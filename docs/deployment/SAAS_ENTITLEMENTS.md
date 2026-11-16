# SaaS entitlement sources: the scopes and permissions agents hold in your SaaS tenants

These source kinds read, read-only, which OAuth scopes and permissions each third-party or custom app (an AI agent, a
connector, an integration) holds in a SaaS tenant, how they were granted and, for a user consent, by which users (shown
only as pseudonyms). They extend active discovery (see `WIDER_DISCOVERY.md`) and sit in its **identity** family, so two
switches stand in front of each one:

1. **The identity family switch** (Discovery sources → Settings → Wider discovery sources). Off by default; turning it
   on asks the admin to confirm it is them.
2. **The source** itself, off until enabled.

RegulAIt never changes anything in the tenant: every read is a GET, the only other call is the token request, and a
credential that may write is refused (Microsoft 365) or is asked for a read-only scope only (Google Workspace). Nothing
is revoked automatically; findings built on this graph are recommendations a person acts on.

Every call goes through the egress allow list: add the hosts named below before the first run.

## Microsoft 365 app permissions — `entitlement_m365`

Reads, for every app that is not one of Microsoft's own:

- its **delegated** permissions (what it may do for a signed-in user), and which users consented, or that an admin
  consented for everyone;
- its **application** permissions (what it may do as itself, with no user) on Microsoft Graph, Exchange Online and
  SharePoint Online.

Target: `tenantId` (the tenant's GUID). Scope: organisation level, or a list of client application ids.

Credential (public config `tenantId`, `clientId`), as for `idp_entra`:

- **Federated (default, no stored secret).** An app registration with a federated credential trusting RegulAIt's
  federation issuer, audience `api://AzureADTokenExchange`, subject `regulait:discovery-source:<source id>`.
- **Static (a relaxation).** The app registration's client secret.

Application permissions to grant (admin consent), and nothing else: `Application.Read.All`,
`DelegatedPermissionGrant.Read.All` and `AppRoleAssignment.Read.All` (or `Directory.Read.All`). Every run reads the
token's permissions; any permission that is not `*.Read.All` or `*.ReadBasic.All` refuses the credential before anything
is read.

Egress: `login.microsoftonline.com` and `graph.microsoft.com`.

A run that could not read every listing to its end (a permission missing, a listing cut short) is kept as a partial
read: it adds and refreshes what it saw and removes nothing. Only a complete read removes grants that were revoked.

## Google Workspace OAuth app grants — `entitlement_google_workspace`

Reads the OAuth grants users made to apps, from the Admin SDK Reports API (`token` activity: the latest `authorize` or
`revoke` per user and app). Google keeps these events for 180 days, so a grant authorised earlier than that is not seen;
the read is always partial and never removes a grant it did not see. A revocation it sees is applied.

Target (all optional): `customerId` (`my_customer` by default, or your `C…` customer id), `lookbackDays` (1 to 180,
default 180). Scope: organisation level, or a list of OAuth client ids.

Credential: static only (Google offers no keyless delegation RegulAIt can use yet). The secret is a service-account
key file (JSON). Public config `adminSubject`: the admin the read acts for.

In the Admin console, give the service account domain-wide delegation of exactly one scope:
`https://www.googleapis.com/auth/admin.reports.audit.readonly`. RegulAIt asks for that scope only. It does not use the
Directory API's token listing, whose only scope can also revoke tokens.

Egress: `oauth2.googleapis.com` and `admin.googleapis.com`.

## Salesforce and Slack

`entitlement_salesforce` and `entitlement_slack` are listed as "not built yet"; their readers follow.
