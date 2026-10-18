/**
 * ADR-0189 B6: the AI BOM and Decision BOM evidence UI, browser side.
 *
 * The SPA does not depend on `@regulait/shared` at runtime, so the vocabularies
 * below MIRROR `packages/shared/src/bom/{contract,contract-b4,settings}.ts`.
 * `bomModel.test.ts` imports the shared source and fails when they drift.
 *
 * Two rules this module keeps:
 *  - A response that does not have the shape the live contract gives is
 *    refused (`BomEvidenceError`), never shown in part. The gateway is the
 *    authority on what is valid; the browser only declines to display what it
 *    cannot read.
 *  - A refusal is shown as what it is. `bomRefusalText` turns every refusal
 *    code the BOM routes answer into a sentence that says what did NOT happen,
 *    so a missing signing key never reads as a success or a generic failure.
 */
import { ApiError } from "../../../api/client";

// ---------------------------------------------------------------------------
// vocabularies (mirrored; pinned by bomModel.test.ts)
// ---------------------------------------------------------------------------

export const AI_BOM_SUBJECT_KINDS = ["use_case", "agent", "builder_agent", "install"] as const;
export type BomSubjectKind = (typeof AI_BOM_SUBJECT_KINDS)[number];
export const AI_BOM_INSTALL_SUBJECT_ID = "00000000-0000-0000-0000-000000000000";
export const AI_BOM_SNAPSHOT_TRIGGERS = [
  "on_demand",
  "use_case_approval",
  "model_card_approval",
  "prompt_promotion",
  "evidence_attached",
  "config_promotion",
  "server_admission",
  "skill_admission",
] as const;
export const AI_BOM_DOWNLOAD_FORMATS = ["native", "cyclonedx-1.7", "cyclonedx-1.6", "spdx-3.0.1"] as const;
export type BomFormat = (typeof AI_BOM_DOWNLOAD_FORMATS)[number];
export const BOM_RENDERING_FORMATS = ["cyclonedx-1.7", "cyclonedx-1.6", "spdx-3.0.1", "in-toto"] as const;
export const AI_BOM_DRIFT_CHANGES = ["added", "removed", "changed_hash", "changed_version"] as const;

export const DECISION_BOM_SECTIONS = ["decision", "receipt", "principal", "actors", "action", "policy", "model", "approval", "outcome", "cost", "trace", "proof"] as const;
/** ADR-0190 I8: a v2 body adds `execution` after the v1 sections */
export const DECISION_BOM_SECTIONS_V2 = [...DECISION_BOM_SECTIONS, "execution"] as const;
export const BOM_SECTION_STATUSES = ["recorded", "not_applicable", "not_recorded"] as const;
export const BOM_NOT_RECORDED_REASONS = ["pre_identity", "pre_facts", "capture_off", "no_bound_row", "unsigned_addendum", "not_captured_by_path", "anchor_absent", "pre_isolation", "no_placement"] as const;

// ADR-0190 decision 9 / I8: the execution facts vocabularies (`packages/shared/src/isolation/contract.ts`, mirrored)
export const WORKLOAD_KINDS = ["model_call", "connector_call", "remote_mcp", "mcp_stdio", "code_exec", "engine_worker", "byoc_worker"] as const;
export const DECISION_EXECUTION_PLACEMENTS = ["in_gateway", "external", "placed", "refused", "mismatch", "offered"] as const;
/** ADR-0190 I4: the linked report rows of an offered placement (`execution_placement_reports`), mirrored */
export const PLACEMENT_REPORT_OUTCOMES = ["placed", "mismatch", "refused", "cancelled", "session_lost"] as const;
export const PLACEMENT_END_CODES = ["later_gate", "placement_timeout", "session_abandoned", "session_unknown"] as const;
export const REQUIRABLE_ISOLATION_CLASSES = ["hardened_container", "user_space_kernel", "microvm"] as const;
export const DECISION_EXECUTION_APPLIED = ["in_gateway", "external", ...REQUIRABLE_ISOLATION_CLASSES, "customer_declared"] as const;
export const REQUIRED_CLASS_SOURCES = ["workload_kind", "data_sensitivity", "compliance_tag", "autonomy_class", "configured_profile", "unknown_agent", "parent_grant"] as const;
export const DECISION_EXECUTION_REFUSAL_CODES = ["no_executor", "attestation_stale", "class_below_required", "executor_quarantined", "profile_retired", "policy_unresolved", "execution_profile_mismatch"] as const;
export const EXECUTOR_BACKENDS = ["runc", "gvisor", "kata", "openshell", "customer"] as const;
export const DECISION_BOM_FINALITY_STATES = ["anchored", "anchored_finite_lock", "anchored_unverified_destination", "chain_signed"] as const;
export const BOM_REPORTED_FINALITY_STATES = [...DECISION_BOM_FINALITY_STATES, "anchored_lapsed"] as const;
export const BOM_ANCHOR_PENDING_REASONS = [
  "anchor_not_flushed",
  "destination_not_tamper_resistant",
  "timestamp_pending",
  "lock_not_recorded",
  "lock_shorter_than_retention",
  "lock_lapsed",
  "retention_unbounded",
  "receipt_unsigned",
] as const;

export const BOM_VERIFY_CHECKS = [
  "bundle_manifest_signature", "bundle_manifest_files", "bundle_subject", "bundle_email_scan",
  "body_version", "body_schema", "body_signature",
  "receipt_signature", "receipt_payload_hash", "receipt_facts_binding", "facts_addenda_chain", "facts_addenda_signatures",
  "sections_projection", "chain_links", "decision_content_binding", "anchor_record", "anchor_imprint", "tsa_token", "finality", "ai_bom_link",
  "rendering_hashes", "serial_number", "supersedes",
] as const;
export type BomVerifyCheck = (typeof BOM_VERIFY_CHECKS)[number];
export const BOM_VERIFY_INVALID_REASONS = [
  "signature_mismatch", "unknown_key", "unknown_body_version", "schema_violation", "hash_mismatch", "manifest_mismatch",
  "subject_mismatch", "facts_hash_mismatch", "v1_receipt_after_boundary", "v2_receipt_before_boundary", "addendum_chain_break",
  "section_mismatch", "chain_break", "anchor_record_incomplete", "anchor_mismatch", "timestamp_invalid", "rendering_not_in_body",
  "serial_mismatch", "supersedes_mismatch", "bom_link_mismatch", "email_shape", "bundle_unreadable",
] as const;
export const BOM_VERIFY_UNVERIFIABLE_REASONS = [
  "preimage_not_exported", "receipt_v1_no_factsHash", "request_facts_not_recorded", "no_timestamp_token", "no_tsa_trust_bundle",
  "anchor_absent", "snapshot_not_in_bundle", "earlier_snapshot_not_in_bundle", "rendering_not_producible", "not_a_bundle",
] as const;
export const BOM_VERIFY_OUTCOMES = ["valid", "unverifiable", "invalid"] as const;
export type BomVerifyOutcome = (typeof BOM_VERIFY_OUTCOMES)[number];
export const BOM_VERIFY_SOURCES = ["bundle", "decision_bom", "ai_bom_snapshot"] as const;
/** contract.ts `BOM_BODY_VERSIONS`: the signed body each subject carries */
export const DECISION_BOM_VERSION = "regulait.decision-bom.v1";
/** ADR-0190 I8: every Decision BOM frozen from I8 on; v1 bodies stay readable */
export const DECISION_BOM_VERSION_V2 = "regulait.decision-bom.v2";
export const DECISION_BOM_VERSIONS = [DECISION_BOM_VERSION, DECISION_BOM_VERSION_V2] as const;
export const AI_BOM_VERSION = "regulait.ai-bom.v1";
export const BOM_BODY_VERSIONS = [DECISION_BOM_VERSION, DECISION_BOM_VERSION_V2, AI_BOM_VERSION] as const;
/** the sections a Decision BOM body of version `v` carries */
export const decisionBomSectionsFor = (v: string): readonly string[] => (v === DECISION_BOM_VERSION ? DECISION_BOM_SECTIONS : DECISION_BOM_SECTIONS_V2);
export type BomVerifySource = (typeof BOM_VERIFY_SOURCES)[number];
export const BOM_BUNDLE_REQUIRED_CHECKS = ["bundle_manifest_signature", "bundle_manifest_files", "bundle_subject", "bundle_email_scan"] as const;
export const BOM_ANCHOR_CHECKS = ["anchor_record", "anchor_imprint", "tsa_token"] as const;
/** B4C-01: the checks a readable, non-invalid report MUST carry, per subject (contract-b4, mirrored) */
export const DECISION_BOM_REQUIRED_CHECKS = [
  "body_version", "body_schema", "body_signature",
  "receipt_signature", "receipt_payload_hash", "receipt_facts_binding",
  "sections_projection", "chain_links", "decision_content_binding",
  "anchor_record", "anchor_imprint", "tsa_token", "finality",
] as const;
export const AI_BOM_REQUIRED_CHECKS = ["body_version", "body_schema", "body_signature", "serial_number"] as const;
export const DECISION_BOM_ONLY_CHECKS = [
  "receipt_signature", "receipt_payload_hash", "receipt_facts_binding", "facts_addenda_chain", "facts_addenda_signatures",
  "sections_projection", "chain_links", "decision_content_binding", "anchor_record", "anchor_imprint", "tsa_token", "finality", "ai_bom_link",
] as const;
export const AI_BOM_ONLY_CHECKS = ["rendering_hashes", "serial_number", "supersedes"] as const;
export const DECISION_BOM_CANNOT_PROVE_FIXED = ["nothing_omitted_after_anchor", "facts_true", "signing_time_beyond_anchor", "destination_tamper_resistant", "decision_row_content"] as const;
export const AI_BOM_CANNOT_PROVE_FIXED = ["facts_true", "signing_time_beyond_anchor"] as const;

/** the ADR's sentence for each limit (contract-b4 `BOM_CANNOT_PROVE_COPY`, verbatim) */
export const BOM_CANNOT_PROVE_COPY: Readonly<Record<string, string>> = {
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
export const BOM_CANNOT_PROVE = Object.keys(BOM_CANNOT_PROVE_COPY);

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/** the browser could not read a BOM response, or a download failed its transport checks; nothing is shown or saved */
export class BomEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BomEvidenceError";
  }
}
const unreadable = (what: string): never => {
  throw new BomEvidenceError(`${what} could not be read: the response does not match the BOM contract, so nothing from it is shown.`);
};

// ---------------------------------------------------------------------------
// small checks
// ---------------------------------------------------------------------------

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;
const SERIAL = /^urn:uuid:[0-9a-f-]{36}$/;
const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const oneOf = <T extends string>(values: readonly T[], v: unknown): v is T => typeof v === "string" && (values as readonly string[]).includes(v);
const posInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const str = (v: unknown, max = 256): v is string => typeof v === "string" && v.length <= max;
const time = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
const uuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const sha = (v: unknown): v is string => typeof v === "string" && SHA256_HEX.test(v);
/** a `.strict()` object of the shared contract: exactly these keys, none missing and none extra */
const exactKeys = (o: Obj, keys: readonly string[]) => Object.keys(o).sort().join() === [...keys].sort().join();

// ---------------------------------------------------------------------------
// subjects
// ---------------------------------------------------------------------------

export interface BomSubject {
  kind: BomSubjectKind;
  id: string;
}

/** `/v1/ai-bom/:kind/:id`; the install subject is the nil key and only that (R20) */
export function subjectPath(subject: BomSubject): string {
  const id = subject.id.toLowerCase();
  if (!oneOf(AI_BOM_SUBJECT_KINDS, subject.kind) || !UUID.test(id) || (subject.kind === "install") !== (id === AI_BOM_INSTALL_SUBJECT_ID)) {
    throw new BomEvidenceError("This is not a valid AI BOM subject.");
  }
  return `/v1/ai-bom/${subject.kind}/${id}`;
}

export function checkedAuditId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!UUID.test(id)) throw new BomEvidenceError("Enter the decision's audit row ID (a UUID).");
  return id;
}

// ---------------------------------------------------------------------------
// GET /v1/ai-bom/:kind/:id/snapshots and POST …/snapshots
// ---------------------------------------------------------------------------

export interface BomSnapshot {
  id: string;
  version: number;
  serialNumber: string;
  trigger: string;
  bodySha256: string;
  keyId: string;
  createdAt: string;
  /** the renderings stored with the snapshot; `native` is always downloadable */
  formats: string[];
}
export interface SnapshotList {
  subject: BomSubject;
  released: boolean;
  snapshots: BomSnapshot[];
}

export function readSnapshotList(value: unknown, subject: BomSubject): SnapshotList {
  const v = obj(value);
  const s = obj(v?.subject);
  if (!v || !s || s.kind !== subject.kind || s.id !== subject.id.toLowerCase() || typeof v.released !== "boolean" || !Array.isArray(v.snapshots)) {
    return unreadable("The snapshot list");
  }
  const snapshots = v.snapshots.map((raw): BomSnapshot => {
    const r = obj(raw);
    if (
      !r || !uuid(r.id) || !posInt(r.version) || !str(r.serialNumber, 45) || !SERIAL.test(r.serialNumber) || !oneOf(AI_BOM_SNAPSHOT_TRIGGERS, r.trigger) ||
      !sha(r.bodySha256) || !str(r.keyId) || !KEY_ID.test(r.keyId) || !time(r.createdAt) || !Array.isArray(r.formats) ||
      !r.formats.every((f) => oneOf(BOM_RENDERING_FORMATS, f))
    ) {
      return unreadable("The snapshot list");
    }
    return { id: r.id, version: r.version, serialNumber: r.serialNumber, trigger: r.trigger, bodySha256: r.bodySha256, keyId: r.keyId, createdAt: r.createdAt, formats: r.formats as string[] };
  });
  return { subject, released: v.released, snapshots };
}

export interface CreatedSnapshot {
  id: string;
  version: number;
  serialNumber: string;
  bodySha256: string;
}
export function readCreatedSnapshot(value: unknown): CreatedSnapshot {
  const v = obj(value);
  if (!v || !uuid(v.id) || !posInt(v.version) || !str(v.serialNumber, 45) || !SERIAL.test(v.serialNumber) || !sha(v.bodySha256)) {
    return unreadable("The new snapshot's record");
  }
  return { id: v.id, version: v.version, serialNumber: v.serialNumber, bodySha256: v.bodySha256 };
}

/** formats a snapshot can be downloaded in: native always, the others only when rendered (R2) */
export function downloadableFormats(snapshot: BomSnapshot): BomFormat[] {
  return AI_BOM_DOWNLOAD_FORMATS.filter((f) => f === "native" || snapshot.formats.includes(f));
}

// ---------------------------------------------------------------------------
// GET /v1/ai-bom/:kind/:id/drift (R8: a change list, never evidence) and its gaps (R25 item 4)
// ---------------------------------------------------------------------------

export interface BomGap {
  auditId: string;
  at: string;
  kind: "skipped_no_key" | "failed";
  trigger: string | null;
  triggeringObjectId: string | null;
  code: string | null;
}
export interface BomGaps {
  gaps: BomGap[];
  gapsTruncated: boolean;
}
export interface DriftSide {
  version: string | null;
  hashes: string[];
}
export interface BomDriftChange {
  ref: string;
  change: (typeof AI_BOM_DRIFT_CHANGES)[number];
  before: DriftSide | null;
  after: DriftSide | null;
}
export interface BomDrift extends BomGaps {
  evidence: false;
  baseline: { snapshotId: string; version: number; createdAt: string; serialNumber: string };
  changes: BomDriftChange[];
}

/** the gaps a drift response (or drift's 409 `ai_bom_no_snapshot`) carries */
export function readGaps(value: unknown): BomGaps {
  const v = obj(value);
  if (!v || !Array.isArray(v.gaps) || typeof v.gapsTruncated !== "boolean") return unreadable("The snapshot gaps");
  const nullable = (x: unknown) => x === null || str(x);
  const gaps = v.gaps.map((raw): BomGap => {
    const g = obj(raw);
    if (!g || !uuid(g.auditId) || !time(g.at) || !oneOf(["skipped_no_key", "failed"] as const, g.kind) || !nullable(g.trigger) || !nullable(g.triggeringObjectId) || !nullable(g.code)) {
      return unreadable("The snapshot gaps");
    }
    return { auditId: g.auditId, at: g.at, kind: g.kind, trigger: g.trigger as string | null, triggeringObjectId: g.triggeringObjectId as string | null, code: g.code as string | null };
  });
  return { gaps, gapsTruncated: v.gapsTruncated };
}

export function readDrift(value: unknown, subject: BomSubject): BomDrift {
  const v = obj(value);
  const s = obj(v?.subject);
  const b = obj(v?.baseline);
  if (
    !v || v.evidence !== false || !s || s.kind !== subject.kind || s.id !== subject.id.toLowerCase() || !b || !uuid(b.snapshotId) || !posInt(b.version) ||
    !time(b.createdAt) || !str(b.serialNumber, 45) || !SERIAL.test(b.serialNumber) || !Array.isArray(v.changes)
  ) {
    return unreadable("The drift report");
  }
  const side = (x: unknown): DriftSide | null => {
    if (x === null) return null;
    const o = obj(x);
    if (!o || !(o.version === null || str(o.version, 512)) || !Array.isArray(o.hashes) || !o.hashes.every((h) => str(h, 256))) return unreadable("The drift report");
    return { version: o.version as string | null, hashes: o.hashes as string[] };
  };
  const changes = v.changes.map((raw): BomDriftChange => {
    const c = obj(raw);
    if (!c || !str(c.ref, 512) || !oneOf(AI_BOM_DRIFT_CHANGES, c.change)) return unreadable("The drift report");
    return { ref: c.ref, change: c.change, before: side(c.before), after: side(c.after) };
  });
  return {
    evidence: false,
    baseline: { snapshotId: b.snapshotId, version: b.version, createdAt: b.createdAt, serialNumber: b.serialNumber },
    changes,
    ...readGaps(v),
  };
}

/** what a drift `ref` (a CycloneDX bom-ref, `aiBomRef` in the shared builder) names, in words */
const REF_KINDS: Array<[string, string]> = [
  ["service:mcp:", "MCP server or tool"],
  // ADR-0190 I8
  ["service:executor:", "Executor"],
  ["execution-profile:", "Execution profile"],
  ["service:connector:", "Connector"],
  ["service:provider:", "Model provider endpoint"],
  ["subject:", "This subject"],
  ["use-case:", "Use case"],
  ["builder-agent:", "Builder agent"],
  ["agent:", "Agent"],
  ["model:", "Model"],
  ["modelcard:", "Model card"],
  ["training-artifact:", "Training artifact"],
  ["artifact:", "Model artifact"],
  ["engine:", "Scan engine"],
  ["dataset:training:", "Training dataset"],
  ["dataset:eval:", "Evaluation dataset"],
  ["prompt:", "Prompt"],
  ["config:", "Configuration"],
  ["skill:", "Skill"],
  ["memory:", "Memory store"],
  ["dev-tool:", "Development tool"],
];
export function driftRefKind(ref: string): string {
  if (ref === "install") return "Install";
  return REF_KINDS.find(([prefix]) => ref.startsWith(prefix))?.[1] ?? "Component";
}

// ---------------------------------------------------------------------------
// capabilities (what the server decided for this caller; never an input)
// ---------------------------------------------------------------------------

export interface BomCapabilities {
  access: "admin" | "auditor_grant";
  exportRoles: "admins_only" | "admins_and_auditors";
  canExport: boolean;
  exportUnavailableReason: "export_signing_key_absent" | null;
  canVerify: boolean;
  canViewDrift: boolean;
  rateLimitPerMinute: number;
}
/** contract-b4 `bomCapabilitiesSchema`, including its refinements */
export function readCapabilities(value: unknown): BomCapabilities {
  const v = obj(value);
  const grant = obj(v?.auditorGrant);
  const grantOk = v?.auditorGrant === null || (grant !== null && uuid(grant.id) && uuid(grant.grantedBy) && time(grant.grantedAt));
  if (
    !v || !oneOf(["admin", "auditor_grant"] as const, v.access) || !oneOf(["admins_only", "admins_and_auditors"] as const, v.exportRoles) ||
    typeof v.canExport !== "boolean" || typeof v.canVerify !== "boolean" || typeof v.canViewDrift !== "boolean" ||
    !(v.exportUnavailableReason === null || v.exportUnavailableReason === "export_signing_key_absent") ||
    v.canExport !== (v.exportUnavailableReason === null) || !posInt(v.rateLimitPerMinute) || v.rateLimitPerMinute > 600 ||
    // OWNER DECISION 9: never a step-up for reading or exporting
    v.exportRequiresStepUp !== false ||
    // R8: drift is admins only, never auditors
    v.canViewDrift !== (v.access === "admin") ||
    // an auditor needs an active grant and the relaxed setting
    !grantOk || (v.access === "auditor_grant" && (grant === null || v.exportRoles !== "admins_and_auditors"))
  ) {
    return unreadable("Your BOM access");
  }
  return {
    access: v.access,
    exportRoles: v.exportRoles,
    canExport: v.canExport,
    exportUnavailableReason: v.exportUnavailableReason as BomCapabilities["exportUnavailableReason"],
    canVerify: v.canVerify,
    canViewDrift: v.canViewDrift,
    rateLimitPerMinute: v.rateLimitPerMinute,
  };
}

// ---------------------------------------------------------------------------
// GET /v1/decisions/:auditId/bom
// ---------------------------------------------------------------------------

export interface SectionCompleteness {
  section: string;
  status: (typeof BOM_SECTION_STATUSES)[number];
  reason: string | null;
}
export interface DecisionBomVersion {
  id: string;
  version: number;
  finality: string;
  bodySha256: string;
  keyId: string;
  createdAt: string;
}
/**
 * ADR-0190 I8: the execution facts of a v2 Decision BOM, read from the signed body only (never from another
 * request). Null when the body is v1 or records no execution (the completeness row says why).
 */
export interface ExecutionView {
  workloadKind: string;
  placement: string;
  placementId: string | null;
  requiredClass: string | null;
  requiredBy: string | null;
  appliedClass: string | null;
  refusalCode: string | null;
  profile: { id: string; name: string; version: number; digest: string } | null;
  executor: { id: string; backend: string; runtimeVersion: string; identityId: string; identity: string | null } | null;
  attestation: { placementReportSha256: string | null; executorAttestationId: string | null; executorReportSha256: string | null } | null;
  /** ADR-0190 I4: the offer of an `offered` placement, the closure image and the runtime flags hash (null when absent) */
  offerId: string | null;
  imageDigest: string | null;
  runtimeFlagsSha256: string | null;
  /** ADR-0190 owner decision C: the person's own stdio relaxation the requirement relied on (null when none) */
  relaxation: { relaxationId: string; scopeKind: "mcp_server" | "project"; scopeId: string } | null;
}
/** ADR-0190 I4: one linked report of an offered placement (live, unsigned: shown beside the signed body) */
export interface PlacementReportView {
  id: string;
  outcome: string;
  appliedClass: string | null;
  reportSha256: string | null;
  refusalCode: string | null;
  endCode: string | null;
  createdAt: string;
}
const ID_TEXT = /^[A-Za-z0-9._:/@+#=-]{1,256}$/;
const nullOr = <T>(v: unknown, ok: (x: unknown) => x is T): v is T | null => v === null || ok(v);
const isSha = (x: unknown): x is string => typeof x === "string" && SHA256_HEX.test(x);
const isUuid = (x: unknown): x is string => typeof x === "string" && UUID.test(x);
const isIdText = (x: unknown): x is string => typeof x === "string" && ID_TEXT.test(x);
const isSpiffe = (x: unknown): x is string => typeof x === "string" && x.length <= 2048 && /^spiffe:\/\/[a-z0-9._-]+\/[A-Za-z0-9._/-]+$/.test(x);
/** the `execution` section of a v2 body: exactly the contract's fields and vocabularies, or the whole BOM is unreadable */
export function readExecution(value: unknown): ExecutionView | null {
  if (value === null) return null;
  const e = obj(value);
  const bad = (): never => unreadable("The Decision BOM");
  const base = ["workloadKind", "placement", "placementId", "requiredClass", "requiredBy", "appliedClass", "refusalCode", "profile", "executor", "attestation"];
  // ADR-0190 I4: three keys a capture from I4 on writes (absent from earlier v2 facts): never any other key
  const i4 = ["offerId", "imageDigest", "runtimeFlagsSha256"];
  // ADR-0190 owner decision C: written only when a relaxation was used
  const optional = [...i4, "relaxation"];
  if (!e || !base.every((k) => k in e) || !Object.keys(e).every((k) => base.includes(k) || optional.includes(k))) return bad();
  let relaxation: ExecutionView["relaxation"] = null;
  if (e.relaxation !== undefined && e.relaxation !== null) {
    const r = obj(e.relaxation);
    if (
      !r ||
      !exactKeys(r, ["kind", "subjectKind", "relaxationId", "scopeKind", "scopeId"]) ||
      r.kind !== "person_stdio_l2" ||
      r.subjectKind !== "interactive_person" ||
      !isUuid(r.relaxationId) ||
      (r.scopeKind !== "mcp_server" && r.scopeKind !== "project") ||
      !isUuid(r.scopeId) ||
      e.workloadKind !== "mcp_stdio" ||
      e.requiredClass === null
    ) {
      return bad();
    }
    relaxation = { relaxationId: r.relaxationId, scopeKind: r.scopeKind, scopeId: r.scopeId };
  }
  const offerId = e.offerId ?? null;
  const imageDigest = e.imageDigest ?? null;
  const runtimeFlagsSha256 = e.runtimeFlagsSha256 ?? null;
  if (!nullOr(offerId, isUuid) || !(imageDigest === null || (typeof imageDigest === "string" && /^sha256:[0-9a-f]{64}$/.test(imageDigest))) || !nullOr(runtimeFlagsSha256, isSha)) return bad();
  if (!oneOf(WORKLOAD_KINDS, e.workloadKind) || !oneOf(DECISION_EXECUTION_PLACEMENTS, e.placement) || !nullOr(e.placementId, isUuid)) return bad();
  if (!(e.requiredClass === null || oneOf(REQUIRABLE_ISOLATION_CLASSES, e.requiredClass)) || !(e.requiredBy === null || oneOf(REQUIRED_CLASS_SOURCES, e.requiredBy))) return bad();
  if (!(e.appliedClass === null || oneOf(DECISION_EXECUTION_APPLIED, e.appliedClass)) || !(e.refusalCode === null || oneOf(DECISION_EXECUTION_REFUSAL_CODES, e.refusalCode))) return bad();
  let profile: ExecutionView["profile"] = null;
  if (e.profile !== null) {
    const p = obj(e.profile);
    if (!p || !exactKeys(p, ["id", "name", "version", "digest"]) || !isUuid(p.id) || !isIdText(p.name) || !posInt(p.version) || !isSha(p.digest)) return bad();
    profile = { id: p.id, name: p.name, version: p.version, digest: p.digest };
  }
  let executor: ExecutionView["executor"] = null;
  if (e.executor !== null) {
    const x = obj(e.executor);
    if (!x || !exactKeys(x, ["id", "backend", "runtimeVersion", "identityId", "identity"]) || !isUuid(x.id) || !oneOf(EXECUTOR_BACKENDS, x.backend) || !isIdText(x.runtimeVersion) || !isUuid(x.identityId) || !nullOr(x.identity, isSpiffe)) return bad();
    executor = { id: x.id, backend: x.backend, runtimeVersion: x.runtimeVersion, identityId: x.identityId, identity: x.identity };
  }
  let attestation: ExecutionView["attestation"] = null;
  if (e.attestation !== null) {
    const a = obj(e.attestation);
    if (!a || !exactKeys(a, ["placementReportSha256", "executorAttestationId", "executorReportSha256"]) || !nullOr(a.placementReportSha256, isSha) || !nullOr(a.executorAttestationId, isUuid) || !nullOr(a.executorReportSha256, isSha)) return bad();
    attestation = { placementReportSha256: a.placementReportSha256, executorAttestationId: a.executorAttestationId, executorReportSha256: a.executorReportSha256 };
  }
  // what ran where: a call no executor places has no placement facts; a placement names its profile (decision 9)
  const local = e.placement === "in_gateway" || e.placement === "external";
  // ADR-0190 I4 review M2: an unresolved policy fact names no requirement and no profile (nothing resolved)
  const unresolved = e.placement === "refused" && e.refusalCode === "policy_unresolved";
  // recheck N5: a `profile_retired` refusal for a digest that names no profile records no profile
  const noProfile = e.placement === "refused" && e.refusalCode === "profile_retired";
  if (local ? e.appliedClass !== e.placement || profile !== null || executor !== null || attestation !== null : !unresolved && ((profile === null && !noProfile) || e.requiredClass === null)) return bad();
  // ADR-0190 I4: only an offered placement names its offer, and it has no report yet
  if ((e.placement === "offered") !== (offerId !== null) || (e.placement === "offered" && (executor === null || attestation === null || attestation.placementReportSha256 !== null))) return bad();
  return {
    workloadKind: e.workloadKind,
    placement: e.placement,
    placementId: e.placementId,
    requiredClass: e.requiredClass,
    requiredBy: e.requiredBy,
    appliedClass: e.appliedClass,
    refusalCode: e.refusalCode,
    profile,
    executor,
    attestation,
    offerId,
    imageDigest: imageDigest as string | null,
    runtimeFlagsSha256,
    relaxation,
  };
}

/** ADR-0190 I4: the read response's linked reports of an offered placement (absent before I4 = none) */
export function readPlacementReports(value: unknown): PlacementReportView[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) return unreadable("The Decision BOM");
  return value.map((item): PlacementReportView => {
    const r = obj(item);
    if (
      !r || !isUuid(r.id) || !oneOf(PLACEMENT_REPORT_OUTCOMES, r.outcome) || !(r.appliedClass === null || oneOf(DECISION_EXECUTION_APPLIED, r.appliedClass)) ||
      !nullOr(r.reportSha256, isSha) || !(r.refusalCode === null || oneOf(DECISION_EXECUTION_REFUSAL_CODES, r.refusalCode)) ||
      !(r.endCode === null || oneOf(PLACEMENT_END_CODES, r.endCode)) || typeof r.createdAt !== "string"
    ) {
      return unreadable("The Decision BOM");
    }
    return { id: r.id, outcome: r.outcome, appliedClass: r.appliedClass, reportSha256: r.reportSha256, refusalCode: r.refusalCode, endCode: r.endCode, createdAt: r.createdAt };
  });
}

/**
 * ADR-0190 owner decision C (A1): the relaxation row the signed facts name, from the read response (live, unsigned;
 * `decisionExecutionRelaxationRecordSchema`, packages/shared/src/bom/contract-b4.ts, mirrored). Who set it, when, the
 * audit row that set it, and whether it was cleared since.
 */
export interface RelaxationRecordView {
  id: string;
  scopeKind: "mcp_server" | "project";
  scopeId: string;
  setBy: string;
  setAt: string;
  clearedBy: string | null;
  clearedAt: string | null;
  /** the `execution-person-stdio-relaxed` audit row; null when it is no longer found (audit retention) */
  setAuditId: string | null;
  /** ADR-0197 Q3: when it stops applying (undefined = a gateway before Q3 did not report it) */
  expiresAt?: string;
  /** the latest renewal, or null when it was never renewed (undefined = not reported) */
  renewedBy?: string | null;
  renewedAt?: string | null;
}
const RELAXATION_RECORD_KEYS = ["id", "scopeKind", "scopeId", "setBy", "setAt", "clearedBy", "clearedAt", "setAuditId"] as const;
/** reported by a gateway with ADR-0197 Q3 (all three together) */
const RELAXATION_EXPIRY_KEYS = ["expiresAt", "renewedBy", "renewedAt"] as const;

/**
 * The read response's relaxation record, bound to the signed facts: it must be exactly the row they name (id and
 * scope) and present exactly when they name one. `undefined` = a gateway before A1 did not report it.
 */
export function readRelaxationRecord(value: unknown, signed: ExecutionView["relaxation"]): RelaxationRecordView | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return signed === null ? null : unreadable("The Decision BOM");
  const r = obj(value);
  if (
    !r || !signed || !(exactKeys(r, RELAXATION_RECORD_KEYS) || exactKeys(r, [...RELAXATION_RECORD_KEYS, ...RELAXATION_EXPIRY_KEYS])) || !uuid(r.id) || !uuid(r.scopeId) || !uuid(r.setBy) || !time(r.setAt) ||
    !nullOr(r.clearedBy, uuid) || !(r.clearedAt === null || time(r.clearedAt)) || (r.clearedBy === null) !== (r.clearedAt === null) || !nullOr(r.setAuditId, uuid) ||
    // cleared after it was set, as the shared contract requires
    (r.clearedAt !== null && Date.parse(r.clearedAt as string) < Date.parse(r.setAt as string)) ||
    // ADR-0197 Q3, as the shared contract requires: it expires after it was set; renewed by someone at a time, after the set
    ("expiresAt" in r &&
      (!time(r.expiresAt) || Date.parse(r.expiresAt as string) <= Date.parse(r.setAt as string) || !nullOr(r.renewedBy, uuid) ||
        !(r.renewedAt === null || time(r.renewedAt)) || (r.renewedBy === null) !== (r.renewedAt === null) ||
        (r.renewedAt !== null && Date.parse(r.renewedAt as string) < Date.parse(r.setAt as string)))) ||
    r.id !== signed.relaxationId || r.scopeKind !== signed.scopeKind || r.scopeId !== signed.scopeId
  ) {
    return unreadable("The Decision BOM");
  }
  const base: RelaxationRecordView = { id: r.id, scopeKind: signed.scopeKind, scopeId: r.scopeId, setBy: r.setBy, setAt: r.setAt, clearedBy: r.clearedBy as string | null, clearedAt: r.clearedAt as string | null, setAuditId: r.setAuditId };
  if (!("expiresAt" in r)) return base;
  return { ...base, expiresAt: r.expiresAt as string, renewedBy: r.renewedBy as string | null, renewedAt: r.renewedAt as string | null };
}

/** the audit log filtered to one row: the target of an evidence link (`GET /v1/audit?id=`) */
export const auditRowHref = (auditId: string) => `/admin/audit?id=${encodeURIComponent(auditId)}`;

export interface DecisionBomView {
  auditId: string;
  /** the signed body's own version (v1 bodies frozen before ADR-0190 I8 have no execution section) */
  bodyVersion: string;
  /** ADR-0190 I8: the execution facts, from the signed body (null for v1, or when none were recorded) */
  execution: ExecutionView | null;
  /** ADR-0190 I4: what happened to an offered placement afterwards (live, unsigned, from the read response) */
  placementReports: PlacementReportView[];
  /** ADR-0190 owner decision C (A1): the relaxation row the signed facts name (live, unsigned); undefined = not reported */
  relaxationRecord: RelaxationRecordView | null | undefined;
  bom: DecisionBomVersion & { reportedFinality: string; aiBomSnapshotId: string | null };
  versions: DecisionBomVersion[];
  renderings: string[];
  completeness: SectionCompleteness[];
  bundleHref: string;
  capabilities: BomCapabilities;
}

function readVersionSummary(value: unknown): DecisionBomVersion {
  const r = obj(value);
  if (!r || !uuid(r.id) || !posInt(r.version) || !oneOf(DECISION_BOM_FINALITY_STATES, r.finality) || !sha(r.bodySha256) || !str(r.keyId) || !KEY_ID.test(r.keyId) || !time(r.createdAt)) {
    return unreadable("The Decision BOM");
  }
  return { id: r.id, version: r.version, finality: r.finality, bodySha256: r.bodySha256, keyId: r.keyId, createdAt: r.createdAt };
}

/**
 * Two parsed JSON values compared structurally: object keys sorted, so key
 * order never matters. Both sides come from `JSON.parse`, so this is a value
 * comparison, not a byte format (the signed bytes are `bom.body`, checked by digest).
 */
export function sameJson(a: unknown, b: unknown): boolean {
  const norm = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(norm) : x !== null && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, norm((x as Obj)[k])])) : x;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/**
 * The read response. EVERYTHING shown comes from `bom.body`, the exact signed
 * bytes whose digest `bomB4Api.decision` checks first; `document` is only
 * accepted when it is the same value as the parsed body. The body's id,
 * audit id, version, supersedes, finality and AI BOM link must match the
 * summary; the bundle link must download exactly this version; the reported
 * finality is the frozen one, or `anchored_lapsed` for an anchored one (R44).
 */
export function readDecisionBom(value: unknown, auditId: string): DecisionBomView & { body: string } {
  const v = obj(value);
  const b = obj(v?.bom);
  const bundle = obj(v?.bundle);
  if (!v || !b || !bundle || v.auditId !== auditId || typeof b.body !== "string" || !Array.isArray(v.versions) || !Array.isArray(v.renderings)) {
    return unreadable("The Decision BOM");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(b.body);
  } catch {
    return unreadable("The Decision BOM");
  }
  const d = obj(parsed);
  const basis = obj(d?.basis);
  if (!d || !basis || !sameJson(v.document, parsed)) return unreadable("The Decision BOM");
  const bom = readVersionSummary({ id: b.id, version: b.version, finality: b.finality, bodySha256: b.bodySha256, keyId: b.keyId, createdAt: b.createdAt });
  const lapsedOk = b.reportedFinality === bom.finality || (b.reportedFinality === "anchored_lapsed" && (bom.finality === "anchored" || bom.finality === "anchored_finite_lock"));
  if (!oneOf(BOM_REPORTED_FINALITY_STATES, b.reportedFinality) || !lapsedOk || !(b.aiBomSnapshotId === null || uuid(b.aiBomSnapshotId))) return unreadable("The Decision BOM");
  if (!(b.supersedes === null || uuid(b.supersedes)) || (bom.version === 1) !== (b.supersedes === null)) return unreadable("The Decision BOM");
  if (
    d.id !== bom.id || d.auditId !== auditId || d.version !== bom.version || d.finality !== bom.finality ||
    d.supersedes !== b.supersedes || basis.aiBomSnapshotId !== b.aiBomSnapshotId
  ) {
    return unreadable("The Decision BOM");
  }
  const versions = v.versions.map(readVersionSummary);
  if (!versions.some((x) => x.id === bom.id && x.version === bom.version && x.bodySha256 === bom.bodySha256) || versions.some((x, i) => i > 0 && x.version <= versions[i - 1]!.version)) {
    return unreadable("The Decision BOM");
  }
  if (bundle.subject !== "decision-bom" || bundle.href !== `/v1/decisions/${auditId}/bom/bundle?version=${bom.version}`) return unreadable("The Decision BOM");
  if (!v.renderings.every((f) => oneOf(BOM_RENDERING_FORMATS, f))) return unreadable("The Decision BOM");
  const c = obj(d.completeness);
  if (!c || !oneOf(DECISION_BOM_VERSIONS, d.v)) return unreadable("The Decision BOM");
  const sections = decisionBomSectionsFor(d.v);
  if (Object.keys(c).length !== sections.length) return unreadable("The Decision BOM");
  // a v1 body has no execution key at all; a v2 body always has one, recorded exactly when present
  if ((d.v === DECISION_BOM_VERSION) === ("execution" in d)) return unreadable("The Decision BOM");
  const execution = d.v === DECISION_BOM_VERSION ? null : readExecution(d.execution);
  const completeness = sections.map((section): SectionCompleteness => {
    const e = obj(c[section]);
    if (!e || !oneOf(BOM_SECTION_STATUSES, e.status) || (e.status === "not_recorded") !== oneOf(BOM_NOT_RECORDED_REASONS, e.reason)) return unreadable("The Decision BOM");
    return { section, status: e.status, reason: (e.reason as string | undefined) ?? null };
  });
  if (d.v !== DECISION_BOM_VERSION && (completeness.find((x) => x.section === "execution")!.status === "recorded") !== (execution !== null)) return unreadable("The Decision BOM");
  return {
    auditId,
    bodyVersion: d.v,
    execution,
    placementReports: readPlacementReports(v.placementReports),
    relaxationRecord: readRelaxationRecord(v.executionRelaxation, execution?.relaxation ?? null),
    body: b.body,
    bom: { ...bom, reportedFinality: b.reportedFinality, aiBomSnapshotId: b.aiBomSnapshotId as string | null },
    versions,
    renderings: v.renderings as string[],
    completeness,
    bundleHref: bundle.href,
    capabilities: readCapabilities(v.capabilities),
  };
}

// ---------------------------------------------------------------------------
// POST /v1/boms/verify
// ---------------------------------------------------------------------------

export interface VerifyCheckRow {
  check: string;
  status: "valid" | "invalid" | "unverifiable";
  reason: string | null;
  ref: string | null;
  /** an `unverifiable` result every correct BOM gives (B4.8): reported, listed in cannotProve, not lowering the outcome */
  byDesign: boolean;
}
export type VerifyIdentity =
  | { subject: "decision-bom"; auditId: string; bomId: string; version: number; recordedFinality: string; reportedFinality: string; receiptPayloadVersion: "v1" | "v2" }
  | { subject: "ai-bom"; snapshotId: string; subjectKind: string; subjectId: string; version: number; serialNumber: string };
export interface VerifyView {
  source: BomVerifySource;
  outcome: BomVerifyOutcome;
  identity: VerifyIdentity | null;
  checks: VerifyCheckRow[];
  sections: Array<{ section: string; status: "valid" | "invalid"; completeness: string; notRecordedReason: string | null }>;
  cannotProve: string[];
  verifiedAt: string;
  capabilities: BomCapabilities;
}
export type VerifyExpectation =
  | { source: "bundle" }
  | { source: "decision_bom"; auditId: string; version?: number }
  | { source: "ai_bom_snapshot"; snapshotId: string };

/** contract-b4 `isUnverifiableByDesign`, mirrored */
function byDesign(check: string, reason: string | null, id: VerifyIdentity, source: BomVerifySource): boolean {
  if ((BOM_BUNDLE_REQUIRED_CHECKS as readonly string[]).includes(check)) return reason === "not_a_bundle" && source !== "bundle";
  if (id.subject === "decision-bom") {
    if (check === "decision_content_binding") return reason === "preimage_not_exported";
    if (check === "receipt_facts_binding") return reason === "receipt_v1_no_factsHash" && id.receiptPayloadVersion === "v1";
    if ((BOM_ANCHOR_CHECKS as readonly string[]).includes(check)) return reason === "anchor_absent" && id.recordedFinality === "chain_signed";
    return false;
  }
  return check === "supersedes" && reason === "earlier_snapshot_not_in_bundle" && source === "bundle" && id.version > 1;
}

/** contract-b4 `bomCannotProveFor`, mirrored: the exact limits of a verified subject, in BOM_CANNOT_PROVE order */
export function cannotProveFor(id: VerifyIdentity | null, source: BomVerifySource): string[] {
  if (id === null) return [];
  const want = new Set<string>(id.subject === "decision-bom" ? DECISION_BOM_CANNOT_PROVE_FIXED : AI_BOM_CANNOT_PROVE_FIXED);
  if (id.subject === "decision-bom") {
    if (id.receiptPayloadVersion === "v1") want.add("facts_recorded_at_decision_time");
    if (id.reportedFinality === "anchored_lapsed") want.add("commitment_after_retain_until");
    if (id.recordedFinality === "anchored_finite_lock") want.add("finite_lock_under_unbounded_retention");
    if (id.recordedFinality === "chain_signed") want.add("external_commitment");
  } else if (source === "bundle" && id.version > 1) want.add("superseded_snapshot");
  return BOM_CANNOT_PROVE.filter((c) => want.has(c));
}

/** the checks a readable, non-invalid report must carry (B4C-01); an inapplicable conditional check is left out */
export function requiredChecksFor(id: VerifyIdentity, source: BomVerifySource): string[] {
  return [
    ...(id.subject === "decision-bom" ? DECISION_BOM_REQUIRED_CHECKS : AI_BOM_REQUIRED_CHECKS),
    ...(source === "bundle" ? BOM_BUNDLE_REQUIRED_CHECKS : []),
    ...(id.subject === "ai-bom" && id.version > 1 ? ["supersedes"] : []),
  ];
}

/** what the report says about itself beyond its checks, sections and limits */
interface VerifyEnvelope {
  source: BomVerifySource;
  outcome: string;
  bodyVersion: string | null;
  hasManifest: boolean;
}

/**
 * The contract's structural rules on a report (contract-b4 `bomVerifyResponseSchema`), as one sentence each.
 * Null means none is broken. A report that breaks one is never displayed: it could claim more than it checked.
 * Every rule of the shared refinement is mirrored here, and `readVerifyReport` mirrors the shapes it relies on
 * (exact keys on the report, its checks, sections and identity; the manifest to the depth `manifestOk` names).
 * bomVerifyDrift.test.ts runs both over a fixture matrix and fails when they disagree on accept or refuse.
 */
function brokenRule(checks: VerifyCheckRow[], sections: VerifyView["sections"], id: VerifyIdentity | null, env: VerifyEnvelope, cannotProve: string[]): string | null {
  const { source, outcome } = env;
  if (checks.length === 0) return "it reports no checks";
  if (cannotProve.join() !== cannotProveFor(id, source).join()) return "its list of what cannot be proved is not the one for this BOM";
  const refs = new Map<string, Array<string | null>>();
  for (const c of checks) refs.set(c.check, [...(refs.get(c.check) ?? []), c.ref]);
  for (const r of refs.values()) if (r.length > 1 && (r.includes(null) || new Set(r).size !== r.length)) return "it repeats a check without telling the results apart";
  if ((source === "bundle") !== env.hasManifest && outcome !== "invalid") return source === "bundle" ? "it reports a readable bundle without its manifest" : "it reports a bundle manifest for a stored BOM";
  if (id === null || env.bodyVersion === null) {
    const what = source === "bundle" ? "an unreadable bundle" : "an unreadable stored BOM";
    return outcome === "invalid" && checks.some((c) => c.status === "invalid") ? null : `${what} is reported as more than invalid, or without the check that failed`;
  }
  const of = (check: string) => checks.filter((c) => c.check === check);
  const all = (check: string, status: string, reason: string) => of(check).every((c) => c.status === status && c.reason === reason);
  const decision = id.subject === "decision-bom";
  if (decision ? !oneOf(DECISION_BOM_VERSIONS, env.bodyVersion) : env.bodyVersion !== AI_BOM_VERSION) return "its body version is not the one for this kind of BOM";
  if ((source === "decision_bom" && !decision) || (source === "ai_bom_snapshot" && decision)) return "it verified a different kind of BOM than the stored one asked for";
  const foreign: readonly string[] = decision ? AI_BOM_ONLY_CHECKS : DECISION_BOM_ONLY_CHECKS;
  if (checks.some((c) => foreign.includes(c.check))) return "it reports checks that belong to the other kind of BOM";
  if (decision ? sections.map((s) => s.section).join() !== decisionBomSectionsFor(env.bodyVersion).join() : sections.length !== 0) return "its sections are not this BOM's sections";
  const missing = requiredChecksFor(id, source).filter((c) => of(c).length === 0);
  if (missing.length && outcome !== "invalid") return `it leaves out required checks (${missing.join(", ")})`;
  for (const c of BOM_BUNDLE_REQUIRED_CHECKS) {
    if (source !== "bundle" && !all(c, "unverifiable", "not_a_bundle")) return "it claims bundle checks for a stored BOM";
  }
  if (source === "bundle" && checks.some((c) => c.reason === "not_a_bundle")) return "it calls a bundle not a bundle";
  if (checks.some((c) => c.reason === "not_a_bundle" && !(BOM_BUNDLE_REQUIRED_CHECKS as readonly string[]).includes(c.check))) return "it reports \"not a bundle\" on a check that is not about the bundle";
  if (id.subject === "ai-bom") {
    if (id.version === 1 && of("supersedes").length) return "it checks an earlier snapshot for version 1";
    if (id.version > 1 && source === "bundle" && !all("supersedes", "unverifiable", "earlier_snapshot_not_in_bundle")) return "it claims to have checked the superseded snapshot, which a bundle never carries";
    return null;
  }
  if (!all("decision_content_binding", "unverifiable", "preimage_not_exported")) return "it claims the decision row's content, which is never exported";
  if (id.receiptPayloadVersion === "v1") {
    const v1Binding = of("receipt_facts_binding").every((c) => (c.status === "unverifiable" && c.reason === "receipt_v1_no_factsHash") || (c.status === "invalid" && c.reason === "v1_receipt_after_boundary"));
    if (!v1Binding) return "it claims a facts binding for a version 1 receipt, which does not commit to the facts";
  } else if (checks.some((c) => c.reason === "receipt_v1_no_factsHash" || c.reason === "v1_receipt_after_boundary")) return "it gives a version 2 receipt a version 1 result";
  if (checks.some((c) => c.reason === "v2_receipt_before_boundary" && (id.receiptPayloadVersion !== "v2" || c.check !== "receipt_facts_binding"))) {
    return "it reports a version 2 boundary result where it does not apply";
  }
  if (id.recordedFinality === "chain_signed") {
    if (BOM_ANCHOR_CHECKS.some((c) => !all(c, "unverifiable", "anchor_absent"))) return "it claims anchor checks for a BOM with no anchor";
  } else if (checks.some((c) => c.reason === "anchor_absent")) return "it says the anchor is absent for a BOM that has one";
  const projection = of("sections_projection");
  if (sections.some((s) => s.status === "invalid") !== projection.some((c) => c.status === "invalid")) return "its sections disagree with the section check";
  if (projection.some((c) => c.status === "unverifiable")) return "it calls the section check unverifiable, though it is a pure recomputation";
  const lapsed = id.reportedFinality === "anchored_lapsed" && (id.recordedFinality === "anchored" || id.recordedFinality === "anchored_finite_lock");
  if (id.reportedFinality !== id.recordedFinality && !lapsed) return "its reported finality is neither the recorded one nor a lapse of it";
  return null;
}

const DECISION_IDENTITY_KEYS = ["subject", "auditId", "bomId", "version", "recordedFinality", "reportedFinality", "receiptPayloadVersion"] as const;
const AI_IDENTITY_KEYS = ["subject", "snapshotId", "subjectKind", "subjectId", "version", "serialNumber"] as const;

function readIdentity(value: unknown): VerifyIdentity | null {
  if (value === null) return null;
  const v = obj(value);
  if (v?.subject === "decision-bom") {
    if (
      !exactKeys(v, DECISION_IDENTITY_KEYS) || !uuid(v.auditId) || !uuid(v.bomId) || !posInt(v.version) || !oneOf(DECISION_BOM_FINALITY_STATES, v.recordedFinality) ||
      !oneOf(BOM_REPORTED_FINALITY_STATES, v.reportedFinality) || !oneOf(["v1", "v2"] as const, v.receiptPayloadVersion)
    ) {
      return unreadable("The verification result");
    }
    return { subject: "decision-bom", auditId: v.auditId, bomId: v.bomId, version: v.version, recordedFinality: v.recordedFinality, reportedFinality: v.reportedFinality, receiptPayloadVersion: v.receiptPayloadVersion };
  }
  if (v?.subject === "ai-bom") {
    if (!exactKeys(v, AI_IDENTITY_KEYS) || !uuid(v.snapshotId) || !oneOf(AI_BOM_SUBJECT_KINDS, v.subjectKind) || !uuid(v.subjectId) || !posInt(v.version) || !str(v.serialNumber, 45) || !SERIAL.test(v.serialNumber)) {
      return unreadable("The verification result");
    }
    return { subject: "ai-bom", snapshotId: v.snapshotId, subjectKind: v.subjectKind, subjectId: v.subjectId, version: v.version, serialNumber: v.serialNumber };
  }
  return unreadable("The verification result");
}

const VERIFY_REPORT_KEYS = ["trust", "source", "bodyVersion", "identity", "outcome", "checks", "sections", "cannotProve", "manifest", "verifiedAt", "capabilities"] as const;
const VERIFY_CHECK_KEYS = ["check", "status", "reason", "ref"] as const;
const VERIFY_SECTION_KEYS = ["section", "status", "completeness", "notRecordedReason"] as const;
const MANIFEST_KEYS = [
  "schema", "product", "installId", "installIdSource", "exportedAt", "exportedAtSource", "exportedByUserId", "subject", "files", "audit", "signingKeyId", "signingKeyFingerprint",
] as const;
/** contract-b4 `EXPORT_BUNDLE_V3_SCHEMA`, mirrored */
export const EXPORT_BUNDLE_V3_SCHEMA = "regulait.export-bundle/3";

/**
 * The bundle manifest a verify report echoes (contract-b4 `exportBundleV3ManifestSchema`), to the depth this page
 * relies on: its envelope (exact keys, schema, product), its subject kind, its sorted file list, and a chain segment
 * exactly for a Decision BOM. The page never displays the manifest, so the subject descriptor's fields, the
 * install-id and email scans and the segment arithmetic are left to the gateway's own schema and are not mirrored.
 */
function manifestOk(value: unknown): boolean {
  const m = obj(value);
  if (!m || !exactKeys(m, MANIFEST_KEYS) || m.schema !== EXPORT_BUNDLE_V3_SCHEMA || m.product !== "regulait") return false;
  const subject = obj(m.subject);
  if (!subject || !oneOf(["decision-bom", "ai-bom"] as const, subject.kind) || !exactKeys(subject, ["kind", "id", "descriptor"]) || !uuid(subject.id) || !obj(subject.descriptor)) return false;
  if (!Array.isArray(m.files) || m.files.length < 1 || m.files.length > 64) return false;
  const paths: string[] = [];
  for (const raw of m.files) {
    const f = obj(raw);
    if (!f || !exactKeys(f, ["path", "sha256"]) || !str(f.path) || f.path.length === 0 || !sha(f.sha256)) return false;
    paths.push(f.path);
  }
  if (paths.some((p, i) => i > 0 && p <= paths[i - 1]!)) return false;
  const audit = obj(m.audit);
  if (m.audit !== null && audit === null) return false;
  return (subject.kind === "decision-bom") === (audit !== null);
}

/**
 * The verify report. Besides its shape, the browser re-derives the outcome
 * from the checks and sections (B4.8) and refuses a report whose outcome is
 * better than its own checks: a `valid` claim over an `invalid` check is never
 * displayed as valid. It also refuses a report that leaves out a required
 * check, carries the wrong `cannotProve` list, or breaks another structural
 * rule of the contract: an empty "valid" report is never shown as Valid.
 */
export function readVerifyReport(value: unknown, expected: VerifyExpectation): VerifyView {
  const v = obj(value);
  if (!v || !exactKeys(v, VERIFY_REPORT_KEYS) || v.trust !== "deployment_registry" || v.source !== expected.source || !oneOf(BOM_VERIFY_OUTCOMES, v.outcome) || !(v.bodyVersion === null || oneOf(BOM_BODY_VERSIONS, v.bodyVersion)) || !(v.manifest === null || manifestOk(v.manifest)) || !time(v.verifiedAt) || !Array.isArray(v.checks) || !Array.isArray(v.sections) || !Array.isArray(v.cannotProve)) {
    return unreadable("The verification result");
  }
  const identity = readIdentity(v.identity);
  // a report about a different subject than the one asked for is refused; a null identity (an unreadable body,
  // shown as invalid with its failing check, as the shared contract allows for every source) asks for nothing
  if (identity !== null && expected.source === "decision_bom" && (identity.subject !== "decision-bom" || identity.auditId !== expected.auditId || (expected.version !== undefined && identity.version !== expected.version))) {
    return unreadable("The verification result");
  }
  if (identity !== null && expected.source === "ai_bom_snapshot" && (identity.subject !== "ai-bom" || identity.snapshotId !== expected.snapshotId)) return unreadable("The verification result");
  const checks = v.checks.map((raw): VerifyCheckRow => {
    const c = obj(raw);
    const reasonOk =
      c?.status === "valid" ? c.reason === null : c?.status === "invalid" ? oneOf(BOM_VERIFY_INVALID_REASONS, c.reason) : c?.status === "unverifiable" ? oneOf(BOM_VERIFY_UNVERIFIABLE_REASONS, c.reason) : false;
    if (!c || !exactKeys(c, VERIFY_CHECK_KEYS) || !oneOf(BOM_VERIFY_CHECKS, c.check) || !reasonOk || !(c.ref === null || (str(c.ref) && /^[A-Za-z0-9._:/-]+$/.test(c.ref)))) return unreadable("The verification result");
    const reason = c.reason as string | null;
    return { check: c.check, status: c.status as VerifyCheckRow["status"], reason, ref: c.ref as string | null, byDesign: identity !== null && c.status === "unverifiable" && byDesign(c.check, reason, identity, expected.source) };
  });
  const sections = v.sections.map((raw) => {
    const s = obj(raw);
    if (!s || !exactKeys(s, VERIFY_SECTION_KEYS) || !oneOf(DECISION_BOM_SECTIONS_V2, s.section) || !oneOf(["valid", "invalid"] as const, s.status) || !oneOf(BOM_SECTION_STATUSES, s.completeness) || !(s.notRecordedReason === null || oneOf(BOM_NOT_RECORDED_REASONS, s.notRecordedReason)) || (s.completeness === "not_recorded") !== (s.notRecordedReason !== null)) {
      return unreadable("The verification result");
    }
    return { section: s.section, status: s.status, completeness: s.completeness, notRecordedReason: s.notRecordedReason as string | null };
  });
  if (!v.cannotProve.every((c) => oneOf(BOM_CANNOT_PROVE, c))) return unreadable("The verification result");
  const anyInvalid = checks.some((c) => c.status === "invalid") || sections.some((s) => s.status === "invalid");
  const lowering = checks.some((c) => c.status === "unverifiable" && !c.byDesign);
  const derived: BomVerifyOutcome = anyInvalid || identity === null ? "invalid" : lowering ? "unverifiable" : "valid";
  if (derived !== v.outcome) {
    throw new BomEvidenceError(`The verification result is inconsistent: it reports "${v.outcome}" but its own checks give "${derived}". It is not shown as a result.`);
  }
  const broken = brokenRule(checks, sections, identity, { source: expected.source, outcome: v.outcome, bodyVersion: v.bodyVersion as string | null, hasManifest: v.manifest !== null }, v.cannotProve as string[]);
  if (broken) throw new BomEvidenceError(`The verification result is inconsistent: ${broken}. It is not shown as a result.`);
  return {
    source: expected.source,
    outcome: v.outcome,
    identity,
    checks,
    sections,
    cannotProve: v.cannotProve as string[],
    verifiedAt: v.verifiedAt,
    capabilities: readCapabilities(v.capabilities),
  };
}

// ---------------------------------------------------------------------------
// refusals, in words
// ---------------------------------------------------------------------------

const PENDING_REASON_COPY: Record<string, string> = {
  anchor_not_flushed: "the audit anchor covering it has not been written yet",
  destination_not_tamper_resistant: "the anchor destination was not observed as tamper-resistant",
  timestamp_pending: "its trusted timestamp has not been granted yet",
  lock_not_recorded: "the anchor's lock was not recorded",
  lock_shorter_than_retention: "the anchor's lock ends before the audit retention does",
  lock_lapsed: "the anchor's lock has lapsed",
  retention_unbounded: "audit retention has no end, and a finite lock is not accepted as final",
  receipt_unsigned: "its decision receipt is not signed yet",
};

/**
 * A BOM refusal as a sentence that says what did not happen. Every code the
 * BOM routes answer is named; anything else falls back to the client's own
 * refusal text, which never claims success either.
 */
export function bomRefusalText(err: unknown): string {
  if (err instanceof BomEvidenceError) return err.message;
  if (!(err instanceof ApiError)) return err instanceof Error ? err.message : "The request failed. Nothing was changed.";
  const p = err.payload;
  const retry = typeof p.retryAfterSeconds === "number" ? ` Try again in about ${p.retryAfterSeconds} seconds.` : "";
  switch (p.error) {
    case "bom_signing_unavailable":
      return p.missingKey === "export"
        ? "No export signing key is configured, so no bundle was built and nothing was exported."
        : "No receipt signing key is configured, so nothing was signed or stored. Enforcement posture shows the key's state.";
    case "receipt_signing_key_invalid":
      return "The configured receipt signing key cannot be used, so nothing was signed or stored. Enforcement posture shows why.";
    case "bom_anchor_pending":
      return `This decision's BOM is not final yet: ${PENDING_REASON_COPY[String(p.reason)] ?? "its anchor is not final"}. Nothing was frozen.${retry}`;
    case "bom_export_forbidden":
      return "BOM evidence is limited to admins and, while bom_export_roles allows it, people with an explicit auditor grant.";
    case "admin_only":
      return "Only an administrator can do this.";
    case "bom_snapshot_busy":
      return "Another snapshot of this subject is being taken. Nothing new was stored; try again shortly.";
    case "ai_bom_build_refused":
      return `The snapshot was refused because a record failed a safety rule${p.detail ? ` (${p.detail})` : ""}. Nothing was stored.`;
    case "ai_bom_too_large":
      return "The subject has more records than an AI BOM may hold, so the snapshot was refused. Nothing was stored.";
    case "ai_bom_subject_not_found":
      return "This AI BOM subject no longer exists.";
    case "invalid_ai_bom_subject":
      return "This is not a valid AI BOM subject.";
    case "ai_bom_no_snapshot":
      return "This subject has no signed snapshot yet, so there is nothing to compare the live state with.";
    case "ai_bom_baseline_unreadable":
      return "The latest snapshot's stored rendering does not match its hash, so drift cannot be measured. Tell an administrator: this needs investigating.";
    case "ai_bom_snapshot_not_found":
      return "That snapshot no longer exists.";
    case "format_not_rendered_for_snapshot":
      return `That format was not rendered when this snapshot was taken, and is never produced afterwards. Available: ${Array.isArray(p.formats) ? p.formats.join(", ") : "native"}.`;
    case "bom_integrity_failure":
      return "The stored BOM failed its integrity re-check, so nothing was exported. Tell an administrator: this needs investigating.";
    case "bom_decision_not_found":
      return "No decision has that audit row ID.";
    case "bom_decision_not_eligible":
      return "That audit row is not a receipt-eligible decision, so it has no Decision BOM.";
    case "bom_version_not_found":
      return "That Decision BOM version does not exist.";
    case "bom_export_refused":
      return `The export was refused because ${String(p.file ?? "a file")} holds something shaped like an email address at ${String(p.path ?? "a field")}. Nothing was exported.`;
    case "bom_bundle_too_large":
      return "That file is larger than the 8 MiB a BOM bundle may be. Nothing was verified.";
    case "invalid_bom_verify_request":
      return "The verify request was refused as malformed. Nothing was verified.";
    case "invalid_audit_id":
      return "Enter the decision's audit row ID (a UUID).";
    case "invalid_bom_snapshot_id":
    case "invalid_bom_format":
    case "invalid_bom_version":
      return "The request was refused as malformed. Nothing was exported.";
    case "bom_snapshots_not_released":
      return "Signed AI BOM snapshots are not released on this gateway.";
    case "not_built":
      return "This BOM route is not built on this gateway.";
    case "rate_limited":
      return `Too many BOM requests in the last minute.${retry || " Wait a moment and try again."}`;
    default:
      return err.message;
  }
}

/** a 403 that will not change on retry: hide the controls rather than offer them again */
export function isBomForbidden(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403 && (err.payload.error === "bom_export_forbidden" || err.payload.error === "admin_only");
}

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

const own = (labels: Readonly<Record<string, string>>, key: string, fallback: string) => (Object.hasOwn(labels, key) ? labels[key]! : fallback);

export const TRIGGER_LABELS: Readonly<Record<string, string>> = {
  on_demand: "On demand",
  use_case_approval: "Use case approval",
  model_card_approval: "Model card approval",
  prompt_promotion: "Prompt promotion",
  evidence_attached: "Evidence attached",
  config_promotion: "Configuration promotion",
  server_admission: "MCP server admission",
  skill_admission: "Skill admission",
};
export const triggerLabel = (t: string | null) => (t === null ? "Not recorded" : own(TRIGGER_LABELS, t, t));

export const FORMAT_LABELS: Readonly<Record<string, string>> = {
  native: "Native signed body",
  "cyclonedx-1.7": "CycloneDX 1.7",
  "cyclonedx-1.6": "CycloneDX 1.6",
  "spdx-3.0.1": "SPDX 3.0.1",
  "in-toto": "in-toto",
};
export const formatLabel = (f: string) => own(FORMAT_LABELS, f, f);

export const FINALITY_LABELS: Readonly<Record<string, string>> = {
  anchored: "Anchored",
  anchored_finite_lock: "Anchored, time-limited lock",
  anchored_unverified_destination: "Anchored, destination not observed tamper-resistant",
  chain_signed: "Chain signed, no anchor",
  anchored_lapsed: "Anchored, lock has lapsed",
};
export const finalityLabel = (f: string) => own(FINALITY_LABELS, f, f);

export const SECTION_LABELS: Readonly<Record<string, string>> = {
  decision: "Decision",
  receipt: "Receipt",
  principal: "Human sponsor",
  actors: "Actor chain",
  action: "Action",
  policy: "Policy",
  model: "Model",
  approval: "Approval",
  outcome: "Outcome",
  cost: "Cost",
  trace: "Trace",
  proof: "Proof",
  execution: "Execution",
};
export const sectionLabel = (s: string) => own(SECTION_LABELS, s, s);

export const NOT_RECORDED_LABELS: Readonly<Record<string, string>> = {
  pre_identity: "Predates workload identity",
  pre_facts: "Predates fact capture",
  capture_off: "Fact capture was off",
  no_bound_row: "No bound record",
  unsigned_addendum: "Unsigned addendum",
  not_captured_by_path: "Not captured on this path",
  anchor_absent: "No anchor recorded",
  pre_isolation: "Predates execution facts",
  no_placement: "No placement recorded",
};

// ADR-0190 I8: execution facts in words. L0 and L1 are never called a sandbox (decision 11).
export const EXECUTION_PLACEMENT_LABELS: Readonly<Record<string, string>> = {
  in_gateway: "Ran in the gateway (L0, not isolated)",
  external: "Ran on the upstream's own host (external)",
  placed: "Placed on an executor",
  refused: "Refused before it ran",
  mismatch: "Refused: the placement report did not match the profile",
  offered: "Offered to an executor (nothing had run when this was decided)",
};
// ADR-0190 I4: the linked reports of an offered placement, in words
export const PLACEMENT_REPORT_LABELS: Readonly<Record<string, string>> = {
  placed: "Ran: the sandbox's report was accepted",
  mismatch: "Refused: the sandbox's report did not match the profile",
  refused: "Never ran: the offer expired, was declined or withdrawn",
  cancelled: "Cancelled by the gateway before the call used it",
  session_lost: "The gateway lost the session (its own refusal)",
};
export const PLACEMENT_END_LABELS: Readonly<Record<string, string>> = {
  later_gate: "a later check refused the call",
  placement_timeout: "the executor did not confirm the sandbox in time",
  session_abandoned: "nothing connected to the session",
  session_unknown: "the session reached a gateway that did not hold it",
};
export const placementReportLabel = (o: string) => own(PLACEMENT_REPORT_LABELS, o, o);
export const placementEndLabel = (c: string | null) => (c === null ? "" : own(PLACEMENT_END_LABELS, c, c));
export const ISOLATION_CLASS_LABELS: Readonly<Record<string, string>> = {
  in_gateway: "L0 in gateway",
  external: "External (the upstream's host)",
  hardened_container: "L1 hardened container",
  user_space_kernel: "L2 user-space kernel",
  microvm: "L3 microVM",
  customer_declared: "customer declared (not verified)",
};
export const REQUIRED_BY_LABELS: Readonly<Record<string, string>> = {
  workload_kind: "the workload kind",
  data_sensitivity: "the data sensitivity",
  compliance_tag: "a compliance tag",
  autonomy_class: "the agent's autonomy class",
  configured_profile: "the configured profile",
  unknown_agent: "an unknown agent",
  parent_grant: "the parent grant",
};
export const executionPlacementLabel = (p: string) => own(EXECUTION_PLACEMENT_LABELS, p, p);
export const isolationClassLabel = (c: string | null) => (c === null ? "none" : own(ISOLATION_CLASS_LABELS, c, c));
export const requiredByLabel = (r: string | null) => (r === null ? "" : own(REQUIRED_BY_LABELS, r, r));
export const notRecordedLabel = (r: string | null) => (r === null ? "" : own(NOT_RECORDED_LABELS, r, r));

export const CHECK_LABELS: Readonly<Record<string, string>> = {
  bundle_manifest_signature: "Bundle manifest signature",
  bundle_manifest_files: "Bundle file digests",
  bundle_subject: "Bundle subject",
  bundle_email_scan: "Bundle email scan",
  body_version: "Body version",
  body_schema: "Body schema",
  body_signature: "Body signature",
  receipt_signature: "Receipt signature",
  receipt_payload_hash: "Receipt payload digest",
  receipt_facts_binding: "Receipt binds the facts",
  facts_addenda_chain: "Fact addendum chain",
  facts_addenda_signatures: "Fact addendum signatures",
  sections_projection: "Sections recomputed",
  chain_links: "Audit chain links",
  decision_content_binding: "Decision content binding",
  anchor_record: "Anchor record",
  anchor_imprint: "Anchor imprint",
  tsa_token: "Timestamp token",
  finality: "Finality",
  ai_bom_link: "AI BOM link",
  rendering_hashes: "Rendering digests",
  serial_number: "Serial number",
  supersedes: "Earlier snapshot link",
};
export const checkLabel = (c: string) => own(CHECK_LABELS, c, c);
export const cannotProveText = (c: string) => own(BOM_CANNOT_PROVE_COPY, c, c);

export const OUTCOME_LABELS: Readonly<Record<BomVerifyOutcome, string>> = {
  valid: "Valid",
  unverifiable: "Not fully verifiable",
  invalid: "Invalid",
};

export const GAP_LABELS: Readonly<Record<BomGap["kind"], string>> = {
  skipped_no_key: "Skipped: no signing key",
  failed: "Snapshot failed",
};

/** a recorded time for display; the ISO value stays available as the title */
export function shownTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
}

/** save a verified download (a transient object URL; nothing is kept) */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** the filename from `content-disposition` (the contract's `regulait-….tar.gz`), or a fallback */
export function bundleFilename(disposition: string | null, fallback: string): string {
  const m = /^attachment; filename="(regulait-[A-Za-z0-9._-]+\.tar\.gz)"$/.exec(disposition ?? "");
  return m?.[1] ?? fallback;
}
