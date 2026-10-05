# Enterprise sign-in with the bundled Keycloak broker (ADR-0174)

regulAIt is a standard OIDC relying party (authorization code + PKCE, state bound to the browser). It can
talk to any OIDC or SAML identity provider directly — Entra ID, Okta, Auth0, Ping, WorkOS — from
**/ui/admin/sso**. This page covers the **optional bundled broker**: a Keycloak that sits between regulAIt
and Microsoft, Google and GitHub, and enforces multi-factor authentication (a one-time code or a passkey)
before it vouches for anyone.

```
browser ──► regulAIt sign-in page ── "Continue with Microsoft" ──► Keycloak (realm regulait)
                                                                      │  kc_idp_hint=microsoft
                                                                      ▼
                                                        Microsoft / Google / GitHub
                                                                      │
                                       Keycloak: first-broker login, then MFA (code or passkey)
                                                                      │  ID token: email_verified, amr=[otp|hwk]
regulAIt /auth/oidc/callback ◄────────────────────────────────────────┘
```

Nothing here is on by default. Existing local sign-in, one-time passwords, TOTP and any SSO provider you
already configured keep working unchanged.

## What has and has not been verified

| | |
| --- | --- |
| Realm import (`infra/keycloak/realm-regulait.json`) on **Keycloak 26.8.0** | verified: imports cleanly; environment placeholders are substituted; the default flows (first broker login, …) are added beside ours |
| `kc_idp_hint` routing (`microsoft`, `github`) and the three IdP buttons on Keycloak's own page | verified against a running 26.8.0 with the imported realm |
| Wrong `redirect_uri` refused by the `regulait-gateway` client | verified (400) |
| `amr` claim carrying `otp` / `hwk` after the MFA step, including after a brokered login | **not verified end to end** — needs real upstream apps. Check it on your first login (see [First-login checklist](#first-login-checklist)) |
| Real Microsoft / Google / GitHub logins | not verified here (no upstream apps) |

## 1. Start the broker

```sh
# secrets — generate, never commit (a .env next to docker-compose.yml, mode 600)
echo "REGULAIT_KC_GATEWAY_CLIENT_SECRET=$(openssl rand -hex 32)" >> .env
echo "REGULAIT_KC_ADMIN_PASSWORD=$(openssl rand -base64 24)"   >> .env
echo "REGULAIT_KC_DB_PASSWORD=$(openssl rand -hex 24)"         >> .env   # Keycloak's own database role
echo "REGULAIT_PUBLIC_URL=https://regulait.acme.example"        >> .env   # where browsers reach regulAIt
echo "REGULAIT_KC_HOSTNAME=https://id.acme.example"             >> .env   # where browsers reach Keycloak
chmod 600 .env

docker compose --profile sso up -d keycloak
```

The `keycloak` service refuses to start while `REGULAIT_KC_GATEWAY_CLIENT_SECRET`,
`REGULAIT_KC_ADMIN_PASSWORD` or `REGULAIT_KC_DB_PASSWORD` is empty (none of them has a default). Keycloak
stores its data in a separate `keycloak` database on the same Postgres and signs in as its **own** role,
`keycloak`, which owns that database and nothing else. The one-shot `keycloak-db-init` service creates both
(and re-running it rotates the role's password to the current `REGULAIT_KC_DB_PASSWORD`); the gateway's own
database role is never used by Keycloak and is not changed. On a managed Postgres, create the same role and
database yourself and point `KC_DB_URL` at it.

`--import-realm` imports the realm **only when it does not exist yet**. After the first start, change the
realm in the admin console (or with `kcadm.sh`), not by editing the JSON — edits to the file are ignored
for an existing realm. Secrets in the JSON are placeholders only:

| Placeholder | Meaning |
| --- | --- |
| `REGULAIT_PUBLIC_URL` | regulAIt's public base URL; the client's redirect URI is `${REGULAIT_PUBLIC_URL}/auth/oidc/callback` |
| `REGULAIT_KC_GATEWAY_CLIENT_SECRET` | the `regulait-gateway` client secret — the same value goes into /ui/admin/sso |
| `REGULAIT_KC_MICROSOFT_CLIENT_ID` / `_CLIENT_SECRET` / `_TENANT` | Entra app registration; tenant defaults to `organizations` (work and school accounts of any tenant). Set your tenant id to admit only your organisation |
| `REGULAIT_KC_GOOGLE_CLIENT_ID` / `_CLIENT_SECRET` / `_HOSTED_DOMAIN` | Google OAuth client; `HOSTED_DOMAIN` (e.g. `acme.example`) restricts to one Workspace domain — a **deployment setting**, see below |
| `REGULAIT_KC_GITHUB_CLIENT_ID` / `_CLIENT_SECRET` | GitHub OAuth app |
| `REGULAIT_KC_SMTP_*` | outbound mail for email verification (needed for all three upstream IdPs, see below) |

Prefer a secret store over a plain `.env` where you have one: compose `secrets:` files, Docker/Kubernetes
secrets, or your cloud's secret manager injecting the same environment variables. Never put a secret in
`realm-regulait.json`, in the repository, or in a ticket.

## 2. Register the three upstream apps

The broker callback for each provider is `https://<REGULAIT_KC_HOSTNAME>/realms/regulait/broker/<alias>/endpoint`.

**Microsoft Entra ID** (Azure portal → Microsoft Entra ID → App registrations → New registration)
- Supported account types: *Accounts in any organizational directory* (multi-tenant) or *this directory
  only* (single tenant — then set `REGULAIT_KC_MICROSOFT_TENANT` to your tenant id).
- Redirect URI (Web): `https://id.acme.example/realms/regulait/broker/microsoft/endpoint`.
- Certificates & secrets → new client secret → `REGULAIT_KC_MICROSOFT_CLIENT_SECRET` (note its expiry and
  rotate before it lapses). Application (client) id → `REGULAIT_KC_MICROSOFT_CLIENT_ID`.
- API permissions: `openid`, `profile`, `email` (delegated, Microsoft Graph).
- The Entra `email` claim is not a verified address for multi-tenant apps, so the realm sets
  **trustEmail = off** for Microsoft: Keycloak verifies the address by email on first login (configure SMTP)
  before it will assert `email_verified`. regulAIt refuses any login without `email_verified=true`.

**Google** (Google Cloud console → APIs & Services → Credentials → OAuth client ID → Web application)
- Authorized redirect URI: `https://id.acme.example/realms/regulait/broker/google/endpoint`.
- Configure the OAuth consent screen (internal for Workspace-only use).
- The realm sets **trustEmail = off** for Google too (security review, ADR-0174 amendment): an address is
  verified by Keycloak itself, by email, on first login (configure SMTP), rather than on the upstream's
  word — the same rule for all three IdPs.
- **`REGULAIT_KC_GOOGLE_HOSTED_DOMAIN` is a deployment setting, not a default.** Set it to your Workspace
  domain (e.g. `acme.example`) and Keycloak asks Google for that domain only (`hd`); leave it empty and any
  Google account can reach the broker, so also set *Allowed email domains* on the provider in regulAIt.
  It is read from the realm import on first start; change it later in the admin console
  (Identity providers → google → Hosted domain).

**GitHub** (Settings → Developer settings → OAuth Apps → New OAuth App; or an organisation-owned app)
- Homepage URL: `https://regulait.acme.example`.
- Authorization callback URL: `https://id.acme.example/realms/regulait/broker/github/endpoint`.
- Scope requested by the realm: `user:email`. The realm sets **trustEmail = off** for GitHub, so Keycloak
  verifies the address by email on first login.

**First broker login stays Keycloak's stock flow.** Every IdP uses `first broker login`, which — when a
brokered identity matches an existing Keycloak user by email — asks the person to confirm the link by email
or by re-authenticating as that user. Do not replace it with a flow that links automatically.

Leave a provider's id as `unset` (the default) and its button still appears in Keycloak but cannot complete;
in regulAIt, only the IdPs you tick on the provider are shown (next section). Disable unused IdPs in the
Keycloak admin console.

## 3. Connect regulAIt to the broker

1. **Egress allow-list** (/ui/admin → Egress allow-list): add the Keycloak host. OIDC discovery, token and
   JWKS calls go through the egress guard (ADR-0043); a self-hosted broker on a private address needs the
   private-range opt-in, and plain `http://` needs the plaintext opt-in — use TLS anywhere real.
2. **/ui/admin/sso → Single sign-on — OIDC providers → Add provider**
   - Issuer URL: `https://id.acme.example/realms/regulait`
   - Client id: `regulait-gateway`; client secret: the value of `REGULAIT_KC_GATEWAY_CLIENT_SECRET`
   - **Broker sign-in buttons**: `microsoft, google, github` (any subset). This is what makes the sign-in
     page show “Continue with Microsoft / Google / GitHub”; each button calls
     `/auth/oidc/<provider>/login?idp=<name>`, which regulAIt checks against an allow-list and passes to
     Keycloak as `kc_idp_hint`.
   - Allowed email domains, JIT provisioning and the JIT default role behave exactly as for any OIDC
     provider (JIT is off by default: unknown people are refused).
   - MFA acr values: leave blank — the realm emits RFC 8176 `amr` (`otp` for a code, `hwk` for a passkey).
   - **Broker enforces MFA**: tick it for the bundled realm. Its brokered logins can report a single `otp`
     or `hwk`, which regulAIt counts as MFA only from a provider flagged as an MFA-enforcing broker.
3. **Require MFA** (/ui/admin/sso → Sessions policy → Require TOTP MFA = admins or everyone). For federated
   sign-ins this means the ID token must assert MFA: `amr` contains `mfa`, or names two distinct factor
   classes (something you know — `pwd`, `pin` — plus something you have or are — `otp`, `hwk`, `swk`,
   `sms`, `fpt`, …); a single `otp`/`hwk`/`swk` counts only from a provider flagged *Broker enforces MFA*;
   or `acr` is one of the provider's configured MFA acr values. A SAML provider's equivalent is its list of
   multi-factor AuthnContextClassRef values; a SAML login without one steps up to the person's regulAIt TOTP
   (or enrolment) before a session exists. An OIDC token without MFA is refused with a clear
   page and an audit row (`oidc-mfa-not-asserted`); a token with it satisfies the requirement without a
   regulAIt TOTP enrolment. Local accounts keep regulAIt's own TOTP.

The public endpoint `GET /auth/sign-in-options` tells the sign-in page which buttons to show. It names
provider ids and display names only — never an issuer, client id, secret or domain list.

## 4. Accounts: linking, break-glass and demo personas

- **Linking without takeover.** A federated identity links to an existing regulAIt account on the
  verified email only when that account has **never been used**: never signed in, no federated identity
  yet, and no local credential (an admin or SCIM created it for exactly this person). Any other account —
  one already linked to an identity provider, or one that has signed in before — is linked only after the
  person proves it once (password, plus authenticator code if enrolled) in the same browser, or an admin
  approves the request in /ui/admin/sso → Account-link requests (two different admins for an administrator
  account). Nobody can approve a link to their own account. The (provider, issuer, subject) is the anchor
  from then on; changing a provider's issuer or entity id removes its links.
- **Existing SSO users keep working.** Someone who signed in through a provider before this release is
  linked automatically the next time they sign in through that same provider with the same verified email
  (the evidence is their earlier `login-succeeded` audit row naming the provider). Through any other
  provider, they prove the account or are approved like anyone else.
- **Break-glass.** Once SSO works, /ui/admin/sso → Sessions policy → *Email sign-in = break-glass admins
  only* refuses password sign-in — and the API-key browser exchange — for everyone except the
  administrators you tick there (anyone else gets the same answer as a wrong password or an unknown key).
  It refuses to engage without an enabled SSO provider and at least one ticked admin who has a password,
  and while it is on, the change that would remove either is refused by name: demoting or deactivating
  the last usable break-glass admin (`break_glass_last_admin`, also from SCIM) and disabling or deleting
  the last enabled SSO provider (`break_glass_last_sso_provider`). Tick more than one break-glass admin. A
  demoted admin leaves the list automatically. Keep the deploy-time bootstrap token procedure (INSTALL.md)
  as the last-resort recovery.
- **Demo personas** keep signing in with a password set by `demo:set-passwords` (see the README).

## 5. Hardening

- **The admin console is not public.** The compose service binds `8080` to loopback only. In front of it,
  publish only `/realms/` and `/resources/` through your TLS proxy and block `/admin/` (and `/metrics`,
  `/health` unless your monitoring needs them). For a separate admin URL reachable only from a management
  network, set `KC_HOSTNAME_ADMIN`.
- **Replace the bootstrap admin.** `KC_BOOTSTRAP_ADMIN_*` creates a temporary admin in the `master` realm.
  Create a named permanent admin (with MFA) in `master`, then delete the bootstrap user and remove
  `REGULAIT_KC_ADMIN_PASSWORD` from the environment.
- **TLS everywhere.** `KC_HOSTNAME` must be the `https://` URL browsers use; Keycloak trusts
  `X-Forwarded-*` only from your proxy (`KC_PROXY_HEADERS=xforwarded`) — do not expose `8080` directly.
- **Brute-force detection** is on in the realm (5 failures, waits growing to 15 minutes). **Self-registration
  is off.** Passwords: 12+ characters, not the username or email, no reuse of the last 5.
- **MFA policy**: every local Keycloak user configures a one-time code at first login (`CONFIGURE_TOTP` is a
  default action) and may add a passkey; every brokered login runs the `regulait post broker mfa` flow.
- **Client**: `regulait-gateway` is confidential, standard flow only (no implicit, no password grant, no
  device grant), PKCE S256 required, one exact redirect URI.
- Rotate the client secret by writing the new value in Keycloak (Clients → regulait-gateway → Credentials)
  and then in /ui/admin/sso (the secret field is write-only there).

## 6. Upgrades

- The image is pinned (`keycloak/keycloak:26.8.0`). To upgrade: read the Keycloak release notes and upgrading
  guide for every version in between, **back up first** (below), set `REGULAIT_KC_IMAGE` to the new tag in a
  staging copy, start it against a restored copy of the database (Keycloak migrates its schema on start),
  run the first-login checklist, then roll production.
- Never jump straight from an unsupported major; never run two Keycloak versions against one database.
- For air-gapped installs, add the Keycloak image to the image bundle you carry across. Note that
  Microsoft, Google and GitHub need internet egress from Keycloak — in an air gap, broker your enterprise
  SAML/OIDC IdP or LDAP/Active Directory instead.

## 7. Backups

- Keycloak's state is the `keycloak` database on the same Postgres. Back it up with the same procedure as
  regulAIt's own database (BACKUP_RESTORE.md), naming the database: `pg_dump -Fc -d keycloak`.
- A configuration-only export (no users, no secrets in a safe place) is useful for review and drift checks:
  `docker compose exec keycloak /opt/keycloak/bin/kc.sh export --dir /tmp/export --realm regulait --users skip`.
  Treat any export as sensitive.
- Restore Keycloak and regulAIt together: regulAIt's federated links are keyed on the IdP subject Keycloak
  issues, so restoring one without the other can strand those links (people then re-link by proof or admin
  approval — never silently).

## First-login checklist

1. Sign in through each enabled button with a test account. Keycloak should ask you to verify your email
   and to set up a code or passkey.
2. In regulAIt, open /ui/admin → Audit log and find the `login-succeeded` row: `detail.idpMfa` must be
   `true` and `detail.mfaVia` `amr` or `broker`. If it is `false`, Keycloak did not emit `amr` — check that the `amr`
   mapper is on the `regulait-gateway` client and that each MFA execution has its *Authenticator
   Reference* (`otp` / `hwk`) set, then turn on *Require MFA* only after this passes.
3. With *Require MFA* on, a login that skips the second factor must be refused with the
   “Multi-factor sign-in required” page.
