/**
 * @regulait/orchestration-kernel — pillar 7's pure decision core (EPIC-05,
 * MULTI_AGENT_ORCHESTRATION_SPEC §2–§5).
 *
 * Pure and zero-I/O like the policy/workflow/optimizer kernels: the gateway
 * loads state, this kernel validates task graphs and transitions run state,
 * the gateway persists results and executes effects.
 *
 * Scope note (§3): the task graph is INPUT here — submitted by the initiating
 * user or a template. Whether a PM Agent may generate it with a model call is
 * an open product question; nothing in this kernel assumes either answer.
 *
 * §5.1 (inheritance, never escalation) is enforced at the gateway by running
 * the policy kernel's evaluateAgent for every node owner under the INITIATING
 * user's grants and ceiling — this kernel never sees an entitlement it could
 * widen, and reassignment goes through the same check.
 */

import { z } from "zod";

export class RunStateError extends Error {}

// §3/§6: the spec's five node statuses, verbatim vocabulary.
export const NODE_STATUSES = [
  "not_started",
  "in_progress",
  "blocked",
  "in_review",
  "done",
] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const taskNodeSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  /** registry agent acting as this worker (§2); checked against the initiating user's entitlements */
  ownerAgentId: z.string().uuid(),
  /** invocation mode the worker runs in; same mode vocabulary as agent grants */
  mode: z.string().min(1).max(64),
  dependsOn: z.array(z.string().min(1)).default([]),
  /** §4: false = this node serializes — nothing else runs while it does */
  parallelizable: z.boolean().default(true),
  /** §4 ownership: files/modules this node owns while it runs */
  files: z.array(z.string().min(1)).optional(),
  /** §5.2: planner-declared token estimate for this node; the gateway falls
   * back to a heuristic from the title when absent */
  estimate: z
    .object({ in: z.number().int().positive(), out: z.number().int().positive() })
    .optional(),
});
export type TaskNode = z.infer<typeof taskNodeSchema>;

export const taskGraphSchema = z
  .object({
    run: z.string().min(1).max(200),
    /** §3: failure escalations land in the ONE Approvals Queue, decided by this named user */
    escalationApproverUserId: z.string().uuid(),
    nodes: z.array(taskNodeSchema).min(1),
  })
  .superRefine((graph, ctx) => {
    const ids = new Set<string>();
    for (const n of graph.nodes) {
      if (ids.has(n.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate node id '${n.id}'` });
      }
      ids.add(n.id);
    }
    for (const n of graph.nodes) {
      for (const dep of n.dependsOn) {
        if (dep === n.id) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `node '${n.id}' depends on itself` });
        } else if (!ids.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `node '${n.id}' depends on unknown node '${dep}'`,
          });
        }
      }
    }
    // cycle detection (iterative DFS, three-color)
    const color = new Map<string, 0 | 1 | 2>();
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const visit = (id: string): boolean => {
      const c = color.get(id) ?? 0;
      if (c === 1) return true;
      if (c === 2) return false;
      color.set(id, 1);
      for (const dep of byId.get(id)?.dependsOn ?? []) {
        if (byId.has(dep) && visit(dep)) return true;
      }
      color.set(id, 2);
      return false;
    };
    if (graph.nodes.some((n) => visit(n.id))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "task graph contains a cycle" });
    }
    // §4 ownership: two nodes touching the same files must be ordered by a
    // dependency path (either direction) — otherwise they could run in
    // parallel on shared state, which the spec forbids.
    const reaches = (from: string, to: string): boolean => {
      const seen = new Set<string>();
      const stack = [from];
      while (stack.length) {
        const cur = stack.pop()!;
        if (cur === to) return true;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const dep of byId.get(cur)?.dependsOn ?? []) stack.push(dep);
      }
      return false;
    };
    for (let i = 0; i < graph.nodes.length; i++) {
      for (let j = i + 1; j < graph.nodes.length; j++) {
        const a = graph.nodes[i]!;
        const b = graph.nodes[j]!;
        if (!a.files?.length || !b.files?.length) continue;
        const shared = a.files.filter((f) => b.files!.includes(f));
        if (shared.length === 0) continue;
        if (!reaches(a.id, b.id) && !reaches(b.id, a.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `nodes '${a.id}' and '${b.id}' share ownership of '${shared[0]}' without a dependency ordering them`,
          });
        }
      }
    }
  });
export type TaskGraph = z.infer<typeof taskGraphSchema>;

export function validateGraph(raw: unknown): TaskGraph {
  return taskGraphSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// Run state machine
// ---------------------------------------------------------------------------

export type RunStatus = "planned" | "running" | "completed" | "aborted";

export interface RunState {
  status: RunStatus;
  nodeStatuses: Record<string, NodeStatus>;
  /** retry count per node (§3 failure handling) */
  attempts: Record<string, number>;
  /** current owner per node — reassignment (§3) changes this, never the graph */
  owners: Record<string, string>;
  lastError: Record<string, string>;
}

export function initialRunState(graph: TaskGraph): RunState {
  return {
    status: "planned",
    nodeStatuses: Object.fromEntries(graph.nodes.map((n) => [n.id, "not_started"])),
    attempts: Object.fromEntries(graph.nodes.map((n) => [n.id, 0])),
    owners: Object.fromEntries(graph.nodes.map((n) => [n.id, n.ownerAgentId])),
    lastError: {},
  };
}

/**
 * Nodes dispatchable right now: not_started with every dependency done. §4
 * serialization: while a parallelizable:false node is in progress nothing else
 * dispatches, and such a node itself only dispatches into an idle run.
 */
export function readyNodes(graph: TaskGraph, state: RunState): string[] {
  if (state.status !== "running") return [];
  const inProgress = graph.nodes.filter((n) => state.nodeStatuses[n.id] === "in_progress");
  if (inProgress.some((n) => !n.parallelizable)) return [];
  const busy = inProgress.length > 0;
  return graph.nodes
    .filter(
      (n) =>
        state.nodeStatuses[n.id] === "not_started" &&
        n.dependsOn.every((d) => state.nodeStatuses[d] === "done") &&
        (n.parallelizable || !busy),
    )
    .map((n) => n.id);
}

export type RunEvent =
  | { kind: "start" }
  | { kind: "node_started"; nodeId: string }
  | { kind: "node_submitted"; nodeId: string }
  | { kind: "node_accepted"; nodeId: string }
  | { kind: "node_failed"; nodeId: string; error: string }
  | { kind: "retry_node"; nodeId: string }
  | { kind: "reassign_node"; nodeId: string; ownerAgentId: string }
  | { kind: "escalate_node"; nodeId: string }
  | { kind: "abort" };

export type RunEffect =
  | { kind: "dispatch_nodes"; nodeIds: string[] }
  | { kind: "request_approval"; nodeId: string };

export interface RunTransition {
  state: RunState;
  effects: RunEffect[];
}

function nodeOrThrow(graph: TaskGraph, nodeId: string): TaskNode {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new RunStateError(`unknown node '${nodeId}'`);
  return node;
}

function expectStatus(state: RunState, nodeId: string, allowed: NodeStatus[]): void {
  const current = state.nodeStatuses[nodeId];
  if (!current || !allowed.includes(current)) {
    throw new RunStateError(
      `node '${nodeId}' is '${current}', expected one of: ${allowed.join(", ")}`,
    );
  }
}

export function transitionRun(graph: TaskGraph, state: RunState, event: RunEvent): RunTransition {
  if (state.status === "completed" || state.status === "aborted") {
    throw new RunStateError(`run is terminal ('${state.status}')`);
  }
  const next: RunState = {
    ...state,
    nodeStatuses: { ...state.nodeStatuses },
    attempts: { ...state.attempts },
    owners: { ...state.owners },
    lastError: { ...state.lastError },
  };
  const effects: RunEffect[] = [];
  const dispatchReady = () => {
    const ready = readyNodes(graph, next);
    if (ready.length > 0) effects.push({ kind: "dispatch_nodes", nodeIds: ready });
  };

  switch (event.kind) {
    case "start": {
      if (state.status !== "planned") throw new RunStateError("run already started");
      next.status = "running";
      dispatchReady();
      break;
    }
    case "node_started": {
      if (state.status !== "running") throw new RunStateError("run is not running");
      const node = nodeOrThrow(graph, event.nodeId);
      expectStatus(next, node.id, ["not_started"]);
      if (!readyNodes(graph, next).includes(node.id)) {
        throw new RunStateError(`node '${node.id}' is not ready (dependencies or serialization)`);
      }
      next.nodeStatuses[node.id] = "in_progress";
      break;
    }
    case "node_submitted": {
      const node = nodeOrThrow(graph, event.nodeId);
      expectStatus(next, node.id, ["in_progress"]);
      next.nodeStatuses[node.id] = "in_review";
      break;
    }
    case "node_accepted": {
      const node = nodeOrThrow(graph, event.nodeId);
      expectStatus(next, node.id, ["in_review"]);
      next.nodeStatuses[node.id] = "done";
      if (graph.nodes.every((n) => next.nodeStatuses[n.id] === "done")) {
        next.status = "completed";
      } else {
        dispatchReady();
      }
      break;
    }
    case "node_failed": {
      const node = nodeOrThrow(graph, event.nodeId);
      expectStatus(next, node.id, ["in_progress", "in_review"]);
      next.nodeStatuses[node.id] = "blocked";
      next.lastError[node.id] = event.error;
      break;
    }
    case "retry_node": {
      const node = nodeOrThrow(graph, event.nodeId);
      expectStatus(next, node.id, ["blocked"]);
      next.nodeStatuses[node.id] = "not_started";
      next.attempts[node.id] = (next.attempts[node.id] ?? 0) + 1;
      dispatchReady();
      break;
    }
    case "reassign_node": {
      const node = nodeOrThrow(graph, event.nodeId);
      expectStatus(next, node.id, ["blocked"]);
      next.nodeStatuses[node.id] = "not_started";
      next.attempts[node.id] = (next.attempts[node.id] ?? 0) + 1;
      next.owners[node.id] = event.ownerAgentId;
      dispatchReady();
      break;
    }
    case "escalate_node": {
      const node = nodeOrThrow(graph, event.nodeId);
      expectStatus(next, node.id, ["blocked"]);
      effects.push({ kind: "request_approval", nodeId: node.id });
      break;
    }
    case "abort": {
      next.status = "aborted";
      break;
    }
  }
  return { state: next, effects };
}

// ---------------------------------------------------------------------------
// §5.2 per-run budget: pure cost estimation over the graph. All numbers are
// ESTIMATES until real model dispatch exists — enforcement is estimate-based
// and every consumer labels it so. An unpriced owner makes the total
// incomparable (null), which callers must treat as fail-closed when a cap is
// set: a cap that cannot be checked is a cap that requires approval, never a
// cap silently skipped (§7).
// ---------------------------------------------------------------------------

export interface NodeTokenEstimate {
  in: number;
  out: number;
}

export interface AgentPricingRef {
  costPerMTokIn: number | null;
  costPerMTokOut: number | null;
}

export interface GraphCostEstimate {
  /** null when any node's owner is unpriced */
  totalUsd: number | null;
  perNodeUsd: Record<string, number | null>;
  unpricedNodes: string[];
}

export function estimateNodeCost(
  pricing: AgentPricingRef | undefined,
  tokens: NodeTokenEstimate,
): number | null {
  if (!pricing || pricing.costPerMTokIn === null || pricing.costPerMTokOut === null) return null;
  return (tokens.in * pricing.costPerMTokIn + tokens.out * pricing.costPerMTokOut) / 1_000_000;
}

export function estimateGraphCost(
  graph: TaskGraph,
  owners: Record<string, string>,
  pricing: Record<string, AgentPricingRef>,
  tokensFor: (node: TaskNode) => NodeTokenEstimate,
): GraphCostEstimate {
  const perNodeUsd: Record<string, number | null> = {};
  const unpricedNodes: string[] = [];
  let total: number | null = 0;
  for (const node of graph.nodes) {
    const owner = owners[node.id] ?? node.ownerAgentId;
    const cost = estimateNodeCost(pricing[owner], node.estimate ?? tokensFor(node));
    perNodeUsd[node.id] = cost;
    if (cost === null) {
      unpricedNodes.push(node.id);
      total = null;
    } else if (total !== null) {
      total += cost;
    }
  }
  return {
    totalUsd: total === null ? null : Number(total.toFixed(6)),
    perNodeUsd,
    unpricedNodes,
  };
}
