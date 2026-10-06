/**
 * ADR-0182 (ADR-0175 batch D4) A14 — AI LITERACY AND ACCEPTABLE-USE
 * ACKNOWLEDGEMENTS. OWNER: A14 (D4).
 *
 * FOUNDATION STUB (P0). Every export keeps its name and signature; A14
 * replaces the bodies. Until then:
 *   - every route answers 501 `not_implemented`;
 *   - `literacyMonitorInput` reports no `literacy_coverage_gap` breach;
 *   - the `literacy-expiry-sweep` job processes nothing;
 *   - the kernel's `ExecutionPosture.literacy` slot is left empty, which means
 *     "not required" (policy-kernel `LITERACY_NOT_REQUIRED`), so nothing is gated.
 * The tables (`ai_policy_documents`, `ai_policy_acknowledgements`) and the org
 * settings (`literacy_gate_mode`, `literacy_default_validity_days`) are
 * migration 0162's.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@regulait/db";
import type { AccountabilityMonitorRuleId, MonitorAssuranceInput } from "@regulait/shared";
import type { SchedulerJobDefinition } from "./scheduler.js";

export const LITERACY_EXPIRY_SWEEP_JOB_NAME = "literacy-expiry-sweep";

/** The monitor's loader for `literacy_coverage_gap` (governance-monitor.ts). */
export async function literacyMonitorInput(
  _db: Db,
  _now: Date,
): Promise<Partial<Record<AccountabilityMonitorRuleId, MonitorAssuranceInput>>> {
  return { literacy_coverage_gap: { breaches: [] } };
}

/** The scheduler jobs this slice owns (spread by scheduler-jobs.ts). */
export function literacyJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: LITERACY_EXPIRY_SWEEP_JOB_NAME,
      description:
        "Not built yet (ADR-0182 A14): will notify people whose AI policy acknowledgement expires within 14 days. " +
        "Processes nothing until then.",
      adr: "ADR-0182",
      defaultIntervalSeconds: 24 * 3600,
      run: async () => ({ itemsProcessed: 0, detail: { stub: true } }),
    },
  ];
}

function notImplemented(reply: FastifyReply) {
  return reply.status(501).send({
    error: "not_implemented",
    detail: "AI literacy and acceptable-use acknowledgements (ADR-0182 A14) are not built yet",
  });
}

/**
 * Routes (classified in route-classes.ts and openapi-registry.ts, A14 block):
 *   GET  /v1/ai-policies                         user: what applies to the caller (admin: all)
 *   POST /v1/ai-policies                         admin
 *   GET  /v1/ai-policies/coverage                admin
 *   POST /v1/ai-policies/:policyId/publish       admin
 *   POST /v1/ai-policies/:policyId/retire        admin
 *   POST /v1/ai-policies/:policyId/acknowledge   user: self only
 *   POST /v1/ai-policies/:policyId/records       admin (completion from an external training system)
 *   GET  /v1/me/ai-literacy                      user: self only
 */
export function registerAiLiteracyRoutes(app: FastifyInstance, _db: Db): void {
  app.get("/v1/ai-policies", async (_req, reply) => notImplemented(reply));
  app.post("/v1/ai-policies", async (_req, reply) => notImplemented(reply));
  app.get("/v1/ai-policies/coverage", async (_req, reply) => notImplemented(reply));
  app.post("/v1/ai-policies/:policyId/publish", async (_req, reply) => notImplemented(reply));
  app.post("/v1/ai-policies/:policyId/retire", async (_req, reply) => notImplemented(reply));
  app.post("/v1/ai-policies/:policyId/acknowledge", async (_req, reply) => notImplemented(reply));
  app.post("/v1/ai-policies/:policyId/records", async (_req, reply) => notImplemented(reply));
  app.get("/v1/me/ai-literacy", async (_req, reply) => notImplemented(reply));
}
