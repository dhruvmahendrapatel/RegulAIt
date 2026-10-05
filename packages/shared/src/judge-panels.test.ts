/**
 * ADR-0173 batch 2c / ADR-0177 item 8 — judge panels, repeated runs and
 * calibration, the pure half.
 */
import { describe, expect, it } from "vitest";
import { mean } from "simple-statistics";
import {
  JUDGE_PANEL_LIMITS,
  KAPPA_MIN_PAIRED_LABELS,
  bootstrapInterval,
  chooseCalibrationCriterion,
  cohensKappa,
  combinePanelVerdicts,
  humanVerdict,
  judgeCalibrationSchema,
  judgePanelSchema,
  judgementBudgetProblem,
  kappaReport,
  meanScoreInterval,
  measuredConfigHash,
  normaliseRubricScore,
  runComparisonRefusal,
  seededRandom,
} from "./judge-panels.js";

/** expand a 2×2 agreement table into labelled pairs */
function table(yy: number, yn: number, ny: number, nn: number): Array<readonly [string, string]> {
  return [
    ...Array.from({ length: yy }, () => ["yes", "yes"] as const),
    ...Array.from({ length: yn }, () => ["yes", "no"] as const),
    ...Array.from({ length: ny }, () => ["no", "yes"] as const),
    ...Array.from({ length: nn }, () => ["no", "no"] as const),
  ];
}

describe("Cohen's kappa, against published worked examples", () => {
  // Wikipedia, "Cohen's kappa", Examples: 50 grant proposals read by two
  // readers — 20 yes/yes, 5 yes/no, 10 no/yes, 15 no/no. pₒ = 0.7, pₑ = 0.5,
  // κ = 0.4.
  it("the 50-application example gives κ = 0.4", () => {
    expect(cohensKappa(table(20, 5, 10, 15))).toBeCloseTo(0.4, 10);
  });

  // Same article, "same percentages but different numbers": both tables have
  // 60% agreement, and κ is 0.1304 and 0.2593.
  it("the two 100-item tables with the same agreement give 0.1304 and 0.2593", () => {
    expect(cohensKappa(table(45, 15, 25, 15))).toBeCloseTo(0.1304, 4);
    expect(cohensKappa(table(25, 35, 5, 35))).toBeCloseTo(0.2593, 4);
  });

  it("perfect agreement is 1; total chance agreement is undefined, not 0 or 1", () => {
    expect(cohensKappa(table(10, 0, 0, 10))).toBe(1);
    expect(cohensKappa(table(10, 0, 0, 0))).toBeNull();
    expect(cohensKappa([])).toBeNull();
  });
});

describe("kappa is reported only from the minimum number of completed pairs", () => {
  it(`below ${KAPPA_MIN_PAIRED_LABELS} pairs: "insufficient", and no number at all`, () => {
    const r = kappaReport(table(10, 2, 2, 5), "s"); // 19 pairs
    expect(r.pairs).toBe(19);
    expect(r.status).toBe("insufficient");
    expect(r.kappa).toBeNull();
    expect(r.interval).toBeNull();
  });

  it(`at ${KAPPA_MIN_PAIRED_LABELS} pairs: reported, with a seeded interval`, () => {
    const r = kappaReport(table(10, 2, 2, 6), "s"); // 20 pairs
    expect(r.status).toBe("reported");
    expect(r.kappa).toBeCloseTo(cohensKappa(table(10, 2, 2, 6))!, 4);
    expect(r.interval).not.toBeNull();
    expect(r.interval!.low).toBeLessThanOrEqual(r.interval!.high);
  });
});

describe("bootstrap intervals use a seeded random source", () => {
  const scores = [0.2, 0.9, 0.4, 0.7, 1, 0.55, 0.3, 0.8, 0.65, 0.1];

  it("the same seed reproduces the same interval exactly; another seed does not", () => {
    const a = meanScoreInterval(scores, "run-1");
    const b = meanScoreInterval(scores, "run-1");
    const c = meanScoreInterval(scores, "run-2");
    expect(a).toEqual(b);
    expect(c).not.toEqual(a);
    expect(a!.estimate).toBeCloseTo(mean(scores), 4);
    expect(a!.low).toBeLessThan(a!.estimate);
    expect(a!.high).toBeGreaterThan(a!.estimate);
    expect(a!.resamples).toBe(1000);
  });

  it("the source is deterministic and uniform-looking in [0, 1)", () => {
    const r1 = seededRandom("x");
    const r2 = seededRandom("x");
    const xs = Array.from({ length: 2000 }, () => r1());
    expect(Array.from({ length: 2000 }, () => r2())).toEqual(xs);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(mean(xs)).toBeGreaterThan(0.45);
    expect(mean(xs)).toBeLessThan(0.55);
  });

  it("no interval on fewer than two observations", () => {
    expect(bootstrapInterval([1], (s) => mean(s), { seed: "a" })).toBeNull();
  });
});

describe("panels", () => {
  const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

  it("2–5 judges with positive weights, each once", () => {
    expect(judgePanelSchema.safeParse([{ agentId: id(1), weight: 1 }]).success).toBe(false);
    expect(
      judgePanelSchema.safeParse(Array.from({ length: 6 }, (_, i) => ({ agentId: id(i + 1), weight: 1 }))).success,
    ).toBe(false);
    expect(judgePanelSchema.safeParse([{ agentId: id(1), weight: 1 }, { agentId: id(2), weight: 0 }]).success).toBe(false);
    expect(judgePanelSchema.safeParse([{ agentId: id(1), weight: 1 }, { agentId: id(2), weight: -1 }]).success).toBe(false);
    expect(judgePanelSchema.safeParse([{ agentId: id(1), weight: 1 }, { agentId: id(1), weight: 2 }]).success).toBe(false);
    expect(judgePanelSchema.safeParse([{ agentId: id(1), weight: 1 }, { agentId: id(2), weight: 3 }]).success).toBe(true);
    expect(
      judgePanelSchema.safeParse(Array.from({ length: 5 }, (_, i) => ({ agentId: id(i + 1), weight: 0.5 }))).success,
    ).toBe(true);
  });

  it("verdicts combine by weight", () => {
    const c = combinePanelVerdicts([
      { judge: "a", weight: 3, score: 1 },
      { judge: "b", weight: 1, score: 0 },
    ]);
    expect(c.score).toBe(0.75);
    expect(c.counted).toBe(2);
    expect(c.spread).toBe(1);
  });

  it("a failed judge leaves the mean — it is never a zero", () => {
    const c = combinePanelVerdicts([
      { judge: "a", weight: 1, score: 0.8 },
      { judge: "b", weight: 5, score: null },
    ]);
    expect(c.score).toBe(0.8);
    expect(c.failed).toBe(1);
    expect(combinePanelVerdicts([{ judge: "a", weight: 1, score: null }]).score).toBeNull();
  });

  it(`judges × cases × repetitions is capped at ${JUDGE_PANEL_LIMITS.maxJudgements}`, () => {
    expect(judgementBudgetProblem(5, 100, 1)).toBeNull();
    expect(judgementBudgetProblem(5, 101, 1)).toMatch(/505 judgements/);
    expect(judgementBudgetProblem(2, 50, 5)).toBeNull();
    expect(judgementBudgetProblem(2, 51, 5)).toMatch(/above the 500/);
    expect(judgementBudgetProblem(1, 1, 6)).toMatch(/repetitions/);
  });
});

describe("calibration labels", () => {
  const opts = { positiveLabels: ["pass", "Good"], negativeLabels: ["fail"], valueThreshold: 0.5 };
  it("a label wins over a score; a score is thresholded; neither is no verdict", () => {
    expect(humanVerdict({ label: "good", value: 0 }, opts)).toBe("pass");
    expect(humanVerdict({ label: "fail", value: 1 }, opts)).toBe("fail");
    expect(humanVerdict({ label: null, value: 0.5 }, opts)).toBe("pass");
    expect(humanVerdict({ label: null, value: 0.49 }, opts)).toBe("fail");
    expect(humanVerdict({ label: "unsure", value: null }, opts)).toBeNull();
  });

  it("a 1-5 rubric score is normalised by its bounds: the worst rating fails, the best passes", () => {
    expect(normaliseRubricScore(1, 1, 5)).toBe(0);
    expect(normaliseRubricScore(5, 1, 5)).toBe(1);
    expect(normaliseRubricScore(3, 1, 5)).toBe(0.5);
    expect(normaliseRubricScore(3, 5, 5)).toBeNull();
    const score = (v: number) => [{ name: "quality", kind: "score" as const, value: normaliseRubricScore(v, 1, 5)!, min: 1, max: 5 }];
    const verdictOf = (v: number) => {
      const c = chooseCalibrationCriterion(score(v), opts);
      if (c.status !== "chosen") throw new Error(c.status);
      return humanVerdict(c, opts);
    };
    expect(verdictOf(1)).toBe("fail");
    expect(verdictOf(2)).toBe("fail");
    expect(verdictOf(4)).toBe("pass");
    expect(verdictOf(5)).toBe("pass");
  });

  it("picks the label criterion whose labels are in positive or negative, never the first by name", () => {
    const criteria = [
      // alphabetically first, but its labels say nothing about pass/fail
      { name: "a_tone", kind: "label" as const, value: "formal", labels: ["formal", "casual"] },
      { name: "z_verdict", kind: "label" as const, value: "fail", labels: ["pass", "fail"] },
      { name: "quality", kind: "score" as const, value: 1, min: 1, max: 5 },
    ];
    expect(chooseCalibrationCriterion(criteria, opts)).toEqual({ status: "chosen", criterion: "z_verdict", label: "fail", value: null });
    // two qualifying labels and none named: ambiguous, not a guess
    const two = [...criteria, { name: "b_outcome", kind: "label" as const, value: "pass", labels: ["pass", "fail"] }];
    expect(chooseCalibrationCriterion(two, opts)).toEqual({ status: "ambiguous", candidates: ["b_outcome", "z_verdict"] });
    // naming one resolves it, and naming one the rubric lacks says so
    expect(chooseCalibrationCriterion(two, { ...opts, criterion: "b_outcome" })).toMatchObject({ status: "chosen", label: "pass" });
    expect(chooseCalibrationCriterion(two, { ...opts, criterion: "quality" })).toMatchObject({ status: "chosen", value: 1 });
    expect(chooseCalibrationCriterion(two, { ...opts, criterion: "nope" })).toEqual({ status: "not_in_rubric" });
    // no qualifying label: one score is chosen, two scores are ambiguous
    const scores = [criteria[0]!, criteria[2]!];
    expect(chooseCalibrationCriterion(scores, opts)).toMatchObject({ status: "chosen", criterion: "quality" });
    expect(chooseCalibrationCriterion([...scores, { ...criteria[2]!, name: "accuracy" }], opts)).toEqual({
      status: "ambiguous",
      candidates: ["accuracy", "quality"],
    });
    expect(chooseCalibrationCriterion([criteria[0]!], opts)).toEqual({ status: "none" });
    // the request validates the criterion's shape
    expect(judgeCalibrationSchema.safeParse({ criterion: "Bad Name" }).success).toBe(false);
    expect(judgeCalibrationSchema.parse({ criterion: "z_verdict" }).criterion).toBe("z_verdict");
  });
});

describe("configuration hash and comparison", () => {
  const base = { model: "m1", tier: 2, systemPromptHash: "abc", customProviderId: null };
  it("any measured field changes the hash; the same configuration hashes the same", () => {
    const h = measuredConfigHash(base);
    expect(measuredConfigHash({ ...base })).toBe(h);
    expect(measuredConfigHash({ ...base, model: "m2" })).not.toBe(h);
    expect(measuredConfigHash({ ...base, tier: 3 })).not.toBe(h);
    expect(measuredConfigHash({ ...base, systemPromptHash: "abd" })).not.toBe(h);
    expect(measuredConfigHash({ ...base, customProviderId: "00000000-0000-4000-8000-000000000001" })).not.toBe(h);
  });

  it("comparison is refused across dataset versions and scoring semantics", () => {
    const a = { id: "a", datasetId: "d", datasetVersion: 1, scoringSemantics: 2, status: "completed" };
    expect(runComparisonRefusal(a, { ...a, id: "b" })).toBeNull();
    expect(runComparisonRefusal(a, { ...a, id: "b", datasetVersion: 2 })?.error).toBe("dataset_version_mismatch");
    expect(runComparisonRefusal(a, { ...a, id: "b", datasetId: "e" })?.error).toBe("dataset_version_mismatch");
    expect(runComparisonRefusal(a, { ...a, id: "b", scoringSemantics: 1 })?.error).toBe("scoring_semantics_mismatch");
    expect(runComparisonRefusal(a, { ...a, id: "b", status: "running" })?.error).toBe("run_not_completed");
    expect(runComparisonRefusal(a, a)?.error).toBe("same_run");
  });
});
