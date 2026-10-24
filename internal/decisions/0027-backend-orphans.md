# ADR-0027 — Backend orphans: per-kind deploy-target config, A4's three halves, cert-rotation lifecycle, scheduled backup verification, stage quorum, partial revocations, per-tool MCP pricing, additive-only reclassification reapply, per-framework cost policies, PM drift auto-resolution + budget-mirroring

- **Status:** Accepted
- **Date:** 2026-07-31
- **Amends / closes:** the #64 flagged deploy-target gap; ADR-0019's deferred **A4** (all three
  halves, as ADR-0019 itself specified them); ADR-0021's deferred per-template stage quorum;
  ROADMAP §6 orphans O1, O2, O5, O6, O7, O8, O9, O10. Migrations **0043–0045**
  (0045 groups the smaller items' additive DDL; every default is behaviour-preserving).

## Context

Eleven verified-open backlog items, each an honest gap between what a spec/ADR promised and what
the backend enforced. All are governed by the standing mandate: admin choice wherever a real org
would differ, ADR-0021's ceiling/default conventions, behaviour-preserving defaults (a fresh
migration changes nothing until an admin acts).

## Decisions

### 1. Per-kind deploy-target config (migration 0043 — the #64 gap)

`createDeployTargetSchema` validated `roleArn` against the AWS ARN grammar **for every
provider**, so a real Azure subscription or GCP project id could not be stored unless it
masqueraded as an ARN. Now: the ARN grammar binds to **aws only**; azure gains
`subscriptionId`/`resourceGroup`/`templateUri`, gcp gains `projectId`/`blueprintGcs`, aws gains
`cluster`, kubernetes gains `namespace` + a **required kubeconfig credential** at creation.

**Storage: one validated `provider_config` jsonb**, not a column per field — the table stays
provider-agnostic (the standing principle: a future provider adds keys, not DDL), while the zod
per-kind validation (including loud rejection of a field on the wrong kind) is as strict as any
CHECK. Threading is **row-first**: `resolveDeployProvider` prefers the named
subscription/project/namespace over the legacy `roleArn`/`region` reuse, and
`liveDeployClients` overlays row fields onto the env the live-client factories read — the
`REGULAIT_DEPLOY_*` env vars become the fleet-wide fallback. Pre-0043 rows (null config) behave
byte-identically.

### 2. A4 (migration 0044) — the three halves ADR-0019 specified

- **(a) `audit_log.deploy_mode`**, written by deploy-mode-scoped actions only: the workflow
  deploy/rollback executors stamp their target's mode; governed infra mutations on
  target-pinned resources stamp theirs. **Null = unknown / not deploy-scoped.** Pre-existing
  rows are **un-backfillable by design** — ADR-0019 already established there is no mode to
  derive for them, so null is an honest absence, never an invented value.
- **(b) MAX-only per-mode retention** (`org_settings.mode_audit_retention`, `{}` default):
  effective retention per row = `max(global floor, override[row.deploy_mode])`. An override can
  only **extend** its mode's rows' retention; one at/below the floor is inert (dropped by
  `effectiveModeOverrides`); with no global floor, keep-all remains the fail-safe. Retention can
  never shorten below any applicable floor, by construction — the exact composition ADR-0019
  said was the only safe one.
- **(c) Mode-scoped restriction rules**: `deploy_mode` on
  `approval_rules`/`rate_limits`/`data_scope_rules` (mirroring migration 0026's additive
  scoping; null = mode-unscoped = today). The kernel gains `deployContext` — a **server-derived
  SET** of modes: the deploy targets named by the attributed project's in-flight workflow
  instances' deployment/rollback stages (`deriveDeployContext`), i.e. "the deploy target the
  change lands on" from ADR-0019, never client-asserted. **Precedence:** mode scoping is one
  more AND-condition on the rule *match*, additive-only (it narrows which restrictions apply,
  never mints an allow); an unknown/empty context means a mode-scoped rule does **not** match —
  a restriction binds to a known context, and since the context is server-derived, "unknown"
  means "not deploy-scoped work", not a dodge. Derivation is lazy (only when a loaded rule
  carries a mode), so the default path costs zero extra queries. Admin PATCH
  `/v1/rules/:kind/:id/deploy-mode`, audited.

### 3. O6 — cert-rotation lifecycle

`active → rotation_proposed → (approve) rotated | (deny) rotation_denied | (provider failure)
rotation_failed`; *rotating* is the in-txn provider call (no async boundary exists to observe it
across, so it is deliberately not a persisted checkpoint). One `cert_rotations` row **per
attempt**, created at propose and advanced by the decide hook, with the approver's
`decisionReason` or the provider's failure message in the new `reason` column. `rotation_denied`
and `rotation_failed` are **re-proposable** (the old code silently reset a denied cert to
`active`, erasing that a rotation was ever refused). Guards: propose only from
active/denied/failed (409 otherwise); a stale approval (cert no longer `rotation_proposed`) is
refused and audited; a provider failure records the failed state and re-opens the finding
instead of aborting the decide. patch/backup verbs keep their pre-O6 contract.

### 4. O5 — scheduled backup verification

`success` ledger rows were seed/manual-only. `runBackupVerifyOnce` checks each backup_target
through the **existing provider path** (`provider.scan` + the same `evaluateBackupSchedule` the
findings pipeline uses) and writes honest rows: success **only** when the provider's own
observation shows an un-missed recovery point; a missed/unobserved backup writes nothing (the
findings pipeline stays the surface for the miss); un-live providers are skipped. Every row is
source-labelled — `scheduler:<kind>`; **the mock provider's rows say `scheduler:mock`** and can
never pass for a real cloud verification; null = pre-O5/seed/manual. The boot scheduler mirrors
the audit auto-prune scheduler exactly (hourly unref'd tick, settings re-read per tick, onClose
stop) and is **OFF by default** (`backup_verify_enabled`, interval 24h).

### 5. Per-stage approval quorum (deferred from ADR-0021)

`human_approval` stages gain optional `quorum: all|any`, overriding the org default **in both
directions**. Loud validation: an unknown value now fails the enum (the object schema used to
strip it silently), and quorum on a non-approval stage is refused naming the stage. Absent =
org default = today.

### 6. O9 — partial revocations

`scope: full|read_only` on MCP and connector revocations (default `full` = every existing row =
ADR-0019's total semantics). `read_only` denies **write-classified** tools/operations while
reads stay allowed; a full revocation still beats everything, and the allow-path-only invariant
holds (a revocation can still never mint an allow). **Agent revocations stay total** — agents
carry no read/write op classification to scope by. Creation always defaults to full: a
revocation starts as the unambiguous total ADR-0019 argued for, and narrowing is an explicit,
audited second act (admin PATCH `/v1/revocations/{mcp|connectors}/:id/scope`).

### 7. O10 — per-tool MCP pricing

An optional `price_per_call_usd` **on the `mcp_tools` inventory row** (the additive column
ADR-0019 predicted), resolved **tool-first with the server flat price as fallback** at the one
metering site in `executeGovernedToolCall` — attributed and unattributed calls both honour it;
unpriced everywhere stays an honest null. A column on the inventory row rather than a jsonb map
on the server: the inventory row is the identity the proxy already resolves per call (no name
drift vs the manifest) and the manifest re-sync upsert (kind/description only) provably never
clobbers an admin-set price.

### 8. O1 — reclassification reapply, THE ADDITIVE-ONLY RULE

An approved reclassification (and a direct first classification — the same hole) recomputes each
affected in-flight instance's **remaining** requirements:

- **Strictly additive ⇒ automatic (audited):** a newly required template whose merge leaves
  every existing stage byte-identical, in order, and only **appends** stages. Appended stages
  are by construction not-yet-executed — they run after everything in flight, so no
  executed/passed stage is ever rewritten. `templateIds`, `definition` and the state's
  `stageStatuses` are extended; audited per instance.
- **Everything else ⇒ manual (surfaced, never silent):** a relaxation (a no-longer-required
  template's stages are **never removed** from a running instance — the stricter merged
  definition stands), a merge conflict, a changed existing stage, or a retired required
  template each earn a per-instance `reclassification-reapply-manual` audit row.

The rule is additive-only because anything else would either rewrite history (restructure) or
weaken a control mid-flight (relaxation) — both are human decisions.

### 9. O2 — per-framework cost policies

`compliance_profiles` gains `maxProjectBudgetUsd` (a **ceiling**, MIN-composed — strictest
framework wins, and it caps an **unbudgeted** project too: a framework cap is not opt-out-able
by leaving the budget blank) and `budgetEnforcement` (a **floor** — a profile's `block` forces
blocking even when the org says `warn_only`; a profile's `warn_only` can never relax a stricter
org and is surfaced as inert). Wired into `preDispatchProjectGate`
(`min(project budget, ceiling)`, the 409 names the governing framework); conflicts surface in
`GET /v1/projects/:id/compliance` (`costPolicy.conflicts`) exactly like existing cascade
conflicts. Composition matches the cascade's standing rules (MIN like patch cadence, strictest
like PII). The post-dispatch alert path still keys off the project's own budget — the gate is
the enforcement point; noted as a known asymmetry.

### 10. O7 — PM drift auto-resolution

Per-connection `drift_resolution: manual|prefer_pm|prefer_regulait` (default manual = every
existing row = detect-only). On detection the auto modes resolve **in the declared direction,
audited with before/after** (`pm-drift-auto-resolved`):

- `prefer_regulait` pushes RegulAIt's expected state back to the PM tool via the provider's
  `transitionState` — status ownership is RegulAIt's, so this is the safe direction; a failed
  push stays a surfaced drift.
- `prefer_pm` **adopts** the PM tool's reported state on the link (`pm_links.adopted_state`) —
  the run state machine is **never driven from outside** (a PM "Done" cannot complete a running
  node), so adoption records the declared source of truth and stops flagging that state as
  drift until the tool reports something new.

Deleted-item orphans and push failures stay surfaced in every mode — the honest "can't be
safely auto-resolved" set.

### 11. O8 — PM budget-approval mirroring

Run **budget-cap escalation** decisions (`__budget__:*` and `__nodebudget__:*`) now mirror to
the PM tool like sign-offs already do — onto the **run-level parent work item** (which exists
for exactly this), always as a **comment** (a spend sanction is not a stage outcome, so a
customer's "Approved" state is never entered), in **both directions** (approved and denied) via
the same decide-hook mirror as sign-offs (`pm-budget-decision-mirrored` audit). Project-level
budget escalations have no PM link to mirror onto and are unchanged.

## Consequences

- Every default is behaviour-preserving: null configs, null modes, `{}` retention overrides,
  `manual` drift policy, `full` revocations, OFF backup scheduler, absent quorum, unclassified
  projects and unpriced tools all behave byte-identically to before the migrations.
- Where the rule-model endpoints live in the SPA-owned `app.ts`, the new admin controls
  (deploy-mode scope, revocation scope) are registered in the org-settings module as
  post-creation edits — creation semantics stay untouched, and the second-act-narrowing shape
  is itself the safer default for revocations.
- Known limits, disclosed: per-mode audit retention only differentiates rows written after
  0044 (older rows have no mode — pruned under the global floor alone); the O2 ceiling does not
  yet drive the softer post-dispatch alert thresholds; `prefer_pm` drift adoption is per-state
  (a new diverging state is re-adopted on the next event, by design of "the PM tool is the
  source of truth").
