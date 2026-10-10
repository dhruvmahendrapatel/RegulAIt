/** B3 metadata mirrors the published route bodies; B4 operations use a separate display port. */
export type BomSubjectKind = "use_case" | "agent" | "builder_agent" | "install";
export interface BomSubject { kind: BomSubjectKind; id: string }
export const BOM_FORMATS = ["native", "cyclonedx-1.7", "cyclonedx-1.6", "spdx-3.0.1"] as const;
export type BomFormat = typeof BOM_FORMATS[number];
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DIGEST = /^[0-9a-f]{64}$/;
export interface BomSnapshot { id: string; version: number; serialNumber: string; trigger: string; bodySha256: string; keyId: string; createdAt: string; formats: string[] }
export interface SnapshotList { subject: BomSubject; released: boolean; snapshots: BomSnapshot[] }
export interface BomDrift { evidence: false; subject: BomSubject; baseline: { snapshotId: string; version: number; createdAt: string; serialNumber: string }; changes: Array<{ reference: string; change: "added" | "removed" | "changed_hash" | "changed_version"; beforeHashes: string[]; afterHashes: string[] }> }
export interface BomInspection { digest: string | null; state: "ready" | "pending" | "not_recorded"; finality: string | null; completeness: Array<{ section: string; status: "recorded" | "not_recorded" | "not_applicable"; reason: string | null }>; cannotProve: string[] }
export interface BomVerification { trust: "deployment_keys" | "independently_pinned"; sections: Array<{ section: string; status: "valid" | "invalid" | "unverifiable" }>; cannotProve: string[] }
/** A display port, not an assumed B4 HTTP response envelope. */
export interface BomEvidencePort {
  /** Supplied by the trusted adapter; absent B4 contract means no export permission is inferred. */
  exportAllowed: boolean;
  inspectSnapshot(id: string): Promise<BomInspection>;
  exportSnapshot(id: string, format: BomFormat): Promise<Blob>;
  decision(auditId: string): Promise<BomInspection>;
  exportDecision(auditId: string): Promise<Blob>;
  verify(bundle: Blob): Promise<BomVerification>;
}
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
const time = (v: unknown) => typeof v === "string" && v.length <= 32 && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const kinds = ["use_case", "agent", "builder_agent", "install"];
export function subjectPath(subject: BomSubject): string {
  if (!kinds.includes(subject.kind) || !UUID.test(subject.id) || (subject.kind === "install") !== (subject.id === "00000000-0000-0000-0000-000000000000")) throw new Error("Choose a valid BOM subject.");
  return "/v1/ai-bom/" + subject.kind + "/" + subject.id;
}
export function readSnapshotList(value: unknown, subject: BomSubject): SnapshotList {
  const v = object(value), s = object(v?.subject);
  if (!v || s?.kind !== subject.kind || s.id !== subject.id || typeof v.released !== "boolean" || !Array.isArray(v.snapshots) || v.snapshots.length > 10000) throw new Error("Snapshot metadata could not be read.");
  const snapshots = v.snapshots.map(value => {
    const row = object(value);
    if (!row || typeof row.id !== "string" || !UUID.test(row.id) || !integer(row.version) || typeof row.bodySha256 !== "string" || !DIGEST.test(row.bodySha256) || !time(row.createdAt) || typeof row.serialNumber !== "string" || !row.serialNumber.startsWith("urn:uuid:") || !UUID.test(row.serialNumber.slice(9)) || typeof row.trigger !== "string" || typeof row.keyId !== "string" || !Array.isArray(row.formats) || row.formats.length > 8 || row.formats.some(f => typeof f !== "string")) throw new Error("Snapshot metadata could not be read.");
    // Deliberately project metadata. No document, location, arbitrary extension or signing material reaches the view.
    return { id: row.id, version: row.version as number, bodySha256: row.bodySha256, createdAt: row.createdAt as string, serialNumber: row.serialNumber, trigger: row.trigger, keyId: row.keyId, formats: row.formats as string[] };
  });
  if (new Set(snapshots.map(s => s.id)).size !== snapshots.length || new Set(snapshots.map(s => s.version)).size !== snapshots.length) throw new Error("Snapshot metadata could not be read.");
  return { subject, released: v.released, snapshots };
}
export function readDrift(value: unknown, subject: BomSubject): BomDrift {
  const v = object(value), s = object(v?.subject), b = object(v?.baseline);
  if (!v || v.evidence !== false || s?.kind !== subject.kind || s.id !== subject.id || !b || typeof b.snapshotId !== "string" || !UUID.test(b.snapshotId) || !integer(b.version) || !time(b.createdAt) || typeof b.serialNumber !== "string" || !b.serialNumber.startsWith("urn:uuid:") || !UUID.test(b.serialNumber.slice(9)) || !Array.isArray(v.changes) || v.changes.length > 100000 || v.changes.some(c => !object(c))) throw new Error("Drift could not be measured.");
  const changes = v.changes.map(value => {
    const c = object(value), before = object(c?.before), after = object(c?.after);
    if (!c || typeof c.ref !== "string" || !(typeof c.change === "string" && ["added", "removed", "changed_hash", "changed_version"].includes(c.change)) || !(c.before === null || before) || !(c.after === null || after)) throw new Error("Drift could not be measured.");
    const hashes = (o: Record<string, unknown> | null) => o && Array.isArray(o.hashes) ? o.hashes.filter((h): h is string => typeof h === "string" && /^SHA-256:[0-9a-f]{64}$/.test(h)).map(h => h.slice(8)) : [];
    // Ref and version strings can contain arbitrary inventory metadata. The view displays fixed labels and digests only.
    return { reference: driftReference(c.ref), change: c.change as BomDrift["changes"][number]["change"], beforeHashes: hashes(before), afterHashes: hashes(after) };
  });
  return { evidence: false, subject, baseline: { snapshotId: b.snapshotId, version: b.version as number, createdAt: b.createdAt as string, serialNumber: b.serialNumber }, changes };
}
export const SECTION_LABELS: Record<string, string> = { decision: "Decision", receipt: "Receipt", principal: "Human sponsor", actors: "Actor chain", action: "Action", policy: "Policy", model: "Model", approval: "Approval", outcome: "Outcome", cost: "Cost", trace: "Trace", proof: "Proof", signature: "Signature", rendering: "Rendering", facts: "Captured facts", chain: "Audit chain", anchor: "Anchor" };
export const REASON_LABELS: Record<string, string> = { pre_identity: "Predates workload identity", pre_facts: "Predates fact capture", capture_off: "Fact capture was off", no_bound_row: "No bound record", unsigned_addendum: "Unsigned addendum", not_captured_by_path: "Not captured by this path", anchor_absent: "No anchor recorded", receipt_v1_no_factsHash: "The older receipt does not commit to these facts" };
export const LIMIT_LABELS: Record<string, string> = { model_truth: "That a model's declarations are true", omitted_prefix: "The omitted audit-chain prefix", external_commitment: "That the external commitment still exists", live_state: "The deployment's present state", receipt_binding: "That older receipts bind the captured facts" };
export function recordedTime(value: string): string { return time(value) ? new Date(value).toLocaleString() : "Unmeasured"; }
export function safeSection(value: string): string { return ownLabel(SECTION_LABELS, value, "Unrecognised section"); }
export function safeLimit(value: string): string { return ownLabel(LIMIT_LABELS, value, "Additional assurance is not established"); }
export function checkedAuditId(value: string): string { if (!UUID.test(value)) throw new Error("Choose a valid audit ID."); return value; }
export function downloadBom(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const ownLabel = (labels: Record<string, string>, value: string, fallback: string): string => Object.hasOwn(labels, value) ? labels[value]! : fallback;
export const safeReason = (value: string | null): string => value === null ? "No additional reason recorded" : ownLabel(REASON_LABELS, value, "Reason is not recognised by this interface");
export function driftReference(ref: string): string {
  const parts = ref.split(":"); const [kind, id] = parts;
  const names: Record<string, string> = { agent: "Agent", use_case: "Use case", model_card: "Model card", mcp_server: "MCP server", connector: "Connector", builder_agent: "Builder agent", engine: "Engine", config: "Configuration", prompt: "Prompt", artifact: "Artifact", dataset: "Dataset", skill: "Skill" };
  return parts.length === 2 && kind && Object.hasOwn(names, kind) && id && UUID.test(id) ? `${names[kind]} ${id}` : "Inventory component";
}
export function formatLabel(format: string): string { return ownLabel({ native: "Native signed body", "cyclonedx-1.7": "CycloneDX 1.7", "cyclonedx-1.6": "CycloneDX 1.6", "spdx-3.0.1": "SPDX 3.0.1" }, format, "Unrecognised format"); }
export function readInspection(value: unknown): BomInspection {
  const v = object(value);
  if (!v || !(typeof v.state === "string" && ["ready", "pending", "not_recorded"].includes(v.state)) || !(v.digest === null || typeof v.digest === "string" && DIGEST.test(v.digest)) || !(v.finality === null || typeof v.finality === "string") || !Array.isArray(v.completeness) || v.completeness.length > 64 || !Array.isArray(v.cannotProve) || v.cannotProve.length > 64) throw new Error("BOM assurance could not be read.");
  return { state: v.state as BomInspection["state"], digest: v.digest as string | null, finality: v.finality as string | null, completeness: v.completeness.map(value => { const r = object(value); if (!r || typeof r.section !== "string" || !(typeof r.status === "string" && ["recorded", "not_recorded", "not_applicable"].includes(r.status)) || !(r.reason === null || typeof r.reason === "string")) throw new Error("BOM assurance could not be read."); return {section:r.section,status:r.status as BomInspection["completeness"][number]["status"],reason:r.reason as string|null}; }), cannotProve: v.cannotProve.map(value=> {if(typeof value!=="string")throw new Error("BOM assurance could not be read.");return value;}) };
}
export function readVerification(value: unknown): BomVerification {
  const v=object(value); if(!v || !(typeof v.trust === "string" && ["deployment_keys","independently_pinned"].includes(v.trust)) || !Array.isArray(v.sections) || v.sections.length>64 || !Array.isArray(v.cannotProve) || v.cannotProve.length>64) throw new Error("BOM verification could not be read.");
  return {trust:v.trust as BomVerification["trust"],sections:v.sections.map(value=>{const r=object(value);if(!r || typeof r.section!=="string" || !(typeof r.status === "string" && ["valid","invalid","unverifiable"].includes(r.status)))throw new Error("BOM verification could not be read.");return {section:r.section,status:r.status as BomVerification["sections"][number]["status"]};}),cannotProve:v.cannotProve.map(value=>{if(typeof value!=="string")throw new Error("BOM verification could not be read.");return value;})};
}
export function finalityLabel(value: string | null): string { return value === null ? "Finality unmeasured" : ownLabel({ anchored:"Anchored", anchored_finite_lock:"Anchored with a time-limited lock", anchored_lapsed:"Anchor lock has lapsed", anchored_unverified_destination:"Destination assurance unverified", chain_signed:"Chain signed, no anchor assurance" }, value, "Finality unmeasured"); }

const portIds = new WeakMap<object, number>();
let nextPortId = 0;
export function bomPortKey(port: object | undefined): string { if (!port) return "unavailable"; let id = portIds.get(port); if (id === undefined) {id=++nextPortId;portIds.set(port,id);} return `port-${id}`; }

export function readCreatedSnapshot(value: unknown): Pick<BomSnapshot, "id" | "version" | "serialNumber" | "bodySha256"> {
  const v=object(value); if(!v || typeof v.id!=="string" || !UUID.test(v.id) || !integer(v.version) || typeof v.serialNumber!=="string" || !v.serialNumber.startsWith("urn:uuid:") || !UUID.test(v.serialNumber.slice(9)) || typeof v.bodySha256!=="string" || !DIGEST.test(v.bodySha256)) throw new Error("Signed snapshot metadata could not be read.");
  return {id:v.id,version:v.version as number,serialNumber:v.serialNumber,bodySha256:v.bodySha256};
}
