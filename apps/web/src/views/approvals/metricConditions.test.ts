import { describe, expect, it } from "vitest";
import {
  blankMetricCondition,
  describeMetricDraft,
  evidenceHref,
  hasMetricErrors,
  metricConditionBody,
  validateMetricCondition,
} from "./metricConditions";

describe("a measured condition draft (ADR-0180 A2)", () => {
  it("the default draft validates and posts the exact decide shape", () => {
    const d = blankMetricCondition();
    expect(hasMetricErrors(validateMetricCondition(d))).toBe(false);
    expect(metricConditionBody(d)).toEqual({
      kind: "metric",
      text: "Error rate below 5 % over 7 days (at least 50 samples)",
      blocking: true,
      metric: "error_rate",
      params: {},
      operator: "lt",
      threshold: 5,
      windowDays: 7,
      minSamples: 50,
      cadence: "daily",
      onBreach: "alert",
    });
  });

  it("refuses a missing threshold, a window outside 1..90 and a zero sample minimum", () => {
    const e = validateMetricCondition({ ...blankMetricCondition(), threshold: "", windowDays: "120", minSamples: "0" });
    expect(e).toEqual({ threshold: "Enter a number.", windowDays: "Between 1 and 90 days.", minSamples: "Between 1 and 100,000." });
  });

  it("a guardrail-mode condition names its detector; a pack condition its framework and control", () => {
    const g = { ...blankMetricCondition(), metric: "guardrail_mode" as const, operator: "gte" as const, threshold: "3", minSamples: "1", detector: "jailbreak" };
    expect(metricConditionBody(g).params).toEqual({ detector: "jailbreak" });
    expect(describeMetricDraft(g)).toBe("Guardrail mode (Jailbreak) at least 3 level over 7 days (at least 1 sample)");
    const p = { ...blankMetricCondition(), metric: "pack_control_evidenced" as const, operator: "eq" as const, threshold: "1", minSamples: "1" };
    expect(validateMetricCondition(p)).toMatchObject({ framework: expect.any(String), controlRef: expect.any(String) });
    expect(metricConditionBody({ ...p, framework: " EU AI Act ", controlRef: "art-14 " }).params).toEqual({ framework: "EU AI Act", controlRef: "art-14" });
  });

  it("links a trace to its trace view and an unknown evidence type nowhere", () => {
    expect(evidenceHref({ type: "trace", id: "t 1" })).toBe("/admin/traces?trace=t%201");
    expect(evidenceHref({ type: "mystery", id: "x" })).toBeNull();
  });
});
