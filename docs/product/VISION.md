# RegulAIt — Product Vision

> Source: feature research brief on Atlas, Cursor, and Lovable, provided by the user during
> bootstrap planning (2026-07-21). Reproduced here verbatim so it is never lost to session
> memory. The two P0 core requirements synthesized from this research are broken out into their
> own full specs: [GOVERNANCE_LAYER_SPEC.md](GOVERNANCE_LAYER_SPEC.md) and
> [WORKFLOW_ENGINE_SPEC.md](WORKFLOW_ENGINE_SPEC.md). Everything in this document should be read
> as sitting *on top of* those two pillars, not alongside them as equal-priority items.

**Purpose:** This document is a consolidated feature inventory of three AI-native software
platforms — Atlas (atlasapp.ai), Cursor (cursor.com), and Lovable (lovable.dev) — intended as a
reference brief for building a similar product. Each section documents what the product does,
how it's structured, and features not obvious from the marketing homepage alone.

> **⭐ TOP-PRIORITY CORE REQUIREMENTS:** Beyond replicating the features of Atlas, Cursor, and
> Lovable, RegulAIt must have two first-class, non-optional architectural pillars — not bolt-on
> Enterprise upsells:
> 1. **A unified governance and access-control layer** — every connector, every agent/model
>    (including any publicly available third-party agent), and every MCP server must be
>    governable **per individual user**, independent of role defaults, by an admin.
> 2. **A configurable workflow engine** — every development request must be routable through an
>    admin-defined, multi-stage workflow (e.g., Plan → requirements sign-off → build → PR → merge
>    approval → conditional auto-deploy), with support for **multiple named workflows** that can
>    be assigned — individually or in combination — based on the tool, system, or type of code
>    being changed.
>
> Both are P0 requirements for any build plan, not phase-2 additions, and every feature described
> below should be understood as running *through* these two layers.

**Sources:** Official websites, product docs, changelogs, and pricing/FAQ pages (accessed July
2026).

---

## 1. Atlas (atlasapp.ai)

### What it is
Atlas is **not a coding tool** — it's an enterprise "AI factory" / agentic-infrastructure
platform that deploys **inside a customer's own cloud** (AWS, Azure, or GCP — "Bring Your Own
Cloud," BYOC). It positions itself as software that understands a company's existing systems of
record (SAP, Salesforce, ServiceNow, Snowflake, etc.), modernizes legacy applications, and
builds/ships/operates automations, agents, and internal apps — all while data and code never
leave the customer's cloud perimeter. Its buyer is enterprise IT/ops leadership (CIOs, CISOs),
not individual developers.

### Core product surfaces

| Surface | What it does |
|---|---|
| **Chat** | Natural-language Q&A grounded across every connected system of record. Can blend data from multiple systems (e.g., SAP + Databricks) and generate answers, visualizations, and slide decks. Can also **write results back** into source systems/databases, not just read. |
| **Build** | Describe an automation, agent, or app in plain language; Atlas designs, builds, tests, and ships it directly into the customer's cloud — "no infrastructure to wire up." Outputs are tracked as **Projects** with a type (Automation / Agent / App), a source cloud (AWS/Azure/GCP), an "Initiative" grouping, build status (Building/Ready), and last-updated timestamp. |
| **Catalog** | Maps the customer's *entire existing application estate* (stack, architecture, data dependencies). For each legacy app, Atlas produces a "DNA" assessment and recommends one of three paths: **rebuild**, **AI-enable**, or **retire** — then executes the chosen path inside the customer's cloud. |
| **Connect** | - **Sources**: read-only connectors to systems of record (SAP, Salesforce, ServiceNow, Databricks, Snowflake, BigQuery, HubSpot, Zendesk, Gong, Slack, Clay, spreadsheets/CSV, PostgreSQL, ClickHouse, Google Cloud Storage, Aha!, etc.) — data is accessed in place, never copied out.<br>- **Connectors**: pre-approved integration building blocks.<br>- **Model Context Protocol (MCP) servers**: Atlas *provisions governed MCP servers inside the customer's own VPC* so agents, apps, and third-party assistants (e.g., Claude, other LLM copilots) can call internal systems under the customer's IAM policy, with per-server tool counts, run status, and OAuth connection state shown in a management table. |
| **Console** | Operational/admin surface: **Activities** (a live log of every patch, sync, model evaluation, and automation run, each tagged Resolved/Passed/Sent), **Resources**, **API keys**, **Users**, **Account**, and **Usage** (e.g., inference spend trend, model-routing savings). |

### Governance & platform philosophy ("Autonomous and sovereign, by design")
- **Runs itself**: patching, scaling, upgrades, and cost tuning happen automatically, gated by customer-defined evals.
- **Sovereign by architecture**: agents/apps run inside the customer's own cloud accounts under the customer's IAM; data never leaves the customer's perimeter.
- **Governed by default**: any write action pauses for human approval; secrets and PII are redacted in-flight; every action is logged.
- **"Current without the churn"**: Atlas continuously evaluates new model releases, price changes, and provider capability shifts, and automatically adopts what's better — customers don't have to manually chase model upgrades.

### CIO/CISO-focused controls (enterprise trust layer)
- Agents/apps run inside the customer's VPC with private networking and isolation; service accounts use least-privilege access.
- Custom domains with SSL and dedicated load balancers.
- **Anti–shadow-IT**: only pre-approved building blocks/connectors are usable; fine-grained allow-lists per team/individual for data and connectors; policy enforcement blocks unauthorized software creation; automated code scanning pre-deployment.
- **Full governance**: complete audit trail from prompt → deployment; activity logs streamable to the customer's SIEM; automated compliance/attestation reports; automated vulnerability detection and remediation.
- **Object-level access control UI**: admins can scope a given user's access to specific sources, connectors, initiatives, apps, and agents (not just role-based access) — "select specific" vs. "All" (current + future) permission model.
- Compliance posture: SOC 2 Certified; SOC 2 Type II and ISO 27001 listed as "In Progress" at time of writing.

### Pricing model
Custom/usage-based — no self-serve tiers. Pricing scales along four axes: (1) number of agents/apps the customer plans to ship, (2) connectors/data sources needed, (3) number of environments (sandbox/staging/production) with CI/CD, and (4) support tier (SLA, onboarding, architecture guidance, compliance assistance). No public price list; sales-assisted "Get a demo" / "Get a custom quote" motion only. Pilot programs are offered before full rollout.

### Illustrative use-case library (shown as pre-built templates on the site)
Grouped into three categories, each with concrete example "apps" that combine an app type (Automation/Agent/App), a set of data connectors, and a target team:
- **Revenue & Go-to-Market**: ROI calculators, CPQ/discount approval agents, sales commission engines, customer-health/churn intelligence, lead routing & enrichment, contract true-up & entitlement tracking.
- **Enterprise Operations**: SAP/ERP natural-language assistant, invoice/PO matching automation, order management & turnaround coordination, predictive maintenance (IoT + SAP PM), IT service-catalog ticket auto-fulfillment, security/compliance/AI-governance (phishing simulations, training tracking, EU AI Act inventory).
- **Analytics & Decision Apps**: demand forecasting, spend analytics/procurement optimization, product usage/adoption intelligence, usage-decline/churn-risk monitoring, revenue & scenario forecasting.

### Notable characteristics for a similar product to emulate
- The **BYOC / sovereign-cloud deployment model** is the core differentiator versus a typical SaaS AI tool — it directly targets enterprises that cannot send data to a third-party cloud.
- **In-VPC MCP server provisioning** is a distinctive mechanism: rather than the platform calling customer systems from *its* cloud, it stands up MCP servers *inside* the customer's cloud that any downstream agent/assistant can call under the customer's own IAM.
- The "Catalog → assess → rebuild/AI-enable/retire" workflow packages application modernization as a structured, staged product feature, not just an ad hoc consulting exercise.
- Autonomous "runs itself" operations (patch/scale/model-upgrade evaluation) plus a nightly/overnight "Activities" log designed to be reviewed asynchronously ("your team reviews outcomes over coffee") is a UX pattern worth studying for autonomous-ops products.

---

## 2. Cursor (cursor.com)

### What it is
Cursor is an **AI coding agent / AI-native IDE** built by Anysphere. It's positioned as "your coding agent for building ambitious software," spanning desktop editor, CLI, cloud/background agents, mobile, and integrations into GitHub, Slack, Linear, and JetBrains IDEs. It is aimed at professional software engineers and engineering organizations (64% of the Fortune 500 reportedly use it), not non-technical builders.

### Surfaces / where Cursor runs
| Surface | Description |
|---|---|
| **Desktop app** | Full IDE (VS Code–based) with manual editing, Tab-completion, Cmd+K inline edits, and full agent mode, macOS/Windows/Linux. |
| **CLI (`cursor-agent`)** | Runs the same agent in any terminal, script, or CI job. Installed via `curl https://cursor.com/install -fsS \| bash`. Supports headless/scripted mode, shell mode with safety checks, and GitHub Actions integration. |
| **Cloud / Background Agents** | Agents run autonomously in isolated cloud VMs (their "own computers"), building/testing/demoing features end-to-end while the user is away; results are reviewed later. Multiple agents can run in parallel across different tasks/repos. |
| **Web** (cursor.com/agents) | Browser dashboard to launch and monitor cloud agents without the desktop app. |
| **Mobile (iOS, public beta; Android referenced)** | Launch/manage cloud agents from a phone: pick a repo, choose any frontier model, use voice input, slash commands. Includes **Remote Control** (take over an agent that's running on your desktop, from your phone), **Live Activities**/push notifications on lock screen, and in-app review of demos/screenshots/diffs with the ability to merge PRs from the app. |
| **Other integrations** | GitHub (PR review via Bugbot, "@cursor" mentions), Slack (chat-driven agent that now shares a plan before starting, supports multi-repo environments, and can read/post across channels/threads), Linear, JetBrains IDEs (via ACP - Agent Client Protocol), Azure DevOps/GitLab/Bitbucket for repo and plugin sync. |

### Core agent capabilities
- **Delegated agent execution**: describe a feature/bug in natural language; Cursor explores the codebase, plans, edits multiple files, runs terminal commands, and iterates — while the user "focuses on higher-level direction."
- **Full model choice**: switch between frontier models from OpenAI, Anthropic, Google Gemini, xAI Grok, and Cursor's own in-house model ("Composer"), including an "Auto" mode that picks the suggested model.
- **Subagents**: for complex tasks, multiple subagents run in parallel, each assigned to a different model/subtask, to explore the codebase faster.
- **Codebase indexing / semantic search**: a custom embedding model gives the agent "best-in-class recall" across very large codebases.
- **Team/workspace rules**: persistent instructions ("Cursor Rules") teach the agent team conventions and architectural decisions so its output matches house style.
- **Modes across the dev lifecycle**: **Plan** (clarifying questions, structured plan, then execute), **Design** (visual UI editing in live preview), **Debug** (instruments code, captures logs/screenshots/network traffic to find root causes from real execution data).
- **Terminal access**: runs shell commands directly, sandboxed by default.
- **Context/@-mentions**, **Git & checkpoints** (rollback to any prior snapshot), **prompt queueing** (reorder/edit/pause/repeat).
- **Extensibility**: Plugins (capability packs), Skills (reusable slash-command playbooks), MCP (external tool/data sources), Hooks (lifecycle hooks around tool execution and the agent conversation itself — `beforeSubmitPrompt`, `afterAgentResponse`, `afterAgentThought`, `stop`, `subagentStart`, etc.).

### Bugbot (AI code review product)
A distinct, separately-branded product that automatically reviews GitHub PRs, posts inline comments describing real logic bugs with suggested fixes, low false-positive rate. Customizable via "Bugbot Rules."

### Enterprise & security features
- SOC 2 Type II certified with regular penetration testing (public Trust Center).
- Zero data retention with Cursor and underlying LLM providers when Privacy Mode is enabled.
- SAML-based SSO and SCIM provisioning.
- Centralized admin controls: global model access policy, MCP server allow/deny lists, repo whitelisting/blacklisting, agent run rules (auto-run, browser, network controls).
- AES-256 at rest, TLS 1.2+ in transit; GDPR/CCPA compliance.
- AI code-tracking API (exportable adoption/productivity analytics).
- **Organizations** feature: multiple teams/orgs under one governance umbrella.
- Runs on SOC 2 Type II–compliant AWS infrastructure; no on-prem/VPC deployment option (unlike Atlas).

### Pricing structure
| Plan | Price | Notes |
|---|---|---|
| Hobby | Free | Limited Agent requests and Tab completions |
| Individual (Pro / Pro+ / Ultra) | From $16/mo | Extended agent limits, frontier model access, MCPs/skills/hooks, cloud agents |
| Teams (Standard / Premium) | From $32/user/mo | Centralized billing/admin, Bugbot included, shared team context, SAML/OIDC SSO |
| Enterprise | Custom | Pooled usage, SCIM, repo/model/MCP access controls, audit logs, AI code-tracking API |

### Features only visible in changelog/docs
Side chats, conversation search, redesigned repo/branch/project pickers, Team Marketplaces (org-approved MCP/plugins/skills), plugin canvases, auto-review Run Mode, Shared Canvases + `/loop` skill, Slack agent upgrades, Automations (scheduled/event-triggered agents), Customize page (single settings surface for plugins/skills/MCPs/subagents/rules/commands/hooks).

### Notable characteristics for a similar product to emulate
- Depth of **developer workflow integration** (terminal, CI, Slack, mobile, JetBrains, GitHub) rather than breadth of business use cases.
- Plan/Build mode split, subagents-in-parallel pattern, and lifecycle hooks around the agent's own reasoning are strong patterns.
- Bugbot: narrow, high-precision automated code review as a viable adjacent product.
- Layered extensibility model — Plugins → Skills → MCP → Hooks — is reusable architecture for an extensible agent platform.

---

## 3. Lovable (lovable.dev)

### What it is
A **full-stack AI app builder ("vibe coding")** platform: describe an app in chat, get a complete, editable, real-code web app (frontend, backend, database, auth, integrations), iterate conversationally, deploy with one click. Broad audience: solo founders/non-developers, PMs/designers/marketers, professional developers/agencies, enterprises.

### Core building experience
- **Plan mode** (pure reasoning, never edits code) → produces a structured, editable **Plan** (`.lovable/plan.md`: overview, key decisions/assumptions, components/data models/APIs, step sequencing). Approving switches to **Build mode** (autonomous execution across frontend/backend/config, browser testing, asset generation, external docs lookup).
- Prompt queue (reorder/edit/pause/repeat up to 50x), @-mention file references, cross-project referencing, design previews, preview toolbar (visual editing), project comments, subagents (parallel sub-investigations), workspace Skills, workspace/project Knowledge (persistent standing instructions), data upload/analysis, Code mode (hand-edit generated source), Templates, Design systems (Business/Enterprise), Environments (Test vs. Live).

### Lovable Cloud (built-in backend, on Supabase)
Database (NL schema gen, daily backups ~14-day retention), Users & Auth (email/phone/Google/Apple, leaked-password protection), Storage (private-by-default), Edge Functions, Jobs (scheduled tasks), Built-in AI (no-API-key chatbots/summarization/etc.), Secrets manager, Logs/Usage/health-check/auto-optimization, Region selection, Pause/Resume/Remove, one-per-day DB export for migration off-platform.

### Publishing & operations
One-click Publish (public/workspace-only/restricted access), branded workspace URLs + custom domains, branded transactional emails, project analytics, SEO/AEO tooling, built-in Stripe/Paddle payments.

### Security (heavily documented, enterprise-oriented)
- **Basic scan** (free, continuous, pre-publish): RLS policy linting, schema review, dependency audit.
- **Deep scan** (on-demand, agentic): access-control review, backend auth checks, code-level vuln detection, project-specific "security memory."
- Optional third-party connectors: **Wiz** (SCA+SAST) and **Aikido** (AI-driven pentest, SOC2/ISO27001-ready reports).
- Auto-fix for eligible critical findings; conversational security review on request.
- Project Security view + workspace Security center (Enterprise): aggregate findings, CSV export, scheduled recurring Deep scans.
- Sensitive data (PII) scanning & "chat send protection" (Enterprise): Log only / Ask before sending / Block original.
- Publishing gates: block on unresolved critical findings; require Basic scan before first publish; block on unresolved PII findings (Enterprise).
- Compliance: SOC 2 Type II, ISO 27001:2022, GDPR/DPA. **Not HIPAA-compliant** — no BAAs, PHI upload disallowed.

### Enterprise/Business governance
SSO (OIDC/SAML2) with enforceable session duration, SCIM with group-to-role mapping, 2FA, verified-domain auto-provisioning; Roles (Owner/Admin/Editor/Viewer/External-collaborator) + Groups + Restricted projects; Audit logs (~90-day retention, SIEM forwarding); data training opt-out; app login method lock-down; publishing controls (restrict external publish); per-member credit limits; code residency/self-hosting (GitHub Enterprise Cloud/Server, GitLab); Build secrets (Enterprise).

### Integrations ecosystem
50+ app connectors (Airtable, AWS S3, BigQuery, Databricks, GitHub/GitLab, HubSpot, Linear, Microsoft 365, Notion, Salesforce, Slack, Snowflake, Stripe, Supabase, Twilio, etc.), mostly OAuth/managed-gateway. Separately: MCP as chat connectors (consuming external MCP servers like Notion/Linear/Jira/Miro), and a **Lovable MCP server** (`mcp.lovable.dev`) exposing Lovable itself as an MCP server so external AI clients can create projects, send build messages, inspect code/diffs, manage a Cloud database, read/set workspace "knowledge" (governance policy), manage connected MCP servers, pull analytics, deploy. "Build with URL" API, general Lovable API, native desktop/mobile apps.

### Pricing model (usage-credit based)
Free (5 daily credits), Pro (from $25/mo/100 credits), Business (~2x Pro), Enterprise (custom — SCIM, audit logs, scheduled Deep scans, PII scanning, design systems, build secrets, GitHub Enterprise, dedicated account team). Credits don't roll over on Free; roll over one cycle on paid plans; message cost scales with complexity.

### Notable characteristics for a similar product to emulate
- Explicit **Plan/Build mode split** (converging industry-standard pattern): separate "think and decide" from "execute," with a durable, editable plan artifact in between.
- **Lovable Cloud**: complete batteries-included backend-as-a-feature on an open-source foundation (Supabase) rather than proprietary — fast friction removal while still producing a portable codebase.
- **Credit-based, complexity-priced usage model** with free daily credits as a habit mechanic, roll-over rules, per-member caps.
- **Dual-direction MCP strategy** (consume external MCPs as chat connectors *and* expose itself as an MCP server) — most sophisticated interoperability model of the three.
- **Two-scanner + two-vendor security architecture** (fast always-on Basic, deep agentic Deep, pluggable Wiz/Aikido) — clean layering of "good enough by default" with paid upsells for regulated customers.

---

## 4. Cross-Product Comparison

| Dimension | Atlas | Cursor | Lovable |
|---|---|---|---|
| **Primary user** | Enterprise IT/ops leadership | Professional software engineers | Broad: non-devs → devs → enterprises |
| **What it builds** | Internal automations, agents, apps; modernizes legacy apps | Any software, via an AI-augmented IDE/agent | Full-stack web apps (frontend+backend+DB) |
| **Deployment model** | Inside customer's own cloud (BYOC) | Cursor-hosted (AWS); local desktop for editing | Lovable-hosted (Lovable Cloud/Supabase) or synced to customer's GitHub/self-hosted infra |
| **Core interaction unit** | NL "Build" request → automation/agent/app project | NL request → agent edits real repo | NL chat → Plan → Build → live app |
| **Data/code residency control** | Full (never leaves customer cloud) | Zero data retention option; no on-prem/VPC hosting | Configurable: Lovable Cloud default, GitHub Enterprise/self-host for Enterprise |
| **Distinctive extensibility** | In-VPC MCP server provisioning for downstream agents | Plugins + Skills + MCP + lifecycle Hooks | 50+ app connectors + inbound/outbound MCP |
| **Built-in code review/security** | Automated vulnerability detection & remediation, platform-wide | Bugbot (separate product) | Basic/Deep scanners + Wiz/Aikido connectors |
| **Pricing** | Custom/usage, sales-assisted only | Free → $16+/mo individual → $32+/user/mo team → custom | Free → credit-based Pro/Business → custom enterprise |
| **Compliance certifications mentioned** | SOC 2 (Certified); SOC2 Type II & ISO 27001 "in progress" | SOC 2 Type II, GDPR, CCPA | SOC 2 Type II, ISO 27001:2022, GDPR; explicitly NOT HIPAA |

---

## 5. Suggested Feature Checklist for RegulAIt

> Governance and the workflow engine are deliberately not repeated here — full specs in
> [GOVERNANCE_LAYER_SPEC.md](GOVERNANCE_LAYER_SPEC.md) and
> [WORKFLOW_ENGINE_SPEC.md](WORKFLOW_ENGINE_SPEC.md) — and should be read as sitting *underneath*
> every category below.

**Core agent loop** *(the fuller, admin-configurable workflow spec generalizes this)*
- Natural-language request → plan/clarify → execute → verify → summarize, with a distinct planning-only mode that never mutates code/state.
- Visible, step-by-step execution log (files touched, tools called, commands run).
- Checkpointing/versioning with one-click rollback to any prior state.
- Prompt queueing with reorder/pause/repeat.
- Parallel subagents for large/multi-part tasks, each optionally on a different model.

**Model & infrastructure flexibility**
- Multi-provider model choice (OpenAI/Anthropic/Google/etc.) plus an "auto-pick best model" default.
- Choice of hosting: managed cloud vs. customer-owned cloud/VPC (regulated enterprises) vs. self-hosted/exported code.

**Extensibility**
- Plugin/marketplace system for community or team-built capability bundles.
- Reusable "skill"/playbook macros triggerable by slash-command or automatically by task type.
- Two-way MCP support: consume external MCP servers as tools, and expose the platform itself as an MCP server.
- Lifecycle hooks (pre/post tool call, pre/post agent turn) for observability and custom guardrails.

**Backend/app-layer batteries** (if building full apps, à la Lovable)
- Managed database, auth, file storage, serverless functions, scheduled jobs, secrets management with zero manual infra setup.
- One-click publish with configurable audience.
- Built-in analytics for published apps.

**Security & governance** *(full spec in GOVERNANCE_LAYER_SPEC.md — summarized for completeness)*
- Fast, always-on baseline scanner (deps, access-control misconfig) plus optional deep/agentic scanner.
- Pluggable third-party SAST/DAST/pentest integrations.
- PII/sensitive-data detection with configurable block/warn/log enforcement at chat entry and at rest.
- Full audit logging with SIEM export, SSO/SAML, SCIM, granular per-user access control across agents/connectors/MCP servers.

**Token & cost optimization** *(standard feature area, not a third P0 pillar — full spec in [TOKEN_OPTIMIZATION_SPEC.md](TOKEN_OPTIMIZATION_SPEC.md))*
- Native prompt caching and cost/token analytics dashboards, on by default.
- Governance-integrated model routing (never exceeds a user's existing entitlement ceiling) and a workflow-level cost-sensitivity tag mirroring the existing data-sensitivity tag.
- Opt-in semantic caching, context-graph tooling, and output-compression preferences — context-graph tooling defaults to local/code-only, per the exfiltration-risk finding in ADR-0005.

**Commercial model**
- A free tier generous enough for habitual use.
- Usage/complexity-based credit pricing rather than flat seats, with roll-over rules and team spend caps.
- A clearly gated Enterprise tier (custom contract) adding identity federation, audit, data residency, dedicated support.
