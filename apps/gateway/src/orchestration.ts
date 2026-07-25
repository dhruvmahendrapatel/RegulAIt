import type { FastifyInstance } from "fastify";
import {
  agentGrants,
  agents,
  approvals,
  auditLog,
  and,
  desc,
  eq,
  orchestrationRunEvents,
  orchestrationRuns,
  userAgentPolicies,
  users,
  type Db,
} from "@regulait/db";
import { evaluateAgent, type AgentDecision } from "@regulait/policy-kernel";
import {
  initialRunState,
  readyNodes,
  transitionRun,
  validateGraph,
  type RunEffect,
  type RunEvent,
  type RunState,
  type TaskGraph,
} from "@regulait/orchestration-kernel";
import { createRunSchema, runEventSchema } from "@regulait/shared";
import { z } from "zod";

const runIdParam = z.object({ runId: z.string().uuid() });

type RunRow = typeof orchestrationRuns.$inferSelect;

/** §5.1: a node's worker runs strictly inside the INITIATING user's
 * entitlements — the same evaluateAgent the human's own invokes go through,
 * with the same grants, modes, and tier ceiling. There is no path where
 * privilege increases moving down the delegation chain. */
async function evaluateNodeOwner(
  db: Db,
  userId: string,
  agentId: string,
  mode: string,
): Promise<{ decision: AgentDecision | null; unknownAgent: boolean }> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) return { decision: null, unknownAgent: true };
  const [grants, [policy]] = await Promise.all([
    db.select().from(agentGrants).where(eq(agentGrants.userId, userId)),
    db.select().from(userAgentPolicies).where(eq(userAgentPolicies.userId, userId)),
  ]);
  let ceilingTier: number | null = null;
  if (policy?.ceilingAgentId) {
    const [ceiling] = await db
      .select({ tier: agents.tier })
      .from(agents)
      .where(eq(agents.id, policy.ceilingAgentId));
    ceilingTier = ceiling?.tier ?? null;
  }
  return {
    decision: evaluateAgent({
      userId,
      agent: { id: agent.id, tier: agent.tier, enabled: agent.enabled, modes: agent.modes ?? null },
      mode,
      agentGrants: grants,
      ceilingTier,
    }),
    unknownAgent: false,
  };
}

/** Transactionally apply one run event: kernel transition under FOR UPDATE,
 * append-only event history, one audit trail (§5.3), and §3 escalations
 * materialized into the ONE approvals queue. */
async function applyRunEvent(
  db: Db,
  runId: string,
  event: RunEvent,
  actorUserId: string,
): Promise<{ run: RunRow; effects: RunEffect[] }> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(orchestrationRuns)
      .where(eq(orchestrationRuns.id, runId))
      .for("update");
    if (!run) throw new Error("run vanished mid-event");
    const graph = run.graph as TaskGraph;
    const { state, effects } = transitionRun(graph, run.state as RunState, event);
    const [updated] = await tx
      .update(orchestrationRuns)
      .set({ state, status: state.status })
      .where(eq(orchestrationRuns.id, runId))
      .returning();
    await tx.insert(orchestrationRunEvents).values({ runId, event, actorUserId });
    await tx.insert(auditLog).values({
      userId: actorUserId,
      objectType: "run",
      objectId: runId,
      detail: { event, initiatingUserId: run.initiatingUserId },
      effect: "allow",
      ruleId: `run-event:${event.kind}`,
      ruleChain: [],
      reason: `orchestration run event '${event.kind}' applied`,
    });
    for (const effect of effects) {
      if (effect.kind !== "request_approval") continue;
      const [pending] = await tx
        .select({ id: approvals.id })
        .from(approvals)
        .where(
          and(
            eq(approvals.runId, runId),
            eq(approvals.stageId, effect.nodeId),
            eq(approvals.status, "pending"),
          ),
        )
        .limit(1);
      if (!pending) {
        await tx.insert(approvals).values({
          userId: run.initiatingUserId,
          objectType: "run",
          runId,
          stageId: effect.nodeId,
          approverUserId: graph.escalationApproverUserId,
        });
      }
    }
    return { run: updated!, effects };
  });
}

/** Decide-endpoint hook (§3): approving an escalated node re-opens it for
 * another attempt; denying it aborts the whole run. */
export async function applyRunApprovalDecision(
  db: Db,
  approvalRow: { runId: string | null; stageId: string | null },
  decision: "approved" | "denied",
  deciderUserId: string,
): Promise<void> {
  if (!approvalRow.runId || !approvalRow.stageId) return;
  const event: RunEvent =
    decision === "approved"
      ? { kind: "retry_node", nodeId: approvalRow.stageId }
      : { kind: "abort" };
  await applyRunEvent(db, approvalRow.runId, event, deciderUserId);
}

export function registerOrchestrationRoutes(app: FastifyInstance, db: Db) {
  async function loadRunFor(req: { authCtx: { userId: string | null; isAdmin: boolean } }, runId: string) {
    const [run] = await db.select().from(orchestrationRuns).where(eq(orchestrationRuns.id, runId));
    if (!run) return { error: 404 as const };
    if (!req.authCtx.isAdmin && req.authCtx.userId !== run.initiatingUserId) {
      return { error: 404 as const }; // existence is not disclosed to non-participants
    }
    return { run };
  }

  // §3: the task graph arrives as a distinct, reviewable plan — creation
  // validates and stores it; nothing executes until an explicit start event.
  app.post("/v1/runs", async (req, reply) => {
    const body = createRunSchema.parse(req.body);
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_initiate" });

    const graph = validateGraph(body.graph);

    const [approver] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, graph.escalationApproverUserId));
    if (!approver) return reply.status(422).send({ error: "unknown_escalation_approver" });

    // §5.1 per-node envelope check under the initiating user's entitlements.
    const envelope: Array<{ nodeId: string; decision: AgentDecision }> = [];
    for (const node of graph.nodes) {
      const { decision, unknownAgent } = await evaluateNodeOwner(db, userId, node.ownerAgentId, node.mode);
      if (unknownAgent) {
        return reply.status(422).send({ error: "unknown_agent", nodeId: node.id });
      }
      envelope.push({ nodeId: node.id, decision: decision! });
    }
    const denied = envelope.filter((e) => e.decision.effect !== "allow");
    for (const e of denied) {
      await db.insert(auditLog).values({
        userId,
        objectType: "run",
        objectId: null,
        detail: { nodeId: e.nodeId, runName: graph.run, phase: "plan" },
        effect: "deny",
        ruleId: e.decision.ruleId,
        ruleChain: e.decision.ruleChain,
        reason: e.decision.reason,
      });
    }
    if (denied.length > 0) {
      return reply.status(422).send({
        error: "entitlement_exceeded",
        nodes: denied.map((e) => ({ nodeId: e.nodeId, decision: e.decision })),
      });
    }

    const state = initialRunState(graph);
    const [run] = await db
      .insert(orchestrationRuns)
      .values({
        name: graph.run,
        initiatingUserId: userId,
        workflowInstanceId: body.workflowInstanceId ?? null,
        graph,
        state,
        status: state.status,
      })
      .returning();
    await db.insert(auditLog).values({
      userId,
      objectType: "run",
      objectId: run!.id,
      detail: { runName: graph.run, nodes: graph.nodes.length, phase: "plan" },
      effect: "allow",
      ruleId: "run-planned",
      ruleChain: [],
      reason: `task graph validated; ${graph.nodes.length} nodes within the initiating user's entitlements`,
    });
    return reply.status(201).send({ id: run!.id, status: run!.status, envelope });
  });

  app.post("/v1/runs/:runId/events", async (req, reply) => {
    const { runId } = runIdParam.parse(req.params);
    const body = runEventSchema.parse(req.body);
    const loaded = await loadRunFor(req, runId);
    if (loaded.error) return reply.status(loaded.error).send({ error: "unavailable" });
    if (!req.authCtx.userId) return reply.status(403).send({ error: "bootstrap_cannot_drive" });

    const needsNode = body.kind !== "start" && body.kind !== "abort";
    if (needsNode && !body.nodeId) return reply.status(400).send({ error: "node_id_required" });
    let event: RunEvent;
    if (body.kind === "node_failed") {
      if (!body.error) return reply.status(400).send({ error: "error_required" });
      event = { kind: "node_failed", nodeId: body.nodeId!, error: body.error };
    } else if (body.kind === "reassign_node") {
      if (!body.ownerAgentId) return reply.status(400).send({ error: "owner_agent_id_required" });
      // §5.1: reassignment is a fresh entitlement check under the INITIATING
      // user — a run can never drift to an agent its human couldn't use.
      const graph = loaded.run.graph as TaskGraph;
      const node = graph.nodes.find((n) => n.id === body.nodeId);
      if (!node) return reply.status(400).send({ error: "unknown_node" });
      const { decision, unknownAgent } = await evaluateNodeOwner(
        db,
        loaded.run.initiatingUserId,
        body.ownerAgentId,
        node.mode,
      );
      if (unknownAgent) return reply.status(422).send({ error: "unknown_agent" });
      if (decision!.effect !== "allow") {
        await db.insert(auditLog).values({
          userId: req.authCtx.userId,
          objectType: "run",
          objectId: runId,
          detail: { nodeId: node.id, ownerAgentId: body.ownerAgentId, phase: "reassign" },
          effect: "deny",
          ruleId: decision!.ruleId,
          ruleChain: decision!.ruleChain,
          reason: decision!.reason,
        });
        return reply.status(403).send({ error: "entitlement_exceeded", decision });
      }
      event = { kind: "reassign_node", nodeId: body.nodeId!, ownerAgentId: body.ownerAgentId };
    } else if (body.kind === "start" || body.kind === "abort") {
      event = { kind: body.kind };
    } else {
      event = { kind: body.kind, nodeId: body.nodeId! };
    }

    const { run, effects } = await applyRunEvent(db, runId, event, req.authCtx.userId);
    return {
      status: run.status,
      state: run.state,
      readyNodes: readyNodes(run.graph as TaskGraph, run.state as RunState),
      effects,
    };
  });

  app.get("/v1/runs/:runId", async (req, reply) => {
    const { runId } = runIdParam.parse(req.params);
    const loaded = await loadRunFor(req, runId);
    if (loaded.error) return reply.status(loaded.error).send({ error: "unavailable" });
    const [events, pendingApprovals] = await Promise.all([
      db
        .select()
        .from(orchestrationRunEvents)
        .where(eq(orchestrationRunEvents.runId, runId))
        .orderBy(orchestrationRunEvents.at),
      db
        .select()
        .from(approvals)
        .where(and(eq(approvals.runId, runId), eq(approvals.status, "pending"))),
    ]);
    return {
      run: loaded.run,
      readyNodes: readyNodes(loaded.run.graph as TaskGraph, loaded.run.state as RunState),
      events,
      pendingApprovals,
    };
  });

  // admin fleet view (§6 dashboard data source)
  app.get("/v1/runs", async (req) => {
    const { status } = z
      .object({ status: z.enum(["planned", "running", "completed", "aborted"]).optional() })
      .parse(req.query);
    const rows = await db
      .select()
      .from(orchestrationRuns)
      .where(status ? eq(orchestrationRuns.status, status) : undefined)
      .orderBy(desc(orchestrationRuns.createdAt));
    return { runs: rows };
  });
}
