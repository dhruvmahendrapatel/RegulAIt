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
  isTerminalEngineRunStatus,
  normaliseEngineResult,
  updateEngineScheduleSchema,
  type CreateEngineRunInput,
  type EngineId,
  type EngineLease,
  type EngineManifestEntry,
  type EngineResultEnvelope,
  type EngineRunNormalised,
  type EngineTaxonomy,
  type EngineTerminalRunStatus,
} from "@regulait/shared";
import { z } from "zod";
import { auditEngine, gatewayBaseUrlOf, manifestOf, NO_IDENTITY, syncEngineManifest, taxonomyOf, type EngineOptions } from "./engines.js";
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

/** create a run (every trigger comes through here) */
export async function createEngineRun(db: Db, input: CreateEngineRunInput, ctx: CreateRunContext): Promise<CreateRunOutcome> {
  const opts = runtime;
  const manifest = manifestOf(opts)[input.engineId as EngineId];
  await syncEngineManifest(db, manifestOf(opts));
  const [engine] = await db.select().from(engines).where(eq(engines.id, input.engineId));
  if (!engine) return { ok: false, status: 404, error: "engine_not_found" };
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
}

/**
 * Move a run from one of `from` to a terminal status, revoke its key, store
 * the normalised items and (completed agent runs) the ledgers — one
 * transaction, compare-and-set on the status. Returns null when the run was
 * no longer in `from` (someone else ended it first).
 */
export async function finishEngineRun(db: Db, runId: string, from: readonly string[], args: FinishArgs): Promise<EngineRunRow | null> {
  const opts = runtime;
  const now = new Date();
  const out = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(engineRuns).where(eq(engineRuns.id, runId)).for("update");
    if (!locked || !from.includes(locked.status)) return null;
    const costUsd = await runCostUsd(tx, locked.virtualKeyId);
    const summary = {
      verdict: args.normalised.verdict,
      counts: args.normalised.counts,
      mappedItems: args.normalised.mappedItems,
      unmappedItems: args.normalised.unmappedItems,
      asr: args.normalised.asr,
      asrInterval: args.normalised.asrInterval,
      asrTrials: args.normalised.asrTrials,
      measurementQuality: args.normalised.measurementQuality,
      classes: args.normalised.classes,
      taxonomyVersion: args.normalised.taxonomyVersion,
      explanation: args.normalised.explanation,
      engineReportedStatus: args.envelope?.status ?? null,
      engineErrorCode: args.envelope?.errorCode ?? null,
      cause: args.cause,
    };
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
  });
  if (out && out.workflowInstanceId) await notifyWorkflowOfEngineRun(db, out);
  return out;
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
    .set({ status: "not_run", errorCode: "approval_denied", finishedAt: now, summary: { verdict: n.verdict, explanation: "approval denied; nothing ran", cause: "approval_denied" } })
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
  const ended = { ...run, status: "not_run" as const };
  return async (db: Db) => notifyWorkflowOfEngineRun(db, ended);
}

// ---------------------------------------------------------------------------
// Workflow binding (owner decision 4)
// ---------------------------------------------------------------------------

/** a workflow-bound run ended: re-evaluate its check stage (lazy import: workflows.ts imports this module) */
async function notifyWorkflowOfEngineRun(db: Db, run: Pick<EngineRunRow, "workflowInstanceId" | "workflowStageId">): Promise<void> {
  if (!run.workflowInstanceId || !run.workflowStageId) return;
  try {
    const wf = await import("./workflows.js");
    await wf.reevaluateCheckStage(db, run.workflowInstanceId, run.workflowStageId, runtime.dataKey);
  } catch {
    // the stage re-evaluates on its next advance; the run's outcome is already stored
  }
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
      const created = await createEngineRun(db, parsed.data, {
        runAsUserId: instance.initiatorUserId,
        isAdmin: false,
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
  const out = { timedOut: 0, leaseExpired: 0, queueExpired: 0, rawReportsPurged: 0 };
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
  const purged = await db
    .update(engineRuns)
    .set({ rawReportCiphertext: null })
    .where(and(isNotNull(engineRuns.rawReportCiphertext), lt(engineRuns.rawReportExpiresAt, now)))
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
      const created = await createEngineRun(db, parsed.data, { runAsUserId: person.id, isAdmin: person.isAdmin, trigger: "scheduled", scheduleId: s.id });
      if (created.ok) runId = created.run.id;
      else skip = `${created.error}${created.detail ? `: ${created.detail}` : ""}`;
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
    // validated now as the person it will run as (the same checks a run gets); nothing is started
    const [engine] = await db.select().from(engines).where(eq(engines.id, body.request.engineId));
    if (!engine) return reply.status(404).send({ error: "engine_not_found" });
    if ("agentId" in body.request.target) {
      const t = await entitlementRefusal(db, userId, body.request.target.agentId, "target");
      if ("ok" in t) return reply.status(t.status).send({ error: t.error, ...(t.detail ? { detail: t.detail } : {}) });
    }
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
      return reply.status(409).send({ error: "engine_disabled", detail: `engine ${engineId} is off: no work is leased` });
    }
    const m = manifest[engineId];
    if (!runner || !runner.selfTestPassed || m.imageDigest === null || runner.reportedDigest !== m.imageDigest || runner.reportedVersion !== m.version) {
      return reply.status(409).send({
        error: "engine_self_test_required",
        detail: "this runner's self-test did not pass against the shipped manifest (digest, version, usage-data switches, egress); re-enrol it from the signed image",
      });
    }
    const now = new Date();
    const leased = await db.transaction(async (tx) => {
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
        ? await tx.select({ id: users.id, disabledAt: users.disabledAt }).from(users).where(eq(users.id, run.runAsUserId))
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
    const [run] = await db.select().from(engineRuns).where(eq(engineRuns.id, runId));
    if (!run || run.runnerId !== runnerId) return reply.status(409).send({ error: "engine_run_not_leased" });
    // an ended run (cancelled, timed out) tells its runner to stop
    if (run.status !== "leased") return reply.send({ cancel: true, status: run.status });
    const now = new Date();
    const deadlinePassed = run.deadlineAt !== null && run.deadlineAt <= now;
    const lease = new Date(Math.min(now.getTime() + ENGINE_LEASE_TTL_SECONDS * 1000, run.deadlineAt?.getTime() ?? now.getTime()));
    await db
      .update(engineRuns)
      .set({ heartbeatAt: now, phase: body.phase, progress: body.progress, leaseExpiresAt: lease })
      .where(and(eq(engineRuns.id, runId), eq(engineRuns.status, "leased")));
    return reply.send({ cancel: deadlinePassed || run.cancelRequestedAt !== null, status: run.status });
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
      else if (parsed.data.runId !== run.id || parsed.data.engineId !== run.engineId) problem = "result_mismatch";
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
        await finishEngineRun(db, run.id, ["leased"], {
          status: "failed",
          errorCode: problem,
          normalised: noResult("failed"),
          cause: problem,
          actorUserId: run.runAsUserId ?? NO_IDENTITY,
        });
        return reply.status(422).send({
          error: "engine_result_invalid",
          detail: problem,
          ...(parsed.success ? {} : { issues: parsed.error.issues.slice(0, 20) }),
        });
      }
      const normalised = normaliseEngineResult({ envelope: envelope!, status: envelope!.status, taxonomy: taxonomyOf(opts), scrub: engineDetectionScrub });
      const done = await finishEngineRun(db, run.id, ["leased"], {
        status: envelope!.status,
        errorCode: envelope!.status === "completed" ? null : (envelope!.errorCode ?? "engine_error"),
        normalised,
        cause: "result",
        actorUserId: run.runAsUserId ?? NO_IDENTITY,
        envelope,
        rawReport,
      });
      if (!done) return reply.status(409).send({ error: "engine_run_finished" });
      return reply.send({ runId: run.id, status: done.status, verdict: normalised.verdict, counts: normalised.counts });
    },
  );
}

/** read-only helpers for tests and views */
export async function engineRunItemsOf(db: Db, runIds: string[]) {
  if (runIds.length === 0) return [];
  return db.select().from(engineRunItems).where(inArray(engineRunItems.runId, runIds));
}
