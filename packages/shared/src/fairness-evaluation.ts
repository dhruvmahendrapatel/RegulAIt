/**
 * ADR-0346 — FAIRNESS EVALUATION THROUGH THE GATEWAY, the pure half. Extends ADR-0222 (`fairness.ts`): the metrics,
 * thresholds, small-group suppression and outcome stay there; this module adds the saved evaluation definition, the
 * model-input dataset, the prompt template, the strict reply mapping, the definition's relaxation check, the breach
 * acceptance window and the promotion gate's verdict.
 *
 * Pure: no db, no clock of its own (callers pass `now`), no I/O. No regex runs on caller input (M-074): the template
 * is scanned with indexOf.
 */
import { z } from "zod";
import { EU_AI_ACT_TIERS, type EuAiActTier } from "./eu-ai-act.js";
import {
  FAIRNESS_DEFAULT_THRESHOLDS,
  FAIRNESS_LIMITS,
  FAIRNESS_METRICS,
  fairnessRunRelaxed,
  fairnessThresholdSchema,
  type FairnessOutcome,
  type FairnessThreshold,
} from "./fairness.js";

export const FAIRNESS_EVALUATION_LIMITS = {
  /** input columns a model-input dataset may name (the prompt template's placeholders) */
  maxInputColumns: 8,
  /** the longest input cell, in characters (an input is a prompt, so longer than ADR-0222's label cells) */
  maxInputCellChars: 4000,
  maxTemplateChars: 8000,
  maxOutputChars: 200,
  /** the share of unparseable replies a definition may tolerate; strict 0 */
  maxUnparseableRate: { min: 0, max: 0.05, default: 0 },
  /** an ADR-0187 engine schedule's interval */
  intervalHours: { min: 1, max: 720 },
  /** the longest a breach acceptance may last */
  maxAcceptanceDays: 90,
  /** the oldest run the promotion gate accepts (org setting `fairness_run_max_age_days`) */
  runMaxAgeDays: { min: 1, max: 365, default: 90 },
} as const;

/**
 * ADR-0346 decision 9 (owner 2026-11-21): which ADR-0085 risk tiers force the promotion gate on a model card, at their
 * column defaults (migration fairness_gate_risk_tiers). Secure by default (ADR-0180): the high-risk tiers force it;
 * an admin may relax a tier, and that change is a stepped-up, audited settings relaxation.
 */
export const FAIRNESS_GATE_TIER_DEFAULTS: Readonly<Record<EuAiActTier, boolean>> = Object.freeze({
  prohibited: true,
  high: true,
  limited: false,
  minimal: false,
});

/** the org settings this ADR adds, at their column defaults (migrations fairness_evaluation, fairness_gate_risk_tiers) */
export const FAIRNESS_EVALUATION_DEFAULT_SETTINGS = Object.freeze({
  /** opt-in per tenant (ADR-0346 decision 9; a compliance tag or a forcing risk tier turns it on for a card) */
  fairnessPromotionGate: false as boolean,
  fairnessRunMaxAgeDays: FAIRNESS_EVALUATION_LIMITS.runMaxAgeDays.default as number,
  fairnessGateTierProhibited: FAIRNESS_GATE_TIER_DEFAULTS.prohibited as boolean,
  fairnessGateTierHigh: FAIRNESS_GATE_TIER_DEFAULTS.high as boolean,
  fairnessGateTierLimited: FAIRNESS_GATE_TIER_DEFAULTS.limited as boolean,
  fairnessGateTierMinimal: FAIRNESS_GATE_TIER_DEFAULTS.minimal as boolean,
});

/** why the promotion gate applies to one card (in this order; empty when it does not) */
export const FAIRNESS_GATE_REASONS = ["compliance_tag", "risk_tier", "org_setting"] as const;
export type FairnessGateReason = (typeof FAIRNESS_GATE_REASONS)[number];

/**
 * Does the fairness promotion gate apply to one model card's sign-off (ADR-0346 decision 9)? Any one source is enough,
 * and none relaxes another: a compliance tag that requires it, the card's risk tier where that tier forces it, or the
 * org-wide setting. `tier` is the card's effective ADR-0085 tier (the strictest among the use cases that intend its
 * agent, after jurisdiction floors); an unscreened card is not forced by tier, since screening is its own sign-off
 * step. Pure: the caller reads the settings and the tier.
 */
export function fairnessGateRequirement(input: {
  orgGate: boolean;
  tagRequires: boolean;
  tier: EuAiActTier | "unscreened";
  tierGates: Readonly<Record<EuAiActTier, boolean>>;
}): { required: boolean; reasons: FairnessGateReason[] } {
  const reasons: FairnessGateReason[] = [];
  if (input.tagRequires) reasons.push("compliance_tag");
  if (input.tier !== "unscreened" && EU_AI_ACT_TIERS.includes(input.tier) && input.tierGates[input.tier] === true) reasons.push("risk_tier");
  if (input.orgGate) reasons.push("org_setting");
  return { required: reasons.length > 0, reasons };
}

/** the per-tier gate switches as `fairnessGateRequirement` reads them, from an org settings row */
export function fairnessGateTiersOf(row: {
  fairnessGateTierProhibited: boolean;
  fairnessGateTierHigh: boolean;
  fairnessGateTierLimited: boolean;
  fairnessGateTierMinimal: boolean;
}): Readonly<Record<EuAiActTier, boolean>> {
  return { prohibited: row.fairnessGateTierProhibited, high: row.fairnessGateTierHigh, limited: row.fairnessGateTierLimited, minimal: row.fairnessGateTierMinimal };
}

export const FAIRNESS_DATASET_KINDS = ["supplied_predictions", "model_inputs"] as const;
export type FairnessDatasetKind = (typeof FAIRNESS_DATASET_KINDS)[number];
export const FAIRNESS_RUN_MODES = ["supplied", "model"] as const;
export type FairnessRunMode = (typeof FAIRNESS_RUN_MODES)[number];
export const FAIRNESS_BREACH_REVIEW_STATUSES = ["pending", "accepted", "rejected", "superseded"] as const;
export type FairnessBreachReviewStatus = (typeof FAIRNESS_BREACH_REVIEW_STATUSES)[number];
export const FAIRNESS_EVALUATION_STATUSES = ["active", "archived"] as const;
export type FairnessEvaluationStatus = (typeof FAIRNESS_EVALUATION_STATUSES)[number];
// The two lifecycles (breach review, evaluation) are declared as ADR-0348 machines in state-machines.ts.

/** the signed evidence body's version tag (the DB CHECK on `fairness_run_evidence` reads it) */
export const FAIRNESS_RUN_EVIDENCE_VERSION = "regulait.fairness-run.v1";

const columnName = z.string().trim().min(1).max(FAIRNESS_LIMITS.maxCellChars);

// ---------------------------------------------------------------------------
// The prompt template
// ---------------------------------------------------------------------------

export type TemplatePart = { kind: "text"; text: string } | { kind: "column"; name: string };

/**
 * Split a template into text and `{{column}}` placeholders (whitespace inside the braces is trimmed). Returns null for
 * a malformed template: an unclosed `{{`, an empty or over-long name, or a name holding `{` or `}`. Linear: one
 * indexOf pass, no regex.
 */
export function parsePromptTemplate(template: string): TemplatePart[] | null {
  const parts: TemplatePart[] = [];
  let at = 0;
  while (at < template.length) {
    const open = template.indexOf("{{", at);
    if (open === -1) {
      parts.push({ kind: "text", text: template.slice(at) });
      break;
    }
    if (open > at) parts.push({ kind: "text", text: template.slice(at, open) });
    const close = template.indexOf("}}", open + 2);
    if (close === -1) return null;
    const name = template.slice(open + 2, close).trim();
    if (name.length === 0 || name.length > FAIRNESS_LIMITS.maxCellChars || name.includes("{") || name.includes("}")) return null;
    parts.push({ kind: "column", name });
    at = close + 2;
  }
  return parts;
}

/** the distinct column names a template uses, in first-use order (null = malformed) */
export function templateColumns(template: string): string[] | null {
  const parts = parsePromptTemplate(template);
  if (!parts) return null;
  return [...new Set(parts.flatMap((p) => (p.kind === "column" ? [p.name] : [])))];
}

/** fill a parsed template from one row's input cells (every column must be present: the definition was validated) */
export function fillPromptTemplate(parts: readonly TemplatePart[], row: Readonly<Record<string, string>>): string {
  return parts
    .map((p) => {
      if (p.kind === "text") return p.text;
      const v = row[p.name];
      if (v === undefined) throw new Error(`template column missing from the row: ${p.name}`);
      return v;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// The reply mapping (ADR-0346 decision 4: exact match after trim + case-fold, no judge, no fuzzy match)
// ---------------------------------------------------------------------------

export type MappedReply = 1 | 0 | null;

function fold(s: string): string {
  return s.trim().toLocaleLowerCase("en-US");
}

/** 1 = the favourable output, 0 = the unfavourable one, null = unparseable (neither) */
export function mapFairnessReply(reply: string, outputs: { favourable: string; unfavourable: string }): MappedReply {
  const r = fold(reply);
  if (r === fold(outputs.favourable)) return 1;
  if (r === fold(outputs.unfavourable)) return 0;
  return null;
}

/** is the unparseable share over the definition's cap? (a run over it is inconclusive) */
export function unparseableOverCap(unparseable: number, total: number, maxRate: number): boolean {
  if (total <= 0) return true;
  return unparseable / total > maxRate + 1e-12;
}

// ---------------------------------------------------------------------------
// The model-input dataset and the evaluation definition
// ---------------------------------------------------------------------------

export const createModelInputDatasetSchema = z
  .object({
    kind: z.literal("model_inputs"),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).nullish(),
    csv: z.string().min(1).max(FAIRNESS_LIMITS.maxCsvBytes),
    labelColumn: columnName,
    favourableLabel: z.string().trim().min(1).max(FAIRNESS_LIMITS.maxCellChars),
    protectedAttributes: z.array(columnName).min(1).max(FAIRNESS_LIMITS.maxAttributes),
    inputColumns: z.array(columnName).min(1).max(FAIRNESS_EVALUATION_LIMITS.maxInputColumns),
    /** the card the dataset is for */
    cardId: z.string().uuid(),
    /** the project the evaluation's runs attribute to: its compliance cascade's PII mode governs the upload with the
     * org default as the floor (decision 3). A model card has no project of its own. */
    projectId: z.string().uuid().nullish(),
  })
  .strict()
  .refine(
    (b) =>
      new Set([b.labelColumn, ...b.protectedAttributes, ...b.inputColumns]).size === 1 + b.protectedAttributes.length + b.inputColumns.length,
    { message: "the label, protected attribute and input columns must be different columns" },
  );
export type CreateModelInputDataset = z.infer<typeof createModelInputDatasetSchema>;

const intervalHours = z.number().int().min(FAIRNESS_EVALUATION_LIMITS.intervalHours.min).max(FAIRNESS_EVALUATION_LIMITS.intervalHours.max);

export const createFairnessEvaluationSchema = z
  .object({
    cardId: z.string().uuid(),
    datasetId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    /** a subset of the dataset's protected attributes */
    attributes: z.array(columnName).min(1).max(FAIRNESS_LIMITS.maxAttributes),
    promptTemplate: z.string().min(1).max(FAIRNESS_EVALUATION_LIMITS.maxTemplateChars),
    favourableOutput: z.string().trim().min(1).max(FAIRNESS_EVALUATION_LIMITS.maxOutputChars),
    unfavourableOutput: z.string().trim().min(1).max(FAIRNESS_EVALUATION_LIMITS.maxOutputChars),
    /** omitted = the strict defaults (ADR-0222) */
    thresholds: z.array(fairnessThresholdSchema).min(1).max(FAIRNESS_METRICS.length).optional(),
    minGroupSize: z.number().int().min(FAIRNESS_LIMITS.minGroupSize.min).max(FAIRNESS_LIMITS.minGroupSize.max).optional(),
    maxUnparseableRate: z
      .number()
      .min(FAIRNESS_EVALUATION_LIMITS.maxUnparseableRate.min)
      .max(FAIRNESS_EVALUATION_LIMITS.maxUnparseableRate.max)
      .optional(),
    /** omitted or null = on demand only */
    intervalHours: intervalHours.nullish(),
  })
  .strict()
  .refine((b) => new Set(b.attributes).size === b.attributes.length, { message: "each attribute may be named once" })
  .refine((b) => !b.thresholds || new Set(b.thresholds.map((t) => t.metric)).size === b.thresholds.length, {
    message: "each metric may have one threshold",
  })
  .refine((b) => b.favourableOutput.toLocaleLowerCase("en-US") !== b.unfavourableOutput.toLocaleLowerCase("en-US"), {
    message: "the favourable and unfavourable outputs must differ",
  })
  .refine((b) => (templateColumns(b.promptTemplate)?.length ?? 0) > 0, {
    message: "the prompt template must be well formed and name at least one input column as {{column}}",
  });
export type CreateFairnessEvaluation = z.infer<typeof createFairnessEvaluationSchema>;

/** what a definition is checked against: the dataset it names */
export interface EvaluationDatasetFacts {
  kind: FairnessDatasetKind;
  protectedAttributes: readonly string[];
  inputColumns: readonly string[];
  purged: boolean;
}

/**
 * The reasons a definition cannot run on its dataset (empty = it can): a supplied-prediction or purged dataset, an
 * attribute the dataset does not protect, or a template column that is not one of its input columns. Each reason
 * names a column, never a cell.
 */
export function evaluationDefinitionProblems(def: Pick<CreateFairnessEvaluation, "attributes" | "promptTemplate">, ds: EvaluationDatasetFacts): string[] {
  const out: string[] = [];
  if (ds.kind !== "model_inputs") out.push("dataset_not_model_inputs");
  if (ds.purged) out.push("dataset_purged");
  for (const a of def.attributes) if (!ds.protectedAttributes.includes(a)) out.push(`attribute_not_in_dataset:${a}`);
  const cols = templateColumns(def.promptTemplate);
  if (!cols) out.push("template_malformed");
  else for (const c of cols) if (!ds.inputColumns.includes(c)) out.push(`template_column_not_input:${c}`);
  return out;
}

/**
 * How a definition is looser than the strict defaults (the `settings_relax` step-up facts, empty = strict): ADR-0222's
 * threshold and group-size rules, plus a non-zero unparseable cap.
 */
export function fairnessEvaluationRelaxed(
  def: Pick<CreateFairnessEvaluation, "thresholds" | "minGroupSize" | "maxUnparseableRate">,
): Record<string, unknown> {
  const out = fairnessRunRelaxed(def.thresholds, def.minGroupSize);
  const rate = def.maxUnparseableRate;
  if (rate !== undefined && rate > FAIRNESS_EVALUATION_LIMITS.maxUnparseableRate.default) out["fairnessEvaluation.maxUnparseableRate"] = rate;
  return out;
}

/** the thresholds a definition stores: its own, or the strict defaults */
export function effectiveEvaluationThresholds(thresholds: readonly FairnessThreshold[] | undefined): FairnessThreshold[] {
  return (thresholds ?? FAIRNESS_DEFAULT_THRESHOLDS).map((t) => ({ ...t }));
}

// ---------------------------------------------------------------------------
// Breaches and the promotion gate
// ---------------------------------------------------------------------------

/** does a run with this outcome open a breach item? (inconclusive does not: there is nothing to accept, decision 8) */
export function fairnessOutcomeIsBreach(outcome: FairnessOutcome): boolean {
  return outcome === "fail" || outcome === "flag";
}

export const acceptFairnessBreachSchema = z
  .object({
    reason: z.string().trim().min(10).max(2000),
    /** how long the acceptance lasts, in days (1 to 90) */
    days: z.number().int().min(1).max(FAIRNESS_EVALUATION_LIMITS.maxAcceptanceDays),
  })
  .strict();
export type AcceptFairnessBreach = z.infer<typeof acceptFairnessBreachSchema>;

/** is a breach acceptance in force at `now`? */
export function breachAcceptanceInForce(review: { status: FairnessBreachReviewStatus; acceptedUntil: Date | null } | null, now: Date): boolean {
  return !!review && review.status === "accepted" && !!review.acceptedUntil && review.acceptedUntil.getTime() > now.getTime();
}

/** does the gate apply to a card? The org setting, or any compliance profile on the card's project requiring it. */
export function fairnessGateApplies(orgGate: boolean, profileRequirements: readonly (boolean | null)[]): { applies: boolean; source: "org" | "compliance_tag" | null } {
  if (profileRequirements.some((r) => r === true)) return { applies: true, source: "compliance_tag" };
  if (orgGate) return { applies: true, source: "org" };
  return { applies: false, source: null };
}

export interface GateCandidateRun {
  outcome: FairnessOutcome;
  createdAt: Date;
  /** the card's pinned model version when the run was made */
  cardModelVersion: string | null;
  /** the breach review on this run, if one exists */
  review: { status: FairnessBreachReviewStatus; acceptedUntil: Date | null } | null;
}

export type FairnessGateVerdict =
  | { allowed: true; reason: "gate_not_applied" | "passing_run" | "breach_accepted" }
  | { allowed: false; reason: "no_run" | "stale_version" | "too_old" | "breach_not_accepted" | "inconclusive" };

/**
 * ADR-0346 decision 9: may a card be signed off (promoted)? Reads the card's LATEST run only, so an older pass never
 * outvotes a newer failure. Allowed when the gate does not apply; otherwise the latest run must be on the card's
 * current model version, no older than `maxAgeDays`, and either pass or carry a breach acceptance in force.
 */
export function evaluateFairnessGate(input: {
  applies: boolean;
  latest: GateCandidateRun | null;
  cardModelVersion: string | null;
  maxAgeDays: number;
  now: Date;
}): FairnessGateVerdict {
  if (!input.applies) return { allowed: true, reason: "gate_not_applied" };
  const run = input.latest;
  if (!run) return { allowed: false, reason: "no_run" };
  if ((run.cardModelVersion ?? null) !== (input.cardModelVersion ?? null)) return { allowed: false, reason: "stale_version" };
  if (input.now.getTime() - run.createdAt.getTime() > input.maxAgeDays * 86_400_000) return { allowed: false, reason: "too_old" };
  if (run.outcome === "pass") return { allowed: true, reason: "passing_run" };
  if (run.outcome === "inconclusive") return { allowed: false, reason: "inconclusive" };
  if (breachAcceptanceInForce(run.review, input.now)) return { allowed: true, reason: "breach_accepted" };
  return { allowed: false, reason: "breach_not_accepted" };
}
