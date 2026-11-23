<!-- fold: pending -->
**E41 EDR follow-ups (ADR-0360 slice 2, 2026-11-17).** (a) Apply lane E15's device quarantine when an EDR isolation
reaches `isolated` (E15 has none yet; no parallel one was built). (b) List EDR isolation requests in the Approvals Queue
screen (#453). (c) Confirm the Falcon webhook signature format and SentinelOne's custom-header option against live
tenants before GA (built from vendor documentation; contract tests pin it). (d was done on 2026-11-23: the
isolation lifecycle is `EDR_ISOLATION_MACHINE`, an ADR-0348 `defineMachine` registered in `STATE_MACHINES`.)
