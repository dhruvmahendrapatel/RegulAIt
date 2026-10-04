# ADR-0174: Enterprise sign-in through a brokered identity provider (Microsoft, Google, GitHub) with MFA

- **Status**: Accepted (owner, 2026-10-04: "use one of the existing ones that allow auth into Microsoft SSO, Google SSO,
  GitHub … then tie up with another for MFA … use the best one out there, without making any current flows break")
- **Date**: 2026-10-04
- **Builds on**: existing OIDC/SAML SSO (`sso-providers.ts`, `saml.ts`), SCIM (`scim.ts`), local TOTP, AUTHZ-04 (SSO state
  bound to the browser)

## Context

RegulAIt already acts as an OIDC and SAML relying party and supports SCIM and TOTP for local accounts, but the sign-in page is
home-built and offers no one-click Microsoft, Google or GitHub sign-in, and MFA for federated users depends on whatever each
customer's IdP does. GitHub in particular offers OAuth, not OIDC sign-in, so it cannot be added as a plain OIDC provider. The
product must also keep working in bring-your-own-cloud and air-gapped deployments (pillar 3), which rules out making a hosted
identity SaaS mandatory.

## Decision

1. **Keycloak is the bundled identity broker.** Open source (CNCF), self-hostable and air-gap friendly, it brokers Microsoft
   Entra ID, Google and GitHub (plus SAML/OIDC enterprise IdPs and LDAP/Active Directory), and provides MFA itself: one-time
   codes (TOTP) and passkeys/WebAuthn, brute-force protection and step-up flows. It ships as an optional compose service with a
   realm import; no client secret is ever committed (environment or secret files only).
2. **RegulAIt stays a standard OIDC relying party** (PKCE, browser-bound state per AUTHZ-04). Keycloak is the default, not a
   lock-in: any OIDC/SAML IdP — Entra ID, Okta, Auth0, Ping, WorkOS — can be configured directly, consistent with the
   provider-agnostic principle.
3. **Sign-in page**: "Continue with Microsoft / Google / GitHub" (provider logos; each button passes the broker an IdP hint) when
   the broker is configured, "Single sign-on" for organisation-configured enterprise IdPs, and "Sign in with email" for local
   accounts. Local accounts remain for break-glass and demo use; an admin may disable local sign-in organisation-wide once SSO
   works, except for a designated break-glass admin.
4. **MFA**: required at the broker for federated users by policy (code or passkey); local accounts keep RegulAIt's TOTP. When the
   organisation requires MFA, RegulAIt refuses a federated session whose token does not assert MFA (`amr`/`acr`).
5. **Account linking without takeover**: a federated identity links to an existing local account only when the IdP asserts a
   verified email **and** the user proves the local account (password + TOTP) or an admin approves; otherwise JIT provisioning
   creates a new account. SCIM is unchanged.
6. **Demo accounts** keep working with a password set by a one-time command that reads it from the environment
   (`REGULAIT_DEMO_USER_PASSWORD`) or a secret file — never from the repository, seed data, logs or audit detail — and refuses to
   run outside a demo-licensed deployment.

## Consequences
- Existing local sign-in, one-time-password onboarding, TOTP and org-configured SSO keep working unchanged; the new paths are
  additive and off until configured.
- Operating Keycloak (upgrades, backups, admin hardening) becomes part of the deployment guide; hosted fast-start may use a
  managed Keycloak or any OIDC IdP instead.

## Amendment — security review fixes (2026-10-04)

Rules as built (migration 0139 edited in place before first push):

1. **SAML MFA.** When the org requires MFA for the person, a SAML login mints a session only if the *verified*
   assertion's AuthnContextClassRef is one the provider lists in `mfa_authn_contexts` (the twin of OIDC
   `mfa_acr_values`). Otherwise an account with TOTP steps up to it first (pending row with `origin = 'saml'`,
   HttpOnly cookie, `POST /auth/mfa/verify` mints the `saml` session); an account without TOTP gets its session
   and the MFA gate sends it to enrolment, as before.
2. **Linking.** A verified email links without proof only an account that has **never signed in** (no session,
   no `login-succeeded` row), has **no federated identity** and **no local credential**. An account already
   federated, or ever signed in, needs proof (password + TOTP when enrolled) or admin approval. **Existing SSO
   users:** pre-0139 sessions record only the origin, so the evidence is the pre-0139 `login-succeeded` audit row
   (actor = the user, `method` oidc/saml, `provider` = the provider row's name, same email, not older than the
   row, and no `providerId` key — every post-0139 row carries one). That user's next sign-in through the same
   provider row links as `prior_sso`; no migration backfill is possible (pre-0139 rows never recorded the
   subject). Bounded by audit retention: if those rows were pruned, proof or approval. Keycloak: `trustEmail` is
   off for every upstream IdP; the stock first-broker-login flow stays; Google `hostedDomain` is a deployment
   setting.
3. **Break-glass.** Decided before the password result is trusted: everyone else gets the wrong-password 401
   after the same scrypt cost, and a refused login neither resets nor advances the lockout counter. The org may
   name **several** break-glass admins. While `break_glass_only` is on, demoting or deactivating the last usable
   one (admin API and SCIM) and disabling or deleting the last enabled SSO provider are refused
   (`break_glass_last_admin`, `break_glass_last_sso_provider`); a demoted admin is dropped from the list. Users are
   never hard-deleted and no route clears a password, so those are the user-side events. `/auth/login-with-key`
   is refused (as an unknown key) for anyone not break-glass; `apiKeyExchange` in sign-in options says so.
4. **amr.** MFA is `mfa`, or two distinct factor classes (know / have / are). A single `otp`/`hwk`/`swk` counts
   only from a provider flagged `broker_enforces_mfa` (set it for the bundled realm).
5. **Anchors.** Links and link requests are keyed on (provider, issuer, subject format, subject): OIDC `iss`, SAML
   entity id + NameID Format. A transient (or absent) NameID is never an anchor — the verified email under the
   pinned entity id anchors instead, created only through the rules above. Changing a provider's issuer or entity
   id deletes its links and pending requests (audited `federated-identities-reset`).
6. **Email.** NFKC-normalised, trimmed, lower-cased; a claim that is not plain ASCII as sent never links (nor is
   JIT-provisioned), and only all-ASCII stored addresses are compared.
7. **Approvals.** Nobody approves a link to their own account; a link to an **admin** account needs two distinct
   approvers (the bootstrap operator counts as one). `link/confirm` checks "identity already linked" before
   spending the request.
8. **Demo.** `demo:set-passwords` requires a valid demo licence (run it after `demo:setup` / `demo:prepare`).
9. **Ops.** The unauthenticated `/auth/oidc/:id/login` is in the per-IP auth rate-limit tier and writes no audit row
   for an unknown provider. Keycloak uses its own `keycloak` database role (password `REGULAIT_KC_DB_PASSWORD`, no
   default) that owns only the `keycloak` database.
