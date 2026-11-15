# Microsoft Entra ID: sign-in (OIDC) and provisioning (SCIM)

This guide connects RegulAIt directly to an Entra ID tenant. It does not use the Keycloak broker; for the broker, see
[SSO_KEYCLOAK.md](SSO_KEYCLOAK.md). Replace `<public-url>` with your gateway's `REGULAIT_PUBLIC_URL` and `<tenant-id>`
with your directory (tenant) ID.

## 1. App registration (sign-in)

1. In the Entra admin center, go to **App registrations** and create a new registration:
   - **Supported account types:** this organizational directory only (single tenant).
   - **Redirect URI (Web):** `<public-url>/auth/oidc/callback`.
2. Under **Certificates & secrets**, create a client secret. Store it in your secret manager; it is entered once in
   step 3 below.
3. Under **Token configuration**, add the `email` and `xms_edov` optional claims to the **ID** token. Add the
   `groups` claim too if you map groups to roles; see step 4 below.

RegulAIt refuses a sign-in whose email is not verified. Entra marks a verified email with `xms_edov: true`, not with
the standard `email_verified` claim. RegulAIt accepts `xms_edov` only from your tenant's own issuer
(`https://login.microsoftonline.com/<tenant-id>/v2.0`, with a matching `tid`; ADR-0326). Without the `xms_edov`
claim, every login is refused with `email_not_verified`.

## 2. Allow the issuer

`login.microsoftonline.com` must be on the egress allow-list:

```sh
curl -sS <public-url>/v1/egress-allow-hosts -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"host":"login.microsoftonline.com","note":"Entra ID sign-in"}'
```

## 3. Add the provider

```sh
curl -sS <public-url>/v1/auth/oidc-providers -H "Authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"name":"entra","issuer":"https://login.microsoftonline.com/<tenant-id>/v2.0","clientId":"<client-id>","clientSecret":"<secret>"}'
```

## 4. Groups

Entra sends group **object IDs** (GUIDs) in the `groups` claim. Map those IDs to roles, not group names. A user in
more than 200 groups gets an overage pointer instead of the list, and RegulAIt does not follow it yet
(PILOT_READINESS G0-3). For the pilot, emit only the groups assigned to the application.

## 5. Provisioning (SCIM)

1. Mint a SCIM token: `POST <public-url>/v1/scim/tokens` with `{"name":"entra"}`. SCIM is a licensed feature.
2. In **Enterprise applications**, open your app, then go to **Provisioning** and set the mode to **Automatic**:
   - **Tenant URL:** `<public-url>/scim/v2`
   - **Secret token:** the token from step 1
3. **Attribute mappings (users).** Keep only these mappings and delete the rest:

   | Entra attribute | SCIM attribute |
   |---|---|
   | `userPrincipalName` | `userName` |
   | `Switch([IsSoftDeleted]…)` (the default) | `active` |
   | `displayName` | `displayName` |
   | `mail` | `emails[type eq "work"].value` |
   | `objectId` | `externalId` |

   The other default mappings (`name.givenName`, `name.familyName`, `title`, addresses, phone numbers, the enterprise
   extension) are refused when Entra sends an update for them (PILOT_READINESS G0-2).

4. **Groups.** Keep `displayName`, `externalId` (`objectId`) and `members`.

The gateway must be reachable from Entra's provisioning service over HTTPS.

## Manual check (sign-in)

Open `<public-url>`, choose the Entra provider and sign in as a test user who has been provisioned (step 5) or
linked. A refused sign-in is audited with its reason; `email_not_verified` means the `xms_edov` optional claim is
missing from the ID token (step 1.3).
