/**
 * The review task's decision model, kept pure so the four outcomes and their
 * validation are unit-tested apart from the drawer that renders them.
 *
 * Four outcomes for an AI use-case sign-off (ADR-0168 §4):
 *   approve · approve with conditions · send back for information · reject.
 * Every other approval kind keeps the plain approve / deny pair.
 */
import type { Approval, DecideApprovalBody } from "../../api/types";

export type ReviewOutcome = "approve" | "approve_conditions" | "return" | "reject";

export const OUTCOMES: Array<{ id: ReviewOutcome; label: string; hint: string; submit: string }> = [
  { id: "approve", label: "Approve", hint: "The use case can go ahead as submitted.", submit: "Approve" },
  {
    id: "approve_conditions",
    label: "Approve with conditions",
    hint: "Approve, with conditions that have an owner and a due date. A before-go-live condition holds deployment until it is met.",
    submit: "Approve with conditions",
  },
  {
    id: "return",
    label: "Send back for information",
    hint: "Return it to the proposer with what is missing. They update the questionnaire and it comes back to you.",
    submit: "Send back",
  },
  { id: "reject", label: "Reject", hint: "The use case does not go ahead.", submit: "Reject" },
];

export interface ConditionDraft {
  key: string;
  text: string;
  ownerUserId: string;
  dueAt: string;
  blocking: boolean;
}

export interface ReviewDraft {
  outcome: ReviewOutcome | null;
  reason: string;
  conditions: ConditionDraft[];
}

let seq = 0;
export const blankCondition = (): ConditionDraft => ({ key: `c${++seq}`, text: "", ownerUserId: "", dueAt: "", blocking: true });

export interface ReviewErrors {
  outcome?: string;
  reason?: string;
  conditions?: string;
  rows: Record<string, { text?: string; dueAt?: string }>;
}

export const hasErrors = (e: ReviewErrors) =>
  Boolean(e.outcome || e.reason || e.conditions || Object.values(e.rows).some((r) => r.text || r.dueAt));

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
  return errors;
}

/** the exact body POST /v1/approvals/:id/decide receives for a draft that validated */
export function decisionBody(draft: ReviewDraft): DecideApprovalBody {
  const reason = draft.reason.trim();
  const withReason = reason ? { reason } : {};
  switch (draft.outcome) {
    case "approve":
      return { decision: "approved", ...withReason };
    case "approve_conditions":
      return {
        decision: "approved",
        ...withReason,
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
