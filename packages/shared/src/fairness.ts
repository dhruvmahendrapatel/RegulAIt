/**
 * ADR-0222 (P13(a)) — FAIRNESS TESTING, the pure half.
 *
 * ADR-0045 recorded bias and fairness as a declared slot on a model card. This
 * module MEASURES group fairness on a labelled evaluation dataset an admin
 * uploads: one true label, one model prediction and one or more protected
 * attributes per row. It computes the standard group metrics, compares each
 * with an admin threshold and returns one outcome.
 *
 * WHAT IT MEASURES, SAID PLAINLY. The predictions are the ones in the file. The
 * gateway does not run the model against the dataset; the result is only as
 * good as the predictions the admin supplied, and the copy says so.
 *
 * THE DEFINITIONS are those of the open-source fairlearn library (MIT), so a
 * reader can reproduce every number: `fairness.test.ts` pins golden values that
 * fairlearn 0.13.0 computed on the same rows. ADR-0222 records why the formulas
 * are written here rather than run through fairlearn (no maintained,
 * permissively licensed JavaScript library exists, and these are four
 * closed-form ratios over a confusion matrix).
 *
 *   selection rate     P(prediction = favourable | group)
 *   TPR                P(prediction = favourable | label = favourable, group)
 *   FPR                P(prediction = favourable | label ≠ favourable, group)
 *   demographic parity difference   max(selection rate) − min(selection rate)
 *   disparate impact ratio          min(selection rate) ÷ max(selection rate)
 *                                   (fairlearn's demographic_parity_ratio)
 *   equal opportunity difference    max(TPR) − min(TPR)
 *   equalised odds difference       the larger of the TPR and FPR differences
 *
 * Pure: no db, no clock, no I/O.
 */
import { z } from "zod";

export const FAIRNESS_METRICS_VERSION = "fairness-metrics/1";

export const FAIRNESS_METRICS = [
  "demographic_parity_difference",
  "disparate_impact_ratio",
  "equal_opportunity_difference",
  "equalized_odds_difference",
] as const;
export type FairnessMetric = (typeof FAIRNESS_METRICS)[number];

/** `max`: the value may not exceed the limit; `min`: the value may not fall below it */
export const FAIRNESS_METRIC_DIRECTION: Readonly<Record<FairnessMetric, "max" | "min">> = {
  demographic_parity_difference: "max",
  disparate_impact_ratio: "min",
  equal_opportunity_difference: "max",
  equalized_odds_difference: "max",
};

/** customer copy for each metric (British spelling, no internal ids) */
export const FAIRNESS_METRIC_COPY: Readonly<Record<FairnessMetric, { label: string; explain: string }>> = {
  demographic_parity_difference: {
    label: "Demographic parity difference",
    explain: "The gap between the highest and lowest rate of favourable predictions across groups. 0 means every group is selected at the same rate.",
  },
  disparate_impact_ratio: {
    label: "Disparate impact ratio",
    explain: "The lowest group's rate of favourable predictions divided by the highest group's. 1 means equal rates; the four-fifths rule asks for at least 0.8.",
  },
  equal_opportunity_difference: {
    label: "Equal opportunity difference",
    explain: "The gap in true positive rate across groups: of the people whose true outcome was favourable, how often each group was predicted favourable.",
  },
  equalized_odds_difference: {
    label: "Equalised odds difference",
    explain: "The larger of the gaps in true positive rate and false positive rate across groups.",
  },
};

export const FAIRNESS_THRESHOLD_ACTIONS = ["fail", "flag"] as const;
export type FairnessThresholdAction = (typeof FAIRNESS_THRESHOLD_ACTIONS)[number];

export interface FairnessThreshold {
  metric: FairnessMetric;
  limit: number;
  /** `fail` (strict) blocks the model card's sign-off and dispatch while blocking is on; `flag` only records */
  action: FairnessThresholdAction;
}

/** THE STRICT DEFAULTS: every metric checked, every breach a failure. 0.8 is the four-fifths rule. */
export const FAIRNESS_DEFAULT_THRESHOLDS: readonly FairnessThreshold[] = Object.freeze([
  { metric: "demographic_parity_difference", limit: 0.1, action: "fail" },
  { metric: "disparate_impact_ratio", limit: 0.8, action: "fail" },
  { metric: "equal_opportunity_difference", limit: 0.1, action: "fail" },
  { metric: "equalized_odds_difference", limit: 0.1, action: "fail" },
] as FairnessThreshold[]);

/** the bounds (zod, the gateway's parser and the DB CHECKs of migration 0243 hold the same numbers) */
export const FAIRNESS_LIMITS = {
  /** the largest CSV an upload may carry, in bytes */
  maxCsvBytes: 5 * 1024 * 1024,
  /** the most data rows one dataset may hold */
  maxRows: 100_000,
  /** protected attributes per dataset */
  maxAttributes: 5,
  /** distinct groups per protected attribute */
  maxGroupsPerAttribute: 50,
  /** the longest cell the parser accepts */
  maxCellChars: 200,
  /** a group with fewer rows than this is reported but left out of the metrics */
  minGroupSize: { min: 1, max: 10_000, default: 30 },
  /** how long an uploaded dataset is kept (encrypted), in days */
  retentionDays: { min: 1, max: 365, default: 30 },
} as const;

/** the org settings this feature adds, at their strict values (the column defaults of migration 0243) */
export const FAIRNESS_STRICT_SETTINGS = Object.freeze({
  fairnessTestingEnabled: false as boolean,
  fairnessBlockOnFail: true as boolean,
  fairnessDatasetRetentionDays: FAIRNESS_LIMITS.retentionDays.default as number,
});

const columnName = z.string().trim().min(1).max(FAIRNESS_LIMITS.maxCellChars);

export const fairnessThresholdSchema = z.object({
  metric: z.enum(FAIRNESS_METRICS),
  limit: z.number().min(0).max(1),
  action: z.enum(FAIRNESS_THRESHOLD_ACTIONS),
});

export const createFairnessDatasetSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).nullish(),
    csv: z.string().min(1).max(FAIRNESS_LIMITS.maxCsvBytes),
    labelColumn: columnName,
    predictionColumn: columnName,
    /** the label (and prediction) value that means the favourable outcome, e.g. "1" or "approved" */
    favourableLabel: z.string().trim().min(1).max(FAIRNESS_LIMITS.maxCellChars),
    protectedAttributes: z.array(columnName).min(1).max(FAIRNESS_LIMITS.maxAttributes),
  })
  .strict()
  .refine(
    (b) => new Set([b.labelColumn, b.predictionColumn, ...b.protectedAttributes]).size === 2 + b.protectedAttributes.length,
    { message: "the label, prediction and protected attribute columns must be different columns" },
  );
export type CreateFairnessDataset = z.infer<typeof createFairnessDatasetSchema>;

export const runFairnessTestSchema = z
  .object({
    datasetId: z.string().uuid(),
    cardId: z.string().uuid(),
    /** omitted = the strict defaults */
    thresholds: z.array(fairnessThresholdSchema).min(1).max(FAIRNESS_METRICS.length).optional(),
    minGroupSize: z
      .number()
      .int()
      .min(FAIRNESS_LIMITS.minGroupSize.min)
      .max(FAIRNESS_LIMITS.minGroupSize.max)
      .optional(),
  })
  .strict()
  .refine((b) => !b.thresholds || new Set(b.thresholds.map((t) => t.metric)).size === b.thresholds.length, {
    message: "each metric may have one threshold",
  });
export type RunFairnessTest = z.infer<typeof runFairnessTestSchema>;

export const updateFairnessSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    blockOnFail: z.boolean().optional(),
    datasetRetentionDays: z
      .number()
      .int()
      .min(FAIRNESS_LIMITS.retentionDays.min)
      .max(FAIRNESS_LIMITS.retentionDays.max)
      .optional(),
  })
  .strict();
export type UpdateFairnessSettings = z.infer<typeof updateFairnessSettingsSchema>;

/**
 * The settings in a write that are looser than their strict default AND than
 * the stored value (ADR-0186 decisions 16 and 26), with their new values: the
 * `settings_relax` step-up facts. Turning the feature ON is a relaxation too:
 * it starts storing sensitive attributes. Turning blocking off, or a longer
 * retention, is looser.
 */
export function fairnessSettingsRelaxed(
  next: UpdateFairnessSettings,
  stored: { fairnessTestingEnabled: boolean; fairnessBlockOnFail: boolean; fairnessDatasetRetentionDays: number },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (next.enabled === true && !stored.fairnessTestingEnabled) out.fairnessTestingEnabled = true;
  if (next.blockOnFail === false && stored.fairnessBlockOnFail) out.fairnessBlockOnFail = false;
  const days = next.datasetRetentionDays;
  // longer than the default, or longer than a value an admin tightened below it (decision 26)
  if (
    days !== undefined &&
    days !== stored.fairnessDatasetRetentionDays &&
    (days > FAIRNESS_STRICT_SETTINGS.fairnessDatasetRetentionDays || days > stored.fairnessDatasetRetentionDays)
  ) {
    out.fairnessDatasetRetentionDays = days;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The computation
// ---------------------------------------------------------------------------

/** a dataset after parsing: one entry per row in each array (0/1 for the outcomes) */
export interface FairnessRows {
  labels: readonly number[];
  predictions: readonly number[];
  /** attribute column → each row's group */
  attributes: Readonly<Record<string, readonly string[]>>;
}

export interface FairnessGroupStats {
  group: string;
  n: number;
  /** rows whose true label is favourable */
  labelPositives: number;
  /** rows predicted favourable */
  predictedPositives: number;
  selectionRate: number;
  /** null when the group has no favourable labels */
  truePositiveRate: number | null;
  /** null when the group has no unfavourable labels */
  falsePositiveRate: number | null;
  /** false when the group is smaller than the minimum group size */
  included: boolean;
}

export interface FairnessMetricValue {
  value: number | null;
  /** why the value could not be computed */
  reason?: string;
}

export interface FairnessAttributeResult {
  attribute: string;
  groups: FairnessGroupStats[];
  metrics: Record<FairnessMetric, FairnessMetricValue>;
}

export type FairnessCheckStatus = "pass" | "breach" | "not_computable";

export interface FairnessEvaluation {
  attribute: string;
  metric: FairnessMetric;
  value: number | null;
  limit: number;
  direction: "max" | "min";
  action: FairnessThresholdAction;
  status: FairnessCheckStatus;
}

export const FAIRNESS_OUTCOMES = ["pass", "flag", "fail", "inconclusive"] as const;
export type FairnessOutcome = (typeof FAIRNESS_OUTCOMES)[number];

export interface FairnessResult {
  metricsVersion: string;
  rowCount: number;
  minGroupSize: number;
  attributes: FairnessAttributeResult[];
  evaluations: FairnessEvaluation[];
  outcome: FairnessOutcome;
}

/** floating-point noise allowance when comparing a value with its limit (0.4 / 0.5 is 0.8000000000000002) */
const EPSILON = 1e-12;

function spread(values: readonly (number | null)[], reasonIfMissing: string): FairnessMetricValue {
  if (values.length < 2) return { value: null, reason: "fewer than two groups meet the minimum group size" };
  if (values.some((v) => v === null)) return { value: null, reason: reasonIfMissing };
  const nums = values as number[];
  return { value: Math.max(...nums) - Math.min(...nums) };
}

function attributeResult(attribute: string, rows: FairnessRows, groupsOf: readonly string[], minGroupSize: number): FairnessAttributeResult {
  const byGroup = new Map<string, { n: number; lp: number; pp: number; tp: number; fp: number }>();
  for (let i = 0; i < groupsOf.length; i++) {
    const g = groupsOf[i]!;
    const s = byGroup.get(g) ?? { n: 0, lp: 0, pp: 0, tp: 0, fp: 0 };
    const y = rows.labels[i] === 1;
    const p = rows.predictions[i] === 1;
    s.n += 1;
    if (y) s.lp += 1;
    if (p) s.pp += 1;
    if (y && p) s.tp += 1;
    if (!y && p) s.fp += 1;
    byGroup.set(g, s);
  }
  const groups: FairnessGroupStats[] = [...byGroup.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([group, s]) => ({
      group,
      n: s.n,
      labelPositives: s.lp,
      predictedPositives: s.pp,
      selectionRate: s.pp / s.n,
      truePositiveRate: s.lp > 0 ? s.tp / s.lp : null,
      falsePositiveRate: s.n - s.lp > 0 ? s.fp / (s.n - s.lp) : null,
      included: s.n >= minGroupSize,
    }));
  const used = groups.filter((g) => g.included);
  const sel = used.map((g) => g.selectionRate);
  const tpr = used.map((g) => g.truePositiveRate);
  const fpr = used.map((g) => g.falsePositiveRate);

  const dpd = spread(sel, "");
  let dir: FairnessMetricValue;
  if (used.length < 2) dir = { value: null, reason: "fewer than two groups meet the minimum group size" };
  else if (Math.max(...sel) === 0) dir = { value: null, reason: "no group received a favourable prediction" };
  else dir = { value: Math.min(...sel) / Math.max(...sel) };
  const eop = spread(tpr, "a group has no rows with a favourable true label");
  const tprGap = eop;
  const fprGap = spread(fpr, "a group has no rows with an unfavourable true label");
  const eod: FairnessMetricValue =
    tprGap.value === null ? tprGap : fprGap.value === null ? fprGap : { value: Math.max(tprGap.value, fprGap.value) };

  return {
    attribute,
    groups,
    metrics: {
      demographic_parity_difference: dpd,
      disparate_impact_ratio: dir,
      equal_opportunity_difference: eop,
      equalized_odds_difference: eod,
    },
  };
}

/**
 * Compute every metric for every protected attribute and judge each against
 * its threshold. The outcome is, in order: `fail` when any `fail` threshold is
 * breached; `inconclusive` when a checked metric could not be computed (too few
 * groups of the minimum size, or a group with no favourable labels); `flag`
 * when only `flag` thresholds are breached; otherwise `pass`. Inconclusive is
 * never read as a pass.
 */
export function computeFairness(
  rows: FairnessRows,
  opts: { thresholds?: readonly FairnessThreshold[]; minGroupSize?: number } = {},
): FairnessResult {
  const thresholds = opts.thresholds ?? FAIRNESS_DEFAULT_THRESHOLDS;
  const minGroupSize = opts.minGroupSize ?? FAIRNESS_LIMITS.minGroupSize.default;
  const n = rows.labels.length;
  if (rows.predictions.length !== n) throw new Error("labels and predictions differ in length");
  const attributes = Object.keys(rows.attributes)
    .sort()
    .map((a) => {
      const col = rows.attributes[a]!;
      if (col.length !== n) throw new Error("an attribute column differs in length from the labels");
      return attributeResult(a, rows, col, minGroupSize);
    });
  const evaluations: FairnessEvaluation[] = [];
  for (const attr of attributes) {
    for (const t of thresholds) {
      const direction = FAIRNESS_METRIC_DIRECTION[t.metric];
      const value = attr.metrics[t.metric].value;
      const status: FairnessCheckStatus =
        value === null
          ? "not_computable"
          : direction === "max"
            ? value > t.limit + EPSILON
              ? "breach"
              : "pass"
            : value < t.limit - EPSILON
              ? "breach"
              : "pass";
      evaluations.push({ attribute: attr.attribute, metric: t.metric, value, limit: t.limit, direction, action: t.action, status });
    }
  }
  const outcome: FairnessOutcome = evaluations.some((e) => e.status === "breach" && e.action === "fail")
    ? "fail"
    : evaluations.some((e) => e.status === "not_computable")
      ? "inconclusive"
      : evaluations.some((e) => e.status === "breach")
        ? "flag"
        : "pass";
  return { metricsVersion: FAIRNESS_METRICS_VERSION, rowCount: n, minGroupSize, attributes, evaluations, outcome };
}

/** does a run with this outcome hold the model card while blocking is on? (an inconclusive run never reads as a pass) */
export function fairnessOutcomeBlocks(outcome: FairnessOutcome): boolean {
  return outcome === "fail" || outcome === "inconclusive";
}
