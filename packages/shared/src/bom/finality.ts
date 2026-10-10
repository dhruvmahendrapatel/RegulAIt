/**
 * ADR-0189 — when a Decision BOM may freeze, and until when its rows are kept.
 * Pure: no clock (every time is an argument), no I/O.
 *
 *  - `bomExpiresAt`: the ONE `expires_at` every decision-scoped row shares
 *    (round-8 entry condition 4237322627): the decision's audit timestamp plus the
 *    composed audit retention, or null when retention is unbounded ("keep
 *    everything", `retentionFloor` with no floor). R16's prune uses it.
 *  - `decisionBomFinality`: R4 and R44's freezing rule, with the #280 policy for
 *    UNBOUNDED retention (4237493042): `anchored` compares the Object Lock's
 *    `retain_until` with the end of the evidence retention, which does not exist
 *    when retention is unbounded. That case is the distinct state
 *    `anchored_finite_lock`: every other `anchored` requirement holds (flushed,
 *    observed tamper-resistant, timestamped when required) and the recorded
 *    `retain_until` is still in the future. It ranks BELOW `anchored`; the strict
 *    default refuses it (pending, reason `retention_unbounded`), and an admin's
 *    audited relaxation `decision_bom_finite_lock_finality = accept` makes it
 *    final (security review F6, ADR-0180). The signed body carries
 *    `retain_until`; the verifier reports `anchored_lapsed` once it has passed
 *    (R44), and `cannotProve` says the commitment is finite while the retention
 *    is not.
 */
import type { DecisionBomFinalityState } from "./contract.js";

const DAY_MS = 86_400_000;

/** null = unbounded retention: the row never expires and is never pruned */
export function bomExpiresAt(auditAt: Date, retainedDays: number | null): Date | null {
  if (retainedDays === null) return null;
  if (!Number.isSafeInteger(retainedDays) || retainedDays < 1) throw new RangeError("bomExpiresAt: retention is a positive whole number of days");
  return new Date(auditAt.getTime() + retainedDays * DAY_MS);
}

/** the admin's floor (`org_settings.decision_bom_finality`), strictest first */
export const DECISION_BOM_FINALITY_SETTINGS = ["anchored", "anchored_unverified_destination", "chain_signed"] as const;
export type DecisionBomFinalitySetting = (typeof DECISION_BOM_FINALITY_SETTINGS)[number];

export const DECISION_BOM_PENDING_REASONS = [
  "anchor_not_flushed",
  "destination_not_tamper_resistant",
  "timestamp_pending",
  "lock_not_recorded",
  "lock_shorter_than_retention",
  "lock_lapsed",
  "retention_unbounded",
] as const;
export type DecisionBomPendingReason = (typeof DECISION_BOM_PENDING_REASONS)[number];

export interface FinalityAnchorFacts {
  status: "pending" | "flushed" | "failed";
  /** R4: the observation recorded at flush */
  tamperResistant: boolean;
  tsaGranted: boolean;
  /** R44: read back from the written object version at flush */
  retainUntil: Date | null;
}
export interface FinalityInput {
  /** the newest anchor covering the decision row, or null */
  anchor: FinalityAnchorFacts | null;
  /** the decision's receipt is signed (and every addendum, R15) */
  receiptSigned: boolean;
  timestampMode: "required" | "off";
  decisionAt: Date;
  /** composed audit retention; null = unbounded */
  retainedDays: number | null;
  /** the freeze time (the database clock at assembly) */
  now: Date;
  setting: DecisionBomFinalitySetting;
  /** `org_settings.decision_bom_finite_lock_finality`: strict `refuse` */
  finiteLock: "refuse" | "accept";
}
export type FinalityDecision =
  | { freeze: true; state: DecisionBomFinalityState }
  | { freeze: false; reason: DecisionBomPendingReason | "receipt_unsigned" };

const RANK: Record<DecisionBomFinalityState, number> = {
  anchored: 4,
  anchored_finite_lock: 3,
  anchored_unverified_destination: 2,
  chain_signed: 1,
};
const FLOOR: Record<DecisionBomFinalitySetting, number> = { anchored: 4, anchored_unverified_destination: 2, chain_signed: 1 };

/** the strongest state the facts support, and why it is not `anchored` */
function strongest(i: FinalityInput): { state: DecisionBomFinalityState; shortOf: DecisionBomPendingReason | null } {
  const a = i.anchor;
  if (!a || a.status !== "flushed") return { state: "chain_signed", shortOf: "anchor_not_flushed" };
  if (!a.tamperResistant) return { state: "anchored_unverified_destination", shortOf: "destination_not_tamper_resistant" };
  if (i.timestampMode === "required" && !a.tsaGranted) return { state: "anchored_unverified_destination", shortOf: "timestamp_pending" };
  if (a.retainUntil === null) return { state: "anchored_unverified_destination", shortOf: "lock_not_recorded" };
  if (a.retainUntil.getTime() <= i.now.getTime()) return { state: "anchored_unverified_destination", shortOf: "lock_lapsed" };
  const end = bomExpiresAt(i.decisionAt, i.retainedDays);
  if (end === null) return { state: "anchored_finite_lock", shortOf: null };
  if (a.retainUntil.getTime() < end.getTime()) return { state: "anchored_unverified_destination", shortOf: "lock_shorter_than_retention" };
  return { state: "anchored", shortOf: null };
}

export function decisionBomFinality(i: FinalityInput): FinalityDecision {
  if (!i.receiptSigned) return { freeze: false, reason: "receipt_unsigned" };
  const { state, shortOf } = strongest(i);
  if (RANK[state] >= FLOOR[i.setting]) return { freeze: true, state };
  if (state === "anchored_finite_lock") return i.finiteLock === "accept" ? { freeze: true, state } : { freeze: false, reason: "retention_unbounded" };
  return { freeze: false, reason: shortOf ?? "anchor_not_flushed" };
}

/** R44: what the verifier REPORTS for a frozen state at verification time (a frozen body is never edited) */
export function reportedFinality(state: DecisionBomFinalityState, retainUntil: Date | null, verifiedAt: Date): DecisionBomFinalityState | "anchored_lapsed" {
  if ((state === "anchored" || state === "anchored_finite_lock") && (retainUntil === null || retainUntil.getTime() <= verifiedAt.getTime())) {
    return "anchored_lapsed";
  }
  return state;
}
