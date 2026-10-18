/**
 * ADR-0188 slice S7 (OWNER DECISION 8) — AN ENGINE RUNNER'S KEY: the credential
 * that replaced the `rge_` bearer token.
 *
 *  - ENROLMENT. The runner generates an Ed25519 key on its own state volume
 *    (0600) and registers only the PUBLIC half with its one-time enrolment
 *    token. The gateway gives the new runner its workload identity (kind
 *    `engine_runner`, S4's `ensureIdentityFor`) and binds the key to it as a
 *    credential through S6's one binding path (`bindPreparedCredentialTx`): a
 *    window of at most `workload_key_max_age_days` (strict 90), and one key
 *    authenticates one identity, ever. Nothing secret is stored, and nothing
 *    the gateway holds could ever authenticate as the runner.
 *  - SUPERSEDING (ADR-0187 round 5 [67], kept). A runner re-enrolling after a
 *    build change proves it held the previous registration with a compact JWS
 *    signed by its OLD key, naming the NEW key's thumbprint (`jkt`); the
 *    gateway verifies it against that old key's registered credential and
 *    revokes that runner in the registration's transaction.
 *  - ROTATION (decision 12). `POST /v1/engine-runner/credentials`, presented
 *    with the runner's current self token, binds a NEW key (proved by a JWS
 *    the new key signed) and moves the old key's `not_after` to now: the old
 *    key mints no new token, while tokens it already authenticated live to
 *    their own expiry. Audited. Rotation is not revocation: nothing is revoked
 *    and the runner's identity, and so its audit continuity, is unchanged.
 *
 * Open source first (ADR-0176): `jose` verifies every JWS and computes RFC 7638
 * thumbprints; the credential checks are S6's.
 */
import type { FastifyInstance } from "fastify";
import { calculateJwkThumbprint, decodeProtectedHeader, EmbeddedJWK, importJWK, jwtVerify, type JWK } from "jose";
import { and, auditLog, engineRunners, eq, isNull, sql, workloadCredentials, workloadIdentities, type Db } from "@regulait/db";
import {
  CLIENT_ASSERTION_MAX_AGE_SECONDS,
  DPOP_PROOF_MAX_FUTURE_SECONDS,
  engineRunnerKeyRotationSchema,
  KEY_ROTATION_PROOF_TYP,
  RUNNER_SUPERSEDE_PROOF_TYP,
  type WorkloadCredentialView,
  type WorkloadPublicJwk,
} from "@regulait/shared";
import { databaseNow } from "./delegation.js";
import { claimReplay, WORKLOAD_PROOF_ALGS } from "./delegated-token.js";
import { bindPreparedCredentialTx, IdentityAdminError, NO_SPIFFE_TRUST_DOMAINS, prepareCredential, runnerKeyLimitRefusal, type PreparedCredential } from "./oauth/identity-admin.js";
import { identityIssuer } from "./oauth/common.js";

/** the system actor of a runner's own registration and rotation (no person acted) */
export const RUNNER_ACTOR_ID = "00000000-0000-0000-0000-000000000000";
export { RUNNER_MAX_LIVE_KEYS } from "./oauth/identity-admin.js";
/** the route a runner rotates its key on (also the `aud` of the rotation proof, under the issuer) */
export const RUNNER_KEY_ROTATION_PATH = "/v1/engine-runner/credentials";

/** a runner's public key, validated and reduced to its RFC 7638 members exactly as S6 binds a JWK */
export async function prepareRunnerKey(publicJwk: WorkloadPublicJwk, now: Date): Promise<PreparedCredential | IdentityAdminError> {
  return prepareCredential({ kind: "jwk", publicJwk }, now, NO_SPIFFE_TRUST_DOMAINS);
}

/** the RFC 7638 thumbprint a registration names its key by */
export async function runnerKeyThumbprint(prepared: PreparedCredential): Promise<string> {
  return prepared.jwkThumbprint ?? (await calculateJwkThumbprint(prepared.publicJwk as JWK, "sha256"));
}

/** is the key `jkt` registered (to any identity, revoked or not)? One key authenticates one identity, ever. */
export async function keyRegistered(db: Db, jkt: string): Promise<{ identityId: string } | null> {
  const [row] = await db.select({ identityId: workloadCredentials.identityId }).from(workloadCredentials).where(eq(workloadCredentials.jwkThumbprint, jkt));
  return row ?? null;
}

/** does `runnerId`'s identity hold the key `jkt` (a registration replay names the same key)? */
export async function runnerHoldsKey(db: Db, runnerId: string, jkt: string): Promise<boolean> {
  const [row] = await db
    .select({ id: workloadCredentials.id })
    .from(workloadCredentials)
    .innerJoin(workloadIdentities, eq(workloadIdentities.id, workloadCredentials.identityId))
    .where(and(eq(workloadIdentities.engineRunnerId, runnerId), eq(workloadCredentials.jwkThumbprint, jkt)));
  return !!row;
}

/**
 * Verify a re-enrolling runner's SUPERSEDE proof: signed by a LIVE registered
 * key (`kid` = its thumbprint: not revoked, inside its window now, so a key
 * already rotated out or expired proves nothing) of an ACTIVE identity of a
 * live runner of `engineId`, naming exactly the new key (`jkt`), `aud` this
 * issuer, at most 5 minutes old, and used ONCE (its `jti` is claimed in the
 * replay store). Returns that runner's id, or null (an unprovable claim
 * supersedes nothing, as an unknown token did).
 */
export async function verifySupersedeProof(db: Db, jws: string, engineId: string, newJkt: string, now: Date): Promise<string | null> {
  const issuer = identityIssuer();
  if (!issuer) return null;
  let kid: unknown;
  let alg: unknown;
  try {
    ({ kid, alg } = decodeProtectedHeader(jws));
  } catch {
    return null;
  }
  if (typeof alg !== "string" || !(WORKLOAD_PROOF_ALGS as readonly string[]).includes(alg)) return null;
  if (typeof kid !== "string" || kid.length !== 43) return null;
  const [cred] = await db
    .select({ publicJwk: workloadCredentials.publicJwk, runnerId: workloadIdentities.engineRunnerId })
    .from(workloadCredentials)
    .innerJoin(workloadIdentities, eq(workloadIdentities.id, workloadCredentials.identityId))
    .where(
      and(
        eq(workloadCredentials.jwkThumbprint, kid),
        isNull(workloadCredentials.revokedAt),
        // live NOW, on the database clock: a rotated-out (not_after moved to the rotation) or expired key proves nothing
        sql`${workloadCredentials.notBefore} <= now() AND ${workloadCredentials.notAfter} > now()`,
        eq(workloadIdentities.kind, "engine_runner"),
        eq(workloadIdentities.status, "active"),
      ),
    );
  if (!cred?.publicJwk || !cred.runnerId) return null;
  const j = cred.publicJwk as unknown as JWK;
  let jti: string;
  let exp: number;
  try {
    // the key is imported for the alg the proof names (EdDSA or Ed25519 for an Ed25519 key, ES256 for P-256): a
    // label that does not fit the registered key fails the import, and the proof with it
    if ((j.kty === "OKP") !== (alg === "EdDSA" || alg === "Ed25519")) return null;
    const { payload } = await jwtVerify(jws, await importJWK(j, alg), {
      algorithms: [...WORKLOAD_PROOF_ALGS],
      typ: RUNNER_SUPERSEDE_PROOF_TYP,
      audience: issuer,
      currentDate: now,
      requiredClaims: ["iat", "jti", "aud"],
    });
    const nowS = Math.floor(now.getTime() / 1000);
    if (payload.jkt !== newJkt || payload.iat! < nowS - CLIENT_ASSERTION_MAX_AGE_SECONDS || payload.iat! > nowS + DPOP_PROOF_MAX_FUTURE_SECONDS) return null;
    if (typeof payload.jti !== "string" || payload.jti.length === 0 || payload.jti.length > 200) return null;
    jti = payload.jti;
    exp = payload.iat! + CLIENT_ASSERTION_MAX_AGE_SECONDS + DPOP_PROOF_MAX_FUTURE_SECONDS;
  } catch {
    return null;
  }
  // one use: the existing replay store (decision 14), keyed apart from client assertions by its prefix
  if (!(await claimReplay(db, "client_assertion", `runner-supersede:${kid}:${jti}`, new Date(exp * 1000)))) return null;
  const [runner] = await db
    .select({ id: engineRunners.id })
    .from(engineRunners)
    .where(and(eq(engineRunners.id, cred.runnerId), eq(engineRunners.engineId, engineId as typeof engineRunners.$inferSelect.engineId), isNull(engineRunners.revokedAt)));
  return runner?.id ?? null;
}

/**
 * Verify a rotation PROOF: a compact JWS signed by the NEW key itself (its
 * public half in the `jwk` header, equal to `publicJwk`), `typ`
 * `regulait-key-rotation+jwt`, `aud` = the rotation route under the issuer,
 * `iat` fresh. Possession of the new key; nobody rotates a runner onto a key
 * it does not hold.
 */
export async function rotationProofValid(
  proof: string,
  publicJwk: WorkloadPublicJwk,
  issuer: string,
  now: Date,
  newJkt: string,
  /** ADR-0195 SD4b: the endpoint agent rotates on its own route, which is then the proof's `aud` */
  path: string = RUNNER_KEY_ROTATION_PATH,
): Promise<boolean> {
  try {
    const { payload, protectedHeader } = await jwtVerify(proof, EmbeddedJWK, {
      algorithms: [...WORKLOAD_PROOF_ALGS],
      typ: KEY_ROTATION_PROOF_TYP,
      audience: `${issuer}${path}`,
      currentDate: now,
      requiredClaims: ["iat"],
    });
    if (!protectedHeader.jwk || (await calculateJwkThumbprint(protectedHeader.jwk, "sha256")) !== newJkt) return false;
    if (typeof payload.aud !== "string") return false;
    const nowS = Math.floor(now.getTime() / 1000);
    return payload.iat! >= nowS - CLIENT_ASSERTION_MAX_AGE_SECONDS && payload.iat! <= nowS + DPOP_PROOF_MAX_FUTURE_SECONDS && publicJwk.kty === protectedHeader.jwk.kty;
  } catch {
    return false;
  }
}

/**
 * The core of a workload's own key rotation (decision 12), inside the caller's
 * transaction: lock the identity, require the authenticating key to be live
 * now, apply the two-live-key cap, bind the new key and end the old key's
 * window. Shared by the runner route and, in ADR-0195 SD4b, by the endpoint
 * agent's `POST /v1/endpoint-agent/credentials`. The caller audits.
 */
export async function rotateWorkloadKeyTx(
  t: Db,
  identityId: string,
  oldCredentialId: string,
  prepared: PreparedCredential,
  now: Date,
): Promise<{ bound: WorkloadCredentialView; retired: { id: string } | undefined } | IdentityAdminError> {
  // one rotation at a time per identity: the identity row is locked FOR UPDATE, so a concurrent rotation waits and
  // then re-reads the authenticating key below, which the first one has already rotated out
  const [ident] = await t.select().from(workloadIdentities).where(eq(workloadIdentities.id, identityId)).for("update");
  if (!ident || ident.status !== "active") return new IdentityAdminError("identity_not_active", 409, "this workload's identity is not active");
  // the key this request authenticated with must still be LIVE, on the database clock (clock_timestamp, not the
  // transaction's start: a rotation that waited on the lock sees the moment it runs). A token whose key was
  // already rotated out rotates nothing: any number of live keys is what decision 12 rules out.
  const [current] = await t
    .select({ id: workloadCredentials.id })
    .from(workloadCredentials)
    .where(
      and(
        eq(workloadCredentials.id, oldCredentialId),
        eq(workloadCredentials.identityId, identityId),
        isNull(workloadCredentials.revokedAt),
        sql`${workloadCredentials.notAfter} > clock_timestamp()`,
      ),
    )
    .for("update");
  if (!current) return new IdentityAdminError("credential_not_live", 409, "the key this token was issued to is no longer live (already rotated, expired or revoked)");
  // at most RUNNER_MAX_LIVE_KEYS during the overlap: the authenticating key and the new one (the same cap the
  // admin bind route applies)
  const limit = await runnerKeyLimitRefusal(t, identityId);
  if (limit) return limit;
  const bound = await bindPreparedCredentialTx(t, identityId, prepared, RUNNER_ACTOR_ID, now);
  if (bound instanceof IdentityAdminError) return bound;
  // decision 12: rotation is not revocation. The old key's window ends now (it mints nothing new); tokens it
  // already authenticated live to their own expiry. Database clock, never before the row's own start.
  const [retired] = await t
    .update(workloadCredentials)
    .set({ notAfter: sql`LEAST(${workloadCredentials.notAfter}, GREATEST(clock_timestamp(), ${workloadCredentials.notBefore} + interval '1 microsecond'))` })
    .where(and(eq(workloadCredentials.id, oldCredentialId), eq(workloadCredentials.identityId, identityId), isNull(workloadCredentials.revokedAt)))
    .returning({ id: workloadCredentials.id });
  return { bound, retired };
}

async function auditRotation(db: Db, identityId: string, effect: "allow" | "deny", detail: Record<string, unknown>, reason: string) {
  await db.insert(auditLog).values({
    userId: RUNNER_ACTOR_ID,
    objectType: "workload_identity",
    objectId: identityId,
    detail: { phase: "runner_key_rotation", ...detail },
    effect,
    ruleId: effect === "allow" ? "engine-runner-key-rotated" : "engine-runner-key-rotation-refused",
    ruleChain: [],
    reason,
  });
}

/** `POST /v1/engine-runner/credentials` — the runner rotates its own key (runner self token only, ENGINE_RUNNER_ROUTES) */
export function registerRunnerKeyRotationRoute(app: FastifyInstance, db: Db): void {
  app.post(RUNNER_KEY_ROTATION_PATH, async (req, reply) => {
    const identityId = req.authCtx.workloadIdentityId;
    const oldCredentialId = req.authCtx.workloadCredentialId;
    if (req.authCtx.via !== "engine-runner" || !identityId || !oldCredentialId) {
      return reply.status(401).send({ error: "engine_runner_token_required" });
    }
    const parsed = engineRunnerKeyRotationSchema.safeParse(req.body);
    if (!parsed.success) {
      await auditRotation(db, identityId, "deny", { code: "request_invalid" }, "a runner's key rotation request was malformed (ADR-0188 S7)");
      return reply.status(400).send({ error: "validation", detail: "send {publicJwk, proof}: the new public key and a JWS the new key signed" });
    }
    const issuer = identityIssuer();
    if (!issuer) return reply.status(503).send({ error: "issuer_not_configured" });
    const now = await databaseNow(db);
    const prepared = await prepareRunnerKey(parsed.data.publicJwk, now);
    if (prepared instanceof IdentityAdminError) {
      await auditRotation(db, identityId, "deny", { code: prepared.code }, "a runner offered an invalid key for rotation (ADR-0188 S7)");
      return reply.status(prepared.status).send({ error: prepared.code, detail: prepared.message });
    }
    const newJkt = await runnerKeyThumbprint(prepared);
    if (!(await rotationProofValid(parsed.data.proof, parsed.data.publicJwk, issuer, now, newJkt))) {
      await auditRotation(db, identityId, "deny", { code: "rotation_proof_invalid", newThumbprint: newJkt }, "a runner's key rotation proof did not prove the new key (ADR-0188 S7)");
      return reply.status(401).send({ error: "rotation_proof_invalid", detail: "the proof must be a fresh JWS signed by the NEW key, typ regulait-key-rotation+jwt, aud this route" });
    }
    const out = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const rotated = await rotateWorkloadKeyTx(t, identityId, oldCredentialId, prepared, now);
      if (rotated instanceof IdentityAdminError) return rotated;
      const { bound, retired } = rotated;
      await auditRotation(
        t,
        identityId,
        "allow",
        { newCredentialId: bound.id, newThumbprint: newJkt, retiredCredentialId: retired?.id ?? null, notAfter: bound.notAfter },
        `engine runner ${req.authCtx.engineRunnerId} rotated its key: a new credential until ${bound.notAfter}, the old key mints no new token (ADR-0188 decision 12)`,
      );
      return { credentialId: bound.id, notAfter: bound.notAfter, retiredCredentialId: retired?.id ?? null };
    });
    if (out instanceof IdentityAdminError) {
      await auditRotation(db, identityId, "deny", { code: out.code, newThumbprint: newJkt }, `a runner's key rotation was refused: ${out.code} (ADR-0188 S7)`);
      return reply.status(out.status).send({ error: out.code, detail: out.message });
    }
    return reply.status(201).send(out);
  });
}
