/**
 * ADR-0188 slice S9 — SPIFFE TRUST BUNDLE MANAGEMENT (decisions 10, 11, 12, 21).
 *
 *   GET  /v1/identity/spiffe-trust-bundles                    every bundle ever recorded (public facts only)
 *   POST /v1/identity/spiffe-trust-bundles                    upload a trust domain's bundle (first, or replacing the active one)
 *   POST /v1/identity/spiffe-trust-bundles/:bundleId/revoke   end the domain's SPIFFE trust, with decision 12's cascade
 *
 * ADMIN-ONLY (the route-class gate). Every write needs an `identity_manage`
 * step-up bound to exactly what it does, and writes an audit row; every
 * refusal of a write writes a DENY row (the S6 pattern).
 *
 * Secure by default (ADR-0180, decision 10 `spiffe_trust_bundles`: empty):
 *  - SPIFFE client authentication is OFF until an admin uploads a bundle for a
 *    trust domain. The S5 environment variable is ignored, never imported;
 *  - a bundle is uploaded, never fetched (air-gapped safe, decision 11). It is
 *    either concatenated PEM certificates or the SPIFFE bundle format (an RFC
 *    7517 JWKS whose `x509-svid` keys carry exactly one `x5c` certificate, and
 *    whose key parameters must be that certificate's public key). Each
 *    authority must be a CA with `keyCertSign`, inside its validity window on
 *    the DATABASE clock, and no private key may appear anywhere in the upload.
 *    `jwt-svid` keys are counted and not stored (JWT-SVID client authentication
 *    is not built);
 *  - one ACTIVE bundle per domain. Replacing it names the active bundle's id
 *    (compare-and-set) and supersedes it: rotation, nothing is revoked, tokens
 *    already issued live to their own expiry (decision 12 "rotation is not
 *    revocation");
 *  - revoking the active bundle ends the domain's trust. In the same
 *    transaction every unexpired token authenticated by a SPIFFE ID credential
 *    of that domain is revoked; then every live grant those credentials
 *    authenticated (as the client or as a parent's subject credential) is
 *    revoked with its descendants (decision 12's "A whole SPIFFE trust bundle"
 *    row). The use-time chain check refuses them anyway (`loadLiveChain`: a
 *    SPIFFE ID credential with no active bundle is not live), so an incomplete
 *    cascade is reported, never silent.
 *
 * Open source first (ADR-0176): Node's `X509Certificate` and `createPublicKey`
 * parse the certificates and JWKs; `pkijs` (pinned) reads the CA facts
 * (`certificateIsAuthority`). The SPIFFE npm packages surveyed (`spiffe`,
 * `@jeengbe/spiffe`, `@defakto/spiffe`) are Workload API CLIENTS (gRPC to a
 * SPIRE agent, the workload side); none parses or validates a bundle on the
 * relying-party side, so the bundle-format checks here are ours.
 */
import { createPublicKey, randomUUID, X509Certificate } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, asc, auditLog, delegationGrants, desc, eq, inArray, isNull, or, spiffeTrustBundles, sql, type Db, type SpiffeTrustBundleRow } from "@regulait/db";
import {
  canonicalJson,
  putSpiffeTrustBundleSchema,
  revokeSpiffeTrustBundleSchema,
  sha256Hex,
  SPIFFE_BUNDLE_MAX_AUTHORITIES,
  SPIFFE_TRUST_BUNDLES_LEGACY_ENV,
  type PutSpiffeTrustBundle,
  type SpiffeBundleFormat,
  type SpiffeTrustAuthorityView,
  type SpiffeTrustBundleListView,
  type SpiffeTrustBundleRevokeResult,
  type SpiffeTrustBundleView,
} from "@regulait/shared";
import { databaseNow } from "../delegation.js";
import { checkStepUp, type StepUpCheckArgs, type StepUpOutcome } from "../step-up.js";
import { IdentityAdminError, liveGrants, revokeGrants } from "./identity-admin.js";
import { legacySpiffeEnvSet } from "./spiffe-trust-domains.js";
import { certificateIsAuthority, certificateThumbprint, pemBundleToDer, PemNotCertificateError } from "./x509.js";

const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";
const PEM_BEGIN = "-----BEGIN CERTIFICATE-----";

// ---------------------------------------------------------------------------
// Parsing an upload (pure; no database)
// ---------------------------------------------------------------------------

export interface ParsedSpiffeBundle {
  format: SpiffeBundleFormat;
  /** DER, in upload order */
  authorities: Buffer[];
  views: SpiffeTrustAuthorityView[];
  /** hex SHA-256 over the sorted thumbprints: independent of order and of the upload format */
  digest: string;
  authoritiesPem: string;
  jwtAuthoritiesIgnored: number;
}

const refused = (code: string, detail: string) => new IdentityAdminError(code, 422, detail);

const toPem = (der: Buffer) => `${PEM_BEGIN}\n${der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "")}\n-----END CERTIFICATE-----\n`;

/** the X.509 authorities of a SPIFFE bundle (JWKS) document; jwt-svid keys counted, anything else refused */
function authoritiesFromJwks(text: string): { ders: Buffer[]; jwtIgnored: number } | IdentityAdminError {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return refused("spiffe_bundle_invalid", "the bundle is neither PEM certificates nor a SPIFFE bundle (JSON)");
  }
  const keys = (doc as { keys?: unknown } | null)?.keys;
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray(keys)) {
    return refused("spiffe_bundle_invalid", "a SPIFFE bundle is a JSON object with a `keys` array (RFC 7517)");
  }
  if (keys.length > SPIFFE_BUNDLE_MAX_AUTHORITIES * 2) return refused("spiffe_bundle_too_large", `a bundle holds at most ${SPIFFE_BUNDLE_MAX_AUTHORITIES} X.509 authorities`);
  const ders: Buffer[] = [];
  let jwtIgnored = 0;
  for (const [i, raw] of keys.entries()) {
    const k = raw as Record<string, unknown> | null;
    if (!k || typeof k !== "object" || Array.isArray(k)) return refused("spiffe_bundle_invalid", `key ${i} is not a JWK`);
    if (["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some((m) => m in k)) return refused("spiffe_bundle_private_material", `key ${i} carries private key material`);
    if (k.use === "jwt-svid") {
      jwtIgnored++;
      continue;
    }
    if (k.use !== "x509-svid") return refused("spiffe_bundle_invalid", `key ${i}: \`use\` must be x509-svid or jwt-svid`);
    // SPIFFE Trust Domain and Bundle §4.2.1: an X.509 authority's x5c holds exactly one certificate
    if (!Array.isArray(k.x5c) || k.x5c.length !== 1 || typeof k.x5c[0] !== "string") {
      return refused("spiffe_bundle_invalid", `key ${i}: an x509-svid key carries exactly one x5c certificate`);
    }
    let der: Buffer;
    try {
      // x5c is standard base64 (RFC 7517 §4.7); Node parses it
      der = Buffer.from(new X509Certificate(Buffer.from(k.x5c[0], "base64")).raw);
    } catch {
      return refused("spiffe_bundle_invalid", `key ${i}: the x5c certificate does not parse`);
    }
    // the key parameters must be the certificate's own public key
    try {
      const fromJwk = createPublicKey({ key: k as never, format: "jwk" }).export({ type: "spki", format: "der" });
      const fromCert = new X509Certificate(der).publicKey.export({ type: "spki", format: "der" });
      if (!Buffer.from(fromJwk).equals(Buffer.from(fromCert))) return refused("spiffe_bundle_key_mismatch", `key ${i}: its parameters are not the x5c certificate's public key`);
    } catch {
      return refused("spiffe_bundle_key_mismatch", `key ${i}: its parameters are not a public key matching the x5c certificate`);
    }
    ders.push(der);
  }
  return { ders, jwtIgnored };
}

/**
 * Validate an uploaded bundle and reduce it to the public facts we keep.
 * `now` is the database clock (M-075).
 */
export function parseSpiffeBundle(text: string, now: Date): ParsedSpiffeBundle | IdentityAdminError {
  // no private key, in either format, anywhere in the upload
  if (text.includes("PRIVATE KEY")) return refused("spiffe_bundle_private_material", "the bundle carries a private key; upload the public CA certificates only");
  const trimmed = text.trim();
  let format: SpiffeBundleFormat;
  let ders: Buffer[];
  let jwtIgnored = 0;
  if (trimmed.startsWith("{")) {
    const out = authoritiesFromJwks(trimmed);
    if (out instanceof IdentityAdminError) return out;
    format = "spiffe_jwks";
    ders = out.ders;
    jwtIgnored = out.jwtIgnored;
  } else if (trimmed.includes(PEM_BEGIN)) {
    try {
      ders = pemBundleToDer(trimmed);
    } catch (e) {
      // #389 review L4: a block that is not a certificate is named, never skipped
      if (e instanceof PemNotCertificateError) return refused("spiffe_bundle_not_certificate", "the bundle holds a PEM block that is not a CERTIFICATE; upload CA certificates only");
      return refused("spiffe_bundle_invalid", `the PEM certificates do not parse (at most ${SPIFFE_BUNDLE_MAX_AUTHORITIES})`);
    }
    format = "pem";
  } else {
    return refused("spiffe_bundle_invalid", "the bundle is neither PEM certificates nor a SPIFFE bundle (JSON)");
  }
  if (ders.length === 0) return refused("spiffe_bundle_invalid", "the bundle holds no X.509 authority");
  if (ders.length > SPIFFE_BUNDLE_MAX_AUTHORITIES) return refused("spiffe_bundle_too_large", `a bundle holds at most ${SPIFFE_BUNDLE_MAX_AUTHORITIES} X.509 authorities`);
  const seen = new Set<string>();
  const views: SpiffeTrustAuthorityView[] = [];
  for (const [i, der] of ders.entries()) {
    const thumbprint = certificateThumbprint(der);
    if (seen.has(thumbprint)) return refused("spiffe_bundle_duplicate", `authority ${i} appears twice`);
    seen.add(thumbprint);
    let cert: X509Certificate;
    let isAuthority: boolean;
    try {
      cert = new X509Certificate(der);
      isAuthority = certificateIsAuthority(der);
    } catch {
      return refused("spiffe_bundle_invalid", `authority ${i} does not parse`);
    }
    if (!isAuthority) return refused("spiffe_bundle_authority_not_ca", `authority ${i} is not a CA with keyCertSign; a leaf certificate is never a trust anchor`);
    const from = new Date(cert.validFrom);
    const to = new Date(cert.validTo);
    if (from.getTime() > now.getTime() || to.getTime() <= now.getTime()) {
      return refused("spiffe_bundle_authority_time", `authority ${i} is not valid now (${cert.validFrom} to ${cert.validTo})`);
    }
    views.push({ thumbprint, subject: cert.subject.replace(/\n/g, ", "), notBefore: from.toISOString(), notAfter: to.toISOString() });
  }
  const digest = sha256Hex(canonicalJson([...seen].sort()));
  return { format, authorities: ders, views, digest, authoritiesPem: ders.map(toPem).join(""), jwtAuthoritiesIgnored: jwtIgnored };
}

// ---------------------------------------------------------------------------
// Views and step-up facts
// ---------------------------------------------------------------------------

export function spiffeBundleView(r: SpiffeTrustBundleRow): SpiffeTrustBundleView {
  return {
    id: r.id,
    trustDomain: r.trustDomain,
    status: r.revokedAt ? "revoked" : r.supersededAt ? "superseded" : "active",
    format: r.format,
    digest: r.digest,
    authorities: [...r.authorities],
    jwtAuthoritiesIgnored: r.jwtAuthoritiesIgnored,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    supersededAt: r.supersededAt ? r.supersededAt.toISOString() : null,
    supersededByBundleId: r.supersededByBundleId,
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
    revokedBy: r.revokedBy,
  };
}

/** the upload's step-up binds the domain, WHAT is trusted (the digest) and WHICH bundle it replaces */
export function spiffeBundleSetStepUp(input: PutSpiffeTrustBundle, digest: string): StepUpCheckArgs {
  return { kind: "identity_manage", facts: { op: "spiffe_bundle_set", trustDomain: input.trustDomain, digest, replacesBundleId: input.replacesBundleId } };
}
export function spiffeBundleRevokeStepUp(bundleId: string): StepUpCheckArgs {
  return { kind: "identity_manage", facts: { op: "spiffe_bundle_revoke", bundleId } };
}

async function auditRefusal(db: Db, actorUserId: string, objectId: string | null, phase: string, err: IdentityAdminError, extra: Record<string, unknown> = {}) {
  await db.insert(auditLog).values({
    userId: actorUserId,
    objectType: "spiffe_trust_bundle",
    objectId,
    detail: { phase, code: err.code, ...extra },
    effect: "deny",
    ruleId: "spiffe-trust-bundle-refused",
    ruleChain: [],
    reason: `refused: ${err.message} (ADR-0188 S9)`,
  });
  return err;
}

const isUniqueViolation = (e: unknown): boolean => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === "23505" || err?.cause?.code === "23505";
};

// ---------------------------------------------------------------------------
// The operations
// ---------------------------------------------------------------------------

export async function listSpiffeTrustBundles(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<SpiffeTrustBundleListView> {
  const rows = await db
    .select()
    .from(spiffeTrustBundles)
    .orderBy(sql`(${spiffeTrustBundles.supersededAt} IS NULL AND ${spiffeTrustBundles.revokedAt} IS NULL) DESC`, asc(spiffeTrustBundles.trustDomain), desc(spiffeTrustBundles.createdAt))
    .limit(500);
  return { items: rows.map(spiffeBundleView), legacyEnvironmentIgnored: legacySpiffeEnvSet(env) };
}

/**
 * Upload a trust domain's bundle. `parsed` is the upload already validated
 * (the step-up binds its digest). In one transaction: the active bundle of the
 * domain is locked, the caller's `replacesBundleId` must name it exactly (null
 * when there is none), it is superseded, the new row is inserted and audited
 * `spiffe-trust-bundle-set`. A refusal writes a deny row and changes nothing.
 */
/**
 * #389 review L3: the step-up is spent only once the write is certain. The route LOOKS at the grant first
 * (`spend: false`); this callback claims it inside the write's transaction, after the compare-and-set and every other
 * refusal, so a 404 or a 409 leaves it unspent. It claims on the root handle: single use, and its own rows survive a
 * rollback (the S8 pattern in `app.ts`).
 */
export type SpendStepUp = () => Promise<StepUpOutcome>;

/** the in-transaction claim was refused (a race with another use of the same grant): nothing was written */
export class StepUpRefusedInWrite extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super("step-up refused");
    this.name = "StepUpRefusedInWrite";
  }
}

async function spendOrThrow(spend: SpendStepUp | undefined): Promise<void> {
  if (!spend) return;
  const su = await spend();
  if (!su.ok) throw new StepUpRefusedInWrite(su.status, su.body);
}

export async function setSpiffeTrustBundle(
  db: Db,
  input: PutSpiffeTrustBundle,
  parsed: ParsedSpiffeBundle,
  actorUserId: string,
  spend?: SpendStepUp,
): Promise<SpiffeTrustBundleView> {
  let out: SpiffeTrustBundleView | IdentityAdminError;
  try {
    out = await db.transaction(async (tx): Promise<SpiffeTrustBundleView | IdentityAdminError> => {
      const t = tx as unknown as Db;
      const [active] = await t
        .select()
        .from(spiffeTrustBundles)
        .where(and(eq(spiffeTrustBundles.trustDomain, input.trustDomain), isNull(spiffeTrustBundles.supersededAt), isNull(spiffeTrustBundles.revokedAt)))
        .for("update");
      if ((active?.id ?? null) !== input.replacesBundleId) {
        return new IdentityAdminError(
          "spiffe_bundle_conflict",
          409,
          active
            ? `${input.trustDomain} already has an active bundle (${active.id}); name it in replacesBundleId to replace it`
            : `${input.trustDomain} has no active bundle; replacesBundleId must be null`,
        );
      }
      if (active && active.digest === parsed.digest) return new IdentityAdminError("spiffe_bundle_unchanged", 409, "the active bundle already holds exactly these authorities");
      // the compare-and-set held: only now is the step-up claimed
      await spendOrThrow(spend);
      const id = randomUUID();
      // the old row first: the one-active index allows no overlap; the self-reference is checked at commit
      if (active) {
        await t
          .update(spiffeTrustBundles)
          .set({ supersededAt: sql`GREATEST(now(), ${spiffeTrustBundles.createdAt})`, supersededByBundleId: id })
          .where(eq(spiffeTrustBundles.id, active.id));
      }
      const [row] = await t
        .insert(spiffeTrustBundles)
        .values({
          id,
          trustDomain: input.trustDomain,
          format: parsed.format,
          authoritiesPem: parsed.authoritiesPem,
          authorities: parsed.views,
          digest: parsed.digest,
          jwtAuthoritiesIgnored: parsed.jwtAuthoritiesIgnored,
          createdBy: actorUserId,
        })
        .returning();
      await t.insert(auditLog).values({
        userId: actorUserId,
        objectType: "spiffe_trust_bundle",
        objectId: id,
        detail: {
          phase: active ? "replace" : "add",
          trustDomain: input.trustDomain,
          bundleId: id,
          replacedBundleId: active?.id ?? null,
          digest: parsed.digest,
          previousDigest: active?.digest ?? null,
          format: parsed.format,
          authorities: parsed.views.map((v) => v.thumbprint),
          jwtAuthoritiesIgnored: parsed.jwtAuthoritiesIgnored,
        },
        effect: "allow",
        ruleId: "spiffe-trust-bundle-set",
        ruleChain: [],
        reason: active
          ? `SPIFFE trust bundle for ${input.trustDomain} replaced (rotation: nothing revoked; tokens already issued live to their own expiry)`
          : `SPIFFE trust bundle for ${input.trustDomain} added: X.509-SVIDs from this trust domain can now authenticate registered SPIFFE ID credentials`,
      });
      return spiffeBundleView(row!);
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    out = new IdentityAdminError("spiffe_bundle_conflict", 409, `a bundle for ${input.trustDomain} was uploaded concurrently; refresh and try again`);
  }
  if (out instanceof IdentityAdminError) {
    throw await auditRefusal(db, actorUserId, input.replacesBundleId, "set_refused", out, { trustDomain: input.trustDomain, digest: parsed.digest });
  }
  return out;
}

/**
 * Revoke the ACTIVE bundle of a domain (decision 12). In one transaction: the
 * bundle row, and every unexpired token authenticated by a SPIFFE ID
 * credential of that trust domain. Then, after commit, every live grant those
 * credentials authenticated, with descendants. Audited `spiffe-trust-bundle-revoked`.
 */
export async function revokeSpiffeTrustBundle(db: Db, bundleId: string, actorUserId: string, spend?: SpendStepUp): Promise<SpiffeTrustBundleRevokeResult> {
  // the SPIFFE ID credentials of a domain: `spiffe://<domain>/...` (the third '/'-separated part)
  const domainCredentials = (domain: string) => sql`select id from workload_credentials where kind = 'spiffe_id' and split_part(spiffe_id, '/', 3) = ${domain}`;
  const out = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [bundle] = await t.select().from(spiffeTrustBundles).where(eq(spiffeTrustBundles.id, bundleId)).for("update");
    if (!bundle) return new IdentityAdminError("spiffe_bundle_not_found", 404, `no SPIFFE trust bundle ${bundleId}`);
    if (bundle.revokedAt) return new IdentityAdminError("spiffe_bundle_already_revoked", 409, `bundle ${bundleId} is already revoked`);
    if (bundle.supersededAt) {
      return new IdentityAdminError("spiffe_bundle_not_active", 409, `bundle ${bundleId} was replaced; revoke the active bundle of ${bundle.trustDomain} to end the domain's trust`);
    }
    await spendOrThrow(spend);
    // #389 review M1: the stamp is taken AFTER the row lock (`clock_timestamp()`, the database clock), so every grant a
    // token request created while it held this bundle FOR SHARE has `created_at` <= `revoked_at`, and the live-chain
    // check refuses it even after a new bundle is uploaded for the domain
    const [row] = await t
      .update(spiffeTrustBundles)
      .set({ revokedAt: sql`GREATEST(clock_timestamp(), ${spiffeTrustBundles.createdAt})`, revokedBy: actorUserId })
      .where(eq(spiffeTrustBundles.id, bundleId))
      .returning();
    // decision 12: every token a SPIFFE ID credential of this domain authenticated (lifecycle stamps on the DB clock)
    const tokens = await t.execute<{ jti: string }>(sql`
      update issued_tokens set revoked_at = GREATEST(now(), issued_at)
      where revoked_at is null and expires_at > now() and auth_credential_id in (${domainCredentials(bundle.trustDomain)})
      returning jti`);
    await t.insert(auditLog).values({
      userId: actorUserId,
      objectType: "spiffe_trust_bundle",
      objectId: bundleId,
      detail: { phase: "revoke", trustDomain: bundle.trustDomain, bundleId, digest: bundle.digest, tokensRevoked: tokens.rows.length },
      effect: "allow",
      ruleId: "spiffe-trust-bundle-revoked",
      ruleChain: [],
      reason: `SPIFFE trust bundle for ${bundle.trustDomain} revoked: no X.509-SVID of this domain authenticates until a new bundle is uploaded; ${tokens.rows.length} token(s) revoked, and every grant a SPIFFE ID of this domain authenticated is refused at its next use (ADR-0188 decision 12)`,
    });
    return { bundle: spiffeBundleView(row!), tokensRevoked: tokens.rows.length, trustDomain: bundle.trustDomain };
  });
  if (out instanceof IdentityAdminError) {
    throw await auditRefusal(db, actorUserId, bundleId, "revoke_refused", out);
  }
  let grants: Awaited<ReturnType<typeof liveGrants>>;
  try {
    const credIds = (await db.execute<{ id: string }>(domainCredentials(out.trustDomain))).rows.map((r) => r.id);
    grants = credIds.length === 0 ? [] : await liveGrants(db, or(inArray(delegationGrants.authCredentialId, credIds), inArray(delegationGrants.subjectCredentialId, credIds))!);
  } catch (e) {
    grants = e instanceof Error ? e : new Error(String(e));
  }
  const cascade = await revokeGrants(db, grants, "credential_revoked", actorUserId, { bundleId, trustDomain: out.trustDomain });
  return { bundle: out.bundle, tokensRevoked: out.tokensRevoked, ...cascade };
}

// ---------------------------------------------------------------------------
// The route handlers (registered literally by identity-routes.ts)
// ---------------------------------------------------------------------------

const actorOf = (req: FastifyRequest) => req.authCtx.userId ?? SYSTEM_USER_ID;
const bundleParam = z.object({ bundleId: z.string().uuid() });

/** a malformed or invalid write is refused AND audited; the deny row names issue paths only, never the bundle text */
async function invalidRequest(db: Db, req: FastifyRequest, reply: FastifyReply, route: string, issues: z.ZodIssue[], objectId: string | null) {
  await db.insert(auditLog).values({
    userId: actorOf(req),
    objectType: "spiffe_trust_bundle",
    objectId,
    detail: { phase: "request_invalid", route, issues: issues.slice(0, 20).map((i) => ({ path: i.path.map(String), message: i.message })) },
    effect: "deny",
    ruleId: "spiffe-trust-bundle-refused",
    ruleChain: [],
    reason: `refused: a malformed ${route} request (ADR-0188 S9)`,
  });
  return reply.status(400).send({ error: "invalid_body", detail: issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
}

function answer(reply: FastifyReply, err: unknown) {
  if (err instanceof StepUpRefusedInWrite) return reply.status(err.status).send(err.body);
  if (!(err instanceof IdentityAdminError)) throw err;
  return reply.status(err.status).send({ error: err.code, detail: err.message });
}

export function spiffeTrustBundleHandlers(db: Db) {
  return {
    list: async (_req: FastifyRequest, reply: FastifyReply) => reply.send(await listSpiffeTrustBundles(db)),
    set: async (req: FastifyRequest, reply: FastifyReply) => {
      const parsedBody = putSpiffeTrustBundleSchema.safeParse(req.body ?? {});
      if (!parsedBody.success) return invalidRequest(db, req, reply, "POST /v1/identity/spiffe-trust-bundles", parsedBody.error.issues, null);
      const input = parsedBody.data;
      // validated BEFORE the step-up: the step-up binds the digest, and a bundle that could never be trusted is refused
      // without asking anyone to confirm it
      const parsed = parseSpiffeBundle(input.bundle, await databaseNow(db));
      if (parsed instanceof IdentityAdminError) {
        await auditRefusal(db, actorOf(req), input.replacesBundleId, "set_refused", parsed, { trustDomain: input.trustDomain });
        return answer(reply, parsed);
      }
      // look, do not spend (#389 review L3): the grant is claimed inside the write, after the compare-and-set
      const args = spiffeBundleSetStepUp(input, parsed.digest);
      const look = await checkStepUp(db, req, args, { spend: false });
      if (!look.ok) return reply.status(look.status).send(look.body);
      try {
        return reply.status(201).send(await setSpiffeTrustBundle(db, input, parsed, actorOf(req), () => checkStepUp(db, req, args)));
      } catch (e) {
        return answer(reply, e);
      }
    },
    revoke: async (req: FastifyRequest, reply: FastifyReply) => {
      const route = "POST /v1/identity/spiffe-trust-bundles/:bundleId/revoke";
      const params = bundleParam.safeParse(req.params);
      if (!params.success) return invalidRequest(db, req, reply, route, params.error.issues, null);
      const { bundleId } = params.data;
      const body = revokeSpiffeTrustBundleSchema.safeParse(req.body ?? {});
      if (!body.success) return invalidRequest(db, req, reply, route, body.error.issues, bundleId);
      const args = spiffeBundleRevokeStepUp(bundleId);
      const look = await checkStepUp(db, req, args, { spend: false });
      if (!look.ok) return reply.status(look.status).send(look.body);
      try {
        return reply.send(await revokeSpiffeTrustBundle(db, bundleId, actorOf(req), () => checkStepUp(db, req, args)));
      } catch (e) {
        return answer(reply, e);
      }
    },
  };
}

/** boot: say once that the retired S5 variable is ignored (it is never read) */
export function warnIfLegacySpiffeEnv(log: { warn: (msg: string) => void }, env: NodeJS.ProcessEnv = process.env): void {
  if (legacySpiffeEnvSet(env)) {
    log.warn(
      `${SPIFFE_TRUST_BUNDLES_LEGACY_ENV} is set and IGNORED (ADR-0188 S9): SPIFFE trust bundles are uploaded through the audited admin route (Identity & Access → Workload identities → SPIFFE trust bundles). Remove the variable.`,
    );
  }
}
