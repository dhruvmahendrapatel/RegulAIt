<!-- fold: pending -->
- **Managed-settings drift screen (ADR-0310 slice 2, lane E1).** `GET /v1/managed-settings/drift` is API-only; the
  drift list with its vendor and device filters is requested on #453 (Governed Designer).
- **Per-server drift (ADR-0310 slice 2).** ADR-0259 reports a remote server's host, never its path, so drift is per
  gateway host, not per `/mcp/<serverId>`. A device carrying a gateway server it is not entitled to is not drift (the
  gateway still refuses its calls). Revisit if the endpoint agent ever reports a path shape-checked against `/mcp/<uuid>`.
- **Catalogue rows for Copilot and Codex MCP configs (ADR-0310 slice 2, #902 review).** The shipped endpoint catalogue
  has no `assistant_config` row for `Code/User/mcp.json`, `Code/User/settings.json`, `.vscode/mcp.json` or
  `.codex/config.toml` (only the `.codex` directory), so the drift route reports those vendors as `not_collected` with
  unknown drift. Adding the rows is a catalogue change (ADR-0195 decision 15: a new pinned seed version or admin seed
  rows, each path checked against vendor documentation), with a test that every `MANAGED_VENDOR_CONFIG_PATHS` entry
  is covered. An admin can add the rows today; the coverage turns `collected` at once.
