<!-- fold: pending -->
- **MCP 2026-07-28 stateless protocol (ADR-0311 decision 4, proposed).** The work is a staged move to the
  `@modelcontextprotocol/server` and `/client` v2 SDK (Apache-2.0). It serves both protocol generations on
  `/mcp/:serverId`, adds `server/discover`, `resultType`, `ttlMs`/`cacheScope` and the renumbered errors, speaks
  2026-07-28 to upstreams with a fallback to 2025-11-25, and decides the governance of MCP Apps `ui://` resources. It
  needs an owner or master decision on scope and timing; nothing in the spec is removed before 2027-07-28.
- **`outputSchema` on stdio stored manifests (ADR-0311).** A stdio server with a stored manifest has its `tools/list`
  rebuilt with only `readOnlyHint`, so `outputSchema` and the other annotations are lost. Keep the whole tool
  definition from the manifest.
