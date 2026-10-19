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
 *     ADR-0188 S9 follow-up: a JWT-SVID (`jwt-spiffe` assertion type) is
 *     verified and matched before the provider runs, like a certificate, and
 *     the provider is told the outcome; its replay key is claimed first in
 *     the grant handler, after the same preflight.
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
import { auditLog, delegationGrants, engineRunners, eq, type Db, type DelegationGrantRow } from "@regulait/db";
import {
  CLIENT_ASSERTION_MAX_AGE_SECONDS,
  CLIENT_ASSERTION_TYPE_JWT_SPIFFE,
  CLIENT_CREDENTIALS_GRANT_TYPE,
  clientCredentialsRequestSchema,
  CREDENTIAL_NOT_AFTER_RESPONSE_MEMBER,
  CREDENTIAL_ROTATE_AFTER_RESPONSE_MEMBER,
  CREDENTIAL_ROTATE_AT_FRACTION,
  WORKLOAD_SELF_KINDS,
  type WorkloadSelfKind,
  DELEGATION_DEPTH_CEILING,
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
import {
  assertionCredentialOf,
  clientJwks,
  findWorkloadClient,
  matchCertificateCredential,
  matchJwtSvidCredential,
  type CertificateMatch,
  type JwtSvidMatch,
  type WorkloadClient,
} from "./clients.js";
import { deploymentEnvironment, gatewayResource, identityIssuer, identitySecretsFor, OAUTH_TOKEN_ROUTE_PATH, tokenEndpointUrl } from "./common.js";
import { rootCapFor, verifyDelegationProof, type VerifiedDelegationProof } from "./delegation-proof.js";
import { presentedClientCertificate } from "./x509.js";
import { lockSpiffeBundleUnrevoked } from "./spiffe-trust-domains.js";
import { mintWorkloadSelfToken, selfKindForResource } from "./workload-self.js";
import { endpointAgentContext } from "../endpoint-agent.js";

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

/** ADR-0188 S7: the form parameters the self-token grant reads (`client_credentials`) */
export const SELF_TOKEN_PARAMS = ["resource"] as const;

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
export const tokenEndpointTestHooks: { beforeGrantCommit?: () => Promise<void>; afterCertificateMatch?: () => Promise<void> } = {};
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
  /** ADR-0188 S7: a self token (`client_credentials`) for an engine runner or a PDP client */
  self?: { kind: WorkloadSelfKind; credentialNotBefore: Date; credentialNotAfter: Date };
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
  /** X45 I7S5-04: the verified client assertion's `exp` and the request DPoP proof's `iat` (seconds), so a replay
   *  claim never expires before the window its own signed times allow, whatever the process clock says */
  assertionExp?: number;
  dpopIat?: number;
  /** decision 21: the certificate this request presented, matched to a credential (or why not) */
  mtls?: { clientId: string; match: CertificateMatch } | null;
  /**
   * ADR-0188 S9 follow-up: a JWT-SVID client assertion (`jwt-spiffe`), verified and matched to a `spiffe_id`
   * credential BEFORE the provider ran, like a certificate. The provider never sees the assertion: it is told the
   * outcome through the same pre-authenticated path as mTLS. Its replay key is claimed in the grant handler.
   */
  jwtSvid?: { clientId: string; match: JwtSvidMatch } | null;
  /** what to audit */
  outcome?: { grantId: string; parentGrantId: string | null; jti: string; actorIdentityId: string };
  /** ADR-0188 S7: a self token that was issued (audited as such, never as a delegation) */
  selfOutcome?: { identityId: string; kind: WorkloadSelfKind; jti: string; credentialId: string };
  /** the grant type the request named (the audit row says which kind of token was asked for) */
  grantType: string | null;
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

/**
 * The credential that authenticated `clientId` BEFORE the provider ran (decision 21's certificate, or the S9
 * follow-up's JWT-SVID), with the SPIFFE bundle that vouched for it, or null.
 */
function preAuthenticated(s: RequestState, clientId: string): { credentialId: string; spiffeBundleId?: string } | null {
  if (s.mtls && s.mtls.clientId === clientId && s.mtls.match.ok) {
    return { credentialId: s.mtls.match.credentialId, ...(s.mtls.match.spiffeBundleId !== undefined ? { spiffeBundleId: s.mtls.match.spiffeBundleId } : {}) };
  }
  if (s.jwtSvid && s.jwtSvid.clientId === clientId && s.jwtSvid.match.ok) return { credentialId: s.jwtSvid.match.credentialId, spiffeBundleId: s.jwtSvid.match.spiffeBundleId };
  return null;
}
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
      // ADR-0188 S7: an engine runner or a PDP client may also take a self token; a thumbprint-named client may ONLY
      const self = (WORKLOAD_SELF_KINDS as readonly string[]).includes(client.identity.kind);
      const grantTypes = client.alias ? [CLIENT_CREDENTIALS_GRANT_TYPE] : self ? [TOKEN_EXCHANGE_GRANT_TYPE, CLIENT_CREDENTIALS_GRANT_TYPE] : [TOKEN_EXCHANGE_GRANT_TYPE];
      const base = { client_id: id, grant_types: grantTypes, response_types: [], redirect_uris: [] };
      if (preAuthenticated(s, id) !== null && !client.alias) {
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
      // the provider's `expiresIn` is relative to the PROCESS clock (signed exp − process now) and is added here to the
      // DATABASE clock; under skew that ends the claim before the signed window does (X45 I7S5-04). So the claim lives
      // at least until the window the signed times give: the assertion's exp (+ skew allowance), or the DPoP proof's
      // iat + its acceptance age (+ the allowance for a proof from the future)
      const floorMs =
        s.phase === "client_assertion"
          ? s.assertionExp !== undefined
            ? (s.assertionExp + DPOP_PROOF_MAX_FUTURE_SECONDS) * 1000
            : 0
          : s.dpopIat !== undefined
            ? (s.dpopIat + DPOP_PROOF_MAX_AGE_SECONDS + DPOP_PROOF_MAX_FUTURE_SECONDS) * 1000
            : 0;
      const expiresAt = new Date(Math.max(s.now.getTime() + Math.max(1, expiresIn) * 1000, floorMs));
      const ok = await claimReplay(db, s.phase, id, expiresAt);
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
async function requestDpop(ctx: KoaContextLike, s: RequestState): Promise<{ thumbprint: string; jti: string; iat: number } | null> {
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
  return { thumbprint: await calculateJwkThumbprint(jwk, "sha256"), jti: payload.jti, iat: payload.iat };
}

/** exported for the ADR-0190 I2 suite (amendment item 11: the token-endpoint shape of `delegation-isolation`) */
export function mapDelegationRefusal(e: DelegationRefusedError): OIDCProviderError {
  switch (e.ruleId) {
    case "delegation-budget":
      return refuse(new InvalidGrant(e.message), "delegation_budget");
    case "delegation-depth":
      return refuse(new InvalidGrant(e.message), "delegation_depth");
    // ADR-0190 decision 8 with amendment item 11: decision 15's pattern, `invalid_grant` with `error_code`
    case "delegation-isolation":
      return refuse(new InvalidGrant(e.message), "delegation_isolation");
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

/**
 * ADR-0188 S7 — the SELF-TOKEN preflight (`client_credentials`), run in the
 * assertion hook before the provider claims anything: the request's DPoP proof
 * (our profile; a self token is ALWAYS DPoP-bound), the one control-plane
 * resource for the client's kind, a live identity of that kind in this
 * environment, and, for a runner, a runner that is not revoked.
 */
async function selfPreflight(ctx: KoaContextLike, s: RequestState): Promise<Preflight> {
  const raw: Record<string, string> = {};
  for (const k of ["grant_type", "resource", "client_assertion_type", "client_assertion", "client_id"]) {
    const v = param(ctx, k);
    if (v !== undefined) raw[k] = v;
  }
  const parsed = clientCredentialsRequestSchema.safeParse(raw);
  if (!parsed.success) throw refuse(new InvalidRequest("the self-token request is malformed"), "request_malformed");
  const clientId = ctx.oidc.client.clientId;
  const client = await findWorkloadClient(s.db, clientId, s.now);
  if (!client) throw refuse(new InvalidClientAuth("unknown client"), "client_unknown");
  const kind = client.identity.kind as WorkloadSelfKind;
  if (!(WORKLOAD_SELF_KINDS as readonly string[]).includes(kind)) throw refuse(new InvalidClientAuth("this client may not take a self token"), "self_token_kind");
  if (selfKindForResource(s.issuer, parsed.data.resource) !== kind) throw refuse(new InvalidTarget("a self token names its own control-plane resource"), "invalid_target");
  if (!client.identity.environments.includes(deploymentEnvironment())) throw refuse(new InvalidClientAuth("this identity is not allowed in this environment"), "identity_environment");
  const authCredentialId = s.assertionCredentialId;
  const credential = client.credentials.find((c) => c.id === authCredentialId);
  if (!authCredentialId || !credential) throw refuse(new InvalidClientAuth("no authenticating credential"), "credential_unknown");
  if (kind === "engine_runner") {
    const [runner] = client.identity.engineRunnerId
      ? await s.db.select({ revokedAt: engineRunners.revokedAt }).from(engineRunners).where(eq(engineRunners.id, client.identity.engineRunnerId))
      : [];
    if (!runner) throw refuse(new InvalidClientAuth("no such engine runner"), "engine_runner_unknown");
    if (runner.revokedAt !== null) throw refuse(new InvalidClientAuth("this engine runner was revoked"), "engine_runner_revoked");
  }
  // ADR-0195 SD4b: an endpoint agent's device must exist and not be revoked
  if (kind === "endpoint_agent" && !(await endpointAgentContext(s.db, client.identity.id)).ok) {
    throw refuse(new InvalidClientAuth("this device was revoked"), "device_revoked");
  }
  const dpop = await requestDpop(ctx, s);
  if (!dpop) throw refuse(new InvalidDpopProof("a DPoP proof is required"), "dpop_required");
  // a self token is bound to the SAME key that authenticated the client: a workload cannot bind its token to some
  // other key it holds (or a key that is not registered at all)
  if (!credential.jwkThumbprint || dpop.thumbprint !== credential.jwkThumbprint) {
    throw refuse(new InvalidDpopProof("the DPoP proof must be signed by the key that authenticated the client"), "dpop_key_mismatch");
  }
  s.dpopIat = dpop.iat;
  return {
    client,
    authCredentialId,
    binding: { kind: "dpop", thumbprint: dpop.thumbprint, dpopJti: dpop.jti },
    resource: parsed.data.resource,
    self: { kind, credentialNotBefore: credential.notBefore, credentialNotAfter: credential.notAfter },
  };
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
  // a JWT-SVID is a bearer credential: no certificate binding is possible, so the DPoP check below is required of it
  const authCredentialId = preAuthenticated(s, clientId)?.credentialId ?? s.assertionCredentialId;
  if (!authCredentialId) throw refuse(new InvalidClientAuth("no authenticating credential"), "credential_unknown");

  // the OUTPUT binding: the DPoP key when a proof is sent, else (mTLS clients only) the certificate
  const dpop = await requestDpop(ctx, s);
  let binding: Binding;
  if (dpop) {
    binding = { kind: "dpop", thumbprint: dpop.thumbprint, dpopJti: dpop.jti };
    s.dpopIat = dpop.iat;
  }
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
  // S5 review item 1 and PR #339 review item 3: refused BEFORE any claim unless the chain's root stored the
  // person's SIGNED depth (links are root first)
  if (!rootDepthSigned(authz.parentLive.links[0]?.grant, authz.parentLive.leaf)) {
    throw refuse(new InvalidGrant("delegation depth is not enforced for this parent"), "delegation_depth_unenforced");
  }
  // the parent's stored limit, judged BEFORE any claim (admitChildGrant judges it again under the parent's lock)
  const parentLeaf = authz.parentLive.leaf;
  if (parentLeaf.depth + 1 > parentLeaf.depthLimit) {
    throw refuse(new InvalidGrant("the parent grant may not delegate further"), "delegation_depth");
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
 * S3 amendment item 1 and the S5 security review item 1 (HIGH), closed by the
 * S4+S5 follow-up. The root exchange persists min(org limit, the person's
 * SIGNED `max_depth`) as the root grant's `depth_limit` (migration 0184) and
 * marks the root `depth_limit_signed` (migration 0190); every child admission
 * (`admitChildGrant`) and every use (`loadLiveChain`, `actorForGrant`) enforces
 * the stored limit. A root minted before that stored the org's limit instead,
 * and nothing else in its row tells the two apart, so an external child
 * exchange is refused `delegation_depth_unenforced` unless the chain's root
 * carries the marker (no grandfathering, ADR-0180), and refused
 * `delegation_depth`, before any replay claim, when the parent may delegate
 * no further.
 */
export function rootDepthSigned(
  root: Pick<DelegationGrantRow, "id" | "depth" | "depthLimitSigned"> | undefined,
  parent: Pick<DelegationGrantRow, "rootGrantId" | "depthLimit">,
): boolean {
  return root !== undefined && root.id === parent.rootGrantId && root.depth === 0 && root.depthLimitSigned === true && Number.isInteger(parent.depthLimit);
}

/** the root's stored `depth_limit`: the person's signed `max_depth`, never more than the org's limit now */
export function rootDepthLimit(signedMaxDepth: number, orgMaxDepth: number): number {
  return Math.max(0, Math.min(signedMaxDepth, orgMaxDepth, DELEGATION_DEPTH_CEILING));
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

  // ADR-0188 S9 follow-up: the JWT-SVID is single-use (decision 5), claimed first, as the provider claims an
  // assertion's jti, now that the whole request has been checked (R11 rule 1)
  const svid = s.jwtSvid && s.jwtSvid.clientId === clientId && s.jwtSvid.match.ok ? s.jwtSvid.match : null;
  if (svid) {
    const ok = await claimReplay(s.db, "client_assertion", svid.replayKey, new Date((svid.exp + DPOP_PROOF_MAX_FUTURE_SECONDS) * 1000));
    if (!ok) throw refuse(new InvalidClientAuth("client assertion replayed"), "assertion_replayed");
  }

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
      // ADR-0188 S9 (#389 review M1, recheck Low 3): a client authenticated by an X.509-SVID holds EVERY bundle row of
      // its trust domain FOR SHARE for the whole issue (`lockSpiffeBundleUnrevoked`), so no revocation or rotation can
      // interleave, and refuses when its bundle was revoked or a rotation away from it ended in a revocation
      const pre = preAuthenticated(s, clientId);
      const spiffeBundleId = pre && pf.authCredentialId === pre.credentialId ? pre.spiffeBundleId : undefined;
      if (spiffeBundleId !== undefined && !(await lockSpiffeBundleUnrevoked(txDb, spiffeBundleId))) {
        throw refuse(new InvalidClientAuth("the SPIFFE trust bundle that authenticated this client was revoked, or a rotation away from it ended in a revocation"), "spiffe_bundle_revoked");
      }
      try {
        if (pf.root) {
          const b = pf.root.proof.body;
          // S5 review item 1: the SIGNED depth is stored on the root, narrowed to the org's limit at this moment
          const org = await loadOrgSettings(txDb);
          const g = await createRootGrant(txDb, {
            maxFurtherDepth: rootDepthLimit(b.max_depth, org.delegationMaxDepth),
            depthLimitSigned: true,
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
          // re-read in this transaction: the chain's root must carry the signed-depth marker (migration 0190)
          const [root] = await tx.select().from(delegationGrants).where(eq(delegationGrants.id, parent.rootGrantId));
          if (!rootDepthSigned(root, parent)) throw refuse(new InvalidGrant("delegation depth is not enforced for this parent"), "delegation_depth_unenforced");
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

/**
 * ADR-0188 S7 — THE SELF-TOKEN GRANT (`client_credentials`): `private_key_jwt`
 * only (the preflight ran in the assertion hook, before the assertion's claim),
 * then the request's DPoP proof is claimed and the token minted, bound to the
 * DPoP key. No grant, no sponsor: the token reaches its own control-plane route
 * and nothing else (`workload-self.ts`).
 */
async function selfToken(provider: Provider, ctx: KoaContextLike): Promise<void> {
  const s = state();
  const pf = s.preflight;
  // an mTLS client sends no assertion, so no preflight exists: S7 issues self tokens to private_key_jwt clients only
  if (!pf?.self) throw refuse(new InvalidClientAuth("a self token needs private_key_jwt client authentication"), "self_token_auth_method");
  s.phase = "as_dpop";
  await checkDpopReplay(provider, ctx, { jti: pf.binding.dpopJti! }, ctx.oidc.client.clientId, InvalidDpopProof);
  if (s.aborted) throw refuse(new InvalidGrant("request timeout"), "timeout");
  const minted = await mintWorkloadSelfToken(s.db, {
    identityId: pf.client.identity.id,
    identifier: pf.client.identity.identifier,
    kind: pf.self.kind,
    authCredentialId: pf.authCredentialId,
    jkt: pf.binding.thumbprint,
    issuer: s.issuer,
    env: deploymentEnvironment(),
  });
  s.selfOutcome = { identityId: pf.client.identity.id, kind: pf.self.kind, jti: minted.jti, credentialId: pf.authCredentialId };
  ctx.body = {
    ...buildTokenResponse(provider, { accessToken: minted.accessToken, tokenType: minted.tokenType, expiresIn: minted.expiresIn }),
    // RFC 6749 §5.1 allows extra members: when the key that authenticated this stops being accepted, and from when
    // its holder should rotate it (two thirds into its window; decision 12)
    [CREDENTIAL_NOT_AFTER_RESPONSE_MEMBER]: Math.floor(pf.self.credentialNotAfter.getTime() / 1000),
    [CREDENTIAL_ROTATE_AFTER_RESPONSE_MEMBER]: Math.floor(
      (pf.self.credentialNotBefore.getTime() + (pf.self.credentialNotAfter.getTime() - pf.self.credentialNotBefore.getTime()) * CREDENTIAL_ROTATE_AT_FRACTION) / 1000,
    ),
  };
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
    // ADR-0188 S7: EdDSA and Ed25519 (RFC 9864) for an Ed25519 key, ES256 for P-256. There is no discovery
    // document; the one signing-alg list the gateway publishes is the RFC 9728 dpop_signing_alg_values_supported
    // (mcp-auth-metadata.ts), which names the same three
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
        // decision 21 and the S9 follow-up: a certificate or a JWT-SVID was validated and matched BEFORE the provider
        // ran; the provider's tls_client_auth path is only told the outcome
        getCertificate: () => {
          const s = als.getStore();
          return s?.mtls?.match.ok || s?.jwtSvid?.match.ok ? "validated-by-regulait" : undefined;
        },
        certificateAuthorized: (ctx: KoaContextLike) => {
          const s = als.getStore();
          return !!s && preAuthenticated(s, ctx.oidc.client.clientId) !== null;
        },
        certificateSubjectMatches: (ctx: KoaContextLike) => {
          const s = als.getStore();
          return !!s && preAuthenticated(s, ctx.oidc.client.clientId) !== null;
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
      s.assertionExp = payload.exp;
      // decision 12: WHICH registered key signed it (the provider verified one of the client's live keys)
      const client = await findWorkloadClient(s.db, ctx.oidc.client.clientId, s.now);
      const assertion = typeof ctx.oidc.params.client_assertion === "string" ? ctx.oidc.params.client_assertion : "";
      const signedBy = client ? await assertionCredentialOf(client, assertion, header, s.now) : null;
      if (signedBy) s.assertionCredentialId = signedBy;
      if (!s.assertionCredentialId) throw refuse(new InvalidClientAuth("client assertion key"), "assertion_key");
      s.preflight = ctx.oidc.params.grant_type === CLIENT_CREDENTIALS_GRANT_TYPE ? await selfPreflight(ctx, s) : await preflight(ctx, s);
    },
  });
  // the Koa app sees only requests the gateway reconstructed; it trusts the forwarded scheme and host WE set
  provider.proxy = true;
  provider.registerGrantType(TOKEN_EXCHANGE_GRANT_TYPE, (ctx) => exchange(provider, ctx), EXCHANGE_PARAMS);
  // ADR-0188 S7: the workload self token (engine runners and PDP clients); the provider's own client_credentials is off
  provider.registerGrantType(CLIENT_CREDENTIALS_GRANT_TYPE, (ctx) => selfToken(provider, ctx), SELF_TOKEN_PARAMS);
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
  // ADR-0188 S7: a self-token request is audited as itself, against the identity, never as a delegation
  if (s?.grantType === CLIENT_CREDENTIALS_GRANT_TYPE) {
    const issued = status < 400 && !!s.selfOutcome;
    await db.insert(auditLog).values({
      userId: "00000000-0000-0000-0000-000000000000",
      objectType: "workload_identity",
      objectId: s.selfOutcome?.identityId ?? s.preflight?.client.identity.id ?? null,
      detail: {
        phase: "client-credentials",
        route: `POST ${OAUTH_TOKEN_ROUTE_PATH}`,
        status,
        code: issued ? null : (s.code ?? (status >= 500 ? "server_error" : "refused")),
        clientId,
        ...(issued ? { kind: s.selfOutcome!.kind, tokenJti: s.selfOutcome!.jti, credentialId: s.selfOutcome!.credentialId } : {}),
      },
      effect: issued ? "allow" : "deny",
      ruleId: issued ? "workload-token-issued" : "workload-token-refused",
      ruleChain: [],
      reason: issued
        ? "a workload self token was issued to an engine runner or a PDP client (ADR-0188 S7)"
        : "a workload self-token request was refused (ADR-0188 S7)",
    });
    return;
  }
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
      ...(s?.jwtSvid ? { clientAuth: "spiffe_jwt_svid" } : {}),
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
  const grantTypes = form.getAll("grant_type");
  const s: RequestState = { db, issuer, secrets, now, phase: "client_assertion", aborted: false, clientId, grantType: grantTypes.length === 1 ? grantTypes[0]!.slice(0, 200) : null };

  // decision 21: a client certificate is matched to a registered credential BEFORE the provider sees the request,
  // and only when the client sent no assertion (one mechanism per request)
  const presented = presentedClientCertificate(req);
  if (presented && clientId && !form.has("client_assertion")) {
    const client = await findWorkloadClient(db, clientId, now);
    s.mtls = { clientId, match: client ? await matchCertificateCredential(db, client, presented, now) : { ok: false, code: "client_unknown" } };
    if (!s.mtls.match.ok) s.code = s.mtls.match.code;
    // test only: a rotation and a revocation landing between the certificate match and the issuing transaction
    await tokenEndpointTestHooks.afterCertificateMatch?.();
  }

  // ADR-0188 S9 follow-up: a JWT-SVID client assertion (draft-ietf-oauth-spiffe-client-auth §3.1) is verified and
  // matched here, then taken OUT of the form: the provider knows no `jwt-spiffe` assertion type, and is told the
  // outcome through the pre-authenticated path instead. One assertion, one type, or nothing authenticates.
  let body: Buffer = req.body;
  const assertionTypes = form.getAll("client_assertion_type");
  if (assertionTypes.includes(CLIENT_ASSERTION_TYPE_JWT_SPIFFE)) {
    const assertions = form.getAll("client_assertion");
    const svidClientId = clientId ?? "";
    let match: JwtSvidMatch;
    if (assertionTypes.length !== 1 || assertions.length !== 1 || !clientId) match = { ok: false, code: "request_malformed" };
    else {
      const client = await findWorkloadClient(db, clientId, now);
      match = client ? await matchJwtSvidCredential(db, client, assertions[0]!, issuer, now) : { ok: false, code: "client_unknown" };
    }
    s.jwtSvid = { clientId: svidClientId, match };
    if (!match.ok) s.code = match.code;
    form.delete("client_assertion");
    form.delete("client_assertion_type");
    form.set("client_id", svidClientId);
    body = Buffer.from(form.toString(), "utf8");
    await tokenEndpointTestHooks.afterCertificateMatch?.();
  }

  // hand the bounded, already-parsed body to Koa. Only the headers the provider needs are passed on; the scheme and
  // host are OUR issuer's (provider.proxy = true trusts exactly these two, which we set)
  const issuerUrl = new URL(issuer);
  const basePath = issuerUrl.pathname === "/" ? "" : issuerUrl.pathname;
  const incoming = Readable.from([body]) as Readable & Record<string, unknown>;
  const headers: Record<string, string> = {
    host: issuerUrl.host,
    "x-forwarded-proto": issuerUrl.protocol.slice(0, -1),
    "x-forwarded-host": issuerUrl.host,
    "content-type": "application/x-www-form-urlencoded",
    "content-length": String(body.length),
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
