# ADR-0340: Process-level reliability for pillar 2's runner: compensation (saga) stages, stage deadlines with SLA escalation, and process-version pinning, migration and canary

- **Status**: Accepted (builder lane E21; all three slices built: compensation, deadlines, and versions with
  migration and canary)
- **Date**: 2026-11-16
- **Index**: Process reliability for the workflow runner (Camunda gap 2 and 8): compensation stages run in reverse on a cancel or a denial through the ordinary executors; stage deadlines with SLA escalation (notify or fail) over pg-boss timers; process versions pinned per instance, governed in-flight migration and canary rollout. No new engine.
- **Backlog item**: `internal/product/GAP_ANALYSIS_CAMUNDA_2026-11.md` rows 2, 5 and 8; next step 3 ("process-level
  reliability … extends the ADR-0282–0286 runner, no new engine")
- **Builds on**: ADR-0254 (keep the runner; a transition and its audit row commit in one transaction, re-authorised at
  claim and commit), ADR-0282 (pg-boss), ADR-0283 (retry), ADR-0284 (the stage execution key), ADR-0232 (no BPMN
  engine), ADR-0046 and ADR-0061 (the approvals queue and ChatOps), ADR-0180 (secure by default), ADR-0176 (open
  source first), AER-048 and AER-049 (rounds, stage entries, effect records).
- **Migrations**: slice 1 none (the compensation state lives in the instance's `state` jsonb, which the kernel
  owns). Slice 2: `pending/workflow_stage_queue_deadline.sql` (the `workflow-stage-deadline` queue). Slice 3:
  `pending/workflow_template_versions.sql` (the `workflow_template` artifact type on `config_versions`, and the
  `workflow_instance_template_versions` and `workflow_instance_migrations` tables). All numbered at merge (ADR-0252).

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

### Slice 2: stage deadlines and SLA escalation (built)

8. A stage may carry `sla: { breachAfterSeconds, warnAfterSeconds?, onBreach: "notify" | "fail" }`, strict, bounded
   (one minute to 90 days, the warning before the breach), absent by default. `fail` cancels the instance, and so
   compensates it (decision 2). Not allowed on a trigger, a rollback or a compensation stage. A deadline is per stage
   ENTRY: a stage re-entered (a re-open, a recheck) gets fresh timers. On a `human_approval` stage only
   `{ breachAfterSeconds, onBreach: "fail" }` is accepted (decision 9).
9. **The escalation contract with lane E23 (ADR-0342 decision 8): one escalation mechanism for human tasks.** A sign-off is a
   row in the one approvals queue, and its timed escalation is the ADR-0046 SLA sweep over `approval_assignments`.
   - On a `human_approval` stage, E21 does not remind or escalate the task itself. A task's reminder, due time and
     escalation target come from the approvals queue's SLA policy, set (once ADR-0342 slice 2 lands) through the one
     `workbench.ts` function it provides; the sweep then warns, breaches and escalates (`notify_only`, `reassign`,
     `add_assignee`), audits it and never decides. Until that function is on main, a stage `sla` with a reminder or
     `notify` on a sign-off is refused at validation rather than accepted and silently not honoured; wiring the
     stage's deadline to the task's due time is a follow-up of this ADR once it lands.
   - The one human-stage action that is not a task escalation stays E21's: `onBreach: "fail"` cancels the INSTANCE
     (and so compensates it, decision 2). E21 keeps a breach timer for it, keyed by the stage execution; when it fires
     on a stage still resting at that entry it applies `abort` as the system actor `workflow-sla`. The pending tasks are
     superseded by the abort, never denied.
   - On every other stage (an artifact, a plan, a manual trigger, an executed stage), the timer and its action
     (`notify` or `fail`) are E21's own, through `applyEvent` under the instance lock, audited `workflow:sla-warned`,
     `workflow:sla-breached` in that transaction. These are not task escalations and do not touch the approvals queue.
10. **Timers are pg-boss jobs on the `workflow-stage-deadline` queue** (policy `exclusive`), sent in the transaction
   that enters the stage, so a timer exists if and only if the entry committed. A job carries ids only and its
   singleton key is the stage execution key (ADR-0284) plus the phase (`warn`, `breach`). The entry also records the
   `sla:<stage>` marker (`executionKey`, `phase`, `warnAt`, `dueAt`, `onBreach`) on the instance and
   `workflow:sla-scheduled`; a queue that cannot take the job is audited `workflow:sla-not-scheduled` (deny) and the
   transition still commits, with no deadline. The worker starts on the boot path beside the retry worker, under the
   same switch. The marker's phases are one declared table in the kernel (build rule 12, `STAGE_DEADLINE_LIFECYCLE`):
   `none → scheduled | unscheduled`, `scheduled → warned → breached`, `scheduled → breached`; any other move is refused.
11. **A firing timer acts only if the instance still rests at that stage execution** (same stage, round and entry; not
   ended, not compensating) and the lifecycle table allows that phase from the marker's current one, decided under
   the instance lock with the marker and the audit row in one transaction; otherwise it does nothing. The actor is
   the system actor `workflow-sla`.
   - `warn`: `workflow:sla-warned` and a reminder.
   - `breach`: `workflow:sla-breached` (deny), then `notify` (a notice) or `fail` (the kernel's `abort`, which
     supersedes the gates and compensates; the first compensation runs after the commit through the ordinary executor
     and its guard).
   - A deadline never approves or denies a sign-off: a failure cancels the instance, whose pending rows are
     superseded, not denied.
12. **Notices** go through a courier ChatOps registers per database handle (as for governance alerts, ADR-0162, and
    the alert SLA sweep): an alert card with a content-free text and a link to the instance, to the workspaces opted
    into alerts (a reminder is `medium`, a breach `high`); a resend workspace mails the instance's initiator, never
    anyone a request names. Each post is audited `chatops-workflow-sla-posted` or `-post-failed`. A notice is sent
    after the commit and never fails the timer; a deployment without ChatOps posts nothing.

### Slice 3: process versions, in-flight migration and canary (built)

13. **Versions are ADR-0048 config versions.** `workflow_template` is a `config_versions` artifact type, so a template
    gets immutable numbered versions, the append-only activation ledger, rollback and canary through the existing
    `/v1/config-versions/workflow_template/:templateId` routes (admin). A version body passes every check a new
    template passes (`validateWorkflowTemplateDefinition`: the kernel schema, eval datasets, review agents, approvers,
    nested run graphs); a retired template takes no versions. Activating a version rewrites the template row (its
    read model) in the activation's transaction, and a version that turns automatic retry on is audited
    `workflow:template-stage-retry-enabled` exactly like a new template (ADR-0283 owner decision).
14. **Pinning.** An instance starts on each template's RESOLVED version (ADR-0048's resolver), runs its snapshotted
    definition to the end, and records what served it in `workflow_instance_template_versions` (a row per template
    at start, a row per applied migration; a NULL version means the template had no history yet). A template edit
    never reaches a running instance.
15. **Canary over new instances.** `workflow_template` is a LIVE canary type: while a canary runs, a new instance is
    served the canary when its bucket (`fnv1a(templateId:instanceId) % 100`) is under the percentage (1 to 99), so the
    choice is sticky per instance; it is recorded on the pin and audited `workflow:canary-version-selected`. Starting,
    adjusting, promoting and ending a canary are ADR-0048's own audited acts. A canary never switches a running
    instance. Promotion follows ADR-0048's gate (an eval run, or an override with a reason, audited); activating a
    version directly is the plain path.
16. **Governed migration.** `POST /v1/workflows/instances/:id/migrations` (admin) answers a dry run by default: the
    kernel's `planInstanceMigration` and the RFC 6902 diff (`definitionDiff`, the pinned `rfc6902`). The kernel
    refuses a migration of an ended or compensating instance, one that removes or changes a stage already reached,
    changes the current stage at all, reorders reached stages, adds a stage before the current one (it would be
    skipped), or drops the compensation of a stage that ran; and the gateway refuses an instance merged from several
    templates. `dryRun: false` with a reason files the request (`workflow_instance_migrations`, one open per
    instance, the reviewed plan kept as evidence) and one `workflow_migration` row in the approvals queue for every
    other active admin; `workflow:migration-requested`. The one decide path refuses the requester
    (`cannot_approve_own_workflow_migration`, whatever delegation or override says), closes the other rows on the
    first decision, and applies an approval in the decision's transaction: it re-plans under the instance lock and
    applies only if the plan still holds and the definition has not moved, replacing the definition and state (stage
    statuses follow the stage ids), bumping the stage entry, pinning the new version and re-arming the current stage's
    deadline, audited `workflow:instance-migrated` with both versions, both definition hashes and the diff; otherwise
    `workflow:migration-stale` (deny) and nothing changes. A denial changes nothing (`workflow:migration-denied`).
17. **One declared migration lifecycle (build rule 12).** A migration request's status is one kernel table,
    `MIGRATION_LIFECYCLE`: `pending → applied | denied | stale`, and nothing leaves a terminal status. The decide path
    moves a request only through `nextMigrationStatus`, and its UPDATE is guarded on `status = 'pending'`, so a second
    decision or a replayed apply changes nothing.

## Consequences

- Slice 3 adds two routes, both API-only for now (`scripts/known-ui-gaps/adr-0340-e21-workflow-migrations.json`, the screen is #453), and a `workflow_migration`
  approvals-queue kind. Tests: kernel ("ADR-0340 slice 3: planInstanceMigration"), shared (the live canary mode of
  `workflow_template`) and `apps/gateway/src/workflows-versions.test.ts` (a version checked like a template; the
  canary serving a share of new instances, pinned and audited; a migration that only another admin can approve,
  including the requester's refused override, and that then runs on; a refused migration; a stale one).
- Slice 2 adds no route either; `GET /v1/workflows/instances/:id` shows the `sla:<stage>` marker (when it is due,
  when it warned and breached). Slice 2's tests: kernel validation ("ADR-0340 slice 2: stage deadlines") and
  `apps/gateway/src/workflows-sla.test.ts` (the queued timers and their delays, a reminder that runs once, a stale
  timer that does nothing, a failure on a sign-off that cancels and compensates as `workflow-sla` without deciding
  it, a notice to the initiator, a refused template). The deadline lifecycle table is pinned in the kernel tests.
- A sign-off stage's own reminder and due time wait for ADR-0342 slice 2's `workbench.ts` function (decision 9);
  until then such a template is refused.
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
