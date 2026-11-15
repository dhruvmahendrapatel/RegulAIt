# ADR-0287: A governed, stateless Responses API compatibility shim (P33 follow-up)

- **Status**: Accepted (builder lane L6, 2026-11-14; PENDING P33 follow-up named in ADR-0257)
- **Date**: 2026-11-14
- **Index**: Governed, stateless `POST /v1/responses` shim (P33 follow-up): laravel/ai's default driver and the OpenAI SDKs' `responses.create`
- **Amends**: [ADR-0020](0020-ide-interception-compat-endpoints.md) by addition (a third provider-shaped surface over
  the same dispatch core). [ADR-0257](0257-third-party-client-compat-tests.md) gains two harness lanes.
- **Migration**: none.

## Context

ADR-0257 ran laravel/ai against the gateway and found that its default `openai` driver speaks the OpenAI Responses
API (`POST /v1/responses`), not Chat Completions; so do the OpenAI SDKs' `responses.create` calls. The gateway had
only `/v1/chat/completions` and `/v1/messages`, so those clients could not be pointed at RegulAIt unchanged.

The Responses API is stateful by default: the vendor stores each response (`store` defaults to true) and a client
continues a conversation with `previous_response_id` instead of resending it. laravel/ai's tool loop does exactly
that unless the provider is configured with `store => false`, in which case it replays the whole history.

Open-source check (ADR-0176): the official `openai` SDK and laravel/ai are clients, not servers. No permissively
licensed library translates the Responses wire format onto a neutral dispatch contract that our governance path can
sit under; LiteLLM (MIT, Python) has a Responses bridge but it is a separate proxy process and would put a second
dispatch path beside the governed one. The shim is a translation layer over our own dispatch core, which is the
"genuinely RegulAIt" exception.

## Decision

1. **`POST /v1/responses` is a translation shim over the one governed dispatch core**
   (`apps/gateway/src/compat-responses.ts`), exactly like the Chat Completions shim: `prepareCompatCall` (entitlement,
   routing, project attribution, PII posture, rate limits) and `executeCompatCall` (the dispatch, cost attribution on
   the usage ledger, the audit row). Audit and usage rows carry `surface: compat_openai_responses`.
2. **It rides the OpenAI-compatible switch.** It is the same vendor dialect, so `openaiCompatEnabled` and its
   ADR-0024 scope rules open and close both routes; a closed surface answers the same indistinguishable 404 before
   auth. Off by default, like every compat surface.
3. **Stateless by design.** RegulAIt does not hold conversation content server-side: a stored response would be
   prompt and output held outside the gateway's retention and PII controls. `previous_response_id` (unsupported
   field), `store: true` and any `include` value other than `reasoning.encrypted_content` are a 400 naming the field;
   every response says `store: false`. The emitted output items (`message`, `function_call`) are valid input items,
   so a client that replays them (laravel/ai with `store => false`, or an SDK caller passing `store: false` and the
   prior output) runs a tool loop with no server state. `include: ["reasoning.encrypted_content"]`, which laravel/ai
   sends for reasoning-model names, is accepted: the shim emits no reasoning items, so there is nothing to include.
4. **The ADR-0020 field rules apply unchanged.** Honoured: `model`, `input` (string or message / `function_call` /
   `function_call_output` items; text and base64 `data:` images), `instructions`, `stream`, function `tools`,
   `tool_choice` (auto, none, required, a named function), `max_output_tokens`, `text.format` (text, json_object,
   json_schema, gated by the served provider's native capability as on Chat Completions). `temperature` is the shared
   accept-and-disclose tier (strict mode rejects it). Everything else, including built-in tools, reasoning items,
   remote image URLs and deferred tool loading, is a 400 whose message names the field.
5. **Streaming speaks the Responses event dialect** (`response.created`, `response.in_progress`,
   `response.output_item.added`, `response.content_part.added`, `response.output_text.delta`/`.done`,
   `response.function_call_arguments.delta`/`.done`, `response.output_item.done`, then `response.completed` or
   `response.incomplete`), each with `type` and a monotonic `sequence_number`. The stream opens lazily, so a denial
   inside the governed dispatch is still a real HTTP error; a failure after the first byte is an `error` event.
6. **Credentials.** The same RegulAIt API key and session rules as Chat Completions (Bearer only; no `x-api-key`
   alias). A virtual dispatch key reaches the route (its allow-list gains it, same governance). Engine keys (ADR-0187)
   and delegated workload tokens (ADR-0188 `WORKLOAD_ROUTES`) do **not**: their allow-lists are unchanged, the
   secure default; widening either is an owner decision (recorded as an open question on the PR).

## Consequences

- laravel/ai's native `openai` driver (with `store => false`) and the OpenAI SDKs' `responses.create` work against
  RegulAIt unchanged; both are new lanes in the ADR-0257 harness (`openai-responses`, `laravel-responses`), which also
  check that their allowed calls were audited on the `compat_openai_responses` surface.
- A client relying on server-side state (`previous_response_id`, laravel/ai's default `store` true in a tool loop)
  gets a clear 400 rather than a silently different conversation.
- Usage reports `input_tokens_details.cached_tokens` from the measured cache-read count and `reasoning_tokens: 0`
  (no reasoning items are produced through this shim).
- No migration, no new table, no UI: the route is listed in the route census as data plane.
