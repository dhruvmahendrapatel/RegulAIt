# ADR-0036: SAML 2.0 SSO as a second federated login path beside OIDC

- **Status**: Accepted
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

## Implementation amendment (2026-08-02)

Implemented as decided — migration **0051** (`saml_providers`, `saml_login_states`,
`saml_assertion_ids`, and the widened `auth_sessions_origin_ck` CHECK), the routes
`GET /auth/saml/providers`, `GET /auth/saml/:providerId/start`,
`POST /auth/saml/:providerId/acs`, `GET /auth/saml/:providerId/metadata` and the admin CRUD at
`/v1/auth/saml-providers` (audited as the new `saml_provider` `objectType`), the login-screen and
admin-portal SAML surfaces in the SPA, and the generalized `sso_only` lockout guard. Gateway suite
1067 → 1102 tests, all green.

**Library.** `@node-saml/node-saml` **5.1.0**, pinned as a normal dependency of
`apps/gateway`. It carries the entire XML-dsig burden — signature verification against the
provider's pinned certificate list, `AudienceRestriction`, `NotBefore`/`NotOnOrAfter` with a
bounded skew, `InResponseTo` correlation, and the single-assertion / signature-scope sanity checks.
No canonicalization or reference resolution is written here, exactly as decided. The `xml-crypto`
dev-dependency exists only so the TEST IdP can *produce* real signatures; nothing in the shipping
path uses it directly.

**Deviations and additions, all in the strict direction:**

1. **Three checks the library does not perform are performed here** — and each one reads only the
   assertion the library has ALREADY signature-verified (`profile.getAssertion()`), never the raw
   POST body, so no new XSW surface is created:
   - **Recipient**: node-saml validates Audience but does not compare
     `SubjectConfirmationData/@Recipient` to the ACS URL. It is compared here, and a
     `SubjectConfirmation` with no `Recipient` at all is refused rather than waved through.
   - **Issuer**: node-saml enforces `idpIssuer` for logout messages only, not for a login
     Response. The assertion `<Issuer>` is pinned here to `saml_providers.entity_id`.
   - **Replay**: the assertion `ID` is inserted into `saml_assertion_ids`; the UNIQUE index IS the
     refusal, so two concurrent presentations cannot both win a check-then-insert race.
2. **IdP-initiated is refused twice.** `validateInResponseTo: always` already refuses an
   unsolicited assertion inside the library; an explicit post-check refuses one whose
   `InResponseTo` is absent. The redundancy is deliberate — a moved library default must not
   silently turn unsolicited assertions into logins.
3. **`want_authn_response_signed` defaults FALSE, not true.** Requiring both signatures by default
   would break the (common) IdP that signs only the assertion. `want_assertions_signed` defaults
   TRUE, and the API refuses the `(false, false)` pair outright — on create AND against the
   effective stored pair on PATCH, so it cannot be reached in two steps.
4. **Clock skew is clamped, not merely configurable.** `REGULAIT_SAML_CLOCK_SKEW_MINUTES` defaults
   to 2 and is clamped to `[0, 9]`; node-saml's `acceptedClockSkewMs: -1` ("skip timestamp checks")
   is unreachable from configuration.
5. **The correlation cache is the database, not memory.** node-saml's default `CacheProvider` is
   in-process, which would fail OPEN across a restart or a second gateway process. It is backed by
   `saml_login_states` instead, which is also what makes the correlation row single-use.
6. **`allow_idp_initiated` is a per-provider column** as decided; a REPLAYED *solicited* assertion
   is refused by the single-use correlation row before it ever reaches the replay seen-set — a
   strictly stronger refusal, and the test asserts both paths.
7. **SP entity id is deployment-global and request-derived** (`REGULAIT_SAML_ENTITY_ID` pins it
   explicitly), mirroring how the OIDC `redirect_uri` is derived. It is not a per-provider column;
   `saml_providers.entity_id` is the IdP's, per the ADR.
8. **ADR-0043 does not apply.** SAML SP-initiated login is a browser redirect and the ACS is
   inbound — the gateway makes no server-side request to the IdP, so there is no egress to guard.
   (An IdP-metadata-fetch feature would need one; none was built.)

**Interplay confirmed:** `saml` was added to `SESSION_ORIGINS` and to migration 0046's CHECK
constraint (without which every SAML session insert would 23514). ADR-0039 pre-wired `saml` into
`HUMAN_SESSION_ORIGINS`; that is now exercised — an out-of-envelope SAML login is refused at the
door with no cookie. ADR-0028's current-password bypass remains `api_key`-only: a `saml` session on
a password-less account still cannot set a password without one. ADR-0022 holds: a deactivated
account cannot sign in via SAML.

**Still open (deliberately out of scope here):** group/attribute → role mapping is ADR-0038;
Single Logout (SLO) is not implemented; encrypted assertions are only partly provisioned (the SP
private key column and its write-only handling exist, the `decryptionPvk` wiring does not); and the
certificate-rotation *runbook* the ADR calls load-bearing is documentation work, not code.
