# ADR-0315: A portable, offline-verifiable agent credential

- **Status**: Proposed (builder lane E3, G7; draft published early so lane E5 can build against the token format. The
  master accepts it on merge of the build PR)
- **Date**: 2026-11-15
- **Generalises**: [ADR-0210](0210-oidc-compatible-mcp-identity-assertion.md) (the 60-second, per-call MCP identity
  assertion) and [ADR-0238](0238-upstream-token-exchange.md) (RFC 8693 outbound exchange). It builds on ADR-0188 S5
  (inbound RFC 8693 delegation grants, `delegation_grants`), ADR-0124 (kill switch) and pillar 7's run budgets.
- **Index**: Portable agent credential (offline-verifiable, delegation chain, budget, status list)

## Context

Market gap G7 (pillar 7 with 1). An agent that RegulAIt governs often calls a tool that RegulAIt does not proxy. Such
an **enforcement point** is something like Kong, agentgateway, or a SaaS MCP server. It must decide alone, offline,
whether to admit the call. It needs four facts, and it must be able to verify them without calling back:
- who the human is;
- which agents act for that human (the delegation chain);
- what they may do;
- how much they may spend.

What exists today (verified in code, 2026-11-15):

- `at+jwt` delegated tokens (`mintDelegatedToken`, `apps/gateway/src/delegated-token.ts`). Their audience is the
  gateway itself, so a third party cannot accept them.
- The ADR-0210 ES256 assertion, issuer `<public URL>/mcp-identity`. It lasts 60 seconds, is minted per call for a
  proxied MCP connection, and carries no budget and no grant reference.
- RFC 7009 revocation and RFC 7662 introspection serve only the client that owns the token. No outside verifier can
  learn that a credential was revoked, short of a signing key leaving the JWKS.
- Neither format carries the run budget. There is no `may_act`.

The delegation model already enforces the invariants. A child grant is a subset of its parent's scope, of its
sponsor's own grants and of its actor's entitlements, and its budget cap fits in the parent's remainder
(`apps/gateway/src/delegation.ts`: `sponsorGrantsMiss`, `scopeSubset`, `actorEntitlementsReach`, `admitChildGrant`).
The credential only **carries** what a grant already holds; it never widens it.

## Decision

### 1. One new issuer, separate from every other RegulAIt token

- **Issuer:** `<REGULAIT_PUBLIC_URL>/agent-credentials`.
- **Discovery:** `GET /agent-credentials/.well-known/openid-configuration`.
- **Keys:** `GET /agent-credentials/.well-known/jwks.json`.
- The keys are the ES256 keys already managed in `identity_signing_keys`: RFC 7638 thumbprint `kid`, rotation and
  revocation behind a `key_management` step-up, and retired keys published through the overlap window.
- No new key store. EdDSA is an option an audience can opt into. The JWKS lists the public halves of both
  algorithms; each audience pins one.

A separate issuer means a verifier configured for agent credentials can never accept the gateway's own `at+jwt`, an
MCP assertion or a federation token, and the reverse also holds.

### 2. Only registered audiences, default-deny

An admin registers each enforcement point as an **audience** (table `agent_credential_audiences`). A registration
holds:
- the audience URI (exactly one per credential);
- the algorithm (`ES256` by default, `EdDSA` as an option);
- the binding (`dpop` by default, `bearer` as an option);
- the maximum lifetime;
- the scope map: which grant scope atoms become which `scope` strings at this audience.

Unmapped atoms are never sent. With no registration, nothing is issued. Each relaxation below is a `settings_relax`
step-up and is audited:
- registering an audience;
- choosing `bearer`;
- raising the lifetime above the default.

### 3. Issuance through the existing RFC 8693 endpoint

`POST /oauth/token` takes:
- `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`;
- `subject_token`: the caller's own delegated `at+jwt`;
- `resource`: the registered audience URI;
- `requested_token_type=urn:regulait:params:oauth:token-type:agent-credential`.

Every condition below is re-checked at mint. A failure is a refusal (never a narrower token), and it is audited:
- The grant must be live: not revoked, not expired, within its depth limit.
- The run must have budget left.
- The org dial must not be `halted`.
- No agent in the chain may be halted, and no workload identity in the chain may be suspended or revoked.
- The issued `scope` is the intersection of the grant's scope with the audience's scope map. An empty intersection is
  refused.

### 4. The token format (stable: lane E5 builds against this)

The header must be exactly:

```json
{ "alg": "ES256", "typ": "at+jwt", "kid": "<RFC 7638 thumbprint>" }
```

`typ` follows RFC 9068, so standard JWT access-token verifiers accept it. The claims (a decoded example follows):

| Claim | Required | Meaning |
|---|---|---|
| `iss` | yes | `<public URL>/agent-credentials`, exactly |
| `aud` | yes | one string: the registered audience URI |
| `sub` | yes | the initiating human, as a pairwise subject per audience (the existing `pairwiseSubject`). A directory identifier is an audited per-audience relaxation. |
| `client_id` | yes | the acting (leaf) agent's workload identity: `spiffe://<trust-domain>/regulait/agent/<id>` |
| `act` | when delegated | the RFC 8693 §4.1 actor chain: the outermost `act` is the current actor (the leaf); each nested `act` is the actor before it, ending at the lead agent. Each `sub` is a SPIFFE ID. Depth is at most 8 (the grant depth limit). |
| `scope` | yes | space-separated strings from the audience's scope map, never wider than the grant |
| `authorization_details` | optional | RFC 9396 array: the same atoms in structured form, for verifiers that use them |
| `regulait_budget` | when the run is capped | `{ "currency": "USD", "cap_micros": n, "remaining_micros": n }`, the run's remaining budget at issue. Advisory to the verifier; spend is still settled by RegulAIt. |
| `regulait_grant` | yes | the delegation grant id (also the key for status and audit) |
| `regulait_run` | when the grant belongs to a run | the orchestration run id |
| `cnf` | unless the audience is `bearer` | `{ "jkt": "<DPoP key thumbprint>" }` (RFC 9449) |
| `status` | yes | `{ "status_list": { "idx": n, "uri": "<public URL>/agent-credentials/status/<list id>" } }`, from the IETF Token Status List draft |
| `iat`, `nbf`, `exp`, `jti` | yes | lifetime 300 s by default and 900 s at most; `jti` is 32 random bytes in base64url |

```json
{
  "iss": "https://regulait.example.com/agent-credentials",
  "aud": "https://mcp.vendor.example/",
  "sub": "pw_3n4c…",
  "client_id": "spiffe://example.com/regulait/agent/4f0c…",
  "act": { "sub": "spiffe://example.com/regulait/agent/4f0c…",
           "act": { "sub": "spiffe://example.com/regulait/agent/91aa…" } },
  "scope": "tickets.read tickets.comment",
  "regulait_budget": { "currency": "USD", "cap_micros": 5000000, "remaining_micros": 3120000 },
  "regulait_grant": "0b6e…",
  "regulait_run": "77d2…",
  "cnf": { "jkt": "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I" },
  "status": { "status_list": { "idx": 4211, "uri": "https://regulait.example.com/agent-credentials/status/2026-11" } },
  "iat": 1794729600, "nbf": 1794729600, "exp": 1794729900, "jti": "q8…"
}
```

**What a verifier must check** (published in the discovery document and the verifier guide):
1. `alg` is the audience's pinned algorithm (never `none`, never chosen from the token), and `typ` is `at+jwt`.
2. The signature verifies with a JWKS key named by `kid`.
3. `iss` and `aud` match exactly.
4. `exp`, `nbf` and `iat` hold, with at most 30 s of leeway.
5. The DPoP proof matches `cnf.jkt` (unless the audience is `bearer`).
6. The `status` bit is 0, using a list fetched at most `ttl` seconds ago (the list sets `ttl`, 60 s by default). A
   verifier that cannot read the list within its own grace window fails closed.

A verifier may also enforce `scope` and `regulait_budget` itself.

### 5. Revocation and the kill switch reach outside verifiers

RegulAIt publishes one signed status list per period (a JWT signed by the same issuer). A credential's bit is set when
any of these happens:
- its grant, or any ancestor grant, is revoked (`revokeDelegationGrant` cascades);
- an agent in its chain is halted;
- a workload identity in its chain is suspended or revoked;
- the org dial goes to `halted`;
- an admin revokes it by `jti`.

The short lifetime bounds the window for a verifier that cannot fetch the list. The `halted` dial also stops all
issuance at once.

### 6. Audit

Each of these events is an audit row in the existing chain, with grant, `jti`, audience, the chain's identity ids and
the scope (never the token):
- issuance;
- refusal;
- a status change;
- an audience registration or relaxation.

## Alignment with open specifications

These are normative:
- RFC 9068 (JWT access tokens);
- RFC 8693 (token exchange, `act`);
- RFC 9396 (`authorization_details`);
- RFC 9449 (DPoP);
- RFC 7638 (key thumbprints);
- RFC 8725 (JWT best current practice);
- OIDC Discovery for the metadata.

These are tracked, not normative, and are re-checked when they become RFCs:
- the IETF OAuth Token Status List draft (`status`);
- the OAuth identity-chaining draft for cross-domain delegation;
- the IETF WIMSE workload-identity drafts;
- the emerging OAuth work on AI agents acting on behalf of users.

The `regulait_*` claims are private names (RFC 7519 §4.3), held until a standard claim exists.

## Open-source check (ADR-0176)

- `jose` signs and verifies, as it already does for every RegulAIt token.
- `oidc-provider` already hosts `/oauth/token`; the new token type is a token-exchange handler there.
- No library implements the Token Status List draft, so encoding the list is our own code: a zlib-compressed
  bitstring, with `node:zlib`. The exception is written down here and re-checked when a maintained implementation exists.

## Consequences

- An enforcement point outside RegulAIt can admit or refuse an agent's call alone. It can see the human, the chain,
  the scope and the remaining budget, and it learns of a revocation or a kill within one status-list `ttl`.
- The delegation invariants stay where they are enforced. The credential is a signed projection of a grant, so it
  cannot exceed the initiating user's entitlements or the run budget.

**Build slices (one PR each):**
1. **1a (built on `builder/e3-agent-credential`):**
   - the audience registry (`agent_credential_audiences` plus a 3NF scope map with FKs to servers, connectors and
     agents; step-up registration, free disable, audited);
   - the issuer's discovery document and JWKS;
   - `mintAgentCredential`: the projection, every mint-time check through the delegation's own `loadLiveChain`
     (which already covers the kill switch and halted agents), the issued-credential record and the audit;
   - the offline reference verifier `verifyAgentCredential`.
2. **1b:** the `requested_token_type` branch in `POST /oauth/token`. The caller's own delegated `at+jwt` is the
   `subject_token`; the request goes through the endpoint's DPoP preflight and replay claims, and the result calls
   `mintAgentCredential`.
3. **2:** the status list (`agent_credentials_issued.status_index` is already allocated), revocation and kill-switch
   propagation to the list, the verifier guide, and a reference verifier test against agentgateway's and Kong's JWT
   configuration shapes.

**Owner questions (built with the secure default):**
- Should `sub` default to the directory identifier for audiences inside the customer's own estate? Built pairwise.
- Should the budget claim be enforced or only advisory at third parties? Built advisory: RegulAIt settles spend.
