/**
 * The review task's decision model, kept pure so the four outcomes and their
 * validation are unit-tested apart from the drawer that renders them.
 *
 * Four outcomes for an AI use-case sign-off (ADR-0168 §4):
 *   approve · approve with conditions · send back for information · reject.
 * Every other approval kind keeps the plain approve / deny pair.
 */
import { ApiError } from "../../api/client";
import type { Approval, DecideApprovalBody } from "../../api/types";

export type ReviewOutcome = "approve" | "approve_conditions" | "return" | "reject";

export const OUTCOMES: Array<{ id: ReviewOutcome; label: string; hint: string; submit: string }> = [
  { id: "approve", label: "Approve", hint: "It goes ahead as submitted.", submit: "Approve" },
  {
    id: "approve_conditions",
    label: "Approve with conditions",
    hint: "It goes ahead with conditions, each with an owner and a due date.",
    submit: "Approve with conditions",
  },
  {
    id: "return",
    label: "Send back for information",
    hint: "The proposer adds what is missing; it comes back to you.",
    submit: "Send back",
  },
  { id: "reject", label: "Reject", hint: "It does not go ahead.", submit: "Reject" },
];

export interface ConditionDraft {
  key: string;
  text: string;
  ownerUserId: string;
  dueAt: string;
  blocking: boolean;
}

/** a risk acceptor accepting residual risk as part of an approval (ADR-0168 amendment) */
export interface RiskAcceptanceDraft {
  on: boolean;
  riskIds: string[];
  rationale: string;
}

export interface ReviewDraft {
  outcome: ReviewOutcome | null;
  reason: string;
  conditions: ConditionDraft[];
  acceptRisk?: RiskAcceptanceDraft;
}

/** risk acceptance rides only on an approval */
export const approves = (outcome: ReviewOutcome | null) => outcome === "approve" || outcome === "approve_conditions";
const accepting = (draft: ReviewDraft) => approves(draft.outcome) && Boolean(draft.acceptRisk?.on);

let seq = 0;
export const blankCondition = (): ConditionDraft => ({ key: `c${++seq}`, text: "", ownerUserId: "", dueAt: "", blocking: true });

export interface ReviewErrors {
  outcome?: string;
  reason?: string;
  conditions?: string;
  rows: Record<string, { text?: string; dueAt?: string }>;
  acceptRisks?: string;
  acceptRationale?: string;
}

export const hasErrors = (e: ReviewErrors) =>
  Boolean(e.outcome || e.reason || e.conditions || e.acceptRisks || e.acceptRationale || Object.values(e.rows).some((r) => r.text || r.dueAt));

/** the AI use-case intake's own sign-off: a workflow approval on an instance the intake started */
export const INTAKE_LABEL_PREFIX = "AI use-case intake: ";
export function isIntakeSignoff(a: Pick<Approval, "objectType" | "instanceId" | "objectLabel">): boolean {
  return a.objectType === "workflow" && Boolean(a.instanceId) && (a.objectLabel ?? "").startsWith(INTAKE_LABEL_PREFIX);
}
export const intakeUseCaseName = (a: Pick<Approval, "objectLabel">) =>
  (a.objectLabel ?? "").startsWith(INTAKE_LABEL_PREFIX) ? (a.objectLabel ?? "").slice(INTAKE_LABEL_PREFIX.length) : (a.objectLabel ?? "");

/**
 * What must be true before the decision is sent. `reasonRequiredBecause` is
 * the separation-of-duties rule the server enforces too (an admin deciding in
 * someone else's place, a delegation onto the requester) — said up front
 * rather than as a refusal after the click.
 */
export function validateReview(draft: ReviewDraft, reasonRequiredBecause: string | null): ReviewErrors {
  const errors: ReviewErrors = { rows: {} };
  if (!draft.outcome) errors.outcome = "Choose a decision.";
  const reason = draft.reason.trim();
  if (draft.outcome === "return" && !reason) errors.reason = "Say what information is missing — the proposer sees this.";
  else if (draft.outcome && reasonRequiredBecause && !reason) errors.reason = reasonRequiredBecause;
  if (draft.outcome === "approve_conditions") {
    if (draft.conditions.length === 0) errors.conditions = "Add at least one condition, or choose Approve.";
    for (const c of draft.conditions) {
      const row: { text?: string; dueAt?: string } = {};
      if (!c.text.trim()) row.text = "Describe the condition.";
      else if (c.text.trim().length > 500) row.text = "Keep the condition under 500 characters.";
      if (!c.dueAt) row.dueAt = "Choose a due date.";
      if (row.text || row.dueAt) errors.rows[c.key] = row;
    }
  }
  if (accepting(draft)) {
    const rationale = draft.acceptRisk!.rationale.trim();
    if (draft.acceptRisk!.riskIds.length === 0) errors.acceptRisks = "Choose at least one risk to accept.";
    if (rationale.length < 10) errors.acceptRationale = "Say why the residual risk is acceptable — at least 10 characters.";
    else if (rationale.length > 2000) errors.acceptRationale = "Keep the rationale under 2,000 characters.";
  }
  return errors;
}

/** the exact body POST /v1/approvals/:id/decide receives for a draft that validated */
export function decisionBody(draft: ReviewDraft): DecideApprovalBody {
  const reason = draft.reason.trim();
  const withReason = reason ? { reason } : {};
  const withAcceptance = accepting(draft)
    ? { acceptRisks: { riskIds: [...draft.acceptRisk!.riskIds], rationale: draft.acceptRisk!.rationale.trim() } }
    : {};
  switch (draft.outcome) {
    case "approve":
      return { decision: "approved", ...withReason, ...withAcceptance };
    case "approve_conditions":
      return {
        decision: "approved",
        ...withReason,
        ...withAcceptance,
        conditions: draft.conditions.map((c) => ({
          text: c.text.trim(),
          ...(c.ownerUserId ? { ownerUserId: c.ownerUserId } : {}),
          dueAt: c.dueAt,
          blocking: c.blocking,
        })),
      };
    case "return":
      return { decision: "returned", reason };
    case "reject":
      return { decision: "denied", ...withReason };
    default:
      throw new Error("no decision chosen");
  }
}

export const outcomeToast: Record<ReviewOutcome, string> = {
  approve: "Approved",
  approve_conditions: "Approved with conditions",
  return: "Sent back for information",
  reject: "Rejected",
};

/**
 * A refused decision in words the reviewer can act on. The two risk-acceptance
 * refusals name what to change; anything else keeps the gateway's message.
 */
export function decideErrorText(error: unknown): { text: string; aboutRiskAcceptance: boolean } {
  if (error instanceof ApiError && error.payload.error === "not_a_risk_acceptor")
    return { text: "The decision was refused: you are not named as a risk acceptor in the review policy. Clear “Accept residual risk” to decide without it.", aboutRiskAcceptance: true };
  if (error instanceof ApiError && error.payload.error === "risk_not_on_use_case")
    return { text: "The decision was refused: a chosen risk is no longer on this use case. Reload the review and choose again.", aboutRiskAcceptance: true };
  return { text: error instanceof Error ? error.message : String(error), aboutRiskAcceptance: false };
}

const REVIEW_STATUS: Record<string, string> = {
  pending: "Awaiting decision",
  approved: "Approved",
  returned: "Sent back",
  denied: "Rejected",
  superseded: "Closed — another review ended the round",
};
export const reviewStatusLabel = (status: string) => REVIEW_STATUS[status] ?? status;

/** "Privacy review · 1 of 3 reviews" — which required review this approval is */
export function reviewPosition<T extends { approvalId: string }>(reviews: readonly T[] | undefined, approvalId: string): { index: number; total: number } | null {
  if (!reviews || reviews.length === 0) return null;
  const at = reviews.findIndex((r) => r.approvalId === approvalId);
  return at < 0 ? null : { index: at + 1, total: reviews.length };
}
