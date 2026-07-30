# ADR-0016 — Team-Lead transitive per-node budget ceiling (§5.2)

- **Status:** Accepted
- **Date:** 2026-07-30
- **Deciders:** user (in-session), Claude
- **Relates:** pillar 7 (MULTI_AGENT_ORCHESTRATION_SPEC §5); complements the §5.1
  agent/tool lead ceiling (`computeNodeCeiling`) already shipped.

## Context

Pillar 7's "well-run team" delegation says a Team-Lead can hand each worker a **subset of
grants + a sub-budget**, and a worker must never exceed what the initiating user (or a lead
above it) allows. The **agent/tool** half already existed: a node's `allowedAgentIds`/
`allowedToolRefs` form a ceiling that `computeNodeCeiling` intersects transitively up the
`leadNodeId` chain, enforced by the policy kernel (`agent-lead-ceiling`). The **budget** half
did not — the only hard cap was the run-level `capUsd`; per-node figures were estimates, not
enforced ceilings.

## Decision

Add a per-node **`budgetCapUsd`** to the task-node schema and a pure
`computeNodeBudgetCeiling(graph, nodeId)` that folds the **MIN** of the node's own cap and every
lead ancestor's cap. It is enforced at `node_started` in `gateNodeStartBudget`, **on top of** the
run-level cap: a node whose estimated cost exceeds its ceiling pauses and escalates into the same
one Approvals Queue (`ruleId: node-budget-cap`, stage `__nodebudget__:<node>`), decided by the
graph's escalation approver.

The invariant is symmetric with §5.1: **delegation can only ever tighten** — for agents it is a
set intersection that can only shrink; for budget it is a MIN that can only lower. A worker under
a lead capped at $1 is capped at $1 even if its own node names a looser $50. Absent caps →
`null` → only the run cap applies, so flat runs are byte-identical to before.

## Consequences

- **Positive:** completes the "subset of grants + a sub-budget" delegation story; reuses the
  exact ceiling shape as §5.1 (pure kernel helper + single gateway enforcement site); no
  migration (nodes/budget live in the run's JSONB); default-safe (over-cap escalates, never
  silently overspends).
- **Deferred:** letting the decompose LLM lead *suggest* per-node caps (the `ProposalNode` schema);
  a measured (not just estimate) per-node running total; UI surfacing of the per-node cap on the
  run detail.
