# ADR-0340: Process-level reliability for pillar 2's runner: compensation (saga) stages, stage deadlines with SLA escalation, and process-version pinning, migration and canary

- **Status**: Accepted (builder lane E21; slice 1, compensation, and slice 2, deadlines, are built; slice 3 follows
  in this lane under this ADR)
- **Date**: 2026-11-16
- **Index**: Process reliability for the workflow runner (Camunda gap 2 and 8): compensation stages run in reverse on a cancel or a denial through the ordinary executors; stage deadlines with SLA escalation (notify, reassign or fail) over pg-boss timers; process versions pinned per instance, governed in-flight migration and canary rollout. No new engine.
- **Backlog item**: `internal/product/GAP_ANALYSIS_CAMUNDA_2026-11.md` rows 2, 5 and 8; next step 3 ("process-level
  reliability … extends the ADR-0282–0286 runner, no new engine")
- **Builds on**: ADR-0254 (keep the runner; a transition and its audit row commit in one transaction, re-authorised at
  claim and commit), ADR-0282 (pg-boss), ADR-0283 (retry), ADR-0284 (the stage execution key), ADR-0232 (no BPMN
  engine), ADR-0046 and ADR-0061 (the approvals queue and ChatOps), ADR-0180 (secure by default), ADR-0176 (open
  source first), AER-048 and AER-049 (rounds, stage entries, effect records).
- **Migrations**: slice 1 none (the compensation state lives in the instance's `state` jsonb, which the kernel
  owns). Slice 2: `pending/workflow_stage_queue_deadline.sql` (the `workflow-stage-deadline` queue). Slice 3 adds its
  own. All numbered at merge (ADR-0252).

## Context

The Camunda gap analysis (2026-11-16) found the runner had durable retries, idempotency, wait-for-token, fan-out and
concurrency limits (ADR-0282 to ADR-0286) but no way to undo work when a run is cancelled or refused, no timers or
deadlines on a stage, and no way to move a running instance to a new template version or to roll a new version out
gradually. Templates are snapshotted into each instance at start, so in-flight runs already finish on the definition
they started with, but that pinning is implicit and there is no version record to migrate between.

ADR-0232 and ADR-0254 rejected Temporal, Camunda/Zeebe, Restate, Inngest and any BPMN engine: their licences, or a
second stateful cluster in BYOC and air-gapped deployments. This ADR adds the three capabilities to the existing
kernel and runner.

## Open-source search (ADR-0176)

- **Repository first.** The runner already has the pieces this reuses: the `rollback` stage (a failure-only stage the
  forward flow skips), the executors with their claim, completion guard and `runExternalWrite` barrier, the pg-boss
  queue and its in-transaction send (ADR-0283), the approvals queue and ChatOps couriers. Nothing in the repository
  compensated, timed out or migrated an instance.
- **Saga libraries** (for example `node-sagas`, `saga-js`) are in-memory orchestrators: they hold the saga's state in
  the process and run steps as callbacks. Ours must be a persisted state machine whose every step commits with its
  audit row under the instance lock and passes the governance gate, so they do not fit; the saga here is a few
  transitions in the kernel.
- **Timers**: pg-boss (already pinned, MIT) has delayed jobs (`startAfter`) and singleton keys; slice 2 uses them.
  `node-cron`, `bree` and similar keep timers in memory and lose them on a restart.
- **Versioning and canary**: no library maps onto a jsonb template definition snapshotted per instance; a JSON diff
  for the migration dry run uses the RFC 6902 patch library the repository already pins (ADR-0246).

## Decision

### Slice 1: compensation (saga) stages (built)

1. **A compensation is a stage that names the forward stage it undoes** (`compensates: "<stage id>"`). Like a rollback
   stage, the forward flow skips it. One compensation per forward stage. Allowed pairs, checked at template
   validation:
   - a `git_operation` `delete_branch` undoes a `create_branch`, and `close_pr` undoes an `open_pr`, on the same
     connection and repository. Both actions are valid only on a compensation stage;
   - a `rollback` undoes a `deployment`;
   - an `automated_build` undoes a git, deploy or build stage: with a `run`, a governed nested run; without one, a
     manual task a person completes. A merge has no git compensation: reverting a merge is a new change that needs
     its own review, so a template compensates it this way.
2. **What triggers it.** A cancel (`abort`) or a denied sign-off (`approval_denied`) on an instance where a forward
   stage that ran (completed, or completed and later re-opened) has a compensation. The plan is those compensations
   in reverse definition order, so the last effect is undone first. A stage that never completed is not compensated.
   With no compensations, a cancel and a denial behave exactly as before. A failed check, a rollback after a failed
   post-deploy verify and an exhausted retry do not trigger it: they wait for a person, who may then cancel.
3. **How it runs.** The kernel records `state.compensation` (`cause`, `fromStageId`, `plan`, `remaining`, and
   `outcome` once it ends) and points the instance at the first compensation, at `awaiting_execution` (executed) or
   `awaiting_trigger` (manual). Each compensation runs through the ordinary executor, so it gets the claim, the
   governance check at claim and at commit, the external-effect barrier (`git.delete_branch`,
   `git.close_pull_request`, `deploy.rollback`), the one-transaction transition with its audit row, and the stage's
   own retry policy if it has one. A compensation's success moves to the next; after the last, the instance ends in
   the cause's terminal status (`aborted` or `denied`). A failed compensation stays where it is and waits for
   `/advance`, like any failed stage. While compensating, the instance accepts only its current compensation's
   outcome or `abort`; a re-open, an approval or any other event is refused.
4. **What a compensation undoes.** Exactly what the forward stage recorded for the current round: the `branch`, the
   `prId`, the `deploy:<stage>` record. Nothing recorded (or only a dry-run deploy) means nothing to undo, and the
   compensation succeeds with `nothingRecorded` on its record (`compensation:<stage>` or `rollback:<stage>`). The
   provider calls are idempotent (a branch already gone and a PR already closed answer `false`). Closing a merged
   pull request throws, so the stage fails rather than claiming an undo that did not happen.
5. **Ending a compensation early is an admin's act.** `abort` on a compensating instance abandons the rest: the
   instance ends in its cause, `workflow:compensation-abandoned` (deny) names the compensations that never completed.
   Anyone else gets `403 compensation_abandon_requires_admin`, audited `workflow:compensation-abandon-refused`; the
   decision is taken under the instance lock.
6. **Audit.** `workflow:compensation-started` (the plan), `workflow:compensation-completed` and
   `workflow:compensation-abandoned` are written in the transition's transaction beside the event's own row. Starting
   a compensation cancels the instance's live engine runs (cause `workflow_compensating`) and supersedes its pending
   gates, as an abort or denial always did, and is a new stage entry, so a forward executor still running from before
   the cancel can never commit into the compensation.

### Slice 2: stage deadlines and SLA escalation (built)

7. A stage may carry `sla: { breachAfterSeconds, warnAfterSeconds?, onBreach: "notify" | "reassign" | "fail",
   reassignTo? }`, strict, bounded (one minute to 90 days, the warning before the breach), absent by default.
   `reassign` (with `reassignTo`, required with it and refused without it) only on a `human_approval` stage; `fail`
   cancels the instance, and so compensates it (decision 2). Not allowed on a trigger, a rollback or a compensation
   stage. A deadline is per stage ENTRY: a stage re-entered (a re-open, a recheck) gets fresh timers.
8. **Timers are pg-boss jobs on the `workflow-stage-deadline` queue** (policy `exclusive`), sent in the transaction
   that enters the stage, so a timer exists if and only if the entry committed. A job carries ids only and its
   singleton key is the stage execution key (ADR-0284) plus the phase (`warn`, `breach`). The entry also records the
   `sla:<stage>` marker (`executionKey`, `warnAt`, `dueAt`, `onBreach`) on the instance and `workflow:sla-scheduled`;
   a queue that cannot take the job is audited `workflow:sla-not-scheduled` (deny) and the transition still commits,
   with no deadline. The worker starts on the boot path beside the retry worker, under the same switch.
9. **A firing timer acts only if the instance still rests at that stage execution** (same stage, round and entry; not
   ended, not compensating) and that phase has not run for it, decided under the instance lock with the marker and
   the audit row in one transaction; otherwise it does nothing. The actor is the system actor `workflow-sla`.
   - `warn`: `workflow:sla-warned` and a reminder.
   - `breach`: `workflow:sla-breached` (deny), then `notify` (a notice); `reassign` (the stage's pending sign-off rows
     are superseded and the `reassignTo` approvers requested through the same path as the stage's own request,
     audited `workflow:sla-reassigned` with both sets); or `fail` (the kernel's `abort`, which supersedes the gates and
     compensates; the first compensation runs after the commit through the ordinary executor and its guard).
   - **Escalation never approves or denies a sign-off**, the ADR-0046 workbench rule: a reassignment moves the
     decision, and a failure cancels the instance, whose pending rows are superseded, not denied.
10. **Notices** go through a courier ChatOps registers per database handle (as for governance alerts, ADR-0162, and
    the alert SLA sweep): an alert card with a content-free text and a link to the instance, to the workspaces opted
    into alerts (a reminder is `medium`, a breach `high`); a resend workspace mails the people the stage waits on (the
    pending approvers, or the initiator of a cancelled instance), never anyone a request names. Each post is audited
    `chatops-workflow-sla-posted` or `-post-failed`. A notice is sent after the commit and never fails the timer; a
    deployment without ChatOps posts nothing, and the pending sign-off stays in the approvals queue.

### Slice 3: process versions, in-flight migration and canary (decided; built after slice 2)

11. **Versions.** Every template create or change writes an immutable, numbered template version row; an instance
   records the versions it was started from (a join table, ADR-0200 3NF) beside its snapshotted definition, which
   stays the definition it runs. A running instance always finishes on its version unless it is migrated.
12. **Governed migration.** `POST …/instances/:id/migrations` with `dryRun` returns the diff (RFC 6902) between the
    instance's definition and the target version, and refuses a migration the target cannot honour (the current stage
    or a stage that ran is missing or changed type; a compensation that would be lost). Applying needs an approval in
    the approvals queue by an admin other than the requester (ADR-0195), is re-validated under the instance lock when
    approved, bumps the stage entry, and writes `workflow:instance-migrated` with both versions and the diff.
13. **Canary.** An admin may roll a new version out to a percentage (1 to 50) of NEW instances of a template; the
    choice is deterministic per instance id, recorded on the instance and audited at start
    (`workflow:canary-version-selected`); starting and stopping a canary is audited. Running instances are never
    switched by a canary.

## Consequences

- Slice 2 adds no route either; `GET /v1/workflows/instances/:id` shows the `sla:<stage>` marker (when it is due,
  when it warned and breached). Slice 2's tests: kernel validation ("ADR-0340 slice 2: stage deadlines") and
  `apps/gateway/src/workflows-sla.test.ts` (the queued timers and their delays, a reminder that runs once, a
  reassignment that then decides normally, a stale timer that does nothing, a failure that cancels and compensates as
  `workflow-sla`, a notice to the pending approvers, a refused template).
- Slice 1 adds no route (the existing `/abort`, `/advance` and approval decide routes drive it), no table and no UI;
  `GET /v1/workflows/instances/:id` shows `state.compensation`. Two git adapter calls are new on every provider
  (GitHub, GitLab, Bitbucket, Azure DevOps, mock) and classified as external writes.
- The abort route now runs the first compensation on the same request and answers with the instance's `state` and
  `context` as well as its `status`.
- A denial that starts compensating runs the first compensation after the decision commits, as an approval runs the
  stage it unblocks.
- A compensation is only as complete as the template author made it: a stage with no compensation is not undone, and
  an earlier round's branch or pull request (in `effects:history`) is not touched.
- Tests: `packages/workflow-kernel` ("ADR-0340: compensation (saga) stages"), `packages/git-provider`
  (`compensation.test.ts`), `apps/gateway/src/workflows-compensation.test.ts` (denial and cancel through the routes,
  the order on the audit trail, a manual compensation, the admin-only abandon), and the external-effect barrier
  matrix (`git.close_pull_request` and `git.delete_branch` under every execution mode).
