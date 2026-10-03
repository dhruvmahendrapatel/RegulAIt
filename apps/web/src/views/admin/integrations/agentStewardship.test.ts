import { describe, expect, it } from "vitest";
import {
  cadenceSentence,
  dateInputToIso,
  draftOf,
  lifecycleChoices,
  matchesFilter,
  reviewCell,
  stewardReviewLimit,
  stewardshipPatch,
  type AgentStewardship,
} from "./agentStewardship";

const agent = (over: Partial<AgentStewardship> = {}): AgentStewardship => ({
  stewardUserId: "ada",
  successorUserId: "dana",
  lifecycleStatus: "active",
  lifecycleReason: null,
  nextReviewAt: "2027-01-13T12:00:00.000Z",
  orphaned: false,
  reviewOverdue: false,
  reviewCadenceMonths: 12,
  highestUseCaseTier: null,
  ...over,
});

describe("filters", () => {
  it("orphaned and overdue select only flagged rows; all selects everything", () => {
    const rows = [agent(), agent({ orphaned: true }), agent({ reviewOverdue: true })];
    expect(rows.filter((r) => matchesFilter(r, "orphaned"))).toHaveLength(1);
    expect(rows.filter((r) => matchesFilter(r, "overdue"))).toHaveLength(1);
    expect(rows.filter((r) => matchesFilter(r, "all"))).toHaveLength(3);
  });
});

describe("the next-review cell", () => {
  it("says a date, not scheduled, or overdue since the date — and nothing for a retired agent", () => {
    expect(reviewCell(agent())).toEqual({ text: "13 Jan 2027", overdue: false });
    expect(reviewCell(agent({ nextReviewAt: null }))).toEqual({ text: "Not scheduled", overdue: false });
    expect(reviewCell(agent({ reviewOverdue: true }))).toEqual({ text: "Overdue since 13 Jan 2027", overdue: true });
    expect(reviewCell(agent({ lifecycleStatus: "retired" })).text).toBe("—");
  });

  it("explains the cadence from the riskiest use case", () => {
    expect(cadenceSentence(agent({ reviewCadenceMonths: 6, highestUseCaseTier: "high" }))).toMatch(/every 6 months, because a high-risk use case/);
    expect(cadenceSentence(agent())).toMatch(/every 12 months\. No screened use case/);
  });
});

describe("the PATCH body", () => {
  it("is null when nothing changed", () => {
    expect(stewardshipPatch(agent(), draftOf(agent()))).toEqual({ body: null, problem: null });
  });

  it("sends only what changed; empty means clear", () => {
    const d = { ...draftOf(agent()), successorUserId: "", nextReview: "2027-02-01" };
    expect(stewardshipPatch(agent(), d, "2026-10-03").body).toEqual({ successorUserId: null, nextReviewAt: dateInputToIso("2027-02-01") });
  });

  it("refuses a new next-review date that is not after today, but keeps an overdue stored one savable", () => {
    const overdue = agent({ nextReviewAt: "2026-09-20T12:00:00.000Z", reviewOverdue: true });
    expect(stewardshipPatch(overdue, { ...draftOf(overdue), nextReview: "2026-10-03" }, "2026-10-03").problem).toMatch(/after today/);
    expect(stewardshipPatch(overdue, { ...draftOf(overdue), successorUserId: "avery" }, "2026-10-03").body).toEqual({ successorUserId: "avery" });
  });

  it("refuses the steward as successor, and a non-active status without a reason", () => {
    expect(stewardshipPatch(agent(), { ...draftOf(agent()), successorUserId: "ada" }).problem).toMatch(/not the steward/);
    expect(stewardshipPatch(agent(), { ...draftOf(agent()), lifecycleStatus: "suspended" }).problem).toMatch(/reason/);
    expect(stewardshipPatch(agent(), { ...draftOf(agent()), lifecycleStatus: "suspended", lifecycleReason: " incident " }).body).toEqual({
      lifecycleStatus: "suspended",
      lifecycleReason: "incident",
    });
    // returning to active needs no reason
    const suspended = agent({ lifecycleStatus: "suspended", lifecycleReason: "incident" });
    expect(stewardshipPatch(suspended, { ...draftOf(suspended), lifecycleStatus: "active" }).body).toEqual({ lifecycleStatus: "active" });
  });
});

describe("a steward who is not an admin tightens the lifecycle, never loosens it", () => {
  const steward = { isAdmin: false };

  it("the status picker offers a steward only under review and suspended, from a status that still serves", () => {
    expect(lifecycleChoices("active", false)).toEqual(["active", "under_review", "suspended"]);
    expect(lifecycleChoices("under_review", false)).toEqual(["under_review", "suspended"]);
    expect(lifecycleChoices("deprecated", false)).toEqual(["suspended", "deprecated"]);
    // nothing to move to: lifting a suspension, leaving proposed, leaving retired
    expect(lifecycleChoices("suspended", false)).toEqual(["suspended"]);
    expect(lifecycleChoices("proposed", false)).toEqual(["proposed"]);
    expect(lifecycleChoices("retired", false)).toEqual(["retired"]);
    // an admin keeps every status
    expect(lifecycleChoices("suspended", true)).toEqual(["proposed", "active", "under_review", "suspended", "deprecated", "retired"]);
  });

  it("refuses a steward's loosening move before the request; an admin's goes through", () => {
    const suspended = agent({ lifecycleStatus: "suspended", lifecycleReason: "incident" });
    const lift = { ...draftOf(suspended), lifecycleStatus: "active" };
    expect(stewardshipPatch(suspended, lift, "2026-10-03", steward).problem).toMatch(/Only an admin/);
    expect(stewardshipPatch(suspended, lift, "2026-10-03", { isAdmin: true }).body).toEqual({ lifecycleStatus: "active" });
    const retire = { ...draftOf(agent()), lifecycleStatus: "retired", lifecycleReason: "replaced" };
    expect(stewardshipPatch(agent(), retire, "2026-10-03", steward).problem).toMatch(/Only an admin/);
    const suspend = { ...draftOf(agent()), lifecycleStatus: "suspended", lifecycleReason: "incident" };
    expect(stewardshipPatch(agent(), suspend, "2026-10-03", steward).body).toEqual({ lifecycleStatus: "suspended", lifecycleReason: "incident" });
  });

  it("caps a steward's next review at the cadence and keeps them from clearing it", () => {
    expect(stewardReviewLimit(agent({ reviewCadenceMonths: 12 }), "2026-10-03")).toBe("2027-10-02");
    expect(stewardReviewLimit(agent({ reviewCadenceMonths: 6 }), "2026-10-03")).toBe("2027-04-02");
    const a = agent({ reviewCadenceMonths: 6 });
    expect(stewardshipPatch(a, { ...draftOf(a), nextReview: "2027-04-03" }, "2026-10-03", steward).problem).toMatch(/every 6 months/);
    expect(stewardshipPatch(a, { ...draftOf(a), nextReview: "2027-04-02" }, "2026-10-03", steward).body).toEqual({
      nextReviewAt: dateInputToIso("2027-04-02"),
    });
    expect(stewardshipPatch(a, { ...draftOf(a), nextReview: "" }, "2026-10-03", steward).problem).toMatch(/Only an admin can clear/);
    // an admin may schedule beyond the cadence and clear it
    expect(stewardshipPatch(a, { ...draftOf(a), nextReview: "2028-01-01" }, "2026-10-03").body).toEqual({ nextReviewAt: dateInputToIso("2028-01-01") });
    expect(stewardshipPatch(a, { ...draftOf(a), nextReview: "" }, "2026-10-03").body).toEqual({ nextReviewAt: null });
    // an unchanged stored date beyond the cadence (an admin set it) does not block a steward's other edits
    const far = agent({ reviewCadenceMonths: 6, nextReviewAt: "2028-06-01T12:00:00.000Z" });
    expect(stewardshipPatch(far, { ...draftOf(far), successorUserId: "avery" }, "2026-10-03", steward).body).toEqual({ successorUserId: "avery" });
  });
});
