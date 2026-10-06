/**
 * ADR-0182 (ADR-0175 batch D4) S5 — ALERT OWNER, SLA AND TICKET (PathForward
 * PF-14). OWNER: S5 (D4).
 *
 * FOUNDATION STUB (P0). Every export keeps its name and signature; S5
 * replaces the bodies. Until then:
 *   - `alertOwnershipAtRaise` gives a new episode no owner and no due time
 *     (the governance monitor calls it for every episode it raises);
 *   - `afterAlertsRaised` files nothing (the monitor calls it after each pass;
 *     `alert_ticket_mode` defaults to `manual`, which files nothing anyway);
 *   - the two routes answer 501 `not_implemented`;
 *   - the `alert-sla-sweep` job processes nothing.
 * The columns (`governance_alerts.owner_user_id/owner_source/due_at/
 * sla_breached_at`) and the settings (`alert_sla_hours`, `alert_ticket_mode`)
 * are migration 0162's.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@regulait/db";
import type { AlertOwnerSource, MonitorFinding } from "@regulait/shared";
import type { SchedulerJobDefinition } from "./scheduler.js";

export const ALERT_SLA_SWEEP_JOB_NAME = "alert-sla-sweep";

export interface AlertOwnershipAtRaise {
  ownerUserId: string | null;
  ownerSource: AlertOwnerSource | null;
  dueAt: Date | null;
}

/** Owner and due time for an episode the monitor is about to raise. */
export async function alertOwnershipAtRaise(_db: Db, _finding: MonitorFinding, _now: Date): Promise<AlertOwnershipAtRaise> {
  return { ownerUserId: null, ownerSource: null, dueAt: null };
}

/** Called once per monitor pass with the ids it raised (best effort: a
 * failure here never fails the pass). */
export async function afterAlertsRaised(_db: Db, _raisedIds: readonly string[], _actorUserId: string | null): Promise<void> {
  return;
}

/** The scheduler jobs this slice owns (spread by scheduler-jobs.ts). */
export function alertSlaJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: ALERT_SLA_SWEEP_JOB_NAME,
      description:
        "Not built yet (ADR-0182 S5): will mark governance alert episodes past their due time as breached, once each, " +
        "and escalate unowned or breached episodes to the admins. Never resolves or acknowledges an episode. " +
        "Processes nothing until then.",
      adr: "ADR-0182",
      defaultIntervalSeconds: 15 * 60,
      run: async () => ({ itemsProcessed: 0, detail: { stub: true } }),
    },
  ];
}

function notImplemented(reply: FastifyReply) {
  return reply.status(501).send({
    error: "not_implemented",
    detail: "alert owner, SLA and ticket (ADR-0182 S5) are not built yet",
  });
}

/**
 * Routes (classified in route-classes.ts and openapi-registry.ts, S5 block):
 *   PUT  /v1/governance/alerts/:alertId/owner    user: an admin or the episode's current owner, in-handler
 *   POST /v1/governance/alerts/:alertId/ticket   admin (files one PM work item per episode, idempotent)
 */
export function registerAlertOwnershipRoutes(app: FastifyInstance, _db: Db, _opts: { dataKey?: string | undefined } = {}): void {
  app.put("/v1/governance/alerts/:alertId/owner", async (_req, reply) => notImplemented(reply));
  app.post("/v1/governance/alerts/:alertId/ticket", async (_req, reply) => notImplemented(reply));
}
