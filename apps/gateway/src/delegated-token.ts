/**
 * ADR-0188 (batch 6 item 1) slice S3 — DELEGATED ACCESS TOKENS: mint, the
 * decision 13 resource-side verifier, the decision 14 replay claim, the
 * decision 20 DPoP nonce, and the decision 23 parent-authorization check.
 *
 * MINT (decision 5). An RFC 9068 JWT (`typ` `at+jwt`), EdDSA under the
 * issuer's current key (`identity-signing-keys.ts`), for an EXTERNAL grant
 * only (`in_process` grants mint nothing, decision 6), always sender-bound:
 * `cnf.jkt` (DPoP) or `cnf.x5t#S256` (mTLS). A token with no `cnf` is never
 * issued. Claims: `iss`, `sub` (the sponsor, PAIRWISE per audience, never an
 * email), `client_id` (the actor's identifier), `act` (rebuilt from the
 * STORED path, outermost = the current actor; decisions 15, 25), `aud` (the
 * grant's one audience), `grant_id`, `env`, `jti`, `iat`, `exp`. Lifetime =
 * `delegated_token_ttl_seconds`, never past the grant. One `issued_tokens`
 * row per token (decision 12) records its binding and signing key.
 *
 * VERIFY (decision 13), each step failing closed with 401:
 *  1. exactly one `cnf` member, `jkt` or `x5t#S256`;
 *  2. DPoP branch: `oauth4webapi.validateJwtAccessToken` with `requireDPoP`,
 *     a fixed algorithm list and ONLY our local issuer keys (no metadata, no
 *     JWKS URL is ever fetched); then OUR checks: proof `iat` within 60 s (at
 *     most 5 s ahead), the gateway nonce, and an atomic `rs_dpop` claim of the
 *     proof `jti`;
 *  3. mTLS branch: `jose.jwtVerify` for the signature only (same rules), then
 *     the client certificate (already path-validated by the transport,
 *     decision 21: S5/S9) must hash to `x5t#S256`; no DPoP fallback;
 *  4. `env`, `aud`, the `issued_tokens` row and its stored binding, the
 *     signing key's lifecycle (rotation overlap, revocation), and the
 *     decision 17 live chain. A valid signature never short-cuts any of these.
 *
 * Open source first (ADR-0176): `jose` 6.2.12 and `oauth4webapi` 3.8.8 do all
 * of the cryptography and JWT/DPoP protocol checks; `canonicalize` (shared)
 * the RFC 8785 body. What is ours is exactly what decision 13 says the
 * libraries do not do: the freshness window, nonce, replay claim, the
 * stored-binding and live-chain checks, and the mTLS branch.
 */
import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import {
  calculateJwkThumbprint,
  decodeJwt,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  SignJWT,
  type JWK,
  type JWTPayload,
} from "jose";
import * as oauth from "oauth4webapi";
import { and, eq, isNotNull, issuedTokens, lte, or, replayClaims, workloadCredentials, type Db, type IdentitySigningKeyRow } from "@regulait/db";
import {
  actClaimFromChain,
  canonicalDelegationBody,
  constantTimeEqual,
  DELEGATION_AUTHZ_TYP,
  DPOP_PROOF_MAX_AGE_SECONDS,
  DPOP_PROOF_MAX_FUTURE_SECONDS,
  type DelegationBody,
  type ReplayNamespace,
} from "@regulait/shared";
import { loadLiveChain, type LiveChain } from "./delegation.js";
import { currentIssuerSigner, ISSUER_JWS_ALG, publishedSigningKeys, signingKeyAccepts } from "./identity-signing-keys.js";
import { loadOrgSettings } from "./org-settings.js";

/** the JOSE `typ` of a delegated access token (RFC 9068) */
export const ACCESS_TOKEN_TYP = "at+jwt" as const;
/** the algorithms a DPoP proof or a delegation authorization may use (decision 13) */
export const WORKLOAD_PROOF_ALGS = ["EdDSA", "ES256"] as const;
/** a DPoP nonce is an HMAC over a 5-minute slot (decision 20) */
export const DPOP_NONCE_SLOT_SECONDS = 300;
/** a placeholder jwks_uri handed to oauth4webapi; `customFetch` answers it locally and nothing else */
const LOCAL_JWKS_URI = "https://issuer-keys.invalid/jwks";

// ---------------------------------------------------------------------------
// Deploy-time secrets (decision 20): shared by every replica, never stored
// ---------------------------------------------------------------------------

export interface IdentitySecrets {
  /** HMAC key of the DPoP nonce (decision 20) */
  nonceKey: Buffer;
  /** HMAC key of the pairwise `sub` (decision 5) */
  pairwiseKey: Buffer;
}

/**
 * Derive the identity HMAC keys from the gateway's existing deploy-time data
 * key with HKDF-SHA-256 (RFC 5869, Node's own implementation), one `info`
 * label per use, so no new secret has to be distributed to replicas and the
 * two keys are independent of each other and of the data key's other uses.
 */
export function deriveIdentitySecrets(dataKey: string): IdentitySecrets {
  if (typeof dataKey !== "string" || dataKey.length < 32) throw new Error("deriveIdentitySecrets: the data key is missing or too short");
  const ikm = Buffer.from(dataKey, "utf8");
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), info, 32));
  return { nonceKey: derive("regulait/adr0188/dpop-nonce/v1"), pairwiseKey: derive("regulait/adr0188/pairwise-sub/v1") };
}

const b64urlSha256 = (v: string | Uint8Array) => createHash("sha256").update(v).digest("base64url");

/** the pairwise subject of a sponsor for one audience (decision 5): stable per (audience, person), unlinkable across audiences */
export function pairwiseSubject(pairwiseKey: Buffer, audience: string, sponsorUserId: string): string {
  return createHmac("sha256", pairwiseKey).update(`${audience}\u0000${sponsorUserId}`).digest("base64url");
}

/** the gateway's current DPoP nonce: `<slot>.<HMAC(slot)>`, valid for the rest of its 5-minute slot on every replica */
export function issueDpopNonce(nonceKey: Buffer, now: Date = new Date()): string {
  const slot = Math.floor(now.getTime() / 1000 / DPOP_NONCE_SLOT_SECONDS);
  return `${slot}.${createHmac("sha256", nonceKey).update(String(slot)).digest("base64url")}`;
}
export function dpopNonceValid(value: unknown, nonceKey: Buffer, now: Date = new Date()): boolean {
  if (typeof value !== "string") return false;
  const expected = issueDpopNonce(nonceKey, now);
  return constantTimeEqual(value, expected);
}

// ---------------------------------------------------------------------------
// Replay claims (decision 14): one atomic insert, never find-then-save
// ---------------------------------------------------------------------------

/**
 * CLAIM `key` in `namespace` until `expiresAt`: `INSERT … ON CONFLICT DO
 * NOTHING RETURNING`. True = this caller is first; false = replay. Runs as its
 * OWN autocommit statement on `db` (never a caller's transaction), so a later
 * failure of the same request can never roll a winning claim back.
 */
export async function claimReplay(db: Db, namespace: ReplayNamespace, key: string, expiresAt: Date): Promise<boolean> {
  const k = key.length <= 256 ? key : b64urlSha256(key);
  const now = new Date();
  const until = expiresAt.getTime() > now.getTime() + 1000 ? expiresAt : new Date(now.getTime() + 1000);
  const rows = await db
    .insert(replayClaims)
    .values({ namespace, key: k, expiresAt: until })
    .onConflictDoNothing()
    .returning({ key: replayClaims.key });
  return rows.length === 1;
}

/** remove claims past their window (the guard trigger refuses removing a live one) */
export async function sweepReplayClaims(db: Db, now: Date = new Date()): Promise<number> {
  return (await db.delete(replayClaims).where(lte(replayClaims.expiresAt, now)).returning({ key: replayClaims.key })).length;
}

// ---------------------------------------------------------------------------
// Mint (decision 5)
// ---------------------------------------------------------------------------

export class TokenMintError extends Error {
  constructor(readonly code: "grant_not_found" | "grant_not_external" | "chain_not_live" | "grant_expiring", message: string) {
    super(message);
  }
}

export interface MintedToken {
  accessToken: string;
  jti: string;
  /** `DPoP`, or `Bearer` on the mTLS branch (RFC 8705 keeps that name for a certificate-bound token) */
  tokenType: "DPoP" | "Bearer";
  expiresIn: number;
  expiresAt: Date;
  kid: string;
}

/**
 * Mint the access token of an EXTERNAL grant. The grant's chain must be live
 * right now (decision 17); the token never outlives the grant. The `act`
 * claim and `client_id` come from the stored chain, never from a caller.
 */
export async function mintDelegatedToken(
  db: Db,
  opts: { grantId: string; issuer: string; secrets: IdentitySecrets; now?: Date; env?: NodeJS.ProcessEnv },
): Promise<MintedToken> {
  const now = opts.now ?? new Date();
  const live = await loadLiveChain(db, opts.grantId, now);
  if (!live) throw new TokenMintError("grant_not_found", "no such delegation grant");
  const grant = live.leaf;
  if (grant.bindingKind === "in_process" || !grant.bindingThumbprint || !grant.audience || !grant.authCredentialId) {
    throw new TokenMintError("grant_not_external", "an in-process grant mints no token (ADR-0188 decision 6)");
  }
  if (live.failure) throw new TokenMintError("chain_not_live", `the delegation chain is not live (${live.failure.code})`);
  const org = await loadOrgSettings(db);
  const iat = Math.floor(now.getTime() / 1000);
  const grantLeft = Math.floor(grant.expiresAt.getTime() / 1000) - iat;
  const ttl = Math.min(org.delegatedTokenTtlSeconds, grantLeft);
  if (ttl < 1) throw new TokenMintError("grant_expiring", "the grant expires before a token could be used");
  const exp = iat + ttl;
  const signer = await currentIssuerSigner(db, opts.env ?? process.env);
  const jti = randomBytes(32).toString("base64url");
  const cnf = grant.bindingKind === "dpop" ? { jkt: grant.bindingThumbprint } : { "x5t#S256": grant.bindingThumbprint };
  await db.insert(issuedTokens).values({
    jti,
    grantId: grant.id,
    authCredentialId: grant.authCredentialId,
    signingKid: signer.kid,
    bindingKind: grant.bindingKind,
    bindingThumbprint: grant.bindingThumbprint,
    audience: grant.audience,
    env: grant.environment,
    issuedAt: new Date(iat * 1000),
    expiresAt: new Date(exp * 1000),
  });
  const leafActor = live.chain.actors[live.chain.actors.length - 1]!;
  const accessToken = await new SignJWT({
    client_id: leafActor.identifier,
    act: actClaimFromChain(live.chain.actors) as unknown as JWTPayload,
    grant_id: grant.id,
    env: grant.environment,
    cnf,
  })
    .setProtectedHeader({ alg: ISSUER_JWS_ALG, typ: ACCESS_TOKEN_TYP, kid: signer.kid })
    .setIssuer(opts.issuer)
    .setSubject(pairwiseSubject(opts.secrets.pairwiseKey, grant.audience, grant.sponsorUserId))
    .setAudience(grant.audience)
    .setJti(jti)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(signer.privateKey);
  return {
    accessToken,
    jti,
    tokenType: grant.bindingKind === "dpop" ? "DPoP" : "Bearer",
    expiresIn: ttl,
    expiresAt: new Date(exp * 1000),
    kid: signer.kid,
  };
}

// ---------------------------------------------------------------------------
// Verify (decision 13)
// ---------------------------------------------------------------------------

export type VerifyFailure = {
  ok: false;
  status: 401;
  /** RFC 6750 / RFC 9449 error */
  error: "invalid_token" | "invalid_dpop_proof" | "use_dpop_nonce";
  /** our short reason CODE (never secret material) */
  code: string;
  /** a fresh nonce to retry with, on `use_dpop_nonce` */
  dpopNonce?: string;
};
export type VerifySuccess = {
  ok: true;
  claims: JWTPayload & { client_id: string; grant_id: string; env: string; jti: string };
  binding: { kind: "dpop" | "mtls"; thumbprint: string };
  grantId: string;
  /** the decision 17 chain, read at this request; hand it to `governedActorFor`'s caller */
  live: LiveChain;
};

export interface VerifyDelegatedTokenInput {
  /** the HTTP request as the resource saw it (method, absolute URL, Authorization and DPoP headers) */
  request: Request;
  /** this route's resource (RFC 8707): the token's `aud` must be exactly it */
  audience: string;
  /** the environment this deployment serves: the token's `env` must equal it */
  env: string;
  /** the gateway issuer (`iss`) */
  issuer: string;
  secrets: Pick<IdentitySecrets, "nonceKey">;
  /**
   * mTLS only: the client's leaf certificate (DER), ALREADY path-validated by
   * the transport under decision 21 (S5/S9). Absent = no client certificate.
   */
  clientCertificateDer?: Uint8Array | null;
  now?: Date;
}

const fail = (code: string, error: VerifyFailure["error"] = "invalid_token", extra: Partial<VerifyFailure> = {}): VerifyFailure => ({
  ok: false,
  status: 401,
  error,
  code,
  ...extra,
});

function exactlyOneCnf(payload: JWTPayload): { kind: "dpop" | "mtls"; thumbprint: string } | null {
  const cnf = payload.cnf as Record<string, unknown> | undefined;
  if (!cnf || typeof cnf !== "object" || Array.isArray(cnf) || Object.keys(cnf).length !== 1) return null;
  if (typeof cnf.jkt === "string" && cnf.jkt) return { kind: "dpop", thumbprint: cnf.jkt };
  if (typeof cnf["x5t#S256"] === "string" && cnf["x5t#S256"]) return { kind: "mtls", thumbprint: cnf["x5t#S256"] as string };
  return null;
}

/** the issuer key a token names, if it is published right now (unknown kid: refuse; no external fallback) */
async function issuerKeyFor(db: Db, token: string, now: Date): Promise<{ row: IdentitySigningKeyRow; published: IdentitySigningKeyRow[] } | null> {
  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return null;
  }
  if (header.alg !== ISSUER_JWS_ALG || header.typ !== ACCESS_TOKEN_TYP || typeof header.kid !== "string") return null;
  const published = await publishedSigningKeys(db, now);
  const row = published.find((k) => k.kid === header.kid);
  return row ? { row, published } : null;
}

const jwkOf = (r: IdentitySigningKeyRow) => ({ kty: "OKP", crv: "Ed25519", x: r.publicJwk.x, kid: r.kid, alg: ISSUER_JWS_ALG, use: "sig" });

/**
 * The checks after the signature (step 4): `env`, `aud`, the stored token row
 * and binding, the signing key's lifecycle, then the live chain. Shared by the
 * resource verifier and the parent check of a hand-off.
 */
async function storedAndLive(
  db: Db,
  claims: JWTPayload,
  binding: { kind: "dpop" | "mtls"; thumbprint: string },
  key: IdentitySigningKeyRow,
  expect: { audience?: string; env: string },
  now: Date,
): Promise<{ ok: true; live: LiveChain } | VerifyFailure> {
  if (claims.env !== expect.env) return fail("env_mismatch");
  if (expect.audience !== undefined && claims.aud !== expect.audience) return fail("audience_mismatch");
  if (typeof claims.jti !== "string" || typeof claims.grant_id !== "string" || typeof claims.iat !== "number") return fail("claims_missing");
  if (!signingKeyAccepts(key, claims.iat, now)) return fail("signing_key_not_accepted");
  const [row] = await db.select().from(issuedTokens).where(eq(issuedTokens.jti, claims.jti));
  if (
    !row ||
    row.revokedAt !== null ||
    row.grantId !== claims.grant_id ||
    row.bindingKind !== binding.kind ||
    row.bindingThumbprint !== binding.thumbprint ||
    row.audience !== claims.aud ||
    row.env !== claims.env ||
    row.signingKid !== key.kid ||
    row.expiresAt.getTime() <= now.getTime()
  ) {
    return fail("issued_token_mismatch");
  }
  // decision 12: a REGISTERED key or certificate used only as this token's binding, once revoked, refuses
  // every token bound to its thumbprint (the grant itself survives; its holder may re-authenticate)
  const [boundRevoked] = await db
    .select({ id: workloadCredentials.id })
    .from(workloadCredentials)
    .where(
      and(
        or(eq(workloadCredentials.jwkThumbprint, binding.thumbprint), eq(workloadCredentials.x5tS256, binding.thumbprint)),
        isNotNull(workloadCredentials.revokedAt),
      ),
    )
    .limit(1);
  if (boundRevoked) return fail("binding_key_revoked");
  const live = await loadLiveChain(db, row.grantId, now);
  if (!live) return fail("grant_not_found");
  if (live.failure) return fail(`chain_${live.failure.code}`);
  // the stored binding is the grant's, and the actor is the leaf's (never what a caller claims)
  if (live.leaf.bindingThumbprint !== binding.thumbprint || live.leaf.bindingKind !== binding.kind) return fail("grant_binding_mismatch");
  const leafActor = live.chain.actors[live.chain.actors.length - 1]!;
  if (claims.client_id !== leafActor.identifier) return fail("client_id_mismatch");
  return { ok: true, live };
}

/**
 * THE RESOURCE-SIDE VERIFIER (decision 13). 401 on any failure, with a short
 * code; `use_dpop_nonce` carries a fresh nonce to retry with.
 */
export async function verifyDelegatedToken(db: Db, input: VerifyDelegatedTokenInput): Promise<VerifySuccess | VerifyFailure> {
  const now = input.now ?? new Date();
  const auth = input.request.headers.get("authorization") ?? "";
  const m = /^(DPoP|Bearer) ([A-Za-z0-9_\-.]+)$/.exec(auth);
  if (!m) return fail("no_token");
  const [, scheme, token] = m as unknown as [string, "DPoP" | "Bearer", string];
  let unverified: JWTPayload;
  try {
    unverified = decodeJwt(token);
  } catch {
    return fail("malformed_token");
  }
  // 1. exactly one sender binding: an unbound (bearer) delegated token is never accepted
  const binding = exactlyOneCnf(unverified);
  if (!binding) return fail("cnf_invalid");
  const key = await issuerKeyFor(db, token, now);
  if (!key) return fail("unknown_or_unpublished_key");

  let claims: JWTPayload;
  if (binding.kind === "dpop") {
    // 2. DPoP branch
    if (scheme !== "DPoP") return fail("dpop_scheme_required");
    const proofJwt = input.request.headers.get("dpop");
    if (!proofJwt) return fail("dpop_proof_missing", "invalid_dpop_proof");
    try {
      claims = await oauth.validateJwtAccessToken({ issuer: input.issuer, jwks_uri: LOCAL_JWKS_URI }, input.request, input.audience, {
        requireDPoP: true,
        signingAlgorithms: [...WORKLOAD_PROOF_ALGS],
        // local keys only: the placeholder URI is answered here and no request ever leaves the process
        [oauth.customFetch]: async (url: string) => {
          if (url !== LOCAL_JWKS_URI) throw new Error("no remote key fetch");
          return new Response(JSON.stringify({ keys: [jwkOf(key.row)] }), { headers: { "content-type": "application/json" } });
        },
      });
    } catch {
      return fail("token_or_proof_invalid");
    }
    let proof: JWTPayload;
    try {
      proof = decodeJwt(proofJwt);
    } catch {
      return fail("dpop_proof_malformed", "invalid_dpop_proof");
    }
    const nowS = Math.floor(now.getTime() / 1000);
    if (typeof proof.iat !== "number" || proof.iat < nowS - DPOP_PROOF_MAX_AGE_SECONDS || proof.iat > nowS + DPOP_PROOF_MAX_FUTURE_SECONDS) {
      return fail("dpop_proof_stale", "invalid_dpop_proof");
    }
    const org = await loadOrgSettings(db);
    if (org.dpopNonceRequired && !dpopNonceValid(proof.nonce, input.secrets.nonceKey, now)) {
      return fail("dpop_nonce_required", "use_dpop_nonce", { dpopNonce: issueDpopNonce(input.secrets.nonceKey, now) });
    }
    if (typeof proof.jti !== "string" || proof.jti.length === 0 || proof.jti.length > 256) return fail("dpop_proof_jti", "invalid_dpop_proof");
    const claimed = await claimReplay(
      db,
      "rs_dpop",
      `${binding.thumbprint}:${proof.jti}`,
      new Date((proof.iat + DPOP_PROOF_MAX_AGE_SECONDS + DPOP_PROOF_MAX_FUTURE_SECONDS) * 1000),
    );
    if (!claimed) return fail("dpop_proof_replayed", "invalid_dpop_proof");
  } else {
    // 3. mTLS branch: the signature alone through jose, then the certificate; no DPoP fallback
    if (scheme !== "Bearer" || input.request.headers.has("dpop")) return fail("mtls_scheme_required");
    try {
      claims = (
        await jwtVerify(token, await importJWK(jwkOf(key.row) as JWK, ISSUER_JWS_ALG), {
          algorithms: [ISSUER_JWS_ALG],
          typ: ACCESS_TOKEN_TYP,
          issuer: input.issuer,
          audience: input.audience,
          currentDate: now,
          requiredClaims: ["iss", "sub", "aud", "exp", "iat", "jti", "client_id"],
        })
      ).payload;
    } catch {
      return fail("token_invalid");
    }
    if (!input.clientCertificateDer || input.clientCertificateDer.length === 0) return fail("client_certificate_required");
    if (b64urlSha256(input.clientCertificateDer) !== binding.thumbprint) return fail("client_certificate_mismatch");
  }

  // 4. env, aud, the stored token and binding, the key's lifecycle, the live chain
  const rest = await storedAndLive(db, claims, binding, key.row, { audience: input.audience, env: input.env }, now);
  if (!rest.ok) return rest;
  return {
    ok: true,
    claims: claims as VerifySuccess["claims"],
    binding,
    grantId: claims.grant_id as string,
    live: rest.live,
  };
}

// ---------------------------------------------------------------------------
// Decision 23: a parent authorises one specific child and body
// ---------------------------------------------------------------------------

export interface DelegationAuthorizationInput {
  /** A's delegated access token (the exchange's `subject_token`) */
  parentToken: string;
  /** A's delegation authorization (the exchange's `actor_token`) */
  authorization: string;
  /** the request body's delegation, exactly as asked */
  body: DelegationBody;
  /** the request's idempotency key */
  idempotencyKey: string;
  /** the workload identity the token endpoint AUTHENTICATED (client assertion / mTLS / SVID) */
  authenticatedChildIdentityId: string;
  /** the RFC 7638 thumbprint of the key that signed the request's own DPoP header (already verified by S5) */
  requestDpopJkt: string;
  /** the token endpoint URL (`htu`) */
  tokenEndpointUrl: string;
  issuer: string;
  /** the deployment's environment: the parent token's `env` must equal it */
  env: string;
  secrets: Pick<IdentitySecrets, "nonceKey">;
  now?: Date;
}
export type DelegationAuthorizationResult =
  | { ok: true; parentGrantId: string; parentLive: LiveChain; jti: string }
  | { ok: false; error: "invalid_grant" | "invalid_request" | "use_dpop_nonce"; code: string; dpopNonce?: string };

/**
 * Check A's authorization of ONE child and body (decision 23), IN THIS ORDER
 * and BEFORE claiming anything: A's token (signature, stored row and binding,
 * live chain; a certificate-bound parent is refused
 * `mtls_parent_handoff_unsupported`), the authorization's signature by A's
 * bound key (header `jwk` whose thumbprint is the token's `cnf.jkt`), its
 * DPoP-style fields (`htm`, `htu`, `ath`, `iat`, `nonce`, `jti`), `iss` = A,
 * `aud` = our issuer, `parent_grant_id`, `child` = the authenticated client,
 * `child_cnf` = the request's DPoP key, `delegation` = the request body's
 * RFC 8785 form, `idempotency_key`. Only when everything matches is the `jti`
 * claimed (`delegation_authz`); a mismatch consumes nothing, so a substituted
 * request cannot burn A's authorization. The caller then admits the child
 * (`admitChildGrant`) with exactly this body.
 */
export async function checkDelegationAuthorization(db: Db, input: DelegationAuthorizationInput): Promise<DelegationAuthorizationResult> {
  const now = input.now ?? new Date();
  const no = (code: string, error: "invalid_grant" | "invalid_request" | "use_dpop_nonce" = "invalid_grant", extra: { dpopNonce?: string } = {}) =>
    ({ ok: false, error, code, ...extra }) as const;

  // A's token: signature with our published keys
  let parentClaims: JWTPayload;
  let binding: { kind: "dpop" | "mtls"; thumbprint: string } | null;
  try {
    binding = exactlyOneCnf(decodeJwt(input.parentToken));
  } catch {
    return no("parent_token_malformed");
  }
  if (!binding) return no("parent_cnf_invalid");
  if (binding.kind === "mtls") return no("mtls_parent_handoff_unsupported");
  const key = await issuerKeyFor(db, input.parentToken, now);
  if (!key) return no("parent_key_unknown");
  try {
    parentClaims = (
      await jwtVerify(input.parentToken, await importJWK(jwkOf(key.row) as JWK, ISSUER_JWS_ALG), {
        algorithms: [ISSUER_JWS_ALG],
        typ: ACCESS_TOKEN_TYP,
        issuer: input.issuer,
        currentDate: now,
        requiredClaims: ["iss", "sub", "aud", "exp", "iat", "jti", "client_id"],
      })
    ).payload;
  } catch {
    return no("parent_token_invalid");
  }
  const stored = await storedAndLive(db, parentClaims, binding, key.row, { env: input.env }, now);
  if (!stored.ok) return no(`parent_${stored.code}`);

  // the authorization: signed by A's BOUND key (the one the parent token's cnf.jkt names)
  let header;
  try {
    header = decodeProtectedHeader(input.authorization);
  } catch {
    return no("authz_malformed");
  }
  const jwk = header.jwk as JWK | undefined;
  if (
    header.typ !== DELEGATION_AUTHZ_TYP ||
    !(WORKLOAD_PROOF_ALGS as readonly string[]).includes(String(header.alg)) ||
    !jwk ||
    typeof jwk !== "object" ||
    ["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some((m) => m in jwk)
  ) {
    return no("authz_header_invalid");
  }
  let thumb: string;
  try {
    thumb = await calculateJwkThumbprint(jwk, "sha256");
  } catch {
    return no("authz_header_invalid");
  }
  if (thumb !== binding.thumbprint) return no("authz_not_parent_key");
  let a: JWTPayload;
  try {
    a = (
      await jwtVerify(input.authorization, await importJWK(jwk, String(header.alg)), {
        algorithms: [...WORKLOAD_PROOF_ALGS],
        typ: DELEGATION_AUTHZ_TYP,
        issuer: parentClaims.client_id as string,
        audience: input.issuer,
        currentDate: now,
      })
    ).payload;
  } catch {
    return no("authz_signature_invalid");
  }
  const nowS = Math.floor(now.getTime() / 1000);
  if (typeof a.iat !== "number" || a.iat < nowS - DPOP_PROOF_MAX_AGE_SECONDS || a.iat > nowS + DPOP_PROOF_MAX_FUTURE_SECONDS) return no("authz_stale");
  const org = await loadOrgSettings(db);
  if (org.dpopNonceRequired && !dpopNonceValid(a.nonce, input.secrets.nonceKey, now)) {
    return no("authz_nonce_required", "use_dpop_nonce", { dpopNonce: issueDpopNonce(input.secrets.nonceKey, now) });
  }
  if (typeof a.jti !== "string" || a.jti.length === 0 || a.jti.length > 256) return no("authz_jti_invalid");
  if (a.htm !== "POST" || a.htu !== input.tokenEndpointUrl || a.ath !== b64urlSha256(input.parentToken)) return no("authz_request_mismatch");
  if (a.parent_grant_id !== parentClaims.grant_id || a.parent_grant_id !== stored.live.leaf.id) return no("authz_parent_mismatch");
  if (a.child !== input.authenticatedChildIdentityId) return no("authz_child_mismatch");
  if (a.child_cnf !== input.requestDpopJkt) return no("authz_child_key_mismatch");
  let canonicalBody: string;
  try {
    canonicalBody = canonicalDelegationBody(input.body);
  } catch {
    return no("delegation_body_invalid", "invalid_request");
  }
  if (a.delegation !== canonicalBody) return no("authz_body_mismatch");
  if (a.idempotency_key !== input.idempotencyKey) return no("authz_idempotency_mismatch");

  // everything matched: only now is A's authorization consumed (once, atomically)
  const claimed = await claimReplay(
    db,
    "delegation_authz",
    `${binding.thumbprint}:${a.jti}`,
    new Date((a.iat + DPOP_PROOF_MAX_AGE_SECONDS + DPOP_PROOF_MAX_FUTURE_SECONDS) * 1000),
  );
  if (!claimed) return no("authz_replayed");
  return { ok: true, parentGrantId: stored.live.leaf.id, parentLive: stored.live, jti: a.jti };
}
