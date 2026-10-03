# Behind your gateway — RegulAIt as a decision point

For a customer who already runs Kong, Envoy, or another L7 gateway and does not want a second one.
**Kong is the supported adapter; there is no Envoy one — see below.**
Their proxy keeps the traffic; RegulAIt answers **"may this run?"** on each request.

Adapter: [`integrations/kong/`](../../integrations/kong/) (a Kong plugin).

> ### Kong: supported and VERIFIED (new cases pending their first CI run). Envoy: withdrawn, do not use.
>
> **Kong** is exercised — on any change to `integrations/`, to the gateway's source, to the
> shared packages or to the lockfile, which are the places that can alter either side of this
> contract — by [`.github/workflows/integrations.yml`](../../.github/workflows/integrations.yml),
> against `kong:3.6` in DB-less mode behind `key-auth`. The assertion is not that the client saw a
> 403 — a 403 rendered after the upstream already ran looks identical from the client side — it is
> that **the upstream was never called**, measured by a counting upstream.
>
> **Verified** (first green run 2026-09-27, run 36300665525; most recent green run of the
> previous plugin and harness, unchanged since, run 36930442969 at `3a91a93`): an entitled consumer reaches the upstream; a denied one does not; an
> `approval_required` is refused with `x-regulait-decision: approval_required` rather than as a
> flat deny; a forged `x-regulait-subject` naming a more-entitled user did not borrow that user's
> entitlement in any of three case spellings (that plugin version IGNORED the header; the current
> one refuses it — see below); a declared session origin that contradicts the credential is refused
> (AER-036); a PDP that is unreachable, that answers non-200, or whose answer
> cannot be parsed each fail closed; and the decision context the adapter claims to send is read
> back from the PDP's own `contextApplied` ledger, including that `args` is NOT claimed.
>
> **Pending first CI run — written, never yet run against a container, so NOT verified until a
> green run id is recorded here** (AER-026, AER-030, AER-034): a forged protocol header is
> **refused** (`forged_protocol_header`) in every case spelling, when duplicated, and from the
> consumer it names, while the documented client headers (`x-regulait-project-id`,
> `x-regulait-agent-id`) pass through to the upstream; a request with more headers than the
> plugin's scan reads is refused (`too_many_headers`); unmapped, mis-mapped, nonexistent and
> deactivated consumer identities and an `anonymous`-fallback consumer are each refused with their
> own reason, and the ledger row keeps the Kong consumer beside the subject it resolved to; two
> governed routes bound to distinct server/tool pairs with crossed entitlements; forged
> server/tool/decision headers refused; and the Kong and Postgres images pinned by digest.
>
> What that covers precisely: Kong 3.6, DB-less, `key-auth`. Other Kong versions, DB-backed mode
> and other auth plugins are not covered, and the priority ordering this plugin depends on is
> version-specific — so treat a different Kong as unverified until the harness runs against it.
>
> **Envoy remains withdrawn.** The adapter shipped with ADR-0127 **failed open on `deny`**: its
> `ext_authz` filter decides from the HTTP status code, and `/v1/authz/check` answers `200` for
> every outcome with the decision in the body, so a refusal would have been admitted by a
> deployment that believed it was governed.
> [`integrations/envoy/ext_authz.yaml`](../../integrations/envoy/ext_authz.yaml) holds the
> post-mortem. Do not point an `ext_authz` filter at this endpoint.

---

## 1. Which topology you are in

There are two, and conflating them is how people get hurt.

| | **In-line** | **Decision point** (this page) |
|---|---|---|
| Traffic path | client → RegulAIt → upstream | client → their gateway → upstream |
| What RegulAIt sees | the whole request and response | a question and nothing else |
| Enforcement | RegulAIt refuses, and the call cannot proceed | their gateway refuses, **because it chose to** |
| PII, guardrails, output scanning | yes — the payload passes through | **no** — the payload never arrives |
| Cost attribution, token optimisation | yes | **no** |

The second row of the last two is the honest cost and this page will not bury it. A PDP callout buys
governed authorization; it does **not** buy the things that need the bytes. Customers who want both
run the in-line MCP proxy for their agent traffic and the callout for the rest.

## 2. It decides; it does not enforce

`POST /v1/authz/check` returns an answer. A caller that ignores it proceeds, and RegulAIt will not
know. Everything below assumes the gateway is configured to obey — **the adapter fails closed**, and
if you change that, you have changed what the product guarantees.

The ledger records what was **asked**. It cannot record what the proxy then did. If you need the
stronger property, that is the in-line topology, not this one.

## 3. The subject, and why this credential is sensitive

The callout names the user it is asking about:

```json
{ "userId": "<RegulAIt user uuid>", "serverId": "<uuid>", "toolName": "read_file" }
```

**The subject comes from the request body, and RegulAIt believes it.** The caller authenticates with
an admin API key and asserts who it is asking about — there is no check that the key "belongs to"
the subject. That is what makes the callout usable by a proxy at all, and it means:

> **The PDP key is a subject-impersonation credential — but it is no longer an administrator.**
> Anything holding it can ask a question about any user, which is inherent: the subject comes from
> the request body and is believed, and that is what makes the callout usable by a proxy at all.
> What it can no longer do is anything else.

**Mint it as a `pdp` virtual key, never as an admin API key** (AER-027, migration 0117):

```sh
curl -X POST https://<gateway>/v1/virtual-keys \
  -H "authorization: Bearer <an admin key>" \
  -d '{"name":"kong-pdp","userId":"<owner uuid>","purpose":"pdp","expiresAt":"2027-01-01T00:00:00Z"}'
```

That credential reaches `POST /v1/authz/check` and **nothing else**: it cannot dispatch a model,
read a ledger, or mint another key, and it is never an administrator whatever its owner is. Until
this existed the only credential that could reach an admin-gated `/v1/authz/check` was an admin API
key — so putting a PDP in your data plane meant putting a control-plane administrator there, which
is the wrong blast radius for a component whose whole job is one question.

Issuing one is itself an admin act, because a pdp key can ask about **anyone**. It carries the
expiry and revocation every virtual key has; rotate it by minting the replacement and revoking the
old one. Still: its own credential, minimum blast radius, never in a config file in git — the Kong
plugin reads it through a vault reference for exactly that reason.

Your gateway must map **its** authenticated identity (a JWT `sub`, a Kong consumer, an mTLS CN) to a
RegulAIt user UUID before it calls. Nothing here does that mapping for you, and a wrong mapping is
an authorization decision about the wrong person.

## 3b. The context a decision needs (AER-028)

`POST /v1/authz/check` accepts three optional fields beyond the subject, and supplying them is what
makes the callout ask **the same question** a real dispatch would:

| field | what it decides |
| --- | --- |
| `args` | data-scope rules, which constrain an argument to allowed values |
| `projectId` | the deploy-mode context a mode-scoped rule matches on |
| `principal` | ADR-0040 session facts (`sessionOrigin`, `mfaCompleted`) for ABAC |

**Omitting them is not neutral.** The kernel fails closed on a data-scope rule whose argument is
absent, so a deployment with one gets `deny` for calls that would really be allowed. That is the
safe direction and still the wrong answer — an operator whose proxy denies everything removes the
proxy, and then nothing is governed at all.

All three are **believed**, exactly as `userId` already is: in this topology your proxy is the
component that authenticated the user and knows what it is calling, so it is the only thing that
*can* supply them. That is why the credential is purpose-scoped (§3) and why the proxy is part of
the trusted path. Omitting `principal` can only ever narrow a decision — absent means the honest
"unknown", which is the weakest reading.

**What the Kong adapter sends, and what it deliberately does not.** `project_id` is per-route plugin
config, because a governed route fronts one project context — static per route and true. The session
origin is **derived from the credential Kong authenticated with** where it can be (key-auth →
`api_key`, basic-auth → `password`), and taken from `asserted_session_origin` only for the values
Kong cannot observe (`oidc`, `saml`). A declared origin that contradicts the credential is a
**refusal**, not a substitution. Until 2026-09-28 this was an unchecked operator-set string in a
vocabulary the product does not use (`sso`), and this repository's own harness declared it on a
key-auth route — see AER-036 and `integrations/kong/README.md`.
There is **no `mfa_completed` field**: Kong cannot observe whether a second factor was completed,
and a configured `true` would be an unchecked assertion sitting in the trusted path. **`args` are
not sent at all**, and that is the adapter's real limit: mapping an HTTP body onto a tool's named
arguments is a per-route projection, and a *wrong* mapping evaluates a data-scope rule against the
wrong values — which is worse than the fail-closed deny that omitting them produces. **A route
governed by a data-scope rule is therefore refused by this adapter until that mapping exists**, by
design. The harness asserts all of this against the PDP's own ledger (`contextApplied`) rather than
against the plugin's source, including that the adapter does *not* claim to send `args`.

The response carries `contextApplied`: the **names** of the dimensions the decision was computed on,
never their values. A proxy that believes it is sending arguments and is not would otherwise see
only a stream of denials with no way to tell a policy refusal from its own misconfiguration.

## 4. What a decision costs

Roughly **twenty Postgres round trips**, across about eight sequential steps: entitlements, scope
memberships, rule and approval loads, version resolution, a `count()` for each matching rate limit,
ABAC attributes when policies exist, the execution posture, and the audit write.

This sits on the **p99 of every request your gateway serves**. The Kong plugin uses a deliberate 2s
timeout rather than a default. Before you put this in front of production traffic:

- measure it against your own latency budget, on your own data volume;
- give RegulAIt's Postgres headroom — the callout is a read-heavy path with one write;
- know that the answer is **not cacheable**. It depends on rate-limit windows (time), the live kill
  switch (ADR-0124), approval-queue state, consent expiry, and active rule versions. A TTL cache
  would stale the kill switch — the one control whose entire value is that it takes effect *now*.

## 5. Before you turn it on

- **Set `REGULAIT_TRUSTED_PROXIES`.** It defaults to trusting **nothing**, which is correct when
  RegulAIt is on the edge and wrong here: with a proxy in front, every audit and session IP becomes
  the proxy's, and the ledger quietly records the wrong source for everything.
- **Protect the callout hop.** The gateway speaks plain HTTP behind its own TLS sidecar
  ([`docs/ops/TLS.md`](../ops/TLS.md)). The question carries a subject identity and the answer
  carries a rule id — if this hop leaves the host, terminate TLS in front of it.
- **The edge rate limiter applies to the callout itself.** A busy data plane can 429 its own PDP.
  Size `REGULAIT_API_KEY_RATE_LIMIT_MAX` for your request volume, not for a human admin's.
- **Do not forward the answer verbatim to callers.** The body is deliberately minimal — a decision
  and a rule id — but `x-regulait-reason` still names a rule. Rule ids are not secrets; your
  policy's *shape* may be.

## 6. The three answers

| `decision` | HTTP at your gateway | meaning |
|---|---|---|
| `allow` | proceed | entitled, within limits, nothing pending |
| `deny` | 403 | refused: no grant, revoked, rate limited, halted, out of scope — or a subject the adapter will not stand behind (below) |
| `approval_required` | **403, with `x-regulait-decision: approval_required`** | a human can unblock this |

**A forged or unusable subject is a `deny` with its own reason, never an ignored header.** The
Kong adapter refuses before anyone is asked when the request carries one of the five protocol
headers (`x-regulait-subject`, `-server-id`, `-tool`, `-decision`, `-reason`) —
`forged_protocol_header` — or more headers than its scan reads (`too_many_headers`); when no
credential stands behind the consumer, including Kong's `anonymous` fallback (`unauthenticated`);
and when the consumer's `custom_id` is missing or is not a user UUID (`consumer_not_mapped`). The PDP
refuses a UUID nobody has (`unknown_subject`) and a deactivated user whose grants survive
(`subject_disabled`), and writes both to the ledger with the Kong consumer that presented them.
Other `x-regulait-*` headers (`x-regulait-project-id`, `x-regulait-agent-id`) are client traffic and
pass through. These refusals are pending their first CI run (see the box at the top).

The third is the one to get right. A proxy filter of this shape has two outcomes and no third, so a
pending approval **must** map to a denial — failing closed, as everywhere else in this product. But
it is not the same fact as a policy refusal, and a caller that treats every 403 alike loses the
distinction the approvals queue exists to make: *"ask someone"* versus *"never"*. The Kong adapter
carries it in a header for that reason. Surface it.

Note that the table above describes what the ADAPTER returns to the client, not what the endpoint
returns to the adapter. `/v1/authz/check` itself answers `200` for all three and puts the decision
in the body — which is exactly why a status-code-driven filter cannot be pointed at it directly.

## 7. What is deliberately not here

- **No gRPC `ext_authz`.** Faster, and it needs a proto service RegulAIt does not speak. The HTTP
  variant works against the endpoint that exists today.
- **No caching layer.** See §4 — it would stale the kill switch.
- **No Istio/Traefik/HAProxy adapters.** The contract is one JSON POST; any gateway that can make
  one can use it. Two worked examples beat six half-tested ones.
