/**
 * ADR-0180 A2 — a MEASURED condition of approval, as the review drawer drafts
 * it and as the use-case record shows it. Pure, so the draft, its validation
 * and the exact decide body are unit-tested apart from the components.
 *
 * The SPA does not import @regulait/shared; the metric vocabulary and its
 * plain-language help mirror `CONDITION_METRIC_HELP` there (the gateway
 * refuses anything else, 422 `invalid_conditions`).
 */

export const METRIC_IDS = [
  "error_rate",
  "trace_eval_flag_rate",
  "guardrail_hits",
  "guardrail_mode",
  "redteam_asr",
  "eval_mean_score",
  "eval_pass_rate",
  "spend_usd",
  "pack_control_evidenced",
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

export const OPERATORS = ["lt", "lte", "gt", "gte", "eq"] as const;
export type Operator = (typeof OPERATORS)[number];
export const OPERATOR_LABEL: Record<Operator, string> = { lt: "below", lte: "at most", gt: "above", gte: "at least", eq: "equal to" };

export const CADENCES = ["hourly", "daily", "weekly"] as const;
export type Cadence = (typeof CADENCES)[number];

export const ON_BREACH = ["alert", "reopen_review"] as const;
export type OnBreach = (typeof ON_BREACH)[number];
export const ON_BREACH_LABEL: Record<OnBreach, string> = {
  alert: "Raise a monitor alert",
  reopen_review: "Alert, and reopen review after 2 breaches in a row",
};

export interface MetricHelp {
  label: string;
  unit: string;
  measures: string;
  sample: string;
  example: string;
}

/** what each metric measures, in words a reviewer can act on */
export const METRIC_HELP: Record<MetricId, MetricHelp> = {
  error_rate: {
    label: "Error rate",
    unit: "%",
    measures: "The share of the use case's finished traces that ended in an error.",
    sample: "one finished trace",
    example: "below 5 % over 7 days, at least 50 traces",
  },
  trace_eval_flag_rate: {
    label: "Trace evaluation flag rate",
    unit: "%",
    measures: "The share of the use case's model responses that continuous trace evaluation flagged (personal data, credentials, toxicity or injection attempts).",
    sample: "one evaluated response",
    example: "below 2 % over 7 days, at least 100 responses",
  },
  guardrail_hits: {
    label: "Guardrail hits",
    unit: "hits",
    measures: "How many times a guardrail blocked, warned on or logged one of the use case's calls.",
    sample: "one governed model call, so zero hits over real traffic can pass",
    example: "at most 0 blocked hits over 7 days, at least 50 calls",
  },
  guardrail_mode: {
    label: "Guardrail mode",
    unit: "level",
    measures: "The weakest mode one guardrail detector is set to across the use case's agents: off 0, log 1, warn 2, block 3.",
    sample: "one agent's guardrail configuration",
    example: "prompt injection at least 3 (block)",
  },
  redteam_asr: {
    label: "Red-team attack success rate",
    unit: "%",
    measures: "How often red-team attacks succeeded in the newest completed run of each of the use case's agents. An agent with no run means the result is not enough to pass.",
    sample: "one probe trial",
    example: "below 5 % over 30 days, at least 30 trials",
  },
  eval_mean_score: {
    label: "Evaluation mean score",
    unit: "score",
    measures: "The mean score, from 0 to 1, of the newest completed evaluation run of each of the use case's agents.",
    sample: "one scored evaluation case",
    example: "at least 0.8 over 30 days, at least 20 cases",
  },
  eval_pass_rate: {
    label: "Evaluation pass rate",
    unit: "%",
    measures: "The share of cases that passed in the newest completed evaluation run of each of the use case's agents.",
    sample: "one scored evaluation case",
    example: "at least 90 % over 30 days, at least 20 cases",
  },
  spend_usd: {
    label: "Spend",
    unit: "USD",
    measures: "What the use case's agents and project spent, from the usage ledger. A call with no price makes the spend unknown, so it cannot pass.",
    sample: "one priced call",
    example: "at most 500 USD over 30 days, at least 1 call",
  },
  pack_control_evidenced: {
    label: "Pack control evidenced",
    unit: "yes/no",
    measures: "Whether one control of an active compliance pack is evidenced for the use case's project: 1 when the evidence meets the control's minimum, otherwise 0. An attestation is not evidence.",
    sample: "one piece of collected evidence",
    example: "equal to 1 over 30 days, at least 1 piece of evidence",
  },
};

/** the detectors a guardrail-mode condition may name (PII has its own path) */
export const GUARDRAIL_DETECTORS = [
  { id: "prompt_injection", label: "Prompt injection" },
  { id: "jailbreak", label: "Jailbreak" },
  { id: "toxicity", label: "Toxicity" },
  { id: "semantic_dlp", label: "Semantic data loss prevention" },
] as const;

export interface MetricConditionDraft {
  key: string;
  metric: MetricId;
  operator: Operator;
  threshold: string;
  windowDays: string;
  minSamples: string;
  cadence: Cadence;
  onBreach: OnBreach;
  blocking: boolean;
  /** guardrail_mode */
  detector: string;
  /** pack_control_evidenced */
  framework: string;
  controlRef: string;
}

let seq = 0;
export const blankMetricCondition = (): MetricConditionDraft => ({
  key: `m${++seq}`,
  metric: "error_rate",
  operator: "lt",
  threshold: "5",
  windowDays: "7",
  minSamples: "50",
  cadence: "daily",
  onBreach: "alert",
  blocking: true,
  detector: "prompt_injection",
  framework: "",
  controlRef: "",
});

export type MetricConditionErrors = Partial<Record<"threshold" | "windowDays" | "minSamples" | "framework" | "controlRef", string>>;

const int = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN);

export function validateMetricCondition(d: MetricConditionDraft): MetricConditionErrors {
  const e: MetricConditionErrors = {};
  if (d.threshold.trim() === "" || !Number.isFinite(Number(d.threshold))) e.threshold = "Enter a number.";
  const w = int(d.windowDays);
  if (!(w >= 1 && w <= 90)) e.windowDays = "Between 1 and 90 days.";
  const m = int(d.minSamples);
  if (!(m >= 1 && m <= 100_000)) e.minSamples = "Between 1 and 100,000.";
  if (d.metric === "pack_control_evidenced") {
    if (!d.framework.trim()) e.framework = "Name the pack's framework.";
    if (!d.controlRef.trim()) e.controlRef = "Name the control reference.";
  }
  return e;
}

export const hasMetricErrors = (e: MetricConditionErrors) => Object.values(e).some(Boolean);

/** "Error rate below 5 % over 7 days (at least 50 samples)" — also the condition's text */
export function describeMetricDraft(d: Pick<MetricConditionDraft, "metric" | "operator" | "threshold" | "windowDays" | "minSamples" | "detector" | "framework" | "controlRef">): string {
  const h = METRIC_HELP[d.metric];
  const what =
    d.metric === "guardrail_mode"
      ? `${h.label} (${GUARDRAIL_DETECTORS.find((x) => x.id === d.detector)?.label ?? d.detector})`
      : d.metric === "pack_control_evidenced" && d.controlRef.trim()
        ? `${h.label} (${d.framework.trim()} ${d.controlRef.trim()})`
        : h.label;
  const unit = h.unit === "%" ? " %" : ` ${h.unit}`;
  const days = Number(d.windowDays.trim());
  const min = Number(d.minSamples.trim());
  return `${what} ${OPERATOR_LABEL[d.operator]} ${d.threshold.trim()}${unit} over ${days} day${days === 1 ? "" : "s"} (at least ${min} sample${min === 1 ? "" : "s"})`;
}

export interface MeasuredConditionBody {
  kind: "metric";
  text: string;
  blocking: boolean;
  metric: MetricId;
  params: Record<string, string>;
  operator: Operator;
  threshold: number;
  windowDays: number;
  minSamples: number;
  cadence: Cadence;
  onBreach: OnBreach;
}

/** the exact condition the decide route receives for a draft that validated */
export function metricConditionBody(d: MetricConditionDraft): MeasuredConditionBody {
  const params: Record<string, string> =
    d.metric === "guardrail_mode"
      ? { detector: d.detector }
      : d.metric === "pack_control_evidenced"
        ? { framework: d.framework.trim(), controlRef: d.controlRef.trim() }
        : {};
  return {
    kind: "metric",
    text: describeMetricDraft(d).slice(0, 500),
    blocking: d.blocking,
    metric: d.metric,
    params,
    operator: d.operator,
    threshold: Number(d.threshold),
    windowDays: int(d.windowDays),
    minSamples: int(d.minSamples),
    cadence: d.cadence,
    onBreach: d.onBreach,
  };
}

// ---------------------------------------------------------------------------
// The record's side: a measured condition's standing
// ---------------------------------------------------------------------------

export type MeasurementState = "pass" | "fail" | "insufficient" | "not_run";
export const MEASUREMENT_STATE_LABEL: Record<MeasurementState, string> = {
  pass: "Passing",
  fail: "Breached",
  insufficient: "Too few samples",
  not_run: "No data yet",
};
export const MEASUREMENT_STATE_TONE: Record<MeasurementState, "ok" | "danger" | "warn" | "neutral"> = {
  pass: "ok",
  fail: "danger",
  insufficient: "warn",
  not_run: "neutral",
};

/** where an evidence row can be looked at in the app */
export function evidenceHref(ref: { type: string; id: string }): string | null {
  switch (ref.type) {
    case "trace":
      return `/admin/traces?trace=${encodeURIComponent(ref.id)}`;
    case "trace_evaluation":
      return "/admin/traces";
    case "audit_log":
      return "/admin/audit";
    case "redteam_run":
      return "/admin/redteam";
    case "eval_run":
      return "/admin/evals";
    case "usage_event":
      return "/admin/cost";
    case "guardrail_policy":
      return "/admin/guardrails";
    case "compliance_pack_control":
      return "/admin/compliance-packs";
    default:
      return null;
  }
}

export const EVIDENCE_LABEL: Record<string, string> = {
  trace: "Trace",
  trace_evaluation: "Trace evaluation",
  audit_log: "Audit row",
  redteam_run: "Red-team run",
  eval_run: "Evaluation run",
  usage_event: "Usage record",
  guardrail_policy: "Guardrail setting",
  compliance_pack_control: "Pack control",
};

/** the measured fields `GET /v1/use-cases/:id` adds to each condition (absent
 * from an older gateway — read as a manual condition) */
export interface MeasuredConditionFields {
  kind?: "manual" | "metric" | "test_class" | "autonomy_floor";
  metric?: string | null;
  spec?: string | null;
  onBreach?: OnBreach;
  lastValue?: number | null;
  lastSamples?: number | null;
  lastState?: MeasurementState | null;
  lastEvaluatedAt?: string | null;
  consecutiveBreaches?: number;
  evidence?: Array<{ type: string; id: string }>;
  waivedAt?: string | null;
  waivedByName?: string | null;
  waiveReason?: string | null;
}

export const isMeasured = (c: MeasuredConditionFields) => Boolean(c.kind && c.kind !== "manual");

export function formatMeasured(metric: string | null, value: number | null): string {
  if (value === null) return "—";
  const unit = metric && metric in METRIC_HELP ? METRIC_HELP[metric as MetricId].unit : "";
  const n = Number.isInteger(value) ? String(value) : value.toFixed(unit === "score" ? 3 : 2);
  return unit === "%" ? `${n} %` : unit ? `${n} ${unit}` : n;
}
