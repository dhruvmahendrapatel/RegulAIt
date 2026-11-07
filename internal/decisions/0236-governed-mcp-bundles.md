# ADR-0236: Governed MCP bundles: a versioned set of MCP tools granted to a user, role or team as one unit

- **Status**: Accepted (builder lane P11, dispatched by the master session; the owner's backlog item P11 of 2026-10-30
  on #453)
- **Date**: 2026-11-07
- **Extends**: [ADR-0014](0014-role-bundled-agent-connector-grants.md) (role-bundled grants),
  [ADR-0019](0019-per-user-revocation-and-full-attribution.md) (per-user revocations), [ADR-0219](0219-a2a-governance.md)
  (default-off governed surface pattern)
- **Migration**: 0291 (`0291_mcp_bundles.sql`, `when` 1785218000000)
- **Backlog item**: [PENDING.md](../product/PENDING.md) P11

## Context

PENDING P11: "Admins approve MCP servers one at a time. A governed bundle of MCP servers and tools that can be granted
as one unit, still bounded by each user's allow-list. Check what role-bundled grants already cover before building."

### Step 1 finding: what role-bundled grants already cover

| Mechanism | Grants | To whom | Versioned | Notes |
|---|---|---|---|---|
| `tool_grants` / `server_grants` (direct) | one tool, or every read tool of a server (`readOnlyAll`) | one user | no | a server grant without `readOnlyAll` is refused as inert |
| `role_tool_grants` / `role_server_grants` | one tool, or every read tool of a server | users assigned the role (directly or via an IdP group, ADR-0038) | no | already a "named bundle of default entitlements" (GOVERNANCE_LAYER_SPEC §5) |
| `revocations` (ADR-0019, O9 scopes) | subtract a role-derived tool, or every role-derived tool on a server, fully or for writes only | one user | no | direct grants survive a revocation |
| `a2a_agent_grants` (ADR-0219) | one remote agent, or one of its skills | one user only | no | grants through roles are a listed follow-up; not MCP |
| Lead ceiling, actor intersection (ADR-0188) | only narrow | a run / an agent | n/a | a worker never exceeds the person |

So roles already bundle MCP tools for users. What they do not cover, and what P11 builds:

1. **Teams.** No grant of any kind reaches a team. A team is the unit most customers onboard a tool set to.
2. **One unit, many holders.** A role's tool list belongs to that role. The same set of tools for three roles and two
   teams is five hand-kept copies that drift.
3. **Versioning.** A role grant is added or deleted in place; there is no record of "what the set was" and a change has
   no compare-and-set. A change to a widely held set is a governed act and should be one.
4. **A governed switch.** Role grants are always on. A new way to hand out access in bulk should start off.

Everything else (the per-user revocation, the read-only-all form, the actor and lead narrowing, the restriction rules)
already exists and is reused, not rebuilt.

## Decision

### 1. A bundle is a grant source at the role tier of the kernel

A bundle is a named list of exact `(server, tool)` pairs. The policy kernel gets one new rule,
`bundle-tool-allow-list`, consulted only when no direct and no role tool grant matched, and before the read-only-all
forms. Its input, `bundleToolGrants`, is pre-filtered by the gateway exactly like role grants.

**How it stays bounded by each person's own entitlement** (the P11 constraint):

- **The person's own revocation always wins.** A bundle grant is derived, so an ADR-0019 revocation (tool or
  server-wide, full or `read_only`) subtracts from it exactly as from a role grant. A bundle can never hand back what
  a person's own override took away.
- **No wildcard and no future tools.** Items are exact tools that exist in the inventory when the version is written.
  There is no server-wide or read-only-all form; a tool a server adds later is in no bundle until a new version names
  it.
- **Every narrowing after the grant step still applies**: the kill switch and halts, the lead ceiling, the ADR-0188
  actor intersection (an agent never exceeds its sponsor), ABAC, data scope, rate limits, approvals, MCP admission.
- **One interception point.** `loadEntitlements` loads the bundle items, so every path that already decides an MCP
  call or a tool list (`governedEvaluate`, `visibleTools` in the proxy, decompose, copilot, the builder roster, the
  stdio pre-connect check) enforces bundles the same way with no second code path.
- **Byte-identical when unused.** With no bundle input the kernel pushes no trace, so every existing decision and rule
  chain is unchanged.

Reading of the brief: "granting a bundle never widens what pillar 1's per-user entitlement allows; it only grants
within it" is taken as above: a bundle is an admin-defined pillar-1 grant (like assigning a role), never a bypass of
the per-user model. A strict intersection ("a bundle only re-grants what the person already holds") would add no
access at all, so it is not what was built. **Open question for the owner** (below).

### 2. Holders: a user, a role or a team

`mcp_bundle_grants` names exactly one subject (DB CHECK `num_nonnulls(...) = 1`). The loader resolves a user's
bundles through the direct row, the roles they are assigned (`role_assignments`) and the teams they belong to
(`team_members`), at each bundle's current version, skipping archived bundles. When one tool is held through several
bundles the kernel names the most direct holding (user, then role, then team).

### 3. Versioned, and a change is a governed event

- `mcp_bundle_versions` and `mcp_bundle_version_items` are append-only (`regulait_refuse_mutation`, no TRUNCATE).
  Version 1 is written at create; each change of tools is a new version written with a compare-and-set on
  `expectedVersion` under the bundle row lock.
- A version that **adds** a tool widens access for every holder at once: it is a `settings_relax` step-up, and the
  ADR-0091 separation-of-duties gate runs for every added tool and every existing holder. A version that only
  **removes** tools narrows and needs neither.
- Every bundle table advances the governance policy epoch, so a decision taken before a change is re-checked.
- "Delete" archives: the bundle confers nothing from then on and its history stays.

### 4. Default-deny and default-off

- `org_settings.mcp_bundles_enabled` is false by default (ADR-0180). While false, every bundle write is refused
  (`409 mcp_bundles_disabled`, audited as a deny) and the loader returns nothing, so an existing grant confers
  nothing. Turning it on is a relaxation in the strictness registry (`notEqual(false)`): `PUT /v1/org/settings`
  asks for a `settings_relax` step-up and names it in the audit row.
- Revoking a grant and archiving a bundle are never refused by the setting: taking access away is always allowed.
- No row = nothing granted.

### 5. Scope tiers: read < write < dangerous (owner-approved scope added 2026-11-07)

Design reference: the read / write / dangerous scopes of the Gravitee APIM MCP server
(`gravitee-io/gravitee-apim-mcp-server`). **Ideas only.** That repository shows no licence, so no code, text or schema
was copied from it.

- A tool's tier comes from the inventory: `mcp_tools.kind` (read or write), or `dangerous` when an admin has set
  `mcp_tools.dangerous`. The manifest re-sync never touches the flag. Setting it is a tightening and is only
  audited. Clearing it is a `settings_relax` step-up (`PUT /v1/mcp-tools/:toolId/dangerous`).
- Every bundle grant carries `max_tier`, which **defaults to `read`** (ADR-0180). A grant reaches a bundled tool only
  when the tool's tier is within the grant's max tier. The kernel uses the stricter of the inventory tier and the
  call's own tool kind, so a disagreement between the two can only narrow access.
- A **dangerous** tool reached only through a bundle always pauses for the bundle's approver
  (`mcp_bundles.approver_user_id`, rule id `bundle-dangerous-tool`), through the same Approvals Queue as every other
  hold. With no approver it is refused (fail closed). A grant with `max_tier = dangerous` is refused (400) while the
  bundle names no approver.
- The hold applies to the bundle path only. A direct or role grant keeps its own rules, and a tool held both ways is
  decided by the direct or role grant first, as before.

### 6. API (admin-only through the default gate; `internal` in the stability registry)

- `GET /v1/mcp-bundles`, `GET /v1/mcp-bundles/:bundleId`, `GET /v1/mcp-bundles/:bundleId/versions/:version`
- `POST /v1/mcp-bundles` `{ name, description?, approverUserId?, items }`, `PATCH /v1/mcp-bundles/:bundleId`
  `{ description?, approverUserId? }`,
  `PUT /v1/mcp-bundles/:bundleId/items` `{ expectedVersion, items }`, `DELETE /v1/mcp-bundles/:bundleId` (archive)
- `GET|POST /v1/mcp-bundles/:bundleId/grants` `{ userId | roleId | teamId, maxTier? }`,
  `DELETE /v1/mcp-bundles/:bundleId/grants/:grantId`
- `PUT /v1/mcp-tools/:toolId/dangerous` `{ dangerous }`

Every write audits in the same transaction as the row (`objectType: "mcp_bundle"`, rule ids `mcp-bundle-*`). Inputs
are bounded (200 items per version, name pattern, description length). The override view
`GET /v1/users/:userId/servers/:serverId/entitlements` lists bundle-held tools with `source: "bundle"`, the bundle, its
version and how it is held, flagged when revoked.

### 7. Open source first (ADR-0176)

Nothing to adopt: this is policy semantics and our own grant model (Cedar, OPA and the MCP SDK have no notion of our
pillar-1 grant tiers). Built only on what is already in use: Drizzle, zod, Fastify, the existing kernel.

## Consequences

- Admins can onboard a tool set to a team or several roles in one step, keep it as one versioned unit, and see every
  change and grant on the trail.
- One more grant source for reviews to know about. It reaches every MCP decision through `loadEntitlements`, so a new
  MCP path that uses that loader is covered automatically.
- One extra indexed query per MCP evaluation when the setting is on (none when off beyond reading the flag).

## Follow-ups (not in this slice)

- **Dynamic lazy tool-loading** (Gravitee design reference, pillar 6). Instead of sending every tool schema up
  front, expose a small meta-surface (`list_scopes`, `list_tools`, `describe_tool_input`, `execute_tool`) so the
  model loads a schema only when it needs one. Every `execute_tool` still goes through the same per-user entitlement
  check (`governedEvaluate`) and is audited as the underlying tool. It overlaps with the TOKEN_OPTIMIZATION_SPEC
  lazy tool-loading item and the existing `max_tools_in_manifest` setting, so it needs its own design. Too large for
  this PR.

- **UI**: a bundle editor and grant screen on the MCP governance pages (posted on #453 for the Governed Designer
  session).
- **SoD holdings**: the ADR-0091 gate checks every bundle MINT, but its read-time holdings do not yet include
  bundle-held tools, so a later direct grant is not checked against a bundle-held side.
- **Certification campaigns** (ADR-0090) do not yet list bundle grants as reviewable items.
- **Simulation page** label for the new `bundle-tool-allow-list` rule (web).
- **RLS** (ADR-0234) for the bundle tables with the next slice.

## Open question for the owner

P11 says a bundle is "still bounded by each user's allow-list". This ADR reads that as: the person's own per-user
overrides (revocations) always bound a bundle, and a bundle never grants anything but its exact, named tools. If the
owner meant a separate per-user ceiling that a bundle may only grant inside (a list of tools each person may ever be
given), that ceiling does not exist today and would be a new pillar-1 object; it can be added as a narrowing step in
the same kernel rule without changing the API.
