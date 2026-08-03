/**
 * ADR-0050 — the DATA-LINEAGE / PROVENANCE GRAPH, the PURE half.
 *
 *   THIS FILE            the vocabularies, the natural-key derivation, the zod
 *                        shapes, and the TRAVERSAL — bounded-depth, cycle-safe,
 *                        and visibility-filtered. No db, no clock, no Fastify.
 *   `apps/gateway/src/lineage.ts`
 *                        the node/edge writes at the points the gateway already
 *                        intercepts, the entitlement-scoped queries, the API
 *                        and the audit rows.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT "LINEAGE" MEANS HERE, AND WHAT IT DOES NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * This graph answers exactly one question, and it is important to say which:
 *
 *   ✅  "Which inputs were SUPPLIED to this dispatch, and what did it produce?"
 *
 * It does NOT answer, and must never be read as answering:
 *
 *   ❌  "Which of those inputs actually INFLUENCED the output, and how much?"
 *
 * The second question is intra-model attribution. It is not observable from
 * outside a model: a dispatch receives a system prompt, a message list and a
 * set of tool results, and returns text. Nothing at the gateway boundary can
 * say which sentence of which supplied document moved which clause of the
 * answer. Claiming otherwise would be the single most tempting overstatement
 * available to a lineage feature, and an auditor who believed it would draw
 * false conclusions from it.
 *
 * So: **lineage here is SUPPLIED-INPUTS PROVENANCE.** It is a faithful record
 * of what the gateway handed to a run and what the run handed back, chained
 * across runs through the context store's versioned items. That is genuinely
 * useful — it is what a DPIA data-flow map and an e-discovery "what touched
 * this" request actually need — and it is all that is claimed.
 *
 * Three further bounds, each stated in `LINEAGE_COMPLETENESS_NOTE` and returned
 * on every traversal payload rather than buried here:
 *
 *  1. **Gateway visibility.** Only what flowed through a governed call is
 *     captured. Something a user pasted into a prompt from an ungoverned
 *     source, or that a model absorbed in training, is invisible. This is the
 *     exact analogue of ADR-0024's "we meter what we intercept".
 *  2. **Node granularity.** A node is a call or an item version, never a
 *     column or a sentence. Field-level lineage is not claimed.
 *  3. **Metadata by default.** A node records THAT source X flowed into run Y,
 *     not the content of X (GOVERNANCE §8.4). Content is opt-in and
 *     cascade-gated; `contentRecorded` on a node says which you are looking at.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const LINEAGE_NODE_KINDS = ["source", "run", "output"] as const;
export type LineageNodeKind = (typeof LINEAGE_NODE_KINDS)[number];

/**
 * The concrete THING a node stands for. Deliberately a closed vocabulary: a new
 * kind of traceable object is a deliberate act, not a typo in a text column.
 */
export const LINEAGE_SUBTYPES = [
  // sources
  "context_item", // a §9.2 shared-context item VERSION (the provenance tag becomes the node)
  "workflow_artifact", // a signed-off requirements/plan artifact supplied as scope-lock
  "connector_result", // a governed connector read
  "mcp_result", // a governed MCP tool result
  "document", // an uploaded attachment
  // runs
  "run_node", // one orchestration task-graph node dispatch
  "agent_dispatch", // a direct (non-orchestrated) governed dispatch
  // outputs
  "dispatch_output", // the text a run produced
  "pull_request",
  "pm_work_item",
] as const;
export type LineageSubtype = (typeof LINEAGE_SUBTYPES)[number];

/**
 * ADR-0050 §1's three edge kinds.
 *
 * ORIENTATION — the one convention the whole traversal rests on: EVERY edge
 * points in the DIRECTION OF DATA FLOW, `from` = upstream, `to` = downstream.
 * That uniformity is what makes `backward` mean "where did this come from?"
 * everywhere in the graph, with no per-edge-kind special case. Note in
 * particular that `derived_from` is NAMED for the relationship it records but
 * is STORED predecessor → successor (`v1 → v2`), not the other way around: an
 * edge stored in the direction its name reads would invert one third of the
 * graph and make a backward walk silently stop at every version boundary.
 *
 *  - `flowed_into`  source → run. Something was SUPPLIED to a dispatch.
 *  - `produced`     run → output. A dispatch emitted something.
 *  - `derived_from` version N → version N+1 of the same item. This is what makes
 *    the chain transitive across runs: revision 2 of a context item derives
 *    from revision 1, so a backward walk from a run that consumed v2 reaches
 *    the run that produced v1. Lineage always points at the SPECIFIC version;
 *    provenance already versions and lineage rides that rather than
 *    re-implementing it.
 */
export const LINEAGE_EDGE_KINDS = ["flowed_into", "produced", "derived_from"] as const;
export type LineageEdgeKind = (typeof LINEAGE_EDGE_KINDS)[number];

export const LINEAGE_DIRECTIONS = ["forward", "backward", "both"] as const;
export type LineageDirection = (typeof LINEAGE_DIRECTIONS)[number];

/** the API's hard ceiling. A backward traversal from a widely-reused source (a
 * coding-standards context item consumed by hundreds of runs) fans out fast;
 * ADR-0050's consequences name this explicitly and cap depth for it. */
export const LINEAGE_MAX_DEPTH = 12;
export const LINEAGE_DEFAULT_DEPTH = 5;
/** and a hard ceiling on breadth, so one traversal cannot page in the graph */
export const LINEAGE_MAX_NODES = 500;

export const LINEAGE_COMPLETENESS_NOTE =
  "SCOPE OF THIS ANSWER — lineage here is SUPPLIED-INPUTS PROVENANCE, not intra-model attribution. " +
  "It records which inputs the gateway SUPPLIED to a dispatch and what that dispatch produced. It " +
  "does NOT claim which of those inputs influenced the output, or how much: that is not observable " +
  "from outside a model and is not asserted. Completeness is further bounded by gateway visibility " +
  "(only governed calls are captured — anything pasted in from an ungoverned source, or absorbed in " +
  "training, is invisible, the analogue of ADR-0024's 'we meter what we intercept'), by NODE " +
  "granularity (a node is a call or an item version, never a column or a sentence), and by the " +
  "metadata-by-default posture (GOVERNANCE §8.4: that X flowed into Y is recorded; the content of X " +
  "only when content-level lineage is explicitly opted into).";

// ---------------------------------------------------------------------------
// Natural keys — the dedupe identity of a node
// ---------------------------------------------------------------------------

/**
 * A node's identity within a project. Two writes describing the same real thing
 * must land on the SAME node or the graph silently forks and every traversal
 * under-reports. The key is derived rather than random for exactly that reason,
 * and it is derived HERE — pure and shared — so the gateway and the tests
 * cannot disagree about what "the same thing" means.
 */
export function lineageNaturalKey(input: {
  subtype: LineageSubtype;
  refId?: string | null;
  refKey?: string | null;
  version?: number | null;
}): string {
  const parts: string[] = [input.subtype];
  if (input.refId) parts.push(input.refId);
  if (input.refKey) parts.push(input.refKey);
  if (input.version != null) parts.push(`v${input.version}`);
  return parts.join(":");
}

export const lineageQuerySchema = z
  .object({
    nodeId: z.string().uuid().optional(),
    /** resolve a node by its natural key inside a project instead of by id */
    projectId: z.string().uuid().optional(),
    naturalKey: z.string().max(400).optional(),
    direction: z.enum(LINEAGE_DIRECTIONS).default("backward"),
    maxDepth: z.coerce.number().int().min(1).max(LINEAGE_MAX_DEPTH).default(LINEAGE_DEFAULT_DEPTH),
  })
  .strict()
  .refine((q) => Boolean(q.nodeId) || Boolean(q.projectId && q.naturalKey), {
    message: "supply either nodeId, or projectId + naturalKey",
  });

// ---------------------------------------------------------------------------
// THE TRAVERSAL
// ---------------------------------------------------------------------------

export interface LineageEdgeLike {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  kind: LineageEdgeKind;
}

export interface TraversalInput {
  startNodeId: string;
  /** every edge the caller's query loaded. The gateway loads only edges whose
   * endpoints are in visible projects; this predicate is the SECOND line of
   * defence, and the one the unit tests attack. */
  edges: LineageEdgeLike[];
  direction: LineageDirection;
  maxDepth: number;
  maxNodes?: number;
  /** false for any node the caller may not see. An invisible node is skipped
   * AND the edge reaching it is omitted from the result — not greyed out, not
   * returned with a redacted label. The count of omissions is reported so the
   * answer is honest about being partial, but never their ids. */
  isVisible?: (nodeId: string) => boolean;
}

export interface TraversalResult {
  /** every reachable, visible node id, in BFS order, start node first */
  nodeIds: string[];
  /** the edges actually traversed — every one has both endpoints in `nodeIds` */
  edges: LineageEdgeLike[];
  /** depth at which each node was found, keyed by node id */
  depths: Record<string, number>;
  maxDepthReached: number;
  /** true when the walk stopped because it hit `maxDepth` or `maxNodes` with
   * frontier left — so a caller never mistakes a truncated answer for a
   * complete one */
  truncated: boolean;
  /** how many edges were dropped because their far endpoint is not visible to
   * this caller. A COUNT ONLY — an id here would defeat the whole point. */
  withheldEdges: number;
  note: string;
}

/**
 * Breadth-first, bounded, cycle-safe.
 *
 * CYCLES ARE REAL, not hypothetical: a context item can be produced by a run
 * that consumed an earlier version of itself, and `derived_from` chains are
 * therefore only acyclic by convention, not by construction. The `seen` set is
 * checked before a node is ever enqueued, so a cycle terminates at its first
 * repeat rather than looping until the depth cap saves it. A deep chain
 * terminates on `maxDepth`; a wide one on `maxNodes`; both set `truncated`.
 *
 * VISIBILITY IS APPLIED TO THE FAR ENDPOINT BEFORE THE EDGE IS EMITTED. That
 * ordering is the whole security property: an edge emitted first and filtered
 * afterwards has already disclosed that a node exists, which for lineage is
 * itself the sensitive fact ("this run touched *something* in the legal team's
 * project" is a leak even without the something).
 */
export function traverseLineage(input: TraversalInput): TraversalResult {
  const visible = input.isVisible ?? (() => true);
  const maxNodes = input.maxNodes ?? LINEAGE_MAX_NODES;

  const result: TraversalResult = {
    nodeIds: [],
    edges: [],
    depths: {},
    maxDepthReached: 0,
    truncated: false,
    withheldEdges: 0,
    note: LINEAGE_COMPLETENESS_NOTE,
  };

  if (!visible(input.startNodeId)) return result;

  // adjacency, built once. `backward` walks toward what produced a thing;
  // `forward` walks toward what a thing reached.
  const out = new Map<string, LineageEdgeLike[]>();
  const inc = new Map<string, LineageEdgeLike[]>();
  const push = (m: Map<string, LineageEdgeLike[]>, k: string, e: LineageEdgeLike) => {
    const list = m.get(k);
    if (list) list.push(e);
    else m.set(k, [e]);
  };
  for (const e of input.edges) {
    push(out, e.fromNodeId, e);
    push(inc, e.toNodeId, e);
  }

  const seen = new Set<string>([input.startNodeId]);
  result.nodeIds.push(input.startNodeId);
  result.depths[input.startNodeId] = 0;
  let frontier = [input.startNodeId];
  const emitted = new Set<string>();

  for (let depth = 1; depth <= input.maxDepth; depth++) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      const candidates: Array<{ edge: LineageEdgeLike; other: string }> = [];
      if (input.direction === "forward" || input.direction === "both") {
        for (const e of out.get(nodeId) ?? []) candidates.push({ edge: e, other: e.toNodeId });
      }
      if (input.direction === "backward" || input.direction === "both") {
        for (const e of inc.get(nodeId) ?? []) candidates.push({ edge: e, other: e.fromNodeId });
      }
      for (const { edge, other } of candidates) {
        // VISIBILITY FIRST. The edge is not emitted for an invisible endpoint.
        if (!visible(other)) {
          if (!emitted.has(edge.id)) {
            emitted.add(edge.id);
            result.withheldEdges++;
          }
          continue;
        }
        if (!emitted.has(edge.id)) {
          emitted.add(edge.id);
          result.edges.push(edge);
        }
        if (seen.has(other)) continue; // the cycle/revisit guard
        if (result.nodeIds.length >= maxNodes) {
          result.truncated = true;
          continue;
        }
        seen.add(other);
        result.nodeIds.push(other);
        result.depths[other] = depth;
        result.maxDepthReached = depth;
        next.push(other);
      }
    }
    if (next.length === 0) return result;
    frontier = next;
  }
  // frontier still non-empty at the depth cap => the answer is partial
  if (frontier.length > 0) {
    for (const nodeId of frontier) {
      const more =
        (input.direction !== "backward" ? (out.get(nodeId) ?? []) : []).length +
        (input.direction !== "forward" ? (inc.get(nodeId) ?? []) : []).length;
      if (more > 0) {
        result.truncated = true;
        break;
      }
    }
  }
  return result;
}

/**
 * A run's DIRECT answer: the inputs supplied to it and the outputs it produced,
 * one hop each way. This is the question ADR-0050 is actually asked most often
 * ("where did this output's inputs come from"), and it is worth having as a
 * named function rather than a traversal every caller re-derives.
 */
export function directRunLineage(input: {
  runNodeId: string;
  edges: LineageEdgeLike[];
  isVisible?: (nodeId: string) => boolean;
}): { inputs: string[]; outputs: string[]; withheldEdges: number } {
  const visible = input.isVisible ?? (() => true);
  const inputs: string[] = [];
  const outputs: string[] = [];
  let withheldEdges = 0;
  for (const e of input.edges) {
    if (e.kind === "flowed_into" && e.toNodeId === input.runNodeId) {
      if (visible(e.fromNodeId)) inputs.push(e.fromNodeId);
      else withheldEdges++;
    }
    if (e.kind === "produced" && e.fromNodeId === input.runNodeId) {
      if (visible(e.toNodeId)) outputs.push(e.toNodeId);
      else withheldEdges++;
    }
  }
  return { inputs, outputs, withheldEdges };
}
