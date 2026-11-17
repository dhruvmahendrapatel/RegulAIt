<!-- fold: state-recap -->
**2026-11-17 - lane E29, declared state machines slice 2 ([ADR-0348](../decisions/0348-declared-state-machines.md)).**
Incidents: edits, close, containment and corrective actions re-read the incident under a row lock; a stale edit is a
409 `incident_changed` instead of a silent overwrite, a close re-checks its blockers under the lock, and a containment
never re-opens a resolved or closed incident; the detail carries `lifecycle`. Eval runs record `error` when the runner
throws instead of staying `running`. The orchestration overage approval no longer erases concurrent measured spend.
The scheduler releases a lease only while it holds it. No migration.
