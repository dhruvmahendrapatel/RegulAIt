/**
 * ADR-0365 (lane E46, slice 1): the live synced context graph (pillar 4, PENDING P2).
 *
 * - `syncContextGraphSource`: incremental, idempotent sync of one bound PM connection's imported work items into graph
 *   nodes, their scope rows and `contains` edges, in one transaction with its audit row. The cursor is a keyset over
 *   `(first_seen_at, id)`, re-read with a 10-minute overlap so an import that committed late with an earlier timestamp
 *   is still seen; every insert is ON CONFLICT DO NOTHING, so the overlap costs nothing.
 * - `nodeReadable`: the ONE readable rule, the same SQL function the row-level security policies call
 *   (`regulait_context_graph_node_readable`): an admin, or a member of the project of EVERY scope row of a node that
 *   has at least one. Every query below applies it, so a caller never sees a node (or an edge to one) they cannot read.
 *
 * Nodes store no copy of the source's facts; the label, URL, type and missing state are joined at read (3NF), and
 * nothing PM-authoritative (title, state, fields) is stored or returned (pillar 8: read through live).
 */
import {
  and,
  auditLog,
  contextGraphEdges,
  contextGraphGitSources,
  contextGraphNodeScopes,
  contextGraphNodes,
  contextGraphSources,
  eq,
  inArray,
  ne,
  pmImportedWorkItems,
  sql,
  type Db,
  type SQL,
} from "@regulait/db";
import type { SchedulerJobDefinition } from "./scheduler.js";
import { syncContextGraphGitSource, type ContextGraphGitDeps } from "./context-graph-git.js";

/** the re-read window behind the cursor (ADR-0365 §2) */
export const CONTEXT_GRAPH_SYNC_OVERLAP_MS = 10 * 60_000;
/** items per page, and the most NEW items (past the old cursor) one sync call processes; the rest waits for the next
 * call (`more: true`). Re-read overlap rows do not count, so consecutive capped calls always progress. */
export const CONTEXT_GRAPH_SYNC_PAGE = 500;
export const CONTEXT_GRAPH_SYNC_MAX_ITEMS = 5_000;
/** the deepest neighbourhood a reader may ask for, and the most nodes it returns */
export const CONTEXT_GRAPH_MAX_DEPTH = 2;
export const CONTEXT_GRAPH_MAX_NEIGHBOURHOOD = 500;

export interface GraphCaller {
  userId: string | null;
  isAdmin: boolean;
}

/** The readable predicate for a node id column or value. Fail closed: no user and not admin reads nothing. */
export function nodeReadable(caller: GraphCaller, nodeId: SQL | ReturnType<typeof sql.raw>): SQL {
  if (caller.isAdmin) return sql`true`;
  if (!caller.userId) return sql`false`;
  return sql`regulait_context_graph_node_readable(${nodeId}, ${caller.userId}::uuid)`;
}

export type SyncResult =
  | { ok: true; sourceId: string; created: { nodes: number; edges: number; scopes: number }; scanned: number; runs: RunLinkResult; more: boolean; cursor: { firstSeenAt: string; itemId: string } | null }
  | { ok: false; status: 404; error: "source_not_found"; detail: string };

/**
 * Sync one source. `full` starts from the beginning (the cursor is ignored) instead of from the cursor minus the
 * overlap. Runs inside the caller's transaction when given one; the route wraps it in its own.
 */
export async function syncContextGraphSource(
  tx: Db,
  args: { sourceId: string; actorUserId: string; full?: boolean; pageSize?: number; maxItems?: number },
): Promise<SyncResult> {
  const pageSize = args.pageSize ?? CONTEXT_GRAPH_SYNC_PAGE;
  const maxItems = args.maxItems ?? CONTEXT_GRAPH_SYNC_MAX_ITEMS;
  const [src] = await tx.select().from(contextGraphSources).where(eq(contextGraphSources.id, args.sourceId)).for("update");
  if (!src) return { ok: false, status: 404, error: "source_not_found", detail: "no such context graph source" };

  const created = { nodes: 0, edges: 0, scopes: 0 };
  // the source's PM project node and its scope row
  const madeProject = await tx.insert(contextGraphNodes).values({ sourceId: src.id, kind: "pm_project" }).onConflictDoNothing().returning({ id: contextGraphNodes.id });
  created.nodes += madeProject.length;
  const [projectNode] = await tx
    .select({ id: contextGraphNodes.id })
    .from(contextGraphNodes)
    .where(and(eq(contextGraphNodes.sourceId, src.id), eq(contextGraphNodes.kind, "pm_project")));
  created.scopes += (await tx.insert(contextGraphNodeScopes).values({ nodeId: projectNode!.id, projectId: src.projectId }).onConflictDoNothing().returning()).length;

  // keyset paging over the connection's imported items. The page position is the timestamp's exact text: a JS Date
  // keeps milliseconds and Postgres microseconds, so a Date-based keyset would re-read the same rows forever.
  // the old cursor, exactly: re-read rows at or before it (the overlap) do not count toward `maxItems`, so a call that
  // resumes after a capped one always makes progress
  const [old] = await tx
    .select({ at: sql<string | null>`${contextGraphSources.cursorFirstSeenAt}::text`, id: contextGraphSources.cursorItemId })
    .from(contextGraphSources)
    .where(eq(contextGraphSources.id, src.id));
  const oldCursor = !args.full && old?.at && old.id ? { at: old.at, id: old.id } : null;
  let after: { at: string; id: string } | null = null;
  let scanned = 0;
  let past = 0;
  let more = false;
  for (;;) {
    const page: { id: string; at: string; past: boolean }[] = await tx
      .select({
        id: pmImportedWorkItems.id,
        at: sql<string>`${pmImportedWorkItems.firstSeenAt}::text`,
        past: oldCursor
          ? sql<boolean>`(${pmImportedWorkItems.firstSeenAt}, ${pmImportedWorkItems.id}) > (${oldCursor.at}::timestamptz, ${oldCursor.id}::uuid)`
          : sql<boolean>`true`,
      })
      .from(pmImportedWorkItems)
      .where(
        and(
          eq(pmImportedWorkItems.connectionId, src.pmConnectionId),
          // the overlap is computed on the database clock's own values, never the app's (mistakes.md)
          oldCursor
            ? sql`${pmImportedWorkItems.firstSeenAt} >= ${oldCursor.at}::timestamptz - make_interval(secs => ${CONTEXT_GRAPH_SYNC_OVERLAP_MS / 1000})`
            : undefined,
          after ? sql`(${pmImportedWorkItems.firstSeenAt}, ${pmImportedWorkItems.id}) > (${after.at}::timestamptz, ${after.id}::uuid)` : undefined,
        ),
      )
      .orderBy(pmImportedWorkItems.firstSeenAt, pmImportedWorkItems.id)
      .limit(pageSize);
    if (page.length === 0) break;
    scanned += page.length;
    past += page.filter((p) => p.past).length;
    const itemIds = page.map((p) => p.id);
    created.nodes += (
      await tx
        .insert(contextGraphNodes)
        .values(itemIds.map((pmImportedWorkItemId) => ({ sourceId: src.id, kind: "pm_work_item" as const, pmImportedWorkItemId })))
        .onConflictDoNothing()
        .returning({ id: contextGraphNodes.id })
    ).length;
    const nodes = await tx
      .select({ id: contextGraphNodes.id })
      .from(contextGraphNodes)
      .where(and(eq(contextGraphNodes.sourceId, src.id), inArray(contextGraphNodes.pmImportedWorkItemId, itemIds)));
    if (nodes.length) {
      created.scopes += (
        await tx.insert(contextGraphNodeScopes).values(nodes.map((n) => ({ nodeId: n.id, projectId: src.projectId }))).onConflictDoNothing().returning()
      ).length;
      created.edges += (
        await tx
          .insert(contextGraphEdges)
          .values(nodes.map((n) => ({ fromNodeId: projectNode!.id, toNodeId: n.id, kind: "contains" as const })))
          .onConflictDoNothing()
          .returning({ id: contextGraphEdges.id })
      ).length;
    }
    const last: { id: string; at: string } = page[page.length - 1]!;
    after = { at: last.at, id: last.id };
    if (page.length < pageSize) break;
    if (past >= maxItems) {
      more = true;
      break;
    }
  }

  // slice 2: the work-item-to-run edges from pm_links, after the item nodes this pass created exist
  const runs = await projectRunLinks(tx, src, Boolean(args.full));

  // The cursor is the last item read (rows come in order, and the read starts at or before the old cursor, so this
  // never skips an unread item); a call that stopped early keeps exactly its place. Nothing read: unchanged.
  await tx
    .update(contextGraphSources)
    .set(
      after
        ? { cursorFirstSeenAt: sql`${after.at}::timestamptz`, cursorItemId: after.id, lastSyncedAt: sql`now()` }
        : { lastSyncedAt: sql`now()` },
    )
    .where(eq(contextGraphSources.id, src.id));
  const [now] = await tx
    .select({ at: sql<string | null>`${contextGraphSources.cursorFirstSeenAt}::text`, id: contextGraphSources.cursorItemId })
    .from(contextGraphSources)
    .where(eq(contextGraphSources.id, src.id));
  const cursor = now?.at && now.id ? { at: now.at, id: now.id } : null;
  await tx.insert(auditLog).values({
    userId: args.actorUserId,
    objectType: "context_graph_source",
    objectId: src.id,
    detail: { subsystem: "context-graph", pmConnectionId: src.pmConnectionId, projectId: src.projectId, full: Boolean(args.full), scanned, created, runs, more },
    effect: "allow",
    ruleId: "context-graph-synced",
    ruleChain: [],
    reason: `context graph source ${src.id} synced${args.full ? " (full)" : ""}: ${scanned} item(s) read, ${created.nodes} node(s), ${created.edges} edge(s), ${created.scopes} scope row(s) created; runs: ${runs.runNodes} node(s), ${runs.tracks} edge(s) created, ${runs.removedEdges} stale edge(s) removed${more ? "; more remain" : ""}`,
  });
  return {
    ok: true,
    sourceId: src.id,
    created,
    scanned,
    runs,
    more,
    cursor: cursor ? { firstSeenAt: new Date(cursor.at).toISOString(), itemId: cursor.id } : null,
  };
}

export interface RunLinkResult {
  runNodes: number;
  tracks: number;
  removedEdges: number;
  removedNodes: number;
}

/**
 * ADR-0365 slice 2: project the source's live `pm_links` rows that tie one of its work items to an orchestration run
 * (`run`, or `run_node` of that run) into a run node and a `tracks` edge from the work item.
 *
 * - The run node carries the source's project scope AND a user scope naming the run's initiator: a run is visible to
 *   its initiator and admins only (orchestration.ts), so a member of the project who did not start it never sees it,
 *   nor the edge to it.
 * - Incremental: links created since `links_synced_at` minus the overlap, plus every link of a work-item node this
 *   pass created (a link can predate the item's import). Full: every link, and edges whose link is gone or orphaned
 *   are removed, with run nodes left without an edge. Both are idempotent (ON CONFLICT DO NOTHING).
 * - Runs as the caller's transaction and scope (an admin route, or the scheduler's `system_task`).
 */
async function projectRunLinks(tx: Db, src: { id: string; pmConnectionId: string; projectId: string; linksSyncedAt: Date | null }, full: boolean): Promise<RunLinkResult> {
  const overlapSecs = CONTEXT_GRAPH_SYNC_OVERLAP_MS / 1000;
  const windowSql =
    full || !src.linksSyncedAt
      ? sql`true`
      : sql`(l.created_at >= (SELECT s.links_synced_at FROM context_graph_sources s WHERE s.id = ${src.id}::uuid) - make_interval(secs => ${overlapSecs})
             OR wn.created_at >= now())`;
  // the live run links of this source's work-item nodes (a run_node link names its run in object_id)
  const linkedFrom = sql`
    FROM pm_links l
    JOIN pm_imported_work_items w ON w.connection_id = l.connection_id AND w.external_id = l.external_id
    JOIN context_graph_nodes wn ON wn.pm_imported_work_item_id = w.id AND wn.source_id = ${src.id}::uuid
    JOIN orchestration_runs r ON r.id = l.object_id`;
  const linkedWhere = sql`
    WHERE l.connection_id = ${src.pmConnectionId}::uuid AND l.object_type IN ('run', 'run_node') AND l.orphaned_at IS NULL`;
  const runNodes = await tx.execute(sql`
    INSERT INTO context_graph_nodes (source_id, kind, orchestration_run_id)
    SELECT DISTINCT ${src.id}::uuid, 'orchestration_run', r.id ${linkedFrom} ${linkedWhere} AND ${windowSql}
    ON CONFLICT DO NOTHING RETURNING id`);
  // every run node of the source carries the project scope and its run's initiator (cheap: one row each, idempotent)
  await tx.execute(sql`
    INSERT INTO context_graph_node_scopes (node_id, project_id)
    SELECT n.id, ${src.projectId}::uuid FROM context_graph_nodes n
    WHERE n.source_id = ${src.id}::uuid AND n.kind = 'orchestration_run'
    ON CONFLICT DO NOTHING`);
  await tx.execute(sql`
    INSERT INTO context_graph_node_user_scopes (node_id, user_id)
    SELECT n.id, r.initiating_user_id FROM context_graph_nodes n
    JOIN orchestration_runs r ON r.id = n.orchestration_run_id
    JOIN users u ON u.id = r.initiating_user_id
    WHERE n.source_id = ${src.id}::uuid AND n.kind = 'orchestration_run'
    ON CONFLICT DO NOTHING`);
  const tracks = await tx.execute(sql`
    INSERT INTO context_graph_edges (from_node_id, to_node_id, kind)
    SELECT DISTINCT wn.id, rn.id, 'tracks' ${linkedFrom}
    JOIN context_graph_nodes rn ON rn.source_id = ${src.id}::uuid AND rn.orchestration_run_id = r.id
    ${linkedWhere} AND ${windowSql}
    ON CONFLICT DO NOTHING RETURNING id`);
  let removedEdges = 0;
  let removedNodes = 0;
  if (full) {
    const gone = await tx.execute(sql`
      DELETE FROM context_graph_edges e
      USING context_graph_nodes wn, context_graph_nodes rn
      WHERE e.kind = 'tracks' AND wn.id = e.from_node_id AND rn.id = e.to_node_id AND wn.source_id = ${src.id}::uuid
        AND NOT EXISTS (
          SELECT 1 FROM pm_links l JOIN pm_imported_work_items w ON w.connection_id = l.connection_id AND w.external_id = l.external_id
          WHERE l.connection_id = ${src.pmConnectionId}::uuid AND l.object_type IN ('run', 'run_node') AND l.orphaned_at IS NULL
            AND w.id = wn.pm_imported_work_item_id AND l.object_id = rn.orchestration_run_id)
      RETURNING e.id`);
    removedEdges = gone.rows.length;
    const lonely = await tx.execute(sql`
      DELETE FROM context_graph_nodes n
      WHERE n.source_id = ${src.id}::uuid AND n.kind = 'orchestration_run'
        AND NOT EXISTS (SELECT 1 FROM context_graph_edges e WHERE e.to_node_id = n.id)
      RETURNING n.id`);
    removedNodes = lonely.rows.length;
  }
  await tx.update(contextGraphSources).set({ linksSyncedAt: sql`now()` }).where(eq(contextGraphSources.id, src.id));
  return { runNodes: runNodes.rows.length, tracks: tracks.rows.length, removedEdges, removedNodes };
}

/**
 * Move every node of a source to the source's current project (after a rebinding), in the caller's transaction: scope
 * rows for any other project are removed and the current one is added, so the old project's members lose sight at
 * once. Returns how many scope rows were removed.
 */
export async function rescopeContextGraphSource(tx: Db, sourceId: string, projectId: string): Promise<number> {
  const nodeIds = tx.select({ id: contextGraphNodes.id }).from(contextGraphNodes).where(eq(contextGraphNodes.sourceId, sourceId));
  const removed = await tx
    .delete(contextGraphNodeScopes)
    .where(and(inArray(contextGraphNodeScopes.nodeId, nodeIds), ne(contextGraphNodeScopes.projectId, projectId)))
    .returning();
  await tx.execute(sql`
    INSERT INTO context_graph_node_scopes (node_id, project_id)
    SELECT n.id, ${projectId}::uuid FROM context_graph_nodes n WHERE n.source_id = ${sourceId}::uuid
    ON CONFLICT DO NOTHING`);
  return removed.length;
}

export interface GraphNodeView {
  id: string;
  kind: "pm_project" | "pm_work_item" | "orchestration_run" | "git_repository" | "git_pull_request";
  /** the PM source, or for a git node (slice 3) its git source */
  sourceId: string;
  /** the PM project, work item id or run name; a git repository's full name, or a pull request's title */
  label: string;
  provider: string;
  externalUrl: string | null;
  itemType: string | null;
  /** slice 3: a pull request's state (open, merged, closed); null for every other kind */
  state: string | null;
  missing: boolean;
  createdAt: string;
}

// The git facts (slice 3) are joined like the PM ones: under `context_graph_read` the fact tables open only the rows a
// readable node refers to, so a LEFT JOIN never reaches an unreadable repository or pull request.
const NODE_SELECT = sql`
  SELECT n.id, n.kind, coalesce(n.source_id, gr.git_source_id) AS source_id, n.created_at,
         CASE n.kind WHEN 'pm_project' THEN c.project WHEN 'orchestration_run' THEN coalesce(o.name, 'run')
           WHEN 'git_repository' THEN gr.full_name WHEN 'git_pull_request' THEN gp.title ELSE w.external_id END AS label,
         coalesce(c.provider, CASE ds.kind WHEN 'repo_github' THEN 'github' WHEN 'repo_gitlab' THEN 'gitlab'
           WHEN 'repo_bitbucket' THEN 'bitbucket' WHEN 'repo_azure_devops' THEN 'azure_devops' END, 'git') AS provider,
         coalesce(w.external_url, gp.url) AS external_url, w.item_type, gp.state,
         (coalesce(w.missing_since, CASE n.kind WHEN 'git_pull_request' THEN gp.missing_since ELSE gr.missing_since END) IS NOT NULL) AS missing
  FROM context_graph_nodes n
  LEFT JOIN context_graph_sources s ON s.id = n.source_id
  LEFT JOIN pm_connections c ON c.id = s.pm_connection_id
  LEFT JOIN pm_imported_work_items w ON w.id = n.pm_imported_work_item_id
  LEFT JOIN orchestration_runs o ON o.id = n.orchestration_run_id
  LEFT JOIN context_graph_git_pull_requests gp ON gp.id = n.git_pull_request_id
  LEFT JOIN context_graph_git_repositories gr ON gr.id = coalesce(n.git_repository_id, gp.repository_id)
  LEFT JOIN context_graph_git_sources gs ON gs.id = gr.git_source_id
  LEFT JOIN discovery_sources ds ON ds.id = gs.discovery_source_id`;

type NodeRow = {
  id: string;
  kind: GraphNodeView["kind"];
  source_id: string;
  created_at: Date | string;
  label: string;
  provider: string;
  external_url: string | null;
  item_type: string | null;
  state: string | null;
  missing: boolean;
};
const toView = (r: NodeRow): GraphNodeView => ({
  id: r.id,
  kind: r.kind,
  sourceId: r.source_id,
  label: r.label,
  provider: r.provider,
  externalUrl: r.external_url,
  itemType: r.item_type,
  state: r.state,
  missing: r.missing,
  createdAt: new Date(r.created_at).toISOString(),
});

/**
 * For a non-admin, start from the caller's own memberships (index `(project_id, node_id)`), so a member who can read
 * few nodes never makes the database test every node in the table; `nodeReadable` stays the final, conjunctive check.
 */
function candidateNodes(caller: GraphCaller): SQL {
  if (caller.isAdmin || !caller.userId) return sql``;
  return sql`AND n.id IN (SELECT s.node_id FROM context_graph_node_scopes s
    JOIN project_members m ON m.project_id = s.project_id WHERE m.user_id = ${caller.userId}::uuid)`;
}

/** A page of the nodes the caller may read, in id order. */
export async function listReadableNodes(
  db: Db,
  caller: GraphCaller,
  q: { kind?: GraphNodeView["kind"]; sourceId?: string; after?: string; limit: number },
): Promise<{ items: GraphNodeView[]; nextAfter: string | null }> {
  const r = await db.execute<NodeRow>(sql`${NODE_SELECT}
    WHERE ${nodeReadable(caller, sql.raw("n.id"))}
      ${candidateNodes(caller)}
      ${q.kind ? sql`AND n.kind = ${q.kind}` : sql``}
      ${q.sourceId ? sql`AND coalesce(n.source_id, gr.git_source_id) = ${q.sourceId}::uuid` : sql``}
      ${q.after ? sql`AND n.id > ${q.after}::uuid` : sql``}
    ORDER BY n.id
    LIMIT ${q.limit + 1}`);
  const items = r.rows.slice(0, q.limit).map(toView);
  return { items, nextAfter: r.rows.length > q.limit ? items[items.length - 1]!.id : null };
}

/** One node, or null when it does not exist OR the caller may not read it (the same answer: no existence leak). */
export async function readableNode(db: Db, caller: GraphCaller, nodeId: string): Promise<GraphNodeView | null> {
  const r = await db.execute<NodeRow>(sql`${NODE_SELECT} WHERE n.id = ${nodeId}::uuid AND ${nodeReadable(caller, sql.raw("n.id"))}`);
  return r.rows[0] ? toView(r.rows[0]) : null;
}

/**
 * The neighbourhood of a readable node up to `depth` hops, over readable nodes only: a node the caller cannot read is
 * never returned and never a hop, and an edge is returned only when both its ends are. Null when the start node is
 * not readable.
 */
export async function readableNeighbourhood(
  db: Db,
  caller: GraphCaller,
  nodeId: string,
  depth: number,
): Promise<{ node: GraphNodeView; nodes: GraphNodeView[]; edges: { id: string; fromNodeId: string; toNodeId: string; kind: string }[]; truncated: boolean } | null> {
  const node = await readableNode(db, caller, nodeId);
  if (!node) return null;
  const walk = await db.execute<{ node_id: string }>(sql`
    WITH RECURSIVE walk(node_id, depth) AS (
      SELECT ${nodeId}::uuid, 0
      UNION
      SELECT CASE WHEN e.from_node_id = w.node_id THEN e.to_node_id ELSE e.from_node_id END, w.depth + 1
      FROM walk w
      JOIN context_graph_edges e ON e.from_node_id = w.node_id OR e.to_node_id = w.node_id
      WHERE w.depth < ${depth}
        AND ${nodeReadable(caller, sql.raw("CASE WHEN e.from_node_id = w.node_id THEN e.to_node_id ELSE e.from_node_id END"))}
    )
    SELECT DISTINCT node_id FROM walk WHERE node_id <> ${nodeId}::uuid LIMIT ${CONTEXT_GRAPH_MAX_NEIGHBOURHOOD + 1}`);
  const truncated = walk.rows.length > CONTEXT_GRAPH_MAX_NEIGHBOURHOOD;
  const ids = walk.rows.slice(0, CONTEXT_GRAPH_MAX_NEIGHBOURHOOD).map((r) => r.node_id);
  const all = [nodeId, ...ids];
  const nodes = ids.length
    ? (await db.execute<NodeRow>(sql`${NODE_SELECT} WHERE n.id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}) AND ${nodeReadable(caller, sql.raw("n.id"))} ORDER BY n.id`)).rows.map(toView)
    : [];
  const inSet = sql.join(all.map((i) => sql`${i}::uuid`), sql`, `);
  const edges = await db.execute<{ id: string; from_node_id: string; to_node_id: string; kind: string }>(sql`
    SELECT e.id, e.from_node_id, e.to_node_id, e.kind FROM context_graph_edges e
    WHERE e.from_node_id IN (${inSet}) AND e.to_node_id IN (${inSet})
      AND ${nodeReadable(caller, sql.raw("e.from_node_id"))} AND ${nodeReadable(caller, sql.raw("e.to_node_id"))}
    ORDER BY e.id`);
  return {
    node,
    nodes,
    edges: edges.rows.map((e) => ({ id: e.id, fromNodeId: e.from_node_id, toNodeId: e.to_node_id, kind: e.kind })),
    truncated,
  };
}

// ---- ADR-0365 slice 2: the scheduled sync ---------------------------------------------------------------------------

export const CONTEXT_GRAPH_SYNC_JOB_NAME = "context-graph-sync";
export const CONTEXT_GRAPH_FULL_SYNC_JOB_NAME = "context-graph-full-sync";
/** the most sources one pass syncs (the least recently synced first); the rest wait for the next pass */
export const CONTEXT_GRAPH_SYNC_MAX_SOURCES = 200;
const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

export interface ContextGraphSweepResult {
  sources: number;
  synced: number;
  failed: { sourceId: string; error: string }[];
  scanned: number;
  more: number;
  /** slice 3: the bound git sources (each read from its provider, then written in one transaction) */
  git: { sources: number; synced: number; failed: { gitSourceId: string; error: string }[]; pullRequests: number };
}

/**
 * One pass over the bound sources, each in its own transaction (a failing source never blocks the rest, and its error
 * is reported, not swallowed). With no source bound (the default) it does nothing. Runs under the scheduler's
 * `system_task` scope; each source's audit row names the scheduler identity.
 */
export async function runContextGraphSyncSweep(
  db: Db,
  opts: { full: boolean; actorUserId?: string | null; maxSources?: number; git?: ContextGraphGitDeps },
): Promise<ContextGraphSweepResult> {
  const sources = await db
    .select({ id: contextGraphSources.id })
    .from(contextGraphSources)
    .orderBy(sql`${contextGraphSources.lastSyncedAt} ASC NULLS FIRST`, contextGraphSources.id)
    .limit(opts.maxSources ?? CONTEXT_GRAPH_SYNC_MAX_SOURCES);
  const out: ContextGraphSweepResult = { sources: sources.length, synced: 0, failed: [], scanned: 0, more: 0, git: { sources: 0, synced: 0, failed: [], pullRequests: 0 } };
  for (const { id } of sources) {
    try {
      const r = await db.transaction((tx) =>
        syncContextGraphSource(tx as unknown as Db, { sourceId: id, actorUserId: opts.actorUserId ?? NO_IDENTITY, full: opts.full }),
      );
      if (!r.ok) continue; // unbound between the list and the sync
      out.synced += 1;
      out.scanned += r.scanned;
      if (r.more) out.more += 1;
    } catch (e) {
      out.failed.push({ sourceId: id, error: e instanceof Error ? e.message.slice(0, 300) : "sync failed" });
    }
  }
  // slice 3: every bound git source, least recently synced first. A git sync is always a full listing (bounded), so the
  // hourly and the daily pass do the same; each source reads its provider first, then writes in its own transaction.
  const gitSources = await db
    .select({ id: contextGraphGitSources.id })
    .from(contextGraphGitSources)
    .orderBy(sql`${contextGraphGitSources.lastSyncedAt} ASC NULLS FIRST`, contextGraphGitSources.id)
    .limit(opts.maxSources ?? CONTEXT_GRAPH_SYNC_MAX_SOURCES);
  out.git.sources = gitSources.length;
  for (const { id } of gitSources) {
    try {
      const r = await syncContextGraphGitSource(db, { gitSourceId: id, actorUserId: opts.actorUserId ?? NO_IDENTITY, ...(opts.git ? { deps: opts.git } : {}) });
      if (r.ok) {
        out.git.synced += 1;
        out.git.pullRequests += r.pullRequests.read;
      } else if (r.status !== 404) {
        out.git.failed.push({ gitSourceId: id, error: `${r.error}: ${r.detail}`.slice(0, 300) });
      }
    } catch (e) {
      out.git.failed.push({ gitSourceId: id, error: e instanceof Error ? e.message.slice(0, 300) : "sync failed" });
    }
  }
  return out;
}

/** The two jobs: hourly incremental and daily full (the full pass also removes stale run edges). */
export function contextGraphJobDefinitions(opts: { dataKey?: string | undefined; git?: Omit<ContextGraphGitDeps, "dataKey"> } = {}): SchedulerJobDefinition[] {
  const git: ContextGraphGitDeps = { ...opts.git, dataKey: opts.dataKey };
  const job = (name: string, full: boolean, every: number, what: string): SchedulerJobDefinition => ({
    name,
    description: what,
    adr: "ADR-0365",
    defaultIntervalSeconds: every,
    run: async (ctx) => {
      const r = await runContextGraphSyncSweep(ctx.db, { full, actorUserId: ctx.actorUserId, git });
      const failed = [...r.failed.map((f) => f.sourceId), ...r.git.failed.map((f) => f.gitSourceId)];
      if (failed.length) throw new Error(`context graph sync failed for ${failed.length} source(s): ${failed.join(", ")}`);
      return { itemsProcessed: r.scanned + r.git.pullRequests, detail: { ...r } };
    },
  });
  return [
    job(
      CONTEXT_GRAPH_SYNC_JOB_NAME,
      false,
      3600,
      "Incrementally sync every bound context graph source (ADR-0365): new PM work items and new work-item-to-run links " +
        "since the last pass, re-read with a 10-minute overlap, and the mapped repositories and pull requests of every " +
        "bound git source (read only). With no source bound it does nothing.",
    ),
    job(
      CONTEXT_GRAPH_FULL_SYNC_JOB_NAME,
      true,
      24 * 3600,
      "Fully re-sync every bound context graph source (ADR-0365): every work item and run link, remove run edges " +
        "whose PM link is gone or orphaned, and the mapped repositories and pull requests of every bound git source " +
        "(read only). With no source bound it does nothing.",
    ),
  ];
}
