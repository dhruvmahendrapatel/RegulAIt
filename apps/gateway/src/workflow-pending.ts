/**
 * ADR-0349 slice 5 (lane E30, Temporal's "pending activities" view): what one workflow instance is waiting for, in a
 * form a person, the UI and an agent read the same way. `GET /v1/workflows/instances/:id/pending` answers it.
 *
 * Read-only and derived on read from the instance row, its pending approvals and its retry job: no new state, so it
 * cannot drift from what the engine does. `waitingOn` is a closed vocabulary with one plain sentence each:
 *
 *   approval        a sign-off is pending (the approvers are named)
 *   artifact        an artifact must be submitted (the output is named)
 *   plan            plan-only mode (ADR-0079): the plan must be completed
 *   trigger         a person must trigger the stage
 *   execution       an executor holds the stage now (claim, lease expiry)
 *   retry           an automatic retry is queued (attempt, next run)
 *   check_report    named checks wait for their reports
 *   advance         the stage failed and waits for /advance (the error is shown)
 *   check_failed    a required check failed: remediate, then recheck
 *   deploy_handoff  a deploy waits for a manual handoff decision
 *   nothing         the instance has ended
 */
import { and, approvals, eq, sql, type Db } from "@regulait/db";
import { isWorkflowTerminalStatus } from "@regulait/shared";
import type { InstanceState, WorkflowDefinition } from "@regulait/workflow-kernel";
import { STAGE_RETRY_QUEUE, stageExecutionKey } from "./workflows-queue.js";

export const PENDING_WORK_VERSION = 1;

export const WAITING_ON = [
  "approval",
  "artifact",
  "plan",
  "trigger",
  "execution",
  "retry",
  "check_report",
  "advance",
  "check_failed",
  "deploy_handoff",
  "nothing",
] as const;
export type WaitingOn = (typeof WAITING_ON)[number];

export interface PendingInstanceRow {
  id: string;
  status: string;
  definition: unknown;
  state: unknown;
  context: Record<string, unknown>;
  round: number;
  stageEntry: number;
}

export interface RetryJobState {
  state: string;
  /** the attempt the next run is (1 = the first automatic retry) */
  attempt: number;
  maxAttempts: number;
  nextRunAt: string | null;
}

export interface PendingWorkInput {
  row: PendingInstanceRow;
  now: Date;
  leaseMs: number;
  retry: RetryJobState | null;
  pendingApprovers: string[];
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** the pending-work view (pure) */
export function describePendingWork(input: PendingWorkInput) {
  const { row, now, leaseMs, retry } = input;
  const def = row.definition as WorkflowDefinition;
  const state = row.state as InstanceState;
  const stage = def.stages[state.currentStageIndex];
  const ctx = row.context ?? {};
  const terminal = isWorkflowTerminalStatus(row.status);

  // the claim, judged exactly as stageClaimState does (renewal, else the claim time, against the lease)
  const claimedStage = str(ctx.executing);
  const lastBeat = str(ctx.executingRenewedAt) ?? str(ctx.executingSince);
  const beatMs = lastBeat ? Date.parse(lastBeat) : NaN;
  const claim =
    claimedStage && stage && claimedStage === stage.id
      ? {
          claimId: str(ctx.executingClaim),
          stageEntry: typeof ctx.executingEntry === "number" ? ctx.executingEntry : null,
          since: str(ctx.executingSince),
          renewedAt: str(ctx.executingRenewedAt),
          leaseExpiresAt: Number.isFinite(beatMs) ? new Date(beatMs + leaseMs).toISOString() : null,
          live:
            Number.isFinite(beatMs) &&
            now.getTime() - beatMs < leaseMs &&
            (typeof ctx.executingEntry !== "number" || ctx.executingEntry === row.stageEntry),
        }
      : null;

  const sla = stage ? (ctx[`sla:${stage.id}`] as { dueAt?: unknown; warnAt?: unknown } | undefined) : undefined;
  const deadline = sla && typeof sla === "object" ? { dueAt: str(sla.dueAt), warnAt: str(sla.warnAt) } : null;
  const lastError = str(ctx.lastError);

  let waitingOn: WaitingOn;
  let detail: string;
  if (terminal || !stage) {
    waitingOn = "nothing";
    detail = `the instance has ended (${row.status}); nothing is pending`;
  } else if (row.status === "blocked_on_approval") {
    waitingOn = "approval";
    detail = `sign-off '${stage.id}' is pending with ${input.pendingApprovers.length} approver(s); it resumes when they decide`;
  } else if (row.status === "blocked_on_artifact") {
    waitingOn = "artifact";
    detail = `stage '${stage.id}' waits for the artifact '${stage.output ?? "?"}' to be submitted`;
  } else if (row.status === "blocked_on_plan") {
    waitingOn = "plan";
    detail = `stage '${stage.id}' is in plan-only mode: complete the plan to continue (no changes are allowed until then)`;
  } else if (row.status === "awaiting_trigger") {
    waitingOn = "trigger";
    detail = `stage '${stage.id}' waits for a person to trigger it`;
  } else if (row.status === "blocked_on_check") {
    waitingOn = "check_failed";
    detail = `a required check of stage '${stage.id}' failed: fix the cause, then ask for a recheck`;
  } else if (row.status === "blocked_on_deploy") {
    waitingOn = "deploy_handoff";
    detail = `deploy stage '${stage.id}' waits for a manual handoff decision (override or abort)`;
  } else if (claim?.live) {
    waitingOn = "execution";
    detail = `an executor is running stage '${stage.id}' (its lease expires at ${claim.leaseExpiresAt})`;
  } else if (retry && (retry.state === "created" || retry.state === "retry" || retry.state === "active")) {
    waitingOn = "retry";
    detail = `stage '${stage.id}' failed and automatic retry ${retry.attempt} of ${retry.maxAttempts} is queued${retry.nextRunAt ? ` for ${retry.nextRunAt}` : ""}`;
  } else if (lastError) {
    waitingOn = "advance";
    detail = `stage '${stage.id}' failed (${lastError}) and waits for someone to advance it`;
  } else if (stage.type === "automated_check" && (stage.checks?.length ?? 0) > 0) {
    waitingOn = "check_report";
    detail = `stage '${stage.id}' waits for results of its named checks to be reported`;
  } else {
    waitingOn = "execution";
    detail = `stage '${stage.id}' is ready to run and waits for an executor`;
  }

  return {
    version: PENDING_WORK_VERSION,
    instanceId: row.id,
    status: row.status,
    round: row.round,
    stageEntry: row.stageEntry,
    currentStage: stage ? { id: stage.id, type: stage.type, index: state.currentStageIndex } : null,
    waitingOn,
    detail,
    pendingApprovers: row.status === "blocked_on_approval" ? input.pendingApprovers : [],
    claim,
    retry,
    deadline,
    lastError,
  };
}

/** the retry job of the instance's current stage execution, if one is queued or ran (ADR-0283/0284) */
export async function currentRetryJob(db: Db, row: PendingInstanceRow): Promise<RetryJobState | null> {
  const def = row.definition as WorkflowDefinition;
  const stage = def.stages[(row.state as InstanceState).currentStageIndex];
  if (!stage) return null;
  const key = stageExecutionKey({ instanceId: row.id, stageId: stage.id, round: row.round, entry: row.stageEntry });
  try {
    const res = (await db.execute(sql`
      SELECT state::text AS state, retry_count, retry_limit, start_after
      FROM regulait_queue.job
      WHERE name = ${STAGE_RETRY_QUEUE} AND singleton_key = ${key}
      ORDER BY created_on DESC
      LIMIT 1
    `)) as unknown as { rows: Array<{ state: string; retry_count: number; retry_limit: number; start_after: Date | string | null }> };
    const j = res.rows[0];
    if (!j) return null;
    return {
      state: j.state,
      attempt: Number(j.retry_count) + 1,
      maxAttempts: Number(j.retry_limit) + 1,
      nextRunAt: j.start_after ? new Date(j.start_after).toISOString() : null,
    };
  } catch {
    // the queue schema is installed by our journal; a read failure is reported as "no retry known", never as a 500
    return null;
  }
}

/** the approvers a pending sign-off of the current stage waits on */
export async function pendingApproversOf(db: Db, row: PendingInstanceRow): Promise<string[]> {
  const def = row.definition as WorkflowDefinition;
  const stage = def.stages[(row.state as InstanceState).currentStageIndex];
  if (!stage || row.status !== "blocked_on_approval") return [];
  const rows = await db
    .select({ approver: approvals.approverUserId })
    .from(approvals)
    .where(and(eq(approvals.instanceId, row.id), eq(approvals.stageId, stage.id), eq(approvals.status, "pending")));
  return [...new Set(rows.map((r) => r.approver).filter((a): a is string => typeof a === "string"))].sort();
}
