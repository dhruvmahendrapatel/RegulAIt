# ADR-0253: The AI SDK provider packages as the vendor-neutral model layer (no `ai` core, no Vercel AI Gateway)

- **Status**: Accepted (owner-approved backlog item P29, 2026-11-07)
- **Date**: 2026-11-07

## Context

The owner's SDK and platform review (2026-11-07) asked us to adopt the Vercel AI SDK **provider packages**
(`@ai-sdk/provider` plus `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google` and so on; Apache-2.0, TypeScript,
released several times a week). They would sit under the gateway's model adapters and replace hand-written adapter
code wherever they cover it (ADR-0176 rule 2). The brief set one hard rule. The `ai` core package hard-depends on
`@ai-sdk/gateway`, and a bare string model id such as `'openai/gpt-x'` routes to Vercel's hosted AI Gateway. That
path must not exist in RegulAIt, and the model layer must keep working air-gapped behind our guarded egress
(ADR-0062).

### Inventory (step 1)

Every model adapter lives in `packages/model-provider`. Each was checked against the AI SDK (`@ai-sdk/provider`
4.0.35, LanguageModelV4).

| Adapter | Built on | Streaming | Tools / tool choice | Structured output | Usage, cache, modality | Errors and retries | AI SDK coverage |
|---|---|---|---|---|---|---|---|
| Google (Gemini) | **Hand-written raw `fetch`**: a request builder, a JSON-Schema-to-Gemini-Schema translator and an SSE parser (about 410 lines) | Own SSE parser | Own functionCall/functionResponse mapping | Own `responseSchema` translation | Raw `usageMetadata`, ADR-0212 modality split, `modelVersion` | Own status mapping, no retries; AER-021 deadline through the injected fetch | `@ai-sdk/google` covers all of it and adds `parametersJsonSchema` (no lossy translation), call ids, Gemini 3 thought-signature replay and output continuation. **Replaced.** |
| Anthropic | Official `@anthropic-ai/sdk` (MIT) | SDK stream | SDK | None (we refuse, ADR-0020) | `cache_read` / `cache_creation`, thinking blocks with signatures | SDK, 2 retries | `@ai-sdk/anthropic` covers it, but this adapter is not hand-written protocol code. **Kept**, see below. |
| OpenAI (chat completions and the Responses API) | Official `openai` (Apache-2.0) | SDK stream | SDK | `response_format` | `cached_tokens`, reasoning tokens, audio/image tokens | SDK, 2 retries | `@ai-sdk/openai` covers it. **Kept**, same reason. |
| xAI | Official `openai` SDK at `api.x.ai` | as OpenAI | as OpenAI | as OpenAI | as OpenAI | as OpenAI | **Kept** (same core as OpenAI). |
| Custom (ADR-0034) | `openai` SDK (with header surgery for keyless endpoints) or the Anthropic adapter | as above | as above | as above | as above | as above | **Kept**. |
| `regulait_llm`, mock | In-process, no network | n/a | n/a | n/a | n/a | n/a | Out of scope. |

## Decision

1. **Use the specification and the per-vendor packages, never the `ai` core.** `packages/model-provider` depends on
   `@ai-sdk/provider` 4.0.35 and `@ai-sdk/google` 4.0.109, pinned exactly (see As built for the release-age choice). It does not install `ai` or
   `@ai-sdk/gateway`. Without the core there is no resolver that turns a string id into a gateway call. Every model is
   a provider **instance** we construct with the agent's key, the configured base URL and our deadline-bound, egress-guarded
   fetch (`resolveModelProvider` is still the single funnel).
2. **One bridge.** `src/ai-sdk-bridge.ts` maps our neutral contract (`ModelDispatchRequest` / `ModelDispatchResult`)
   onto LanguageModelV4: the prompt (tool results split into `tool` messages, names recovered from history, prior
   thinking skipped), tools, tool choice, JSON mode, streaming with `onText`, and errors (our model deadline stays
   `504` and is named as one; an HTTP failure keeps its status; an egress refusal passes through on the cause chain).
   Any later vendor package (Bedrock, Azure, Mistral) plugs into the same bridge without new protocol code.
3. **Google moves first, and the hand-written adapter is deleted.** It shipped behind an internal switch
   (`REGULAIT_P29_GOOGLE_ADAPTER`, commit 1), ran the full suite on both paths (legacy 171/171, AI SDK 162/171,
   where all 9 differences were wire-dialect assertions), then became the only path (commit 2). Those 9 tests now
   assert the SDK's documented Gemini wire shapes with the same intent: `parametersJsonSchema` and
   `responseJsonSchema` carry the JSON Schema verbatim, and `functionCall` / `functionResponse` carry the call id and
   use `response: {name, content | error}`.
4. **Behaviour the gateway sees does not move.** The Gemini adapter reads these from the **raw vendor response**,
   not from the SDK's normalised view:
   - **usage:** `promptTokenCount` and `candidatesTokenCount`, plus the ADR-0212 modality split. The SDK adds
     tool-use prompt tokens and thought tokens into its totals, and adopting that would change a bill, which is pillar
     5's decision (see Consequences);
   - **refusals:** our refusal set (SAFETY, PROHIBITED_CONTENT, BLOCKLIST, SPII, and prompt blocks). RECITATION
     and IMAGE_SAFETY stay `other`, as before;
   - **served model:** `modelVersion` (ADR-0175 A4), which the SDK does not surface;
   - **tool-call ids:** `<responseId>-fc-<n>` whenever Gemini sends no id of its own.

   Governance, cost attribution (pillar 5), token optimisation (pillar 6) and audit are unchanged, because they all
   run upstream of `ModelProvider.dispatch`.
5. **Anthropic, OpenAI, xAI and custom stay on their vendors' official SDKs.** ADR-0176 rule 2 replaces
   *hand-written* solutions. These adapters already use validated open-source clients for transport, streaming,
   retries and errors. Our own code there is the mapping onto our contract, and a bridge would still need it.
   Swapping now would put at risk behaviour those adapters have and tests pin (thinking-signature replay, the OpenAI
   Responses API split, keyless header removal for custom endpoints) without retiring any protocol code. **Re-check**
   when any of these happens:
   - a vendor SDK falls short of the ADR-0176 bar;
   - we add a vendor that has no official TypeScript SDK;
   - the owner wants a single client stack.

   Each vendor then moves through the same bridge, one per commit, behind a switch.
6. **Guards (`src/ai-sdk-guard.test.ts`).** The build fails if:
   - `ai` or `@ai-sdk/gateway` appears in any workspace manifest or in the lockfile;
   - a file touching the AI SDK passes a string-literal model id;
   - such a file imports a provider's **default instance** (for example `google`), which reads an ambient
     `GOOGLE_GENERATIVE_AI_API_KEY` instead of the agent's credential;
   - the installed `@ai-sdk/*` code names a Vercel host.

   An egress test also proves three things: every request reaches only the configured host (the default and an
   air-gapped private base); it goes through the injected fetch, never the global one; and the agent's own key is
   sent even when an ambient one is set. The adapter refuses an empty key instead of letting the SDK fall back to the
   environment.
7. **Telemetry.** The provider packages contain none. OpenTelemetry spans live in the `ai` core
   (`experimental_telemetry`, opt-in), which is not installed.

## Consequences

- About 410 lines of hand-written Gemini protocol code are gone. Gemini tool schemas are no longer approximated
  (`oneOf` was widened to `anyOf`, and `additionalProperties` and `$ref` were dropped). Gemini 3 thought signatures and
  long-output continuation now work.
- The model package gains a shared runtime module, `src/core.ts` (error type, deadline, usage helpers, defaults). The
  adapter modules import it without an import cycle through `index.ts`, which re-exports it unchanged.
- New dependencies, all listed in `packages/model-provider/THIRD_PARTY.md`: `@ai-sdk/provider`, `@ai-sdk/google`,
  `@ai-sdk/provider-utils`, `undici`, `@workflow/serde`, `eventsource-parser`, `json-schema` (types only, BSD-3-Clause
  elected; unmaintained, accepted because no runtime code reaches it) and `zod` (the version the repo already pins).
  The provider packages release several times a week, so updates go through the normal pinned-lockfile review.
- **Follow-up for pillar 5 / P21 (#453).** Gemini thinking models bill `thoughtsTokenCount` as output, and
  `toolUsePromptTokenCount` is input. We have never counted either (this ADR preserves that exactly). Whether to
  count them is a cost-attribution decision for the P21 usage extractor, not part of this swap.
- **Merge coordination with P21 (ADR-0241).** P21 adds `usageSource` to each adapter's result, including the
  legacy Gemini adapter this ADR deletes. Whichever PR merges second carries it into `google-ai-sdk.ts`: the raw
  response body on the non-streaming path, and the last raw chunk that carried `usageMetadata` when streaming. Both
  are already in hand there.

## As built (2026-11-07, merge with P21)

P21 (ADR-0241) merged first, so this PR carried `usageSource` into `google-ai-sdk.ts`: the response body when not
streaming, and the last raw event that carried `usageMetadata` when streaming. That is the same object the legacy
adapter reported. `src/google-usage-source.test.ts` pins both paths. Under ADR-0252 the STATE and PENDING entries
are fragments in `internal/fragments/`, and the index row is generated from this file's header at merge time.

## As built (2026-11-08, #723 review)

- **Continuation.** `@ai-sdk/google` continues a long Gemini output on its own when a hop finishes with
  `CONTINUATION`, sending one HTTP request per hop. Both paths now read usage from the SDK's per-hop sum
  (`providerMetadata.google.usageMetadata`, built by `addGoogleUsageMetadata`), not from the last hop. Before this
  fix the streaming path billed only the last hop, which under-counted pillar-5 cost and budget.
- **Deadline.** The adapter passes one `abortSignal` (`AbortSignal.timeout(modelDispatchTimeout())`) for the whole
  dispatch, so every hop and every body read share one AER-021 deadline. `deadlineBoundFetch` still binds each fetch
  as well. A `GoogleProvider` built directly, outside `resolveModelProvider`, is therefore bounded too.
- **`usageSource` (P21).** It is the raw vendor object that carried usage, with its `usageMetadata` replaced by the
  same per-hop sum. An admin usage mapping (ADR-0241) therefore reads exactly the tokens `usage` reports. With a
  single hop it is the vendor object unchanged.
- **Release age.** The pins are `@ai-sdk/provider` 4.0.35 and `@ai-sdk/google` 4.0.109, with `provider-utils`
  5.0.72 transitive. All three were released on 2026-10-30, eight days before adoption. This follows the repo's
  precedent of not admitting releases from the week of adoption (`@hyperjump/json-pointer` 1.1.3 over 1.1.4, and
  `rfc6902` in #719). The first pins (4.0.36 / 4.0.113) were 1 to 3 days old.
- `src/google-usage-source.test.ts` pins two-hop continuation on both paths and the whole-dispatch deadline. Both
  of those tests fail with the fix reverted.
