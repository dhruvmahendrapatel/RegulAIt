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

## Addendum — 2026-07-30 (all three deferrals cleared)

The deferrals cleanup shipped all three items above; none required a migration (everything rides
the run's JSONB):

- **B1 — measured per-node running total.** `RunBudget` gains `measuredPerNodeUsd:
  Record<string,number>`. `dispatchRunNode` accumulates each node's OWN provider-measured spend and
  applies the same first-crossing-escalate pattern used for the run cap, against
  `computeNodeBudgetCeiling(graph,nodeId)`, under a **distinct** sentinel
  `__nodebudget_measured__:<node>` and ruleId `node-budget-cap-measured` (escalated to
  `graph.escalationApproverUserId`). First crossing is allowed-but-escalated; the per-turn pre-gate
  blocks the next turn/dispatch; the /auto loop stops the pass on the crossing. Deciding the
  escalation (approve) lifts enforcement for the run; a flat no-cap run is byte-identical (no new
  approvals).

- **B2 — lead may suggest per-node caps at decompose.** `ProposalNode` + `decompositionPlanSchema`
  gain an optional `budgetCapUsd`; the planning prompt invites the lead to suggest one; it carries
  into the submittable graph (the kernel node schema already has `budgetCapUsd`) and is echoed
  through kernel validation. The New-Run editor gains a per-node "cap $" input. A suggestion can
  only ever TIGHTEN spend — the caller's per-run budget + transitive ceiling still govern, so a
  suggested cap grants no new authority.

- **B3 — per-node cap surfaced in the run UI.** The run-view node row renders a `cap $X` chip when
  a node has a `budgetCapUsd` / a transitive ceiling (reusing the existing badge classes), amber
  once measured (preferred) or estimated spend approaches the cap. `ui-theme.ts` was not touched.
