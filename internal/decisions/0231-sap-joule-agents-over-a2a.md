# ADR-0231: SAP Joule agents as governed remote agents through SAP Agent Gateway (A2A)

- **Status**: Proposed
- **Date**: 2026-11-06

## Context

The owner put P20 at the top of the post-demo backlog on 2026-11-03, together with P19 (ADR-0230;
[internal/product/PENDING.md](../product/PENDING.md) §2e). SAP exposes Joule agents to third-party clients through
its Agent Gateway over the A2A protocol. RegulAIt already governs A2A remote agents
([ADR-0219](0219-a2a-governance.md)): `executeGovernedA2aCall` in `apps/gateway/src/a2a.ts` is the single choke point,
with a default-off org setting (`a2a_enabled`), admin-only registration, per-person grants (`a2a_agent_grants`), the
lead ceiling, the egress guard, a static credential (`a2a_agent_credentials`), the project budget gate and PII mode,
and one audit plus one usage row per allowed call. It uses `@a2a-js/sdk` 1.3.0, client half only.

Two gaps block Joule (PENDING.md P20):

1. **Transport binding.** Our client accepts only cards with a JSON-RPC interface (`a2a.ts` filters
   `supportedInterfaces` to `protocolBinding === "JSONRPC"` on the registered origin, and builds the client with
   `JsonRpcTransportFactory` only). SAP's gateway is reported to speak A2A 0.3.0 over HTTP+JSON.
2. **Credentials.** We hold one static header per agent. SAP needs a client-credentials token for discovery and a
   user-bound token to invoke an agent, because the Joule agent acts within the person's own SAP authorisations.

### Sources

Checked 2026-11-06. **Verified** means the page was fetched and says it. **Unverified** means it was not.

- [SAP Architecture Center news, 2026-10-27, "A2A Agent Gateway interoperability"](https://architecture.learning.sap.com/news/2026/10/27/a2a-agent-gateway-interoperability):
  - inbound A2A (an external client calls an SAP agent) is GA as of October 2026;
  - outbound A2A and outbound MCP are "future direction", with no date;
  - discovery is through ARD, as a tenant-scoped catalogue filtered by the customer's ACL, where each entry gives the
    identifier, type, version and AgentCard URL;
  - a client-credentials technical token is for discovery only, and invoking an agent needs a user-bound token;
  - setup is SAP for Me registration as an "Agent Gateway Consumer" (which alone grants no access), then three
    formations;
  - on every call the gateway validates the token, resolves the tenant and checks the ACL.

  **Verified.**
- [Ref-arch 76ec36, "A2A and MCP at SAP"](https://architecture.learning.sap.com/docs/ref-arch/76ec36) and
  [ref-arch fe0d1d](https://architecture.learning.sap.com/docs/ref-arch/fe0d1d):
  - "A2A 0.3.0 specification with HTTP+JSON transport", and JSON-RPC is not mentioned;
  - runtime tokens are SAP Cloud Identity Services (IAS) App2App tokens with named user context;
  - bring-your-own-agent uses `message/send`, text parts only, a 60-second synchronous wait, async results by push
    notification to a webhook Joule provides, and IAS App2App trust.

  **Verified.** Both pages (updated 2026-10-26) still say bidirectional communication with third-party agents "is not
  yet supported". That conflicts with the news post. We read it as: inbound is GA, bidirectional is not.
- [Ref-arch f4a2c8, token exchange](https://architecture.learning.sap.com/docs/ref-arch/f4a2c8):
  - the user-bound token comes from IAS with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` (RFC 7523), with
    the incoming user token as `assertion` and `resource` naming the SAP target;
  - client authentication is mTLS, a client secret or a jwt-bearer client assertion;
  - autonomous agents use client credentials with `impersonate_assigned_user=true`;
  - a corporate IdP is an optional federated login source;
  - the page says parts are "still in preparation" and the steps are transitional.

  **Verified.** This is **not RFC 8693** token exchange, although P20 and the lane brief assumed RFC 8693. Section 4
  takes this into account.
- [Ref-arch 140bdb](https://architecture.learning.sap.com/docs/ref-arch/140bdb): agent identity in IAS is OIDC,
  including federation with third-party IdPs; the policy enforcement point "will be released in H2/2026". **Verified.**
- [ARD specification](https://github.com/ards-project/ard-spec) (Apache-2.0, v0.91): `/.well-known/ard.json`,
  `POST /search`, optional `POST /explore` and `GET /agents`; entries need `identifier`, `displayName`, `type` and
  `url` or `data`. **Verified.** SAP's own ARD endpoint paths (an SAP Help page) are **unverified**.
- SAP Community, "Integrating Joule with Code-based Agents: Three Paths Forward": the fetch returned 403, so only the
  search snippet was seen. It says direct A2A works for pro-code agents only, synchronous calls time out at 60 seconds,
  and longer work uses an async REST pattern. **Unverified.**
- `@a2a-js/sdk` (npm registry and the repo's CHANGELOG and README):
  - 1.3.0 (2026-09-29, Apache-2.0) is the latest, and the one we pin;
  - a REST client landed in 0.3.7;
  - 1.0.0 implements A2A v1.0 over JSON-RPC, HTTP+JSON and gRPC;
  - talking to a **0.3.0** server needs the opt-in compatibility layer: `@a2a-js/sdk/compat/v0_3/client`
    (`LegacyRestTransport`, a transport class; see §3 for how it is plugged in).

  **Verified** from the changelog. Not yet exercised against SAP.

## Decision

### 1. Joule agents are ordinary governed A2A agents

No new choke point. A Joule agent is a row in `a2a_agents` with `provider = 'sap_agent_gateway'` (new column, default
null), registered and called through `executeGovernedA2aCall` with every ADR-0219 check in the same order: org setting,
agent and skill, lead ceiling, the person's grant, project attribution and budget, PII mode, egress, credential. The
SAP-specific parts are discovery, the binding and the token, each below.

### 2. Discovery: ARD catalogue import, admin-only

- An admin registers one **SAP Agent Gateway connection** (new table `a2a_gateway_connections`: base URL, token
  endpoint, client id, encrypted client secret or client certificate reference, audience). Creating it, changing its
  URL or secret, and deleting it are admin-only, `settings_relax` step-ups, and audited. The URL goes through the
  egress decision at write time and call time, as for any remote agent.
- **Import** (`POST /v1/a2a/gateway-connections/:id/import`): the gateway gets a client-credentials token (section 4),
  reads the gateway's agent catalogue (ARD) through the guarded fetch, and lists the AgentCards the customer's SAP ACL
  allows this client to see. The admin picks which to register; nothing is auto-registered. Each chosen card goes
  through the existing card checks (size cap 60 kB, interfaces only on the registered origin, refusal otherwise).
- **Refresh** re-reads the catalogue and each card. **A changed card never replaces the stored card on its own.**
  - **Where it goes:** the new card is held as `a2a_agents.pending_card`, together with a diff of skills and
    interfaces, and the change is audited.
  - **What stays in use:** the stored `card` remains the one calls use until an admin accepts the change. `a2a.ts`
    already builds the client from the stored `agent.card`, and that does not change.
  - **Accepting:** acceptance re-runs every card check on the new card (size, origin and version) before it becomes
    the stored card. If it adds a skill or an interface, acceptance is a `settings_relax` step-up.
  - **New skills:** they are not callable until someone is granted them; grants on the existing skills stay as they
    were.
  - **Removals:** a skill or interface that disappears stops being callable at once, because narrowing needs no
    review.
  - **Gone from the catalogue:** the agent is disabled, not deleted, and that change is audited.
- Discovery calls are audited (`a2a-gateway-discovery`), not costed.

### 3. The HTTP+JSON binding

- Accept an interface whose `protocolBinding` is `HTTP+JSON` (the A2A REST binding) in addition to `JSONRPC`, under the
  same rule: only on the registered origin, everything else filtered out before the client is built.
- **Legacy (0.3) cards.** A 0.3 card has no `protocolBinding`. It uses `url`, `preferredTransport` and
  `additionalInterfaces[].transport`, and its `protocolVersion` is per card, where 1.0 has it per interface.
  - **The problem:** `cardProblem` and `clientCard` call `AgentCard.fromJSON`, which yields no interfaces for a legacy
    card. Registration would therefore refuse every Joule card today.
  - **Detect and convert:** registration and refresh detect a legacy card with the SDK's `isLegacyAgentCard` and
    convert it with `parseLegacyAgentCard`.
  - **Store:** they keep the normalised card, its original version (`a2a_agents.card_protocol_version`) and a hash
    of the raw legacy card.
  - **Check:** the origin, size and binding checks then run on the normalised card.
  - **Confirm the names:** slice B0 confirms the exact export names at the pinned version.
- **Open source first**: the pinned `@a2a-js/sdk` 1.3.0 already ships the HTTP+JSON client. We write no transport.
  There is no version bump.
  - **1.x cards:** `ClientFactory` gets `transports: [JsonRpcTransportFactory, RestTransportFactory]` and
    `preferredTransports` set to JSON-RPC and then HTTP+JSON. Both factories are given our guarded fetch.
  - **0.3.x cards:** the v0.3 compatibility export is a transport class (`LegacyRestTransport`), not a factory option.
    The gateway therefore builds `LegacyRestTransport` directly with the stored interface url and `fetchImpl` set to
    our guarded fetch. It hands the result to the SDK client through a small factory registered under the `HTTP+JSON`
    binding. That is a few lines of glue over the SDK's own transport, not a new transport.
- **Version.** SAP speaks A2A **0.3.0**; the 1.x SDK speaks 1.0 by default. Whether a call uses the legacy transport is
  decided from the stored `card_protocol_version`, never from a header the remote sends at call time. Registration records the card's
  `protocolVersion`. Any version other than 0.3.x and 1.x is refused, with an audited reason, rather than guessed.

### 4. Per-user OAuth: two token kinds

New credential kinds on `a2a_agent_credentials` (and on the gateway connection), stored like the existing ones (data-key
envelope, listed in `CIPHERTEXT_COLUMNS`, never returned, last four characters only):

- **`oauth_client_credentials`** — used only for discovery (section 2). The token is cached per connection until a
  minute before expiry; never sent to an agent endpoint for a message.
- **`oauth_user_token`**: used for every message. For each call, the gateway gets a user-bound token at the configured
  token endpoint. The grant is set per connection:
  - **`jwt_bearer`** (RFC 7523, the default for `sap_agent_gateway`, because it is what SAP documents for IAS App2App):
    `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, `assertion` set to the subject token below, and
    `resource` set to the agent gateway;
  - **`token_exchange`** (RFC 8693, for other A2A gateways and in case SAP adopts it): `subject_token` and
    `subject_token_type`, with an optional `actor_token`.

  Common to both:
  - The subject token (the `assertion`, or `subject_token`) is a short-lived assertion for the person, issued by the identity provider SAP trusts (the
    customer's IdP, federated with SAP Cloud Identity Services). Two sources, chosen per connection: (a) the person's
    own IdP token, kept from their RegulAIt sign-in or obtained by a token exchange at that IdP, when the IdP is the one
    SAP trusts. **This is preferred**, because RegulAIt then mints nothing SAP trusts. Controls on (a):
    - **Timing:** the subject token is obtained or exchanged per call, and only after every
      `executeGovernedA2aCall` check (grant, ceiling, approval, budget, PII, egress) passes.
    - **Lifetime and audience:** the shortest lifetime the IdP allows, with the audience pinned to the IAS tenant.
    - **Storage:** an IdP or refresh token that must be kept is stored with the data-key envelope
      (`CIPHERTEXT_COLUMNS`) and never returned.
    - **Logging:** the token is never logged, audited or passed to the model.

    Or (b), only where (a) is
    impossible: a RegulAIt-signed ES256 assertion that the customer's IAS trusts as a corporate IdP, with these
    controls:
    - a **dedicated signing key per SAP trust**, which is not the general ADR-0210 key, with its own issuer path;
    - `aud` pinned to the one IAS tenant;
    - `exp` of 60 seconds or less, with a `jti` that RegulAIt records and refuses to mint twice (IAS-side rejection of
      a replayed `jti` is **unverified**; B0 confirms it, and it is treated as an extra control);
    - rotation and revocation through key management;
    - IAS restricted to the user group that this trust may assert.

    Every assertion minted under (b) is audited. Which of (a) and (b) SAP accepts in practice is confirmed in B0.
  - Client authentication: mTLS or a jwt-bearer client assertion (preferred), or a client secret (allowed but flagged
    as weaker in the UI). These are the three methods SAP documents.
  - Under RFC 8693 only, `actor_token` is RegulAIt's agent identity, matching ADR-0188's actor chain. Under jwt-bearer
    the actor is recorded in our own audit only.
  - The exchanged token is cached per (person, agent) until shortly before expiry, never shared across people, and
    never cached across an authorisation decision: a revoked grant stops the next call even with a live token.
- **Library**: `oauth4webapi` 3.8.8, already pinned in the gateway (MIT), does client credentials and the generic
  token-exchange grant. Both grants are generic grant requests. No new dependency.
- A call whose exchange fails is refused, audited (`a2a-user-token-failed`, with SAP's error code but not its
  text), and not costed.

### 5. Governance defaults (ADR-0180)

- `a2a_enabled` stays off by default; a new `sap_agent_gateway_enabled` org setting, also off by default, gates the
  connection, import and calls. Turning either on is a relaxation (`settings_relax` step-up, audited).
- Registration, import and refresh are admin-only.
- **Per-person grants**, default-deny, whole agent or one skill; never to an agent or a role in the first slice (roles
  stay an ADR-0219 follow-up).
- Every **refused** call is audited (org setting, grant, ceiling, budget, PII, egress, token) and **not costed**. An
  allowed call that fails upstream is audited and charged nothing, as ADR-0219.
- A Joule agent that can write in SAP is still governed only at the agent level by A2A (the protocol carries no tool
  call we can see). The admin can therefore require an **approval per call** on a Joule agent
  (`a2a_agents.requires_approval`, default **true** for `sap_agent_gateway` agents), using the existing approval queue
  with the message text bound into the approval payload (ADR-0104).

### 6. Audit and cost

- Audit row as ADR-0219 (`object_type` `a2a_agent`), plus the connection id, the token kind used, and the exchanged
  token's `jti` hash (never the token). SAP-side correlation ids, if returned, are recorded so an SAP auditor can match
  the call.
- One `usage_events` row per allowed call, the agent's flat price (null means unpriced), attributed to the project. If
  SAP's commercial model for Agent Gateway calls is known per call, the admin sets the flat price to it.

### 7. Customer-side setup (documented in the runbook, not automated)

1. Register RegulAIt in **SAP for Me** as an "Agent Gateway Consumer". This grants no access by itself (verified).
2. Run SAP's three **formations**, in this order (verified):
   - identity: SAP Cloud Identity Services creates a single-tenant OIDC agent identity for the consumer;
   - trust: "Agent Gateway for Third Party";
   - authorisation: "Agent Gateway Consumer", which creates the ACL of SAP agents the consumer may invoke.

   A later ACL change needs only the authorisation formation updated, followed by a RegulAIt refresh (section 2).
3. **Federate users** through an IdP that SAP Cloud Identity Services trusts, so that the person RegulAIt gets a
   token for is the same person SAP authorises. A corporate IdP is a federated login source of IAS (verified). Their SAP business roles decide what the agent can do for them.
4. Enter the connection in RegulAIt (base URL, token endpoint, client id and secret), import the agents, grant people.

SAP marks parts of the token-exchange setup as transitional, so the runbook re-checks them at B0.

### 8. Later: the reverse path ("bring your own agent")

Joule calling a RegulAIt agent needs an A2A server endpoint, which RegulAIt does not have. SAP lists outbound A2A
(Joule as the client) as "future direction" (verified). SAP's bring-your-own-agent pattern is already described:
`message/send`, text parts only, a 60-second synchronous wait, push notifications for async results, and IAS App2App
trust. When both exist, the design is: a governed A2A server endpoint on the
gateway, each exposed RegulAIt agent opt-in (default off), the inbound caller authenticated by SAP's token, mapped to
a RegulAIt person through the same IdP federation, and every inbound call passing the same per-user entitlement,
budget and audit as an outbound one. Because Joule waits only 60 seconds, anything longer has to use the
push-notification path, and the approval queue cannot sit inside a synchronous call. This is its own ADR when SAP
ships it.

## Alternatives rejected

- **A Joule-specific integration outside A2A** (SAP's own SDKs, or a Joule MCP server). Duplicates the A2A governance
  path and ties us to one vendor's protocol. A2A is the standard SAP chose and we already govern.
- **One shared technical token for all people.** The Joule agent would act with one identity's SAP rights for
  everyone: a confused deputy, and SAP's own audit would not show the person.
- **Auto-register every agent in the catalogue.** Contradicts admin-only registration; an SAP-side ACL change would
  silently widen what RegulAIt users could call.
- **Write our own A2A REST client.** The pinned SDK already has one, with a v0.3 compatibility layer (ADR-0176).
- **RFC 8693 only.** SAP documents the jwt-bearer grant. Supporting only RFC 8693 would not work with SAP's gateway.
- **Default the new setting on for customers with SAP.** ADR-0180.

## Build plan (each slice one reviewable PR with tests)

| Slice | What | Tests |
|---|---|---|
| B0 | Spike (no merge): run the SDK's v0.3 REST compatibility transport against SAP's gateway. Confirm, against a trial tenant: SAP's ARD paths, the card shape, the jwt-bearer parameters (`resource`, client authentication) and what the subject token can be. Output: an addendum to this ADR. | — |
| B1 | HTTP+JSON binding in `a2a.ts`: accept `HTTP+JSON` interfaces on the registered origin; the SDK's `RestTransportFactory`, and `LegacyRestTransport` for 0.3.x cards; legacy-card detection and conversion (`isLegacyAgentCard`, `parseLegacyAgentCard`), storing the normalised card, `card_protocol_version` and the raw-card hash; protocol-version check. | The real-agent loopback test extended with the SDK's REST server half: JSON-RPC and HTTP+JSON both work; **a legacy 0.3 card registers and is called through `LegacyRestTransport`**; a legacy card whose `url` or `additionalInterfaces` point to another origin is refused; cross-origin HTTP+JSON refused; redirect refused; unsupported major version refused. |
| B2 | Credential kinds `oauth_client_credentials` and `oauth_user_token` (grant `jwt_bearer` or `token_exchange`) (migration, renumbered at merge per M-108): storage, admin routes, step-ups, the per-call exchange with `oauth4webapi`, per (person, agent) cache, refusal audited and not costed. | A fake token endpoint for both grants: success; failure refused and audited; token never in audit or logs; cache keyed per person; grant revocation stops the next call with a live token. |
| B3 | `a2a_gateway_connections`, `sap_agent_gateway_enabled`, ARD import and refresh (admin-only, step-up, audited), `pending_card` and acceptance. | A fake catalogue: import lists only ACL-visible cards; nothing is auto-registered; **a changed card is held as pending, and calls keep using the stored card until an admin accepts it**; accepting a widened card needs a step-up; a new skill is not callable until it is granted; a removed skill stops being callable at once; a removed card is disabled; oversize or cross-origin cards are refused. |
| B4 | `requires_approval` for gateway agents (default true), message bound into the approval payload. A per-agent A2A rate-limit bucket (moved here from the follow-ups because gateway agents can write in SAP): seeded at 30 calls per person per hour for `sap_agent_gateway` agents, and raising it is a relaxation. | Call pauses for approval; approval for one message does not authorise another; the 31st call in an hour is refused, audited and not costed. |
| B5 | Admin UI: a "Connect SAP Agent Gateway" panel on the Remote agents tab, the import picker, token-kind display; runbook section for the customer setup. | Component tests; entry bundle stays under its ceiling (ADR-0219 placement lesson). |
| B6 | Live check against a customer or trial tenant (owner-run), recorded as an addendum. | `demo:check`-style row, off by default. |

## Threat model

| Threat | Mitigation |
|---|---|
| Confused deputy: the Joule agent acts with more SAP rights than the person | A user-bound token per person (jwt-bearer or RFC 8693); no shared token; SAP authorises the person. |
| Token leakage | Tokens never stored in plain text, never returned, never logged; sent only to the registered origin through the guarded fetch; short-lived, audience-bound. |
| Cross-person token reuse | Cache keyed by (person, agent); grant checked before every use. |
| A changed card redirects our calls or silently widens skills | Interfaces only on the registered origin. A refreshed card is held as pending, and the stored card stays in use until an admin accepts the change (a step-up when it widens). New skills need a grant. |
| **The person's own IdP token (option (a)) leaks** and is used at SAP directly, bypassing approval, rate limit and budget | It is obtained per call and only after every gateway check passes; it has the shortest lifetime with an audience pinned to the IAS tenant; it is never logged or audited; any token that must be kept is stored with the data-key envelope and never returned. |
| **The RegulAIt signing key becomes an IAS-trusted IdP (subject-token option (b))**: a key compromise or a gateway bug could mint any SAP user that IAS maps | Option (a) is preferred. Under (b): a dedicated key per SAP trust, never the general ADR-0210 key; its own issuer; `aud` pinned to the IAS tenant; `exp` 60 seconds or less; a `jti` with replay rejection; rotation and revocation; IAS restricted to the user group that may be asserted; every assertion minted is audited. |
| Catalogue widening through an SAP ACL change | Admin-only import; nothing auto-registered. |
| SSRF through the gateway URL or token endpoint | Egress decision at write and call time; guarded fetch; redirects refused. |
| Prompt injection driving SAP writes through Joule | Approval per call by default on gateway agents; PII mode; budget; a per-agent rate-limit bucket (B4). |
| Replay of an approval | Message bound into the approval payload (ADR-0104). |
| Unaudited refusals | Every refusal audited, none costed. |

### Security checklist items touched (ADR-0200)

- **Object-level authorisation**: the per-person grant, plus SAP's authorisation of the exchanged identity.
- **JWT and signing secrets out of code, rotatable, algorithm and audience pinned**: under option (b) the subject
  assertion is ES256 with a **dedicated per-SAP-trust key, never the ADR-0210 key**, `aud` pinned to the IAS tenant
  and `exp` of 60 seconds or less; under option (a) the IdP token's audience is pinned the same way; and the
  exchanged token's audience is pinned to the agent gateway.
- **API secrets server side only**: the client secret encrypted with the data key, never returned.
- **SSRF through the guarded fetch**: gateway base URL, token endpoint, catalogue and agent URLs.
- **No sensitive data in logs**: no tokens, no SAP error text.
- **MFA for step-up**: connection create, secret rotation, enabling the settings.
- **Rate limiting**: a per-agent bucket for gateway agents (B4), on top of the gateway-wide tier.
- **Permissions enforced server side**: all checks in `executeGovernedA2aCall`.

## Consequences

- Easier: any A2A gateway that uses OAuth token exchange (not only SAP's) can use the same credential kinds; the HTTP+JSON
  binding opens every REST-only A2A agent.
- Harder: per-call token exchange adds latency (mitigated by the per-person cache) and a dependency on the customer's
  IdP federation being right.
- Follow-ups: streaming and task polling for long-running Joule tasks; PII on the reply; the reverse path (section 8).

## Open questions for the owner

1. **RFC 8693 vs jwt-bearer**: P20 assumed RFC 8693; SAP documents RFC 7523 jwt-bearer. Proposed: support both, with
   jwt-bearer as the SAP default. Agree?
2. **Subject token source**: (a), the person's own IdP token, is preferred. Should (b), a RegulAIt-signed assertion
   with a dedicated key, be built at all in the first slices, or only when a customer cannot do (a)?
3. **Approval per call on Joule agents by default** (proposed true): acceptable friction, or default to grant-only for
   read-style agents?
4. **Pricing**: flat price per call from SAP's commercial terms, or leave unpriced until known?
5. **Trial tenant for B0/B6**: which SAP tenant and who registers it in SAP for Me?
6. **Reverse path**: put it on the roadmap now, or wait for SAP's outbound A2A to ship?
