# ADR-0337: SaaS entitlement graph and usage-based least privilege for agents in Microsoft 365, Google Workspace, Salesforce and Slack

- **Status**: Accepted (owner direction 2026-11-16, lane E18 brief: close the Obsidian gap analysis item "SaaS entitlement graph"; slice 1 built). Amended by the owner's decisions of 2026-11-17 on both slice 1 questions (§4 Google Directory opt-in, §6 agent links), built in slice 1
- **Date**: 2026-11-16
- **Index**: **SaaS entitlement graph: read-only `entitlement_*` discovery sources (M365 Graph, Google Workspace, Salesforce, Slack) store each agent's granted OAuth scopes and permissions in four 3NF tables, inside the run's fenced transaction with its audit row; a frozen, versioned scope classifier; usage comparison, unused-grant, excessive-scope, oversharing and public-exposure findings follow as recommendations through the approvals queue, never auto-revoked.**
- **Built in**: lane E18, branch `builder/e18-saas-entitlements` (slice 1), `builder/e18-saas-entitlements-s2` (slice 2),
  `builder/e18-saas-entitlements-s3` (slice 3: usage, findings and their review)
- **Migration**: `pending/saas_entitlement_graph.sql`, and for slice 3 `pending/saas_entitlement_usage.sql` and
  `pending/saas_finding_reviews.sql`, numbered at merge (ADR-0252)
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
`publicly-exposed-agent`. Nothing calls a vendor to revoke. Slice 3a observes use and computes the findings; slice 3b
raises a finding into the approvals queue for a recorded decision. Both are built.

**Observed use, read-only only (slice 3a).** Each reader may return a usage block with a coverage that says how finely
it could see use, and the worker stores it in the run's transaction (`saas_entitlement_usage_reads`, one row per
source; `saas_entitlement_app_usage`, one row per app, times only move forward). A usage read that fails never makes
the grant read partial; it only makes use unobservable. Researched per vendor (official docs, 2026-11-21):

| Platform | Source | Credential cost | Coverage |
|---|---|---|---|
| Microsoft 365 | Graph beta `reports/servicePrincipalSignInActivities`: each app's last sign-in. A guided setup, off by default (§5a) | `AuditLog.Read.All` (read) and Entra ID P1 or P2 | `app` once the logs flow: per app, no read/write split |
| Google Workspace | Reports `token` `activity` events: API method per user and app | the same read-only Reports scope | `verb`: method names classified by the frozen `classifyGoogleApiMethod` (get, list, search, query, batchGet, export read; anything else counts as a write). Recorded only on Enterprise and Education Standard or Plus and Cloud Identity Premium, so a tenant with no event at all is `none`, never "unused" |
| Google (Directory opt-in) | none: the token listing carries no activity | n/a | `none` |
| Salesforce | `OauthToken.LastUsedDate`, only with the audited org-wide token opt-in (§4a); otherwise none (login history needs Monitor Login History, the API event log files need View Event Log Files and keep one day) | Customize Application, by opt-in only | `app` with the opt-in, else `none` |
| Slack | none: access and integration logs need the legacy `admin` scope, which includes a write method; audit logs carry app lifecycle events only | refused (write-capable) | `none` |

Not used: Microsoft Graph activity logs (the only per-permission, per-verb Microsoft signal) live in a customer's Log
Analytics workspace, not the Graph API; a follow-up can read them where the customer exports them.

**§5a. Guided, off-by-default reads (owner decisions 2026-11-22).**

- **Microsoft 365 activity logs.** The sign-in activity read runs only when the source's `activityLogs` is `on`. Each
  read records what it observed of the setup, `SAAS_ACTIVITY_LOG_STATES`, in `saas_entitlement_usage_reads.activity_log_state`:
  - `off`: the default; nothing is asked of Graph.
  - `not_enabled`: Graph refused the read (no consent, or no P1 or P2).
  - `unreadable`: the read failed or was cut short.
  - `no_activity_yet`: the read worked but the logs hold no activity at all.
  - `flowing`: the logs hold activity.

  Only `flowing` observes use (coverage `app`); the batch check refuses a state that contradicts its coverage. A tenant
  with no activity at all is not judged: that would flag every app unused. The state is an observation that each read
  replaces, not a lifecycle, so it has no declared machine. `GET /v1/discovery/entitlements/sources/:sourceId/read-setup`
  serves the setup as data the UI shows:
  - the exact admin steps (`M365_ACTIVITY_LOG_SETUP`);
  - the permission and licence;
  - the tenant-wide admin consent link, built only from the tenant and the app's client id, both GUIDs;
  - the observed state, which reads `not_checked` until a read since the source asked for logs.

  The checklist screen is the design lane's (#453; KNOWN_UI_GAPS).
- **Salesforce.** No broad access by default. The default read states plainly what it cannot see
  (`SALESFORCE_DEFAULT_READ`), in the run's outcomes and in the read-setup view: OAuth scopes are never read (Metadata
  API, write-capable), and per-user tokens and last use need the opt-in. The opt-in (§4a) is two-keyed:
  - the org switch `salesforceOrgTokens`: off by default, turned on with a `settings_relax` step-up bound to it, and
    audited with `SALESFORCE_ORG_TOKENS_TRADE_OFF`;
  - the source's `orgTokens: on`: refused at create, widen, enable, run and in the worker while the switch is off.

  With both, the integration user may hold Customize Application, and only that. Every other write or escalation
  permission, and any object-level write, still refuses the credential, which is recorded `unverified`, never
  `read_only`. The reader then selects only `AppName, UserId, LastUsedDate FROM OauthToken`:
  - a token is matched to a connected app only by a unique name, and the rest are counted, never guessed;
  - each holder becomes a pseudonymised principal of a `connected_app:user_token` grant;
  - each app's latest use becomes coverage `app`.

  Without Customize Application on the user, tokens are not read: only the user's own would be visible.

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

**Raising a finding for a decision (slice 3b).** `POST /v1/discovery/entitlements/findings/reviews` (admin-only)
raises a finding the report flags NOW (recomputed server side: a stale or invented key is refused, 404
`finding_not_current`) into the one approvals queue (kind `saas_finding_review`), naming another active admin as
approver (never the requester, nor anyone delegation-linked). `saas_finding_reviews` keeps the rationale and evidence as
raised, a deliberate point-in-time copy, and the approval's arguments digest binds them: the approver decides exactly
what was raised, and a review whose binding no longer matches is refused (409 `approval_unbound`). At most one pending
review per finding (409 `review_already_pending`).

- The lifecycle is the declared ADR-0348 machine `SAAS_FINDING_REVIEW_MACHINE` (`pending -> remediate | accepted |
  withdrawn`, all three final; a finding can be raised again as a new review). Every write is guarded on the states its
  event may leave from, and audited (`saas-finding-review-raised | -remediate | -accepted | -withdrawn`).
- Approved = `remediate`: the grant is to be removed or narrowed in the vendor's console. Denied = `accepted`: the grant
  is kept, with the decider's reason. **Nothing executes on either**; a test pins that the graph is unchanged.
- The requester never decides their own review, by any route; the decider must be in the approval's pool (no admin
  override). No step-up: a decision changes nothing outside RegulAIt, it records a judgement (a second administrator
  is the control).
- An accepted risk is never hidden: the findings report marks each finding with its latest review. A grant the vendor
  later removes leaves its review in place, `subjectGone`.
- Not used: an ADR-0090 campaign. Its items are RegulAIt grant rows and its denial revokes the row in the decision's
  transaction; neither holds for a vendor-side grant.
- `GET .../findings/reviews` (filtered, keyset-paged) and `POST .../findings/reviews/:reviewId/withdraw` (pending only;
  the queue item is superseded). Census entries on #453 until a screen exists.

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
  visible. The integration user is checked with the same code as the Agentforce adapter (`salesforce-org.ts`, #890
  R4 [1]): any write or escalation system permission on its session (`WRITE_SYSTEM_PERMISSIONS`: Modify All Data,
  Modify Metadata, Customize Application, Author Apex, Manage Users, Assign Permission Sets, Manage Profiles and
  Permission Sets, Manage Internal Users, Manage Roles, Manage Sharing, Reset Passwords), else Create, Edit, Delete or
  Modify All on any object across its permission sets, refuses the credential before any app is read. Both clear
  records `read_only`; a check that cannot be read reads nothing else (`unverified`). The token comes from the shared
  JWT bearer helper (`salesforceJwtToken`, #890 R4 [2]): an RSA key of at least 2048 bits, a 2-minute assertion with a
  fresh `jti`, posted only to the source's validated My Domain (target `environment` + `myDomain`); the vendor's
  `instance_url` is ignored, and the org named by the token must be the target's `orgId`. The token query never
  selects a token field.

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
- Follow-ups: Salesforce usage from API event log files; Microsoft Graph activity logs where a customer exports them. The agent-link and app-listing routes came with
  the owner's 2026-11-17 decisions (§6), with route census and KNOWN_UI_GAPS entries pointing at #453. Keyless Google delegation (IAM Credentials `signJwt` under
  workload identity federation) would remove the static key.

### Owner decisions (2026-11-17)

1. Google Directory token listing: **allowed as an admin opt-in**, off by default, turned on with a step-up and audited;
   the scope can revoke, but RegulAIt never calls revoke outside the governed removal flow (§4, with a test).
2. Linking a vendor app to an agent: **auto-link on an exact identifier match**, each auto-link audited and unlinkable by
   an admin; partial or fuzzy matches stay admin-only (§6).
3. Salesforce: should an admin be allowed to grant the integration user Customize Application (org-wide OAuth tokens,
   per-user grants and `LastUsedDate` usage) or metadata read (OAuth scopes), knowing both can also change the org?
   Default: no; connected apps, self-authorisation and pre-authorisations only. **Answered 2026-11-22, below.**

### Owner decisions (2026-11-22)

1. Salesforce: **no broad access by default.** The integration user gets neither Customize Application nor metadata
   read. The map shows what the narrower permissions reveal and states plainly what it cannot see. An admin may opt in
   to Customize Application, for org-wide OAuth tokens only (never metadata). That choice is audited and its trade-off
   explained (§5a).
2. Microsoft 365 activity logs: **a guided setup, off by default.** The backend detects whether the Graph activity
   logs are flowing and reports "not enabled" honestly until they are. The exact admin steps and the consent link are
   data the UI shows. The in-app checklist screen belongs to the design lane (KNOWN_UI_GAPS, #453) (§5a).
