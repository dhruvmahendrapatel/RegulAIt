# RegulAIt — Market Analysis, 2026-08-15

**Status:** research snapshot, written 2026-08-15. Extends — does not repeat —
[COMPETITIVE_PARITY_PLAN.md](COMPETITIVE_PARITY_PLAN.md) (drafted 2026-08-07, wave complete same
day). That file's §0 verdicts stand and are *re-tested* here against what the field ships eight
days later; where a verdict has moved, this file says so explicitly.

**Method and honesty rules.** Everything below was verified by live web search on 2026-08-15
through the session's egress proxy. Every claim carries the date it was verified and, where known,
the date of the underlying event. Claims sourced only from third-party blogs (not the vendor) are
marked as such — pricing figures especially, since vendors reprice without notice. Nothing here is
asserted from model memory alone (assistant knowledge cutoff is 2026-01; the eight months since
contain most of what matters).

**Sources not reached.** `atlasapp.ai` is **blocked by this session's egress proxy** for direct
fetch. What is recorded about Atlas below comes from search-index snippets of its own pages
(retrieved 2026-08-15) and is thinner than every other profile — treat it as unverified beyond the
one-line positioning. No other target was unreachable.

---

## 0. What changed since the 2026-08-07 pass — the five findings that matter

1. **The gateway-governance category is being absorbed into security giants.** Palo Alto Networks
   announced its acquisition of **Portkey** on 2026-04-30 and closed it 2026-05-29, folding the
   gateway into Prisma AIRS (Palo Alto press releases, verified 2026-08-15). **Lakera** went to
   Check Point (announced Sept 2025, closed Q4 2025 — Check Point press, verified 2026-08-15).
   **Helicone** was acquired by Mintlify on 2026-03-03 and is in **maintenance mode** — new
   roadmap development stopped (helicone.ai/blog and mintlify.com/blog, verified 2026-08-15).
   Langfuse is described as "now part of ClickHouse" in August-2026 trade coverage (MarkTechPost,
   2026-08-09 — single-source class, not vendor-confirmed here). Consequence: fewer independent
   gateway competitors, but the survivors sit inside vendors with unlimited go-to-market budget.

2. **The platform vendors shipped pillar-1 for their own agents.** GitHub's **Enterprise AI
   Controls + agent control plane went GA 2026-02-26** (github.blog changelog): a consolidated
   AI-policy tab, audit logs with `actor_is_agent`, per-agent governance. Anthropic shipped
   (April 2026, per multiple trade writeups of the announcement) user groups with custom roles,
   per-user spend caps, **managed Claude Code policies** (enforced tool permissions, file-access
   restrictions, MCP server configuration) and a Compliance API; org/user spend limits with 75%/90%
   alerts followed 2026-07-02. **Microsoft Agent 365 GA'd 2026-05-01** as a unified agent registry
   + control plane over Entra Agent ID (conditional access, lifecycle workflows, access packages
   for agents) — $15/user/mo standalone per third-party coverage (bighatgroup.com, verified
   2026-08-15; price not vendor-confirmed here). Per-user, tool-level agent governance is no
   longer even *gateway-vendor* territory — it is a platform checkbox, one vendor at a time.

3. **The cross-vendor cost wedge (Slice C) is now contested from two directions.** From the
   call side: **Cloudflare AI Gateway added unified billing in 2026** — third-party model charges
   (OpenAI, Anthropic, Google AI Studio) consolidated onto one Cloudflare invoice (comparison
   coverage, verified 2026-08-15). From the invoice/SSO side: SaaS-management incumbents
   (**Torii, Zylo**, and peers) now market AI-spend modules that discover AI tools via SSO logs,
   browser signals and finance feeds, and break token spend down **by user, team and project for
   chargeback** (toriihq.com and zylo.com marketing, verified 2026-08-15). The FinOps Foundation
   reports 98% of practitioners now manage AI spend, up from 63% a year earlier (finops.org,
   verified 2026-08-15). The wedge is *narrowed, not gone* — see §3, pillar 5.

4. **The PM-tool pillar is under direct attack from the PM-tool vendor itself.** Atlassian's
   **Rovo Dev** is GA (devops.com, verified 2026-08-15): an agentic plan → generate → review →
   automate loop wired to Jira acceptance criteria via Teamwork Graph, plus a Jira launcher that
   opens work items directly in Claude Code, Cursor, Copilot or Codex with context pre-loaded
   (community.atlassian.com, verified 2026-08-15). GitHub's **Agent HQ** (public preview,
   verified 2026-08-15) centralizes third-party agents from Anthropic, OpenAI, Google, Cognition
   and xAI inside GitHub itself. Pillar 8's window is the fastest-closing of the eight.

5. **Runtime enforcement arrived in the compliance-governance tier.** The 2025-era "registry +
   policy-pack + questionnaire" products grew teeth in 2026: **ServiceNow AI Control Tower** now
   discovers/observes/governs/secures AI from any origin, acquired **Traceloop** for runtime agent
   observability, integrates Veza for identity, and can **shut down an off-policy agent in real
   time** (ServiceNow newsroom, 2026 releases, verified 2026-08-15). **Holistic AI** added Guardian
   Agents (observe + block/quarantine/revoke/kill) in 2026; **IBM watsonx.governance** added Agent
   Monitoring & Insights in Q1 2026 and holds the Gartner AI-governance Leader position (June
   2026). The GRC tier and the gateway tier are converging on RegulAIt's ground from above and
   below simultaneously.

---

## 1. Competitor profiles

Grouped as in the research brief. Format per entry: what ships today (pillar-relevant only) ·
pricing/deployment · conspicuous gaps. All verified 2026-08-15 unless noted.

### 1.1 AI coding / agent platforms

**Cursor (Anysphere).** Enterprise tier: SCIM, SAML SSO, audit logs, org-wide privacy mode,
pooled dollar credits, granular admin *and model* controls, an AI-code-tracking API, SOC 2 Type II
(third-party pricing guides dated July 2026: Teams $40/user/mo standard seat, $120 premium seat;
Enterprise custom). *Gaps:* SaaS only — no BYOC/air-gapped control plane; no cross-vendor cost
view; no multi-stage governed workflow (checks live in the customer's CI); no compliance cascade;
admin controls govern Cursor, not the customer's other AI estate.

**Devin (Cognition).** Core/Team $20–$500/mo billed in ACUs ($2.25/ACU pay-as-you-go per
third-party guides); Enterprise adds **VPC deployment where code never leaves the customer's cloud
boundary**, SAML/OIDC, teamspace isolation, central billing/usage analytics, and parallel fleets
for large migrations. *Gaps:* governs only Devin; no per-user entitlement model over third-party
tools; no compliance cascade; cost analytics are Devin-spend only.

**Windsurf (acquired by Cognition, ~Dec 2025, ~$250M per trade coverage — not vendor-confirmed).**
Free / Pro $20 / Max $200 / Teams $40 / Enterprise custom (repriced March 2026, credits → quotas).
Ships an **on-prem/self-hosted option running Cascade against a customer-hosted model gateway**,
zero-data-retention mode, and FedRAMP/HIPAA/ITAR positioning; 2026 additions: Plan Mode,
parallel multi-agent sessions (Wave 13, March 2026), Codemaps. *Gaps:* same shape as Cursor —
single-product governance, no org workflow engine, no cross-vendor anything.

**GitHub Copilot / Agent HQ.** The most consequential mover. **Enterprise AI Controls + agent
control plane GA 2026-02-26** (github.blog changelog): one AI-policy surface, audit logs with
agent attribution (`actor_is_agent`), coding agent with model selection, self-review, and free
security scanning on every agent PR. **Agent HQ** (public preview) brings Anthropic/OpenAI/
Google/Cognition/xAI agents under one GitHub-native mission control, with a Copilot SDK and CLI.
*Gaps:* GitHub-resident work only — no governance of AI use outside the repo perimeter; no
air-gapped mode below GHES-class deployments; no compliance-classification cascade; cost view is
Copilot-seat-shaped, not per-project dollars.

**Lovable.** Free / Pro $25 / Business $50 / Enterprise custom (third-party guides, July 2026).
SOC 2 Type II + ISO 27001; SSO on Business; SCIM + audit logs on Enterprise. *Gaps:* pure SaaS
app-builder; effectively nothing against pillars 1, 3, 5, 6, 7, 8 beyond its own seat admin.

**Atlas (atlasapp.ai) — thin evidence, direct fetch blocked.** Search snippets of its own pages
(2026-08-15) position it as an **"AI factory in your cloud"**: agentic infrastructure deployed
inside the customer's own cloud for building/running/scaling automations, agents and apps,
"nothing leaving your perimeter", with a partner motion for consulting firms deploying into client
clouds. That is a direct BYOC-positioning competitor to pillar 3. Feature depth, pricing and
governance claims **could not be verified** — do not cite this profile beyond the positioning line.

**Claude Code / Agent SDK (Anthropic).** Claude Code ships in Team/Enterprise premium seats.
April 2026: user groups + custom roles, per-user spend caps, **managed policies enforcing tool
permissions, file-access restrictions and MCP server configs org-wide**, Compliance API for
programmatic access to usage data and content. 2026-07-02: admin usage analytics, org- and
user-level spend limits, alerts at 75%/90% of budget. The Agent SDK underpins a large third-party
agent ecosystem. *Gaps:* one vendor's models and one vendor's agent; policies do not reach the
customer's Copilot/Cursor/Gemini estate; no project-level dollar attribution across tools; no
workflow-stage engine.

**OpenAI Codex.** Six plans, Business $20–25/user/mo, Enterprise custom credit pool; 2026 moved
billing from messages to token credits (third-party guides + openai.com). Cloud agent works in a
sandbox and returns a PR. **Workspace agents** (research preview, openai.com): admins enable
agents via RBAC, set per-app action safeguards, and see agent activity in the admin console.
*Gaps:* mirror-image of Anthropic's — single-vendor governance, no cross-tool or cross-vendor
plane, no BYOC control plane.

### 1.2 LLM gateways / governance layers

**LiteLLM.** OSS gateway, 100+ providers; budgets per org/team/project/key; virtual keys; MCP
gateway with OAuth; guardrails; audit logs; SSO/RBAC in Enterprise (Basic tier $250/mo per
truefoundry.com pricing guide — competitor source); **explicit air-gap support**; weekly stable
releases. *Gaps:* no workflow engine, no compliance cascade, no invoice-side cost import, no
PM-tool integration; admin UX is operator-grade.

**Portkey (now Palo Alto Networks / Prisma AIRS — closed 2026-05-29).** Pre-acquisition: 1,600+
models, guardrails, virtual keys, budgets; **Agent Gateway** with virtual MCP servers and **OAuth
identity injection enforcing user-level permissions on every tool call** — pillar 1's exact claim,
shipped, now inside a security platform. Pricing had been free / $49/mo / enterprise-custom with
VPC hosting. *Gaps (pre-integration):* no SDLC workflow, no PM integration, no invoice-side cost;
post-acquisition roadmap is security-platform-shaped, and standalone availability is the open
question.

**Kong AI Gateway.** Self-hostable OSS core + enterprise tier; provider-agnostic API (OpenAI,
Anthropic, Bedrock, Vertex, Azure, Mistral, Cohere); semantic caching and semantic routing
(enterprise); token-based rate limiting; prompt middleware; unified API+AI policy surface.
*Gaps:* infrastructure-team product — no per-human entitlement portal, no project cost dashboard,
nothing above the proxy layer.

**Cloudflare AI Gateway.** Core features free on a Cloudflare account; caching (exact-match, not
semantic), spend caps, logs; **2026: unified billing consolidating OpenAI/Anthropic/Google AI
Studio charges onto one Cloudflare invoice**. *Gaps:* no hierarchical team/project budgets
(comparison coverage, 2026-08-15), no self-hosted/air-gapped mode by nature, no governance
portal, no per-user tool-level entitlements.

**TrueFoundry.** Closed-source enterprise gateway; **VPC, on-prem and air-gapped deployment**;
sub-5ms claimed overhead; SOC 2 Type 2 + HIPAA (2024); Agent Gateway with access controls,
credential brokering, routing policy, audit trails; Kubernetes-native. The closest single
competitor to RegulAIt's pillar 1+3 combination. *Gaps:* no SDLC workflow engine, no compliance
cascade, no PM-tool integration, no invoice-side cost consolidation; ML-platform DNA, not
GRC DNA.

**Helicone.** Acquired by Mintlify 2026-03-03; **maintenance mode** — security updates continue,
roadmap stopped (helicone.ai/blog, verified 2026-08-15). Effectively exits the field.

**Langfuse.** MIT-licensed core; tracing, prompt management, evals, datasets; Monitors & Alerts
GA and active development through 2026; self-hostable (same codebase as cloud). Trade coverage
(2026-08-09) describes it as now part of ClickHouse. *Gaps:* observability-first — no
enforcement, no entitlements, no budgets-with-teeth, no deploy workflow.

**Arize (AX / Phoenix).** Enterprise AX adds Evaluator Hub (commit-versioned LLM-as-judge
evaluators), Signal continuous production trace review, voice-agent observability, and **runtime
Guards** (2026 coverage). *Gaps:* same shape as Langfuse — evaluation/observability, not
governance-with-enforcement, not cost, not workflow.

**Lakera (Check Point AI Guardrails).** Runtime guardrails across prompts, RAG and **MCP**;
claimed 98%+ prompt-injection detection at sub-50ms (vendor claims, verified as claims
2026-08-15); continuous red-teaming fed by Gandalf's 80M+ adversarial patterns. *Gaps:* a
guardrail layer, not a platform — pairs with a gateway rather than replacing one. Competitive
lesson for ADR-0057/0068: the red-team bar in the market is a continuously-updated corpus, not a
frozen one.

### 1.3 Enterprise AI governance / compliance

**Credo AI.** AI registry, risk intelligence, policy engine with ready-made packs (EU AI Act,
NIST AI RMF, ISO 42001); boardroom/GRC motion. *Gaps:* no runtime position — governs paperwork
and process, not calls; no gateway, no cost, no SDLC.

**Holistic AI.** Inventory/audit heritage; **2026 added runtime**: AI Safeguard input/output
filtering plus Guardian Agents — Sentinel (observe) paired with Operative agents that block,
quarantine, revoke or kill (2026 buyer's-guide coverage, verified 2026-08-15). *Gaps:* runtime
layer is new and thin relative to gateway incumbents; no cost plane, no SDLC workflow.

**IBM watsonx.governance.** Platform-agnostic lifecycle governance (any model, any cloud,
on-prem/hybrid); **Q1 2026: Agent Monitoring & Insights** with reasoning-trace capture and
threshold alerts; Guardium AI-security integration; Gartner AI Governance Platforms Leader (June
2026). *Gaps:* heavyweight GRC deployment; not a dev-tool gateway; no per-project AI spend
dashboard for engineering work; no PM/SDLC integration of the pillar-2/8 kind.

**Microsoft Purview (AI) + Agent 365.** Purview governs AI activity well inside the Microsoft
estate, with limited reach beyond it (2026 buyer's guides). The sharper edge is **Agent 365** (GA
2026-05-01): unified registry + control plane for Microsoft *and non-Microsoft* agents, built on
Entra Agent ID — conditional access, lifecycle workflows, sponsorship/ownership, access packages
for on-behalf-of and autonomous agents (learn.microsoft.com, verified 2026-08-15). *Gaps:*
identity-plane governance, not call-plane — no token/cost attribution per project, no SDLC
workflow, no model-routing or optimization; gravity is Microsoft-stack-first.

**ServiceNow AI Control Tower.** 2026 expansion: discover, observe, govern, secure and measure
AI **of any origin**; Traceloop acquisition for runtime agent observability; Veza integration for
identity access governance into hyperscaler AI environments; real-time detection and shutdown of
off-policy agents; five risk frameworks aligned to NIST/EU AI Act; deep Microsoft
Foundry/Copilot Studio/Agent 365 integration (ServiceNow newsroom, verified 2026-08-15). *Gaps:*
ITSM-platform gravity and pricing; not a dev-team product; no per-call gateway economics; SDLC
depth is workflow-ticket-shaped, not PR-shaped.

### 1.4 Newly prominent in 2026 (searched explicitly)

- **AWS Kiro** — spec-driven IDE, GA early 2026: requirements/design/tasks generated and approved
  *before* code; specs, steering, hooks. Pillar 2's forced-plan gate at single-developer scale —
  proof the pattern is now mainstream, minus the org-level assignment/enforcement.
- **Managed agent runtimes** — AWS Bedrock AgentCore (VPC runtime with state, identity, memory,
  guardrails), Microsoft Copilot Studio (described as the enterprise default orchestration
  platform in VB Pulse Q1 2026 tracking), Google Vertex + A2A protocol, OpenAI workspace agents,
  Salesforce Agentforce, watsonx Orchestrate. LangGraph holds the largest open-framework
  production footprint. Pillar 7's mechanics are fully commoditized; its *inheritance discipline*
  is not (see §3).
- **Model-routing/optimization field moved**: Martian pivoted away from routing to
  interpretability research (2026 coverage); OpenRouter's Auto Router (powered by NotDiamond)
  exposes a cost/quality dial at no surcharge; provider prompt-caching is table stakes with
  45–80% savings routinely cited; AWS intelligent prompt routing claims ~30% average savings.
- **AI-spend management from the SaaS-management side**: Torii, Zylo et al. now discover AI tools
  via SSO/finance feeds and attribute token spend per user/team/project — see §0.3.
- **Shared agent memory** is having a moment (TencentDB-Agent-Memory trending on GitHub at
  ~12.9k stars per Aug-2026 coverage; arXiv work on shared organizational memory for coding
  agents) — but as frameworks and papers, not as a governed enterprise product.

---

## 2. Pillar-by-pillar parity table — RegulAIt vs the field, 2026-08-15

"RegulAIt today" reflects shipped ADRs (0001–0075) including the 08-07 parity wave, with its
honesty notes; "field leader" is the strongest verified competitor *for that pillar's claim*.

| # | Pillar | RegulAIt today | Field leader(s) today | Parity verdict |
|---|---|---|---|---|
| 1 | Per-user governance gateway | Default-deny entitlement kernel, per-user tool-level allow-lists, approvals, audit chain, virtual keys, OpenAI-compat endpoint (ADR-0066); **no live model provider connected** | Portkey/Palo Alto (OAuth identity injection per tool call), GitHub agent control plane (GA 2026-02), Anthropic managed policies (2026-04), Agent 365 (GA 2026-05), TrueFoundry, LiteLLM | **At feature parity on mechanism; behind on proof** (nothing verified against live traffic). Vendor-neutral + self-hosted remains the only stance the platform vendors can't copy. |
| 2 | Multi-stage workflow engine | Declarative stages, plan-gate, sign-off, PR/checks integration per WORKFLOW_ENGINE_SPEC; compliance-tag-driven stage injection | Kiro (spec-first, IDE-scale), Rovo Dev (plan→generate→review vs Jira criteria), GitHub required checks + agent PR scanning | **Ahead in composition** — nobody ships admin-assignable, org-wide, compliance-conditional stage templates. Behind in ecosystem reach. |
| 3 | Infra-ops + compliance cascade + BYOC/air-gapped | Air-gap-first posture code-enforced (ADR-0062), egress guard, cascade §8.3 wired into red-team gating, cost, retention | TrueFoundry (VPC/on-prem/air-gapped gateway), LiteLLM (air-gap), Devin (VPC), Windsurf (on-prem), Atlas (BYOC positioning, unverified) | **Cascade is genuinely unmatched** — no competitor ships one classification tag driving stages+scopes+retention+PII mode. Air-gap alone is rare-but-not-unique. |
| 4 | Shared Projects, cross-team context | Governed shared context store w/ provenance + versioned conflict resolution, entitlement-gated partial sharing | No enterprise product found; field is frameworks (TencentDB-Agent-Memory) and papers (arXiv 2608.00122) | **Differentiated, demand unproven.** Watch Atlassian Teamwork Graph — closest adjacent asset. |
| 5 | Cost-per-project dashboard | Per-call attribution at gateway, budgets→Approvals Queue, chargeback; **cross-vendor invoice import (ADR-0069) with metered/imported CHECK-enforced separation** | Every gateway does call-side; Cloudflare unified billing (2026) does invoice consolidation for its own traffic; Torii/Zylo do SSO/finance-feed AI spend per user/team | **Call-side commoditized (unchanged). Wedge narrowed:** nobody yet joins metered call-side + imported invoice-side in one governed plane with basis honesty — but two categories are converging on it. |
| 6 | Backend-enforced token/cost optimization | Routing, compaction, caching, batching under entitlement ceiling; savings into pillar-5 dashboard | OpenRouter auto-routing (free), provider prompt caching (45–80%), AWS intelligent routing (~30%) — all opt-in, none entitlement-aware | **Mechanisms commoditized.** "Enforced transparently, never widening entitlement, savings attributed per project" is packaging differentiation only — real, but thin. |
| 7 | Multi-agent orchestration, PM/Team-Lead model | DAG decomposition, worker fan-out, **tighten-only inheritance of entitlements + per-run budget** (ADR-0016 ceilings) | Copilot Studio (enterprise default per VB Pulse Q1 2026), AgentCore, LangGraph (largest OSS footprint), A2A interop | **Orchestration itself: fully commoditized.** Tighten-only entitlement/budget inheritance: not found natively in any framework — the defensible sliver, and Agent 365/AgentCore identity work is approaching it. |
| 8 | Bi-directional PM-tool integration | Spec'd: PM tool as source of truth, decisions/approvals as linked records, one audit trail; adapters not yet built against live PM instances | Atlassian Rovo Dev (GA, Jira-native, Teamwork Graph), Jira "open in Claude Code/Cursor/Copilot/Codex" launcher, GitHub Agent HQ | **Behind and closing fastest.** The vendor-neutral, decisions-as-first-class-records version remains unshipped by anyone — including us. |

---

## 3. The brutal differentiation verdict, pillar by pillar

The 08-07 pass falsified three assumed differentiators. Eight days later the honest scorecard is:

- **P1 — not differentiated on capability; differentiated on stance.** Per-user tool-level
  governance now ships from GitHub, Anthropic, Microsoft and Palo Alto — each for *their* slice.
  The only claim left is the combination: one vendor-neutral plane, self-hosted/air-gapped,
  covering all of them. That is the packaging wedge COMPETITIVE_PARITY_PLAN §0(2) predicted, and
  its predicted erosion has begun (ServiceNow + Agent 365 bundling).
- **P2 — moderately differentiated.** Forced-plan is now an IDE feature (Kiro) and a PM feature
  (Rovo Dev). Nobody ships the org-level artifact: declarative templates assigned by
  repo/change-type/sensitivity/role/environment with human sign-off gates. Window: open, but the
  pattern is mainstream now, so months not years.
- **P3 — the compliance cascade is the single most defensible claim RegulAIt has.** Verified
  against every profile above: no competitor ships one classification tag that cascades into
  workflow stages, connector scopes, retention and PII mode. Air-gap-first is shared with
  TrueFoundry/LiteLLM at the gateway layer only.
- **P4 — differentiated by default (nobody's product), risky by the same token (nobody's
  revenue).** The 2026 shared-memory surge is framework-level; a *governed* cross-team context
  store with provenance remains unshipped by anyone.
- **P5 — call-side: commodity (verdict unchanged). Cross-vendor wedge: still real, now on a
  clock.** Cloudflare consolidates invoices for traffic it carries; Torii/Zylo attribute spend
  from SSO/finance exhaust without governing anything. Neither joins metered + imported in one
  governed plane with the basis-honesty spine ADR-0069 enforces in the schema. That seam is the
  wedge now — narrower than the 08-07 framing, and both neighbors are one product cycle away.
- **P6 — not differentiated as a capability.** Every mechanism is free or built into providers.
  The entitlement-ceiling-aware, backend-enforced, savings-attributed framing is honest product
  polish, not a moat. Stop describing it as a pillar-scale differentiator.
- **P7 — orchestration commoditized; the inheritance discipline is the claim.** "A worker agent
  can never exceed the initiating user's entitlements or budget" is not natively enforced by
  LangGraph, CrewAI, AgentCore or Copilot Studio today (verified against 2026 framework
  comparisons). It is also exactly where Entra Agent ID's access-package model is heading —
  defensible for perhaps two quarters as a *unique* claim.
- **P8 — spec'd differentiation, shipped nothing; the field shipped.** Atlassian and GitHub are
  building the single-vendor versions from positions of incumbency. The vendor-neutral
  "PM tool is the source of truth, decisions are first-class linked records in one audit trail"
  product still does not exist — but RegulAIt's version is prose, and prose loses to GA.

**Net:** two claims are genuinely differentiated today — the **compliance cascade (P3)** and the
**metered+imported cost plane with enforced basis honesty (P5)** — plus two second-order ones
(P2's org-level workflow artifact, P7's tighten-only inheritance) that are differentiated mainly
because they are *invariants already enforced in our schema and tests*, which is harder to copy
quickly than a feature. Everything else is parity or packaging.

---

## 4. Ranked next-build queue

Ranking rule per the brief: customer-visible wedge > parity gap > polish — with one override: an
unproven system demonstrates nothing, so credibility blockers that gate *every* wedge demo come
first. Cross-referenced against [PENDING.md](PENDING.md) P1–P3 and the 08-07 wave's named
follow-ups.

1. **Connect a real model provider end-to-end (PENDING P1).** Every model-dependent claim in
   Slices A/B/F is "mechanism-proven, judgment-unverified" by our own admission. Against a field
   where GitHub ships security scans on live agent PRs and Lakera quotes measured detection
   rates, an unverified judge is a demo-stopper. Nothing below ranks above this. *(Credibility
   gate; owner's parked-key instruction must be resolved in-session first.)*
2. **Verify the 08-07 wave against live third-party systems.** One real vendor cost export
   through ADR-0069, one real proxy-log export through ADR-0071, one live OTLP collector for
   ADR-0070. The wave's own close-out names this as the first follow-up for three slices; until
   then the honest answer to "has this ever parsed a real file?" is no. *(Parity-gap closure,
   cheap, high credibility yield.)*
3. **Defend the P5 wedge before the neighbors arrive: scheduled reconciliation + SSO-roster
   ingestion.** ADR-0069 deliberately holds no vendor billing credentials and does not poll.
   Torii/Zylo's pitch is precisely "we poll your SSO and finance feeds". Add an operator-run
   reconciliation cadence, staleness SLOs on the consolidated view, and an SSO app-access-report
   adapter feeding identity resolution — keeping the metered/imported spine intact. *(Wedge
   defense; the two-sided squeeze in §0.3 is the clock.)*
4. **Ship the compliance cascade as the demo, not a feature note.** P3's cascade is the one
   unmatched claim — make one tag visibly rewrite a workflow, narrow a connector scope, extend
   retention and flip PII mode in a single recorded flow, and put that flow in VISION.md and the
   first sales artifact. *(Customer-visible wedge; mostly composition of shipped parts.)*
5. **Pillar 8 minimum: one live Jira adapter with decisions-as-linked-records.** Not the five-PM
   matrix — one bidirectional Jira slice where a workflow stage transition writes a linked
   decision record and the work item remains the source of truth. Rovo Dev's GA makes the
   single-vendor version table stakes; a shipped neutral slice beats a spec'd neutral matrix.
   *(Closing window; first pillar-8 code.)*
6. **Name and test the P7 claim: tighten-only delegation as a conformance suite.** The ceilings
   exist (ADR-0016). Package them as an asserted, documented invariant — "no worker exceeds the
   initiating user" as a runnable conformance check against our orchestrator, and an A2A/MCP
   interop note showing third-party agents inherit the same ceiling through the gateway.
   *(Differentiation defense against Agent 365/AgentCore's identity trajectory.)*
7. **Workflow-template gallery mapped to the cascade (P2).** Admin-assignable YAML templates per
   change-type/sensitivity with the plan-gate enforced — the org-level artifact Kiro and Rovo
   stop short of. Ranked below 4–6 because it compounds on the cascade demo rather than standing
   alone. *(Second-order wedge.)*
8. **Deliberately deferred:** guardrail-model breadth (Lakera-class detection is a partnership or
   an adapter, not a build), HA/SLA work (PENDING P2 — matters at first paying install, not
   before), semantic caching depth, SPA pages for the API-only slices, and anything in
   COMPETITIVE_PARITY_PLAN §2's do-not-match list, which this analysis re-confirms unchanged.

---

## 5. Source register

Verified 2026-08-15 via live search unless noted. Vendor-primary sources: github.blog changelog
(2026-02-26 GA post), openai.com (workspace agents), learn.microsoft.com (Entra Agent ID / Agent
365), ServiceNow newsroom (2026 releases), Palo Alto Networks press (2026-04-30 / 2026-05-29),
Check Point press (Lakera), helicone.ai + mintlify.com blogs (2026-03-03), litellm.ai, portkey.ai
docs, credo.ai, ibm.com, atlassian.com (Rovo Dev), finops.org, openrouter.ai docs. Third-party
(pricing figures and acquisition amounts especially): eesel.ai, layer3labs.io, nocode.mba,
truefoundry.com (competitor-authored comparisons — used for its own product's claims and flagged
elsewhere), MarkTechPost (2026-08-09), Forbes (2026-07-05, agent-gateway control-plane trend),
devops.com, bighatgroup.com, toriihq.com, zylo.com, VB Pulse Q1 2026 as cited in framework
comparisons. **Unreachable:** atlasapp.ai (egress-blocked; snippet-level only). Single-source
claims are marked inline; treat any un-marked price as "third-party guide, repriceable".
