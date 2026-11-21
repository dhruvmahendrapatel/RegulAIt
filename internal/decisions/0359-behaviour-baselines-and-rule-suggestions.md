# ADR-0359: Learned behaviour baselines and backtested rule suggestions over the audit chain

- **Status**: Proposed (builder lane E40, 2026-11-17; owner decision 2026-11-17 from the competitor gap audit, Obsidian row 9 and DarkControl row 20)
- **Date**: 2026-11-17
- **Index**: Behaviour analytics: per-install baselines, explainable anomaly findings (shadow mode), backtested rule suggestions
- **Builds on**: ADR-0333 (lane E15, deterministic detection rules), ADR-0049
  (robust z-score spend anomalies), ADR-0060 (audit chain), ADR-0015 (deployment modes and data boundary), ADR-0242
  (engine sandbox), ADR-0180 (secure by default), ADR-0176 (open source first), ADR-0200 (engineering guidelines)
- **Migration**: `pending/behaviour_baselines.sql` (slice 1) and `pending/behaviour_rule_suggestions.sql` (slice 2),
  numbered at merge (ADR-0252)

## Context

ADR-0333 (lane E15) detects risky behaviour with deterministic rules that an admin writes. A rule catches only what
someone thought of. The owner asked (2026-11-17) for a learned layer on top: learn what is normal for each agent and
user from the customer's own audit trail, show what departs from it, and turn repeated departures into candidate rules
in E15's format that a human approves.

Constraints from the brief:

- The baseline is built from the customer's own audit data, inside their install. No data leaves the install and
  nothing is pooled across customers (ADR-0015). It works air-gapped.
- The statistics are explainable. Every finding shows its baseline and how far the value departs from it.
- Shadow mode by default: findings only, no enforcement.
- Rule suggestions use a local model only, are backtested on the customer's own history, and become active only after
  human approval with step-up. Their lifecycle is a declared transition table.

## Options compared (owner rule 9, ADR-0176)

| Approach | Licence | Maintenance | Fit |
|---|---|---|---|
| **River** (Python, online ML: half-space trees, online stats) | BSD-3-Clause | 0.27.0, active | Needs a Python sidecar in the ADR-0242 engine sandbox. Its online anomaly scores (half-space trees) are not explainable as "baseline X, deviation Y". Too heavy for counts per day. |
| **PyOD** (Python, isolation forest, ECOD, COPOD and others) | BSD-2-Clause | 3.6.8, active | Same sidecar cost. An isolation-forest score is a path length, which an admin cannot read as a baseline. |
| **`isolation-forest`** (npm) | MIT | 0.0.9, last release 2022-05 | Stale (fails the ADR-0176 maintenance test) and has the same explainability problem. |
| **Seasonal decomposition (STL)** | — | No maintained, air-gapped TypeScript package was found (npm search 2026-11-17) | Writing STL ourselves would break the open-source-first rule. The hour-of-day signal below covers the daily cycle without it. |
| **Chosen: robust z-score (Iglewicz–Hoaglin) and share of history, on `simple-statistics`** | ISC | 7.12.1, already pinned in `@regulait/shared` (8.0.0 released 2026-10) | `median` and `medianAbsoluteDeviation` come from the library. The method is the one ADR-0049 already uses for spend anomalies, so admins read one kind of number. Runs in-process, so no sidecar and no network, and it works air-gapped. |

Repo search (rule 8): ADR-0049's `detectAnomaly` (`packages/shared/src/forecasting.ts`) is the same method, but it is
keyed on spend signals and floors. The new module keeps its rules (cold start first, an absolute floor, a one-sided
modified z, the 3x-median fallback when MAD is 0, the share-of-history rule for categories) and its explanation style,
but takes the median and MAD from `simple-statistics` rather than from new hand-written code. Merging the two is left to
a later batch; it is a refactor outside this lane.

## Decision

### 1. The data stays in the install

- The only input is the install's own `audit_log` (ADR-0060). Every read and write happens inside the gateway's own
  Postgres. There is no network call, no external model and no cross-customer pool. Because a RegulAIt install is
  single-tenant (ADR-0015), "per customer" is "per install".
- The rollup and the findings are derived data. They name `audit_log` as their source of truth (ADR-0200 read-model
  exception).

### 2. Subjects and signals

- **Subjects:** a **user** (`audit_log.user_id`, every row) and an **agent** (`audit_log.actor_identity_id`, the
  workload identity of ADR-0188, on delegated rows).
- **Signals** are declared once (`BEHAVIOUR_SIGNALS` in `@regulait/shared`):

| Signal | Kind | Counted from |
|---|---|---|
| `model_calls` | volume per day | rows with `object_type = 'agent'` (model calls) |
| `data_scoped_calls` | volume per day | rows whose rule chain ran a `data-scope` rule |
| `tool` | category | `tool_name` of `mcp_tool` rows |
| `destination` | category | `mcp:<server_id>`, `model:<object_id>` or `connector:<object_id>` |
| `hour_of_day` | category | the UTC hour of the row (00 to 23) |

### 3. The baseline

- **Rollup.** A leased cursor over `audit_log.seq` (the ADR-0333 pattern) adds each committed row once to
  `behaviour_daily_counts` (day, subject, signal, key, count). On first run it replays the retained history from the
  first row, a bounded number of batches per pass. A day is evaluated only once the rollup has reached the chain head,
  so a part-built baseline never produces findings. Its own audit rows (`object_type = 'behaviour_baseline'`) are
  skipped.
- **Window.** The baseline is the 28 complete UTC days before the day under test. The day under test is the last
  complete UTC day.
- **Volume signals.** The baseline is one count per day, zero-filled from the subject's first active day in the window.
  Fewer than 7 baseline days is a cold start: no finding and no claim (ADR-0049 §5). Below the signal's absolute floor
  nothing fires. Otherwise the modified z-score is `0.6745 × (observed − median) / MAD`, one-sided (only an increase),
  against 3.5. When MAD is 0 the fallback fires at 3x the median or more, and the finding says it used the fallback.
- **Category signals.** The baseline is the count per key over the window. A key whose share of the subject's history
  is below 2% fires (a first-seen key has a share of 0). This needs at least 7 active days and 20 events in the window.

### 4. Findings, shadow mode

- Each finding is a point-in-time snapshot in `behaviour_anomaly_findings`. It keeps the observed value, the baseline
  (median and MAD, or the key's count and the total), the number of baseline days, the method, the score, the
  threshold, and a sentence that says all of it. It is unique per (day, subject, signal, key), so a re-run adds nothing.
- Each finding also writes one chained audit row (`behaviour-anomaly-observed`), so the ADR-0303 SIEM export carries
  it with no new path.
- **Shadow mode is the default and the only mode built.** `behaviour_baseline_settings.mode` is `shadow` or `off`.
  Nothing a finding says changes a decision, and the sweep is never in the decision path. Turning the engine off is a
  relaxation: it needs a `settings_relax` step-up and is audited. Turning it back on is audited.
- **Finding status** is a declared table: `open → acknowledged | dismissed`, `acknowledged → dismissed`. `dismissed`
  is terminal.
- At most 500 findings are recorded per evaluated day, highest score first. The cap is reported in the day's summary
  audit row, never silent.

### 5. Rule suggestions (slice 2)

- Repeated findings for a signal propose a candidate rule in E15's pack format (`regulait.detection-pack.v1`, a
  `single` or `event_count` rule with a closed selector). The candidate is built by deterministic templates in-process,
  so no model call is made at all. A local model may later only reword the title (the slice-2 brief allows a local model
  only); no customer data leaves the install either way.
- Each suggestion is backtested against the install's own retained history with E15's engine. The result shows hits and
  false positives (hits on events an admin had dismissed).
- **States** (declared transition table): `proposed → backtested | retired`, `backtested → approved | retired`,
  `approved → active | retired`, `active → retired`. `retired` is terminal. Approval and activation each need a
  `settings_relax`-class step-up; activation writes a new signed pack version through E15's own pack route logic.

### 6. Exceptions recorded (ADR-0176 §4)

- The rollup cursor and window code is RegulAIt code (about 100 lines), for the same reason ADR-0333
  gives: the state must be shared across replicas, survive a restart and stay exact against the audit chain. No
  streaming library keeps its state in our Postgres.

## Consequences

- An admin sees, per user and per agent, what is normal and what departed from it, with numbers they can check.
- No enforcement changes. A finding never blocks a call.
- Weekly seasonality is not modelled. A team that works only on weekdays gets zero-filled weekend days, which lowers
  the median. The 3.5 threshold and the absolute floors keep that from firing on an ordinary Monday; a day-of-week
  baseline is a follow-up if findings show it is needed.
- The API ships without screens. The routes are known UI gaps on #453.

## As built

- Slice 1: `packages/shared/src/behaviour-baseline.ts` (the pure statistics), `apps/gateway/src/behaviour/` (rollup,
  evaluation, sweep job `behaviour-baseline-sweep`, routes).
