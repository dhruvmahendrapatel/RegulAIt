/**
 * ADR-0173 batch 2c (K) — the pure half of the Monitoring page and the
 * Automations tab: the gateway's read shapes, the bounds the gateway enforces
 * (MIRRORED from packages/shared/src/kri.ts and automation-rules.ts; the SPA
 * does not import @regulait/shared, and the server refuses anything else, so
 * drift fails loudly), value formatting, series pivoting for the chart, and
 * the rule form's payload.
 */

// ---------------------------------------------------------------------------
// KRIs
// ---------------------------------------------------------------------------

export const KRI_METRIC_OPTIONS = [
  { id: "trace_volume", label: "Trace volume", unit: "traces" },
  { id: "error_rate", label: "Error rate", unit: "%" },
  { id: "latency_p50", label: "Latency p50", unit: "ms" },
  { id: "latency_p99", label: "Latency p99", unit: "ms" },
  { id: "cost_usd", label: "Cost", unit: "USD" },
  { id: "feedback_score", label: "Feedback score", unit: "score" },
] as const;
export type KriMetric = (typeof KRI_METRIC_OPTIONS)[number]["id"];

/** mirrors KRI_LIMITS / SERIES_LIMITS / DASHBOARD_LIMITS */
export const MONITORING_LIMITS = { maxWindowDays: 90, maxBuckets: 500, maxPanels: 24 } as const;

export type KriState = "breached" | "ok" | "insufficient" | "disabled";

export interface Kri {
  id: string;
  name: string;
  metric: KriMetric;
  metricLabel: string;
  unit: string;
  scope: "fleet" | "agent" | "project";
  scopeId: string | null;
  scopeLabel?: string | null;
  windowDays: number;
  comparator: "above" | "below";
  threshold: number;
  minSamples: number;
  severity: "low" | "medium" | "high";
  scoreName: string | null;
  enabled: boolean;
  measurement: { value: number | null; samples: number; state: KriState } | null;
  alert: { id: string; status: string } | null;
}

export interface KrisResponse {
  kris: Kri[];
  measuredAt: string;
  note: string;
}

export function formatMetricValue(metric: string, value: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "no data";
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
    default:
      return value.toFixed(2);
  }
}

export const KRI_STATE_WORDS: Record<KriState, string> = {
  breached: "Past threshold",
  ok: "Within threshold",
  insufficient: "Too few samples",
  disabled: "Off",
};

export interface KriForm {
  name: string;
  metric: KriMetric;
  scope: "fleet" | "agent" | "project";
  scopeId: string;
  windowDays: string;
  comparator: "above" | "below";
  threshold: string;
  minSamples: string;
  severity: "low" | "medium" | "high";
  scoreName: string;
}

export const EMPTY_KRI_FORM: KriForm = {
  name: "",
  metric: "error_rate",
  scope: "fleet",
  scopeId: "",
  windowDays: "7",
  comparator: "above",
  threshold: "",
  minSamples: "20",
  severity: "medium",
  scoreName: "",
};

export function kriFormFrom(k: Kri): KriForm {
  return {
    name: k.name,
    metric: k.metric,
    scope: k.scope,
    scopeId: k.scopeId ?? "",
    windowDays: String(k.windowDays),
    comparator: k.comparator,
    threshold: String(k.threshold),
    minSamples: String(k.minSamples),
    severity: k.severity,
    scoreName: k.scoreName ?? "",
  };
}

/** the first problem with the form, in words, or null */
export function kriFormProblem(f: KriForm): string | null {
  if (!f.name.trim()) return "Give the KRI a name.";
  const w = Number(f.windowDays);
  if (!Number.isInteger(w) || w < 1 || w > MONITORING_LIMITS.maxWindowDays) return "The window is 1 to 90 days.";
  if (f.threshold.trim() === "" || !Number.isFinite(Number(f.threshold))) return "Set a numeric threshold.";
  const m = Number(f.minSamples);
  if (!Number.isInteger(m) || m < 1) return "The minimum sample count is a whole number of at least 1.";
  if (f.scope !== "fleet" && !f.scopeId) return `Pick the ${f.scope}.`;
  return null;
}

export function kriPayload(f: KriForm): Record<string, unknown> {
  return {
    name: f.name.trim(),
    metric: f.metric,
    scope: f.scope,
    scopeId: f.scope === "fleet" ? null : f.scopeId,
    windowDays: Number(f.windowDays),
    comparator: f.comparator,
    threshold: Number(f.threshold),
    minSamples: Number(f.minSamples),
    severity: f.severity,
    scoreName: f.metric === "feedback_score" && f.scoreName.trim() ? f.scoreName.trim() : null,
  };
}

// ---------------------------------------------------------------------------
// series
// ---------------------------------------------------------------------------

export interface SeriesResponse {
  metric: string;
  unit: string;
  bucket: "hour" | "day";
  groups: Array<{ key: string; label: string }>;
  points: Array<{ bucket: string; group: string; value: number | null; samples: number }>;
  folded: number;
  otherIsApproximate: boolean;
}

export const SERIES_RANGES = [
  { days: 1, label: "Last 24 hours", bucket: "hour" },
  { days: 7, label: "Last 7 days", bucket: "day" },
  { days: 30, label: "Last 30 days", bucket: "day" },
  { days: 90, label: "Last 90 days", bucket: "day" },
] as const;

/** how many groups the chart draws (the categorical palette's validated slots); the table lists all */
export const CHART_SERIES_CAP = 6;

export function seriesPath(q: { metric: string; groupBy: string; rangeDays: number; bucket: "hour" | "day" }, now: Date = new Date()): string {
  // align to the bucket so the request is stable while the page is open
  const step = q.bucket === "hour" ? 3_600_000 : 86_400_000;
  const to = new Date(Math.ceil(now.getTime() / step) * step);
  const from = new Date(to.getTime() - q.rangeDays * 86_400_000);
  const p = new URLSearchParams({ metric: q.metric, groupBy: q.groupBy, bucket: q.bucket, from: from.toISOString(), to: to.toISOString() });
  return `/v1/monitoring/series?${p.toString()}`;
}

/** rows for the chart: one per bucket, one key per charted group */
export function pivotSeries(s: SeriesResponse, cap: number = CHART_SERIES_CAP): {
  rows: Array<Record<string, string | number | null>>;
  charted: Array<{ key: string; label: string }>;
} {
  const charted = s.groups.slice(0, cap);
  const keys = new Set(charted.map((g) => g.key));
  const byBucket = new Map<string, Record<string, string | number | null>>();
  for (const p of s.points) {
    if (!keys.has(p.group)) continue;
    const row = byBucket.get(p.bucket) ?? { bucket: p.bucket };
    row[p.group] = p.value;
    byBucket.set(p.bucket, row);
  }
  const rows = [...byBucket.values()].sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)));
  return { rows, charted };
}

export function bucketLabel(iso: string, bucket: "hour" | "day"): string {
  return bucket === "hour" ? iso.slice(11, 16) : iso.slice(5, 10);
}

// ---------------------------------------------------------------------------
// dashboards
// ---------------------------------------------------------------------------

export type DashboardPanel =
  | { kind: "kri"; title: string; kriId: string }
  | { kind: "series"; title: string; metric: string; groupBy: string; bucket: "hour" | "day"; rangeDays: number };

export interface Dashboard {
  id: string;
  name: string;
  panels: DashboardPanel[];
}

// ---------------------------------------------------------------------------
// automation rules
// ---------------------------------------------------------------------------

/** mirrors AUTOMATION_LIMITS */
export const AUTOMATION_UI_LIMITS = { maxBackfillDays: 7, maxDailyActionCap: 10_000, maxHoldDays: 1095 } as const;

export interface AutomationRule {
  id: string;
  name: string;
  filter: Record<string, unknown>;
  samplingRate: number;
  actions: Array<{ type: "queue"; queueId: string } | { type: "dataset"; datasetId: string } | { type: "webhook"; subscriptionId: string } | { type: "retention"; days: number }>;
  status: "active" | "paused";
  pausedReason: string | null;
  author: { id: string; name: string | null };
  dailyActionCap: number;
  backfillUntil: string | null;
  stats?: { today: number; total: number; retrying: number; failed: number; lastMatchedAt: string | null };
}

export interface AutomationRulesResponse {
  rules: AutomationRule[];
  retention: { floorDays: number | null; maxHoldDays: number | null };
}

export interface AutomationMatch {
  id: string;
  traceId: string;
  traceName: string | null;
  matchedAt: string;
  backfill: boolean;
  status: "done" | "retry" | "failed";
  attempts: number;
  actionResults: Array<{ type: string; status: "ok" | "failed" | "pending"; reason: string | null; attempts: number }>;
}

export const ACTION_WORDS: Record<string, string> = {
  queue: "Send to annotation queue",
  dataset: "Add to dataset",
  webhook: "Notify webhook",
  retention: "Extend retention",
};

export interface RuleForm {
  name: string;
  tagKey: string;
  tagValue: string;
  model: string;
  agentId: string;
  status: string;
  minCostUsd: string;
  minLatencyMs: string;
  scoreName: string;
  scoreMax: string;
  flagged: boolean;
  deniedOnly: boolean;
  samplingPct: string;
  dailyActionCap: string;
  queueId: string;
  datasetId: string;
  subscriptionId: string;
  retentionDays: string;
}

export const EMPTY_RULE_FORM: RuleForm = {
  name: "",
  tagKey: "",
  tagValue: "",
  model: "",
  agentId: "",
  status: "",
  minCostUsd: "",
  minLatencyMs: "",
  scoreName: "",
  scoreMax: "",
  flagged: false,
  deniedOnly: false,
  samplingPct: "100",
  dailyActionCap: "500",
  queueId: "",
  datasetId: "",
  subscriptionId: "",
  retentionDays: "",
};

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

export function ruleFormFrom(r: AutomationRule): RuleForm {
  const f = r.filter;
  const act = <T extends AutomationRule["actions"][number]["type"]>(t: T) =>
    r.actions.find((a) => a.type === t) as Extract<AutomationRule["actions"][number], { type: T }> | undefined;
  return {
    name: r.name,
    tagKey: str(f["tagKey"]),
    tagValue: str(f["tagValue"]),
    model: str(f["model"]),
    agentId: str(f["agentId"]),
    status: str(f["status"]),
    minCostUsd: str(f["minCostUsd"]),
    minLatencyMs: str(f["minLatencyMs"]),
    scoreName: str(f["scoreName"]),
    scoreMax: str(f["scoreMax"]),
    flagged: f["flagged"] === true,
    deniedOnly: f["deniedOnly"] === true,
    samplingPct: String(Math.round(r.samplingRate * 1000) / 10),
    dailyActionCap: String(r.dailyActionCap),
    queueId: act("queue")?.queueId ?? "",
    datasetId: act("dataset")?.datasetId ?? "",
    subscriptionId: act("webhook")?.subscriptionId ?? "",
    retentionDays: act("retention") ? String(act("retention")!.days) : "",
  };
}

export function ruleFormProblem(f: RuleForm, maxHoldDays: number | null): string | null {
  if (!f.name.trim()) return "Give the rule a name.";
  const pct = Number(f.samplingPct);
  if (f.samplingPct.trim() === "" || !Number.isFinite(pct) || pct < 0 || pct > 100) return "Sampling is 0 to 100 percent.";
  const cap = Number(f.dailyActionCap);
  if (!Number.isInteger(cap) || cap < 1 || cap > AUTOMATION_UI_LIMITS.maxDailyActionCap) return "The daily cap is 1 to 10,000 matches.";
  if (f.tagValue && !f.tagKey) return "A tag value needs a tag key.";
  if (f.tagKey && !/^[a-z0-9_.-]{1,64}$/.test(f.tagKey)) return "A tag key is lowercase letters, digits, dot, dash or underscore.";
  if (f.scoreMax && !f.scoreName) return "A score bound needs a score name.";
  for (const [label, v] of [["Cost", f.minCostUsd], ["Latency", f.minLatencyMs], ["Score", f.scoreMax]] as const) {
    if (v.trim() !== "" && !Number.isFinite(Number(v))) return `${label} must be a number.`;
  }
  if (!f.queueId && !f.datasetId && !f.subscriptionId && !f.retentionDays) return "Pick at least one action.";
  if (f.retentionDays) {
    const d = Number(f.retentionDays);
    if (maxHoldDays === null) return "No retention floor is set, so traces are never pruned and there is nothing to extend.";
    if (!Number.isInteger(d) || d < 1 || d > maxHoldDays) return `A hold is 1 to ${maxHoldDays} days (twice the retention floor, at most three years).`;
  }
  return null;
}

export function rulePayload(f: RuleForm): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (f.tagKey) filter["tagKey"] = f.tagKey;
  if (f.tagValue) filter["tagValue"] = f.tagValue;
  if (f.model.trim()) filter["model"] = f.model.trim();
  if (f.agentId) filter["agentId"] = f.agentId;
  if (f.status) filter["status"] = f.status;
  if (f.minCostUsd.trim()) filter["minCostUsd"] = Number(f.minCostUsd);
  if (f.minLatencyMs.trim()) filter["minLatencyMs"] = Number(f.minLatencyMs);
  if (f.scoreName.trim()) filter["scoreName"] = f.scoreName.trim();
  if (f.scoreMax.trim()) filter["scoreMax"] = Number(f.scoreMax);
  if (f.flagged) filter["flagged"] = true;
  if (f.deniedOnly) filter["deniedOnly"] = true;
  const actions: Array<Record<string, unknown>> = [];
  if (f.queueId) actions.push({ type: "queue", queueId: f.queueId });
  if (f.datasetId) actions.push({ type: "dataset", datasetId: f.datasetId });
  if (f.subscriptionId) actions.push({ type: "webhook", subscriptionId: f.subscriptionId });
  if (f.retentionDays) actions.push({ type: "retention", days: Number(f.retentionDays) });
  return {
    name: f.name.trim(),
    filter,
    samplingRate: Math.round(Number(f.samplingPct) * 10) / 1000,
    actions,
    dailyActionCap: Number(f.dailyActionCap),
  };
}

/** "tag release=2026.10 · model x · cost ≥ $1" */
export function filterSentence(filter: Record<string, unknown>): string {
  const parts: string[] = [];
  if (filter["tagKey"]) parts.push(`tag ${String(filter["tagKey"])}${filter["tagValue"] !== undefined ? `=${String(filter["tagValue"])}` : ""}`);
  if (filter["model"]) parts.push(`model ${String(filter["model"])}`);
  if (filter["agentId"]) parts.push("one agent");
  if (filter["status"]) parts.push(`status ${String(filter["status"])}`);
  if (filter["minCostUsd"] !== undefined) parts.push(`cost ≥ $${String(filter["minCostUsd"])}`);
  if (filter["minLatencyMs"] !== undefined) parts.push(`latency ≥ ${String(filter["minLatencyMs"])} ms`);
  if (filter["scoreName"]) parts.push(`score ${String(filter["scoreName"])}${filter["scoreMax"] !== undefined ? ` ≤ ${String(filter["scoreMax"])}` : ""}`);
  if (filter["flagged"] === true) parts.push("flagged by evaluation");
  if (filter["deniedOnly"] === true) parts.push("governance refused something");
  return parts.length ? parts.join(" · ") : "every finished trace";
}

export function reasonWords(code: string | null): string {
  return code ? code.replace(/_/g, " ") : "";
}
