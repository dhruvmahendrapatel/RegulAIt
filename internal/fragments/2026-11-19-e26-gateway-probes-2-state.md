<!-- fold: state-recap -->
**2026-11-19 - lane E26, agent-risk proofs, slice 2c part 2 ([ADR-0345](../decisions/0345-agent-risk-control-proof-registry.md)).**
All eight gateway probes now run. The last three are:
- replaying a spent approval and presenting an expired one, through the live consume path, on sandbox records in a
  transaction that always rolls back;
- the worker loop cap, through `workerTurnCap`, now the single function that bounds the dispatch loop.

A deployment with fewer than two active admins records the approval probes as `not_run` rather than fake a
self-approval. No new tables, migrations or routes.
