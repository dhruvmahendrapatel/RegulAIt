# ADR-0034 — Admin-registered custom LLM providers, behind a default-deny egress guard

- **Status**: Accepted
- **Date**: 2026-08-01
- **Relates to**: ADR-0009 (stack), ADR-0015 (BYOC / air-gapped deploy modes), ADR-0021
  (`org_settings` configurability layer), ADR-0023 (`agents.systemPrompt` invariant in the one
  dispatch core), ADR-0024 (key custody), ADR-0031 (P0 hardening)
- **Migration**: 0048 (`custom_model_providers`, `egress_allow_hosts`, `agents.custom_provider_id`,
  `org_settings.custom_model_providers_enabled`)

## Context

The owner asked for "the ability for users to plug in their own LLM". Investigation found the
capability was **half-built and unreachable**:

- **BYO keys already worked.** Platform `model_credentials` (migration 0016) and per-user
  `user_model_credentials` (migration 0017) both exist, both encrypt under `REGULAIT_DATA_KEY`,
  and per-user precedence is applied at dispatch.
- **`baseUrl` already existed** on both credential tables and was already plumbed through all four
  adapters in `packages/model-provider` (Anthropic, OpenAI, Google, xAI each accept an override).
- **But the provider set was a closed zod enum** — `z.enum(["anthropic","openai","google","xai"])`
  — so there was no way to name Ollama, vLLM, LM Studio, LocalAI, Azure OpenAI, a Bedrock proxy,
  or any internal gateway. The plumbing was built and simply had no door.
- **`agents` had no per-agent endpoint**, so a URL was a property of a provider *kind*. Two
  self-hosted models on two different hosts was inexpressible.

This also made **pillar 3's air-gapped deployment mode hollow**: a mode whose every supported
model provider is an internet SaaS is not an air-gapped mode.

**Locked with the user before implementation: registration is ADMIN-ONLY**, not per-user
self-service.

### The part that dominated the design

**An admin-suppliable `baseUrl` is a Server-Side Request Forgery primitive**, and pretending
otherwise would have shipped a governance product with a hole in the middle of it. The gateway
runs on EC2. Pointed at

```
http://169.254.169.254/latest/meta-data/iam/security-credentials/
```

it will issue the request and hand back the response — which is the instance role's AWS
credentials. The same applies to anything routable from the VPC and to `localhost` services on the
box (Postgres is on the compose network). "Only an admin can set it" is **not** a mitigation: an
admin account is precisely what an attacker escalates to, and an admin who is phished into pasting
a URL is the ordinary case, not the exotic one.

The tension is real, not theoretical: the air-gapped and local-dev cases the product *promises*
need `http://localhost:11434` (Ollama) and `http://vllm.internal:8000` — exactly the destinations
an SSRF guard exists to block. A guard that forbids them is unusable; a blanket "allow http and
private ranges" is no guard at all.

## Decision

### 1. Schema (migration 0048)

`custom_model_providers` — admin-defined, named endpoints:

| column | notes |
| --- | --- |
| `id`, `name` (UNIQUE) | the label that appears wherever a provider name appears |
| `wire_protocol` | `openai_chat` \| `anthropic_messages`, DB CHECK-constrained |
| `base_url` | the endpoint root |
| `key_ciphertext` | **NULLABLE** — AES-256-GCM under `REGULAIT_DATA_KEY` when present |
| `allow_plaintext_http` | default **false** — the provider half of the plaintext opt-in |
| `enabled` | default **false** — registration does not enable |
| `last_tested_at`, `last_test_error` | only a PASS writes `last_tested_at`; it is what the enable gate reads |
| `created_by`, `created_at` | |

`key_ciphertext` is nullable **on purpose**: a local Ollama / LocalAI endpoint has no API key at
all, and minting a placeholder would make "is this endpoint authenticated?" permanently
unanswerable.

`egress_allow_hosts` — the allow-list: `host` (UNIQUE, normalized by a DB CHECK to lowercase, no
trailing dot, no whitespace/`@`/`/`), `allow_private_ranges` (default false),
`allow_plaintext_http` (default false), `note`, `created_by`, `created_at`. There is deliberately
**no wildcard column**: `*.example.com` is one dangling subdomain takeover away from being a hole,
and an operator who needs three hosts can add three rows.

### 2. How an agent binds to a custom provider — and why it is an FK, not an encoded string

`agents` gains a nullable `custom_provider_id` FK (`ON DELETE RESTRICT`), and `provider` gains the
single new literal `'custom'`. The pair is a **discriminated union enforced by the database**:

```sql
CHECK (("provider" = 'custom') = ("custom_provider_id" IS NOT NULL))
```

The alternative — encoding `custom:<uuid>` inside the existing `provider` text column — was
rejected because `provider` is a **closed vocabulary that four other things depend on**:
`model_credentials` is UNIQUE per provider, `usage_events.provider` records it, the ADR-0021
env-fallback allow-list enumerates it, and `isModelProviderKind()` switches over it exhaustively
(so a new kind forces a compile error, by design). Smuggling an id through that column would
silently poison every one of them. `ON DELETE RESTRICT` rather than cascade or set-null: an
endpoint an agent still points at must not vanish underneath it, and a dispatch must never
silently degrade to "no endpoint".

### 3. The adapter implements no protocol of its own

`CustomProvider` in `packages/model-provider`:

- `openai_chat` → the **existing** `dispatchChatCompletions` core (already shared by OpenAI and
  xAI) aimed at the admin's `baseUrl`;
- `anthropic_messages` → the **existing** `AnthropicProvider` aimed at the admin's `baseUrl`.

Streaming (which the SPA needs for SSE), refusal discipline, tool calls, and usage accounting are
therefore identical to the shipped adapters *by construction* rather than by re-implementation.
The only genuinely new behaviour on this path is **where the bytes go** — which is exactly the
part the guard governs.

**Keyless endpoints**: the OpenAI SDK refuses to construct without an `apiKey`, so a sentinel is
passed and the `Authorization` header is then **deleted outright** (openai-node treats a null
default header as "remove"). A keyless endpoint therefore sees *no credential header at all*,
rather than a request quietly shipping the string `regulait-keyless` to whatever the admin pointed
us at. This is asserted on the wire in both the unit and e2e suites.

### 4. THE EGRESS GUARD (`apps/gateway/src/egress-guard.ts`)

Default-deny, twice over, and re-evaluated continuously.

**Blocked by default (every resolved address is checked, not just the literal):**

- IPv4: `0.0.0.0/8`, `10/8`, `100.64/10` (CGNAT), `127/8`, **`169.254.0.0/16` (link-local — IMDS)**,
  `172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`, `224/4` (multicast), `240/4` (reserved).
- IPv6: `::`, `::1`, `fe80::/10`, `fc00::/7`, `ff00::/8`, plus **`::ffff:0:0/96` IPv4-mapped and
  `64:ff9b::/96` NAT64, which are unwrapped and re-checked against the IPv4 rules** (the
  `[::ffff:169.254.169.254]` bypass).
- Host suffixes: `.internal`, `.local`, `.localhost`, `.home.arpa`, and bare `localhost`.
- Any scheme other than `http`/`https`.
- **URL userinfo is refused outright** (`user:pass@host`). `http://169.254.169.254@evil.com/` and
  `http://evil.com@169.254.169.254/` differ only in which side of the `@` the real host is, and
  the pair exists to fool a human reviewer. No OpenAI-compatible endpoint needs credentials in the
  URL, so the safe reading of an ambiguous URL is "reject it".
- **An address the guard cannot classify fails CLOSED.**

**Alternate encodings** (`http://2852039166/`, `0xa9fea9fe`, `0251.0376.0251.0376`, `169.254.43518`)
are normalized by the WHATWG URL parser to a dotted quad *before* classification, so a decimal
IMDS address is the same host as a dotted one — proven in the suite rather than assumed. Trailing
dots are stripped and hosts are lowercased/punycoded at both storage and comparison time, so
`Metadata.Google.Internal.` cannot be a different string from `metadata.google.internal`.

**The admin escape hatch — explicit, per-host, off by default, audited:**

- `egress_allow_hosts.allow_private_ranges` lets **that one host** resolve into an otherwise
  blocked range. It does not relax the https requirement.
- Plaintext http requires **two** opt-ins: `egress_allow_hosts.allow_plaintext_http` **AND**
  `custom_model_providers.allow_plaintext_http`. One flag is a typo; two flags are a decision.
- Every allow-list write is audited, and the audit reason names the opt-ins explicitly
  ("… WITH private-range access WITH plaintext http").

So `http://localhost:11434` (Ollama) works — after an admin adds `localhost` with
`allowPrivateRanges` and `allowPlaintextHttp`, and sets the provider's own plaintext flag. That is
three deliberate acts, all on the record. It is not reachable by accident.

**When the guard runs:**

1. at registration (earliest honest failure — a bad endpoint is a 400, not a surprise later);
2. **again on every dispatch** (`resolveCustomProviderForDispatch`), because a registration-time
   verdict is not a fact about the future — DNS can be re-pointed after approval, the allow-list
   can be withdrawn, the provider can be disabled;
3. **again inside the guarded fetch, per HTTP request.**

**Redirects are refused entirely**, not re-validated per hop. A 302 to `http://169.254.169.254/` is
the shortest path around any pre-flight check, and following-then-checking means the socket to the
redirect target is already open by the time we look. Re-validating each hop would also work, but no
OpenAI-compatible or Anthropic-Messages endpoint requires a redirect to function, so the stricter
and cheaper rule wins: any 3xx is a hard error with an honest message, and an admin whose endpoint
really redirects points `baseUrl` at the final destination.

**Errors are not flattened.** openai-node/@anthropic-ai/sdk turn a throwing `fetch` into
`APIConnectionError("Connection error.")`, which would reduce a governance decision to a network
blip. `ModelProviderError` now carries `cause`, and `egressRefusal()` walks the chain so a guard
refusal surfaces as a **403 `egress_blocked` with the real reason**, audited.

### 5. Everything true of a governed dispatch stays true

The custom branch lives *inside* `executeGovernedDispatch`, after the entitlement/routing decision
and after the project-budget and PII gates. Policy-kernel evaluation, per-user entitlement, audit,
PII handling, per-run budget ceilings, and cost attribution are **inherited, not reimplemented**.
The branch contributes exactly two things: a validated destination and a guarded fetch.

`configuredProviders()` gains a subtlety worth naming: every other entry in that set is a provider
*kind*, because one stored key makes every agent of that kind servable. A custom endpoint is not
like that — two agents can both be `provider: 'custom'` while one points at a live endpoint and
the other at a disabled one. So the token is `custom:<uuid>` (`agentProviderToken()`), and only
**enabled** endpoints get one. Routing therefore never lands on an agent whose specific endpoint
is off, and when the org master switch is off, no token is emitted and every custom agent is
correctly seen as unservable.

### 6. Cost: unpriced stays unpriced

A self-hosted endpoint has no list price, so `agents.costPerMTokIn/Out` stay null. The existing
discipline already does the right thing and is now covered for this case: `costOf()` returns null
for an unpriced agent, `routeModel` **passes through** when the baseline is unpriced ("savings
incomparable") and **skips unpriced candidates entirely** as routing targets. The measured ledger
records real token counts with `costUsd: null`. **No pricing is fabricated anywhere**, and the
optimizer never claims savings against a custom model.

### 7. Admin toggle

`org_settings.custom_model_providers_enabled`, default **true**. It is the "remove the capability
entirely" switch, not the thing standing between an org and an open proxy — the capability is
already default-deny four separate ways beneath it (admin-only registration, an empty allow-list,
`enabled=false` until a connection test passes, and the ordinary per-user agent grant). Off refuses
registration and enablement and stops every custom dispatch with a 409, with no request leaving the
box.

### 8. Endpoints (all admin-only; none appear in `NON_ADMIN_ROUTES`)

```
GET    /v1/custom-model-providers
POST   /v1/custom-model-providers            # registers DISABLED; pre-flights the URL
PATCH  /v1/custom-model-providers/:id        # moving the endpoint re-arms the gate
POST   /v1/custom-model-providers/:id/test   # real dispatch through the guard
POST   /v1/custom-model-providers/:id/enabled
DELETE /v1/custom-model-providers/:id        # 409 while any agent still points at it
GET    /v1/egress-allow-hosts
POST   /v1/egress-allow-hosts                # upsert by host, audited
DELETE /v1/egress-allow-hosts/:hostId
```

The key is **never returned** by any route — the read projection omits `key_ciphertext`
structurally and reports only `hasApiKey`. Refusals are honest: a failed connection test is a real
502 carrying the upstream's own message, never an optimistic 200; enabling an untested provider is
a 409 `connection_test_required`. Changing `baseUrl` or the plaintext flag **disables the provider
and clears `last_tested_at`**, so the connection test cannot be passed once and then edited around.

### 9. Audit

- **registration / update / enable / disable / removal** — `custom-provider-registered`,
  `-updated`, `-enabled`, `-disabled`, `-removed`;
- **allow-list writes** — `egress-allow-host-set` / `-removed`, reason naming the private-range and
  plaintext opt-ins;
- **connection tests** — `custom-provider-tested` / `-test-failed`;
- **every dispatch** — `custom-provider-dispatch`, recording protocol, **destination host**, port,
  **every resolved address**, provider name, wire protocol, model, credential source and project.
  The destination also rides the `usage_events.detail.egress` object;
- **every refusal** — `custom-provider-egress_blocked`, `custom-provider-egress-blocked` (blocked
  mid-flight), `custom-provider-custom_providers_disabled`, etc., all with `effect: "deny"`.

New audit `objectType`: `custom_model_provider` (TS-only enum extension — plain text column, no
DDL).

## Consequences

### Easier

- Any OpenAI-compatible or Anthropic-Messages-compatible endpoint is now reachable: Ollama, vLLM,
  LM Studio, LocalAI, Azure OpenAI, Bedrock proxies, internal gateways.
- Pillar 3's air-gapped mode has a real model story for the first time.
- Two self-hosted models on two different hosts are expressible (per-agent endpoint, not
  per-kind).
- The gateway now has a **reusable, unit-tested SSRF guard** where it previously had none.

### Harder / given up

- Registering a provider is now a **three-step ceremony** (allow-list the host → register →
  connection test → enable). That is deliberate friction on the one surface that can point the
  gateway at the inside of its own network.
- No wildcard allow-list entries. An org with many internal hosts adds many rows.
- No per-user custom providers. Locked with the user; per-user would mean any user could choose
  the gateway's destination.

## WHAT THIS DOES **NOT** MITIGATE — read this part

Stated plainly, because a half-closed guard described as closed is worse than an open one
described honestly.

1. **The https DNS-rebinding TOCTOU is NOT closed.** For plaintext **http** the request is pinned:
   after validation the URL host is rewritten to the validated IP literal and the original hostname
   is sent in the `Host` header, so no second resolution happens and a rebind cannot move the
   connection. For **https** it is not pinned — rewriting to an IP literal breaks SNI and
   certificate verification, and Node's global fetch exposes no supported hook for supplying a
   pinned `lookup` while keeping the original `servername`. An https destination is therefore
   validated immediately before each request and then resolved a second time by the TLS stack. A
   rebind inside that sub-millisecond window is not prevented. It is materially harder to exploit
   than the http case (the attacker must also present a certificate valid for the allow-listed
   hostname), but it is a **real residual**. Closing it needs a pinned-`lookup` dispatcher
   (`undici.Agent` with `connect: { lookup, servername }`), which is a dependency decision, not a
   code tweak. **Follow-up.**
2. **The pre-existing `model_credentials.baseUrl` / `user_model_credentials.baseUrl` overrides are
   NOT behind this guard.** They are an equivalent SSRF primitive, they predate this ADR (migrations
   0016/0017), and several existing e2e suites depend on pointing them at `127.0.0.1`. Bringing them
   behind the allow-list is the obvious next step and is a **known, disclosed gap** — not something
   this ADR closed. **Follow-up.**
3. **The allow-list does not constrain paths, ports or methods.** An allow-listed host is reachable
   on any port and any path. If an internal host is deliberately allow-listed with
   `allowPrivateRanges`, everything that host serves is reachable by an admin who can edit
   `baseUrl`. Per-host port/path constraints are not implemented.
4. **An admin who can edit the allow-list can defeat the guard.** That is inherent — the allow-list
   is the trust root. What the design provides is that doing so is **explicit, per-host, and
   audited**, so it is visible after the fact rather than implicit in a URL string.
5. **Response content is not inspected.** The guard governs the destination, not what comes back.
   A permitted endpoint returning attacker-chosen model output is out of scope here (PII handling
   and refusal discipline apply as they do to every provider).
6. **No egress rate limiting or timeout policy** specific to custom providers; they inherit the
   ambient defaults.
7. **`anthropic_messages` with a keyless endpoint** passes the sentinel as `x-api-key` rather than
   deleting the header (the Anthropic SDK offers no equivalent removal). No known deployment has
   that shape; documented rather than silently handled.

## Evidence

- **Adversarial SSRF suite** (`egress-guard.test.ts`, 48 tests): decimal/octal/hex/short-form IMDS
  encodings, `[::ffff:169.254.169.254]`, hostnames resolving to link-local, split DNS answers where
  only one address is blocked, redirect-to-IMDS, the `user@host` ambiguity pair both ways,
  trailing-dot FQDNs, uppercase and unicode host variants, `.internal`/`.local` suffixes, the
  Postgres-on-the-compose-network shape, non-http schemes, resolver failure, and per-request
  re-validation of a host that is re-pointed after approval. **Genuinely red before the guard: 45
  of 48 fail against a naive string-check implementation; 48/48 green after.**
- **e2e** (`custom-providers.test.ts`, 20 tests): a real local OpenAI-compatible server, the real
  adapter, the real guard — the suite must add an explicit `127.0.0.1` allow entry with both
  opt-ins, exactly as an air-gapped operator would. Covers default-deny before registration, IMDS
  refusal even when allow-listed, register→test→enable, endpoint-move re-arming the gate,
  admin-only 403s, a full governed dispatch with the usage row + destination-host audit row,
  `costUsd: null`, provider-disabled / org-switch-off / allow-list-withdrawn all stopping cold with
  zero requests leaving the box, the keyless (no `Authorization` header) path, an honest 502 on a
  failing endpoint, and redirect refusal.
- **Suite**: workspace **1585 → 1658**, gateway **881/69 files → 949/71 files**. Delta **+73** =
  48 egress-guard + 20 custom-providers (gateway) + 5 CustomProvider adapter tests
  (model-provider). Zero pre-existing tests changed.
- `pnpm -r build` clean; migration 0048 applies cleanly on boot against a freshly created database.

---

## Amendment — 2026-08-01: disclosed gap #2 is closed (credential `baseUrl` overrides)

- **Status of the amendment**: Accepted
- **Migration**: none. No DDL. One TS-only `auditLog.objectType` extension
  (`model_credential`), the same plain-text-column pattern ADR-0034 itself used for
  `custom_model_provider`.

### What was still open, and how bad it actually was

"WHAT THIS DOES **NOT** MITIGATE" item 2 above said the pre-existing
`model_credentials.baseUrl` / `user_model_credentials.baseUrl` overrides (migrations 0016/0017)
were "an equivalent primitive still outside the guard". They were, and re-reading it with the
exploit in hand it was worse than the phrasing suggests:

- The destination was settable through the **shipped** model-credential endpoints, and
  `POST /v1/users/:userId/model-credentials` is in `NON_ADMIN_ROUTES` — so this was **not**
  admin-only. Any authenticated user could set their own credential's `baseUrl` to
  `http://169.254.169.254/latest/meta-data/iam/security-credentials/` and, on the next dispatch of
  any agent of that provider, have the gateway fetch the EC2 instance role's AWS credentials on
  their behalf. The per-user row takes **precedence** over the platform one, so it did not even
  need the platform slot to be empty.
- Everything routable from the VPC was reachable the same way, Postgres on the compose network
  included.
- The `*_BASE_URL` env fallbacks (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, …) land in the same
  variable at dispatch and were equally unguarded.

This was live in deployed code, not a design gap.

### Decision

**Route every credential `baseUrl` override through the existing guard — no second mechanism.**
`apps/gateway/src/credential-egress.ts` is a thin adapter onto `checkEgress` /
`createGuardedFetch` and the **same** `egress_allow_hosts` table with the **same** per-host
`allow_private_ranges` / `allow_plaintext_http` opt-ins. There is one egress policy and one place
to reason about it.

It runs at **both** moments, deliberately:

1. **Write time** — `POST /v1/model-credentials` and `POST /v1/users/:userId/model-credentials`
   refuse a non-allow-listed destination with a **400 `egress_blocked`** naming the reason, and
   audit the attempt (`ruleId: model-credential-egress-blocked`, `effect: deny`). Checked *after*
   the ADR-0024 key-custody gate, so the more specific refusal still wins.
2. **Every dispatch** — inside `executeGovernedDispatch`, before the adapter is constructed. A
   write-time verdict is not a fact about the future (DNS moves, the allow-list can be withdrawn)
   **and rows written before this guard existed are in the live database right now**. A refused
   dispatch is a 403 `egress_blocked`, audited, with nothing leaving the box.
3. The resulting adapter gets `createGuardedFetch`, so every HTTP request the SDK makes is
   re-validated, plaintext http is pinned to the validated address with the original `Host`
   header, and **redirects are refused** — a 302 to IMDS from an approved endpoint does not work.

**No override means no check.** With `baseUrl` null the adapter uses its compiled vendor endpoint,
which nobody can type; requiring an allow entry for `api.anthropic.com` would be ceremony, not
security. Every non-overriding deployment is byte-identical, down to the fetch implementation.

### Pre-existing rows: refused, never rewritten

A row holding a now-invalid `baseUrl` keeps it. Nothing is migrated, back-filled or nulled. It is
**refused at dispatch** with an honest 403 until an admin either allow-lists the host or clears
the override. Silently nulling stored operator configuration would be a worse failure mode than
refusing it loudly, and a null there would be indistinguishable from "never had one". This is
asserted in the suite by inserting such a row directly into Postgres and dispatching through it.

### One deliberate difference from the custom-provider path

A custom provider carries its own `allow_plaintext_http`, so plaintext http there needs **two**
opt-ins. A credential row has no such column and this change adds **no migration**, so plaintext
http to a credential `baseUrl` is gated by the host entry's `allow_plaintext_http` **alone** —
still explicit, per-host, admin-only and audited, but one opt-in rather than two. Recorded here
rather than left to be discovered.

### Compatibility: how many suites were pointing at loopback

**Five existing suites** had to add an explicit `127.0.0.1` allow entry with the private-range and
plaintext opt-ins — exactly the sequence an air-gapped operator performs, and exactly what
`custom-providers.test.ts` already did:

| suite | why |
| --- | --- |
| `mcp-proxy.test.ts` | openai/google/xai adapter e2e + BYO-key precedence, all against local fakes |
| `interception-depth.test.ts` | ADR-0024 key-custody precedence, platform vs user fake endpoints |
| `credentials-keys.test.ts` | stores overrides for the read-back projection |
| `env-fallback.test.ts` | `ANTHROPIC_BASE_URL` fallback |
| `org-settings.test.ts` | `envKeyFallbackEnabled` |

Three `.invalid` / public-hostname fixtures were re-pointed at an allow-listed **loopback dead
port**: the guard *resolves* every destination, so a public hostname would have made CI depend on
DNS and a `.invalid` one fails closed — which would have masked what those tests actually assert
(that the credential gate was passed and the failure happens at the provider). No assertion was
weakened and no guard behaviour was relaxed to make a test pass. Two suites that assert *refusal*
(`custom-providers.test.ts`, the new `credential-egress.test.ts`) now start from an emptied
`egress_allow_hosts`, because a file whose subject is "what is refused" must not inherit a sibling
suite's allow entry from the shared database.

That five is itself the finding: five separate places in this codebase were quietly steering the
gateway's model traffic at a host of their choosing.

### Enumeration of the other outbound surfaces (asked for, answered, mostly NOT fixed)

Scope creep on a security fix is its own risk, so this PR fixes the disclosed gap and **reports**
the rest. Every one of these was checked against the code that actually issues the request:

| surface | who can set it | reaches the network? | status |
| --- | --- | --- | --- |
| `model_credentials.baseUrl` | admin | yes, model dispatch | **GUARDED (this amendment)** |
| `user_model_credentials.baseUrl` | **any user, own row** (`NON_ADMIN_ROUTES`) | yes, model dispatch | **GUARDED (this amendment)** |
| `ANTHROPIC_/OPENAI_/GOOGLE_/XAI_BASE_URL` env fallback | operator (process env) | yes, model dispatch | **GUARDED** — it lands in the same variable, so it came along for free |
| `connectors.baseUrl` + `connector_credentials.baseUrl` | admin | **yes** — `resolveConnectorProvider` → generic/http/**webhook**/slack/github/jira/snowflake all fetch it | **EXPOSED.** Same primitive. The `webhook` kind is worse than a read: it **POSTs the payload** to the URL, so it is an exfiltration channel as well as an SSRF one. Guardable with the same call; left out only to keep this PR to one surface. **Highest-priority follow-up.** |
| `git_connections.baseUrl` | admin | **yes** — GitHub/GitLab/Bitbucket/Azure-DevOps adapters | **EXPOSED.** Same shape, same fix would apply. |
| `pm_connections.baseUrl` | admin (the SPA exposes the field) | **yes** — Jira/ADO/Linear/Asana/monday/generic-webhook adapters, `generic_webhook` again POSTs | **EXPOSED.** |
| `mcp_servers.url` | admin | **yes** — `connectUpstream(serverRow.url)` | **EXPOSED, and needs its own design.** Internal MCP servers are a *legitimate and common* deployment (that is the point of a self-hosted tool server), so a default-deny host allow-list here would break the ordinary case rather than an exotic one. It needs a decision about what the default posture is, not a one-line call. **Do not bolt the same check on without that decision.** |
| `oidc_providers.issuerUrl` | admin | **yes** — OIDC discovery, and `auth.ts` explicitly enables `allowInsecureRequests` for `http://` issuers | **EXPOSED.** Narrower (fires on the login path, response is parsed as OIDC metadata rather than returned raw) but it is still an admin-typed URL the server fetches. |
| `deploy_targets.baseUrl` | admin | **no** — the column is read into `ResolveDeployProviderConfig.baseUrl` and no deploy adapter (aws/azure/gcp/kubernetes/mock) ever issues a request with it | **INERT today.** Guarding it would guard nothing; it becomes live the day an adapter uses it. |
| infra adapters (`infra-provider`) | — | cloud SDKs to fixed vendor endpoints | not an admin-typed destination; out of scope |

Nothing above is *fixed* by this PR except the three marked GUARDED. They are named so the next
decision is informed rather than blind.

### What is STILL not mitigated

Every item in "WHAT THIS DOES **NOT** MITIGATE" above still stands except #2, which this amendment
closes. In particular:

1. **The https DNS-rebind TOCTOU is still open, on this path too.** This change reuses
   `createGuardedFetch` unchanged: http destinations are pinned to the validated address, https
   destinations are validated immediately before each request and then resolved a second time by
   the TLS stack. **This PR does not implement the `undici.Agent` with `connect: { lookup,
   servername }` that would close it, and therefore closes none of it.** The credential paths
   inherit exactly the same open window as the custom-provider path. Said plainly so this change
   is not read as closing more than it does.
2. **Ports and paths are still unconstrained** on an allow-listed host.
3. **An admin who can edit `egress_allow_hosts` is still the trust root.**
4. **The connector, git, PM, MCP and OIDC surfaces enumerated above remain exposed.**

### Evidence

- `credential-egress.test.ts`, **11 tests**: platform credential at IMDS refused at **write** time
  (and still refused when the IMDS address is itself allow-listed **with** the plaintext opt-in —
  the range check is what stops it); per-user credential at IMDS refused for the user's own row;
  `.internal` suffix, `user@host` ambiguity, `db:5432`, non-http scheme; a **pre-existing row
  inserted directly into Postgres** refused at **dispatch** with zero requests leaving the box and
  its `baseUrl` left intact; the same for a per-user row; a hostname that **resolves** to
  link-local refused (and split-DNS: one good answer does not launder a bad one); the allow-listed
  loopback endpoint dispatching end-to-end with the pinned `Host` header; **withdrawing** the
  allow entry stopping the very next dispatch; an approved endpoint that **302s to IMDS** refused
  mid-flight; and a credential with no `baseUrl` untouched.
- **Suite**: workspace **1658 → 1669**, gateway **949/71 files → 960/72 files**. Delta **+11**,
  all of it `credential-egress.test.ts`. **Zero pre-existing tests changed** — five suites gained
  an allow-list entry in `beforeAll` and three fixture URLs moved, no assertion was altered.
- `pnpm -r build` clean; full `pnpm -r test` green on a freshly dropped/recreated `regulait_test`.
