<!-- fold: pending -->
**P33 — Third-party client compatibility (SDK and platform review, owner 2026-11-07).** **Built (ADR-0257):** the
official OpenAI and Anthropic SDKs, the Laravel AI SDK and dart_mcp run, each in a digest-pinned image with its
dependencies vendored at build, against a real gateway (auth, governed allow and deny, streaming, tool calls, cost
attribution, audit); CI job `client-compat.yml` on compat/MCP paths plus nightly. Fixed on the way: the SSE shims forced
`Connection: keep-alive`. Follow-ups: a governed `/v1/responses` shim (laravel/ai's default `openai` driver needs it);
provider-shaped 401s on compat routes (the shared auth hook answers `{"error":"unauthenticated"}`); dart_mcp has no HTTP
transport of its own.
