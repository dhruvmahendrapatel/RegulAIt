# ADR-0036: SAML 2.0 SSO as a second federated login path beside OIDC

- **Status**: Proposed
- **Date**: 2026-08-01

## Context

RegulAIt already has one federated login path: OIDC, built on `openid-client` in
`apps/gateway/src/auth.ts` (PKCE, server-side `state`/`nonce`, single-use `oidc_login_states`
rows) with a multi-IdP registry in the `oidc_providers` table (`packages/db/src/schema.ts:122`)
and default-deny JIT provisioning (`oidc_providers.jit_provisioning` defaults `false`; an unknown
verified-email subject is 403'd and audited per ADR-0025). Identity always maps on the **verified
email claim** (`email_verified === true`), never on a locally-editable field.

A large share of regulated enterprise buyers — the exact buyer this product's governance pillar
targets — still standardize on **SAML 2.0**, not OIDC. Their IdPs (ADFS, Okta, Azure AD /
Entra, Ping, Shibboleth, Google Workspace) are frequently configured for SAML first, and a
security team's existing SSO integration runbooks, certificates, and audit tooling are SAML-shaped.
Refusing SAML forecloses those deals. We therefore need a **second** federated path that sits
*beside* OIDC rather than replacing it — the two must be co-equal, share the same session
machinery, and be governed by the same default-deny posture.

SAML is also a notoriously sharp protocol. Its security rests entirely on correct **XML digital
signature** verification, and the class of **signature-wrapping (XSW)** and **canonicalization**
attacks against SAML has broken many hand-rolled and even library-based implementations. Any
decision here has to be explicit about which library carries that burden and what we do *not*
trust ourselves to implement.

## Decision

Add SAML 2.0 as a parallel federated login path, mirroring the OIDC design point-for-point.

**Library.** Use a maintained, security-focused SAML SP library rather than hand-rolling XML
signature verification — `@node-saml/node-saml` is the proposed choice (the actively-maintained
successor to `passport-saml`'s core, decoupled from Passport, with the XSW-hardening history that
matters most here). Hand-rolling SAML XML-dsig is explicitly out of scope: the one thing this ADR
will not do is write our own canonicalization or signature-reference resolution. If a later
security review finds the chosen library wanting, the decision is to *swap the library*, never to
in-house the crypto. The library boundary is the whole point.

**Registry — a SAML twin of `oidc_providers`.** A new `saml_providers` table mirrors
`oidc_providers` shape-for-shape so the admin surface, JIT policy, and audit `objectType` extend
by analogy rather than by a new pattern:
- `name` (unique), `enabled` (default true).
- `entity_id` (our SP entity id is deployment-global; this column is the **IdP** entity id /
  issuer we pin assertions against).
- `idp_sso_url` (IdP SingleSignOn endpoint for SP-initiated redirects).
- `idp_signing_cert` — the IdP's X.509 signing certificate(s), stored as PEM. Assertions are
  verified against *this pinned cert*, never against whatever the assertion embeds. Supports a
  list so a certificate **rollover** can stage the new cert before the IdP cuts over.
- `allowed_email_domains` (jsonb, nullable) — identical semantics to OIDC: null = any domain,
  else the verified email's domain must be listed.
- `default_role_id` (nullable FK to `roles`, `ON DELETE SET NULL`) — the baseline role a
  JIT-provisioned user receives; **never admin**, exactly as OIDC.
- `jit_provisioning` (boolean, **default false**) — default-deny: an unknown subject with JIT off
  is 403'd and audited.
- `want_assertions_signed` (default true) and `want_authn_response_signed` — posture flags passed
  straight to the library; we default to requiring signatures and refuse to weaken them via config
  in a way that could silently accept an unsigned assertion.

No IdP secret is symmetric here the way an OIDC `client_secret` is, but any SP-side private key
(for optional request signing / encrypted assertions) is stored **write-only, AES-256-GCM under
`REGULAIT_DATA_KEY`**, identical to how `oidc_providers.client_secret_ciphertext` and TOTP
secrets are already handled.

**Both initiation modes.**
- **SP-initiated** (preferred): `GET /auth/saml/:providerId/start` builds an `AuthnRequest`,
  persists a single-use correlation row — a `saml_login_states` twin of `oidc_login_states`
  carrying the request `id`, a `relay_state`, the `returnTo` (restricted to `/app` or `/admin`
  as OIDC already does), and a short expiry — and 302s to the IdP.
- **IdP-initiated**: `POST /auth/saml/:providerId/acs` (Assertion Consumer Service) accepts an
  unsolicited assertion. IdP-initiated SSO is a known CSRF/stolen-assertion risk surface, so it is
  **opt-in per provider** (`allow_idp_initiated`, default false) and, when enabled, still runs the
  full validation below. When disabled, an assertion with no matching outstanding `InResponseTo`
  correlation row is refused.

**Assertion validation (the security core), all delegated to the library, all mandatory:**
- **Signature**: the assertion (and/or response) must be signed and must verify against the
  provider's pinned `idp_signing_cert`. This is what defeats signature-wrapping: we trust the
  library's reference-resolution + canonicalization, and we pin the cert out-of-band rather than
  from the document.
- **Audience**: the `<AudienceRestriction>` must name our SP entity id. An assertion minted for a
  different SP is refused.
- **Recipient / ACS URL**: the `Recipient` must match our ACS endpoint.
- **Clock skew**: `NotBefore` / `NotOnOrAfter` are enforced with a **bounded** skew tolerance
  (small, single-digit minutes — mirrors the ±1 TOTP step tolerance already in the codebase),
  configurable but never unbounded.
- **Replay**: the assertion `ID` is recorded and refused on reuse within its validity window
  (a `saml_assertion_ids` seen-set, swept by expiry), the SAML analogue of the OIDC single-use
  `state` row and the TOTP `lastUsedStep` guard.

**Identity mapping — verified email, exactly like OIDC.** The subject is resolved from the SAML
**email attribute** (the `NameID` when its format is `emailAddress`, else a configured email
attribute), and the account is matched via the existing `loadUserByEmail` on `users.email`.
RegulAIt **never** maps a SAML session onto `users.username` (ADR-0030's locally-editable second
identifier) — a username is admin/self-managed and would let a compromised or misconfigured IdP
attribute impersonate another account. Where the IdP can assert an email-verified signal we honor
it; where it cannot, mapping on a domain-allow-listed, IdP-signed email attribute is the trust
anchor, and `allowed_email_domains` is the mandatory backstop (an admin who enables a provider
without pinning domains is choosing to trust every email that IdP asserts — surfaced in the UI).

**Default-deny JIT and session minting.** Identical to OIDC: unknown subject + JIT off → 403 +
audit; JIT on → create a non-admin `users` row, attach `default_role_id` if set, audit
`saml-user-provisioned`. On success, mint the **same** server-side session cookie via
`createSession`, with a **new `origin` value `saml`** added to `SESSION_ORIGINS` (joining
`password | api_key | oidc | bootstrap | unknown`). Like `oidc`, the `saml` origin never receives
the ADR-0028 current-password bypass — that bypass is `api_key`-only and fails closed for every
other origin.

**Admin toggle and org interplay.** SAML providers are admin-CRUD'd under the default admin gate,
audited as a new `saml_provider` `objectType`. The existing `org_settings.sso_only` and the
"can't disable the last enabled provider while sso_only is on" lockout guard are **generalized** to
count enabled OIDC **and** SAML providers together — with SAML present, disabling the last OIDC
provider no longer strands logins if a SAML provider is live, and vice versa.

## Consequences

- **Easier**: the large SAML-first regulated buyer segment can adopt RegulAIt without an OIDC
  migration; SAML and OIDC coexist per-org (some IdPs, some providers each way); the session,
  audit, JIT, and default-role machinery is reused wholesale rather than forked.
- **We deliberately give up** owning the XML-dsig verification: the entire signature-wrapping /
  canonicalization threat class is delegated to `@node-saml/node-saml`. This is a bet that a
  maintained library verifies signatures more correctly than we would — the honest risk is that a
  library CVE becomes *our* CVE, mitigated by ADR-0017's automated dependency/CVE patching and by
  pinning + monitoring that specific package. We do not consider hand-rolling a viable fallback.
- **Residual risks to hold explicitly**: (1) IdP-initiated SSO is inherently weaker than
  SP-initiated — it is off by default and gated behind full validation when on; (2) SAML metadata
  and certificate **rotation** is operationally heavier than OIDC discovery (there is no
  `.well-known` auto-refresh), so the cert list + a rotation runbook are load-bearing, and an
  expired pinned cert fails **closed** (logins stop, which is the safe direction); (3) mapping on
  an IdP email attribute is only as trustworthy as the IdP's own email verification — the
  domain allow-list is the required mitigation and the UI must make an empty allow-list a
  conscious choice, not a default.
- **Follow-up work created**: migrations for `saml_providers`, `saml_login_states`,
  `saml_assertion_ids`; the `saml` `SESSION_ORIGINS` value + migration CHECK update; the
  `saml_provider` audit `objectType`; admin-portal SAML provider CRUD screens; SP metadata
  publication endpoint (`/auth/saml/:providerId/metadata`) so IdP admins can consume our SP
  config; and generalizing the sso_only lockout guard to both provider families. Group/attribute
  → role mapping is **out of scope here** and specified in ADR-0038; this ADR provisions only the
  `default_role_id` baseline.
