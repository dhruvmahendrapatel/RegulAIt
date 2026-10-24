# ADR-0048: Agent / prompt / policy versioning — immutable labeled versions, canary rollout, one-click rollback

- **Status**: Accepted
- **Date**: 2026-08-01 (proposed) / 2026-08-02 (accepted + implemented, migration 0060)

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

## Implementation amendment — 2026-08-02 (migration 0060)

Accepted and built. This section records what shipped, where it deviates from the proposal above,
and — most importantly — **what is genuinely enforced versus what is structural only**. Read the
honesty section before assuming a rule canary shadows anything. It does not.

### What shipped

**Migration 0060 (`0060_config_versioning`)** — two tables, three columns on `usage_events`, and a
behaviour-preserving backfill:

- `config_versions` — `(artifact_type, artifact_id, version)` unique, with `body` jsonb holding the
  artifact **verbatim**, plus `label`, `parent_version`, `status` ∈ `draft | canary | active |
  rolled_back | superseded`, `canary_pct`, `author_user_id`. §1's invariant is enforced by **two
  PARTIAL UNIQUE INDEXES** — at most one `active` and at most one `canary` row per artifact — rather
  than by convention, and a CHECK ties `canary_pct` to the `canary` status **in both directions**, so
  a percentage can neither be missing on a canary nor linger on a promoted version.
- `config_activation_events` — the append-only record of *which version was active when*, with
  `action` ∈ `created | activated | canary_started | canary_adjusted | promoted | rolled_back |
  abandoned`, the `from_version`, the gating `eval_run_id`, and an `override` flag whose DB CHECK
  **forces a non-empty reason**.
- `usage_events.config_version_id` / `.config_version` / `.config_canary` — §3's STAMP. Three real
  columns, indexed, not a jsonb key: "which version served this dispatch" is a `WHERE` clause.
- **Backfill**: every agent with a non-null `system_prompt` becomes `version 1, active, label
  'v1 (pre-versioning baseline)'`, with a matching activation event. An agent with **no** prompt gets
  **no** row — inventing an empty v1 would make "has this agent ever had a base prompt?"
  unanswerable.

New `audit_log.object_type` value `config_version` (plain text, no DDL), with stable ruleIds:
`config-version-created`, `config-version-activated`, `config-version-rolled-back`,
`config-canary-started`, `config-canary-adjusted`, `config-canary-abandoned`,
`canary-promoted-eval-gated`, `canary-promote-blocked`, `canary-promote-override`,
`canary-promote-override-no-reason`.

**`packages/shared/src/config-versions.ts`** — `canaryBucket` (FNV-1a 32-bit, implemented in ten
readable lines rather than imported; **not** cryptographic, and the file says why so nobody
"upgrades" it to sha256 and silently re-buckets every in-flight canary), `resolveVersion`,
`stableKeyFor` (run id → conversation id → user id), `canaryIsLive`, and `evaluatePromotion`.

**`apps/gateway/src/config-versions.ts`** — `newVersion` (INSERT only), `activateVersion` (the one
operation behind activate, rollback **and** promote), `resolveAgentPromptVersion`, and the admin API.

**`apps/gateway/src/agents-connectors.ts`** — two edits, both inside the ONE dispatch core:
resolution replaces the direct read of `served.systemPrompt`, and the resolved version is stamped
onto the `usage_events` insert. `POST /v1/agents/:agentId/system-prompt` — which used to be a raw
`UPDATE agents SET system_prompt` — now mints a version and activates it.

**SPA** — `/admin/prompt-versions` under Governance.

### §1's precedent, and the one denormalization, stated plainly

This follows **ADR-0040**'s shape exactly: immutable version rows, an active pointer, activation as a
pointer move, and rollback as "activate an older row" rather than a separate mechanism.
`activateVersion` is the single function behind all three verbs; rollback and promotion differ only
in the ruleId, the reason and the ledger `action`.

**`agents.systemPrompt` is now a READ-MODEL of the active version**, rewritten by `activateVersion`
on every pointer move. This is a deliberate denormalization with one writer, and it is what makes a
new prompt version visible to the two surfaces the ADR says it must reach without either learning
about `config_versions`:

- **ADR-0044's eval harness** hashes `agents.systemPrompt` into `eval_runs.system_prompt_hash`, so an
  eval run automatically snapshots the **active** version's text.
- **ADR-0045's MRM gate** governs the served agent, which is unchanged — versioning changes the
  prompt, never which agent is served, so the gate composes with no edit at all.

**Dispatch never trusts the read-model**: `resolveAgentPromptVersion` reads `config_versions`
whenever any version row exists for the agent, which is the only way a canary can serve a different
body than the active one. An agent with no version rows falls back to the column, which is
byte-identical pre-0048 behaviour.

### Deviations from the proposal above

1. **THE RULES ENGINE IS NOT WIRED.** §1's `artifact_type` vocabulary is implemented in full and
   `approval_rule` / `rate_limit` / `data_scope_rule` / `compliance_profile` versions can be created,
   activated and rolled back through the same surface — but **the rules kernels still read their own
   tables and ignore `config_versions` entirely**. Consequently §2's **shadow canary for restriction
   rules evaluates nothing**: a stored rule canary changes no behaviour and produces no
   "what-would-this-have-blocked" signal. `canaryIsLive` names the boundary in code, the lineage
   endpoint says so in its `note`, and a test asserts that text. This is the largest gap in the
   slice and it is a follow-up, not an oversight — wiring four kernels to resolve through a version
   table is its own slice with its own regression surface.
2. **`agent_config` is likewise vocabulary-only.** Only `agent_system_prompt` resolves at dispatch.
3. **Rollback reads the ACTIVATION LEDGER, not version arithmetic.** §5 says "the immediately-prior
   active version". Implemented as the `from_version` of the most recent activation event, because
   "the previous active" and "the version numerically below this one" stop being the same thing the
   moment a rollback has already happened.
4. **A displaced canary returns to `draft`, not `rolled_back`.** It was never active, so calling it
   rolled-back would misstate its history. An explicitly ABANDONED canary does become
   `rolled_back`.
5. **Retention/pruning is not built.** §"Consequences" requires a pruning policy tied to the
   compliance-cascade retention tiers. Versions accumulate monotonically today. The stamping means
   any pruning must respect ledger references, which is exactly why it is deferred rather than
   guessed at.
6. **The prompt-cache skew is disclosed, not measured.** Two prompt variants in flight lower the
   prompt-cache hit rate during a ramp; nothing here quantifies that.

### What is GENUINELY ENFORCED vs. what is STRUCTURAL ONLY

**Genuinely enforced — every dispatch assertion is made on TWO things at once, the text the
PROVIDER actually received (a recording spy) and the version stamped on the ledger row, so a stamp
that disagreed with the served text could not pass:**

- **AN IN-PLACE EDIT DOES NOT LOSE THE PRIOR VERSION.** The test drives the pre-existing
  `POST /v1/agents/:id/system-prompt` endpoint twice and asserts v1's row still exists afterwards
  **with its original body**, status `superseded`, while v2 is `active`.
- **ACTIVATION IS IMMEDIATE.** The dispatch after the edit is asserted to send v2's text, and the
  `usage_events` row is asserted to carry v2's id, `config_version = 2`, `config_canary = false`.
- **ROLLBACK IS IMMEDIATE AND REWRITES NOTHING.** After rollback the very next dispatch sends v1;
  v2's row **still exists** with its body intact at status `rolled_back`; and the activation ledger
  is asserted to have **grown by exactly one row with every prior row unchanged**. Re-activating v2
  afterwards proves a rollback can itself be rolled back.
- **THE CANARY SPLIT IS DETERMINISTIC AND STICKY.** The test picks two real users whose buckets
  differ, computed with the **same pure function the resolver uses**, sets the percentage between
  them, and then dispatches each user **six times**, asserting every single call lands on the same
  side — text and stamp both. A per-call coin flip fails this. The pure suite additionally pins the
  FNV-1a constants, so swapping the hash breaks loudly instead of silently re-bucketing.
- **A SPECIFIC REQUEST IS TRACEABLE TO ITS VERSION.** The stamped version's stored **body** is
  asserted equal to the text the provider received, and the routing **bucket** is recorded in the
  usage detail — so the split is reproducible from the ledger row alone, months later.
- **THE ADR-0023 INVARIANT SURVIVES.** A caller-supplied `system` is asserted to appear **after** the
  versioned base, never instead of it.
- **PROMOTION IS GATED.** An ungated promotion returns 409 `canary-promote-blocked` **and the canary
  is asserted to still be the canary** — a refused promotion changes nothing. An override without a
  reason is refused. An override with a reason succeeds and the reason is asserted present on the
  append-only ledger with `override = true`. An eval run that **predates** the canary is refused,
  which is what makes the gate a gate rather than a checkbox.
- **ADMIN GATING.** Every versioning route is refused to a non-admin (create, activate, canary,
  promote, rollback, read), and the version count is asserted unchanged afterwards.
- **BEHAVIOUR PRESERVATION.** An agent with no version rows dispatches from `agents.systemPrompt`
  with **nothing stamped**; an agent with no base prompt sends no system at all.

**Structural only — stated plainly:**

- **Rule/compliance-profile versions are stored and nothing reads them.** See deviation 1. A canary
  on `approval_rule` today is a row, not a control.
- **No blast-radius preview.** ADR-0059's simulation consumes the shadow signal that deviation 1
  says is not produced.
- **No pruning.** `config_versions` grows monotonically.
- **`agent_config` versioning is vocabulary only.**

### Verification performed (covers ADR-0047 and ADR-0048 together)

- Migrations **0001–0060 apply clean to a fresh database**, verified on two independently created
  databases.
- `pnpm -r build` clean; web bundle builds clean.
- `policy-kernel`: **129**, unchanged. `workflow-kernel`: **39**, unchanged.
- `packages/shared`: **116 → 150** tests, all passing (19 new ADR-0047 cases, 15 new ADR-0048 cases).
- Full gateway suite: **1308 → 1341** tests, all passing (16 new in `reporting.test.ts`, 17 new in
  `config-versions.test.ts`), run **twice** against two independently created fresh databases.
  Both new suites write to the ONE `usage_events` ledger and to `config_versions`, so each `afterAll`
  deletes every row it created — a leaked usage row would move another suite's org-wide totals, and a
  leaked active prompt version would change what every other dispatch suite sends.

### Follow-ups this slice leaves open

- **Wire the rules engine to resolve through `config_versions`**, and implement §2's shadow
  evaluation for restriction rules. This is the gap that matters most.
- **Retention/pruning** for `superseded` / `rolled_back` versions, respecting the ledger references
  the stamping creates.
- **`agent_config` resolution** at dispatch.
- **Quantify the prompt-cache skew** during a ramp.

## Amendment — 2026-08-09: deviation 1 is CLOSED (ADR-0073, migration 0084)

Appended, not rewritten: everything above stands as the record of what ADR-0048 decided and what it
shipped. This section records what has changed since, and exactly what has not.

**[ADR-0073](0073-rules-engine-versioning.md) closes deviation 1.** The rules engine now resolves
through `config_versions`:

- `governedEvaluate` overlays the **ACTIVE** version of every loaded `approval_rule`, `rate_limit`
  and `data_scope_rule` onto its row before calling the kernel, and `projects.ts:profilesForTags`
  does the same for `compliance_profile` — the one funnel every §8.3 cascade consumer already goes
  through. Activating and rolling back a rule version therefore **changes evaluation**, proved end
  to end through the kernel rather than by reading a status column.
- §2's **shadow canary for restriction rules now genuinely evaluates**. The candidate is run through
  the kernel a second time, parameterised by the candidate bodies and nothing else, and each sampled
  comparison is stored in `config_canary_observations` (migration 0084) with both sides' effect,
  ruleId and full reason. `canary_pct` is honoured as the shadow **sampling rate** on the same
  deterministic `canaryBucket` stable key.
- Resolution is **one indexed query per evaluation** across all three rule types, not an N+1.
- An artifact with version rows but **no active version** is UNRESOLVABLE and **fails closed** — a
  `deny` with `ruleId: config-version-unresolvable` in the kernel path, a real 409 in the compliance
  path. There is no branch on which "no version found" ends in an allow.
- ADR-0048 §7's behaviour-preserving default is applied **lazily**: the first version created for a
  rule mints `v1 (pre-versioning baseline)` from the live row and activates it. No migration
  backfill, so an install with no rule versions behaves byte-identically to before.

**`canaryIsLive` was NOT flipped for rules, deliberately.** It means "does the canary SERVE
traffic", it is read by `resolveVersion`, and making it true for a restriction rule would enforce a
candidate `deny` on a percentage of real work — the outage §2 exists to forbid. Instead the
vocabulary is split: `canaryIsLive` (serves — still **false** for every rule type, pinned by a
test), `canaryIsEvaluated` (something genuinely computes what the candidate would have decided —
now **true** for all four rule types and for prompts), and `canaryModeOf` → `live | shadow | inert`,
which is what the API and SPA report.

**Deviation 2 is still open, and is now reported honestly rather than mislabelled.** `agent_config`
was DECLARED a live-canary type by this ADR and never given a resolver, so `canaryIsLive`
('agent_config') answered "yes" about something nothing reads. `LIVE_CANARY_ARTIFACT_TYPES` is now
explicitly intent and `RESOLVED_ARTIFACT_TYPES` fact; `agent_config` is in the first and not the
second, and every surface reports it as `inert` — "changes nothing and measures nothing".

**Deviations 3, 4, 5 and 6 are unchanged.** In particular **retention/pruning (deviation 5) is still
not built**, and now covers one more table: `config_canary_observations` also grows monotonically
while a canary runs.

**One consequence of this ADR's own design is named by ADR-0073 rather than fixed**: the ordinary
rule-CRUD routes (`POST /v1/rules/approvals` and siblings) do **not** mint a version, unlike
`POST /v1/agents/:id/system-prompt` which does. A versioned rule edited through the old CRUD surface
would have its row and its active version disagree, and **dispatch would keep serving the version**.
See ADR-0073's disclosure 10.

The test in `config-versions.test.ts` that asserted this endpoint said "shadow evaluation for rule
types is NOT yet wired" was **rewritten, not deleted**, carrying a comment naming what changed and
why; it now pins the opposite claim plus the one thing that must not have changed with it.
