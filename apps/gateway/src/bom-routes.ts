/**
 * ADR-0189 (batch 6 item 2) — the Decision BOM and AI BOM routes. FOUNDATION
 * STUB (slice B1): every route §9 names is registered here and answers 501
 * `{error: "not_built"}` until its slice lands (B3 snapshots and drift, B4
 * Decision BOMs, bundles and verify). The list is `BOM_ROUTES` in
 * `@regulait/shared` (`bom/contract.ts`); `zz-adr0189-b1-foundation.test.ts`
 * pins that this file registers exactly that list.
 *
 * Every route is ADMIN-ONLY at the route-class layer (the default; none is in
 * `NON_ADMIN_ROUTES`). §9 also admits holders of an explicit auditor grant when
 * `bom_export_roles` is relaxed; that in-handler check lands with B4, and only
 * then may a route move to `NON_ADMIN_ROUTES` (strict until then).
 *
 *   POST /v1/ai-bom/:subjectKind/:subjectId/snapshots   freeze and sign (B3; disabled until R17)
 *   GET  /v1/ai-bom/:subjectKind/:subjectId/snapshots   the subject's snapshot list (B3; the B6 tab)
 *   GET  /v1/ai-bom/:subjectKind/:subjectId/drift       change list, `evidence: false` (B3, R8)
 *   GET  /v1/ai-bom/snapshots/:snapshotId               signed snapshot, by format (B3/B4, R7)
 *   GET  /v1/ai-bom/snapshots/:snapshotId/bundle        export-bundle/3 (B4)
 *   GET  /v1/decisions/:auditId/bom                     the signed Decision BOM (B4)
 *   GET  /v1/decisions/:auditId/bom/bundle              export-bundle/3 (B4)
 *   POST /v1/boms/verify                                the pure verifier, online (B4, R6)
 *
 * Written out literally (not looped over BOM_ROUTES) so the affordance census
 * (`scripts/preflight-ui-affordances.mjs`) sees every route.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@regulait/db";
import { BOM_NOT_BUILT } from "@regulait/shared";

export function registerBomRoutes(app: FastifyInstance, _db: Db): void {
  const notBuilt = async (_req: unknown, reply: FastifyReply) => reply.status(501).send(BOM_NOT_BUILT);
  app.post("/v1/ai-bom/:subjectKind/:subjectId/snapshots", notBuilt);
  app.get("/v1/ai-bom/:subjectKind/:subjectId/snapshots", notBuilt);
  app.get("/v1/ai-bom/:subjectKind/:subjectId/drift", notBuilt);
  app.get("/v1/ai-bom/snapshots/:snapshotId", notBuilt);
  app.get("/v1/ai-bom/snapshots/:snapshotId/bundle", notBuilt);
  app.get("/v1/decisions/:auditId/bom", notBuilt);
  app.get("/v1/decisions/:auditId/bom/bundle", notBuilt);
  app.post("/v1/boms/verify", notBuilt);
}
