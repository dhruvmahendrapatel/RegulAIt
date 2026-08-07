# ADR-0066: Gateway parity — model discovery, virtual keys, per-key ceilings, and provider fallback

- **Status**: Accepted
- **Date**: 2026-08-07
- **Relates to**: [ADR-0020](0020-ide-interception-compat-surfaces.md) and
  [ADR-0024](0024-openai-compat-surface.md) (the two provider-shaped compat shims this builds on),
  [ADR-0016](0016-real-model-dispatch.md) (`executeGovernedDispatch`, the one dispatch core),
  [ADR-0019](0019-per-user-revocations.md) and
  [ADR-0014](0014-roles-as-provisioning-bundles.md) (the entitlement inputs re-evaluated per hop),
  [ADR-0062](0062-mode-scoped-egress.md) (the egress *ceiling* shape this copies),
  [ADR-0021](0021-org-settings-configurability-layer.md) (ceilings that may only tighten),
  [ADR-0025](0025-real-authentication.md) (the API-key hashing scheme reused verbatim),
  [`docs/product/COMPETITIVE_PARITY_PLAN.md`](../product/COMPETITIVE_PARITY_PLAN.md) §1 Slice D

## Context

### The finding

Session 07's competitive research falsified this project's three assumed differentiators
(recorded in `COMPETITIVE_PARITY_PLAN.md` §0 and not softened here). What it *also* found is that
the incumbent gateways — LiteLLM, Portkey, Cloudflare AI Gateway — ship four things RegulAIt does
not, and every one of them is an **adoption blocker rather than a feature gap**:

| Missing | What it costs us |
| --- | --- |
| `GET /v1/models` | Every off-the-shelf OpenAI-compatible client calls it at setup. `client.models.list()`, Cursor's and Continue's "verify base URL" step, LangChain's availability probe. Without it, pointing a tool at RegulAIt fails **before the first completion**, on a request that has nothing to do with governance. |
| Virtual keys | To let a developer use this gateway you must either hand them the vendor key (defeating the purpose) or mint a full RegulAIt API key that carries their **entire** entitlement set with no budget of its own. |
| Per-key model allow-lists | Without them a key is all-or-nothing, so "give the contractor cheap models only" is not expressible. |
| Provider fallback chains | A single upstream 503 is a hard failure, which is a hard sell for anything a team depends on. |

RegulAIt is likely to be released as **freeware**. With no revenue to defend, adoption friction is
the thing worth attacking, and the OpenAI-compatible surface is the single lowest-friction path
that exists — a base-URL change instead of an integration rewrite.

### The thing that must not be lost while closing a parity gap

Every one of these four features is, in the incumbents' hands, a *convenience*. Here they touch the
exact machinery pillar 1 exists to enforce. Three of them are one careless line away from being a
privilege-escalation primitive:

- a **discovery endpoint** that lists the registry hands every caller a map of models they were
  never granted;
- a **virtual key** whose allow-list is read as a grant rather than a filter is a way to hand
  yourself an entitlement you do not have;
- a **fallback chain** that retries after a *denial* is a governance bypass with a retry loop
  around it.

So the entire design of this ADR is one sentence: **each of these may only ever NARROW.** That is
the same ceiling shape [ADR-0062](0062-mode-scoped-egress.md) used for egress posture and
[ADR-0021](0021-org-settings-configurability-layer.md) used for org settings, and it is applied
here three more times.

## Decision

**Build all four, with the ceiling invariant enforced in code at the one dispatch core rather than
at each surface, and with a default-deny route allow-list making a virtual key structurally unable
to reach anything but dispatch.**

### 1. `GET /v1/models` — entitlement-filtered discovery

One route, **two envelopes**, chosen by the `anthropic-version` header — which the Anthropic SDK
sends on every request and no OpenAI client ever sends. That is a real protocol marker, not a
guess, which is why the Anthropic-shaped variant is shipped rather than declined. Absent header ⇒
the OpenAI `{object:"list", data:[{id,object,created,owned_by}]}` shape, because that is what the
overwhelming majority of "compatible" tooling speaks and what a bare `curl` most likely wants. Both
envelopes are produced from **one** `listEntitledModels()`, so the two shapes cannot drift; the
suite asserts the id sets are identical across them.

**The governance twist.** The list runs the *same* `evaluateAgent` the dispatch path runs, with the
same grants, role grants, revocations, tier ceiling and mode. Under default-deny an ungranted model
is **absent** — not listed and then 403'd on use. `gateway-parity.test.ts` proves this in both
directions: two users with disjoint grants, each list asserted to contain their own model and to
**not contain** the other's, plus "a model listed for a user is a model that user can actually
call" and "a model absent from a user's list really is denied when called".

Excluded on purpose:

- **Decision-only agents** (`agents.model` NULL, ADR-0016) — advertising a model id guaranteed to
  fail is worse than omitting it.
- **The bootstrap token** — it has no user identity, and this endpoint's whole contract is *"what
  may YOU call"*. Answering with the whole registry would make it the one list in this system that
  is not entitlement-scoped, so it refuses (403 `bootstrap_cannot_list`).

Gated by ADR-0020's existing interception hook, on **either** shim being enabled: a deployment that
intercepts nothing should not answer a discovery call, and a client that can list models must be
able to call at least one. A disabled surface answers the same indistinguishable Fastify 404.

Each entry carries a non-standard `regulait: { agent_ids, tier }` field. OpenAI clients ignore
unknown fields, and it is the only way a caller in `require_agent` resolution mode can learn the
agent id it must put in `x-regulait-agent-id`.

### 2. Virtual keys

A `virtual_keys` row is an issued `rglv_`-prefixed credential carrying: an **owning user**, an
optional **model allow-list**, an optional **USD budget** with a running spend counter, an optional
**expiry**, a **revoked** flag, and an optional **pinned upstream platform credential** the holder
never sees.

- **Hashing is reused, not reinvented.** sha256 of a 24-byte `randomBytes` token, exactly as
  `api_keys`. `hashToken` moved to `token-hash.ts` so `virtual-keys.ts` shares the one
  implementation without an import cycle; `auth.ts` re-exports it so every existing import is
  unchanged. The token is returned **once** and the suite greps the stored row for it.
- **`isAdmin` is hard-coded `false`** in the auth context, whatever the owner is. A key issued by
  an admin is not an admin — asserted directly, against an admin owner who is first shown to reach
  `GET /v1/users` with their own key.
- **The ceiling.** A dispatch is allowed iff the **owner** is entitled to the served agent **AND**
  the key's allow-list admits it. There is no branch that turns a deny into an allow. The headline
  test issues a key allow-listing a model its owner was never granted and asserts it still denies —
  and then asserts the *same key* works for a model the owner does hold, so the denial is provably
  the owner's entitlement and not a broken key.
- **An empty allow-list means nothing, not everything.** A key someone deliberately emptied must
  not become a key that allows everything. NULL means "no per-key restriction"; `[]` is honoured as
  written.
- **Budget refuses honestly.** 402 with the spent/budget figures in the reason. The first crossing
  is allowed — measured cost is only knowable after the call, the same reasoning the pillar-5
  project budget uses — and every call after it is refused. The suite asserts that the refused call
  wrote **no** `usage_events` row, because a refusal that still bills is a refusal that did not
  happen, and then raises the budget and asserts the call works again so the 402 was provably the
  budget.
- **Spend rides the ONE ledger.** `usage_events.virtual_key_id` is the record;
  `virtual_keys.spent_usd` is the enforcement counter, incremented in SQL so concurrent dispatches
  cannot lose a charge. `GET /v1/virtual-keys/:id/usage` reports both so they can be compared rather
  than assumed equal. An unpriced agent adds 0 — a measured token count never becomes an invented
  dollar.
- **The pinned upstream credential outranks everything**, including the owner's own BYO key.
  "Which vendor account does this key's traffic land on" is a decision the *issuer* made, and a
  holder must not be able to change it by pasting a credential of their own. A provider mismatch
  **refuses** (409) rather than falling through to a different credential: silently burning a key
  the issuer did not name is exactly the accounting lie this feature exists to prevent.

**Only the ISSUER may loosen a key.** Being the *owner* is enough to rename or revoke, and not
enough to raise a budget, widen an allow-list or extend an expiry — otherwise an admin who issues a
contractor a $20 key would watch that contractor `PATCH` it to $10,000. A self-issued key has
`created_by == user_id`, so the self-service motion is unaffected; keying on the **issuer** rather
than on admin-ness is what makes both cases work with one rule. Revocation is deliberately
unrestricted: it only ever narrows.

**The route ceiling — default-deny, and the most important part of this section.** A virtual key is
not a general-purpose identity. `VIRTUAL_KEY_ALLOWED_ROUTES` is an explicit **allow-list** of five
routes (`POST /v1/chat/completions`, `POST /v1/messages`, `GET /v1/models`,
`POST /v1/agents/:agentId/invoke`, `GET /v1/me`); everything else answers 403 `virtual_key_scope`.
An allow-list rather than a deny-list because the failure mode of forgetting must be a 403, not a
hole: a route added tomorrow is unreachable on a virtual key until someone deliberately names it.
Conspicuously absent are the routes that would dissolve the ceiling — minting keys, editing grants,
reading credentials.

`POST /auth/login-with-key` refuses a virtual key **by kind**, before anything else happens. That
exchange hands back a browser session, i.e. the owner's full identity, and would evaporate every
restriction on the key in a single POST.

A virtual key is also subject to `api_key_ip_policy` — it is a programmatic header credential like
an API key, and leaving it out would have made "issue a virtual key" a way around the ADR-0039
network envelope.

### 3. Per-key model allow-lists at every dispatch entry point

Enforcement lives in **two** places, deliberately:

1. **Inside `dispatchOnce`** (the one governed-dispatch core), against the **SERVED** agent —
   after the caller's `evaluateAgent`, before the MRM gate and before any provider work, so a
   refusal costs no tokens. Because it is inside the core, pillar-6 routing cannot route around it
   and a fallback hop cannot slip past it. Every caller of the core inherits it.
2. **At the entry points**, against the **REQUESTED** agent — because `dispatch: false` never
   reaches the core at all (a decision-only invoke would otherwise answer for a model the key may
   not touch), and because refusing at the entry names the agent the caller actually asked for
   rather than whatever routing settled on. The suite asserts the `dispatch: false` case explicitly.

An entry matches by **provider-native model id OR agent id**. Both, because both are things a
client can legitimately name — `GET /v1/models` hands out model ids, while `require_agent` mode and
`/v1/agents/:id/invoke` name agent ids. Matching only one would make a key that works on one
surface silently fail on another, which is the exact class of hole this slice was asked to close.

`GET /v1/models` under a key shows the **intersection**, so a client's model picker cannot advertise
something the credential would refuse.

**Coverage of "every dispatch entry point" is structural, not a checklist.** There are seven call
sites of `executeGovernedDispatch` in the gateway — `performDispatch` (the native invoke path),
`executeCompatCall` (both shims share it), orchestration worker nodes, decompose, the copilot, and
two in the eval harness. A virtual key can reach exactly **two** of them (the invoke path and the
shared compat path), because the route allow-list denies every route that leads to the other five —
and the allow-list check lives in the core all seven share, so the other five are covered anyway if
a future route ever exposes them. A dispatch route added tomorrow inherits the core's check and is
unreachable on a virtual key until someone deliberately names it in the allow-list.

### 4. Provider fallback chains

`agent_fallbacks` is an ordered agent→agent chain, per agent, replaced wholesale by
`PUT /v1/agents/:id/fallbacks`. **Agent→agent and not agent→provider**: entitlement in this system
is granted on agents, so a chain expressed in providers would name hops the policy kernel has no
opinion about, and re-evaluating entitlement per hop would be impossible.

`executeGovernedDispatch` becomes a thin driver over `dispatchOnce`, with four rules:

1. **A GOVERNANCE DENY IS NOT A FAILURE.** Only `model_dispatch_failed` — a thrown
   `ModelProviderError`, i.e. a transport/upstream error — triggers the chain. An entitlement
   denial, a PII or guardrail block, an egress refusal, an MRM refusal, an exhausted project or key
   budget, a missing credential, an undispatchable agent: every one of those is a **decision**, and
   retrying a decision somewhere else is how a governance product becomes a bypass. This is the
   subtle rule and it is tested three ways, each against a chain whose hop the caller **is**
   entitled to so a wrong implementation would visibly serve: an **unentitled primary** (asserted:
   zero hops, zero fallback audit rows), a model **refusal** (asserted: the refusal is returned as
   the answer, no hop), and an **exhausted virtual-key budget** (asserted: 402, no hop, and zero
   `usage_events` rows — the most tempting bypass, because a naive chain would turn "no funds" into
   a successful call on a different model). All three ride the same single
   `error !== 'model_dispatch_failed'` check, which is what makes the untested members of that set
   (missing credential, undispatchable agent, MRM refusal, PII/guardrail block, egress refusal,
   project budget) covered by construction rather than by three more tests.
2. **ENTITLEMENT IS RE-EVALUATED PER HOP, FROM SCRATCH.** A hop never inherits the primary's allow.
   The caller's own `evaluateAgent` runs again — same grants, revocations, tier ceiling, and **the
   same mode**, so a `plan`-only grant cannot serve an `execute` call from inside a chain. An
   unentitled hop is skipped and audited, never served. The suite runs one chain under two users
   and asserts hop 0 is skipped for one and serves for the other.
3. **EGRESS POSTURE IS RE-EVALUATED PER HOP**, because each hop runs the whole of `dispatchOnce`,
   including ADR-0062's compiled-default admission and ADR-0034's `baseUrl` guard. There is no
   shortcut path — that is the point of making the driver call the same body rather than a
   stripped-down one.
4. **EVERY HOP IS AUDITED**, and the outcome is disclosed on the response (`result.fallback` on
   success, `fallback` on an exhausted chain). A fallback is never silent. An exhausted chain
   returns the **original** primary failure, not the last hop's, because a chain that swapped in a
   different error would hide which target the caller actually asked for.

`dispatchOnce` never recurses, so a chain is exactly one level deep and no cycle is possible; the
self-reference case is additionally refused by a database CHECK constraint. A hop with no model id
is refused at configuration time rather than becoming a dead rung discovered at 3am.

An agent with no chain rows — every agent, until an admin configures one — costs one extra indexed
SELECT **on the failure path only** and is otherwise byte-identical to the pre-0066 core.

### Alternatives considered

**Nullable budget/allow-list columns on `api_keys` instead of a second table — rejected.** An
ordinary API key *is* its user: it carries their admin-ness and reaches every route they reach. A
virtual key is a scoped, budgeted, expiring proxy. Conflating them would have turned every existing
read of `api_keys` into a place where a caller can forget to check a budget or an allow-list. A
second table cannot be read by accident.

**A deny-list of routes a virtual key may not reach — rejected.** It fails open. The routes that
matter most (mint a key, edit a grant, read a credential) are exactly the ones a future author
would forget to add, and the symptom would be a scoped credential silently becoming unscoped.

**Enforcing the allow-list only at the two compat surfaces — rejected**, and named in the slice
brief as the hole to avoid. A key that works on `/v1/chat/completions` but bypasses the check on
`/v1/agents/:id/invoke` is not a ceiling. Putting it in the shared core is what makes the claim
provable rather than reviewed.

**Fallback as a wrapper called only by the three reachable surfaces — rejected.** It would have
left orchestration, evals and the copilot without chains, and worse, it would have made "does this
path get fallback?" a per-call-site fact. Building it into the core means every caller gets the
same four rules by construction.

**Triggering fallback on any non-ok outcome — rejected**, and this is the decision the whole
feature turns on. It is the natural implementation (`if (!outcome.ok) tryNext()`) and it is a
governance bypass: a user denied a model would be silently served a different one, and a PII block
would be retried until some hop's project happened to be unclassified.

**A separate per-key spend table — rejected.** Per-key spend, per-project spend and the pillar-5
rollups must be the same numbers by construction, not by reconciliation, so the attribution is one
nullable column on the existing `usage_events` ledger.

**A generated `GET /v1/models` list including decision-only agents — rejected.** Discovery output is
a promise a client will act on. Listing a model id that cannot be dispatched is a lie a client
discovers on its next request.

## Consequences

### Easier

- An existing OpenAI SDK, Cursor, Continue or LangChain integration points at RegulAIt with a
  base-URL change and works — including the setup call that used to fail first.
- A developer can be given a credential scoped to two cheap models with a $20 ceiling and a
  30-day expiry, which is a sentence that was previously not expressible in this product.
- "What did this key do, and what was it stopped from doing" is one query against `audit_log`
  filtered to `objectType = 'virtual_key'`.
- A transient upstream 503 stops being a hard failure, without any hop escaping the governance the
  primary was subject to.

### What this explicitly does NOT give you

Stated here rather than discovered later.

- **Fallback is one level deep.** `dispatchOnce` does not recurse, so a hop's *own* chain is never
  consulted. This is deliberate (it makes cycles impossible and bounds latency) and it means a
  deeply layered fallback topology is not expressible.
- **There is no load balancing.** The slice brief's parity list mentions it; this ADR does not
  implement it. A chain is strictly ordered failover, not weighted or round-robin distribution.
  Adding it would need per-target health state and a scheduler, and would change what the ordering
  column *means*, so it is a separate decision rather than a half-built one here.
- **There is no retry, and no backoff.** One attempt per hop. A flapping upstream that fails then
  succeeds is a failure here, and the chain — not a timer — is the mitigation.
- **A virtual key's budget has no period window.** It is a lifetime cap on the key, not a monthly
  one. The pillar-5 project budget has `budget_period` (ADR migration 0028); this does not. Rotating
  a key is the intended monthly motion. Named as follow-up scope, not implied away.
- **Per-key rate limits are not implemented.** The parity targets have them. RegulAIt's rate limits
  (the pillar-1 scoped rule tables, migration 0026) key on user/role/team/fleet and continue to do so; a virtual key inherits
  its **owner's** limits and adds none of its own.
- **The pinned upstream credential is platform-scoped only.** A key cannot be pinned to a *user's*
  BYO credential. Pinning is an admin act about which vendor account absorbs the spend, and letting
  it point at another human's personal credential would be a different and worse feature.
- **The pinned credential's HAPPY PATH is structural, not end-to-end verified.** The two REFUSALS
  are tested end to end (a provider mismatch 409s before any provider work and bills nothing; a
  credential that does not exist is refused at issue time). Proving that the pinned key is the one
  that reaches the wire would require a real outbound call to a vendor endpoint, which this suite
  does not make and this environment has no key for — the same "no model provider is connected"
  caveat that has been load-bearing since ADR-0016. What IS verified is that the resolution branch
  runs first and short-circuits the entire BYO/platform/env chain; what is NOT verified is the
  header on the socket.
- **Pinning is inert for `mock`, `custom` and `regulait_llm` agents**, which need no vendor
  credential at all, so the pin is simply never consulted. Nothing is silently burned; there is
  nothing to burn.
- **`GET /v1/models` is gated on the interception surfaces**, so a deployment using only the native
  `/v1/agents/:id/invoke` API sees a 404 there. That is intentional — the route is provider-shaped
  and belongs to the shims — but it does mean the endpoint is not a general-purpose "what can I
  reach" API. `GET /v1/users/:id/agents` remains that.
- **The Anthropic envelope's pagination is nominal.** Everything is returned in one page, so
  `has_more` is honestly `false` and `first_id`/`last_id` bound a single page. A deployment with
  thousands of entitled models would want real cursors; none does.
- **Fallback still costs money.** Each hop that reaches a provider bills its own `usage_events` row.
  A chain of three that all fail can produce three rows of spend for one answer that never came —
  visible in the pillar-5 dashboard, which is the correct place for it, but worth knowing before
  configuring a long chain. The chain length is capped at 8 for exactly this reason.
- **No UI.** Virtual keys and fallback chains are API-only in this slice; the SPA has no page for
  either. The routes are in the published OpenAPI contract and the generated client, so they are
  usable, but an admin manages them with `curl` or the SDK today.
- **A virtual key cannot use the MCP proxy.** `POST /mcp/:serverId` is not in the route allow-list.
  A key that could call arbitrary tools is a much larger blast radius than one that can call models,
  and nothing in the parity brief asked for it. Adding it later is a deliberate decision, not an
  oversight.

### Follow-up

- Load balancing and per-target health, if a real deployment ever runs a chain hot enough to want
  it. It should be its own ADR because it changes what `position` means.
- A budget **period** for virtual keys, mirroring `projects.budget_period`, if key rotation turns
  out to be the wrong motion in practice.
- An admin SPA page for both features. The API contract is stable enough to build against.
- Semantic-cache hits are already reported through the pillar-5 dashboard (the parity brief lists
  "cache-hit cost saving" under Slice D); nothing here changed it, and no claim is made that it was
  part of this slice.
