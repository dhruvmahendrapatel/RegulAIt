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
import { users, gitConnections, orchestrationRuns } from "@regulait/db";
import { resolveProvider, GitProviderError } from "@regulait/git-provider";
import { validateGraph } from "@regulait/orchestration-kernel";
import { inTransaction, planRun, type ApprovalPostCommit, type DbOrTx } from "./orchestration.js";
import { assertProjectAttribution, requiredTemplateIdsFor } from "./projects.js";
import { decryptSecret, encryptSecret as encryptTokenOnce } from "./secrets.js";
import {
  advanceStageSchema,
  createAssignmentRuleSchema,
  createGitConnectionSchema,
  createWorkflowTemplateSchema,
  startInstanceSchema,
  submitArtifactSchema,
} from "@regulait/shared";
import { z } from "zod";

const instanceIdParam = z.object({ instanceId: z.string().uuid() });

type InstanceRow = typeof workflowInstances.$inferSelect;

function resolveApprover(approver: string, initiatorUserId: string): string {
  return approver === "requesting_user" ? initiatorUserId : approver;
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

  // All-must-approve: the pending count is evaluated INSIDE applyEvent's
  // instance lock, so a re-open that inserts fresh rows (or another approver)
  // serializes with the grant instead of racing it. A stale or wrong-stage
  // decision is additionally rejected by the kernel's stage check.
  const r = await applyEvent(
    dbx,
    instanceId,
    { kind: "approval_granted", stageId },
    deciderUserId,
    async (tx) => {
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

    // §2 stage 8: the check executor. Deterministic and offline in this
    // slice — each named check "runs" against the built artifacts (the
    // signed-off outputs this instance produced) and records a pass result
    // into instance.context, so the rail and the audit trail both show WHAT
    // was checked, not just that something advanced.
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
      context[`checks:${stage.id}`] = (stage.checks ?? []).map((name) => ({
        check: name,
        status: "passed",
        detail: `ran against ${against}`,
      }));
      delete context.executing;
      delete context.lastError;
      await db
        .update(workflowInstances)
        .set({ context })
        .where(eq(workflowInstances.id, instance.id));
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

    let executionError: string | null = null;
    try {
      if (!dataKey) throw new GitProviderError("gateway has no data key configured");
      const [conn] = await db
        .select()
        .from(gitConnections)
        .where(eq(gitConnections.name, stage.connection!));
      if (!conn) throw new GitProviderError(`unknown git connection '${stage.connection}'`);
      const provider = resolveProvider({
        provider: conn.provider,
        token: decryptSecret(dataKey, conn.tokenCiphertext),
        baseUrl: conn.baseUrl,
      });

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
    if (!opts.dataKey) {
      return reply.status(503).send({ error: "no_data_key", detail: "set REGULAIT_DATA_KEY" });
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

  app.post("/v1/workflows/assignment-rules", async (req, reply) => {
    const body = createAssignmentRuleSchema.parse(req.body);
    const [row] = await db
      .insert(workflowAssignmentRules)
      .values({
        templateId: body.templateId,
        pathPattern: body.pathPattern ?? null,
        changeType: body.changeType ?? null,
        environment: body.environment ?? null,
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
      templateIds = matchTemplates(body.change, rules);
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
        change: body.change,
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
    access?: { allowPendingApprover?: boolean },
  ): Promise<LoadResult> => {
    const [instance] = await db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, instanceId));
    if (!instance) return { error: 404 };
    if (!req.authCtx.isAdmin && req.authCtx.userId !== instance.initiatorUserId) {
      // Read-only widening: the named approver of a PENDING approval on this
      // instance may view what they are being asked to sign off — deciding
      // blind is not governance. Only the GET route passes the flag; every
      // driving route keeps the admin/initiator gate.
      if (access?.allowPendingApprover && req.authCtx.userId) {
        const [naming] = await db
          .select({ id: approvals.id })
          .from(approvals)
          .where(
            and(
              eq(approvals.instanceId, instanceId),
              eq(approvals.approverUserId, req.authCtx.userId),
              eq(approvals.status, "pending"),
            ),
          )
          .limit(1);
        if (naming) return { instance };
      }
      return { error: 403 };
    }
    return { instance };
  };

  app.post("/v1/workflows/instances/:instanceId/artifacts", async (req, reply) => {
    const { instanceId } = instanceIdParam.parse(req.params);
    const body = submitArtifactSchema.parse(req.body);
    const loaded = await loadInstanceFor(req, instanceId);
    if (loaded.error) return reply.status(loaded.error).send({ error: "unavailable" });
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
    if (loaded.error) return reply.status(loaded.error).send({ error: "unavailable" });
    if (!req.authCtx.userId) return reply.status(403).send({ error: "bootstrap_cannot_drive" });
    // Retrying a failed git stage, a build stage with a nested run, or a
    // check stage with named checks: re-run the executor instead of a human
    // trigger (the kernel forbids human-triggering those stages — no
    // bypassing the run or the checks).
    const def = loaded.instance.definition as WorkflowDefinition;
    const targetStage = def.stages.find((st) => st.id === body.stageId);
    if (
      targetStage?.type === "git_operation" ||
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

  app.post("/v1/workflows/instances/:instanceId/abort", async (req, reply) => {
    const { instanceId } = instanceIdParam.parse(req.params);
    const loaded = await loadInstanceFor(req, instanceId);
    if (loaded.error) return reply.status(loaded.error).send({ error: "unavailable" });
    if (!req.authCtx.userId) return reply.status(403).send({ error: "bootstrap_cannot_drive" });
    const { state } = await applyEvent(db, loaded.instance.id, { kind: "abort" }, req.authCtx.userId);
    return { status: state.status };
  });

  // §5 dashboard: one instance in full…
  app.get("/v1/workflows/instances/:instanceId", async (req, reply) => {
    const { instanceId } = instanceIdParam.parse(req.params);
    const loaded = await loadInstanceFor(req, instanceId, { allowPendingApprover: true });
    if (loaded.error) return reply.status(loaded.error).send({ error: "unavailable" });
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
        .where(and(eq(approvals.instanceId, instanceId), eq(approvals.status, "pending"))),
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
    const ruleRows = await db
      .select({ changeType: workflowAssignmentRules.changeType })
      .from(workflowAssignmentRules);
    const changeTypes = [
      ...new Set(ruleRows.map((r) => r.changeType).filter((c): c is string => c !== null)),
    ].sort();
    return { instances: rows, changeTypes };
  });
}
