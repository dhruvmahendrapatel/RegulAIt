# Gap analysis — Camunda "agentic orchestration", 2026-11-16

**Status:** research snapshot, written 2026-11-16 at the owner's request. It adds Camunda to the competitor list in
[MARKET_ANALYSIS_2026-11.md](MARKET_ANALYSIS_2026-11.md) §1.4, next to
[GAP_ANALYSIS_OBSIDIAN_2026-11.md](GAP_ANALYSIS_OBSIDIAN_2026-11.md).

**Sources and honesty rules.** Primary: `https://camunda.com/`, `https://camunda.com/platform/` and
`https://camunda.com/what-is-agentic-orchestration/`, read 2026-11-16. Customer numbers and analyst placements
(Gartner BOAT Visionary 2026, Forrester Wave APO Leader Q3 2026, "750+ enterprises", "12 of 15 leading global banks")
are the vendor's own claims and were not verified. "RegulAIt status" is checked against `origin/main` (6a3a7a03).

## 1. What Camunda sells

Camunda is a process-orchestration platform (BPMN engine Zeebe) repositioned as **agentic orchestration**: one
governed process that sequences AI agents, people, systems, business rules, RPA bots and document processing, with
deterministic steps where the path is known and agent reasoning where it is not. Components: **Modeler** (shared
BPMN canvas for business and IT), **Zeebe** (durable engine: retries, compensation, timeouts, escalations), **Operate**
(live instances, traces, incidents, audit), **Tasklist** (human work), **Optimize** (heatmaps, bottlenecks), **Hub**
(workspaces, reusable approved assets, business-value dashboard), **Connectors** (ERP, CRM, ITSM, LLMs over MCP, A2A
and REST), **Identity** (RBAC, SSO, SCIM). Agents run as native process steps with per-instance model calls, tokens,
tools and conversation history. Hosted SaaS (99.9% SLA on advanced clusters) or self-managed with multi-region HA;
SOC 2 Type II, ISO 27001, TISAX. **Licence:** core engine is source-available and enterprise features are commercial
(vendor FAQ) — the "Camunda License", which ADR-0232 §11 already rejected for RegulAIt under ADR-0176.

**Where it overlaps us:** pillar 2 (workflow engine) and pillar 7 (multi-agent orchestration). Camunda is the
process-automation incumbent moving into our space; it is not a gateway, cost or token-optimisation product.

## 2. Capability-by-capability parity

| # | Capability | RegulAIt status | Evidence | Gap |
|---|---|---|---|---|
| 1 | Visual modeler shared by business and IT; open-standard process format | **Partial** | ADR-0232 (Proposed, design), read-only run graph in `apps/web/src/ui/runGraph/` | Templates are declarative JSON, not BPMN. The drag-and-drop pipeline builder is designed but not built. BPMN was rejected for agent pipelines (ADR-0232). |
| 2 | Durable execution: retries, compensation, timeouts, escalations | **Partial** | ADR-0282–0286 (pg-boss retry and backoff, idempotency, wait-for-token, fan-out, concurrency) | No saga/compensation steps, no stage timers and no timed escalation. |
| 3 | AI agent as a native step with per-instance visibility | **Have** | ADR-0070, ADR-0320 | Nested orchestration runs inside workflow stages; traces carry model calls, tokens, tools and conversation through the gateway. |
| 4 | Deterministic + AI + human in one process; "fully dynamic" mode | **Partial** | ADR-0079, `packages/orchestration-kernel` | Stage types mix automation, planning, checks and human approval. An agent-generated path (dynamic mode) is not a governed option yet. |
| 5 | Human task management (Tasklist) | **Partial** | ADR-0046, ADR-0061, ADR-0018 | Approvals queue, review workbench, ChatOps approvals and assignment matching. No task priorities, SLAs, timed escalation or embeddable task widget. |
| 6 | Business rules / decision tables (DMN) | **Partial** | ADR-0040, ADR-0073, ADR-0327 | Cedar ABAC policy and a rules engine; AI-step-to-rule-table conversion in shadow mode (ADR-0327). No business-authored decision tables. |
| 7 | Live operations console + immutable audit | **Have (audit ahead)** | ADR-0060, ADR-0116 | Hash-chained, signed audit beats an "immutable audit trail". No Operate-style instance list with incident resolution; recovery is manual. |
| 8 | Versioning; in-flight migration; canary rollouts | **Partial** | ADR-0048 | Templates, prompts and policies are versioned. No migration of running instances and no canary rollout of a process version. |
| 9 | Process analytics (heatmaps, bottlenecks, cycle time) and ROI | **Gap** | Nearest: ADR-0047, ADR-0049 | Trust, executive and cost reports exist; no process-mining view and no business-value dashboard (cost per outcome is in flight on #848). |
| 10 | Reusable asset catalog (Hub) | **Partial** | ADR-0077, ADR-0101, ADR-0236 | Template gallery, federated MCP registry, governed MCP bundles. No catalog of approved reusable sub-processes. |
| 11 | Connector marketplace; RPA; document processing | **Partial** | ADR-0255, ADR-0256, ADR-0230 | Activepieces-based catalogue, MCP seed catalogue, SAP over MCP/A2A. No RPA bots and no intelligent document processing. |
| 12 | Agent-agnostic via MCP and A2A; orchestrator agents | **Have** | ADR-0219, ADR-0320 | OpenAI/Anthropic-compatible endpoints, MCP proxy, A2A client, multi-agent kernel with tighten-only delegation. No A2A server endpoint yet (PENDING). |
| 13 | Identity: RBAC, SSO, SCIM, service accounts | **Have** | ADR-0036, ADR-0037 | Plus IdP group mapping (ADR-0038) and workload identity with DPoP/SPIFFE (ADR-0188). |
| 14 | High availability; multi-region; SLA | **Gap** | ADR-0228, ADR-0325; `ENTERPRISE_READINESS_PLAN.md` | Single-host control plane today; only the BYOC AWS module has Multi-AZ RDS. No replication, multi-region or SLA. |
| 15 | Certifications (SOC 2 Type II, ISO 27001, TISAX) | **Gap (owner-deferred)** | `ENTERPRISE_READINESS_PLAN.md` | Attestation is deferred by owner decision. ADR-0134 is an ISO 27001 evidence pack for customers, not our own certificate. |

## 3. Gaps, ranked by enterprise-buyer impact

1. **Certifications** (SOC 2 Type II, ISO 27001). Blocks procurement. Owner-deferred; listed for completeness.
2. **High availability and an SLA** for the control plane: replicated database, multi-AZ, documented RPO/RTO.
3. **Process-level reliability:** compensation (saga) steps, stage timers and SLA escalations, in-flight instance
   migration and canary process versions — extends the ADR-0282–0286 runner, no new engine.
4. **Visual pipeline builder** shared by business and IT — ADR-0232's design, built on the existing JSON templates
   (the canvas library choice is already made there).
5. **Process analytics and value dashboard:** cycle time, bottlenecks and per-stage heatmaps from the workflow audit
   events, joined with cost per outcome (#848); plus human-task priorities and SLAs in the approvals queue.

Not recommended: adopting Camunda or BPMN as the engine. ADR-0232 and ADR-0254 rejected Camunda 8 on licence
(ADR-0176) and Temporal as a second stateful cluster in every BYOC and air-gapped install; nothing on these pages
changes either reason.

## 4. Where RegulAIt is ahead

- **Governance on every call, not just every step.** Camunda governs the process around an agent; RegulAIt also
  governs each model, connector, MCP and A2A call the agent makes (ADR-0251): guardrails (ADR-0042), PII redaction
  (ADR-0140), MCP admission scanning and definition pinning (ADR-0097, ADR-0246), kill switch (ADR-0124), and budget
  ceilings that tighten at every delegation (ADR-0016).
- **Each workflow transition is re-authorised** at claim and at commit, with the audit row written in the same
  transaction as the state change (ADR-0254).
- **Evidence:** hash-chained, signed, offline-verifiable audit (ADR-0060, ADR-0116) and AI-BOM / decision-BOM
  snapshots (ADR-0189); regulatory compliance packs (ADR-0058, ADR-0243).
- **Cost and tokens:** per-call cost attribution and enforced budgets (pillar 5) and automatic token optimisation
  (pillar 6). Camunda's own FAQ names token cost as a top agentic challenge and offers no answer on these pages.
- **Licence-clean, BYOC and air-gapped by design**, with no extra engine cluster (ADR-0015, ADR-0041, ADR-0176).

## 5. One-line positioning

"Camunda orchestrates the process around your agents. RegulAIt governs every call your agents make inside it — and
runs the process too, in your cloud or air-gapped, on a licence-clean stack."
