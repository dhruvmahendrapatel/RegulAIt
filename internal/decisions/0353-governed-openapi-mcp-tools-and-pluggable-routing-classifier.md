# ADR-0353: Governed MCP tools generated from a customer's OpenAPI or REST API, and a pluggable routing classifier

- **Status**: Accepted (lane E34 brief, 2026-11-17: the confirmed direction; owner questions are listed at the end)
- **Date**: 2026-11-17
- **Index**: **Governed MCP tools from a customer's OpenAPI 3.x document or REST endpoint list (staged and default-deny until an admin approves each tool; drift on re-import needs re-approval; a declared transition table; served through the MCP proxy as an in-process `openapi` upstream; every call through the guarded fetch with server-held credentials) and a pluggable routing classifier behind the ADR-0088 scorer contract (off by default, recorded in the audit)** (lane E34)
- **Driver**: `internal/product/GAP_ANALYSIS_KRAKEND_2026-11.md` (on PR #935 until it merges) rows 4 and 14, ranked gaps 4 and 5
- **Built in**: lane E34, two PRs (1: this ADR and the routing classifier; 2: the OpenAPI tool sources)
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

**3. The lifecycle is one declared transition table** (`OPENAPI_OPERATION_TRANSITIONS` in `@regulait/shared`), checked
server side on every write, returned with each operation so the UI and agents can show the next allowed actions:

| From | Event | To |
|---|---|---|
| (none) | import | `staged` |
| `staged` | approve | `approved` |
| `staged` | reject | `rejected` |
| `staged` | re-import, definition changed | `staged` (the new definition replaces the staged one) |
| `staged` | re-import, operation gone | `withdrawn` |
| `approved` | re-import, definition changed | `drifted` |
| `approved` | re-import, operation gone | `withdrawn` |
| `approved` | revoke | `withdrawn` |
| `drifted` | approve (the new definition) | `approved` |
| `drifted` | reject | `rejected` |
| `drifted` | re-import, definition changed again | `drifted` (the newest definition waits) |
| `drifted` | re-import, back to the approved definition | `approved` (exactly what an admin approved) |
| `drifted` | re-import, operation gone | `withdrawn` |
| `rejected` | re-import, definition changed | `staged` |
| `withdrawn` | re-import, operation present | `staged` |

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
