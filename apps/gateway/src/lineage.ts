/**
 * ADR-0050 — the GATEWAY half of the DATA-LINEAGE / PROVENANCE GRAPH.
 *
 *   `packages/shared/src/lineage.ts`  the vocabularies, the natural-key
 *                                     derivation and the bounded, cycle-safe,
 *                                     visibility-filtered traversal. Pure.
 *   THIS FILE                         the capture helpers the already-existing
 *                                     interception points call, the
 *                                     entitlement-scoped queries, the API and
 *                                     the audit rows.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * THE SCOPE SENTENCE, REPEATED HERE ON PURPOSE
 * ═════════════════════════════════════════════════════════════════════════
 *
 * This is SUPPLIED-INPUTS provenance. It records which inputs the gateway
 * HANDED to a dispatch and what that dispatch handed back. It does not, and
 * cannot, say which of those inputs influenced the output — that is intra-model
 * attribution and is not observable from outside a model. Every traversal
 * response carries `LINEAGE_COMPLETENESS_NOTE` saying exactly that, because a
 * caveat that lives only in an ADR is a caveat nobody reads.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * FOUR PROPERTIES THIS FILE EXISTS TO GUARANTEE
 * ═════════════════════════════════════════════════════════════════════════
 *
 *  1. IT BUILDS ON PILLAR 4, IT DOES NOT DUPLICATE IT. A `context_item` node
 *     IS the §9.2 provenance tag promoted to a graph node: same key, same
 *     revision, same versioning. `project_context_items` stays the source of
 *     truth and this graph is a derived read-model over it — if it were lost
 *     it could be rebuilt.
 *
 *  2. CAPTURE RIDES EXISTING INTERCEPTION POINTS. There is no second
 *     instrumentation pass (the ADR-0024 discipline). `recordContextRevision`
 *     is called from the ONE context-write path, and `recordRunInputs` /
 *     `recordRunOutput` / `recordToolResultInput` from the ONE orchestration
 *     dispatch path. Each is best-effort and swallows its own failure: a
 *     lineage write must never be able to fail a governed dispatch that has
 *     already been metered and audited.
 *
 *  3. LINEAGE NEVER REVEALS CONTEXT THE CALLER CANNOT ACCESS. Nodes carry a
 *     `project_id` and every query loads ONLY nodes in the caller's visible
 *     projects. The traversal then applies `isVisible` as a second line of
 *     defence, and an edge to an invisible node is dropped WITH its endpoint —
 *     reported as a count, never as an id. For lineage the mere existence of a
 *     node is the sensitive fact: "this run touched something in the legal
 *     team's project" is a leak even without the something.
 *
 *  4. TRAVERSALS TERMINATE. Bounded depth, bounded breadth, a visited set, and
 *     a DDL-level ban on self-loops. A cycle is not hypothetical here — a
 *     context item can be produced by a run that consumed an earlier version of
 *     itself.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  and,
  desc,
  eq,
  inArray,
  lineageEdges,
  lineageNodes,
  auditLog,
  projectMembers,
  projects,
  sql,
  type Db,
  type LineageNodeRow,
} from "@regulait/db";
import {
  LINEAGE_COMPLETENESS_NOTE,
  LINEAGE_MAX_NODES,
  directRunLineage,
  lineageNaturalKey,
  lineageQuerySchema,
  traverseLineage,
  type LineageEdgeKind,
  type LineageNodeKind,
  type LineageSubtype,
} from "@regulait/shared";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

// ---------------------------------------------------------------------------
// Capture primitives
// ---------------------------------------------------------------------------

export interface EnsureNodeInput {
  projectId: string;
  kind: LineageNodeKind;
  subtype: LineageSubtype;
  /**
   * The dedupe identity, computed by the CALLER with `lineageNaturalKey`.
   * Explicit rather than inferred from the fields below, because the two are
   * not the same question: a context item is identified by its KEY and
   * REVISION (so an API caller can name it without first looking up a uuid),
   * while a run node is identified by its run id and graph-node id. A single
   * inference rule over the columns would silently pick the wrong one for half
   * the subtypes, and the failure mode — a forked graph that under-reports
   * every traversal while looking healthy — is invisible until an audit.
   */
  naturalKey: string;
  refId?: string | null;
  refKey?: string | null;
  version?: number | null;
  label: string;
  detail?: Record<string, unknown>;
  /** GOVERNANCE §8.4: content is OPT-IN. A caller that does not pass this
   * records metadata only, which is the default posture everywhere. */
  content?: string | null;
}

/**
 * Idempotent by natural key. Two captures of the same real thing MUST land on
 * one node — a forked graph under-reports every traversal while looking
 * perfectly healthy, which is the worst failure mode a provenance store has.
 */
export async function ensureLineageNode(db: Db, input: EnsureNodeInput): Promise<string> {
  const naturalKey = input.naturalKey;
  const [existing] = await db
    .select({ id: lineageNodes.id })
    .from(lineageNodes)
    .where(and(eq(lineageNodes.projectId, input.projectId), eq(lineageNodes.naturalKey, naturalKey)));
  if (existing) return existing.id;
  const [row] = await db
    .insert(lineageNodes)
    .values({
      projectId: input.projectId,
      kind: input.kind,
      subtype: input.subtype,
      naturalKey,
      refId: input.refId ?? null,
      refKey: input.refKey ?? null,
      version: input.version ?? null,
      label: input.label.slice(0, 500),
      contentRecorded: input.content != null,
      content: input.content ?? null,
      detail: input.detail ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: lineageNodes.id });
  if (row) return row.id;
  // lost a concurrent race on the unique index — re-read the winner
  const [winner] = await db
    .select({ id: lineageNodes.id })
    .from(lineageNodes)
    .where(and(eq(lineageNodes.projectId, input.projectId), eq(lineageNodes.naturalKey, naturalKey)));
  return winner!.id;
}

export async function ensureLineageEdge(
  db: Db,
  input: {
    projectId: string;
    fromNodeId: string;
    toNodeId: string;
    kind: LineageEdgeKind;
    runId?: string | null;
    nodeId?: string | null;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  if (input.fromNodeId === input.toNodeId) return; // the DDL bans it; do not throw on it
  await db
    .insert(lineageEdges)
    .values({
      projectId: input.projectId,
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      kind: input.kind,
      runId: input.runId ?? null,
      nodeId: input.nodeId ?? null,
      detail: input.detail ?? null,
    })
    .onConflictDoNothing();
}

/**
 * BEST-EFFORT. Every capture call site sits AFTER a governed action has already
 * been metered and audited, so a lineage failure must never turn a successful,
 * billed dispatch into an error. The swallow is deliberate and is the reason
 * lineage is described as a derived read-model rather than a ledger.
 */
async function bestEffort(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    /* lineage is a derived read-model; it is rebuildable from the ledgers */
  }
}

/** the label a context-item node shows */
const contextLabel = (key: string, revision: number) => `context '${key}' v${revision}`;

/**
 * Called from the ONE context-write path (`writeContextRevision`). Creates the
 * item-version node and, when there is a predecessor, the `derived_from` edge
 * that chains versions — stored predecessor → successor so a backward walk
 * crosses it without a special case.
 *
 * When the write declares the run that produced it, the `produced` edge is
 * added too: THAT is what makes lineage chain ACROSS runs, because the same
 * node is a source for whichever later run consumes it.
 */
export async function recordContextRevision(
  db: Db,
  input: {
    projectId: string;
    key: string;
    revision: number;
    itemId: string;
    baseRevision: number | null;
    /** the orchestration run + node that produced this write, when declared */
    producedByRunId?: string | null;
    producedByNodeId?: string | null;
  },
): Promise<void> {
  await bestEffort(async () => {
    const nodeId = await ensureLineageNode(db, {
      projectId: input.projectId,
      naturalKey: lineageNaturalKey({ subtype: "context_item", refKey: input.key, version: input.revision }),
      // a written context item is an OUTPUT of whatever produced it and a
      // SOURCE for whatever consumes it next. It is stored as `source`
      // because that is what it is for every downstream traversal; the
      // `produced` edge below is what marks it as an output of a run.
      kind: "source",
      subtype: "context_item",
      refId: input.itemId,
      refKey: input.key,
      version: input.revision,
      label: contextLabel(input.key, input.revision),
    });

    if (input.baseRevision != null) {
      const [prev] = await db
        .select({ id: lineageNodes.id })
        .from(lineageNodes)
        .where(
          and(
            eq(lineageNodes.projectId, input.projectId),
            eq(
              lineageNodes.naturalKey,
              lineageNaturalKey({ subtype: "context_item", refKey: input.key, version: input.baseRevision }),
            ),
          ),
        );
      if (prev) {
        await ensureLineageEdge(db, {
          projectId: input.projectId,
          fromNodeId: prev.id,
          toNodeId: nodeId,
          kind: "derived_from",
          detail: { fromRevision: input.baseRevision, toRevision: input.revision },
        });
      }
    }

    if (input.producedByRunId && input.producedByNodeId) {
      const runNode = await ensureLineageNode(db, {
        projectId: input.projectId,
        naturalKey: lineageNaturalKey({
          subtype: "run_node",
          refId: input.producedByRunId,
          refKey: input.producedByNodeId,
        }),
        kind: "run",
        subtype: "run_node",
        refId: input.producedByRunId,
        refKey: input.producedByNodeId,
        label: `run node '${input.producedByNodeId}'`,
      });
      await ensureLineageEdge(db, {
        projectId: input.projectId,
        fromNodeId: runNode,
        toNodeId: nodeId,
        kind: "produced",
        runId: input.producedByRunId,
        nodeId: input.producedByNodeId,
      });
    }
  });
}

/** the run node for one orchestration task-graph node dispatch */
export async function ensureRunNode(db: Db, projectId: string, runId: string, nodeId: string): Promise<string> {
  return ensureLineageNode(db, {
    projectId,
    naturalKey: lineageNaturalKey({ subtype: "run_node", refId: runId, refKey: nodeId }),
    kind: "run",
    subtype: "run_node",
    refId: runId,
    refKey: nodeId,
    label: `run node '${nodeId}'`,
  });
}

/**
 * Called from the ONE orchestration dispatch path, for each input the gateway
 * ACTUALLY SUPPLIED to the worker: the signed-off workflow artifacts that form
 * the nested-run scope lock, and any shared-context item versions the dispatch
 * named. "Actually supplied" is load-bearing — recording an input the worker
 * never received would be exactly the fiction this ADR is written against.
 */
export async function recordRunInputs(
  db: Db,
  input: {
    projectId: string;
    runId: string;
    nodeId: string;
    artifacts?: Array<{ output: string; version: number }>;
    contextItems?: Array<{ id: string; key: string; revision: number }>;
  },
): Promise<void> {
  await bestEffort(async () => {
    const runNodeId = await ensureRunNode(db, input.projectId, input.runId, input.nodeId);
    for (const a of input.artifacts ?? []) {
      const src = await ensureLineageNode(db, {
        projectId: input.projectId,
        naturalKey: lineageNaturalKey({ subtype: "workflow_artifact", refKey: a.output, version: a.version }),
        kind: "source",
        subtype: "workflow_artifact",
        refKey: a.output,
        version: a.version,
        label: `signed-off artifact '${a.output}' v${a.version}`,
      });
      await ensureLineageEdge(db, {
        projectId: input.projectId,
        fromNodeId: src,
        toNodeId: runNodeId,
        kind: "flowed_into",
        runId: input.runId,
        nodeId: input.nodeId,
        detail: { supplied: "workflow artifact as nested-run scope lock" },
      });
    }
    for (const c of input.contextItems ?? []) {
      const src = await ensureLineageNode(db, {
        projectId: input.projectId,
        naturalKey: lineageNaturalKey({ subtype: "context_item", refKey: c.key, version: c.revision }),
        kind: "source",
        subtype: "context_item",
        refId: c.id,
        refKey: c.key,
        version: c.revision,
        label: contextLabel(c.key, c.revision),
      });
      await ensureLineageEdge(db, {
        projectId: input.projectId,
        fromNodeId: src,
        toNodeId: runNodeId,
        kind: "flowed_into",
        runId: input.runId,
        nodeId: input.nodeId,
        detail: { supplied: "shared context item version, injected as system context" },
      });
    }
  });
}

/** a governed MCP tool result that came back INTO a run mid-loop */
export async function recordToolResultInput(
  db: Db,
  input: { projectId: string; runId: string; nodeId: string; serverId: string; toolName: string; callId: string },
): Promise<void> {
  await bestEffort(async () => {
    const runNodeId = await ensureRunNode(db, input.projectId, input.runId, input.nodeId);
    const src = await ensureLineageNode(db, {
      projectId: input.projectId,
      naturalKey: lineageNaturalKey({
        subtype: "mcp_result",
        refId: input.serverId,
        refKey: `${input.toolName}#${input.callId}`,
      }),
      kind: "source",
      subtype: "mcp_result",
      refId: input.serverId,
      refKey: `${input.toolName}#${input.callId}`,
      label: `MCP tool result '${input.toolName}'`,
    });
    await ensureLineageEdge(db, {
      projectId: input.projectId,
      fromNodeId: src,
      toNodeId: runNodeId,
      kind: "flowed_into",
      runId: input.runId,
      nodeId: input.nodeId,
      detail: { supplied: "governed MCP tool result returned into the worker loop" },
    });
  });
}

/** what the dispatch produced. METADATA ONLY — the output TEXT is not stored
 * here (§8.4); the node records that an output exists and which run made it. */
export async function recordRunOutput(
  db: Db,
  input: { projectId: string; runId: string; nodeId: string; stopReason?: string | null; tokens?: number },
): Promise<void> {
  await bestEffort(async () => {
    const runNodeId = await ensureRunNode(db, input.projectId, input.runId, input.nodeId);
    const out = await ensureLineageNode(db, {
      projectId: input.projectId,
      naturalKey: lineageNaturalKey({ subtype: "dispatch_output", refId: input.runId, refKey: input.nodeId }),
      kind: "output",
      subtype: "dispatch_output",
      refId: input.runId,
      refKey: input.nodeId,
      label: `output of run node '${input.nodeId}'`,
      detail: { stopReason: input.stopReason ?? null, outputTokens: input.tokens ?? null },
    });
    await ensureLineageEdge(db, {
      projectId: input.projectId,
      fromNodeId: runNodeId,
      toNodeId: out,
      kind: "produced",
      runId: input.runId,
      nodeId: input.nodeId,
    });
  });
}

// ---------------------------------------------------------------------------
// Entitlement scoping
// ---------------------------------------------------------------------------

/**
 * The projects a caller may see lineage for. Admin = all. Anyone else = the
 * projects they are a MEMBER of, exactly the narrowing pillar 4 already applies
 * to the context store itself — lineage must not become a side channel that
 * reveals context the /context endpoints would refuse.
 */
export async function visibleProjectIds(
  db: Db,
  actor: { userId: string | null; isAdmin: boolean },
): Promise<string[] | null> {
  if (actor.isAdmin) return null; // null = unconstrained
  if (!actor.userId) return [];
  const rows = await db
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, actor.userId));
  return [...new Set(rows.map((r) => r.id))];
}

/**
 * Load the nodes and edges a traversal may consider — ALREADY NARROWED. This is
 * the primary defence: the traversal simply never receives an edge whose
 * endpoints the caller cannot see. `traverseLineage`'s `isVisible` predicate is
 * the second, applied to whatever does come back.
 */
async function loadGraph(
  db: Db,
  visible: string[] | null,
): Promise<{ nodes: Map<string, LineageNodeRow>; edges: Array<{ id: string; fromNodeId: string; toNodeId: string; kind: LineageEdgeKind }> }> {
  const nodeRows = await db
    .select()
    .from(lineageNodes)
    .where(visible === null ? undefined : inArray(lineageNodes.projectId, visible.length ? visible : [ZERO_UUID]));
  const nodes = new Map(nodeRows.map((n) => [n.id, n]));
  const edgeRows = await db
    .select({
      id: lineageEdges.id,
      fromNodeId: lineageEdges.fromNodeId,
      toNodeId: lineageEdges.toNodeId,
      kind: lineageEdges.kind,
    })
    .from(lineageEdges);
  // an edge is CONSIDERED only when BOTH endpoints are visible nodes. An edge
  // with one visible endpoint is still counted as withheld by the traversal,
  // which is how a partial answer stays honest about being partial.
  return { nodes, edges: edgeRows.filter((e) => nodes.has(e.fromNodeId) || nodes.has(e.toNodeId)) };
}

function publicNode(n: LineageNodeRow) {
  return {
    id: n.id,
    projectId: n.projectId,
    kind: n.kind,
    subtype: n.subtype,
    naturalKey: n.naturalKey,
    refId: n.refId,
    refKey: n.refKey,
    version: n.version,
    label: n.label,
    contentRecorded: n.contentRecorded,
    // content is returned ONLY where it was explicitly recorded (§8.4). A node
    // captured under the default metadata-only posture has none to return.
    ...(n.contentRecorded ? { content: n.content } : {}),
    createdAt: n.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerLineageRoutes(app: FastifyInstance, db: Db): void {
  async function audit(
    actor: string | null,
    objectId: string | null,
    ruleId: string,
    reason: string,
    detail: Record<string, unknown>,
    effect: "allow" | "deny" = "allow",
  ) {
    await db.insert(auditLog).values({
      userId: actor ?? NO_IDENTITY,
      objectType: "project",
      objectId,
      detail,
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });
  }

  /** THE TRAVERSAL. Forward = "everything this reached"; backward = "everything
   * that produced this". Bounded depth, bounded breadth, entitlement-scoped. */
  app.get("/v1/lineage", async (req, reply) => {
    const q = lineageQuerySchema.parse(req.query ?? {});
    const visible = await visibleProjectIds(db, req.authCtx);
    const { nodes, edges } = await loadGraph(db, visible);

    let startId = q.nodeId ?? null;
    if (!startId && q.projectId && q.naturalKey) {
      const [row] = await db
        .select({ id: lineageNodes.id })
        .from(lineageNodes)
        .where(and(eq(lineageNodes.projectId, q.projectId), eq(lineageNodes.naturalKey, q.naturalKey)));
      startId = row?.id ?? null;
    }
    // A node the caller cannot see is reported as UNKNOWN, not as forbidden:
    // a 403 would confirm that the node exists, which for lineage is itself
    // the disclosure. Same 404 either way.
    if (!startId || !nodes.has(startId)) {
      await audit(
        req.authCtx.userId ?? null,
        q.projectId ?? null,
        "lineage-node-not-visible",
        "a lineage traversal named a node that does not exist, or that this caller cannot see. The " +
          "two are answered IDENTICALLY on purpose: distinguishing them would confirm the existence " +
          "of context the caller has no access to, which for a provenance graph is the disclosure itself.",
        { naturalKey: q.naturalKey ?? null, direction: q.direction },
        "deny",
      );
      return reply.status(404).send({ error: "unknown_lineage_node" });
    }

    const result = traverseLineage({
      startNodeId: startId,
      edges,
      direction: q.direction,
      maxDepth: q.maxDepth,
      maxNodes: LINEAGE_MAX_NODES,
      isVisible: (id) => nodes.has(id),
    });

    return {
      start: publicNode(nodes.get(startId)!),
      direction: q.direction,
      maxDepth: q.maxDepth,
      nodes: result.nodeIds.map((id) => ({ ...publicNode(nodes.get(id)!), depth: result.depths[id] ?? 0 })),
      edges: result.edges,
      truncated: result.truncated,
      maxDepthReached: result.maxDepthReached,
      /** a COUNT, never ids — see the module header */
      withheldEdges: result.withheldEdges,
      note: LINEAGE_COMPLETENESS_NOTE,
    };
  });

  /** THE HEADLINE QUERY: "where did this run's inputs come from, and what did
   * it produce?" — one hop each way, which is what an investigator asks first. */
  app.get("/v1/lineage/runs/:runId", async (req, reply) => {
    const { runId } = z.object({ runId: z.string().uuid() }).parse(req.params);
    const q = z.object({ nodeId: z.string().max(64).optional() }).parse(req.query ?? {});
    const visible = await visibleProjectIds(db, req.authCtx);
    const { nodes, edges } = await loadGraph(db, visible);

    const runNodes = [...nodes.values()].filter(
      (n) => n.kind === "run" && n.refId === runId && (!q.nodeId || n.refKey === q.nodeId),
    );
    if (runNodes.length === 0) return reply.status(404).send({ error: "unknown_lineage_run" });

    const dispatches = runNodes.map((rn) => {
      const direct = directRunLineage({ runNodeId: rn.id, edges, isVisible: (id) => nodes.has(id) });
      return {
        node: publicNode(rn),
        suppliedInputs: direct.inputs.map((id) => publicNode(nodes.get(id)!)),
        producedOutputs: direct.outputs.map((id) => publicNode(nodes.get(id)!)),
        withheldEdges: direct.withheldEdges,
      };
    });
    return { runId, dispatches, note: LINEAGE_COMPLETENESS_NOTE };
  });

  /** the node index a UI lists from, entitlement-scoped like everything else */
  app.get("/v1/lineage/nodes", async (req) => {
    const q = z
      .object({
        projectId: z.string().uuid().optional(),
        kind: z.enum(["source", "run", "output"]).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(req.query ?? {});
    const visible = await visibleProjectIds(db, req.authCtx);
    const rows = await db
      .select()
      .from(lineageNodes)
      .where(
        and(
          ...(q.projectId ? [eq(lineageNodes.projectId, q.projectId)] : []),
          ...(q.kind ? [eq(lineageNodes.kind, q.kind)] : []),
          ...(visible === null
            ? []
            : [inArray(lineageNodes.projectId, visible.length ? visible : [ZERO_UUID])]),
        ),
      )
      .orderBy(desc(lineageNodes.createdAt))
      .limit(q.limit);
    return { nodes: rows.map(publicNode), note: LINEAGE_COMPLETENESS_NOTE };
  });

  /** the admin rollup the SPA's lineage page renders */
  app.get("/v1/lineage/overview", async () => {
    const counts = await db
      .select({ kind: lineageNodes.kind, n: sql<number>`count(*)::int` })
      .from(lineageNodes)
      .groupBy(lineageNodes.kind);
    const edgeCounts = await db
      .select({ kind: lineageEdges.kind, n: sql<number>`count(*)::int` })
      .from(lineageEdges)
      .groupBy(lineageEdges.kind);
    const byProject = await db
      .select({ projectId: lineageNodes.projectId, name: projects.name, n: sql<number>`count(*)::int` })
      .from(lineageNodes)
      .leftJoin(projects, eq(projects.id, lineageNodes.projectId))
      .groupBy(lineageNodes.projectId, projects.name);
    return {
      nodesByKind: counts,
      edgesByKind: edgeCounts,
      byProject,
      contentLevelLineageEnabled: false,
      note: LINEAGE_COMPLETENESS_NOTE,
      captureNote:
        "Capture rides the interception points that already exist: the shared-context write path and " +
        "the orchestration node-dispatch path (including governed MCP tool results returned into a " +
        "worker loop). There is no second instrumentation pass, and paths NOT yet wired — direct " +
        "/v1/messages dispatches, connector invocations outside a run, PR and PM-work-item outputs — " +
        "produce no lineage today rather than a partial record that looks complete.",
    };
  });
}
