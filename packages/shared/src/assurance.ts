/**
 * ADR-0180 (ADR-0175 batch D3) — CONTINUOUS ASSURANCE: the shared contract.
 *
 * Four items build on this file, each in its own module:
 *   A2  measurable conditions        `measureAssuranceMetric`, `evaluateUseCaseConditions`
 *   A3  required AI test classes     `requiredTestConditionsFor`, and the deploy-gate composition
 *   A8  agent autonomy class         `autonomyFloorFor`
 *   A10 risk tolerance + acceptance  `residualPosition`
 *
 * This file holds only what they share: the vocabularies (kept in lockstep
 * with the DB CHECKs of migration 0155), the strict defaults, the types the
 * gate and the monitor exchange, and NO-OP defaults of the five interface
 * functions, so every branch builds before the others land. The no-ops report
 * "nothing measured", never "pass": an unimplemented check can never satisfy
 * anything.
 *
 * SECURE BY DEFAULT (ADR-0180 §1). Every setting here starts at its strict
 * value; an admin may relax it, and that change is audited. Nothing is
 * grandfathered.
 */
import { z } from "zod";
import type { ReviewPolicyTierKey } from "./review-policy.js";

// ---------------------------------------------------------------------------
// The enforcement setting
// ---------------------------------------------------------------------------

/** `org_settings.assurance_gate_mode`: how the deploy gate treats the D3
 * checks. `enforce` holds the gate; `warn` reports them without holding;
 * `off` skips them and the gate response says they were skipped. */
export const ASSURANCE_GATE_MODES = ["off", "warn", "enforce"] as const;
export type AssuranceGateMode = (typeof ASSURANCE_GATE_MODES)[number];
export const assuranceGateModeSchema = z.enum(ASSURANCE_GATE_MODES);

/** `PUT /v1/org/settings/assurance-gate-mode` */
export const setAssuranceGateModeSchema = z.object({ mode: assuranceGateModeSchema }).strict();
export type SetAssuranceGateModeInput = z.infer<typeof setAssuranceGateModeSchema>;

// ---------------------------------------------------------------------------
// The strict defaults
// ---------------------------------------------------------------------------

export const ASSURANCE_DEFAULTS = {
  /** the deploy gate holds on the D3 checks unless an admin relaxes it */
  gateMode: "enforce",
  /** a required test run older than this is stale */
  requiredTestFreshnessDays: 30,
  /** the most an admin may relax freshness to */
  requiredTestFreshnessMaxDays: 90,
  /** the longest an acceptance of high or critical residual risk may run */
  acceptanceMaxMonthsHighCritical: 6,
  /** the longest any other acceptance may run */
  acceptanceMaxMonthsOther: 12,
  /** with no tolerance row, residual risk above this band needs a valid acceptance */
  toleranceMaxBand: "medium",
  /** a breach reopens review only after this many consecutive breached evaluations
   * (and only where the condition says `on_breach = reopen_review`) */
  reopenAfterConsecutiveBreaches: 2,
} as const satisfies {
  gateMode: AssuranceGateMode;
  requiredTestFreshnessDays: number;
  requiredTestFreshnessMaxDays: number;
  acceptanceMaxMonthsHighCritical: number;
  acceptanceMaxMonthsOther: number;
  toleranceMaxBand: ToleranceBand;
  reopenAfterConsecutiveBreaches: number;
};

export const DEFAULT_ASSURANCE_GATE_MODE: AssuranceGateMode = ASSURANCE_DEFAULTS.gateMode;

export const ASSURANCE_LIMITS = {
  maxWindowDays: 90,
  maxMinSamples: 100_000,
  maxConditionTextChars: 500,
  maxWaiveReasonChars: 2000,
  maxAutonomyNoteChars: 2000,
  maxRationaleChars: 4000,
  maxCompensatingControls: 20,
} as const;

// ---------------------------------------------------------------------------
// Metrics (A2 measures them; A3, A8 and A10 reuse the measurement)
// ---------------------------------------------------------------------------

/** Every metric reads an EXISTING ledger. `samples` names what one sample is. */
export const ASSURANCE_METRICS = {
  trace_eval_flag_rate: {
    label: "Trace evaluation flag rate",
    unit: "%",
    samples: "evaluated responses",
    ledger: "continuous trace evaluation (ADR-0160)",
  },
  guardrail_hits: {
    label: "Guardrail hits",
    unit: "hits",
    samples: "guardrail hit rows in the window",
    ledger: "audit_log guardrail-blocked / -warned / -logged rows",
  },
  guardrail_mode: {
    label: "Guardrail mode",
    unit: "level",
    samples: "the guardrail configuration",
    ledger: "guardrail settings",
  },
  redteam_asr: {
    label: "Red-team attack success rate",
    unit: "%",
    samples: "probes run",
    ledger: "redteam_runs",
  },
  eval_mean_score: {
    label: "Evaluation mean score",
    unit: "score",
    samples: "scored results",
    ledger: "eval_runs / eval_results",
  },
  eval_pass_rate: {
    label: "Evaluation pass rate",
    unit: "%",
    samples: "scored results",
    ledger: "eval_runs / eval_results",
  },
  spend_usd: {
    label: "Spend",
    unit: "USD",
    samples: "priced usage events",
    ledger: "usage_events",
  },
  error_rate: {
    label: "Error rate",
    unit: "%",
    samples: "finished traces",
    ledger: "traces",
  },
  pack_control_evidenced: {
    label: "Pack control evidenced",
    unit: "yes/no",
    samples: "the control's evidence",
    ledger: "compliance pack evidence",
  },
  // ADR-0182 (D4) A13 — measured from the feedback register. Until A13 lands
  // the gateway measures both as `not_run` (never a pass).
  user_report_rate: {
    label: "User problem reports per 1,000 traces",
    unit: "per 1k",
    samples: "finished traces",
    ledger: "use_case_feedback (problem reports) over traces",
  },
  appeal_overturn_rate: {
    label: "Appeal overturn rate",
    unit: "%",
    samples: "resolved appeals",
    ledger: "use_case_feedback (appeals upheld or overturned)",
  },
} as const;
export type AssuranceMetricId = keyof typeof ASSURANCE_METRICS;
export const ASSURANCE_METRIC_IDS = Object.keys(ASSURANCE_METRICS) as [AssuranceMetricId, ...AssuranceMetricId[]];

/** `manual` is the ADR-0168 free-text condition; the rest are measured */
export const CONDITION_KINDS = ["manual", "metric", "test_class", "autonomy_floor"] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];
export const MEASURED_CONDITION_KINDS = ["metric", "test_class", "autonomy_floor"] as const;
export type MeasuredConditionKind = (typeof MEASURED_CONDITION_KINDS)[number];

/** a condition PASSES when `value <operator> threshold` holds */
export const CONDITION_OPERATORS = ["lt", "lte", "gt", "gte", "eq"] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export const CONDITION_CADENCES = ["hourly", "daily", "weekly"] as const;
export type ConditionCadence = (typeof CONDITION_CADENCES)[number];

/** `alert` (default): a breach raises a monitor alert. `reopen_review`: two
 * consecutive breached evaluations also reopen review. */
export const CONDITION_ON_BREACH = ["alert", "reopen_review"] as const;
export type ConditionOnBreach = (typeof CONDITION_ON_BREACH)[number];

/** `insufficient` (too few samples) and `not_run` (nothing measured) are never a pass */
export const MEASUREMENT_STATES = ["pass", "fail", "insufficient", "not_run"] as const;
export type MeasurementState = (typeof MEASUREMENT_STATES)[number];

export interface MetricSpec {
  metric: AssuranceMetricId;
  /** metric-specific narrowing, e.g. a detector, an OWASP test class, a dataset or a control ref */
  params: Record<string, unknown>;
  operator: ConditionOperator;
  threshold: number;
  windowDays: number;
  minSamples: number;
}

export const metricSpecSchema = z
  .object({
    metric: z.enum(ASSURANCE_METRIC_IDS),
    params: z.record(z.unknown()).default({}),
    operator: z.enum(CONDITION_OPERATORS),
    threshold: z.number().finite(),
    windowDays: z.number().int().min(1).max(ASSURANCE_LIMITS.maxWindowDays),
    minSamples: z.number().int().min(1).max(ASSURANCE_LIMITS.maxMinSamples),
  })
  .strict();

/** what a measurement is scoped to: the use case's project and its agent stack */
export interface AssuranceScope {
  projectId: string | null;
  agentIds: string[];
}

/** a pointer at the ledger row a measurement rests on */
export interface EvidenceRef {
  type: string;
  id: string;
}

export interface Measurement {
  value: number | null;
  samples: number;
  state: MeasurementState;
  evidence: EvidenceRef[];
}

/** the measurement every no-op returns: nothing was measured, so nothing passes */
export const NOT_RUN_MEASUREMENT: Readonly<Measurement> = Object.freeze({
  value: null,
  samples: 0,
  state: "not_run",
  evidence: [],
});

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/** A condition's due date: a calendar date (`YYYY-MM-DD`, due at the END of
 * that day, UTC) or a full ISO-8601 timestamp (ADR-0168). The one definition;
 * `approvalConditionSchema` uses it too. */
export const conditionDueAtSchema = z
  .string()
  .refine(
    (v) =>
      /^\d{4}-\d{2}-\d{2}$/.test(v)
        ? !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v)
        : z.string().datetime({ offset: true }).safeParse(v).success,
    { message: "dueAt must be a date (YYYY-MM-DD) or an ISO-8601 timestamp" },
  );

/** a MEASURED condition as imposed (decide path) or generated (required tests,
 * autonomy floors). Its fields map one-to-one onto `use_case_conditions`. */
export const measuredConditionInputSchema = z
  .object({
    kind: z.enum(MEASURED_CONDITION_KINDS),
    text: z.string().trim().min(1).max(ASSURANCE_LIMITS.maxConditionTextChars),
    ownerUserId: z.string().uuid().optional(),
    /** absent = the imposing path chooses (a generated condition has no natural due date) */
    dueAt: conditionDueAtSchema.optional(),
    blocking: z.boolean(),
    metric: z.enum(ASSURANCE_METRIC_IDS),
    params: z.record(z.unknown()).default({}),
    operator: z.enum(CONDITION_OPERATORS),
    threshold: z.number().finite(),
    windowDays: z.number().int().min(1).max(ASSURANCE_LIMITS.maxWindowDays),
    minSamples: z.number().int().min(1).max(ASSURANCE_LIMITS.maxMinSamples),
    cadence: z.enum(CONDITION_CADENCES).default("daily"),
    onBreach: z.enum(CONDITION_ON_BREACH).default("alert"),
  })
  .strict();
export type MeasuredConditionInput = z.infer<typeof measuredConditionInputSchema>;

/** the ADR-0168 free-text condition, named as a kind */
export interface ManualConditionInput {
  kind: "manual";
  text: string;
  ownerUserId?: string;
  dueAt: string;
  blocking: boolean;
}
export type ConditionInput = ManualConditionInput | MeasuredConditionInput;

/** `POST /v1/use-cases/:useCaseId/conditions/:conditionId/waive` (admin, audited) */
export const waiveConditionSchema = z
  .object({ reason: z.string().trim().min(1).max(ASSURANCE_LIMITS.maxWaiveReasonChars) })
  .strict();
export type WaiveConditionInput = z.infer<typeof waiveConditionSchema>;

/** One condition's standing. A waived condition reads `waived` — a gate
 * WARNING, never a pass. A manual one reads `manual` (its status says open or met). */
export interface ConditionVerdict {
  conditionId: string;
  useCaseId: string;
  kind: ConditionKind;
  text: string;
  blocking: boolean;
  status: "open" | "met" | "waived";
  state: MeasurementState | "manual" | "waived";
  /** null for a manual or waived condition */
  measurement: Measurement | null;
  onBreach: ConditionOnBreach;
  consecutiveBreaches: number;
  /** ISO; null = never evaluated */
  evaluatedAt: string | null;
}

// ---------------------------------------------------------------------------
// Required AI test classes (A3)
// ---------------------------------------------------------------------------

export interface RequiredTestClass {
  /** an OWASP LLM or agentic id from the vendored table — never invented */
  testClass: string;
  /** red-team ASR at most this (percent) */
  maxAsr?: number;
  /** eval mean score at least this */
  minScore?: number;
}

export interface RequiredTestTierPolicy {
  classes: RequiredTestClass[];
  /** default ASSURANCE_DEFAULTS.requiredTestFreshnessDays, at most requiredTestFreshnessMaxDays */
  freshnessDays: number;
}

/** `governance_review_policy.required_tests`: absent tier = the strict code default */
export type RequiredTestPolicy = Partial<Record<ReviewPolicyTierKey, RequiredTestTierPolicy>>;

export const REQUIRED_TEST_STATES = ["satisfied", "missing", "stale", "failing", "not_run"] as const;
export type RequiredTestState = (typeof REQUIRED_TEST_STATES)[number];

/** one (test class, agent) requirement as the gate reads it */
export interface RequiredTestStatus {
  testClass: string;
  agentId: string | null;
  state: RequiredTestState;
  runId: string | null;
  /** ISO */
  completedAt: string | null;
  value: number | null;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Agent autonomy class (A8)
// ---------------------------------------------------------------------------

/** Ordered, least to most autonomous. Kept in lockstep with
 * `builder_agents_autonomy_class_ck` (migration 0155). */
export const AUTONOMY_CLASSES = ["assist", "supervised", "delegated", "autonomous"] as const;
export type AutonomyClass = (typeof AUTONOMY_CLASSES)[number];

export const AUTONOMY_CLASS_INFO: Readonly<Record<AutonomyClass, { level: 1 | 2 | 3 | 4; label: string; description: string }>> = {
  assist: {
    level: 1,
    label: "Assistant",
    description: "Answers when a person asks. It takes no action on its own.",
  },
  supervised: {
    level: 2,
    label: "Supervised",
    description: "Uses tools, but asks a person first before anything that changes data.",
  },
  delegated: {
    level: 3,
    label: "Delegated",
    description: "Acts within limits without asking: changes data, uses a computer or hands work to other agents.",
  },
  autonomous: {
    level: 4,
    label: "Autonomous",
    description: "Runs unattended: starts work on a schedule or from incoming messages.",
  },
};

/** the observed facts the class is derived from */
export interface AutonomyFacts {
  schedules: number;
  subAgents: number;
  writeToolsWithoutAskFirst: number;
  inboundChannels: number;
  computerUse: boolean;
}

export interface AutonomyFloorResult {
  /** over the use case's builder agents (joined through the shared project) */
  facts: AutonomyFacts;
  /** null = the use case has no builder agent */
  derived: AutonomyClass | null;
  declared: AutonomyClass | null;
  /** the floor's controls not in place, as conditions */
  unmet: ConditionInput[];
}

// ---------------------------------------------------------------------------
// Risk tolerance and time-boxed acceptance (A10)
// ---------------------------------------------------------------------------

/** the residual band of a risk. (`RiskBand` is the dependency graph's own
 * none/low/medium/high scale; this one adds `critical`.) */
export const RESIDUAL_RISK_BANDS = ["low", "medium", "high", "critical"] as const;
export type ResidualRiskBand = (typeof RESIDUAL_RISK_BANDS)[number];

/** the most a tolerance may allow; `none` = every residual risk needs an acceptance */
export const TOLERANCE_BANDS = ["none", ...RESIDUAL_RISK_BANDS] as const;
export type ToleranceBand = (typeof TOLERANCE_BANDS)[number];

export const RISK_TOLERANCE_SCOPE_KINDS = ["category", "tier"] as const;
export type RiskToleranceScopeKind = (typeof RISK_TOLERANCE_SCOPE_KINDS)[number];

export const RISK_RESPONSE_TYPES = ["accept", "mitigate_partially", "transfer", "avoid_pending"] as const;
export type RiskResponseType = (typeof RISK_RESPONSE_TYPES)[number];

/** the longest an acceptance at this residual band may run, in calendar months */
export function maxAcceptanceMonths(band: ResidualRiskBand): number {
  return band === "high" || band === "critical"
    ? ASSURANCE_DEFAULTS.acceptanceMaxMonthsHighCritical
    : ASSURANCE_DEFAULTS.acceptanceMaxMonthsOther;
}

export interface RiskAcceptanceSummary {
  id: string;
  responseType: RiskResponseType;
  residualBand: ResidualRiskBand;
  acceptedByUserId: string | null;
  /** ISO */
  acceptedAt: string;
  /** ISO */
  expiresAt: string;
}

export interface ResidualPosition {
  riskId: string;
  /** null = no residual position declared */
  band: ResidualRiskBand | null;
  tolerance: { band: ToleranceBand; source: "default" | "category" | "tier" };
  /** the live (unexpired, unsuperseded, unrevoked) acceptance, if any */
  acceptance: RiskAcceptanceSummary | null;
  aboveTolerance: boolean;
}

// ---------------------------------------------------------------------------
// The deploy gate's optional inputs (A3 composes them; ADR-0161 gate)
// ---------------------------------------------------------------------------

/** `DeployGateInput` extends this. Every field is optional: absent = that
 * check was not gathered, which the gate reports rather than passing. */
export interface DeployGateAssuranceInput {
  assuranceMode?: AssuranceGateMode;
  conditionVerdicts?: readonly ConditionVerdict[];
  requiredTests?: readonly RequiredTestStatus[];
  autonomy?: AutonomyFloorResult | null;
  residualRisks?: readonly ResidualPosition[];
}

// ---------------------------------------------------------------------------
// The five interface functions, and their no-op defaults
// ---------------------------------------------------------------------------
//
// `D` is the gateway's database handle; this package does not depend on the
// DB package, so the handle is a type parameter.

export type MeasureAssuranceMetricFn<D = unknown> = (
  db: D,
  spec: MetricSpec,
  scope: AssuranceScope,
  now: Date,
) => Promise<Measurement>;
export type EvaluateUseCaseConditionsFn<D = unknown> = (
  db: D,
  useCaseId: string,
  now: Date,
  opts: { persist: boolean },
) => Promise<ConditionVerdict[]>;
export type RequiredTestConditionsForFn = (
  tier: ReviewPolicyTierKey,
  policy: RequiredTestPolicy,
) => MeasuredConditionInput[];
export type AutonomyFloorForFn<D = unknown> = (
  db: D,
  useCase: { id: string; projectId: string | null },
) => Promise<AutonomyFloorResult>;
export type ResidualPositionFn<D = unknown> = (
  db: D,
  useCaseId: string,
  now: Date,
) => Promise<ResidualPosition[]>;

export const NO_AUTONOMY_FACTS: Readonly<AutonomyFacts> = Object.freeze({
  schedules: 0,
  subAgents: 0,
  writeToolsWithoutAskFirst: 0,
  inboundChannels: 0,
  computerUse: false,
});

/** no-op: nothing measured (`not_run`), never a pass */
export const noopMeasureAssuranceMetric: MeasureAssuranceMetricFn = async () => ({ ...NOT_RUN_MEASUREMENT, evidence: [] });
/** no-op: no verdicts */
export const noopEvaluateUseCaseConditions: EvaluateUseCaseConditionsFn = async () => [];
/** no-op: no required tests */
export const noopRequiredTestConditionsFor: RequiredTestConditionsForFn = () => [];
/** no-op: no facts, nothing derived, nothing unmet */
export const noopAutonomyFloorFor: AutonomyFloorForFn = async () => ({
  facts: { ...NO_AUTONOMY_FACTS },
  derived: null,
  declared: null,
  unmet: [],
});
/** no-op: no residual positions */
export const noopResidualPosition: ResidualPositionFn = async () => [];
