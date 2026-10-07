/**
 * ADR-0186 A/B — PASSKEYS (WebAuthn credentials; slice A, Claude). FOUNDATION
 * STUB: every route answers 501 `{error: "not_built"}`.
 *
 * Self (a signed-in user, session only):
 *   POST   /v1/auth/passkeys/registration-options  {} → {challengeId, options}  (step-up if one exists)
 *   POST   /v1/auth/passkeys                       {challengeId, response, label} → {id, label, createdAt, backedUp}
 *   GET    /v1/auth/passkeys                       → {passkeys:[{id, label, createdAt, lastUsedAt}]}
 *   PATCH  /v1/auth/passkeys/:passkeyId            {label}
 *   DELETE /v1/auth/passkeys/:passkeyId            (needs a passkey_manage step-up)
 * Admin:
 *   GET    /v1/users/:userId/passkeys · DELETE /v1/users/:userId/passkeys/:passkeyId (revoke, audited)
 *
 * WebAuthn is `@simplewebauthn/server` (pinned). RP ID = hostname of
 * `REGULAIT_PUBLIC_URL`; unset → 409 `passkey_rp_unconfigured`. Registration
 * must request `attestationType: "none"` and REFUSE any response whose
 * attestation format is not `none` BEFORE verification: verifying a
 * certificate-bearing attestation makes the library fetch the CRL URLs named
 * in the attacker-supplied certificate (an outbound request outside the egress
 * guard).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@regulait/db";
import { BATCH4_NOT_BUILT } from "@regulait/shared";

export function registerPasskeyRoutes(app: FastifyInstance, _db: Db): void {
  const notBuilt = async (_req: unknown, reply: FastifyReply) => reply.status(501).send(BATCH4_NOT_BUILT);
  app.post("/v1/auth/passkeys/registration-options", notBuilt);
  app.post("/v1/auth/passkeys", notBuilt);
  app.get("/v1/auth/passkeys", notBuilt);
  app.patch("/v1/auth/passkeys/:passkeyId", notBuilt);
  app.delete("/v1/auth/passkeys/:passkeyId", notBuilt);
  app.get("/v1/users/:userId/passkeys", notBuilt);
  app.delete("/v1/users/:userId/passkeys/:passkeyId", notBuilt);
}
