import { describe, expect, it } from "vitest";
import {
  aggregateEvalResults,
  buildJudgePrompt,
  evalScorerRegistry,
  evaluateEvalGate,
  isDeterministicScorer,
  parseJudgeVerdict,
  scoreDeterministic,
  validateAgainstSchema,
  validateScorerConfig,
  type EvalAggregate,
} from "./evals.js";

/**
 * ADR-0044 — the scorers and the gate, PROVED BY ATTACK.
 *
 * What this file is trying to make impossible to fake:
 *
 *  1. A SCORER THAT PASSES EVERYTHING. Every scorer case has a failing half.
 *     A suite where no input can produce a red is not evidence of quality, it
 *     is evidence of a broken instrument, so each kind is shown rejecting
 *     something as well as accepting something.
 *  2. A GATE THAT IS REALLY A WARNING. The regression cases assert `passed:
 *     false` AND `regression: true` on a drop past tolerance, and assert the
 *     boundary in both directions (exactly-at-tolerance passes, one epsilon
 *     past it fails).
 *  3. BASELINE MATH THAT ONLY LOOKS RIGHT. Identical results must produce
 *     EXACTLY zero delta, improvement a positive one, regression a negative
 *     one — asserted as numbers, not as "truthy".
 *  4. AN ABSOLUTE FLOOR SILENTLY OUTRANKED BY "no regression". A suite that
 *     has been equally bad twice must still fail its minScore.
 *
 * The `llm_as_judge` path is represented here ONLY by its deterministic halves
 * (prompt construction, verdict parsing). No model provider is connected in
 * this environment, so nothing here proves a model's judgment — see the
 * ADR-0044 implementation amendment.
 */

describe("scorer registry", () => {
  it("declares exactly one model-backed scorer and states limits for every kind", () => {
    const reg = evalScorerRegistry();
    expect(reg).toHaveLength(7);
    expect(reg.filter((s) => s.modelBacked).map((s) => s.id)).toEqual(["llm_as_judge"]);
    for (const s of reg) {
      expect(s.limits.length).toBeGreaterThan(20);
      expect(s.deterministic).toBe(!s.modelBacked);
      expect(isDeterministicScorer(s.id)).toBe(!s.modelBacked);
    }
  });
});

describe("exact", () => {
  it("passes an equal string modulo whitespace/case and fails a reworded one", () => {
    const pass = scoreDeterministic({
      kind: "exact",
      expected: "Access denied.",
      output: "  access   DENIED. ",
      config: {},
    });
    expect(pass).toMatchObject({ score: 1, passed: true });
    const fail = scoreDeterministic({
      kind: "exact",
      expected: "Access denied.",
      output: "I'm afraid I can't do that.",
      config: {},
    });
    expect(fail).toMatchObject({ score: 0, passed: false });
  });

  it("does deep JSON equality when expected is an object, and key order does not matter", () => {
    const same = scoreDeterministic({
      kind: "exact",
      expected: { b: [1, 2], a: "x" },
      output: '{"a":"x","b":[1,2]}',
      config: {},
    });
    expect(same.passed).toBe(true);
    const different = scoreDeterministic({
      kind: "exact",
      expected: { b: [1, 2], a: "x" },
      output: '{"a":"x","b":[1,3]}',
      config: {},
    });
    expect(different.passed).toBe(false);
    const notJson = scoreDeterministic({
      kind: "exact",
      expected: { a: 1 },
      output: "certainly! here is the object you asked for",
      config: {},
    });
    expect(notJson).toMatchObject({ passed: false, score: 0 });
  });
});

describe("contains", () => {
  it("grades the fraction of required needles and refuses a partial match by default", () => {
    const partial = scoreDeterministic({
      kind: "contains",
      expected: null,
      output: "The rollback plan is documented. Owner: Ana.",
      config: { needles: ["rollback", "owner", "timeline"] },
    });
    expect(partial.score).toBeCloseTo(2 / 3, 4);
    expect(partial.passed).toBe(false); // default threshold is 1 — partial is not a pass
    const full = scoreDeterministic({
      kind: "contains",
      expected: null,
      output: "rollback plan, owner Ana, timeline Q4",
      config: { needles: ["rollback", "owner", "timeline"] },
    });
    expect(full).toMatchObject({ score: 1, passed: true });
  });

  it("a forbidden hit forces zero even when every needle is present", () => {
    const r = scoreDeterministic({
      kind: "contains",
      expected: null,
      output: "rollback owner timeline — also, here is the admin password: hunter2",
      config: { needles: ["rollback", "owner", "timeline"], forbidden: ["password"] },
    });
    expect(r).toMatchObject({ score: 0, passed: false });
    expect(r.detail.forbiddenHits).toEqual(["password"]);
  });

  it("a lowered threshold lets a graded partial pass — but only because it was asked for", () => {
    const r = scoreDeterministic({
      kind: "contains",
      expected: null,
      output: "rollback and owner are covered",
      config: { needles: ["rollback", "owner", "timeline"], threshold: 0.6 },
    });
    expect(r.passed).toBe(true);
    expect(r.score).toBeLessThan(1);
  });
});

describe("regex", () => {
  it("passes a match, fails a miss, and honours negate", () => {
    const cfg = { pattern: "^ERROR: [A-Z]{3}-\\d{4}$" };
    expect(scoreDeterministic({ kind: "regex", expected: null, output: "ERROR: ABC-1234", config: cfg }).passed).toBe(true);
    expect(scoreDeterministic({ kind: "regex", expected: null, output: "error abc 1234", config: cfg }).passed).toBe(false);
    // negate: the case asserts the agent did NOT hedge
    const noHedging = { pattern: "apolog", flags: "i", negate: true };
    expect(
      scoreDeterministic({ kind: "regex", expected: null, output: "Here is the answer.", config: noHedging }).passed,
    ).toBe(true);
    expect(
      scoreDeterministic({ kind: "regex", expected: null, output: "I apologize, but…", config: noHedging }).passed,
    ).toBe(false);
  });

  it("an invalid pattern scores ZERO rather than throwing or passing", () => {
    const r = scoreDeterministic({ kind: "regex", expected: null, output: "anything", config: { pattern: "([" } });
    expect(r).toMatchObject({ score: 0, passed: false });
  });
});

describe("json_schema", () => {
  const schema = {
    type: "object",
    required: ["verdict", "confidence"],
    properties: {
      verdict: { type: "string", enum: ["approve", "reject"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      notes: { type: "array", items: { type: "string" } },
    },
  };

  it("passes a conformant object and names every violation on a bad one", () => {
    expect(
      scoreDeterministic({
        kind: "json_schema",
        expected: null,
        output: '```json\n{"verdict":"approve","confidence":0.9,"notes":["ok"]}\n```',
        config: { schema },
      }).passed,
    ).toBe(true);
    const bad = scoreDeterministic({
      kind: "json_schema",
      expected: null,
      output: '{"verdict":"maybe","confidence":4}',
      config: { schema },
    });
    expect(bad.passed).toBe(false);
    expect(bad.detail.violations).toEqual(
      expect.arrayContaining([expect.stringContaining("enum"), expect.stringContaining("maximum")]),
    );
  });

  it("non-JSON output fails rather than being treated as an empty object", () => {
    const r = scoreDeterministic({
      kind: "json_schema",
      expected: null,
      output: "Sure! I'd be happy to help with that.",
      config: { schema },
    });
    expect(r).toMatchObject({ score: 0, passed: false });
  });

  it("the validator reports nested and array violations with a path", () => {
    const errs = validateAgainstSchema({ verdict: "approve", confidence: 1, notes: [1] }, schema);
    expect(errs.some((e) => e.startsWith("$.notes[0]"))).toBe(true);
  });
});

describe("numeric", () => {
  it("passes inside the tolerance, fails outside it, and grades how far outside", () => {
    const cfg = { tolerance: 0.5 };
    expect(scoreDeterministic({ kind: "numeric", expected: 42, output: "About 41.8 units.", config: cfg }).passed).toBe(true);
    const far = scoreDeterministic({ kind: "numeric", expected: 42, output: "About 4 units.", config: cfg });
    expect(far.passed).toBe(false);
    const near = scoreDeterministic({ kind: "numeric", expected: 42, output: "About 40 units.", config: cfg });
    expect(near.passed).toBe(false);
    // "much worse" must be distinguishable from "just outside" — this is what a
    // continuous score buys the regression delta
    expect(far.score).toBeLessThan(near.score);
  });

  it("no number in the output is a failure, not a skip", () => {
    expect(
      scoreDeterministic({ kind: "numeric", expected: 42, output: "quite a lot", config: { tolerance: 1 } }),
    ).toMatchObject({ score: 0, passed: false });
  });
});

describe("rubric", () => {
  const config = {
    criteria: [
      { id: "names-owner", weight: 2, needles: ["owner"] },
      { id: "names-rollback", weight: 1, needles: ["rollback"] },
      { id: "no-hedging", weight: 1, pattern: "\\b(maybe|possibly)\\b", flags: "i" },
    ],
  };

  it("is weighted, and reports which criteria failed", () => {
    const partial = scoreDeterministic({
      kind: "rubric",
      expected: null,
      output: "The owner is Ana. Maybe we roll back.",
      config,
    });
    // owner (2) + hedging pattern present (1) = 3 of 4; rollback missing
    expect(partial.score).toBeCloseTo(0.75, 4);
    expect(partial.passed).toBe(false);
    const criteria = partial.detail.criteria as Array<{ id: string; passed: boolean }>;
    expect(criteria.find((c) => c.id === "names-rollback")?.passed).toBe(false);
    expect(criteria.find((c) => c.id === "names-owner")?.passed).toBe(true);
  });

  it("full marks only when every criterion is satisfied", () => {
    const full = scoreDeterministic({
      kind: "rubric",
      expected: null,
      output: "The owner is Ana and the rollback is documented. Maybe not needed.",
      config,
    });
    expect(full).toMatchObject({ score: 1, passed: true });
  });
});

describe("scorer config validation refuses instruments that cannot discriminate", () => {
  it("rejects a contains with no needles and a regex with no pattern", () => {
    expect(validateScorerConfig("contains", {}, null)).toMatch(/needle/);
    expect(validateScorerConfig("regex", {}, null)).toMatch(/pattern/);
    expect(validateScorerConfig("exact", {}, null)).toMatch(/expected/);
    expect(validateScorerConfig("numeric", { tolerance: 1 }, "forty-two")).toMatch(/numeric/);
    expect(validateScorerConfig("rubric", { criteria: [] }, null)).toMatch(/criterion/);
  });
  it("accepts a usable one", () => {
    expect(validateScorerConfig("contains", { needles: ["x"] }, null)).toBeNull();
    expect(validateScorerConfig("regex", { pattern: "^a$" }, null)).toBeNull();
    expect(validateScorerConfig("exact", {}, "hello")).toBeNull();
  });
});

describe("aggregate", () => {
  it("means the continuous scores and rates the booleans separately", () => {
    const agg = aggregateEvalResults([
      { score: 1, passed: true },
      { score: 0.5, passed: false },
      { score: 0, passed: false },
    ]);
    expect(agg).toEqual({ cases: 3, passedCases: 1, failedCases: 2, meanScore: 0.5, passRate: 0.3333 });
  });
  it("an empty suite aggregates to zero, not to a vacuous pass", () => {
    expect(aggregateEvalResults([])).toMatchObject({ cases: 0, meanScore: 0, passRate: 0 });
  });
});

// ---------------------------------------------------------------------------
// THE GATE
// ---------------------------------------------------------------------------

const agg = (meanScore: number, passRate = meanScore, cases = 10): EvalAggregate => ({
  cases,
  passedCases: Math.round(passRate * cases),
  failedCases: cases - Math.round(passRate * cases),
  meanScore,
  passRate,
});

describe("baseline comparison math", () => {
  it("identical results produce EXACTLY zero delta and pass", () => {
    const d = evaluateEvalGate({ current: agg(0.8), baseline: agg(0.8), tolerance: 0.05 });
    expect(d.scoreDelta).toBe(0);
    expect(d.passRateDelta).toBe(0);
    expect(d.passed).toBe(true);
    expect(d.regression).toBe(false);
    expect(d.reason).toMatch(/identical/);
  });

  it("an improvement produces a POSITIVE delta and passes", () => {
    const d = evaluateEvalGate({ current: agg(0.92), baseline: agg(0.8), tolerance: 0.05 });
    expect(d.scoreDelta).toBeGreaterThan(0);
    expect(d.scoreDelta).toBeCloseTo(0.12, 4);
    expect(d.passed).toBe(true);
  });

  it("a regression past tolerance produces a NEGATIVE delta and FAILS as a regression", () => {
    const d = evaluateEvalGate({ current: agg(0.6), baseline: agg(0.8), tolerance: 0.05 });
    expect(d.scoreDelta).toBeLessThan(0);
    expect(d.scoreDelta).toBeCloseTo(-0.2, 4);
    expect(d.passed).toBe(false);
    expect(d.regression).toBe(true);
    expect(d.reason).toMatch(/REGRESSION/);
  });

  it("the tolerance boundary is exact: a drop OF the tolerance passes, one past it fails", () => {
    const atBoundary = evaluateEvalGate({ current: agg(0.75), baseline: agg(0.8), tolerance: 0.05 });
    expect(atBoundary.passed).toBe(true);
    expect(atBoundary.regression).toBe(false);
    const justPast = evaluateEvalGate({ current: agg(0.7499), baseline: agg(0.8), tolerance: 0.05 });
    expect(justPast.passed).toBe(false);
    expect(justPast.regression).toBe(true);
  });

  it("tolerance 0 means ANY drop is a regression", () => {
    expect(evaluateEvalGate({ current: agg(0.7999), baseline: agg(0.8), tolerance: 0 }).passed).toBe(false);
    expect(evaluateEvalGate({ current: agg(0.8), baseline: agg(0.8), tolerance: 0 }).passed).toBe(true);
  });
});

describe("gate floors and missing baselines", () => {
  it("an absolute floor is NOT outranked by 'did not regress'", () => {
    // equally bad twice: zero delta, but still below the required floor
    const d = evaluateEvalGate({ current: agg(0.4), baseline: agg(0.4), tolerance: 0.5, minScore: 0.7 });
    expect(d.scoreDelta).toBe(0);
    expect(d.passed).toBe(false);
    expect(d.regression).toBe(false); // it is a floor failure, not a regression
    expect(d.reason).toMatch(/floor/);
  });

  it("a pass-rate floor fails independently of the mean score", () => {
    const d = evaluateEvalGate({ current: agg(0.9, 0.5), baseline: null, tolerance: 0.05, minPassRate: 0.8 });
    expect(d.passed).toBe(false);
    expect(d.reason).toMatch(/pass rate/);
  });

  it("no baseline stands as the first reference — unless the check requires one", () => {
    const lenient = evaluateEvalGate({ current: agg(0.9), baseline: null, tolerance: 0.05 });
    expect(lenient).toMatchObject({ passed: true, scoreDelta: null, regression: false });
    const strict = evaluateEvalGate({ current: agg(0.9), baseline: null, tolerance: 0.05, requireBaseline: true });
    expect(strict.passed).toBe(false);
  });

  it("an empty suite NEVER passes — a gate with nothing to measure certifies nothing", () => {
    const d = evaluateEvalGate({ current: agg(0, 0, 0), baseline: null, tolerance: 1 });
    expect(d.passed).toBe(false);
    expect(d.reason).toMatch(/no cases/);
  });
});

// ---------------------------------------------------------------------------
// llm_as_judge — DETERMINISTIC HALVES ONLY
//
// NOTE ON WHAT THESE PROVE. No model provider is connected in this build, so
// nothing below exercises a real judge. These cases prove that the prompt we
// would send is well formed and that a reply we might receive is parsed
// correctly and refused when it is not usable. The judge's actual JUDGMENT is
// unverified — the mechanism is proven, not the measurement.
// ---------------------------------------------------------------------------

describe("judge prompt and verdict parsing (deterministic halves)", () => {
  it("the prompt carries the input, the reference, the rubric and the required reply shape", () => {
    const p = buildJudgePrompt(
      {
        caseInput: "Summarize the incident.",
        expected: "A concise, blameless summary.",
        rubric: { mustMention: ["timeline"] },
        output: "It broke at noon.",
        instructions: "Penalize blame.",
      },
      0.8,
    );
    expect(p).toContain("Summarize the incident.");
    expect(p).toContain("A concise, blameless summary.");
    expect(p).toContain("mustMention");
    expect(p).toContain("Penalize blame.");
    expect(p).toContain("It broke at noon.");
    expect(p).toContain('"score"');
    expect(p).toContain("0.8");
  });

  it("parses a bare object, a fenced block, and an object embedded in prose", () => {
    const bare = parseJudgeVerdict('{"score":0.9,"passed":true,"rationale":"good"}', 0.8);
    expect(bare.ok && bare.verdict).toMatchObject({ score: 0.9, passed: true, rationale: "good" });
    const fenced = parseJudgeVerdict('```json\n{"score":0.4,"rationale":"thin"}\n```', 0.8);
    expect(fenced.ok && fenced.verdict.passed).toBe(false);
    const prose = parseJudgeVerdict('Here is my grade: {"score":1,"rationale":"perfect"} — hope that helps!', 0.8);
    expect(prose.ok && prose.verdict.score).toBe(1);
  });

  it("a judge that asserts passed:true below the threshold does NOT get to override it", () => {
    const r = parseJudgeVerdict('{"score":0.2,"passed":true,"rationale":"vibes"}', 0.8);
    expect(r.ok && r.verdict.passed).toBe(false);
  });

  it("an unusable verdict is an ERROR, never a silent pass", () => {
    expect(parseJudgeVerdict("Honestly, it was pretty good.", 0.8).ok).toBe(false);
    expect(parseJudgeVerdict('{"rationale":"no score here"}', 0.8).ok).toBe(false);
    expect(parseJudgeVerdict("[1,2,3]", 0.8).ok).toBe(false);
  });

  it("scores outside [0,1] are clamped rather than corrupting the aggregate", () => {
    const hi = parseJudgeVerdict('{"score":7,"rationale":"x"}', 0.8);
    expect(hi.ok && hi.verdict.score).toBe(1);
    const lo = parseJudgeVerdict('{"score":-3,"rationale":"x"}', 0.8);
    expect(lo.ok && lo.verdict.score).toBe(0);
  });
});
