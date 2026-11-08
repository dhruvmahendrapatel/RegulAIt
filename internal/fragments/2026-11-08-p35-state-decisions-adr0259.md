<!-- fold: state-decisions -->
**ADR-0259 (builder, 2026-11-07, Accepted; backlog P35): endpoint MCP client-config discovery.** `apisec-inc/mcp-audit`
is MIT, but it has one tagged release (v1.0.0, 2026-01-15) and is a Python CLI that cannot run inside the static Go
agent, so none fits. The Go agent gets a native, read-only `mcp_config` collector (mcp-audit is design reference only;
PatronAI too, §7): one fact per configured server, never executed, never an argument or value. Each fact carries:
- the transport, the command base name, the package or image and the remote host;
- key presence with its type;
- compiled risk flags and risky auto-approved tools.

It is off by default per org: `discovery_settings.endpoint_mcp_config_enabled`, pending migration
`endpoint_mcp_config_discovery`; turning it on is a `settings_relax` step-up, audited. It is also an opt-in kind on the
device (`enabledOptInKinds`). While it is off, mcp_config facts are counted and refused. While it is on, they feed the
host config's shadow-AI device finding and the `endpoint_mcp_servers` inventory, which keeps secret types only and has
the ADR-0122 registry diff, audited admin links to approved servers, and an `endpoint-mcp-servers-added` audit event.
Agent permissions are unchanged. The three admin routes are temporary KNOWN_UI_GAPS (owner decision on #733, option c);
the screen is tracked on #453. Open:
- the history-marker question on #453;
- the PatronAI-derived catalogue additions;
- JSONC/TOML configs, a gap until a maintained parser passes ADR-0176;
- the agent config route serving the opt-in once the SD4 pack signer lands.
