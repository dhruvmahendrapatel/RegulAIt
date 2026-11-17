# ADR-0353: Governed MCP tools generated from a customer's OpenAPI or REST API, and a pluggable routing classifier

- **Status**: Accepted (lane E34 brief, 2026-11-17: the confirmed direction; owner questions are listed at the end)
- **Date**: 2026-11-17
- **Index**: **Governed MCP tools from a customer's OpenAPI 3.x document or REST endpoint list (staged and default-deny until an admin approves each tool; drift on re-import needs re-approval; a declared transition table; served through the MCP proxy as an in-process `openapi` upstream; every call through the guarded fetch with server-held credentials) and a pluggable routing classifier behind the ADR-0088 scorer contract (off by default, recorded in the audit)** (lane E34)
- **Driver**: `internal/product/GAP_ANALYSIS_KRAKEND_2026-11.md` (on PR #935 until it merges) rows 4 and 14, ranked gaps 4 and 5
- **Built in**: lane E34, two PRs (1: this ADR and the routing classifier; 2: the OpenAPI tool sources and the part 3 conformance record)
- **Migration**: `pending/routing_classifier.sql` (PR 1), `pending/openapi_tool_sources.sql` (PR 2), numbered at merge (ADR-0252)
- **Related**: [ADR-0043](0043-mcp-oidc-egress-guard.md) (egress on MCP upstreams),
  [ADR-0088](0088-external-scorer-adapter.md) (external scorer contract), [ADR-0097](0097-mcp-admission-scanning-and-auth-discovery.md)
  (admission scanning), [ADR-0176](0176-open-source-first.md), [ADR-0180](0180-continuous-assurance-strict-by-default.md),
  [ADR-0185](0185-batch3-retention-metrics-mcp-ownership.md) G4 (upstream transports), [ADR-0204](0204-mcp-upstream-static-credential.md)
  (server-held upstream credential), [ADR-0246](0246-mcp-definition-pinning-and-vuln-fixtures.md) (definition pinning),
  [ADR-0251](0251-one-governed-decision-core.md) (one governed decision core), [ADR-0255](0255-governed-connector-catalogue.md)

## Context

KrakenD's Enterprise "MCP Server" turns REST backends into MCP tools, and its AI Router can call a prompt classifier
(Not Diamond) to pick a model. The gap analysis ranks both as gaps for us (§3 ranks 4 and 5): we govern MCP servers
and connectors, but a customer with an internal REST API has to write and host an MCP server before an agent can use
it, and our model router (`routeModel`, pillar 6 §8) only takes a fixed complexity heuristic.

The owner approved both on 2026-11-17 from the competitor reviews. Vendor features are ideas only: we never embed a
competitor's proxy, and the ADR-0251 core stays the single decision point.

### Open source first (ADR-0176, and the 2026-11-17 owner rule to compare at least two approaches)

**OpenAPI to MCP converters** (npm metadata read 2026-11-17):

| Package | Licence | Latest | Shape | Verdict |
|---|---|---|---|---|
| `mcp-from-openapi` (agentfront) | Apache-2.0 | 2.9.3 (2026-11-12); 2.9.1 (2026-10-20) | library: `OpenAPIToolGenerator.fromJSON` → `generateTools()` (name, description, annotations, inputSchema, outputSchema, a parameter `mapper`), and a **pure** `buildHttpRequest(tool, input, {baseUrl})` that sends nothing | **Used**, 2.9.1 (2.9.2 and 2.9.3 are under the 7-day release age) |
| `openapi-mcp-generator` (harsha-iiiv) | MIT | 5.0.1 (2026-10-24) | CLI that writes a server project | No: a code generator, and the output would be a second server |
| `@ivotoby/openapi-mcp-server` | MIT | 1.18.0 (2026-11-11) | a runtime proxy that makes its own HTTP calls (axios) | No: a third-party proxy, outside our egress guard |
| `mcp-openapi`, `openapi-mcp`, `openapi-mcp-server` | MIT | 2025 to 2026-03 | servers | No: servers, stale or low use |
| `@samchon/openapi` | MIT | 6.0.1 (2026-01) | OpenAPI to LLM function schemas | Possible, but no request builder and its own model |
| `@apidevtools/swagger-parser` | MIT | 13.1.0 (2026-09-20) | parser and validator | Not needed: `mcp-from-openapi` dereferences with the same `json-schema-ref-parser` and validates |
| `@scalar/openapi-parser` | MIT | 0.29.23 | parser | Not needed; pre-1.0, about 8 MB of dependencies |

FastMCP's `from_openapi` is Python only; Stainless and Speakeasy generate hosted servers.

`mcp-from-openapi` is loaded only with `secureDefaults: true` and from an already parsed object (`fromJSON`), so it
never fetches: no spec URL, no redirect, and external `$ref` resolution is off (`refResolution.allowedProtocols: []`).
Security schemes stay out of the input schema (`includeSecurityInInput` is false, the default), so a model never sees
or supplies a credential. Its transitive `@apidevtools/json-schema-ref-parser` is pinned by a root override to 16.0.5,
the newest release past the 7-day release age. That parser's `js-yaml` 5 declares `argparse` 3 (PSF-2.0, not on the
admitted list) for its command-line tool only, which is never loaded; a root override pins it to the already-admitted
`argparse` 2.0.1 (Python-2.0), so no new licence enters the closure (`apps/gateway/THIRD_PARTY.md`).

**Pluggable routing classifier.** KrakenD calls Not Diamond, a hosted service; the gap analysis (§5) rejects a hosted
classifier on every prompt. No open-source package plugs a classifier into our own router: the router is ours
(`@regulait/optimizer-kernel`), and the contract to an outside instrument already exists (ADR-0088). This is
governance on our own data (ADR-0176 rule 4).

## Decision

### Part 1: governed MCP tools from OpenAPI or a list of REST endpoints

**1. An import creates an `openapi` upstream.** An admin posts an OpenAPI 3.0 or 3.1 document (JSON or YAML text, at
most 2 MiB) or a list of REST endpoints (`method`, `path`, `description`, optional `inputSchema`, at most 200), plus the
API's base URL. A REST list is turned into a minimal OpenAPI 3.1 document first, so both inputs go through one
generator. The import creates:

- one `mcp_servers` row with the new transport `openapi` and the URL `openapi:<name>` (the `stdio:<name>` pattern), so
  every MCP control applies unchanged: admission (ADR-0097), definition pinning (ADR-0246), per-user tool grants,
  approval rules, rate limits, the project budget gate, consent and audit (ADR-0251);
- one `openapi_tool_sources` row (the base URL, the spec digest, title and version, the import time and admin);
- one `openapi_tool_operations` row per generated tool, in state `staged`.

The base URL is the admin's, never the document's `servers` entry, and it is checked by the egress guard when it is
saved. A generic `POST /v1/servers` with `transport: "openapi"` is refused: only the import route makes these rows.

**2. Default-deny at three layers.**
- The org's upstream transport list (ADR-0185 G4) does not include `openapi` by default, so nothing is served until an
  admin enables the transport (a strictness relaxation, audited).
- An operation is served only in state `approved`. A staged, drifted, rejected or withdrawn operation is not in the
  manifest, and a `tools/call` on it is refused before any request leaves.
- Approving an operation grants nobody anything: users still need a tool grant (pillar 1), as for any MCP server.

**3. The lifecycle is one declared machine** (`OPENAPI_OPERATION_MACHINE` in `@regulait/shared`, built with the
ADR-0348 `defineMachine` and listed in its `STATE_MACHINES`). Every write's UPDATE carries the machine's `whereFrom`
guard, and each operation is returned with its `describe()` (every event, whether it is allowed now and why not), so
the server, the UI and agents read the same table. Each event lands in one state:

| Event | From | To |
|---|---|---|
| (import) | (none) | `staged` |
| approve (admin, stepped up, by digest) | `staged`, `drifted` | `approved` |
| reject (admin) | `staged`, `drifted` | `rejected` |
| revoke (admin) | `approved` | `withdrawn` |
| reimport_changed (definition changed) | `approved`, `drifted` | `drifted` |
| reimport_restaged (definition changed) | `staged`, `rejected` | `staged` |
| reimport_reverted (back to exactly the approved definition) | `drifted` | `approved` |
| reimport_missing (operation gone) | `staged`, `approved`, `drifted`, `rejected` | `withdrawn` |
| reimport_present (operation back) | `withdrawn` | `staged` |

A re-import whose definition digest is unchanged changes nothing. `drifted` is **not served**: the API changed, so
neither the old nor the new definition is offered until an admin approves the new one (secure default; owner question
1). Every transition is one audit row (`openapi-operation-<event>`) written in the same transaction as the change.

**4. What is pinned and approved.** The definition digest is SHA-256 over the RFC 8785 canonical form of the tool as
served (name, title, description, inputSchema, annotations; no outputSchema, because an MCP client then demands
structured content matching it and a real API drifts from its document) and its request template (method, path and
the parameter mapper), with the shared `canonicalize`. The operation row keeps both the imported definition and the
approved one (point-in-time evidence, the commented ADR-0200 exception, like ADR-0246). Approve is a compare-and-set on
the digest the admin reviewed (409 `openapi_operation_stale` if a re-import moved it), so an admin never approves a
definition they did not see. When an admin approves a definition at this layer, the same transaction approves the
ADR-0246 pin for that tool at that digest, so one review is enough and the rug-pull detector stays armed for anything
that did not come through this route.

**5. Serving.** For an `openapi` row `guardedMcpConnect` does not open a socket: it connects the MCP client to an
in-process MCP `Server` over the SDK's `InMemoryTransport`. That server lists the approved operations and runs a
`tools/call` by:
1. validating the arguments against the approved input schema (Ajv, the gateway's existing validator);
2. building the request with `buildHttpRequest` against the admin's base URL (the path stays inside the base URL's
   origin, and the built URL is refused if it does not);
3. adding the server-held credential (ADR-0204: the existing encrypted `mcp_servers` credential, opened per connect,
   never returned on read, never in the manifest);
4. sending it through `createGuardedFetch` with the org's egress allow-list (DNS-pinned, redirects refused, private
   ranges by the row's flag);
5. returning at most 1 MiB of the response as MCP text content (`isError` on a non-2xx status).

Because the client is a normal MCP client, the manifest still passes `syncUpstreamTools`: admission scanning and
definition pinning run on exactly what a model will see, and the governed call path is the one every server uses.

**6. Admin API (admin-only by the global gate; UI is built separately, tracked on #453).**

| Route | Purpose |
|---|---|
| `POST /v1/openapi-tool-sources` | import (creates the server, the source and staged operations) |
| `GET /v1/openapi-tool-sources` | list, paginated |
| `GET /v1/openapi-tool-sources/:sourceId` | one source and its operations, each with its state and allowed events |
| `POST /v1/openapi-tool-sources/:sourceId/reimport` | re-import; returns the per-operation transitions |
| `POST /v1/openapi-tool-sources/:sourceId/operations/:operationId/:event` | `approve` (with `definitionDigest`), `reject`, `revoke` |

### Part 2: a pluggable routing classifier

- **Off by default.** A new org setting `routing_classifier_scorer_id` (a foreign key to `external_scorers`, null by
  default) names one registered ADR-0088 scorer that claims the new kind `routing_complexity`. Null means the built-in
  heuristic `classifyComplexity`, as today.
- **The contract is ADR-0088's, unchanged:** `{input, output: "", context: [], scorerKind: "routing_complexity"}` →
  `{score in [0,1]}`, with its strict reply parser, its egress guard, register → test → enable, and the air-gapped
  refusal of a vendor adapter. Only the `regulait` adapter may serve this kind (no third-party vendor dialect).
- **It only chooses a complexity.** Score below 1/3 is `low`, below 2/3 `medium`, otherwise `high`. `routeModel` still
  decides among entitlement-filtered candidates, never above the tier ceiling and never above the requested model's
  tier. A classifier cannot widen a grant or raise a cost ceiling.
- **Fail safe, not fail open:** a disabled or unreachable scorer, a timeout (a 1.5 s bound on this hop), or a
  non-conforming reply falls back to the heuristic, and the reason is recorded.
- **Recorded in the audit.** Every routed dispatch that used a configured classifier writes one `routing-classified`
  audit row: the scorer, the score, the complexity, the source (`external` or `heuristic-fallback`), the fallback
  reason, and the routing decision (requested, selected, rule). The `model_routing` cost ledger detail carries the same
  classifier fields.
- **Where it applies:** the governed invoke path and the OpenAI/Anthropic compat edges, and only when routing will run
  (the org toggle on and the caller's mode `automatic`), so no prompt is sent to a scorer for a passthrough call. The
  orchestration budget re-plan classifies task titles, not prompts, and keeps the heuristic.
- Setting the classifier requires the scorer to exist, be enabled, speak the `regulait` contract and claim
  `routing_complexity`, through `PUT /v1/org/settings` (admin, audited). Naming a scorer is a strictness relaxation
  (it sends prompt text out), so it needs a `settings_relax` step-up; clearing it does not.

### Part 3: MCP 2026-07-28 conformance check (owner addition, 2026-11-17, MARKET_ANALYSIS_2026-11 G10)

**Result.** MCP revision 2026-07-28 is published and is the current version ([versioning](https://modelcontextprotocol.io/specification/versioning),
[changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)). It removes sessions, the `initialize`
handshake, the GET stream and resumability; carries the protocol version and capabilities in every request's `_meta`;
adds `server/discover`; moves sampling, elicitation and roots into `tools/call` results (`inputRequests`); and replaces
`resources/subscribe` with `subscriptions/listen`. The gateway, on SDK `@modelcontextprotocol/sdk` 1.32.2 (the newest
1.x; its `LATEST_PROTOCOL_VERSION` is 2025-11-25), is a conformant 2025-11-25 server and client, which the spec allows
as a legacy peer. It does not speak 2026-07-28 on either side.

| Change | Status | Evidence |
|---|---|---|
| No sessions; ignore an incoming `Mcp-Session-Id`, never mint one | Conformant | stateless transport per POST, `mcp-proxy.ts` (`sessionIdGenerator: undefined`) |
| GET answers 405 | Conformant | `mcp-proxy.ts` `app.get("/mcp/:serverId")` |
| No resumability (`Last-Event-ID`) | Conformant | no event store is passed to the transport |
| DELETE answers 405 (SHOULD) | Gap: 404 | no DELETE route |
| No `initialize`; per-request `_meta` version; `UnsupportedProtocolVersion` (-32022) | Gap | the SDK 1.x server answers a 2026-07-28 header with 400 / -32000; a dual-era client falls back to `initialize` and works, a 2026-07-28-only client fails |
| `server/discover` MUST | Gap (modern era) | not handled |
| Gateway as a client of a 2026-07-28-only upstream | Gap | the SDK 1.x `Client` always runs `initialize` (`mcp-egress.ts` `guardedMcpConnect`); the upstream refuses, and the call fails as an audited 502 |
| `inputRequests` in results, `subscriptions/listen` | Not reachable today | our refusals of sampling, elicitation and subscribe match on method names (`mcp-protocol.ts`); in the new era these arrive inside `tools/call` results |
| Auth (`iss` check, DCR changes) | n/a | the gateway runs no upstream OAuth client flow; RFC 9728 metadata unchanged |

**Triage (owner rule, F×S).**
- DELETE 404 instead of 405: F 2, S 1, F×S 2, filed as #997 (`triage-low`), code left alone.
- A 2026-07-28-only client cannot use the gateway: F 3, S 5, F×S 15.
- A 2026-07-28-only upstream is unreachable: F 3, S 5, F×S 15.
- Speaking the new era without new governance would let upstream sampling and elicitation arrive as `inputRequests`
  inside `tools/call` results, past the method-name refusals: F 2, S 8, F×S 16 (latent: unreachable until the gateway
  speaks the new era).

**Why the three scored ≥ 5 are not fixed in this lane.** None can be fixed on SDK 1.x: speaking 2026-07-28 needs the
v2 packages `@modelcontextprotocol/server` and `@modelcontextprotocol/client` (2.4.0, released 2026-10-23, Apache-2.0),
which answer and detect both eras. Moving the MCP proxy, the protocol relay, the transports and the egress connect onto
a new major SDK changes the shared MCP request path that several lanes edit, so it is its own lane (PENDING fragment),
not part of the OpenAPI slice. The binding conditions for that lane, recorded here so the migration cannot drop them:
1. keep serving 2025-11-25 clients and upstreams (dual-era), with the stateless, POST-only transport;
2. refuse, filter and audit `inputRequests` (sampling, elicitation, roots) in upstream results exactly as the current
   method refusals do, and refuse `subscriptions/listen` like `resources/subscribe`, before the new era is enabled;
3. answer `server/discover` with only the capabilities the caller is entitled to, and keep policy decisions on the
   body, not the routing headers (`Mcp-Method`, `Mcp-Name`), rejecting a header/body mismatch (-32020);
4. the new era stays off until an admin enables it (ADR-0180), and DELETE gets its 405 (#997).

## Consequences

- A customer's internal REST API becomes governed MCP tools without writing or hosting an MCP server, with nothing
  served before an admin approves it and a user is granted it.
- The import path never fetches anything: the document is sent in the request body. Fetching a spec from a URL is a
  follow-up (through the guarded fetch).
- OAuth flows for the target API are not supported in this slice: the credential is the static ADR-0204 header. The
  ADR-0238 token exchange is the follow-up for per-user credentials.
- Multipart and binary request bodies are refused at import (the operation is skipped with a reason).
- The routing classifier sends the prompt text to the scorer the admin registered. That is the admin's decision, made
  by registering the scorer behind the egress allow-list; an air-gapped deployment can only reach a local one.

## Owner questions (open; built with the secure default)

1. A drifted operation is withheld until re-approved. The alternative is to keep serving the last-approved definition
   while the new one waits.
2. The `openapi` transport is off until an admin enables it, like SSE and stdio.
