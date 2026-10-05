/**
 * ADR-0180 A10 — RISK TOLERANCE AND TIME-BOXED ACCEPTANCE. OWNER: A10 (D3).
 *
 * FOUNDATION STUB (P0). Every export below keeps its name and signature; A10
 * replaces the bodies (and adds the expiry sweep here). Until then:
 *   - `residualPosition` reports no positions;
 *   - `residualRiskMonitorInput` reports no breach for either rule;
 *   - the four routes answer 501 `not_implemented`.
 *
 * ACCEPTANCE ROUTE DECISION (P0, ADR-0180): `POST /v1/risks/:riskId/acceptances`
 * is the new record-keeping path (history rows in `risk_acceptances`, with
 * response type, expiry, rationale and compensating controls). The legacy
 * `POST /v1/risks/:riskId/accept` stays registered and becomes a WRAPPER: it
 * writes the same `risk_acceptances` row (response type `accept`, rationale =
 * its note, expiry = the strict maximum for the residual band) through the
 * same code, so there is one acceptance write path and no second record shape.
 *
 * Schema (migration 0155): `risk_tolerances` (empty = the strict default in
 * code) and `risk_acceptances` (rationale and revoke_reason prose-scrubbed;
 * compensating_controls is jsonb, so its writer scrubs each description).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@regulait/db";
import {
  noopResidualPosition,
  type AssuranceMonitorRuleId,
  type MonitorAssuranceInput,
  type ResidualPositionFn,
} from "@regulait/shared";

/** Each risk of the use case: its residual band, tolerance, live acceptance
 * and whether it sits above tolerance with no valid acceptance. */
export const residualPosition: ResidualPositionFn<Db> = noopResidualPosition;

/** The monitor's loader for `residual_above_tolerance` and
 * `risk_acceptance_expired` (governance-monitor.ts). */
export async function residualRiskMonitorInput(
  _db: Db,
  _now: Date,
): Promise<Partial<Record<AssuranceMonitorRuleId, MonitorAssuranceInput>>> {
  return { residual_above_tolerance: { breaches: [] }, risk_acceptance_expired: { breaches: [] } };
}

function notImplemented(reply: FastifyReply) {
  return reply.status(501).send({
    error: "not_implemented",
    detail: "risk tolerance and time-boxed acceptance (ADR-0180 A10) are not built yet",
  });
}

/**
 * Routes (classified in route-classes.ts and openapi-registry.ts, A10 block):
 *   GET  /v1/risk-tolerances                admin
 *   PUT  /v1/risk-tolerances                admin, audited (relaxing the strict default)
 *   GET  /v1/risks/:riskId/acceptances      non-admin; owner-or-admin in-handler like GET /v1/risks/:riskId
 *   POST /v1/risks/:riskId/acceptances      admin (like the legacy accept), audited
 */
export function registerRiskToleranceRoutes(app: FastifyInstance, _db: Db): void {
  app.get("/v1/risk-tolerances", async (_req, reply) => notImplemented(reply));
  app.put("/v1/risk-tolerances", async (_req, reply) => notImplemented(reply));
  app.get("/v1/risks/:riskId/acceptances", async (_req, reply) => notImplemented(reply));
  app.post("/v1/risks/:riskId/acceptances", async (_req, reply) => notImplemented(reply));
}
