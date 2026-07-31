# Connecting an IDE / existing coding agent to RegulAIt

> Implements [ROADMAP Batch H](ROADMAP.md); the decisions behind it are
> [ADR-0020](../decisions/0020-ide-interception-compat-endpoints.md) and
> [ADR-0024](../decisions/0024-interception-depth-metering-scope-custody.md).
>
> **Read the honest framing first.** RegulAIt governs *calls that arrive at it*. Nothing in this
> document makes a developer's IDE send its calls here. What it makes possible is that when they
> do, every model call and every tool call is entitlement-checked, cost-attributed, PII-enforced,
> optimizable and audited. Whether that is a request or a requirement is decided by which ladder
> rung you actually enforce: `key_custody` can be **enforced by this deployment** (a toggle,
> ADR-0024), `network` is enforced at **your network boundary** (see
> [the network rung](#the-network-rung-egress-control-at-your-boundary)), and everything below
> those is policy or honor system. See [The enforcement ladder](#the-enforcement-ladder).

---

## The two halves, and what each one covers

There are **two independent interception paths**. Enabling one does not cover the other.

| Path | Endpoint | What it governs | Ships since |
|---|---|---|---|
| **Tool calls** | `POST /mcp/:serverId` | MCP tool calls — file writes, repo access, DB queries, anything an MCP server exposes. Allow-lists, read/write data scope, rate limits, approvals, audit, project attribution, PII on arguments and results. | already shipped (ADR-0019) |
| **Model calls** | `POST /v1/messages`, `POST /v1/chat/completions` | Model completions. Entitlement, tier ceiling, per-user revocation, project attribution and budget, PII input/output, pillar-6 optimization, measured usage ledger, audit. | ADR-0020 |

Concretely:

- MCP path only → you govern what the agent **does** (its tools), not what it **says** or what it
  **costs**.
- Compat path only → you govern what the agent **costs** and what it **sends/receives**, not the
  tools it reaches for.
- Both → the developer's whole session is governed.

---

## Turning it on (admin)

Everything below is in the admin portal under **Identity & Access → Client Access**, or via
`GET`/`PUT /v1/interception/settings` (admin-only; every write is audited).

| Setting | Default | What it does |
|---|---|---|
| `anthropicCompatEnabled` | **off** | Exposes `POST /v1/messages` (Anthropic Messages shape). |
| `openaiCompatEnabled` | **off** | Exposes `POST /v1/chat/completions` (OpenAI Chat Completions shape). |
| `mcpInterceptionEnabled` | **on** | Exposes `POST /mcp/:serverId`. |
| `resolutionMode` | `map_by_model` | How an IDE's `model` string resolves onto a governed agent. |
| `enforcementPosture` | `voluntary` | Which ladder rung you declare you are on. The portal labels each rung with its **real** status — honor system / policy / enforced / declared-but-not-enforced. |
| `requireProjectAttribution` | **off** | Reject a compat call with no `x-regulait-project-id` rather than run it unattributed. |
| `requireMcpAttribution` | **off** | The MCP twin: reject an MCP tool call with no `x-regulait-project-id` rather than run it into the Unattributed bucket. |
| `keyCustodyEnforced` | **off** | Make the `key_custody` rung real: per-user BYO model credentials 409 and are skipped at dispatch — org/platform credentials only. Reversible. |

**Both compat surfaces are OFF by default.** A new arrival surface is something you opt into. While
off, the endpoint returns an ordinary 404 — indistinguishable from a route that does not exist. We
do not advertise a surface you turned off.

### Staged rollout — per-scope overrides (ADR-0024)

The singleton does not have to flip org-wide. **Scope rules**
(`/v1/interception/scope-rules`, or Client Access → Staged rollout) override
`anthropicCompatEnabled`, `openaiCompatEnabled` and `resolutionMode` for one **user**, one
**project** (matched from the request's `x-regulait-project-id` header), or one **role**. Any
field left as *inherit* falls through.

- **Precedence:** `user > project > role > org singleton` — the first non-inherit value **per
  field** wins, each field independently. Ties within one kind (a user holding two roles whose
  rules disagree) go to the **most recently created** rule.
- **A surface disabled by resolution answers the same indistinguishable 404** as one disabled
  org-wide, and a caller without valid credentials always resolves at the org level — scope
  rules are not detectable from outside.
- **Surface exposure is NOT entitlement.** A rule enabling a surface for a role grants nothing:
  every dispatch still runs the same per-user entitlement check (`evaluateAgent`), so an
  unentitled user on an enabled surface is still a 403.
- The Client Access tab includes a **live effective-value preview** for a chosen user (and
  optional project) — it runs the exact resolver the request gate runs.

### Model → agent resolution

An IDE sends `model: "claude-opus-5"`, not a RegulAIt agent id. Pick the mode that fits your
organisation:

| Mode | Behaviour | Suits |
|---|---|---|
| `map_by_model` | Resolves to the enabled governed agent whose model id matches the requested string. If several match: **lowest tier**, then **oldest**, then id — and the response names which was picked and how many candidates there were. | Least developer friction. The sensible default. |
| `require_agent` | The caller **must** send `x-regulait-agent-id`; the model string is advisory. Missing header → 400. | Strictest; explicit attribution per call. |
| `router_decides` | The requested model is a **hint** the pillar-6 router may override for cost. | Maximum optimization. |

In every mode:

- `x-regulait-agent-id`, when supplied, wins — but it can only ever **narrow**. The named agent
  still goes through the normal entitlement check, so naming an agent you are not entitled to is a
  403.
- **An unmapped or unresolvable model is a 403, never a pass-through to the vendor.** No usage row
  is written, because nothing reached a provider. This is the invariant the whole feature rests on.
- **`router_decides` always discloses what it served.** The response's `model` field is the model
  actually served (never the requested one); the same value rides `x-regulait-served-model`, and
  the audit row records requested-vs-served. A different model is never served silently.

### Attribution and metering (pillar 5) — the true coverage statement

**Every gateway call is metered. Attribution determines *where* the cost lands.** A call carrying
`x-regulait-project-id` bills its project; a call without one — model or MCP tool alike — still
writes the same usage/pricing row, with a NULL project, and rolls up in the explicit
**"Unattributed" bucket** (`GET /v1/costs/unattributed`; Cost & Projects → Unattributed spend).
The bucket is visible and labeled on purpose: an admin has to see the attribution leak to decide
to close it. An unattributed row can never count against any project budget, and no project's
numbers include it.

Send `x-regulait-project-id: <uuid>` — the same header on both the compat surfaces and the MCP
proxy. The project is validated exactly as the invoke path validates `projectId`: a malformed id
is a 400, a project you may not bill to is a 403.

Two admin toggles close the unattributed gap **entirely** for deployments that want the
guarantee rather than the visibility:

- `requireProjectAttribution` **on** → a compat call without the header is rejected outright
  (400 `project_attribution_required`) instead of running as unattributed spend. Only enable it
  for clients that can send custom headers on model calls (see the coverage matrix).
- `requireMcpAttribution` **on** → an MCP call without the header is rejected pre-dispatch
  (400 `mcp_attribution_required`, audited). MCP clients set the header once on the transport,
  so this one is safe for any MCP-capable client.

---

## The enforcement ladder

`enforcementPosture` records which rung you are on, and since ADR-0024 the product labels each
rung with its **real** status — the API returns a computed `posture` object beside the settings
row, and the Client Access tab renders from it, so the portal can never imply enforcement that
does not exist.

| Rung | Mechanism | Bypassable? | Status the product shows |
|---|---|---|---|
| `observe` | Ingest the OpenTelemetry the IDEs already emit | n/a — no enforcement | **Honor system** |
| `voluntary` | The developer points their IDE at RegulAIt | **trivially** | **Honor system** |
| `managed` | Admin pushes IDE policy / managed settings / MDM env vars | developer can undo locally | **Policy** |
| `key_custody` | The org never issues raw provider keys, only RegulAIt keys | **no — no key, no call** (when enforced) | **ENFORCED by this deployment** when `keyCustodyEnforced` is on; otherwise **DECLARED but NOT enforced**, with a warning |
| `network` | RegulAIt is the only sanctioned egress to the vendor APIs | **no** | **Requires egress control at your network boundary — see below** |

Stated plainly, because an enterprise buyer will ask:

- **`observe` and `voluntary` are honor systems.** Nothing stops a developer from pointing their
  IDE back at the vendor. If someone asks what prevents that at these rungs, the honest answer is:
  nothing.
- **`key_custody` is the cheapest non-bypassable answer — and this deployment can enforce it.**
  With `keyCustodyEnforced` on: per-user BYO model credentials are refused (409, audited) and
  dispatch resolution skips any stored user credential — the org's platform credentials are the
  only way to a vendor *through this gateway*. Existing user credential rows are kept inert, not
  deleted, so the toggle is reversible. Declaring `key_custody` **without** the toggle is a
  statement, not a mechanism, and the portal says so with a warning. Note the honest limit: this
  governs credentials *this gateway* holds and uses; a developer with a personally-obtained
  vendor key can still call the vendor directly — stopping that is the network rung.
- **`network` is the airtight answer and is a genuine infrastructure project.** It is enforced at
  your network boundary, never by this product — the recipe follows.

### The network rung — egress control at your boundary

This is **documentation of an infrastructure-level control, not product code** — RegulAIt cannot
firewall your network for you, and does not pretend to. The rung is real when your egress policy
makes the RegulAIt gateway the only route to the model vendors:

1. **Default-deny egress** from developer workstations / build agents / agent runtimes to the
   public internet, or at minimum to the AI-vendor API domains.
2. **Block the vendor APIs directly** at your egress proxy / firewall / DNS policy — e.g.
   `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, `api.x.ai`, and
   any regional/vendor equivalents your registry uses (the same provider list your Model
   Credentials page shows).
3. **Allow exactly the RegulAIt gateway** origin (your deployment's base URL) — that is where
   `ANTHROPIC_BASE_URL`-style overrides and the MCP proxy already point (see
   [Per-client setup](#per-client-setup)).
4. The **gateway host itself** (or its BYOC VPC) is the one place allowed to reach the vendor
   APIs — it holds the org credentials (pair this with `keyCustodyEnforced`) and applies
   governance, attribution and audit to everything that passes.
5. Verify from a developer machine: a direct `curl https://api.anthropic.com/v1/messages` must
   fail at the network layer while the same call against the gateway succeeds — that difference
   *is* the rung.

Pairing `network` + `key_custody_enforced` is the airtight combination: no raw key to use, and
nowhere to use one. In BYOC/air-gapped deployments (pillar 3) the allowlist belongs in the same
egress controls the deployment mode already requires.

---

## Per-client setup

The admin portal's **Client Access → Connect a client** generator emits these snippets with this
deployment's own base URL, MCP server id and project id filled in. Use it rather than
hand-editing. Below, `BASE` is your RegulAIt origin (e.g. `https://regulait.example.com`).

Two URL conventions matter and are easy to get wrong:

- **Anthropic clients** take the **origin** and append `/v1/messages` themselves →
  `ANTHROPIC_BASE_URL=BASE`
- **OpenAI clients** take a base ending in `/v1` and append `/chat/completions` →
  `BASE/v1`

Issue each developer their **own** RegulAIt API key (Identity & Access → Users → issue key). Never
hand out a shared or admin key — entitlement, attribution and the audit trail are all per-user.

### Claude Code

```sh
# Model calls -> RegulAIt (Anthropic-shaped)
export ANTHROPIC_BASE_URL="BASE"
export ANTHROPIC_API_KEY="<the developer's RegulAIt key>"
export ANTHROPIC_CUSTOM_HEADERS="x-regulait-project-id: <PROJECT_ID>"

# Tool calls -> RegulAIt (governed MCP proxy)
claude mcp add --transport http regulait BASE/mcp/<MCP_SERVER_ID> \
  --header "Authorization: Bearer <KEY>" --header "x-regulait-project-id: <PROJECT_ID>"
```

Claude Code sends the key as `x-api-key`; `POST /v1/messages` accepts that header name for exactly
this reason. It is the same key and the same authentication path as `Authorization: Bearer`.

### Cursor

Settings → Models → override the OpenAI base URL:

```
Base URL:  BASE/v1
API key:   <the developer's RegulAIt key>
Model:     <a model id registered on a governed agent>
```

MCP, in `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "regulait": {
      "url": "BASE/mcp/<MCP_SERVER_ID>",
      "headers": {
        "Authorization": "Bearer <KEY>",
        "x-regulait-project-id": "<PROJECT_ID>"
      }
    }
  }
}
```

Cursor sends no custom headers on **model** calls — with `requireProjectAttribution` on, its
completions would be rejected. Attribute its **tool** calls via the MCP header instead.

### Cline / Roo Code

API Provider → **OpenAI Compatible**, Base URL `BASE/v1`, API key, Model ID. Or API Provider →
**Anthropic** with a custom base URL of `BASE`. Enable whichever surface matches the provider you
pick. MCP config uses the same JSON shape as Cursor's above.

### Continue

```yaml
models:
  - name: regulait
    provider: openai
    model: <model id>
    apiKey: <KEY>
    apiBase: BASE/v1
```

For the Anthropic shape use `provider: anthropic` and `apiBase: BASE`.

### Zed

```json
{
  "language_models": {
    "anthropic": { "api_url": "BASE" },
    "openai":    { "api_url": "BASE/v1" }
  },
  "context_servers": {
    "regulait": { "source": "custom", "url": "BASE/mcp/<MCP_SERVER_ID>" }
  }
}
```

The API key is entered in Zed's agent panel. Zed cannot attach custom headers to model calls —
leave `requireProjectAttribution` off for it.

### Generic Anthropic-compatible

```sh
curl BASE/v1/messages \
  -H "x-api-key: <KEY>" \
  -H "x-regulait-project-id: <PROJECT_ID>" \
  -H "content-type: application/json" \
  -d '{"model":"<model id>","max_tokens":256,"messages":[{"role":"user","content":"hello"}]}'
```

### Generic OpenAI-compatible

```sh
curl BASE/v1/chat/completions \
  -H "Authorization: Bearer <KEY>" \
  -H "x-regulait-project-id: <PROJECT_ID>" \
  -H "content-type: application/json" \
  -d '{"model":"<model id>","messages":[{"role":"user","content":"hello"}]}'
```

---

## Honest coverage matrix

**"Works with every IDE" would be a false claim.** What is true: any client that accepts a custom
Anthropic- or OpenAI-compatible base URL can have its model calls governed here, and any
MCP-capable client can have its tool calls governed here.

| Client | Model calls | Tool calls (MCP) | Custom headers |
|---|---|---|---|
| Claude Code | `ANTHROPIC_BASE_URL` → `/v1/messages` | yes (`claude mcp add` / `.mcp.json`) | yes |
| Cursor | OpenAI-compatible base URL | yes (`.cursor/mcp.json`) | MCP only |
| Cline | OpenAI- or Anthropic-compatible base URL | yes | MCP only |
| Roo Code | OpenAI- or Anthropic-compatible base URL | yes | MCP only |
| Continue | `apiBase` override | yes | MCP only |
| Zed | `language_models` `api_url` override | yes (context servers) | MCP only |
| VS Code (built-in MCP) | not applicable | yes | yes |
| **GitHub Copilot** | **not supported** — largely locked down; its enterprise proxy path or nothing | not via this proxy | n/a |
| **Eclipse** | **no first-party agent of note**; the ecosystem is third-party plugins, each with its own (often absent) configurability | varies by plugin | n/a |

---

## What is and is not governed on each path

**On `POST /mcp/:serverId` (tool calls)** — governed: per-user tool-level allow-lists, read/write
data scope, rate limits, approval gating, full audit, project attribution, PII enforcement on tool
arguments and results, per-call pricing into the usage ledger. Not governed: the model completion
that decided to call the tool (that is the other path).

**On `POST /v1/messages` and `POST /v1/chat/completions` (model calls)** — governed: agent
entitlement (direct grants, role-bundled grants, per-user revocations, tier ceiling, declared
modes), project attribution and membership, project budget gating before any provider work, PII
input block (pre-call, no cost) and output bill-and-withhold, pillar-6 routing / prompt caching
where applicable, measured token + cost ledger, one audit row per call recording requested-vs-served.
Not governed: tools the agent runs locally in the IDE without going through an MCP server (file
edits, shell commands) — those are outside any gateway's reach and are an MCP-adoption question,
not a model-endpoint one.

---

## Supported request fields, and what fails loudly

RegulAIt **will not silently drop a field that changes what the model does** — a dropped
`tool_choice` or `thinking` would alter the completion without the caller ever learning. Fields fall
into three tiers:

| Tier | Behaviour |
|---|---|
| **Supported** | honoured normally |
| **Accepted but not honoured** | request succeeds; the field is reported back in the `x-regulait-ignored-fields` response header **and** recorded on the audit row |
| **Rejected** | **400 naming the field**, in the provider's own error envelope |

The middle tier is deliberately narrow. A field qualifies only when ignoring it cannot change
whether an output is safe, governed, priced or attributed. Today it contains exactly one entry:

- **`temperature`** — IDE clients (Cursor, Continue, Cline) send it on every request from a settings
  default the developer never consciously chose, so a 400 bounced the whole call over a field nobody
  meaningfully asked for. Rejecting it protected nothing and blocked the interception this feature
  exists to enable. It nudges sampling; it cannot make an ungoverned action possible.

`tool_choice`, `response_format` and `thinking` could never join that tier — they change what the
model is *able to do*, not merely how it samples. Since 2026-07-31 (ADR-0020 §5 amendment) they are
**supported** instead, each with a real end-to-end mapping into every provider adapter that can
express it. One consequence to know about: a field can be valid in the endpoint's dialect yet
un-honourable by the **served** agent's provider (resolution — including `router_decides` — picks
the agent). That mismatch is a **400 naming the field and the provider**, never a silent drop:

- `thinking` is honoured on Anthropic-provider (and mock) agents only.
- `response_format` is honoured on OpenAI-, xAI-, Google- and mock-provider agents. **The Anthropic
  adapter deliberately has no mapping** — the Messages API offers no native structured-output
  mechanism, and a system-prompt nudge is not a guarantee, so RegulAIt refuses rather than
  pretends. Each surface honours what its dialect and the served provider can really express; this
  asymmetry is a decision, documented here and in ADR-0020.
- `tool_choice` maps on all four real providers (Anthropic `{type:auto|none|any|tool}`,
  OpenAI/xAI `auto|none|required|{type:function,…}`, Google `functionCallingConfig`
  `AUTO|NONE|ANY`+`allowedFunctionNames`) and the mock.

**`POST /v1/messages`**

- Supported: `model`, `messages`, `system`, `max_tokens`, `stream`, `tools`, `tool_choice`,
  `thinking`; content blocks `text`, `image` (base64), `document` (base64), `tool_use`,
  `tool_result`, plus `thinking`/`redacted_thinking` on **assistant** turns (a prior response
  replayed into history — round-tripped natively, signature intact). A `cache_control` marker on a
  **system** block maps onto pillar-6 prompt caching. `thinking: {type:"enabled", budget_tokens}`
  returns thinking blocks first in the response and streams them as vendor-framed
  `thinking_delta`/`signature_delta` blocks; `{type:"disabled"}` maps to absent. Thinking tokens
  are billed as output tokens (Anthropic's own accounting) and land unchanged in the measured
  ledger.
- Accepted but not honoured: `temperature`.
- Rejected: `top_p`, `top_k`, `stop_sequences`, `metadata`, `service_tier`, `container`,
  `mcp_servers`, any other unknown top-level key; unknown block types; `thinking` blocks on
  non-assistant turns; non-base64 image/document sources; per-message `cache_control`;
  non-`custom` tool types; roles other than `user`/`assistant`; `tool_choice` naming a tool absent
  from the request's `tools` list; `tool_choice.disable_parallel_tool_use: true` and any unknown
  `tool_choice`/`thinking` variant (the 400 names the exact variant); `thinking` when the served
  agent's provider has no mapping.
- `anthropic-version` and similar protocol headers are accepted and ignored.

**`POST /v1/chat/completions`**

- Supported: `model`, `messages`, `stream`, `tools`, `max_tokens`, `max_completion_tokens`,
  `tool_choice`, `response_format` (`text` = the default, `json_object`, `json_schema`); roles
  `system`/`developer` (hoisted into the dispatch's system field), `user`, `assistant` (with
  `tool_calls`), `tool`; user content parts `text` and `image_url` with a base64 `data:` URI.
- Accepted but not honoured: `temperature`.
- Rejected: `top_p`, `n`, `stop`, `presence_penalty`, `frequency_penalty`, `logit_bias`, `logprobs`,
  `seed`, `thinking`, `parallel_tool_calls`, `stream_options`,
  `reasoning_effort`, `store`, `metadata`, `user`, any other unknown top-level key; remote image
  URLs; non-`function` tool types; unknown roles; `tool_choice` naming a tool absent from the
  request's `tools` list; unknown `tool_choice`/`response_format` variants (the 400 names the
  exact variant); `response_format` when the served agent's provider is Anthropic (see above).

**`top_p`, `top_k` and `stop_sequences` are still a 400.** They are the same *class* of field as
`temperature` and some clients send them unconditionally too; they were left rejected because only
`temperature` was observed causing the problem. If a client in your fleet trips over one, widening
the accept-and-ignore tier is a one-line change — the disclosure machinery already covers it.

---

## Streaming

`stream: true` emits a real provider SSE sequence — `message_start` / `content_block_start` /
`content_block_delta` / `content_block_stop` / `message_delta` / `message_stop` for the Anthropic
shape, `chat.completion.chunk` frames terminated by `data: [DONE]` for the OpenAI shape.

**A project whose compliance cascade sets PII mode `block` does not stream.** The output PII check
can only run once the full text exists, so streaming it would flash raw model output before the
check could withhold it. Instead the same governed dispatch runs fully buffered and returns ordinary
JSON, disclosed via `regulait.streamingSuppressed` and the `x-regulait-streaming-suppressed`
header. This is ADR-0019's rule, applied unchanged.

---

## Troubleshooting

| Symptom | Meaning |
|---|---|
| 404 on `/v1/messages` or `/v1/chat/completions` | The surface is disabled. An admin enables it in Client Access. |
| 401 | Bad or revoked RegulAIt API key. |
| 403 `model_not_mapped` | No enabled governed agent carries that model id. Register one, or switch to `require_agent`. |
| 403 `agent_denied` | The caller is not entitled to the resolved agent (no grant, revoked, above their tier ceiling, or the mode is not declared). |
| 403 `not_a_project_member` | The `x-regulait-project-id` names a project this user may not bill to. |
| 400 `agent_header_required` | Resolution mode is `require_agent`; send `x-regulait-agent-id`. |
| 400 `project_attribution_required` | `requireProjectAttribution` is on; send `x-regulait-project-id`. |
| 400 `mcp_attribution_required` | `requireMcpAttribution` is on; set `x-regulait-project-id` on the MCP transport. |
| 400 naming a field | That field is outside the supported subset — see above. |
| 403 `pii_blocked` | The request text tripped the project's PII policy before any provider call. No cost was incurred. |
| 409 `no_model_credential` | The served agent's provider has no stored or environment credential. |
| 409 `key_custody_enforced` | This deployment enforces key custody — per-user BYO credentials cannot be created or updated; dispatches use the org/platform credential. |
