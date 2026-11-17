# Gap analysis — Obsidian Security "AI Agent Security", 2026-11-16

**Status:** research snapshot, written 2026-11-16 at the owner's request ("see if we have everything that they do").
It adds Obsidian Security to the competitor list in [MARKET_ANALYSIS_2026-11.md](MARKET_ANALYSIS_2026-11.md) §1.4.

**Source and honesty rules.** Primary source: the vendor's product page
`https://www.obsidiansecurity.com/ai-agent-security`, read 2026-11-16. Its headline banner announces a
"context-aware runtime decision engine to enforce AI agent actions" (blog post linked from the page, not read).
Every vendor statistic quoted below is the vendor's own marketing claim and was not verified. "RegulAIt status"
is checked against `origin/main` (bf92c0ff) and the open PRs named; a PR number means the work is in flight and is
not yet merged.

## 1. What Obsidian sells

Obsidian started as a SaaS security posture and identity-threat platform (customers named on the page include
T-Mobile, Databricks, S&P Global and Snowflake; IR partners Kroll, PwC and others). It has extended that platform
to AI agents with a four-stage story: **find it, govern it, stop it, prove it**.

| Stage | Vendor claim (summarised) |
|---|---|
| Visibility | Continuous discovery of every agent across Amazon Bedrock, Azure AI Foundry, Copilot Studio, ChatGPT, Google Vertex, Salesforce Agentforce, n8n and Claude Code; shadow agents surfaced automatically; each agent mapped to owner, connected apps, MCP servers, models, tools and permissions. |
| Identity | Author vs runner resolution (who built it vs who runs it), orphaned agents, mapping to the real service accounts and non-human identities. |
| Access | OAuth and entitlement mapping into connected SaaS; usage-based least privilege ("90% of agent access is unused"); oversharing and publicly exposed agents; embedded credentials flagged. |
| Posture | Automatic risk score on every publish or modify, mapped to OWASP risk factors, ranked by blast radius and business impact; toxic combinations. |
| Runtime | Guardrails at the execution layer that block high-risk actions before they run; behavioural baselines across users and agents; policies per agent, per team or org-wide; enforcement "directly inside SaaS", including low-code builders. |
| Compliance | Continuous, audit-ready evidence of which agents exist, who owns them, what they can reach, and the runtime guardrails in force. |
| Platform | 29B+ events a month, 99.99% uptime, regional hosting, cross-customer threat intelligence ("network effect"). |

## 2. Capability-by-capability parity

| # | Capability | RegulAIt status | Evidence | Gap |
|---|---|---|---|---|
| 1 | Agent discovery across vendor platforms; shadow agents | **Partial**, #855 in flight | ADR-0195, ADR-0235 (scheduled read-only scanners: repos, Bedrock/SageMaker, Vertex, Azure OpenAI/Foundry, Entra consents, endpoints); the decision record on #855 (Entra Agent ID, Agent 365, Gemini Enterprise, AgentCore) | No connector for **Copilot Studio, Salesforce Agentforce, the OpenAI/ChatGPT agent builder or n8n**. Claude Code is found on endpoints only (ADR-0259, ADR-0298). |
| 2 | Inventory: owner, apps, MCP, models, tools, permissions | **Have** (own registry) | ADR-0082, ADR-0156 | Vendor-hosted agents get this only once #855 imports them; SaaS-side connected apps are not mapped. |
| 3 | Author vs runner, orphaned agents, NHI mapping | **Partial** | ADR-0089 (owner, lifecycle, orphan flag), ADR-0188 (agent principal, human sponsor, RFC 8693 actor chain) | No "built by / run by" view for vendor agents; cloud service accounts are not linked to agents. |
| 4 | OAuth / entitlement map into SaaS apps | **Partial** | ADR-0235 (Entra `oauth2PermissionGrants`), ADR-0255 | Entra only, and only as shadow-AI findings. No Salesforce, Google Workspace or Slack scope graph. |
| 5 | Usage-based least privilege; oversharing, public exposure | **Partial** | ADR-0092 (`unused-grant` from the usage ledger), ADR-0090 (certification campaigns) | Right-sizes RegulAIt's own grants, not SaaS-side permissions. No oversharing or public-agent detection. |
| 6 | Embedded credentials in agent integrations | **Partial** | ADR-0055, ADR-0195, ADR-0259 | Repos and endpoint configs are scanned; agent configs inside SaaS builders are not. |
| 7 | Auto risk score on publish/modify, OWASP, blast radius, toxic combinations | **Partial**, #831 in flight | ADR-0214, ADR-0091, ADR-0243, ADR-0059 | No score recomputed on every change; OWASP drives required tests, not a score. |
| 8 | Block before execution; per-agent/team/org policy; context-aware decisions | **Have** (strongest area) | ADR-0251, ADR-0040; endpoint hooks ADR-0298, ADR-0330 | Only for traffic through the gateway or endpoint hook. Decisions do not yet use live third-party app context. |
| 9 | Behavioural baselines and anomalies | **Gap**, #865 in flight | Nearest on main: ADR-0049 (spend-anomaly detection only); the decision record on #865 (sequence rules over the audit chain) | No behavioural baseline for agents or users today; #865 adds deterministic rules, not a learned baseline, by owner decision. |
| 10 | Continuous audit-ready evidence | **Have, ahead** | ADR-0058, ADR-0060, ADR-0116, ADR-0186, ADR-0303 | Hash-chained audit, signed exports and receipts, SIEM delivery go further than the page claims. |
| 11 | Enforcement inside SaaS / low-code builders | **Gap**, partly in flight | the decision record on #850 (vendor-native managed settings), the decision record on #867 (managed browser extension); SAP only via ADR-0230/0231 | Agents that never touch the gateway or an endpoint are visible at best, not controllable. |
| 12 | Regional hosting / data isolation | **Have, by another route** | ADR-0015, ADR-0041, ADR-0062 | No multi-region hosted SaaS; BYOC and air-gapped give customer-controlled residency. |
| 13 | Cross-customer threat intelligence | **Gap** (by design) | Nearest: ADR-0186 vendored detection content, ADR-0158 curated feed | Single-tenant BYOC rules out pooled telemetry; a signed, opt-in detection-content feed is the honest substitute. |

## 3. Gaps, ranked by enterprise-buyer impact

None of these is queued as a whole today (checked against `PENDING.md` and the ADR index on main); parts
are in flight where noted. Building any of them needs the owner's go-ahead and a new decision record.

1. **Discovery connectors for Copilot Studio, Salesforce Agentforce, OpenAI agents and n8n.** This is Obsidian's
   headline. Natural home: extend #855's registry importer with these sources, read-only, staged and default-deny
   as the owner already decided for registries (R1/R2).
2. **SaaS entitlement graph** (Salesforce, Google Workspace, Slack, M365 Graph beyond Entra consents), feeding
   ADR-0092's unused-grant engine so least privilege covers SaaS-side scopes, plus oversharing and public-exposure
   findings.
3. **In-platform control for low-code builders.** Today we see but cannot stop. Options: vendor admin APIs to
   disable or quarantine an agent (a governed removal, as #871 does for endpoint add-ons), and pushing policy through
   vendor-native settings (#850).
4. **Risk score recomputed on every publish or modify**, mapped to OWASP Agentic / LLM Top 10 factors and ranked by
   blast radius (ADR-0059) — builds on #831's per-asset scores.
5. **Author vs runner and NHI resolution for vendor-hosted agents**, linking each imported agent to its cloud service
   account (extends ADR-0188's actor chain).

Not recommended: pooled cross-customer telemetry (#13). It conflicts with the BYOC/air-gapped boundary (ADR-0015);
a signed detection-content feed covers the same need.

## 4. Where RegulAIt is ahead

Obsidian's page claims none of the following, each of which exists in the repo:

- **Execution-path governance, not just posture:** declarative multi-stage workflow engine with a forced plan gate
  and governed deploy (ADR-0079, ADR-0161), on a durable stage runner (ADR-0282–0286); multi-agent orchestration with tighten-only delegation as
  a tested invariant (ADR-0078); governed A2A (ADR-0219); payload-bound approvals in Slack and Teams (ADR-0104,
  ADR-0061).
- **Cost and token economics:** per-call cost attribution, budgets enforced through the approvals queue, cross-vendor
  spend consolidation with metered and imported kept apart (ADR-0069, ADR-0076), and seven token-optimisation
  techniques with measured savings.
- **Deployment and SDLC reach:** BYOC and code-enforced air-gapped mode (ADR-0015, ADR-0062), bi-directional PM-tool
  integration (pillar 8), four git providers, built-in eval and red-team engines, and model risk cards (ADR-0045).
- **Evidence quality:** hash-chained, signed, exportable audit rather than "documented guardrails".

## 5. One-line positioning

"Obsidian watches agents from the SaaS side and blocks what it can see. RegulAIt is the path the agent's calls take,
so every action is decided, costed and recorded before it runs — in your cloud or air-gapped."
