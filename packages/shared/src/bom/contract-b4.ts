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
  DECISION_BOM_SECTIONS,
  decisionBomBodySchema,
} from "./contract.js";

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
  z.object({ error: z.literal("rate_limited"), detail, retryAfterSeconds }).strict(),
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
  })
  .strict()
  .superRefine((r, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
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
    installId: z.string().min(1).max(256).nullable(),
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
  });
export type ExportBundleV3Manifest = z.infer<typeof exportBundleV3ManifestSchema>;

// ---------------------------------------------------------------------------
// POST /v1/boms/verify (§6, §9, R6, R19)
// ---------------------------------------------------------------------------

/** the decoded bundle ceiling; the base64 text is at most 4/3 of it */
export const BOM_VERIFY_MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const BOM_VERIFY_MAX_BASE64 = Math.ceil(BOM_VERIFY_MAX_BUNDLE_BYTES / 3) * 4;

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

/** §6's fixed list plus R4, R39, R44, R46 and the #280 finite-lock entry */
export const BOM_CANNOT_PROVE = [
  "nothing_omitted_after_anchor",
  "facts_true",
  "signing_time_beyond_anchor",
  "destination_tamper_resistant",
  "decision_row_content",
  "commitment_after_retain_until",
  "facts_recorded_at_decision_time",
  "finite_lock_under_unbounded_retention",
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
};

export const BOM_VERIFY_OUTCOMES = ["valid", "valid_with_unverifiable", "invalid"] as const;

/** a Decision BOM section as verified: the recomputed result and the recorded completeness (a gap is a limit, not a failure) */
export const bomVerifySectionSchema = z
  .object({
    section: z.enum(DECISION_BOM_SECTIONS),
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
    source: z.enum(["bundle", "decision_bom", "ai_bom_snapshot"]),
    /** null only when the bundle could not be read far enough to tell (then `invalid`) */
    bodyVersion: z.enum(BOM_BODY_VERSIONS).nullable(),
    identity: bomVerifyIdentitySchema.nullable(),
    outcome: z.enum(BOM_VERIFY_OUTCOMES),
    checks: z.array(bomVerifyCheckResultSchema).min(1).max(4096),
    /** Decision BOMs: one entry per section, in DECISION_BOM_SECTIONS order; empty for an AI BOM */
    sections: z.array(bomVerifySectionSchema).max(DECISION_BOM_SECTIONS.length),
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
    const statuses = new Set(r.checks.map((c) => c.status));
    const want = statuses.has("invalid") ? "invalid" : statuses.has("unverifiable") ? "valid_with_unverifiable" : "valid";
    if (r.outcome !== want) issue(`outcome is ${want} for these checks`);
    if (r.identity === null || r.bodyVersion === null) {
      if (r.outcome !== "invalid") issue("an unreadable bundle is invalid");
    } else {
      const decision = r.identity.subject === "decision-bom";
      if (r.bodyVersion !== (decision ? "regulait.decision-bom.v1" : "regulait.ai-bom.v1")) issue("bodyVersion matches the subject");
      const foreign = decision ? AI_BOM_ONLY_CHECKS : DECISION_BOM_ONLY_CHECKS;
      if (r.checks.some((c) => (foreign as readonly string[]).includes(c.check))) issue("checks belong to the subject (R19)");
      if (decision && r.sections.map((s) => s.section).join() !== DECISION_BOM_SECTIONS.join()) issue("every Decision BOM section, in order");
      if (!decision && r.sections.length) issue("an AI BOM has no Decision BOM sections");
      const fixed = decision ? DECISION_BOM_CANNOT_PROVE_FIXED : AI_BOM_CANNOT_PROVE_FIXED;
      if (fixed.some((c) => !r.cannotProve.includes(c))) issue("the fixed cannotProve list is always present");
      if (r.identity.subject === "decision-bom") {
        const id = r.identity;
        const lapsed = id.reportedFinality === "anchored_lapsed";
        if (!(id.reportedFinality === id.recordedFinality || (lapsed && (id.recordedFinality === "anchored" || id.recordedFinality === "anchored_finite_lock")))) {
          issue("reportedFinality is the recorded state, or anchored_lapsed for an anchored state");
        }
        if (lapsed && !r.cannotProve.includes("commitment_after_retain_until")) issue("a lapsed lock adds commitment_after_retain_until (R44)");
        if (id.recordedFinality === "anchored_finite_lock" && !r.cannotProve.includes("finite_lock_under_unbounded_retention")) issue("a finite lock adds its cannotProve entry");
        if (id.receiptPayloadVersion === "v1" && !r.cannotProve.includes("facts_recorded_at_decision_time")) issue("a v1 receipt adds facts_recorded_at_decision_time (R46)");
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

const ACCESS_ERRORS = { 401: [], 403: ["bom_export_forbidden", "admin_only"], 429: ["rate_limited"], 501: ["not_built"] } as const;

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
