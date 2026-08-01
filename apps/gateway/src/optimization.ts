import type { FastifyInstance } from "fastify";
import { costEvents, count, desc, eq, sql, usageEvents, type Db, type SQL } from "@regulait/db";
import { z } from "zod";
import { streamUsageEventsCsv } from "./projects.js";
import { resolveCsvWindow } from "./csv-export.js";

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
  app.get("/v1/cost-events", async (req, reply) => {
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

  // PILLAR 5 actuals: the measured-spend ledger written by real dispatches.
  // Same visibility rule as cost-events — non-admins see only themselves.
  app.get("/v1/usage-events", async (req, reply) => {
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
}
