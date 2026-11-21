<!-- fold: state-recap -->
**2026-11-20 - lane E46, the live synced context graph, slice 1 ([ADR-0365](../decisions/0365-live-synced-context-graph.md), PENDING P2).**
- **Chosen:** graph in Postgres (node, edge and node-scope tables, recursive CTE) over Apache AGE (no Amazon RDS
  support), graphology (in memory, kept for later algorithms over an already-filtered subgraph) and a separate graph
  database (GPL/BSL or a second user model). Comparison recorded in the ADR.
- **Built:** migration `pending/shared_context_graph.sql` (numbered at merge), four 3NF tables under forced row-level
  security; an incremental, idempotent sync from PM imported work items (keyset cursor with a 10-minute overlap); an
  admin binding of a PM connection to one project (`settings_relax` step-up, audited); three read routes for any
  signed-in principal that return only nodes whose every scope project the caller belongs to (a hidden node is a 404).
  One new read-only RLS reason, `context_graph_read`. Eight API-only routes are known UI gaps.
- **Boundary with ADR-0316:** the graph stores references, never content, and never writes the context store;
  distillation never writes the graph.
