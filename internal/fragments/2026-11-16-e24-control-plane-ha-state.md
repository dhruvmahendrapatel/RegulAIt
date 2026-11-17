<!-- fold: state-recap -->
**2026-11-16 - lane E24, control-plane HA slice 1 ([ADR-0343](../decisions/0343-control-plane-high-availability.md)).**
RPO/RTO targets per deployment mode, the failure model and the scope are recorded. The gateway is safe at N replicas:
boot migrations take one cluster lock (`withSessionAdvisoryLock`, which polls, because a blocking waiter deadlocked the
holder's `CREATE INDEX CONCURRENTLY`); the audit anchor, audit auto-prune and backup-verify timers run on one leader
(`ClusterLeader`, a Postgres advisory-lock lease); `GET /ready` answers 503 `draining` once a shutdown starts
(`REGULAIT_DRAIN_DELAY_MS`); OTLP carries `service.instance.id`. Next: slice 2 (Postgres HA modules and the
CloudNativePG/Helm replica story), slice 3 (the failover suite). No migration.
