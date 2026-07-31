# ADR-0025 — Real human authentication: passwords + server-side sessions, TOTP MFA, OIDC SSO (migration 0042)

- **Status**: Accepted
- **Date**: 2026-07-31
- **Relates to**: ADR-0022 (identity lifecycle — disabled users), ADR-0021 (org_settings configurability mandate), ADR-0012 (UIs as API clients), pillar 1 (per-user governance)

## Context

The owner's verdict, verbatim: *"this app doesn't even have a secure auth
mechanism to login."* Both UIs authenticated by pasting a raw API key into web
storage — the strongest credential in the product, held long-lived in a
browser context where any XSS exfiltrates it, with no logout semantics, no
expiry, no MFA, and no enterprise SSO story. API keys are the right credential
for **programmatic/IDE access** (that is their purpose); they were never a
browser login. Migration **0042** carries the schema; this ADR records the
architecture.

## Decisions

### 1. Passwords: scrypt via node:crypto — memory-hard, zero new dependencies

`users.password_hash` stores `scrypt$N$r$p$saltB64$hashB64` with **N=2^14,
r=8, p=1, keylen=64, 16-byte random salt** (≈16 MiB per verification —
interactive-login grade per the scrypt paper and OWASP; bcrypt was rejected
as not memory-hard, argon2 as a native dependency). The parameter string is
self-describing so parameters can be raised later while old hashes keep
verifying. Comparison is `timingSafeEqual`; verifying against a missing/
malformed hash still burns one full scrypt derivation so response timing
cannot distinguish "no such user / no password" from "wrong password".

Policy is org-configurable (ADR-0021 mandate): `password_min_length` (12) and
`password_require_classes` (2 of lower/upper/digit/symbol), enforced at
change-password only — never at login, so raising policy never locks anyone
out of an existing password.

### 2. Sessions: server-side rows, hashed tokens, HttpOnly cookie

`auth_sessions`: the cookie value is a **256-bit random token**; only its
sha256 is stored (a DB leak yields no usable session — same discipline as API
keys). Cookie: `regulait_session`, **HttpOnly, SameSite=Strict, Path=/**,
`Secure` when the request is https (honoring `x-forwarded-proto`). Two walls:
`expires_at` (absolute, `session_lifetime_hours`, default 24) never slides;
`idle_expires_at` (`session_idle_minutes`, default 120) slides on every
authenticated use (the idle quantum is snapshotted per session at creation).
Revocation is a `revoked_at` stamp — logout, change-password (all OTHER
sessions), admin revoke-all, admin password reset (all sessions).

**One downstream authorization model.** The session resolves to the same
`authCtx` shape API keys produce (`via: "session"`); zero route-level checks
changed. A header credential always wins over a cookie riding along, so the
**API-key request path is byte-identical** to pre-0042. A disabled user's
sessions die at resolve (ADR-0022 parity, same distinct 401). A
bootstrap-token exchange yields a null-user admin session that only resolves
while the deployment still configures a bootstrap token.

### 3. CSRF: SameSite=Strict + a custom-header requirement

Every state-changing cookie-authenticated request must carry
`x-regulait-csrf: 1`. Why this suffices: both UIs are same-origin XHR
clients; **no cross-origin form post or no-cors fetch can set a custom
header** (setting one forces a CORS preflight, which the gateway never
answers permissively), so a forged request dies even in a browser that
mis-handles SameSite. The header is also required on the login endpoints
(login-CSRF hardening). Header-credential clients (API keys) are not
CSRF-able and are exempt — their path is untouched.

### 4. Login: uniform errors + audited temporary lockout

`POST /auth/login` answers **the same 401 body** for unknown email, wrong
password, passwordless account, deactivated account, and active lockout — the
endpoint is not an account-existence oracle; the audit trail records the real
reason. Lockout dials (org_settings): `login_lockout_threshold` (5) failures
inside `login_lockout_window_minutes` (15) lock for `login_lockout_minutes`
(15), audited as `login-lockout`. Success resets the counters.

### 5. TOTP MFA: RFC 6238 via node:crypto HMAC-SHA1, zero deps

160-bit secret (base32), 30 s period, 6 digits, ±1 step skew window.
`users.totp_secret_ciphertext` is AES-256-GCM under `REGULAIT_DATA_KEY` like
every other stored secret; the plaintext secret + otpauth:// URI are shown
exactly once at enrollment. Activation requires a valid code. **Replay
protection**: `totp_last_used_step` — any step ≤ the last consumed step is
refused, so a captured code is dead within its own window. Login becomes
two-step when enabled: password → single-use pending token (`auth_mfa_pending`,
hashed, 5-minute expiry) → code → session. Disabling re-proves BOTH factors.
Admin recovery (`/v1/users/:id/mfa/clear`) requires a recorded reason and is
audited. `mfa_required` (off|admins|all, default off) gates un-enrolled
session users into the auth self-service surface until they enroll; API-key
requests are machine traffic and are never MFA-gated.

### 6. OIDC SSO: `openid-client` (the standard, audited lib), never hand-rolled

Authorization-code + **PKCE (S256)** with per-redirect `state` (single-use,
claimed atomically), `nonce`, and the code verifier all held **server-side**
(`oidc_login_states`) — nothing security-relevant lives in the browser.
Hand-rolling JWKS/ID-token validation was explicitly rejected. Client secrets
are encrypted at rest and **write-only** at the API. Trust model: sign-in
maps the **verified email claim** (`email_verified === true` required) to an
existing user, optionally filtered by per-provider allowed email domains.
**JIT provisioning is default-deny**: unknown subject + JIT off = 403,
audited; JIT on creates the user **never admin**, with at most the provider's
`default_role_id`, audited. SSO sessions are the same `auth_sessions` rows.
`sso_only` refuses password login org-wide and — no-lockout guards — cannot
be enabled with zero enabled providers, and the last enabled provider can be
neither disabled nor deleted while it is on. MFA for SSO users is the IdP's
job (the gateway does not double-challenge a federated login).

### 7. Transition plan

- Migration 0042 leaves every existing user **passwordless** — password login
  is impossible for them until an admin issues a one-time password
  (`/v1/users/:id/set-initial-password`: generated server-side, returned
  exactly once, `must_change_password=true`, all sessions revoked, audited;
  overwriting an existing password requires `force` and audits as a reset).
- The must-change gate closes every session-authenticated route except the
  auth self-service surface until the user sets their own password.
- Seeded personas get printed one-time passwords (seed output only; a re-seed
  never overwrites a password a human set).
- Both UIs' paste-a-key flow is REMOVED as the primary path; a
  "sign in with an API key" fallback (details-toggle) exchanges the key for a
  session via `POST /auth/login-with-key`, so cookies rule the browser either
  way. API keys remain first-class for programmatic/IDE access. The bootstrap
  token is unchanged (operator-level; header use identical, and it can be
  exchanged for a browser session that dies with the token).

## Consequences

- Browser XSS can no longer exfiltrate a long-lived credential: the cookie is
  HttpOnly, sessions expire/idle out, and every one is individually and
  centrally revocable — with the full lifecycle audited (login success/
  failure/lockout, password + MFA changes, provider CRUD, JIT provisioning).
- One new dependency (`openid-client`); passwords and TOTP are node:crypto.
- The pre-0042 header path is regression-tested byte-identical; the 638-test
  suite passes untouched, +39 new auth e2e tests (including a full fake-IdP
  OIDC flow).
- Deferred, recorded here: WebAuthn/passkeys; per-user session listing in the
  UIs (API exists: `GET /v1/users/:id/sessions`); SCIM deprovisioning; OIDC
  RP-initiated logout; remember-device for MFA.
