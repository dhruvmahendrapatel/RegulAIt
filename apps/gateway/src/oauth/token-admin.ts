/**
 * ADR-0188 decision 7 (slice S5) — RFC 7009 REVOCATION and RFC 7662
 * INTROSPECTION of gateway-issued delegated tokens:
 * `POST /oauth/token/revocation`, `POST /oauth/token/introspection`.
 *
 * WHY NOT THE PROVIDER'S ENDPOINTS: `oidc-provider`'s revocation and
 * introspection look tokens up in ITS token models; our tokens are minted by
 * our grant handler and live in `issued_tokens` (decision 12), which those
 * endpoints cannot see. ADR-0176 §4 exception, narrow and written down: the
 * unmet requirement is "find and judge a token in our own store". The two
 * endpoints still authenticate the client exactly as the token endpoint does:
 * `private_key_jwt` verified with `jose` against the client's LIVE registered
 * keys (`aud` = the token endpoint URL, at most 5 minutes old, `iss` = `sub`
 * = `client_id`), its `jti` claimed atomically in the SAME namespace and key
 * shape the provider uses (`client_assertion`, sha256(iss‖jti)), so an
 * assertion used at one endpoint is refused at the others; or a client
 * certificate through the decision 21 validator. Authentication is REQUIRED.
 *
 * NO LEAKAGE TO OTHER CLIENTS: a client may revoke or introspect only tokens
 * issued TO IT (the token's grant's actor is the authenticated identity).
 * Anyone else's token, an unknown string and a dead token all get the same
 * answer: revocation 200 with no effect, introspection `{active: false}`.
 * Introspection of an active token runs the full decision 13 step 4 check
 * (S3 `storedAndLive`: stored row, binding, signing key lifecycle, live chain);
 * a valid signature alone is never "active".
 */
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify, type JWK, type JWTPayload } from "jose";
import { auditLog, delegationGrants, eq, issuedTokens, sql, type Db } from "@regulait/db";
import { CLIENT_ASSERTION_MAX_AGE_SECONDS, CLIENT_ASSERTION_TYPE_JWT_BEARER, DPOP_PROOF_MAX_FUTURE_SECONDS, OAUTH_INTROSPECTION_PATH, OAUTH_REVOCATION_PATH } from "@regulait/shared";
import { databaseNow } from "../delegation.js";
import { ACCESS_TOKEN_TYP, claimReplay, exactlyOneCnf, issuerKeyFor, jwkOf, storedAndLive } from "../delegated-token.js";
import { ISSUER_JWS_ALG } from "../identity-signing-keys.js";
import { clientJwks, findWorkloadClient, matchCertificateCredential, type WorkloadClient } from "./clients.js";
import { deploymentEnvironment, identityIssuer, tokenEndpointUrl } from "./common.js";
import { presentedClientCertificate } from "./x509.js";

const BODY_LIMIT = 32 * 1024;

type ClientAuth = { ok: true; client: WorkloadClient; credentialId: string } | { ok: false; code: string };

/** authenticate the caller as a workload client (decision 5), claiming its assertion once */
export async function authenticateWorkloadClient(db: Db, req: FastifyRequest, form: URLSearchParams, issuer: string, now: Date): Promise<ClientAuth> {
  const assertion = form.get("client_assertion");
  const nowS = Math.floor(now.getTime() / 1000);
  if (assertion !== null) {
    if (form.getAll("client_assertion").length !== 1 || form.get("client_assertion_type") !== CLIENT_ASSERTION_TYPE_JWT_BEARER) return { ok: false, code: "assertion_malformed" };
    let unverified: JWTPayload;
    let kid: string | undefined;
    try {
      unverified = decodeJwt(assertion);
      kid = decodeProtectedHeader(assertion).kid;
    } catch {
      return { ok: false, code: "assertion_malformed" };
    }
    if (typeof unverified.sub !== "string" || unverified.iss !== unverified.sub) return { ok: false, code: "assertion_claims" };
    if (form.has("client_id") && form.get("client_id") !== unverified.sub) return { ok: false, code: "client_id_mismatch" };
    const client = await findWorkloadClient(db, unverified.sub, now);
    if (!client) return { ok: false, code: "client_unknown" };
    for (const k of clientJwks(client)) {
      if (kid !== undefined && kid !== k.kid) continue;
      let p: JWTPayload;
      try {
        p = (await jwtVerify(assertion, await importJWK(k as JWK, k.alg), { algorithms: [k.alg!], audience: tokenEndpointUrl(issuer), currentDate: now, requiredClaims: ["iat", "exp", "jti"] })).payload;
      } catch {
        continue;
      }
      // `aud` is exactly one string, the token endpoint URL, as at the token endpoint (S5 review item 7): `jose`
      // alone also accepts an array that merely contains it
      if (typeof p.aud !== "string" || p.aud !== tokenEndpointUrl(issuer)) return { ok: false, code: "assertion_claims" };
      if (p.iat! < nowS - CLIENT_ASSERTION_MAX_AGE_SECONDS || p.iat! > nowS + DPOP_PROOF_MAX_FUTURE_SECONDS || p.exp! > p.iat! + CLIENT_ASSERTION_MAX_AGE_SECONDS || typeof p.jti !== "string" || p.jti.length > 256) {
        return { ok: false, code: "assertion_claims" };
      }
      // the provider's own replay key shape, so one assertion is single-use across all three endpoints
      const key = createHash("sha256").update(`${p.iss}${p.jti}`).digest("base64url");
      if (!(await claimReplay(db, "client_assertion", key, new Date((p.exp! + 5) * 1000)))) return { ok: false, code: "assertion_replayed" };
      return { ok: true, client, credentialId: client.credentials.find((c) => c.jwkThumbprint === k.kid)!.id };
    }
    return { ok: false, code: "assertion_invalid" };
  }
  const clientId = form.get("client_id");
  const presented = presentedClientCertificate(req);
  if (!clientId || !presented) return { ok: false, code: "client_authentication_required" };
  const client = await findWorkloadClient(db, clientId, now);
  if (!client) return { ok: false, code: "client_unknown" };
  const m = await matchCertificateCredential(client, presented, now);
  return m.ok ? { ok: true, client, credentialId: m.credentialId } : { ok: false, code: m.code };
}

/** the issued_tokens row and grant actor of a presented token string, if it is one of ours */
async function ownToken(db: Db, token: string): Promise<{ jti: string; actorIdentityId: string; grantId: string } | null> {
  let jti: unknown;
  try {
    jti = decodeJwt(token).jti;
  } catch {
    return null;
  }
  if (typeof jti !== "string" || jti.length === 0 || jti.length > 128) return null;
  const [row] = await db
    .select({ jti: issuedTokens.jti, grantId: issuedTokens.grantId, actorIdentityId: delegationGrants.actorIdentityId })
    .from(issuedTokens)
    .innerJoin(delegationGrants, eq(delegationGrants.id, issuedTokens.grantId))
    .where(eq(issuedTokens.jti, jti));
  return row ?? null;
}

async function audit(db: Db, phase: "token-revocation" | "token-introspection", effect: "allow" | "deny", detail: Record<string, unknown>) {
  await db.insert(auditLog).values({
    userId: "00000000-0000-0000-0000-000000000000",
    objectType: "delegation_grant",
    objectId: null,
    detail: { phase, ...detail },
    effect,
    ruleId: phase,
    ruleChain: [],
    reason: phase === "token-revocation" ? "a workload client asked to revoke a delegated token (RFC 7009)" : "a workload client introspected a delegated token (RFC 7662)",
  });
}

const unauthorized = (reply: FastifyReply) =>
  reply.status(401).header("www-authenticate", 'Bearer error="invalid_client"').send({ error: "invalid_client", error_description: "client authentication failed" });

export function registerTokenAdminEndpoints(app: FastifyInstance, db: Db): void {
  app.register(async (scope) => {
    scope.removeContentTypeParser("application/x-www-form-urlencoded");
    scope.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: BODY_LIMIT }, (_req, body, done) => done(null, body));

    const begin = async (req: FastifyRequest, reply: FastifyReply) => {
      const issuer = identityIssuer();
      if (!issuer) {
        await reply.status(503).send({ error: "temporarily_unavailable" });
        return null;
      }
      if (typeof req.body !== "string") {
        await reply.status(400).send({ error: "invalid_request" });
        return null;
      }
      const form = new URLSearchParams(req.body);
      const token = form.get("token");
      if (!token || form.getAll("token").length !== 1 || token.length > 16_384) {
        await reply.status(400).send({ error: "invalid_request", error_description: "exactly one token is required" });
        return null;
      }
      const now = await databaseNow(db);
      const auth = await authenticateWorkloadClient(db, req, form, issuer, now);
      return { issuer, form, token, now, auth };
    };

    scope.post(OAUTH_REVOCATION_PATH, { bodyLimit: BODY_LIMIT }, async (req, reply) => {
      const b = await begin(req, reply);
      if (!b) return reply;
      if (!b.auth.ok) {
        await audit(db, "token-revocation", "deny", { code: b.auth.code });
        return unauthorized(reply);
      }
      const own = await ownToken(db, b.token);
      if (own && own.actorIdentityId === b.auth.client.identity.id) {
        // the database clock, never before the token's own issue stamp (S3 lifecycle rule)
        await db.execute(sql`update issued_tokens set revoked_at = GREATEST(now(), issued_at) where jti = ${own.jti} and revoked_at is null`);
        await audit(db, "token-revocation", "allow", { tokenJti: own.jti, grantId: own.grantId, clientIdentityId: b.auth.client.identity.id });
      } else {
        await audit(db, "token-revocation", "deny", { code: own ? "not_this_clients_token" : "unknown_token", clientIdentityId: b.auth.client.identity.id });
      }
      // RFC 7009 §2.2: 200 whether or not anything was revoked, so an unknown and a foreign token look the same
      return reply.status(200).header("cache-control", "no-store").send({});
    });

    scope.post(OAUTH_INTROSPECTION_PATH, { bodyLimit: BODY_LIMIT }, async (req, reply) => {
      const b = await begin(req, reply);
      if (!b) return reply;
      if (!b.auth.ok) {
        await audit(db, "token-introspection", "deny", { code: b.auth.code });
        return unauthorized(reply);
      }
      const inactive = async (code: string) => {
        await audit(db, "token-introspection", "deny", { code, clientIdentityId: b.auth.ok ? b.auth.client.identity.id : null });
        return reply.status(200).header("cache-control", "no-store").send({ active: false });
      };
      const own = await ownToken(db, b.token);
      if (!own || own.actorIdentityId !== b.auth.client.identity.id) return inactive(own ? "not_this_clients_token" : "unknown_token");
      let claims: JWTPayload;
      let binding;
      const key = await issuerKeyFor(db, b.token, b.now);
      try {
        binding = exactlyOneCnf(decodeJwt(b.token));
        if (!key || !binding) return inactive("token_invalid");
        claims = (
          await jwtVerify(b.token, await importJWK(jwkOf(key.row) as JWK, ISSUER_JWS_ALG), {
            algorithms: [ISSUER_JWS_ALG],
            typ: ACCESS_TOKEN_TYP,
            issuer: b.issuer,
            currentDate: b.now,
            requiredClaims: ["iss", "sub", "aud", "exp", "iat", "jti", "client_id"],
          })
        ).payload;
      } catch {
        return inactive("token_invalid");
      }
      // one audience, a single string, as the token endpoint mints it (S5 review item 7)
      if (typeof claims.aud !== "string") return inactive("token_invalid");
      const rest = await storedAndLive(db, claims, binding, key.row, { env: deploymentEnvironment() }, b.now);
      if (!rest.ok) return inactive(rest.code);
      await audit(db, "token-introspection", "allow", { tokenJti: own.jti, grantId: own.grantId, clientIdentityId: b.auth.client.identity.id });
      return reply
        .status(200)
        .header("cache-control", "no-store")
        .send({
          active: true,
          iss: claims.iss,
          sub: claims.sub,
          aud: claims.aud,
          client_id: claims.client_id,
          exp: claims.exp,
          iat: claims.iat,
          jti: claims.jti,
          env: claims.env,
          token_type: binding.kind === "dpop" ? "DPoP" : "Bearer",
          cnf: claims.cnf,
          ...(claims.act ? { act: claims.act } : {}),
        });
    });
  });
}
