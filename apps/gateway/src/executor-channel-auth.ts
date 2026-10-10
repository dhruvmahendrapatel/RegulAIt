/**
 * ADR-0190 I3 — EXECUTOR CHANNEL AUTHENTICATION: the gateway's half of the one
 * adapter (`packages/sandbox-executor/src/channel-credential.ts` is the
 * other). Every executor-channel request carries one `Executor-Proof`
 * header, a one-use signed proof under a LIVE `jwk` credential of the
 * executor's ADR-0188 `worker_runtime` identity. Verified here, in this
 * order, each step failing closed with a short code (never key material):
 *
 *  1. header present; JOSE `typ` `regulait-executor-proof+jwt`; `alg` in the
 *     workload list (EdDSA, ES256); a `kid`;
 *  2. `iss` names a `worker_runtime` identity that is in service (S3's one
 *     predicate, `identityServiceFailure`) for this deployment's environment;
 *  3. the signature verifies under the credential whose thumbprint is `kid`,
 *     among the identity's LIVE credentials only (S5's `findWorkloadClient`,
 *     judged on the DATABASE clock); `sub` = `iss`; `aud` = the issuer;
 *  4. `htm` = this method; `htu` = this route's absolute URL under the issuer
 *     (no query); `bh` = base64url(SHA-256(the exact raw body, or ""));
 *  5. `iat` within 60 s and at most 5 s ahead, on the DATABASE clock (M-075);
 *  6. `jti` claimed once in `replay_claims` (namespace `executor_channel`),
 *     the atomic insert of ADR-0188 decision 14, in its own statement;
 *  7. the identity is registered as an executor (`executors` row), which is
 *     not `revoked`; `last_seen_at` is stamped `now()`.
 *
 * This is RFC 7523 client authentication carrying RFC 9449's request binding,
 * with no access token: ADR-0188 S5 issues tokens only from a human delegation
 * proof, which an executor does not have. When S7 gives service workloads a
 * token path, this file and the executor's credential change together.
 */
import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jose";
import { auditLog, eq, executors, sql, type Db, type ExecutorRow, type WorkloadCredentialRow } from "@regulait/db";
import {
  EXECUTOR_PROOF_ALGS,
  EXECUTOR_PROOF_CLAIM_SECONDS,
  EXECUTOR_PROOF_HEADER,
  EXECUTOR_PROOF_MAX_AGE_SECONDS,
  EXECUTOR_PROOF_MAX_FUTURE_SECONDS,
  EXECUTOR_PROOF_TYP,
  type ExecutorNext,
} from "@regulait/shared";
import { claimReplay } from "./delegated-token.js";
import { databaseNow, identityServiceFailure } from "./delegation.js";
import { findWorkloadClient, type WorkloadClient } from "./oauth/clients.js";
import { deploymentEnvironment, identityIssuer } from "./oauth/common.js";

export const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

export interface ExecutorAuth {
  client: WorkloadClient;
  credential: WorkloadCredentialRow;
  /** the executor row, or null when the identity is not registered as one (announce says so with 401) */
  executor: ExecutorRow | null;
  issuer: string;
  /** the database clock at this request */
  now: Date;
}

export type ExecutorAuthOutcome = { ok: true; auth: ExecutorAuth } | { ok: false; status: 401 | 403 | 503; code: string; next?: ExecutorNext };

const refuse = (status: 401 | 403 | 503, code: string, next?: ExecutorNext): ExecutorAuthOutcome => ({ ok: false, status, code, ...(next ? { next } : {}) });

export function executorBodyHash(raw: string | undefined): string {
  return createHash("sha256")
    .update(raw ?? "", "utf8")
    .digest("base64url");
}

/** the public JWK of a live `jwk` credential, as `jose` imports it */
function jwkOf(c: WorkloadCredentialRow): JWK | null {
  const j = c.publicJwk as unknown as Record<string, string> | null;
  if (!j) return null;
  return j.kty === "OKP" ? { kty: "OKP", crv: "Ed25519", x: j.x! } : { kty: "EC", crv: "P-256", x: j.x!, y: j.y! };
}

/**
 * Authenticate one executor-channel request. `rawBody` is the exact body as
 * received (the channel routes keep it as a string), or undefined.
 */
export async function authenticateExecutorRequest(db: Db, req: FastifyRequest, rawBody: string | undefined): Promise<ExecutorAuthOutcome> {
  const issuer = identityIssuer();
  if (!issuer) return refuse(503, "issuer_not_configured");
  const header = req.headers[EXECUTOR_PROOF_HEADER];
  const proof = typeof header === "string" ? header : Array.isArray(header) ? header[0] : undefined;
  if (!proof || proof.length > 8192) return refuse(401, "proof_missing");

  let kid: string;
  let alg: string;
  let iss: unknown;
  try {
    const h = decodeProtectedHeader(proof);
    if (h.typ !== EXECUTOR_PROOF_TYP || typeof h.kid !== "string" || !h.alg || !(EXECUTOR_PROOF_ALGS as readonly string[]).includes(h.alg)) return refuse(401, "proof_header");
    kid = h.kid;
    alg = h.alg;
    iss = decodeJwt(proof).iss;
  } catch {
    return refuse(401, "proof_malformed");
  }
  if (typeof iss !== "string") return refuse(401, "proof_issuer");

  const now = await databaseNow(db);
  const client = await findWorkloadClient(db, iss, now);
  if (!client) return refuse(401, "identity_unknown");
  if (client.identity.kind !== "worker_runtime") return refuse(401, "identity_not_worker_runtime");
  const service = identityServiceFailure({ ...client.identity, agentHaltedAt: null, agentLifecycle: null, agentEnabled: true, builderArchivedAt: null, runnerRevokedAt: null }, deploymentEnvironment());
  if (service) return refuse(401, service, service === "identity_revoked" ? "revoked" : undefined);
  if (!client.methods.has("private_key_jwt")) return refuse(401, "method_not_allowed");
  const credential = client.credentials.find((c) => c.kind === "jwk" && c.jwkThumbprint === kid);
  const jwk = credential ? jwkOf(credential) : null;
  if (!credential || !jwk) return refuse(401, "credential_unknown");

  let payload;
  try {
    const key = await importJWK(jwk, alg);
    payload = (
      await jwtVerify(proof, key, {
        issuer: iss,
        subject: iss,
        audience: issuer,
        typ: EXECUTOR_PROOF_TYP,
        algorithms: [alg],
        currentDate: now,
        clockTolerance: EXECUTOR_PROOF_MAX_FUTURE_SECONDS,
        maxTokenAge: `${EXECUTOR_PROOF_MAX_AGE_SECONDS}s`,
        requiredClaims: ["iat", "jti", "htm", "htu", "bh"],
      })
    ).payload;
  } catch {
    return refuse(401, "proof_invalid");
  }
  const path = new URL(req.url, "http://local").pathname;
  if (payload.htm !== req.method.toUpperCase()) return refuse(401, "proof_htm");
  if (payload.htu !== `${issuer}${path}`) return refuse(401, "proof_htu");
  if (payload.bh !== executorBodyHash(rawBody)) return refuse(401, "proof_body");
  const nowS = Math.floor(now.getTime() / 1000);
  // the library's window check used the database clock above; restated so a library default never widens it
  if (typeof payload.iat !== "number" || payload.iat > nowS + EXECUTOR_PROOF_MAX_FUTURE_SECONDS || payload.iat < nowS - EXECUTOR_PROOF_MAX_AGE_SECONDS) return refuse(401, "proof_stale");
  if (typeof payload.jti !== "string" || payload.jti.length < 8 || payload.jti.length > 128) return refuse(401, "proof_jti");
  const claimed = await claimReplay(db, "executor_channel", `${client.identity.id}:${payload.jti}`, new Date(now.getTime() + EXECUTOR_PROOF_CLAIM_SECONDS * 1000));
  if (!claimed) return refuse(401, "proof_replayed");

  const [executor] = await db.select().from(executors).where(eq(executors.workloadIdentityId, client.identity.id));
  if (executor?.status === "revoked") return refuse(403, "executor_revoked", "revoked");
  if (executor) await db.update(executors).set({ lastSeenAt: sql`now()`, updatedAt: sql`now()` }).where(eq(executors.id, executor.id));
  return { ok: true, auth: { client, credential, executor: executor ?? null, issuer, now } };
}

/** audit and send a channel refusal (codes and ids only) */
export async function sendExecutorRefusal(db: Db, reply: FastifyReply, out: Extract<ExecutorAuthOutcome, { ok: false }>, route: string): Promise<FastifyReply> {
  await db.insert(auditLog).values({
    userId: NO_IDENTITY,
    objectType: "executor",
    objectId: null,
    detail: { phase: "executor-channel-refused", code: out.code, route },
    effect: "deny",
    ruleId: "executor-channel-refused",
    ruleChain: [],
    reason: "an executor-channel request was refused (ADR-0190 decision 4; ADR-0188 decision 5)",
  });
  return reply.status(out.status).send({ error: out.code, ...(out.next ? { next: out.next } : {}) });
}
