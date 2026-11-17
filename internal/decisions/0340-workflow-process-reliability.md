# ADR-0340: Process-level reliability for pillar 2's runner: compensation (saga) stages, stage deadlines with SLA escalation, and process-version pinning, migration and canary

- **Status**: Accepted (builder lane E21; slice 1, compensation, is built; slices 2 and 3 follow in this lane under
  this ADR)
- **Date**: 2026-11-16
- **Index**: Process reliability for the workflow runner (Camunda gap 2 and 8): compensation stages run in reverse on a cancel or a denial through the ordinary executors; stage deadlines with SLA escalation (notify, reassign or fail) over pg-boss timers; process versions pinned per instance, governed in-flight migration and canary rollout. No new engine.
- **Backlog item**: `internal/product/GAP_ANALYSIS_CAMUNDA_2026-11.md` rows 2, 5 and 8; next step 3 ("process-level
  reliability … extends the ADR-0282–0286 runner, no new engine")
- **Builds on**: ADR-0254 (keep the runner; a transition and its audit row commit in one transaction, re-authorised at
  claim and commit), ADR-0282 (pg-boss), ADR-0283 (retry), ADR-0284 (the stage execution key), ADR-0232 (no BPMN
  engine), ADR-0046 and ADR-0061 (the approvals queue and ChatOps), ADR-0180 (secure by default), ADR-0176 (open
  source first), AER-048 and AER-049 (rounds, stage entries, effect records).
- **Migrations**: slice 1 none (the compensation state lives in the instance's `state` jsonb, which the kernel
  owns). Slices 2 and 3 add pending migrations, numbered at merge (ADR-0252).

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
   - a template whose `close_pr` closes a pull request that a later stage merges must compensate that merge too:
     closing cannot undo a merge, so without it a saga after the merge would fail on every retry.
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
   provider calls are idempotent (a branch already gone and a PR already closed answer `false`; on GitHub only a
   missing ref counts as gone, any other refusal such as branch protection throws). Closing a merged pull request
   throws, so the stage fails rather than claiming an undo that did not happen, with one exception: when this
   instance's own merge of that pull request was already reverted by its compensation in the same saga, and the
   provider says the pull request is merged, the `close_pr` is recorded `superseded: "merged"` and succeeds.
5. **Ending a compensation early is an admin's act.** `abort` on a compensating instance abandons the rest: the
   instance ends in its cause, `workflow:compensation-abandoned` (deny) names the compensations that never completed.
   Anyone else gets `403 compensation_abandon_requires_admin`, audited `workflow:compensation-abandon-refused`; the
   decision is taken under the instance lock.
6. **One declared lifecycle (build rule 12).** `COMPENSATION_LIFECYCLE` in the kernel lists every compensation move
   (`none → compensating → completed | abandoned`) with the instance status it implies (the compensation stage's
   resting status, the cause's terminal status, or unchanged). Every move goes through it, and the gateway refuses
   to write a state whose status disagrees with its phase. The instance UPDATE is guarded on the status and stage
   entry read under the lock.
7. **Audit.** `workflow:compensation-started` (the plan), `workflow:compensation-completed` and
   `workflow:compensation-abandoned` are written in the transition's transaction beside the event's own row. Starting
   a compensation cancels the instance's live engine runs (cause `workflow_compensating`) and supersedes its pending
   gates, as an abort or denial always did, and is a new stage entry, so a forward executor still running from before
   the cancel can never commit into the compensation.

### Slice 2: stage deadlines and SLA escalation (decided; built next)

8. A stage may carry `sla: { breachAfterSeconds, warnAfterSeconds?, onBreach: "notify" | "reassign" | "fail",
   reassignTo? }`, bounded, absent by default. `reassign` only on a `human_approval` stage; `fail` cancels the
   instance (and so compensates it, decision 2). A timer is a pg-boss job sent in the transaction that enters the
   stage, keyed by the stage execution key (ADR-0284), so it exists if and only if the entry committed and a stale
   timer finds a different key and does nothing.
9. **The escalation contract with lane E23 (its process-analytics ADR, PR #888): one escalation mechanism for human tasks.** A sign-off is a
   row in the one approvals queue, and its timed escalation is the ADR-0046 SLA sweep over `approval_assignments`.
   - On a `human_approval` stage, E21 does not escalate the task itself. When the stage is entered, E21 sets each of
     the stage's pending tasks' warn time, due time (and, from the stage's `sla`, the escalation target for `reassign`)
     through the one `workbench.ts` function lane E23's slice 2 provides. The sweep then warns, breaches and escalates
     (`notify_only`, `reassign`, `add_assignee`), audits it and never decides. A re-entry of the stage sets the due
     time of its new tasks; a superseded task's clock stops with it.
   - The one human-stage action that is not a task escalation stays E21's: `onBreach: "fail"` cancels the INSTANCE
     (and so compensates it, decision 2). E21 keeps a breach timer for it, keyed by the stage execution; when it fires
     on a stage still resting at that entry it applies `abort` as the system actor `workflow-sla`. The pending tasks are
     superseded by the abort, never denied.
   - On every other stage (an artifact, a plan, a manual trigger, an executed stage), the timer and its action
     (`notify` or `fail`) are E21's own, through `applyEvent` under the instance lock, audited `workflow:sla-warned`,
     `workflow:sla-breached` in that transaction. These are not task escalations and do not touch the approvals queue.
   - A timer that cannot be sent is audited and the stage simply has no deadline, never a blocked transition. The
     worker follows ADR-0283's switch.

### Slice 3: process versions, in-flight migration and canary (decided; built after slice 2)

10. **Versions.** Every template create or change writes an immutable, numbered template version row; an instance
   records the versions it was started from (a join table, ADR-0200 3NF) beside its snapshotted definition, which
   stays the definition it runs. A running instance always finishes on its version unless it is migrated.
11. **Governed migration.** `POST …/instances/:id/migrations` with `dryRun` returns the diff (RFC 6902) between the
    instance's definition and the target version, and refuses a migration the target cannot honour (the current stage
    or a stage that ran is missing or changed type; a compensation that would be lost). Applying needs an approval in
    the approvals queue by an admin other than the requester (ADR-0195), is re-validated under the instance lock when
    approved, bumps the stage entry, and writes `workflow:instance-migrated` with both versions and the diff.
12. **Canary.** An admin may roll a new version out to a percentage (1 to 50) of NEW instances of a template; the
    choice is deterministic per instance id, recorded on the instance and audited at start
    (`workflow:canary-version-selected`); starting and stopping a canary is audited. Running instances are never
    switched by a canary.

## Consequences

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
