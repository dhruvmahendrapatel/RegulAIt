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
  /** pillar 7 tool-using worker: MCP servers this node's worker may draw tools
   * from. A DECLARATION ONLY — the gateway narrows it to exactly the tools the
   * INITIATING user is entitled to on those servers; declaring a server the
   * user isn't granted on simply yields no tools. */
  toolServers: z.array(z.string().uuid()).optional(),
  /** optional allow-list of tool NAMES within the declared servers; absent =
   * every entitled tool on those servers */
  toolNames: z.array(z.string().min(1).max(128)).optional(),
  /** pillar 7: max model turns in the node's tool-using loop (each turn is one
   * measured, governed dispatch). Bounded so a runaway declaration can't
   * request an unbounded loop; the gateway also applies the per-run budget and
   * measured-spend caps per turn. */
  maxTurns: z.number().int().min(1).max(20).optional(),
  /** §5.1 Team-Lead delegation: the id of another node in this graph acting as
   * this node's LEAD. The lead's `allowedAgentIds`/`allowedToolRefs` form a
   * CEILING that composes transitively up the chain and can only NARROW what
   * the initiating user is already granted — never widen it (default-deny is
   * preserved). A node with no lead is unconstrained beyond the user's own
   * grants, so flat runs behave exactly as before. */
  leadNodeId: z.string().min(1).max(64).optional(),
  /** §5.1 ceiling this node (as a lead) imposes on its delegated workers: the
   * agent ids a worker under it may be owned by. Absent = "no agent constraint
   * at this hop" (the intersection identity). Applies only to nodes that name
   * this node via `leadNodeId` — never to this node itself. */
  allowedAgentIds: z.array(z.string().uuid()).optional(),
  /** §5.1 ceiling this node (as a lead) imposes on its delegated workers: the
   * tool NAMES a worker under it may call (same shape as `toolNames`). Absent =
   * "no tool constraint at this hop". */
  allowedToolRefs: z.array(z.string().min(1).max(128)).optional(),
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
    // §5.1 Team-Lead delegation: a leadNodeId must reference an existing node,
    // never itself, and the lead chain (leadNodeId edges) must be acyclic — a
    // ceiling that referenced itself, a stranger, or a loop could not compose.
    for (const n of graph.nodes) {
      if (n.leadNodeId === undefined) continue;
      if (n.leadNodeId === n.id) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `node '${n.id}' is its own lead` });
      } else if (!ids.has(n.leadNodeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `node '${n.id}' names unknown lead node '${n.leadNodeId}'`,
        });
      }
    }
    const leadColor = new Map<string, 0 | 1 | 2>();
    const visitLead = (id: string): boolean => {
      const c = leadColor.get(id) ?? 0;
      if (c === 1) return true;
      if (c === 2) return false;
      leadColor.set(id, 1);
      const lead = byId.get(id)?.leadNodeId;
      if (lead && lead !== id && byId.has(lead) && visitLead(lead)) return true;
      leadColor.set(id, 2);
      return false;
    };
    if (graph.nodes.some((n) => visitLead(n.id))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "task graph contains a lead-chain cycle" });
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
// §5.1 Team-Lead entitlement-narrowing ceiling
// ---------------------------------------------------------------------------

/** The delegation ceiling a node inherits from its lead chain. `null` at a
 * field means "no constraint of that kind above this node" — the effective set
 * is then the initiating user's own grants, unchanged. A non-null array is the
 * INTERSECTION of every ancestor lead's declared allow-list of that kind, so it
 * can only be a subset of what the user is granted, never a superset. An empty
 * array means "nothing of this kind is allowed under the chain". */
export interface NodeCeiling {
  /** agent ids a worker under this chain may be owned by; null = unconstrained */
  agentIds: string[] | null;
  /** tool NAMES a worker under this chain may call; null = unconstrained */
  toolRefs: string[] | null;
}

/** Intersect two ceiling hops. `null` is the identity (no constraint at that
 * hop), so null ∩ x = x. Two sets intersect to their shared members; an empty
 * result stays empty (nothing allowed). A ceiling can therefore only ever
 * SHRINK as the chain lengthens — the invariant that makes delegation safe. */
function intersectCeiling(a: readonly string[] | null, b: readonly string[] | null): string[] | null {
  if (a === null) return b === null ? null : [...b];
  if (b === null) return [...a];
  const bset = new Set(b);
  return a.filter((x) => bset.has(x));
}

/**
 * PURE helper (no I/O): walk the `leadNodeId` chain UP from `nodeId` and
 * intersect every ancestor lead's `allowedAgentIds`/`allowedToolRefs` into one
 * ceiling. The node's OWN allow-lists are the ceiling it imposes on ITS
 * workers, not on itself, so they are not included here — a node's ceiling
 * comes entirely from the leads above it.
 *
 * Transitivity falls straight out of the fold: grandchild ≤ child ≤ lead ≤
 * (the user's own grants, applied separately by the policy kernel). A node
 * with no lead returns {null, null} — unconstrained beyond its user's grants,
 * so flat runs are byte-identical to pre-delegation behaviour. The walk is
 * cycle-guarded so the helper is safe on any input, even though validateGraph
 * already rejects lead-chain cycles.
 */
export function computeNodeCeiling(graph: TaskGraph, nodeId: string): NodeCeiling {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  let agentIds: string[] | null = null;
  let toolRefs: string[] | null = null;
  const seen = new Set<string>([nodeId]);
  let cur = byId.get(nodeId)?.leadNodeId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const lead = byId.get(cur);
    if (!lead) break;
    agentIds = intersectCeiling(agentIds, lead.allowedAgentIds ?? null);
    toolRefs = intersectCeiling(toolRefs, lead.allowedToolRefs ?? null);
    cur = lead.leadNodeId;
  }
  return { agentIds, toolRefs };
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
