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

## As built: SD0 foundation (2026-10-17, migration 0202)

**Status: built on branch `sd0-discovery-foundation`; the migration journal entry waits for 0201 to merge.** No
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
   - Reveal: a `settings_relax` step-up (`discoveryPseudonymReveal: {pseudonym}`); the audit names the pseudonym, never
     the name.
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
     heartbeat(): Promise<boolean>;  // extends the lease; false = lost, stop
     signal: AbortSignal;            // the lease deadline
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
   attempts left (re-take audited `discovery-run-lease-retaken`); run it (15-minute lease); delete device findings and
   device-user pseudonyms not seen within the endpoint retention (audited). All lease times use the database clock.
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
  An SD0 observation has no field for a sighting's path, line or commit, for `.env.example` names or for a stdio MCP
  server's command, so those are not reported (open question for SD0).
