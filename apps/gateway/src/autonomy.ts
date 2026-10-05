/**
 * ADR-0180 A8 — AGENT AUTONOMY CLASS. OWNER: A8 (D3).
 *
 * FOUNDATION STUB (P0). Every export below keeps its name and signature; A8
 * replaces the bodies. Until then:
 *   - `autonomyFloorFor` reports no facts, no class and nothing unmet;
 *   - `autonomyMonitorInput` reports no breach for either rule;
 *   - the two routes answer 501 `not_implemented`.
 *
 * Schema (migration 0155): `builder_agents.declared_autonomy_class`,
 * `autonomy_declared_by`, `autonomy_declared_at`, `autonomy_note` (prose-scrubbed).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@regulait/db";
import {
  noopAutonomyFloorFor,
  type AssuranceMonitorRuleId,
  type AutonomyFloorForFn,
  type MonitorAssuranceInput,
} from "@regulait/shared";

/** A use case's autonomy facts, derived and declared class, and unmet floor. */
export const autonomyFloorFor: AutonomyFloorForFn<Db> = noopAutonomyFloorFor;

/** The monitor's loader for `autonomy_declared_below_observed` and
 * `autonomy_floor_unmet` (governance-monitor.ts). */
export async function autonomyMonitorInput(
  _db: Db,
  _now: Date,
): Promise<Partial<Record<AssuranceMonitorRuleId, MonitorAssuranceInput>>> {
  return { autonomy_declared_below_observed: { breaches: [] }, autonomy_floor_unmet: { breaches: [] } };
}

function notImplemented(reply: FastifyReply) {
  return reply.status(501).send({
    error: "not_implemented",
    detail: "agent autonomy classes (ADR-0180 A8) are not built yet",
  });
}

/**
 * Routes (classified in route-classes.ts and openapi-registry.ts, A8 block):
 *   GET /v1/builder/agents/:id/autonomy  non-admin; visibility checked in-handler like GET /v1/builder/agents/:id
 *   PUT /v1/builder/agents/:id/autonomy  non-admin; owner-or-admin in-handler (the agent's steward), audited
 */
export function registerAutonomyRoutes(app: FastifyInstance, _db: Db): void {
  app.get("/v1/builder/agents/:id/autonomy", async (_req, reply) => notImplemented(reply));
  app.put("/v1/builder/agents/:id/autonomy", async (_req, reply) => notImplemented(reply));
}
