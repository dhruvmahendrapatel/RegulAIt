<!-- fold: pending -->
- **P2 context graph follow-ups after slice 3 (ADR-0365, lane E46):** the git source is built (branch
  `builder/e46-context-graph-git`, stacked on #1158; no PR until #1158 merges). Still open:
  - the admin screen for git sources and repository mappings, with the slice 1 bindings screen and the member graph
    view (#453);
  - edges between pull requests and PM work items or runs (for example from `pm_links` or a PR's linked work item);
  - a read policy on `discovery_sources` under `context_graph_read` if a later ADR-0234 batch forces that table (the
    node read joins it for the provider name);
  - identity and connector sources; workflow-instance edges; a live title read-through via the PM adapters;
    provenance and retention by the compliance cascade.
