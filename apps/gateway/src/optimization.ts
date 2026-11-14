import type { FastifyInstance } from "fastify";
import { and, connectors, costEvents, count, desc, eq, getTableColumns, gte, lt, sql, usageEvents, users, type Db, type SQL } from "@regulait/db";
import { answerListExport, answerListPage, type ContractList } from "./list-contract-route.js";
import { z } from "zod";
import { streamUsageEventsCsv } from "./projects.js";
import { resolveCsvWindow } from "./csv-export.js";
import { USAGE_SUMMARY_DEFAULT_DAYS, usageSummaryQuery } from "./list-queries.js";
import { filterParams, parseListExport, parseListPage, runListPage, sendListError, sendListExport, wantsListContract, type ListSpec } from "./list-contract.js";
import { USAGE_EVENTS_LIST, usageEventsFilterQuery, usageEventsReader, usageEventsWhere } from "./usage-events-list.js";

const listQuery = z.object({
  userId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  format: z.enum(["json", "csv"]).default("json"),
  // ADR-0031: explicit date bounds on the CSV export; absent bounds fall back
  // to the disclosed default window.
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/** OPTIMIZATION §7: the savings ledger read surface. Pillar 5's per-project
 * dashboard will roll these up later; until then this endpoint is the
 * dashboard-ready source of truth (per-technique totals + raw events). */
export function registerOptimizationRoutes(app: FastifyInstance, db: Db) {
  // ADR-0226: with any of sort/dir/cursor/offset/count the raw ledger answers
  // the shared list contract; with none of them, exactly the response below
  // (the per-technique totals and the newest `limit` events). The same
  // visibility rule: a non-admin's userId is forced to their own.
  const costEventsList: ContractList<CostEventListRow, { userId?: string; technique?: string }> = {
    spec: COST_EVENTS_LIST,
    filters: z.object({ userId: z.string().uuid().optional(), technique: z.string().min(1).max(64).optional() }).strict(),
    reader: {
      fetch: (q) =>
        db
          .select({ ...getTableColumns(costEvents), userName: COST_EVENT_USER, _cursorAt: q.cursorAt })
          .from(costEvents)
          .where(q.where)
          .orderBy(...q.orderBy)
          .limit(q.limit)
          .offset(q.offset),
      countable: (where) => db.select({ one: sql`1` }).from(costEvents).where(where),
      idOf: (r) => r.id,
    },
    where: (req, f) => {
      const userId = req.authCtx.isAdmin ? f.userId : req.authCtx.userId;
      if (!req.authCtx.isAdmin && !userId) return null;
      const conds: SQL[] = [];
      if (userId) conds.push(eq(costEvents.userId, userId));
      if (f.technique) conds.push(eq(costEvents.technique, f.technique as never));
      return conds.length ? sql.join(conds, sql` and `) : undefined;
    },
    refusal: { status: 403, body: { error: "bootstrap_has_no_cost_history" } },
  };
  app.get("/v1/cost-events/export.xlsx", async (req, reply) => answerListExport(db, req, reply, costEventsList));
  app.get("/v1/cost-events", async (req, reply) => {
    if (wantsListContract(req.query)) return answerListPage(db, req, reply, costEventsList);
    const q = listQuery.parse(req.query);
    // Non-admins see only their own cost history; the userId filter is
    // forced to self rather than trusted from the query string.
    const userId = req.authCtx.isAdmin ? q.userId : req.authCtx.userId;
    if (!req.authCtx.isAdmin && !userId) {
      return reply.status(403).send({ error: "bootstrap_has_no_cost_history" });
    }
    const where = userId ? eq(costEvents.userId, userId) : undefined;

    const [events, totals] = await Promise.all([
      db
        .select()
        .from(costEvents)
        .where(where)
        .orderBy(desc(costEvents.at))
        .limit(q.limit),
      db
        .select({
          technique: costEvents.technique,
          events: count(),
          estimatedCostSavedUsd: sql<number>`coalesce(sum(${costEvents.estimatedCostSavedUsd}), 0)::float8`,
          estimatedTokensSaved: sql<number>`coalesce(sum(${costEvents.estimatedTokensSaved}), 0)::int`,
        })
        .from(costEvents)
        .where(where)
        .groupBy(costEvents.technique),
    ]);

    return { events, totals };
  });

  // ADR-0226: with any of sort/dir/cursor/offset/count the usage ledger
  // answers the shared list contract (usage-events-list.ts), with the same
  // visibility rule; with none of them, exactly the response below.
  app.get("/v1/usage-events/export.xlsx", async (req, reply) => {
    try {
      const q = req.query as Record<string, unknown>;
      const filters = usageEventsFilterQuery.parse(filterParams(q));
      const ex = parseListExport(USAGE_EVENTS_LIST, q);
      const where = usageEventsWhere(req, filters);
      if (where === null) return reply.status(403).send({ error: "bootstrap_has_no_usage_history" });
      await sendListExport(db, req, reply, USAGE_EVENTS_LIST, usageEventsReader(db), where, ex, filters);
      return reply;
    } catch (e) {
      return sendListError(reply, e);
    }
  });

  // PILLAR 5 actuals: the measured-spend ledger written by real dispatches.
  // Same visibility rule as cost-events — non-admins see only themselves.
  app.get("/v1/usage-events", async (req, reply) => {
    if (wantsListContract(req.query)) {
      try {
        const q = req.query as Record<string, unknown>;
        const filters = usageEventsFilterQuery.parse(filterParams(q));
        const page = parseListPage(USAGE_EVENTS_LIST, q);
        const where = usageEventsWhere(req, filters);
        if (where === null) return reply.status(403).send({ error: "bootstrap_has_no_usage_history" });
        return await runListPage(db, USAGE_EVENTS_LIST, usageEventsReader(db), where, page);
      } catch (e) {
        return sendListError(reply, e);
      }
    }
    const q = listQuery.parse(req.query);
    const userId = req.authCtx.isAdmin ? q.userId : req.authCtx.userId;
    if (!req.authCtx.isAdmin && !userId) {
      return reply.status(403).send({ error: "bootstrap_has_no_usage_history" });
    }
    const where = userId ? eq(usageEvents.userId, userId) : undefined;

    if (q.format === "csv") {
      // ADR-0031: same streamed/keyset/disclosed path as the per-project
      // export. `limit` stays this endpoint's ceiling (max 500) and is now
      // DISCLOSED when it actually cuts the export short, instead of silently
      // handing back a short file.
      const baseFilters: SQL[] = userId ? [eq(usageEvents.userId, userId)] : [];
      await streamUsageEventsCsv(db, reply, {
        filename: "usage-events.csv",
        baseFilters,
        window: resolveCsvWindow(q.from, q.to),
        maxRows: q.limit,
      });
      return reply;
    }

    const [events, [totals]] = await Promise.all([
      db.select().from(usageEvents).where(where).orderBy(desc(usageEvents.at)).limit(q.limit),
      db
        .select({
          events: count(),
          inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::int`,
          costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
          measuredCostSavedUsd: sql<number>`coalesce(sum(${usageEvents.measuredCostSavedUsd}), 0)::float8`,
        })
        .from(usageEvents)
        .where(where),
    ]);

    return { events, totals };
  });

  // PILLAR 5 breakdowns, aggregated IN THE DATABASE over a stated window — so
  // spend by agent, connector, MCP tool, project and day cover every event in the window,
  // never a client-side sum over the newest page of `/v1/usage-events`.
  // Same entitlement scoping as `/v1/usage-events`: a non-admin's `userId` is
  // forced to self (the query string is not trusted); an admin may name one
  // user or omit it for the organisation; a bootstrap operator with no user
  // identity is refused, as there.
  app.get("/v1/usage-events/summary", async (req, reply) => {
    const q = usageSummaryQuery.parse(req.query);
    const userId = req.authCtx.isAdmin ? q.userId : req.authCtx.userId;
    if (!req.authCtx.isAdmin && !userId) {
      return reply.status(403).send({ error: "bootstrap_has_no_usage_history" });
    }
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - USAGE_SUMMARY_DEFAULT_DAYS * 86_400_000);
    if (from >= to) return reply.status(400).send({ error: "invalid_window", detail: "`from` must be before `to`" });
    const inWindow = and(
      ...(userId ? [eq(usageEvents.userId, userId)] : []),
      gte(usageEvents.at, from),
      lt(usageEvents.at, to),
    );
    const ofType = (t: string) => and(inWindow, eq(usageEvents.objectType, t));
    const costUsd = sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`;
    const events = sql<number>`count(*)::int`;
    // `agent`, `connector` and `mcp_tool` each read only their own object type
    // (the price models are not comparable); `project` and `day` span the whole
    // ledger, as the totals do. Whatever no typed breakdown names (a training
    // job, say) is reported in `ledger.other`, so the typed breakdowns plus
    // `other` always add up to `ledger` — nothing drops out silently.
    const day = sql<string>`to_char(${usageEvents.at} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
    const groupsQuery = (() => {
      switch (q.groupBy) {
        case "agent":
          return db
            .select({ agentId: usageEvents.agentId, costUsd, events })
            .from(usageEvents)
            .where(ofType("agent"))
            .groupBy(usageEvents.agentId)
            .orderBy(desc(costUsd));
        case "connector":
          return db
            .select({ connectorId: usageEvents.connectorId, name: connectors.name, operation: usageEvents.operation, costUsd, events })
            .from(usageEvents)
            .leftJoin(connectors, eq(usageEvents.connectorId, connectors.id))
            .where(ofType("connector"))
            .groupBy(usageEvents.connectorId, connectors.name, usageEvents.operation)
            .orderBy(desc(costUsd));
        case "mcp_tool":
          // an MCP row carries no agent; `operation` is the tool name (the
          // server id rides the detail jsonb, as in the per-project rollup)
          return db
            .select({ toolName: usageEvents.operation, costUsd, events })
            .from(usageEvents)
            .where(ofType("mcp_tool"))
            .groupBy(usageEvents.operation)
            .orderBy(desc(costUsd));
        case "project":
          return db
            .select({ projectId: usageEvents.projectId, costUsd, events })
            .from(usageEvents)
            .where(inWindow)
            .groupBy(usageEvents.projectId)
            .orderBy(desc(costUsd));
        case "day":
          return db.select({ day, costUsd, events }).from(usageEvents).where(inWindow).groupBy(day).orderBy(day);
      }
    })();
    const [groups, byType] = await Promise.all([
      groupsQuery,
      db
        .select({ objectType: usageEvents.objectType, costUsd, events })
        .from(usageEvents)
        .where(inWindow)
        .groupBy(usageEvents.objectType),
    ]);
    const totals = { events: 0, costUsd: 0 };
    for (const g of groups as ReadonlyArray<{ events: number; costUsd: number }>) {
      totals.events += g.events;
      totals.costUsd += g.costUsd;
    }
    const sumOf = (rows: typeof byType) =>
      rows.reduce((a, r) => ({ events: a.events + r.events, costUsd: a.costUsd + r.costUsd }), { events: 0, costUsd: 0 });
    const ledger = {
      ...sumOf(byType),
      byObjectType: byType,
      other: sumOf(byType.filter((r) => !TYPED_BREAKDOWNS.has(r.objectType))),
    };
    return {
      groupBy: q.groupBy,
      userId: userId ?? null,
      window: { from: from.toISOString(), to: to.toISOString(), defaulted: !q.from },
      groups,
      totals,
      ledger,
    };
  });
}

// ---------------------------------------------------------------------------
// ADR-0226: the raw cost-events ledger under the shared list contract
// ---------------------------------------------------------------------------

type CostEventListRow = typeof costEvents.$inferSelect & { userName: string | null };
const COST_EVENT_USER = sql<string | null>`(select coalesce(nullif(${users.displayName}, ''), ${users.email}) from ${users} where ${users.id} = ${costEvents.userId})`;

export const COST_EVENTS_LIST: ListSpec<CostEventListRow> = {
  id: "cost-events",
  sorts: {
    at: { expr: costEvents.at, keysetAt: costEvents.at },
    user: { expr: sql`lower(${COST_EVENT_USER})` },
    technique: { expr: costEvents.technique },
    tokens: { expr: costEvents.estimatedTokensSaved },
    usd: { expr: costEvents.estimatedCostSavedUsd },
    object: { expr: costEvents.objectType },
    basis: { expr: costEvents.estimationBasis },
    project: { expr: costEvents.projectId },
  },
  columns: {
    at: { label: "At", value: (r) => r.at },
    user: { label: "User", value: (r) => r.userName },
    technique: { label: "Technique", value: (r) => r.technique },
    tokens: { label: "Tokens saved", value: (r) => r.estimatedTokensSaved },
    usd: { label: "Est. saved", value: (r) => r.estimatedCostSavedUsd },
    object: { label: "Object", value: (r) => r.objectType },
    basis: { label: "Estimation basis", value: (r) => r.estimationBasis },
    project: { label: "Project", value: (r) => r.projectId },
  },
  filters: ["userId", "technique"],
  defaultSort: { col: "at", dir: "desc" },
  idCol: costEvents.id,
};
/** the object types that have a breakdown of their own (`groupBy=agent|connector|mcp_tool`) */
const TYPED_BREAKDOWNS: ReadonlySet<string> = new Set(["agent", "connector", "mcp_tool"]);
