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
export const BOM_SECTION_STATUSES = ["recorded", "not_applicable", "not_recorded"] as const;
export const BOM_NOT_RECORDED_REASONS = ["pre_identity", "pre_facts", "capture_off", "no_bound_row", "unsigned_addendum", "not_captured_by_path", "anchor_absent"] as const;
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
export type BomVerifySource = (typeof BOM_VERIFY_SOURCES)[number];
const BOM_BUNDLE_REQUIRED_CHECKS = ["bundle_manifest_signature", "bundle_manifest_files", "bundle_subject", "bundle_email_scan"];
const BOM_ANCHOR_CHECKS = ["anchor_record", "anchor_imprint", "tsa_token"];

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
export function readCapabilities(value: unknown): BomCapabilities {
  const v = obj(value);
  if (
    !v || !oneOf(["admin", "auditor_grant"] as const, v.access) || !oneOf(["admins_only", "admins_and_auditors"] as const, v.exportRoles) ||
    typeof v.canExport !== "boolean" || typeof v.canVerify !== "boolean" || typeof v.canViewDrift !== "boolean" ||
    !(v.exportUnavailableReason === null || v.exportUnavailableReason === "export_signing_key_absent") ||
    v.canExport !== (v.exportUnavailableReason === null) || !posInt(v.rateLimitPerMinute)
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
export interface DecisionBomView {
  auditId: string;
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
 * The read response, checked for the bindings the contract states: the summary
 * matches the signed document, the bundle link downloads exactly this version,
 * and the reported finality is the frozen one (or `anchored_lapsed` for an
 * anchored one, R44). The body's hash is checked by `bomB4Api` (it needs
 * SubtleCrypto, which is async).
 */
export function readDecisionBom(value: unknown, auditId: string): DecisionBomView & { body: string } {
  const v = obj(value);
  const b = obj(v?.bom);
  const d = obj(v?.document);
  const bundle = obj(v?.bundle);
  if (!v || !b || !d || !bundle || v.auditId !== auditId || typeof b.body !== "string" || !Array.isArray(v.versions) || !Array.isArray(v.renderings)) {
    return unreadable("The Decision BOM");
  }
  const bom = readVersionSummary({ id: b.id, version: b.version, finality: b.finality, bodySha256: b.bodySha256, keyId: b.keyId, createdAt: b.createdAt });
  const lapsedOk = b.reportedFinality === bom.finality || (b.reportedFinality === "anchored_lapsed" && (bom.finality === "anchored" || bom.finality === "anchored_finite_lock"));
  if (!oneOf(BOM_REPORTED_FINALITY_STATES, b.reportedFinality) || !lapsedOk || !(b.aiBomSnapshotId === null || uuid(b.aiBomSnapshotId))) return unreadable("The Decision BOM");
  if (d.id !== bom.id || d.auditId !== auditId || d.version !== bom.version || d.finality !== bom.finality) return unreadable("The Decision BOM");
  const versions = v.versions.map(readVersionSummary);
  if (!versions.some((x) => x.id === bom.id && x.version === bom.version && x.bodySha256 === bom.bodySha256) || versions.some((x, i) => i > 0 && x.version <= versions[i - 1]!.version)) {
    return unreadable("The Decision BOM");
  }
  if (bundle.subject !== "decision-bom" || bundle.href !== `/v1/decisions/${auditId}/bom/bundle?version=${bom.version}`) return unreadable("The Decision BOM");
  if (!v.renderings.every((f) => oneOf(BOM_RENDERING_FORMATS, f))) return unreadable("The Decision BOM");
  const c = obj(d.completeness);
  if (!c) return unreadable("The Decision BOM");
  const completeness = DECISION_BOM_SECTIONS.map((section): SectionCompleteness => {
    const e = obj(c[section]);
    if (!e || !oneOf(BOM_SECTION_STATUSES, e.status) || (e.status === "not_recorded") !== oneOf(BOM_NOT_RECORDED_REASONS, e.reason)) return unreadable("The Decision BOM");
    return { section, status: e.status, reason: (e.reason as string | undefined) ?? null };
  });
  return {
    auditId,
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
  if (BOM_BUNDLE_REQUIRED_CHECKS.includes(check)) return reason === "not_a_bundle" && source !== "bundle";
  if (id.subject === "decision-bom") {
    if (check === "decision_content_binding") return reason === "preimage_not_exported";
    if (check === "receipt_facts_binding") return reason === "receipt_v1_no_factsHash" && id.receiptPayloadVersion === "v1";
    if (BOM_ANCHOR_CHECKS.includes(check)) return reason === "anchor_absent" && id.recordedFinality === "chain_signed";
    return false;
  }
  return check === "supersedes" && reason === "earlier_snapshot_not_in_bundle" && source === "bundle" && id.version > 1;
}

function readIdentity(value: unknown): VerifyIdentity | null {
  if (value === null) return null;
  const v = obj(value);
  if (v?.subject === "decision-bom") {
    if (
      !uuid(v.auditId) || !uuid(v.bomId) || !posInt(v.version) || !oneOf(DECISION_BOM_FINALITY_STATES, v.recordedFinality) ||
      !oneOf(BOM_REPORTED_FINALITY_STATES, v.reportedFinality) || !oneOf(["v1", "v2"] as const, v.receiptPayloadVersion)
    ) {
      return unreadable("The verification result");
    }
    return { subject: "decision-bom", auditId: v.auditId, bomId: v.bomId, version: v.version, recordedFinality: v.recordedFinality, reportedFinality: v.reportedFinality, receiptPayloadVersion: v.receiptPayloadVersion };
  }
  if (v?.subject === "ai-bom") {
    if (!uuid(v.snapshotId) || !oneOf(AI_BOM_SUBJECT_KINDS, v.subjectKind) || !uuid(v.subjectId) || !posInt(v.version) || !str(v.serialNumber, 45) || !SERIAL.test(v.serialNumber)) {
      return unreadable("The verification result");
    }
    return { subject: "ai-bom", snapshotId: v.snapshotId, subjectKind: v.subjectKind, subjectId: v.subjectId, version: v.version, serialNumber: v.serialNumber };
  }
  return unreadable("The verification result");
}

/**
 * The verify report. Besides its shape, the browser re-derives the outcome
 * from the checks and sections (B4.8) and refuses a report whose outcome is
 * better than its own checks: a `valid` claim over an `invalid` check is never
 * displayed as valid.
 */
export function readVerifyReport(value: unknown, expected: VerifyExpectation): VerifyView {
  const v = obj(value);
  if (!v || v.trust !== "deployment_registry" || v.source !== expected.source || !oneOf(BOM_VERIFY_OUTCOMES, v.outcome) || !time(v.verifiedAt) || !Array.isArray(v.checks) || !Array.isArray(v.sections) || !Array.isArray(v.cannotProve)) {
    return unreadable("The verification result");
  }
  const identity = readIdentity(v.identity);
  if (expected.source === "decision_bom" && (identity?.subject !== "decision-bom" || identity.auditId !== expected.auditId || (expected.version !== undefined && identity.version !== expected.version))) {
    return unreadable("The verification result");
  }
  if (expected.source === "ai_bom_snapshot" && (identity?.subject !== "ai-bom" || identity.snapshotId !== expected.snapshotId)) return unreadable("The verification result");
  const checks = v.checks.map((raw): VerifyCheckRow => {
    const c = obj(raw);
    const reasonOk =
      c?.status === "valid" ? c.reason === null : c?.status === "invalid" ? oneOf(BOM_VERIFY_INVALID_REASONS, c.reason) : c?.status === "unverifiable" ? oneOf(BOM_VERIFY_UNVERIFIABLE_REASONS, c.reason) : false;
    if (!c || !oneOf(BOM_VERIFY_CHECKS, c.check) || !reasonOk || !(c.ref === null || (str(c.ref) && /^[A-Za-z0-9._:/-]+$/.test(c.ref)))) return unreadable("The verification result");
    const reason = c.reason as string | null;
    return { check: c.check, status: c.status as VerifyCheckRow["status"], reason, ref: c.ref as string | null, byDesign: identity !== null && c.status === "unverifiable" && byDesign(c.check, reason, identity, expected.source) };
  });
  const sections = v.sections.map((raw) => {
    const s = obj(raw);
    if (!s || !oneOf(DECISION_BOM_SECTIONS, s.section) || !oneOf(["valid", "invalid"] as const, s.status) || !oneOf(BOM_SECTION_STATUSES, s.completeness) || !(s.notRecordedReason === null || oneOf(BOM_NOT_RECORDED_REASONS, s.notRecordedReason))) {
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
};
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
