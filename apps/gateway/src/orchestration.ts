import type { FastifyInstance, FastifyReply } from "fastify";
import {
  agentGrants,
  agents,
  approvals,
  auditLog,
  and,
  costEvents,
  desc,
  eq,
  inArray,
  orchestrationRunEvents,
  orchestrationRuns,
  projectContextItems,
  traceSpans,
  traces,
  userAgentPolicies,
  users,
  workflowArtifacts,
  workflowInstances,
  type Db,
  type TraceStatus,
} from "@regulait/db";
import type { WorkflowDefinition } from "@regulait/workflow-kernel";
import { evaluateAgent, type AgentDecision } from "@regulait/policy-kernel";
import {
  computeNodeCeiling,
  computeNodeBudgetCeiling,
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
import {
  classifyComplexity,
  estimateTokens,
  planRequestBatching,
  routeModel,
} from "@regulait/optimizer-kernel";
import { effectiveTechniqueMode, loadOrgSettings } from "./org-settings.js";
import { recordRunInputs, recordRunOutput, recordToolResultInput } from "./lineage.js";
import {
  isModelProviderKind,
  type ModelChatMessage,
  type ModelContentBlock,
} from "@regulait/model-provider";
import {
  autoAdvanceSchema,
  createRunSchema,
  dispatchNodeSchema,
  runEventSchema,
} from "@regulait/shared";
import {
  agentProviderToken,
  configuredProviders,
  executeGovernedDispatch,
  type SkippedCandidate,
} from "./agents-connectors.js";
// ADR-0070 — the run's trace tree: run -> node -> model turn -> tool call.
import {
  childContext,
  closeSpan,
  finishTrace,
  openSpan,
  traceForRoot,
  type TraceContext,
} from "./tracing.js";
import { executeGovernedToolCall, resolveNodeToolContext } from "./mcp-proxy.js";
import { loadAgentRevocations, loadRoleAgentGrants } from "./entitlements.js";
import { assertProjectAttribution, projectPiiMode } from "./projects.js";
// ADR-0079: the plan-only gate, shared verbatim with the invoke path.
import { guardInstanceAttributedCall, isPlanSafeMode } from "./plan-only.js";
import { loadInterceptionSettings } from "./compat-core.js";
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
  /** §5.2 measured per-node running total: provider-measured actuals summed PER
   * NODE, so a node's own transitive budget ceiling can be enforced on measured
   * dollars the same way the run cap is. Absent/missing key = $0 for that node.
   * Rides the run JSONB — no migration. */
  measuredPerNodeUsd?: Record<string, number>;
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

// --- WORKER-NODE STREAMING (pillar 7 + ADR-0019 §8.4) ----------------------
// The dispatch and auto-advance routes accept `stream: true` and deliver the
// worker's tokens as SSE with EXACTLY the invoke path's guarantees, reusing
// its exported building blocks (executeGovernedDispatch's onText,
// projectPiiMode, loadInterceptionSettings) rather than re-deriving them:
//  - every gate resolves BEFORE any stream byte leaves: entitlement, budget,
//    node-state and config failures are real HTTP errors, never a 200 stream
//    (the stream opens LAZILY on the first delta, the compat-surface pattern);
//  - a block-mode PII project gets NO delta stream — the same governed
//    dispatch runs fully buffered and returns ordinary JSON, disclosed via
//    `streamingSuppressed: true` (or a 400 when the org's ADR-0021
//    streamingOnBlockMode is 'reject');
//  - non-stream requests take a code path with byte-identical responses.

/** The `stream` opt-in, read from the RAW body — dispatchNodeSchema /
 * autoAdvanceSchema stay untouched in @regulait/shared (they strip unknown
 * keys, so the flag rides beside them without widening any package schema). */
const streamFlagSchema = z.object({ stream: z.boolean().optional() });

type StreamRequest =
  | { mode: "off" }
  | { mode: "stream" }
  | { mode: "suppressed" }
  | { mode: "rejected"; status: 400; body: { error: string; detail: string } };

/** Resolve a caller's stream request against the run's project PII posture —
 * the SAME ADR-0019 §8.4 suppression (and ADR-0021 'reject' escalation) the
 * invoke path applies, evaluated BEFORE any stream could open. `stream` absent
 * short-circuits to "off" with zero extra queries (non-stream path unchanged). */
async function resolveStreamRequest(
  db: Db,
  rawBody: unknown,
  projectId: string | null,
): Promise<StreamRequest> {
  const { stream } = streamFlagSchema.parse(rawBody ?? {});
  if (stream !== true) return { mode: "off" };
  if ((await projectPiiMode(db, projectId)) !== "block") return { mode: "stream" };
  const iset = await loadInterceptionSettings(db);
  if (iset.streamingOnBlockMode === "reject") {
    return {
      mode: "rejected",
      status: 400,
      body: {
        error: "streaming_rejected_on_block_project",
        detail:
          "this project's PII mode is 'block' and this deployment rejects streaming on such projects — retry without stream:true",
      },
    };
  }
  return { mode: "suppressed" };
}

/** Lazily-opened SSE channel with the invoke path's exact event framing
 * (`event: <name>\ndata: <json>\n\n`). Nothing is hijacked until the first
 * send, so a failure raised before any delta still returns a real HTTP error
 * instead of a 200 that carries a failure — the compat-surface pattern. */
function sseChannel(reply: FastifyReply) {
  let opened = false;
  return {
    get opened() {
      return opened;
    },
    send(event: string, data: unknown) {
      if (!opened) {
        opened = true;
        reply.hijack();
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
      }
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      if (opened) reply.raw.end();
    },
  };
}

/** Gateway-level node enrichment (same pattern as RunBudget living beside the
 * kernel's state): a node may carry a multi-sentence `instruction` — the
 * actual work order its worker is prompted with, where the ≤200-char title
 * stays a label. The kernel's node schema strips unknown keys on validation,
 * so instructions are lifted from the RAW graph payload and re-attached to
 * the stored graph; dispatch falls back title-ward when absent. */
function nodeInstruction(node: TaskNode): string | undefined {
  const instruction = (node as TaskNode & { instruction?: unknown }).instruction;
  return typeof instruction === "string" && instruction.trim() ? instruction : undefined;
}

function attachInstructions(graph: TaskGraph, graphRaw: unknown, maxChars = 100_000): void {
  const rawNodes = (graphRaw as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(rawNodes)) return;
  const byId = new Map<string, string>();
  for (const raw of rawNodes) {
    if (raw === null || typeof raw !== "object") continue;
    const { id, instruction } = raw as { id?: unknown; instruction?: unknown };
    if (typeof id !== "string" || typeof instruction !== "string") continue;
    const text = instruction.trim();
    // same ceiling as an explicit dispatch-time input override; ADR-0021: the
    // org sharedContextMaxChars dial can narrow it (default 100_000 = today)
    if (text) byId.set(id, text.slice(0, maxChars));
  }
  for (const node of graph.nodes) {
    const instruction = byId.get(node.id);
    if (instruction) (node as TaskNode & { instruction?: string }).instruction = instruction;
  }
}

type RunRow = typeof orchestrationRuns.$inferSelect;

/** The open-transaction type the codebase's db.transaction callbacks receive. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Route-level flows (the decide endpoint) thread their open transaction down
 * so the decision write and the event it causes commit or roll back together;
 * standalone callers pass the Db itself. */
export type DbOrTx = Db | Tx;

/** Run `fn` inside a transaction on `dbx`. On a Db this opens a real
 * transaction; on an already-open transaction it opens a savepoint, so the
 * whole flow stays atomic from the outermost caller's perspective. */
export function inTransaction<T>(dbx: DbOrTx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (dbx as Db).transaction(fn);
}

/** A step that must run only after the decision transaction has committed
 * (git executions, nested-run completion): the decision is durable first, and
 * a failure here can never be mistaken for a failed decision. */
export type ApprovalPostCommit = (db: Db) => Promise<void>;

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
  // §5.2 Team-Lead SUB-BUDGET: the transitive per-node ceiling (min of this
  // node's own cap and every lead ancestor's) is enforced ON TOP OF the
  // run-level cap. A node whose estimated cost exceeds the ceiling delegation
  // assigned it pauses and escalates into the SAME queue — a lead can cap a
  // worker's spend below the run cap, and that cap only ever tightens down the
  // chain. Absent cap = only the run cap applies (byte-identical to before).
  const nodeCapUsd = computeNodeBudgetCeiling(graph, node.id);
  if (
    nodeCapUsd !== null &&
    !budget.overageApproved &&
    (nodeCost === null || nodeCost > nodeCapUsd)
  ) {
    const [pending] = await db
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.runId, run.id),
          eq(approvals.stageId, `__nodebudget__:${node.id}`),
          eq(approvals.status, "pending"),
        ),
      )
      .limit(1);
    if (!pending) {
      await db.insert(approvals).values({
        userId: run.initiatingUserId,
        objectType: "run",
        runId: run.id,
        stageId: `__nodebudget__:${node.id}`,
        approverUserId: graph.escalationApproverUserId,
      });
    }
    await db.insert(auditLog).values({
      userId: actorUserId,
      objectType: "run",
      objectId: run.id,
      detail: { phase: "node-budget-breach", nodeId: node.id, estimatedNodeUsd: nodeCost, nodeCapUsd },
      effect: "require_approval",
      ruleId: "node-budget-cap",
      ruleChain: [],
      reason:
        nodeCost === null
          ? `node '${node.id}' has an unpriced owner under a per-node budget cap; approval required`
          : `node '${node.id}' estimated at $${nodeCost.toFixed(6)} exceeds its delegated per-node cap of $${nodeCapUsd}`,
    });
    return {
      blocked: { error: "node_budget_exceeded", nodeId: node.id, estimatedNodeUsd: nodeCost, nodeCapUsd },
      nodeCost,
    };
  }
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
  | { kind: "node_budget_blocked_measured"; nodeId: string; measuredNodeUsd: number; nodeCapUsd: number }
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
        /** pillar 7 loop trace: model turns taken and governed tool calls made */
        turns: number;
        toolCalls: number;
        /** true when the loop halted with a tool approval pending in the queue */
        toolApprovalPending?: boolean;
      };
      measuredSpentUsd: number;
      budgetBreached: boolean;
      /** §5.2 measured per-node ceiling was crossed on this dispatch (first
       * crossing allowed-but-escalated; the next turn is pre-gated) */
      nodeBudgetBreached: boolean;
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
/**
 * ADR-0050 §2 — resolve declared shared-context KEYS to the CURRENT ACCEPTED
 * REVISION of each, inside the run's OWN project.
 *
 * Three constraints, all load-bearing:
 *   - **Same project only.** Reading another project's context here would be a
 *     pillar-4 entitlement hole wearing a convenience feature's clothes.
 *   - **The accepted head, pinned.** The resolved revision NUMBER is what both
 *     the injection and the lineage edge use, so the graph points at the
 *     version actually supplied rather than at "the key".
 *   - **An unknown key is absent, not an error.** A worker naming context that
 *     does not exist yet is ordinary; failing an otherwise-valid dispatch over
 *     it would be worse than supplying less.
 */
async function resolveSuppliedContext(
  db: Db,
  projectId: string | null,
  keys: string[] | undefined,
): Promise<{ system?: string; items: Array<{ id: string; key: string; revision: number }> }> {
  if (!projectId || !keys || keys.length === 0) return { items: [] };
  const rows = await db
    .select()
    .from(projectContextItems)
    .where(
      and(
        eq(projectContextItems.projectId, projectId),
        inArray(projectContextItems.key, keys),
        eq(projectContextItems.accepted, true),
      ),
    );
  const head = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const prev = head.get(r.key);
    if (!prev || r.revision > prev.revision) head.set(r.key, r);
  }
  // preserve the caller's declared order so the prompt is deterministic
  const items = keys.map((k) => head.get(k)).filter((r): r is (typeof rows)[number] => Boolean(r));
  if (items.length === 0) return { items: [] };
  // The FIRST LINE names exactly which item VERSIONS were supplied. That is not
  // decoration: it is the same manifest the `flowed_into` edges are built from,
  // stated where the worker (and anyone reading a transcript) can see it, so a
  // divergence between what lineage claims was supplied and what the prompt
  // actually carried would be visible rather than latent.
  const manifest = items.map((i) => `${i.key} v${i.revision}`).join(", ");
  return {
    system:
      `Shared project context supplied to this worker: ${manifest}.\n\n` +
      items.map((i) => `--- context '${i.key}' v${i.revision} ---\n${i.content}`).join("\n\n"),
    items: items.map((i) => ({ id: i.id, key: i.key, revision: i.revision })),
  };
}

/** join the nested-run scope lock and the supplied context into one system
 * prompt, preserving `undefined` when there is neither (so a dispatch with no
 * context is byte-identical to the pre-lineage behaviour) */
function composeSystem(a: string | undefined, b: string | undefined): string | undefined {
  const parts = [a, b].filter((x): x is string => Boolean(x));
  return parts.length === 0 ? undefined : parts.join("\n\n");
}

/**
 * ADR-0070 — THE RUN'S TREE.
 *
 * An orchestration run is the shape a trace exists for: a DAG of nodes, each of
 * which is a bounded agentic loop of model turns and governed tool calls. Until
 * now that structure lived in `orchestration_run_events` (an append-only list)
 * and in `state.nodeStatuses` (a map). Neither is a causal tree, and neither
 * says which model turn asked for which tool call.
 *
 * So: one `run` span per run (created once, reused by every node), one
 * `run_node` span per node dispatch under it, one `llm` span per TURN of that
 * node's loop under THAT, and every tool call the turn made under the turn.
 * Four real levels, from four real relationships — not a flat list relabelled.
 *
 * Every early return below (unknown node, not in progress, entitlement denied,
 * budget blocked, dispatch failed) closes the node span with its own status and
 * reason. A node that never ran is a `denied` span saying why, because the
 * whole point is that the tree explains an absence.
 */
/** The run's own display name: the graph's `run` label (its title), falling
 * back to a short id. */
function runSpanName(run: RunRow): string {
  const label = (run.graph as TaskGraph).run;
  return typeof label === "string" && label.length > 0 ? label : `run ${run.id.slice(0, 8)}`;
}

async function ensureRunSpan(
  db: Db,
  ctx: TraceContext | null,
  run: RunRow,
): Promise<string | null> {
  if (!ctx) return null;
  try {
    const [existing] = await db
      .select({ id: traceSpans.id })
      .from(traceSpans)
      .where(
        and(eq(traceSpans.traceId, ctx.traceId), eq(traceSpans.kind, "run"), eq(traceSpans.runId, run.id)),
      )
      .limit(1);
    if (existing) return existing.id;
  } catch {
    return null;
  }
  return openSpan(db, ctx, {
    kind: "run",
    name: runSpanName(run),
    startedAt: run.createdAt ?? new Date(),
    runId: run.id,
    attributes: { initiatingUserId: run.initiatingUserId, ...(run.projectId ? { projectId: run.projectId } : {}) },
  });
}

async function dispatchRunNode(
  db: Db,
  dataKey: string | undefined,
  run: RunRow,
  nodeId: string,
  args: {
    input?: string | undefined;
    maxTokens?: number | undefined;
    maxTurns?: number | undefined;
    onDelta?: ((text: string) => void) | undefined;
    contextKeys?: string[] | undefined;
  },
  actorUserId: string,
): Promise<NodeDispatchOutcome> {
  const runCtx = await traceForRoot(db, {
    kind: "run",
    name: runSpanName(run),
    userId: run.initiatingUserId,
    projectId: run.projectId ?? null,
    sessionId: run.id,
    rootRefId: run.id,
  });
  const runSpanId = await ensureRunSpan(db, runCtx, run);
  const nodeCtx = childContext(runCtx, runSpanId);
  const nodeSpanId = await openSpan(db, nodeCtx, {
    kind: "run_node",
    name: nodeId,
    startedAt: new Date(),
    runId: run.id,
    nodeId,
  });
  const outcome = await dispatchRunNodeInner(
    db,
    dataKey,
    run,
    nodeId,
    args,
    actorUserId,
    childContext(nodeCtx, nodeSpanId),
  );
  // Every non-ok outcome is a DECISION about this node, so the node span says
  // which one, verbatim, rather than merely ending.
  const [status, reason]: [TraceStatus, string | null] =
    outcome.kind === "ok"
      ? ["ok", null]
      : outcome.kind === "dispatch_failed"
        ? ["error", `${outcome.error}${outcome.detail ? `: ${outcome.detail}` : ""}`]
        : outcome.kind === "entitlement_denied"
          ? ["denied", outcome.decision.reason]
          : outcome.kind === "budget_blocked_measured"
            ? [
                "denied",
                `run measured spend $${outcome.measuredSpentUsd} is at or over the $${outcome.capUsd} cap; ` +
                  `further dispatches are blocked until the overage is approved`,
              ]
            : outcome.kind === "node_budget_blocked_measured"
              ? [
                  "denied",
                  `node measured spend $${outcome.measuredNodeUsd} is at or over its delegated ` +
                    `per-node cap of $${outcome.nodeCapUsd}`,
                ]
              : outcome.kind === "unknown_node"
                ? ["error", `node '${nodeId}' is not in this run's graph`]
                : outcome.kind === "unknown_agent"
                  ? ["error", `node '${nodeId}' owner agent no longer exists`]
                  : ["error", `node '${nodeId}' is not in progress`];
  await closeSpan(db, nodeSpanId, status, reason);
  return outcome;
}

async function dispatchRunNodeInner(
  db: Db,
  dataKey: string | undefined,
  run: RunRow,
  nodeId: string,
  args: {
    input?: string | undefined;
    maxTokens?: number | undefined;
    maxTurns?: number | undefined;
    /** streaming delta callback, threaded to executeGovernedDispatch's onText
     * across every turn of the worker loop. Callers pass it ONLY after the
     * ADR-0019 §8.4 suppression check (resolveStreamRequest) has allowed a
     * stream; absent = byte-identical non-streaming dispatch. */
    onDelta?: ((text: string) => void) | undefined;
    /** ADR-0050: shared-context keys to SUPPLY to this worker. The same list
     * drives the system-context injection AND the `flowed_into` lineage edges,
     * so lineage cannot record an input the worker never received. */
    contextKeys?: string[] | undefined;
  },
  actorUserId: string,
  /** ADR-0070 — the node's span; every model turn and tool call below hangs
   * from it. Null when tracing is off, and every use of it then no-ops. */
  nodeTrace: TraceContext | null,
): Promise<NodeDispatchOutcome> {
  const graph = run.graph as TaskGraph;
  const state = run.state as RunState;
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return { kind: "unknown_node" };
  if (state.nodeStatuses[nodeId] !== "in_progress") {
    return { kind: "not_in_progress", status: state.nodeStatuses[nodeId] ?? null };
  }

  // §5.1 Team-Lead ceiling for this node: the intersected agent/tool allow-list
  // its lead chain imposes. {null, null} for a node with no lead (flat run) —
  // then the checks below are byte-identical to pre-delegation behaviour.
  const ceiling = computeNodeCeiling(graph, nodeId);

  // §5.1 at execution time: grants may have changed since plan/start — the
  // CURRENT owner is re-checked under the INITIATING user right before the
  // model call, AND against the lead ceiling. A revoked grant OR a ceiling
  // exclusion stops the worker cold.
  const ownerId = state.owners[nodeId] ?? node.ownerAgentId;
  const { decision, unknownAgent } = await evaluateNodeOwner(
    db,
    run.initiatingUserId,
    ownerId,
    node.mode,
    ceiling.agentIds,
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

  // ADR-0050 §2 — SUPPLIED CONTEXT. Each declared key resolves to the CURRENT
  // ACCEPTED revision of that key IN THE RUN'S OWN PROJECT: never a
  // cross-project read (which would be a pillar-4 entitlement hole dressed up
  // as a convenience) and never a stale-or-newer revision (lineage must point
  // at the version that was actually supplied). An unknown key is silently
  // absent rather than an error — a worker asking for context that does not
  // exist yet is ordinary, and failing the dispatch over it would be worse.
  const supplied = await resolveSuppliedContext(db, run.projectId ?? null, args.contextKeys);
  const systemPrompt = composeSystem(nested?.system, supplied.system);

  const [servedAgent] = await db.select().from(agents).where(eq(agents.id, ownerId));

  // PILLAR 7 tool-using worker: resolve the node's DECLARED tool servers into
  // the initiating user's ENTITLED tool defs (model-facing) plus a name→server
  // routing map spanning each declared server's full manifest (governance
  // routing). A node that declares nothing gets no tools and the loop is a
  // single ordinary turn — byte-identical to the pre-loop behaviour.
  const declaredServers = node.toolServers ?? [];
  const declaredNames = node.toolNames;
  const { toolDefs, serverByTool } =
    declaredServers.length > 0
      ? await resolveNodeToolContext(
          db,
          run.initiatingUserId,
          declaredServers,
          declaredNames,
          ceiling.toolRefs,
        )
      : { toolDefs: [], serverByTool: new Map<string, string>() };
  // ADR-0021 worker caps: the default and the hard ceiling are org dials
  // (defaults 6/20 = the previous constants). The zod/kernel wall of 20 stays
  // the absolute maximum — the org ceiling can only narrow below it.
  const orgForNode = await loadOrgSettings(db);
  const maxTurnsDecl = args.maxTurns ?? node.maxTurns;
  const maxTurns = Math.min(
    Math.max(maxTurnsDecl ?? orgForNode.defaultWorkerMaxTurns, 1),
    orgForNode.maxWorkerTurns,
  );

  const firstInput = args.input ?? nodeInstruction(node) ?? node.title;
  const messages: ModelChatMessage[] = [{ role: "user", content: firstInput }];

  // ADR-0050 — SUPPLIED-INPUT LINEAGE, captured from the SAME values that were
  // actually handed to the worker above: `nested.artifacts` is the scope lock
  // in `nested.system`, and `supplied.items` is the context injected alongside
  // it. Deriving the edges from the injected values rather than from the
  // request makes it structurally impossible to record an input the worker
  // never received. Best-effort inside the helper.
  if (run.projectId) {
    await recordRunInputs(db, {
      projectId: run.projectId,
      runId: run.id,
      nodeId,
      ...(nested?.artifacts ? { artifacts: nested.artifacts } : {}),
      contextItems: supplied.items,
    });
  }

  // The bounded governed agentic loop. Each iteration is ONE measured, governed
  // model turn; every tool call inside it is a FULL governed+audited action
  // re-checked against the INITIATING user (§5.1), and the per-run measured cap
  // + first-crossing escalation are evaluated PER TURN (§5.2), so a runaway
  // loop halts and escalates into the one approvals queue exactly like a single
  // dispatch. No path increases privilege entering the loop.
  let runningMeasured = measuredSpent;
  let budgetBreached = false;
  // §5.2 measured per-node ceiling (transitive MIN up the lead chain): enforced
  // on MEASURED dollars exactly like the run cap. null = no per-node cap (flat/
  // uncapped run) → this whole block is inert and byte-identical to before.
  const nodeCeiling = computeNodeBudgetCeiling(graph, nodeId);
  const measuredPerNode: Record<string, number> = { ...(budget?.measuredPerNodeUsd ?? {}) };
  let runningNodeMeasured = measuredPerNode[nodeId] ?? 0;
  let nodeBudgetBreached = false;
  let turnCount = 0;
  let toolCallCount = 0;
  let toolApprovalPending = false;
  let totalCostUsd: number | null = 0;
  const totalUsage = { inputTokens: 0, outputTokens: 0 };
  let last: Extract<Awaited<ReturnType<typeof executeGovernedDispatch>>, { ok: true }> | null = null;

  for (let turn = 0; turn < maxTurns; turn++) {
    // §5.2 PER-TURN measured pre-gate: a loop already at/over the cap stops
    // before spending more. On turn 0 with no prior success this surfaces as
    // budget_blocked_measured (identical to a blocked single dispatch).
    if (budget && budget.capUsd !== null && !budget.overageApproved && runningMeasured >= budget.capUsd) {
      if (turn === 0) {
        return { kind: "budget_blocked_measured", measuredSpentUsd: runningMeasured, capUsd: budget.capUsd };
      }
      break;
    }
    // §5.2 PER-TURN measured NODE pre-gate: a node already at/over its own
    // transitive ceiling stops before spending more. On turn 0 (a re-dispatch of
    // an already-breached node) this surfaces as node_budget_blocked_measured;
    // mid-loop it just halts the loop with the escalation already queued.
    if (
      budget &&
      nodeCeiling !== null &&
      !budget.overageApproved &&
      runningNodeMeasured >= nodeCeiling
    ) {
      if (turn === 0) {
        return {
          kind: "node_budget_blocked_measured",
          nodeId,
          measuredNodeUsd: runningNodeMeasured,
          nodeCapUsd: nodeCeiling,
        };
      }
      break;
    }

    const outcome = await executeGovernedDispatch(db, dataKey, {
      userId: run.initiatingUserId,
      served: servedAgent,
      requestedAgentId: node.ownerAgentId,
      baseline: null,
      input: firstInput,
      messages,
      // ADR-0070: this turn's `llm` span is a CHILD of the node span.
      trace: nodeTrace,
      traceSpanName: `turn ${turn + 1}: ${servedAgent?.name ?? node.ownerAgentId}`,
      ...(systemPrompt !== undefined ? { system: systemPrompt } : {}),
      ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
      maxTokens: args.maxTokens,
      ...(args.onDelta ? { onText: args.onDelta } : {}),
      projectId: run.projectId ?? null,
      detail: {
        runId: run.id,
        nodeId,
        mode: node.mode,
        turn,
        ...(nested ? { contextArtifacts: nested.artifacts } : {}),
      },
    });

    if (!outcome.ok) {
      await db.insert(auditLog).values({
        userId: actorUserId,
        objectType: "run",
        objectId: run.id,
        detail: { nodeId, ownerAgentId: ownerId, phase: "dispatch", turn, error: outcome.error },
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

    turnCount++;
    last = outcome;
    totalUsage.inputTokens += outcome.result.usage.inputTokens;
    totalUsage.outputTokens += outcome.result.usage.outputTokens;
    if (outcome.result.costUsd == null) totalCostUsd = null;
    else if (totalCostUsd !== null) totalCostUsd = Number((totalCostUsd + outcome.result.costUsd).toFixed(6));

    // §5.2: measured spend accumulates on the run AFTER every turn. The first
    // cap crossing is allowed (measured cost is only known post-call) but
    // escalates immediately into the one approvals queue; the per-turn
    // pre-gate above then blocks the next turn. Never silently exceeded (§7).
    if (budget) {
      runningMeasured = Number((runningMeasured + (outcome.result.costUsd ?? 0)).toFixed(6));
      // §5.2 accumulate this node's OWN measured spend alongside the run total.
      runningNodeMeasured = Number((runningNodeMeasured + (outcome.result.costUsd ?? 0)).toFixed(6));
      measuredPerNode[nodeId] = runningNodeMeasured;
      await db
        .update(orchestrationRuns)
        .set({ budget: { ...budget, measuredSpentUsd: runningMeasured, measuredPerNodeUsd: measuredPerNode } })
        .where(eq(orchestrationRuns.id, run.id));
      // §5.2 first-crossing escalate on the NODE's transitive ceiling — the same
      // pattern as the run cap, into the SAME approvals queue, with a DISTINCT
      // sentinel and ruleId so it is never confused with a run-cap breach.
      if (
        nodeCeiling !== null &&
        !budget.overageApproved &&
        runningNodeMeasured > nodeCeiling &&
        !nodeBudgetBreached
      ) {
        nodeBudgetBreached = true;
        const [pendingNode] = await db
          .select({ id: approvals.id })
          .from(approvals)
          .where(
            and(
              eq(approvals.runId, run.id),
              eq(approvals.stageId, `__nodebudget_measured__:${nodeId}`),
              eq(approvals.status, "pending"),
            ),
          )
          .limit(1);
        if (!pendingNode) {
          await db.insert(approvals).values({
            userId: run.initiatingUserId,
            objectType: "run",
            runId: run.id,
            stageId: `__nodebudget_measured__:${nodeId}`,
            approverUserId: graph.escalationApproverUserId,
          });
        }
        await db.insert(auditLog).values({
          userId: actorUserId,
          objectType: "run",
          objectId: run.id,
          detail: {
            phase: "node-budget-breach-measured",
            nodeId,
            turn,
            measuredNodeUsd: runningNodeMeasured,
            nodeCapUsd: nodeCeiling,
          },
          effect: "require_approval",
          ruleId: "node-budget-cap-measured",
          ruleChain: [],
          reason: `node '${nodeId}' measured spend $${runningNodeMeasured} exceeds its delegated per-node cap of $${nodeCeiling}; approval required to continue`,
        });
      }
      if (
        budget.capUsd !== null &&
        !budget.overageApproved &&
        runningMeasured > budget.capUsd &&
        !budgetBreached
      ) {
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
            turn,
            measuredSpentUsd: runningMeasured,
            capUsd: budget.capUsd,
          },
          effect: "require_approval",
          ruleId: "run-budget-cap",
          ruleChain: [],
          reason: `measured spend $${runningMeasured} exceeds the $${budget.capUsd} cap after node '${nodeId}' dispatched; approval required to continue`,
        });
      }
    }

    // ADR-0070: every tool call this turn makes hangs from THIS turn's span, so
    // the tree answers "which model turn asked for this tool" rather than
    // merely "this run touched this tool at some point".
    const turnTrace = childContext(nodeTrace, outcome.trace?.spanId ?? null);

    const toolCalls = outcome.result.stopReason === "tool_use" ? (outcome.result.toolCalls ?? []) : [];
    if (toolCalls.length === 0) break; // a final text answer — the loop is done

    // Append the assistant tool_use turn, then execute each call AS THE
    // INITIATING USER and append the tool_result turn so the model can react.
    const assistantBlocks: ModelContentBlock[] = [];
    if (outcome.result.outputText) {
      assistantBlocks.push({ type: "text", text: outcome.result.outputText });
    }
    for (const tc of toolCalls) {
      assistantBlocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
    }
    messages.push({ role: "assistant", content: assistantBlocks });

    const resultBlocks: ModelContentBlock[] = [];
    let breakForApproval = false;
    for (const tc of toolCalls) {
      toolCallCount++;
      const serverId = serverByTool.get(tc.name);
      let block: ModelContentBlock;
      let traceStatus: string;
      if (!serverId) {
        // the model asked for a tool no declared server manifests — no
        // governance target, so report it back as an error and move on
        block = {
          type: "tool_result",
          toolUseId: tc.id,
          content: `tool '${tc.name}' is not available to this node`,
          isError: true,
        };
        traceStatus = "unavailable";
      } else {
        const toolOut = await executeGovernedToolCall(db, dataKey, {
          userId: run.initiatingUserId,
          serverId,
          toolName: tc.name,
          arguments: (tc.arguments ?? {}) as Record<string, unknown>,
          // §5.1 hard enforcement: even if a tool leaked into context, the lead
          // ceiling denies the call with ruleId `lead-ceiling`.
          ceilingTools: ceiling.toolRefs,
          // ADR-0019 pillar-5: a worker's tool calls bill to the run's project,
          // on the same ledger as its model dispatches — the run's projectId was
          // already attribution-checked when the run was created, so no second
          // membership check is needed here.
          projectId: run.projectId ?? null,
          trace: turnTrace,
          toolCallId: tc.id,
        });
        switch (toolOut.kind) {
          case "allowed":
            block = { type: "tool_result", toolUseId: tc.id, content: toolResultText(toolOut.content) };
            traceStatus = "allowed";
            // ADR-0050: a governed tool RESULT flowing back INTO the worker is
            // a supplied input, captured at the same point the call was
            // governed and metered. Metadata only — the result content is not
            // stored (GOVERNANCE §8.4).
            if (run.projectId) {
              await recordToolResultInput(db, {
                projectId: run.projectId,
                runId: run.id,
                nodeId,
                serverId,
                toolName: tc.name,
                callId: tc.id,
              });
            }
            break;
          case "denied":
            block = {
              type: "tool_result",
              toolUseId: tc.id,
              content: `blocked by governance: ${toolOut.decision.reason}`,
              isError: true,
            };
            traceStatus = "denied";
            break;
          // ADR-0019 §8.4: the run's project is block-mode and the tool
          // ARGUMENTS carried PII — denied pre-call, nothing billed. Reported
          // back to the worker by CATEGORY, never by content.
          case "pii_blocked":
            block = {
              type: "tool_result",
              toolUseId: tc.id,
              content: `blocked by governance: ${toolOut.reason}`,
              isError: true,
            };
            traceStatus = "pii_blocked";
            break;
          // ADR-0042: a guardrail detector refused the tool ARGUMENTS. The
          // worker is told by CATEGORY, never by content, so a refusal cannot
          // itself become a channel for the thing that was refused.
          case "guardrail_blocked":
            block = {
              type: "tool_result",
              toolUseId: tc.id,
              content: `blocked by governance: ${toolOut.reason}`,
              isError: true,
            };
            traceStatus = "guardrail_blocked";
            break;
          // ADR-0103: the run's PROJECT budget (pillar 5) is exhausted, so a
          // paid tool call is refused pre-call — nothing executed, nothing
          // billed. Surfaced exactly like a governed denial so a delegated
          // worker cannot spend what a direct caller cannot. Distinct from the
          // run/node budget gated by `gateNodeStartBudget` above: that is the
          // run's own ledger, this is the project's.
          case "budget_blocked":
            block = {
              type: "tool_result",
              toolUseId: tc.id,
              content:
                `blocked by governance: ${toolOut.error}` +
                (toolOut.detail ? ` — ${toolOut.detail}` : ""),
              isError: true,
            };
            traceStatus = "budget_blocked";
            break;
          case "approval_required":
            block = {
              type: "tool_result",
              toolUseId: tc.id,
              content: `approval required: '${toolOut.approvalId}' is pending sign-off — this worker is paused until it is decided`,
              isError: true,
            };
            traceStatus = "approval_required";
            breakForApproval = true;
            toolApprovalPending = true;
            break;
          case "approval_consumed_race":
            block = {
              type: "tool_result",
              toolUseId: tc.id,
              content: `approval '${toolOut.approvalId}' was already consumed — retry to request a new one`,
              isError: true,
            };
            traceStatus = "approval_consumed_race";
            break;
          case "unknown_tool":
            block = {
              type: "tool_result",
              toolUseId: tc.id,
              content: `unknown tool '${tc.name}'`,
              isError: true,
            };
            traceStatus = "unknown_tool";
            break;
        }
      }
      resultBlocks.push(block);
      // Append-only trace of every tool call (no migration — rides the events
      // jsonb). The governed decision's own audit row is written by
      // executeGovernedToolCall; this is the run-side record of the loop.
      await db.insert(orchestrationRunEvents).values({
        runId: run.id,
        event: {
          kind: "node_tool_call",
          nodeId,
          turn,
          toolName: tc.name,
          serverId: serverId ?? null,
          status: traceStatus,
        },
        actorUserId,
      });
    }
    messages.push({ role: "user", content: resultBlocks });

    // §5.1/§3: an approval-required tool halts the loop with the approval in
    // the one queue — the human decides, then re-dispatches the node. Never a
    // hang.
    if (breakForApproval) break;
  }

  // last is non-null: turn 0 always dispatches (the budget pre-gate returns
  // before the loop body when it would block). Defensive fallback otherwise.
  if (!last) {
    return { kind: "budget_blocked_measured", measuredSpentUsd: runningMeasured, capUsd: budget?.capUsd ?? 0 };
  }

  // Append-only history: the node's whole loop is one node_dispatched record —
  // final text, summed usage/cost, and the loop trace counts.
  await db.insert(orchestrationRunEvents).values({
    runId: run.id,
    event: {
      kind: "node_dispatched",
      nodeId,
      agentId: last.result.servedAgentId,
      model: last.result.model,
      stopReason: last.result.stopReason,
      refusal: last.result.refusal,
      usage: totalUsage,
      costUsd: totalCostUsd,
      turns: turnCount,
      toolCalls: toolCallCount,
      ...(toolApprovalPending ? { toolApprovalPending: true } : {}),
      // §6 traceability: exactly which signed-off artifact versions framed
      // this execution
      ...(nested ? { contextArtifacts: nested.artifacts } : {}),
      // ADR-0021: the stored-output ceiling is an org dial (default 20_000)
      outputText: last.result.outputText.slice(0, orgForNode.nodeOutputMaxChars),
    },
    actorUserId,
  });
  // ADR-0050: the `run --produced--> output` edge, written from the same place
  // the run-side history record is. METADATA ONLY: the node records that this
  // dispatch produced an output and how big it was, never the text (§8.4).
  if (run.projectId) {
    await recordRunOutput(db, {
      projectId: run.projectId,
      runId: run.id,
      nodeId,
      stopReason: last.result.stopReason,
      tokens: totalUsage.outputTokens,
    });
  }
  await db.insert(auditLog).values({
    userId: actorUserId,
    objectType: "run",
    objectId: run.id,
    detail: {
      nodeId,
      agentId: last.result.servedAgentId,
      model: last.result.model,
      stopReason: last.result.stopReason,
      refusal: last.result.refusal,
      costUsd: totalCostUsd,
      turns: turnCount,
      toolCalls: toolCallCount,
      phase: "dispatch",
    },
    effect: "allow",
    ruleId: "run-node-dispatched",
    ruleChain: [],
    reason: `node '${nodeId}' executed by its assigned owner under the initiating user's entitlements (${turnCount} turn(s), ${toolCallCount} tool call(s))`,
  });

  return {
    kind: "ok",
    result: {
      servedAgentId: last.result.servedAgentId,
      model: last.result.model,
      outputText: last.result.outputText,
      stopReason: last.result.stopReason,
      refusal: last.result.refusal,
      usage: totalUsage,
      costUsd: totalCostUsd,
      measuredCostSavedUsd: last.result.measuredCostSavedUsd,
      credentialSource: last.result.credentialSource,
      turns: turnCount,
      toolCalls: toolCallCount,
      ...(toolApprovalPending ? { toolApprovalPending: true } : {}),
    },
    measuredSpentUsd: runningMeasured,
    budgetBreached,
    nodeBudgetBreached,
  };
}

/** The dispatch route's one outcome→HTTP mapping, shared verbatim by the
 * JSON, suppressed-stream and SSE deliveries so the three can never drift:
 * SSE sends `body` inside a `result`/`error` event; the others send it as the
 * response with `status`. */
function nodeDispatchHttp(out: NodeDispatchOutcome): {
  status: number;
  body: Record<string, unknown>;
} {
  switch (out.kind) {
    case "unknown_node":
      return { status: 400, body: { error: "unknown_node" } };
    case "unknown_agent":
      return { status: 422, body: { error: "unknown_agent" } };
    case "not_in_progress":
      return { status: 409, body: { error: "node_not_in_progress", status: out.status } };
    case "entitlement_denied":
      return { status: 403, body: { error: "entitlement_exceeded", decision: out.decision } };
    case "budget_blocked_measured":
      return {
        status: 409,
        body: {
          error: "budget_exceeded_measured",
          measuredSpentUsd: out.measuredSpentUsd,
          capUsd: out.capUsd,
        },
      };
    case "node_budget_blocked_measured":
      return {
        status: 409,
        body: {
          error: "node_budget_exceeded_measured",
          nodeId: out.nodeId,
          measuredNodeUsd: out.measuredNodeUsd,
          nodeCapUsd: out.nodeCapUsd,
        },
      };
    case "dispatch_failed":
      return {
        status: out.status,
        body: { error: out.error, ...(out.detail ? { detail: out.detail } : {}) },
      };
    case "ok":
      return {
        status: 200,
        body: {
          dispatch: out.result,
          measuredSpentUsd: out.measuredSpentUsd,
          ...(out.budgetBreached ? { budgetBreached: true } : {}),
          ...(out.nodeBudgetBreached ? { nodeBudgetBreached: true } : {}),
        },
      };
  }
}

// The worker-turn default (6) and hard ceiling (20) moved to org_settings
// (ADR-0021: defaultWorkerMaxTurns / maxWorkerTurns) — the previous constants
// live on as the migration's column defaults.

/** Flatten an MCP callTool result to text for a tool_result block — join text
 * content parts, else stringify. Keeps the model's view of the tool output
 * faithful without leaking transport structure. */
function toolResultText(content: unknown): string {
  const c = content as { content?: Array<{ type?: string; text?: string }> } | null;
  if (c && Array.isArray(c.content)) {
    const text = c.content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join(" ");
    if (text) return text;
  }
  return JSON.stringify(content ?? null);
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
  /** §5.1 Team-Lead ceiling: the agent ids this node's lead chain permits.
   * null = no lead constraint. The GRANTS subject stays `userId` (the
   * initiating user) — the ceiling is a SEPARATE intersecting constraint that
   * can only narrow, never a substitute for the user's own grant load. */
  ceilingAgentIds: readonly string[] | null = null,
): Promise<{ decision: AgentDecision | null; unknownAgent: boolean }> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) return { decision: null, unknownAgent: true };
  const [grants, roleAgentGrantsForUser, agentRevocationsForUser, [policy]] = await Promise.all([
    db.select().from(agentGrants).where(eq(agentGrants.userId, userId)),
    // §5 role-bundled grants (ADR-0014) — a worker node running under the
    // initiating user's entitlements must see their role-derived agent grants.
    loadRoleAgentGrants(db, userId),
    // ADR-0019 — and their per-user revocations, or "inherit never escalate"
    // would leak: a worker could run an agent the initiating user is denied.
    loadAgentRevocations(db, userId),
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
      roleAgentGrants: roleAgentGrantsForUser,
      agentRevocations: agentRevocationsForUser,
      ceilingTier,
      ceilingAgentIds,
    }),
    unknownAgent: false,
  };
}

/** Transactionally apply one run event: kernel transition under FOR UPDATE,
 * append-only event history, one audit trail (§5.3), §3 escalations
 * materialized into the ONE approvals queue, and — the other side of the same
 * coin — approvals mooted by the event (a reassigned/retried node, a run
 * turning terminal) superseded in the SAME transaction, so the queue never
 * shows a decidable gate for work that has moved on. Accepts an open
 * transaction (decide-endpoint atomicity) or the Db. */
async function applyRunEventTx(
  dbx: DbOrTx,
  runId: string,
  event: RunEvent,
  actorUserId: string,
): Promise<{ run: RunRow; effects: RunEffect[] }> {
  return inTransaction(dbx, async (tx) => {
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
    // A reassigned or retried node moots its open escalation AND its
    // node-scoped budget gate: the situation the approver was asked about no
    // longer exists. Superseded, never silently left decidable.
    if (event.kind === "reassign_node" || event.kind === "retry_node") {
      await tx
        .update(approvals)
        .set({ status: "superseded" })
        .where(
          and(
            eq(approvals.runId, runId),
            eq(approvals.status, "pending"),
            inArray(approvals.stageId, [event.nodeId, `__budget__:${event.nodeId}`]),
          ),
        );
    }
    // A terminal run moots EVERY approval still pending against it.
    if (state.status === "completed" || state.status === "aborted") {
      await tx
        .update(approvals)
        .set({ status: "superseded" })
        .where(and(eq(approvals.runId, runId), eq(approvals.status, "pending")));
    }
    return { run: updated!, effects };
  });
}

/** §8 nesting: a terminal nested run advances (or fails) its parent
 * workflow's build stage — as a post-commit step, since it drives its own
 * transactions and git executions. transitionRun throws on already-terminal
 * runs, so a terminal status here is always a fresh transition. */
function nestedCompletionPostCommit(
  run: RunRow,
  actorUserId: string,
  dataKey?: string,
): ApprovalPostCommit | null {
  if (run.workflowInstanceId && (run.status === "completed" || run.status === "aborted")) {
    return (db) => handleNestedRunCompletion(db, dataKey, run, actorUserId);
  }
  return null;
}

/** The single funnel for ALL standalone run-event applications: transition +
 * bookkeeping in one transaction, then the §8 parent-workflow notification. */
async function applyRunEvent(
  db: Db,
  runId: string,
  event: RunEvent,
  actorUserId: string,
  dataKey?: string,
): Promise<{ run: RunRow; effects: RunEffect[] }> {
  const applied = await applyRunEventTx(db, runId, event, actorUserId);
  const postCommit = nestedCompletionPostCommit(applied.run, actorUserId, dataKey);
  if (postCommit) await postCommit(db);
  // ADR-0070 — a run's trace and its root span close when the RUN turns
  // terminal, not when one of its dispatches returns. A run that is still going
  // therefore reads as `running` rather than as `ok` after its first node, and
  // a `completed` run's trace duration is the run's elapsed time.
  await closeRunTrace(db, applied.run);
  return applied;
}

/** Close the run's trace + root `run` span on a terminal transition. Silent and
 * best-effort (recorder rule 2): observability never fails the run it observes. */
export async function closeRunTrace(db: Db, run: RunRow): Promise<void> {
  if (run.status !== "completed" && run.status !== "aborted") return;
  const status: TraceStatus = run.status === "completed" ? "ok" : "error";
  try {
    const [t] = await db
      .select({ id: traces.id })
      .from(traces)
      .where(and(eq(traces.kind, "run"), eq(traces.rootRefId, run.id)))
      .orderBy(desc(traces.startedAt))
      .limit(1);
    if (!t) return;
    const [rootSpan] = await db
      .select({ id: traceSpans.id })
      .from(traceSpans)
      .where(and(eq(traceSpans.traceId, t.id), eq(traceSpans.kind, "run")))
      .limit(1);
    await closeSpan(
      db,
      rootSpan?.id ?? null,
      status,
      run.status === "aborted" ? "run aborted" : null,
    );
    await finishTrace(db, { traceId: t.id, parentSpanId: null, sessionId: run.id, policy: { enabled: true, captureContent: false, previewMaxChars: 0 } }, status);
  } catch {
    /* recorder rule 2 */
  }
}

/** Decide-endpoint hook (§3): approving an escalated node re-opens it for
 * another attempt; denying it aborts the whole run. Runs on the decide
 * endpoint's OPEN transaction so a kernel refusal (RunStateError → 409) rolls
 * the decision itself back; returns the post-commit step (§8 parent-workflow
 * notification) for the caller to run once the decision is durable. */
export async function applyRunApprovalDecision(
  dbx: DbOrTx,
  approvalRow: { runId: string | null; stageId: string | null },
  decision: "approved" | "denied",
  deciderUserId: string,
  dataKey?: string,
): Promise<ApprovalPostCommit | null> {
  if (!approvalRow.runId || !approvalRow.stageId) return null;
  const runId = approvalRow.runId;
  // §5.2 budget approvals: approving lifts cap enforcement for this run
  // (the overage is now sanctioned); denying aborts it. Never a silent path.
  // Covers both the run-cap `__budget__[:node]` and the measured per-node
  // ceiling `__nodebudget_measured__:<node>` escalations — both sanction the
  // overage for this run so the pre-gates (which check overageApproved) let the
  // node proceed on a re-dispatch.
  if (
    approvalRow.stageId.startsWith("__budget__") ||
    approvalRow.stageId.startsWith("__nodebudget_measured__")
  ) {
    if (decision === "approved") {
      const [run] = await dbx
        .select()
        .from(orchestrationRuns)
        .where(eq(orchestrationRuns.id, runId));
      if (!run) return null;
      const budget = (run.budget ?? {}) as Record<string, unknown>;
      await dbx
        .update(orchestrationRuns)
        .set({ budget: { ...budget, overageApproved: true } })
        .where(eq(orchestrationRuns.id, runId));
      await dbx.insert(auditLog).values({
        userId: deciderUserId,
        objectType: "run",
        objectId: runId,
        detail: { phase: "budget-decision", stageId: approvalRow.stageId },
        effect: "allow",
        ruleId: "run-budget-overage-approved",
        ruleChain: [],
        reason: "budget overage approved by the named approver; cap enforcement lifted for this run",
      });
      return null;
    }
    const aborted = await applyRunEventTx(dbx, runId, { kind: "abort" }, deciderUserId);
    return nestedCompletionPostCommit(aborted.run, deciderUserId, dataKey);
  }
  const event: RunEvent =
    decision === "approved"
      ? { kind: "retry_node", nodeId: approvalRow.stageId }
      : { kind: "abort" };
  const applied = await applyRunEventTx(dbx, runId, event, deciderUserId);
  return nestedCompletionPostCommit(applied.run, deciderUserId, dataKey);
}

export type PlanRunResult =
  // 409 (ADR-0079): the named workflow instance is at a plan-only stage
  | { ok: false; status: 400 | 403 | 409 | 422; body: Record<string, unknown> }
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
 * workflow can never launch a run its human couldn't. `dataKey` lets the
 * budget re-plan check which providers hold a decryptable credential, so a
 * substitution never lands a node on an agent that cannot dispatch. */
export async function planRun(
  db: Db,
  userId: string,
  graphRaw: unknown,
  workflowInstanceId: string | null,
  projectId: string | null = null,
  dataKey?: string,
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
  attachInstructions(graph, graphRaw, (await loadOrgSettings(db)).sharedContextMaxChars);

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
  // PILLAR 2 §2 stage 2 (ADR-0079): a run NAMING a workflow instance is
  // attributed to it, and a run is execution. The same gate as the invoke path,
  // applied per node because a graph declares one mode per node: while the
  // instance rests at a planning stage, any node with a mutating mode refuses
  // the whole plan (planning half a graph would be worse than refusing it).
  // The nested build-stage call passes the instance's OWN id and initiator, and
  // a build stage is never a planning stage, so that path is untouched — and
  // the instance link, previously unvalidated on POST /v1/runs, is now checked
  // like `projectId` is instead of failing later on a foreign key.
  if (workflowInstanceId) {
    const mutating = graph.nodes.filter((n) => !isPlanSafeMode(n.mode));
    const gate = await guardInstanceAttributedCall(db, {
      instanceId: workflowInstanceId,
      userId,
      isAdmin: false,
      mode: mutating[0]?.mode ?? "plan",
      detail: { phase: "run-plan", run: graph.run, nodes: graph.nodes.map((n) => n.id) },
      what:
        mutating.length > 0
          ? `run '${graph.run}' node${mutating.length > 1 ? "s" : ""} ` +
            mutating.map((n) => `'${n.id}' (mode '${n.mode}')`).join(", ")
          : undefined,
    });
    if (!gate.ok) {
      return { ok: false, status: gate.status, body: { error: gate.error, detail: gate.detail } };
    }
  }

  const [grants, roleAgentGrantsForUser, agentRevocationsForUser, [policy], agentRows] =
    await Promise.all([
      db.select().from(agentGrants).where(eq(agentGrants.userId, userId)),
      // §5 role-bundled grants (ADR-0014) — the plan-time per-node envelope check
      // must honour role-derived agent grants, exactly as dispatch/reassign does.
      loadRoleAgentGrants(db, userId),
      // ADR-0019 — and per-user revocations, so a revoked agent fails the
      // envelope check at PLAN time rather than surfacing only at dispatch.
      loadAgentRevocations(db, userId),
      db.select().from(userAgentPolicies).where(eq(userAgentPolicies.userId, userId)),
      db.select().from(agents),
    ]);
    const agentById = new Map(agentRows.map((a) => [a.id, a]));
    let ceilingTier: number | null = null;
    if (policy?.ceilingAgentId) {
      ceilingTier = agentById.get(policy.ceilingAgentId)?.tier ?? null;
    }
    const evalOwner = (
      agentId: string,
      mode: string,
      ceilingAgentIds: readonly string[] | null = null,
    ): AgentDecision | null => {
      const agent = agentById.get(agentId);
      if (!agent) return null;
      return evaluateAgent({
        userId,
        agent: { id: agent.id, tier: agent.tier, enabled: agent.enabled, modes: agent.modes ?? null },
        mode,
        agentGrants: grants,
        roleAgentGrants: roleAgentGrantsForUser,
        agentRevocations: agentRevocationsForUser,
        ceilingTier,
        ceilingAgentIds,
      });
    };

    // §5.1 per-node envelope check under the initiating user's entitlements AND
    // that node's Team-Lead ceiling (the intersected agent allow-list of its
    // lead chain). A node whose owner the lead forbids is denied at plan time
    // with ruleId `agent-lead-ceiling`, exactly as at dispatch/reassign.
    const envelope: Array<{ nodeId: string; decision: AgentDecision }> = [];
    for (const node of graph.nodes) {
      const decision = evalOwner(
        node.ownerAgentId,
        node.mode,
        computeNodeCeiling(graph, node.id).agentIds,
      );
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
      routing: ReturnType<typeof routeModel> & { skippedCandidates?: SkippedCandidate[] };
    }> = [];
    const replanSkipped: Array<{ nodeId: string; skipped: SkippedCandidate[] }> = [];
    if (capUsd !== null && cost.totalUsd !== null && cost.totalUsd > capUsd && breachAction === "replan") {
      // §5.2 auto re-plan: substitute cheaper owners per node via the same
      // governed routing pillar 6 uses — candidates are entitlement-filtered,
      // so a re-plan can never escalate (§5.1). Same graph shape, cheaper team.
      // Candidates must also be DISPATCHABLE (the same filter the invoke path
      // applies): a substitution onto a provider with no stored credential
      // would turn the node's later dispatch into a `no_model_credential`
      // failure. The node's CURRENT owner is never filtered out — routeModel
      // fails safe without its baseline, and an undispatchable owner the graph
      // author chose must fail explicitly at dispatch rather than be quietly
      // substituted away.
      const configured = await configuredProviders(db, dataKey, userId);
      const skipReason = (
        a: (typeof agentRows)[number],
        ownerId: string,
      ): SkippedCandidate["reason"] | null => {
        if (a.id === ownerId) return null;
        if (!a.model) return "no_model_id";
        if (!isModelProviderKind(a.provider)) return "unknown_provider";
        if (!configured.has(agentProviderToken(a))) return "no_model_credential";
        return null;
      };
      for (const node of graph.nodes) {
        const ownerId = state.owners[node.id]!;
        // §5.1: a budget re-plan must NOT move a node onto an agent its lead
        // ceiling forbids — the candidate pool is entitlement-filtered AND
        // ceiling-filtered, so a cheaper-but-forbidden agent is never chosen.
        const nodeCeiling = computeNodeCeiling(graph, node.id).agentIds;
        const entitled = agentRows
          .filter((a) => a.enabled)
          .filter((a) => evalOwner(a.id, node.mode, nodeCeiling)?.effect === "allow");
        const skippedCandidates: SkippedCandidate[] = entitled.flatMap((a) => {
          const reason = skipReason(a, ownerId);
          return reason ? [{ agentId: a.id, name: a.name, reason }] : [];
        });
        const skippedIds = new Set(skippedCandidates.map((s) => s.agentId));
        const candidates = entitled
          .filter((a) => !skippedIds.has(a.id))
          .map((a) => ({
            id: a.id,
            tier: a.tier,
            costPerMTokIn: a.costPerMTokIn ?? null,
            costPerMTokOut: a.costPerMTokOut ?? null,
          }));
        let routing: ReturnType<typeof routeModel> & { skippedCandidates?: SkippedCandidate[] } =
          routeModel({
            requestedAgentId: ownerId,
            candidates,
            routingMode: policy?.routingMode ?? "automatic",
            complexity: classifyComplexity(node.title),
            costSensitivity: "cost-sensitive",
            ceilingTier,
            estimate: tokensFor(node),
          });
        // Purely additive to the trace, exactly like the invoke path: the
        // agents routing never got to weigh are listed with the reason each
        // was withheld.
        if (skippedCandidates.length > 0) {
          routing = { ...routing, skippedCandidates };
          replanSkipped.push({ nodeId: node.id, skipped: skippedCandidates });
        }
        if (routing.effect === "routed") {
          substitutions.push({ node, from: ownerId, routing });
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
        detail: {
          nodeId: sub.node.id,
          phase: "budget-replan",
          ...(sub.routing.skippedCandidates
            ? { routingSkippedCandidates: sub.routing.skippedCandidates }
            : {}),
        },
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
      detail: {
        runName: graph.run,
        nodes: graph.nodes.length,
        phase: "plan",
        replanned,
        ...(replanSkipped.length > 0 ? { replanSkippedCandidates: replanSkipped } : {}),
      },
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
  async function loadRunFor(
    req: { authCtx: { userId: string | null; isAdmin: boolean } },
    runId: string,
    access?: { allowPendingApprover?: boolean },
  ) {
    const [run] = await db.select().from(orchestrationRuns).where(eq(orchestrationRuns.id, runId));
    if (!run) return { error: 404 as const };
    if (!req.authCtx.isAdmin && req.authCtx.userId !== run.initiatingUserId) {
      // Read-only widening (mirrors the workflow-instance read): the named
      // approver of a PENDING approval on this run may view what they are
      // deciding. Only the GET route passes the flag; every driving/dispatch
      // route keeps the admin/initiator gate.
      if (access?.allowPendingApprover && req.authCtx.userId) {
        const [naming] = await db
          .select({ id: approvals.id })
          .from(approvals)
          .where(
            and(
              eq(approvals.runId, runId),
              eq(approvals.approverUserId, req.authCtx.userId),
              eq(approvals.status, "pending"),
            ),
          )
          .limit(1);
        if (naming) return { run };
      }
      return { error: 404 as const }; // existence is not disclosed to non-participants
    }
    return { run };
  }

  app.post("/v1/runs", async (req, reply) => {
    const body = createRunSchema.parse(req.body);
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_initiate" });
    const planned = await planRun(
      db,
      userId,
      body.graph,
      body.workflowInstanceId ?? null,
      body.projectId ?? null,
      opts.dataKey,
    );
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
      // §5.1: a reassignment must also honour this node's lead ceiling — it can
      // never move the node onto an agent the lead forbids, even if the
      // initiating user is granted it.
      const { decision, unknownAgent } = await evaluateNodeOwner(
        db,
        loaded.run.initiatingUserId,
        body.ownerAgentId,
        node.mode,
        computeNodeCeiling(graph, node.id).agentIds,
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
  // STREAMING (stream: true): the SAME governed dispatch, delivered as SSE
  // with the invoke path's event framing — `delta {text}` per worker token,
  // then ONE `result` event carrying exactly the JSON payload, or ONE `error`
  // event when a mid-loop turn fails after deltas already left. Every gate
  // resolves before the stream opens (lazy open on the first delta), so
  // entitlement/budget/config failures stay real HTTP errors; a block-mode
  // PII project never streams — the dispatch runs buffered and returns JSON
  // with `streamingSuppressed: true` (disclosed, never silent), or 400 under
  // ADR-0021 'reject'. Without stream:true this route is byte-identical to
  // its pre-streaming behaviour.
  app.post("/v1/runs/:runId/nodes/:nodeId/dispatch", async (req, reply) => {
    const { runId, nodeId } = z
      .object({ runId: z.string().uuid(), nodeId: z.string().min(1).max(64) })
      .parse(req.params);
    const body = dispatchNodeSchema.parse(req.body ?? {});
    const loaded = await loadRunFor(req, runId);
    if (loaded.error) return reply.status(loaded.error).send({ error: "unavailable" });
    if (!req.authCtx.userId) return reply.status(403).send({ error: "bootstrap_cannot_drive" });

    const streamReq = await resolveStreamRequest(db, req.body, loaded.run.projectId ?? null);
    if (streamReq.mode === "rejected") return reply.status(streamReq.status).send(streamReq.body);

    if (streamReq.mode === "stream") {
      const sse = sseChannel(reply);
      const out = await dispatchRunNode(
        db,
        opts.dataKey,
        loaded.run,
        nodeId,
        { ...body, onDelta: (text) => sse.send("delta", { text }) },
        req.authCtx.userId,
      );
      const r = nodeDispatchHttp(out);
      if (out.kind !== "ok") {
        // no delta left yet → the failure is a REAL HTTP error, exactly the
        // non-stream response; after first delta the wire is committed, so
        // the same body rides an `error` event instead.
        if (!sse.opened) return reply.status(r.status).send(r.body);
        sse.send("error", r.body);
        sse.end();
        return reply;
      }
      sse.send("result", r.body);
      sse.end();
      return reply;
    }

    const out = await dispatchRunNode(db, opts.dataKey, loaded.run, nodeId, body, req.authCtx.userId);
    const r = nodeDispatchHttp(out);
    if (streamReq.mode === "suppressed") {
      // ADR-0019 §8.4 disclosure — recorded, never silent.
      await db.insert(auditLog).values({
        userId: req.authCtx.userId,
        objectType: "run",
        objectId: runId,
        detail: { nodeId, phase: "dispatch", streamingSuppressed: true },
        effect: "allow",
        ruleId: "stream-suppressed-block-project",
        ruleChain: [],
        reason:
          "stream requested on a block-mode PII project — the governed dispatch ran fully buffered so the output PII check completes before any byte leaves",
      });
      return reply.status(r.status).send({ ...r.body, streamingSuppressed: true });
    }
    return reply.status(r.status).send(r.body);
  });

  // AUTO-ADVANCE: a self-driving pass over the run — same gates, zero new
  // authority. One synchronous call (no scheduler/queue infrastructure, same
  // bias as ADR-0010) starts the run if needed, then drives the FULL ready
  // set as a wave (§4 parallelism made real): every wave node is started —
  // each through its own budget gates — and dispatched before any of them is
  // submitted, so independent branches are genuinely concurrent in the run's
  // recorded state rather than a one-at-a-time march; dependents become the
  // next wave. Review stays a human gate by DEFAULT: nodes land in_review
  // and dependents wait; only an explicit acceptReviews=true also accepts
  // each submission. Node-level problems (entitlement, config, refusal) mark
  // that node failed and the wave continues on independent branches;
  // run-level problems (budget) stop the whole pass — with everything
  // already dispatched still submitted, so nothing strands in_progress.
  // Every step is the same audited event/dispatch machinery the manual
  // endpoints use.
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

    // MULTIPLEXED STREAMING (stream: true) — one SSE stream for the WHOLE
    // pass, with per-node ENVELOPE events so a client can render N nodes
    // progressing at once (parallel-ready nodes may interleave deltas; the
    // nodeId key on every event is what makes that safe):
    //   node_start    {nodeId, agent}                    — node started, about to dispatch
    //   node_delta    {nodeId, text}                     — one worker token chunk
    //   node_complete {nodeId, status[, usage, costUsd]} — status: "submitted" |
    //                  "accepted" | "refused" | "failed"; usage/costUsd ride
    //                  only when the dispatch itself succeeded
    //   run_complete  {status, stoppedReason, dispatched, measuredSpentUsd}
    //                                                     — always the LAST event
    // Emitted for every node that got a node_start; nodes blocked BEFORE their
    // start (budget pre-gates) surface only in run_complete's stoppedReason +
    // the audited steps, exactly like the JSON response. Run-level gates
    // (terminal, budget_approval_pending) resolve before the stream opens and
    // stay real HTTP errors; the stream opens lazily on the first event. A
    // block-mode PII project never streams — the same pass runs buffered and
    // the JSON response carries `streamingSuppressed: true` (400 under
    // ADR-0021 'reject'). Without stream:true this route is byte-identical to
    // its pre-streaming behaviour.
    const streamReq = await resolveStreamRequest(db, req.body, run.projectId ?? null);
    if (streamReq.mode === "rejected") return reply.status(streamReq.status).send(streamReq.body);
    const sse = streamReq.mode === "stream" ? sseChannel(reply) : null;

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
    // PILLAR 6 §8 REQUEST BATCHING (ESTIMATE-ONLY): recorded ONCE per auto pass,
    // on the first non-empty READY set. See the estimate block below — nodes
    // still dispatch individually; true batching (an async Batches API) is out
    // of scope for this synchronous interactive path.
    let batchingEstimated = false;

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

      // PILLAR 6 §8 REQUEST BATCHING (ESTIMATE-ONLY): the READY set may hold
      // several nodes owned by the SAME model. A real Batches API would amortize
      // the per-request framing (system re-send, request scaffolding) each
      // individual dispatch pays; we do NOT batch in this synchronous
      // interactive path — nodes still dispatch one at a time below — so this is
      // purely the ESTIMATE of that opportunity, recorded once per auto pass in
      // the same per-technique savings ledger. It NEVER changes dispatch
      // behaviour. "passthrough" (the initiator's §12 off switch) yields no
      // estimate. True async batching is out of scope here.
      if (!batchingEstimated) {
        batchingEstimated = true;
        const owners = ready
          .map((nodeId) => {
            const node = graph.nodes.find((n) => n.id === nodeId);
            return node ? (state.owners[node.id] ?? node.ownerAgentId) : null;
          })
          .filter((id): id is string => !!id);
        const ownerAgents = owners.length
          ? await db.select().from(agents).where(inArray(agents.id, owners))
          : [];
        // group by served model; fall back to the agent id as a stable label so
        // distinct unpriced/no-model owners don't spuriously batch together
        const modelById = new Map(ownerAgents.map((a) => [a.id, a.model ?? a.id]));
        const models = owners.map((id) => modelById.get(id) ?? id);
        const [[initPolicy], orgForBatch] = await Promise.all([
          db.select().from(userAgentPolicies).where(eq(userAgentPolicies.userId, run.initiatingUserId)),
          loadOrgSettings(db),
        ]);
        const plan = planRequestBatching({
          models,
          // ADR-0021: the org default routing mode fills in for unset users;
          // the batchOverheadTokens dial rides into the kernel (default 200)
          routingMode: effectiveTechniqueMode(orgForBatch, true, initPolicy?.routingMode ?? null),
          perRequestOverheadTokens: orgForBatch.batchOverheadTokens,
        });
        if (plan.batchable) {
          await db.insert(costEvents).values({
            userId: run.initiatingUserId,
            objectType: "run",
            objectId: run.id,
            technique: "request_batching",
            estimatedTokensSaved: plan.estimatedTokensSaved,
            // an amortized-overhead estimate, not a priced substitution — left
            // null rather than invent a dollar figure
            estimatedCostSavedUsd: null,
            estimationBasis: plan.estimationBasis,
            ruleId: "request-batching",
            ...(run.projectId ? { projectId: run.projectId } : {}),
            detail: { groups: plan.groups },
          });
        }
      }

      // One WAVE = the whole ready set (capped by the pass budget). Each wave
      // node is started (through its own §5.2 gates) and dispatched before
      // any submission lands, so independent branches overlap in the recorded
      // state — the events history shows node B starting while node A is
      // still in_progress. Submissions close the wave; dependents surface as
      // the next wave's ready set.
      const wave = ready.slice(0, Math.max(1, body.maxNodes - dispatched));
      const toSubmit: string[] = [];
      let waveStop: string | null = null;

      for (const nodeId of wave) {
        run = await reload();
        // Serialization honesty: a non-parallelizable wave member (or a wave
        // member invalidated by an earlier wave failure) is skipped, not
        // forced — the next iteration re-evaluates readiness from scratch.
        if (!readyNodes(run.graph as TaskGraph, run.state as RunState).includes(nodeId)) continue;

        // run-level measured-budget stop BEFORE starting the node, so a
        // blocked pass never strands a node in_progress.
        const budget = (run.budget ?? null) as RunBudget | null;
        const measuredSpent = budget?.measuredSpentUsd ?? 0;
        if (budget && budget.capUsd !== null && !budget.overageApproved && measuredSpent >= budget.capUsd) {
          waveStop = "budget_exceeded_measured";
          steps.push({ nodeId, action: "blocked_budget_measured", measuredSpentUsd: measuredSpent });
          break;
        }

        // §5.2 estimate gate, then the same node_started event the manual path uses
        const gate = await gateNodeStartBudget(db, run, nodeId, actor);
        if (gate.blocked) {
          waveStop = "budget_exceeded";
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

        const runForDispatch = await reload();
        if (sse) {
          const g = runForDispatch.graph as TaskGraph;
          const s = runForDispatch.state as RunState;
          sse.send("node_start", {
            nodeId,
            agent: s.owners[nodeId] ?? g.nodes.find((n) => n.id === nodeId)?.ownerAgentId ?? null,
          });
        }
        const out = await dispatchRunNode(
          db,
          opts.dataKey,
          runForDispatch,
          nodeId,
          {
            input: body.inputs?.[nodeId],
            maxTokens: body.maxTokens,
            ...(sse ? { onDelta: (text: string) => sse.send("node_delta", { nodeId, text }) } : {}),
          },
          actor,
        );

        if (out.kind === "budget_blocked_measured") {
          // started this wave but the cap arrived first — fail it (blocked,
          // retryable once the overage is approved) rather than strand it
          waveStop = "budget_exceeded_measured";
          steps.push({ nodeId, action: "blocked_budget_measured", measuredSpentUsd: out.measuredSpentUsd });
          await applyRunEvent(
            db,
            runId,
            { kind: "node_failed", nodeId, error: "budget cap reached before this node could dispatch" },
            actor,
            opts.dataKey,
          );
          sse?.send("node_complete", { nodeId, status: "failed" });
          break;
        }
        if (out.kind === "node_budget_blocked_measured") {
          // this node's own measured ceiling was already reached on a prior pass
          // — its escalation is queued; fail it (blocked, retryable once the
          // overage is approved) and stop the pass rather than strand it.
          waveStop = "node_budget_exceeded_measured";
          steps.push({ nodeId, action: "blocked_node_budget_measured", measuredNodeUsd: out.measuredNodeUsd });
          await applyRunEvent(
            db,
            runId,
            { kind: "node_failed", nodeId, error: "per-node budget ceiling reached before this node could dispatch" },
            actor,
            opts.dataKey,
          );
          sse?.send("node_complete", { nodeId, status: "failed" });
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
          sse?.send("node_complete", { nodeId, status: "failed" });
          continue;
        }
        if (out.kind !== "ok") {
          // unknown_node / not_in_progress cannot happen for a node we just
          // started — defensive stop rather than a silent loop
          waveStop = out.kind;
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
          sse?.send("node_complete", {
            nodeId,
            status: "refused",
            usage: out.result.usage,
            costUsd: out.result.costUsd,
          });
          if (out.budgetBreached) {
            waveStop = "budget_exceeded_measured";
            break;
          }
          if (out.nodeBudgetBreached) {
            waveStop = "node_budget_exceeded_measured";
            break;
          }
          continue;
        }

        toSubmit.push(nodeId);
        steps.push({
          nodeId,
          action: body.acceptReviews ? "accepted" : "submitted",
          costUsd: out.result.costUsd,
        });
        sse?.send("node_complete", {
          nodeId,
          status: body.acceptReviews ? "accepted" : "submitted",
          usage: out.result.usage,
          costUsd: out.result.costUsd,
        });
        if (out.budgetBreached) {
          waveStop = "budget_exceeded_measured";
          break;
        }
        // §5.2 a node's measured ceiling crossing (first crossing allowed +
        // escalated) stops the pass, mirroring the run-cap stop, so no further
        // node dispatches while the per-node overage sits in the queue.
        if (out.nodeBudgetBreached) {
          waveStop = "node_budget_exceeded_measured";
          break;
        }
      }

      // Close the wave: everything that dispatched cleanly is submitted (and
      // optionally accepted) — even when the wave stopped early, so a budget
      // stop never leaves finished work stranded in_progress.
      for (const nodeId of toSubmit) {
        await applyRunEvent(db, runId, { kind: "node_submitted", nodeId }, actor, opts.dataKey);
        let finalStatus: "in_review" | "done" = "in_review";
        if (body.acceptReviews) {
          await applyRunEvent(db, runId, { kind: "node_accepted", nodeId }, actor, opts.dataKey);
          finalStatus = "done";
        }
        await mirrorNodeStatus(db, opts.dataKey, runId, nodeId, finalStatus, actor);
      }

      if (waveStop) {
        stoppedReason = waveStop;
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
        // ADR-0019 §8.4 disclosure — a stream request buffered on a
        // block-mode project is recorded, never silent.
        ...(streamReq.mode === "suppressed" ? { streamingSuppressed: true } : {}),
      },
      effect: "allow",
      ruleId: "run-auto-advance",
      ruleChain: [],
      reason: `auto-advance pass took ${steps.length} step(s), stopped: ${stoppedReason}`,
    });
    const measuredSpentUsd = ((run.budget ?? null) as RunBudget | null)?.measuredSpentUsd ?? 0;
    if (sse) {
      // always the LAST envelope event, even when nothing was ready — the
      // stream never ends without saying how the pass ended.
      sse.send("run_complete", { status: run.status, stoppedReason, dispatched, measuredSpentUsd });
      sse.end();
      return reply;
    }
    return {
      status: run.status,
      state: run.state,
      readyNodes: readyNodes(run.graph as TaskGraph, run.state as RunState),
      steps,
      stoppedReason,
      measuredSpentUsd,
      ...(streamReq.mode === "suppressed" ? { streamingSuppressed: true } : {}),
    };
  });

  app.get("/v1/runs/:runId", async (req, reply) => {
    const { runId } = runIdParam.parse(req.params);
    const loaded = await loadRunFor(req, runId, { allowPendingApprover: true });
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
      run: loaded.run,
      readyNodes: readyNodes(loaded.run.graph as TaskGraph, loaded.run.state as RunState),
      events,
      pendingApprovals: pendingApprovals.map((a) => ({
        ...a,
        approverName: approverName.get(a.approverUserId) ?? null,
      })),
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
