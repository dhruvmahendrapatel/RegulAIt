/**
 * ADR-0312 (lane E2, G3) — COST PER OUTCOME.
 *
 * Pillar 5 attributes spend at every gateway call (`usage_events`, the metered ledger). This joins that ledger to what
 * the spend produced:
 *
 *   merged_pr            a workflow instance whose merge stage returned a merge commit (pillar 2)
 *   workflow_run         a workflow instance that reached a terminal status, whatever it was (the cost of an attempt)
 *   accepted_change      a workflow instance that completed every stage, including post-deploy verification
 *   completed_work_item  a PM work item (pillar 8 `pm_links`) whose linked instance, run or run node completed
 *
 * WHAT IS STORED, AND WHAT IS NOT. `cost_outcomes` records that an outcome happened (append-only evidence, RLS). The
 * spend is never copied there: every read sums `usage_events.cost_usd` over the rows the subject's orchestration runs
 * dispatched (`detail.runId`, and `detail.nodeId` for a node). A row with no price is counted as unpriced, never
 * invented. Imported spend (`imported_cost_lines`, basis 'imported') is never joined to an outcome: it was not observed
 * per call, so the roll-up shows it beside the metered figure for the same cost centre and window, never divided.
 *
 * Search first (ADR-0176): FinOps tools (OpenCost, Kubecost's open core, the FOCUS spec) allocate cloud resources, not
 * our own per-call ledger to our own workflow and PM records. Nothing to adopt; this is pillar-5 semantics. Pagination
 * reuses the ADR-0226 list contract; the job runs on the ADR-0064 scheduler. No new dependency.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, auditLog, costOutcomes, eq, gte, lt, sql, type CostOutcomeRow, type Db, type SQL } from "@regulait/db";
import { type ListSpec } from "./list-contract.js";
import { answerListPage, type ContractList } from "./list-contract-route.js";
import type { SchedulerJobDefinition } from "./scheduler.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export const COST_OUTCOME_KINDS = ["merged_pr", "workflow_run", "accepted_change", "completed_work_item"] as const;
export type CostOutcomeKind = (typeof COST_OUTCOME_KINDS)[number];

export const COST_OUTCOME_RULE_IDS = {
  recorded: "cost-outcome-recorded",
  summaryRead: "cost-outcome-summary-read",
} as const;

export const COST_OUTCOME_JOB_NAME = "cost-outcome-recorder";

export const COST_OUTCOME_LIMITS = {
  /** outcomes one recorder pass inserts per kind; the next pass continues */
  recordBatch: 2_000,
  /** the longest window a read may span */
  maxWindowDays: 366,
  /** the window when none is given */
  defaultWindowDays: 30,
  /** roll-up groups per page */
  summaryPageMax: 500,
  summaryPageDefault: 50,
} as const;

/** workflow statuses after which an instance never moves again (the workflow kernel's terminal set) */
export const TERMINAL_INSTANCE_STATUSES = ["completed", "aborted", "denied", "rolled_back"] as const;

export const COST_OUTCOME_BASIS_STATEMENT =
  "Metered spend is the sum of usage_events.cost_usd over the calls the outcome's orchestration runs dispatched " +
  "(detail.runId; for a run node, detail.nodeId too), across the subject's whole life, not only the window. Calls with " +
  "no price are counted as unpricedCalls and add nothing; a cost per outcome with unpriced calls is a lower bound. " +
  "Calls made outside an orchestration run are not attributed to any outcome. The four kinds overlap (a merged pull " +
  "request is usually also a workflow run and an accepted change), so figures are never added across kinds. Imported " +
  "spend was restated from customer files, not observed per call: it is shown beside the metered figure for the same " +
  "cost centre and never divided by outcomes.";

// ---------------------------------------------------------------------------
// the recorder
// ---------------------------------------------------------------------------

export interface CostOutcomeRecordResult {
  recorded: Record<CostOutcomeKind, number>;
  total: number;
}

const terminalList = sql.join(
  TERMINAL_INSTANCE_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

/**
 * One idempotent pass: inserts an outcome row for every subject that reached an outcome and has none yet. Safe to run
 * concurrently (the partial unique indexes make a second insert of the same outcome a no-op). Runs as the caller's RLS
 * scope: the scheduler's `system_task`, or an admin's request.
 */
export async function recordCostOutcomes(db: Db, trigger: "schedule" | "manual"): Promise<CostOutcomeRecordResult> {
  const n = COST_OUTCOME_LIMITS.recordBatch;
  const count = (r: { rowCount?: number | null }) => r.rowCount ?? 0;
  const instanceKind = async (kind: Exclude<CostOutcomeKind, "completed_work_item">, predicate: SQL) =>
    count(
      await db.execute(sql`
        INSERT INTO cost_outcomes (kind, workflow_instance_id, project_id, initiator_user_id, merge_sha, subject_status, trigger)
        SELECT ${kind}, wi.id, p.id, wi.initiator_user_id,
               ${kind === "merged_pr" ? sql`left(wi.context->>'mergeSha', 128)` : sql`NULL`},
               left(wi.status, 64), ${trigger}
          FROM workflow_instances wi
          LEFT JOIN projects p ON p.id = wi.project_id
         WHERE ${predicate}
           AND NOT EXISTS (SELECT 1 FROM cost_outcomes o WHERE o.kind = ${kind} AND o.workflow_instance_id = wi.id)
         ORDER BY wi.updated_at, wi.id
         LIMIT ${n}
        ON CONFLICT DO NOTHING`),
    );
  const merged = await instanceKind("merged_pr", sql`coalesce(wi.context->>'mergeSha', '') <> ''`);
  const runs = await instanceKind("workflow_run", sql`wi.status IN (${terminalList})`);
  const accepted = await instanceKind("accepted_change", sql`wi.status = 'completed'`);
  // a PM work item is complete when the RegulAIt object it mirrors completed. The PM tool's own state strings
  // (pm_links.inbound_state) are provider-specific and are shown, never interpreted.
  const items = count(
    await db.execute(sql`
      INSERT INTO cost_outcomes (kind, workflow_instance_id, orchestration_run_id, node_id, pm_link_id, project_id,
                                 initiator_user_id, subject_status, trigger)
      SELECT 'completed_work_item', coalesce(wi.id, r.workflow_instance_id), r.id,
             CASE WHEN l.object_type = 'run_node' THEN l.node_id END, l.id, p.id,
             coalesce(wi.initiator_user_id, r.initiating_user_id),
             CASE l.object_type WHEN 'workflow_instance' THEN wi.status WHEN 'run' THEN r.status ELSE 'done' END,
             ${trigger}
        FROM pm_links l
        LEFT JOIN workflow_instances wi ON l.object_type = 'workflow_instance' AND wi.id = l.object_id
        LEFT JOIN orchestration_runs r ON l.object_type IN ('run', 'run_node') AND r.id = l.object_id
        LEFT JOIN projects p ON p.id = coalesce(wi.project_id, r.project_id)
       WHERE l.orphaned_at IS NULL
         AND (   (l.object_type = 'workflow_instance' AND wi.status = 'completed')
              OR (l.object_type = 'run' AND r.status = 'completed')
              OR (l.object_type = 'run_node' AND char_length(coalesce(l.node_id, '')) BETWEEN 1 AND 64
                  AND r.state->'nodeStatuses'->>l.node_id = 'done'))
         AND NOT EXISTS (SELECT 1 FROM cost_outcomes o WHERE o.kind = 'completed_work_item' AND o.pm_link_id = l.id)
       ORDER BY l.created_at, l.id
       LIMIT ${n}
      ON CONFLICT DO NOTHING`),
  );
  const recorded = { merged_pr: merged, workflow_run: runs, accepted_change: accepted, completed_work_item: items };
  return { recorded, total: merged + runs + accepted + items };
}

export function costOutcomeJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: COST_OUTCOME_JOB_NAME,
      description:
        "Record cost-per-outcome evidence: one append-only row per merged pull request, finished workflow run, " +
        "accepted change and completed PM work item not yet recorded. Reads workflow, run and PM link state; never in " +
        "a decision path. Spend is joined from the metered ledger at read time, never copied.",
      adr: "ADR-0312",
      defaultIntervalSeconds: 300,
      run: async (ctx) => {
        const out = await recordCostOutcomes(ctx.db, "schedule");
        return { itemsProcessed: out.total, detail: { recorded: out.recorded } };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// the spend join (metered only)
// ---------------------------------------------------------------------------

/**
 * The usage_events predicate for one outcome row. `o` names the outcome row's columns: the table itself in the list
 * (drizzle column refs) or an alias in the roll-up. A work item linked to a run (or a node) reads that run; any other
 * outcome reads every run of its workflow instance. Both NULL (the subject was deleted) matches nothing.
 */
function spendMatch(o: { runId: SQL; instanceId: SQL; nodeId: SQL }): SQL {
  return sql`(u.detail->>'runId') IN (
      SELECT r.id::text FROM orchestration_runs r
       WHERE (${o.runId} IS NOT NULL AND r.id = ${o.runId})
          OR (${o.runId} IS NULL AND r.workflow_instance_id = ${o.instanceId}))
    AND (${o.nodeId} IS NULL OR u.detail->>'nodeId' = ${o.nodeId})`;
}

const tableRefs = {
  runId: sql`${costOutcomes.orchestrationRunId}`,
  instanceId: sql`${costOutcomes.workflowInstanceId}`,
  nodeId: sql`${costOutcomes.nodeId}`,
};
const aliasRefs = { runId: sql.raw(`co.orchestration_run_id`), instanceId: sql.raw(`co.workflow_instance_id`), nodeId: sql.raw(`co.node_id`) };

const meteredUsdOf = (o: typeof tableRefs) =>
  sql<number>`(SELECT coalesce(sum(u.cost_usd), 0)::float8 FROM usage_events u WHERE ${spendMatch(o)})`;
const callsOf = (o: typeof tableRefs) => sql<number>`(SELECT count(*)::int FROM usage_events u WHERE ${spendMatch(o)})`;
const unpricedOf = (o: typeof tableRefs) =>
  sql<number>`(SELECT count(*)::int FROM usage_events u WHERE ${spendMatch(o)} AND u.cost_usd IS NULL)`;

// ---------------------------------------------------------------------------
// windows
// ---------------------------------------------------------------------------

const windowQuery = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

/** the refusal for a window resolveOutcomeWindow rejects */
export const WINDOW_REFUSAL = `send from < to, at most ${COST_OUTCOME_LIMITS.maxWindowDays} days apart`;

export function resolveOutcomeWindow(q: { from?: string | undefined; to?: string | undefined }, now = new Date()): { from: Date; to: Date } {
  const to = q.to ? new Date(q.to) : now;
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - COST_OUTCOME_LIMITS.defaultWindowDays * 86_400_000);
  if (!(from < to)) throw new Error("from must be before to");
  if (to.getTime() - from.getTime() > COST_OUTCOME_LIMITS.maxWindowDays * 86_400_000) {
    throw new Error(`the window may span at most ${COST_OUTCOME_LIMITS.maxWindowDays} days`);
  }
  return { from, to };
}

// ---------------------------------------------------------------------------
// the list (ADR-0226 contract)
// ---------------------------------------------------------------------------

/** a PM work item as the PM tool holds it (Azure DevOps Boards, Jira, ...): joined at read time, never copied */
export interface OutcomeWorkItem {
  provider: string;
  externalId: string;
  externalUrl: string;
  /** the PM tool's own reported state: shown, never counted (owner decision on #848) */
  inboundState: string | null;
}

export type CostOutcomeListRow = CostOutcomeRow & {
  projectName: string | null;
  /** the pull request the outcome's workflow opened (Azure DevOps Repos, GitHub, GitLab, Bitbucket), read from the
   * instance's context at query time */
  pullRequest: { id: string | null; url: string | null } | null;
  workItems: OutcomeWorkItem[];
  meteredUsd: number;
  calls: number;
  unpricedCalls: number;
};

const PROJECT_NAME = sql<string | null>`(SELECT p.name FROM projects p WHERE p.id = ${costOutcomes.projectId})`;
const PULL_REQUEST = sql<{ id: string | null; url: string | null } | null>`(
  SELECT CASE WHEN wi.context ? 'prId' OR wi.context ? 'prUrl'
              THEN json_build_object('id', wi.context->>'prId', 'url', wi.context->>'prUrl') END
    FROM workflow_instances wi WHERE wi.id = ${costOutcomes.workflowInstanceId})`;
// the outcome's own link for a work item; otherwise the instance's linked items (bounded)
const WORK_ITEMS = sql<OutcomeWorkItem[]>`coalesce((
  SELECT json_agg(json_build_object('provider', c.provider, 'externalId', l.external_id, 'externalUrl', l.external_url,
                                    'inboundState', l.inbound_state) ORDER BY l.created_at)
    FROM (SELECT * FROM pm_links l0
           WHERE (${costOutcomes.pmLinkId} IS NOT NULL AND l0.id = ${costOutcomes.pmLinkId})
              OR (${costOutcomes.pmLinkId} IS NULL AND l0.object_type = 'workflow_instance'
                  AND l0.object_id = ${costOutcomes.workflowInstanceId} AND l0.orphaned_at IS NULL)
           ORDER BY l0.created_at LIMIT 10) l
    JOIN pm_connections c ON c.id = l.connection_id), '[]'::json)`;

export const COST_OUTCOMES_LIST: ListSpec<CostOutcomeListRow> = {
  id: "cost-outcomes",
  sorts: {
    when: { expr: costOutcomes.observedAt, keysetAt: costOutcomes.observedAt },
    kind: { expr: costOutcomes.kind },
    project: { expr: sql`lower(${PROJECT_NAME})` },
  },
  columns: {
    when: { label: "Observed", value: (r) => r.observedAt },
    kind: { label: "Outcome", value: (r) => r.kind },
    project: { label: "Project", value: (r) => r.projectName },
    status: { label: "Subject status", value: (r) => r.subjectStatus },
    usd: { label: "Metered spend (USD)", value: (r) => r.meteredUsd },
    calls: { label: "Calls", value: (r) => r.calls },
    unpriced: { label: "Unpriced calls", value: (r) => r.unpricedCalls },
    merge: { label: "Merge commit", value: (r) => r.mergeSha },
    pr: { label: "Pull request", value: (r) => r.pullRequest?.url ?? r.pullRequest?.id ?? null },
    items: { label: "Work items", value: (r) => r.workItems.map((w) => w.externalId).join(", ") || null },
  },
  filters: ["kind", "projectId"],
  defaultSort: { col: "when", dir: "desc" },
  idCol: costOutcomes.id,
};

const listFilters = z
  .object({
    kind: z.enum(COST_OUTCOME_KINDS).optional(),
    projectId: z.string().uuid().optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
type ListFilters = z.infer<typeof listFilters>;

// ---------------------------------------------------------------------------
// the roll-up
// ---------------------------------------------------------------------------

interface KindFigure {
  outcomes: number;
  meteredUsd: number;
  calls: number;
  unpricedCalls: number;
  /** null when there were no outcomes; a lower bound when unpricedCalls > 0 */
  meteredPerOutcomeUsd: number | null;
}

export interface CostOutcomeGroup {
  key: string | null;
  label: string;
  costCenter: string | null;
  metered: Partial<Record<CostOutcomeKind, KindFigure>>;
  /** cost-centre grouping only; null for a project grouping (imported lines carry no project) */
  imported: { basis: "imported"; usd: number; lines: number; nonUsdLines: number } | null;
}

const summaryQuery = windowQuery
  .extend({
    by: z.enum(["project", "cost_center"]).default("project"),
    kind: z.enum(COST_OUTCOME_KINDS).optional(),
    limit: z.coerce.number().int().min(1).max(COST_OUTCOME_LIMITS.summaryPageMax).default(COST_OUTCOME_LIMITS.summaryPageDefault),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();

export async function buildCostOutcomeSummary(
  db: Db,
  q: z.infer<typeof summaryQuery>,
  window: { from: Date; to: Date },
): Promise<{ groups: CostOutcomeGroup[]; totalGroups: number; nextOffset: number | null }> {
  const kindFilter = q.kind ? sql`AND co.kind = ${q.kind}` : sql``;
  // the project's cost centre first, then the initiator's: the same precedence as the consolidated cost view
  const groupKey =
    q.by === "project" ? sql.raw(`co.project_id::text`) : sql.raw(`coalesce(p.cost_center, iu.cost_center)`);
  const label = q.by === "project" ? sql.raw(`p.name`) : sql.raw(`coalesce(p.cost_center, iu.cost_center)`);
  const res = await db.execute<{
    group_key: string | null;
    label: string | null;
    cost_center: string | null;
    kind: CostOutcomeKind;
    outcomes: number;
    metered_usd: number;
    calls: number;
    unpriced: number;
  }>(sql`
    WITH o AS (
      SELECT co.kind, co.project_id, co.initiator_user_id,
             ${meteredUsdOf(aliasRefs)} AS metered_usd,
             ${callsOf(aliasRefs)} AS calls,
             ${unpricedOf(aliasRefs)} AS unpriced
        FROM cost_outcomes co
       WHERE co.observed_at >= ${window.from.toISOString()}::timestamptz
         AND co.observed_at < ${window.to.toISOString()}::timestamptz
         ${kindFilter}
    )
    SELECT ${groupKey} AS group_key, ${label} AS label,
           ${q.by === "project" ? sql.raw(`max(p.cost_center)`) : sql.raw(`coalesce(p.cost_center, iu.cost_center)`)} AS cost_center,
           co.kind, count(*)::int AS outcomes, coalesce(sum(co.metered_usd), 0)::float8 AS metered_usd,
           coalesce(sum(co.calls), 0)::int AS calls, coalesce(sum(co.unpriced), 0)::int AS unpriced
      FROM o co
      LEFT JOIN projects p ON p.id = co.project_id
      LEFT JOIN users iu ON iu.id = co.initiator_user_id
     GROUP BY 1, 2, ${q.by === "project" ? sql.raw(`4`) : sql.raw(`3, 4`)}`);

  const groups = new Map<string, CostOutcomeGroup>();
  const totals = new Map<string, number>();
  for (const r of res.rows) {
    const k = r.group_key ?? "";
    let g = groups.get(k);
    if (!g) {
      g = {
        key: r.group_key,
        label: r.label ?? (q.by === "project" ? "Unattributed (no project)" : "Unassigned (no cost centre)"),
        costCenter: r.cost_center,
        metered: {},
        imported: null,
      };
      groups.set(k, g);
    }
    const outcomes = Number(r.outcomes);
    const usd = Number(r.metered_usd);
    g.metered[r.kind] = {
      outcomes,
      meteredUsd: usd,
      calls: Number(r.calls),
      unpricedCalls: Number(r.unpriced),
      meteredPerOutcomeUsd: outcomes > 0 ? usd / outcomes : null,
    };
    totals.set(k, (totals.get(k) ?? 0) + usd);
  }

  if (q.by === "cost_center") {
    const imported = await db.execute<{ cc: string | null; usd: number | null; lines: number; non_usd: number }>(sql`
      SELECT coalesce(l.cost_center, u.cost_center) AS cc,
             sum(l.amount) FILTER (WHERE l.currency = 'USD')::float8 AS usd,
             count(*)::int AS lines,
             count(*) FILTER (WHERE l.currency <> 'USD')::int AS non_usd
        FROM imported_cost_lines l
        JOIN cost_import_batches b ON b.id = l.batch_id AND b.status = 'applied'
        LEFT JOIN users u ON u.id = l.resolved_user_id
       WHERE l.superseded_at IS NULL
         AND l.period_start < ${window.to.toISOString()}::timestamptz
         AND l.period_end > ${window.from.toISOString()}::timestamptz
       GROUP BY 1`);
    for (const r of imported.rows) {
      const k = r.cc ?? "";
      let g = groups.get(k);
      if (!g) {
        g = { key: r.cc, label: r.cc ?? "Unassigned (no cost centre)", costCenter: r.cc, metered: {}, imported: null };
        groups.set(k, g);
      }
      g.imported = { basis: "imported", usd: Number(r.usd ?? 0), lines: Number(r.lines), nonUsdLines: Number(r.non_usd) };
    }
    for (const g of groups.values()) g.imported ??= { basis: "imported", usd: 0, lines: 0, nonUsdLines: 0 };
  }

  // largest metered spend first, then the label: a stable order for offset paging
  const ordered = [...groups.entries()]
    .sort(([ka, a], [kb, b]) => (totals.get(kb) ?? 0) - (totals.get(ka) ?? 0) || a.label.localeCompare(b.label) || ka.localeCompare(kb))
    .map(([, g]) => g);
  const page = ordered.slice(q.offset, q.offset + q.limit);
  const next = q.offset + q.limit < ordered.length ? q.offset + q.limit : null;
  return { groups: page, totalGroups: ordered.length, nextOffset: next };
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

async function auditOutcome(
  db: Db,
  actor: string | null | undefined,
  ruleId: string,
  reason: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditLog).values({
    userId: actor ?? NIL_UUID,
    objectType: "cost_outcome",
    objectId: null,
    detail: { subsystem: "cost-outcomes", adr: "0312", ...detail },
    effect: "allow",
    ruleId,
    ruleChain: [],
    reason,
  });
}

function refuse(reply: FastifyReply, status: number, error: string, detail: string) {
  return reply.status(status).send({ error, detail });
}

export function registerCostOutcomeRoutes(app: FastifyInstance, db: Db): void {
  /**
   * Self-scoped for a non-admin (in NON_ADMIN_ROUTES): the handler's predicate limits a non-admin to the outcomes of
   * workflows they initiated, and the table's RLS policy enforces the same, so a dropped predicate still leaks nothing.
   */
  const outcomesList: ContractList<CostOutcomeListRow, ListFilters> = {
    spec: COST_OUTCOMES_LIST,
    filters: listFilters,
    reader: {
      fetch: (q) =>
        db
          .select({
            id: costOutcomes.id,
            kind: costOutcomes.kind,
            workflowInstanceId: costOutcomes.workflowInstanceId,
            orchestrationRunId: costOutcomes.orchestrationRunId,
            nodeId: costOutcomes.nodeId,
            pmLinkId: costOutcomes.pmLinkId,
            projectId: costOutcomes.projectId,
            initiatorUserId: costOutcomes.initiatorUserId,
            mergeSha: costOutcomes.mergeSha,
            subjectStatus: costOutcomes.subjectStatus,
            trigger: costOutcomes.trigger,
            observedAt: costOutcomes.observedAt,
            projectName: PROJECT_NAME,
            pullRequest: PULL_REQUEST,
            workItems: WORK_ITEMS,
            meteredUsd: meteredUsdOf(tableRefs),
            calls: callsOf(tableRefs),
            unpricedCalls: unpricedOf(tableRefs),
            _cursorAt: q.cursorAt,
          })
          .from(costOutcomes)
          .where(q.where)
          .orderBy(...q.orderBy)
          .limit(q.limit)
          .offset(q.offset),
      countable: (where) => db.select({ one: sql`1` }).from(costOutcomes).where(where),
      idOf: (r) => r.id,
    },
    where: (req, f) => {
      let window;
      try {
        window = resolveOutcomeWindow(f);
      } catch {
        return null;
      }
      const self = req.authCtx.isAdmin ? undefined : req.authCtx.userId ? eq(costOutcomes.initiatorUserId, req.authCtx.userId) : null;
      if (self === null) return null;
      return and(
        gte(costOutcomes.observedAt, window.from),
        lt(costOutcomes.observedAt, window.to),
        f.kind ? eq(costOutcomes.kind, f.kind) : undefined,
        f.projectId ? eq(costOutcomes.projectId, f.projectId) : undefined,
        self,
      );
    },
    refusal: {
      status: 400,
      body: { error: "invalid_window", detail: WINDOW_REFUSAL },
    },
    extra: () => ({ basis: "metered", basisStatement: COST_OUTCOME_BASIS_STATEMENT }),
  };

  app.get("/v1/cost-outcomes", async (req, reply) => answerListPage(db, req, reply, outcomesList));

  app.get("/v1/cost-outcomes/summary", async (req: FastifyRequest, reply) => {
    const parsed = summaryQuery.safeParse(req.query ?? {});
    if (!parsed.success) {
      return refuse(reply, 400, "invalid_request", "send by=project|cost_center, kind?, from?, to?, limit (1-500), offset");
    }
    let window;
    try {
      window = resolveOutcomeWindow(parsed.data);
    } catch {
      // a fixed, server-authored refusal (log-error-text: no raw error message leaves the gateway)
      return refuse(reply, 400, "invalid_window", WINDOW_REFUSAL);
    }
    const out = await buildCostOutcomeSummary(db, parsed.data, window);
    await auditOutcome(db, req.authCtx.userId, COST_OUTCOME_RULE_IDS.summaryRead,
      `cost-per-outcome roll-up read for ${window.from.toISOString()}..${window.to.toISOString()} grouped by ${parsed.data.by}`,
      { by: parsed.data.by, kind: parsed.data.kind ?? null, groups: out.groups.length });
    return {
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      groupedBy: parsed.data.by,
      kind: parsed.data.kind ?? null,
      groups: out.groups,
      totalGroups: out.totalGroups,
      nextOffset: out.nextOffset,
      basisStatement: COST_OUTCOME_BASIS_STATEMENT,
      note:
        "There is deliberately no combined metered-plus-imported figure and no figure added across kinds. A group's " +
        "imported spend counts every applied, non-superseded line whose billing period overlaps the window, whole.",
    };
  });

  app.post("/v1/cost-outcomes/refresh", async (req) => {
    const out = await recordCostOutcomes(db, "manual");
    await auditOutcome(db, req.authCtx.userId, COST_OUTCOME_RULE_IDS.recorded,
      `cost-per-outcome recorder run by hand: ${out.total} new outcome(s)`, { recorded: out.recorded });
    return out;
  });
}
