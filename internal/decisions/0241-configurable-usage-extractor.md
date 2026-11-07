# ADR-0241: A configurable usage extractor (backlog P21)

- **Status**: Proposed
- **Date**: 2026-11-07
- **Backlog**: P21 (owner-approved 2026-11-07; the PENDING.md row lands with the PR "docs(pending): P21 usage extractor…")
- **Pillars**: 5 (cost attribution), 6 (the same interception point), 1 (admin-only, audited, step-up)

## Context

Pillar 5 prices every model dispatch from the token counts the adapter reports (`ModelDispatchResult.usage`). Each
adapter in `@regulait/model-provider` reads its provider's usage block with its own code: Anthropic's `usage`, OpenAI's
`usage` on chat completions and the Responses API, Gemini's `usageMetadata`. [ADR-0212](0212-modality-pricing-and-model-rate-limits.md)
prices image and audio tokens separately, but only where the adapter reports a modality split. So a new or custom
provider, or a provider whose usage block has moved, cannot be priced correctly without a code change.

The design reference is Gravitee's AI prompt token tracking policy
(`gravitee-io/gravitee-policy-ai-prompt-token-tracking`, Apache-2.0, Java). Its custom extractor maps a response body
to sent and received token counts with JSON pointers. It is cited for the idea only; no code is copied. It covers text
counts only, so the modality split, the cache counts, the array step, the consistency check and the governance around
activation are new here.

## Decision

**An admin defines, per agent, a mapping from the provider's decoded response body to usage counts. Expressions are RFC
6901 JSON Pointers, resolved by `@hyperjump/json-pointer`. The mapping is versioned, tested against a sample response
before it can be activated, audited at every change, and read at dispatch only once an org switch is on. That switch is
off by default, and turning it on needs a step-up.**

1. **The mapping** (`regulait.usage-mapping/v1`, validated by `validateUsageMapping` in
   `packages/model-provider/src/usage-extractor.ts`). It covers eight counts:
   - `inputTokens` and `outputTokens`, both required;
   - `cacheReadInputTokens` and `cacheCreationInputTokens`;
   - `imageInputTokens`, `imageOutputTokens`, `audioInputTokens` and `audioOutputTokens`.

   Each count is read by one of three sources:
   - `pointer`: one pointer;
   - `sum`: up to four pointers added together;
   - `arraySum`: a declarative step over an array (`array`, an optional `where: {pointer, equals[]}`, and `value`). It
     covers providers that report usage as a list keyed by modality, such as Gemini's `promptTokensDetails`.

   `totalsInclude` says whether the totals already include the modality counts (`all`, the default, as OpenAI and
   Gemini report them; text is then the remainder, as in ADR-0212) or not (`text_only`; the modality counts are then
   added to the totals).

2. **Library (ADR-0176).** `@hyperjump/json-pointer` 1.1.3 (MIT, released 2026-10-03, no dependencies). It reads own
   properties only, so a pointer cannot reach a prototype. The search also covered:
   - `jsonpointer` and `json-pointer`: no release since 2022;
   - `json-ptr`: no release since 2022;
   - a JSONPath library: filter and script expressions are more than a bounded mapping needs (`jsonpath-plus` is in the
     lockfile only through `@kubernetes/client-node`).

   1.1.4 and 2.0.x were released in the week of adoption, so they were not taken.

3. **Bounds, and no code execution.** There is no template language, no regular expression, no script and no recursion
   driven by the mapping. The limits are pinned by tests (`USAGE_EXTRACTOR_LIMITS`):

   | What is bounded | Limit |
   |---|---|
   | Mapping document | 4 KiB of JSON |
   | Pointer length | 256 characters |
   | Pointer segments | 12 |
   | Terms in a `sum` | 4 |
   | `equals` values | 8, each at most 64 characters |
   | Elements in an `arraySum` array | 256. A longer array is refused, never truncated |
   | Response body (checked before any pointer is evaluated) | 20,000 values, nesting depth 64, 1 MiB of text |
   | A count | a non-negative safe integer of at most 10^12 |

   The size check walks the body iteratively and stops at the first limit crossed, so a cyclic in-memory object
   cannot loop. Unknown keys, a wrong format tag, a malformed pointer and a missing required field are refused at save
   time with `422 invalid_usage_mapping`. A sample to test against is capped at 1 MiB (`413 sample_too_large`).

4. **Where it runs.** Adapters now return the decoded object their usage came from as `usageSource`:
   - Anthropic: the message;
   - OpenAI chat and Responses: the response;
   - Gemini, and streamed chat completions: the last chunk that carried usage.

   `usageSource` is held in memory only. It is never stored, logged or returned. `resolveDispatchUsage`
   (`apps/gateway/src/usage-extractors.ts`) runs at the one pricing point of the governed dispatch, just before
   ADR-0212's `priceDispatchUsage`. The mapped counts therefore feed pillar-5 attribution, the baseline saving,
   virtual-key spend, the dashboard and modality pricing without a second pricing path. The usage row names the
   version that produced its counts (`usage_events.usage_extractor_version_id`, FK-free like the ledger's other
   attribution columns) and records the outcome in `detail.usageExtractor`. The stored mapping is validated again on
   every read.

5. **Fail closed: the adapter's built-in extraction.** A mapping can fail to read a response for any of these
   reasons:
   - there is no body;
   - a bound is crossed;
   - a required count is absent;
   - a value is not a token count;
   - the image and audio counts are larger than the total they are part of;
   - the stored mapping no longer validates.

   In each case the dispatch keeps the adapter's own counts. The usage row records
   `usageExtractor: {result: "fallback", failure}` with a NULL version, and an audit row
   (`usage-extractor-fallback`) is written. **We fall back rather than refuse, because the extractor runs after the
   call.** The provider has already served and billed it, so refusing at that point would only lose the record of
   spend. The refusal for an unpriceable call stays where it already is, before dispatch: under a budget, an unpriced
   agent is refused (ADR-0188 decision 16, `delegation-budget`; ADR-0016 per-node ceilings; ADR-0103 for MCP). A
   mapping never turns a call the built-in counts would price into an unpriced one, because it produces counts and
   never prices.

6. **Versioned, tested, audited.**
   - **Save.** `POST /v1/agents/:agentId/usage-extractor/versions` saves the next version as an immutable row, under
     a lock on the agent row.
   - **Test.** `POST .../versions/:versionId/test` takes `{sample, expected}`. It passes only when the mapping
     produces exactly the expected counts, with an absent count read as 0. Only the sample's SHA-256 is stored.
   - **Activate.** `POST .../versions/:versionId/activate` works only when the latest test of that exact version
     passed. This is checked before the step-up, so a refusal never spends a grant, and checked again under the row
     lock. Activation needs a `settings_relax` step-up, because it changes what spend is attributed.
   - **Deactivate.** `POST .../usage-extractor/deactivate` returns the agent to its built-in counts.
   - **Switch.** `PUT /v1/usage-extractors/enabled` turns the org switch on or off.
   - **Audit.** Every one of these writes its audit row in the same transaction.
   - **Read.** `GET /v1/usage-extractors` and `GET .../versions` read the configuration.
   - **Admin only.** Every route is admin-only through the global gate, and none is in `NON_ADMIN_ROUTES`.

7. **Off by default (ADR-0180).** `org_settings.usage_extractor_enabled` defaults to false. While it is off, no
   mapping is read and every count is the adapter's own. Turning it on needs a `settings_relax` step-up. Turning it
   off, and deactivating a version, return to the strict default, so they are audited without a step-up.

8. **Cached tokens are counted, not priced.** The cache counts go into the existing `cacheReadInputTokens` and
   `cacheCreationInputTokens` fields. Those fields are observability only (ADR-0173 batch 2c): no price or budget reads
   them. This ADR does not add a cache price. If one is wanted, it is a separate pricing decision.

## Consequences

- A new or custom provider can be priced, modality split included, from an admin mapping without a code change. The
  golden tests show the mapping reproducing the built-in adapters exactly for OpenAI chat (including the streamed final
  chunk), the OpenAI Responses API, Anthropic and Gemini. They also cover Amazon Bedrock Converse and Cohere v2, which
  no built-in adapter reads.
- **One dispatch-time read is added when the switch is on:** the switch, plus one join on the active version. While
  the switch is off, the cost is the switch read.
- **A wrong mapping that still passes its test can misattribute spend.** The controls are the exact-count test, the
  step-up on activation, the audit trail, the version stamp on every usage row, and the consistency check (a split
  larger than its total falls back). They cannot catch a mapping that reads the wrong but well-formed field on every
  response. This is disclosed.
- **A mapping is per agent, not per provider.** Two agents served by the same custom provider need a mapping each. A
  shared per-provider mapping is a possible follow-up.
- **The mapping editor UI is not built here.** The brief was API only. The need is posted on #453 for the Governed
  Designer, and the seven routes are listed as `KNOWN_UI_GAPS` in `scripts/preflight-ui-route-census.mjs`. That list's
  ratchet is raised from 0 to 7 for the master to accept or refuse on the PR.
- Migration `0297_usage_extractor.sql` adds:
  - three tables: `usage_extractor_versions`, `usage_extractor_tests` and `usage_extractor_active`;
  - one org switch: `org_settings.usage_extractor_enabled`;
  - one ledger column: `usage_events.usage_extractor_version_id`.

  It adds no functions or triggers.
