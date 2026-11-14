# ADR-0284: Idempotency keys for workflow stage executions, and wait-for-token mapped onto the existing sign-off pause

- **Status**: Accepted (builder lane L5, backlog P30 part 3 of 5)
- **Date**: 2026-11-14
- **Index**: Idempotency keys for workflow stage executions (P30): `<instance>:<stage>:<round>:<entry>` is the key of one stage execution, the queue's singletonKey under an `exclusive` policy, so a redelivered or duplicated job never runs a stage twice; wait-for-token is the existing sign-off pause (an approval row resumed by the authenticated decide route), with no new route.
- **Backlog item**: [PENDING.md](../product/PENDING.md) P30
- **Builds on**: ADR-0254 decision 4 (patterns borrowed from trigger.dev and the spike), ADR-0282, ADR-0283, AER-048
  (round tokens and the stage claim), ADR-0179 / AER-050 (the `Idempotency-Key` header).
- **Migration**: none of its own (the queue policy is in ADR-0283's `workflow_stage_queue`).

## Context

ADR-0254 borrowed three patterns for the runner. This ADR records two of them: idempotency keys, so a redelivered job
never runs a stage twice, and wait-for-token pauses. The third, per-queue concurrency limits, gets its own ADR in this lane.

## Decision

1. **The stage execution key.** One execution of a stage is named by `<instance>:<stage>:<round>:<entry>`
   (`stageExecutionKey`). `round` moves on a re-open; `stage_entry` moves on every entry into an executable stage
   (AER-048). The key therefore changes whenever the work it names stops being current.
2. **Used three ways.**
   - **Queue idempotency.** It is the retry job's `singletonKey`, and the `workflow-stage-retry` queue is `exclusive`:
     at most one job per key queued, retrying or active. A second failure of the same entry (a manual `/advance` that
     fails again while the chain waits) sends nothing new and audits `workflow:stage-retry-not-scheduled` with
     `already_scheduled`.
   - **Execution idempotency.** A job runs only while the instance is still awaiting exactly that execution (stage,
     round and entry match, status `awaiting_execution`); otherwise it is *superseded* and runs nothing. A redelivered
     job (a worker that died after the stage succeeded) finds the stage done and stops. Inside an execution the existing
     claim (`executingEntry`, `executingClaim`, REL-06 TTL) still keeps two executors off one stage, and the effect
     stamps (AER-049) still keep a git step from being redone.
   - **Traceability.** The key is in every retry audit row (`executionKey`) and in the `retryAttempt` detail of the
     events an attempt commits.
3. **Wait-for-token is the existing sign-off pause.** trigger.dev's `wait.forToken` (and the spike's `createHook` /
   `resumeHook`) park a run on a token that an authenticated caller completes. The runner already does this: a
   `human_approval` stage parks the instance at `blocked_on_approval` with one `approvals` row per approver, the row id
   is the token, and `POST /v1/approvals/:id/decide` (authenticated, object-level checked, audited, quorum-aware) resumes
   it through `applyWorkflowApprovalDecision` in one transaction. Reported checks are the same shape for machines: a
   stage waits at `awaiting_execution` and `POST .../checks` resumes it. No new route, token type or table is added:
   a second resume mechanism beside the Approvals Queue would split pillar 1's single inbox and audit trail.

## Consequences

- No new route or table. The `Idempotency-Key` header (ADR-0179) stays on the intake writes it already covers. Adding
  it to `/advance` and `/decide` is a follow-up if a client needs replay-safe resumes; today a repeated decide is
  refused because the row is no longer pending, and a repeated `/advance` finds the stage claimed or moved on.
- Tests: `workflows-queue.test.ts` covers the key (one job per execution, the second failure of an entry, a redelivered
  job superseded, an aborted instance superseding its queued job).
