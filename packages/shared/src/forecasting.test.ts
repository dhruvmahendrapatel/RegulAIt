import { describe, expect, it } from "vitest";
import {
  ANOMALY_ABSOLUTE_FLOORS,
  MIN_BASELINE_SAMPLES,
  activeHours,
  bucketDaily,
  budgetBreachDay,
  decideEnforcement,
  detectAnomaly,
  detectUnusualModel,
  ewma,
  forecastSpend,
  mad,
  median,
  modifiedZ,
  stddev,
} from "./forecasting.js";

/**
 * ADR-0049, the pure half — proved by HAND-COMPUTED EXPECTATION, never by
 * snapshot. Every projection asserted below has its arithmetic written out in
 * the test body, so a change to the formula fails here with a visible diff
 * rather than a re-recorded blob.
 *
 * The two cases this file exists to make impossible to fake:
 *
 *   1. A FORECAST INVENTED FROM NOTHING. The insufficient-data cases assert
 *      `projectedSpendUsd === null` — not 0, not "last period". If the
 *      implementation ever grew a fallback number, these fail.
 *   2. A DETECTOR THAT FIRES ON EVERYTHING. Every "fires on a spike" case is
 *      paired with a "stays silent on normal variance" case built from the SAME
 *      baseline. A detector that passed only the first half would be useless
 *      and would still look green, so the pairing is the point.
 */

describe("ADR-0049 — the small statistics are exact", () => {
  it("median, MAD and the modified z-score match hand arithmetic", () => {
    const xs = [1, 2, 3, 4, 100];
    expect(median(xs)).toBe(3);
    // deviations from median 3: [2,1,0,1,97] -> sorted [0,1,1,2,97] -> median 1
    expect(mad(xs)).toBe(1);
    // 0.6745 * (100 - 3) / 1 = 65.4265
    expect(modifiedZ(100, xs)).toBeCloseTo(65.4265, 4);
    // a perfectly flat baseline has no scale, so the z-score is undefined and
    // the function says so rather than dividing by zero
    expect(modifiedZ(10, [5, 5, 5, 5, 5])).toBeNull();
  });

  it("sample stddev uses n-1 and is zero for a single observation", () => {
    // mean 4; squared devs 4,1,0,1,4 = 10; /(5-1) = 2.5; sqrt = 1.5811...
    expect(stddev([2, 3, 4, 5, 6])).toBeCloseTo(1.5811388, 6);
    expect(stddev([7])).toBe(0);
  });

  it("EWMA is the standard recursion seeded on the first observation", () => {
    // alpha 0.5 over [1,3]: 0.5*3 + 0.5*1 = 2
    expect(ewma([1, 3], 0.5)).toBe(2);
    // over [1,3,5]: prev 2 -> 0.5*5 + 0.5*2 = 3.5
    expect(ewma([1, 3, 5], 0.5)).toBe(3.5);
  });

  it("bucketDaily counts EMPTY days, which is what keeps the mean rate honest", () => {
    const start = new Date("2026-03-01T00:00:00Z");
    const end = new Date("2026-03-05T00:00:00Z");
    const buckets = bucketDaily(
      [
        { at: new Date("2026-03-01T06:00:00Z"), value: 2 },
        { at: new Date("2026-03-01T18:00:00Z"), value: 3 },
        { at: new Date("2026-03-04T01:00:00Z"), value: 5 },
        { at: new Date("2026-02-27T01:00:00Z"), value: 999 }, // outside the window
      ],
      start,
      end,
    );
    expect(buckets).toEqual([5, 0, 0, 5]);
  });
});

describe("ADR-0049 — the forecast is hand-computable", () => {
  /** 10 elapsed days of a 30-day period, $2/day exactly. */
  const flat = { dailyTotals: new Array(10).fill(2), periodDays: 30, elapsedDays: 10 };

  it("run_rate equals spend_to_date / fraction_of_period_elapsed, exactly", () => {
    const f = forecastSpend({ ...flat, method: "run_rate" });
    // spendToDate = 20; meanDaily = 2; remaining = 20 days; 20 + 2*20 = 60
    // and the ADR's identity: 20 / (10/30) = 60
    expect(f.sufficient).toBe(true);
    expect(f.spendToDateUsd).toBe(20);
    expect(f.meanDailyUsd).toBe(2);
    expect(f.projectedSpendUsd).toBe(60);
    expect(f.projectedSpendUsd).toBe(20 / (10 / 30));
  });

  it("a perfectly flat history yields a ZERO-WIDTH band, because there is no sampling variation", () => {
    const f = forecastSpend({ ...flat, method: "run_rate" });
    // stddev of ten identical values is 0 -> halfWidth 0
    expect(f.lowUsd).toBe(60);
    expect(f.highUsd).toBe(60);
    expect(f.relativeBandWidth).toBe(0);
  });

  it("the band is 1.96 * (s/sqrt(n)) * remainingDays, and NARROWS as the period fills", () => {
    // 8 days: 1,3,1,3,1,3,1,3 -> sum 16, mean 2, sample sd = sqrt(8*1/(8-1))
    const daily = [1, 3, 1, 3, 1, 3, 1, 3];
    const early = forecastSpend({ dailyTotals: daily, periodDays: 30, elapsedDays: 8, method: "run_rate" });
    const s = stddev(daily); // = sqrt(8/7) = 1.069045
    const seMean = s / Math.sqrt(8);
    const halfEarly = 1.96 * seMean * (30 - 8);
    expect(early.projectedSpendUsd).toBe(16 + 2 * 22); // 60
    expect(early.highUsd).toBeCloseTo(60 + halfEarly, 5);
    expect(early.lowUsd).toBeCloseTo(60 - halfEarly, 5);

    // the SAME daily shape twice as far into the period: fewer remaining days
    // and more samples, so the band must be strictly narrower
    const late = forecastSpend({
      dailyTotals: [...daily, ...daily],
      periodDays: 30,
      elapsedDays: 16,
      method: "run_rate",
    });
    expect(late.relativeBandWidth!).toBeLessThan(early.relativeBandWidth!);
  });

  it("ewma weights recent days harder than the flat mean on a rising series", () => {
    // rising: mean 3, but the recent days are 5 -> ewma must project higher
    const daily = [1, 1, 2, 3, 4, 5, 5];
    const rr = forecastSpend({ dailyTotals: daily, periodDays: 14, elapsedDays: 7, method: "run_rate" });
    const ew = forecastSpend({ dailyTotals: daily, periodDays: 14, elapsedDays: 7, method: "ewma" });
    const sum = 21;
    expect(rr.projectedSpendUsd).toBe(sum + (sum / 7) * 7); // 42
    // hand-computed EWMA(alpha=0.4) of the series, then extended 7 days
    const rate = ewma(daily, 0.4);
    expect(ew.projectedSpendUsd).toBe(Number((sum + rate * 7).toFixed(6)));
    expect(ew.projectedSpendUsd!).toBeGreaterThan(rr.projectedSpendUsd!);
    expect(ew.method).toBe("ewma");
  });

  it("a DECIDED scheduled change is added on top of the extrapolation, and is signed", () => {
    const up = forecastSpend({ ...flat, method: "run_rate", scheduledDeltaUsd: 15 });
    expect(up.projectedSpendUsd).toBe(75);
    const down = forecastSpend({ ...flat, method: "run_rate", scheduledDeltaUsd: -15 });
    expect(down.projectedSpendUsd).toBe(45);
    expect(down.scheduledDeltaUsd).toBe(-15);
  });

  it("budget percentage and the early-warning breach day are derived, not guessed", () => {
    const f = forecastSpend({ ...flat, method: "run_rate", budgetUsd: 40 });
    expect(f.projectedPctOfBudget).toBe(150); // 60/40
    // spendToDate 20, rate 2/day, budget 40 -> 10 more days -> day 20
    expect(f.budgetBreachDay).toBe(20);
    // a budget the current rate never reaches inside the period has NO breach
    // day rather than one invented beyond the window
    expect(forecastSpend({ ...flat, method: "run_rate", budgetUsd: 1000 }).budgetBreachDay).toBeNull();
    expect(budgetBreachDay(20, 0, 10, 30, 40)).toBeNull();
  });
});

describe("ADR-0049 — insufficient data returns the HONEST SIGNAL, never a number", () => {
  it("no spend at all: null projection and a stated reason", () => {
    const f = forecastSpend({ dailyTotals: [0, 0, 0, 0, 0], periodDays: 30, elapsedDays: 5, method: "run_rate" });
    expect(f.sufficient).toBe(false);
    expect(f.projectedSpendUsd).toBeNull();
    expect(f.lowUsd).toBeNull();
    expect(f.highUsd).toBeNull();
    expect(f.insufficientReason).toMatch(/INSUFFICIENT DATA/);
    expect(f.insufficientReason).toMatch(/no measured spend/i);
  });

  it("one or two active days is below the floor — refused, not extrapolated", () => {
    const f = forecastSpend({
      dailyTotals: [0, 0, 0, 0, 0, 0, 5, 0, 0, 7],
      periodDays: 30,
      elapsedDays: 10,
      method: "run_rate",
    });
    expect(f.sufficient).toBe(false);
    expect(f.projectedSpendUsd).toBeNull();
    expect(f.activeDays).toBe(2);
    expect(f.insufficientReason).toMatch(/below the 3-day floor/);
    // spend-to-date is still REPORTED — it is measured, not projected
    expect(f.spendToDateUsd).toBe(12);
  });

  it("too little of the period elapsed is refused even with plenty of active days", () => {
    const f = forecastSpend({
      dailyTotals: [3, 4, 5],
      periodDays: 90,
      elapsedDays: 3, // 3.3% of the period
      method: "run_rate",
    });
    expect(f.sufficient).toBe(false);
    expect(f.projectedSpendUsd).toBeNull();
    expect(f.insufficientReason).toMatch(/of the period has elapsed/);
  });

  it("every payload carries the method, its assumptions, its limits and the disclaimer", () => {
    for (const f of [
      forecastSpend({ dailyTotals: new Array(10).fill(2), periodDays: 30, elapsedDays: 10, method: "run_rate" }),
      forecastSpend({ dailyTotals: [0], periodDays: 30, elapsedDays: 1, method: "ewma" }),
    ]) {
      expect(f.assumptions.length).toBeGreaterThan(0);
      expect(f.limits.join(" ")).toMatch(/seasonal/);
      expect(f.limits.join(" ")).toMatch(/step change/);
      expect(f.disclaimer).toMatch(/NOT A COMMITMENT/);
    }
  });
});

describe("ADR-0049 — the anomaly detector fires on a real spike AND stays silent otherwise", () => {
  /** 14 days of ordinary variance around $10/day. */
  const normalBaseline = [10, 11, 9, 10, 12, 8, 10, 11, 9, 10, 10, 12, 9, 11];

  it("FIRES on a genuine runaway spike", () => {
    const v = detectAnomaly({ signal: "spend_spike", baseline: normalBaseline, observed: 400, sensitivity: "medium" });
    expect(v.evaluated).toBe(true);
    expect(v.fired).toBe(true);
    expect(v.method).toBe("mad_z");
    // median 10, MAD 1 -> z = 0.6745 * 390 / 1 = 263.055
    expect(v.baselineMedian).toBe(10);
    expect(v.baselineMad).toBe(1);
    expect(v.score).toBeCloseTo(263.055, 3);
    expect(v.explanation).toMatch(/modified z-score/);
    expect(v.explanation).toMatch(/FIRED/);
  });

  it("STAYS SILENT on ordinary day-to-day variance from the same baseline", () => {
    // every observation the baseline itself contains must be unremarkable
    for (const x of normalBaseline) {
      const v = detectAnomaly({ signal: "spend_spike", baseline: normalBaseline, observed: x, sensitivity: "medium" });
      expect(v.evaluated, `observed ${x}`).toBe(true);
      expect(v.fired, `observed ${x} must not fire`).toBe(false);
    }
    // and a day 40% above the median is still normal variance, not an incident
    const v = detectAnomaly({ signal: "spend_spike", baseline: normalBaseline, observed: 14, sensitivity: "medium" });
    expect(v.fired).toBe(false);
    expect(v.score).toBeCloseTo(0.6745 * 4, 4);
    expect(v.explanation).toMatch(/within normal variance/);
  });

  it("sensitivity is a real dial: 'high' catches what 'low' lets through", () => {
    const observed = 15; // z = 0.6745*5 = 3.3725
    expect(detectAnomaly({ signal: "spend_spike", baseline: normalBaseline, observed, sensitivity: "low" }).fired).toBe(false);
    expect(detectAnomaly({ signal: "spend_spike", baseline: normalBaseline, observed, sensitivity: "medium" }).fired).toBe(false);
    expect(detectAnomaly({ signal: "spend_spike", baseline: normalBaseline, observed, sensitivity: "high" }).fired).toBe(true);
  });

  it("COLD START makes no claim at all — neither fired nor not-fired is asserted", () => {
    const v = detectAnomaly({ signal: "spend_spike", baseline: [10, 10, 900], observed: 100_000, sensitivity: "high" });
    expect(v.evaluated).toBe(false);
    expect(v.fired).toBe(false);
    expect(v.method).toBeNull();
    expect(v.score).toBeNull();
    expect(v.explanation).toMatch(/BASELINE BUILDING/);
    expect(v.baselineSamples).toBeLessThan(MIN_BASELINE_SAMPLES);
  });

  it("the absolute floor stops a statistically extreme but operationally trivial reading", () => {
    // a scope that normally spends fractions of a cent; 0.05 is a 300-sigma
    // event and still not an incident
    const tiny = [0.001, 0.0012, 0.0009, 0.001, 0.0011, 0.001, 0.0013, 0.001];
    const v = detectAnomaly({ signal: "spend_spike", baseline: tiny, observed: 0.05, sensitivity: "high" });
    expect(v.evaluated).toBe(true);
    expect(v.fired).toBe(false);
    expect(v.explanation).toMatch(/below this signal's absolute floor/);
    expect(v.absoluteFloor).toBe(ANOMALY_ABSOLUTE_FLOORS.spend_spike);
  });

  it("a DEGENERATE flat baseline falls back to percent-over-baseline and says so", () => {
    const flat = new Array(10).fill(10);
    const under = detectAnomaly({ signal: "spend_spike", baseline: flat, observed: 25, sensitivity: "medium" });
    expect(under.method).toBe("pct_over_baseline");
    expect(under.fired).toBe(false); // 2.5x < 3x
    const over = detectAnomaly({ signal: "spend_spike", baseline: flat, observed: 30, sensitivity: "medium" });
    expect(over.fired).toBe(true); // exactly 3x
    expect(over.explanation).toMatch(/MAD = 0/);
    expect(over.baselineMad).toBe(0);
  });

  it("only UPWARD excursions are anomalies — spending less than usual is not an incident", () => {
    const v = detectAnomaly({ signal: "spend_spike", baseline: normalBaseline, observed: 1, sensitivity: "high" });
    expect(v.fired).toBe(false);
  });

  it("token-volume uses its own floor, so a small odd call is not a runaway loop", () => {
    const base = [1000, 1100, 900, 1000, 1200, 950, 1050, 1000];
    expect(detectAnomaly({ signal: "token_volume", baseline: base, observed: 1400, sensitivity: "medium" }).fired).toBe(false);
    const spike = detectAnomaly({ signal: "token_volume", baseline: base, observed: 900_000, sensitivity: "medium" });
    expect(spike.fired).toBe(true);
    expect(spike.absoluteFloor).toBe(ANOMALY_ABSOLUTE_FLOORS.token_volume);
  });
});

describe("ADR-0049 — the unusual-model signal is categorical and explains itself", () => {
  const history = { "cheap-model": 500, "mid-model": 40 };

  it("fires on a never-before-seen expensive model that actually cost something", () => {
    const v = detectUnusualModel({ model: "frontier-model", historicalCounts: history, observedSpendUsd: 42 });
    expect(v.evaluated).toBe(true);
    expect(v.fired).toBe(true);
    expect(v.method).toBe("share_of_history");
    expect(v.explanation).toMatch(/0\/540/);
  });

  it("does NOT fire on the scope's ordinary workhorse model", () => {
    const v = detectUnusualModel({ model: "cheap-model", historicalCounts: history, observedSpendUsd: 900 });
    expect(v.fired).toBe(false);
    expect(v.explanation).toMatch(/not unusual for this scope/);
  });

  it("does NOT fire on an unfamiliar model that cost essentially nothing", () => {
    const v = detectUnusualModel({ model: "frontier-model", historicalCounts: history, observedSpendUsd: 0.02 });
    expect(v.fired).toBe(false);
  });

  it("makes no claim before the scope has a history", () => {
    const v = detectUnusualModel({ model: "x", historicalCounts: { a: 2 }, observedSpendUsd: 1000 });
    expect(v.evaluated).toBe(false);
    expect(v.fired).toBe(false);
  });
});

describe("ADR-0049 — enforcement rides the existing queue and respects the framework floor", () => {
  it("alert-not-block is the default and gates nothing", () => {
    const d = decideEnforcement({ action: "alert", hasApprover: true });
    expect(d.effect).toBe("alert");
    expect(d.escalate).toBe(false);
    expect(d.reason).toMatch(/alert-not-block/);
  });

  it("an explicit require_approval escalates into the EXISTING approvals queue", () => {
    const d = decideEnforcement({ action: "require_approval", hasApprover: true });
    expect(d.effect).toBe("require_approval");
    expect(d.escalate).toBe(true);
    expect(d.reason).toMatch(/EXISTING Approvals Queue/);
    expect(d.reason).toMatch(/no separate inbox/);
  });

  it("a block-mandating framework floor TIGHTENS an 'alert' policy — and never the reverse", () => {
    const tightened = decideEnforcement({ action: "alert", frameworkFloor: "block", hasApprover: true });
    expect(tightened.effect).toBe("require_approval");
    expect(tightened.ruleId).toBe("spend-anomaly-enforced-framework-floor");
    // a 'warn' floor cannot pull a require_approval policy DOWN to alert
    const notRelaxed = decideEnforcement({ action: "require_approval", frameworkFloor: "warn", hasApprover: true });
    expect(notRelaxed.effect).toBe("require_approval");
  });

  it("with no named approver the escalation is DECLINED and the gap stated, not faked", () => {
    const d = decideEnforcement({ action: "require_approval", hasApprover: false });
    expect(d.effect).toBe("alert");
    expect(d.escalate).toBe(false);
    expect(d.ruleId).toBe("spend-anomaly-no-approver");
    expect(d.reason).toMatch(/no budget approver/);
  });
});

describe("ADR-0049 — active hours are derived from the scope's own history", () => {
  it("keeps hours carrying a real share and drops the noise", () => {
    const rows = [
      { hour: 9, value: 100 },
      { hour: 10, value: 100 },
      { hour: 11, value: 100 },
      { hour: 3, value: 1 }, // 0.33% — noise
    ];
    expect(activeHours(rows)).toEqual([9, 10, 11]);
    expect(activeHours([])).toEqual([]);
  });
});
