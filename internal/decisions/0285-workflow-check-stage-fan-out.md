# ADR-0285: In-stage fan-out of an automated_check stage's named checks, committed as one transition

- **Status**: Accepted (builder lane L5, backlog P30 part 4 of 5)
- **Date**: 2026-11-14
- **Index**: In-stage fan-out of named checks (P30): an automated_check stage's eval-bound checks run at once, up to the stage's `checkConcurrency` (default 4, at most 16) and a process-wide limit, through fastq's bounded queues; the verdicts are gathered in declared order and still commit as one transition with its audit row.
- **Backlog item**: [PENDING.md](../product/PENDING.md) P30
- **Builds on**: ADR-0254 decision 3 (fan-out goes to the runner), ADR-0044 (eval-bound checks), AER-048 (the verdict
  is decided at commit under the row lock), ADR-0286 (the limits), ADR-0176 (open source first).
- **Migration**: none.

## Context

An `automated_check` stage with eval-bound checks (ADR-0044) ran each check's eval dataset one after another
(`runStageEvalChecks`). A stage with four quality gates took the sum of four eval runs. ADR-0254 asked for fan-out
inside a stage, committed as one transition with the audit row in its transaction.

## Decision

1. **The eval-bound checks of a stage run at once.** `runStageEvalChecks` hands its bindings to `fanOut`, which runs at
   most `stageCheckConcurrency(stage)` of them for this stage and at most the process-wide limit across every stage
   (ADR-0286). Each check is unchanged:
   - it runs under the instance initiator's entitlements and the project's budget;
   - one that could not run (unknown dataset or agent, a retired dataset, a denied dispatch, a throw) fails closed.
2. **One transition, in declared order.** The results are returned in the order the template declares the checks,
   whatever order they finish in. The verdict is still decided at commit under the row lock (AER-048) and committed
   as one `execution_succeeded` or `check_failed`, with its audit row, by `commitStageResult`. Fan-out changes how long
   the stage takes, not what it decides.
3. **The width is a template setting with a deployment default.** `checkConcurrency` (1–16) on an `automated_check`
   stage with named checks sets its width; it is refused on any other stage. Absent means
   `REGULAIT_WORKFLOW_CHECK_CONCURRENCY` (default 4). `checkConcurrency: 1` keeps the old one-at-a-time behaviour.
4. **In process, not through the queue.** The checks of one stage are bounded, run for seconds to minutes, and share
   one claim and one commit. Splitting them into queue jobs would split the verdict across workers, against decision
   2, and add a hop for nothing. The queue (ADR-0282) stays for work that outlives a request: retries (ADR-0283).
5. **Open source first.** The bounded queues are `fastq` 1.20.3 (ISC, by a fastify maintainer). It is already in the
   tree through fastify, at that exact version, and is now a direct, exact-pinned dependency. A hand-written limiter
   would re-solve a solved problem.

## Consequences

- A stage with several eval gates now takes about as long as its slowest gate (up to its width), not their sum.
- Reported checks and engine-bound checks are unchanged: a reported check waits for its report, and an engine-bound
  check is read back from its sidecar run.
- **Budget under concurrency.** Concurrent eval dispatches meet the same per-dispatch budget and entitlement checks as
  concurrent API calls by the same user. A check may therefore run past the project budget by the dispatches already in
  flight when the budget ran out, which is the same bound as for any concurrent user. `checkConcurrency: 1` removes it
  for a stage that must not.
- Tests: `workflows-fanout.test.ts` covers `fanOut`'s order, width and process limit, and a real check stage whose four
  eval checks ran four at a time (and one at a time with `checkConcurrency: 1`), committing one transition in declared
  order. The kernel tests cover the `checkConcurrency` validation.
