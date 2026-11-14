/**
 * ADR-0297 (P18 B6) — SECTOR PACKS: authored data.
 *
 *  - `sr-11-7@1`: the US banking supervisors' model risk management guidance (Federal Reserve SR 11-7 with OCC
 *    Bulletin 2011-12, "Supervisory Guidance on Model Risk Management", 4 April 2011), mapped onto the ADR-0045 model
 *    risk registry (model cards, approvals and their recertification) and the evaluation evidence.
 *  - `nyc-ll144@1`: New York City Local Law 144 of 2021 on automated employment decision tools (NYC Admin. Code
 *    §§ 20-870 to 20-874) with its rules (6 RCNY §§ 5-300 to 5-304), mapped onto the ADR-0222 fairness runs, which
 *    compute each group's selection rate and the impact ratio the rules define.
 *
 * CITATION. Each control cites its section of the guidance or the code; titles and notes are regulAIt's own words.
 * SR 11-7 is a US government work (public domain) and the city's law is public, but no text is reproduced here
 * either. Nothing is legal advice or a statement of compliance; no pack has had a domain review.
 *
 * Imports from `compliance-packs.ts` are TYPE-ONLY: that file imports this one to append the packs.
 */
import type { CreateCompliancePackInput } from "./compliance-packs.js";
import type { TrustDimension } from "./risks.js";

type Control = CreateCompliancePackInput["controls"][number];

const ev = (
  controlRef: string,
  title: string,
  e: Pick<Control, "coverage" | "collector"> & Partial<Pick<Control, "collectorParams">> & { evidence: string; note: string },
): Control => ({
  controlRef,
  title,
  description: `Evidence counted: ${e.evidence}`,
  coverage: e.coverage,
  collector: e.collector,
  collectorParams: e.collectorParams ?? {},
  minEvidenceCount: 1,
  attestationRequired: false,
  ownerNote: e.note,
});

const att = (controlRef: string, title: string, coverage: Control["coverage"], ownerNote: string): Control => ({
  controlRef,
  title,
  coverage,
  collector: "none",
  collectorParams: {},
  minEvidenceCount: 1,
  attestationRequired: true,
  ownerNote,
});

const NOTE =
  "Cited by section; titles and notes are regulAIt's own words. Not legal or supervisory advice and not a statement " +
  "of compliance.";

// ===========================================================================
// SR 11-7 / OCC 2011-12 — model risk management
// ===========================================================================

const sr = (slug: string) => `sr-11-7:${slug}`;

export const SR_11_7_CONTROLS: Control[] = [
  att(sr("iv-development"), "IV — Develop models with a documented purpose, design, data and testing", "partial", "Partly supported: model cards record purpose, intended use and limits. Attest the development documentation, including data suitability and developer testing."),
  att(sr("iv-implementation-use"), "IV — Implement models correctly and use them within their limits", "partial", "Partly supported: the gateway serves only registered, approved models to entitled users. Attest how limits on use are communicated and kept to."),
  att(sr("v-conceptual-soundness"), "V.1 — Evaluate the model's design and theory before use", "partial", "Partly supported: evaluation runs measure a model on the organisation's test sets. Attest the review of design, assumptions and data."),
  ev(sr("v-ongoing-monitoring"), "V.2 — Monitor the model in use to confirm it still performs as intended", {
    coverage: "partial",
    collector: "eval_runs",
    evidence: "evaluation runs started in the period.",
    note: "Re-running evaluations and the served-model drift check catch change; monitoring of the business outcome is the organisation's.",
  }),
  att(sr("v-outcomes-analysis"), "V.3 — Compare model outputs with actual outcomes", "partial", "Partly supported: evaluation and fairness runs compare predictions with labelled outcomes the organisation supplies. Attest back-testing done elsewhere."),
  ev(sr("v-effective-challenge"), "V — Have models challenged and approved by people independent of their development", {
    coverage: "partial",
    collector: "model_cards_approved",
    evidence: "approved, unexpired model cards.",
    note: "A model card is approved by a named person; whether that person is independent of the developers is the organisation's to ensure and attest.",
  }),
  ev(sr("vi-model-inventory"), "VI — Keep a firm-wide inventory of models in use", {
    coverage: "evidenced",
    collector: "model_cards_approved",
    evidence: "approved model cards in the registry.",
    note: "The registry covers models reached through the platform. Models used outside it are the organisation's to inventory.",
  }),
  ev(sr("vi-periodic-review"), "VI — Review each model at least once a year", {
    coverage: "enforced",
    collector: "model_cards_approved",
    evidence: "unexpired model card approvals (an approval expires, which forces re-approval).",
    note: "Recertification is enforced by expiry, and the optional dispatch gate refuses a model whose approval lapsed.",
  }),
  att(sr("vi-policies-procedures"), "VI — Set model risk policies and procedures", "unaddressed", "Organisational: the platform does not address this. Attest the model risk management policy."),
  att(sr("vi-roles-responsibilities"), "VI — Assign model owners, developers, validators and users", "partial", "Partly supported: model cards name an owner and approvers. Attest the role definitions and the board's oversight."),
  att(sr("vi-internal-audit"), "VI — Have internal audit assess the model risk framework", "partial", "Partly supported: time-boxed auditor access and signed evidence exports serve an audit. Attest the audit and its findings."),
  ev(sr("vi-vendor-models"), "VI — Bring vendor and third-party models into the same framework", {
    coverage: "partial",
    collector: "model_cards_approved",
    evidence: "approved model cards, which include third-party models and providers.",
    note: "A vendor model is registered and approved like any other; the vendor's own development evidence is the organisation's to obtain.",
  }),
  att(sr("vi-documentation"), "VI — Document models well enough for someone unfamiliar to understand them", "partial", "Partly supported: model cards hold the documentation the platform needs. Attest documentation kept elsewhere."),
];

export const SR_11_7_PACK: CreateCompliancePackInput = {
  framework: "sr-11-7",
  version: 1,
  title: "SR 11-7 / OCC 2011-12 — model risk management (control mapping)",
  description:
    "Maps the supervisory guidance on model risk management onto the model risk registry: model cards, their approval " +
    "and recertification, and evaluation evidence. A mapping is not a supervisory finding.",
  provenance: {
    source: "Board of Governors of the Federal Reserve System SR 11-7 and OCC Bulletin 2011-12",
    catalogueRevision: "4 April 2011",
    reviewedBy: null,
    reviewedOn: null,
    note: NOTE,
  },
  cascadeTag: null,
  controls: SR_11_7_CONTROLS,
};

// ===========================================================================
// NYC Local Law 144 — automated employment decision tools
// ===========================================================================

const ll = (slug: string) => `nyc-ll144:${slug}`;

export const NYC_LL144_CONTROLS: Control[] = [
  ev(ll("bias-audit"), "§ 20-871(a)(1) — Have the tool bias-audited within the year before it is used", {
    coverage: "partial",
    collector: "model_card_fairness",
    evidence: "model cards documenting a completed fairness assessment.",
    note:
      "A fairness run computes the selection rate of each group and the impact ratio from the organisation's labelled " +
      "data. The law requires the audit to be done by an independent auditor and repeated within a year; attest both.",
  }),
  att(
    ll("impact-ratios"),
    "6 RCNY § 5-301 — Report impact ratios by sex, by race and ethnicity, and for their intersections",
    "partial",
    "Partly supported: fairness runs compute impact ratios for every attribute in the dataset, including a combined " +
      "sex-by-race attribute; groups below the minimum size are suppressed. Attest that the audit covered the required " +
      "categories and how small categories were handled.",
  ),
  att(ll("published-summary"), "§ 20-871(a)(2) — Publish a summary of the latest bias audit and the tool's distribution date", "unaddressed", "Not addressed by the platform: publication is on the employer's website. Attest the published summary and its date."),
  att(ll("candidate-notice"), "§ 20-871(b)(1) — Tell candidates and employees that the tool is used, ahead of its use", "unaddressed", "Not addressed by the platform. Attest the notice, its timing and the alternative process offered."),
  att(ll("qualifications-notice"), "§ 20-871(b)(2) — Tell candidates which qualifications and characteristics the tool assesses", "unaddressed", "Not addressed by the platform. Attest the notice."),
  att(ll("data-notice"), "§ 20-871(b)(3) — Disclose the type and source of data collected and the retention policy", "partial", "Partly supported: a record of processing holds the data categories and retention for the tool. Attest the disclosure made to candidates."),
  ev(ll("tool-registered"), "§ 20-870 — Know which tools are automated employment decision tools", {
    coverage: "partial",
    collector: "model_cards_approved",
    evidence: "approved model cards (an employment tool is registered and approved before use).",
    note: "Whether a tool substantially assists an employment decision is the employer's determination; attest the classification.",
  }),
];

export const NYC_LL144_PACK: CreateCompliancePackInput = {
  framework: "nyc-ll144",
  version: 1,
  title: "NYC Local Law 144 — automated employment decision tools (control mapping)",
  description:
    "Maps the city's bias-audit and notice duties onto fairness runs and the model registry. Most duties are the " +
    "employer's and are attested. A mapping is not a bias audit.",
  provenance: {
    source: "NYC Admin. Code §§ 20-870 to 20-874 (Local Law 144 of 2021) and 6 RCNY §§ 5-300 to 5-304",
    catalogueRevision: "rules effective 5 July 2023",
    reviewedBy: null,
    reviewedOn: null,
    note: NOTE,
  },
  cascadeTag: null,
  controls: NYC_LL144_CONTROLS,
};

export const SECTOR_PACKS: CreateCompliancePackInput[] = [SR_11_7_PACK, NYC_LL144_PACK];

/** trust dimensions of the sector controls (ADR-0148): SR 11-7 is reliability; LL144's audit is bias, its notices compliance */
export const SECTOR_PACK_DIMENSIONS: Readonly<Record<string, TrustDimension>> = Object.fromEntries([
  ...SR_11_7_CONTROLS.map((c) => [c.controlRef, "reliability"] as const),
  ...NYC_LL144_CONTROLS.map((c) => [c.controlRef, /:(bias-audit|impact-ratios)$/.test(c.controlRef) ? "bias" : "compliance"] as const),
]);
