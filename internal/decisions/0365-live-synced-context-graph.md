# ADR-0365: A live synced context graph, filtered by the reader's own entitlements

- **Status**: Accepted (lane E46 brief, owner choice 2026-11-20; slice 1 built)
- **Date**: 2026-11-20
- **Index**: **Live context graph (pillar 4, PENDING P2), slice 1: node, edge and node-scope tables in Postgres (3NF, forced row-level security), an incremental sync from PM work items an admin binds to one project (a `settings_relax` step-up, audited), and a query API that returns only nodes whose every scope the caller can read; a hidden node is a 404. Graph-in-Postgres chosen over Apache AGE, graphology and a separate graph database. Boundary with ADR-0316: the graph indexes source-system objects and stores no content; distillation writes text into the context store and never into the graph.**
- **Backlog item**: PENDING P2 ("a live, synced context graph")
- **Built in**: lane E46, branch `builder/e46-context-graph` (slice 1)
- **Migration**: `pending/shared_context_graph.sql`, numbered at merge (ADR-0252)
- **Related**: ADR-0011 (Shared Projects and the context store), ADR-0054 and ADR-0289 (PM work-item importer),
  ADR-0234 (row-level security), ADR-0316 (session distillation), ADR-0337 (SaaS entitlement graph, a different
  graph: agents' vendor grants), ADR-0176 (open source first), ADR-0180 (secure by default), ADR-0200 (3NF, security
  checklist), ADR-0252 (merge-time numbering)

## Context

Shared Projects hold a governed context store (ADR-0011) with provenance, but nothing continuously brings the objects
of the source systems (work items, repositories, people, documents) into one graph an agent can query. PENDING P2
asks for that graph with three constraints: incremental sync from the existing integrations, every node and edge
carrying its source's access control, and queries filtered by the caller's own entitlements, so the graph never
widens what a user could already read.

Two facts shape slice 1:

- **PM work items are already imported as linkage only** (ADR-0289): `pm_imported_work_items` holds the external id,
  URL and item type of each item a connection's project contains, with first-seen, last-seen and missing-since times.
  Title, state and fields stay in the PM tool and are read through live (pillar 8). The table is admin-only under
  row-level security (ADR-0234); no non-admin path reads it today.
- **No per-user grant covers PM content.** Pillar 1's per-user grants cover agents, connectors and MCP tools. A PM
  connection is admin-managed deployment configuration. The per-user boundary that already exists for shared work is
  Shared Project membership (`project_members`, `requireRole`).

## Options compared (ADR-0176, owner build rules 2026-11-17)

| | Graph in Postgres (adjacency tables + recursive CTE) | Apache AGE (Postgres extension, openCypher) | graphology (in-process JS graph library) | A separate graph database |
|---|---|---|---|---|
| Licence | PostgreSQL (already shipped) | Apache-2.0 | MIT | Neo4j Community GPLv3, Memgraph BSL: excluded. NebulaGraph and Dgraph Apache-2.0 |
| Maintenance | the database we already run | active Apache project | active | varies |
| Air-gapped | yes | needs a custom Postgres image with the extension; not offered on Amazon RDS, so BYOC on AWS breaks | yes | one more service to ship, patch and back up in every mode |
| Per-user access control | row-level security on the same principal setting every table uses (ADR-0234), plus the application filter | label tables are ordinary tables, but Cypher plans read them through the extension; RLS on them is undocumented, so the filter would be ours to prove | none: the graph lives in memory, so it must be built per reader from rows already filtered | its own user model, unrelated to our principals; we would duplicate every grant into it |
| Transactional with audit and the source rows | yes (one transaction) | yes | no persistence | no (two systems) |
| Traversal and algorithms | recursive CTE, enough for neighbourhoods; no built-in algorithms | Cypher, strong | rich (shortest path, centrality, communities) | strong |

**Decision: graph in Postgres.** It is the only option where the entitlement filter is the same row-level security
the rest of the product already proves, inside the same transaction as the source rows and the audit row, in all
three deployment modes, with no new dependency. The ADR-0176 exception is not needed: we write tables and a query,
not a graph engine. **graphology stays the candidate for later algorithms** (ranking, communities) run in memory over
a subgraph that the database has already filtered for the reader; it never sees unfiltered rows. Apache AGE is
re-checked if Cypher becomes a requirement and a managed AWS Postgres offers it.

## Decision

### 1. Tables (third normal form, forced row-level security)

- `context_graph_sources`: one row per bound PM connection (`pm_connection_id`, unique) with the project whose
  members may read what it brings in (`project_id`), who bound it, and the sync cursor (`cursor_first_seen_at`,
  `cursor_item_id`, `last_synced_at`). Deleting the connection or the project removes the source and, by cascade,
  its nodes, edges and scopes.
- `context_graph_nodes`: `kind` is `pm_project` (one per source: the connection's PM project) or `pm_work_item`
  (one per imported item, `pm_imported_work_item_id` unique, cascade). **A node stores no copy of the source's
  facts**: the label, URL, type and missing state are joined from `pm_connections` and `pm_imported_work_items` at
  read, so the graph cannot go stale against them, and nothing PM-authoritative (title, state, fields) is stored,
  as pillar 8 requires.
- `context_graph_edges`: `from_node_id`, `to_node_id`, `kind` (`contains`: a PM project contains a work item),
  unique per triple, both ends cascade.
- `context_graph_node_scopes`: the node's access-control scope as a join table, `(node_id, project_id)`. **A reader
  must satisfy every scope row of a node (conjunctive), and a node with no scope row is visible to no one but an
  admin (fail closed).** Slice 1 writes one row per node, the source's project. A later source with item-level
  access (a private repository, a restricted PM area) adds rows; a reader then needs all of them, so adding a scope
  can only narrow.

### 2. Sync: incremental, from PM work items, idempotent

**Why PM before git:** the PM importer already persists exactly the incremental change set (new items by
`first_seen_at`, removals by `missing_since`, deletions by cascade), in our own database, under row-level security,
so the sync reads no vendor API and opens no new egress. Git has no item-level ingest today (`git_connections`
serves the workflow engine's PR path); a git source needs its own fetcher first. PM is also pillar 8's source of
truth for priority and acceptance criteria, which is what an agent most often needs to find.

`syncContextGraphSource` (one transaction, as the admin principal):
- ensures the source's `pm_project` node and its scope row;
- reads the connection's imported items with `(first_seen_at, id)` after the cursor **minus a 10-minute overlap**,
  in pages of 500, so an import that committed late with an earlier timestamp is still seen; inserts are
  `ON CONFLICT DO NOTHING`, so the overlap is harmless;
- creates each item's node, its scope row and its `contains` edge, advances the cursor, and writes one audit row
  (`context-graph-synced`, counts and cursor). A missing item keeps its node and reads as `missing` (joined);
  re-appearing needs no write. A full pass (`full: true`) starts from the beginning and also re-scopes every node to
  the source's current project, for use after a rebinding.

Triggered by an admin (`POST /v1/context-graph/sources/:sourceId/sync`). A scheduled job is a follow-up.

### 3. Binding is off by default and a relax (ADR-0180)

No source exists until an admin binds one: `POST /v1/context-graph/sources` with `{ pmConnectionId, projectId }`
is a `settings_relax` step-up (`op: context_graph_source_bind`), because it lets that project's members see the
connection's work-item linkage, which only admins see today. Binding, rebinding (`PATCH`, same step-up), unbinding
(`DELETE`) and each sync are audited. An archived project cannot be bound.

### 4. Queries are filtered by the caller's own entitlements

- `GET /v1/context-graph/nodes` (any signed-in principal): pages of nodes the caller may read, optionally by
  `kind` or `sourceId`, with the joined facts.
- `GET /v1/context-graph/nodes/:nodeId` and `GET /v1/context-graph/nodes/:nodeId/neighbours?depth=1|2`: a node the
  caller may not read is a **404, the same as a missing one** (no existence leak). A neighbourhood returns only edges
  whose two ends the caller may read; a hidden node is never a hop (the recursive walk is over readable nodes only).
- **Readable** = an active admin, or a principal who is a member (any role) of the project of **every** scope row of
  the node, and the node has at least one. The rule is one SQL predicate used by the routes, and the same predicate
  is the row-level security policy (`regulait_context_graph_node_readable`), so a route that forgets the filter
  still returns nothing it should not. The bootstrap token reads as an admin, as on every other admin-readable table.
- Per-user tool grants (pillar 1) still decide what an agent may do with what it reads: the graph is read through
  these routes as the user, so an agent acting for a user sees what that user sees and no more.

### 5. Boundary with ADR-0316 (session distillation, lane E4)

- **The context store holds content; the graph holds references.** ADR-0316 writes distilled session text as a
  revision of `project_context_items`, through the one context write path. The graph stores no text and never
  writes `project_context_items`; distillation never writes graph rows.
- **No shared tables, no shared write path.** Each keeps its own reader check: ADR-0316's lineage check for a
  distilled revision, this ADR's scope predicate for a node.
- **Later joins, named now so neither side widens the other.** (a) If the graph gains a `context_item` node for a
  shared-context revision, that node is readable only when both this ADR's scopes and ADR-0316 §6's distilled-
  revision check allow it. (b) If a distillation ever reads graph nodes as input, ADR-0316 §6's closed allow-list
  ("fail closed on unknown sources") must add them as gating inputs in the same change, so a reader sees the
  distilled text only while they can read every node it came from.

## Consequences

- Project members can find their project's PM work items, and an agent acting for them can walk from a project to
  its items, without any widening: no member reads anything unless an admin bound the connection to their project.
- Labels are identifiers (the PM project name, an item's external id and type); titles stay in the PM tool. A
  read-through of titles via the existing PM adapters is a follow-up.
- **Follow-ups (PENDING P2):** a scheduled sync; a git source (repositories and PRs, with per-repository scope rows);
  identity and connector sources; edges from work items to RegulAIt runs (`pm_links`); a UI (the routes are known UI
  gaps); provenance and retention by the compliance cascade.
- New routes: five admin, three for any signed-in principal; all API-only in slice 1 and listed as known UI gaps.
