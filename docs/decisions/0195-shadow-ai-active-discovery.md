# ADR-0195: Shadow AI active discovery: code repos, AWS, GCP, Azure and user machines

- **Status**: Accepted
- **Date**: 2026-10-17
- **Amends**: ADR-0055 (shadow-AI discovery) and ADR-0083 (first-party discovery). Their "evidence only, no
  collectors" stance and ADR-0083 §1's refusal of endpoint collection are superseded by this ADR. Everything they
  built stays: the catalogue, imports, raw adapters, paste-in classifier, MCP discovery, findings, dispositions and
  the remediation plan.

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
   scope, and is audited. Disabling one is free. Every scan run is audited with its source, scope, counts and
   outcome.
2. **Endpoints: both options are offered.** The customer chooses per org:
   - **(a) No agent.** RegulAIt ships a signed osquery query pack that the customer deploys through their own MDM or
     EDR, plus importers for the osquery results and for MDM or EDR inventory exports.
   - **(b) RegulAIt endpoint agent.** A RegulAIt-signed, read-only agent the customer distributes through their MDM.
   Either can be enabled alone, or both.
3. **Cloud credentials: federated and static are both allowed.** Federated, short-lived credentials are the default
   and need no relaxation: AWS role assumption with an external ID, GCP workload identity federation, and Azure
   workload identity federation or managed identity. Static credentials (an AWS access key, a GCP service-account
   key file, an Azure client secret) are allowed as an admin relaxation under ADR-0180: storing one is a
   `settings_relax` step-up, the secret is encrypted at rest with the existing data key, it is never returned by any
   route, enforcement posture shows every source that uses one, and the UI warns once the secret is older than 90
   days (the age is configurable, and lengthening it is a relaxation).
4. **Built in RegulAIt.** No other suite module owns this capability (owner, 2026-10-17).

### Shared rules for every scanner

5. **Findings go into the existing model.** Every scanner writes `shadow_ai_findings` through the same merge-by-usage
   path as imports, so repeat sightings merge, and dispositions, risk-register feed and the remediation plan work
   unchanged. New evidence kinds: `repo_scan`, `cloud_inventory`, `cloud_audit_log`, `endpoint_osquery`,
   `endpoint_inventory` and `endpoint_agent`.
6. **Data minimisation.** No scanner stores file contents, prompt or response content, or a full secret. A detected
   key is kept only as the existing 8-character redacted prefix plus where it was found (repo, path, line, commit;
   or device and config file). Repo scanners keep only the matched signature, path and line. Raw scanner output is
   digested (SHA-256) and discarded, like pasted content today.
7. **Credentials.** Scanner credentials live in a dedicated table, encrypted with the data key, scoped to one
   source, never returned, and rotated or revoked by admins (revoking is free; replacing is the same step-up as
   adding). Git-provider credentials reuse the provider's read-only scopes; a credential that grants write scopes
   is refused where the provider lets us check.
8. **Egress.** Every outbound scanner call goes through `guardedFetch` and the egress allow list (ADR-0034, with the
   ADR-0034 D4 step-up for new hosts). Cloud and git-provider API hosts are added by the admin when the source is
   enabled, not shipped pre-allowed.
9. **Scheduling and runs.** Sources run on an admin-set schedule (default daily; a shorter interval is not a
   relaxation) and on demand. Runs are leased rows with expiry, as the workflow engine does (REL-06), so a crashed
   worker's run is retried, never lost or doubled. Each source is rate-limited per provider and backs off on 429.
10. **Air-gapped mode.** Repo scanning works against self-hosted git. Cloud scanning works only through the
    customer's private endpoints for the cloud APIs; with none configured the cloud sources stay disabled with an
    honest "unreachable in air-gapped mode" state. Endpoint options work unchanged.
11. **Open source first (ADR-0176).** Cloud scanners use the official SDKs (AWS SDK for JavaScript v3, Apache-2.0;
    `@google-cloud/*`, Apache-2.0; `@azure/*`, MIT). The repo scanner evaluates syft (Apache-2.0) for dependency
    inventory and gitleaks rules (MIT) for key detection, provided each runs air-gapped from a pinned artifact;
    the builder records what it found. The endpoint query pack uses osquery (Apache-2.0 / GPL-2.0 dual licence;
    RegulAIt ships only queries, not osquery itself).
12. **No vendor-named presets.** The refusal of vendor-named CASB or SWG scrapers (PENDING) stands. MDM and EDR
    exports come in through a generic mapped importer, as `generic_mapped` does today.

### Code repos

13. Extend `packages/git-provider` with read-only `listRepos`, `getTree` and `readFile` for GitHub, GitLab,
    Bitbucket and Azure DevOps (provider-agnostic, as pillar 2 requires).
14. The scanner reads the default branch head of each repo in scope. It checks dependency manifests (npm, PyPI,
    Go, Maven, Gradle, NuGet, RubyGems, Cargo), source imports, AI tool configuration files (for example MCP server
    configs, coding-assistant instruction files and `.env.example` names), and AI provider key patterns. Scanning
    history is an admin relaxation (step-up), off by default.
15. The catalogue gains coding-assistant signatures, closing PENDING S17 (GitHub Copilot and the other assistants
    that leave config files or packages behind).

### Cloud accounts

16. One `CloudScanner` interface with three adapters, each listing only AI services:
    - **AWS:** Bedrock (custom and imported models, provisioned throughput, agents, knowledge bases, guardrails,
      model-invocation logging settings), SageMaker endpoints and models, and CloudTrail `InvokeModel`,
      `InvokeModelWithResponseStream` and `Converse` events grouped by calling principal.
    - **GCP:** Vertex AI endpoints, models and deployed indexes through Cloud Asset Inventory, and Cloud Audit Logs for
      `aiplatform.googleapis.com` and `generativelanguage.googleapis.com`.
    - **Azure:** Cognitive Services accounts of kind OpenAI or AIServices and their deployments through Azure Resource
      Graph, and activity and diagnostic logs for those accounts.
17. The read-only role or permission set each adapter needs is published as a document and as IaC snippets the
    customer applies in their own account. RegulAIt never creates IAM in a customer account.

### User machines

18. **No-agent option.** The signed query pack covers installed AI desktop apps, IDE extensions, browser extensions,
    local model runtimes and their listening ports, AI CLIs, and the names (never values) of AI-related environment
    variables and config files. Results are imported as `endpoint_osquery`; MDM or EDR inventory exports as
    `endpoint_inventory`.
19. **Agent option.** The agent collects the same facts as the query pack and nothing more. Explicit non-goals: no
    keystrokes, screenshots, clipboard, file contents, prompt or response content, or browsing history. Key values
    are redacted on the device before anything is sent. It enrols with its own workload identity using the ADR-0188
    S7 pattern (its own key, DPoP-bound tokens, rotation), sends only to the org's gateway, and verifies signed
    releases before any update. The customer distributes it through MDM; RegulAIt never installs it.
20. **Privacy.** Device users are pseudonymous by default (a keyed hash, per tenant); revealing a name is an admin
    action with step-up and audit. RegulAIt ships an employee-notice template. Employee-monitoring and privacy law
    (for example GDPR and works-council rules) varies by country: as with ADR-0193 Art. 50, RegulAIt makes no
    compliance claim and recommends the customer takes legal advice before enabling either endpoint option.

### Slices

- **SD0 Foundation** (migration 0202): discovery sources, scanner credentials, scan runs and schedules; the new
  evidence kinds; enable and credential step-ups; posture rows; an admin "Discovery sources" page; the scan worker
  with leased runs.
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
- Follow-ups: browser-extension and SaaS OAuth-grant discovery through IdP APIs remain out of scope here; IGA-owned
  identity discovery stays refused (PENDING).
