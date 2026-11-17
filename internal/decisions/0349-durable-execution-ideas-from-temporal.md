# ADR-0349: Five durable-execution ideas borrowed from Temporal, built inside pillar 2's own runner

- **Status**: Accepted (builder lane E30; slice 1 built, slices 2–5 follow in their own PRs)
- **Date**: 2026-11-17
- **Index**: Five durable-execution ideas from Temporal, built in pillar 2's own runner (owner, 2026-11-17; ADR-0254 stands, Temporal is not adopted): a replay regression check of recorded histories in CI, a start-conflict policy (one open instance per template + target + work item, refused 409 by default), a heartbeat that renews a stage claim under a short lease plus a schedule-to-close limit, workflow schedules on the ADR-0064 scheduler with overlap, catch-up, pause and backfill, and typed instance search with a per-instance pending-work view.
- **Backlog item**: owner decision 2026-11-17 (lane E30), after a Temporal.io comparison
- **Builds on**: ADR-0254 (the stage runner stays), ADR-0282 (pg-boss), ADR-0283 (retry), ADR-0284 (the stage execution
  key), ADR-0285/0286 (fan-out and limits), ADR-0064 (in-process scheduler), ADR-0079 (plan-only stage), ADR-0161
  (deploy gate), ADR-0176 (open source first), ADR-0180 (secure by default), ADR-0186 A (`settings_relax` step-up),
  ADR-0226 (the list contract), ADR-0252 (migrations numbered at merge), and lane E29's declared state machines (PR #920).
- **Neighbours, kept separate**: lane E23's process analytics (PR #888: it replays live history and flags
  `diverged`), and lane E21's compensation, stage SLAs, template versions and canary (PRs #885, #891, #894). Stage SLA is a business
  deadline for people and parties outside the engine; the execution limits here bound the engine's own work.
- **Migrations**: none in slice 1. Slices 2–5 each add a pending migration (ADR-0252), named in their PRs.

## Context

The owner compared pillar 2's runner with Temporal.io (2026-11-17) and queued five of its ideas. Temporal itself is
not adopted, and ADR-0254's verdict stands. Its server is MIT, but it is a second stateful cluster in every BYOC and
air-gapped install, and it sits outside our row-level security and outside the transaction that writes each audit
row. `@temporalio/testing` downloads a server binary at test time, which fails air-gapped. `@temporalio/worker`
bundles a Rust core and a V8 sandbox, which is too heavy for a gateway process. We take the ideas, not the
libraries.

What the runner already has, so that nothing here duplicates it:

- `packages/workflow-kernel` `transition()` is a pure fold. `apps/gateway/src/workflows.ts` `applyEvent` commits each
  transition, its `workflow_events` row and its audit row in one transaction, under `SELECT … FOR UPDATE`.
- Retry with backoff, idempotent stage executions, fan-out and concurrency limits run over pg-boss (ADR-0282–0286).
- An executor claims a stage in `workflow_instances.context` (`executing`, `executingSince`, `executingEntry`,
  `executingClaim`). The claim expires after `REGULAIT_WORKFLOW_CLAIM_TTL_MS`, 15 minutes by default (REL-06).
- `GET /v1/workflows/instances` has the ADR-0226 list contract (sort, keyset, export), with one filter: status.
- The ADR-0064 scheduler runs sweeps under a database lease. It does not start workflows.

## Decision

### 1. Replay regression check in CI (slice 1, built)

Temporal replays recorded histories against new workflow code, so a change that would make a running workflow
behave differently fails before it ships. Our equivalent is smaller, because our "workflow code" is the kernel plus
the instance's snapshotted definition.

- **One replayer.** The check uses ADR-0342's `replayHistory(definition, history, stored)` (lane E23, PR #888), the
  kernel's one pure replayer, shared with process analytics. It folds the events through `transition()` from
  `initialState()` and reports `ok` with every step, or `diverged` / `too_long`. Slice 1 first shipped its own fold
  next to it; the code review asked for one replayer, so that copy was removed and this check stacks on PR #888.
- **Recorded fixtures.** `packages/workflow-kernel/replay-fixtures/*.json` hold histories in the exact shape of
  `workflow_events.event`, each with the definition snapshot it ran on (defaults applied, as
  `workflow_instances.definition` stores it) and the state and status trail recorded with it. The first ten cover
  both shipped pipeline shapes (intake to merge, and governed deploy with verify and rollback), every event kind and
  every status an instance can rest in.
- **The check.** `replay-fixtures.test.ts` runs in the kernel suite, which CI runs on every PR. For every fixture:
  - the snapshot still passes `validateDefinition`;
  - `replayHistory` replays it `ok`, in recorded order, and every step rests in the recorded status;
  - the final state equals the recorded one in full (not only the parts `replayHistory` compares).

  Compile-time lists make the coverage test ask for a new fixture whenever an event kind or a resting status is added
  to the kernel.
- **A fixture is never re-recorded to make CI pass.** `scripts/record-replay-fixture.mjs` records new fixtures only:
  it refuses to overwrite one. A deliberate behaviour change ships with an ADR that says what happens to instances
  already in flight (finish on the old rule, a governed migration under lane E21's versioning (PR #894), or aborted with a reason). Only then
  is the affected fixture replaced, in the same PR.

### 2. Start conflict policy (slice 2)

Temporal's workflow-id reuse policy refuses a second running workflow with the same id. Ours: **at most one open
instance per template set + target + work item.**

- **The key.** `POST /v1/workflows/instances` takes an optional `workItem` (the PM tool's item key, at most 200
  characters, a verbatim external identifier). With a work item, the start key is the routed template SET (the
  ids in any order), `change.targetSystem` (null counts as a value) and the work item. Without a work item there is no
  identity to deduplicate on, and the start behaves as before.
- **Enforced in the database.** A partial unique index over `workflow_instances` (template ids, target and work
  item, `NULLS NOT DISTINCT`, `WHERE status NOT IN` the four terminal statuses, and only where a work item is set).
  An instance that ends frees its key. A race between two starts ends with one insert and one unique violation,
  which is caught and answered like the pre-check.
- **Refused by default (ADR-0180).** A conflicting start answers **409 `workflow_start_conflict`** with the existing
  instance's id and status, and writes a `workflow:start-conflict` audit row (deny).
- **"Use existing" is the admin relaxation.** It is the org setting `workflowStartConflictPolicy`
  (`refuse` | `use_existing`). Relaxing it is a `settings_relax` step-up and is audited through the strictness
  registry. Under `use_existing` the start answers 200 with the existing instance (`reused: true`) and audits
  `workflow:start-reused`. It never returns an instance the caller may not read: a caller who is neither its
  initiator nor an admin gets the 409 with no instance id.

### 3. Heartbeat and lease renewal, plus a schedule-to-close limit (slice 3)

Temporal's activity heartbeat lets a short timeout detect a dead worker while a long activity still runs.

- **Short lease, renewed.** An executor renews its claim every third of the lease while a stage or provider call runs.
  The lease (`REGULAIT_WORKFLOW_CLAIM_LEASE_MS`, default 60 s, bounds 15 s to 15 min) replaces the 15-minute TTL as the
  liveness test, so a dead worker's stage is taken over within about a minute instead of fifteen. This narrows the
  REL-06 double-effect window: a live but slow executor keeps its claim instead of losing it at 15 minutes.
- **Every renewal is a guarded UPDATE**: `WHERE id = $instance AND status = 'awaiting_execution' AND stage_entry =
  $entry AND context->>'executingClaim' = $claimId`, setting `executingRenewedAt` from the database clock (M-075). A
  renewal that matches no row means the claim was lost: the executor stops renewing, and its result is already
  discarded at commit by the existing claim guard (AER-048).
- **One liveness predicate.** `stageClaimState` reads `executingRenewedAt` (else `executingSince`) against the lease.
  It is the only definition used by the claim, the takeover audit and the pending-work view.
- **Schedule-to-close.** `REGULAIT_WORKFLOW_EXECUTION_MAX_MS` (default 2 h, bounds 1 min to 24 h) bounds one execution
  from its claim, however often it renews. Past it, the executor stops renewing and the stage fails with
  `execution_failed` ("execution limit reached"). That failure is retryable, so the stage's ADR-0283 policy applies
  and the outcome is audited.

### 4. Workflow schedules (slice 4)

Temporal Schedules start a workflow on a calendar, with overlap, catch-up, pause and backfill.

- **A schedule** belongs to one template and holds a cron expression and time zone, the change it starts (validated
  as a start body is), a project, and a run-as user. The run-as user is the admin who created it; a schedule never
  runs as a system identity. Each start goes through the normal governed start path (entitlements, project
  attribution, budget, assignment, audit) as that user. A disabled or deleted user, a retired template or a refused
  start pauses the schedule with the reason, audited.
- **Driver.** One ADR-0064 scheduler job, `workflow-schedules`, under its existing database lease, so a second
  replica does not double-fire. The cron parser is `cron-parser`, already in the tree as a pg-boss dependency, made
  a direct, exact-pinned dependency. No second scheduler is added.
- **Overlap.** `skip` is the default: no start while the schedule's previous instance is still open. `buffer_one`
  (start once the open instance ends) and `allow` are audited relaxations with a step-up.
- **Catch-up window.** After downtime, fire times missed within the window (default 0, at most 7 days) start once
  each, oldest first; older ones are skipped and audited as one row.
- **Jitter.** Up to the schedule's `jitterSeconds` (default 0, at most 1 hour), derived from the schedule id and the
  fire time, so it is deterministic and spreads schedules that share a cron expression.
- **Pause, resume and backfill.** Pause and resume each take a note and are audited. Backfill starts one instance per
  fire time in a range (at most 100), as the schedule's user, under the overlap policy, and is audited.
- **Exactly once per fire time.** A row in `workflow_schedule_runs`, unique on (schedule, fire time), is inserted in
  the start's transaction.

### 5. Visibility: typed search and a pending-work view (slice 5)

Temporal's visibility store gives indexed search attributes and a "pending activities" view.

- **Typed search fields** on the versioned list `GET /v1/workflows/instances` under the ADR-0226 contract: template,
  target, work item, owner (initiator), current stage, status, deadline and compliance tag. Each field is a column or
  join with an index, never an unindexed jsonb scan. Pages are bounded and keyset-paginated, as the contract already
  does. Non-admins see only what they may see today.
- **Pending work, per instance**: `GET /v1/workflows/instances/:id/pending`, read-only. It reports the claim holder,
  attempt, next retry, lease expiry, deadline (from lane E21's stage SLA, PR #891, when present) and a machine-readable `waitingOn`. The
  reasons are approval, artifact, plan, trigger, execution, retry, check report, deploy handoff and nothing. Each
  comes with a plain sentence, and the instance lifecycle is described through lane E29's `describe` (PR #920).
- **No screens.** The design builders build the UI. Both routes get KNOWN_UI_GAPS entries pointing at #453.

### State machines (lane E29, PR #920)

The instance lifecycle is the kernel's `transition()`, which is already one declared function. Slices 2–5 add no
status field of their own except the schedule's `state` (`active` | `paused`). That machine is declared with
lane E29's `MachineDef` (PR #920) and its guarded writes, not with a new helper.

## Consequences

- A kernel change that would move an in-flight instance fails the kernel suite in CI, with the fixture, the event
  and the field that moved. Coverage grows by adding fixtures. The first kernel PR that adds an event kind (for example
  lane E21's compensation events, PR #885) adds a fixture that uses it.
- The fixtures cover the kernel, not the gateway's write path. Live data belongs to lane E23's analytics (PR #888): its projection replays
  `workflow_events` and flags `diverged`. One gap is recorded: `workflow_events` has no sequence column, so events
  committed in one transaction share a timestamp, and their order is reconstructed rather than stored (lane E23's analytics, PR #888,
  bounds that reordering). Filed as issue #924 (`triage-low`, F 2 × S 2 = 4), not built here.
- Slices 2–5 change the start route, the executor's claim and the list route. Each lands as its own small PR with
  its own tests and migration.

## Alternatives considered

| | Fit | Verdict |
|---|---|---|
| Temporal server + TypeScript SDK (MIT) | Every idea built in, but a second stateful cluster per install, outside RLS and our audit transaction; test server downloaded at test time | Rejected (ADR-0254 stands) |
| Restate (BUSL-1.1 server) | Similar model; licence not allowed under ADR-0176 | Rejected |
| DBOS Transact (MIT, Postgres) | Durable steps in our Postgres, but its own system tables and recovery loop, beside the runner we keep | Rejected for the same reasons as `vercel/workflow` (ADR-0254 criterion 3) |
| Ideas inside our runner, on pg-boss and the ADR-0064 scheduler | No new runtime, our RLS and audit, air-gapped | **Chosen** |

## As built

Slices 2–5 are separate PRs (#927 for slice 2; slices 3–5 follow). Where the build differs in detail from the decisions
above, it is recorded here, against the decision it refers to.

- **Decision 2 (start conflict), PR #927.** As decided. The key compares the template SET: `regulait_workflow_template_set(jsonb)`, an immutable SQL function, sorts the ids in byte order, and the unique index and the lookup use the same expression (code review: routing order must not let one set start twice). The open-instance predicate is built from the one declared terminal-status list.
  A race is answered like the pre-check, because the insert runs under a savepoint, so a caller's own transaction
  survives the unique violation.
- **Decision 3 (heartbeat).**
  - The claim is now also *taken* on the database clock (`databaseNow`), not only renewed on it, so the one
    liveness predicate compares like with like.
  - The older `REGULAIT_WORKFLOW_CLAIM_TTL_MS` is still read when the new variable is unset, within the same bounds.
  - The limit failure is committed by the heartbeat itself through `commitStageResult` (the claim guard). It is
    audited `workflow:execution-limit-reached`, and the executor's late result is then discarded by the existing
    discard path.
- **Decision 4 (schedules).**
  - *"Declared with lane E29's `MachineDef`"*: the schedule has no status column. It is paused exactly when
    `paused_at` is set (with `paused_by_user_id` and `pause_note`), and the API derives `state: active | paused` from
    that. Two states held by one nullable timestamp have no transition table to declare, so no machine helper is used.
  - *"Catch-up window (default 0)"*: a fire time is on time within `max(5 minutes, window)`. Otherwise a default
    schedule would treat its own fire as missed whenever the 60-second sweep ran a little late.
  - A start refused with `workflow_start_conflict` is recorded on the run and audited, but does not pause the
    schedule: the open instance is the schedule's overlap, not a broken schedule.
  - `POST /v1/workflows/schedules/run-due` runs the same sweep on demand, as the other ADR-0064 jobs have.
  - There is no delete route: pause is enough, and a schedule's runs are its evidence.
- **Decision 5 (visibility).**
  - The search fields are query parameters of the existing list (legacy answer and ADR-0226 contract).
  - *Deadline* is in the pending view, read from lane E21's `sla:<stage>` marker (PR #891). It is not yet a search
    field, because that marker is a context key. It becomes one when the due time is a column, which is recorded as
    a PENDING item.
  - The `describe` transitions of lane E29 (PR #920) join the pending view once that helper merges.
