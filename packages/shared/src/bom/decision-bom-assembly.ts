/**
 * ADR-0189 slice B4 — the Decision BOM projection and assembly (pure).
 *
 * B4.4: every section of `regulait.decision-bom.v1` and `.v2` (ADR-0190 I8) is a pure function of the
 * receipt payload, the decision's facts payload and its signed addenda (in `n`
 * order), the decision row's `rule_chain`, the chain rows and the anchor row
 * (R37). This file holds that mapping ONCE: the gateway's assembler builds the
 * body with it, and the verifier (`verify.ts`) recomputes every section with it
 * and compares (`sections_projection`). Nothing here reads a clock, a database
 * or the network.
 *
 * The cost sum (B4.7-3, R23) uses `bignumber.js` (ADR-0176): an exact decimal
 * sum of the stored shortest round-trip strings, written in plain notation with
 * no exponent and no trailing fractional zeros (`toFixed()` with no argument).
 */
import BigNumber from "bignumber.js";
import { createHash } from "node:crypto";
import { RECEIPT_PAYLOAD_VERSION_V2, receiptCanonicalBytes, type AnyDecisionReceiptPayload } from "../batch4.js";
import { isDecisionReceiptPayload } from "../receipts/verify.js";
import {
  BOM_ROW_PROJECTIONS,
  bomCanonicalBytes,
  bomIdentifierSchema,
  bomRowDigest,
  bomSha256,
  bomUuidSchema,
  DECISION_BOM_CURRENT_VERSION,
  DECISION_BOM_VERSION,
  DECISION_BOM_VERSION_V2,
  DECISION_FACTS_VERSION_V2,
  decisionBomAnchorSchema,
  decisionBomSectionsFor,
  decisionFactsAddendumSchema,
  decisionFactsSchema,
  executionFactsOf,
  type BoundRow,
  type DecisionBomFinalityState,
  type DecisionBomSection,
  type DecisionBomVersion,
  type DecisionExecutionFacts,
  type DecisionFacts,
  type DecisionFactsAddendum,
} from "./contract.js";
import type { z } from "zod";

export type DecisionBomAnchor = z.infer<typeof decisionBomAnchorSchema>;
export interface DecisionBomChainRow {
  seq: number;
  contentHash: string;
  prevHash: string;
  rowHash: string;
}
export type BomCompletenessEntry = { status: "recorded" } | { status: "not_applicable" } | { status: "not_recorded"; reason: string };
/** the "no facts" reason (B4.4 decided here): `capture_off` when the marker says so, `pre_facts` with no marker */
export type DecisionBomNoFactsReason = "pre_facts" | "capture_off";

/** the sections a projection recomputes, plus `basis` */
export interface DecisionBomProjection {
  decision: Record<string, unknown>;
  principal: { sponsorUserId: string };
  actors: DecisionFacts["actors"];
  action: DecisionFacts["action"];
  policy: DecisionFacts["policy"];
  model: DecisionFacts["model"];
  approval: BoundRow[] | null;
  outcome: DecisionFacts["outcome"] | null;
  cost: { usageEventIds: string[]; inputTokens: number; outputTokens: number; costUsd: string | null; costSource: "usage_events.cost_usd" } | null;
  trace: { traceIds: string[]; spanIds: string[] } | null;
  /** ADR-0190 I8: v2 only (a v1 projection has no execution section, and `completeness` no `execution` key) */
  execution: DecisionExecutionFacts | null;
  completeness: Partial<Record<DecisionBomSection, BomCompletenessEntry>>;
  basis: { auditSeq: number; anchorId: string | null; receiptSeq: number; aiBomSnapshotId: string | null };
  /**
   * What makes the inputs unprojectable (B4.4 'decided here', B4.3 v2 bullet, G15). The assembler refuses each as
   * 500 `bom_integrity_failure`; the verifier reports the named section `invalid` `section_mismatch`.
   */
  problems: Array<{ section: DecisionBomSection; why: string }>;
}

export interface DecisionBomProjectionInput {
  /** the body version being projected: v1 (a frozen pre-I8 body, verified) or v2 (every new body) */
  bodyVersion: DecisionBomVersion;
  receipt: AnyDecisionReceiptPayload;
  receiptSeq: number;
  facts: DecisionFacts | null;
  /** in `n` order, each signed (R15); ignored when there are no facts (R35: no addendum without facts) */
  addenda: DecisionFactsAddendum[];
  /** the reason every fact section carries when there are no facts */
  noFactsReason: DecisionBomNoFactsReason;
  ruleChain: string[];
  chain: DecisionBomChainRow[];
  anchor: DecisionBomAnchor | null;
}

/** sorted by UTF-16 code unit, never `localeCompare` (amendment 5) */
export const bomCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** B4.7-3: the exact decimal sum of R23 cost strings (plain notation, no exponent, no trailing fractional zeros) */
/**
 * R23's exact shape, checked before any arithmetic: the ECMAScript shortest round-trip string of a FINITE double
 * (`String(Number(s)) === s`), at most 32 characters. That bounds the digits and the exponent (a double is below
 * 1e309 and above 5e-325), so `1e9999999`, `NaN`, `Infinity`, `0x10`, `1.0` or prose is refused, never summed
 * (ADR-0191 review of #344, item 2).
 */
export function isBomCostString(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 32) return false;
  const n = Number(value);
  return Number.isFinite(n) && String(n) === value;
}

export function bomDecimalSum(values: readonly string[]): string {
  let total = new BigNumber(0);
  for (const v of values) {
    if (!isBomCostString(v)) throw new RangeError("bomDecimalSum: a cost is not an R23 decimal string");
    total = total.plus(new BigNumber(v));
  }
  const out = total.toFixed();
  return out === "-0" ? "0" : out;
}

const isIdentifier = (v: unknown): v is string => typeof v === "string" && bomIdentifierSchema.safeParse(v).success;
const isLowerUuid = (v: unknown): v is string => typeof v === "string" && bomUuidSchema.safeParse(v).success;

/** B4.4: the bound rows are `facts.rows`, then each addendum's `rows`, in `n` order */
export function boundRowsOf(facts: DecisionFacts | null, addenda: readonly DecisionFactsAddendum[]): BoundRow[] {
  return facts ? [...facts.rows, ...addenda.flatMap((a) => a.rows)] : [];
}

/** B4.4's table, exactly. Pure; never throws on well-typed inputs (problems are returned, not thrown). */
export function projectDecisionBom(input: DecisionBomProjectionInput): DecisionBomProjection {
  const { receipt, facts } = input;
  const d = receipt.decision;
  const problems: DecisionBomProjection["problems"] = [];
  const bound = boundRowsOf(facts, input.addenda);

  // G15 / B4.4: a usage event or span bound more than once has no valid projection
  for (const [table, section] of [["usage_events", "cost"], ["trace_spans", "trace"]] as const) {
    const ids = bound.filter((r) => r.table === table).map((r) => r.id);
    if (new Set(ids).size !== ids.length) problems.push({ section, why: `a ${table} row is bound more than once` });
  }
  // B4.4 principal row: the recorded sponsor is the receipt's
  if (facts?.actors && facts.actors.sponsorUserId !== d.userId) problems.push({ section: "principal", why: "facts.actors.sponsorUserId is not the receipt's decision.userId" });
  // B4.3 v2 bullet: the receipt's actor equals the recorded actors (the chains are different spellings, not compared)
  if (receipt.v === RECEIPT_PAYLOAD_VERSION_V2 && facts?.actors) {
    if (receipt.actor.identityId !== facts.actors.actorIdentityId || receipt.actor.delegationGrantId !== facts.actors.delegationGrantId) {
      problems.push({ section: "actors", why: "the v2 receipt's actor differs from the recorded actors" });
    }
  }

  // ADR-0190 I8: a v1 body never carries v2 facts (it would drop their execution section unseen)
  const v2 = input.bodyVersion === DECISION_BOM_VERSION_V2;
  if (!v2 && facts?.v === DECISION_FACTS_VERSION_V2) problems.push({ section: "decision", why: "a v1 Decision BOM carries v2 facts" });

  const pick = (tables: readonly string[]) => bound.filter((r) => tables.includes(r.table));
  // stable sort by table then id: every binding is kept
  const approvals = pick(["approvals", "approval_decisions"])
    .map((r, i) => [r, i] as const)
    .sort(([a, i], [b, j]) => bomCompare(a.table, b.table) || bomCompare(a.id, b.id) || i - j)
    .map(([r]) => ({ table: r.table, id: r.id, projection: r.projection, digest: r.digest }));
  const usage = pick(["usage_events"]).sort((a, b) => bomCompare(a.id, b.id));
  const spans = pick(["trace_spans"]).sort((a, b) => bomCompare(a.id, b.id));

  const num = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : 0);
  let cost: DecisionBomProjection["cost"] = null;
  if (usage.length) {
    const costs = usage.map((u) => u.projection.costUsd);
    const malformed = costs.some((c) => c !== null && c !== undefined && !isBomCostString(c));
    if (malformed) problems.push({ section: "cost", why: "a bound usage event's costUsd is not an R23 decimal string" });
    const costUsd = malformed || costs.some((c) => c === null || c === undefined)
      ? null
      : costs.length === 1
        ? (costs[0] as string)
        : bomDecimalSum(costs as string[]);
    cost = {
      usageEventIds: usage.map((u) => u.id),
      inputTokens: usage.reduce((s, u) => s + num(u.projection.inputTokens), 0),
      outputTokens: usage.reduce((s, u) => s + num(u.projection.outputTokens), 0),
      costUsd,
      costSource: "usage_events.cost_usd",
    };
  }
  const trace = spans.length
    ? { traceIds: [...new Set(spans.map((s) => String(s.projection.traceId)))].sort(bomCompare), spanIds: spans.map((s) => s.id) }
    : null;

  const rec: BomCompletenessEntry = { status: "recorded" };
  const nr = (reason: string): BomCompletenessEntry => ({ status: "not_recorded", reason });
  const gap = nr(input.noFactsReason);
  const fact = (v: unknown, reason: string) => (facts === null ? gap : v === null || v === undefined ? nr(reason) : rec);
  const rows = (list: readonly unknown[]) => (facts === null ? gap : list.length ? rec : nr("no_bound_row"));
  const last = input.chain[input.chain.length - 1];
  // ADR-0190 I8: the execution section. Approvals execute nothing (`not_applicable`); v1 facts predate execution
  // facts (`pre_isolation`); a v2 null is a call with no placement row in its transaction (`no_placement`)
  const execution = executionFactsOf(facts);
  const executionCompleteness: BomCompletenessEntry =
    facts === null
      ? gap
      : execution !== null
        ? rec
        : facts.v !== DECISION_FACTS_VERSION_V2
          ? nr("pre_isolation")
          : d.objectType === "approval"
            ? { status: "not_applicable" }
            : nr("no_placement");
  const completeness: DecisionBomProjection["completeness"] = {
    decision: rec,
    receipt: rec,
    principal: rec,
    actors: fact(facts?.actors, "pre_identity"),
    action: fact(facts?.action, "not_captured_by_path"),
    policy: fact(facts?.policy, "not_captured_by_path"),
    model: fact(facts?.model, "not_captured_by_path"),
    approval: rows(approvals),
    outcome: fact(facts?.outcome, "not_captured_by_path"),
    cost: rows(usage),
    trace: rows(spans),
    proof: input.anchor === null ? nr("anchor_absent") : rec,
    ...(v2 ? { execution: executionCompleteness } : {}),
  };

  return {
    decision: {
      auditSeq: receipt.audit.seq,
      at: d.at,
      objectType: d.objectType,
      objectId: d.objectId !== null && d.objectId.length <= 256 ? d.objectId : null,
      serverId: isLowerUuid(d.serverId) ? d.serverId : null,
      toolName: isIdentifier(d.toolName) ? d.toolName : null,
      effect: d.effect,
      ruleId: isIdentifier(d.ruleId) ? d.ruleId : null,
      ruleChain: input.ruleChain,
    },
    principal: { sponsorUserId: d.userId },
    actors: facts?.actors ?? null,
    action: facts?.action ?? null,
    policy: facts?.policy ?? null,
    model: facts?.model ?? null,
    approval: approvals.length ? approvals : null,
    outcome: facts?.outcome ?? null,
    cost,
    trace,
    execution: v2 ? execution : null,
    completeness,
    basis: {
      auditSeq: last ? last.seq : receipt.audit.seq,
      anchorId: input.anchor ? input.anchor.id : null,
      receiptSeq: input.receiptSeq,
      aiBomSnapshotId: facts?.model?.aiBomSnapshotId ?? null,
    },
    problems,
  };
}

// ---------------------------------------------------------------------------
// assembly (the gateway reads the rows; this builds the body)
// ---------------------------------------------------------------------------

/** why assembly refused: the route's status and code (B4.4, `contract-b4.ts` BOM_B4_ROUTE_CONTRACT) */
export class DecisionBomAssemblyError extends Error {
  constructor(
    readonly status: 422 | 500,
    readonly code: "bom_decision_not_eligible" | "bom_integrity_failure",
    message: string,
  ) {
    super(message);
    this.name = "DecisionBomAssemblyError";
  }
}

export interface StoredDecisionReceipt {
  receiptSeq: number;
  payload: AnyDecisionReceiptPayload;
  payloadHash: string;
  signature: string;
  keyId: string;
}
export interface StoredFactAddendum {
  n: number;
  prevHash: string;
  facts: unknown;
  factsHash: string;
  /** the `decision_fact_addendum_signatures` row (R15); assembly never sees an unsigned one */
  signature: string;
  keyId: string;
}
export interface DecisionBomAssemblyInput {
  id: string;
  auditId: string;
  version: number;
  supersedes: string | null;
  finality: DecisionBomFinalityState;
  receipt: StoredDecisionReceipt;
  /** `decision_facts.facts` and its stored hash, or null */
  facts: { facts: unknown; factsHash: string } | null;
  addenda: StoredFactAddendum[];
  noFactsReason: DecisionBomNoFactsReason;
  ruleChain: unknown;
  chain: DecisionBomChainRow[];
  anchor: DecisionBomAnchor | null;
}
export interface AssembledDecisionBom {
  body: Record<string, unknown>;
  bodyBytes: string;
  bodySha256: string;
  aiBomSnapshotId: string | null;
}

const integrity = (why: string) => new DecisionBomAssemblyError(500, "bom_integrity_failure", why);

/**
 * B4.4: build the `regulait.decision-bom.v2` body (ADR-0190 I8) from stored rows. Re-checks every bound row's digest and the
 * addendum chain from `facts_hash` (R35); any mismatch is a 500 `bom_integrity_failure` and nothing is frozen (R5).
 * The caller email-scans and signs the result.
 */
export function assembleDecisionBom(input: DecisionBomAssemblyInput): AssembledDecisionBom {
  const receipt = input.receipt;
  if (!isDecisionReceiptPayload(receipt.payload)) throw integrity("the stored receipt payload is not a v1 or v2 receipt");
  const payloadBytes = bomReceiptBytes(receipt.payload);
  if (bomSha256(payloadBytes) !== receipt.payloadHash) throw integrity("the stored receipt payload hash does not re-check");
  if (receipt.payload.audit.id !== input.auditId) throw integrity("the receipt names another decision");

  // B4.4 decision row: at most 64 rule-chain entries, each an identifier
  const ruleChain = input.ruleChain;
  if (!Array.isArray(ruleChain) || ruleChain.length > 64 || !ruleChain.every(isIdentifier)) {
    throw new DecisionBomAssemblyError(422, "bom_decision_not_eligible", "the decision's rule chain is not at most 64 identifiers");
  }

  let facts: DecisionFacts | null = null;
  let factsBytes: string | null = null;
  if (input.facts) {
    const parsed = decisionFactsSchema.safeParse(input.facts.facts);
    if (!parsed.success) throw integrity("the stored facts do not parse, or a bound row's digest does not re-check");
    factsBytes = bomCanonicalBytes(input.facts.facts);
    if (bomSha256(factsBytes) !== input.facts.factsHash) throw integrity("the stored facts hash does not re-check");
    facts = parsed.data;
    if (facts.auditId !== input.auditId) throw integrity("the facts name another decision");
  }
  if (!facts && input.addenda.length) throw integrity("addenda exist for a decision with no facts");

  const addenda: DecisionFactsAddendum[] = [];
  const addendaOut: Array<{ n: number; prevHash: string; payload: string; signature: string; keyId: string }> = [];
  let prev = input.facts?.factsHash ?? null;
  input.addenda.forEach((a, i) => {
    if (a.n !== i + 1) throw integrity("the addenda are not numbered 1 to k");
    if (a.prevHash !== prev) throw integrity(`addendum ${a.n}'s prev_hash is not the previous facts_hash`);
    const parsed = decisionFactsAddendumSchema.safeParse(a.facts);
    if (!parsed.success) throw integrity(`addendum ${a.n} does not parse, or a bound row's digest does not re-check`);
    const bytes = bomCanonicalBytes(a.facts);
    if (bomSha256(bytes) !== a.factsHash) throw integrity(`addendum ${a.n}'s facts hash does not re-check`);
    if (parsed.data.n !== a.n || parsed.data.prev !== a.prevHash || parsed.data.auditId !== input.auditId) throw integrity(`addendum ${a.n} disagrees with its row`);
    addenda.push(parsed.data);
    addendaOut.push({ n: a.n, prevHash: a.prevHash, payload: bytes, signature: a.signature, keyId: a.keyId });
    prev = a.factsHash;
  });
  // every bound row's digest is re-checked (R5); the zod schema already did, this states it once more for the reader
  for (const r of boundRowsOf(facts, addenda)) {
    const want = BOM_ROW_PROJECTIONS[r.table] as readonly string[];
    if (Object.keys(r.projection).length !== want.length || bomRowDigest(r.table, r.projection) !== r.digest) throw integrity(`bound ${r.table} row ${r.id} does not re-check`);
  }

  const projection = projectDecisionBom({
    bodyVersion: DECISION_BOM_CURRENT_VERSION,
    receipt: receipt.payload,
    receiptSeq: receipt.receiptSeq,
    facts,
    addenda,
    noFactsReason: input.noFactsReason,
    ruleChain: ruleChain as string[],
    chain: input.chain,
    anchor: input.anchor,
  });
  const first = projection.problems[0];
  if (first) throw integrity(first.why);

  const body: Record<string, unknown> = {
    v: DECISION_BOM_CURRENT_VERSION,
    id: input.id,
    auditId: input.auditId,
    version: input.version,
    supersedes: input.supersedes,
    finality: input.finality,
    decision: projection.decision,
    receipt: { receiptSeq: receipt.receiptSeq, payloadHash: receipt.payloadHash, keyId: receipt.keyId, payload: payloadBytes, signature: receipt.signature },
    principal: projection.principal,
    actors: projection.actors,
    action: projection.action,
    policy: projection.policy,
    model: projection.model,
    approval: projection.approval,
    outcome: projection.outcome,
    cost: projection.cost,
    trace: projection.trace,
    execution: projection.execution,
    proof: { chain: input.chain, anchor: input.anchor },
    facts: { payload: factsBytes, addenda: addendaOut },
    completeness: Object.fromEntries(decisionBomSectionsFor(DECISION_BOM_CURRENT_VERSION).map((s) => [s, projection.completeness[s]])),
    basis: projection.basis,
  };
  const bodyBytes = bomCanonicalBytes(body);
  return { body, bodyBytes, bodySha256: bomSha256(bodyBytes), aiBomSnapshotId: projection.basis.aiBomSnapshotId };
}

/** the canonical receipt payload bytes (ADR-0060 `canonicalJson`, byte-identical to RFC 8785 for these shapes) */
export const bomReceiptBytes = (payload: AnyDecisionReceiptPayload): string => receiptCanonicalBytes(payload);

/**
 * B4.4 Freezing item 5: two bodies are the same version when they differ in nothing but `id`, `version` and
 * `supersedes`. ADR-0190 I8: a format change is not a new fact. A frozen v1 body and a v2 assembly of the same
 * decision are the same version when the v2 body adds nothing but `v` and an execution section that records
 * nothing (`not_recorded`: `pre_isolation`, `pre_facts` or `capture_off`). So a decision frozen before I8 keeps
 * its v1 BOM; it gains a v2 version only when a recorded fact really differs.
 */
export function decisionBomSameContent(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const strip = (x: Record<string, unknown>, dropExecution: boolean) => {
    const { id: _id, version: _version, supersedes: _supersedes, v: _v, ...rest } = x;
    if (!dropExecution) return bomCanonicalBytes({ v: x.v, ...rest });
    const { execution: _execution, completeness, ...kept } = rest as Record<string, unknown> & { completeness?: Record<string, unknown> };
    const { execution: _entry, ...others } = completeness ?? {};
    return bomCanonicalBytes({ ...kept, completeness: others });
  };
  const formatOnly = (v1: Record<string, unknown>, v2: Record<string, unknown>) => {
    const entry = (v2.completeness as Record<string, { status?: string; reason?: string }> | undefined)?.execution;
    const nothing = v2.execution === null && entry?.status === "not_recorded" && ["pre_isolation", "pre_facts", "capture_off"].includes(entry.reason ?? "");
    return nothing && strip(v1, true) === strip(v2, true);
  };
  if (a.v === DECISION_BOM_VERSION && b.v === DECISION_BOM_VERSION_V2) return formatOnly(a, b);
  if (b.v === DECISION_BOM_VERSION && a.v === DECISION_BOM_VERSION_V2) return formatOnly(b, a);
  return strip(a, false) === strip(b, false);
}

/** the SHA-256 hex of bytes (Buffer or text) */
export const bomBytesSha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
