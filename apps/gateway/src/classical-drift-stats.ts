/**
 * ADR-0223 (P13b) — drift statistics for classical (non-LLM) models. Pure: no I/O, no clock, no database.
 *
 * WHAT GOES IN. Aggregates only, never rows: per feature either a histogram (bin edges and counts) or a category
 * table (labels and counts). A production summary must use the reference's bins for a numeric feature; categories
 * are aligned by label, and a label the reference never saw counts as zero there. `validateFeatureSet` bounds every
 * size and refuses a label or name the PII detector flags, so a category table cannot smuggle identities in.
 *
 * WHAT COMES OUT, per feature:
 *   psi  population stability index, Σ (p − q) · ln(p / q). This is the Jeffreys divergence, taken from
 *        `ml-distance` (MIT) rather than written here (ADR-0176).
 *   js   Jensen–Shannon divergence in nats (0 … ln 2), also from `ml-distance`.
 *   ks   numeric features only: the two-sample Kolmogorov–Smirnov distance D between the two binned CDFs, and its
 *        asymptotic p-value. Binned data can only show D at the bin edges, so D here is a LOWER BOUND on the raw
 *        statistic, and the result says so. No maintained, permissively licensed library computes KS on binned
 *        aggregates (the ones we found take raw samples, which we refuse by design), so the cumulative maximum and
 *        the Kolmogorov series are the narrow exception, recorded in the ADR.
 *
 * Zero bins are floored at EPSILON and renormalised before psi and js, the usual practice, so a bin empty on one
 * side gives a large finite value instead of infinity.
 */
import { createHash } from "node:crypto";
import { distance } from "ml-distance";
import { z } from "zod";
import { GUARDRAIL_DETECTOR_IDS, evaluateGuardrails, type GuardrailModes } from "@regulait/shared";

export const DRIFT_LIMITS = {
  features: 200,
  bins: 100,
  categories: 100,
  labelChars: 64,
  nameChars: 128,
  importanceFeatures: 500,
  /** a single count; well above any batch a summary describes, well below float precision trouble */
  maxCount: 1_000_000_000,
} as const;

const EPSILON = 1e-4;
/** names: identifiers a pipeline uses for a column, never free text */
const FEATURE_NAME = /^[A-Za-z0-9_.:\-[\] ]+$/;
/** labels: printable text without control characters */
const LABEL = /^[^\u0000-\u001f\u007f]+$/;

const count = z.number().int().min(0).max(DRIFT_LIMITS.maxCount);
const featureName = z.string().trim().min(1).max(DRIFT_LIMITS.nameChars).regex(FEATURE_NAME, "letters, digits, space and _ . : - [ ] only");

const numericFeature = z
  .object({
    name: featureName,
    kind: z.literal("numeric"),
    edges: z.array(z.number().finite()).min(2).max(DRIFT_LIMITS.bins + 1),
    counts: z.array(count).min(1).max(DRIFT_LIMITS.bins),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.counts.length !== f.edges.length - 1) ctx.addIssue({ code: "custom", message: "counts must have one entry per bin (edges − 1)" });
    for (let i = 1; i < f.edges.length; i++) {
      if (!(f.edges[i]! > f.edges[i - 1]!)) {
        ctx.addIssue({ code: "custom", message: "edges must be strictly ascending" });
        break;
      }
    }
  });

const categoricalFeature = z
  .object({
    name: featureName,
    kind: z.literal("categorical"),
    categories: z.array(z.string().trim().min(1).max(DRIFT_LIMITS.labelChars).regex(LABEL, "no control characters")).min(1).max(DRIFT_LIMITS.categories),
    counts: z.array(count).min(1).max(DRIFT_LIMITS.categories),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.counts.length !== f.categories.length) ctx.addIssue({ code: "custom", message: "counts must have one entry per category" });
    if (new Set(f.categories).size !== f.categories.length) ctx.addIssue({ code: "custom", message: "categories must be unique" });
  });

export const driftFeatureSchema = z.discriminatedUnion("kind", [numericFeature, categoricalFeature]);
export type DriftFeature = z.infer<typeof driftFeatureSchema>;

export const driftFeatureSetSchema = z
  .array(driftFeatureSchema)
  .min(1)
  .max(DRIFT_LIMITS.features)
  .superRefine((fs, ctx) => {
    if (new Set(fs.map((f) => f.name)).size !== fs.length) ctx.addIssue({ code: "custom", message: "feature names must be unique" });
    for (const f of fs) {
      if (f.counts.reduce((a, b) => a + b, 0) === 0) ctx.addIssue({ code: "custom", message: `feature '${f.name}' has no samples` });
    }
  });

export const explainabilitySchema = z
  .object({
    kind: z.enum(["global_importance", "shap_summary"]),
    method: z.string().trim().min(1).max(120),
    importances: z
      .array(z.object({ feature: featureName, value: z.number().finite() }).strict())
      .min(1)
      .max(DRIFT_LIMITS.importanceFeatures)
      .refine((xs) => new Set(xs.map((x) => x.feature)).size === xs.length, "feature names must be unique"),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();
export type ExplainabilityInput = z.infer<typeof explainabilitySchema>;

const PII_ONLY: GuardrailModes = Object.fromEntries(GUARDRAIL_DETECTOR_IDS.map((id) => [id, id === "pii" ? "block" : "off"])) as GuardrailModes;

/**
 * The PII detector over every name and label in a payload. Returns the detector categories that matched (never the
 * matched text), or an empty list. Aggregates are the contract; a label that looks like a person is refused.
 */
export function personalDataCategories(texts: readonly string[]): string[] {
  if (texts.length === 0) return [];
  const evaluation = evaluateGuardrails({ phase: "input", text: texts.join("\n"), modes: PII_ONLY });
  return [...new Set(evaluation.findings.flatMap((f) => f.hits.map((h) => h.category)))].sort();
}

export function featureTexts(features: readonly DriftFeature[]): string[] {
  return features.flatMap((f) => (f.kind === "categorical" ? [f.name, ...f.categories] : [f.name]));
}

/** SHA-256 of the canonical JSON of a validated payload: what the audit row and the stored row both carry */
export function payloadSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export interface DriftThresholds {
  psiWarn: number;
  psiAlert: number;
  ksAlert: number;
  jsAlert: number;
}

/** the strict defaults (the migration's column defaults); a larger value alerts later, so it is a relaxation */
export const STRICT_DRIFT_THRESHOLDS: Readonly<DriftThresholds> = Object.freeze({ psiWarn: 0.1, psiAlert: 0.25, ksAlert: 0.1, jsAlert: 0.05 });

export type DriftFeatureStatus = "within" | "warn" | "drift" | "insufficient";
export type DriftReportStatus = DriftFeatureStatus;

export interface DriftFeatureResult {
  feature: string;
  kind: "numeric" | "categorical";
  referenceSamples: number;
  samples: number;
  psi: number;
  js: number;
  /** numeric only; a lower bound on the raw-sample statistic */
  ksD: number | null;
  ksP: number | null;
  status: DriftFeatureStatus;
  /** which statistics crossed an alert threshold */
  breached: Array<"psi" | "js" | "ks">;
}

export class DriftShapeError extends Error {
  constructor(
    readonly code: "feature_missing" | "feature_unknown" | "kind_mismatch" | "bins_mismatch",
    readonly feature: string,
    message: string,
  ) {
    super(message);
  }
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

function smoothed(counts: readonly number[]): number[] {
  const n = sum(counts);
  const floored = counts.map((c) => Math.max(c / n, EPSILON));
  const total = sum(floored);
  return floored.map((p) => p / total);
}

/** Q_KS(λ) = 2 Σ (−1)^(j−1) e^(−2 j² λ²), the Kolmogorov survival function */
function kolmogorovQ(lambda: number): number {
  if (lambda < 1e-3) return 1;
  let total = 0;
  for (let j = 1; j <= 100; j++) {
    const term = 2 * (j % 2 === 1 ? 1 : -1) * Math.exp(-2 * j * j * lambda * lambda);
    total += term;
    if (Math.abs(term) < 1e-12) break;
  }
  return Math.min(1, Math.max(0, total));
}

/** two-sample KS on binned counts sharing the same edges: D over the bin edges, and its asymptotic p-value */
export function binnedKs(reference: readonly number[], production: readonly number[]): { d: number; p: number } {
  const n1 = sum(reference);
  const n2 = sum(production);
  let c1 = 0;
  let c2 = 0;
  let d = 0;
  for (let i = 0; i < reference.length; i++) {
    c1 += reference[i]! / n1;
    c2 += production[i]! / n2;
    d = Math.max(d, Math.abs(c1 - c2));
  }
  const ne = Math.sqrt((n1 * n2) / (n1 + n2));
  return { d, p: kolmogorovQ((ne + 0.12 + 0.11 / ne) * d) };
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;

/** align one production feature with its reference; throws DriftShapeError on a mismatch */
function aligned(ref: DriftFeature, prod: DriftFeature): { ref: number[]; prod: number[] } {
  if (ref.kind !== prod.kind) throw new DriftShapeError("kind_mismatch", ref.name, `feature '${ref.name}' is ${ref.kind} in the reference`);
  if (ref.kind === "numeric" && prod.kind === "numeric") {
    if (ref.edges.length !== prod.edges.length || ref.edges.some((e, i) => e !== prod.edges[i])) {
      throw new DriftShapeError("bins_mismatch", ref.name, `feature '${ref.name}' must use the reference's bin edges`);
    }
    return { ref: [...ref.counts], prod: [...prod.counts] };
  }
  if (ref.kind === "categorical" && prod.kind === "categorical") {
    const labels = [...ref.categories, ...prod.categories.filter((c) => !ref.categories.includes(c))];
    const of = (f: typeof ref, label: string) => {
      const i = f.categories.indexOf(label);
      return i < 0 ? 0 : f.counts[i]!;
    };
    return { ref: labels.map((l) => of(ref, l)), prod: labels.map((l) => of(prod, l)) };
  }
  throw new DriftShapeError("kind_mismatch", ref.name, `feature '${ref.name}' is ${ref.kind} in the reference`);
}

const RANK: Record<DriftReportStatus, number> = { within: 0, warn: 1, insufficient: 2, drift: 3 };

/**
 * Every reference feature against the production summary. The summary must name exactly the reference's features.
 * A feature with fewer than `minSamples` production samples is `insufficient` and never `drift`; the report's status
 * is the worst feature status (drift > insufficient > warn > within).
 */
export function computeDrift(
  reference: readonly DriftFeature[],
  production: readonly DriftFeature[],
  thresholds: DriftThresholds,
  minSamples: number,
): { status: DriftReportStatus; driftedFeatures: number; sampleCount: number; results: DriftFeatureResult[] } {
  const byName = new Map(production.map((f) => [f.name, f]));
  for (const p of production) {
    if (!reference.some((r) => r.name === p.name)) throw new DriftShapeError("feature_unknown", p.name, `feature '${p.name}' is not in the reference`);
  }
  const results: DriftFeatureResult[] = reference.map((ref) => {
    const prod = byName.get(ref.name);
    if (!prod) throw new DriftShapeError("feature_missing", ref.name, `feature '${ref.name}' is missing from the summary`);
    const a = aligned(ref, prod);
    const samples = sum(a.prod);
    const p = smoothed(a.prod);
    const q = smoothed(a.ref);
    const psi = distance.jeffreys(p, q);
    const js = distance.jensenShannon(q, p);
    const ks = ref.kind === "numeric" ? binnedKs(a.ref, a.prod) : null;
    const breached: DriftFeatureResult["breached"] = [];
    if (psi >= thresholds.psiAlert) breached.push("psi");
    if (js >= thresholds.jsAlert) breached.push("js");
    if (ks && ks.d >= thresholds.ksAlert) breached.push("ks");
    const status: DriftFeatureStatus =
      samples < minSamples ? "insufficient" : breached.length > 0 ? "drift" : psi >= thresholds.psiWarn ? "warn" : "within";
    return {
      feature: ref.name,
      kind: ref.kind,
      referenceSamples: sum(a.ref),
      samples,
      psi: round(psi),
      js: round(js),
      ksD: ks ? round(ks.d) : null,
      ksP: ks ? round(ks.p) : null,
      status,
      breached: status === "insufficient" ? [] : breached,
    };
  });
  const status = results.reduce<DriftReportStatus>((worst, r) => (RANK[r.status] > RANK[worst] ? r.status : worst), "within");
  return {
    status,
    driftedFeatures: results.filter((r) => r.status === "drift").length,
    sampleCount: Math.max(...results.map((r) => r.samples)),
    results,
  };
}

/** the total samples behind a reference (its largest feature total) */
export function referenceSamples(features: readonly DriftFeature[]): number {
  return Math.max(...features.map((f) => sum(f.counts)));
}
