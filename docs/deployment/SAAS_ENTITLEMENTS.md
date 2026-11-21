# SaaS entitlement sources: the scopes and permissions agents hold in your SaaS tenants

These source kinds read, read-only, which OAuth scopes and permissions each third-party or custom app (an AI agent, a
connector, an integration) holds in a SaaS tenant, how they were granted and, for a user consent, by which users (shown
only as pseudonyms). They extend active discovery (see `WIDER_DISCOVERY.md`) and sit in its **identity** family, so two
switches stand in front of each one:

1. **The identity family switch** (Discovery sources → Settings → Wider discovery sources). Off by default; turning it
   on asks the admin to confirm it is them.
2. **The source** itself, off until enabled.

RegulAIt never changes anything in the tenant: every read is a GET, the only other call is the token request, and a
credential that may write is refused (Microsoft 365) or is asked for a read-only scope only (Google Workspace, unless an
admin opts in to the Directory token listing below, which RegulAIt still only reads with). Nothing
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

Optional, to observe use (the findings below): also grant `AuditLog.Read.All` (a read permission). The reader then
reads each app's last sign-in (`reports/servicePrincipalSignInActivities`, a Graph beta report that needs Microsoft
Entra ID P1 or P2). Without it, the usage read is denied, the grant read is unaffected, and use is reported as not
observable.

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

### Opt-in: the Directory token listing

The Reports API only sees grants made in the last 180 days. To see older grants too, an admin can turn on the
Directory API's per-user token listing. It is off by default and has two switches, both audited:

1. **The org switch**, `googleDirectoryTokens` in the discovery settings (Settings on the Discovery sources page).
   Turning it on asks the admin to confirm it is them; turning it off is free. While it is off, no source can be
   created, enabled, changed to or run with the listing, and a queued run stops before it reads a credential. The
   discovery posture lists every source configured for it.
2. **The source**, target `directoryTokens: "on"` (the default is `"off"`). It takes effect only on an enabled source:
   enabling the source, or changing the target of an enabled source, asks the admin to confirm it is them. Turning it
   back off, with nothing else changed, needs no confirmation.

With it on, delegate exactly these two scopes instead of the Reports scope:
`https://www.googleapis.com/auth/admin.directory.user.readonly` (to list users) and
`https://www.googleapis.com/auth/admin.directory.user.security` (to list each user's tokens). The second scope can also
revoke tokens. RegulAIt never does: every data call is a read, and any other request is refused inside the gateway
before it is sent. Because this listing sees every grant, a run that reads every user is complete, and a grant that
later disappears is removed from the graph.

## Linking apps to agents

An app in the graph can be linked to a RegulAIt agent, so its grants are shown against that agent.

- **Automatic, on an exact match.** Declare the agent's app id for a platform (`POST /v1/discovery/agent-identifiers`
  with the agent, the platform and the id). Every app on that platform whose id is exactly the same, including case,
  is linked to the agent, now and after each later read. Each automatic link is audited. An identifier applies to every
  source of its platform: the response and the declaration's audit row list each app and source it linked. A
  Microsoft 365 app id (a GUID) is stored lowercase, as Graph reports it. An agent with a declared identifier cannot be
  deleted until the identifier is removed, and a retired agent is never linked.
- **By hand, for anything else.** A partial or similar match is never linked automatically. An admin links it with
  `PUT /v1/discovery/entitlements/apps/<app id>/agent-link`.
- **Unlinking.** `DELETE /v1/discovery/entitlements/apps/<app id>/agent-link` removes any link, audited. An unlinked
  app is not linked automatically again; only an admin can link it.

`GET /v1/discovery/entitlements/apps?sourceId=<source id>` lists a source's apps with their link state and which link
changes are allowed next. There is no screen yet.

## Salesforce connected apps — `entitlement_salesforce`

Reads every connected app, whether any user may authorise it themselves ("All users may self-authorize"), and which
profiles and permission sets an admin pre-authorised for it.

Target: `loginUrl` (`https://login.salesforce.com`, `https://test.salesforce.com` or your
`https://<domain>.my.salesforce.com`), `orgId` (the org's `00D…` id). Scope: organisation level, or a list of connected
app ids (`0H4…`).

Credential: static only (the OAuth 2.0 JWT bearer flow). Create a connected app with "Use digital signatures" and a
certificate, pre-authorise a dedicated integration user, and store the matching private key (PKCS#8 PEM,
`BEGIN PRIVATE KEY`) as the secret. Public config: `clientId` (the consumer key) and `username` (the integration user).

Give the integration user View Setup and Configuration and API Enabled, and nothing that can change the org: a user
holding Modify All Data, Customize Application, Manage Users, Author Apex or Modify Metadata is refused before anything
is read. Because of that, connected apps' OAuth scopes (Metadata API) and every user's OAuth tokens (which need
Customize Application) are not read.

Egress: your login host and your instance host (`<domain>.my.salesforce.com`).

## Slack approved apps — `entitlement_slack`

Reads the apps approved for an Enterprise Grid org or a workspace, with each app's user and bot scopes.

Target: exactly one of `enterpriseId` (`E…`) or `teamId` (`T…`). Scope: organisation level, or a list of app ids
(`A…`).

Credential: static only. The secret is an org-level user token (`xoxp-…`) from an app installed by an org admin, with
the scope `admin.apps:read` (other `:read` scopes are tolerated). Every run checks the token's scopes first; any scope
that is not a `:read` scope refuses the credential before anything is read. The token must belong to the target org or
workspace.

Egress: `slack.com`.

## Observed use and findings

Each read also records how finely it could see the apps' use (the coverage, shown on the run's audit row):

| Source | What is observed | Coverage |
|---|---|---|
| `entitlement_m365` | each app's last sign-in (needs `AuditLog.Read.All` and Entra ID P1 or P2) | per app |
| `entitlement_google_workspace` | the token `activity` events: each app's latest read and latest write, by API method name, with the same read-only Reports scope (recorded only on Enterprise and Education Standard or Plus and Cloud Identity Premium) | reads and writes |
| Google with the Directory opt-in, Salesforce, Slack | nothing yet: no read-only usage source the reader can use | none |

`GET /v1/discovery/entitlements/findings?windowDays=90` (admin only; 7 to 365 days) computes four findings at read time,
each with its evidence and the rule's limits:

- **unused grant**: an app with no observed use in the window, for grants first seen at least the window ago;
- **excessive scope**: a write, admin or unrecognised scope held by an app that only read in the window (Google only);
- **oversharing**: a tenant-wide consent to a write, admin or unrecognised scope, with the publisher's verification;
- **publicly exposed agent**: a published Copilot Studio agent with no authentication or the "any multi-tenant" policy.

A source that could not observe use, or observed less than the window, is listed as not assessable, never as unused.
Nothing is revoked: act on a finding in the vendor's own admin console, and the next read shows the change.

