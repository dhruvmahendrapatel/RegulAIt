# ADR-0218: Wider shadow-AI discovery sources: SaaS app inventories, identity-provider app consents and standalone ML platforms

- **Status**: Accepted (builder lane P9; the owner's backlog decision of 2026-10-30 on #453)
- **Date**: 2026-10-30
- **Extends**: [ADR-0195](0195-shadow-ai-active-discovery.md) (active discovery; its framework, credentials, worker,
  pseudonyms and finding lifecycle are reused unchanged). Its follow-up "discovery of SaaS OAuth grants through IdP
  APIs" is delivered here for one identity provider.
- **Migration**: 0238 (`0238_discovery_wider_sources.sql`)
- **Backlog item**: [PENDING.md](../product/PENDING.md) P9

## Context

ADR-0195 scans code repos, the three clouds (their native ML services included) and user machines. Three places where
ungoverned AI is commonly adopted stay unscanned:

- **SaaS apps** that teams sign up to directly. Customers usually already keep a list of them in a SaaS-management,
  CASB or in-house inventory tool; RegulAIt today takes that list only as an uploaded `saas_export` file.
- **Identity-provider app consents**: a user or admin clicking "accept" on an AI app's OAuth/OIDC consent screen gives
  it standing access to mail, files or calendars. That consent is recorded in the identity provider, not in any repo,
  cloud or device RegulAIt scans.
- **Standalone ML platforms** outside AWS, GCP and Azure: a model registry and serving layer the customer runs or
  rents, which may also forward requests to external model providers.

Findings already have an admin disposition, feed the risk register and remediation plan, and can be registered as a
use case (issue #522 finding #30, migration 0211).

## Decision

### 1. Three new read-only source kinds, one per family

| Kind | Family | Reads | Evidence kind | Subject kind |
|---|---|---|---|---|
| `saas_inventory_api` | `saas` | a JSON list of SaaS apps from an HTTPS API the admin names | `saas_inventory` | `saas_app` |
| `idp_entra` | `identity` | Microsoft Graph `servicePrincipals` and `oauth2PermissionGrants` of one Entra ID tenant | `idp_app_grant` | `saas_app` |
| `ml_mlflow` | `ml_platform` | MLflow `registered-models/search` and, where served, `serving-endpoints` | `ml_platform_inventory` | `system` |

Each is a `Scanner` in ADR-0195 SD0's registry, so it inherits, unchanged: off until an admin enables the source
(`settings_relax` step-up bound to kind, target and scope; widening is the same step-up); leased runs; per-source
throttle and back-off; every outbound call through the guarded fetch and the egress allow list (the admin adds the
API host); raw bodies digested and discarded; observations only, matched against the enabled admin catalogue
(detection is data, ADR-0083 §3); matched sightings merged into `shadow_ai_findings` through the import path; run
audit; read outcomes per run.

- **Vendor neutrality (ADR-0195 decision 12).** `saas_inventory_api` ships no vendor preset: the admin names the URL,
  the dotted path to the list, and the name, domain, user-count and next-page fields. `ml_mlflow` targets the open
  MLflow REST API, which self-hosted servers and hosted platforms built on MLflow both serve. `idp_entra` is the
  identity service of Azure, which decision 12 already allows. Other identity providers (a Google Workspace tenant,
  other OIDC providers) are follow-ups; IGA-owned identity discovery stays refused (PENDING).
- **What is kept (decision 6).** SaaS: the app's host (or its name when it has none) and a user count. Entra: the
  client application's display name and application id, the host of its homepage or first reply URL, the number of
  consenting users, and the consented permission NAMES (never tokens or values). ML: `<platform host>/models/<name>`
  or `<platform host>/serving-endpoints/<name>`, and for a serving endpoint each external model provider's name.
- **People (decision 20).** The user behind a single-user consent is kept only as an `idp_user` pseudonym; a tenant-wide
  (admin) consent carries no person. Graph object ids never leave the run.
- **Write scope (decision 7).** `idp_entra` reads the `roles` claim of the access token it was just issued: every
  role must be a `.Read.All` or `.ReadBasic.All` permission, otherwise the credential is reported as `write`, nothing
  is read, and SD0 refuses it from then on. The generic SaaS and MLflow APIs cannot report a token's scope; their
  posture row stays "write scope unverified" and the run says to use a read-only token.
- **Bounded.** At most 50 pages per listing, 5,000 items per run, and 8 MB per JSON body. A next-page link is followed
  only on the first URL's own origin (an inventory API cannot steer the scanner, or its token, to another host). Field
  paths are own-property lookups, never evaluated.

### 2. Each family behind its own default-off org switch

`discovery_settings` gains `saas_sources_enabled`, `identity_sources_enabled` and `ml_platform_sources_enabled`, all
false (ADR-0180 first-load posture; nothing is backfilled). Turning one on is a `settings_relax` step-up bound to
exactly the families being turned on (`discoveryWiderSourceFamilies`), audited with before and after in the same
transaction. Turning one off is free and stops the family at once: a source of a switched-off family cannot be
created, enabled or run (409 `family_disabled`), the scheduler queues none, a run already queued fails
`family_disabled` before its credential is decrypted, and the posture neither counts it as enabled nor names it as
scanned. The ADR-0195 families (repo, cloud, endpoint) have no switch: each of their sources is already off until
enabled.

### 3. Credentials

The existing discovery credential table and routes are used (ADR-0195 decision 7: a data-key envelope, scoped to one
source, never returned, revoked or replaced by admins). `saas_inventory_api` and `ml_mlflow` accept no external OIDC
token, so only a static token is possible; storing one is the existing static-credential step-up. Like an MCP
upstream credential (ADR-0204) it is sent as `Authorization: Bearer`, or as is in a header the admin names
(`authHeader`, a header NAME checked against a fixed shape; the value is only ever the secret). `idp_entra` takes the
same `tenantId` and `clientId` public config as `cloud_azure`, federated by default through RegulAIt's federation
issuer (audience `api://AzureADTokenExchange`), or a client secret as the static relaxation; a credential whose tenant
differs from the source's is refused.

### 4. Catalogue

Two identifier signature kinds are added: `oauth_app` (an identity provider's client application id) and
`ml_platform_asset` (an ML platform asset key). The shipped seed adds `ml_platform_asset` rows for
`mlflow:registered_model`, `mlflow:serving_endpoint` and `mlflow:external_model:<provider>` for the providers the
MLflow external-model configuration documents (openai, anthropic, cohere, mistral, gemini, amazon-bedrock,
togetherai). No `oauth_app` rows are seeded: an application id is added by an admin once verified. A consented app
still matches the existing hostname and web-app rows through its host, and a SaaS inventory entry matches them through
its domain.

### 5. Asset inventory reconciliation: no separate step (assessment asked for by P9)

RegulAIt has no stored asset inventory apart from the registers. The inventory views (ADR-0082) and the AI-BOM are
read-time aggregations over the use-case register, the agent registry and the run ledgers, so the use case a finding
is registered as (migration 0211) is the inventory entry. A second "reconcile into the asset inventory" action would
create a parallel record with nothing to read it. The new findings therefore use the existing lifecycle unchanged:
disposition, risk-register feed, remediation plan, and "register as use case". One gap is real and is recorded as a
follow-up: a finding can be registered only as a NEW use case; linking it to an EXISTING use case (the same SaaS app
or model already registered) needs its own small step, so a second sighting does not prompt a duplicate register entry.

### 6. Open source first (ADR-0176)

No new dependency. Searched: an MLflow JavaScript client (none official; the community packages are unmaintained and
add nothing over three GET calls); the Microsoft Graph JavaScript SDK (`@microsoft/microsoft-graph-client`, MIT, but
it brings its own HTTP stack, which decision 8 would have to re-point at the guarded fetch, for two paged GETs); a
JSON-pointer or JSONPath library for the SaaS field mapping (permissive ones exist, but the mapping is a dotted
own-property walk, and a path language would let target data steer evaluation). The Entra token request reuses the
existing `@azure/identity` credential built over the guarded fetch in `@regulait/cloud-discovery`.

## Consequences

- RegulAIt may now hold a read credential to a customer's identity provider. Graph `Application.Read.All` and
  `DelegatedPermissionGrant.Read.All` expose every app registration and consent in the tenant; that is the scope the
  scan needs, it is checked on every run, and the source is off until two admin step-ups (the family, then the
  source).
- The generic SaaS and MLflow sources rely on the admin issuing a read-only token; RegulAIt says so on every run.
- Customer copy names no internal ids; the Discovery sources page shows the three switches in its Settings card and
  says, where a kind is chosen, when its family is off.

## Follow-ups

1. Link a finding to an existing use case (§5).
2. More identity providers: Google Workspace third-party app tokens (Admin SDK, domain-wide delegation) and a generic
   OIDC/SCIM adapter; application-permission (app-role) consents in Entra, which need one Graph call per app.
3. National and sovereign Entra clouds (a configurable Graph and authority host).
4. More standalone ML platforms on open APIs (a KServe or other Kubernetes inference-service listing; a model hub
   organisation listing).
5. Seed `oauth_app` rows once each application id is verified against the vendor's own documentation.

## As built (2026-10-30)

- Scanners: `apps/gateway/src/discovery-wider-scanners.ts` (registered in `discovery-scanners.ts`); seed rows joined to
  `SHIPPED_SIGNATURE_SEED` in `shadow-ai.ts`. Vocabulary, switches and public-config allowlist:
  `packages/shared/src/discovery/index.ts`. Routes and worker gates: `discovery-routes.ts`, `discovery-worker.ts`,
  `discovery-posture.ts`. UI: the Settings card and the kind picker on the Discovery sources page; two kinds in the
  catalogue editor. Operator notes: `docs/deployment/WIDER_DISCOVERY.md`.
- Tests: `discovery-wider-scanners.test.ts` (fake services behind `ctx.fetch`: hooks, paging, same-origin next links,
  scope filters, write-scope refusal before any Graph read, pseudonymised consenting user, catalogue matching through
  the seed) and `zz-adr0218-wider-discovery.test.ts` (real database: default off, step-up with negative controls,
  findings through the import path, switching off stops create, run, schedule, a queued run and the posture).
