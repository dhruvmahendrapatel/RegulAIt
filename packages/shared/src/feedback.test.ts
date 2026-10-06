/**
 * ADR-0182 A13 — the pure half of feedback and appeal: due times, the SLA
 * chip, transitions, separation of duties, routing, the two metrics.
 */
import { describe, expect, it } from "vitest";
import {
  appealOverturnRate,
  appealSodConflict,
  feedbackDueDates,
  feedbackRouteTo,
  feedbackSlaState,
  feedbackSubjectKey,
  feedbackTransitionProblem,
  userReportRatePer1k,
} from "./feedback.js";

const H = 3_600_000;
const D = 86_400_000;
const t0 = new Date("2026-10-06T00:00:00.000Z");

describe("feedbackDueDates", () => {
  it("is ackHours × 1 h and resolveDays × 24 h after receipt, in UTC", () => {
    const d = feedbackDueDates(t0, { ackHours: 72, resolveDays: 30 });
    expect(d.ackDueAt.toISOString()).toBe("2026-10-09T00:00:00.000Z");
    expect(d.resolveDueAt.toISOString()).toBe("2026-11-05T00:00:00.000Z");
  });
  it("never puts acknowledgement after resolution", () => {
    const d = feedbackDueDates(t0, { ackHours: 168, resolveDays: 1 });
    expect(d.ackDueAt.getTime()).toBe(d.resolveDueAt.getTime());
  });
});

describe("feedbackSlaState", () => {
  const item = { ackDueAt: new Date(t0.getTime() + 72 * H), resolveDueAt: new Date(t0.getTime() + 30 * D), acknowledgedAt: null, resolvedAt: null };
  it("on time, then due soon within 24 h, then breached", () => {
    expect(feedbackSlaState(item, t0).chip).toBe("on_time");
    expect(feedbackSlaState(item, new Date(t0.getTime() + 50 * H)).chip).toBe("due_soon");
    const late = feedbackSlaState(item, new Date(t0.getTime() + 72 * H));
    expect(late.chip).toBe("breached");
    expect(late.breached).toEqual(["acknowledge"]);
  });
  it("acknowledged moves to the resolution phase; unacknowledged past resolution breaches both", () => {
    const acked = feedbackSlaState({ ...item, acknowledgedAt: t0 }, new Date(t0.getTime() + 80 * H));
    expect(acked.phase).toBe("resolve");
    expect(acked.chip).toBe("on_time");
    expect(feedbackSlaState(item, new Date(t0.getTime() + 31 * D)).breached).toEqual(["acknowledge", "resolve"]);
  });
  it("a resolved item is done", () => {
    expect(feedbackSlaState({ ...item, resolvedAt: t0 }, new Date(t0.getTime() + 99 * D))).toEqual({ phase: "done", chip: "done", dueAt: null, breached: [] });
  });
  it("subject keys are stable per phase", () => {
    expect(feedbackSubjectKey("u", "f", "acknowledge")).toBe("use_case:u>feedback:f>acknowledge");
  });
});

describe("feedbackTransitionProblem", () => {
  it("upheld/overturned are an appeal's outcomes only", () => {
    expect(feedbackTransitionProblem("problem", "acknowledged", "upheld")).toBe("appeal_outcome_on_problem");
    expect(feedbackTransitionProblem("appeal", "acknowledged", "overturned")).toBeNull();
  });
  it("a resolved item is final, and an acknowledged one does not go back to received", () => {
    expect(feedbackTransitionProblem("appeal", "upheld", "in_review")).toBe("feedback_already_resolved");
    expect(feedbackTransitionProblem("problem", "in_review", "received")).toBe("feedback_status_backwards");
  });
});

describe("separation of duties and routing", () => {
  it("the contested decision-maker and the filer may not resolve an appeal; a problem is unconstrained", () => {
    expect(appealSodConflict({ kind: "appeal", resolverUserId: "a", submitterUserId: "s", contestedUserId: "a" })).toBe("contested_decision_maker");
    expect(appealSodConflict({ kind: "appeal", resolverUserId: "s", submitterUserId: "s", contestedUserId: null })).toBe("submitter");
    expect(appealSodConflict({ kind: "appeal", resolverUserId: "o", submitterUserId: "s", contestedUserId: "a" })).toBeNull();
    expect(appealSodConflict({ kind: "problem", resolverUserId: "a", submitterUserId: "a", contestedUserId: "a" })).toBeNull();
  });
  it("routes to the owner unless the owner is excluded, then to the admins (null)", () => {
    expect(feedbackRouteTo({ kind: "problem", useCaseOwnerUserId: "o", submitterUserId: "o", contestedUserId: "o" })).toBe("o");
    expect(feedbackRouteTo({ kind: "appeal", useCaseOwnerUserId: "o", submitterUserId: "s", contestedUserId: "o" })).toBeNull();
    expect(feedbackRouteTo({ kind: "appeal", useCaseOwnerUserId: "o", submitterUserId: "s", contestedUserId: "x" })).toBe("o");
  });
});

describe("the two A2 metrics", () => {
  it("user_report_rate is per 1,000 traces, and no traces is no measurement", () => {
    expect(userReportRatePer1k(3, 1500)).toBe(2);
    expect(userReportRatePer1k(0, 10)).toBe(0);
    expect(userReportRatePer1k(5, 0)).toBeNull();
  });
  it("appeal_overturn_rate counts only upheld and overturned", () => {
    expect(appealOverturnRate(3, 1)).toBe(25);
    expect(appealOverturnRate(0, 0)).toBeNull();
  });
});
