import { describe, expect, it } from "vitest";
import { AUTONOMY_CLASSES, belowObservedCopy, floorSummary } from "./autonomyModel";

describe("ADR-0180 A8 autonomy model (SPA mirror)", () => {
  it("keeps the shared class order, least to most autonomous", () => {
    expect(AUTONOMY_CLASSES).toEqual(["assist", "supervised", "delegated", "autonomous"]);
  });
  it("says what a below-observed declaration means", () => {
    const declared = { class: "supervised" as const, note: null, declaredBy: null, declaredAt: "2026-10-05T00:00:00Z" };
    expect(belowObservedCopy({ declared, observed: { class: "autonomous", reasons: [], facts: {}, windowDays: 30 }, effective: "autonomous" })).toBe(
      "You declared Supervised, but the agent is set up or seen acting as Autonomous. The Autonomous controls still apply, and governance monitoring reports the gap until the two match.",
    );
    expect(belowObservedCopy({ declared: null, observed: { class: "assist", reasons: [], facts: {}, windowDays: 30 }, effective: "assist" })).toBe("");
  });
  it("summarises the floor", () => {
    expect(floorSummary([])).toBe("An assistant needs no extra controls.");
    expect(floorSummary([{ met: true }, { met: true }])).toBe("All 2 in place.");
    expect(floorSummary([{ met: false }, { met: true }])).toMatch(/^1 of 2 not in place\./);
  });
});
