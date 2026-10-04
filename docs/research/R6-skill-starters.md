```yaml
name: eu-ai-act-tier-mapping
description: Use when determining the regulatory tier of a new AI system under the EU AI Act based on its purpose and capabilities.
```
# EU AI Act Tier Mapping
Purpose: To accurately classify an AI system into one of the four EU AI Act risk tiers (Prohibited, High-Risk, Limited, Minimal/None) based on its intended use and context.
## Steps
1. Review the AI system's intended purpose, deployment context, and affected persons.
2. Check against Article 5 (Prohibited AI practices). If a match, classify as Prohibited.
3. Check against Annex I (Safety components) and Annex III (High-risk areas like biometric categorization, critical infrastructure, education, employment, access to essential services, law enforcement). If a match, classify as High-Risk.
4. Check against Article 50 (Transparency obligations for chatbots, deepfakes, emotion recognition). If a match but not High-Risk, classify as Limited Risk.
5. If none of the above apply, classify as Minimal/No Risk.
## Output format
Markdown table indicating the determined tier, the specific Article/Annex citation, and a brief rationale for the decision.
## Never
Never provide formal legal advice, and never downgrade a High-Risk classification without explicit human legal review.

```yaml
name: vendor-ai-due-diligence-questionnaire
description: Use when drafting a security and compliance questionnaire for a prospective third-party AI model or tool vendor.
```
# Vendor AI Due-Diligence Questionnaire
Purpose: To generate a comprehensive set of questions for third-party AI vendors covering data privacy, security, and model governance.
## Steps
1. Identify the type of AI service (e.g., foundation model API, SaaS with embedded AI, custom model developer).
2. Generate questions on data retention (e.g., "Are customer inputs used to train your models?").
3. Generate questions on security certifications (e.g., SOC 2, ISO 27001, ISO 42001).
4. Generate questions on model robustness, bias testing, and red-teaming practices.
5. Format the questionnaire for vendor completion.
## Output format
A structured list of questions grouped by domain (Data Privacy, Security, Model Governance, Legal/Compliance).
## Never
Never invent compliance certifications that do not exist, and never accept a vendor's marketing material as verified proof of compliance.

```yaml
name: audit-trail-summary-for-a-reviewer
description: Use when a human reviewer needs a concise summary of an AI system's automated audit trail prior to deployment approval.
```
# Audit-Trail Summary for a Reviewer
Purpose: To synthesize complex technical logs and compliance checks into a readable summary for a human approver.
## Steps
1. Aggregate the system's intake form, risk assessment, and automated control validations.
2. Identify any controls that failed validation or lack evidence.
3. Highlight any residual high or critical risks.
4. Summarize the deployment pipeline checks (e.g., security scans, model evaluations).
## Output format
A 3-5 bullet point executive summary followed by a "Red Flags / Open Items" section highlighting unresolved issues.
## Never
Never alter or omit failed checks, and never mark an unverified control as satisfied.

```yaml
name: model-card
description: Use when creating a standardized transparency document (Model Card) for a newly deployed AI model or agent.
```
# Model Card
Purpose: To document the intended use, performance characteristics, limitations, and ethical considerations of an AI model.
## Steps
1. Extract model metadata (name, version, developer, release date).
2. Define the intended use cases and explicitly state out-of-scope uses.
3. Summarize the training data sources, including any PII mitigation steps.
4. Document evaluation metrics (accuracy, robustness, fairness) across different demographics if applicable.
5. List known limitations and potential risks.
## Output format
A standardized markdown template following the Mitchell et al. (2019) Model Card framework.
## Never
Never fabricate performance metrics, and never hide known critical limitations or biases.

```yaml
name: prompt-injection-risk-check
description: Use when evaluating an LLM application's susceptibility to prompt injection and generating mitigation recommendations.
```
# Prompt-Injection Risk Check
Purpose: To assess the risk of adversarial prompt injection (OWASP LLM01) in a given AI agent architecture and recommend defenses.
## Steps
1. Review the agent's system prompt and input handling architecture.
2. Identify if untrusted user input is concatenated directly with system instructions.
3. Check for the presence of mitigation controls (e.g., input validation, delimiter usage, secondary LLM intent classification).
4. Evaluate the potential impact if an injection succeeds (e.g., data exfiltration, unauthorized tool use).
## Output format
A risk rating (Low, Medium, High) accompanied by a bulleted list of specific architectural recommendations (e.g., "Implement parameterization for tool calls").
## Never
Never execute live prompt injection attacks against production systems, and never guarantee that an application is 100% immune to injection.

```yaml
name: dpia-section
description: Use when drafting the technical data processing section of a Data Protection Impact Assessment (DPIA) for an AI system.
```
# DPIA Section
Purpose: To accurately document the flow of personal data through an AI system to assist privacy teams with GDPR/CCPA compliance.
## Steps
1. Identify all categories of personal data processed by the AI system (e.g., names, financial data, health records).
2. Document the data flow from collection, through the AI model (inference/training), to storage and deletion.
3. Identify the lawful basis for processing and any automated decision-making (ADM) impacts.
4. List the technical safeguards applied to the data (e.g., encryption, pseudonymization, zero-retention API agreements).
## Output format
A structured narrative document ready to be inserted into the organization's official DPIA template.
## Never
Never sign off on the DPIA or make legal determinations regarding the lawfulness of processing.

```yaml
name: least-privilege-check-of-an-agents-tools
description: Use when reviewing the permissions granted to an AI agent to ensure it only has the access necessary for its intended purpose.
```
# Least-Privilege Check of an Agent's Tools
Purpose: To enforce the principle of least privilege by identifying over-provisioned access rights granted to an AI agent.
## Steps
1. Review the agent's approved use case and intended functionality.
2. List all tools, APIs, and data sources the agent is currently authorized to access.
3. Compare the required capabilities against the granted permissions.
4. Flag any permissions that are overly broad (e.g., `s3:*` instead of `s3:GetObject` on a specific bucket) or unnecessary for the stated purpose.
## Output format
A table mapping "Intended Purpose", "Granted Permission", and "Recommendation (Keep / Reduce / Revoke)".
## Never
Never autonomously revoke access in a production environment without human approval.

```yaml
name: incident-timeline
description: Use when reconstructing the sequence of events during an AI governance or security incident.
```
# Incident Timeline
Purpose: To create a chronological record of an AI-related incident (e.g., data leak, model hallucination leading to harm) for root cause analysis.
## Steps
1. Gather logs from the AI gateway, application servers, and security monitoring tools.
2. Identify the initial trigger (e.g., malicious user prompt, model update).
3. Sequence the events in UTC, detailing the system's actions and any human interventions.
4. Highlight the point of failure or policy breach.
## Output format
A bulleted chronological timeline with exact UTC timestamps, followed by a brief summary of the impact.
## Never
Never alter timestamps, delete logs, or obscure the actions of specific users or models.

```yaml
name: policy-to-control-tests
description: Use when translating a high-level corporate AI policy into specific, testable technical controls.
```
# Policy → Control Tests
Purpose: To bridge the gap between abstract governance policies and concrete engineering implementation.
## Steps
1. Ingest a corporate policy statement (e.g., "AI systems must not use customer data for training without consent").
2. Identify the technical mechanisms required to enforce the policy.
3. Draft specific, measurable test cases (e.g., "Verify API configuration uses `opt_out=true` flag").
4. Map the test cases to relevant compliance frameworks (e.g., ISO 42001).
## Output format
A list of control objectives, each with 1-3 specific, automatable validation tests (e.g., "Check X configuration in Y system").
## Never
Never create controls that contradict existing security baselines or mandate unfeasible technical implementations.

```yaml
name: quarterly-ai-risk-summary
description: Use when aggregating AI risk data for a quarterly executive or board-level report.
```
# Quarterly AI Risk Summary
Purpose: To synthesize a quarter's worth of AI governance metrics, incidents, and deployments into an executive overview.
## Steps
1. Query the trust dashboard and incident management system for the past 90 days.
2. Aggregate the number of newly approved AI use cases, classified by risk tier.
3. Summarize any significant governance alerts or security incidents and their remediation status.
4. Calculate the overall control coverage and compliance posture.
## Output format
A high-level executive summary (max 3 paragraphs) accompanied by 3-5 key metrics (e.g., "Open High Risks: 2").
## Never
Never downplay or omit critical incidents, and never fabricate metrics to show a better compliance posture.
