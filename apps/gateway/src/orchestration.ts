import type { FastifyInstance } from "fastify";
import {
  agentGrants,
  agents,
  approvals,
  auditLog,
  and,
  costEvents,
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
  estimateGraphCost,
  estimateNodeCost,
  initialRunState,
  readyNodes,
  transitionRun,
  validateGraph,
  type NodeTokenEstimate,
  type RunEffect,
  type RunEvent,
  type RunState,
  type TaskGraph,
  type TaskNode,
} from "@regulait/orchestration-kernel";
import { classifyComplexity, estimateTokens, routeModel } from "@regulait/optimizer-kernel";
import { createRunSchema, runEventSchema } from "@regulait/shared";
import { z } from "zod";

/** §5.2 budget envelope persisted on the run. Every number is an ESTIMATE
 * (tokens × list price) until real model dispatch exists — enforcement is
 * estimate-based and says so. */
interface RunBudget {
  capUsd: number | null;
  breachAction: "approve" | "replan";
  estimatedTotalUsd: number | null;
  perNodeUsd: Record<string, number | null>;
  unpricedNodes: string[];
  /** estimated spend accumulated as nodes start */
  spentUsd: number;
  /** a decided __budget__ approval lifts cap enforcement for this run */
  overageApproved: boolean;
  replanned: boolean;
  estimationBasis: string;
}

const BUDGET_BASIS =
  "estimated-tokens-x-list-price; enforcement is estimate-based until real dispatch exists";

function tokensFor(node: TaskNode): NodeTokenEstimate {
  return node.estimate ?? estimateTokens(node.title, classifyComplexity(node.title));
}

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
  // §5.2 budget approvals: approving lifts cap enforcement for this run
  // (the overage is now sanctioned); denying aborts it. Never a silent path.
  if (approvalRow.stageId.startsWith("__budget__")) {
    if (decision === "approved") {
      const [run] = await db
        .select()
        .from(orchestrationRuns)
        .where(eq(orchestrationRuns.id, approvalRow.runId));
      if (!run) return;
      const budget = (run.budget ?? {}) as Record<string, unknown>;
      await db
        .update(orchestrationRuns)
        .set({ budget: { ...budget, overageApproved: true } })
        .where(eq(orchestrationRuns.id, approvalRow.runId));
      await db.insert(auditLog).values({
        userId: deciderUserId,
        objectType: "run",
        objectId: approvalRow.runId,
        detail: { phase: "budget-decision", stageId: approvalRow.stageId },
        effect: "allow",
        ruleId: "run-budget-overage-approved",
        ruleChain: [],
        reason: "budget overage approved by the named approver; cap enforcement lifted for this run",
      });
    } else {
      await applyRunEvent(db, approvalRow.runId, { kind: "abort" }, deciderUserId);
    }
    return;
  }
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

    const [grants, [policy], agentRows] = await Promise.all([
      db.select().from(agentGrants).where(eq(agentGrants.userId, userId)),
      db.select().from(userAgentPolicies).where(eq(userAgentPolicies.userId, userId)),
      db.select().from(agents),
    ]);
    const agentById = new Map(agentRows.map((a) => [a.id, a]));
    let ceilingTier: number | null = null;
    if (policy?.ceilingAgentId) {
      ceilingTier = agentById.get(policy.ceilingAgentId)?.tier ?? null;
    }
    const evalOwner = (agentId: string, mode: string): AgentDecision | null => {
      const agent = agentById.get(agentId);
      if (!agent) return null;
      return evaluateAgent({
        userId,
        agent: { id: agent.id, tier: agent.tier, enabled: agent.enabled, modes: agent.modes ?? null },
        mode,
        agentGrants: grants,
        ceilingTier,
      });
    };

    // §5.1 per-node envelope check under the initiating user's entitlements.
    const envelope: Array<{ nodeId: string; decision: AgentDecision }> = [];
    for (const node of graph.nodes) {
      const decision = evalOwner(node.ownerAgentId, node.mode);
      if (!decision) {
        return reply.status(422).send({ error: "unknown_agent", nodeId: node.id });
      }
      envelope.push({ nodeId: node.id, decision });
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

    // §5.2 pre-execution budget check: estimate the whole graph before
    // anything runs. Over cap → cheaper re-plan (admin-configured) or an
    // approval gate. Unpriced owners under a cap fail closed: a cap that
    // cannot be checked requires approval, it is never silently skipped (§7).
    const state = initialRunState(graph);
    const pricing = Object.fromEntries(
      agentRows.map((a) => [
        a.id,
        { costPerMTokIn: a.costPerMTokIn ?? null, costPerMTokOut: a.costPerMTokOut ?? null },
      ]),
    );
    const capUsd = policy?.runBudgetUsd ?? null;
    const breachAction = policy?.runBudgetBreachAction ?? "approve";
    let cost = estimateGraphCost(graph, state.owners, pricing, tokensFor);
    let replanned = false;
    const substitutions: Array<{
      node: TaskNode;
      from: string;
      routing: ReturnType<typeof routeModel>;
    }> = [];
    if (capUsd !== null && cost.totalUsd !== null && cost.totalUsd > capUsd && breachAction === "replan") {
      // §5.2 auto re-plan: substitute cheaper owners per node via the same
      // governed routing pillar 6 uses — candidates are entitlement-filtered,
      // so a re-plan can never escalate (§5.1). Same graph shape, cheaper team.
      for (const node of graph.nodes) {
        const candidates = agentRows
          .filter((a) => a.enabled)
          .filter((a) => evalOwner(a.id, node.mode)?.effect === "allow")
          .map((a) => ({
            id: a.id,
            tier: a.tier,
            costPerMTokIn: a.costPerMTokIn ?? null,
            costPerMTokOut: a.costPerMTokOut ?? null,
          }));
        const routing = routeModel({
          requestedAgentId: state.owners[node.id]!,
          candidates,
          routingMode: policy?.routingMode ?? "automatic",
          complexity: classifyComplexity(node.title),
          costSensitivity: "cost-sensitive",
          ceilingTier,
          estimate: tokensFor(node),
        });
        if (routing.effect === "routed") {
          substitutions.push({ node, from: state.owners[node.id]!, routing });
          state.owners[node.id] = routing.selectedAgentId;
          replanned = true;
        }
      }
      cost = estimateGraphCost(graph, state.owners, pricing, tokensFor);
    }
    const overCap = capUsd !== null && (cost.totalUsd === null || cost.totalUsd > capUsd);
    const budget: RunBudget = {
      capUsd,
      breachAction,
      estimatedTotalUsd: cost.totalUsd,
      perNodeUsd: cost.perNodeUsd,
      unpricedNodes: cost.unpricedNodes,
      spentUsd: 0,
      overageApproved: false,
      replanned,
      estimationBasis: BUDGET_BASIS,
    };

    const [run] = await db
      .insert(orchestrationRuns)
      .values({
        name: graph.run,
        initiatingUserId: userId,
        workflowInstanceId: body.workflowInstanceId ?? null,
        graph,
        state,
        budget,
        status: state.status,
      })
      .returning();
    // §5.3/§8: every re-plan substitution is a cost-attribution event like
    // any other routing decision.
    for (const sub of substitutions) {
      const est = tokensFor(sub.node);
      await db.insert(costEvents).values({
        userId,
        objectType: "run",
        objectId: run!.id,
        technique: "model_routing",
        requestedAgentId: sub.from,
        servedAgentId: sub.routing.selectedAgentId,
        baselineAgentId: sub.routing.baselineAgentId,
        estimatedTokensIn: est.in,
        estimatedTokensOut: est.out,
        estimatedTokensSaved: 0,
        estimatedCostSavedUsd: sub.routing.estimatedCostSavedUsd,
        estimationBasis: sub.routing.estimationBasis,
        ruleId: sub.routing.ruleId,
        detail: { nodeId: sub.node.id, phase: "budget-replan" },
      });
    }
    if (overCap) {
      await db.insert(approvals).values({
        userId,
        objectType: "run",
        runId: run!.id,
        stageId: "__budget__",
        approverUserId: graph.escalationApproverUserId,
      });
      await db.insert(auditLog).values({
        userId,
        objectType: "run",
        objectId: run!.id,
        detail: { phase: "budget", capUsd, estimatedTotalUsd: cost.totalUsd, unpricedNodes: cost.unpricedNodes },
        effect: "require_approval",
        ruleId: "run-budget-cap",
        ruleChain: [],
        reason:
          cost.totalUsd === null
            ? "run cost cannot be estimated under a budget cap (unpriced agents); approval required"
            : `estimated run cost $${cost.totalUsd} exceeds the $${capUsd} cap; approval required`,
      });
    }
    await db.insert(auditLog).values({
      userId,
      objectType: "run",
      objectId: run!.id,
      detail: { runName: graph.run, nodes: graph.nodes.length, phase: "plan", replanned },
      effect: "allow",
      ruleId: "run-planned",
      ruleChain: [],
      reason: `task graph validated; ${graph.nodes.length} nodes within the initiating user's entitlements`,
    });
    return reply
      .status(201)
      .send({ id: run!.id, status: run!.status, envelope, budget, budgetApprovalPending: overCap });
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

    // §5.2 budget enforcement — never silently exceeded (§7).
    const budget = (loaded.run.budget ?? null) as RunBudget | null;
    if (
      event.kind === "start" &&
      budget &&
      budget.capUsd !== null &&
      !budget.overageApproved &&
      (budget.estimatedTotalUsd === null || budget.estimatedTotalUsd > budget.capUsd)
    ) {
      return reply.status(409).send({ error: "budget_approval_pending", budget });
    }
    let nodeCost: number | null = null;
    if (event.kind === "node_started" && budget) {
      // live tracking: cost of THIS node under its CURRENT owner —
      // reassignment may have made it pricier than the plan-time estimate.
      const graph = loaded.run.graph as TaskGraph;
      const state = loaded.run.state as RunState;
      const node = graph.nodes.find((n) => n.id === event.nodeId);
      if (node) {
        const owner = state.owners[node.id] ?? node.ownerAgentId;
        const [agent] = await db.select().from(agents).where(eq(agents.id, owner));
        nodeCost = estimateNodeCost(
          agent
            ? { costPerMTokIn: agent.costPerMTokIn ?? null, costPerMTokOut: agent.costPerMTokOut ?? null }
            : undefined,
          tokensFor(node),
        );
        if (
          budget.capUsd !== null &&
          !budget.overageApproved &&
          (nodeCost === null || budget.spentUsd + nodeCost > budget.capUsd)
        ) {
          // pause at the breaching node and escalate into the one queue
          const [pending] = await db
            .select({ id: approvals.id })
            .from(approvals)
            .where(
              and(
                eq(approvals.runId, runId),
                eq(approvals.stageId, `__budget__:${node.id}`),
                eq(approvals.status, "pending"),
              ),
            )
            .limit(1);
          if (!pending) {
            await db.insert(approvals).values({
              userId: loaded.run.initiatingUserId,
              objectType: "run",
              runId,
              stageId: `__budget__:${node.id}`,
              approverUserId: (loaded.run.graph as TaskGraph).escalationApproverUserId,
            });
          }
          await db.insert(auditLog).values({
            userId: req.authCtx.userId,
            objectType: "run",
            objectId: runId,
            detail: {
              phase: "budget-breach",
              nodeId: node.id,
              spentUsd: budget.spentUsd,
              estimatedNodeUsd: nodeCost,
              capUsd: budget.capUsd,
            },
            effect: "require_approval",
            ruleId: "run-budget-cap",
            ruleChain: [],
            reason:
              nodeCost === null
                ? `node '${node.id}' has an unpriced owner under a budget cap; approval required`
                : `starting node '${node.id}' would take estimated spend to $${(budget.spentUsd + nodeCost).toFixed(6)}, over the $${budget.capUsd} cap`,
          });
          return reply.status(409).send({
            error: "budget_exceeded",
            nodeId: node.id,
            spentUsd: budget.spentUsd,
            estimatedNodeUsd: nodeCost,
            capUsd: budget.capUsd,
          });
        }
      }
    }

    const { run, effects } = await applyRunEvent(db, runId, event, req.authCtx.userId);
    if (event.kind === "node_started" && budget && nodeCost !== null) {
      await db
        .update(orchestrationRuns)
        .set({ budget: { ...budget, spentUsd: Number((budget.spentUsd + nodeCost).toFixed(6)) } })
        .where(eq(orchestrationRuns.id, runId));
    }
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
