<!-- fold: state-recap -->
**2026-11-07 - backlog P33: third-party client compatibility tests ([ADR-0257](../decisions/0257-third-party-client-compat-tests.md), builder lane, branch `builder/p33-client-compat-tests`).**
- **Built:** `apps/gateway/client-compat/` (the harness) and `client-compat/` (the client images) run the official
  `openai` 7.43.0 and `@anthropic-ai/sdk` 1.3.0, `laravel/ai` v1.3.0 (its `openai-compatible` and `anthropic` drivers)
  and `dart_mcp` 0.5.2, each in a digest-pinned image with dependencies vendored at build, against a real gateway on an
  `--internal` network. Checks: auth, governed allow, governed deny, streaming, tool calls, cost attribution and audit.
  Own workflow `client-compat.yml` (compat/MCP paths, nightly 03:37 UTC, on demand).
- **Fixed (trivial):** the SSE shims forced `Connection: keep-alive`, which hung laravel/ai's Anthropic stream.
- **Follow-ups (PENDING P33):** a governed `/v1/responses` shim; provider-shaped 401s on compat routes; dart_mcp has
  no HTTP transport of its own. No migration.
