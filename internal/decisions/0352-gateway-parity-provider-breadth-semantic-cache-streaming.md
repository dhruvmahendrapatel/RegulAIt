# ADR-0352: Gateway parity 2 — native Bedrock, Vertex, Mistral, Cohere and Qwen adapters; a meaning-based cache tier; incremental streaming inspection

- **Status**: Accepted (owner-approved lane E33, 2026-11-17, from the KrakenD competitor review)
- **Date**: 2026-11-17
- **Index**: Gateway parity 2: five native provider adapters, a meaning-based cache tier, incremental streaming inspection

## Context

The KrakenD AI Gateway review (`internal/product/GAP_ANALYSIS_KRAKEND_2026-11.md`, on PR #935 until it merges) ranked
three request-path gaps first, because they are what a KrakenD, LiteLLM or Portkey evaluator tests first:

1. **Provider breadth.** Our compat edges (ADR-0257, ADR-0287) speak OpenAI and Anthropic and route to native
   Anthropic, OpenAI, Google and xAI adapters plus admin-registered endpoints (ADR-0034). There is no native AWS Bedrock
   (SigV4), Google Vertex, Mistral, Cohere or Qwen adapter, so "point Claude Code at the gateway and serve it from
   Bedrock under the customer's own AWS account" needs a hand-built proxy.
2. **A cache that matches by meaning** (gap #6 in the review). ADR-0119/0136/0138/0146 cache by exact canonical identity.
3. **Streaming inspection without buffering** (gap #9). Under a blocking output policy ADR-0042/0137 buffers the whole
   completion.

Vendor features are ideas only. We never embed a competitor's proxy, and the ADR-0251 gateway stays the single
decision point (review §4).

This ADR is built in three slices, one pull request each. This section records slice 1; slices 2 and 3 add their own
"As built" sections here under the same number.

## Decision — slice 1: five native provider adapters

### What we built

- **Five new provider kinds** in `MODEL_PROVIDER_KINDS`: `bedrock`, `vertex`, `mistral`, `cohere`, `qwen`. They are
  served by one adapter class, `AiSdkVendorProvider` (`packages/model-provider/src/ai-sdk-vendors.ts`), driven through
  the ADR-0253 bridge (`ai-sdk-bridge.ts`), the same path the Gemini adapter takes. The bridge gained two additive fields
  on `StreamCollected` (the normalised finish reason and the usage block of the finish part).
- **The same governed path.** Nothing new decides anything. The gateway's one dispatch core (ADR-0251) resolves the
  adapter through `resolveModelProvider`, so entitlement, budget pre-gate, rate limits, guardrails, cost attribution
  (`usage_events`, priced from the agent row), and audit apply unchanged. `zz-adr0352-vendor-adapters.test.ts` proves it
  end to end against a fake Bedrock endpoint: an ungranted user is refused before any vendor call, the granted call is
  SigV4-signed with the stored credential, priced and audited.
- **Credentials stay in the encrypted store and are rotatable** through the existing platform (`/v1/model-credentials`)
  and per-user (`/v1/users/:id/model-credentials`) routes: re-posting a provider replaces the key, stamps
  `secret_set_at` and writes a `model-credential-rotated` audit row (ADR-0181). The secret is never returned or logged.
  Structured secrets are JSON in the same encrypted column:
  - **Bedrock**: `{"accessKeyId","secretAccessKey","sessionToken"?,"region"?}` for SigV4, or a Bedrock API key (sent as
    a bearer token).
  - **Vertex**: a service-account key (`type: "service_account"`), or an express-mode API key.
  - **Mistral, Cohere, Qwen**: the vendor's API key.
  Both routes now check the shape per kind when the secret is typed (`validateVendorCredential`), so a malformed secret
  fails with a 400 that names the problem and never echoes the value.
- **SigV4 through the AWS SDK's signer.** Bedrock requests are signed by `@smithy/signature-v4` (the signer inside the
  AWS SDK for JavaScript v3), with `@smithy/hash-node` for SHA-256. The test re-signs the request that actually went on
  the wire and compares signatures, so "the request sent is the request signed" is checked, not assumed.
- **No ambient credential, ever.** Each SDK falls back to process-wide credentials when none is passed
  (`AWS_BEARER_TOKEN_BEDROCK`, `AWS_ACCESS_KEY_ID`, `AWS_REGION`, `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`,
  `GOOGLE_VERTEX_API_KEY`, Google Application Default Credentials and the metadata server, `MISTRAL_API_KEY`,
  `COHERE_API_KEY`, `ALIBABA_API_KEY`). The adapters always pass the key, region and base URL explicitly. For SigV4 and
  service accounts the SDK is handed an inert sentinel API key, so it takes its plain API-key path and never looks for
  ambient credentials; our fetch wrapper removes the sentinel header and signs, or adds a bearer token minted from the
  stored service account. Tests stub every ambient variable and the global fetch and assert none is used.
- **Destinations stay adjudicated (ADR-0062).** Bedrock endpoints are per region and Vertex service-account endpoints are
  per project and location, so neither has a compiled default. Both **require an explicit `baseUrl`** on the credential,
  which the ADR-0034/0043 egress guard checks when it is typed and again on every request. Deriving the URL from a region
  inside the secret would have sent traffic to a host the guard never saw, so the region only ever comes from the
  `bedrock-runtime.<region>.amazonaws.com` host, or from the credential for a private endpoint (a mismatch is refused).
  `defaultBaseUrlFor` returns `null` for Bedrock (nothing to adjudicate without a baseUrl, like `custom`) and the
  vendor's compiled host for the other four, pinned by a drift test. The Vertex service-account token request also goes
  through the injected fetch, so on the guarded path `oauth2.googleapis.com` must be on the egress allow-list too; the
  key's own `token_uri` is ignored, so a stored key cannot redirect the token request. Minted tokens are cached per
  credential (keyed by a hash of the key, never shared across credentials) until a minute before expiry.
- **Env-key fallback** (ADR-0021/0181, off by default): Mistral (`MISTRAL_API_KEY`), Cohere (`COHERE_API_KEY`,
  `CO_API_KEY`) and Qwen (`DASHSCOPE_API_KEY`, `ALIBABA_API_KEY`) join the four existing kinds. The org's
  `env_fallback_providers` column default is unchanged (the original four), so an existing install allows none of the new
  ones until an admin adds them, which is the audited loosening path. Bedrock and Vertex have no env fallback: their
  credentials are structured and need an explicit baseUrl.
- **One vocabulary.** `VENDOR_MODEL_PROVIDERS` and `ENV_FALLBACK_MODEL_PROVIDERS` in `@regulait/shared` replace the
  hand-copied lists in the credential schema, the org-settings schema, the gateway's env fallback and the
  `/v1/model-providers/status` report. A gateway test pins `VENDOR_MODEL_PROVIDERS` to the package's kinds.
- **Capabilities fail loud.** `thinking` is refused on the five kinds (no verified native mapping yet). Structured output
  (`response_format`) is accepted for `vertex` (the same `@ai-sdk/google` implementation as `google`) and refused with a
  named 400 on the others until each is verified (ADR-0020's "honoured or loud" rule).
- **Served model (ADR-0175 A4)** is read from the vendor's own response body only: Mistral and Qwen `model`, Vertex
  `modelVersion`. Bedrock Converse and Cohere v2 report none, so theirs is `null`, never the request echoed.

### Options compared (ADR-0176, owner rule 9)

Repository search first: the ADR-0253 bridge and its Gemini adapter, the encrypted per-kind credential store with its
upsert-as-rotation and audit, the ADR-0034/0062 egress guard and guarded fetch, the ADR-0181 env fallback and the
ADR-0020 capability gate were all reused. Nothing parallel was written.

| Vendor | Option A (chosen) | Option B | Option C | Why A |
|---|---|---|---|---|
| Bedrock | `@ai-sdk/amazon-bedrock` 5.0.130 (Apache-2.0, released 2026-10-30) with SigV4 by `@smithy/signature-v4` 5.7.5 (Apache-2.0, 2026-10-29) | `@aws-sdk/client-bedrock-runtime` (Apache-2.0, official) `ConverseCommand` | the AI SDK's built-in signing through `aws4fetch` | A reuses the bridge (tools, streaming events, usage), and signs with the AWS SDK's own signer. B means a second hand-written mapping of our contract onto Converse and its event stream, beside the bridge. C: `aws4fetch` 1.0.20 was last released 2024-08-28, which fails the 12-month maintenance rule; it stays in the lockfile as an unused transitive dependency (the SDK only calls it when no API key is passed, and we always pass one). |
| Vertex | `@ai-sdk/google-vertex` 5.0.129 (Apache-2.0) with `google-auth-library` 11.3.2 (Apache-2.0) for the service-account token | `@google/genai` (Apache-2.0, official) in Vertex mode | — | A runs the same `@ai-sdk/google` 4.0.109 implementation our Gemini adapter already uses, so the Gemini mapping exists once. B would be a second Gemini mapping and defaults to Application Default Credentials. |
| Mistral | `@ai-sdk/mistral` 4.0.77 (Apache-2.0) | `@mistralai/mistralai` (Apache-2.0, official) | — | A reuses the bridge; B would be a fourth hand-mapped chat contract. |
| Cohere | `@ai-sdk/cohere` 4.0.73 (Apache-2.0) | `cohere-ai` (MIT, official) | — | Same reason as Mistral. |
| Qwen | `@ai-sdk/alibaba` 2.0.80 (Apache-2.0) | the existing `custom` kind with `openai_chat` pointed at DashScope compatible mode | — | A makes Qwen a first-class kind with a named compiled default and the vendor's own handling of Qwen specifics; B stays available for any other OpenAI-compatible endpoint. |

All AI SDK packages are pinned to the versions released on 2026-10-30 that depend on exactly `@ai-sdk/provider` 4.0.35
and `@ai-sdk/provider-utils` 5.0.72, the versions ADR-0253 already admitted, so the spec and HTTP helpers are not
duplicated. The ADR-0253 guard tests (no `ai` core, no `@ai-sdk/gateway`, no default provider instances, no bare-string
model ids, no Vercel host in installed provider code) cover the new packages unchanged and pass.

### Not built in slice 1, and why

- **Instance-role / workload-identity credentials** (the AWS default credential chain, GKE workload identity) for BYOC.
  They are ambient by nature and need their own opt-in setting, like the env fallback. Recorded as a pending item.
- **Admin UI** for the new kinds (the credential form, the agent register form). No new route was added, so there is no
  route-census entry; the screens are the design builder's (#453) and are recorded as a pending item.
- **Thinking and structured output** on Bedrock, Mistral, Cohere and Qwen: refused loudly until each mapping is verified
  against a live endpoint.

## Consequences

- An admin can serve Claude, Llama, Mistral or Nova models from the customer's own Bedrock account, Gemini from Vertex
  under a GCP service account, and Mistral, Cohere and Qwen natively, behind the same per-user entitlement, budget, cost
  and audit path as every other model call. The OpenAI and Anthropic compat edges route to them like any agent.
- Seven more npm packages ship in `@regulait/model-provider` (listed in its `THIRD_PARTY.md`); all are Apache-2.0 or MIT
  and make no network call of their own outside the injected fetch.
- Bedrock and Vertex service-account credentials only work with an explicit, allow-listed baseUrl. That is a deliberate
  cost of keeping every destination adjudicated.

## As built — slice 2: a meaning-based cache tier (2026-11-17)

### What we built

- **A second tier behind the exact cache, off by default.** `org_settings.semantic_cache_similarity_enabled` (default
  `false`), `semantic_cache_similarity_min` (cosine, default 0.95, CHECK 0.80–0.999) and `semantic_cache_embedder_id`
  (FK to `external_scorers`, SET NULL on delete), all in the `semantic_cache_similarity` migration. Turning the tier on
  is a classified loosening in the ADR-0181 strictness registry (`notEqual(false)`); so is lowering the bar
  (`atLeast(0.95)`). The settings PUT refuses `true` without an embedder (`embedder_required`), an id that is not a
  `text_embedding` scorer (`unknown_embedder`), or one that has not passed its connection test (`embedder_disabled`).
  It also needs the exact cache's own policy (`semantic_cache_policy`, ADR-0181 default `off`) to cache at all.
- **The partition is mandatory and has no setting.** A vector is stored in `semantic_cache_embeddings`, one row per
  `semantic_cache` row (FK, ON DELETE CASCADE, so the TTL purge and user erasure remove it). Its `partition_key` is a
  sha256 commitment to the user, the agent, and **everything in the ADR-0146 exact key except the input text**: the
  attributed project, mode, system, baseline, reference content, attachments, max tokens, cost sensitivity, the
  planner dials and the serving configuration (provider, model, custom endpoint, system prompt, active config and
  prompt versions). A lookup filters on the partition key **and** on the parent row's user and agent, the embedder
  and the embedder's reported model, and the TTL. So a row can only ever be served to the same user, for the same
  agent, under the same project, options and configuration; an embedder upgrade misses. One deployment is one tenant
  (ADR-0041), so the deployment is the tenant boundary.
- **Every hit runs the live gates.** The tier rides inside `lookupSemanticCache`, so the call site keeps the AER-010
  shape the ADR-0119 AST guard pins: one bound hit, one `if (hit)`, handed to `executeGovernedDispatch` as
  `cachedResponse`, and only the core's adjudicated output is served. That core re-runs entitlement, ABAC, guardrails,
  PII mode, budget and the output policy on **this** request's input and the cached output (ADR-0138). The test
  revokes a grant and the paraphrase is refused with 403, not served. The savings row is
  `semantic-cache-similar-hit` with the similarity score; the audit row records `tier: "similarity"` and the score,
  never text.
- **A local embedder only, enforced in code.** The embedder is the ADR-0247 trained-detectors service with a new
  opt-in model (`sentence-transformers/all-MiniLM-L6-v2`, Apache-2.0, pinned by revision and sha256, used as its
  published ONNX export) and a new `POST /embed` route. The gateway registers it as an external scorer claiming
  `text_embedding` **alone** on the `regulait` contract (vendor adapters cannot claim it), so it reuses the
  write-only key, the register → connection test → enable lifecycle and the egress allow-list. On top of the guard,
  the embed fetch's resolver refuses any host that resolves to a public or unclassifiable address, on the very
  addresses the DNS-pinned fetch then connects to, and an IP-literal URL is classified directly
  (`localLiteralRefusal`). A SaaS embedding API cannot be configured, and an internal name re-pointed at a public
  address is refused before a byte of the prompt leaves.
- **Failure is a miss.** An embedder that is down, slow (2 s budget), non-conforming or not local produces a logged
  miss and the call is dispatched for real, fully governed. A cache can never fail a call.
- **The store** writes the vector computed at lookup (one embed call per miss), only on the store path ADR-0146
  already guards (the requested agent served, no fallback, the configuration unchanged during the dispatch).
- **Bounded search in the existing Postgres.** Each lookup compares at most the partition's 256 newest live rows,
  cosine over unit vectors in the gateway. The partition is narrow by construction (one user, one agent, one exact
  set of options), so an index is not needed for correctness or latency at that size.

### Options compared (ADR-0176, owner rule 9)

| Question | Option A (chosen) | Option B | Option C |
|---|---|---|---|
| Embedder | `all-MiniLM-L6-v2` in the existing ONNX sidecar (Apache-2.0; stock tooling) | `BAAI/bge-small-en-v1.5` (MIT; tuned for asymmetric query-to-passage retrieval with a query prefix, which a prompt-to-prompt match does not need) | in-process Node: `@huggingface/transformers` + `onnxruntime-node` (Apache-2.0/MIT), a large native dependency in the gateway image; `fastembed` JS (no release in the maintenance window) |
| Vector store | `double precision[]` in the existing Postgres, bounded brute force inside the partition | `pgvector` (PostgreSQL licence): needs an extension our stock `postgres:16` images do not ship, and managed or air-gapped Postgres installs may not allow it | Redis vectors (the KrakenD design): a new stateful service, and caches must not cross users, which a shared index makes easy to get wrong |

Repository search first: the exact-cache key, store and purge (ADR-0119/0146/0185), the governed hit path (ADR-0138),
the external-scorer registry and its guarded fetch (ADR-0088/0220), the egress guard's address classifier
(ADR-0043) and the ADR-0247 ONNX sidecar were all reused. KrakenD's `key_variants` idea is taken and made mandatory.

### Not built in slice 2, and why

- **The OpenAI/Anthropic compat path** keeps the exact tier only. Its key commits to the whole request
  (ADR-0136), and choosing which part of a message list is "the input" to compare by meaning is its own decision.
  Recorded as a pending item.
- **Row-level security** on `semantic_cache` and its new child table: `semantic_cache` is in ADR-0234's user-owned
  batch, which has not run yet; the child follows its parent there. The partition is enforced in every query today.
- **An admin screen** for the three settings and the embedder registration (design builder, #453; the API is complete).

## As built — slice 3: incremental streaming inspection (2026-11-17)

### What we built

- **An opt-in release mode; the strict default is unchanged.** `org_settings.stream_output_inspection` is `buffer`
  (default) or `incremental` (migration `stream_output_inspection`, CHECK-constrained). `buffer` is today's
  ADR-0019/0042 behaviour: under an output-phase block policy (the project PII mode at `block`, or a guardrail
  detector at `block`) the stream is suppressed or rejected at the route, and the core scans the whole completion
  before one flush. Choosing `incremental` is a classified loosening in the ADR-0181 strictness registry.
- **The rule that does not change: no character before a scan that covered it.** `IncrementalStreamReleaser`
  (`apps/gateway/src/stream-inspection.ts`) accumulates the provider's text deltas. Whenever at least 512 characters
  wait beyond a 256-character hold-back, it scans the window from 256 characters before the released point to the
  end, with the same detectors the final scan uses (`enforcePII` at `block`, and `runGuardrailsAsync` on the output
  phase). Only after the window passes is text released, up to 256 characters short of the end. Any finding no longer
  than the hold-back that touches released text lies inside a scanned window. A scanner failure fails closed.
- **The full scan stays authoritative.** When the provider finishes, the existing whole-result scan runs exactly as
  before (it also covers thinking and tool-call arguments), and the held-back tail is released only if it passes and
  the delta transcript equals the result that was scanned. A window block, a final block, a scanner failure or a
  transcript mismatch all withhold.
- **On a violation, an explicit error event.** The core then returns `ok: false` (`pii_blocked` or
  `guardrail_blocked`, 403) after the usage row, the guardrail decision and the audit rows are written
  (bill-and-withhold), so every streaming surface ends with its own native error: `event: error` on the native SSE
  invoke route, an OpenAI error chunk then `[DONE]` on the OpenAI edge, `event: error` on the Anthropic edge and the
  orchestration worker stream. Where nothing had been released yet, the compat edges and the worker route answer with
  their ordinary HTTP error instead, as they already do for any refusal before the first byte. The detail tells the
  client to discard any partial text it received. Nothing more is released after a block.
- **Where it applies.** The native invoke route, both compat edges and the orchestration worker stream keep a live
  stream under incremental mode (one helper, `incrementalStreamInspection`, read at each of the three pre-dispatch
  decision points). The guarantee itself is in the one dispatch core (ADR-0251), so a served agent's own stricter
  policy is still caught there. A request that also streams thinking keeps the buffer: thinking deltas have no
  windowed path yet.

### Measured overhead

- **Detector cost** (`stream-inspection.test.ts`, the real PII detector, 9,564 characters in 40-character deltas,
  20 runs): 17 windowed scans costing **0.12 ms** in total, against 0.02 ms for one whole-result scan. The windows
  overlap, so the scanned volume is about (512 + 2 × 256) / 512 = 2× the text.
- **Time to first byte**: the first piece is released after about **800 characters** (step plus hold-back) instead of
  after the whole answer (9,564 characters in that run).
- **End to end** (`zz-adr0352-stream-inspection.test.ts`, mock provider, one run each, dominated by fixture and
  database work): buffer 204–217 ms, incremental 119–163 ms for the same 2,700-character answer.
- **Remote detectors scale with windows.** A guardrail served by an external scorer (ADR-0088/0220) is called once per
  window, about length / 512 times per answer, so its own latency adds per window. That is a reason the mode is
  opt-in.

### Options compared

| Approach | Verdict |
|---|---|
| Sliding window with a hold-back, same detectors (chosen) | Keeps one set of detectors (no second regex list, the ADR-0137 warning), bounded cost, a stated span bound. |
| Re-scan the whole accumulated text at each step | Simplest proof, but quadratic cost and a remote scorer call over the whole text at every step. |
| Per-detector streaming state machines (Aho-Corasick or regex automata carried across chunks) | Exact for pattern detectors, but needs a streaming form of every detector, including classifiers that have none; a second implementation to drift. |

Repository search first: the ADR-0042 buffer-and-flush, the ADR-0019 route suppression, `enforcePII`,
`runGuardrailsAsync`, and the routes' existing error events were reused. Nothing in open source fits this exact
contract: KrakenD's streaming manipulation (the design idea credited here) is closed EE code; LLM Guard (MIT) and
Guardrails AI (Apache-2.0) are Python libraries whose streaming validators also re-validate accumulated chunks, the
same windowed idea; adopting either would add a second detector stack.

### Residual, stated plainly

A detector that judges the whole text (a classifier score, or a finding longer than 256 characters) can block at the
end after earlier pieces were released. The client then receives the explicit error event and must discard what it
showed; the spend is billed and the decision audited. This is why `buffer` stays the default. Redaction (ADR-0137's
`redact` mode) is still not enabled: on a block the stream stops; it is not rewritten in flight. The provider call is
not cancelled on a window block (its tokens are billed, as with any bill-and-withhold).
