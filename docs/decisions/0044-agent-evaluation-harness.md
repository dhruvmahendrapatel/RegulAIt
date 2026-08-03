# ADR-0044: Agent evaluation harness — versioned golden datasets, pluggable scorers, and a promotion-blocking workflow check

- **Status**: Accepted
- **Date**: 2026-08-01 (proposed) / 2026-08-02 (accepted + implemented, migration 0056)
- **Relates to**: ADR-0009 (TS/Fastify stack, hand-rolled policy kernel), ADR-0018
  (six-dimension assignment matching), ADR-0019/0024 (the one `usage_events` ledger, unconditional
  metering), ADR-0021 (`org_settings` ceiling model), ADR-0023 (`agents.systemPrompt` as a
  governance artifact), ADR-0034 (`custom_model_providers`)
- **Cross-refs (forward)**: ADR-0045 (model risk management — consumes this harness's scored
  results as its eval evidence)
- **Pillars**: 2 (workflow engine — the automated-checks stage), 5 (cost — judge calls are
  metered), 6 (optimization — a routing/prompt change is exactly what a regression gate must catch)
- **Migration**: **0056** (`0056_eval_harness`) — see the implementation amendment at the bottom of
  this file for what actually shipped, what is genuinely verified, and what is mechanism-only.

## Context

RegulAIt routes every dispatch through one governed core (`executeGovernedDispatch`) against an
`agents` registry whose entries carry a `model`, an admin-authored `systemPrompt` base (ADR-0023),
a routing tier, and — since ADR-0034 — an optional `custom_provider_id`. Every one of those fields
is a lever an admin can change, and each change silently alters what the agent *does*. Today the
platform can prove a change is **governed, metered, and audited** (ADR-0019/0024); it cannot prove
the change did not make the agent **worse**. A prompt edit that quietly regresses refusal
discipline, a routing-tier drop (pillar 6) that trades quality for cost, or a swapped
`custom_provider` endpoint all pass every existing gate because those gates check *authority and
cost*, never *output quality*.

The workflow engine (WORKFLOW_ENGINE_SPEC §2 stage 8, §3 `automated_check`) already defines an
automated-checks stage that blocks promotion — today it means CI tests, code review, and security
scan. There is no check that answers "does this agent still meet its quality bar on a known set of
cases?" Without one, the forced Plan→Build→checks→merge pipeline has a hole exactly where an
AI-native platform most needs a gate.

The forces in tension:
- A regression gate is only trustworthy if it is **reproducible** — the same dataset version, the
  same scorers, the same baseline — otherwise a red result is dismissed as noise and the gate is
  worked around, which is worse than no gate.
- LLM-as-judge scoring is itself a governed model call. It costs money, it is non-deterministic,
  and the judge is itself an agent that can regress. A harness that ignores this is measuring with
  a ruler made of rubber.
- The product is provider-agnostic (CLAUDE.md standing principle). The judge cannot be hard-locked
  to one vendor.

## Decision

Build an **evaluation harness** as a first-class governance surface, not a test-runner bolt-on.

### 1. Versioned golden datasets as immutable records

Proposed schema: `eval_datasets` (id, name, `version` int, `created_by`, `created_at`, `note`) and
`eval_cases` (id, `dataset_id`, `dataset_version`, `input` jsonb, `expected` jsonb nullable,
`rubric` jsonb nullable, `tags` text[]). A dataset **version is immutable once referenced by a
run** — editing cases mints a new version rather than mutating an existing one, mirroring the
never-edit-an-Accepted-record discipline the ADRs themselves follow. A gate result is meaningless
unless the dataset it ran against is pinned and cannot move underneath it.

### 2. Pluggable scorers — four kinds, one interface

A scorer takes `(case, agent_output) → { score: 0..1, passed: bool, detail }`. Four built-in kinds,
selected per dataset (or per case):
- **exact** — deterministic string/JSON-shape match against `expected`. Zero cost, zero variance.
- **semantic** — embedding similarity above a threshold; one embedding call, cheap, low variance.
- **llm_as_judge** — a judge **agent from the `agents` registry** scores the output against
  `expected`/`rubric`. Provider-agnostic by construction: the judge is any registry entry, so a
  deployment picks Claude, GPT, Gemini, or a self-hosted `custom_provider` judge, and the judge
  call runs through `executeGovernedDispatch` — **so it is entitlement-checked, metered into
  `usage_events`, and audited like any other dispatch**, not a side channel.
- **rubric** — a structured, weighted checklist (each criterion pass/fail with a weight); can be
  scored deterministically or handed to the judge. Makes "quality" an explicit, reviewable
  artifact rather than a single opaque number.

### 3. Scored results are first-class records

`eval_runs` (id, `dataset_id`, `dataset_version`, `agent_id` **or** `custom_provider_id`, `trigger`
∈ `scheduled|workflow|manual`, `judge_agent_id` nullable, `started_at`, `finished_at`, `status`)
and `eval_results` (id, `run_id`, `case_id`, `scorer_kind`, `score`, `passed`, `detail` jsonb). A
run is a durable, queryable record — the same way ADR-0027 made cert-rotation and backup
verification ledgered rather than ephemeral. New `audit_log.object_type` value `eval_run`
(plain-text column, no DDL, the pattern ADR-0024/0034 established).

### 4. Runs happen on a schedule AND as a workflow check that BLOCKS promotion

- **Scheduled** — a periodic sweep re-runs pinned datasets against currently-enabled agents,
  following the existing scheduler posture (ADR-0032/0035): loud on failure, admin-visible health.
  This is the drift detector (§5).
- **Workflow check** — a new `automated_check` kind `agent_eval` usable in any workflow template
  (WORKFLOW_ENGINE_SPEC §3). It runs a named dataset against the *candidate* agent config and
  **fails the stage — blocking promotion — when the score regresses below a stored baseline** by
  more than an admin-set tolerance. "Promotion" is concretely: enabling a new/edited agent,
  changing its `systemPrompt`/`model`/tier, or binding a new `custom_provider_id`. A regression is
  a real red check on the PR/merge gate, surfaced like any other failed check, not a warning buried
  in a log. Baseline = the last passing run on the same dataset version for that agent, stored on
  the run.

### 5. Drift alerts

The scheduled sweep compares each run to the agent's rolling baseline and raises a finding when the
score degrades beyond tolerance — even with no config change (a provider silently changed a model
behind a stable id; a `custom_provider` endpoint drifted). Findings surface through the **existing
one findings surface + one Approvals/review path** (ADR-0017), not a new alerting silo.

### 6. The judge is pinned and its cost is owned

- The `judge_agent_id` is recorded **on the run**, so "which judge, which version, at what cost"
  is always answerable and a gate result can never be silently re-scored by a different judge.
- Judge dispatches are ordinary metered calls: they land in `usage_events` attributed to a
  reserved internal project (or the initiating workflow's project), so eval spend is visible in the
  pillar-5 dashboard rather than hidden. The optimizer (pillar 6) must **not** down-route the judge
  — a cheaper judge is a different measuring instrument; the judge tier is pinned per deployment.

## Consequences

### Easier
- The workflow pipeline finally has a **quality gate** co-equal with its CI/security gates; a
  prompt or routing change that regresses an agent is caught before merge, by machine, not after an
  incident.
- ADR-0045 (MRM) gets a concrete, versioned evidence source for its model cards and recertification
  — "this agent scored X on dataset vN at date D" is a durable record it can link to.
- Provider-agnosticism is preserved end to end: both the evaluated agent and the judge are registry
  entries, so no vendor is privileged and a self-hosted judge works air-gapped.

### Harder / given up
- **A blocking gate can wedge delivery.** A flaky judge or a stale dataset can red a good change.
  Mitigations: deterministic scorers preferred where possible, an admin tolerance band, and an
  audited admin override on the stage — but an override is a recorded decision, never a silent skip.
- **Judge cost and non-determinism are real and disclosed.** LLM-as-judge runs cost tokens and vary
  run to run; a purely `llm_as_judge` dataset will have score jitter. The honest posture is to lean
  on exact/semantic/rubric scorers for anything load-bearing and treat the judge as corroboration.
- **Golden datasets go stale.** A dataset that no longer reflects real usage will bless the wrong
  behaviour. Immutable versioning makes staleness visible (an old version pinned to old cases) but
  does not fix it — dataset curation is ongoing human work this ADR does not automate.
- **This is measurement, not safety.** A high eval score is not a fairness, bias, or
  intended-use assurance — that is ADR-0045's job, which consumes these results but adds the
  governance lifecycle around them.

### Follow-up
- Wire `agent_eval` into the default "Standard Change Workflow + Design Review" variant once the
  first datasets exist.
- Decide the reserved-project attribution for scheduled (non-workflow) eval spend so it does not
  land in the Unattributed bucket (ADR-0024) by default.
- ADR-0045 defines the model-card/recertification layer that reads `eval_runs` as evidence.

---

## Implementation amendment — 2026-08-02 (migration 0056)

Accepted and built. This section records what shipped, where it deviates from the proposal above,
and — most importantly — **which parts of the gate are actually verified and which are only
mechanically wired**. Read the honesty section before treating a green eval as evidence of quality.

### What shipped

**Migration 0056 (`0056_eval_harness`)** — four tables:

- `eval_datasets` — **one row per (name, version)**, not one row per dataset with a mutable case
  list. Unique on `(name, version)`, plus a composite unique on `(id, version)` that `eval_cases`
  and `eval_runs` take as a foreign key. That FK is what makes "the dataset a run scored against
  cannot move underneath it" a database constraint instead of a convention. `eval_runs`' FK is
  `ON DELETE RESTRICT`: a scored version cannot be deleted out from under its own evidence.
- `eval_cases` — `input`, `expected` (jsonb), `rubric`, `tags`, and an optional per-case scorer
  override on top of the dataset default.
- `eval_runs` — the dataset version, the agent, **a snapshot of what was measured** (`agent_name`,
  `model`, `tier`, and a hash of the agent's ADR-0023 `systemPrompt`), the pinned judge
  (`judge_agent_id` + `judge_impl`), the trigger (`manual|workflow|scheduled`), the gate
  configuration (`tolerance`, `min_score`, `min_pass_rate`), the aggregate, the metered cost
  roll-up, and **the stored comparison** (`baseline_run_id`, `score_delta`, `pass_rate_delta`,
  `gate_passed`, `regression`, `gate_reason`). The comparison is stored rather than recomputed on
  read so a verdict stays reconstructible after the baseline moves. A partial unique index allows
  at most one pinned `is_baseline` run per (dataset version, agent).
- `eval_results` — per case: `scorer_kind`, `score`, `passed`, `latency_ms`, `cost_usd`, tokens,
  a truncated `output_text`, the judge's `judge_rationale`, and a `error` column that distinguishes
  "the dispatch was refused" from "the answer scored badly".

New `audit_log.object_type` value `eval_run` (plain-text column, no DDL — the ADR-0024/0034
pattern). No new ledger: eval spend lands in the one `usage_events` table, eval decisions in the
one `audit_log`.

**`packages/shared/src/evals.ts`** — the pure half: the scorer registry, the deterministic scoring
functions, the aggregate math, `evaluateEvalGate` (the gate decision), and the judge's
deterministic halves (`buildJudgePrompt`, `parseJudgeVerdict`). No db, no clock, no provider.

**`apps/gateway/src/evals.ts`** — the runner and the admin/run API. Every case executes through
`executeGovernedDispatch` with the agent passed as `served` (no routing — the harness measures the
agent it was asked to measure). The initiating user's `evaluateAgent` entitlement is checked before
any run row is created, for **both** the agent under test and the judge.

**`packages/workflow-kernel`** — `automated_check` stages gain an `evals` array binding a declared
check to a dataset + agent + tolerance. Template validation refuses a binding on a non-check stage,
on a check the stage does not declare, or two bindings for one check.

**`apps/gateway/src/workflows.ts`** — the check executor resolves eval-bound checks by *running*
them and folds the verdict into the existing results array. A failure therefore raises the existing
`check_failed` event and routes to `blocked_on_check` (or the stage's `rollbackStageId`) exactly
like a failed unit-test check. `POST .../checks` now refuses a reported result for an eval-bound
check (422) — a human must not be able to hand-wave a machine-decided quality gate green.

**SPA** — `/admin/evals` under Governance: datasets (with the frozen state visible), the case
editor, the scorer registry rendered with each scorer's honest `limits`, run triggering, the run
list with the delta and gate verdict, the per-case diff against the baseline, and baseline pinning.

### Deviations from the proposal above

1. **Scorer kinds: four became seven, and `semantic` did not ship.** §2 proposed
   `exact | semantic | llm_as_judge | rubric`. What shipped is `exact | contains | regex |
   json_schema | numeric | rubric | llm_as_judge`. The single `exact` was split into the five
   deterministic checks a real regression suite actually needs (a suite that can only do exact
   string match on free-text output is a suite nobody will keep). **`semantic` (embedding
   similarity) was deliberately NOT shipped**: it needs an embedding call, the dispatch core does
   not expose one, and no provider is connected — shipping a kind that cannot execute would be a
   worse lie than its absence. It stays a follow-up.
2. **`rubric` is deterministic only.** §2 allowed a rubric to be "scored deterministically or
   handed to the judge". Only the deterministic path shipped: weighted criteria, each a
   contains/regex match, scored as a weighted fraction with the per-criterion outcome stored.
   Handing a rubric to the judge is available by choosing `llm_as_judge` with the rubric on the
   case.
3. **`tags` is jsonb, not `text[]`.** Every array in this schema is jsonb (`agents.modes`,
   `guardrail_configs.custom_terms`); one native array would be the only place a reader has to
   switch idioms.
4. **Scheduled runs (§5, drift alerts) did NOT ship.** The `trigger` column carries `scheduled` and
   the runner accepts it, but nothing schedules a sweep and no finding is raised. Drift detection
   is a follow-up; today the harness runs on `manual` and `workflow` triggers only. **This is a
   real gap against §5 and is not hidden by a stub.**
5. **The reserved-project attribution question (§Follow-up) is still open.** A run attributes to
   whatever project the caller (or the workflow instance) names; an unattributed run lands in the
   Unattributed bucket per ADR-0024, unchanged.
6. **One addition the proposal did not name:** a scorer configuration that could never fail (a
   `contains` with no needles, a `regex` with no pattern, a `rubric` with no criteria) is refused
   at case-authoring time with 422. An eval suite where no case can go red is theatre, and it is
   far cheaper to reject it at authoring than to explain a green gate later.

### What is GENUINELY VERIFIED vs. what is MECHANISM-ONLY

**No model provider is connected in this deployment.** The owner's key is parked and was not used.
Everything below was exercised against the in-memory mock provider (a deterministic, local
adapter), wrapped by a recording spy so "was the provider called at all" is assertable.

**Genuinely verified — real behaviour, asserted end to end:**

- **All six deterministic scorers.** 33 pure unit cases in `packages/shared/src/evals.test.ts`,
  each with a passing AND a failing half, plus boundary cases (exact tolerance, invalid regex,
  non-JSON output, forbidden-substring override, weighted rubric partials). The golden dataset in
  the integration suite deliberately carries a case that **cannot** pass, so no green assertion in
  that file rests on a suite incapable of going red.
- **The gate arithmetic.** Identical results → delta exactly `0`; improvement → positive; a drop
  past tolerance → negative AND `regression: true`; a drop *of exactly* the tolerance passes and
  one epsilon past it fails; `tolerance: 0` makes any drop a regression; an absolute `minScore`
  floor is **not** outranked by "did not regress"; an empty suite never passes.
- **The eval path is governed.** A user with no grant on the agent is refused with the ordinary
  `AgentDecision` shape, no run row is created, **no provider call is made**, and the denial lands
  in `audit_log` as `object_type: eval_run`. An un-entitled *judge* is refused the same way.
- **The eval path is metered.** One `usage_events` row per case, attributed to the run's project,
  carrying `detail.purpose = 'eval'` and the run id; the run's `cost_usd` roll-up matches the sum
  of those ledger rows. The judge's own dispatch produces its own metered row with
  `detail.purpose = 'eval-judge'` — so ADR-0044 §6's "judge spend is visible in pillar 5" is real.
- **The eval path is not a content-control bypass.** With `prompt_injection` at `block`, an eval
  case whose input trips the detector fails with score 0 and **zero provider calls**.
- **Block-on-regression at the workflow gate.** Baseline run passes; the agent's system prompt is
  then edited to a degraded one (exactly the ADR's motivating scenario); the workflow's
  automated-check stage runs the eval, the score regresses past tolerance, and the instance parks
  at **`blocked_on_check`** — the workflow state is asserted, not a boolean — with
  `workflow:check_failed` in the audit trail, the unbound sibling check still passing, and the
  per-case diff naming the regressed cases. Undoing the prompt and calling the ordinary
  `/recheck` endpoint resumes the pipeline. A check bound to a dataset that does not exist
  **fails** rather than passing. A human reporting an eval-bound check green is refused (422).
- **Dataset immutability.** Adding a case to a version a run has scored is refused (409); minting
  the next version copies the cases and is editable.

**Mechanism-only — wired, type-checked, partially exercised, but NOT proven:**

- **LLM-as-judge.** `ModelBackedJudge` routes through `executeGovernedDispatch` and that path *is*
  exercised: the tests show it really dispatches, that the judge call is metered as `eval-judge`
  against the run's project, that the judge agent is entitlement-checked, and that an unparseable
  verdict fails the case loudly instead of silently passing. Its prompt builder and verdict parser
  are unit-tested. **But no real model has ever scored anything through it.** The mock answers in
  prose, and the injected `StubJudge` returns a fixed verdict. Therefore: **the judge's plumbing is
  verified; the judge's JUDGMENT is not.** Do not read a judge-scored eval result in this build as
  a quality measurement.
- **The regression gate as a whole, at the level of judgment.** The gate's *mechanism* is proven —
  a score drop past tolerance reliably fails the check and routes as a check failure through the
  existing path. What is **not** proven is the gate's *judgment*: whether the scores it compares
  correspond to real output quality, because the outputs being scored came from a deterministic
  local mock rather than a model. A gate that has never been exercised against real model output is
  a gate whose mechanism is proven, not its judgment. Establishing the latter requires a connected
  provider and a curated dataset, and is explicitly out of scope for this slice.
- **Provider-agnosticism of the judge.** It is provider-agnostic *by construction* (the judge is
  any registry entry, including a `custom_provider`), but only the `mock` provider has been run.

### Verification performed

- Migrations 0001–0056 apply clean to a fresh database.
- `pnpm -r build` clean; web bundle builds clean.
- Full gateway suite: **1226 → 1247 tests, all passing**, run twice against two independently
  created fresh databases (a prior slice had to fix a test order-dependency, so the new suite
  restores the guardrail org-default singleton it mutates in `afterAll`, and its users carry
  display names with no `@` so the names-only directory assertion in another suite still holds).
- `packages/shared`: 17 → 50 tests, all passing. `policy-kernel`: 129, unchanged.

### Follow-ups this slice leaves open

- The **scheduled sweep and drift findings (§5)** — the `scheduled` trigger exists, nothing drives
  it, and no finding is raised into the ADR-0017 surface.
- **`semantic` scoring**, once the dispatch core exposes an embedding call.
- **Reserved-project attribution** for non-workflow eval spend (§Follow-up above), unchanged.
- Wiring `agent_eval` into the default "Standard Change Workflow + Design Review" variant once real
  datasets exist — deliberately not done, because a blocking gate on an empty or unproven dataset
  would wedge delivery for no measurement gain.
- **Re-verify the judge and the gate's judgment against a real provider** the moment one is
  connected. Until then, this ADR's §4 promise is delivered as a mechanism, not as a measurement.

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
