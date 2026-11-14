# ADR-0240: One second factor (TOTP) for the external portals: supplier and auditor

- **Status**: Accepted (builder slice; API and backend only, the screens are the Governed Designer's on #453)
- **Date**: 2026-11-07
- **Index**: One second factor (TOTP) for the external portals, supplier and auditor (the ADR-0221 and ADR-0225 MFA follow-ups)
- **Driver**: the "supplier MFA" follow-up of [ADR-0221](0221-supplier-portal.md) and the "auditor MFA" follow-up of
  [ADR-0225](0225-outward-trust-pages.md), dispatched together by the master session. The ADR-0200 security checklist
  requires MFA for admins and step-up, and these two portals are external principals reaching governed data.
- **Migration**: `pending/external_portal_mfa.sql` (numbered at merge, ADR-0252).
- **Amends**: ADR-0221 (decisions 3 and 4, the sign-in) and ADR-0225 (the sign-in link), each with an addendum that
  points here. **Extends**: [ADR-0180](0180-continuous-assurance-strict-by-default.md) (strict by default),
  [ADR-0183](0183-post-d4-delivery-plan.md) batch 2.1 (`totp.ts` on `otpauth`),
  [ADR-0186](0186-batch4-approvals-receipts-detection.md) (step-up).

## Context

Both portals sign an outside person in through a single-use link: 256 random bits, stored as sha256, at most 72 hours
old, spent on first use. Whoever holds the link before its owner does gets the session. Both ADRs named a second
factor as the follow-up, and ADR-0225 noted it needs either an outbound mail path that works air-gapped or enrolment of
an authenticator. ADR-0225 also named consolidating the two portals' external-access pattern as a later step. A shared
second factor is the first piece of that consolidation, so one ADR covers both portals.

## Decision

1. **One implementation, reused.** The factor is TOTP (RFC 6238) through the gateway's existing `totp.ts` (the
   `otpauth` library, MIT, ADR-0183 batch 2.1). It uses the same ±1-step window and the same replay rule as the
   platform login (`POST /auth/mfa/verify`): a step at or before the last one accepted is refused. The secret is a
   data-key envelope (`secrets.ts`), and `external_mfa_factors.secret_ciphertext` is registered in `CIPHERTEXT_COLUMNS`,
   so the custody probe and the re-encryption walk cover it. Tokens use `hashToken`, and the limiter is
   `@fastify/rate-limit`. The state machine for both portals is one module, `apps/gateway/src/external-mfa.ts`. Each
   portal keeps its own routes, refusal bodies and audit object type (`supplier_access`, `auditor_grant`).
2. **Required by default (ADR-0180).** `org_settings.supplier_portal_mfa_required` and
   `org_settings.trust_auditor_mfa_required` both ship `true` (migration `external_portal_mfa`, with the strict values recorded in the
   migration outbox). Each portal's existing settings path relaxes it:
   - the supplier flag through `PUT /v1/supplier-portal/settings` (`mfaRequired`), the endpoint ADR-0221 set apart for
     its settings;
   - the auditor flag through `PUT /v1/org/settings` (`trustAuditorMfaRequired`), where `trustPagesEnabled` already
     lives, with a strictness-registry rule `notEqual(true)`.

   Turning either off is a relaxation, so it needs a `settings_relax` step-up and is audited with `detail.relaxed`.
   While a flag is on and the deployment has no data key, a link is refused **before** it is spent (503
   `mfa_unavailable`). It never falls back to link-only.
3. **Where the factor sits.** The link is redeemed exactly as before and is **spent**. With the second factor
   required, the redemption opens a **challenge**, not a session. A challenge is a `rgxm_` + 32-byte token, stored as
   sha256, that lives 10 minutes (the CHECK allows 15). It is held in an `HttpOnly; SameSite=Strict` cookie scoped to
   that portal's verify path only (`/supplier/v1/session/mfa`, `/v1/auditor/session/mfa`). A `POST` of a six-digit
   code to that path, with the CSRF header, turns the challenge into the portal's existing session (same cookie,
   lifetime and idle rules as before). The challenge cookie is cleared at the same time. The grant must still be live
   at that moment on the database clock: not revoked, not expired, vendor not retired for a supplier, and the trust
   pages still on for an auditor.
4. **One factor per external grant, enrolled on first use of a link.** `external_mfa_factors` holds exactly one of
   `supplier_access_id` or `auditor_grant_id` (CHECK `num_nonnulls = 1`, each UNIQUE, cascading with its grant). The
   portal is whichever reference is set, never a copied column (ADR-0200 normal form).
   - The first link a grant's holder redeems answers `mfa: "enrol"` with the secret and its `otpauth://` URI, once.
     The first correct code proves the enrolment (`activated_at`) and opens the session.
   - An enrolment that was never proved is no factor: the next link enrols again with a new secret, and the failure
     count carries over.
   - Once a factor is active, every later link answers `mfa: "verify"` and never shows or replaces the secret. So a
     leaked later link cannot re-enrol the factor onto an attacker's device.
   - A factor belongs to the grant, not the e-mail address: a new grant enrols afresh.
5. **Rate limits and lockout.**
   - Each portal's per-address bucket and the gateway-wide limiter still apply. A per-challenge bucket (10 codes per 15
     minutes) sits on top.
   - A wrong code and a replayed code count the same and get the same body, so a replay cannot be told from a typo.
     After **5 consecutive** failures (across challenges, reset by a correct code), the factor is **locked**: the
     refusal is 423 `mfa_locked`, its open challenges are revoked, and the lock is audited (`supplier-mfa-lockout`,
     `auditor-mfa-lockout`).
   - While a factor is locked, every new link is refused with 423 and audited.
   - The code check, the failure count and the lock commit in the same transaction as the refusal.
6. **Recovery belongs to the inviting admin, never to the external person.** `POST
   /v1/vendors/:vendorId/supplier-access/:accessId/mfa/reset` and `POST /v1/trust/auditor-grants/:grantId/mfa/reset`
   are admin-only. They need an `identity_manage` step-up and a reason.
   - A reset deletes the factor and its challenges, ends the grant's live sessions, and is audited
     (`supplier-mfa-reset`, `auditor-mfa-reset`; the audit row is the record).
   - The admin then issues a new link with the existing route, and the person enrols again.
   - `GET …/mfa` shows the state (`none`, `enrolling`, `active`, `locked`), the failure count and the times. It never
     shows the secret.
   - There is no recovery code, no e-mail reset and no "lost my device" path on the portal.
7. **Turning a portal off** also revokes its open challenges, in the same transaction that already revokes its links
   and sessions. Turning it on again revives none of them.

### Threat model (what changes)

| Threat | Before | Now |
|---|---|---|
| A forwarded, intercepted or logged link | the link was the whole credential | the link alone opens nothing; the holder also needs the enrolled authenticator |
| A leaked later link used to re-enrol | n/a | an active factor is never re-enrolled through a link; only an admin reset clears it |
| Guessing codes | n/a | 10^6 space, ±1 step, 5 consecutive failures lock, per-challenge and per-address limits, audited |
| Replaying an observed code | n/a | a step at or before the last one used is refused (same body as a wrong code) |
| Social-engineering a recovery | n/a | no self-service recovery; the inviting admin resets with a step-up, audited |
| A challenge cookie leaking to other routes | n/a | scoped to one path, HttpOnly, SameSite=Strict, 10 minutes, single use |
| Enrolling the first link's secret on an attacker's device (first link leaked before first use) | full access | still possible: the first link is trust-on-first-use (see limits) |

## Open source first (ADR-0176)

No new dependency. Reused: `otpauth` through `totp.ts`, `node:crypto`, the `secrets.ts` envelope, `hashToken`,
`@fastify/rate-limit`, and the CSRF-header convention. Considered and not used:
- WebAuthn through `@simplewebauthn/server` (MIT, already a gateway dependency for platform passkeys). It needs a
  credential store per external principal and a browser ceremony the portal screens do not have yet. It is the natural
  second factor kind to add later beside TOTP.
- A one-time code by e-mail. There is no outbound mail path that works air-gapped (ADR-0225 follow-up 1).

THIRD_PARTY.md is unchanged.

## Honest limits and follow-ups

- **Trust on first use.** Whoever redeems the first link enrols the factor. The protection is against every later
  link, a session that outlives a stolen cookie, and a forwarded link after enrolment. An admin who suspects the first
  link leaked resets the factor and issues a new link.
- **No passkey option yet** (see above), and no admin notification on lockout beyond the audit row and `GET …/mfa`.
- **The screens.** The supplier page (`/ui/supplier`) and the auditor page (`/ui/audit`) do not yet handle the
  `mfa: "enrol" | "verify"` answer. Until the Governed Designer ships them (brief on #453), an external person with
  the second factor required cannot finish signing in from the browser. That is the strict default working as
  intended, and an admin may relax the setting, audited. The mocked supplier UI spec is unaffected.

## Consequences

- A link stops being a bearer credential on its own for both portals, with one code path, one table pair and one set
  of tests (`zz-adr0240-external-portal-mfa.test.ts`: a wrong code, a replayed code, a reused link, a cross-portal
  challenge, lockout, admin reset, relaxation with step-up, a missing data key and the rate limit).
- The ADR-0221 and ADR-0225 suites pin the link-to-session flow with the requirement relaxed in their own setup, and
  put it back to strict afterwards.
