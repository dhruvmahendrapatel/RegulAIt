/**
 * ADR-0173 batch 2c (F) — THE TRACE FILTER, shared by every reader of traces:
 * the trace list and tree (T), automation rules (K), KRIs and series (K), and
 * any queue or dataset picker that selects traces (Q, E). Pure.
 *
 * One schema so one filter means the same thing everywhere. The gateway turns a
 * parsed filter into SQL with `traceFilterConditions(filter, { scopeUserId })`
 * (apps/gateway/src/trace-scores.ts); that function — not this schema — owns
 * the scoping rule (a non-admin always sees only their own traces).
 *
 * THE FIELDS (all optional; absent = no constraint; every field ANDs):
 *   userId        the trace's owner. For a non-admin this is either absent or
 *                 their own id (resolveTraceScope refuses anything else).
 *   projectId     the trace's project
 *   sessionId     the trace's session/thread
 *   kind          TRACE_FILTER_KINDS
 *   status        TRACE_FILTER_STATUSES
 *   deniedOnly    true = at least one denied span
 *   from / to     ISO datetimes, inclusive bounds on `traces.started_at`
 *   agentId       some span of the trace ran this agent
 *   model         some span of the trace used this model id (exact match)
 *   minCostUsd    `traces.cost_usd >=` (an unpriced trace never matches)
 *   minLatencyMs  `traces.duration_ms >=` (a running trace never matches)
 *   scoreName     some `trace_scores` row of the trace has this name …
 *   scoreMin/Max  … and (when given) a value inside [scoreMin, scoreMax].
 *                 Either bound alone is fine; both need scoreName.
 *   flagged       true = some span has a FLAGGED trace evaluation (ADR-0160);
 *                 false = none has
 *   tagKey        the trace carries this tag key …
 *   tagValue      … with exactly this value (needs tagKey)
 *
 * QUERY STRINGS. Numbers are coerced, and booleans accept true/false/1/0 as
 * strings — unlike `z.coerce.boolean()`, "false" really means false.
 *
 * EXTENDING. `traceFilterBaseSchema` is the plain object (so a route can
 * `.extend({ limit, cursor })`); re-apply `refineTraceFilter` afterwards:
 *
 *   const q = traceFilterBaseSchema.extend({ limit: … }).superRefine(refineTraceFilter);
 *
 * Unknown keys are stripped (zod's default), so a stored automation-rule
 * filter round-trips through this schema without carrying anything extra.
 */
import { z } from "zod";

/** mirrors `TRACE_KINDS` in packages/db/src/schema.ts */
export const TRACE_FILTER_KINDS = ["dispatch", "run", "workflow", "conversation", "tool", "eval"] as const;
/** mirrors `TRACE_STATUSES` in packages/db/src/schema.ts */
export const TRACE_FILTER_STATUSES = ["running", "ok", "error", "denied"] as const;

/** trace tag key shape; the same pattern is a CHECK on `trace_tags.key` */
export const TRACE_TAG_KEY_PATTERN = /^[a-z0-9_.-]{1,64}$/;

/** the tag rules T's tag routes enforce; the DB CHECKs the key and value length */
export const TRACE_TAG_LIMITS = {
  keyChars: 64,
  valueChars: 256,
  tagsPerTrace: 20,
  /** system-written tags only; an API write of a key with this prefix is refused */
  reservedPrefix: "regulait.",
} as const;

/** score names written to `trace_scores.name` and filtered on */
export const TRACE_SCORE_NAME_MAX_CHARS = 128;

/** a query-string boolean: true/false, "true"/"false", "1"/"0" */
const queryBool = z.preprocess((v) => {
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return v;
}, z.boolean());

const finiteNumber = z.coerce.number().finite();

export const traceFilterBaseSchema = z.object({
  // --- the filters the trace list already had ---------------------------
  userId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  sessionId: z.string().min(1).max(200).optional(),
  kind: z.enum(TRACE_FILTER_KINDS).optional(),
  status: z.enum(TRACE_FILTER_STATUSES).optional(),
  deniedOnly: queryBool.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  // --- batch 2c ------------------------------------------------------------
  agentId: z.string().uuid().optional(),
  model: z.string().min(1).max(200).optional(),
  minCostUsd: finiteNumber.min(0).optional(),
  minLatencyMs: z.coerce.number().int().min(0).optional(),
  scoreName: z.string().min(1).max(TRACE_SCORE_NAME_MAX_CHARS).optional(),
  scoreMin: finiteNumber.optional(),
  scoreMax: finiteNumber.optional(),
  flagged: queryBool.optional(),
  tagKey: z.string().regex(TRACE_TAG_KEY_PATTERN).optional(),
  tagValue: z.string().max(TRACE_TAG_LIMITS.valueChars).optional(),
});

/** the cross-field rules; re-apply after `.extend()` */
export function refineTraceFilter(f: z.infer<typeof traceFilterBaseSchema>, ctx: z.RefinementCtx): void {
  if ((f.scoreMin !== undefined || f.scoreMax !== undefined) && f.scoreName === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scoreName"], message: "a score range needs scoreName" });
  }
  if (f.scoreMin !== undefined && f.scoreMax !== undefined && f.scoreMin > f.scoreMax) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scoreMax"], message: "scoreMax is below scoreMin" });
  }
  if (f.tagValue !== undefined && f.tagKey === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tagKey"], message: "tagValue needs tagKey" });
  }
  if (f.from !== undefined && f.to !== undefined && Date.parse(f.from) > Date.parse(f.to)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to is before from" });
  }
}

export const traceFilterSchema = traceFilterBaseSchema.superRefine(refineTraceFilter);
export type TraceFilter = z.infer<typeof traceFilterSchema>;

/**
 * Who a reader may see, decided once per request. A non-admin is ALWAYS
 * scoped to themself; naming another user is refused (the caller answers 403,
 * the cost-consolidated precedent), never silently ignored. An admin is
 * unscoped (`scopeUserId: null`); their own `userId` filter still applies as an
 * ordinary filter. Pass the result straight into `traceFilterConditions`.
 */
export function resolveTraceScope(
  reader: { userId: string; isAdmin: boolean },
  filter: Pick<TraceFilter, "userId">,
): { ok: true; scopeUserId: string | null } | { ok: false; reason: string } {
  if (reader.isAdmin) return { ok: true, scopeUserId: null };
  if (filter.userId !== undefined && filter.userId !== reader.userId) {
    return { ok: false, reason: "a non-admin may only read their own traces" };
  }
  return { ok: true, scopeUserId: reader.userId };
}
