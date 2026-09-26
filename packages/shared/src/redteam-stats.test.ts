/**
 * ADR-0068 §1 — the ASR statistics, proved ADVERSARIALLY.
 *
 * The brief for this slice named the failure mode precisely: "a constant, or an
 * interval that ignores N, is not a statistic." So every assertion here is
 * PAIRED with its opposite and the GAP is asserted — the same discipline
 * ADR-0067's groundedness suite used. A test that only checks `asr === 0.5`
 * would pass against a function that returns 0.5 for everything.
 */
import { describe, expect, it } from "vitest";
import {
  RED_TEAM_DEFAULT_Z,
  aggregateAsrByClass,
  describeAsr,
  measurementQuality,
  summarizeProbeAsr,
  wilsonInterval,
  type RedTeamTrialOutcome,
} from "./redteam-stats.js";

const trials = (defeats: number, total: number): RedTeamTrialOutcome[] =>
  Array.from({ length: total }, (_, i) => ({
    trial: i + 1,
    defeated: i < defeats,
    score: i < defeats ? 0 : 1,
    error: null,
  }));

const summary = (defeats: number, total: number) =>
  summarizeProbeAsr({
    probeKey: "p",
    attackClass: "jailbreak",
    severity: "high",
    outcomes: trials(defeats, total),
  });

describe("wilsonInterval", () => {
  it("is a POINT-FREE interval at n = 0 — total ignorance, never a point estimate", () => {
    const i = wilsonInterval(0, 0);
    expect(i.lower).toBe(0);
    expect(i.upper).toBe(1);
    expect(i.width).toBe(1);
    expect(i.trials).toBe(0);
  });

  it("NEVER collapses to zero width at the boundaries, which is the whole reason it is not Wald", () => {
    // Wald would give [1,1] and [0,0] here — a claim of certainty from a
    // handful of samples, at exactly the two results red-team runs live at.
    const allDefeated = wilsonInterval(5, 5);
    const noneDefeated = wilsonInterval(0, 5);
    expect(allDefeated.width).toBeGreaterThan(0.3);
    expect(noneDefeated.width).toBeGreaterThan(0.3);
    expect(allDefeated.upper).toBe(1);
    expect(noneDefeated.lower).toBe(0);
  });

  it("WIDENS as N shrinks — the interval is a function of the denominator, not a constant", () => {
    const widths = [3, 10, 30, 100, 300].map((n) => wilsonInterval(Math.round(n / 2), n).width);
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i]!).toBeLessThan(widths[i - 1]!);
    }
    // and the gap is LARGE, not a rounding artefact
    expect(widths[0]! - widths[widths.length - 1]!).toBeGreaterThan(0.4);
  });

  it("distinguishes 2/3 from 40/60 — SAME point estimate, visibly different claims", () => {
    const small = wilsonInterval(2, 3);
    const large = wilsonInterval(40, 60);
    expect(2 / 3).toBeCloseTo(40 / 60, 10);
    expect(small.width).toBeGreaterThan(large.width * 2.5);
    // the small sample's lower bound is consistent with "barely better than a
    // coin"; the large sample's is not
    expect(small.lower).toBeLessThan(0.3);
    expect(large.lower).toBeGreaterThan(0.5);
  });

  it("clamps to [0,1] and records the z it used, so a stored interval is reproducible", () => {
    const i = wilsonInterval(0, 1, 2.576);
    expect(i.lower).toBeGreaterThanOrEqual(0);
    expect(i.upper).toBeLessThanOrEqual(1);
    expect(i.z).toBe(2.576);
    // a wider confidence level must produce a wider interval
    expect(i.width).toBeGreaterThan(wilsonInterval(0, 1, RED_TEAM_DEFAULT_Z).width);
  });

  it("saturates rather than throwing when successes exceed trials", () => {
    expect(wilsonInterval(9, 3)).toEqual(wilsonInterval(3, 3));
  });
});

describe("summarizeProbeAsr — a rate is never separable from its denominator", () => {
  it("an ALWAYS-failing probe and a NEVER-failing probe are visibly different over the same N", () => {
    const always = summary(20, 20);
    const never = summary(0, 20);
    expect(always.asr).toBe(1);
    expect(never.asr).toBe(0);
    // the intervals must not overlap AT ALL — this is the assertion that a
    // constant would fail
    expect(never.interval!.upper).toBeLessThan(always.interval!.lower);
    expect(always.trials).toBe(never.trials);
  });

  it("the SAME outcome at a smaller N produces a WIDER interval", () => {
    const big = summary(0, 40);
    const small = summary(0, 3);
    expect(big.asr).toBe(small.asr);
    expect(small.interval!.width).toBeGreaterThan(big.interval!.width * 2);
  });

  it("an unrun probe is `not_run` with a stated reason — never `passed`, never an ASR of 0", () => {
    const s = summarizeProbeAsr({
      probeKey: "ag-tool-abuse",
      attackClass: "tool_abuse",
      severity: "critical",
      outcomes: [],
      notRunReason: "no MCP server named 'crm' is registered in this deployment",
    });
    expect(s.status).toBe("not_run");
    expect(s.asr).toBeNull();
    expect(s.interval).toBeNull();
    expect(s.meanScore).toBeNull();
    expect(s.notRunReason).toContain("crm");
    expect(describeAsr(s)).toContain("NOT RUN");
    expect(describeAsr(s)).toContain("No attack-success rate exists");
  });

  it("an ERRORED trial is excluded from the denominator, not scored either way", () => {
    const s = summarizeProbeAsr({
      probeKey: "p",
      attackClass: "jailbreak",
      severity: "high",
      outcomes: [
        { trial: 1, defeated: true, score: 0, error: null },
        { trial: 2, defeated: false, score: 1, error: null },
        { trial: 3, defeated: false, score: 0, error: "model_dispatch_failed" },
      ],
    });
    expect(s.trials).toBe(2);
    expect(s.erroredTrials).toBe(1);
    expect(s.defeats).toBe(1);
    expect(s.asr).toBe(0.5);
    expect(describeAsr(s)).toContain("1 trial(s) errored");
  });

  it("EVERY trial erroring is `not_run`, not a clean sheet — an outage cannot manufacture a green result", () => {
    const s = summarizeProbeAsr({
      probeKey: "p",
      attackClass: "jailbreak",
      severity: "high",
      outcomes: [
        { trial: 1, defeated: false, score: 0, error: "model_dispatch_failed" },
        { trial: 2, defeated: false, score: 0, error: "model_dispatch_failed" },
      ],
    });
    expect(s.status).toBe("not_run");
    expect(s.asr).toBeNull();
    expect(s.notRunReason).toContain("2 attempted trial(s)");
  });

  it("reports whether variance was OBSERVED, so a deterministic provider is legible as such", () => {
    const flapping = summarizeProbeAsr({
      probeKey: "p",
      attackClass: "jailbreak",
      severity: "high",
      outcomes: [
        { trial: 1, defeated: true, score: 0, error: null },
        { trial: 2, defeated: false, score: 1, error: null },
        { trial: 3, defeated: true, score: 0, error: null },
      ],
    });
    expect(flapping.varianceObserved).toBe(true);
    expect(flapping.scoreVariance).toBeGreaterThan(0);
    const constant = summary(0, 3);
    expect(constant.varianceObserved).toBe(false);
    expect(constant.scoreVariance).toBe(0);
  });

  it("keeps the PER-TRIAL outcomes, so a reviewer can see the run rather than a mean", () => {
    const s = summary(1, 4);
    expect(s.outcomes).toHaveLength(4);
    expect(s.outcomes.map((o) => o.defeated)).toEqual([true, false, false, false]);
  });
});

describe("aggregateAsrByClass", () => {
  it("pools the denominator per class and keeps NOT-RUN probes out of every rate", () => {
    const rows = aggregateAsrByClass([
      summarizeProbeAsr({ probeKey: "a", attackClass: "jailbreak", severity: "high", outcomes: trials(1, 10) }),
      summarizeProbeAsr({ probeKey: "b", attackClass: "jailbreak", severity: "critical", outcomes: trials(10, 10) }),
      summarizeProbeAsr({
        probeKey: "c",
        attackClass: "jailbreak",
        severity: "critical",
        outcomes: [],
        notRunReason: "target not registered",
      }),
    ]);
    const jb = rows.find((r) => r.attackClass === "jailbreak")!;
    expect(jb.probes).toBe(2);
    expect(jb.notRunProbes).toBe(1);
    expect(jb.trials).toBe(20);
    expect(jb.defeats).toBe(11);
    expect(jb.asr).toBeCloseTo(0.55, 5);
    expect(jb.probesEverDefeated).toBe(2);
    // only 'b' fell in EVERY trial — the distinction a single number loses
    expect(jb.probesAlwaysDefeated).toBe(1);
    expect(jb.worstDefeatedSeverity).toBe("critical");
  });

  it("a class with only NOT-RUN probes reports a null rate rather than a green zero", () => {
    const rows = aggregateAsrByClass([
      summarizeProbeAsr({
        probeKey: "x",
        attackClass: "tool_abuse",
        severity: "critical",
        outcomes: [],
        notRunReason: "no connector named 'external-share'",
      }),
    ]);
    expect(rows[0]!.asr).toBeNull();
    expect(rows[0]!.interval).toBeNull();
    expect(rows[0]!.probes).toBe(0);
    expect(rows[0]!.notRunProbes).toBe(1);
  });
});

describe("measurementQuality — one trial is labelled, not laundered", () => {
  it("labels the honest thing at each N", () => {
    expect(measurementQuality(1, 5)).toBe("single-trial");
    expect(measurementQuality(3, 5)).toBe("low-power");
    expect(measurementQuality(30, 5)).toBe("measured");
    expect(measurementQuality(30, 0)).toBe("not-run");
    expect(measurementQuality(0, 5)).toBe("not-run");
  });
});
