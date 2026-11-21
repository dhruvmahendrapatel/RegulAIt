# ADR-0365: A live synced context graph, filtered by the reader's own entitlements

- **Status**: Accepted (lane E46 brief, owner choice 2026-11-20; slice 1 built). Amended 2026-11-21 (owner-approved
  backlog slice): slice 2, the scheduled sync and the work-item-to-run edges
- **Date**: 2026-11-20
- **Index**: **Live context graph (pillar 4, PENDING P2), slice 1: node, edge and node-scope tables in Postgres (3NF, forced row-level security), an incremental sync from PM work items an admin binds to one project (a `settings_relax` step-up, audited), and a query API that returns only nodes whose every scope the caller can read; a hidden node is a 404. Graph-in-Postgres chosen over Apache AGE, graphology and a separate graph database. Boundary with ADR-0316: the graph indexes source-system objects and stores no content; distillation writes text into the context store and never into the graph.**
- **Backlog item**: PENDING P2 ("a live, synced context graph")
- **Built in**: lane E46, branch `builder/e46-context-graph` (slice 1)
- **Migration**: `pending/shared_context_graph.sql` (slice 1) and `pending/shared_context_graph_runs.sql` (slice 2),
  numbered at merge (ADR-0252)
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
- **Readable** = an active admin, or an active principal who is a member (any role) of the project of **every**
  scope row of the node, and the node has at least one. The rule is one SQL predicate used by the routes, and the same predicate
  is the row-level security policy (`regulait_context_graph_node_readable`), so a route that forgets the filter
  still returns nothing it should not. The bootstrap token reads as an admin, as on every other admin-readable table.
- **One new system reason, read only.** A node's joined facts live in admin-only tables (`context_graph_sources`,
  `pm_connections`, `pm_imported_work_items`, ADR-0234). The three read routes run as a `context_graph_read`
  principal step (the `pm_sync` pattern): it adds SELECT on those three tables and nothing else, and it does not widen
  nodes or edges, which stay under the principal's own readable policy. Each of those SELECT policies follows the
  readable rule too (security review of #1092, S4 finding 1): a source, PM connection or imported item is visible only
  when a node the principal may read refers to it, so an unbound connection (and its ciphertext columns) is never
  reachable, even from a later route that forgets the filter. Under the same step a principal reads the scope rows of
  its own projects only, so the node list starts from the caller's memberships (index `(project_id, node_id)`, code
  review R4 finding 1) instead of testing every node. No write is admitted under it. The reason is
  added to the closed registry in the migration and to `RLS_SYSTEM_REASONS`; a scratch-database test proves each
  claim with no application filter.
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
- New routes: five admin, three for any signed-in principal; all API-only in slice 1, listed as known UI gaps
  (`scripts/known-ui-gaps/adr-0365-e46-context-graph.json`), and the unbind DELETE is in the affordance preflight's
  API-only list until the screen lands.
- Not to be confused with `GET /v1/projects/:projectId/context/graph`, which draws the revision history of one
  project's context store; this graph indexes source-system objects across projects.
- **Known limit:** an import that commits more than 10 minutes after its own `first_seen_at` timestamp, behind a
  cursor that has already moved past it, is picked up only by a full pass. Imports are single transactions of
  seconds, so the window is generous; the scheduled job will run a full pass daily.

## Slice 2 (2026-11-21): the scheduled sync and the work-item-to-run edges

Owner-approved backlog slice (master, 2026-11-21), from the slice 1 follow-ups.

1. **Scheduled sync.** Two scheduler jobs run the slice 1 sync over every bound source, each source in its own
   transaction, least recently synced first, at most 200 sources a pass:
   - `context-graph-sync` every hour, incremental;
   - `context-graph-full-sync` every day, full, which also removes stale run edges.

   With no source bound (the default) both do nothing. Both run under the scheduler's `system_task` scope and write
   each source's audit row in the scheduler's name. A failing source fails the run, with the source named, and never
   blocks the others. The new policies admit `system_task` on the graph tables and, for SELECT only, on
   `pm_imported_work_items`. `pm_links` already admitted it (ADR-0234 PM batch).
2. **Edges from work items to runs.** A live `pm_links` row of kind `run`, or `run_node` of that run, whose external id
   is a bound work item becomes:
   - one `orchestration_run` node per source and run (a foreign key to the run, cascading);
   - one `tracks` edge from the work item.

   Incremental passes read links created since `links_synced_at`, minus the same 10-minute overlap, plus every link of
   a work-item node the pass created, because a link can predate the item's import. The full pass reads all links,
   and removes edges whose link is gone or orphaned and run nodes left with no edge.
3. **A second access scope, by user.** A run is visible to its initiator and admins only (`loadRunFor`). A project
   scope alone would show it to every project member, so a run node also gets a row in
   `context_graph_node_user_scopes` naming the run's initiator.
   - When a node has user scopes, the reader must be one of them, on top of every project scope.
   - The readable function still reads only the scope tables, so the node policy cannot recurse.
   - A pending approver of the run does not see it in the graph. The graph's read is stricter than the run screen's
     read-only widening.
4. **Boundary with ADR-0234 PM follow-on (#1144).** The sync reads `pm_links` under `system_task`. #1144 narrows
   `pm_sync`, not `system_task`, so the two compose. The graph does not reuse #1144's object-visibility helper: its
   own scope rows decide, and its rule for a run (initiator only) is no wider than that helper's write rule.

## Slice 3 (2026-11-21): a git source, with a project scope per repository

Owner-approved backlog slice (master, 2026-11-21), from the slice 1 follow-ups.

1. **The source is an existing discovery repo source (ADR-0195).** An admin binds a `repo_github`, `repo_gitlab`,
   `repo_bitbucket` or `repo_azure_devops` discovery source (`context_graph_git_sources`, one row per source).
   - No token is stored. The sync uses the discovery source's credential (stored read-only token, or federated), the
     egress-guarded fetch over the egress allow list, and the same reader-opening helper as the repo scanner
     (`openRepoReader`, now exported from `discovery-repo-scanner.ts`).
   - A credential that grants write is refused as a scan refuses it: the discovery credential moves to `refused`
     along the ADR-0336 transitions, the refusal is audited, and the source is never read again until replaced.
   - The discovery source's own gates apply: it must be enabled, and its family switch on.
2. **Per-repository scope rows, strict by default.** `context_graph_git_repo_mappings` maps (git source, repository
   full name) to a project.
   - A repository with no mapping is never projected: no fact row and no node exist for it. With nothing mapped a
     sync does not even list the repositories.
   - Names match case-insensitively (one mapping per name). A repo-level discovery source maps only the repositories
     its scope names.
   - Remapping re-scopes that repository's nodes in the same transaction, so the old project's members lose sight
     at once. Unmapping removes the facts and nodes (cascade from the mapping).
   - Binding and mapping are `settings_relax` step-ups; every change is audited (`context_graph_git_source`).
3. **Facts and nodes.** Two fact tables hold verbatim provider payloads, each column with its ADR-0200 exception
   comment: `context_graph_git_repositories` (default branch, archived, first/last seen, `missing_since`) and
   `context_graph_git_pull_requests` (number, title, state normalised to open / merged / closed, https URL only,
   provider times, first/last seen, `missing_since`).
   - **No author or other identity is stored or read into the summary** (secure and minimal).
   - Node kinds `git_repository` and `git_pull_request` reference their fact row by foreign key. Their `source_id`
     (the PM source) is NULL; the kind CHECK says which reference each kind carries.
   - A repository `contains` its pull requests. Every git node gets one project scope, its repository's mapping.
4. **Sync.** `RepoReader.listPullRequests` (GET only, every state, most recent first, at most 500 per repository) is
   added for all four providers. A sync lists the source's repositories (its namespace), keeps the mapped ones (at
   most 200 a sync), reads their pull requests, and only then writes everything in one transaction: no network call
   happens inside it.
   - A mapped repository or a pull request that a complete listing no longer has gets `missing_since`, cleared when
     it reappears. A capped listing marks nothing.
   - The two scheduler jobs also sync every bound git source (always a full, bounded listing) under `system_task`.
     An admin route syncs one source.
5. **Reads and row-level security.** The node read routes return git nodes with the joined facts (label: the
   repository name or pull request title; URL; state), filtered by the same readable predicate.
   - The readable function is unchanged and still reads only the scope tables.
   - Under `context_graph_read` the fact tables and the git source table open, for SELECT only, just the rows a
     readable node refers to. The mappings never open under it.
   - `system_task` writes the facts and reads, but never writes, the mappings. No new system reason.
6. **Routes and UI.** Seven admin routes, all API-only, listed as known UI gaps
   (`scripts/known-ui-gaps/adr-0365-e46-context-graph-git.json`); the two DELETE routes are in the affordance
   preflight's API-only list until the screen lands.

**As built.** The migration is `pending/shared_context_graph_slice3_git.sql`, named to sort after
`shared_context_graph_runs.sql` in byte order (a name `shared_context_graph_git.sql` would sort before it and have
its node kind CHECK replaced by slice 2's). The node read joins `discovery_sources` for the provider name; that table
has no row-level security today, and if a later ADR-0234 batch forces it, a git node's provider reads `git` until a
matching read policy is added.
