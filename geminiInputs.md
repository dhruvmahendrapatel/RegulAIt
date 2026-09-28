# RegulAIt - Gemini Findings & Next Steps for Agents

This document contains findings from the initial repository sweep regarding RegulAIt's gateway capabilities, its current limitations compared to its claims, and architectural requirements for expanding it into a full-fledged gateway and Shadow AI discovery engine. 

This file is intended for consumption by Claude and Codex agents operating on this repository.

## 1. What is Needed to Make RegulAIt a Full-Fledged Gateway

Currently, RegulAIt is a "method-aware proxy" built specifically for HTTP LLM/MCP governance. To reach parity with enterprise API gateways, the following architectural gaps must be closed:

### A. Network Resilience & Traffic Management
*   **Circuit Breakers:** Prevent cascading failures when upstream providers (OpenAI, Anthropic) or MCP servers go down. 
*   **Request Timeouts & Retries:** Configurable upstream timeouts and intelligent retry logic (with exponential backoff).
*   **Payload Size Limits:** Hard limits on request/response body sizes to prevent memory exhaustion attacks.
*   **Health Checks:** Active and passive health checks for registered downstream MCP servers.

### B. Distributed State Management
*   **Centralized Rate Limiting & Budgets:** Currently, rate limits and project budgets live in single-process memory. If the gateway scales to N replicas, the limits multiply by N. We need a shared state store (e.g., Redis or Valkey) to enforce limits consistently across a High Availability (HA) cluster.

### C. Protocol Expansion
*   **Transparent Proxying:** The gateway currently hardcodes handlers for `tools/list` and `tools/call` and drops other MCP calls (like `resources/*` or `prompts/*`). It needs a transparent pass-through mode for ungoverned routes.
*   **Transport Support:** It only supports streamable HTTP. It needs support for `stdio` (standard I/O) and SSE (Server-Sent Events), which are heavily used by local MCP servers.

### Recommended Open-Source References for Gateway Features:
Agents should reference the architectures of the following open-source projects when building these features:
*   **Kong / Envoy Proxy:** For circuit breaking, distributed rate-limiting, and `ext_authz` (external authorization) patterns.
*   **Traefik / HAProxy:** For dynamic health checking and routing tables.
*   **LiteLLM:** For how to handle transparent proxying across multiple LLM provider schemas.

---

## 2. Sweep of Product Claims vs. Reality (What it DOES NOT do)

Other agents building on this codebase must be aware of these current limitations to avoid compounding technical debt:

*   **CLAIM:** *Full MCP Proxy Gateway.* 
    *   **REALITY:** It is not a full proxy. It only handles tool execution. Other MCP capabilities (resources, prompts) are actively dropped. It cannot proxy `stdio` MCP servers.
*   **CLAIM:** *Enterprise Rate Limiting.*
    *   **REALITY:** Limits are enforced locally per Node.js process. It is not HA-ready for rate limiting.
*   **CLAIM:** *Self-Verifying Exports.*
    *   **REALITY:** The export bundles are offline-verifiable via a detached script, but they do *not* contain the trust root (public key) as authority. This is a deliberate security design, but the marketing phrasing is slightly overstated.
*   **CLAIM:** *Seven Token Optimization Techniques.*
    *   **REALITY:** Only two techniques (semantic caching and basic routing) are actually applied to the IDE/compat proxy paths. Techniques like context compaction or edit-vs-rewrite require specific payload shapes that the standard OpenAI wire format does not support.

---

## 3. Shadow AI Discovery Engine (Architecture & Requirements)

To fulfill the vision of an end-to-end Shadow AI discovery tool, the platform needs a new **Discovery Engine**. Agents should build this out in the following phases:

### Phase 1: Cloud & Code Repository Scanning
We need a scan engine to automatically identify undeclared AI workloads and create intake use cases for them.
*   **Cloud Estate (AWS, GCP, Azure):** Use read-only IAM roles to scan for managed AI service usage (e.g., AWS Bedrock, SageMaker endpoints, Azure OpenAI deployments, GCP Vertex AI).
    *   *Reference:* Look at **CloudQuery** or **Steampipe** for multi-cloud data extraction architectures.
*   **Git Repositories:** Scan enterprise source code for imported AI libraries (e.g., `openai`, `langchain`, `anthropic`) or hardcoded API keys. 
    *   *Reference:* Look at **TruffleHog** or **Gitleaks** for scanning patterns.

### Phase 2: Endpoint Agent (Local MCP Detection)
*   **Lightweight Daemon:** Build a small, low-footprint agent (preferably in Rust or Go) intended to run on end-user workstations.
*   **Capabilities:** 
    *   Monitor running processes for known MCP server execution commands (e.g., `npx -y @modelcontextprotocol/server-...`, Python MCP runners).
    *   Monitor local port bindings associated with AI dev tools.
*   *Reference:* Look at **OSquery** or **Wazuh** for cross-platform endpoint telemetry gathering.

### Phase 3: Network Traffic Log Analysis via Internal LLM
*   **Log Ingestion:** Ingest VPC flow logs, DNS queries, and corporate proxy logs (e.g., Zscaler, Palo Alto).
*   **Local LLM Analysis:** Rather than using simple regex, route these logs through an *internally hosted, local LLM* (to preserve privacy). The LLM will be fine-tuned to detect heuristic patterns of Shadow AI usage (e.g., unrecognized IPs receiving large outbound payloads typical of LLM prompts, or frequent DNS lookups to frontier model APIs).
*   **Action:** When detected, the engine automatically generates a "Shadow AI Finding" in the RegulAIt dashboard, prompting the admin to either block the traffic or formally onboard the use case into a governed policy pack.

---

## 4. Full Feature Sweep (Vision vs. Current Reality)

Beyond the gateway and shadow AI features, RegulAIt envisions an 8-pillar architecture. Below is a sweep of these visionary features against what the codebase currently supports, highlighting what still needs to be built:

### Pillar 2: Configurable Workflow Engine
*   **VISION:** An admin-configurable, declarative YAML/JSON workflow template engine supporting stages like Planning (forced no-mutation), Artifact Generation, Multi-party sign-offs, automated PR generation, and Conditional Deployment.
*   **REALITY:** The codebase currently handles inline proxy executions and simple state tracking. It does **not** implement a fully declarative, multi-stage CI/CD pipeline mapped to these governance steps.
*   **NEXT STEPS:** Agents must build the core engine capable of parsing YAML definitions (`stages: [intake, plan, signoff, build, pr, deploy]`) and enforcing state transitions before any code generation or model dispatch is allowed.

### Pillar 6: Token Optimization Layer
*   **VISION:** Seven token-saving techniques applied automatically: routing, edit-vs-rewrite detection, context compaction, lazy tool-loading, request batching, and semantic caching.
*   **REALITY:** Only **two** techniques (semantic caching and basic model routing) are actually applied on the IDE proxy paths.
*   **NEXT STEPS:** Techniques like context compaction or edit-vs-rewrite require specific payload shapes that the standard OpenAI wire format does not support. Agents need to expand the protocol adapters or implement custom clients to support these features.

### Pillar 7: Multi-Agent Orchestration
*   **VISION:** A Project Manager -> Team Lead -> Worker Agent hierarchy that acts as a DAG (Directed Acyclic Graph) of tasks, explicitly detecting serialization and inheriting budgets without escalation.
*   **REALITY:** The current agent routing is mostly direct.
*   **NEXT STEPS:** The system must be upgraded to decompose complex tasks into a DAG, detect non-parallelizable dependencies (to prevent conflicts), and track per-subtask budget caps. The orchestrator must *never* grant a worker agent more entitlements than the human who initiated the run.

### Pillar 8: Native PM Tool Integration
*   **VISION:** Bi-directional sync with Azure DevOps, Jira, Linear, and Asana where the PM tool acts as the *source of truth* for priority and acceptance criteria to avoid a split-brain system of record.
*   **REALITY:** Currently lacks robust bi-directional sync adapters.
*   **NEXT STEPS:** Agents need to build the integration layer so that decisions are recorded as first-class work items, and approvals made inside RegulAIt sync back as status transitions (or comments) on the linked ADO/Jira tickets.

---

## 5. Enterprise Cybersecurity Roadmap

To elevate RegulAIt from an "AI proxy with compliance rules" to a true **enterprise-grade cybersecurity application** (AI SecOps platform), agents should prioritize building the following capabilities:

### A. Active Threat Defense
*   **Prompt Injection & Jailbreak Blocking:** Upgrade the current injection detection from "log mode" to an active firewall layer that blocks prompt injections, system prompt leaks, and malicious payloads *before* they reach the LLM.
*   **Malware & Malicious URL Scanning:** Implement an inspection layer for MCP tools. If an agent fetches a file or webpage, the payload must be scanned for malware or phishing links before it enters the agent's context window.

### B. Enterprise Data Loss Prevention (DLP)
*   **Context-Aware Redaction:** Move beyond static pattern matching (e.g., regex for SSNs). Implement Exact Data Match (EDM) to protect specific customer databases and allow for in-flight redaction/masking rather than just outright dropping the request.
*   **Source Code & IP Protection:** Build classifiers to detect and block the exfiltration of proprietary source code or internal API keys to public models.

### C. SecOps & SIEM/SOAR Integration
*   **Real-time SIEM Streaming:** While WORM storage is good for audits, SOCs need real-time data. Build native streaming integrations for Splunk, Datadog, Microsoft Sentinel, and CrowdStrike LogScale.
*   **Automated Incident Response (SOAR):** Implement webhooks that trigger SOAR platforms when severe violations occur (e.g., repeated jailbreak attempts), allowing for automated remediation like isolating the user or revoking credentials.

### D. Identity & Access Management (IAM) Parity
*   **SCIM Provisioning & SAML SSO:** Build SCIM endpoints to automatically sync users, groups, and roles directly from enterprise directories like Azure AD (Entra ID) or Okta.
*   **Attribute-Based Access Control (ABAC):** Expand the policy engine to evaluate dynamic attributes (e.g., device posture, network location) alongside static roles.

### E. Certifications
*   Code architecture and data handling must strictly align with the requirements for **SOC 2 Type II, ISO 27001, and HIPAA compliance** to satisfy enterprise CISOs.

---

# VERIFICATION APPENDIX — added 2026-09-28 by the Claude session on `dhruv/active`

**Scope: sections 1–4 only.** Section 5 (Enterprise Cybersecurity Roadmap) was
committed after this pass ran and is NOT covered — see "Section 5" at the end.

Sections 1–4 were verified against the code before any of them was built on.
**Four of the "REALITY" lines are wrong or stale, and two of them would have caused
an agent to rebuild features that already ship.** The original text above is left
untouched; this appendix is the correction.

Why this appendix exists at all: this repository has a logged mistake (`mistakes.md`
M-046) from exactly this failure mode — a written-down limitation was carried forward
for five weeks without being re-derived, and the real defect turned out to be far
worse than the sentence describing it. *A limit you wrote down is a claim you have
not re-checked.* So every line below was checked against code, not against docs.

## Corrections — do not build these, they exist

| Claim above | Verdict | Evidence |
| --- | --- | --- |
| "Circuit Breakers" needed | **ALREADY EXISTS** | ADR-0126 + migration `0116_upstream_circuit_breaker.sql`. Per-upstream breaker columns on `mcp_servers`; `breakerAdmits()` consulted on the hot path before the connect (`mcp-proxy.ts:1318`), answering `503 mcp_upstream_circuit_open` with `Retry-After`. Columns deliberately on the server row so reading costs no extra query. |
| "Request Timeouts & Retries" needed | **ALREADY EXISTS** (retries: see caveat) | ADR-0126 + `apps/gateway/src/timeouts.ts`. `requestTimeout` was Fastify's `0` (disabled) and is now set (`app.ts:512`); MCP `connect`/`listTools`/`callTool` each carry a deadline (`mcp-egress.ts:277`, `mcp-proxy.ts:929`, `:1096`); model dispatch is bounded. `connectionTimeout` is deliberately NOT set — it is socket inactivity, and this product streams on purpose (MCP hijack, both compat SSE edges, orchestration SSE, `/v1/audit.csv`). |
| "Payload Size Limits" needed | **ALREADY EXISTED BEFORE ADR-0126** | Fastify defaults `bodyLimit` to 1 MiB and nothing overrode it. ADR-0126 restated it explicitly in `timeouts.ts` and pinned the number with a test, so changing it has to be argued for. This was never a missing bound. |
| "Centralized Rate Limiting & Budgets… limits live in single-process memory… we need Redis or Valkey" | **FALSE, and the remedy is already chosen** | ADR-0125 + migration `0115_rate_limit_counters.sql` audited this exact sentence and found it **too broad**: almost every enforcement counter was already shared because it was already SQL — kernel `rate_limits` (`count()` over `audit_log`), project budgets (`sum(usage_events.cost_usd)`), virtual-key budgets (atomic increment), login lockout, replay guards. Only TWO were per-process, and both were fixed: the HTTP edge limiter now counts in Postgres via `SharedRateLimitStore` (`rate-limit-store.ts`, wired at `app.ts:67`), and the measured run/node budget was made atomic. **Postgres was chosen over a new dependency deliberately**, and the ADR gives the security reason for rejecting the naive one-write-per-request version: a limiter that writes on every unauthenticated request turns a request flood into a Postgres flood, making the limiter the amplifier it exists to prevent. |
| "Pillar 2: does NOT implement a declarative multi-stage pipeline… agents must build the core engine" | **FALSE** | `packages/workflow-kernel/src/index.ts` is a zod-validated declarative engine (stage types `trigger`/`planning`/`artifact_generation`/`human_approval`/`automated_build`/`automated_check`/`git_operation`/`deployment`/`rollback`) with a real state machine, assignment-rule routing and multi-template merge. Persisted in `workflowTemplates`/`workflowInstances`/`workflowEvents`/`workflowArtifacts`. Routes in `apps/gateway/src/workflows.ts`. PR generation calls a real git provider (`createBranch`/`openPullRequest`/`mergePullRequest`), not a stub. **Plan-only is enforced, not advisory**: `plan-only.ts` refuses `409 plan_only_stage` at the actual dispatch entry points (`agents-connectors.ts:3426`, `orchestration.ts:1778`). A test proves out-of-order transitions are refused (`workflow-kernel/src/index.test.ts:466`). |
| "Seven Token Optimization Techniques… only two are actually applied" | **PARTLY TRUE — true only of ONE surface** | "2 of 7 on the compat/IDE paths" is correct and is ADR-0119's own number. But **all seven are implemented and wired on some route**: model routing + semantic caching on compat AND native invoke; edit-vs-rewrite, file pre-processing and context compaction on `POST /v1/agents/:agentId/invoke`; lazy tool-loading on the MCP proxy's manifest endpoint; request batching in orchestration's auto-dispatch. Read as "only two exist", the claim would cause five working techniques to be rebuilt. Also note the reason differs per technique: three are blocked from the compat surface (missing `baseline`/`attachments` fields; statelessness), two were never applicable there — they belong to other surfaces. |
| "Self-Verifying Exports… marketing phrasing is slightly overstated" | **TECHNICALLY TRUE, BUT ALREADY FIXED** | The mechanics described are right: the bundle carries `manifest.json` + detached signature + digests + chain segment, plus `signing-key.pub` explicitly labelled "a CONVENIENCE ONLY" (`export-bundle.ts:32`), and `scripts/verify-export-bundle.sh` **refuses to run at all** without an out-of-band trust root, printing why (a bundle checked against its own bundled key proves only internal consistency). ADR-0116 already identified the overstated deck wording, called it false, and prescribed the replacement sentence. Nothing in `docs/` still claims "self-verifying". No action. |

## Genuinely open — these are real

1. **ACTIVE health checking.** The breaker is *passive*: it learns from failures on real traffic. There is no prober that checks a registered MCP server on a schedule when no traffic is flowing, so a dead upstream is discovered by the first user to hit it. (`/health` and `/v1/health/schedulers` are the gateway's own liveness, not upstream probes.) This is the one item of section 1A that is not already built.
2. **Retry backoff is the SDK's, not ours.** `maxRetries: 2` is set per provider client (`packages/model-provider/src/index.ts:266` and three more) and the deadline now bounds the total, but there is no RegulAIt-owned exponential-backoff policy, no jitter, and no per-upstream retry budget. The claim said "intelligent retry logic (with exponential backoff)" — that part is fair.
3. **Transparent MCP proxying and non-HTTP transports.** Consistent with the claim: the proxy exposes one route (`POST /mcp/:serverId`) and the only MCP client calls are `listTools`/`callTool`, so `resources/*` and `prompts/*` have no path, and there is no `stdio` or SSE transport. (Checked directly; not exhaustively audited for a pass-through branch.)
4. **YAML authoring.** The workflow engine is declarative and JSON-native; there is no YAML parser in the repo. "YAML/JSON" is half true — a thin serialization gap, not an engine gap.
5. **Arbitrary conditional branching** between stages (route to a sub-workflow on outcome) is not in the executable stage types; only a single `condition` gate on `deployment` exists.

## NOT verified in this pass — treat as unknown, not as true

**Pillar 7 (orchestration DAG) and Pillar 8 (PM bi-directional sync).** The verification
agent for these two hit a session rate limit before reporting. `packages/orchestration-kernel`
and `packages/pm-provider` both exist with substantial test suites (27 and 62 tests), and
`pm-provider` has an `inbound.ts`, which is evidence against "lacks bi-directional sync" —
but that is an inference, not a verification. **Do not act on those two "REALITY" lines
either way until someone checks them.**

## Section 5 (Enterprise Cybersecurity Roadmap) — NOT VERIFIED, with three flags

That section landed while this verification was being written, so none of it was
checked. It is listed here so nobody mistakes silence for confirmation. Three items
in it, however, describe things this session has direct evidence already exist —
enough to say "check before building", not enough to call the line wrong:

- **"SAML SSO"** — ADR-0125's audit table names "replay guards (SAML, TOTP, OIDC)"
  among the enforcement mechanisms that are already shared state, which means a SAML
  path exists. SCIM provisioning is a separate question and was not checked.
- **"Attribute-Based Access Control (ABAC) — expand the policy engine to evaluate
  dynamic attributes"** — `packages/policy-kernel/src/abac.ts` already evaluates
  principal attributes including `sessionOrigin` and `mfaCompleted` (`abac.ts:97-99`,
  `:202-203`), and the authorization callout was extended on 2026-09-27 specifically
  to carry them (AER-028). The engine exists; whether it covers *device posture and
  network location* specifically is the open part.
- **"Upgrade the current injection detection from 'log mode' to an active firewall
  layer that blocks"** — a `block` mode already exists and is exercised: the copilot
  test suite runs a guardrail at `block` and asserts samples are withheld. So the
  gap, if any, is which surfaces default to which mode — not the absence of blocking.

Everything else in section 5 (malware/URL scanning, EDM, source-code exfiltration
classifiers, SIEM streaming, SOAR webhooks, SCIM, certification alignment) is
unassessed here.
