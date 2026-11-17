<!-- fold: state-recap -->
**2026-11-17 - G2 slice 2: managed-settings drift ([ADR-0310](../decisions/0310-vendor-native-managed-settings.md) decision 8, lane E1, branch `builder/e1-managed-settings`).**
`GET /v1/managed-settings/drift` (admin-only, keyset-paginated) reads ADR-0259's endpoint MCP inventory and lists every
enabled server in a managed vendor's MCP config (Claude Code, Copilot, Codex, Cursor) whose identity is not this
gateway's host, per pseudonymous device. Refused (409) with no public URL or before any bundle is exported. No new
table or migration. The route is an API-only gap on #453 (`KNOWN_UI_GAPS_MAX` 67). G10 (ADR-0311) is slice 3.
