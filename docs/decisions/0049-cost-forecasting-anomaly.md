# ADR-0049: Cost forecasting and spend-anomaly detection on the measured usage ledger

- **Status**: Proposed
- **Date**: 2026-08-01

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
