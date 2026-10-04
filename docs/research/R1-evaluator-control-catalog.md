| Evaluator | What it checks | Method (heuristic/LLM judge/code/human) | NIST AI RMF 1.0 subcategories | ISO/IEC 42001:2023 Annex A controls | EU AI Act articles | OWASP LLM Top 10 2025 ID | Sources |
|---|---|---|---|---|---|---|---|
| **Security: PII Leakage** | Detects output of sensitive personal data (SSN, credit cards, emails) | Heuristic / Regex | MEASURE-2.7 | A.7.2.3 Data privacy | Art. 10(5) Data governance | LLM06: Sensitive Information Disclosure | NIST AI RMF, OWASP |
| **Security: Prompt Injection** | Detects attempts to override system instructions via user inputs | LLM judge / Heuristic | MEASURE-2.6 | A.7.2.4 Security | Art. 15 Accuracy, robustness, cybersecurity | LLM01: Prompt Injection | OWASP |
| **Security: Code Injection** | Identifies malicious executable code in inputs or outputs | Code / Heuristic | MEASURE-2.6 | A.7.2.4 Security | Art. 15 | LLM01: Prompt Injection, LLM04: Insecure Output Handling | OWASP |
| **Security: Secret Exfiltration** | Detects API keys or credentials in agent outputs | Heuristic / Regex | MEASURE-2.7 | A.7.2.4 Security | Art. 15 | LLM06: Sensitive Information Disclosure | OWASP |
| **Security: Jailbreak Attempts** | Detects known jailbreak patterns or adversarial framing | Heuristic / LLM judge | MEASURE-2.6 | A.7.2.4 Security | Art. 15 | LLM01: Prompt Injection | OWASP |
| **Security: SSRF Attempts** | Detects agent attempting to fetch internal network resources | Code / Sandbox | MEASURE-2.6 | A.7.2.4 Security | Art. 15 | LLM07: Insecure Plugin Design | OWASP |
| **Security: Unauthorized Access** | Checks if agent accessed data outside its permitted scope | Code / Log analysis | MANAGE-2.3 | A.7.2.4 Security | Art. 15 | LLM02: Insecure Output Handling | OWASP |
| **Security: Cryptographic Weakness** | Checks if code generated uses weak hashing (e.g., MD5) | Heuristic / Code analysis | MEASURE-2.6 | A.7.2.4 Security | Art. 15 | LLM04: Insecure Output Handling | OWASP |
| **Safety: Toxicity** | Measures offensive, hateful, or toxic language in output | LLM judge / Classifier | MEASURE-2.11 | A.7.2.2 Fairness | Art. 10 | N/A | NIST AI RMF |
| **Safety: Bias/Fairness (Demographic)** | Measures disparate outcomes based on gender, race, age | LLM judge / Statistical | MEASURE-2.11 | A.7.2.2 Fairness | Art. 10 | N/A | NIST AI RMF |
| **Safety: Harmful Advice** | Detects instructions for illegal or dangerous activities | LLM judge | MEASURE-2.4 | A.7.2.1 General safety | Art. 15 | N/A | NIST AI RMF |
| **Safety: Self-Harm Encouragement** | Detects content promoting or facilitating self-harm | LLM judge | MEASURE-2.4 | A.7.2.1 General safety | Art. 15 | N/A | NIST AI RMF |
| **Safety: Misinformation** | Detects generation of known falsehoods or conspiracy theories | LLM judge | MEASURE-2.4 | A.7.2.1 General safety | Art. 15 | N/A | NIST AI RMF |
| **Quality: Hallucination** | Measures factual inaccuracies not grounded in provided context | LLM judge | MEASURE-2.7 | A.7.2.1 General safety | Art. 15 | LLM09: Overreliance | OWASP |
| **Quality: Groundedness** | Verifies output claims are fully supported by context | LLM judge | MEASURE-2.7 | A.7.2.1 General safety | Art. 15 | LLM09: Overreliance | OWASP |
| **Quality: Relevance** | Measures if the response directly answers the user's query | LLM judge | MEASURE-2.1 | A.7.1.1 System requirements | N/A | N/A | NIST AI RMF |
| **Quality: Coherence** | Evaluates the logical flow and readability of the output | LLM judge | MEASURE-2.1 | A.7.1.1 System requirements | N/A | N/A | NIST AI RMF |
| **Quality: Summarization Accuracy** | Checks if key points are captured without alteration | LLM judge | MEASURE-2.7 | A.7.1.1 System requirements | Art. 15 | N/A | NIST AI RMF |
| **Quality: Code Correctness** | Validates generated code syntax and execution | Code / Sandbox | MEASURE-2.1 | A.7.1.1 System requirements | N/A | N/A | NIST AI RMF |
| **Conversation: AI Disclosure** | Checks if the agent identifies itself as an AI | Heuristic / LLM judge | GOVERN-4.1 | A.7.2.5 Transparency | Art. 50 Transparency | N/A | EU AI Act |
| **Conversation: Human Escalation** | Verifies the agent offers or executes human handoff when stuck | LLM judge / Code | MANAGE-2.3 | A.7.2.6 Human oversight | Art. 14 Human oversight | N/A | EU AI Act |
| **Conversation: Empathy** | Evaluates appropriate tone and empathy for sensitive topics | LLM judge | MEASURE-2.1 | A.7.1.1 System requirements | N/A | N/A | NIST AI RMF |
| **Conversation: Politeness** | Checks for professional and polite language | LLM judge | MEASURE-2.1 | A.7.1.1 System requirements | N/A | N/A | NIST AI RMF |
| **Conversation: Refusal Compliance** | Checks if the agent properly refuses prohibited requests | LLM judge | MEASURE-2.6 | A.7.2.4 Security | Art. 15 | N/A | NIST AI RMF |
| **Agent: Tool Selection Accuracy** | Verifies the correct tool was called for the intent | LLM judge / Code | MEASURE-2.1 | A.7.1.1 System requirements | N/A | LLM07: Insecure Plugin Design | OWASP |
| **Agent: Plan Adherence** | Checks if the agent followed its generated multi-step plan | LLM judge | MEASURE-2.1 | A.7.1.1 System requirements | N/A | N/A | NIST AI RMF |
| **Agent: Excessive Agency** | Detects actions taken without required human approval | Code / LLM judge | MANAGE-2.3 | A.7.2.6 Human oversight | Art. 14 Human oversight | LLM08: Excessive Agency | OWASP |
| **Agent: Parameter Validation** | Checks if the agent passed malformed arguments to tools | Code / Heuristic | MEASURE-2.6 | A.7.2.4 Security | Art. 15 | LLM07: Insecure Plugin Design | OWASP |
| **Agent: Infinite Looping** | Detects agent stuck in repetitive tool-calling cycles | Code / Heuristic | MEASURE-2.1 | A.7.1.1 System requirements | N/A | LLM05: Improper Error Handling | OWASP |
| **Agent: Graceful Degradation** | Checks response when a required tool API fails | LLM judge | MEASURE-2.1 | A.7.1.1 System requirements | N/A | LLM05: Improper Error Handling | OWASP |
| **Image: NSFW Content** | Detects generation of explicit or inappropriate images | Classifier | MEASURE-2.4 | A.7.2.1 General safety | Art. 15 | N/A | NIST AI RMF |
| **Image: Deepfake Generation** | Detects attempts to generate photorealistic public figures | Classifier / Heuristic | MEASURE-2.4 | A.7.2.1 General safety | Art. 50 | N/A | EU AI Act |
| **Image: Watermarking Presence** | Verifies synthetic images contain required origin watermarks | Code / Heuristic | GOVERN-4.1 | A.7.2.5 Transparency | Art. 50 | N/A | EU AI Act |
| **Voice: Voice Cloning** | Detects attempts to clone specific human voices without consent | Classifier / Heuristic | MEASURE-2.4 | A.7.2.1 General safety | Art. 50 | N/A | EU AI Act |
| **Voice: Synthetic Audio Disclosure** | Verifies generated audio states it is AI-generated | Heuristic | GOVERN-4.1 | A.7.2.5 Transparency | Art. 50 | N/A | EU AI Act |
