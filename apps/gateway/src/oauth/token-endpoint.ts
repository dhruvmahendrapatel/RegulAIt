/**
 * ADR-0188 decisions 7, 14, 15, 20, 23 (slice S5) — THE TOKEN ENDPOINT,
 * `POST /oauth/token`: RFC 8693 token exchange on `oidc-provider` 9.12.2.
 *
 * WHAT THE PROVIDER DOES: request parsing and duplicate-parameter refusal,
 * client authentication (`private_key_jwt` against the client's LIVE
 * registered keys; `tls_client_auth` once our decision 21 validator has
 * matched the certificate to a registered credential), the
 * `assertJwtClientAuthClaimsAndHeader` hook, the grant dispatch, and the RFC
 * 6749 error and response shapes. Everything else in it is off: no browser
 * flow, no discovery, no registration, no refresh tokens, no other grant, no
 * provider-issued token, no client `jwks_uri` (decision 20).
 *
 * WHAT IS OURS (R11's two integration rules, kept):
 *  1. THE WHOLE DELEGATION IS CHECKED BEFORE THE FIRST CLAIM. The provider
 *     claims the client assertion `jti` right after the hook, before any grant
 *     handler, so `preflight` runs IN the hook: the request's DPoP proof (our
 *     profile), the target, and the root proof or the parent's decision 23
 *     authorization against this exact child, key and body — all without
 *     claiming anything. A substituted request therefore burns neither the
 *     client assertion nor A's authorization. (An mTLS client sends no
 *     assertion; its preflight runs first thing in the grant handler, before
 *     any claim.) The adapter refuses a client-assertion claim with no
 *     preflight on record, so a provider upgrade that moved the hook fails
 *     closed (and `provider-contract.test.ts` fails the build).
 *  2. OUR DPoP PROFILE: signature by the embedded public key (`jose`), `htm`
 *     POST, `htu` = this endpoint, `iat` within 60 s (at most 5 s ahead) on the
 *     DATABASE clock, and the gateway's 5-minute HMAC nonce (decision 20).
 *     The provider's own nonce helper is not used.
 *
 * REPLAY (decision 14): every claim is one atomic `INSERT … ON CONFLICT DO
 * NOTHING` in `replay_claims` (S3's `claimReplay`), in its own statement,
 * never rolled back by a later failure: the client assertion (via the
 * adapter's `ReplayDetection.upsert`, namespace `client_assertion`), the
 * request's DPoP proof (`checkDpopReplay` → `as_dpop`), then the human proof
 * (`human_delegation_proof`) or A's authorization (`delegation_authz`).
 *
 * THEN: the grant (S3 `createRootGrant` / `admitChildGrant`: refuse over
 * scope, depth, budget or lifetime, never narrow) and the token (S3
 * `mintDelegatedToken`: `cnf` = the CHILD's key, `act` rebuilt from the
 * stored path). Every issue and every refusal writes an audit row of its own
 * (decision 20: the raw request bypasses later Fastify hooks), with codes and
 * ids only — never a token, assertion, proof or certificate.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { calculateJwkThumbprint, decodeJwt, decodeProtectedHeader, EmbeddedJWK, importJWK, jwtVerify, type JWK, type JWTPayload } from "jose";
import Provider, { type AdapterPayload, type KoaContextLike } from "oidc-provider";
import { buildTokenResponse, checkDpopReplay } from "oidc-provider/lib/helpers/grants.js";
import {
  InvalidAuthorizationDetails,
  InvalidClientAuth,
  InvalidDpopProof,
  InvalidGrant,
  InvalidRequest,
  InvalidTarget,
  UseDpopNonce,
  type OIDCProviderError,
} from "oidc-provider/lib/helpers/errors.js";
import { auditLog, delegationGrants, eq, type Db } from "@regulait/db";
import {
  CLIENT_ASSERTION_MAX_AGE_SECONDS,
  DELEGATION_ERROR_CODES,
  DPOP_PROOF_MAX_AGE_SECONDS,
  DPOP_PROOF_MAX_FUTURE_SECONDS,
  delegationBodySchema,
  canonicalDelegationBody,
  TOKEN_EXCHANGE_GRANT_TYPE,
  TOKEN_TYPE_ACCESS_TOKEN,
  TOKEN_TYPE_DELEGATION_AUTHZ,
  TOKEN_TYPE_DELEGATION_PROOF,
  tokenExchangeRequestSchema,
  type DelegationBody,
} from "@regulait/shared";
import { admitChildGrant, createRootGrant, databaseNow, DelegationRefusedError, revokeDelegationGrant } from "../delegation.js";
import {
  checkDelegationAuthorization,
  claimReplay,
  dpopNonceValid,
  issueDpopNonce,
  mintDelegatedToken,
  TokenMintError,
  WORKLOAD_PROOF_ALGS,
  type IdentitySecrets,
} from "../delegated-token.js";
import { loadOrgSettings } from "../org-settings.js";
import { clientJwks, findWorkloadClient, matchCertificateCredential, type CertificateMatch, type WorkloadClient } from "./clients.js";
import { deploymentEnvironment, gatewayResource, identityIssuer, identitySecretsFor, OAUTH_TOKEN_ROUTE_PATH, tokenEndpointUrl } from "./common.js";
import { rootCapFor, verifyDelegationProof, type VerifiedDelegationProof } from "./delegation-proof.js";
import { presentedClientCertificate } from "./x509.js";

/** the form parameters the exchange grant reads (everything else is stripped by the provider) */
export const EXCHANGE_PARAMS = [
  "subject_token",
  "subject_token_type",
  "actor_token",
  "actor_token_type",
  "requested_token_type",
  "resource",
  "authorization_details",
  "project_id",
  "env",
  "cap_micros",
  "max_depth",
  "expires_at",
  "idempotency_key",
] as const;

/** the bound on the raw form body (a subject token, an actor token and a scope list fit well inside) */
export const TOKEN_BODY_LIMIT_BYTES = 96 * 1024;
/** the bound on the provider's work for one request (decision 20); a timed-out request is closed and audited */
export const TOKEN_REQUEST_TIMEOUT_MS = 10_000;
let requestTimeoutMs = TOKEN_REQUEST_TIMEOUT_MS;

/**
 * TEST ONLY (S5 review item 5): the timeout race cannot be reached on purpose
 * from outside, so the tests shorten the timeout and pause the grant
 * transaction just before its timeout re-check. Production code never sets
 * either; `setTokenRequestTimeoutForTest` returns the restore.
 */
export const tokenEndpointTestHooks: { beforeGrantCommit?: () => Promise<void> } = {};
export function setTokenRequestTimeoutForTest(ms: number): () => void {
  const before = requestTimeoutMs;
  requestTimeoutMs = ms;
  return () => {
    requestTimeoutMs = before;
  };
}

// ---------------------------------------------------------------------------
// Per-request state (AsyncLocalStorage: the provider's hooks and adapter read it)
// ---------------------------------------------------------------------------

interface Binding {
  kind: "dpop" | "mtls";
  thumbprint: string;
  dpopJti?: string;
}

interface Preflight {
  client: WorkloadClient;
  authCredentialId: string;
  binding: Binding;
  resource: string;
  root?: { proof: VerifiedDelegationProof };
  child?: { parentGrantId: string; body: DelegationBody; idempotencyKey: string; subjectCredentialId: string | null; claim: { key: string; expiresAt: Date } };
}

interface RequestState {
  db: Db;
  issuer: string;
  secrets: IdentitySecrets;
  now: Date;
  phase: "client_assertion" | "as_dpop";
  /** set by the hook (private_key_jwt) or the handler (mTLS), before any claim */
  preflight?: Preflight;
  /** the credential a verified client assertion was signed with */
  assertionCredentialId?: string;
  /** decision 21: the certificate this request presented, matched to a credential (or why not) */
  mtls?: { clientId: string; match: CertificateMatch } | null;
  /** what to audit */
  outcome?: { grantId: string; parentGrantId: string | null; jti: string; actorIdentityId: string };
  /** S5 review item 5: a grant made for this request that was revoked because the request timed out */
  revokedOnAbort?: string;
  /** S5 review item 5: settles when the grant handler has finished (the audit row waits for it) */
  settled?: Promise<void>;
  code?: string;
  aborted: boolean;
  /** the client the request named (for the audit row) */
  clientId: string | null;
  /** the audit row is written before the response leaves (Koa middleware); the route writes it otherwise */
  audited?: boolean;
}

const als = new AsyncLocalStorage<RequestState>();
const state = (): RequestState => {
  const s = als.getStore();
  if (!s) throw new Error("token endpoint: no request state");
  return s;
};

/** refuse with an RFC error and remember our short code for the audit row (and for the body, when it is public) */
function refuse<E extends OIDCProviderError>(err: E, code: string): E {
  const s = als.getStore();
  if (s) s.code = code;
  return err;
}

// ---------------------------------------------------------------------------
// The adapter: clients from our tables, replay claims atomic, nothing else stored
// ---------------------------------------------------------------------------

function adapterFor(db: Db) {
  return class RegulaitAdapter {
    constructor(readonly model: string) {}
    async find(id: string): Promise<AdapterPayload | undefined> {
      if (this.model === "ReplayDetection") return undefined; // uniqueness is the claim in upsert, never find
      if (this.model !== "Client") return undefined;
      const s = state();
      const client = await findWorkloadClient(db, id, s.now);
      if (!client) return undefined;
      const base = { client_id: id, grant_types: [TOKEN_EXCHANGE_GRANT_TYPE], response_types: [], redirect_uris: [] };
      if (s.mtls && s.mtls.clientId === id) {
        // decision 21: the certificate was validated and matched BEFORE the provider ran; the provider is told the
        // outcome through certificateAuthorized/certificateSubjectMatches. The SAN property only satisfies its schema.
        return { ...base, token_endpoint_auth_method: "tls_client_auth", tls_client_auth_san_uri: id };
      }
      const keys = clientJwks(client);
      if (keys.length === 0) return undefined;
      return { ...base, token_endpoint_auth_method: "private_key_jwt", jwks: { keys } };
    }
    async upsert(id: string, _payload: AdapterPayload, expiresIn: number): Promise<void> {
      if (this.model !== "ReplayDetection") throw new Error(`token endpoint: the provider may not store ${this.model}`);
      const s = state();
      // R11 rule 1, enforced: a client-assertion claim with no completed preflight means the provider's hook order changed
      if (s.phase === "client_assertion" && !s.preflight) throw refuse(new InvalidClientAuth("provider pre-claim hook order changed"), "hook_order");
      const ok = await claimReplay(db, s.phase, id, new Date(s.now.getTime() + Math.max(1, expiresIn) * 1000));
      if (!ok) {
        throw s.phase === "as_dpop" ? refuse(new InvalidDpopProof("DPoP proof replayed"), "dpop_replayed") : refuse(new InvalidClientAuth("client assertion replayed"), "assertion_replayed");
      }
    }
    async findByUserCode(): Promise<undefined> {
      return undefined;
    }
    async findByUid(): Promise<undefined> {
      return undefined;
    }
    async consume(): Promise<void> {
      throw new Error("token endpoint: nothing is consumed through the provider");
    }
    async destroy(): Promise<void> {
      throw new Error("token endpoint: nothing is destroyed through the provider");
    }
    async revokeByGrantId(): Promise<void> {
      throw new Error("token endpoint: nothing is revoked through the provider");
    }
  };
}

// ---------------------------------------------------------------------------
// Preflight: everything, claimed nothing
// ---------------------------------------------------------------------------

const param = (ctx: KoaContextLike, k: string): string | undefined => {
  const v = ctx.oidc.params[k];
  return typeof v === "string" ? v : undefined;
};

/** our DPoP profile for the token endpoint request (decisions 13, 20) */
async function requestDpop(ctx: KoaContextLike, s: RequestState): Promise<{ thumbprint: string; jti: string } | null> {
  const proof = ctx.get("DPoP");
  if (!proof) return null;
  let payload: JWTPayload;
  let jwk: JWK;
  try {
    const h = decodeProtectedHeader(proof);
    if (!h.jwk || typeof h.jwk !== "object" || ["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some((m) => m in (h.jwk as object))) throw new Error("key");
    jwk = h.jwk as JWK;
    payload = (await jwtVerify(proof, EmbeddedJWK, { algorithms: [...WORKLOAD_PROOF_ALGS], typ: "dpop+jwt", currentDate: s.now })).payload;
  } catch {
    throw refuse(new InvalidDpopProof("invalid DPoP proof"), "dpop_invalid");
  }
  const nowS = Math.floor(s.now.getTime() / 1000);
  if (typeof payload.iat !== "number" || payload.iat < nowS - DPOP_PROOF_MAX_AGE_SECONDS || payload.iat > nowS + DPOP_PROOF_MAX_FUTURE_SECONDS) {
    throw refuse(new InvalidDpopProof("DPoP proof is not fresh"), "dpop_stale");
  }
  const org = await loadOrgSettings(s.db);
  if (org.dpopNonceRequired && !dpopNonceValid(payload.nonce, s.secrets.nonceKey, s.now)) {
    ctx.set("DPoP-Nonce", issueDpopNonce(s.secrets.nonceKey, s.now));
    throw refuse(new UseDpopNonce("a current gateway nonce is required"), "dpop_nonce_required");
  }
  let htu: URL | null = null;
  try {
    htu = typeof payload.htu === "string" ? new URL(payload.htu) : null;
  } catch {
    htu = null;
  }
  if (payload.htm !== "POST" || !htu || `${htu.origin}${htu.pathname}` !== tokenEndpointUrl(s.issuer)) {
    throw refuse(new InvalidDpopProof("DPoP proof is for another request"), "dpop_htm_htu");
  }
  if (typeof payload.jti !== "string" || payload.jti.length === 0 || payload.jti.length > 256) throw refuse(new InvalidDpopProof("DPoP proof jti"), "dpop_jti");
  return { thumbprint: await calculateJwkThumbprint(jwk, "sha256"), jti: payload.jti };
}

function mapDelegationRefusal(e: DelegationRefusedError): OIDCProviderError {
  switch (e.ruleId) {
    case "delegation-budget":
      return refuse(new InvalidGrant(e.message), "delegation_budget");
    case "delegation-depth":
      return refuse(new InvalidGrant(e.message), "delegation_depth");
    case "delegation-scope":
    case "actor-allow-list":
    case "lead-ceiling":
      return refuse(new InvalidAuthorizationDetails("the requested scope is not delegable"), e.code);
    case "delegation-request-invalid":
      return refuse(new InvalidRequest("the delegation request is invalid"), e.code);
    default:
      return refuse(new InvalidGrant(e.message), e.code);
  }
}

async function preflight(ctx: KoaContextLike, s: RequestState): Promise<Preflight> {
  const raw: Record<string, string> = { grant_type: TOKEN_EXCHANGE_GRANT_TYPE };
  for (const k of EXCHANGE_PARAMS) {
    const v = param(ctx, k);
    if (v !== undefined) raw[k] = v;
  }
  const parsed = tokenExchangeRequestSchema.safeParse(raw);
  if (!parsed.success) throw refuse(new InvalidRequest("the token exchange request is malformed"), "request_malformed");
  const p = parsed.data;
  const resource = gatewayResource(s.issuer, p.resource);
  if (!resource) throw refuse(new InvalidTarget("the resource is not one of this gateway's protected resources"), "invalid_target");
  let scope: unknown;
  try {
    scope = JSON.parse(p.authorization_details);
  } catch {
    throw refuse(new InvalidAuthorizationDetails("authorization_details is not JSON"), "authorization_details_json");
  }

  const clientId = ctx.oidc.client.clientId;
  const client = await findWorkloadClient(s.db, clientId, s.now);
  if (!client) throw refuse(new InvalidClientAuth("unknown client"), "client_unknown");
  const authCredentialId = s.mtls && s.mtls.clientId === clientId && s.mtls.match.ok ? s.mtls.match.credentialId : s.assertionCredentialId;
  if (!authCredentialId) throw refuse(new InvalidClientAuth("no authenticating credential"), "credential_unknown");

  // the OUTPUT binding: the DPoP key when a proof is sent, else (mTLS clients only) the certificate
  const dpop = await requestDpop(ctx, s);
  let binding: Binding;
  if (dpop) binding = { kind: "dpop", thumbprint: dpop.thumbprint, dpopJti: dpop.jti };
  else if (s.mtls && s.mtls.clientId === clientId && s.mtls.match.ok) binding = { kind: "mtls", thumbprint: s.mtls.match.thumbprint };
  else throw refuse(new InvalidDpopProof("a DPoP proof is required"), "dpop_required");

  const env = deploymentEnvironment();
  if (p.subject_token_type === TOKEN_TYPE_DELEGATION_PROOF) {
    const proof = await verifyDelegationProof(s.db, p.subject_token, s.issuer, s.now);
    if (!proof) throw refuse(new InvalidGrant("the delegation proof is invalid or expired"), "proof_invalid");
    if (proof.agentIdentityId !== client.identity.id) throw refuse(new InvalidGrant("the delegation proof names another agent"), "proof_agent_mismatch");
    if (proof.childCnf !== null && (binding.kind !== "dpop" || proof.childCnf !== binding.thumbprint)) {
      throw refuse(new InvalidGrant("the delegation proof is bound to another key"), "proof_key_mismatch");
    }
    // the request restates exactly the scope and resource the person signed
    let requested: string;
    try {
      requested = canonicalDelegationBody({ ...proof.body, authorization_details: scope as DelegationBody["authorization_details"], resource });
    } catch {
      throw refuse(new InvalidAuthorizationDetails("authorization_details is not a valid scope"), "authorization_details_invalid");
    }
    if (requested !== proof.canonical) throw refuse(new InvalidGrant("the request differs from what the person delegated"), "proof_body_mismatch");
    if (proof.body.env !== env) throw refuse(new InvalidGrant("the delegation proof is for another environment"), "env_mismatch");
    // S5 review item 2, re-read now: the person is still a steward of this agent
    if (!client.identity.sponsorUserIds.includes(proof.sponsorUserId)) throw refuse(new InvalidGrant("the person is not a steward of this agent"), "delegation_not_steward");
    // S5 review item 6 (ADR-0180), judged now against the CURRENT settings: a cap, and a short lifetime
    const org = await loadOrgSettings(s.db);
    if (proof.body.cap_micros === null && !rootCapFor(null, { ...org, delegationRootDefaultCapMicros: 0 }).ok) {
      throw refuse(new InvalidGrant("this organisation does not allow uncapped delegations"), "delegation_cap_required");
    }
    if (proof.body.expires_at - Math.floor(s.now.getTime() / 1000) > org.delegationRootMaxLifetimeSeconds) {
      throw refuse(new InvalidGrant("the delegation lives longer than this organisation allows"), "delegation_lifetime");
    }
    return { client, authCredentialId, binding, resource, root: { proof } };
  }

  // CHILD: A's token and A's authorization of THIS child, key and body (decision 23); claims nothing yet
  if (p.actor_token_type !== TOKEN_TYPE_DELEGATION_AUTHZ || !p.actor_token) throw refuse(new InvalidRequest("a child exchange needs actor_token"), "actor_token_missing");
  if (binding.kind !== "dpop") throw refuse(new InvalidDpopProof("a child token is bound to the child's DPoP key"), "dpop_required");
  const num = (v: string | undefined) => (v !== undefined && v !== "" && [...v].every((c) => c >= "0" && c <= "9") ? Number(v) : NaN);
  const cap = p.cap_micros === "null" ? null : num(p.cap_micros);
  const bodyParsed = delegationBodySchema.safeParse({
    authorization_details: scope,
    resource,
    project_id: p.project_id === "null" ? null : p.project_id,
    env: p.env,
    cap_micros: cap,
    max_depth: num(p.max_depth),
    expires_at: num(p.expires_at),
  });
  if (!bodyParsed.success) throw refuse(new InvalidRequest("the delegation body is malformed"), "delegation_body_invalid");
  const body = bodyParsed.data;
  if (body.env !== env) throw refuse(new InvalidGrant("another environment"), "env_mismatch");
  const authz = await checkDelegationAuthorization(s.db, {
    parentToken: p.subject_token,
    authorization: p.actor_token,
    body,
    idempotencyKey: p.idempotency_key!,
    authenticatedChildIdentityId: client.identity.id,
    requestDpopJkt: binding.thumbprint,
    tokenEndpointUrl: tokenEndpointUrl(s.issuer),
    issuer: s.issuer,
    env,
    secrets: s.secrets,
    now: s.now,
    deferClaim: true,
  });
  if (!authz.ok) {
    if (authz.error === "use_dpop_nonce") {
      if (authz.dpopNonce) ctx.set("DPoP-Nonce", authz.dpopNonce);
      throw refuse(new UseDpopNonce("a current gateway nonce is required"), authz.code);
    }
    throw authz.error === "invalid_request" ? refuse(new InvalidRequest("the delegation request is invalid"), authz.code) : refuse(new InvalidGrant("the parent's authorization does not admit this request"), authz.code);
  }
  // decision 15 open question, answered strictly for v1: a child's single audience is its parent's
  if (authz.parentLive.leaf.audience !== resource) throw refuse(new InvalidTarget("a child's resource is its parent's"), "audience_not_parent");
  // S5 review item 1: refused BEFORE any claim unless the parent's signed depth is enforced (today: never)
  if (!parentDepthEnforced(authz.parentLive.leaf as unknown as Record<string, unknown>)) {
    throw refuse(new InvalidGrant("delegation depth is not enforced for external children yet"), "delegation_depth_unenforced");
  }
  // decision 12: the child's subject credential is the one behind the parent's proof (the parent grant's authenticating credential)
  return {
    client,
    authCredentialId,
    binding,
    resource,
    child: { parentGrantId: authz.parentGrantId, body, idempotencyKey: p.idempotency_key!, subjectCredentialId: authz.parentLive.leaf.authCredentialId, claim: authz.claim! },
  };
}

// ---------------------------------------------------------------------------
// The grant handler
// ---------------------------------------------------------------------------

/**
 * S3 amendment item 1 and the S5 security review item 1 (HIGH): the root
 * exchange signs `max_depth` but `createRootGrant` does not store it, so a
 * person who signed `max_depth: 0` could not stop the agent authorising a
 * child. FAIL CLOSED: an external child exchange is refused unless the parent
 * grant carries an ENFORCED depth limit. Two things must both hold, and today
 * neither does, so every external child exchange is refused:
 *  - the row has S4's `depth_limit` (migration 0184), and
 *  - the root exchange persists the SIGNED `max_depth` into it
 *    (`SIGNED_ROOT_DEPTH_PERSISTED`): S4 alone stores the ORG limit on a root,
 *    which is not what the person signed.
 * TODO(ADR-0188 S4 follow-up): pass min(org limit, signed `max_depth`) to
 * `createRootGrant` as the root's `depth_limit`, enforce `depth_limit` on every
 * admission, then set `SIGNED_ROOT_DEPTH_PERSISTED` and turn the
 * `delegation_depth_unenforced` tests into the reviewer's probe expecting
 * `delegation_depth`.
 */
const SIGNED_ROOT_DEPTH_PERSISTED = false;
export function parentDepthEnforced(parent: Record<string, unknown>): boolean {
  return SIGNED_ROOT_DEPTH_PERSISTED && typeof parent.depthLimit === "number" && Number.isInteger(parent.depthLimit);
}


async function exchange(provider: Provider, ctx: KoaContextLike): Promise<void> {
  const s = state();
  // S5 review item 5: the request's audit row waits until this handler has settled, so it records what happened
  let settle!: () => void;
  s.settled = new Promise<void>((r) => (settle = r));
  try {
    await exchangeSteps(provider, ctx, s);
  } finally {
    settle();
  }
}

async function exchangeSteps(provider: Provider, ctx: KoaContextLike, s: RequestState): Promise<void> {
  if (!s.preflight) s.preflight = await preflight(ctx, s); // mTLS: no assertion, so nothing was claimed before this
  const pf = s.preflight;
  const clientId = ctx.oidc.client.clientId;

  // the claims, each atomic and in its own statement (decision 14), in R11's order
  s.phase = "as_dpop";
  if (pf.binding.kind === "dpop") await checkDpopReplay(provider, ctx, { jti: pf.binding.dpopJti! }, clientId, InvalidDpopProof);
  if (pf.root) {
    const ok = await claimReplay(s.db, "human_delegation_proof", pf.root.proof.jti, new Date(pf.root.proof.exp * 1000 + DPOP_PROOF_MAX_FUTURE_SECONDS * 1000));
    if (!ok) throw refuse(new InvalidGrant("the delegation proof was already used"), "proof_replayed");
  } else {
    const ok = await claimReplay(s.db, "delegation_authz", pf.child!.claim.key, pf.child!.claim.expiresAt);
    if (!ok) throw refuse(new InvalidGrant("the parent's authorization was already used"), "authz_replayed");
  }
  if (s.aborted) throw refuse(new InvalidGrant("request timeout"), "timeout");

  const binding = { kind: pf.binding.kind, thumbprint: pf.binding.thumbprint, authCredentialId: pf.authCredentialId, audience: pf.resource } as const;
  // S5 review item 5: the grant and its token are made in ONE transaction that re-reads the timeout flag before it
  // commits. A request that timed out meanwhile revokes its new grant in that same transaction; one that times out
  // during the commit is revoked straight after. A refusal is never recorded while a live grant exists.
  const issued = await s.db.transaction(
    async (tx): Promise<{ grantId: string; parentGrantId: string | null; minted: Awaited<ReturnType<typeof mintDelegatedToken>> | null }> => {
      const txDb = tx as unknown as Db;
      let grantId: string;
      let parentGrantId: string | null = null;
      try {
        if (pf.root) {
          const b = pf.root.proof.body;
          const g = await createRootGrant(txDb, {
            sponsorUserId: pf.root.proof.sponsorUserId,
            actorIdentityId: pf.client.identity.id,
            scope: b.authorization_details,
            capMicros: b.cap_micros,
            expiresAt: new Date(b.expires_at * 1000),
            environment: b.env,
            projectId: b.project_id,
            binding,
          });
          grantId = g.id;
        } else {
          const c = pf.child!;
          const [parent] = await tx.select().from(delegationGrants).where(eq(delegationGrants.id, c.parentGrantId));
          if (!parent) throw refuse(new InvalidGrant("no parent grant"), "parent_not_found");
          if (!parentDepthEnforced(parent as unknown as Record<string, unknown>)) throw refuse(new InvalidGrant("delegation depth is not enforced for external children yet"), "delegation_depth_unenforced");
          const r = await admitChildGrant(txDb, {
            parentGrantId: c.parentGrantId,
            idempotencyKey: c.idempotencyKey,
            actorIdentityId: pf.client.identity.id,
            scope: c.body.authorization_details,
            capMicros: c.body.cap_micros,
            expiresAt: new Date(c.body.expires_at * 1000),
            maxFurtherDepth: c.body.max_depth,
            environment: c.body.env,
            projectId: c.body.project_id,
            subjectCredentialId: c.subjectCredentialId,
            binding,
          });
          grantId = r.grant.id;
          parentGrantId = c.parentGrantId;
        }
      } catch (e) {
        if (e instanceof DelegationRefusedError) throw mapDelegationRefusal(e);
        throw e;
      }
      let minted;
      try {
        minted = await mintDelegatedToken(txDb, { grantId, issuer: s.issuer, secrets: s.secrets });
      } catch (e) {
        if (e instanceof TokenMintError) throw refuse(new InvalidGrant("the delegation cannot be issued"), e.code);
        throw e;
      }
      await tokenEndpointTestHooks.beforeGrantCommit?.();
      if (s.aborted) {
        // the response is gone and its token was never delivered: the grant is revoked in the transaction that made
        // it, so it commits already ended (its creation and revocation both stay on the record)
        await revokeDelegationGrant(txDb, { grantId, reason: "request_aborted" });
        return { grantId, parentGrantId, minted: null };
      }
      return { grantId, parentGrantId, minted };
    },
  );
  const { grantId, parentGrantId, minted } = issued;
  if (!minted) {
    s.revokedOnAbort = grantId;
    throw refuse(new InvalidGrant("request timeout"), "timeout_grant_revoked");
  }
  if (s.aborted) {
    // the timeout fired while the transaction committed: the grant is live, so end it now and say so
    await revokeDelegationGrant(s.db, { grantId, reason: "request_aborted" });
    s.revokedOnAbort = grantId;
    throw refuse(new InvalidGrant("request timeout"), "timeout_grant_revoked");
  }
  s.outcome = { grantId, parentGrantId, jti: minted.jti, actorIdentityId: pf.client.identity.id };
  ctx.body = buildTokenResponse(provider, {
    accessToken: minted.accessToken,
    tokenType: minted.tokenType,
    issuedTokenType: TOKEN_TYPE_ACCESS_TOKEN,
    expiresIn: minted.expiresIn,
  });
}

// ---------------------------------------------------------------------------
// The provider (one per issuer and database)
// ---------------------------------------------------------------------------

const providers = new WeakMap<Db, Map<string, Provider>>();

export function tokenProviderFor(db: Db, issuer: string): Provider {
  let byIssuer = providers.get(db);
  if (!byIssuer) providers.set(db, (byIssuer = new Map()));
  const existing = byIssuer.get(issuer);
  if (existing) return existing;
  // the provider insists on a keystore for tokens it would sign itself; it signs nothing here (our grant handler
  // mints with the issuer key), so an ephemeral key that never leaves the process satisfies it
  const ephemeral = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const provider = new Provider(issuer, {
    adapter: adapterFor(db),
    clients: [],
    jwks: { keys: [{ ...ephemeral, kid: "ephemeral-unused", alg: "EdDSA", use: "sig" }] },
    cookies: { keys: [randomBytes(32).toString("base64url")] },
    routes: { token: OAUTH_TOKEN_ROUTE_PATH },
    clientAuthMethods: ["private_key_jwt", "tls_client_auth"],
    enabledJWA: { clientAuthSigningAlgValues: [...WORKLOAD_PROOF_ALGS], dPoPSigningAlgValues: [...WORKLOAD_PROOF_ALGS] },
    clockTolerance: 5,
    // the provider validates every client's metadata against its own keystore; it signs no ID token here
    clientDefaults: { id_token_signed_response_alg: "EdDSA", grant_types: [TOKEN_EXCHANGE_GRANT_TYPE], response_types: [] },
    features: {
      devInteractions: { enabled: false },
      dPoP: { enabled: true, requireNonce: () => false },
      introspection: { enabled: false },
      revocation: { enabled: false },
      registration: { enabled: false },
      clientIdMetadataDocument: { enabled: false },
      mTLS: {
        enabled: true,
        tlsClientAuth: true,
        selfSignedTlsClientAuth: false,
        certificateBoundAccessTokens: false,
        getCertificate: () => {
          const s = als.getStore();
          return s?.mtls?.match.ok ? "validated-by-regulait" : undefined;
        },
        certificateAuthorized: (ctx: KoaContextLike) => {
          const s = als.getStore();
          return !!s?.mtls && s.mtls.match.ok && s.mtls.clientId === ctx.oidc.client.clientId;
        },
        certificateSubjectMatches: (ctx: KoaContextLike) => {
          const s = als.getStore();
          return !!s?.mtls && s.mtls.match.ok && s.mtls.clientId === ctx.oidc.client.clientId;
        },
      },
    },
    // R11 rule 1: runs after the assertion's signature is verified, BEFORE the provider claims its jti
    assertJwtClientAuthClaimsAndHeader: async (ctx: KoaContextLike, payload: JWTPayload, header: { kid?: string; alg?: string }) => {
      const s = state();
      const nowS = Math.floor(s.now.getTime() / 1000);
      if (
        typeof payload.iat !== "number" ||
        payload.iat < nowS - CLIENT_ASSERTION_MAX_AGE_SECONDS ||
        payload.iat > nowS + DPOP_PROOF_MAX_FUTURE_SECONDS ||
        typeof payload.exp !== "number" ||
        payload.exp > payload.iat + CLIENT_ASSERTION_MAX_AGE_SECONDS ||
        payload.exp <= nowS ||
        payload.sub !== payload.iss ||
        payload.aud !== tokenEndpointUrl(s.issuer)
      ) {
        throw refuse(new InvalidClientAuth("client assertion claims"), "assertion_claims");
      }
      // decision 12: WHICH registered key signed it (the provider verified one of the client's live keys)
      const client = await findWorkloadClient(s.db, ctx.oidc.client.clientId, s.now);
      const assertion = typeof ctx.oidc.params.client_assertion === "string" ? ctx.oidc.params.client_assertion : "";
      for (const k of client ? clientJwks(client) : []) {
        if (header.kid !== undefined && header.kid !== k.kid) continue;
        try {
          await jwtVerify(assertion, await importJWK(k as JWK, k.alg), { algorithms: [k.alg!], currentDate: s.now });
          s.assertionCredentialId = client!.credentials.find((c) => c.jwkThumbprint === k.kid)!.id;
          break;
        } catch {
          // another key of the same client
        }
      }
      if (!s.assertionCredentialId) throw refuse(new InvalidClientAuth("client assertion key"), "assertion_key");
      s.preflight = await preflight(ctx, s);
    },
  });
  // the Koa app sees only requests the gateway reconstructed; it trusts the forwarded scheme and host WE set
  provider.proxy = true;
  provider.registerGrantType(TOKEN_EXCHANGE_GRANT_TYPE, (ctx) => exchange(provider, ctx), EXCHANGE_PARAMS);
  // expose our public RegulAIt error_code (decision 15) on the refusals that carry one
  // and write the audit row BEFORE the response leaves (decision 20: the provider runs outside Fastify's hooks)
  provider.use(async (ctx, next) => {
    await next();
    const s = als.getStore();
    const body = ctx.body as Record<string, unknown> | undefined;
    if (s?.code && body && typeof body === "object" && typeof body.error === "string" && (DELEGATION_ERROR_CODES as readonly string[]).includes(s.code)) {
      ctx.body = { ...body, error_code: s.code };
    }
    if (s && !s.audited) {
      s.audited = true;
      await auditTokenRequest(db, s, s.aborted ? 499 : ctx.status, s.clientId);
    }
  });
  byIssuer.set(issuer, provider);
  return provider;
}

// ---------------------------------------------------------------------------
// The Fastify mount
// ---------------------------------------------------------------------------

async function auditTokenRequest(db: Db, s: RequestState | null, status: number, clientId: string | null): Promise<void> {
  const ok = status < 400 && !!s?.outcome;
  await db.insert(auditLog).values({
    userId: "00000000-0000-0000-0000-000000000000",
    objectType: "delegation_grant",
    // S5 review item 5: a grant made and then revoked because the request timed out is named, never hidden
    objectId: ok ? s!.outcome!.grantId : (s?.revokedOnAbort ?? null),
    detail: {
      phase: "token-exchange",
      route: `POST ${OAUTH_TOKEN_ROUTE_PATH}`,
      status,
      code: ok ? null : (s?.code ?? (status >= 500 ? "server_error" : "refused")),
      clientId,
      ...(ok ? { grantId: s!.outcome!.grantId, parentGrantId: s!.outcome!.parentGrantId, tokenJti: s!.outcome!.jti, actorIdentityId: s!.outcome!.actorIdentityId } : {}),
      ...(!ok && s?.revokedOnAbort ? { grantId: s.revokedOnAbort, grantRevokedReason: "request_aborted" } : {}),
    },
    effect: ok ? "allow" : "deny",
    ruleId: ok ? "token-exchange-issued" : "token-exchange-refused",
    ruleChain: [],
    reason: ok ? "a delegated access token was issued (ADR-0188 decision 15)" : "a token exchange request was refused (ADR-0188 decision 15)",
  });
}

function clientIdOf(form: URLSearchParams): string | null {
  const direct = form.get("client_id");
  if (direct) return direct.slice(0, 2048);
  const a = form.get("client_assertion");
  if (!a) return null;
  try {
    const sub = decodeJwt(a).sub;
    return typeof sub === "string" ? sub.slice(0, 2048) : null;
  } catch {
    return null;
  }
}

/** register `POST /oauth/token` in an encapsulated scope (its own form parser and body limit) */
export function registerTokenEndpoint(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined }): void {
  app.register(async (scope) => {
    scope.removeContentTypeParser("application/x-www-form-urlencoded");
    scope.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "buffer", bodyLimit: TOKEN_BODY_LIMIT_BYTES }, (_req, body, done) => done(null, body));
    scope.post(OAUTH_TOKEN_ROUTE_PATH, { bodyLimit: TOKEN_BODY_LIMIT_BYTES }, async (req, reply) => tokenRoute(db, opts, req, reply));
  });
}

async function tokenRoute(db: Db, opts: { dataKey?: string | undefined }, req: FastifyRequest, reply: FastifyReply) {
  const issuer = identityIssuer();
  const secrets = identitySecretsFor(opts.dataKey);
  if (!issuer || !secrets) {
    await auditTokenRequest(db, null, 503, null);
    return reply.status(503).send({ error: "temporarily_unavailable", error_description: "the token endpoint is not configured (REGULAIT_PUBLIC_URL and the data key)" });
  }
  if (!Buffer.isBuffer(req.body)) {
    await auditTokenRequest(db, null, 400, null);
    return reply.status(400).send({ error: "invalid_request", error_description: "an application/x-www-form-urlencoded body is required" });
  }
  const form = new URLSearchParams(req.body.toString("utf8"));
  const clientId = clientIdOf(form);
  const now = await databaseNow(db);
  const s: RequestState = { db, issuer, secrets, now, phase: "client_assertion", aborted: false, clientId };

  // decision 21: a client certificate is matched to a registered credential BEFORE the provider sees the request,
  // and only when the client sent no assertion (one mechanism per request)
  const presented = presentedClientCertificate(req);
  if (presented && clientId && !form.has("client_assertion")) {
    const client = await findWorkloadClient(db, clientId, now);
    s.mtls = { clientId, match: client ? await matchCertificateCredential(client, presented, now) : { ok: false, code: "client_unknown" } };
    if (!s.mtls.match.ok) s.code = s.mtls.match.code;
  }

  // hand the bounded, already-parsed body to Koa. Only the headers the provider needs are passed on; the scheme and
  // host are OUR issuer's (provider.proxy = true trusts exactly these two, which we set)
  const issuerUrl = new URL(issuer);
  const basePath = issuerUrl.pathname === "/" ? "" : issuerUrl.pathname;
  const incoming = Readable.from([req.body]) as Readable & Record<string, unknown>;
  const headers: Record<string, string> = {
    host: issuerUrl.host,
    "x-forwarded-proto": issuerUrl.protocol.slice(0, -1),
    "x-forwarded-host": issuerUrl.host,
    "content-type": "application/x-www-form-urlencoded",
    "content-length": String(req.body.length),
    accept: "application/json",
  };
  const dpop = req.headers.dpop;
  if (typeof dpop === "string") headers.dpop = dpop;
  Object.assign(incoming, {
    method: "POST",
    url: OAUTH_TOKEN_ROUTE_PATH,
    originalUrl: `${basePath}${OAUTH_TOKEN_ROUTE_PATH}`,
    headers,
    rawHeaders: Object.entries(headers).flat(),
    socket: req.raw.socket,
    connection: req.raw.socket,
    httpVersion: "1.1",
  });
  const provider = tokenProviderFor(db, issuer);
  reply.hijack();
  const timer = setTimeout(() => {
    s.aborted = true;
    s.code = "timeout";
    reply.raw.destroy();
  }, requestTimeoutMs);
  try {
    await als.run(
      s,
      () =>
        new Promise<void>((resolve) => {
          reply.raw.once("finish", resolve);
          reply.raw.once("close", resolve);
          provider.callback()(incoming as never, reply.raw);
        }),
    );
  } finally {
    clearTimeout(timer);
    // S5 review item 5: a timed-out response closes before the grant handler ends; the audit row records the
    // handler's real outcome (a grant revoked on abort, or none), never a refusal while it may still make a grant
    if (s.settled) await s.settled.catch(() => {});
    if (!s.audited) {
      s.audited = true;
      await auditTokenRequest(db, s, s.aborted ? 499 : reply.raw.statusCode, clientId).catch(() => {});
    }
  }
}
