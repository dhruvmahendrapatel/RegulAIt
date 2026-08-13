import type { FastifyInstance } from "fastify";
import {
  and,
  approvals,
  auditLog,
  desc,
  eq,
  inArray,
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
import { validateGraph } from "@regulait/orchestration-kernel";
import { inTransaction, planRun, type ApprovalPostCommit, type DbOrTx } from "./orchestration.js";
import {
  assertProjectAttribution,
  projectClassifications,
  requiredTemplateIdsFor,
} from "./projects.js";
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
): Promise<{ state: InstanceState; effects: Effect[]; skipped?: boolean }> {
  // One transaction with the instance row locked: concurrent decisions,
  // re-opens, and aborts serialize instead of racing read-modify-write. When
  // the caller already holds a transaction (the decide endpoint), this nests
  // as a savepoint so the whole flow commits or rolls back together.
  return inTransaction(db, async (tx) => {
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
    const { state, effects } = transition(def, instance.state as InstanceState, event);

    await tx
      .update(workflowInstances)
      .set({ state, status: state.status, updatedAt: new Date() })
      .where(eq(workflowInstances.id, instance.id));
    await tx.insert(workflowEvents).values({ instanceId: instance.id, event, actorUserId });

    const isDenial = event.kind === "approval_denied" || event.kind === "abort";
    await tx.insert(auditLog).values({
      userId: actorUserId ?? instance.initiatorUserId,
      objectType: "workflow",
      objectId: instance.id,
      detail: { event },
      effect: isDenial ? "deny" : "allow",
      ruleId: `workflow:${event.kind}`,
      ruleChain: [],
      reason: `workflow instance event '${event.kind}' (status → ${state.status})`,
      // A4: deploy-scoped events carry their target's mode; everything else
      // stays null (unknown/not-applicable — honestly un-backfillable).
      deployMode: deployMode ?? null,
    });

    // A re-open stales EVERY outstanding gate downstream, and a terminal
    // denial/abort must leave no live rows in the one inbox — supersede all
    // pending rows for the instance in each of these cases.
    if (event.kind === "artifact_submitted" || isDenial) {
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
    return { state, effects };
  });
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
  decision: "approved" | "denied",
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

export interface WorkflowRouteOptions {
  /** hex AES-256 key for git-connection tokens; absent = git features refused */
  dataKey?: string;
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

  if (run.status === "completed") {
    const r = await applyEvent(
      db,
      instance.id,
      { kind: "execution_succeeded", stageId: stage.id },
      actorUserId,
    );
    // completion can flow straight into a downstream git stage
    await runGitExecutions(db, instance.id, r.effects, actorUserId, dataKey);
  } else {
    const ctx = { ...context, lastError: `${stage.id}: nested run ${run.id} aborted` };
    await db.update(workflowInstances).set({ context: ctx }).where(eq(workflowInstances.id, instance.id));
    await applyEvent(
      db,
      instance.id,
      { kind: "execution_failed", stageId: stage.id, error: `nested run ${run.id} aborted` },
      actorUserId,
    );
  }
}

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
      if (ctx.executing === effect.stageId) return null; // another executor holds it
      ctx.executing = effect.stageId;
      await tx.update(workflowInstances).set({ context: ctx }).where(eq(workflowInstances.id, row.id));
      return { instance: { ...row, context: ctx } };
    });
    if (!claimed) {
      throw new WorkflowStateError(
        `stage '${effect.stageId}' is not currently executable for this instance`,
      );
    }
    const instance = claimed.instance;
    const def = instance.definition as WorkflowDefinition;
    const stage = def.stages.find((st) => st.id === effect.stageId)!;
    const context = { ...(instance.context as Record<string, unknown>) };

    // §8 nesting: an automated_build stage with a run graph spawns a nested
    // orchestration run instead of a git operation — planned under the
    // INSTANCE INITIATOR's entitlements (planRun), driven by the normal run
    // endpoints, completing the stage via handleNestedRunCompletion when the
    // run turns terminal. Idempotent: a live or completed run for this stage
    // is never duplicated; only an aborted one is replaced on retry.
    if (stage.type === "automated_build" && stage.run !== undefined) {
      delete context.executing;
      const existingId = context[`runId:${stage.id}`];
      if (typeof existingId === "string") {
        const [existing] = await db
          .select()
          .from(orchestrationRuns)
          .where(eq(orchestrationRuns.id, existingId));
        if (existing && existing.status !== "aborted") {
          await db
            .update(workflowInstances)
            .set({ context })
            .where(eq(workflowInstances.id, instance.id));
          if (existing.status === "completed") {
            // replay after a missed completion notification
            const r = await applyEvent(
              db,
              instanceId,
              { kind: "execution_succeeded", stageId: stage.id },
              actorUserId,
            );
            lastEffects = r.effects;
            pending = r.effects.filter((e) => e.kind === "execute_stage");
            continue;
          }
          break; // run is planned/running — the stage waits for it
        }
      }
      const planned = await planRun(db, instance.initiatorUserId, stage.run, instance.id, instance.projectId ?? null, dataKey);
      if (!planned.ok) {
        const error = `nested run rejected: ${JSON.stringify(planned.body)}`;
        context.lastError = `${stage.id}: ${error}`;
        await db
          .update(workflowInstances)
          .set({ context })
          .where(eq(workflowInstances.id, instance.id));
        await applyEvent(
          db,
          instanceId,
          { kind: "execution_failed", stageId: stage.id, error },
          actorUserId,
        );
        break;
      }
      context[`runId:${stage.id}`] = planned.run.id;
      delete context.lastError;
      await db
        .update(workflowInstances)
        .set({ context })
        .where(eq(workflowInstances.id, instance.id));
      break; // stage stays awaiting_execution until the run completes
    }

    // §2 stage 8: the check executor. Each named check resolves to a result:
    // if a result was REPORTED for it (via POST .../checks — a real CI posts
    // here; the seed/tests post here for the demo) that result wins, PASS or
    // FAIL; otherwise it falls back to the deterministic offline auto-pass
    // (byte-identical to the pre-fail-routing contract, so existing templates
    // still sail through). A required check that FAILED parks the instance at
    // blocked_on_check instead of advancing — the failure path deploy/rollback
    // build on. Every result lands in instance.context so the rail and audit
    // trail show WHAT was checked and how it fared, not just that it advanced.
    if (stage.type === "automated_check") {
      const artifacts = await db
        .select()
        .from(workflowArtifacts)
        .where(eq(workflowArtifacts.instanceId, instance.id))
        .orderBy(desc(workflowArtifacts.version));
      const latestByOutput = new Map<string, (typeof artifacts)[number]>();
      for (const a of artifacts) if (!latestByOutput.has(a.output)) latestByOutput.set(a.output, a);
      const subjects = [...latestByOutput.values()].map((a) => `${a.output} v${a.version}`);
      const against = subjects.length ? subjects.join(", ") : "the built change set";
      const reported = normalizeCheckReports(context[`reported:${stage.id}`]);
      const byName = new Map(reported.map((r) => [r.check, r]));
      // ADR-0044: checks bound to an evaluation dataset are decided by RUNNING
      // it, here, under the instance initiator's entitlements — never by a
      // reported result (POST .../checks refuses to report against them) and
      // never by the offline auto-pass. A regression produces status 'failed',
      // which then flows into the SAME check_failed event every other failing
      // check uses; there is no second failure path.
      const evalOutcomes = await runStageEvalChecks(db, instance, stage, dataKey);
      const results = (stage.checks ?? []).map((name) => {
        const ev = evalOutcomes.get(name);
        if (ev) return ev;
        const rep = byName.get(name);
        return rep
          ? {
              check: name,
              status: rep.status,
              severity: rep.severity ?? null,
              detail: rep.detail ?? `reported ${rep.status}`,
            }
          : { check: name, status: "passed" as const, severity: null, detail: `ran against ${against}` };
      });
      context[`checks:${stage.id}`] = results;
      if (evalOutcomes.size > 0) {
        context[`evals:${stage.id}`] = Object.fromEntries(
          [...evalOutcomes].map(([name, r]) => [name, r.eval]),
        );
      }
      delete context.executing;
      delete context.lastError;
      await db
        .update(workflowInstances)
        .set({ context })
        .where(eq(workflowInstances.id, instance.id));
      const failures = results.filter((r) => r.status === "failed").map((r) => r.check);
      const r =
        failures.length > 0
          ? await applyEvent(
              db,
              instanceId,
              { kind: "check_failed", stageId: stage.id, failures },
              actorUserId,
            )
          : await applyEvent(
              db,
              instanceId,
              { kind: "execution_succeeded", stageId: stage.id },
              actorUserId,
            );
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
        delete context.executing;
        await db.update(workflowInstances).set({ context }).where(eq(workflowInstances.id, instance.id));
        const r = await applyEvent(
          db,
          instanceId,
          { kind: "deploy_blocked", stageId: stage.id, reason: handoff },
          actorUserId,
          undefined,
          // A4: the target may be missing here (that IS one of the handoffs)
          target?.mode ?? null,
        );
        lastEffects = r.effects;
        pending = [];
        continue;
      }
      let deployErr: string | null = null;
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
          const res = await provider.deploy(target!.name, target!.environment, instance.id);
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
        deployErr = err instanceof Error ? err.message : String(err);
      }
      delete context.executing;
      if (deployErr === null) delete context.lastError;
      else context.lastError = `${stage.id}: ${deployErr}`;
      await db.update(workflowInstances).set({ context }).where(eq(workflowInstances.id, instance.id));
      // a provider that isn't integrated yet → manual handoff (not a hard fail)
      if (deployErr !== null) {
        const r = await applyEvent(
          db,
          instanceId,
          { kind: "deploy_blocked", stageId: stage.id, reason: deployErr },
          actorUserId,
          undefined,
          target!.mode, // A4: the deploy-scoped audit row carries the target's mode
        );
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
          await db.update(workflowInstances).set({ context }).where(eq(workflowInstances.id, instance.id));
          const r = await applyEvent(
            db,
            instanceId,
            { kind: "deploy_blocked", stageId: stage.id, reason },
            actorUserId,
            undefined,
            target!.mode, // A4
          );
          lastEffects = r.effects;
          pending = [];
          continue;
        }
      }
      const r = await applyEvent(
        db,
        instanceId,
        { kind: "execution_succeeded", stageId: stage.id },
        actorUserId,
        undefined,
        target!.mode, // A4: the successful deploy's audit row carries the mode
      );
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
          const res = await provider.rollback(target.name, priorDeploy?.deployId ?? "unknown");
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
      delete context.executing;
      if (rbErr === null) delete context.lastError;
      else context.lastError = `${stage.id}: ${rbErr}`;
      await db.update(workflowInstances).set({ context }).where(eq(workflowInstances.id, instance.id));
      // a rollback that itself FAILS is a serious operator situation — it stays
      // awaiting_execution (retryable via /advance), never silently terminal.
      if (rbErr !== null) break;
      const r = await applyEvent(
        db,
        instanceId,
        { kind: "rolled_back", stageId: stage.id },
        actorUserId,
        undefined,
        target?.mode ?? null, // A4
      );
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
        const branch = `${stage.branchPrefix ?? "regulait"}/${instance.id.slice(0, 8)}`;
        // Idempotent replay (§2 re-open): if we already created this branch,
        // re-execution succeeds without a provider call instead of 422ing forever.
        if (context.branch !== branch) {
          await provider.createBranch(stage.repo!, branch, stage.base ?? "main");
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
        const pr = await provider.openPullRequest(stage.repo!, {
          head: String(context.branch ?? ""),
          base: stage.base ?? "main",
          title: change.description,
          body:
            `Workflow instance ${instance.id}

` +
            (latestArtifact
              ? `Signed-off ${latestArtifact.output} v${latestArtifact.version}:

${latestArtifact.content}`
              : "(no artifact)"),
        });
        context.prId = pr.id;
        context.prUrl = pr.url;
      } else if (stage.action === "merge" && context.mergeSha === undefined) {
        const result = await provider.mergePullRequest(
          stage.repo!,
          String(context.prId ?? ""),
          stage.strategy ?? "merge",
        );
        context.mergeSha = result.sha;
      }
    } catch (err) {
      executionError = err instanceof Error ? err.message : String(err);
    }

    // Release the claim; record outcome. The kernel event application sits
    // OUTSIDE the provider try so a post-success DB hiccup is never recorded
    // as a failed (and re-runnable) git operation.
    delete context.executing;
    if (executionError === null) delete context.lastError;
    else context.lastError = `${stage.id}: ${executionError}`;
    await db
      .update(workflowInstances)
      .set({ context })
      .where(eq(workflowInstances.id, instance.id));

    if (executionError !== null) {
      await applyEvent(
        db,
        instanceId,
        { kind: "execution_failed", stageId: stage.id, error: executionError },
        actorUserId,
      );
      break;
    }
    const r = await applyEvent(
      db,
      instanceId,
      { kind: "execution_succeeded", stageId: stage.id },
      actorUserId,
    );
    lastEffects = r.effects;
    pending = r.effects.filter((e) => e.kind === "execute_stage");
  }
  return lastEffects;
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
    const definition = validateDefinition(body.definition);
    // Approvers must be resolvable NOW — a bad approver id must fail template
    // creation, not brick an instance mid-flight.
    const named = definition.stages
      .flatMap((st) => st.approvers ?? [])
      .filter((a) => a !== "requesting_user");
    if (named.length > 0) {
      const uuidCheck = z.string().uuid();
      if (named.some((a) => !uuidCheck.safeParse(a).success)) {
        return reply.status(422).send({ error: "invalid_approver" });
      }
      const found = await db.select({ id: users.id }).from(users).where(inArray(users.id, named));
      if (found.length !== new Set(named).size) {
        return reply.status(422).send({ error: "invalid_approver" });
      }
    }
    // §8: nested run graphs must be valid NOW — a template must never promise
    // a graph the orchestration engine can't run. Their escalation approvers
    // resolve at template time too (same fail-fast rule as stage approvers).
    const nestedApprovers: string[] = [];
    for (const st of definition.stages) {
      if (st.type !== "automated_build" || st.run === undefined) continue;
      try {
        nestedApprovers.push(validateGraph(st.run).escalationApproverUserId);
      } catch (err) {
        if (err instanceof z.ZodError) {
          return reply
            .status(422)
            .send({ error: "invalid_run_graph", stageId: st.id, issues: err.issues });
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
        return reply.status(422).send({ error: "invalid_approver" });
      }
    }
    const [row] = await db
      .insert(workflowTemplates)
      .values({ name: body.name, definition })
      .returning();
    return reply.status(201).send(row);
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

    const templates = await db
      .select()
      .from(workflowTemplates)
      .where(inArray(workflowTemplates.id, templateIds));
    if (templates.length !== templateIds.length) {
      return reply.status(400).send({ error: "invalid_reference" });
    }
    // ADR-0022 retire: a RETIRED template starting a new instance is refused
    // LOUDLY, never silently skipped — silently dropping a routed (possibly
    // compliance-required) template would let the change through ungoverned.
    const retired = templates.filter((t) => t.retiredAt !== null);
    if (retired.length > 0) {
      return reply.status(422).send({
        error: "template_retired",
        templates: retired.map((t) => t.name),
        detail: `workflow template(s) ${retired.map((t) => `'${t.name}'`).join(", ")} are retired and start no new instances — an admin must route this change to an active template`,
      });
    }
    // merge in matched order (deterministic: matchTemplates preserves rule order)
    const ordered = templateIds.map((id) => templates.find((t) => t.id === id)!);
    const merged = mergeDefinitions(ordered.map((t) => t.definition as WorkflowDefinition));

    if (body.projectId) {
      // ADR-0011: the initiator must be allowed to bill this project
      const attribution = await assertProjectAttribution(db, body.projectId, userId, req.authCtx.isAdmin);
      if (!attribution.ok) return reply.status(attribution.status).send({ error: attribution.error });
    }
    const [instance] = await db
      .insert(workflowInstances)
      .values({
        templateIds,
        definition: merged,
        initiatorUserId: userId,
        change,
        projectId: body.projectId ?? null,
        state: initialState(merged),
        status: "running",
      })
      .returning();

    const first = await applyEvent(db, instance!.id, { kind: "start" }, userId);
    await runGitExecutions(db, instance!.id, first.effects, userId, opts.dataKey);
    const [fresh] = await db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, instance!.id));
    return reply.status(201).send({ id: instance!.id, status: fresh!.status, state: fresh!.state });
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

    // locked read-modify-write of context[reported:<stageId>] so a concurrent
    // executor claim serializes with the report instead of racing it
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(workflowInstances)
        .where(eq(workflowInstances.id, instanceId))
        .for("update");
      if (!row) throw new WorkflowStateError("instance disappeared");
      const ctx = { ...(row.context as Record<string, unknown>) };
      const merged = new Map(
        normalizeCheckReports(ctx[`reported:${body.stageId}`]).map((r) => [r.check, r]),
      );
      for (const r of accepted) {
        merged.set(r.check, { check: r.check, status: r.status, severity: r.severity ?? null, detail: r.detail ?? null });
      }
      ctx[`reported:${body.stageId}`] = [...merged.values()];
      await tx.update(workflowInstances).set({ context: ctx }).where(eq(workflowInstances.id, row.id));
    });

    // evaluate now only if this stage is the one currently executing
    const [afterWrite] = await db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, instanceId));
    const cur = (afterWrite!.definition as WorkflowDefinition).stages[
      (afterWrite!.state as InstanceState).currentStageIndex
    ];
    if (afterWrite!.status === "awaiting_execution" && cur?.id === body.stageId) {
      await runGitExecutions(
        db,
        instanceId,
        [{ kind: "execute_stage", stageId: body.stageId }],
        req.authCtx.userId,
        opts.dataKey,
      );
    }
    const [fresh] = await db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, instanceId));
    return { status: fresh!.status, state: fresh!.state, context: fresh!.context };
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
