/**
 * ADR-0049 — COST FORECASTING and SPEND-ANOMALY DETECTION, the PURE half.
 *
 * Division of labour, exactly where ADR-0044/0045/0047/0048 drew it:
 *
 *   THIS FILE            the vocabularies, the zod shapes, the FORECAST math,
 *                        the ANOMALY statistics, and the enforcement decision.
 *                        No db, no clock of its own (every function that needs
 *                        "now" takes it), no Fastify.
 *   `apps/gateway/src/spend-monitor.ts`
 *                        the `usage_events` queries, the entitlement scoping
 *                        (which it borrows WHOLESALE from ADR-0047's
 *                        `evaluateReportAccess` rather than inventing a second
 *                        one), the Approvals-Queue escalation, the admin API
 *                        and the audit rows.
 *
 * THREE THINGS THIS FILE REFUSES TO DO
 *
 *  1. IT NEVER INVENTS A NUMBER. `forecastSpend` returns
 *     `{ sufficient: false, projectedSpendUsd: null, insufficientReason }` when
 *     the history is too thin to project from. A forecast with no data behind
 *     it is worse than no forecast, because a budget conversation will be had
 *     about it. Every caller therefore has to handle the null; there is no
 *     "0" or "same as last period" fallback anywhere below.
 *
 *  2. IT NEVER PRESENTS A PROJECTION AS A CERTAINTY. Every payload carries the
 *     METHOD, its ASSUMPTIONS, its stated LIMITS, an explicit confidence
 *     interval, and the sample size the interval was computed from. The band
 *     is a real 95% interval on the MEAN DAILY RATE — not a decorative ±10%.
 *
 *  3. IT NEVER CLAIMS AN ANOMALY IT CANNOT EXPLAIN. `detectAnomaly` returns
 *     the method, the baseline, the threshold, the score and the observation,
 *     so a flag is always re-derivable by hand. Below a minimum sample size it
 *     returns `evaluated: false` ("baseline building") and makes NO claim at
 *     all — ADR-0049 §5's cold-start rail, enforced rather than described.
 *
 * WHERE THE MATH BREAKS — stated here, carried in every payload, and asserted
 * in the tests rather than left as prose:
 *
 *   - SPARSE DATA. Run-rate divides by elapsed fraction. Two days of data in a
 *     31-day month is a 15x extrapolation of two numbers; the confidence band
 *     widens accordingly (it is proportional to `remainingDays / sqrt(n)`), but
 *     a wide band is not a substitute for data. Hence the sample-size floor.
 *   - SEASONALITY. Neither method models day-of-week or holiday effects. A
 *     team that spends on weekdays only, measured from a Monday, over-projects;
 *     measured from a Saturday, under-projects. ADR-0049 defers seasonal/ML
 *     modelling behind this same interface ON PURPOSE — v1 is a number the
 *     customer can re-derive with a calculator, which is the trust trade.
 *   - COLD START. A project with no history has no forecast and no anomaly
 *     baseline. Only the static budget/framework caps protect it. Disclosed,
 *     never faked.
 *   - STEP CHANGES. A deliberate mid-period change (a newly granted expensive
 *     agent) is NOT inferable from the trend. `scheduledDeltaUsd` exists so a
 *     KNOWN decided change is added on top; an undeclared one will simply make
 *     the projection wrong, and the payload says so.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * The two v1 projectors. Both are deterministic, both are hand-computable, and
 * both are documented at their implementation below.
 *
 *  - `run_rate`   ADR-0049 §1's named default: mean daily spend so far,
 *                 extended over the remaining days of the period. Equivalent to
 *                 `spendToDate / fractionOfPeriodElapsed` when the elapsed
 *                 fraction is measured in the same days.
 *  - `ewma`       an exponentially-weighted mean daily rate (alpha-weighted,
 *                 most recent day heaviest), extended the same way. Reacts to a
 *                 recent step change faster than the flat mean; over-reacts to
 *                 a single spike, which is exactly why it is NOT the default.
 */
export const FORECAST_METHODS = ["run_rate", "ewma"] as const;
export type ForecastMethod = (typeof FORECAST_METHODS)[number];

/**
 * The v1 anomaly signals (ADR-0049 §2). Each is a SHAPE-OF-SPEND signal; none
 * inspects payload content — content-level DLP stays with ADR-0042's guardrail
 * engine and "what actually flowed" stays with ADR-0050's lineage graph.
 */
export const ANOMALY_SIGNALS = [
  /** §2.2 — per-window spend far above the scope's own rolling baseline */
  "spend_spike",
  /** §2.2 — per-window token volume far above baseline (the runaway loop) */
  "token_volume",
  /** §2.1 — a dispatch to a model this scope has never/rarely used */
  "unusual_model",
  /** §2.3 — spend materially outside the scope's historically active hours */
  "off_hours",
  /** §2.4 — connector/MCP egress CALL-VOLUME burst. Volume-shaped only. */
  "egress_volume",
] as const;
export type AnomalySignal = (typeof ANOMALY_SIGNALS)[number];

/**
 * The documented statistical rule. `mad_z` is the Iglewicz–Hoaglin MODIFIED
 * z-score: `0.6745 * (x - median) / MAD`, where MAD is the median absolute
 * deviation. It is used rather than a plain z-score because a mean/stddev
 * baseline is dragged upward by the very spike it is supposed to detect, which
 * makes a classic z-score progressively blinder the worse the incident gets.
 * `pct_over_baseline` is the fallback for a DEGENERATE baseline (MAD = 0,
 * i.e. a perfectly flat history) where a z-score is undefined.
 */
export const ANOMALY_METHODS = ["mad_z", "pct_over_baseline", "share_of_history"] as const;
export type AnomalyMethod = (typeof ANOMALY_METHODS)[number];

/** What a fired signal DOES. ADR-0049 §4: alert-not-block is the default, and
 * enforcement rides the EXISTING Approvals Queue — never a new inbox. */
export const ANOMALY_ACTIONS = ["alert", "require_approval"] as const;
export type AnomalyAction = (typeof ANOMALY_ACTIONS)[number];

export const ANOMALY_STATUSES = ["open", "acknowledged", "dismissed"] as const;
export type AnomalyStatus = (typeof ANOMALY_STATUSES)[number];

/**
 * Sensitivity is an ADMIN DIAL under the ADR-0021 org-settings conventions, and
 * it is expressed as a NAMED level rather than a raw threshold so the dial has
 * no unsafe positions. The numbers are the modified-z thresholds each level
 * maps to; 3.5 is the Iglewicz–Hoaglin convention and is the default.
 */
export const ANOMALY_SENSITIVITIES = ["low", "medium", "high"] as const;
export type AnomalySensitivity = (typeof ANOMALY_SENSITIVITIES)[number];

export const SENSITIVITY_Z: Record<AnomalySensitivity, number> = {
  low: 5.0,
  medium: 3.5, // Iglewicz & Hoaglin (1993) — the published convention
  high: 2.5,
};

/**
 * The FLOOR under every signal. A modified z-score is scale-free, so a baseline
 * of $0.0001/day makes $0.002 an "eleven-sigma event" — statistically true and
 * operationally worthless. Nothing fires unless the observation ALSO clears an
 * absolute floor, per signal. These are deliberately conservative: a detector
 * that fires on everything is not a detector.
 */
export const ANOMALY_ABSOLUTE_FLOORS = {
  spend_spike: 1.0, // USD in the window
  token_volume: 10_000, // tokens in the window
  unusual_model: 1.0, // USD on the unfamiliar model
  off_hours: 1.0, // USD outside the active window
  egress_volume: 25, // governed connector/MCP calls in the window
} as const satisfies Record<AnomalySignal, number>;

/** ADR-0049 §5 cold start, as a NUMBER. Below this many baseline observations
 * the detector makes no claim whatsoever. */
export const MIN_BASELINE_SAMPLES = 7;

/** ADR-0049's forecast cold-start floor: below this many DAYS with any spend,
 * a projection is an extrapolation of noise and is refused. */
export const MIN_FORECAST_DAYS = 3;

/** ...and below this fraction of the period elapsed, likewise. Projecting a
 * month from its first six hours is arithmetic, not forecasting. */
export const MIN_FORECAST_ELAPSED_FRACTION = 0.1;

export const FORECAST_DISCLAIMER =
  "A FORECAST IS NOT A COMMITMENT. This is a deterministic extrapolation of measured history " +
  "(usage_events, priced at published list price per GOVERNANCE_LAYER_SPEC §10.4). It models no " +
  "day-of-week or seasonal effect, no undeclared future change, and no step change it has not " +
  "already observed. Treat the confidence interval as the honest width of the answer, not the " +
  "point estimate as the answer.";

export const ANOMALY_DISCLAIMER =
  "AN ANOMALY IS A SIGNAL FOR HUMAN REVIEW, NEVER PROOF OF WRONGDOING. It states that an " +
  "observation sits far from this scope's own recent history by a stated statistical rule. It " +
  "says nothing about intent, and false positives are expected — tune sensitivity rather than " +
  "treating a flag as a finding.";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export const spendMonitorPolicySchema = z
  .object({
    /** null = the ORG-WIDE default policy (the singleton fallback) */
    projectId: z.string().uuid().nullish(),
    enabled: z.boolean().default(true),
    sensitivity: z.enum(ANOMALY_SENSITIVITIES).default("medium"),
    /** trailing days of history the rolling baseline is computed from */
    baselineDays: z.number().int().min(7).max(365).default(30),
    /** what a fired signal does. Default `alert` — ADR-0049 §5's
     * alert-not-block bias, expressed as the schema default rather than as a
     * comment somewhere else. */
    action: z.enum(ANOMALY_ACTIONS).default("alert"),
    /** signals to evaluate; null = all of them */
    signals: z.array(z.enum(ANOMALY_SIGNALS)).min(1).nullish(),
    /** UTC hour range treated as "active" for the off-hours signal. Null =
     * derive it from the scope's own history. */
    activeHourStart: z.number().int().min(0).max(23).nullish(),
    activeHourEnd: z.number().int().min(0).max(23).nullish(),
  })
  .strict();
export type SpendMonitorPolicyInput = z.infer<typeof spendMonitorPolicySchema>;

export const scheduledSpendChangeSchema = z
  .object({
    projectId: z.string().uuid(),
    /** the DECIDED delta this change adds to (or removes from) the remainder
     * of the period. Signed on purpose: a decommissioned expensive agent is a
     * negative number, and a forecast that could only ever go up would be a
     * different kind of dishonest. */
    deltaUsd: z.number().finite(),
    effectiveAt: z.string().datetime(),
    reason: z.string().min(1).max(1000),
  })
  .strict();

export const forecastQuerySchema = z
  .object({
    projectId: z.string().uuid().optional(),
    teamId: z.string().uuid().optional(),
    method: z.enum(FORECAST_METHODS).default("run_rate"),
    period: z.enum(["current_month", "current_quarter", "last_30_days"]).default("current_month"),
  })
  .strict();

export const decideAnomalySchema = z
  .object({
    status: z.enum(["acknowledged", "dismissed"]),
    reason: z.string().min(1).max(2000),
  })
  .strict();

// ---------------------------------------------------------------------------
// Small, exact statistics — every one hand-checkable
// ---------------------------------------------------------------------------

/** 6-dp rounding at the edge, the same precision ADR-0047's `round6` uses, so
 * the forecast and the report cannot disagree by rounding. */
export function round6(n: number): number {
  return Number(n.toFixed(6));
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** SAMPLE standard deviation (n-1). Zero for n < 2 — an interval computed from
 * one observation would be a fabricated zero-width certainty. */
export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Median absolute deviation — the robust scale estimate `mad_z` divides by. */
export function mad(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/**
 * The Iglewicz–Hoaglin modified z-score. 0.6745 is the 0.75 quantile of the
 * standard normal, which is what makes MAD a consistent estimator of sigma for
 * normal data — so the threshold 3.5 has the same meaning it would on a plain
 * z-score, without the mean/stddev's vulnerability to the spike itself.
 */
export function modifiedZ(x: number, baseline: number[]): number | null {
  const scale = mad(baseline);
  if (scale === 0) return null; // degenerate baseline — caller falls back
  return (0.6745 * (x - median(baseline))) / scale;
}

// ---------------------------------------------------------------------------
// THE FORECAST
// ---------------------------------------------------------------------------

export interface ForecastInput {
  /** one entry per ELAPSED day of the period, in order, INCLUDING zero days.
   * Zero days matter: a project that spent on 2 of 10 elapsed days has a mean
   * daily rate of (total/10), not (total/2). Dropping the zeros would inflate
   * every projection. */
  dailyTotals: number[];
  /** total days in the period (e.g. 31 for a 31-day month) */
  periodDays: number;
  /** days elapsed, matching `dailyTotals.length`. Fractional is fine — a
   * partial current day is a partial observation. */
  elapsedDays: number;
  method: ForecastMethod;
  /** DECIDED future deltas (ADR-0049 §1's scheduled-change adjustment), summed
   * by the caller from `spend_scheduled_changes` rows still ahead in the
   * period. Added on top of the extrapolation, never inferred from it. */
  scheduledDeltaUsd?: number;
  /** the project's budget for the period, when it has one */
  budgetUsd?: number | null;
  /** EWMA smoothing factor. 0.4 weights the most recent day at 40% and decays
   * geometrically; exposed so the number is auditable rather than magic. */
  alpha?: number;
}

export interface ForecastResult {
  method: ForecastMethod;
  /** false = NOT ENOUGH HISTORY. `projectedSpendUsd` is null and the caller
   * must render the reason, never a number. */
  sufficient: boolean;
  insufficientReason: string | null;
  spendToDateUsd: number;
  observedDays: number;
  /** days in the sample that carried ANY spend — the honest sample size, as
   * distinct from calendar days elapsed */
  activeDays: number;
  meanDailyUsd: number;
  /** the point estimate. NULL whenever `sufficient` is false. */
  projectedSpendUsd: number | null;
  /** 95% interval on the projection, from the standard error of the mean daily
   * rate. NULL alongside the point estimate. */
  lowUsd: number | null;
  highUsd: number | null;
  /** the half-width as a fraction of the point estimate — the one number that
   * answers "how much should I trust this?" at a glance. */
  relativeBandWidth: number | null;
  scheduledDeltaUsd: number;
  budgetUsd: number | null;
  projectedPctOfBudget: number | null;
  /** ADR-0049 §1's early warning: the day-of-period on which the CURRENT rate
   * crosses the budget, or null if it does not within the period (or there is
   * no budget). Integer day index, 1-based. */
  budgetBreachDay: number | null;
  assumptions: string[];
  limits: string[];
  disclaimer: string;
}

/**
 * The projector. Both methods share one skeleton:
 *
 *     projected = spendToDate + dailyRate * remainingDays + scheduledDelta
 *
 * and differ ONLY in how `dailyRate` is estimated:
 *
 *   run_rate:  dailyRate = spendToDate / elapsedDays          (the flat mean)
 *   ewma:      dailyRate = EWMA(dailyTotals, alpha)           (recency-weighted)
 *
 * Note the `run_rate` identity: `spendToDate + (spendToDate/elapsed)*(period -
 * elapsed)` is algebraically `spendToDate * period / elapsed`, which is exactly
 * ADR-0049 §1's `spend_to_date / fraction_of_period_elapsed`. Written the long
 * way here because the long way is the one that also produces the interval.
 *
 * THE INTERVAL. The mean daily rate is an estimate from `n` daily observations
 * with sample standard deviation `s`; its standard error is `s/sqrt(n)`. That
 * uncertainty is multiplied by the remaining days (the only part of the total
 * that is estimated rather than measured) and widened to 95% with 1.96:
 *
 *     halfWidth = 1.96 * (s / sqrt(n)) * remainingDays
 *
 * So the band narrows as the period fills (remainingDays falls, n rises) and is
 * widest at the start — the property ADR-0049 §1 asks for, arrived at by
 * construction rather than by a fudge factor. It is a normal approximation, and
 * it says nothing about the risk that the RATE ITSELF changes; that is the
 * step-change limit named in the header.
 */
export function forecastSpend(input: ForecastInput): ForecastResult {
  const {
    dailyTotals,
    periodDays,
    elapsedDays,
    method,
    scheduledDeltaUsd = 0,
    budgetUsd = null,
    alpha = 0.4,
  } = input;

  const spendToDate = round6(dailyTotals.reduce((a, b) => a + b, 0));
  const observedDays = dailyTotals.length;
  const activeDays = dailyTotals.filter((d) => d > 0).length;
  const remainingDays = Math.max(0, periodDays - elapsedDays);
  const elapsedFraction = periodDays > 0 ? elapsedDays / periodDays : 0;
  const meanDaily = elapsedDays > 0 ? spendToDate / elapsedDays : 0;

  const assumptions = [
    `spend continues at the ${method === "run_rate" ? "flat mean" : "recency-weighted (EWMA α=" + alpha + ")"} daily rate observed so far`,
    "every day in the remaining period behaves like the days already measured",
    "only DECIDED changes recorded as scheduled deltas are added on top; nothing else is anticipated",
  ];
  const limits = [
    "no day-of-week or seasonal effect is modelled — a weekday-only team measured from a weekend under-projects, and vice versa",
    "a step change not yet observed (a newly granted expensive agent, a new team onboarding) is invisible to the extrapolation",
    "the confidence interval covers sampling variation in the daily rate ONLY; it does not cover the rate itself changing",
    "spend is a list-price ESTIMATE (GOVERNANCE_LAYER_SPEC §10.4), so the forecast inherits that basis and is not invoice-grade",
  ];

  const insufficient = (reason: string): ForecastResult => ({
    method,
    sufficient: false,
    insufficientReason: reason,
    spendToDateUsd: spendToDate,
    observedDays,
    activeDays,
    meanDailyUsd: round6(meanDaily),
    projectedSpendUsd: null,
    lowUsd: null,
    highUsd: null,
    relativeBandWidth: null,
    scheduledDeltaUsd: round6(scheduledDeltaUsd),
    budgetUsd,
    projectedPctOfBudget: null,
    budgetBreachDay: null,
    assumptions,
    limits,
    disclaimer: FORECAST_DISCLAIMER,
  });

  // THE THREE COLD-START REFUSALS. Each returns the honest signal, never a
  // number — ADR-0049 §5's "cold start is disclosed, not faked".
  if (activeDays === 0) {
    return insufficient(
      "INSUFFICIENT DATA: no measured spend in this period for this scope. A forecast would be an " +
        "extrapolation of nothing — only the static budget/framework caps apply until history exists.",
    );
  }
  if (activeDays < MIN_FORECAST_DAYS) {
    return insufficient(
      `INSUFFICIENT DATA: spend observed on ${activeDays} day(s), below the ${MIN_FORECAST_DAYS}-day ` +
        "floor. Extrapolating a period from one or two days is arithmetic on noise, so no projection is offered.",
    );
  }
  if (elapsedFraction < MIN_FORECAST_ELAPSED_FRACTION) {
    return insufficient(
      `INSUFFICIENT DATA: only ${(elapsedFraction * 100).toFixed(1)}% of the period has elapsed, below the ` +
        `${MIN_FORECAST_ELAPSED_FRACTION * 100}% floor. A ${(1 / Math.max(elapsedFraction, 1e-9)).toFixed(0)}x ` +
        "extrapolation is not a forecast.",
    );
  }

  const dailyRate = method === "run_rate" ? meanDaily : ewma(dailyTotals, alpha);
  const projectedRaw = spendToDate + dailyRate * remainingDays + scheduledDeltaUsd;
  const projected = round6(Math.max(0, projectedRaw));

  const s = stddev(dailyTotals);
  const seMean = s / Math.sqrt(observedDays);
  const halfWidth = 1.96 * seMean * remainingDays;
  const low = round6(Math.max(0, projectedRaw - halfWidth));
  const high = round6(projectedRaw + halfWidth);

  return {
    method,
    sufficient: true,
    insufficientReason: null,
    spendToDateUsd: spendToDate,
    observedDays,
    activeDays,
    meanDailyUsd: round6(meanDaily),
    projectedSpendUsd: projected,
    lowUsd: low,
    highUsd: high,
    relativeBandWidth: projected > 0 ? round6(halfWidth / projected) : null,
    scheduledDeltaUsd: round6(scheduledDeltaUsd),
    budgetUsd,
    projectedPctOfBudget: budgetUsd && budgetUsd > 0 ? round6((projected / budgetUsd) * 100) : null,
    budgetBreachDay: budgetBreachDay(spendToDate, dailyRate, elapsedDays, periodDays, budgetUsd),
    assumptions,
    limits,
    disclaimer: FORECAST_DISCLAIMER,
  };
}

/**
 * Exponentially-weighted mean of a series, most recent observation heaviest.
 * Seeded with the FIRST observation (the standard recursive form) so the result
 * is fully determined by the series and alpha — no warm-up window, nothing
 * hidden.
 */
export function ewma(xs: number[], alpha: number): number {
  if (xs.length === 0) return 0;
  let acc = xs[0]!;
  for (let i = 1; i < xs.length; i++) acc = alpha * xs[i]! + (1 - alpha) * acc;
  return acc;
}

/**
 * The day of the period on which cumulative spend crosses the budget at the
 * current rate — ADR-0049 §1's "reaches 130% of budget by day 24". Returns null
 * when there is no budget, no rate, or the crossing lies beyond the period
 * (a forecast that stays under budget has no breach day, and inventing one
 * outside the window would be a lie about the period).
 */
export function budgetBreachDay(
  spendToDate: number,
  dailyRate: number,
  elapsedDays: number,
  periodDays: number,
  budgetUsd: number | null,
): number | null {
  if (!budgetUsd || budgetUsd <= 0) return null;
  if (spendToDate >= budgetUsd) return Math.max(1, Math.ceil(elapsedDays));
  if (dailyRate <= 0) return null;
  const day = elapsedDays + (budgetUsd - spendToDate) / dailyRate;
  if (day > periodDays) return null;
  return Math.ceil(day);
}

// ---------------------------------------------------------------------------
// THE ANOMALY DETECTOR
// ---------------------------------------------------------------------------

export interface AnomalyInput {
  signal: AnomalySignal;
  /** the trailing per-window observations the baseline is built from, EXCLUDING
   * the observation under test */
  baseline: number[];
  /** the observation under test */
  observed: number;
  sensitivity: AnomalySensitivity;
  /** overrides ANOMALY_ABSOLUTE_FLOORS for this signal, when a policy sets one */
  absoluteFloor?: number;
}

export interface AnomalyVerdict {
  signal: AnomalySignal;
  /** false = COLD START. `fired` is false and no claim is made either way. */
  evaluated: boolean;
  fired: boolean;
  method: AnomalyMethod | null;
  observed: number;
  baselineMedian: number | null;
  baselineMad: number | null;
  baselineSamples: number;
  score: number | null;
  threshold: number | null;
  absoluteFloor: number;
  /** the full sentence a human reads. Always names the method, the baseline,
   * the threshold and the observation — ADR-0049 §5's "no unexplained risk
   * score", enforced by making the explanation the return value. */
  explanation: string;
  disclaimer: string;
}

/**
 * The rule, in order:
 *
 *  1. COLD START. Fewer than `MIN_BASELINE_SAMPLES` baseline observations →
 *     `evaluated: false`. No claim. This is checked FIRST so a brand-new
 *     project can never be flagged by a two-point "baseline".
 *  2. ABSOLUTE FLOOR. An observation below the signal's floor cannot fire,
 *     whatever its z-score. This is what stops a $0.002 call being an
 *     eleven-sigma incident against a $0.0001 baseline.
 *  3. MODIFIED Z. `|0.6745 * (x - median) / MAD| > threshold`, one-sided (only
 *     an UPWARD excursion is a spend anomaly; spending less than usual is not
 *     an incident).
 *  4. DEGENERATE BASELINE. MAD = 0 (a perfectly flat history — common for a
 *     project that bills the same amount daily) makes the z-score undefined.
 *     The documented fallback is percent-over-baseline: fire at ≥ 3x the
 *     median. Reported as method `pct_over_baseline` so the flag never claims
 *     a z-score it did not compute.
 */
export function detectAnomaly(input: AnomalyInput): AnomalyVerdict {
  const { signal, baseline, observed, sensitivity } = input;
  const floor = input.absoluteFloor ?? ANOMALY_ABSOLUTE_FLOORS[signal];
  const threshold = SENSITIVITY_Z[sensitivity];
  const base = {
    signal,
    observed: round6(observed),
    absoluteFloor: floor,
    baselineSamples: baseline.length,
    disclaimer: ANOMALY_DISCLAIMER,
  };

  if (baseline.length < MIN_BASELINE_SAMPLES) {
    return {
      ...base,
      evaluated: false,
      fired: false,
      method: null,
      baselineMedian: null,
      baselineMad: null,
      score: null,
      threshold: null,
      explanation:
        `BASELINE BUILDING: ${baseline.length} of the ${MIN_BASELINE_SAMPLES} observations required ` +
        "before this scope has a baseline. No anomaly claim is made — only the static budget and " +
        "compliance-framework caps apply to a scope with no history (ADR-0049 §5).",
    };
  }

  const med = median(baseline);
  const scale = mad(baseline);

  if (observed < floor) {
    return {
      ...base,
      evaluated: true,
      fired: false,
      method: "mad_z",
      baselineMedian: round6(med),
      baselineMad: round6(scale),
      score: null,
      threshold,
      explanation:
        `observation ${round6(observed)} is below this signal's absolute floor of ${floor}; a ` +
        "statistically extreme reading of an operationally trivial amount is not reported as an incident",
    };
  }

  if (scale === 0) {
    // DEGENERATE baseline — documented fallback, and it says which rule it used
    const ratio = med > 0 ? observed / med : Infinity;
    const fired = ratio >= 3;
    return {
      ...base,
      evaluated: true,
      fired,
      method: "pct_over_baseline",
      baselineMedian: round6(med),
      baselineMad: 0,
      score: Number.isFinite(ratio) ? round6(ratio) : null,
      threshold: 3,
      explanation:
        `baseline is perfectly flat (MAD = 0) over ${baseline.length} observations, so a modified ` +
        `z-score is undefined; the documented fallback is percent-over-baseline. Observed ` +
        `${round6(observed)} is ${Number.isFinite(ratio) ? round6(ratio) + "x" : "infinitely above"} the ` +
        `median of ${round6(med)} — ${fired ? "at or above" : "below"} the 3x fallback threshold.`,
    };
  }

  const z = (0.6745 * (observed - med)) / scale;
  const fired = z > threshold;
  return {
    ...base,
    evaluated: true,
    fired,
    method: "mad_z",
    baselineMedian: round6(med),
    baselineMad: round6(scale),
    score: round6(z),
    threshold,
    explanation:
      `modified z-score ${round6(z)} = 0.6745 × (${round6(observed)} − median ${round6(med)}) / MAD ` +
      `${round6(scale)}, over ${baseline.length} baseline observations, against a '${sensitivity}' ` +
      `sensitivity threshold of ${threshold} — ${fired ? "FIRED" : "within normal variance"}.`,
  };
}

/**
 * §2.1 unusual-model: a SHARE-OF-HISTORY rule rather than a z-score, because
 * the question is categorical ("has this scope used this model before?") and
 * pretending otherwise would be exactly the unexplained-score this ADR bans.
 * Fires when a model accounts for < `rareShare` of the scope's historical
 * dispatches AND the spend attributed to it in the window clears the floor.
 */
export function detectUnusualModel(input: {
  model: string;
  /** historical dispatch counts per model over the baseline window */
  historicalCounts: Record<string, number>;
  observedSpendUsd: number;
  rareShare?: number;
  absoluteFloor?: number;
}): AnomalyVerdict {
  const rareShare = input.rareShare ?? 0.02;
  const floor = input.absoluteFloor ?? ANOMALY_ABSOLUTE_FLOORS.unusual_model;
  const total = Object.values(input.historicalCounts).reduce((a, b) => a + b, 0);
  const own = input.historicalCounts[input.model] ?? 0;
  const base = {
    signal: "unusual_model" as const,
    observed: round6(input.observedSpendUsd),
    absoluteFloor: floor,
    baselineSamples: total,
    disclaimer: ANOMALY_DISCLAIMER,
  };
  if (total < MIN_BASELINE_SAMPLES) {
    return {
      ...base,
      evaluated: false,
      fired: false,
      method: null,
      baselineMedian: null,
      baselineMad: null,
      score: null,
      threshold: null,
      explanation:
        `BASELINE BUILDING: ${total} historical dispatch(es), below the ${MIN_BASELINE_SAMPLES} required ` +
        "before a model can be called unfamiliar for this scope.",
    };
  }
  const share = own / total;
  const fired = share < rareShare && input.observedSpendUsd >= floor;
  return {
    ...base,
    evaluated: true,
    fired,
    method: "share_of_history",
    baselineMedian: round6(share),
    baselineMad: null,
    score: round6(share),
    threshold: rareShare,
    explanation:
      `model '${input.model}' accounts for ${own}/${total} (${round6(share * 100)}%) of this scope's ` +
      `dispatches over the baseline window, against a rarity threshold of ${rareShare * 100}%, with ` +
      `$${round6(input.observedSpendUsd)} attributed to it in the observed window (floor $${floor}) — ` +
      `${fired ? "FIRED" : "not unusual for this scope"}.`,
  };
}

// ---------------------------------------------------------------------------
// Enforcement — floors respected, alert-not-block default
// ---------------------------------------------------------------------------

export interface EnforcementInput {
  action: AnomalyAction;
  /** ADR-0027 §9's compliance-cascade cost floor for the project, when one
   * applies. `block` here means a framework MANDATES blocking enforcement. */
  frameworkFloor?: "warn" | "block" | null;
  /** does the project have a named budget approver? Without one there is
   * nobody to route an approval TO, and manufacturing an approver would be
   * worse than declining to escalate. */
  hasApprover: boolean;
}

export interface EnforcementDecision {
  /** what actually happens */
  effect: "alert" | "require_approval";
  /** true = an Approvals-Queue item is raised on the EXISTING queue */
  escalate: boolean;
  ruleId: string;
  reason: string;
}

/**
 * ADR-0049 §4: an anomaly response may TIGHTEN but never RELAX a framework's
 * required enforcement. The floor is applied as a MAX, so a `block`-mandating
 * profile makes `require_approval` the minimum even when the policy says
 * `alert`; the reverse can never happen.
 */
export function decideEnforcement(input: EnforcementInput): EnforcementDecision {
  const floorRequires = input.frameworkFloor === "block";
  const wants = input.action === "require_approval" || floorRequires;

  if (!wants) {
    return {
      effect: "alert",
      escalate: false,
      ruleId: "spend-anomaly-alert-only",
      reason:
        "policy action is 'alert' and no compliance framework mandates blocking cost enforcement for " +
        "this project — the signal is recorded and surfaced, and no spend is gated. This is ADR-0049 " +
        "§5's deliberate alert-not-block default for an ambiguous statistical signal.",
    };
  }
  if (!input.hasApprover) {
    return {
      effect: "alert",
      escalate: false,
      ruleId: "spend-anomaly-no-approver",
      reason:
        "enforcement was requested" +
        (floorRequires ? " (and a compliance framework mandates it)" : "") +
        ", but this project names no budget approver, so there is no queue to route the review to. " +
        "The signal is recorded as an alert and the gap is stated rather than an approver invented.",
    };
  }
  return {
    effect: "require_approval",
    escalate: true,
    ruleId: floorRequires ? "spend-anomaly-enforced-framework-floor" : "spend-anomaly-enforced",
    reason:
      (floorRequires
        ? "a compliance framework mandates blocking cost enforcement for this project, so the anomaly " +
          "response is raised to require-approval regardless of the configured action (a floor tightens, never relaxes)"
        : "policy action is 'require_approval'") +
      " — a review item is raised on the EXISTING Approvals Queue against the project's named budget " +
      "approver. It is reversible and appealable through that same queue; no separate inbox exists.",
  };
}

/**
 * Bucket a series of `(at, value)` observations into consecutive UTC day
 * totals covering `[start, end)`, INCLUDING days with no observations. Pure so
 * the forecast's "zero days count" invariant is testable without a database.
 */
export function bucketDaily(
  rows: Array<{ at: Date; value: number }>,
  start: Date,
  end: Date,
): number[] {
  const dayMs = 24 * 3600 * 1000;
  const startDay = Math.floor(start.getTime() / dayMs);
  const days = Math.max(0, Math.ceil((end.getTime() - start.getTime()) / dayMs));
  const out = new Array<number>(days).fill(0);
  for (const r of rows) {
    const idx = Math.floor(r.at.getTime() / dayMs) - startDay;
    if (idx >= 0 && idx < days) out[idx] = out[idx]! + r.value;
  }
  return out.map(round6);
}

/** UTC hours in which this scope historically spends, derived from its own
 * history: every hour whose share of historical spend is at or above
 * `minShare`. Returned sorted so the payload is stable. */
export function activeHours(
  rows: Array<{ hour: number; value: number }>,
  minShare = 0.02,
): number[] {
  const total = rows.reduce((a, r) => a + r.value, 0);
  if (total <= 0) return [];
  const byHour = new Map<number, number>();
  for (const r of rows) byHour.set(r.hour, (byHour.get(r.hour) ?? 0) + r.value);
  return [...byHour.entries()]
    .filter(([, v]) => v / total >= minShare)
    .map(([h]) => h)
    .sort((a, b) => a - b);
}
