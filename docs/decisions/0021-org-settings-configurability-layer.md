# ADR-0021 — `org_settings`: the single home for org-wide functional defaults (the configurability layer)

- **Status:** Accepted
- **Date:** 2026-07-30
- **Implements:** the owner's standing mandate — *"admins must have options to enable/disable
  features whenever there is a functional or technical choice feasible"* — as applied to the
  findings of the configurability audit (every place the codebase hardcoded a functional or
  technical choice an admin could reasonably want to make).
- **Builds on:** [ADR-0020](0020-ide-interception-compat-endpoints.md) (the
  `interception_settings` singleton pattern this generalizes: fixed-PK singleton + CHECK,
  admin-only GET/PUT, partial update, every write audited, admin-UI tab),
  [ADR-0019](0019-per-user-revocation-and-full-attribution.md) (block-mode streaming
  suppression, the one usage ledger), [ADR-0014](0014-role-bundled-agent-connector-grants.md).

## Context

A configurability audit against the owner's mandate found that pillar 6 in particular was **a
wall of unwired kernel constants**: `@regulait/optimizer-kernel` already accepted override
parameters (`thresholdTokens`, `minCacheableTokens`, `maxTools`, `minBaselineTokens`,
`perRequestOverheadTokens`, `minTokens`, TTL and discount constants) that **no caller ever
passed** — the dials existed, the admin had no lever. Beyond pillar 6, a set of
regulated-buyer-relevant behaviours were hardcoded: PII enforcement silently absent for
unclassified projects, the env-var platform-key fallback always on, project budgets always
hard-blocking at exactly 100%, workflow `human_approval` stages always all-must-approve, audit
pruning manual-only, orchestration worker turn caps and several size ceilings frozen as
constants, streaming-on-block always suppress-and-buffer, and the compat surfaces' `temperature`
accept-and-disclose tier non-optional.

`interception_settings` (ADR-0020, migration 0037) had already proven the shape of the answer
for one domain. This ADR generalizes it.

## Decision

### 1. One `org_settings` singleton table (migration 0038) is the single home for org-wide functional defaults

One row, ever — fixed primary key `'singleton'` plus a CHECK constraint, exactly like
`interception_settings`. Columns (37 functional + bookkeeping):

- **Pillar-6 technique toggles** (all default `true`): `routing_enabled`, `compaction_enabled`,
  `prompt_caching_enabled`, `edit_vs_rewrite_enabled`, `file_preprocessing_enabled`,
  `lazy_tool_loading_enabled`; plus `default_routing_mode` (`automatic`|`passthrough`, default
  `automatic`) — the org default for users with no per-user `routingMode`.
- **Pillar-6 numeric dials**, wired to the kernel override params that existed unconnected:
  `compaction_threshold_tokens` (1600), `compaction_recent_window` (4), `min_cacheable_tokens`
  (1024), `cache_read_discount` (0.9), `max_tools_in_manifest` (20),
  `min_editable_baseline_tokens` (200), `batch_overhead_tokens` (200), `min_preprocess_tokens`
  (200).
- **Semantic cache policy**: `semantic_cache_policy` (`off`|`opt_in`|`always`, default `opt_in`
  = today's caller-opt-in; `off` wins over a caller's `semanticCache: true`) +
  `semantic_cache_ttl_seconds` (3600).
- **Compaction behaviour**: `compaction_failure_mode` (`fail_open`|`fail_closed`, default
  `fail_open`), `summarizer_selection` (`cheapest`|`fixed_agent`, default `cheapest`) +
  nullable `summarizer_agent_id` (a fixed pick must still be inside the caller's own
  entitled+dispatchable roster — it can pin a choice, never widen entitlement).
- **Governance/compliance defaults**: `default_pii_mode` (`none`|`log`|`warn`|`block`, default
  `none` = today's no-enforcement) applied wherever a project-attributed call's compliance
  cascade resolves to no PII policy (an unclassified project, or tags with no profile) — a
  classified project's cascade always wins, the default only fills the gap; unattributed calls
  stay unenforced. `env_key_fallback_enabled` (true) + `env_fallback_providers` (all four)
  gating the ANTHROPIC_API_KEY-style dispatch-time fallback, so a regulated org can force every
  credential through the encrypted store.
- **Budgets**: `budget_enforcement` (`block`|`warn_only`, default `block`) +
  `budget_hard_block_pct` (100) — `warn_only` still escalates into the one Approvals Queue and
  audits every crossing, but lets the call run (showback without enforcement).
- **Approvals**: `approval_quorum` (`all`|`any`, default `all`) for workflow `human_approval`
  stages; `any` advances on the first approval and supersedes the stage's remaining pending
  rows so no dead gate outlives the advance.
- **Audit retention**: `auto_prune_enabled` (false), `prune_interval_hours` (24),
  `default_audit_retention_days` (null = never prune without a profile floor). The effective
  floor is `max(compliance-profile floor, org default)` — **a framework floor always wins
  upward; the org default can only add retention where no profile set one, never shorten one.**
  An hourly, unref'd boot scheduler runs the same prune the manual button runs, off by default.
- **Worker caps**: `default_worker_max_turns` (6), `max_worker_turns` (20) — the previous
  orchestration constants, now dials (20 stays the absolute API/kernel wall).
- **Size ceilings**: `max_attachments_per_dispatch` (8), `max_attachment_bytes` (6 MiB — the
  shipped composer's own clamp), `image_token_estimate_tokens` (1200),
  `shared_context_max_chars` (100 000), `node_output_max_chars` (20 000).

Two settings were folded into `interception_settings` instead (same migration, ALTERs), because
they are properties of the interception surface, not org-wide defaults:
`streaming_on_block_mode` (`suppress`|`reject`, default `suppress` = ADR-0019's
buffer-and-disclose; `reject` 400s a stream request to a block-mode PII project on both the
invoke path and the compat shims) and `strict_field_rejection` (default `false`; `true`
disables the `COMPAT_IGNORED_FIELDS` accept-and-disclose tier so `temperature` 400s again —
the strict pre-#47 posture).

### 2. The CEILING MODEL: org ≥ user, narrowing only

The composition rule for every pillar-6 technique (`effectiveTechniqueMode` in
`org-settings.ts`): **org toggle off ⇒ passthrough for everyone — no per-user setting can
re-enable it**; org toggle on ⇒ the user's own `routingMode` when set (a user's `passthrough`
always wins — narrowing is always available), else the org `default_routing_mode`. The same
directionality holds everywhere: a zod/schema max stays the absolute wall and an org ceiling
can only move DOWN from it (attachments, worker turns, chars); the org PII default cannot
override a compliance cascade; the org retention default cannot shorten a profile floor; a
fixed summarizer cannot leave the caller's entitled roster. Nothing in this layer can ever
*widen* what a user could do before it existed.

An org-disabled technique also writes **no savings-ledger row** (there is no decision to
account for); a per-user passthrough under an org-enabled technique still records its
passthrough decision, exactly as before.

### 3. Behaviour-preserving defaults are a MIGRATION INVARIANT

Every default equals the pre-0038 behaviour, so applying the migration is invisible until an
admin acts. This was verified mechanically: the full 432-test gateway suite runs green against
the migrated schema with an untouched settings row, and the new suite's first assertion is the
default row itself. The one deliberate hair-split: `max_attachment_bytes` defaults to the
composer UI's own 6 MiB clamp, which sits slightly below the API's ~6.75 MiB base64 wall — an
API-only caller sending 6.3–6.75 MiB is newly rejected; real traffic (the shipped UI) is
unaffected, and the zod wall is unchanged.

### 4. Same operational pattern as `interception_settings`, deliberately

`loadOrgSettings` is byte-for-byte the `loadInterceptionSettings` pattern (indexed PK select,
belt-and-braces singleton creation), loaded once per request at each consumption point and
threaded down. `GET/PUT /v1/org/settings` are admin-only (absent from `NON_ADMIN_ROUTES`); PUT
is a partial update; every write lands an `org_settings` audit row (new `objectType` union
member, no DDL) naming exactly the changed keys. The admin UI gained an **"Organization" tab in
the Policy nav group** — org_settings answers the same "what does this org allow / default to"
question the Rules Engine answers per-object, answered once for the whole deployment; a
separate top-level group for one tab would fragment the nav. Sections: Optimization /
Compliance defaults / Budgets & limits / Approvals / Retention, each its own partial PUT, with
plain-language descriptions of what each dial does and what its default means. The Compliance
section additionally SHOWS which conventional env keys are currently present on the server
(names and booleans only — never a value). `GET /v1/me` additively carries the two attachment
ceilings so the /app composer clamps against the org's numbers instead of constants.

### 5. What landed where — and what was deferred

- **Here (org_settings)**: everything org-wide-functional above.
- **interception_settings**: `streaming_on_block_mode`, `strict_field_rejection` — surface
  posture, not org default.
- **Deferred, recorded**:
  - *Per-template stage-level `quorum` override*: the workflow kernel's `stageSchema` strips
    unknown keys at `validateDefinition`, so a stage-level field would need a kernel change
    (`packages/workflow-kernel` is outside this batch's file boundary). Quorum is org-level
    only for now; the kernel addition is cheap when wanted.
  - *Per-user/per-project dial overrides* (e.g. a per-project compaction threshold): the
    ceiling model supports them naturally (narrowing only), but no buyer signal yet justifies
    the extra rows; the org dial is the 90% case.
  - *True async request batching*: `batch_overhead_tokens` tunes the estimate only — the
    synchronous path still dispatches nodes individually, as before.
  - *Compat-surface UI limits*: the /app composer reads its ceilings from `/v1/me`; IDE
    clients get the server-side 422s only.

## Consequences

- Every functional choice the audit found is now an admin lever with an audited write path,
  and the product's own story ("default-deny, admin-configurable, honest about posture") now
  applies to its optimization and compliance behaviour, not only its access control.
- Hot paths pay one extra indexed PK select per consultation — the same cost profile
  `interception_settings` already established; no caching layer was added, matching that
  precedent (and its correctness-over-latency trade).
- The gateway suite grew from 432 to 452 tests; the new file
  (`apps/gateway/src/org-settings.test.ts`) pins the defaults, the ceiling model, and one
  behavioural test per admin choice.
