# Gap analysis — Manifold Security "runtime security for AI agents on endpoints", 2026-11-17

**Status:** research snapshot, written 2026-11-17 at the owner's request (Manifold was not yet in the competitor list).
It sits next to [GAP_ANALYSIS_DARKCONTROL_2026-11.md](GAP_ANALYSIS_DARKCONTROL_2026-11.md), the closest earlier
competitor, and follows the format of [GAP_ANALYSIS_CAMUNDA_2026-11.md](GAP_ANALYSIS_CAMUNDA_2026-11.md).

**Sources and honesty rules.** Company identified as **Manifold Security, `https://www.manifold.security/`** (New York /
San Diego; not the Manifold prediction market or the Manifold secrets tool; owner-confirmed). Primary sources, read
2026-11-17: the home page; the blog index and the product posts `ai-agent-security-policies-beyond-blocking`,
`agent-consent-enforcement`, `remove-ai-assets-from-endpoints`, `browser-ai-governance`,
`manifest-ai-supply-chain-intelligence`, `approval-queues-to-continuous-governance`, `prompt-injection-action-risk`,
`agentaudit-ai-agent-configuration-security`, `agent-log-tampering`, `claude-code-cowork-governance`,
`gateway-gap-ai-agent-security`, `edr-fails-ai-agents`, `manifold-raises-8m-seed-funding`; `/about`; `/lp/demo`; the
Vanta trust centre `https://trust.manifold.security/`; and `https://github.com/manifold-security/agentaudit`. The site
has **no public docs, pricing or platform pages**: `/pricing`, `/docs`, `/platform`, `/product`, `/security` and
`/trust` return 404, and the demo page is a video. Feature detail therefore comes mostly from **blog posts**, which mix
product description with research and advice. Everything below about Manifold is a **vendor claim** and was not
verified. Where a post only recommends a technique (for example Merkle-tree logging), it is not counted as a feature.
Third-party facts (founders ex-Laiyer AI / LLM Guard, single-tenant customer environments) come from dealroom.co and a
Dash0 case study and are marked as such. "RegulAIt status" is checked against `origin/main` (bb3def28f). In-flight work
is cited by PR number. Lane labels E29–E32 are the coordinator's. E31 means DarkControl gap 1 (on-device command, file and package rules); DarkControl gap 2 (the endpoint decision audit) is a follow-up slice in lane E1 after #902; E32 is DarkControl's evidence extras (syslog, EU AI Act register, CIS pack). Neither
label is written on main yet.

## 1. What Manifold sells

Manifold calls itself an **AI detection and response (AIDR) and governance platform** for "the agentic workforce".
It watches what AI agents *do* on endpoints and in browsers, not what they say. It claims to cover coding agents
(Claude Code, Cursor, Codex, Copilot, Windsurf, Cline), desktop agents (Claude Cowork, OpenClaw) and browser AI. It
claims deployment "in minutes", "agentlessly", on observability protocols (a testimonial names OpenTelemetry). The
posts describe per-agent hooks that see a command before it runs, and an MDM-pushed, signed Chromium extension. It
claims three modules:

| Module | Vendor claim |
|---|---|
| Discovery | Runtime inventory graph of every agent and the MCP servers, tools, resources, skills and plugins it uses, with the browser's add-ons in the same AI bill of materials. |
| Risk & exposure | Privilege paths, **delegation chains** and **capability combinations** that create exposure, ranked by severity. Supply-chain verdicts for skills and MCP servers from its own index, Manifest. |
| Detection & response | Real-time detection from first suspicious action to full attack chain (read sensitive data then send it out in one session; capabilities no task needs). Remediate, quarantine or terminate. Every session is recorded as a trace. |

Policy language is **Cedar** (shown in a post) over the tool-call event, matched on command text with `like`
patterns. The posts describe seven **graduated responses**, all of which record a violation except Disable:

- **Alert**: the action runs and is only recorded.
- **Advise**: the action runs and the agent is told the better way for next time.
- **Correct**: the action is denied and the agent gets the reason plus the approved alternative, then retries.
- **Ask**: the action is held for a person, and no answer counts as a denial.
- **Block**: the action is refused.
- **Block session**: everything after that point in the session is stopped.
- **Disable**: the policy is switched off.

The blog's headline example is a coding agent that hits a GitHub MCP refusal and switches to the `gh` CLI. Manifold
says one rule covered the MCP, CLI and API routes and pointed the agent at an internal share.

Other claims:

- **Governed removal** of a flagged skill, plugin or MCP server version from one endpoint or a whole fleet. A person
  starts each removal, it is audited, it is paired with a reinstall block, and the developer is notified.
- **Browser**: block a denied prompt or AI site, require a corporate account on managed devices, show an in-page
  notice, and give one timeline per tab. Prompt capture is a deployment setting.
- **Free tools:**
  - **Manifest**, a public supply-chain index (139,617 assets scanned, vendor figure).
  - **agentaudit**, an open-source CLI. It is **Apache-2.0 and written in Go**, with its last commit on 2026-11-12. It
    flags risky `.claude/`, `.cursor/` and `.codex/` repository settings: hooks, MCP servers, `ANTHROPIC_BASE_URL`,
    `HTTPS_PROXY`, `env.PATH`, credential helpers and inline skill shell.
  - The **Agent Incident Ledger**.

**Commercial:** an $8M seed round (vendor blog). There is no public pricing; access is demo-led. **Trust** (Vanta trust
centre, vendor claim): SOC 2 Type I and Type II, ISO 27001:2022, US data residency, and subprocessors AWS, GCP,
Auth0 and Anthropic. It names no BYOC or air-gapped option.

**Where it overlaps us:** pillar 1 at the endpoint and browser edge. This is the same "calls that bypass the gateway"
surface as DarkControl. Manifold's "Gateway Gap" post argues directly against gateway-only products like ours. It
claims nothing for pillars 2, 4, 5, 6, 7 or 8.

## 2. Capability-by-capability parity

| # | Capability (vendor claim) | RegulAIt status | Evidence | Gap |
|---|---|---|---|---|
| 1 | One rule enforced across MCP, shell/CLI and direct-API routes on the endpoint | **Gap** | ADR-0298, ADR-0330 | Our hook adapters decide MCP tool calls only. Bash and shell get "no decision" by design. This is DarkControl gap 1, **already queued as E31**. |
| 2 | Graduated responses: Alert, Advise, Correct (deny plus a safe alternative the agent retries), Ask, Block, Block session | **Partial** | ADR-0042, ADR-0251, ADR-0104, ADR-0105, ADR-0124, ADR-0298 §3 | Gateway verbs are `block`, `warn` and `log`, plus `require_approval` through payload-bound approvals and the kill switch at org, agent or tool scope. Missing: a policy-authored **corrective message** returned to the agent, an **Advise** verb, and **Block session** (end one session on a strong signal). The hook's deny reason is fixed and never carries arguments. |
| 3 | Human approval (Ask) on every coding agent, with no answer counted as a denial | **Partial** | ADR-0104, ADR-0105, ADR-0330 (Cursor `ask` in audit mode) | Approvals for governed calls are expiring and payload-bound. On-device Ask for commands comes with E31. |
| 4 | Runtime inventory of agents, MCP servers, skills and plugins per endpoint and version | **Have** | ADR-0195, ADR-0259, ADR-0332, ADR-0189 | Endpoint discovery and the per-version add-on inventory are joined to the scan of the exact content digest, and AI-BOM snapshots exist. |
| 5 | Supply-chain verdicts for skills and MCP servers; approved-version drift | **Have** | ADR-0242, ADR-0097, ADR-0246, ADR-0332; #902 in flight | Admission scanning and definition pinning are in place. Managed-settings drift is #902. We have no public index (see §4). |
| 6 | Governed removal of a flagged add-on from one endpoint or the fleet, with a reinstall block | **In flight** | #871 in flight (lane E13) | It is person-started, needs a step-up, is off by default and blocks reinstall by default. |
| 7 | Risk and exposure: privilege paths, delegation chains, capability combinations | **Partial** | ADR-0059, ADR-0091, ADR-0188, ADR-0092; #865 in flight (E15); #883 in flight (E20) | Blast radius, SoD toxic combinations at grant time, the actor chain and unused-grant recommendations exist. There is no per-agent **capability-combination** finding, for example private data plus untrusted input plus outbound send. Session-level behaviour rules are #865. |
| 8 | Real-time detection along the attack chain; quarantine or terminate | **Partial** | ADR-0186, ADR-0220, ADR-0124; #865 (E15) and #881 (E19) in flight | Detectors and monitor rules cover gateway-mediated calls. On-device sessions are not seen. There is no endpoint quarantine (DarkControl gap 4). |
| 9 | Every agent session recorded as a trace that shows which policy handled each action | **Partial** | ADR-0070, ADR-0320 | Full traces exist for gateway and cloud coding agents. There is no on-device decision audit. This is DarkControl gap 2, **already queued as a lane E1 follow-up slice after #902**. |
| 10 | Browser AI governance: site and prompt blocking, corporate-account gating, in-page notice, per-tab timeline | **In flight** | #867 in flight (lane E16, ADR-0334 not on main) | It covers Chromium only, with prompt-capture retention as a setting. Browser-driving agents come in PR 2. |
| 11 | Repository agent-config audit (agentaudit) | **Gap** | ADR-0259, ADR-0242 | We discover MCP configs on machines and scan servers and skills. Nothing flags a **repository's** `.claude/`, `.cursor/` or `.codex/` hooks, base-URL or proxy overrides, PATH changes or credential helpers, either before an agent opens the repository or as a pipeline-2 PR check. |
| 12 | Tamper-evident session logs (hash chain, outside recorder) | **Have, ahead** | ADR-0060, ADR-0116 | Our audit is hash-chained, WORM- or externally-anchored, signed and verifiable offline. Manifold's post recommends these techniques but does not say its product ships them. |
| 13 | Policy as code in Cedar | **Have** | ADR-0040, ADR-0059, ADR-0120 | Cedar ABAC is in place, with simulation and rule-candidate backtests. |
| 14 | Integrations: SIEM, EDR | **Partial** | ADR-0303, ADR-0113 | We have signed SIEM delivery over HTTPS and Teams. Syslog is missing (DarkControl gap 5). We have no EDR integration. Manifold names its integrations but gives no detail. |
| 15 | SOC 2 Type II and ISO 27001:2022 | **Gap (owner-deferred)** | `ENTERPRISE_READINESS_PLAN.md` | This is the same procurement gap as Camunda gap 1. |
| 16 | Public research: CVE disclosures, the incident ledger and Manifest | **Gap (marketing)** | none | This is not an engineering capability. |

## 3. Gaps, ranked by enterprise-buyer impact

1. **One rule for every route on the device: shell, CLI and direct API as well as MCP** (#1, #3) — **L**. This is
   Manifold's lead story and DarkControl's. **Already queued: E31** (it extends the ADR-0298/0330 adapters with a
   neutral command decision, using ADR-0330 B4's single device-policy signer, built in #867). Manifold adds one requirement to E31: the device rule and the
   gateway's MCP rule should compile from **one** policy, so the `gh gist create --public` route and the
   `github.create_gist` route cannot disagree. Write that into E31's acceptance criteria rather than opening a lane.
2. **Graduated, agent-steering responses: Advise, Correct and Block session** (#2) — **M**. **New lane** (suggested
   E33), which extends ADR-0042/ADR-0251's decision vocabulary and ADR-0298 §3's deny path.
   - Add a policy-authored, admin-reviewed `agentMessage` to `block`. That makes "Correct": the agent gets the reason
     and the approved route.
   - Add an `advise` verb that annotates and allows.
   - Add a `terminate_session` response at the ADR-0124 dial's narrowest scope, for prompt-injection or credential-reach
     signals from #865.
   - Every response writes the same audit row, so one history covers all of them.
   - Secure-by-default rules (ADR-0180):
     - the message is static policy text, never model output or call arguments;
     - Advise cannot be the default for a rule that ships at `block`;
     - lowering a rule from `block` to `advise` is a `settings_relax` step-up.
   - This works on the gateway path today and reaches the device when E31 lands.
3. **On-device session trace and decision audit** (#9) — **M**. **Already queued: lane E1's follow-up slice** (DarkControl gap 2; partly in
   flight in #902). Manifold's "which policy handled each action" view is the UI that slice needs. No new lane.
4. **Repository agent-config audit** (#11) — **S**. **New lane** (suggested E34).
   - Run a read-only check of a repository's `.claude/`, `.cursor/`, `.codex/` and `.mcp.json` settings. Flag hooks,
     MCP servers, base-URL or proxy overrides, PATH changes, credential helpers and inline skill shell.
   - Surface it in two places: as an automated check in the pillar-2 PR stage (ADR-0079), and in the ADR-0332
     inventory, for repositories that cloud coding agents (ADR-0320) are about to open.
   - Open source first (ADR-0176): evaluate `manifold-security/agentaudit` (Apache-2.0, Go, offline, active) as the
     engine before writing rules. It is new and has a single vendor, so record the maintenance risk in the ADR.
5. **Capability-combination exposure findings** (#7) — **M**. For each agent or delegation tree, flag grants that
   together give private-data read, untrusted-content input and an external send. Rank the findings by ADR-0059 blast
   radius, and feed them to #883's recomputed risk score. Reuse ADR-0091's toxic-combination rule shape, applied to
   agent capabilities instead of human SoD. **Partly queued:** it builds on E15 (#865) and E20 (#883). The static
   finding is new and should fold into E20, not a new lane.

Lower priority:

- endpoint quarantine and syslog, both already DarkControl gaps 4 and 5;
- SOC 2 and ISO certification, which the owner deferred;
- a public research and incident programme, which is a marketing decision.

## 4. Not recommended

- **Textual `like` matching as the security boundary.** Manifold's own Cedar example matches the command string
  (`*gh gist create*--public*`). That is easy to evade with aliases, `gh api`, `curl` or a script file. Ship command
  rules as a guardrail with that disclaimer in the capability matrix, as the DarkControl analysis already recommends.
  The gateway stays the enforcement point that cannot be bypassed for model and MCP calls.
- **Agent-steering messages generated by a model.** Correct and Advise text must be static policy text that an admin
  reviews. A generated message becomes an injection channel back into the agent.
- **A public, vendor-hosted supply-chain index built from customer telemetry.** It conflicts with the BYOC and
  air-gapped boundary (ADR-0015, ADR-0062). The signed detection-content feed (Codex lane C2, proposed in #935) is the
  in-boundary equivalent.
- **Prompt capture on by default.** Manifold makes it a deployment setting. Ours stays off unless enabled, with bounded
  retention (#867's B2 decision).

## 5. Where RegulAIt is ahead

- **The call path, not just the device.** Manifold sees what agents do on endpoints and in browsers. RegulAIt governs
  each model, connector, MCP and A2A call itself (ADR-0020, ADR-0251). That covers guardrails (ADR-0042), PII redaction
  (ADR-0140), admission scanning and pinning (ADR-0097, ADR-0242, ADR-0246), the kill switch (ADR-0124) and governed
  cloud coding agents (ADR-0320). It works for agents that never touch an enrolled laptop. Manifold's "Gateway Gap"
  argument is answered by E31: the gateway plus the device, on one policy.
- **Per-person entitlements.** Default-deny, per-user allow-lists at tool level, role bundles and IdP group mapping
  (ADR-0014). Manifold describes policies, not a per-user entitlement model.
- **Evidence.** Our audit is hash-chained, anchored, signed and verifiable offline (ADR-0060, ADR-0116), with AI-BOM
  and decision-BOM snapshots (ADR-0189) and compliance packs (ADR-0058). Manifold writes about tamper-evident logging
  as research.
- **Cost and tokens.** Per-call attribution, budgets enforced through the approvals queue, and forecasts (pillar 5),
  plus automatic token optimisation (pillar 6). Manifold claims neither.
- **The rest of the SDLC.** Forced plan gate, sign-off, PR checks and governed deploy (pillar 2), shared projects
  (pillar 4), multi-agent orchestration with tighten-only delegation (pillar 7), and bi-directional PM-tool integration
  (pillar 8).
- **Deployment.** BYOC into AWS, Azure or GCP and a code-enforced air-gapped mode (ADR-0015, ADR-0062). Manifold
  offers a US-hosted SaaS, with Anthropic among its subprocessors (trust-centre claim).

## 6. One-line positioning

"Manifold watches and steers what agents do on a laptop. RegulAIt governs, costs and records every call those agents
make, on the laptop, in the cloud or air-gapped, and is bringing the laptop's commands under the same signed
policy."
