import { describe, expect, it } from "vitest";
import { packRatios, pctText } from "./packRatios";

describe("ADR-0175 — pack coverage beside pass rate", () => {
  it("coverage is evidence-backed ÷ mapped; passing is satisfied ÷ evidence-backed", () => {
    // 31 mapped, 25 with a collector (20 met, 5 did not), 6 attestation-only
    const r = packRatios({ controls: 31, satisfied: 20, unsatisfied: 5 });
    expect(r).toEqual({ mapped: 31, withEvidence: 25, passing: 20, coveragePct: 80, passingPct: 80 });
  });

  it("the same pass rate reads differently once coverage sits beside it", () => {
    const narrow = packRatios({ controls: 5, satisfied: 4, unsatisfied: 1 });
    const wide = packRatios({ controls: 31, satisfied: 4, unsatisfied: 1 });
    expect(narrow.passingPct).toBe(wide.passingPct);
    expect(narrow.coveragePct).toBe(100);
    expect(wide.coveragePct).toBe(16);
  });

  it("nothing evidence-backed is UNKNOWN, never 0% or 100%", () => {
    const r = packRatios({ controls: 3, satisfied: 0, unsatisfied: 0 });
    expect(r.coveragePct).toBe(0);
    expect(r.passingPct).toBeNull();
    expect(pctText(r.passingPct)).toBe("unknown");
    expect(packRatios({ controls: 0, satisfied: 0, unsatisfied: 0 }).coveragePct).toBeNull();
  });

  it("rounds down, so a near-miss never reads as complete", () => {
    expect(packRatios({ controls: 200, satisfied: 199, unsatisfied: 0 }).coveragePct).toBe(99);
    expect(packRatios({ controls: 200, satisfied: 199, unsatisfied: 1 }).passingPct).toBe(99);
  });
});
