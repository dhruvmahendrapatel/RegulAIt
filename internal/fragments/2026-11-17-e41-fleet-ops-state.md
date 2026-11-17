<!-- fold: state-recap -->
**2026-11-17 - E41 slice 1a: endpoint fleet operations ([ADR-0360](../decisions/0360-endpoint-fleet-operations-and-edr.md), lane E41, branch `builder/e41-fleet-ops`).**
Device groups (staging rings, a device in at most one), the per-source self-update setting (off by default; on only
with a `settings_relax` step-up recorded on the row), staged update rollouts over groups with a declared lifecycle
(`endpoint-fleet-lifecycle.ts`, guarded UPDATEs, one open rollout per source) and one-line enrolment tokens (one
device, 15 minutes by default and at most 60, optional group, secret only hashed). Migration
`pending/endpoint_fleet_operations.sql`. Twelve admin routes are API-only gaps on #453. The agent updater (slice 1b),
the signed directive and update results (1c) and EDR (2) follow.
