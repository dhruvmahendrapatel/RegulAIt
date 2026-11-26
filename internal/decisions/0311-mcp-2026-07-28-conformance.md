# ADR-0311: MCP 2026-07-28 conformance check, the transport fixes it found, and the staged move to the stateless protocol

- **Status**: Accepted for the check and the fixes (lane E1 brief, gap G10 of `internal/product/MARKET_ANALYSIS_2026-11.md` §3). Decision 4 (the staged move to the stateless protocol) is **Accepted** (owner, 2026-11-21); slice 1, the 2026-07-28 server side for `tools/*`, and slice 2, its governed resources, prompts and completions, are built.
- **Date**: 2026-11-19
- **Index**: **MCP 2026-07-28 conformance (G10).** The 2026-07-28 revision is a breaking, stateless protocol, not a hardening pass, so the gateway does not conform yet. This ADR records the gap matrix for the server and client sides and fixes now the transport MUSTs that hold in every revision the gateway serves: browser `Origin` validation, no JSON-RPC batches from 2025-06-18 on, and DELETE answered 405. It proposes a staged move to SDK v2 that serves both protocol generations.
- **Built in**: lane E1 (slice 3).
- **Related**: ADR-0185 (G3 protocol surface, G4 transports), ADR-0097 (RFC 9728 protected resource metadata), ADR-0188 (workload identity, RFC 8707 audience), ADR-0204, ADR-0210, ADR-0238 (upstream credentials), ADR-0176, ADR-0180

## Context

The market analysis listed G10 as "likely mostly done; needs a check, not a build". The check was made on 2026-11-19
against primary sources:
- the specification's versioning page and the 2026-07-28 changelog, transports and authorization pages
  (modelcontextprotocol.io/specification/2026-07-28/…);
- `schema/2026-07-28/schema.ts`;
- the npm registry for the SDKs.

It found the following:

- **2026-07-28 is the "Current" revision**, and 2025-11-25 is the one before it. Per the versioning page, "Current"
  means ready for use, though backwards-compatible changes may still be made.
- **It is a different protocol.**
  - There are no sessions: `Mcp-Session-Id` is removed.
  - There is no `initialize` handshake. Every request carries its protocol version and client capabilities in
    `_meta`, and the server MUST implement `server/discover`.
  - Every POST MUST carry the `Mcp-Method` and `Mcp-Name` headers, and the server MUST answer a header/body mismatch
    with 400 `HeaderMismatchError`.
  - `ping`, `logging/setLevel` and SSE resumability are removed.
  - Server-to-client requests (sampling, elicitation, `roots/list`) become `InputRequiredResult`, which the client
    answers with a retry.
  - Every result carries `resultType`, and list results carry `ttlMs` and `cacheScope`.
  - `subscriptions/listen` replaces the GET stream and `resources/subscribe`.
  - The error codes are renumbered (-32020 to -32022), and resource-not-found becomes -32602.
- **Deprecations, under the new feature-lifecycle policy:**
  - Roots, Sampling, Logging and Dynamic Client Registration are deprecated. The earliest removal is the first
    revision on or after 2027-07-28.
  - The HTTP+SSE transport is reclassified as deprecated.
  - Tasks move to an extension (`io.modelcontextprotocol/tasks`).
  - MCP Apps is the stable extension `io.modelcontextprotocol/ui`.
- **Authorization additions:**
  - An authorization server SHOULD send `iss` in its authorization response (RFC 9207), and a client MUST check it.
  - A client MUST bind its stored credentials to their issuer.
  - DCR clients MUST send `application_type`.
  - Client ID Metadata Documents are preferred over DCR.
  - The rest carries forward unchanged: RFC 9728 metadata, RFC 8707 audience, no token pass-through, and
    `insufficient_scope` step-up as a SHOULD.
- **SDK support.**
  - The gateway runs `@modelcontextprotocol/sdk` 1.32.2 (MIT). No v1 release implements 2026-07-28: its latest
    version is 2025-11-25.
  - The revision is implemented by the v2 split packages `@modelcontextprotocol/server`, `/client` and `/core`, from
    2.0.0. The latest is 2.4.0 (2026-10-23), which is past the two-week rule. Its licence changed from MIT to
    Apache-2.0 at 2.3.0; both are allowed (ADR-0176).

## Decision

1. **The conformance matrix** (S = the gateway serving `/mcp/:serverId`; C = the gateway calling upstreams):

   | Requirement | Since | Side | Gateway today | Action |
   |---|---|---|---|---|
   | Validate `Origin` (DNS rebinding), 403 if invalid | 2025-06-18, kept | S | not checked | **fixed here** (decision 2) |
   | One JSON-RPC message per POST (no batches) | 2025-06-18, kept | S | the SDK accepts arrays | **fixed here** for versions ≥ 2025-06-18 |
   | DELETE without sessions | 2025-03-26 | S | 404 (falls through to admin-only) | **fixed here**: 405 `Allow: POST` |
   | GET without a server stream: 405 | 2025-03-26 | S | done (ADR-0185 G4) | none |
   | Stateless, no `Mcp-Session-Id` | 2026-07-28 | S | already: one transport per POST, no session id | none |
   | `MCP-Protocol-Version` header, unsupported version refused | 2025-06-18 | S/C | done by the SDK (400) | none |
   | RFC 9728 metadata, `WWW-Authenticate resource_metadata`, RFC 8707 audience | 2025-06-18, kept | S | done (ADR-0097, ADR-0188) | none |
   | `insufficient_scope` step-up challenge | SHOULD | S | not sent (403 carries no challenge, by design) | recorded; scopes are not the gateway's authorization model (pillar 1 per-tool entitlements) |
   | No `initialize`; `_meta` protocolVersion/clientCapabilities; `server/discover` | 2026-07-28 | S/C | v1 handshake | **slice 1** (S); the client side is (d) |
   | `Mcp-Method`/`Mcp-Name` headers, `HeaderMismatchError` | 2026-07-28 | S/C | absent | **slice 1** (S, by the SDK's validation ladder); `Mcp-Param-*` deferred; the client side is (d) |
   | `resultType`, `ttlMs`/`cacheScope`, renumbered errors | 2026-07-28 | S | absent | **slice 1** (`ttlMs: 0`, `cacheScope: private`, the SDK defaults) |
   | `InputRequiredResult` instead of server-to-client requests | 2026-07-28 | S/C | sampling, elicitation and roots already refused (ADR-0185 G3) | decision 4; nothing to unwind |
   | Deterministic `tools/list` order | 2026-07-28, SHOULD | S | upstream order, filtered | **slice 1** on the 2026-07-28 path (code-point order by name); the 2025-era path keeps upstream order |
   | `outputSchema` kept for stdio servers with a stored manifest | 2025-06-18 | S | dropped on that path (only `readOnlyHint` rebuilt) | follow-up (PENDING); not a MUST violation, as no `structuredContent` is promised |
   | Authorization `iss` check, issuer-bound credentials | 2026-07-28 | C | the gateway uses no authorization-code flow upstream (static credentials, assertions, RFC 8693 exchange) | none today; applies if an OAuth client flow is ever added |
   | DCR deprecated, CIMD preferred | 2026-07-28 | S (as AS) | the gateway's token endpoint has DCR and CIMD off | none |
   | MCP Apps extension (`io.modelcontextprotocol/ui`) | extension | S | not offered | decision 4 decides governance of `ui://` resources |

2. **The Origin rule** (`apps/gateway/src/mcp-conformance.ts`).
   - The gateway serves no CORS. The only browser origin that may call `/mcp/:serverId` is therefore that of
     `REGULAIT_PUBLIC_URL`.
   - A request without `Origin` does not come from a browser page, so it passes.
   - Any other origin is refused with 403 `mcp_origin_refused`, before the upstream is opened.
   - With no public URL set, every request carrying an `Origin` is refused (ADR-0180).
   - The SDK's `enableDnsRebindingProtection` is not used, for two reasons: it runs only after the gateway has
     connected the upstream for the request, and it lets everything through when its list is empty.
   - Cookie sessions were already protected by `SameSite=Strict` and the `x-regulait-csrf` header, so this closes a
     conformance gap rather than an open hole.
3. **No batches from 2025-06-18 on.**
   - A JSON-RPC array whose `MCP-Protocol-Version` is 2025-06-18 or later is answered with 400 and a JSON-RPC
     -32600 error.
   - A client that sends no header (the 2025-03-26 default), or 2025-03-26, keeps the old behaviour, because that
     revision defined batching. This holds until those versions are dropped (decision 4).
4. **Accepted (owner, 2026-11-21): a staged move to the stateless protocol on SDK v2.** It is a migration, not a check,
   and it touches the proxy's busiest files, so it is built in slices.
   - (a) Pin `@modelcontextprotocol/server` and `/client` 2.4.x beside the v1 SDK.
   - (b) Serve both generations on `/mcp/:serverId`. A request with `_meta` `io.modelcontextprotocol/protocolVersion`
     and the `Mcp-Method` header takes the 2026-07-28 path; an `initialize` request takes the v1 path. The
     governance pipeline (entitlements, approvals, scanning, cost, audit) sits behind both unchanged.
   - (c) Add `server/discover`, `resultType`, `ttlMs`/`cacheScope`, the renumbered errors and deterministic tool
     order on the new path.
   - (d) On the client side, speak 2026-07-28 to upstreams that offer it, and fall back to 2025-11-25.
   - (e) Decide the governance of MCP Apps `ui://` resources, which would be default-deny like every capability.
   - (f) Drop 2024-11-05 and 2024-10-07 once telemetry shows no clients use them.

   The deprecation windows (no removal before 2027-07-28) leave room to do this in slices.

   **Slice 1 (built, 2026-11-21).** (a), (b) and (c) for the server side, `tools/*` only.
   - `@modelcontextprotocol/server` 2.4.0 is pinned exactly beside the v1 SDK (`@modelcontextprotocol/client` 2.4.0 is
     a test-only devDependency). Both are Apache-2.0; `apps/gateway/THIRD_PARTY.md` lists them and what they bundle.
   - `POST /mcp/:serverId` runs every refusal it ran before (Origin, batch, API key, unknown or disabled server,
     project attribution, the stdio entitlement check, admission and egress preflight, the breaker, the manifest
     connect) for both generations. Then the SDK's own classifier (`isLegacyRequest`) picks the path. A 2025-era
     request (`initialize` and everything without the envelope) takes the v1 path unchanged. A 2026-07-28 request is
     served by `createMcpHandler(…, { legacy: 'reject' })` (`apps/gateway/src/mcp-modern.ts`).
   - `tools/list` and `tools/call` on both paths are the same two functions (`listToolsForCaller`,
     `callToolForCaller` in `mcp-proxy.ts`), moved out of the v1 handlers unchanged, so entitlements, approvals,
     scans, cost and audit cannot differ between generations.
   - The SDK answers `server/discover` (no upstream is contacted: the route connects only for `tools/list`), the
     envelope and header ladder (`-32020` header mismatch, `-32022` unsupported revision), `resultType`, and the
     `ttlMs: 0` / `cacheScope: private` defaults. The new path sorts `tools/list` by name.
   - Every other method on the new path answers `-32601` with an `mcp-method-unsupported` audit row
     (`detail.protocolRevision`). `subscriptions/listen`, which the SDK would serve itself, is refused the same way
     before the handler runs.

   **Slice 2 (built, 2026-11-21).** The governed non-tool methods on the server side.
   - `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list`, `prompts/get` and
     `completion/complete` on the new path call `protocolCallForCaller` (`mcp-proxy.ts`), the v1 route's inline
     protocol `call` moved out unchanged. Both paths therefore run the same ADR-0185 G3 primitive
     (`executeGovernedProtocolCall`): the org switch (`mcp-method-disabled`), the kernel decision on the `mcp:*`
     grant, data scopes (`resources/read` is decided on `{uri}`), definition pins, approvals, input and output scans,
     content provenance and audit.
   - The new path advertises `protocolCapabilities(...)` of the org's enabled methods, the same input as the v1 path,
     minus `logging/setLevel`. It never advertises `logging`.
   - Upstream connects are unchanged: the route connects eagerly only for `tools/list`, and the primitive connects
     only after an allow. `server/discover` still opens no upstream, even with every method enabled.
   - Differences from 2025-era behaviour come from the revision and are left to the SDK. The SDK re-codes
     resource-not-found `-32002` to `-32602`. List results carry `resultType` and the `ttlMs: 0` /
     `cacheScope: private` defaults. Only `tools/list` is sorted: the revision's deterministic-order SHOULD names
     `tools/list` alone, so the other lists keep the upstream's order and cursors.
   - Progress for the caller's own request is relayed on that request's response stream (`ctx.mcpReq.notify`; the
     SDK upgrades the answer to SSE). The org rule is the 2025-era one: progress is relayed only while
     `logging/setLevel` is enabled. Upstream `notifications/message` are never relayed on this path, and no
     `protocol-relay` decision is made for them (`relayLogMessages: false`). The revision removed
     `logging/setLevel`, and a server MUST NOT emit log messages for a request without a per-request log level, which
     the gateway does not offer.
   - Refusals keep the existing vocabulary (`mcp-method-unsupported`, `detail.protocolRevision`). The SDK answers
     `-32601` itself, before any handler runs, for a method that is not a client-to-server request of the revision:
     `logging/setLevel`, `ping`, `resources/subscribe`, and the client-bound `sampling/*` among them. That answer now
     gets its audit row after the fact (`detail.answeredBy: "sdk"`). A non-spec name under an always-refused prefix
     reaches the primitive and is refused by name, as on the v1 path. An unknown method stays an audited `-32601`.

   Deferred to later slices: subscriptions; `InputRequiredResult`; per-request log levels
   (`io.modelcontextprotocol/logLevel`, logging being deprecated); `Mcp-Param-*` header validation (the SDK checks
   it only for its high-level `McpServer`); the upstream client side (d); MCP Apps `ui://` governance (e); dropping
   the oldest versions (f).

## Consequences

- The gateway enforces the transport rules every served revision requires, and a refusal never reaches an upstream.
- The gateway does not yet speak 2026-07-28. A client that speaks only 2026-07-28 cannot use it, and this is now
  written down instead of assumed done. (Superseded in part by slices 1 and 2: such a client can discover, list
  and call tools, and use the governed resources, prompts and completions; subscriptions and logging are not
  offered on that path.)
- The `/mcp` route gains `DELETE` (405) in the route classes, the census (protocol plumbing) and OpenAPI. No
  migration, table or UI is added.
