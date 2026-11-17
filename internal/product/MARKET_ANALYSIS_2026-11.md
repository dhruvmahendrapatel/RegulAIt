# RegulAIt — Market Analysis, 2026-11-14

**Status:** research snapshot, written 2026-11-14. It follows
[MARKET_ANALYSIS_2026-08.md](MARKET_ANALYSIS_2026-08.md) (2026-08-15) and covers only what changed after it. It is
checked against what RegulAIt has built or queued since then (ADR index on `origin/main` through ADR-0304,
`PENDING.md`, `ARCHITECTURE.md`, `PRODUCT_GOALS.md`, `ROADMAP.md`).

**Method and honesty rules.** Live web search and page fetches on 2026-11-14. **Primary** means the vendor's own
page, changelog or press release was read on that date. **Secondary** means trade press, aggregators or
competitor-written pages; those claims are marked *(secondary)*. Claims that could be found only in one aggregator, or
that the sources disagree on, are marked **unverified**. Prices and acquisition values are secondary unless stated.
Several vendor sites gave search snippets only; where so, it is said.

**Reach this pass.** `atlasapp.ai` was reachable this time (blocked in August). The New Stack article on Cognition's
budgets returned HTTP 403 (snippet only). No Microsoft Ignite 2026 coverage exists yet: the event runs 2026-11-17 to
11-19, after this snapshot, and Agent 365 news is expected there.

---

## 0. What changed since August — the six findings that matter

1. **Every platform vendor now ships an "agent passport": identity, scoped delegation and a kill switch for its own
   agents.** ServiceNow announced **AI Passport** on 2026-10-15: a signed per-agent credential, verified at each step of
   a multi-agent workflow, with scope narrowing at each delegation, graduated responses (redirect, restrict, throttle,
   block), a kill switch, and control over what agents **and MCP servers** may do. It is due Q4 2026 (primary,
   ServiceNow press release). Google's Gemini Enterprise Agent Platform (Agent Identity, Agent Registry, Agent Gateway)
   went GA in late July *(secondary)*. Palo Alto's Prisma AIRS AI Gateway (the former Portkey) went **GA on 2026-07-16**
   with CyberArk-based agent identity *(secondary, PANW blog snippets)*. Atlassian announced agent accounts and a
   non-human-identity inventory as "soon" (2026-10-08, secondary). RegulAIt's pillar-1/7 mechanics (ADR-0188 workload
   identity, ADR-0210 identity assertion, ADR-0124 kill switch, ADR-0016 ceilings) are at parity. Its one remaining
   distinct claim is that it is vendor-neutral and self-hosted.

2. **Pillar 5's cross-vendor cost wedge is now contested by four more vendors.** ServiceNow **AI Cost Management**
   brings frontier-model, embedded-SaaS-AI, hyperscaler and GPU spend into one view with budget alerts (due Q4 2026,
   primary). Atlassian **AI Capital Management** (open beta) reports AI spend by model provider, department and
   initiative (2026-10-08, secondary). AWS made Bedrock **per-IAM-principal cost attribution** GA in CUR 2.0, with
   request-level metadata tags (April–May 2026, secondary). Cognition shipped **hierarchical Devin budgets by team and
   project that halt a session** (around 2026-10-30, secondary). Cloudflare added dollar spend limits (June) and
   identity-driven per-user budgets (closed beta) *(secondary)*. ADR-0069/0076 still import files only and hold no
   vendor credential. That posture is now the main thing keeping the wedge from being real-time.

3. **Pillar 8's ground is now "assign the work item to an agent", and the PM vendors own it.** **Agents in Jira went
   GA in May 2026** for Standard, Premium and Enterprise. Any work item can be assigned to Rovo, Claude, Cursor, Codex,
   Copilot or Jira's own coding agent, and every agent action is in Jira's audit log *(secondary + Atlassian community
   page)*. At Team '26 Europe (reported 2026-10-08), Devin, Factory and Warp were listed on the Atlassian Marketplace,
   the Atlassian MCP server grew to 200+ tools with every call audited, and Rovo overage billing starts 2026-12-03
   *(secondary)*. Microsoft made the **Azure Boards → Copilot coding agent** integration GA (Learn release notes; work
   item → plan → draft PR). Neither vendor offers a neutral, cross-vendor approvals and decisions record. RegulAIt now
   has to plug into these "assign to agent" surfaces instead of competing with them.

4. **The AI-coding tools became agent platforms with their own governance layers.** Cursor shipped an **Agent SDK**
   (2026-10-20: agents as code, evals, deploy to Cursor or your own infrastructure, triggered from Git providers,
   Slack, webhooks or cron), the **Origin app marketplace** (10-13) and **Live Apps** with admin publish approval
   (11-05) (all primary, Cursor changelog). GitHub added **enterprise MCP allowlists** enforced in Copilot app, CLI and
   VS Code, failing closed (2026-08-06, primary). It also default-enabled GA Copilot features from 2026-10-22
   *(secondary)* and added BYOK and custom models to the usage API and a cost-centre lookup API (2026-11-03,
   primary). OpenAI's Codex has managed `requirements.toml` policies, an Admin plugin and a combined credit
   dashboard *(secondary)*. Each tool now has its own managed-settings channel. RegulAIt does not yet write to any of
   them.

5. **Gateway consolidation went on, and an open-source supply-chain incident hit the category.** Kong split AI
   Gateway into its own product: 2.0 GA on 2026-09-01 with MCP server bundling, per-caller tool ACLs, principal-keyed
   cost attribution and modality pricing (primary, Kong blog), and 2.2 reported 2026-09-30 *(secondary)*.
   **agentgateway** (open source, Rust; MCP, A2A and LLM traffic) became an Agentic AI Foundation project on
   2026-06-04 *(secondary)*. **LiteLLM's release pipeline was compromised on 2026-10-21**: `v1.107.0` shipped malware
   that stole credentials and loaded remote-code-execution tools, and LiteLLM rotated its signing key on 10-23
   (primary, LiteLLM incident posts). This strengthens RegulAIt's signed-bundle, pinned-dependency and air-gapped
   posture (ADR-0041, ADR-0176, ADR-0199) as a selling point. The release-key ceremony (PENDING S3) is still owner-gated.

6. **The GRC tier is moving to runtime more slowly than claimed.** **Credo AI Agent Governor** is a *research preview*
   (2026-07-14). It hooks the agent harness (allow, deny, escalate, advise per tool call), and secondary sources say it
   is Claude-Code-only with no SLA (Credo blog, primary; scope secondary). No Holistic AI Guardian Agents GA date was
   found. IBM watsonx.governance published an "Enterprise Governance Graph" inventory *(secondary, IBM community post)*.
   Check Point packaged Lakera into an **AI Defense Plane** (March) with AI Agent Security in early access since June
   *(secondary + Lakera changelog snippet)*. Runtime enforcement at a gateway, which RegulAIt has, is still rare in
   this tier.

**Market money signal (secondary, repriceable):** Cognition raised more than $2B at a $48B valuation in September
2026, Lovable $400M at $13.3B (2026-08-12), and Cyera agreed to buy Oasis Security, a non-human-identity vendor, for
about $1B (LOI 2026-07-28; completion reported 2026-09-08). Anthropic filed an S-1 on 2026-10-26 (primary, Anthropic
news). Spend is flowing to agent platforms and agent identity, not to standalone gateways.

---

## 1. Competitor updates (only what changed since 2026-08-15)

### 1.1 AI coding / agent platforms

**Cursor (Anysphere).** Primary (cursor.com/changelog, read 2026-11-14):
- **Origin app marketplace**, 2026-10-13: 20+ deploy, CI, review, security and monitoring apps; open to public
  submissions.
- **Cloud agent canvases and an Environments API** (beta), 10-16: up to 300 repositories per environment.
- **Agent SDK**, 10-20: agents as code projects, tested with evals, deployed to Cursor *or your own infrastructure*;
  triggered from GitHub, GitLab, Bitbucket, Slack, webhooks or cron.
- **Live Apps**, 11-05: cloud agents build and host internal apps. Admins see every app and secret, add security
  review rules, approve blocked publishes and unpublish.
- **Voice chat with agents**, 11-06.

Earlier in 2026, secondary: self-hosted cloud agents (March 31) and an Organizations feature with sandbox
environments (June 8). *Gaps unchanged:* governs Cursor only; no cross-vendor cost view; no compliance cascade.

**Devin / Windsurf (Cognition).**
- **SWE-2 model**, 2026-09-10 *(secondary)*.
- **Enterprise spend and oversight platform**, around 2026-10-30: hierarchical budgets by team and project that halt
  a session when the budget runs out, plus a productivity score estimating productive engineering hours against usage
  *(secondary: FF News; New Stack 2026-11-02, snippet only, page 403)*.
- **Devin Outposts** (run Devin workloads in your own environment) appears in the 2026 release notes *(secondary)*.
- Listed on the Atlassian Marketplace (Team '26 Europe).
- Series E of more than $2B at $48B, September 2026 *(secondary; one source)*.

No Windsurf-specific news after August was found (unverified). *Gaps:* governs Devin only.

**GitHub Copilot / Agent HQ.**
- **MCP allowlists in enterprise managed settings**, 2026-08-06 (primary): `allowedMcpServers` and
  `deniedMcpServers` match by URL with wildcards, by stdio command or by name (name is not a security control). They
  are enforced in the Copilot app, CLI and VS Code, and fail closed; layered policies must all pass.
- **Default enablement of GA Copilot features** for Business and Enterprise, announced around 2026-09-24 and effective
  around 10-22 *(secondary; changelog title seen)*.
- November 2026 (primary, github.blog/changelog):
  - **BYOK and enterprise custom models in the Copilot usage API** (11-03).
  - **Cost-centre lookup in the REST API** (11-03).
  - **Copilot impact dashboard** adds chat and VS Code agent usage (11-06).
  - **Usage metrics API** adds code review details and addressed rate (11-05).
  - **GitHub Enterprise Server support in the Copilot app** (11-13).
  - `@GitHub` in Slack and Teams GA (11-06).
- Agent HQ is still documented as **public preview**; no GA found (unverified either way).

*Gaps:* GitHub-resident work only. Usage and cost data now has an API that RegulAIt could ingest (see gap G1).

**Lovable.** $400M Series C at $13.3B, 2026-08-12, earmarked for "enterprise integrations, governance and permissions
controls" *(secondary, SiliconANGLE)*. Ships SSO/SAML, RBAC, SCIM, audit logs, publishing restrictions, security
scanning and built-in pen testing *(secondary)*. A September chat release extended it to research, documents and
database queries *(secondary)*. *Gaps unchanged* for pillars 1, 3 and 5–8.

**Atlas (atlasapp.ai). Reached directly this time (primary, 2026-11-14).** Positioning: "AI systems for every
outcome", built and run **inside the customer's own cloud (AWS, Azure or GCP)**. The parts:
- **Ontology:** business objects, rules and sources such as SAP, Salesforce and Snowflake.
- **Work:** questions from Atlas, Teams or any MCP client.
- **Build:** automations, agents and apps, tested before release.
- **Release:** runs apps, agents and MCP servers in the customer's cloud.
- **Orbit:** a per-employee assistant with that person's own access.

Atlas proposes the cloud resources an outcome needs, and **nothing is created until approved**. It uses Claude Code,
Codex, Copilot and Cursor to build. It claims SOC 2, ISO 27001, GDPR and HIPAA. Forward-deployed engineers are
offered. No pricing and no dated news. *Read:* a BYOC "outcome factory" with an approval gate on infrastructure. It
overlaps pillars 2, 3 and 7 in shape. It shows no per-user tool-level entitlement model, cost dashboard or compliance
cascade on the page (absence on a marketing page, not verified absence in the product).

**Claude Code / Agent SDK (Anthropic).** Primary (anthropic.com/news):
- Agent Skills donated to the Agentic AI Foundation (2026-10-22; "70+ platforms adopted").
- Opus 5.5 (09-22, ~40% cheaper to run than Opus 5), Sonnet 5.5 (09-28), Haiku 5.5 (10-07, aimed at subagents),
  Fable 5.2 and Mythos 5.2 (11-09).
- S-1 filed (10-26).

Managed settings now include version pinning (`requiredMinimumVersion`/`requiredMaximumVersion`) and a
`managed-settings.d/` drop-in directory *(secondary, release-tracker sites)*. No dated enterprise-admin announcement
after August was found on the news page. *Gaps unchanged:* one vendor's estate.

**OpenAI Codex / Frontier.** Codex admin: a dedicated admin group, admin-enforced `requirements.toml` policies from a
Codex Policies page (primary, developers.openai.com snippet), an **Admin plugin** for conversational workspace
administration (launched "August 25"; year inferred as 2026, unverified), and a combined ChatGPT and Codex credit
dashboard *(secondary)*. **Frontier** (launched 2026-02-05) gives each agent its own identity, permissions and
guardrails and supports third-party agents. It was in limited release at launch; GA status now is unverified
*(secondary)*.

### 1.2 LLM gateways / governance layers

**LiteLLM.** Primary (docs.litellm.ai):
- **v1.107.0 supply-chain compromise**, 2026-10-21: credential-stealing malware plus remote-code-execution loaders,
  built and signed by LiteLLM's own pipeline. Root-cause analysis 10-23, cosign key rotated 10-23. Enterprise
  private-release users were not affected.
- A **March 2026 suspected supply-chain incident** and a **guardrail-logging secret-header exposure** (2026-03-18).
- Licence enforcement tightened in October: organisation APIs return 403 without a licence (v1.102.0), and a
  `worker_registry` proxy refuses to boot unlicensed (v1.98.0).
- v1.104–1.106 added master-key enforcement, team routing controls and MCP rate limits.

*Read:* still the reference open-source gateway, but enterprise features are moving behind the licence. RegulAIt
cannot take its code anyway (ADR-0176 open-source-first; RegulAIt is proprietary, ADR-0178).

**Portkey → Prisma AIRS AI Gateway.** GA 2026-07-16 as "the AI control plane for the enterprise": inline across
model, MCP and A2A traffic, runtime inspection, CyberArk-backed agent identity *(secondary, PANW blog snippets)*. No
standalone Portkey roadmap was found.

**Kong AI Gateway.** Primary (Kong blog, 2026-09-01): **AI Gateway 2.0 GA** as a standalone runtime. It adds:
- **MCP server bundling**: one route, merged tool catalogue, filtered per caller by MCP ACL.
- **Identity principals**: rate limits, cost attribution and access control keyed on the authenticated principal; off
  by default.
- **Modality-aware pricing catalogue**: text, audio, image, video, cache reads and writes.
- **SigV4 for Bedrock AgentCore** on the A2A and MCP proxy plugins.

AI Gateway 2.2 (caller-specific MCP tool authorization) reported GA 2026-09-30 *(secondary)*. Agent Gateway for A2A
traffic arrived in 3.14 (April, secondary). *Read:* Kong now covers per-principal MCP tool ACLs and cost
attribution, so pillar 1's mechanism is common at the gateway layer.

**Cloudflare AI Gateway.**
- **Dollar spend limits**: per model, provider or custom attribute, with fallback routing on a hit (June 2026,
  changelog URL seen).
- **Identity-driven per-user and per-group budgets** via Cloudflare Access (closed beta).
- **Shadow MCP detection rules** in its secure web gateway, and MCP server portals.
- **Monetization Gateway**: paid MCP tools and x402 agent payments (closed beta, October 2026).

All *(secondary)* except the changelog URL. *Read:* Cloudflare now has budgets per user, but only for traffic it
carries.

**TrueFoundry.** No new funding found. It markets one gateway covering LLM, MCP and agents, and announced a UK and
Europe channel expansion (2026-11-10) *(secondary)*. Nothing changes the August profile.

**Helicone.** No change (maintenance mode since 2026-03).

**Langfuse.** The ClickHouse acquisition is now confirmed primary: **announced 2026-01-16** (clickhouse.com and
langfuse.com blogs). The August file's "unconfirmed" flag is resolved; the core stays MIT.

**Arize AX.** September 2026: first-class sessions, **Agent-as-a-Judge** on every plan, and vision evals (primary blog
title; content secondary). At Observe 2026 it announced managed agents and Harness-as-a-Judge *(secondary)*.

**Lakera / Check Point.** **AI Defense Plane** launched in late March 2026 (application and agent security, workforce
AI security; red teaming in limited release) *(secondary)*. Lakera's changelog for 2026-06-01 shows **AI Agent
Security early access**: agent discovery, per-agent risk ratings and tool allow/deny lists (changelog snippet).

### 1.3 Enterprise AI governance / compliance

**Credo AI.** GAIA governance agent GA (2026-05-13). **Agent Governor research preview** (2026-07-14): runtime
allow, deny, escalate and advise at the agent harness, with three posture presets (primary, Credo blog and product
page say "not generally available · no production SLA"). AIUC-1 integration reported 2026-09-22 *(secondary,
aggregator; unverified)*.

**Holistic AI.** No 2026 release with a GA date was found; Guardian Agents are still undated *(secondary)*.

**IBM watsonx.governance.** An "Enterprise Governance Graph" inventory covering models, agents, tools and shadow AI,
framed as an AI assurance layer (IBM community post, 2026-05-11) *(secondary)*. Nothing new was found after August.

**Microsoft Purview + Agent 365.** Agent 365 is $15 per user per month standalone, or bundled in M365 E7 at $99
*(secondary)*. The **Ignite 2026 preview guide** (Tech Community) says Agent 365 is moving from a control plane to an
**AI observability platform**, with sessions on MCP server management and **AI spend** (primary title; event
2026-11-17 to 19). **Re-check after Ignite.** Microsoft Agent Framework 1.0 went GA in April, and Foundry Control
Plane added inventory of registered custom agents in May *(secondary)*.

**ServiceNow AI Control Tower → "Super Intelligence Control Tower".** Primary:
- **AI Passport** (2026-10-15): signed per-agent credential, step-wise verification in multi-agent flows,
  narrowing delegation, revocation, graduated responses, kill switch, audit with compliance signatures, built "on open
  specifications"; NVIDIA is a launch partner.
- **AI Cost Management** in ITAM, plus **value intelligence** (cost, quality and realised value).

All due Q4 2026. A **Control Tower Alliance** (2026-10-28) has founding members including Anthropic, AWS, Cisco,
NVIDIA, OpenAI and Okta (primary press-release title). Docs list policies that auto-block agents, models or domains,
and a kill-switch role (primary docs snippet).

### 1.4 Newly prominent since August

- **Agent-identity M&A.** Cyera agreed to buy Oasis Security (agent and non-human identity) for about $1B (LOI
  2026-07-28; completion reported 2026-09-08) *(secondary)*. Proofpoint bought Acuvity (runtime AI and MCP
  governance) on 2026-02-12 (primary press release, before August, missed last time).
- **MCP gateways as a funded category.** Runlayer ($30M Series A, date unverified), Obot (open-source MCP gateway;
  $35M seed in 2025), NeuralTrust ($20M, June 2026; agent gateway "TrustGate"), Helmet Security ($9M, December 2025)
  *(all secondary)*. **agentgateway** joined the AAIF on 2026-06-04.
- **Standards.** MCP spec **2026-07-28**: stateless servers behind ordinary load balancers, OAuth and OIDC
  hardening, a feature-lifecycle and deprecation policy, and MCP Apps as an official extension. Release candidate vs
  final status is unverified. Agent Skills went to the AAIF (2026-10-22, primary). **OpenTelemetry GenAI and agent
  semantic conventions are still "Development"**, not stable, and moved to a separate `semantic-conventions-genai`
  repository *(primary spec page status; one secondary source claims stable — contradicted)*.
- **AI FinOps from the cloud and FinOps side.** AWS Bedrock per-principal attribution and an AWS FinOps Agent
  (preview); Harness request-level AI cost to agent or workflow (May); Flexera AI Spend Management (early access);
  Revenium per-trace circuit breakers; Portal26 Agentic Token Control (April); DoiT Attribute (eBPF, per agent);
  Stacklet Token Custodian (GA planned Q4). A **Tokenomics Foundation** started with the FinOps Foundation on
  2026-06-03 *(all secondary)*.
- **"Software factory" orchestration for coding agents.** Warp Factories (work enters from Linear and Jira; factory
  definitions as version-controlled code), Linear agent integrations, and Cursor's Agent SDK *(secondary / vendor
  pages)*. This is pillar 7's ground in a single-developer-tool shape.
- **SaaS-security vendors extending to agents (added 2026-11-16).** **Obsidian Security** "AI Agent Security":
  continuous discovery across Bedrock, Azure AI Foundry, Copilot Studio, ChatGPT, Vertex, Agentforce, n8n and Claude
  Code; agent-to-owner, MCP, model and SaaS-permission mapping; usage-based least privilege; risk scores on publish;
  runtime blocking via a "context-aware runtime decision engine"; audit evidence *(primary vendor page, read
  2026-11-16)*. Full parity table and ranked gaps: [GAP_ANALYSIS_OBSIDIAN_2026-11.md](GAP_ANALYSIS_OBSIDIAN_2026-11.md).
- **Process-orchestration incumbents repositioning as agentic (added 2026-11-16).** **Camunda** "agentic
  orchestration": BPMN processes that sequence AI agents, people, systems, rules, RPA and document processing, with a
  shared modeler, durable engine, live operations console, task list, process analytics and a connector marketplace
  over MCP, A2A and REST *(primary vendor pages, read 2026-11-16; analyst placements are vendor claims)*. Overlaps
  pillars 2 and 7. Parity table and gaps: [GAP_ANALYSIS_CAMUNDA_2026-11.md](GAP_ANALYSIS_CAMUNDA_2026-11.md).
- **Endpoint "AI detection and response" for coding agents (added 2026-11-17).** **DarkControl** "AIDR": a
  lightweight endpoint agent that intercepts AI coding agents' shell commands, file access and package installs and
  returns Allow, Ask or Deny from central policy, with an MCP inventory and risk scores, time-limited exceptions,
  tamper detection, quarantine, SIEM and Teams alerts and an EU AI Act register *(vendor pages, read 2026-11-17; the
  vendor calls its console views illustrative; no docs or pricing published)*. Overlaps pillar 1 on the endpoint. Parity
  table and gaps: [GAP_ANALYSIS_DARKCONTROL_2026-11.md](GAP_ANALYSIS_DARKCONTROL_2026-11.md).
  **Manifold Security** "AIDR" (added 2026-11-17): endpoint and browser runtime security for AI agents with discovery,
  risk and exposure, and detection and response; Cedar policies with graduated responses (alert, advise, correct, ask,
  block, block session, disable), governed removal of risky add-ons, a Chromium extension and the open-source
  `agentaudit` repo-config scanner *(vendor blog and site, read 2026-11-17; docs and pricing pages not published)*.
  Parity table and gaps: [GAP_ANALYSIS_MANIFOLD_2026-11.md](GAP_ANALYSIS_MANIFOLD_2026-11.md).
- **API gateways adding AI modules (added 2026-11-17).** **KrakenD AI Gateway**: a stateless Go API gateway whose AI
  module is Enterprise-only (LLM routing and failover, semantic cache, prompt guard, token quotas, stream rewriting, an
  MCP server over REST backends); the Community Edition (Apache-2.0) has no AI module *(vendor pages and GitHub, read
  2026-11-17)*. Overlaps pillars 1, 5 and 6 at the gateway. Parity table and gaps:
  [GAP_ANALYSIS_KRAKEND_2026-11.md](GAP_ANALYSIS_KRAKEND_2026-11.md).
- **Managed agent platforms.** Google Gemini Enterprise Agent Platform: Agent Identity, Agent Registry and Agent
  Gateway, GA end of July *(secondary)*. AWS Bedrock AgentCore: managed harness, CLI and skills in April *(primary
  AWS What's New title)*. Nothing later than April was found; re:Invent is in December.

---

## 2. Pillar-by-pillar parity table — 2026-11-14

"RegulAIt today" reflects ADRs on `origin/main` through ADR-0304. "Moved since August" is the change in the field.

| # | Pillar | RegulAIt today (cites) | Field leader(s) now | Moved since Aug | Verdict |
|---|---|---|---|---|---|
| 1 | Per-user governance gateway | Default-deny kernel; one governed decision core for model, connector, MCP and A2A (ADR-0251, Proposed, slices built); MCP admission scanning, definition pinning and bundles (0097, 0246 Proposed, 0236); workload identity (0188), identity assertion (0210, Proposed, slice built); kill switch (0124); IDE semantic cache (0119); Cedar rate limits (0239); endpoint MCP-config discovery (0259) and on-device enforcement slice 1, default off (0298); OpenAI and Anthropic SDK plus Responses API compatibility (0257, 0287). SIEM delivery of the audit chain as a signed, ordered Standard Webhooks batch adapter (0303). Demo on mock provider; no live LLM provider connected (PENDING first table, P1). | Prisma AIRS AI Gateway (GA July), Kong AI GW 2.x (per-caller MCP ACL), ServiceNow AI Passport (Q4), Google Agent Gateway, GitHub MCP allowlists, Cloudflare per-user budgets | Up: four vendors added agent identity and MCP ACLs | **Parity on mechanism, ahead on breadth** (MCP admission, pinning and consent binding go further than any profile found). Behind on live proof and on pushing policy into vendor clients (gap G2). |
| 2 | Multi-stage workflow engine | Declarative templates, forced plan gate (0079, 0250), deploy gate (0161), pg-boss retry, backoff, fan-out, idempotency and wait-for-token (0282–0286), all four git providers | Jira Agents (assign → PR, GA May), Azure Boards → Copilot (GA), Cursor Agent SDK triggers, Warp Factories, Atlas (approve-before-create) | Up: "work item → agent → PR" is now native in Jira and ADO | **Still ahead in composition** (cascade-conditional, admin-assigned stages). Behind on entry points (gap G4) and on using external coding agents as workers (gap G6). |
| 3 | Infra ops, cascade, BYOC/air-gapped | Code-enforced air-gap egress (0062); signed update bundles (0041); Kubernetes operator and Helm chart (0304); incident clocks GDPR, NIS2, DORA and CRA (0296); MITRE ATLAS (0293); OWASP MCP Top 10 (0243); evidence retention via the cascade (0302) | Atlas (BYOC, approval before resource creation), TrueFoundry, Devin Outposts, Cursor self-hosted cloud agents | Flat-to-up: more coding vendors offer self-hosted runtimes | **Cascade still unmatched** in every profile checked. Operator and Helm close the August "compose only" gap. No third-party attestation yet (queued, PENDING P2/P3). |
| 4 | Shared Projects, cross-team context | Governed shared context with provenance and versioned conflicts (EPIC-02 MVP) | Atlassian Teamwork Graph (250B objects, function-level code context in beta, **agent-session memory**) | Up: Atlassian is moving into "governed shared agent memory" | **Differentiated on governance, behind on scale and automatic capture** (gap G9). |
| 5 | Cost-per-project dashboard | Per-call attribution; budgets to the approvals queue; forecast and anomaly (0049); modality pricing (0212); configurable usage extractor (0241, Proposed, slice built); cross-vendor **file** import with metered vs imported CHECK (0069) and reconciliation and roster (0076) | ServiceNow AI Cost Mgmt + value intelligence (Q4), Atlassian AI Capital Mgmt (beta), AWS per-principal CUR, Cognition hierarchical budgets, Cloudflare per-user budgets, Kong principal-keyed cost | **Sharply up**: four vendors now pitch consolidated AI spend | **Wedge narrowed again.** RegulAIt still uniquely keeps metered and imported apart in the schema, but it ingests by file only (gap G1) and has no cost-per-outcome view (gap G3). |
| 6 | Token/cost optimisation | Seven techniques live, savings measured (EPIC-04); semantic cache on IDE path (0119) | Provider price cuts (Opus 5.5 ~40% cheaper), Cloudflare fallback on budget hit, Atlassian MCP "25% fewer tokens" | Flat | **Commodity**, as in August. No new gap worth building. |
| 7 | Multi-agent orchestration | DAG, governed workers, tighten-only ceilings (0016), conformance suite (0078), governed A2A (0219), SAP Joule over A2A (0231, Proposed, slice built), pipeline builder (0232, Proposed, design only) | ServiceNow AI Passport (narrowing delegation), MS Agent Framework 1.0, AgentCore harness, Cursor Agent SDK, Warp Factories | Up: "scope narrows at each delegation" is now a ServiceNow marketing claim | **Tighten-only inheritance no longer unique as a claim.** It is unique as a *tested invariant* across vendors (ADR-0078). Gaps G6 and G8. |
| 8 | Bi-directional PM-tool integration | Adapter matrix, approval mirroring, decision records, inbound sync with replay protection (0010 amend.); live Jira Cloud and Azure DevOps connections for the demo (0202); work-item importer not built (PENDING, ADR-0054) | Agents in Jira (GA), Atlassian MCP 200+ tools with audit, Azure Boards → Copilot (GA), ADO remote MCP server (preview) | **Sharply up** | **Behind on entry point, ahead on neutrality.** Nobody else records decisions and approvals neutrally across Jira, ADO and Linear, but buyers now start from "assign to agent" (gap G4). |

---

## 3. Gap list, ranked by adoption impact for an enterprise buyer

**Rule.** A gap is listed only if no ADR, `PENDING.md` item or `ROADMAP.md` row already builds or queues it; the
check is cited. §3b lists items that are already queued but whose urgency rose. Licences in the OSS column follow
ADR-0176 (MIT, Apache-2.0, BSD or ISC only); a licence named here was not re-verified in this pass unless stated.

### 3a. Unqueued gaps

| Rank | Gap | Pillar | Size | OSS option | Who ships it (evidence) | Repo check |
|---|---|---|---|---|---|---|
| **G1** | **Pull vendor usage and cost APIs** into the cross-vendor view: Anthropic Admin usage and cost, OpenAI usage and costs, GitHub Copilot usage metrics plus cost centres (BYOK now included), Cursor admin, Codex analytics, AWS CUR 2.0 `line_item_iam_principal`. Imported data stays `basis='imported'`. | 5 | M | Official SDKs: `openai` (Apache-2.0), `@anthropic-ai/sdk` (MIT), `@octokit/rest` (MIT), `@aws-sdk/*` (Apache-2.0) | ServiceNow AI Cost Mgmt (primary, Q4), Atlassian AI Capital Mgmt (secondary), AWS (secondary), GitHub usage API 11-03 (primary) | ADR-0069 and ADR-0076 import files only and **deliberately hold no vendor credential and do not poll**. Reversing that needs an owner decision. |
| **G2** | **Compile RegulAIt policy into vendor-native managed settings**: Copilot `allowedMcpServers`/`deniedMcpServers`, Claude Code `managed-settings.json` (MCP, permissions, version pins), Codex `requirements.toml`, Cursor admin. Detect drift through ADR-0259 discovery. | 1 | M | `smol-toml` (MIT) for TOML; JSON is native | GitHub (primary, 2026-08-06), Claude Code docs (primary), Codex docs (primary snippet) | ROADMAP's IDE ladder lists the "**Managed** — admin pushes IDE policy / managed settings" rung at size M, **not built**. ADR-0298 does hooks on the device, which is a different mechanism. |
| **G3** | **Cost per outcome**: spend per merged PR, per workflow run, per completed work item and per accepted change, joining the pillar-5 ledger to pillar-2 PR stages and pillar-8 items. | 5 (2, 8) | S–M | none needed (SQL over existing ledgers) | ServiceNow value intelligence (primary), GitHub impact dashboard and code-review addressed rate (primary), Cognition productivity score (secondary), Claude cost per commit (secondary, July) | No ADR or PENDING item found (grep "per PR", "per merged", "ROI", "outcome"). The ADR-0214 "objective cards" are posture metrics, not cost per outcome. |
| **G4** | **Be assignable from Jira and Azure Boards**: register RegulAIt's governed agent so that assigning, @mentioning or a Jira Automation rule starts a pillar-2 workflow, with the decision record written back. Also ingest the Atlassian MCP-server and agent audit events as evidence. | 8 (2) | M–L | Jira and ADO REST plus webhooks (existing adapters); Atlassian Forge licence not checked, so a Forge app may not qualify (a plain webhook and Automation path avoids it) | Agents in Jira GA (secondary + community page), Azure Boards → Copilot GA (primary Learn), Marketplace agents Devin, Factory, Warp (secondary) | ADR-0010 has inbound sync. ADR-0054's work-item **importer** is queued. Nothing registers RegulAIt as an *assignable agent*. |
| **G5** | **Govern third-party cloud coding agents as pillar-2/7 workers**: dispatch a build stage to Copilot coding agent, Codex cloud, Devin or Cursor cloud agents through their APIs, under the initiating user's ceiling; capture the PR, attribute cost, enforce the plan gate. | 7 (2, 5) | L | A2A SDK (`@a2a-js/sdk`, Apache-2.0, unverified version) where offered; vendor REST otherwise | Jira and ADO assignment to these agents (above), Cursor Agent SDK (primary), Warp Factories (secondary) | No ADR or PENDING hit for "coding agent" or "cloud agent". ADR-0219 governs A2A calls, and ADR-0231 covers SAP Joule only. |
| **G6** | **Import agents from vendor agent registries** into RegulAIt's inventory and ownership model: Entra Agent ID and Agent 365, Gemini Enterprise Agent Registry, Bedrock AgentCore, Atlassian agent accounts (when shipped). | 1 (7) | M | `@microsoft/microsoft-graph-client` (MIT), `@google-cloud/*` (Apache-2.0), `@aws-sdk/*` (Apache-2.0) | Google (secondary), Microsoft (secondary), ServiceNow 30+ integrations (secondary), Atlassian "soon" | ADR-0195 and ADR-0235 scan cloud AI services and Entra **OAuth app consents**. No ADR imports **agent registries**. This is integration, not IGA, so it stays inside the PRODUCT_GOALS refusal. |
| **G7** | **A portable, verifiable agent credential** that a third-party enforcement point (Kong, agentgateway, a SaaS MCP server) can check offline: a signed scope plus a delegation chain, matching the "open specifications" ServiceNow claims. | 7 (1) | M | `jose` (MIT), already in use; `oidc-provider` (MIT), already in use | ServiceNow AI Passport (primary), PANW + CyberArk (secondary) | ADR-0210 signs a 60-second assertion **for MCP only**. ADR-0238 (RFC 8693 outbound, Proposed) is the nearest. Nothing issues a credential verifiable outside RegulAIt for A2A or third-party gateways. Partly queued, so ranked below G1–G6. |
| **G8** | **Agent-session memory into the Shared Project context store**: distil governed agent sessions into provenance-tagged, entitlement-gated shared context. | 4 | M | none found that fits governed provenance; build | Atlassian Teamwork Graph session memory (secondary, 2026-10-08) | No ADR or PENDING hit for session memory or distillation. |
| **G9** | **Paid-tool and agent-payment budgets**: price per paid MCP or API call (x402, Cloudflare Monetization Gateway), budget at authorisation, reconcile at settlement. | 5 | S–M | x402 reference implementation (licence unverified) | Cloudflare (secondary, closed beta) | No hit for x402, AP2 or agent payments. Emerging; low urgency. |
| **G10** | **MCP 2026-07-28 spec conformance check** (stateless servers, OAuth/OIDC hardening, deprecation policy, MCP Apps extension) for the gateway's MCP client and server sides. | 1 | S | `@modelcontextprotocol/sdk` (MIT), when it ships the revision | AAIF (secondary; RC vs final unverified) | ADR-0185 already runs streamable HTTP, stateless and one transport per request. No ADR names the 2026-07-28 revision. Likely mostly done; needs a check, not a build. |
| **G11** | **AIUC-1 control mapping pack** | 3 | S | data only | Credo AI (secondary, unverified) | No hit for AIUC. The pack framework exists (ADR-0215, ADR-0295). |

### 3b. Already queued; urgency rose since August

| Item | Pillar | Size | Why it moved up | Where queued |
|---|---|---|---|---|
| **Third-party attestation** (SOC 2 Type II, ISO 27001, ISO 42001) **and a pen test** | 3 | L | Every vendor profiled above leads with its attestations; Atlas and Lovable included. For a security-led buyer this is the first filter. | PENDING first table, P3; DELIVERY_PLAN "owner-gated"; ADR-0167 deferred D4 |
| **A first live model provider; PM adapters verified on live tenants** | 1, 8 | M | Competitors' claims are all live. RegulAIt's adapters are "proven against fake servers" (PRODUCT_GOALS), and no LLM provider is connected yet. | PENDING first table, P1 |
| **Release-key ceremony and supply-chain provenance** | 3 | S | LiteLLM's 2026-10-21 signed-malware release shows a signing pipeline is itself a target; a real offline key is a selling point now. | PENDING S3 |
| **Vendor-specific SIEM adapters** (Splunk HEC, Sentinel, OCSF) | 1 | S–M | ServiceNow, Check Point and Prisma AIRS all integrate with SOC tools. The generic signed webhook delivery is built (ADR-0303); vendor-specific adapters are not (ADR-0303 point 4). | ADR-0303 |
| **RFC 8693 down-scoped upstream credentials** | 1 | M | Per-user, per-tool upstream tokens are what the identity-plus-gateway vendors now market. | ADR-0238 (Proposed) |
| **On-device enforcement beyond slice 1** | 1 | M | GitHub and Claude Code enforce on the client; Credo Agent Governor hooks the harness. | ADR-0298 (Proposed, default off) |

---

## 4. Where RegulAIt leads (re-tested 2026-11-14)

1. **The compliance cascade (pillar 3).** No profile found ships one classification tag that drives workflow
   stages, connector and MCP scopes, retention (now evidence retention too, ADR-0302) and PII mode. ServiceNow's
   policies are the nearest, and they are policy-to-agent, not tag-to-everything.
2. **MCP supply-chain depth.** Admission scanning with RFC 9728 discovery (0097), scheduled re-scan (0100), federated
   registries (0101), consent bound to target and policy (0105, 0166), definition pinning with rug-pull detection
   (0246, Proposed), governed bundles (0236), Cisco scanner engines (0242, Proposed, slices built), OWASP MCP Top 10 pack (0243), endpoint config
   discovery (0259). GitHub's allowlist matches by URL, command or name. Kong filters per caller. Neither pins tool
   definitions or binds consent to arguments.
3. **Metered vs imported cost kept apart in the schema** (ADR-0069 CHECK constraint). Every new pillar-5 entrant
   (ServiceNow, Atlassian, Flexera) blends sources into "one view". The honesty spine is still unique. G1 keeps it.
4. **Tighten-only delegation as a tested, cross-vendor invariant** (ADR-0016, 0078, 0219). ServiceNow now *claims*
   narrowing delegation for its own Passport; RegulAIt's is a conformance suite across vendors.
5. **Air-gapped as code, plus supply-chain posture.** Code-enforced egress (0062), signed update bundles (0041),
   Kubernetes operator that rolls out only a verified bundle (0304), pinned and vendored dependencies (0176, 0199).
   The LiteLLM incident makes this concrete for buyers.
6. **Neutral decision and approval records across PM tools** (pillar 8). Jira and ADO each audit their own agents.
   Nobody records approvals and decisions across Jira, ADO and Linear in one hash-chained trail (0060).
7. **Regulatory breadth in-product.** EU AI Act tiering (0085), NIST and ISO packs, MITRE ATLAS techniques (0293),
   GDPR, NIS2, DORA and CRA incident clocks (0296), framework imports (0215). Credo and IBM have breadth without
   gateway enforcement; gateways have enforcement without breadth.

**Where August's lead eroded:** per-user tool-level MCP ACLs (Kong 2.x, Cloudflare, GitHub), agent identity with a
kill switch (ServiceNow, Google, Microsoft), and the cross-vendor cost story as a *pitch*: four vendors now say
"one view of AI spend".

---

## 5. Source register

All read 2026-11-14. **P** = primary (vendor page, changelog or press release read directly, or its official
title and snippet); **S** = secondary.

| Topic | Source | Class |
|---|---|---|
| Cursor Oct–Nov releases | https://cursor.com/changelog | P |
| GitHub Nov 2026 changelog | https://github.blog/changelog/ | P |
| GitHub MCP allowlists, 2026-08-06 | https://github.blog/changelog/2026-08-06-mcp-allowlists-in-enterprise-managed-settings | P |
| GitHub default enablement, Sept 2026 | https://github.blog/changelog/2026-09-24-default-enablement-of-copilot-features-for-copilot-business-and-enterprise | P (title only) |
| Anthropic news Sep–Nov 2026 | https://www.anthropic.com/news | P |
| Claude Code managed settings | https://code.claude.com/docs/en/managed-settings | P (snippet) |
| Codex admin setup | https://developers.openai.com/codex/enterprise/admin-setup | P (snippet) |
| Codex governance (third-party guides) | https://codex.danielvaughan.com/topics/enterprise-and-governance/ | S |
| OpenAI Frontier | https://openai.com/business/frontier/ ; https://axios.com/2026/02/05/openai-platform-ai-agents | P (snippet) / S |
| Cognition budgets, SWE-2, Series E | https://ffnews.com/news/who-pays-for-ai-coding-agents-cognition-s-new-enterprise-solution-8eefe340 ; https://thenewstack.io/22842541cognition-devin-hierarchical-budgets/ (403) ; https://www.channelinsider.com/ai/news-cognition-devin-2b-funding-48b-valuation/ | S |
| Lovable Series C | https://siliconangle.com/2026/08/12/vibe-coding-startup-lovable-doubles-valuation-13-3b-400m-raise/ | S |
| Atlas | https://atlasapp.ai | P |
| LiteLLM incidents and releases | https://docs.litellm.ai/blog/tags/incident-report ; https://docs.litellm.ai/release_notes/ | P |
| Prisma AIRS AI Gateway GA | https://www2.paloaltonetworks.com/blog/2026/07/announcing-general-availability-of-prisma-airs-ai-gateway.md/ | P (snippet) |
| Kong AI Gateway 2.0 | https://konghq.com/blog/product-releases/kong-ai-gateway-2-0-ga | P |
| Kong AI Gateway 2.2 | https://unite.ai/kong-ships-ai-gateway-2-2-with-mcp-tool-governance-identity-policies | S |
| Cloudflare spend limits and identity budgets | https://developers.cloudflare.com/changelog/post/2026-06-05-spend-limits/ ; https://www.crnasia.com/news/2026/cybersecurity/cloudflare-expands-ai-gateway-with-identity-controls-and-ai ; https://thenewstack.io/cloudflare-x402-agent-spending/ | P (URL) / S |
| TrueFoundry | https://www.truefoundry.com/press-room/truefoundry-expands-uk-presence-to-help-enterprises-scale-ai-with-control-governance-and-data-sovereignty | P (snippet) |
| Langfuse → ClickHouse | https://clickhouse.com/blog/clickhouse-acquires-langfuse-open-source-llm-observability ; https://langfuse.com/blog/joining-clickhouse | P |
| Arize AX Sept 2026 | https://arize.com/blog/new-in-arize-ax-september-2026-updates/ | P (title) |
| Check Point / Lakera | https://docs.lakera.ai/changelog/2026-06-01 ; https://securitybrief.news/story/check-point-launches-ai-defence-plane-for-enterprise | P (snippet) / S |
| Credo AI Agent Governor | https://www.credo.ai/blog/introducing-credo-ai-agent-governor ; https://www.credo.ai/agent-governor | P |
| IBM watsonx.governance | https://community.ibm.com/community/user/blogs/maria-godoy/2026/05/11/operationalizing-ai-assurance-at-scale-watsonxgove | S |
| ServiceNow AI Passport | https://investor.servicenow.com/news/news-details/2026/ServiceNow-advances-its-operational-harness-for-enterprise-AI-with-AI-Passport-and-expanded-governance-capabilities/default.aspx | P |
| ServiceNow Control Tower Alliance | https://investor.servicenow.com/news/news-details/2026/ServiceNow-launches-Control-Tower-Alliance-to-help-enterprises-adopt-AI-safely-at-scale/default.aspx | P (title) |
| Agent 365 at Ignite 2026 | https://techcommunity.microsoft.com/blog/agent-365-blog/microsoft-ignite-2026-your-guide-to-agent-365/4571750 | P (title) |
| Microsoft Agent Framework / Foundry | https://devblogs.microsoft.com/foundry/whats-new-in-microsoft-foundry-build-2026/ | P (snippet) |
| Google Gemini Enterprise Agent Platform | https://cloud.google.com/blog/products/ai-machine-learning/whats-new-in-gemini-enterprise-agent-platform | P (snippet) |
| AWS AgentCore / Bedrock cost attribution | https://aws.amazon.com/about-aws/whats-new/2026/04/agentcore-new-features-to-build-agents-faster/ ; https://aws.amazon.com/blogs/machine-learning/introducing-granular-cost-attribution-for-amazon-bedrock/ | P (snippet) |
| Agents in Jira; Team '26 Europe | https://community.atlassian.com/forums/Jira-articles/Introducing-Agents-in-Jira/ba-p/3194583 ; https://nand-research.com/atlassian-team-26-europe-announcements-context-governance-at-the-center-of-agentic-work/ | P (snippet) / S |
| Azure Boards → Copilot | https://learn.microsoft.com/en-us/azure/devops/boards/github/work-item-integration-github-copilot | P (snippet) |
| MCP 2026-07-28 spec / AAIF | https://aaif.io/blog/mcp-graduates-to-enterprise-infrastructure-stateless-architecture-formal-governance-and-security ; https://venturebeat.com/orchestration/mcp-just-got-its-biggest-update-ever-heres-what-changes-for-ai-agents | P (title) / S |
| agentgateway joins AAIF | https://agentgateway.dev/blog/2026-06-04-agentgateway-joins-aaif/ | P (title) |
| OTel GenAI conventions status | https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/ ; https://www.dash0.com/knowledge/opentelemetry-genai-semantic-conventions-explained | P / S |
| Cyera–Oasis | https://www.securityweek.com/cyera-acquiring-oasis-security-in-1-billion-deal/ ; https://securitybrief.co.uk/story/cyera-completes-usd-1-billion-oasis-security-deal | S |
| Proofpoint–Acuvity | https://www.proofpoint.com/us/newsroom/press-releases/proofpoint-acquires-acuvity-deliver-ai-security-and-governance-across | P (title) |
| MCP-gateway funding | https://www.superbcrew.com/runlayer-raises-30m-series-a-funding-round/ ; https://obot.ai/obot-ai-secures-35m-seed-to-build-enterprise-mcp-gateway/ ; https://pulse2.com/neuraltrust-raises-20-million-to-secure-enterprise-ai-agents/amp/ | S |
| AI FinOps entrants | https://www.revefi.com/blog/best-ai-finops-tools ; https://www.techtarget.com/searchcloudcomputing/news/366644897/AWS-launches-FinOps-agent-expands-bedrock-cost-tracking ; https://itbrief.news/story/revenium-unveils-tool-registry-to-track-full-ai-costs | S |
| Warp Factories / Linear agents | https://warp.dev/factories ; https://linear.app/agents | P (vendor pages) |
| Obsidian Security AI Agent Security (added 2026-11-16) | https://www.obsidiansecurity.com/ai-agent-security | P |
| Camunda agentic orchestration (added 2026-11-16) | https://camunda.com/ ; https://camunda.com/platform/ ; https://camunda.com/what-is-agentic-orchestration/ | P |
| DarkControl AIDR (added 2026-11-17) | https://darkcontrolai.com/ ; https://darkcontrolai.com/platform.php ; https://darkcontrolai.com/features.php | P |
| Manifold Security AIDR (added 2026-11-17) | https://www.manifold.security/ ; https://www.manifold.security/blog ; https://github.com/manifold-security/agentaudit | P |
| KrakenD AI Gateway (added 2026-11-17) | https://www.krakend.io/ai-gateway/ ; https://www.krakend.io/docs/enterprise/ai-gateway/ ; https://github.com/krakend | P |

**Not found / unverified:** Agent HQ GA; any Windsurf news after August; Holistic AI Guardian Agents GA date;
Credo AIUC-1 integration; Codex Admin plugin year; Runlayer Series A date; Kong 2.1 timing; MCP 2026-07-28 RC vs
final; Cyera–Oasis completion (one source). Re-check Microsoft after Ignite (2026-11-17 to 19) and AWS after re:Invent
(December).
