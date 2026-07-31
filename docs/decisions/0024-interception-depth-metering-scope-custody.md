# ADR-0024 — Interception depth: meter everything, scoped surface rollout, and key custody as an enforced rung (O11 / O13 / O15)

- **Status:** Accepted
- **Date:** 2026-07-31
- **Implements:** [ROADMAP §6](../product/ROADMAP.md) orphaned items **11** (unattributed-MCP
  metering + docs honesty), **13** (per-role/per-project interception overrides), **15**
  (`key_custody`/`network` enforcement rungs) — together "the difference between *we intercept*
  and *we can't be bypassed*".
- **Builds on:** [ADR-0019](0019-per-user-revocation-and-full-attribution.md) (MCP attribution,
  the one usage ledger), [ADR-0020](0020-ide-interception-compat-endpoints.md) (compat surfaces,
  the posture ladder, the indistinguishable 404), [ADR-0021](0021-org-settings-configurability-layer.md)
  (the ceiling pattern: a setting only ever narrows), [ADR-0023](0023-schema-depth-credential-json-systemprompt-mcpmode.md)
  (which disclosed the O11 gap it now closes).
- **Migration:** `0041_interception_depth.sql`.

## Context

Three honesty gaps survived Batch H, each disclosed in an earlier ADR rather than closed:

1. **O11.** An MCP tool call without `x-regulait-project-id` was governed and audited but wrote
   **no usage/pricing row**. Pillar 5's true coverage was therefore "every *attributed* gateway
   call" (ADR-0019's own consequences section says so), while the specs read as if it were every
   call. The leak was invisible: unattributed spend showed up nowhere at all.
2. **O13.** The `interception_settings` posture is a singleton, so both compat surfaces flip
   org-wide at once. An admin could not pilot the Anthropic surface with one team — the exact
   staged-rollout move a careful org wants — without exposing it to everyone.
3. **O15.** `enforcement_posture` includes `key_custody`, but nothing *enforced* it: per-user BYO
   credentials kept working regardless, so the rung was a declaration wearing the costume of a
   mechanism. `network` likewise had no story beyond a table row.

## Decision

### 1. METERING IS UNCONDITIONAL; attribution only decides WHERE a row lands (O11)

Every allowed, executed MCP tool call now writes the same `usage_events` row (server flat
per-call price, `object_type='mcp_tool'`) whether or not it is attributed. An unattributed call
lands with `project_id = NULL` — the explicit **"Unattributed" bucket**, rolled up by
`GET /v1/costs/unattributed` (admin-only) and rendered as its own labeled card on the Cost &
Projects tab, never mixed into any total a project reports.

**Why a visible bucket rather than either extreme.** Silently continuing not to meter keeps the
leak invisible; silently folding unattributed spend into some project would fabricate
attribution. An admin has to *see* the leak to decide to close it. The invariants that make this
safe are pinned in tests:

- a NULL-project row can never hit a project budget — `preDispatchProjectGate` and every
  per-project rollup filter on `projectId`, so all pre-existing project numbers are unchanged;
- PII enforcement on unattributed calls stays absent (there is still no project policy to
  enforce) — metering and policy are different things;
- denied calls and upstream failures still bill nothing.

**The admin lever.** `interception_settings.require_mcp_attribution` (default **false** =
today's behaviour) mirrors the compat surfaces' `require_project_attribution` exactly: when
true, an MCP call with no `x-regulait-project-id` is rejected **pre-dispatch** — before the
reply is hijacked into an MCP transport, so it is a plain HTTP 400 naming the header — and
audited (`ruleId: mcp-attribution-required`). The two require-toggles together close the
unattributed gap entirely; the docs now say precisely that (see §5).

### 2. SCOPE RULES: staged rollout with a strict precedence chain (O13)

Migration 0041 adds `interception_scope_rules`: `(scope_kind ∈ user|project|role, scope_id,
anthropic_compat_enabled BOOL NULL, openai_compat_enabled BOOL NULL, resolution_mode TEXT NULL,
note, created_by, timestamps)`. `NULL` = inherit. `scope_id` is polymorphic with no FK —
existence is validated at the API (422 `unknown_scope_target`), and a dangling rule matches
nothing.

**Precedence, exactly:** `user > project > role > org singleton`. Each of the three fields
resolves **independently** — the first non-NULL value walking down that chain wins for that
field. Ties *within* one kind (a user holding two roles whose rules disagree) resolve to the
**most recently created** rule (`createdAt` desc, id desc as the total-order tiebreak). The
project dimension is the request's `x-regulait-project-id` header — the same attribution signal
everything else uses.

**The gate stays indistinguishable.** The onRequest 404 gate is now scope-aware for the two
compat routes: with no scope rules in the table it is byte-identical to the ADR-0020 gate (org
value, no identity resolution). With rules present, the caller's identity is resolved from the
same headers the auth hook reads; an unauthenticated or invalid caller resolves at the **org**
level, so a credential-less probe cannot even detect that scope rules exist. A surface disabled
by resolution answers the same Fastify-shaped 404 as one disabled org-wide. The MCP route stays
org-only — scope rules deliberately cover the compat surfaces, which are the rollout question.

**THE CRITICAL POINT — surface exposure is NOT entitlement.** A rule enabling a surface for a
role grants *nothing*. It only decides that the provider-shaped route exists for those callers;
`evaluateAgent` still gates every dispatch identically. Pinned with the load-bearing pair of
tests: org-off + role-enabled + **unentitled** user → still 403 `agent_denied`; org-off +
role-enabled + **entitled** user → 200. `resolutionMode` overrides are disclosed: the effective
mode and its source ride the response's `regulait.resolutionMode`/`modeSource` and the audit
row, so a scoped override is never invisible.

Admin surface: CRUD at `/v1/interception/scope-rules` (admin-only, every write audited with
`objectType interception_scope_rule`), plus `GET /v1/interception/effective?userId=&projectId=`
— a live preview that runs the *same resolver* the gate and `prepareCompatCall` run, so the
preview cannot drift from enforcement. The Client Access tab gains the scope picker,
inherit/enabled/disabled tri-state per field, and the per-user effective-value preview.

### 3. KEY CUSTODY becomes an ENFORCED rung; the ladder is labeled honestly (O15)

`interception_settings.key_custody_enforced` (default **false**). When **true**:

- `POST /v1/users/:userId/model-credentials` (create *and* update — the endpoint upserts)
  returns **409 `key_custody_enforced`** explaining custody mode, and every refusal is audited
  (`ruleId: key-custody-enforced`);
- dispatch credential resolution **skips stored per-user credentials entirely** — org/platform
  credentials (and the org-gated env fallback) are the only path to a vendor. The org holds the
  vendor keys; developers hold only RegulAIt keys;
- `configuredProviders` applies the same skip, so pillar-6 routing can never select an agent
  only a now-inert user credential could serve.

**Reversibility is deliberate:** existing `user_model_credentials` rows are *not* deleted — they
are inert while enforced and come back exactly as stored when the toggle is lifted. Deleting
them would turn a policy experiment into data loss. The flip itself is audited by the existing
settings-PUT audit (changed keys named).

**Honest posture display.** `GET /v1/interception/settings` now returns a computed
`posture` object beside the raw row, and the Client Access tab renders from it, so the UI can
never claim enforcement the deployment does not have:

| Rung | Status shown |
|---|---|
| `observe`, `voluntary` | **Honor system** |
| `managed` | **Policy** (reversible on the developer's machine) |
| `key_custody` + toggle ON | **ENFORCED by this deployment** |
| `key_custody` + toggle OFF | **DECLARED but NOT enforced** — an explicit warning |
| `network` | **Requires egress control at your network boundary — see docs** |

**The network rung stays infrastructure, and the docs now say how.**
`docs/product/IDE_INTEGRATION.md` gains a Network-rung section with a concrete egress-allowlist
recipe (block `api.anthropic.com` / `api.openai.com` / the other vendor APIs at the boundary,
allow only the RegulAIt gateway). It is documentation of an infra-level control, stated plainly
as such — not product code, and the product does not pretend otherwise.

### 4. Rider — prompt-cache estimation counts the admin base

The pillar-6 cacheable-token estimate on the invoke path counted only the caller's `system`,
but since ADR-0023 the dispatched system is the **served agent's admin `systemPrompt` base +
the caller's system**. The estimate now measures the composed prefix, matching what the
provider actually caches — fixing both under-reported savings and wrongly-skipped caching when
the base alone cleared the provider minimum. Cost-annotation accuracy only; no behavioural
change to what is dispatched.

### 5. Docs honesty

`GOVERNANCE_LAYER_SPEC.md` §10 and `IDE_INTEGRATION.md` now state the *now-true* pillar-5
claim: **every gateway call is metered; attribution determines where the cost lands** (a
project, or the visible Unattributed bucket); the two require-attribution toggles close the
unattributed gap entirely for deployments that want the guarantee. The previous phrasing
("every *attributed* call", flagged by ADR-0019/0023) is retired because the caveat no longer
exists.

## Consequences

- **Positive.** Pillar 5's coverage claim is literally true for the first time, with the
  residual (unattributed) spend visible instead of absent. Staged rollout exists without
  weakening the default-deny gate or the 404 indistinguishability, and cannot leak privilege by
  construction (exposure ≠ entitlement, pinned). The interception ladder stops overstating
  itself: each rung is labeled with what actually enforces it, and the cheapest non-bypassable
  rung is now a real toggle rather than a claim.
- **Negative / trade-offs.**
  - Gated compat requests pay one extra indexed existence probe; when scope rules exist they pay
    an identity resolution in the onRequest phase (same authenticate(), run once more). Accepted
    for the same correctness-over-latency reason as ADR-0020/0021.
  - Unattributed MCP metering changes an observable number: users' total metered event counts now
    include unattributed tool calls (orchestration runs without a project included). Called out
    here and asserted in tests rather than hidden.
  - Scope rules cover the two compat surfaces + resolution mode only. Widening to other posture
    fields (attribution requirements, custody) was deliberately not done: those are org-level
    guarantees, and per-scope exceptions to a guarantee would un-guarantee it.
  - Custody enforcement governs **this gateway's** credential use. It cannot stop a developer
    with a personally-obtained vendor key from calling the vendor directly — that is the network
    rung, which remains the customer's boundary control, as documented.

## Files

- `packages/db/migrations/0041_interception_depth.sql`, `packages/db/src/schema.ts`
- `packages/shared/src/index.ts` (settings schema + scope-rule schemas)
- `apps/gateway/src/compat-core.ts` (resolver, posture status, scope-rule CRUD, effective preview)
- `apps/gateway/src/app.ts` (scope-aware interception gate)
- `apps/gateway/src/mcp-proxy.ts` (unconditional metering, `require_mcp_attribution`)
- `apps/gateway/src/agents-connectors.ts` (custody 409 + dispatch/routing skip,
  `GET /v1/costs/unattributed`, cache-estimate fix)
- `apps/gateway/src/admin-portal.ts` (Client Access + Cost & Projects)
- `apps/gateway/src/interception-depth.test.ts` (e2e)
- `docs/product/IDE_INTEGRATION.md`, `docs/product/GOVERNANCE_LAYER_SPEC.md`
