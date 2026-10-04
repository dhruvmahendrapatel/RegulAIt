/**
 * ADR-0175 (A1) — THE 72 NIST AI RMF 1.0 SUBCATEGORIES, checked in.
 *
 * Source: NIST AI 100-1, "Artificial Intelligence Risk Management Framework
 * (AI RMF 1.0)", Tables 1–4 (GOVERN, MAP, MEASURE, MANAGE). Every id below was
 * extracted from the PDF's tables and the count checked against it on
 * 2026-10-04: GOVERN 19, MAP 18, MEASURE 22, MANAGE 13 — 72 in all.
 *
 * The titles are SHORT PARAPHRASES for labels and review, not the framework's
 * text. Read the publication for the actual wording.
 *
 * Why this file exists: the first two versions of the `nist-ai-rmf` pack cited
 * GOVERN 1.2 for accountability (it is GOVERN 2.1) and MANAGE 2.2 for
 * deactivation (it is MANAGE 2.4), and the wrong ids spread to intake
 * suggestions, the demo library and a model card. `nist-ai-rmf-refs.test.ts`
 * scans the repository against this list so an id that does not exist, a
 * consumer pointing at a superseded mapping, or a label that does not match
 * its id fails a test instead of reaching a customer.
 */

export type NistAiRmfFunction = "GOVERN" | "MAP" | "MEASURE" | "MANAGE";

export interface NistAiRmfSubcategory {
  /** canonical form used in pack controlRefs: `GOVERN-1.1` (pack ref `nist-ai-rmf:GOVERN-1.1`) */
  id: string;
  fn: NistAiRmfFunction;
  /** short paraphrase, never the framework's own sentence */
  title: string;
}

const s = (id: string, title: string): NistAiRmfSubcategory => ({
  id,
  fn: id.split("-")[0] as NistAiRmfFunction,
  title,
});

export const NIST_AI_RMF_SUBCATEGORIES: readonly NistAiRmfSubcategory[] = [
  // GOVERN (Table 1)
  s("GOVERN-1.1", "Legal and regulatory requirements understood and documented"),
  s("GOVERN-1.2", "Trustworthy-AI characteristics built into policies and practice"),
  s("GOVERN-1.3", "Risk-management effort scaled to risk tolerance"),
  s("GOVERN-1.4", "Risk-management process set by transparent policies and controls"),
  s("GOVERN-1.5", "Ongoing monitoring and periodic review planned, with owners and frequency"),
  s("GOVERN-1.6", "Inventory of AI systems"),
  s("GOVERN-1.7", "Safe decommissioning and phase-out of AI systems"),
  s("GOVERN-2.1", "Roles, responsibilities and lines of communication documented"),
  s("GOVERN-2.2", "AI risk-management training for personnel and partners"),
  s("GOVERN-2.3", "Executive leadership responsible for AI risk decisions"),
  s("GOVERN-3.1", "Decisions informed by a diverse, interdisciplinary team"),
  s("GOVERN-3.2", "Roles for human-AI configurations and oversight defined"),
  s("GOVERN-4.1", "Critical-thinking, safety-first culture"),
  s("GOVERN-4.2", "Teams document and communicate risks and impacts"),
  s("GOVERN-4.3", "Practices for AI testing, incident identification and information sharing"),
  s("GOVERN-5.1", "Feedback from people outside the team collected and integrated"),
  s("GOVERN-5.2", "Adjudicated feedback regularly incorporated into design"),
  s("GOVERN-6.1", "Third-party AI risk policies, including intellectual property"),
  s("GOVERN-6.2", "Contingency processes for high-risk third-party failures"),
  // MAP (Table 2)
  s("MAP-1.1", "Intended purpose, context, users and setting documented"),
  s("MAP-1.2", "Interdisciplinary actors and their participation documented"),
  s("MAP-1.3", "Organisational mission and AI goals documented"),
  s("MAP-1.4", "Business value or context of use defined or re-evaluated"),
  s("MAP-1.5", "Organisational risk tolerances determined and documented"),
  s("MAP-1.6", "System requirements elicited, socio-technical implications considered"),
  s("MAP-2.1", "Tasks and methods the system uses defined"),
  s("MAP-2.2", "Knowledge limits and human use and oversight of output documented"),
  s("MAP-2.3", "Scientific integrity and TEVV considerations documented"),
  s("MAP-3.1", "Potential benefits examined and documented"),
  s("MAP-3.2", "Potential costs of errors examined and documented"),
  s("MAP-3.3", "Targeted application scope specified and documented"),
  s("MAP-3.4", "Operator and practitioner proficiency processes defined"),
  s("MAP-3.5", "Human oversight processes defined, assessed and documented"),
  s("MAP-4.1", "Technology and legal risks of components, incl. third-party, mapped"),
  s("MAP-4.2", "Internal risk controls for components, incl. third-party AI, documented"),
  s("MAP-5.1", "Likelihood and magnitude of each impact identified"),
  s("MAP-5.2", "Regular engagement and impact feedback practices in place"),
  // MEASURE (Table 3)
  s("MEASURE-1.1", "Metrics chosen for the most significant risks; unmeasured risks documented"),
  s("MEASURE-1.2", "Metric appropriateness and control effectiveness reassessed"),
  s("MEASURE-1.3", "Independent internal or external assessors involved"),
  s("MEASURE-2.1", "Test sets, metrics and TEVV tools documented"),
  s("MEASURE-2.2", "Human-subject evaluations meet requirements and are representative"),
  s("MEASURE-2.3", "Performance measured in deployment-like conditions"),
  s("MEASURE-2.4", "Functionality and behaviour monitored in production"),
  s("MEASURE-2.5", "Validity and reliability demonstrated; generalisation limits documented"),
  s("MEASURE-2.6", "Safety risks evaluated regularly; fails safely"),
  s("MEASURE-2.7", "Security and resilience evaluated and documented"),
  s("MEASURE-2.8", "Transparency and accountability risks examined"),
  s("MEASURE-2.9", "Model explained and validated; output interpreted in context"),
  s("MEASURE-2.10", "Privacy risk examined and documented"),
  s("MEASURE-2.11", "Fairness and bias evaluated and results documented"),
  s("MEASURE-2.12", "Environmental impact and sustainability assessed"),
  s("MEASURE-2.13", "Effectiveness of TEVV metrics and processes evaluated"),
  s("MEASURE-3.1", "Existing, unanticipated and emergent risks tracked"),
  s("MEASURE-3.2", "Risk tracking where measurement is not yet possible"),
  s("MEASURE-3.3", "End-user feedback and appeal processes established"),
  s("MEASURE-4.1", "Measurement connected to deployment context and domain experts"),
  s("MEASURE-4.2", "Trustworthiness results validated with domain experts and AI actors"),
  s("MEASURE-4.3", "Performance improvements or declines identified and documented"),
  // MANAGE (Table 4)
  s("MANAGE-1.1", "Decision on whether the system meets its purpose and should proceed"),
  s("MANAGE-1.2", "Treatment of documented risks prioritised"),
  s("MANAGE-1.3", "Responses to high-priority risks planned and documented"),
  s("MANAGE-1.4", "Negative residual risks documented"),
  s("MANAGE-2.1", "Resources and non-AI alternatives considered"),
  s("MANAGE-2.2", "Mechanisms to sustain the value of deployed systems"),
  s("MANAGE-2.3", "Procedures to respond to and recover from newly identified risks"),
  s("MANAGE-2.4", "Mechanisms and owners to supersede, disengage or deactivate systems"),
  s("MANAGE-3.1", "Third-party risks and benefits monitored, controls applied"),
  s("MANAGE-3.2", "Pre-trained models monitored as part of maintenance"),
  s("MANAGE-4.1", "Post-deployment monitoring plans implemented"),
  s("MANAGE-4.2", "Continual-improvement activities built into updates"),
  s("MANAGE-4.3", "Incidents and errors communicated, tracked and recovered from"),
];

const BY_ID = new Map(NIST_AI_RMF_SUBCATEGORIES.map((x) => [x.id, x]));

/** accepts `GOVERN-1.1`, `GOVERN 1.1` or `nist-ai-rmf:GOVERN-1.1` */
export function normaliseNistAiRmfId(ref: string): string {
  return ref.replace(/^nist-ai-rmf:/, "").trim().replace(/\s+/, "-").toUpperCase();
}

export function isNistAiRmfSubcategory(ref: string): boolean {
  return BY_ID.has(normaliseNistAiRmfId(ref));
}

export function nistAiRmfSubcategory(ref: string): NistAiRmfSubcategory | undefined {
  return BY_ID.get(normaliseNistAiRmfId(ref));
}

/**
 * A human-readable standard reference, e.g. for a model card:
 * `NIST AI RMF 1.0 — MAP 1.1 (Intended purpose, context, users and setting documented)`.
 * Throws on an id that is not one of the 72, so a typo cannot reach a record.
 */
export function nistAiRmfLabel(ref: string): string {
  const sub = nistAiRmfSubcategory(ref);
  if (!sub) throw new Error(`'${ref}' is not a NIST AI RMF 1.0 subcategory`);
  return `NIST AI RMF 1.0 — ${sub.id.replace("-", " ")} (${sub.title})`;
}
