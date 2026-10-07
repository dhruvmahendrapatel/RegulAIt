/**
 * G4 — Regulatory & Policy Intelligence feed.
 *
 * 10–14 entries covering AI regulation, guidance and voluntary standards. Every
 * date and claim is drawn from the sourceUrl listed; entries where a date could
 * not be confirmed from the primary source are excluded rather than estimated
 * (an uncertain regulatory date in front of a prospect is worse than a short
 * list).
 *
 * ADR-0179 (G14-FEED) reconciled every entry:
 *  - each entry names its instrument kind. NIST AI RMF, NIST AI 600-1 and
 *    ISO/IEC 42001 are voluntary standards: `published`, never `in_force`;
 *  - a law whose source names a later enforcement date carries it separately
 *    (NYC Local Law 144: effective 2023-01-01, enforced from 2023-07-05);
 *  - withdrawn guidance stays listed as `withdrawn` with its withdrawal date
 *    (CFPB Circular 2022-03, withdrawn 2025-05-12);
 *  - summaries restate the source and draw no applicability conclusion. Whether
 *    an entry applies to a given organisation is pending legal review.
 *
 * Type: `RegulatoryUpdate` from `packages/shared/src/regulatory-intel.ts`.
 */

import type { RegulatoryUpdate } from "../regulatory-intel.js";

export const REGULATORY_UPDATES: RegulatoryUpdate[] = [
  // ---- EU AI Act — phased application ----
  {
    key: "eu-ai-act-prohibitions-in-force",
    jurisdiction: "EU",
    instrument: "EU AI Act (Regulation 2024/1689)",
    instrumentKind: "law",
    title: "EU AI Act — Prohibited AI practices apply",
    summary:
      "Chapters I and II, including the Art. 5 prohibitions, apply from 2 February 2025 (Art. 113(a)). " +
      "The prohibited practices include social scoring and, subject to narrow exceptions, real-time remote " +
      "biometric identification in publicly accessible spaces for law enforcement. Art. 99 sets fines of up " +
      "to €35 million or 7 % of worldwide annual turnover for breaching Art. 5.",
    effectiveDate: "2025-02-02",
    status: "in_force",
    frameworks: ["eu-ai-act"],
    controlRefs: [
      "eu-ai-act:art-9-risk-management-system",
      "eu-ai-act:art-14-human-oversight",
    ],
    sourceUrl: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32024R1689",
    verifiedOn: "2026-10-05",
  },
  {
    key: "eu-ai-act-gpai-in-force",
    jurisdiction: "EU",
    instrument: "EU AI Act (Regulation 2024/1689)",
    instrumentKind: "law",
    title: "EU AI Act — GPAI model obligations apply",
    summary:
      "Chapter V general-purpose AI (GPAI) model obligations apply from 2 August 2025. " +
      "Providers of GPAI models must maintain technical documentation, put in place a policy to comply " +
      "with Union copyright law, and publish a summary of the content used for training. Providers of GPAI " +
      "models with systemic risk have additional evaluation, adversarial-testing and incident-reporting " +
      "obligations.",
    effectiveDate: "2025-08-02",
    status: "in_force",
    frameworks: ["eu-ai-act"],
    controlRefs: [
      "eu-ai-act:art-12-record-keeping",
      "eu-ai-act:art-9-risk-management-system",
      "eu-ai-act:art-72-post-market-monitoring",
    ],
    sourceUrl: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32024R1689",
    verifiedOn: "2026-10-01",
  },
  {
    key: "eu-digital-omnibus-on-ai",
    jurisdiction: "EU",
    instrument: "Digital Omnibus on AI (Regulation (EU) 2026/1744)",
    instrumentKind: "law",
    title: "EU Digital Omnibus on AI — Amends AI Act timelines",
    summary:
      "Regulation (EU) 2026/1744 (Digital Omnibus on AI), adopted on 8 July 2026, entered into force on " +
      "27 July 2026. It amends the application dates for high-risk AI systems under the EU AI Act: " +
      "2 December 2027 for systems classified as high-risk under Art. 6(2) and Annex III, and 2 August 2028 " +
      "for systems classified as high-risk under Art. 6(1) and Annex I.",
    effectiveDate: "2026-07-27",
    status: "in_force",
    frameworks: ["eu-ai-act"],
    controlRefs: [
      "eu-ai-act:art-9-risk-management-system",
    ],
    sourceUrl: "https://eur-lex.europa.eu/eli/reg/2026/1744/oj/eng",
    verifiedOn: "2026-10-05",
  },
  {
    key: "eu-ai-act-high-risk-annex-i-in-force",
    jurisdiction: "EU",
    instrument: "EU AI Act (Regulation 2024/1689)",
    instrumentKind: "law",
    title: "EU AI Act — Annex I (safety components) high-risk obligations",
    summary:
      "High-risk AI systems classified under Art. 6(1) and Annex I (safety components of products covered " +
      "by Union harmonisation legislation) must comply with the Chapter III requirements — risk management, " +
      "data governance, transparency, human oversight, accuracy, robustness and cybersecurity — from " +
      "2 August 2028. The Digital Omnibus on AI (Regulation 2026/1744) set this date.",
    effectiveDate: "2028-08-02",
    status: "upcoming",
    frameworks: ["eu-ai-act"],
    scope: { euAiActTiers: ["high"] },
    controlRefs: [
      "eu-ai-act:art-9-risk-management-system",
      "eu-ai-act:art-14-human-oversight",
      "eu-ai-act:art-15-accuracy-robustness",
      "eu-ai-act:art-12-record-keeping",
    ],
    sourceUrl: "https://eur-lex.europa.eu/eli/reg/2026/1744/oj/eng",
    verifiedOn: "2026-10-05",
  },
  {
    key: "eu-ai-act-high-risk-annex-iii-in-force",
    jurisdiction: "EU",
    instrument: "EU AI Act (Regulation 2024/1689)",
    instrumentKind: "law",
    title: "EU AI Act — Annex III (high-risk use cases) obligations",
    summary:
      "High-risk AI systems classified under Art. 6(2) and Annex III — areas that include creditworthiness " +
      "assessment, employment, education and law enforcement — must satisfy the Chapter III obligations " +
      "from 2 December 2027. The Digital Omnibus on AI (Regulation 2026/1744) set this date.",
    effectiveDate: "2027-12-02",
    status: "upcoming",
    frameworks: ["eu-ai-act"],
    scope: { euAiActTiers: ["high"] },
    controlRefs: [
      "eu-ai-act:art-9-risk-management-system",
      "eu-ai-act:art-10-bias-examination",
      "eu-ai-act:art-14-human-oversight",
      "eu-ai-act:art-72-post-market-monitoring",
    ],
    sourceUrl: "https://eur-lex.europa.eu/eli/reg/2026/1744/oj/eng",
    verifiedOn: "2026-10-05",
  },
  {
    key: "eu-ai-act-transparency-in-force",
    jurisdiction: "EU",
    instrument: "EU AI Act (Regulation 2024/1689)",
    instrumentKind: "law",
    title: "EU AI Act — Art. 50 transparency for chatbots and AI-generated content",
    summary:
      "Art. 50 transparency requirements (informing natural persons that they are interacting with an AI " +
      "system, and marking synthetic content) apply from 2 August 2026, the Regulation's general " +
      "application date (Art. 113).",
    effectiveDate: "2026-08-02",
    status: "in_force",
    frameworks: ["eu-ai-act"],
    // Art. 50 has no control in the EU AI Act pack yet, and Art. 4 (literacy) and Art. 12 (record-keeping)
    // are not what this entry is about, so it links none rather than the wrong ones (R5:43 review, 2026-10-07).
    // Link the Art. 50 control here once the pack gains one in a new revision.
    controlRefs: [],
    sourceUrl: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32024R1689",
    verifiedOn: "2026-10-05",
  },

  // ---- NIST AI RMF (voluntary) ----
  {
    key: "nist-ai-rmf-1-0",
    jurisdiction: "US",
    instrument: "NIST AI Risk Management Framework 1.0 (NIST AI 100-1)",
    instrumentKind: "voluntary_standard",
    title: "NIST AI RMF 1.0 — Voluntary framework for managing AI risks",
    summary:
      "NIST AI RMF 1.0 was published in January 2023. The framework describes itself as voluntary, " +
      "rights-preserving, non-sector-specific and use-case agnostic. Its four core functions — GOVERN, MAP, " +
      "MEASURE and MANAGE — map to the risk-register categories in RegulAIt's compliance packs.",
    effectiveDate: "2023-01-26",
    status: "published",
    frameworks: ["nist-ai-rmf"],
    controlRefs: [
      "nist-ai-rmf:GOVERN-2.1",
      "nist-ai-rmf:MAP-4.1",
      "nist-ai-rmf:MEASURE-2.7",
      "nist-ai-rmf:MANAGE-2.4",
    ],
    sourceUrl: "https://doi.org/10.6028/NIST.AI.100-1",
    verifiedOn: "2026-10-05",
  },
  {
    key: "nist-ai-rmf-genai-profile",
    jurisdiction: "US",
    instrument: "NIST AI RMF Generative AI Profile (NIST AI 600-1)",
    instrumentKind: "voluntary_standard",
    title: "NIST AI 600-1 — Generative AI profile for the AI RMF",
    summary:
      "NIST AI 600-1 was published in July 2024 and is intended for voluntary use. It describes 12 risks " +
      "unique to or exacerbated by generative AI — including confabulation, data privacy, harmful bias, " +
      "information security, and value chain and component integration — and suggests actions organised " +
      "by the AI RMF functions.",
    effectiveDate: "2024-07-26",
    status: "published",
    frameworks: ["nist-ai-rmf"],
    controlRefs: [
      "nist-ai-rmf:MEASURE-2.7",
      "nist-ai-rmf:MEASURE-2.11",
      "nist-ai-rmf:MANAGE-2.4",
      "nist-ai-rmf:GOVERN-4.1",
    ],
    sourceUrl: "https://doi.org/10.6028/NIST.AI.600-1",
    verifiedOn: "2026-10-05",
  },

  // ---- ISO/IEC 42001 (voluntary) ----
  {
    key: "iso-42001-published",
    jurisdiction: "International",
    instrument: "ISO/IEC 42001:2023",
    instrumentKind: "voluntary_standard",
    title: "ISO/IEC 42001 — AI Management System standard published",
    summary:
      "ISO/IEC 42001:2023 (edition 1) was published in December 2023. It specifies requirements for " +
      "establishing, implementing, maintaining and continually improving an AI management system (AIMS) " +
      "within organisations. Adopting it, or certifying against it, is voluntary.",
    effectiveDate: "2023-12-18",
    status: "published",
    frameworks: ["iso-42001"],
    controlRefs: [
      "iso-42001:8.3-ai-system-impact-assessment",
      "iso-42001:9.1-monitoring-measurement",
      "iso-42001:A.6-ai-system-lifecycle",
      "iso-42001:5.3-roles-responsibilities",
    ],
    sourceUrl: "https://www.iso.org/standard/81230.html",
    verifiedOn: "2026-10-05",
  },

  // ---- Colorado ----
  {
    key: "colorado-ai-act-sb26-189",
    jurisdiction: "US-CO",
    instrument: "Colorado SB 26-189 (Automated Decision-Making Technology)",
    instrumentKind: "law",
    title: "Colorado SB 26-189 — Automated decision-making technology in consequential decisions",
    summary:
      "Colorado SB 26-189, signed on 14 May 2026, repeals and re-enacts the provisions of SB 24-205. Per " +
      "the bill summary, from 1 January 2027 developers of automated decision-making technology used to " +
      "materially influence a consequential decision must give deployers technical documentation. The act " +
      "also sets consumer notice, post-adverse-outcome explanation, data-correction and human-review " +
      "rights, and a 3-year record-retention duty. Before 1 January 2030 the Attorney General must give a " +
      "60-day notice and opportunity to cure.",
    effectiveDate: "2027-01-01",
    status: "upcoming",
    frameworks: ["nist-ai-rmf", "eu-ai-act"],
    controlRefs: [
      "eu-ai-act:art-9-risk-management-system",
      "eu-ai-act:art-14-human-oversight",
      "nist-ai-rmf:GOVERN-2.1",
    ],
    sourceUrl: "https://leg.colorado.gov/bills/sb26-189",
    verifiedOn: "2026-10-05",
  },

  // ---- NYC Local Law 144 ----
  {
    key: "nyc-local-law-144",
    jurisdiction: "US-NYC",
    instrument: "NYC Local Law 144 of 2021",
    instrumentKind: "law",
    title: "NYC Local Law 144 — Automated employment decision tool bias audits",
    summary:
      "NYC Local Law 144 of 2021 took effect on 1 January 2023; the Department of Consumer and Worker " +
      "Protection began enforcing the law and its rule on 5 July 2023. It prohibits employers and " +
      "employment agencies from using an automated employment decision tool (AEDT) unless the tool has " +
      "had a bias audit within one year of its use, information about the audit is publicly available, " +
      "and required notices have been given to candidates or employees.",
    effectiveDate: "2023-01-01",
    enforcementDate: "2023-07-05",
    status: "in_force",
    frameworks: ["eu-ai-act", "nist-ai-rmf"],
    controlRefs: [
      "eu-ai-act:art-10-bias-examination",
      "nist-ai-rmf:MEASURE-2.11",
      "eu-ai-act:art-14-human-oversight",
    ],
    sourceUrl: "https://legistar.council.nyc.gov/LegislationDetail.aspx?ID=4344524&GUID=B051915D-A9AC-451E-81F8-6596032FA3F9",
    verifiedOn: "2026-10-05",
  },

  // ---- EU DORA (financial sector) ----
  {
    key: "eu-dora-in-force",
    jurisdiction: "EU",
    instrument: "EU Digital Operational Resilience Act (DORA, Regulation 2022/2554)",
    instrumentKind: "law",
    title: "EU DORA — Digital operational resilience requirements for financial entities",
    summary:
      "DORA entered into force on 16 January 2023 and applies from 17 January 2025 (Art. 64). It sets " +
      "requirements for EU financial entities on ICT risk management, ICT-related incident reporting, " +
      "digital operational resilience testing and ICT third-party risk. Whether a particular AI service is " +
      "an ICT third-party service in its scope is pending legal review.",
    effectiveDate: "2025-01-17",
    status: "in_force",
    frameworks: ["eu-ai-act", "iso-27001"],
    controlRefs: [
      "nist-ai-rmf:MAP-4.1",
      "iso-27001:A.5.15",
      "soc-2:CC9.2-vendor-risk",
    ],
    sourceUrl: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32022R2554",
    verifiedOn: "2026-10-05",
  },

  // ---- CFPB guidance (withdrawn) ----
  {
    key: "cfpb-adverse-action-ai",
    jurisdiction: "US",
    instrument: "CFPB Circular 2022-03",
    instrumentKind: "guidance",
    title: "CFPB Circular 2022-03 — Adverse-action notices for complex algorithms (withdrawn)",
    summary:
      "CFPB Circular 2022-03 (released 26 May 2022; 87 FR 35864) addressed adverse-action notification " +
      "requirements for credit decisions based on complex algorithms. The CFPB withdrew it on 12 May 2025 " +
      "(90 FR 20084), and it is no longer current CFPB guidance. This entry draws no conclusion about the " +
      "underlying statutes and regulations; how they apply to a given credit model is pending legal review.",
    effectiveDate: "2022-05-26",
    withdrawnOn: "2025-05-12",
    status: "withdrawn",
    frameworks: ["eu-ai-act", "nist-ai-rmf"],
    controlRefs: [
      "eu-ai-act:art-14-human-oversight",
      "eu-ai-act:art-12-record-keeping",
      "nist-ai-rmf:GOVERN-2.1",
    ],
    sourceUrl: "https://www.consumerfinance.gov/compliance/guidance/withdrawn-guidance/",
    verifiedOn: "2026-10-05",
  },
];
