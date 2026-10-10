/**
 * ADR-0189 slice B3: the AI BOM RECORD SET, which is the loader contract between
 * the gateway (which reads rows in one REPEATABLE READ capture, R22/R50) and the
 * pure builder (`ai-bom-builder.ts`).
 *
 * Every record type has a fixed field ALLOWLIST, typed against the
 * `packages/db` columns it comes from (R32). `normaliseAiBomRecords` refuses
 * an unknown key rather than copying it, so a broad loader query (a system
 * prompt, a prompt template, a skill body, a training payload, a credential)
 * can never reach a signed body. It also normalises every list into a total
 * order, so row order and key order are never inputs (amendment 5). These
 * rules port spike B0 (`spikes/bom-b0/render.mjs` `normalise`, R12 sections
 * 10 to 14). Nothing here reads a clock, a database or the network.
 *
 * Content-safety rules applied here, once:
 *  - R47 and #280 (4237493036): an endpoint is exported as scheme://host[:port]
 *    ONLY. The query and fragment are always dropped, and so is the PATH,
 *    because a path can carry a credential (`/bot<TOKEN>/api`). Userinfo
 *    refuses the snapshot. Not relaxable.
 *  - Round 9 (4237344238): `model_cards.data_claims` is projected to allowlisted
 *    keys whose values are length-capped strings, safe integers or booleans.
 *    Anything else is refused.
 *  - #280 (4237488597): a free-form evidence reference (`external_ref`, a bias
 *    assessment's `resultRef`) is rendered as a sanitised URL origin, as an
 *    identifier, or otherwise as its SHA-256 only.
 *  - Free text that is allowed (names, intended use, limitations) is
 *    length-capped, and a value over the cap is refused, never truncated.
 *    Every string is email-scanned by the builder.
 */
import { createHash } from "node:crypto";
import { scrubAuditText } from "../audit-scrub.js";
import { aiDevStackToolSchema, bomSafeIssue, type AiDevStackTool } from "./ai-dev-stack.js";
import { RELEASE_SBOM_IDENTITY_BASES, RELEASE_SBOM_KINDS, releaseCommitSchema, releaseImageDigestSchema, releaseSbomSerialSchema, type ReleaseSbomRecord } from "./release-sbom-identity.js";
import { AI_BOM_SUBJECT_KINDS, bomCanonicalBytes, bomIdentifierSchema, isBomExportEndpoint, isBomSpiffeId, parseTrainingDatasetChecksum, type AiBomSubjectKind } from "./contract.js";

// ---------------------------------------------------------------------------
// persisted vocabularies (each mirrors a `packages/db` enum; any other value is refused)
// ---------------------------------------------------------------------------

/** `AI_USE_CASE_SENSITIVITIES` (packages/db schema.ts) */
export const AI_BOM_DATA_SENSITIVITIES = ["public", "internal", "confidential", "regulated"] as const;
/** R11: `TRAINING_SCAN_VERDICTS` */
export const AI_BOM_PII_VERDICTS = ["clean", "flagged", "blocked"] as const;
/** #280 round 12 (4237584874): `ARTIFACT_SCAN_VERDICTS` (packages/shared engines/contract.ts) */
export const AI_BOM_SCAN_VERDICTS = ["clean", "no_known_unsafe", "unsafe", "unknown", "not_run"] as const;
/** `MODEL_CARD_EVIDENCE_KINDS` */
export const AI_BOM_EVIDENCE_KINDS = ["eval_run", "external", "engine_scan"] as const;
/** `BUILDER_SKILL_ADMISSION_STATES` */
export const AI_BOM_SKILL_ADMISSION_STATES = ["unscanned", "clean", "held", "refused", "admitted"] as const;
/** `MCP_UPSTREAM_TRANSPORTS` */
export const AI_BOM_MCP_TRANSPORTS = ["streamable_http", "sse", "stdio"] as const;
/** `ADR-0045` bias/fairness slot statuses (`BIAS_FAIRNESS_STATUSES`) */
export const AI_BOM_BIAS_STATUSES = ["not_assessed", "in_progress", "assessed", "waived"] as const;
/** the config artifact types whose active and canary versions are agent components (round 8, 4237322637) */
export const AI_BOM_AGENT_CONFIG_TYPES = ["agent_system_prompt", "agent_config"] as const;
export const AI_BOM_CONFIG_STATUSES = ["active", "canary"] as const;
/** the memory stores of the ADR-0082 inventory (`memoryStoreInventory`) */
export const AI_BOM_MEMORY_STORE_KINDS = ["semantic_cache", "conversations", "builder_agent_memory", "project_context"] as const;

/** round 9: the only `data_claims` keys that may reach a BOM (spike B0 `DATA_CLAIM_KEYS`) */
export const AI_BOM_DATA_CLAIM_KEYS = ["trainingData", "task", "architecture", "license", "retention", "releaseTime", "downloadLocation"] as const;
export const AI_BOM_DATA_CLAIM_MAX_CHARS = 512;
/** the cap on any free-text value that may appear (names, intended use, limitations) */
export const AI_BOM_TEXT_MAX_CHARS = 4096;
export const AI_BOM_NAME_MAX_CHARS = 512;
/** the most records one list may carry (an install snapshot is bounded, never unbounded memory) */
export const AI_BOM_MAX_RECORDS_PER_LIST = 20_000;

export class AiBomRecordError extends Error {
  constructor(message: string) {
    super(`ai-bom: ${message}`);
    this.name = "AiBomRecordError";
  }
}
const fail = (m: string): never => {
  throw new AiBomRecordError(m);
};

// ---------------------------------------------------------------------------
// the record types (field names = the drizzle field names they come from)
// ---------------------------------------------------------------------------

type Nullable<T> = T | null;
export interface UseCaseRecord {
  id: string;
  name: string;
  ownerUserId: Nullable<string>;
  /** only under `bom_person_identifiers = display_name` (R45: AI BOMs only), read in the same capture */
  ownerDisplayName: Nullable<string>;
  dataSensitivity: string;
  complianceTags: string[];
  euAiActTier: Nullable<string>;
  status: string;
  intendedAgentIds: string[];
}
export interface AgentRecord {
  id: string;
  name: string;
  provider: string;
  /** `agents.model`: the requested model; agents have NO version column (#280 round 12) */
  model: Nullable<string>;
  expectedServedModel: Nullable<string>;
  customProviderId: Nullable<string>;
  lifecycleStatus: string;
  ownerUserId: Nullable<string>;
  ownerDisplayName: Nullable<string>;
  /** the ADR-0188 workload identity URI, when one is registered */
  workloadIdentity: Nullable<string>;
  /** ADR-0082 OBSERVED use, kept apart from the granted edges */
  observedLastSeen: Nullable<string>;
  observedCount: number;
}
export interface CustomProviderRecord {
  id: string;
  name: string;
  wireProtocol: string;
  baseUrl: Nullable<string>;
  /** R30: `authenticated` from the credential record (a key ciphertext is stored) */
  keySet: boolean;
}
export interface BiasFairnessRecord {
  dimension: string;
  method: string;
  status: string;
  resultRef: Nullable<string>;
  assessedAt: Nullable<string>;
}
export interface ModelCardRecord {
  id: string;
  agentId: Nullable<string>;
  customProviderId: Nullable<string>;
  intendedUse: string;
  limitations: Nullable<string>;
  biasFairness: BiasFairnessRecord[];
  dataClaims: Record<string, string | number | boolean>;
  standardRefs: string[];
  /** #280 round 12 (4237584891): the version of THIS card's model component */
  pinnedModelVersion: Nullable<string>;
}
export interface ModelCardApprovalRecord {
  id: string;
  cardId: string;
  status: string;
  decidedAt: Nullable<string>;
  validUntil: Nullable<string>;
}
export interface ModelCardEvidenceRecord {
  id: string;
  cardId: string;
  kind: string;
  evalRunId: Nullable<string>;
  /** already made safe by `safeReference` (never the raw text) */
  externalRef: Nullable<string>;
  artifactScanId: Nullable<string>;
  attachedAt: string;
}
export interface EvalRunRecord {
  id: string;
  datasetId: string;
  datasetVersion: number;
}
export interface EvalDatasetRecord {
  id: string;
  version: number;
  name: string;
  /** R24/R26: SHA-256 over the RFC 8785 array of the version's `eval_cases` projections (`evalCasesDigest`) */
  casesDigest: string;
}
export interface TrainingDatasetRecord {
  id: string;
  version: number;
  name: string;
  checksum: string;
  rowCount: number;
  piiVerdict: string;
  projectId: Nullable<string>;
  /** R24: the linked project's sensitivity, when `project_id` is set */
  projectDataSensitivity: Nullable<string>;
}
export interface TrainingJobRecord {
  id: string;
  datasetId: string;
  datasetVersion: number;
  method: string;
  baseAgentId: Nullable<string>;
  status: string;
}
export interface TrainingArtifactRecord {
  id: string;
  jobId: string;
  name: string;
  method: string;
  kind: string;
  agentId: Nullable<string>;
  modelCardId: Nullable<string>;
  /** #280 (4237488600): SHA-256 over the RFC 8785 bytes of an INLINE artifact's payload; null for remote */
  payloadDigest: Nullable<string>;
  createdAt: string;
}
export interface ModelArtifactRecord {
  id: string;
  sha256: string;
  sizeBytes: number;
  format: string;
}
export interface ArtifactScanRecord {
  id: string;
  artifactId: string;
  engineRunId: Nullable<string>;
  artifactSha256: string;
  verdict: string;
  scannerVersion: string;
  createdAt: string;
}
export interface EngineRunRecord {
  id: string;
  engineId: string;
  engineVersion: string;
}
export interface EngineRecord {
  id: string;
  version: string;
  imageDigest: Nullable<string>;
  licence: string;
}
export interface PromptTagRecord {
  promptId: string;
  promptName: string;
  tag: string;
  commitId: string;
  hash: string;
  agentId: string;
}
export interface ConfigVersionRecord {
  id: string;
  artifactType: string;
  artifactId: string;
  version: number;
  status: string;
  canaryPct: Nullable<number>;
  /** SHA-256 over the RFC 8785 bytes of `config_versions.body` (never the body) */
  bodyDigest: string;
}
export interface McpServerRecord {
  id: string;
  name: string;
  transport: string;
  url: Nullable<string>;
  releaseDigest: Nullable<string>;
  admissionState: string;
  admissionManifestDigest: Nullable<string>;
  identityPropagation: string;
  ownerUserId: Nullable<string>;
  ownerDisplayName: Nullable<string>;
}
export interface McpToolRecord {
  id: string;
  serverId: string;
  name: string;
  kind: string;
}
export interface ConnectorRecord {
  id: string;
  name: string;
  kind: string;
  url: Nullable<string>;
  ownerUserId: Nullable<string>;
  ownerDisplayName: Nullable<string>;
  /** R30: a credential row exists */
  credentialSet: boolean;
}
export const AI_BOM_GRANT_HOLDERS = ["agent", "builder_agent"] as const;
export const AI_BOM_GRANT_TARGETS = ["mcp_tool", "mcp_server", "connector"] as const;
/** a GRANTED edge (ADR-0082): what may happen, never merged with observed use */
export interface GrantRecord {
  holderKind: string;
  holderId: string;
  targetKind: string;
  targetId: string;
  /** where the grant is recorded (`identity_tool_grants`, `builder_agent_tools`, ...) */
  source: string;
}
export interface BuilderAgentRecord {
  id: string;
  name: string;
  modelAgentId: Nullable<string>;
  ownerUserId: Nullable<string>;
  ownerDisplayName: Nullable<string>;
  workloadIdentity: Nullable<string>;
}
/** #280 round 12 (4237584873): keyed by the (agent_id, skill_id) attachment, with its pinned snapshot */
export interface BuilderSkillRecord {
  agentId: string;
  skillId: string;
  snapshotName: string;
  snapshotDigest: string;
  snapshotVersion: number;
  snapshotAdmissionState: string;
}
export interface MemoryStoreRecord {
  kind: string;
  builderAgentId: Nullable<string>;
}
export interface InstallRecord {
  /** ADR-0116: the operator-set install id, or null (said so, never generated) */
  installId: Nullable<string>;
}

export interface AiBomRecordSet {
  subject: { kind: AiBomSubjectKind; id: string };
  install: InstallRecord | null;
  useCases: UseCaseRecord[];
  agents: AgentRecord[];
  customProviders: CustomProviderRecord[];
  modelCards: ModelCardRecord[];
  modelCardApprovals: ModelCardApprovalRecord[];
  modelCardEvidence: ModelCardEvidenceRecord[];
  evalRuns: EvalRunRecord[];
  evalDatasets: EvalDatasetRecord[];
  trainingDatasets: TrainingDatasetRecord[];
  trainingJobs: TrainingJobRecord[];
  trainingArtifacts: TrainingArtifactRecord[];
  modelArtifacts: ModelArtifactRecord[];
  artifactScans: ArtifactScanRecord[];
  engineRuns: EngineRunRecord[];
  engines: EngineRecord[];
  promptTags: PromptTagRecord[];
  configVersions: ConfigVersionRecord[];
  mcpServers: McpServerRecord[];
  mcpTools: McpToolRecord[];
  connectors: ConnectorRecord[];
  grants: GrantRecord[];
  builderAgents: BuilderAgentRecord[];
  builderSkills: BuilderSkillRecord[];
  memoryStores: MemoryStoreRecord[];
  /**
   * B7 (R9): the release's ADR-0184 SBOMs, ONLY from a signature-verified
   * identity file (`verifiedReleaseSbomRecords`) or, in our release build, from
   * the SBOM bytes themselves (`releaseBuildSbomRecords`). Install subject only;
   * omitted or empty means no BOM-Link and an `incomplete` subject.
   */
  releaseSboms?: ReleaseSbomRecord[];
  /** B7: the reviewed inventory of AI tools in our development stack (`security/ai-dev-stack.json`); install subject only */
  devStackTools?: AiDevStackTool[];
}
/** the record lists only an install snapshot may carry (B7) */
export const AI_BOM_INSTALL_ONLY_LISTS = ["releaseSboms", "devStackTools"] as const;
type RecordOf<K extends keyof AiBomRecordSet> = NonNullable<AiBomRecordSet[K]> extends ReadonlyArray<infer T> ? T : never;

/** the list-valued keys of a record set, in a fixed order */
export const AI_BOM_RECORD_LISTS = [
  "useCases", "agents", "customProviders", "modelCards", "modelCardApprovals", "modelCardEvidence", "evalRuns",
  "evalDatasets", "trainingDatasets", "trainingJobs", "trainingArtifacts", "modelArtifacts", "artifactScans",
  "engineRuns", "engines", "promptTags", "configVersions", "mcpServers", "mcpTools", "connectors", "grants",
  "builderAgents", "builderSkills", "memoryStores", "releaseSboms", "devStackTools",
] as const satisfies ReadonlyArray<keyof AiBomRecordSet>;
export type AiBomRecordList = (typeof AI_BOM_RECORD_LISTS)[number];

/** the source table of each record list (R22's basis names the table) */
export const AI_BOM_RECORD_TABLES: Readonly<Record<AiBomRecordList, string>> = {
  useCases: "ai_use_cases", agents: "agents", customProviders: "custom_model_providers", modelCards: "model_cards",
  modelCardApprovals: "model_card_approvals", modelCardEvidence: "model_card_evidence", evalRuns: "eval_runs",
  evalDatasets: "eval_datasets", trainingDatasets: "training_datasets", trainingJobs: "training_jobs",
  trainingArtifacts: "training_artifacts", modelArtifacts: "model_artifacts", artifactScans: "artifact_scans",
  engineRuns: "engine_runs", engines: "engines", promptTags: "prompt_tags", configVersions: "config_versions",
  mcpServers: "mcp_servers", mcpTools: "mcp_tools", connectors: "connectors", grants: "grants",
  builderAgents: "builder_agents", builderSkills: "builder_agent_skills", memoryStores: "memory_stores",
  // B7: not tables; the signed release identity file and the checked-in inventory
  releaseSboms: "release:sbom_identity", devStackTools: "release:ai_dev_stack",
};

/** THE ALLOWLISTS: exactly the fields each record may carry */
const FIELDS: { [K in AiBomRecordList]: ReadonlyArray<keyof RecordOf<K>> } = {
  useCases: ["id", "name", "ownerUserId", "ownerDisplayName", "dataSensitivity", "complianceTags", "euAiActTier", "status", "intendedAgentIds"],
  agents: ["id", "name", "provider", "model", "expectedServedModel", "customProviderId", "lifecycleStatus", "ownerUserId", "ownerDisplayName", "workloadIdentity", "observedLastSeen", "observedCount"],
  customProviders: ["id", "name", "wireProtocol", "baseUrl", "keySet"],
  modelCards: ["id", "agentId", "customProviderId", "intendedUse", "limitations", "biasFairness", "dataClaims", "standardRefs", "pinnedModelVersion"],
  modelCardApprovals: ["id", "cardId", "status", "decidedAt", "validUntil"],
  modelCardEvidence: ["id", "cardId", "kind", "evalRunId", "externalRef", "artifactScanId", "attachedAt"],
  evalRuns: ["id", "datasetId", "datasetVersion"],
  evalDatasets: ["id", "version", "name", "casesDigest"],
  trainingDatasets: ["id", "version", "name", "checksum", "rowCount", "piiVerdict", "projectId", "projectDataSensitivity"],
  trainingJobs: ["id", "datasetId", "datasetVersion", "method", "baseAgentId", "status"],
  trainingArtifacts: ["id", "jobId", "name", "method", "kind", "agentId", "modelCardId", "payloadDigest", "createdAt"],
  modelArtifacts: ["id", "sha256", "sizeBytes", "format"],
  artifactScans: ["id", "artifactId", "engineRunId", "artifactSha256", "verdict", "scannerVersion", "createdAt"],
  engineRuns: ["id", "engineId", "engineVersion"],
  engines: ["id", "version", "imageDigest", "licence"],
  promptTags: ["promptId", "promptName", "tag", "commitId", "hash", "agentId"],
  configVersions: ["id", "artifactType", "artifactId", "version", "status", "canaryPct", "bodyDigest"],
  mcpServers: ["id", "name", "transport", "url", "releaseDigest", "admissionState", "admissionManifestDigest", "identityPropagation", "ownerUserId", "ownerDisplayName"],
  mcpTools: ["id", "serverId", "name", "kind"],
  connectors: ["id", "name", "kind", "url", "ownerUserId", "ownerDisplayName", "credentialSet"],
  grants: ["holderKind", "holderId", "targetKind", "targetId", "source"],
  builderAgents: ["id", "name", "modelAgentId", "ownerUserId", "ownerDisplayName", "workloadIdentity"],
  builderSkills: ["agentId", "skillId", "snapshotName", "snapshotDigest", "snapshotVersion", "snapshotAdmissionState"],
  memoryStores: ["kind", "builderAgentId"],
  releaseSboms: ["kind", "serialNumber", "version", "sha256", "imageDigest", "releaseCommit", "identityBasis"],
  devStackTools: ["id", "category", "description", "deployment", "networkEgress", "repositoryAccess", "dataShared", "outputControl", "governedBy", "introducedOn"],
};
const BIAS_FIELDS = ["dimension", "method", "status", "resultRef", "assessedAt"] as const;

/** the stable key of one record (its id, or the composite of an attachment/edge) */
export function aiBomRecordKey(list: AiBomRecordList, r: Record<string, unknown>): string {
  switch (list) {
    case "promptTags":
      return `${r.promptId}:${r.tag}`;
    case "grants":
      return `${r.holderKind}:${r.holderId}:${r.targetKind}:${r.targetId}:${r.source}`;
    case "builderSkills":
      return `${r.agentId}:${r.skillId}`;
    case "memoryStores":
      return `${r.kind}:${r.builderAgentId ?? "org"}`;
    case "releaseSboms":
      return String(r.kind);
    case "evalDatasets":
    case "trainingDatasets":
      return `${r.id}:${r.version}`;
    default:
      return String(r.id);
  }
}

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

/** code-unit order, never localeCompare (amendment 5) */
export const cmpCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export const sortedBy = <T>(list: readonly T[], key: (x: T) => string): T[] => [...list].sort((a, b) => cmpCodeUnits(key(a), key(b)));
const sortedStrings = (list: readonly string[]): string[] => [...list].sort(cmpCodeUnits);
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_MS = (v: string) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

function oneOf<T extends string>(what: string, v: unknown, allowed: readonly T[]): T {
  // never echo the record value (PR #287): name the field and the rule only
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) fail(`${what}: not one of ${allowed.join(" | ")}`);
  return v as T;
}
function text(what: string, v: unknown, max: number, opts: { nullable?: boolean } = {}): string | null {
  if (v === null || v === undefined) return opts.nullable ? null : fail(`${what}: required`);
  if (typeof v !== "string") return fail(`${what}: not text`);
  if (v.length > max) fail(`${what}: longer than ${max} characters (refused, never truncated)`);
  return v;
}
const req = (what: string, v: unknown, max: number) => text(what, v, max) as string;
const opt = (what: string, v: unknown, max: number) => text(what, v, max, { nullable: true });
function uuid(what: string, v: unknown, nullable = false): string | null {
  if (v === null || v === undefined) return nullable ? null : fail(`${what}: required`);
  if (typeof v !== "string" || !UUID.test(v)) fail(`${what}: not a uuid`);
  return v as string;
}
function int(what: string, v: unknown, nullable = false): number | null {
  if (v === null || v === undefined) return nullable ? null : fail(`${what}: required`);
  if (typeof v === "bigint") return fail(`${what}: load it as a checked safe integer`);
  if (typeof v !== "number" || !Number.isSafeInteger(v)) fail(`${what}: not a safe integer (amendment 5)`);
  return v as number;
}
function time(what: string, v: unknown, nullable = false): string | null {
  if (v === null || v === undefined) return nullable ? null : fail(`${what}: required`);
  const s = v instanceof Date ? v.toISOString() : v;
  if (typeof s !== "string" || !ISO_MS(s)) fail(`${what}: not an ISO-8601 UTC time with milliseconds`);
  return s as string;
}
function digest(what: string, v: unknown, nullable = false): string | null {
  if (v === null || v === undefined) return nullable ? null : fail(`${what}: required`);
  if (typeof v !== "string" || !HEX64.test(v)) fail(`${what}: not a bare lowercase SHA-256 (R30: never \`sha256:undefined\`)`);
  return v as string;
}
const ident = (what: string, v: unknown): string => {
  if (!bomIdentifierSchema.safeParse(v).success) fail(`${what}: not an identifier`);
  // X41 B9F-01: an identifier-shaped credential (`sk-…`) is still a credential (policy (c))
  return guardName(what, v as string);
};
const bool = (what: string, v: unknown): boolean => (typeof v === "boolean" ? v : fail(`${what}: not a boolean`));
function strings(what: string, v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return fail(`${what}: not a list`);
  return sortedStrings(v.map((x, i) => req(`${what}[${i}]`, x, max)));
}

/**
 * R47 + #280 (4237493036): an exported endpoint is scheme://host[:port] ONLY.
 * Query, fragment and path are always dropped (a path can carry a credential).
 * Userinfo refuses. Not relaxable.
 */
export function sanitiseAiBomEndpoint(url: string, what: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return fail(`${what}: endpoint is not an absolute URL`);
  }
  if (u.username || u.password) fail(`${what}: endpoint carries userinfo; snapshot refused (R47)`);
  if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) fail(`${what}: endpoint scheme is not exportable`); // never the scheme text: it is part of the value
  if (!/^[A-Za-z0-9.-]+$/.test(u.hostname)) fail(`${what}: endpoint host is not exportable as plain ASCII`);
  const origin = `${u.protocol}//${u.host}`;
  // belt and braces: the B1 export shape (R47), checked by its linear splitter
  if (!isBomExportEndpoint(origin)) fail(`${what}: endpoint is not exportable`);
  return origin;
}

/** a scheme prefix (`https:`, `id:`, `mailto:`): bounded, anchored, linear */
const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]{0,31}:/;
/** an identifier of known shape: no `:`, `/`, `=`, `+`, `@`, `#` (PR #287 decision) */
const REF_ID = /^[A-Za-z0-9._-]{1,128}$/;
const isRefId = (v: string) => UUID.test(v) || REF_ID.test(v);
const WEB_SCHEMES: readonly string[] = ["http:", "https:", "ws:", "wss:"];
/**
 * B7 fix round F4: a scheme-prefixed value IS a URL only when `//` follows the
 * scheme, or the scheme is http, https, ws or wss. `Prod: claims triage` and
 * `llama3:8b` are text (still credential-guarded), not refused URLs.
 */
function isUrlValue(v: string): boolean {
  const n = urlView(v);
  const m = SCHEME_PREFIX.exec(n);
  if (!m) return false;
  return n.startsWith("//", m[0].length) || WEB_SCHEMES.includes(m[0].toLowerCase());
}
/** the percent-escapes that spell a URL delimiter (`/`, `?`, `#`, `;`), decoded for the checks only */
const URL_DELIMITER_ESCAPES: Readonly<Record<string, string>> = { "2f": "/", "3f": "?", "23": "#", "3b": ";" };
/**
 * B7 round 3 (F3 bypasses): the view of a value a URL check looks at, built
 * on a COPY in one linear pass, never a regex: NFKC (fullwidth `／？` become
 * `/?`), leading whitespace trimmed, `\` read as `/`, and the four delimiter
 * escapes `%2F %3F %23 %3B` decoded (any case). Only those four: a general
 * `decodeURIComponent` would throw on ordinary prose such as "50% of cases",
 * and these four cannot fail to decode. The value itself is never rewritten.
 */
function urlView(v: string): string {
  const n = v.normalize("NFKC").trimStart();
  let out = "";
  for (let i = 0; i < n.length; i++) {
    const c = n[i]!;
    if (c === "\\") out += "/";
    else if (c === "%" && i + 2 < n.length && URL_DELIMITER_ESCAPES[n.slice(i + 1, i + 3).toLowerCase()] !== undefined) {
      out += URL_DELIMITER_ESCAPES[n.slice(i + 1, i + 3).toLowerCase()]!;
      i += 2;
    } else out += c;
  }
  return out;
}
/**
 * B7 fix rounds F3 and 3: a protocol-relative URL (`//host/path`) or a
 * scheme-less one carrying a query, fragment or parameter (`host/path?sig=`,
 * `host/path#sig=`, `host/path;sig=`), on the normalised view. Plain string
 * checks, no regex (linear). `team/model-name` (a `/`, no delimiter) is text.
 */
const hiddenUrl = (v: string) => {
  const n = urlView(v);
  return n.startsWith("//") || (n.includes("/") && (n.includes("?") || n.includes("#") || n.includes(";")));
};
/** does the text carry a URL (a URL value, or `://` anywhere), on the normalised view? */
const carriesUrl = (v: string) => isUrlValue(v) || urlView(v).includes("://");
/**
 * B7 round 3: a scheme a consumer may turn into an executable link is refused
 * in names and free text. `data:` only when a payload follows directly
 * (`data:text/html,…`), so "Data: claims summary" stays prose.
 */
function scriptScheme(v: string): boolean {
  const n = urlView(v).toLowerCase();
  if (n.startsWith("javascript:") || n.startsWith("vbscript:")) return true;
  return n.startsWith("data:") && n.length > 5 && n[5] !== " " && n[5] !== "\t";
}

/**
 * #280 (4237488597) and the PR #287 decision (ADR-0180): a free-form
 * reference is NEVER emitted raw. An already-safe output passes (idempotent);
 * an `id:` input is re-validated; any scheme-prefixed value is a URL reduced to
 * its origin (`sanitiseAiBomEndpoint`) or refused; an identifier of known shape
 * is `id:`; everything else is `sha256:` of its bytes.
 */
export function safeReference(v: string, what: string): string {
  if (v.startsWith("sha256:") && HEX64.test(v.slice(7))) return v;
  if (v.startsWith("id:")) return isRefId(v.slice(3)) ? v : `sha256:${sha256(v)}`;
  if (v.startsWith("url:")) return `url:${sanitiseAiBomEndpoint(v.slice(4), what)}`;
  if (carriesUrl(v)) return `url:${sanitiseAiBomEndpoint(urlView(v), what)}`;
  if (isRefId(v)) return `id:${v}`;
  return `sha256:${sha256(v)}`;
}

/**
 * Free text that may appear (names, intended use, limitations, claims, bias
 * dimension and method): refused when it holds credential-shaped material,
 * detected by the audit scrubber's own rules (`scrubAuditText`, ADR-0099; no
 * new pattern). The refusal names the field, never the value.
 */
function guardText(what: string, v: string): string {
  if (scrubAuditText(v) !== v) fail(`${what}: holds credential-shaped material (refused, never redacted)`);
  return v;
}
/**
 * X41 B9F-02 (ADR-0180 policy (b)+(c)): free text (names, intended use,
 * limitations, prompt names): a value that IS a URL keeps its origin only, a URL
 * inside prose is refused, and other text passes the credential guard.
 */
const free = (what: string, v: unknown, max: number) => urlOrText(what, req(what, v, max));
const freeOpt = (what: string, v: unknown, max: number) => {
  const t = opt(what, v, max);
  return t === null ? null : urlOrText(what, t);
};
/**
 * X41 B9F-01 (policy (c)): a name or identifier that is not a fixed shape
 * (provider, model, served model, owner display name, pinned model version):
 * refused when it holds credential material or any URL. Not cut to an origin,
 * because `name:tag` model ids look like a scheme and must stay exact.
 */
function guardName(what: string, v: string): string {
  if (carriesUrl(v) || hiddenUrl(v) || scriptScheme(v)) fail(`${what}: a URL is refused in a name or identifier`);
  return guardText(what, v);
}
const name = (what: string, v: unknown, max: number) => guardName(what, req(what, v, max));
const nameOpt = (what: string, v: unknown, max: number) => {
  const t = opt(what, v, max);
  return t === null ? null : guardName(what, t);
};
/**
 * A value that may be a URL or text (claims, standard refs, bias method): a
 * URL keeps its origin only (R47); a URL buried in prose is refused; other
 * text passes the credential guard.
 */
function urlOrText(what: string, v: string): string {
  if (scriptScheme(v)) fail(`${what}: a script or data URL is refused`);
  if (isUrlValue(v)) return sanitiseAiBomEndpoint(urlView(v), what);
  if (carriesUrl(v) || hiddenUrl(v)) fail(`${what}: a URL inside free text is refused; record the URL on its own`);
  return guardText(what, v);
}
/** a timestamp (date or date-time), checked linearly then parsed */
const STAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9:.]{1,18}(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?$/;
function stamp(what: string, v: unknown, nullable: boolean): string | null {
  if (v === null || v === undefined) return nullable ? null : fail(`${what}: required`);
  if (typeof v !== "string" || v.length > 40 || !STAMP.test(v) || !Number.isFinite(Date.parse(v))) return fail(`${what}: not a timestamp`);
  return v;
}

function onlyFields<K extends AiBomRecordList>(list: K, r: unknown, at: string): Record<string, unknown> {
  if (!r || typeof r !== "object" || Array.isArray(r)) return fail(`${at}: expected an object`);
  const allowed = FIELDS[list] as readonly string[];
  const extra = Object.keys(r).filter((k) => !allowed.includes(k));
  if (extra.length) fail(`${at}: unknown key(s) refused: ${extra.join(", ")}`);
  const missing = allowed.filter((k) => !(k in r));
  if (missing.length) fail(`${at}: missing field(s): ${missing.join(", ")}`);
  return r as Record<string, unknown>;
}

function dataClaims(v: unknown, at: string): Record<string, string | number | boolean> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail(`${at}: data_claims must be an object`);
  const out: Record<string, string | number | boolean> = {};
  for (const k of sortedStrings(Object.keys(v))) {
    if (!(AI_BOM_DATA_CLAIM_KEYS as readonly string[]).includes(k)) fail(`${at}: an unknown data_claims key is refused (allowed: ${AI_BOM_DATA_CLAIM_KEYS.join(", ")})`);
    let x = (v as Record<string, unknown>)[k];
    if (typeof x === "string") {
      if (x.length > AI_BOM_DATA_CLAIM_MAX_CHARS) fail(`${at}.${k}: longer than ${AI_BOM_DATA_CLAIM_MAX_CHARS} characters`);
      // PR #287: a URL claim keeps its origin only (R47), a time claim must be a time, other text is guarded
      if (k === "releaseTime") x = stamp(`${at}.${k}`, x, false);
      else if (k === "downloadLocation") x = carriesUrl(x as string) ? sanitiseAiBomEndpoint(urlView(x as string), `${at}.${k}`) : fail(`${at}.${k}: not a URL`);
      else x = urlOrText(`${at}.${k}`, x as string);
    } else if (!(typeof x === "boolean" || (typeof x === "number" && Number.isSafeInteger(x)))) {
      fail(`${at}.${k}: only a string, safe integer or boolean is allowed (no nested object or array)`);
    }
    out[k] = x as string | number | boolean;
  }
  return out;
}

const spiffeOrNull = (what: string, v: unknown): string | null => {
  if (v === null) return null;
  // B1's linear, length-capped split check (CodeQL js/polynomial-redos), one definition for every SPIFFE id
  if (typeof v !== "string" || !isBomSpiffeId(v)) return fail(`${what}: not a workload identity URI`);
  return v;
};

// ---------------------------------------------------------------------------
// normalise
// ---------------------------------------------------------------------------

/**
 * Validate and normalise a loaded record set. Refuses unknown keys, unknown
 * enum values, unsafe integers, malformed digests and credential-bearing
 * endpoints. Returns a NEW set whose every list is sorted by its record key,
 * so the builder's output does not depend on input order.
 */
export function normaliseAiBomRecords(input: AiBomRecordSet): AiBomRecordSet {
  if (!input || typeof input !== "object") fail("record set: expected an object");
  const subjectKind = oneOf("subject.kind", input.subject?.kind, AI_BOM_SUBJECT_KINDS);
  const subject = { kind: subjectKind, id: uuid("subject.id", input.subject?.id) as string };
  const install = input.install === null ? null : { installId: input.install?.installId === null ? null : ident("install.installId", input.install?.installId) };
  if (subjectKind === "install" && install === null) fail("an install subject needs its install record");

  const each = <K extends AiBomRecordList>(list: K, map: (r: Record<string, unknown>, at: string) => RecordOf<K>): RecordOf<K>[] => {
    let raw = (input as unknown as Record<string, unknown>)[list];
    // B7's install-only lists are optional on input; every other list is required
    if (raw === undefined && (AI_BOM_INSTALL_ONLY_LISTS as readonly string[]).includes(list)) raw = [];
    if (!Array.isArray(raw)) return fail(`${list}: expected a list`);
    if (raw.length > AI_BOM_MAX_RECORDS_PER_LIST) fail(`${list}: more than the cap of ${AI_BOM_MAX_RECORDS_PER_LIST} records (refused)`);
    const out = raw.map((r, i) => map(onlyFields(list, r, `${list}[${i}]`), `${list}[${i}]`));
    const sorted = sortedBy(out, (r) => aiBomRecordKey(list, r as unknown as Record<string, unknown>));
    for (let i = 1; i < sorted.length; i++) {
      const a = aiBomRecordKey(list, sorted[i - 1] as unknown as Record<string, unknown>);
      if (a === aiBomRecordKey(list, sorted[i] as unknown as Record<string, unknown>)) fail(`${list}: record ${a} loaded twice`);
    }
    return sorted;
  };

  const n: AiBomRecordSet = {
    subject,
    install,
    useCases: each("useCases", (r, at) => ({
      id: uuid(`${at}.id`, r.id) as string,
      name: free(`${at}.name`, r.name, AI_BOM_NAME_MAX_CHARS),
      ownerUserId: uuid(`${at}.ownerUserId`, r.ownerUserId, true),
      ownerDisplayName: nameOpt(`${at}.ownerDisplayName`, r.ownerDisplayName, AI_BOM_NAME_MAX_CHARS),
      dataSensitivity: oneOf(`${at}.dataSensitivity`, r.dataSensitivity, AI_BOM_DATA_SENSITIVITIES),
      complianceTags: strings(`${at}.complianceTags`, r.complianceTags, 128).map((t, i) => ident(`${at}.complianceTags[${i}]`, t)),
      euAiActTier: r.euAiActTier === null ? null : ident(`${at}.euAiActTier`, r.euAiActTier),
      status: ident(`${at}.status`, r.status),
      intendedAgentIds: strings(`${at}.intendedAgentIds`, r.intendedAgentIds, 64).map((t, i) => uuid(`${at}.intendedAgentIds[${i}]`, t) as string),
    })),
    agents: each("agents", (r, at) => ({
      id: uuid(`${at}.id`, r.id) as string,
      name: free(`${at}.name`, r.name, AI_BOM_NAME_MAX_CHARS),
      provider: name(`${at}.provider`, r.provider, AI_BOM_NAME_MAX_CHARS),
      model: nameOpt(`${at}.model`, r.model, AI_BOM_NAME_MAX_CHARS),
      expectedServedModel: nameOpt(`${at}.expectedServedModel`, r.expectedServedModel, AI_BOM_NAME_MAX_CHARS),
      customProviderId: uuid(`${at}.customProviderId`, r.customProviderId, true),
      lifecycleStatus: ident(`${at}.lifecycleStatus`, r.lifecycleStatus),
      ownerUserId: uuid(`${at}.ownerUserId`, r.ownerUserId, true),
      ownerDisplayName: nameOpt(`${at}.ownerDisplayName`, r.ownerDisplayName, AI_BOM_NAME_MAX_CHARS),
      workloadIdentity: spiffeOrNull(`${at}.workloadIdentity`, r.workloadIdentity),
      observedLastSeen: time(`${at}.observedLastSeen`, r.observedLastSeen, true),
      observedCount: int(`${at}.observedCount`, r.observedCount) as number,
    })),
    customProviders: each("customProviders", (r, at) => ({
      id: uuid(`${at}.id`, r.id) as string,
      name: free(`${at}.name`, r.name, AI_BOM_NAME_MAX_CHARS),
      wireProtocol: ident(`${at}.wireProtocol`, r.wireProtocol),
      baseUrl: r.baseUrl === null ? null : sanitiseAiBomEndpoint(req(`${at}.baseUrl`, r.baseUrl, 2048), `${at}.baseUrl`),
      keySet: bool(`${at}.keySet`, r.keySet),
    })),
    modelCards: each("modelCards", (r, at) => {
      const agentId = uuid(`${at}.agentId`, r.agentId, true);
      const customProviderId = uuid(`${at}.customProviderId`, r.customProviderId, true);
      if ((agentId === null) === (customProviderId === null)) fail(`${at}: exactly one of agentId and customProviderId (model_cards_subject_check)`);
      const intendedUse = free(`${at}.intendedUse`, r.intendedUse, AI_BOM_TEXT_MAX_CHARS);
      if (!intendedUse.trim()) fail(`${at}.intendedUse: empty`);
      if (!Array.isArray(r.biasFairness)) fail(`${at}.biasFairness: not a list`);
      const bias = (r.biasFairness as unknown[]).map((b, i) => {
        const w = `${at}.biasFairness[${i}]`;
        if (!b || typeof b !== "object" || Array.isArray(b)) return fail(`${w}: expected an object`);
        const extra = Object.keys(b).filter((k) => !(BIAS_FIELDS as readonly string[]).includes(k));
        if (extra.length) fail(`${w}: an unknown bias_fairness key is refused (allowed: ${BIAS_FIELDS.join(", ")})`);
        const o = b as Record<string, unknown>;
        const resultRef = opt(`${w}.resultRef`, o.resultRef, AI_BOM_TEXT_MAX_CHARS);
        return {
          dimension: free(`${w}.dimension`, o.dimension, AI_BOM_NAME_MAX_CHARS),
          method: urlOrText(`${w}.method`, req(`${w}.method`, o.method, AI_BOM_NAME_MAX_CHARS)),
          status: oneOf(`${w}.status`, o.status, AI_BOM_BIAS_STATUSES),
          resultRef: resultRef === null || resultRef === "" ? null : safeReference(resultRef, `${w}.resultRef`),
          assessedAt: stamp(`${w}.assessedAt`, o.assessedAt === "" ? null : o.assessedAt, true),
        } satisfies BiasFairnessRecord;
      });
      const limitations = freeOpt(`${at}.limitations`, r.limitations, AI_BOM_TEXT_MAX_CHARS);
      const pinned = nameOpt(`${at}.pinnedModelVersion`, r.pinnedModelVersion, AI_BOM_NAME_MAX_CHARS);
      return {
        id: uuid(`${at}.id`, r.id) as string,
        agentId,
        customProviderId,
        intendedUse,
        limitations: limitations !== null && limitations.trim() ? limitations : null,
        // a TOTAL order on every rendered field (R12 section 13)
        biasFairness: sortedBy(bias, (b) => bomCanonicalBytes(b)),
        dataClaims: dataClaims(r.dataClaims, `${at}.dataClaims`),
        standardRefs: strings(`${at}.standardRefs`, r.standardRefs, AI_BOM_NAME_MAX_CHARS).map((x, i) => urlOrText(`${at}.standardRefs[${i}]`, x)).sort(cmpCodeUnits),
        pinnedModelVersion: pinned !== null && pinned.trim() ? pinned : null,
      };
    }),
    modelCardApprovals: each("modelCardApprovals", (r, at) => ({
      id: uuid(`${at}.id`, r.id) as string,
      cardId: uuid(`${at}.cardId`, r.cardId) as string,
      status: ident(`${at}.status`, r.status),
      decidedAt: time(`${at}.decidedAt`, r.decidedAt, true),
      validUntil: time(`${at}.validUntil`, r.validUntil, true),
    })),
    modelCardEvidence: each("modelCardEvidence", (r, at) => {
      const kind = oneOf(`${at}.kind`, r.kind, AI_BOM_EVIDENCE_KINDS);
      const evalRunId = uuid(`${at}.evalRunId`, r.evalRunId, true);
      const artifactScanId = uuid(`${at}.artifactScanId`, r.artifactScanId, true);
      const external = opt(`${at}.externalRef`, r.externalRef, AI_BOM_TEXT_MAX_CHARS);
      // model_card_evidence_shape_check, re-asserted: exactly the kind's reference
      if ((kind === "eval_run") !== (evalRunId !== null) || (kind === "external") !== (external !== null) || (kind === "engine_scan") !== (artifactScanId !== null)) {
        fail(`${at}: reference does not match kind ${kind}`);
      }
      return {
        id: uuid(`${at}.id`, r.id) as string,
        cardId: uuid(`${at}.cardId`, r.cardId) as string,
        kind,
        evalRunId,
        // already-safe values (a prior normalise) pass through unchanged
        externalRef: external === null ? null : safeReference(external, `${at}.externalRef`),
        artifactScanId,
        attachedAt: time(`${at}.attachedAt`, r.attachedAt) as string,
      };
    }),
    evalRuns: each("evalRuns", (r, at) => ({
      id: uuid(`${at}.id`, r.id) as string,
      datasetId: uuid(`${at}.datasetId`, r.datasetId) as string,
      datasetVersion: int(`${at}.datasetVersion`, r.datasetVersion) as number,
    })),
    evalDatasets: each("evalDatasets", (r, at) => ({
      id: uuid(`${at}.id`, r.id) as string,
      version: int(`${at}.version`, r.version) as number,
      name: free(`${at}.name`, r.name, AI_BOM_NAME_MAX_CHARS),
      casesDigest: digest(`${at}.casesDigest`, r.casesDigest) as string,
    })),
    trainingDatasets: each("trainingDatasets", (r, at) => {
      const rowCount = int(`${at}.rowCount`, r.rowCount) as number;
      const checksum = text(`${at}.checksum`, r.checksum, 128) as string;
      // round 13: B1's parser (safe-integer count, agreement with row_count); refuses any other form
      parseTrainingDatasetChecksum(checksum, rowCount);
      const projectId = uuid(`${at}.projectId`, r.projectId, true);
      const pds = r.projectDataSensitivity === null ? null : oneOf(`${at}.projectDataSensitivity`, r.projectDataSensitivity, AI_BOM_DATA_SENSITIVITIES);
      if (projectId === null && pds !== null) fail(`${at}: a classification without a project (R24)`);
      return {
        id: uuid(`${at}.id`, r.id) as string,
        version: int(`${at}.version`, r.version) as number,
        name: free(`${at}.name`, r.name, AI_BOM_NAME_MAX_CHARS),
        checksum,
        rowCount,
        piiVerdict: oneOf(`${at}.piiVerdict`, r.piiVerdict, AI_BOM_PII_VERDICTS),
        projectId,
        projectDataSensitivity: pds,
      };
    }),
    trainingJobs: each("trainingJobs", (r, at) => ({
      id: uuid(`${at}.id`, r.id) as string,
      datasetId: uuid(`${at}.datasetId`, r.datasetId) as string,
      datasetVersion: int(`${at}.datasetVersion`, r.datasetVersion) as number,
      method: ident(`${at}.method`, r.method),
      baseAgentId: uuid(`${at}.baseAgentId`, r.baseAgentId, true),
      status: ident(`${at}.status`, r.status),
    })),
    trainingArtifacts: each("trainingArtifacts", (r, at) => {
      const kind = oneOf(`${at}.kind`, r.kind, ["inline", "remote"] as const);
      const payloadDigest = digest(`${at}.payloadDigest`, r.payloadDigest, true);
      if (kind === "remote" && payloadDigest !== null) fail(`${at}: a remote artifact has no payload to digest`);
      return {
        id: uuid(`${at}.id`, r.id) as string,
        jobId: uuid(`${at}.jobId`, r.jobId) as string,
        name: free(`${at}.name`, r.name, AI_BOM_NAME_MAX_CHARS),
        method: ident(`${at}.method`, r.method),
        kind,
        agentId: uuid(`${at}.agentId`, r.agentId, true),
        modelCardId: uuid(`${at}.modelCardId`, r.modelCardId, true),
        payloadDigest,
        createdAt: time(`${at}.createdAt`, r.createdAt) as string,
      };
    }),
    modelArtifacts: each("modelArtifacts", (r, at) => ({
      id: uuid(`${at}.id`, r.id) as string,
      sha256: digest(`${at}.sha256`, r.sha256) as string,
      sizeBytes: int(`${at}.sizeBytes`, r.sizeBytes) as number,
      format: ident(`${at}.format`, r.format),
    })),
    artifactScans: each("artifactScans", (r, at) => ({
      id: uuid(`${at}.id`, r.id) as string,
      artifactId: uuid(`${at}.artifactId`, r.artifactId) as string,
      engineRunId: uuid(`${at}.engineRunId`, r.engineRunId, true),
      artifactSha256: digest(`${at}.artifactSha256`, r.artifactSha256) as string,
      verdict: oneOf(`${at}.verdict`, r.verdict, AI_BOM_SCAN_VERDICTS),
      scannerVersion: ident(`${at}.scannerVersion`, r.scannerVersion),
      createdAt: time(`${at}.createdAt`, r.createdAt) as string,
    })),
    engineRuns: each("engineRuns", (r, at) => ({
      id: uuid(`${at}.id`, r.id) as string,
      engineId: ident(`${at}.engineId`, r.engineId),
      engineVersion: ident(`${at}.engineVersion`, r.engineVersion),
    })),
    engines: each("engines", (r, at) => {
      const d = r.imageDigest === null ? null : req(`${at}.imageDigest`, r.imageDigest, 80);
      const bare = d === null ? null : d.replace(/^sha256:/, "");
      return {
        id: ident(`${at}.id`, r.id),
        version: ident(`${at}.version`, r.version),
        imageDigest: digest(`${at}.imageDigest`, bare, true),
        licence: ident(`${at}.licence`, r.licence),
      };
    }),
    promptTags: each("promptTags", (r, at) => ({
      promptId: uuid(`${at}.promptId`, r.promptId) as string,
      promptName: free(`${at}.promptName`, r.promptName, AI_BOM_NAME_MAX_CHARS),
      tag: ident(`${at}.tag`, r.tag),
      commitId: uuid(`${at}.commitId`, r.commitId) as string,
      hash: digest(`${at}.hash`, r.hash) as string,
      agentId: uuid(`${at}.agentId`, r.agentId) as string,
    })),
    configVersions: each("configVersions", (r, at) => ({
      id: uuid(`${at}.id`, r.id) as string,
      artifactType: oneOf(`${at}.artifactType`, r.artifactType, AI_BOM_AGENT_CONFIG_TYPES),
      artifactId: uuid(`${at}.artifactId`, r.artifactId) as string,
      version: int(`${at}.version`, r.version) as number,
      status: oneOf(`${at}.status`, r.status, AI_BOM_CONFIG_STATUSES),
      canaryPct: int(`${at}.canaryPct`, r.canaryPct, true),
      bodyDigest: digest(`${at}.bodyDigest`, r.bodyDigest) as string,
    })),
    mcpServers: each("mcpServers", (r, at) => {
      const transport = oneOf(`${at}.transport`, r.transport, AI_BOM_MCP_TRANSPORTS);
      const url = req(`${at}.url`, r.url, 2048);
      return {
        id: uuid(`${at}.id`, r.id) as string,
        name: free(`${at}.name`, r.name, AI_BOM_NAME_MAX_CHARS),
        transport,
        // a stdio server's url is the `stdio:<name>` sentinel, not an endpoint (R12 section 12)
        url: transport === "stdio" ? null : sanitiseAiBomEndpoint(url, `${at}.url`),
        releaseDigest: r.releaseDigest === null ? null : digest(`${at}.releaseDigest`, String(r.releaseDigest).replace(/^sha256:/, "")),
        admissionState: ident(`${at}.admissionState`, r.admissionState),
        admissionManifestDigest: r.admissionManifestDigest === null ? null : digest(`${at}.admissionManifestDigest`, String(r.admissionManifestDigest).replace(/^sha256:/, "")),
        identityPropagation: ident(`${at}.identityPropagation`, r.identityPropagation),
        ownerUserId: uuid(`${at}.ownerUserId`, r.ownerUserId, true),
        ownerDisplayName: nameOpt(`${at}.ownerDisplayName`, r.ownerDisplayName, AI_BOM_NAME_MAX_CHARS),
      };
    }),
    mcpTools: each("mcpTools", (r, at) => ({
      id: uuid(`${at}.id`, r.id) as string,
      serverId: uuid(`${at}.serverId`, r.serverId) as string,
      name: free(`${at}.name`, r.name, AI_BOM_NAME_MAX_CHARS),
      kind: oneOf(`${at}.kind`, r.kind, ["read", "write"] as const),
    })),
    connectors: each("connectors", (r, at) => ({
      id: uuid(`${at}.id`, r.id) as string,
      name: free(`${at}.name`, r.name, AI_BOM_NAME_MAX_CHARS),
      kind: ident(`${at}.kind`, r.kind),
      // a governance-only connector has no base_url: no endpoint at all
      url: r.url === null ? null : sanitiseAiBomEndpoint(req(`${at}.url`, r.url, 2048), `${at}.url`),
      ownerUserId: uuid(`${at}.ownerUserId`, r.ownerUserId, true),
      ownerDisplayName: nameOpt(`${at}.ownerDisplayName`, r.ownerDisplayName, AI_BOM_NAME_MAX_CHARS),
      credentialSet: bool(`${at}.credentialSet`, r.credentialSet),
    })),
    grants: each("grants", (r, at) => ({
      holderKind: oneOf(`${at}.holderKind`, r.holderKind, AI_BOM_GRANT_HOLDERS),
      holderId: uuid(`${at}.holderId`, r.holderId) as string,
      targetKind: oneOf(`${at}.targetKind`, r.targetKind, AI_BOM_GRANT_TARGETS),
      targetId: uuid(`${at}.targetId`, r.targetId) as string,
      source: ident(`${at}.source`, r.source),
    })),
    builderAgents: each("builderAgents", (r, at) => ({
      id: uuid(`${at}.id`, r.id) as string,
      name: free(`${at}.name`, r.name, AI_BOM_NAME_MAX_CHARS),
      modelAgentId: uuid(`${at}.modelAgentId`, r.modelAgentId, true),
      ownerUserId: uuid(`${at}.ownerUserId`, r.ownerUserId, true),
      ownerDisplayName: nameOpt(`${at}.ownerDisplayName`, r.ownerDisplayName, AI_BOM_NAME_MAX_CHARS),
      workloadIdentity: spiffeOrNull(`${at}.workloadIdentity`, r.workloadIdentity),
    })),
    builderSkills: each("builderSkills", (r, at) => {
      const d = text(`${at}.snapshotDigest`, r.snapshotDigest, 64) as string;
      if (d !== "" && !HEX64.test(d)) fail(`${at}.snapshotDigest: malformed`);
      return {
        agentId: uuid(`${at}.agentId`, r.agentId) as string,
        skillId: uuid(`${at}.skillId`, r.skillId) as string,
        snapshotName: free(`${at}.snapshotName`, r.snapshotName, AI_BOM_NAME_MAX_CHARS),
        snapshotDigest: d,
        snapshotVersion: int(`${at}.snapshotVersion`, r.snapshotVersion) as number,
        snapshotAdmissionState: oneOf(`${at}.snapshotAdmissionState`, r.snapshotAdmissionState, AI_BOM_SKILL_ADMISSION_STATES),
      };
    }),
    memoryStores: each("memoryStores", (r, at) => ({
      kind: oneOf(`${at}.kind`, r.kind, AI_BOM_MEMORY_STORE_KINDS),
      builderAgentId: uuid(`${at}.builderAgentId`, r.builderAgentId, true),
    })),
    releaseSboms: each("releaseSboms", (r, at) => {
      const kind = oneOf(`${at}.kind`, r.kind, RELEASE_SBOM_KINDS);
      if (!releaseSbomSerialSchema.safeParse(r.serialNumber).success) fail(`${at}.serialNumber: not a urn:uuid serial`);
      if (kind === "image" ? !releaseImageDigestSchema.safeParse(r.imageDigest).success : r.imageDigest !== null) fail(`${at}.imageDigest: set for the image SBOM only, as sha256:<hex>`);
      if (!releaseCommitSchema.safeParse(r.releaseCommit).success) fail(`${at}.releaseCommit: not a commit id`);
      const version = int(`${at}.version`, r.version) as number;
      if (version < 1) fail(`${at}.version: not positive`);
      return {
        kind,
        serialNumber: r.serialNumber as string,
        version,
        sha256: digest(`${at}.sha256`, r.sha256) as string,
        imageDigest: (r.imageDigest ?? null) as string | null,
        releaseCommit: r.releaseCommit as string,
        // R9: a verified signature (install time) or derived from the SBOM bytes (release build); nothing else
        identityBasis: oneOf(`${at}.identityBasis`, r.identityBasis, RELEASE_SBOM_IDENTITY_BASES),
      };
    }),
    devStackTools: each("devStackTools", (r, at) => {
      const t = aiDevStackToolSchema.safeParse(r);
      // name the field and the rule only, never the value (PR #287)
      if (!t.success) return fail(`${at}: ${t.error.issues.map(bomSafeIssue).join("; ")}`);
      return { ...t.data, dataShared: sortedStrings(t.data.dataShared) as AiDevStackTool["dataShared"], governedBy: sortedStrings(t.data.governedBy) };
    }),
  };
  for (const list of AI_BOM_INSTALL_ONLY_LISTS) {
    if (subjectKind !== "install" && (n[list]?.length ?? 0) > 0) fail(`${list}: only an install snapshot carries release records (B7)`);
  }
  const commits = new Set((n.releaseSboms ?? []).map((r) => r.releaseCommit));
  if (commits.size > 1) fail("releaseSboms: every SBOM identity must name the same release commit");
  return n;
}
