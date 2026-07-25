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
  workflowArtifacts,
  workflowInstances,
  type Db,
} from "@regulait/db";
import type { WorkflowDefinition } from "@regulait/workflow-kernel";
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
import {
  autoAdvanceSchema,
  createRunSchema,
  dispatchNodeSchema,
  runEventSchema,
} from "@regulait/shared";
import { executeGovernedDispatch } from "./agents-connectors.js";
import { assertProjectAttribution } from "./projects.js";
import { mirrorNodeStatus } from "./pm.js";
import { handleNestedRunCompletion } from "./workflows.js";
import { z } from "zod";

/** §5.2 budget envelope persisted on the run. Plan/start numbers are
 * ESTIMATES (tokens × list price); measuredSpentUsd is provider-measured
 * actuals accumulated by real worker-node dispatches — the two are never
 * mixed into one figure. */
interface RunBudget {
  capUsd: number | null;
  breachAction: "approve" | "replan";
  estimatedTotalUsd: number | null;
  perNodeUsd: Record<string, number | null>;
  unpricedNodes: string[];
  /** estimated spend accumulated as nodes start */
  spentUsd: number;
  /** MEASURED spend accumulated as nodes actually dispatch (absent on runs
   * planned before real dispatch existed — read with ?? 0) */
  measuredSpentUsd?: number;
  /** a decided __budget__ approval lifts cap enforcement for this run */
  overageApproved: boolean;
  replanned: boolean;
  estimationBasis: string;
}

const BUDGET_BASIS =
  "node-start gating is estimated-tokens-x-list-price; measuredSpentUsd is provider-measured actuals from real dispatches";

function tokensFor(node: TaskNode): NodeTokenEstimate {
  return node.estimate ?? estimateTokens(node.title, classifyComplexity(node.title));
}

const runIdParam = z.object({ runId: z.string().uuid() });

type RunRow = typeof orchestrationRuns.$inferSelect;

/** §5.2 estimate-based node-start gate. Returns the node's estimated cost
 * under its CURRENT owner, or a blocked payload — in which case the
 * `__budget__:<node>` approval and require_approval audit row have already
 * been written (deduped). */
async function gateNodeStartBudget(
  db: Db,
  run: RunRow,
  nodeId: string,
  actorUserId: string,
): Promise<{ blocked: Record<string, unknown> | null; nodeCost: number | null }> {
  const budget = (run.budget ?? null) as RunBudget | null;
  if (!budget) return { blocked: null, nodeCost: null };
  const graph = run.graph as TaskGraph;
  const state = run.state as RunState;
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return { blocked: null, nodeCost: null };
  // live tracking: cost of THIS node under its CURRENT owner — reassignment
  // may have made it pricier than the plan-time estimate.
  const owner = state.owners[node.id] ?? node.ownerAgentId;
  const [agent] = await db.select().from(agents).where(eq(agents.id, owner));
  const nodeCost = estimateNodeCost(
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
          eq(approvals.runId, run.id),
          eq(approvals.stageId, `__budget__:${node.id}`),
          eq(approvals.status, "pending"),
        ),
      )
      .limit(1);
    if (!pending) {
      await db.insert(approvals).values({
        userId: run.initiatingUserId,
        objectType: "run",
        runId: run.id,
        stageId: `__budget__:${node.id}`,
        approverUserId: graph.escalationApproverUserId,
      });
    }
    await db.insert(auditLog).values({
      userId: actorUserId,
      objectType: "run",
      objectId: run.id,
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
    return {
      blocked: {
        error: "budget_exceeded",
        nodeId: node.id,
        spentUsd: budget.spentUsd,
        estimatedNodeUsd: nodeCost,
        capUsd: budget.capUsd,
      },
      nodeCost,
    };
  }
  return { blocked: null, nodeCost };
}

type NodeDispatchOutcome =
  | { kind: "unknown_node" }
  | { kind: "unknown_agent" }
  | { kind: "not_in_progress"; status: string | null }
  | { kind: "entitlement_denied"; decision: AgentDecision }
  | { kind: "budget_blocked_measured"; measuredSpentUsd: number; capUsd: number }
  | { kind: "dispatch_failed"; status: number; error: string; detail?: string }
  | {
      kind: "ok";
      result: {
        servedAgentId: string;
        model: string;
        outputText: string;
        stopReason: string;
        refusal: boolean;
        usage: { inputTokens: number; outputTokens: number };
        costUsd: number | null;
        measuredCostSavedUsd: number | null;
        credentialSource: "user" | "platform" | "none";
      };
      measuredSpentUsd: number;
      budgetBreached: boolean;
    };

/** §2 scope-lock made real for nested runs: workers execute against exactly
 * the workflow's SIGNED-OFF artifacts, injected as system context — never a
 * re-imagined version of the requirements. The build stage's `scope` narrows
 * the context to one artifact; without it every artifact's latest version is
 * included. Returns null when the instance has no artifacts (nothing to
 * inject) or the run isn't the one the stage is bound to. */
async function buildNestedRunContext(
  db: Db,
  instanceId: string,
  runId: string,
  runName: string,
  node: TaskNode,
): Promise<{ system: string; artifacts: Array<{ output: string; version: number }> } | null> {
  const [instance] = await db
    .select()
    .from(workflowInstances)
    .where(eq(workflowInstances.id, instanceId));
  if (!instance) return null;
  const def = instance.definition as WorkflowDefinition;
  const context = instance.context as Record<string, unknown>;
  const stage = def.stages.find(
    (st) => st.type === "automated_build" && context[`runId:${st.id}`] === runId,
  );

  const rows = await db
    .select()
    .from(workflowArtifacts)
    .where(eq(workflowArtifacts.instanceId, instanceId))
    .orderBy(workflowArtifacts.version);
  // latest version per output, optionally narrowed to the stage's scope
  const latest = new Map<string, { output: string; version: number; content: string }>();
  for (const row of rows) {
    if (stage?.scope && row.output !== stage.scope) continue;
    latest.set(row.output, { output: row.output, version: row.version, content: row.content });
  }
  if (latest.size === 0) return null;

  const artifacts = [...latest.values()];
  const sections = artifacts
    .map((a) => `--- signed-off artifact '${a.output}' v${a.version} ---\n${a.content}`)
    .join("\n\n");
  return {
    system:
      `You are the worker agent for node '${node.id}' ("${node.title}") of run '${runName}', ` +
      `executing the build stage of a governed workflow. Execute strictly within the ` +
      `signed-off requirements below; do not expand scope.\n\n${sections}`,
    artifacts: artifacts.map((a) => ({ output: a.output, version: a.version })),
  };
}

/** Execute one in_progress node's work through the shared governed-dispatch
 * core: §5.1 re-checked under the INITIATING user at execution time, §5.2
 * measured-spend accounting, node_dispatched history, audit trail. Callers
 * (the per-node route and the auto-advance loop) map outcomes to HTTP or to
 * loop decisions. */
async function dispatchRunNode(
  db: Db,
  dataKey: string | undefined,
  run: RunRow,
  nodeId: string,
  args: { input?: string | undefined; maxTokens?: number | undefined },
  actorUserId: string,
): Promise<NodeDispatchOutcome> {
  const graph = run.graph as TaskGraph;
  const state = run.state as RunState;
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return { kind: "unknown_node" };
  if (state.nodeStatuses[nodeId] !== "in_progress") {
    return { kind: "not_in_progress", status: state.nodeStatuses[nodeId] ?? null };
  }

  // §5.1 at execution time: grants may have changed since plan/start — the
  // CURRENT owner is re-checked under the INITIATING user right before the
  // model call. A revoked grant stops the worker cold.
  const ownerId = state.owners[nodeId] ?? node.ownerAgentId;
  const { decision, unknownAgent } = await evaluateNodeOwner(
    db,
    run.initiatingUserId,
    ownerId,
    node.mode,
  );
  if (unknownAgent) return { kind: "unknown_agent" };
  if (decision!.effect !== "allow") {
    await db.insert(auditLog).values({
      userId: actorUserId,
      objectType: "run",
      objectId: run.id,
      detail: { nodeId, ownerAgentId: ownerId, phase: "dispatch" },
      effect: "deny",
      ruleId: decision!.ruleId,
      ruleChain: decision!.ruleChain,
      reason: decision!.reason,
    });
    return { kind: "entitlement_denied", decision: decision! };
  }

  // §5.2 on MEASURED dollars: once measured spend reaches the cap, further
  // dispatches are blocked until the overage is approved.
  const budget = (run.budget ?? null) as RunBudget | null;
  const measuredSpent = budget?.measuredSpentUsd ?? 0;
  if (budget && budget.capUsd !== null && !budget.overageApproved && measuredSpent >= budget.capUsd) {
    return { kind: "budget_blocked_measured", measuredSpentUsd: measuredSpent, capUsd: budget.capUsd };
  }

  // §8/§2: a nested run's workers receive the workflow's signed-off
  // artifacts as system context (scope-lock) — standalone runs get none.
  const nested = run.workflowInstanceId
    ? await buildNestedRunContext(db, run.workflowInstanceId, run.id, graph.run, node)
    : null;

  const [servedAgent] = await db.select().from(agents).where(eq(agents.id, ownerId));
  const outcome = await executeGovernedDispatch(db, dataKey, {
    userId: run.initiatingUserId,
    served: servedAgent,
    requestedAgentId: node.ownerAgentId,
    baseline: null,
    input: args.input ?? node.title,
    system: nested?.system,
    maxTokens: args.maxTokens,
    projectId: run.projectId ?? null,
    detail: {
      runId: run.id,
      nodeId,
      mode: node.mode,
      ...(nested ? { contextArtifacts: nested.artifacts } : {}),
    },
  });

  if (!outcome.ok) {
    await db.insert(auditLog).values({
      userId: actorUserId,
      objectType: "run",
      objectId: run.id,
      detail: { nodeId, ownerAgentId: ownerId, phase: "dispatch", error: outcome.error },
      effect: "allow",
      ruleId: "run-node-dispatch-failed",
      ruleChain: [],
      reason: `node '${nodeId}' dispatch failed before execution: ${outcome.error}`,
    });
    return {
      kind: "dispatch_failed",
      status: outcome.status,
      error: outcome.error,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
    };
  }

  // Measured spend accumulates on the run. The FIRST cap crossing is
  // allowed (measured cost is only known after the call) but escalates
  // immediately into the one approvals queue; the pre-check above blocks
  // everything after it. Never silently exceeded (§7).
  let newMeasured = measuredSpent;
  let budgetBreached = false;
  if (budget) {
    newMeasured = Number((measuredSpent + (outcome.result.costUsd ?? 0)).toFixed(6));
    await db
      .update(orchestrationRuns)
      .set({ budget: { ...budget, measuredSpentUsd: newMeasured } })
      .where(eq(orchestrationRuns.id, run.id));
    if (budget.capUsd !== null && !budget.overageApproved && newMeasured > budget.capUsd) {
      budgetBreached = true;
      const [pending] = await db
        .select({ id: approvals.id })
        .from(approvals)
        .where(
          and(
            eq(approvals.runId, run.id),
            eq(approvals.stageId, `__budget__:${nodeId}`),
            eq(approvals.status, "pending"),
          ),
        )
        .limit(1);
      if (!pending) {
        await db.insert(approvals).values({
          userId: run.initiatingUserId,
          objectType: "run",
          runId: run.id,
          stageId: `__budget__:${nodeId}`,
          approverUserId: graph.escalationApproverUserId,
        });
      }
      await db.insert(auditLog).values({
        userId: actorUserId,
        objectType: "run",
        objectId: run.id,
        detail: {
          phase: "budget-breach-measured",
          nodeId,
          measuredSpentUsd: newMeasured,
          capUsd: budget.capUsd,
        },
        effect: "require_approval",
        ruleId: "run-budget-cap",
        ruleChain: [],
        reason: `measured spend $${newMeasured} exceeds the $${budget.capUsd} cap after node '${nodeId}' dispatched; approval required to continue`,
      });
    }
  }

  // Append-only history: the dispatch is part of the run's record.
  await db.insert(orchestrationRunEvents).values({
    runId: run.id,
    event: {
      kind: "node_dispatched",
      nodeId,
      agentId: outcome.result.servedAgentId,
      model: outcome.result.model,
      stopReason: outcome.result.stopReason,
      refusal: outcome.result.refusal,
      usage: outcome.result.usage,
      costUsd: outcome.result.costUsd,
      // §6 traceability: exactly which signed-off artifact versions framed
      // this execution
      ...(nested ? { contextArtifacts: nested.artifacts } : {}),
      outputText: outcome.result.outputText.slice(0, 20_000),
    },
    actorUserId,
  });
  await db.insert(auditLog).values({
    userId: actorUserId,
    objectType: "run",
    objectId: run.id,
    detail: {
      nodeId,
      agentId: outcome.result.servedAgentId,
      model: outcome.result.model,
      stopReason: outcome.result.stopReason,
      refusal: outcome.result.refusal,
      costUsd: outcome.result.costUsd,
      phase: "dispatch",
    },
    effect: "allow",
    ruleId: "run-node-dispatched",
    ruleChain: [],
    reason: `node '${nodeId}' executed by its assigned owner under the initiating user's entitlements`,
  });

  return { kind: "ok", result: outcome.result, measuredSpentUsd: newMeasured, budgetBreached };
}

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
 * materialized into the ONE approvals queue. This is the single funnel for
 * ALL run events, so §8 nesting hooks here: a run reaching a terminal state
 * notifies its parent workflow instance (after the transaction commits). */
async function applyRunEvent(
  db: Db,
  runId: string,
  event: RunEvent,
  actorUserId: string,
  dataKey?: string,
): Promise<{ run: RunRow; effects: RunEffect[] }> {
  const applied = await db.transaction(async (tx) => {
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
  // §8 nesting: a terminal nested run advances (or fails) its parent
  // workflow's build stage. applyRunEvent throws on already-terminal runs,
  // so a terminal status here is always a fresh transition.
  if (
    applied.run.workflowInstanceId &&
    (applied.run.status === "completed" || applied.run.status === "aborted")
  ) {
    await handleNestedRunCompletion(db, dataKey, applied.run, actorUserId);
  }
  return applied;
}

/** Decide-endpoint hook (§3): approving an escalated node re-opens it for
 * another attempt; denying it aborts the whole run. */
export async function applyRunApprovalDecision(
  db: Db,
  approvalRow: { runId: string | null; stageId: string | null },
  decision: "approved" | "denied",
  deciderUserId: string,
  dataKey?: string,
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
      await applyRunEvent(db, approvalRow.runId, { kind: "abort" }, deciderUserId, dataKey);
    }
    return;
  }
  const event: RunEvent =
    decision === "approved"
      ? { kind: "retry_node", nodeId: approvalRow.stageId }
      : { kind: "abort" };
  await applyRunEvent(db, approvalRow.runId, event, deciderUserId, dataKey);
}

export type PlanRunResult =
  | { ok: false; status: 400 | 422; body: Record<string, unknown> }
  | {
      ok: true;
      run: RunRow;
      envelope: Array<{ nodeId: string; decision: AgentDecision }>;
      budget: RunBudget;
      overCap: boolean;
    };

/** §3: the task graph arrives as a distinct, reviewable plan — planning
 * validates and stores it; nothing executes until an explicit start event.
 * Shared by POST /v1/runs and the workflow build-stage executor (§8 nesting) —
 * the nested case runs under the WORKFLOW INITIATOR's entitlements, so a
 * workflow can never launch a run its human couldn't. */
export async function planRun(
  db: Db,
  userId: string,
  graphRaw: unknown,
  workflowInstanceId: string | null,
  projectId: string | null = null,
): Promise<PlanRunResult> {
  let graph: TaskGraph;
  try {
    graph = validateGraph(graphRaw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { ok: false, status: 400, body: { error: "invalid_graph", issues: err.issues } };
    }
    throw err;
  }

  const [approver] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, graph.escalationApproverUserId));
  if (!approver) return { ok: false, status: 422, body: { error: "unknown_escalation_approver" } };
  if (projectId) {
    // ADR-0011: the initiating user must be allowed to bill this project
    const attribution = await assertProjectAttribution(db, projectId, userId, false);
    if (!attribution.ok) {
      return { ok: false, status: attribution.status as 400 | 422, body: { error: attribution.error } };
    }
  }

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
        return { ok: false, status: 422, body: { error: "unknown_agent", nodeId: node.id } };
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
      return {
        ok: false,
        status: 422,
        body: {
          error: "entitlement_exceeded",
          nodes: denied.map((e) => ({ nodeId: e.nodeId, decision: e.decision })),
        },
      };
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

    budget.measuredSpentUsd = 0;
    const [run] = await db
      .insert(orchestrationRuns)
      .values({
        name: graph.run,
        initiatingUserId: userId,
        workflowInstanceId,
        projectId,
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
        projectId,
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
    return { ok: true, run: run!, envelope, budget, overCap };
}

export function registerOrchestrationRoutes(
  app: FastifyInstance,
  db: Db,
  opts: { dataKey?: string } = {},
) {
  async function loadRunFor(req: { authCtx: { userId: string | null; isAdmin: boolean } }, runId: string) {
    const [run] = await db.select().from(orchestrationRuns).where(eq(orchestrationRuns.id, runId));
    if (!run) return { error: 404 as const };
    if (!req.authCtx.isAdmin && req.authCtx.userId !== run.initiatingUserId) {
      return { error: 404 as const }; // existence is not disclosed to non-participants
    }
    return { run };
  }

  app.post("/v1/runs", async (req, reply) => {
    const body = createRunSchema.parse(req.body);
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_initiate" });
    const planned = await planRun(db, userId, body.graph, body.workflowInstanceId ?? null, body.projectId ?? null);
    if (!planned.ok) return reply.status(planned.status).send(planned.body);
    return reply.status(201).send({
      id: planned.run.id,
      status: planned.run.status,
      envelope: planned.envelope,
      budget: planned.budget,
      budgetApprovalPending: planned.overCap,
    });
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
      const gate = await gateNodeStartBudget(db, loaded.run, event.nodeId, req.authCtx.userId);
      if (gate.blocked) return reply.status(409).send(gate.blocked);
      nodeCost = gate.nodeCost;
    }

    const { run, effects } = await applyRunEvent(db, runId, event, req.authCtx.userId, opts.dataKey);
    if (event.kind === "node_started" && budget && nodeCost !== null) {
      await db
        .update(orchestrationRuns)
        .set({ budget: { ...budget, spentUsd: Number((budget.spentUsd + nodeCost).toFixed(6)) } })
        .where(eq(orchestrationRuns.id, runId));
    }
    // EPIC-06 §3/§5: node status changes mirror outbound to the linked work
    // item. A mirror failure never fails the run event — it is surfaced here.
    let pmSync: Awaited<ReturnType<typeof mirrorNodeStatus>> = null;
    if ("nodeId" in event) {
      const newStatus = (run.state as RunState).nodeStatuses[event.nodeId];
      if (newStatus) {
        pmSync = await mirrorNodeStatus(db, opts.dataKey, runId, event.nodeId, newStatus, req.authCtx.userId);
      }
    }
    return {
      status: run.status,
      state: run.state,
      readyNodes: readyNodes(run.graph as TaskGraph, run.state as RunState),
      effects,
      ...(pmSync ? { pmSync } : {}),
    };
  });

  // WORKER-NODE DISPATCH: a started node actually executes its work through
  // the same governed dispatch core as /v1/agents/:id/invoke. No routing
  // happens here — the node's CURRENT owner (chosen at plan/re-plan/reassign
  // time, all entitlement-checked) is executed exactly as assigned. The state
  // machine stays authoritative: dispatch produces output, it never moves the
  // node; completing/reviewing remain explicit run events.
  app.post("/v1/runs/:runId/nodes/:nodeId/dispatch", async (req, reply) => {
    const { runId, nodeId } = z
      .object({ runId: z.string().uuid(), nodeId: z.string().min(1).max(64) })
      .parse(req.params);
    const body = dispatchNodeSchema.parse(req.body ?? {});
    const loaded = await loadRunFor(req, runId);
    if (loaded.error) return reply.status(loaded.error).send({ error: "unavailable" });
    if (!req.authCtx.userId) return reply.status(403).send({ error: "bootstrap_cannot_drive" });

    const out = await dispatchRunNode(db, opts.dataKey, loaded.run, nodeId, body, req.authCtx.userId);
    switch (out.kind) {
      case "unknown_node":
        return reply.status(400).send({ error: "unknown_node" });
      case "unknown_agent":
        return reply.status(422).send({ error: "unknown_agent" });
      case "not_in_progress":
        return reply.status(409).send({ error: "node_not_in_progress", status: out.status });
      case "entitlement_denied":
        return reply.status(403).send({ error: "entitlement_exceeded", decision: out.decision });
      case "budget_blocked_measured":
        return reply.status(409).send({
          error: "budget_exceeded_measured",
          measuredSpentUsd: out.measuredSpentUsd,
          capUsd: out.capUsd,
        });
      case "dispatch_failed":
        return reply.status(out.status).send({
          error: out.error,
          ...(out.detail ? { detail: out.detail } : {}),
        });
      case "ok":
        return {
          dispatch: out.result,
          measuredSpentUsd: out.measuredSpentUsd,
          ...(out.budgetBreached ? { budgetBreached: true } : {}),
        };
    }
  });

  // AUTO-ADVANCE: a self-driving pass over the run — same gates, zero new
  // authority. One synchronous call (no scheduler/queue infrastructure, same
  // bias as ADR-0010) starts the run if needed, then repeatedly takes the
  // first ready node through start → governed dispatch → submit. Review
  // stays a human gate by DEFAULT: nodes land in_review and dependents wait;
  // only an explicit acceptReviews=true also accepts each submission.
  // Node-level problems (entitlement, config, refusal) mark that node failed
  // and the loop continues on independent branches; run-level problems
  // (budget) stop the whole pass. Every step is the same audited event/
  // dispatch machinery the manual endpoints use.
  app.post("/v1/runs/:runId/auto", async (req, reply) => {
    const { runId } = runIdParam.parse(req.params);
    const body = autoAdvanceSchema.parse(req.body ?? {});
    const loaded = await loadRunFor(req, runId);
    if (loaded.error) return reply.status(loaded.error).send({ error: "unavailable" });
    if (!req.authCtx.userId) return reply.status(403).send({ error: "bootstrap_cannot_drive" });
    const actor = req.authCtx.userId;

    const reload = async (): Promise<RunRow> =>
      (await db.select().from(orchestrationRuns).where(eq(orchestrationRuns.id, runId)))[0]!;

    let run = loaded.run;
    if (run.status === "completed" || run.status === "aborted") {
      return reply.status(409).send({ error: "run_terminal", status: run.status });
    }
    if (run.status === "planned") {
      const budget = (run.budget ?? null) as RunBudget | null;
      if (
        budget &&
        budget.capUsd !== null &&
        !budget.overageApproved &&
        (budget.estimatedTotalUsd === null || budget.estimatedTotalUsd > budget.capUsd)
      ) {
        return reply.status(409).send({ error: "budget_approval_pending", budget });
      }
      await applyRunEvent(db, runId, { kind: "start" }, actor, opts.dataKey);
    }

    const steps: Array<Record<string, unknown>> = [];
    let stoppedReason = "max_nodes_reached";
    let dispatched = 0;
    let iterations = 0;

    while (dispatched < body.maxNodes) {
      if (++iterations > body.maxNodes * 3 + 10) {
        stoppedReason = "iteration_cap";
        break;
      }
      run = await reload();
      if (run.status !== "running") {
        stoppedReason = run.status === "completed" ? "completed" : "terminal";
        break;
      }
      const graph = run.graph as TaskGraph;
      const state = run.state as RunState;
      const ready = readyNodes(graph, state);
      if (ready.length === 0) {
        const statuses = Object.values(state.nodeStatuses);
        stoppedReason = statuses.includes("in_review")
          ? "awaiting_review"
          : statuses.includes("blocked")
            ? "blocked"
            : statuses.includes("in_progress")
              ? "in_progress_elsewhere"
              : "no_ready_nodes";
        break;
      }
      const nodeId = ready[0]!;

      // run-level measured-budget stop BEFORE starting the node, so a blocked
      // pass never strands a node in_progress.
      const budget = (run.budget ?? null) as RunBudget | null;
      const measuredSpent = budget?.measuredSpentUsd ?? 0;
      if (budget && budget.capUsd !== null && !budget.overageApproved && measuredSpent >= budget.capUsd) {
        stoppedReason = "budget_exceeded_measured";
        steps.push({ nodeId, action: "blocked_budget_measured", measuredSpentUsd: measuredSpent });
        break;
      }

      // §5.2 estimate gate, then the same node_started event the manual path uses
      const gate = await gateNodeStartBudget(db, run, nodeId, actor);
      if (gate.blocked) {
        stoppedReason = "budget_exceeded";
        steps.push({ nodeId, action: "start_blocked_budget", ...gate.blocked });
        break;
      }
      await applyRunEvent(db, runId, { kind: "node_started", nodeId }, actor, opts.dataKey);
      if (budget && gate.nodeCost !== null) {
        await db
          .update(orchestrationRuns)
          .set({
            budget: { ...budget, spentUsd: Number((budget.spentUsd + gate.nodeCost).toFixed(6)) },
          })
          .where(eq(orchestrationRuns.id, runId));
      }

      const out = await dispatchRunNode(
        db,
        opts.dataKey,
        await reload(),
        nodeId,
        { input: body.inputs?.[nodeId], maxTokens: body.maxTokens },
        actor,
      );

      if (out.kind === "budget_blocked_measured") {
        stoppedReason = "budget_exceeded_measured";
        steps.push({ nodeId, action: "blocked_budget_measured", measuredSpentUsd: out.measuredSpentUsd });
        break;
      }
      if (out.kind === "entitlement_denied" || out.kind === "dispatch_failed" || out.kind === "unknown_agent") {
        // node-level problem: fail THIS node (blocked, §3 retry/reassign/
        // escalate applies), keep driving independent branches
        const error =
          out.kind === "entitlement_denied"
            ? `entitlement denied: ${out.decision.reason}`
            : out.kind === "unknown_agent"
              ? "owner agent no longer exists"
              : `dispatch failed: ${out.error}`;
        await applyRunEvent(db, runId, { kind: "node_failed", nodeId, error }, actor, opts.dataKey);
        await mirrorNodeStatus(db, opts.dataKey, runId, nodeId, "blocked", actor);
        steps.push({ nodeId, action: "failed", error });
        continue;
      }
      if (out.kind !== "ok") {
        // unknown_node / not_in_progress cannot happen for a node we just
        // started — defensive stop rather than a silent loop
        stoppedReason = out.kind;
        break;
      }

      dispatched++;
      if (out.result.refusal) {
        await applyRunEvent(
          db,
          runId,
          { kind: "node_failed", nodeId, error: "worker refused the task" },
          actor,
          opts.dataKey,
        );
        await mirrorNodeStatus(db, opts.dataKey, runId, nodeId, "blocked", actor);
        steps.push({ nodeId, action: "refused" });
        if (out.budgetBreached) {
          stoppedReason = "budget_exceeded_measured";
          break;
        }
        continue;
      }

      await applyRunEvent(db, runId, { kind: "node_submitted", nodeId }, actor, opts.dataKey);
      let action = "submitted";
      let finalStatus: "in_review" | "done" = "in_review";
      if (body.acceptReviews) {
        await applyRunEvent(db, runId, { kind: "node_accepted", nodeId }, actor, opts.dataKey);
        action = "accepted";
        finalStatus = "done";
      }
      await mirrorNodeStatus(db, opts.dataKey, runId, nodeId, finalStatus, actor);
      steps.push({ nodeId, action, costUsd: out.result.costUsd });
      if (out.budgetBreached) {
        stoppedReason = "budget_exceeded_measured";
        break;
      }
    }

    run = await reload();
    await db.insert(auditLog).values({
      userId: actor,
      objectType: "run",
      objectId: runId,
      detail: {
        phase: "auto-advance",
        steps: steps.length,
        dispatched,
        stoppedReason,
        acceptReviews: body.acceptReviews ?? false,
      },
      effect: "allow",
      ruleId: "run-auto-advance",
      ruleChain: [],
      reason: `auto-advance pass took ${steps.length} step(s), stopped: ${stoppedReason}`,
    });
    return {
      status: run.status,
      state: run.state,
      readyNodes: readyNodes(run.graph as TaskGraph, run.state as RunState),
      steps,
      stoppedReason,
      measuredSpentUsd: ((run.budget ?? null) as RunBudget | null)?.measuredSpentUsd ?? 0,
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

  // fleet view for admins; non-admins see exactly their own initiated runs
  app.get("/v1/runs", async (req, reply) => {
    const { status } = z
      .object({ status: z.enum(["planned", "running", "completed", "aborted"]).optional() })
      .parse(req.query);
    const conditions = [];
    if (status) conditions.push(eq(orchestrationRuns.status, status));
    if (!req.authCtx.isAdmin) {
      if (!req.authCtx.userId) return reply.status(403).send({ error: "bootstrap_has_no_runs" });
      conditions.push(eq(orchestrationRuns.initiatingUserId, req.authCtx.userId));
    }
    const rows = await db
      .select()
      .from(orchestrationRuns)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(orchestrationRuns.createdAt));
    return { runs: rows };
  });
}
