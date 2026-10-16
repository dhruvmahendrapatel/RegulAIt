/**
 * ADR-0189 slice B2 — DECISION FACT CAPTURE (the pure half).
 *
 * §4: every receipt-eligible decision writes `regulait.decision-facts.v2` (ADR-0190 I8; v1 before it) in its
 * own transaction. Round-10 entry condition 4237346656: fact and capture-status
 * capture sit behind ONE shared, transaction-aware audit writer used by every
 * `receiptClass: "decision"` writer. That writer is `appendChainedAuditRows`
 * (`packages/db/src/audit-chain.ts`), the single chokepoint every
 * `insert(auditLog)` already passes through; it calls `captureDecisionFacts`
 * (`packages/db/src/decision-facts.ts`), which loads the rows this file names and
 * hands them back here. Nothing in this file reads a clock, a database or the
 * network.
 *
 * WHAT IS CAPTURED, AND FROM WHERE (every value has a source or is null):
 *  - `actors` (R18, ADR-0188 decision 9): from the audit row's own COLUMNS
 *    (`actor_identity_id`, `delegation_grant_id`, `actor_chain`), only on a row
 *    written under audit v2 (`chain_version = 2`), because only there does the
 *    content hash cover them. A v1 row has `actors: null` (B4 reports
 *    `not_recorded`, `pre_identity`). The chain's identity ids are mapped to
 *    their workload identity URIs, and the leaf grant and every identity are
 *    bound by projection (R18).
 *  - `action`: the target from the audit row's columns; `argumentsDigest` and
 *    `contextDigest` only where the path recorded them on the row (ADR-0104,
 *    ADR-0105; open question 7: a path that never computes the digest records
 *    null); `complianceTags` from the attributed project's classifications, read
 *    in the decision's transaction. `dataSensitivity` is null: projects have no
 *    such column. `inputs` is null (NOT RECORDED): no path records its inputs, and
 *    `[]` would claim "none".
 *  - `policy`: recorded where the path wrote, on the decision row, the
 *    governance policy epoch it decided under (`detail.policyEpoch`, the
 *    `advance_governance_policy_epoch` generation) and the kill-switch state it
 *    decided under (`detail.killSwitch`): the MCP tool, MCP protocol and
 *    connector paths. Every list the path does not record is null (NOT
 *    RECORDED), never `[]`; the ABAC versions cannot be held at all while the
 *    contract's `schemaVersion` is an integer and `abac_policy_versions.schema_version`
 *    is text. A path that records no epoch has `policy: null`
 *    (`not_captured_by_path`).
 *  - `model`: for an `agent` decision, the agent id only; every other field is
 *    null (unknown at decision time), never filled from a live read.
 *  - `outcome`: the row's `effect`; the refusal code and upstream status class
 *    are not known when the decision row is written (null).
 *  - `rows` (R5, R18): the approval a row names (`detail.approvalId`,
 *    `detail.approvedApprovalId`) with every `approval_decisions` row it has at
 *    that point, the leaf delegation grant and the chain's workload identities.
 *    Usage events and spans are written after the decision and belong to addenda.
 *  - `execution` (ADR-0190 decision 9, slice I8): the decision's `execution_placements` row, read in the same
 *    transaction (it is written there before the facts), with its profile, executor and attestation references;
 *    without one, `in_gateway` for a model or connector call, `external` for a remote MCP server, and null (NOT
 *    RECORDED) for a stdio call, an unknown server or an approval (`buildExecutionFacts`).
 *
 * A value the contract cannot represent truthfully makes its whole section null
 * rather than a guess (an unrepresentable compliance tag, a project that is
 * gone). A broken actor chain (an identity or grant the row names that does not
 * exist, or a non-SPIFFE identifier) FAILS the capture, and with it the
 * decision's transaction: the facts of an agent's decision are never silently
 * dropped (fail closed, ADR-0180).
 */
import { createHash } from "node:crypto";
import { RECEIPT_OBJECT_TYPES } from "../batch4.js";
import {
  bomDigestOf,
  bomIdentifierSchema,
  bomJsonSafeIssues,
  bomRowDigest,
  bomUuidSchema,
  DECISION_FACTS_CURRENT_VERSION,
  decisionFactsV2Schema,
  isBomSpiffeId,
  projectBomRow,
  type BomProjectedTable,
  type BoundRow,
  type DecisionExecutionFacts,
  type DecisionFacts,
} from "./contract.js";

/** the columns of a chained audit row that capture reads (the stored, scrubbed values) */
export interface DecisionAuditRow {
  id: string;
  seq: number;
  at: Date;
  userId: string;
  objectType: string;
  objectId: string | null;
  serverId: string | null;
  toolName: string | null;
  effect: string;
  detail: unknown;
  actorIdentityId: string | null;
  delegationGrantId: string | null;
  actorChain: string[] | null;
  chainVersion: number | null;
}

const RECEIPT_TYPES: ReadonlySet<string> = new Set(RECEIPT_OBJECT_TYPES);
const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * THE receipt-eligibility predicate (ADR-0186 R): a receipt object type and
 * `detail.receiptClass = "decision"`. The receipt sweep's SQL filter
 * (`decision-receipts.ts`) and migration 0189's commit-time guard state the same
 * test; `zz-adr0189-b2-facts.test.ts` pins that the three agree.
 */
export function isReceiptEligibleAuditRow(row: { objectType: string | null | undefined; detail: unknown }): boolean {
  return typeof row.objectType === "string" && RECEIPT_TYPES.has(row.objectType) && asRecord(row.detail)?.receiptClass === "decision";
}

/**
 * The composed audit retention in days (null = unbounded, keep everything): the
 * longest compliance-profile retention and the org default, the larger winning.
 * ONE rule, shared by the gateway's retention floor (`org-settings.ts`) and the
 * capture's common `expires_at` (round-8 entry condition 4237322627).
 */
export function composeAuditRetentionDays(profileDays: ReadonlyArray<number | null>, orgDays: number | null): number | null {
  const known = profileDays.filter((d): d is number => d !== null && d !== undefined);
  const profileFloor = known.length ? known.reduce((m, d) => Math.max(m, d), 0) : null;
  if (profileFloor !== null && orgDays !== null) return Math.max(profileFloor, orgDays);
  return profileFloor ?? orgDays;
}

const isUuid = (v: unknown): v is string => typeof v === "string" && bomUuidSchema.safeParse(v).success;
const isDigest = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const isIdentifier = (v: unknown): v is string => typeof v === "string" && bomIdentifierSchema.safeParse(v).success;
const isEpoch = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** what a decision row asks the loader to read in its own transaction */
export interface DecisionFactRefs {
  projectId: string | null;
  approvalIds: string[];
  grantId: string | null;
  identityIds: string[];
  /** ADR-0190 I8: an MCP tool decision's server, whose transport says remote (`external`) or stdio (placed) */
  mcpServerId: string | null;
}

/** the ids a row's facts need; only the audit row decides them (never the request) */
export function decisionFactRefs(row: DecisionAuditRow): DecisionFactRefs {
  const detail = asRecord(row.detail) ?? {};
  const approvalIds = [...new Set([detail.approvalId, detail.approvedApprovalId].filter(isUuid))];
  const v2Actor = row.chainVersion === 2 && row.actorIdentityId !== null;
  return {
    projectId: isUuid(detail.projectId) ? detail.projectId : null,
    approvalIds,
    grantId: v2Actor && isUuid(row.delegationGrantId) ? row.delegationGrantId : null,
    identityIds: v2Actor ? [...new Set(row.actorChain ?? [])] : [],
    mcpServerId: row.objectType === "mcp_tool" && isUuid(row.serverId) ? row.serverId : null,
  };
}

/**
 * ADR-0190 I8: the placement of one decision, read in the decision's own transaction. The I4/I8 contract: the
 * `execution_placements` row is written in the same transaction as the decision's audit row, BEFORE the facts are
 * captured, so it is visible here. Drizzle field names, as read.
 */
export interface DecisionPlacementRead {
  /** the `execution_placements` row */
  placement: Record<string, unknown>;
  /** the `execution_profiles` row its `profile_digest` names (id, name, version, digest) */
  profile: Record<string, unknown> | null;
  /** the `executors` row it names (id, backend, runtimeVersion, workloadIdentityId) */
  executor: Record<string, unknown> | null;
  /** that executor's workload identity URI (`workload_identities.identifier`) */
  executorIdentity: string | null;
  /** the executor self-test the placement relied on (id, reportSha256), or null */
  executorAttestation: Record<string, unknown> | null;
}

/** the rows the loader read, keyed by id (drizzle field names, as `projectBomRow` expects) */
export interface DecisionFactReads {
  /** `projects.classifications` of each attributed project that exists */
  projectTags: ReadonlyMap<string, readonly string[] | null>;
  approvals: ReadonlyMap<string, Record<string, unknown>>;
  /** every `approval_decisions` row of each approval, at decision time */
  approvalDecisions: ReadonlyMap<string, ReadonlyArray<Record<string, unknown>>>;
  grants: ReadonlyMap<string, Record<string, unknown>>;
  identities: ReadonlyMap<string, Record<string, unknown>>;
  /** ADR-0190 I8: the placement row of each decision that has one, keyed by audit id (absent = none) */
  placements?: ReadonlyMap<string, DecisionPlacementRead>;
  /** ADR-0190 I8: `mcp_servers.transport` of each MCP tool decision's server that exists */
  mcpServerTransports?: ReadonlyMap<string, string>;
}

const REMOTE_MCP_TRANSPORTS: ReadonlySet<string> = new Set(["streamable_http", "sse"]);
/** `engine-runs.ts`'s `detail.phase` on an engine run's entitlement decision (ADR-0190 I8 review M1) */
export const ENGINE_RUN_ENTITLEMENT_PHASE = "engine-run-entitlement";
const asText = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * ADR-0190 decision 9 / I8: the `execution` facts of one decision, or null (NOT RECORDED).
 *  - A placement row in the decision's transaction is the authority, whatever the object type. An `offered` row
 *    (ADR-0190 I4) is recorded as offered: executor, attested class, the broker's attestation, the offer, no report.
 *  - No row: a model call (`agent`) or a connector call runs in the gateway (`in_gateway`); an MCP tool call on a
 *    remote server runs on the upstream's host (`external`); a stdio server's call, an MCP call whose server is
 *    unknown, and an approval have no placement to record, so null. Nothing is inferred beyond these.
 */
export function buildExecutionFacts(row: DecisionAuditRow, reads: DecisionFactReads): DecisionExecutionFacts | null {
  const p = reads.placements?.get(row.id);
  const engineRunEntitlement = row.objectType === "agent" && asRecord(row.detail)?.phase === ENGINE_RUN_ENTITLEMENT_PHASE;
  // ADR-0190 I5: an ALLOWED engine run entitlement decision is the run's task start, and its engine_worker placement is
  // written in the same transaction. Without one (or with another kind of workload) the I5 contract is broken: the
  // capture fails, and the decision with it (fail closed), rather than record a run whose isolation is unknown.
  if (engineRunEntitlement && row.effect === "allow" && (!p || p.placement.workloadKind !== "engine_worker")) {
    throw new DecisionFactsCaptureError(row.id, "an allowed engine run entitlement decision has no engine_worker placement in its transaction (ADR-0190 I5)");
  }
  if (p) {
    const pl = p.placement;
    const profile = p.profile
      ? { id: asText(p.profile.id), name: asText(p.profile.name), version: p.profile.version, digest: asText(p.profile.digest) }
      : null;
    const executor = p.executor
      ? {
          id: asText(p.executor.id),
          backend: asText(p.executor.backend),
          runtimeVersion: asText(p.executor.runtimeVersion),
          identityId: asText(p.executor.workloadIdentityId),
          identity: p.executorIdentity !== null && isBomSpiffeId(p.executorIdentity) ? p.executorIdentity : null,
        }
      : null;
    const outcome = asText(pl.outcome);
    const report = asText(pl.reportSha256);
    const att = p.executorAttestation;
    return {
      workloadKind: pl.workloadKind,
      placement: outcome,
      placementId: asText(pl.id),
      requiredClass: pl.requiredClass ?? null,
      requiredBy: pl.requiredBy ?? null,
      appliedClass: pl.appliedClass ?? null,
      refusalCode: pl.refusalCode ?? null,
      profile,
      executor,
      // ADR-0190 I4: the row's own stamps (the offer of an `offered` row, the closure image, the runtime flags hash)
      offerId: outcome === "offered" ? asText(pl.offerId) : null,
      imageDigest: asText(pl.imageDigest),
      runtimeFlagsSha256: asText(pl.runtimeFlagsSha256),
      attestation:
        outcome === "refused"
          ? null
          : { placementReportSha256: report, executorAttestationId: att ? asText(att.id) : null, executorReportSha256: att ? asText(att.reportSha256) : null },
    } as DecisionExecutionFacts;
  }
  const none = { placementId: null, requiredClass: null, requiredBy: null, refusalCode: null, profile: null, executor: null, attestation: null };
  // an engine run's entitlement decision governs an engine worker, not a model call in the gateway. From I5 an
  // allowed one always has its placement (above). A refusal written before any task start (run creation, the
  // lease's re-check) placed nothing: its location is NOT RECORDED (`no_placement`), never a guess
  if (engineRunEntitlement) return null;
  if (row.objectType === "agent") return { workloadKind: "model_call", placement: "in_gateway", appliedClass: "in_gateway", ...none };
  if (row.objectType === "connector") return { workloadKind: "connector_call", placement: "in_gateway", appliedClass: "in_gateway", ...none };
  if (row.objectType === "mcp_tool") {
    const serverId = decisionFactRefs(row).mcpServerId;
    const transport = serverId ? reads.mcpServerTransports?.get(serverId) : undefined;
    if (transport !== undefined && REMOTE_MCP_TRANSPORTS.has(transport)) return { workloadKind: "remote_mcp", placement: "external", appliedClass: "external", ...none };
  }
  return null;
}

/** a decision's facts cannot be captured truthfully; the decision's transaction fails with it */
export class DecisionFactsCaptureError extends Error {
  constructor(auditId: string, why: string) {
    super(`decision facts (ADR-0189 B2): ${auditId}: ${why}`);
    this.name = "DecisionFactsCaptureError";
  }
}

function bind(table: Exclude<BomProjectedTable, "eval_cases">, row: Record<string, unknown>): BoundRow {
  const projection = projectBomRow(table, row);
  return { table, id: String(projection[table === "issued_tokens" ? "jti" : "id"]), projection, digest: bomRowDigest(table, projection) };
}
const byTableThenId = (a: BoundRow, b: BoundRow) =>
  a.table < b.table ? -1 : a.table > b.table ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Build the `regulait.decision-facts.v2` payload of one receipt-eligible row
 * from the row and what the loader read in the same transaction. Validated
 * against the B1 contract (and its JSON-safety rule, F5) before it is returned.
 */
export function buildDecisionFacts(row: DecisionAuditRow, reads: DecisionFactReads): DecisionFacts {
  const detail = asRecord(row.detail) ?? {};
  const refs = decisionFactRefs(row);
  const rows: BoundRow[] = [];

  // --- actors (from ADR-0188's columns; R18) -------------------------------
  let actors: DecisionFacts["actors"] = null;
  if (row.chainVersion === 2) {
    if (!isUuid(row.userId)) throw new DecisionFactsCaptureError(row.id, "the sponsor user id is not a lower-case uuid");
    if (row.actorIdentityId === null) {
      actors = { sponsorUserId: row.userId, actorIdentityId: null, delegationGrantId: null, actorChain: [] };
    } else {
      const chain = row.actorChain ?? [];
      const uris = chain.map((id) => {
        const identity = reads.identities.get(id);
        const uri = identity?.identifier;
        if (typeof uri !== "string" || !isBomSpiffeId(uri)) {
          throw new DecisionFactsCaptureError(row.id, `actor chain identity ${id} has no SPIFFE identifier at decision time`);
        }
        return uri;
      });
      const grant = refs.grantId ? reads.grants.get(refs.grantId) : undefined;
      if (!grant || !isUuid(row.actorIdentityId)) throw new DecisionFactsCaptureError(row.id, "the delegation grant the row names does not exist at decision time");
      actors = { sponsorUserId: row.userId, actorIdentityId: row.actorIdentityId, delegationGrantId: row.delegationGrantId, actorChain: uris };
      rows.push(bind("delegation_grants", grant));
      for (const id of refs.identityIds) rows.push(bind("workload_identities", reads.identities.get(id)!));
    }
  }

  // --- action ---------------------------------------------------------------
  let action: DecisionFacts["action"] = null;
  const kind = row.objectType as "mcp_tool" | "connector" | "agent" | "approval";
  const tags = refs.projectId === null ? [] : reads.projectTags.get(refs.projectId);
  // a project that is gone, or a tag the contract cannot hold, makes the section unrecordable (never a guess)
  if (tags !== undefined && (tags ?? []).every(isIdentifier)) {
    const toolNameOk = row.toolName === null || isIdentifier(row.toolName);
    action = {
      argumentsDigest: isDigest(detail.argumentsDigest) ? detail.argumentsDigest : null,
      contextDigest: isDigest(detail.contextDigest) ? detail.contextDigest : null,
      target: {
        kind,
        serverId: isUuid(row.serverId) ? row.serverId : null,
        toolName: toolNameOk ? row.toolName : null,
        toolNameHash: toolNameOk ? null : createHash("sha256").update(row.toolName!, "utf8").digest("hex"),
        connectorId: kind === "connector" && isUuid(row.objectId) ? row.objectId : null,
        agentId: kind === "agent" && isUuid(row.objectId) ? row.objectId : null,
      },
      inputs: null, // NOT RECORDED: no decision path records its inputs yet
      dataSensitivity: null,
      complianceTags: [...new Set(tags ?? [])].sort(),
    };
  }

  // --- policy (what the path recorded on the decision row; lists it did not record are null) ---
  const policy: DecisionFacts["policy"] = isEpoch(detail.policyEpoch)
    ? {
        governancePolicyEpoch: detail.policyEpoch,
        abacPolicyVersions: null,
        configVersions: null,
        guardrailConfigDigest: null,
        modelPolicyRuleIds: null,
        killSwitch: detail.killSwitch === "off" || detail.killSwitch === "engaged" ? detail.killSwitch : null,
      }
    : null;

  // --- model (an agent decision names its agent; nothing else is known yet) --
  const model: DecisionFacts["model"] =
    kind === "agent" && isUuid(row.objectId)
      ? { agentId: row.objectId, provider: null, requestedModel: null, servedModel: null, pinnedModelVersion: null, modelCardId: null, modelCardApprovalId: null, aiBomSnapshotId: null }
      : null;

  // --- bound approval rows (R5) ---------------------------------------------
  for (const approvalId of refs.approvalIds) {
    const approval = reads.approvals.get(approvalId);
    if (!approval) continue; // not bound: B4 reports `no_bound_row`, never a live read later
    rows.push(bind("approvals", approval));
    for (const d of reads.approvalDecisions.get(approvalId) ?? []) rows.push(bind("approval_decisions", d));
  }
  rows.sort(byTableThenId);

  if (row.effect !== "allow" && row.effect !== "deny" && row.effect !== "require_approval") {
    throw new DecisionFactsCaptureError(row.id, `effect ${JSON.stringify(row.effect)} is not a decision outcome`);
  }
  const facts = {
    v: DECISION_FACTS_CURRENT_VERSION,
    auditId: row.id,
    auditSeq: row.seq,
    action,
    policy,
    model,
    actors,
    outcome: { effect: row.effect, refusalCode: null, upstreamStatusClass: null },
    rows,
    execution: buildExecutionFacts(row, reads),
  };
  const unsafe = bomJsonSafeIssues(facts);
  if (unsafe.length) throw new DecisionFactsCaptureError(row.id, `facts are not canonical-safe JSON (${unsafe[0]})`);
  // a placement row the contract cannot represent fails the capture, and the decision with it (fail closed)
  const parsed = decisionFactsV2Schema.safeParse(facts);
  if (!parsed.success) throw new DecisionFactsCaptureError(row.id, `facts do not match ${DECISION_FACTS_CURRENT_VERSION} (${parsed.error.issues[0]?.message ?? "invalid"})`);
  return parsed.data;
}

/** `facts_hash`: SHA-256 over the RFC 8785 bytes (migration 0182's CHECK recomputes it in SQL) */
export const decisionFactsHash = (facts: DecisionFacts): string => bomDigestOf(facts);
