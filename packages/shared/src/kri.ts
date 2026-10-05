/**
 * ADR-0173 batch 2c (K) — KEY RISK INDICATORS: the metric registry over
 * traces, the series a dashboard plots, and the dashboard shape. Pure.
 *
 * A KRI is one metric, over one scope, over a rolling window, against one
 * threshold. The governance monitor evaluates every enabled KRI on its pass
 * (`kri_threshold_breached`, subject `kri:<id>`), so a breach is an ordinary
 * governance alert: acknowledged, resolved and sent to chat exactly like the
 * others. This registry is the one ADR-0175 A2 (D3) reuses.
 *
 * THE METRICS, all over `traces` (and, for feedback, `trace_scores`):
 *   trace_volume    traces started in the window                      (count)
 *   error_rate      error traces / finished traces, in percent         (0–100)
 *   latency_p50     median trace duration, ms (Postgres percentile_cont)
 *   latency_p99     99th percentile trace duration, ms (percentile_cont)
 *   cost_usd        priced spend in the window, USD
 *   feedback_score  mean annotation score (source = annotation); until a
 *                   dedicated feedback source exists, annotation scores ARE
 *                   the feedback signal (owner decision, 2026-10-05)
 *
 * SAMPLES. Every metric reports how many observations it rests on (traces,
 * finished traces, timed traces, priced traces, annotation scores). Below a
 * KRI's `minSamples` the state is "insufficient": it neither breaches nor
 * resolves, so a quiet weekend never closes a real episode and one slow call
 * never opens one.
 *
 * WINDOW TOTALS ARE THE EXCEPTION (`kriMetricIsWindowTotal`). For a count or a
 * sum over the window (trace volume, cost) the WINDOW is the sample: "no
 * traces this week" is a measurement of 0, not too little data, so
 * `minSamples` never suppresses those two. Otherwise "trace volume below 10"
 * could never fire on the very outage it exists to catch. Cost is 0 when the
 * window holds no traces at all; when it holds traces but none was priced the
 * spend is unknown, so it is "no data" (value null) rather than an invented 0.
 */
import { z } from "zod";

export const KRI_METRICS = {
  trace_volume: { label: "Trace volume", unit: "traces", samples: "traces started in the window" },
  error_rate: { label: "Error rate", unit: "%", samples: "finished traces" },
  latency_p50: { label: "Latency p50", unit: "ms", samples: "traces with a duration" },
  latency_p99: { label: "Latency p99", unit: "ms", samples: "traces with a duration" },
  cost_usd: { label: "Cost", unit: "USD", samples: "priced traces" },
  feedback_score: { label: "Feedback score", unit: "score", samples: "annotation scores" },
} as const;
export type KriMetric = keyof typeof KRI_METRICS;
export const KRI_METRIC_IDS = Object.keys(KRI_METRICS) as [KriMetric, ...KriMetric[]];

export const KRI_SCOPES = ["fleet", "agent", "project"] as const;
export type KriScope = (typeof KRI_SCOPES)[number];
export const KRI_COMPARATORS = ["above", "below"] as const;
export type KriComparator = (typeof KRI_COMPARATORS)[number];
export const KRI_SEVERITIES = ["low", "medium", "high"] as const;

export const KRI_LIMITS = {
  maxWindowDays: 90,
  maxNameChars: 120,
  maxMinSamples: 100_000,
  defaultMinSamples: 20,
} as const;

const kriFields = {
  name: z.string().trim().min(1).max(KRI_LIMITS.maxNameChars),
  metric: z.enum(KRI_METRIC_IDS),
  scope: z.enum(KRI_SCOPES),
  scopeId: z.string().uuid().nullable(),
  windowDays: z.number().int().min(1).max(KRI_LIMITS.maxWindowDays),
  comparator: z.enum(KRI_COMPARATORS),
  threshold: z.number().finite(),
  minSamples: z.number().int().min(1).max(KRI_LIMITS.maxMinSamples),
  severity: z.enum(KRI_SEVERITIES),
  scoreName: z.string().trim().min(1).max(128).nullable(),
  enabled: z.boolean(),
};

function refineKri(
  k: { scope?: KriScope | undefined; scopeId?: string | null | undefined; metric?: KriMetric | undefined; scoreName?: string | null | undefined },
  ctx: z.RefinementCtx,
): void {
  if (k.scope !== undefined) {
    if (k.scope === "fleet" && k.scopeId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scopeId"], message: "a fleet KRI names no agent or project" });
    }
    if (k.scope !== "fleet" && !k.scopeId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scopeId"], message: `a ${k.scope} KRI needs the ${k.scope}'s id` });
    }
  }
  if (k.metric !== undefined && k.metric !== "feedback_score" && k.scoreName) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scoreName"], message: "only a feedback KRI names a score" });
  }
}

export const kriCreateSchema = z
  .object({
    ...kriFields,
    scope: kriFields.scope.default("fleet"),
    scopeId: kriFields.scopeId.default(null),
    windowDays: kriFields.windowDays.default(7),
    comparator: kriFields.comparator.default("above"),
    minSamples: kriFields.minSamples.default(KRI_LIMITS.defaultMinSamples),
    severity: kriFields.severity.default("medium"),
    scoreName: kriFields.scoreName.default(null),
    enabled: kriFields.enabled.default(true),
  })
  .strict()
  .superRefine(refineKri);
export type KriCreate = z.infer<typeof kriCreateSchema>;

/** a PATCH: any field; scope and scopeId travel together */
export const kriUpdateSchema = z
  .object({
    name: kriFields.name,
    metric: kriFields.metric,
    scope: kriFields.scope,
    scopeId: kriFields.scopeId,
    windowDays: kriFields.windowDays,
    comparator: kriFields.comparator,
    threshold: kriFields.threshold,
    minSamples: kriFields.minSamples,
    severity: kriFields.severity,
    scoreName: kriFields.scoreName,
    enabled: kriFields.enabled,
  })
  .partial()
  .strict()
  .superRefine((k, ctx) => {
    if ((k.scope === undefined) !== (k.scopeId === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scope"], message: "change scope and scopeId together" });
    }
    refineKri(k, ctx);
  });
export type KriUpdate = z.infer<typeof kriUpdateSchema>;

export type KriState = "breached" | "ok" | "insufficient";

/** a count or a sum over the window: the window itself is the sample, so
 * `minSamples` does not apply (see WINDOW TOTALS above) */
export function kriMetricIsWindowTotal(metric: KriMetric): boolean {
  return metric === "trace_volume" || metric === "cost_usd";
}

/** a KRI's verdict on one measurement. `value` null (nothing measured) is
 * insufficient however many samples are claimed. Below `minSamples` it is
 * insufficient too, except for a window total (`kriMetricIsWindowTotal`),
 * whose value — 0 included — is always a measurement. */
export function evaluateKri(
  kri: { metric?: KriMetric | undefined; comparator: KriComparator; threshold: number; minSamples: number },
  m: { value: number | null; samples: number },
): KriState {
  if (m.value === null || !Number.isFinite(m.value)) return "insufficient";
  const windowTotal = kri.metric !== undefined && kriMetricIsWindowTotal(kri.metric);
  if (!windowTotal && m.samples < kri.minSamples) return "insufficient";
  const breached = kri.comparator === "above" ? m.value > kri.threshold : m.value < kri.threshold;
  return breached ? "breached" : "ok";
}

export function formatKriValue(metric: KriMetric, value: number | null): string {
  if (value === null) return "no data";
  switch (metric) {
    case "trace_volume":
      return `${Math.round(value)}`;
    case "error_rate":
      return `${value.toFixed(1)}%`;
    case "latency_p50":
    case "latency_p99":
      return `${Math.round(value)} ms`;
    case "cost_usd":
      return `$${value.toFixed(2)}`;
    case "feedback_score":
      return value.toFixed(2);
  }
}

// ---------------------------------------------------------------------------
// series (what a chart plots)
// ---------------------------------------------------------------------------

export const SERIES_BUCKETS = { hour: 3_600_000, day: 86_400_000 } as const;
export type SeriesBucket = keyof typeof SERIES_BUCKETS;
export const SERIES_GROUP_BY = ["none", "agent", "project"] as const;
export type SeriesGroupBy = (typeof SERIES_GROUP_BY)[number];

export const SERIES_LIMITS = {
  /** buckets per series: (to - from) / bucket */
  maxBuckets: 500,
  /** groups shown by name; the rest are summed into "other" */
  topGroups: 20,
  maxRangeDays: KRI_LIMITS.maxWindowDays,
} as const;

/** the label of the bucket that collects every group past the top 20 */
export const SERIES_OTHER_GROUP = "other";

export const seriesQuerySchema = z
  .object({
    metric: z.enum(KRI_METRIC_IDS),
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    bucket: z.enum(["hour", "day"]).default("day"),
    groupBy: z.enum(SERIES_GROUP_BY).default("none"),
    agentId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    scoreName: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    const from = Date.parse(q.from);
    const to = Date.parse(q.to);
    if (!(to > from)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to must be after from" });
      return;
    }
    if (to - from > SERIES_LIMITS.maxRangeDays * SERIES_BUCKETS.day) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["from"], message: `a series spans at most ${SERIES_LIMITS.maxRangeDays} days` });
    }
    const buckets = Math.ceil((to - from) / SERIES_BUCKETS[q.bucket]);
    if (buckets > SERIES_LIMITS.maxBuckets) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bucket"],
        message: `${buckets} buckets; a series has at most ${SERIES_LIMITS.maxBuckets} (use a coarser bucket or a shorter range)`,
      });
    }
  });
export type SeriesQuery = z.infer<typeof seriesQuerySchema>;

/**
 * Keep the top `SERIES_LIMITS.topGroups` groups by total and fold the rest
 * into one "other" group, bucket by bucket. Counts and costs add; for a rate,
 * a percentile or a mean the folded value is the sample-weighted mean of the
 * folded groups (an approximation, labelled as such by the caller).
 */
export function foldTopGroups<P extends { bucket: string; group: string; value: number | null; samples: number }>(
  points: P[],
  additive: boolean,
  top: number = SERIES_LIMITS.topGroups,
): { points: Array<{ bucket: string; group: string; value: number | null; samples: number }>; groups: string[]; folded: number } {
  const totals = new Map<string, number>();
  for (const p of points) totals.set(p.group, (totals.get(p.group) ?? 0) + (additive ? (p.value ?? 0) : p.samples));
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([g]) => g);
  const keep = new Set(ranked.slice(0, top));
  const folded = ranked.length - keep.size;
  const out: Array<{ bucket: string; group: string; value: number | null; samples: number }> = [];
  const other = new Map<string, { sum: number; weight: number; samples: number; any: boolean }>();
  for (const p of points) {
    if (keep.has(p.group)) {
      out.push({ bucket: p.bucket, group: p.group, value: p.value, samples: p.samples });
      continue;
    }
    const o = other.get(p.bucket) ?? { sum: 0, weight: 0, samples: 0, any: false };
    o.samples += p.samples;
    if (p.value !== null) {
      o.any = true;
      if (additive) o.sum += p.value;
      else {
        o.sum += p.value * p.samples;
        o.weight += p.samples;
      }
    }
    other.set(p.bucket, o);
  }
  for (const [bucket, o] of other) {
    const value = !o.any ? null : additive ? o.sum : o.weight > 0 ? o.sum / o.weight : null;
    out.push({ bucket, group: SERIES_OTHER_GROUP, value, samples: o.samples });
  }
  out.sort((a, b) => a.bucket.localeCompare(b.bucket) || a.group.localeCompare(b.group));
  return { points: out, groups: [...ranked.slice(0, top), ...(folded ? [SERIES_OTHER_GROUP] : [])], folded };
}

/** metrics whose per-bucket values add up across groups */
export function kriMetricIsAdditive(metric: KriMetric): boolean {
  return metric === "trace_volume" || metric === "cost_usd";
}

// ---------------------------------------------------------------------------
// dashboards
// ---------------------------------------------------------------------------

export const DASHBOARD_LIMITS = { maxPanels: 24, maxTitleChars: 120, maxNameChars: 120 } as const;

export const dashboardPanelSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("kri"),
        title: z.string().trim().min(1).max(DASHBOARD_LIMITS.maxTitleChars),
        kriId: z.string().uuid(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("series"),
        title: z.string().trim().min(1).max(DASHBOARD_LIMITS.maxTitleChars),
        metric: z.enum(KRI_METRIC_IDS),
        groupBy: z.enum(SERIES_GROUP_BY).default("none"),
        bucket: z.enum(["hour", "day"]).default("day"),
        rangeDays: z.number().int().min(1).max(SERIES_LIMITS.maxRangeDays).default(7),
      })
      .strict(),
  ])
  .superRefine((p, ctx) => {
    if (p.kind !== "series") return;
    const buckets = Math.ceil((p.rangeDays * SERIES_BUCKETS.day) / SERIES_BUCKETS[p.bucket]);
    if (buckets > SERIES_LIMITS.maxBuckets) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bucket"], message: `${buckets} buckets; at most ${SERIES_LIMITS.maxBuckets}` });
    }
  });
export type DashboardPanel = z.infer<typeof dashboardPanelSchema>;

export const dashboardSchema = z
  .object({
    name: z.string().trim().min(1).max(DASHBOARD_LIMITS.maxNameChars),
    panels: z.array(dashboardPanelSchema).max(DASHBOARD_LIMITS.maxPanels),
  })
  .strict();
export type DashboardInput = z.infer<typeof dashboardSchema>;
