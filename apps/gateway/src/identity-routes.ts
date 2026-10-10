/**
 * ADR-0188 (batch 6 item 1) — per-agent and workload identity, and constrained
 * delegation. FOUNDATION STUB (slice S1): every route the design names is
 * registered here, under its auth class, and answers 501 `{error: "not_built"}`
 * until its slice lands. The route list, auth classes and request bodies are
 * `IDENTITY_ROUTES` and the zod schemas in `@regulait/shared`
 * (`identity/contract.ts`); `zz-adr0188-s1-foundation.test.ts` pins that this
 * file registers exactly that list.
 *
 * Public (no RegulAIt credential; each authenticates IN-ROUTE once built):
 *   GET  /.well-known/jwks.json             the issuer's public keys (S3)
 *   POST /oauth/token                       RFC 8693 token exchange (S5): client
 *                                           assertion / mTLS / SVID + DPoP
 *   POST /oauth/token/revocation            RFC 7009 (S5)
 *   POST /oauth/token/introspection         RFC 7662 (S5)
 * Signed-in person, acting for themselves (OWNER DECISION 4: a session or an
 * MFA-qualified API key; never the bootstrap token or a virtual key):
 *   POST /v1/delegations/proofs             a one-use delegation proof (S5)
 * Admin (every write also needs an `identity_manage` step-up and is audited):
 *   /v1/workload-identities[...]            identities, credentials, own grants (S6 UI)
 *   /v1/delegation-grants[...]              list (a run's tree with ?runId=), inspect, cascade-revoke (S6 UI)
 *   /v1/identity/picker-sources             the options the identity forms offer (S6 UI)
 *   /v1/identity/signing-keys[...]          issuer key list, rotate, revoke (S3)
 *
 * The routes are written out literally (not looped over IDENTITY_ROUTES) so the
 * affordance census (`scripts/preflight-ui-affordances.mjs`) sees the DELETE.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@regulait/db";
import { IDENTITY_NOT_BUILT } from "@regulait/shared";

export function registerIdentityRoutes(app: FastifyInstance, _db: Db): void {
  const notBuilt = async (_req: unknown, reply: FastifyReply) => reply.status(501).send(IDENTITY_NOT_BUILT);
  // public
  app.get("/.well-known/jwks.json", notBuilt);
  app.post("/oauth/token", notBuilt);
  app.post("/oauth/token/revocation", notBuilt);
  app.post("/oauth/token/introspection", notBuilt);
  // a person acting for themselves
  app.post("/v1/delegations/proofs", notBuilt);
  // admin: identities, credentials, an agent's own grants
  app.get("/v1/workload-identities", notBuilt);
  app.post("/v1/workload-identities", notBuilt);
  app.get("/v1/workload-identities/:identityId", notBuilt);
  app.patch("/v1/workload-identities/:identityId", notBuilt);
  app.post("/v1/workload-identities/:identityId/revoke", notBuilt);
  app.get("/v1/workload-identities/:identityId/credentials", notBuilt);
  app.post("/v1/workload-identities/:identityId/credentials", notBuilt);
  app.delete("/v1/workload-identities/:identityId/credentials/:credentialId", notBuilt);
  app.get("/v1/workload-identities/:identityId/grants", notBuilt);
  app.put("/v1/workload-identities/:identityId/grants", notBuilt);
  app.get("/v1/workload-identities/:identityId/grant-proposals", notBuilt);
  // admin: what the identity forms may offer (sponsors, subjects, environments, grant targets)
  app.get("/v1/identity/picker-sources", notBuilt);
  // admin: delegation grants
  app.get("/v1/delegation-grants", notBuilt);
  app.get("/v1/delegation-grants/:grantId", notBuilt);
  app.post("/v1/delegation-grants/:grantId/revoke", notBuilt);
  // admin: the issuer's signing keys
  app.get("/v1/identity/signing-keys", notBuilt);
  app.post("/v1/identity/signing-keys/rotate", notBuilt);
  app.post("/v1/identity/signing-keys/:kid/revoke", notBuilt);
}
