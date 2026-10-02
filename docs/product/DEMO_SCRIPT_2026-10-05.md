# AI Intake Demo Script — 2026-10-05

**Objective:** Showcase the three phases of agentic AI governance (Discover & Register, Assess & Deploy, Monitor & Respond) through a single, cohesive journey: Acme Bank deploying a credit-limit-increase assistant.

---

## 0. Setup and Preparation
- **Database:** Ensure a clean seeded database by running `pnpm --filter @regulait/gateway seed`, then `demo:setup`, then `demo:intake` (in that order). The `seed` command prints one-time passwords for the personas below — keep them handy to log in.
- **Browser:** Two browser profiles ready (to switch personas seamlessly without logging in and out).
  - Profile A: **Dana** (Developer / Proposer)
  - Profile B: **Avery** (Risk Reviewer / Approver)
- **Fallback Rule:** Every beat uses the keyless **mock** provider. No live models are required.

---

## 1. Phase 1: Discover & Register

### Beat 1A: Shadow AI Discovery *(CONDITIONAL on task X4)*
- **Persona:** Dana
- **URL:** `/ui/admin/governance/shadow-ai` (or via Inbox)
- **Screen State:** A list of discovered shadow-AI usage. One item highlights an unregistered LLM tool (a credit-limit-increase assistant) in use.
- **Action:**
  1. Click on the shadow-AI finding.
  2. Click **"Register as use case"**. *(Fallback if X4 is incomplete: just open the intake wizard directly at `/ui/admin/governance/intake`)*
- **Talking Point:** "Governance often begins not with a formal request, but by discovering shadow AI. Here, RegulAIt has detected an unregistered credit assistant being tested. Instead of simply blocking it, Dana can easily bring it into the governed fold."

### Beat 1B: AI Intake Wizard
- **Persona:** Dana
- **URL:** `/ui/admin/governance/intake` (Prefilled from Shadow AI, or direct)
- **Screen State:** The Intake Wizard with steps: Describe → Assistant suggestions → Questionnaire → Link stack → Review & submit.
- **Action:**
  1. Under "Describe", enter a plain language description of the credit-limit-increase assistant.
  2. Click **Next** to generate Assistant Suggestions.
  3. Review the auto-generated suggestions (EU AI Act tier proposal, frameworks, risks). Note the `source: rules` badge (deterministic logic). The narrative draft will be labelled `mock` unless a live model is configured.
  4. Accept the suggestions and proceed to the Questionnaire. (Observe pre-filled answers from `fixtures.ts`: essential-services + profilesNaturalPersons).
  5. Proceed to the "Stack" step: Link the `mock-balanced` model, vendor, and agent.
  6. Review & Submit.
- **Talking Point:** "Instead of making developers fill out massive spreadsheets, RegulAIt's deterministic rules propose a regulatory tier based on a plain-language description. It suggests we trigger EU AI Act High-Risk requirements because we're making credit decisions."
- **Recovery Step:** If the assistant API (`POST /v1/use-cases/intake/assist`) fails, manually fill in the first 3 fields of the questionnaire and proceed to Submit.

---

## 2. Phase 2: Assess & Deploy

### Beat 2A: Use-Case 360 and Risk Linking
- **Persona:** Dana
- **URL:** `/ui/admin/governance/use-cases/<new_use_case_id>`
- **Screen State:** Use-case 360 page showing status as `under_review`, Tier as `High`, and the 6 tabs (Overview, Frameworks, Risks, Stack, Approvals, Audit).
- **Action:**
  1. Navigate to the **Stack** tab. Show the Agent Card (`/v1/agents/:id/card`), highlighting purpose and data sources. Note that *observed* tools live on the inventory record linked from the agent card.
  2. Navigate to the **Risks** tab. 
  3. Show the automatically mapped risks. Click **Add risk from library** *(CONDITIONAL on X8; fallback is to create the risk using the manual form)*.
  4. Pick an agentic risk scenario (e.g., *Credit model disparate impact*).
  5. Link a suggested control (e.g., `eu-ai-act:art-14-human-oversight`).
  6. Show the Inherent vs. Residual risk reduction.
- **Talking Point:** "The use-case 360 view connects the agent, the model, and the vendor. Because this is high-risk, RegulAIt mapped EU AI Act, NIST AI RMF, and ISO 42001 frameworks automatically. We can pull specific agentic risks from our curated library and link platform controls to reduce our residual risk."
- **Recovery Step:** If linking controls fails, highlight the inherent risk scores and move on to the Approvals tab.

### Beat 2B: Approval Gate
- **Persona:** Avery (Risk Reviewer)
- **URL:** `/ui/admin/governance/inbox` or `/ui/admin/governance/use-cases/<new_use_case_id>` (Approvals tab)
- **Screen State:** A pending approval request for the new use case.
- **Action:**
  1. Review the linked risks and controls.
  2. Click **Approve** and provide a short note.
  3. Check the **Audit** tab to show the recorded immutable audit row.
- **Talking Point:** "With separation of duties, Avery reviews the residual risk and the linked controls. Approving it writes an immutable audit record, safely gating the deployment."

---

## 3. Phase 3: Monitor & Respond

### Beat 3A: Trust Dashboard
- **Persona:** Avery
- **URL:** `/ui/admin/governance/trust`
- **Screen State:** Six-dimension radar chart, KPI tiles, 3x3 heatmap, and dimension drill-downs.
- **Action:**
  1. Highlight the six-axis radar (Bias, Security, Privacy, Reliability, Safety, Compliance).
  2. Note the "Evidence coverage %" (not a fabricated "score").
  3. Show the `bias` axis gap. An axis is "unmeasured" when no active pack control applies to it.
  4. Click into the `security` drill-down.
- **Talking Point:** "Once deployed, we don't rely on static attestations. This Trust Dashboard is driven purely by evidence coverage from collectors over platform ledgers, with attestation-based controls clearly labelled (like documented model-card assessments for bias). Unmeasured dimensions show up as a clear gap, keeping us honest."

### Beat 3B: Continuous Governance Escalation
- **Persona:** Avery
- **URL:** `/ui/admin/governance/alerts`
- **Screen State:** Governance Monitor alerts list.
- **Action:**
  1. The monitor runs hourly (or on "Evaluate now") and alerts on 7 specific governance rules.
  2. Click into an inherited-risk alert to see `detail.pathLabels` (e.g., Use Case → Agent → Vendor).
  3. Click **Acknowledge** with a mandatory note.
  4. Generate a signed Audit Export (`?signed=1`). *(CONDITIONAL on X4)*
- **Talking Point:** "When a dependency inherits a new risk, the Governance Monitor triggers an alert on the next monitor pass. We can see exactly where the risk propagated in our dependency graph and export a cryptographically signed audit trail for the regulators."
- **Recovery Step:** If the real-time alert is delayed, click **Evaluate now** to force the `governance-monitor-sweep` job.

---

## Honest Disclaimer: What is Mock vs. Live?
- **Mock:**
  - The model provider is a keyless mock (`mock-balanced`). No live AI API calls are strictly required for the demo to succeed.
  - The initial "Shadow AI" discovery event is a seeded artifact.
- **Live:**
  - The API endpoints (Trust dashboard, Intake assist, Use-case 360, Graph API).
  - **Metrics:** All dashboard metrics are driven by real database queries over the seeded ledgers (no hardcoded "98% safe" numbers).
  - **Risk Math:** The Inherent vs Residual logic is fully backed by the database schema (ADR-0147).
