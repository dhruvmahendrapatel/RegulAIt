import { describe, expect, it } from "vitest";
import {
  ABSENT,
  applyInducedRule,
  DEFAULT_RULE_INDUCTION_OPTIONS,
  extractStepFields,
  induceStepRule,
  normalizeStepOutput,
  resolveRuleInductionOptions,
  type StepRun,
} from "./index.js";

/** deterministic pseudo-random sequence (no Math.random in tests) */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const SEVERITIES = ["low", "medium", "high", "critical"] as const;
const SOURCES = ["email", "portal", "phone"] as const;

/** a triage step whose label is a pure function of severity and source, with noise fields */
function triageRuns(n: number, seed = 1): StepRun[] {
  const rnd = lcg(seed);
  const runs: StepRun[] = [];
  for (let i = 0; i < n; i++) {
    const severity = SEVERITIES[Math.floor(rnd() * SEVERITIES.length)]!;
    const source = SOURCES[Math.floor(rnd() * SOURCES.length)]!;
    const queue =
      severity === "critical" ? "on-call" : severity === "high" && source === "phone" ? "on-call" : severity === "low" ? "backlog" : "triage";
    runs.push({
      fields: { severity, source, region: ["eu", "us", "apac"][Math.floor(rnd() * 3)]!, attempt: Math.floor(rnd() * 4) },
      output: ` ${queue}\n`,
    });
  }
  return runs;
}

describe("induceStepRule (ADR-0327 slice 1)", () => {
  it("finds the smallest field set that reproduces a rule-like step", () => {
    const res = induceStepRule(triageRuns(600));
    expect(res.status).toBe("rule_like");
    if (res.status !== "rule_like") return;
    expect(res.rule.fields).toEqual(["severity", "source"]);
    expect(res.evidence.agreement).toBe(1);
    expect(res.evidence.coverage).toBe(1);
    expect(res.evidence.runs).toBe(600);
    expect(res.rule.cells).toHaveLength(12);
    expect(applyInducedRule(res.rule, { severity: "high", source: "phone", region: "eu" })).toEqual({
      matched: true,
      output: "on-call",
    });
    expect(applyInducedRule(res.rule, { severity: "high", source: "email" })).toEqual({ matched: true, output: "triage" });
  });

  it("falls back to the AI for an input outside the learned table", () => {
    const res = induceStepRule(triageRuns(600));
    if (res.status !== "rule_like") throw new Error("expected a rule");
    expect(applyInducedRule(res.rule, { severity: "unknown", source: "phone" })).toEqual({ matched: false });
    expect(applyInducedRule(res.rule, { source: "phone" })).toEqual({ matched: false });
    expect(applyInducedRule(res.rule, { severity: "high", source: "phone ", })).toEqual({ matched: false });
  });

  it("keys on zero fields when the step always returns one output", () => {
    const runs = triageRuns(300).map((r) => ({ ...r, output: "ok" }));
    const res = induceStepRule(runs);
    expect(res.status).toBe("rule_like");
    if (res.status === "rule_like") expect(res.rule.fields).toEqual([]);
  });

  it("refuses a step with too few runs", () => {
    expect(induceStepRule(triageRuns(199))).toMatchObject({ status: "not_rule_like", reason: "too_few_runs", runs: 199 });
  });

  it("refuses free-text outputs (too many classes)", () => {
    const runs = triageRuns(400).map((r, i) => ({ ...r, output: `summary ${i}` }));
    expect(induceStepRule(runs)).toMatchObject({ status: "not_rule_like", reason: "too_many_output_classes" });
  });

  it("refuses a step whose output does not follow from the fields, and reports the closest candidate", () => {
    const rnd = lcg(7);
    const runs = triageRuns(600).map((r) => ({ ...r, output: rnd() < 0.5 ? "a" : "b" }));
    const res = induceStepRule(runs);
    expect(res).toMatchObject({ status: "not_rule_like", reason: "no_rule_met_thresholds" });
    if (res.status === "not_rule_like") expect(res.closest?.agreement ?? 0).toBeLessThan(0.95);
  });

  it("does not accept a rule that agrees only 97% of the time under the strict default", () => {
    const rnd = lcg(11);
    const runs = triageRuns(1000).map((r) => (rnd() < 0.03 ? { ...r, output: "escalate-to-legal" } : r));
    const strict = induceStepRule(runs);
    expect(strict.status).toBe("not_rule_like");
    // an org may relax to the floor, and then the same history passes
    const relaxed = induceStepRule(runs, { minAgreement: 0.95 });
    expect(relaxed.status).toBe("rule_like");
  });

  it("measures agreement on held-out runs, so a memorised table of one-off keys is not a rule", () => {
    // each ticket has exactly minCellSupport runs, one per fold, and a random label: on all rows the ticket
    // table looks perfect, but no training fold ever has enough support to cover its held-out run
    const rnd = lcg(5);
    const labels = Array.from({ length: 80 }, () => (rnd() < 0.5 ? "a" : "b"));
    const runs: StepRun[] = Array.from({ length: 400 }, (_, i) => ({
      fields: { ticket: `T-${Math.floor(i / 5)}`, channel: i % 2 === 0 ? "x" : "y" },
      output: labels[Math.floor(i / 5)]!,
    }));
    expect(induceStepRule(runs)).toMatchObject({ status: "not_rule_like", reason: "no_rule_met_thresholds" });
  });

  it("leaves impure cells out so they fall back to the AI", () => {
    const runs = triageRuns(800).map((r) =>
      r.fields.severity === "medium" ? { ...r, output: r.fields.attempt === 0 ? "triage" : "vendor" } : r,
    );
    const res = induceStepRule(runs, { minCoverage: 0.7 });
    expect(res.status).toBe("rule_like");
    if (res.status !== "rule_like") return;
    expect(res.evidence.coverage).toBeLessThan(0.9);
    expect(applyInducedRule(res.rule, { severity: "medium", source: "email" })).toEqual({ matched: false });
  });

  it("distinguishes an absent field from null and from the string 'null'", () => {
    const runs: StepRun[] = [];
    for (let i = 0; i < 300; i++) {
      const v = i % 3;
      runs.push({ fields: v === 0 ? {} : { owner: v === 1 ? null : "null" }, output: ["unassigned", "orphan", "named"][v]! });
    }
    const res = induceStepRule(runs);
    expect(res.status).toBe("rule_like");
    if (res.status !== "rule_like") return;
    expect(res.rule.cells.map((c) => c.key[0])).toContainEqual(ABSENT);
    expect(applyInducedRule(res.rule, {})).toEqual({ matched: true, output: "unassigned" });
    expect(applyInducedRule(res.rule, { owner: null })).toEqual({ matched: true, output: "orphan" });
    expect(applyInducedRule(res.rule, { owner: "null" })).toEqual({ matched: true, output: "named" });
  });

  it("is deterministic", () => {
    expect(induceStepRule(triageRuns(500, 3))).toEqual(induceStepRule(triageRuns(500, 3)));
  });
});

describe("resolveRuleInductionOptions", () => {
  it("defaults are strict", () => {
    expect(resolveRuleInductionOptions()).toEqual(DEFAULT_RULE_INDUCTION_OPTIONS);
    expect(DEFAULT_RULE_INDUCTION_OPTIONS.minAgreement).toBe(0.99);
    expect(DEFAULT_RULE_INDUCTION_OPTIONS.minRuns).toBe(200);
  });

  it("refuses thresholds below the floors and search sizes above the ceilings", () => {
    expect(() => resolveRuleInductionOptions({ minAgreement: 0.9 })).toThrow(RangeError);
    expect(() => resolveRuleInductionOptions({ minRuns: 10 })).toThrow(RangeError);
    expect(() => resolveRuleInductionOptions({ minCoverage: 0.2 })).toThrow(RangeError);
    expect(() => resolveRuleInductionOptions({ minCellSupport: 1 })).toThrow(RangeError);
    expect(() => resolveRuleInductionOptions({ maxFields: 5 })).toThrow(RangeError);
    expect(() => resolveRuleInductionOptions({ maxRuns: 1e9 })).toThrow(RangeError);
    expect(() => resolveRuleInductionOptions({ folds: 1 })).toThrow(RangeError);
    expect(() => resolveRuleInductionOptions({ minAgreement: Number.NaN })).toThrow(RangeError);
    expect(() => resolveRuleInductionOptions({ minAgreement: 1.5 })).toThrow(RangeError);
  });

  it("lets an org tighten", () => {
    expect(resolveRuleInductionOptions({ minAgreement: 0.999, minRuns: 1000 })).toMatchObject({
      minAgreement: 0.999,
      minRuns: 1000,
    });
  });
});

describe("extractStepFields / normalizeStepOutput", () => {
  it("flattens one nested level of scalars", () => {
    expect({ ...extractStepFields('{"a":"x","b":{"c":1,"d":[1]},"e":[2],"f":null}') }).toEqual({ a: "x", "b.c": 1, f: null });
  });

  it("skips text that is not a JSON object, including a truncated preview", () => {
    expect(extractStepFields('{"a":"x","b":')).toBeNull();
    expect(extractStepFields("[1,2]")).toBeNull();
    expect(extractStepFields("plain text")).toBeNull();
  });

  it("does not let a __proto__ key reach the prototype", () => {
    const f = extractStepFields('{"__proto__":"x","k":"v"}');
    expect(f && Object.getPrototypeOf(f)).toBeNull();
    expect(f?.["__proto__"]).toBe("x");
  });

  it("keeps case and collapses whitespace", () => {
    expect(normalizeStepOutput("  On-Call \n now ")).toBe("On-Call now");
  });
});
