/**
 * ADR-0160 — CONTINUOUS TRACE EVALUATION, the gateway half.
 *
 * `runTraceEvaluationSweep` takes the next batch of completed model-call spans
 * (`llm`, `fallback_hop`; status `ok`) that have no evaluation yet, runs the
 * pure evaluator from `packages/shared/src/trace-evaluation.ts` over their
 * stored previews, and writes one counts-only row per span. The cursor is the
 * newest evaluated `span_started_at`, re-read with an overlap; the unique span
 * id makes the overlap harmless.
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
const OVERLAP_MS = 10 * 60_000;
const FIRST_RUN_LOOKBACK_MS = TRACE_EVAL_WINDOW_DAYS * 86_400_000;

export interface TraceSweepResult {
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
  const [cursorRow] = await db
    .select({ at: sql<Date | null>`max(${traceEvaluations.spanStartedAt})` })
    .from(traceEvaluations);
  const cursor = cursorRow?.at ? new Date(new Date(cursorRow.at).getTime() - OVERLAP_MS) : new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS);

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
        gte(traceSpans.startedAt, cursor),
        isNull(traceEvaluations.id),
      ),
    )
    .orderBy(traceSpans.startedAt)
    .limit(limit);

  const out: TraceSweepResult = { scanned: spans.length, evaluated: 0, flagged: 0, withheld: 0, noContent: 0, capped: spans.length === limit };
  if (spans.length === 0) return out;
  const rows = spans.map((s) => {
    const r = evaluateTraceContent(s);
    if (r.outcome === "evaluated") out.evaluated += 1;
    else if (r.outcome === "withheld") out.withheld += 1;
    else out.noContent += 1;
    if (r.flagged) out.flagged += 1;
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
    await db.insert(traceEvaluations).values(rows.slice(i, i + 200)).onConflictDoNothing();
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
