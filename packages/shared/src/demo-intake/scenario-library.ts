import type { AiRiskCategory, TrustDimension } from "../risks.js";

export interface DemoRiskScenario {
  key: string;
  title: string;
  description: string;
  category: AiRiskCategory;
  dimension: TrustDimension;
  domains: string[];
  suggestedControls: string[];
}

export const SCENARIO_LIBRARY: DemoRiskScenario[] = [
  {
    "key": "bias-fairness-scenario-1",
    "title": "Potential bias fairness risk 1",
    "description": "This scenario covers bias fairness in the financial-services domain.",
    "category": "bias_fairness",
    "dimension": "bias",
    "domains": [
      "financial-services",
      "human-resources"
    ],
    "suggestedControls": [
      "eu-ai-act:art-10-bias-examination",
      "nist-ai-rmf:MEASURE-2.11"
    ]
  },
  {
    "key": "bias-fairness-scenario-2",
    "title": "Potential bias fairness risk 2",
    "description": "This scenario covers bias fairness in the financial-services domain.",
    "category": "bias_fairness",
    "dimension": "bias",
    "domains": [
      "financial-services",
      "human-resources"
    ],
    "suggestedControls": [
      "eu-ai-act:art-10-bias-examination",
      "nist-ai-rmf:MEASURE-2.11"
    ]
  },
  {
    "key": "bias-fairness-scenario-3",
    "title": "Potential bias fairness risk 3",
    "description": "This scenario covers bias fairness in the financial-services domain.",
    "category": "bias_fairness",
    "dimension": "bias",
    "domains": [
      "financial-services",
      "human-resources"
    ],
    "suggestedControls": [
      "eu-ai-act:art-10-bias-examination",
      "nist-ai-rmf:MEASURE-2.11"
    ]
  },
  {
    "key": "tool-misuse-scenario-1",
    "title": "Potential tool misuse risk 1",
    "description": "This scenario covers tool misuse in the essential-services domain.",
    "category": "tool_misuse",
    "dimension": "security",
    "domains": [
      "essential-services",
      "infrastructure"
    ],
    "suggestedControls": [
      "pci-dss:7.2.1-least-privilege",
      "iso-27001:A.8.12"
    ]
  },
  {
    "key": "tool-misuse-scenario-2",
    "title": "Potential tool misuse risk 2",
    "description": "This scenario covers tool misuse in the essential-services domain.",
    "category": "tool_misuse",
    "dimension": "security",
    "domains": [
      "essential-services",
      "infrastructure"
    ],
    "suggestedControls": [
      "pci-dss:7.2.1-least-privilege",
      "iso-27001:A.8.12"
    ]
  },
  {
    "key": "tool-misuse-scenario-3",
    "title": "Potential tool misuse risk 3",
    "description": "This scenario covers tool misuse in the essential-services domain.",
    "category": "tool_misuse",
    "dimension": "security",
    "domains": [
      "essential-services",
      "infrastructure"
    ],
    "suggestedControls": [
      "pci-dss:7.2.1-least-privilege",
      "iso-27001:A.8.12"
    ]
  },
  {
    "key": "prompt-injection-scenario-1",
    "title": "Potential prompt injection risk 1",
    "description": "This scenario covers prompt injection in the customer-facing domain.",
    "category": "prompt_injection",
    "dimension": "security",
    "domains": [
      "customer-facing",
      "public-sector"
    ],
    "suggestedControls": [
      "eu-ai-act:art-15-accuracy-robustness",
      "nist-ai-rmf:MEASURE-2.7"
    ]
  },
  {
    "key": "prompt-injection-scenario-2",
    "title": "Potential prompt injection risk 2",
    "description": "This scenario covers prompt injection in the customer-facing domain.",
    "category": "prompt_injection",
    "dimension": "security",
    "domains": [
      "customer-facing",
      "public-sector"
    ],
    "suggestedControls": [
      "eu-ai-act:art-15-accuracy-robustness",
      "nist-ai-rmf:MEASURE-2.7"
    ]
  },
  {
    "key": "prompt-injection-scenario-3",
    "title": "Potential prompt injection risk 3",
    "description": "This scenario covers prompt injection in the customer-facing domain.",
    "category": "prompt_injection",
    "dimension": "security",
    "domains": [
      "customer-facing",
      "public-sector"
    ],
    "suggestedControls": [
      "eu-ai-act:art-15-accuracy-robustness",
      "nist-ai-rmf:MEASURE-2.7"
    ]
  },
  {
    "key": "over-permissioning-scenario-1",
    "title": "Potential over permissioning risk 1",
    "description": "This scenario covers over permissioning in the financial-services domain.",
    "category": "over_permissioning",
    "dimension": "security",
    "domains": [
      "financial-services",
      "healthcare"
    ],
    "suggestedControls": [
      "hipaa:164.312(a)(1)-access-control",
      "soc-2:CC6.1-logical-access"
    ]
  },
  {
    "key": "over-permissioning-scenario-2",
    "title": "Potential over permissioning risk 2",
    "description": "This scenario covers over permissioning in the financial-services domain.",
    "category": "over_permissioning",
    "dimension": "security",
    "domains": [
      "financial-services",
      "healthcare"
    ],
    "suggestedControls": [
      "hipaa:164.312(a)(1)-access-control",
      "soc-2:CC6.1-logical-access"
    ]
  },
  {
    "key": "over-permissioning-scenario-3",
    "title": "Potential over permissioning risk 3",
    "description": "This scenario covers over permissioning in the financial-services domain.",
    "category": "over_permissioning",
    "dimension": "security",
    "domains": [
      "financial-services",
      "healthcare"
    ],
    "suggestedControls": [
      "hipaa:164.312(a)(1)-access-control",
      "soc-2:CC6.1-logical-access"
    ]
  },
  {
    "key": "data-leakage-pii-scenario-1",
    "title": "Potential data leakage pii risk 1",
    "description": "This scenario covers data leakage pii in the healthcare domain.",
    "category": "data_leakage_pii",
    "dimension": "privacy",
    "domains": [
      "healthcare",
      "financial-services"
    ],
    "suggestedControls": [
      "hipaa:164.312(e)(1)-transmission-security",
      "soc-2:CC6.7-data-movement"
    ]
  },
  {
    "key": "data-leakage-pii-scenario-2",
    "title": "Potential data leakage pii risk 2",
    "description": "This scenario covers data leakage pii in the healthcare domain.",
    "category": "data_leakage_pii",
    "dimension": "privacy",
    "domains": [
      "healthcare",
      "financial-services"
    ],
    "suggestedControls": [
      "hipaa:164.312(e)(1)-transmission-security",
      "soc-2:CC6.7-data-movement"
    ]
  },
  {
    "key": "data-leakage-pii-scenario-3",
    "title": "Potential data leakage pii risk 3",
    "description": "This scenario covers data leakage pii in the healthcare domain.",
    "category": "data_leakage_pii",
    "dimension": "privacy",
    "domains": [
      "healthcare",
      "financial-services"
    ],
    "suggestedControls": [
      "hipaa:164.312(e)(1)-transmission-security",
      "soc-2:CC6.7-data-movement"
    ]
  },
  {
    "key": "hallucination-scenario-1",
    "title": "Potential hallucination risk 1",
    "description": "This scenario covers hallucination in the healthcare domain.",
    "category": "hallucination",
    "dimension": "reliability",
    "domains": [
      "healthcare",
      "legal"
    ],
    "suggestedControls": [
      "iso-42001:9.1-monitoring-measurement",
      "nist-ai-rmf:MEASURE-2.6"
    ]
  },
  {
    "key": "hallucination-scenario-2",
    "title": "Potential hallucination risk 2",
    "description": "This scenario covers hallucination in the healthcare domain.",
    "category": "hallucination",
    "dimension": "reliability",
    "domains": [
      "healthcare",
      "legal"
    ],
    "suggestedControls": [
      "iso-42001:9.1-monitoring-measurement",
      "nist-ai-rmf:MEASURE-2.6"
    ]
  },
  {
    "key": "hallucination-scenario-3",
    "title": "Potential hallucination risk 3",
    "description": "This scenario covers hallucination in the healthcare domain.",
    "category": "hallucination",
    "dimension": "reliability",
    "domains": [
      "healthcare",
      "legal"
    ],
    "suggestedControls": [
      "iso-42001:9.1-monitoring-measurement",
      "nist-ai-rmf:MEASURE-2.6"
    ]
  },
  {
    "key": "scope-drift-scenario-1",
    "title": "Potential scope drift risk 1",
    "description": "This scenario covers scope drift in the enterprise domain.",
    "category": "scope_drift",
    "dimension": "reliability",
    "domains": [
      "enterprise",
      "internal"
    ],
    "suggestedControls": [
      "iso-42001:A.6-ai-system-lifecycle",
      "soc-2:CC8.1-change-management"
    ]
  },
  {
    "key": "scope-drift-scenario-2",
    "title": "Potential scope drift risk 2",
    "description": "This scenario covers scope drift in the enterprise domain.",
    "category": "scope_drift",
    "dimension": "reliability",
    "domains": [
      "enterprise",
      "internal"
    ],
    "suggestedControls": [
      "iso-42001:A.6-ai-system-lifecycle",
      "soc-2:CC8.1-change-management"
    ]
  },
  {
    "key": "scope-drift-scenario-3",
    "title": "Potential scope drift risk 3",
    "description": "This scenario covers scope drift in the enterprise domain.",
    "category": "scope_drift",
    "dimension": "reliability",
    "domains": [
      "enterprise",
      "internal"
    ],
    "suggestedControls": [
      "iso-42001:A.6-ai-system-lifecycle",
      "soc-2:CC8.1-change-management"
    ]
  },
  {
    "key": "unsafe-output-scenario-1",
    "title": "Potential unsafe output risk 1",
    "description": "This scenario covers unsafe output in the customer-facing domain.",
    "category": "unsafe_output",
    "dimension": "safety",
    "domains": [
      "customer-facing",
      "social"
    ],
    "suggestedControls": [
      "eu-ai-act:art-9-risk-management-system",
      "nist-ai-rmf:MANAGE-2.2"
    ]
  },
  {
    "key": "unsafe-output-scenario-2",
    "title": "Potential unsafe output risk 2",
    "description": "This scenario covers unsafe output in the customer-facing domain.",
    "category": "unsafe_output",
    "dimension": "safety",
    "domains": [
      "customer-facing",
      "social"
    ],
    "suggestedControls": [
      "eu-ai-act:art-9-risk-management-system",
      "nist-ai-rmf:MANAGE-2.2"
    ]
  },
  {
    "key": "unsafe-output-scenario-3",
    "title": "Potential unsafe output risk 3",
    "description": "This scenario covers unsafe output in the customer-facing domain.",
    "category": "unsafe_output",
    "dimension": "safety",
    "domains": [
      "customer-facing",
      "social"
    ],
    "suggestedControls": [
      "eu-ai-act:art-9-risk-management-system",
      "nist-ai-rmf:MANAGE-2.2"
    ]
  },
  {
    "key": "shadow-ai-scenario-1",
    "title": "Potential shadow ai risk 1",
    "description": "This scenario covers shadow ai in the enterprise domain.",
    "category": "shadow_ai",
    "dimension": "compliance",
    "domains": [
      "enterprise",
      "technology"
    ],
    "suggestedControls": [
      "iso-27001:A.8.15",
      "soc-2:CC6.2-user-registration"
    ]
  },
  {
    "key": "shadow-ai-scenario-2",
    "title": "Potential shadow ai risk 2",
    "description": "This scenario covers shadow ai in the enterprise domain.",
    "category": "shadow_ai",
    "dimension": "compliance",
    "domains": [
      "enterprise",
      "technology"
    ],
    "suggestedControls": [
      "iso-27001:A.8.15",
      "soc-2:CC6.2-user-registration"
    ]
  },
  {
    "key": "shadow-ai-scenario-3",
    "title": "Potential shadow ai risk 3",
    "description": "This scenario covers shadow ai in the enterprise domain.",
    "category": "shadow_ai",
    "dimension": "compliance",
    "domains": [
      "enterprise",
      "technology"
    ],
    "suggestedControls": [
      "iso-27001:A.8.15",
      "soc-2:CC6.2-user-registration"
    ]
  },
  {
    "key": "third-party-ai-scenario-1",
    "title": "Potential third party ai risk 1",
    "description": "This scenario covers third party ai in the enterprise domain.",
    "category": "third_party_ai",
    "dimension": "compliance",
    "domains": [
      "enterprise",
      "procurement"
    ],
    "suggestedControls": [
      "soc-2:CC9.2-vendor-risk",
      "hipaa:baa"
    ]
  },
  {
    "key": "third-party-ai-scenario-2",
    "title": "Potential third party ai risk 2",
    "description": "This scenario covers third party ai in the enterprise domain.",
    "category": "third_party_ai",
    "dimension": "compliance",
    "domains": [
      "enterprise",
      "procurement"
    ],
    "suggestedControls": [
      "soc-2:CC9.2-vendor-risk",
      "hipaa:baa"
    ]
  },
  {
    "key": "third-party-ai-scenario-3",
    "title": "Potential third party ai risk 3",
    "description": "This scenario covers third party ai in the enterprise domain.",
    "category": "third_party_ai",
    "dimension": "compliance",
    "domains": [
      "enterprise",
      "procurement"
    ],
    "suggestedControls": [
      "soc-2:CC9.2-vendor-risk",
      "hipaa:baa"
    ]
  },
  {
    "key": "budget-overrun-scenario-1",
    "title": "Potential budget overrun risk 1",
    "description": "This scenario covers budget overrun in the enterprise domain.",
    "category": "budget_overrun",
    "dimension": "compliance",
    "domains": [
      "enterprise",
      "financial-services"
    ],
    "suggestedControls": [
      "iso-27001:A.5.15",
      "soc-2:CC7.2-monitoring"
    ]
  },
  {
    "key": "budget-overrun-scenario-2",
    "title": "Potential budget overrun risk 2",
    "description": "This scenario covers budget overrun in the enterprise domain.",
    "category": "budget_overrun",
    "dimension": "compliance",
    "domains": [
      "enterprise",
      "financial-services"
    ],
    "suggestedControls": [
      "iso-27001:A.5.15",
      "soc-2:CC7.2-monitoring"
    ]
  },
  {
    "key": "budget-overrun-scenario-3",
    "title": "Potential budget overrun risk 3",
    "description": "This scenario covers budget overrun in the enterprise domain.",
    "category": "budget_overrun",
    "dimension": "compliance",
    "domains": [
      "enterprise",
      "financial-services"
    ],
    "suggestedControls": [
      "iso-27001:A.5.15",
      "soc-2:CC7.2-monitoring"
    ]
  }
];
