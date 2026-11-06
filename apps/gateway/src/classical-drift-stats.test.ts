/**
 * ADR-0223 (P13b) — the pure drift statistics and the payload rules. No database.
 */
import { describe, expect, it } from "vitest";
import {
  DriftShapeError,
  STRICT_DRIFT_THRESHOLDS,
  binnedKs,
  computeDrift,
  driftFeatureSetSchema,
  explainabilitySchema,
  featureTexts,
  kolmogorovQ,
  modelVersionSchema,
  payloadSha256,
  personalDataCategories,
  type DriftFeature,
} from "./classical-drift-stats.js";

const num = (name: string, counts: number[]): DriftFeature => ({ name, kind: "numeric", edges: counts.map((_, i) => i).concat(counts.length), counts });
const cat = (name: string, categories: string[], counts: number[]): DriftFeature => ({ name, kind: "categorical", categories, counts });

describe("ADR-0223 drift statistics", () => {
  it("PSI and Jensen–Shannon match their definitions on a small example", () => {
    const ref = [num("score", [500, 500])];
    const prod = [num("score", [400, 600])];
    const out = computeDrift(ref, prod, STRICT_DRIFT_THRESHOLDS, 100);
    const p = [0.4, 0.6];
    const q = [0.5, 0.5];
    const psi = (p[0]! - q[0]!) * Math.log(p[0]! / q[0]!) + (p[1]! - q[1]!) * Math.log(p[1]! / q[1]!);
    const m = [0.45, 0.55];
    const js = 0.5 * (q[0]! * Math.log(q[0]! / m[0]!) + q[1]! * Math.log(q[1]! / m[1]!)) + 0.5 * (p[0]! * Math.log(p[0]! / m[0]!) + p[1]! * Math.log(p[1]! / m[1]!));
    expect(out.results[0]!.psi).toBeCloseTo(psi, 5);
    expect(out.results[0]!.js).toBeCloseTo(js, 5);
    expect(out.results[0]!.ksD).toBeCloseTo(0.1, 6);
    expect(out.results[0]!.status).toBe("within");
    expect(out.status).toBe("within");
  });

  it("identical distributions are within thresholds with a KS p-value of 1", () => {
    const f = [num("x", [10, 20, 70])];
    const out = computeDrift(f, f, STRICT_DRIFT_THRESHOLDS, 1);
    expect(out.results[0]).toMatchObject({ psi: 0, js: 0, ksD: 0, ksP: 1, status: "within", breached: [] });
  });

  it("a shifted distribution is drift, names the statistics it crossed, and counts the feature", () => {
    const out = computeDrift([num("x", [800, 200, 0])], [num("x", [100, 300, 600])], STRICT_DRIFT_THRESHOLDS, 100);
    expect(out.status).toBe("drift");
    expect(out.driftedFeatures).toBe(1);
    expect(out.results[0]!.breached).toEqual(["psi", "js", "ks"]);
    // an empty reference bin is floored, so the value is large but finite
    expect(Number.isFinite(out.results[0]!.psi)).toBe(true);
    expect(out.results[0]!.ksP).toBeLessThan(0.001);
  });

  it("a PSI between the warning and alert thresholds is a warning, not drift", () => {
    // PSI ≈ 0.16 with the JS and KS thresholds loosened out of the way
    const out = computeDrift([num("x", [500, 500])], [num("x", [300, 700])], { psiWarn: 0.1, psiAlert: 0.25, ksAlert: 1, jsAlert: 0.7 }, 100);
    expect(out.results[0]!.psi).toBeGreaterThan(0.1);
    expect(out.results[0]!.psi).toBeLessThan(0.25);
    expect(out.status).toBe("warn");
  });

  it("too few production samples is insufficient, never drift, and holds the report", () => {
    const out = computeDrift([num("x", [800, 200])], [num("x", [1, 9])], STRICT_DRIFT_THRESHOLDS, 100);
    expect(out.results[0]).toMatchObject({ status: "insufficient", breached: [] });
    expect(out.status).toBe("insufficient");
    // drift on another feature still wins
    const mixed = computeDrift(
      [num("x", [800, 200]), num("y", [900, 100])],
      [num("x", [1, 9]), num("y", [100, 900])],
      STRICT_DRIFT_THRESHOLDS,
      100,
    );
    expect(mixed.status).toBe("drift");
  });

  it("categorical features align by label, a new label counts as zero in the reference, and KS does not apply", () => {
    const out = computeDrift([cat("region", ["north", "south"], [500, 500])], [cat("region", ["south", "east"], [500, 500])], STRICT_DRIFT_THRESHOLDS, 100);
    expect(out.results[0]!.ksD).toBeNull();
    expect(out.results[0]!.ksP).toBeNull();
    expect(out.results[0]!.status).toBe("drift");
  });

  it("refuses a summary that does not match the reference's shape", () => {
    const ref = [num("x", [1, 1])];
    const shape = (prod: DriftFeature[]) => {
      try {
        computeDrift(ref, prod, STRICT_DRIFT_THRESHOLDS, 1);
        return null;
      } catch (e) {
        return e instanceof DriftShapeError ? e.code : "other";
      }
    };
    expect(shape([])).toBe("feature_missing");
    expect(shape([num("x", [1, 1]), num("y", [1, 1])])).toBe("feature_unknown");
    expect(shape([cat("x", ["a"], [2])])).toBe("kind_mismatch");
    expect(shape([{ name: "x", kind: "numeric", edges: [0, 1, 3], counts: [1, 1] }])).toBe("bins_mismatch");
  });

  /**
   * Reference values from an independent implementation (SciPy 1.18.1), not re-derived from the code under test:
   *   kolmogorovQ(λ)  scipy.stats.kstwobign.sf(λ)
   *   js              scipy.spatial.distance.jensenshannon(q, p) ** 2   (natural log)
   *   psi             numpy.sum(scipy.special.rel_entr(p, q) + rel_entr(q, p))
   *   ks D            scipy.stats.ks_2samp(a, b).statistic, with each count expanded into samples at its bin midpoint
   */
  it.each([
    [0.002, 1.0],
    [0.005, 1.0],
    [0.01, 1.0],
    [0.1, 1.0],
    [0.3, 0.9999906941986655],
    [0.5, 0.9639452436648751],
    [0.8, 0.5441424115741981],
    [1.0, 0.26999967167735456],
    [1.18, 0.1234538094297657],
    [1.2, 0.11224966667072497],
    [1.5, 0.022217962616525127],
    [2.0, 0.0006709252557796953],
    [3.0, 3.045995948942526e-8],
  ])("the Kolmogorov survival function matches scipy kstwobign.sf at λ = %s", (lambda, expected) => {
    expect(Math.abs(kolmogorovQ(lambda) - expected)).toBeLessThan(1e-9);
  });

  it("near-identical distributions at large n have a KS p-value near 1, not a false 'significant' one", () => {
    // n₁ = n₂ = 10⁶ and D = 10⁻⁵ gives λ ≈ 0.007, where the alternating series alone returned a value well below 1
    const { d, p } = binnedKs([500_000, 500_000], [500_010, 499_990]);
    expect(d).toBeCloseTo(1e-5, 12);
    expect(p).toBe(1);
    expect(kolmogorovQ(0)).toBe(1);
    expect(() => kolmogorovQ(-1)).toThrow(RangeError);
    expect(() => kolmogorovQ(Number.NaN)).toThrow(RangeError);
  });

  it("PSI, Jensen–Shannon and KS D match SciPy on a five-bin histogram", () => {
    const out = computeDrift([num("x", [120, 340, 280, 160, 100])], [num("x", [60, 200, 300, 260, 180])], STRICT_DRIFT_THRESHOLDS, 100);
    const r = out.results[0]!;
    expect(r.psi).toBeCloseTo(0.2128303581823792, 5);
    expect(r.js).toBeCloseTo(0.026252604314891168, 5);
    expect(r.ksD).toBeCloseTo(0.2, 6);
  });

  it("binned KS: D is the largest gap between the cumulative proportions", () => {
    const { d, p } = binnedKs([25, 25, 25, 25], [0, 0, 50, 50]);
    expect(d).toBeCloseTo(0.5, 10);
    expect(p).toBeLessThan(0.05);
  });
});

describe("ADR-0223 payload rules", () => {
  it("bounds and validates a feature set", () => {
    expect(driftFeatureSetSchema.safeParse([num("x", [1, 2])]).success).toBe(true);
    expect(driftFeatureSetSchema.safeParse([]).success).toBe(false);
    expect(driftFeatureSetSchema.safeParse([{ name: "x", kind: "numeric", edges: [0, 0], counts: [1] }]).success).toBe(false);
    expect(driftFeatureSetSchema.safeParse([{ name: "x", kind: "numeric", edges: [0, 1], counts: [1, 2] }]).success).toBe(false);
    expect(driftFeatureSetSchema.safeParse([num("x", [0, 0])]).success).toBe(false);
    expect(driftFeatureSetSchema.safeParse([num("x", [1]), num("x", [1])]).success).toBe(false);
    expect(driftFeatureSetSchema.safeParse([cat("c", ["a", "a"], [1, 1])]).success).toBe(false);
    expect(driftFeatureSetSchema.safeParse([num("x", [-1, 2])]).success).toBe(false);
    expect(driftFeatureSetSchema.safeParse([num("bad<name>", [1])]).success).toBe(false);
    expect(driftFeatureSetSchema.safeParse(Array.from({ length: 201 }, (_, i) => num(`f${i}`, [1]))).success).toBe(false);
    expect(driftFeatureSetSchema.safeParse([num("x", Array.from({ length: 101 }, () => 1))]).success).toBe(false);
    expect(driftFeatureSetSchema.safeParse([{ ...num("x", [1]), extra: true }]).success).toBe(false);
  });

  it("flags a category label that looks like personal data, by category only", () => {
    expect(personalDataCategories(featureTexts([cat("tier", ["gold", "silver"], [1, 1])]))).toEqual([]);
    const hits = personalDataCategories(featureTexts([cat("customer", ["someone@regulait.example", "x"], [1, 1])]));
    expect(hits).toEqual(["email"]);
  });

  it("validates explainability artefacts", () => {
    expect(explainabilitySchema.safeParse({ kind: "shap_summary", method: "mean |SHAP|", importances: [{ feature: "age", value: 0.3 }] }).success).toBe(true);
    expect(explainabilitySchema.safeParse({ kind: "shap_summary", method: "m", importances: [{ feature: "a", value: 1 }, { feature: "a", value: 2 }] }).success).toBe(false);
    expect(explainabilitySchema.safeParse({ kind: "other", method: "m", importances: [{ feature: "a", value: 1 }] }).success).toBe(false);
  });

  it("hashes the canonical payload: sorted keys, so any key order gives the same hash", () => {
    // python: hashlib.sha256(json.dumps(o, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    const expected = "2be1e94a66ad074d1d8e041d45ca00506175ec63babe97da207a8c163bf788fa";
    expect(payloadSha256([{ name: "x", kind: "numeric", edges: [0, 1], counts: [1] }])).toBe(expected);
    expect(payloadSha256([{ counts: [1], kind: "numeric", edges: [0, 1], name: "x" }])).toBe(expected);
  });

  it("bounds a declared model version", () => {
    expect(modelVersionSchema.safeParse("scorecard-2026.10").success).toBe(true);
    expect(modelVersionSchema.safeParse("").success).toBe(false);
    expect(modelVersionSchema.safeParse("x".repeat(201)).success).toBe(false);
    expect(modelVersionSchema.safeParse("v1\nv2").success).toBe(false);
  });
});
