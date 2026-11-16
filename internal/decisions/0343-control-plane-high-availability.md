# ADR-0343: Control-plane high availability: stateless gateway replicas, replicated Postgres with automated failover and PITR, and a failover test suite

- **Status**: Accepted (lane E24 brief, 2026-11-16: the confirmed direction; owner questions are listed at the end)
- **Date**: 2026-11-16
- **Index**: **Control-plane HA for every deployment mode (pillar 3): N stateless gateway replicas (one cluster lock around boot migrations, a Postgres leader lease for the three plain boot timers, a `/ready` probe that drains first), replicated Postgres with automated failover and point-in-time recovery (Terraform modules for AWS, Azure and GCP; CloudNativePG through the Helm chart and operator for Kubernetes and air-gapped), and a failover test suite that kills a replica and the primary and checks that no committed decision or audit row is lost and the hash chain still verifies.** RPO/RTO targets per mode in §1.
- **Backlog item**: [PENDING.md](../product/PENDING.md) P2 ("Single point of failure"); `GAP_ANALYSIS_CAMUNDA_2026-11.md` row 14
- **Built in**: lane E24, three PRs (1: this ADR and the multi-replica fixes; 2: database replication and failover IaC and the Helm/operator replica story; 3: the failover test suite)
- **Migration**: none
- **Related**: [ADR-0013](0013-dev-app-deploy-single-ec2-compose.md) (Compose on one host), [ADR-0035](0035-nightly-pg-dump-to-s3.md) (nightly `pg_dump`),
  [ADR-0060](0060-tamper-evident-audit.md) (hash-chained audit), [ADR-0064](0064-in-process-scheduler.md) (scheduler leases),
  [ADR-0176](0176-open-source-first.md), [ADR-0180](0180-continuous-assurance-strict-by-default.md), ADR-0200 (engineering guidelines),
  [ADR-0252](0252-merge-queue-and-merge-time-numbering.md), [ADR-0301](0301-otlp-metrics-push.md) (OTLP push),
  [ADR-0304](0304-kubernetes-operator-and-helm-chart.md) (operator and Helm chart, "one replica until P2 lands"),
  [ADR-0325](0325-byoc-aws-pilot-and-rehearsal.md) (BYOC on AWS)

## Context

The control plane is one gateway process and one Postgres. The demo host is a single EC2 box with Postgres in a
container volume (ADR-0228); the self-install paths run one replica (ADR-0304 §4 caps `spec.replicas` at 1); only the
BYOC AWS module (ADR-0325) turns on Multi-AZ RDS. The Camunda gap analysis lists HA, multi-region and an SLA as the one
infrastructure gap (row 14). PENDING P2 says no SLA is offerable.

What the code already gets right, read from it (lane E24 audit, 2026-11-16):

- **No module-level cache holds policy, entitlements, sessions, revocations, approvals or budgets.** Each request reads
  them from Postgres. So there is nothing to invalidate across replicas, and no LISTEN/NOTIFY is needed.
- **The rate limiter is Postgres-backed** (`SharedRateLimitStore`, ADR-0125). The in-process map is only a pre-filter.
- **The ADR-0064 scheduler is cluster-safe**: a row lock plus a lease, and the loser records `skipped`. pg-boss (stage
  retries, ADR-0283) and the discovery and engine workers claim with `FOR UPDATE SKIP LOCKED`.
- **The audit chain serializes every append** on one transaction-scoped advisory lock in the same transaction as the
  decision it records, with a unique `seq` index as a backstop (ADR-0060).
- **SIGTERM already drains** (`installShutdownHandlers`): `app.close()`, then the pool, under a deadline.

What was not safe with two replicas:

1. **Boot migrations raced.** `startGateway` runs `runMigrations` on every boot, and drizzle-orm 0.45.4's migrator
   takes no lock. Two replicas booting together both read the same watermark and both apply the same files.
2. **Three plain boot timers ran N times**: the audit anchor capture and flush (two flushes could push the same anchor
   to the WORM sink twice), the audit auto-prune, and the backup verification.
3. **There was no readiness probe distinct from liveness.** `/health` keeps answering 200 until the listener closes,
   so a load balancer keeps routing to a replica that is leaving.
4. **OTLP series collided**: the resource carried only `service.name`, so N replicas' cumulative counters merged at a
   collector.

## Decision

### 1. Targets per deployment mode

RPO is the committed work that may be lost; RTO is the time until the control plane answers again. The targets assume
the defaults this ADR sets. A customer who turns a default off (an operator choice, audited where the product can see
it) gets the "single" row. Each number is a target until the slice-3 suite or a rehearsal measures it; the measured
value is recorded here as it lands.

| Mode | Database | Zone / node loss | Region loss | Notes |
|---|---|---|---|---|
| Hosted (our SaaS) | Managed Postgres, synchronous standby in a second zone | RPO 0, RTO ≤ 5 min | RPO ≤ 5 min, RTO ≤ 4 h (manual promote of a cross-region replica or PITR restore) | ≥ 2 gateway replicas across ≥ 2 zones. Not built or designated here: nothing hosted is production until the owner says so. |
| BYOC AWS | RDS Multi-AZ (synchronous), or Aurora | RPO 0, RTO ≤ 5 min | RPO ≤ 5 min, RTO ≤ 4 h | Multi-AZ is the default (ADR-0180); `db_multi_az = false` is the opt-out. |
| BYOC Azure | Flexible Server, zone-redundant HA (synchronous) | RPO 0, RTO ≤ 5 min | RPO ≤ 5 min (geo-redundant backup), RTO ≤ 4 h | |
| BYOC GCP | Cloud SQL, regional HA (synchronous disk) | RPO 0, RTO ≤ 5 min | RPO ≤ 5 min (cross-region replica), RTO ≤ 4 h | |
| Kubernetes / air-gapped | CloudNativePG, 3 instances, one synchronous standby, WAL archived to the customer's S3-compatible store | RPO 0, RTO ≤ 2 min | RPO ≤ 5 min (`archive_timeout`), RTO ≤ 4 h (restore into a new cluster) | Multi-region is a second cluster in replica mode, promoted by hand. |
| Single host (Compose, ADR-0013) | One Postgres container, nightly `pg_dump` (ADR-0035) | RPO ≤ 24 h, RTO = time to restore | same | Not HA, and the docs say so. It stays the evaluation and demo shape. |

RPO 0 depends on **synchronous** replication with `synchronous_commit` at `on` or stronger: a commit returns only
once the standby has the WAL. An asynchronous replica alone cannot claim RPO 0, and the modules do not present one as
HA.

### 2. Failure model

**In scope**, each with the behaviour the control plane must show:

| Failure | Required behaviour |
|---|---|
| A gateway replica crashes or is killed | The others keep serving. Its in-flight requests fail; nothing it committed is lost; anything it held (advisory locks, a timer lease, a scheduler lease) is freed with its session or lease. |
| A rolling deploy or scale-in | `/ready` turns 503 first; the replica serves in-flight work for `REGULAIT_DRAIN_DELAY_MS`, then closes. No request handed to it is dropped. |
| A node or zone is lost | As a replica crash, for every replica in it; the database fails over if its primary was there. |
| The database primary fails | The standby is promoted (managed service or CloudNativePG). Transactions in flight on the old primary abort, so the requests fail closed (deny, 5xx) and are not half-applied. The pool drops broken connections and reconnects through the writer endpoint. Every transaction that committed is on the new primary. |
| A partition between a replica and the database | That replica's `/ready` and `/health` turn 503, and it serves nothing it cannot audit. Governance fails closed. |
| Two replicas boot at once | Migrations take turns under one cluster lock; the second finds nothing to apply. |

**Out of scope**: automatic cross-region failover (promotion is a documented manual step: an automatic one risks a
split-brain primary, and the owner has not asked for it); the loss of the primary and every synchronous standby at
once (PITR is the recovery); corrupted storage or operator error (PITR and the ADR-0035 dumps); loss of the
Kubernetes control plane itself; and an SLA. An SLA is a commercial commitment, and nothing here designates anything
production.

### 3. Gateway replicas are stateless (slice 1)

- **One cluster lock around migrations.** `runMigrations` runs inside `withSessionAdvisoryLock(db,
  SESSION_LOCK_KEYS.migrations, …)` (`packages/db/src/session-lock.ts`). The lock is a session advisory lock on one
  pinned connection. A waiter **polls** `pg_try_advisory_lock` and never blocks: a backend blocked in `pg_advisory_lock`
  is a running statement with a snapshot, and the holder's `CREATE INDEX CONCURRENTLY` (`buildConcurrentIndexes`)
  waits for every snapshot. A blocking waiter deadlocked the run; the new test found it. `withRuntimeLoginLock` now
  uses the same helper instead of its own copy.
- **A leader lease for the three plain timers.** `ClusterLeader` (`apps/gateway/src/cluster-leader.ts`) holds a
  session advisory lock (one key per timer, `CLUSTER_LEADER_KEYS`) on a connection taken on the first tick. A follower
  tries the lock on each tick; a leader proves its session with `select 1` before it acts. A dead leader loses its
  session and so its lock, and after a failover the new primary never had it. `leaderOnly` wraps the anchor, prune and
  backup-verify ticks. The other boot timers (rate-limit counter prune, PM delivery prune) are idempotent deletes and
  stay on every replica.
- **Readiness is not liveness.** `GET /ready` (auth-exempt, never rate limited, `internal` in the OpenAPI registry)
  answers 503 `draining` from the moment a shutdown starts, and 503 `degraded` when the database does not answer within
  the `/health` deadline. `GET /health` stays the liveness probe. `REGULAIT_DRAIN_DELAY_MS` (default 0, at most 60 s,
  capped one second under the shutdown grace) is how long a draining replica keeps serving before it closes. Kubernetes
  sets it through the chart.
- **One id per process.** `PROCESS_INSTANCE_ID` (a random UUID) is the OTLP `service.instance.id` and the scheduler's
  default lease owner. This adds one attribute to ADR-0301's "only `service.name`" resource. It names no host, process
  or SDK, which is what ADR-0301 kept out.

**Known exceptions, each with what a multi-replica install must provide** (ADR-0176's multi-replica state case;
slice 2 makes the chart and operator provide them, and a boot check refuses N > 1 without them):

| State | Why it is per process | What N > 1 needs |
|---|---|---|
| `REGULAIT_INSTALL_SECRETS_DIR` (receipt and identity signing keys, the runtime-login URL) | First boot writes keys and the runtime database URL to local files | One shared volume (ReadWriteMany), or the keys and `REGULAIT_RUNTIME_DATABASE_URL` from Secrets. Per-pod directories give each replica different keys, so receipts and tokens would not verify across replicas. |
| `FileArtifactStore` (`REGULAIT_MODEL_ARTIFACT_DIR`) | Local disk | The S3-compatible artifact store. |
| Engine task offers (`engine-tasks.ts`) and executor stdio sessions | An in-process handle to a sandboxed process | Session affinity on the run or offer id at the load balancer; stdio already relays through the frames table and needs a data key. |
| Policy-simulation in-flight caps | Per-process by design | Read as N × the cap; documented, not changed. |
| `/v1/health/schedulers` | In-memory per process | Shows the replica that answered; the run ledger is the cluster view. |

### 4. Replicated Postgres with automated failover and PITR (slice 2)

Reusable, project-agnostic Terraform modules in `infra/modules/`, one per cloud, each defaulting to synchronous
zone-redundant HA, encrypted storage with a customer-managed key, TLS-only connections, automated backups with PITR
(retention ≥ 7 days, default 14), deletion protection on, no public endpoint, and an optional cross-region replica or
backup copy. They are validated with `terraform validate` and `terraform test` plans with mocked providers. Nothing is
applied; a regulait-dev rehearsal (ADR-0325's exception) runs only if a plan cannot answer a question. The BYOC AWS
module of lane E10 is not edited here: the AWS module is a sibling that BYOC can adopt later.

For Kubernetes and air-gapped installs, the chart gains an opt-in CloudNativePG `Cluster` (3 instances, one synchronous
standby, pod anti-affinity across zones, WAL archive and base backups to an S3-compatible store, a `ScheduledBackup`),
and the gateway reads the `-rw` service. ADR-0304's cap of one replica is lifted when the §3 exceptions are provided:
`replicas` > 1 requires a shared install-secrets claim (or Secret-provided keys) and the S3 artifact store, and gets a
`RollingUpdate` strategy, a PodDisruptionBudget, zone topology spread, `/ready` as the readiness probe and a preStop
drain. The migration Job stays the one migrator; the boot lock covers anything else that migrates.

### 5. The failover test suite (slice 3)

A Docker Compose file (`deploy/ha-test/`) with a Postgres primary and a synchronous standby, two gateway replicas and a
promotion step, plus a driver that runs governed decisions and audit appends while it kills a gateway replica, then the
primary. It asserts that every decision the driver saw committed is present after the failover, that no audit row is
lost or duplicated, and that the hash chain verifies end to end (the existing offline verifier). The same driver runs
on bare Postgres binaries when Docker is not available, so CI and a laptop run one suite.

### As built: the failover suite (slice 3, 2026-11-16)

`deploy/ha-test/failover-suite.mjs`, with two backends: `native` (Postgres 16 binaries and gateway processes) and
`compose` (`deploy/ha-test/compose.yml`, the gateway image built from the repository Dockerfile). The governed decision
is `POST /v1/authz/check` for an unknown subject, which commits one audited deny per acknowledged answer. Before the
primary dies, the standby is taken down for 1.5 s so that it is behind. Freezing only its WAL receiver was tried first
and was not enough: WAL already in the receiver's socket buffer was applied after it resumed, and the negative control
did not fail.

Measured on the native backend (4 CPU container, loopback, two replicas, 8 clients):

| Run | Acknowledged | Lost | Duplicated | Chain | Replica kill → next answer | Primary crash → next answer |
|---|---|---|---|---|---|---|
| synchronous replication | 919 | 0 | 0 | ok (929 rows) | 85 ms | 328 ms |
| synchronous, standby down 1.5 s before the crash | 715 | 0 | 0 | ok | 91 ms | 561 ms |
| **asynchronous (negative control)**, same | 776 | **81**, all acknowledged while the standby was down | 0 | ok | 83 ms | 560 ms |

The negative control is what makes the first rows evidence. The chain verifies in the asynchronous case too: a lost
tail leaves a valid, shorter chain. So the suite checks the clients' ledger, and production depends on the anchor
outside the database (ADR-0060) to show truncation. CI runs the suite and the negative control
(`.github/workflows/ha-failover.yml`: native on HA pull requests, at merge, on main and nightly; Compose nightly and on
demand). These are local recovery times with promotion driven by the suite. They are not the §1 targets, which include
a managed service's or CloudNativePG's own detection and promotion time.

## Open-source search (ADR-0176)

| Need | Candidate | Result |
|---|---|---|
| Cluster-wide mutual exclusion and leader election | Postgres advisory locks (already used for the audit chain, runtime login, the index build) | **Used.** A Kubernetes Lease or etcd client would add a coordination service that Compose, BYOC VMs and air-gapped installs lack. |
| | drizzle-orm migrator lock | None in 0.45.4 (`pg-core/dialect.js` `migrate` opens a transaction and takes no lock). |
| Postgres HA on Kubernetes | **CloudNativePG** (Apache-2.0, CNCF) | **Used** in slice 2: synchronous replicas, automated failover, WAL archive and PITR, no external DCS, runs air-gapped from a mirrored image. |
| | Patroni (MIT), Zalando postgres-operator (MIT), Crunchy PGO (Apache-2.0) | Not chosen: Patroni needs etcd or Consul; CloudNativePG's feature set covers both other operators' for this case. |
| Managed Postgres HA | AWS RDS/Aurora Multi-AZ, Azure Flexible Server zone-redundant HA, Cloud SQL regional HA | **Used** through their Terraform providers; community modules (`terraform-aws-modules/rds`, `terraform-google-modules/sql-db`, Azure Verified Modules) are evaluated in slice 2 and recorded there. |
| Chaos and fault injection | Toxiproxy (MIT), Pumba (Apache-2.0), Chaos Mesh (Apache-2.0) | Slice 3 needs only "kill this process" and "promote the standby", which `docker compose kill` and `pg_ctl promote` do. A tool is adopted if a network fault case is added. |

## Consequences

- `runMigrations` waits, and says so once, when another process is migrating. A boot behind a long migration is slower
  and no longer fails.
- Each replica may hold up to three extra pool connections while it leads a timer. The leader is chosen on the first
  tick, so constructing an app (about a hundred test files do) holds none.
- A leader whose session dies may, in the window before its next tick, act once more alongside its successor. The
  three timers tolerate one extra run.
- `/ready` is a new unauthenticated route. Like `/health` it names no data.
- HA costs money in every mode (a standby, a second zone). The defaults favour availability; a customer can opt out,
  and the targets in §1 say what they give up.

## Owner questions (open; built with the secure default meanwhile)

1. **The hosted SLA figure.** The targets above support 99.9%; 99.95% needs multi-region work. Which do we publish
   once hosted production is signed off?
2. **Cross-region failover.** Manual promotion (built), or automatic with its split-brain risk?
3. **Synchronous replication's write latency.** It is the default for RPO 0; accept it for every mode?
