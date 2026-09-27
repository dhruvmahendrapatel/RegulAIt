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
