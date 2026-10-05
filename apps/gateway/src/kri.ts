/**
 * ADR-0173 batch 2c (K) — KEY RISK INDICATORS and the SERIES the monitoring
 * page plots. Admin-only, every route (none is in NON_ADMIN_ROUTES): a KRI is
 * a policy surface, and a series reads every user's traces.
 *
 *   GET    /v1/kris                 every KRI with its current measurement
 *   POST   /v1/kris                 create
 *   PATCH  /v1/kris/:kriId          edit (disabling resolves its open episode)
 *   DELETE /v1/kris/:kriId          delete (resolves its open episode)
 *   GET    /v1/monitoring/series    one metric bucketed over time, optionally per agent/project
 *
 * MEASUREMENT. One aggregate over `traces` (and `trace_scores` for feedback)
 * per KRI, in its window, in its scope. Percentiles are Postgres
 * `percentile_cont` (linear interpolation; the test checks it against
 * simple-statistics on a fixture). The governance monitor calls
 * `kriMonitorInput` on its pass and owns the episodes (rule
 * `kri_threshold_breached`, subject `kri:<id>`).
 *
 * NO CONTENT. Every query here selects aggregates over ids, statuses,
 * durations, costs and score values only — never a preview, an attribute bag,
 * a status reason or a comment. The test reads the generated SQL and fails if
 * any content column appears.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  agents,
  and,
  auditLog,
  eq,
  governanceAlerts,
  gte,
  inArray,
  isNotNull,
  kris,
  lte,
  ne,
  projects,
  sql,
  traceScores,
  traceSpans,
  traces,
  type Db,
  type KriRow,
  type SQL,
} from "@regulait/db";
import {
  KRI_METRICS,
  SERIES_BUCKETS,
  evaluateKri,
  foldTopGroups,
  kriCreateSchema,
  kriMetricIsAdditive,
  kriSubjectKey,
  kriUpdateSchema,
  seriesQuerySchema,
  type KriMetric,
  type MonitorKriInput,
  type SeriesQuery,
} from "@regulait/shared";

const NIL_USER = "00000000-0000-0000-0000-000000000000";

export const KRI_AUDIT_RULE_IDS = {
  created: "kri-created",
  updated: "kri-updated",
  deleted: "kri-deleted",
} as const;

/** the governance-monitor rule a KRI raises (packages/shared/src/governance-monitor.ts) */
export const KRI_MONITOR_RULE = "kri_threshold_breached";

// ---------------------------------------------------------------------------
// measurement
// ---------------------------------------------------------------------------

/** A KRI's own scope (fleet, one agent, one project), or — ADR-0180 A2 — an
 * ASSURANCE scope: a use case's project PLUS its agent set (a trace counts
 * when it is in the project OR any of its spans ran one of the agents). An
 * assurance scope with neither a project nor an agent matches nothing, never
 * the whole fleet. Only the measurement takes `assurance`; a stored KRI's
 * scope stays fleet/agent/project. */
export type KriScopeSpec =
  | { scope: "fleet" | "agent" | "project"; scopeId: string | null }
  | { scope: "assurance"; projectId: string | null; agentIds: readonly string[] };

/** the trace predicate for a scope */
function scopeCondition(s: KriScopeSpec): SQL {
  if (s.scope === "assurance") {
    const parts: SQL[] = [];
    if (s.projectId) parts.push(eq(traces.projectId, s.projectId));
    if (s.agentIds.length > 0) {
      parts.push(
        sql`exists (select 1 from ${traceSpans} where ${traceSpans.traceId} = ${traces.id} and ${inArray(traceSpans.agentId, [...s.agentIds])})`,
      );
    }
    if (parts.length === 0) return sql`false`;
    return parts.length === 1 ? parts[0]! : sql`(${sql.join(parts, sql` or `)})`;
  }
  if (s.scope === "project" && s.scopeId) return eq(traces.projectId, s.scopeId);
  if (s.scope === "agent" && s.scopeId) {
    return sql`exists (select 1 from ${traceSpans} where ${traceSpans.traceId} = ${traces.id} and ${traceSpans.agentId} = ${s.scopeId})`;
  }
  return sql`true`;
}

/** the aggregates every trace metric is computed from — counts, durations and
 * costs only */
function traceAggregates() {
  return {
    n: sql<number>`count(*)::int`,
    finished: sql<number>`(count(*) filter (where ${traces.status} <> 'running'))::int`,
    errors: sql<number>`(count(*) filter (where ${traces.status} = 'error'))::int`,
    timed: sql<number>`count(${traces.durationMs})::int`,
    p50: sql<number | null>`percentile_cont(0.5) within group (order by ${traces.durationMs})`,
    p99: sql<number | null>`percentile_cont(0.99) within group (order by ${traces.durationMs})`,
    priced: sql<number>`count(${traces.costUsd})::int`,
    cost: sql<number | null>`sum(${traces.costUsd})`,
  };
}

interface TraceAgg {
  n: number;
  finished: number;
  errors: number;
  timed: number;
  p50: number | null;
  p99: number | null;
  priced: number;
  cost: number | null;
}

function traceMetricValue(metric: Exclude<KriMetric, "feedback_score">, a: TraceAgg): { value: number | null; samples: number } {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  switch (metric) {
    case "trace_volume":
      return { value: Number(a.n), samples: Number(a.n) };
    case "error_rate":
      return { value: Number(a.finished) > 0 ? (Number(a.errors) / Number(a.finished)) * 100 : null, samples: Number(a.finished) };
    case "latency_p50":
      return { value: num(a.p50), samples: Number(a.timed) };
    case "latency_p99":
      return { value: num(a.p99), samples: Number(a.timed) };
    case "cost_usd":
      // a window total: no traces at all is a spend of 0; traces none of
      // which was priced is an unknown spend, never an invented 0
      return { value: Number(a.priced) > 0 ? num(a.cost) : Number(a.n) === 0 ? 0 : null, samples: Number(a.priced) };
  }
}

/** the KRI measurement query over traces (exported so a test can read its SQL) */
export function kriTraceQuery(db: Db, s: KriScopeSpec, since: Date, until: Date) {
  return db
    .select(traceAggregates())
    .from(traces)
    .where(and(gte(traces.startedAt, since), lte(traces.startedAt, until), scopeCondition(s)));
}

/** the feedback query: annotation scores on traces in the window and scope */
export function kriFeedbackQuery(db: Db, s: KriScopeSpec, since: Date, until: Date, scoreName: string | null) {
  return db
    .select({ n: sql<number>`count(${traceScores.value})::int`, avg: sql<number | null>`avg(${traceScores.value})` })
    .from(traceScores)
    .innerJoin(traces, eq(traces.id, traceScores.traceId))
    .where(
      and(
        eq(traceScores.source, "annotation"),
        scoreName ? eq(traceScores.name, scoreName) : undefined,
        gte(traces.startedAt, since),
        lte(traces.startedAt, until),
        scopeCondition(s),
      ),
    );
}

export async function measureKri(
  db: Db,
  k: Pick<KriRow, "metric" | "scope" | "scopeId" | "windowDays" | "scoreName">,
  now: Date,
): Promise<{ value: number | null; samples: number }> {
  const since = new Date(now.getTime() - k.windowDays * 86_400_000);
  const s = { scope: k.scope, scopeId: k.scopeId };
  if (k.metric === "feedback_score") {
    const [r] = await kriFeedbackQuery(db, s, since, now, k.scoreName);
    const n = Number(r?.n ?? 0);
    return { value: n > 0 && r?.avg !== null && r?.avg !== undefined ? Number(r.avg) : null, samples: n };
  }
  const [a] = await kriTraceQuery(db, s, since, now);
  return traceMetricValue(k.metric, a as TraceAgg);
}

/**
 * ADR-0180 A2 — one trace metric over an ASSURANCE scope (a use case's project
 * plus its agent set): the same aggregate a KRI uses, plus the ids of the
 * finished traces it rests on (for `error_rate` the error traces first; then
 * newest first; at most `evidenceLimit`). Content-free like every query here.
 */
export async function measureTraceMetricForScope(
  db: Db,
  metric: Exclude<KriMetric, "feedback_score">,
  scope: { projectId: string | null; agentIds: readonly string[] },
  since: Date,
  until: Date,
  evidenceLimit = 20,
): Promise<{ value: number | null; samples: number; traceIds: string[] }> {
  const s: KriScopeSpec = { scope: "assurance", projectId: scope.projectId, agentIds: scope.agentIds };
  const [a] = await kriTraceQuery(db, s, since, until);
  const m = traceMetricValue(metric, a as TraceAgg);
  const evidence = await db
    .select({ id: traces.id })
    .from(traces)
    .where(
      and(
        gte(traces.startedAt, since),
        lte(traces.startedAt, until),
        scopeCondition(s),
        ne(traces.status, "running"),
      ),
    )
    .orderBy(
      ...(metric === "error_rate" ? [sql`(${traces.status} = 'error') desc`] : []),
      sql`${traces.startedAt} desc`,
    )
    .limit(evidenceLimit);
  return { ...m, traceIds: evidence.map((r) => r.id) };
}

async function scopeLabels(db: Db, rows: Array<Pick<KriRow, "scope" | "scopeId">>): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const agentIds = [...new Set(rows.filter((r) => r.scope === "agent" && r.scopeId).map((r) => r.scopeId!))];
  const projectIds = [...new Set(rows.filter((r) => r.scope === "project" && r.scopeId).map((r) => r.scopeId!))];
  if (agentIds.length) {
    for (const a of await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))) {
      labels.set(a.id, a.name);
    }
  }
  if (projectIds.length) {
    for (const p of await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, projectIds))) {
      labels.set(p.id, p.name);
    }
  }
  return labels;
}

/** what the governance monitor evaluates: every KRI, enabled ones measured */
export async function kriMonitorInput(db: Db, now: Date): Promise<MonitorKriInput[]> {
  const rows = await db.select().from(kris);
  const labels = await scopeLabels(db, rows);
  const out: MonitorKriInput[] = [];
  for (const k of rows) {
    const m = k.enabled ? await measureKri(db, k, now) : { value: null, samples: 0 };
    out.push({
      id: k.id,
      name: k.name,
      metric: k.metric,
      scope: k.scope,
      scopeId: k.scopeId,
      scopeLabel: k.scopeId ? (labels.get(k.scopeId) ?? null) : null,
      windowDays: k.windowDays,
      comparator: k.comparator,
      threshold: k.threshold,
      minSamples: k.minSamples,
      severity: k.severity,
      enabled: k.enabled,
      value: m.value,
      samples: m.samples,
    });
  }
  return out;
}

/** resolve a KRI's open episode now (on delete or disable), audited */
export async function resolveKriEpisode(db: Db, kriId: string, actorUserId: string | null, why: string): Promise<number> {
  const now = new Date();
  const rows = await db
    .update(governanceAlerts)
    .set({ status: "resolved", resolvedAt: now })
    .where(
      and(
        eq(governanceAlerts.ruleId, KRI_MONITOR_RULE),
        eq(governanceAlerts.subjectKey, kriSubjectKey(kriId)),
        ne(governanceAlerts.status, "resolved"),
      ),
    )
    .returning({ id: governanceAlerts.id, title: governanceAlerts.title });
  for (const r of rows) {
    await db.insert(auditLog).values({
      userId: actorUserId ?? NIL_USER,
      objectType: "governance_alert",
      objectId: r.id,
      detail: { ruleId: KRI_MONITOR_RULE, subjectKey: kriSubjectKey(kriId), why },
      effect: "allow",
      ruleId: "governance-alert-resolved",
      ruleChain: [],
      reason: `governance alert resolved — ${why}: ${r.title}`,
    });
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// series
// ---------------------------------------------------------------------------

/**
 * (trace, agent) pairs for `groupBy=agent`, BOUNDED BY THE SERIES WINDOW: only
 * spans of traces that started in [from, to] (and in the project, when one is
 * named) are read, through `traces_started_idx` and the spans' trace index,
 * never every span ever recorded. The bound is on the TRACE's start, exactly
 * the predicate the outer query applies, so no pair the series counts is lost
 * (a span's own `started_at` is caller-supplied and may precede its trace's).
 */
function agentPairs(db: Db, q: SeriesQuery) {
  const windowTraces = db
    .select({ id: traces.id })
    .from(traces)
    .where(
      and(
        gte(traces.startedAt, new Date(q.from)),
        lte(traces.startedAt, new Date(q.to)),
        q.projectId ? eq(traces.projectId, q.projectId) : undefined,
      ),
    );
  return db
    .selectDistinct({ traceId: traceSpans.traceId, agentId: traceSpans.agentId })
    .from(traceSpans)
    .where(and(isNotNull(traceSpans.agentId), inArray(traceSpans.traceId, windowTraces)))
    .as("trace_agents");
}

/** the series query (exported so a test can read its SQL) */
export function seriesTraceQuery(db: Db, q: SeriesQuery) {
  const unit = q.bucket;
  const bucket = sql<string>`to_char(date_trunc(${unit}, ${traces.startedAt} at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:00:00"Z"')`;
  const conds = and(
    gte(traces.startedAt, new Date(q.from)),
    lte(traces.startedAt, new Date(q.to)),
    q.projectId ? eq(traces.projectId, q.projectId) : undefined,
    q.agentId ? scopeCondition({ scope: "agent", scopeId: q.agentId }) : undefined,
  );
  if (q.groupBy === "agent") {
    const pairs = agentPairs(db, q);
    return db
      .select({ bucket, group: sql<string>`${pairs.agentId}::text`, ...traceAggregates() })
      .from(traces)
      .innerJoin(pairs, eq(pairs.traceId, traces.id))
      .where(conds)
      .groupBy(sql`1`, sql`2`);
  }
  const group = q.groupBy === "project" ? sql<string>`coalesce(${traces.projectId}::text, 'unattributed')` : sql<string>`'all'`;
  return db
    .select({ bucket, group, ...traceAggregates() })
    .from(traces)
    .where(conds)
    .groupBy(sql`1`, sql`2`);
}

export function seriesFeedbackQuery(db: Db, q: SeriesQuery) {
  const bucket = sql<string>`to_char(date_trunc(${q.bucket}, ${traces.startedAt} at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:00:00"Z"')`;
  const conds = and(
    eq(traceScores.source, "annotation"),
    q.scoreName ? eq(traceScores.name, q.scoreName) : undefined,
    gte(traces.startedAt, new Date(q.from)),
    lte(traces.startedAt, new Date(q.to)),
    q.projectId ? eq(traces.projectId, q.projectId) : undefined,
    q.agentId ? scopeCondition({ scope: "agent", scopeId: q.agentId }) : undefined,
  );
  const agg = { n: sql<number>`count(${traceScores.value})::int`, avg: sql<number | null>`avg(${traceScores.value})` };
  if (q.groupBy === "agent") {
    const pairs = agentPairs(db, q);
    return db
      .select({ bucket, group: sql<string>`${pairs.agentId}::text`, ...agg })
      .from(traceScores)
      .innerJoin(traces, eq(traces.id, traceScores.traceId))
      .innerJoin(pairs, eq(pairs.traceId, traces.id))
      .where(conds)
      .groupBy(sql`1`, sql`2`);
  }
  const group = q.groupBy === "project" ? sql<string>`coalesce(${traces.projectId}::text, 'unattributed')` : sql<string>`'all'`;
  return db
    .select({ bucket, group, ...agg })
    .from(traceScores)
    .innerJoin(traces, eq(traces.id, traceScores.traceId))
    .where(conds)
    .groupBy(sql`1`, sql`2`);
}

export async function computeSeries(db: Db, q: SeriesQuery) {
  let raw: Array<{ bucket: string; group: string; value: number | null; samples: number }>;
  if (q.metric === "feedback_score") {
    raw = (await seriesFeedbackQuery(db, q)).map((r) => ({
      bucket: r.bucket,
      group: r.group,
      value: Number(r.n) > 0 && r.avg !== null ? Number(r.avg) : null,
      samples: Number(r.n),
    }));
  } else {
    const metric = q.metric;
    raw = (await seriesTraceQuery(db, q)).map((r) => ({ bucket: r.bucket, group: r.group, ...traceMetricValue(metric, r as TraceAgg) }));
  }
  const folded = foldTopGroups(raw, kriMetricIsAdditive(q.metric));
  // labels for agent and project groups
  const ids = folded.groups.filter((g) => /^[0-9a-f-]{36}$/.test(g));
  const labels = new Map<string, string>([
    ["all", "All traces"],
    ["other", "Other"],
    ["unattributed", "No project"],
  ]);
  if (ids.length && q.groupBy === "agent") {
    for (const a of await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, ids))) labels.set(a.id, a.name);
  }
  if (ids.length && q.groupBy === "project") {
    for (const p of await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, ids))) labels.set(p.id, p.name);
  }
  return {
    metric: q.metric,
    unit: KRI_METRICS[q.metric].unit,
    bucket: q.bucket,
    bucketMs: SERIES_BUCKETS[q.bucket],
    from: q.from,
    to: q.to,
    groupBy: q.groupBy,
    groups: folded.groups.map((key) => ({ key, label: labels.get(key) ?? key })),
    points: folded.points,
    folded: folded.folded,
    /** "other" of a non-additive metric is a sample-weighted mean of the folded groups */
    otherIsApproximate: folded.folded > 0 && !kriMetricIsAdditive(q.metric),
  };
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

const kriIdParam = z.object({ kriId: z.string().uuid() });

function kriView(k: KriRow, m: { value: number | null; samples: number } | null, alert: { id: string; status: string } | null) {
  return {
    id: k.id,
    name: k.name,
    metric: k.metric,
    metricLabel: KRI_METRICS[k.metric].label,
    unit: KRI_METRICS[k.metric].unit,
    scope: k.scope,
    scopeId: k.scopeId,
    windowDays: k.windowDays,
    comparator: k.comparator,
    threshold: k.threshold,
    minSamples: k.minSamples,
    severity: k.severity,
    scoreName: k.scoreName,
    enabled: k.enabled,
    createdAt: k.createdAt.toISOString(),
    updatedAt: k.updatedAt.toISOString(),
    measurement: m
      ? { value: m.value, samples: m.samples, state: k.enabled ? evaluateKri(k, m) : ("disabled" as const) }
      : null,
    alert,
  };
}

export function registerKriRoutes(app: FastifyInstance, db: Db): void {
  const actor = (req: { authCtx: { userId?: string | null } }) => req.authCtx.userId ?? null;
  const audit = (userId: string | null, objectId: string, ruleId: string, reason: string, detail: Record<string, unknown>) =>
    db.insert(auditLog).values({ userId: userId ?? NIL_USER, objectType: "kri", objectId, detail, effect: "allow", ruleId, ruleChain: [], reason });

  app.get("/v1/kris", async () => {
    const now = new Date();
    const rows = await db.select().from(kris).orderBy(kris.createdAt);
    const labels = await scopeLabels(db, rows);
    const active = rows.length
      ? await db
          .select({ id: governanceAlerts.id, status: governanceAlerts.status, subjectKey: governanceAlerts.subjectKey })
          .from(governanceAlerts)
          .where(
            and(
              eq(governanceAlerts.ruleId, KRI_MONITOR_RULE),
              ne(governanceAlerts.status, "resolved"),
              inArray(governanceAlerts.subjectKey, rows.map((r) => kriSubjectKey(r.id))),
            ),
          )
      : [];
    const bySubject = new Map(active.map((a) => [a.subjectKey, { id: a.id, status: a.status }]));
    const out = [];
    for (const k of rows) {
      const m = k.enabled ? await measureKri(db, k, now) : null;
      out.push({ ...kriView(k, m, bySubject.get(kriSubjectKey(k.id)) ?? null), scopeLabel: k.scopeId ? (labels.get(k.scopeId) ?? null) : null });
    }
    return {
      kris: out,
      metrics: Object.entries(KRI_METRICS).map(([id, m]) => ({ id, ...m })),
      measuredAt: now.toISOString(),
      note:
        "A KRI is evaluated on every governance-monitor pass; a breach raises a governance alert. Below its minimum " +
        "sample count a KRI neither raises nor resolves.",
    };
  });

  app.post("/v1/kris", async (req, reply) => {
    const body = kriCreateSchema.parse(req.body);
    const [row] = await db
      .insert(kris)
      .values({ ...body, createdByUserId: actor(req) })
      .returning();
    await audit(actor(req), row!.id, KRI_AUDIT_RULE_IDS.created, `KRI '${row!.name}' created (${row!.metric} ${row!.comparator} ${row!.threshold})`, {
      metric: row!.metric,
      scope: row!.scope,
      scopeId: row!.scopeId,
      windowDays: row!.windowDays,
      comparator: row!.comparator,
      threshold: row!.threshold,
      minSamples: row!.minSamples,
      severity: row!.severity,
    });
    return reply.status(201).send(kriView(row!, null, null));
  });

  app.patch("/v1/kris/:kriId", async (req, reply) => {
    const { kriId } = kriIdParam.parse(req.params);
    const body = kriUpdateSchema.parse(req.body);
    const [prior] = await db.select().from(kris).where(eq(kris.id, kriId));
    if (!prior) return reply.status(404).send({ error: "not_found" });
    const merged = { ...prior, ...body };
    // the cross-field rules hold for the merged row too
    const check = kriCreateSchema.safeParse({
      name: merged.name,
      metric: merged.metric,
      scope: merged.scope,
      scopeId: merged.scopeId,
      windowDays: merged.windowDays,
      comparator: merged.comparator,
      threshold: merged.threshold,
      minSamples: merged.minSamples,
      severity: merged.severity,
      scoreName: merged.scoreName,
      enabled: merged.enabled,
    });
    if (!check.success) return reply.status(400).send({ error: "validation", issues: check.error.issues });
    const [row] = await db
      .update(kris)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(kris.id, kriId))
      .returning();
    await audit(actor(req), kriId, KRI_AUDIT_RULE_IDS.updated, `KRI '${row!.name}' changed`, {
      changed: Object.keys(body),
      before: Object.fromEntries(Object.keys(body).map((k) => [k, (prior as Record<string, unknown>)[k]])),
    });
    let resolved = 0;
    if (prior.enabled && body.enabled === false) resolved = await resolveKriEpisode(db, kriId, actor(req), "the KRI was disabled");
    return { ...kriView(row!, null, null), resolvedEpisodes: resolved };
  });

  app.delete("/v1/kris/:kriId", async (req, reply) => {
    const { kriId } = kriIdParam.parse(req.params);
    const [row] = await db.delete(kris).where(eq(kris.id, kriId)).returning();
    if (!row) return reply.status(404).send({ error: "not_found" });
    const resolved = await resolveKriEpisode(db, kriId, actor(req), "the KRI was deleted");
    await audit(actor(req), kriId, KRI_AUDIT_RULE_IDS.deleted, `KRI '${row.name}' deleted`, { metric: row.metric, resolvedEpisodes: resolved });
    return { deleted: true, resolvedEpisodes: resolved };
  });

  app.get("/v1/monitoring/series", async (req) => {
    const q = seriesQuerySchema.parse(req.query);
    return computeSeries(db, q);
  });
}
