<!-- fold: state-decisions -->
**ADR-0330 (builder lane E13, 2026-11-15, Proposed; PENDING P1): hook adapters for Cursor, Copilot CLI and Codex.**
- **What:** `regulait-agent hook cursor|copilot-cli|codex`, three parsers and renderers over ADR-0298's single
  `Decide` and the same signed policy. The policy gains an optional `agentModes` map (audit or enforce per agent).
- **Long-term shape (owner direction, 2026-11-15):** every agent is one `Adapter` value, made of contract data and a
  capability-matrix row, plus thin parse and render functions. Its fixtures are versioned per contract under
  `testdata/hooks/<agent>/<version>/`, and old versions are never edited. `regulait-agent hook-capabilities` prints the
  matrix.
- **Honest coverage:** none of the three reports where an MCP server was defined, so each one's calls carry an
  unattested source that a policy must accept explicitly. Cursor names the server and fails closed with `failClosed`.
  Copilot CLI cannot identify MCP servers, so its non-built-in tools are denied in enforce mode, and its timeouts
  always fail open. Codex takes the server only from the tool name, and its hook errors fail open.
- **Default:** off (nothing registers a hook; the keyring stays empty until SD4). The admin UI for per-agent modes and
  coverage is a known UI gap on #453.
- **Owner decisions (2026-11-15, ADR-0330 §8):**
  - Copilot CLI: audit mode plus GitHub's MCP registry allow-list.
  - Codex: audit-grade, paired with `requirements.toml`.
  - Cursor: allows answered "allow". Whether that skips Cursor's own run confirmation is not documented, and is a
    manual check.
  - Signing: one rotatable device-policy signer, shared with the browser lane. The agent verifies its pinned
    `devicePolicyKeys`, two at most.
