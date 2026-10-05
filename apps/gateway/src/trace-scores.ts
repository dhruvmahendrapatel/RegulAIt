/**
 * ADR-0173 batch 2c (F) — TRACE SCORES and THE TRACE FILTER'S SQL.
 *
 * Two primitives the rest of batch 2c builds on. No routes live here.
 *
 * `traceFilterConditions(filter, { scopeUserId })` turns a parsed
 * `TraceFilter` (packages/shared/src/trace-filters.ts) into ONE drizzle `SQL`
 * predicate over `traces`, for `.where(...)`. THE SCOPING INVARIANT: when
 * `scopeUserId` is a string, the predicate ALWAYS contains
 * `traces.user_id = scopeUserId`, whatever the filter says — no filter field
 * can widen it (a `userId` filter naming somebody else simply ANDs to nothing).
 * `scopeUserId: null` means unscoped and is only for an admin reader. The
 * option is required, so every caller decides; get it from
 * `resolveTraceScope(reader, filter)` (shared), which also refuses a non-admin
 * who names another user so the route can answer 403 instead of an empty page.
 * The span-, score-, tag- and evaluation-based fields are EXISTS subqueries
 * correlated on `traces.id`, so they never multiply rows: a count over
 * `traces` with this predicate is a count of traces.
 *
 * `recordTraceScore(db, input)` writes one `trace_scores` row, IDEMPOTENT on
 * (source, sourceRefId, name): a replay returns the existing row's id with
 * `created: false` and changes nothing — first write wins, so a retried sweep
 * or a double-submitted annotation cannot rewrite a recorded score. It writes
 * no audit row; the caller audits the action that produced the score (an
 * annotation submit, an eval run) in its own transaction. Pass a transaction
 * handle to make the score commit with that action.
 */
import { z } from "zod";
import {
  TRACE_SCORE_SOURCES,
  and,
  eq,
  gte,
  lte,
  sql,
  traceEvaluations,
  traceScores,
  traceSpans,
  traceTags,
  traces,
  type Db,
  type SQL,
  type TraceScoreSource,
} from "@regulait/db";
import { TRACE_SCORE_NAME_MAX_CHARS, type TraceFilter } from "@regulait/shared";

// ---------------------------------------------------------------------------
// the filter
// ---------------------------------------------------------------------------

export interface TraceFilterScope {
  /** a user id = only that user's traces, always; null = unscoped (admin only) */
  scopeUserId: string | null;
}

/**
 * The WHERE predicate over `traces` for `filter`, scoped per `scopeUserId`.
 * Never undefined: with no constraints at all it is `true`. Compose with
 * `and(traceFilterConditions(f, s), extra)` when a route needs more.
 */
export function traceFilterConditions(filter: TraceFilter, scope: TraceFilterScope): SQL {
  const conds: SQL[] = [];
  // THE INVARIANT. First, unconditional, and independent of `filter.userId`.
  if (scope.scopeUserId !== null) conds.push(eq(traces.userId, scope.scopeUserId));
  if (filter.userId !== undefined) conds.push(eq(traces.userId, filter.userId));

  if (filter.projectId !== undefined) conds.push(eq(traces.projectId, filter.projectId));
  if (filter.sessionId !== undefined) conds.push(eq(traces.sessionId, filter.sessionId));
  if (filter.kind !== undefined) conds.push(eq(traces.kind, filter.kind));
  if (filter.status !== undefined) conds.push(eq(traces.status, filter.status));
  if (filter.deniedOnly === true) conds.push(sql`${traces.deniedSpanCount} > 0`);
  if (filter.from !== undefined) conds.push(gte(traces.startedAt, new Date(filter.from)));
  if (filter.to !== undefined) conds.push(lte(traces.startedAt, new Date(filter.to)));
  if (filter.minCostUsd !== undefined) conds.push(gte(traces.costUsd, filter.minCostUsd));
  if (filter.minLatencyMs !== undefined) conds.push(gte(traces.durationMs, filter.minLatencyMs));

  if (filter.agentId !== undefined) {
    conds.push(
      sql`exists (select 1 from ${traceSpans} where ${traceSpans.traceId} = ${traces.id} and ${traceSpans.agentId} = ${filter.agentId})`,
    );
  }
  if (filter.model !== undefined) {
    conds.push(
      sql`exists (select 1 from ${traceSpans} where ${traceSpans.traceId} = ${traces.id} and ${traceSpans.model} = ${filter.model})`,
    );
  }
  if (filter.scoreName !== undefined) {
    const range: SQL[] = [];
    if (filter.scoreMin !== undefined) range.push(sql` and ${traceScores.value} >= ${filter.scoreMin}`);
    if (filter.scoreMax !== undefined) range.push(sql` and ${traceScores.value} <= ${filter.scoreMax}`);
    conds.push(
      sql`exists (select 1 from ${traceScores} where ${traceScores.traceId} = ${traces.id} and ${traceScores.name} = ${filter.scoreName}${sql.join(range)})`,
    );
  }
  if (filter.flagged !== undefined) {
    const flaggedExists = sql`exists (select 1 from ${traceEvaluations} where ${traceEvaluations.traceId} = ${traces.id} and ${traceEvaluations.flagged})`;
    conds.push(filter.flagged ? flaggedExists : sql`not ${flaggedExists}`);
  }
  if (filter.tagKey !== undefined) {
    const valueCond = filter.tagValue !== undefined ? sql` and ${traceTags.value} = ${filter.tagValue}` : sql``;
    conds.push(
      sql`exists (select 1 from ${traceTags} where ${traceTags.traceId} = ${traces.id} and ${traceTags.key} = ${filter.tagKey}${valueCond})`,
    );
  }
  return conds.length ? and(...conds)! : sql`true`;
}

// ---------------------------------------------------------------------------
// scores
// ---------------------------------------------------------------------------

export const TRACE_SCORE_LABEL_MAX_CHARS = 128;
export const TRACE_SCORE_REF_MAX_CHARS = 200;

const recordTraceScoreSchema = z
  .object({
    traceId: z.string().uuid(),
    /** must belong to `traceId` when given */
    spanId: z.string().uuid().nullish(),
    source: z.enum(TRACE_SCORE_SOURCES),
    name: z.string().trim().min(1).max(TRACE_SCORE_NAME_MAX_CHARS),
    value: z.number().finite().nullish(),
    label: z.string().trim().min(1).max(TRACE_SCORE_LABEL_MAX_CHARS).nullish(),
    /** the id of the row in the source (submission, eval result, verdict, evaluation) */
    sourceRefId: z.string().min(1).max(TRACE_SCORE_REF_MAX_CHARS),
  })
  .strict()
  .refine((v) => v.value != null || v.label != null, { message: "a score needs a value or a label" });

export interface RecordTraceScoreInput {
  traceId: string;
  spanId?: string | null | undefined;
  source: TraceScoreSource;
  name: string;
  value?: number | null | undefined;
  label?: string | null | undefined;
  sourceRefId: string;
}

export interface RecordTraceScoreResult {
  id: string;
  /** false = a row with this (source, sourceRefId, name) already existed; it was left as it was */
  created: boolean;
}

/**
 * Record one score. Throws (zod) on a malformed input, and throws when
 * `spanId` is not a span of `traceId` or the trace does not exist. Idempotent
 * on (source, sourceRefId, name): see the file header.
 */
export async function recordTraceScore(db: Db, input: RecordTraceScoreInput): Promise<RecordTraceScoreResult> {
  const v = recordTraceScoreSchema.parse(input);
  if (v.spanId) {
    const [span] = await db
      .select({ traceId: traceSpans.traceId })
      .from(traceSpans)
      .where(eq(traceSpans.id, v.spanId));
    if (!span || span.traceId !== v.traceId) throw new Error("recordTraceScore: the span is not part of the trace");
  }
  const [inserted] = await db
    .insert(traceScores)
    .values({
      traceId: v.traceId,
      spanId: v.spanId ?? null,
      source: v.source,
      name: v.name,
      value: v.value ?? null,
      label: v.label ?? null,
      sourceRefId: v.sourceRefId,
    })
    .onConflictDoNothing({ target: [traceScores.source, traceScores.sourceRefId, traceScores.name] })
    .returning({ id: traceScores.id });
  if (inserted) return { id: inserted.id, created: true };
  const [existing] = await db
    .select({ id: traceScores.id })
    .from(traceScores)
    .where(
      and(
        eq(traceScores.source, v.source),
        eq(traceScores.sourceRefId, v.sourceRefId),
        eq(traceScores.name, v.name),
      ),
    );
  if (!existing) throw new Error("recordTraceScore: conflicting row vanished");
  return { id: existing.id, created: false };
}
