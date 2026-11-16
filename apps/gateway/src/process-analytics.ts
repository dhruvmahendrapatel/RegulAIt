/**
 * ADR-0342 (lane E23) — process analytics: cycle time, wait vs work, throughput, rework and bottlenecks per workflow
 * template and stage, from the workflow history.
 *
 * SOURCE OF TRUTH. `workflow_events` (the append-only per-instance history written by `applyEvent`, the one place a
 * workflow changes state) replayed through the pure kernel `transition` against the instance's snapshotted
 * definition. The replay reproduces, event by event, the status and current stage the engine itself computed. A
 * replay whose final state differs from the stored `workflow_instances.state` is marked `diverged` and its instance is
 * excluded (and counted as excluded on every response), so a figure is never built on a history we could not
 * reproduce.
 *
 * THE READ MODEL (packages/db block "ADR-0342", migration `pending/process_analytics.sql`). One instance row, its
 * template links and one span per stage visit. `projectProcessAnalytics` rebuilds an instance's rows whenever its
 * `updated_at` or its project changed since the last projection: idempotent, bounded per pass, run by the
 * `process-analytics-projector` scheduler job under `system_task` and by an admin through the audited refresh route.
 * Requests aggregate the read model; none replays or scans the history.
 *
 * AUTHORISATION. Every read resolves the caller's scope with the ADR-0047 entitlement decision
 * (`evaluateReportAccess`): an admin under `scope=org` sees every instance (including instances with no project);
 * every other read is narrowed to the projects in scope the caller is a member of, at query construction. Row-level
 * security on the three tables is the second line: a non-admin principal reads only instances of its own projects.
 * A refused read and every cross-project read (org or team scope) is audited.
 *
 *   GET  /v1/process-analytics/templates    per template: started, ended by status, cycle time, rework rate, open
 *   GET  /v1/process-analytics/stages       per stage, ranked by total wait (the bottleneck ranking)
 *   GET  /v1/process-analytics/heatmap      stage x period cells (visits, median duration, wait)
 *   GET  /v1/process-analytics/throughput   per period: started and ended by terminal status
 *   POST /v1/process-analytics/refresh      run one projection pass now (admin, audited)
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { auditLog, sql, type Db, type SQL } from "@regulait/db";
import { evaluateReportAccess } from "@regulait/shared";
import {
  initialState,
  transition,
  type InstanceState,
  type InstanceStatus,
  type WorkflowDefinition,
  type WorkflowEvent,
} from "@regulait/workflow-kernel";
import { callerProjectIds, callerTeamIds, resolveScopeProjectIds } from "./reporting.js";
import { databaseNow } from "./db-clock.js";
import type { SchedulerJobDefinition } from "./scheduler.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const DAY_MS = 86_400_000;

export const PROCESS_ANALYTICS_PROJECTOR_JOB_NAME = "process-analytics-projector";
/** instances rebuilt per pass; the rest wait for the next pass (oldest change first) */
export const PROJECTION_BATCH_MAX = 500;
/** an instance with more history than this is marked `too_long` and excluded rather than replayed */
export const PROJECTION_EVENTS_MAX = 5000;
/** events sharing one timestamp (one transaction) are re-ordered at most this far before the replay gives up */
const TIE_GROUP_MAX = 8;

const TERMINAL: ReadonlySet<InstanceStatus> = new Set(["completed", "aborted", "denied", "rolled_back"]);
/** the engine is executing the stage, or it is queued for an executor */
const WORK: ReadonlySet<InstanceStatus> = new Set(["running", "awaiting_execution"]);

export const BASIS =
  "Projected from the workflow event history (workflow_events) replayed through the workflow kernel. Stage time is " +
  "split into wait (the instance needed a person or an outside party: an approval, an artifact, a plan, a trigger, a " +
  "failed check or a deploy handoff) and work (the engine was executing the stage or it was queued for an executor). " +
  "A stage visit counts in the period it ended; an instance counts as started and ended in the periods those happened. " +
  "Instances whose history could not be reproduced are excluded and counted. An instance started from several " +
  "templates counts under each.";

// ---------------------------------------------------------------------------
// The replay (pure)
// ---------------------------------------------------------------------------

export interface HistoryEvent {
  event: WorkflowEvent;
  at: Date;
}

export interface ReplaySpan {
  seq: number;
  stageId: string;
  stageType: string;
  visit: number;
  enteredAt: Date;
  exitedAt: Date | null;
  waitMs: number;
  workMs: number;
  exitKind: "advanced" | "reworked" | "ended" | null;
}

export type ReplayResult =
  | {
      status: "ok";
      spans: ReplaySpan[];
      startedAt: Date;
      endedAt: Date | null;
      terminalStatus: InstanceStatus | null;
      lastEventAt: Date;
    }
  | { status: "diverged"; reason: string };

function sameState(a: InstanceState, b: InstanceState): boolean {
  return (
    a.status === b.status &&
    a.currentStageIndex === b.currentStageIndex &&
    JSON.stringify(a.stageStatuses) === JSON.stringify(b.stageStatuses)
  );
}

/**
 * Order the history so the kernel accepts every event and ends at `stored`. Events are taken in time order; events
 * sharing one timestamp (written in one transaction, where `now()` is the transaction start) are tried in their
 * stored order first and re-ordered only if the kernel refuses that order. Returns the accepted order or null.
 */
function acceptedOrder(def: WorkflowDefinition, history: HistoryEvent[], stored: InstanceState): HistoryEvent[] | null {
  const groups: HistoryEvent[][] = [];
  for (const h of history) {
    const last = groups[groups.length - 1];
    if (last && last[0]!.at.getTime() === h.at.getTime()) last.push(h);
    else groups.push([h]);
  }
  let budget = 10_000;
  const out: HistoryEvent[] = [];
  const walk = (gi: number, state: InstanceState, rest: HistoryEvent[]): boolean => {
    if (budget-- <= 0) return false;
    if (rest.length === 0) {
      if (gi === groups.length) return sameState(state, stored);
      const g = groups[gi]!;
      if (g.length > TIE_GROUP_MAX) return false;
      return walk(gi + 1, state, g);
    }
    for (let i = 0; i < rest.length; i++) {
      let next: InstanceState;
      try {
        next = transition(def, state, rest[i]!.event).state;
      } catch {
        continue;
      }
      out.push(rest[i]!);
      if (walk(gi, next, [...rest.slice(0, i), ...rest.slice(i + 1)])) return true;
      out.pop();
      if (budget <= 0) return false;
    }
    return false;
  };
  return walk(0, initialState(def), []) ? out : null;
}

/**
 * Replay one instance's history into stage spans. Between two events the instance holds the status and stage the
 * earlier event left it in; that interval is wait or work time of the span it falls in. A span ends when the instance
 * moves to another stage (`advanced` forward, `reworked` backward), re-runs a failed check (`reworked`) or reaches a
 * terminal status (`ended`). A re-opened terminal instance is open again.
 */
export function replayHistory(def: WorkflowDefinition, history: HistoryEvent[], stored: InstanceState): ReplayResult {
  if (history.length === 0) return { status: "diverged", reason: "no events" };
  const ordered = acceptedOrder(def, history, stored);
  if (!ordered) return { status: "diverged", reason: "the kernel did not reproduce the stored state from this history" };

  const spans: ReplaySpan[] = [];
  const visits = new Map<string, number>();
  let state = initialState(def);
  let cur: ReplaySpan | null = null;
  let curIndex = -1;
  let lastAt = ordered[0]!.at;
  let endedAt: Date | null = null;
  let terminalStatus: InstanceStatus | null = null;

  const close = (at: Date, kind: "advanced" | "reworked" | "ended") => {
    if (!cur) return;
    cur.exitedAt = at;
    cur.exitKind = kind;
    cur = null;
    curIndex = -1;
  };
  const open = (index: number, at: Date) => {
    const stage = def.stages[index];
    if (!stage) return;
    const visit = (visits.get(stage.id) ?? 0) + 1;
    visits.set(stage.id, visit);
    cur = { seq: spans.length, stageId: stage.id, stageType: stage.type, visit, enteredAt: at, exitedAt: null, waitMs: 0, workMs: 0, exitKind: null };
    curIndex = index;
    spans.push(cur);
  };

  for (const h of ordered) {
    const elapsed = Math.max(0, h.at.getTime() - lastAt.getTime());
    if (cur && elapsed > 0) {
      const span: ReplaySpan = cur;
      if (WORK.has(state.status)) span.workMs += elapsed;
      else span.waitMs += elapsed;
    }
    lastAt = h.at;
    const prior = state;
    state = transition(def, state, h.event).state;

    if (TERMINAL.has(state.status)) {
      close(h.at, "ended");
      endedAt = h.at;
      terminalStatus = state.status;
      continue;
    }
    if (TERMINAL.has(prior.status)) {
      endedAt = null;
      terminalStatus = null;
    }
    const index = state.currentStageIndex;
    if (cur === null) open(index, h.at);
    else if (index !== curIndex) {
      close(h.at, index < curIndex ? "reworked" : "advanced");
      open(index, h.at);
    } else if (h.event.kind === "recheck" || h.event.kind === "reopen") {
      close(h.at, "reworked");
      open(index, h.at);
    }
  }
  return { status: "ok", spans, startedAt: ordered[0]!.at, endedAt, terminalStatus, lastEventAt: lastAt };
}

// ---------------------------------------------------------------------------
// The projector
// ---------------------------------------------------------------------------

export interface ProjectionPass {
  projected: number;
  diverged: number;
  tooLong: number;
  /** candidates left for the next pass */
  remaining: boolean;
}

interface CandidateRow extends Record<string, unknown> {
  id: string;
  definition: WorkflowDefinition;
  state: InstanceState;
  template_ids: string[];
  project_id: string | null;
  /** text, so the microseconds survive the round trip (a Date would truncate them and the change detector would
   * then see every instance as changed) */
  updated_at: string;
}

/** the live project of an instance (its `project_id` is FK-free and may name a project that was deleted) */
const liveProject = (col: SQL) => sql`(SELECT pr.id FROM projects pr WHERE pr.id = ${col})`;

/**
 * One bounded, idempotent projection pass. Must run in a scope the write policies admit (an admin principal or
 * `system_task`); under any other scope row-level security makes every write fail.
 */
export async function projectProcessAnalytics(db: Db, opts: { limit?: number } = {}): Promise<ProjectionPass> {
  const limit = Math.min(Math.max(opts.limit ?? PROJECTION_BATCH_MAX, 1), PROJECTION_BATCH_MAX);
  const candidates = (
    await db.execute<CandidateRow>(sql`
      SELECT wi.id, wi.definition, wi.state, wi.template_ids, ${liveProject(sql`wi.project_id`)} AS project_id, wi.updated_at::text AS updated_at
        FROM workflow_instances wi
        LEFT JOIN process_analytics_instances p ON p.instance_id = wi.id
       WHERE p.instance_id IS NULL
          OR p.source_updated_at IS DISTINCT FROM wi.updated_at
          OR p.project_id IS DISTINCT FROM ${liveProject(sql`wi.project_id`)}
       ORDER BY wi.updated_at, wi.id
       LIMIT ${limit + 1}`)
  ).rows;
  const pass: ProjectionPass = { projected: 0, diverged: 0, tooLong: 0, remaining: candidates.length > limit };

  for (const c of candidates.slice(0, limit)) {
    const events = (
      await db.execute<{ event: WorkflowEvent; at: Date | string }>(sql`
        SELECT event, at FROM workflow_events WHERE instance_id = ${c.id} ORDER BY at, ctid LIMIT ${PROJECTION_EVENTS_MAX + 1}`)
    ).rows.map((r) => ({ event: r.event, at: new Date(r.at) }));
    if (events.length === 0) continue; // being created: the next pass sees its start event

    const tooLong = events.length > PROJECTION_EVENTS_MAX;
    const replay = tooLong ? null : replayHistory(c.definition, events, c.state);
    const ok = replay?.status === "ok" ? replay : null;
    const replayStatus = tooLong ? "too_long" : ok ? "ok" : "diverged";
    const templateIds = Array.isArray(c.template_ids) ? c.template_ids.filter((t) => typeof t === "string") : [];

    await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      // a concurrent pass (the scheduler and an admin refresh) rebuilds the same instance one after the other
      await t.execute(sql`SELECT pg_advisory_xact_lock(hashtext('process-analytics'), hashtext(${c.id}))`);
      await t.execute(sql`DELETE FROM process_analytics_instances WHERE instance_id = ${c.id}`);
      const first = events[0]!.at;
      const last = events[Math.min(events.length, PROJECTION_EVENTS_MAX) - 1]!.at;
      await t.execute(sql`
        INSERT INTO process_analytics_instances
          (instance_id, project_id, started_at, ended_at, terminal_status, last_event_at, event_count, replay_status, source_updated_at)
        VALUES (${c.id}, ${c.project_id}, ${ts(ok ? ok.startedAt : first)}, ${ts(ok?.endedAt ?? null)}, ${ok?.terminalStatus ?? null},
                ${ts(ok ? ok.lastEventAt : last)}, ${Math.min(events.length, PROJECTION_EVENTS_MAX)}, ${replayStatus}, ${c.updated_at}::timestamptz)`);
      if (templateIds.length > 0) {
        await t.execute(sql`
          INSERT INTO process_analytics_instance_templates (instance_id, template_id)
          SELECT ${c.id}, wt.id FROM workflow_templates wt WHERE wt.id::text IN (${sql.join(templateIds.map((x) => sql`${x}`), sql`, `)})
          ON CONFLICT DO NOTHING`);
      }
      if (ok && ok.spans.length > 0) {
        const values = ok.spans.map(
          (s) =>
            sql`(${c.id}, ${s.seq}, ${s.stageId}, ${s.stageType}, ${s.visit}, ${ts(s.enteredAt)}, ${ts(s.exitedAt)}, ${s.waitMs}, ${s.workMs}, ${s.exitKind})`,
        );
        await t.execute(sql`
          INSERT INTO process_analytics_stage_spans
            (instance_id, seq, stage_id, stage_type, visit, entered_at, exited_at, wait_ms, work_ms, exit_kind)
          VALUES ${sql.join(values, sql`, `)}`);
      }
    });
    if (replayStatus === "ok") pass.projected++;
    else if (replayStatus === "too_long") pass.tooLong++;
    else pass.diverged++;
  }
  return pass;
}

export function processAnalyticsJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: PROCESS_ANALYTICS_PROJECTOR_JOB_NAME,
      description:
        "Rebuild the process analytics read model for workflow instances that changed since their last projection " +
        `(at most ${PROJECTION_BATCH_MAX} per pass, oldest change first) by replaying their event history through the ` +
        "workflow kernel. Reads workflow state only; never in a decision path.",
      adr: "ADR-0342",
      defaultIntervalSeconds: 5 * 60,
      run: async (ctx) => {
        const out = await projectProcessAnalytics(ctx.db);
        return { itemsProcessed: out.projected + out.diverged + out.tooLong, detail: { ...out } };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Scope and query parameters
// ---------------------------------------------------------------------------

const uuid = z.string().uuid();
const baseQuery = z
  .object({
    scope: z.enum(["org", "team", "project"]).default("org"),
    scopeId: uuid.optional(),
    templateId: uuid.optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .strict();
const bucketed = { bucket: z.enum(["day", "week", "month"]).default("week") };
const paged = { limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).max(100_000).default(0) };

export const templatesQuery = baseQuery.extend(paged);
export const stagesQuery = baseQuery.extend(paged);
export const heatmapQuery = baseQuery.extend({ ...bucketed, limit: z.coerce.number().int().min(1).max(50).default(20) });
export const throughputQuery = baseQuery.extend(bucketed);
type BaseQuery = z.infer<typeof baseQuery>;

const BUCKET_MS = { day: DAY_MS, week: 7 * DAY_MS, month: 31 * DAY_MS } as const;
/** a response never has more period columns than this */
export const MAX_BUCKETS = 400;

export interface AnalyticsScope {
  /** null = every instance, including those with no project (an admin under scope=org only) */
  projectIds: string[] | null;
  from: Date;
  to: Date;
  templateId: string | null;
  scope: BaseQuery["scope"];
  scopeId: string | null;
}

export type ScopeResult = { ok: true; scope: AnalyticsScope } | { ok: false; status: number; error: string; detail: string };

/** resolve and authorise the caller's scope (ADR-0047 entitlement decision), and bound the window */
export async function resolveAnalyticsScope(
  db: Db,
  actor: { userId: string | null; isAdmin: boolean },
  q: BaseQuery,
  now: Date,
): Promise<ScopeResult> {
  const to = q.to ?? now;
  const from = q.from ?? new Date(to.getTime() - 30 * DAY_MS);
  if (!(from < to)) return { ok: false, status: 400, error: "invalid_window", detail: "`from` must be before `to`" };
  if (to.getTime() - from.getTime() > 366 * DAY_MS) {
    return { ok: false, status: 400, error: "invalid_window", detail: "a window may span at most 366 days" };
  }
  if (q.scope !== "org" && !q.scopeId) {
    return { ok: false, status: 400, error: "invalid_query", detail: `scope=${q.scope} needs a scopeId` };
  }
  if (q.scope === "org" && q.scopeId) {
    return { ok: false, status: 400, error: "invalid_query", detail: "scope=org takes no scopeId" };
  }
  const scopeId = q.scopeId ?? null;
  const scopeProjectIds = await resolveScopeProjectIds(db, { scopeKind: q.scope, scopeId });
  const decision = evaluateReportAccess({
    isAdmin: actor.isAdmin,
    userId: actor.userId,
    definition: { kind: "team_scorecard", scopeKind: q.scope, scopeId, entitlementScope: q.scope },
    scopeProjectIds,
    callerProjectIds: await callerProjectIds(db, actor.userId),
    callerTeamIds: await callerTeamIds(db, actor.userId),
  });
  if (!decision.allowed) return { ok: false, status: 403, error: "forbidden", detail: `${decision.ruleId}: ${decision.reason}` };
  return { ok: true, scope: { projectIds: decision.projectIds, from, to, templateId: q.templateId ?? null, scope: q.scope, scopeId } };
}

/** the instance filter every query shares: reproduced histories, in scope, of the template if one is named */
function instanceFilter(s: AnalyticsScope, alias = "i"): SQL {
  const a = sql.raw(alias);
  const parts: SQL[] = [sql`${a}.replay_status = 'ok'`];
  if (s.projectIds !== null) {
    parts.push(
      s.projectIds.length === 0
        ? sql`false`
        : sql`${a}.project_id IN (${sql.join(s.projectIds.map((p) => sql`${p}::uuid`), sql`, `)})`,
    );
  }
  if (s.templateId) {
    parts.push(
      sql`EXISTS (SELECT 1 FROM process_analytics_instance_templates it WHERE it.instance_id = ${a}.instance_id AND it.template_id = ${s.templateId}::uuid)`,
    );
  }
  return sql.join(parts, sql` AND `);
}

function scopeFilterOnly(s: AnalyticsScope): SQL {
  if (s.projectIds === null) return sql`true`;
  if (s.projectIds.length === 0) return sql`false`;
  return sql`i.project_id IN (${sql.join(s.projectIds.map((p) => sql`${p}::uuid`), sql`, `)})`;
}

const ts = (d: Date | null): SQL => (d === null ? sql`NULL::timestamptz` : sql`${d.toISOString()}::timestamptz`);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const ms = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(Number(v)));

async function envelope(db: Db, s: AnalyticsScope) {
  const r = (
    await db.execute<{ diverged: number; too_long: number; last: Date | string | null }>(sql`
      SELECT count(*) FILTER (WHERE i.replay_status = 'diverged')::int AS diverged,
             count(*) FILTER (WHERE i.replay_status = 'too_long')::int AS too_long,
             max(i.projected_at) AS last
        FROM process_analytics_instances i
       WHERE ${scopeFilterOnly(s)}`)
  ).rows[0];
  return {
    window: { from: s.from.toISOString(), to: s.to.toISOString() },
    scope: { kind: s.scope, id: s.scopeId, templateId: s.templateId },
    excluded: { diverged: r?.diverged ?? 0, tooLong: r?.too_long ?? 0 },
    lastProjectedAt: r?.last ? new Date(r.last).toISOString() : null,
    basis: BASIS,
  };
}

// ---------------------------------------------------------------------------
// The four reads
// ---------------------------------------------------------------------------

export async function templateAnalytics(db: Db, s: AnalyticsScope, page: { limit: number; offset: number }) {
  const rows = (
    await db.execute(sql`
      WITH inst AS (
        SELECT i.*, it.template_id,
               EXISTS (SELECT 1 FROM process_analytics_stage_spans sp WHERE sp.instance_id = i.instance_id AND sp.exit_kind = 'reworked') AS reworked
          FROM process_analytics_instances i
          JOIN process_analytics_instance_templates it ON it.instance_id = i.instance_id
         WHERE ${instanceFilter(s)}
           AND ((i.started_at >= ${ts(s.from)} AND i.started_at < ${ts(s.to)})
             OR (i.ended_at >= ${ts(s.from)} AND i.ended_at < ${ts(s.to)})
             OR (i.ended_at IS NULL AND i.started_at < ${ts(s.to)}))
      ), g AS (
        SELECT template_id,
               count(*) FILTER (WHERE started_at >= ${ts(s.from)} AND started_at < ${ts(s.to)})::int AS started,
               count(*) FILTER (WHERE ended_at >= ${ts(s.from)} AND ended_at < ${ts(s.to)})::int AS ended,
               count(*) FILTER (WHERE ended_at >= ${ts(s.from)} AND ended_at < ${ts(s.to)} AND terminal_status = 'completed')::int AS completed,
               count(*) FILTER (WHERE ended_at >= ${ts(s.from)} AND ended_at < ${ts(s.to)} AND terminal_status = 'aborted')::int AS aborted,
               count(*) FILTER (WHERE ended_at >= ${ts(s.from)} AND ended_at < ${ts(s.to)} AND terminal_status = 'denied')::int AS denied,
               count(*) FILTER (WHERE ended_at >= ${ts(s.from)} AND ended_at < ${ts(s.to)} AND terminal_status = 'rolled_back')::int AS rolled_back,
               count(*) FILTER (WHERE ended_at >= ${ts(s.from)} AND ended_at < ${ts(s.to)} AND reworked)::int AS ended_reworked,
               count(*) FILTER (WHERE ended_at IS NULL)::int AS open,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ended_at - started_at) * 1000)
                 FILTER (WHERE ended_at >= ${ts(s.from)} AND ended_at < ${ts(s.to)}) AS p50,
               percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM ended_at - started_at) * 1000)
                 FILTER (WHERE ended_at >= ${ts(s.from)} AND ended_at < ${ts(s.to)}) AS p90,
               avg(extract(epoch FROM ended_at - started_at) * 1000) FILTER (WHERE ended_at >= ${ts(s.from)} AND ended_at < ${ts(s.to)}) AS mean
          FROM inst GROUP BY template_id
      )
      SELECT g.*, wt.name, count(*) OVER ()::int AS total
        FROM g JOIN workflow_templates wt ON wt.id = g.template_id
       ORDER BY g.started DESC, g.ended DESC, wt.name, g.template_id
       LIMIT ${page.limit} OFFSET ${page.offset}`)
  ).rows as Array<Record<string, unknown>>;
  return {
    ...(await envelope(db, s)),
    total: num(rows[0]?.total) ?? 0,
    limit: page.limit,
    offset: page.offset,
    templates: rows.map((r) => {
      const ended = Number(r.ended);
      return {
        templateId: r.template_id as string,
        name: r.name as string,
        started: Number(r.started),
        ended: { total: ended, completed: Number(r.completed), aborted: Number(r.aborted), denied: Number(r.denied), rolledBack: Number(r.rolled_back) },
        open: Number(r.open),
        cycleTimeMs: { p50: ms(r.p50), p90: ms(r.p90), mean: ms(r.mean) },
        reworkRate: ended > 0 ? Number(r.ended_reworked) / ended : null,
      };
    }),
  };
}

export async function stageAnalytics(db: Db, s: AnalyticsScope, page: { limit: number; offset: number }) {
  const rows = (
    await db.execute(sql`
      WITH sp AS (
        SELECT sp.* FROM process_analytics_stage_spans sp
          JOIN process_analytics_instances i ON i.instance_id = sp.instance_id
         WHERE ${instanceFilter(s)}
           AND ((sp.exited_at >= ${ts(s.from)} AND sp.exited_at < ${ts(s.to)}) OR (sp.exited_at IS NULL AND sp.entered_at < ${ts(s.to)}))
      ), g AS (
        SELECT stage_id, stage_type,
               count(*) FILTER (WHERE exited_at IS NOT NULL)::int AS visits,
               count(*) FILTER (WHERE exit_kind = 'reworked')::int AS reworked,
               count(*) FILTER (WHERE exited_at IS NULL)::int AS open,
               min(entered_at) FILTER (WHERE exited_at IS NULL) AS oldest_open,
               coalesce(sum(wait_ms) FILTER (WHERE exited_at IS NOT NULL), 0)::float8 AS wait_total,
               coalesce(sum(work_ms) FILTER (WHERE exited_at IS NOT NULL), 0)::float8 AS work_total,
               avg(wait_ms) FILTER (WHERE exited_at IS NOT NULL) AS wait_mean,
               avg(work_ms) FILTER (WHERE exited_at IS NOT NULL) AS work_mean,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM exited_at - entered_at) * 1000) FILTER (WHERE exited_at IS NOT NULL) AS p50,
               percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM exited_at - entered_at) * 1000) FILTER (WHERE exited_at IS NOT NULL) AS p90
          FROM sp GROUP BY stage_id, stage_type
      )
      SELECT g.*, row_number() OVER (ORDER BY g.wait_total DESC, g.p90 DESC NULLS LAST, g.stage_id, g.stage_type)::int AS rank,
             sum(g.wait_total) OVER ()::float8 AS wait_all, count(*) OVER ()::int AS total
        FROM g
       ORDER BY rank
       LIMIT ${page.limit} OFFSET ${page.offset}`)
  ).rows as Array<Record<string, unknown>>;
  return {
    ...(await envelope(db, s)),
    rankedBy: "total wait time of the stage visits that ended in the window",
    total: num(rows[0]?.total) ?? 0,
    limit: page.limit,
    offset: page.offset,
    stages: rows.map((r) => {
      const visits = Number(r.visits);
      const waitAll = Number(r.wait_all);
      return {
        rank: Number(r.rank),
        stageId: r.stage_id as string,
        stageType: r.stage_type as string,
        visits,
        durationMs: { p50: ms(r.p50), p90: ms(r.p90) },
        waitMs: { total: Math.round(Number(r.wait_total)), mean: ms(r.wait_mean) },
        workMs: { total: Math.round(Number(r.work_total)), mean: ms(r.work_mean) },
        waitShare: waitAll > 0 ? Number(r.wait_total) / waitAll : null,
        reworked: Number(r.reworked),
        reworkRate: visits > 0 ? Number(r.reworked) / visits : null,
        open: Number(r.open),
        oldestOpenSince: r.oldest_open ? new Date(r.oldest_open as string).toISOString() : null,
      };
    }),
  };
}

function bucketsFor(s: AnalyticsScope, bucket: keyof typeof BUCKET_MS): number {
  return Math.ceil((s.to.getTime() - s.from.getTime()) / BUCKET_MS[bucket]) + 1;
}

export async function stageHeatmap(db: Db, s: AnalyticsScope, q: { bucket: keyof typeof BUCKET_MS; limit: number }) {
  const unit = sql.raw(`'${q.bucket}'`);
  const rows = (
    await db.execute(sql`
      WITH sp AS (
        SELECT sp.stage_id, sp.wait_ms, extract(epoch FROM sp.exited_at - sp.entered_at) * 1000 AS dur,
               to_char(date_trunc(${unit}, sp.exited_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS b
          FROM process_analytics_stage_spans sp
          JOIN process_analytics_instances i ON i.instance_id = sp.instance_id
         WHERE ${instanceFilter(s)} AND sp.exited_at >= ${ts(s.from)} AND sp.exited_at < ${ts(s.to)}
      ), top AS (
        SELECT stage_id FROM sp GROUP BY stage_id ORDER BY sum(wait_ms) DESC, stage_id LIMIT ${q.limit}
      )
      SELECT sp.stage_id, sp.b, count(*)::int AS visits, sum(sp.wait_ms)::float8 AS wait_total,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY sp.dur) AS p50
        FROM sp JOIN top USING (stage_id)
       GROUP BY sp.stage_id, sp.b
       ORDER BY sp.stage_id, sp.b`)
  ).rows as Array<Record<string, unknown>>;
  const order: string[] = [];
  const byStage = new Map<string, Array<{ period: string; visits: number; medianDurationMs: number | null; waitMs: number }>>();
  const periods = new Set<string>();
  for (const r of rows) {
    const id = r.stage_id as string;
    if (!byStage.has(id)) {
      byStage.set(id, []);
      order.push(id);
    }
    const period = String(r.b);
    periods.add(period);
    byStage.get(id)!.push({ period, visits: Number(r.visits), medianDurationMs: ms(r.p50), waitMs: Math.round(Number(r.wait_total)) });
  }
  return {
    ...(await envelope(db, s)),
    bucket: q.bucket,
    periods: [...periods].sort(),
    stages: order.map((stageId) => ({ stageId, cells: byStage.get(stageId)! })),
  };
}

export async function throughputSeries(db: Db, s: AnalyticsScope, q: { bucket: keyof typeof BUCKET_MS }) {
  const unit = sql.raw(`'${q.bucket}'`);
  const rows = (
    await db.execute(sql`
      WITH ev AS (
        SELECT to_char(date_trunc(${unit}, i.started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS b, 'started' AS what FROM process_analytics_instances i
         WHERE ${instanceFilter(s)} AND i.started_at >= ${ts(s.from)} AND i.started_at < ${ts(s.to)}
        UNION ALL
        SELECT to_char(date_trunc(${unit}, i.ended_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), i.terminal_status FROM process_analytics_instances i
         WHERE ${instanceFilter(s)} AND i.ended_at >= ${ts(s.from)} AND i.ended_at < ${ts(s.to)}
      )
      SELECT b, what, count(*)::int AS n FROM ev GROUP BY b, what ORDER BY b`)
  ).rows as Array<{ b: string; what: string; n: number }>;
  const byPeriod = new Map<string, { period: string; started: number; completed: number; aborted: number; denied: number; rolledBack: number }>();
  for (const r of rows) {
    const period = String(r.b);
    const p = byPeriod.get(period) ?? { period, started: 0, completed: 0, aborted: 0, denied: 0, rolledBack: 0 };
    const key = r.what === "rolled_back" ? "rolledBack" : (r.what as "started" | "completed" | "aborted" | "denied");
    p[key] += Number(r.n);
    byPeriod.set(period, p);
  }
  return { ...(await envelope(db, s)), bucket: q.bucket, periods: [...byPeriod.values()] };
}

// ---------------------------------------------------------------------------
// Routes. The four reads are in NON_ADMIN_ROUTES and authorise in the handler; refresh is admin-only.
// ---------------------------------------------------------------------------

const refuse = (reply: FastifyReply, status: number, error: string, detail: string) => reply.status(status).send({ error, detail });
const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; ");

/**
 * Run a read with just-in-time compilation off. Measured (ADR-0342): on 25,000 spans the aggregate executes in about
 * 36 ms and JIT compilation added about 320 ms, because the row-level security sub-plans inflate the planner's cost
 * estimate past `jit_above_cost`. `SET LOCAL` dies with the transaction.
 */
export async function withAnalyticsSettings<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await t.execute(sql`SET LOCAL jit = off`);
    return fn(t);
  });
}

async function auditRead(db: Db, userId: string | null, view: string, detail: Record<string, unknown>, allowed: boolean, reason: string) {
  await db.insert(auditLog).values({
    userId: userId ?? NIL_UUID,
    objectType: "report",
    objectId: null,
    detail: { subsystem: "process-analytics", adr: "0342", view, ...detail },
    effect: allowed ? "allow" : "deny",
    ruleId: allowed ? "process-analytics-read" : "process-analytics-read-refused",
    ruleChain: [],
    reason,
  });
}

export function registerProcessAnalyticsRoutes(app: FastifyInstance, db: Db): void {
  const read = <Q extends z.ZodType<BaseQuery>>(
    path: string,
    view: string,
    schema: Q,
    run: (tx: Db, s: AnalyticsScope, q: z.infer<Q>) => Promise<unknown>,
    maxBuckets?: (s: AnalyticsScope, q: z.infer<Q>) => number,
  ) => {
    app.get(path, async (req, reply) => {
      const parsed = schema.safeParse(req.query ?? {});
      if (!parsed.success) return refuse(reply, 400, "invalid_query", issues(parsed.error));
      const q = parsed.data;
      const actor = { userId: req.authCtx.userId ?? null, isAdmin: req.authCtx.isAdmin === true };
      const resolved = await resolveAnalyticsScope(db, actor, q, await databaseNow(db));
      const filters = { scope: q.scope, scopeId: q.scopeId ?? null, templateId: q.templateId ?? null };
      if (!resolved.ok) {
        if (resolved.status === 403) await auditRead(db, actor.userId, view, filters, false, resolved.detail);
        return refuse(reply, resolved.status, resolved.error, resolved.detail);
      }
      if (maxBuckets && maxBuckets(resolved.scope, q) > MAX_BUCKETS) {
        return refuse(reply, 400, "invalid_window", `at most ${MAX_BUCKETS} periods per response; use a wider bucket or a shorter window`);
      }
      if (q.scope !== "project") {
        await auditRead(db, actor.userId, view, { ...filters, from: resolved.scope.from.toISOString(), to: resolved.scope.to.toISOString() }, true,
          `process analytics (${view}) read across ${resolved.scope.projectIds === null ? "the whole organisation" : `${resolved.scope.projectIds.length} project(s)`} (ADR-0342)`);
      }
      return withAnalyticsSettings(db, (tx) => run(tx, resolved.scope, q));
    });
  };

  read("/v1/process-analytics/templates", "templates", templatesQuery, (tx, s, q) => templateAnalytics(tx, s, q));
  read("/v1/process-analytics/stages", "stages", stagesQuery, (tx, s, q) => stageAnalytics(tx, s, q));
  read("/v1/process-analytics/heatmap", "heatmap", heatmapQuery, (tx, s, q) => stageHeatmap(tx, s, q), (s, q) => bucketsFor(s, q.bucket));
  read("/v1/process-analytics/throughput", "throughput", throughputQuery, (tx, s, q) => throughputSeries(tx, s, q), (s, q) => bucketsFor(s, q.bucket));

  app.post("/v1/process-analytics/refresh", async (req, reply) => {
    if (req.body !== undefined && req.body !== null && (typeof req.body !== "object" || Object.keys(req.body as object).length)) {
      return refuse(reply, 400, "invalid_body", "this route takes no body");
    }
    const result = await projectProcessAnalytics(db);
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NIL_UUID,
      objectType: "report",
      objectId: null,
      detail: { subsystem: "process-analytics", adr: "0342", ...result },
      effect: "allow",
      ruleId: "process-analytics-refreshed",
      ruleChain: [],
      reason: `process analytics re-projected from the workflow history (ADR-0342): ${result.projected} instance(s), ${result.diverged} diverged, ${result.tooLong} too long`,
    });
    return reply.status(200).send(result);
  });
}
