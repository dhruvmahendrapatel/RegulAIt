# ADR-0207: Lifecycle for connectors, MCP servers, git and PM connections (G3–G6)

- **Status**: Accepted
- **Date**: 2026-10-30

## Context

The owner approved the after-demo lifecycle proposals on 2026-10-29 (#453, comment 6509969403) and unparked the
G3–G6 set on 2026-10-30 (#453, comment 6522492997, which also reserved migrations 0219–0222 and this ADR number).
Before this change:

- a connector could not be disabled or removed, only its credential, and saving or removing that credential was not
  audited;
- an MCP server could not be disabled or removed, only single tools halted, and a registry could be switched off but
  never deleted;
- a git connection could only be created and deleted (#596), so a wrong token meant deleting the connection, which
  broke the workflow stages naming it;
- a PM connection's webhook secret was shown once at creation and could never be rotated, and the connection could not
  be edited.

PR #605 held the approved UI on mocked routes. This ADR records the gateway routes, migrations and rules that make it
real.

## Decision

The owner's decisions, as approved (c6509969403):

| Gap | Decision |
|---|---|
| G3 Connectors | **As shown.** Disable and enable, with a step-up to re-enable. Delete only once disabled, and never while approvals or chat connections refer to it. Credential save and remove become audited. |
| G4 MCP servers | **As shown**, plus registry delete. Row actions move next to the name in the wide table. |
| G5 Git connections | **As shown:** edit the base URL and replace the token. Also add an in-use refusal to #596's delete. |
| G6 PM connections | **As shown:** edit, replace the token, and rotate the webhook secret with a 24 h overlap. The button reads "Rotate secret". |

## As built (2026-10-30)

All routes are versioned under `/v1`, admin-only through the default gate (none is in `NON_ADMIN_ROUTES`),
CSRF-checked by the global cookie gate, bounded by `.strict()` zod contracts in `@regulait/shared`, and audited in the
same transaction as their write. A refusal has its own code. No response or audit row carries a token or secret.

### G3 — connectors (migration 0219)

- `POST /v1/connectors/:connectorId/enabled {enabled, reason}`. Disabling needs a reason of 10 to 1000 characters
  (the CHECK `connectors_disabled_check` repeats it), stamps `disabled_at` on the database clock and is audited as a
  `deny` (`connector-disabled`). Enabling again is a `settings_relax` step-up (as for agents) with a compare-and-set,
  audited as `connector-enabled`.
- A disabled connector refuses every governed call first, in `executeGovernedConnectorCall` (403 `connector_disabled`,
  a deny row `connector-disabled-refused`), so a call that waited for an approval is refused when it comes back. The
  ChatOps courier refuses to post through it. 0122's statement trigger on `connectors` advances the policy epoch, so a
  call decided before the disable is withheld at its next epoch check.
- `DELETE /v1/connectors/:connectorId`: 409 `connector_not_disabled` while enabled; 409 `connector_in_use` while
  approvals or ChatOps connections refer to it, with exact counts and at most 20 ids of each. Otherwise grants, role
  and agent grants, revocations and the credential cascade, and `connector-removed` counts them.
- Credential save (`connector-credential-saved`, `set` or `replaced`) and removal (`connector-credential-removed`) are
  audited.
- `GET /v1/connectors` returns `enabled`, the reason, when, and who disabled it (by email).

### G4 — MCP servers and registries (migration 0220)

- `POST /v1/servers/:serverId/enabled` as for connectors (`mcp-server-disabled` / `mcp-server-enabled`).
- A disabled server refuses the proxy route before the transport is hijacked (403 `mcp_server_disabled`) and
  `executeGovernedToolCall`, which delegated workers call directly; each refusal writes a deny row
  (`mcp-server-disabled-refused`). Nothing connects upstream, and no approval is queued or spent. Halts, admission and
  the circuit breaker stay separate facts.
- 0220 adds a row trigger that advances the policy epoch only when `disabled_at` changes (the proxy rewrites the row
  constantly for breaker state, so a statement trigger would invalidate every in-flight admission), plus a statement
  trigger on delete. It reuses `advance_governance_policy_epoch()`; no new function.
- `DELETE /v1/servers/:serverId`: 409 `mcp_server_not_disabled`; 409 `mcp_server_in_use` while approvals, agent grants
  (`identity_server_grants`, `identity_tool_grants`) or versioned rules (approval rules, data-scope rules, rate limits)
  refer to it. The rules are a deviation from the approved text, stricter than it: their foreign keys cascade, and a
  cascade would remove an ADR-0074 versioned rule with no `config_versions` row. Tools, grants, revocations and the
  upstream credential cascade, counted in `mcp-server-removed`.
- `PATCH /v1/servers/:serverId` (the existing edit, now with an Edit dialog) refuses a disabled server (409
  `mcp_server_disabled`), and a rename or url move is audited as `mcp-server-updated` with both values. A url move
  still clears identity propagation and the upstream credential, as before.
- `DELETE /v1/mcp-registries/:registryId`: 409 `mcp_registry_not_disabled` while enabled. Catalogue entries cascade;
  imported servers keep running and lose the link (`registry_id` is ON DELETE SET NULL, 0105). `mcp-registry-removed`
  (phase `registry-removed`, under the registry routes' `mcp_server` object type) names the detached servers.
- The servers table puts the actions column second, next to the name.

### G5 — git connections (no migration)

- `PATCH /v1/git/connections/:name {baseUrl}`: only the base URL. The name and provider are fixed (stages name the
  connection). A new URL goes through the egress guard again (400 `egress_blocked`, as on create). Compare-and-set,
  `git-connection-updated` with both values.
- `POST /v1/git/connections/:name/token {token}`: replaced in place, `git-connection-token-rotated`.
- `DELETE /v1/git/connections/:name` (#596) now refuses with 409 `git_connection_in_use` while an active template or an
  unfinished workflow instance has a `git_operation` stage naming the connection (a `jsonb_path_exists` query; at
  most 20 names or ids of each).

### G6 — PM connections (migration 0221)

- `PATCH /v1/pm/connections/:name {project?, baseUrl?, apiVersion?, driftResolution?}`. The name is part of the webhook
  address and the provider picks the adapter, so neither can change. The edited connection must still resolve; a new
  base URL is checked by the egress guard. Compare-and-set, `pm-connection-updated` with the changed fields.
- `POST /v1/pm/connections/:name/token {token}`: replaced in place, `pm-connection-token-rotated`.
- `POST /v1/pm/connections/:name/webhook-secret/rotate {immediate?}`: a new secret, shown once. The previous secret
  moves to a three-column slot (its hash, its data-key envelope in `CIPHERTEXT_COLUMNS`, and
  `previous_webhook_secret_valid_until = now() + 24 hours`). The webhook tries the current secret first and the previous
  one only while the window is open on the database clock. A second rotation inside the window is 409
  `rotation_in_progress` unless `immediate`, which ends every older secret at once. `pm-webhook-secret-rotated` records
  the end of the window. No step-up: rotation only tightens.
- `GET /v1/pm/connections` returns `driftResolution` and `previousSecretValidUntil` (only while the window is open).

### Migrations, UI and size

- 0219–0221 are hand-written (never `drizzle-kit generate`), with journal `when` = 1785149000000 + (N − 214) × 1,000,000.
  0222 is left unused. The two `disabled_reason` columns are registered in `prose-scrub.ts` (ADR-0102).
- The UI calls each route literally (so the route census and affordance parity see them), and the edit, token and
  rotation dialogs load lazily from one module. All JS rises from 1,050 kB to 1,056 kB (ADR-0196 addendum, citing
  c6522492997); entry ceilings are unchanged.
- Open source first (ADR-0176): no library fits a governance lifecycle rule; these routes reuse Fastify, drizzle, zod
  and the existing step-up, egress and audit helpers.

## Consequences

- Every integration object now has the same order: disable (reason, audited), then delete; enable again is a step-up.
  Evidence (approvals) is never cascaded away.
- A token can be replaced without breaking the stages or links that name the connection.
- A PM webhook secret can be rotated without losing events in flight.
