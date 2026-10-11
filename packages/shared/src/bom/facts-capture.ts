/**
 * ADR-0189 slice B2 — DECISION FACT CAPTURE (the pure half).
 *
 * §4: every receipt-eligible decision writes `regulait.decision-facts.v1` in its
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
  DECISION_FACTS_VERSION,
  decisionFactsSchema,
  isBomSpiffeId,
  projectBomRow,
  type BomProjectedTable,
  type BoundRow,
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
  };
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
 * Build the `regulait.decision-facts.v1` payload of one receipt-eligible row
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
    v: DECISION_FACTS_VERSION,
    auditId: row.id,
    auditSeq: row.seq,
    action,
    policy,
    model,
    actors,
    outcome: { effect: row.effect, refusalCode: null, upstreamStatusClass: null },
    rows,
  };
  const unsafe = bomJsonSafeIssues(facts);
  if (unsafe.length) throw new DecisionFactsCaptureError(row.id, `facts are not canonical-safe JSON (${unsafe[0]})`);
  const parsed = decisionFactsSchema.safeParse(facts);
  if (!parsed.success) throw new DecisionFactsCaptureError(row.id, `facts do not match regulait.decision-facts.v1 (${parsed.error.issues[0]?.message ?? "invalid"})`);
  return parsed.data;
}

/** `facts_hash`: SHA-256 over the RFC 8785 bytes (migration 0182's CHECK recomputes it in SQL) */
export const decisionFactsHash = (facts: DecisionFacts): string => bomDigestOf(facts);
