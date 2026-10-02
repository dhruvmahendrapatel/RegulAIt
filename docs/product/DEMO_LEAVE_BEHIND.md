# RegulAIt: Evidence-Based AI Governance
RegulAIt bridges the gap between regulatory requirements and technical reality. Unlike traditional governance tools that rely on spreadsheets and point-in-time surveys, RegulAIt connects directly to your AI execution layer.

## 1. Discover & Register
You can't govern what you don't know exists. RegulAIt begins by integrating with your environment to discover Shadow AI usage. When an unregistered AI tool is found, developers can quickly bring it into the fold using our Assisted Intake Wizard (**ADR-0149**). Using deterministic rules, the wizard drafts risk questionnaires and proposes regulatory tiers based on plain-language descriptions—such as classifying an agent under the EU AI Act High-Risk tier—eliminating manual guesswork.

## 2. Assess & Deploy
Once a use case is registered, RegulAIt maps it against established frameworks like the EU AI Act, NIST AI RMF, and ISO 42001. A comprehensive Use-Case 360 view provides a complete agentic dependency graph (**ADR-0156**), tracing the relationships between your use case, autonomous agents, models, and third-party vendors.

Before any deployment, separation of duties is enforced. A risk reviewer must evaluate the inherent and residual risk scores (**ADR-0147**) and approve the use case, writing an immutable audit record. Our CI/CD Deploy Gate (**ADR-0161**) integrates this approval directly into your pipelines, blocking unapproved or non-compliant systems from reaching production.

## 3. Monitor & Respond
Governance is continuous. The Trust Dashboard provides a live, six-dimension view of your AI posture driven entirely by evidence coverage, rather than subjective trust scores (**ADR-0148**). If a dependency inherits a new risk, the Governance Monitor triggers an alert on its next pass (**ADR-0157**). From there, you can trace the exact path of the risk and propose an executable remediation—such as linking a new control—which then undergoes a strict human approval process (**ADR-0159**). Furthermore, continuous trace evaluations expose violation counts using shipped detectors without leaking sensitive payload data (**ADR-0160**).

---

### What We Never Claim
- **No Fabricated Scores:** We measure the coverage of evidence. If a dimension is unmeasured, we explicitly label it as a gap rather than inventing a "98% safe" score.
- **Attestations are Labelled:** We distinguish between runtime evidence and static attestations. If a control relies on a manual model-card review, it is clearly labelled as such.
- **Human in the Loop:** RegulAIt automates discovery and monitoring, but it does not auto-remediate. Nothing changes your governed state without a second human's explicit approval.
