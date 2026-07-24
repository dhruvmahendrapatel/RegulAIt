# ADR-0008: Escalate to eight co-equal P0 pillars

- **Status**: Accepted
- **Date**: 2026-07-24

## Context
Third feature report (`atlas-cursor-lovable-feature-report_4.md`) adds two more core
requirements on top of ADR-0007's six: (7) dynamic multi-agent orchestration with a
Project-Manager/Team-Lead delegation model (report Section 14), (8) native bi-directional
integration with Azure DevOps/Jira/other PM tools, treating them as the system of record for
decisions/approvals rather than a shadow copy (report Section 15).

## Decision
Adopt both as co-equal P0 pillars, bringing the total to eight. New spec docs (matching the
pattern already used for pillar 6 — `TOKEN_OPTIMIZATION_SPEC.md` — rather than folding into an
existing doc, since both are substantial and distinct):
- `docs/product/MULTI_AGENT_ORCHESTRATION_SPEC.md` (pillar 7): PM → Team Lead → Worker Agent
  delegation hierarchy, task-graph/DAG decomposition, resource-contention/ownership avoidance,
  and — critically — entitlement inheritance (never escalation) and per-run budget caps so
  delegation cannot become a way to bypass governance or cost control.
- `docs/product/PM_TOOL_INTEGRATION_SPEC.md` (pillar 8): adapters for ADO/Jira/Linear/Asana/
  monday.com, configurable field mapping, bi-directional sync, decisions/approvals tracked as
  first-class records in the customer's own PM tool, one unified audit trail.

Both compose with existing pillars rather than duplicating them: pillar 7's cost caps reuse the
governance layer's entitlement system and the cost-per-project dashboard (GOVERNANCE_LAYER_SPEC
§4, §10); pillar 7's task graph extends the workflow engine's instance dashboard
(WORKFLOW_ENGINE_SPEC §7.5 pattern); pillar 8's audit trail feeds the same single audit log as
every other governed action (GOVERNANCE_LAYER_SPEC §3, §6).

## Consequences
- No AWS/Terraform infrastructure change needed — still nothing deployed (EPIC-02/03/04 haven't
  started). Spec-only update, same as ADR-0007.
- `CLAUDE.md` and `VISION.md`'s pillar-count banners update from six to eight.
- New epics EPIC-05 (multi-agent orchestration MVP) and EPIC-06 (PM-tool integration MVP) added
  to `STATE.md`.
