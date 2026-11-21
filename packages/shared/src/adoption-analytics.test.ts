import { describe, expect, it } from "vitest";
import {
  ADOPTION_POLICY_DEFAULTS,
  adoptionPolicyRelaxations,
  resolveAdoptionWindow,
  seatUtilisation,
  setAdoptionPolicySchema,
  suppressCount,
} from "./adoption-analytics.js";

const NOW = new Date("2026-11-17T00:00:00Z");
const strict = { ...ADOPTION_POLICY_DEFAULTS };

describe("ADR-0358 adoption analytics contract", () => {
  it("defaults are strict: ranking off, cohort 5", () => {
    expect(strict).toEqual({ perPersonRanking: false, minCohortSize: 5 });
  });

  it("names only real relaxations", () => {
    expect(adoptionPolicyRelaxations({ perPersonRanking: true }, strict)).toEqual({ perPersonRanking: true });
    expect(adoptionPolicyRelaxations({ minCohortSize: 3 }, strict)).toEqual({ minCohortSize: 3 });
    expect(adoptionPolicyRelaxations({ minCohortSize: 9, perPersonRanking: false }, strict)).toEqual({});
    // already relaxed further: tightening part-way back is not a new relaxation
    expect(adoptionPolicyRelaxations({ minCohortSize: 3 }, { perPersonRanking: true, minCohortSize: 1 })).toEqual({});
    expect(adoptionPolicyRelaxations({ perPersonRanking: true }, { perPersonRanking: true, minCohortSize: 5 })).toEqual({});
  });

  it("suppresses counts between 1 and the cohort minus one, never zero", () => {
    expect(suppressCount(0, 5)).toEqual({ value: 0, suppressed: false });
    expect(suppressCount(4, 5)).toEqual({ value: null, suppressed: true });
    expect(suppressCount(5, 5)).toEqual({ value: 5, suppressed: false });
    expect(suppressCount(1, 1)).toEqual({ value: 1, suppressed: false });
  });

  it("resolves and bounds the window", () => {
    expect(resolveAdoptionWindow({}, NOW)).toEqual({ from: new Date("2026-10-18T00:00:00Z"), to: NOW });
    expect(() => resolveAdoptionWindow({ from: "2025-01-01T00:00:00Z" }, NOW)).toThrow(/366/);
    expect(() => resolveAdoptionWindow({ from: "2026-01-01T00:00:00Z" }, NOW, "day")).toThrow(/92/);
    expect(() => resolveAdoptionWindow({ from: "2026-11-18T00:00:00Z" }, NOW)).toThrow(/before/);
  });

  it("utilisation is null when activity is unknown or nothing is licensed", () => {
    expect(seatUtilisation({ licensed: 10, activeLicensed: 0, activeWithoutSeat: 0, activityKnown: false })).toBeNull();
    expect(seatUtilisation({ licensed: 0, activeLicensed: 0, activeWithoutSeat: 3, activityKnown: true })).toBeNull();
    expect(seatUtilisation({ licensed: 3, activeLicensed: 2, activeWithoutSeat: 0, activityKnown: true })).toBe(0.6667);
  });

  it("requires a reason and at least one field", () => {
    expect(setAdoptionPolicySchema.safeParse({ perPersonRanking: true }).success).toBe(false);
    expect(setAdoptionPolicySchema.safeParse({ reason: "x" }).success).toBe(false);
    expect(setAdoptionPolicySchema.safeParse({ minCohortSize: 51, reason: "x" }).success).toBe(false);
    expect(setAdoptionPolicySchema.safeParse({ minCohortSize: 1, reason: "x" }).success).toBe(true);
  });
});
