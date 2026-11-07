# DefenseClaw comparison: adopt, integrate, or learn from

- **Date:** 2026-11-07
- **Type:** research report (docs only; no code, no decision). A decision, if taken, gets its own ADR.
- **Subject:** Cisco DefenseClaw, `cisco-ai-defense/defenseclaw`, release 1.0.8 (2026-11-05). Releases 1.0.4 to 1.0.8
  shipped between 2026-10-27 and 2026-11-05, so the project is moving fast and any detail here can go stale quickly.
- **Method:** I read the public README, LICENSE, NOTICE, the releases page and the documentation site (overview,
  connector compatibility, guardrail, policies, scanning, AI discovery, observability, enterprise, fail modes). I did not
  download, install or run anything. The installer is `curl | bash` and was not touched. The GitHub API was not used.
- **Evidence:** everything below comes from that public material. Claims the docs do not state, or that I inferred,
  are marked **UNVERIFIED**. Nothing was tested hands-on. This report makes no compliance claims for either product.
- **RegulAIt sources:** [PRODUCT_GOALS](../PRODUCT_GOALS.md), [ARCHITECTURE](../ARCHITECTURE.md),
  [PENDING](../product/PENDING.md) §2b P1, ADR-0020, ADR-0066, ADR-0097, ADR-0100, ADR-0101, ADR-0129, ADR-0175 (A6
  skill admission), ADR-0176, ADR-0180 and ADR-0195.

> **Numbering note.** The brief calls the skill scanner "P23". On `main` today, PENDING's P23 is the
> "LICENSE and SECURITY.md absent" item, and skill admission lives in ADR-0175 A6. This report compares against what
> is on `main` (ADR-0175 A6). If a separate P23 skill-scanner item exists on an unmerged branch, the comparison in §2.3
> still applies.

---

## 1. What DefenseClaw is, component by component

DefenseClaw calls itself "security governance for AI coding agents and agentic runtimes" and "an enforcement and
evidence layer". It runs **on the developer's machine**. It is a local gateway that agent hooks call before each
prompt, tool call and tool result, plus scanners for what agents install. It is not a hosted control plane.

| Component | What it does (per the docs) | Notes |
|---|---|---|
| **Go gateway** (`cmd/`, `internal/`) | The decision point. Hooks send each event to it, and it returns allow, alert, confirm or block. Per-user installs use a local port; the enterprise "managed standalone" profile listens on `127.0.0.1:18970`. Proxy connectors use a guardrail proxy on port 4000 by default. | NOTICE lists Bifrost (Apache-2.0, an LLM gateway), OPA, CEL-Go and OpenTelemetry Go among its dependencies. Exactly how Bifrost is used is **UNVERIFIED**. |
| **Connector hooks** | Version-pinned hook "contracts" for Codex, Claude Code, Cursor, GitHub Copilot CLI, Devin, Hermes, Antigravity, OpenCode, Amp and Kiro. Most inspect prompts, tool calls and tool results; some see less (Antigravity sees no prompts or results; OpenCode sees no prompts). | Setup **refuses** a connector version that has no contract. An unknown *newer* version is assumed to work, with a warning. `DEFENSECLAW_ALLOW_HOOK_CONTRACT_DRIFT=1` skips the checks. |
| **Proxy connectors** | OpenClaw and ZeptoClaw are governed through the guardrail proxy instead of hooks (marked "not-gated"). | Linux and macOS only; native Windows does not run the proxy. TLS interception is not described (**UNVERIFIED**). |
| **Guardrail and policy** | Rule packs (`permissive`, `default`, `strict`; custom packs pinned by digest). Regex rules, CEL rules over facts extracted from structured tool calls (commands, paths, network targets) and OPA/Rego. An optional decision model, then an optional LLM judge. The worst severity maps to an action. A human-approval ("ask") step exists only in agents that can prompt. | "Observe mode does not enforce", except that writes to DefenseClaw's own state are always blocked. Regex alone never blocks. The LLM judge can be local (Ollama, vLLM, LM Studio) or remote. |
| **Skill, MCP and plugin scanning** | The skill scanner wraps `cisco-ai-skill-scanner` and checks `SKILL.md` and bundled files for prompt injection, risky shell or Python, and untrusted binaries. The MCP scanner reads tool names, schemas and descriptions and flags tools whose behaviour does not match their claims. Plugins are scanned too. An install watcher scans new assets; rescans run every 60 minutes and when settings change. | Defaults: CRITICAL and HIGH quarantined, MEDIUM warned and queued for review. Deny beats allow. **Scanner failure counts as rejection ("admission fails closed").** A rejected MCP server stays installed, but its tool calls are refused. The docs warn that "the rules alone miss most malicious assets" without the LLM judge. The skill scanner's licence is **UNVERIFIED**. |
| **AI discovery and sensor** | Finds agents, AI CLIs, editor and IDE extensions, MCP servers, skills, plugins, package dependencies, provider domains, running model servers and local models across 16 categories. It has runtime "planes": inference activity, egress attribution and an opt-in record of agent actions (macOS Endpoint Security, Linux `cn_proc`/`fanotify`, Tetragon on managed Linux, the Windows Security log). `aibom scan` writes a JSON AI bill of materials. | Environment variable names are recorded, never their values. Paths are hashed by default. The BOM is "not signed and has no CycloneDX format". The sensor (`internal/sensor/`) is a Go reimplementation of an Apache-2.0 project. |
| **Python operator CLI and TUI** (`cli/defenseclaw/`) | Setup, `quickstart`, `doctor --fix`, scans, discovery and upgrades. | Requires Python 3.10 to 3.13. |
| **TypeScript** | An OpenClaw extension (`extensions/defenseclaw/`), plus other TypeScript the README does not describe. | **UNVERIFIED** beyond the OpenClaw plugin. |
| **macOS app, edge connector, OpenShell sandboxes, ACP guard, segmentation** | Listed in the docs navigation. The edge connector bundles an MQTT client. | Not read in depth; **UNVERIFIED**. |
| **Audit and observability** | Local SQLite `audit.db` keeps every log for 7 days by default; this local history cannot be turned off. Exports go to JSONL, console, Splunk HEC, HTTP JSONL, Prometheus and OTLP (gRPC or HTTP), plus a Galileo trace preset. Records fall into 14 closed buckets (for example `security.finding`, `enforcement.action`, `model.io`), schema family `v8`. Consumers must deduplicate on record ID. Webhook alerts go to Slack, PagerDuty, Webex or a signed generic webhook. | From 1.0.6, rows carry a row hash and signature. **Hash chaining and signing-key management are not described (UNVERIFIED).** Once a destination is on, the default redaction is `none`, so prompts, responses, tool arguments and paths leave as recorded. |
| **Enterprise profiles** | *Managed standalone*: OS services owned by an administrator, deployed through MDM or configuration management, with a hook guardian that restores tampered hooks, a user enumerator and a sensor helper. Users cannot change policy; `config.yaml` is the only policy. *Secure Client*: decisions come **only from Cisco AI Defense** (the commercial cloud service). | The enterprise demo maps Active Directory groups to strict or standard profiles. Okta and Entra ID pages exist but were not read (**UNVERIFIED**). Pricing is not stated. |

### 1.1 Fail modes (the "fail-closed hooks" claim)

- **Fail-closed by default, with conditions.** The README says "hooks fail closed by default". The fail-mode reference
  is more nuanced. On a **per-user** install, when the gateway is down, the `default` and `permissive` packs **let the
  call run with a warning**, and only `strict` blocks. **Managed standalone** defaults to closed, and `open` there applies
  only when the hook can prove the gateway service is stopped. **Secure Client** resolves an unset mode to `open` for
  every connector.
- **These always block:** gateway 4xx or 5xx answers, malformed answers, missing tokens, an unverified listener on the
  gateway port, and a decision that arrives after the hook deadline (managed Codex hooks wait about 3.5 to 4 seconds).
- **Bypasses the docs admit:** shell settings such as `BASH_ENV`, `SHELLOPTS=noexec` or `CLAUDE_CODE_SHELL_PREFIX`
  can stop a shell-form hook from starting, and so can a missing hook script (exit 126 or 127). The call then **runs
  unguarded in every fail mode**. Managed Linux and macOS installs use exec form, which avoids this. A custom
  `DEFENSECLAW_HOME` lets a same-user program redirect a config record.
- **The structural limit:** a hook governs only agents that implement a hook contract, and only at certified
  versions. A tool with no hooks, a raw SDK call or a browser chat is out of scope unless the proxy, discovery or the
  sensor plane catches it.

### 1.2 Air gap and telemetry

| Question | Finding |
|---|---|
| Default telemetry to Cisco? | None stated. "With no destination configured, nothing leaves the computer", and the default `observability: {}` exports nothing. Whether the binary contacts any other host (an update check, for example) is **UNVERIFIED**. |
| Exceptions | `agent discover` emits **sanitized telemetry by default**; `--no-emit-otel` keeps it local. Where that goes with no destination configured is **UNVERIFIED**. On managed devices, records can go to the AI Defense destination. |
| Can the decision path run offline? | Probably, for the standalone profile: regex, CEL and OPA rules run in the local gateway, and the judge can be a local model. The docs never say "air-gapped" (**UNVERIFIED**). The Secure Client profile cannot run offline, because Cisco AI Defense makes its decisions. `--scanner-mode remote|both` also calls Cisco AI Defense. |
| Install and upgrade offline? | Install is `curl | bash` from GitHub releases, and `defenseclaw upgrade` runs the latest release's installer. An offline or mirrored install path is **UNVERIFIED**. |
| Supply chain | `checksums.txt` is signed with Sigstore (keyless, by the release workflow), and 1.0.8 adds attestations and SBOMs per tarball. The macOS app is ad-hoc signed and **not notarized**. The 1.0.4 enterprise macOS package was not Developer ID-signed, and the 1.0.4 Windows enterprise setup was **not Authenticode-signed**. Later releases do not say (**UNVERIFIED**). |

---

## 2. Feature by feature against RegulAIt

The two products sit at **different interception points**. RegulAIt governs calls that **reach its gateway** (server
side, per user, per project, per budget). DefenseClaw governs what an agent **does on the machine** (client side,
through hooks). Most rows below compare things that complement each other, not like with like.

| Area | RegulAIt (on `main`) | DefenseClaw | Verdict |
|---|---|---|---|
| **2.1 Gateway** | A server-side control plane. OpenAI- and Anthropic-shaped endpoints are translation shims over one governed dispatch core (ADR-0020). Per-user default-deny entitlement, virtual keys with narrowing-only allow-lists, project budgets, pillar-6 optimisation, PII handling, provider fallback that never retries a denial (ADR-0066), and one audit transaction per call. Multi-tenant, with row-level security. | A **local, single-machine** gateway that answers hook questions, plus a guardrail proxy for two agent runtimes. It has no project, budget, cost attribution, model routing or tenant model. Per-user identity exists only as OS and AD-group mapping on managed hosts. | Different jobs. RegulAIt is the **organisation** control plane; DefenseClaw is a **device** policy point. |
| **2.2 MCP admission** | ADR-0097 scans upstream manifests (names, descriptions and **nested input-schema descriptions**) before any tool reaches a model, and holds risky servers for admin review. ADR-0100 re-scans on a schedule. ADR-0101 imports federated registries without granting anything. ADR-0129 gives every `tools/call` exactly one attempt. ADR-0043 guards egress. **Only HTTP (URL) MCP servers; there is no stdio transport** (ADR-0101). | Scans MCP servers **installed on the machine, including stdio servers**, by starting them under the user's account. Flags a mismatch between a tool's description and its behaviour. Deny beats allow. A scanner failure counts as rejection. A rejected server stays installed, but hooks refuse its tool calls. Rescans hourly. | Comparable depth on manifests. **DefenseClaw reaches local stdio MCP servers, which RegulAIt cannot.** RegulAIt's held-for-review state, audited admin override and registry federation are org-level features DefenseClaw does not describe. |
| **2.3 Skill scanning** | ADR-0175 A6: every skill save runs the ADR-0097 rules plus look-alike-letter and exfiltration-URL detectors. A high finding refuses the save; a medium finding holds the skill until an admin admits it with a reason. Release-age cooldown (A5). Digests are recorded per builder step. Covers skills in **RegulAIt's own library** only. | Scans skills and plugins **as agents install them on disk**, using `cisco-ai-skill-scanner`, an optional LLM judge and quarantine to a folder. | Similar rule shape. DefenseClaw covers the **endpoint skill folders** that RegulAIt never sees. |
| **2.4 Runtime inspection** | The ADR-0042 guardrail engine scans tool arguments and results at `governedToolCall`, and PII rules run on model input and output. All of this applies **only to traffic through the gateway**. | Inspects prompts, tool calls (with shell, path and network facts extracted for CEL rules), tool results and model I/O, **on the device**, before the call runs. Human approval exists only where the agent can prompt. A session correlator flags findings after the fact. | DefenseClaw sees **local tool execution** (shell, file writes) that never touches a model API. RegulAIt sees nothing that bypasses its gateway. |
| **2.5 Hooks** | **None.** RegulAIt redirects tools to its gateway with a base-URL change (ADR-0020). Nothing on the machine forces that redirect (PENDING P1). | Its core mechanism: version-certified hook contracts for about ten coding agents, a hook guardian that restores tampered hooks, and a clear fail-mode matrix. | **The biggest single gap on our side.** |
| **2.6 Audit** | A hash-chained audit log (`audit-chain.ts`), anchored to Object Lock storage, with one chain for every governed call type. Evidence formats are RegulAIt's own. Retention follows the compliance cascade. | Local SQLite with 7-day default retention. Per-row hash and signature from 1.0.6; chaining is not described. Exports to OTLP, Splunk HEC and JSONL. Exported redaction defaults to `none`. | RegulAIt's chain is the stronger evidence store. DefenseClaw's **export** is a clean ingest source (OTLP or JSONL). |
| **2.7 Endpoint coverage (P1, ADR-0195)** | Discovery only. A signed osquery pack plus MDM or EDR importers, and a **read-only** RegulAIt-signed Go agent (`agents/endpoint/`, SD4a) that reports to the org's gateway. **No enforcement on the device.** | Discovery (16 categories, runtime planes, AI BOM) **and** enforcement (hooks, admission, quarantine) on Windows, Linux and macOS, deployed through MDM under the managed profile. | DefenseClaw ships today, in open source, what PENDING P1 describes as unbuilt. |

## 3. Gaps on each side

**What DefenseClaw does that RegulAIt lacks**
1. **On-device enforcement** through agent hooks, covering prompts, tool calls and tool results, with a fail-closed
   managed profile and a tamper guardian. This is PENDING P1.
2. **Governance of local tool execution**, such as shell commands and file writes, that never touches a model API.
3. **Admission of stdio MCP servers, skills and plugins installed on the device**, with quarantine.
4. **Per-agent, per-version hook contracts**, so setup refuses an uncertified agent version instead of failing open
   silently. This is a useful design pattern in its own right.
5. **Runtime sensor planes** (process, egress and action attribution) on three operating systems.
6. **Standard telemetry export** (OTLP, Splunk HEC) from the edge, plus Grafana dashboards.

**What RegulAIt does that DefenseClaw lacks** (per its public docs)
1. **An organisation control plane**: multi-tenant, per-user default-deny entitlements managed centrally, admin
   portal, role builder, step-up and separation of duties.
2. **Cost attribution, budgets and optimisation** (pillars 5 and 6) at the point of each call.
3. **Workflow governance** (pillar 2), multi-agent orchestration with inherited ceilings (pillar 7) and PM-tool
   integration (pillar 8).
4. **A hash-chained, anchored audit trail** spanning model, connector and MCP calls, with evidence packs and
   compliance-cascade retention.
5. **Provider-agnostic routing** with virtual keys and fallback chains that never retry a denial.
6. **Org-level discovery** across code repositories and AWS, GCP and Azure accounts (ADR-0195), not just endpoints.
7. **A vendor-neutral position.** DefenseClaw's enterprise Secure Client profile hands decisions to Cisco AI Defense,
   a commercial Cisco service.

## 4. Options

### (a) Adopt as a component: DefenseClaw's hooks or Go gateway as the P1 endpoint enforcer

- **What it means.** Ship DefenseClaw (or a fork) in our MDM bundle, and write the policy from RegulAIt's control
  plane into its `config.yaml` and `asset_policy` (for example by extending our read-only Go agent to render them).
- **Effort.** Medium to start, high to keep. We would need a policy compiler from RegulAIt entitlements to its rule
  packs and lists, signed policy delivery, mapping of identities to users, and audit ingest. On top of that, we would
  track a release stream that shipped five versions in nine days, with hook contracts pinned per agent version.
- **Risks.**
  - *Licence (blocking as it stands).* The project is Apache-2.0, but NOTICE lists **EPL-2.0** Eclipse Paho MQTT code
    (Go client and an embedded C client in the edge connector) and a **GPL-2.0** e2fsprogs fallback bundled in the macOS
    package. ADR-0176 forbids EPL and GPL in shipped code. A fork would have to prove those parts are not in the
    artefacts we ship. Which binaries link Paho is **UNVERIFIED**.
  - *ADR-0176 "validated" tests.* An air-gapped install path is unverified, and the auto-upgrade uses `curl | bash`.
    The enterprise macOS and Windows packages were unsigned or not notarized as recently as 1.0.4.
  - *ADR-0180 (secure by default).* Per-user installs fail **open** under the default rule pack, and Secure Client
    resolves an unset mode to open. We would have to pin every setting to its strict value and test that pinning.
  - *Architecture.* Its policy model (rule packs, AD groups, a local file) is not our per-user entitlement model, so
    two policy languages would drift.
  - *Ownership.* We would ship a competitor's security code inside our trust boundary and inherit its CVEs on its
    release schedule.
- **Licence and NOTICE obligations.** Apache-2.0 section 4: include the licence, carry the NOTICE text forward
  (including its third-party attributions), mark changed files, and list it in `THIRD_PARTY.md` with a pinned version.
  Its Cisco trademarks (Apache-2.0 section 6) cannot be used to brand our client.
- **Strategic position.** DefenseClaw is open-source distribution for Cisco AI Defense, and its enterprise profile is
  the upsell. Adopting it makes our endpoint story depend on a vendor whose commercial product competes with ours, and
  whose roadmap we do not control.
- **What the customer sees.** "RegulAIt's endpoint client is DefenseClaw underneath." Customers who already run Cisco
  may like that; others will ask why a Cisco agent is on their machines. Support boundaries blur.

### (b) Integrate: customers run DefenseClaw, and RegulAIt ingests its audit export

- **What it means.** Add an ingest source that accepts DefenseClaw's OTLP logs, or HTTP JSONL, into RegulAIt. Map its
  14 record buckets (`security.finding`, `enforcement.action`, `ai_discovery`, `ai_component.*` and the rest) onto our
  audit chain as **attributed third-party evidence**, and its discovery records onto the ADR-0195 findings and
  catalogue, as a new upload-fed or push-fed kind. Optionally, a later step publishes RegulAIt policy as a DefenseClaw
  `asset_policy` file the customer deploys through their own MDM, with no code of theirs in our artefacts.
- **Effort.** Low to medium. This is one ingest adapter beside the existing ADR-0071 and ADR-0195 importers, a
  signature or mTLS-checked receiver (webhook replay protection per the security checklist), and deduplication on
  record ID (their docs require it). The policy-file export is a separate, optional slice.
- **Risks.**
  - Their schema is `v8` and changing quickly, so the adapter needs a pinned schema version and drift tests.
  - Exports default to `redaction: none`, so the receiver must scrub before storing (ADR-0102 and ADR-0233 rules) and
    we should tell customers to turn redaction on.
  - Evidence quality: their rows are not chained, so we record them as received third-party evidence with a source
    digest and never present them as RegulAIt-enforced decisions.
  - Customers without DefenseClaw get nothing from this option.
- **Licence and NOTICE.** None. We ship none of their code. Reading a documented export format carries no licence
  obligation. Naming the product in our docs is nominative use only.
- **Strategic position.** RegulAIt stays the **system of record and policy owner**, and DefenseClaw becomes one more
  sensor, as osquery is today. This fits our provider-agnostic principle and does not depend on Cisco's roadmap.
- **What the customer sees.** "Already running DefenseClaw? Point its OTLP export at RegulAIt, and its endpoint
  decisions appear in the same audit trail and findings as your gateway calls."

### (c) Learn only: a clean-room build of P1, informed by its design

- **What it means.** Build P1 inside our existing Go agent (`agents/endpoint/`, ADR-0195 SD4a), turning it from
  read-only to enforcing. Take the *ideas*, not the code:
  - per-agent, per-version **hook contracts** that refuse uncertified versions;
  - **exec-form** hook registration, so shell variables cannot stop the hook;
  - a **hook guardian** that restores tampered hooks;
  - a fail-mode matrix that is **closed by default** on managed hosts, with no shell variable able to widen it;
  - admission that **fails closed on scanner error**, with deny beating allow;
  - an hourly rescan;
  - a **local decision cache** with signed policy pulled from our control plane, which is the "honest offline mode"
    P1 asks for.
- **Effort.** High: multiple batches. Hook adapters for each target agent are the long tail, and each needs its own
  contract tests and upkeep as agents change. A first slice could cover two agents (for example Claude Code and
  Cursor), with the rest added on demand.
- **Risks.** It takes longer to reach coverage. Hook surfaces change often, which is exactly why DefenseClaw keeps
  version contracts. Clean-room discipline: whoever builds it should work from the public docs and this report, not
  from DefenseClaw's source. Apache-2.0 would allow copying with attribution, but keeping the code ours avoids NOTICE
  drift and keeps the design ours.
- **Licence and NOTICE.** None, if no code is copied. If a specific open-source component is chosen under ADR-0176
  (OPA, CEL-Go and fsnotify are all permissive), it is pinned and listed in the usual way.
- **Strategic position.** The strongest. Enforcement decisions come from **the same per-user entitlement model** that
  governs the gateway, so device and server cannot disagree. Audit lands in one chain. No dependency on a competitor.
- **What the customer sees.** One RegulAIt client (the endpoint agent they may already deploy for discovery) that now
  also enforces, using the same users, roles and approvals as the console.

## 5. Recommendation

**Do (c), with (b) as a cheap early step. Do not do (a).**

1. **Now (small):** build (b), a DefenseClaw ingest adapter (OTLP or HTTP JSONL to findings and third-party audit
   evidence). It costs little, ships no foreign code, and covers customers who already run DefenseClaw while P1 is
   unbuilt. It also gives us a real data feed to test our endpoint evidence model.
2. **P1 itself:** build (c) clean-room in `agents/endpoint/`, using the design lessons listed above. Before writing
   any code, write the ADR-0176 search record. This report counts as one candidate reviewed, rejected as an embedded
   component for the reasons in (a).
3. **Not (a):** EPL and GPL parts in its shipped artefacts, an unverified air-gap install, per-user fail-open
   defaults, a second policy language, and a competitor's commercial upsell built into the enterprise profile together
   outweigh the time saved.

**What would change this recommendation**
- **Towards (a), or a hybrid:** DefenseClaw documents a **pluggable remote decision endpoint**, similar to how the
  Secure Client profile delegates to Cisco AI Defense, that a third party may implement. RegulAIt could then be the
  decision backend for its hooks with no fork, which would turn (a) into "integrate at the decision layer". This would
  also need: a shipped binary set verified free of EPL and GPL code, signed and notarized enterprise packages, and a
  documented offline install.
- **Towards (b) only:** customer evidence that our target buyers already standardise on DefenseClaw or Cisco AI
  Defense, so that building our own enforcer duplicates what they run.
- **Towards a faster (c):** a buyer requires on-device enforcement for a deal, which would move P1 ahead of other
  post-demo work.
- **Against all of this:** if DefenseClaw's licence changes away from Apache-2.0, or its export schema stops being
  documented, (b) loses its basis and only (c) remains.

## 6. Open questions (not decided here)

- Should P1's first slice target hooks (agent-specific) or a local egress proxy (agent-agnostic)? DefenseClaw does
  both, and the trade-off deserves its own ADR.
- Does the ingest adapter in (b) become a new ADR-0195 discovery kind, or an ADR-0071 format adapter?
- The PENDING numbering for the skill scanner ("P23" in the brief, against PENDING's P23 on `main`) should be
  reconciled by the master session.
