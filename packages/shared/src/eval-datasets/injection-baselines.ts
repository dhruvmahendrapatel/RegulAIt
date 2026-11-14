/**
 * ADR-0244 (P25) — PINNED, OFFLINE BASELINES FOR THE PROMPT-INJECTION DETECTORS.
 *
 * Three MIT-licensed public benchmarks are vendored as normalised snapshots
 * under `vendor/injection-baselines/` (written by
 * `scripts/refresh-injection-eval-snapshots.py`, never downloaded at run time;
 * upstream commit, licence, sampling seed and per-file sha256 in
 * `MANIFEST.json`; attribution in `THIRD_PARTY.md`):
 *
 *   notinject   339 benign prompts full of injection trigger words (the
 *               false-positive baseline; no injections, so recall is n/a)
 *   injecagent  300 indirect injections inside tool responses, a stratified
 *               sample of the 2,108 base and enhanced cases (no benign cases,
 *               so FPR is n/a)
 *   agentdojo   135 injection texts (27 goals x 5 task-independent attacks)
 *               and the 97 benign user-task prompts of benchmark v1
 *   jailbreakbench  150 adversarial jailbreak prompts (30 per attack method,
 *               seeded, deduplicated; responses never vendored) and the 100
 *               benign JBB-Behaviors. These are jailbreaks, not injections, so
 *               they measure the injection detectors outside their target.
 *
 * plus one set of OUR OWN content, written for RegulAIt (proprietary, like the
 * rest of the repository), pinned in the same manifest:
 *
 *   regulait-web-agent  50 injections aimed at a web-browsing agent (the ten
 *               security-violation categories WASP publishes, arXiv:2504.18575,
 *               x five carriers: page text, hidden HTML, form fields, search
 *               results, tool output) and 50 benign look-alikes. WASP itself is
 *               CC BY-NC, so none of its tasks, prompts or templates is used;
 *               its category names are cited only.
 *
 * `injection-baselines.expected.json` pins the measured numbers per detector
 * and dataset with a tolerance. The test re-measures the heuristic detector on
 * every run and fails on a regression beyond the tolerance, printing the delta
 * table; the trained classifier is measured offline by
 * `agents/trained-detectors/eval_baselines.py` (its image is not built in CI,
 * ADR-0220 §8), so its numbers are recorded, not gated.
 *
 * This module is PURE (no file system): the pins, the record schema, the
 * metrics and the comparison. A confusion matrix is four counts, so no library
 * is used for it (ADR-0176 search recorded in ADR-0244).
 */
import { createHash } from "node:crypto";
import { z } from "zod";

/** relative to `packages/shared/src/eval-datasets/` */
export const INJECTION_BASELINE_VENDOR_DIR = "vendor/injection-baselines";

export const INJECTION_BASELINE_DATASET_IDS = ["notinject", "injecagent", "agentdojo", "jailbreakbench", "regulait-web-agent"] as const;
export type InjectionBaselineDatasetId = (typeof INJECTION_BASELINE_DATASET_IDS)[number];

/** the snapshot pins; `MANIFEST.json` carries the same values and the test keeps them equal */
export const INJECTION_BASELINE_FILES: Record<
  InjectionBaselineDatasetId,
  { file: string; sha256: string; cases: number; injection: number; benign: number; commit: string | null }
> = {
  notinject: {
    file: "notinject.json",
    sha256: "c347962d40ca3e79b2ed3e46b448217dca2901db6ff9458bbab3a18dadd06fd7",
    cases: 339,
    injection: 0,
    benign: 339,
    commit: "1b5751e88bf7475acbedfc8eda795ce060307c84",
  },
  injecagent: {
    file: "injecagent.json",
    sha256: "eba995e4fe62498bea6f9663d8e7b88fdf9432941361d323499d499c1fb79269",
    cases: 300,
    injection: 300,
    benign: 0,
    commit: "f19c9f2c79a41046eb13c03c51a24c567a8ffa07",
  },
  agentdojo: {
    file: "agentdojo.json",
    sha256: "0dca21143ccacdd16aabcbc390cf8e1dac4a71369872418285ca68fd4a000f61",
    cases: 232,
    injection: 135,
    benign: 97,
    commit: "089ed468cf3ed0322acc66b0211f26d9d90dbf60",
  },
  jailbreakbench: {
    file: "jailbreakbench.json",
    sha256: "7667e027695aca79fa703b2a86c0f9faaf5f0b01273a2a8238e0404625c1c3bd",
    cases: 250,
    injection: 150,
    benign: 100,
    commit: "909e68c01d94222b8ad2e397a017e2e12e2adb73",
  },
  /** our own content (no upstream): see the module comment */
  "regulait-web-agent": {
    file: "regulait-web-agent.json",
    sha256: "07c96b4ae5615bb89d57b03a310d067c56091246af0ad1db54b8a9d86d6d860d",
    cases: 100,
    injection: 50,
    benign: 50,
    commit: null,
  },
};

export const injectionBaselineCaseSchema = z
  .object({
    id: z.string().min(1).max(200),
    label: z.enum(["injection", "benign"]),
    stratum: z.string().min(1).max(200),
    text: z.string().min(1).max(20_000),
  })
  .strict();
export type InjectionBaselineCase = z.infer<typeof injectionBaselineCaseSchema>;

export const injectionBaselineSnapshotSchema = z
  .object({
    source: z.enum(INJECTION_BASELINE_DATASET_IDS),
    cases: z.array(injectionBaselineCaseSchema).min(1).max(5_000),
  })
  .strict();

export function snapshotSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Parse a snapshot's bytes, refusing any whose sha256 is not the pin (checked
 * BEFORE parsing) or whose counts drifted.
 */
export function parseInjectionBaselineSnapshot(id: InjectionBaselineDatasetId, bytes: Uint8Array): InjectionBaselineCase[] {
  const pin = INJECTION_BASELINE_FILES[id];
  const got = snapshotSha256(bytes);
  if (got !== pin.sha256) throw new Error(`injection baseline ${id}: sha256 ${got} is not the pinned ${pin.sha256}`);
  const doc = injectionBaselineSnapshotSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  if (doc.source !== id) throw new Error(`injection baseline ${id}: the file says it is ${doc.source}`);
  const injection = doc.cases.filter((c) => c.label === "injection").length;
  if (doc.cases.length !== pin.cases || injection !== pin.injection) {
    throw new Error(`injection baseline ${id}: ${doc.cases.length} cases (${injection} injection), pinned ${pin.cases} (${pin.injection})`);
  }
  if (new Set(doc.cases.map((c) => c.id)).size !== doc.cases.length) throw new Error(`injection baseline ${id}: duplicate case ids`);
  return doc.cases;
}

export interface ConfusionMatrix {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

/** null where the dataset has no case of the class the metric divides by */
export interface DetectorMetrics extends ConfusionMatrix {
  precision: number | null;
  recall: number | null;
  fpr: number | null;
}

const ratio = (num: number, den: number): number | null => (den === 0 ? null : Math.round((num / den) * 10_000) / 10_000);

export function metricsFromMatrix(m: ConfusionMatrix): DetectorMetrics {
  return {
    ...m,
    precision: ratio(m.tp, m.tp + m.fp),
    recall: ratio(m.tp, m.tp + m.fn),
    fpr: ratio(m.fp, m.fp + m.tn),
  };
}

/** score a detector verdict (true = flagged as injection) over the cases */
export function scoreInjectionCases(
  cases: readonly InjectionBaselineCase[],
  flagged: (c: InjectionBaselineCase) => boolean,
): { metrics: DetectorMetrics; misses: string[]; falseAlarms: string[] } {
  const m: ConfusionMatrix = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const misses: string[] = [];
  const falseAlarms: string[] = [];
  for (const c of cases) {
    const hit = flagged(c);
    if (c.label === "injection") {
      if (hit) m.tp++;
      else {
        m.fn++;
        misses.push(c.id);
      }
    } else if (hit) {
      m.fp++;
      falseAlarms.push(c.id);
    } else m.tn++;
  }
  return { metrics: metricsFromMatrix(m), misses, falseAlarms };
}

export function poolMetrics(all: readonly ConfusionMatrix[]): DetectorMetrics {
  return metricsFromMatrix(
    all.reduce((a, m) => ({ tp: a.tp + m.tp, fp: a.fp + m.fp, fn: a.fn + m.fn, tn: a.tn + m.tn }), { tp: 0, fp: 0, fn: 0, tn: 0 }),
  );
}

export const INJECTION_BASELINE_DETECTORS = ["heuristic_prompt_injection", "trained_prompt_injection"] as const;
export type InjectionBaselineDetector = (typeof INJECTION_BASELINE_DETECTORS)[number];

const rate = z.number().min(0).max(1).nullable();
const metricsSchema = z
  .object({
    tp: z.number().int().min(0),
    fp: z.number().int().min(0),
    fn: z.number().int().min(0),
    tn: z.number().int().min(0),
    precision: rate,
    recall: rate,
    fpr: rate,
  })
  .strict();

const detectorBaselineSchema = z
  .object({
    /** gated: CI re-measures and fails on a regression; otherwise recorded from an offline run */
    gated: z.boolean(),
    measuredWith: z.string().min(1).max(500),
    /** the threshold the verdict used, for a scored detector (null for the heuristic, which has none) */
    threshold: z.number().min(0).max(1).nullable(),
    datasets: z.record(z.enum(INJECTION_BASELINE_DATASET_IDS), metricsSchema),
    pooled: metricsSchema,
  })
  .strict();

export const injectionBaselineExpectedSchema = z
  .object({
    schema: z.literal("regulait.injection-eval-baselines.v1"),
    /** absolute tolerance per metric: a drop in precision or recall, or a rise in FPR, beyond it fails */
    tolerance: z.object({ precision: z.number().min(0).max(1), recall: z.number().min(0).max(1), fpr: z.number().min(0).max(1) }).strict(),
    detectors: z.record(z.enum(INJECTION_BASELINE_DETECTORS), detectorBaselineSchema),
  })
  .strict();
export type InjectionBaselineExpected = z.infer<typeof injectionBaselineExpectedSchema>;

export interface MetricDelta {
  scope: InjectionBaselineDatasetId | "pooled";
  metric: "precision" | "recall" | "fpr";
  pinned: number | null;
  measured: number | null;
  delta: number | null;
  /** true when the change is worse than the tolerance allows */
  regression: boolean;
}

/**
 * Compare measured metrics with the pinned ones. A metric that was defined and
 * is now null (or the reverse) is a regression: the dataset changed shape.
 */
export function compareInjectionBaseline(
  pinned: { datasets: Partial<Record<InjectionBaselineDatasetId, DetectorMetrics>>; pooled: DetectorMetrics },
  measured: { datasets: Partial<Record<InjectionBaselineDatasetId, DetectorMetrics>>; pooled: DetectorMetrics },
  tolerance: InjectionBaselineExpected["tolerance"],
): MetricDelta[] {
  const out: MetricDelta[] = [];
  const scopes: Array<InjectionBaselineDatasetId | "pooled"> = [...INJECTION_BASELINE_DATASET_IDS, "pooled"];
  for (const scope of scopes) {
    const p = scope === "pooled" ? pinned.pooled : pinned.datasets[scope];
    const m = scope === "pooled" ? measured.pooled : measured.datasets[scope];
    for (const metric of ["precision", "recall", "fpr"] as const) {
      const pv = p ? p[metric] : null;
      const mv = m ? m[metric] : null;
      if (pv === null && mv === null) continue;
      if (pv === null || mv === null) {
        out.push({ scope, metric, pinned: pv, measured: mv, delta: null, regression: true });
        continue;
      }
      const delta = Math.round((mv - pv) * 10_000) / 10_000;
      const worse = metric === "fpr" ? delta : -delta;
      out.push({ scope, metric, pinned: pv, measured: mv, delta, regression: worse > tolerance[metric] + 1e-9 });
    }
  }
  return out;
}

const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);

/** the delta table a detector or threshold change prints */
export function formatInjectionBaselineDeltas(detector: string, deltas: readonly MetricDelta[]): string {
  const lines = [`${detector}: scope metric pinned -> measured (delta)`];
  for (const d of deltas) {
    const delta = d.delta === null ? "shape changed" : `${d.delta >= 0 ? "+" : ""}${(d.delta * 100).toFixed(1)} pt`;
    lines.push(`  ${d.scope.padEnd(18)} ${d.metric.padEnd(9)} ${pct(d.pinned).padStart(6)} -> ${pct(d.measured).padStart(6)} (${delta})${d.regression ? "  REGRESSION" : ""}`);
  }
  return lines.join("\n");
}
