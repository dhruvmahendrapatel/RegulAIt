/**
 * ADR-0160 — CONTINUOUS TRACE EVALUATION, the gateway half.
 *
 * `runTraceEvaluationSweep` takes the next batch of completed model-call spans
 * (`llm`, `fallback_hop`; status `ok`) that have no evaluation yet, runs the
 * pure evaluator from `packages/shared/src/trace-evaluation.ts` over their
 * stored previews, and writes one counts-only row per span.
 *
 * NO HIGH-WATER CURSOR (AER-045). The work queue is the anti-join itself:
 * every eligible span with no `trace_evaluations` row. An earlier version paged
 * on `started_at >= max(evaluated span_started_at) - 10 min`, which permanently
 * skipped any model call that finished (or committed) after a newer span had
 * moved the cursor past its start. No timestamp on `trace_spans` is
 * commit-ordered (`ended_at` is caller-supplied, `created_at` is transaction
 * start), so none can carry a cursor. Instead the scan floor is FIXED: the
 * first sweep's own evaluation time less the first-run lookback, read back as
 * `min(evaluated_at)`. It never advances, so a span started after it stays
 * reachable until it is evaluated; the unique `span_id` index plus
 * `ON CONFLICT DO NOTHING ... RETURNING` makes that exactly once, and the
 * result counts only the rows this pass actually wrote.
 *
 * Reached two ways, one implementation: the ADR-0064 scheduler job
 * (`trace-evaluation-sweep`, 15 min) and `POST /v1/governance/trace-evaluations/run`.
 * The governance monitor (ADR-0157) reads `traceSummaryForAgents` for its
 * `agent_output_leakage` rule. Admin-only through the default gate — the rows
 * describe every agent's traffic.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  agents,
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  sql,
  traceEvaluations,
  traceSpans,
  type Db,
} from "@regulait/db";
import {
  TRACE_EVALUATION_NOTES,
  evaluateTraceContent,
  summarizeTraceEvaluations,
  type AgentTraceSummary,
  type TraceFinding,
} from "@regulait/shared";

export const TRACE_EVAL_WINDOW_DAYS = 7;
const FIRST_RUN_LOOKBACK_MS = TRACE_EVAL_WINDOW_DAYS * 86_400_000;

export interface TraceSweepResult {
  /** spans selected this pass; the outcome counts below cover only the rows
   * this pass wrote, so a concurrent pass never double-counts a span */
  scanned: number;
  evaluated: number;
  flagged: number;
  withheld: number;
  noContent: number;
  /** true when the batch limit was hit — the next pass continues */
  capped: boolean;
}

export async function runTraceEvaluationSweep(
  db: Db,
  opts: { now?: Date; limit?: number } = {},
): Promise<TraceSweepResult> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 500;
  // Fixed floor, not a moving cursor: anchored on the FIRST evaluation ever
  // written, so it only bounds pre-deployment history and never skips a span
  // that completes late. Before any evaluation exists it is the plain lookback.
  const [firstRow] = await db
    .select({ at: sql<Date | string | null>`min(${traceEvaluations.evaluatedAt})` })
    .from(traceEvaluations);
  const anchor = firstRow?.at ? new Date(firstRow.at) : now;
  const floor = new Date(Math.min(anchor.getTime(), now.getTime()) - FIRST_RUN_LOOKBACK_MS);

  const spans = await db
    .select({
      id: traceSpans.id,
      traceId: traceSpans.traceId,
      agentId: traceSpans.agentId,
      startedAt: traceSpans.startedAt,
      inputPreview: traceSpans.inputPreview,
      outputPreview: traceSpans.outputPreview,
      contentWithheld: traceSpans.contentWithheld,
    })
    .from(traceSpans)
    .leftJoin(traceEvaluations, eq(traceEvaluations.spanId, traceSpans.id))
    .where(
      and(
        inArray(traceSpans.kind, ["llm", "fallback_hop"]),
        eq(traceSpans.status, "ok"),
        gte(traceSpans.startedAt, floor),
        isNull(traceEvaluations.id),
      ),
    )
    .orderBy(traceSpans.startedAt, traceSpans.id)
    .limit(limit);

  const out: TraceSweepResult = { scanned: spans.length, evaluated: 0, flagged: 0, withheld: 0, noContent: 0, capped: spans.length === limit };
  if (spans.length === 0) return out;
  const rows = spans.map((s) => {
    const r = evaluateTraceContent(s);
    return {
      spanId: s.id,
      traceId: s.traceId,
      agentId: s.agentId,
      spanStartedAt: s.startedAt,
      outcome: r.outcome,
      flagged: r.flagged,
      findings: r.findings,
      evaluatedAt: now,
    };
  });
  for (let i = 0; i < rows.length; i += 200) {
    const inserted = await db
      .insert(traceEvaluations)
      .values(rows.slice(i, i + 200))
      .onConflictDoNothing()
      .returning({ outcome: traceEvaluations.outcome, flagged: traceEvaluations.flagged });
    for (const r of inserted) {
      if (r.outcome === "evaluated") out.evaluated += 1;
      else if (r.outcome === "withheld") out.withheld += 1;
      else out.noContent += 1;
      if (r.flagged) out.flagged += 1;
    }
  }
  return out;
}

/** per-agent summaries over the window; `agentIds` narrows when given */
export async function traceSummaryForAgents(
  db: Db,
  opts: { now?: Date; days?: number; agentIds?: string[] } = {},
): Promise<AgentTraceSummary[]> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.days ?? TRACE_EVAL_WINDOW_DAYS) * 86_400_000);
  if (opts.agentIds && opts.agentIds.length === 0) return [];
  const rows = await db
    .select({
      agentId: traceEvaluations.agentId,
      outcome: traceEvaluations.outcome,
      flagged: traceEvaluations.flagged,
      findings: traceEvaluations.findings,
    })
    .from(traceEvaluations)
    .where(
      and(
        gte(traceEvaluations.spanStartedAt, since),
        opts.agentIds ? inArray(traceEvaluations.agentId, opts.agentIds) : undefined,
      ),
    );
  return summarizeTraceEvaluations(
    rows
      .filter((r): r is typeof r & { agentId: string } => r.agentId !== null)
      .map((r) => ({ ...r, findings: r.findings as TraceFinding[] })),
  );
}

export function registerTraceEvaluationRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/governance/trace-evaluations", async (req) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(90).default(TRACE_EVAL_WINDOW_DAYS) }).parse(req.query);
    const summaries = await traceSummaryForAgents(db, { days: q.days });
    const names = summaries.length
      ? new Map(
          (
            await db
              .select({ id: agents.id, name: agents.name })
              .from(agents)
              .where(inArray(agents.id, summaries.map((s) => s.agentId)))
          ).map((a) => [a.id, a.name]),
        )
      : new Map<string, string>();
    const [last] = await db
      .select({ at: traceEvaluations.evaluatedAt })
      .from(traceEvaluations)
      .orderBy(desc(traceEvaluations.evaluatedAt))
      .limit(1);
    const total = (k: keyof AgentTraceSummary) => summaries.reduce((a, s) => a + (s[k] as number), 0);
    return {
      window: { days: q.days },
      lastEvaluatedAt: last?.at?.toISOString() ?? null,
      totals: {
        spans: total("spans"),
        evaluated: total("evaluated"),
        flagged: total("flagged"),
        withheld: total("withheld"),
        noContent: total("noContent"),
      },
      agents: summaries.map((s) => ({ ...s, agentName: names.get(s.agentId) ?? null })),
      notes: TRACE_EVALUATION_NOTES,
    };
  });

  app.post("/v1/governance/trace-evaluations/run", async () => runTraceEvaluationSweep(db));
}
