# ADR-0148: Trust Dashboard — Evidence Coverage by Dimension

Status: Accepted (implemented)
Date: 2026-10-01
Related: ADR-0082 (posture report), ADR-0058 (pack evaluator), ADR-0147
(trust dimensions, residual risk); demo task C1 in `AgentCoordination.md`
Migration: none

## Context

The intake demo's dashboard shows a six-axis radar (bias, security, privacy,
reliability, safety, compliance), risks found vs mitigated, a coverage
percentage and a likelihood × impact heatmap. Competitor dashboards show
per-axis percentages with no stated denominator. This product's rule
(ADR-0082) is that every number is recomputed from ledgers at request time,
an empty ledger is unmeasured, and coverage is never presented as compliance.

## Decision

`GET /v1/reports/trust[?projectId=]`, admin-only like the posture report:

- **Radar value = evidence coverage**, the posture report's `evidencedPct`
  sliced by dimension: controls satisfied by ledger evidence or a live
  attestation ÷ controls applicable, over active packs. Each control is
  classified to one dimension by `dimensionForControl` in
  `@regulait/shared` — explicit overrides for attestation-only controls, then
  the evidence collector and its parameters, then `compliance`. A dimension
  with no applicable control is `measured: false`, `evidenceCoveragePct:
  null`; the UI draws a gap, not a zero.
- **Mitigated** = closed, or live with ≥1 linked control *and* a declared
  residual position. Accepted risks are counted separately; a control link
  alone is not mitigation.
- **Heatmaps**: live risks by declared inherent position; the residual map
  moves a risk only when a residual is declared. Three-level declared scale,
  no arithmetic (ADR-0087).
- The payload carries a `definitions` block stating each of the above, so the
  meaning travels with the numbers.

## Consequences

- No default pack control evidences **bias**, so the bias axis is a gap on a
  default install. This is recorded by a test that must be changed on purpose
  when a fairness control ships. Follow-up (demo task C1b): add pack versions
  with a fairness control (EU AI Act Art. 10 bias examination, NIST MEASURE
  2.11) evidenced by documented model-card fairness assessments, and a safety
  control (NIST MEASURE 2.6) evidenced by toxicity/jailbreak guardrails.
- Pack activation is licence-gated (ADR-0052), so a dashboard on an
  unlicensed install shows every axis unmeasured — correct, and a demo setup
  step (the runbook sets the demo licence keyring).

## Verification

- `packages/shared/src/trust-dimensions.test.ts` 4/4: every override names a
  real control, every attestation-only default control is classified on
  purpose, collector rules, and the recorded five-of-six reach.
- `apps/gateway/src/zz-adr0148-trust-dashboard.test.ts` 4/4 on a fresh
  database: fixed axis order and gap rule; activating the EU AI Act pack
  measures compliance and reliability while bias stays a gap; admin-only and
  unknown-project 404; mitigation counts (link-only not mitigated, accepted
  separate), project scoping, inherent and residual heatmaps.
- `posture.test.ts` 11/11 and `openapi.test.ts` 25/25 unchanged.
