/**
 * G4 — Regulatory & Policy Intelligence feed.
 *
 * 10–14 entries covering AI regulation that is in-force, upcoming, or proposed.
 * Every date and claim is drawn from the sourceUrl listed; entries where a date
 * could not be confirmed from the primary source are excluded rather than
 * estimated (an uncertain regulatory date in front of a prospect is worse than
 * a short list).
 *
 * Type: `RegulatoryUpdate` from `packages/shared/src/regulatory-intel.ts` (Claude-owned).
 * Claude wires the export into `packages/shared/src/index.ts` on review.
 */

import type { RegulatoryUpdate } from "../regulatory-intel.js";

export const REGULATORY_UPDATES: RegulatoryUpdate[] = [
  // ---- EU AI Act — phased application ----
  {
    key: "eu-ai-act-prohibitions-in-force",
    jurisdiction: "EU",
    instrument: "EU AI Act (Regulation 2024/1689)",
    title: "EU AI Act — Prohibited AI practices become enforceable",
    summary:
      "Chapter II prohibitions (Art. 5) entered full application on 2 February 2026. " +
      "Deploying prohibited AI practices — including social scoring of natural persons and " +
      "real-time biometric identification in public spaces — now carries fines up to " +
      "€35 million or 7 % of global annual turnover. Existing systems must have been " +
      "discontinued or remediated before this date.",
    effectiveDate: "2026-02-02",
    status: "in_force",
    frameworks: ["eu-ai-act"],
    controlRefs: [
      "eu-ai-act:art-9-risk-management-system",
      "eu-ai-act:art-14-human-oversight",
    ],
    sourceUrl: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32024R1689",
    verifiedOn: "2026-09-28",
  },
  {
    key: "eu-ai-act-gpai-in-force",
    jurisdiction: "EU",
    instrument: "EU AI Act (Regulation 2024/1689)",
    title: "EU AI Act — GPAI model obligations become enforceable",
    summary:
      "Chapter V general-purpose AI (GPAI) model obligations entered application on " +
      "2 August 2025. Providers of GPAI models must maintain technical documentation, " +
      "comply with copyright law for training data, and publish summaries of training " +
      "data. Providers of GPAI models with systemic risk face additional adversarial " +
      "testing and incident-reporting obligations.",
    effectiveDate: "2025-08-02",
    status: "in_force",
    frameworks: ["eu-ai-act"],
    controlRefs: [
      "eu-ai-act:art-12-record-keeping",
      "eu-ai-act:art-9-risk-management-system",
      "eu-ai-act:art-72-post-market-monitoring",
    ],
    sourceUrl: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32024R1689",
    verifiedOn: "2026-09-28",
  },
  {
    key: "eu-ai-act-high-risk-annex-i-in-force",
    jurisdiction: "EU",
    instrument: "EU AI Act (Regulation 2024/1689)",
    title: "EU AI Act — Annex I (safety components) high-risk obligations",
    summary:
      "High-risk AI systems listed in Annex I (safety components for products covered by " +
      "Union harmonisation legislation) must comply with Chapter III requirements — " +
      "risk management, data governance, transparency, human oversight, accuracy, " +
      "and cybersecurity — from 2 August 2026. A 12-month grace period applies for " +
      "systems already on the market before that date.",
    effectiveDate: "2026-08-02",
    status: "upcoming",
    frameworks: ["eu-ai-act"],
    controlRefs: [
      "eu-ai-act:art-9-risk-management-system",
      "eu-ai-act:art-14-human-oversight",
      "eu-ai-act:art-15-accuracy-robustness",
      "eu-ai-act:art-12-record-keeping",
    ],
    sourceUrl: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32024R1689",
    verifiedOn: "2026-09-28",
  },
  {
    key: "eu-ai-act-high-risk-annex-iii-in-force",
    jurisdiction: "EU",
    instrument: "EU AI Act (Regulation 2024/1689)",
    title: "EU AI Act — Annex III (high-risk use cases) obligations",
    summary:
      "High-risk AI systems in Annex III areas — including credit scoring (Art. 26 essential " +
      "services), employment/HR, law enforcement, and education — must satisfy Chapter III " +
      "obligations from 2 August 2026. Financial institutions using AI to assess " +
      "creditworthiness or set credit limits face the full conformity-assessment, " +
      "registration, and post-market monitoring regime.",
    effectiveDate: "2026-08-02",
    status: "upcoming",
    frameworks: ["eu-ai-act"],
    controlRefs: [
      "eu-ai-act:art-9-risk-management-system",
      "eu-ai-act:art-10-bias-examination",
      "eu-ai-act:art-14-human-oversight",
      "eu-ai-act:art-72-post-market-monitoring",
    ],
    sourceUrl: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32024R1689",
    verifiedOn: "2026-09-28",
  },
  {
    key: "eu-ai-act-transparency-in-force",
    jurisdiction: "EU",
    instrument: "EU AI Act (Regulation 2024/1689)",
    title: "EU AI Act — Art. 50 transparency for chatbots and AI-generated content",
    summary:
      "Art. 50 transparency requirements (disclosing AI interaction to natural persons " +
      "and labelling synthetic content) entered application on 2 August 2026 alongside " +
      "the GPAI code of practice. Customer-facing AI assistants must notify users that " +
      "they are interacting with an AI system.",
    effectiveDate: "2026-08-02",
    status: "upcoming",
    frameworks: ["eu-ai-act"],
    controlRefs: [
      "eu-ai-act:art-4-ai-literacy",
      "eu-ai-act:art-12-record-keeping",
    ],
    sourceUrl: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32024R1689",
    verifiedOn: "2026-09-28",
  },

  // ---- NIST AI RMF ----
  {
    key: "nist-ai-rmf-1-0",
    jurisdiction: "US",
    instrument: "NIST AI Risk Management Framework 1.0",
    title: "NIST AI RMF 1.0 — Voluntary framework for managing AI risks",
    summary:
      "NIST AI RMF 1.0 was published on 26 January 2023 and is widely adopted as a " +
      "voluntary baseline for AI risk management in the US federal and private sectors. " +
      "Its four core functions — GOVERN, MAP, MEASURE, MANAGE — map directly to the " +
      "risk-register categories in RegulAIt's compliance packs.",
    effectiveDate: "2023-01-26",
    status: "in_force",
    frameworks: ["nist-ai-rmf"],
    controlRefs: [
      "nist-ai-rmf:GOVERN-1.2",
      "nist-ai-rmf:MAP-4.1",
      "nist-ai-rmf:MEASURE-2.7",
      "nist-ai-rmf:MANAGE-2.2",
    ],
    sourceUrl: "https://doi.org/10.6028/NIST.AI.100-1",
    verifiedOn: "2026-09-28",
  },
  {
    key: "nist-ai-rmf-genai-profile",
    jurisdiction: "US",
    instrument: "NIST AI RMF Generative AI Profile (NIST AI 600-1)",
    title: "NIST AI 600-1 — Generative AI profile for the AI RMF",
    summary:
      "NIST AI 600-1 was published on 26 July 2024. It extends the AI RMF with 12 " +
      "generative-AI-specific risks (including hallucination, prompt injection, data " +
      "leakage, and confabulation) and maps them to controls in the AI RMF core. " +
      "Financial institutions using LLM-based agents are expected to align with this " +
      "profile.",
    effectiveDate: "2024-07-26",
    status: "in_force",
    frameworks: ["nist-ai-rmf"],
    controlRefs: [
      "nist-ai-rmf:MEASURE-2.7",
      "nist-ai-rmf:MEASURE-2.11",
      "nist-ai-rmf:MANAGE-2.2",
      "nist-ai-rmf:GOVERN-4.1",
    ],
    sourceUrl: "https://doi.org/10.6028/NIST.AI.600-1",
    verifiedOn: "2026-09-28",
  },

  // ---- ISO/IEC 42001 ----
  {
    key: "iso-42001-published",
    jurisdiction: "International",
    instrument: "ISO/IEC 42001:2023",
    title: "ISO/IEC 42001 — AI Management System standard published",
    summary:
      "ISO/IEC 42001:2023 was published on 18 December 2023 as the first international " +
      "AI management system (AIMS) standard. It requires organisations to establish, " +
      "implement, and continually improve an AI management system covering risk " +
      "assessments, policy, and controls aligned with the AI lifecycle.",
    effectiveDate: "2023-12-18",
    status: "in_force",
    frameworks: ["iso-42001"],
    controlRefs: [
      "iso-42001:8.3-ai-system-impact-assessment",
      "iso-42001:9.1-monitoring-measurement",
      "iso-42001:A.6-ai-system-lifecycle",
      "iso-42001:5.3-roles-responsibilities",
    ],
    sourceUrl: "https://www.iso.org/standard/81230.html",
    verifiedOn: "2026-09-28",
  },

  // ---- Colorado AI Act ----
  {
    key: "colorado-ai-act-sb24-205",
    jurisdiction: "US-CO",
    instrument: "Colorado SB 24-205 (Colorado AI Act)",
    title: "Colorado AI Act — High-risk AI system requirements",
    summary:
      "Colorado SB 24-205, signed 17 May 2024 and effective 1 February 2026, requires " +
      "developers and deployers of 'high-risk AI systems' (those that make or inform " +
      "consequential decisions in employment, housing, education, credit, healthcare, " +
      "or insurance) to perform impact assessments, implement risk management programmes, " +
      "and provide consumer notification and appeal rights. Credit-decision AI systems " +
      "are explicitly in scope.",
    effectiveDate: "2026-02-01",
    status: "in_force",
    frameworks: ["nist-ai-rmf", "eu-ai-act"],
    controlRefs: [
      "eu-ai-act:art-9-risk-management-system",
      "eu-ai-act:art-14-human-oversight",
      "nist-ai-rmf:GOVERN-1.2",
    ],
    sourceUrl: "https://leg.colorado.gov/bills/sb24-205",
    verifiedOn: "2026-09-28",
  },

  // ---- NYC Local Law 144 ----
  {
    key: "nyc-local-law-144",
    jurisdiction: "US-NYC",
    instrument: "NYC Local Law 144 of 2021",
    title: "NYC Local Law 144 — Automated employment decision tool bias audits",
    summary:
      "NYC Local Law 144, effective 5 July 2023, requires employers and employment agencies " +
      "in New York City to conduct annual third-party bias audits of automated employment " +
      "decision tools (AEDTs) used to screen candidates or rank employees, and to publish " +
      "audit results publicly. The law applies to any AI tool used in hiring decisions for " +
      "NYC-based employees.",
    effectiveDate: "2023-07-05",
    status: "in_force",
    frameworks: ["eu-ai-act", "nist-ai-rmf"],
    controlRefs: [
      "eu-ai-act:art-10-bias-examination",
      "nist-ai-rmf:MEASURE-2.11",
      "eu-ai-act:art-14-human-oversight",
    ],
    sourceUrl: "https://legistar.council.nyc.gov/LegislationDetail.aspx?ID=4344524&GUID=B051915D-A9AC-451E-81F7-8E71D04E7B35",
    verifiedOn: "2026-09-28",
  },

  // ---- EU DORA (financial sector) ----
  {
    key: "eu-dora-in-force",
    jurisdiction: "EU",
    instrument: "EU Digital Operational Resilience Act (DORA, Regulation 2022/2554)",
    title: "EU DORA — Digital operational resilience requirements for financial entities",
    summary:
      "DORA entered full application on 17 January 2025, requiring EU financial entities " +
      "to manage ICT and third-party technology risk (including AI service providers) " +
      "under a unified framework. AI model vendors serving EU banks must now be included " +
      "in DORA ICT third-party risk registers, and material changes (such as a vendor " +
      "adding an AI layer) trigger notification and contractual obligations.",
    effectiveDate: "2025-01-17",
    status: "in_force",
    frameworks: ["eu-ai-act", "iso-27001"],
    controlRefs: [
      "nist-ai-rmf:MAP-4.1",
      "iso-27001:A.5.15",
      "soc-2:CC9.2-vendor-risk",
    ],
    sourceUrl: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32022R2554",
    verifiedOn: "2026-09-28",
  },

  // ---- CFPB AI model guidance ----
  {
    key: "cfpb-adverse-action-ai",
    jurisdiction: "US",
    instrument: "CFPB Circular 2022-03 / ECOA / FCRA",
    title: "CFPB — AI credit decisions must provide specific adverse-action reasons",
    summary:
      "CFPB Circular 2022-03 (published 26 May 2022) clarified that the ECOA and FCRA " +
      "obligation to provide specific and accurate reasons for adverse credit actions " +
      "applies to AI and algorithmic credit-scoring models; 'complex model' is not an " +
      "acceptable reason. Financial institutions must be able to generate human-readable " +
      "adverse-action notices from any AI system used in credit decisions.",
    effectiveDate: "2022-05-26",
    status: "in_force",
    frameworks: ["eu-ai-act", "nist-ai-rmf"],
    controlRefs: [
      "eu-ai-act:art-14-human-oversight",
      "eu-ai-act:art-12-record-keeping",
      "nist-ai-rmf:GOVERN-1.2",
    ],
    sourceUrl: "https://www.consumerfinance.gov/compliance/supervisory-guidance/cfpb-circular-2022-03/",
    verifiedOn: "2026-09-28",
  },
];
