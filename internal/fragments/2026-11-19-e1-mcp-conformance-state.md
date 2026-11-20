<!-- fold: state-recap -->
**2026-11-19 - MCP 2026-07-28 conformance check (G10, [ADR-0311](../decisions/0311-mcp-2026-07-28-conformance.md), lane E1, branch `builder/e1-mcp-conformance`).**
The 2026-07-28 revision is a breaking, stateless protocol: no `initialize`, `_meta`-carried version and capabilities,
`server/discover`, `Mcp-Method`/`Mcp-Name` headers, and `InputRequiredResult` in place of server-to-client requests.
Only the v2 SDK packages implement it, so the gateway does not conform yet. ADR-0311 records the gap matrix. This slice
fixes the transport MUSTs that hold in every revision the gateway serves:
- `/mcp/:serverId` refuses a browser `Origin` other than the public URL's (403 `mcp_origin_refused`);
- it refuses JSON-RPC batches from protocol 2025-06-18 on;
- it answers DELETE with 405.
The staged move to SDK v2, serving both protocol generations, is proposed for an owner decision.
