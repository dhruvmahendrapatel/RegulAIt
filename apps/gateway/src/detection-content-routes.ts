/** ADR-0186 V: report actual converted content and explicit coverage limits. */
import type { FastifyInstance } from "fastify";
import type { Db } from "@regulait/db";
import { VENDORED_PACK_MANIFESTS } from "@regulait/shared";
import { loadOrgSettings } from "./org-settings.js";
export function registerDetectionContentRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/detection-content", async () => {
    const settings = await loadOrgSettings(db);
    return {
      packs: VENDORED_PACK_MANIFESTS.map((pack) => ({ ...pack, enabled: settings.vendoredDetectionPacks.includes(pack.id), auditRedactionAlways: pack.id === "pipelock-secrets" })),
      // The foundation has no outbound audience hook. A pure helper alone is
      // not installed enforcement; change this only with the integration test.
      outboundAudienceEnforced: false,
    };
  });
}
