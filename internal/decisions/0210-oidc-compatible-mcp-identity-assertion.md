# ADR-0210: An OIDC-compatible MCP identity assertion, and simulation parity for approval quorums

- **Status**: Proposed (builder draft; the master accepts it on merge)
- **Date**: 2026-10-30

## Context

ADR-0188 S8 sends an upstream MCP server a signed identity assertion: EdDSA (Ed25519), in the custom header
`RegulAIt-Identity-Assertion`, verifiable against `<issuer>/.well-known/jwks.json`, with no OIDC discovery document and
no `scope` claim. An upstream that validates a standard OIDC JWT cannot use it. The ABAP MCP server's validator is one
(#453, comments 6508443897 and 6508672833). It requires:

- an OIDC discovery document at `{issuer}/.well-known/openid-configuration` naming `jwks_uri`;
- a pinned algorithm from RS256, ES256 or PS256;
- the token in `Authorization: Bearer`;
- `iss` and `aud`;
- a `scope` claim (without one it treats the token as read-only; a write needs `read write`).

For the 2026-10-31 run-through the two sessions fell back to the ADR-0204 static credential, and put "OIDC-compatible
assertions (discovery, ES256, a bearer option, a scope claim)" on the backlog. This ADR builds it.

Separately, PR #607's review (open item 2) found that the Simulation preview (`POST /v1/evaluate`) answers
`require_approval` for a call the gateway refuses at queue time, because the preview skipped the approver-quorum and
signature-mode check the queue runs (`toolApprovalRequirements`).

## Decision

### Part A — the OIDC profile, per server, opt-in

1. **A per-server profile, off by default.** `mcp_servers.identity_assertion_profile` is `regulait_header` (the S8
   assertion, unchanged) or `oidc_bearer`; `identity_assertion_scope` is the `scope` claim, set by an admin. Migration
   0228 adds both, with a CHECK: `oidc_bearer` only while `identity_propagation` is `signed_assertion`, and only with a
   scope of RFC 6749 scope tokens (1 to 512 characters); the default profile carries no scope. Nothing is backfilled.
2. **Turning it on is a relaxation (ADR-0180).** `PATCH /v1/servers/:id` with `identityAssertionProfile` and
   `identityAssertionScope`. Turning it on, changing the scope, or keeping it on across a url move needs the request's
   one `settings_relax` step-up, bound to the server, the url and the values. Every change is audited
   (`mcp-server-identity-assertion-profile-changed`) in the write's transaction, and the compare-and-set covers both
   columns. Refusals happen before any step-up: no assertion (409 `identity_assertion_profile_needs_assertion`), a
   missing or malformed scope (400 `identity_assertion_scope_invalid`), a stdio server (409).
3. **A url move, or propagation turning off, returns it to the default** (audited, no step-up), as S8 and ADR-0204 do:
   neither the bearer placement nor the scope follows the url to a new destination.
4. **Mutually exclusive with an ADR-0204 Bearer credential.** Both would claim `Authorization`. Turning the profile on
   while the server has a `bearer`-scheme credential is refused (409 `identity_assertion_bearer_conflict`), and setting
   a `bearer` credential while the profile is on is refused the same way (audited as `mcp-upstream-credential-refused`,
   code `oidc_bearer_profile`). Both writers re-check under the server row's lock, so the two can never both be set. A
   `header`-scheme credential is unaffected.
5. **Its own issuer, discovery document and JWKS.** `iss` is `<REGULAIT_PUBLIC_URL>/mcp-identity`. Public, like the
   other issuer metadata: `GET /mcp-identity/.well-known/openid-configuration` (issuer, `jwks_uri`,
   `id_token_signing_alg_values_supported: ["ES256"]`, `subject_types_supported: ["pairwise"]`, the claims) and
   `GET /mcp-identity/.well-known/jwks.json` (ES256 public halves only). The path never collides with `/federation`, and
   the base issuer still publishes no discovery document.
6. **An ES256 key beside Ed25519, in the existing key management.** `REGULAIT_IDENTITY_SIGNING_KEY` may now hold PKCS#8
   P-256 keys beside Ed25519 ones (any other curve refuses the whole file). `identity_signing_keys` takes
   `algorithm = 'ES256'` with a per-algorithm public-only CHECK, and the one-active index is per algorithm. Each
   algorithm has its own first-load activation; rotate (a `key_management` step-up bound to the key) retires only the
   active key of the target's algorithm; revoke is unchanged; every lifecycle row records the algorithm. Verifiers of
   our own tokens read Ed25519 keys only (`publishedSigningKeys` defaults to it, and `signingKeyAccepts` refuses any
   other algorithm), so an ES256 key never verifies a delegated token, a proof or a self token, and
   `/.well-known/jwks.json` never lists one. `jose` signs; no new cryptography.
7. **The assertion.** The S8 claim set plus `scope`: `iss`, `aud` (the canonical server URI), `sub` (pairwise, as
   before), `scope`, `act` (when an agent acts, pairwise unless the server discloses workload IDs), `iat`, `exp` (60 s),
   `jti`. Header `alg: ES256`, `typ: JWT` (what standard validators expect; the separate issuer and algorithm already
   keep it apart from our delegated tokens), `kid`.
8. **On every request of the armed connection.** An OIDC-validating upstream authenticates each request, so once the
   call is allowed and armed, every request on that connection (`initialize`, notifications, `tools/call`, the stream
   GET, the session DELETE) carries a freshly signed assertion in `Authorization: Bearer`, each with its own `jti` and
   its own `mcp-identity-assertion-issued` row (`profile`, `placement`, `scope`, `issuer`). Any other `Authorization`
   value is removed first. An unarmed connection (the manifest sync before the decision) carries none: no identity
   leaves before the call is decided. All S8 fail-closed rules hold, with "no active ES256 key" and "no scope" as
   further reasons to refuse.

### Part B — simulation parity

9. **The preview runs the queue's check.** `POST /v1/evaluate` passes a `require_approval` decision through
   `previewToolApprovalQueue`, which calls the same `toolApprovalRequirements` the MCP and connector queues call. When
   the approver pool cannot meet the quorum (classified-project membership, passkey signature mode), the preview
   answers the queue's deny (`approval-quorum-unsatisfiable`, the same reason text through one shared builder). It only
   reads: no audit row, nothing queued.

Open source first (ADR-0176): `jose` for ES256 signing and the thumbprint, Node `crypto` for key parsing, the MCP SDK's
fetch middleware, the existing step-up, audit and egress helpers. What is ours is when an identity may leave and what it
may say.

## Consequences

- An upstream with a standard OIDC validator can verify who each governed call is for, with a scope an admin chose,
  without a long-lived static secret.
- **Honest limit (master, 2026-10-30, #612):** an upstream that refuses unauthenticated requests cannot be
  manifest-synced through an unarmed connection with this profile alone: the sync before a decision carries no
  identity, by design, and this slice does not change that. Manual tool registration is the workaround; the separate
  governed on-demand sync lane (`builder/mcp-sync-cooldown`, #625) is where a sync for such servers belongs.
- More audit rows: one per request of an armed connection, not one per call.
- The ES256 key is operator-managed; the installer still generates an Ed25519 key alone. Decided (master,
  2026-10-30): no install-time P-256 key; first-use activation of an operator-configured key is enough.
- **Named follow-up: the UI control.** This slice is API-only (accepted by the master for this slice). The profile and
  scope control belongs with the MCP server's identity settings in the admin UI.
- The Simulation preview and the queue now agree on quorum and signature mode. The preview still passes no project
  attribution, and budget and compliance gates are still not previewed.
