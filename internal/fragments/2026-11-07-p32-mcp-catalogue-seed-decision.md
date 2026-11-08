<!-- fold: state-decisions -->
**ADR-0256 (builder, 2026-11-07, Proposed): seed the MCP catalogue (backlog P32).** On top of ADR-0101, unchanged:
admin-only presets (the official MCP Registry, data CC0 1.0; `awesome-mcp-servers`, MIT) create a source disabled
through the egress check. Sources gain `listing_kind` (community = unvetted) and `delivery` (pull, or a signed offline
bundle for air-gapped installs: Ed25519 over the exact bytes, public keyring in `REGULAIT_MCP_CATALOGUE_BUNDLE_KEYS`,
none = every bundle refused, rollback-protected, never dialled). Each refresh writes an append-only
`mcp_catalogue_snapshots` row; `mcp_catalogue_items` dedupes by GitHub repository, else by name, with one source row
each; paid and x402 entries are flagged. Every entry stays "available, not admitted" until ADR-0101's import and the
admission scan (P23, P27). Migration `mcp_catalogue_seed` (numbered at merge). The UI is on #453.
