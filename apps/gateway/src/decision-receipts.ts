/**
 * ADR-0186 R — SIGNED DECISION RECEIPTS (slice R, Codex). FOUNDATION STUB.
 *
 * The foundation registers every §4.9 receipts route here answering 501
 * `{error: "not_built"}`, and the one-writer sweep `decision-receipt-sign-sweep`
 * (scheduler-jobs.ts spreads `decisionReceiptJobDefinitions`) as a no-op. Slice
 * R fills this module: the sweep (advisory lock, audit-seq order, idempotent)
 * signs `DecisionReceiptPayload`s (shared batch4.ts) with Ed25519 from
 * `REGULAIT_RECEIPT_SIGNING_KEY` / `_KEY_ID` into `decision_receipts`, records
 * the public key in `receipt_signing_keys`, and the routes read and verify them.
 * Receipt-bearing audit rows: `RECEIPT_OBJECT_TYPES`.
 *
 * Routes (admin-only, the gateway's default gate):
 *   GET  /v1/receipts?fromSeq&limit · GET /v1/receipts/:auditId
 *   GET  /v1/receipts/status · GET /v1/receipts/keys
 *   GET  /v1/receipts/export?fromSeq&toSeq (audited)
 *   POST /v1/receipts/verify
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@regulait/db";
import { BATCH4_NOT_BUILT } from "@regulait/shared";
import type { SchedulerJobDefinition } from "./scheduler.js";

export const DECISION_RECEIPT_SIGN_JOB_NAME = "decision-receipt-sign-sweep";

export interface DecisionReceiptSweepResult {
  /** receipts written this pass */
  signed: number;
  /** "not_built" until slice R lands; then the `ReceiptSigningState` */
  state: "not_built" | "signing" | "no_key" | "off";
}

/** the one-writer signing pass. Foundation: signs nothing. */
export async function runDecisionReceiptSignSweep(
  _db: Db,
  _opts: { now: Date } = { now: new Date() },
): Promise<DecisionReceiptSweepResult> {
  return { signed: 0, state: "not_built" };
}

export function decisionReceiptJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: DECISION_RECEIPT_SIGN_JOB_NAME,
      description:
        "ADR-0186 R: sign a receipt for every governed-call and approval decision on the audit chain, in audit order, " +
        "with the deployment's Ed25519 receipt key (one writer at a time). Not built yet: signs nothing.",
      adr: "ADR-0186",
      defaultIntervalSeconds: 60,
      run: async (ctx) => {
        const out = await runDecisionReceiptSignSweep(ctx.db, { now: ctx.now });
        return { itemsProcessed: out.signed, detail: { ...out } };
      },
    },
  ];
}

export function registerDecisionReceiptRoutes(app: FastifyInstance, _db: Db, _opts: { dataKey?: string } = {}): void {
  const notBuilt = async (_req: unknown, reply: FastifyReply) => reply.status(501).send(BATCH4_NOT_BUILT);
  app.get("/v1/receipts", notBuilt);
  app.get("/v1/receipts/status", notBuilt);
  app.get("/v1/receipts/keys", notBuilt);
  app.get("/v1/receipts/export", notBuilt);
  app.post("/v1/receipts/verify", notBuilt);
  app.get("/v1/receipts/:auditId", notBuilt);
}
