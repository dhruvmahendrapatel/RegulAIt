# ADR-0039: Session & device management — revocation, IP allow-listing, forced logout

- **Status**: Proposed
- **Date**: 2026-08-01

## Context

RegulAIt already has server-side browser sessions (ADR-0025): `auth_sessions`
(`schema.ts:80`) stores a sha256 of a 256-bit token, an absolute `expires_at` and a sliding
`idle_expires_at`, a `last_seen_at`, and — already present — an `ip` and a `user_agent` column
captured at creation (`createSession` records `req.ip` and a 512-char-truncated UA). ADR-0028
added an `origin` column recording *how* each session was established
(`password | api_key | oidc | bootstrap | unknown`, and `saml` per ADR-0036). There is already an
admin surface to **list** a user's sessions (`GET /v1/users/:userId/sessions`) and **revoke all**
of them (`POST /v1/users/:userId/sessions/revoke`), and password change / reset / user-deactivate
already revoke sessions as a side effect.

What is missing for an enterprise security team:
- **Per-session (single-device) revocation** — kill one suspicious session without logging the
  user out everywhere. Today revocation is all-or-nothing per user.
- **Device/context visibility** — the `ip`/`user_agent` are stored but only captured *at creation*
  and not surfaced as a meaningful "device" list the user or an admin can reason about.
- **Org-level network policy** — regulated buyers require that human sessions only originate from
  (or continue from) corporate networks: **IP allow-listing by CIDR**, "trusted network" policy,
  and the ability to force logout when a session leaves the allowed envelope.
- A clear, **fail-closed** interaction with the API-key path (ADR-0028 `origin`), which is a
  different trust model from a browser session and must not be governed by browser-session network
  rules in a way that silently locks out automation — or silently exempts it.

This is unbuilt enterprise session-governance work that must extend the existing model without
weakening any of its current guarantees.

## Decision

Extend `auth_sessions` and add org-level network policy so that sessions become individually
revocable, device-aware, and bounded by an admin-defined network envelope — all fail-closed.

**Device/context on the session.** `auth_sessions` already carries `ip` and `user_agent` at
creation; add:
- `last_seen_ip` — updated on every authenticated use alongside the existing idle-slide (so an
  admin sees where a session *is now*, not only where it started; an IP change mid-session is
  itself a signal and, under a trusted-network policy below, a trigger).
- A derived, non-authoritative **device label** computed from the UA at creation (browser + OS
  family) purely for the human-readable session list — never a security control, just so "Chrome
  on macOS · 10.0.4.2" is legible in the UI. We do **not** implement device *fingerprinting* or
  treat any device attribute as an authentication factor; the session token remains the only
  credential.

**Per-session revocation (single + all-for-user).** Add
`POST /v1/users/:userId/sessions/:sessionId/revoke` (single) beside the existing revoke-all. A
user also gets self-service `GET /auth/sessions` (their own live sessions) and
`POST /auth/sessions/:id/revoke` / `POST /auth/sessions/revoke-others` ("sign out my other
devices") — the common account-security affordance, and the fast path for a user who notices a
session they don't recognize. Revocation is the existing mechanism (set `revoked_at`), which
`resolveSession` already honors on the very next request — no new enforcement path, just finer
granularity. Every revocation audits with actor, target session, and reason.

**Forced logout.** "Force logout" is revoke-all for a user (already exists) plus two new triggers
that call it: an admin **deactivating** a user (ADR-0022 already revokes sessions — restated here
as the same mechanism), and a network-policy violation (below). Forced logout is always *just*
revocation — there is one way sessions die, and it is `revoked_at` / expiry, so there is no second
code path to get wrong.

**Org-level IP allow-listing (CIDR) + trusted-network policy.** Add to `org_settings`:
- `session_ip_allowlist` (jsonb array of CIDR blocks, IPv4 + IPv6; empty/null = **no restriction**,
  today's behavior — the default must not lock anyone out on upgrade).
- `session_ip_policy` (`off` | `enforce_at_login` | `enforce_continuous`):
  - `off` (default): no IP restriction.
  - `enforce_at_login`: a **new** human session may only be **created** from an allow-listed CIDR;
    an out-of-range login is refused (401 + audit) and no cookie is minted. Existing sessions are
    unaffected.
  - `enforce_continuous`: **every authenticated use** is checked against the allow-list; a request
    whose `req.ip` falls outside the envelope is refused and the session **force-revoked** on the
    spot. This is the "trusted network only" posture — a laptop that leaves the corporate VPN
    loses its session mid-flight.
- The check uses `req.ip`, which under ADR-0031's trusted-proxy handling is the real client IP
  behind the named Caddy proxy (the same trust-gating that decides the `Secure` cookie flag), not a
  spoofable header. A deployment that terminates TLS elsewhere must set the trusted-proxy env or
  `req.ip` is the proxy's address — the boot log already surfaces this posture, and IP policy is
  another consumer of it.

**Fail-closed everywhere.**
- If `session_ip_policy` is enforcing and the request's client IP **cannot be determined**
  (null `req.ip`), the request is **denied**, not allowed — an unknowable IP is treated as
  outside the envelope. A network policy that fails open would be no policy at all.
- A malformed CIDR in the allow-list fails **closed** for that entry (it matches nothing), and the
  admin write path validates CIDRs so a bad block can't be saved silently; but at evaluation time
  the posture is still deny-on-doubt.
- The lockout guard mirrors the existing sso_only guard: an admin cannot save an allow-list that
  **excludes their own current IP** under `enforce_continuous` without an explicit confirm, so a
  misconfigured block can't strand every admin out of the portal (the air-gapped/BYOC operator
  recovery is the deploy-time bootstrap token, which is out-of-band by design).

**Interplay with API-key sessions and the `api_key`/`bootstrap` origins (ADR-0028).** The IP
policy governs **human browser sessions**. Its interaction with each origin is explicit and
fail-safe:
- Sessions of `origin` `password` | `oidc` | `saml` are human logins — fully governed by the IP
  policy at both login and (if continuous) every use.
- Header **API-key** requests (`via: "api-key"`, no session) and `origin='api_key'` **exchanged**
  sessions represent automation/IDE access, which legitimately runs from CI runners, cloud
  functions, and developer laptops off the corporate network. The org IP allow-list is intended for
  *interactive* access, so by default it does **not** apply to the API-key path — **but** a
  separate, explicit `org_settings.api_key_ip_policy` (same shape, default `off`) lets a
  high-assurance deployment extend CIDR enforcement to API keys too. The two are separate knobs so
  an admin makes a conscious choice rather than accidentally locking out all automation by tightening
  the human policy — and neither knob can *exempt* a human session; there is no direction in which
  turning on a policy loosens another path.
- The `bootstrap` origin (deploy-time operator token) is never IP-restricted — it is the
  break-glass path and is already scoped to "dies when the bootstrap token is unset."

**Audit.** Session list access, every single/all revocation, every network-policy denial and
every continuous-enforcement mid-session force-revoke write to the single audit log
(`objectType: "user"`), naming actor, session, client IP, and the policy/CIDR that fired.

## Consequences

- **Easier**: security teams get the session-governance table stakes — see every device, revoke
  one or all, force logout, and confine interactive access to corporate networks by CIDR — built
  on the session model that already exists rather than a new subsystem. Users get self-service
  "sign out other devices". Continuous enforcement gives a genuine "trusted network only" posture,
  not just login-time filtering.
- **One enforcement path preserved**: sessions still only end via `revoked_at`/expiry checked in
  `resolveSession`; per-session revocation and force-logout are finer callers of the same
  mechanism, so there is no parallel enforcement to drift out of sync.
- **Deliberately given up / out of scope**: device *fingerprinting* and binding a session to a
  device as an auth factor (the token stays the sole credential); geo/IP *reputation* logic;
  step-up re-auth on a risk signal (that is future ABAC/MFA-policy work, cross-referenced to
  ADR-0040). We store `last_seen_ip` and can *revoke* on change under continuous policy, but we do
  not build anomaly scoring here.
- **Honest risks**: (1) `enforce_continuous` behind a misconfigured proxy where `req.ip` is the
  proxy address would either allow-all (if the proxy IP is listed) or deny-all — the trusted-proxy
  posture is load-bearing and the boot-time posture print + admin self-lockout guard are the
  mitigations, but a BYOC operator can still footgun their network config; (2) IPv6, CGNAT, and
  corporate egress-IP churn make CIDR allow-lists operationally fiddly — an allow-list that's too
  narrow generates support pain, too broad is theater, and keeping it current is a real admin
  burden we should document, not hide; (3) the human/API-key split means an admin who wants *total*
  network confinement must set both knobs — surfaced in the UI so "humans are confined but CI is
  not" is a visible, chosen state.
- **Follow-up work**: migration adding `last_seen_ip` to `auth_sessions` and the
  `session_ip_allowlist` / `session_ip_policy` / `api_key_ip_policy` columns to `org_settings`;
  the single-session and self-service revocation routes; the CIDR match + fail-closed evaluation in
  the auth hook (login-time and continuous); CIDR validation + admin self-lockout guard on the
  settings write; the device-label UA parse for the session-list UI; and admin-portal +
  account-security session screens.
