# ADR-0342: Process analytics and human-task SLAs (cycle time, wait vs work, bottlenecks, heatmaps, task priority and due dates)

- **Status**: Accepted (owner direction 2026-11-16, lane E23 brief from the Camunda gap analysis; slices 1 and 2 built)
- **Date**: 2026-11-16
- **Index**: Process analytics: a measured read model replayed from `workflow_events` through the workflow kernel, served by versioned, bounded, scope-checked APIs (per-template and per-stage cycle time, wait vs work, throughput, rework, bottleneck ranking, heatmap)
- **Built in**: lane E23, branch `builder/e23-process-analytics`
- **Migration**: `pending/process_analytics.sql` (slice 1) and `pending/approval_task_priority.sql` (slice 2), numbered at merge (ADR-0252)
- **Related**: ADR-0041 (single tenant per deployment), ADR-0047 (reporting entitlement decision, reused), ADR-0049 (forecasting and anomalies), ADR-0046 (review
  workbench: approval assignments, SLA policies and the SLA sweep), ADR-0064 (scheduler), ADR-0200 (measured read
  model), ADR-0234 (row-level security), ADR-0180 (secure by default), ADR-0176 (open source first)

## Context

The Camunda gap analysis (`internal/product/GAP_ANALYSIS_CAMUNDA_2026-11.md`, rows 5 and 9) found two gaps:

- **Process analytics.** Trust, executive and cost reports exist (ADR-0047, ADR-0049), but nothing answers "how long
  does a change take per template, where does it wait, which stage is the bottleneck, how often is work sent back".
- **Human tasks.** The approvals queue (ADR-0046) already has routed assignment, warn and due times from SLA policies
  and an SLA sweep that escalates (`add_assignee`, `reassign`, `notify_only`, never auto-decide). What it lacks is a
  task priority, a per-task due date that is not only derived from a policy, and a hook another lane's stage timers can
  drive.

The workflow engine records every state change in one place: `applyEvent` (apps/gateway/src/workflows.ts) locks the
instance, runs the pure kernel `transition`, stores the new state and appends the event to `workflow_events` and the
audit chain. Every number analytics needs can be derived from that history, because the kernel is deterministic: replaying
the events against the instance's snapshotted definition reproduces the status and current stage after each event.

**Search first (ADR-0176).** Process-mining libraries: PM4Py (AGPL-3.0, Python), ProM (GPL), Apromore (LGPL and
commercial) and bupaR (R) are excluded by licence or runtime; no maintained JavaScript or TypeScript library exists.
None of them knows our kernel, so each would need its own event-log export and still could not tell wait from work.
In the repo, the reporting entitlement decision (`evaluateReportAccess`, ADR-0047), the scope resolvers in
`reporting.ts`, the scheduler (ADR-0064) and PostgreSQL's ordered-set aggregates (`percentile_cont`) cover everything
else. No new dependency.

## Decision

### Slice 1: the read model and the analytics API (built)

1. **Source of truth: the workflow history, replayed.** `projectProcessAnalytics` takes each instance whose
   `updated_at` or (live) project changed since its last projection, loads its events (time order, insert order for
   ties) and replays them through `transition` from `initialState`. Events written in one transaction share a
   timestamp (`now()` is the transaction start); when the kernel refuses the stored order inside such a group, the
   replay tries the other orders of that group (at most 8 events, a bounded search). The replay is accepted only if its
   final state equals the stored `workflow_instances.state`. Otherwise the instance is `diverged`; with more than 5,000
   events it is `too_long`. Either way it has no spans and every response counts it under `excluded`, so no figure
   is built on a history we could not reproduce.

   The replayer is pure and lives in the kernel (`packages/workflow-kernel/src/replay.ts`, `replayHistory`): events in,
   `ok` with every step's state before and after, or `diverged`, or `too_long`. It owns the ordering and divergence
   rules, so every consumer (these analytics, lane E30's CI replay check) applies the same ones. Analytics policy (wait
   vs work, span exits) stays in the gateway. The kernel also declares the one terminal-status set
   (`TERMINAL_STATUSES`, `isTerminalStatus`), which the kernel's own checks and the analytics import; the migration's
   SQL CHECK repeats it and says so.

2. **Spans, wait and work.** Between two events the instance holds the status and stage the earlier event left it in.
   That interval belongs to the span of that stage visit and is:
   - **wait** when the status needs a person or an outside party (`blocked_on_approval`, `blocked_on_artifact`,
     `blocked_on_plan`, `awaiting_trigger`, `blocked_on_check`, `blocked_on_deploy`);
   - **work** when the engine is executing the stage or it is queued for an executor (`running`,
     `awaiting_execution`).

   A span ends `advanced` (to a later stage), `reworked` (back to an earlier stage, or a failed check re-run, or a
   re-open) or `ended` (terminal status). A re-opened terminal instance is open again. `visit` counts repeat visits.

3. **The tables (3NF, with the read-model exceptions stated on the columns).** `process_analytics_instances` (one per
   instance: start, end, terminal status, replay status, change detector), `process_analytics_instance_templates` (a
   join table: a merged instance has several templates) and `process_analytics_stage_spans`. The exceptions are
   `project_id` (the row-level security key, re-synced by the projector when the instance's project changes) and the
   stage id and type (point-in-time, from the snapshotted definition). Everything can be dropped and rebuilt.

4. **Measured (ADR-0200 addendum).** A synthetic history (4 stages, one rework, 6 events per instance) on the local
   PostgreSQL 16, stage ranking over the whole window:

   | instances | events | replay on every request | read-model query | full projection (once) |
   | --- | --- | --- | --- | --- |
   | 5,000 | 30,000 | 176 ms | 34 ms | 15.5 s (10 passes) |
   | 20,000 | 120,000 | 655 ms | 163 ms | 60.8 s (40 passes) |

   The per-request replay grows with all history in scope and repeats the tie search on every read; the read model is
   about four times faster and the projection runs once per change (about 3 ms per instance). JIT compilation added
   about 320 ms to a 36 ms aggregate (the row-level security sub-plans push the cost estimate past `jit_above_cost`),
   so every read runs with `SET LOCAL jit = off`.

5. **The projector.** One idempotent pass rebuilds at most 500 instances, oldest change first. It runs as the
   `process-analytics-projector` scheduler job every five minutes under `system_task`, and from
   `POST /v1/process-analytics/refresh` (admin, audited). The change detector is `updated_at` copied as text, so its
   microseconds survive. The projector only reads workflow state and is never in a decision path. Figures lag the
   engine by up to one interval.

6. **The API (versioned, bounded, paginated).** All four reads take `scope` (`org`, `team` or `project`, with
   `scopeId`), optional `templateId`, and a window `from`/`to` (default the last 30 days, at most 366). Unknown
   parameters are refused.
   - `GET /v1/process-analytics/templates`: per template, instances started and ended (by terminal status), cycle
     time p50, p90 and mean, rework rate, open instances. `limit` 1 to 200, `offset`.
   - `GET /v1/process-analytics/stages`: per stage, visits, duration p50 and p90, wait and work (total and mean),
     share of all wait, rework count and rate, open visits and the oldest. Ranked by total wait (the bottleneck
     ranking). `limit` 1 to 200, `offset`.
   - `GET /v1/process-analytics/heatmap`: the top `limit` (1 to 50) stages by wait, one cell per stage and period
     (`bucket` day, week or month): visits, median duration, wait.
   - `GET /v1/process-analytics/throughput`: per period, instances started and ended by terminal status.

   A heatmap or throughput response has at most 400 periods. Periods are UTC. A stage visit counts in the period it
   ended; an instance counts as started and ended in the periods those happened. Every response carries `excluded`,
   `lastProjectedAt` and a `basis` statement. The routes are `internal` in the OpenAPI registry.

7. **Authorisation (secure by default, ADR-0180).**
   - Every read applies the ADR-0047 decision (`evaluateReportAccess`) with the requested scope as both scope and
     grant. `scope=org` is admin-only and is the only path to instances with no project. A team or project read is
     narrowed to the projects in scope the caller is a member of, at query construction, and refused when that set is
     empty.
   - Row-level security is enabled and forced on all three tables. An admin, `system_task` and `migration` read every
     instance row; any other principal reads only rows of projects it is a member of. Spans and template links are
     readable exactly when their instance row is. Only an admin or `system_task` writes. With no principal and no system
     context a transaction sees nothing.
   - A refused read is audited (`process-analytics-read-refused`). So is every cross-project read (org or team scope).
     A member's project read is not, to keep dashboard polling out of the chain. The four reads are in
     `NON_ADMIN_ROUTES` and check in the handler; refresh is admin-only.
   - The deployment is single-tenant (ADR-0041; ADR-0234 found no tenant key), so the row-level security scope is the principal and its project
     memberships. No figure aggregates beyond the caller's visible projects.

### Slice 2: human-task priority, due date and the escalation contract (built)

8. **One escalation mechanism.** Human tasks are rows in the one approvals queue, and their timed escalation stays the
   ADR-0046 SLA sweep (`runApprovalSlaSweep` over `approval_assignments`). Slice 2 adds to the assignment (pending
   migration `approval_task_priority`):
   - `priority` (`low`, `normal` default, `high`, `urgent`): it orders the queue (`sort=priority`, and `sort=due` for
     the due time) and decides nothing;
   - `due_source` (`policy`, the ADR-0046 derivation; `explicit`, set by an admin; `stage_timer`, set by a workflow
     stage timer), plus a CHECK that a warn time never follows the due time.

   **The one setter.** `scheduleApprovalTask(db, approvalId, { priority?, dueAt?, warnAt?, slaPolicyId? }, ctx)` sets
   a pending task's priority, due and warn times and escalation policy, then runs the ordinary ADR-0046 evaluation, so
   a due time already passed warns, breaches and escalates exactly once, the usual way, and never approves or denies.
   `PUT /v1/approvals/:approvalId/schedule` (admin) calls it. `scheduleStageApprovals(db, { instanceId, stageId },
   input, { actorUserId, systemActor })` is the stage-timer entry point: it schedules every pending task of one
   workflow stage.

   **Secure by default (ADR-0180).** A tightening (earlier due, higher priority, a notify-only policy where there was
   none) is audited (`approval-task-scheduled`). A loosening needs a `settings_relax` step-up and is audited as a
   relaxation (`approval-task-schedule-relaxed`). The loosenings are a later or removed due or warn time, a lower
   priority, a different escalation policy, and attaching a policy whose breach reassigns or adds an assignee
   (`escalation_policy_attached`): both of the last two change who decides the task, which B4S-02 makes a
   `settings_relax`. A stage timer may never loosen (`stage_timer_cannot_relax`).

   **One transaction per change.** The read of the task (`FOR UPDATE`), the relaxation decision, the write, its audit
   row and the ADR-0046 evaluation commit together, so two changes to one task (an admin and a stage timer, or two
   admins) serialise. Each one decides against what the other committed, never a stale read, so no loosening lands
   without its step-up. A test races a tightening against a priority-only change. A stage timer's change is audited as
   the system (`SYSTEM_ATTRIBUTION_ID`, with `detail.actor` naming the timer), never as the task's requester. A new due time must be in the future, and a named policy must exist and be enabled.
   The escalation target is always an admin-defined ADR-0046 SLA policy (`slaPolicyId`), never a free-form target,
   because creating a policy that hands a task to someone else already requires a step-up.

   **Declared SLA transitions (owner rule: explicit state machines).** `APPROVAL_SLA_MACHINE` in
   `packages/shared/src/workbench.ts` declares `approval_assignments.sla_state` with the shared ADR-0348
   `defineMachine` and is registered in `STATE_MACHINES`, so its states are held equal to the column's CHECK. Its
   events belong to two causes: the clock (`warn`, `breach`: the ADR-0046 evaluation only ever moves `ok` to
   `warning` to `breached`) and a reschedule (`rearm_ok`, `rearm_warning`: a due time moved later re-arms `breached`
   or `warning` back). `slaTransitionAllowed(cause, from, to)` reads the machine. `scheduleApprovalTask` applies
   only reschedule events; a test pins that `evaluateSla` makes only clock ones. A re-armed breach keeps its `breached_at` on the record.

   **The contract with lane E21 (stage timers).** On a human-approval stage, E21 does not escalate the task itself:
   when the stage is entered, it sets each pending task's due and warn times (and optionally priority and policy)
   through `scheduleStageApprovals`, and the SLA sweep does the rest. A breach rule that cancels the instance is
   E21's, not a task escalation, and its pending tasks are superseded, never denied. Timers on non-human stages stay
   E21's and never touch the queue. E21 recorded its side of this contract in its own ADR on #885.

### Slice 3: the value view (after #848)

9. **Value joins, never copies.** Once lane E2's cost per outcome (#848) is on main, a value read joins these
   analytics to its outcome ledger per template and project: outcomes, metered spend per outcome, cycle time and wait
   per outcome. Metered spend only. Imported spend stays beside it, never divided or added, as #848 does.

## Consequences

- The dashboard data layer can show cycle time, throughput, rework, bottlenecks and a stage heatmap per template,
  project and team, within the caller's own visibility.
- Screens are not in this lane: five `KNOWN_UI_GAPS` entries point at #453 for the design builder.
- Wait vs work is a property of the engine's statuses, not of a person's effort: "wait" at a sign-off is the time the
  approver had it. Time a person spent on an artifact before submitting it is wait.
- Follow-ups: a per-instance sequence number on `workflow_events` would make replay ordering exact and remove the tie
  search (engine owner); a projection hook in `applyEvent` if five minutes of lag is too much; partitioning or a
  retention window for spans if histories grow past the measured range.
