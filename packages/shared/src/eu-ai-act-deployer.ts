/**
 * ADR-0351 slice 2 — THE EU AI ACT DEPLOYER-OBLIGATION REGISTER: a compliance pack plus one declared lifecycle.
 *
 * `eu-ai-act-deployer@1` maps the duties Regulation (EU) 2024/1689 places on a DEPLOYER of an AI system (Art. 26,
 * with Art. 4, 27, 49(3), 50(3), 50(4), 73 and 86 where they bind a deployer) onto the existing pack format (ADR-0058).
 * It is not a new framework mechanism: the register route reads the active pack's ordinary evaluation and adds a
 * typed view.
 *
 * EACH DUTY HAS ONE BASIS.
 *  - `observed`: a real collector over a ledger the platform already keeps evidences it. The register links to that
 *    evidence. A person cannot attest an observed duty (the pack route refuses it, 409), so a statement never stands
 *    in for what the system can see.
 *  - `attested`: only a person can confirm it. The register shows who attested, when, the evidence reference and the
 *    review date. An attestation always carries a review date, at most `DEPLOYER_REVIEW_MAX_DAYS` ahead.
 *
 * WORDING. The Regulation is EU law and may be reused, but every title and note here is regulAIt's own short
 * description; read the article for the duty itself. Article numbers follow the Official Journal text of 12 July 2024,
 * and Art. 4 the text that Regulation (EU) 2026/1744 substituted (as the `eu-ai-act@3` pack does).
 * An observed duty is evidence that a control ran, not a legal finding that the duty is met.
 *
 * Imports from `compliance-packs.ts` are TYPE-ONLY: that file imports this one to append the pack.
 */
import { z } from "zod";
import type { CreateCompliancePackInput } from "./compliance-packs.js";
import { attestedControl as att, evidencedControl as ev } from "./pack-builders.js";
import type { TrustDimension } from "./risks.js";

export const EU_AI_ACT_DEPLOYER_FRAMEWORK = "eu-ai-act-deployer";
const ref = (slug: string) => `${EU_AI_ACT_DEPLOYER_FRAMEWORK}:${slug}`;

export const EU_AI_ACT_DEPLOYER_CONTROLS: CreateCompliancePackInput["controls"] = [
  // --- observed: a collector over an existing ledger ----------------------------------------------------------------
  ev(ref("art-26-1-use-per-instructions"), "Art. 26(1) — Use the system as the provider's instructions for use say", {
    coverage: "partial",
    collector: "model_cards_approved",
    evidence: "model cards with an unexpired sign-off, which record each model's intended use",
    note: "The sign-off records the intended use. The technical and organisational measures that keep use within it are the deployer's own.",
  }),
  ev(ref("art-26-2-human-oversight"), "Art. 26(2) — Human oversight by people with the competence and authority to intervene", {
    coverage: "partial",
    collector: "approvals",
    collectorParams: { status: "approved" },
    evidence: "approvals decided by a named person in the period",
    note: "Approvals show oversight happening. Choosing competent, trained overseers and giving them authority is the deployer's own.",
  }),
  ev(ref("art-26-5-monitor-operation"), "Art. 26(5) — Monitor the system's operation and act on what is found", {
    coverage: "partial",
    collector: "audit_decisions",
    collectorParams: { effect: "deny" },
    evidence: "governed calls refused at runtime in the period, which show operation is monitored and acted on",
    note: "Runtime refusals are monitoring evidence. Informing the provider and suspending use when a risk appears is attested separately (Art. 73 item).",
  }),
  ev(ref("art-26-6-keep-logs"), "Art. 26(6) — Keep the automatically generated logs for at least six months", {
    coverage: "enforced",
    collector: "compliance_profile_cascade",
    collectorParams: { cascadeAspect: "retention" },
    evidence: "compliance profiles whose cascade forces an audit-retention floor",
    note: "The retention floor is configuration the platform enforces. Logs kept outside the platform are the deployer's own.",
  }),
  ev(ref("art-4-ai-literacy"), "Art. 4 (as replaced by Regulation (EU) 2026/1744) — Measures support the AI literacy of staff and others operating the system", {
    coverage: "partial",
    collector: "literacy_acknowledgements",
    evidence: "acknowledgements and completions of published AI policy and training documents in the period",
    note: "Acknowledgements are evidence of literacy measures. Article 4 does not require any specific level of literacy, and this counts none.",
  }),
  // --- attested: only a person can confirm it ---------------------------------------------------------------------
  att(ref("art-26-1-technical-organisational-measures"), "Art. 26(1) — Technical and organisational measures for use per the instructions", "unaddressed",
    "Attest the measures in place (procedures, access, training) with a reference to where they are documented."),
  att(ref("art-26-4-input-data"), "Art. 26(4) — Input data under the deployer's control is relevant and representative for the intended purpose", "unaddressed",
    "Attest how input data is checked for relevance and representativeness, with a reference to the check."),
  att(ref("art-26-5-inform-and-suspend"), "Art. 26(5) and Art. 73 — Inform the provider and authorities of a risk or serious incident, and suspend use", "partial",
    "The incident register records incidents. Attest the procedure for informing the provider, importer or distributor and the market surveillance authority, and for suspending use."),
  att(ref("art-26-7-inform-workers"), "Art. 26(7) — Inform workers' representatives and affected workers before workplace use", "unaddressed",
    "Applies to an employer putting a high-risk system into use at the workplace. Attest when and how workers were informed."),
  att(ref("art-26-8-eu-database-registration"), "Art. 26(8) and Art. 49(3) — Public-authority deployers register their use in the EU database", "unaddressed",
    "Applies to public authorities and Union bodies. Attest the registration with its database reference, or that the duty does not apply."),
  att(ref("art-26-9-dpia"), "Art. 26(9) — Use the provider's information for the data protection impact assessment", "unaddressed",
    "Attest the DPIA under GDPR Art. 35 or Directive 2016/680 Art. 27, with a reference to it."),
  att(ref("art-26-10-post-remote-biometric-authorisation"), "Art. 26(10) — Authorisation for post-remote biometric identification in criminal investigations", "unaddressed",
    "Applies only to law-enforcement use of post-remote biometric identification. Attest the authorisation, or that the duty does not apply."),
  att(ref("art-26-11-inform-affected-persons"), "Art. 26(11) — Tell people they are subject to a decision a high-risk system helps make", "unaddressed",
    "Applies to Annex III systems that make or assist decisions about people. Attest how and where people are informed."),
  att(ref("art-26-12-cooperate-with-authorities"), "Art. 26(12) — Cooperate with the competent authorities", "unaddressed",
    "Attest the contact point and the procedure for answering a competent authority."),
  att(ref("art-27-fria"), "Art. 27 — Fundamental rights impact assessment before first use", "unaddressed",
    "Applies to public bodies, private entities providing public services, and credit-scoring and life or health insurance uses. Attest the assessment and its notification to the market surveillance authority."),
  att(ref("art-50-3-emotion-biometric-notice"), "Art. 50(3) — Tell exposed people about emotion recognition or biometric categorisation", "unaddressed",
    "Applies only where such a system is deployed. Attest the notice, or that the duty does not apply."),
  att(ref("art-50-4-deep-fake-disclosure"), "Art. 50(4) — Disclose deep fakes and AI-generated text published on matters of public interest", "unaddressed",
    "Attest the disclosure practice, or that the duty does not apply."),
  att(ref("art-86-explanation-on-request"), "Art. 86 — Give an affected person a clear explanation of the system's role on request", "partial",
    "The feedback and appeal channel can receive requests. Attest the procedure for answering one with an explanation."),
];

export const EU_AI_ACT_DEPLOYER_PACK: CreateCompliancePackInput = {
  framework: EU_AI_ACT_DEPLOYER_FRAMEWORK,
  version: 1,
  title: "EU AI Act — deployer obligations register (Art. 26 and related)",
  description:
    "Each duty of a deployer is one item: observed (a platform collector evidences it, with a link to the evidence) or " +
    "attested (a named person confirms it, with an evidence reference and a review date). A control-mapping report, " +
    "not a legal opinion or a conformity statement.",
  provenance: {
    source:
      "Regulation (EU) 2024/1689 (AI Act), Official Journal of 12 July 2024: Art. 26, 27, 49(3), 50(3), 50(4), 73, 86; " +
      "Art. 4 as replaced by Regulation (EU) 2026/1744 (OJ 24 July 2026)",
    catalogueRevision: "OJ L 2024/1689 (12 July 2024) as amended by OJ L 2026/1744 (24 July 2026)",
    reviewedBy: null,
    reviewedOn: null,
    note: "regulAIt's own wording; no legal review. Read the article for the duty itself.",
  },
  cascadeTag: null,
  controls: EU_AI_ACT_DEPLOYER_CONTROLS,
};

export const EU_AI_ACT_DEPLOYER_PACKS: CreateCompliancePackInput[] = [EU_AI_ACT_DEPLOYER_PACK];

/** the attestation-only items' trust dimension (ADR-0148: a `none` collector says nothing about subject matter) */
export const EU_AI_ACT_DEPLOYER_DIMENSIONS: Readonly<Record<string, TrustDimension>> = Object.fromEntries(
  EU_AI_ACT_DEPLOYER_CONTROLS.filter((c) => c.collector === "none").map((c) => [
    c.controlRef,
    (c.controlRef.includes("dpia") || c.controlRef.includes("biometric") ? "privacy" : "compliance") as TrustDimension,
  ]),
);

// ===========================================================================
// THE LIFECYCLE — one declared table, enforced by the server, read by the UI and agents
// ===========================================================================

export const DEPLOYER_ITEM_BASES = ["observed", "attested"] as const;
export type DeployerItemBasis = (typeof DEPLOYER_ITEM_BASES)[number];

export const DEPLOYER_ITEM_STATES = ["open", "observed", "attested", "review_due"] as const;
export type DeployerItemState = (typeof DEPLOYER_ITEM_STATES)[number];

export const DEPLOYER_ITEM_EVENTS = ["evidence_found", "evidence_lost", "attest", "review_date_passed"] as const;
export type DeployerItemEvent = (typeof DEPLOYER_ITEM_EVENTS)[number];

export interface DeployerItemTransition {
  basis: DeployerItemBasis;
  from: DeployerItemState;
  event: DeployerItemEvent;
  to: DeployerItemState;
  /** who causes it: the system's evaluation, a person's action, or the clock */
  by: "system" | "person" | "clock";
}

/** every allowed transition; anything not listed is refused */
export const DEPLOYER_ITEM_TRANSITIONS: readonly DeployerItemTransition[] = Object.freeze([
  { basis: "observed", from: "open", event: "evidence_found", to: "observed", by: "system" },
  { basis: "observed", from: "observed", event: "evidence_lost", to: "open", by: "system" },
  { basis: "attested", from: "open", event: "attest", to: "attested", by: "person" },
  { basis: "attested", from: "attested", event: "attest", to: "attested", by: "person" },
  { basis: "attested", from: "review_due", event: "attest", to: "attested", by: "person" },
  { basis: "attested", from: "attested", event: "review_date_passed", to: "review_due", by: "clock" },
]);

/** the transition, or null when the table does not allow it */
export function deployerItemTransition(basis: DeployerItemBasis, from: DeployerItemState, event: DeployerItemEvent): DeployerItemTransition | null {
  return DEPLOYER_ITEM_TRANSITIONS.find((t) => t.basis === basis && t.from === from && t.event === event) ?? null;
}

/** an attestation is valid until its review date; a duty is never attested open-ended */
export const DEPLOYER_REVIEW_MAX_DAYS = 366;

/**
 * The state an item is in now, derived from its evaluation. Observed: evidence at or above the threshold is
 * `observed`, else `open`. Attested: the newest attestation decides (none = `open`, review date passed =
 * `review_due`, else `attested`). Each state is reachable only by a transition in the table above.
 */
export function deployerItemState(
  basis: DeployerItemBasis,
  input: { evidenceCount: number | null; minEvidenceCount: number; latestAttestation: { reviewDate: string | null } | null },
  now: Date,
): DeployerItemState {
  if (basis === "observed") return (input.evidenceCount ?? 0) >= input.minEvidenceCount ? "observed" : "open";
  const a = input.latestAttestation;
  if (!a) return "open";
  if (a.reviewDate == null || new Date(a.reviewDate).getTime() <= now.getTime()) return "review_due";
  return "attested";
}

/** what a person sends to attest an item: a statement, where the evidence is, and when it must be reviewed */
export const deployerAttestSchema = z
  .object({
    controlRef: z.string().min(1).max(200),
    statement: z.string().trim().min(1).max(4000),
    evidenceRef: z.string().trim().min(1).max(600),
    reviewDate: z.string().datetime(),
  })
  .strict();
export type DeployerAttestInput = z.infer<typeof deployerAttestSchema>;
