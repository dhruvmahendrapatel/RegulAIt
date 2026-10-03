/**
 * ADR-0070 — TRACE / SPAN OBSERVABILITY: the recorder and the read surface.
 *
 * WHAT THIS FILE IS FOR, IN ONE SENTENCE: it makes "why did nothing happen"
 * answerable, by recording a governance DENY as a PRESENT span carrying its
 * reason rather than as the absence of one.
 *
 * FIVE RULES, EACH OF WHICH IS A TEST IN `tracing.test.ts`.
 *
 *  1. **A SPAN REFERENCES; IT DOES NOT RESTATE.** `usageEventId`, `auditLogId`,
 *     `runId`, `nodeId`, `agentId` point at the rows that already hold the
 *     facts. The five denormalised fields (`provider`, `model`, both token
 *     counts, `costUsd`) exist ONLY so a tree of N spans renders in one query
 *     instead of N, they are copied FROM the referenced `usage_events` row in
 *     the same call, and the suite joins them back and asserts equality rather
 *     than trusting the copy.
 *
 *  2. **TRACING NEVER FAILS THE CALL IT IS TRACING.** Every write in this file
 *     is inside a try/catch that swallows and moves on. An observability layer
 *     that can 500 a governed dispatch is a liability, not an asset. The cost
 *     of that choice is stated honestly in the ADR: a trace can be INCOMPLETE
 *     (a span was lost) and the API says `partial: true` when the rollup and
 *     the stored spans disagree, so a hole is visible rather than silent.
 *
 *  3. **CONTENT RIDES THE EXISTING POSTURE.** An output preview is
 *     `result.outputText` — the text the dispatch core already ran through
 *     §8.4 PII and ADR-0042 guardrails, WITH the withheld marker already
 *     substituted — truncated, exactly as `eval_results.output_text` (ADR-0044)
 *     and the ADR-0065 training ingest store theirs. No fourth posture. When a
 *     block acted, `contentWithheld` is true and what is stored IS the marker.
 *
 *  4. **READING A TRACE IS DEFAULT-DENY.** A trace carries another person's
 *     prompts. Every read route here is self-scoped in-handler — the caller's
 *     own traces, or an admin's fleet-wide view — following ADR-0069's
 *     `GET /v1/users/:userId/cost-consolidated` precedent exactly. There is no
 *     "any authenticated user" path.
 *
 *  5. **NO DEFAULT OUTBOUND CONNECTION.** ADR-0041 makes air-gapped the primary
 *     motion. There is no default OTLP endpoint in this file, in the schema, or
 *     in any env var read here. With nothing configured the export route
 *     answers a real 409 naming what is missing, and traces work locally and
 *     completely. When an endpoint IS configured it is an admin-typed URL and
 *     it goes through the SAME ADR-0034/0062 egress guard `mcp_servers.url`
 *     goes through — re-adjudicated on EVERY export, not once at write time.
 *
 * RETENTION rides `runAuditPruneOnce`'s §8.3 compliance-cascade floor (see
 * `org-settings.ts`). There is deliberately no trace-retention knob: one would
 * let an operator keep prompts for a year under a framework that says ninety
 * days, which is the exact drift a cascade exists to prevent.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  and,
  asc,
  auditLog,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  sql,
  traceSpans,
  traces,
  type Db,
  type TraceKind,
  type TraceRow,
  type TraceSpanKind,
  type TraceSpanRow,
  type TraceStatus,
} from "@regulait/db";
import {
  OTLP_EXPORT_LIMITS,
  buildOtlpPayload,
  buildSpanTree,
  summariseSpanTree,
  tracePreview,
  type SpanRecord,
} from "@regulait/shared";
import { loadOrgSettings, otlpHeadersForExport } from "./org-settings.js";
import { loadEgressAllowList } from "./custom-providers.js";
import { checkEgress, createGuardedFetch } from "./egress-guard.js";

/**
 * The subset of the drizzle client the RECORDER uses, declared structurally so
 * a TRANSACTION can record too.
 *
 * Added 2026-08-15 with the `workflow_stage` writer: a workflow transition is
 * decided inside a transaction (the approvals-decide endpoint hands its OWN
 * open transaction down), and a recorder that only accepted the root `Db`
 * could not have traced the single most valuable workflow event there is —
 * an approval DENIED. Nothing here uses `$client`, so widening the parameter
 * costs nothing and hides nothing.
 */
export type SpanWriter = Pick<Db, "insert" | "update" | "select">;

export const TRACE_RULE_IDS = {
  read: "trace-read",
  exported: "traces-exported",
  exportRefused: "trace-export-refused",
  configUpdated: "tracing-config-updated",
} as const;

/**
 * The scope note every read surface returns, for the same reason ADR-0050's
 * `LINEAGE_COMPLETENESS_NOTE` exists: a viewer must not read more into a tree
 * than was recorded.
 */
export const TRACE_SCOPE_NOTE =
  "A trace shows what the GATEWAY mediated: governed model dispatches (including each fallback " +
  "hop), governed MCP tool calls, orchestration runs and their nodes, and the governance " +
  "decisions that refused any of them. It is not intra-model attribution, and it cannot see a " +
  "call that never passed through RegulAIt. Spans REFERENCE the usage_events and audit_log rows " +
  "that hold the underlying facts; the token/cost figures on a span are copied from the " +
  "usage_events row it names.";

// ---------------------------------------------------------------------------
// Policy snapshot
// ---------------------------------------------------------------------------

export interface TracingPolicy {
  enabled: boolean;
  captureContent: boolean;
  previewMaxChars: number;
}

export async function loadTracingPolicy(db: SpanWriter): Promise<TracingPolicy> {
  try {
    const org = await loadOrgSettings(db as Db);
    return {
      enabled: org.tracingEnabled !== false,
      captureContent: org.tracingCaptureContent !== false,
      previewMaxChars: org.tracingPreviewMaxChars ?? 4000,
    };
  } catch {
    // A settings read that fails must not fail the dispatch. Fail CLOSED on
    // content (never store a prompt we could not confirm we are allowed to
    // store) and closed on tracing itself.
    return { enabled: false, captureContent: false, previewMaxChars: 0 };
  }
}

// ---------------------------------------------------------------------------
// The context threaded through a governed call
// ---------------------------------------------------------------------------

export interface TraceContext {
  traceId: string;
  /** the span every span recorded under this context hangs from; null = root */
  parentSpanId: string | null;
  sessionId: string | null;
  policy: TracingPolicy;
}

export interface BeginTraceArgs {
  kind: TraceKind;
  name: string;
  userId: string;
  projectId?: string | null;
  sessionId?: string | null;
  rootRefId?: string | null;
}

/**
 * Open a trace. Returns null when tracing is off — every caller treats null as
 * "record nothing", which is what makes the disabled path byte-identical.
 */
export async function beginTrace(
  db: SpanWriter,
  args: BeginTraceArgs,
  policy?: TracingPolicy,
): Promise<TraceContext | null> {
  const p = policy ?? (await loadTracingPolicy(db));
  if (!p.enabled) return null;
  try {
    const [row] = await db
      .insert(traces)
      .values({
        kind: args.kind,
        name: args.name.slice(0, 200),
        userId: args.userId,
        projectId: args.projectId ?? null,
        sessionId: args.sessionId ?? null,
        rootRefId: args.rootRefId ?? null,
        status: "running",
      })
      .returning({ id: traces.id });
    if (!row) return null;
    return { traceId: row.id, parentSpanId: null, sessionId: args.sessionId ?? null, policy: p };
  } catch {
    return null;
  }
}

/**
 * Reuse the trace of an already-running root when one exists, else open a new
 * one. Used by the orchestration path so every node dispatch of a run lands in
 * ONE tree rather than N unrelated ones.
 */
export async function traceForRoot(
  db: SpanWriter,
  args: BeginTraceArgs,
  policy?: TracingPolicy,
): Promise<TraceContext | null> {
  const p = policy ?? (await loadTracingPolicy(db));
  if (!p.enabled) return null;
  if (args.rootRefId) {
    try {
      const [existing] = await db
        .select({ id: traces.id, sessionId: traces.sessionId })
        .from(traces)
        .where(and(eq(traces.kind, args.kind), eq(traces.rootRefId, args.rootRefId)))
        .orderBy(desc(traces.startedAt))
        .limit(1);
      if (existing) {
        return {
          traceId: existing.id,
          parentSpanId: null,
          sessionId: existing.sessionId,
          policy: p,
        };
      }
    } catch {
      /* fall through to a fresh trace */
    }
  }
  return beginTrace(db, args, p);
}

export interface RecordSpanArgs {
  kind: TraceSpanKind;
  name: string;
  status: TraceStatus;
  statusReason?: string | null;
  startedAt: Date;
  endedAt?: Date | null;
  /** overrides ctx.parentSpanId when a caller nests explicitly (a fallback hop
   * under the attempt that failed, a tool call under its turn) */
  parentSpanId?: string | null;
  usageEventId?: string | null;
  auditLogId?: string | null;
  runId?: string | null;
  nodeId?: string | null;
  agentId?: string | null;
  mcpServerId?: string | null;
  connectorId?: string | null;
  provider?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  /** ALREADY-ADJUDICATED text only (see rule 3). Truncated here; never scanned
   * here, because a second PII decision in a second place is how two postures
   * become three. */
  inputText?: string | null;
  outputText?: string | null;
  contentWithheld?: boolean;
  attributes?: Record<string, unknown> | null;
}

/**
 * Record one completed span, and fold its figures into the trace's rollups.
 *
 * TWO STATEMENTS, DELIBERATELY. The first is an atomic
 * `UPDATE ... RETURNING span_count`, which does double duty: it maintains the
 * list-view rollups AND allocates the span's `seq`. A monotonic per-trace
 * counter is what makes sibling order deterministic — millisecond timestamps
 * collide on an in-process path, and a tree whose children reorder between two
 * reads is not a trace.
 */
export async function recordSpan(
  db: SpanWriter,
  ctx: TraceContext | null,
  args: RecordSpanArgs,
): Promise<string | null> {
  if (!ctx) return null;
  try {
    const ended = args.endedAt ?? new Date();
    const durationMs = Math.max(0, ended.getTime() - args.startedAt.getTime());
    const [counted] = await db
      .update(traces)
      .set({
        spanCount: sql`${traces.spanCount} + 1`,
        deniedSpanCount:
          args.status === "denied" ? sql`${traces.deniedSpanCount} + 1` : sql`${traces.deniedSpanCount}`,
        inputTokens: sql`${traces.inputTokens} + ${args.inputTokens ?? 0}`,
        outputTokens: sql`${traces.outputTokens} + ${args.outputTokens ?? 0}`,
        costUsd:
          args.costUsd == null
            ? sql`${traces.costUsd}`
            : sql`coalesce(${traces.costUsd}, 0) + ${args.costUsd}`,
      })
      .where(eq(traces.id, ctx.traceId))
      .returning({ seq: traces.spanCount });
    if (!counted) return null;

    const capture = ctx.policy.captureContent;
    const max = ctx.policy.previewMaxChars;
    const [row] = await db
      .insert(traceSpans)
      .values({
        traceId: ctx.traceId,
        parentSpanId: args.parentSpanId === undefined ? ctx.parentSpanId : args.parentSpanId,
        seq: counted.seq,
        kind: args.kind,
        name: args.name.slice(0, 200),
        status: args.status,
        statusReason: args.statusReason ?? null,
        startedAt: args.startedAt,
        endedAt: ended,
        durationMs,
        usageEventId: args.usageEventId ?? null,
        auditLogId: args.auditLogId ?? null,
        runId: args.runId ?? null,
        nodeId: args.nodeId ?? null,
        agentId: args.agentId ?? null,
        mcpServerId: args.mcpServerId ?? null,
        connectorId: args.connectorId ?? null,
        provider: args.provider ?? null,
        model: args.model ?? null,
        inputTokens: args.inputTokens ?? null,
        outputTokens: args.outputTokens ?? null,
        costUsd: args.costUsd ?? null,
        inputPreview: capture ? tracePreview(args.inputText, max) : null,
        outputPreview: capture ? tracePreview(args.outputText, max) : null,
        contentWithheld: args.contentWithheld ?? false,
        attributes: args.attributes ?? null,
      })
      .returning({ id: traceSpans.id });
    return row?.id ?? null;
  } catch {
    // Rule 2. A lost span is a hole the read surface reports; a thrown one
    // would be a 500 on a call that governance already allowed.
    return null;
  }
}

/** Open a CONTAINER span (a run, a node) that will be closed later. */
export async function openSpan(
  db: SpanWriter,
  ctx: TraceContext | null,
  args: Omit<RecordSpanArgs, "status" | "endedAt"> & { status?: TraceStatus },
): Promise<string | null> {
  return recordSpan(db, ctx, { ...args, status: args.status ?? "running", endedAt: args.startedAt });
}

/** Close a container span opened above. Duration is recomputed from the stored
 * `startedAt`, so a container's elapsed time is real rather than zero. */
export async function closeSpan(
  db: SpanWriter,
  spanId: string | null,
  status: TraceStatus,
  statusReason?: string | null,
): Promise<void> {
  if (!spanId) return;
  try {
    const now = new Date();
    const [existing] = await db
      .select({ startedAt: traceSpans.startedAt })
      .from(traceSpans)
      .where(eq(traceSpans.id, spanId));
    if (!existing) return;
    await db
      .update(traceSpans)
      .set({
        status,
        ...(statusReason !== undefined ? { statusReason } : {}),
        endedAt: now,
        durationMs: Math.max(0, now.getTime() - existing.startedAt.getTime()),
      })
      .where(eq(traceSpans.id, spanId));
  } catch {
    /* rule 2 */
  }
}

/**
 * Close the trace itself. `startedAt` is optional and is a PERFORMANCE choice,
 * not a correctness one: the hot dispatch path already holds the start instant,
 * so passing it turns the close into ONE statement instead of a read plus a
 * write. Omitting it re-reads the stored value.
 */
export async function finishTrace(
  db: SpanWriter,
  ctx: TraceContext | null,
  status: TraceStatus,
  startedAt?: Date,
): Promise<void> {
  if (!ctx) return;
  try {
    let start = startedAt;
    if (!start) {
      const [row] = await db
        .select({ startedAt: traces.startedAt })
        .from(traces)
        .where(eq(traces.id, ctx.traceId));
      if (!row) return;
      start = row.startedAt;
    }
    const now = new Date();
    await db
      .update(traces)
      .set({ status, endedAt: now, durationMs: Math.max(0, now.getTime() - start.getTime()) })
      .where(eq(traces.id, ctx.traceId));
  } catch {
    /* rule 2 */
  }
}

/** A child context under a given span — the one way a caller nests. */
export function childContext(ctx: TraceContext | null, parentSpanId: string | null): TraceContext | null {
  if (!ctx) return null;
  return { ...ctx, parentSpanId };
}

// ---------------------------------------------------------------------------
// Read projections
// ---------------------------------------------------------------------------

function spanProjection(s: TraceSpanRow): SpanRecord & { orphaned?: boolean } {
  return {
    id: s.id,
    traceId: s.traceId,
    parentSpanId: s.parentSpanId,
    seq: s.seq,
    kind: s.kind,
    name: s.name,
    status: s.status,
    statusReason: s.statusReason,
    startedAt: s.startedAt.toISOString(),
    endedAt: s.endedAt ? s.endedAt.toISOString() : null,
    durationMs: s.durationMs,
    usageEventId: s.usageEventId,
    auditLogId: s.auditLogId,
    runId: s.runId,
    nodeId: s.nodeId,
    agentId: s.agentId,
    mcpServerId: s.mcpServerId,
    connectorId: s.connectorId,
    provider: s.provider,
    model: s.model,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    costUsd: s.costUsd,
    inputPreview: s.inputPreview,
    outputPreview: s.outputPreview,
    contentWithheld: s.contentWithheld,
    attributes: (s.attributes ?? null) as Record<string, unknown> | null,
  };
}

function traceProjection(t: TraceRow) {
  return {
    id: t.id,
    sessionId: t.sessionId,
    kind: t.kind,
    rootRefId: t.rootRefId,
    name: t.name,
    userId: t.userId,
    projectId: t.projectId,
    status: t.status,
    startedAt: t.startedAt.toISOString(),
    endedAt: t.endedAt ? t.endedAt.toISOString() : null,
    durationMs: t.durationMs,
    spanCount: t.spanCount,
    deniedSpanCount: t.deniedSpanCount,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    costUsd: t.costUsd,
  };
}

/** Load one trace's spans in a SINGLE query — never one query per node. */
export async function loadTraceSpans(db: Db, traceId: string, limit = 2000): Promise<TraceSpanRow[]> {
  return db
    .select()
    .from(traceSpans)
    .where(eq(traceSpans.traceId, traceId))
    .orderBy(asc(traceSpans.seq), asc(traceSpans.id))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listQuerySchema = z.object({
  userId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  sessionId: z.string().min(1).max(200).optional(),
  kind: z.enum(["dispatch", "run", "workflow", "conversation", "tool", "eval"]).optional(),
  status: z.enum(["running", "ok", "error", "denied"]).optional(),
  /** the killer filter: show me the traces where governance refused something */
  deniedOnly: z.coerce.boolean().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const exportSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  traceIds: z.array(z.string().uuid()).max(200).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  /** dry run: build the payload, adjudicate egress, send nothing */
  dryRun: z.boolean().optional(),
});

export const MAX_SPANS_PER_TRACE = 2000;

export function registerTracingRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string } = {}): void {
  /** the bootstrap credential has no user identity; the trail records the nil
   * uuid rather than refusing to write a row (same idiom as cost-import.ts) */
  const NIL_UUID = "00000000-0000-0000-0000-000000000000";
  const audit = async (
    userId: string | null,
    objectId: string | null,
    ruleId: string,
    effect: "allow" | "deny",
    reason: string,
    detail: Record<string, unknown> = {},
  ) => {
    await db.insert(auditLog).values({
      userId: userId ?? NIL_UUID,
      objectType: "trace",
      objectId,
      detail,
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });
  };

  /**
   * LIST. A non-admin is FORCED to their own traces — not filtered by default,
   * forced: passing `userId` for somebody else is a 403, not a silently-ignored
   * parameter, because a query string that quietly means something other than
   * what it says is how a read boundary erodes.
   *
   * ORDER IS EXPLICIT AND TOTAL (`startedAt DESC, id DESC`). A list endpoint
   * without a deterministic order has bitten this project before.
   */
  app.get("/v1/traces", async (req, reply) => {
    const q = listQuerySchema.parse(req.query ?? {});
    const isAdmin = req.authCtx.isAdmin;
    if (!isAdmin && q.userId && q.userId !== req.authCtx.userId) {
      return reply.status(403).send({
        error: "forbidden",
        detail:
          "you may list only your own traces; another person's prompts are an admin surface " +
          "(same posture as GET /v1/users/:userId/cost-consolidated)",
      });
    }
    const scopedUserId = isAdmin ? (q.userId ?? null) : req.authCtx.userId;
    const conds = [];
    if (scopedUserId) conds.push(eq(traces.userId, scopedUserId));
    if (q.projectId) conds.push(eq(traces.projectId, q.projectId));
    if (q.sessionId) conds.push(eq(traces.sessionId, q.sessionId));
    if (q.kind) conds.push(eq(traces.kind, q.kind));
    if (q.status) conds.push(eq(traces.status, q.status));
    if (q.deniedOnly) conds.push(sql`${traces.deniedSpanCount} > 0`);
    if (q.from) conds.push(gte(traces.startedAt, new Date(q.from)));
    if (q.to) conds.push(lte(traces.startedAt, new Date(q.to)));
    const rows = await db
      .select()
      .from(traces)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(traces.startedAt), desc(traces.id))
      .limit(q.limit ?? 50);
    return {
      traces: rows.map(traceProjection),
      scope: isAdmin && !q.userId ? "fleet" : "self",
      note: TRACE_SCOPE_NOTE,
    };
  });

  /**
   * SESSIONS. The thread grouping: a multi-turn conversation or a long-running
   * workflow reads as one thing. One grouped query, not N.
   */
  app.get("/v1/sessions", async (req, reply) => {
    const q = listQuerySchema.parse(req.query ?? {});
    const isAdmin = req.authCtx.isAdmin;
    if (!isAdmin && q.userId && q.userId !== req.authCtx.userId) {
      return reply.status(403).send({
        error: "forbidden",
        detail: "you may list only your own sessions",
      });
    }
    const scopedUserId = isAdmin ? (q.userId ?? null) : req.authCtx.userId;
    const conds = [isNotNull(traces.sessionId)];
    if (scopedUserId) conds.push(eq(traces.userId, scopedUserId));
    if (q.projectId) conds.push(eq(traces.projectId, q.projectId));
    if (q.from) conds.push(gte(traces.startedAt, new Date(q.from)));
    if (q.to) conds.push(lte(traces.startedAt, new Date(q.to)));
    const rows = await db
      .select({
        sessionId: traces.sessionId,
        kind: traces.kind,
        userId: traces.userId,
        projectId: traces.projectId,
        traceCount: sql<number>`count(*)::int`,
        spanCount: sql<number>`sum(${traces.spanCount})::int`,
        deniedSpanCount: sql<number>`sum(${traces.deniedSpanCount})::int`,
        inputTokens: sql<number>`sum(${traces.inputTokens})::int`,
        outputTokens: sql<number>`sum(${traces.outputTokens})::int`,
        costUsd: sql<number | null>`sum(${traces.costUsd})`,
        startedAt: sql<string>`min(${traces.startedAt})`,
        lastAt: sql<string>`max(${traces.startedAt})`,
      })
      .from(traces)
      .where(and(...conds))
      .groupBy(traces.sessionId, traces.kind, traces.userId, traces.projectId)
      .orderBy(sql`max(${traces.startedAt}) desc`, sql`${traces.sessionId} desc`)
      .limit(q.limit ?? 50);
    return {
      sessions: rows,
      scope: isAdmin && !q.userId ? "fleet" : "self",
      note: TRACE_SCOPE_NOTE,
    };
  });

  /** THE TREE. One query for the trace, one for its spans — never N. */
  app.get("/v1/traces/:traceId", async (req, reply) => {
    const { traceId } = z.object({ traceId: z.string().uuid() }).parse(req.params);
    const [row] = await db.select().from(traces).where(eq(traces.id, traceId));
    if (!row) return reply.status(404).send({ error: "not_found" });
    if (!req.authCtx.isAdmin && row.userId !== req.authCtx.userId) {
      await audit(
        req.authCtx.userId,
        traceId,
        TRACE_RULE_IDS.read,
        "deny",
        "refused a read of another user's trace",
      );
      return reply.status(403).send({
        error: "forbidden",
        detail:
          "you may read only your own traces; a trace carries another person's prompts and tool " +
          "arguments, so cross-user reads are an admin surface",
      });
    }
    const spanRows = await loadTraceSpans(db, traceId, MAX_SPANS_PER_TRACE + 1);
    const truncated = spanRows.length > MAX_SPANS_PER_TRACE;
    const kept = truncated ? spanRows.slice(0, MAX_SPANS_PER_TRACE) : spanRows;
    const projected = kept.map(spanProjection);
    const tree = buildSpanTree(projected);
    const totals = summariseSpanTree(projected);
    return {
      trace: traceProjection(row),
      tree,
      totals,
      // Rule 2's honest residual, surfaced: if the trace's own rollup counted
      // more spans than are stored, a write was lost and the tree is INCOMPLETE.
      partial: !truncated && row.spanCount > projected.length,
      truncated,
      ...(truncated ? { spanLimit: MAX_SPANS_PER_TRACE } : {}),
      note: TRACE_SCOPE_NOTE,
    };
  });

  /** The exporter posture. Admin-only via the default gate. */
  app.get("/v1/tracing/config", async (req) => {
    const org = await loadOrgSettings(db);
    const headers = (org.tracingOtlpHeaders ?? null) as Record<string, string> | null;
    void req;
    return {
      enabled: org.tracingEnabled !== false,
      captureContent: org.tracingCaptureContent !== false,
      previewMaxChars: org.tracingPreviewMaxChars ?? 4000,
      otlp: {
        configured: !!org.tracingOtlpEndpoint,
        endpoint: org.tracingOtlpEndpoint ?? null,
        serviceName: org.tracingOtlpServiceName ?? "regulait-gateway",
        // values redacted: an OTLP collector header is usually a bearer token
        headerNames: headers ? Object.keys(headers) : [],
      },
      limits: OTLP_EXPORT_LIMITS,
      retention:
        "Traces are pruned by the SAME §8.3 compliance-cascade audit-retention floor that prunes " +
        "the audit log (org-settings `defaultAuditRetentionDays` composed with every compliance " +
        "profile's `auditRetentionDays`, longest wins). There is deliberately no trace-specific " +
        "retention knob.",
      note: TRACE_SCOPE_NOTE,
    };
  });

  /**
   * EXPORT. Admin-only, opt-in, and refuses honestly:
   *   - no endpoint configured -> 409 `otlp_not_configured` (the shipped state
   *     of an air-gapped install, and NOT an error condition — traces work
   *     locally with no exporter at all);
   *   - endpoint not on the egress allow-list -> 403 `egress_blocked`, the same
   *     verdict from the same table every other outbound surface consults.
   */
  app.post("/v1/tracing/export", async (req, reply) => {
    const body = exportSchema.parse(req.body ?? {});
    const org = await loadOrgSettings(db);
    const endpoint = org.tracingOtlpEndpoint;
    if (!endpoint) {
      await audit(
        req.authCtx.userId,
        null,
        TRACE_RULE_IDS.exportRefused,
        "deny",
        "trace export refused: no OTLP endpoint is configured",
      );
      return reply.status(409).send({
        error: "otlp_not_configured",
        detail:
          "no OTLP endpoint is configured (org setting `tracingOtlpEndpoint`). This is the shipped " +
          "state and is not a fault: RegulAIt never opens an outbound telemetry connection by " +
          "default, because ADR-0041 makes air-gapped the primary deployment motion. Traces are " +
          "fully usable locally with no exporter configured.",
        limits: OTLP_EXPORT_LIMITS,
      });
    }

    // THE EGRESS GUARD, on EVERY export rather than once at write time: DNS can
    // be re-pointed and an allow entry can be withdrawn after an admin typed
    // the URL. Same table, same decision function, as ADR-0043's mcp_servers.url.
    const allowList = await loadEgressAllowList(db);
    const decision = await checkEgress(endpoint, { allowList });
    if (!decision.ok) {
      await audit(
        req.authCtx.userId,
        null,
        TRACE_RULE_IDS.exportRefused,
        "deny",
        `trace export refused by the egress guard: ${decision.reason}`,
        { endpoint, code: decision.code },
      );
      return reply.status(403).send({ error: "egress_blocked", detail: decision.reason });
    }

    const conds = [];
    if (body.traceIds?.length) conds.push(inArray(traces.id, body.traceIds));
    if (body.from) conds.push(gte(traces.startedAt, new Date(body.from)));
    if (body.to) conds.push(lte(traces.startedAt, new Date(body.to)));
    const traceRows = await db
      .select()
      .from(traces)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(traces.startedAt), desc(traces.id))
      .limit(body.limit ?? 100);

    const bundles: Array<{ trace: ReturnType<typeof traceProjection>; spans: SpanRecord[] }> = [];
    if (traceRows.length > 0) {
      // ONE query for every span of every exported trace — not one per trace.
      const spanRows = await db
        .select()
        .from(traceSpans)
        .where(inArray(traceSpans.traceId, traceRows.map((t) => t.id)))
        .orderBy(asc(traceSpans.traceId), asc(traceSpans.seq));
      const byTrace = new Map<string, SpanRecord[]>();
      for (const s of spanRows) {
        const list = byTrace.get(s.traceId) ?? [];
        list.push(spanProjection(s));
        byTrace.set(s.traceId, list);
      }
      for (const t of traceRows) {
        bundles.push({ trace: traceProjection(t), spans: byTrace.get(t.id) ?? [] });
      }
    }

    const payload = buildOtlpPayload({
      serviceName: org.tracingOtlpServiceName ?? "regulait-gateway",
      traces: bundles,
      // Content leaves the deployment ONLY when the org already allows storing
      // it. An install with capture off exports the tree, timings, costs and
      // deny reasons and no prompt text.
      includeContent: org.tracingCaptureContent !== false,
      ...(process.env["REGULAIT_DEPLOY_MODE"]
        ? { deploymentMode: process.env["REGULAIT_DEPLOY_MODE"] }
        : {}),
    });

    if (body.dryRun) {
      return {
        dryRun: true,
        endpoint,
        traceCount: payload.traceCount,
        spanCount: payload.spanCount,
        body: payload.body,
        limits: OTLP_EXPORT_LIMITS,
      };
    }

    // ADR-0167 (SEC-06): the collector headers are decrypted HERE, at the
    // moment they leave as request headers, and nowhere else.
    const stored = otlpHeadersForExport(org, opts.dataKey);
    if (!stored.ok) return reply.status(503).send({ error: "no_data_key", detail: stored.detail });
    const headers = stored.headers;
    // The SAME guarded fetch every other adjudicated outbound surface uses:
    // re-validates the destination on each request, pins the connection to the
    // validated addresses, refuses redirects.
    const guarded = createGuardedFetch({ allowList });
    let status: number;
    let responseText = "";
    try {
      const res = await guarded(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(payload.body),
      });
      status = res.status;
      responseText = (await res.text()).slice(0, 500);
    } catch (e) {
      await audit(
        req.authCtx.userId,
        null,
        TRACE_RULE_IDS.exportRefused,
        "deny",
        `trace export to ${endpoint} failed: ${(e as Error).message}`,
        { endpoint, traceCount: payload.traceCount },
      );
      return reply.status(502).send({
        error: "otlp_export_failed",
        detail: `POST to the configured OTLP endpoint failed: ${(e as Error).message}. Nothing was ` +
          `spooled and nothing will be retried — re-run the export.`,
      });
    }
    const ok = status >= 200 && status < 300;
    await audit(
      req.authCtx.userId,
      null,
      ok ? TRACE_RULE_IDS.exported : TRACE_RULE_IDS.exportRefused,
      ok ? "allow" : "deny",
      ok
        ? `exported ${payload.spanCount} span(s) across ${payload.traceCount} trace(s) to ${endpoint}`
        : `OTLP endpoint ${endpoint} rejected the export with HTTP ${status}`,
      { endpoint, traceCount: payload.traceCount, spanCount: payload.spanCount, status },
    );
    if (!ok) {
      return reply.status(502).send({
        error: "otlp_export_rejected",
        detail: `the configured OTLP endpoint answered HTTP ${status}: ${responseText}`,
      });
    }
    return {
      exported: true,
      endpoint,
      traceCount: payload.traceCount,
      spanCount: payload.spanCount,
      contentIncluded: org.tracingCaptureContent !== false,
      limits: OTLP_EXPORT_LIMITS,
    };
  });
}
