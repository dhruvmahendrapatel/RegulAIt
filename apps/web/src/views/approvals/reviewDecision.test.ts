import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client";
import { blankCondition, decideErrorText, decisionBody, hasErrors, intakeUseCaseName, isIntakeSignoff, reviewPosition, validateReview, type ReviewDraft } from "./reviewDecision";

const draft = (patch: Partial<ReviewDraft>): ReviewDraft => ({ outcome: null, reason: "", conditions: [], ...patch });
const cond = (patch: Partial<ReturnType<typeof blankCondition>>) => ({ ...blankCondition(), ...patch });

describe("the review task's four outcomes", () => {
  it("approve sends approved, with the reason only when one was written", () => {
    expect(decisionBody(draft({ outcome: "approve" }))).toEqual({ decision: "approved" });
    expect(decisionBody(draft({ outcome: "approve", reason: "  fine  " }))).toEqual({ decision: "approved", reason: "fine" });
  });

  it("approve with conditions sends each condition; an unassigned owner is omitted, not sent empty", () => {
    const body = decisionBody(draft({
      outcome: "approve_conditions",
      conditions: [
        cond({ text: " Bias test on holdout ", ownerUserId: "u-1", dueAt: "2026-11-01", blocking: true }),
        cond({ text: "Quarterly drift review", ownerUserId: "", dueAt: "2027-01-15", blocking: false }),
      ],
    }));
    expect(body).toEqual({
      decision: "approved",
      conditions: [
        { text: "Bias test on holdout", ownerUserId: "u-1", dueAt: "2026-11-01", blocking: true },
        { text: "Quarterly drift review", dueAt: "2027-01-15", blocking: false },
      ],
    });
  });

  it("send back is `returned` and always carries the reason", () => {
    expect(decisionBody(draft({ outcome: "return", reason: "Add the DPIA" }))).toEqual({ decision: "returned", reason: "Add the DPIA" });
  });

  it("reject is `denied`", () => {
    expect(decisionBody(draft({ outcome: "reject", reason: "Prohibited purpose" }))).toEqual({ decision: "denied", reason: "Prohibited purpose" });
  });
});

describe("validation", () => {
  it("needs a decision", () => {
    expect(validateReview(draft({}), null).outcome).toBeTruthy();
  });
  it("send back needs a reason; whitespace is not one", () => {
    expect(validateReview(draft({ outcome: "return", reason: "   " }), null).reason).toMatch(/missing/);
    expect(hasErrors(validateReview(draft({ outcome: "return", reason: "Add the DPIA" }), null))).toBe(false);
  });
  it("an admin deciding in the reviewer's place needs a reason for any outcome", () => {
    expect(validateReview(draft({ outcome: "approve" }), "override reason needed").reason).toBe("override reason needed");
    expect(hasErrors(validateReview(draft({ outcome: "approve" }), null))).toBe(false);
  });
  it("each condition needs text and a due date; approve-with-conditions needs at least one", () => {
    const empty = cond({});
    const e = validateReview(draft({ outcome: "approve_conditions", conditions: [empty] }), null);
    expect(e.rows[empty.key]).toEqual({ text: "Describe the condition.", dueAt: "Choose a due date." });
    expect(validateReview(draft({ outcome: "approve_conditions", conditions: [] }), null).conditions).toBeTruthy();
    expect(hasErrors(validateReview(draft({ outcome: "approve_conditions", conditions: [cond({ text: "x", dueAt: "2026-11-01" })] }), null))).toBe(false);
  });
  it("conditions are ignored for a plain approve", () => {
    expect(hasErrors(validateReview(draft({ outcome: "approve", conditions: [cond({})] }), null))).toBe(false);
  });
});

describe("which approvals are an AI use-case sign-off", () => {
  it("a workflow approval on an intake instance", () => {
    expect(isIntakeSignoff({ objectType: "workflow", instanceId: "i", objectLabel: "AI use-case intake: Credit assistant" })).toBe(true);
    expect(intakeUseCaseName({ objectLabel: "AI use-case intake: Credit assistant" })).toBe("Credit assistant");
  });
  it("not any other workflow, MCP action or run", () => {
    expect(isIntakeSignoff({ objectType: "workflow", instanceId: "i", objectLabel: "Deploy billing" })).toBe(false);
    expect(isIntakeSignoff({ objectType: "mcp_tool", instanceId: null, objectLabel: "AI use-case intake: x" })).toBe(false);
    expect(isIntakeSignoff({ objectType: "workflow", instanceId: null, objectLabel: "AI use-case intake: x" })).toBe(false);
  });
});

describe("risk acceptance on an approval (ADR-0168 amendment)", () => {
  const accept = (patch: Partial<NonNullable<ReviewDraft["acceptRisk"]>> = {}) => ({ on: true, riskIds: ["r1", "r2"], rationale: "  Residual is low after human review.  ", ...patch });

  it("rides on approve and on approve with conditions, rationale trimmed", () => {
    expect(decisionBody(draft({ outcome: "approve", acceptRisk: accept() }))).toEqual({
      decision: "approved",
      acceptRisks: { riskIds: ["r1", "r2"], rationale: "Residual is low after human review." },
    });
    const withConditions = decisionBody(draft({
      outcome: "approve_conditions",
      conditions: [cond({ text: "Bias test", dueAt: "2026-11-01" })],
      acceptRisk: accept({ riskIds: ["r2"] }),
    }));
    expect(withConditions.acceptRisks).toEqual({ riskIds: ["r2"], rationale: "Residual is low after human review." });
  });

  it("is never sent when switched off, or with send back or reject", () => {
    expect(decisionBody(draft({ outcome: "approve", acceptRisk: accept({ on: false }) }))).toEqual({ decision: "approved" });
    expect(decisionBody(draft({ outcome: "return", reason: "Need the DPIA", acceptRisk: accept() }))).toEqual({ decision: "returned", reason: "Need the DPIA" });
    expect(decisionBody(draft({ outcome: "reject", acceptRisk: accept() }))).toEqual({ decision: "denied" });
  });

  it("needs at least one risk and a 10..2000 character rationale", () => {
    const none = validateReview(draft({ outcome: "approve", acceptRisk: accept({ riskIds: [], rationale: "too short" }) }), null);
    expect(none.acceptRisks).toBe("Choose at least one risk to accept.");
    expect(none.acceptRationale).toBe("Say why the residual risk is acceptable — at least 10 characters.");
    expect(hasErrors(none)).toBe(true);
    expect(validateReview(draft({ outcome: "approve", acceptRisk: accept({ rationale: "x".repeat(2001) }) }), null).acceptRationale).toBe("Keep the rationale under 2,000 characters.");
    // controls: a valid acceptance, and an invalid one that is switched off, both pass
    expect(hasErrors(validateReview(draft({ outcome: "approve", acceptRisk: accept() }), null))).toBe(false);
    expect(hasErrors(validateReview(draft({ outcome: "approve", acceptRisk: accept({ on: false, riskIds: [] }) }), null))).toBe(false);
  });

  it("names the two risk-acceptance refusals in words", () => {
    expect(decideErrorText(new ApiError(403, { error: "not_a_risk_acceptor" })).aboutRiskAcceptance).toBe(true);
    expect(decideErrorText(new ApiError(422, { error: "risk_not_on_use_case" })).text).toMatch(/no longer on this use case/);
    expect(decideErrorText(new Error("boom"))).toEqual({ text: "boom", aboutRiskAcceptance: false });
  });

  it("says which review of the round this is", () => {
    const reviews = [{ approvalId: "a" }, { approvalId: "b" }, { approvalId: "c" }];
    expect(reviewPosition(reviews, "b")).toEqual({ index: 2, total: 3 });
    expect(reviewPosition(reviews, "z")).toBeNull();
    expect(reviewPosition([], "a")).toBeNull();
  });
});
