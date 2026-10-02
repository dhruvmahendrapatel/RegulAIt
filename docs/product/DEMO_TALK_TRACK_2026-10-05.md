# RegulAIt vs. Credo AI: Positioning Talk Track

**Date:** 2026-10-05
**Audience:** Internal Sales & Demo Leads

---

## Core Positioning: "Evidence Over Attestation"

When talking to prospects comparing RegulAIt to Credo AI (or traditional GRC platforms like OneTrust), the key differentiation lies in **how risk is evidenced**. 

Credo AI relies heavily on manual attestations, surveys, and third-party assessments to populate its dashboards. RegulAIt connects directly to the execution layer. We don't ask developers if their app is secure; we check the gateway logs and the actual guardrail configurations.

### Key Differentiator 1: Live, Ledger-Backed Trust Metrics
**Our Claim:** RegulAIt's Trust Dashboard never fabricates a metric. If we can't measure it, we show an explicit gap.
**The Proof:** 
- As outlined in **ADR-0148 (Trust dashboard API)**, our six trust dimensions (Bias, Security, Privacy, Reliability, Safety, Compliance) are backed strictly by ledger telemetry. 
- For example, if a model's bias hasn't been formally assessed in a model card (per **ADR-0147**), the dashboard explicitly labels it "unmeasured" rather than averaging it to zero or 100%. We measure the *coverage of evidence*, not a subjective "Trust Score".

### Key Differentiator 2: The Agentic Dependency Graph
**Our Claim:** Traditional AI GRC tools track static models. RegulAIt tracks autonomous, multi-step agents and their runtime dependencies.
**The Proof:**
- **ADR-0156 (Dependency graph + risk propagation)** introduced a live dependency graph (`GET /v1/inventory/graph`) that links Use Cases → Agents → MCP Servers / Tools.
- We track both *declared* edges (what was approved) and *observed* edges (what the agent actually called at runtime). 
- If a third-party vendor introduces a vulnerability, the risk automatically propagates up the graph to the Use Case, triggering alerts.

### Key Differentiator 3: Automated Governance Monitoring
**Our Claim:** RegulAIt shifts governance from a point-in-time audit to continuous monitoring.
**The Proof:**
- **ADR-0157 (Governance monitor + alerts)** acts as a continuous rule engine over our risk register and dependency graph.
- If an agent is running without an approved model card, or a high-risk system drops its mitigating controls, the Monitor immediately raises a severity alert. Credo AI would only catch this during a quarterly manual review.

### Key Differentiator 4: Intake Assistance Without the Burden
**Our Claim:** We reduce friction for developers by using AI to draft risk questionnaires based on plain-language descriptions.
**The Proof:**
- **ADR-0149 (Intake assistant API)** powers our Intake Wizard. A business owner describes an app, and the system automatically proposes the EU AI Act risk tier and maps the necessary framework controls (e.g., NIST AI RMF, ISO 42001). We guide the user instead of handing them a blank 100-question spreadsheet.

---

## Verifiable Claims to Highlight in Demos

1. **"Our guardrail metrics reflect actual API blocks."** (Show the Privacy/Safety dimensions on the Trust Dashboard).
2. **"Our agent cards show observed tool usage, not just intended tool usage."** (Show the Use-Case 360 Stack tab).
3. **"We support EU AI Act tiering right at intake."** (Show the Intake Assistant).

*Note: Never claim that RegulAIt automatically fixes risks. We automate the discovery, mapping, and monitoring of risks, but remediation and approval are always human-gated.*
