# ADR-0337: SaaS entitlement graph and usage-based least privilege for agents in Microsoft 365, Google Workspace, Salesforce and Slack

- **Status**: Accepted (owner direction 2026-11-16, lane E18 brief: close the Obsidian gap analysis item "SaaS entitlement graph"; slice 1 built). Amended by the owner's decisions of 2026-11-17 on both slice 1 questions (§4 Google Directory opt-in, §6 agent links), built in slice 1
- **Date**: 2026-11-16
- **Index**: **SaaS entitlement graph: read-only `entitlement_*` discovery sources (M365 Graph, Google Workspace, Salesforce, Slack) store each agent's granted OAuth scopes and permissions in four 3NF tables, inside the run's fenced transaction with its audit row; a frozen, versioned scope classifier; usage comparison, unused-grant, excessive-scope, oversharing and public-exposure findings follow as recommendations through the approvals queue, never auto-revoked.**
- **Built in**: lane E18, branch `builder/e18-saas-entitlements` (slice 1)
- **Migration**: `pending/saas_entitlement_graph.sql`, numbered at merge (ADR-0252)
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
| `entitlement_salesforce` | Salesforce | connected app OAuth usage and permissions (2) |
| `entitlement_slack` | Slack | installed apps and their scopes (2) |

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
  can also revoke tokens. It is off by default: the source's target `directoryTokens: "on"` turns it on, and it takes
  effect only on an enabled source, so turning it on is the existing enable step-up (its approved facts include the
  target), or the widening step-up when the source is already enabled; both are audited. With it on, the reader asks
  for exactly `admin.directory.user.readonly` and `admin.directory.user.security` (not the Reports scope), lists every
  user and each user's tokens, and its batch is complete when every listing was read. RegulAIt never revokes with the
  scope: every data call goes through `readOnlyFetch`, which refuses any method but GET and HEAD before it leaves the
  gateway, and a test proves no DELETE reaches a token endpoint. A revoke belongs to the governed removal flow (§5: a
  recommendation a person acts on), never to a reader. The credential stays `unverified`, and the run records that the
  opted-in scope could revoke.

### 5. Findings are recommendations, through the approvals queue (slice 3)

Slice 3 compares grants with observed use (M365 service-principal sign-in activity, Google token `activity` events,
Salesforce and Slack access logs), and emits:

- `unused-grant` (vendor side): a scope with no observed use in the window;
- `excessive-scope`: a `write`, `admin` or `unknown` scope where only reads were observed;
- `oversharing`: a tenant-wide consent of a `write` or `admin` scope, notably to an unverified publisher;
- `publicly-exposed-agent`: an agent the platform exposes beyond the tenant.

They are a new version of ADR-0092's frozen rule set (a stated rule, its evidence, no score), and each becomes an item
in the existing approvals queue for a human decision, or feeds an ADR-0090 certification campaign. Nothing calls a
vendor to revoke. Where lane E17's vendor agent adapters (Copilot Studio, Agentforce) expose publication state, the
public-exposure rule reads it through their interface rather than a second adapter.

### 6. Linking a vendor app to a RegulAIt agent (owner decision 2026-11-17)

- **Auto-link on an exact identifier match.** An admin declares an agent's app id on one platform
  (`agent_vendor_identifiers`: agent, platform, external id; one identifier names one agent). An app whose vendor id
  equals it exactly (case-sensitive, same platform) is linked to that agent automatically: after each read, inside the
  run's transaction, and at once when the identifier is declared. Each auto-link writes its own
  `saas-entitlement-agent-auto-linked` audit row.
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
`jsforce` and `@slack/web-api` are re-checked in slice 2.

## Consequences

- An admin can answer "which scopes does this agent hold in M365 or Google Workspace, granted how, by how many users"
  from one graph, with each read audited and every person pseudonymised.
- Collision note: `discovery_sources_kind_check` and `discovery_runs_kind_check` are rewritten with the full kind list.
  A lane that adds discovery kinds and merges after this one must include these four kinds in its own list.
- Follow-ups: slice 2 (Salesforce, Slack), slice 3 (usage and findings). The agent-link and app-listing routes came with
  the owner's 2026-11-17 decisions (§6), with route census and KNOWN_UI_GAPS entries pointing at #453. Keyless Google delegation (IAM Credentials `signJwt` under
  workload identity federation) would remove the static key.

### Owner decisions (2026-11-17)

1. Google Directory token listing: **allowed as an admin opt-in**, off by default, turned on with a step-up and audited;
   the scope can revoke, but RegulAIt never calls revoke outside the governed removal flow (§4, with a test).
2. Linking a vendor app to an agent: **auto-link on an exact identifier match**, each auto-link audited and unlinkable by
   an admin; partial or fuzzy matches stay admin-only (§6).
