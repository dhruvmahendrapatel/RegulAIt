# ADR-0159: Remediation Proposals — Planned by Rule, Executed Only on Approval

Status: Accepted (implemented)
Date: 2026-10-02
Related: ADR-0157 (governance monitor), ADR-0147 (control links), ADR-0089
(agent ownership), ADR-0091 (SoD override — the decide-path pattern reused),
ADR-0056 (copilot proposes, never applies); ROADMAP §9 Phase 3 "Remediation agents"
Migration: 0125 (`remediation_proposals`)

## Context

Competitors market "remediation agents". The governance-safe core of that is
narrower than the marketing: a system that, for each alert, works out what
would clear it, and can carry out the parts that are mechanical — but only
after a human who is not the proposer approves the exact action.

## Decision

1. **A deterministic planner** (`packages/shared/src/remediation.ts`) maps
   each monitor rule to candidates. **Executable**: `link_control` (a pack
   control suggested for the risk's category, in an active pack, not yet
   linked — for `high_risk_without_control` and for the source risk of
   `use_case_inherited_high_risk`) and `assign_agent_owner` (the use case's
   active owner). **Guidance** (steps for a person, never executed): source
   re-assessment, halted-agent review, vendor assessment, model-card sign-off,
   coverage gap, author a control.
2. **A proposal must equal a current executable candidate** for its alert —
   the endpoint cannot carry an arbitrary control link or owner change under
   an alert's name (422 `not_a_current_candidate`).
3. **Approval is arm's-length, by name**: the proposer cannot name themselves
   (409 `approver_is_proposer`) and cannot decide it through delegation or
   admin override (403 `cannot_approve_own_remediation`, precheck keyed on
   the decider, as ADR-0091).
4. **Execution happens in the one decide path** (`approvals.objectType =
   remediation`, stage sentinel `__remediation__:<id>`) inside the decision's
   transaction, running the STORED kind+params. An execution that cannot
   proceed (risk gone, control no longer in an active pack, agent owned by
   someone else meanwhile) records `failed` with the reason; it never
   overwrites a human decision made since the proposal.
5. **After commit, the monitor re-evaluates** so a cleared condition resolves
   its alert immediately.
6. One pending proposal per identical action (partial unique index).
   Everything is audited (`remediation-proposed/applied/denied/failed`, plus
   the domain row the manual path writes, e.g. `risk-control-linked`).

## Consequences

- No model is in this loop; "agentic" here means computed, not generated.
  A model-drafted remediation plan would be a separate, labelled, optional
  layer — not a change to this one.
- Adding an executable kind = planner case + applier branch + CHECK
  constraint value; each needs its own failure modes written down.

## Tests

`packages/shared/src/remediation.test.ts` (5) and
`apps/gateway/src/zz-adr0159-remediation.test.ts` (4: planning, refusals,
self-decide refusal + approve executes + alert resolves, deny changes nothing).
