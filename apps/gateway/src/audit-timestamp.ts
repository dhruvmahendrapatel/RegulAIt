/**
 * ADR-0186 S — RFC 3161 TRUSTED TIMESTAMPS ON AUDIT ANCHORS (slice S, Codex).
 * FOUNDATION STUB.
 *
 * The seam: `audit-chain.ts` calls `anchorTimestamper.afterFlush(db, …)` after
 * every anchor flush attempt (capture and buffered flush alike; boot uses the
 * same functions). The foundation's timestamper does nothing, so every anchor
 * keeps `tsa_status = 'not_configured'`. Slice S fills this module: with
 * `REGULAIT_TSA_URL` (egress allow-listed, pinned fetch), `REGULAIT_TSA_TRUST_BUNDLE`
 * and optional `REGULAIT_TSA_POLICY_OID`, a pkijs `TimeStampReq` over the
 * anchor's canonical bytes (nonce, certReq) is sent and the response verified
 * (granted, imprint and nonce match, ESS signing-certificate binding, chain to
 * the bundle, timeStamping EKU) into the `audit_anchors.tsa_*` columns; failures
 * retry with backoff in `anchor-timestamp-sweep`.
 *
 * Routes (admin-only):
 *   POST /v1/audit/anchors/:anchorId/timestamp        — retry now
 *   GET  /v1/audit/anchors/:anchorId/timestamp.tsr    — DER `application/timestamp-reply`
 * `GET /v1/audit/anchors` rows gain `timestamp: {status, genTime, tsaUrl, serial,
 * policyOid, verified}` (slice S edits that handler's mapping in audit-chain.ts
 * under "To Claude", or exports a row mapper this module owns).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "@regulait/db";
import { BATCH4_NOT_BUILT } from "@regulait/shared";
import type { AnchorTimestamper } from "./audit-chain.js";
import type { SchedulerJobDefinition } from "./scheduler.js";

export const ANCHOR_TIMESTAMP_JOB_NAME = "anchor-timestamp-sweep";

/** the seam audit-chain.ts calls after each anchor flush. Foundation: no-op. */
export const anchorTimestamper: AnchorTimestamper = {
  async afterFlush() {
    // slice S: request, verify and record an RFC 3161 token for this anchor
  },
};

export interface AnchorTimestampSweepResult {
  attempted: number;
  granted: number;
  failed: number;
  state: "not_built" | "not_configured" | "off" | "active";
}

/** retry pending / failed timestamps whose backoff has come due. Foundation: nothing. */
export async function runAnchorTimestampSweep(
  _db: Db,
  _opts: { now: Date } = { now: new Date() },
): Promise<AnchorTimestampSweepResult> {
  return { attempted: 0, granted: 0, failed: 0, state: "not_built" };
}

export function anchorTimestampJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: ANCHOR_TIMESTAMP_JOB_NAME,
      description:
        "ADR-0186 S: obtain an RFC 3161 timestamp from the configured time-stamping authority for audit anchors that " +
        "have none yet, retrying failures with backoff. Not built yet: requests nothing.",
      adr: "ADR-0186",
      defaultIntervalSeconds: 5 * 60,
      run: async (ctx) => {
        const out = await runAnchorTimestampSweep(ctx.db, { now: ctx.now });
        return { itemsProcessed: out.attempted, detail: { ...out } };
      },
    },
  ];
}

export function registerAuditTimestampRoutes(app: FastifyInstance, _db: Db): void {
  const notBuilt = async (_req: unknown, reply: FastifyReply) => reply.status(501).send(BATCH4_NOT_BUILT);
  app.post("/v1/audit/anchors/:anchorId/timestamp", notBuilt);
  app.get("/v1/audit/anchors/:anchorId/timestamp.tsr", notBuilt);
}
