# ADR-0340: Process-level reliability for pillar 2's runner: compensation (saga) stages, stage deadlines with SLA escalation, and process-version pinning, migration and canary

- **Status**: Accepted (builder lane E21; slice 1, compensation, slice 2, deadlines, and slice 3, versions, are built;
  slice 3 is built on ADR-0341's version store, see the 2026-11-25 addendum)
- **Date**: 2026-11-16
- **Index**: Process reliability for the workflow runner (Camunda gap 2 and 8): compensation stages run in reverse on a cancel or a denial through the ordinary executors; stage deadlines with SLA escalation (notify, reassign or fail) over pg-boss timers; process versions pinned per instance, governed in-flight migration and canary rollout. No new engine.
- **Backlog item**: `internal/product/GAP_ANALYSIS_CAMUNDA_2026-11.md` rows 2, 5 and 8; next step 3 ("process-level
  reliability … extends the ADR-0282–0286 runner, no new engine")
- **Builds on**: ADR-0254 (keep the runner; a transition and its audit row commit in one transaction, re-authorised at
  claim and commit), ADR-0282 (pg-boss), ADR-0283 (retry), ADR-0284 (the stage execution key), ADR-0232 (no BPMN
  engine), ADR-0046 and ADR-0061 (the approvals queue and ChatOps), ADR-0180 (secure by default), ADR-0176 (open
  source first), AER-048 and AER-049 (rounds, stage entries, effect records).
- **Migrations**: slice 1 none (the compensation state lives in the instance's `state` jsonb, which the kernel
  owns). Slice 2: `pending/workflow_stage_queue_deadline.sql` (the `workflow-stage-deadline` queue). Slice 3:
  `pending/workflow_template_canary_pinning.sql`. All numbered at merge (ADR-0252).

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

### Slice 3: process versions, in-flight migration and canary (decided; built after slice 2)

13. **Versions.** Every template create or change writes an immutable, numbered template version row; an instance
   records the versions it was started from (a join table, ADR-0200 3NF) beside its snapshotted definition, which
   stays the definition it runs. A running instance always finishes on its version unless it is migrated.
14. **Governed migration.** `POST …/instances/:id/migrations` with `dryRun` returns the diff (RFC 6902) between the
    instance's definition and the target version, and refuses a migration the target cannot honour (the current stage
    or a stage that ran is missing or changed type; a compensation that would be lost). Applying needs an approval in
    the approvals queue by an admin other than the requester (ADR-0195), is re-validated under the instance lock when
    approved, bumps the stage entry, and writes `workflow:instance-migrated` with both versions and the diff.
15. **Canary.** An admin may roll a new version out to a percentage (1 to 50) of NEW instances of a template; the
    choice is deterministic per instance id, recorded on the instance and audited at start
    (`workflow:canary-version-selected`); starting and stopping a canary is audited. Running instances are never
    switched by a canary.

## Consequences

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

## Addendum (2026-11-25): slice 3 is built on ADR-0341's `workflow_template_versions`

**Why.** Slice 3 was first drafted (PR #894) with template versions as ADR-0048 `config_versions` rows (a new
artifact type `workflow_template`). While it waited, ADR-0341 (the visual pipeline builder) merged its own version
store, `workflow_template_versions`, written by the builder's publish and by ADR-0357's governance apply, both of which
replace `workflow_templates.definition`. Merging the draft as it was would have given one template two version
histories and two writers of its live definition: a builder publish would have been undone for new instances (they
started on the older active `config_versions` body), and a version activated through `config_versions` would have had
no builder history. One fact lives in one place (ADR-0200), so slice 3 was rebuilt on the builder's table and the
`config_versions` artifact type was dropped. The master decided the rebuild on 2026-11-25; the new PR supersedes #894.

What changes against decisions 13 to 15:

13. **Versions** are ADR-0341's rows; slice 3 adds no version store. The version that holds a template's live
    definition serves a new instance; when a template has none yet (never opened in the builder, or written by a
    seed), the start records its live definition as the next version (`origin` `baseline`, audited
    `workflow-template-version-baseline`, the rule the builder uses for the same act). No template lock is taken on
    the start path: two starts recording the same number race on the (template, version) unique index and the loser
    reads the winner's row. Every instance is pinned in `workflow_instance_template_versions` (one row per template at
    start, one per applied migration; append-only), so every pin names a real version and the join table needs no
    template column.
14. **Governed migration** is unchanged, with the target a `workflow_template_versions` row of the instance's own
    (single) template. It is also refused when the instance already runs the target's definition (`no_change`). The
    request's reason is 10 to 500 characters. The definition hash is SHA-256 of ADR-0060's canonical JSON, the same
    hash as the version's `content_hash`.
15. **Canary.** A canary opens with a builder publish that names `canaryPercent` (1 to 50, bound into the publish's
    step-up with the other facts, so a proof for a plain publish cannot open one). The new version is the canary and
    the version it replaced is the stable one (`workflow_template_canaries`, composite foreign keys keep both versions
    on the canary's own template; at most one open per template). The bucket is `canaryBucket(template, instance)`
    from `@regulait/shared` (ADR-0048's FNV-1a), so the choice is sticky per instance. While a canary is open no other
    publish is accepted, from the builder or from governance apply (`canary_open`), so its two versions cannot move
    under it. It ends once (`CANARY_LIFECYCLE`, rule 12): **promoted** (every new instance gets the canary version) or
    **rolled back** (the stable definition is published again as the next version, `origin` `canary_rollback`, and
    becomes the live definition; a restore is a publish, ADR-0341 §5). Ending needs a reason (10 to 500 characters)
    and is audited (`workflow-template-canary-promoted` / `-rolled-back`); opening is audited
    (`workflow-template-canary-started`). A promote takes no second step-up: it widens a version whose bytes were
    already stepped up at publish. A rollback is a publish like any other (R3 review, 2026-11-25): what it weakens
    against the live definition (a stage the canary added, for example) must be accepted (`acceptRelaxations`,
    ADR-0341 §4.5; refused `relaxation_not_accepted` otherwise), and it needs the `settings_relax` step-up
    (ADR-0341 §4.6) bound to the template, the canary, the version it replaces and the content hash it restores
    (op `workflow_template_canary_rollback`). Its audit row records the relaxations, the reason and the step-up.
    While a canary is open `workflow_templates.definition` is the canary version (the builder's publish wrote it);
    the stable side is read from its version row.

Routes (admin, the default class): `GET /v1/workflows/builder/templates/:id/canary`,
`POST /v1/workflows/builder/templates/:id/canary/end`, `POST|GET /v1/workflows/instances/:id/migrations`. They are
API-only until the design builder's screens (`scripts/known-ui-gaps/adr-0340-e21-workflow-template-versions.json`).
The approvals-queue kind `workflow_migration` is decided in the one decide path, which refuses the requester
(`cannot_approve_own_workflow_migration`). Tests: `packages/workflow-kernel/src/migration.test.ts` (the plan, both
lifecycle tables) and `apps/gateway/src/workflows-template-versions.test.ts` (a pin on the recorded live version, a
canary publish bound to its share, the open-canary refusal, both sides served and audited, rollback and promote, a
migration approved by another admin and one recorded stale).
