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
  type Effect,
  type InstanceState,
  type WorkflowDefinition,
  type WorkflowEvent,
} from "@regulait/workflow-kernel";
import { users, gitConnections } from "@regulait/db";
import { resolveProvider, GitProviderError } from "@regulait/git-provider";
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
  db: Db,
  instanceId: string,
  event: WorkflowEvent,
  actorUserId: string | null,
): Promise<{ state: InstanceState; effects: Effect[] }> {
  // One transaction with the instance row locked: concurrent decisions,
  // re-opens, and aborts serialize instead of racing read-modify-write.
  return db.transaction(async (tx) => {
    const [instance] = await tx
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, instanceId))
      .for("update");
    if (!instance) throw new Error("instance disappeared");

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
 */
export async function applyWorkflowApprovalDecision(
  db: Db,
  approvalRow: { instanceId: string | null; stageId: string | null },
  decision: "approved" | "denied",
  deciderUserId: string,
  dataKey?: string,
): Promise<void> {
  if (!approvalRow.instanceId || !approvalRow.stageId) return;
  const stageId = approvalRow.stageId;
  const instanceId = approvalRow.instanceId;

  if (decision === "denied") {
    await applyEvent(db, instanceId, { kind: "approval_denied", stageId }, deciderUserId);
    return;
  }

  // All-must-approve: advance only when no pending rows remain for the stage.
  // A stale or wrong-stage decision is rejected by the kernel's stage check.
  const pending = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.instanceId, instanceId),
        eq(approvals.stageId, stageId),
        eq(approvals.status, "pending"),
      ),
    );
  if (pending.length === 0) {
    const r = await applyEvent(db, instanceId, { kind: "approval_granted", stageId }, deciderUserId);
    // an approval can unblock straight into a git stage (e.g. merge gate → merge)
    await runGitExecutions(db, instanceId, r.effects, deciderUserId, dataKey);
  }
}

export interface WorkflowRouteOptions {
  /** hex AES-256 key for git-connection tokens; absent = git features refused */
  dataKey?: string;
}

/**
 * Execute pending git stages until the instance blocks on something else.
 * Each stage's result lands in instance.context; failures are recorded as
 * execution_failed events and leave the stage retryable via /advance.
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
    const [instance] = await db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, instanceId));
    if (!instance) break;
    const def = instance.definition as WorkflowDefinition;
    const stage = def.stages.find((st) => st.id === effect.stageId)!;
    const context = { ...(instance.context as Record<string, unknown>) };

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
        await provider.createBranch(stage.repo!, branch, stage.base ?? "main");
        context.branch = branch;
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
      } else if (stage.action === "merge") {
        const result = await provider.mergePullRequest(
          stage.repo!,
          String(context.prId ?? ""),
          stage.strategy ?? "merge",
        );
        context.mergeSha = result.sha;
      }
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      context.lastError = `${stage.id}: ${message}`;
      await db
        .update(workflowInstances)
        .set({ context })
        .where(eq(workflowInstances.id, instance.id));
      await applyEvent(
        db,
        instanceId,
        { kind: "execution_failed", stageId: stage.id, error: message },
        actorUserId,
      );
      break;
    }
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
      if (templateIds.length === 0) {
        return reply.status(422).send({ error: "no_workflow_matches_change" });
      }
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

    const [instance] = await db
      .insert(workflowInstances)
      .values({
        templateIds,
        definition: merged,
        initiatorUserId: userId,
        change: body.change,
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
  ): Promise<LoadResult> => {
    const [instance] = await db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, instanceId));
    if (!instance) return { error: 404 };
    if (!req.authCtx.isAdmin && req.authCtx.userId !== instance.initiatorUserId) {
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
    await runGitExecutions(db, instance.id, effects, req.authCtx.userId, opts.dataKey);
    const version = state.artifactVersions[stage.output!]!;
    await db.insert(workflowArtifacts).values({
      instanceId,
      stageId: stage.id,
      output: stage.output!,
      version,
      content: body.content,
      createdBy: req.authCtx.userId!,
    });
    return reply.status(201).send({ version, status: state.status });
  });

  app.post("/v1/workflows/instances/:instanceId/advance", async (req, reply) => {
    const { instanceId } = instanceIdParam.parse(req.params);
    const body = advanceStageSchema.parse(req.body);
    const loaded = await loadInstanceFor(req, instanceId);
    if (loaded.error) return reply.status(loaded.error).send({ error: "unavailable" });
    if (!req.authCtx.userId) return reply.status(403).send({ error: "bootstrap_cannot_drive" });
    // Retrying a failed git stage: re-run the executor instead of a human trigger.
    const def = loaded.instance.definition as WorkflowDefinition;
    const targetStage = def.stages.find((st) => st.id === body.stageId);
    if (targetStage?.type === "git_operation") {
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
    const loaded = await loadInstanceFor(req, instanceId);
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
    return { instance: loaded.instance, events, artifacts, pendingApprovals };
  });

  // …and the fleet view (admin).
  app.get("/v1/workflows/instances", async (req) => {
    const { status } = z.object({ status: z.string().optional() }).parse(req.query);
    const rows = await db
      .select()
      .from(workflowInstances)
      .where(status ? eq(workflowInstances.status, status) : undefined)
      .orderBy(desc(workflowInstances.createdAt))
      .limit(100);
    return { instances: rows };
  });
}
