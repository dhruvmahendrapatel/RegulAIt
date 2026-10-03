import { describe, expect, it } from "vitest";
import {
  cadenceSentence,
  dateInputToIso,
  draftOf,
  matchesFilter,
  reviewCell,
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
