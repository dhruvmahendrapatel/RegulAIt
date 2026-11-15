# ADR-0286: Concurrency limits for workflow retries (per process and per project) and for check fan-out (per stage and per process)

- **Status**: Accepted (builder lane L5, backlog P30 part 5 of 5)
- **Date**: 2026-11-14
- **Index**: Concurrency limits for pillar 2's runner (P30): retry jobs at most 2 per process and 1 per project across every process (pg-boss localConcurrency and database-tracked groupConcurrency), and check fan-out at most 4 per stage and 8 per process; every limit bounded, with a default, set by environment variable.
- **Backlog item**: [PENDING.md](../product/PENDING.md) P30
- **Builds on**: ADR-0254 decision 4 (per-queue concurrency limits, borrowed from trigger.dev), ADR-0282 (pg-boss),
  ADR-0283 (retry), ADR-0285 (fan-out), ADR-0180 (secure by default).
- **Migration**: none (the job's group is a column of the pg-boss schema installed with ADR-0283).

## Context

ADR-0254 asked for per-queue concurrency limits on the fan-out and retry work, for example per check kind and per
project. Without them, one project with many failing stages could take every retry slot, and one stage with many
eval gates could start as many eval runs as it declares.

## Decision

| Limit | Variable | Default | Bounds | Enforced by |
|---|---|---|---|---|
| Retry jobs running in one gateway process | `REGULAIT_WORKFLOW_RETRY_CONCURRENCY` | 2 | 1–16 | pg-boss `localConcurrency` on the worker |
| Retry jobs of one project running at once, across every process | `REGULAIT_WORKFLOW_RETRY_PROJECT_CONCURRENCY` | 1 | 1–16 | pg-boss `groupConcurrency`, tracked in the database; each job's group is its instance's project (`no-project` when none) |
| Eval checks of one stage running at once | the stage's `checkConcurrency`, else `REGULAIT_WORKFLOW_CHECK_CONCURRENCY` | 4 | 1–16 | `fanOut` (fastq) |
| Eval checks running at once across every stage in one process | `REGULAIT_WORKFLOW_CHECK_PROCESS_CONCURRENCY` | 8 | 1–64 | `fanOut` (fastq), one shared queue |

1. **Every limit is bounded and has a default.** A value that is not an integer within its bounds falls back to the
   default (`concurrencyLimit`); no setting means unbounded. The values are read when the work starts, so an operator
   change needs no code.
2. **Per project for retries.** A project's retries run one at a time by default, so a project whose stages keep failing
   waits behind itself, not in front of everyone else. The group is set on the job when it is sent (in the failure's
   transaction), and the limit is tracked in the database, so it holds with several gateway replicas.
3. **Per stage and per process for fan-out.** A stage's width keeps one template from starting more eval runs than it
   needs; the process limit keeps several stages finishing at once from multiplying it.
4. **Per check kind** (ADR-0254's other example) is not added. Eval-bound checks are the only ones that fan out; reported
   checks run elsewhere and engine-bound checks are sidecar runs with their own lease. A per-kind limit would have
   nothing to bound.

## Consequences

- No route, no UI and no migration. The four variables are documented here and in the code
  (`apps/gateway/src/workflows-queue.ts`, `CONCURRENCY_LIMITS`).
- Tests: `workflows-fanout.test.ts` covers the bounds, the fallback, the stage-over-default precedence, the job's
  group, and the per-stage and process limits in `fanOut`.
