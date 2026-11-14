/**
 * ADR-0294 (P18 B5) — THE NIST AI 600-1 PACK: authored data.
 *
 * `nist-ai-600-1@1` has one control per GAI risk of NIST AI 600-1 §2 (the
 * Generative AI Profile of the AI RMF, July 2024). Each risk's name and
 * description are NIST's own words (a US government work, public domain,
 * 17 U.S.C. 105). The coverage, collector and owner note are regulAIt's own
 * self-assessment against enforcing code, with no domain review.
 *
 * The profile's 212 suggested actions are not authored here: they are the
 * `nist-ai-600-1` import source (framework-imports-data/nist-ai-600-1.json).
 * An admin who imports it onto this pack gets a new draft version holding the
 * twelve risk controls (kept) plus every action (added unmapped), through the
 * ADR-0215 three-way merge.
 *
 * Imports from `compliance-packs.ts` are TYPE-ONLY: that file imports this one
 * to append the pack to `DEFAULT_COMPLIANCE_PACKS`.
 */
import type { CreateCompliancePackInput } from "./compliance-packs.js";

type Control = CreateCompliancePackInput["controls"][number];

export const NIST_AI_600_1_FRAMEWORK = "nist-ai-600-1";

const ref = (slug: string) => `${NIST_AI_600_1_FRAMEWORK}:risk-${slug}`;

const evidenced = (
  slug: string,
  n: number,
  name: string,
  definition: string,
  c: Pick<Control, "coverage" | "collector"> & Partial<Pick<Control, "collectorParams">> & { evidence: string; ownerNote: string },
): Control => ({
  controlRef: ref(slug),
  title: `GAI risk ${n} — ${name}`,
  description: `${definition} Evidence counted: ${c.evidence}`,
  coverage: c.coverage,
  collector: c.collector,
  collectorParams: c.collectorParams ?? {},
  minEvidenceCount: 1,
  attestationRequired: false,
  ownerNote: c.ownerNote,
});

const attested = (slug: string, n: number, name: string, definition: string, coverage: Control["coverage"], ownerNote: string): Control => ({
  controlRef: ref(slug),
  title: `GAI risk ${n} — ${name}`,
  description: definition,
  coverage,
  collector: "none",
  collectorParams: {},
  minEvidenceCount: 1,
  attestationRequired: true,
  ownerNote,
});

export const NIST_AI_600_1_CONTROLS: Control[] = [
  attested(
    "cbrn-information",
    1,
    "CBRN Information or Capabilities",
    "Eased access to or synthesis of materially nefarious information or design capabilities related to chemical, " +
      "biological, radiological, or nuclear (CBRN) weapons or other dangerous materials or agents.",
    "unaddressed",
    "Not addressed by the platform: no detector recognises CBRN content, and red-team classes do not probe for it. " +
      "Attest the model provider's CBRN safeguards and any domain evaluation the organisation runs.",
  ),
  evidenced(
    "confabulation",
    2,
    "Confabulation",
    "The production of confidently stated but erroneous or false content (known colloquially as “hallucinations” or " +
      "“fabrications”) by which users may be misled or deceived.",
    {
      coverage: "partial",
      collector: "eval_runs",
      evidence: "evaluation runs started in the period.",
      ownerNote:
        "Groundedness and faithfulness scorers measure confabulation on the organisation's own test sets; nothing checks " +
        "answers at run time. How people are told to rely on output is the organisation's.",
    },
  ),
  evidenced(
    "dangerous-violent-hateful",
    3,
    "Dangerous, Violent, or Hateful Content",
    "Eased production of and access to violent, inciting, radicalizing, or threatening content as well as " +
      "recommendations to carry out self-harm or conduct illegal activities. Includes difficulty controlling public " +
      "exposure to hateful and disparaging or stereotyping content.",
    {
      coverage: "partial",
      collector: "guardrail_configs",
      collectorParams: { detector: "toxicity", minMode: "block" },
      evidence: "configuration of a toxicity detector set to block.",
      ownerNote:
        "The toxicity detector catches what it recognises; it does not recognise every incitement or self-harm request. " +
        "Content policies of the model provider apply in addition.",
    },
  ),
  evidenced(
    "data-privacy",
    4,
    "Data Privacy",
    "Impacts due to leakage and unauthorized use, disclosure, or de-anonymization of biometric, health, location, or " +
      "other personally identifiable information or sensitive data.",
    {
      coverage: "partial",
      collector: "compliance_profile_cascade",
      collectorParams: { cascadeAspect: "pii_block" },
      evidence: "a compliance profile whose cascade forces PII blocking.",
      ownerNote:
        "PII detection is pattern- and model-based and runs at the gateway. Data a model provider retains or trains on " +
        "is governed by the organisation's contract with that provider.",
    },
  ),
  evidenced(
    "environmental-impacts",
    5,
    "Environmental Impacts",
    "Impacts due to high compute resource utilization in training or operating GAI models, and related outcomes that " +
      "may adversely impact ecosystems.",
    {
      coverage: "partial",
      collector: "energy_estimate_available",
      evidence: "model calls covered by an admin-entered energy factor (an estimate, never a measurement).",
      ownerNote:
        "Energy and emissions are estimated from admin-entered factors and recorded token counts. Training impact and " +
        "the provider's data-centre figures are the provider's.",
    },
  ),
  evidenced(
    "harmful-bias-homogenization",
    6,
    "Harmful Bias and Homogenization",
    "Amplification and exacerbation of historical, societal, and systemic biases; performance disparities between " +
      "sub-groups or languages, possibly due to non-representative training data, that result in discrimination, " +
      "amplification of biases, or incorrect presumptions about performance; undesired homogeneity that skews system " +
      "or model outputs, which may be erroneous, lead to ill-founded decision-making, or amplify harmful biases.",
    {
      coverage: "partial",
      collector: "model_card_fairness",
      evidence: "model cards documenting a completed bias or fairness assessment.",
      ownerNote:
        "The platform records that an assessment was done and where its result lives, and the bias red-team class " +
        "probes for disparity; it does not grade fairness itself.",
    },
  ),
  evidenced(
    "human-ai-configuration",
    7,
    "Human-AI Configuration",
    "Arrangements of or interactions between a human and an AI system which can result in the human inappropriately " +
      "anthropomorphizing GAI systems or experiencing algorithmic aversion, automation bias, over-reliance, or emotional " +
      "entanglement with GAI systems.",
    {
      coverage: "partial",
      collector: "approvals",
      collectorParams: { status: "approved" },
      evidence: "approvals decided by a named person in the period.",
      ownerNote:
        "Human sign-off is evidenced where a workflow or rule requires it. Over-reliance and anthropomorphising by end " +
        "users are matters of interface design and training, which the organisation attests through its literacy records.",
    },
  ),
  attested(
    "information-integrity",
    8,
    "Information Integrity",
    "Lowered barrier to entry to generate and support the exchange and consumption of content which may not " +
      "distinguish fact from opinion or fiction or acknowledge uncertainties, or could be leveraged for large-scale " +
      "dis- and mis-information campaigns.",
    "unaddressed",
    "Not addressed by the platform: there is no content provenance marking (watermarking or signed provenance) of " +
      "generated output. Attest the provenance and disclosure practice for content the organisation publishes.",
  ),
  evidenced(
    "information-security",
    9,
    "Information Security",
    "Lowered barriers for offensive cyber capabilities, including via automated discovery and exploitation of " +
      "vulnerabilities to ease hacking, malware, phishing, offensive cyber operations, or other cyberattacks; increased " +
      "attack surface for targeted cyberattacks, which may compromise a system's availability or the confidentiality or " +
      "integrity of training data, code, or model weights.",
    {
      coverage: "partial",
      collector: "guardrail_configs",
      collectorParams: { detector: "prompt_injection", minMode: "block" },
      evidence: "configuration of a prompt-injection detector set to block.",
      ownerNote:
        "Prompt injection is detected at the gateway, tool access is default-deny, and red-team classes probe injection, " +
        "exfiltration and tool abuse. Use of a model to build offensive capability is not detected. Model weights are the " +
        "provider's to protect.",
    },
  ),
  attested(
    "intellectual-property",
    10,
    "Intellectual Property",
    "Eased production or replication of alleged copyrighted, trademarked, or licensed content without authorization " +
      "(possibly in situations which do not fall under fair use); eased exposure of trade secrets; or plagiarism or " +
      "illegal replication.",
    "unaddressed",
    "Not addressed by the platform: output is not checked against copyrighted works. Trade-secret exposure is partly " +
      "reduced by the data-loss detector. Attest the organisation's policy and any provider indemnity relied on.",
  ),
  attested(
    "obscene-degrading-abusive",
    11,
    "Obscene, Degrading, and/or Abusive Content",
    "Eased production of and access to obscene, degrading, and/or abusive imagery which can cause harm, including " +
      "synthetic child sexual abuse material (CSAM), and nonconsensual intimate images (NCII) of adults.",
    "partial",
    "Partly met: the toxicity detector screens text, but the platform does not screen generated images. Attest the " +
      "image-generation providers' safeguards and the organisation's reporting process.",
  ),
  evidenced(
    "value-chain-component-integration",
    12,
    "Value Chain and Component Integration",
    "Non-transparent or untraceable integration of upstream third-party components, including data that has been " +
      "improperly obtained or not processed and cleaned due to increased automation from GAI; improper supplier vetting " +
      "across the AI lifecycle; or other issues that diminish transparency or accountability for downstream users.",
    {
      coverage: "partial",
      collector: "model_cards_approved",
      evidence: "approved, unexpired model cards.",
      ownerNote:
        "Models and providers are registered and approved before use, MCP server releases are pinned and quarantined, " +
        "and data lineage is recorded. How upstream training data was obtained is the provider's.",
    },
  ),
];

export const NIST_AI_600_1_PACK: CreateCompliancePackInput = {
  framework: NIST_AI_600_1_FRAMEWORK,
  version: 1,
  title: "NIST AI 600-1 — Generative AI Profile: the twelve GAI risks (control mapping)",
  description:
    "One control per GAI risk of NIST AI 600-1 §2, mapped onto platform evidence. The profile's suggested actions are " +
    "importable onto this pack from the vendored NIST text (ADR-0294). A mapping is not conformity with the profile.",
  provenance: {
    source: "NIST AI 600-1, Artificial Intelligence Risk Management Framework: Generative Artificial Intelligence Profile",
    catalogueRevision: "July 2024 (https://doi.org/10.6028/NIST.AI.600-1)",
    reviewedBy: null,
    reviewedOn: null,
    note:
      "Risk names and descriptions are NIST's text (US government work, public domain). Coverage and collectors are " +
      "regulAIt's own self-assessment.",
  },
  cascadeTag: null,
  controls: NIST_AI_600_1_CONTROLS,
};
