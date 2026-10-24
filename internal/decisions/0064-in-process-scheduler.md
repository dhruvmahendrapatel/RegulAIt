# ADR-0064: An in-process scheduler, so the six sweeps actually run

- **Status**: Accepted
- **Date**: 2026-08-03

## Context

Six shipped capabilities each define a schedule and then, in the same breath, disclose that
nothing drives it:

| ADR | The sweep | Its endpoint |
| --- | --- | --- |
| [0044](0044-agent-evaluation-harness.md) | eval drift detection (§5) | *nothing existed* — the `scheduled` trigger was accepted, no driver was written |
| [0045](0045-model-risk-management.md) | model-card expiry sweep | `POST /v1/mrm/expiry-sweep` |
| [0046](0046-review-workbench.md) | approval SLA breach detection | `POST /v1/approvals/sla/sweep` |
| [0047](0047-executive-compliance-reporting.md) | scheduled report generation | `POST /v1/reports/schedules/run-due` |
| [0049](0049-cost-forecasting-anomaly.md) | spend forecast / anomaly evaluation | `POST /v1/spend/anomalies/evaluate` |
| [0057](0057-continuous-red-teaming.md) | "continuous" red-team runs | `POST /v1/redteam/runs` with `trigger: 'scheduled'` |

Each of those ADRs' amendments says some version of *"there is no in-process scheduler in this
codebase; an operator or an external cron must call this endpoint."* That was honest. It was also
the same hole, six times, documented in six places and visible in none of them — because the
failure mode of "nobody wired the cron" is a screen full of null timestamps, which looks exactly
like a screen full of *"nothing was due"*.

**The thing that makes this survivable, and which must not change.** Every one of those six was
built so that **enforcement never depends on the sweep having run**:

- `mrmDispatchGate` recomputes expiry from `valid_until` on **every** dispatch. A lapsed card is
  refused whether or not the stored status was ever swept — ADR-0045's suite proves this by
  leaving the status at `approved` and asserting the call still refuses.
- Approval SLA breach is evaluated when the queue is **read** and when an approval is **decided**,
  and the deadlines are a pure function of `requested_at`, so a lazily detected breach is
  byte-identical to what a timer would have produced.

So the sweeps buy **timeliness**, not **correctness**. That distinction is the whole reason this
ADR is a convenience feature and not a security fix, and it is the property this change is most
at risk of quietly destroying.

**Why an external scheduler is the wrong answer here.** [ADR-0041](0041-byoc-primary-motion.md)
made BYOC/air-gapped the primary motion. A design that says "point EventBridge at these six
endpoints" is a design for a buyer this product does not target: an air-gapped install has no
cloud scheduler, and a BYOC install frequently has no host cron a vendor is allowed near. Telling
that customer their compliance sweeps require infrastructure we cannot reach is telling them the
sweeps do not work.

This is the same argument [ADR-0040](0040-abac-policy-as-code.md) used to embed Cedar in-process
rather than run an OPA sidecar: one artifact, one process, nothing extra to operate, and it works
on a box with no network.

**Why safety with a second instance matters even though there is one gateway today.** There is
exactly one gateway process now. The deployment-readiness checklist plans HA, and nobody reviewing
that change will remember a scheduler module written today. A design whose correctness rests on
"there is only one process" is a design that breaks silently the day that stops being true — and
the symptom would be every sweep double-firing, i.e. duplicate reports, duplicate escalations and
double-spent eval tokens.

## Decision

**Build a small in-process scheduler in the gateway, claim each job through a Postgres row lock so
two instances cannot double-fire it, keep it OFF by default, and register the six existing sweeps
as jobs that CALL the functions their endpoints already call.**

Concretely:

1. **Migration 0076** adds two tables.
   - `scheduler_jobs` — one row per registered job: enabled, cadence (`interval_seconds`),
     `next_due_at`, `last_run_at` / `last_outcome` / `last_error` / `last_items_processed`, and the
     running totals (`runs`, `failures`, `consecutive_failures`). This row is **also the lock**:
     `running` + `lease_owner` + `lease_expires_at`.
   - `scheduler_runs` — the append-only ledger, one row per execution **attempt**: job, trigger
     (`schedule` | `manual`), instance id, started/finished, duration, outcome
     (`running` | `ok` | `failed` | `skipped`), `items_processed`, `detail`, `error`.

   Between them, *"did the MRM sweep actually run last night, and what did it do?"* is answerable
   from the database with one query.

2. **The lock is a short claim transaction**, not a long one. `claimJob` opens a transaction,
   takes `SELECT … FOR UPDATE` on the job's own row, re-checks enabled / due / lease **inside** the
   lock, opens the ledger row, writes a lease, and commits. The critical section is three
   statements; the job body runs **outside** it, holding only the lease. A second instance blocks
   on the row, reads the winner's lease, and records a `skipped` run — a skip is data, not an
   error, because *"the other box ran it"* and *"nothing ran it"* must not look the same.

   Blocking `FOR UPDATE` rather than `SKIP LOCKED` is deliberate: the loser must be able to say
   **why** it did nothing, and "the row was locked" and "the job was not due" are different facts.

   The lease carries an expiry rather than being a bare boolean, so a process `SIGKILL`ed mid-pass
   does not strand its job forever.

3. **Off by default, in every environment.** `REGULAIT_SCHEDULER` defaults to off; an operator sets
   `REGULAIT_SCHEDULER=on`. Turning this feature on therefore changes nothing about existing
   behaviour except that the sweeps now run — which is the only way that sentence can be true.
   `buildApp` starts **no timer at all**; the loop is started by the boot path (`startGateway`),
   after `listen`, so a slow first sweep can never delay a deployment coming into service. Under
   vitest the resolver returns off **even when the environment says on**, so a stray CI variable
   cannot start timers underneath the suite.

4. **Per-job error isolation.** Each job runs inside its own try/catch. A throw is logged (first,
   always), written to its run row and its job row, audited, and the tick continues to the next
   job. Nothing a job does can reach the Fastify process.

5. **Overlap protection** is two-layer: an in-process `inFlight` set (deterministic, no database
   round trip) plus the lease (cross-process).

6. **Shutdown semantics, chosen and stated: the loop stops immediately and an in-flight job is
   AWAITED, not aborted.** Every job body here mutates governed state and writes audit rows; a
   sweep killed at an arbitrary statement is worse than a shutdown that takes a few seconds
   longer. `stop()` resolves only when nothing is running. The interval is `unref`'d, so a
   forgotten scheduler can never be the reason a process refuses to exit.

7. **The six jobs call the existing functions.** Four sweeps had their logic entangled with a
   Fastify handler and were **extracted**, not duplicated — `runApprovalSlaSweep`,
   `runDueReportSchedules`, `runSpendAnomalyEvaluation`, plus the two new drivers
   `runEvalDriftSweep` and `runScheduledRedTeamSweep`. The endpoints now call those same functions
   and remain available for manual/on-demand runs. There is exactly one implementation per sweep,
   so a manual run and a scheduled run are the same code path by construction rather than by
   review. `POST /v1/evals/drift-sweep` and `POST /v1/redteam/scheduled-sweep` were added so those
   two also have a manual door.

8. **The scheduler has no identity.** Jobs that only reconcile stored state (MRM expiry, SLA
   evaluation) run with a null actor and audit as the deployment itself. Jobs that **dispatch a
   model** — eval drift, red team — inherit the entitlements of the specific human who pinned the
   baseline or last ran the probe, and **skip with a stated reason** when that human is gone.
   Nothing a timer does can reach a model the initiating user could not, and the red-team sweep
   only re-probes `(library × agent)` pairs a human already chose, because a timer should not
   start sending adversarial prompts at pairings nobody selected.

9. **Every pass is audited** into the one existing `audit_log` under stable ruleIds —
   `scheduler-job-started`, `-succeeded`, `-failed`, `-skipped`, and `scheduler-job-configured`
   for an admin change. Disabling a governance sweep audits with `effect: 'deny'`, so it lands in
   the same filtered view an admin already uses to find things that did not go through. The
   **effects** a sweep produces keep auditing on their own objectType, so *"what happened to this
   approval"* stays one query.

10. **Admin API + SPA page.** `GET /v1/scheduler` (posture + every job's cadence / last run / last
    outcome / next due), `GET /v1/scheduler/jobs/:name/runs`, `PATCH /v1/scheduler/jobs/:name`
    (enable/disable, re-cadence), `POST /v1/scheduler/jobs/:name/run` (run now, through the same
    claim and the same lease). Admin-only through the default gate. The page renders "next due" as
    an em-dash — never a future timestamp — when the scheduler is off or the job is disabled,
    because a time nothing will act on is a lie with a clock on it.

### Alternatives considered

**An external scheduler (cloud cron, EventBridge, systemd timers, a customer's own crontab) —
rejected.** It is the status quo and it is the thing that did not happen six times. More
importantly it is wrong for the primary buyer (ADR-0041): an air-gapped install has no cloud
scheduler and a BYOC install often has no host cron we may touch. Making compliance sweeps depend
on infrastructure outside the artifact we ship means they do not run for exactly the customers who
care most that they do. It remains fully supported — every sweep still has an endpoint, and an
operator who prefers their own cron simply leaves `REGULAIT_SCHEDULER` off.

**A queue/worker service (Redis + BullMQ, pg-boss, a separate worker container) — rejected.** It
buys retry policies, fan-out, priorities and durable per-item work. None of the six sweeps needs
any of that: each is a single idempotent pass over a table whose next pass fixes whatever the last
one missed. What it costs is a second process (or a second datastore) to install, monitor, back up
and patch inside a single-tenant BYOC deployment where the customer's platform team operates it —
and ADR-0041's whole argument is that operational surface in that environment is expensive in a
way it is not in a hosted SaaS. The same reasoning ADR-0040 used against an OPA sidecar.

**In-process with a database lock — chosen.** No new process, no new dependency, works on a box
with no network, and its correctness does not rest on there being exactly one instance.

## Consequences

### Easier

- The six sweeps run, on a schedule, in a deployment that has no cron and no network — which is
  the deployment this product targets.
- "Did it run, and what did it do?" is a database query with a per-run row, not an inference from
  absent side effects.
- An operator can disable one job, re-cadence it, or run it now, without a deploy — and every one
  of those is audited.
- ADR-0044 §5 (drift alerts) and ADR-0057's "continuous" finally have a driver, having been
  blocked on the absence of exactly this.

### What this explicitly does NOT give you

Stated here rather than discovered later:

- **It is not a distributed job queue.** No fan-out, no priorities, no retry policy, no per-item
  durability, no dead-letter. A failed pass is recorded and the *next* tick tries again. That is
  the right shape for a sweep and the wrong shape for anything else.
- **A job that needs to outlive a deploy, or run for hours, is out of scope.** A restart aborts
  nothing gracefully beyond the current pass (`stop()` waits for it), and a job longer than its
  lease will have that lease stolen. If a future job needs hours, it needs a different mechanism,
  not a longer lease.
- **Timeliness is bounded by the tick interval.** A job due at T runs somewhere in `[T, T + tick]`.
  There is no wall-clock cron expression — a plain interval, deliberately, because a cron parser is
  a dependency and an expression is a thing to get wrong, and none of these six needs "the third
  Tuesday". An operator who genuinely needs wall-clock precision still has the endpoints.
- **Timeliness is also bounded by the box being UP, and this deployment is not.**
  [ADR-0032](0032-scheduled-power-off-dev-infra.md) powers the dev infrastructure off nightly. A
  sweep whose next-due time falls inside the off-window **simply does not run** — it is not
  queued, not deferred, not caught up; the first tick after power-on finds it overdue and runs it
  once, late. An operator must understand this: an in-process scheduler is a property of a running
  process, and a stopped process schedules nothing. This is not a bug to fix; it is the boundary
  of the mechanism, and it is the single most likely reason a real deployment sees a sweep it
  expected not to have happened.
- **It changes no enforcement, and is not allowed to.** MRM still refuses a lapsed card at
  dispatch with the scheduler disabled entirely; SLA breach is still caught on read and on decide.
  Both are asserted in `scheduler.test.ts` specifically so that a future change which quietly
  moves a control into the timer breaks a test rather than a customer.
- **It is off by default,** so a fresh install gets exactly the behaviour it had before this ADR
  until an operator opts in. That is deliberate — enabling a background loop that sweeps every
  project's spend, generates every org-wide report and spends model tokens re-probing agents is an
  operator's decision, not a default — but it does mean an operator who never reads the boot line
  or the admin page still has no sweeps running. The boot log, the admin page and each sweep
  endpoint's own response all say so out loud.
- **The two dispatching jobs cost money.** `eval-drift-sweep` and `redteam-sweep` spend real model
  tokens on every pass, which is why both default to daily rather than hourly and why both are
  scoped to what a human already chose. Their spend lands in the ordinary `usage_events` ledger
  and is therefore visible to the pillar-5 dashboard and to ADR-0049's own anomaly detection —
  including the mildly amusing case where the spend-anomaly job flags the eval-drift job.
- **A job removed from the code is not deleted from the table.** Its history is the evidence that
  it used to run. It is flagged `registered: false` on the admin surface instead.

### Follow-up

- Neither billing-period close (ADR-0051) nor licence re-verification (ADR-0052) got a job. Both
  disclosures were updated to say *why* rather than to claim no scheduler exists: cutting a billing
  period is a commercial act with an invoice on the other side of it, and a timer must not perform
  it. If that changes, it is a new decision, not an oversight.
- A catch-up policy (should a sweep missed during a power-off run once, or once per missed
  window?) is currently "once, late". Nothing here needs more, and anything that does should say
  so explicitly.
- Stuck runs (a row left at `running` past its lease) are surfaced on the admin page but are not
  reaped — the lease expiry makes the job claimable again, and the stale row is left as the
  diagnosis.
