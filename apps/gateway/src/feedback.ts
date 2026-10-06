/**
 * ADR-0182 (ADR-0175 batch D4) A13 — END-USER FEEDBACK AND APPEAL. OWNER: A13 (D4).
 *
 * FOUNDATION STUB (P0). Every export keeps its name and signature; A13
 * replaces the bodies. Until then:
 *   - every route answers 501 `not_implemented`, including the two public
 *     signed-link routes (the one AUTH_EXEMPT addition of D4), which read and
 *     store nothing;
 *   - `feedbackMonitorInput` reports no `feedback_sla_breached` breach;
 *   - the `feedback-sla-sweep` and `feedback-retention-sweep` jobs process nothing.
 * The tables (`use_case_feedback`, `use_case_feedback_links`) and the org
 * settings (`feedback_signed_links_enabled` (off), `feedback_ack_sla_hours`,
 * `feedback_resolve_sla_days`, `feedback_retention_days`) are migration 0162's.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@regulait/db";
import type { AccountabilityMonitorRuleId, MonitorAssuranceInput } from "@regulait/shared";
import type { SchedulerJobDefinition } from "./scheduler.js";

export const FEEDBACK_SLA_SWEEP_JOB_NAME = "feedback-sla-sweep";
export const FEEDBACK_RETENTION_SWEEP_JOB_NAME = "feedback-retention-sweep";

/** The monitor's loader for `feedback_sla_breached` (governance-monitor.ts). */
export async function feedbackMonitorInput(
  _db: Db,
  _now: Date,
): Promise<Partial<Record<AccountabilityMonitorRuleId, MonitorAssuranceInput>>> {
  return { feedback_sla_breached: { breaches: [] } };
}

/** The scheduler jobs this slice owns (spread by scheduler-jobs.ts). */
export function feedbackJobDefinitions(_opts: { dataKey?: string | undefined } = {}): SchedulerJobDefinition[] {
  return [
    {
      name: FEEDBACK_SLA_SWEEP_JOB_NAME,
      description:
        "Not built yet (ADR-0182 A13): will mark feedback past its acknowledgement or resolution time and alert the " +
        "owner and the admins. Processes nothing until then.",
      adr: "ADR-0182",
      defaultIntervalSeconds: 15 * 60,
      run: async () => ({ itemsProcessed: 0, detail: { stub: true } }),
    },
    {
      name: FEEDBACK_RETENTION_SWEEP_JOB_NAME,
      description:
        "Not built yet (ADR-0182 A13): will delete feedback bodies and contact details older than the org's " +
        "retention, keeping the resolution record. Processes nothing until then.",
      adr: "ADR-0182",
      defaultIntervalSeconds: 24 * 3600,
      run: async () => ({ itemsProcessed: 0, detail: { stub: true } }),
    },
  ];
}

function notImplemented(reply: FastifyReply) {
  return reply.status(501).send({
    error: "not_implemented",
    detail: "end-user feedback and appeal (ADR-0182 A13) is not built yet",
  });
}

/**
 * Routes (classified in route-classes.ts and openapi-registry.ts, A13 block):
 *   POST   /v1/use-cases/:useCaseId/feedback                    user: any signed-in user
 *   GET    /v1/feedback                                         user: the caller's queue (admin: all)
 *   GET    /v1/feedback/:feedbackId                             user: owner or admin (a body read is audited)
 *   PATCH  /v1/feedback/:feedbackId                             user: owner or admin
 *   POST   /v1/feedback/:feedbackId/open-incident               user: owner or admin
 *   POST   /v1/use-cases/:useCaseId/feedback-links              user: the use case's owner or admin
 *   GET    /v1/use-cases/:useCaseId/feedback-links              user: the use case's owner or admin
 *   DELETE /v1/use-cases/:useCaseId/feedback-links/:linkId      user: the use case's owner or admin (revokes)
 *   POST   /v1/feedback/l/:token                                PUBLIC (signed link; 404 while the setting is off)
 *   GET    /v1/feedback/l/:token                                PUBLIC (the use case's public name only)
 */
export function registerFeedbackRoutes(app: FastifyInstance, _db: Db, _opts: { dataKey?: string | undefined } = {}): void {
  app.post("/v1/use-cases/:useCaseId/feedback", async (_req, reply) => notImplemented(reply));
  app.get("/v1/feedback", async (_req, reply) => notImplemented(reply));
  app.get("/v1/feedback/:feedbackId", async (_req, reply) => notImplemented(reply));
  app.patch("/v1/feedback/:feedbackId", async (_req, reply) => notImplemented(reply));
  app.post("/v1/feedback/:feedbackId/open-incident", async (_req, reply) => notImplemented(reply));
  app.post("/v1/use-cases/:useCaseId/feedback-links", async (_req, reply) => notImplemented(reply));
  app.get("/v1/use-cases/:useCaseId/feedback-links", async (_req, reply) => notImplemented(reply));
  app.delete("/v1/use-cases/:useCaseId/feedback-links/:linkId", async (_req, reply) => notImplemented(reply));
  app.post("/v1/feedback/l/:token", async (_req, reply) => notImplemented(reply));
  app.get("/v1/feedback/l/:token", async (_req, reply) => notImplemented(reply));
}
