# RegulAIt: Evidence-Based AI Governance

RegulAIt governs AI from the execution path. The gateway that authorises every agent, model,
connector and MCP-tool call also records what happened, so governance is measured from what the
platform saw — and labelled as an attestation where it cannot be.

## 1. Discover & Register
RegulAIt classifies the evidence you import — SaaS exports, egress logs, code scans — to find AI
in use that nobody registered. A finding becomes a governed proposal in one step: the intake
wizard pre-fills only what the evidence established, and the proposer answers the EU AI Act
screening. The risk tier is computed from those structured answers by deterministic rules, with
the reasons shown (ADR-0085); suggested frameworks, risks and controls are accepted, edited or
rejected by a person (ADR-0149).

## 2. Assess & Deploy
Each use case has a 360 view of its frameworks, risks, stack, dependencies, approvals and audit
trail. Risks carry declared inherent and residual positions — likelihood and impact chosen by a
person, residual tied to named controls; no scores, no arithmetic (ADR-0147). A dependency graph
(its own page, and a tab on each use case) shows how a high risk recorded against a vendor, model
or agent propagates to everything that depends on it (ADR-0156). Sign-off goes to a named
governance approver, never the proposer (ADR-0165). When a pipeline calls the deploy gate, it
refuses a release that is not approved, uses an agent outside the approved stack, is halted,
fails the model-risk gate, or has an open high alert (ADR-0161).

## 3. Monitor & Respond
The trust dashboard shows, per dimension, the share of applicable controls with evidence; a
dimension with nothing to measure is shown as a gap (ADR-0148). The governance monitor raises and
resolves alerts as conditions change (ADR-0157), including content flagged by continuous trace
evaluation — counts only (ADR-0160) — and approved traffic that cost routing served from an
unapproved agent (ADR-0164). From an alert, an executable remediation runs only after a different
person approves it (ADR-0159). Alerts reach Slack or Teams by severity (ADR-0162), and everything
lands in one hash-chained audit trail exportable as a signed bundle (ADR-0060).

---

### What we never claim
- **No fabricated scores.** We report evidence coverage; an unmeasured dimension is a gap.
- **Attestations are labelled.** Controls met by a documented review are marked as such.
- **Remediation is human-approved.** A remediation proposal changes governed state only after a
  second person approves it. (Administrators can still edit records directly — audited.)
- **Screening is not legal advice.** The tier is a calculator over your answers.
