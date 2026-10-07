/**
 * ADR-0186 B — PASSKEY-SIGNED APPROVALS (slice B, Claude). FOUNDATION STUB.
 *
 *   POST /v1/approvals/:approvalId/signing-options  (eligible approver)
 *        {decision} → {challengeId, options, signedPayload}
 *
 * The signed payload and challenge are `approvalSigningPayload` /
 * `approvalSigningChallenge` (`@regulait/shared` approval-signing.ts); the
 * challenge row is a `webauthn_challenges` row with purpose `approval_sign`,
 * claimed once through `consumeWebauthnChallenge` (step-up.ts). The extended
 * `POST /v1/approvals/:approvalId/decide` (`passkey: {challengeId, response}`)
 * and the execution-time recheck in `consumeBoundApproval` are slice B's.
 */
import type { FastifyInstance } from "fastify";
import type { Db } from "@regulait/db";
import { BATCH4_NOT_BUILT } from "@regulait/shared";

export function registerApprovalSigningRoutes(app: FastifyInstance, _db: Db): void {
  app.post("/v1/approvals/:approvalId/signing-options", async (_req, reply) =>
    reply.status(501).send(BATCH4_NOT_BUILT),
  );
}
