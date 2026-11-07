# ADR-0238: Down-scoped upstream credentials by RFC 8693 token exchange

- **Status**: Proposed (builder, 2026-11-07; backlog P12(d))
- **Date**: 2026-11-07

## Context

Backlog P12(d) asks for OAuth token exchange, noting that an RFC 8693 endpoint already exists on `oidc-provider`, and
asks first what it covers.

### Step 1: what exists today (verified in code)

| What | Where | Direction | What it does | What it does not do |
|---|---|---|---|---|
| `POST /oauth/token`, RFC 8693 on `oidc-provider` 9.12.2 | `apps/gateway/src/oauth/token-endpoint.ts` (ADR-0188 S5) | **inbound**: RegulAIt is the authorization server | An agent workload trades a human delegation proof (root) or its parent's decision 23 authorization (child) for a DPoP- or mTLS-bound delegated access token. Also `client_credentials` self tokens for engine runners and PDP clients (S7). | Its only resource is the gateway itself: `resource` must be one of the gateway's own routes (`gatewayResource`, `WORKLOAD_ROUTES`). It never issues a token for a third party and never talks to another authorization server. |
| Signed identity assertion per call | `mcp-identity-assertion.ts` (ADR-0188 S8, ADR-0210) | outbound, MCP only | A 60 s gateway-signed JWT (pairwise `sub`, `act` chain). The ADR-0210 `oidc_bearer` profile sends it as `Authorization: Bearer` with a `scope` claim. | The `scope` is one admin-set string for the whole server, the same for every tool and person. The upstream must trust RegulAIt as an issuer; nothing is obtained from the upstream's own authorization server. |
| Static upstream credential | `mcp-upstream-credential.ts` (ADR-0204), `connector_credentials` | outbound | One secret per MCP server or connector, the same for every caller and tool. | Not per person, not per tool, not short-lived. |

So the missing part is the one the backlog guessed: the gateway acting as an RFC 8693 **client** of an upstream's own
authorization server, so that an upstream receives a token that speaks for the calling person and is no broader than
the one tool or connector operation the person was just allowed to use.

## Decision

Add an outbound token exchange, generic over MCP servers and connectors, off by default.

1. **Configuration** (migration 0299). At most one `upstream_token_exchanges` row per MCP server or connector: the
   token endpoint (https only), the subject token's audience (the authorization server's identifier), the pinned
   `audience` and optional RFC 8707 `resource` of the issued token, the client id, the client secret (data-key envelope,
   in `CIPHERTEXT_COLUMNS`, `secret_set_at` stamped by the 0142 trigger, rotated by a PUT that carries a new one), a
   lifetime ceiling (default 300 s, 30–900 s), and `enabled` (default false). The per-action scope map is a join table,
   `upstream_token_exchange_scopes(exchange_id, action, scope)` (ADR-0200 addendum: a list is a table). An action is an
   MCP tool name, an MCP JSON-RPC method, or a connector operation.
2. **Admin API** (internal, admin-only by the default gate): `GET`/`PUT`/`DELETE`
   `/v1/servers/:serverId/token-exchange` and `/v1/connectors/:connectorId/token-exchange`. Every write is a
   `settings_relax` step-up bound to the target and every stored value (only whether the secret changes, never the
   secret), claimed in the write's transaction under the target's row lock, and audited in that transaction. No read
   returns the secret (only its last four characters). Refused, audited: a stdio server, a server on the `oidc_bearer`
   profile or with an ADR-0204 Bearer credential (both already own `Authorization`). A server url move turns the
   exchange off (audited), like ADR-0204 and S8.
3. **At call time**, after the governed decision (entitlement, approvals, budget, PII, guardrails) and before the
   connect, any approval being spent, or the connector call:
   - **default-deny**: an action with no mapped scope is refused before anything is sent;
   - the subject token is a fresh ADR-0210 OIDC assertion (ES256, issuer `<public URL>/mcp-identity` with its public
     JWKS, 60 s, unique `jti`, pairwise `sub` for the authorization server, the `act` chain of an acting agent) whose
     `scope` is the action's mapped scopes;
   - the exchange (`grant_type` token-exchange, `subject_token_type` jwt, `requested_token_type` access_token, the
     pinned `audience` and `resource`, the action's `scope`, client_secret_basic) runs through the egress-guarded fetch;
   - the answer must be a Bearer access token with `expires_in` present and within the ceiling, no scope beyond the
     request; a JWT access token must also carry exactly the pinned audience/resource in `aud`, an unexpired `exp`
     within the ceiling, and no wider `scope`/`scp`. A refresh token is never kept;
   - the token's SHA-256 is claimed in `replay_claims` (new namespace `upstream_exchanged_token`): a token handed out
     twice, to the same person or another, is refused and never attached again;
   - an `upstream-token-exchange-issued` row is written (scope, audience, subject `jti`, pairwise `sub`, a 16-hex
     fingerprint; never the token), and only then is the token attached: as `Authorization: Bearer` on requests of that
     one MCP call to the registered origin (`UpstreamExchangeHolder`), or in place of the connector's credential for
     that one invocation.
   - Any failure is our own refusal: `upstream-token-exchange-refused` with a code, the call is denied, nothing is sent.
4. **No caching.** The token lives in one call's holder or one invocation's local variable. It is never stored, pooled
   or shared, so nothing can cross users or tenants. Each call exchanges afresh.

Open source first (ADR-0176): `oauth4webapi` 3.8.8 (already pinned; used by ADR-0188 S3) builds the request and client
authentication and validates the response, with our guarded fetch as its `customFetch`; `jose` signs the subject token
and decodes an issued JWT; the MCP SDK's `createMiddleware` attaches it. Nothing is added to the tree. Ours is the
policy: when a token may be obtained, for which scopes, and what the answer may say.

### Design reference (owner-approved, ideas only)

[loglux/authmcp-gateway](https://github.com/loglux/authmcp-gateway) (MIT, 2026) is an MCP authentication proxy:
OAuth 2.0 with dynamic client registration (RFC 7591) in front of MCP servers, JWT authentication, RBAC, rate limits
and an admin dashboard. It was read only as a reference for how the MCP specification's inbound OAuth 2.1/DCR flow
and outbound upstream credentials sit on either side of one proxy. No code was copied, and nothing from it is in the
tree; it is young, and the decisions here follow from our own controls (pillar 1 default-deny, ADR-0180, ADR-0200).
The idea taken: keep the two sides separate. How a client authenticates TO the gateway decides who the person is; what
the gateway sends ONWARD is decided per call from that person's entitlement, and is never the client's own token passed
through. This ADR is the onward side only.

### MCP-spec OAuth 2.1 / DCR on our own MCP endpoint (out of scope, follow-up)

Checked: `POST /mcp/:serverId` already serves RFC 9728 protected-resource metadata and a `WWW-Authenticate` challenge
(ADR-0097 part B, `mcp-auth-metadata.ts`), and accepts RegulAIt API keys, the session cookie and ADR-0188 delegated
tokens. It does not offer the MCP specification's authorization-code + PKCE flow for third-party MCP clients, nor
RFC 7591 dynamic client registration; ADR-0097 records both as deliberately out of scope. They are an inbound concern
and do not affect this ADR (the subject of an exchange is the already-authenticated person, however they signed in), so
they stay out of scope here and are recorded as a follow-up below. If taken up, `oidc-provider` (already pinned) offers
both the authorization-code flow and `registration` (DCR), which would be switched on with an initial-access-token and
an admin approval, never open registration (ADR-0180).

### How this serves ADR-0231 later (no SAP code here)

ADR-0231 (SAP Joule over A2A, still Proposed, awaiting the owner) needs a user-bound token per call and found that SAP
documents RFC 7523 jwt-bearer, not RFC 8693. This ADR gives it the reusable parts: the configuration row and its admin
step-up, the per-person subject assertion (the jwt-bearer `assertion` is the same ES256 OIDC assertion), the response
check, the replay claim, the audit rows and the no-cache rule. Serving it later means: a third target kind
(`a2a_agent_id`), and a `grant_profile` column (`token_exchange` default, `jwt_bearer` for SAP IAS) that changes only the
form parameters of step 4. That is a migration and a small branch, decided when the owner accepts ADR-0231.

## Consequences

- An upstream that runs its own authorization server (Entra ID on-behalf-of, Okta, Keycloak, Auth0, Ping and others
  that support RFC 8693) can receive a token that names the person and is limited to one tool's scopes, instead of a
  shared static secret or a server-wide scope.
- Every governed call to an enabled target costs one extra round trip to the authorization server (bounded at 10 s).
  That is the price of no caching; a per-person cache keyed on the scope set is a possible later optimisation and would
  need its own ADR.
- Before the decision (the manifest sync of an unknown tool) the holder is unarmed, so no token is sent. An upstream
  that demands a token for `tools/list` must be synced another way (the same limit ADR-0210 has).
- The admin must map scopes per action; an unmapped tool on an enabled server is refused. That is the default-deny the
  backlog asks for, and it makes the first configuration more work.
- The token endpoint's host must be on the egress allow-list, over https.

### Follow-ups

- UI: the admin form for the configuration and scope map (posted on #453).
- A connector `base_url` change does not yet turn the exchange off (the server url move does). The token's audience is
  pinned, so it would be rejected by any other resource server, but the strict behaviour is to turn it off as well.
- Refusing the reverse conflicts at write time: setting an ADR-0204 Bearer credential or the `oidc_bearer` profile while
  an exchange is on. At call time this already fails closed (the arm refuses the `oidc_bearer` profile, and the
  exchanged token replaces a static Bearer value).
- `private_key_jwt` client authentication with the gateway's issuer key instead of a client secret.
- ADR-0231's `jwt_bearer` profile and A2A target, once the owner decides.
- MCP-specification OAuth 2.1 (authorization code + PKCE) and RFC 7591 dynamic client registration on our own MCP
  endpoint, for third-party MCP clients (out of scope per ADR-0097; see above). Owner decision needed before building.

## As built

- Migration `0299_upstream_token_exchange` (journal `when` 1785225000000; renumbered from 0293 when 0297 reached main first, so it would not fall under the watermark); Drizzle tables in `packages/db/src/schema.ts`.
- Contract: `packages/shared/src/identity/upstream-token-exchange.ts`; `upstream_exchanged_token` in `REPLAY_NAMESPACES`.
- Gateway: `apps/gateway/src/upstream-token-exchange.ts`; wired in `mcp-proxy.ts` (`tools/call`), `mcp-protocol.ts`
  (governed protocol methods), `mcp-egress.ts` (the middleware), `connector-call.ts`, `app.ts` (routes, url move),
  `data-key.ts`, `openapi-registry.ts` (internal).
- Tests: `upstream-token-exchange.test.ts` (33, no database) and `zz-adr0238-upstream-token-exchange.test.ts` (17, real
  database): the strict default; step-up writes and secret hygiene; the down-scoped exchange end to end; and the
  negatives (unmapped action, wrong audience, scope widening in the answer and in the JWT, expired and over-long tokens,
  replay, another user's token, a token-endpoint error, an egress-blocked endpoint), the connector path, the url move,
  and no token in any audit row or log line.
