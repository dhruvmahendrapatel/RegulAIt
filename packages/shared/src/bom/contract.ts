/**
 * ADR-0189 (batch 6 item 2) — the Decision BOM and AI BOM CONTRACT (slice B1).
 *
 * What lives here, once, for every later slice and for the offline verifier:
 *  - the vocabularies (subject kinds, snapshot triggers, rendering formats,
 *    finality states, capture statuses, completeness states) that migration
 *    0182's CHECKs hold too;
 *  - the fixed canonical COLUMN PROJECTION of every row a decision binds
 *    (R5, R18, R26): ids, digests, enums, integers and times only, and the
 *    digest rule over that projection;
 *  - the zod schemas of `regulait.decision-facts.v1`, the addendum
 *    `regulait.decision-facts-addendum.v1`, the Decision BOM body
 *    `regulait.decision-bom.v1` and the AI BOM native body `regulait.ai-bom.v1`;
 *  - the canonical bytes (RFC 8785 via the pinned `canonicalize`, ADR-0176), the
 *    whole-document email scan (R10, R21), the endpoint shape (R47) and the
 *    v8 serial number derivation (amendment 5);
 *  - the route list, every route a 501 stub until its slice lands.
 *
 * Nothing here reads a clock, a database or the network.
 */
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { z } from "zod";

// ---------------------------------------------------------------------------
// versions (the `v` field is inside the signed bytes: domain separation, OWNER DECISION 2)
// ---------------------------------------------------------------------------

export const DECISION_BOM_VERSION = "regulait.decision-bom.v1";
export const AI_BOM_VERSION = "regulait.ai-bom.v1";
export const DECISION_FACTS_VERSION = "regulait.decision-facts.v1";
export const DECISION_FACTS_ADDENDUM_VERSION = "regulait.decision-facts-addendum.v1";
/** every `v` a BOM verifier accepts; anything else is refused (OWNER DECISION 2) */
export const BOM_BODY_VERSIONS = [DECISION_BOM_VERSION, AI_BOM_VERSION] as const;

/** the internal install subject key (R20): never exported as an identity */
export const AI_BOM_INSTALL_SUBJECT_ID = "00000000-0000-0000-0000-000000000000";

// ---------------------------------------------------------------------------
// vocabularies (migration 0182's CHECKs hold the same lists)
// ---------------------------------------------------------------------------

export const AI_BOM_SUBJECT_KINDS = ["use_case", "agent", "builder_agent", "install"] as const;
export type AiBomSubjectKind = (typeof AI_BOM_SUBJECT_KINDS)[number];

/** OWNER DECISION 8: the sign-off events that take an automatic snapshot, plus on demand */
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
export type AiBomSnapshotTrigger = (typeof AI_BOM_SNAPSHOT_TRIGGERS)[number];

export const BOM_RENDERING_FORMATS = ["cyclonedx-1.7", "cyclonedx-1.6", "spdx-3.0.1", "in-toto"] as const;
export type BomRenderingFormat = (typeof BOM_RENDERING_FORMATS)[number];

/**
 * R4, R44 and the #280 unbounded-retention policy, strictest first:
 *  - `anchored`: flushed to a destination OBSERVED tamper-resistant, timestamped
 *    when timestamps are required, and an Object Lock `retain_until` on or after
 *    the end of the decision's evidence retention;
 *  - `anchored_finite_lock`: the same, but the audit retention is UNBOUNDED, so no
 *    finite lock can cover it; the lock's `retain_until` is recorded and must
 *    still be in the future at freeze. Ranked BELOW `anchored` and NOT accepted by
 *    the strict default (ADR-0180); final only once an admin relaxes
 *    `decision_bom_finite_lock_finality` to `accept` (audited). The verifier
 *    reports `anchored_lapsed` once `retain_until` has passed;
 *  - `anchored_unverified_destination`: flushed, observation `false` or a lock
 *    shorter than the retention (an audited relaxation);
 *  - `chain_signed`: no anchor (an audited relaxation).
 */
export const DECISION_BOM_FINALITY_STATES = [
  "anchored",
  "anchored_finite_lock",
  "anchored_unverified_destination",
  "chain_signed",
] as const;
export type DecisionBomFinalityState = (typeof DECISION_BOM_FINALITY_STATES)[number];

/** the round-8 capture-status marker: every receipt-eligible decision has one */
export const DECISION_CAPTURE_STATUSES = ["captured", "capture_off"] as const;
export type DecisionCaptureStatus = (typeof DECISION_CAPTURE_STATUSES)[number];

/** per-section completeness (§2): a missing fact is never inferred */
export const BOM_SECTION_STATUSES = ["recorded", "not_applicable", "not_recorded"] as const;
export const BOM_NOT_RECORDED_REASONS = [
  "pre_identity",
  "pre_facts",
  "capture_off",
  "no_bound_row",
  "unsigned_addendum",
  "not_captured_by_path",
  "anchor_absent",
] as const;

export const DECISION_BOM_SECTIONS = [
  "decision",
  "receipt",
  "principal",
  "actors",
  "action",
  "policy",
  "model",
  "approval",
  "outcome",
  "cost",
  "trace",
  "proof",
] as const;
export type DecisionBomSection = (typeof DECISION_BOM_SECTIONS)[number];

/** the anchor observation modes recorded at flush (R4; `sink_constant` = a sink with no `observe()`) */
export const ANCHOR_OBSERVATION_MODES = [
  "compliance",
  "governance",
  "no_default_retention",
  "object_lock_absent",
  "unobserved",
  "sink_constant",
] as const;
export type AnchorObservationMode = (typeof ANCHOR_OBSERVATION_MODES)[number];

/** what a BOM retention hold is pinned to (R16: "no evidence hold covers it") */
export const BOM_RETENTION_HOLD_SCOPES = ["decision", "ai_bom_subject", "all"] as const;
export const BOM_RETENTION_HOLD_KINDS = ["legal", "incident", "regulator_request", "audit"] as const;

// ---------------------------------------------------------------------------
// primitive shapes
// ---------------------------------------------------------------------------

export const bomDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const bomUuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
/** ISO-8601 with milliseconds, UTC — exactly what `Date.toISOString` writes */
export const bomTimeSchema = z
  .string()
  .max(32)
  .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v, "an ISO-8601 UTC time with milliseconds");
/** an identifier: ids, enums, provider/model/tool names, rule ids. ASCII, no spaces, never prose. */
export const bomIdentifierSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:/@+#=-]+$/);
/** a safe JS integer (amendment 5: integers never exceed 2^53) */
export const bomIntSchema = z.number().int().safe();
/**
 * LINEAR shape checks for the delimited formats (CodeQL js/polynomial-redos): a
 * regex with a repeated group over caller input is replaced by a split on the
 * delimiter and one flat, anchored character-class test per part, after a
 * length cap. No nested or overlapping quantifier is applied to caller input.
 */
const SPIFFE_HOST = /^[a-z0-9.-]+$/;
const SPIFFE_SEGMENT = /^[A-Za-z0-9._~:@!$&'()*+,;=-]+$/;
export function isBomSpiffeId(value: string): boolean {
  if (value.length > 2048 || !value.startsWith("spiffe://")) return false;
  const rest = value.slice("spiffe://".length);
  const slash = rest.indexOf("/");
  if (slash < 1 || !SPIFFE_HOST.test(rest.slice(0, slash))) return false;
  return rest.slice(slash + 1).split("/").every((segment) => SPIFFE_SEGMENT.test(segment));
}
const OID_ARC = /^[0-9]+$/;
/** a dotted OID: `0`, `1` or `2`, then one or more numeric arcs */
export function isBomDottedOid(value: string): boolean {
  if (value.length > 256) return false;
  const [first, ...arcs] = value.split(".");
  return (first === "0" || first === "1" || first === "2") && arcs.length >= 1 && arcs.every((arc) => OID_ARC.test(arc));
}
export const bomSpiffeSchema = z.string().max(2048).refine(isBomSpiffeId, "a spiffe://trust-domain/path identifier");

// ---------------------------------------------------------------------------
// canonical bytes, digests, serial numbers
// ---------------------------------------------------------------------------

/**
 * The RFC 8785 bytes of a BOM body, facts payload or row projection (the pinned
 * `canonicalize`, ADR-0176; admitted byte-identical to `canonicalJson` for these
 * shapes by `bom.test.ts`). Throws on a value RFC 8785 cannot represent.
 */
export function bomCanonicalBytes(value: unknown): string {
  const out = canonicalize(value);
  if (typeof out !== "string") throw new TypeError("bomCanonicalBytes: the value has no canonical form");
  return out;
}
export const bomSha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
/** SHA-256 over the canonical bytes (the `facts_hash`, `body_sha256` and row digest rule) */
export const bomDigestOf = (value: unknown): string => bomSha256(bomCanonicalBytes(value));

/** amendment 5: the CycloneDX `serialNumber` is an RFC 9562 v8 UUID from SHA-256 of `regulait:ai-bom:<snapshot id>`.
 * Migration 0182's `regulait_ai_bom_serial()` computes the same value; a test pins that. */
export function aiBomSerialNumber(snapshotId: string): string {
  // lower-cased like Postgres's uuid::text, so an upper-case id derives the same serial as the database (F7)
  const h = createHash("sha256").update(`regulait:ai-bom:${snapshotId.toLowerCase()}`, "utf8").digest();
  h[6] = (h[6]! & 0x0f) | 0x80;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** R23: a stored double as its shortest round-trip decimal string (never a float in a signed body). */
export function bomCostString(value: number | null): string | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) throw new RangeError("bomCostString: a cost must be finite");
  // ECMAScript's shortest round-trip form: `Number(s) === value` for every finite double
  return String(Object.is(value, -0) ? 0 : value);
}

// ---------------------------------------------------------------------------
// R26 / issue #280 round 13: parsing `training_datasets.checksum`, fail closed
// ---------------------------------------------------------------------------

/** the longest row-count digit string accepted (2^53 - 1 has 16 digits) */
export const TRAINING_CHECKSUM_MAX_COUNT_DIGITS = 16;
export type ParsedTrainingChecksum =
  /** `sha256:<64 hex>:<count>` (`datasetChecksum`): a real SHA-256 plus `regulait:dataset:rowCount` */
  | { kind: "sha256"; sha256: string; rowCount: number }
  /** a retained pre-0176 `fnv1a32:` value: never relabelled as SHA-256; a property only, composition incomplete */
  | { kind: "legacy"; value: string }
  /** the column default: no hash (not a hash of nothing); composition incomplete */
  | { kind: "empty" };
export class TrainingChecksumError extends Error {
  constructor(message: string) {
    super(`training_datasets.checksum: ${message}`);
    this.name = "TrainingChecksumError";
  }
}
/**
 * R26 with round 13's rule: the count is digits only, at most 16 of them, and a
 * SAFE integer (no rounding above 2^53, no Infinity); when the stored
 * `row_count` is known it must equal the checksum's count. Anything else is
 * refused, never coerced.
 */
export function parseTrainingDatasetChecksum(checksum: string, storedRowCount?: number | null): ParsedTrainingChecksum {
  if (checksum === "") return { kind: "empty" };
  if (/^fnv1a32:[0-9a-f]{8}$/.test(checksum)) return { kind: "legacy", value: checksum };
  const m = /^sha256:([0-9a-f]{64}):([0-9]+)$/.exec(checksum);
  if (!m) throw new TrainingChecksumError("not sha256:<64 hex>:<count>, fnv1a32:<8 hex> or empty");
  const digits = m[2]!;
  if (digits.length > TRAINING_CHECKSUM_MAX_COUNT_DIGITS) throw new TrainingChecksumError("row count has too many digits");
  if (digits.length > 1 && digits.startsWith("0")) throw new TrainingChecksumError("row count has a leading zero");
  const rowCount = Number(digits);
  if (!Number.isSafeInteger(rowCount)) throw new TrainingChecksumError("row count is not a safe integer");
  if (storedRowCount !== undefined && storedRowCount !== null && storedRowCount !== rowCount) {
    throw new TrainingChecksumError("row count disagrees with the stored row_count");
  }
  return { kind: "sha256", sha256: m[1]!, rowCount };
}

// ---------------------------------------------------------------------------
// R10 / R21: the whole-document email scan (keys and values); fail closed
// ---------------------------------------------------------------------------

/**
 * An email shape: at least one local-part character immediately before an `@`,
 * and a dotted domain immediately after it. Checked in LINEAR time (CodeQL
 * js/polynomial-redos on the earlier unanchored regex): each `@` is visited
 * once, and the domain is matched with a sticky regex whose runs are separated
 * by literal dots, so it cannot backtrack across positions. The domain is now a
 * hand scan by code unit (no regex): CodeQL flagged the sticky domain regex too.
 */
const EMAIL_LOCAL_CHAR = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]$/;
/** a domain-label character `[A-Za-z0-9-]`, by code unit (no regex) */
const isLabelChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45;
export function hasEmailShape(text: string): boolean {
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (at === 0 || !EMAIL_LOCAL_CHAR.test(text[at - 1]!)) continue;
    // a dotted domain follows iff: one or more label characters, a dot, and one more label character
    let i = at + 1;
    while (i < text.length && isLabelChar(text.charCodeAt(i))) i += 1;
    if (i > at + 1 && text.charCodeAt(i) === 46 && i + 1 < text.length && isLabelChar(text.charCodeAt(i + 1))) return true;
  }
  return false;
}

/** every JSON path whose key or string value holds an email shape; empty means clean */
export function findEmailShapes(value: unknown, at = "$"): string[] {
  const out: string[] = [];
  const walk = (v: unknown, p: string) => {
    if (typeof v === "string") {
      if (hasEmailShape(v)) out.push(p);
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${p}[${i}]`));
    } else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (hasEmailShape(k)) out.push(`${p}{key}`);
        walk(x, `${p}.${k}`);
      }
    }
  };
  walk(value, at);
  return out;
}

// ---------------------------------------------------------------------------
// R47: an exported endpoint is scheme, host, port and path only
// ---------------------------------------------------------------------------

const ENDPOINT_SCHEME = /^(?:https|http|wss|ws):\/\//;
const ENDPOINT_HOST = /^[A-Za-z0-9.-]+$/;
const ENDPOINT_PORT = /^[0-9]{1,5}$/;
const ENDPOINT_SEGMENT = /^[A-Za-z0-9._~!$&'()*+,;=:%-]*$/;
/** no userinfo, no query, no fragment; the path is plain URL characters (a linear split, no nested quantifier) */
export function isBomExportEndpoint(value: string): boolean {
  if (value.length > 2048) return false;
  const scheme = ENDPOINT_SCHEME.exec(value);
  if (!scheme) return false;
  const rest = value.slice(scheme[0].length);
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const colon = authority.indexOf(":");
  const host = colon === -1 ? authority : authority.slice(0, colon);
  if (!ENDPOINT_HOST.test(host) || (colon !== -1 && !ENDPOINT_PORT.test(authority.slice(colon + 1)))) return false;
  return slash === -1 || rest.slice(slash + 1).split("/").every((segment) => ENDPOINT_SEGMENT.test(segment));
}
export const bomEndpointSchema = z.string().max(2048).refine(isBomExportEndpoint, "scheme://host[:port]/path only");

// ---------------------------------------------------------------------------
// R5 / R18 / R26: the fixed canonical column projection of every bound row
// ---------------------------------------------------------------------------

/**
 * THE PROJECTIONS. Keys are the drizzle field names of the `packages/db` tables;
 * every listed column is an id, digest, enum, integer, boolean or time. Free
 * text (reasons, previews, names, signed payloads, attributes, detail) is never
 * listed. `eval_cases` is DIGEST-ONLY (R26): its projection is hashed by the
 * loader and never leaves the boundary.
 */
export const BOM_ROW_PROJECTIONS = {
  approvals: [
    "id", "objectType", "serverId", "toolName", "ruleId", "connectorId", "projectId", "approverUserId",
    "namedApproverUserId", "approverRoleId", "status", "requestedAt", "decidedBy", "decidedAt", "argumentsDigest",
    "contextDigest", "approvalScope", "quorum", "signatureMode", "expiresAt",
  ],
  approval_decisions: [
    "id", "approvalId", "deciderUserId", "principalUserId", "decision", "stepUpMethod", "credentialId",
    "signedDigest", "counterBefore", "decidedAt",
  ],
  usage_events: [
    "id", "at", "userId", "objectType", "agentId", "requestedAgentId", "connectorId", "operation", "provider", "model",
    "servedModel", "inputTokens", "outputTokens", "costUsd", "refusal", "projectId", "configVersionId",
    "configVersion", "configCanary", "agentConfigVersionId", "agentConfigVersion", "actorIdentityId",
    "delegationGrantId",
  ],
  trace_spans: [
    "id", "traceId", "parentSpanId", "seq", "kind", "status", "startedAt", "endedAt", "durationMs", "usageEventId",
    "auditLogId", "agentId", "mcpServerId", "connectorId", "provider", "model", "inputTokens", "outputTokens",
    "costUsd", "contentWithheld", "actorIdentityId", "delegationGrantId",
  ],
  delegation_grants: [
    "id", "rootGrantId", "parentGrantId", "path", "depth", "sponsorUserId", "actorIdentityId", "scope", "capMicros",
    "environment", "audience", "authCredentialId", "bindingKind", "bindingThumbprint", "expiresAt", "revokedAt",
    "createdAt",
  ],
  issued_tokens: [
    "jti", "grantId", "authCredentialId", "signingKid", "bindingKind", "bindingThumbprint", "audience", "env",
    "issuedAt", "expiresAt",
  ],
  workload_identities: ["id", "kind", "agentId", "builderAgentId", "engineRunnerId", "identifier", "status", "grantsRevision"],
  eval_cases: [
    "id", "datasetId", "datasetVersion", "input", "expected", "rubric", "context", "contextInPrompt", "tags",
    "scorerKind", "scorerConfig",
  ],
} as const satisfies Record<string, readonly string[]>;
export type BomProjectedTable = keyof typeof BOM_ROW_PROJECTIONS;
export const BOM_PROJECTED_TABLES = Object.keys(BOM_ROW_PROJECTIONS) as BomProjectedTable[];
/** the tables whose projection may appear inside a BOM (eval_cases is digest-only) */
export const BOM_BOUND_TABLES = BOM_PROJECTED_TABLES.filter((t) => t !== "eval_cases") as Exclude<BomProjectedTable, "eval_cases">[];
/** columns holding a double (`cost_usd`): projected as a lossless decimal string (R23) */
const DOUBLE_COLUMNS = new Set(["costUsd"]);

type ProjectionValue = string | number | boolean | null | ProjectionValue[] | { [k: string]: ProjectionValue };

function projectValue(column: string, value: unknown): ProjectionValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (DOUBLE_COLUMNS.has(column) && typeof value === "number") return bomCostString(value);
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError(`${column}: integer above 2^53`);
    return Number(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new RangeError(`${column}: only safe integers are projected (doubles are strings)`);
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  // jsonb columns (`scope`, eval case bodies) and arrays (`path`): canonicalised as they are
  return JSON.parse(bomCanonicalBytes(value)) as ProjectionValue;
}

/** the fixed projection of one row: exactly the listed columns, absent ones as null */
export function projectBomRow(table: BomProjectedTable, row: Record<string, unknown>): Record<string, ProjectionValue> {
  const out: Record<string, ProjectionValue> = {};
  for (const column of BOM_ROW_PROJECTIONS[table]) out[column] = projectValue(column, row[column]);
  return out;
}
/** SHA-256 over the canonical bytes of `{table, projection}` (R5: one rule, defined once) */
export const bomRowDigest = (table: BomProjectedTable, projection: Record<string, unknown>): string =>
  bomDigestOf({ table, projection });
/** R26: the digest of an evaluation dataset version = SHA-256 over the canonical array of its cases' projections, by case id */
export function evalCasesDigest(cases: Array<Record<string, unknown>>): string {
  const projected = cases.map((c) => projectBomRow("eval_cases", c));
  projected.sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  return bomDigestOf(projected);
}

const projectionScalar: z.ZodType<ProjectionValue> = z.lazy(() =>
  z.union([
    z.string().max(4096),
    bomIntSchema,
    z.boolean(),
    z.null(),
    z.array(projectionScalar).max(256),
    z.record(z.string().max(128), projectionScalar),
  ]),
);
/** a bound row inside facts or an addendum: its table, id, projection and digest (R18) */
export const boundRowSchema = z
  .object({
    table: z.enum(BOM_BOUND_TABLES as [Exclude<BomProjectedTable, "eval_cases">, ...Exclude<BomProjectedTable, "eval_cases">[]]),
    id: z.string().min(1).max(256),
    projection: z.record(z.string(), projectionScalar),
    digest: bomDigestSchema,
  })
  .strict()
  .superRefine((row, ctx) => {
    const want = BOM_ROW_PROJECTIONS[row.table] as readonly string[];
    const have = Object.keys(row.projection);
    if (have.length !== want.length || want.some((c) => !(c in row.projection))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `projection of ${row.table} is not its fixed column list` });
    } else if (bomRowDigest(row.table, row.projection) !== row.digest) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `digest of ${row.table} ${row.id} does not match its projection` });
    }
  });
export type BoundRow = z.infer<typeof boundRowSchema>;

// ---------------------------------------------------------------------------
// regulait.decision-facts.v1 (§4, R5, R18, R37) and the addendum (R15, R35)
// ---------------------------------------------------------------------------

/**
 * F5: the JSON shapes the SQL canonicaliser (0162 `regulait_canonical_json`)
 * and RFC 8785 serialise identically: safe integers only (no fractions, no
 * exponents, nothing above 2^53) and printable-ASCII object keys. Migration
 * 0182's `regulait_bom_json_safe` holds the same rule on stored facts.
 */
export function bomJsonSafeIssues(value: unknown, at = "$"): string[] {
  const out: string[] = [];
  const walk = (v: unknown, p: string) => {
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v) || Object.is(v, -0)) out.push(`${p}: not a safe integer`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (!/^[\x20-\x7e]*$/.test(k)) out.push(`${p}: key is not printable ASCII`);
        walk(x, `${p}.${k}`);
      }
    }
  };
  walk(value, at);
  return out;
}
const jsonSafe = (value: unknown, ctx: z.RefinementCtx) => {
  for (const issue of bomJsonSafeIssues(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
};

const nullableId = bomIdentifierSchema.nullable();
const nullableUuid = bomUuidSchema.nullable();
export const DECISION_INPUT_KINDS = ["prompt_commit", "dataset_version", "eval_dataset_version", "model_artifact", "config_version", "skill"] as const;

export const decisionActionFactsSchema = z
  .object({
    argumentsDigest: bomDigestSchema.nullable(),
    contextDigest: bomDigestSchema.nullable(),
    target: z
      .object({
        kind: z.enum(["mcp_tool", "connector", "agent", "approval"]),
        serverId: nullableUuid,
        toolName: nullableId,
        toolNameHash: bomDigestSchema.nullable(),
        connectorId: nullableUuid,
        agentId: nullableUuid,
      })
      .strict(),
    inputs: z
      .array(z.object({ kind: z.enum(DECISION_INPUT_KINDS), id: bomIdentifierSchema, digest: bomDigestSchema.nullable(), classification: nullableId }).strict())
      .max(256),
    dataSensitivity: nullableId,
    complianceTags: z.array(bomIdentifierSchema).max(64),
  })
  .strict();

export const decisionPolicyFactsSchema = z
  .object({
    governancePolicyEpoch: bomIntSchema.nullable(),
    abacPolicyVersions: z.array(z.object({ id: bomIdentifierSchema, schemaVersion: bomIntSchema }).strict()).max(256),
    configVersions: z.array(z.object({ id: bomUuidSchema, version: bomIntSchema.nullable(), canary: z.boolean() }).strict()).max(64),
    guardrailConfigDigest: bomDigestSchema.nullable(),
    modelPolicyRuleIds: z.array(bomIdentifierSchema).max(256),
    killSwitch: z.enum(["off", "engaged"]).nullable(),
  })
  .strict();

export const decisionModelFactsSchema = z
  .object({
    agentId: nullableUuid,
    provider: nullableId,
    requestedModel: nullableId,
    servedModel: nullableId,
    pinnedModelVersion: nullableId,
    modelCardId: nullableUuid,
    modelCardApprovalId: nullableUuid,
    aiBomSnapshotId: nullableUuid,
  })
  .strict();

export const decisionActorFactsSchema = z
  .object({
    sponsorUserId: bomUuidSchema,
    actorIdentityId: nullableUuid,
    delegationGrantId: nullableUuid,
    /** root first (ADR-0188 decision 25): workload identity URIs */
    actorChain: z.array(bomSpiffeSchema).max(16),
  })
  .strict();

export const decisionOutcomeFactsSchema = z
  .object({
    effect: z.enum(["allow", "deny", "require_approval"]),
    refusalCode: nullableId,
    upstreamStatusClass: z.enum(["1xx", "2xx", "3xx", "4xx", "5xx", "none"]).nullable(),
  })
  .strict();

const rowsHaveDistinctIds = (rows: BoundRow[]) => new Set(rows.map((r) => `${r.table}\u0000${r.id}`)).size === rows.length;

export const decisionFactsSchema = z
  .object({
    v: z.literal(DECISION_FACTS_VERSION),
    auditId: bomUuidSchema,
    auditSeq: bomIntSchema.positive(),
    action: decisionActionFactsSchema.nullable(),
    policy: decisionPolicyFactsSchema.nullable(),
    model: decisionModelFactsSchema.nullable(),
    /** null before ADR-0188's audit v2 boundary (`actors: not_recorded, reason: pre_identity`) */
    actors: decisionActorFactsSchema.nullable(),
    outcome: decisionOutcomeFactsSchema,
    rows: z.array(boundRowSchema).max(512).refine(rowsHaveDistinctIds, "a row is bound at most once"),
  })
  .strict()
  .superRefine(jsonSafe);
export type DecisionFacts = z.infer<typeof decisionFactsSchema>;

export const decisionFactsAddendumSchema = z
  .object({
    v: z.literal(DECISION_FACTS_ADDENDUM_VERSION),
    auditId: bomUuidSchema,
    n: bomIntSchema.positive(),
    /** the previous addendum's `facts_hash`, or the decision's own for n = 1 (R35) */
    prev: bomDigestSchema,
    rows: z.array(boundRowSchema).max(512).refine(rowsHaveDistinctIds, "a row is bound at most once"),
    postActionVerification: z.object({ result: z.enum(["passed", "failed", "inconclusive"]), stageId: nullableId }).strict().nullable(),
  })
  .strict()
  .superRefine(jsonSafe);
export type DecisionFactsAddendum = z.infer<typeof decisionFactsAddendumSchema>;

// ---------------------------------------------------------------------------
// regulait.decision-bom.v1 (§2, R1, R4, R33, R37, R44, R45, R48)
// ---------------------------------------------------------------------------

const completenessEntry = z
  .object({ status: z.enum(BOM_SECTION_STATUSES), reason: z.enum(BOM_NOT_RECORDED_REASONS).optional() })
  .strict()
  .refine((e) => (e.status === "not_recorded") === (e.reason !== undefined), "a reason exactly when not_recorded");

const chainRowSchema = z
  .object({ seq: bomIntSchema.positive(), contentHash: bomDigestSchema, prevHash: bomDigestSchema, rowHash: bomDigestSchema })
  .strict();

/** R1: the complete canonical anchor record, exactly as stored, plus R4/R33/R44's recorded facts */
export const decisionBomAnchorSchema = z
  .object({
    id: bomUuidSchema,
    record: z
      .object({
        seq: bomIntSchema.positive(),
        rowHash: bomDigestSchema,
        headAt: bomTimeSchema,
        algorithm: bomIdentifierSchema,
        payloadVersion: bomIntSchema,
        capturedAt: bomTimeSchema,
      })
      .strict(),
    destination: z.enum(["local_worm", "s3_object_lock", "external_log", "none"]),
    status: z.enum(["pending", "flushed", "failed"]),
    externalRef: z.string().max(2048).nullable(),
    flushedAt: bomTimeSchema.nullable(),
    tamperResistant: z.boolean(),
    observationMode: z.enum(ANCHOR_OBSERVATION_MODES).nullable(),
    observedAt: bomTimeSchema.nullable(),
    retainUntil: bomTimeSchema.nullable(),
    tsa: z
      .object({
        token: z.string().max(65536).regex(/^[A-Za-z0-9+/=]+$/),
        genTime: bomTimeSchema,
        messageImprint: bomDigestSchema,
        policyOid: z.string().max(256).refine(isBomDottedOid, "a dotted OID").nullable(),
        nonce: z.string().regex(/^[0-9a-f]{1,64}$/).nullable(),
        requestSentAt: bomTimeSchema.nullable(),
        /** #280: a token granted before `tsa_request_sent_at` existed; the verifier says `request_facts_not_recorded` */
        requestFactsLegacy: z.boolean(),
      })
      .strict()
      .refine((t) => t.requestFactsLegacy || (t.nonce !== null && t.requestSentAt !== null), "request facts recorded unless legacy")
      .nullable(),
  })
  .strict();

export const decisionBomBodySchema = z
  .object({
    v: z.literal(DECISION_BOM_VERSION),
    id: bomUuidSchema,
    auditId: bomUuidSchema,
    version: bomIntSchema.positive(),
    supersedes: bomUuidSchema.nullable(),
    finality: z.enum(DECISION_BOM_FINALITY_STATES),
    decision: z
      .object({
        auditSeq: bomIntSchema.positive(),
        at: bomTimeSchema,
        objectType: bomIdentifierSchema,
        objectId: z.string().max(256).nullable(),
        serverId: nullableUuid,
        toolName: nullableId,
        effect: z.enum(["allow", "deny", "require_approval"]),
        ruleId: nullableId,
        ruleChain: z.array(bomIdentifierSchema).max(64),
      })
      .strict(),
    /** R48: the receipt EXACTLY as stored (canonical payload bytes, signature, key id), v1 and v2 alike */
    receipt: z
      .object({
        receiptSeq: bomIntSchema.positive(),
        payloadHash: bomDigestSchema,
        keyId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
        payload: z.string().max(65536),
        signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
      })
      .strict()
      .refine((r) => bomSha256(r.payload) === r.payloadHash, "payloadHash is SHA-256 of the payload bytes"),
    /** R45: ids only, always */
    principal: z.object({ sponsorUserId: bomUuidSchema }).strict(),
    actors: decisionActorFactsSchema.nullable(),
    action: decisionActionFactsSchema.nullable(),
    policy: decisionPolicyFactsSchema.nullable(),
    model: decisionModelFactsSchema.nullable(),
    approval: z.array(boundRowSchema).max(64).nullable(),
    outcome: decisionOutcomeFactsSchema.nullable(),
    cost: z
      .object({ usageEventIds: z.array(bomUuidSchema).max(64), inputTokens: bomIntSchema, outputTokens: bomIntSchema, costUsd: z.string().regex(/^-?[0-9.e+-]+$/).nullable(), costSource: z.literal("usage_events.cost_usd") })
      .strict()
      .nullable(),
    trace: z.object({ traceIds: z.array(bomUuidSchema).max(64), spanIds: z.array(bomUuidSchema).max(1024) }).strict().nullable(),
    proof: z
      .object({ chain: z.array(chainRowSchema).min(1).max(100000), anchor: decisionBomAnchorSchema.nullable() })
      .strict(),
    /** R37: the exact canonical bytes the receipt's factsHash and the addendum chain are checked against */
    facts: z
      .object({
        payload: z.string().max(1_048_576).nullable(),
        addenda: z
          .array(
            z
              .object({ n: bomIntSchema.positive(), prevHash: bomDigestSchema, payload: z.string().max(1_048_576), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/), keyId: z.string().min(1).max(128) })
              .strict(),
          )
          .max(1024),
      })
      .strict(),
    completeness: z.object(Object.fromEntries(DECISION_BOM_SECTIONS.map((s) => [s, completenessEntry])) as Record<DecisionBomSection, typeof completenessEntry>).strict(),
    basis: z
      .object({ auditSeq: bomIntSchema.positive(), anchorId: nullableUuid, receiptSeq: bomIntSchema.positive(), aiBomSnapshotId: nullableUuid })
      .strict(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if ((body.version === 1) !== (body.supersedes === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "supersedes is set exactly when version > 1" });
    }
    // a section with no value is never `recorded`; a recorded section has a value (nothing is inferred)
    for (const s of ["actors", "action", "policy", "model", "approval", "outcome", "cost", "trace"] as const) {
      const recorded = body.completeness[s].status === "recorded";
      if (recorded !== (body[s] !== null)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["completeness", s], message: `${s}: recorded exactly when present` });
      }
    }
    if (body.proof.anchor === null && body.finality !== "chain_signed") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["finality"], message: "only chain_signed has no anchor" });
    }
    const last = body.proof.chain[body.proof.chain.length - 1]!;
    if (body.proof.anchor && (body.proof.anchor.record.seq !== last.seq || body.proof.anchor.record.rowHash !== last.rowHash)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["proof"], message: "the anchor covers the last row of the segment" });
    }
    if (body.proof.chain[0]!.seq !== body.decision.auditSeq) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["proof"], message: "the segment starts at the decision row" });
    }
    const emails = findEmailShapes(body);
    if (emails.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `email-shaped value at ${emails.join(", ")}` });
  });
export type DecisionBomBody = z.infer<typeof decisionBomBodySchema>;

// ---------------------------------------------------------------------------
// regulait.ai-bom.v1, the signed native body (§3, R2, R3, R19, R22, R27)
// ---------------------------------------------------------------------------

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string().max(65536), bomIntSchema, z.boolean(), z.null(), z.array(jsonValue).max(4096), z.record(z.string().max(256), jsonValue)]),
);

const renderingEntry = z.union([
  z.object({ status: z.literal("rendered"), sha256: bomDigestSchema, bytes: bomIntSchema.positive(), validator: z.string().min(1).max(256) }).strict(),
  /** R3: a format the standard cannot express without inventing a value */
  z.object({ status: z.literal("not_producible"), missing: z.array(bomIdentifierSchema).min(1).max(64) }).strict(),
]);

export const aiBomNativeBodySchema = z
  .object({
    v: z.literal(AI_BOM_VERSION),
    snapshot: z
      .object({
        id: bomUuidSchema,
        subjectKind: z.enum(AI_BOM_SUBJECT_KINDS),
        subjectId: bomUuidSchema,
        version: bomIntSchema.positive(),
        supersedes: bomUuidSchema.nullable(),
        trigger: z.enum(AI_BOM_SNAPSHOT_TRIGGERS),
        createdAt: bomTimeSchema,
        /** R22: each loaded row's table, id and the SHA-256 of its canonical projection */
        basis: z.array(z.object({ table: bomIdentifierSchema, id: z.string().min(1).max(256), sha256: bomDigestSchema }).strict()).max(100000),
      })
      .strict(),
    serialNumber: z.string().regex(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    /** the subject's own record, by kind (R31); B3 fixes the per-kind field lists */
    subject: z.record(z.string().max(128), jsonValue),
    /** the normalised record set the renderings were built from; B3 fixes the per-type allowlists */
    records: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9:]*$/), z.array(z.record(z.string().max(128), jsonValue)).max(100000)),
    /** every member the build could not fully describe (R24, R26, R27, R29, R30, R3) */
    unrecorded: z.array(z.object({ ref: z.string().min(1).max(512), field: bomIdentifierSchema, reason: bomIdentifierSchema }).strict()).max(100000),
    compositions: z
      .array(z.object({ aggregate: z.enum(["complete", "incomplete", "unknown"]), assemblies: z.array(z.string().min(1).max(512)).max(100000) }).strict())
      .max(1024),
    renderings: z.record(z.enum(BOM_RENDERING_FORMATS), renderingEntry),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.serialNumber !== `urn:uuid:${aiBomSerialNumber(body.snapshot.id)}`) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["serialNumber"], message: "the serial number is derived from the snapshot id" });
    }
    if (body.snapshot.subjectKind === "install" && body.snapshot.subjectId !== AI_BOM_INSTALL_SUBJECT_ID) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["snapshot", "subjectId"], message: "the install subject key is the nil uuid (R20)" });
    }
    if ((body.snapshot.version === 1) !== (body.snapshot.supersedes === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["snapshot"], message: "supersedes is set exactly when version > 1" });
    }
    // INVARIANT: never `complete` with an unrecorded member (not relaxable)
    const gaps = new Set(body.unrecorded.map((u) => u.ref));
    body.compositions.forEach((c, i) => {
      if (c.aggregate === "complete" && c.assemblies.some((a) => gaps.has(a))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["compositions", i], message: "a complete composition has an unrecorded member" });
      }
    });
    // INVARIANT: no email anywhere, keys included (R10)
    const emails = findEmailShapes(body);
    if (emails.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `email-shaped value at ${emails.join(", ")}` });
    // INVARIANT: an exported endpoint carries no userinfo, query or fragment (R47)
    const walk = (v: unknown, p: string) => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
      else if (v !== null && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          const urls = typeof x === "string" ? [x] : Array.isArray(x) && x.every((e) => typeof e === "string") ? (x as string[]) : null;
          if ((k === "url" || k === "endpoint" || k === "endpoints") && urls) {
            for (const e of urls) {
              if (!bomEndpointSchema.safeParse(e).success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `endpoint at ${p}.${k} is not scheme://host[:port]/path` });
            }
          } else walk(x, `${p}.${k}`);
        }
      }
    };
    walk(body.records, "$.records");
    walk(body.subject, "$.subject");
  });
export type AiBomNativeBody = z.infer<typeof aiBomNativeBodySchema>;

// ---------------------------------------------------------------------------
// routes (§9): every one a 501 stub in B1; all admin-only until B4 adds the
// in-handler `bom_export_roles` check (the auditor grant)
// ---------------------------------------------------------------------------

export const BOM_NOT_BUILT = { error: "not_built" } as const;
export const BOM_ERROR_CODES = [
  "not_built",
  "bom_signing_unavailable",
  "bom_anchor_pending",
  "bom_snapshots_not_released",
  "format_not_rendered_for_snapshot",
  "bom_export_forbidden",
] as const;

export const BOM_ROUTES = [
  "POST /v1/ai-bom/:subjectKind/:subjectId/snapshots",
  "GET /v1/ai-bom/:subjectKind/:subjectId/snapshots",
  "GET /v1/ai-bom/:subjectKind/:subjectId/drift",
  "GET /v1/ai-bom/snapshots/:snapshotId",
  "GET /v1/ai-bom/snapshots/:snapshotId/bundle",
  "GET /v1/decisions/:auditId/bom",
  "GET /v1/decisions/:auditId/bom/bundle",
  "POST /v1/boms/verify",
] as const;
export type BomRoute = (typeof BOM_ROUTES)[number];
