<!-- fold: state-recap -->
C3 / ADR-0352 adds pending-only audited approval priorities, scoped assignee load and a content-free first-party task-widget API contract. No screen or alternate decision path is supplied. Workflow-stage deadline projection awaits E21 (#891); existing assignment SLA fields remain separate. Two API-only screen gaps are raised on #453 with the UI-gap ceiling unchanged, so READY requires the master's gate decision or completed screens.

Validation: nine integration tests pass on fresh PostgreSQL, the shared priority-machine suite passes and the existing workbench/list-contract compatibility suites pass (52 tests). The census honestly reports 75 gaps against the unchanged cap of 73; final build, bundle and CI evidence is recorded on the lane PR before READY.
