<!-- fold: state-recap -->
**2026-11-16 - lane E24, control-plane HA slice 3: the failover suite ([ADR-0343](../decisions/0343-control-plane-high-availability.md)).**
`deploy/ha-test/failover-suite.mjs` (native Postgres binaries, or Docker Compose) boots two gateway replicas together,
drives governed decisions, kills a replica, then crashes the primary behind a synchronous standby, promotes it and
restarts the replica. It asserts that no acknowledged decision or audit row is lost or duplicated and that the chain
verifies. Measured locally: 919 decisions, 0 lost, 85 ms after a replica kill and 328 ms after a primary crash. The
`--async` negative control loses 81 acknowledged decisions and fails, as it must. CI: `ha-failover.yml`.
