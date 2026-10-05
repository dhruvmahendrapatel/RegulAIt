/**
 * ADR-0173 batch 2c (K) — AUTOMATION RULES over traces: a stored trace filter,
 * a deterministic sampling rate, and one to four actions. Pure: the schemas,
 * the sampling decision and the retention-hold bound. The gateway's
 * `automation-rules.ts` runs the sweep.
 *
 * THE ACTIONS (one of each type at most):
 *   queue      send the trace to an annotation queue
 *   dataset    add the trace's model-call spans to an evaluation dataset
 *   webhook    deliver `automation.matched` to ONE webhook subscription
 *   retention  hold the trace past the §8.3 floor for `days` from its start
 *
 * SAMPLING is decided per (rule, trace) from `sha256("<ruleId>:<traceId>")`,
 * not from a random draw, so a trace gets the same answer on every pass and on
 * a backfill: a re-run never "re-rolls" a trace into or out of a rule. A rate
 * of 0 never matches and a rate of 1 always does.
 *
 * RETENTION HOLDS (owner decision, 2026-10-05): at most twice the §8.3 floor
 * and at most three years. With no floor set nothing is pruned, so a hold has
 * nothing to extend and the action is refused rather than recorded.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { traceFilterBaseSchema, refineTraceFilter } from "./trace-filters.js";

export const AUTOMATION_ACTION_TYPES = ["queue", "dataset", "webhook", "retention"] as const;
export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];

export const AUTOMATION_LIMITS = {
  maxActions: 4,
  maxNameChars: 120,
  /** an explicit backfill reaches at most this far back */
  maxBackfillDays: 7,
  /** traces a sweep pass examines, across every rule */
  tracesPerPass: 500,
  /** a pass stops starting new work after this */
  passBudgetMs: 45_000,
  /** LATE ARRIVALS: a rule whose filter reads a tag, a score or the flag
   * (`automationFilterIsPostHoc`) also re-reads traces that ended this many
   * hours back (never before the rule existed), because those land after the
   * trace ends. Past it, a late tag or score needs an explicit backfill. */
  lateArrivalWindowHours: 24,
  /** attempts per failed action (the first try included) */
  maxAttempts: 3,
  defaultDailyActionCap: 500,
  maxDailyActionCap: 10_000,
  /** the hold bound: at most this multiple of the §8.3 floor … */
  holdFloorMultiple: 2,
  /** … and at most three years */
  maxHoldDays: 3 * 365,
} as const;

/** the fixed reason codes an action outcome carries (never error text) */
export const AUTOMATION_FAILURE_CODES = [
  "target_not_found",
  "target_inactive",
  "target_frozen",
  "content_withheld",
  "no_eligible_spans",
  "not_permitted",
  "no_retention_floor",
  "hold_exceeds_bound",
  "erasure_released",
  "daily_cap_reached",
  /** the deployment has no implementation wired for this action type */
  "action_unavailable",
  "internal_error",
] as const;
export type AutomationFailureCode = (typeof AUTOMATION_FAILURE_CODES)[number];

export const automationActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("queue"), queueId: z.string().uuid() }).strict(),
  z.object({ type: z.literal("dataset"), datasetId: z.string().uuid() }).strict(),
  z.object({ type: z.literal("webhook"), subscriptionId: z.string().uuid() }).strict(),
  z
    .object({
      type: z.literal("retention"),
      /** total retention from the trace's start, in days */
      days: z.number().int().min(1).max(AUTOMATION_LIMITS.maxHoldDays),
    })
    .strict(),
]);
export type AutomationAction = z.infer<typeof automationActionSchema>;

const actionsSchema = z
  .array(automationActionSchema)
  .min(1)
  .max(AUTOMATION_LIMITS.maxActions)
  .superRefine((acts, ctx) => {
    const seen = new Set<string>();
    for (const [i, a] of acts.entries()) {
      if (seen.has(a.type)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, "type"], message: `one ${a.type} action per rule` });
      seen.add(a.type);
    }
  });

/** a stored rule filter: the shared trace filter (unknown keys stripped) */
export const automationFilterSchema = traceFilterBaseSchema.superRefine(refineTraceFilter);

/**
 * Does this filter read something that can land AFTER the trace ends — a tag
 * (`tagKey`/`tagValue`), an annotation, evaluator or judge score
 * (`scoreName`/`scoreMin`/`scoreMax`), or the ADR-0160 flag (`flagged: true`)?
 * Such a rule also rescans the late-arrival window
 * (`AUTOMATION_LIMITS.lateArrivalWindowHours`). `flagged: false` is not
 * post-hoc: an unflagged trace matches it the moment it ends.
 */
export function automationFilterIsPostHoc(f: z.infer<typeof automationFilterSchema>): boolean {
  return f.tagKey !== undefined || f.scoreName !== undefined || f.flagged === true;
}

export const automationRuleCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(AUTOMATION_LIMITS.maxNameChars),
    filter: automationFilterSchema.default({}),
    samplingRate: z.number().min(0).max(1).default(1),
    actions: actionsSchema,
    dailyActionCap: z.number().int().min(1).max(AUTOMATION_LIMITS.maxDailyActionCap).default(AUTOMATION_LIMITS.defaultDailyActionCap),
  })
  .strict();
export type AutomationRuleCreate = z.infer<typeof automationRuleCreateSchema>;

export const automationRuleUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(AUTOMATION_LIMITS.maxNameChars),
    filter: automationFilterSchema,
    samplingRate: z.number().min(0).max(1),
    actions: actionsSchema,
    dailyActionCap: z.number().int().min(1).max(AUTOMATION_LIMITS.maxDailyActionCap),
    /** pause or resume */
    status: z.enum(["active", "paused"]),
  })
  .partial()
  .strict();
export type AutomationRuleUpdate = z.infer<typeof automationRuleUpdateSchema>;

export const automationBackfillSchema = z
  .object({ days: z.number().int().min(1).max(AUTOMATION_LIMITS.maxBackfillDays) })
  .strict();

/**
 * THE SAMPLING DECISION. The first 8 bytes of `sha256("<ruleId>:<traceId>")`
 * as an unsigned integer, divided by 2^64, gives u in [0, 1); the trace is in
 * the sample when u < rate. So rate 0 never matches, rate 1 always does, and
 * the same (rule, trace) always gets the same answer.
 */
export function automationSampled(ruleId: string, traceId: string, rate: number): boolean {
  if (!(rate > 0)) return false;
  if (rate >= 1) return true;
  const h = createHash("sha256").update(`${ruleId}:${traceId}`).digest();
  const u = Number(h.readBigUInt64BE(0)) / 2 ** 64;
  return u < rate;
}

/** the longest hold allowed under a §8.3 floor of `floorDays` (null = no floor, so no hold) */
export function maxRetentionHoldDays(floorDays: number | null): number | null {
  if (floorDays === null || !(floorDays > 0)) return null;
  return Math.min(AUTOMATION_LIMITS.holdFloorMultiple * floorDays, AUTOMATION_LIMITS.maxHoldDays);
}

/**
 * Where a hold of `days` on a trace that started at `startedAt` ends, or why
 * it cannot be placed. A request above the bound is refused (not clamped), so
 * nothing is ever held longer than the policy the rule's author saw.
 */
export function retentionHoldUntil(
  startedAt: Date,
  days: number,
  floorDays: number | null,
): { ok: true; holdUntil: Date } | { ok: false; reason: "no_retention_floor" | "hold_exceeds_bound"; maxDays: number | null } {
  const max = maxRetentionHoldDays(floorDays);
  if (max === null) return { ok: false, reason: "no_retention_floor", maxDays: null };
  if (days > max) return { ok: false, reason: "hold_exceeds_bound", maxDays: max };
  return { ok: true, holdUntil: new Date(startedAt.getTime() + days * 86_400_000) };
}
