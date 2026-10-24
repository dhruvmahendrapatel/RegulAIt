# ADR-0164: Monitor Rule — Approved Use-Case Traffic Served Outside Its Approved Stack

Status: Accepted (implemented)
Date: 2026-10-02
Related: ADR-0157 (governance monitor), ADR-0159 (remediation), ADR-0161
(deploy gate), ADR-0163 (finding recorded), ADR-0029/0066 (routing, pillar 6)
Migration: none

## Context

ADR-0163 recorded a product finding: right-size routing (pillar 6) served
calls made to an approved use case's agent from a cheaper agent that the use
case's approval does not name. Nothing reported it. The approval covered the
stack the reviewers saw; the traffic ran on another one. Changing routing
behaviour is an owner decision (it trades pillar-6 savings for containment)
and is not taken here. Detecting it is not a trade-off.

## Decision

1. **New monitor rule `use_case_served_outside_stack` (high).** For each
   APPROVED use case, the monitor reads the usage ledger (`usage_events`,
   which stamps both `requested_agent_id` and the served `agent_id` on every
   dispatch) over the trace-evaluation window (7 days): dispatches requested
   for an agent in `intended_agent_ids` and served by an agent outside it.
   One alert per (use case, serving agent), subject
   `use_case:<id>>agent:<served>`, naming the requested agents and the
   measured call count.
2. **Detection only.** No routing rule, dispatch path or entitlement reads
   it. Because it is an ordinary open high alert on the use case, the
   ADR-0161 deploy gate blocks that use case's pipeline until it is
   acknowledged or cleared — the existing alert semantics, not a new control.
3. **Remediation is guidance** (`contain_routing`, ADR-0159): pin the use
   case's traffic (`costSensitivity: quality-sensitive` or a routing-rule
   exclusion) or amend the use case to include the serving agent and re-review.
   Both are deliberate human decisions.
4. **Resolves** when a window passes with no off-stack dispatch.
5. **`demo:traffic`** pins its routine calls (as a team pins production
   traffic) and sends ONE unpinned `routed` call, so the Monitor beat shows a
   single deliberate off-stack finding instead of one per use case. Pinning
   also surfaced that MRM enforcement refuses the demo's agents without an
   approved model card when routing does not move them — reported as it
   happens, consistent with their existing model-card alerts.

## Consequences

- The ADR-0163 gap (monitor blind to routed traffic) is visible as an alert;
  trace evaluation still attributes content flags to the SERVED agent.
- Follow-up candidates from ADR-0163 stand: a routing guard that keeps a use
  case's traffic in its approved stack (owner decision), and use-case
  attribution of traces.

## Tests

`packages/shared/src/governance-monitor.test.ts` and `remediation.test.ts`
(pure); `apps/gateway/src/zz-adr0164-off-stack.test.ts` (real database:
on-stack, unrelated-agent and out-of-window dispatches raise nothing; two
off-stack dispatches raise one high alert with the measured count; guidance
only; the deploy gate denies; resolves when the window clears).
`demo:prepare` on an empty database: 17/17 PASS.
