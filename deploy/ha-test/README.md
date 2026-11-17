# Control-plane failover suite (ADR-0343 slice 3)

This suite proves the control plane's high-availability claim end to end: **no governance decision a client saw
committed is lost when a gateway replica or the database primary dies, and the audit hash chain still verifies.**

## What it does

1. It starts a Postgres primary with one **synchronous** standby (`synchronous_standby_names = 'FIRST 1 (standby1)'`,
   `synchronous_commit = on`) and a writer endpoint (`writer-proxy.mjs`). The writer endpoint plays the part of the RDS
   endpoint, the Azure FQDN or CloudNativePG's `-rw` Service.
2. It boots **two gateway replicas at the same time** against the empty database. The ADR-0343 migration lock makes
   them take turns, and both become ready.
3. Eight clients send governed decisions round-robin to the live replicas: `POST /v1/authz/check` for a random
   subject id nobody has. Each `200 unknown_subject` answer is a committed deny with exactly one audit row. The suite
   records every id it sent and every id that was acknowledged.
4. **Kill a replica** (SIGKILL); the other keeps serving.
5. **Kill the primary.** The standby is taken down first for a moment, so it is behind when the primary crashes
   (`pg_ctl stop -m immediate`, or SIGKILL on Compose). The suite then starts the standby again, promotes it and
   repoints the writer endpoint. The replicas reconnect by themselves.
6. **Restart the killed replica** against the promoted database.
7. **Assert**, on the promoted primary:
   - every acknowledged decision has its audit row (`everyAcknowledgedDecisionIsCommitted`);
   - no decision has two rows (`noDuplicateAuditRows`);
   - no row exists for a request that was never sent (`noRowForAnUnsentRequest`);
   - `verifyAuditChain` reports `ok` over the whole chain (`hashChainVerifies`).

The JSON report also records the measured recovery times (`rtoMs`): the time from a kill to the next acknowledged
decision.

## The negative control

`--async` leaves replication asynchronous. While the standby is down, the primary keeps acknowledging decisions that
the standby never receives. After the failover they are gone, and the suite **must fail**, naming them. CI runs this on
every run, so a suite that can no longer see a lost decision fails the build (M-002).

The hash chain still verifies in that case, because losing the tail of a chain leaves a valid, shorter chain. That is
why the suite checks the clients' own ledger as well as the chain: only the ledger, or an anchor captured outside the
database (ADR-0060), can show that rows went missing.

## Running it

```sh
pnpm install && pnpm -r build

# native: Postgres 16 binaries on this machine (PG_BIN, or `pg_config --bindir`). No Docker needed.
node deploy/ha-test/failover-suite.mjs
node deploy/ha-test/failover-suite.mjs --async        # the negative control; it must exit 1

# Docker Compose: builds the gateway image from the repository Dockerfile
node deploy/ha-test/failover-suite.mjs --backend compose
```

Options: `--per-phase N` sets the acknowledged decisions per phase (default 150). `--concurrency N` sets the number of
clients (default 8). `--freeze-ms N` sets how long the standby stays down before the primary dies (default 1500).
`--report file.json` writes the report to a file. `--keep` keeps the native data directory for inspection.

Under root, the native backend runs Postgres as the `postgres` user (initdb refuses root). Every port is bound to
127.0.0.1. Auth is `trust` on loopback for the native clusters and SCRAM with a per-run random password on Compose.
The data key and bootstrap token are generated for each run. It is test infrastructure and never a deployment.

CI: `.github/workflows/ha-failover.yml`. The native job and its negative control run on pull requests that touch the
HA code, at merge time, on main and nightly. The Compose job runs nightly and on demand.
