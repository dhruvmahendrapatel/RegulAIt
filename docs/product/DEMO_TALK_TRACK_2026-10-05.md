# RegulAIt vs. Credo AI: Positioning Talk Track

**Date:** 2026-10-05
**Audience:** Internal Sales & Demo Leads

---

## Core Positioning: "Evidence Over Attestation"

When talking to prospects comparing RegulAIt to traditional GRC platforms, the key differentiation lies in **how risk is evidenced**. 

RegulAIt connects directly to the execution layer. We don't ask developers if their app is secure; we check the gateway logs and the actual guardrail configurations.

### Key Differentiator 1: Live, Ledger-Backed Trust Metrics
**Our Claim:** RegulAIt's Trust Dashboard never fabricates a metric. If we can't measure it, we show an explicit gap.
**The Proof:** 
- As outlined in **ADR-0148 (Trust dashboard API)**, our six trust dimensions (Bias, Security, Privacy, Reliability, Safety, Compliance) measure evidence coverage from collectors over platform ledgers; attestation-based controls are labelled. 
- For example, if a model's bias hasn't been formally assessed in a model card (per **ADR-0147**), the dashboard explicitly labels it "unmeasured". We measure the *coverage of evidence*, not a subjective "Trust Score".

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
- If an agent is running without an approved model card, or a high-risk system drops its mitigating controls, the Monitor raises on the next monitor pass (hourly, or on demand).

### Key Differentiator 4: Intake Assistance Without the Burden
**Our Claim:** We reduce friction for developers by using deterministic rules to draft risk questionnaires based on plain-language descriptions, while any AI narrative generation is optional, governed, and clearly labelled.
**The Proof:**
- **ADR-0149 (Intake assistant API)** powers our Intake Wizard. A developer describes an app, and the system automatically proposes the EU AI Act risk tier and maps the necessary framework controls (e.g., NIST AI RMF, ISO 42001) using deterministic rules. We guide the user instead of handing them a blank 100-question spreadsheet.

---

## Verifiable Claims to Highlight in Demos

1. **"Our guardrail metrics reflect actual API blocks."** (Show the Privacy/Safety dimensions on the Trust Dashboard).
2. **"Our agent cards link to the inventory record, which separates GRANTED from OBSERVED tools (ADR-0082)."** (Show the Use-Case 360 Stack tab).
3. **"We support EU AI Act tiering right at intake."** (Show the Intake Assistant).
4. **"Our remediations require human approval."** (Show that executable remediations trigger an approval workflow, per **ADR-0159**).
5. **"We continuously evaluate traces with shipped detectors, exposing only violation counts."** (Show the trace evaluation counts, backed by **ADR-0160**).
6. **"Our CI/CD deploy gate enforces compliance programmatically."** (Show a pipeline step being blocked by an open high alert and then allowed upon acknowledgment, per **ADR-0161**).

*Note: Never claim that RegulAIt automatically fixes risks. We automate the discovery, mapping, and monitoring of risks, but remediation and approval are always human-gated.*
