# Gap analysis — DarkControl "AIDR: EDR & compliance for AI agents", 2026-11-17

**Status:** research snapshot, written 2026-11-17 at the owner's request ("another competitor whose features we need to
evaluate and build"). It adds DarkControl to the competitor list in [MARKET_ANALYSIS_2026-11.md](MARKET_ANALYSIS_2026-11.md)
§1.4, next to [GAP_ANALYSIS_OBSIDIAN_2026-11.md](GAP_ANALYSIS_OBSIDIAN_2026-11.md) and
[GAP_ANALYSIS_CAMUNDA_2026-11.md](GAP_ANALYSIS_CAMUNDA_2026-11.md). The closest earlier comparison is
`internal/reviews/2026-11-07-defenseclaw-comparison.md`, which reviewed a product in the same endpoint category.

**Sources and honesty rules.** Primary sources, read 2026-11-17: `https://darkcontrolai.com/` (home),
`https://darkcontrolai.com/platform.php` (platform tour), `https://darkcontrolai.com/features.php` (plans) and the
summaries of `risk-checker.php`, `compliance-checker.php`, `rule-generator.php` and `landing.php?sector=banking`, all
found through the site's `sitemap.xml`. The site has **no public docs, pricing figures, security or trust page, or blog**:
`/pricing.php`, `/docs/`, `/security.php`, `/trust.php` and `/blog/` all return 404. **No GitHub presence was found.** The
GitHub accounts named `DarkControl` and `DarkControl-AI` are not linked from the site, and their repositories
(Vietnamese-language "Gemini" projects and a Roblox project) are unrelated to the product. Everything below is the
**vendor's own claim**. The vendor itself says the console views on its pages are "illustrative and show sample data". It
also claims membership of the OpenAI Partner Network and the Claude Partner Network, which was not verified. No customer
names, certifications or headcount appear on the pages read. The listed contact details are a Madrid (+34 91) phone
number and an `en_GB`/`es` site. "RegulAIt status" is checked against `origin/main` (9aa539679) and the open PRs named. A
PR number means the work is in flight and not yet merged.

## 1. What DarkControl sells

DarkControl calls itself **AIDR** (AI detection and response), an EDR-style product for **AI coding agents on developer
machines**. These are Claude Code, Codex, Cursor, GitHub Copilot, OpenCode, Google Antigravity, Grok Build and OpenClaw.
A lightweight agent for Windows, Linux and macOS sits "between the AI agent and the operating system". It checks in
every five minutes, pulls the current policy and updates itself. It enforces through each tool's native policy file
where one exists, and through its own hook where it does not. It is not a gateway, and it does not see or route model
traffic.

| Area | Vendor claim (summarised) |
|---|---|
| Policy | Command, file (read vs write) and package (npm, yarn, pnpm, pip, apt, brew) rules, each with an **Allow / Ask / Deny** verdict. Policies are assigned to the organisation, a department, an endpoint group or one endpoint, and the most specific assignment wins. A "resolve effective policy" view, twelve templates, conflict detection that refuses catch-all allows, and JSON import and export. |
| Backtest | Before a rule goes live, a dry run matches it against the commands agents actually ran in the last 7, 30 or 90 days. |
| Restrictions | Deny an AI tool per department, or limit it to approved models by ID, prefix, family or pattern. |
| Egress | Domain, URL or regex allow and deny rules for what agents reach from their commands. CSV import and export, and a tester. The vendor states it is "not a replacement for a network firewall". |
| JIT exceptions | Lift a deny or ask rule on one endpoint for 15 minutes to 3 days (extendable to 7). A reason is mandatory, the rule reverts automatically, and the change is audited. |
| MCP inventory | Per-tool, per-user discovery of MCP servers, with a **0–100 risk score** and itemised findings (unpinned npx, embedded credentials, command execution, steering text). Approve, deny or hold servers by name, command, URL or fingerprint. |
| Permission modes | Shows where bypass or auto-approve mode is configured and which sessions actually ran that way. Deny-bypass and deny-auto-approve rules per tool. |
| Secrets exposure | Report of plaintext credentials in agent config files: file, setting, type and length, with the value kept on the device. Detects the same credential reused across endpoints. Report only. |
| Tamper detection | Fingerprints the managed policy files every few seconds. On a change it reports with a severity and **restores** the policy. It also reports a stopped agent. |
| Sessions | Turns, tool calls, file operations and verdicts grouped per session, with subagents shown separately. A timeline, relationship graph and process tree. Capture depth per organisation: metadata, prompt hashes or prompt content. On-device secret redaction. |
| Token usage | Input and output tokens per session, tool and endpoint, read from each tool's own usage records. Shows "not reported" when a tool does not provide them. |
| Response | Workflow graph: one trigger, conditions, then actions. Versioned, with dry run and run history. Triggers include denial spikes, tamper, credentials in a session, token spikes and endpoints that stop checking in. Actions include **quarantining an endpoint** (AI tool use suspended for a set time, with a per-run limit), Teams, HTTPS webhook, syslog and changing group membership. |
| Evidence | A 0–100 posture score (licence health, rule coverage, agent liveness, governance) and a checklist mapped to SOC 2, CIS and ISO 27001. An **EU AI Act register of 16 deployer obligations**: 9 "observed by DarkControl" and 7 "recorded by an administrator", each with an evidence reference and a review date. A field-level before/after audit trail. A 7- or 30-day executive PDF and a risk ranking of endpoints. |
| AI analysis | On-demand anomaly review and rule recommendations backtested on the customer's history, "on DarkControl's own GPU infrastructure". |
| Deployment | A one-line install with single-use tokens and an Intune guide. Enterprise customers get a dedicated instance with its own database. Entra ID SSO, per-org retention with an audited daily purge, and SIEM delivery over syslog or HTTPS. |
| Plans | Observability (7-day watch-only trial, 10 devices), Team, Business and Enterprise. No prices are published. Most exposure, restriction and response features are Enterprise-only. |
| Lead magnets | A risk checker (8 questions, mapped to OWASP, MITRE ATT&CK, NIST CSF 2.0 and CIS), a compliance checker (6 questions, mapped to the EU AI Act, NIS2, DORA, SOC 2, ISO 27001 and ISO/IEC 42001) and a rule generator (116 rules in 10 packs, output in each agent's own permission-file format). Sector landing pages cover banking, legal, insurance, healthcare, government, defence, energy and telecom. |

The vendor's own caveat: "Rule matching is textual. DarkControl is a guardrail for AI agents and complements, not
replaces, your operating system and network controls." Its coverage table also admits gaps, for example Cursor has no
file, model or MCP enforcement.

**Where it overlaps us:** pillar 1 at the endpoint edge. This is the "calls that bypass the gateway" surface that
ADR-0020 named and that ADR-0298 and ADR-0330 began to cover, plus shadow-AI discovery (ADR-0195, ADR-0259, ADR-0332).
DarkControl has no workflow engine, no cost attribution or budgets, no token optimisation, no orchestration and no
PM-tool integration.

## 2. Capability-by-capability parity

| # | Capability | RegulAIt status | Evidence | Gap |
|---|---|---|---|---|
| 1 | On-device enforcement of coding-agent **shell commands** (Allow / Ask / Deny) | **Gap** | ADR-0298, ADR-0330; `agents/endpoint/internal/enforce/` | Our hook adapters (Claude Code, Cursor, Copilot CLI, Codex) decide **MCP tool calls only**. Built-in `Bash`/`shell` gets "no decision" by design, and the fixtures test exactly that. Both ADRs are Proposed, built and default off. No policy verifies until the SD4 signer lands (owner-blocked). |
| 2 | On-device **file** (read/write) and **package-manager** rules | **Gap** | ADR-0298 §1, ADR-0330 §1 | Adapters never decode tool arguments. Gateway-side data scope (ADR-0143) covers only governed calls. |
| 3 | Policy precedence org → department → endpoint group → endpoint, with a "resolve effective policy" view | **Partial** | ADR-0014, ADR-0038, ADR-0310 | Per-user role bundles with overrides, IdP group mapping, and managed-settings bundles per user or role (ADR-0310). There are no endpoint groups or device-scoped assignment, because our subject is the person, not the machine. |
| 4 | Backtest a rule against 7, 30 or 90 days of real activity | **Have** | ADR-0059, ADR-0120, ADR-0073 | Simulation against recorded transcripts and blast-radius preview, plus a canary shadow pass on live traffic. It covers gateway-mediated calls, not on-device commands (we do not record those). |
| 5 | Tool and model restrictions per department | **Have, ahead** | ADR-0014, ADR-0310, ADR-0020 | Default-deny per-user agent and model entitlement at the gateway, with vendor managed settings compiled from it (ADR-0310). The gateway routes and costs the call, rather than only blocking it. |
| 6 | Network and egress allow/deny rules | **Partial** | ADR-0034, ADR-0043, ADR-0062 | Egress guard and mode-scoped egress for the **control plane and gateway**. Endpoint egress is the "proxy slice" ADR-0298 left for a later ADR. Nothing inspects a coding agent's commands for destinations. |
| 7 | Time-boxed JIT exceptions per endpoint, with reason and auto-revert | **Partial** | ADR-0018, ADR-0104, ADR-0105, ADR-0182 §6 | Payload-bound, expiring approvals and time-boxed risk acceptance exist. There is no "lift rule R on endpoint E for N hours" grant, which needs #1 first. |
| 8 | MCP server inventory per tool and user, with risk score, approve, deny or hold | **Have** | ADR-0259, ADR-0332, ADR-0242, ADR-0097, ADR-0246; #823, #831 in flight; #871 in flight | Endpoint MCP config discovery, a per-version add-on inventory joined to the admission scan of the exact content digest, definition pinning and a hold-until-reviewed admission gate. Governed removal of flagged servers is #871 (in flight). Per-asset scores UI is #831. |
| 9 | Permission-mode (bypass / auto-approve) visibility and denial | **Partial** | ADR-0310, ADR-0259 | Managed settings ship `disableBypassPermissionsMode: "disable"` (ADR-0310), and discovery flags auto-approved tools. There is no per-session view of "which sessions actually ran in bypass". Drift against the inventory is #902 (in flight). |
| 10 | Secrets-in-agent-config report (type and length only, cross-endpoint reuse) | **Have** | ADR-0259, ADR-0195, ADR-0233 | Embedded secrets are reported as a fact and a type, never the value. A cross-endpoint "same credential reused" signal is not stated in the ADRs. |
| 11 | Tamper detection with **auto-restore** of policy files | **Gap** | ADR-0298 "Not in slice 1", ADR-0330 | Tamper reporting is a recorded follow-up (reporting first, restoring later). Managed-settings drift detection is #902 (in flight). |
| 12 | Per-session timeline of an on-device agent (turns, tools, subagents, process tree) | **Partial** | ADR-0070, ADR-0320, ADR-0316 | Full traces for calls through the gateway and for cloud coding agents run as governed workers (ADR-0320). An on-device session that bypasses the gateway is invisible, and the hook decision audit is an ADR-0298 follow-up. |
| 13 | Token usage per session, tool and endpoint from the tool's own records | **Have, ahead** | Pillar 5, ADR-0069, ADR-0076, ADR-0322; #861 in flight | Metered per-call cost and tokens at the gateway, with budgets enforced through the approvals queue. Vendor usage pull (Anthropic, OpenAI) is #861. DarkControl counts tokens. It does not price, budget or optimise them. |
| 14 | Response workflows (trigger → condition → action), dry run, run history, **endpoint quarantine** | **Partial** | ADR-0124, ADR-0186 (monitor rules), ADR-0113; #865, #881 in flight | Kill switch and safe modes at org, agent or tool scope, plus monitor rules. Rule-based behaviour detection is #865 and vendor-agent quarantine is #881 (both in flight; their ADRs are not on main yet). There is no per-endpoint quarantine and no user-built trigger-to-action graph. |
| 15 | Alert destinations: SIEM over syslog or HTTPS, Microsoft Teams | **Partial** | ADR-0303, ADR-0135, ADR-0113 | Signed, ordered, acknowledged SIEM delivery of the hash-chained audit over HTTPS webhooks, and a Teams outbound courier. **No syslog (RFC 5424 over UDP/TCP/TLS) destination.** |
| 16 | Posture score and checklist mapped to SOC 2, CIS and ISO 27001 | **Have** | ADR-0082, ADR-0214, ADR-0058, ADR-0134, ADR-0295 | Posture estimate with ranked actions and compliance packs (ISO, SOC 2, OWASP, NIST AI 600-1, AIUC-1). There is no CIS Controls pack. |
| 17 | EU AI Act deployer-obligation register (observed vs attested, evidence reference, review date) | **Partial** | ADR-0085, ADR-0058, ADR-0182 | Tier screening on intake that ends in the enforcement cascade, an eu-ai-act pack and accountability records. There is no obligations register that splits "observed by the system" from "attested by an admin". |
| 18 | Field-level before/after audit of every rule change | **Have, ahead** | ADR-0060, ADR-0116, ADR-0048 | Hash-chained, signed, offline-verifiable audit and versioned policies, compared with a CSV/JSON export. |
| 19 | Executive PDF report and endpoint risk ranking | **Have** | ADR-0047, ADR-0214 | Executive compliance reporting and ranked posture actions. Ranking is per asset, not per endpoint. |
| 20 | AI analysis of telemetry: anomalies and backtested rule suggestions, no third-party AI | **Partial** | ADR-0049, ADR-0220, ADR-0327; #903 in flight | Cost anomaly detection, trained runtime detectors and AI-step-to-rule shadow mode (#903). There is no "suggest a rule from my history" assistant. Air-gapped mode keeps telemetry in-boundary by construction (ADR-0062). |
| 21 | Endpoint agent: Windows, Linux and macOS, self-updating, one-line install token, Intune guide | **Partial** | ADR-0195, `agents/endpoint/` | A signed, read-only Go agent with TPM-backed device keys, distributed through the customer's MDM, plus an osquery-pack option. Self-update and an Intune runbook are not stated in the ADRs. |
| 22 | Dedicated instance; Entra ID SSO; per-org retention with an audited purge | **Have, ahead** | ADR-0015, ADR-0041, ADR-0174, ADR-0185, ADR-0302 | BYOC and air-gapped as well as hosted. Brokered enterprise SSO (Microsoft and Google), and retention that follows the compliance cascade. |
| 23 | Watch-only trial mode | **Have** | ADR-0298 §3 (`audit` mode), ADR-0195 | Discovery is read-only by default, and the hook has an `audit` mode that decides and never blocks. |
| 24 | Free self-assessment tools and a permission-file generator | **Gap (marketing)** | ADR-0310 | ADR-0310 already compiles vendor managed-settings files from policy, but behind the product. There is no public risk or compliance checker. |

## 3. Gaps, ranked by enterprise-buyer impact

1. **Shell-command, file and package enforcement in the hook adapters** (#1, #2) — **L**. This is DarkControl's whole
   pitch, and the first thing a CISO asks after "which agents run here?". Extend ADR-0298/0330's adapter interface with a
   neutral `Command` decision: a closed glob/prefix rule list with Allow, Ask or Deny, fail closed, and Ask rendered
   through each agent's own permission prompt. Rules are compiled by the control plane from the same per-user
   entitlements the gateway enforces, so device and gateway cannot disagree (the ADR-0298 "policy content" follow-up).
   Ship the capability matrix honestly per agent. **Blocked on the SD4 policy signer** (owner-blocked), so the slice
   should start with the signer decision. **New lane** (it extends the P1 on-device enforcement lane).
2. **Decision audit and tamper reporting from the endpoint** (#11, #12) — **M**. Both are ADR-0298 follow-ups. Every
   hook decision, including audit-mode "would deny", goes into the gateway's hash-chained audit. Periodic checks of the
   managed hook and settings report changes, building on #902's drift check, and restore comes in a second step. Without
   this, #1 has no evidence. **Partly in flight** (#902). The decision audit is new.
3. **Device-scoped policy and time-boxed exceptions** (#3, #7) — **M**. Endpoint groups as a policy subject alongside
   the user, with "lift rule R on device E for N hours" grants that reuse the ADR-0104/0105 approval binding and expiry.
   This extends ADR-0310's user/role bundle key and needs #1. **New**, queued behind #1.
4. **Endpoint response: per-device quarantine and user-built trigger-to-action rules** (#14) — **M**. Add a
   `quarantine device` action that pushes a deny-all signed policy with `notAfter`, with a per-run limit, wired to
   the behaviour detections in #865 and the ADR-0124 dial. Use the existing workflow engine or monitor rules rather than a new
   rule builder. **In flight** in part (#865, #881). Device quarantine is new.
5. **Syslog destination and an EU AI Act deployer-obligation register** (#15, #17) — **S each**. Add an RFC 5424
   syslog-over-TLS sink beside ADR-0303's webhook outbox, using the same scrubbed `regulait.siem.audit.v1` envelope. Add
   an Article 26 obligations register in the eu-ai-act pack (ADR-0058, ADR-0182) that marks each obligation "observed"
   (backed by a live control query) or "attested" (an admin record with an evidence reference and a review date).
   Optionally add a CIS Controls pack (ADR-0295 pattern). **New**, and cheap procurement wins.

Lower priority: a per-session bypass-mode view (#9, which comes with item 2), cross-endpoint secret-reuse detection (#10,
an HMAC of the value on the device, never the value), an agent self-update and Intune runbook (#21), and public lead-magnet
tools (#24, a marketing decision, not engineering).

## 4. Not recommended

- **A local TLS-intercepting proxy as the next step.** ADR-0298 §1 already rejected it for slice 1: a root CA on every
  device, broken pinning and a privileged service. DarkControl does not do this either. Its egress rules inspect command
  text. Endpoint egress should ride the command-rule slice (destinations parsed from the command), not a proxy.
- **Textual command matching as a security boundary.** DarkControl admits "rule matching is textual". We should ship
  command rules as a guardrail with the same disclaimer in the capability matrix, never market them as containment, and
  keep the gateway as the enforcement point that cannot be bypassed for model and MCP calls.
- **Sending customer telemetry to a vendor-hosted AI for "analysis".** DarkControl runs it on its own GPUs. For BYOC and
  air-gapped customers (ADR-0015, ADR-0062), any rule-suggestion assistant must run on the customer's own entitled
  models through our gateway.
- **Machine-as-identity.** DarkControl's subject is the endpoint. Ours stays the person (pillar 1). Device groups should
  narrow a user's policy, never replace it, or a shared CI runner would carry nobody's entitlements.

## 5. Where RegulAIt is ahead

- **The call path, not just the laptop.** DarkControl only sees what an agent does on the OS. RegulAIt sits on the
  model, connector, MCP and A2A calls themselves (ADR-0020, ADR-0251): guardrails (ADR-0042), PII redaction (ADR-0140),
  MCP admission scanning and definition pinning (ADR-0097, ADR-0242, ADR-0246), kill switch (ADR-0124) and governed
  cloud coding agents (ADR-0320). These work for agents that never touch an enrolled laptop.
- **Cost and tokens:** per-call cost attribution, budgets enforced through the approvals queue, forecasts and anomalies
  (pillar 5), and automatic token optimisation (pillar 6). DarkControl only reports token counts.
- **The rest of the SDLC:** forced plan gate, sign-off, PR checks and governed deploy (pillar 2), multi-agent
  orchestration with tighten-only delegation (pillar 7), and bi-directional PM-tool integration (pillar 8). DarkControl
  has none of these.
- **Evidence quality:** a hash-chained, signed, offline-verifiable audit (ADR-0060, ADR-0116), AI-BOM and decision-BOM
  snapshots (ADR-0189), and a signed SIEM outbox (ADR-0303). DarkControl offers a before/after table exported to CSV.
- **Deployment:** BYOC into AWS, Azure or GCP and code-enforced air-gapped mode (ADR-0015, ADR-0062), against a
  vendor-hosted "dedicated instance".
- **Discovery breadth:** endpoint plus SaaS, cloud and vendor agent registries (ADR-0235; #855, #884, #890 in flight),
  against coding agents on endpoints only.

## 6. One-line positioning

"DarkControl polices what coding agents type into a laptop's shell. RegulAIt governs, costs and records every call
those agents make, on the laptop, in the cloud or air-gapped, and is closing the shell-command gap on the same signed
endpoint policy."
