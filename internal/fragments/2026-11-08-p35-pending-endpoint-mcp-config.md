<!-- fold: pending -->
**P35: MCP client configs on employee machines (from the security and infra review, owner 2026-11-07).** The endpoint agent saw that an MCP host's config existed, but not which MCP servers it names, what they run, which carry embedded secrets, which tools are auto-approved, or which are not governed here.

**Built (backend and agent), [ADR-0259](../decisions/0259-endpoint-mcp-config-discovery.md), pending migration `endpoint_mcp_config_discovery`.**
- `apisec-inc/mcp-audit` (MIT) fails the maintenance and fit check (one tagged release; a Python CLI), so the read-only Go agent gains a native `mcp_config` collector.
- It reports servers, secret types (never values), compiled risk flags and risky auto-approved tools, and never executes a server.
- It is default off per org (step-up, audited) and an opt-in kind on the device.
- The inventory has the ADR-0122 registry diff and audited links to approved servers, and it feeds the host config's shadow-AI device finding.

**Open:**
- the UI (#453; the three routes are temporary KNOWN_UI_GAPS);
- the owner's call on browser and shell history markers (#453);
- PatronAI-derived catalogue additions;
- JSONC/TOML configs, a reported gap;
- the agent config route serving the opt-in once the SD4 pack signer lands.
