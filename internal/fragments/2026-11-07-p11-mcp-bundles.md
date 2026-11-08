<!-- fold: state-decisions -->
**ADR-0236 (builder, 2026-11-07): governed MCP bundles (backlog P11).** Step 1 finding: roles already bundle MCP tools
for users (`role_tool_grants`, `role_server_grants`), with per-user revocations; nothing reached a team, a tool set could
not be shared by several roles and teams as one unit, and grants had no versions. A bundle is a named, versioned list of
exact (server, tool) pairs granted to a user, role or team (`mcp_bundle_grants`, one subject). The kernel rule
`bundle-tool-allow-list` sits at the role tier and is fed by `loadEntitlements`, so every MCP decision and tool list
enforces it; a person's own revocation always wins, there is no wildcard, and every later narrowing applies. Versions are
append-only with a compare-and-set; a version that adds a tool is a `settings_relax` step-up plus an SoD check per
holder. Default-off `org_settings.mcp_bundles_enabled` (a step-up to enable). Scope tiers (owner-approved, design reference: the Gravitee APIM MCP server, ideas only): grants default to `max_tier` read, `mcp_tools.dangerous` is an admin flag, and a dangerous tool held through a bundle always pauses for the bundle's approver (fail closed without one). migration `mcp_bundles`. Open: dynamic lazy tool-loading (follow-up); the owner's reading
of "bounded by each user's allow-list" (ADR §Open question); UI on #453; SoD holdings, certification campaigns and RLS
follow-ups.
