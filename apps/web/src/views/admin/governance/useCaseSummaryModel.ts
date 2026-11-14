/**
 * The use-case DECISION SUMMARY (owner, #453, 2026-11-07; design thread #743): the first tab of the record,
 * derived — never re-typed — from the two reads the page already makes (the overview and the lifecycle detail).
 *
 * Nothing here adds a number the platform does not hold. A figure whose read failed says it is unavailable; a figure no
 * read measures says "Not measured" and points at where the evidence lives; neither is ever shown as 0. The one Next
 * action is picked from the server's own flags (`canMarkMet`, `resubmission.allowed`), so the page never offers
 * something the server would refuse.
 */
import type { Tone } from "../../../ui/kit";
import type { UseCaseCondition, UseCaseReview, UseCaseRiskAcceptance } from "../../../api/types";
import { canMarkMet, shortDate, statusLabel, type OverviewResponse, type OverviewRisk } from "./useCaseLifecycle";

/** what a read gave: its value, still loading, or failed (unknown is not none, AER-055) */
export type Read<T> = { state: "ok"; value: T } | { state: "loading" } | { state: "error" };

export const readOf = <T>(q: { isSuccess: boolean; isError: boolean; data: T | undefined }): Read<T> =>
  q.isSuccess && q.data !== undefined ? { state: "ok", value: q.data } : q.isError ? { state: "error" } : { state: "loading" };

/** a tab of the record a figure or the Next action points at */
export type SummaryLink = { tab: string; label: string };

export interface Figure {
  key: "risk" | "evidence" | "conditions" | "recertification";
  label: string;
  /** ok: a measured value; unmeasured: no read measures it; unavailable: its read failed; loading: not yet known */
  state: "ok" | "unmeasured" | "unavailable" | "loading";
  value: string | null;
  /** the second line, which carries the counts behind the value */
  detail: string | null;
  /** what the figure covers, always shown */
  scope: string;
  meter: { value: number; max: number; warn: boolean; label: string } | null;
  link: SummaryLink | null;
}

const RISK_SCOPE = "The risks registered against this use case, from its risk register.";

/** Risk, inherent → residual: how many risks, how many carry a residual rating after their controls, and who accepted residual risk */
export function riskFigure(risks: OverviewRisk[], acceptance: Read<UseCaseRiskAcceptance[]>): Figure {
  const base = { key: "risk" as const, label: "Risk: inherent → residual", scope: RISK_SCOPE, link: { tab: "risks", label: "Open the risks" } };
  if (risks.length === 0) {
    return { ...base, state: "ok", value: "No risks registered", detail: "Nothing has been added to this use case's risk register yet.", meter: null };
  }
  const rated = risks.filter((r) => r.residual !== null).length;
  const n = risks.length;
  const parts = [`residual rated for ${rated} of ${n} after the linked controls`];
  if (acceptance.state === "ok") {
    const accepted = acceptance.value.filter((r) => r.acceptedByName || r.acceptedAt);
    const names = [...new Set(accepted.map((r) => r.acceptedByName).filter((x): x is string => Boolean(x)))];
    parts.push(
      accepted.length === 0
        ? "no residual risk accepted"
        : `${accepted.length} accepted${names.length ? ` by ${names.join(" and ")}` : ""}`,
    );
  } else if (acceptance.state === "error") {
    parts.push("who accepted residual risk could not be loaded");
  }
  return {
    ...base,
    state: "ok",
    value: `${n} ${n === 1 ? "risk" : "risks"}`,
    detail: parts.join(" · "),
    meter: { value: rated, max: n, warn: rated < n, label: "Risks with a residual rating" },
  };
}

/**
 * Evidence attached: "X of Y required items" only when a read gives BOTH numbers. No read the page makes counts
 * the required evidence items of one use case today, so the page passes `null` and the figure says "Not measured".
 */
export function evidenceFigure(source: Read<{ attached: number; required: number }> | null): Figure {
  const base = { key: "evidence" as const, label: "Evidence attached", link: { tab: "audit", label: "Open the audit evidence" } };
  if (source === null) {
    return {
      ...base,
      state: "unmeasured",
      value: "Not measured",
      detail: "No read counts this use case's required evidence items yet, so no number is shown.",
      scope: "Required evidence items for this use case. The audit tab holds the evidence that is recorded.",
      meter: null,
    };
  }
  const scope = "Required evidence items for this use case's tier.";
  if (source.state === "loading") return { ...base, state: "loading", value: null, detail: null, scope, meter: null };
  if (source.state === "error") return { ...base, state: "unavailable", value: "Unavailable", detail: "The evidence count could not be loaded. Nothing here means none is attached.", scope, meter: null };
  const { attached, required } = source.value;
  return {
    ...base,
    state: "ok",
    value: `${attached} of ${required}`,
    detail: "required items attached",
    scope,
    meter: { value: attached, max: required, warn: attached < required, label: "Required evidence items attached" },
  };
}

/** conditions split by whether they hold the deploy gate */
export function conditionCounts(conditions: UseCaseCondition[]) {
  const open = conditions.filter((c) => c.status === "open");
  return {
    total: conditions.length,
    open: open.length,
    met: conditions.filter((c) => c.status === "met").length,
    waived: conditions.filter((c) => c.status === "waived").length,
    openBlocking: open.filter((c) => c.blocking).length,
  };
}

const CONDITIONS_SCOPE = "The conditions attached to this use case's approval.";

export function conditionsFigure(conditions: Read<UseCaseCondition[]>): Figure {
  const base = { key: "conditions" as const, label: "Conditions", scope: CONDITIONS_SCOPE, link: { tab: "overview", label: "Open the conditions" } };
  if (conditions.state === "loading") return { ...base, state: "loading", value: null, detail: null, meter: null };
  if (conditions.state === "error") {
    return { ...base, state: "unavailable", value: "Unavailable", detail: "The conditions could not be loaded. Nothing here means there are none.", meter: null };
  }
  const c = conditionCounts(conditions.value);
  if (c.total === 0) return { ...base, state: "ok", value: "None attached", detail: "No reviewer has attached a condition.", meter: null };
  const parts = [`${c.met} of ${c.total} met`];
  if (c.waived) parts.push(`${c.waived} waived`);
  parts.push(c.openBlocking ? `${c.openBlocking} ${c.openBlocking === 1 ? "blocks" : "block"} go-live (the deploy gate refuses)` : "none blocks go-live");
  return {
    ...base,
    state: "ok",
    value: `${c.open} open`,
    detail: parts.join(" · "),
    meter: { value: c.met + c.waived, max: c.total, warn: c.openBlocking > 0, label: "Conditions closed" },
  };
}

export interface LifecycleDates {
  approvedUntil: string | null;
  approvalExpired: boolean;
  recertification: boolean;
  recertificationDueAt: string | null;
}

const RECERT_SCOPE = "The end of this use case's approval, when it returns to review.";

export function recertificationFigure(lifecycle: Read<LifecycleDates>): Figure {
  const base = { key: "recertification" as const, label: "Recertification", scope: RECERT_SCOPE, link: null, meter: null };
  if (lifecycle.state === "loading") return { ...base, state: "loading", value: null, detail: null };
  if (lifecycle.state === "error") return { ...base, state: "unavailable", value: "Unavailable", detail: "The approval's dates could not be loaded." };
  const l = lifecycle.value;
  if (l.recertification) {
    const due = l.recertificationDueAt ?? l.approvedUntil;
    return { ...base, state: "ok", value: due ? shortDate(due) : "Due now", detail: "The approval expired, so the use case is back in review." };
  }
  if (l.approvedUntil) {
    return l.approvalExpired
      ? { ...base, state: "ok", value: shortDate(l.approvedUntil), detail: "The approval expired then. The use case needs a new review before it is deployed again." }
      : { ...base, state: "ok", value: shortDate(l.approvedUntil), detail: "The approval expires then and the use case returns to review." };
  }
  return { ...base, state: "unmeasured", value: "No end date", detail: "The record holds no approval end date, so no recertification is due." };
}

/** the one Next action, in the owner's order; null when nothing waits on this viewer */
export type NextAction =
  | { kind: "mark-met"; condition: UseCaseCondition }
  | { kind: "resubmit"; reachable: boolean; reason: string | null }
  | { kind: "review" }
  | null;

export function nextAction(input: {
  status: string;
  conditions: Read<UseCaseCondition[]>;
  /** `resubmission.allowed` from the detail read (the server's flag) */
  resubmissionAllowed: boolean;
  returnReason?: string | null;
  /** whether this viewer can open the resubmission screen (it sits in the admin area) */
  canOpenResubmit: boolean;
}): NextAction {
  if (input.conditions.state === "ok") {
    const mine = input.conditions.value
      .filter((c) => c.blocking && canMarkMet(c))
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    if (mine[0]) return { kind: "mark-met", condition: mine[0] };
  }
  if (input.status === "needs_info" && input.resubmissionAllowed) return { kind: "resubmit", reachable: input.canOpenResubmit, reason: input.returnReason ?? null };
  if (input.status === "under_review") return { kind: "review" };
  return null;
}

/** the header's decision panel: status only, never a control that decides */
export interface DecisionPanel {
  title: string;
  tone: Tone;
  /** "Avery Approver, 4 Nov 2026" */
  by: string | null;
  /** "2 of 2 required reviews approved", when the round had role reviews */
  quorum: string | null;
}

const DECIDED: Record<string, { word: string; tone: Tone }> = {
  approved: { word: "Approved", tone: "ok" },
  denied: { word: "Rejected", tone: "danger" },
  returned: { word: "Sent back for information", tone: "warn" },
};

export function decisionPanel(input: {
  status: string;
  approvals: OverviewResponse["approvals"];
  reviews: Read<UseCaseReview[]>;
  conditions: Read<UseCaseCondition[]>;
  userName: (id: string | null) => string | null;
}): DecisionPanel {
  const decided = input.approvals
    .filter((a) => a.decidedAt && DECIDED[a.status])
    .sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""))[0];
  const reviews = input.reviews.state === "ok" ? input.reviews.value : [];
  const deciders = [...new Set(reviews.filter((r) => r.decidedAt && r.deciderName).map((r) => r.deciderName!))];
  const who = deciders.length ? deciders.join(" and ") : decided ? input.userName(decided.approverUserId) : null;
  const when = decided?.decidedAt ?? reviews.map((r) => r.decidedAt).filter((x): x is string => Boolean(x)).sort().pop() ?? null;
  const by = who || when ? [who, when ? shortDate(when) : null].filter(Boolean).join(", ") : null;
  const quorum = reviews.length
    ? `${reviews.filter((r) => r.status === "approved").length} of ${reviews.length} required ${reviews.length === 1 ? "review" : "reviews"} approved`
    : null;
  let title: string;
  let tone: Tone;
  switch (input.status) {
    case "approved": {
      tone = "ok";
      const total = input.conditions.state === "ok" ? input.conditions.value.length : null;
      title = total ? `Approved with ${total} ${total === 1 ? "condition" : "conditions"}` : "Approved";
      break;
    }
    case "under_review":
      title = "Awaiting a decision";
      tone = "info";
      break;
    case "needs_info":
      title = "Sent back for information";
      tone = "warn";
      break;
    case "rejected":
      title = "Rejected";
      tone = "danger";
      break;
    case "proposed":
      title = "Not yet submitted for review";
      tone = "neutral";
      break;
    default:
      title = statusLabel(input.status);
      tone = "neutral";
  }
  // only a decided round names who decided; an open review names nobody
  const open = input.status === "under_review" || input.status === "proposed";
  return { title, tone, by: open ? null : by, quorum };
}

/** a line of "Why it was approved", each from a flag the record holds */
export interface CheckLine {
  key: string;
  ok: boolean;
  text: string;
}

export function approvalChecklist(data: OverviewResponse, conditions: Read<UseCaseCondition[]>): CheckLine[] {
  const lines: CheckLine[] = [];
  lines.push({ key: "questionnaire", ok: data.questionnaire.submitted, text: data.questionnaire.submitted ? "Intake questionnaire submitted" : "Intake questionnaire not submitted" });
  lines.push({
    key: "screening",
    ok: data.screening.screened && data.screening.tier !== "prohibited",
    text: data.screening.screened ? `EU AI Act screening complete: ${data.screening.tier ?? "unknown"} tier` : "EU AI Act screening not done",
  });
  const n = data.risks.length;
  const rated = data.risks.filter((r) => r.residual !== null).length;
  lines.push({ key: "risks", ok: n > 0 && rated === n, text: n ? `${rated} of ${n} ${n === 1 ? "risk has" : "risks have"} a residual rating` : "No risks registered" });
  if (data.summary.liveRisks > 0) {
    lines.push({
      key: "controls",
      ok: data.summary.liveWithoutControls === 0,
      text: data.summary.liveWithoutControls === 0 ? "Every live risk has a linked control" : `${data.summary.liveWithoutControls} live ${data.summary.liveWithoutControls === 1 ? "risk has" : "risks have"} no linked control`,
    });
  }
  if (data.stack.agents.length > 0) {
    const missing = data.summary.agentsWithoutApprovedModelCard;
    lines.push({ key: "model-cards", ok: missing === 0, text: missing === 0 ? "Every agent has an approved model card" : `${missing} ${missing === 1 ? "agent has" : "agents have"} no approved model card` });
  }
  if (conditions.state === "ok") {
    for (const c of conditions.value.filter((x) => x.status === "open")) {
      lines.push({ key: `cond-${c.id}`, ok: false, text: `${c.text} (condition, ${c.blocking ? "before go-live" : "after go-live"})` });
    }
  }
  return lines;
}

/** the recorded reason of the newest approving decision, where the record has one */
export function approvalReason(approvals: OverviewResponse["approvals"]): string | null {
  const row = approvals
    .filter((a) => a.status === "approved" && a.decidedAt)
    .sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""))[0];
  return row?.decisionReason?.trim() || null;
}
