<!-- fold: state-decisions -->
**ADR-0330 (builder lane E13, 2026-11-15, Proposed; PENDING P1): hook adapters for Cursor, Copilot CLI and Codex.**
- **What:** `regulait-agent hook cursor|copilot-cli|codex`, three parsers and renderers over ADR-0298's single
  `Decide` and the same signed policy. The policy gains an optional `agentModes` map (audit or enforce per agent).
- **Honest coverage:** none of the three reports where an MCP server was defined, so each one's calls carry an
  unattested source that a policy must accept explicitly. Cursor names the server and fails closed with `failClosed`.
  Copilot CLI cannot identify MCP servers, so its non-built-in tools are denied in enforce mode, and its timeouts
  always fail open. Codex takes the server only from the tool name, and its hook errors fail open.
- **Default:** off (nothing registers a hook; the keyring stays empty until SD4). The admin UI for per-agent modes and
  coverage is a known UI gap on #453.
