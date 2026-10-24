# ADR-0007: Escalate to six co-equal P0 pillars (supersedes token-opt "standard feature" framing)

- **Status**: Accepted
- **Date**: 2026-07-22

## Context
User-supplied updated feature report (`atlas-cursor-lovable-feature-report_3.md`) expands
core requirements from 2 pillars (governance, workflow) to 6: governance, workflow,
infra-ops/compliance-cascade/deployment-model (new, HyperLocal-parity), Shared Projects (new),
cost-per-project dashboard (new), and automatic backend-enforced token/cost optimization
(escalated — TOKEN_OPTIMIZATION_SPEC.md and ADR-0005/0006 previously framed this as a standard
feature, explicitly not P0).

## Decision
Adopt all six as co-equal P0 pillars. Specifically:
- Token optimization escalates from "standard feature" to P0 — Section 13's backend-enforced
  mechanics (complexity-based model routing, edit-vs-rewrite detection, context compaction,
  lazy tool-loading, dedup/caching, plan-first default) merge into
  [TOKEN_OPTIMIZATION_SPEC.md](../product/TOKEN_OPTIMIZATION_SPEC.md), superseding that doc's
  "not a third pillar" framing and its "do not let this creep toward P0" line.
- Infra-ops/compliance-cascade/deployment-model, Shared Projects, and cost-per-project dashboard
  (report Sections 10-12) are adopted as committed scope, extending
  [GOVERNANCE_LAYER_SPEC.md](../product/GOVERNANCE_LAYER_SPEC.md) since all three compose
  directly with its entitlement/audit mechanisms per the source report itself.
- `CLAUDE.md` and `VISION.md`'s "two non-negotiable P0 pillars" framing updates to six.

## Consequences
- No AWS/Terraform infrastructure change needed now — EPIC-02/03 haven't started, nothing is
  deployed yet. This ADR is spec-scope only.
- Section 10.4's three deployment modes (hosted / BYOC / air-gapped) are a future product
  architecture decision, not a rework of RegulAIt's own current bootstrap infra (ADR-0002/0003) —
  the existing Terraform module structure is already reusable toward that goal.
- Six P0 pillars is a materially larger build than two — expect EPIC-02/03 scope to grow
  accordingly once work starts.
