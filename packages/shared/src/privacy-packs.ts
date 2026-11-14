/**
 * ADR-0296 part 2 (P18 B2) — PRIVACY-LAW PRESETS AND PACKS: authored data on the ADR-0224 machinery.
 *
 * Four laws: the GDPR (Regulation (EU) 2016/679), the CCPA as amended by the CPRA (Cal. Civ. Code § 1798.100 ff.),
 * India's Digital Personal Data Protection Act 2023 (DPDP) and Brazil's LGPD (Lei nº 13.709/2018).
 *
 *  - A PRESET is the org settings a law suggests on the existing privacy machinery: the data-subject request period
 *    (`dsrSlaDays`), the national identifiers the PII detector looks for, and the processing limit
 *    (`privacyOpsEnabled`). `privacyPresetPatch` only ever TIGHTENS: it shortens the request period, adds identifier
 *    categories and turns the limit on; it never lengthens, removes or turns off (secure by default, ADR-0180). An
 *    admin applies the patch through the existing `PUT /v1/org/settings`, which audits it.
 *  - A PACK per law maps its articles or sections onto evidence the gateway already writes: records of processing,
 *    data-subject requests, erasures, the processing limit at dispatch, the PII cascade and the incident register.
 *
 * CITATION. Each control cites its article or section number; titles, descriptions and notes are regulAIt's own
 * words. No statutory text is reproduced (the EU legal-text licence question, P18 A5, is the owner's). Nothing here
 * is legal advice or a statement of compliance, and no pack has had a domain review.
 *
 * Imports from `compliance-packs.ts` are TYPE-ONLY: that file imports this one to append the packs.
 */
import type { CreateCompliancePackInput } from "./compliance-packs.js";
import type { InternationalPiiCategory } from "./pii-international.js";
import { DSR_DEFAULT_SLA_DAYS } from "./privacy-ops.js";
import type { TrustDimension } from "./risks.js";

type Control = CreateCompliancePackInput["controls"][number];

// ===========================================================================
// Presets
// ===========================================================================

export const PRIVACY_LAWS = ["gdpr", "ccpa", "dpdp", "lgpd"] as const;
export type PrivacyLaw = (typeof PRIVACY_LAWS)[number];

export interface PrivacyLawPreset {
  law: PrivacyLaw;
  title: string;
  /** the request period the law sets, in its own terms, with the provision */
  statutoryPeriod: string;
  /** the `dsrSlaDays` the preset sets: the statutory period or the strict default, whichever is shorter */
  dsrSlaDays: number;
  /** national identifiers the PII detector should look for under this law */
  piiInternationalCategories: readonly InternationalPiiCategory[];
  /** what the preset cannot do, in plain words */
  notes: string;
}

export const PRIVACY_LAW_PRESETS: Readonly<Record<PrivacyLaw, PrivacyLawPreset>> = {
  gdpr: {
    law: "gdpr",
    title: "GDPR — Regulation (EU) 2016/679",
    statutoryPeriod: "one month from receipt, extendable by two further months (Art. 12(3))",
    // one month; the strict default (30 days) is the shorter reading
    dsrSlaDays: DSR_DEFAULT_SLA_DAYS,
    piiInternationalCategories: ["bsn", "codice_fiscale", "dni_nie", "nir", "steuer_id"],
    notes:
      "Breach notification is the GDPR incident-clock regime (ADR-0296 part 1). The lawful bases a record of processing " +
      "offers are Art. 6(1)'s six.",
  },
  ccpa: {
    law: "ccpa",
    title: "CCPA as amended by the CPRA — Cal. Civ. Code § 1798.100 ff.",
    statutoryPeriod: "45 calendar days from receipt, extendable once by 45 (§ 1798.130(a)(2))",
    // the strict default is shorter than the statute, so the preset keeps it
    dsrSlaDays: DSR_DEFAULT_SLA_DAYS,
    piiInternationalCategories: [],
    notes:
      "The request kinds offered are access, erasure and objection; correction and opting out of sale or sharing are " +
      "handled outside the platform. The CCPA has no lawful-basis concept: a record of processing's basis is informational.",
  },
  dpdp: {
    law: "dpdp",
    title: "Digital Personal Data Protection Act 2023 (India)",
    statutoryPeriod: "a period the Act leaves to rules (s. 13(2)); the strict default applies",
    dsrSlaDays: DSR_DEFAULT_SLA_DAYS,
    piiInternationalCategories: ["aadhaar"],
    notes:
      "The Act's grounds are consent and certain legitimate uses (ss. 4, 6, 7); map them onto a record's basis as " +
      "consent or legal obligation. Breach intimation to the Board is not an encoded clock.",
  },
  lgpd: {
    law: "lgpd",
    title: "LGPD — Lei nº 13.709/2018 (Brazil)",
    statutoryPeriod: "15 days from the request for a full access statement (Art. 19, II)",
    dsrSlaDays: 15,
    piiInternationalCategories: ["cpf"],
    notes:
      "Art. 7 lists ten legal bases; map them onto the record's nearest Art. 6(1) basis. Incident communication to the " +
      "ANPD is not an encoded clock.",
  },
};

/** the settings a preset would change; every field only tightens */
export interface PrivacyPresetPatch {
  dsrSlaDays?: number;
  piiInternationalCategories?: string[];
  privacyOpsEnabled?: true;
}

/**
 * The org-settings patch that applies the presets of `laws` to `current`. Several laws combine to the strictest: the
 * shortest request period and the union of identifier categories. A field already at least as strict is left out, so
 * an empty patch means nothing would change. Never lengthens a period, removes a category or turns the limit off.
 */
export function privacyPresetPatch(
  laws: readonly PrivacyLaw[],
  current: { dsrSlaDays: number; piiInternationalCategories: readonly string[]; privacyOpsEnabled: boolean },
): PrivacyPresetPatch {
  if (laws.length === 0) return {};
  const presets = [...new Set(laws)].map((l) => PRIVACY_LAW_PRESETS[l]);
  const patch: PrivacyPresetPatch = {};
  const sla = Math.min(...presets.map((p) => p.dsrSlaDays));
  if (sla < current.dsrSlaDays) patch.dsrSlaDays = sla;
  const have = new Set(current.piiInternationalCategories);
  const add = [...new Set(presets.flatMap((p) => p.piiInternationalCategories))].filter((c) => !have.has(c));
  if (add.length) patch.piiInternationalCategories = [...current.piiInternationalCategories, ...add.sort()];
  if (!current.privacyOpsEnabled) patch.privacyOpsEnabled = true;
  return patch;
}

// ===========================================================================
// Packs
// ===========================================================================

/** the rule ids the gateway writes for privacy operations (apps/gateway/src/privacy-ops.ts, PRIVACY_RULE_IDS) */
const RECORDS = "processing-record-";
const REQUESTS_CLOSED = "data-subject-request-closed";
const ERASED = "data-subject-request-erased";
const REQUESTS = "data-subject-request-";
const LIMIT = "processing-not-permitted";

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

/** the shared controls every law has, in its own citation */
function common(fw: string, cite: { records: string; access: string; erasure: string; minimise: string; security: string }): Control[] {
  return [
    ev(`${fw}:records-of-processing`, `${cite.records} — Keep a record of each AI system's processing`, {
      coverage: "partial",
      collector: "audit_decisions",
      collectorParams: { ruleIdPrefix: RECORDS },
      evidence: "records of processing created or changed in the period.",
      note: "Records cover AI systems governed by the platform. Processing outside it is the organisation's to record.",
    }),
    ev(`${fw}:access-requests`, `${cite.access} — Answer people's requests about their data on time`, {
      coverage: "partial",
      collector: "audit_decisions",
      collectorParams: { ruleIdPrefix: REQUESTS_CLOSED },
      evidence: "data-subject requests closed in the period (each has a due date from the request period).",
      note: "Requests are located across the data the platform holds; data held elsewhere is the organisation's to search.",
    }),
    ev(`${fw}:erasure`, `${cite.erasure} — Erase a person's data when asked`, {
      coverage: "partial",
      collector: "audit_decisions",
      collectorParams: { ruleIdPrefix: ERASED },
      evidence: "erasures completed in the period.",
      note: "Erasure covers conversations and shared context; the tamper-evident audit trail is kept and tombstoned, not edited.",
    }),
    ev(`${fw}:processing-limit`, `${cite.minimise} — Send personal data only for a recorded purpose`, {
      coverage: "enforced",
      collector: "audit_decisions",
      collectorParams: { ruleIdPrefix: LIMIT },
      evidence: "dispatches refused because no record of processing permitted the personal data found.",
      note: "Enforced when the processing limit is on. It sees the categories the PII detector finds, not every kind of personal data.",
    }),
    ev(`${fw}:personal-data-blocking`, `${cite.security} — Keep personal data out of model calls by default`, {
      coverage: "partial",
      collector: "compliance_profile_cascade",
      collectorParams: { cascadeAspect: "pii_block" },
      evidence: "a compliance profile whose cascade forces PII blocking.",
      note: "Detection is pattern- and model-based at the gateway. Security of systems outside the gateway is the organisation's.",
    }),
  ];
}

const LAW_NOTE =
  "Cited by article or section number; titles and notes are regulAIt's own words. Not legal advice and not a statement " +
  "of compliance.";

const pack = (framework: PrivacyLaw, title: string, source: string, revision: string, controls: Control[]): CreateCompliancePackInput => ({
  framework,
  version: 1,
  title,
  description:
    `Maps ${PRIVACY_LAW_PRESETS[framework].title} onto the privacy operations the platform runs (records of processing, ` +
    "data-subject requests, the processing limit, PII blocking). Its preset sets the request period and identifiers.",
  provenance: { source, catalogueRevision: revision, reviewedBy: null, reviewedOn: null, note: LAW_NOTE },
  cascadeTag: null,
  controls,
});

export const GDPR_PACK = pack("gdpr", "GDPR — privacy operations (control mapping)", "Regulation (EU) 2016/679", "OJ L 119, 4.5.2016", [
  ...common("gdpr", { records: "Art. 30", access: "Art. 12(3), 15", erasure: "Art. 17", minimise: "Art. 5(1)(b)-(c)", security: "Art. 25, 32" }),
  ev("gdpr:objection", "Art. 21 — Stop processing when a person objects", {
    coverage: "partial",
    collector: "audit_decisions",
    collectorParams: { ruleIdPrefix: REQUESTS },
    evidence: "data-subject requests recorded or handled in the period, objections among them.",
    note: "An objection is recorded and tracked; stopping the processing is the organisation's action.",
  }),
  ev("gdpr:breach-notification", "Art. 33, 34 — Notify breaches on time", {
    coverage: "partial",
    collector: "incident_register",
    evidence: "incidents recorded in the period; a personal data breach starts the GDPR clocks.",
    note: "The clocks are reminders; deciding whether a breach must be notified is the controller's.",
  }),
  att("gdpr:impact-assessment", "Art. 35 — Assess high-risk processing before it starts", "unaddressed", "Not addressed by the platform: there is no impact-assessment record yet (P18 lane C1). Attest the DPIAs carried out."),
  att("gdpr:international-transfers", "Art. 44-49 — Transfer personal data abroad only on a valid basis", "partial", "Partly supported: provider region pinning and BYOC keep data in place. Attest the transfer mechanisms relied on."),
]);

export const CCPA_PACK = pack("ccpa", "CCPA/CPRA — privacy operations (control mapping)", "Cal. Civ. Code § 1798.100 ff. (CCPA as amended by the CPRA)", "as in force 2026", [
  ...common("ccpa", { records: "§ 1798.100(a)", access: "§ 1798.110, 1798.130", erasure: "§ 1798.105", minimise: "§ 1798.100(c)", security: "§ 1798.100(e)" }),
  att("ccpa:correction", "§ 1798.106 — Correct inaccurate personal information on request", "unaddressed", "Not addressed by the platform: correction is not a request kind. Attest the correction process."),
  att("ccpa:opt-out", "§ 1798.120, 1798.135 — Honour opting out of sale or sharing", "unaddressed", "Not addressed by the platform: it neither sells nor shares data for advertising. Attest how opt-outs are honoured elsewhere."),
  att("ccpa:sensitive-limit", "§ 1798.121 — Limit use of sensitive personal information on request", "partial", "Partly supported: the processing limit refuses categories no record permits. Attest how a limit request is handled."),
  ev("ccpa:breach", "§ 1798.82, 1798.150 — Notify breaches and keep reasonable security", {
    coverage: "partial",
    collector: "incident_register",
    evidence: "incidents recorded in the period.",
    note: "California breach-notice deadlines are not an encoded clock; the register records the incident and its dates.",
  }),
]);

export const DPDP_PACK = pack("dpdp", "India DPDP Act 2023 — privacy operations (control mapping)", "Digital Personal Data Protection Act, 2023 (No. 22 of 2023)", "2023 Act", [
  ...common("dpdp", { records: "s. 8(1)", access: "s. 11, 13", erasure: "s. 8(7), 12", minimise: "s. 4, 6(1)", security: "s. 8(5)" }),
  att("dpdp:notice-consent", "s. 5, 6 — Give notice and hold consent where it is the ground", "unaddressed", "Not addressed by the platform: consent is collected where the data is collected. Attest the notices and consent records."),
  ev("dpdp:breach-intimation", "s. 8(6) — Tell the Board and affected people about a breach", {
    coverage: "partial",
    collector: "incident_register",
    evidence: "incidents recorded in the period.",
    note: "Intimation to the Data Protection Board is not an encoded clock; the register records the incident and its dates.",
  }),
  att("dpdp:cross-border", "s. 16 — Transfer outside India only where not restricted", "partial", "Partly supported: provider region pinning and BYOC keep data in place. Attest the transfers made."),
]);

export const LGPD_PACK = pack("lgpd", "Brazil LGPD — privacy operations (control mapping)", "Lei nº 13.709, de 14 de agosto de 2018 (LGPD)", "as amended to 2026", [
  ...common("lgpd", { records: "Art. 37", access: "Art. 18, II; Art. 19", erasure: "Art. 18, VI", minimise: "Art. 6, III", security: "Art. 46" }),
  att("lgpd:legal-basis", "Art. 7, 11 — Process on a legal basis, with stricter bases for sensitive data", "partial", "Partly supported: each record of processing names a basis. Attest the mapping of LGPD's bases onto the records."),
  att("lgpd:impact-report", "Art. 38 — Prepare a data protection impact report when required", "unaddressed", "Not addressed by the platform: there is no impact-assessment record yet (P18 lane C1). Attest the reports prepared."),
  ev("lgpd:incident-communication", "Art. 48 — Communicate security incidents to the ANPD and the people affected", {
    coverage: "partial",
    collector: "incident_register",
    evidence: "incidents recorded in the period.",
    note: "The ANPD's deadline is not an encoded clock; the register records the incident and its dates.",
  }),
]);

export const PRIVACY_PACKS: CreateCompliancePackInput[] = [GDPR_PACK, CCPA_PACK, DPDP_PACK, LGPD_PACK];

/** trust dimensions of the privacy controls (ADR-0148): all privacy, including those an audit count evidences
 * (whose collector alone would file them under compliance) */
export const PRIVACY_PACK_DIMENSIONS: Readonly<Record<string, TrustDimension>> = Object.fromEntries(
  PRIVACY_PACKS.flatMap((p) => p.controls).map((c) => [c.controlRef, "privacy"] as const),
);
