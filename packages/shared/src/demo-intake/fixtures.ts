import type { DemoIntakeFixtures } from "../demo-intake-types.js";

export const DEMO_INTAKE_FIXTURES: DemoIntakeFixtures = {
  company: {
    name: "Acme Bank",
    description:
      "A fictional mid-size retail and commercial bank operating in the EU and North America.",
  },

  // -------------------------------------------------------------------------
  // HERO — the live-demo use case. NOT pre-seeded; its intake is typed live in
  // the wizard. Kept here so the e2e spec and seed guard share the same data.
  // essential-services + profilesNaturalPersons → EU AI Act HIGH (ruleset v1).
  // -------------------------------------------------------------------------
  hero: {
    key: "hero-credit-limit",
    name: "Credit-limit-increase assistant",
    description:
      "A conversational AI agent that evaluates customer requests for credit-limit increases, " +
      "drafts a recommendation letter, and routes decisions to a human loan officer.",
    businessContext:
      "Retail banking — replacing a partly-manual call-centre workflow to cut turnaround from 3 days to same-day.",
    dataSensitivity: "regulated",
    complianceTags: ["gdpr", "ccpa", "eu-ai-act"],
    targetStatus: "proposed",
    intendedAgentNames: ["balanced-mock"],
    intake: {
      title: "Credit-limit-increase assistant",
      description:
        "A conversational AI agent that evaluates customer requests for credit-limit increases, " +
        "drafts a recommendation letter, and routes decisions to a human loan officer.",
      euAiAct: {
        purposeDomain: "essential-services",
        affectedPersons: ["customers"],
        decisionAutonomy: "human-reviews",
        biometricUse: "none",
        emotionRecognition: false,
        socialScoring: false,
        manipulativeTechniques: false,
        profilesNaturalPersons: true,
        safetyComponent: false,
        interactsWithHumans: true,
        generatesSyntheticContent: true,
      },
      context: {
        sectors: ["financial-services"],
        dataCategories: ["personal", "financial"],
        deployment: "customer-facing",
        euNexus: true,
        usesExternalVendor: true,
        generative: true,
        autonomousActions: true,
        toolsUsed: ["crm.read", "loan-engine.score"],
      },
      draftNarrative: false,
    },
  },

  // -------------------------------------------------------------------------
  // VENDORS — 5 total, mixed statuses
  // Note: vendor-mock has linkedAgentProviders: ["mock"] — the hero agent
  // (balanced-mock, provider="mock") resolves to this vendor, giving the
  // dependency graph a vendor-scoped risk path for the G5 beat.
  // -------------------------------------------------------------------------
  vendors: [
    {
      key: "vendor-anthropic",
      name: "Anthropic",
      description:
        "Provider of the Claude family of large language models, focused on AI safety research.",
      category: "model_provider",
      linkedAgentProviders: ["anthropic"],
      targetStatus: "approved",
    },
    {
      key: "vendor-openai",
      name: "OpenAI",
      description:
        "Provider of GPT-series models and the OpenAI API platform.",
      category: "model_provider",
      linkedAgentProviders: ["openai"],
      targetStatus: "approved",
    },
    {
      key: "vendor-google",
      name: "Google Cloud AI",
      description:
        "Provider of Gemini models via Google Cloud Vertex AI.",
      category: "model_provider",
      linkedAgentProviders: ["google"],
      targetStatus: "under_assessment",
    },
    {
      key: "vendor-xai",
      name: "xAI",
      description:
        "Provider of Grok models, a frontier reasoning LLM.",
      category: "model_provider",
      linkedAgentProviders: ["xai"],
      targetStatus: "proposed",
    },
    {
      // vendor-mock is the vendor that supplies the hero agent (provider="mock")
      // G5: a high × high vendor-scoped risk is attached to this vendor so the
      // dependency graph shows the hero use case inheriting a HIGH rating.
      key: "vendor-mock",
      name: "Acme Internal AI Platform",
      description:
        "Acme Bank's internal model-serving layer, hosting mock and fine-tuned models for demos.",
      category: "model_provider",
      linkedAgentProviders: ["mock"],
      targetStatus: "approved",
    },
  ],

  // -------------------------------------------------------------------------
  // USE CASES — 10 entries (not counting the hero).
  // targetStatus spread: 2 proposed, 2 under_review, 4 approved, 1 rejected, 1 retired.
  // EU AI Act tier (COMPUTED from intake answers):
  //   ≥2 high:      uc-1 (employment-hr), uc-6 (essential-services + profiles)
  //   1 prohibited: uc-3 (socialScoring=true)
  //   ≥3 limited:   uc-2, uc-7, uc-9 (interactsWithHumans/generates)
  //   rest minimal: uc-4, uc-5, uc-8, uc-10
  // -------------------------------------------------------------------------
  useCases: [
    {
      key: "uc-1",
      name: "HR Resume Screening Assistant",
      description:
        "AI agent that parses and ranks job-applicant resumes against role requirements, " +
        "surfacing a shortlist for human recruiters.",
      businessContext:
        "HR — reduces screening time by 60% for high-volume technical roles.",
      dataSensitivity: "confidential",
      complianceTags: ["gdpr"],
      targetStatus: "under_review",
      intendedAgentNames: ["gpt-5"],
      intake: {
        title: "HR Resume Screening Assistant",
        description:
          "AI agent that ranks resumes and surfaces a shortlist for human recruiters.",
        euAiAct: {
          purposeDomain: "employment-hr",
          affectedPersons: ["general-public"],
          decisionAutonomy: "informs-human",
          biometricUse: "none",
          emotionRecognition: false,
          socialScoring: false,
          manipulativeTechniques: false,
          profilesNaturalPersons: true,
          safetyComponent: false,
          interactsWithHumans: false,
          generatesSyntheticContent: false,
        },
        context: {
          sectors: ["general"],
          dataCategories: ["personal"],
          deployment: "internal",
          euNexus: true,
          usesExternalVendor: true,
          generative: false,
          autonomousActions: false,
          toolsUsed: [],
        },
        draftNarrative: false,
      },
    },
    {
      key: "uc-2",
      name: "Customer Sentiment Analyzer",
      description:
        "Analyses support-ticket text to classify customer sentiment and escalate negative " +
        "cases automatically to a senior agent queue.",
      businessContext:
        "Customer Service — improves SLA compliance by routing escalations 40% faster.",
      dataSensitivity: "confidential",
      complianceTags: [],
      targetStatus: "approved",
      intendedAgentNames: ["claude-opus"],
      intake: {
        title: "Customer Sentiment Analyzer",
        description:
          "Classifies customer sentiment in support tickets and routes escalations.",
        euAiAct: {
          purposeDomain: "general-business",
          affectedPersons: ["customers"],
          decisionAutonomy: "human-reviews",
          biometricUse: "none",
          emotionRecognition: true,
          socialScoring: false,
          manipulativeTechniques: false,
          profilesNaturalPersons: false,
          safetyComponent: false,
          interactsWithHumans: false,
          generatesSyntheticContent: false,
        },
        context: {
          sectors: ["financial-services"],
          dataCategories: ["personal"],
          deployment: "internal",
          euNexus: true,
          usesExternalVendor: true,
          generative: true,
          autonomousActions: false,
          toolsUsed: [],
        },
        draftNarrative: false,
      },
    },
    {
      key: "uc-3",
      name: "Social Behaviour Credit Scorer",
      description:
        "Proposed system to score retail customers on social-media behaviour and on-time payment " +
        "history to adjust credit limits dynamically.",
      businessContext:
        "Risk — rejected at inception; documented as a prohibited-tier reference case.",
      dataSensitivity: "regulated",
      complianceTags: [],
      targetStatus: "rejected",
      decisionReason:
        "Prohibited under EU AI Act Art. 5(1)(c) — AI system for social scoring of natural persons " +
        "leading to detrimental treatment.",
      intendedAgentNames: ["gemini-pro"],
      intake: {
        title: "Social Behaviour Credit Scorer",
        description:
          "AI that scores customer creditworthiness using social-media behaviour signals.",
        euAiAct: {
          purposeDomain: "general-business",
          affectedPersons: ["customers"],
          decisionAutonomy: "fully-automated",
          biometricUse: "none",
          emotionRecognition: false,
          socialScoring: true,
          manipulativeTechniques: false,
          profilesNaturalPersons: true,
          safetyComponent: false,
          interactsWithHumans: false,
          generatesSyntheticContent: false,
        },
        context: {
          sectors: ["financial-services"],
          dataCategories: ["personal", "financial"],
          deployment: "customer-facing",
          euNexus: true,
          usesExternalVendor: true,
          generative: false,
          autonomousActions: true,
          toolsUsed: [],
        },
        draftNarrative: false,
      },
    },
    {
      key: "uc-4",
      name: "Internal IT Knowledge Base Bot",
      description:
        "A Q&A bot grounded on internal Confluence and Jira pages that answers employee IT " +
        "questions without human-agent involvement for routine queries.",
      businessContext:
        "IT Support — deflects ~30% of tier-1 helpdesk tickets.",
      dataSensitivity: "internal",
      complianceTags: [],
      targetStatus: "approved",
      intendedAgentNames: ["balanced-mock"],
      intake: {
        title: "Internal IT Knowledge Base Bot",
        description:
          "Q&A bot that answers routine IT questions using internal documentation.",
        euAiAct: {
          purposeDomain: "internal-productivity",
          affectedPersons: ["employees"],
          decisionAutonomy: "human-reviews",
          biometricUse: "none",
          emotionRecognition: false,
          socialScoring: false,
          manipulativeTechniques: false,
          profilesNaturalPersons: false,
          safetyComponent: false,
          interactsWithHumans: true,
          generatesSyntheticContent: true,
        },
        context: {
          sectors: ["general"],
          dataCategories: ["proprietary"],
          deployment: "internal",
          euNexus: true,
          usesExternalVendor: false,
          generative: true,
          autonomousActions: false,
          toolsUsed: [],
        },
        draftNarrative: false,
      },
    },
    {
      key: "uc-5",
      name: "Marketing Campaign Copy Generator",
      description:
        "Generates first-draft marketing copy for email campaigns and social-media posts " +
        "from a product brief. Replaced by a newer multi-modal system.",
      businessContext: "Marketing — retired after six months when a successor was approved.",
      dataSensitivity: "public",
      complianceTags: [],
      targetStatus: "retired",
      decisionReason:
        "Superseded by the Multi-Modal Brand Assistant (uc-10); system decommissioned.",
      intendedAgentNames: ["fast-mock"],
      intake: {
        title: "Marketing Campaign Copy Generator",
        description:
          "Generates first-draft copy for marketing campaigns from a product brief.",
        euAiAct: {
          purposeDomain: "general-business",
          affectedPersons: [],
          decisionAutonomy: "human-reviews",
          biometricUse: "none",
          emotionRecognition: false,
          socialScoring: false,
          manipulativeTechniques: false,
          profilesNaturalPersons: false,
          safetyComponent: false,
          interactsWithHumans: false,
          generatesSyntheticContent: true,
        },
        context: {
          sectors: ["general"],
          dataCategories: ["proprietary"],
          deployment: "internal",
          euNexus: false,
          usesExternalVendor: false,
          generative: true,
          autonomousActions: false,
          toolsUsed: [],
        },
        draftNarrative: false,
      },
    },
    {
      key: "uc-6",
      name: "Real-Time Fraud Detection Engine",
      description:
        "Agent that scores card-transaction patterns in real time and autonomously blocks " +
        "suspected fraud, profiling customer spending habits as features.",
      businessContext:
        "Payments Risk — reduces fraud loss by an estimated 18% versus the legacy rules engine.",
      dataSensitivity: "regulated",
      complianceTags: ["pci"],
      targetStatus: "approved",
      intendedAgentNames: ["premium-mock"],
      intake: {
        title: "Real-Time Fraud Detection Engine",
        description:
          "Scores card-transaction patterns and autonomously blocks suspected fraud.",
        euAiAct: {
          purposeDomain: "essential-services",
          affectedPersons: ["customers"],
          decisionAutonomy: "narrow-procedural",
          biometricUse: "none",
          emotionRecognition: false,
          socialScoring: false,
          manipulativeTechniques: false,
          profilesNaturalPersons: true,
          safetyComponent: false,
          interactsWithHumans: false,
          generatesSyntheticContent: false,
        },
        context: {
          sectors: ["financial-services", "payments"],
          dataCategories: ["personal", "financial", "payment-card"],
          deployment: "internal",
          euNexus: true,
          usesExternalVendor: false,
          generative: false,
          autonomousActions: true,
          toolsUsed: ["fraud-rules.evaluate", "card-block.write"],
        },
        draftNarrative: false,
      },
    },
    {
      key: "uc-7",
      name: "Developer Code Copilot",
      description:
        "An AI pair-programming assistant integrated into VS Code that suggests code " +
        "completions, explains errors, and writes test stubs.",
      businessContext:
        "Engineering — proposed to accelerate feature delivery by reducing boilerplate coding time.",
      dataSensitivity: "internal",
      complianceTags: [],
      targetStatus: "proposed",
      intendedAgentNames: ["gpt-5"],
      intake: {
        title: "Developer Code Copilot",
        description:
          "AI pair-programming assistant suggesting code completions and test stubs in VS Code.",
        euAiAct: {
          purposeDomain: "internal-productivity",
          affectedPersons: ["employees"],
          decisionAutonomy: "human-reviews",
          biometricUse: "none",
          emotionRecognition: false,
          socialScoring: false,
          manipulativeTechniques: false,
          profilesNaturalPersons: false,
          safetyComponent: false,
          interactsWithHumans: true,
          generatesSyntheticContent: true,
        },
        context: {
          sectors: ["general"],
          dataCategories: ["proprietary"],
          deployment: "internal",
          euNexus: true,
          usesExternalVendor: true,
          generative: true,
          autonomousActions: false,
          toolsUsed: [],
        },
        draftNarrative: false,
      },
    },
    {
      key: "uc-8",
      name: "Legal Contract Clause Analyzer",
      description:
        "Extracts, classifies, and red-flags non-standard clauses in third-party vendor " +
        "contracts submitted for legal review.",
      businessContext:
        "Legal — reduces average contract review time from 4 hours to under 45 minutes.",
      dataSensitivity: "confidential",
      complianceTags: [],
      targetStatus: "under_review",
      intendedAgentNames: ["claude-opus"],
      intake: {
        title: "Legal Contract Clause Analyzer",
        description:
          "Extracts and flags non-standard clauses in vendor contracts for legal review.",
        euAiAct: {
          purposeDomain: "general-business",
          affectedPersons: ["employees"],
          decisionAutonomy: "human-reviews",
          biometricUse: "none",
          emotionRecognition: false,
          socialScoring: false,
          manipulativeTechniques: false,
          profilesNaturalPersons: false,
          safetyComponent: false,
          interactsWithHumans: false,
          generatesSyntheticContent: false,
        },
        context: {
          sectors: ["general"],
          dataCategories: ["proprietary"],
          deployment: "internal",
          euNexus: true,
          usesExternalVendor: true,
          generative: true,
          autonomousActions: false,
          toolsUsed: [],
        },
        draftNarrative: false,
      },
    },
    {
      key: "uc-9",
      name: "Call-Centre Voice IVR Assistant",
      description:
        "A voice-based interactive assistant that handles routine balance inquiries, " +
        "dispute initiations, and PIN resets, escalating complex calls to live agents.",
      businessContext:
        "Contact Centre — proposed to reduce average handle time and after-hours staffing cost.",
      dataSensitivity: "confidential",
      complianceTags: [],
      targetStatus: "proposed",
      intendedAgentNames: ["gemini-pro"],
      intake: {
        title: "Call-Centre Voice IVR Assistant",
        description:
          "Voice assistant handling balance inquiries, disputes, and PIN resets by phone.",
        euAiAct: {
          purposeDomain: "general-business",
          affectedPersons: ["customers"],
          decisionAutonomy: "human-reviews",
          biometricUse: "none",
          emotionRecognition: false,
          socialScoring: false,
          manipulativeTechniques: false,
          profilesNaturalPersons: false,
          safetyComponent: false,
          interactsWithHumans: true,
          generatesSyntheticContent: true,
        },
        context: {
          sectors: ["general"],
          dataCategories: ["personal"],
          deployment: "customer-facing",
          euNexus: true,
          usesExternalVendor: true,
          generative: true,
          autonomousActions: false,
          toolsUsed: [],
        },
        draftNarrative: false,
      },
    },
    {
      key: "uc-10",
      name: "Financial Forecasting Assistant",
      description:
        "Generates quarterly revenue and expense forecasts by querying the data warehouse " +
        "and producing narrative summaries for the Finance leadership team.",
      businessContext:
        "Finance — reduces the time to produce the quarterly board pack from 2 weeks to 3 days.",
      dataSensitivity: "confidential",
      complianceTags: [],
      targetStatus: "approved",
      intendedAgentNames: ["grok"],
      intake: {
        title: "Financial Forecasting Assistant",
        description:
          "Generates quarterly revenue forecasts from the data warehouse with narrative summaries.",
        euAiAct: {
          purposeDomain: "general-business",
          affectedPersons: [],
          decisionAutonomy: "human-reviews",
          biometricUse: "none",
          emotionRecognition: false,
          socialScoring: false,
          manipulativeTechniques: false,
          profilesNaturalPersons: false,
          safetyComponent: false,
          interactsWithHumans: false,
          generatesSyntheticContent: false,
        },
        context: {
          sectors: ["financial-services"],
          dataCategories: ["financial"],
          deployment: "internal",
          euNexus: true,
          usesExternalVendor: true,
          generative: true,
          autonomousActions: false,
          toolsUsed: [],
        },
        draftNarrative: false,
      },
    },
  ],

  // -------------------------------------------------------------------------
  // RISKS — 30 entries across all 11 categories.
  // Spread: ~60% mitigating (with residual + controls), 2 accepted, 4 closed,
  // rest open.
  // risk-31 is VENDOR-ONLY (vendorKey only, no useCaseKey) at high × high so
  // the dependency graph shows the hero use case inheriting a HIGH rating from
  // vendor-mock (the hero's agent provider).  G5 beat.
  // -------------------------------------------------------------------------
  risks: [
    // ---- bias_fairness (3) ----
    {
      key: "risk-1",
      useCaseKey: "hero-credit-limit",
      title: "Credit model produces disparate approval rates across demographic groups",
      description:
        "The credit-limit model may learn proxy variables for protected characteristics " +
        "from historical lending data, systematically under-approving qualified applicants " +
        "from certain groups and exposing the bank to fair-lending regulatory action.",
      category: "bias_fairness",
      likelihood: "high",
      impact: "high",
      targetStatus: "mitigating",
      mitigation:
        "Fairness assessment documented in the model card; adverse-action reason codes provided per ECOA.",
      controls: [
        "eu-ai-act:art-10-bias-examination",
        "eu-ai-act:art-9-risk-management-system",
        "nist-ai-rmf:MEASURE-2.11",
      ],
      residual: { likelihood: "low", impact: "high" },
    },
    {
      key: "risk-2",
      useCaseKey: "uc-1",
      title: "Resume screener down-ranks candidates from certain geographic ZIP codes",
      description:
        "Historical hiring patterns may have encoded ZIP-code as a proxy for socioeconomic " +
        "status; the screener perpetuates this bias, producing a discriminatory candidate " +
        "shortlist and creating EEOC exposure.",
      category: "bias_fairness",
      likelihood: "medium",
      impact: "high",
      targetStatus: "mitigating",
      mitigation:
        "Demographic-parity testing added to model evaluation gate; human-review step mandatory before rejection.",
      controls: [
        "eu-ai-act:art-10-bias-examination",
        "eu-ai-act:art-14-human-oversight",
        "nist-ai-rmf:MEASURE-2.11",
      ],
      residual: { likelihood: "low", impact: "medium" },
    },
    {
      key: "risk-3",
      useCaseKey: "uc-6",
      title: "Fraud model falsely blocks transactions from high-risk demographic segments",
      description:
        "The fraud-detection model may have learned to over-flag transaction patterns " +
        "correlated with certain demographic segments, causing disproportionate payment " +
        "declines and triggering fair-credit complaints.",
      category: "bias_fairness",
      likelihood: "medium",
      impact: "high",
      targetStatus: "open",
      controls: [
        "eu-ai-act:art-10-bias-examination",
        "eu-ai-act:art-9-risk-management-system",
      ],
    },

    // ---- tool_misuse (3) ----
    {
      key: "risk-4",
      useCaseKey: "uc-4",
      title: "IT bot invokes a write tool and deletes helpdesk records",
      description:
        "The IT bot holds a write-capable connector grant as a convenience; a misformed " +
        "query could issue a DELETE on a helpdesk table, destroying ticket history and " +
        "breaching audit-retention requirements.",
      category: "tool_misuse",
      likelihood: "low",
      impact: "high",
      targetStatus: "mitigating",
      mitigation:
        "Connector grant narrowed to read-only; write operations require explicit user confirmation and a separate approval step.",
      controls: [
        "eu-ai-act:art-14-human-oversight",
        "nist-ai-rmf:GOVERN-1.2",
        "iso-27001:A.5.15",
      ],
      residual: { likelihood: "low", impact: "low" },
    },
    {
      key: "risk-5",
      useCaseKey: "uc-6",
      title: "Fraud agent blocks legitimate transactions via autonomous card-block tool",
      description:
        "The fraud agent has write access to the card-block API; an over-aggressive " +
        "model decision could mass-block legitimate cards, causing customer service " +
        "outages and reputational damage.",
      category: "tool_misuse",
      likelihood: "medium",
      impact: "high",
      targetStatus: "mitigating",
      mitigation:
        "Rate-limit on card-block API enforced at gateway; human override required for blocks exceeding 50/hour.",
      controls: [
        "eu-ai-act:art-14-human-oversight",
        "eu-ai-act:art-15-accuracy-robustness",
        "nist-ai-rmf:MANAGE-2.2",
      ],
      residual: { likelihood: "low", impact: "medium" },
    },
    {
      key: "risk-6",
      useCaseKey: "uc-8",
      title: "Legal analyzer writes to contract management system without authorisation",
      description:
        "The legal bot was provisioned with a contract-management write token for " +
        "annotation purposes; adversarial input could redirect it to create or delete " +
        "contract records, producing an invalid executed document.",
      category: "tool_misuse",
      likelihood: "low",
      impact: "medium",
      targetStatus: "accepted",
      controls: ["eu-ai-act:art-14-human-oversight", "nist-ai-rmf:GOVERN-1.2"],
      acceptanceNote:
        "Residual risk accepted after legal sign-off: the write token is scoped to a sandbox " +
        "environment only; production contracts remain read-only for the agent.",
    },

    // ---- prompt_injection (3) ----
    {
      key: "risk-7",
      useCaseKey: "hero-credit-limit",
      title: "Injected instruction in customer message overrides credit-decision prompt",
      description:
        "A customer can embed adversarial text in their free-text application narrative " +
        "to override the credit-decision system prompt, potentially granting a higher " +
        "credit limit than the bank's policy would approve.",
      category: "prompt_injection",
      likelihood: "high",
      impact: "high",
      targetStatus: "mitigating",
      mitigation:
        "Prompt-injection guardrail set to block mode; system-prompt is isolated from user input via structured roles.",
      controls: [
        "eu-ai-act:art-15-accuracy-robustness",
        "nist-ai-rmf:MEASURE-2.7",
        "eu-ai-act:art-9-risk-management-system",
      ],
      residual: { likelihood: "low", impact: "medium" },
    },
    {
      key: "risk-8",
      useCaseKey: "uc-7",
      title: "Indirect injection in a code repository comment rewrites generated code",
      description:
        "The code copilot fetches context from public and internal repositories; " +
        "a malicious comment or README can contain instructions that modify the " +
        "generated code to introduce backdoors or exfiltrate secrets.",
      category: "prompt_injection",
      likelihood: "medium",
      impact: "high",
      targetStatus: "mitigating",
      mitigation:
        "Fetched context is sandboxed with a secondary extraction filter; generated code requires human review before commit.",
      controls: [
        "nist-ai-rmf:MEASURE-2.7",
        "eu-ai-act:art-15-accuracy-robustness",
      ],
      residual: { likelihood: "medium", impact: "medium" },
    },
    {
      key: "risk-9",
      useCaseKey: "uc-9",
      title: "Voice channel injection mimics IVR instructions to escalate permissions",
      description:
        "An attacker could use an audio-based injection phrase that the ASR transcribes " +
        "as a system command, tricking the IVR assistant into granting the caller " +
        "privileged actions such as an account limit override.",
      category: "prompt_injection",
      likelihood: "low",
      impact: "high",
      targetStatus: "open",
      controls: [
        "eu-ai-act:art-15-accuracy-robustness",
        "eu-ai-act:art-14-human-oversight",
      ],
    },

    // ---- data_leakage_pii (3) ----
    {
      key: "risk-10",
      useCaseKey: "hero-credit-limit",
      title: "Customer PII included in prompt reaches third-party model provider",
      description:
        "The agent constructs prompts containing customer name, income, and credit " +
        "history; these reach the external model-provider API without scrubbing, " +
        "creating a GDPR data-processor agreement breach.",
      category: "data_leakage_pii",
      likelihood: "medium",
      impact: "high",
      targetStatus: "mitigating",
      mitigation:
        "PII-block cascade active on the financial-services compliance profile; DPA with provider signed.",
      controls: [
        "iso-27001:A.8.12",
        "eu-ai-act:art-12-record-keeping",
        "nist-ai-rmf:MEASURE-2.7",
      ],
      residual: { likelihood: "low", impact: "medium" },
    },
    {
      key: "risk-11",
      useCaseKey: "uc-2",
      title: "Support-ticket text contains PHI that is logged in plain text",
      description:
        "Customer support tickets sometimes include incidentally disclosed medical " +
        "information; the sentiment analyser logs the full ticket text in a telemetry " +
        "pipeline without redaction, exposing PHI to infrastructure engineers.",
      category: "data_leakage_pii",
      likelihood: "medium",
      impact: "high",
      targetStatus: "mitigating",
      mitigation:
        "Regex-based PII scrubber applied to logs before ingestion; sensitive fields replaced with typed placeholders.",
      controls: [
        "iso-27001:A.8.12",
        "iso-27001:A.8.15",
        "eu-ai-act:art-12-record-keeping",
      ],
      residual: { likelihood: "low", impact: "low" },
    },
    {
      key: "risk-12",
      useCaseKey: "uc-7",
      title: "Source code with hardcoded secrets forwarded to external model API",
      description:
        "Developers paste full file contents into the copilot context; files may contain " +
        "API keys or database passwords that are forwarded verbatim to the external model " +
        "provider, leaking credentials.",
      category: "data_leakage_pii",
      likelihood: "medium",
      impact: "high",
      targetStatus: "closed",
      controls: [
        "iso-27001:A.8.12",
        "nist-ai-rmf:GOVERN-4.1",
      ],
      closeReason:
        "Mitigated via secret-scanning pre-filter deployed in the IDE plugin v2.1; issue closed after 30-day clean period.",
    },

    // ---- over_permissioning (3) ----
    {
      key: "risk-13",
      useCaseKey: "uc-4",
      title: "IT bot holds standing admin grants never scoped down after pilot",
      description:
        "During the pilot phase, the IT bot was granted admin-level directory permissions " +
        "for testing; these were never narrowed to production scope, leaving the agent " +
        "capable of modifying user accounts organisation-wide.",
      category: "over_permissioning",
      likelihood: "medium",
      impact: "high",
      targetStatus: "closed",
      controls: [
        "iso-27001:A.5.15",
        "nist-ai-rmf:GOVERN-1.2",
      ],
      closeReason:
        "Admin grants revoked; new least-privilege grant set documented and verified in the grant audit trail.",
    },
    {
      key: "risk-14",
      useCaseKey: "uc-6",
      title: "Fraud agent granted access to all transaction schemas including HR payroll",
      description:
        "The data-warehouse connector bound to the fraud agent uses a broad service " +
        "account with read access to all schemas including payroll; a compromise would " +
        "expose salary data far beyond the fraud detection scope.",
      category: "over_permissioning",
      likelihood: "medium",
      impact: "high",
      targetStatus: "mitigating",
      mitigation:
        "Schema-scoped read grant issued; access bounded to the payments schema only via row-level security.",
      controls: [
        "iso-27001:A.5.15",
        "nist-ai-rmf:GOVERN-1.2",
        "pci-dss:7.2.1-least-privilege",
      ],
      residual: { likelihood: "low", impact: "medium" },
    },
    {
      key: "risk-15",
      useCaseKey: "uc-8",
      title: "Legal bot connector token spans all document-management folders",
      description:
        "The connector used by the legal contract analyser has read access to all " +
        "document-management folders including M&A deal rooms; legal privilege could " +
        "be inadvertently waived by exposing those documents to the model provider.",
      category: "over_permissioning",
      likelihood: "low",
      impact: "high",
      targetStatus: "open",
      controls: [
        "iso-27001:A.5.15",
        "iso-27001:A.8.12",
      ],
    },

    // ---- budget_overrun (3) ----
    {
      key: "risk-16",
      useCaseKey: "uc-10",
      title: "Forecasting agent enters an infinite retry loop exhausting monthly token budget",
      description:
        "If the data-warehouse query returns malformed data, the forecasting agent " +
        "retries the summarisation step indefinitely; this could exhaust the project's " +
        "monthly token budget in hours and trigger an unplanned cost spike.",
      category: "budget_overrun",
      likelihood: "low",
      impact: "medium",
      targetStatus: "mitigating",
      mitigation:
        "Orchestration run-cap set at 50 LLM calls per invocation; exponential back-off with a hard abort at 3 retries.",
      controls: [
        "nist-ai-rmf:MANAGE-2.2",
        "eu-ai-act:art-14-human-oversight",
      ],
      residual: { likelihood: "low", impact: "low" },
    },
    {
      key: "risk-17",
      useCaseKey: "uc-9",
      title: "Voice IVR agent invokes expensive model tier for low-value balance queries",
      description:
        "The IVR agent defaults to the premium-tier model for every call, including " +
        "simple balance inquiries that could be served by the fast-tier model; " +
        "per-call cost is 15× the minimum required, eroding the business case.",
      category: "budget_overrun",
      likelihood: "medium",
      impact: "low",
      targetStatus: "accepted",
      controls: [
        "nist-ai-rmf:MANAGE-2.2",
      ],
      acceptanceNote:
        "Cost optimisation deferred to v2; current volume is below the approved annual budget threshold. " +
        "Reviewed and accepted by Head of AI Platform.",
    },
    {
      key: "risk-18",
      useCaseKey: "uc-7",
      title: "Code copilot API endpoint lacks rate limiting enabling cost amplification",
      description:
        "The copilot VS Code extension does not enforce client-side rate limiting; " +
        "an automated testing script could hammer the endpoint, generating thousands of " +
        "completion requests per minute and exhausting the project's monthly budget.",
      category: "budget_overrun",
      likelihood: "medium",
      impact: "medium",
      targetStatus: "open",
      controls: [
        "nist-ai-rmf:MANAGE-2.2",
        "eu-ai-act:art-12-record-keeping",
      ],
    },

    // ---- hallucination (3) ----
    {
      key: "risk-19",
      useCaseKey: "uc-10",
      title: "Forecasting assistant invents historical revenue figures not in source data",
      description:
        "The model generates narrative commentary referencing revenue figures that " +
        "do not appear in the warehouse query results; finance leadership presents " +
        "these to the board, creating material misstatement risk.",
      category: "hallucination",
      likelihood: "high",
      impact: "high",
      targetStatus: "mitigating",
      mitigation:
        "Groundedness evaluation (claim-support check against warehouse output) run on every forecast; " +
        "human finance controller sign-off required before board distribution.",
      controls: [
        "eu-ai-act:art-15-accuracy-robustness",
        "eu-ai-act:art-12-record-keeping",
        "nist-ai-rmf:MEASURE-2.7",
      ],
      residual: { likelihood: "low", impact: "medium" },
    },
    {
      key: "risk-20",
      useCaseKey: "uc-8",
      title: "Legal analyzer cites non-existent case law in contract risk summary",
      description:
        "The model generates a risk summary referencing precedents it has not retrieved, " +
        "leading the legal team to rely on fictitious citations in a negotiation, " +
        "potentially constituting professional-standards negligence.",
      category: "hallucination",
      likelihood: "medium",
      impact: "high",
      targetStatus: "mitigating",
      mitigation:
        "Retrieval-augmented generation (RAG) from a verified legal database only; " +
        "every citation is footnoted with the source chunk ID for human verification.",
      controls: [
        "eu-ai-act:art-15-accuracy-robustness",
        "eu-ai-act:art-14-human-oversight",
      ],
      residual: { likelihood: "low", impact: "medium" },
    },
    {
      key: "risk-21",
      useCaseKey: "uc-4",
      title: "IT bot answers confidently about system capabilities that no longer exist",
      description:
        "The knowledge base index is refreshed weekly; the bot may answer questions " +
        "about decommissioned systems with high confidence, misdirecting engineers " +
        "and causing hours of wasted troubleshooting.",
      category: "hallucination",
      likelihood: "medium",
      impact: "low",
      targetStatus: "mitigating",
      mitigation:
        "Knowledge base refreshed daily; metadata freshness displayed inline in bot responses.",
      controls: [
        "eu-ai-act:art-15-accuracy-robustness",
        "nist-ai-rmf:MEASURE-2.6",
      ],
      residual: { likelihood: "low", impact: "low" },
    },

    // ---- shadow_ai (3) ----
    {
      key: "risk-22",
      useCaseKey: "uc-5",
      title: "Marketing team uses personal Claude.ai accounts to draft campaign content",
      description:
        "Campaign briefs containing unreleased product features and strategic positioning " +
        "are uploaded to personal Claude.ai accounts by marketers, bypassing the " +
        "governed gateway and exposing confidential roadmap data to Anthropic's API.",
      category: "shadow_ai",
      likelihood: "high",
      impact: "high",
      targetStatus: "closed",
      controls: [
        "eu-ai-act:art-9-risk-management-system",
        "nist-ai-rmf:GOVERN-4.1",
      ],
      closeReason:
        "Acceptable-use policy updated; DLP rule blocks upload of marketing-classified documents to external AI services.",
    },
    {
      key: "risk-23",
      useCaseKey: "uc-2",
      title: "Support agents use unauthorized Grammarly AI to rephrase customer replies",
      description:
        "Support agents pass full customer-conversation transcripts through Grammarly's " +
        "AI rewriting feature without realising the free tier trains on user input, " +
        "exposing customer PII to a third party with no DPA.",
      category: "shadow_ai",
      likelihood: "medium",
      impact: "high",
      targetStatus: "mitigating",
      mitigation:
        "Grammarly Enterprise deployed with privacy mode enabled under a signed DPA; " +
        "free-tier browser extensions blocked at proxy.",
      controls: [
        "eu-ai-act:art-9-risk-management-system",
        "nist-ai-rmf:GOVERN-4.1",
        "iso-27001:A.8.12",
      ],
      residual: { likelihood: "low", impact: "medium" },
    },
    {
      key: "risk-24",
      useCaseKey: "uc-1",
      title: "HR team uses free AI summariser to condense interview notes containing PII",
      description:
        "Recruiters upload interview notes including candidate names, addresses, and " +
        "salary expectations to a free online AI summariser, creating a GDPR data " +
        "processing violation with no consent or DPA.",
      category: "shadow_ai",
      likelihood: "medium",
      impact: "high",
      targetStatus: "open",
      controls: [
        "nist-ai-rmf:GOVERN-4.1",
        "eu-ai-act:art-9-risk-management-system",
      ],
    },

    // ---- third_party_ai (3) ----
    {
      key: "risk-25",
      useCaseKey: "uc-6",
      title: "Fraud vendor silently adds an AI scoring step without disclosure",
      description:
        "The third-party fraud data feed provider updated their API to include an " +
        "AI-generated risk signal without notifying Acme; this undisclosed AI component " +
        "feeds the bank's fraud model without a vendor AI assessment in the registry.",
      category: "third_party_ai",
      likelihood: "medium",
      impact: "high",
      targetStatus: "mitigating",
      mitigation:
        "Vendor AI use disclosed in annual questionnaire; contract addendum added requiring 30-day notice of AI capability changes.",
      controls: [
        "nist-ai-rmf:MAP-4.1",
        "eu-ai-act:art-9-risk-management-system",
        "soc-2:CC9.2-vendor-risk",
      ],
      residual: { likelihood: "low", impact: "medium" },
    },
    {
      key: "risk-26",
      useCaseKey: "uc-9",
      title: "IVR platform vendor processes voice transcripts through unassessed AI",
      description:
        "The telephony platform used for the IVR agent applies an AI sentiment layer " +
        "to all call transcripts for quality scoring without an approved vendor assessment; " +
        "this creates a hidden AI touchpoint on regulated customer conversations.",
      category: "third_party_ai",
      likelihood: "medium",
      impact: "medium",
      targetStatus: "open",
      controls: [
        "nist-ai-rmf:MAP-4.1",
        "eu-ai-act:art-9-risk-management-system",
      ],
    },
    {
      key: "risk-27",
      useCaseKey: "uc-10",
      title: "BI tool vendor adds AI-assisted report generation without approval",
      description:
        "The business-intelligence platform vendor enabled a generative AI " +
        "report-narrative feature by default; financial data flows through this " +
        "feature with no recorded assessment of the provider's subprocessors.",
      category: "third_party_ai",
      likelihood: "low",
      impact: "medium",
      targetStatus: "mitigating",
      mitigation:
        "AI feature disabled pending vendor assessment; DPA addendum requested from vendor.",
      controls: [
        "nist-ai-rmf:MAP-4.1",
        "soc-2:CC9.2-vendor-risk",
      ],
      residual: { likelihood: "low", impact: "low" },
    },

    // ---- unsafe_output (3) ----
    {
      key: "risk-28",
      useCaseKey: "hero-credit-limit",
      title: "Credit assistant generates manipulative sales language to maximise limit",
      description:
        "Without output guardrails, the model might craft persuasive language " +
        "urging customers to accept the highest available credit limit, employing " +
        "dark-pattern framing that constitutes manipulative technique under Art. 5.",
      category: "unsafe_output",
      likelihood: "medium",
      impact: "high",
      targetStatus: "mitigating",
      mitigation:
        "Output reviewed against the anti-manipulation rule in the guardrail config; " +
        "jailbreak and toxicity detectors both set to block mode.",
      controls: [
        "eu-ai-act:art-15-accuracy-robustness",
        "eu-ai-act:art-14-human-oversight",
        "nist-ai-rmf:MANAGE-2.2",
      ],
      residual: { likelihood: "low", impact: "medium" },
    },
    {
      key: "risk-29",
      useCaseKey: "uc-9",
      title: "IVR assistant provides financial advice exceeding its authorised scope",
      description:
        "A customer in financial distress could elicit investment or debt-relief " +
        "advice from the IVR bot; the model, lacking domain guardrails, might provide " +
        "FCA-regulated guidance without the required licensing disclosures.",
      category: "unsafe_output",
      likelihood: "medium",
      impact: "high",
      targetStatus: "open",
      controls: [
        "eu-ai-act:art-15-accuracy-robustness",
        "eu-ai-act:art-14-human-oversight",
      ],
    },
    {
      key: "risk-30",
      useCaseKey: "uc-7",
      title: "Code copilot generates vulnerable cryptographic implementation",
      description:
        "The copilot suggests deprecated cryptographic primitives (e.g., MD5 for " +
        "password hashing) or introduces reentrancy flaws in Solidity contracts; " +
        "deploying this code exposes production systems to immediate exploitation.",
      category: "unsafe_output",
      likelihood: "medium",
      impact: "high",
      targetStatus: "closed",
      controls: [
        "nist-ai-rmf:MEASURE-2.7",
        "eu-ai-act:art-15-accuracy-robustness",
      ],
      closeReason:
        "Static analysis (Semgrep) integrated into the copilot review pipeline; " +
        "cryptographic anti-patterns now blocked before code is surfaced to the developer.",
    },

    // ---- scope_drift (1) ----
    {
      key: "risk-31",
      useCaseKey: "uc-2",
      title: "Sentiment analyser repurposed to score employee engagement without approval",
      description:
        "Managers have begun pasting internal team survey responses into the customer " +
        "sentiment analyser to generate engagement scores; this use is outside the " +
        "approved purpose and no ledger measures whether the repurposed usage persists.",
      category: "scope_drift",
      likelihood: "medium",
      impact: "medium",
      targetStatus: "open",
      controls: [
        "nist-ai-rmf:GOVERN-4.1",
        "eu-ai-act:art-9-risk-management-system",
      ],
    },

    // ---- VENDOR-ONLY risk (G5 dependency-graph beat) ----
    // No useCaseKey — this is scoped to vendor-mock so the graph shows the
    // hero use-case inheriting a HIGH rating from its agent's provider.
    {
      key: "risk-vendor-mock-supply-chain",
      vendorKey: "vendor-mock",
      title: "Internal AI platform has unresolved supply-chain vulnerability in model weights",
      description:
        "A third-party audit flagged that the model-weight provenance for mock models " +
        "served by the internal platform is not cryptographically attested; a compromised " +
        "supply chain could silently alter model behaviour in production.",
      category: "third_party_ai",
      likelihood: "high",
      impact: "high",
      targetStatus: "open",
      controls: [
        "nist-ai-rmf:MAP-4.1",
        "eu-ai-act:art-9-risk-management-system",
        "iso-27001:A.8.12",
      ],
    },
  ],

  // -------------------------------------------------------------------------
  // MODEL CARDS — one per seeded agent referenced above.
  // Agents in seed.ts: fast-mock, balanced-mock, premium-mock, claude-opus,
  // gpt-5, gemini-pro, grok.
  // ≥2 must have `assessed` biasFairness entries; 1 must be `in_progress`.
  // biasFairnessEntrySchema requires: dimension, method, status
  // (conductedAt → assessedAt; reportUrl not a valid field)
  // -------------------------------------------------------------------------
  modelCards: [
    {
      agentName: "claude-opus",
      intendedUse:
        "General-purpose reasoning, document analysis, and structured-output generation " +
        "for regulated financial and legal workflows.",
      dataClaims: {
        trainingData: "Anthropic public-internet corpus (Constitutional AI training, 2024 cutoff)",
        personalDataUsed: false,
      },
      limitations:
        "May hallucinate legal citations or regulatory references not in retrieved context. " +
        "Requires RAG grounding for factual legal and financial tasks.",
      biasFairness: [
        {
          dimension: "Demographic parity — credit decisions",
          method:
            "Offline disparate-impact audit on the Acme Bank synthetic credit dataset (N=50,000); " +
            "measured approval-rate gap across gender and ethnicity groups.",
          status: "assessed",
          assessedAt: "2026-06-15T00:00:00Z",
          assessedBy: "Acme MRM team",
          resultRef: "https://internal.acme.example/mrm/reports/claude-opus-bias-2026-06.pdf",
          note: "Approval-rate gap < 2 pp across all measured groups; within the bank's fairness threshold.",
        },
      ],
      standardRefs: ["eu-ai-act:art-10-bias-examination", "nist-ai-rmf:MEASURE-2.11"],
    },
    {
      agentName: "gpt-5",
      intendedUse:
        "High-throughput text classification and structured data extraction for HR and operations workflows.",
      dataClaims: {
        trainingData: "OpenAI training corpus (GPT-5, 2025 knowledge cutoff)",
        personalDataUsed: false,
      },
      limitations:
        "Context window of 128 K tokens; may lose coherence on very long documents. " +
        "ZIP-code penalisation risk observed in HR screening — must be mitigated at evaluation layer.",
      biasFairness: [
        {
          dimension: "Equal opportunity — resume screening",
          method:
            "Retrospective audit on anonymised 2025 applicant pool (N=8,000); " +
            "shortlist-rate compared across self-reported demographic groups.",
          status: "assessed",
          assessedAt: "2026-07-01T00:00:00Z",
          assessedBy: "Acme HR Compliance",
          resultRef: "https://internal.acme.example/mrm/reports/gpt5-resume-bias-2026-07.pdf",
          note:
            "Shortlist rate for highest-risk demographic pair within 3 pp of parity; " +
            "ZIP-code feature removed from feature set after audit.",
        },
      ],
      standardRefs: ["eu-ai-act:art-10-bias-examination"],
    },
    {
      agentName: "gemini-pro",
      intendedUse:
        "Voice and multimodal processing for IVR and call-centre workflows; intent recognition from ASR transcripts.",
      dataClaims: {
        trainingData: "Google Gemini multimodal training corpus, 2025",
        personalDataUsed: false,
      },
      limitations:
        "ASR quality varies for accented speech — may misinterpret customer instructions. " +
        "Bias fairness assessment for voice-demographic interactions is in progress.",
      biasFairness: [
        {
          dimension: "ASR error rate parity — regional accent groups",
          method:
            "In-progress evaluation using a curated accent-diversity test set (N=2,000 calls); " +
            "false-rejection rate comparison across eight regional accent groups.",
          status: "in_progress",
          note:
            "Evaluation began 2026-09-01; results expected by 2026-10-15. Interim: IVR deployed " +
            "with human-override escalation for any failed intent-recognition event.",
        },
      ],
      standardRefs: [],
    },

    {
      agentName: "fast-mock",
      intendedUse:
        "Low-latency mock model for automated testing and CI pipelines. Not for production use.",
      dataClaims: { synthetic: true },
      limitations: "Mock model — deterministic outputs for testing only; not suitable for real inference.",
      biasFairness: [],
      standardRefs: [],
    },
    {
      agentName: "balanced-mock",
      intendedUse:
        "General-purpose mock model simulating a mid-tier LLM; used for the live demo environment " +
        "and integration testing of the credit-limit-increase assistant.",
      dataClaims: { synthetic: true },
      limitations:
        "Mock model — outputs are scripted; no real language understanding. " +
        "Bias fairness not applicable to deterministic mock outputs.",
      biasFairness: [],
      standardRefs: [],
    },
    {
      agentName: "premium-mock",
      intendedUse:
        "High-fidelity mock model simulating a frontier-tier LLM; used for fraud-detection " +
        "integration testing requiring structured JSON tool calls.",
      dataClaims: { synthetic: true },
      limitations: "Mock model — deterministic outputs for testing only; not suitable for real inference.",
      biasFairness: [],
      standardRefs: [],
    },
  ],

  // -------------------------------------------------------------------------
  // SHADOW AI — 6 SaaS AI apps discovered by the shadow-AI discovery feed.
  // Provides the "shadow AI" finding that kicks off the demo journey (Beat 1A).
  // -------------------------------------------------------------------------
  shadowAi: [
    {
      appName: "Credit Team LLM Prototype",
      vendorHost: "api.anthropic.com",
      grantedBy: "user-17@acme.example",
      installCount: 1,
    },
    {
      appName: "ChatGPT Web",
      vendorHost: "chat.openai.com",
      grantedBy: "user-44@acme.example",
      installCount: 27,
    },
    {
      appName: "Claude Web",
      vendorHost: "claude.ai",
      grantedBy: "user-03@acme.example",
      installCount: 156,
    },
    {
      appName: "OpenAI API Testing",
      vendorHost: "api.openai.com",
      grantedBy: "user-29@acme.example",
      installCount: 6,
    },
  ],
};
