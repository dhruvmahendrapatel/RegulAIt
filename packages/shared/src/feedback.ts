/**
 * ADR-0182 (ADR-0175 batch D4) A13 — END-USER FEEDBACK AND APPEAL: the pure half. OWNER: A13 (D4).
 *
 * NIST AI RMF GOVERN 5.1/5.2, MEASURE 3.3, MAP 5.2, MANAGE 4.1: people affected
 * by an AI system can report a problem or appeal a decision, someone accountable
 * answers within a stated time, and the answers are counted.
 *
 * This file decides nothing on its own and touches no database. The gateway
 * (`apps/gateway/src/feedback.ts`) calls these functions so the routes, the
 * sweeps, the monitor loader and the metrics agree on:
 *   - the due times a new item gets (`feedbackDueDates`), from the org's
 *     `feedback_ack_sla_hours` / `feedback_resolve_sla_days`;
 *   - where an item stands against them (`feedbackSlaState`), which the owner's
 *     queue shows as a chip and the monitor raises as `feedback_sla_breached`;
 *   - which status moves are allowed (`feedbackTransitionProblem`);
 *   - who may NOT resolve an appeal (`appealSodConflict`): separation of duties;
 *   - the two A2 metrics' arithmetic (`userReportRatePer1k`, `appealOverturnRate`).
 *
 * Vocabularies and request bodies are in `accountability.ts` (P0). This file
 * does not import the package barrel (index.ts re-exports it).
 */
import {
  APPEAL_OUTCOMES,
  RESOLVED_FEEDBACK_STATUSES,
  type FeedbackKind,
  type FeedbackStatus,
} from "./accountability.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** a signed link's opaque token starts with this (192+ bits follow; only its SHA-256 is stored) */
export const FEEDBACK_LINK_TOKEN_PREFIX = "rglf_";

/** an SLA chip turns amber this long before the due time */
export const FEEDBACK_DUE_SOON_MS = 24 * HOUR_MS;

/**
 * The public signed-link routes' own rate limits, on top of the gateway's
 * global per-address tier. Per ADDRESS before the token is looked up (a bucket
 * named after an unverified string would be one the caller mints at will), and
 * per LINK once the token resolved to a stored link.
 */
export const FEEDBACK_PUBLIC_RATE_LIMITS = Object.freeze({
  perAddress: { max: 20, windowMs: 15 * 60_000 },
  perLink: { max: 60, windowMs: 60 * 60_000 },
});

export function isResolvedFeedbackStatus(s: string): s is (typeof RESOLVED_FEEDBACK_STATUSES)[number] {
  return (RESOLVED_FEEDBACK_STATUSES as readonly string[]).includes(s);
}

/**
 * A new item's due times. Acknowledgement is due `ackHours` after receipt and
 * resolution `resolveDays` after it (`N × 24 h`, UTC instants). An
 * acknowledgement can never fall due after the resolution (the DB CHECK
 * `resolve_due_at >= ack_due_at` holds it), so a short resolution time pulls
 * the acknowledgement in with it.
 */
export function feedbackDueDates(
  receivedAt: Date,
  sla: { ackHours: number; resolveDays: number },
): { ackDueAt: Date; resolveDueAt: Date } {
  const resolveDueAt = new Date(receivedAt.getTime() + sla.resolveDays * DAY_MS);
  const ack = receivedAt.getTime() + sla.ackHours * HOUR_MS;
  return { ackDueAt: new Date(Math.min(ack, resolveDueAt.getTime())), resolveDueAt };
}

export type FeedbackSlaPhase = "acknowledge" | "resolve" | "done";
export type FeedbackSlaChip = "on_time" | "due_soon" | "breached" | "done";
export interface FeedbackSlaState {
  /** what is due next: acknowledging it, resolving it, or nothing */
  phase: FeedbackSlaPhase;
  chip: FeedbackSlaChip;
  /** when the phase falls due (null once done) */
  dueAt: Date | null;
  /** the phases whose due time has passed while still open (both can be) */
  breached: Array<"acknowledge" | "resolve">;
}

/**
 * Where an item stands against its due times at `now`. A resolved item is
 * done. An unacknowledged one is in its acknowledgement phase; an acknowledged,
 * unresolved one is in its resolution phase. An item can breach both: never
 * acknowledged, and now past its resolution time too.
 */
export function feedbackSlaState(
  item: { ackDueAt: Date; resolveDueAt: Date; acknowledgedAt: Date | null; resolvedAt: Date | null },
  now: Date,
): FeedbackSlaState {
  if (item.resolvedAt) return { phase: "done", chip: "done", dueAt: null, breached: [] };
  const t = now.getTime();
  const breached: Array<"acknowledge" | "resolve"> = [];
  if (!item.acknowledgedAt && item.ackDueAt.getTime() <= t) breached.push("acknowledge");
  if (item.resolveDueAt.getTime() <= t) breached.push("resolve");
  const phase: FeedbackSlaPhase = item.acknowledgedAt ? "resolve" : "acknowledge";
  const dueAt = phase === "acknowledge" ? item.ackDueAt : item.resolveDueAt;
  const chip: FeedbackSlaChip =
    breached.length > 0 ? "breached" : dueAt.getTime() - t <= FEEDBACK_DUE_SOON_MS ? "due_soon" : "on_time";
  return { phase, chip, dueAt, breached };
}

/** the monitor subject of one breached phase of one item (stable across passes) */
export function feedbackSubjectKey(useCaseId: string, feedbackId: string, phase: "acknowledge" | "resolve"): string {
  return `use_case:${useCaseId}>feedback:${feedbackId}>${phase}`;
}

/**
 * Is `from → to` a move this item may make? Returns the refusal's code, or
 * null. A resolved item is final (a new report is a new item); `upheld` and
 * `overturned` are an appeal's outcomes only (a DB CHECK holds it too); moving
 * back to `received` would erase an acknowledgement.
 */
export function feedbackTransitionProblem(
  kind: FeedbackKind,
  from: FeedbackStatus,
  to: FeedbackStatus,
): null | "feedback_already_resolved" | "appeal_outcome_on_problem" | "feedback_status_backwards" {
  if (isResolvedFeedbackStatus(from)) return "feedback_already_resolved";
  if (kind !== "appeal" && (APPEAL_OUTCOMES as readonly string[]).includes(to)) return "appeal_outcome_on_problem";
  if (to === "received" && from !== "received") return "feedback_status_backwards";
  return null;
}

/**
 * SEPARATION OF DUTIES on an appeal. An appeal contests a decision; the person
 * who made that decision (the person whose trace the appeal cites) may not
 * decide it, and neither may the person who filed it. With no cited decision,
 * only the filer is excluded. Returns why the resolver is excluded, or null.
 * A problem report has no contested decision and is not constrained.
 */
export function appealSodConflict(input: {
  kind: FeedbackKind;
  resolverUserId: string;
  submitterUserId: string | null;
  contestedUserId: string | null;
}): null | "contested_decision_maker" | "submitter" {
  if (input.kind !== "appeal") return null;
  if (input.contestedUserId && input.contestedUserId === input.resolverUserId) return "contested_decision_maker";
  if (input.submitterUserId && input.submitterUserId === input.resolverUserId) return "submitter";
  return null;
}

/**
 * Who an item is routed to: the use case's owner, unless the owner is excluded
 * from deciding it (an appeal against the owner's own decision, or filed by
 * the owner). Then it is unassigned and lands in the admins' queue.
 */
export function feedbackRouteTo(input: {
  kind: FeedbackKind;
  useCaseOwnerUserId: string | null;
  submitterUserId: string | null;
  contestedUserId: string | null;
}): string | null {
  const owner = input.useCaseOwnerUserId;
  if (!owner) return null;
  const conflict = appealSodConflict({
    kind: input.kind,
    resolverUserId: owner,
    submitterUserId: input.submitterUserId,
    contestedUserId: input.contestedUserId,
  });
  return conflict ? null : owner;
}

/**
 * `user_report_rate`: problem reports per 1,000 finished traces in scope over
 * the window. The traces are the samples; no traces is no measurement (null),
 * never a rate of 0.
 */
export function userReportRatePer1k(reports: number, finishedTraces: number): number | null {
  if (finishedTraces <= 0) return null;
  return (reports / finishedTraces) * 1000;
}

/**
 * `appeal_overturn_rate`: the share (%) of decided appeals whose contested
 * decision was overturned. Only `upheld` and `overturned` decide an appeal;
 * `no_change` and `rejected` say nothing about the decision and are not
 * samples. No decided appeal is no measurement (null).
 */
export function appealOverturnRate(upheld: number, overturned: number): number | null {
  const n = upheld + overturned;
  if (n <= 0) return null;
  return (overturned / n) * 100;
}
