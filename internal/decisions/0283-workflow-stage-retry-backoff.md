# ADR-0283: Automatic retry with backoff for a failed workflow stage, as a template opt-in over the pg-boss queue

- **Status**: Accepted (builder lane L5, backlog P30 part 2 of 5)
- **Date**: 2026-11-14
- **Index**: Automatic retry with backoff for a failed workflow stage (P30): a per-stage `retry` policy in the template (off by default, bounded), one queue job per stage execution sent in the failure's own transaction and audited beside it, each attempt run by the ordinary executor; plus the plan-gate partial index on `workflow_instances(project_id)`.
- **Backlog item**: [PENDING.md](../product/PENDING.md) P30; the plan-gate index fragment of ADR-0250 (PR #720 review finding 4)
- **Builds on**: ADR-0254 (keep the runner), ADR-0282 (pg-boss), ADR-0284 (the stage execution key), ADR-0180
  (secure by default), ADR-0064 (in-process scheduler, the model for the worker switch).
- **Migrations**: `pending/workflow_stage_queue.sql` (the pg-boss schema `regulait_queue` and the `workflow-stage-retry`
  queue) and `pending/workflow_instances_project_open_idx.sql` (marker for a `CONCURRENT_INDEXES` entry), numbered at
  merge (ADR-0252).

## Context

A retryable `execution_failed` (a git provider error, an aborted nested build run) leaves the stage at
`awaiting_execution` until someone calls `/advance`. ADR-0254 kept the runner and asked for automatic retry with
backoff under it, with the audit row kept in the transition's transaction.

## Decision

1. **A per-stage `retry` policy in the template, absent by default.** `retry: { maxAttempts 1–10, delaySeconds 5–3600
   (default 30), backoff (default true), maxDelaySeconds 5–86400 (default 3600, at least delaySeconds) }`, strict
   (an unknown key is refused). It is accepted only on `git_operation`, `automated_build` with a run and
   `automated_check` with named checks. Anywhere else it is refused at template validation (`isExecutedStage` in the
   kernel is the one definition of an executed stage). With no policy nothing changes: the stage waits for `/advance`,
   as before.
   - **A deployment is refused too** (#808 review). Its failures are manual hand-offs (`blocked_on_deploy`), not
     `execution_failed`, so a policy there would promise nothing; and an unattended re-deploy, to production above
     all, is a decision for a person.
   - **Not retried, ever:** a failed check (`check_failed` is a verdict, not an execution error), a rollback stage (its
     failure is an operator situation and does not go through `execution_failed`), and a governance refusal.
   - Automatic retry of a git stage re-runs a governed external effect without a person. That is why it is
     opt-in per template rather than on by default; each attempt passes the same claim and completion guard as a human
     `/advance`. **Owner question open:** whether a default policy should apply to git stages.
2. **Scheduled in the failure's transaction.** `applyEvent` is the one place every transition commits. When the event is
   `execution_failed` and the failing stage has a policy, it sends one job to `workflow-stage-retry` through the same
   transaction (pg-boss `send` with its `fromDrizzle` adapter over our transaction) and writes
   `workflow:stage-retry-scheduled` beside the transition's own audit row. The job exists if and only if the failure
   committed. The job carries ids only (instance, stage, round, entry).
   - **One chain per stage execution, ever** (#808 review). The `workflow:stage-retry-scheduled` row is the permanent
     record of a chain (the queue's own rows are deleted after a week). A later failure of an execution that already
     had its chain schedules nothing and audits `workflow:stage-retry-not-scheduled` with `already_scheduled` (the
     chain is still queued, retrying or active) or `exhausted` (it has ended). This closes the loop where an attempt
     hands a build to a nested run, its job completes, and the run's abort (committed outside the attempt) would have
     started a new chain; it also means a manual `/advance` after exhaustion starts no fresh chain. A re-open or a new
     entry into the stage is a new execution key and gets a new chain.
   - **A queue error never blocks the failure.** The sender is started at boot (and lazily, outside the transaction,
     if that failed), and the send runs under a savepoint. If it throws, only the send rolls back: the failure commits
     with `workflow:stage-retry-not-scheduled` (deny) and reason `queue_unavailable`, and the stage waits for `/advance`.
3. **Backoff is the queue's, bounded by the policy.** The first attempt runs after `delaySeconds`; later attempts follow
   pg-boss's jittered exponential backoff (`retryDelay`, `retryBackoff`, `retryDelayMax` set on the job), never above
   `maxDelaySeconds`. `retryDelaySeconds` in the kernel gives the upper bound for attempt *n* without jitter.
4. **An attempt is the ordinary executor.** `runStageRetryJob` runs `runGitExecutions` for the stage inside the attempt
   context, so the claim, the governance check at claim and at commit, the one-transaction transition and its audit are
   the same as for `/advance`. The attempt context applies only to events of the execution its key names: an attempt
   whose stage succeeds and whose executor runs on into a failing downstream stage leaves that stage to schedule its
   own chain, and that stage's events carry no `retryAttempt`. The outcome is decided from what `applyEvent` committed
   for the attempt's own key (recorded after the commit), never from leftover instance context. Outcomes:
   - *superseded*: the instance is no longer awaiting that stage execution (it succeeded by hand, was re-opened, aborted
     or moved on), or another executor holds the stage. Nothing runs; the job completes.
   - *failed with attempts left*: the executor committed `execution_failed` (and, inside the attempt context, scheduled
     nothing new); the handler throws and the queue retries after its backoff.
   - *exhausted*: the last attempt failed, or threw for any other reason; `workflow:stage-retry-exhausted` (deny) is
     audited (with the error when it threw) and the stage waits for `/advance`.
   - *handed off*: the attempt committed nothing for its execution (a check stage waiting for its reports, a build
     handed to a nested run); `workflow:stage-retry-handed-off` is audited and the job completes. It is not counted as
     a failure, and by decision 2 a later failure of that execution is not retried.
   - *succeeded* and *refused* complete the job.

   Each attempt that passes the first check writes `workflow:stage-retry-attempt` (actor `workflow-retry`) before its
   claim; one that then runs nothing (another executor holds the stage, or it moved on before the claim) closes it
   with `workflow:stage-retry-superseded`. The events an attempt commits for its own execution carry
   `retryAttempt: { attempt, maxAttempts, key }` in their audit detail.
5. **The worker runs on the boot path only.** `startStageRetryWorker` starts after listen, on unless
   `REGULAIT_WORKFLOW_RETRY_WORKER=off`, and forced off under vitest (like the ADR-0064 scheduler). It polls every
   5 s, two jobs at a time, and only it supervises (job expiry, retention). A worker that does not start is a
   degradation: the jobs wait, and the stage stays retryable through `/advance`. Enforcement never depends on it.
6. **The queue schema is ours.** `regulait_queue` is installed by our journal from `getConstructionPlans` of the pinned
   pg-boss (ADR-0282); `workflows-queue.test.ts` fails if the package and the migration disagree. `regulait_app` gets
   least privilege (#808 review): DML on the job tables and on the worker's instance rows, read on the queue and version
   rows with UPDATE only on pg-boss's bookkeeping columns (never a policy, retry setting or the version), EXECUTE only on
   `job_now()` (no function is executable by PUBLIC, so `create_queue` and `delete_queue` stay the migrator's), and
   default privileges for a job partition a later migration adds.
7. **The plan-gate partial index** (ADR-0250 follow-up): `workflow_instances_project_open_idx` on `(project_id) WHERE
   status NOT IN ('completed', 'aborted', 'denied', 'rolled_back')`, built `CONCURRENTLY` by `runMigrations` through
   `CONCURRENT_INDEXES` (the 0210 pattern) and declared in `schema.ts`. It serves `guardProjectPlanOnly` and the retry
   handler's open-instance reads.

## Consequences

- No route and no UI change. The audit rule ids `workflow:stage-retry-scheduled`, `-not-scheduled`, `-attempt`,
  `-superseded`, `-handed-off` and `-exhausted` are new.
- **A job that expires loses the rest of its chain.** A job's `expireInSeconds` (900 s) equals the stage claim TTL. If
  the worker dies mid-attempt, pg-boss expires the job and, with attempts left, retries it after its backoff (the next
  attempt finds the claim lapsed or held and is superseded or runs). An expiry on the LAST attempt fails the job with
  no exhaustion row, because no handler ran to write it; the stage still waits at `awaiting_execution` with its
  `lastError` and stays retryable through `/advance`, and decision 2 keeps that execution from getting a second chain.
- A template author can now make a stage retry itself. The bounds (10 attempts, a 5 s minimum delay) keep a broken
  stage from becoming a hot loop.
- Queue rows are retained 14 days and deleted 7 days after completion (pg-boss defaults, set on the queue).
- Tests: kernel policy validation and backoff (`packages/workflow-kernel`, including the refusal on a deployment), and
  `workflows-queue.test.ts`: the schema pin; one job per stage execution; attempts failed / succeeded / superseded /
  exhausted / handed off (a reported-check stage); a nested run aborting again after its chain ended and a manual
  `/advance` after exhaustion (both `exhausted`, no new job); a downstream stage's own chain after a succeeding
  attempt; an attempt that throws on its last try; a queue that refuses the job (the failure still commits,
  `queue_unavailable`); `regulait_app` unable to create a queue or change a queue's policy or the version; the worker
  end to end.
