/**
 * ADR-0187 B5-E — THE RUNNER CORE: engine runs from request to result.
 *
 *   create   POST /v1/engine-runs, a schedule, or a workflow `automated_check`
 *            binding. The person the run executes as must be entitled to the
 *            target (and judge) exactly as for POST /v1/redteam/runs; the run
 *            starts `queued`, or `awaiting_approval` when it uses an agentic,
 *            offensive or unclassified set, or its budget is over the org's
 *            threshold (owner decision 4).
 *   lease    a runner of the engine takes the oldest queued run. Only now is the
 *            run-scoped virtual key minted (owner decision 2): owner = the
 *            run-as person, allowed models = target + judge, the run's budget,
 *            expiry = the run deadline, purpose `engine`, pinned to the run's
 *            project. Entitlement is re-checked; a person gone or no longer
 *            entitled ends the run `not_run` with a stated reason.
 *   heartbeat extends the lease; answers `{cancel}`.
 *   result   the envelope is normalised by the shared, pure normaliser
 *            (not-clean semantics), each engine string through the one
 *            detection-scrub interface, the items stored, a completed agent run
 *            written into the red-team / eval ledgers, the raw report kept
 *            encrypted for the retention window, and the key revoked.
 *   cancel   ends the run at once and revokes its key: later calls get 401
 *            whether or not the runner stops; the runner learns on its next
 *            heartbeat.
 *   sweep    a passed deadline or an expired lease ends the run `timeout` and
 *            revokes its key; a queued run nobody leased in 24 hours ends
 *            `not_run`; raw reports past retention are deleted.
 *
 * The runner is never trusted to stop itself, to total its own results, or to
 * say what its items map to.
 *
 * Open-source check (ADR-0176): pg-boss and graphile-worker (MIT) are
 * Postgres job queues; neither fits, because the queue here IS the governed
 * evidence record (`engine_runs`, audited, linked to a key and an approval),
 * the consumer is an external container on an HTTP lease rather than a worker
 * in this process, and adopting one would keep a second copy of each run's
 * state. A lease is one `FOR UPDATE SKIP LOCKED` statement.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  agents,
  and,
  approvals,
  asc,
  auditLog,
  desc,
  engineRunItems,
  engineRunners,
  engineRuns,
  engineSchedules,
  engines,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  modelArtifacts,
  or,
  sql,
  usageEvents,
  users,
  virtualKeys,
  type Db,
  type EngineRunRow,
} from "@regulait/db";
import {
  BATCH5_NOT_BUILT,
  ENGINE_IDS,
  ENGINE_LEASE_TTL_SECONDS,
  ENGINE_QUEUE_TTL_SECONDS,
  ENGINE_RESULT_LIMITS,
  ENGINE_RUN_STATUSES,
  ENGINE_VIRTUAL_KEY_PURPOSE,
  cancelEngineRunSchema,
  canonicalJson,
  createEngineRunSchema,
  createEngineScheduleSchema,
  engineConfigNeedsApproval,
  engineHeartbeatSchema,
  engineResultEnvelopeSchema,
  evaluateRunnerSelfTest,
  isTerminalEngineRunStatus,
  normaliseEngineResult,
  promptfooConfigProblem,
  updateEngineScheduleSchema,
  type CreateEngineRunInput,
  type EngineId,
  type EngineLease,
  type EngineManifestEntry,
  type EngineResultEnvelope,
  type EngineRunNormalised,
  type EngineTaxonomy,
  type EngineTerminalRunStatus,
  type RunnerSelfTest,
} from "@regulait/shared";
import { z } from "zod";
import { auditEngine, gatewayBaseUrlOf, manifestOf, NO_IDENTITY, selfTestAdmitsEnable, syncEngineManifest, taxonomyOf, type EngineOptions } from "./engines.js";
import { engineDetectionScrub } from "./engine-scrub.js";
import { writeEngineRunLedgers } from "./engine-ledger.js";
import { agentConfigHash, buildAgentDecider } from "./evals.js";
import { assertProjectAttribution } from "./projects.js";
import { loadOrgSettings } from "./org-settings.js";
import { refuseRunStartWithoutLiteracy } from "./ai-literacy.js";
import { encryptSecret } from "./secrets.js";
import { engineKeyName, generateVirtualKeyToken } from "./virtual-keys.js";
import { AGENT_HEADER, PROJECT_HEADER } from "./compat-core.js";
import type { SchedulerJobDefinition } from "./scheduler.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type AgentRow = typeof agents.$inferSelect;

// ---------------------------------------------------------------------------
// Process-wide runtime (set once by registerEngineRunRoutes, like the retry
// policy): the schedule sweep and the workflow executor create runs too.
// ---------------------------------------------------------------------------

let runtime: EngineOptions = {};
export function setEngineRuntime(opts: EngineOptions): void {
  runtime = opts;
}
export function engineRuntime(): EngineOptions {
  return runtime;
}

export const ENGINE_SWEEP_JOB_NAME = "engine-run-sweep";
export const ENGINE_SCHEDULE_JOB_NAME = "engine-schedule-sweep";

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** revoke a run's key now (idempotent), audited with the cause */
export async function revokeRunKey(
  db: Db | Tx,
  run: Pick<EngineRunRow, "id" | "virtualKeyId" | "engineId" | "runAsUserId">,
  cause: string,
  actorUserId: string,
): Promise<boolean> {
  if (!run.virtualKeyId) return false;
  const revoked = await db
    .update(virtualKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(virtualKeys.id, run.virtualKeyId), isNull(virtualKeys.revokedAt)))
    .returning({ id: virtualKeys.id });
  if (revoked.length === 0) return false;
  await db.insert(auditLog).values({
    userId: actorUserId,
    objectType: "virtual_key",
    objectId: run.virtualKeyId,
    detail: { phase: "revoke", cause, engineRunId: run.id, engineId: run.engineId, ownerUserId: run.runAsUserId },
    effect: "allow",
    ruleId: "engine-run-key-revoked",
    ruleChain: [],
    reason: `engine run ${run.id} key revoked (${cause}): it authenticates nothing from this moment on`,
  });
  return true;
}

/** the spend of a run, read off the one ledger by the run's key */
async function runCostUsd(db: Db | Tx, virtualKeyId: string | null): Promise<number> {
  if (!virtualKeyId) return 0;
  const [row] = await db
    .select({ total: sql<number>`COALESCE(SUM(${usageEvents.costUsd}), 0)::float8` })
    .from(usageEvents)
    .where(eq(usageEvents.virtualKeyId, virtualKeyId));
  return Number(row?.total ?? 0);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export type CreateRunOutcome =
  | { ok: true; run: EngineRunRow; approvalId: string | null }
  | { ok: false; status: number; error: string; detail?: string };

export interface CreateRunContext {
  runAsUserId: string;
  isAdmin: boolean;
  trigger: "manual" | "workflow" | "scheduled";
  scheduleId?: string | null;
  workflow?: { instanceId: string; stageId: string; check: string; round: number } | null;
}

export function engineRunConfigHash(req: CreateEngineRunInput): string {
  return createHash("sha256")
    .update(canonicalJson({ engineId: req.engineId, target: req.target, config: req.config, trials: req.trials }))
    .digest("hex");
}

type RunRefusal = Extract<CreateRunOutcome, { ok: false }>;
async function entitlementRefusal(db: Db, userId: string, agentId: string, role: "target" | "judge"): Promise<RunRefusal | AgentRow> {
  const [a] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!a) return { ok: false, status: 404, error: role === "target" ? "unknown_agent" : "unknown_judge_agent" };
  const decide = await buildAgentDecider(db, userId);
  const decision = decide(a as AgentRow, "execute");
  if (decision.effect !== "allow") {
    await db.insert(auditLog).values({
      userId,
      objectType: "agent",
      objectId: a.id,
      detail: { phase: "engine-run-entitlement", role },
      effect: "deny",
      ruleId: decision.ruleId,
      ruleChain: decision.ruleChain,
      reason: decision.reason,
    });
    return { ok: false, status: 403, error: role === "target" ? "agent_not_entitled" : "judge_not_entitled", detail: decision.reason };
  }
  return a as AgentRow;
}

export interface PreparedEngineRun {
  manifest: EngineManifestEntry;
  targetAgent: AgentRow | null;
  judgeAgent: AgentRow | null;
  budgetUsd: number;
  timeoutSeconds: number;
  sensitive: boolean;
  overBudget: boolean;
  needsApproval: boolean;
  approverUserId: string | null;
}

/**
 * Every check a run request gets, with nothing written (PR #203 review [13]:
 * a schedule is validated by exactly this before it is stored): the engine on,
 * the target kind, the project, entitlement to target AND judge, attribution,
 * the budget ceiling, and an approver when one is needed.
 */
export async function validateEngineRunRequest(
  db: Db,
  input: CreateEngineRunInput,
  ctx: Pick<CreateRunContext, "runAsUserId" | "isAdmin">,
): Promise<RunRefusal | { ok: true; prepared: PreparedEngineRun }> {
  const opts = runtime;
  const manifest = manifestOf(opts)[input.engineId as EngineId];
  await syncEngineManifest(db, manifestOf(opts));
  const [engine] = await db.select().from(engines).where(eq(engines.id, input.engineId));
  if (!engine) return { ok: false, status: 404, error: "engine_not_found" };
  // PR #205 review round 4 [66]: an engine-specific shape check (a promptfoo strategy rewrites a
  // plugin's test cases, so a plan of strategies alone would run nothing)
  const configProblem = input.engineId === "promptfoo" ? promptfooConfigProblem(input.config.sets) : null;
  if (configProblem) return { ok: false, status: 422, error: "engine_config_invalid", detail: configProblem };
  if (!engine.enabled) {
    return { ok: false, status: 409, error: "engine_disabled", detail: `engine ${input.engineId} is off; an admin enables it after its runner self-test passes` };
  }
  const wantsArtifact = "artifactId" in input.target;
  if ((manifest.kind === "model_scan") !== wantsArtifact) {
    return {
      ok: false,
      status: 422,
      error: "engine_target_mismatch",
      detail: manifest.kind === "model_scan" ? "this engine scans an uploaded model artifact" : "this engine runs against an agent",
    };
  }
  let targetAgent: AgentRow | null = null;
  let judgeAgent: AgentRow | null = null;
  if ("agentId" in input.target) {
    if (!input.projectId) {
      return { ok: false, status: 422, error: "project_required", detail: "an engine run's model calls are pinned to a project; name the project to bill" };
    }
    const t = await entitlementRefusal(db, ctx.runAsUserId, input.target.agentId, "target");
    if ("ok" in t) return t;
    targetAgent = t;
    if (input.target.judgeAgentId) {
      const j = await entitlementRefusal(db, ctx.runAsUserId, input.target.judgeAgentId, "judge");
      if ("ok" in j) return j;
      judgeAgent = j;
    }
  } else {
    const [art] = await db.select({ id: modelArtifacts.id }).from(modelArtifacts).where(eq(modelArtifacts.id, input.target.artifactId));
    if (!art) return { ok: false, status: 404, error: "unknown_artifact" };
  }
  if (input.projectId) {
    const attribution = await assertProjectAttribution(db, input.projectId, ctx.runAsUserId, ctx.isAdmin);
    if (!attribution.ok) return { ok: false, status: attribution.status, error: attribution.error };
  }
  const org = await loadOrgSettings(db);
  const budgetUsd = input.budgetUsd ?? org.engineDefaultRunBudgetUsd;
  if (budgetUsd > engine.maxBudgetUsd) {
    return {
      ok: false,
      status: 422,
      error: "engine_budget_exceeds_ceiling",
      detail: `a ${input.engineId} run may spend at most $${engine.maxBudgetUsd.toFixed(2)}; asked for $${budgetUsd.toFixed(2)}`,
    };
  }
  const timeoutSeconds = Math.max(60, Math.min(engine.timeoutSeconds, org.engineMaxRunTimeoutMinutes * 60));
  const sensitive = org.engineSensitiveSetApproval && engineConfigNeedsApproval(manifest, input.config.sets);
  const overBudget = budgetUsd > org.engineRunApprovalThresholdUsd;
  const needsApproval = sensitive || overBudget;
  const approverUserId = needsApproval ? (input.approverUserId ?? org.infraApproverUserId ?? null) : null;
  if (needsApproval) {
    if (!approverUserId) {
      return {
        ok: false,
        status: 422,
        error: "engine_approver_required",
        detail:
          (sensitive ? "this run uses an agentic, offensive or unclassified set" : `this run's $${budgetUsd.toFixed(2)} budget is over the $${org.engineRunApprovalThresholdUsd.toFixed(2)} approval threshold`) +
          ", so it waits for approval: name approverUserId, or set a default approver in org settings",
      };
    }
    if (approverUserId === ctx.runAsUserId) {
      return { ok: false, status: 403, error: "caller_cannot_approve", detail: "the person a run executes as cannot approve it" };
    }
    const [approver] = await db.select({ id: users.id, disabledAt: users.disabledAt }).from(users).where(eq(users.id, approverUserId));
    if (!approver || approver.disabledAt) return { ok: false, status: 404, error: "unknown_approver" };
  }
  return {
    ok: true,
    prepared: { manifest, targetAgent, judgeAgent, budgetUsd, timeoutSeconds, sensitive, overBudget, needsApproval, approverUserId },
  };
}

/** create a run (every trigger comes through here) */
export async function createEngineRun(db: Db, input: CreateEngineRunInput, ctx: CreateRunContext): Promise<CreateRunOutcome> {
  const checked = await validateEngineRunRequest(db, input, ctx);
  if (!checked.ok) return checked;
  const { manifest, targetAgent, judgeAgent, budgetUsd, timeoutSeconds, sensitive, overBudget, needsApproval, approverUserId } = checked.prepared;
  const now = new Date();
  const configHash = engineRunConfigHash(input);
  const created = await db.transaction(async (tx) => {
    const [run] = await tx
      .insert(engineRuns)
      .values({
        engineId: input.engineId,
        engineVersion: manifest.version,
        status: needsApproval ? "awaiting_approval" : "queued",
        trigger: ctx.trigger,
        runAsUserId: ctx.runAsUserId,
        projectId: input.projectId ?? null,
        targetKind: targetAgent ? "agent" : "artifact",
        targetAgentId: targetAgent?.id ?? null,
        judgeAgentId: judgeAgent?.id ?? null,
        targetArtifactId: "artifactId" in input.target ? input.target.artifactId : null,
        config: input.config,
        configHash,
        trials: input.trials,
        budgetUsd,
        timeoutSeconds,
        scheduleId: ctx.scheduleId ?? null,
        workflowInstanceId: ctx.workflow?.instanceId ?? null,
        workflowStageId: ctx.workflow?.stageId ?? null,
        workflowCheckName: ctx.workflow?.check ?? null,
        workflowRound: ctx.workflow?.round ?? null,
        createdAt: now,
        queueExpiresAt: new Date(now.getTime() + ENGINE_QUEUE_TTL_SECONDS * 1000),
      })
      .returning();
    let approvalId: string | null = null;
    if (needsApproval) {
      const [a] = await tx
        .insert(approvals)
        .values({
          userId: ctx.runAsUserId,
          objectType: "engine_run",
          approverUserId: approverUserId!,
          projectId: input.projectId ?? null,
          // PR #203 review round 2 [21]: linked to its workflow instance, so ending
          // the instance supersedes it with the instance's other gates
          instanceId: ctx.workflow?.instanceId ?? null,
          stageId: `__engine_run__:${run!.id}`,
          status: "pending",
        })
        .returning({ id: approvals.id });
      approvalId = a!.id;
      await tx.update(engineRuns).set({ approvalId }).where(eq(engineRuns.id, run!.id));
    }
    return { run: { ...run!, approvalId }, approvalId };
  });
  await auditEngine(db, {
    userId: ctx.runAsUserId,
    objectType: "engine_run",
    objectId: created.run.id,
    ruleId: needsApproval ? "engine-run-queued-for-approval" : "engine-run-created",
    effect: needsApproval ? "require_approval" : "allow",
    detail: {
      engineId: input.engineId,
      trigger: ctx.trigger,
      target: input.target,
      sets: input.config.sets,
      budgetUsd,
      timeoutSeconds,
      configHash,
      approvalId: created.approvalId,
      sensitiveSet: sensitive,
      overBudget,
      ...(ctx.workflow ? { workflow: ctx.workflow } : {}),
      ...(ctx.scheduleId ? { scheduleId: ctx.scheduleId } : {}),
    },
    reason: needsApproval
      ? `${input.engineId} run queued for approval (${sensitive ? "sensitive set" : "budget over threshold"}); nothing runs until it is approved`
      : `${input.engineId} run queued (${ctx.trigger})`,
  });
  return { ok: true, run: created.run, approvalId: created.approvalId };
}

// ---------------------------------------------------------------------------
// End a run (every terminal path comes through here)
// ---------------------------------------------------------------------------

export interface FinishArgs {
  status: EngineTerminalRunStatus;
  errorCode: string | null;
  normalised: EngineRunNormalised;
  cause: string;
  actorUserId: string;
  envelope?: EngineResultEnvelope | null;
  rawReport?: { sha256: string; bytes: number; ciphertext: string | null; expiresAt: Date | null } | null;
  /** a runner's result: refused (the run times out) when the deadline or lease has passed */
  requireLive?: boolean;
}

/**
 * Move a run from one of `from` to a terminal status, revoke its key, store
 * the normalised items and (completed agent runs) the ledgers — one
 * transaction, compare-and-set on the status. Returns null when the run was
 * no longer in `from` (someone else ended it first).
 */
/** THE summary every terminal path stores (PR #203 review [15]: one shape, whatever ended the run) */
export function runSummary(n: EngineRunNormalised, cause: string, envelope: EngineResultEnvelope | null = null): Record<string, unknown> {
  return {
    verdict: n.verdict,
    counts: n.counts,
    // PR #205 review round 3 [61]: not-run items that are not declared planning-time exclusions
    runtimeNotRun: n.runtimeNotRun,
    mappedItems: n.mappedItems,
    unmappedItems: n.unmappedItems,
    asr: n.asr,
    asrInterval: n.asrInterval,
    asrTrials: n.asrTrials,
    measurementQuality: n.measurementQuality,
    classes: n.classes,
    taxonomyVersion: n.taxonomyVersion,
    explanation: n.explanation,
    engineReportedStatus: envelope?.status ?? null,
    engineErrorCode: n.engineErrorCode,
    cause,
  };
}

export async function finishEngineRun(db: Db, runId: string, from: readonly string[], given: FinishArgs): Promise<EngineRunRow | null> {
  const now = new Date();
  const out = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(engineRuns).where(eq(engineRuns.id, runId)).for("update");
    if (!locked || !from.includes(locked.status)) return null;
    return endLockedRun(tx, locked, given, now);
  });
  if (out && out.workflowInstanceId) await notifyWorkflowOfEngineRun(db, out);
  return out;
}

/** the terminal write itself, for a run the caller holds locked (`FOR UPDATE`) in `tx` */
async function endLockedRun(tx: Tx, locked: EngineRunRow, given: FinishArgs, now: Date) {
  const opts = runtime;
  const runId = locked.id;
  let args = given;
  // PR #203 review [8]: a result is accepted only while the run is live, decided
  // under the row lock — after the deadline or the lease the run is timed out
  // even when the sweep has not run yet; a late envelope never counts
  if (given.requireLive && locked.status === "leased") {
    const deadline = locked.deadlineAt !== null && locked.deadlineAt.getTime() <= now.getTime();
    const leaseGone = locked.leaseExpiresAt !== null && locked.leaseExpiresAt.getTime() <= now.getTime();
    if (deadline || leaseGone) {
      const cause = deadline ? "deadline_passed" : "lease_expired";
      args = { status: "timeout", errorCode: cause, normalised: noResult("timeout"), cause, actorUserId: given.actorUserId, envelope: null, rawReport: null };
    }
  }
  const costUsd = await runCostUsd(tx, locked.virtualKeyId);
  const summary = runSummary(args.normalised, args.cause, args.envelope ?? null);
  const [updated] = await tx
    .update(engineRuns)
    .set({
      status: args.status,
      errorCode: args.errorCode,
      finishedAt: now,
      costUsd,
      summary,
      ...(args.rawReport
        ? {
            rawReportSha256: args.rawReport.sha256,
            rawReportBytes: args.rawReport.bytes,
            rawReportCiphertext: args.rawReport.ciphertext,
            rawReportExpiresAt: args.rawReport.expiresAt,
          }
        : {}),
    })
    .where(eq(engineRuns.id, runId))
    .returning();
  await revokeRunKey(tx, locked, args.cause, args.actorUserId);
  const itemRows = args.normalised.items.map((it) => ({
      runId,
      key: it.key,
      sourceSystem: it.sourceSystem,
      sourceId: it.sourceId,
      attackClass: it.attackClass,
      scorerKind: it.scorerKind,
      claimedClass: it.claimedClass,
      severity: it.severity,
      attempts: it.attempts,
      defeated: it.defeated,
      claimedVerdict: it.claimedVerdict,
      verdict: it.verdict,
      reason: it.reason,
      verdictNote: it.verdictNote,
      notRunReason: it.notRunReason,
      dispatchAuditIds: it.dispatchAuditIds,
    }));
  for (let i = 0; i < itemRows.length; i += 500) await tx.insert(engineRunItems).values(itemRows.slice(i, i + 500));
  let ledgers: { evalRunId: string | null; redteamRunId: string | null } = { evalRunId: null, redteamRunId: null };
  if (args.status === "completed") {
    const kind = manifestOf(opts)[locked.engineId as EngineId].kind;
    ledgers = await writeEngineRunLedgers(tx, { run: { ...updated!, costUsd }, kind, normalised: args.normalised, finishedAt: now });
    if (ledgers.evalRunId || ledgers.redteamRunId) {
      await tx.update(engineRuns).set({ evalRunId: ledgers.evalRunId, redteamRunId: ledgers.redteamRunId }).where(eq(engineRuns.id, runId));
    }
  }
  await tx.insert(auditLog).values({
    userId: args.actorUserId,
    objectType: "engine_run",
    objectId: runId,
    detail: {
      engineId: locked.engineId,
      status: args.status,
      errorCode: args.errorCode,
      cause: args.cause,
      verdict: args.normalised.verdict,
      counts: args.normalised.counts,
      costUsd,
      rawReportSha256: args.rawReport?.sha256 ?? null,
      ...ledgers,
    },
    effect: args.status === "completed" ? "allow" : "deny",
    ruleId: args.envelope ? "engine-run-result-ingested" : `engine-run-${args.status.replace(/_/g, "-")}`,
    ruleChain: [],
    reason: `engine run ${runId} (${locked.engineId}) ended ${args.status}: ${args.normalised.explanation}`,
  });
  return { ...updated!, ...ledgers };
}

/**
 * PR #203 review round 2 [21]: a workflow that ends (aborted, denied,
 * completed, rolled back) or re-opens into a new round takes its live engine
 * runs with it — each is cancelled, its key revoked and its pending approval
 * superseded, in the caller's transaction (the one that holds the instance
 * row). `beforeRound` limits it to runs of earlier rounds (a re-open). The
 * workflow is not notified: it has already moved on.
 */
export async function cancelEngineRunsOfInstance(
  tx: Tx,
  instanceId: string,
  actorUserId: string | null,
  opts: { beforeRound?: number; cause: string },
): Promise<number> {
  const live = await tx
    .select()
    .from(engineRuns)
    .where(
      and(
        eq(engineRuns.workflowInstanceId, instanceId),
        inArray(engineRuns.status, ["awaiting_approval", "queued", "leased"]),
        ...(opts.beforeRound !== undefined ? [lt(engineRuns.workflowRound, opts.beforeRound)] : []),
      ),
    )
    .orderBy(asc(engineRuns.id))
    .for("update");
  const now = new Date();
  const actor = actorUserId ?? NO_IDENTITY;
  for (const run of live) {
    await tx.update(engineRuns).set({ cancelRequestedAt: now, cancelRequestedByUserId: actorUserId }).where(eq(engineRuns.id, run.id));
    await endLockedRun(tx, run, { status: "cancelled", errorCode: "workflow_ended", normalised: noResult("cancelled"), cause: opts.cause, actorUserId: actor }, now);
    await tx.update(engineRuns).set({ workflowNotifiedAt: now }).where(eq(engineRuns.id, run.id));
    if (run.approvalId) {
      await tx.update(approvals).set({ status: "superseded" }).where(and(eq(approvals.id, run.approvalId), eq(approvals.status, "pending")));
    }
  }
  return live.length;
}

/** an empty normalisation (no result): every reading is unknown or not run */
function noResult(status: EngineTerminalRunStatus): EngineRunNormalised {
  return normaliseEngineResult({ envelope: null, status, taxonomy: taxonomyOf(runtime), scrub: engineDetectionScrub });
}

/** end every leased run a revoked runner holds (DELETE /v1/engine-runners/:id) */
export async function endLeasedRunsOfRunner(db: Db, runnerId: string, actorUserId: string): Promise<number> {
  const held = await db
    .select({ id: engineRuns.id })
    .from(engineRuns)
    .where(and(eq(engineRuns.runnerId, runnerId), eq(engineRuns.status, "leased")));
  let n = 0;
  for (const r of held) {
    const done = await finishEngineRun(db, r.id, ["leased"], {
      status: "cancelled",
      errorCode: "runner_revoked",
      normalised: noResult("cancelled"),
      cause: "runner_revoked",
      actorUserId,
    });
    if (done) n += 1;
  }
  return n;
}

/** the decide path's hook for an `engine_run` approval (inside its transaction) */
export async function applyEngineRunApprovalDecision(
  tx: Tx,
  approval: { id: string },
  decision: "approved" | "denied",
  deciderUserId: string,
): Promise<((db: Db) => Promise<void>) | null> {
  const [run] = await tx.select().from(engineRuns).where(eq(engineRuns.approvalId, approval.id)).for("update");
  if (!run || run.status !== "awaiting_approval") return null;
  const now = new Date();
  if (decision === "approved") {
    await tx
      .update(engineRuns)
      .set({ status: "queued", queueExpiresAt: new Date(now.getTime() + ENGINE_QUEUE_TTL_SECONDS * 1000) })
      .where(eq(engineRuns.id, run.id));
    await tx.insert(auditLog).values({
      userId: deciderUserId,
      objectType: "engine_run",
      objectId: run.id,
      detail: { phase: "approval", approvalId: approval.id, decision },
      effect: "allow",
      ruleId: "engine-run-approved",
      ruleChain: [],
      reason: `engine run ${run.id} approved; it is queued for a runner`,
    });
    return null;
  }
  const n = noResult("not_run");
  await tx
    .update(engineRuns)
    .set({ status: "not_run", errorCode: "approval_denied", finishedAt: now, summary: runSummary(n, "approval_denied") })
    .where(eq(engineRuns.id, run.id));
  await tx.insert(auditLog).values({
    userId: deciderUserId,
    objectType: "engine_run",
    objectId: run.id,
    detail: { phase: "approval", approvalId: approval.id, decision },
    effect: "deny",
    ruleId: "engine-run-approval-denied",
    ruleChain: [],
    reason: `engine run ${run.id} was refused in the Approvals Queue and never ran`,
  });
  if (!run.workflowInstanceId) return null;
  return async (db: Db) => {
    await notifyWorkflowOfEngineRun(db, run);
  };
}

// ---------------------------------------------------------------------------
// Workflow binding (owner decision 4)
// ---------------------------------------------------------------------------

/** test seams (code only): a hook that runs before a workflow stage is told a run ended */
export const engineRunTestHooks: {
  beforeWorkflowNotify?: (runId: string) => void;
  /** runs after the lease route's pre-checks, before its transaction (PR #203 review round 2 [17]) */
  beforeLeaseTx?: (runnerId: string) => Promise<void> | void;
  /** runs after the self-test route's pre-checks, before its transaction (PR #205 review round 4 [65]) */
  beforeSelfTestTx?: (runnerId: string) => Promise<void> | void;
  /** runs just before a due schedule creates its run (PR #203 review round 2 [23]) */
  beforeScheduledCreate?: () => void;
} = {};

/**
 * A workflow-bound run ended: re-evaluate its check stage (lazy import:
 * workflows.ts imports this module). PR #203 review [5]: the hand-off is
 * DURABLE — `workflow_notified_at` is stamped only once the stage evaluated
 * (or is no longer the current one); a failure, or another executor holding
 * the stage, leaves it unset and the engine sweep tries again, so an ended run
 * can never leave its workflow waiting for ever.
 */
async function notifyWorkflowOfEngineRun(db: Db, run: Pick<EngineRunRow, "id" | "workflowInstanceId" | "workflowStageId">): Promise<boolean> {
  if (!run.workflowInstanceId || !run.workflowStageId) return true;
  try {
    engineRunTestHooks.beforeWorkflowNotify?.(run.id);
    const wf = await import("./workflows.js");
    await wf.reevaluateCheckStage(db, run.workflowInstanceId, run.workflowStageId, runtime.dataKey);
  } catch {
    return false; // retried by the sweep
  }
  await db.update(engineRuns).set({ workflowNotifiedAt: new Date() }).where(eq(engineRuns.id, run.id));
  return true;
}

export interface EngineCheckOutcome {
  check: string;
  status: "passed" | "failed" | "pending";
  severity: string | null;
  detail: string;
  engine: { runId: string | null; engineId: string; status: string; verdict: string | null };
}

/**
 * The outcome of every engine-bound check of a stage, starting each run on
 * first sight (as the instance initiator, on the instance's project, like an
 * eval binding). PENDING until the run ends; PASSED only when it completed
 * with verdict pass; FAILED when it failed, timed out, was cancelled, did not
 * run, could not be started, or completed with any failed or unknown item.
 */
export async function stageEngineCheckOutcomes(
  db: Db,
  instance: { id: string; initiatorUserId: string; projectId: string | null; round: number },
  stage: { id: string; checks?: string[]; engines?: Array<{ check: string; engine: string; agent: string; judgeAgent?: string; sets: string[]; params?: Record<string, string | number | boolean>; trials?: number; budgetUsd?: number }> },
): Promise<Map<string, EngineCheckOutcome>> {
  const out = new Map<string, EngineCheckOutcome>();
  const declared = new Set(stage.checks ?? []);
  for (const b of stage.engines ?? []) {
    if (!declared.has(b.check)) continue;
    const fail = (detail: string, runId: string | null, status: string): void => {
      out.set(b.check, { check: b.check, status: "failed", severity: "high", detail, engine: { runId, engineId: b.engine, status, verdict: null } });
    };
    let [run] = await db
      .select()
      .from(engineRuns)
      .where(
        and(
          eq(engineRuns.workflowInstanceId, instance.id),
          eq(engineRuns.workflowStageId, stage.id),
          eq(engineRuns.workflowCheckName, b.check),
          eq(engineRuns.workflowRound, instance.round),
        ),
      );
    if (!run) {
      const [agent] = await db.select({ id: agents.id }).from(agents).where(eq(agents.name, b.agent));
      const [judge] = b.judgeAgent ? await db.select({ id: agents.id }).from(agents).where(eq(agents.name, b.judgeAgent)) : [null];
      if (!agent || (b.judgeAgent && !judge)) {
        fail(`the engine check could not start: agent '${!agent ? b.agent : b.judgeAgent}' is not registered`, null, "not_run");
        continue;
      }
      const parsed = createEngineRunSchema.safeParse({
        engineId: b.engine,
        target: { agentId: agent.id, ...(judge ? { judgeAgentId: judge.id } : {}) },
        config: { sets: b.sets, params: b.params ?? {} },
        ...(instance.projectId ? { projectId: instance.projectId } : {}),
        ...(b.budgetUsd !== undefined ? { budgetUsd: b.budgetUsd } : {}),
        trials: b.trials ?? 3,
      });
      if (!parsed.success) {
        fail("the engine check could not start: its binding is not a valid run request", null, "not_run");
        continue;
      }
      // PR #203 review [9]: the initiator's CURRENT standing (an admin attributes
      // to any project, as on POST /v1/engine-runs); a person gone stays refused
      const [initiator] = await db.select({ isAdmin: users.isAdmin, disabledAt: users.disabledAt }).from(users).where(eq(users.id, instance.initiatorUserId));
      if (!initiator || initiator.disabledAt) {
        fail("the engine check could not start: the person who started this workflow is gone or deactivated", null, "not_run");
        continue;
      }
      const created = await createEngineRun(db, parsed.data, {
        runAsUserId: instance.initiatorUserId,
        isAdmin: initiator.isAdmin,
        trigger: "workflow",
        workflow: { instanceId: instance.id, stageId: stage.id, check: b.check, round: instance.round },
      }).catch((e: unknown) => {
        const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
        if (code === "23505") return null; // another executor created it first
        throw e;
      });
      if (created === null) {
        [run] = await db
          .select()
          .from(engineRuns)
          .where(
            and(
              eq(engineRuns.workflowInstanceId, instance.id),
              eq(engineRuns.workflowStageId, stage.id),
              eq(engineRuns.workflowCheckName, b.check),
              eq(engineRuns.workflowRound, instance.round),
            ),
          );
      } else if (!created.ok) {
        fail(`the engine check could not start: ${created.error}${created.detail ? ` — ${created.detail}` : ""}`, null, "not_run");
        continue;
      } else {
        run = created.run;
      }
    }
    if (!run) {
      fail("the engine check could not start", null, "not_run");
      continue;
    }
    const verdict = (run.summary as { verdict?: string } | null)?.verdict ?? null;
    const engine = { runId: run.id, engineId: run.engineId, status: run.status, verdict };
    if (!isTerminalEngineRunStatus(run.status)) {
      out.set(b.check, { check: b.check, status: "pending", severity: null, detail: `engine run ${run.id} is ${run.status}`, engine });
    } else if (run.status === "completed" && verdict === "pass") {
      out.set(b.check, { check: b.check, status: "passed", severity: null, detail: `engine run ${run.id} completed with no failed or unknown item`, engine });
    } else {
      out.set(b.check, {
        check: b.check,
        status: "failed",
        severity: "high",
        detail: `engine run ${run.id} ended ${run.status}${verdict ? ` (verdict ${verdict})` : ""}${run.errorCode ? `, ${run.errorCode}` : ""}: it does not pass`,
        engine,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sweeps (the runner is never trusted to stop itself)
// ---------------------------------------------------------------------------

export async function runEngineRunSweep(db: Db, opts: { now?: Date; actorUserId?: string | null } = {}) {
  const now = opts.now ?? new Date();
  const actor = opts.actorUserId ?? NO_IDENTITY;
  const out = { timedOut: 0, leaseExpired: 0, queueExpired: 0, rawReportsPurged: 0, workflowsNotified: 0 };
  const overdue = await db
    .select({ id: engineRuns.id, deadlineAt: engineRuns.deadlineAt, leaseExpiresAt: engineRuns.leaseExpiresAt })
    .from(engineRuns)
    .where(and(eq(engineRuns.status, "leased"), or(lt(engineRuns.deadlineAt, now), lt(engineRuns.leaseExpiresAt, now))))
    .limit(500);
  for (const r of overdue) {
    const deadline = r.deadlineAt !== null && r.deadlineAt < now;
    const done = await finishEngineRun(db, r.id, ["leased"], {
      status: "timeout",
      errorCode: deadline ? "deadline_passed" : "lease_expired",
      normalised: noResult("timeout"),
      cause: deadline ? "deadline_passed" : "lease_expired",
      actorUserId: actor,
    });
    if (done) {
      if (deadline) out.timedOut += 1;
      else out.leaseExpired += 1;
    }
  }
  const stale = await db
    .select({ id: engineRuns.id })
    .from(engineRuns)
    .where(and(eq(engineRuns.status, "queued"), lt(engineRuns.queueExpiresAt, now)))
    .limit(500);
  for (const r of stale) {
    const done = await finishEngineRun(db, r.id, ["queued"], {
      status: "not_run",
      errorCode: "no_runner",
      normalised: noResult("not_run"),
      cause: "no_runner",
      actorUserId: actor,
    });
    if (done) out.queueExpired += 1;
  }
  // PR #203 review [5]: workflow hand-offs that did not land are retried
  const unnotified = await db
    .select({ id: engineRuns.id, workflowInstanceId: engineRuns.workflowInstanceId, workflowStageId: engineRuns.workflowStageId })
    .from(engineRuns)
    .where(and(isNotNull(engineRuns.workflowInstanceId), isNotNull(engineRuns.finishedAt), isNull(engineRuns.workflowNotifiedAt)))
    .orderBy(asc(engineRuns.finishedAt))
    .limit(100);
  for (const r of unnotified) if (await notifyWorkflowOfEngineRun(db, r)) out.workflowsNotified += 1;
  // PR #203 review [6]: retention is the setting NOW, applied from when the run
  // ended — lowering it shortens reports already stored (the stored expiry can
  // only ever end one sooner, never keep one longer)
  const org = await loadOrgSettings(db);
  const purged = await db
    .update(engineRuns)
    .set({ rawReportCiphertext: null })
    .where(
      and(
        isNotNull(engineRuns.rawReportCiphertext),
        or(
          lt(engineRuns.rawReportExpiresAt, now),
          sql`COALESCE(${engineRuns.finishedAt}, ${engineRuns.createdAt}) + make_interval(days => ${org.engineRawReportRetentionDays}) < ${now.toISOString()}::timestamptz`,
        ),
      ),
    )
    .returning({ id: engineRuns.id });
  out.rawReportsPurged = purged.length;
  return out;
}

/** due schedules: each run executes as the person who configured it, or is skipped with a stated reason */
export async function runEngineScheduleSweep(db: Db, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const out = { started: 0, skipped: 0 };
  const due = await db
    .select()
    .from(engineSchedules)
    .where(and(eq(engineSchedules.enabled, true), lt(engineSchedules.nextRunAt, now)))
    .orderBy(asc(engineSchedules.nextRunAt))
    .limit(100);
  for (const s of due) {
    const next = new Date(now.getTime() + s.intervalHours * 3_600_000);
    const [claimed] = await db
      .update(engineSchedules)
      .set({ nextRunAt: next, updatedAt: now })
      .where(and(eq(engineSchedules.id, s.id), eq(engineSchedules.nextRunAt, s.nextRunAt)))
      .returning();
    if (!claimed) continue; // another sweep took it
    let skip: string | null = null;
    let runId: string | null = null;
    const [person] = s.runAsUserId
      ? await db.select({ id: users.id, disabledAt: users.disabledAt, isAdmin: users.isAdmin }).from(users).where(eq(users.id, s.runAsUserId))
      : [];
    const parsed = createEngineRunSchema.safeParse(s.request);
    if (!person || person.disabledAt) skip = "the person this schedule runs as is gone or deactivated";
    else if (!parsed.success) skip = "the stored run request is no longer valid";
    else if (engineRunConfigHash(parsed.data) !== s.configHash) skip = "the stored run request does not match its configuration hash";
    else {
      // PR #203 review round 2 [23]: the claim above is already committed, so a
      // creation that throws is recorded as an audited skip — a due run is
      // never lost silently
      try {
        engineRunTestHooks.beforeScheduledCreate?.();
        const created = await createEngineRun(db, parsed.data, { runAsUserId: person.id, isAdmin: person.isAdmin, trigger: "scheduled", scheduleId: s.id });
        if (created.ok) runId = created.run.id;
        else skip = `${created.error}${created.detail ? `: ${created.detail}` : ""}`;
      } catch (err) {
        skip = `the run could not be created: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    await db.update(engineSchedules).set({ lastRunId: runId ?? s.lastRunId, lastSkip: skip }).where(eq(engineSchedules.id, s.id));
    if (skip) {
      out.skipped += 1;
      await auditEngine(db, {
        userId: s.runAsUserId ?? NO_IDENTITY,
        objectType: "engine_schedule",
        objectId: s.id,
        ruleId: "engine-schedule-skipped",
        effect: "deny",
        detail: { engineId: s.engineId, skip },
        reason: `scheduled ${s.engineId} run skipped: ${skip}`,
      });
    } else out.started += 1;
  }
  return out;
}

export function engineJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: ENGINE_SWEEP_JOB_NAME,
      description:
        "End engine runs whose deadline passed or whose lease expired (status timeout) and revoke their keys; end queued " +
        "runs no runner took in 24 hours (not_run); delete raw engine reports past their retention. The kill switch does " +
        "not depend on it: a cancel revokes the key at once, and a key expires at the run deadline anyway.",
      adr: "ADR-0187",
      defaultIntervalSeconds: 60,
      run: async (ctx) => {
        const out = await runEngineRunSweep(ctx.db, { now: ctx.now, actorUserId: ctx.actorUserId });
        return { itemsProcessed: out.timedOut + out.leaseExpired + out.queueExpired, detail: { ...out } };
      },
    },
    {
      name: ENGINE_SCHEDULE_JOB_NAME,
      description:
        "Start due scheduled engine runs, each as the person who configured it; skip, with a stated and audited reason, " +
        "when that person is gone, no longer entitled, or the engine is off. Sensitive or over-threshold runs still wait " +
        "for approval.",
      adr: "ADR-0187",
      defaultIntervalSeconds: 300,
      run: async (ctx) => {
        const out = await runEngineScheduleSweep(ctx.db, { now: ctx.now });
        return { itemsProcessed: out.started, detail: { ...out } };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const runParam = z.object({ runId: z.string().uuid() });
const scheduleParam = z.object({ scheduleId: z.string().uuid() });
const listQuery = z.object({
  engineId: z.enum(ENGINE_IDS).optional(),
  status: z.enum(ENGINE_RUN_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function publicRun(run: EngineRunRow) {
  const { rawReportCiphertext, ...rest } = run;
  return { ...rest, rawReportStored: rawReportCiphertext !== null };
}

export function registerEngineRunRoutes(app: FastifyInstance, db: Db, opts: EngineOptions = {}): void {
  setEngineRuntime(opts);
  const manifest = manifestOf(opts);

  const visible = (req: { authCtx: { isAdmin: boolean; userId: string | null } }, run: EngineRunRow) =>
    req.authCtx.isAdmin || (req.authCtx.userId !== null && run.runAsUserId === req.authCtx.userId);

  // ---- POST /v1/engine-runs ---------------------------------------------------
  app.post("/v1/engine-runs", async (req, reply) => {
    const body = createEngineRunSchema.parse(req.body);
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_run_engine" });
    if ("agentId" in body.target) {
      const literacy = await refuseRunStartWithoutLiteracy(db, req, { kind: "red-team", subjectId: body.target.agentId });
      if (literacy) return reply.status(literacy.status).send(literacy.body);
    }
    const out = await createEngineRun(db, body, { runAsUserId: userId, isAdmin: req.authCtx.isAdmin, trigger: "manual" });
    if (!out.ok) return reply.status(out.status).send({ error: out.error, ...(out.detail ? { detail: out.detail } : {}) });
    return reply.status(202).send({ run: publicRun(out.run), approvalId: out.approvalId });
  });

  app.get("/v1/engine-runs", async (req) => {
    const q = listQuery.parse(req.query ?? {});
    const conds = [];
    if (!req.authCtx.isAdmin) conds.push(eq(engineRuns.runAsUserId, req.authCtx.userId ?? NO_IDENTITY));
    if (q.engineId) conds.push(eq(engineRuns.engineId, q.engineId));
    if (q.status) conds.push(eq(engineRuns.status, q.status));
    const rows = await db
      .select()
      .from(engineRuns)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(engineRuns.createdAt))
      .limit(q.limit);
    return { runs: rows.map(publicRun) };
  });

  app.get("/v1/engine-runs/:runId", async (req, reply) => {
    const { runId } = runParam.parse(req.params);
    const [run] = await db.select().from(engineRuns).where(eq(engineRuns.id, runId));
    if (!run || !visible(req, run)) return reply.status(404).send({ error: "engine_run_not_found" });
    const items = await db.select().from(engineRunItems).where(eq(engineRunItems.runId, runId)).orderBy(asc(engineRunItems.createdAt));
    return { run: publicRun(run), items };
  });

  // ---- POST /v1/engine-runs/:runId/cancel (the kill switch) -------------------
  app.post("/v1/engine-runs/:runId/cancel", async (req, reply) => {
    const { runId } = runParam.parse(req.params);
    const body = cancelEngineRunSchema.parse(req.body ?? {});
    const [run] = await db.select().from(engineRuns).where(eq(engineRuns.id, runId));
    if (!run || !visible(req, run)) return reply.status(404).send({ error: "engine_run_not_found" });
    if (isTerminalEngineRunStatus(run.status)) return reply.status(409).send({ error: "engine_run_finished", status: run.status });
    const actor = req.authCtx.userId ?? NO_IDENTITY;
    await db
      .update(engineRuns)
      .set({ cancelRequestedAt: new Date(), cancelRequestedByUserId: req.authCtx.userId })
      .where(and(eq(engineRuns.id, runId), isNull(engineRuns.cancelRequestedAt)));
    const done = await finishEngineRun(db, runId, ["awaiting_approval", "queued", "leased"], {
      status: "cancelled",
      errorCode: "cancelled",
      normalised: noResult("cancelled"),
      cause: body.reason ? `cancelled: ${body.reason}` : "cancelled",
      actorUserId: actor,
    });
    if (!done) {
      const [now] = await db.select().from(engineRuns).where(eq(engineRuns.id, runId));
      return reply.status(409).send({ error: "engine_run_finished", status: now?.status ?? "unknown" });
    }
    if (run.approvalId && run.status === "awaiting_approval") {
      // the approval has nothing left to release
      await db.update(approvals).set({ status: "superseded" }).where(and(eq(approvals.id, run.approvalId), eq(approvals.status, "pending")));
    }
    return reply.send({ run: publicRun(done) });
  });

  // ---- schedules -----------------------------------------------------------------
  app.post("/v1/engine-schedules", async (req, reply) => {
    const body = createEngineScheduleSchema.parse(req.body);
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_schedule_engine" });
    // PR #203 review [13]: validated now, as the person it will run as, by the SAME
    // checks a run gets (engine on, target kind, project, target and judge
    // entitlement, attribution, budget ceiling, approver); nothing is started
    const checked = await validateEngineRunRequest(db, body.request, { runAsUserId: userId, isAdmin: req.authCtx.isAdmin });
    if (!checked.ok) return reply.status(checked.status).send({ error: checked.error, ...(checked.detail ? { detail: checked.detail } : {}) });
    const now = new Date();
    const [row] = await db
      .insert(engineSchedules)
      .values({
        engineId: body.request.engineId,
        request: body.request as unknown as Record<string, unknown>,
        configHash: engineRunConfigHash(body.request),
        runAsUserId: userId,
        intervalHours: body.intervalHours,
        nextRunAt: new Date(now.getTime() + body.intervalHours * 3_600_000),
      })
      .returning();
    await auditEngine(db, {
      userId,
      objectType: "engine_schedule",
      objectId: row!.id,
      ruleId: "engine-schedule-created",
      detail: { engineId: body.request.engineId, intervalHours: body.intervalHours, configHash: row!.configHash },
      reason: `scheduled ${body.request.engineId} run every ${body.intervalHours}h, executing as its creator`,
    });
    return reply.status(201).send({ schedule: row });
  });

  app.get("/v1/engine-schedules", async (req) => {
    const rows = await db
      .select()
      .from(engineSchedules)
      .where(req.authCtx.isAdmin ? undefined : eq(engineSchedules.runAsUserId, req.authCtx.userId ?? NO_IDENTITY))
      .orderBy(desc(engineSchedules.createdAt))
      .limit(200);
    return { schedules: rows };
  });

  app.patch("/v1/engine-schedules/:scheduleId", async (req, reply) => {
    const { scheduleId } = scheduleParam.parse(req.params);
    const body = updateEngineScheduleSchema.parse(req.body);
    const [row] = await db.select().from(engineSchedules).where(eq(engineSchedules.id, scheduleId));
    if (!row || (!req.authCtx.isAdmin && row.runAsUserId !== req.authCtx.userId)) return reply.status(404).send({ error: "engine_schedule_not_found" });
    // re-enabling a schedule restarts runs as its creator: only the creator may do that
    if (body.enabled && row.runAsUserId !== req.authCtx.userId) {
      return reply.status(403).send({ error: "schedule_owner_only", detail: "only the person a schedule runs as can switch it back on" });
    }
    const [after] = await db.update(engineSchedules).set({ enabled: body.enabled, updatedAt: new Date() }).where(eq(engineSchedules.id, scheduleId)).returning();
    await auditEngine(db, {
      userId: req.authCtx.userId ?? NO_IDENTITY,
      objectType: "engine_schedule",
      objectId: scheduleId,
      ruleId: body.enabled ? "engine-schedule-enabled" : "engine-schedule-disabled",
      detail: { engineId: row.engineId, transitions: { enabled: { from: row.enabled, to: body.enabled } } },
      reason: `scheduled ${row.engineId} run switched ${body.enabled ? "on" : "off"}`,
    });
    return { schedule: after };
  });

  // ---- POST /v1/model-artifacts (B5-M builds the upload) ---------------------------
  app.post("/v1/model-artifacts", async (_req, reply) => reply.status(501).send(BATCH5_NOT_BUILT));

  // ===== runner routes (runner token only; the scope hook enforces it) ==========

  app.post("/v1/engine-runner/lease", async (req, reply) => {
    const runnerId = req.authCtx.engineRunnerId!;
    const engineId = req.authCtx.engineId as EngineId;
    await syncEngineManifest(db, manifest);
    const [runner] = await db.select().from(engineRunners).where(eq(engineRunners.id, runnerId));
    const [engine] = await db.select().from(engines).where(eq(engines.id, engineId));
    if (!engine || !engine.enabled) {
      // PR #205 review round 4 [64]: say WHY, so a runner whose own last report failed keeps
      // re-proving itself on a slow cadence, and one that an admin simply switched off just waits.
      // A passing refresh never re-enables the engine: that stays an audited admin action.
      const reason = runner && !runner.selfTestPassed ? "runner_self_test_failed" : "disabled";
      return reply.status(409).send({
        error: "engine_disabled",
        reason,
        detail:
          reason === "runner_self_test_failed"
            ? `engine ${engineId} is off and this runner's last self-test failed: submit a fresh one; an admin re-enables the engine`
            : `engine ${engineId} is off: no work is leased`,
      });
    }
    const m = manifest[engineId];
    const now = new Date();
    // PR #203 review [3]: decided NOW, never from a stored boolean — the runner's
    // own report is re-evaluated against the manifest (digest, version, switches,
    // egress, and its 24-hour freshness), and the engine's recorded self-test
    // must still admit it (fresh, same build)
    const runnerVerdict = runner ? evaluateRunnerSelfTest(m, runner.selfTest as RunnerSelfTest, now) : null;
    const engineAdmits = selfTestAdmitsEnable(engine, m, now);
    if (
      !runner ||
      !runnerVerdict?.passed ||
      runner.reportedDigest !== m.imageDigest ||
      runner.reportedVersion !== m.version ||
      !engineAdmits.ok
    ) {
      return reply.status(409).send({
        error: "engine_self_test_required",
        detail:
          !runnerVerdict?.passed
            ? `this runner's self-test does not pass now (${runnerVerdict?.failures.join(", ") ?? "no runner"}); re-enrol it from the signed image`
            : `the engine's self-test no longer admits it (${engineAdmits.why ?? "build changed"}); run the self-test again`,
      });
    }
    await engineRunTestHooks.beforeLeaseTx?.(runnerId);
    const leased = await db.transaction(async (tx) => {
      // PR #203 review round 2 [17]: the runner row is locked (shared) and its
      // revocation re-read inside the transaction that hands out the work.
      // Revocation UPDATEs that row, so it waits for this lease to commit (and
      // then ends the run it leased), or this lease waits for the revocation and
      // sees it — a runner revoked concurrently never walks away with a key.
      const [live] = await tx
        .select({ revokedAt: engineRunners.revokedAt })
        .from(engineRunners)
        .where(eq(engineRunners.id, runnerId))
        .for("share");
      if (!live || live.revokedAt !== null) return { kind: "revoked" as const };
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`engine-lease:${engineId}`}))`);
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(engineRuns)
        .where(and(eq(engineRuns.engineId, engineId), eq(engineRuns.status, "leased")));
      if (Number(n) >= engine.maxConcurrent) return { kind: "busy" as const };
      const [run] = await tx
        .select()
        .from(engineRuns)
        .where(and(eq(engineRuns.engineId, engineId), eq(engineRuns.status, "queued"), sql`${engineRuns.queueExpiresAt} > now()`))
        .orderBy(asc(engineRuns.createdAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!run) return { kind: "none" as const };
      // the person it runs as, re-checked now: gone or no longer entitled ends it, with the reason stated
      const [person] = run.runAsUserId
        ? await tx.select({ id: users.id, disabledAt: users.disabledAt, isAdmin: users.isAdmin }).from(users).where(eq(users.id, run.runAsUserId))
        : [];
      let refusal: string | null = null;
      let target: AgentRow | null = null;
      let judge: AgentRow | null = null;
      if (!person || person.disabledAt) refusal = "run_as_gone";
      else if (run.targetKind === "agent") {
        const decide = await buildAgentDecider(tx as unknown as Db, person.id);
        const [t] = run.targetAgentId ? await tx.select().from(agents).where(eq(agents.id, run.targetAgentId)) : [];
        const [j] = run.judgeAgentId ? await tx.select().from(agents).where(eq(agents.id, run.judgeAgentId)) : [];
        if (!t || decide(t as AgentRow, "execute").effect !== "allow") refusal = "run_as_not_entitled";
        else if (run.judgeAgentId && (!j || decide(j as AgentRow, "execute").effect !== "allow")) refusal = "run_as_not_entitled";
        else if (!run.projectId) refusal = "project_gone";
        else {
          // PR #203 review [10]: attribution is re-checked here too (a member removed
          // since the run was queued no longer bills to the project)
          const attribution = await assertProjectAttribution(tx as unknown as Db, run.projectId, person.id, person.isAdmin);
          if (!attribution.ok) refusal = "project_not_attributable";
        }
        target = (t as AgentRow | undefined) ?? null;
        judge = (j as AgentRow | undefined) ?? null;
      }
      if (refusal) return { kind: "refused" as const, run, refusal };
      const deadlineAt = new Date(now.getTime() + run.timeoutSeconds * 1000);
      let apiKey: string | null = null;
      let keyId: string | null = null;
      if (run.targetKind === "agent" && m.needsModelAccess) {
        const { token, tokenHash } = generateVirtualKeyToken();
        const [key] = await tx
          .insert(virtualKeys)
          .values({
            name: engineKeyName(engineId, run.id),
            userId: run.runAsUserId!,
            tokenHash,
            purpose: ENGINE_VIRTUAL_KEY_PURPOSE,
            allowedModels: [target!.id, ...(judge ? [judge.id] : [])],
            budgetUsd: run.budgetUsd,
            expiresAt: deadlineAt,
            projectId: run.projectId,
            engineRunId: run.id,
            createdBy: null,
          })
          .returning({ id: virtualKeys.id });
        apiKey = token;
        keyId = key!.id;
        await tx.insert(auditLog).values({
          userId: run.runAsUserId!,
          objectType: "virtual_key",
          objectId: keyId,
          detail: {
            phase: "issue",
            purpose: ENGINE_VIRTUAL_KEY_PURPOSE,
            engineRunId: run.id,
            engineId,
            ownerUserId: run.runAsUserId,
            allowedModels: [target!.id, ...(judge ? [judge.id] : [])],
            budgetUsd: run.budgetUsd,
            expiresAt: deadlineAt.toISOString(),
            projectId: run.projectId,
          },
          effect: "allow",
          ruleId: "engine-run-key-minted",
          ruleChain: [],
          reason: `run-scoped key minted for ${engineId} run ${run.id}: the run-as person's ceiling, $${run.budgetUsd.toFixed(2)}, until ${deadlineAt.toISOString()}`,
        });
      }
      const agentHash = target ? await agentConfigHash(tx as unknown as Db, target) : null;
      const [updated] = await tx
        .update(engineRuns)
        .set({
          status: "leased",
          runnerId,
          leasedAt: now,
          leaseExpiresAt: new Date(now.getTime() + ENGINE_LEASE_TTL_SECONDS * 1000),
          heartbeatAt: now,
          deadlineAt,
          virtualKeyId: keyId,
          agentConfigHash: agentHash,
        })
        .where(eq(engineRuns.id, run.id))
        .returning();
      await tx.insert(auditLog).values({
        userId: run.runAsUserId ?? NO_IDENTITY,
        objectType: "engine_run",
        objectId: run.id,
        detail: { phase: "lease", engineId, runnerId, deadlineAt: deadlineAt.toISOString(), virtualKeyId: keyId },
        effect: "allow",
        ruleId: "engine-run-leased",
        ruleChain: [],
        reason: `${engineId} run ${run.id} leased by runner ${runnerId} until ${deadlineAt.toISOString()}`,
      });
      return { kind: "leased" as const, run: updated!, apiKey, target, judge };
    });
    if (leased.kind === "revoked") {
      return reply.status(401).send({ error: "engine_runner_revoked", detail: "this runner was revoked: its token authenticates nothing" });
    }
    if (leased.kind === "busy" || leased.kind === "none") return reply.status(204).send();
    if (leased.kind === "refused") {
      await finishEngineRun(db, leased.run.id, ["queued"], {
        status: "not_run",
        errorCode: leased.refusal,
        normalised: noResult("not_run"),
        cause: leased.refusal,
        actorUserId: NO_IDENTITY,
      });
      return reply.status(204).send();
    }
    const run = leased.run;
    const [artifact] = run.targetArtifactId ? await db.select().from(modelArtifacts).where(eq(modelArtifacts.id, run.targetArtifactId)) : [];
    const headers = (agentId: string): Record<string, string> => ({ [AGENT_HEADER]: agentId, [PROJECT_HEADER]: run.projectId! });
    const body: EngineLease = {
      runId: run.id,
      engineId,
      engineVersion: run.engineVersion,
      spec: { config: run.config, trials: run.trials },
      target:
        leased.apiKey && leased.target
          ? { baseUrl: gatewayBaseUrlOf(opts), model: leased.target.model ?? leased.target.name, apiKey: leased.apiKey, headers: headers(leased.target.id) }
          : null,
      judge: leased.apiKey && leased.judge ? { model: leased.judge.model ?? leased.judge.name, headers: headers(leased.judge.id) } : null,
      artifacts: artifact ? [{ id: artifact.id, sha256: artifact.sha256, size: artifact.sizeBytes }] : [],
      deadlineAt: run.deadlineAt!.toISOString(),
      budgetUsd: leased.apiKey ? run.budgetUsd : null,
    };
    return reply.send(body);
  });

  app.post("/v1/engine-runner/runs/:runId/heartbeat", async (req, reply) => {
    const { runId } = runParam.parse(req.params);
    const body = engineHeartbeatSchema.parse(req.body);
    const runnerId = req.authCtx.engineRunnerId!;
    // PR #203 review round 2 [20]: decided under the run's row lock — a lease
    // that has expired (or a deadline that has passed) is never renewed; the
    // run ends as a timeout, its key is revoked, and the runner is told 409
    const now = new Date();
    const beat = await db.transaction(async (tx) => {
      const [run] = await tx.select().from(engineRuns).where(eq(engineRuns.id, runId)).for("update");
      if (!run || run.runnerId !== runnerId) return { kind: "not_leased" as const };
      // an ended run (cancelled, timed out) tells its runner to stop
      if (run.status !== "leased") return { kind: "ended" as const, status: run.status };
      const deadlinePassed = run.deadlineAt !== null && run.deadlineAt.getTime() <= now.getTime();
      const leaseGone = run.leaseExpiresAt !== null && run.leaseExpiresAt.getTime() <= now.getTime();
      if (deadlinePassed || leaseGone) return { kind: "expired" as const, cause: deadlinePassed ? "deadline_passed" : "lease_expired" };
      const lease = new Date(Math.min(now.getTime() + ENGINE_LEASE_TTL_SECONDS * 1000, run.deadlineAt?.getTime() ?? now.getTime()));
      await tx
        .update(engineRuns)
        .set({ heartbeatAt: now, phase: body.phase, progress: body.progress, leaseExpiresAt: lease })
        .where(eq(engineRuns.id, runId));
      return { kind: "renewed" as const, cancel: run.cancelRequestedAt !== null, status: run.status };
    });
    if (beat.kind === "not_leased") return reply.status(409).send({ error: "engine_run_not_leased" });
    if (beat.kind === "ended") return reply.send({ cancel: true, status: beat.status });
    if (beat.kind === "expired") {
      // the expiry only ever moves forward through a heartbeat that saw it live,
      // so no heartbeat can revive it between the check above and this end
      await finishEngineRun(db, runId, ["leased"], {
        status: "timeout",
        errorCode: beat.cause,
        normalised: noResult("timeout"),
        cause: beat.cause,
        actorUserId: NO_IDENTITY,
      });
      return reply.status(409).send({ error: "engine_run_timed_out", detail: `the run's ${beat.cause === "lease_expired" ? "lease expired" : "deadline passed"}; it ended as a timeout` });
    }
    return reply.send({ cancel: beat.cancel, status: beat.status });
  });

  // streamed through the gateway once B5-M builds the artifact store
  app.get("/v1/engine-runner/artifacts/:artifactId", async (_req, reply) => reply.status(501).send(BATCH5_NOT_BUILT));

  app.post(
    "/v1/engine-runner/runs/:runId/result",
    { bodyLimit: ENGINE_RESULT_LIMITS.maxBodyBytes },
    async (req, reply) => {
      const { runId } = runParam.parse(req.params);
      const runnerId = req.authCtx.engineRunnerId!;
      const [run] = await db.select().from(engineRuns).where(eq(engineRuns.id, runId));
      if (!run || run.runnerId !== runnerId) return reply.status(409).send({ error: "engine_run_not_leased" });
      if (run.status !== "leased") {
        // LATE: the run already ended (cancelled, timed out). A late envelope never upgrades it.
        await auditEngine(db, {
          userId: run.runAsUserId ?? NO_IDENTITY,
          objectType: "engine_run",
          objectId: run.id,
          ruleId: "engine-run-result-late",
          effect: "deny",
          detail: { engineId: run.engineId, status: run.status, runnerId },
          reason: `a result for ${run.engineId} run ${run.id} arrived after it ended ${run.status}; it was not ingested`,
        });
        return reply.status(409).send({ error: "engine_run_finished", status: run.status });
      }
      const parsed = engineResultEnvelopeSchema.safeParse(req.body);
      let problem: string | null = null;
      let envelope: EngineResultEnvelope | null = null;
      if (!parsed.success) problem = "result_invalid";
      // PR #203 review [12]: the envelope must be for this run, this engine AND the version it was leased at
      else if (parsed.data.runId !== run.id || parsed.data.engineId !== run.engineId || parsed.data.engineVersion !== run.engineVersion) {
        problem = "result_mismatch";
      }
      else envelope = parsed.data;
      let rawReport: FinishArgs["rawReport"] = null;
      if (envelope?.rawReport) {
        const r = envelope.rawReport;
        if (r.contentBase64 !== undefined) {
          const bytes = Buffer.from(r.contentBase64, "base64");
          const sha = createHash("sha256").update(bytes).digest("hex");
          if (bytes.length !== r.bytes || sha !== r.sha256) problem = "raw_report_mismatch";
        }
        if (!problem) {
          const org = await loadOrgSettings(db);
          const store = r.contentBase64 !== undefined && opts.dataKey;
          rawReport = {
            sha256: r.sha256,
            bytes: r.bytes,
            ciphertext: store ? encryptSecret(opts.dataKey!, r.contentBase64!) : null,
            expiresAt: store ? new Date(Date.now() + org.engineRawReportRetentionDays * 86_400_000) : null,
          };
        }
      }
      if (problem) {
        // an invalid or mismatched result: the run failed and every reading is unknown
        const failed = await finishEngineRun(db, run.id, ["leased"], {
          status: "failed",
          errorCode: problem,
          normalised: noResult("failed"),
          cause: problem,
          actorUserId: run.runAsUserId ?? NO_IDENTITY,
          requireLive: true,
        });
        if (failed?.status === "timeout") return reply.status(409).send({ error: "engine_run_timed_out", status: "timeout" });
        return reply.status(422).send({
          error: "engine_result_invalid",
          detail: problem,
          ...(parsed.success ? {} : { issues: parsed.error.issues.slice(0, 20) }),
        });
      }
      // PR #205 review round 3 [61]: only the manifest's declared reduced set may be not-run without
      // making the run incomplete; every other not-run item happened at run time
      const declaredNotRun = new Set(manifestOf(opts)[run.engineId as EngineId].airGappedReducedSet.map((e) => e.key));
      const normalised = normaliseEngineResult({ envelope: envelope!, status: envelope!.status, taxonomy: taxonomyOf(opts), scrub: engineDetectionScrub, declaredNotRun });
      const done = await finishEngineRun(db, run.id, ["leased"], {
        status: envelope!.status,
        errorCode: envelope!.status === "completed" ? null : (normalised.engineErrorCode ?? "engine_error"),
        normalised,
        cause: "result",
        actorUserId: run.runAsUserId ?? NO_IDENTITY,
        envelope,
        rawReport,
        requireLive: true,
      });
      if (!done) return reply.status(409).send({ error: "engine_run_finished" });
      if (done.status === "timeout" && envelope!.status !== "timeout") {
        return reply.status(409).send({ error: "engine_run_timed_out", status: "timeout", detail: "the result arrived after the run's deadline or lease; it was not ingested" });
      }
      return reply.send({ runId: run.id, status: done.status, verdict: normalised.verdict, counts: normalised.counts });
    },
  );
}

/** read-only helpers for tests and views */
export async function engineRunItemsOf(db: Db, runIds: string[]) {
  if (runIds.length === 0) return [];
  return db.select().from(engineRunItems).where(inArray(engineRunItems.runId, runIds));
}
