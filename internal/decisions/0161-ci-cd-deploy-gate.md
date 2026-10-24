# ADR-0161: A CI/CD Deploy Gate Over Existing Governance State

Status: Accepted (implemented)
Date: 2026-10-02
Related: ADR-0080 (use-case approval), ADR-0045 (MRM gate), ADR-0124 (halts),
ADR-0157 (monitor alerts); ROADMAP §9 Phase 2 "Enforcement integration with
CI/CD, CASBs, API gateways"
Migration: none

## Context

Governance decisions (use-case approval, halts, MRM sign-off, open alerts)
are enforced at dispatch. A release pipeline learned about them only when
the shipped system was refused at runtime. Pipelines need the same answer
before they ship, without a second policy store that can drift.

## Decision

1. **`POST /v1/gates/deploy {useCaseId, agentIds?, environment?, ref?}`** →
   `{decision: allow|deny, reasons[{code, severity: block|warn, message, ref}], …}`.
   Always 200 for a known use case; the pipeline acts on `decision`.
   **What `agentIds` means is defined by the AER-044 amendment at the end of this file**
   (2026-10-03): it never narrows the check.
2. **Blocks**: use case not approved; an agent outside its approved stack;
   an agent halted/disabled/not active; the MRM gate's decision refuses the
   agent (when enforced); an OPEN high-severity monitor alert on the use case
   or its agents. **Warns**: no approved model card while MRM is not
   enforced; an ACKNOWLEDGED high alert; an open medium alert.
3. **No second policy store**: every input is existing state; the pure
   evaluator (`packages/shared/src/deploy-gate.ts`) only combines them.
4. **MRM decision without dispatch side effects**: the gate evaluates
   `evaluateMrmGate` over the same card loading as the dispatch gate. The
   staleness-recertification deepening (which writes a dispatch-phase audit
   row) stays a runtime check.
5. **Who may ask**: an admin or the use case's owner — a pipeline runs as the
   service account that owns what it ships. Every evaluation is audited
   (`deploy-gate-allowed|denied`, objectType `deploy_gate`) with `ref` and
   `environment`, recorded verbatim and never interpreted.

## Usage (GitHub Actions)

```yaml
- name: RegulAIt deploy gate
  run: |
    res=$(curl -sf -X POST "$REGULAIT_URL/v1/gates/deploy" \
      -H "authorization: Bearer $REGULAIT_CI_KEY" -H "content-type: application/json" \
      -d "{\"useCaseId\":\"$USE_CASE_ID\",\"environment\":\"staging\",\"ref\":\"$GITHUB_SHA\"}")
    echo "$res" | jq -r '.reasons[] | "\(.severity): \(.message)"'
    test "$(echo "$res" | jq -r .decision)" = "allow"
```
The same call works from GitLab CI, Azure Pipelines or any runner.

## Consequences

- Dispatch enforcement is unchanged; the gate moves the answer earlier.
- CASB and API-gateway enforcement remain separate items (the Kong adapter
  exists; a CASB integration does not).

## Tests

`packages/shared/src/deploy-gate.test.ts` (4 at acceptance; 14 since the AER-044 amendment) and
`apps/gateway/src/zz-adr0161-deploy-gate.test.ts` (4); since 2026-10-03 also
`apps/gateway/src/zz-aer044-deploy-gate-selection.test.ts` (10).

## Amendment 2026-10-03 — `agentIds` declares what ships, it never narrows the check (AER-044)

Decision §1 named `agentIds?` without saying what it does, and the code read it as a *replacement*
for the approved stack: the route used `b.agentIds ?? intended` and the evaluator
`requestedAgentIds ?? intendedAgentIds`. An explicit `agentIds: []` is not nullish, so it checked
**zero** agents and allowed; a subset checked only the subset, so a halted, disabled or
MRM-refused intended agent left out of the request never reached the gate. A pipeline could
launder exactly the refusals this gate exists to report by how it phrased the request (Codex
review, AER-044).

**The contract, stated once:** a selection can only add to what is checked, never narrow it.
The gate always evaluates the use case's whole approved stack (`intendedAgentIds`) plus any
requested extras, deduplicated, intended first. Omitted, `[]` and a subset are therefore
equivalent for intended agents; a requested agent outside the stack still blocks as
`agent_not_in_approved_stack`. `[]` is not rejected with a 400: under the union rule it is
harmless and equal to omission, which is what every existing caller relies on.

- **Shared evaluator** (`ec68ebc`): `checked = unique([...intendedAgentIds, ...(requestedAgentIds ?? [])])`.
- **Route** (`4f7516b`): agents, MRM decisions and monitor alerts are loaded for the same union, so a
  subset request now also picks up open or acknowledged alerts on intended agents it left out.
  The response gains `agentsRequested` (the request's `agentIds`, or `null` when omitted) beside
  `agentsChecked`; the `deploy_gate` audit detail gains `requestedAgents` beside `agents` (the
  checked set). No schema change, no migration.
- **Callers unchanged:** `demo-gate-lib.ts`, `demo-check-lib.ts`, the Usage example above and
  `zz-adr0164` all omit `agentIds`, and for an omitted list the checked set is what it was, so the
  demo's `demo:gate` beat keeps its DENY.

**Evidence.** `deploy-gate.test.ts` 14 (10 new: omitted, empty and subset, each against a halted,
an MRM-refused and a clean stack, plus an off-stack dedup case); `zz-aer044-deploy-gate-selection.test.ts`
10, each asserting the verdict and its `deploy-gate-allowed|denied` audit row with
`requestedAgents`. Negative controls: the pre-fix evaluator fails 7 of 14 (every empty and subset
case and the dedup case; the omitted cases were already right and stay as regression guards);
the pre-fix route fails 10 of 10 (empty and subset on the verdict, omitted on the new fields).

**Honest limit (pre-existing, outside AER-044).** An approved use case whose intended stack is
empty checks zero agents and allows when no agent is named; naming any agent blocks it as
off-stack, so the selection cannot be used to bypass anything. A `no_intended_agents` block or
warn reason is an optional follow-up, not decided here.
