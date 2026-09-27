# Behind your gateway — RegulAIt as a decision point

For a customer who already runs Kong, Envoy, or another L7 gateway and does not want a second one.
Their proxy keeps the traffic; RegulAIt answers **"may this run?"** on each request.

Adapter: [`integrations/kong/regulait-authz.lua`](../../integrations/kong/regulait-authz.lua).

> **Kong only, today. There is no Envoy adapter** — the one shipped with ADR-0127 was withdrawn
> because it failed open on `deny`, and [`integrations/envoy/ext_authz.yaml`](../../integrations/envoy/ext_authz.yaml)
> now records why and what a correct one needs. Envoy's `ext_authz` decides from the HTTP status
> code, and `/v1/authz/check` answers `200` for all three outcomes with the decision in the body.
> Giving Envoy a contract it can act on is a change to the ENDPOINT that Kong's adapter would have
> to move with, so it is a contract decision rather than a config fix. Do not point an `ext_authz`
> filter at this endpoint in the meantime.

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
know. Everything below assumes the gateway is configured to obey — **both adapters fail closed**, and
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

> **The PDP key is a subject-impersonation credential.** Anything holding it can ask a question
> about any user. Treat it like a signing key: its own key, minimum blast radius, rotated, never in
> a config file in git.

Your gateway must map **its** authenticated identity (a JWT `sub`, a Kong consumer, an mTLS CN) to a
RegulAIt user UUID before it calls. Nothing here does that mapping for you, and a wrong mapping is
an authorization decision about the wrong person.

## 4. What a decision costs

Roughly **twenty Postgres round trips**, across about eight sequential steps: entitlements, scope
memberships, rule and approval loads, version resolution, a `count()` for each matching rate limit,
ABAC attributes when policies exist, the execution posture, and the audit write.

This sits on the **p99 of every request your gateway serves**. Both adapters ship a deliberate 2s
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
| `deny` | 403 | refused: no grant, revoked, rate limited, halted, out of scope |
| `approval_required` | **403, with `x-regulait-decision: approval_required`** | a human can unblock this |

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
