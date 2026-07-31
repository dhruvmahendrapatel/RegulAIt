# ADR-0028 — Session origin (migration 0046) and the API-key-session password-recovery bypass, bounded so a stolen key can never become a password

- **Status:** Accepted
- **Date:** 2026-07-31
- **Amends:** ADR-0025 (real human authentication) — the `must_change_password` gate and
  `POST /auth/change-password`. Migration **0046**.

## Context — a real lockout, hit on the deployed box

ADR-0025 shipped three ways to establish a browser session (password login, OIDC, and
`POST /auth/login-with-key`, which exchanges an API key or the deploy-time bootstrap token for
the same cookie) and one gate in front of everything: while `users.must_change_password` is
true, every route except the auth self-service surface answers `403 password_change_required`.

Those two facts combine into a dead end:

1. A user's account is created with `must_change_password = true` — by seeding, or because an
   admin issued a one-time password.
2. The user signs in with their **API key** (`/auth/login-with-key`) — the credential they
   actually hold; nobody handed them the one-time password, or it was issued into a channel
   they never saw.
3. The SPA routes them to the forced-password-change gate, which demanded the **current
   (one-time) password**. `change-password` hard-required and verified `currentPassword`.
4. They cannot supply it. And because the gate 403s every non-self-service route, they cannot
   reach the Users screen to issue *themselves* a fresh one-time password either.

With no second admin available the account is **bricked** — holding a perfectly valid credential
the whole time. The same dead end exists in the `password_hash IS NULL` variant: ADR-0025's
transition state left existing users passwordless, and `change-password` answered
`409 no_password_set` ("an admin must set an initial one-time password") to the very person who
*is* the admin.

The credential the user presented was never recorded, so the server could not tell the
"authenticated by API key, cannot possibly know a password" case from the "authenticated by
password" case. That missing dimension is the root cause.

## Decision

### 1. Record HOW every session was established — `auth_sessions.origin` (migration 0046)

`origin` is `NOT NULL`, constrained by CHECK to
`password | api_key | oidc | bootstrap | unknown`, and set at **every** session-creation site:

| creation site | origin |
|---|---|
| `POST /auth/login` (password accepted, no MFA required) | `password` |
| `POST /auth/mfa/verify` (password + TOTP completed) | `password` |
| `POST /auth/login-with-key` with a user's API key | `api_key` |
| `POST /auth/login-with-key` with the deploy-time bootstrap token | `bootstrap` |
| `GET /auth/oidc/callback` | `oidc` |

An MFA-completed login is `password`, deliberately: the second factor does not change **which
credential** established the session, and the bypass below keys off the credential.

The drizzle model declares **no default** for the column, so any future login path that forgets
to name an origin is a compile error; the SQL column keeps `DEFAULT 'unknown'` so the fail-closed
value is also what a raw insert lands on.

**Honest backfill.** Rows that existed before 0046 carry no recorded origin and it cannot be
reconstructed from anything stored — the token hash, IP and user-agent say nothing about which
credential was presented. They are backfilled to **`'unknown'`**, never assumed to be
`'password'`. This is the same discipline as ADR-0027's `audit_log.deploy_mode` (null = honest
absence, never an invented value); the difference is only that a session's origin is needed for
an authorization decision, so the unknown case must be a *value* rather than a null, and that
value must **fail closed**. `unknown` never receives the bypass. Pre-0046 sessions therefore
behave exactly as they did before this ADR, which is the correct answer for a row we cannot
classify.

### 2. The bypass, and exactly where it stops

`currentPassword` becomes **optional in the wire schema**. Whether it is **required** is decided
server-side by one function (`passwordChangeRequiresCurrent`), and the rule is:

> **The current password is NOT required when — and only when — the session's `origin` is
> `api_key` AND the account is in a recovery state: `must_change_password = true` OR
> `password_hash IS NULL`.**
>
> **In every other case it is REQUIRED and verified exactly as before**, including for an
> `api_key` session on an account that has an established password and no forced change.

Fail-closed corollaries, all tested:

- `origin = 'unknown'` (pre-0046) → required.
- `origin` = `password` / `oidc` / `bootstrap` → required, whatever the account's state. A
  password-origin session on a must-change account is the ordinary one-time-password flow and
  is untouched. `bootstrap` has no user identity at all.
- A **header** API-key request (no cookie, so no session and no origin) → required.

### 3. Why the boundary sits precisely there — the key-theft escalation path

The permissive half is easy to justify: an API key **already authenticates as that user**. Anyone
holding it can already do everything that user can do. Demanding a one-time password they were
never told adds no security against a key-holder — it only guarantees that the *legitimate*
key-holder is locked out. In the recovery state there is also nothing to protect: there is either
no password at all, or a password the admin already intends to be replaced.

The restrictive half is the part that must not be relaxed. In the **steady state** — an account
with a password the user chose and no forced change — the API key and the password are two
distinct credentials with two distinct revocation stories. An admin who suspects a key is
compromised revokes that key, and the account is safe. If a key alone could **set** the password,
then a stolen key could be escalated into a **permanent** password that keeps working after the
key is revoked, plus a session-revocation-surviving foothold, plus (via the password) an
independent path into any flow that re-proves the password. That is a genuine
privilege-persistence path, not a convenience question — an attacker who steals a key today
would otherwise own the account after the key is gone. So: **key + recovery state = set a
password; key + established password = prove the old one.**

Note the honest limit of the strictness: a header-key holder can always call
`/auth/login-with-key` and obtain an `api_key`-origin session, so refusing the bypass for header
requests is a consistency choice (the rule is stated over the *recorded, auditable* session
dimension), not an additional security boundary. The boundary that carries weight is the
recovery-state condition.

### 4. Every bypass use is audited distinctly

An ordinary change stays `password-changed`. A bypassed one is written under its own rule id
**`password-set-via-key-session`** (effect `allow`), with `sessionOrigin` and
`recoveryCondition` (`must_change_password` or `no_password_hash`) plus
`currentPasswordRequired: false` in the detail — so "a password was set from a key session
without proving the old one" is a distinct, searchable event and never hides inside the ordinary
password-change stream. A request that omits the current password where it *is* required is
audited too (`password-change-rejected`, `why: current_password_required`) and answers
`401 current_password_required`; a wrong current password still answers
`401 current_password_incorrect`, unchanged.

Everything else about the endpoint is unchanged: org password policy still applies, and the
change still revokes every **other** live session for the account.

### 5. One rule, one source of truth, and the UI obeys it

`GET /auth/me` returns **`passwordChangeRequiresCurrent`** — computed by calling the *same
function* the handler enforces with, on the same inputs — plus `sessionOrigin` for display. The
SPA's `ForcedPasswordChange` hides the current-password field entirely when the flag is
`false` and says why in one line ("You signed in with an API key, so you can set a password
directly."); anything other than an explicit `false` (including an older gateway that omits the
field) is treated as required. The UI is deliberately forbidden from deriving the rule from
`via`/`mustChangePassword`/`passwordSet` itself — a second implementation of a security rule is
a second place for it to drift.

## Consequences

- The lockout is closed for the two states it can occur in, using the credential the user
  already holds, with no new admin, no new endpoint and no new dependency.
- The steady state is byte-identical: password-origin sessions, OIDC sessions, header-key
  requests and any account with an established password all still prove the current password.
- Pre-0046 sessions are honestly unclassifiable and fail closed; they age out with their normal
  lifetime, after which every live session carries a real origin.
- `auth_sessions.origin` is now available as a general dimension (admin session lists, future
  origin-scoped policy such as "SSO sessions only for this role"); this ADR deliberately uses it
  for one decision and nothing else.
- Disclosed limits: the bypass is available to anyone holding a valid API key for an account in
  a recovery state — that is the same reach the key already grants, but it does mean a key
  stolen *before* the user's first password set can claim the password first. The mitigations
  are the ones that already exist (keys are revocable, the event is loudly audited under its own
  rule id, and setting the password revokes every other session), and the ordinary
  `set-initial-password` admin reset re-closes the account.
