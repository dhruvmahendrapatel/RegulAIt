/**
 * ADR-0186 V — the vendored detection content's admin surface (slice V, Codex).
 * FOUNDATION STUB.
 *
 *   GET /v1/detection-content (admin) →
 *     {packs: [{id, source, commit, sha256, licence, rules, notImported, enabled}]}
 *
 * The data and its provenance live in `@regulait/shared`'s
 * `detection-content/` (`VENDORED_PACK_MANIFESTS`); `enabled` is
 * `org_settings.vendored_detection_packs`.
 */
import type { FastifyInstance } from "fastify";
import type { Db } from "@regulait/db";
import { BATCH4_NOT_BUILT } from "@regulait/shared";

export function registerDetectionContentRoutes(app: FastifyInstance, _db: Db): void {
  app.get("/v1/detection-content", async (_req, reply) => reply.status(501).send(BATCH4_NOT_BUILT));
}
