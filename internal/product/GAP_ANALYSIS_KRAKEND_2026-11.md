# Gap analysis — KrakenD AI Gateway, 2026-11-17

**Status:** research snapshot, written 2026-11-17 at the owner's request. It adds KrakenD to the competitor list in
[MARKET_ANALYSIS_2026-11.md](MARKET_ANALYSIS_2026-11.md) §1.4, next to
[GAP_ANALYSIS_CAMUNDA_2026-11.md](GAP_ANALYSIS_CAMUNDA_2026-11.md) and
[GAP_ANALYSIS_OBSIDIAN_2026-11.md](GAP_ANALYSIS_OBSIDIAN_2026-11.md).

**Sources and honesty rules.** Primary, read 2026-11-17: `krakend.io/contact-ai-gateway/`, `/ai-gateway/`, `/features/`
(Open Source vs Enterprise), `/enterprise/`, the Enterprise docs under `/docs/enterprise/ai-gateway/` (overview,
governance, budget-control, security, ai-router, semantic-cache, prompt-guard, mcp-server, mcp-gateway), the blog posts
"KrakenD 3.0 Is Here" (2026-09-30) and "Dropping plugin support in KrakenD Open Source and Lura" (2026-06-04), and GitHub
(`github.com/krakend` org listing, `krakend/krakend-ce` incl. `LICENSE` and `go.mod`, `luraproject/lura` incl. `LICENSE`,
`krakend/mcp-server`, `krakend/krakend-ratelimit`). Customer logos, "SOC2 & GDPR ready", "no data leaves your infra",
"FIPS compliance" and the LiteLLM/OpenRouter/Vercel comparisons in the vendor FAQ are **the vendor's own claims** and were
not verified. No pricing is published; the FAQ claims "no usage-based or per-token fees". "RegulAIt status" is checked
against `origin/main` (bb3def28) and open PR titles; in-flight work is cited as "#NNN in flight".

## 1. What KrakenD sells

KrakenD is a stateless, declarative, high-throughput **API gateway written in Go**, configured by one JSON file
(`"version": 4` since 3.0). The **AI Gateway** is a licensed module of the closed **Enterprise Edition (EE)** binary, not a
separate product: a unified LLM interface (OpenAI, Anthropic, Gemini, Mistral, AWS Bedrock, Alibaba Qwen; OpenAI- and
Anthropic-format responses so e.g. Claude Code can be served by Bedrock), an **LLM provider inventory**, an **AI Router**
(CEL/header/JWT-claim "gates" plus the Not Diamond prompt classifier, with a failover provider), a **Semantic Cache**
(local ONNX embedder + Redis vectors, cosine `max_distance` 0.25, TTL 600 s, optional `key_variants` to partition by user
or tenant), **Prompt Guard** (regex, CEL policy and external-classifier guards with severities and a fail-open/closed
switch), response guardrails and regex data masking, a persistent **token quota** (`governance/quota`, tiers keyed on a
header/JWT value, weight read from the response body), LLM streaming with per-message manipulation, OpenTelemetry LLM
metrics and a Grafana token dashboard (EE 2.13), and a native **MCP Server** that turns REST backends into MCP tools with
OAuth 2.1 resource-server auth and tool filtering by "audience" read from a header or path parameter. Roadmap (vendor
claim): embedder-based router, TOON payload compression, full MCP protocol coverage, an event system, external secrets.

**Edition split (from `/features/` and the docs).** Every AI feature above is marked **Enterprise only**. The Community
Edition (CE) lists only the **MCP Gateway** (a `no-op` pass-through to a third-party MCP server with the ordinary gateway
auth and throttling), plus cache, OpenTelemetry and the config audit command; note the MCP Gateway doc page itself says
"Only applies to KrakenD Enterprise", so the two vendor pages disagree. `krakend-ce`'s `go.mod` (v3.0.4) pulls no AI
module, which matches. In 3.0, **Go plugin support was removed from CE and from Lura** and kept in EE.

**Licence and activity (GitHub).** `krakend/krakend-ce`: Apache-2.0, Go, v3.0.4 released 2026-11-12, about 2.7k stars.
`luraproject/lura` (the core framework, a Linux Foundation project): Apache-2.0, v3.0.1 released 2026-10-29. The
component repos (`krakend-ratelimit` v4, `krakend-httpcache` v3, `krakend-cel` v3, `krakend-jose`, `krakend-otel`,
`krakend-audit`, ...) are Apache-2.0 and were updated between 2026-09-30 and 2026-11-16. The org's only AI-labelled
repos are `krakend/mcp-server` (Apache-2.0, v0.8.2 of 2026-11-13, 8 releases), which is an MCP server that helps people
**write and validate KrakenD configuration**, not a runtime gateway, and `krakend/claude-code-plugin` (Apache-2.0, skills
for the same job). The AI Gateway's runtime code is not public.

**Where it overlaps us:** pillar 1 (the gateway in front of model and MCP calls), pillar 5 (token quotas) and pillar 6
(routing and caching). It is an API-gateway incumbent adding AI traffic controls; it has no workflow, shared projects,
orchestration, PM-tool or compliance-evidence story.

## 2. Capability-by-capability parity

| # | Capability (KrakenD edition) | RegulAIt status | Evidence | Gap |
|---|---|---|---|---|
| 1 | One endpoint for many LLMs; OpenAI/Anthropic format in, any provider out (EE) | **Partial** | ADR-0034, ADR-0066, ADR-0287, ADR-0257; `packages/model-provider` | OpenAI, Anthropic and Responses compat edges route to native Anthropic, OpenAI, Google and xAI adapters plus admin-registered OpenAI/Anthropic-wire endpoints. **No native Bedrock (SigV4), Vertex, Mistral, Cohere or Qwen adapter.** |
| 2 | Provider inventory defined once, referenced everywhere (EE) | **Have** | ADR-0034, ADR-0066 | Agents and custom providers are registry rows with encrypted credentials and per-user grants, not repeated config. |
| 3 | Rule-based routing by header / JWT claim / CEL (EE) | **Have (stronger)** | ADR-0014, ADR-0040, ADR-0239, ADR-0251 | Entitlement, Cedar ABAC and tier ceilings decide which agent a *user* may reach; routing never widens a grant. Routes are not keyed on caller-supplied headers (ADR-0167). |
| 4 | Prompt-content classifier routing (Not Diamond) (EE) | **Partial** | pillar 6, `optimizer-kernel` `routeModel`/`classifyComplexity` | Deterministic complexity heuristic under the tier ceiling. No pluggable learned classifier. |
| 5 | Failover provider; fallback proxy strategy (EE) | **Have** | ADR-0066, ADR-0126, ADR-0128; Agents → Fallbacks card | Fallback chains that never retry a governance denial; deadlines, circuit breaker and a retry policy. |
| 6 | Semantic cache by meaning (embeddings, cosine distance) (EE) | **Gap** | ADR-0119, ADR-0136, ADR-0138, ADR-0146 | Our "semantic cache" is exact canonical identity after normalisation, bound to project, options and serving config, and hits re-run live gates. A paraphrase misses. |
| 7 | Prompt Guard: regex, CEL, external classifier, severities, fail-closed switch (EE) | **Have (ahead)** | ADR-0042, ADR-0088, ADR-0220, ADR-0237, ADR-0244, ADR-0247 | Layered guardrails in the one decision core; bundled ONNX injection/harm classifiers with pinned baselines; vendor adapters; strict-by-default (ADR-0181). |
| 8 | Response guardrails, regex masking (EE) | **Partial** | ADR-0140, ADR-0141, ADR-0143, ADR-0145; ADR-0137 (Proposed) | Validated redaction on MCP and connector paths; output block/warn; in-flight model-output redaction is still gated (ADR-0137). |
| 9 | Streaming manipulated message by message, policies still applied (EE) | **Partial** | `compat-openai.ts`, `compat-anthropic.ts`; ADR-0137 | Compat edges stream SSE deltas. Under a redaction policy ADR-0137 buffers the whole result; no incremental scan with a hold-back window. |
| 10 | Token quotas per user / tier, weight from response body (EE) | **Have (ahead)** | ADR-0016, ADR-0103, ADR-0125, ADR-0212, ADR-0241 | Per-user/project budgets enforced pre-dispatch across replicas, modality pricing, configurable usage extractor, tighten-only delegation budgets. |
| 11 | Rate limits per tenant/team/project, burst, Redis-backed cluster-wide (stateful limiter EE) | **Have** | ADR-0125, ADR-0212, ADR-0239, #818 in flight | Shared Postgres counters (no Redis), per-model limits, Cedar-expressed limits; admin routes in flight. |
| 12 | Token metrics via OpenTelemetry; Grafana dashboard; "no reporting API yet" (EE) | **Have (ahead)** | ADR-0069, ADR-0070, ADR-0301, ADR-0303; pillar 5 dashboard | Native cost dashboard, forecasts and anomaly alerts (ADR-0049), OTLP push and SIEM delivery. |
| 13 | MCP Gateway: proxy a third-party MCP server with auth and throttling (CE per `/features/`) | **Have (ahead)** | ADR-0019, ADR-0097, ADR-0100, ADR-0166, ADR-0236, ADR-0246 | Per-user tool allow-lists, admission scanning, definition pinning, consent bound to arguments and target. |
| 14 | MCP Server: compose REST backends into MCP tools, declaratively (EE) | **Gap** | nearest ADR-0230, ADR-0255, ADR-0251 | We govern MCP servers and connectors; we do not generate governed MCP tools from a customer's REST/OpenAPI APIs. |
| 15 | MCP OAuth 2.1 resource server + protected-resource metadata (EE) | **Have** | ADR-0097 part B (`mcp-auth-metadata.ts`), ADR-0210, ADR-0238 (Proposed) | RFC 9728 metadata on the MCP proxy, OIDC assertion profile; down-scoped upstream tokens proposed. |
| 16 | Tool filtering by audience header to save context (EE) | **Have (stronger)** | ADR-0019, ADR-0236; pillar 6 `selectTools` (lazy tool-loading) | Visible tools come from the caller's server-side grants, and lazy tool-loading trims context. |
| 17 | Declarative, GitOps-native config file with JSON Schema and `audit` command (CE + EE) | **Partial** | ADR-0048, ADR-0073, ADR-0304 (Helm/operator), ADR-0341 | Policies, templates and prompts are versioned in the database with canary and rollback; no declarative export/plan/apply of governance config from git. |
| 18 | Stateless compiled binary; benchmarks; horizontal scale (CE + EE) | **Partial** | ADR-0343 (merged, lane E24), ADR-0125, ADR-0304 | Multi-replica control plane with leader election is new; no published latency benchmark. |
| 19 | Self-hosted; air-gapped (e-government page); FIPS; SOC 2 "ready" (EE, vendor claims) | **Have / Gap (owner-deferred)** | ADR-0015, ADR-0041, ADR-0062; `ENTERPRISE_READINESS_PLAN.md` | Hosted, BYOC and code-enforced air-gapped modes. No FIPS build and no SOC 2; certifications are owner-deferred. |
| 20 | Per-user audit trail of LLM access (EE claim, "full audit trail included") | **Have (ahead)** | ADR-0060, ADR-0099, ADR-0116, ADR-0189 | Hash-chained, signed, offline-verifiable audit with credential scrub and decision BOMs; the KrakenD docs read describe telemetry and logs, not tamper-evident audit. |

## 3. Gaps, ranked by enterprise-buyer impact

| Rank | Slice | Size | Extends | New or queued |
|---|---|---|---|---|
| 1 | **Native provider breadth:** Bedrock (SigV4 with the customer's IAM), Vertex, Mistral, Cohere and Qwen adapters, so the existing Anthropic/OpenAI compat edges can serve any of them (the "point Claude Code at the gateway, serve from Bedrock" case). Use each vendor's maintained SDK or the AI SDK bridge already in `model-provider` (ADR-0176). | M | ADR-0034, ADR-0066, ADR-0287 | **New** |
| 2 | **Meaning-based cache tier:** an opt-in similarity tier behind the exact cache, with a local ONNX embedder (the ADR-0247 serving path) and pgvector rather than Redis; partitioning by user and project is **mandatory, not an option**; every hit still runs ADR-0138 live gates and current output policy; default off (it trades exactness for savings, so it needs its own ADR next to ADR-0136/0146). | M | pillar 6, ADR-0119, ADR-0138, ADR-0146 | **New** |
| 3 | **Incremental streaming inspection:** scan SSE output in a sliding window and release only scanned text, so a redaction or output-guard policy no longer forces full buffering — keeping ADR-0137's rule that no unscanned token is ever emitted. | M | ADR-0137, ADR-0140, ADR-0042 | **New** |
| 4 | **Governed MCP tools from REST/OpenAPI:** an admin imports an OpenAPI document, picks operations, and they appear as MCP tools that run through the ADR-0251 core with grants, consent and audit. Search for a maintained OpenAPI-to-MCP library first (ADR-0176). | M | ADR-0230, ADR-0236, ADR-0251 | **New** |
| 5 | **Pluggable routing classifier:** let `routeModel` take a scorer through the ADR-0088 external-scorer contract (local or self-hosted only, egress-guarded), still capped by the tier ceiling and entitlement. | S | pillar 6, ADR-0088 | **New** |
| 6 | **Governance config as code:** export and import of policies, rate limits, bundles and templates as schema-validated files with a dry-run diff, applied as ordinary versioned changes (ADR-0048 canary/rollback). | M | ADR-0048, ADR-0073, ADR-0304 | **Partly queued**: template versions and pinning are E21 (#894 in flight); the file export/apply is new |
| 7 | **Throughput evidence:** a published latency/overhead benchmark of the governed path on the HA control plane. | S | ADR-0343 | **Queued** (E24 follow-up) |

No overlap with E17–E20 (discovery, entitlements, vendor agent control, agent ownership/risk), E26–E28 (risk/proof
registry #904, fairness #910, governed memory #905), E29 (state machines), E30 (Temporal ideas) or E31/E32 (DarkControl):
KrakenD's surface is the request path, which those lanes do not touch.

**Recommended to queue:** 1, 2 and 3 as one "gateway parity 2" lane (they are what a KrakenD, LiteLLM or Portkey
evaluator tests first), then 4. Items 5 and 6 can wait; 7 rides E24.

## 4. Reuse under ADR-0176 — verdict: **no, we do not embed KrakenD CE or Lura**

- **Licence and maintenance pass:** CE and Lura are Apache-2.0 with releases in the last month, and so are the component
  repos (`krakend-ratelimit`, `krakend-httpcache`, `krakend-cel`).
- **The AI features are not in the open-source code.** Router, semantic cache, prompt guard, token quota, LLM streaming
  and the MCP Server are Enterprise-only in a closed binary; CE's `go.mod` contains no AI module. Reusing CE gives us a
  generic HTTP proxy, not an AI gateway.
- **The plugin model is gone from open source.** Since 3.0, Go plugins work only in EE; CE extension means forking and
  recompiling the Go source.
- **It would be a second decision point.** Our gateway is TypeScript on Node; KrakenD would run as a separate Go process in
  front of it. ADR-0251 requires one governed decision core for model, connector, MCP and A2A calls, and a proxy that
  rate-limits or caches before that core would decide on its own data, the bypass ADR-0127 warned about ("a proxy is not an admin").
- **The parts we would want are already solved in our stack.** Our rate limits are shared across replicas in Postgres
  (ADR-0125), while the docs mark KrakenD's cluster-wide (Redis) limiter as Enterprise; our caches must bind to user,
  project and serving config (ADR-0146), which `krakend-httpcache` (an HTTP response cache) does not do; our policy language is
  Cedar (ADR-0239), not CEL.
- **What we do take:** design ideas only, with credit in the ADRs that use them: per-guard severity with an explicit
  fail-closed flag, the cache `key_variants` idea (which we would make mandatory), and the router's "no match goes to a
  named failover" rule.
- Customers who already run KrakenD can keep it **in front of** RegulAIt as a plain edge proxy; the ADR-0127
  authorization callout is the integration point. That is a deployment option, not a dependency.

## 5. Not recommended

- **Adopting KrakenD (CE or EE) as our data plane:** see §4.
- **Not Diamond (or any hosted classifier) as a built-in router:** a SaaS call on every prompt breaks air-gapped mode
  (ADR-0062) and sends prompt content to a third party. Gap 5 allows only local or self-hosted scorers.
- **Tool visibility or quota tiers keyed on a request header the caller sets:** KrakenD documents audience and tier
  from headers. Under ADR-0167 a control is keyed on what the caller cannot choose; ours come from server-side grants.
- **TOON payload compression:** still a KrakenD roadmap item; pillar 6 compaction and preprocessing already target the
  same cost, and a wire-format change would break client compatibility (ADR-0257).
- **An optional cache partition:** an unpartitioned semantic cache can serve one user's answer to another. Any
  similarity tier we build partitions by default and has no setting to turn that off (ADR-0180).

## 6. Where RegulAIt is ahead

- **Per-user, default-deny entitlement on every model, connector, MCP and A2A call** (ADR-0014, ADR-0251), with approvals
  bound to exact arguments and policy (ADR-0104, ADR-0105, ADR-0166), kill switch (ADR-0124), SoD (ADR-0091) and access
  certification (ADR-0090). KrakenD governs routes and API keys, not people.
- **MCP security depth:** admission scanning and scheduled re-scan (ADR-0097, ADR-0100), definition pinning against rug
  pulls (ADR-0246), governed bundles (ADR-0236), offline scanners (ADR-0242).
- **Evidence, not logs:** hash-chained signed audit, receipts, RFC 3161 timestamps and decision/AI BOMs (ADR-0116,
  ADR-0186, ADR-0189); compliance packs (ADR-0243, ADR-0319).
- **Cost as a product:** per-call attribution, budgets that tighten at every delegation, forecasts and anomaly alerts,
  cross-vendor reconciliation (pillar 5; ADR-0016, ADR-0049, ADR-0069). KrakenD's docs say there is "no API available to
  generate reporting yet" and point at its internal Redis.
- **Pillars KrakenD does not address:** workflow engine, shared projects, multi-agent orchestration and PM-tool sync
  (pillars 2, 4, 7, 8).
- **Licence-clean and air-gapped by design**, with the full product in one deployable rather than an AI module licensed
  onto a closed binary.

## 7. One-line positioning

"KrakenD routes, caches and rate-limits your AI traffic. RegulAIt decides, per person, whether each model, tool and agent
call may happen at all, and proves it afterwards. Keep KrakenD at the edge if you already run it."
