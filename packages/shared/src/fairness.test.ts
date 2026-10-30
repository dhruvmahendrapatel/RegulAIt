/**
 * ADR-0222 — the fairness metrics, pinned against fairlearn.
 *
 * `__fixtures__/fairness-golden.json` holds 240 synthetic rows and the values
 * fairlearn 0.13.0 computed on them (`__fixtures__/fairness-golden-gen.py`
 * regenerates it). If a formula here drifts from the library's definition,
 * the golden case fails rather than a customer's report silently changing.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FAIRNESS_DEFAULT_THRESHOLDS,
  FAIRNESS_METRICS,
  computeFairness,
  createFairnessDatasetSchema,
  fairnessOutcomeBlocks,
  fairnessSettingsRelaxed,
  runFairnessTestSchema,
  type FairnessRows,
} from "./fairness.js";

const golden = JSON.parse(readFileSync(new URL("./__fixtures__/fairness-golden.json", import.meta.url), "utf8")) as {
  fairlearn: string;
  rows: Array<{ sex: string; age_band: string; label: number; prediction: number }>;
  expected: Record<string, Record<string, number>>;
};

const goldenRows: FairnessRows = {
  labels: golden.rows.map((r) => r.label),
  predictions: golden.rows.map((r) => r.prediction),
  attributes: { sex: golden.rows.map((r) => r.sex), age_band: golden.rows.map((r) => r.age_band) },
};

function rowsOf(spec: Array<[group: string, label: number, prediction: number, count: number]>): FairnessRows {
  const labels: number[] = [];
  const predictions: number[] = [];
  const g: string[] = [];
  for (const [group, label, prediction, count] of spec) {
    for (let i = 0; i < count; i++) {
      labels.push(label);
      predictions.push(prediction);
      g.push(group);
    }
  }
  return { labels, predictions, attributes: { group: g } };
}

describe("computeFairness — the fairlearn definitions", () => {
  it("matches fairlearn 0.13.0 on every metric and attribute of the golden dataset", () => {
    expect(golden.fairlearn).toBe("0.13.0");
    const r = computeFairness(goldenRows, { minGroupSize: 1 });
    for (const attr of r.attributes) {
      for (const m of FAIRNESS_METRICS) {
        expect(attr.metrics[m].value, `${attr.attribute} ${m}`).toBeCloseTo(golden.expected[attr.attribute]![m]!, 12);
      }
    }
    expect(r.rowCount).toBe(240);
  });

  it("fails the golden dataset under the strict defaults, and names each breach", () => {
    const r = computeFairness(goldenRows, { minGroupSize: 1 });
    expect(r.outcome).toBe("fail");
    const breaches = r.evaluations.filter((e) => e.status === "breach").map((e) => `${e.attribute}:${e.metric}`);
    // sex: DPD 0.121 > 0.1, DIR 0.777 < 0.8, EOpD 0.101 > 0.1, EOD 0.101 > 0.1; age band: EOpD/EOD 0.144 > 0.1
    expect(breaches.sort()).toEqual(
      [
        "age_band:equal_opportunity_difference",
        "age_band:equalized_odds_difference",
        "sex:demographic_parity_difference",
        "sex:disparate_impact_ratio",
        "sex:equal_opportunity_difference",
        "sex:equalized_odds_difference",
      ].sort(),
    );
  });
});

describe("computeFairness — outcomes", () => {
  it("passes identical groups, and a ratio exactly on the four-fifths line is not a breach", () => {
    const equal = rowsOf([
      ["a", 1, 1, 40],
      ["a", 0, 0, 40],
      ["b", 1, 1, 40],
      ["b", 0, 0, 40],
    ]);
    expect(computeFairness(equal).outcome).toBe("pass");
    // selection 0.4 vs 0.5: ratio 0.8000000000000002 in floating point; only the ratio is checked
    const fourFifths = rowsOf([
      ["a", 1, 1, 40],
      ["a", 0, 0, 60],
      ["b", 1, 1, 50],
      ["b", 0, 0, 50],
    ]);
    const r = computeFairness(fourFifths, { thresholds: [{ metric: "disparate_impact_ratio", limit: 0.8, action: "fail" }] });
    expect(r.attributes[0]!.metrics.disparate_impact_ratio.value).toBeCloseTo(0.8, 12);
    expect(r.outcome).toBe("pass");
  });

  it("a breach of a flag threshold flags but does not fail", () => {
    const skew = rowsOf([
      ["a", 1, 1, 30],
      ["a", 0, 0, 70],
      ["b", 1, 1, 60],
      ["b", 0, 0, 40],
    ]);
    const r = computeFairness(skew, { thresholds: [{ metric: "demographic_parity_difference", limit: 0.1, action: "flag" }] });
    expect(r.outcome).toBe("flag");
    expect(fairnessOutcomeBlocks(r.outcome)).toBe(false);
  });

  it("leaves a group below the minimum size out of the metrics, and one group left is inconclusive, never a pass", () => {
    const small = rowsOf([
      ["a", 1, 1, 50],
      ["a", 0, 0, 50],
      ["b", 1, 0, 5],
    ]);
    const r = computeFairness(small, { minGroupSize: 30 });
    const b = r.attributes[0]!.groups.find((g) => g.group === "b")!;
    expect(b.included).toBe(false);
    expect(r.attributes[0]!.metrics.demographic_parity_difference.value).toBeNull();
    expect(r.outcome).toBe("inconclusive");
    expect(fairnessOutcomeBlocks("inconclusive")).toBe(true);
    expect(fairnessOutcomeBlocks("fail")).toBe(true);
    expect(fairnessOutcomeBlocks("pass")).toBe(false);
  });

  it("a group with no favourable labels makes the opportunity metrics not computable, with a reason", () => {
    const noPositives = rowsOf([
      ["a", 1, 1, 40],
      ["a", 0, 0, 40],
      ["b", 0, 0, 70],
      ["b", 0, 1, 10],
    ]);
    const r = computeFairness(noPositives);
    const m = r.attributes[0]!.metrics;
    expect(m.equal_opportunity_difference.value).toBeNull();
    expect(m.equal_opportunity_difference.reason).toMatch(/no rows with a favourable true label/);
    expect(m.equalized_odds_difference.value).toBeNull();
    expect(r.outcome).toBe("fail"); // selection 0.5 vs 0.125 also breaches: fail outranks inconclusive
  });

  it("the default thresholds check every metric with fail", () => {
    expect(FAIRNESS_DEFAULT_THRESHOLDS.map((t) => t.metric).sort()).toEqual([...FAIRNESS_METRICS].sort());
    expect(FAIRNESS_DEFAULT_THRESHOLDS.every((t) => t.action === "fail")).toBe(true);
  });
});

describe("the request schemas", () => {
  const base = { name: "Loans Q3", csv: "a,b,c\n1,1,x\n", labelColumn: "a", predictionColumn: "b", favourableLabel: "1", protectedAttributes: ["c"] };
  it("refuses a column used twice and an unknown field", () => {
    expect(createFairnessDatasetSchema.safeParse(base).success).toBe(true);
    expect(createFairnessDatasetSchema.safeParse({ ...base, protectedAttributes: ["a"] }).success).toBe(false);
    expect(createFairnessDatasetSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
  it("refuses two thresholds for one metric and a limit outside 0..1", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const t = { metric: "disparate_impact_ratio", limit: 0.8, action: "fail" } as const;
    expect(runFairnessTestSchema.safeParse({ datasetId: id, cardId: id, thresholds: [t] }).success).toBe(true);
    expect(runFairnessTestSchema.safeParse({ datasetId: id, cardId: id, thresholds: [t, t] }).success).toBe(false);
    expect(runFairnessTestSchema.safeParse({ datasetId: id, cardId: id, thresholds: [{ ...t, limit: 1.5 }] }).success).toBe(false);
  });
});

describe("fairnessSettingsRelaxed", () => {
  const strict = { fairnessTestingEnabled: false, fairnessBlockOnFail: true, fairnessDatasetRetentionDays: 30 };
  it("turning the feature on, blocking off and a longer retention are relaxations; tightening is not", () => {
    expect(fairnessSettingsRelaxed({ enabled: true }, strict)).toEqual({ fairnessTestingEnabled: true });
    expect(fairnessSettingsRelaxed({ blockOnFail: false }, strict)).toEqual({ fairnessBlockOnFail: false });
    expect(fairnessSettingsRelaxed({ datasetRetentionDays: 90 }, strict)).toEqual({ fairnessDatasetRetentionDays: 90 });
    expect(fairnessSettingsRelaxed({ enabled: false, blockOnFail: true, datasetRetentionDays: 7 }, strict)).toEqual({});
  });
  it("lengthening a retention an admin had shortened is a relaxation even below the default", () => {
    expect(fairnessSettingsRelaxed({ datasetRetentionDays: 14 }, { ...strict, fairnessDatasetRetentionDays: 7 })).toEqual({
      fairnessDatasetRetentionDays: 14,
    });
  });
});
