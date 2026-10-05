/**
 * ADR-0173 batch 2c (K) — CUSTOM MONITORING DASHBOARDS. Admin-only (none is in
 * NON_ADMIN_ROUTES): a dashboard plots fleet-wide series.
 *
 *   GET    /v1/monitoring/dashboards
 *   POST   /v1/monitoring/dashboards
 *   PATCH  /v1/monitoring/dashboards/:dashboardId
 *   DELETE /v1/monitoring/dashboards/:dashboardId
 *
 * A dashboard is a name and at most 24 panels; every panel is validated by
 * the shared `dashboardPanelSchema` (a KRI tile, or a series with a bounded
 * range and bucket), so a stored dashboard can never ask the series route for
 * more than it would answer. A KRI panel naming a KRI that no longer exists
 * renders as "removed", it is not an error. Every write is audited.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditLog, eq, monitoringDashboards, type Db, type MonitoringDashboardRow } from "@regulait/db";
import { dashboardSchema } from "@regulait/shared";

const NIL_USER = "00000000-0000-0000-0000-000000000000";
const idParam = z.object({ dashboardId: z.string().uuid() });
const updateSchema = dashboardSchema.partial().strict();

function view(d: MonitoringDashboardRow) {
  return {
    id: d.id,
    name: d.name,
    panels: d.panels,
    createdByUserId: d.createdByUserId,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

export function registerDashboardRoutes(app: FastifyInstance, db: Db): void {
  const audit = (userId: string | null | undefined, objectId: string, ruleId: string, reason: string, detail: Record<string, unknown>) =>
    db.insert(auditLog).values({
      userId: userId ?? NIL_USER,
      objectType: "monitoring_dashboard",
      objectId,
      detail,
      effect: "allow",
      ruleId,
      ruleChain: [],
      reason,
    });

  app.get("/v1/monitoring/dashboards", async () => {
    const rows = await db.select().from(monitoringDashboards).orderBy(monitoringDashboards.createdAt);
    return { dashboards: rows.map(view) };
  });

  app.post("/v1/monitoring/dashboards", async (req, reply) => {
    const body = dashboardSchema.parse(req.body);
    const [row] = await db
      .insert(monitoringDashboards)
      .values({ name: body.name, panels: body.panels as Array<Record<string, unknown>>, createdByUserId: req.authCtx.userId ?? null })
      .returning();
    await audit(req.authCtx.userId, row!.id, "monitoring-dashboard-created", `dashboard '${row!.name}' created`, { panels: body.panels.length });
    return reply.status(201).send(view(row!));
  });

  app.patch("/v1/monitoring/dashboards/:dashboardId", async (req, reply) => {
    const { dashboardId } = idParam.parse(req.params);
    const body = updateSchema.parse(req.body);
    const [row] = await db
      .update(monitoringDashboards)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.panels !== undefined ? { panels: body.panels as Array<Record<string, unknown>> } : {}),
        updatedAt: new Date(),
      })
      .where(eq(monitoringDashboards.id, dashboardId))
      .returning();
    if (!row) return reply.status(404).send({ error: "not_found" });
    await audit(req.authCtx.userId, row.id, "monitoring-dashboard-updated", `dashboard '${row.name}' changed`, {
      changed: Object.keys(body),
      panels: row.panels.length,
    });
    return view(row);
  });

  app.delete("/v1/monitoring/dashboards/:dashboardId", async (req, reply) => {
    const { dashboardId } = idParam.parse(req.params);
    const [row] = await db.delete(monitoringDashboards).where(eq(monitoringDashboards.id, dashboardId)).returning();
    if (!row) return reply.status(404).send({ error: "not_found" });
    await audit(req.authCtx.userId, row.id, "monitoring-dashboard-deleted", `dashboard '${row.name}' deleted`, {});
    return { deleted: true };
  });
}
