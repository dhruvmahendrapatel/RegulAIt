<!-- fold: pending -->
**P32 — Seed the admin MCP catalogue from the official MCP Registry, with community lists as unvetted entries (SDK and
platform review, owner 2026-11-07).** Building on `builder/p32-mcp-catalogue-seed`
([ADR-0256](../decisions/0256-mcp-catalogue-seed.md), migration `mcp_catalogue_seed`). API and backend: presets (the
official registry, `awesome-mcp-servers`) created disabled behind the egress check; snapshot refreshes (scheduled or
admin-triggered) through guarded egress; signed offline bundles for air-gapped installs; cross-source dedupe with
provenance per source; paid and x402 flagged; every entry "available, not admitted" until ADR-0101's import and the
admission scan (P23 scanners, P27 pinning). Left: the UI, posted on #453.
