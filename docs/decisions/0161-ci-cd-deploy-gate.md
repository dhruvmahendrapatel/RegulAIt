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

`packages/shared/src/deploy-gate.test.ts` (4) and
`apps/gateway/src/zz-adr0161-deploy-gate.test.ts` (4).
