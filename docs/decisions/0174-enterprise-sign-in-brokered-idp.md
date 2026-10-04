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
