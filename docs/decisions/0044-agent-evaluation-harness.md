# ADR-0044: Agent evaluation harness — versioned golden datasets, pluggable scorers, and a promotion-blocking workflow check

- **Status**: Proposed
- **Date**: 2026-08-01
- **Relates to**: ADR-0009 (TS/Fastify stack, hand-rolled policy kernel), ADR-0018
  (six-dimension assignment matching), ADR-0019/0024 (the one `usage_events` ledger, unconditional
  metering), ADR-0021 (`org_settings` ceiling model), ADR-0023 (`agents.systemPrompt` as a
  governance artifact), ADR-0034 (`custom_model_providers`)
- **Cross-refs (forward)**: ADR-0045 (model risk management — consumes this harness's scored
  results as its eval evidence)
- **Pillars**: 2 (workflow engine — the automated-checks stage), 5 (cost — judge calls are
  metered), 6 (optimization — a routing/prompt change is exactly what a regression gate must catch)
- **Migration**: proposed, next free number (0049+). Nothing here ships until this ADR is Accepted.

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
