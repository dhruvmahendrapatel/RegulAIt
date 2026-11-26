/**
 * ADR-0349 slice 3 (lane E30, Temporal's activity heartbeat): an executor renews its stage claim while the stage, or
 * the provider call inside it, runs, so a short lease detects a dead worker fast and a live but slow one keeps its
 * claim. This narrows the REL-06 double-effect window: before, a claim was only ever "taken N minutes ago", so a live
 * executor lost it to a takeover after the 15-minute TTL however busy it was.
 *
 * - **Lease.** `stageClaimTtlMs()` is the lease (`REGULAIT_WORKFLOW_CLAIM_LEASE_MS`, default 60 s, 15 s to 15 min;
 *   the older `REGULAIT_WORKFLOW_CLAIM_TTL_MS` is still read when the new one is unset). The claim is live while
 *   `executingRenewedAt` (else `executingSince`) is younger than it: `stageClaimState`, the one predicate.
 * - **Renewal.** Every third of the lease, one guarded UPDATE on the database clock: the instance must still be
 *   `awaiting_execution` at the same stage entry, and the claim must still be this executor's (`executingClaim`).
 *   A renewal that matches no row means the claim was lost: renewal stops, and the executor's result is discarded at
 *   commit by the existing claim guard (AER-048).
 * - **Schedule-to-close.** `REGULAIT_WORKFLOW_EXECUTION_MAX_MS` (default 2 h, 1 min to 24 h) bounds one execution from
 *   its claim, however often it renews. When it passes, the heartbeat stops renewing and commits `execution_failed`
 *   ("execution limit reached") under the same claim guard, so the stage's retry policy (ADR-0283) applies and the
 *   outcome is audited. The executor's late result, if any, is then discarded (its external-effect records are still
 *   salvaged by the discard path).
 */
import { and, eq, sql, workflowInstances, type Db } from "@regulait/db";
import { errLine } from "./err-serializer.js";

export const DEFAULT_CLAIM_LEASE_MS = 60_000;
export const CLAIM_LEASE_BOUNDS = { min: 15_000, max: 15 * 60_000 } as const;
export const DEFAULT_EXECUTION_MAX_MS = 2 * 60 * 60_000;
export const EXECUTION_MAX_BOUNDS = { min: 60_000, max: 24 * 60 * 60_000 } as const;

function boundedMs(raw: string | undefined, bounds: { min: number; max: number }): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= bounds.min && n <= bounds.max ? n : null;
}

/** the claim lease; an unset or out-of-bounds value falls back (new variable, then the legacy TTL, then 60 s) */
export function claimLeaseMs(env: NodeJS.ProcessEnv = process.env): number {
  return (
    boundedMs(env.REGULAIT_WORKFLOW_CLAIM_LEASE_MS, CLAIM_LEASE_BOUNDS) ??
    boundedMs(env.REGULAIT_WORKFLOW_CLAIM_TTL_MS, CLAIM_LEASE_BOUNDS) ??
    DEFAULT_CLAIM_LEASE_MS
  );
}

/** the schedule-to-close limit of one stage execution */
export function executionMaxMs(env: NodeJS.ProcessEnv = process.env): number {
  return boundedMs(env.REGULAIT_WORKFLOW_EXECUTION_MAX_MS, EXECUTION_MAX_BOUNDS) ?? DEFAULT_EXECUTION_MAX_MS;
}

export interface HeartbeatGuard {
  instanceId: string;
  stageId: string;
  entry: number;
  claimId: string;
}

export type RenewOutcome = "renewed" | "lost" | "limit";

/**
 * One renewal: the guarded UPDATE. `limit` = the claim is still this executor's but the execution is past its
 * schedule-to-close limit (nothing was written); `lost` = the claim is not this executor's any more.
 */
export async function renewStageClaim(db: Db, g: HeartbeatGuard, maxMs: number): Promise<RenewOutcome> {
  const ours = and(
    eq(workflowInstances.id, g.instanceId),
    eq(workflowInstances.status, "awaiting_execution"),
    eq(workflowInstances.stageEntry, g.entry),
    sql`${workflowInstances.context}->>'executing' = ${g.stageId}`,
    sql`${workflowInstances.context}->>'executingClaim' = ${g.claimId}`,
  );
  const renewed = await db
    .update(workflowInstances)
    .set({ context: sql`jsonb_set(${workflowInstances.context}, '{executingRenewedAt}', to_jsonb(now()))` })
    .where(
      and(
        ours,
        sql`(${workflowInstances.context}->>'executingSince')::timestamptz > now() - make_interval(secs => ${maxMs / 1000})`,
      ),
    )
    .returning({ id: workflowInstances.id });
  if (renewed.length > 0) return "renewed";
  const [still] = await db.select({ id: workflowInstances.id }).from(workflowInstances).where(ours);
  return still ? "limit" : "lost";
}

export interface ClaimHeartbeat {
  /** stop renewing and wait for a renewal in flight; idempotent */
  stop(): Promise<void>;
  /** the last renewal outcome (`renewed` until one says otherwise) */
  readonly state: RenewOutcome;
}

/**
 * Renew the claim every third of the lease until stopped. `onLimit` runs once, when the execution passes its
 * schedule-to-close limit; renewal stops before it runs. A renewal error is logged and retried on the next tick
 * (a database blip must not end a healthy execution; the lease decides if the blips last).
 */
export function startClaimHeartbeat(
  db: Db,
  g: HeartbeatGuard,
  onLimit: () => Promise<void>,
  opts: { leaseMs?: number; maxMs?: number } = {},
): ClaimHeartbeat {
  const leaseMs = opts.leaseMs ?? claimLeaseMs();
  const maxMs = opts.maxMs ?? executionMaxMs();
  let state: RenewOutcome = "renewed";
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  const tick = async () => {
    if (stopped) return;
    try {
      state = await renewStageClaim(db, g, maxMs);
    } catch (err) {
      console.error(`workflow claim renewal for ${g.instanceId}/${g.stageId} failed: ${errLine(err)}`);
      return;
    }
    if (state === "renewed") return;
    stopped = true;
    clearInterval(timer);
    if (state === "limit") await onLimit();
  };
  const timer = setInterval(() => {
    inFlight = inFlight.then(tick).catch((err) => {
      console.error(`workflow claim heartbeat for ${g.instanceId}/${g.stageId}: ${errLine(err)}`);
    });
  }, Math.max(1_000, Math.floor(leaseMs / 3)));
  timer.unref();
  return {
    get state() {
      return state;
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
