/**
 * ADR-0189 slice B4 — who may read and export BOMs, the online trust root, and
 * the bundle downloads (§7 `bom_export_roles`, §9, B4.1, B4.2, R6, R21).
 *
 * ACCESS (strict default, ADR-0180): admins only. While an admin has relaxed
 * `bom_export_roles` to `admins_and_auditors` (audited), a person holding an
 * active `bom_auditor_grants` row may read, export and verify too. Decided
 * here on every request; `BomCapabilities` only reports it.
 *
 * ONLINE TRUST (B4.2): receipt keys from `receipt_signing_keys` (retired keys
 * included, R6), the receipt v2 boundary from `receipt_payload_versions`, the
 * export keys from the public-only verification keyring
 * (`REGULAIT_EXPORT_VERIFY_PUBLIC_KEYS` or `…_FILE`) plus the deployment's own
 * configured export key, and the TSA trust bundle. Never a key from the bundle.
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { readFileSync, statSync } from "node:fs";
import type { FastifyReply, FastifyRequest } from "fastify";
import { and, bomAuditorGrants, eq, isNull, orgSettings, ORG_SETTINGS_ID, receiptSigningKeys, sql, type Db } from "@regulait/db";
import {
  BOM_BUNDLE_HEADERS,
  BOM_EXPORT_VERIFY_KEYS_ENV,
  BOM_EXPORT_VERIFY_KEYS_FILE_ENV,
  bomOnlineExportTrust,
  EXPORT_BUNDLE_V3_SCHEMA,
  writeBomTar,
  type BomBundleEnvelope,
  type BomCapabilities,
  type BomVerifyTrust,
  type BuiltBomBundle,
} from "@regulait/shared";
import { loadReceiptV2Boundary } from "./decision-receipts.js";
import { deploymentTimestampVerifier } from "./bom-timestamp.js";
import { resolveExportSigningKey, resolveInstallIdentity } from "./export-bundle.js";
import { resolveLicense } from "./licensing.js";
import { BomRouteError } from "./decision-bom.js";

const rowsOf = <T>(r: unknown): T[] => (r as { rows?: T[] }).rows ?? [];

export interface BomAccess {
  access: "admin" | "auditor_grant";
  exportRoles: "admins_only" | "admins_and_auditors";
  auditorGrant: { id: string; grantedAt: string; grantedBy: string } | null;
  rateLimitPerMinute: number;
}

/** §7, §9: admin, or an active auditor grant while `bom_export_roles = admins_and_auditors`; null = refused */
export async function bomAccessOf(db: Db, req: FastifyRequest): Promise<BomAccess | null> {
  const [s] = await db.select({ roles: orgSettings.bomExportRoles, rate: orgSettings.bomExportRateLimitPerMinute }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  const exportRoles = s?.roles === "admins_and_auditors" ? "admins_and_auditors" : "admins_only";
  const rateLimitPerMinute = typeof s?.rate === "number" ? s.rate : 30;
  if (req.authCtx.isAdmin) return { access: "admin", exportRoles, auditorGrant: null, rateLimitPerMinute };
  const userId = req.authCtx.userId;
  if (exportRoles !== "admins_and_auditors" || !userId) return null;
  const [grant] = await db.select().from(bomAuditorGrants).where(and(eq(bomAuditorGrants.userId, userId), isNull(bomAuditorGrants.revokedAt))).limit(1);
  if (!grant) return null;
  return { access: "auditor_grant", exportRoles, auditorGrant: { id: grant.id, grantedAt: grant.grantedAt.toISOString(), grantedBy: grant.grantedBy }, rateLimitPerMinute };
}

/** `BomCapabilities`: what the server decided for this caller (never an input) */
export function bomCapabilitiesOf(a: BomAccess): BomCapabilities {
  const key = resolveExportSigningKey();
  return {
    access: a.access,
    exportRoles: a.exportRoles,
    auditorGrant: a.auditorGrant,
    canExport: key.ok,
    exportUnavailableReason: key.ok ? null : "export_signing_key_absent",
    canVerify: true,
    canViewDrift: a.access === "admin",
    exportRequiresStepUp: false,
    rateLimitPerMinute: a.rateLimitPerMinute,
  };
}

/** the configured export verification keyring (inline or file), or null when neither is set */
export function configuredExportVerifyKeyring(): unknown | null {
  const inline = process.env[BOM_EXPORT_VERIFY_KEYS_ENV]?.trim();
  const file = process.env[BOM_EXPORT_VERIFY_KEYS_FILE_ENV]?.trim();
  if (inline && file) throw new Error(`set one of ${BOM_EXPORT_VERIFY_KEYS_ENV} and ${BOM_EXPORT_VERIFY_KEYS_FILE_ENV}, not both`);
  if (inline) return JSON.parse(inline) as unknown;
  if (file) {
    if (!statSync(file).isFile() || statSync(file).size > 256 * 1024) throw new Error(`${BOM_EXPORT_VERIFY_KEYS_FILE_ENV} is not a readable keyring file`);
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  }
  return null;
}

/** B4.2's online trust root: the deployment's recorded keys and boundary, never the caller's (R6: no private key needed) */
export async function onlineBomTrust(db: Db): Promise<BomVerifyTrust> {
  const keys = await db.select({ keyId: receiptSigningKeys.keyId, jwk: receiptSigningKeys.publicJwk }).from(receiptSigningKeys);
  const own = resolveExportSigningKey();
  const clock = rowsOf<{ now: Date | string }>(await db.execute(sql`select now() as "now"`))[0]!;
  return {
    receipt: { keys },
    receiptV2FromAuditSeq: await loadReceiptV2Boundary(db),
    export: bomOnlineExportTrust(configuredExportVerifyKeyring(), own.ok ? { keyId: own.keyId, publicKeyPem: own.publicKeyPem } : null),
    timestamp: deploymentTimestampVerifier(),
    verificationTime: new Date(clock.now).toISOString(),
  };
}

/** the export key and the envelope fields of a bundle (B4.1 "The manifest"); 409 when no export key (R6) */
export async function bomBundleEnvelope(db: Db, exportedByUserId: string): Promise<BomBundleEnvelope> {
  const key = resolveExportSigningKey();
  if (!key.ok) {
    throw new BomRouteError(409, { error: "bom_signing_unavailable", missingKey: "export", detail: `No export signing key is configured (${key.ruleId}); a bundle is never built unsigned.` });
  }
  const license = await resolveLicense(db);
  const install = await resolveInstallIdentity(db, license.document?.licenseId ?? null);
  const clock = rowsOf<{ now: Date | string }>(await db.execute(sql`select now() as "now"`))[0]!;
  const receiptKeys = await db.select({ keyId: receiptSigningKeys.keyId, jwk: receiptSigningKeys.publicJwk }).from(receiptSigningKeys);
  return {
    installId: install.installId,
    installIdSource: install.source === "environment" ? "operator" : install.source === "license" ? "license" : "absent",
    exportedAt: new Date(clock.now).toISOString(),
    exportedByUserId,
    exportKey: { keyId: key.keyId, fingerprint: key.fingerprint, publicKeyPem: key.publicKeyPem, sign: key.sign },
    receiptKeys: receiptKeys.map((k) => ({ keyId: k.keyId, jwk: { kty: "OKP" as const, crv: "Ed25519" as const, x: k.jwk.x } })),
  };
}

/** write a built bundle as the served `.tar.gz` with the contract's headers (B4.1, `bomBundleHeadersSchema`) */
export function sendBomBundle(reply: FastifyReply, built: BuiltBomBundle, subject: "decision-bom" | "ai-bom", exportKey: { keyId: string; fingerprint: string }): FastifyReply {
  // the B4.1 writer the verifier rebuilds and compares against; one gzip member, level 9, MTIME 0, no name
  const archive = gzipSync(writeBomTar(built.files), { level: 9 });
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  return reply
    .status(200)
    .header(BOM_BUNDLE_HEADERS.contentType, "application/gzip")
    .header(BOM_BUNDLE_HEADERS.contentDisposition, `attachment; filename="${built.root}.tar.gz"`)
    .header(BOM_BUNDLE_HEADERS.schema, EXPORT_BUNDLE_V3_SCHEMA)
    .header(BOM_BUNDLE_HEADERS.subject, subject)
    .header(BOM_BUNDLE_HEADERS.archiveSha256, sha(archive))
    .header(BOM_BUNDLE_HEADERS.manifestSha256, built.manifestSha256)
    .header(BOM_BUNDLE_HEADERS.exportKeyId, exportKey.keyId)
    .header(BOM_BUNDLE_HEADERS.exportKeyFingerprint, exportKey.fingerprint)
    .header(BOM_BUNDLE_HEADERS.bodySha256, built.bodySha256)
    .send(archive);
}
