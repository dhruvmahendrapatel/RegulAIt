# ADR-0257: Third-party client compatibility tests in CI (backlog P33)

- **Status**: Accepted (builder lane P33; owner-approved 2026-11-07, "From the SDK and platform review")
- **Date**: 2026-11-07
- **Index**: Third-party client compatibility tests in CI (backlog P33): official OpenAI and Anthropic SDKs, Laravel AI SDK and dart_mcp against a real gateway
- **Amends**: [ADR-0053](0053-public-api-sdks.md) by addition only. ADR-0053's decision stands unchanged: RegulAIt
  publishes a TypeScript SDK and no other language. This ADR adds no SDK; it proves that clients other people publish
  work against the gateway as they are.
- **Builds on**: [ADR-0020](0020-ide-interception-compat-endpoints.md) (the provider-compatible surfaces), the MCP
  proxy (pillar 1), ADR-0180/0181 (strict defaults).
- **Migration**: none.
- **Backlog item**: [PENDING.md](../product/PENDING.md) P33 (a §0 fragment under ADR-0252)

## Context

The gateway's adoption story is "point the client you already use at RegulAIt". Our own suites prove the compat and
MCP surfaces with `app.inject` and our own TypeScript clients, so they cannot catch a third-party client that sends a
header, field or transport detail we did not expect. The SDK and platform review (owner, 2026-11-07) asked for CI
tests with real third-party clients, without adding SDK languages:

- the **Laravel AI SDK** (`laravel/ai`, MIT, PHP), against the OpenAI- and Anthropic-compatible endpoints;
- **dart_mcp** (`dart-lang/ai`, BSD-3-Clause), as an MCP client against the governed MCP endpoint;
- the **official OpenAI and Anthropic SDKs**, pointed at our base URL.

## Decision

1. **One harness, three client images.** `apps/gateway/client-compat/harness.test.ts` (its own vitest config, outside
   the gateway suite) boots a real gateway against Postgres with the `mock` model provider and an in-process upstream
   MCP server, seeds a project, a priced mock agent and one allow/deny user pair per lane, and runs each client image.
   The images live in a top-level `client-compat/` directory, outside `apps/`: every product and engine Dockerfile
   copies `apps/` whole, and a test client's `package.json` there would enter those build contexts (the ENG-IMG publish
   gate refuses it). Their manifest/lock pairs (`composer.json`/`composer.lock`, `pubspec.yaml`/`pubspec.lock`) join
   `go.mod`/`go.sum` as toolchain-mandated pairs the basename-collision guard admits:

   | Image | Client (pinned) | Surface |
   |---|---|---|
   | `node-sdks` | `openai` 7.43.0, `@anthropic-ai/sdk` 1.3.0 (Apache-2.0) | `/v1/chat/completions`, `/v1/messages` |
   | `laravel-ai` | `laravel/ai` v1.3.0 (MIT), booted in `orchestra/testbench` v10.12.0 (MIT) | `openai-compatible` and `anthropic` drivers |
   | `dart-mcp` | `dart_mcp` 0.5.2 (BSD-3-Clause) | `POST /mcp/:serverId` |

2. **The same seven checks for every client.** From the client's side: **auth** (a bad key is a clean 401 in the
   client's own error type), **governed allow**, **governed deny** (a clean, client-readable 403 or MCP error naming
   the denial), **streaming** and **tool calls**. From the gateway's side, in the harness: the allowed calls are
   **cost-attributed** (usage rows priced above zero and carrying the project), and the allow and the deny are both
   **audited**.
3. **Strict defaults, named exceptions.** Project attribution stays mandatory (every client sends
   `x-regulait-project-id`, as a deployment requires). The harness relaxes only: `mrmEnforced` and
   `dispatchAttributionRequired` (model-risk paperwork for the mock agent, relaxed by every compat suite); strict
   admission of the fixture upstream; and the org's default PII mode, `block` to `warn`, because on a block-mode
   project the gateway correctly refuses `stream: true` (ADR-0019/0021), which would leave nothing to stream.
4. **Pinned and offline at test time.** Each image is pinned by its base image's multi-arch index digest and by the
   client's lockfile (`package-lock.json`, `composer.lock`, `pubspec.lock`); dependencies are fetched only at image
   build (the Dart client is compiled to a native executable on a `scratch` runtime). At test time the clients run on
   an `--internal` docker network whose only reachable address is the gateway, bound to that network's gateway IP,
   with a read-only root filesystem. No real provider key exists anywhere in the job.
5. **Cheap.** A separate workflow, `.github/workflows/client-compat.yml`: on pull requests that touch the compat or
   MCP surfaces (or the harness), nightly at 03:37 UTC, and on demand. Never on every PR.
6. **Test-only dependencies.** None of these packages ships. They are listed in
   `client-compat/THIRD_PARTY.md` for the ADR-0176 record; every one is MIT, BSD, Apache-2.0 or
   Unlicense.

## Findings

### Fixed here (trivial)

- **The SSE shims forced `Connection: keep-alive`.** `/v1/messages` and `/v1/chat/completions` wrote
  `connection: keep-alive` on every stream, overriding the client's `Connection: close`. A client that reads an SSE
  body to EOF then waits for a close that never comes: laravel/ai's Anthropic driver (Guzzle's PHP stream handler)
  hung until its 60 s timeout. The header is removed; Node keeps the socket alive unless the client asks otherwise.
  Verified both ways: with the old line the `laravel.anthropic.stream` check fails, without it the check passes, and
  the five existing compat suites stay green (184/184).

### Recorded, not fixed here

- **laravel/ai's native `openai` driver speaks the OpenAI Responses API (`POST /v1/responses`).** The gateway exposes
  Chat Completions only, so a Laravel app using the default `openai` driver cannot point at RegulAIt; it must use the
  `openai-compatible` driver (which the tests cover). xAI's driver uses the same API. Adding a governed
  `/v1/responses` shim is a real feature on the ADR-0020 core, not a trivial fix, and is left as a follow-up.
- **A 401 on a compat route is not provider-shaped.** The shared auth hook answers every route with
  `{"error": "unauthenticated"}` (or another RegulAIt code) before the compat shim runs, so an OpenAI- or
  Anthropic-shaped client gets the right status and its typed authentication error, but no `error.message`. The 403
  deny path is provider-shaped already. Reshaping the hook's refusals per route touches the authentication path for
  every surface, so it is a follow-up, not a trivial fix; the auth checks assert the 401 and the client's error type.
- **dart_mcp 0.5.2 ships a stdio transport only.** Its `MCPClient.connectServer` accepts any
  `StreamChannel<String>`, so the test supplies the smallest Streamable HTTP channel (one POST per message, JSON or SSE
  back, the session header kept). A Dart app would need the same few lines, or a stdio bridge, to reach a remote MCP
  endpoint; nothing on the gateway side is missing.

## Consequences

- A change to the compat surfaces, the auth hook or the MCP proxy that breaks an off-the-shelf client fails a PR, not
  a customer install.
- Updating a client is a lockfile change plus a digest change, reviewed like any other dependency bump.
- The harness proves compatibility with the versions pinned; a newer client release can still break before we pin it.
  The nightly run does not float versions on purpose: an unpinned nightly would make the job non-reproducible.
- Adding a client is one image directory plus one `describe` block; adding a surface (for example `/v1/responses`)
  extends the matrix.
