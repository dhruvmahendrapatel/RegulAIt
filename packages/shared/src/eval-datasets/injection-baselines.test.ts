/**
 * ADR-0244 (P25) — the pinned prompt-injection baselines. The snapshots must
 * rehash to their pins, and the heuristic detector is re-measured on every run:
 * a drop in recall or precision, or a rise in FPR, beyond the configured
 * tolerance fails CI and prints the delta table. Re-pin after a reviewed change
 * with `node scripts/injection-eval-baseline.mjs --write`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GUARDRAIL_DETECTORS } from "../guardrails.js";
import {
  INJECTION_BASELINE_DATASET_IDS,
  INJECTION_BASELINE_FILES,
  INJECTION_BASELINE_VENDOR_DIR,
  compareInjectionBaseline,
  formatInjectionBaselineDeltas,
  injectionBaselineExpectedSchema,
  metricsFromMatrix,
  parseInjectionBaselineSnapshot,
  poolMetrics,
  scoreInjectionCases,
  snapshotSha256,
  type DetectorMetrics,
  type InjectionBaselineDatasetId,
} from "./injection-baselines.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.join(here, INJECTION_BASELINE_VENDOR_DIR);
const read = (rel: string) => readFileSync(path.join(vendor, rel));

interface ManifestSource {
  id: string;
  commit: string;
  licence: string;
  licenceFile: string;
  licenceSha256: string;
  file: string;
  sha256: string;
  bytes: number;
  cases: number;
  injection: number;
  benign: number;
  sampling: { method: string; seed?: number };
}
const manifest = JSON.parse(read("MANIFEST.json").toString("utf8")) as {
  seed: number;
  sources: ManifestSource[];
  excluded: Array<{ id: string; reason: string }>;
};
const expected = injectionBaselineExpectedSchema.parse(
  JSON.parse(readFileSync(path.join(here, "injection-baselines.expected.json"), "utf8")),
);

describe("vendored injection snapshots (pins, licences, manifest)", () => {
  it("every snapshot rehashes to its pin, and MANIFEST.json agrees with the code", () => {
    expect(manifest.sources.map((s) => s.id).sort()).toEqual([...INJECTION_BASELINE_DATASET_IDS].sort());
    for (const s of manifest.sources) {
      const pin = INJECTION_BASELINE_FILES[s.id as InjectionBaselineDatasetId];
      const bytes = read(s.file);
      expect(snapshotSha256(bytes)).toBe(pin.sha256);
      expect(s).toMatchObject({ file: pin.file, sha256: pin.sha256, bytes: bytes.length, cases: pin.cases, injection: pin.injection, benign: pin.benign, commit: pin.commit });
      expect(s.licence).toBe("MIT");
      const licence = read(s.licenceFile);
      expect(snapshotSha256(licence)).toBe(s.licenceSha256);
      expect(licence.toString("utf8")).toMatch(/^MIT License/);
    }
  });

  it("records the sampling seed, and why HackAPrompt is not vendored", () => {
    expect(manifest.seed).toBe(20261107);
    expect(manifest.sources.find((s) => s.id === "injecagent")?.sampling).toMatchObject({ seed: 20261107 });
    expect(manifest.excluded.map((e) => e.id)).toEqual(["hackaprompt"]);
  });

  it("refuses a snapshot whose bytes drifted, before parsing it", () => {
    const bytes = Buffer.concat([read(INJECTION_BASELINE_FILES.notinject.file), Buffer.from(" ")]);
    expect(() => parseInjectionBaselineSnapshot("notinject", bytes)).toThrow(/sha256/);
  });
});

describe("metrics and the regression rule", () => {
  it("leaves a metric undefined when its denominator class is absent", () => {
    expect(metricsFromMatrix({ tp: 0, fp: 3, fn: 0, tn: 7 })).toMatchObject({ recall: null, fpr: 0.3, precision: 0 });
    expect(metricsFromMatrix({ tp: 6, fp: 0, fn: 4, tn: 0 })).toMatchObject({ recall: 0.6, fpr: null, precision: 1 });
  });

  it("fails only on a change worse than the tolerance, in the right direction", () => {
    const pinned: DetectorMetrics = metricsFromMatrix({ tp: 50, fp: 5, fn: 50, tn: 95 });
    const at = (m: Parameters<typeof metricsFromMatrix>[0]) => ({ datasets: { agentdojo: metricsFromMatrix(m) }, pooled: metricsFromMatrix(m) });
    const tol = { precision: 0.02, recall: 0.02, fpr: 0.02 };
    const same = compareInjectionBaseline(at(pinned), at(pinned), tol);
    expect(same.some((d) => d.regression)).toBe(false);
    const better = compareInjectionBaseline(at(pinned), at({ tp: 80, fp: 0, fn: 20, tn: 100 }), tol);
    expect(better.some((d) => d.regression)).toBe(false);
    const lowerRecall = compareInjectionBaseline(at(pinned), at({ tp: 47, fp: 5, fn: 53, tn: 95 }), tol);
    expect(lowerRecall.filter((d) => d.regression).map((d) => d.metric)).toContain("recall");
    const moreFalseAlarms = compareInjectionBaseline(at(pinned), at({ tp: 50, fp: 8, fn: 50, tn: 92 }), tol);
    expect(moreFalseAlarms.filter((d) => d.regression).map((d) => d.metric)).toContain("fpr");
  });
});

describe("heuristic prompt_injection detector against the pinned baseline (gated)", () => {
  it("does not regress beyond the configured tolerance on any dataset", () => {
    const datasets = {} as Record<InjectionBaselineDatasetId, DetectorMetrics>;
    for (const id of INJECTION_BASELINE_DATASET_IDS) {
      const cases = parseInjectionBaselineSnapshot(id, read(INJECTION_BASELINE_FILES[id].file));
      datasets[id] = scoreInjectionCases(cases, (c) => GUARDRAIL_DETECTORS.prompt_injection.detect(c.text, []).length > 0).metrics;
    }
    const measured = { datasets, pooled: poolMetrics(Object.values(datasets)) };
    const pinned = expected.detectors.heuristic_prompt_injection;
    expect(pinned.gated).toBe(true);
    const deltas = compareInjectionBaseline(pinned, measured, expected.tolerance);
    const table = formatInjectionBaselineDeltas("heuristic_prompt_injection", deltas);
    console.info(table);
    expect(deltas.filter((d) => d.regression), table).toEqual([]);
  });

  it("records the trained classifier's offline numbers, not gated in CI (its image is not built here)", () => {
    const trained = expected.detectors.trained_prompt_injection;
    expect(trained.gated).toBe(false);
    expect(trained.threshold).toBe(0.5);
    for (const id of INJECTION_BASELINE_DATASET_IDS) {
      const m = trained.datasets[id];
      expect(m.tp + m.fp + m.fn + m.tn).toBe(INJECTION_BASELINE_FILES[id].cases);
    }
  });
});
