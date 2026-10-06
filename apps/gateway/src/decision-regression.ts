/**
 * ADR-0182 (ADR-0175 batch D4) A11 — DECISION REGRESSION, AND DECISIONS THAT
 * CITE THEIR VERSIONS. OWNER: A11 (D4).
 *
 * FOUNDATION STUB (P0). Every export keeps its name and signature; A11
 * replaces the bodies. Until then every route answers 501 `not_implemented`.
 * The tables (`governance_review_policy_versions`, `use_case_decision_records`,
 * `decision_regression_cases`, `decision_regression_runs`) and the org
 * settings (`decision_regression_gate`, `decision_regression_max_age_minutes`)
 * are migration 0162's; the bodies are in `@regulait/shared` (accountability.ts).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@regulait/db";

function notImplemented(reply: FastifyReply) {
  return reply.status(501).send({
    error: "not_implemented",
    detail: "decision regression (ADR-0182 A11) is not built yet",
  });
}

/**
 * Routes (classified in route-classes.ts and openapi-registry.ts, A11 block):
 *   POST   /v1/governance/decision-regression/preview          admin
 *   GET    /v1/governance/decision-regression/runs             admin
 *   GET    /v1/governance/decision-regression/runs/:runId      admin
 *   GET    /v1/governance/decision-regression/cases            admin
 *   POST   /v1/governance/decision-regression/cases            admin
 *   DELETE /v1/governance/decision-regression/cases/:caseId    admin (retires the case)
 *   GET    /v1/use-cases/:useCaseId/decision-records           user: the use case's owner or an admin, in-handler
 */
export function registerDecisionRegressionRoutes(app: FastifyInstance, _db: Db): void {
  app.post("/v1/governance/decision-regression/preview", async (_req, reply) => notImplemented(reply));
  app.get("/v1/governance/decision-regression/runs", async (_req, reply) => notImplemented(reply));
  app.get("/v1/governance/decision-regression/runs/:runId", async (_req, reply) => notImplemented(reply));
  app.get("/v1/governance/decision-regression/cases", async (_req, reply) => notImplemented(reply));
  app.post("/v1/governance/decision-regression/cases", async (_req, reply) => notImplemented(reply));
  app.delete("/v1/governance/decision-regression/cases/:caseId", async (_req, reply) => notImplemented(reply));
  app.get("/v1/use-cases/:useCaseId/decision-records", async (_req, reply) => notImplemented(reply));
}
