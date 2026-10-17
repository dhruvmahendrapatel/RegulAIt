/**
 * ADR-0188 (batch 6 item 1) — per-agent and workload identity, and constrained
 * delegation. Slice S1 registered every route the design names here, under its
 * auth class, as a 501 `{error: "not_built"}` stub until its slice landed; S6
 * built the last of them, so no identity route answers 501 any more. The route list, auth classes and request bodies are
 * `IDENTITY_ROUTES` and the zod schemas in `@regulait/shared`
 * (`identity/contract.ts`); `zz-adr0188-s1-foundation.test.ts` pins that this
 * file registers exactly that list.
 *
 * BUILT IN S3: the JWKS document and the issuer signing-key routes (list,
 * rotate, revoke), over `identity-signing-keys.ts`. BUILT IN S5 (`oauth/`):
 * the token endpoint, revocation, introspection, the delegation proof and the
 * delegation-grant admin routes.
 *
 * BUILT IN S4 (`workload-identity-admin.ts`): the identity list and detail, and
 * an identity's own grant set (read, and replace under an `identity_manage`
 * step-up), because S4 switches the agent paths on under the strict default
 * and an admin must be able to grant.
 *
 * Public (no RegulAIt credential; each authenticates IN-ROUTE once built):
 *   GET  /.well-known/jwks.json             the issuer's public keys (S3, built)
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
 *   /v1/identity/signing-keys[...]          issuer key list, rotate, revoke (S3, built; the writes need a
 *                                           `key_management` step-up instead, migration 0203)
 *   /v1/identity/spiffe-trust-bundles[...]  SPIFFE trust bundles: list, upload, revoke (S9, `oauth/spiffe-bundles.ts`)
 *
 * The routes are written out literally (not looped over IDENTITY_ROUTES) so the
 * affordance census (`scripts/preflight-ui-affordances.mjs`) sees the DELETE.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Db } from "@regulait/db";
import {
  IDENTITY_SIGNING_KID_PATTERN,
  revokeIdentitySigningKeySchema,
  rotateIdentitySigningKeySchema,
  type IdentitySigningKeyListView,
} from "@regulait/shared";
import { requireStepUp } from "./step-up.js";
import { registerOAuthRoutes } from "./oauth/index.js";
import {
  IdentitySigningKeyError,
  identitySigningKeyConfiguration,
  jwksDocument,
  listIdentitySigningKeys,
  publishedSigningKeys,
  resolveRotationTarget,
  revokeIdentitySigningKey,
  revokeRefusal,
  rotateIdentitySigningKey,
  signingKeyRevokeStepUp,
  signingKeyRotateStepUp,
} from "./identity-signing-keys.js";
import { workloadIdentityAdminHandlers } from "./workload-identity-admin.js";
import { workloadIdentityS6Handlers } from "./oauth/identity-admin.js";
import { spiffeTrustBundleHandlers } from "./oauth/spiffe-bundles.js";

const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";
const kidParam = z.object({ kid: z.string().regex(IDENTITY_SIGNING_KID_PATTERN) });

/** a signing-key refusal: never key material, only the code and a fixed sentence */
function signingKeyRefusal(reply: FastifyReply, err: unknown) {
  if (!(err instanceof IdentitySigningKeyError)) throw err;
  const status =
    err.code === "signing_key_not_found" || err.code === "signing_key_unknown"
      ? 404
      : err.code === "signing_key_config_invalid" || err.code === "signing_key_unavailable"
        ? 503
        : 409;
  return reply.status(status).send({ error: err.code, detail: err.message });
}

export function registerIdentityRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined } = {}): void {
  const s4 = workloadIdentityAdminHandlers(db);
  const s6 = workloadIdentityS6Handlers(db);
  const s9 = spiffeTrustBundleHandlers(db);
  // public: the issuer's PUBLIC keys (decision 5) — active, and retired ones
  // inside their overlap; never a revoked key. Short cache: a revocation must
  // reach verifiers quickly.
  app.get("/.well-known/jwks.json", async (_req, reply) => {
    const doc = jwksDocument(await publishedSigningKeys(db));
    return reply.header("cache-control", "public, max-age=60").type("application/jwk-set+json").send(JSON.stringify(doc));
  });
  // S5: the token endpoint, revocation, introspection, the delegation proof and the grant admin backend
  registerOAuthRoutes(app, db, { dataKey: opts.dataKey });
  // admin: identities, credentials, an agent's own grants
  app.get("/v1/workload-identities", s4.list);
  app.post("/v1/workload-identities", s6.create);
  app.get("/v1/workload-identities/:identityId", s4.get);
  app.patch("/v1/workload-identities/:identityId", s4.patch);
  app.post("/v1/workload-identities/:identityId/revoke", s6.revoke);
  app.get("/v1/workload-identities/:identityId/credentials", s6.listCredentials);
  app.post("/v1/workload-identities/:identityId/credentials", s6.addCredential);
  app.delete("/v1/workload-identities/:identityId/credentials/:credentialId", s6.revokeCredential);
  app.get("/v1/workload-identities/:identityId/grants", s4.getGrants);
  app.put("/v1/workload-identities/:identityId/grants", s4.putGrants);
  app.get("/v1/workload-identities/:identityId/grant-proposals", s6.grantProposals);
  // admin: what the identity forms may offer (sponsors, subjects, environments, grant targets)
  app.get("/v1/identity/picker-sources", s6.pickerSources);
  // admin (S9): the SPIFFE trust bundles, in audited storage (decisions 10, 12, 21)
  app.get("/v1/identity/spiffe-trust-bundles", s9.list);
  app.post("/v1/identity/spiffe-trust-bundles", s9.set);
  app.post("/v1/identity/spiffe-trust-bundles/:bundleId/revoke", s9.revoke);
  // admin: the issuer's signing keys (public halves only; every write needs a
  // `key_management` step-up bound to the op and the exact key, migration 0203,
  // and is audited inside identity-signing-keys.ts)
  app.get("/v1/identity/signing-keys", async (_req, reply) => {
    // ADR-0188 S7: and where the private halves come from (install-generated, operator-managed, missing)
    const view: IdentitySigningKeyListView = { items: await listIdentitySigningKeys(db), configuration: await identitySigningKeyConfiguration() };
    return reply.send(view);
  });
  app.post("/v1/identity/signing-keys/rotate", async (req, reply) => {
    const body = rotateIdentitySigningKeySchema.parse(req.body ?? {});
    // the key rotated TO is resolved first, so the grant names it (and a refused rotation spends none)
    let target: string;
    try {
      target = await resolveRotationTarget(db, body.kid);
    } catch (err) {
      return signingKeyRefusal(reply, err);
    }
    const su = await requireStepUp(db, req, reply, signingKeyRotateStepUp(target));
    if (!su.ok) return reply;
    try {
      const out = await rotateIdentitySigningKey(db, { kid: target, actorUserId: req.authCtx.userId ?? SYSTEM_USER_ID, stepUp: su.method });
      return reply.status(200).send(out);
    } catch (err) {
      return signingKeyRefusal(reply, err);
    }
  });
  app.post("/v1/identity/signing-keys/:kid/revoke", async (req, reply) => {
    const { kid } = kidParam.parse(req.params);
    revokeIdentitySigningKeySchema.parse(req.body ?? {});
    const pre = await revokeRefusal(db, kid);
    if (pre) return signingKeyRefusal(reply, pre);
    const su = await requireStepUp(db, req, reply, signingKeyRevokeStepUp(kid));
    if (!su.ok) return reply;
    try {
      const out = await revokeIdentitySigningKey(db, { kid, actorUserId: req.authCtx.userId ?? SYSTEM_USER_ID, stepUp: su.method });
      return reply.status(200).send({ kid, ...out });
    } catch (err) {
      return signingKeyRefusal(reply, err);
    }
  });
}
