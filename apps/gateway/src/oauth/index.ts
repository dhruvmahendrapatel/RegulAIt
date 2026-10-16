/**
 * ADR-0188 slice S5 — the external identity surface, registered in one place:
 * the client-certificate admission hook (decision 21), the token endpoint
 * (decisions 7, 15, 23), revocation and introspection, the human delegation
 * proof (decision 15 step 1), and the delegation grant admin backend.
 */
import type { FastifyInstance } from "fastify";
import type { Db } from "@regulait/db";
import { createDelegationProofRoute } from "./delegation-proof.js";
import { registerGrantAdminRoutes } from "./grant-admin.js";
import { registerTokenAdminEndpoints } from "./token-admin.js";
import { registerTokenEndpoint } from "./token-endpoint.js";
import { registerClientCertificateHook } from "./x509.js";
import { warnIfLegacySpiffeEnv } from "./spiffe-bundles.js";

export function registerOAuthRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined }): void {
  registerClientCertificateHook(app);
  // ADR-0188 S9: the S5 SPIFFE bundle variable is ignored; say so once at boot
  warnIfLegacySpiffeEnv(app.log);
  registerTokenEndpoint(app, db, opts);
  registerTokenAdminEndpoints(app, db);
  app.post("/v1/delegations/proofs", async (req, reply) => createDelegationProofRoute(db, req, reply));
  registerGrantAdminRoutes(app, db);
}
