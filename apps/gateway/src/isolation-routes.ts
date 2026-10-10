/**
 * ADR-0190 (batch 6 item 3) — isolation and execution profiles. FOUNDATION
 * STUB (slice I1): every admin route the design names is registered here and
 * answers 501 `{error: "not_built"}` until its slice lands. The route list and
 * request bodies are `ISOLATION_ROUTES` and the zod schemas in
 * `@regulait/shared` (`isolation/contract.ts`);
 * `zz-adr0190-i1-foundation.test.ts` pins that this file registers exactly
 * that list.
 *
 * Admin (every relaxing write also needs a `settings_relax` step-up and is audited):
 *   /v1/execution-profiles[...]     list, create, versions, retire (I2)
 *   /v1/executors[...]              register, inspect, attestations, quarantine,
 *                                   re-enable, revoke, the customer_declared mapping (I3)
 *   /v1/execution-placements[...]   placement decisions and refusals (I2)
 *
 * The executor's own channel (ADR-0188 credentials, the outbound stream, its
 * reports) is designed by I3 and is not stubbed here.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@regulait/db";
import { ISOLATION_NOT_BUILT } from "@regulait/shared";

export function registerIsolationRoutes(app: FastifyInstance, _db: Db): void {
  const notBuilt = async (_req: unknown, reply: FastifyReply) => reply.status(501).send(ISOLATION_NOT_BUILT);
  // execution profiles
  app.get("/v1/execution-profiles", notBuilt);
  app.post("/v1/execution-profiles", notBuilt);
  app.get("/v1/execution-profiles/:name", notBuilt);
  app.post("/v1/execution-profiles/:name/versions", notBuilt);
  app.post("/v1/execution-profiles/:name/retire", notBuilt);
  // executors
  app.get("/v1/executors", notBuilt);
  app.post("/v1/executors", notBuilt);
  app.get("/v1/executors/:executorId", notBuilt);
  app.get("/v1/executors/:executorId/attestations", notBuilt);
  app.post("/v1/executors/:executorId/quarantine", notBuilt);
  app.post("/v1/executors/:executorId/reenable", notBuilt);
  app.post("/v1/executors/:executorId/revoke", notBuilt);
  app.put("/v1/executors/:executorId/declared-class", notBuilt);
  // placements
  app.get("/v1/execution-placements", notBuilt);
  app.get("/v1/execution-placements/:placementId", notBuilt);
}
