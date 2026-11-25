/** ADR-0359 — the behaviour baseline statistics, against hand-computed values. */
import { describe, expect, it } from "vitest";
import { BEHAVIOUR_BASELINE, evaluateCategory, evaluateVolume } from "./behaviour-baseline.js";

const days = (n: number, v: number | ((i: number) => number)) => Array.from({ length: n }, (_, i) => (typeof v === "number" ? v : v(i)));

describe("evaluateVolume", () => {
  it("is a cold start below the minimum baseline days and makes no claim", () => {
    const v = evaluateVolume({ signal: "model_calls", observed: 1000, baseline: days(BEHAVIOUR_BASELINE.minBaselineDays - 1, 10) });
    expect(v).toMatchObject({ evaluated: false, fired: false, method: null, baselineDays: 6 });
    expect(v.explanation).toContain("baseline building");
  });

  it("fires on a modified z-score above 3.5 and shows the baseline", () => {
    // baseline 40,42,...: median 50, MAD 5 → z = 0.6745 × (100 − 50) / 5 = 6.745
    const baseline = [40, 45, 50, 55, 60, 45, 55, 50, 50, 50];
    const v = evaluateVolume({ signal: "model_calls", observed: 100, baseline });
    expect(v).toMatchObject({ evaluated: true, fired: true, method: "mad_z", baselineMedian: 50, baselineMad: 5, score: 6.745, threshold: 3.5 });
    expect(v.explanation).toContain("median 50");
    expect(v.explanation).toContain("MAD 5");
  });

  it("is one-sided: a drop never fires", () => {
    const v = evaluateVolume({ signal: "model_calls", observed: 20, baseline: [40, 45, 50, 55, 60, 45, 55, 50] });
    expect(v.fired).toBe(false);
    expect(v.score!).toBeLessThan(0);
  });

  it("does not fire below the absolute floor however unusual", () => {
    const v = evaluateVolume({ signal: "model_calls", observed: 19, baseline: days(10, (i) => i % 2) });
    expect(v).toMatchObject({ evaluated: true, fired: false, score: null });
  });

  it("falls back to 3x the median on a flat baseline and says so", () => {
    const fired = evaluateVolume({ signal: "data_scoped_calls", observed: 30, baseline: days(10, 10) });
    expect(fired).toMatchObject({ fired: true, method: "ratio_over_median", score: 3, threshold: 3, baselineMad: 0 });
    const quiet = evaluateVolume({ signal: "data_scoped_calls", observed: 29, baseline: days(10, 10) });
    expect(quiet.fired).toBe(false);
    const fromZero = evaluateVolume({ signal: "data_scoped_calls", observed: 50, baseline: days(10, 0) });
    expect(fromZero).toMatchObject({ fired: true, score: null });
  });

  it("refuses a category signal", () => {
    expect(() => evaluateVolume({ signal: "tool", observed: 1, baseline: [] })).toThrow(TypeError);
  });
});

describe("evaluateCategory", () => {
  const history = { read_file: 70, list_dir: 29, http_fetch: 1 };

  it("fires on a first-seen key with its share of history", () => {
    const v = evaluateCategory({ signal: "tool", key: "vault_get_secret", observed: 3, history, activeDays: 10 });
    expect(v).toMatchObject({ evaluated: true, fired: true, method: "share_of_history", score: 0, baselineKeyCount: 0, baselineTotal: 100 });
    expect(v.explanation).toContain("first seen");
  });

  it("fires on a rare key (1%) and not on a usual one", () => {
    expect(evaluateCategory({ signal: "tool", key: "http_fetch", observed: 1, history, activeDays: 10 })).toMatchObject({ fired: true, score: 0.01 });
    expect(evaluateCategory({ signal: "tool", key: "list_dir", observed: 5, history, activeDays: 10 }).fired).toBe(false);
  });

  it("is a cold start with too few days or events", () => {
    expect(evaluateCategory({ signal: "hour_of_day", key: "03", observed: 1, history, activeDays: 6 }).evaluated).toBe(false);
    expect(evaluateCategory({ signal: "hour_of_day", key: "03", observed: 1, history: { "09": 19 }, activeDays: 10 }).evaluated).toBe(false);
  });

  it("does not read inherited keys as history", () => {
    const v = evaluateCategory({ signal: "tool", key: "constructor", observed: 1, history, activeDays: 10 });
    expect(v).toMatchObject({ fired: true, baselineKeyCount: 0 });
  });
});
