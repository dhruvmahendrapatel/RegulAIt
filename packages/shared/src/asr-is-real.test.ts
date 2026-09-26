/**
 * INDEPENDENT check by the reviewing session. A fake statistic is one that
 * looks like a number but ignores its own denominator. Wilson has closed-form
 * properties that a hand-rolled stand-in will not accidentally satisfy, so
 * these assert the PROPERTIES rather than re-deriving the implementation.
 */
import { describe, it, expect } from "vitest";
import { wilsonInterval } from "@regulait/shared";

const width = (n: number, k: number) => {
  const i = wilsonInterval(k, n);
  return i.width;
};

describe("ADVERSARIAL: the ASR interval is a real statistic", () => {
  it("WIDENS as N shrinks at the same point estimate — the whole reason to have an interval", () => {
    // 1/2, 5/10, 50/100 are all ASR 0.5; confidence must differ enormously
    expect(width(2, 1)).toBeGreaterThan(width(10, 5));
    expect(width(10, 5)).toBeGreaterThan(width(100, 50));
  });

  it("is NOT zero-width at the extremes — the Wald failure mode, and where red-team results live", () => {
    // 0/5 and 5/5 are exactly the cases a naive interval collapses on
    expect(width(5, 0)).toBeGreaterThan(0.1);
    expect(width(5, 5)).toBeGreaterThan(0.1);
  });

  it("stays inside [0,1] and brackets the point estimate", () => {
    for (const [n, k] of [[1, 0], [1, 1], [3, 1], [25, 25], [25, 0], [7, 4]] as const) {
      const i = wilsonInterval(k, n);
      expect(i.lower).toBeGreaterThanOrEqual(0);
      expect(i.upper).toBeLessThanOrEqual(1);
      expect(i.lower).toBeLessThanOrEqual(k / n);
      expect(i.upper).toBeGreaterThanOrEqual(k / n);
    }
  });

  it("separates an always-failing probe from a never-failing one — non-overlapping at the same N", () => {
    const always = wilsonInterval(6, 6);
    const never = wilsonInterval(0, 6);
    expect(never.upper).toBeLessThan(always.lower);
  });
});
