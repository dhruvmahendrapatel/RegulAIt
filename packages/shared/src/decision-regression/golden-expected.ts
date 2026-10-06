/**
 * ADR-0182 (ADR-0175 batch D4) A11 — THE EXPECTED OUTCOMES of the shipped
 * golden cases under the CODE DEFAULTS (no review policy, every tier's
 * required tests at the strict default, the built-in intake shape). OWNER: A11 (D4).
 *
 * `decision-regression.test.ts` runs `SHIPPED_GOLDEN_CASES` and fails on any
 * difference from this file. A change to the screening rules (eu-ai-act.ts),
 * the suggestion rules (intake-assist.ts) or the required-test defaults
 * (required-tests.ts) that alters an outcome therefore fails CI until this
 * file is updated IN THE SAME COMMIT — and, for a suggestion-rule change,
 * `INTAKE_ASSIST_RULES_VERSION` is bumped with it (the versions below must
 * equal the live constants). The diff of this file is the review of what the
 * change does to decisions.
 */
import type { DecisionOutcome } from "../accountability.js";

/** the rule versions these outcomes were produced under */
export const GOLDEN_EXPECTED_VERSIONS = { euAiActRulesetVersion: 1, intakeAssistVersion: "2026-10-06.1" } as const;

export const GOLDEN_EXPECTED: Readonly<Record<string, DecisionOutcome>> = {
  "minimal-internal-search": {
    "tier": "minimal",
    "reasons": [],
    "frameworks": [
      "nist-ai-rmf",
      "iso-42001"
    ],
    "requiredRoles": [],
    "requiredTests": [
      "owasp:llm:01 maxAsr<=0% within 30d"
    ],
    "suggestedControls": [],
    "approverRouting": "single approver: requesting_user"
  },
  "minimal-eu-vendor-summariser": {
    "tier": "minimal",
    "reasons": [],
    "frameworks": [
      "eu-ai-act",
      "nist-ai-rmf",
      "iso-42001"
    ],
    "requiredRoles": [],
    "requiredTests": [
      "owasp:llm:01 maxAsr<=0% within 30d"
    ],
    "suggestedControls": [
      "eu-ai-act:art-15-accuracy-robustness",
      "nist-ai-rmf:MAP-4.1",
      "nist-ai-rmf:MEASURE-2.5"
    ],
    "approverRouting": "single approver: requesting_user"
  },
  "minimal-hr-narrow-procedural": {
    "tier": "minimal",
    "reasons": [],
    "frameworks": [
      "nist-ai-rmf",
      "iso-42001",
      "soc-2",
      "iso-27001"
    ],
    "requiredRoles": [],
    "requiredTests": [
      "owasp:llm:01 maxAsr<=0% within 30d"
    ],
    "suggestedControls": [
      "iso-27001:A.8.12",
      "iso-42001:8.3-ai-system-impact-assessment",
      "nist-ai-rmf:MEASURE-2.11",
      "soc-2:CC6.7-data-movement"
    ],
    "approverRouting": "single approver: requesting_user"
  },
  "limited-customer-chatbot": {
    "tier": "limited",
    "reasons": [
      "l-interaction-transparency (Art. 50(1))"
    ],
    "frameworks": [
      "eu-ai-act",
      "nist-ai-rmf",
      "iso-42001",
      "soc-2",
      "iso-27001"
    ],
    "requiredRoles": [],
    "requiredTests": [
      "owasp:llm:01 maxAsr<=0% within 30d"
    ],
    "suggestedControls": [
      "eu-ai-act:art-15-accuracy-robustness",
      "iso-27001:A.8.12",
      "nist-ai-rmf:MEASURE-2.5",
      "soc-2:CC6.7-data-movement",
      "soc-2:CC7.2-monitoring"
    ],
    "approverRouting": "single approver: requesting_user"
  },
  "limited-public-synthetic-content": {
    "tier": "limited",
    "reasons": [
      "l-synthetic-content (Art. 50(2)/(4))"
    ],
    "frameworks": [
      "eu-ai-act",
      "nist-ai-rmf",
      "iso-42001",
      "soc-2"
    ],
    "requiredRoles": [],
    "requiredTests": [
      "owasp:llm:01 maxAsr<=0% within 30d"
    ],
    "suggestedControls": [
      "eu-ai-act:art-15-accuracy-robustness",
      "nist-ai-rmf:MAP-4.1",
      "nist-ai-rmf:MEASURE-2.5",
      "soc-2:CC7.2-monitoring",
      "soc-2:CC9.2-vendor-risk"
    ],
    "approverRouting": "single approver: requesting_user"
  },
  "high-credit-scoring": {
    "tier": "high",
    "reasons": [
      "h-domain-essential-services (Annex III 5)",
      "h-annex3-profiling (Art. 6(3), final subparagraph)"
    ],
    "frameworks": [
      "eu-ai-act",
      "nist-ai-rmf",
      "iso-42001",
      "soc-2",
      "iso-27001"
    ],
    "requiredRoles": [],
    "requiredTests": [
      "owasp:llm:01 maxAsr<=0% within 30d",
      "owasp:llm:02 maxAsr<=0% within 30d",
      "owasp:llm:06 maxAsr<=0% within 30d",
      "owasp:agentic:asi01 maxAsr<=0% within 30d",
      "owasp:agentic:asi02 maxAsr<=0% within 30d",
      "owasp:agentic:asi06 maxAsr<=0% within 30d",
      "owasp:agentic:asi10 maxAsr<=0% within 30d"
    ],
    "suggestedControls": [
      "eu-ai-act:art-9-risk-management-system",
      "iso-27001:A.8.12",
      "iso-42001:8.3-ai-system-impact-assessment",
      "nist-ai-rmf:MEASURE-2.11",
      "soc-2:CC6.7-data-movement"
    ],
    "approverRouting": "single approver: requesting_user"
  },
  "high-hiring-screen": {
    "tier": "high",
    "reasons": [
      "h-domain-employment (Annex III 4)",
      "h-annex3-profiling (Art. 6(3), final subparagraph)"
    ],
    "frameworks": [
      "eu-ai-act",
      "nist-ai-rmf",
      "iso-42001",
      "soc-2",
      "iso-27001"
    ],
    "requiredRoles": [],
    "requiredTests": [
      "owasp:llm:01 maxAsr<=0% within 30d",
      "owasp:llm:02 maxAsr<=0% within 30d",
      "owasp:llm:06 maxAsr<=0% within 30d",
      "owasp:agentic:asi01 maxAsr<=0% within 30d",
      "owasp:agentic:asi02 maxAsr<=0% within 30d",
      "owasp:agentic:asi06 maxAsr<=0% within 30d",
      "owasp:agentic:asi10 maxAsr<=0% within 30d"
    ],
    "suggestedControls": [
      "eu-ai-act:art-15-accuracy-robustness",
      "eu-ai-act:art-9-risk-management-system",
      "iso-27001:A.8.12",
      "iso-42001:8.3-ai-system-impact-assessment",
      "nist-ai-rmf:MAP-4.1",
      "nist-ai-rmf:MEASURE-2.11",
      "nist-ai-rmf:MEASURE-2.5",
      "soc-2:CC6.7-data-movement",
      "soc-2:CC9.2-vendor-risk"
    ],
    "approverRouting": "single approver: requesting_user"
  },
  "high-medical-device-component": {
    "tier": "high",
    "reasons": [
      "h-safety-component (Art. 6(1) / Annex I)"
    ],
    "frameworks": [
      "eu-ai-act",
      "nist-ai-rmf",
      "iso-42001",
      "soc-2",
      "iso-27001",
      "hipaa"
    ],
    "requiredRoles": [],
    "requiredTests": [
      "owasp:llm:01 maxAsr<=0% within 30d",
      "owasp:llm:02 maxAsr<=0% within 30d",
      "owasp:llm:06 maxAsr<=0% within 30d",
      "owasp:agentic:asi01 maxAsr<=0% within 30d",
      "owasp:agentic:asi02 maxAsr<=0% within 30d",
      "owasp:agentic:asi06 maxAsr<=0% within 30d",
      "owasp:agentic:asi10 maxAsr<=0% within 30d"
    ],
    "suggestedControls": [
      "hipaa:164.312(a)(1)-access-control",
      "iso-27001:A.8.12",
      "soc-2:CC6.7-data-movement"
    ],
    "approverRouting": "single approver: requesting_user"
  },
  "high-grid-operations-agent": {
    "tier": "high",
    "reasons": [
      "h-domain-critical-infrastructure (Annex III 2)"
    ],
    "frameworks": [
      "eu-ai-act",
      "nist-ai-rmf",
      "iso-42001"
    ],
    "requiredRoles": [],
    "requiredTests": [
      "owasp:llm:01 maxAsr<=0% within 30d",
      "owasp:llm:02 maxAsr<=0% within 30d",
      "owasp:llm:06 maxAsr<=0% within 30d",
      "owasp:agentic:asi01 maxAsr<=0% within 30d",
      "owasp:agentic:asi02 maxAsr<=0% within 30d",
      "owasp:agentic:asi06 maxAsr<=0% within 30d",
      "owasp:agentic:asi10 maxAsr<=0% within 30d"
    ],
    "suggestedControls": [
      "eu-ai-act:art-14-human-oversight",
      "eu-ai-act:art-72-post-market-monitoring",
      "iso-42001:9.1-monitoring-measurement",
      "nist-ai-rmf:GOVERN-2.1",
      "nist-ai-rmf:MANAGE-2.4"
    ],
    "approverRouting": "single approver: requesting_user"
  },
  "high-card-fraud-review": {
    "tier": "high",
    "reasons": [
      "h-domain-essential-services (Annex III 5)",
      "h-annex3-profiling (Art. 6(3), final subparagraph)"
    ],
    "frameworks": [
      "nist-ai-rmf",
      "iso-42001",
      "soc-2",
      "iso-27001",
      "pci-dss"
    ],
    "requiredRoles": [],
    "requiredTests": [
      "owasp:llm:01 maxAsr<=0% within 30d",
      "owasp:llm:02 maxAsr<=0% within 30d",
      "owasp:llm:06 maxAsr<=0% within 30d",
      "owasp:agentic:asi01 maxAsr<=0% within 30d",
      "owasp:agentic:asi02 maxAsr<=0% within 30d",
      "owasp:agentic:asi06 maxAsr<=0% within 30d",
      "owasp:agentic:asi10 maxAsr<=0% within 30d"
    ],
    "suggestedControls": [
      "iso-27001:A.8.12",
      "iso-42001:8.3-ai-system-impact-assessment",
      "iso-42001:9.1-monitoring-measurement",
      "nist-ai-rmf:MEASURE-2.11",
      "soc-2:CC6.7-data-movement"
    ],
    "approverRouting": "single approver: requesting_user"
  },
  "prohibited-social-scoring": {
    "tier": "prohibited",
    "reasons": [
      "p-social-scoring (Art. 5(1)(c))"
    ],
    "frameworks": [
      "eu-ai-act",
      "nist-ai-rmf",
      "iso-42001",
      "soc-2",
      "iso-27001"
    ],
    "requiredRoles": [],
    "requiredTests": [
      "owasp:llm:01 maxAsr<=0% within 30d",
      "owasp:llm:02 maxAsr<=0% within 30d",
      "owasp:llm:06 maxAsr<=0% within 30d",
      "owasp:agentic:asi01 maxAsr<=0% within 30d",
      "owasp:agentic:asi02 maxAsr<=0% within 30d",
      "owasp:agentic:asi06 maxAsr<=0% within 30d",
      "owasp:agentic:asi10 maxAsr<=0% within 30d"
    ],
    "suggestedControls": [
      "eu-ai-act:art-9-risk-management-system",
      "iso-27001:A.8.12",
      "iso-42001:8.3-ai-system-impact-assessment",
      "nist-ai-rmf:MEASURE-2.11",
      "soc-2:CC6.7-data-movement"
    ],
    "approverRouting": "single approver: requesting_user"
  },
  "prohibited-workplace-emotion": {
    "tier": "prohibited",
    "reasons": [
      "p-emotion-workplace-education (Art. 5(1)(f))",
      "h-emotion-recognition (Annex III 1(c))",
      "h-domain-employment (Annex III 4)"
    ],
    "frameworks": [
      "eu-ai-act",
      "nist-ai-rmf",
      "iso-42001",
      "soc-2",
      "iso-27001"
    ],
    "requiredRoles": [],
    "requiredTests": [
      "owasp:llm:01 maxAsr<=0% within 30d",
      "owasp:llm:02 maxAsr<=0% within 30d",
      "owasp:llm:06 maxAsr<=0% within 30d",
      "owasp:agentic:asi01 maxAsr<=0% within 30d",
      "owasp:agentic:asi02 maxAsr<=0% within 30d",
      "owasp:agentic:asi06 maxAsr<=0% within 30d",
      "owasp:agentic:asi10 maxAsr<=0% within 30d"
    ],
    "suggestedControls": [
      "eu-ai-act:art-9-risk-management-system",
      "iso-27001:A.8.12",
      "iso-42001:8.3-ai-system-impact-assessment",
      "nist-ai-rmf:MEASURE-2.11",
      "soc-2:CC6.7-data-movement"
    ],
    "approverRouting": "single approver: requesting_user"
  },
  "not-sure-profiling-counted-as-yes": {
    "tier": "high",
    "reasons": [
      "h-annex3-profiling (Art. 6(3), final subparagraph)",
      "not sure: profilesNaturalPersons counted as yes"
    ],
    "frameworks": [
      "eu-ai-act",
      "nist-ai-rmf",
      "iso-42001",
      "soc-2",
      "iso-27001"
    ],
    "requiredRoles": [],
    "requiredTests": [
      "owasp:llm:01 maxAsr<=0% within 30d",
      "owasp:llm:02 maxAsr<=0% within 30d",
      "owasp:llm:06 maxAsr<=0% within 30d",
      "owasp:agentic:asi01 maxAsr<=0% within 30d",
      "owasp:agentic:asi02 maxAsr<=0% within 30d",
      "owasp:agentic:asi06 maxAsr<=0% within 30d",
      "owasp:agentic:asi10 maxAsr<=0% within 30d"
    ],
    "suggestedControls": [
      "eu-ai-act:art-9-risk-management-system",
      "iso-27001:A.8.12",
      "iso-42001:8.3-ai-system-impact-assessment",
      "nist-ai-rmf:MEASURE-2.11",
      "soc-2:CC6.7-data-movement"
    ],
    "approverRouting": "single approver: requesting_user"
  },
  "not-sure-interaction-counted-as-yes": {
    "tier": "limited",
    "reasons": [
      "l-interaction-transparency (Art. 50(1))",
      "not sure: interactsWithHumans counted as yes",
      "not sure: usesExternalVendor counted as yes"
    ],
    "frameworks": [
      "nist-ai-rmf",
      "iso-42001"
    ],
    "requiredRoles": [],
    "requiredTests": [
      "owasp:llm:01 maxAsr<=0% within 30d"
    ],
    "suggestedControls": [
      "nist-ai-rmf:MAP-4.1",
      "nist-ai-rmf:MEASURE-2.5"
    ],
    "approverRouting": "single approver: requesting_user"
  },
  "not-sure-stored-beside-no": {
    "tier": null,
    "reasons": [
      "answers refused: unsure_answer_must_count_as_yes (safetyComponent)"
    ],
    "frameworks": [],
    "requiredRoles": [],
    "requiredTests": [
      "owasp:llm:01 maxAsr<=0% within 30d",
      "owasp:llm:02 maxAsr<=0% within 30d",
      "owasp:llm:06 maxAsr<=0% within 30d",
      "owasp:agentic:asi01 maxAsr<=0% within 30d",
      "owasp:agentic:asi02 maxAsr<=0% within 30d",
      "owasp:agentic:asi06 maxAsr<=0% within 30d",
      "owasp:agentic:asi10 maxAsr<=0% within 30d"
    ],
    "suggestedControls": [],
    "approverRouting": "single approver: requesting_user"
  },
  "unscreened-missing-answer": {
    "tier": null,
    "reasons": [
      "answers refused: decisionAutonomy Required"
    ],
    "frameworks": [],
    "requiredRoles": [],
    "requiredTests": [
      "owasp:llm:01 maxAsr<=0% within 30d",
      "owasp:llm:02 maxAsr<=0% within 30d",
      "owasp:llm:06 maxAsr<=0% within 30d",
      "owasp:agentic:asi01 maxAsr<=0% within 30d",
      "owasp:agentic:asi02 maxAsr<=0% within 30d",
      "owasp:agentic:asi06 maxAsr<=0% within 30d",
      "owasp:agentic:asi10 maxAsr<=0% within 30d"
    ],
    "suggestedControls": [],
    "approverRouting": "single approver: requesting_user"
  },
  "limited-broker-dealer-assistant": {
    "tier": "limited",
    "reasons": [
      "l-interaction-transparency (Art. 50(1))"
    ],
    "frameworks": [
      "nist-ai-rmf",
      "iso-42001",
      "soc-2",
      "iso-27001",
      "finra"
    ],
    "requiredRoles": [],
    "requiredTests": [
      "owasp:llm:01 maxAsr<=0% within 30d"
    ],
    "suggestedControls": [
      "iso-27001:A.8.12",
      "nist-ai-rmf:MAP-4.1",
      "nist-ai-rmf:MEASURE-2.5",
      "soc-2:CC6.7-data-movement",
      "soc-2:CC7.2-monitoring",
      "soc-2:CC9.2-vendor-risk"
    ],
    "approverRouting": "single approver: requesting_user"
  }
};
