# ADR-0098 — API-key expiry: the credential that authenticates everything finally has a lifetime

- **Status**: Accepted
- **Date**: 2026-09-06
- **Relates to**: [ADR-0025](0025-secure-human-auth.md) and
  [ADR-0039](0039-session-device-management.md) (sessions already have a lifetime and an idle
  window — the shape this copies), [ADR-0066](0066-gateway-parity.md) §2
  (virtual keys already have an optional `expires_at` with issuer-only extension — the nearest
  precedent, and the one whose extension rule this ADR deliberately declines to imitate),
  [ADR-0022](0022-identity-lifecycle-approver-visibility.md) (the "a credential that really exists but may
  not be used says WHY" idiom, and the `disabled` refusal this sits beside),
  [ADR-0097](0097-mcp-admission-scanning-and-auth-discovery.md) (the RFC 6750 challenge on the MCP
  proxy's 401 — the front door this rides), [ADR-0021](0021-org-settings-configurability-layer.md)
  (the org-settings ceiling model and its "a fresh settings row changes nothing" invariant),
  [ADR-0023](0023-schema-depth-credential-json-systemprompt-mcpmode.md) (the MCP proxy, whose only bearer credential is an API key)
- **Migration**: 0104 (`0104_api_key_expiry`)

## Context

`api_keys` (`packages/db/src/schema.ts`) carried four columns of state: `created_at`,
`last_used_at`, `revoked_at` — and that is the whole list. **There was no expiry column at all.**

That is not a small omission on a small credential. An API key is the `rgl_`-prefixed bearer token
that authenticates the MCP proxy (ADR-0023, and after ADR-0097 it is the *only* bearer credential
that can reach a tool call at all), the two compat shims, the native dispatch surface, every admin
route, and — via `POST /auth/login-with-key` — a full browser session. It is the most privileged
thing this product hands anybody. And it was the only credential in the system that lived forever:

| credential | lifetime | where |
| --- | --- | --- |
| browser session | absolute lifetime **and** idle expiry, org-configurable | ADR-0025 / ADR-0039 |
| virtual key | optional `expires_at`, refused at auth with its own named reason | ADR-0066 §2 |
| **API key** | **none — a key issued in 2026 authenticates in 2036** | — |

The consequences compound rather than sit still. A key handed to a contractor for a two-week
engagement is still live two years later. A key pasted into a CI config, a laptop, an IDE
`settings.json` or a `.env` that outlives the machine it was created on has no end date anybody
scheduled. Nothing surfaces "this credential has been idle for eleven months and still works", and
the only way to end one was for a human to remember to press revoke.

## Decision

**Add a nullable `expires_at` to `api_keys`, two org-settings dials that ship inert, and one
enforcement point — with an expired key refused by a name that is not the name a revoked key gets.**

### 1. The column, and the default that must not break an upgrade

`api_keys.expires_at` is `timestamptz`, **nullable, with no default**. Every row that exists when
migration 0104 runs therefore gets `NULL`, and `NULL` means *never expires*.

**This is said out loud because it is the decision, not an implementation detail.** An upgrade must
not silently invalidate every key in a running install. A deployment that pulls this migration on a
Tuesday afternoon does not lose its CI jobs, its IDE integrations and its MCP clients at the same
instant, discover it at 3am, and correctly conclude that the safe move is to never upgrade again.
Existing keys keep working exactly as they did until an operator decides otherwise — which they do
by issuing new ones, not by this migration deciding for them. It is the same reasoning ADR-0097
recorded one migration ago for grandfathering `mcp_servers`, and it is the same trade: a softer
boundary at the upgrade, in exchange for a control that actually gets adopted.

### 2. Two org knobs, both shipping inert

- **`org_settings.api_key_default_ttl_days`** — the lifetime applied to a key issued with **no**
  caller-supplied expiry. `NULL` by default.
- **`org_settings.api_key_max_ttl_days`** — the **ceiling** on what any issuer may *request*.
  `NULL` by default.

With both `NULL` — which is the state migration 0104 leaves behind — a newly issued key gets
`expires_at NULL` and never expires, so **behaviour is byte-identical to pre-0098**. That is
ADR-0021's "a fresh settings row changes nothing" invariant held one more time, and
`api-key-expiry.test.ts` **pins** it rather than asserting it in prose: it reads the two dials off
`GET /v1/org/settings`, asserts both null, issues a key with no `expiresAt`, and asserts the
response's `expiresAt` is null, the key authenticates, and the listing reports `state: "active"`.

**Recommended production settings: `api_key_default_ttl_days: 90`, `api_key_max_ttl_days: 365`.**
Ninety days is short enough that a forgotten key dies before it is forgotten *and* leaked, and long
enough not to become a quarterly outage; a year is a hard outer bound for the deliberate long-lived
CI credential that every real deployment turns out to need. **Neither is flipped here.** A migration
that starts expiring live credentials is how a security control gets turned back off permanently.

The pair must stay coherent: a default above the ceiling would make every no-argument issuance
refuse itself. That is a database `CHECK` **and** an explaining 422 (`api_key_ttl_ordering`) on
`PUT /v1/org/settings`, evaluated over the **merged** values rather than only the submitted ones, so
lowering the ceiling under an existing default is caught too.

### 3. Issuance — three inputs, three meanings, and a refusal instead of a clamp

`POST /v1/users/:userId/keys` accepts an optional `expiresAt` (ISO-8601). It distinguishes three
inputs, because they mean three different things:

| input | meaning | result |
| --- | --- | --- |
| **absent** | "you decide" | `defaultTtlDays`, else the ceiling, else no expiry |
| **a timestamp** | an explicit request | honoured, unless it exceeds the ceiling |
| **explicit `null`** | "this key must never expire" | honoured with no ceiling; **refused** under one |

**Does the default apply when the caller supplies nothing? Yes — that is what a default is**, and
the alternative (a default that only applies when someone asks for it) is not a default. The issued
value is returned on the 201 response alongside a small `expirySource` field
(`caller | org_default | org_ceiling | none`), so a caller never has to infer what it was given.

**A ceiling refusal is by name, never a clamp.** Requesting 30 days under a 7-day ceiling answers
**422 `api_key_expiry_exceeds_ceiling`**, naming the knob (`apiKeyMaxTtlDays`), the cap, and the
longest expiry that *would* have been accepted — and issues nothing. This is the codebase's
established idiom for an unsatisfiable request (ADR-0066's `self_fallback`,
`fallback_not_dispatchable`, ADR-0025's `password_policy`): a real 4xx that explains itself, never a
silent substitution. Clamping would hand somebody a credential with a lifetime they did not ask for
and were never told about — and they would discover it the moment it stopped working, which is
precisely the support ticket this ADR exists to eliminate.

**The explicit `null` is refused by the same ceiling**, and that is the subtle half. "Never expires"
is the longest lifetime there is. A ceiling a caller steps over by asking for infinity is not a
ceiling, and a per-field guard that only inspects timestamps would have exactly that hole.

The one place a lifetime is *not* refused for being unrequested: with a ceiling set and no default,
an **omitted** expiry takes the ceiling. Refusing every no-argument issuance in such an install
would break every existing caller for no safety gain, and "as long as you allow" is the only
coherent reading of an omitted expiry under a cap. It is `expirySource: "org_ceiling"` on the
response and in the audit row, so it is disclosed rather than silent.

### 4. Enforcement — one point, and no second path

The check is in **`authenticate()` (`apps/gateway/src/auth.ts`)**, which is the one place in this
gateway where a bearer token becomes an identity. That was verified rather than assumed: `apiKeys`
is referenced in exactly four places outside the schema — `authenticate()`, the three routes in
`app.ts` (issue / list / revoke), and `access-recommendations.ts`, which reads `last_used_at` for a
report and resolves no credential. `POST /auth/login-with-key`, the route auth hook, and ADR-0020's
interception identity probe all reach the token through that same function, so **there is no
secondary path on which expiry could be bypassed** — which the suite proves by driving the exchange
endpoint directly and watching it refuse.

The `revoked_at IS NULL` predicate **moved out of the lookup's `WHERE` clause**. It used to make a
revoked key indistinguishable from a token that never existed; the row is now fetched either way so
the two dead states can be told apart. It is still one indexed equality on `token_hash`.

Order matters and is deliberate: **disabled owner → revoked → expired**. ADR-0022's `disabled`
answer is checked first and is unchanged. **Revoked beats expired**, because a key somebody
deliberately killed is revoked whatever its clock says, and telling its holder "expired" would
invite them to ask for the same key again on the same terms.

A refused presentation does **not** touch `last_used_at`. A refusal is not a use.

### 5. Expired ≠ revoked — in the error *and* in the audit trail

Two 401s that say different things, joining ADR-0066's virtual-key pair on identical reasoning
(only somebody holding the real token ever sees these, so nothing leaks):

| state | HTTP | `error` | audit `ruleId` |
| --- | --- | --- | --- |
| expired | 401 | `api_key_expired` | `api-key-refused-expired` |
| revoked | 401 | `api_key_revoked` | `api-key-refused-revoked` |
| unknown token | 401 | `unauthenticated` | *(none — nothing to audit)* |

An operator debugging "my key stopped working" needs these apart, because the two facts call for
**opposite responses**: a lifetime that ran out is reissued on the same terms; a credential somebody
deliberately killed means finding out who revoked it and why. `unauthenticated` distinguishes
neither from a typo.

`api_key_revoked` is a **behaviour change** and is recorded as one: before this ADR a revoked key
answered the generic `unauthenticated`. The status code is unchanged (401), no test asserted the old
body, and the asymmetry it removes was never deliberate — it was a side effect of the revocation
filter living in the `WHERE` clause. Naming one of the pair and leaving the other generic would have
made the audit trail answer half the question.

The audit rows are written **inside `authenticate()`**, not at each 401 site, because that function
is the only place that knows *which* key was presented — what leaves it is a bare string. Every
caller therefore audits identically, with no site left to forget. `objectType` is a new
`api_key` value on the audit enum (a plain text column, no DDL), for the same reason ADR-0066 gave
`virtual_key` its own: "why did this key stop working" should be one query.

### 6. The ADR-0097 cross-check — expiry rides the front door B9 built

An expired key presented to `POST /mcp/:serverId` answers **401 with the RFC 6750
`WWW-Authenticate` challenge carrying `error="invalid_token"` and `resource_metadata`**, byte-for-
byte the same header an invalid key gets. This required **no new code**, and that is the point:
ADR-0097 deliberately put the challenge on the `onSend` hook, keyed on *any* 401 from that route,
precisely so a refusal added later could not arrive without one. The suite asserts the two challenge
strings are equal, and follows the `resource_metadata` URL to the document it names.

The 401/403 line ADR-0097 drew is unchanged and correct here: an expired credential is a
**credential** problem, so it is a 401 and it gets a challenge. It is not an entitlement problem.

### 7. Lifecycle surface

`GET /v1/keys` now returns `expiresAt` and a derived `state`: **`active` | `expiring` | `expired` |
`revoked`**, with **revoked winning over expired** (same precedence as the enforcement, and the
suite exercises it on a key that is both). `expiring` is a fixed 14-day window — a module constant,
**not** a third org knob: this slice's brief is two dials, and a warning window is a presentation
choice with nothing enforced on it. An admin can now see what is about to break before it breaks,
which is half the reason to ship a lifetime rather than only an enforcement.

### 8. Extension is deliberately not offered

ADR-0066 §2 lets the **issuer** (not the owner) extend a virtual key's expiry, keyed on
`virtual_keys.created_by`. **`api_keys` has no `created_by` column**, so that rule is not
expressible here — there is no stored fact that distinguishes an issuer from an owner.

Two ways out were available and both were rejected. Adding `created_by` and copying the rule is a
larger migration than this slice, and would be backfilled with `NULL` for every existing key, which
means the rule would not apply to any key that exists today — the exact keys most likely to be asked
about. Letting the **owner** extend is the escalation ADR-0066 explicitly refused: an admin issues a
contractor a 30-day key and watches the contractor `PATCH` it to ten years.

**So the lifecycle is: issue, and revoke. An expiry is set once, at issuance, and cannot be
extended.** The replacement motion is rotation — issue a new key, revoke the old — which is the
motion an expiry policy is trying to create in the first place. The refusal text says so
(`"an expiry cannot be extended"`) so a holder is not left hunting for an endpoint that does not
exist. If a future slice adds `created_by`, ADR-0066's rule can be adopted verbatim.

## What this deliberately does NOT do

- **It does not expire anything on upgrade.** Every existing key gets `NULL` and keeps working.
  Nothing in migration 0104 makes a running install's credentials stop.
- **It does not turn the control on.** Both dials ship `NULL`, and the recommended production values
  are stated here rather than set.
- **It does not sweep.** There is no scheduled job that revokes expired keys, mails their owners, or
  prunes rows. An expired key stays in the table, refused at auth and reported as `expired` in the
  listing — which keeps its audit history resolvable, exactly as ADR-0066 revokes rather than
  deletes a virtual key.
- **It does not notify.** `state: "expiring"` is a fact the API reports; nothing pushes it anywhere.
  No email, no webhook, no banner.
- **It does not offer extension** (§8), and does not add `created_by` to `api_keys`.
- **It does not touch the bootstrap token.** The deploy-time bootstrap credential is not an
  `api_keys` row at all — it is compared before the table is ever read — so no expiry can attach to
  it and an install can never be locked out of its own bootstrap. Asserted.
- **It does not touch virtual keys.** ADR-0066's `rglv_` path is disjoint by prefix and is
  unchanged in every respect.
- **It does not add an SPA surface.** The `state` field is on the API; rendering it is the web
  session's surface, not this one's.

## Honest limits

1. **An expiry is only as good as the day somebody sets one.** With the shipped defaults this ADR
   changes nothing at all, by design. It ships the *mechanism*; a deployment that never sets a dial
   gets exactly the pre-0098 posture, and this document's recommended values are advice, not a
   default.
2. **No rotation help.** There is no "reissue this key with the same name and settings" endpoint, no
   overlap window, and no way to hand a client a new key before the old one dies. Rotation is two
   manual calls and a config edit.
3. **A key issued before an admin sets a ceiling is unbounded forever.** The ceiling binds
   *issuance*; it does not retroactively shorten anything, and §8 means there is no way to shorten
   an existing key either — only to revoke it.
4. **`expiring` is a fixed 14 days.** Not configurable, and not derived from the key's own TTL, so a
   365-day key and a 20-day key both warn for the same fortnight.
5. **Expiry is evaluated against the gateway's clock at authentication time.** A skewed clock skews
   the boundary. This is the same exposure ADR-0025's session lifetime and ADR-0066's virtual-key
   expiry already carry, and no new clock discipline is introduced.
6. **An expired key still writes an audit row on every presentation.** A client looping on a dead
   credential generates one deny row per attempt. That is deliberate — it is exactly the evidence an
   operator needs — but it is unbounded, and the existing audit-retention machinery (ADR-0021's
   prune) is the only thing that bounds it.
7. **`api_key_revoked` is a changed error body** for a case that previously answered
   `unauthenticated`. Any external client string-matching that value on a revoked key sees a new
   string. The status code is unchanged.

## Alternatives considered

**Backfill an expiry onto existing rows** (e.g. `created_at + 90 days`). Rejected as the single
worst option available: it would silently invalidate a live install's credentials on upgrade,
including keys created three months ago that would be dead the instant the migration ran. See §1.

**Clamp an over-long request to the ceiling instead of refusing.** Rejected. A clamp is quiet, and
the person it lies to is the person holding the credential. The refusal names the cap and the
longest acceptable instant, so the caller can retry correctly on the first attempt.

**An idle expiry (`last_used_at + N`) instead of, or as well as, an absolute one.** Attractive — it
targets the actual risk (a forgotten key) more precisely than a calendar. Rejected **for this
slice** because it is a second, independent policy with its own semantics (does a key idle past its
window die, or merely warn? does a single use resurrect it?), and shipping both at once would make
the byte-identical proof cover two mechanisms instead of one. ADR-0039 already established the
idle-expiry shape for sessions, so the precedent is there if it is wanted next.

**Owner-extendable expiry.** Rejected — it is the escalation ADR-0066 refused, and `api_keys` cannot
express the issuer rule that makes ADR-0066's version safe. See §8.

## Verification

### The proofs (`apps/gateway/src/api-key-expiry.test.ts`, 14 tests, keyless)

Byte-identical at the shipped defaults (both dials asserted `NULL`, key issued with no expiry
authenticates and lists as `active`, and a row with `expires_at NULL` — the shape 0104 leaves on
every upgraded install — still authenticates); a key with a TTL authenticates **before** and fails
**after**, with `expires_at` written directly rather than slept through, so the subject is the
enforcement and not the passage of time; expired and revoked produce different `error` codes,
different details, and two audit rows with different `ruleId`s; `last_used_at` is *not* advanced by
a refused presentation; the exchange path (`POST /auth/login-with-key`) refuses the same expired key
that worked minutes earlier; the bootstrap token is unaffected; the default TTL applies to an
omitted expiry and is disclosed as `org_default`; the ceiling refuses an over-long request **by
name** with the knob and the maximum acceptable instant in the detail, and the key count is
unchanged (a delta, not an absolute); the explicit `expiresAt: null` is refused by the **same**
ceiling; an omitted expiry under a ceiling takes the ceiling as `org_ceiling`; a past expiry is a
400 before the ceiling is consulted; a default above the ceiling is a 422 that saves nothing; the
MCP proxy answers an expired key with a 401 whose `WWW-Authenticate` header is **string-equal** to
the one an invalid key gets, containing `error="invalid_token"` and a `resource_metadata` URL that
really serves the document for that resource (and a *live* key on the same URL is asserted **not**
401, so the auth hook is proved to run first); and the listing reports all four states with revoked
winning over expired on a key that is both.

### The no-op probe (M-002)

The expiry branch in `authenticate()` was neutralised in a scratch edit (`if (false && ...)`).
**Four tests reddened**, named:

1. `enforcement in authenticate() > a key with a TTL authenticates BEFORE its expiry and fails AFTER it` — `expected 200 to be 401`
2. `enforcement in authenticate() > EXPIRED and REVOKED are different answers and different audit rows` — `expected 200 to be 401`
3. `enforcement in authenticate() > expiry cannot be bypassed on the key-exchange path either` — `expected 200 to be 401`
4. `ADR-0098 × ADR-0097 — an expired key at the MCP proxy > answers 401 with the RFC 6750 challenge, exactly as an invalid key does` — `expected 404 to be 401`

The fourth is the informative one: with the check removed the expired key **authenticated** and the
request fell through to the proxy handler, which answered 404 for an unregistered server id. That is
the cleanest possible demonstration that the 401 in the green run is produced by the expiry check
and not by anything else on that route.

Ten tests stayed green, correctly: everything in the defaults block (a `NULL` expiry is not expired
under either version of the code), the whole issuance/ceiling block (those are 422s and 400s from
`resolveIssuedExpiry`, which the probe left intact — refusing to *issue* an over-long key is a
separate mechanism from refusing to *authenticate* an expired one, and the probe proving they are
separate is worth more than a larger red count), the bootstrap assertion, and the lifecycle listing
(`apiKeyState` is pure and independent of `authenticate()`). The edit was reverted exactly —
`git diff --stat apps/gateway/src/auth.ts` empty — and the file re-run green.

### Migration

Journal entry `idx: 104`, `when: 1785039000000`, tag `0104_api_key_expiry`; `idx` and `when`
verified **unique and strictly ascending** across all 104 entries, and no duplicate migration number
in the folder. Migrations 0001–0104 apply cleanly to a freshly created database via the suite's own
`runMigrations` (verified on a fresh `regulait_b10a`: `__drizzle_migrations` holds 104 rows, and
`\d api_keys` shows `expires_at` and `api_keys_expires_at_idx` present).

## Deviations and deliberate edits to existing surfaces

1. **`apps/gateway/src/credentials-keys.test.ts`** — the `GET /v1/keys` field-set assertion is an
   exact sorted list, so it names `expiresAt` and `state` now. It was **strengthened** rather than
   merely updated: the same test now also asserts every listed key's `expiresAt` is null and its
   `state` is `active`, which is the byte-identical claim restated where a reader of that file will
   see it.
2. **`docs/api/openapi.json` and `packages/api-client/src/generated.ts`** are regenerated build
   products, per ADR-0053's procedure. The whole diff is the new optional `expiresAt` on the
   issuance request body.
3. **`AUTH_REFUSAL_DETAIL`** (new, in `auth.ts`) is the single home for the holder-facing wording of
   all five refusals. Both the route hook and `login-with-key` previously carried their own inline
   ternaries over ADR-0066's pair, which had already drifted into two different sentences for the
   same credential state; adding two more refusals to two hand-written ternaries would have made
   that worse.
4. **No SPA surface.** `state` is API-only in this slice, per the cloud/local session split in
   `docs/CONTRIBUTING_PARALLEL_SESSIONS.md`.
