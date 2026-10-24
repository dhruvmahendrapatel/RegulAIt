# ADR-0078: Name and test the pillar-7 claim — a tighten-only delegation conformance suite + interop note

- **Status**: Accepted
- **Date**: 2026-08-15
- **Migration**: none — no schema or behaviour change; this ships a named conformance suite,
  a contract document, and verified interop claims over enforcement that already exists.
- **Driver**: [MARKET_ANALYSIS_2026-08.md](../product/MARKET_ANALYSIS_2026-08.md) §4 item 6 —
  package the existing ceilings (ADR-0016) as an asserted, documented invariant: "no worker
  exceeds the initiating user" as a runnable conformance check, plus an A2A/MCP interop note.
  Differentiation defense against the Agent 365 / AgentCore identity trajectory.
- **Extends**: [ADR-0016](0016-orchestration-kernel.md) (the delegation ceilings under test),
  [ADR-0021](0021-org-dials-and-ceilings.md) (the ceiling model), the pillar-7 execution-time
  attacks in `apps/gateway/src/pillar7-inheritance.test.ts` (not duplicated — extended).

## Context

The tighten-only lattice was fully enforced and partially tested, but scattered: agent-ceiling
narrowing in `orchestration-tools.test.ts`, budget MIN in `node-budget.test.ts`, revocation
races in `pillar7-inheritance.test.ts`. Nothing *named* the invariant as one contract, nothing
enumerated the dimension × level matrix systematically (so a skipped composition level could
hide in the gaps between files), and the market-facing claim — third-party agents inherit the
same ceiling through the gateway — had never been checked against what MCP and A2A actually
specify.

## Decision

1. **A named conformance suite** — `apps/gateway/src/delegation-conformance.test.ts` (12
   tests) — systematically enumerates the lattice: dimensions (agent allow-list, tool refs,
   budget cap) × levels (user grant, lead ceiling, nested-lead ceiling, run budget, node
   budget), asserting composition is INTERSECTION/MIN, never widening. The probe design makes
   every denial isolate exactly one level: each excluded member of the lattice is vetoed by
   only one level (only the grandparent excludes C, only the direct lead excludes A, only the
   grant level excludes D), with an allowed control (E / `dconf_beta` / a $4 MIN above a $3
   estimate) per dimension so a denial proves the lattice rather than general breakage
   (M-002). Three three-level chain proofs (agent reassign, tool call, budget MIN). RuleIds
   pin *which* level denied: `agent-lead-ceiling`/`lead-ceiling` vs `default-deny`. The
   no-widening surface is asserted directly: a smuggled `budget` key in the run payload is
   stripped and the policy's `capUsd` stands.
2. **The contract document** —
   [DELEGATION_CONFORMANCE.md](../product/DELEGATION_CONFORMANCE.md) — states the invariant as
   a checkable contract and pins every cell of the dimensions × levels table to a test name
   (citing companion files where a cell was already covered; structural n/a cells listed
   explicitly so the enumeration is visibly complete). Renaming a cited test is a spec change.
3. **Interop note, verified not asserted** (in the same document): MCP (rev 2025-06-18)
   defines resource-level OAuth only — no per-tool/per-user access control, no delegation
   semantics — so the ceiling has no wire representation and lives at our gateway choke
   point, which is exactly why third-party MCP tools inherit it with zero server cooperation.
   A2A (v1.0.0) names the authorization layer as implementation-specific and has no
   ceiling/composition/budget vocabulary; a remote A2A agent inherits our ceiling only when
   invoked through the gateway. Claims dated 2026-08-15; `modelcontextprotocol.io` and
   `a2a-protocol.org` are egress-blocked here and are named as unreachable — content was
   verified from the canonical `modelcontextprotocol/modelcontextprotocol` and
   `a2aproject/A2A` GitHub repositories instead.

## Bypass-proof evidence (M-002)

Each dimension's probes were shown to FAIL against a temporarily bypassed composition point,
then the bypass was reverted (all on 2026-08-15, scratch DB recreated per run):

| Bypass (temporary edit) | Result |
|---|---|
| `computeNodeCeiling` walk truncated after the direct lead | 3/12 failed — exactly the nested-level probes (agent reassign chain, agent plan-time chain, tool `dconf_gamma`) |
| `ceiling.toolRefs` → `null` at both dispatch-loop enforcement sites | 1/12 failed — the tool lattice (`dconf_alpha` executed instead of denying) |
| `computeNodeBudgetCeiling` ignoring every lead ancestor's cap | 2/12 failed — exactly the two lead-level budget probes |

Green run on the reverted tree: 12/12.

## Honest limits

- The suite proves the lattice at the gateway's enforcement points (plan, reassign, dispatch,
  worker tool calls, node start); it does not add new enforcement. A future surface that
  dispatches work without passing these points would need its own row in the table.
- The interop claim is about *our* choke point; neither MCP nor A2A can carry the constraint
  onward to sub-delegations a remote agent makes on its own authority, and RegulAIt has no
  native A2A adapter today — stated in the contract document.
- Structural n/a cells (budget levels × agent/tool identity) are declared, not tested — there
  is nothing to test; they exist so the enumeration is complete on its face.
