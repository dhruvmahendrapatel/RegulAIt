/**
 * ADR-0189 slice B4 — the FROZEN API CONTRACT (request and response bodies
 * only; no implementation). Frozen 2026-10-10 so the B6 web UI can be built
 * against it before B4 lands. B4 implements exactly these shapes; a change
 * here is a contract change, reviewed with B6.
 *
 * Routes (all `internal` stability, `audit` tag; still 501 `not_built` until B4):
 *
 *   GET  /v1/decisions/:auditId/bom            decisionBomReadQuery -> DecisionBomReadResponse (JSON, for display)
 *   GET  /v1/decisions/:auditId/bom/bundle     decisionBomReadQuery -> export-bundle/3 bytes + BomBundleHeaders
 *   GET  /v1/ai-bom/snapshots/:snapshotId      aiBomSnapshotFormatQuery -> export-bundle/3 bytes (R7: never bare rendering bytes)
 *   GET  /v1/ai-bom/snapshots/:snapshotId/bundle   -> export-bundle/3 bytes with every rendered format
 *   POST /v1/boms/verify                       BomVerifyRequest -> BomVerifyResponse
 *
 * Every refusal is a `BomErrorEnvelope`; `BOM_B4_ROUTE_CONTRACT` lists the
 * statuses and codes each route may answer.
 *
 * Authorization (§7 `bom_export_roles`, §9, OWNER DECISION 9) is decided by the
 * SERVER on every request. `BomCapabilities` reports what the server decided,
 * for the UI to choose what to show; the UI never derives access from it and
 * no request field can widen it. Strict defaults: admins only; an explicit
 * auditor grant only while `bom_export_roles = admins_and_auditors`; no
 * step-up for reading or exporting (decision 9); every read, export and
 * verify is audited; a BOM carries digests and ids, never content
 * (OWNER DECISION 5, R45).
 *
 * Nothing here reads a clock, a database or the network. Every regex is
 * linear (one flat character class per anchored test).
 */
import { z } from "zod";
import { BOM_EXPORT_ROLE_MODES } from "./settings.js";
import { DECISION_BOM_PENDING_REASONS } from "./finality.js";
import {
  AI_BOM_SNAPSHOT_TRIGGERS,
  AI_BOM_SUBJECT_KINDS,
  BOM_BODY_VERSIONS,
  BOM_NOT_RECORDED_REASONS,
  BOM_RENDERING_FORMATS,
  BOM_SECTION_STATUSES,
  bomCanonicalBytes,
  bomDigestSchema,
  bomIntSchema,
  bomSha256,
  bomTimeSchema,
  bomUuidSchema,
  DECISION_BOM_FINALITY_STATES,
  DECISION_BOM_SECTIONS_V2,
  DECISION_BOM_VERSIONS,
  decisionBomSectionsFor,
  decisionBomBodySchema,
  DECISION_EXECUTION_REFUSAL_CODES,
  decisionExecutionRelaxationSchema,
  findEmailShapes,
  hasEmailShape,
  type DecisionBomFinalityState,
} from "./contract.js";
import { APPLIED_ISOLATION_KINDS, PLACEMENT_END_CODES } from "../isolation/contract.js";

/**
 * ADR-0190 I4 (with the I8 contract): what happened to a decision's OFFERED placement after the decision, one
 * `execution_placement_reports` row each (append-only). It is NOT part of the signed body: the decision's facts are
 * frozen at the decision, when nothing had run yet; this is the live, linked record the read route shows beside the
 * body (the placement row it links to is the one the body's `execution.placementId` names).
 */
export const decisionPlacementReportSchema = z
  .object({
    id: bomUuidSchema,
    placementId: bomUuidSchema,
    offerId: bomUuidSchema,
    /** the audit row written for this outcome */
    auditId: bomUuidSchema,
    outcome: z.enum(["placed", "mismatch", "refused", "cancelled", "session_lost"]),
    appliedClass: z.enum(APPLIED_ISOLATION_KINDS).nullable(),
    reportSha256: bomDigestSchema.nullable(),
    refusalCode: z.enum(DECISION_EXECUTION_REFUSAL_CODES).nullable(),
    endCode: z.enum(PLACEMENT_END_CODES).nullable(),
    createdAt: bomTimeSchema,
  })
  .strict();
export type DecisionPlacementReport = z.infer<typeof decisionPlacementReportSchema>;

/**
 * ADR-0190 owner decision C (slice A1): the `execution_person_stdio_relaxations` row the signed body's
 * `execution.relaxation` names, and the audit row that set it. NOT part of the signed body: the facts sign which
 * relaxation the requirement relied on (its id and scope); who set it, when, and whether it was cleared since come from
 * that row, which is never deleted and whose set fields never change (migration 0201's guard). The read route shows it
 * beside the body, like the placement reports. `setAuditId` is the `execution-person-stdio-relaxed` row written in the
 * set's own transaction, or null when it is no longer found (pruned by the audit retention).
 */
export const decisionExecutionRelaxationRecordSchema = z
  .object({
    id: bomUuidSchema,
    scopeKind: decisionExecutionRelaxationSchema.shape.scopeKind,
    scopeId: bomUuidSchema,
    setBy: bomUuidSchema,
    setAt: bomTimeSchema,
    clearedBy: bomUuidSchema.nullable(),
    clearedAt: bomTimeSchema.nullable(),
    setAuditId: bomUuidSchema.nullable(),
    // ADR-0197 Q3 (migration 0208): when it stops applying, and its latest renewal. Absent from a gateway before Q3.
    expiresAt: bomTimeSchema.optional(),
    renewedBy: bomUuidSchema.nullable().optional(),
    renewedAt: bomTimeSchema.nullable().optional(),
  })
  .strict()
  .refine((r) => (r.clearedBy === null) === (r.clearedAt === null), "a relaxation is cleared by someone at a time, or not at all")
  .refine((r) => r.clearedAt === null || Date.parse(r.clearedAt) >= Date.parse(r.setAt), "a relaxation is cleared after it was set")
  .refine((r) => (r.expiresAt === undefined) === (r.renewedBy === undefined) && (r.expiresAt === undefined) === (r.renewedAt === undefined), "the expiry and the renewal are reported together")
  .refine((r) => r.expiresAt === undefined || Date.parse(r.expiresAt) > Date.parse(r.setAt), "a relaxation expires after it was set")
  .refine((r) => ((r.renewedBy ?? null) === null) === ((r.renewedAt ?? null) === null), "a relaxation is renewed by someone at a time, or not at all")
  .refine((r) => (r.renewedAt ?? null) === null || Date.parse(r.renewedAt as string) >= Date.parse(r.setAt), "a relaxation is renewed after it was set");
export type DecisionExecutionRelaxationRecord = z.infer<typeof decisionExecutionRelaxationRecordSchema>;

// ---------------------------------------------------------------------------
// shared pieces
// ---------------------------------------------------------------------------

/** ADR-0116's bundle family; B4 adds `/3` for both BOM subjects (§6) */
export const EXPORT_BUNDLE_V3_SCHEMA = "regulait.export-bundle/3" as const;
export const BOM_BUNDLE_SUBJECTS = ["decision-bom", "ai-bom"] as const;
export type BomBundleSubject = (typeof BOM_BUNDLE_SUBJECTS)[number];

/** what the verifier reports at verification time (R44): a frozen state, or `anchored_lapsed` */
export const BOM_REPORTED_FINALITY_STATES = [...DECISION_BOM_FINALITY_STATES, "anchored_lapsed"] as const;
export type BomReportedFinality = (typeof BOM_REPORTED_FINALITY_STATES)[number];

/** §9's `format=` values for an AI BOM snapshot download; `native` is the signed body alone */
export const AI_BOM_DOWNLOAD_FORMATS = ["native", "cyclonedx-1.7", "cyclonedx-1.6", "spdx-3.0.1"] as const;
export type AiBomDownloadFormat = (typeof AI_BOM_DOWNLOAD_FORMATS)[number];

const sha256Hex = bomDigestSchema;
/** `sha256:<64 hex>` over the DER SubjectPublicKeyInfo (ADR-0116) */
export const bomKeyFingerprintSchema = z.string().length(71).regex(/^sha256:[0-9a-f]{64}$/);
/** a signing key id: `[A-Za-z0-9._:-]`, as the receipt and export keys are named */
export const bomKeyIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
/** a path parameter id: case-insensitive on the wire, lower-cased before use (as B3's routes do) */
export const bomPathUuidSchema = z.string().max(36).transform((v) => v.toLowerCase()).pipe(bomUuidSchema);
/** a positive version number in a query string */
const queryVersion = z.string().max(9).regex(/^[1-9][0-9]*$/).transform(Number);

// ---------------------------------------------------------------------------
// capabilities: what the server decided for this caller (never an input)
// ---------------------------------------------------------------------------

/** how the caller qualifies under `bom_export_roles` */
export const BOM_ACCESS_BASES = ["admin", "auditor_grant"] as const;
/** why a bundle cannot be built right now although the caller may export */
export const BOM_EXPORT_UNAVAILABLE_REASONS = ["export_signing_key_absent"] as const;

export const bomAuditorGrantSchema = z
  .object({
    /** `bom_auditor_grants.id`; a grant has no expiry or narrower scope in B1's table: it covers every BOM until revoked */
    id: bomUuidSchema,
    grantedAt: bomTimeSchema,
    grantedBy: bomUuidSchema,
  })
  .strict();
export type BomAuditorGrant = z.infer<typeof bomAuditorGrantSchema>;

export const bomCapabilitiesSchema = z
  .object({
    access: z.enum(BOM_ACCESS_BASES),
    /** the org's current `bom_export_roles` */
    exportRoles: z.enum(BOM_EXPORT_ROLE_MODES),
    /** the caller's active grant; required when `access = auditor_grant` */
    auditorGrant: bomAuditorGrantSchema.nullable(),
    /** a bundle can be built now (both signing keys present where needed, R6) */
    canExport: z.boolean(),
    exportUnavailableReason: z.enum(BOM_EXPORT_UNAVAILABLE_REASONS).nullable(),
    /** verification needs no private key (R6): true for everyone inside `bom_export_roles` */
    canVerify: z.boolean(),
    /** R8: the drift view is admins only, never auditors */
    canViewDrift: z.boolean(),
    /** OWNER DECISION 9: no step-up for reading or exporting (step-up stays on relaxing settings) */
    exportRequiresStepUp: z.literal(false),
    /** §7: `bom_export_rate_limit_per_minute` */
    rateLimitPerMinute: bomIntSchema.min(1).max(600),
  })
  .strict()
  .superRefine((c, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (c.access === "auditor_grant" && (c.auditorGrant === null || c.exportRoles !== "admins_and_auditors")) {
      issue("auditor access needs an active grant and bom_export_roles = admins_and_auditors");
    }
    if (c.canExport !== (c.exportUnavailableReason === null)) issue("exportUnavailableReason is set exactly when canExport is false");
    if (c.canViewDrift !== (c.access === "admin")) issue("drift is admins only (R8)");
  });
export type BomCapabilities = z.infer<typeof bomCapabilitiesSchema>;

// ---------------------------------------------------------------------------
// the refusal envelope
// ---------------------------------------------------------------------------

/** why a Decision BOM is not final yet (finality.ts, plus an unsigned receipt or addendum, R15) */
export const BOM_ANCHOR_PENDING_REASONS = [...DECISION_BOM_PENDING_REASONS, "receipt_unsigned"] as const;
/** which key is missing for a 409 `bom_signing_unavailable` (R6: receipt key to assemble or snapshot, export key to bundle) */
export const BOM_MISSING_KEYS = ["receipt", "export"] as const;

const detail = z.string().max(2048).optional();
const retryAfterSeconds = bomIntSchema.min(1).max(86_400);
const plain = <C extends string>(code: C) => z.object({ error: z.literal(code), detail }).strict();

export const bomErrorEnvelopeSchema = z.discriminatedUnion("error", [
  // B1 / B3 codes
  plain("not_built"),
  plain("bom_snapshots_not_released"),
  plain("bom_export_forbidden"),
  /** the admin route class answers this until B4 moves the routes behind the in-handler role check */
  plain("admin_only"),
  plain("invalid_ai_bom_subject"),
  plain("ai_bom_subject_not_found"),
  plain("ai_bom_no_snapshot"),
  plain("ai_bom_build_refused"),
  plain("ai_bom_too_large"),
  plain("bom_snapshot_busy"),
  /** a configured receipt key that cannot be used (ADR-0189 R25 item 12): 503, distinct from a missing key's 409 */
  plain("receipt_signing_key_invalid"),
  z.object({ error: z.literal("rate_limited"), detail, retryAfterSeconds }).strict(),
  /** the global MFA gate (ADR-0181/0183): a session, or an API key (`credential: "api_key"`), whose owner must enroll TOTP */
  z.object({ error: z.literal("mfa_enrollment_required"), detail, credential: z.literal("api_key").optional() }).strict(),
  z.object({ error: z.literal("bom_signing_unavailable"), detail, missingKey: z.enum(BOM_MISSING_KEYS) }).strict(),
  z.object({ error: z.literal("bom_anchor_pending"), detail, reason: z.enum(BOM_ANCHOR_PENDING_REASONS), retryAfterSeconds }).strict(),
  z.object({ error: z.literal("format_not_rendered_for_snapshot"), detail, formats: z.array(z.enum(AI_BOM_DOWNLOAD_FORMATS)).min(1).max(8) }).strict(),
  // B4 codes
  plain("invalid_audit_id"),
  plain("invalid_bom_snapshot_id"),
  plain("invalid_bom_format"),
  plain("invalid_bom_version"),
  plain("invalid_bom_verify_request"),
  plain("bom_decision_not_found"),
  plain("bom_decision_not_eligible"),
  plain("bom_version_not_found"),
  plain("ai_bom_snapshot_not_found"),
  plain("bom_bundle_too_large"),
  /** R10 / R21: the email scan refused assembly or export; names the bundle file (`body` for the Decision BOM body at assembly) and the JSON path, never the value */
  z.object({ error: z.literal("bom_export_refused"), detail, reason: z.literal("email_shape"), file: z.string().min(1).max(256), path: z.string().min(1).max(1024) }).strict(),
  /** R5: a bound row's digest did not re-check at assembly; nothing is frozen */
  plain("bom_integrity_failure"),
]);
export type BomErrorEnvelope = z.infer<typeof bomErrorEnvelopeSchema>;
export type BomErrorCode = BomErrorEnvelope["error"];
export const BOM_B4_ERROR_CODES = bomErrorEnvelopeSchema.options.map((o) => o.shape.error.value) as BomErrorCode[];

// ---------------------------------------------------------------------------
// GET /v1/decisions/:auditId/bom
// ---------------------------------------------------------------------------

export const decisionBomParamsSchema = z.object({ auditId: bomPathUuidSchema }).strict();
/** `version` omitted = the newest version (first request assembles and freezes v1, OWNER DECISION 3) */
export const decisionBomReadQuerySchema = z.object({ version: queryVersion.optional() }).strict();
export type DecisionBomReadQuery = z.infer<typeof decisionBomReadQuerySchema>;

/** one frozen version of a decision's BOM (the "Decision BOM list" is this decision's versions) */
export const decisionBomVersionSummarySchema = z
  .object({
    id: bomUuidSchema,
    version: bomIntSchema.positive(),
    supersedes: bomUuidSchema.nullable(),
    finality: z.enum(DECISION_BOM_FINALITY_STATES),
    bodySha256: sha256Hex,
    keyId: bomKeyIdSchema,
    createdAt: bomTimeSchema,
  })
  .strict();
export type DecisionBomVersionSummary = z.infer<typeof decisionBomVersionSummarySchema>;

/** the one download path of a Decision BOM version (`bundle.href` is bound to it) */
export const decisionBomBundleHref = (auditId: string, version: number): string => `/v1/decisions/${auditId}/bom/bundle?version=${version}`;

export const bomBundleLinkSchema = z
  .object({
    schema: z.literal(EXPORT_BUNDLE_V3_SCHEMA),
    subject: z.enum(BOM_BUNDLE_SUBJECTS),
    /** the relative download path (a GET on a §9 bundle route) */
    href: z.string().min(1).max(256).regex(/^\/v1\/[A-Za-z0-9/_?=.-]+$/),
  })
  .strict();

export const decisionBomReadResponseSchema = z
  .object({
    auditId: bomUuidSchema,
    bom: decisionBomVersionSummarySchema.extend({
      /** the EXACT stored canonical bytes; nothing is re-rendered after freezing (§5) */
      body: z.string().min(2).max(16 * 1024 * 1024),
      /** base64url Ed25519 over `body` with the receipt key (OWNER DECISION 2) */
      signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
      aiBomSnapshotId: bomUuidSchema.nullable(),
      /** R44 at read time: `anchored_lapsed` once the recorded lock has passed; the body never changes */
      reportedFinality: z.enum(BOM_REPORTED_FINALITY_STATES),
    }).strict(),
    /** `body` parsed, for display; its canonical bytes equal `body` */
    document: decisionBomBodySchema,
    /** every frozen version of this decision, ascending */
    versions: z.array(decisionBomVersionSummarySchema).min(1).max(1024),
    /** renderings frozen with this version (`bom_renderings`), if any */
    renderings: z.array(z.enum(BOM_RENDERING_FORMATS)).max(BOM_RENDERING_FORMATS.length),
    bundle: bomBundleLinkSchema,
    capabilities: bomCapabilitiesSchema,
    /** ADR-0190 I4: the linked reports of the decision's offered placement (live, unsigned; absent before I4) */
    placementReports: z.array(decisionPlacementReportSchema).max(8).optional(),
    /**
     * ADR-0190 owner decision C (A1): the relaxation row the body's `execution.relaxation` names (live, unsigned).
     * Null when the body names none; absent from a gateway before A1.
     */
    executionRelaxation: decisionExecutionRelaxationRecordSchema.nullable().optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    // A1: the linked record is exactly the row the signed facts name, and present whenever they name one
    if (r.executionRelaxation !== undefined) {
      const signed = "execution" in r.document ? (r.document.execution?.relaxation ?? null) : null;
      const linked = r.executionRelaxation;
      if ((signed === null) !== (linked === null)) issue("executionRelaxation is present exactly when the signed facts name a relaxation");
      else if (signed && linked && (signed.relaxationId !== linked.id || signed.scopeKind !== linked.scopeKind || signed.scopeId !== linked.scopeId)) {
        issue("executionRelaxation is the row the signed facts name (id and scope)");
      }
    }
    if (bomSha256(r.bom.body) !== r.bom.bodySha256) issue("bodySha256 is SHA-256 of body");
    let canonical: string | null = null;
    try {
      canonical = bomCanonicalBytes(r.document);
    } catch {
      canonical = null;
    }
    if (canonical !== r.bom.body) issue("document is the parse of body (canonical bytes equal)");
    const d = r.document;
    if (d.id !== r.bom.id || d.auditId !== r.auditId || d.version !== r.bom.version || d.supersedes !== r.bom.supersedes || d.finality !== r.bom.finality) {
      issue("bom metadata matches the signed document");
    }
    if (d.basis.aiBomSnapshotId !== r.bom.aiBomSnapshotId) issue("aiBomSnapshotId is the document's basis link");
    if (!r.versions.some((v) => v.id === r.bom.id && v.version === r.bom.version)) issue("versions lists the returned version");
    if (r.versions.some((v, i) => i > 0 && v.version <= r.versions[i - 1]!.version)) issue("versions ascend");
    if (r.bundle.subject !== "decision-bom") issue("a Decision BOM links a decision-bom bundle");
    if (r.bundle.href !== decisionBomBundleHref(r.auditId, r.bom.version)) issue("bundle.href downloads exactly this decision's returned version");
    const lapsedOk = r.bom.reportedFinality === r.bom.finality || (r.bom.reportedFinality === "anchored_lapsed" && (r.bom.finality === "anchored" || r.bom.finality === "anchored_finite_lock"));
    if (!lapsedOk) issue("reportedFinality is the frozen state, or anchored_lapsed for an anchored state (R44)");
  });
export type DecisionBomReadResponse = z.infer<typeof decisionBomReadResponseSchema>;

// ---------------------------------------------------------------------------
// the bundle downloads (bytes: application/gzip, the ADR-0116 tar.gz layout)
// ---------------------------------------------------------------------------

export const aiBomSnapshotParamsSchema = z.object({ snapshotId: bomPathUuidSchema }).strict();
/** `GET /v1/ai-bom/snapshots/:snapshotId?format=`: a bundle holding the signed native body plus that one rendering */
export const aiBomSnapshotFormatQuerySchema = z.object({ format: z.enum(AI_BOM_DOWNLOAD_FORMATS).default("native") }).strict();
export type AiBomSnapshotFormatQuery = z.infer<typeof aiBomSnapshotFormatQuerySchema>;

/** the response headers of every BOM bundle download (lower-case names, as Node reports them) */
export const BOM_BUNDLE_HEADERS = {
  contentType: "content-type",
  contentDisposition: "content-disposition",
  schema: "x-regulait-bundle-schema",
  subject: "x-regulait-bundle-subject",
  archiveSha256: "x-regulait-bundle-sha256",
  manifestSha256: "x-regulait-bundle-manifest-sha256",
  exportKeyId: "x-regulait-export-signing-key-id",
  exportKeyFingerprint: "x-regulait-export-signing-key-fingerprint",
  bodySha256: "x-regulait-bom-body-sha256",
} as const;

export const bomBundleHeadersSchema = z
  .object({
    [BOM_BUNDLE_HEADERS.contentType]: z.literal("application/gzip"),
    [BOM_BUNDLE_HEADERS.contentDisposition]: z.string().max(256).regex(/^attachment; filename="regulait-[A-Za-z0-9._-]+\.tar\.gz"$/),
    [BOM_BUNDLE_HEADERS.schema]: z.literal(EXPORT_BUNDLE_V3_SCHEMA),
    [BOM_BUNDLE_HEADERS.subject]: z.enum(BOM_BUNDLE_SUBJECTS),
    [BOM_BUNDLE_HEADERS.archiveSha256]: sha256Hex,
    [BOM_BUNDLE_HEADERS.manifestSha256]: sha256Hex,
    [BOM_BUNDLE_HEADERS.exportKeyId]: bomKeyIdSchema,
    [BOM_BUNDLE_HEADERS.exportKeyFingerprint]: bomKeyFingerprintSchema,
    /** the signed BOM body inside (Decision BOM `body_sha256`, or the AI BOM snapshot's) */
    [BOM_BUNDLE_HEADERS.bodySha256]: sha256Hex,
  })
  .passthrough();
export type BomBundleHeaders = z.infer<typeof bomBundleHeadersSchema>;

/** a bundle file path: `content/…`, `audit/chain.tsv`, `signing-key.pub`, `README.txt` (no `..`, no leading slash) */
const bundlePath = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).refine((p) => !p.split("/").includes(".."), "no parent segments");

export const decisionBomBundleDescriptorSchema = z
  .object({
    auditId: bomUuidSchema,
    bomId: bomUuidSchema,
    version: bomIntSchema.positive(),
    finality: z.enum(DECISION_BOM_FINALITY_STATES),
    bodySha256: sha256Hex,
    receiptSeq: bomIntSchema.positive(),
    aiBomSnapshotId: bomUuidSchema.nullable(),
    formats: z.array(z.enum(BOM_RENDERING_FORMATS)).max(BOM_RENDERING_FORMATS.length),
  })
  .strict();
export const aiBomBundleDescriptorSchema = z
  .object({
    snapshotId: bomUuidSchema,
    subjectKind: z.enum(AI_BOM_SUBJECT_KINDS),
    subjectId: bomUuidSchema,
    version: bomIntSchema.positive(),
    serialNumber: z.string().max(45).regex(/^urn:uuid:[0-9a-f-]{36}$/),
    trigger: z.enum(AI_BOM_SNAPSHOT_TRIGGERS),
    bodySha256: sha256Hex,
    /** the formats this bundle carries (the native body is always present) */
    formats: z.array(z.enum(AI_BOM_DOWNLOAD_FORMATS)).min(1).max(AI_BOM_DOWNLOAD_FORMATS.length),
  })
  .strict();

/**
 * `manifest.json` of an export-bundle/3, as `POST /v1/boms/verify` echoes it.
 * Ids only (R45): unlike `/1`, no display name or email of the exporter, so the
 * R21 whole-bundle email scan cannot be tripped by the exporter's own identity.
 * No audit payload files (R39): `payloadScope` is always `none`.
 */
export const exportBundleV3ManifestSchema = z
  .object({
    schema: z.literal(EXPORT_BUNDLE_V3_SCHEMA),
    product: z.literal("regulait"),
    /** ADR-0116's install identity; refused when email-shaped (R21: the manifest is scanned too) */
    installId: z.string().min(1).max(256).refine((v) => !hasEmailShape(v), "an email-shaped installId is refused (R21)").nullable(),
    /** `absent` exactly when `installId` is null */
    installIdSource: z.enum(["operator", "license", "absent"]),
    exportedAt: bomTimeSchema,
    exportedAtSource: z.literal("database"),
    exportedByUserId: bomUuidSchema,
    subject: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("decision-bom"), id: bomUuidSchema, descriptor: decisionBomBundleDescriptorSchema }).strict(),
      z.object({ kind: z.literal("ai-bom"), id: bomUuidSchema, descriptor: aiBomBundleDescriptorSchema }).strict(),
    ]),
    files: z.array(z.object({ path: bundlePath, sha256: sha256Hex }).strict()).min(1).max(64),
    /** the hash-only chain segment (Decision BOMs); null for an AI BOM */
    audit: z
      .object({
        payloadScope: z.literal("none"),
        segmentFromSeq: bomIntSchema.positive(),
        segmentToSeq: bomIntSchema.positive(),
        segmentRowCount: bomIntSchema.positive(),
      })
      .strict()
      .nullable(),
    signingKeyId: bomKeyIdSchema,
    signingKeyFingerprint: bomKeyFingerprintSchema,
  })
  .strict()
  .superRefine((m, ctx) => {
    if ((m.subject.kind === "decision-bom") !== (m.audit !== null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a chain segment exactly for a Decision BOM bundle" });
    }
    if (m.audit && m.audit.segmentToSeq - m.audit.segmentFromSeq + 1 !== m.audit.segmentRowCount) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "the segment row count matches its range" });
    }
    const paths = m.files.map((f) => f.path);
    if (paths.some((p, i) => i > 0 && p <= paths[i - 1]!)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "files sorted by path, each once" });
    if (paths.some((p) => p.startsWith("audit/rows/"))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "no audit row payloads (R39)" });
    if ((m.installIdSource === "absent") !== (m.installId === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "installIdSource is absent exactly when installId is null" });
    }
    // R21: the manifest is email-scanned before it is signed, like every other bundle entry
    const emails = findEmailShapes(m);
    if (emails.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `email-shaped value at ${emails.join(", ")}` });
  });
export type ExportBundleV3Manifest = z.infer<typeof exportBundleV3ManifestSchema>;

// ---------------------------------------------------------------------------
// the export-key VERIFICATION trust root (master decision, round 2; spec B4.2)
// ---------------------------------------------------------------------------

/**
 * Online verify authenticates a bundle's manifest against a configured list of export PUBLIC keys, loaded
 * independently of the signing key, so a deployment with no export private key can still verify bundles. Two forms,
 * the same JSON document (`bomExportVerifyKeyringSchema`): inline in `REGULAIT_EXPORT_VERIFY_PUBLIC_KEYS`, or in a
 * file named by `REGULAIT_EXPORT_VERIFY_PUBLIC_KEYS_FILE` (air-gapped installs). A manifest whose `signingKeyId` is
 * not in the trusted set is `bundle_manifest_signature` `invalid` `unknown_key`. Implemented in B4.
 */
export const BOM_EXPORT_VERIFY_KEYS_ENV = "REGULAIT_EXPORT_VERIFY_PUBLIC_KEYS" as const;
export const BOM_EXPORT_VERIFY_KEYS_FILE_ENV = "REGULAIT_EXPORT_VERIFY_PUBLIC_KEYS_FILE" as const;
/** an Ed25519 SubjectPublicKeyInfo PEM, as `KeyObject.export({type: "spki", format: "pem"})` writes it */
const spkiPem = z.string().max(1024).regex(/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n?$/);
export const bomExportVerifyKeySchema = z
  .object({
    keyId: bomKeyIdSchema,
    publicKeyPem: spkiPem,
    /** optional pin: when given, the fingerprint of `publicKeyPem` must equal it or the keyring is refused at load */
    fingerprint: bomKeyFingerprintSchema.optional(),
  })
  .strict();
export const bomExportVerifyKeyringSchema = z
  .array(bomExportVerifyKeySchema)
  .min(1)
  .max(64)
  .refine((keys) => new Set(keys.map((k) => k.keyId)).size === keys.length, "each keyId once");
export type BomExportVerifyKeyring = z.infer<typeof bomExportVerifyKeyringSchema>;

// ---------------------------------------------------------------------------
// POST /v1/boms/verify (§6, §9, R6, R19)
// ---------------------------------------------------------------------------

/** the decoded bundle ceiling; the base64 text is at most 4/3 of it */
export const BOM_VERIFY_MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
export const BOM_VERIFY_MAX_BASE64 = Math.ceil(BOM_VERIFY_MAX_BUNDLE_BYTES / 3) * 4;
/**
 * The route's `bodyLimit`: the largest admitted request (the base64 text plus its JSON envelope,
 * `{"source":"bundle","bundleBase64":"…"}`) with headroom; above it the route answers 413 `bom_bundle_too_large`.
 */
export const BOM_VERIFY_MAX_REQUEST_BYTES = BOM_VERIFY_MAX_BASE64 + 1024;

/**
 * Three sources. The trust root is ALWAYS the server's recorded keys
 * (`receipt_signing_keys`, the export key) and its TSA trust bundle; no request
 * field supplies keys, trust roots or a verification time.
 *  - `bundle`: an export-bundle/3, base64 (the whole offline check, run online);
 *  - `decision_bom` / `ai_bom_snapshot`: the stored frozen document, verified in
 *    place (no outer manifest: those checks are reported `not_a_bundle`).
 */
export const bomVerifyRequestSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("bundle"),
      bundleBase64: z.string().min(4).max(BOM_VERIFY_MAX_BASE64).regex(/^[A-Za-z0-9+/]+={0,2}$/),
    })
    .strict(),
  z.object({ source: z.literal("decision_bom"), auditId: bomPathUuidSchema, version: bomIntSchema.positive().optional() }).strict(),
  z.object({ source: z.literal("ai_bom_snapshot"), snapshotId: bomPathUuidSchema }).strict(),
]);
export type BomVerifyRequest = z.input<typeof bomVerifyRequestSchema>;
export type BomVerifyRequestParsed = z.output<typeof bomVerifyRequestSchema>;

export const BOM_VERIFY_STATUSES = ["valid", "invalid", "unverifiable"] as const;
export type BomVerifyStatus = (typeof BOM_VERIFY_STATUSES)[number];

/** every check the verifier reports, both subjects (R19) */
export const BOM_VERIFY_CHECKS = [
  // the bundle envelope (ADR-0116 manifest)
  "bundle_manifest_signature",
  "bundle_manifest_files",
  "bundle_subject",
  "bundle_email_scan",
  // the signed body (both subjects)
  "body_version",
  "body_schema",
  "body_signature",
  // Decision BOM
  "receipt_signature",
  "receipt_payload_hash",
  "receipt_facts_binding",
  "facts_addenda_chain",
  "facts_addenda_signatures",
  "sections_projection",
  "chain_links",
  "decision_content_binding",
  "anchor_record",
  "anchor_imprint",
  "tsa_token",
  "finality",
  "ai_bom_link",
  // AI BOM
  "rendering_hashes",
  "serial_number",
  "supersedes",
] as const;
export type BomVerifyCheck = (typeof BOM_VERIFY_CHECKS)[number];
export const DECISION_BOM_ONLY_CHECKS = [
  "receipt_signature", "receipt_payload_hash", "receipt_facts_binding", "facts_addenda_chain", "facts_addenda_signatures",
  "sections_projection", "chain_links", "decision_content_binding", "anchor_record", "anchor_imprint", "tsa_token", "finality", "ai_bom_link",
] as const satisfies readonly BomVerifyCheck[];
export const AI_BOM_ONLY_CHECKS = ["rendering_hashes", "serial_number", "supersedes"] as const satisfies readonly BomVerifyCheck[];
/**
 * B4C-01: the checks a readable, non-`invalid` response MUST report (spec B4.4: a check that does not apply is left
 * out, so the conditional ones are named here too). Conditional, left out when not applicable:
 *  - Decision BOM: `facts_addenda_chain` and `facts_addenda_signatures` (no addenda), `ai_bom_link` (no snapshot link);
 *  - AI BOM: `rendering_hashes` (no rendering carried), `supersedes` (required exactly when version > 1).
 */
export const DECISION_BOM_REQUIRED_CHECKS = [
  "body_version", "body_schema", "body_signature",
  "receipt_signature", "receipt_payload_hash", "receipt_facts_binding",
  "sections_projection", "chain_links", "decision_content_binding",
  "anchor_record", "anchor_imprint", "tsa_token", "finality",
] as const satisfies readonly BomVerifyCheck[];
export const AI_BOM_REQUIRED_CHECKS = ["body_version", "body_schema", "body_signature", "serial_number"] as const satisfies readonly BomVerifyCheck[];
/** required for a `bundle` source; a stored source has no envelope and reports these only as `unverifiable` `not_a_bundle` */
export const BOM_BUNDLE_REQUIRED_CHECKS = ["bundle_manifest_signature", "bundle_manifest_files", "bundle_subject", "bundle_email_scan"] as const satisfies readonly BomVerifyCheck[];
/** a `chain_signed` BOM reports these `unverifiable` `anchor_absent` (B4.4) */
export const BOM_ANCHOR_CHECKS = ["anchor_record", "anchor_imprint", "tsa_token"] as const satisfies readonly BomVerifyCheck[];

export const BOM_VERIFY_INVALID_REASONS = [
  "signature_mismatch",
  "unknown_key",
  "unknown_body_version",
  "schema_violation",
  "hash_mismatch",
  "manifest_mismatch",
  "subject_mismatch",
  "facts_hash_mismatch",
  "v1_receipt_after_boundary",
  /** B4.9 G10: a v2 receipt below the trust root's boundary, or with no boundary recorded (B4.10) */
  "v2_receipt_before_boundary",
  "addendum_chain_break",
  "section_mismatch",
  "chain_break",
  "anchor_record_incomplete",
  "anchor_mismatch",
  "timestamp_invalid",
  "rendering_not_in_body",
  "serial_mismatch",
  "supersedes_mismatch",
  "bom_link_mismatch",
  "email_shape",
  "bundle_unreadable",
] as const;
export const BOM_VERIFY_UNVERIFIABLE_REASONS = [
  /** R39: the decision row's preimage is never exported */
  "preimage_not_exported",
  /** R46: a v1 receipt does not commit to the facts */
  "receipt_v1_no_factsHash",
  /** R33: a token granted before the request facts were recorded */
  "request_facts_not_recorded",
  "no_timestamp_token",
  "no_tsa_trust_bundle",
  /** `chain_signed`: no anchor in the proof */
  "anchor_absent",
  /** the BOM-Link target or the superseded snapshot is not in the bundle */
  "snapshot_not_in_bundle",
  "earlier_snapshot_not_in_bundle",
  /** R3: a format the standard cannot express without inventing a value */
  "rendering_not_producible",
  /** a stored-source verify has no outer manifest */
  "not_a_bundle",
] as const;
export type BomVerifyInvalidReason = (typeof BOM_VERIFY_INVALID_REASONS)[number];
export type BomVerifyUnverifiableReason = (typeof BOM_VERIFY_UNVERIFIABLE_REASONS)[number];

export const bomVerifyCheckResultSchema = z
  .object({
    check: z.enum(BOM_VERIFY_CHECKS),
    status: z.enum(BOM_VERIFY_STATUSES),
    reason: z.enum([...BOM_VERIFY_INVALID_REASONS, ...BOM_VERIFY_UNVERIFIABLE_REASONS]).nullable(),
    /** what the check ran on: a bundle file, a rendering format, `addendum:<n>`, `chain:<seq>`; never a value */
    ref: z.string().min(1).max(256).regex(/^[A-Za-z0-9._:/-]+$/).nullable(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const ok =
      r.status === "valid"
        ? r.reason === null
        : r.status === "invalid"
          ? (BOM_VERIFY_INVALID_REASONS as readonly string[]).includes(r.reason ?? "")
          : (BOM_VERIFY_UNVERIFIABLE_REASONS as readonly string[]).includes(r.reason ?? "");
    if (!ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "valid has no reason; invalid and unverifiable each take a reason of their own kind" });
  });
export type BomVerifyCheckResult = z.infer<typeof bomVerifyCheckResultSchema>;

/** §6's fixed list plus R4, R39, R44, R46, the #280 finite-lock entry and B4.8's two by-design limits (B4.10) */
export const BOM_CANNOT_PROVE = [
  "nothing_omitted_after_anchor",
  "facts_true",
  "signing_time_beyond_anchor",
  "destination_tamper_resistant",
  "decision_row_content",
  "commitment_after_retain_until",
  "facts_recorded_at_decision_time",
  "finite_lock_under_unbounded_retention",
  /** B4.8: a `chain_signed` Decision BOM has no anchor */
  "external_commitment",
  /** B4.8: an AI BOM bundle above version 1 never carries the snapshot it supersedes (B4.1) */
  "superseded_snapshot",
] as const;
export type BomCannotProve = (typeof BOM_CANNOT_PROVE)[number];
/** always present for every Decision BOM verify (§6, R4, R39) */
export const DECISION_BOM_CANNOT_PROVE_FIXED = [
  "nothing_omitted_after_anchor",
  "facts_true",
  "signing_time_beyond_anchor",
  "destination_tamper_resistant",
  "decision_row_content",
] as const satisfies readonly BomCannotProve[];
/** always present for every AI BOM verify */
export const AI_BOM_CANNOT_PROVE_FIXED = ["facts_true", "signing_time_beyond_anchor"] as const satisfies readonly BomCannotProve[];

/** the sentence the UI shows for each entry (the ADR's wording) */
export const BOM_CANNOT_PROVE_COPY: Readonly<Record<BomCannotProve, string>> = {
  nothing_omitted_after_anchor: "That nothing was omitted after the anchor.",
  facts_true: "That the facts were true: only that they were recorded and signed.",
  signing_time_beyond_anchor: "The signing time, beyond the anchor timestamp.",
  destination_tamper_resistant: "That the anchor destination is tamper-resistant: this is the server's recorded observation.",
  decision_row_content:
    "That the audit row's content is the decision described: the content hash is chained and anchored, but its preimage is not disclosed.",
  commitment_after_retain_until: "That the external commitment exists after its retain-until date.",
  facts_recorded_at_decision_time: "That these facts are the ones recorded at decision time: the receipt does not commit to them.",
  finite_lock_under_unbounded_retention: "That the anchor stays locked for the whole retention: the lock is finite while the retention has no end.",
  external_commitment: "That the chain row was committed outside this deployment: this BOM is chain_signed and has no anchor.",
  superseded_snapshot: "What the snapshot this one supersedes held: only its id is named, and it is not in the bundle.",
};

/**
 * ADR-0189 B4.8 (B4.10): `invalid` if any check or section is invalid; else `unverifiable` if any check is unverifiable
 * other than by design (`isUnverifiableByDesign`); else `valid`.
 */
export const BOM_VERIFY_OUTCOMES = ["valid", "unverifiable", "invalid"] as const;
export type BomVerifyOutcome = (typeof BOM_VERIFY_OUTCOMES)[number];
export const BOM_VERIFY_SOURCES = ["bundle", "decision_bom", "ai_bom_snapshot"] as const;
export type BomVerifySource = (typeof BOM_VERIFY_SOURCES)[number];

/** what B4.8's table needs to know about the verified subject; the Decision BOM fields are null for an AI BOM */
export interface BomByDesignContext {
  subject: "decision-bom" | "ai-bom";
  source: BomVerifySource;
  receiptPayloadVersion: "v1" | "v2" | null;
  recordedFinality: DecisionBomFinalityState | null;
  /** the Decision BOM or AI BOM snapshot version */
  version: number;
}

/**
 * ADR-0189 B4.8's table, exactly: an `unverifiable` result that a correct BOM always gives, because the bundle never
 * carries what the check would check. It is reported, its limit is listed in `cannotProve`, and it does not lower the
 * outcome. Every other `unverifiable` result does. Pure; `reason` is the check result's reason.
 */
export function isUnverifiableByDesign(check: BomVerifyCheck, reason: BomVerifyUnverifiableReason | BomVerifyInvalidReason | null, ctx: BomByDesignContext): boolean {
  if ((BOM_BUNDLE_REQUIRED_CHECKS as readonly string[]).includes(check)) return reason === "not_a_bundle" && ctx.source !== "bundle";
  if (ctx.subject === "decision-bom") {
    if (check === "decision_content_binding") return reason === "preimage_not_exported";
    if (check === "receipt_facts_binding") return reason === "receipt_v1_no_factsHash" && ctx.receiptPayloadVersion === "v1";
    if ((BOM_ANCHOR_CHECKS as readonly string[]).includes(check)) return reason === "anchor_absent" && ctx.recordedFinality === "chain_signed";
    return false;
  }
  return check === "supersedes" && reason === "earlier_snapshot_not_in_bundle" && ctx.source === "bundle" && ctx.version > 1;
}

/**
 * ADR-0189 B4.8: the exact `cannotProve` list of a verified subject: its fixed list plus each conditional entry whose
 * condition holds, in BOM_CANNOT_PROVE order, each once.
 */
export function bomCannotProveFor(ctx: BomByDesignContext & { reportedFinality: BomReportedFinality | null }): BomCannotProve[] {
  const want = new Set<BomCannotProve>(ctx.subject === "decision-bom" ? DECISION_BOM_CANNOT_PROVE_FIXED : AI_BOM_CANNOT_PROVE_FIXED);
  if (ctx.subject === "decision-bom") {
    if (ctx.receiptPayloadVersion === "v1") want.add("facts_recorded_at_decision_time");
    if (ctx.reportedFinality === "anchored_lapsed") want.add("commitment_after_retain_until");
    if (ctx.recordedFinality === "anchored_finite_lock") want.add("finite_lock_under_unbounded_retention");
    if (ctx.recordedFinality === "chain_signed") want.add("external_commitment");
  } else if (ctx.source === "bundle" && ctx.version > 1) want.add("superseded_snapshot");
  return BOM_CANNOT_PROVE.filter((c) => want.has(c));
}

/** a Decision BOM section as verified: the recomputed result and the recorded completeness (a gap is a limit, not a failure) */
export const bomVerifySectionSchema = z
  .object({
    section: z.enum(DECISION_BOM_SECTIONS_V2),
    status: z.enum(BOM_VERIFY_STATUSES),
    completeness: z.enum(BOM_SECTION_STATUSES),
    notRecordedReason: z.enum(BOM_NOT_RECORDED_REASONS).nullable(),
  })
  .strict()
  .refine((s) => (s.completeness === "not_recorded") === (s.notRecordedReason !== null), "a reason exactly when not_recorded");

export const bomVerifyIdentitySchema = z.discriminatedUnion("subject", [
  z
    .object({
      subject: z.literal("decision-bom"),
      auditId: bomUuidSchema,
      bomId: bomUuidSchema,
      version: bomIntSchema.positive(),
      /** the state frozen inside the signed body */
      recordedFinality: z.enum(DECISION_BOM_FINALITY_STATES),
      /** the state reported at `verifiedAt` (R44) */
      reportedFinality: z.enum(BOM_REPORTED_FINALITY_STATES),
      receiptPayloadVersion: z.enum(["v1", "v2"]),
    })
    .strict(),
  z
    .object({
      subject: z.literal("ai-bom"),
      snapshotId: bomUuidSchema,
      subjectKind: z.enum(AI_BOM_SUBJECT_KINDS),
      subjectId: bomUuidSchema,
      version: bomIntSchema.positive(),
      serialNumber: z.string().max(45).regex(/^urn:uuid:[0-9a-f-]{36}$/),
    })
    .strict(),
]);

export const bomVerifyResponseSchema = z
  .object({
    /** §9: the online verifier trusts the server's recorded keys, and says so */
    trust: z.literal("deployment_registry"),
    source: z.enum(BOM_VERIFY_SOURCES),
    /** null only when the bundle could not be read far enough to tell (then `invalid`) */
    bodyVersion: z.enum(BOM_BODY_VERSIONS).nullable(),
    identity: bomVerifyIdentitySchema.nullable(),
    outcome: z.enum(BOM_VERIFY_OUTCOMES),
    checks: z.array(bomVerifyCheckResultSchema).min(1).max(4096),
    /** Decision BOMs: one entry per section of the body's version, in `decisionBomSectionsFor` order (v2 adds `execution`, ADR-0190 I8); empty for an AI BOM */
    sections: z.array(bomVerifySectionSchema).max(DECISION_BOM_SECTIONS_V2.length),
    cannotProve: z.array(z.enum(BOM_CANNOT_PROVE)).max(BOM_CANNOT_PROVE.length),
    /** the bundle's manifest (bundle source only) */
    manifest: exportBundleV3ManifestSchema.nullable(),
    /** the database clock, used as `now` for R33's window and R44's lapse */
    verifiedAt: bomTimeSchema,
    capabilities: bomCapabilitiesSchema,
  })
  .strict()
  .superRefine((r, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    // B4.8: a section is never unverifiable in v1; it is the sections_projection result, valid or invalid
    if (r.sections.some((s) => s.status === "unverifiable")) issue("a section is valid or invalid in v1, never unverifiable (B4.8)");
    // B4.8 (B4C-02 kept): any invalid check or section -> invalid; else any unverifiable check NOT by design -> unverifiable; else valid
    const subject = r.identity;
    const design: BomByDesignContext | null =
      subject === null
        ? null
        : subject.subject === "decision-bom"
          ? { subject: subject.subject, source: r.source, receiptPayloadVersion: subject.receiptPayloadVersion, recordedFinality: subject.recordedFinality, version: subject.version }
          : { subject: subject.subject, source: r.source, receiptPayloadVersion: null, recordedFinality: null, version: subject.version };
    const anyInvalid = r.checks.some((c) => c.status === "invalid") || r.sections.some((s) => s.status === "invalid");
    const lowering = r.checks.some((c) => c.status === "unverifiable" && (design === null || !isUnverifiableByDesign(c.check, c.reason, design)));
    const want: BomVerifyOutcome = anyInvalid ? "invalid" : lowering ? "unverifiable" : "valid";
    if (r.outcome !== want) issue(`outcome is ${want} for these checks and sections (B4.8)`);
    // B4.8: cannotProve is exactly the subject's fixed list plus the conditional entries that hold, in BOM_CANNOT_PROVE order
    const wantCannotProve = subject === null || design === null ? [] : bomCannotProveFor({ ...design, reportedFinality: subject.subject === "decision-bom" ? subject.reportedFinality : null });
    if (r.cannotProve.join() !== wantCannotProve.join()) issue(`cannotProve is exactly [${wantCannotProve.join(", ")}] (B4.8)`);
    // a check reported more than once names a distinct `ref` each time (B4C-01)
    const seen = new Map<string, Array<string | null>>();
    for (const c of r.checks) seen.set(c.check, [...(seen.get(c.check) ?? []), c.ref]);
    for (const [check, refs] of seen) {
      if (refs.length > 1 && (refs.includes(null) || new Set(refs).size !== refs.length)) issue(`${check}: a repeated check needs a distinct ref each time`);
    }
    const of = (check: BomVerifyCheck) => r.checks.filter((c) => c.check === check);
    const all = (check: BomVerifyCheck, status: BomVerifyStatus, reason: string) => of(check).every((c) => c.status === status && c.reason === reason);
    if (r.identity === null || r.bodyVersion === null) {
      if (r.outcome !== "invalid" || !r.checks.some((c) => c.status === "invalid")) issue("an unreadable bundle is invalid, with the failing check");
    } else {
      const decision = r.identity.subject === "decision-bom";
      if (decision ? !(DECISION_BOM_VERSIONS as readonly string[]).includes(r.bodyVersion) : r.bodyVersion !== "regulait.ai-bom.v1") issue("bodyVersion matches the subject");
      // B4C-03: a stored source names its own subject; a bundle may hold either
      if ((r.source === "decision_bom" && !decision) || (r.source === "ai_bom_snapshot" && decision)) issue("the stored source matches the verified subject");
      const foreign = decision ? AI_BOM_ONLY_CHECKS : DECISION_BOM_ONLY_CHECKS;
      if (r.checks.some((c) => (foreign as readonly string[]).includes(c.check))) issue("checks belong to the subject (R19)");
      if (decision && r.sections.map((s) => s.section).join() !== decisionBomSectionsFor(r.bodyVersion).join()) issue("every Decision BOM section of its version, in order");
      if (!decision && r.sections.length) issue("an AI BOM has no Decision BOM sections");

      // B4C-01: the minimum check set for this source and subject; an inapplicable conditional check is left out (B4.4)
      const required: readonly BomVerifyCheck[] = [
        ...(decision ? DECISION_BOM_REQUIRED_CHECKS : AI_BOM_REQUIRED_CHECKS),
        ...(r.source === "bundle" ? BOM_BUNDLE_REQUIRED_CHECKS : []),
        ...(r.identity.subject === "ai-bom" && r.identity.version > 1 ? (["supersedes"] as const) : []),
      ];
      const missing = required.filter((c) => of(c).length === 0);
      if (missing.length && r.outcome !== "invalid") issue(`a ${r.outcome} response reports every required check; missing: ${missing.join(", ")}`);
      // the bundle envelope: claimed only for a bundle; a stored source may report it only as not_a_bundle
      for (const c of BOM_BUNDLE_REQUIRED_CHECKS) {
        if (r.source !== "bundle" && !all(c, "unverifiable", "not_a_bundle")) issue(`${c}: a stored source has no bundle envelope (only unverifiable not_a_bundle)`);
      }
      if (r.source === "bundle" && r.checks.some((c) => c.reason === "not_a_bundle")) issue("not_a_bundle is never reported for a bundle");
      if (r.checks.some((c) => c.reason === "not_a_bundle" && !(BOM_BUNDLE_REQUIRED_CHECKS as readonly string[]).includes(c.check))) issue("not_a_bundle applies to the bundle_* checks only");
      if (r.identity.subject === "ai-bom" && r.identity.version === 1 && of("supersedes").length) issue("version 1 supersedes nothing: the supersedes check is left out");
      // B4.8: a bundle never carries the superseded snapshot (B4.1), so above version 1 its supersedes check is
      // unverifiable earlier_snapshot_not_in_bundle, as a chain_signed BOM's anchor checks are anchor_absent
      if (r.identity.subject === "ai-bom" && r.identity.version > 1 && r.source === "bundle" && !all("supersedes", "unverifiable", "earlier_snapshot_not_in_bundle")) {
        issue("supersedes: unverifiable earlier_snapshot_not_in_bundle for a bundle above version 1");
      }
      if (r.identity.subject === "decision-bom") {
        const id = r.identity;
        // R39: the decision row's preimage is never exported, so its content binding is never claimed
        if (!all("decision_content_binding", "unverifiable", "preimage_not_exported")) issue("decision_content_binding is unverifiable preimage_not_exported (R39)");
        // R46: a v1 receipt never commits to the facts (or is invalid after the boundary, B4.3)
        const v1Binding = of("receipt_facts_binding").every((c) => (c.status === "unverifiable" && c.reason === "receipt_v1_no_factsHash") || (c.status === "invalid" && c.reason === "v1_receipt_after_boundary"));
        if (id.receiptPayloadVersion === "v1" && !v1Binding) issue("a v1 receipt's facts binding is unverifiable receipt_v1_no_factsHash, or invalid after the boundary (R46)");
        if (id.receiptPayloadVersion === "v2" && r.checks.some((c) => c.reason === "receipt_v1_no_factsHash" || c.reason === "v1_receipt_after_boundary")) issue("a v2 receipt takes no v1 reason");
        // B4.9 G10 (B4.10): v2_receipt_before_boundary is the facts binding of a v2 receipt only
        if (r.checks.some((c) => c.reason === "v2_receipt_before_boundary" && (id.receiptPayloadVersion !== "v2" || c.check !== "receipt_facts_binding"))) {
          issue("v2_receipt_before_boundary is reported only on receipt_facts_binding of a v2 receipt");
        }
        // a chain_signed BOM has no anchor: its anchor checks are unverifiable anchor_absent (B4.4)
        if (id.recordedFinality === "chain_signed") {
          for (const c of BOM_ANCHOR_CHECKS) if (!all(c, "unverifiable", "anchor_absent")) issue(`${c}: unverifiable anchor_absent for chain_signed`);
        } else if (r.checks.some((c) => c.reason === "anchor_absent")) issue("anchor_absent only for chain_signed");
        // B4C-02: a section result is the sections_projection result broken down; completeness is separate from validity
        const projection = of("sections_projection");
        const sectionInvalid = r.sections.some((s) => s.status === "invalid");
        const projectionInvalid = projection.some((c) => c.status === "invalid");
        if (sectionInvalid !== projectionInvalid) issue("a section is invalid exactly when sections_projection is invalid (section_mismatch)");
        if (projection.some((c) => c.status === "unverifiable")) issue("sections_projection is a pure recomputation: never unverifiable");
        const lapsed = id.reportedFinality === "anchored_lapsed";
        if (!(id.reportedFinality === id.recordedFinality || (lapsed && (id.recordedFinality === "anchored" || id.recordedFinality === "anchored_finite_lock")))) {
          issue("reportedFinality is the recorded state, or anchored_lapsed for an anchored state");
        }
      }
    }
    if ((r.source === "bundle") !== (r.manifest !== null) && r.outcome !== "invalid") issue("a manifest exactly for a readable bundle");
    if (new Set(r.cannotProve).size !== r.cannotProve.length) issue("cannotProve entries are distinct");
  });
export type BomVerifyResponse = z.infer<typeof bomVerifyResponseSchema>;

// ---------------------------------------------------------------------------
// the route table (what B4 answers; B1's stubs still answer 501 not_built)
// ---------------------------------------------------------------------------

export interface BomRouteContract {
  summary: string;
  params: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
  /** JSON responses carry a schema; bundle responses are `application/gzip` bytes with `bomBundleHeadersSchema` */
  response: { kind: "json"; schema: z.ZodTypeAny } | { kind: "bundle"; headers: z.ZodTypeAny };
  /** every refusal status and its codes (body: `bomErrorEnvelopeSchema`) */
  errors: Readonly<Record<number, readonly BomErrorCode[]>>;
}

const ACCESS_ERRORS = { 401: [], 403: ["bom_export_forbidden", "admin_only", "mfa_enrollment_required"], 429: ["rate_limited"], 501: ["not_built"] } as const;

export const BOM_B4_ROUTE_CONTRACT = {
  "GET /v1/decisions/:auditId/bom": {
    summary:
      "The signed Decision BOM of one receipt-eligible decision (assembled and frozen on first request), its versions and the caller's capabilities. Audited.",
    params: decisionBomParamsSchema,
    query: decisionBomReadQuerySchema,
    response: { kind: "json", schema: decisionBomReadResponseSchema },
    errors: {
      ...ACCESS_ERRORS,
      400: ["invalid_audit_id", "invalid_bom_version"],
      404: ["bom_decision_not_found", "bom_version_not_found"],
      409: ["bom_anchor_pending", "bom_signing_unavailable"],
      422: ["bom_decision_not_eligible", "bom_export_refused"],
      500: ["bom_integrity_failure"],
      503: ["receipt_signing_key_invalid"],
    },
  },
  "GET /v1/decisions/:auditId/bom/bundle": {
    summary: "The Decision BOM as a signed, offline-verifiable export-bundle/3 (tar.gz). Audited.",
    params: decisionBomParamsSchema,
    query: decisionBomReadQuerySchema,
    response: { kind: "bundle", headers: bomBundleHeadersSchema },
    errors: {
      ...ACCESS_ERRORS,
      400: ["invalid_audit_id", "invalid_bom_version"],
      404: ["bom_decision_not_found", "bom_version_not_found"],
      409: ["bom_anchor_pending", "bom_signing_unavailable"],
      422: ["bom_decision_not_eligible", "bom_export_refused"],
      500: ["bom_integrity_failure"],
      503: ["receipt_signing_key_invalid"],
    },
  },
  "GET /v1/ai-bom/snapshots/:snapshotId": {
    summary: "One signed AI BOM snapshot in one format, always inside an export-bundle/3 with the signed native body (R7). Audited.",
    params: aiBomSnapshotParamsSchema,
    query: aiBomSnapshotFormatQuerySchema,
    response: { kind: "bundle", headers: bomBundleHeadersSchema },
    errors: {
      ...ACCESS_ERRORS,
      400: ["invalid_bom_snapshot_id", "invalid_bom_format"],
      404: ["ai_bom_snapshot_not_found", "format_not_rendered_for_snapshot"],
      409: ["bom_signing_unavailable"],
      422: ["bom_export_refused"],
      500: ["bom_integrity_failure"],
    },
  },
  "GET /v1/ai-bom/snapshots/:snapshotId/bundle": {
    summary: "One signed AI BOM snapshot with every rendered format, as an export-bundle/3. Audited.",
    params: aiBomSnapshotParamsSchema,
    response: { kind: "bundle", headers: bomBundleHeadersSchema },
    errors: {
      ...ACCESS_ERRORS,
      400: ["invalid_bom_snapshot_id"],
      404: ["ai_bom_snapshot_not_found"],
      409: ["bom_signing_unavailable"],
      422: ["bom_export_refused"],
      500: ["bom_integrity_failure"],
    },
  },
  "POST /v1/boms/verify": {
    summary:
      "The pure BOM verifier, online: checks a bundle or a stored frozen BOM against the server's recorded keys (never caller-supplied ones). Needs no private key (R6). Audited.",
    params: z.object({}).strict(),
    body: bomVerifyRequestSchema,
    response: { kind: "json", schema: bomVerifyResponseSchema },
    errors: {
      ...ACCESS_ERRORS,
      400: ["invalid_bom_verify_request"],
      404: ["bom_decision_not_found", "bom_version_not_found", "ai_bom_snapshot_not_found"],
      413: ["bom_bundle_too_large"],
    },
  },
} as const satisfies Record<string, BomRouteContract>;
export type BomB4Route = keyof typeof BOM_B4_ROUTE_CONTRACT;
export const BOM_B4_ROUTES = Object.keys(BOM_B4_ROUTE_CONTRACT) as BomB4Route[];
