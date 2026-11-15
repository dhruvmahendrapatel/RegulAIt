<!-- fold: pending -->
**G2 follow-ups (ADR-0310, lane E1, 2026-11-15).** (a) Emit a VS Code device policy (`ChatMCP`,
`ChatAllowedMcpServers`, `/etc/vscode/policy.json`) once its value encodings are confirmed from primary docs. (b) Push
the servers themselves (Claude Code `managedMcpServers` / `managed-mcp.json`) with each vendor's client auth header,
which then makes per-tool `mcp__<server>__<tool>` rules possible. (c) The managed-settings export screen on #453.
