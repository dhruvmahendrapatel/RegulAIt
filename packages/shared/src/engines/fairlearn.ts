/**
 * ADR-0346 — THE FAIRLEARN ENGINE'S CONTRACT, as data and schemas: what the gateway, the runner and the task agree on.
 *
 * A fairness evaluation run (ADR-0346 decisions 4–5) is an ADR-0187 engine run of kind `eval` against the card's
 * agent. Its config names one set and one param:
 *
 *   sets:   ["fairlearn:group-metrics"]
 *   params: { evaluationId: "<uuid>" }
 *
 * THE INPUT. The gateway (never the runner) builds the task's one data file, `fairness-input.json`, from the
 * evaluation and its encrypted dataset when the task starts, and pins its sha256 on the run (the ADR-0242 subject-file
 * pattern): the runner never sees the rows. Each row carries the prompt the gateway rendered from the evaluation's
 * template, the true label and the row's protected groups.
 *
 * THE TASK. In the sandbox (no network but the gateway channel), for each row it calls the card's model through the
 * gateway's OpenAI-compatible chat route with the run's key, maps the reply exactly (`mapFairnessReply`: trim and
 * case-fold, no judge), keeps the parseable rows, applies ADR-0222's small-group suppression (`suppressSmallGroups`,
 * the same function the gateway runs) and computes the four group metrics with fairlearn's MetricFrame
 * (`engines/fairlearn/fairlearn_metrics.py`). It returns each row's mapped prediction and fairlearn's values, never a
 * reply's text.
 *
 * THE GATEWAY then recomputes the metrics with `computeFairness` on the same predictions and records the run only when
 * both agree (`fairlearnAgrees`); anything else is `inconclusive`. Pure: no I/O.
 */
import { z } from "zod";
import { FAIRNESS_LIMITS, FAIRNESS_METRICS, type FairnessMetric } from "../fairness.js";
import { FAIRNESS_EVALUATION_LIMITS } from "../fairness-evaluation.js";
import type { EngineSetClass } from "./manifest.js";

/** the fairlearn release the image is built from (engines/fairlearn/requirements.txt pins the same) */
export const FAIRLEARN_ENGINE_VERSION = "0.15.0";

/** the one set a fairness evaluation run names */
export const FAIRLEARN_SET = "fairlearn:group-metrics";

/** the vocabulary name in `sourceTaxonomy.system` for every fairlearn item */
export const FAIRLEARN_TAXONOMY_SYSTEM = "fairlearn";

/**
 * The switches the worker sets on the metric process, each at the value the self-test requires. fairlearn and its
 * closure have no telemetry or update check (source review of 0.15.0); these close the generic ones. Network denial
 * stays the real control.
 */
export const FAIRLEARN_USAGE_DATA_ENV: Readonly<Record<string, string>> = Object.freeze({
  OTEL_SDK_DISABLED: "true",
  DO_NOT_TRACK: "1",
  PYTHONDONTWRITEBYTECODE: "1",
});

/** as garak's (ADR-0187 decision 141): the switch the runner derives from the worker's own fresh self-test */
export const FAIRLEARN_WORKER_SELF_TEST_SWITCH = "REGULAIT_FAIRLEARN_WORKER_SELFTEST";

/** the manifest's set classes: the one set is a standard evaluation (no offensive content) */
export function fairlearnManifestSets(): Readonly<Record<string, EngineSetClass>> {
  return { [FAIRLEARN_SET]: "standard" };
}

/** the taxonomy rows (none: a fairness item maps to no red-team attack class or scorer) */
export function fairlearnTaxonomyEntries(): never[] {
  return [];
}

/**
 * The bounds of one model run. A model run makes one gateway call per row, so its rows are bounded far below
 * ADR-0222's upload bound; the prompt bound keeps the gateway-built input file inside the task's input budget.
 */
export const FAIRLEARN_LIMITS = {
  maxRows: 2000,
  maxPromptChars: 16_000,
  /** the gateway-built input file, at most (checked when it is built: a larger one ends the run `not_run`) */
  maxInputBytes: 8 * 1024 * 1024,
  /** the task's result file, at most */
  maxResultBytes: 2 * 1024 * 1024,
  /** a reply longer than this is unparseable without being read further (the outputs are at most 200 chars) */
  maxReplyChars: 4000,
  /** the tokens each call asks for: enough for a one-word decision, never an essay */
  maxTokens: 16,
} as const;

/** the run params a fairlearn run accepts; anything else is refused at creation (422 `engine_config_invalid`) */
export const FAIRLEARN_RUN_PARAMS: readonly string[] = Object.freeze(["evaluationId"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** what is wrong with a run's config for fairlearn, or null */
export function fairlearnConfigProblem(config: { sets: readonly string[]; params?: Readonly<Record<string, unknown>> }): string | null {
  if (config.sets.length !== 1 || config.sets[0] !== FAIRLEARN_SET) return `a fairlearn run names exactly the set ${FAIRLEARN_SET}`;
  const params = config.params ?? {};
  const extra = Object.keys(params).filter((k) => !FAIRLEARN_RUN_PARAMS.includes(k));
  if (extra.length > 0) return `fairlearn takes only the evaluationId param (got: ${extra.sort().join(", ")})`;
  const id = params.evaluationId;
  if (typeof id !== "string" || !UUID.test(id)) return "a fairlearn run needs params.evaluationId, the evaluation's id";
  return null;
}

/** the evaluation a fairlearn run's config names (call after `fairlearnConfigProblem` returned null) */
export function fairlearnEvaluationIdOf(config: { params?: Readonly<Record<string, unknown>> }): string {
  return String(config.params?.evaluationId);
}

// ---------------------------------------------------------------------------
// The gateway-built input file
// ---------------------------------------------------------------------------

/** the input file's name, at the task input's root */
export const FAIRLEARN_INPUT_FILE = "fairness-input.json";
export const FAIRLEARN_INPUT_VERSION = "regulait.fairness-input.v1";
export const FAIRLEARN_RESULT_VERSION = "regulait.fairness-result.v1";

const outcome = z.union([z.literal(0), z.literal(1)]);
const group = z.string().min(1).max(FAIRNESS_LIMITS.maxCellChars);
const attributeName = z.string().min(1).max(FAIRNESS_LIMITS.maxCellChars);

export const fairlearnInputSchema = z
  .object({
    v: z.literal(FAIRLEARN_INPUT_VERSION),
    runId: z.string().regex(UUID),
    evaluationId: z.string().regex(UUID),
    prompts: z.array(z.string().min(1).max(FAIRLEARN_LIMITS.maxPromptChars)).min(1).max(FAIRLEARN_LIMITS.maxRows),
    labels: z.array(outcome).min(1).max(FAIRLEARN_LIMITS.maxRows),
    attributes: z.record(attributeName, z.array(group).max(FAIRLEARN_LIMITS.maxRows)),
    outputs: z
      .object({
        favourable: z.string().min(1).max(FAIRNESS_EVALUATION_LIMITS.maxOutputChars),
        unfavourable: z.string().min(1).max(FAIRNESS_EVALUATION_LIMITS.maxOutputChars),
      })
      .strict(),
    minGroupSize: z.number().int().min(FAIRNESS_LIMITS.minGroupSize.min).max(FAIRNESS_LIMITS.minGroupSize.max),
  })
  .strict()
  .refine((i) => i.labels.length === i.prompts.length, "one label per prompt")
  .refine((i) => {
    const names = Object.keys(i.attributes);
    return names.length >= 1 && names.length <= FAIRNESS_LIMITS.maxAttributes && names.every((n) => i.attributes[n]!.length === i.prompts.length);
  }, "one to five attributes, each with one group per prompt");
export type FairlearnInput = z.infer<typeof fairlearnInputSchema>;

// ---------------------------------------------------------------------------
// The task's result (carried back as the envelope's raw report, ADR-0242's side channel)
// ---------------------------------------------------------------------------

const metricValues = z
  .object(Object.fromEntries(FAIRNESS_METRICS.map((m) => [m, z.number().finite().nullable()])) as Record<FairnessMetric, z.ZodNullable<z.ZodNumber>>)
  .strict();

/** why a run produced no metrics (each a closed code; never free text from the model or the library) */
export const FAIRLEARN_RUN_PROBLEMS = [
  "input_invalid",
  "gateway_refused",
  "budget_exhausted",
  "timed_out",
  "cancelled",
  "metrics_failed",
  "too_few_parseable",
] as const;
export type FairlearnRunProblem = (typeof FAIRLEARN_RUN_PROBLEMS)[number];

export const fairlearnResultSchema = z
  .object({
    v: z.literal(FAIRLEARN_RESULT_VERSION),
    runId: z.string().regex(UUID),
    evaluationId: z.string().regex(UUID),
    /** the input file the task read, by sha256 (the gateway checks it is the one it placed) */
    inputSha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** per row, in input order: 1 favourable, 0 unfavourable, null unparseable or not answered */
    predictions: z.array(outcome.nullable()).max(FAIRLEARN_LIMITS.maxRows),
    /** the version fairlearn reported, or null when the metric step did not run */
    fairlearn: z.string().max(64).nullable(),
    /** fairlearn's values per attribute (null when the metric step did not run) */
    metrics: z.record(attributeName, metricValues).nullable(),
    problem: z.enum(FAIRLEARN_RUN_PROBLEMS).nullable(),
  })
  .strict();
export type FairlearnResult = z.infer<typeof fairlearnResultSchema>;

/** the tolerance within which fairlearn's value and `computeFairness`'s must agree (ADR-0346 decision 5) */
export const FAIRLEARN_AGREEMENT_TOLERANCE = 1e-9;

/**
 * Do fairlearn's values agree with the gateway's own, metric by metric? A metric the gateway could not compute (null:
 * a 0/0 rate, ADR-0222's deliberate divergence) is not compared: the gateway's null already makes the run
 * inconclusive. A metric the gateway computed but fairlearn did not is a disagreement.
 */
export function fairlearnAgrees(
  ours: Readonly<Record<string, Readonly<Record<FairnessMetric, number | null>>>>,
  theirs: Readonly<Record<string, Readonly<Record<FairnessMetric, number | null>>>> | null,
): { agrees: boolean; disagreements: Array<{ attribute: string; metric: FairnessMetric }> } {
  const disagreements: Array<{ attribute: string; metric: FairnessMetric }> = [];
  for (const [attribute, values] of Object.entries(ours)) {
    for (const metric of FAIRNESS_METRICS) {
      const a = values[metric];
      if (a === null) continue;
      const b = theirs?.[attribute]?.[metric];
      if (b === null || b === undefined || Math.abs(a - b) > FAIRLEARN_AGREEMENT_TOLERANCE) disagreements.push({ attribute, metric });
    }
  }
  return { agrees: disagreements.length === 0, disagreements };
}
