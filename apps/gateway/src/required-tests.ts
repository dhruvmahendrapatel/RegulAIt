/**
 * ADR-0180 A3 — REQUIRED AI TEST CLASSES PER RISK TIER. OWNER: A3 (D3).
 *
 * FOUNDATION STUB (P0). Every export below keeps its name and signature; A3
 * replaces the bodies. Until then:
 *   - `requiredTestConditionsFor` requires nothing;
 *   - `requiredTestsMonitorInput` reports no breach;
 *   - the two routes answer 501 `not_implemented`.
 *
 * STORAGE DECISION (P0, ADR-0180): the per-tier required classes and their
 * freshness live in `governance_review_policy.required_tests` (migration
 * 0155), a column of their own rather than a key inside `tiers`. The existing
 * `PUT /v1/governance/review-policy` rebuilds `tiers` from its own schema and
 * would silently drop an unknown key; a separate column and a separate route
 * keep that PUT (and gateway review-policy.ts) untouched. An absent tier key =
 * the strict default in code.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@regulait/db";
import {
  noopRequiredTestConditionsFor,
  type AssuranceMonitorRuleId,
  type MonitorAssuranceInput,
  type RequiredTestConditionsForFn,
} from "@regulait/shared";

/** The conditions a tier's policy requires; called when conditions are
 * imposed and by the gate. Pure (A3 may move it into shared and re-export). */
export const requiredTestConditionsFor: RequiredTestConditionsForFn = noopRequiredTestConditionsFor;

/** The monitor's loader for `required_test_stale` (governance-monitor.ts). */
export async function requiredTestsMonitorInput(
  _db: Db,
  _now: Date,
): Promise<Partial<Record<AssuranceMonitorRuleId, MonitorAssuranceInput>>> {
  return { required_test_stale: { breaches: [] } };
}

function notImplemented(reply: FastifyReply) {
  return reply.status(501).send({
    error: "not_implemented",
    detail: "required AI test classes (ADR-0180 A3) are not built yet",
  });
}

/**
 * Routes (classified in route-classes.ts and openapi-registry.ts, A3 block):
 *   GET /v1/governance/review-policy/required-tests  any signed-in user (like GET review-policy)
 *   PUT /v1/governance/review-policy/required-tests  admin, audited
 * The path sits under the existing `/v1/governance/review-policy` prefix.
 */
export function registerRequiredTestRoutes(app: FastifyInstance, _db: Db): void {
  app.get("/v1/governance/review-policy/required-tests", async (_req, reply) => notImplemented(reply));
  app.put("/v1/governance/review-policy/required-tests", async (_req, reply) => notImplemented(reply));
}
