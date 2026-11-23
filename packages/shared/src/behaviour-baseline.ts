/**
 * ADR-0359 (lane E40) — the pure half of behaviour baselines: given a subject's own history and the day under test,
 * say whether the day departs from normal, by how much, and in a sentence that shows the numbers.
 *
 * The method is ADR-0049's (spend anomalies), so an admin reads one kind of number across the product:
 *   - VOLUME signals (a count per day): cold start first (fewer than `minBaselineDays` baseline days → no claim), then
 *     the absolute floor, then the one-sided Iglewicz–Hoaglin modified z-score `0.6745 × (x − median) / MAD` against
 *     `zThreshold`. A flat baseline (MAD = 0) makes z undefined, so the documented fallback fires at `flatRatio` × the
 *     median or more and says it used the fallback.
 *   - CATEGORY signals (a tool, a destination, an hour of the day): the key's share of the subject's history in the
 *     window. A share below `rareShare` fires; a first-seen key has share 0. Needs `minBaselineDays` active days and
 *     `minCategoryEvents` events first.
 * `median` and `medianAbsoluteDeviation` come from simple-statistics (ISC, pinned; ADR-0176). No I/O, no network.
 */
import { median, medianAbsoluteDeviation } from "simple-statistics";

export const BEHAVIOUR_SIGNAL_NAMES = ["model_calls", "data_scoped_calls", "tool", "destination", "hour_of_day"] as const;
export type BehaviourSignal = (typeof BEHAVIOUR_SIGNAL_NAMES)[number];

type SignalDef = { readonly kind: "volume"; readonly floor: number } | { readonly kind: "category" };
export const BEHAVIOUR_SIGNALS: Readonly<Record<BehaviourSignal, SignalDef>> = Object.freeze({
  /** model calls per day (`object_type = 'agent'`) */
  model_calls: { kind: "volume", floor: 20 },
  /** calls per day whose rule chain ran a data-scope rule */
  data_scoped_calls: { kind: "volume", floor: 10 },
  /** the MCP tool name */
  tool: { kind: "category" },
  /** `mcp:<server>`, `model:<agent>` or `connector:<connector>` */
  destination: { kind: "category" },
  /** the UTC hour of the call, `00`..`23` */
  hour_of_day: { kind: "category" },
});
export const BEHAVIOUR_VOLUME_SIGNALS = BEHAVIOUR_SIGNAL_NAMES.filter((s) => BEHAVIOUR_SIGNALS[s].kind === "volume");
export const BEHAVIOUR_CATEGORY_SIGNALS = BEHAVIOUR_SIGNAL_NAMES.filter((s) => BEHAVIOUR_SIGNALS[s].kind === "category");

export const BEHAVIOUR_SUBJECT_KINDS = ["user", "agent"] as const;
export type BehaviourSubjectKind = (typeof BEHAVIOUR_SUBJECT_KINDS)[number];

export const BEHAVIOUR_METHODS = ["mad_z", "ratio_over_median", "share_of_history"] as const;
export type BehaviourMethod = (typeof BEHAVIOUR_METHODS)[number];

/** shadow = findings only, never enforcement (the default and the only mode built); off = no sweep */
export const BEHAVIOUR_MODES = ["shadow", "off"] as const;
export type BehaviourMode = (typeof BEHAVIOUR_MODES)[number];

/** the finding lifecycle's states; the transition table is `apps/gateway/src/behaviour/lifecycle.ts` */
export const BEHAVIOUR_FINDING_STATUSES = ["open", "acknowledged", "dismissed"] as const;
export type BehaviourFindingStatus = (typeof BEHAVIOUR_FINDING_STATUSES)[number];

export const BEHAVIOUR_BASELINE = Object.freeze({
  windowDays: 28,
  minBaselineDays: 7,
  zThreshold: 3.5,
  flatRatio: 3,
  rareShare: 0.02,
  minCategoryEvents: 20,
});

export interface BehaviourVerdict {
  signal: BehaviourSignal;
  /** '' for a volume signal */
  key: string;
  /** false = cold start: no claim either way */
  evaluated: boolean;
  fired: boolean;
  method: BehaviourMethod | null;
  observed: number;
  baselineDays: number;
  /** volume signals */
  baselineMedian: number | null;
  baselineMad: number | null;
  /** category signals: the key's count and all keys' count over the window */
  baselineKeyCount: number | null;
  baselineTotal: number | null;
  score: number | null;
  threshold: number | null;
  explanation: string;
}

const r6 = (n: number) => Number(n.toFixed(6));

/** the median and MAD of a per-day series (null when empty), for a baseline view */
export function volumeBaselineStats(series: readonly number[]): { median: number | null; mad: number | null } {
  if (series.length === 0) return { median: null, mad: null };
  return { median: r6(median([...series])), mad: r6(medianAbsoluteDeviation([...series])) };
}

/** A volume signal: `baseline` is one count per baseline day (zero days included), `observed` the day under test. */
export function evaluateVolume(input: { signal: BehaviourSignal; observed: number; baseline: number[] }): BehaviourVerdict {
  const { signal, observed, baseline } = input;
  const def = BEHAVIOUR_SIGNALS[signal];
  if (def.kind !== "volume") throw new TypeError(`${signal} is not a volume signal`);
  const { minBaselineDays, zThreshold, flatRatio } = BEHAVIOUR_BASELINE;
  const base = { signal, key: "", observed, baselineDays: baseline.length, baselineKeyCount: null, baselineTotal: null };
  if (baseline.length < minBaselineDays) {
    return {
      ...base,
      evaluated: false,
      fired: false,
      method: null,
      baselineMedian: null,
      baselineMad: null,
      score: null,
      threshold: null,
      explanation: `baseline building: ${baseline.length} of the ${minBaselineDays} days needed before ${signal} has a baseline; no claim is made`,
    };
  }
  const med = median(baseline);
  const scale = medianAbsoluteDeviation(baseline);
  const common = { ...base, evaluated: true, baselineMedian: r6(med), baselineMad: r6(scale) };
  if (observed < def.floor) {
    return {
      ...common,
      fired: false,
      method: "mad_z",
      score: null,
      threshold: zThreshold,
      explanation: `${signal} ${observed} is below the absolute floor of ${def.floor}; a small count is not reported however unusual`,
    };
  }
  if (scale === 0) {
    const ratio = med > 0 ? observed / med : Infinity;
    const fired = ratio >= flatRatio;
    return {
      ...common,
      fired,
      method: "ratio_over_median",
      score: Number.isFinite(ratio) ? r6(ratio) : null,
      threshold: flatRatio,
      explanation:
        `${signal} ${observed} against a flat baseline (median ${r6(med)}, MAD 0 over ${baseline.length} days), so the ` +
        `modified z-score is undefined and the ${flatRatio}x-median fallback applies: ` +
        `${Number.isFinite(ratio) ? `${r6(ratio)}x the median` : "the median is 0"} — ${fired ? "FIRED" : "within normal"}`,
    };
  }
  const z = (0.6745 * (observed - med)) / scale;
  const fired = z > zThreshold;
  return {
    ...common,
    fired,
    method: "mad_z",
    score: r6(z),
    threshold: zThreshold,
    explanation:
      `${signal} ${observed}: modified z-score ${r6(z)} = 0.6745 × (${observed} − median ${r6(med)}) / MAD ${r6(scale)} ` +
      `over ${baseline.length} baseline days, threshold ${zThreshold} — ${fired ? "FIRED" : "within normal"}`,
  };
}

/**
 * A category signal: `history` is the count per key over the baseline window, `activeDays` the number of baseline days
 * with any event for this signal, `observed` the key's count on the day under test.
 */
export function evaluateCategory(input: {
  signal: BehaviourSignal;
  key: string;
  observed: number;
  history: Readonly<Record<string, number>>;
  activeDays: number;
}): BehaviourVerdict {
  const { signal, key, observed, history, activeDays } = input;
  if (BEHAVIOUR_SIGNALS[signal].kind !== "category") throw new TypeError(`${signal} is not a category signal`);
  const { minBaselineDays, minCategoryEvents, rareShare } = BEHAVIOUR_BASELINE;
  const total = Object.values(history).reduce((a, b) => a + b, 0);
  const own = Object.hasOwn(history, key) ? history[key]! : 0;
  const base = { signal, key, observed, baselineDays: activeDays, baselineMedian: null, baselineMad: null, baselineKeyCount: own, baselineTotal: total };
  if (activeDays < minBaselineDays || total < minCategoryEvents) {
    return {
      ...base,
      evaluated: false,
      fired: false,
      method: null,
      score: null,
      threshold: null,
      explanation:
        `baseline building: ${activeDays} active days and ${total} events, below the ${minBaselineDays} days and ` +
        `${minCategoryEvents} events needed before a ${signal} can be called unusual; no claim is made`,
    };
  }
  const share = own / total;
  const fired = share < rareShare;
  return {
    ...base,
    evaluated: true,
    fired,
    method: "share_of_history",
    score: r6(share),
    threshold: rareShare,
    explanation:
      `${signal} '${key}' (${observed} today) is ${own} of ${total} events (${r6(share * 100)}%) over ${activeDays} ` +
      `active baseline days, against a rarity threshold of ${rareShare * 100}%` +
      `${own === 0 ? " — first seen" : ""} — ${fired ? "FIRED" : "usual for this subject"}`,
  };
}
