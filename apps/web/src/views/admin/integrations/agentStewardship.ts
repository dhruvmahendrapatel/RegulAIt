/**
 * Agent stewardship (ADR-0168 item 6) — the pure half of the agent inventory's
 * stewardship card and drawer: labels, filters, the review sentence and the
 * PATCH body a drawer edit produces. The gateway owns every rule; this module
 * only mirrors the two refusals a person can see coming (the successor is the
 * steward; a non-active status with no reason) so the form can say so before
 * the request, never instead of it.
 */
import type { Tone } from "../../../ui/kit";

export const LIFECYCLE_STATUSES = ["proposed", "active", "under_review", "suspended", "deprecated", "retired"] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

const LIFECYCLE_LABEL: Record<LifecycleStatus, string> = {
  proposed: "Proposed",
  active: "Active",
  under_review: "Under review",
  suspended: "Suspended",
  deprecated: "Deprecated",
  retired: "Retired",
};
const LIFECYCLE_TONE: Record<LifecycleStatus, Tone> = {
  proposed: "info",
  active: "ok",
  under_review: "warn",
  suspended: "danger",
  deprecated: "warn",
  retired: "neutral",
};
/** what each status does, in words — shown under the status picker */
export const LIFECYCLE_EFFECT: Record<LifecycleStatus, string> = {
  proposed: "Registered but not yet in service. Calls are still allowed.",
  active: "In service.",
  under_review: "Being reviewed. Calls are still allowed.",
  suspended: "Out of service: every call is refused until it returns to active.",
  deprecated: "Being phased out. Calls are still allowed.",
  retired: "Permanently out of service. Retirement cannot be undone.",
};

export const lifecycleLabel = (s: string) => LIFECYCLE_LABEL[s as LifecycleStatus] ?? s;
export const lifecycleTone = (s: string): Tone => LIFECYCLE_TONE[s as LifecycleStatus] ?? "neutral";

/** the stewardship fields GET /v1/agents adds to each row */
export interface AgentStewardship {
  ownerUserId?: string | null;
  stewardUserId?: string | null;
  stewardName?: string | null;
  stewardDeactivated?: boolean;
  successorUserId?: string | null;
  successorName?: string | null;
  successorDeactivated?: boolean;
  orphaned?: boolean;
  reviewOverdue?: boolean;
  nextReviewAt?: string | null;
  lastReviewedAt?: string | null;
  lastReviewedByName?: string | null;
  reviewCadenceMonths?: number;
  highestUseCaseTier?: string | null;
  lifecycleStatus?: string;
  lifecycleReason?: string | null;
}

export type StewardshipFilter = "all" | "orphaned" | "overdue";

export function matchesFilter(a: AgentStewardship, f: StewardshipFilter): boolean {
  if (f === "orphaned") return !!a.orphaned;
  if (f === "overdue") return !!a.reviewOverdue;
  return true;
}

export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** the "Next review" cell: a date, "Not scheduled", or an overdue date called out */
export function reviewCell(a: AgentStewardship): { text: string; overdue: boolean } {
  if (a.lifecycleStatus === "retired") return { text: "—", overdue: false };
  if (!a.nextReviewAt) return { text: "Not scheduled", overdue: false };
  if (a.reviewOverdue) return { text: `Overdue since ${fmtDay(a.nextReviewAt)}`, overdue: true };
  return { text: fmtDay(a.nextReviewAt), overdue: false };
}

/** why the cadence is what it is, in one sentence */
export function cadenceSentence(a: AgentStewardship): string {
  const months = a.reviewCadenceMonths ?? 12;
  const tier = a.highestUseCaseTier;
  if (tier === "high" || tier === "prohibited") {
    return `Reviewed every ${months} months, because a high-risk use case runs on it.`;
  }
  return tier
    ? `Reviewed every ${months} months. Its highest-risk use case is ${tier === "limited" ? "limited" : "minimal"} risk.`
    : `Reviewed every ${months} months. No screened use case runs on it yet.`;
}

/** yyyy-mm-dd (a date input's value) ⇄ ISO. Noon UTC, so the date never shifts by a timezone. */
export const dateInputToIso = (d: string) => (d ? new Date(`${d}T12:00:00Z`).toISOString() : null);
export const isoToDateInput = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");

export interface StewardshipDraft {
  stewardUserId: string; // "" = nobody
  successorUserId: string; // "" = nobody
  lifecycleStatus: string;
  lifecycleReason: string;
  nextReview: string; // yyyy-mm-dd or ""
}

export function draftOf(a: AgentStewardship): StewardshipDraft {
  return {
    stewardUserId: a.stewardUserId ?? a.ownerUserId ?? "",
    successorUserId: a.successorUserId ?? "",
    lifecycleStatus: a.lifecycleStatus ?? "active",
    lifecycleReason: a.lifecycleReason ?? "",
    nextReview: isoToDateInput(a.nextReviewAt),
  };
}

/**
 * The PATCH body for what changed, or a problem the person can fix first.
 * `{ body: null }` means nothing changed.
 */
export function stewardshipPatch(
  a: AgentStewardship,
  d: StewardshipDraft,
  today: string = new Date().toISOString().slice(0, 10),
): { body: Record<string, unknown> | null; problem: string | null } {
  const before = draftOf(a);
  const body: Record<string, unknown> = {};
  if (d.stewardUserId !== before.stewardUserId) body.stewardUserId = d.stewardUserId || null;
  if (d.successorUserId !== before.successorUserId) body.successorUserId = d.successorUserId || null;
  if (d.stewardUserId && d.stewardUserId === d.successorUserId) {
    return { body: null, problem: "Choose a successor who is not the steward." };
  }
  const reason = d.lifecycleReason.trim();
  if (d.lifecycleStatus !== before.lifecycleStatus) {
    body.lifecycleStatus = d.lifecycleStatus;
    if (d.lifecycleStatus !== "active") {
      if (!reason) return { body: null, problem: `Give a reason for moving this agent to ${lifecycleLabel(d.lifecycleStatus).toLowerCase()}.` };
      body.lifecycleReason = reason;
    }
  } else if (d.lifecycleStatus !== "active" && reason && reason !== before.lifecycleReason) {
    body.lifecycleReason = reason;
  }
  if (d.nextReview !== before.nextReview) {
    if (d.nextReview && d.nextReview <= today) {
      return { body: null, problem: "Choose a next review date after today. To record a review that happened, use Record review." };
    }
    body.nextReviewAt = dateInputToIso(d.nextReview);
  }
  return { body: Object.keys(body).length ? body : null, problem: null };
}
