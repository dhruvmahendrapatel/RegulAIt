# ADR-0037: SCIM 2.0 provisioning (Users + Groups) with deactivate-never-delete deprovisioning

- **Status**: Accepted
- **Date**: 2026-08-01

## Context

Federated **login** (OIDC today, SAML per ADR-0036) authenticates a human at sign-in time, and
JIT provisioning creates an account the first time an unknown-but-allowed subject appears. That
covers onboarding-by-first-login, but it does **not** cover the enterprise lifecycle an IdP-driven
org expects: accounts created *before* first login, attribute updates pushed from the IdP as the
source of truth, group membership synced continuously, and — the security-critical one —
**deprovisioning** when someone is offboarded in the IdP, which must not wait for a failed login
attempt that may never come.

RegulAIt already has the right primitives for this:
- `users` (`schema.ts:18`) with `email` (unique, the mapping key), optional `username`, and — the
  key enabler — `disabledAt` from ADR-0022: **deactivate ≠ delete**, every FK/audit/history row
  survives, only authentication and dispatch-as stop, and reactivation clears the flag. There is
  deliberately **no hard-delete route** for a user.
- `roles` / `role_assignments` — the baseline entitlement layer a synced group should drive.
- `api_keys` — a deactivated user's keys already stop authenticating immediately (ADR-0022,
  enforced in `authenticate()`), so deprovisioning a user *automatically* neutralizes their
  programmatic credentials without a separate step.
- A single audit log every governed action already writes to, with a `user` `objectType`.

What is missing is the **SCIM 2.0** protocol surface an IdP's provisioning engine (Okta, Entra,
etc.) talks to. Building it means honoring SCIM's RFC 7643/7644 semantics precisely enough that
off-the-shelf IdP connectors work, while never letting the protocol violate RegulAIt's own
invariants (default-deny entitlement, no hard-delete, one audit trail).

## Decision

Expose a SCIM 2.0 endpoint set at `/scim/v2`, authenticated per-IdP by a bearer token, mapping
`/Users` onto `users`, `/Groups` onto a group→role bridge, and modeling deprovisioning as
**deactivation, not deletion**.

**Authentication — per-IdP bearer token.** A new `scim_tokens` table issues one bearer token per
configured IdP integration (`id`, `name`, `token_hash` — sha256, only the hash is stored, minted
and shown exactly once like every other secret in the product; `revoked_at`; `last_used_at`).
The SCIM endpoints authenticate **only** via this token — they are a distinct trust path from
the human session / user-API-key path, so a leaked SCIM token grants provisioning power but not a
user identity, and can be rotated without touching users. The token is bound to a provider so its
actions are attributable. SCIM auth is deliberately *not* the pillar-1 governed API — it is
IdP-machine-to-gateway plumbing, gated by its own token and its own rate limit.

**`/Users` — mapped to `users`, keyed on verified email.**
- `POST /scim/v2/Users` (create): maps SCIM `userName`/`emails[primary]` → `users.email` (the
  lowercase unique key), `displayName`/`name.formatted` → `displayName`, `active` → the inverse
  of `disabledAt`. A created SCIM user has **no password** (`passwordHash` null) — they must
  authenticate via SSO or receive an admin-issued one-time password; SCIM never sets a password.
  A created user is **never** admin (`isAdmin` false); admin is not an IdP-assertable attribute.
- `GET /scim/v2/Users/:id` and `GET /scim/v2/Users?filter=userName eq "…"`: the IdP reconciles
  existing state before pushing changes. Filtering supports at least the `userName eq` / `emails`
  equality filters IdP connectors rely on.
- `PATCH` / `PUT` (update): attribute updates where the **IdP is the source of truth** for
  email/displayName/active. Mapping onto `username` is **not** driven by SCIM — `username` remains
  ADR-0030's locally/admin-managed second identifier and is never overwritten by an IdP push, for
  the same impersonation reason SSO never maps on it.
- **`active: false` → deactivate, `DELETE` → deactivate.** This is the load-bearing decision.
  Both SCIM's soft signal (`PATCH active:false`) and its hard signal (`DELETE /Users/:id`) map to
  setting `users.disabledAt` — **never a row delete**. Deprovisioning a user immediately kills
  their sessions (revoke all `auth_sessions`) and, by ADR-0022's existing behavior, their API keys
  stop authenticating. Reactivation (`active:true`) clears `disabledAt` and restores keys unchanged
  — deactivate is reversible, delete would not be. This satisfies the security requirement
  (offboarding is instant and IdP-driven) without violating the no-hard-delete invariant.

**`/Groups` — a group→role bridge, default-deny.**
- `/Groups` CRUD maintains a `scim_groups` table (external group id + display name) and its
  membership (`scim_group_members`, linking a group to `users`). This is the **inbound sync
  surface only**: it records *what the IdP says the groups and memberships are*.
- A synced group grants **nothing by itself** — this ADR deliberately stops at recording group
  membership. The mapping of a group to a RegulAIt **role** (and thus to entitlements) is
  admin-defined and default-deny, specified in **ADR-0038**. An unmapped group is inert. This
  keeps SCIM from becoming a privilege-escalation vector: the IdP can assert membership, but only
  an admin's explicit mapping turns membership into access.

**Idempotency.** Every operation is idempotent by SCIM's model: create-by-email upserts on the
unique email (a re-POST of an existing user returns the existing resource / `409` per SCIM
conventions, not a duplicate); `PATCH active:false` on an already-disabled user is a no-op that
still returns `200`; group membership sync is set-reconciliation (compute add/remove deltas against
current state), so a replayed full-sync converges rather than duplicating. IdP connectors retry
aggressively; non-idempotent handling would corrupt state.

**Rate limiting.** The SCIM endpoints are rate-limited per `scim_token` (reusing the gateway's
existing rate-limit machinery, ADR-0031's hardening). A full org sync from a large directory is
bursty; the limit bounds a misconfigured or runaway IdP connector without failing legitimate
syncs, and a `429` with `Retry-After` is the SCIM-correct backpressure signal.

**Audit every provisioning op.** Every SCIM create/update/deactivate/reactivate and every group
membership change writes to the single audit log as `objectType: "user"` (or a new
`scim_group` objectType for group ops), with the acting **`scim_token`/provider** named as the
actor, the before/after of what changed, and a stable `ruleId` (`scim-user-created`,
`scim-user-deactivated`, `scim-group-member-added`, …). "Who deprovisioned this account and when"
must be answerable from the same trail as every other governed action — that is the whole point of
a governance product.

## Consequences

- **Easier**: enterprises provision and — critically — **deprovision** RegulAIt accounts from
  their IdP as the source of truth, meeting a hard security/compliance requirement (instant,
  automated offboarding) rather than relying on login-time discovery. SCIM group sync feeds the
  ADR-0038 role mapping so entitlement can follow directory structure at scale.
- **Reused invariant, not a new one**: deprovision = `disabledAt`, leaning entirely on ADR-0022's
  deactivate-never-delete model and its already-built cascade (keys stop, sessions die,
  reactivation restores). SCIM did not force a hard-delete path into existence, and must not.
- **Deliberately deferred / out of scope**: the group→role/entitlement **mapping** (ADR-0038) — a
  synced group is inert until an admin maps it; password provisioning via SCIM (we never set
  passwords — SSO or admin one-time password only); SCIM provisioning of `api_keys` (keys stay
  user-self-service / admin-issued, not IdP-pushed); and full SCIM filter-grammar support (we
  implement the equality filters real IdP connectors use, not the entire RFC 7644 filter language).
- **Honest risks**: (1) a leaked `scim_token` is a provisioning-power credential — mitigated by
  hash-only storage, per-token rotation/revocation, rate limiting, and full audit, but it is a
  real new attack surface distinct from user auth; (2) SCIM connectors vary in how faithfully they
  implement the spec, so real-world Okta/Entra interop testing is required before claiming support
  for a given IdP, and "SCIM 2.0 compliant" will be scoped to tested connectors; (3) email as the
  join key means an IdP that changes a user's primary email produces a *new* account unless the IdP
  correlates by SCIM `id` first — we persist the external SCIM id on the user to make re-mapping on
  email change possible, but cross-IdP email collisions remain an admin-resolved edge case.
- **Follow-up work**: migrations for `scim_tokens`, `scim_groups`, `scim_group_members`, and an
  external-scim-id column on `users`; the SCIM router with RFC 7644 resource/error envelopes;
  per-token rate-limit wiring; the `scim_group` audit objectType; and admin-portal screens to
  issue/rotate SCIM tokens and view sync status (mirroring the SSO provider sync-status surface in
  GOVERNANCE_LAYER_SPEC §6.1).

## Implementation amendment (2026-08-02)

Implemented as decided — migration **0052** (`scim_tokens`, `scim_groups`, `scim_group_members`,
and `users.scim_external_id`), the SCIM router at `/scim/v2` (`ServiceProviderConfig`, `/Users`
GET/POST/GET-by-id/PUT/PATCH/DELETE, `/Groups` GET/POST/GET-by-id/PUT/PATCH/DELETE), the per-token
rate-limit bucket, the new `scim_group` and `scim_token` audit `objectType`s, the admin endpoints
`/v1/scim/tokens` (list/issue/rotate/revoke) and `/v1/scim/status`, and a **Provisioning (SCIM)**
screen in the admin SPA. Gateway suite **1102 → 1142 tests**, all green. Zero new dependencies —
SCIM is JSON over HTTP and needed none.

**The load-bearing behaviour, asserted by test rather than asserted in prose.** A user is
provisioned through SCIM, given a live browser session AND a live API key, then deprovisioned by
*both* signals in turn:

- `PATCH active:false` → `users.disabled_at` set, **the row still exists** (asserted with a direct
  `SELECT`, not by asking the API that wrote it), every live `auth_sessions` row revoked so the
  next request from that browser 401s, and the API key stops authenticating with no separate step;
- `DELETE /Users/:id` → identical outcome, 204, **row still present**;
- `active:true` → `disabled_at` cleared and the *same* API key authenticates again.

There is no code path in `scim.ts` that deletes a `users` row.

**Deviations and choices, stated plainly:**

1. **`DELETE /Users/:id` does not delete, and the resource stays READABLE afterwards.** RFC 7644
   says DELETE removes the resource and a subsequent GET should 404. Here the account is
   deactivated, so `GET /Users/:id` still answers 200 with `active:false`. Every connector we care
   about treats that as deprovisioned. Honouring the letter of the RFC would mean destroying the
   audit, cost and provenance record of everything the account ever did — the opposite of what a
   governance product is for, and a direct violation of ADR-0022.
2. **Idempotent create resolves to `409 uniqueness`, not "return the existing resource".** The ADR
   allowed either. 409 is what Okta and Entra expect (they follow it with a `userName eq` GET and
   switch to PATCH), and — the deciding reason — a 200 would let a create attempt silently ADOPT a
   pre-existing locally-created account, including an admin's. The refusal is itself audited
   (`scim-user-create-conflict`, effect `deny`). No duplicate row is possible either way:
   `users.email` is unique.
3. **`scim_groups.external_id` is nullable-but-unique** rather than `NOT NULL`. `externalId` is
   optional in RFC 7643 and not every connector sends one on group create; fabricating one from the
   display name would invent an identity the IdP never asserted. Postgres treats NULLs as distinct,
   so every group that HAS an external id can exist exactly once.
4. **An unsupported filter is a `400 invalidFilter`, and an unsupported PATCH path a
   `400 invalidPath`** — never a silently-ignored operation. A filter we cannot evaluate answered
   with an unfiltered (or empty) 200 tells a reconciling connector "this user does not exist",
   which is precisely how duplicate accounts get created; a silently-dropped PATCH operation is how
   a "deprovisioned" user stays provisioned. Implemented: `userName|emails|emails.value|externalId|
   id eq "…"` for Users, `displayName|externalId|id eq "…"` for Groups.
5. **A new `scim_token` audit `objectType` beyond the ADR's `scim_group`.** Issuing a provisioning
   credential is a governed act in its own right, not a footnote on some user's row.
6. **A dedicated rate-limit bucket, not the existing api-key one.** `rateLimitKey` returns
   `scim:<token>` for anything under `/scim/v2`, keyed on the presented token — matched on the URL
   PATH so a 404 under the prefix cannot fall back into the generous global bucket. Default 3000
   requests/minute per token (`REGULAIT_SCIM_RATE_LIMIT_MAX` / `_WINDOW_MS`): a full directory sync
   is bursty and must not be throttled into a half-synced state, while a connector stuck in a retry
   loop is bounded well below it. The 429 carries `Retry-After`, per the ADR.
7. **`ServiceProviderConfig` is served and is behind the token**, because real connectors probe it
   before their first write. It states `changePassword: {supported: false}` — SCIM never sets a
   password here — and `bulk: {supported: false}`.
8. **`PATCH` accepts both the explicit-path and the path-less `{op:"replace", value:{active:false}}`
   shapes**, and tolerates the string `"true"`/`"false"` some connectors send for `active`. Unknown
   *attributes* in a payload are ignored (an Okta payload carries far more than we map); unknown
   *operations* are refused. That asymmetry is deliberate: an extra attribute changes nothing, an
   unhonoured operation changes the answer.

**The three invariants SCIM cannot cross, each with its own test.** A SCIM-created user has
`passwordHash` null and cannot password-login (a payload carrying `password` is ignored); is never
admin (a payload asserting `isAdmin`/`roles` gets neither the flag nor a role assignment); and
never has `users.username` written (ADR-0030) — SCIM's `userName` is the mapping key and lands on
`users.email`, never on the local identifier, on create or on PATCH.

**SCIM is a separate trust path, and the tests attack it as one.** `/scim/v2` is auth-exempt from
the session/api-key hook in `app.ts` precisely so a human credential can never be the thing that
admits a request, and non-admin-gated because a connector has no user identity to be admin with.
Refused, each by test: no credential, a revoked token, a rotated-away token, an **admin's** API
key, an **admin's** session cookie, and the deploy-time bootstrap token. `/v1/scim/*` token
management is, conversely, admin-only.

**Still open (deliberately out of scope here):** group→role mapping is **ADR-0038** — a synced
group is inert, the status endpoint says `groupsGrantEntitlement: false` in the payload, and the
membership write carries a comment saying so; `PUT`/`PATCH` on `/Groups` reconcile membership but
grant nothing. Also unbuilt: SCIM `/Me`, `/ResourceTypes` and `/Schemas`; ETag/version
concurrency; sort; bulk; and real-connector interop testing against live Okta/Entra tenants, which
the ADR already names as required before claiming support for a named IdP.
