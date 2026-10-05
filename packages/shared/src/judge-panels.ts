/**
 * ADR-0173 batch 2c / ADR-0177 clean-room item 8 — JUDGE PANELS, REPEATED RUNS
 * AND JUDGE CALIBRATION, the pure half.
 *
 * ADR-0044 left one limit open in writing: the judge is itself an agent that
 * can regress, and nothing measured it. This module is the measurement:
 *
 *  - a PANEL of 2–5 weighted judges, whose verdicts combine into one score by
 *    weight while every verdict is kept (the gateway stores each one);
 *  - REPEATED judging (at most 5 repetitions) with a BOOTSTRAP confidence
 *    interval on the mean score, from a SEEDED random source so the same run
 *    reproduces the same interval;
 *  - CALIBRATION: agreement between a judge's pass/fail and human annotation
 *    labels, as Cohen's kappa, reported only with at least
 *    KAPPA_MIN_PAIRED_LABELS completed pairs and otherwise "insufficient".
 *
 * OBSERVE-ONLY. Nothing here, and nothing that calls it, changes a gate: a
 * panel's combined score is the case score exactly as a single judge's was,
 * and calibration is a report.
 *
 * Statistics come from `simple-statistics` (ISC, pinned): `mean`, `quantile`
 * and `sampleWithReplacement`. The seeded random source is SHA-256 in counter
 * mode from `node:crypto` (the standard library; no RNG package is needed).
 * Cohen's kappa is not in any maintained package, so it is the ten lines below,
 * tested against a published worked example.
 */
import crypto from "node:crypto";
import { z } from "zod";
import { mean, quantile, sampleWithReplacement } from "simple-statistics";

export const JUDGE_PANEL_LIMITS = {
  minJudges: 2,
  maxJudges: 5,
  /** judges × cases × repetitions for one run */
  maxJudgements: 500,
  maxRepetitions: 5,
} as const;

/** completed paired labels needed before kappa is reported at all */
export const KAPPA_MIN_PAIRED_LABELS = 20;

export const BOOTSTRAP_DEFAULTS = { resamples: 1000, level: 0.95 } as const;

export const judgePanelMemberSchema = z
  .object({
    agentId: z.string().uuid(),
    weight: z.number().positive().max(100),
  })
  .strict();

/** 2–5 judges, positive weights, no judge twice */
export const judgePanelSchema = z
  .array(judgePanelMemberSchema)
  .min(JUDGE_PANEL_LIMITS.minJudges)
  .max(JUDGE_PANEL_LIMITS.maxJudges)
  .superRefine((panel, ctx) => {
    const ids = panel.map((m) => m.agentId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a judge may sit on a panel only once" });
    }
  });
export type JudgePanel = z.infer<typeof judgePanelSchema>;

/** the judgement budget, checked before any row is written */
export function judgementBudgetProblem(judges: number, cases: number, repetitions: number): string | null {
  if (repetitions < 1 || repetitions > JUDGE_PANEL_LIMITS.maxRepetitions) {
    return `repetitions must be between 1 and ${JUDGE_PANEL_LIMITS.maxRepetitions}`;
  }
  const n = judges * cases * repetitions;
  if (n > JUDGE_PANEL_LIMITS.maxJudgements) {
    return (
      `${judges} judge(s) × ${cases} case(s) × ${repetitions} repetition(s) = ${n} judgements, above the ` +
      `${JUDGE_PANEL_LIMITS.maxJudgements} per run limit. Use fewer judges, repetitions or cases.`
    );
  }
  return null;
}

export interface PanelVerdictInput {
  judge: string;
  weight: number;
  /** null when the judge call failed */
  score: number | null;
}

export interface PanelCombination {
  /** weighted mean of the verdicts that produced a score; null when none did */
  score: number | null;
  /** judges whose verdict counted */
  counted: number;
  /** judges whose call failed */
  failed: number;
  /** max − min of the counted scores: how far the panel disagreed */
  spread: number | null;
}

const round4 = (n: number) => Number(n.toFixed(4));

/**
 * Combine a panel's verdicts by weight. A failed judge is NOT a zero: its
 * weight leaves the denominator and the failure is counted, so a missing
 * instrument is never recorded as a bad measurement (ADR-0072).
 */
export function combinePanelVerdicts(verdicts: readonly PanelVerdictInput[]): PanelCombination {
  const ok = verdicts.filter((v) => v.score !== null && Number.isFinite(v.score));
  const failed = verdicts.length - ok.length;
  if (ok.length === 0) return { score: null, counted: 0, failed, spread: null };
  const w = ok.reduce((a, v) => a + v.weight, 0);
  const s = ok.reduce((a, v) => a + v.weight * (v.score as number), 0) / w;
  const scores = ok.map((v) => v.score as number);
  return {
    score: round4(Math.min(1, Math.max(0, s))),
    counted: ok.length,
    failed,
    spread: round4(Math.max(...scores) - Math.min(...scores)),
  };
}

// ---------------------------------------------------------------------------
// The seeded random source and the bootstrap
// ---------------------------------------------------------------------------

/**
 * A deterministic source of uniform numbers in [0, 1): SHA-256 over
 * `seed:counter`, 48 bits per draw. Same seed, same sequence, on every
 * platform. Not for secrets; for reproducible resampling.
 */
export function seededRandom(seed: string): () => number {
  let counter = 0;
  return () => {
    const h = crypto.createHash("sha256").update(`${seed}:${counter++}`).digest();
    return h.readUIntBE(0, 6) / 2 ** 48;
  };
}

export interface BootstrapInterval {
  method: "percentile-bootstrap";
  estimate: number;
  low: number;
  high: number;
  level: number;
  resamples: number;
  n: number;
  seed: string;
}

/**
 * Percentile bootstrap interval of `statistic` over `values`, resampled with
 * replacement from the seeded source. Null with fewer than two values: an
 * interval on one observation would be a number with no meaning.
 */
export function bootstrapInterval<T>(
  values: readonly T[],
  statistic: (sample: T[]) => number,
  opts: { seed: string; resamples?: number; level?: number },
): BootstrapInterval | null {
  if (values.length < 2) return null;
  const resamples = opts.resamples ?? BOOTSTRAP_DEFAULTS.resamples;
  const level = opts.level ?? BOOTSTRAP_DEFAULTS.level;
  const rand = seededRandom(opts.seed);
  const stats: number[] = [];
  for (let i = 0; i < resamples; i++) {
    const s = statistic(sampleWithReplacement([...values], values.length, rand));
    if (Number.isFinite(s)) stats.push(s);
  }
  if (stats.length === 0) return null;
  const alpha = (1 - level) / 2;
  return {
    method: "percentile-bootstrap",
    estimate: round4(statistic([...values])),
    low: round4(quantile(stats, alpha)),
    high: round4(quantile(stats, 1 - alpha)),
    level,
    resamples,
    n: values.length,
    seed: opts.seed,
  };
}

/** the bootstrap interval on a run's mean case score */
export function meanScoreInterval(scores: readonly number[], seed: string): BootstrapInterval | null {
  return bootstrapInterval(scores, (s) => mean(s), { seed });
}

// ---------------------------------------------------------------------------
// Cohen's kappa
// ---------------------------------------------------------------------------

/**
 * Cohen's kappa for two raters over the same items: κ = (pₒ − pₑ) / (1 − pₑ),
 * pₒ the observed agreement and pₑ the agreement expected by chance from each
 * rater's marginal frequencies (J. Cohen, "A coefficient of agreement for
 * nominal scales", Educational and Psychological Measurement 20(1), 1960).
 * Tested against the worked examples in the Wikipedia article "Cohen's kappa"
 * (Example: 50 applications, κ = 0.4; and the two 100-item tables with the same
 * 60% agreement giving κ = 0.1304 and κ = 0.2593). Null when chance agreement
 * is total (pₑ = 1): kappa is undefined there, not 0 and not 1.
 */
export function cohensKappa(pairs: ReadonlyArray<readonly [string, string]>): number | null {
  const n = pairs.length;
  if (n === 0) return null;
  const a = new Map<string, number>();
  const b = new Map<string, number>();
  let agree = 0;
  for (const [x, y] of pairs) {
    if (x === y) agree++;
    a.set(x, (a.get(x) ?? 0) + 1);
    b.set(y, (b.get(y) ?? 0) + 1);
  }
  const po = agree / n;
  let pe = 0;
  for (const [k, ca] of a) pe += (ca / n) * ((b.get(k) ?? 0) / n);
  return pe === 1 ? null : (po - pe) / (1 - pe);
}

export interface KappaReport {
  status: "reported" | "insufficient";
  /** completed (judge, human) pairs */
  pairs: number;
  required: number;
  kappa: number | null;
  agreement: number | null;
  interval: BootstrapInterval | null;
  note: string;
}

/**
 * Kappa for one judge against human labels, or "insufficient" below the
 * minimum. The interval is a seeded bootstrap over the pairs.
 */
export function kappaReport(pairs: ReadonlyArray<readonly [string, string]>, seed: string): KappaReport {
  if (pairs.length < KAPPA_MIN_PAIRED_LABELS) {
    return {
      status: "insufficient",
      pairs: pairs.length,
      required: KAPPA_MIN_PAIRED_LABELS,
      kappa: null,
      agreement: null,
      interval: null,
      note:
        `${pairs.length} completed paired label(s); kappa is reported from ${KAPPA_MIN_PAIRED_LABELS}. ` +
        "Below that, agreement is too noisy to tell a calibrated judge from a lucky one.",
    };
  }
  const k = cohensKappa(pairs);
  const agreement = pairs.filter(([x, y]) => x === y).length / pairs.length;
  return {
    status: "reported",
    pairs: pairs.length,
    required: KAPPA_MIN_PAIRED_LABELS,
    kappa: k === null ? null : round4(k),
    agreement: round4(agreement),
    interval: bootstrapInterval(pairs, (s) => cohensKappa(s) ?? Number.NaN, { seed }),
    note:
      k === null
        ? "Every label on both sides is the same class, so chance agreement is total and kappa is undefined."
        : "Cohen's kappa between the judge's pass/fail and the human label. Observe-only: it never changes a gate.",
  };
}

/** turn a human annotation into pass/fail, or null when it says neither */
export function humanVerdict(
  label: { label: string | null; value: number | null },
  opts: { positiveLabels: readonly string[]; negativeLabels: readonly string[]; valueThreshold: number },
): "pass" | "fail" | null {
  if (label.label !== null) {
    const l = label.label.trim().toLowerCase();
    if (opts.positiveLabels.some((p) => p.toLowerCase() === l)) return "pass";
    if (opts.negativeLabels.some((p) => p.toLowerCase() === l)) return "fail";
  }
  if (label.value !== null && Number.isFinite(label.value)) return label.value >= opts.valueThreshold ? "pass" : "fail";
  return null;
}

export const judgeCalibrationSchema = z
  .object({
    positiveLabels: z.array(z.string().min(1).max(64)).max(20).default(["pass"]),
    negativeLabels: z.array(z.string().min(1).max(64)).max(20).default(["fail"]),
    valueThreshold: z.number().min(0).max(1).default(0.5),
  })
  .strict();
export type JudgeCalibrationInput = z.infer<typeof judgeCalibrationSchema>;

// ---------------------------------------------------------------------------
// Configuration hash (automatic re-run) and run comparison
// ---------------------------------------------------------------------------

/** the configuration a run measured; a change in any field is a config change */
export interface MeasuredConfig {
  model: string | null;
  tier: number | null;
  systemPromptHash: string | null;
  customProviderId: string | null;
}

export function measuredConfigHash(c: MeasuredConfig): string {
  const canonical = JSON.stringify([c.model ?? null, c.tier ?? null, c.systemPromptHash ?? null, c.customProviderId ?? null]);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export interface ComparableRun {
  id: string;
  datasetId: string;
  datasetVersion: number;
  scoringSemantics: number;
  status: string;
}

/** why two runs cannot be compared, or null when they can */
export function runComparisonRefusal(a: ComparableRun, b: ComparableRun): { error: string; detail: string } | null {
  if (a.id === b.id) return { error: "same_run", detail: "a run compared with itself has no differences to show" };
  if (a.status !== "completed" || b.status !== "completed") {
    return { error: "run_not_completed", detail: "only completed runs carry a full set of scores to compare" };
  }
  if (a.datasetId !== b.datasetId || a.datasetVersion !== b.datasetVersion) {
    return {
      error: "dataset_version_mismatch",
      detail:
        "the two runs scored different dataset versions, so their cases are not the same cases and a per-case " +
        "delta would compare different questions",
    };
  }
  if (a.scoringSemantics !== b.scoringSemantics) {
    return {
      error: "scoring_semantics_mismatch",
      detail: `run ${a.id} was scored under semantics v${a.scoringSemantics} and run ${b.id} under v${b.scoringSemantics} (ADR-0072); the numbers mean different things`,
    };
  }
  return null;
}
