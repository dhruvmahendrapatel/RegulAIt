import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  and,
  approvals,
  auditLog,
  desc,
  eq,
  inArray,
  sql,
  workflowArtifacts,
  workflowAssignmentRules,
  workflowEvents,
  workflowInstances,
  workflowTemplates,
  type Db,
} from "@regulait/db";
import {
  initialState,
  matchTemplates,
  mergeDefinitions,
  transition,
  validateDefinition,
  WorkflowStateError,
  type Effect,
  type InstanceState,
  type WorkflowDefinition,
  type WorkflowEvent,
} from "@regulait/workflow-kernel";
import {
  users,
  roles,
  roleAssignments,
  gitConnections,
  deployTargets,
  orchestrationRuns,
  agents,
  evalDatasets,
} from "@regulait/db";
import { runEvalSuite } from "./evals.js";
import {
  resolveProvider,
  gitDefaultBaseUrl,
  GitProviderError,
  IMPLEMENTED_GIT_PROVIDERS,
} from "@regulait/git-provider";
import { resolveDeployProvider, liveDeployClients, DeployProviderError } from "./deploy.js";
import { ExternalEffectBlockedError, runExternalWrite, type ExternalWriteAudit } from "./external-effects.js";
import { validateGraph } from "@regulait/orchestration-kernel";
import { inTransaction, planRun, type ApprovalPostCommit, type DbOrTx } from "./orchestration.js";
import {
  assertProjectAttribution,
  projectClassifications,
  requiredTemplateIdsFor,
} from "./projects.js";
import { refuseIfFeatureNotLicensed } from "./licensing.js";
import { decryptSecret, encryptSecret as encryptTokenOnce } from "./secrets.js";
import { guardConnectionCall, refuseConnectionEgressWrite } from "./connection-egress.js";
// ADR-0062 — the compiled git endpoint, adjudicated under a strict posture.
import {
  auditCompiledDefaultDenied,
  CompiledDefaultEgressBlockedError,
  decideCompiledDefault,
  loadCompiledEgressContext,
} from "./compiled-egress.js";
import { loadOrgSettings } from "./org-settings.js";
import { networkFacingSignal } from "./dev-secrets.js";
import { finishTrace, recordSpan, traceForRoot } from "./tracing.js";
import { activeDelegatorsFor } from "./delegations.js";
import {
  advanceStageSchema,
  createAssignmentRuleSchema,
  createDeployTargetSchema,
  deployTargetProviderConfig,
  createGitConnectionSchema,
  createWorkflowTemplateSchema,
  deployOverrideSchema,
  recheckSchema,
  reportChecksSchema,
  scrubAuditText,
  retireTemplateSchema,
  startInstanceSchema,
  submitArtifactSchema,
} from "@regulait/shared";
import { z } from "zod";

const instanceIdParam = z.object({ instanceId: z.string().uuid() });

type InstanceRow = typeof workflowInstances.$inferSelect;

function resolveApprover(approver: string, initiatorUserId: string): string {
  return approver === "requesting_user" ? initiatorUserId : approver;
}

/** A per-check outcome reported into a check stage (real CI, or the demo). */
type CheckReport = {
  check: string;
  status: "passed" | "failed";
  severity?: string | null;
  detail?: string | null;
  /** ADR-0167 (AUTHZ-06) — PROVENANCE: who posted this result, and whether
   * that person is the change's own initiator. Absent on rows written before
   * the stamp existed. */
  reportedByUserId?: string | null;
  selfReported?: boolean;
  reason?: string | null;
  /** AER-048: the workflow round (workflow_instances.round) the report was
   * accepted into. Absent on rows written before the token existed. */
  round?: number;
};
/** Defensive read of context[`reported:<stageId>`] — tolerate anything and keep
 * only well-formed pass/fail rows, so a malformed context value can never crash
 * the executor or smuggle a third status. */
function normalizeCheckReports(v: unknown): CheckReport[] {
  return Array.isArray(v)
    ? (v as CheckReport[]).filter(
        (r) => r && typeof r.check === "string" && (r.status === "passed" || r.status === "failed"),
      )
    : [];
}

/**
 * Run a kernel transition, persist the new state, append history, audit into
 * the one trail, and materialize effects (approval rows into the §6 queue —
 * all named approvers must approve).
 */
async function applyEvent(
  db: DbOrTx,
  instanceId: string,
  event: WorkflowEvent,
  actorUserId: string | null,
  precondition?: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<boolean>,
  /** A4 (migration 0044): the mode of the deploy target a deploy-scoped event
   * acted on — stamped onto the audit row so per-mode audit retention and the
   * mode dimension are real. Only the deploy/rollback executors pass it; every
   * other event keeps null (= not a deploy-scoped action). */
  deployMode?: "hosted" | "byoc" | "air_gapped" | null,
  /** AER-048 (review item 6): `deferSpan` — the caller is inside its OWN
   * transaction and records the `workflow_stage` span itself, AFTER that
   * transaction commits (`recordDeferredSpan`), so a span failure can never
   * roll back a result whose side effects already happened. */
  opts?: { deferSpan?: boolean },
): Promise<{ state: InstanceState; effects: Effect[]; skipped?: boolean; deferredSpan?: DeferredSpan }> {
  // One transaction with the instance row locked: concurrent decisions,
  // re-opens, and aborts serialize instead of racing read-modify-write. When
  // the caller already holds a transaction (the decide endpoint), this nests
  // as a savepoint so the whole flow commits or rolls back together.
  const applied = await inTransaction(db, async (tx) => {
    const [instance] = await tx
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, instanceId))
      .for("update");
    if (!instance) throw new Error("instance disappeared");
    if (precondition && !(await precondition(tx))) {
      return { state: instance.state as InstanceState, effects: [], skipped: true };
    }

    const def = instance.definition as WorkflowDefinition;
    const prior = instance.state as InstanceState;
    const { state, effects } = transition(def, prior, event);

    // AER-047 (review): a check result belongs to the ROUND it was reported
    // in. An artifact resubmitted after its stage completed re-opens the
    // workflow (kernel §2 stage 4) and every downstream stage runs again on
    // the NEW artifact — so every check result and report already stored for
    // a downstream automated_check stage is stale and is cleared here, in the
    // same locked transaction as the re-open. Without this the re-run check
    // stage reused the previous round's CI green, unlabelled, and advanced
    // without anything having run against the new artifact. (A report posted
    // after the re-open — including one posted ahead of the stage while a
    // gate is pending — belongs to the new round, exactly as in round one.)
    // ADR-0168: a RETURNED sign-off re-opens from the artifact stage it went
    // back to (the kernel parked the instance there) — the same staleness.
    // AER-049: the generic `reopen` (recertification, or any caller of
    // reopenWorkflowInstance) re-opens from the stage it names.
    const reopenedFrom =
      event.kind === "artifact_submitted" || event.kind === "reopen"
        ? def.stages.findIndex((st) => st.id === event.stageId)
        : event.kind === "approval_returned"
          ? state.currentStageIndex
          : -1;
    const staleCheckStages: string[] = [];
    const staleRunStages: string[] = [];
    let archivedEffects: EffectHistoryEntry[] = [];
    let context: Record<string, unknown> | undefined;
    // AER-048 — THE ROUND TOKENS (migration 0130), bumped here because every
    // state change goes through this one locked transaction. `round` moves on
    // a RE-OPEN only: check reports bind to it, so a report produced for the
    // previous artifact is refused instead of landing in the new round.
    // `stage_entry` moves on a re-open AND on every entry into an executable
    // stage (awaiting_execution at a new stage, or again after a recheck): an
    // executor captured it with its claim, and its completion commits only
    // while it is unchanged — so an executor still running from before the
    // re-open (or from a previous entry) can neither restore the context it
    // snapshotted nor advance the instance.
    const isReopen = reopenedFrom >= 0 && reopenedFrom < prior.currentStageIndex;
    const entersExecutable =
      state.status === "awaiting_execution" &&
      (prior.status !== "awaiting_execution" || prior.currentStageIndex !== state.currentStageIndex);
    const bumpEntry = isReopen || entersExecutable;
    if (isReopen || bumpEntry) {
      const ctx = { ...(instance.context as Record<string, unknown>) };
      let changed = false;
      if (isReopen) {
        // AER-049: every effect record of a stage that runs again — a deploy,
        // a rollback, the branch / PR / merge, a planned nested run — moves to
        // `effects:history` with the round that produced it. The new round
        // merges and deploys afresh; an earlier round's record is never an
        // idempotency key for it. (AER-048 review item 5, subsumed: a nested
        // run planned in the OLD round no longer satisfies the new one — the
        // old run row stays, and its late completion no longer matches runId.)
        archivedEffects = archiveEffectRecords(def, ctx, reopenedFrom, instance.round, instance.round + 1, new Date().toISOString());
        for (const entry of archivedEffects) {
          for (const k of entry.keys) if (k.startsWith("runId:")) staleRunStages.push(k.slice("runId:".length));
        }
        def.stages.forEach((st, i) => {
          if (i <= reopenedFrom) return;
          if (st.type !== "automated_check") return;
          const keys = [`reported:${st.id}`, `checks:${st.id}`, `evals:${st.id}`, `awaitingReport:${st.id}`];
          if (keys.some((k) => k in ctx)) staleCheckStages.push(st.id);
          for (const k of keys) delete ctx[k];
        });
        changed = staleCheckStages.length > 0 || archivedEffects.length > 0;
      }
      // a claim taken under an earlier entry belongs to an executor whose
      // result will be discarded — it must not block this entry's executor
      if (CLAIM_KEYS.some((k) => k in ctx)) {
        for (const k of CLAIM_KEYS) delete ctx[k];
        changed = true;
      }
      if (changed) context = ctx;
    }
    const round = instance.round + (isReopen ? 1 : 0);
    const stageEntry = instance.stageEntry + (bumpEntry ? 1 : 0);

    await tx
      .update(workflowInstances)
      .set({
        state,
        status: state.status,
        round,
        stageEntry,
        updatedAt: new Date(),
        ...(context ? { context } : {}),
      })
      .where(eq(workflowInstances.id, instance.id));
    await tx.insert(workflowEvents).values({ instanceId: instance.id, event, actorUserId });

    const isDenial = event.kind === "approval_denied" || event.kind === "abort";
    // ADR-0168: a returned sign-off is not terminal, but the gate did not let
    // the change through — it audits as the refusal it is.
    const isReturn = event.kind === "approval_returned";
    await tx.insert(auditLog).values({
      userId: actorUserId ?? instance.initiatorUserId,
      objectType: "workflow",
      objectId: instance.id,
      detail: {
        event,
        ...(staleCheckStages.length > 0 ? { staleCheckResultsCleared: staleCheckStages } : {}),
        ...(staleRunStages.length > 0 ? { staleRunIdsCleared: staleRunStages } : {}),
        ...(isReopen ? { round } : {}),
        ...(bumpEntry ? { stageEntry } : {}),
      },
      effect: isDenial || isReturn ? "deny" : "allow",
      ruleId: `workflow:${event.kind}`,
      ruleChain: [],
      reason: `workflow instance event '${event.kind}' (status → ${state.status})`,
      // A4: deploy-scoped events carry their target's mode; everything else
      // stays null (unknown/not-applicable — honestly un-backfillable).
      deployMode: deployMode ?? null,
    });
    // AER-049: the archive is on the trail with the values — what an earlier
    // round shipped stays traceable from the audit alone.
    if (archivedEffects.length > 0) {
      await tx.insert(auditLog).values({
        userId: actorUserId ?? instance.initiatorUserId,
        objectType: "workflow",
        objectId: instance.id,
        detail: {
          event: event.kind,
          reopenedFrom: def.stages[reopenedFrom]?.id ?? null,
          closedRound: instance.round,
          round,
          archived: archivedEffects.map((e) => ({ round: e.round, keys: e.keys, values: e.values })),
        },
        effect: "allow",
        ruleId: "workflow:effects-archived",
        ruleChain: [],
        reason:
          `re-open into round ${round}: the effect records of round(s) ${[...new Set(archivedEffects.map((e) => e.round))].join(", ")} ` +
          `(${archivedEffects.flatMap((e) => e.keys).join(", ")}) moved to effects:history — the new round merges/deploys afresh`,
      });
    }

    // A re-open stales EVERY outstanding gate downstream, and a terminal
    // denial/abort must leave no live rows in the one inbox — supersede all
    // pending rows for the instance in each of these cases.
    if (event.kind === "artifact_submitted" || event.kind === "reopen" || isDenial || isReturn) {
      await tx
        .update(approvals)
        .set({ status: "superseded" })
        .where(and(eq(approvals.instanceId, instance.id), eq(approvals.status, "pending")));
    }

    for (const effect of effects) {
      if (effect.kind === "request_approval") {
        for (const approver of effect.approvers) {
          await tx.insert(approvals).values({
            userId: instance.initiatorUserId,
            objectType: "workflow",
            instanceId: instance.id,
            stageId: effect.stageId,
            approverUserId: resolveApprover(approver, instance.initiatorUserId),
          });
        }
      }
    }
    return {
      state,
      effects,
      span: {
        userId: instance.initiatorUserId,
        projectId: instance.projectId,
        status: state.status,
      },
    };
  });
  if (opts?.deferSpan) return { ...applied, deferredSpan: { instanceId, event, applied } };
  await recordWorkflowStageSpan(db, instanceId, event, applied);
  return applied;
}

/** a `workflow_stage` span whose write waits for the caller's commit */
type DeferredSpan = {
  instanceId: string;
  event: WorkflowEvent;
  applied: Parameters<typeof recordWorkflowStageSpan>[3];
};

/** AER-048: write a deferred span after the commit; a tracing failure is
 * logged, never propagated — the transition it describes is already durable */
async function recordDeferredSpan(db: Db, span: DeferredSpan | undefined): Promise<void> {
  if (!span) return;
  try {
    await recordWorkflowStageSpan(db, span.instanceId, span.event, span.applied);
  } catch (err) {
    console.error(`workflow_stage span for ${span.instanceId} not recorded: ${(err as Error).message}`);
  }
}

/**
 * ADR-0070 amendment (2026-08-15) — THE `workflow_stage` SPAN.
 *
 * `workflow_stage` was a DECLARED span kind with no writer. It is emitted here,
 * at `applyEvent`, for the same reason the dispatch span is emitted at the one
 * dispatch core: **this is the ONE choke point every workflow state change goes
 * through.** Sign-off, abort, artifact submission, a failing required check, a
 * blocked deploy, a rollback, a nested-run completion — all of them are an
 * `applyEvent` call, and none of them mentions tracing. A fifteenth event kind
 * added to the kernel tomorrow is traced without anybody remembering to.
 *
 * ONE TRACE PER INSTANCE, not one per event: `traceForRoot` reuses the
 * instance's tree, so a multi-day workflow reads as one thing (its `session_id`
 * is the instance id) and each transition is a sibling span in `seq` order.
 * That is what makes "where did this change stall, and who stopped it"
 * answerable off the indentation instead of by reading the event table.
 *
 * WHAT IS A REFUSAL HERE, and why. `approval_denied`, `abort`, `check_failed`
 * and `deploy_blocked` are DECISIONS — a human or a required gate refused to
 * let the change proceed, which is the workflow engine WORKING. They are
 * `denied` spans carrying the reason. `execution_failed` is the one
 * non-decision: it is a git/build/deploy fault and records as `error`, exactly
 * as `model_dispatch_failed` does in the dispatch core. Scoring a gate that
 * held as a failure is the ADR-0057/0072 inversion, and this is the third
 * place in the product where the line has to be drawn deliberately.
 *
 * A SKIPPED transition (the precondition said the event no longer applies)
 * writes NOTHING: nothing changed, so there is nothing to say.
 */
async function recordWorkflowStageSpan(
  db: DbOrTx,
  instanceId: string,
  event: WorkflowEvent,
  applied: {
    state: InstanceState;
    skipped?: boolean;
    span?: { userId: string; projectId: string | null; status: string };
  },
): Promise<void> {
  if (applied.skipped || !applied.span) return;
  const stageId = "stageId" in event ? event.stageId : null;
  const decided: Record<string, string> = {
    approval_denied: "stage approval was DENIED by an approver",
    approval_returned: "stage approval was RETURNED for more information by an approver",
    abort: "the workflow instance was aborted",
  };
  let status: "ok" | "denied" | "error" = "ok";
  let reason: string | null = null;
  if (event.kind === "execution_failed") {
    // the ONE non-decision: a git/build/deploy fault, not a verdict
    status = "error";
    reason = event.error;
  } else if (event.kind === "check_failed") {
    status = "denied";
    reason = `required checks failed, stage is blocked: ${event.failures.join(", ")}`;
  } else if (event.kind === "deploy_blocked") {
    status = "denied";
    reason = event.reason;
  } else if (decided[event.kind]) {
    status = "denied";
    reason = decided[event.kind]!;
  }
  const at = new Date();
  const ctx = await traceForRoot(db, {
    kind: "workflow",
    name: `workflow ${instanceId}`,
    userId: applied.span.userId,
    projectId: applied.span.projectId,
    sessionId: instanceId,
    rootRefId: instanceId,
  });
  if (!ctx) return;
  await recordSpan(db, ctx, {
    kind: "workflow_stage",
    name: stageId ? `${stageId}: ${event.kind}` : event.kind,
    status,
    statusReason: reason,
    startedAt: at,
    endedAt: at,
    attributes: {
      event: event.kind,
      ...(stageId ? { stageId } : {}),
      instanceStatus: applied.span.status,
      // the rule id the SAME transition wrote onto the audit trail, so the two
      // records name each other rather than each inventing a vocabulary
      ruleId: `workflow:${event.kind}`,
      ...(applied.span.projectId ? { projectId: applied.span.projectId } : {}),
    },
  });
  // The instance's trace closes when the INSTANCE does — not when one of its
  // transitions returns, exactly as a run's trace closes with the run.
  const terminal = ["completed", "denied", "aborted", "rolled_back"];
  if (terminal.includes(applied.span.status)) {
    await finishTrace(db, ctx, applied.span.status === "completed" ? "ok" : "denied");
  }
}

/**
 * Called from the §6 decide endpoint for approvals with objectType
 * 'workflow'. All-must-approve: the instance advances only when no pending
 * rows remain for the stage; any denial denies the stage immediately.
 * Runs on the decide endpoint's OPEN transaction so a kernel refusal
 * (WorkflowStateError → 409) rolls the decision itself back; returns the
 * post-commit step (git/build stage execution) for the caller to run once
 * the decision is durable.
 */
export async function applyWorkflowApprovalDecision(
  dbx: DbOrTx,
  approvalRow: { instanceId: string | null; stageId: string | null },
  decision: "approved" | "denied" | "returned",
  deciderUserId: string,
  dataKey?: string,
): Promise<ApprovalPostCommit | null> {
  if (!approvalRow.instanceId || !approvalRow.stageId) return null;
  const stageId = approvalRow.stageId;
  const instanceId = approvalRow.instanceId;

  if (decision === "denied") {
    await applyEvent(dbx, instanceId, { kind: "approval_denied", stageId }, deciderUserId);
    return null;
  }
  // ADR-0168 — send back for information: ONE approver's return sends the
  // instance back to its artifact stage whatever the quorum (a return is a
  // request for a new version, and every other pending gate on the stage is
  // superseded by applyEvent). The next artifact version re-requests sign-off.
  if (decision === "returned") {
    await applyEvent(dbx, instanceId, { kind: "approval_returned", stageId }, deciderUserId);
    return null;
  }

  // ADR-0021 approval quorum: 'all' (default, today) = every named approver
  // must approve before the stage advances; 'any' = the FIRST approval
  // advances it and the remaining pending rows are superseded (a dead gate is
  // never left decidable).
  // ADR-0027 (the deferral recorded in ADR-0021, now closed): a
  // human_approval STAGE may carry its own quorum override, which beats the
  // org default in BOTH directions — a template can demand 'all' in an 'any'
  // org and vice versa. Absent (every pre-ADR-0027 template) = the org
  // default = today's behaviour.
  const [instRow] = await dbx
    .select({ definition: workflowInstances.definition })
    .from(workflowInstances)
    .where(eq(workflowInstances.id, instanceId));
  const stageQuorum = (
    (instRow?.definition as { stages?: Array<{ id: string; quorum?: "all" | "any" }> })?.stages ?? []
  ).find((s) => s.id === stageId)?.quorum;
  const quorum = stageQuorum ?? (await loadOrgSettings(dbx as Db)).approvalQuorum;

  // The quorum test is evaluated INSIDE applyEvent's instance lock, so a
  // re-open that inserts fresh rows (or another approver) serializes with the
  // grant instead of racing it. A stale or wrong-stage decision is
  // additionally rejected by the kernel's stage check.
  const r = await applyEvent(
    dbx,
    instanceId,
    { kind: "approval_granted", stageId },
    deciderUserId,
    async (tx) => {
      if (quorum === "any") {
        // first-approval-wins: supersede the stage's other pending rows so no
        // ghost gate outlives the advance, then let the grant through.
        await tx
          .update(approvals)
          .set({ status: "superseded" })
          .where(
            and(
              eq(approvals.instanceId, instanceId),
              eq(approvals.stageId, stageId),
              eq(approvals.status, "pending"),
            ),
          );
        return true;
      }
      const pending = await tx
        .select({ id: approvals.id })
        .from(approvals)
        .where(
          and(
            eq(approvals.instanceId, instanceId),
            eq(approvals.stageId, stageId),
            eq(approvals.status, "pending"),
          ),
        );
      return pending.length === 0;
    },
  );
  if (r.skipped) return null;
  // an approval can unblock straight into a git stage (e.g. merge gate →
  // merge) — executed post-commit, against the real Db
  return async (db) => {
    await runGitExecutions(db, instanceId, r.effects, deciderUserId, dataKey);
  };
}

/**
 * AER-049 — THE GENERIC RE-OPEN. Takes the instance back to `stageId` (a stage
 * it already passed; a COMPLETED instance included — e.g. the recertification
 * sweep re-opening an approved intake to its sign-off) through the kernel's
 * `reopen` event, so it gets exactly what every other re-open gets under the
 * one instance lock: the round moves on, the stage entry moves on, stale check
 * results are cleared, outstanding gates are superseded, the effect records of
 * every stage that runs again move to `effects:history` (audited
 * `workflow:effects-archived`), and the gate(s) it runs forward into are
 * requested again. May run on the caller's open transaction (it nests as a
 * savepoint). Returns the post-commit step — executing any git/deploy/build
 * stage the re-open runs straight into — for the caller to run once its
 * transaction is durable. Throws WorkflowStateError when the instance cannot
 * be re-opened there (aborted/denied/rolled back, or a stage not yet passed).
 */
export async function reopenWorkflowInstance(
  dbx: DbOrTx,
  instanceId: string,
  opts: { stageId: string; reason: string; actorUserId: string | null; dataKey?: string },
): Promise<{ state: InstanceState; round: number; postCommit: ApprovalPostCommit }> {
  const r = await applyEvent(dbx, instanceId, { kind: "reopen", stageId: opts.stageId, reason: opts.reason }, opts.actorUserId);
  const [row] = await dbx
    .select({ round: workflowInstances.round })
    .from(workflowInstances)
    .where(eq(workflowInstances.id, instanceId));
  return {
    state: r.state,
    round: row?.round ?? 0,
    postCommit: async (db) => {
      await runGitExecutions(db, instanceId, r.effects, opts.actorUserId, opts.dataKey);
    },
  };
}

export interface WorkflowRouteOptions {
  /** hex AES-256 key for git-connection tokens; absent = git features refused */
  dataKey?: string;
  /** ADR-0080: called (post-transition, best-effort ordering with the response)
   * after a human-driven route moves an instance — artifact submit, advance,
   * abort — so a dependent object (the AI use-case registry) can mirror the
   * instance's status. The DECIDE path is covered separately inside the one
   * approvals transaction in app.ts; this hook exists because those three
   * routes live here and app.ts composes the modules (no import cycle). */
  onInstanceTransition?: (db: Db, instanceId: string, actorUserId: string | null) => Promise<void>;
}

/** §8 nesting: called from the orchestration run-event funnel when a run
 * bound to a workflow instance reaches a terminal state. A completed run
 * advances the instance's awaiting build stage; an aborted run records an
 * execution failure and leaves the stage retryable via /advance (which
 * spawns a fresh run). Stale or mismatched notifications are skipped —
 * the instance's own state decides. */
export async function handleNestedRunCompletion(
  db: Db,
  dataKey: string | undefined,
  run: { id: string; workflowInstanceId: string | null; status: string },
  actorUserId: string | null,
): Promise<void> {
  if (!run.workflowInstanceId) return;
  const [instance] = await db
    .select()
    .from(workflowInstances)
    .where(eq(workflowInstances.id, run.workflowInstanceId));
  if (!instance || instance.status !== "awaiting_execution") return;
  const def = instance.definition as WorkflowDefinition;
  const state = instance.state as InstanceState;
  const stage = def.stages[state.currentStageIndex];
  if (!stage || stage.type !== "automated_build" || stage.run === undefined) return;
  const context = instance.context as Record<string, unknown>;
  if (context[`runId:${stage.id}`] !== run.id) return; // not the run this stage is waiting on

  // AER-048 (review item 5): the read above is unlocked and only a filter.
  // The transition applies only if, UNDER THE ROW LOCK, the instance is still
  // waiting on THIS run at THIS stage — a re-open (which clears runId:<stage>)
  // or a retry that planned a newer run committed in between makes this a
  // stale notification, and it changes nothing.
  const stillWaitingOnThisRun = async (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]): Promise<boolean> => {
    const [row] = await tx.select().from(workflowInstances).where(eq(workflowInstances.id, instance.id));
    if (!row || row.status !== "awaiting_execution") return false;
    const cur = (row.definition as WorkflowDefinition).stages[(row.state as InstanceState).currentStageIndex];
    return cur?.id === stage.id && (row.context as Record<string, unknown>)[`runId:${stage.id}`] === run.id;
  };
  if (run.status === "completed") {
    const r = await applyEvent(
      db,
      instance.id,
      { kind: "execution_succeeded", stageId: stage.id },
      actorUserId,
      stillWaitingOnThisRun,
    );
    if (r.skipped) return;
    // completion can flow straight into a downstream git stage
    await runGitExecutions(db, instance.id, r.effects, actorUserId, dataKey);
  } else {
    // AER-048: a key-level merge under the same lock, never a write-back of
    // the (unlocked) context read above
    const patch = JSON.stringify({ lastError: `${stage.id}: nested run ${run.id} aborted` });
    await applyEvent(
      db,
      instance.id,
      { kind: "execution_failed", stageId: stage.id, error: `nested run ${run.id} aborted` },
      actorUserId,
      async (tx) => {
        if (!(await stillWaitingOnThisRun(tx))) return false;
        await tx
          .update(workflowInstances)
          .set({ context: sql`${workflowInstances.context} || ${patch}::jsonb` })
          .where(eq(workflowInstances.id, instance.id));
        return true;
      },
    );
  }
}

/** AER-047: the detail every auto-passed (opt-in, offline) check carries */
export const CHECK_AUTO_PASSED_DETAIL = "auto-passed — no report (offline mode)";
/** AER-047: the detail a check with no reported result carries while it waits */
export const CHECK_PENDING_DETAIL = "pending — no result has been reported for this check";

/** AER-047: the env var a process sets (to exactly `1`) to DECLARE itself an
 * offline/demo box on which a template's `offlineAutoPass` may be honoured */
export const OFFLINE_CHECKS_ENV = "REGULAIT_OFFLINE_CHECKS";

/**
 * AER-047 — why THIS process will not honour a template's `offlineAutoPass`,
 * or null when it will. FAIL CLOSED: the opt-in needs a POSITIVE declaration
 * (`REGULAIT_OFFLINE_CHECKS=1`, which the demo seed and the demo's gateway
 * terminal set), and is refused regardless whenever the process shows a sign
 * of being deployed (ADR-0167's `networkFacingSignal`). Absence of a deployed
 * signal is NOT proof of a laptop — a bare `docker compose --profile tls` on a
 * public host sets neither REGULAIT_DEPLOY_MODE nor REGULAIT_HSTS — so the
 * heuristic only ever narrows the opt-in, it never grants it.
 */
export function offlineAutoPassRefusal(
  env: NodeJS.ProcessEnv,
): { reason: string; deployedSignal?: string } | null {
  const deployedSignal = networkFacingSignal(env);
  if (deployedSignal !== null) return { reason: `this box is deployed: ${deployedSignal}`, deployedSignal };
  if ((env[OFFLINE_CHECKS_ENV] ?? "").trim() !== "1") {
    return { reason: `this process never declared offline mode (${OFFLINE_CHECKS_ENV}=1 is not set)` };
  }
  return null;
}

/** one evaluated check as it lands in context[`checks:<stageId>`] */
type EvaluatedCheck = {
  check: string;
  /** "pending" (AER-047) = nobody reported it; the stage waits */
  status: "passed" | "failed" | "pending";
  severity: string | null;
  detail: string;
  /** AER-047: true ONLY when the template's offlineAutoPass opt-in passed a
   * check nobody reported — every surface labels it */
  autoPassed?: true;
  selfReported?: true;
  reportedByUserId?: string | null;
  reason?: string | null;
  eval?: Record<string, unknown>;
};

/** the shape one named check resolves to inside the check executor */
interface CheckOutcome {
  check: string;
  status: "passed" | "failed";
  severity: string | null;
  detail: string;
  /** ADR-0044: present only for eval-bound checks — the run id, the aggregate
   * and the baseline delta, so the workflow rail can show WHY it went red */
  eval?: Record<string, unknown>;
}

/**
 * ADR-0044 — THE BLOCK-ON-REGRESSION GATE.
 *
 * Runs each eval binding declared on this check stage and turns the gate
 * decision into an ordinary check result. Three properties are load-bearing:
 *
 *  1. IT REUSES THE EXISTING FAILURE PATH. A regression returns
 *     `status: 'failed'`, which the caller folds into the same results array
 *     every reported failure lands in, which raises the same `check_failed`
 *     event, which routes to `blocked_on_check` (or the stage's rollback
 *     target). There is no second mechanism and no special-cased status.
 *
 *  2. IT RUNS AS THE INSTANCE INITIATOR. Exactly like the nested-run path
 *     (`planRun`), so the eval's dispatches are bounded by the initiating
 *     user's entitlements and the instance's project budget. A workflow cannot
 *     be used to reach a model its initiator may not reach.
 *
 *  3. A CHECK THAT COULD NOT RUN FAILS. An unknown dataset, an unknown agent,
 *     a denied entitlement or a thrown error all produce `failed`, never a
 *     pass. A quality gate that silently degrades to green is the specific
 *     failure this whole ADR exists to prevent.
 */
async function runStageEvalChecks(
  db: Db,
  instance: { id: string; initiatorUserId: string; projectId: string | null },
  stage: WorkflowDefinition["stages"][number],
  dataKey: string | undefined,
): Promise<Map<string, CheckOutcome>> {
  // AER-048: the barrier the round-token tests park an executor on, mid-eval
  if (workflowTestHooks.duringStageEval) {
    await workflowTestHooks.duringStageEval({ instanceId: instance.id, stageId: stage.id });
  }
  const out = new Map<string, CheckOutcome>();
  const bindings = stage.evals ?? [];
  if (bindings.length === 0) return out;
  const declared = new Set(stage.checks ?? []);
  for (const binding of bindings) {
    if (!declared.has(binding.check)) continue;
    const fail = (detail: string, extra?: Record<string, unknown>): void => {
      out.set(binding.check, {
        check: binding.check,
        status: "failed",
        severity: "high",
        detail,
        eval: { dataset: binding.dataset, agent: binding.agent, ...(extra ?? {}) },
      });
    };
    // resolve the PINNED dataset version: an explicit `version`, else the
    // highest existing one at the moment the stage runs
    const versions = await db
      .select()
      .from(evalDatasets)
      .where(eq(evalDatasets.name, binding.dataset))
      .orderBy(desc(evalDatasets.version));
    const dataset = binding.version
      ? versions.find((d) => d.version === binding.version)
      : versions[0];
    if (!dataset) {
      fail(
        `eval dataset '${binding.dataset}'${binding.version ? ` v${binding.version}` : ""} does not exist — the quality gate could not run, so it does not pass`,
      );
      continue;
    }
    const [agentRow] = await db.select().from(agents).where(eq(agents.name, binding.agent));
    if (!agentRow) {
      fail(`eval agent '${binding.agent}' is not in the registry — the quality gate could not run, so it does not pass`);
      continue;
    }
    let judgeAgentId: string | null = null;
    if (binding.judgeAgent) {
      const [judgeRow] = await db.select().from(agents).where(eq(agents.name, binding.judgeAgent));
      if (!judgeRow) {
        fail(`eval judge agent '${binding.judgeAgent}' is not in the registry`);
        continue;
      }
      judgeAgentId = judgeRow.id;
    }
    try {
      const outcome = await runEvalSuite(db, dataKey, {
        datasetId: dataset.id,
        agentId: agentRow.id,
        userId: instance.initiatorUserId,
        trigger: "workflow",
        judgeAgentId,
        projectId: instance.projectId,
        tolerance: binding.tolerance ?? 0.05,
        minScore: binding.minScore ?? null,
        minPassRate: binding.minPassRate ?? null,
        requireBaseline: binding.requireBaseline ?? false,
        workflow: { instanceId: instance.id, stageId: stage.id, checkName: binding.check },
      });
      if (!outcome.ok) {
        fail(
          `eval '${binding.dataset}' could not run against '${binding.agent}': ${outcome.error}${outcome.detail ? ` — ${outcome.detail}` : ""}`,
          { error: outcome.error },
        );
        continue;
      }
      out.set(binding.check, {
        check: binding.check,
        status: outcome.gate.passed ? "passed" : "failed",
        severity: outcome.gate.passed ? null : outcome.gate.regression ? "high" : "medium",
        detail: `${binding.dataset} v${dataset.version} on '${binding.agent}': ${outcome.gate.reason}`,
        eval: {
          runId: outcome.run.id,
          dataset: dataset.name,
          datasetVersion: dataset.version,
          agent: agentRow.name,
          model: agentRow.model,
          meanScore: outcome.aggregate.meanScore,
          passRate: outcome.aggregate.passRate,
          cases: outcome.aggregate.cases,
          scoreDelta: outcome.gate.scoreDelta,
          baselineRunId: outcome.baseline?.id ?? null,
          regression: outcome.gate.regression,
          costUsd: outcome.run.costUsd,
        },
      });
    } catch (e) {
      fail(`eval '${binding.dataset}' errored: ${(e as Error).message}`);
    }
  }
  return out;
}

/**
 * Execute pending executable stages (git operations, nested build runs, and
 * automated checks) until the instance blocks on something else. Each stage's
 * result lands in instance.context; failures are recorded as execution_failed
 * events and leave the stage retryable via /advance.
 */
async function runGitExecutions(
  db: Db,
  instanceId: string,
  effects: Effect[],
  actorUserId: string | null,
  dataKey: string | undefined,
  /** AER-048 (review item 3): 1 inside the single follow-up evaluation a check
   * executor that ended WITHOUT committing runs when reports arrived during
   * its claim — never more than one level */
  reevalDepth = 0,
): Promise<Effect[]> {
  let pending = effects.filter((e) => e.kind === "execute_stage");
  let lastEffects = effects;
  while (pending.length > 0) {
    const effect = pending[0]! as Extract<Effect, { kind: "execute_stage" }>;

    // Validate state and CLAIM the stage before any provider side effect: the
    // instance must actually be awaiting execution of exactly this stage, and
    // only one executor may hold the claim. A denied/aborted/completed
    // instance or a stale/concurrent /advance never reaches the provider.
    const claimed = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(workflowInstances)
        .where(eq(workflowInstances.id, instanceId))
        .for("update");
      if (!row || row.status !== "awaiting_execution") return null;
      const rowDef = row.definition as WorkflowDefinition;
      const rowState = row.state as InstanceState;
      const current = rowDef.stages[rowState.currentStageIndex];
      if (!current || current.id !== effect.stageId) return null;
      const ctx = { ...(row.context as Record<string, unknown>) };
      const held = stageClaimState(ctx, effect.stageId, Date.now(), stageClaimTtlMs(), row.stageEntry);
      if (held.heldLive) return "held" as const; // another executor holds it
      // AER-048: the claim names the stage ENTRY it was taken under and carries
      // a unique id, so this executor's completion can prove it is still the
      // one the instance is waiting on (commitStageResult)
      const claimId = randomUUID();
      ctx.executing = effect.stageId;
      ctx.executingSince = new Date().toISOString();
      ctx.executingEntry = row.stageEntry;
      ctx.executingClaim = claimId;
      await tx.update(workflowInstances).set({ context: ctx }).where(eq(workflowInstances.id, row.id));
      return {
        instance: { ...row, context: ctx },
        expiredClaimSince: held.expiredSince,
        guard: { instanceId: row.id, stageId: effect.stageId, entry: row.stageEntry, round: row.round, claimId },
      };
    });
    if (claimed === "held") throw new StageClaimHeldError(effect.stageId);
    if (!claimed) {
      throw new WorkflowStateError(
        `stage '${effect.stageId}' is not currently executable for this instance`,
      );
    }
    const instance = claimed.instance;
    const guard = claimed.guard;
    const def = instance.definition as WorkflowDefinition;
    const stage = def.stages.find((st) => st.id === effect.stageId)!;
    const context = { ...(instance.context as Record<string, unknown>) };
    // AER-048: what the context looked like when the claim was taken. The
    // executor OWNS exactly the keys it changes relative to this snapshot;
    // completion merges only those into the row as it is THEN (re-read FOR
    // UPDATE), so a report or re-open that committed meanwhile survives.
    const snapshot = { ...(instance.context as Record<string, unknown>) };
    const finish = async (
      event: WorkflowEvent | null,
      deployMode?: "hosted" | "byoc" | "air_gapped" | null,
    ): Promise<StageCommit> => {
      const owned = ownedKeyChanges(snapshot, context);
      return commitStageResult(
        db,
        guard,
        actorUserId,
        (fresh) => {
          for (const k of owned) {
            if (k in context) fresh[k] = context[k];
            else delete fresh[k];
          }
          return { event, deployMode: deployMode ?? null };
        },
        { discardedKeys: owned, ...(event ? { discardedEvent: event.kind } : {}) },
        { snapshot, context },
      );
    };
    // AER-048 (review item 3): a check executor that ends WITHOUT committing
    // (its result discarded, or a throw) must not leave a report that arrived
    // during its claim unevaluated until the claim TTL — the report route
    // answered that report 202 "deferred to the running executor". So once,
    // and only if the stored reports moved since the claim, the stage is
    // evaluated again. If it is no longer executable (re-opened) or another
    // executor holds it, that is fine: they own the reports now.
    /** AER-048 (review item 1): every external effect this executor makes is
     * an audit row of its own, whatever later happens to its result */
    const effectAudit = <T,>(summarize: (r: T) => Record<string, unknown>): ExternalWriteAudit<T> => ({
      userId: actorUserId ?? "00000000-0000-0000-0000-000000000000",
      objectType: "workflow",
      objectId: instance.id,
      detail: { stageId: stage.id, stageEntry: guard.entry, round: guard.round },
      summarize,
    });
    const reevaluateIfReportsArrived = async (): Promise<void> => {
      if (stage.type !== "automated_check" || reevalDepth > 0) return;
      const key = `reported:${stage.id}`;
      const [now] = await db
        .select({ context: workflowInstances.context })
        .from(workflowInstances)
        .where(eq(workflowInstances.id, instanceId));
      if (!now) return;
      const stored = (now.context as Record<string, unknown>)[key];
      if (JSON.stringify(stored ?? null) === JSON.stringify(snapshot[key] ?? null)) return;
      try {
        await runGitExecutions(db, instanceId, [{ kind: "execute_stage", stageId: stage.id }], actorUserId, dataKey, 1);
      } catch (err) {
        if (!(err instanceof WorkflowStateError)) {
          console.error(`re-evaluation of '${stage.id}' on ${instanceId} failed: ${(err as Error).message}`);
        }
      }
    };
    if (claimed.expiredClaimSince !== null) {
      // REL-06: a claim nobody released — a process killed mid-stage — is
      // re-taken after its TTL rather than stranding the instance at
      // awaiting_execution forever, and the re-take is on the record.
      await db.insert(auditLog).values({
        userId: actorUserId ?? "00000000-0000-0000-0000-000000000000",
        objectType: "workflow",
        objectId: instance.id,
        detail: { stageId: stage.id, claimedSince: claimed.expiredClaimSince, ttlMs: stageClaimTtlMs() },
        effect: "allow",
        ruleId: "workflow-stage-claim-expired",
        ruleChain: [],
        reason: `stage '${stage.id}' execution claim from ${claimed.expiredClaimSince} was never released — re-claimed after the ${stageClaimTtlMs()} ms TTL`,
      });
    }
    try {

    // §8 nesting: an automated_build stage with a run graph spawns a nested
    // orchestration run instead of a git operation — planned under the
    // INSTANCE INITIATOR's entitlements (planRun), driven by the normal run
    // endpoints, completing the stage via handleNestedRunCompletion when the
    // run turns terminal. Idempotent: a live or completed run for this stage
    // is never duplicated; only an aborted one is replaced on retry.
    if (stage.type === "automated_build" && stage.run !== undefined) {
      releaseStageClaim(context);
      const existingId = context[`runId:${stage.id}`];
      if (typeof existingId === "string") {
        const [existing] = await db
          .select()
          .from(orchestrationRuns)
          .where(eq(orchestrationRuns.id, existingId));
        if (existing && existing.status !== "aborted") {
          // replay after a missed completion notification, or (planned/
          // running) the stage simply waits for the run
          const r = await finish(
            existing.status === "completed" ? { kind: "execution_succeeded", stageId: stage.id } : null,
          );
          if (r.committed && existing.status === "completed") {
            lastEffects = r.effects;
            pending = r.effects.filter((e) => e.kind === "execute_stage");
            continue;
          }
          break;
        }
      }
      const planned = await planRun(db, instance.initiatorUserId, stage.run, instance.id, instance.projectId ?? null, dataKey);
      if (!planned.ok) {
        const error = `nested run rejected: ${JSON.stringify(planned.body)}`;
        context.lastError = `${stage.id}: ${error}`;
        await finish({ kind: "execution_failed", stageId: stage.id, error });
        break;
      }
      context[`runId:${stage.id}`] = planned.run.id;
      delete context.lastError;
      await finish(null);
      break; // stage stays awaiting_execution until the run completes
    }

    // §2 stage 8: the check executor. Each named check resolves to a result:
    // an eval-bound check (ADR-0044) by RUNNING its dataset; otherwise a result
    // REPORTED for it (via POST .../checks — a real CI posts here; the seed and
    // tests post here for the demo) wins, PASS or FAIL. A check NOBODY reported
    // is PENDING (AER-047 / PENDING L1): it never passes on silence. Before
    // AER-047 it fell back to a deterministic offline auto-pass, so a gate
    // approved before CI posted sailed through with every check "passed".
    //
    //   - any FAILED check → check_failed (blocked_on_check, or the stage's
    //     rollback target) — a reported failure blocks even while others wait;
    //   - otherwise any PENDING check → the instance WAITS at
    //     awaiting_execution (the claim is released, nothing advances), with an
    //     audit row naming the missing checks; the next report re-evaluates;
    //   - otherwise → execution_succeeded.
    //
    // A template may opt back into the offline behaviour ONLY through the typed
    // stage field `offlineAutoPass: true`, and every auto-passed result says so
    // (`autoPassed: true`, "auto-passed — no report (offline mode)") in the
    // context, the audit trail, the rail and the approval view. The opt-in
    // FAILS CLOSED: it is honoured only in a process that positively declares
    // offline mode (REGULAIT_OFFLINE_CHECKS=1 — the demo seed and the demo's
    // gateway terminal) and never on a box that shows a sign of being deployed,
    // so a production configuration cannot pass a check nobody ran
    // (offlineAutoPassRefusal).
    if (stage.type === "automated_check") {
      const declaredChecks = stage.checks ?? [];
      // ADR-0044: checks bound to an evaluation dataset are decided by RUNNING
      // it, here, under the instance initiator's entitlements — never by a
      // reported result (POST .../checks refuses to report against them) and
      // never by an offline auto-pass. A regression produces status 'failed',
      // which then flows into the SAME check_failed event every other failing
      // check uses; there is no second failure path.
      const evalBound = new Set((stage.evals ?? []).map((e) => e.check));
      const refusal = stage.offlineAutoPass === true ? offlineAutoPassRefusal(process.env) : null;
      const autoPassHonoured = stage.offlineAutoPass === true && refusal === null;
      // The evals run ONCE per stage entry, as they did before AER-047, not
      // once per re-evaluation. While the stage WAITS on reported checks
      // (context[awaitingReport:<id>] is set) every partial report and every
      // retried /advance re-evaluates it; re-running the datasets each time
      // would spend the initiator's and the project's budget only to wait
      // again. So within one waiting episode the outcome recorded when the
      // stage was entered is reused. A failing eval never waits (failures
      // block at once), a recheck from blocked_on_check is not a waiting
      // episode and re-runs them, and a re-open clears the episode.
      const waitKey = `awaitingReport:${stage.id}`;
      const episodeEvals = new Map<string, CheckOutcome>();
      if (typeof context[waitKey] === "string" && Array.isArray(context[`checks:${stage.id}`])) {
        for (const r of context[`checks:${stage.id}`] as EvaluatedCheck[]) {
          if (r && evalBound.has(r.check) && r.status === "passed" && r.eval) {
            episodeEvals.set(r.check, { check: r.check, status: "passed", severity: r.severity, detail: r.detail, eval: r.eval });
          }
        }
      }
      const declaredEvals = declaredChecks.filter((n) => evalBound.has(n));
      // the slow part — possibly seconds of eval dispatches — runs OUTSIDE any
      // lock, on the claim alone
      const evalOutcomes =
        declaredEvals.length > 0 && declaredEvals.every((n) => episodeEvals.has(n))
          ? episodeEvals
          : await runStageEvalChecks(db, instance, stage, dataKey);

      // AER-048 — the VERDICT is decided at commit, under the row lock, from
      // the reports stored THEN (not the ones snapshotted at claim time). A
      // report posted while the evals ran is therefore part of this verdict
      // rather than overwritten by it, and a re-open or a re-taken claim
      // discards the whole result (commitStageResult) instead of restoring the
      // check keys the re-open cleared.
      let waited = false;
      const r = await commitStageResult(
        db,
        guard,
        actorUserId,
        (fresh, row) => {
          // reports stamped with another round never count (a re-open clears
          // them anyway; this is the belt to that brace)
          const reported = normalizeCheckReports(fresh[`reported:${stage.id}`]).filter(
            (rep) => rep.round === undefined || rep.round === row.round,
          );
          const byName = new Map(reported.map((rep) => [rep.check, rep]));
          const results: EvaluatedCheck[] = declaredChecks.map((name): EvaluatedCheck => {
            const ev = evalOutcomes.get(name);
            if (ev) return ev;
            // ADR-0044 property 3: an eval-bound check that produced no outcome
            // could not run, so it FAILS — never reported, never auto-passed
            if (evalBound.has(name)) {
              return {
                check: name,
                status: "failed",
                severity: "high",
                detail: "the eval produced no outcome — the quality gate could not run, so it does not pass",
              };
            }
            const rep = byName.get(name);
            if (rep) {
              return {
                check: name,
                status: rep.status,
                severity: rep.severity ?? null,
                detail: rep.detail ?? `reported ${rep.status}`,
                // ADR-0167 (AUTHZ-06): the provenance rides into the evaluated
                // result, so the rail and the approval view can say "the
                // initiator reported this green" rather than showing CI's colour
                ...(rep.selfReported
                  ? { selfReported: true, reportedByUserId: rep.reportedByUserId ?? null, reason: rep.reason ?? null }
                  : {}),
              };
            }
            return autoPassHonoured
              ? { check: name, status: "passed", severity: null, detail: CHECK_AUTO_PASSED_DETAIL, autoPassed: true }
              : { check: name, status: "pending", severity: null, detail: CHECK_PENDING_DETAIL };
          });
          const failures = results.filter((x) => x.status === "failed").map((x) => x.check);
          const missing = results.filter((x) => x.status === "pending").map((x) => x.check);
          const autoPassed = results.filter((x) => x.autoPassed).map((x) => x.check);
          const waiting = failures.length === 0 && missing.length > 0;
          waited = waiting;
          fresh[`checks:${stage.id}`] = results;
          if (evalOutcomes.size > 0) {
            fresh[`evals:${stage.id}`] = Object.fromEntries(
              [...evalOutcomes].map(([name, x]) => [name, x.eval]),
            );
          }
          // One waiting audit row per DISTINCT waiting state, not per
          // re-evaluation: an initiator retrying /advance, or a CI posting one
          // check at a time, writes a row only when the set of missing checks (or
          // why the opt-in was refused) actually changes.
          const waitSignature = waiting
            ? JSON.stringify({ missing, refused: refusal?.reason ?? null })
            : null;
          const sameWait = waiting && fresh[waitKey] === waitSignature;
          if (waiting) fresh[waitKey] = waitSignature;
          else delete fresh[waitKey];
          delete fresh.lastError;
          const audits: AuditInsert[] = [];
          if (waiting && !sameWait) {
            // WAIT. No kernel event: the instance stays awaiting_execution on
            // THIS stage, which is exactly the state POST .../checks
            // re-evaluates from, so the next reported result picks it up.
            // Nothing advances on silence.
            audits.push({
              userId: actorUserId ?? "00000000-0000-0000-0000-000000000000",
              objectType: "workflow",
              objectId: instance.id,
              detail: {
                stageId: stage.id,
                missingChecks: missing,
                ...(refusal
                  ? {
                      offlineAutoPassRefused: true,
                      refusedBecause: refusal.reason,
                      ...(refusal.deployedSignal ? { deployedSignal: refusal.deployedSignal } : {}),
                    }
                  : {}),
              },
              effect: "allow",
              ruleId: "workflow:checks-awaiting-report",
              ruleChain: [],
              reason:
                `stage '${stage.id}' is waiting on ${missing.length} check(s) with no reported result: ${missing.join(", ")} — ` +
                `a check nobody reported never passes; the stage re-evaluates when a result is posted` +
                (refusal ? ` (the template opts into offlineAutoPass, ignored because ${refusal.reason})` : ""),
            });
          }
          if (!waiting && failures.length === 0 && autoPassed.length > 0) {
            audits.push({
              userId: actorUserId ?? "00000000-0000-0000-0000-000000000000",
              objectType: "workflow",
              objectId: instance.id,
              detail: { stageId: stage.id, autoPassedChecks: autoPassed, offlineAutoPass: true },
              effect: "allow",
              ruleId: "workflow:checks-auto-passed",
              ruleChain: [],
              reason:
                `stage '${stage.id}': ${autoPassed.length} check(s) auto-passed — no report (offline mode): ${autoPassed.join(", ")} — ` +
                `the template opts into offlineAutoPass; nothing ran these checks`,
            });
          }
          return {
            event: waiting
              ? null
              : failures.length > 0
                ? { kind: "check_failed", stageId: stage.id, failures }
                : { kind: "execution_succeeded", stageId: stage.id },
            audits,
          };
        },
        {
          discardedKeys: [`checks:${stage.id}`, `evals:${stage.id}`, waitKey],
          ...(evalOutcomes.size > 0
            ? { discardedEvals: Object.fromEntries([...evalOutcomes].map(([name, x]) => [name, x.status])) }
            : {}),
        },
      );
      if (!r.committed) {
        await reevaluateIfReportsArrived();
        break;
      }
      if (waited) break;
      lastEffects = r.effects;
      pending = r.effects.filter((e) => e.kind === "execute_stage");
      continue;
    }

    // §2 the DEPLOY executor. Gated on (a) a configured deploy target existing
    // and (b) an optional stage condition matching the change; if either fails,
    // the stage parks at blocked_on_deploy (a manual handoff) instead of
    // deploying. Otherwise it deploys via the (mock/pluggable) adapter and
    // records the deployment in context so a later rollback can reverse it.
    // Idempotent: an existing deployment for this stage is never duplicated.
    if (stage.type === "deployment") {
      const [target] = stage.connection
        ? await db.select().from(deployTargets).where(eq(deployTargets.name, stage.connection))
        : [];
      const cond = stage.condition;
      const change = instance.change as { environment?: string; changeType?: string };
      const condValue = cond
        ? cond.field === "environment"
          ? change.environment
          : change.changeType
        : undefined;
      const condMet = !cond || condValue === cond.equals;
      const handoff = !target
        ? `no deploy target '${stage.connection}' is configured`
        : !condMet
          ? `condition not met: change ${cond!.field} is '${condValue ?? "unset"}', target requires '${cond!.equals}'`
          : null;
      if (handoff) {
        releaseStageClaim(context);
        const r = await finish(
          { kind: "deploy_blocked", stageId: stage.id, reason: handoff },
          // A4: the target may be missing here (that IS one of the handoffs)
          target?.mode ?? null,
        );
        if (!r.committed) break;
        lastEffects = r.effects;
        pending = [];
        continue;
      }
      let deployErr: string | null = null;
      let executionControlRefused = false;
      try {
        if (context[`deploy:${stage.id}`] === undefined) {
          const provider = resolveDeployProvider({
            provider: target!.provider,
            credential:
              dataKey && target!.credentialCiphertext
                ? decryptSecret(dataKey, target!.credentialCiphertext)
                : undefined,
            baseUrl: target!.baseUrl,
            roleArn: target!.roleArn,
            region: target!.region,
            // migration 0043: the row's validated per-kind config — row-first
            // over the legacy roleArn reuse and the gateway-wide env vars.
            providerConfig: target!.providerConfig,
            // REGULAIT_DEPLOY_LIVE wiring: flag off = {} (dry-run, byte-
            // identical); flag on = the real lazily-loading per-cloud client.
            ...liveDeployClients(target!.provider, process.env, target!.providerConfig),
          });
          // ASYNC-DEPLOY: awaited like every other async stage executor (git
          // ops, nested runs). The stage claim was taken in its own committed
          // transaction above and is released below after the provider call —
          // awaiting here holds no DB transaction or row lock open, and a
          // rejected promise lands in the same catch → deploy_blocked path.
          const res = await runExternalWrite(
            db,
            "deploy.deploy",
            () => provider.deploy(target!.name, target!.environment, instance.id),
            effectAudit((r) => ({ deployId: r.deployId, target: target!.name, environment: target!.environment, mode: target!.mode, dryRun: r.dryRun })),
          );
          // §3 the control-plane / agent-execution-plane data boundary: in
          // AIR_GAPPED mode NOTHING that could carry execution-plane detail
          // (the deploy URL, the provider detail string) is retained in the
          // control plane — only metadata (id, target, env, mode) is kept, so
          // the disclosed boundary holds. hosted/byoc keep the full record.
          // #79c honesty: dryRun is persisted in BOTH branches. It is pure
          // metadata (a boolean about how the control plane's own adapter
          // ran), so it does not cross the ADR-0015 air-gapped data boundary.
          context[`deploy:${stage.id}`] =
            target!.mode === "air_gapped"
              ? { deployId: res.deployId, target: target!.name, environment: target!.environment, mode: "air_gapped", dryRun: res.dryRun }
              : { ...res, target: target!.name, environment: target!.environment, mode: target!.mode };
          if (target!.mode !== "air_gapped") context.deployUrl = res.url;
        }
      } catch (err) {
        executionControlRefused = err instanceof ExternalEffectBlockedError;
        deployErr = err instanceof Error ? err.message : String(err);
      }
      releaseStageClaim(context);
      if (deployErr === null) delete context.lastError;
      else context.lastError = `${stage.id}: ${deployErr}`;
      // A deployment-wide stop is not a manual deploy handoff: leave the
      // claimed stage awaiting_execution so lifting the stop permits a retry.
      if (executionControlRefused) {
        await finish(null);
        break;
      }
      // a provider that isn't integrated yet → manual handoff (not a hard fail)
      if (deployErr !== null) {
        const r = await finish(
          { kind: "deploy_blocked", stageId: stage.id, reason: deployErr },
          target!.mode, // A4: the deploy-scoped audit row carries the target's mode
        );
        if (!r.committed) break;
        lastEffects = r.effects;
        pending = [];
        continue;
      }
      // #79c: a DRY-RUN must never satisfy a PRODUCTION deploy gate. The
      // recorded (possibly replayed) deployment carries dryRun; when the
      // target or the change names production, the stage parks at
      // blocked_on_deploy with the reason spelled out — an operator may
      // deploy-override after a real out-of-band deploy, exactly like any
      // other manual handoff. Non-production dry-runs advance (dev/staging
      // rehearsal stays useful) with the flag persisted and badged.
      {
        const recorded = context[`deploy:${stage.id}`] as { dryRun?: boolean } | undefined;
        const prodGate = target!.environment === "production" || change.environment === "production";
        if (recorded?.dryRun === true && prodGate) {
          const reason = `dry-run deploy cannot satisfy a production deploy gate: the '${target!.provider}' adapter ran in dry-run mode (no live mutation happened) — wire a live deploy client, or confirm an out-of-band production deploy via deploy-override`;
          context.lastError = `${stage.id}: ${reason}`;
          const r = await finish(
            { kind: "deploy_blocked", stageId: stage.id, reason },
            target!.mode, // A4
          );
          if (!r.committed) break;
          lastEffects = r.effects;
          pending = [];
          continue;
        }
      }
      const r = await finish(
        { kind: "execution_succeeded", stageId: stage.id },
        target!.mode, // A4: the successful deploy's audit row carries the mode
      );
      if (!r.committed) break;
      lastEffects = r.effects;
      pending = r.effects.filter((e) => e.kind === "execute_stage");
      continue;
    }

    // §2 the ROLLBACK executor — reached only via the post-deploy-verify jump.
    // Reverses the recorded deployment (the most recent deploy:* in context) and
    // ends the run at the terminal rolled_back.
    if (stage.type === "rollback") {
      const [target] = stage.connection
        ? await db.select().from(deployTargets).where(eq(deployTargets.name, stage.connection))
        : [];
      // the deployment to reverse: the newest recorded deploy in context
      const deployKeys = Object.keys(context).filter((k) => k.startsWith("deploy:"));
      const priorDeploy = deployKeys.length
        ? (context[deployKeys[deployKeys.length - 1]!] as { deployId?: string; target?: string })
        : undefined;
      let rbErr: string | null = null;
      try {
        if (context[`rollback:${stage.id}`] === undefined) {
          if (!target) throw new DeployProviderError(`no deploy target '${stage.connection}'`);
          const provider = resolveDeployProvider({
            provider: target.provider,
            credential:
              dataKey && target.credentialCiphertext
                ? decryptSecret(dataKey, target.credentialCiphertext)
                : undefined,
            baseUrl: target.baseUrl,
            roleArn: target.roleArn,
            region: target.region,
            // migration 0043: row-first per-kind config, as in the deploy executor
            providerConfig: target.providerConfig,
            // same REGULAIT_DEPLOY_LIVE wiring as the deploy executor
            ...liveDeployClients(target.provider, process.env, target.providerConfig),
          });
          // ASYNC-DEPLOY: awaited outside any transaction (same claim/release
          // semantics as the deploy executor); a rejection lands in this catch
          // and keeps the stage awaiting_execution (retryable), never terminal.
          const res = await runExternalWrite(
            db,
            "deploy.rollback",
            () => provider.rollback(target.name, priorDeploy?.deployId ?? "unknown"),
            effectAudit(() => ({ target: target.name, revertedDeployId: priorDeploy?.deployId ?? null })),
          );
          // §3 air-gapped boundary: keep only which deploy was reversed, not the
          // provider detail string (which could carry execution-plane info).
          context[`rollback:${stage.id}`] =
            target.mode === "air_gapped"
              ? { reverted: res.reverted, target: target.name, mode: "air_gapped" }
              : { ...res, target: target.name };
        }
      } catch (err) {
        rbErr = err instanceof Error ? err.message : String(err);
      }
      releaseStageClaim(context);
      if (rbErr === null) delete context.lastError;
      else context.lastError = `${stage.id}: ${rbErr}`;
      // a rollback that itself FAILS is a serious operator situation — it stays
      // awaiting_execution (retryable via /advance), never silently terminal.
      const r = await finish(
        rbErr !== null ? null : { kind: "rolled_back", stageId: stage.id },
        target?.mode ?? null, // A4
      );
      if (rbErr !== null || !r.committed) break;
      lastEffects = r.effects;
      pending = r.effects.filter((e) => e.kind === "execute_stage");
      continue;
    }

    let executionError: string | null = null;
    try {
      if (!dataKey) throw new GitProviderError("gateway has no data key configured");
      const [conn] = await db
        .select()
        .from(gitConnections)
        .where(eq(gitConnections.name, stage.connection!));
      if (!conn) throw new GitProviderError(`unknown git connection '${stage.connection}'`);
      // ADR-0034 amendment #2 — THE GIT `baseUrl`, BEHIND THE EGRESS GUARD.
      // An admin-typed GHE/self-hosted-GitLab/Bitbucket-DC/ADO root is the same
      // SSRF primitive as a custom model endpoint, and it carries a PAT. The
      // check runs on EVERY execution, not just at connection-create time,
      // because DNS moves and because connections written before this guard
      // existed are in the live database now. A refusal throws, so it becomes
      // this stage's `execution_failed` (the path's existing refusal shape —
      // there is no per-git-call HTTP boundary to 403 from) with nothing
      // leaving the box. A null baseUrl means the vendor default, which nobody
      // can type: unchecked, unguarded fetch, byte-identical behaviour.
      // ADR-0062 amends that last sentence for a STRICT posture only — see the
      // `else` branch below.
      let gitFetch: typeof fetch | undefined;
      if (conn.baseUrl) {
        gitFetch = (
          await guardConnectionCall(db, {
            surface: "git_connection",
            baseUrl: conn.baseUrl,
            userId: actorUserId,
            objectId: conn.id,
            label: `git connection '${conn.name}' (${conn.provider})`,
            detail: {
              connection: conn.name,
              provider: conn.provider,
              instanceId,
              stageId: stage.id,
              action: stage.action,
            },
          })
        ).fetchImpl;
      } else {
        // ADR-0062 — the compiled git endpoint (api.github.com, gitlab.com,
        // api.bitbucket.org). Under a strict posture the host must be in the
        // same egress allow-list; the refusal THROWS, so it becomes this
        // stage's `execution_failed` with nothing leaving the box — the
        // existing refusal shape on this path, which has no per-call HTTP
        // boundary to 403 from. Under `hosted` this is byte-identical.
        const { posture, allowList } = await loadCompiledEgressContext(db);
        const compiled = decideCompiledDefault({
          posture,
          surface: "git_connection",
          kind: conn.provider,
          defaultBaseUrl: gitDefaultBaseUrl(conn.provider),
          allowList,
        });
        if (!compiled.ok) {
          await auditCompiledDefaultDenied(db, {
            userId: actorUserId,
            surface: "git_connection",
            objectId: conn.id,
            kind: conn.provider,
            decision: compiled,
            posture,
            detail: {
              connection: conn.name,
              instanceId,
              stageId: stage.id,
              action: stage.action,
            },
          });
          throw new CompiledDefaultEgressBlockedError("git_connection", compiled);
        }
      }
      const provider = resolveProvider(
        {
          provider: conn.provider,
          token: decryptSecret(dataKey, conn.tokenCiphertext),
          baseUrl: conn.baseUrl,
        },
        gitFetch as unknown as Parameters<typeof resolveProvider>[1],
      );

      const change = instance.change as { description: string };
      if (stage.action === "create_branch") {
        // AER-049: a round after the first works on a FRESH branch named for
        // its round (`<base>-r<round>`) — the earlier round's branch (and its
        // PR, merged or not) is history, never reused. Round 0 keeps the
        // original name.
        const baseBranch = `${stage.branchPrefix ?? "regulait"}/${instance.id.slice(0, 8)}`;
        const branch = instance.round > 0 ? `${baseBranch}-r${instance.round}` : baseBranch;
        // Idempotent replay WITHIN the round: if we already created this
        // branch, re-execution succeeds without a provider call instead of
        // 422ing forever.
        if (context.branch !== branch) {
          await runExternalWrite(
            db,
            "git.create_branch",
            () => provider.createBranch(stage.repo!, branch, stage.base ?? "main"),
            effectAudit(() => ({ repo: stage.repo, branch })),
          );
          context.branch = branch;
        }
      } else if (stage.action === "open_pr" && context.prId !== undefined) {
        // idempotent replay: PR already open for this instance
      } else if (stage.action === "open_pr") {
        // §2 stage 7: PR description auto-linked to the requirements artifact
        const [latestArtifact] = await db
          .select()
          .from(workflowArtifacts)
          .where(eq(workflowArtifacts.instanceId, instance.id))
          .orderBy(desc(workflowArtifacts.version))
          .limit(1);
        // AER-049: the newest earlier-round PR this one replaces (a re-open
        // moved it to effects:history), named in the body for the reviewer
        const superseded = effectHistory(context)
          .filter((e) => e.round < instance.round && typeof e.values.prId === "string")
          .sort((a, b) => b.round - a.round)[0];
        const pr = await runExternalWrite(db, "git.open_pull_request", () => provider.openPullRequest(stage.repo!, {
          head: String(context.branch ?? ""),
          base: stage.base ?? "main",
          title: change.description,
          // AER-048 (review item 2): the two machine-readable lines a CI
          // reads at run start to bind its check report — POST .../checks
          // requires `round` from an API key. AER-049: a re-open past this
          // stage opens a NEW pull request for the new round, so the round
          // written here is the round of THIS pull request; CI may still
          // re-read it from GET /v1/workflows/instances/:id, and a 409
          // stale_check_report names the current one.
          body:
            `Workflow instance ${instance.id}
regulait-instance: ${instance.id}
regulait-round: ${instance.round}
` +
            (superseded
              ? `regulait-supersedes: round ${superseded.round} pull request ${String(superseded.values.prUrl ?? superseded.values.prId)}
`
              : "") +
            `
` +
            (latestArtifact
              ? `Signed-off ${latestArtifact.output} v${latestArtifact.version}:

${latestArtifact.content}`
              : "(no artifact)"),
        }), effectAudit((r) => ({ repo: stage.repo, prId: r.id, prUrl: r.url })));
        context.prId = pr.id;
        context.prUrl = pr.url;
      } else if (stage.action === "merge" && context.mergeSha === undefined) {
        const result = await runExternalWrite(
          db,
          "git.merge_pull_request",
          () => provider.mergePullRequest(stage.repo!, String(context.prId ?? ""), stage.strategy ?? "merge"),
          effectAudit((r) => ({ repo: stage.repo, prId: String(context.prId ?? ""), mergeSha: r.sha })),
        );
        context.mergeSha = result.sha;
      }
    } catch (err) {
      executionError = err instanceof Error ? err.message : String(err);
    }

    // Release the claim; record outcome. The kernel event application sits
    // OUTSIDE the provider try so a post-success DB hiccup is never recorded
    // as a failed (and re-runnable) git operation.
    releaseStageClaim(context);
    if (executionError === null) delete context.lastError;
    else context.lastError = `${stage.id}: ${executionError}`;

    if (executionError !== null) {
      await finish({ kind: "execution_failed", stageId: stage.id, error: executionError });
      break;
    }
    const r = await finish({ kind: "execution_succeeded", stageId: stage.id });
    if (!r.committed) break;
    lastEffects = r.effects;
    pending = r.effects.filter((e) => e.kind === "execute_stage");
    } catch (err) {
      // REL-06: a throw from anywhere between the claim and its release (a
      // nested-run lookup, an artifact read, a provider resolution) used to
      // leave `executing` set with nothing to clear it. Release it here —
      // only if this executor still holds it — and let the error propagate.
      await releaseStageClaimIfHeld(db, instance.id, stage.id, guard.claimId).catch(() => {});
      await reevaluateIfReportsArrived().catch(() => {});
      throw err;
    }
  }
  return lastEffects;
}

/** REL-06: how long an execution claim may go unreleased before another
 * executor may take it over (REGULAIT_WORKFLOW_CLAIM_TTL_MS, default 15 min —
 * the same horizon the ADR-0064 scheduler lease uses). */
export const DEFAULT_STAGE_CLAIM_TTL_MS = 15 * 60_000;

export function stageClaimTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.REGULAIT_WORKFLOW_CLAIM_TTL_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_STAGE_CLAIM_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_STAGE_CLAIM_TTL_MS;
}

/**
 * REL-06: is `stageId`'s execution claim held LIVE in this context? A claim
 * is live when it names this stage and was taken less than the TTL ago. A
 * claim with no `executingSince` (written before this field existed) or one
 * older than the TTL is EXPIRED: `heldLive` is false and `expiredSince`
 * carries what the record said, so the re-take can be audited.
 */
export function stageClaimState(
  ctx: Record<string, unknown>,
  stageId: string,
  now: number = Date.now(),
  ttlMs: number = stageClaimTtlMs(),
  /** AER-048: the instance's current stage_entry. A claim taken under a
   * different entry belongs to an executor whose result will be discarded,
   * so it is never live (applyEvent also drops it on every entry bump). */
  currentEntry?: number,
): { heldLive: boolean; expiredSince: string | null } {
  if (ctx.executing !== stageId) return { heldLive: false, expiredSince: null };
  if (currentEntry !== undefined && typeof ctx.executingEntry === "number" && ctx.executingEntry !== currentEntry) {
    return { heldLive: false, expiredSince: typeof ctx.executingSince === "string" ? ctx.executingSince : "unknown" };
  }
  const since = typeof ctx.executingSince === "string" ? Date.parse(ctx.executingSince) : NaN;
  if (Number.isFinite(since) && now - since < ttlMs) return { heldLive: true, expiredSince: null };
  return { heldLive: false, expiredSince: typeof ctx.executingSince === "string" ? ctx.executingSince : "unknown" };
}

/** the context keys that make up a stage execution claim */
const CLAIM_KEYS = ["executing", "executingSince", "executingEntry", "executingClaim"] as const;

/** drop the claim from an in-memory context (the normal release path) */
function releaseStageClaim(context: Record<string, unknown>): void {
  for (const k of CLAIM_KEYS) delete context[k];
}

/** drop the claim from the STORED context, only if it still names `stageId`
 * (and, AER-048, is still THIS executor's claim) — the error path, after an
 * unexpected throw mid-stage */
async function releaseStageClaimIfHeld(db: Db, instanceId: string, stageId: string, claimId?: string): Promise<void> {
  await db
    .update(workflowInstances)
    .set({
      context: sql`${workflowInstances.context} - 'executing' - 'executingSince' - 'executingEntry' - 'executingClaim'`,
    })
    .where(
      and(
        eq(workflowInstances.id, instanceId),
        sql`${workflowInstances.context}->>'executing' = ${stageId}`,
        ...(claimId ? [sql`${workflowInstances.context}->>'executingClaim' = ${claimId}`] : []),
      ),
    );
}

/** AER-048: thrown when another executor holds a LIVE claim on the stage — a
 * WorkflowStateError (409 on /advance, as before), told apart so the check
 * report route can rely on the holder folding the report in instead. */
export class StageClaimHeldError extends WorkflowStateError {
  constructor(stageId: string) {
    super(`stage '${stageId}' is not currently executable for this instance (another executor holds it)`);
  }
}

/**
 * AER-048 — TEST-ONLY barrier. Production never sets it. A test parks a
 * check executor inside `runStageEvalChecks` (the long, lock-free part of a
 * check stage) to commit a report, a re-open or a second executor in the
 * middle — deterministically, instead of racing a sleep.
 */
export const workflowTestHooks: {
  duringStageEval?: (at: { instanceId: string; stageId: string }) => Promise<void>;
  /** parks ANY executor after its work, just before its locked completion */
  beforeStageCommit?: (at: { instanceId: string; stageId: string }) => Promise<void>;
} = {};

type AuditInsert = typeof auditLog.$inferInsert;

/** what one executor iteration's claim was taken under */
interface StageGuard {
  instanceId: string;
  stageId: string;
  /** workflow_instances.stage_entry when the claim was taken */
  entry: number;
  /** workflow_instances.round when the claim was taken */
  round: number;
  /** context.executingClaim this executor wrote */
  claimId: string;
}

type StageCommit = { committed: true; effects: Effect[] } | { committed: false; reason: string };

/** AER-048 (review item 1): context keys that RECORD an external effect an
 * executor performed — and that the executors read back to stay idempotent
 * (a recorded deploy/branch/PR/merge/rollback/run is never performed again). */
function isEffectRecordKey(k: string): boolean {
  return (
    ["branch", "prId", "prUrl", "mergeSha", "deployUrl"].includes(k) ||
    k.startsWith("deploy:") ||
    k.startsWith("rollback:") ||
    k.startsWith("runId:")
  );
}

/**
 * AER-049 — EFFECT RECORDS BELONG TO THE ROUND THAT PRODUCED THEM.
 *
 * Owner decision (ADR-0168 afternoon amendment, item 1): "if something is
 * changing then we need an additional review round". Every effect record an
 * executor commits is STAMPED in `effects:stamps` with the round
 * (workflow_instances.round) and the stage that produced it. A re-open that
 * bumps the round (artifact resubmitted after its stage completed,
 * approval_returned, the generic `reopen` — recertification) MOVES every live
 * record of a stage that will run again into the append-only `effects:history`
 * list, so the new round's merge/deploy run again against a FRESH branch / PR /
 * deployment and never count an earlier round's as "already done". Records of
 * stages BEFORE the re-open point (which do not run again) stay live, keeping
 * their original stamp. Within one round the AER-048 salvage/idempotency
 * holds: a discarded executor's records are kept live, so nothing is performed
 * twice in the same round; a record salvaged from an executor of an EARLIER
 * round goes straight to history.
 */
export const EFFECT_STAMPS_KEY = "effects:stamps";
export const EFFECT_HISTORY_KEY = "effects:history";

/** one live record's stamp */
export interface EffectStamp {
  round: number;
  stageId: string;
}

/** one append-only history entry: the records of ONE round that were archived */
export interface EffectHistoryEntry {
  round: number;
  keys: string[];
  values: Record<string, unknown>;
  at: string;
  /** why they left the live context */
  source: "reopen" | "discarded-executor";
  /** the round that replaced them */
  archivedInRound: number;
}

function effectStamps(ctx: Record<string, unknown>): Record<string, EffectStamp> {
  const v = ctx[EFFECT_STAMPS_KEY];
  return v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, EffectStamp>) } : {};
}

function effectHistory(ctx: Record<string, unknown>): EffectHistoryEntry[] {
  const v = ctx[EFFECT_HISTORY_KEY];
  return Array.isArray(v) ? [...(v as EffectHistoryEntry[])] : [];
}

/** the stage that produced an effect record: its stamp, else (a record written
 * before stamps existed) the stage the key names or the git/deploy stage that
 * writes it; null when nothing says (archived conservatively) */
function effectRecordStageIndex(def: WorkflowDefinition, key: string, stamp: EffectStamp | undefined): number | null {
  const byId = (id: string) => {
    const i = def.stages.findIndex((st) => st.id === id);
    return i >= 0 ? i : null;
  };
  if (stamp) return byId(stamp.stageId);
  const colon = key.indexOf(":");
  if (colon > 0) return byId(key.slice(colon + 1));
  const gitAction = key === "branch" ? "create_branch" : key === "prId" || key === "prUrl" ? "open_pr" : key === "mergeSha" ? "merge" : null;
  const i = def.stages.findIndex((st) =>
    gitAction ? st.type === "git_operation" && st.action === gitAction : key === "deployUrl" && st.type === "deployment",
  );
  return i >= 0 ? i : null;
}

/**
 * AER-049: archive (in place, on `ctx`) every live effect record of a stage at
 * or after `fromIndex` — the stages a re-open runs again. Grouped by the round
 * each record was produced in (an unstamped record belongs to `closingRound`).
 * Returns what moved, for the `workflow:effects-archived` audit row.
 */
function archiveEffectRecords(
  def: WorkflowDefinition,
  ctx: Record<string, unknown>,
  fromIndex: number,
  closingRound: number,
  newRound: number,
  at: string,
): EffectHistoryEntry[] {
  const stamps = effectStamps(ctx);
  const byRound = new Map<number, Record<string, unknown>>();
  for (const k of Object.keys(ctx)) {
    if (!isEffectRecordKey(k)) continue;
    const idx = effectRecordStageIndex(def, k, stamps[k]);
    if (idx !== null && idx < fromIndex) continue; // upstream: not re-run, stays live
    const round = stamps[k]?.round ?? closingRound;
    const values = byRound.get(round) ?? {};
    values[k] = ctx[k];
    byRound.set(round, values);
    delete ctx[k];
    delete stamps[k];
  }
  if (byRound.size === 0) return [];
  const entries: EffectHistoryEntry[] = [...byRound.entries()]
    .sort(([a], [b]) => a - b)
    .map(([round, values]) => ({ round, keys: Object.keys(values), values, at, source: "reopen", archivedInRound: newRound }));
  ctx[EFFECT_HISTORY_KEY] = [...effectHistory(ctx), ...entries];
  if (Object.keys(stamps).length > 0) ctx[EFFECT_STAMPS_KEY] = stamps;
  else delete ctx[EFFECT_STAMPS_KEY];
  return entries;
}

/** the effect-record keys an executor set, with their values (for the audit) */
function effectRecordsOf(snapshot: Record<string, unknown>, context: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    ownedKeyChanges(snapshot, context)
      .filter((k) => isEffectRecordKey(k) && k in context)
      .map((k) => [k, context[k]]),
  );
}

/** AER-048: the context keys an executor changed relative to its claim-time
 * snapshot (set, changed or deleted) — the only keys it owns. The claim keys
 * themselves are released separately. */
function ownedKeyChanges(snapshot: Record<string, unknown>, context: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(snapshot), ...Object.keys(context)]);
  return [...keys].filter(
    (k) =>
      !(CLAIM_KEYS as readonly string[]).includes(k) &&
      (k in snapshot !== k in context || JSON.stringify(snapshot[k]) !== JSON.stringify(context[k])),
  );
}

/** AER-048: why a stored row no longer accepts this executor's result, or null */
function staleExecutorReason(row: InstanceRow, g: StageGuard): string | null {
  if (row.stageEntry !== g.entry) {
    return `the instance left the stage entry this executor started in (stage_entry ${g.entry} → ${row.stageEntry}: re-opened or re-entered meanwhile)`;
  }
  if (row.status !== "awaiting_execution") {
    return `the instance is no longer awaiting execution (status '${row.status}')`;
  }
  const current = (row.definition as WorkflowDefinition).stages[(row.state as InstanceState).currentStageIndex];
  if (current?.id !== g.stageId) return `stage '${g.stageId}' is no longer the current stage`;
  const ctx = row.context as Record<string, unknown>;
  if (ctx.executing !== g.stageId || ctx.executingClaim !== g.claimId) {
    return "this executor no longer holds the stage claim (it lapsed and was re-taken)";
  }
  return null;
}

/**
 * AER-048 — THE EXECUTOR'S COMPLETION. Re-reads the instance FOR UPDATE and
 * commits only if the stage entry, the current stage and this executor's
 * claim are all still what they were when the claim was taken. `decide`
 * writes ONLY the executor's own keys into the row's context as it is now
 * (so a report or re-open that committed meanwhile is never overwritten) and
 * names the kernel event to apply, which applies in the SAME transaction —
 * nothing can slip between the context merge and the state change. On a
 * mismatch nothing is written: the result is discarded, the discard is
 * audited (`workflow:executor-result-discarded`), and the claim is released
 * if it is still this executor's.
 */
async function commitStageResult(
  db: Db,
  guard: StageGuard,
  actorUserId: string | null,
  decide: (
    fresh: Record<string, unknown>,
    row: InstanceRow,
  ) => {
    event: WorkflowEvent | null;
    deployMode?: "hosted" | "byoc" | "air_gapped" | null;
    audits?: AuditInsert[];
  },
  discardDetail: Record<string, unknown>,
  /** the executor's claim-time snapshot and its working context — from which
   * a DISCARD still salvages the external-effect records (review item 1) */
  local?: { snapshot: Record<string, unknown>; context: Record<string, unknown> },
): Promise<StageCommit> {
  if (workflowTestHooks.beforeStageCommit) {
    await workflowTestHooks.beforeStageCommit({ instanceId: guard.instanceId, stageId: guard.stageId });
  }
  const out = await db.transaction(async (tx): Promise<StageCommit & { span?: DeferredSpan }> => {
    const [row] = await tx
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, guard.instanceId))
      .for("update");
    if (!row) return { committed: false, reason: "the instance no longer exists" };
    const fresh = { ...(row.context as Record<string, unknown>) };
    const stale = staleExecutorReason(row, guard);
    if (stale) {
      // DISCARD — the verdict and the transition are dropped, but an external
      // effect this executor already PERFORMED (a deploy, a branch, a PR, a
      // merge, a rollback, a planned run) is a fact, and its record is what
      // makes the next entry idempotent and the effect traceable/reversible.
      // It is merged when the row does not already say something else about
      // it (absent, or unchanged since the claim); a run planned in a round
      // that has since been re-opened is never carried into the new round.
      //
      // AER-049: that holds WITHIN the round the executor started in. If the
      // instance has since been re-opened into a new round, the effect belongs
      // to the round that is over: it goes straight to `effects:history`
      // (never into the live context, where it would make the new round skip
      // its own merge/deploy), and the archive is audited like a re-open's.
      const salvaged: Record<string, unknown> = {};
      const archived: Record<string, unknown> = {};
      const crossRound = row.round !== guard.round;
      if (local) {
        const stamps = effectStamps(fresh);
        for (const k of ownedKeyChanges(local.snapshot, local.context)) {
          if (!isEffectRecordKey(k) || !(k in local.context)) continue;
          if (crossRound) {
            archived[k] = local.context[k];
            continue;
          }
          const untouched = !(k in fresh) || JSON.stringify(fresh[k]) === JSON.stringify(local.snapshot[k]);
          if (!untouched) continue;
          fresh[k] = local.context[k];
          stamps[k] = { round: guard.round, stageId: guard.stageId };
          salvaged[k] = local.context[k];
        }
        if (Object.keys(salvaged).length > 0) fresh[EFFECT_STAMPS_KEY] = stamps;
        if (Object.keys(archived).length > 0) {
          const entry: EffectHistoryEntry = {
            round: guard.round,
            keys: Object.keys(archived),
            values: archived,
            at: new Date().toISOString(),
            source: "discarded-executor",
            archivedInRound: row.round,
          };
          fresh[EFFECT_HISTORY_KEY] = [...effectHistory(fresh), entry];
        }
      }
      const ours = fresh.executing === guard.stageId && fresh.executingClaim === guard.claimId;
      if (ours) releaseStageClaim(fresh);
      if (ours || Object.keys(salvaged).length > 0 || Object.keys(archived).length > 0) {
        await tx.update(workflowInstances).set({ context: fresh }).where(eq(workflowInstances.id, row.id));
      }
      if (Object.keys(archived).length > 0) {
        await tx.insert(auditLog).values({
          userId: actorUserId ?? "00000000-0000-0000-0000-000000000000",
          objectType: "workflow",
          objectId: guard.instanceId,
          detail: {
            event: "executor-result-discarded",
            stageId: guard.stageId,
            closedRound: guard.round,
            round: row.round,
            archived: [{ round: guard.round, keys: Object.keys(archived), values: archived }],
          },
          effect: "allow",
          ruleId: "workflow:effects-archived",
          ruleChain: [],
          reason:
            `stage '${guard.stageId}' executor of round ${guard.round} finished after the re-open into round ${row.round}: ` +
            `its effect record(s) (${Object.keys(archived).join(", ")}) went to effects:history, not the live context — the new round merges/deploys afresh`,
        });
      }
      await tx.insert(auditLog).values({
        userId: actorUserId ?? "00000000-0000-0000-0000-000000000000",
        objectType: "workflow",
        objectId: guard.instanceId,
        detail: {
          stageId: guard.stageId,
          claimedEntry: guard.entry,
          currentEntry: row.stageEntry,
          claimedRound: guard.round,
          currentRound: row.round,
          currentStatus: row.status,
          ...discardDetail,
          // the VALUES of every external-effect record this executor holds,
          // salvaged into the row or not — the effect is traceable from here
          ...(local ? { effectRecords: effectRecordsOf(local.snapshot, local.context) } : {}),
          salvagedEffectRecords: Object.keys(salvaged),
          archivedEffectRecords: Object.keys(archived),
        },
        effect: "deny",
        ruleId: "workflow:executor-result-discarded",
        ruleChain: [],
        reason:
          `stage '${guard.stageId}' executor result discarded: ${stale} — no verdict was written and no transition was applied` +
          (Object.keys(salvaged).length > 0
            ? `; the record of the external effect(s) it performed was kept (${Object.keys(salvaged).join(", ")})`
            : "") +
          (Object.keys(archived).length > 0
            ? `; the record of the external effect(s) it performed in round ${guard.round} went to effects:history (${Object.keys(archived).join(", ")})`
            : ""),
      });
      return { committed: false, reason: stale };
    }
    const decision = decide(fresh, row);
    // AER-049: stamp every effect record this executor committed with the
    // round (and stage) that produced it — the claim's round is the row's
    // round here, since a re-open would have moved the stage entry on
    if (local) {
      const stamps = effectStamps(fresh);
      let stamped = false;
      for (const k of ownedKeyChanges(local.snapshot, local.context)) {
        if (!isEffectRecordKey(k)) continue;
        if (k in fresh) stamps[k] = { round: row.round, stageId: guard.stageId };
        else delete stamps[k];
        stamped = true;
      }
      if (stamped) fresh[EFFECT_STAMPS_KEY] = stamps;
    }
    releaseStageClaim(fresh);
    await tx.update(workflowInstances).set({ context: fresh }).where(eq(workflowInstances.id, row.id));
    for (const a of decision.audits ?? []) await tx.insert(auditLog).values(a);
    if (!decision.event) return { committed: true, effects: [] };
    const r = await applyEvent(tx, row.id, decision.event, actorUserId, undefined, decision.deployMode ?? null, {
      deferSpan: true,
    });
    return { committed: true, effects: r.effects, ...(r.deferredSpan ? { span: r.deferredSpan } : {}) };
  });
  // review item 6: the span is written only once the result is durable
  if (out.committed) await recordDeferredSpan(db, out.span);
  return out.committed ? { committed: true, effects: out.effects } : { committed: false, reason: out.reason };
}

/**
 * ADR-0077 — THE ONE TEMPLATE-CREATION PATH.
 *
 * Extracted verbatim from `POST /v1/workflows/templates` so the gallery's
 * "create from gallery" route (template-gallery.ts) instantiates through the
 * exact same validation an admin-authored definition gets: kernel definition
 * validation, approver resolution (a bad approver id must fail template
 * creation, not brick an instance mid-flight), and nested-run-graph validation
 * (a template must never promise a graph the orchestration engine can't run).
 * A zod definition failure THROWS (ZodError → the global 400 mapping), exactly
 * as the route always behaved.
 */
export async function createWorkflowTemplateValidated(
  db: Db,
  body: { name: string; definition?: unknown },
): Promise<
  | { ok: true; row: typeof workflowTemplates.$inferSelect }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const definition = validateDefinition(body.definition);
  const named = definition.stages
    .flatMap((st) => st.approvers ?? [])
    .filter((a) => a !== "requesting_user");
  if (named.length > 0) {
    const uuidCheck = z.string().uuid();
    if (named.some((a) => !uuidCheck.safeParse(a).success)) {
      return { ok: false, status: 422, body: { error: "invalid_approver" } };
    }
    const found = await db.select({ id: users.id }).from(users).where(inArray(users.id, named));
    if (found.length !== new Set(named).size) {
      return { ok: false, status: 422, body: { error: "invalid_approver" } };
    }
  }
  // §8: nested run graphs must be valid NOW. Their escalation approvers
  // resolve at template time too (same fail-fast rule as stage approvers).
  const nestedApprovers: string[] = [];
  for (const st of definition.stages) {
    if (st.type !== "automated_build" || st.run === undefined) continue;
    try {
      nestedApprovers.push(validateGraph(st.run).escalationApproverUserId);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return {
          ok: false,
          status: 422,
          body: { error: "invalid_run_graph", stageId: st.id, issues: err.issues },
        };
      }
      throw err;
    }
  }
  if (nestedApprovers.length > 0) {
    const found = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, nestedApprovers));
    if (found.length !== new Set(nestedApprovers).size) {
      return { ok: false, status: 422, body: { error: "invalid_approver" } };
    }
  }
  const [row] = await db
    .insert(workflowTemplates)
    .values({ name: body.name, definition })
    .returning();
  return { ok: true, row: row! };
}

/**
 * THE ONE INSTANCE-CREATION PATH, extracted (ADR-0080) so the AI use-case
 * front-door starts its intake instance through EXACTLY the code
 * `POST /v1/workflows/instances` runs — retired-template refusal, ordered
 * merge, ADR-0011 attribution, kernel `start` and stage execution included.
 * The caller is responsible for HOW `templateIds` was chosen (assignment
 * rules + the §8.3 cascade union for the route; the intake template for the
 * use-case registry) — everything after that choice lives here, once.
 */
export async function startWorkflowInstanceWithTemplates(
  db: Db,
  dataKey: string | undefined,
  input: {
    templateIds: string[];
    initiatorUserId: string;
    change: Record<string, unknown>;
    projectId?: string | null;
    isAdmin?: boolean;
  },
): Promise<
  | { ok: true; instance: { id: string; status: string; state: unknown } }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const { templateIds, initiatorUserId, change } = input;
  const templates = await db
    .select()
    .from(workflowTemplates)
    .where(inArray(workflowTemplates.id, templateIds));
  if (templates.length !== templateIds.length) {
    return { ok: false, status: 400, body: { error: "invalid_reference" } };
  }
  // ADR-0022 retire: a RETIRED template starting a new instance is refused
  // LOUDLY, never silently skipped — silently dropping a routed (possibly
  // compliance-required) template would let the change through ungoverned.
  const retired = templates.filter((t) => t.retiredAt !== null);
  if (retired.length > 0) {
    return {
      ok: false,
      status: 422,
      body: {
        error: "template_retired",
        templates: retired.map((t) => t.name),
        detail: `workflow template(s) ${retired.map((t) => `'${t.name}'`).join(", ")} are retired and start no new instances — an admin must route this change to an active template`,
      },
    };
  }
  // merge in matched order (deterministic: matchTemplates preserves rule order)
  const ordered = templateIds.map((id) => templates.find((t) => t.id === id)!);
  const merged = mergeDefinitions(ordered.map((t) => t.definition as WorkflowDefinition));

  if (input.projectId) {
    // ADR-0011: the initiator must be allowed to bill this project
    const attribution = await assertProjectAttribution(
      db,
      input.projectId,
      initiatorUserId,
      input.isAdmin ?? false,
    );
    if (!attribution.ok) {
      return { ok: false, status: attribution.status, body: { error: attribution.error } };
    }
  }
  const [instance] = await db
    .insert(workflowInstances)
    .values({
      templateIds,
      definition: merged,
      initiatorUserId,
      change,
      projectId: input.projectId ?? null,
      state: initialState(merged),
      status: "running",
    })
    .returning();

  const first = await applyEvent(db, instance!.id, { kind: "start" }, initiatorUserId);
  await runGitExecutions(db, instance!.id, first.effects, initiatorUserId, dataKey);
  const [fresh] = await db
    .select()
    .from(workflowInstances)
    .where(eq(workflowInstances.id, instance!.id));
  return { ok: true, instance: { id: instance!.id, status: fresh!.status, state: fresh!.state } };
}

export function registerWorkflowRoutes(app: FastifyInstance, db: Db, opts: WorkflowRouteOptions = {}) {
  // Git connections: admin-only; tokens encrypted at rest, never returned.
  app.post("/v1/git/connections", async (req, reply) => {
    const body = createGitConnectionSchema.parse(req.body);
    // #79b honesty: a git-connection kind must have a real adapter TODAY.
    // Every kind in the current schema enum is implemented, so this never
    // fires right now — it exists so the NEXT kind added to the enum fails
    // here, at creation, with the kind named, instead of at stage execution
    // deep inside someone's workflow.
    if (!IMPLEMENTED_GIT_PROVIDERS.has(body.provider)) {
      return reply.status(400).send({
        error: "unimplemented_git_provider",
        detail: `git provider '${body.provider}' has no adapter yet — implemented: ${[...IMPLEMENTED_GIT_PROVIDERS].join(", ")}`,
      });
    }
    if (!opts.dataKey) {
      return reply.status(503).send({ error: "no_data_key", detail: "set REGULAIT_DATA_KEY" });
    }
    // ADR-0034 amendment #2 — the earliest honest failure for a git endpoint.
    // NOT a substitute for the per-execution check in runGitExecutions.
    if (body.baseUrl) {
      const refusal = await refuseConnectionEgressWrite(db, {
        surface: "git_connection",
        baseUrl: body.baseUrl,
        userId: req.authCtx.userId ?? null,
        phase: "git_connection_write",
        label: `git connection '${body.name}' baseUrl`,
        detail: { name: body.name, provider: body.provider },
      });
      if (refusal) return reply.status(400).send(refusal);
    }
    const [row] = await db
      .insert(gitConnections)
      .values({
        name: body.name,
        provider: body.provider,
        baseUrl: body.baseUrl ?? null,
        tokenCiphertext: encryptTokenOnce(opts.dataKey, body.token),
      })
      .returning({
        id: gitConnections.id,
        name: gitConnections.name,
        provider: gitConnections.provider,
        baseUrl: gitConnections.baseUrl,
        createdAt: gitConnections.createdAt,
      });
    return reply.status(201).send(row);
  });

  app.get("/v1/git/connections", async () => ({
    connections: await db
      .select({
        id: gitConnections.id,
        name: gitConnections.name,
        provider: gitConnections.provider,
        baseUrl: gitConnections.baseUrl,
        createdAt: gitConnections.createdAt,
      })
      .from(gitConnections),
  }));

  // §2 deploy targets: admin-only; credentials (when given) encrypted at rest,
  // never returned. A deployment/rollback stage names one of these; a stage
  // naming a target that doesn't exist parks at a manual handoff.
  // roleArn is an identifier, not a secret, so it is safe to return; the
  // credential ciphertext is never selected.
  const deployTargetView = {
    id: deployTargets.id,
    name: deployTargets.name,
    provider: deployTargets.provider,
    environment: deployTargets.environment,
    baseUrl: deployTargets.baseUrl,
    mode: deployTargets.mode,
    roleArn: deployTargets.roleArn,
    region: deployTargets.region,
    // migration 0043: identifiers/locations only (cluster, subscription,
    // resource group, template/blueprint URIs, namespace) — never a secret, so
    // safe to return like roleArn
    providerConfig: deployTargets.providerConfig,
    createdAt: deployTargets.createdAt,
  };
  app.post("/v1/deploy/targets", async (req, reply) => {
    const body = createDeployTargetSchema.parse(req.body);
    // ADR-0052 §4: air-gapped mode is a TIER FEATURE, enforced at the one
    // in-product act that SELECTS it — creating a deploy target whose mode is
    // air_gapped. hosted/byoc targets are untouched, and every air-gapped
    // target that already exists keeps deploying (committed footprint, §5).
    // The RUNNING process mode is REGULAIT_DEPLOY_MODE (ADR-0062) — an
    // operator env var, deliberately not an API act, so there is nothing to
    // gate there; recorded-vs-actual `deploymentMode` cross-checking is its
    // own decision (ADR-0052 amendment) and is deliberately not smuggled in.
    if (body.mode === "air_gapped") {
      const flagRefusal = await refuseIfFeatureNotLicensed(db, {
        actorUserId: req.authCtx.userId,
        feature: "airgapped_mode",
        what: "creating an air-gapped deploy target",
      });
      if (flagRefusal) return reply.status(flagRefusal.status).send(flagRefusal.body);
    }
    if (body.credential && !opts.dataKey) {
      return reply.status(503).send({ error: "no_data_key", detail: "set REGULAIT_DATA_KEY to store a deploy credential" });
    }
    const [row] = await db
      .insert(deployTargets)
      .values({
        name: body.name,
        provider: body.provider,
        environment: body.environment ?? null,
        baseUrl: body.baseUrl ?? null,
        mode: body.mode ?? "hosted",
        roleArn: body.roleArn ?? null,
        region: body.region ?? null,
        // migration 0043: the validated per-kind config (null = none given)
        providerConfig: deployTargetProviderConfig(body),
        credentialCiphertext:
          body.credential && opts.dataKey ? encryptTokenOnce(opts.dataKey, body.credential) : null,
      })
      .returning(deployTargetView);
    return reply.status(201).send(row);
  });
  app.get("/v1/deploy/targets", async () => ({
    targets: await db.select(deployTargetView).from(deployTargets),
  }));
  app.delete("/v1/deploy/targets/:name", async (req, reply) => {
    const { name } = z.object({ name: z.string().min(1) }).parse(req.params);
    const deleted = await db
      .delete(deployTargets)
      .where(eq(deployTargets.name, name))
      .returning({ id: deployTargets.id });
    if (deleted.length === 0) return reply.status(404).send({ error: "unknown_target" });
    return { removed: true };
  });

  // --- templates + assignment rules (admin) ---

  app.post("/v1/workflows/templates", async (req, reply) => {
    const body = createWorkflowTemplateSchema.parse(req.body);
    const result = await createWorkflowTemplateValidated(db, body);
    if (!result.ok) return reply.status(result.status).send(result.body);
    return reply.status(201).send(result.row);
  });

  app.get("/v1/workflows/templates", async () => ({
    templates: await db.select().from(workflowTemplates),
  }));

  // ADR-0022 retire (soft-disable). Not edit-in-place versioning: the template
  // simply stops starting NEW instances; in-flight instances keep their
  // snapshotted definition and are untouched; assignment rules pointing at it
  // stay visible (and now refuse loudly). The why is required and audited.
  app.post("/v1/workflows/templates/:templateId/retire", async (req, reply) => {
    const { templateId } = z.object({ templateId: z.string().uuid() }).parse(req.params);
    const body = retireTemplateSchema.parse(req.body);
    const [tpl] = await db.select().from(workflowTemplates).where(eq(workflowTemplates.id, templateId));
    if (!tpl) return reply.status(404).send({ error: "unknown_template" });
    if (tpl.retiredAt) return reply.status(409).send({ error: "already_retired" });
    const [row] = await db
      .update(workflowTemplates)
      .set({ retiredAt: new Date(), retiredReason: body.reason })
      .where(eq(workflowTemplates.id, templateId))
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
      objectType: "workflow_template",
      objectId: templateId,
      detail: { phase: "template-retired", name: tpl.name, reason: body.reason },
      effect: "allow",
      ruleId: "workflow-template-retired",
      ruleChain: [],
      reason: `workflow template '${tpl.name}' retired: ${body.reason}`,
    });
    return row;
  });

  app.post("/v1/workflows/assignment-rules", async (req, reply) => {
    const body = createAssignmentRuleSchema.parse(req.body);
    const [row] = await db
      .insert(workflowAssignmentRules)
      .values({
        templateId: body.templateId,
        pathPattern: body.pathPattern ?? null,
        changeType: body.changeType ?? null,
        environment: body.environment ?? null,
        targetSystem: body.targetSystem ?? null,
        initiatorRole: body.initiatorRole ?? null,
        dataSensitivity: body.dataSensitivity ?? null,
      })
      .returning();
    return reply.status(201).send(row);
  });

  app.get("/v1/workflows/assignment-rules", async () => ({
    rules: await db.select().from(workflowAssignmentRules),
  }));

  // A rule that matches forever with no off switch is a governance hole —
  // deleting it is the admin's way to stop routing changes to a template.
  // Admin-gated by default (not in the non-admin route set).
  app.delete("/v1/workflows/assignment-rules/:ruleId", async (req, reply) => {
    const { ruleId } = z.object({ ruleId: z.string().uuid() }).parse(req.params);
    const deleted = await db
      .delete(workflowAssignmentRules)
      .where(eq(workflowAssignmentRules.id, ruleId))
      .returning({ id: workflowAssignmentRules.id });
    if (deleted.length === 0) return reply.status(404).send({ error: "unknown_rule" });
    return { removed: true };
  });

  // --- instances ---

  // §4: the requester does not choose the workflow — assignment rules do.
  // An explicit templateId is an admin-only escape hatch.
  app.post("/v1/workflows/instances", async (req, reply) => {
    const body = startInstanceSchema.parse(req.body);
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_initiate" });

    // ADR-0018 §4 dim: the INITIATING user's role names are resolved SERVER-SIDE
    // (never from the request body) and passed on the change descriptor so a
    // role-scoped assignment rule can only ever fire for a genuine role holder.
    // The kernel stays subject-free — it just matches these strings.
    const initiatorRoleRows = await db
      .select({ name: roles.name })
      .from(roleAssignments)
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .where(eq(roleAssignments.userId, userId));
    // ADR-0038: distinct — a role held both directly and via an IdP group
    // mapping is two assignment rows and one role name.
    const initiatorRoles = [...new Set(initiatorRoleRows.map((r) => r.name))];
    // ADR-0018 addendum (ADR-0019) — the 6th dim, resolved SERVER-SIDE like the
    // 5th: a change's data sensitivity is the set of compliance classification
    // tags its ATTRIBUTED PROJECT carries, i.e. the exact same source
    // effectiveCompliancePolicy cascades from. That is the only
    // server-authoritative sensitivity signal in the model, and it means the
    // dim cannot be asserted by a client. No project, or a project with no
    // classifications, yields [] — a sensitivity-scoped rule then simply does
    // not fire (matches as absent; never an invented sensitivity).
    const dataSensitivities = body.projectId
      ? await projectClassifications(db, body.projectId)
      : [];
    // targetSystem is a legitimate client-supplied change attribute;
    // initiatorRoles and dataSensitivities are authoritative server truth.
    // Neither could ever reach here from a client — changeDescriptorSchema
    // accepts neither — but rebuild explicitly.
    const change = { ...body.change, initiatorRoles, dataSensitivities };

    let templateIds: string[];
    if (body.templateId) {
      if (!req.authCtx.isAdmin) {
        return reply.status(403).send({ error: "explicit_template_is_admin_only" });
      }
      templateIds = [body.templateId];
    } else {
      const rules = await db
        .select()
        .from(workflowAssignmentRules)
        .orderBy(workflowAssignmentRules.createdAt);
      templateIds = matchTemplates(change, rules);
    }
    // §8.3 cascade — the ENFORCED consumer: a classified project's required
    // templates are unioned in with no manual per-control setup (and can
    // force a workflow even when no assignment rule matches). The existing
    // §4 union/strictest merge keeps every added sign-off stage.
    if (body.projectId) {
      const required = await requiredTemplateIdsFor(db, body.projectId);
      for (const id of required) if (!templateIds.includes(id)) templateIds.push(id);
    }
    if (templateIds.length === 0) {
      return reply.status(422).send({ error: "no_workflow_matches_change" });
    }

    const started = await startWorkflowInstanceWithTemplates(db, opts.dataKey, {
      templateIds,
      initiatorUserId: userId,
      change,
      projectId: body.projectId ?? null,
      isAdmin: req.authCtx.isAdmin,
    });
    if (!started.ok) return reply.status(started.status).send(started.body);
    return reply.status(201).send(started.instance);
  });

  type LoadResult =
    | { error: 403 | 404; instance?: never }
    | { error?: never; instance: InstanceRow };
  const loadInstanceFor = async (
    req: { authCtx: { userId: string | null; isAdmin: boolean } },
    instanceId: string,
    access?: { allowParticipant?: boolean },
  ): Promise<LoadResult> => {
    const [instance] = await db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, instanceId));
    if (!instance) return { error: 404 };
    if (!req.authCtx.isAdmin && req.authCtx.userId !== instance.initiatorUserId) {
      // ADR-0022 read-only widening — "party to the instance": anyone NAMED as
      // approver on ANY approval row of this instance (pending OR already
      // decided) may READ it. Deciding a merge gate blind is not governance,
      // and an approver reviewing what they signed off yesterday is part of
      // the same accountability. An ACTIVE delegate of a user with a PENDING
      // approval here may read too — they can decide it, so they must see it.
      // Scoped read only: the flag is passed by the GET route alone; every
      // driving route (artifacts/advance/checks/recheck/deploy-override/abort)
      // keeps the strict admin/initiator gate.
      if (access?.allowParticipant && req.authCtx.userId) {
        const [naming] = await db
          .select({ id: approvals.id })
          .from(approvals)
          .where(
            and(
              eq(approvals.instanceId, instanceId),
              eq(approvals.approverUserId, req.authCtx.userId),
            ),
          )
          .limit(1);
        if (naming) return { instance };
        const delegators = await activeDelegatorsFor(db, req.authCtx.userId);
        if (delegators.length > 0) {
          const [viaDelegation] = await db
            .select({ id: approvals.id })
            .from(approvals)
            .where(
              and(
                eq(approvals.instanceId, instanceId),
                inArray(approvals.approverUserId, delegators),
                eq(approvals.status, "pending"),
              ),
            )
            .limit(1);
          if (viaDelegation) return { instance };
        }
      }
      return { error: 403 };
    }
    return { instance };
  };
  // A 403 must read as an ACCESS problem, never as an outage: the body says
  // plainly that the caller lacks access (the UIs surface `detail` verbatim).
  const sendLoadError = (reply: { status: (code: number) => { send: (body: unknown) => unknown } }, code: 403 | 404) =>
    code === 404
      ? reply.status(404).send({ error: "not_found", detail: "no such workflow instance" })
      : reply.status(403).send({
          error: "forbidden",
          detail:
            "you don't have access to this workflow instance — it is visible to its initiator, admins, and its named approvers",
        });

  app.post("/v1/workflows/instances/:instanceId/artifacts", async (req, reply) => {
    const { instanceId } = instanceIdParam.parse(req.params);
    const body = submitArtifactSchema.parse(req.body);
    const loaded = await loadInstanceFor(req, instanceId);
    if (loaded.error) return sendLoadError(reply, loaded.error);
    const { instance } = loaded;

    const def = instance.definition as WorkflowDefinition;
    const stage = def.stages.find(
      (s) => s.id === body.stageId && s.type === "artifact_generation",
    );
    if (!stage) return reply.status(404).send({ error: "unknown_artifact_stage" });

    if (!req.authCtx.userId) return reply.status(403).send({ error: "bootstrap_cannot_drive" });
    const { state, effects } = await applyEvent(
      db,
      instance.id,
      { kind: "artifact_submitted", stageId: body.stageId },
      req.authCtx.userId,
    );
    const version = state.artifactVersions[stage.output!]!;
    // The artifact row must exist BEFORE any git stage runs — an open_pr
    // directly downstream links this very version into the PR body.
    await db.insert(workflowArtifacts).values({
      instanceId,
      stageId: stage.id,
      output: stage.output!,
      version,
      content: body.content,
      createdBy: req.authCtx.userId!,
    });
    await runGitExecutions(db, instance.id, effects, req.authCtx.userId, opts.dataKey);
    await opts.onInstanceTransition?.(db, instance.id, req.authCtx.userId);
    const [fresh] = await db
      .select({ status: workflowInstances.status })
      .from(workflowInstances)
      .where(eq(workflowInstances.id, instance.id));
    return reply.status(201).send({ version, status: fresh!.status });
  });

  app.post("/v1/workflows/instances/:instanceId/advance", async (req, reply) => {
    const { instanceId } = instanceIdParam.parse(req.params);
    const body = advanceStageSchema.parse(req.body);
    const loaded = await loadInstanceFor(req, instanceId);
    if (loaded.error) return sendLoadError(reply, loaded.error);
    if (!req.authCtx.userId) return reply.status(403).send({ error: "bootstrap_cannot_drive" });
    // Retrying a failed git stage, a build stage with a nested run, or a
    // check stage with named checks: re-run the executor instead of a human
    // trigger (the kernel forbids human-triggering those stages — no
    // bypassing the run or the checks).
    const def = loaded.instance.definition as WorkflowDefinition;
    const targetStage = def.stages.find((st) => st.id === body.stageId);
    if (
      targetStage?.type === "git_operation" ||
      targetStage?.type === "deployment" ||
      targetStage?.type === "rollback" ||
      (targetStage?.type === "automated_build" && targetStage.run !== undefined) ||
      (targetStage?.type === "automated_check" && (targetStage.checks?.length ?? 0) > 0)
    ) {
      await runGitExecutions(
        db,
        loaded.instance.id,
        [{ kind: "execute_stage", stageId: body.stageId }],
        req.authCtx.userId,
        opts.dataKey,
      );
    } else {
      const r = await applyEvent(
        db,
        loaded.instance.id,
        { kind: "human_trigger", stageId: body.stageId },
        req.authCtx.userId,
      );
      await runGitExecutions(db, loaded.instance.id, r.effects, req.authCtx.userId, opts.dataKey);
    }
    await opts.onInstanceTransition?.(db, loaded.instance.id, req.authCtx.userId);
    const [fresh] = await db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, loaded.instance.id));
    return { status: fresh!.status, state: fresh!.state, context: fresh!.context };
  });

  // §2 report per-check results into an automated_check stage. A real CI posts
  // pass/fail here; the seed/tests do too. Results merge by check name (latest
  // wins) and only checks DECLARED on the stage are kept. If the stage is
  // currently executing, evaluating happens immediately (a failing required
  // check → blocked_on_check); otherwise the results are stored for when the
  // stage runs (or for the next recheck).
  app.post("/v1/workflows/instances/:instanceId/checks", async (req, reply) => {
    const { instanceId } = instanceIdParam.parse(req.params);
    const body = reportChecksSchema.parse(req.body);
    const loaded = await loadInstanceFor(req, instanceId);
    if (loaded.error) return sendLoadError(reply, loaded.error);
    if (!req.authCtx.userId) return reply.status(403).send({ error: "bootstrap_cannot_drive" });
    const def = loaded.instance.definition as WorkflowDefinition;
    const stage = def.stages.find((st) => st.id === body.stageId);
    if (!stage || stage.type !== "automated_check" || (stage.checks?.length ?? 0) === 0) {
      return reply.status(422).send({ error: "not_a_check_stage" });
    }
    const declared = new Set(stage.checks ?? []);
    // ADR-0044: a check bound to an eval dataset is MACHINE-DECIDED. Accepting
    // a reported result for one would let a human hand-wave the quality gate
    // green, which is precisely the bypass a blocking gate exists to prevent —
    // so it is refused loudly rather than ignored silently.
    const evalBound = new Set((stage.evals ?? []).map((e) => e.check));
    const usurped = body.results.filter((r) => evalBound.has(r.check)).map((r) => r.check);
    if (usurped.length > 0) {
      return reply.status(422).send({
        error: "eval_check_cannot_be_reported",
        detail: `check(s) ${usurped.join(", ")} are decided by running their eval dataset; a reported result cannot stand in for one`,
      });
    }
    const accepted = body.results.filter((r) => declared.has(r.check));
    if (accepted.length === 0) return reply.status(422).send({ error: "no_declared_checks_reported" });

    // AER-048 — ROUND BINDING FAILS CLOSED. A machine reporter (API key,
    // virtual key, bootstrap token: what a CI uses) must say which round its
    // results were produced for; one that does not is refused, so a result
    // computed against a since-replaced artifact can never land in the new
    // round by omission. Exempt: a person in the console (session auth) — they
    // act on the instance as it is on their screen, and the console sends the
    // round anyway — and an org that explicitly opts out
    // (`checkReportsAllowUnbound`, default off), where an unbound report binds
    // to the round current when it is applied (the pre-AER-048 behaviour).
    if (body.round === undefined && req.authCtx.via !== "session") {
      const org = await loadOrgSettings(db);
      if (!org.checkReportsAllowUnbound) {
        return reply.status(422).send({
          error: "round_required",
          detail:
            `a check report must name the workflow round it was produced for (body.round) — this instance is in round ${loaded.instance.round}. ` +
            "Read it at run start from GET /v1/workflows/instances/:id (instance.round) or the `regulait-round:` line of the PR body; " +
            "an admin can allow unbound reports with the org setting checkReportsAllowUnbound",
          currentRound: loaded.instance.round,
        });
      }
    }

    // ADR-0167 (AUTHZ-06) — PROVENANCE, and the separation-of-duties rule the
    // deploy-override below already applies. This route admits the INITIATOR
    // (loadInstanceFor), so the person a check stage exists to gate could
    // declare `security_scan: passed` and advance their own change, with
    // nothing in the context or the audit trail distinguishing that from a CI
    // report. Still permitted — the demo, the seed and a team without CI all
    // report by hand — but never silent: every stored result carries who
    // posted it, a self-reported PASS requires a recorded reason, and the
    // self-report is an audit row of its own. (Reporting your own check as
    // FAILED needs no reason: that is the honest direction.)
    const selfReported = req.authCtx.userId === loaded.instance.initiatorUserId;
    // scrubbed with ADR-0099's own scrubber before it lands in the context
    // jsonb (ADR-0102 covers reason COLUMNS; this one rides a jsonb value)
    const reason = scrubAuditText(body.reason?.trim() ?? "");
    if (selfReported && accepted.some((r) => r.status === "passed") && !reason) {
      return reply.status(400).send({
        error: "check_report_reason_required",
        detail:
          "you initiated this change, so reporting one of its own checks as passed is a self-attestation; record why it passed (the CI run, the remediation, the ticket) — a real CI reports under its own identity",
      });
    }

    // locked read-modify-write of context[reported:<stageId>] so a concurrent
    // executor claim serializes with the report instead of racing it.
    // AER-048: the report binds to the instance's ROUND, decided under the same
    // lock a re-open takes — a report naming a round that is no longer current
    // was produced for a previous artifact and is refused (and audited) rather
    // than stored into the new round. A report with no `round` is taken for the
    // round current at this point (backward compatible: an existing CI
    // integration that never sends one keeps working, for the current round).
    const stale = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(workflowInstances)
        .where(eq(workflowInstances.id, instanceId))
        .for("update");
      if (!row) throw new WorkflowStateError("instance disappeared");
      if (body.round !== undefined && body.round !== row.round) {
        await tx.insert(auditLog).values({
          userId: req.authCtx.userId!,
          objectType: "workflow",
          objectId: row.id,
          detail: {
            stageId: body.stageId,
            reportedRound: body.round,
            currentRound: row.round,
            results: accepted.map((r) => ({ check: r.check, status: r.status })),
          },
          effect: "deny",
          ruleId: "workflow:checks-report-stale-round",
          ruleChain: [],
          reason: `check report for stage '${body.stageId}' names round ${body.round}, but the workflow is in round ${row.round} (re-opened since) — refused, nothing stored`,
        });
        return { currentRound: row.round };
      }
      const ctx = { ...(row.context as Record<string, unknown>) };
      const merged = new Map(
        normalizeCheckReports(ctx[`reported:${body.stageId}`]).map((r) => [r.check, r]),
      );
      for (const r of accepted) {
        merged.set(r.check, {
          check: r.check,
          status: r.status,
          severity: r.severity ?? null,
          detail: r.detail ?? null,
          reportedByUserId: req.authCtx.userId,
          selfReported,
          reason: reason || null,
          round: row.round,
        });
      }
      ctx[`reported:${body.stageId}`] = [...merged.values()];
      await tx.update(workflowInstances).set({ context: ctx }).where(eq(workflowInstances.id, row.id));
      return null;
    });
    if (stale) {
      return reply.status(409).send({
        error: "stale_check_report",
        detail: `these results were reported for round ${body.round}, but the workflow has been re-opened and is in round ${stale.currentRound}; results for a previous round are refused — re-run the checks against the current artifact and report them for round ${stale.currentRound}`,
        reportedRound: body.round,
        currentRound: stale.currentRound,
      });
    }
    if (selfReported) {
      const summary = accepted.map((r) => `${r.check}=${r.status}`).join(", ");
      await db.insert(auditLog).values({
        userId: req.authCtx.userId,
        objectType: "workflow",
        objectId: loaded.instance.id,
        detail: {
          stageId: body.stageId,
          selfReported: true,
          initiatorUserId: loaded.instance.initiatorUserId,
          results: accepted.map((r) => ({ check: r.check, status: r.status })),
        },
        effect: "allow",
        ruleId: "workflow:checks-self-reported",
        ruleChain: [],
        reason: reason
          ? `initiator reported their own change's checks (${summary}): ${reason}`
          : `initiator reported their own change's checks (${summary})`,
      });
    }

    // evaluate now only if this stage is the one currently executing
    const [afterWrite] = await db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, instanceId));
    const cur = (afterWrite!.definition as WorkflowDefinition).stages[
      (afterWrite!.state as InstanceState).currentStageIndex
    ];
    // AER-048: the response says what happened to the report, so a caller can
    // tell "it was evaluated" from "it is waiting for someone else to"
    let evaluation: "evaluated" | "stored_for_later" | "deferred_to_running_executor" = "stored_for_later";
    if (afterWrite!.status === "awaiting_execution" && cur?.id === body.stageId) {
      try {
        await runGitExecutions(
          db,
          instanceId,
          [{ kind: "execute_stage", stageId: body.stageId }],
          req.authCtx.userId,
          opts.dataKey,
        );
        evaluation = "evaluated";
      } catch (err) {
        // AER-048: another executor is mid-evaluation of this very stage. The
        // report is committed; that executor decides its verdict from the
        // reports stored at ITS commit (under the row lock), and if it ends
        // without committing it re-evaluates once because this report arrived
        // during its claim. 202: accepted, not yet evaluated.
        if (!(err instanceof StageClaimHeldError)) throw err;
        evaluation = "deferred_to_running_executor";
      }
    }
    const [fresh] = await db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, instanceId));
    return reply.status(evaluation === "deferred_to_running_executor" ? 202 : 200).send({
      status: fresh!.status,
      state: fresh!.state,
      context: fresh!.context,
      round: fresh!.round,
      evaluation,
    });
  });

  // §2 re-run a check stage parked at blocked_on_check, after the failing checks
  // were remediated and fresh passing results reported. The kernel guards that
  // the instance is actually blocked on THIS stage.
  app.post("/v1/workflows/instances/:instanceId/recheck", async (req, reply) => {
    const { instanceId } = instanceIdParam.parse(req.params);
    const body = recheckSchema.parse(req.body);
    const loaded = await loadInstanceFor(req, instanceId);
    if (loaded.error) return sendLoadError(reply, loaded.error);
    if (!req.authCtx.userId) return reply.status(403).send({ error: "bootstrap_cannot_drive" });
    const r = await applyEvent(
      db,
      loaded.instance.id,
      { kind: "recheck", stageId: body.stageId },
      req.authCtx.userId,
    );
    await runGitExecutions(db, loaded.instance.id, r.effects, req.authCtx.userId, opts.dataKey);
    const [fresh] = await db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, loaded.instance.id));
    return { status: fresh!.status, state: fresh!.state, context: fresh!.context };
  });

  // §2 resolve a deploy stage parked at blocked_on_deploy — the operator confirms
  // the deploy happened out-of-band (or accepts the condition). The kernel guards
  // that the instance is actually blocked on that deploy stage; advancing may
  // cascade straight into the post-deploy verify.
  app.post("/v1/workflows/instances/:instanceId/deploy-override", async (req, reply) => {
    const { instanceId } = instanceIdParam.parse(req.params);
    const body = deployOverrideSchema.parse(req.body);
    const loaded = await loadInstanceFor(req, instanceId);
    if (loaded.error) return sendLoadError(reply, loaded.error);
    if (!req.authCtx.userId) return reply.status(403).send({ error: "bootstrap_cannot_drive" });
    // Separation of duties on the manual-deploy handoff, same rule the
    // Approvals Queue applies to a self-review. This endpoint clears a stage
    // that parked precisely BECAUSE governance found no authorized way to
    // deploy — so "it went out another way" is an attestation, and when the
    // person attesting is the one who asked for the change in the first
    // place, there is no second party in it at all. Still permitted (an
    // operator is not always on hand, and refusing outright would strand the
    // instance) but never silent: a recorded reason, and an audit row that
    // says plainly it was self-attested. An arm's-length admin clearing
    // someone else's handoff stays a one-click action.
    const selfAttested = req.authCtx.userId === loaded.instance.initiatorUserId;
    if (selfAttested && !body.reason?.trim()) {
      return reply.status(400).send({
        error: "deploy_override_reason_required",
        detail:
          "you initiated this change, so clearing its own deploy gate is a self-attestation; record why it is safe to advance (e.g. how it was actually deployed)",
      });
    }
    const r = await applyEvent(
      db,
      loaded.instance.id,
      { kind: "deploy_override", stageId: body.stageId },
      req.authCtx.userId,
    );
    if (selfAttested || body.reason?.trim()) {
      await db.insert(auditLog).values({
        userId: req.authCtx.userId,
        objectType: "workflow",
        objectId: loaded.instance.id,
        detail: { stageId: body.stageId, selfAttested, initiatorUserId: loaded.instance.initiatorUserId },
        effect: "allow",
        ruleId: "workflow:deploy-override-attested",
        ruleChain: [],
        reason: selfAttested
          ? `initiator cleared their own parked deploy: ${body.reason!.trim()}`
          : `operator cleared a parked deploy: ${body.reason!.trim()}`,
      });
    }
    await runGitExecutions(db, loaded.instance.id, r.effects, req.authCtx.userId, opts.dataKey);
    const [fresh] = await db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, loaded.instance.id));
    return { status: fresh!.status, state: fresh!.state, context: fresh!.context };
  });

  app.post("/v1/workflows/instances/:instanceId/abort", async (req, reply) => {
    const { instanceId } = instanceIdParam.parse(req.params);
    const loaded = await loadInstanceFor(req, instanceId);
    if (loaded.error) return sendLoadError(reply, loaded.error);
    if (!req.authCtx.userId) return reply.status(403).send({ error: "bootstrap_cannot_drive" });
    const { state } = await applyEvent(db, loaded.instance.id, { kind: "abort" }, req.authCtx.userId);
    await opts.onInstanceTransition?.(db, loaded.instance.id, req.authCtx.userId);
    return { status: state.status };
  });

  // §5 dashboard: one instance in full…
  app.get("/v1/workflows/instances/:instanceId", async (req, reply) => {
    const { instanceId } = instanceIdParam.parse(req.params);
    const loaded = await loadInstanceFor(req, instanceId, { allowParticipant: true });
    if (loaded.error) return sendLoadError(reply, loaded.error);
    const [events, artifacts, pendingApprovals] = await Promise.all([
      db
        .select()
        .from(workflowEvents)
        .where(eq(workflowEvents.instanceId, instanceId))
        .orderBy(workflowEvents.at),
      db
        .select()
        .from(workflowArtifacts)
        .where(eq(workflowArtifacts.instanceId, instanceId))
        .orderBy(workflowArtifacts.createdAt),
      db
        .select()
        .from(approvals)
        .where(and(eq(approvals.instanceId, instanceId), eq(approvals.status, "pending")))
        // Ordered on purpose. Without an ORDER BY, Postgres is free to return
        // these rows in any order it likes, and under a quorum of `all` there
        // is one pending row PER approver — so "the first pending gate" is a
        // different approval from one request to the next. That is a wart for
        // anything rendering the queue, and it silently broke a test that had
        // been reading the first row as though it were the caller's own.
        .orderBy(approvals.requestedAt, approvals.id),
    ]);
    // name the approver on each pending gate so "awaiting <who>" is renderable
    const approverIds = [...new Set(pendingApprovals.map((a) => a.approverUserId))];
    const approverRows = approverIds.length
      ? await db
          .select({ id: users.id, displayName: users.displayName, email: users.email })
          .from(users)
          .where(inArray(users.id, approverIds))
      : [];
    const approverName = new Map(approverRows.map((u) => [u.id, u.displayName || u.email]));
    return {
      instance: loaded.instance,
      // §9: the effective (strictest-wins merged) cost-sensitivity for this run
      costSensitivity:
        (loaded.instance.definition as WorkflowDefinition).costSensitivity ?? "standard",
      events,
      artifacts,
      pendingApprovals: pendingApprovals.map((a) => ({
        ...a,
        approverName: approverName.get(a.approverUserId) ?? null,
      })),
    };
  });

  // …and the list view: fleet for admins, own instances for everyone else.
  app.get("/v1/workflows/instances", async (req, reply) => {
    const { status } = z.object({ status: z.string().optional() }).parse(req.query);
    const conditions = [];
    if (status) conditions.push(eq(workflowInstances.status, status));
    if (!req.authCtx.isAdmin) {
      if (!req.authCtx.userId) return reply.status(403).send({ error: "bootstrap_has_no_instances" });
      conditions.push(eq(workflowInstances.initiatorUserId, req.authCtx.userId));
    }
    const rows = await db
      .select()
      .from(workflowInstances)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(workflowInstances.createdAt))
      .limit(100);
    // The distinct changeTypes any assignment rule actually routes — derived
    // from the same rules the admin list endpoint returns, but exposed here
    // because this endpoint is the one non-admins can read. The /app intake
    // form offers exactly these, so a requester can never type a changeType
    // that dead-ends in no_workflow_matches_change.
    const [ruleRows, tplRows] = await Promise.all([
      db
        .select({
          changeType: workflowAssignmentRules.changeType,
          templateId: workflowAssignmentRules.templateId,
        })
        .from(workflowAssignmentRules),
      db
        .select({
          id: workflowTemplates.id,
          name: workflowTemplates.name,
          retiredAt: workflowTemplates.retiredAt,
        })
        .from(workflowTemplates),
    ]);
    const tplById = new Map(tplRows.map((t) => [t.id, t]));
    // ADR-0022 UX: the intake form shows, LIVE, which template(s) a change
    // type routes to — names only (no rule internals leak to non-admins). A
    // retired template is labelled so the requester learns BEFORE submitting
    // that this type currently dead-ends.
    const routesByType = new Map<string, Set<string>>();
    for (const r of ruleRows) {
      if (r.changeType === null) continue;
      const tpl = tplById.get(r.templateId);
      const label = tpl ? tpl.name + (tpl.retiredAt ? " (retired)" : "") : "unknown template";
      const set = routesByType.get(r.changeType) ?? new Set<string>();
      set.add(label);
      routesByType.set(r.changeType, set);
    }
    const changeTypes = [...routesByType.keys()].sort();
    const routes = changeTypes.map((t) => ({
      changeType: t,
      templates: [...(routesByType.get(t) ?? [])].sort(),
    }));
    return { instances: rows, changeTypes, routes };
  });
}
