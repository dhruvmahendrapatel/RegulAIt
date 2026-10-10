/** ADR-0186 V: report actual converted content and explicit coverage limits. */
import type { FastifyInstance } from "fastify";
import type { Db } from "@regulait/db";
import { VENDORED_PACK_MANIFESTS } from "@regulait/shared";
import { loadOrgSettings } from "./org-settings.js";
import { outboundAudienceEnforced } from "./outbound-audience.js";
export function registerDetectionContentRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/detection-content", async () => {
    const settings = await loadOrgSettings(db);
    return {
      packs: VENDORED_PACK_MANIFESTS.map((pack) => ({ ...pack, enabled: settings.vendoredDetectionPacks.includes(pack.id), auditRedactionAlways: pack.id === "pipelock-secrets" })),
      // ADR-0186 decision 32: enforced at the MCP tool, MCP protocol and
      // connector dispatch points (outbound-audience.ts) while the org setting
      // is `enforce` AND the secrets pack is on; zz-b4o-outbound-audience.test.ts
      // proves both dispatch paths refuse. stdio MCP has no host and is out of scope.
      outboundAudienceEnforced: outboundAudienceEnforced(settings),
      outboundCredentialAudience: settings.outboundCredentialAudience,
    };
  });
}
