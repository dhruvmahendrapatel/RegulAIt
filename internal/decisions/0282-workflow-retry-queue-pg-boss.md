# ADR-0282: pg-boss is the queue under pillar 2's stage runner (retry, fan-out jobs, concurrency); graphile-worker is not adopted

- **Status**: Accepted (builder lane L5, backlog P30 part 1 of 5; the spike verdict ADR-0254 left the choice open)
- **Date**: 2026-11-14
- **Index**: pg-boss 12.38.2 (MIT) is the Postgres queue under pillar 2's stage runner for retry with backoff, fan-out jobs and per-queue concurrency; graphile-worker is not adopted (config-file loading, beta config dependency, fixed backoff). Installed in our own schema `regulait_queue` by our migration journal, never by its own migrator.
- **Backlog item**: [PENDING.md](../product/PENDING.md) P30
- **Builds on**: [ADR-0254](0254-workflow-durable-execution-spike.md) (the spike: keep the runner, add a queue under it),
  ADR-0176 (open source first), ADR-0180 (secure by default), ADR-0200 (security checklist), ADR-0252 (migrations
  numbered at merge), ADR-0064 (the in-process scheduler, which this does not replace).
- **Follow-ups in this lane**: one ADR each for retry with backoff, idempotency keys and wait-for-token, in-stage
  fan-out of named checks, and per-queue concurrency limits (the lane's reserved numbers follow this one).
- **Migration**: none in this PR (dependency only). The schema install lands with the retry ADR as a pending migration.

## Context

ADR-0254 rejected `vercel/workflow` as pillar 2's engine and kept the existing stage runner (`packages/workflow-kernel`
plus `apps/gateway/src/workflows.ts`). Two gaps go to the runner: automatic retry with backoff for a retryable
`execution_failed`, and fan-out inside an `automated_check` stage. It named graphile-worker (MIT) as the candidate queue
and pg-boss (MIT) as the fallback, and asked for the choice to be made and recorded. This ADR makes it. The dependency
lands alone, in its own small PR, so the lockfile change does not collide with other lanes (owner brief, lane L5).

## Options compared (2026-11-14, from the npm registry and the packed tarballs)

| | **pg-boss 12.38.2** | **graphile-worker 0.18.0** |
|---|---|---|
| Licence | MIT | MIT |
| Last release | 2026-11-10 (12.38.0 2026-10-13, 12.38.1 2026-11-05) | 2026-09-08 |
| Runtime dependencies | `pg`, `cron-parser` (→ `luxon`), `rrule-temporal` (→ `temporal-spec`, Apache-2.0), `serialize-error` (→ `non-error`, `type-fest` MIT OR CC0-1.0, `tagged-tag`); peer `@opentelemetry/api`, already pinned by the gateway | `pg`, `graphile-config` **0.0.1-beta**, `cosmiconfig`, `json5`, `yargs`, `@graphile/logger`, and `@types/pg` / `@types/debug` at run time |
| Configuration loading | Constructor options only | `cosmiconfig` searches the working directory for config files, including JavaScript ones, through `graphile-config` presets: code loaded from disk at start, which a secure default does not want |
| Retry and backoff | Per job or per queue: `retryLimit`, `retryDelay`, `retryBackoff` (exponential with jitter), `retryDelayMax` | Fixed formula `exp(min(attempts, 10))` seconds; `max_attempts` only |
| Idempotency | `singletonKey`, plus queue policies (`singleton`, `stately`, `exclusive`, `key_strict_fifo`) | `job_key` with replace / preserve-run-at modes |
| Concurrency limits | Per queue `localConcurrency`; per group `groupConcurrency` across nodes (database-tracked) | One global worker concurrency; a named `queue_name` is serial (concurrency 1) only |
| Enqueue inside our transaction | `send(name, data, { db })` with an adapter over our transaction | `SELECT graphile_worker.add_job(...)` in SQL |
| Schema | Name is an option; DDL is available as `getConstructionPlans(schema)` and upgrades as `getMigrationPlans(schema, version)`; `migrate: false` stops it migrating itself | Name is an option; it always runs its own migrator at start |
| Extensions needed | None (checked: the construction plan creates no extension) | None |
| Air-gapped | No network use (the only network is Postgres); no install script | No network use |
| Advisories (`pnpm audit --prod`, 2026-11-14) | None on pg-boss or its closure | Not installed |

**Decision: pg-boss.** Each of the following is enough on its own under ADR-0176/0180, and together they settle it:

1. **No configuration from disk.** graphile-worker's cosmiconfig/graphile-config path loads config files, JavaScript
   included, from the working directory at start. pg-boss takes options from the constructor only.
2. **No pre-1.0 beta in the closure.** graphile-worker needs `graphile-config` 0.0.1-beta; pg-boss's closure is stable
   releases only.
3. **Backoff is ours to set.** Retry delay, exponential backoff and a cap are options per queue or per job. A fixed
   `exp(attempts)` formula cannot honour an admin-set limit.
4. **Per-group concurrency exists.** `groupConcurrency` limits jobs per group (for example per project) across nodes,
   which is the per-queue / per-project limit ADR-0254 asked to borrow. graphile-worker has only serial named queues.
5. **The schema install can live in our journal.** `getConstructionPlans('regulait_queue')` gives the exact DDL of the
   pinned version, so the install is a pending migration (ADR-0252) and pg-boss starts with `migrate: false`. This is
   the criterion ADR-0254 failed `vercel/workflow` on (criterion 3): the schema name is ours and its migrations run from
   our journal. An upgrade is a lockfile PR plus a migration from `getMigrationPlans`; a test fails when the pinned
   version and the installed schema disagree (the retry ADR's test).

## How it is used (binding on the lane's follow-up ADRs)

- **The runner stays the engine.** pg-boss is a queue under it, never an execution engine. Every stage outcome is still
  one kernel `transition()` committed by `applyEvent` / `commitStageResult`, with the audit row in that transaction.
- **Jobs carry ids only.** A job's payload is the instance id, stage id, stage entry, round and attempt: no prompt, no
  artifact, no check output, no secret. The queue tables therefore hold no tenant content, and the instance row (under
  ADR-0234 row-level security and object-level checks) stays the only record of what happened. The queue schema is
  server-side only; no route reads it.
- **Enqueue in the transition's transaction.** A retry or fan-out job is sent through an adapter over the same
  transaction that writes the transition and its audit row, so the job exists if and only if the transition committed.
- **Off unless the boot path starts it, like the scheduler (ADR-0064).** No worker starts under `buildApp` or vitest.
  Enforcement never depends on the worker: without it a failed stage stays retryable through `/advance`, as today.
- **No cron, no telemetry export.** `schedule: false` (we have the ADR-0064 scheduler) and no OpenTelemetry provider is
  passed, so it records nothing outside our own metrics.

## Consequences

- One new direct dependency of `@regulait/gateway`, exact-pinned: `pg-boss` 12.38.2 and nine transitive packages (all
  MIT, `temporal-spec` Apache-2.0, `type-fest` MIT OR CC0-1.0). The workspace licence gate passes with no new
  admission. Listed in `apps/gateway/THIRD_PARTY.md`.
- ADR-0176's register row "Scheduler (`scheduler.ts`): Replace with a Postgres-backed queue" is **not** closed here:
  the scheduler's sweeps keep their own lease and "skipped, and why" records. Whether they move onto this queue is a
  separate decision.
- `engine-runs.ts`'s ADR-0176 note ("neither fits" for the engine-run lease) stands: that queue is the governed evidence
  record consumed over HTTP by an external container.
- **Re-check** if pg-boss changes licence, stops releasing for 12 months, or drops `getConstructionPlans` /
  `migrate: false`.
