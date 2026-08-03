# ADR-0049: Cost forecasting and spend-anomaly detection on the measured usage ledger

- **Status**: Accepted
- **Date**: 2026-08-01 (proposed) / 2026-08-02 (accepted + implemented, migration 0061)

## Context

Pillars 5 and 6 already stand on a solid metering base:

- **`usage_events` is the measured ledger** — ADR-0024 made metering *unconditional*: every
  governed agent/model, connector, and MCP tool call writes exactly one `usage_events` row after
  it runs, with the five attribution dimensions (project, team, environment, model/agent, cost
  center) attached; attribution only decides *where* the cost lands (a project vs the explicit
  Unattributed bucket), never *whether* it is recorded.
- **`cost_events` is the estimate ledger** — provider list-price-based per-call cost computed at
  the gateway (GOVERNANCE §10.4), used *before* a call runs where a measurement does not yet exist.
- **Enforcement today is a static cap** — ADR-0027 §9 added per-framework budget ceilings
  (MIN-composed, block-beats-warn floor) enforced in `preDispatchProjectGate`, and pillar-5 budgets
  block/queue further spend at a threshold through the Approvals Queue.

Two capabilities the spec explicitly names (GOVERNANCE §10.3) are **not built**:

1. **Forecast** — *"projected end-of-period spend based on current trajectory and any already-
   scheduled changes."* Finance needs budget-*vs-forecast*, not just budget-vs-actual: a static
   cap tells you nothing until you hit it.
2. **Anomaly detection** — *"flag unusual spend spikes (e.g. a runaway agent loop) with enough
   context to investigate."* A static budget cap catches only the runaway that happens to *cross
   the cap*. It misses a slow leak that stays under budget, a burst that is cheap-per-call but
   behaviourally weird, an off-hours spike, or an exfil-shaped read pattern — none of which a
   threshold on a single number can see.

The forces: forecasting and anomaly work must sit on the **measured** ledger (`usage_events`) for
accuracy; must **reuse the existing Approvals Queue and budget enforcement** rather than mint a new
alerting surface; must be **honest** about what a statistical flag is (a signal for human review,
never proof); and must respect the compliance-cascade cost floors (ADR-0027 §9) — an anomaly
response may *tighten* but never *relax* a framework's required enforcement.

## Decision

On top of the measured `usage_events` ledger, build **budget-vs-actual forecasting** and
**spend-anomaly detection**, both alerting and (optionally) enforcing through the **existing
Approvals Queue and pillar-5 budget enforcement**. Explicitly: **statistical baseline first, ML
later; an anomaly is a signal, not proof.**

### 1. Forecast — explainable run-rate first

The v1 projector is deliberately simple and legible, not a black box:

- **Run-rate projection**: `projected_period_spend = spend_to_date / fraction_of_period_elapsed`,
  reported with a confidence band that widens early in a period (little data) and narrows as the
  period fills.
- **Scheduled-change adjustment**: a known future delta (a newly granted higher-per-call agent, a
  ceiling change taking effect mid-period, per §10.3) is added on top of the run-rate so the
  forecast reflects *decided* changes, not just the past trend.
- **Early-warning output**: "at the current rate this project reaches 130% of budget by day 24,"
  surfaced on the pillar-5 dashboard and, at admin-configured thresholds, as an Approvals-Queue
  review item — the same inbox, not a new one.

Seasonal/ML forecasting (day-of-week effects, holiday dips) is a later iteration behind the same
interface; v1 is a run-rate the customer can re-derive by hand, which is a feature for trust.

### 2. Anomaly signals — statistical, per-project/per-user baseline

A per-project (and per-user) **rolling baseline** (trailing 30 days by default) computed from
`usage_events`, with robust thresholds (MAD / z-score, admin-tunable sensitivity per the ADR-0021
`org_settings` ceiling-and-default conventions). v1 signals:

1. **Unusual model** — a dispatch to a model this project/user has never or rarely used, especially
   a jump toward the entitlement ceiling's more expensive model.
2. **Unusual token volume** — per-call or per-window token count sitting far above the project's
   own rolling baseline (catches the runaway loop and the pathological-context case).
3. **Off-hours spend** — spend materially outside the project's/org's historically active window.
4. **Potential-exfil signature** — a read-tool / connector / MCP egress *volume* burst
   inconsistent with baseline. This is the **cost/volume-shaped** signal only; content-level DLP
   stays with the guardrail engine (ADR-0042) and the *what-touched-what* trace stays with the
   lineage graph (ADR-0050). 0049 owns the shape of the spend, not the inspection of the payload.

### 3. Where it runs

- A **scheduled evaluator** over `usage_events` (mirroring the ADR-0027/0031 boot schedulers —
  hourly-ish tick, settings re-read per tick, **OFF by default**, admin-enabled) computes baselines
  and raises flags.
- Plus an optional **inline check** in `preDispatchProjectGate` for the fast runaway-loop case,
  reading a **cached rolling spend-acceleration counter** (never a full ledger scan on the hot
  path) so a spend that is accelerating abnormally can trip a soft gate in-flight. The inline gate
  necessarily reasons over `cost_events` estimates (you cannot measure a call that has not run);
  the scheduled evaluator reasons over `usage_events` measurements. That two-ledger split is the
  honest boundary between *predicting* a call's cost and *accounting for* it.

### 4. Actions ride existing surfaces — no new inbox, floors respected

- **Alert**: post to the pillar-5 dashboard with full context (which project, which agent, which
  window, which signal fired, what the baseline was) and, above a threshold, an Approvals-Queue
  item.
- **Enforce**: reuse ADR-0027 §9 budget enforcement — an anomaly can escalate to *"require approval
  for further spend"* (the soft, reversible default) through the Approvals Queue, or a hard stop
  only where an admin explicitly configured one. A **framework cost policy is the floor**: an
  anomaly response can never relax a `block`-mandating profile down to `warn`.

### 5. Honesty rails (load-bearing, not boilerplate)

- **Statistical, not ML, in v1** — and every flag is **explainable**: which signal, which baseline,
  which window, what threshold. No unexplained "risk score."
- **An anomaly is a signal for human review, never proof of wrongdoing.** The design **biases
  toward alert-not-block** for ambiguous signals; enforcement is reversible and appealable through
  the same Approvals Queue.
- **Cold-start is disclosed, not faked**: a project with no baseline yet (new, or below a minimum
  sample size) gets **no anomaly claims** — only the static budget/framework caps apply — and the
  dashboard says "baseline building," never a spurious flag.

## Consequences

- Finance gains forecast and early-warning instead of a cap that is silent until breached; a class
  of runaway/anomalous spend that a static budget misses becomes catchable.
- **False positives are expected and carry a tuning burden.** Sensitivity is an admin dial under
  the ADR-0021 conventions; the alert-not-block default keeps a mis-tuned detector from
  half-throttling legitimate work.
- The **cold-start window** (new projects) is a disclosed blind spot for the anomaly path — only
  the hard caps protect a project with no history, by design.
- **ML/seasonal modeling is deferred** behind the same interface; v1's legibility is the trade we
  chose on purpose.
- The inline gate adds one cached-counter read on the dispatch hot path (bounded, no scan); the
  scheduled evaluator adds background load proportional to ledger size, mitigated by the rolling
  window and the OFF-by-default posture.
- **No new surface**: alerts and enforcement flow through the existing dashboard and Approvals
  Queue, so this composes with — rather than forks — pillars 5/6. The exfil-shaped signal
  deliberately overlaps but does **not** duplicate ADR-0042 (content DLP) or ADR-0050 (lineage):
  0049 flags *anomalous spend/volume*, and hands the *what actually flowed* question to those.

---

## Implementation amendment — 2026-08-02 (migration 0061)

Accepted and built. What follows is the honest record of what actually ships, where the math is
weak, and what nothing drives.

### What shipped

**Pure half — `packages/shared/src/forecasting.ts` (+ 31 unit tests):** both projectors and their
confidence interval, the anomaly rule with its cold-start and absolute-floor rails, the
`unusual_model` share-of-history rule, the enforcement decision, and the daily/hourly bucketing.
No db, no clock of its own.

**Gateway half — `apps/gateway/src/spend-monitor.ts` (+ 21 integration tests):** the `usage_events`
queries, the entitlement scoping, the Approvals-Queue escalation, the admin API and the audit rows.

**Migration 0061** adds four tables: `spend_monitor_policies` (the admin dial, **OFF by default**),
`spend_scheduled_changes` (§1's decided future deltas, signed, reason mandatory),
`spend_anomalies` (the append-only flag ledger, one row per project/signal/window), and
`spend_forecast_runs` (the forecast artifact, mirroring ADR-0047's `report_runs`).

**Admin SPA:** `/admin/spend-monitor` — forecast, policies, flags with their evidence, decided
changes.

### The forecasting method, stated exactly, with its limits

Both v1 projectors share one skeleton, and the whole point of choosing them is that a customer can
re-derive the number with a calculator:

```
projected = spendToDate + dailyRate × remainingDays + scheduledDelta
```

- **`run_rate` (default, §1's named method)** — `dailyRate = spendToDate / elapsedDays`, the flat
  mean over every elapsed day **including days with zero spend**. Algebraically identical to the
  ADR's `spend_to_date / fraction_of_period_elapsed`, and the test asserts that identity directly.
- **`ewma`** — `dailyRate = EWMA(dailyTotals, α=0.4)`, seeded on the first observation. Reacts to a
  recent step change faster; over-reacts to a single spike, which is exactly why it is not default.

**The interval is real, not decorative.** The mean daily rate is estimated from `n` daily
observations with sample standard deviation `s`, so its standard error is `s/√n`. Only the
*remaining* days are estimated rather than measured, so:

```
halfWidth = 1.96 × (s / √n) × remainingDays
```

The band therefore **widens early and narrows as the period fills** by construction rather than by
a fudge factor, and a perfectly flat history yields a **zero-width** interval — a band invented
where no sampling variation exists would be a lie in the opposite direction from an overconfident
one. It is a normal approximation on the mean.

**Where it breaks — carried in every payload's `limits[]`, not just here:**

1. **Sparse data.** Refused rather than extrapolated. Three floors, all enforced and all tested:
   at least **3 days with measured spend**, at least **10% of the period elapsed**, and any spend
   at all. Below any of them the response is `sufficient: false`, `projectedSpendUsd: null` and a
   sentence beginning `INSUFFICIENT DATA`. **There is no fallback number** — not zero, not "same as
   last period". Migration 0061 puts a `CHECK` on `spend_forecast_runs` so a *stored* forecast
   cannot claim a number without sufficiency, and the test asserts the database rejects it.
2. **Seasonality.** Neither method models day-of-week or holiday effects. A weekday-only team
   measured from a Saturday under-projects; measured from a Monday, over-projects. Deferred behind
   the same interface, as §1 says.
3. **Cold start.** A new project has no forecast and no anomaly baseline. Only the static
   budget/framework caps protect it. Disclosed on the page, never faked.
4. **Step changes.** Not inferable from a trend. `spend_scheduled_changes` exists so a **decided**
   change is added on top; an undeclared one simply makes the projection wrong.
5. **The basis is a list-price ESTIMATE** (GOVERNANCE §10.4), inherited from `usage_events`. The
   forecast is not invoice-grade and says so.

### The anomaly rule, stated exactly

**Iglewicz–Hoaglin modified z-score**: `z = 0.6745 × (x − median) / MAD`, one-sided (only upward
excursions are spend anomalies). MAD rather than mean/stddev because a mean-based baseline is
dragged upward by the very spike it should detect, making a classic z-score progressively blinder
the worse an incident gets. Sensitivity is a named dial mapping to `low 5.0 / medium 3.5 / high 2.5`
— 3.5 is the published convention.

Three rails, all tested:

- **Cold start first.** Under `MIN_BASELINE_SAMPLES = 7` baseline observations the detector returns
  `evaluated: false` and makes **no claim in either direction**.
- **Absolute floor.** A scale-free z-score makes `$0.002` an eleven-sigma event against a
  `$0.0001` baseline. Nothing fires below a per-signal floor (`$1` spend, 10k tokens, 25 egress
  calls).
- **Degenerate baseline.** A perfectly flat history has `MAD = 0` and no defined z-score; the
  documented fallback is percent-over-baseline at 3×, reported as method `pct_over_baseline` so a
  flag never claims a z-score it did not compute.

`unusual_model` is deliberately **not** a z-score — the question is categorical, and dressing it as
one would be the unexplained score §5 bans. It is a share-of-history rule (< 2% of the scope's
dispatches) gated on the spend actually attributed to that model in the window.

### What is GENUINELY ENFORCED vs. what NOTHING DRIVES

**Genuinely enforced — asserted on served payloads and persisted rows, not on UI:**

- **THE FORECAST IS ARITHMETIC ON THE REAL LEDGER.** Ten `usage_events` rows of `$2` are seeded and
  the projection is asserted `=== 60` against the arithmetic written out in the test body — and
  separately against the ADR's own `spendToDate / fractionElapsed` identity — with `spendToDateUsd`
  asserted equal to an independent JS sum of the ledger rows. Not a snapshot.
- **INSUFFICIENT DATA RETURNS NO NUMBER.** Asserted over HTTP, in the persisted `spend_forecast_runs`
  row, in the audit row's `detail`, and at the **database CHECK** level.
- **THE DETECTOR FIRES ON A SPIKE AND STAYS SILENT ON NORMAL VARIANCE.** Two projects are seeded
  with the *same* 30-day baseline; one gets a 40× spike on the observed day and one an ordinary day.
  The first fires with `baselineMedian 10 / MAD 1 / z ≈ 263`; **every signal on the second is
  asserted not to fire, and its anomaly table is asserted empty.** The unit tests additionally
  assert every observation *inside* the baseline is unremarkable, and that a 40%-above-median day is
  normal variance.
- **A DERIVED NUMBER DOES NOT LEAK ANOTHER TEAM'S SPEND.** Team B's lead is refused the org
  forecast, team A's team forecast and team A's project forecast (403 `spend_scope_not_entitled`,
  audited `spend-forecast-denied` with `effect: deny`). The forecast they *are* entitled to is
  asserted to carry team B's ledger sum **and not** team B + the other team's — with the persisted
  `effective_project_ids` asserted to be the single-element list. Team A's anomaly rows are asserted
  absent from team B's list **by id**, while team A's lead does see them.
- **ENFORCEMENT IS THE EXISTING QUEUE.** An escalating anomaly is asserted to create exactly one
  `approvals` row (`objectType: 'project'`, `stageId: '__spend_anomaly__'`, the project's own named
  budget approver), the anomaly row is asserted to *point at* it, and the item is asserted visible
  in `GET /v1/approvals` — the same queue the rest of the product reads.
- **IDEMPOTENCE.** A unique index on `(project, signal, window_start, window_end)` means a cron
  driven ten times an hour records one incident, not ten. Asserted by re-driving the evaluator.
- **OFF BY DEFAULT IS REAL.** A disabled policy computes nothing and says so; asserted.
- **ADMIN GATING.** Policies, scheduled changes, the evaluator and the overview are admin-only via
  the default gate; only `GET /v1/spend/forecast` and `GET /v1/spend/anomalies` are non-admin, and
  both resolve entitlement inside the handler. Asserted per route.
- **STABLE ruleIds.** Eight are asserted present in the integration suite:
  `spend-forecast-computed`, `spend-forecast-denied`, `spend-anomaly-escalated`,
  `spend-anomaly-acknowledged`, `spend-anomaly-swept`, `spend-monitor-policy-updated`,
  `spend-scheduled-change-created`, `spend-scheduled-change-deleted`. Two more exist and are
  emitted by the same code paths but are **not** covered by an assertion:
  `spend-anomaly-detected` (the alert-only branch of a fired signal, since the fixture's fired
  signal escalates) and `spend-anomaly-dismissed` (the dismiss branch of the decide route, since the
  fixture acknowledges). Named here rather than implied by the list.

**Nothing drives it — stated plainly:**

- **THERE IS NO IN-PROCESS SCHEDULER IN THIS CODEBASE, AND THIS SLICE DID NOT ADD ONE.** §3's
  "scheduled evaluator" ships as a **definition** (`spend_monitor_policies`) plus an endpoint an
  operator or external cron drives (`POST /v1/spend/anomalies/evaluate`). Its response and the SPA
  say so in those words, and `last_evaluated_at` staying `NULL` is how an undriven policy is
  **visible** rather than assumed to be working. Same shape as ADRs 0044/0045/0046/0047.

### Deviations from the proposal above

1. **§3's INLINE pre-dispatch acceleration gate is NOT built.** It wants a cached rolling
   spend-acceleration counter on the dispatch hot path; adding an un-cached ledger scan to
   `preDispatchProjectGate` to claim the feature would be exactly the overstatement this project
   refuses. `preDispatchProjectGate` is untouched, and the two-ledger split §3 describes
   (`cost_events` for prediction, `usage_events` for accounting) is therefore only half-realised:
   **everything shipped reads the measured ledger.**
2. **§4's framework cost floor is wired but not sourced.** `decideEnforcement` takes a
   `frameworkFloor` and its tighten-never-relax behaviour is unit-tested, but the gateway currently
   passes `null` — ADR-0027 §9's per-framework cost profile is not yet read here. The *mechanism* is
   proved; the *wiring* to the compliance cascade is a follow-up. This is a real gap, named rather
   than papered over.
3. **The observation window is the last COMPLETE UTC day**, not a rolling hour. A partial day
   compared against full days would systematically under-read.
4. **`off_hours` and `egress_volume` ship but are only exercised negatively** in the integration
   fixture (the seeded history gives them no baseline, so they correctly make no claim). Their
   detection path is the same `detectAnomaly` covered by the unit tests.
5. **Per-USER baselines** (§2's "per-project *and* per-user") are modelled in the schema
   (`spend_anomalies.subject_user_id`) but the evaluator computes **project-level** baselines only.
6. **No alerting transport.** An alert is a row plus, optionally, an approvals item. No mail, no
   webhook, no ChatOps.

### Follow-ups this slice leaves open

- The inline `cost_events`-based acceleration gate on the dispatch path (§3).
- Sourcing the ADR-0027 §9 framework cost floor into `decideEnforcement`.
- Per-user baselines alongside per-project ones.
- Seasonal/ML forecasting behind the same `ForecastMethod` interface (§1, explicitly deferred).
- A documented cron entry (or a scheduler) for `POST /v1/spend/anomalies/evaluate`.
- Retention/pruning for `spend_forecast_runs.payload` and `spend_anomalies`.

---

## Amendment (2026-08-03) — this ADR's scheduling gap is closed by ADR-0064

[ADR-0064](0064-in-process-scheduler.md) added an **in-process scheduler** to the gateway, with a
Postgres row-lock claim so a second instance cannot double-fire a job, and registered this ADR's
sweep as one of its six jobs. The sweep's logic was **not reimplemented** — the job calls the same
function this ADR's endpoint calls, so there is exactly one implementation and the endpoint
remains available for manual/on-demand runs.

Three things about that are worth stating here rather than only in ADR-0064:

1. **It is OFF by default**, in every environment (`REGULAIT_SCHEDULER`). A deployment that does
   not opt in behaves exactly as this ADR originally described, and its endpoint is still the way
   to drive the sweep from an operator's own cron.
2. **Nothing about enforcement changed, and nothing was allowed to.** This ADR's sweep was
   deliberately built so that correctness never depended on it having run; that property is
   asserted in `scheduler.test.ts` precisely so a future change which moves a control into the
   timer breaks a test rather than a customer. The scheduler buys **timeliness**.
3. **Timeliness is bounded by the box being up.** [ADR-0032](0032-scheduled-power-off-dev-infra.md)
   powers this deployment's infrastructure off nightly; a sweep due inside the off-window does not
   run, is not queued, and is picked up once — late — on the first tick after power-on.
