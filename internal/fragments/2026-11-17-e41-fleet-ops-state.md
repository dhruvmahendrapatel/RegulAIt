<!-- fold: state-recap -->
**2026-11-17 - E41 slice 1a: endpoint fleet operations ([ADR-0360](../decisions/0360-endpoint-fleet-operations-and-edr.md), lane E41, branch `builder/e41-fleet-ops`).**
The per-device-group self-update setting (D-2026-11-22-04; off by default; on only with a `settings_relax` step-up recorded on the row),
staged update rollouts over ADR-0350 device groups (lane E31's, reused; no second group table) with a declared lifecycle
(ADR-0348 machines in `@regulait/shared`, `whereFrom`-guarded UPDATEs, one open rollout per source, a paged list, a halt threshold bounded 1 to 10 whose loosening is a step-up) and one-line enrolment tokens (one
device, 15 minutes by default and at most 60, optional ADR-0350 group, secret only hashed). Migration
`pending/endpoint_fleet_operations.sql`. Eight admin routes are API-only gaps on #453
(`scripts/known-ui-gaps/adr-0360-e41-endpoint-fleet-operations.json`). The agent updater (slice 1b),
the signed directive and update results (1c) and EDR (2) follow.
