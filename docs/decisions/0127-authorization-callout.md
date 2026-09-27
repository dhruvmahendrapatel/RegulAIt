# ADR-0127 — The authorization callout: asking is not doing, and a proxy is not an admin

- **Status**: Accepted
- **Date**: 2026-09-26
- **Relates to**: [ADR-0060](0060-audit-hash-chain.md) (the content hash that decided where the
  advisory marker lives), [ADR-0102](0102-operator-prose-credential-scrub.md) (preserves booleans by
  identity, so the marker survives the write path), [ADR-0104](0104-approval-payload-binding.md) /
  [ADR-0124](0124-kill-switch-and-safe-modes.md) (the queue and the dial the callout must not
  misrepresent), [ADR-0125](0125-shared-enforcement-counters.md) / [ADR-0126](0126-upstream-deadlines-and-circuit-breaker.md)
  (the other two §8 defects), [ROADMAP §8](../product/ROADMAP.md) G9
- **Migration**: none — deliberately, see §1

## Context

ROADMAP G9 said: *"ship the PDP as a sidecar/callout — an Envoy `ext_authz` and Kong pre-function
adapter over `POST /v1/evaluate`, plus a documented deployment topology."* The value is real: a
customer who already runs Kong keeps it, and "you already have a gateway" turns from an objection
into a sale.

**Building it literally would have shipped a defect.** Auditing `/v1/evaluate` before writing any
adapter found four things, one of them serious.

## Decision

### 1. Asking is not doing, and the fix is not a column

The kernel's rate limits are `count(audit_log)` over rows with `effect = 'allow'` for a user in a
window. Every governed execution writes one, correctly — **and so did `/v1/evaluate`, which executes
nothing.** A preview spent the subject's budget on traffic that never ran; a preview followed by the
real call counted twice. A session log from 2026-07-24 records this as *"acceptable for slice"*, and
it was, while the route was an occasional admin preview.

G9 is what makes it intolerable: the premise of a callout is that a proxy asks **on every request**.
Shipping our own recommended topology would have made a governance product mis-count its own limits
in proportion to how much the customer used it.

**The marker is a key in `detail`, not a new `advisory` column, and that is the whole design.**
`content_hash` is taken over an *enumerated* field list (`canonicalAuditPayload`), so a new column
sits **outside** the hash unless the payload version is bumped and the verifier taught both
versions. A flag outside the hash is not tamper-evident: anyone able to flip it on an executed row
changes what the limiter counts, invisibly, in the one table this product asks people to trust.
`detail` is already inside the hash — tamper-evident for free, no migration, no version bump.

**The default is "executed."** A row with no marker counts. Every existing producer keeps its
meaning unedited, and a future one that never reads this ADR is counted rather than silently
exempted. Backwards, a new path could quietly stop counting against a limit — failing open.

The predicate is `IS DISTINCT FROM`, not `NOT (… = 'true')`. `detail` is nullable, `NULL ->> 'k'` is
NULL, and the negation is NULL — which filters the row **out**, quietly disabling rate limiting for
every execution that wrote no detail. There is a test for exactly that row.

### 2. The callout is its own endpoint, because the proxy is not the audience

`POST /v1/authz/check`. Same kernel, same governance, a deliberately narrower contract:
`{ decision, reason }` and nothing else.

`Decision.reason` and `ruleChain` carry rule ids, grant ids, role names and approver **display names
and emails**. That is right for an admin in the portal and wrong for a data-plane proxy, which may
log, forward, or render whatever it receives — none of it under our control. The full chain still
goes to the ledger, where entitlement to read it is enforced.

**An unknown tool is a `deny`, not a 404.** A proxy needs an answer it can route on; a 404 invites a
fail-open `catch` in somebody's Lua, and the request sails through because the adapter could not
parse a refusal.

The three codes are a **closed set** and therefore a compatibility surface: adding one is safe,
changing what an existing one means breaks somebody's routing table silently.

### 3. `require_approval` is a deny that says which kind

Envoy's `ext_authz` has two outcomes and no third, and nothing in this repository had ever had to
decide what a pending approval means at a proxy. It is a **deny** — the request must not proceed,
failing closed as everywhere else. But it is not the same fact as a policy refusal, and collapsing
them destroys the distinction the approvals queue exists to make: *"a human can unblock this"*
versus *"never"*. So it carries its own code and the adapter maps it to 403 **with a header naming
it**.

### 4. The credential is a subject-impersonation key, and the docs say so

The subject comes from the request body and the gateway believes it; there is no check that the
caller's key "belongs to" the subject — unlike `GET …/tools`, which does scope to self. That is what
makes the endpoint usable by a proxy at all, and it means the PDP key can ask about **any** user.

This is stated in the topology doc under its own heading rather than left to be discovered, along
with the fact that the customer's gateway must map its own identity to a RegulAIt user UUID before
calling — and that a wrong mapping is an authorization decision about the wrong person.

### 5. What the topology does not buy, stated in the comparison table

A callout gets governed authorization. It does **not** get PII handling, guardrails, output
scanning, cost attribution or token optimisation, because **the payload never arrives**. And a PDP
decides without enforcing: a caller that ignores the answer proceeds, and we will not know. The
ledger records what was *asked*, not what the proxy then did.

The adapter therefore **fails closed**, including when the PDP is unreachable — an outage that
silently becomes an open door is the worst shape this can take, because the trail would show that
nothing was ever asked.

> **AMENDED, 2026-09-27 (fourth) — AER-027 and AER-028, the two this ADR left open.**
>
> **The PDP credential is no longer an administrator.** `/v1/authz/check` is admin-gated, so the
> only credential that could reach it was an admin API key — putting a control-plane administrator
> inside the most exposed component in a deployment, to do a job one question wide. Migration 0117
> adds `purpose` to ADR-0066 virtual keys: a `pdp` key reaches that one route and nothing else,
> is never admin whatever its owner is, and carries the expiry and revocation virtual keys already
> have. THE SEPARATION RUNS BOTH WAYS — a dispatch key cannot ask an authorization question about
> another person, and a pdp key cannot spend anybody's budget. An unrecognised purpose resolves to
> the EMPTY route set, so a credential a future build does not understand reaches nothing. Issuing
> one is admin-only, because a pdp key can ask about anybody.
>
> **The callout now asks the same question the dispatch would.** It passed `args = undefined,
> projectId = null, principal = undefined`, and the consequence was not that rules were skipped: the
> kernel FAILS CLOSED on a data-scope rule whose argument is absent, so any deployment with one got
> `deny` for calls that would really have been allowed. Safe direction, wrong answer — and wrong in
> the way that gets a PDP removed, after which nothing is governed at all. All three are now
> accepted, all three are optional, and all three are believed exactly as `userId` already is. The
> response carries `contextApplied`, the NAMES of the dimensions used and never their values,
> because the single likeliest misdeployment is a proxy that believes it is sending arguments and
> is not.
>
> **RESOLVED, 2026-09-27 (third).** The Kong plugin is now **verified**: its deny path runs end to
> end against a pinned `kong:3.6` on every change to `integrations/`, with a COUNTING UPSTREAM —
> because a 403 rendered after the upstream already ran is indistinguishable from a refusal on the
> client side, which is precisely how the Envoy defect stayed invisible. An entitled consumer
> reaches the upstream, a denied one does not, a forged `x-regulait-subject` is ignored in all three
> case spellings, and an unreachable PDP fails closed. Envoy stays withdrawn. What is covered is
> Kong 3.6 / DB-less / key-auth / one route, and nothing wider.
>
> **CORRECTION, 2026-09-27 (second).** The Kong adapter has since been withdrawn too, so **this ADR
> currently ships no supported adapter**. The `pre-function` snippet could not run: Pre-Function
> executes at priority `1000000`, ahead of every auth plugin, so taking identity from the consumer
> refused all authenticated traffic; `require "resty.http"` is blocked in Kong's serverless sandbox;
> and its "per-route" server/tool configuration was `os.getenv`, which is node-wide. A real plugin
> replaces it (`integrations/kong/`) with the priority and per-route config both correct — and no
> Kong has run it, so it is the correct shape and not a supported integration.
>
> **CORRECTION, 2026-09-27.** As first written this section said *both* adapters fail closed. That
> was false of the Envoy one and false in the most expensive direction. Envoy's `ext_authz` decides
> from the HTTP status code and `/v1/authz/check` answers `200` for `deny` as well as `allow`, so a
> refusal would have been admitted — by a deployment that believed it was governed, with a ledger
> row agreeing that the call was denied. The Envoy adapter is **withdrawn**; see
> `integrations/envoy/ext_authz.yaml` for the full post-mortem and what a correct one requires. The
> claim was written from the config's intent rather than from Envoy's contract, and no Envoy ever
> ran it — which is precisely the gap the "not exercised by CI" limit below described and which I
> then reasoned past.

### 6. Honest performance, up front

A decision is roughly **twenty Postgres round trips** across about eight sequential steps, and it
sits on the p99 of every request the customer's gateway serves. The Kong plugin uses a deliberate 2s
timeout rather than a default, and §4 of the topology doc says to measure it before production.

**It is not cacheable**, and the reason is the interesting one: the answer depends on rate-limit
windows, the live kill switch, approval-queue state, consent expiry and active rule versions. A TTL
cache would stale the **kill switch** — the one control whose entire value is that it takes effect
now.

## Consequences

**What this buys.** "You already run Kong, keep it" becomes a supported deployment with two worked
adapters and a topology document. G9 closes. `/v1/evaluate`'s counting bug closes with it.

**What it costs.** One more route on the compatibility surface, and the repository's **first
artifacts intended to run outside the gateway** (`integrations/`) — code we ship and do not execute,
which is a maintenance category this project did not previously have.

**Named limits.**

- **No gRPC `ext_authz`** — faster, needs a proto service we do not speak.
- **No Istio/Traefik/HAProxy adapters.** The contract is one JSON POST; two worked examples beat six
  half-tested ones.
- **No identity mapping.** The customer maps their consumer/JWT subject to a RegulAIt user UUID. We
  do not, and cannot, do it for them.
- **The adapter is not exercised by CI.** It is Lua for someone else's runtime; the *endpoint* is
  tested, the adapter is reviewed. That is a real gap and it is disclosed rather than papered over
  — and disclosing it turned out not to be enough: an unexercised adapter shipped with a fail-open
  deny path and a second one shipped taking its subject from a client-settable header. Review did
  not catch either. Nothing in `integrations/` should be called supported again until its deny
  path is exercised end to end against a pinned container, asserting zero upstream invocations for
  every refusal.
- **The subject was spoofable until 2026-09-27.** The Kong adapter preferred an inbound
  `x-regulait-subject` header over the authenticated consumer, and took `serverId`/`toolName` from
  client headers too — so a caller could choose both who they were and which question was asked.
  Identity now comes only from the authenticated consumer, the question comes from route
  configuration, and inbound `x-regulait-*` headers are stripped.
