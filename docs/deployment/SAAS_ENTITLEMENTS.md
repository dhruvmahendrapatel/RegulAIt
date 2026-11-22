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

### Optional: activity logs (a guided setup, off by default)

To observe use (the findings below), the source can also read each app's last sign-in
(`reports/servicePrincipalSignInActivities`, a Graph beta report). This is off until you turn it on. Setup:

1. In the Microsoft Entra admin center, open App registrations and select this source's app. Under API permissions,
   add the Microsoft Graph **application** permission `AuditLog.Read.All`. It reads sign-in and audit logs and cannot
   change anything.
2. Grant admin consent, as a Privileged Role Administrator or Global Administrator. Use the same page, or the link
   `https://login.microsoftonline.com/<tenantId>/adminconsent?client_id=<clientId>`.
3. Check that the tenant has Microsoft Entra ID P1 or P2. Without it, Microsoft refuses the read.
4. Set the source's target `activityLogs` to `on`. On an enabled source this is a widening, so it needs a step-up.
5. Run the source.

`GET /v1/discovery/entitlements/sources/<sourceId>/read-setup` serves the steps, the consent link, and the state the
latest read observed. The state is one of:

- `off`;
- `not checked`;
- `not enabled`: refused;
- `unreadable`;
- `no activity yet`;
- `flowing`.

No app is judged unused until the state is `flowing`. The grant read is never affected by this read.

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

Target: `environment` (`production` or `sandbox`), `myDomain` (the org's My Domain URL,
`https://<name>.my.salesforce.com`, or `https://<name>--<sandbox>.sandbox.my.salesforce.com`; the only host the reader
calls) and `orgId` (the org's `00D…` id). Scope: organisation level, or a list of connected app ids (`0H4…`).

Credential: static only (the OAuth 2.0 JWT bearer flow). Create a connected app with "Use digital signatures" and a
certificate, pre-authorise a dedicated integration user, and store the matching private key (an RSA key of at least
2048 bits, PKCS#8 PEM, `BEGIN PRIVATE KEY`) as the secret. Public config: `clientId` (the consumer key) and `username` (the integration user).

Give the integration user View Setup and Configuration and API Enabled, and nothing that can change the org. A user
whose session holds Modify All Data, Modify Metadata, Customize Application, Author Apex, Manage Users, Assign
Permission Sets, Manage Profiles and Permission Sets, Manage Internal Users, Manage Roles, Manage Sharing or Reset
Passwords, or who may create, edit or delete records of any object, is refused before anything is read (the same check
as the Agentforce source).

What this default read **cannot see**, as each run's outcomes and the read-setup view state:

- connected apps' OAuth scopes: they are only in the Metadata API, which needs write-capable permissions, so they are
  never read;
- which users hold a token for each app, and when each app was last used: these need Customize Application, so they
  are read only with the opt-in below.

### Opt-in: org-wide OAuth tokens (Customize Application)

Off by default. The opt-in needs both keys:

1. An admin turns on `salesforceOrgTokens` in the discovery settings. This is a step-up, audited with its trade-off.
2. The source sets its target `orgTokens` to `on`. While the switch is off, a source asking for this is refused at
   create, change, enable and run.

The integration user may then hold **Customize Application**, and nothing else from the list above. It can change the
org's setup, so the credential is recorded as `unverified`, never `read-only`. RegulAIt still only reads:
`SELECT AppName, UserId, LastUsedDate FROM OauthToken`. The map then shows:

- who holds a token for each connected app, as pseudonyms;
- each app's last use, which feeds the unused-grant finding.

A token whose app name is missing from the listing, or is shared by two apps, is counted and not guessed. Without
Customize Application on the user, the tokens are not read: only the user's own would be visible.

Egress: your My Domain host only.

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
| `entitlement_m365` with `activityLogs: on` | each app's last sign-in (needs `AuditLog.Read.All` and Entra ID P1 or P2), once the logs flow | per app |
| `entitlement_google_workspace` | the token `activity` events: each app's latest read and latest write, by API method name, with the same read-only Reports scope (recorded only on Enterprise and Education Standard or Plus and Cloud Identity Premium) | reads and writes |
| `entitlement_salesforce` with the org-wide token opt-in | each connected app's latest OAuth token use | per app |
| Google with the Directory opt-in, Salesforce without the opt-in, Slack | nothing: no usage source the reader may use | none |

`GET /v1/discovery/entitlements/findings?windowDays=90` (admin only; 7 to 365 days) computes four findings at read time,
each with its evidence and the rule's limits:

- **unused grant**: an app with no observed use in the window, for grants first seen at least the window ago;
- **excessive scope**: a write, admin or unrecognised scope held by an app that only read in the window (Google only);
- **oversharing**: a tenant-wide consent to a write, admin or unrecognised scope, with the publisher's verification;
- **publicly exposed agent**: a published Copilot Studio agent with no authentication or the "any multi-tenant" policy.

A source that could not observe use, or observed less than the window, is listed as not assessable, never as unused.
Nothing is revoked: act on a finding in the vendor's own admin console, and the next read shows the change.

To have a second administrator decide a finding, raise it: `POST /v1/discovery/entitlements/findings/reviews` with the
finding's `key`, the `approverUserId` of another admin and a `reason`. It appears in the approvals queue. Approving it
records that the grant is to be removed or narrowed in the vendor's console; denying it records the risk as accepted.
Either way nothing is sent to the vendor, and the findings report shows the decision on the finding.

