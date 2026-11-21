# ADR-0337: SaaS entitlement graph and usage-based least privilege for agents in Microsoft 365, Google Workspace, Salesforce and Slack

- **Status**: Accepted (owner direction 2026-11-16, lane E18 brief: close the Obsidian gap analysis item "SaaS entitlement graph"; slice 1 built). Amended by the owner's decisions of 2026-11-17 on both slice 1 questions (§4 Google Directory opt-in, §6 agent links), built in slice 1
- **Date**: 2026-11-16
- **Index**: **SaaS entitlement graph: read-only `entitlement_*` discovery sources (M365 Graph, Google Workspace, Salesforce, Slack) store each agent's granted OAuth scopes and permissions in four 3NF tables, inside the run's fenced transaction with its audit row; a frozen, versioned scope classifier; usage comparison, unused-grant, excessive-scope, oversharing and public-exposure findings follow as recommendations through the approvals queue, never auto-revoked.**
- **Built in**: lane E18, branch `builder/e18-saas-entitlements` (slice 1), `builder/e18-saas-entitlements-s2` (slice 2),
  `builder/e18-saas-entitlements-s3` (slice 3a: usage and findings)
- **Migration**: `pending/saas_entitlement_graph.sql` and (slice 3) `pending/saas_entitlement_usage.sql`, numbered at merge
  (ADR-0252)
- **Related**: ADR-0195 (active discovery framework: sources, credentials, worker, pseudonyms), ADR-0235 (Entra consent
  discovery, the wider-source helpers reused here), ADR-0092 (access recommendations, the frozen rule-set discipline),
  ADR-0090 (certification campaigns), ADR-0255 (governed connector catalogue), ADR-0089 (agent ownership),
  ADR-0200 (3NF addendum, security checklist), ADR-0180 (secure by default), ADR-0176 (open source first),
  ADR-0252 (merge-time numbering)

## Context

The Obsidian Security gap analysis (2026-11-16, `internal/product/GAP_ANALYSIS_OBSIDIAN_2026-11.md`) ranks a SaaS
entitlement graph second among enterprise-buyer gaps. An AI agent built in, or connected to, a SaaS platform holds OAuth
scopes and permissions there: mail, files, CRM records, channels. RegulAIt sees what crosses its gateway and, since
ADR-0235, which apps users consented to in Entra ID (as shadow-AI findings). It does not know, per agent and per
platform, which scopes are granted, how broadly, by whom, or whether they are used. ADR-0092's unused-grant rule
right-sizes RegulAIt's own grants only.

Owner rules for this work: read-only toward vendor platforms; everything staged and default-deny until a human
approves; credentials server side and rotatable; every vendor call through the guarded fetch; audit in the same
transaction; vendor-neutral adapters; fixtures only (no live tenant).

## Decision

### 1. Entitlement readers are ADR-0195 discovery sources, not a parallel pipeline

Four source kinds join the discovery framework, in the existing `identity` family (behind its default-off org switch,
ADR-0235), each source also off until an admin enables it (a `settings_relax` step-up):

| Kind | Platform | Reads (slice) |
|---|---|---|
| `entitlement_m365` | Microsoft 365 | Graph `servicePrincipals`, `oauth2PermissionGrants` (delegated, with consenting users), and `appRoleAssignedTo` on Microsoft Graph, Exchange Online and SharePoint Online (application permissions, role ids resolved through each resource's `appRoles`). Microsoft first-party apps are left out. (1) |
| `entitlement_google_workspace` | Google Workspace | Admin SDK Reports `token` activity: `authorize` and `revoke` events, latest per user and app; or, as an admin opt-in, the Directory API's per-user token listing (§4). (1) |
| `entitlement_salesforce` | Salesforce | `ConnectedApplication` (and whether any user may self-authorise it) and `SetupEntityAccess` (the profiles and permission sets an admin pre-authorised), through the JWT bearer flow as a read-only integration user. (2) |
| `entitlement_slack` | Slack | `admin.apps.approved.list` (Enterprise Grid org or workspace): approved apps and their user and bot scopes. (2) |

Reused unchanged: sources, schedules, leases, the encrypted credential (federated by default where the platform allows
it; a static key is a step-up relaxation), the guarded fetch with throttle, backoff and digest, secret scrubbing,
write-scope refusal (decision 7), pseudonyms (decision 20), run records and read outcomes. A kind's spec carries
`entitlements: true`; such a scanner returns no observations and one vendor-neutral `SaasEntitlementBatch`.

Reused code: ADR-0235's bounded JSON reader, paging, origin-pinned next links and outcome helpers (now exported from
`discovery-wider-scanners.ts`); the Entra token step, extracted as `entraGraphToken` and shared by `idp_entra` and
`entitlement_m365`; `@regulait/cloud-discovery`'s service-account key parser and guarded Gaxios transport, extended with
`workspaceDelegatedClient` (domain-wide delegation with exactly the scopes asked for).

### 2. The graph, in third normal form

- `saas_entitlement_apps`: one app per source and vendor id (`external_id`, exact case), its kind, the vendor's display
  name and publisher, and its link to a RegulAIt agent (`agent_id` FK and `agent_link_state`, §6). The platform is not
  stored: it is the source's kind.
- `saas_entitlement_scopes`: the scope dictionary, one row per (platform, resource, name). `resource` is the Microsoft
  resource application id, empty where names are global.
- `saas_entitlement_grants`: app x scope x grant type (`delegated` | `application`), with the consent breadth
  (`tenant` | `user`).
- `saas_entitlement_grant_principals`: grant x `discovery_pseudonyms` row for user consents. A person is only ever a
  pseudonym; no name or email is stored.

A scope's access class (`read` | `write` | `admin` | `unknown`) is computed from its name at read time by the frozen V1
classifier in `@regulait/shared` (`SAAS_SCOPE_RULES_V1`), never stored. `unknown` is treated like `write` (secure by
default). A better rule is a new version beside V1. Row-level security is enabled and forced on all four tables
(admins, and the `system_task` and `migration` reasons, as ADR-0332).

### 3. Storing a read: in the run's transaction, and never mistaking a failed read for a revocation

The worker checks the batch (`checkSaasEntitlementBatch`: vocabulary, bounds, printable ids, pseudonyms only, no named
tenant consent; a batch from a kind that is not an entitlement reader is refused) and stores it through the existing
`inCommit` hook of the run's fenced completion transaction, with a `saas-entitlements-recorded` audit row. A worker
that lost its lease writes nothing.

Every touched row is stamped with the transaction's `now()`, so "not seen by this run" is `last_seen_at < now()`:

- A **complete** batch (every listing read to its end, no bound reached) removes the source's grants and user consents
  it did not see. Apps stay, so an admin's agent link survives.
- A **partial** batch removes nothing it did not see. Explicit revocations (`revokedPrincipals`, from an audit read)
  apply either way, and a user-consent grant nobody holds any more is deleted.

Google's Reports API keeps token events for 180 days, so a Google batch is always partial: a grant authorised before
the window is not seen and is never removed for that reason.

### 4. Read-only, even where the vendor makes that awkward

- **M365:** the token's `roles` must all be `.Read.All` or `.ReadBasic.All`; anything more refuses the credential
  before any Graph read (as `idp_entra`).
- **Google (default):** the reader uses only `admin.reports.audit.readonly`. The write scope of the delegation itself
  cannot be read, so the credential is `unverified`, never `read_only`.
- **Google Directory token listing (owner decision 2026-11-17: allowed as an admin opt-in).** The Directory API's
  per-user token listing sees grants older than the Reports window, but its only scope (`admin.directory.user.security`)
  can also revoke tokens. It is off by default behind two gates (security review of #884). First the org switch
  `googleDirectoryTokens` in the discovery settings: off by default, turned on only with a `settings_relax` step-up
  bound to exactly it (`DISCOVERY_STEP_UP_KEYS.googleDirectoryTokens`), audited before/after, turned off for free; it
  shows in the settings view, and the posture names every source configured for the listing. While it is off, a
  source with `directoryTokens: "on"` cannot be created, widened into, enabled or run (409
  `directory_tokens_not_allowed`), and a run queued before it was turned off fails in the worker before any credential
  is read. Then the source: its target `directoryTokens: "on"` takes effect only on an enabled source, so turning it on
  is the existing enable step-up (its approved facts include the target), or the widening step-up when the source is
  already enabled; both are audited. Turning it OFF on an enabled source, with nothing else changed, narrows the read
  and needs no step-up. With it on, the reader asks
  for exactly `admin.directory.user.readonly` and `admin.directory.user.security` (not the Reports scope), lists every
  user and each user's tokens, and its batch is complete when every listing was read. RegulAIt never revokes with the
  scope: every data call goes through `readOnlyFetch`, which refuses any method but GET and HEAD before it leaves the
  gateway, and a test proves no DELETE reaches a token endpoint. A revoke belongs to the governed removal flow (§5: a
  recommendation a person acts on), never to a reader. The credential stays `unverified`, and the run records that the
  opted-in scope could revoke.

### 5. Findings are recommendations, through the approvals queue (slice 3)

Slice 3 compares grants with observed use and emits four findings: `unused-grant`, `excessive-scope`, `oversharing`,
`publicly-exposed-agent`. Nothing calls a vendor to revoke. Slice 3a (built) observes use and computes the findings;
slice 3b raises a finding into the approvals queue (or an ADR-0090 campaign) for a recorded decision.

**Observed use, read-only only (slice 3a).** Each reader may return a usage block with a coverage that says how finely
it could see use, and the worker stores it in the run's transaction (`saas_entitlement_usage_reads`, one row per
source; `saas_entitlement_app_usage`, one row per app, times only move forward). A usage read that fails never makes
the grant read partial; it only makes use unobservable. Researched per vendor (official docs, 2026-11-21):

| Platform | Source | Credential cost | Coverage |
|---|---|---|---|
| Microsoft 365 | Graph beta `reports/servicePrincipalSignInActivities`: each app's last sign-in | `AuditLog.Read.All` (read) and Entra ID P1 or P2 | `app`: per app, no read/write split |
| Google Workspace | Reports `token` `activity` events: API method per user and app | the same read-only Reports scope | `verb`: method names classified by the frozen `classifyGoogleApiMethod` (get, list, search, query, batchGet, export read; anything else counts as a write). Recorded only on Enterprise and Education Standard or Plus and Cloud Identity Premium, so a tenant with no event at all is `none`, never "unused" |
| Google (Directory opt-in) | none: the token listing carries no activity | n/a | `none` |
| Salesforce | none yet: login history needs Monitor Login History, the free API event log files need View Event Log Files and keep one day | not held by the read-only integration user | `none` (follow-up) |
| Slack | none: access and integration logs need the legacy `admin` scope, which includes a write method; audit logs carry app lifecycle events only | refused (write-capable) | `none` |

Not used: Microsoft Graph activity logs (the only per-permission, per-verb Microsoft signal) live in a customer's Log
Analytics workspace, not the Graph API; a follow-up can read them where the customer exports them. Salesforce
`OauthToken.LastUsedDate` needs Customize Application (the open owner question 3).

**The rules (slice 3a), `SAAS_FINDING_RULES_V1`.** A frozen, versioned set in the ADR-0092 discipline (id, severity
class, a rationale rendered strictly from the evidence, a limits paragraph on every payload; no score). It is a sibling
of ADR-0092's set rather than its V2: those rules judge RegulAIt's own grants and revoke through a campaign; these judge
vendor grants RegulAIt cannot revoke. Computed at read time by `GET /v1/discovery/entitlements/findings` (admin-only,
`windowDays` 7 to 365, default 90, at most 1,000 findings per rule with an exact count). Computing it writes nothing.

- `unused-grant`: a grant first seen at least the window before the source's latest usage read, held by an app with no
  observed use in that window. Use is per app: an app that uses one scope keeps all its grants out of the rule.
- `excessive-scope`: a `write`, `admin` or `unknown` scope held by an app whose observed calls in the window were all
  reads. Needs coverage `verb` (Google only today).
- `oversharing`: a tenant-wide consent to a `write`, `admin` or `unknown` scope, with the publisher's verification in
  the evidence. Every Salesforce connected-app grant is `unknown` and so appears here while its scopes are not readable.
- `publicly-exposed-agent`: a published Copilot Studio agent with no authentication, or with the "any multi-tenant"
  access policy, read from lane E17's registry records (no second adapter). Other registries record no audience and
  are listed as not assessable.

The window is anchored at the source's latest usage read, not at the request time, and every finding carries that
read's time. A source whose read could not observe use, or covered less than the window, is listed under the rule's
`notAssessable` with the reason, never as unused (the ADR-0082 disclosure). A grant younger than the window is not
judged. The route is a census entry on #453 until a screen exists.

### 4a. Salesforce and Slack (slice 2)

- **Slack:** an org-level token whose scopes (the `x-oauth-scopes` header of `auth.test`) are all `:read` scopes;
  anything else refuses the credential before the app listing is read, and a token of another org or workspace is
  refused. A user scope is a `delegated` grant, a bot scope an `application` grant; both are admin-approved (`tenant`).
  `is_app_directory_approved` is kept as the publisher-verified flag.
- **Salesforce:** read-only is only partly reachable. OAuth scopes of a connected app exist only in the Metadata API,
  and the org-wide `OauthToken` listing (per-user grants, `LastUsedDate`, and a `DeleteToken` that can revoke) needs
  Customize Application; both can change the org. The reader therefore reads, as an integration user holding View
  Setup and Configuration, only the connected apps, whether "all users may self-authorise" each one (grant
  `connected_app:self_authorize`, `tenant`) and which profiles and permission sets an admin pre-authorised (grant
  `connected_app:preauthorized`, resource `profile:<name>` or `permission_set:<name>`). The V1 classifier does not
  know these names, so they read as `unknown`, treated as `write`, which is right while the scopes behind them are not
  visible. A run-as user holding Modify All Data, Customize Application, Manage Users, Author Apex or Modify Metadata
  (its profile's permission set included) is refused before any app is read; object-level edit rights cannot all be
  judged, so the credential stays `unverified`. The JWT assertion is signed with `jose` (already pinned); the token
  query never selects a token field.

### 6. Linking a vendor app to a RegulAIt agent (owner decision 2026-11-17)

- **Auto-link on an exact identifier match.** An admin declares an agent's app id on one platform
  (`agent_vendor_identifiers`: agent, platform, external id; one identifier names one agent). An app whose vendor id
  equals it exactly (case-sensitive, same platform) is linked to that agent automatically: after each read, inside the
  run's transaction, and at once when the identifier is declared. Each auto-link writes its own
  `saas-entitlement-agent-auto-linked` audit row. An M365 app id is a GUID that Graph prints lowercase and the reader
  stores lowercase, so a GUID identifier is stored lowercase too (the same GUID in either case is one identifier);
  every other platform's id is exact.
- **An identifier applies across sources (security review of #884).** It names a platform, not a source, so declaring
  it links matching apps in EVERY entitlement source of that platform. That is deliberate (one agent, one app id,
  however many tenants are read) and explicit: the declaration's own `agent-vendor-identifier-declared` audit row and
  response name every app and source it linked. An agent with a declared identifier cannot be deleted (`ON DELETE
  RESTRICT`), so an identifier never disappears without its own `agent-vendor-identifier-removed` row. A retired agent
  (terminal, ADR-0089) is never linked: declaring an identifier for it or linking it is refused (409 `agent_retired`),
  and a read does not auto-link through an identifier whose agent was retired later.
- **Partial or fuzzy matches stay admin-only.** A case variant, prefix or similar name is never linked automatically;
  an admin links it by hand (`saas-entitlement-agent-linked`).
- **An admin can unlink** any link (`saas-entitlement-agent-unlinked`); an unlinked app is not auto-linked again until an
  admin links it.
- **Declared machine (ADR-0348).** `saas_entitlement_apps.agent_link_state` is `none | auto | admin | unlinked`, declared
  as `SAAS_APP_AGENT_LINK_MACHINE` (events `auto_link` from `none`, `link` from any state, `unlink` from `auto` or
  `admin`). Every write is guarded on the states the event may leave from; a CHECK ties `auto` and `admin` to a named
  agent; the agent FK is RESTRICT (an agent is retired through its lifecycle, not deleted under a link). Removing an
  identifier stops future auto-links through it; links already made stay until an admin unlinks them.
- **Routes** (admin-only, no vendor call; census entries on #453 until a screen exists): `GET
  /v1/discovery/entitlements/apps` (each app with its state and the machine's `describe()` view), `PUT` and `DELETE
  /v1/discovery/entitlements/apps/:appId/agent-link`, `GET` and `POST /v1/discovery/agent-identifiers`, `DELETE
  /v1/discovery/agent-identifiers/:identifierId`.

## Open source first (ADR-0176)

Searched: `@microsoft/microsoft-graph-client` (MIT), `googleapis` (Apache-2.0), `jsforce` (MIT), `@slack/web-api` (MIT),
and SaaS posture tools. No library maps entitlements across vendors into one model; that model is RegulAIt's own
(governance semantics). The Graph and Google API clients bring their own HTTP stacks and would need the same
guarded-transport adaptation `@regulait/cloud-discovery` already does for the cloud SDKs, for a few GET calls that the
bounded reader already covers; they are not added. `google-auth-library` (already pinned) signs the delegation JWT.
Slice 2 re-check: `jsforce` (MIT) and `@slack/web-api` (MIT) each wrap a few GET calls the bounded reader already makes,
and each brings its own HTTP client around the guarded fetch, so neither is added; `jose` (already pinned) signs the
Salesforce JWT bearer assertion.

## Consequences

- An admin can answer "which scopes does this agent hold in M365 or Google Workspace, granted how, by how many users"
  from one graph, with each read audited and every person pseudonymised.
- Collision note: `discovery_sources_kind_check` and `discovery_runs_kind_check` are rewritten with the full kind list.
  A lane that adds discovery kinds and merges after this one must include these four kinds in its own list.
- Follow-ups: slice 3b (raise a finding into the approvals queue for a recorded decision); Salesforce usage from
  API event log files; Microsoft Graph activity logs where a customer exports them. The agent-link and app-listing routes came with
  the owner's 2026-11-17 decisions (§6), with route census and KNOWN_UI_GAPS entries pointing at #453. Keyless Google delegation (IAM Credentials `signJwt` under
  workload identity federation) would remove the static key.

### Owner decisions (2026-11-17)

1. Google Directory token listing: **allowed as an admin opt-in**, off by default, turned on with a step-up and audited;
   the scope can revoke, but RegulAIt never calls revoke outside the governed removal flow (§4, with a test).
2. Linking a vendor app to an agent: **auto-link on an exact identifier match**, each auto-link audited and unlinkable by
   an admin; partial or fuzzy matches stay admin-only (§6).
3. Salesforce: should an admin be allowed to grant the integration user Customize Application (org-wide OAuth tokens,
   per-user grants and `LastUsedDate` usage) or metadata read (OAuth scopes), knowing both can also change the org?
   Default: no; connected apps, self-authorisation and pre-authorisations only.
