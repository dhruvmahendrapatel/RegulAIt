# ADR-0212: Modality pricing in cost attribution, and rate limits keyed on the model

- **Status**: Accepted
- **Date**: 2026-10-30

## Context

The owner started the competitor-gap backlog on 2026-10-30 (#453, comment 6522850568). Wave 1 includes P12 items (b) and
(c), on lane `builder/p12-gateway-parity`, with migration 0230 and this ADR. Items (a) guardrail-provider adapters and
(d) token exchange belong to wave 2 and are not covered here.

- **(b)** Pillar 5 priced every dispatch as `input tokens x input price + output tokens x output price`. A request that
  carries images or audio was priced as if it were all text, although providers list those modalities at different
  prices.
- **(c)** Pillar-1 rate limits are keyed on a subject (user, role, team or fleet) and on an MCP server or tool. Nothing
  bounded how often a subject may call one model.

The lane rules apply: new features land behind a default-off org setting unless purely additive and read-only, writes
are admin-only and audited in the same transaction, relaxations need a step-up, and settings sit next to the settings
they belong with.

## Decision

### (b) Pricing by modality

1. **Measured, never inferred.** The model-provider adapters report an image and audio share of their token totals only
   when the provider's own usage block carries one: OpenAI-style chat `prompt_tokens_details` /
   `completion_tokens_details` (`audio_tokens`, and `image_tokens` where a compatible endpoint sends it) and Gemini
   `promptTokensDetails` / `candidatesTokensDetails` (IMAGE and VIDEO count as image, AUDIO as audio). Text is the
   remainder. Adapters whose provider reports no split report nothing.
2. **Per-agent modality prices.** `agents` gains four optional list prices per million tokens (image in and out, audio
   in and out; migration 0230). A modality with no price of its own is priced at the agent's text price.
3. **Unchanged without modality data.** One pure function (`priceDispatchUsage`, shared) prices every dispatch. With no
   modality data it is the pre-0212 formula, and no split is stored. With modality data but no modality prices the
   total is still the pre-0212 figure, and the split records where it went. An agent with no text price stays unpriced.
   The routing baseline's measured saving is priced by the same function.
4. **Recorded on the ledger.** `usage_events.modality_usage` (jsonb, CHECK-shaped) holds tokens and cost per modality
   for rows that have a split, and is NULL otherwise. Nothing is backfilled.
5. **Shown where spend is shown.** The project cost dashboard returns `byModality`: the split totals, and the spend of
   rows with no split as its own line, not folded into text. The chargeback CSV export gains three trailing columns,
   `textCostUsd`, `imageCostUsd` and `audioCostUsd`, empty when a row has no split.
6. **Admin write.** `PUT /v1/agents/:agentId/modality-pricing` is admin-only through the global gate and writes its
   old -> new audit row in the same transaction under a row lock. Setting a price is not a relaxation of a control, so,
   like the text-price edit, it needs no step-up. The columns are not part of the versioned `agent_config` artifact;
   the dispatch reads them from the row (registered with the ADR-0074 writer guard).
7. **No separate switch.** The split records only what a provider measured, and prices change only when an admin sets a
   modality price, which is the opt-in. A second org switch would gate nothing further.

### (c) Rate limits per model

1. **A new key.** `model_rate_limits` (migration 0230) binds a subject (user, role, team or fleet, the pillar-1 scope
   discriminant, repeated as a CHECK) to one agent registry entry: at most `maxCalls` dispatches in a sliding window of
   `windowSeconds`. Bounds are 1 to 1,000,000 calls and 1 second to 30 days, in the schema and as CHECKs. It is a
   separate table, so the MCP tool path's `rate_limits` loads, versioning and kernel stay byte-identical.
2. **Enforced at the dispatch interception point.** The one governed-dispatch core checks it after the lifecycle gate
   and before the virtual-key ceiling and any provider work, so every dispatch path (invoke, orchestration, compat
   shims, fallback hops) inherits it. Usage is counted from `usage_events` agent rows for that user and agent, on the
   database clock (indexed). A role, team or fleet limit counts each user separately, as `rate_limits` does. The first
   exhausted limit refuses; there is no summing.
3. **A clear refusal, audited.** `429 model_rate_limited`, with the count, ceiling and window in the detail. The
   refusal writes a `deny` audit row (`model-rate-limit`) naming the limit, and writes no usage row. It does not
   trigger a fallback hop (only a transport failure does).
4. **Off by default; opt-in with a step-up.** `org_settings.model_rate_limits_enabled` defaults to false. Limits may be
   written at any time but bind only once an admin turns enforcement on with
   `PUT /v1/rules/model-rate-limits/enforcement`, which needs a `settings_relax` step-up in both directions and writes
   an `org-settings-updated` audit row old -> new in the same transaction. Turning it off is recorded as a relaxation.
5. **CRUD.** Create is admin-only and audited in its transaction; it only restricts, so it needs no step-up. Delete
   removes a restriction, so it needs a `settings_relax` step-up and is audited in its transaction as a relaxation.
6. **Placement.** The controls sit in the existing Rate limits card on the Rules page (the opt-in, the form and the
   table), and the modality prices in the existing price fields of the Models page. No new section is added.

## Consequences

- A dispatch with images or audio is attributed at the prices an admin set, and the dashboard and chargeback show the
  split. Without modality data, or without modality prices, every figure is what it was.
- Admins can bound how often a subject calls one model, at the same point that enforces governance and attributes cost.
- **Disclosed limit.** As with the tool-path limits, the count is read before the dispatch and the usage row written
  after it, so concurrent dispatches by one user can overrun a limit by the number in flight.
- **Disclosed limit.** Anthropic and the OpenAI Responses API report no modality split today, so their rows carry none
  and appear under "no split" on the dashboard.

## Alternatives considered

- **A model column on `rate_limits`.** Rejected: every tool-path load, the versioning resolver and the kernel would
  have to learn to skip it, a shared-contract change across many callers for a key that never applies to a tool call.
- **Estimating modality from the request (counting images).** Rejected: pillar 5 records measured spend; an estimate
  would put an invented number on the ledger.
- **Open-source first.** No library prices LLM usage by modality against an admin-held rate card, or keys rate limits on
  a governed registry entry. The counting reuses the measured ledger; the scope logic reuses the pillar-1 memberships.
