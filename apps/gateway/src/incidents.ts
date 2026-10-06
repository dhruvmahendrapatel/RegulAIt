/**
 * ADR-0182 (ADR-0175 batch D4) A12 — THE AI INCIDENT REGISTER. OWNER: A12 (D4).
 *
 * FOUNDATION STUB (P0). Every export keeps its name and signature; A12
 * replaces the bodies. Until then:
 *   - every route answers 501 `not_implemented`;
 *   - `incidentMonitorInput` reports no breach for `incident_notification_due`
 *     and `incident_action_overdue` (both rules evaluated, nothing raised);
 *   - the `incident-clock-sweep` job processes nothing.
 * Containment calls `haltAgentInTx` (execution-control.ts). The tables
 * (`ai_incidents` and its events, links, actions and notification clocks) and
 * the org settings (`incident_gate_mode`, `incident_evidence_hold`,
 * `incident_clock_regimes`) are migration 0162's.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@regulait/db";
import type { AccountabilityMonitorRuleId, MonitorAssuranceInput } from "@regulait/shared";
import type { SchedulerJobDefinition } from "./scheduler.js";

export const INCIDENT_CLOCK_SWEEP_JOB_NAME = "incident-clock-sweep";

/** The monitor's loader for the two incident rules (governance-monitor.ts). */
export async function incidentMonitorInput(
  _db: Db,
  _now: Date,
): Promise<Partial<Record<AccountabilityMonitorRuleId, MonitorAssuranceInput>>> {
  return { incident_notification_due: { breaches: [] }, incident_action_overdue: { breaches: [] } };
}

/** The scheduler jobs this slice owns (spread by scheduler-jobs.ts). */
export function incidentJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: INCIDENT_CLOCK_SWEEP_JOB_NAME,
      description:
        "Not built yet (ADR-0182 A12): will flag incident notification clocks that fall due within 24 hours or are " +
        "overdue. Processes nothing until then.",
      adr: "ADR-0182",
      defaultIntervalSeconds: 15 * 60,
      run: async () => ({ itemsProcessed: 0, detail: { stub: true } }),
    },
  ];
}

function notImplemented(reply: FastifyReply) {
  return reply.status(501).send({
    error: "not_implemented",
    detail: "the AI incident register (ADR-0182 A12) is not built yet",
  });
}

/**
 * Routes (classified in route-classes.ts and openapi-registry.ts, A12 block):
 *   GET   /v1/incidents                                         user: filtered to what the caller may see
 *   POST  /v1/incidents                                         user: anyone may report an incident
 *   GET   /v1/incidents/:incidentId                             user: owner, linked use-case owner or admin
 *   PATCH /v1/incidents/:incidentId                             user: owner or admin
 *   POST  /v1/incidents/:incidentId/events                      user: owner or admin
 *   POST  /v1/incidents/:incidentId/links                       user: owner or admin
 *   POST  /v1/incidents/:incidentId/actions                     user: owner or admin
 *   PATCH /v1/incidents/:incidentId/actions/:actionId           user: owner, the action's owner or admin
 *   POST  /v1/incidents/:incidentId/notifications/:notificationId/sent          user: owner or admin
 *   POST  /v1/incidents/:incidentId/notifications/:notificationId/not-required  admin, reason required
 *   POST  /v1/incidents/:incidentId/notifications/:notificationId/toll          admin, reason required
 *   POST  /v1/incidents/:incidentId/close                       user: owner or admin
 *   POST  /v1/incidents/:incidentId/contain                     admin (halts a linked agent)
 *   GET   /v1/incidents/:incidentId/export                      admin (signed bundle)
 */
export function registerIncidentRoutes(app: FastifyInstance, _db: Db, _opts: { dataKey?: string | undefined } = {}): void {
  app.get("/v1/incidents", async (_req, reply) => notImplemented(reply));
  app.post("/v1/incidents", async (_req, reply) => notImplemented(reply));
  app.get("/v1/incidents/:incidentId", async (_req, reply) => notImplemented(reply));
  app.patch("/v1/incidents/:incidentId", async (_req, reply) => notImplemented(reply));
  app.post("/v1/incidents/:incidentId/events", async (_req, reply) => notImplemented(reply));
  app.post("/v1/incidents/:incidentId/links", async (_req, reply) => notImplemented(reply));
  app.post("/v1/incidents/:incidentId/actions", async (_req, reply) => notImplemented(reply));
  app.patch("/v1/incidents/:incidentId/actions/:actionId", async (_req, reply) => notImplemented(reply));
  app.post("/v1/incidents/:incidentId/notifications/:notificationId/sent", async (_req, reply) => notImplemented(reply));
  app.post("/v1/incidents/:incidentId/notifications/:notificationId/not-required", async (_req, reply) =>
    notImplemented(reply),
  );
  app.post("/v1/incidents/:incidentId/notifications/:notificationId/toll", async (_req, reply) => notImplemented(reply));
  app.post("/v1/incidents/:incidentId/close", async (_req, reply) => notImplemented(reply));
  app.post("/v1/incidents/:incidentId/contain", async (_req, reply) => notImplemented(reply));
  app.get("/v1/incidents/:incidentId/export", async (_req, reply) => notImplemented(reply));
}
