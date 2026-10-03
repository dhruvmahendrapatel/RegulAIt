import { describe, expect, it } from "vitest";
import { ACTIVITY_STATUS, canMarkMet, conditionState, deriveActivities, phaseFor, statusLabel, type ActivityInput } from "./useCaseLifecycle";

const base: ActivityInput = {
  status: "under_review",
  ownerName: "Ada Owner",
  questionnaire: { submitted: true, version: 2, submittedAt: "2026-10-01T10:00:00Z" },
  screening: { screened: true, tier: "high", reasons: [{ reason: "Essential financial services" }] },
  screenedAt: "2026-10-01T10:00:01Z",
  stack: { agents: [{ name: "Credit assistant", modelCardApproved: true }], vendors: [{ name: "Acme" }] },
  risks: [{ residual: { likelihood: "low", impact: "medium" }, controls: [{}], status: "mitigating" }],
  approvals: [{ status: "pending", approverUserId: "avery", requestedAt: "2026-10-01T10:00:02Z", decidedAt: null }],
  approverName: (id) => (id === "avery" ? "Avery Approver" : null),
};
const byKey = (input: ActivityInput) => Object.fromEntries(deriveActivities(input).map((a) => [a.key, a]));

describe("lifecycle phase", () => {
  it("maps each status onto Proposed → Under review → Approved → Monitoring", () => {
    expect(phaseFor("proposed", {})).toEqual({ current: 0, flag: null });
    expect(phaseFor("under_review", {})).toEqual({ current: 1, flag: null });
    expect(phaseFor("needs_info", {}).current).toBe(1);
    expect(phaseFor("needs_info", {}).flag?.text).toBe("Needs information");
    expect(phaseFor("approved", {})).toEqual({ current: 3, flag: null });
  });
  it("stays at Approved while a before-go-live condition is open", () => {
    expect(phaseFor("approved", { openBlocking: 2 })).toMatchObject({ current: 2, flag: { tone: "warn" } });
  });
  it("an expired approval goes back under review", () => {
    expect(phaseFor("approved", { approvalExpired: true })).toMatchObject({ current: 1, flag: { tone: "danger" } });
  });
  it("labels needs_info for people", () => {
    expect(statusLabel("needs_info")).toBe("Needs information");
  });
});

describe("activities are derived from the record", () => {
  it("a complete submission awaiting sign-off", () => {
    const a = byKey(base);
    expect(a.context!.status).toBe("complete");
    expect(a.context!.detail).toBe("Questionnaire version 2 submitted");
    expect(a.screening!.detail).toBe("High tier — Essential financial services");
    expect(a.stack!.status).toBe("complete");
    expect(a.risks!.status).toBe("complete");
    expect(a.signoff!).toMatchObject({ status: "pending", owner: "Avery Approver", detail: "Awaiting Avery Approver" });
  });
  it("an unrated residual or an uncontrolled live risk is not complete — no implied assurance", () => {
    expect(byKey({ ...base, risks: [{ residual: null, controls: [{}], status: "mitigating" }] }).risks!.status).toBe("in_progress");
    expect(byKey({ ...base, risks: [{ residual: { l: 1 }, controls: [], status: "open" }] }).risks!.status).toBe("in_progress");
    expect(byKey({ ...base, risks: [] }).risks!.status).toBe("not_started");
  });
  it("a use case sent back asks for the questionnaire to be updated", () => {
    const a = byKey({ ...base, status: "needs_info", approvals: [{ status: "returned", approverUserId: "avery", requestedAt: "x", decidedAt: "y" }] });
    expect(a.context!.status).toBe("needs_update");
    expect(a.context!.action.label).toBe("Update questionnaire");
    expect(a.signoff!.status).toBe("returned");
  });
  it("an agent without an approved model card keeps the stack in progress", () => {
    expect(byKey({ ...base, stack: { agents: [{ name: "x", modelCardApproved: false }], vendors: [] } }).stack!.status).toBe("in_progress");
  });
});

describe("conditions", () => {
  const open = { status: "open" as const, ownerUserId: "cond-owner" };
  it("the condition owner, the use-case owner or an admin may mark it met — nobody else", () => {
    expect(canMarkMet(open, { userId: "cond-owner", isAdmin: false }, "uc-owner")).toBe(true);
    expect(canMarkMet(open, { userId: "uc-owner", isAdmin: false }, "uc-owner")).toBe(true);
    expect(canMarkMet(open, { userId: "someone", isAdmin: true }, "uc-owner")).toBe(true);
    expect(canMarkMet(open, { userId: "someone", isAdmin: false }, "uc-owner")).toBe(false);
    expect(canMarkMet({ ...open, status: "met" }, { userId: "cond-owner", isAdmin: true }, "uc-owner")).toBe(false);
  });
  it("overdue shows over open; met and waived are terminal", () => {
    const c = { id: "c", approvalId: "a", text: "t", ownerUserId: null, ownerName: null, dueAt: "2026-01-01", blocking: true, status: "open" as const, metAt: null, metByName: null, overdue: true };
    expect(conditionState(c).label).toBe("Overdue");
    expect(conditionState({ ...c, overdue: false }).label).toBe("Open");
    expect(conditionState({ ...c, status: "met" }).label).toBe("Met");
  });
});

describe("review rounds and re-review (ADR-0168 amendment)", () => {
  it("one sign-off row per required review: role, reviewer, status", () => {
    const rows = deriveActivities({
      ...base,
      reviews: [
        { roleId: "privacy", roleName: "Privacy", status: "approved", deciderName: "Pat Privacy", decidedAt: "2026-10-02T10:00:00Z" },
        { roleId: "security", roleName: "Security", status: "pending", deciderName: null, decidedAt: null },
        { roleId: "model-risk", roleName: "Model risk", status: "returned", deciderName: "Mo Risk", decidedAt: "2026-10-02T11:00:00Z" },
      ],
    });
    const signoffs = rows.filter((a) => a.key.startsWith("signoff"));
    expect(signoffs.map((a) => [a.name, a.status, a.owner, a.detail])).toEqual([
      ["Sign-off: Privacy", "complete", "Pat Privacy", "Approved by Pat Privacy · review 1 of 3"],
      ["Sign-off: Security", "pending", "Security reviewers", "Awaiting a member of Security · review 2 of 3"],
      ["Sign-off: Model risk", "returned", "Mo Risk", "Sent back by Mo Risk · review 3 of 3"],
    ]);
    // control: no reviews keeps the single named-approver row
    expect(deriveActivities({ ...base, reviews: [] }).filter((a) => a.key.startsWith("signoff")).map((a) => a.name)).toEqual(["Sign-off"]);
  });

  it("a review the round closed before it was decided reads closed, never awaiting", () => {
    const rows = deriveActivities({
      ...base,
      reviews: [
        { roleId: "security", roleName: "Security", status: "superseded", deciderName: null, decidedAt: null },
        { roleId: "privacy", roleName: "Privacy", status: "returned", deciderName: "Riley Reviewer", decidedAt: "2026-10-02T11:00:00Z" },
      ],
    });
    const signoffs = rows.filter((a) => a.key.startsWith("signoff"));
    expect(signoffs.map((a) => [a.status, a.owner, a.detail])).toEqual([
      ["closed", "Security reviewers", "Closed — another review ended the round · review 1 of 2"],
      ["returned", "Riley Reviewer", "Sent back by Riley Reviewer · review 2 of 2"],
    ]);
    expect(ACTIVITY_STATUS.closed).toEqual({ label: "Closed", tone: "neutral" });
  });

  it("a recertification reads as a re-review with the expiry date", () => {
    const phase = phaseFor("under_review", { recertification: { dueAt: "2026-09-01T00:00:00" } });
    expect(phase).toEqual({ current: 1, flag: { text: "Re-review: approval expired 1 Sep 2026", tone: "warn" } });
    // control: an ordinary review round has no flag
    expect(phaseFor("under_review", { recertification: null })).toEqual({ current: 1, flag: null });
  });
});
