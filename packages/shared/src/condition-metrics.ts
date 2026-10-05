/**
 * ADR-0180 A2 (ADR-0175 batch D3) — MEASURABLE CONDITIONS: the pure half.
 *
 * The gateway measures a metric from the existing ledgers
 * (`apps/gateway/src/condition-metrics.ts`); this file holds what the gateway,
 * the gate and the SPA must agree on and what is testable without a database:
 *   - THE STATE RULE (`measurementStateFor`): no data is `not_run`, too few
 *     samples is `insufficient`, and neither is EVER `pass`;
 *   - the per-metric parameters a condition may narrow a metric with;
 *   - the plain-language help a reviewer reads when choosing a metric;
 *   - the cadence arithmetic the scheduler job uses;
 *   - the shapes of a measured condition on the use-case read.
 *
 * Does not import the package barrel (index.ts re-exports this file).
 */
import { z } from "zod";
import {
  ASSURANCE_DEFAULTS,
  ASSURANCE_METRICS,
  type AssuranceMetricId,
  type ConditionCadence,
  type ConditionKind,
  type ConditionOnBreach,
  type ConditionOperator,
  type EvidenceRef,
  type MeasurementState,
  type MetricSpec,
} from "./assurance.js";
import { GUARDRAIL_DETECTOR_IDS, type GuardrailMode } from "./guardrails.js";
import { RED_TEAM_ATTACK_CLASSES } from "./redteam.js";

// ---------------------------------------------------------------------------
// The state rule
// ---------------------------------------------------------------------------

/** does `value <operator> threshold` hold? */
export function conditionHolds(operator: ConditionOperator, value: number, threshold: number): boolean {
  switch (operator) {
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "eq":
      // a measured value is a float (a rate, a mean); equal within a hair
      return Math.abs(value - threshold) <= 1e-9 * Math.max(1, Math.abs(threshold));
  }
}

/**
 * THE ONE PLACE A MEASUREMENT'S STATE IS DECIDED. Read the branch order: no
 * data and too few samples return BEFORE the comparison is consulted, so
 * there is no path on which an under-sampled measurement reads `pass`.
 */
export function measurementStateFor(input: {
  value: number | null;
  samples: number;
  minSamples: number;
  operator: ConditionOperator;
  threshold: number;
}): MeasurementState {
  if (input.value === null || !Number.isFinite(input.value) || input.samples <= 0) return "not_run";
  if (input.samples < Math.max(1, input.minSamples)) return "insufficient";
  return conditionHolds(input.operator, input.value, input.threshold) ? "pass" : "fail";
}

// ---------------------------------------------------------------------------
// Metric parameters (what a condition may narrow a metric with)
// ---------------------------------------------------------------------------

/** the guardrail detectors a mode condition may name (PII has its own path) */
export const GUARDRAIL_MODE_DETECTORS = GUARDRAIL_DETECTOR_IDS.filter((d) => d !== "pii") as Array<
  Exclude<(typeof GUARDRAIL_DETECTOR_IDS)[number], "pii">
>;

/** `guardrail_mode` is measured as a level: off 0 < log 1 < warn 2 < block 3 */
export const GUARDRAIL_MODE_LEVEL: Readonly<Record<GuardrailMode, number>> = { off: 0, log: 1, warn: 2, block: 3 };

const GUARDRAIL_OUTCOMES = ["blocked", "warned", "logged"] as const;

export const METRIC_PARAMS_SCHEMAS: Readonly<Record<AssuranceMetricId, z.ZodTypeAny>> = {
  trace_eval_flag_rate: z.object({ detector: z.string().trim().min(1).max(64).optional() }).strict(),
  guardrail_hits: z.object({ outcome: z.enum(GUARDRAIL_OUTCOMES).optional() }).strict(),
  guardrail_mode: z.object({ detector: z.enum(GUARDRAIL_MODE_DETECTORS as [string, ...string[]]) }).strict(),
  redteam_asr: z.object({ attackClass: z.enum(RED_TEAM_ATTACK_CLASSES).optional() }).strict(),
  eval_mean_score: z.object({ datasetId: z.string().uuid().optional() }).strict(),
  eval_pass_rate: z.object({ datasetId: z.string().uuid().optional() }).strict(),
  spend_usd: z.object({}).strict(),
  error_rate: z.object({}).strict(),
  pack_control_evidenced: z
    .object({ framework: z.string().trim().min(1).max(120), controlRef: z.string().trim().min(1).max(120) })
    .strict(),
};

export type MetricParamsCheck =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; issues: Array<{ path: Array<string | number>; message: string }> };

/** validate a condition's `params` for its metric (the decide path refuses a bad one by name) */
export function validateMetricParams(metric: AssuranceMetricId, params: unknown): MetricParamsCheck {
  const r = METRIC_PARAMS_SCHEMAS[metric].safeParse(params ?? {});
  if (r.success) return { ok: true, params: r.data as Record<string, unknown> };
  return { ok: false, issues: r.error.issues.map((i) => ({ path: ["params", ...i.path], message: i.message })) };
}

// ---------------------------------------------------------------------------
// Plain-language help (the reviewer reads this when choosing a metric)
// ---------------------------------------------------------------------------

export interface ConditionMetricHelp {
  label: string;
  unit: string;
  /** what the number is, in one sentence */
  measures: string;
  /** what one sample is — the minimum-samples field counts these */
  sample: string;
  /** what the optional/required parameters narrow, or null */
  params: string | null;
  /** a sensible starting condition, shown as a hint */
  example: string;
}

export const CONDITION_METRIC_HELP: Readonly<Record<AssuranceMetricId, ConditionMetricHelp>> = {
  trace_eval_flag_rate: {
    label: ASSURANCE_METRICS.trace_eval_flag_rate.label,
    unit: "%",
    measures:
      "The share of the use case's model responses that continuous trace evaluation flagged (personal data, " +
      "credentials, toxicity or injection attempts), over the window.",
    sample: "one evaluated response",
    params: "Optionally one detector, so only its findings count.",
    example: "below 2 % over 7 days, at least 100 responses",
  },
  guardrail_hits: {
    label: ASSURANCE_METRICS.guardrail_hits.label,
    unit: "hits",
    measures:
      "How many times a guardrail blocked, warned on or logged one of the use case's calls over the window " +
      "(read from the audit log).",
    sample: "one governed model call in the window (so zero hits over real traffic can pass)",
    params: "Optionally one outcome: blocked, warned or logged.",
    example: "at most 0 blocked hits over 7 days, at least 50 calls",
  },
  guardrail_mode: {
    label: ASSURANCE_METRICS.guardrail_mode.label,
    unit: "level",
    measures:
      "The weakest mode one guardrail detector is set to across the use case's agents, as a level: off 0, log 1, " +
      "warn 2, block 3.",
    sample: "one agent's resolved guardrail configuration",
    params: "Required: the detector (prompt injection, jailbreak, toxicity or semantic DLP).",
    example: "prompt injection at least 3 (block)",
  },
  redteam_asr: {
    label: ASSURANCE_METRICS.redteam_asr.label,
    unit: "%",
    measures:
      "The attack success rate of the newest completed red-team run of each of the use case's agents in the " +
      "window, judged on the weakest agent in the stack (the highest rate; the fewest trials count as the " +
      "samples). Only the use case's own agents count; one with no run, or whose newest run measured nothing " +
      "for the class, makes the result insufficient, never a pass.",
    sample: "one usable probe trial",
    params: "Optionally one attack class.",
    example: "below 5 % over 30 days, at least 30 trials",
  },
  eval_mean_score: {
    label: ASSURANCE_METRICS.eval_mean_score.label,
    unit: "score",
    measures:
      "The mean score (0 to 1) of the newest completed evaluation run of each of the use case's agents in the " +
      "window, judged on the weakest agent in the stack (the lowest score; the fewest cases count as the " +
      "samples). Red-team runs are not counted here. An agent with no scored run makes the result insufficient.",
    sample: "one scored evaluation case",
    params: "Optionally one evaluation dataset.",
    example: "at least 0.8 over 30 days, at least 20 cases",
  },
  eval_pass_rate: {
    label: ASSURANCE_METRICS.eval_pass_rate.label,
    unit: "%",
    measures:
      "The share of cases that passed in the newest completed evaluation run of each of the use case's agents in " +
      "the window, judged on the weakest agent in the stack (the lowest pass rate; the fewest cases count as " +
      "the samples). An agent whose newest run has no cases makes the result insufficient.",
    sample: "one scored evaluation case",
    params: "Optionally one evaluation dataset.",
    example: "at least 90 % over 30 days, at least 20 cases",
  },
  spend_usd: {
    label: ASSURANCE_METRICS.spend_usd.label,
    unit: "USD",
    measures:
      "What the use case's agents and project spent over the window, from the usage ledger. If any call in the " +
      "window has no price, the spend is unknown and the result is insufficient.",
    sample: "one priced call",
    params: null,
    example: "at most 500 USD over 30 days, at least 1 call",
  },
  error_rate: {
    label: ASSURANCE_METRICS.error_rate.label,
    unit: "%",
    measures: "The share of the use case's finished traces that ended in an error, over the window.",
    sample: "one finished trace",
    params: null,
    example: "below 5 % over 7 days, at least 50 traces",
  },
  pack_control_evidenced: {
    label: ASSURANCE_METRICS.pack_control_evidenced.label,
    unit: "yes/no",
    measures:
      "Whether one control of an active compliance pack is evidenced for the use case's project over the window: " +
      "1 when the evidence meets the control's minimum, otherwise 0. An attestation is not evidence.",
    sample: "one piece of collected evidence",
    params: "Required: the pack's framework and the control reference.",
    example: "equal to 1 over 30 days, at least 1 piece of evidence",
  },
};

export const CONDITION_OPERATOR_LABEL: Readonly<Record<ConditionOperator, string>> = {
  lt: "below",
  lte: "at most",
  gt: "above",
  gte: "at least",
  eq: "equal to",
};

/** "Error rate below 5 % over 7 days (at least 50 samples)" */
export function describeMetricCondition(spec: Pick<MetricSpec, "metric" | "operator" | "threshold" | "windowDays" | "minSamples">): string {
  const h = CONDITION_METRIC_HELP[spec.metric];
  return (
    `${h.label} ${CONDITION_OPERATOR_LABEL[spec.operator]} ${spec.threshold}${h.unit === "%" ? " %" : ` ${h.unit}`} ` +
    `over ${spec.windowDays} day${spec.windowDays === 1 ? "" : "s"} (at least ${spec.minSamples} sample${spec.minSamples === 1 ? "" : "s"})`
  );
}

// ---------------------------------------------------------------------------
// Cadence, actors and subjects
// ---------------------------------------------------------------------------

export const CONDITION_CADENCE_SECONDS: Readonly<Record<ConditionCadence, number>> = {
  hourly: 3600,
  daily: 86_400,
  weekly: 7 * 86_400,
};

/** the scheduler runs every few minutes; a condition is due a little early
 * rather than a whole pass late */
export const CONDITION_DUE_SLACK_SECONDS = 5 * 60;

export function conditionEvaluationDue(lastEvaluatedAt: Date | null, cadence: ConditionCadence | null, now: Date): boolean {
  if (!lastEvaluatedAt) return true;
  const every = CONDITION_CADENCE_SECONDS[cadence ?? "daily"];
  return now.getTime() - lastEvaluatedAt.getTime() >= (every - CONDITION_DUE_SLACK_SECONDS) * 1000;
}

/** the audit actor of an evaluation the scheduler (or an admin's "evaluate now") ran */
export const CONDITION_EVALUATOR_ACTOR = "system:condition-evaluator";

/** how many consecutive breached evaluations of a `reopen_review` condition reopen review */
export const CONDITION_REOPEN_AFTER = ASSURANCE_DEFAULTS.reopenAfterConsecutiveBreaches;

/** the monitor subject of one condition (`condition_metric_breached`) */
export const conditionSubjectKey = (useCaseId: string, conditionId: string) => `use_case:${useCaseId}>condition:${conditionId}`;

/** a measured breach counts toward the streak; a pass ends it; too few samples
 * or no data HOLD it (neither a breach nor a pass) */
export function nextConsecutiveBreaches(previous: number, state: MeasurementState): number {
  if (state === "fail") return previous + 1;
  if (state === "pass") return 0;
  return previous;
}

// ---------------------------------------------------------------------------
// The measured fields of a condition as the use-case read returns it
// ---------------------------------------------------------------------------

export interface MeasuredConditionFields {
  kind: ConditionKind;
  /** null for a manual condition */
  metric: AssuranceMetricId | null;
  params: Record<string, unknown>;
  operator: ConditionOperator | null;
  threshold: number | null;
  windowDays: number | null;
  minSamples: number | null;
  cadence: ConditionCadence | null;
  onBreach: ConditionOnBreach;
  /** plain words for the spec, e.g. "Error rate below 5 % over 7 days (at least 50 samples)" */
  spec: string | null;
  lastValue: number | null;
  lastSamples: number | null;
  lastState: MeasurementState | null;
  /** ISO */
  lastEvaluatedAt: string | null;
  consecutiveBreaches: number;
  evidence: EvidenceRef[];
  /** ISO */
  waivedAt: string | null;
  waivedByName: string | null;
  waiveReason: string | null;
}
