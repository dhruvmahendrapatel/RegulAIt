/**
 * ADR-0173 batch 2c (item 7) — DATASETS FROM TRACES, and EVALUATORS ON TRACES.
 *
 * Production traces are the cheapest source of realistic eval cases and the
 * most natural thing to score continuously. Both directions read the stored
 * trace PREVIEW only — the same §8.4/ADR-0042-postured text the trace already
 * holds — and both are admin-only and audited, because an admin is reading
 * other people's traces.
 *
 * ADD TO DATASET (`addTracesToDataset`)
 *   - a span becomes a case: its input preview is the case input, its output
 *     preview the reference answer;
 *   - per row, a withheld span (`content_withheld`), an empty one
 *     (`no_content`), an unknown one (`not_found`), a span already in this
 *     dataset version (`already_in_dataset`, enforced by a unique index), a
 *     repeat inside the request (`duplicate_in_request`) and a case the
 *     dataset's default scorer could not score (`unusable_scorer_config`) are
 *     SKIPPED WITH THE REASON, never silently dropped;
 *   - a frozen dataset version refuses the whole call (409), the same rule the
 *     case editor follows;
 *   - at most EVAL_TRACE_ROWS_MAX rows per call.
 *   Exported for the automation rules' "add to dataset" action (K), which
 *   passes its rule id so the webhook names it.
 *
 * EVALUATE TRACES (`evaluateTraceSpans`)
 *   One DETERMINISTIC scorer over span output previews. A judge-backed kind is
 *   refused (an evaluator on traces never dispatches a model). A withheld or
 *   empty preview is "not evaluated" — never a zero. Each result is recorded as
 *   a trace score (source `evaluator`) through F's idempotent `recordTraceScore`.
 *
 * Copying a preview into a dataset makes it authored content that outlives the
 * §8.3 trace prune. That is what a dataset is; it is why the copy is admin-only,
 * capped, and audited with the span ids.
 */
import crypto from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import {
  and,
  asc,
  auditLog,
  eq,
  evalCases,
  evalDatasets,
  inArray,
  traceSpans,
  traces,
  type Db,
} from "@regulait/db";
import {
  EVAL_TRACE_ROWS_MAX,
  datasetFromTracesSchema,
  evalScorerConfigSchema,
  evaluateTracesSchema,
  isDeterministicScorer,
  scoreDeterministic,
  validateScorerConfig,
  type EvalScorerConfig,
  type EvalScorerKind,
  type EvalTraceSkipReason,
  type JudgeBackedScorerKind,
} from "@regulait/shared";
import { datasetIsFrozen } from "./evals.js";
import { emitWebhookEvent } from "./outbound-webhooks.js";
import { recordTraceScore } from "./trace-scores.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export interface AddTracesToDatasetInput {
  datasetId: string;
  /** rows chosen span by span — exactly one of `spanIds` / `traceIds` */
  spanIds?: readonly string[] | undefined;
  /** whole traces: each trace's model-call (`llm`) spans become rows */
  traceIds?: readonly string[] | undefined;
  /** the admin (or the automation rule's author) doing it */
  actorUserId: string | null;
  /** set when an automation rule does it (K) */
  ruleId?: string | null;
  dataKey?: string | undefined;
  log?: FastifyBaseLogger;
}

export type AddTracesToDatasetOutcome =
  | {
      ok: true;
      added: number;
      skipped: Array<{ id: string; reason: EvalTraceSkipReason }>;
      rows: Array<{ spanId: string; caseId: string }>;
      dataset: { id: string; name: string; version: number };
    }
  | { ok: false; status: number; error: string; detail?: string };

const idsOf = (xs: readonly string[]) => [...new Set(xs)];

async function loadSpans(db: Db, ids: readonly string[]) {
  const uuid = z.string().uuid();
  const valid = idsOf(ids).filter((i) => uuid.safeParse(i).success);
  if (valid.length === 0) return new Map<string, SpanPreview>();
  const rows = await db
    .select({
      id: traceSpans.id,
      traceId: traceSpans.traceId,
      inputPreview: traceSpans.inputPreview,
      outputPreview: traceSpans.outputPreview,
      contentWithheld: traceSpans.contentWithheld,
      ownerUserId: traces.userId,
    })
    .from(traceSpans)
    .innerJoin(traces, eq(traces.id, traceSpans.traceId))
    .where(inArray(traceSpans.id, valid));
  return new Map(rows.map((r) => [r.id, r]));
}
type SpanPreview = {
  id: string;
  traceId: string;
  inputPreview: string | null;
  outputPreview: string | null;
  contentWithheld: boolean;
  ownerUserId: string;
};

const blank = (s: string | null | undefined) => s === null || s === undefined || s.trim().length === 0;

/**
 * The `traceIds` form: each trace's GenAI-operation (model call, span kind
 * `llm`) spans, in trace and span order. A trace that does not exist, or has no
 * model-call span, is skipped with its own id and the reason; a repeated trace
 * id is `duplicate_in_request`.
 */
async function expandTraces(
  db: Db,
  traceIds: readonly string[],
): Promise<{ spanIds: string[]; skipped: Array<{ id: string; reason: EvalTraceSkipReason }> }> {
  const uuid = z.string().uuid();
  const valid = [...new Set(traceIds)].filter((i) => uuid.safeParse(i).success);
  const known = valid.length
    ? new Set((await db.select({ id: traces.id }).from(traces).where(inArray(traces.id, valid))).map((r) => r.id))
    : new Set<string>();
  const spans = valid.length
    ? await db
        .select({ id: traceSpans.id, traceId: traceSpans.traceId })
        .from(traceSpans)
        .where(and(inArray(traceSpans.traceId, valid), eq(traceSpans.kind, "llm")))
        .orderBy(asc(traceSpans.seq), asc(traceSpans.id))
    : [];
  const spanIds: string[] = [];
  const skipped: Array<{ id: string; reason: EvalTraceSkipReason }> = [];
  const seen = new Set<string>();
  for (const id of traceIds) {
    if (seen.has(id)) {
      skipped.push({ id, reason: "duplicate_in_request" });
      continue;
    }
    seen.add(id);
    if (!known.has(id)) {
      skipped.push({ id, reason: "not_found" });
      continue;
    }
    const mine = spans.filter((s) => s.traceId === id).map((s) => s.id);
    if (mine.length === 0) skipped.push({ id, reason: "no_model_call" });
    spanIds.push(...mine);
  }
  return { spanIds, skipped };
}

export async function addTracesToDataset(db: Db, input: AddTracesToDatasetInput): Promise<AddTracesToDatasetOutcome> {
  const bySpan = input.spanIds !== undefined && input.spanIds.length > 0;
  const byTrace = input.traceIds !== undefined && input.traceIds.length > 0;
  if (bySpan === byTrace) {
    return {
      ok: false,
      status: 422,
      error: "span_ids_or_trace_ids",
      detail: "send exactly one of `spanIds` or `traceIds`",
    };
  }
  const sent = bySpan ? input.spanIds!.length : input.traceIds!.length;
  if (sent > EVAL_TRACE_ROWS_MAX) {
    return {
      ok: false,
      status: 422,
      error: "too_many_rows",
      detail: `at most ${EVAL_TRACE_ROWS_MAX} ${bySpan ? "spans" : "traces"} per call; ${sent} were sent`,
    };
  }
  const expanded = byTrace ? await expandTraces(db, input.traceIds!) : { spanIds: [...input.spanIds!], skipped: [] };
  if (expanded.spanIds.length > EVAL_TRACE_ROWS_MAX) {
    return {
      ok: false,
      status: 422,
      error: "too_many_rows",
      detail:
        `those traces hold ${expanded.spanIds.length} model-call spans; at most ${EVAL_TRACE_ROWS_MAX} rows are ` +
        "added per call. Send fewer traces, or choose spans.",
    };
  }
  const [dataset] = await db.select().from(evalDatasets).where(eq(evalDatasets.id, input.datasetId));
  if (!dataset) return { ok: false, status: 404, error: "unknown_dataset" };
  if (await datasetIsFrozen(db, dataset)) {
    return {
      ok: false,
      status: 409,
      error: "dataset_version_frozen",
      detail: `version ${dataset.version} of '${dataset.name}' has been scored by a run and is immutable — mint the next version and add the traces to that`,
    };
  }
  const kind = dataset.scorerKind as EvalScorerKind;
  const cfgParsed = evalScorerConfigSchema.safeParse(dataset.scorerConfig ?? {});
  const cfg: EvalScorerConfig = cfgParsed.success ? cfgParsed.data : {};

  const spans = await loadSpans(db, expanded.spanIds);
  const skipped: Array<{ id: string; reason: EvalTraceSkipReason }> = [...expanded.skipped];
  const rows: Array<{ spanId: string; caseId: string; traceId: string }> = [];
  const seen = new Set<string>();
  for (const id of expanded.spanIds) {
    if (seen.has(id)) {
      skipped.push({ id, reason: "duplicate_in_request" });
      continue;
    }
    seen.add(id);
    const span = spans.get(id);
    if (!span) {
      skipped.push({ id, reason: "not_found" });
      continue;
    }
    if (span.contentWithheld) {
      skipped.push({ id, reason: "content_withheld" });
      continue;
    }
    if (blank(span.inputPreview)) {
      skipped.push({ id, reason: "no_content" });
      continue;
    }
    const expected = blank(span.outputPreview) ? null : span.outputPreview;
    if (validateScorerConfig(kind, cfg, expected, [])) {
      skipped.push({ id, reason: "unusable_scorer_config" });
      continue;
    }
    const [row] = await db
      .insert(evalCases)
      .values({
        datasetId: dataset.id,
        datasetVersion: dataset.version,
        input: span.inputPreview!,
        expected: expected as never,
        context: [],
        contextInPrompt: true,
        tags: ["from-trace"],
        sourceTraceId: span.traceId,
        sourceSpanId: span.id,
      })
      .onConflictDoNothing()
      .returning({ id: evalCases.id });
    if (!row) {
      skipped.push({ id, reason: "already_in_dataset" });
      continue;
    }
    rows.push({ spanId: span.id, caseId: row.id, traceId: span.traceId });
  }

  await db.insert(auditLog).values({
    userId: input.actorUserId ?? NIL_UUID,
    objectType: "eval_run",
    objectId: dataset.id,
    detail: {
      phase: "dataset-from-traces",
      datasetName: dataset.name,
      datasetVersion: dataset.version,
      added: rows.length,
      form: byTrace ? "traceIds" : "spanIds",
      spanIds: rows.map((r) => r.spanId),
      traceIds: [...new Set(rows.map((r) => r.traceId))],
      skipped: skipped.map((s) => ({ id: s.id, reason: s.reason })),
      ...(input.ruleId ? { ruleId: input.ruleId } : {}),
    },
    effect: "allow",
    ruleId: "eval-dataset-from-traces",
    ruleChain: [],
    reason: `${rows.length} trace span(s) added to '${dataset.name}' v${dataset.version}; ${skipped.length} skipped with a reason`,
  });

  for (const r of rows) {
    try {
      await emitWebhookEvent(
        db,
        input.dataKey,
        "trace.added_to_dataset",
        {
          traceId: r.traceId,
          spanId: r.spanId,
          datasetId: dataset.id,
          datasetName: dataset.name,
          datasetVersion: dataset.version,
          rowId: r.caseId,
          addedByUserId: input.actorUserId,
          ruleId: input.ruleId ?? null,
        },
        input.log,
      );
    } catch (e) {
      // a webhook is a notification, never a reason to undo an audited write
      input.log?.warn({ err: (e as Error).message }, "trace.added_to_dataset webhook enqueue failed");
    }
  }

  return {
    ok: true,
    added: rows.length,
    skipped,
    rows: rows.map(({ spanId, caseId }) => ({ spanId, caseId })),
    dataset: { id: dataset.id, name: dataset.name, version: dataset.version },
  };
}

// ---------------------------------------------------------------------------
// Evaluators on traces
// ---------------------------------------------------------------------------

export interface EvaluateTraceSpansInput {
  scorerKind: EvalScorerKind;
  scorerConfig: EvalScorerConfig;
  expected: unknown;
  spanIds: readonly string[];
  scoreName?: string | undefined;
  actorUserId: string | null;
}

export type TraceEvaluation =
  | { spanId: string; traceId: string; outcome: "evaluated"; score: number; passed: boolean; traceScoreId: string }
  | { spanId: string; outcome: "not_evaluated"; reason: EvalTraceSkipReason };

export type EvaluateTraceSpansOutcome =
  | { ok: true; evaluated: number; notEvaluated: number; results: TraceEvaluation[]; scoreName: string; runRef: string }
  | { ok: false; status: number; error: string; detail?: string };

export async function evaluateTraceSpans(db: Db, input: EvaluateTraceSpansInput): Promise<EvaluateTraceSpansOutcome> {
  if (!isDeterministicScorer(input.scorerKind)) {
    return {
      ok: false,
      status: 422,
      error: "deterministic_scorer_required",
      detail:
        `'${input.scorerKind}' is a model-backed scorer. An evaluator on traces runs only deterministic scorers over ` +
        "the stored preview: it never dispatches a model and never reads more than the trace already holds.",
    };
  }
  if (input.spanIds.length > EVAL_TRACE_ROWS_MAX) {
    return { ok: false, status: 422, error: "too_many_rows", detail: `at most ${EVAL_TRACE_ROWS_MAX} spans per call` };
  }
  const bad = validateScorerConfig(input.scorerKind, input.scorerConfig, input.expected ?? null, []);
  if (bad) return { ok: false, status: 422, error: "unusable_scorer_config", detail: bad };

  const scoreName = input.scoreName ?? `evaluator.${input.scorerKind}`;
  // one id per evaluation call: a trace score's source_ref_id, so re-running
  // the same call is a new measurement and a retried write is not a duplicate
  const runRef = crypto.randomUUID();
  const spans = await loadSpans(db, input.spanIds);
  const results: TraceEvaluation[] = [];
  const seen = new Set<string>();
  for (const id of input.spanIds) {
    if (seen.has(id)) {
      results.push({ spanId: id, outcome: "not_evaluated", reason: "duplicate_in_request" });
      continue;
    }
    seen.add(id);
    const span = spans.get(id);
    if (!span) {
      results.push({ spanId: id, outcome: "not_evaluated", reason: "not_found" });
      continue;
    }
    if (span.contentWithheld) {
      results.push({ spanId: id, outcome: "not_evaluated", reason: "content_withheld" });
      continue;
    }
    if (blank(span.outputPreview)) {
      results.push({ spanId: id, outcome: "not_evaluated", reason: "no_content" });
      continue;
    }
    const scored = scoreDeterministic({
      kind: input.scorerKind as Exclude<EvalScorerKind, JudgeBackedScorerKind>,
      expected: input.expected ?? null,
      output: span.outputPreview!,
      config: input.scorerConfig,
      caseInput: span.inputPreview ?? "",
      context: [],
    });
    const rec = await recordTraceScore(db, {
      traceId: span.traceId,
      spanId: span.id,
      source: "evaluator",
      name: scoreName,
      value: scored.score,
      label: scored.passed ? "pass" : "fail",
      sourceRefId: `${runRef}:${span.id}`,
    });
    results.push({
      spanId: id,
      traceId: span.traceId,
      outcome: "evaluated",
      score: scored.score,
      passed: scored.passed,
      traceScoreId: rec.id,
    });
  }
  const evaluated = results.filter((r) => r.outcome === "evaluated");
  await db.insert(auditLog).values({
    userId: input.actorUserId ?? NIL_UUID,
    objectType: "trace",
    objectId: runRef,
    detail: {
      phase: "trace-evaluator",
      scorerKind: input.scorerKind,
      scoreName,
      evaluated: evaluated.length,
      notEvaluated: results.length - evaluated.length,
      spanIds: evaluated.map((r) => r.spanId),
      traceIds: [...new Set(evaluated.map((r) => (r as { traceId: string }).traceId))],
    },
    effect: "allow",
    ruleId: "trace-evaluator-run",
    ruleChain: [],
    reason: `${evaluated.length} span preview(s) scored with '${input.scorerKind}'; ${results.length - evaluated.length} not evaluated`,
  });
  return {
    ok: true,
    evaluated: evaluated.length,
    notEvaluated: results.length - evaluated.length,
    results,
    scoreName,
    runRef,
  };
}

// ---------------------------------------------------------------------------
// Routes (registered from registerEvalRoutes; both admin-only by default)
// ---------------------------------------------------------------------------

const idParam = z.object({ id: z.string().uuid() });

export function registerEvalDatasetSourceRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string }) {
  /**
   * T's traces page "Add to dataset": `{traceIds}` (whole traces) or
   * `{spanIds}` — exactly one, else 422 — answering `{added, skipped:[{id, reason}]}`.
   */
  app.post("/v1/evals/datasets/:id/from-traces", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = datasetFromTracesSchema.parse(req.body);
    const out = await addTracesToDataset(db, {
      datasetId: id,
      spanIds: body.spanIds,
      traceIds: body.traceIds,
      actorUserId: req.authCtx.userId ?? null,
      dataKey: opts.dataKey,
      log: req.log,
    });
    if (!out.ok) return reply.status(out.status).send({ error: out.error, ...(out.detail ? { detail: out.detail } : {}) });
    return reply.status(200).send({ added: out.added, skipped: out.skipped, dataset: out.dataset });
  });

  /** one deterministic scorer over trace span previews; results land as trace scores */
  app.post("/v1/evals/traces/evaluate", async (req, reply) => {
    const body = evaluateTracesSchema.parse(req.body);
    const out = await evaluateTraceSpans(db, {
      scorerKind: body.scorerKind,
      scorerConfig: body.scorerConfig,
      expected: body.expected ?? null,
      spanIds: body.spanIds,
      scoreName: body.scoreName,
      actorUserId: req.authCtx.userId ?? null,
    });
    if (!out.ok) return reply.status(out.status).send({ error: out.error, ...(out.detail ? { detail: out.detail } : {}) });
    return out;
  });
}

