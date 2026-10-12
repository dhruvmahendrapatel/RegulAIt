/**
 * ADR-0188 slice S7 (OWNER DECISION 8) — WORKLOAD SELF TOKENS: an engine runner
 * or a PDP client acting AS ITSELF on its own control-plane route, with no
 * bearer secret.
 *
 * WHAT REPLACED WHAT. An engine runner held an `rge_` bearer token and a data
 * plane proxy a `pdp` virtual key: whoever held the string was the principal.
 * Each is now a workload identity (kind `engine_runner` or `pdp`) with a
 * registered PUBLIC key. It authenticates to `POST /oauth/token` with
 * `private_key_jwt` (RFC 7523) and the RFC 6749 `client_credentials` grant,
 * proves possession of a key with DPoP (RFC 9449), and gets a token bound to
 * that key (`cnf.jkt`): a stolen token is useless without the private key, and
 * the private key never leaves the workload.
 *
 * WHAT A SELF TOKEN IS, AND IS NOT. It names the identity as `sub` and
 * `client_id` (RFC 9068 §2.2: a client acting on its own behalf), ONE
 * control-plane audience (`WORKLOAD_SELF_RESOURCE_PATHS`: the runner routes, or
 * `POST /v1/authz/check`), and carries NO delegation grant and NO sponsor. So it
 * can never reach a governed route: the delegated-token verifier requires a
 * grant (`storedAndLive` refuses a row with none), the RFC 8707 resources a
 * delegated token may name are disjoint from these two, and this verifier
 * refuses any token that carries a `grant_id`. The authority a runner's run
 * needs is unchanged: the run-scoped engine key (ADR-0187: the run-as person's
 * ceiling, the run's project) and the run's delegation grant (S4), both minted
 * at lease.
 *
 * MINT. Lifetime `delegated_token_ttl_seconds` (strict 300); one
 * `issued_tokens` row per token (`subject_identity_id`, no `grant_id`; migration
 * 0195), recording the authenticating credential, the DPoP binding and the
 * signing key, so decision 12's revocations reach it: revoking the key that
 * authenticated it, the key it is bound to, the identity, or the issuer key
 * that signed it refuses it at the next use.
 *
 * VERIFY (every step fails closed, 401): the DPoP scheme, exactly one `cnf`
 * member and it is `jkt` (a self token is never certificate-bound), the issuer
 * key (local only), S3's shared DPoP branch (`verifyDpopBranch`: the library's
 * JWT and proof checks, then our 60 s freshness, gateway nonce and atomic
 * `rs_dpop` replay claim); then `env`, the route's audience, the stored row
 * (self, unrevoked, same binding, audience, env and signing key), the binding
 * key and the authenticating credential unrevoked, and the identity live, of
 * the route's kind, allowed in this environment. Open source first (ADR-0176):
 * `jose` and `oauth4webapi` do the cryptography and the protocol checks; what
 * is ours is the stored-row and identity policy above.
 */
import { randomBytes } from "node:crypto";
import { decodeJwt, SignJWT, type JWTPayload } from "jose";
import { and, engineRunners, eq, isNotNull, issuedTokens, or, workloadCredentials, workloadIdentities, type Db, type IdentitySigningKeyRow } from "@regulait/db";
import { WORKLOAD_SELF_KINDS, WORKLOAD_SELF_RESOURCE_PATHS, type WorkloadSelfKind } from "@regulait/shared";
import { ACCESS_TOKEN_TYP, exactlyOneCnf, issuerKeyFor, verifyDpopBranch, type IdentitySecrets, type VerifyFailure } from "../delegated-token.js";
import { databaseNow } from "../delegation.js";
import { currentIssuerSigner, ISSUER_JWS_ALG, signingKeyAccepts } from "../identity-signing-keys.js";
import { loadOrgSettings } from "../org-settings.js";

/** the one control-plane resource a self token of `kind` names (an absolute URL under the issuer) */
export function selfResource(issuer: string, kind: WorkloadSelfKind): string {
  return `${issuer}${WORKLOAD_SELF_RESOURCE_PATHS[kind]}`;
}

/** which self-token kind a requested resource is for, or null (exact match only) */
export function selfKindForResource(issuer: string, resource: string): WorkloadSelfKind | null {
  for (const k of WORKLOAD_SELF_KINDS) if (resource === selfResource(issuer, k)) return k;
  return null;
}

export interface MintedSelfToken {
  accessToken: string;
  jti: string;
  tokenType: "DPoP";
  expiresIn: number;
}

/**
 * Mint a self token for `identity`, authenticated by `authCredentialId` and
 * bound to the DPoP key `jkt`. Database clock throughout (S3 amendment item 4).
 */
export async function mintWorkloadSelfToken(
  db: Db,
  opts: { identityId: string; identifier: string; kind: WorkloadSelfKind; authCredentialId: string; jkt: string; issuer: string; env: string; now?: Date },
): Promise<MintedSelfToken> {
  const now = opts.now ?? (await databaseNow(db));
  const org = await loadOrgSettings(db);
  const signer = await currentIssuerSigner(db, process.env);
  // never stamped before the signing key's activation (the verifier's lifecycle check), whole seconds rounded down
  const iat = Math.max(Math.floor(now.getTime() / 1000), Math.floor(signer.activatedAt.getTime() / 1000));
  const ttl = org.delegatedTokenTtlSeconds;
  const exp = iat + ttl;
  const jti = randomBytes(32).toString("base64url");
  const audience = selfResource(opts.issuer, opts.kind);
  await db.insert(issuedTokens).values({
    jti,
    grantId: null,
    subjectIdentityId: opts.identityId,
    authCredentialId: opts.authCredentialId,
    signingKid: signer.kid,
    bindingKind: "dpop",
    bindingThumbprint: opts.jkt,
    audience,
    env: opts.env,
    issuedAt: new Date(iat * 1000),
    expiresAt: new Date(exp * 1000),
  });
  const accessToken = await new SignJWT({ client_id: opts.identifier, env: opts.env, cnf: { jkt: opts.jkt } })
    .setProtectedHeader({ alg: ISSUER_JWS_ALG, typ: ACCESS_TOKEN_TYP, kid: signer.kid })
    .setIssuer(opts.issuer)
    .setSubject(opts.identifier)
    .setAudience(audience)
    .setJti(jti)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(signer.privateKey);
  return { accessToken, jti, tokenType: "DPoP", expiresIn: ttl };
}

const fail = (code: string, error: VerifyFailure["error"] = "invalid_token", extra: Partial<VerifyFailure> = {}): VerifyFailure => ({ ok: false, status: 401, error, code, ...extra });

export interface SelfTokenSubject {
  identity: typeof workloadIdentities.$inferSelect;
  authCredentialId: string;
  jti: string;
  /** an engine runner's row (kind `engine_runner` only) */
  runner: { id: string; engineId: string } | null;
}

/**
 * Step 4 for a self token, shared by the resource verifier and RFC 7662
 * introspection: the stored row, the keys, and the identity, read now.
 */
export async function storedSelfToken(
  db: Db,
  claims: JWTPayload,
  binding: { kind: "dpop" | "mtls"; thumbprint: string },
  key: IdentitySigningKeyRow,
  expect: { kind?: WorkloadSelfKind; audience?: string; env: string; issuer?: string },
  now: Date,
): Promise<{ ok: true; subject: SelfTokenSubject } | VerifyFailure> {
  if (binding.kind !== "dpop") return fail("self_token_binding");
  // a delegated token is never a self token, whatever its row says
  if (claims.grant_id !== undefined || claims.act !== undefined) return fail("delegated_token_not_accepted");
  if (claims.env !== expect.env) return fail("env_mismatch");
  if (expect.audience !== undefined && claims.aud !== expect.audience) return fail("audience_mismatch");
  if (typeof claims.jti !== "string" || typeof claims.iat !== "number" || typeof claims.client_id !== "string" || claims.sub !== claims.client_id) return fail("claims_missing");
  if (!signingKeyAccepts(key, claims.iat, now)) return fail("signing_key_not_accepted");
  const [row] = await db.select().from(issuedTokens).where(eq(issuedTokens.jti, claims.jti));
  if (
    !row ||
    row.revokedAt !== null ||
    row.grantId !== null ||
    row.subjectIdentityId === null ||
    row.bindingKind !== "dpop" ||
    row.bindingThumbprint !== binding.thumbprint ||
    row.audience !== claims.aud ||
    row.env !== claims.env ||
    row.signingKid !== key.kid ||
    row.expiresAt.getTime() <= now.getTime()
  ) {
    return fail("issued_token_mismatch");
  }
  // decision 12: a revoked key refuses what it authenticated and what is bound to it
  const [revoked] = await db
    .select({ id: workloadCredentials.id })
    .from(workloadCredentials)
    .where(
      and(
        or(eq(workloadCredentials.id, row.authCredentialId), eq(workloadCredentials.jwkThumbprint, binding.thumbprint), eq(workloadCredentials.spkiThumbprint, binding.thumbprint))!,
        isNotNull(workloadCredentials.revokedAt),
      ),
    )
    .limit(1);
  if (revoked) return fail("credential_revoked");
  const [identity] = await db.select().from(workloadIdentities).where(eq(workloadIdentities.id, row.subjectIdentityId));
  if (!identity || identity.status !== "active") return fail("identity_not_active");
  if (identity.identifier !== claims.client_id) return fail("client_id_mismatch");
  const kind = identity.kind as string;
  if (!(WORKLOAD_SELF_KINDS as readonly string[]).includes(kind)) return fail("identity_kind");
  if (expect.kind !== undefined && kind !== expect.kind) return fail("identity_kind");
  if (expect.issuer !== undefined && claims.aud !== selfResource(expect.issuer, kind as WorkloadSelfKind)) return fail("audience_mismatch");
  if (!identity.environments.includes(expect.env)) return fail("identity_environment");
  let runner: SelfTokenSubject["runner"] = null;
  if (kind === "engine_runner") {
    if (!identity.engineRunnerId) return fail("identity_kind");
    const [r] = await db
      .select({ id: engineRunners.id, engineId: engineRunners.engineId, revokedAt: engineRunners.revokedAt })
      .from(engineRunners)
      .where(eq(engineRunners.id, identity.engineRunnerId));
    if (!r) return fail("engine_runner_unknown");
    // ADR-0187: a revoked runner's credential authenticates nothing (the runner's loop reads this code)
    if (r.revokedAt !== null) return fail("engine_runner_revoked");
    runner = { id: r.id, engineId: r.engineId };
  }
  return { ok: true, subject: { identity, authCredentialId: row.authCredentialId, jti: row.jti, runner } };
}

export interface VerifySelfTokenInput {
  /** the request as the resource saw it (method, absolute URL under the issuer, Authorization and DPoP headers) */
  request: Request;
  kind: WorkloadSelfKind;
  env: string;
  issuer: string;
  secrets: Pick<IdentitySecrets, "nonceKey">;
  now?: Date;
}

/** THE SELF-TOKEN VERIFIER at a control-plane route. 401 on any failure, with a short code. */
export async function verifyWorkloadSelfToken(db: Db, input: VerifySelfTokenInput): Promise<{ ok: true; subject: SelfTokenSubject } | VerifyFailure> {
  const now = input.now ?? (await databaseNow(db));
  const auth = input.request.headers.get("authorization") ?? "";
  const sp = auth.indexOf(" ");
  // RFC 9110 §11.1: the scheme is case-insensitive; a self token is ALWAYS DPoP-bound (no Bearer form exists)
  if (sp <= 0 || auth.slice(0, sp).toLowerCase() !== "dpop") return fail("dpop_scheme_required");
  const token = auth.slice(sp + 1).trim();
  let unverified: JWTPayload;
  try {
    unverified = decodeJwt(token);
  } catch {
    return fail("malformed_token");
  }
  const binding = exactlyOneCnf(unverified);
  if (!binding || binding.kind !== "dpop") return fail("cnf_invalid");
  const key = await issuerKeyFor(db, token, now);
  if (!key) return fail("unknown_or_unpublished_key");
  const audience = selfResource(input.issuer, input.kind);
  const dpop = await verifyDpopBranch(db, { request: input.request, audience, issuer: input.issuer, secrets: input.secrets as IdentitySecrets }, key.row, binding.thumbprint, now);
  if (!dpop.ok) return dpop;
  return storedSelfToken(db, dpop.claims, binding, key.row, { kind: input.kind, audience, env: input.env }, now);
}
