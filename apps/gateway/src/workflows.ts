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
import { users } from "@regulait/db";
import {
  advanceStageSchema,
  createAssignmentRuleSchema,
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
    await applyEvent(db, instanceId, { kind: "approval_granted", stageId }, deciderUserId);
  }
}

export function registerWorkflowRoutes(app: FastifyInstance, db: Db) {
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

    const { state } = await applyEvent(db, instance!.id, { kind: "start" }, userId);
    return reply.status(201).send({ id: instance!.id, status: state.status, state });
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
    const { state } = await applyEvent(
      db,
      instance.id,
      { kind: "artifact_submitted", stageId: body.stageId },
      req.authCtx.userId,
    );
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
    const { state } = await applyEvent(
      db,
      loaded.instance.id,
      { kind: "human_trigger", stageId: body.stageId },
      req.authCtx.userId,
    );
    return { status: state.status, state };
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
