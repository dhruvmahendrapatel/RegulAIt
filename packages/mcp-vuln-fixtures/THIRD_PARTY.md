# Third-party components — `@regulait/mcp-vuln-fixtures` (TEST ONLY, never shipped)

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `@modelcontextprotocol/sdk` (npm, github.com/modelcontextprotocol/typescript-sdk) | `1.32.2` (pinned in `pnpm-lock.yaml`, the gateway's version) | MIT | The low-level `Server` and its transports serve the fixture manifests exactly as written, so a test sees the bytes an attacker would send. |

**Clean room (ADR-0246).** These fixtures replace "Damn Vulnerable MCP Server" and "mcp-injection-experiments", which
carry no licence. Their source was not opened or read. Every fixture is written from the publicly documented attack
classes (tool poisoning, tool shadowing, rug pull, excessive permissions, secrets in output, exfiltration through
parameters, indirect injection through returned content) as described in public security write-ups and the OWASP MCP
Top 10. The secrets in them are fake, assembled at runtime so no credential-shaped literal is committed.
