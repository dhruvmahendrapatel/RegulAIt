# ADR-0195: Shadow AI active discovery: code repos, AWS, GCP, Azure and user machines

- **Status**: Accepted
- **Date**: 2026-10-17
- **Amends**: ADR-0055 (shadow-AI discovery), ADR-0071 (format adapters), ADR-0083 (first-party discovery) and
  ADR-0122 (MCP discovery). Their "evidence only, no collector, nothing is scanned" stance and ADR-0083 §1's refusal
  of endpoint collection and of integrations with the existing git-provider and cloud set are superseded by this
  ADR. Everything they built stays: the catalogue, imports, raw adapters, paste-in classifier, MCP discovery,
  findings, dispositions and the remediation plan, and "detection is data" (ADR-0083 §3) stands.

## Context

RegulAIt finds shadow AI only in evidence a customer hands it: imported egress or code-scan rows, five raw log
formats, and pasted logs or dependency manifests checked against the frozen 81-signature catalogue
(`SHADOW_AI_CATALOG_V1`). Nothing in RegulAIt reaches out to look. ADR-0055 named a repo scanner over
`packages/git-provider` as follow-up work but never scheduled it, and ADR-0083 §1 refused endpoint collection as a
new trust boundary.

That leaves the four places where most ungoverned AI actually lives unscanned:

- **Code repos.** `packages/git-provider` has adapters for GitHub, GitLab, Bitbucket and Azure DevOps, but they
  cover only branches, PRs, checks and merge. They cannot list repos or read files.
- **Cloud accounts.** `infra-aws-client.ts`, `infra-gcp-client.ts` and `infra-azure-client.ts` serve infra
  operations only. There is no inventory of Bedrock, SageMaker, Vertex AI or Azure OpenAI. ADR-0083 limit 3 notes
  that log scanning cannot tell Bedrock calls from other AWS SDK traffic; the cloud's own audit logs can.
- **User machines.** AI desktop apps, IDE and browser extensions, local model runtimes and AI CLIs with keys in
  config files are invisible to RegulAIt.
- **Coding assistants.** There is no GitHub Copilot signature (PENDING S17).

The owner asked on 2026-10-17 for RegulAIt to scan code repos, AWS, GCP, Azure and local user machines. The owner
also confirmed that no other regulAIt suite module owns discovery or scanning, so it is built here. The suite's
`CAPABILITY_MAP.md` is not readable from the build environment; the owner's answer stands in for that check.

## Decision

### Owner decisions (2026-10-17)

1. **Active, read-only scanning.** RegulAIt may call customer systems to discover AI use. Every scanner is
   read-only: it never writes to, changes or deletes anything in a scanned system. Every discovery source is off
   until an admin enables it. Enabling a source is a `settings_relax` step-up bound to the source's kind, target and
   scope, and is audited. Widening a source's scope (more repos, accounts, projects, subscriptions or regions, or an
   organisation-level scope) is the same step-up; narrowing and disabling are free. A source may target one account,
   project or subscription, or an organisation-level scope (an AWS Organization, a GCP organization or folder, an
   Azure management group). Every scan run is audited with its source, scope, counts and
   outcome.
2. **Endpoints: both options are offered.** The customer chooses per org:
   - **(a) No agent.** RegulAIt ships a signed osquery query pack that the customer deploys through their own MDM or
     EDR, plus importers for the osquery results and for MDM or EDR inventory exports.
   - **(b) RegulAIt endpoint agent.** A RegulAIt-signed, read-only agent the customer distributes through their MDM.
   Either can be enabled alone, or both.
3. **Cloud credentials: federated and static are both allowed.** Federated, short-lived credentials are the default
   and need no relaxation: AWS role assumption with an external ID, GCP workload identity federation, and Azure
   workload identity federation or managed identity. RegulAIt presents an OIDC token from its own workload identity
   issuer (ADR-0188) to AWS `AssumeRoleWithWebIdentity`, to GCP workload identity federation and to an Azure
   federated credential. Federation tokens are signed with an RS256 or ES256 key held beside the issuer's Ed25519
   keys, because the clouds do not accept EdDSA. AWS and Azure fetch the issuer's discovery document and JWKS over
   public HTTPS; GCP can instead take an uploaded JWKS. An install whose issuer the cloud cannot reach uses GCP's
   uploaded JWKS, a customer-side identity, or a static credential (the relaxation below). SD2 verifies each cloud's
   accepted algorithms against current documentation. Where an AWS principal
   does exist, `AssumeRole` uses an external ID that RegulAIt generates per source; the admin never chooses it. Static credentials (an AWS access key, a GCP service-account
   key file, an Azure client secret) are allowed as an admin relaxation under ADR-0180: storing one is a
   `settings_relax` step-up, the secret is encrypted at rest with the existing data key, it is never returned by any
   route, enforcement posture shows every source that uses one, and the UI warns once the secret is older than 90
   days (the age is configurable, and lengthening it is a relaxation).
4. **Built in RegulAIt.** No other suite module owns this capability (owner, 2026-10-17).

### Shared rules for every scanner

5. **Detection is data (ADR-0083 §3 stands).** A scanner observation becomes a finding only when it matches an
   enabled `ai_endpoint_signatures` row. SD0 adds signature kinds `cloud_ai_service`, `desktop_app`, `ide_extension`,
   `browser_extension`, `local_runtime` and `assistant_config`, with matchers that never evaluate a regex taken from
   data. An observation that matches only compiled detection is an unmatched observation reported in
   `deploymentCatalogueGaps`, as ADR-0083 §3 does today.
5a. **Findings go into the existing model.** Matched observations merge into `shadow_ai_findings` through the same
   merge-by-usage path as imports, keyed by subject kind, subject and provider, so dispositions, the risk-register
   feed and the remediation plan work unchanged. SD0 adds subject kinds `device`, `cloud_resource` and
   `cloud_principal`, and records which source produced each sighting as a signal source per scan run:
   `repo_scan`, `cloud_inventory`, `cloud_audit_log`, `endpoint_osquery`, `endpoint_inventory` and `endpoint_agent`
   (the closed `shadow_ai_imports.kind` enum is extended to match, so imports and scans share one path).
5b. **Posture statements tell the truth.** The posture sentences the shadow-AI and MCP-discovery routes return today
   ("ships no collector", "nothing is scanned") are rewritten to list the active sources enabled for the org. With
   none enabled they keep saying nothing is scanned.
6. **Data minimisation.** No scanner stores file contents, prompt or response content, or a full secret. A detected
   key is kept only as the existing 8-character redacted prefix plus where it was found (repo, path, line, commit;
   or device and config file). Repo scanners keep only the matched signature, path and line. Raw scanner output is
   digested (SHA-256) and discarded, like pasted content today. A scanner never calls a provider to test a key it
   finds: liveness checks would be an outbound use of a customer secret.
7. **Credentials.** Scanner credentials live in a dedicated table, encrypted with the data key, scoped to one
   source, never returned, and rotated or revoked by admins (revoking is free; replacing a static credential is the same
   step-up as storing one; replacing a federated one is free). Git-provider credentials reuse the provider's read-only scopes; a credential that grants write scopes
   is refused where the provider lets us check; where it cannot be checked, the source's posture row says "write
   scope unverified".
8. **Egress.** Every outbound scanner call goes through `guardedFetch` and the egress allow list (ADR-0034, with
   the owner amendment of 2026-10-16: adding any allow entry is a `settings_relax` step-up, being built in #395, open). The cloud
   SDKs bring their own HTTP stacks, so each client is constructed with a transport that delegates to
   `guardedFetch`: a custom `requestHandler` for the AWS SDK v3, a custom `HttpClient` for `@azure/core-rest-pipeline`,
   and Google clients in REST fallback mode with a guarded fetch. gRPC transports are not used. The credential providers' token exchanges (AWS STS, Google STS and IAM Credentials,
   the Azure identity token endpoint) use the same guarded transport. A test proves that a
   willing network spy records no call when the host is not allow-listed. Cloud and git-provider API hosts are added
   by the admin when the source is enabled, not shipped pre-allowed.
9. **Scheduling and runs.** Sources run on an admin-set schedule (default daily; a shorter interval is not a
   relaxation) and on demand. Runs are leased rows with expiry, as the workflow engine does (REL-06), so a crashed
   worker's run is retried, never lost or doubled. Each source is rate-limited per provider and backs off on 429.
10. **Air-gapped mode.** Repo scanning works against self-hosted git. Cloud scanning works only through the
    customer's private endpoints for the cloud APIs; with none configured the cloud sources stay disabled with an
    honest "unreachable in air-gapped mode" state. Endpoint options work unchanged.
11. **Open source first (ADR-0176).** Cloud scanners use the official SDKs (AWS SDK for JavaScript v3, Apache-2.0;
    `@google-cloud/*`, Apache-2.0; `@azure/*`, MIT). The repo scanner evaluates syft (Apache-2.0) for dependency
    inventory, provided it runs air-gapped from a pinned artifact. Key detection reuses the gitleaks-derived
    `dlp.secret.*` patterns already in `packages/shared`, or the gitleaks binary with its own RE2 engine; no regex
    taken from data is evaluated in JavaScript (ADR-0055). The builder records what it found. The endpoint query pack uses osquery (Apache-2.0 / GPL-2.0 dual licence;
    RegulAIt ships only queries, not osquery itself).
12. **No vendor-named presets.** ADR-0071 §5's "no vendor-named preset" and ADR-0083 §1's "no vendor-named integration" are superseded only for the existing
    git-provider and cloud set (GitHub, GitLab, Bitbucket, Azure DevOps, AWS, GCP, Azure). Named CASB, SWG, MDM and
    EDR presets stay refused (PENDING). MDM and EDR exports come in through a generic mapped importer, as
    `generic_mapped` does today.

### Code repos

13. Extend `packages/git-provider` with read-only `listRepos`, `getTree` and `readFile` for GitHub, GitLab,
    Bitbucket and Azure DevOps (provider-agnostic, as pillar 2 requires).
14. The scanner reads the default branch head of each repo in scope. It checks dependency manifests (npm, PyPI,
    Go, Maven, Gradle, NuGet, RubyGems, Cargo), source imports, AI tool configuration files (for example MCP server
    configs, coding-assistant instruction files and `.env.example` names), and AI provider key patterns. Scanning
    history is an admin relaxation (step-up), off by default.
15. Coding-assistant signatures ship in a new `SHADOW_AI_CATALOG_V2` alongside v1 (v1 stays byte-identical as
    ADR-0083 §2 requires; v2 is pinned by entry count and hash), plus seed rows for the admin catalogue. Each endpoint
    is verified against current vendor documentation, as PENDING S17 requires; S17 closes when SD1 ships.

### Cloud accounts

16. One `CloudScanner` interface with three adapters, each listing only AI services:
    - **AWS:** in every enabled region, Bedrock (custom and imported models, provisioned throughput, agents,
      knowledge bases, guardrails, model-invocation logging settings) and SageMaker endpoints and models; and
      CloudTrail `InvokeModel`, `InvokeModelWithResponseStream`, `Converse` and `ConverseStream` events grouped by
      calling principal. `LookupEvents` covers 90 days of management events only; agent and knowledge-base calls
      (`InvokeAgent`, `Retrieve`, `RetrieveAndGenerate`) are data events, readable only when the customer has enabled
      data-event selectors and granted read on the trail's bucket. The scanner reports which of these it could read.
    - **GCP:** a Service Usage check for enabled `aiplatform.googleapis.com` and `generativelanguage.googleapis.com`
      (cheap and strong); Vertex AI endpoints, models and index endpoints through Cloud Asset Inventory; and Cloud
      Audit Logs. Vertex prediction calls appear only in Data Access audit logs, which are off by default and need
      `roles/logging.privateLogViewer`; the scanner reports "not enabled" honestly when they are absent.
    - **Azure:** Cognitive Services accounts of kind OpenAI or AIServices through Azure Resource Graph; their
      deployments through Resource Graph where present, otherwise the ARM list-deployments call; Azure Machine
      Learning and AI Foundry hub and project workspaces; and the activity log. Diagnostic logs are read only when the
      customer routes them to a Log Analytics workspace the reader can query.
17. The read-only role or permission set each adapter needs is published as a document and as IaC snippets the
    customer applies in their own account. RegulAIt never creates IAM in a customer account.

### User machines

18. **No-agent option.** The signed query pack covers installed AI desktop apps, IDE extensions, browser extensions,
    local model runtimes and their listening ports, AI CLIs, and the names (never values) of AI-related environment
    variables and config files. Results are imported as `endpoint_osquery`; MDM or EDR inventory exports as
    `endpoint_inventory`. The pack is signed (mechanism decided in the SD4 spike with the agent's release signing;
    `infra/release-keys/` is not reused without an owner decision).
19. **Agent option.** The agent collects the same facts as the query pack and nothing more. Explicit non-goals: no
    keystrokes, screenshots, clipboard, file contents, prompt or response content, or browsing history. Key values
    are redacted on the device before anything is sent. It enrols with its own workload identity using the ADR-0188
    S7 pattern (its own key, DPoP-bound tokens, rotation), sends only to the org's gateway, and verifies signed
    releases before any update. The customer distributes it through MDM; RegulAIt never installs it. By default it
    updates only through MDM; self-update is a relaxation. The SD4 spike decides the signing mechanism, how
    enrolment scales to thousands of devices (an MDM-delivered enrolment token) and device revocation.
20. **Privacy.** People are pseudonymous by default: device users and device names, git commit authors and cloud calling principals
    are shown as a keyed hash (HMAC key per tenant, as in ADR-0193). The display name is stored encrypted under the
    data key in a separate table; revealing it decrypts it under a step-up and is audited. Endpoint evidence has a
    strict default retention of 90 days; lengthening it is a relaxation. RegulAIt ships an employee-notice template. Employee-monitoring and privacy law
    (for example GDPR and works-council rules) varies by country: as with ADR-0193 Art. 50, RegulAIt makes no
    compliance claim and recommends the customer takes legal advice before enabling either endpoint option.

### Slices

- **SD0 Foundation** (migration 0202; 0201 is claimed by the ADR-0190 isolation-admin build in flight): discovery
  sources, scanner credentials, scan runs and schedules; the new signature kinds, subject kinds and signal sources;
  the pseudonym table; enable, widen and credential step-ups; posture rows and the rewritten posture sentences; an
  admin "Discovery sources" page; the scan worker with leased runs. Depends on #395 (egress step-up).
- **SD1 Repo scanner** over SD0 (all four git providers).
- **SD2 Cloud scanners** over SD0 (AWS, GCP, Azure in one interface).
- **SD3 Endpoint, no agent**: query pack, signing, osquery and generic MDM/EDR importers.
- **SD4 Endpoint agent**: a design spike first (language and packaging for a small signed static binary on
  macOS, Windows and Linux; enrolment; update signing), then the build.
- SD1 to SD4 may run in parallel once SD0's interfaces are on main; SD4's spike may start at once.

## Consequences

- RegulAIt now holds read credentials to customer repos and cloud accounts. That is a new class of secret; it is
  encrypted, scoped, never returned, and every use is audited. A compromise of RegulAIt could read, but not change,
  what those credentials can read. Federated credentials keep that window short; static keys widen it and are
  therefore a visible, step-up relaxation.
- The endpoint agent is a new trust boundary and a long-term commitment: signing keys, patching, OS support and a
  security response process. The no-agent option exists so customers who will not take on an agent are still
  covered.
- Endpoint scanning raises employee-monitoring questions customers' legal teams will ask. Pseudonymous defaults, a
  minimal fixed fact set and the notice template help; no compliance claim is made.
- Cloud discovery fills ADR-0083 limit 3: Bedrock calls become attributable through CloudTrail.
- Air-gapped installs get repo and endpoint discovery, and cloud discovery only through private endpoints.
- Follow-ups: discovery of SaaS OAuth grants through IdP APIs, and of browser extensions through browser-management
  consoles, remains out of scope here (browser extensions on managed devices are covered by SD3 and SD4); IGA-owned
  identity discovery stays refused (PENDING).

## Open-source evaluation (ADR-0176, 2026-10-17)

The owner asked for six existing projects to be checked for reuse. None is fit to ship as a dependency or binary;
two contribute detection data under their licences.

| Project | Licence | Finding |
|---|---|---|
| An endpoint network-sensor repository from a commercial vendor | No licence file (all rights reserved) | Endpoint network sensor (packet capture, SNI/DNS, process pairing, traffic-shape scoring). Cannot be reused; the traffic-shape idea informs SD4. |
| AmanSK5/shadow-ai-guard | Apache-2.0 (with NOTICE and a trademark policy) | Its `registry/registry.yaml` (31 tools: env-var names, bundle ids, executables, per-OS MCP config paths, inference domains) is imported into the catalogue with NOTICE and per-entry provenance, for SD3 and SD4. Its endpoint collector scripts and MDM importers are reference designs only. Not taken as a dependency: Python, and its registry loader and classifier make network calls, so it is not air-gap safe. Its name is not used (trademark policy). |
| giggsoinc/PatronAI | Apache-2.0 (repo level) | Its provider and detector data files cross-check and extend the catalogue for SD1 and SD2, pinned by commit (no release tags). |
| A hosted product's open snapshot from a commercial vendor | MIT | One snapshot commit, not maintained in the open; detector regexes used only to compare coverage for SD1. |
| datacline/open-threat-detector | MIT | One detector, inactive; not used. |
| HEUDavid/shadow-ai | No licence file | Not a detector: a hidden assistant built to evade monitoring. Not used; its traits (no visible window, LAN remote control) become SD3/SD4 detection signatures written by us. |

Every imported signature records its source project, commit and licence; the packages' `THIRD_PARTY.md` lists them.

## Implementation notes: SD2 cloud scanners (2026-10-17)

Built in `packages/cloud-discovery` (Phase A: the scanners without the SD0 registration).

- **Open source first (decision 11).** The official SDKs are used as published: AWS SDK for JavaScript v3
  `3.1152.0`, `@google-cloud/service-usage` `5.2.0`, `@google-cloud/asset` `7.2.0`, `@google-cloud/resource-manager`
  `7.2.0`, `google-auth-library` `11.3.1`, and `@azure/identity` `4.14.0` with the Resource Graph, Cognitive
  Services, Monitor and `@azure/monitor-query-logs` clients. The whole production tree is Apache-2.0, MIT,
  BSD-3-Clause, ISC or 0BSD. Two pieces are ours, recorded in the package's `THIRD_PARTY.md`: an Azure `HttpClient`
  over the guarded fetch (the pipeline package exports no fetch-based client for Node), and a small credential
  memo. The AWS transport is the SDK's own `FetchHttpHandler` with `customFetch`. Audit-log entries are read through
  the Logging REST API with the guarded auth client, because the Logging GAPIC client's REST fallback cannot decode
  the `AuditLog` payload (no AuditLog type is bundled).
- **Decision 8 found a real bypass.** `google-auth-library` 11.3.1 builds the external-account client's STS client
  without the transporter it was given, so the workload identity token exchange left on global fetch: the first
  fake-cloud test run received a live response from Google's STS endpoint. The package re-points it and fails
  closed if the library's internal shape changes; a negative control shows the egress test fails without the fix.
  To be reported upstream.
- **Retries against a refusal.** google-gax reports a fetch that failed before any response, an egress refusal
  included, as UNAVAILABLE and retries it for up to a minute. Calls pass `maxRetries: 2`. MSAL replaces any transport
  failure with `network_error`; both are reported as `unreachable`.
- **Federation signing algorithm (decision 3 check, 2026-10-17).** AWS IAM OIDC providers accept RS256, RS384,
  RS512, ES256, ES384 and ES512 (IAM user guide, "Create an OpenID Connect (OIDC) identity provider"). GCP workload
  identity federation accepts tokens "signed using the RS256 or ES256 algorithm" (IAM docs, "Configure Workload
  Identity Federation with other identity providers"; an uploaded JWKS holds at most 8 keys). Microsoft Entra
  supports only issuers whose tokens are signed with RS256; other algorithms "may work, but haven't been tested"
  (Entra Workload ID, "Important considerations and restrictions for federated identity credentials"). The one
  algorithm all three accept is **RS256**, so the federation key beside the issuer's Ed25519 keys is RS256.
- **Not supported:** instance-metadata credentials (AWS default chain, Azure managed identity, GCP metadata server).
  The guard refuses the metadata address unconditionally and a source must name its principal. Decision 3's
  "managed identity" is therefore not offered.
- **Phase B: registered with SD0.** `apps/gateway/src/discovery-cloud-scanners.ts` adds `cloud_aws`, `cloud_gcp` and
  `cloud_azure` to `DISCOVERY_SCANNERS`. It maps a source's target, scope and credential onto the adapters (fields
  listed in that file and in `docs/deployment/CLOUD_DISCOVERY.md`), wraps `ctx.fetch` so every request awaits
  `ctx.throttle()`, a 429 or 503 is retried only when `ctx.backoff()` agrees, and every body goes to `ctx.recordRaw()`,
  pseudonymises principals as `cloud_principal`, calls `ctx.heartbeat()` between regions, projects and subscriptions,
  and returns observations with `artifact: { kind: "cloud_ai_service", value: <service key> }` (matched by
  `identifier`). AWS scope `include` is regions and an organisation-level AWS scope means every enabled region of the
  one target account; GCP `include` is projects (organisation level needs `assetScope`); Azure `include` is
  subscriptions (organisation level needs `managementGroupId`). The AWS static secret is a JSON object holding the key
  id too, because SD0 refuses key-shaped names in public config.
- **What could not be read, at run level.** Every read's status goes to SD0's `readOutcomes` (`<capability>@<scope>`,
  problems first, at most 100). When no read succeeds at all the run also fails (`scanner_error`) with the summary.
- **Credential fields follow SD0's allowlist** (`DISCOVERY_PUBLIC_CONFIG`): AWS federated `roleArn`; GCP federated
  `projectNumber`, `workloadIdentityPool`, `workloadIdentityProvider` and `serviceAccountEmail`, from which the pool
  provider audience is built; Azure `tenantId` and `clientId`. `credentialTargetMatch` gains GCP: the impersonated
  service account's home project equal to the target `projectId` is a match; anything else is unverifiable, never a
  mismatch, because a central project may hold the service account and pool.
- **Pending (M-041):** nothing has run against a real cloud account; the published Terraform is unvalidated. A
  federated credential fails its run with an explicit reason until the ADR-0188 issuer has an RS256 federation key
  and a mint path for these audiences (key material and schema outside this slice); AWS `assume_role` needs
  RegulAIt's own AWS principal and fails the same way. Organisation-level AWS account enumeration is not built.
- **Scrubbing and account binding (SD0 final push).** Every short-lived credential an adapter obtains or sends is
  passed to `ctx.registerSecret` before use: the OIDC assertion, AWS STS session credentials (and a static key's
  parts), Google STS and IAM Credentials tokens, the Entra access token, and any bearer token on an API call. The AWS
  scanner calls `sts:GetCallerIdentity` (no IAM permission needed) in every mode and reads nothing unless the
  credential's account equals `target.accountId`.
- **Seed.** The catalogue seed route installs `CLOUD_AI_SERVICE_SEED` with the default signatures
  (`SHIPPED_SIGNATURE_SEED` in `shadow-ai.ts`; SD1 and SD3 add theirs the same way); admin-edited rows stay untouched.
- **Review of #404 (fixed).** Endpoints are pinned against ambient SDK configuration (AWS endpoint URLs, shared-config
  profiles, FIPS and dual-stack; `GOOGLE_CLOUD_UNIVERSE_DOMAIN`; `AZURE_AUTHORITY_HOST`), with an env-poisoning test.
  `@azure/identity` also reads `AZURE_REGIONAL_AUTHORITY_NAME` with no override; it only selects a regional Microsoft
  host, which still needs an allow entry. Trail-bucket objects are capped (8 MB read, 64 MB inflated) and response
  digests at 4 MB; token-exchange responses go through an undigested credential fetch; Azure audit evidence is
  attributed only to discovered AI resources; error details redact `key=`/`token=`-style values.

## As built: SD0 foundation (2026-10-17, migration 0202)

**Status: built on branch `sd0-discovery-foundation`; migration 0202 with its journal entry (idx 202) after 0201.** No
scanner ships: the production registry is empty, so no source can be created yet and the admin page shows every
kind as "not built yet" with the slice that builds it.

1. **Migration 0202** (hand-written; no function and no trigger, so the 0185 guard has nothing new to check):
   - `discovery_sources`: `kind` (the ten kinds), `target` (a JSON object), `scope` (`{orgLevel, include[]}`, CHECKed),
     `enabled` default false, `schedule_interval_seconds` (3600 to 30 days, default daily), `version` for
     compare-and-set, `next_run_at`/`last_run_at`, who enabled and disabled it. Unique by `lower(name)`.
   - `discovery_credentials`: `credential_mode` federated or static, `public_config` (non-secret identifiers),
     `secret_ciphertext` (a data-key envelope, listed in `CIPHERTEXT_COLUMNS`), `write_scope` (`unverified` or
     `read_only`), `created_at` for the age warning. One live credential per source (partial unique index); a
     revoked row has its ciphertext destroyed (CHECK).
   - `discovery_runs`: leased with expiry (`lease_owner`, `lease_expires_at`, `attempt` at most 3), one live run per
     source (partial unique index), counts, `catalogue_gaps` (at most 50), `raw_output_sha256`, `error_code` and
     `error_detail`. CHECKs tie status to lease, finish time and error code.
   - `discovery_settings` (one row): `credential_warning_age_days` 90 and `endpoint_retention_days` 90.
   - `discovery_pseudonym_keys` (one row, a data-key envelope of 32 random bytes, made on first use) and
     `discovery_pseudonyms` (`kind`, `pseudonym` = `psn:` + 24 hex of HMAC-SHA256(key, kind + name), the display name
     as a data-key envelope, first and last seen). The key is stored, not derived from the data key, so a data-key
     rotation (which re-encrypts it) does not change anyone's pseudonym.
   - Widened, never loosened: `ai_endpoint_signatures` kinds gain the six artifact kinds, matched only by the new
     `identifier` match type (CHECKed both ways); `shadow_ai_imports.kind` gains the six scanner evidence kinds and a
     `discovery_run_id`; `shadow_ai_findings.subject_kind` gains `device`, `cloud_resource`, `cloud_principal`.
2. **Detection stays data (decision 5).** `classifyObservation` gains an artifact step: whole-identifier,
   case-insensitive equality against an enabled signature of the same artifact kind (medium severity; `assistant_config`
   low). No regex from data. The worker classifies every observation against the enabled admin catalogue; an
   unmatched one is recorded in the run's `catalogue_gaps` (artifact, host or package; never a key fragment).
3. **One import path (decision 5a).** A run writes one `shadow_ai_imports` row per evidence kind it reported (mode
   apply, `discovery_run_id` set, `payload_sha256` = the raw-output digest) and calls the existing `upsertFindings`,
   in the same transaction as the run's completion, which is fenced on the lease. The upload routes still accept only
   the four import kinds.
4. **Posture sentences (decision 5b).** `activeDiscoveryPosture()` (shared) names each enabled source, or says "No
   active discovery source is enabled, so nothing is scanned". It is appended to the adapter, first-party discovery and
   MCP-discovery postures and is the coverage scorecard's statement. The three constants no longer claim "ships no
   collector" or "nothing is scanned" globally; they now describe their own classifier (ADR-0071 and ADR-0122 were
   amended in the ADR branch).
5. **Routes** (`discovery-routes.ts`, admin-only, every write audited):
   `GET /v1/discovery/scanners`, `GET|POST /v1/discovery/sources`, `PATCH|DELETE /v1/discovery/sources/:sourceId`,
   `POST …/enable`, `POST …/disable`, `PUT|DELETE …/credential`, `POST …/runs`, `GET /v1/discovery/runs`,
   `GET|PUT /v1/discovery/settings`, `POST /v1/discovery/pseudonyms/:pseudonym/reveal`.
   - Enable: `settings_relax` step-up with facts `{values: {discoverySourceEnabled: {sourceId, kind, target, scope}}}`,
     spent only after the row lock and the `version` compare-and-set. A PATCH that changes the target or widens the
     scope (`scopeWidens`: org-level, or a new name) of an ENABLED source needs the same step-up with the new values;
     narrowing, editing a disabled source, and disabling are free. Disabling needs no `version` and fails queued runs.
   - Credential: federated is free; static is a `settings_relax` step-up (`discoveryStaticCredential: {sourceId, kind,
     replacesCredentialId}`), CAS on `replacesCredentialId`. Public config keys that look like secrets are refused; for
     `cloud_aws` federated, RegulAIt generates `externalId` (`regulait-<uuid>`, kept across replacements) and refuses
     one sent by the admin. Revoking is free and destroys the secret. No view selects the ciphertext.
   - Settings: lengthening the warning age or the endpoint retention is a `settings_relax` step-up; shortening is free.
   - Reveal: its own step-up kind `pseudonym_reveal` (master decision on #403: revealing a name is not a settings
     relaxation), facts `{op: "pseudonym_reveal", pseudonym}`. Migration 0202 adds the kind to the `step_up_grants`,
     `webauthn_challenges` and `org_settings.step_up_actions` CHECKs, to the column default and to the existing org row
     (first load); `STEP_UP_ACTION_KINDS` has eight kinds and the dialog says "revealing a person's name". A
     `settings_relax` grant does not reveal. The audit names the pseudonym, never the name.
6. **The scanner interface** (`discovery-scanners.ts`), for SD1 to SD4:
   ```ts
   interface Scanner { kind: DiscoverySourceKind; requiresCredential: boolean; run(ctx: ScanContext): Promise<ScanResult> }
   interface ScanContext {
     source: { id; name; kind; target: Record<string,string>; scope: { orgLevel; include } };
     credential: { mode; publicConfig; secret: string | null } | null;   // decrypted for this run only
     fetch: typeof fetch;            // the ONLY network access: the egress-guarded fetch (allow list, DNS pinning, no redirects)
     throttle(): Promise<void>;      // the per-source rate-limit hook, before every request
     backoff(res): Promise<boolean>; // 429/503: waits the bounded Retry-After (at most 60 s, 5 times); false = give up
     recordRaw(chunk): void;         // digested (SHA-256), never kept
     pseudonymise(kind, displayName): Promise<string>;  // device_user | commit_author | cloud_principal -> psn:…
     heartbeat(): Promise<boolean>;  // renews the lease now; false = lost, stop (the worker also renews it on its own)
     signal: AbortSignal;            // aborted at the run's maximum duration or when the lease is lost
   }
   interface ScanResult { observations: ScanObservation[]; credentialWriteScope?: "read_only" | "write" | "unverified" }
   // ScanObservation: { evidenceKind, subjectKind, subject, observedAt?, count?, host?, packageName?, keyFragment?, keyLength?, artifact?: { kind, value } }
   ```
   A scanner returns observations, never findings, severities or verdicts. The worker refuses the run when an
   observation names an evidence or subject kind its source kind does not report (`DISCOVERY_KIND_SPECS`), exceeds the
   bounds, or exceeds `EVIDENCE_MAX_ROWS`; it cuts every key fragment to 8 characters whatever the scanner sent.
   `credentialWriteScope: "write"` fails the run (`credential_has_write_scope`); `read_only` clears the posture row. A
   scanner must never test a key it finds (decision 6). A new scanner is one line in `DISCOVERY_SCANNERS`. Cloud SDK
   transports that delegate to `ctx.fetch` are SD2's.
7. **The worker** (`discovery-worker.ts`, scheduler job `discovery-scan-sweep`, every 60 s): enqueue due enabled sources
   (one `INSERT … ON CONFLICT` against the live-run index, `next_run_at` moved on in the same statement); fail runs whose
   lease lapsed on attempt 3 (`lease_expired`); claim with `FOR UPDATE SKIP LOCKED` a queued run or a lapsed lease with
   attempts left (re-take audited `discovery-run-lease-retaken`); run it; delete device findings and device-user
   pseudonyms not seen within the endpoint retention (audited). All lease times use the database clock.
   - **The run lease is the worker's, not the scanner's or the scheduler's** (master decision on #403). The lease is 5
     minutes; while `run` is pending the worker renews it every third of that on its own timer, independent of the
     scheduler job's lease and of whether the scanner calls `heartbeat`, so a long scan is not re-taken while its
     worker lives (tested: a 3-second scan under a 1-second lease, with a rival worker claiming half-way, finishes on
     attempt 1 with no re-take). A crashed worker stops renewing, and its run is re-taken one lease later. A lost
     lease aborts `ctx.signal` and nothing the scan returns is written. A scan is cut off at 2 hours
     (`DISCOVERY_RUN_MAX_SECONDS`, `timed_out`).
   - **Endpoint retention deletes even dispositioned evidence** (master decision on #403): a `device` finding not
     seen within the retention window is deleted whatever its disposition, and so is a device-user pseudonym. The
     audit log keeps the disposition event (it never held the name) and a retention row with the counts.
   The default rate limiter spaces one source's requests 100 ms apart in this process. Open source first: the
   maintained candidates were concurrency limiters (`p-limit`), not per-key spacing, and `bottleneck` has had no
   release since 2019; none was adopted.
8. **Posture rows**: `GET /v1/org/posture` gains `discovery` (reported, never a control): sources enabled, static
   credentials in use, static credentials older than the warning age, credentials whose write scope is unverified, and
   the posture sentence. The Enforcement posture page shows them; so does the Discovery sources page.
9. **Web**: `/admin/shadow-ai/discovery-sources` (nav: Governance, after Shadow-AI discovery). Kinds without a built
   scanner are listed as "not built yet (SDn)" and are not selectable; with none built, the add form is an empty state,
   not a disabled submit. Enable, widen, static credential, settings relaxation and reveal go through `withStepUp`.
   `KNOWN_UI_GAPS` stays 0; both UI preflights pass.
10. **Tests**: `zz-adr0195-sd0-discovery.test.ts` (database; typechecked locally, run in CI) with negative controls for
    every step-up (no grant, an API key, a grant for another scope that is not spent) and for the secret never being
    returned (every read route's body checked for the secret and its ciphertext); `discovery-scanners.test.ts`
    (contract, no database); shared `discovery/discovery.test.ts` (scope widening, posture sentence, artifact matching).

11. **Review of #403 (fixed before merge):**
    - **Public config is an allowlist.** `DISCOVERY_PUBLIC_CONFIG` names the identifier fields each kind accepts per
      mode, each with a shape check (numeric id, GUID, AWS role ARN, GCP id, GCP service-account email, an https
      audience with no query or credentials). Any other key is refused, so a key, token or service-account file cannot
      be stored as "federated" public config; the generated AWS `externalId` is refused in any spelling. The web
      "Replace credential" form leaves server-generated keys out of its pre-fill.
    - **A credential cannot widen an enabled source.** `credentialTargetMatch` compares the AWS role's account with
      `target.accountId` and the Azure tenant with `target.tenantId`: a mismatch is refused. Where it cannot be checked,
      storing or replacing a credential on an ENABLED source is the enable step-up, bound to the source and the new
      config (a static secret on an enabled source needs both step-ups).
    - **Stored text is scrubbed.** Every run error detail, audit reason and read-outcome detail goes through
      `scrubRunText`: the run's decrypted secret in each encoding (`scrubSecrets`), credential shapes (`scrubAuditText`,
      the `dlp.secret.*` patterns), URL query strings, then a length cap.
    - **A write-scope credential is refused, not reused.** When a scanner reports write scope, the credential is set
      `write_scope = 'refused'` (audited `discovery-credential-refused`); it is never used again, and enable and run-now
      refuse until it is replaced. Posture lists refused credentials.
    - **People and devices are pseudonyms.** A `cloud_principal` or `device` subject must match `^psn:[0-9a-f]{24}$`
      (device subjects use `pseudonymise("device_user", …)`); anything else refuses the run.
    - **Read outcomes** (for SD2): `ScanResult.readOutcomes?` (`{read, status: read|denied|not_enabled|unreachable|
      skipped|error, detail?}`, at most 100, optional so SD1/SD3 compile unchanged) are scrubbed, stored in
      `discovery_runs.read_outcomes` and shown on the run list as "could not read: …".
    - **Retention is batched** (1000 per pass). A sanctioned device whose finding was deleted by retention and is seen
      again comes back as a new, OPEN finding: the earlier disposition survives only in the audit log.
    - **Database clock** for a credential's age, an undated observation and an import's `applied_at` (M-075).
    - Reveal decrypts under the row lock before the grant is spent; a duplicate name on PATCH is refused before any
      grant is spent; the decision 8 spy test proves a call to a host that is not allow-listed reaches no transport and
      fails the run `egress_blocked`.

12. **Additions for SD1 (all optional, so other scanners compile unchanged):**
    - `ScanObservation.location?: {path, line?, commit?}` (path normalised to forward slashes with no leading `./` or
      `/`, no `..` segment, no control character, at most 512; line 1 to 10,000,000; commit 7 to 64 hex),
      `names?: string[]` (at most 50 identifier-like NAMES, never values: `NAME=value` is refused) and
      `actorPseudonym?` (`psn:` + 24 hex). They ride on the sighting kept in the finding's evidence
      (`FindingEvidence.location`, `.names`, `.actor`) and show in the Shadow-AI findings table's "Sightings" column; an
      actor links to the reveal card on Discovery sources (prefilled; the step-up still applies).
    - `ScanContext.catalogue` (read-only): `matches(observation)` runs the worker's own checks and matcher against the
      enabled admin catalogue, and `rows(kinds?)` returns the enabled rows (provider, kind, value, match type, min
      length) frozen. A scanner may use it to keep observations only an admin-added row would match; it never decides a
      finding.

13. **Additions for SD3:**
    - Pseudonym kind `device` (a device's own name), beside `device_user`, `commit_author` and `cloud_principal`; same
      per-tenant HMAC, enveloped name and `pseudonym_reveal` step-up. Retention deletes `device` and `device_user`
      pseudonyms alike. The device user rides on a sighting as `actorPseudonym` and shows pseudonymous in the findings.
    - Catalogue columns on `ai_endpoint_signatures`: `os` (macos, windows, linux, or null), `ecosystem` (bounded name),
      `tool_id` (bounded id), `note` (at most 500, registered for the ADR-0102 prose scrub) and `confidence` (high,
      medium, low; default high), all CHECKed. A row with `os` or `ecosystem` set matches only an observation that
      carries the same value (an observation without one does not match it). A medium- or low-confidence match is
      recorded on the sighting and shown in the findings. The seed and the catalogue route accept the columns, and the
      admin catalogue screen shows and sets them (and offers the artifact kinds).
    - Upload-fed kinds (`endpoint_osquery`, `endpoint_inventory`, `uploadFed` in `DISCOVERY_KIND_SPECS`) have no
      schedule: enabling sets no `next_run_at`, the worker never queues a scheduled run for them, and the UI hides the
      schedule field ("fed by uploads").

14. **Recheck of #403 (scope frozen after this):**
    - No credential in clear from a scanner: any subject (other than a pseudonym), host, package name, artifact value,
      location path or name that `scrubAuditText` would change refuses the observation, and a name matching an
      enabled `api_key_prefix` row is refused as a value. Refused observations are never stored or shown.
    - The enable step-up also binds the live credential id, so a credential swapped between the grant and its spend
      makes the grant fail. A `cloud_aws` source's target must carry `accountId` (12 digits).
    - `publicConfigProblem` checks own keys only (`constructor`, `__proto__` are unknown fields); route record keys
      are identifier-checked again.
    - Classification reloads the catalogue after the scan; the pre-scan copy serves only `ctx.catalogue`.
    - `ctx.registerSecret(value)` lets a scanner register a short-lived secret it obtained (a federated access token, a
      signed URL) for scrubbing; the source's own secret is registered already.
    - The new `ai_endpoint_signatures` CHECKs are declared in `schema.ts`; the browser's step-up cap follows the kinds.

**Not built in SD0 (left to the slices):** any scanner; cloud SDK transports over `ctx.fetch` (SD2); the git-provider
read methods (SD1); `SHADOW_AI_CATALOG_V2` and seed rows for the artifact kinds (SD1/SD3); the endpoint-notice
template and query pack (SD3); the agent (SD4); the air-gapped "unreachable" state for cloud sources (SD2).

### SD1 builder findings (decision 11, 2026-10-17)

- **Dependency inventory.** syft was not adopted: it catalogues a checked-out filesystem or image, while the repo
  scanner never clones (it reads a bounded set of files through the provider API and keeps no content), and it would
  add a binary to the image. Manifests are parsed with `smol-toml` (BSD-3-Clause, already pinned in the repo) and
  `fast-xml-parser` (MIT, entity processing off); npm, requirements.txt and go.mod reuse the ADR-0083 readers.
  Gradle scripts and Gemfiles are programs and are read by a bounded literal line scan.
- **Key detection.** The compiled gitleaks-derived `dlp.secret.*` rules are reused in JavaScript (they are compiled,
  not data, and linear by construction); the gitleaks binary was not needed.
- **Git provider clients.** No provider SDK is used: the existing adapters already call the four REST APIs through
  an injected fetch, and the readers extend that pattern so every call stays on the guarded fetch.
- **JSONC.** No maintained JSONC parser meets ADR-0176's maintenance window; a `.vscode/*.json` file with comments
  is reported by its path and its contents are counted as unparsed.
- **Catalogue v2.** 180 entries (v1's 81 unchanged first); coding-assistant entries were checked against vendor
  documentation or the VS Code marketplace on 2026-10-17. One PatronAI extension id no longer resolves and was left
  out. Seed rows for the artifact kinds use SD0's `identifier` match type.
- **Repo scanners (SD1 Phase B).** `discovery-repo-scanner.ts` registers `repo_github`, `repo_gitlab`,
  `repo_bitbucket` and `repo_azure_devops`. A source's target takes `namespace`, `baseUrl`, `history` and
  `historyDepth`; history is scanned only when `history = true`, and because the target is bound to SD0's enable
  step-up, turning history on for an enabled source is that step-up (decision 14). Requests go through `ctx.fetch`
  after `ctx.throttle()`; 429 and 503 waits are `ctx.backoff`'s, and a limit still in force afterwards fails the run
  as `rate_limited` (the next scheduled run retries). Commit authors go only to `ctx.pseudonymise("commit_author")`.
  Every observation carries SD0's `location` (path, line, commit); `.env.example` variable names and a stdio MCP
  server's command basename travel as `names` (names only, never values); `actorPseudonym` is the pseudonym of the
  author of the commit the tree was read at (not a per-line blame). `ctx.catalogue.matches()` keeps a package, host
  or extension id that only an admin-added row knows. Partial reads, empty repos and the repo-list cap are reported
  as `readOutcomes`.
- **Follow-up: federated git credentials.** The repo scanners accept only a static read-only token; a federated
  credential is refused with `credential_unusable`. GitHub App installation tokens and OIDC federation (GitLab,
  Azure DevOps workload identity) are later work.
- **Save-time validation.** SD1 added an optional `validateTarget(target, scope)` to SD0's `Scanner`; the source
  create and PATCH routes call it and refuse a malformed target or repo address with 400 `target_invalid` before
  anything is written or a step-up grant is spent.

## Owner decisions (2026-10-17): endpoint agent and detection data

Appended after the SD4 design spike ([R15](../research/R15-endpoint-agent-sd4-spike.md)). Nothing above is changed.

**Owner decisions (2026-10-17).**

1. **Apple signing.** A company Apple Developer account. The Developer ID signing identity is kept in a protected CI
   secret store that only release jobs can use.
2. **Windows signing.** An OV code-signing certificate, with its key in a cloud HSM-backed key service called from CI.
3. **Enrolment.** A per-org bulk enrolment token, delivered by MDM, capped, expiring and revocable. Each device then
   creates its own key and identity (ADR-0188 S7 pattern, new workload kind `endpoint_agent`).
4. **Device keys.** Hardware-bound by default: Secure Enclave P-256 on macOS, TPM on Windows and Linux. The OS-keystore
   fallback is used only where no such hardware exists, and posture flags it. A macOS build runner is needed.
5. **Product names in detection data.** AI products, including ones RegulAIt competes with, may appear as detection
   catalogue data (names, domains, bundle ids, extension ids, package names) and in the findings it produces, because
   customers need to see them. They never appear in marketing, docs prose, ADR prose, comparisons or UI copy.

**Technical calls recorded with them (master, 2026-10-17).**

- **The agent runs only as the logged-in user.** There is no root/SYSTEM component in v1. The package's one-time
  install step, which runs as root under MDM, redeems the bulk token for a per-device enrolment ticket (only when the
  device holds no valid one, and never failing an MDM install because redemption failed). The fleet token is never
  readable by ordinary users. The ticket file is readable only by the agent's group, and every registration is
  audited against the ticket id. A leaked ticket is usable from any machine until it expires; hardware-binding it is
  a later slice.
- **Endpoint findings record key presence only.** A finding carries the provider, the file or variable, and the key
  name. It carries no 8-character prefix: decision 18's "names (never values)" governs endpoints.
- **Key patterns are compiled into the agent** from the gitleaks-derived `dlp.secret.*` set (Go RE2). The collection
  manifest carries only paths, globs and names.
- **Pseudonyms are applied on the server.** Device user names and device hostnames are keyed-hashed server-side, and
  their display names are stored encrypted. Revealing one needs a `pseudonym_reveal` step-up and is audited. A device
  user name is self-reported, and the reveal UI says so. Endpoint evidence keeps the 90-day default retention of
  decision 20.
- **Three separate signing keys.** Agent releases are signed in the ADR-0041 manifest format under their own key id,
  separate from the ADR-0041 control-plane release key. Decision 18's query pack and collection manifest use the same
  format under a further key id of their own. A customer-side verify step ships with every pack, and the gateway
  verifies the pack manifest when it serves or accepts it. SD3's signer hook calls the same signing stage.
  `infra/release-keys/` is not reused. MDM is the only install channel. In v1, self-update (a relaxation, off by
  default) only downloads, verifies and notifies the user and the admin. A privileged install helper is out of
  scope, because it would bring back a resident root component.
- **Bulk token defaults.** The admin must set the device cap (there is no unlimited default). Expiry defaults to 30
  days, and lengthening it is a relaxation. The admin is alerted as the cap is approached. Rotation is by MDM
  re-push.
- **ADR-0176 build-tool exceptions.** WiX (MS-RL) and `rcodesign` (MPL-2.0) are accepted as written exceptions, with
  the unmet requirement stated in R15 §4.4: no permissively licensed tool builds an MSI, or signs and notarises Mach-O
  from Linux. Both are build tools only; their output is not covered by their licences and nothing of them is
  shipped.
- **Linux TPM.** The agent uses the TPM only where `/dev/tpmrm0` is already reachable by the user. Adding console
  users to the `tss` group is an audited admin opt-in (a relaxation), because it grants raw TPM access. Otherwise the
  software fallback applies and posture flags it.
- **Language.** The agent is written in Go: a static build for Windows and Linux, and a cgo build on the macOS runner
  for darwin.

## As built: SD2b federation signer (2026-10-17): BLOCKED on a migration

**Superseded (2026-10-17):** migration 0205 was assigned and SD2b was built; see "As built: SD2b federation signer" below. This
section is kept as the record of the plan that the as-built section deviates from.

**Status: not built. Blocked on a migration number from the master.** Branch `sd2b-federation-signer`.

Why a migration is unavoidable. The RS256 federation key must be generated in the product and its private half kept
encrypted under the data key. The existing issuer key store cannot hold it:

- `identity_signing_keys` CHECKs `algorithm = 'Ed25519'` and an `OKP`/`Ed25519` public JWK;
- it has one global "one active key" index, so an active RS256 key would collide with the active Ed25519 signer;
- it has no private-key column (the Ed25519 private halves are a deploy-time file, ADR-0188 decision 5);
- the data-key re-encryption sweep (`data-key-reencrypt.ts`) updates ciphertext rows `WHERE id = …`, so a key table
  needs an `id` column.

Loosening the Ed25519 table's CHECKs would weaken the delegated-token verifier's invariants, which `issued_tokens`
references by `kid`. A separate table leaves them untouched.

Design the migration below supports (to be built once a number is assigned):

- `federation_signing_keys`: generated in-product (Node `crypto`, RSA 2048-bit, e = 65537; `kid` is the RFC 7638
  thumbprint through `jose`), the PKCS#8 private half enveloped under the data key and listed in
  `CIPHERTEXT_COLUMNS`. A retired or revoked key's private half is destroyed in the same update (CHECK).
- Federation is off until an admin generates and activates the first key. That first activation is a
  `settings_relax` step-up, because it turns federation on. Rotating and revoking go through the issuer-key
  management routes under the `identity_manage` step-up those routes require today. PR #415's `key_management` kind
  is not on main. Revoking is compromise handling: the key leaves the JWKS at once.
- The public halves (active, plus retired keys inside the overlap) are published as `alg: RS256` entries in
  `/.well-known/jwks.json` beside the Ed25519 keys. The Ed25519 verifier never accepts an RS256 `kid`.
- Federation JWTs: `iss` = the issuer, `sub` = `discovery-source:<sourceId>`, `aud` bound per target (AWS
  `sts.amazonaws.com`, the GCP pool provider resource, Entra `api://AzureADTokenExchange`), at most 5 minutes, `jti`
  random. AWS `AssumeRoleWithWebIdentity` uses `@aws-sdk/client-sts`, GCP STS uses `google-auth-library`'s external
  account client (with the SD2 transporter workaround), and Entra uses `@azure/identity`'s `ClientAssertionCredential`.
  All of them are already pinned in `packages/cloud-discovery`, and every call goes through the guarded fetch.
- AWS Organizations `ListAccounts` (paginated, read-only) for organisation-level AWS sources, from RegulAIt's own AWS
  principal (`assume_role` with the per-source external ID).

Exact SQL proposed (number `NNNN` to be assigned by the master; hand-written, no journal entry added here):

```sql
-- ADR-0195 SD2b: the issuer's RS256 federation signing keys (cloud workload identity federation).
-- Hand-authored (never drizzle-kit generate). Separate from identity_signing_keys so the Ed25519 verifier's
-- CHECKs, its one-active index and the issued_tokens FK are untouched.
CREATE TABLE "federation_signing_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kid" text NOT NULL,
  "algorithm" text DEFAULT 'RS256' NOT NULL,
  "public_jwk" jsonb NOT NULL,
  "private_key_ciphertext" text,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "activated_at" timestamp with time zone,
  "retired_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "federation_signing_keys_kid_uq" UNIQUE ("kid"),
  CONSTRAINT "federation_signing_keys_kid_check" CHECK ("kid" ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT "federation_signing_keys_algorithm_check" CHECK ("algorithm" = 'RS256'),
  CONSTRAINT "federation_signing_keys_public_only_check" CHECK (
    COALESCE(
      jsonb_typeof("public_jwk") = 'object'
      AND "public_jwk" ->> 'kty' = 'RSA'
      AND "public_jwk" ->> 'e' = 'AQAB'
      AND jsonb_typeof("public_jwk" -> 'n') = 'string'
      AND length("public_jwk" ->> 'n') BETWEEN 342 AND 683
      AND NOT ("public_jwk" ?| ARRAY['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']),
      false
    )
  ),
  -- a live key holds its private half; a retired or revoked key never does
  CONSTRAINT "federation_signing_keys_private_check" CHECK (
    ("retired_at" IS NULL AND "revoked_at" IS NULL) = ("private_key_ciphertext" IS NOT NULL)
  ),
  CONSTRAINT "federation_signing_keys_order_check" CHECK (
    ("activated_at" IS NULL OR "activated_at" >= "created_at")
    AND ("retired_at" IS NULL OR ("activated_at" IS NOT NULL AND "retired_at" >= "activated_at"))
    AND ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "federation_signing_keys_one_active_uq" ON "federation_signing_keys" ((true))
  WHERE "activated_at" IS NOT NULL AND "retired_at" IS NULL AND "revoked_at" IS NULL;
--> statement-breakpoint
-- never deleted; identity and each lifecycle stamp written once; the ciphertext may be re-encrypted (data-key
-- rotation) while live, and once destroyed it never comes back
CREATE OR REPLACE FUNCTION public."regulait_federation_signing_key_guard"() RETURNS trigger
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'federation_signing_keys: a signing key is never deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."kid" IS DISTINCT FROM OLD."kid"
     OR NEW."algorithm" IS DISTINCT FROM OLD."algorithm" OR NEW."public_jwk" IS DISTINCT FROM OLD."public_jwk"
     OR NEW."created_by" IS DISTINCT FROM OLD."created_by" OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR (OLD."activated_at" IS NOT NULL AND NEW."activated_at" IS DISTINCT FROM OLD."activated_at")
     OR (OLD."retired_at" IS NOT NULL AND NEW."retired_at" IS DISTINCT FROM OLD."retired_at")
     OR (OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at")
     OR (OLD."private_key_ciphertext" IS NULL AND NEW."private_key_ciphertext" IS NOT NULL) THEN
    RAISE EXCEPTION 'federation_signing_keys: a key and each of its lifecycle stamps are written once'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "federation_signing_keys_guard"
  BEFORE UPDATE OR DELETE ON "federation_signing_keys"
  FOR EACH ROW EXECUTE FUNCTION public."regulait_federation_signing_key_guard"();
--> statement-breakpoint
CREATE TRIGGER "federation_signing_keys_no_truncate" BEFORE TRUNCATE ON public."federation_signing_keys"
  FOR EACH STATEMENT EXECUTE FUNCTION public.regulait_refuse_truncate();
```

Nothing above has been run (no Postgres in the build environment). It follows the 0185 guard rules (pinned
`search_path`, TRUNCATE refused beside the row guard), and the code side adds the `CIPHERTEXT_COLUMNS` entry and the
`schema.ts` declaration with the same CHECKs.

## As built: SD2b federation signer (2026-10-17, migration 0205)

**Status: built on branch `sd2b-federation-signer`.** Migration `0205_federation_signing_keys.sql` is hand-written;
its journal entry is NOT in this branch (0204 merges first; the master adds
`{"idx": 205, "version": "7", "when": 1785140000000, "tag": "0205_federation_signing_keys", "breakpoints": true}`).
Until then the database tests that need the table fail in CI.

Why a separate table. The RS256 key is generated in the product and its private half kept under the data key. The
Ed25519 issuer store (`identity_signing_keys`) CHECKs `algorithm = 'Ed25519'` and an `OKP` JWK, has one global
"one active key" index, has no private-key column (ADR-0188 decision 5) and no `id` for the re-encryption sweep.
Loosening it would weaken the delegated-token verifier's invariants, so `federation_signing_keys` stands alone.

1. **Migration 0205** (`federation_signing_keys`): `id` (the data-key re-encryption walk updates by it), `kid`
   (RFC 7638 thumbprint, unique), `algorithm` = RS256, a public-only RSA JWK (e = AQAB, 2048 to 4096 bits, no
   private member; CHECK), `private_key_ciphertext` (PKCS#8 under the data key, in `CIPHERTEXT_COLUMNS`), lifecycle
   stamps. A live key holds its private half and a retired or revoked key never does (CHECK); at most one active
   key (partial unique index); never deleted, each stamp written once, a destroyed private half never returns
   (trigger, `search_path` pinned); TRUNCATE refused (0185 rules).
2. **A separate issuer (deviation from the plan above).** The plan published the RS256 keys beside the Ed25519 keys in
   `/.well-known/jwks.json`. As built, federation has its own issuer `<REGULAIT_PUBLIC_URL>/federation`, with its own
   OIDC discovery document (`/federation/.well-known/openid-configuration`, which AWS IAM and Entra require) and its
   own JWKS (`/federation/.well-known/jwks.json`, RS256 only). Reasons: AWS, GCP and Entra parse every key of the
   JWKS they are given, and an `OKP` entry is not one they all accept; and with a different `iss` and different keys
   a federation token never verifies at RegulAIt's own delegated-token verifier, nor an issuer token at a cloud. The
   Ed25519 JWKS is unchanged. Both new routes are public (auth-exempt, `NON_ADMIN_ROUTES`), public data only.
3. **Lifecycle** (`federation-signing-keys.ts`, routes in `federation-routes.ts`, admin-only, every change audited
   as `federation_signing_key`):
   - `POST /v1/discovery/federation/keys` generates a PENDING key (RSA 2048, Node `crypto`; free, it signs nothing
     and is not published; at most one pending key).
   - `POST …/keys/:kid/activate` with no active key TURNS FEDERATION ON: `settings_relax` step-up
     `{op: "federation_enable", keyId}`. With an active key it ROTATES: `key_management` step-up
     `{op: "federation_key_rotate", keyId}`; the previous key is retired, its private half destroyed, and it stays
     published for 600 s (token life plus skew).
   - `POST …/keys/:kid/revoke`: `key_management` step-up `{op: "federation_key_revoke", keyId}`; the key leaves the
     JWKS at once (revoking the active key turns federation off).
   - `POST /v1/discovery/federation/disable`: free (a tightening); the active key is retired.
   The step-up is decided on an unlocked read and re-checked under the table lock; if the active key moved, nothing
   is written (409 `changed_concurrently`, ADR-0186 A). A refused act spends no grant.
4. **Tokens**: RS256, `iss` the federation issuer, `sub` `regulait:discovery-source:<sourceId>` (or
   `regulait:aws-principal`), `aud` exactly one per target (AWS `sts.amazonaws.com`, Entra
   `api://AzureADTokenExchange`, GCP `https://iam.googleapis.com/projects/<n>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`
   from the credential), `iat` = `nbf`, `exp` 300 s later, random `jti`. `federationTokenMinter` refuses any
   audience the credential does not name before reading the database. Minting refuses while federation is off,
   while `REGULAIT_PUBLIC_URL` is unset, or when the data key cannot open the key.
5. **Scanner wiring**: the worker gives a FEDERATED credential's run `ctx.federation` (source token bound to the
   source and its audiences; RegulAIt's own AWS principal when configured). The token exchanges stay the SD2 SDK
   paths (`fromWebToken`, `fromTemporaryCredentials`, `IdentityPoolClient`, `ClientAssertionCredential`), every
   call on the guarded fetch; minted tokens are registered for scrubbing and exchange bodies are never digested.
6. **RegulAIt's own AWS principal**: `REGULAIT_AWS_PRINCIPAL_ROLE_ARN` names an IAM role that trusts the federation
   issuer for `sub = regulait:aws-principal`. A `cloud_aws` target `federation=principal` reaches that role by web
   identity and then `AssumeRole`s into the customer's role with the source's SD0-generated external id;
   `federation=oidc` (the default) is AssumeRoleWithWebIdentity straight into the customer's role. No long-lived
   key and no default credential chain anywhere.
7. **AWS Organizations**: a `cloud_aws` target `organizationAccounts=true` calls Organizations `ListAccounts`
   (paginated, page cap per call, read-only; `@aws-sdk/client-organizations` 3.1152.0, Apache-2.0, added to
   `THIRD_PARTY.md`) from the source's account. With `memberRoleName` each ACTIVE member (at most 50 per run) is
   scanned by the SD2 AWS scanner through `AssumeRole` into that role with the external id (federated credentials
   only), reads reported as `<account>:<scope>`; without it the accounts are listed and reported as not scanned.
8. **Web**: a "Cloud federation" card on Discovery sources (generate, turn on, rotate, revoke, turn off; issuer,
   subject and audiences to put in a trust policy). Both UI preflights pass with `KNOWN_UI_GAPS` 0.
9. **Tests**: `federation-signing-keys.test.ts` (signer/JWKS round trip, audience and expiry binding, refusals,
   publication overlap; no database), `discovery-cloud-scanners.test.ts` (federated AWS, principal, Organizations
   pagination and member scan, egress refusal, malformed targets), `zz-adr0195-sd2b-federation.test.ts` (database:
   CHECKs, guard and TRUNCATE, off by default, each step-up with negative controls that are not spent, round trip
   against the JWKS route, rotate, revoke, disable).

Open source first: key generation is Node `crypto`, the thumbprint and JWS are `jose` 6.2.12, the token exchanges
are the cloud SDKs already pinned; the one new dependency is the Organizations client. Not built: an
end-to-end run against a real cloud account (pending execution, needs a customer trust policy), and federated
git-provider credentials (SD1 follow-up).

**Q11 design review (2026-10-18, ADR-0197).** The separate issuer `<REGULAIT_PUBLIC_URL>/federation` is kept: RS256
is the one algorithm AWS, GCP and Entra all accept, and the root JWKS, which third parties trust, stays Ed25519-only.
Customers configure one trust per cloud. A pending federation key is published before it signs. Revocation cannot
end cloud sessions already obtained.

**As built: pending key published (2026-10-18, branch `federation-pending-key-jwks`, no migration).** This changes
item 3's "it signs nothing and is not published": a PENDING key is now in the federation JWKS from the moment it is
generated, so a cloud can cache it before it signs and a rotation never meets an unknown `kid`.
- `isPublished` is true for a pending key (not revoked); `publishedFederationKeys` drops the `activated_at IS NOT
  NULL` condition and keeps `revoked_at IS NULL` and the 600 s retired overlap; the JWKS lists the pending key first
  (`activated_at DESC NULLS FIRST`). `federationKeyView.published` follows.
- Signing is unchanged: `mintFederationToken` still reads only the active key (activated, not retired, not
  revoked), so a pending key signs nothing until activated, and activation switches signing to it.
- Revoking a pending key still removes it from the JWKS at once and destroys its private half.
- The Cloud federation card says generated keys are published at once and to activate (or rotate) after a few
  minutes.
- `CLOUD_DISCOVERY.md` (status, the issuer to register, rotation, revocation limits, Entra propagation) and the
  comments and variable descriptions of `docs/deployment/cloud-discovery/{aws,azure,gcp}.tf` now name the federation
  issuer `<REGULAIT_PUBLIC_URL>/federation` instead of the ADR-0188 issuer.
- Tests: `federation-signing-keys.test.ts` (a pending key is published, a revoked pending key is not);
  `zz-adr0195-sd2b-federation.test.ts` (a pending key is in the JWKS route with RSA public members only and mints
  nothing; during rotation the pending key is published beside the active key, which keeps signing; activation
  switches signing; revoking a pending key removes it at once; the retired key's overlap is unchanged).

## As built: lane A6, environment-variable-name and CLI presence signatures (2026-10-17)

**Status: shared matcher, catalogue data, tests and the SD1/SD3 wiring built on branch `sd-env-name-signatures`
(review fix round, 2026-10-17). The admin-catalogue `env_name` and `cli` kinds are BLOCKED on a migration number
(below).** Nothing above is changed.

1. **Master decision (data minimisation).** A presence match records only that a signature matched and the
   signature's id. The variable names themselves and any values are never stored as evidence. Values are never read
   beyond what matching needs: `envNamePresenceInText` slices only the candidate name on each line (before its `=` or
   `:`) and moves to the next line with `indexOf`, so no value substring is ever created. `matchEnvNames`,
   `matchCliNames` and `envNamePresenceInText` return `{signatureId, provider, kind, confidence}` and nothing else.
2. **Kinds.** `PRESENCE_SIGNATURE_KINDS = ["env_name", "cli"]` (`packages/shared/src/discovery/presence-signatures.ts`).
   Decision 18 lists AI CLIs and the names (never values) of AI-related environment variables among the endpoint
   facts, and decision 14 lists `.env.example` names among the repo facts. No SD0 kind fits either (`local_runtime` is
   a model runtime), so both are added.
3. **Name shape.** An env name must match the endpoint agent's pattern `^[A-Z][A-Z0-9_]*$` and be at most 128
   characters. Anything else is skipped and never matched. Matching is whole-name, case-sensitive equality. A CLI
   name is the base name of a path (`/` or `\`), lower-cased, without `.exe`, checked against
   `^[a-z0-9][a-z0-9._-]{0,63}$`, then compared whole. No regex comes from data. Inputs are bounded: at most 5,000 names
   per call and 2,000,000 characters per text. Going over the bound throws an error; the input is never silently cut.
4. **Text formats.** `dotenv` (`[export] NAME=`), `dockerfile` (`ENV`/`ARG NAME`, `NAME=` or `NAME value`) and
   `ci_yaml` (`NAME:`, `- NAME=`, `- NAME:`, `name: NAME`). Stated limits: one name per line, so `ENV A=1 B=2` yields
   only `A`; continuation lines and YAML flow mappings are not parsed; commented-out lines do not match.
5. **Catalogue data (`PRESENCE_SIGNATURES_V1`, 16 rows, pinned by count and SHA-256 in the test).** There are 13
   env names and 3 CLI names. All are taken from the `env_vars` and `cli.binaries` fields of the Apache-2.0 registry
   that the open-source evaluation above names, at commit `12b7bbf733032d7822b2fb16e88b0f7a1399d1da`. Its LICENSE and
   NOTICE are kept in `src/discovery/vendor/shadow-ai-guard/`, and `THIRD_PARTY.md` lists the registry. Each row cites
   the commit. A generic cloud-platform key name is low confidence. The three short CLI names are medium confidence,
   because other programs may share them. Open source first: the registry is the data source; no maintained library
   matches env-name presence with these minimisation rules, so the matcher is ours.
6. **BLOCKED: migration needed.** Migration 0202 closes `ai_endpoint_signatures_kind_ck` and
   `ai_endpoint_signatures_kind_match_ck`, so `env_name` and `cli` rows cannot be stored, and `AI_SIGNATURE_KINDS`
   does not list them. A test asserts that they are not listed. The SQL the follow-up needs is below. It is not
   written as a migration, and it is pending execution:
   ```sql
   ALTER TABLE "ai_endpoint_signatures" DROP CONSTRAINT IF EXISTS "ai_endpoint_signatures_kind_ck";
   ALTER TABLE "ai_endpoint_signatures" ADD CONSTRAINT "ai_endpoint_signatures_kind_ck" CHECK ("kind" IN (
     'hostname', 'sdk_package', 'api_key_prefix', 'web_app',
     'cloud_ai_service', 'desktop_app', 'ide_extension', 'browser_extension', 'local_runtime', 'assistant_config',
     'env_name', 'cli'));
   ALTER TABLE "ai_endpoint_signatures" DROP CONSTRAINT IF EXISTS "ai_endpoint_signatures_kind_match_ck";
   ALTER TABLE "ai_endpoint_signatures" ADD CONSTRAINT "ai_endpoint_signatures_kind_match_ck" CHECK (
     ("kind" = 'sdk_package') = ("match_type" = 'package')
     AND ("kind" = 'api_key_prefix') = ("match_type" = 'key_prefix')
     AND ("kind" IN ('cloud_ai_service', 'desktop_app', 'ide_extension', 'browser_extension', 'local_runtime',
                     'assistant_config', 'env_name', 'cli')) = ("match_type" = 'identifier')
   );
   ALTER TABLE "ai_endpoint_signatures" DROP CONSTRAINT IF EXISTS "ai_endpoint_signatures_presence_value_ck";
   ALTER TABLE "ai_endpoint_signatures" ADD CONSTRAINT "ai_endpoint_signatures_presence_value_ck" CHECK (
     ("kind" <> 'env_name' OR ("value" ~ '^[A-Z][A-Z0-9_]*$' AND char_length("value") <= 128))
     AND ("kind" <> 'cli' OR "value" ~ '^[a-z0-9][a-z0-9._-]{0,63}$')
   );
   ```
   The statements create no function and no trigger, so the 0185 guard has nothing new to check. `schema.ts` would
   declare the new value CHECK for parity, as SD0 did.
7. **Wiring (built in the review fix round of #419).**
   - **SD1.** `analyseRepo` reads `.env.example`-style templates, Dockerfiles (`Dockerfile`, `Containerfile`,
     `Dockerfile.*`, `*.dockerfile`) and CI YAML (`.github/workflows/*.yml|yaml`, `.gitlab-ci.yml`,
     `azure-pipelines.yml`, `bitbucket-pipelines.yml`, `.circleci/config.yml`) with `envNamePresenceInText`, and emits
     `env_presence` observations that carry a signature id only. The repo scanner sends one observation per file with
     `presence: [ids]`. It no longer sends env names in `names`; `names` keeps only an MCP server's command basename,
     and an env-shaped basename is not sent.
   - **SD3.** `reduceEndpointObservations` runs `matchEnvNames` over a row's env-variable keys and `matchCliNames` over
     its CLI binaries before the artifact match. A match becomes a sighting whose value is the signature id, sent as
     `presence`. An env-variable name is never an artifact candidate and never a catalogue-gap sample. A CLI binary
     the presence catalogue does not know (for example a local runtime) is still matched as an artifact.
   - **SD0.** `ScanObservation.presence` and `Observation.presence` carry ids, checked against the presence
     catalogue (an unknown id is refused). `checkObservations` refuses a `names` entry shaped like an env name
     (`^[A-Z][A-Z0-9_]*$`), and its refusal messages no longer echo the refused text. No SD0 refusal echoes a scanner-supplied value: the
     evidence-kind, subject-kind, artifact-kind and read-status refusals name the index and the field only (recheck of
     #419, F1). `classifyObservation` has a
     presence step: an id counts only when an ENABLED `identifier` row of a backing kind carries the same value
     (`PRESENCE_BACKING_KINDS`: `assistant_config`/`local_runtime` for env names, `desktop_app`/`local_runtime` for
     CLI names, the kinds SD3's seed stores them as). Disabling that row turns the detection off. The finding's
     `matchedValue` is the id, its evidence keeps `presence: [ids]`, and the confidence is the lower of the two rows'.
     The web view shows the ids as "presence signatures".
   - **Catalogue validation.** `isPresenceSignature` and `assertPresenceCatalogue` check every row (id pattern and
     kind prefix, value shape, provider, tool id, confidence, unique ids) once per catalogue. Every matcher refuses a
     malformed catalogue rather than match against it. The migration follow-up reuses them for admin rows.

   **Still missing (follow-ups):** (a) the kind migration above; (b) adding `env_name` and `cli` to
   `AI_SIGNATURE_KINDS`, `catalogueSignatureSchema` and `PRESENCE_BACKING_KINDS`, with seed rows from
   `PRESENCE_SIGNATURES_V1` carrying `tool_id` and `confidence`; (c) SD4's agent rows calling the same matchers.
   SD4a (merged in #411) already emits `env_name` facts whose `identifier` is the env-variable name
   (`agents/endpoint/internal/collect/configs.go`). When the SD4b gateway intake is built, it must map each such fact
   to its presence signature id (`matchEnvNames`) and send it as `presence`; it must never pass the name through
   `names` (which `checkObservations` refuses) or as an artifact value.
   Coverage note: the SD1 repo path now detects only the env names in `PRESENCE_SIGNATURES_V1` (the same 13 that
   SD3's seed carries); an admin-added env name cannot be matched until (b), because the scanner no longer handles
   names.
8. **Decision recorded (was an open question).** The master decision answers it: environment-variable names are
   never stored as evidence, from any scanner. SD0 addition 12 (`ScanObservation.names` into
   `FindingEvidence.names`) is limited to non-env identifiers (an MCP command basename). Env-name presence is reported
   only as A6 signature ids. No stored evidence on main depended on env names in `names`: the SD1 env-name
   observation carried no matchable value, so it never reached a finding. SD3's env-variable findings stored the
   catalogue's env name as `matchedValue`; they now store the signature id.

## SD3 build notes (2026-10-17)

- The query pack is generated from the enabled endpoint signature seed (`packages/shared/src/endpoint-discovery/`), so a
  device filters to what the catalogue can match instead of shipping its whole software inventory; each query's
  definition also carries the importer's column allowlist. `scripts/endpoint-pack-build.mjs` writes
  `endpoint-discovery/osquery/`, and the shared suite fails on drift. Execution under osquery is pending (M-041).
- Endpoint match types are exact, case-insensitive comparisons (`app_name`, `bundle_id`, `executable_name`,
  `cli_binary`, `npm_package`, `process_name`, `ide_extension_id`, `browser_extension_id`, `env_var_name`), a
  home-relative `config_path`, a decimal `listening_port`, and a `trait_set` over a closed trait vocabulary
  (`listen_all_interfaces`, `user_writable_path`, `hidden_path`, `background_agent`). SD0 aligns its matcher columns
  to these.
- Seed: 90 rows derived from the pinned registry (commit `12b7bbf7`), 12 written by us (local runtime names and default
  ports, AI CLI npm packages, three hidden-assistant trait rows). Rows for a general-purpose desktop app are imported
  disabled: its presence is not AI use. The two LAN-listener trait rows stay enabled and are marked low confidence
  (coordinator, 2026-10-17).
- Importers bound each file at 5,000,000 bytes and 20,000 rows (one osquery line at 262,144 characters, one cell at
  512); every row not imported is refused with its line and counted. A row with a value, command-line or contents
  column is refused. Decorations are discarded. Device names are pseudonymised as well as device users, because host
  names often carry a person's name. There is no default pseudonym hook; a missing hook refuses the import.
- The pack is unsigned until SD4; the manifest carries its SHA-256 and a signer seam.
- Phase B (wired into SD0): `endpoint_osquery` and `endpoint_inventory` are registered as upload-fed scanners (a
  scheduled run observes nothing). `POST /v1/discovery/sources/:sourceId/endpoint-imports` parses the file with a
  request-local keyed hash, matches it against the enabled catalogue, opens a run on the source holding its lease, and
  commits through SD0's fenced path (`applyDiscoveryRunObservations`, factored out of the worker). Only the devices
  and device users of committed sightings get SD0 pseudonyms; the user travels as `actorPseudonym`. `POST /v1/discovery/endpoint-signatures/seed` installs the
  seed as `identifier` rows (ports as `port:<n>`, trait sets as `trait:<sorted set>`). Endpoint retention is SD0's.
- With SD0's follow-up columns (migration 0202): device names use the `device` pseudonym kind and device users
  `device_user` (sent as `actorPseudonym`); seed rows carry `os` (one OS, or any when SD3 scoped a row to two),
  `ecosystem` (`vscode`, `jetbrains`, `firefox`, `safari`, and `chromium` for Chrome and Edge), `tool_id`, `note` and
  `confidence` (`high`, and `low` on the two LAN-listener trait rows); upload-fed sources are never scheduled. An
  OS-scoped row matches only a sighting whose OS is known and equal, so an inventory export without an OS column
  matches only the OS-neutral rows.

## As built: SD4a (endpoint agent, agent side)

Built 2026-10-17 on branch `sd4a-endpoint-agent`, in `agents/endpoint/` (a Go module outside the pnpm workspace; Go
1.27.2 toolchain). Nothing above is changed. "SD4a" here is the master's name for this build slice; it covers R15's
SD4c (agent core), most of SD4d (collectors), the drop counter, jitter and backoff of SD4f, the build and licence
check of SD4g, the unsigned packages of SD4h, and the Linux and Windows parts of SD4j. No gateway, `packages/shared`
or web code is touched, and there is no migration.

### What it does

- **Collectors** (`internal/collect`) for every decision-18 fact, driven only by the signed collection manifest:
  desktop apps (macOS `Info.plist` bundle ids, Linux desktop file ids, Windows uninstall display names), IDE
  extensions (VS Code-family `package.json` ids, plugin directory names), browser extensions (Chromium-family
  extension directories, Firefox-family `extensions.json`), local runtimes (process names and listening ports), AI
  tool config files, CLIs on `PATH`, and environment-variable names in start-up files and the Windows registry.
  Matching is equality on catalogue identifiers (case-insensitive where the OS is); no pattern from data is ever
  evaluated. Every read goes through an `os.Root`, so a symlink cannot lead out of the home directory, and each file
  read is capped at 256 KiB (4 MiB for `extensions.json`). Collector failures become fixed gap codes, never error
  strings, because an OS error carries the absolute path.
- **Key presence only** (call 2). Values are checked on the device against patterns compiled from the shared
  `dlp.secret.*` set (`internal/secrets`, Go RE2) and dropped. A fact carries `{keyName, ruleId, present}`. A
  manifest-listed name is reported in the manifest's own spelling; any other name only when it is an
  environment-variable-style identifier (`^[A-Z][A-Z0-9_]*$`, at most 128 characters), and otherwise as `(unnamed)`,
  so a lower-case, dotted or free-text name (a login such as `alice.smith`, a JSON key) never leaves the device
  (security review L3, 2026-10-17). The three shared rules that use lookaround
  (`jwt`, `stripe_key`, `google_api_key`) are an RE2 match plus a check in code. `testdata/vectors.json` runs the
  same inputs through the Go table and through the shared JavaScript rules (`scripts/check-secret-rules.mjs`, CI job
  `secret-rules`), which also fails when a shared rule is added, removed or changed.
- **The collection manifest** (`internal/pack`): `regulait.endpoint-collection/1` inside a pack in the ADR-0041
  manifest format (`schema regulait.update-bundle/1`, `product regulait-endpoint-pack`), Ed25519 over the exact
  manifest bytes. Refused: no signature, an unknown key id, a bad signature, a modified, missing or unlisted file, a
  downgrade below the last accepted version or below the build's compiled minimum (`pack.MinimumVersion`, 1.0.0, so
  a new user or lost state cannot accept an older signed pack; security review L2), an unknown kind or member, a field of another kind, and any name or path
  with a pattern character (`^ $ | \ [ ] { } ( ) +`, globs in names, `**`, `..`, absolute paths, including
  drive-letter and backslash roots). A braced GUID is the
  one allowed use of braces (Firefox add-on ids). The compiled pack keyring is **empty** until the pack key exists,
  so every pack is refused today: the strict default. The `cli` and `env_name` kinds are accepted; SD0/SD3 decide
  whether the catalogue adopts them.
- **Pseudonymity** (decision 20, call 3). Reports carry only catalogue identifiers, root-relative paths, versions,
  ports and key names. The hostname is sent only to the ticket route and the self-reported user name only to the
  register route, both for the gateway to keyed-hash. A guard (`internal/privacy`) refuses to send any report that
  contains the home directory's path, or the user or host name as a whole token; a refusal is logged and nothing is
  sent.
- **Local config** (`/etc/regulait-agent/config.json`, `/Library/Application Support/RegulAIt/Agent/config.json`,
  `%ProgramData%\RegulAIt\Agent\config.json`): root-owned, not writable by others, unknown members refused. It names
  the issuer (https only, never plain http), an optional pinned CA bundle (which then replaces the OS store), and
  kinds to turn off. It cannot relax anything: every limit is compiled in, and the org policy the gateway serves is
  clamped (interval 1 h to 7 d, default daily; kinds can only be turned off).
- **Enrolment.** `redeem-ticket` is the package's install step, run once as root: it redeems the bulk token only when
  the device holds no ticket valid for at least another hour, refuses a token file that is not root-only `0600` or is
  a symlink, refuses a token whose `expiresAt` has passed (it is never sent), checks the token's issuer against the
  config, writes the ticket `0640` to group `regulait-agent` through an exclusive temporary file, records the outcome
  in a world-readable status file holding no secret, and always exits 0. `register` (first run as each user) refuses a
  missing, expired, foreign-issuer or world-readable ticket with "waiting for enrolment ticket", creates the device
  key and registers its public JWK; it is idempotent, and a key created by a registration whose answer was lost is
  reused.
- **Device keys** (owner decision d; `internal/devicekey`), all P-256/ES256. Hardware is chosen when it probes
  usable; the software fallback only when the probe says there is no hardware, logged at warn level and sent as
  `keyProtection: software` with the reason; hardware that is present but failing is an error, never a fallback.
  - Linux: the TPM through `go-tpm` over `/dev/tpmrm0` (a P-256 key under the re-derived TCG ECC SRK; only its
    TPM-wrapped blob is stored, `0600`), used only where the user can already open the device; otherwise a `0600`
    PKCS#8 file, created exclusively, never opened through a symlink, in a `0700` directory.
  - Windows: the Platform Crypto Provider (NCrypt), per-user and non-exportable; otherwise a DPAPI-protected file.
    Only `NTE_DEVICE_NOT_FOUND` (0x80090035), `NTE_PROV_DLL_NOT_FOUND` (0x8009001E) or a missing `ncrypt.dll` count
    as "no hardware"; every other status from opening the provider (access denied, a TPM present but not ready, a
    failing provider DLL) is an error and the agent refuses, never falling back to DPAPI (security review M2;
    `classifyProviderOpen`, unit-tested on every OS). One exception, observed on the CI Windows runner: a machine
    with no TPM answers `NTE_DEVICE_NOT_READY` (0x80090030), the same status as a TPM that is present but not
    ready. That status, and `TBS_E_TPM_NOT_FOUND` (0x8028400F) if the provider passes it through, counts as "no
    hardware" only when TBS (`Tbsi_GetDeviceInfo`) itself answers `TBS_E_TPM_NOT_FOUND`; a TPM that TBS reports
    present, any other TBS error, or no `tbs.dll` keeps it a refusal. The TBS answer is injected into
    `classifyProviderOpen` (`tpmPresent func() (bool, error)`), so every combination, including the runner's
    observed 0x80090030 with no TPM, is a unit-test row on every OS.
  - macOS: **refuses to create a key.** The Secure Enclave store needs the cgo build on the macOS runner (SD4j), and
    falling back to software on hardware every supported Mac has would break decision d.
- **Tokens and upload** (ADR-0188 S7 reused; `internal/auth`, `internal/transport`): `client_credentials` with an
  ES256 `private_key_jwt` (aud the token endpoint, 60 s) and a DPoP proof by the same key, one nonce retry, a fresh
  proof per request with `ath`, one retry with a new token after another 401. The HTTP client reaches only the issuer
  (checked per request before dialling), requires TLS 1.3, honours the proxy settings and never follows a redirect.
  Each report is sent with an RFC 9530 `Content-Digest` and a report signature (below). Rotation follows S7 point 4:
  the new key is saved as pending before the request, and a lost answer is recovered by trying the pending key.
- **Schedule.** `run` repeats the cycle on the org's interval with ±30 min jitter, backing off from 5 min to 6 h after
  a failure. There is no buffer yet (SD4f): a snapshot that cannot be delivered is dropped and counted in the next
  report's `droppedSnapshots`.
- **`preview -manifest FILE`** runs the collectors against a local, unsigned manifest and prints the facts. It sends
  nothing; it exists so an admin can see what the agent reports on a machine before enrolling it.

### Gateway ingest contract (for SD4b)

Go types: `agents/endpoint/internal/contract`. Byte-exact example bodies: `internal/contract/testdata/`. A strict fake
that SD4b's gateway must agree with: `internal/gatewaytest`.

| Route | Auth | Request | Answer |
|---|---|---|---|
| `POST /v1/endpoint-agent/enrolment-tickets` | `Authorization: Bearer <bulk token>` | `{hostname, os, arch, agentVersion}` | `201 {ticket, ticketId, expiresAt (RFC 3339), identityCap}`. Refusals: `401`, `409 enrolment_cap_reached`, `410 token_expired`, `403 token_revoked` |
| `POST /v1/endpoint-agent/register` | `Authorization: Bearer <device ticket>` | `{publicJwk (EC P-256, public members), keyProtection hardware\|software, keyProvider tpm\|tpm_ncrypt\|secure_enclave\|file\|dpapi, keyFallbackReason?, agentVersion, os, arch, deviceUser}` | `201 {identityId, clientId}`, where `clientId` is the RFC 9278 thumbprint URI of `publicJwk`; the agent refuses any other. Re-registering the same key is idempotent. Refusals: `401`, `409 ticket_exhausted`, `410 ticket_expired` |
| `POST /oauth/token` | `private_key_jwt` + DPoP | form: `grant_type=client_credentials`, `client_id`, `client_assertion_type` (jwt-bearer), `client_assertion` (ES256, `typ JWT`, `kid` = thumbprint, `iss`=`sub`=client id, `aud` = token endpoint URL, `jti`, `iat`, `exp` = `iat`+60), `resource=<issuer>/v1/endpoint-agent`; header `DPoP` (ES256, `typ dpop+jwt`, `jwk` header, `htm`, `htu`, `iat`, `jti`, `nonce`) | `200 {access_token, token_type: DPoP, expires_in, regulait_credential_rotate_after?}`; `400 use_dpop_nonce` with `DPoP-Nonce`. ES256 must be accepted for kind `endpoint_agent` |
| `GET /v1/endpoint-agent/config` | `Authorization: DPoP <token>` + DPoP proof with `ath` | — | `200 {pack: {manifest, signature, files: {name: base64}}, orgPolicy: {intervalSeconds, disabledKinds}}` (all standard base64). A `401` with `WWW-Authenticate: DPoP error="use_dpop_nonce"` is retried once |
| `POST /v1/endpoint-agent/reports` | as above, plus `Content-Digest: sha-256=:<b64>:` and `Regulait-Report-Signature` | `regulait.endpoint-report/1`: `{snapshotId (UUID v4), collectedAt, agentVersion, os, arch, manifestVersion, manifestDigest, keyProtection, droppedSnapshots, facts[], gaps[], factsDigest}` | `202 {accepted: true, duplicate}`; idempotent on `snapshotId` |
| `POST /v1/endpoint-agent/credentials` | as above | `{publicJwk, proof}`: proof is ES256 by the new key, `typ regulait-key-rotation+jwt`, `jwk` header, `aud` = this route's URL | `201 {identityId, clientId}` of the new key; the old key then mints nothing |

- **Report signature** (new in SD4a; R15 did not specify one). DPoP covers the method, URL and token, not the body,
  so the agent also sends `Regulait-Report-Signature`: a compact JWS by the device key, `typ
  regulait-endpoint-report+jwt`, `kid` = thumbprint, claims `{iss: clientId, aud: <issuer>/v1/endpoint-agent/reports,
  iat, jti, snapshotId, contentDigest}`. The gateway verifies it under the identity's bound key, requires
  `contentDigest` to equal the `Content-Digest` it recomputes over the raw body, `snapshotId` to equal the body's,
  and claims `jti` in its replay store.
- **Facts**: `{kind, signatureId, provider, matchedOn, identifier, location: {root, path}, version?, port?, portOnly?,
  keys?: [{keyName, ruleId?, present}]}`. `root` is one of `home`, `system_applications`, `appdata`,
  `localappdata`, `path` (an absolute PATH directory outside the home), `registry` (`HKCU\…` or `HKLM\…`) or
  `process_table`. `matchedOn` is one of `bundleId`, `desktopId`, `uninstallName`, `extensionId`, `processName`,
  `port`, `processName+port`, `file`, `executable`, `envName`. `factsDigest` is opaque to the gateway (equality
  only, never recomputed). Gaps are `{kind, reason}` with fixed reason codes (`internal/collect/collect.go`).
- Every merged fact maps to `shadow_ai_findings` with signal source `endpoint_agent` and subject kind `device`
  (decision 5a) on the gateway side; SD4b decides the mapping of `signatureId` to `ai_endpoint_signatures` rows.

### Open-source search (ADR-0176)

Recorded in `agents/endpoint/THIRD_PARTY.md`. Used: `go-jose/v4` 4.1.6 (Apache-2.0) for JWS over a
`crypto.Signer`; `golang.org/x/sys` 0.49.0 (BSD-3-Clause); `google/go-tpm` 0.9.8 (Apache-2.0); `gopsutil/v4` 4.26.9
(BSD-3-Clause) on Linux and macOS; `go-tpm-tools` 0.4.11 (Apache-2.0, test only: the reference TPM simulator); `nfpm`
2.47.0 (MIT, build only). Not used: gopsutil on Windows (it links `wmi`, last release 2024-01, and `go-ole`, last
release 2023-08, which fail the 12-month rule; Windows reads Toolhelp and `GetExtendedTcpTable` through `x/sys`);
`howett.net/plist` (last release 2023-10; XML plists are read with `encoding/xml` and binary ones converted by the
OS's `/usr/bin/plutil`); `google/uuid` (one v4 format); osquery embedded (R15 §2.5). Every linked module@version must
be listed: `scripts/check-licences.sh` fails CI otherwise.

### Executed (2026-10-17, Linux x86_64 container, unless marked CI)

- `go test ./...`, and the TPM store against the reference TPM simulator (`go test -tags tpmsim
  ./internal/devicekey/`): create, sign, verify, reload, delete.
- Non-vacuity probes: disabling the pseudonymity guard, the hardware fail-closed rule, the pack signature check, the
  token-file mode check, the JWT RE2 rewrite, the `(unnamed)` key-name rule and the issuer-only transport each made
  its test fail.
- Security-review round (2026-10-17), each probe made its test fail: the local `disabledKinds` narrowing, the Unix
  file-owner check with another uid (run as root), `cleanVersion`, the not-regular-file guard in `readBounded`, the
  absolute-locator refusal, the compiled pack minimum, the env-style key-name rule, the `ELOOP` mapping to
  `token_file_unsafe`, a bulk token or ticket written to the log (`TestSecretsNeverReachLogsOrErrors`), the NCrypt
  status classifier, the Windows DACL write check, and removing `environment: release` or the pull-request guard
  from a signing job.
- Recheck round (2026-10-17), each probe made its test fail: dropping any single bit from the Windows write mask
  (`GENERIC_WRITE`, `MAXIMUM_ALLOWED`, `FILE_WRITE_EA`, `FILE_WRITE_ATTRIBUTES`, `DELETE`, `WRITE_OWNER`) or read mask
  (`GENERIC_READ`, `FILE_EXECUTE`, `GENERIC_EXECUTE`; execute rights count as reads, because an execute mapping can be
  read), trusting INTERACTIVE for writes, the Unix uid check without root (`readChecked` against another uid on a
  file this user owns), the leading-backslash clause of the absolute-locator refusal (`\Windows\x`), and, in the
  workflow guard, a `pull_request_target` trigger, a workflow-level `env` of `toJSON(secrets)`, `secrets['X']` or
  `toJSON(secrets)` in a non-signing job, and a job that calls a reusable workflow (with or without `secrets:
  inherit`). The guard now matches any mention of the `secrets` context outside whole-line comments and checks the
  triggers are exactly `pull_request`, `push` and `workflow_dispatch`. The Windows file-ACL test sets the file's
  owner to the runner's user explicitly, so the user-owned system-file case always runs, and the CI Windows job
  runs `internal/agent` verbosely so its Windows tests are visible in the log.
- `node scripts/check-secret-rules.mjs`: 12 rules and 20 vectors agree with `packages/shared`.
- `scripts/build.sh`: all six targets (7.3 to 8.2 MiB each, stripped). `scripts/package-linux.sh`: `.deb` and `.rpm`
  for amd64 and arm64.
- The amd64 `.deb` installed with `dpkg -i` in the container (no systemd running, no gateway): the postinstall
  created the group, enabled the user unit globally and exited 0 with outcome `config_invalid`; with a config and a
  synthetic token naming an unreachable issuer, `gateway_unreachable`; with the token file made `0644`,
  `token_file_unsafe` and nothing sent. Then purged.
- `regulait-agent preview` against a local manifest on this Linux host.
- **CI only** (the workflow `endpoint-agent.yml` runs them; results are in the PR): the unit tests on macOS (real
  `plutil`, gopsutil) and on Windows (DPAPI round trip, the NCrypt probe, the Toolhelp and TCP tables, registry
  reads), the reproducibility check, and the unsigned macOS `.pkg` build.

### Pending execution, unverified, and deviations

- **Not run on a real macOS or Windows machine** beyond the CI runners: no collector has seen a real installed
  catalogue product, a real browser profile or a real IDE; the Windows uninstall and environment registry paths and
  the macOS LaunchAgent have not run in a user session.
- **NCrypt TPM keys are not run** where a TPM exists (CI runners are expected to report "no hardware"; the test
  skips). The Linux TPM path ran on the simulator only, not on a physical TPM.
- **macOS has no device key in this build** (it refuses; SD4j). The macOS fallback (Keychain) and the Linux Secret
  Service fallback are not built; the Linux fallback is the `0600` file.
- **Signing**: Developer ID signing and notarisation, OV Authenticode through the cloud HSM, and Linux package
  signing are CI jobs that skip with their reason because the accounts, certificate and keys do not exist (owner
  decisions 1 and 2). Pending execution. Owner decision 1 says the identity is kept in "a protected CI secret store
  that only release jobs can use": the three jobs never run for a pull request (`if: github.event_name !=
  'pull_request' && github.ref == 'refs/heads/main'`) and read their secrets from the `release` environment, not from
  repository secrets (security review M1; `scripts/endpoint-agent-workflow.test.mjs` fails if any other job reads a
  secret). **Pending (owner):** the `release` environment's protection (required reviewers, deployment branch `main`)
  is a repository setting that is not in code and has not been configured; GitHub creates the environment unprotected
  on first use. The pack and agent-release keys do not exist either: the compiled pack
  keyring is empty, and no release manifest is verified (self-update is SD4i).
- **No Windows installer.** The MSI needs WiX, whose licence terms R15 asks SD4h to confirm before pinning; the
  per-user logon task is therefore not built, and nothing places the bulk token file's ACL on Windows yet.
- **Windows file check (deviation from the first SD4a build, security review M3).** The first build checked only the
  file type on Windows, so any regular file under `%ProgramData%` was trusted and `token_file_unsafe` could not
  occur there. The agent now fails closed: it reads the owner and DACL of the handle it then reads from, and accepts
  a system file only when it is owned by SYSTEM or Administrators, and the user's state only when owned by that user,
  SYSTEM or Administrators. No other SID may hold any right that writes, appends, deletes or re-permissions the file;
  nobody else may read the bulk token or the user's state; only INTERACTIVE may also read the ticket (R15 §3.2's
  planned ACL); a NULL DACL or an entry type the check does not evaluate is refused. Reparse points and Unix symlinks
  (`ELOOP`) are unsafe files too. Files the agent writes get a protected DACL at creation (SYSTEM, Administrators and
  the writer in full; INTERACTIVE read for the ticket, Users read for the status file). Not covered: the parent
  directory's ACL (a user with delete-child rights on the directory could still swap the file), which the MSI (SD4h)
  must set. The judgement (`judgeWindowsFile`) is unit-tested on every OS; reading real DACLs runs only on the CI
  Windows runner (`TestWindowsFileACLs`), not on a Windows host (pending execution, SD4j).
- **No offline buffer** (SD4f): undelivered snapshots are counted, not kept. `launchctl getenv` for manifest-listed
  names is not read.
- **Windows sees more than Linux and macOS**: the Toolhelp snapshot names other users' processes, so a listener of
  another user matches on its process name there, not on its port only. Only catalogue names are ever reported.
- **The pseudonymity guard can block a device**: a user or host name that equals a catalogue token as a whole word
  stops every upload from that device (fail closed). Posture should show it (SD4b).
- **`product regulait-endpoint-pack`**: `scripts/verify-update-bundle.sh` accepts only `product regulait`, so it does
  not verify packs; SD4g's customer-side verifier is to be built from `internal/pack`.
- **Go 1.27.2**: R15 measured with 1.24, which is out of support; the toolchain is pinned in `go.mod`.

### Open questions for the owner

1. Is the report signature header (above) wanted in addition to DPoP, or should SD4b rely on DPoP and TLS alone?
2. Should a user or host name colliding with a catalogue token block uploads (today), or should the guard drop the
   colliding fact and send the rest?
3. Windows installer: confirm WiX's licence terms, or name another MSI route, so SD4h can build it.

## As built: SD4b (endpoint agent, gateway side)

Built 2026-10-17 on branch `sd4b-endpoint-ingest`. Nothing above is changed. Migration **0207**
(`0207_endpoint_agent_devices.sql`, hand-written; journal idx 207, added by the master after 0204 to 0206 merged).
Code: `apps/gateway/src/endpoint-agent.ts` (contract, bounds, report signature, fact mapping) and
`endpoint-agent-routes.ts` (routes and the ingest job); the admin card is `EndpointAgentCard.tsx` on the Discovery
sources page.

### What it does

- **Strict default.** Every agent route refuses while the `endpoint_agent` discovery source is disabled, and enabling
  it is SD0's `settings_relax` step-up (audited). `endpoint_agent` is now an upload-fed kind (`DISCOVERY_KIND_SPECS`),
  so SD0 never schedules it; its registered scanner observes nothing on "run now".
- **Enrolment (owner decision 3, R15 §3.2).** An admin issues a per-source bulk token (`rgea_` + 64 hex) with a
  required device cap (1 to 100,000; no unlimited default) and an expiry of 1 to 30 days (default and maximum 30: there
  is no lengthening, so no relaxation exists to audit). It is returned once, inside the `regulait.endpoint-enrol/1`
  file MDM delivers; only its SHA-256 is stored, and no audit row holds it. The install step's
  `POST /v1/endpoint-agent/enrolment-tickets` counts one device under a row lock and returns a device ticket
  (`rgat_` + 64 hex, SHA-256 stored, 7 days, 8 identities). Refusals: `401 invalid_token`, `403 token_revoked`,
  `410 token_expired`, `403 enrolment_disabled`, `409 enrolment_cap_reached`, `400 invalid_body`. Reaching 80 % and
  100 % of a cap each writes an audit row (`endpoint-enrolment-cap-80`, `-100`); no alert channel beyond the audit log
  is wired. "Single-use, short-lived" in the build task is met by the ticket: one ticket per redeemed device, 7 days;
  the bulk token itself is the owner's capped fleet token (a cap of 1 makes it single-use).
- **Registration.** `POST /v1/endpoint-agent/register` with the ticket binds the agent's P-256 public key (the TPM,
  NCrypt or DPAPI-protected key SD4a creates; private members refused) through S6's binding path
  (`bindPreparedCredentialTx`: one key, one identity, ever) to a new workload identity of kind `endpoint_agent`
  (migration 0207 widens the 0180 kind and subject CHECKs; admins cannot create one through the identity routes). Its
  steward is the admin who issued the token. Same key again on the same device: idempotent 201. Refusals:
  `401 invalid_ticket`, `403 device_revoked`, `403 token_revoked`, `410 ticket_expired`, `409 ticket_exhausted`,
  `409 device_mismatch` (another OS or architecture than the ticket's device), `409 credential_already_registered`,
  `400 invalid_jwk`, `400 invalid_body` (including hardware protection with a software provider, or a software key
  without its fallback reason). The fallback reason is required and never stored (it can name a device path); posture
  keeps `key_protection` and `key_provider` only.
- **Pseudonyms (decision 20, call 3).** The hostname becomes an SD0 `device` pseudonym at ticket time and the
  self-reported device user a `device_user` pseudonym at registration; display names are enveloped in
  `discovery_pseudonyms` and revealed only through SD0's `pseudonym_reveal` step-up. Neither is stored in clear in any
  SD4b table, reply or audit row (tested).
- **Token and route ceiling.** `endpoint_agent` joins `WORKLOAD_SELF_RESOURCE_PATHS` (`/v1/endpoint-agent`), so S7's
  `client_credentials` grant mints its DPoP-bound self token (ES256 private_key_jwt named by the RFC 9278 thumbprint,
  the same key's DPoP proof, the gateway nonce). It resolves to `via: "endpoint-agent"` and reaches only
  `GET …/config`, `POST …/reports` and `POST …/credentials` (`403 workload_scope` elsewhere). The token endpoint
  and the self-token verifier both read the device on every use: a revoked device answers `device_revoked`, which
  SD4a treats as final.
- **Key rotation.** `POST /v1/endpoint-agent/credentials` is S7 point 4: the proof is a JWS by the new key with `aud`
  this route; the runner's rotation transaction is factored into `rotateWorkloadKeyTx` and shared (two live keys at
  most; the old key mints nothing after). Answer `201 {identityId, clientId}` with the new key's client id.
- **Config.** `GET /v1/endpoint-agent/config` answers `503 collection_pack_unavailable`: the pack signing key and
  stage (SD4g) do not exist, and an unsigned pack is never served. Until then no agent reaches the report stage in a
  real deployment.
- **Reports.** `POST /v1/endpoint-agent/reports` accepts a body only when, in order: the self token verifies and its
  device is live and its source enabled; the raw body is at most 1 MiB (`413 report_too_large`); it parses against the
  strict SD4a schema (at most 2,000 facts, 200 gaps, 50 keys per fact, 512-character identifiers, a UUID v4 snapshot
  id; `400 invalid_body`); its OS and architecture are the device's (`409 device_mismatch`); `Content-Digest` equals
  the SHA-256 recomputed over the raw bytes (`400 content_digest_mismatch`); the `Regulait-Report-Signature` JWS
  verifies under the identity's bound key (ES256 only, `kid` the thumbprint, no embedded key, `iss` its client id,
  `aud` the reports URL, `snapshotId` and `contentDigest` equal to the body's; `400 invalid_report_signature`) and is
  at most 5 minutes old (`400 report_signature_stale`); its `jti` is claimed once in the replay store
  (`400 report_replayed`); and the snapshot was collected within the last day (`422 report_stale`). A retry of a stored
  snapshot with a fresh signature answers `202 {accepted: true, duplicate: true}`. Every refusal is a fixed code with
  no detail, and is audited with ids, the code and the body's SHA-256 only. This answers SD4a open question 1 as
  built: the report signature is required in addition to DPoP (an owner decision may still remove it).
- **Data minimisation (master decision).** An `env_name` fact, and any fact matched on `envName` whatever kind it
  claims, is **refused**: counted in `facts_env_refused` and dropped before anything is stored; the name is never
  stored, logged or echoed (tested with a run-unique name across reports, findings, runs and audit rows; the one log
  line on this route carries an error code only). Key names inside config facts are dropped too. When this was built
  PR #419's presence matcher was not on main. #419 has since merged (`matchEnvNames`, lane A6), and the refusal is
  **kept deliberately** in the review fix round: it is the stricter of the two and needs no catalogue, while mapping a
  fact to its presence signature id (the #419 as-built note above asks SD4b to do that) is a behaviour change that
  waits on owner question 4 below. Of every other fact only the catalogue sighting survives: SD3's own matcher
  (`reduceEndpointObservations`) runs against the enabled catalogue, keeping the matched catalogue value, provider, OS,
  extension ecosystem (read from the root-relative location, which is then discarded) and a count. Unmatched facts are
  counted, never stored or recorded as catalogue gaps (a manifest is built from the catalogue). No path, version, port
  number beyond a matched `port:<n>` value, key name or identifier outside the catalogue is kept.
- **Commit into SD0.** Accepted reports are stored `pending` in `endpoint_agent_reports`; the route then tries to
  commit at once, and the scheduler job `endpoint-agent-ingest` (every 60 s) commits the rest. A commit opens one
  discovery run on the source holding its lease (one live run per source, so replicas never commit a report twice),
  turns the sightings into SD0 observations (`endpoint_agent` evidence, `device` subject = the device pseudonym, the
  device user as `actorPseudonym`, `observedAt` = the snapshot time) and commits them through
  `applyDiscoveryRunObservations`, marking the reports `committed` and stamping the pseudonyms' last-seen time in the
  same fenced transaction. A batch SD0's checks refuse is marked `refused` (never retried forever). A revoked device's
  pending reports are never merged. Device findings and pseudonyms follow SD0's 90-day endpoint retention.
- **Caps under concurrency.** Ticket redemption and registration each lock their token or device row
  (`SELECT … FOR UPDATE`) before checking the cap, and increment the counter in SQL (`devices_enrolled + 1`,
  `identities_registered + 1`), so the `<= cap` CHECKs are a backstop behind the lock. Tested with five concurrent
  redemptions of a cap-1 token and five concurrent registrations on a cap-1 ticket: exactly one succeeds each time.
- **Revocation.** `POST /v1/discovery/endpoint-devices/:deviceId/revoke` (admin, audited `endpoint-device-revoked`)
  revokes the device and each of its identities through S6 (`revokeWorkloadIdentity`: keys and live tokens) and
  writes its audit row in one transaction (review fix round), so a crash midway leaves no identity listed as active;
  from the commit on the device is refused on every route and at the token endpoint. `POST /v1/discovery/enrolment-tokens/:tokenId/revoke` stops new
  tickets and new registrations under the token's tickets; enrolled devices keep reporting.
- **Migration 0207 and the 0185 guard.** Tables `endpoint_enrolment_tokens`, `endpoint_devices`,
  `endpoint_agent_identities`, `endpoint_agent_reports`, every bound CHECKed (digests, pseudonym shapes, caps, the 30-
  and 7-day windows, status). One function, `regulait_endpoint_agent_report_guard`, with
  `SET search_path = pg_catalog, public, pg_temp`: a report's evidence columns are written once and its only change is
  `pending` to `committed` or `refused`. Because that is a row-level UPDATE refusal, the table also has the
  statement-level TRUNCATE refusal (`regulait_refuse_truncate`). The same guard refuses a plain row DELETE (review fix
  round); the one DELETE it admits is the cascade of the row's own identity, device or source once that parent row is
  gone (`pg_trigger_depth() > 1`, the 0182/0186 pattern), so SD0's source deletion still works. Retention deletion of
  report rows, when built, goes through the same cascade or needs its own admitted path.
- **schema.ts matches 0207.** The widened `workload_identities` kind and subject CHECKs carry `endpoint_agent`, and
  the three UNIQUE constraints are declared with `unique()` as the SQL creates them (review fix round).
- **Admin UI.** "Endpoint agent enrolment" card: issue a token (cap required, the enrolment file shown once), list and
  revoke tokens, list devices pseudonymously with each user's key protection (software keys flagged), revoke a device.
  `KNOWN_UI_GAPS` stays 0; the agent's five routes are one machine-only census pattern.

### Open-source search (ADR-0176)

No new dependency. `jose` (already pinned) verifies the report JWS and computes thumbprints; `oidc-provider` and S7's
code do the token grant; `zod` validates bodies. The RFC 9530 `Content-Digest` member is one SHA-256 in the
structured-field byte-sequence form: no maintained module covers only that, and the structured-field parsers found
would add a dependency to format one fixed string. SD3's matcher is reused for detection rather than a new one.

### Executed (2026-10-17, Linux container, no database or Docker)

- `pnpm -r --workspace-concurrency=1 build`: exit 0.
- `endpoint-agent.test.ts` (no database, 15 tests): SD4a's golden bodies parse; bounds refuse; the report signature
  verifies only under the bound runtime-generated P-256 key with the recomputed digest and refuses another device's
  key, a missing signature, a wrong `kid`, an embedded key, another `typ`, another snapshot id, a stale or future
  `iat`, and a tampered body; env-name and key-name never survive the reduction. Non-vacuity: letting `env_name`
  facts through, and removing the `Content-Digest` comparison, each made a test fail.
- Shared discovery, identity and endpoint-discovery suites; the web governance and identity suites; the route-census
  and affordance tests; both UI preflights (0 known UI gaps); the gateway's non-database discovery, OAuth and
  scanner-contract suites.
- **Typechecked only, run in CI** (needs Postgres and migration 0207's journal entry):
  `zz-adr0195-sd4b-endpoint-agent.test.ts` (enrolment off by default and admin-only, the token shown once, the device
  cap, revoked and expired tokens and tickets, idempotent registration and the identity cap, the ES256 self token and
  its route ceiling, accept and merge as an `endpoint_agent` device finding, duplicate, unsigned, wrong-device,
  replayed, stale, oversized and mismatched reports, nothing stored in clear, rotation, revocation stopping uploads and
  minting, the report table's UPDATE and TRUNCATE guard) and the 0185 guard suite over migration 0207. Both ran
  green in CI once the journal entry landed.
- **Review fix round (2026-10-18).** `endpoint-agent.test.ts` grew to 17 tests: the port-identifier check now uses a
  port the catalogue would match, an `envName` match under another kind is refused, and `isUuidV4` refuses v1, v7 and
  a wrong variant. Mutation probes (each reverted): removing the port-identifier check, the `matchedOn === "envName"`
  refusal and the version check in `isUuidV4` each made a test fail. The database suite gained the concurrent cap
  tests, the plain-DELETE refusal with the parent cascade admitted, member refusal on all five admin routes,
  registration under a revoked token, and a v7 snapshot id (typechecked here, run in CI).

### Pending execution, unverified, and deviations

- **Pending execution:** no real agent binary has enrolled against this gateway; no Windows or macOS device has
  redeemed a ticket, registered a TPM, NCrypt or DPAPI key or uploaded a report. SD4a's Go fake
  (`internal/gatewaytest`) and these routes have not been run against each other.
- The collection pack is not served (above), so end to end the agent stops at config today.
- `facts_env_refused` refuses rather than maps `env_name` facts, although #419 has merged (above; owner question 4).
- Rate limiting per identity (R15's `cred:wid:<identityId>` bucket) is not built; the gateway's general limiter
  applies. An org IP allow-list for programmatic credentials (`api_key_ip_policy`) also binds agents.
- `endpoint_agent_reports` rows (digests, counts, catalogue sightings, no personal data) are not yet deleted by the
  endpoint retention pass; their device findings and pseudonyms are.
- Posture rows for agents (devices behind release, software keys) appear only on the devices list, not yet in
  `GET /v1/org/posture`.
- An extension's ecosystem is inferred from its location (`/extensions/` under a VS Code-family or Chromium profile,
  `extensions.json` for Firefox, a `jetbrains` path): an unusual layout matches only ecosystem-neutral rows.
- Re-registration of a device user with a new key creates a new identity within the ticket's cap; R15's
  old-key possession proof for re-registration is not built.

### Open questions for the owner

1. Keep the report signature header required (built), or rely on DPoP and TLS alone (SD4a question 1)?
2. Should an enrolment token's expiry be lengthenable beyond 30 days as an audited relaxation, or stay capped?
3. Should revoking an enrolment token also revoke the devices it enrolled (today it stops only new enrolment)?
4. Now that #419 has merged: map `env_name` facts to presence signature ids with `matchEnvNames` (the name still
   never stored), or keep refusing them (built, the stricter default)?

## As built: A4 remediation plan start (2026-10-17, no migration)

Branch `shadow-ai-remediation-plan`. Owner text above is unchanged; this section records how the remediation plan
(decision 5a: "the remediation plan works unchanged") was made to start a workflow with the discovery subject kinds.

1. **The plan body is the start body.** `GET /v1/shadow-ai/findings/:id/remediation-plan` returns a
   `workflowRequest.body` that `startInstanceSchema` (and the strict change descriptor) accepts as it stands; a gateway
   test posts it to `POST /v1/workflows/instances` unchanged and gets 201. The old `repoPath` shape was already gone
   (#378); A4 completes it:
   - the description names the subject and provider, or only the subject kind ("a device (pseudonymised)") when the
     subject is a pseudonym (`device`, `cloud_principal`, or any `psn:` value), and always ends with the finding
     reference `shadow-AI finding <id>`;
   - `paths` are the repo and the repo-relative `location.path` values of its sightings (decision 6), at most 20. A
     path that climbs (`..`), is absolute, home or drive-rooted (starts with `/`, `\`, `~` or `X:`; it names a
     person), carries a pseudonym, or that the audit scrubber would change (credential-shaped) is dropped. Non-repo findings have no paths: a device's home-relative config path is not a repo path and is personal;
   - `targetSystem` is the subject only when it is not pseudonymised.
2. **Environment, fail closed.** `?environment=` is optional. It must match `^[a-z0-9][a-z0-9_.-]{0,63}$` and be one an
   admin has already given a meaning to: an environment named on a deploy target or a workflow assignment rule. There
   is no shipped list, so with none configured every stated value is refused (400 `environment_not_allowed`, with the
   allowed list). Without it the body keeps `unstated` and `needsInput: ["change.environment"]`. The start route
   applies the same rule to a `shadow-ai-remediation` change: `unstated` in any case is refused (422
   `environment_unstated`), and any other value must match the pattern and the allowed list (422
   `environment_not_allowed`), so a workflow never starts in a placeholder or a made-up environment.
3. **A strict default workflow ships.** `apps/gateway/src/shadow-ai-remediation.ts` holds the template
   `shadow-ai-remediation`: intake, the ADR-0079 plan-only stage, a `shadow_ai_remediation_plan` artifact and a
   sign-off by an admin other than the initiator (point 6). The start route installs it, with a rule on the change
   type, the first time a remediation starts (the ADR-0080 "minted on first use" pattern, so no migration; race-safe
   on the unique template name; audited once as `shadow-ai-remediation-default-installed`). The install runs only
   after that start's own checks pass (environment, project attribution, a second admin exists), so a refused start
   installs nothing. It is never installed:
   - over an admin's decision: when any assignment rule already names the change type (checked inside the install
     transaction), that rule decides alone and the default's stages are never unioned into it;
   - again once the name exists, active or retired.
   An admin relaxes it by retiring the template (`POST /v1/workflows/templates/:id/retire`). For this template the
   retirement also deletes its change-type rule in the same transaction, and the `workflow-template-retired` audit
   row records it (`ruleId`, `ruleIds`). Starts then answer 422 `no_workflow_matches_change` until the admin assigns
   their own template, which then runs alone. Deleting the rule while the template stays active only makes starting
   fail again (stricter, not looser). The plan reports `assignment.defaultTemplate.state` (`not_installed`, `active`,
   `retired`), and `ruleConfigured` counts only rules whose template is active.
4. **The unlinked start is server state.** "Live" below means any status except the three terminals that leave the
   finding unremediated, `denied`, `aborted` and `rolled_back` (one constant, `UNSUCCESSFUL_TERMINAL_STATUSES`, used
   by the plan, the link route and the screen). `completed` is the successful end: it counts as live and stays
   linkable. The plan returns `pendingLink`: the newest live `shadow-ai-remediation`
   instance THE VIEWER started whose description carries the finding reference and that no finding
   links yet. Another user's instance is never offered (they control its description), nor one that is not live. The screen seeds its
   "started but not linked" state from it, so after a reload it still offers only "Retry linking this workflow"; the
   start button and the "link an existing workflow" form stay disabled until the link lands. The screen keeps the
   finding reference on the description whatever the person types. Browser storage is not used.
   The link route (`POST /v1/shadow-ai/findings/:id/remediate`) enforces the same on the server:
   - only the instance's own initiator may link it (403 `not_your_workflow`; the bootstrap token has no user and is
     refused);
   - the instance must be a live `shadow-ai-remediation` workflow whose description carries THIS finding's reference
     (422 `workflow_not_linkable`), and not one already linked to another finding (409 `instance_already_linked`);
   - a link is set once while it stands. A finding linked to a live workflow is refused (409 `already_linked`).
   - the one replace path: when the linked workflow ended `denied`, `aborted` or `rolled_back`, it remediates nothing,
     so a new live workflow may replace it, under every rule above (initiator, change type, reference). The update is
     conditional on the column still holding that dead instance (or `IS NULL` for a first link), so a concurrent
     second link cannot overwrite the first. The `shadow-ai-finding-remediation-linked` audit row records
     `replacedInstanceId` and `replacedInstanceStatus`. A terminal status never changes, so a live link can never be
     replaced. Without this path a denied plan would dead-end the finding for good (only a database edit could free it).
     An admin who wants another user's workflow linked asks that user to link it.
   The plan also returns `currentLink` (`instanceId`, `status`, `replaceable`). The screen keeps start and link
   disabled while the link stands, and says so; when it is replaceable it offers both and says the replace is audited.
   The screen's "link an existing workflow" list offers only live remediation workflows carrying the reference.
5. **Open-source check (ADR-0176).** Nothing new to adopt: validation is zod, queries are drizzle, both already pinned.
6. **Sign-off by a second person (owner question Q1, decided by the master session under ADR-0180; the owner may
   overrule).** The engine had no per-template separation of duties for a workflow sign-off: a `requesting_user`
   approver decides their own gate with a recorded reason (stamped `selfReview`). The default instead names a new
   approver placeholder, `admin_not_initiator` (`apps/gateway/src/workflow-approvers.ts`), with quorum `any`:
   - at the stage it resolves to one approval row per active org admin other than the initiator, so one other admin
     decides it through the existing approvals queue;
   - the decide path refuses the initiator on such a stage by any route (named approver, delegate or admin override),
     keyed on the decider: 403 `initiator_cannot_sign_off`;
   - a start is refused (422 `second_approver_unavailable`) when no other active admin exists, since the stage could
     never be decided.
   An admin who wants the initiator to sign off authors their own template (`requesting_user`) through the existing
   audited template path and retires the default.

**Limits and open points (A4):**
- The `admin_not_initiator` rows are written when the instance reaches its sign-off, from the admins active then. An
  admin added later is not added to a sign-off already waiting, and one demoted later can still decide the row they
  were named on (the existing named-approver rule); the initiator never can.
- `pendingLink` matches on the description text, but only among the viewer's own instances, so another user's
  description cannot steer it.
- The gateway tests for 1 to 4 run against Postgres in CI only (typechecked locally).
