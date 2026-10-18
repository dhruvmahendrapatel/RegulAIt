/**
 * ADR-0195 SD2b — the cloud federation issuer's routes (logic in `federation-signing-keys.ts`).
 *
 * Public (the clouds fetch them to verify a token; public keys and metadata only, nothing secret):
 *   GET  /federation/.well-known/openid-configuration   OIDC discovery for the issuer `<public URL>/federation`
 *   GET  /federation/.well-known/jwks.json              the RS256 public keys (active, and retired inside the overlap)
 * Admin (admin-only by default; none is in NON_ADMIN_ROUTES; every write audited):
 *   GET  /v1/discovery/federation                       status, issuer, keys (public halves only), trust values
 *   POST /v1/discovery/federation/keys                  generate a pending key (free: it turns nothing on)
 *   POST /v1/discovery/federation/keys/:kid/activate    turn federation on (`settings_relax`) or rotate (`key_management`)
 *   POST /v1/discovery/federation/keys/:kid/revoke      compromise (`key_management`, bound to the key)
 *   POST /v1/discovery/federation/disable               turn federation off (free, a tightening)
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Db } from "@regulait/db";
import { FEDERATION_DISCOVERY_PATH, FEDERATION_JWKS_PATH } from "@regulait/shared";
import { CHANGED_CONCURRENTLY, requireStepUp } from "./step-up.js";
import {
  activateFederationKey,
  activationStepUp,
  disableFederation,
  FederationError,
  federationDiscoveryDocument,
  federationErrorStatus,
  federationIssuer,
  federationJwks,
  federationStatus,
  generateFederationKey,
  publishedFederationKeys,
  revocationStepUp,
  revokeFederationKey,
} from "./federation-signing-keys.js";

const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";
const kidParam = z.object({ kid: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/) });
const emptyBody = z.object({}).strict();

function refusal(reply: FastifyReply, err: unknown) {
  if (!(err instanceof FederationError)) throw err;
  if (err.code === "changed_concurrently") return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
  return reply.status(federationErrorStatus(err.code)).send({ error: err.code, detail: err.message });
}

export function registerFederationRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined } = {}): void {
  // public: short cache, so a revocation reaches the clouds quickly
  app.get(FEDERATION_DISCOVERY_PATH, async (_req, reply) => {
    const issuer = federationIssuer();
    if (!issuer) return reply.status(404).send({ error: "federation_issuer_unset", detail: "the federation issuer needs REGULAIT_PUBLIC_URL" });
    return reply.header("cache-control", "public, max-age=300").type("application/json").send(JSON.stringify(federationDiscoveryDocument(issuer)));
  });
  app.get(FEDERATION_JWKS_PATH, async (_req, reply) => {
    const doc = federationJwks(await publishedFederationKeys(db));
    return reply.header("cache-control", "public, max-age=60").type("application/jwk-set+json").send(JSON.stringify(doc));
  });

  app.get("/v1/discovery/federation", async () => federationStatus(db));

  app.post("/v1/discovery/federation/keys", async (req, reply) => {
    emptyBody.parse(req.body ?? {});
    try {
      const key = await generateFederationKey(db, { dataKey: opts.dataKey, actorUserId: req.authCtx.userId ?? SYSTEM_USER_ID });
      return reply.status(201).send(key);
    } catch (err) {
      return refusal(reply, err);
    }
  });

  app.post("/v1/discovery/federation/keys/:kid/activate", async (req, reply) => {
    const { kid } = kidParam.parse(req.params);
    emptyBody.parse(req.body ?? {});
    // decided unlocked first, so a refused activation spends no grant; re-checked under the lock
    let decision;
    try {
      decision = await activationStepUp(db, kid);
    } catch (err) {
      return refusal(reply, err);
    }
    const su = await requireStepUp(db, req, reply, decision.args);
    if (!su.ok) return reply;
    try {
      const out = await activateFederationKey(db, {
        kid,
        expectPreviousKid: decision.previousKid,
        actorUserId: req.authCtx.userId ?? SYSTEM_USER_ID,
        stepUp: su.method,
        stepUpKind: decision.args.kind,
      });
      return reply.send(out);
    } catch (err) {
      return refusal(reply, err);
    }
  });

  app.post("/v1/discovery/federation/keys/:kid/revoke", async (req, reply) => {
    const { kid } = kidParam.parse(req.params);
    emptyBody.parse(req.body ?? {});
    let args;
    try {
      args = await revocationStepUp(db, kid);
    } catch (err) {
      return refusal(reply, err);
    }
    const su = await requireStepUp(db, req, reply, args);
    if (!su.ok) return reply;
    try {
      return reply.send(await revokeFederationKey(db, { kid, actorUserId: req.authCtx.userId ?? SYSTEM_USER_ID, stepUp: su.method }));
    } catch (err) {
      return refusal(reply, err);
    }
  });

  app.post("/v1/discovery/federation/disable", async (req, reply) => {
    emptyBody.parse(req.body ?? {});
    try {
      return reply.send(await disableFederation(db, { actorUserId: req.authCtx.userId ?? SYSTEM_USER_ID }));
    } catch (err) {
      return refusal(reply, err);
    }
  });
}
