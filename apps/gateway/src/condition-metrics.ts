/**
 * ADR-0180 A2 — MEASURABLE CONDITIONS. OWNER: A2 (D3).
 *
 * FOUNDATION STUB (P0). Every export below keeps its name and signature; A2
 * replaces the bodies. Until then:
 *   - `measureAssuranceMetric` reports `not_run` (nothing measured, never a pass);
 *   - `evaluateUseCaseConditions` returns no verdicts;
 *   - `conditionMetricsMonitorInput` reports no breach;
 *   - the two routes answer 501 `not_implemented`.
 *
 * Callers (A3's gate composition, A8, A10, the monitor) import from THIS
 * module, so A2 landing changes their behaviour without changing an import.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@regulait/db";
import {
  noopEvaluateUseCaseConditions,
  noopMeasureAssuranceMetric,
  type EvaluateUseCaseConditionsFn,
  type MeasureAssuranceMetricFn,
  type MonitorAssuranceInput,
  type AssuranceMonitorRuleId,
} from "@regulait/shared";

/** Measure one metric over a use case's scope. Reused by A3, A8 and A10. */
export const measureAssuranceMetric: MeasureAssuranceMetricFn<Db> = noopMeasureAssuranceMetric;

/** Evaluate a use case's conditions; `persist` writes the last_* columns. The
 * deploy gate (persist: false) and the monitor (persist: true) both call it. */
export const evaluateUseCaseConditions: EvaluateUseCaseConditionsFn<Db> = noopEvaluateUseCaseConditions;

/** The monitor's loader for `condition_metric_breached` (governance-monitor.ts). */
export async function conditionMetricsMonitorInput(
  _db: Db,
  _now: Date,
): Promise<Partial<Record<AssuranceMonitorRuleId, MonitorAssuranceInput>>> {
  return { condition_metric_breached: { breaches: [] } };
}

function notImplemented(reply: FastifyReply) {
  return reply.status(501).send({
    error: "not_implemented",
    detail: "measurable conditions (ADR-0180 A2) are not built yet",
  });
}

/**
 * Routes (classified in route-classes.ts and openapi-registry.ts, A2 block):
 *   POST /v1/use-cases/:useCaseId/conditions/:conditionId/evaluate  admin
 *   POST /v1/use-cases/:useCaseId/conditions/:conditionId/waive     admin, reason required, audited
 */
export function registerConditionMetricRoutes(app: FastifyInstance, _db: Db): void {
  app.post("/v1/use-cases/:useCaseId/conditions/:conditionId/evaluate", async (_req, reply) => notImplemented(reply));
  app.post("/v1/use-cases/:useCaseId/conditions/:conditionId/waive", async (_req, reply) => notImplemented(reply));
}
