<!-- fold: state-recap -->
**2026-11-21 - lane E46, context graph slice 2: scheduled sync and run edges ([ADR-0365](../decisions/0365-live-synced-context-graph.md), amended).**
- **Scheduled sync:** `context-graph-sync` (hourly, incremental) and `context-graph-full-sync` (daily, full) run the
  slice 1 sync over every bound source under `system_task`, one transaction per source. With no source bound they do
  nothing.
- **Run edges:** a live `pm_links` run or run-node link of a bound work item becomes an `orchestration_run` node and a
  `tracks` edge. The full pass removes edges whose link is gone or orphaned.
- **Access:** a run node carries a new user scope, the run's initiator, so other members of the project never see it
  or its edge; admins do. Migration `pending/shared_context_graph_runs.sql`, numbered at merge. No new routes or RLS
  reasons.
