# ADR-0048: Agent / prompt / policy versioning — immutable labeled versions, canary rollout, one-click rollback

- **Status**: Proposed
- **Date**: 2026-08-01

## Context

The governance layer now has two admin-authored artifacts that directly shape what a dispatch
does but are themselves **ungoverned with respect to change**:

1. **The per-agent base system prompt** (`agents.systemPrompt`, ADR-0023) — a first-class
   governance artifact whose "admin base always wins" invariant is enforced in the one dispatch
   core, `executeGovernedDispatch`. Editing it today is an in-place `UPDATE`: the new prompt takes
   effect on the very next dispatch, org-wide, for every user, with no version history, no staged
   rollout, and no way to answer *"which prompt text served this particular dispatch?"* after the
   fact.
2. **The rules engine** (ADR-0027 §2 — `approval_rules`, `rate_limits`, `data_scope_rules`, plus
   `compliance_profiles` cost/mode policy, with the deploy-mode scoping ADR-0027 added). A rule
   edit is likewise immediate and in-place.

For a product whose entire thesis is *governing* AI, the governance artifacts being mutable-in-
place is the sharpest self-inflicted gap. A bad prompt edit (a typo that neuters a safety
instruction, an over-broad `data_scope_rules` change) becomes an incident with **no rollback,
no attribution, and no blast-radius preview**. We already treat policy-as-code as
version-controllable *in the customer's repos* (GOVERNANCE §5), but the live, DB-resident
values the gateway actually reads have no in-product version model.

The forces:

- **Auditability**: an auditor (and ADR-0058's compliance packs) must be able to reconstruct the
  exact prompt/rule *version* that governed any historical dispatch, not just the current value.
- **Safe change**: a prompt or routing change should be provable on a slice of real traffic before
  it becomes the default — the same "prove it before it's the default" posture the product forces
  on its *users* via Plan-mode, applied to *our own* governance config.
- **Reversibility**: undo must be a pointer flip, not a manual re-typing of the previous text from
  memory or a git blame.
- **No second policy path**: whatever we build must resolve at the *existing* dispatch core, never
  a parallel evaluation path (the ADR-0020/0023 invariant).

## Decision

Version every agent config, system prompt, and policy rule as **immutable, labeled versions**;
**canary** a configurable percentage of traffic onto a new version; support **one-click
rollback**; and **stamp the served version onto every dispatch's ledger row**. The agent
evaluation harness (ADR-0044) is the canary's **promotion gate**.

### 1. Immutable versioned records (never `UPDATE` in place)

A `config_versions` table keyed by `(artifact_type, artifact_id, version_int)` where
`artifact_type ∈ {agent_system_prompt, agent_config, approval_rule, rate_limit,
data_scope_rule, compliance_profile}`. Each row carries: the immutable body (prompt text or rule
definition JSON), `author_user_id`, `created_at`, an admin-set `label` (e.g. `"v7 — tightened PII
instruction"`), `parent_version_int`, and a `status ∈ {draft, canary, active, rolled_back,
superseded}`. An "edit" **inserts a new version**; the prior row is never mutated.

**Invariant**: at most **one `active` version per artifact** at any instant, and at most **one
`canary` version** alongside it carrying an integer `canary_pct`. Everything else is `draft`,
`superseded`, or `rolled_back`. Activation and rollback are recorded as their own audited
*activation events*, so the history of *which version was active when* is itself append-only and
reconstructable.

### 2. Canary routing — sticky, not per-call

When an artifact has a `canary` version at `canary_pct = N`, a dispatch is routed to the canary
iff `hash(stable_key) mod 100 < N`, where `stable_key` is a **stable-per-conversation** key (the
run id, else the initiating user id) — **not** a fresh coin-flip per call. A multi-turn run must
not flip its base prompt mid-conversation, so bucketing is sticky. `canary_pct` is admin-set and
adjustable without minting a new version (ramp 5% → 25% → 100%).

For **restriction rules** (`approval_rules` / `rate_limits` / `data_scope_rules`), a canary runs
in **shadow mode**: the canary version is *evaluated* and its would-be decision is *logged*, but
the currently-`active` version is what actually enforces. You cannot safely half-enforce a
`deny` — a 10%-canaried block would non-deterministically deny real work — so a rule canary
answers *"what would this rule have blocked?"* without blocking, which is exactly the signal
ADR-0059's blast-radius preview consumes. Prompts and model-routing config, being on the
generative hot path rather than the allow/deny path, canary **live**.

### 3. Dispatch-time resolution + stamping

Version resolution happens **inside `executeGovernedDispatch`** (and the shared
`executeGovernedToolCall` for rule-governed tool calls) — the one core, so the direct-invoke
path, orchestration workers, and both compat shims inherit it with zero reimplementation, exactly
as ADR-0023's base-prompt invariant already does. The resolved `version_int` for each governing
artifact is **written onto the dispatch's `usage_events` / audit row**, so *"which version served
this dispatch"* is a query, not an archaeology exercise. The ADR-0023 base-always-wins invariant
is preserved unchanged: a canary base prompt still wins over, and is still only *appended to* by,
a caller-supplied `system`.

### 4. Eval-gated promotion (ADR-0044 is the gate)

A `canary` version cannot be **promoted to `active`** until an ADR-0044 evaluation run against
that version's golden sets passes the configured regression thresholds. Promotion with a failing
or absent eval is possible only as an explicit, **audited manual override with a reason**
(`ruleId: canary-promote-override`) — the honest escape hatch for the period before ADR-0044
ships, and for artifacts an org has no golden set for. Until ADR-0044 exists, *every* promotion is
that manual-with-reason path, and the ADR says so rather than pretending the gate is live.

### 5. One-click rollback

Rollback re-activates the **immediately-prior `active` version** by writing a new activation event
that flips the current active to `rolled_back` and the prior to `active`. Because the prior body
is stored verbatim and immutable, rollback is a pointer flip — no reconstruction, no
recomputation — and is itself a versioned, audited act. A canary can be abandoned the same way
(canary → `rolled_back`, active untouched).

### 6. Deploy-mode scoping is orthogonal, inherited

A policy-rule *version* still carries ADR-0027's `deploy_mode` scoping; versioning is the unit of
*change*, scoping is the unit of *applicability*, and they compose without interaction — the
resolver picks the effective version, the kernel then applies that version's deploy-mode match as
today.

### 7. Behaviour-preserving migration

The migration backfills each existing artifact's current value as `version 1, status = active,
label = "v1 (pre-versioning baseline)"`, author = the migration, no canary. Nothing changes until
an admin creates a `v2` — the ADR-0027/0038 behaviour-preserving-default invariant.

## Consequences

- The governance artifacts become auditable and reversible like the code that reads them: an
  auditor can name the exact prompt/rule version behind any historical dispatch, and an admin can
  undo a bad change in one click instead of retyping it.
- **Storage grows monotonically** — immutable versions accumulate. A retention/pruning policy for
  `superseded`/`rolled_back` versions is required, reusing the compliance-cascade audit-retention
  tiers (GOVERNANCE §8.3) rather than a new knob; the `active` version and any version referenced
  by an un-pruned ledger row must never be pruned (the stamping in §3 pins them).
- Canary resolution adds one cheap hash + one indexed version lookup on the dispatch hot path.
  Live prompt canaries also mean **two prompt variants in flight**, which lowers prompt-cache hit
  rate during a ramp — a real, disclosed cost skew (ADR-0023 already noted the admin base rides
  the cache uncounted).
- Rule canaries are **shadow-only for `deny` effects** — you get the blast-radius signal, not a
  gradual enforcement ramp. Stated plainly so no one expects a 10%-enforced block.
- Promotion is only *as gated as ADR-0044 is built*. Until then it is manual-with-reason, which is
  honest but not yet a hard quality bar; the coupling is explicit so 0048 and 0044 are sequenced
  together.
- This is the enabling substrate for ADR-0059 (policy simulation / blast-radius: a shadow canary
  *is* a live blast-radius measurement) and a producer of evidence for ADR-0058 (compliance packs
  can cite version lineage). It does **not** version connector grants or role bundles in v1 — those
  have their own additive-grant history (ADR-0014/0019) and are a deferred, separate scope line.
