# ADR-0020 — IDE / existing-agent interception: provider-shaped compatibility endpoints as translation shims, with an admin-selectable posture

- **Status:** Accepted
- **Date:** 2026-07-30
- **Implements:** [ROADMAP.md](../product/ROADMAP.md) **Batch H**, including its §5 decision 0
  (how far up the interception ladder RegulAIt intends to go).
- **Builds on:** [ADR-0019](0019-per-user-revocation-and-full-attribution.md) (the
  `x-regulait-project-id` header pattern, block-mode streaming suppression, per-user revocation),
  [ADR-0014](0014-role-bundled-agent-connector-grants.md) (role-bundled agent grants).

## Context

Every spec in `docs/product/` describes governing agents that come **to** our gateway. RegulAIt
governs *calls that arrive at it* — nothing enforces that a developer's IDE sends its calls here.
A developer running Cursor, Cline, Continue, Zed or Claude Code never touches the gateway, so the
governance is invisible to precisely the population it exists to cover. This is a scope hole, not
a defect.

Half the fix already shipped and was unmarketed. `POST /mcp/:serverId`
(`apps/gateway/src/mcp-proxy.ts`) is a spec-compliant streamable-HTTP MCP proxy with the full
kernel behind it — allow-lists, data scope, rate limits, approvals, audit, and (since ADR-0019)
project attribution + PII. Any MCP-capable client can point at it today. That governs **tool
calls**, arguably the higher-blast-radius half.

The actual gap was **model calls**. The gateway exposed only `POST /v1/agents/:agentId/invoke` —
our own shape, which no IDE speaks. There was no `/v1/messages` (Anthropic shape) and no
`/v1/chat/completions` (OpenAI shape), so every model completion an IDE agent made went straight
to the vendor, taking with it the spend (pillar 5), the token optimization (pillar 6), the PII
enforcement (pillar 3) and the audit trail (pillar 1).

Two forces shaped the design:

1. `executeGovernedDispatch` (`apps/gateway/src/agents-connectors.ts`) is already a reusable core
   running governance → routing → optimization → dispatch → PII → ledger. A provider-compatible
   endpoint only needs to be a **translation shim in front of it**.
2. The owner's requirement, stated plainly: *"whatever is most comprehensive — need to give
   options for the admins to choose from what to use on their end."* Every axis of interception is
   therefore configuration, not a constant we pick on the customer's behalf.

## Decision

### 1. The compatibility endpoints are TRANSLATION SHIMS over the one governed dispatch core — never a second policy path

`POST /v1/messages` (`compat-anthropic.ts`) and `POST /v1/chat/completions` (`compat-openai.ts`)
own **only** wire-format translation. Everything policy-bearing — identity, project attribution,
`evaluateAgent` entitlement, per-user revocation, tier ceiling, pillar-6 routing, PII input/output
enforcement, project budget gating, the `usage_events` ledger, the audit row — lives in
`compat-core.ts`, which calls exactly the primitives `/v1/agents/:agentId/invoke` calls and then
`executeGovernedDispatch`.

**The invariant this buys, and the reason for the separation: the compat surface can never grant
what `/v1/agents/:agentId/invoke` would deny.** It is under test — a user without a grant gets 403
through both paths, and a per-user revocation denies through both.

Compat calls are evaluated under mode `execute`. Provider wire formats carry no RegulAIt "mode",
and a completion request is an execution; a grant restricted to other modes therefore denies a
compat call, which is the same answer `/invoke` gives.

### 2. Model→agent resolution is ADMIN-SELECTABLE, with default-deny on anything unresolvable

An IDE sends `model: "claude-opus-5"`, not an agentId. All three modes ship; the admin chooses:

| Mode | Behaviour |
|---|---|
| `map_by_model` (default) | Resolve to the enabled governed agent whose `agents.model` matches the requested string. |
| `require_agent` | The caller MUST send `x-regulait-agent-id`; the model string is advisory. Missing header → **400**. |
| `router_decides` | The requested model is a **hint** the pillar-6 router may override for cost. |

**Tie-break (documented because it must be deterministic across deployments):** when several
registry rows carry the same model id, sort by **lowest `tier`**, then **oldest `createdAt`**, then
**id ascending**, and take the first. The response's `regulait.tieBreak` names how many candidates
there were and which was picked, so the choice is never invisible.

**`x-regulait-agent-id` is honoured in all three modes**, mandatory only in `require_agent`. It can
only ever narrow: the named agent still goes through `evaluateAgent` for the calling user, so
naming an agent you are not entitled to is a 403 exactly as it is at `/invoke`.

**`router_decides` must disclose what it served.** The response's top-level `model` always names
the model actually served (never the requested one), the same value rides the
`x-regulait-served-model` response header and the `regulait.servedModel` body field, and the audit
row records `resolution.requestedModel` **and** `resolution.servedModel`. A routing override also
writes the usual `model_routing` row into the pillar-6 cost-events ledger, so intercepted traffic
shows up in the savings-by-technique chart with no further work.

**THE INVARIANT, non-negotiable and under test: an unresolvable or unmapped model is DEFAULT-DENY
(403), never a silent pass-through to the vendor.** That holds in every mode, and no
`usage_events` row is written because nothing reached a provider. Passing an ungoverned call
through would defeat the entire purpose of intercepting.

### 3. New interception surfaces are OFF by default and answer 404 when disabled

Migration **0037** adds a single-row `interception_settings` table (fixed primary key `'singleton'`
plus a CHECK constraint, so a second row is a database error rather than a silent second policy):

| Column | Default | Meaning |
|---|---|---|
| `anthropic_compat_enabled` | **false** | `POST /v1/messages` exists at all |
| `openai_compat_enabled` | **false** | `POST /v1/chat/completions` exists at all |
| `mcp_interception_enabled` | **true** | `POST /mcp/:serverId` — already shipped, already governed |
| `resolution_mode` | `map_by_model` | see §2 |
| `enforcement_posture` | `voluntary` | see §4 |
| `require_project_attribution` | **false** | reject an unattributed compat call rather than run it |
| `updated_by`, `created_at`, `updated_at` | — | provenance |

Default-deny posture: a new arrival surface is something an admin opts **into**. A disabled surface
returns Fastify's own 404 body (`{message: "Route POST:/v1/messages not found", error: "Not Found",
statusCode: 404}`) rather than a 501 — we do not advertise a surface the admin turned off. The gate
runs in the **onRequest** phase, before authentication, so the surface's existence does not leak via
a 401 either.

`GET`/`PUT /v1/interception/settings` are **admin-only** (deliberately absent from
`NON_ADMIN_ROUTES`), and every write is audited (`objectType: "interception_settings"`,
`ruleId: "interception-settings-updated"`, with the changed keys in the detail). The two compat
endpoints themselves **are** in `NON_ADMIN_ROUTES` — they are the developer's path, exactly like
the MCP proxy; their governance is the entitlement check inside the shim, not admin-ness.

`require_project_attribution` is the admin's lever to guarantee pillar-5 coverage: when true, a
compat call with no `x-regulait-project-id` is rejected (400 `project_attribution_required`) rather
than run as untracked spend. It is off by default because several clients cannot send custom
headers on model calls.

### 4. Enforcement posture is DECLARED by the admin, and the product states plainly which rungs are honor-system

`enforcement_posture` records which rung of Batch H's interception ladder the organisation says it
is on. It is **descriptive, not enforcing** — it changes what the admin portal tells you, nothing
else — and the portal says so:

| Rung | Bypassable? | What the UI says |
|---|---|---|
| `observe` | n/a — no enforcement | Telemetry only. Nothing stops a developer calling the vendor directly. |
| `voluntary` | trivially | **Honor system.** A developer points their IDE here and can point it straight back. |
| `managed` | developer can undo locally | Pushed via IDE policy / managed settings / MDM. Reversible on the developer's machine. |
| `key_custody` | **no — no key, no call** | **Non-bypassable.** The org never issues raw vendor keys. Almost entirely IT policy, not product code. |
| `network` | **no** | **Non-bypassable.** RegulAIt is the only sanctioned egress. An infrastructure project; belongs with BYOC. |

The honest framing is part of the decision: RegulAIt's code buys the *voluntary* rung. Key custody
and network egress — the two non-bypassable rungs — are the customer's IT policy and network, not
ours. The product says that in the admin UI and in `docs/product/IDE_INTEGRATION.md` rather than
implying universal enforcement.

### 5. The supported request-field subset is documented, and everything outside it fails loudly

A dropped `tool_choice` would change what the model does without the caller ever learning — the
opposite of a governance product's job. So an unsupported field is a **400 naming the field**, never
a silent shrug. `ModelDispatchRequest` is the boundary: a field it cannot carry is a field we will
not pretend to honour.

**Amended after first deployment — a third tier: accepted but not honoured.** The strict two-tier
rule had a false positive that mattered. IDE clients send `temperature` on every request from a
settings default the developer never consciously chose, so a 400 bounced the entire call over a
field nobody meaningfully asked for — rejecting it protected nothing while blocking the very
interception this ADR exists to enable. `temperature` is now accepted and ignored.

The honesty requirement did not disappear, it **moved**: an ignored field is reported back on the
`x-regulait-ignored-fields` response header *and* recorded on the audit row, so "the caller asked
for this and we did not apply it" stays a fact both the client and an auditor can see. That is the
distinction that matters — accept-and-**disclose** is not the silent drop this decision forbids.

The tier is deliberately narrow: a field qualifies only when ignoring it cannot change whether an
output is safe, governed, priced or attributed. `temperature` nudges sampling. `tool_choice` and
`thinking` change what the model is *able to do*, so they could never join the ignore tier — they
stayed a 400 until they earned real mappings (see the 2026-07-31 amendment below). `top_p`/`top_k`/
`stop_sequences` are arguably the same class as `temperature` and were left rejected only because
`temperature` alone was observed causing the problem; widening the tier is one line if a real client
trips over them.

**Amended 2026-07-31 — the long tail moves to HONOURED, one real mapping at a time.**
`tool_choice`, OpenAI `response_format` (structured outputs) and Anthropic `thinking` moved from
the rejected tier to the supported tier. Per the standing rule, none of them entered the
accept-and-ignore tier (that tier stays exactly `temperature`): each is honoured with a real
end-to-end mapping through `ModelDispatchRequest` into every adapter that can express it —

- `tool_choice` → neutral `toolChoice: "auto" | "none" | "required" | {name}`; Anthropic
  `{type: auto|none|any|tool}`, OpenAI/xAI `"auto"|"none"|"required"|{type:function,…}`, Google
  `functionCallingConfig` `AUTO|NONE|ANY` (+`allowedFunctionNames` for a named tool), mock
  observably. A named tool absent from the request's own `tools` list is a 400; unmappable
  variants (`disable_parallel_tool_use: true`, unknown types) still 400 naming the exact variant.
- `response_format` → neutral `responseFormat` (`json_object` / `json_schema`; `text` maps to
  absent — it *is* the default). OpenAI/xAI native passthrough (chat completions and the
  Responses surface's `text.format`), Google `responseMimeType`/`responseSchema`, mock echo.
  **The Anthropic adapter deliberately has NO mapping**: the Messages API offers no native
  structured-output mechanism, a system-prompt suffix cannot *guarantee* valid JSON the way
  OpenAI's json mode does, and a forced-single-tool emulation reshapes the response (tool_use
  instead of text; breaks text-delta streaming) — neither is faithful, so an OpenAI-shaped
  request carrying `response_format` that resolves to an Anthropic-provider agent is a **400
  naming the field and the provider**. Each surface honours what its dialect + the served
  provider can really express; the asymmetry is documented, not papered over.
- `thinking` → neutral `thinking: {budgetTokens}` (Anthropic `{type:"enabled", budget_tokens}`;
  `{type:"disabled"}` is a real mapping onto absent). Anthropic adapter only (plus mock):
  real parameter, `thinking`/`redacted_thinking` blocks surfaced first in the response with
  signatures intact, round-tripped through assistant-turn history, and streamed with vendor
  framing (`thinking_delta` / `signature_delta` in their own content block before the text
  block). On any other provider the request is a 400 naming the field — never silently dropped.
  Usage honesty: thinking tokens are output tokens in Anthropic's own accounting, so
  `usage.outputTokens` (and the measured ledger) carries them unchanged.

**`POST /v1/messages` (Anthropic shape)**

- Supported top-level: `model`, `messages`, `system`, `max_tokens`, `stream`, `tools`,
  `tool_choice` *(2026-07-31)*, `thinking` *(2026-07-31)*.
- Supported content blocks: `text`, `image` (base64 source), `document` (base64 source),
  `tool_use`, `tool_result` (string content or an array of text parts), and — on **assistant**
  turns only — `thinking` / `redacted_thinking` *(2026-07-31: a prior response replayed into
  history, round-tripped natively with signature intact)*.
- `system` accepts a string or an array of text blocks; a `cache_control` marker on a system block
  is a **real mapping** onto pillar-6 prompt caching (`cacheSystem`), not a dropped field.
- Accepted but not honoured (disclosed via `x-regulait-ignored-fields` + audit row): `temperature`.
- Rejected with a 400 naming the field: `top_p`, `top_k`, `stop_sequences`,
  `metadata`, `service_tier`, `container`, `mcp_servers` and any other
  unknown top-level key; content blocks of any other type (`server_tool_use`, …) and
  `thinking`/`redacted_thinking` blocks on non-assistant turns; non-`base64` image/document
  sources (url/file/text); per-message `cache_control`; non-`custom` tool types; roles other than
  `user`/`assistant`; `tool_choice.disable_parallel_tool_use: true` and unknown
  `tool_choice`/`thinking` variants (named exactly).
- `anthropic-version` and other protocol headers are accepted and ignored — they negotiate wire
  protocol, not model behaviour.

**`POST /v1/chat/completions` (OpenAI shape)**

- Supported top-level: `model`, `messages`, `stream`, `tools`, `max_tokens`,
  `max_completion_tokens`, `tool_choice` *(2026-07-31)*, `response_format` *(2026-07-31)*.
- Supported roles: `system` and `developer` (hoisted, in order, into the dispatch's out-of-band
  `system` field), `user`, `assistant` (including `tool_calls`), `tool` (mapped to a user turn
  carrying one `tool_result` block).
- Supported user content parts: `text`, and `image_url` when the URL is a base64 `data:` URI.
- Accepted but not honoured (disclosed via `x-regulait-ignored-fields` + audit row): `temperature`.
- Rejected with a 400 naming the field: `top_p`, `n`, `stop`, `presence_penalty`,
  `frequency_penalty`, `logit_bias`, `logprobs`, `seed`, `thinking`,
  `parallel_tool_calls`, `stream_options`, `reasoning_effort`, `store`, `metadata`, `user` and any
  other unknown top-level key; remote (`https://`) image URLs; non-`function` tool types; unknown
  roles; unknown `tool_choice`/`response_format` variants (named exactly); `response_format` on a
  request whose served agent dispatches to a provider with no native structured-output mechanism
  (Anthropic — see the amendment above).

Errors are returned in the **provider's own error envelope** (`{type:"error",error:{…}}` /
`{error:{…}}`) with the RegulAIt code preserved as `regulait_code`, so an IDE renders a governance
denial as an error rather than a parse failure.

### 6. Streaming honours ADR-0019 block-mode suppression, and opens lazily

`stream: true` emits a real provider SSE sequence fed by the existing `onText` callback —
`message_start` / `content_block_start` / `content_block_delta` (`text_delta`) /
`content_block_stop` / `message_delta` / `message_stop` for Anthropic, `chat.completion.chunk`
frames terminated by `data: [DONE]` for OpenAI.

ADR-0019's suppression is **reused, not re-derived**: if the attributed project's PII mode is
`block`, the call does not stream at all — the same governed dispatch runs fully buffered and
returns ordinary JSON, disclosed via `regulait.streamingSuppressed` and the
`x-regulait-streaming-suppressed` header.

The stream also opens **lazily** — nothing is hijacked until the first delta — so a denial raised
inside the dispatch (PII input block, project budget gate) still returns a proper HTTP error status
instead of a 200 that carries a failure.

### 7. `x-api-key` is accepted on `/v1/messages` only

Anthropic clients send the key in `x-api-key`, so an `ANTHROPIC_BASE_URL`-based tool would
otherwise be unable to authenticate unmodified. This is the **same RegulAIt API key** resolved by
the **same `authenticate()`** — a second header name, never a second credential or a weaker path.
A bogus `x-api-key` is still a 401. `Authorization: Bearer` continues to work identically on both
surfaces.

## Consequences

**Easier.** Any client that accepts a custom Anthropic- or OpenAI-compatible base URL becomes a
governed RegulAIt client with no client-side code. Every completion it makes is instantly
attributed (pillar 5), optimizable (pillar 6), PII-checked (pillar 3) and audited (pillar 1) — the
existing pillars pay off retroactively over traffic they previously never saw. The MCP half, which
already worked, is now documented and has an admin-facing config generator.

**Harder / given up.**

- The compatibility surface has a long tail we deliberately do **not** cover: ~~thinking blocks,
  prompt-caching headers beyond the system mapping, `tool_choice`, sampling parameters, structured
  outputs~~. Widening the subset is incremental follow-up work, one field at a time, each with a real
  mapping. `temperature` was the first amendment (see §5) — accepted-and-disclosed rather than
  rejected, because a 400 there blocked real clients without protecting anything. *(Amended
  2026-07-31: `tool_choice`, `response_format` and `thinking` are now honoured with real mappings —
  see §5. The remaining uncovered tail is sampling parameters (`top_p`/`top_k`/`stop_sequences`),
  prompt-caching beyond the system mapping, and Anthropic-side structured outputs, which stays a
  documented 400 by decision rather than omission.)*
- Two more entry points now share the singleton posture row. A misconfigured `resolution_mode`
  affects both surfaces at once; there is no per-role or per-project override yet (ROADMAP notes
  one as plausible, mirroring migration 0026's rule scoping — deferred).
- `map_by_model` requires an admin to register a registry agent per model id they want IDEs to be
  able to name. That is the intended friction: an unregistered model is denied.

**Doc debt this closes and creates.** `CLAUDE.md` and `VISION.md` promise governance over "every
agent/model, connector, and MCP-server-tool call", written on the assumption that calls arrive at
our gateway. This ADR makes the interception story explicit but does **not** make that claim
literally true: at the `voluntary` rung it remains an honor system, and Copilot/Eclipse are not
covered at all. **That wording still needs restating as an explicit interception story with a named
target rung — flagged here, not edited.**

**Follow-up not taken in this batch.** OTel ingestion (the `observe` rung), per-role/per-project
resolution-mode overrides, and any code for the `key_custody` or `network` rungs (both are policy
and infrastructure, not gateway code).

## Files

- `packages/db/migrations/0037_interception_settings.sql`, `packages/db/src/schema.ts`
- `packages/shared/src/index.ts` (`updateInterceptionSettingsSchema`, resolution/posture enums)
- `apps/gateway/src/compat-core.ts` (governed core, settings endpoints)
- `apps/gateway/src/compat-anthropic.ts`, `apps/gateway/src/compat-openai.ts` (shims)
- `apps/gateway/src/app.ts` (interception gate, `x-api-key` alias, `NON_ADMIN_ROUTES`)
- `apps/gateway/src/admin-portal.ts` (the **Client Access** tab, under Identity & Access)
- `apps/gateway/src/ide-interception.test.ts` (40 e2e tests)
- `docs/product/IDE_INTEGRATION.md`
