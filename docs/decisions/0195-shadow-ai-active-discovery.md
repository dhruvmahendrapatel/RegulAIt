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
    `classifyProviderOpen`, unit-tested on every OS).
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
