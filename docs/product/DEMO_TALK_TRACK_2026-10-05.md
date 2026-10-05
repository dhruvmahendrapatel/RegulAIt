# RegulAIt Positioning Talk Track — AI Intake Demo (v2)

**Date:** 2026-10-05
**Audience:** internal — whoever presents the demo
**Rule:** every claim here is something the demo shows or an ADR documents. Say what RegulAIt
does; do not characterise how any other product works internally.

---

## Core positioning: evidence over attestation

RegulAIt sits on the execution path. The same gateway that governs every agent, model, connector
and MCP-tool call records what happened, so governance can be measured from what the platform
actually saw — and is labelled as an attestation where it cannot be.

### 1. Trust metrics that are evidence coverage, never a fabricated score
- Each of the six dimensions (bias, security, privacy, reliability, safety, compliance) is the
  share of **applicable active-pack controls** that have evidence (ADR-0148).
- **Unmeasured** means no active-pack control applies to that dimension — shown as a gap, never as
  zero. When a control applies but nothing evidences it (e.g. no assessed model card for bias),
  the dimension is **measured at 0 %** (ADR-0150).
- Privacy and safety coverage is evidenced by **guardrail configuration** (the controls are met by
  configured detectors, ADR-0150). Guardrail block counts are a different signal: they resolve
  risks in the register (ADR-0147).

### 2. Intake that screens from structured answers
- The EU AI Act tier is computed by deterministic rules from the proposer's **structured
  answers** (`classifyEuAiActTier`, ADR-0085) — a calculator, not a lawyer, and never from a
  free-text description.
- The intake assistant suggests frameworks, risks, controls and questionnaire drafts from the same
  answers; every suggestion carries its source and is accepted, edited or rejected by a person
  (ADR-0149).
- A shadow-AI finding pre-fills only what the evidence established — name and observed use;
  every screening answer is left for the proposer.

### 3. Separation of duties by construction
- Use-case sign-offs go to a named governance approver (ADR-0165); the proposer cannot approve
  their own registration, and an executable remediation cannot be approved by the person who
  proposed it (ADR-0159).

### 4. The agentic dependency graph
- Nodes: use case, agent, model, vendor, MCP server, connector. Edges are **declared** (what was
  approved) and **observed** (what agents actually called at runtime) (ADR-0156).
- A high risk **recorded** against a vendor, model or agent propagates to everything that depends
  on it **as a maximum**, and the path to the source is shown.

### 5. Continuous monitoring, not point-in-time review
- The governance monitor runs nine rules over the graph, the risk register, trust coverage and
  runtime evidence — hourly and on demand; alerts are condition episodes that raise, refresh and
  resolve (ADR-0157).
- **Continuous trace evaluation** re-runs the shipped detectors over stored responses every 15
  minutes and reports **counts only** — it found a credential the inline guardrail let through
  (ADR-0160).
- **Routing outside the approved stack**: when cost optimization serves an approved use case's
  traffic from an agent its approval never named, the monitor says so, with the measured call
  count. It changes no routing; a person decides (ADR-0164).

### 6. Respond, with a human in the loop
- From an alert, the planner proposes remediations. Two kinds are **executable** — link a control,
  assign an owner — and run only after a **different** human approves them; everything else is
  guidance with steps (ADR-0159).
- Alerts can also be posted to Slack or Teams by severity threshold, through the same egress
  allow-list as everything else (ADR-0162).

### 7. Enforcement where releases happen
- **Deploy gate**: a pipeline asks `POST /v1/gates/deploy` whether a use case may ship. Approval,
  the approved stack, halts, the model-risk decision and open alerts combine into allow/deny with
  reasons; an open HIGH alert blocks, an acknowledged one warns; every answer is audited with the
  build ref (ADR-0161). It also checks, live and strict by default, that the AI tests the risk tier
  requires passed recently on the configuration being shipped (ADR-0180). Shown live with `demo:gate`.

### 8. Regulatory intelligence joined to our own state
- A curated, source-dated feed of obligations (e.g. the Digital Omnibus on AI moving Annex III
  high-risk obligations to 2 December 2027) joined to active packs, live control status and the
  use cases in scope (ADR-0158).

---

## Lines to use in the demo

1. "Coverage is evidence, and an unmeasured dimension is a gap, not a zero." (Trust dashboard)
2. "The inventory separates what an agent is GRANTED from what it was OBSERVED doing
   (ADR-0082)." (`/ui/admin/inventory`; the agent card is on Use-case 360 → Stack)
3. "The tier comes from the structured answers — deterministic and explainable." (Intake)
4. "Nothing changes governed state until a different human approves it." (Remediation, ADR-0159)
5. "We evaluate stored responses continuously and keep only counts." (Trace evaluation, ADR-0160)
6. "The pipeline asks the same governance state the runtime enforces." (Deploy gate, ADR-0161)
7. "The optimizer saved money by moving approved traffic — and the monitor told us it left the
   approved stack." (ADR-0164)

**Never claim** that RegulAIt fixes risks automatically. Discovery, mapping and monitoring are
automated; remediation and approval are human-gated.
