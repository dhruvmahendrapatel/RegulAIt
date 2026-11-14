/**
 * ADR-0295 (P18 B4) — THE ISO/IEC ID-ONLY PACKS: authored data.
 *
 *  - `iso-42001@2`: ISO/IEC 42001:2023 widened from four controls to every
 *    requirement clause (4 to 10) and all 38 Annex A controls.
 *  - `iso-23894@1`: ISO/IEC 23894:2023 (AI risk management guidance), its
 *    framework (clause 5) and process (clause 6) subclauses.
 *  - `iso-42005@1`: ISO/IEC 42005:2025 (AI system impact assessment), its
 *    process (clause 5) and documentation (clause 6) subclauses.
 *
 * LICENCE (ADR-0176, ADR-0215 decision 2). ISO/IEC standards are copyrighted
 * and sold; they are cited BY IDENTIFIER ONLY. Each title starts with the
 * standard and clause number; the rest of every title, description and owner
 * note is regulAIt's own wording. No ISO heading, requirement or note is
 * reproduced; read the standard for that. Clause numbers were checked against
 * each standard's published table of contents.
 *
 * WHY v1 IS NOT EDITED. `iso-42001@1` cites its impact-assessment control as
 * `8.3-…`; in ISO/IEC 42001:2023 that assessment is 8.4 (8.3 is risk
 * treatment). A published version is never edited (ADR-0058), and other data
 * still cites the v1 ref, so v2 carries the correct `8.4-…` ref, adds 8.3 as
 * risk treatment, and the ADR-0087 diff shows the renumbering to the admin.
 * v1's other three controls are carried into v2 unchanged.
 *
 * HONEST COVERAGE. Most of a management-system standard is organisational:
 * those controls are attestation-required and say what to attest. Where a
 * collector evidences part of a clause the control is `partial` and the owner
 * note says which part. Nothing here is a statement of conformity, and no
 * pack has had a domain review.
 *
 * Imports from `compliance-packs.ts` are TYPE-ONLY: that file imports this one
 * to append the packs to `DEFAULT_COMPLIANCE_PACKS`.
 */
import type { CreateCompliancePackInput } from "./compliance-packs.js";
import type { TrustDimension } from "./risks.js";

type Control = CreateCompliancePackInput["controls"][number];
type Evidence = Pick<Control, "coverage" | "collector"> & Partial<Pick<Control, "collectorParams">> & { note: string };

const ev = (controlRef: string, title: string, e: Evidence): Control => ({
  controlRef,
  title,
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

/** ISO-wide wording for organisational clauses the platform does not touch */
const ORG = (what: string) => `Organisational: the platform does not address this. Attest ${what}.`;

const LICENCE_NOTE =
  "ISO/IEC text is copyrighted and NOT reproduced: titles cite the clause number and describe it in regulAIt's own " +
  "words. Clause numbers checked against the standard's published table of contents.";

// ===========================================================================
// ISO/IEC 42001:2023 — v2, every clause and Annex A control
// ===========================================================================

const i42 = (slug: string) => `iso-42001:${slug}`;
const t42 = (clause: string, text: string) => `ISO/IEC 42001 ${clause} — ${text}`;

export const ISO_42001_V2_CONTROLS: Control[] = [
  // --- clauses 4 to 10 -------------------------------------------------------
  att(i42("4.1-context"), t42("4.1", "Know the internal and external issues that bear on the AI management system"), "unaddressed", ORG("the documented context analysis")),
  att(i42("4.2-interested-parties"), t42("4.2", "Know who has a stake in the AI management system and what they need"), "unaddressed", ORG("the register of interested parties and their requirements")),
  att(
    i42("4.3-scope"),
    t42("4.3", "Set and document the boundaries of the AI management system"),
    "partial",
    "Partly supported: the AI system registry lists the systems the platform governs, which can inform the scope. " +
      "Attest the documented scope statement.",
  ),
  att(i42("4.4-aims"), t42("4.4", "Run and keep improving an AI management system"), "unaddressed", ORG("that the management system is established and maintained")),
  att(i42("5.1-leadership"), t42("5.1", "Top management leads and backs the AI management system"), "unaddressed", ORG("the evidence of top-management commitment")),
  ev(i42("5.2-ai-policy"), t42("5.2", "Publish an AI policy and have people acknowledge it"), {
    coverage: "partial",
    collector: "literacy_acknowledgements",
    note: "Evidenced by acknowledgements of published AI policy documents in the period. Writing the policy, and its fit to the organisation's purpose, are the organisation's.",
  }),
  // carried from v1 unchanged
  att(
    i42("5.3-roles-responsibilities"),
    "Organisational roles, responsibilities and authorities are assigned",
    "unaddressed",
    "Named accountable owners are an organisational artefact.",
  ),
  ev(i42("6.1.2-ai-risk-assessment"), t42("6.1.2", "Define how AI risks are assessed"), {
    coverage: "partial",
    collector: "model_cards_approved",
    note: "Evidenced by approved model cards, which record a risk sign-off per model. The organisation's risk assessment method and criteria are its own.",
  }),
  att(i42("6.1.3-ai-risk-treatment"), t42("6.1.3", "Define how AI risks are treated, and keep a statement of which controls apply"), "partial", "Partly supported: pack controls and their coverage can serve as a working statement of applicability. Attest the approved statement and treatment plan."),
  att(i42("6.1.4-ai-impact-assessment"), t42("6.1.4", "Define how the impacts of AI systems on people and society are assessed"), "partial", "Partly supported: use-case intake records intended use and risk tier. Attest the documented impact-assessment process."),
  att(i42("6.2-ai-objectives"), t42("6.2", "Set measurable AI objectives and plan how to reach them"), "unaddressed", ORG("the objectives and the plans to achieve them")),
  ev(i42("6.3-planning-changes"), t42("6.3", "Make changes to the AI management system in a planned way"), {
    coverage: "partial",
    collector: "approvals",
    collectorParams: { status: "approved" },
    note: "Evidenced by changes approved by a named person in the period. Changes made outside the platform are not seen.",
  }),
  att(i42("7.1-resources"), t42("7.1", "Provide the resources the AI management system needs"), "unaddressed", ORG("the resourcing decisions")),
  ev(i42("7.2-competence"), t42("7.2", "Make sure people doing AI work are competent, and keep the evidence"), {
    coverage: "partial",
    collector: "literacy_acknowledgements",
    note: "Evidenced by recorded completions of published training documents. Competence itself is not measured here.",
  }),
  ev(i42("7.3-awareness"), t42("7.3", "Make people aware of the AI policy and their part in it"), {
    coverage: "partial",
    collector: "literacy_acknowledgements",
    note: "Evidenced by acknowledgements of published AI policy and training documents in the period.",
  }),
  att(i42("7.4-communication"), t42("7.4", "Decide what is communicated about the AI management system, to whom and when"), "unaddressed", ORG("the communication plan")),
  att(i42("7.5-documented-information"), t42("7.5", "Create, control and keep the documents the AI management system needs"), "partial", "Partly supported: the audit ledger, model cards and pack versions are kept and versioned by the platform. Attest document control for everything held elsewhere."),
  ev(i42("8.1-operational-planning"), t42("8.1", "Plan and control the processes that put the AI management system into practice"), {
    coverage: "partial",
    collector: "approvals",
    collectorParams: { status: "approved" },
    note: "Evidenced by approvals decided in the period at governed workflow stages. Processes run outside the platform are not seen.",
  }),
  ev(i42("8.2-ai-risk-assessment-performed"), t42("8.2", "Carry out AI risk assessments at planned intervals and on significant change"), {
    coverage: "partial",
    collector: "model_cards_approved",
    note: "Evidenced by approved, unexpired model cards: an expired sign-off stops counting, which forces reassessment. The assessment content is the organisation's.",
  }),
  ev(i42("8.3-ai-risk-treatment"), t42("8.3", "Put the AI risk treatment plan into effect"), {
    coverage: "partial",
    collector: "abac_policies_active",
    note: "Evidenced by attribute-based access policies in force, one of the treatments the platform enforces. Treatments outside the platform are the organisation's.",
  }),
  ev(i42("8.4-ai-system-impact-assessment"), t42("8.4", "Carry out AI system impact assessments and keep their results"), {
    coverage: "partial",
    collector: "model_cards_approved",
    note: "The signed-off model card is the platform's half; the wider impact assessment is not. (iso-42001@1 cited this as 8.3; see ADR-0295.)",
  }),
  // carried from v1 unchanged
  {
    controlRef: i42("9.1-monitoring-measurement"),
    title: "Monitoring, measurement, analysis and evaluation",
    coverage: "evidenced",
    collector: "attributed_usage",
    collectorParams: {},
    minEvidenceCount: 1,
    attestationRequired: false,
    ownerNote: null,
  },
  att(i42("9.2-internal-audit"), t42("9.2", "Audit the AI management system internally at planned intervals"), "partial", "Partly supported: time-boxed auditor access and the signed evidence export serve an audit. Attest the audit programme and its results."),
  att(i42("9.3-management-review"), t42("9.3", "Have top management review the AI management system"), "unaddressed", ORG("the management review records")),
  att(i42("10.1-continual-improvement"), t42("10.1", "Keep improving the AI management system"), "unaddressed", ORG("the improvement actions taken")),
  ev(i42("10.2-nonconformity-corrective-action"), t42("10.2", "Deal with nonconformities and take corrective action"), {
    coverage: "partial",
    collector: "incident_register",
    note: "Evidenced by AI incidents recorded in the period. Nonconformities found outside the incident register are the organisation's.",
  }),
  // carried from v1 unchanged (the Annex A lifecycle group, kept for the evaluator catalog and existing attestations)
  {
    controlRef: i42("A.6-ai-system-lifecycle"),
    title: "Controls over the AI system lifecycle — changes are governed",
    coverage: "enforced",
    collector: "approvals",
    collectorParams: {},
    minEvidenceCount: 1,
    attestationRequired: false,
    ownerNote: null,
  },
  // --- Annex A ---------------------------------------------------------------
  ev(i42("A.2.2-ai-policy"), t42("A.2.2", "Document an AI policy"), {
    coverage: "partial",
    collector: "literacy_acknowledgements",
    note: "Evidenced by acknowledgements of the published AI policy. The policy's content is the organisation's.",
  }),
  att(i42("A.2.3-policy-alignment"), t42("A.2.3", "Line the AI policy up with the organisation's other policies"), "unaddressed", ORG("how the AI policy relates to other policies")),
  att(i42("A.2.4-policy-review"), t42("A.2.4", "Review the AI policy at planned intervals"), "unaddressed", ORG("the policy review dates and outcomes")),
  att(i42("A.3.2-ai-roles"), t42("A.3.2", "Define and assign AI roles and responsibilities"), "partial", "Partly supported: roles and per-user entitlements are configured in the platform. Attest the organisational role definitions."),
  ev(i42("A.3.3-reporting-concerns"), t42("A.3.3", "Give people a way to raise concerns about AI systems"), {
    coverage: "partial",
    collector: "user_feedback_channel",
    note: "Evidenced by problem reports and appeals received in the period. A whistle-blowing channel outside the product is the organisation's.",
  }),
  att(i42("A.4.2-resource-documentation"), t42("A.4.2", "Record the resources each AI system depends on"), "partial", "Partly supported: models, providers, connectors and MCP servers are registered. Attest the rest of the resource inventory."),
  ev(i42("A.4.3-data-resources"), t42("A.4.3", "Record the data resources AI systems use"), {
    coverage: "partial",
    collector: "lineage_edges",
    note: "Evidenced by lineage recorded in the period for data the platform sees. Datasets used outside the platform are the organisation's.",
  }),
  att(i42("A.4.4-tooling-resources"), t42("A.4.4", "Record the tools AI systems use"), "partial", "Partly supported: connectors and MCP tools are registered and versioned. Attest development tooling outside the platform."),
  ev(i42("A.4.5-computing-resources"), t42("A.4.5", "Record the system and computing resources AI systems use"), {
    coverage: "partial",
    collector: "attributed_usage",
    note: "Evidenced by model usage attributed to a project in the period. Infrastructure outside the gateway is the organisation's.",
  }),
  att(i42("A.4.6-human-resources"), t42("A.4.6", "Record the people and skills AI systems depend on"), "unaddressed", ORG("the staffing and skills records")),
  ev(i42("A.5.2-impact-assessment-process"), t42("A.5.2", "Have a process for assessing AI system impacts"), {
    coverage: "partial",
    collector: "model_cards_approved",
    note: "Evidenced by approved model cards. The impact-assessment process itself is the organisation's.",
  }),
  ev(i42("A.5.3-impact-assessment-records"), t42("A.5.3", "Keep records of AI system impact assessments"), {
    coverage: "partial",
    collector: "model_cards_approved",
    note: "Evidenced by approved model cards, which keep the sign-off and its date. Full assessment records held elsewhere are the organisation's.",
  }),
  att(i42("A.5.4-impact-on-individuals"), t42("A.5.4", "Assess how AI systems affect individuals and groups"), "partial", "Partly supported: model cards can document fairness assessments and use-case intake records affected groups. Attest the assessments."),
  att(i42("A.5.5-societal-impact"), t42("A.5.5", "Assess how AI systems affect society"), "unaddressed", ORG("the societal impact assessments")),
  att(i42("A.6.1.2-responsible-development-objectives"), t42("A.6.1.2", "Set objectives for developing AI systems responsibly"), "unaddressed", ORG("the development objectives")),
  ev(i42("A.6.1.3-responsible-development-process"), t42("A.6.1.3", "Define the process for designing and building AI systems responsibly"), {
    coverage: "partial",
    collector: "approvals",
    collectorParams: { status: "approved" },
    note: "Evidenced by approvals at governed workflow stages (plan sign-off, merge, deploy). Work outside the workflow engine is not seen.",
  }),
  att(i42("A.6.2.2-requirements"), t42("A.6.2.2", "Specify requirements for new AI systems and changes"), "partial", "Partly supported: the workflow engine's plan stage produces a signed-off requirements artefact. Attest requirements kept elsewhere."),
  att(i42("A.6.2.3-design-documentation"), t42("A.6.2.3", "Document design and development decisions"), "partial", "Partly supported: decision records and approvals are kept. Attest design documentation kept elsewhere."),
  ev(i42("A.6.2.4-verification-validation"), t42("A.6.2.4", "Verify and validate AI systems before use"), {
    coverage: "evidenced",
    collector: "eval_runs",
    note: "Evidenced by evaluation runs started in the period. Whether the tests are adequate is the organisation's judgement.",
  }),
  ev(i42("A.6.2.5-deployment"), t42("A.6.2.5", "Plan and approve deployment"), {
    coverage: "partial",
    collector: "approvals",
    collectorParams: { status: "approved" },
    note: "Evidenced by approvals decided in the period, including governed deploys. Deploys made outside the platform are not seen.",
  }),
  ev(i42("A.6.2.6-operation-monitoring"), t42("A.6.2.6", "Operate and monitor AI systems in use"), {
    coverage: "partial",
    collector: "guardrail_configs",
    collectorParams: { detector: "prompt_injection", minMode: "log" },
    note: "Configuration evidence that runtime detection is on. Performance monitoring of the model itself is the organisation's.",
  }),
  att(i42("A.6.2.7-technical-documentation"), t42("A.6.2.7", "Provide technical documentation to those who need it"), "partial", "Partly supported: model cards hold technical documentation. Attest documentation provided outside the platform."),
  ev(i42("A.6.2.8-event-logs"), t42("A.6.2.8", "Decide when AI systems record event logs, and keep them"), {
    coverage: "enforced",
    collector: "audit_decisions",
    collectorParams: { effect: "allow" },
    note: "Every governed call writes a hash-chained audit row. Logs inside the model provider are the provider's.",
  }),
  att(i42("A.7.2-data-for-development"), t42("A.7.2", "Manage the data used to build and improve AI systems"), "unaddressed", "Not addressed by the platform: regulAIt does not train or fine-tune models. Attest the data management process for training and fine-tuning data."),
  att(i42("A.7.3-data-acquisition"), t42("A.7.3", "Record how data is acquired"), "unaddressed", ORG("the data acquisition records")),
  att(i42("A.7.4-data-quality"), t42("A.7.4", "Define and meet data quality requirements"), "unaddressed", ORG("the data quality requirements and checks")),
  ev(i42("A.7.5-data-provenance"), t42("A.7.5", "Record where data came from"), {
    coverage: "evidenced",
    collector: "lineage_edges",
    note: "Evidenced by lineage edges recorded in the period. Provenance of data the platform never sees is the organisation's.",
  }),
  att(i42("A.7.6-data-preparation"), t42("A.7.6", "Define how data is prepared"), "unaddressed", ORG("the data preparation methods")),
  att(i42("A.8.2-user-information"), t42("A.8.2", "Give users the information they need about an AI system"), "partial", "Partly supported: model cards and published policy documents carry user information. Attest what users are shown elsewhere."),
  att(i42("A.8.3-external-reporting"), t42("A.8.3", "Let outside parties report adverse impacts"), "partial", "Partly supported: the feedback and appeal channel accepts reports from end users. Attest the channel for other outside parties."),
  ev(i42("A.8.4-incident-communication"), t42("A.8.4", "Communicate incidents to the people who need to know"), {
    coverage: "partial",
    collector: "incident_register",
    note: "Evidenced by incidents recorded in the period, whose clocks drive notification. Who is told, and how, is the organisation's.",
  }),
  att(i42("A.8.5-interested-party-information"), t42("A.8.5", "Meet obligations to report to interested parties"), "unaddressed", ORG("the reports made to interested parties")),
  ev(i42("A.9.2-responsible-use-process"), t42("A.9.2", "Define the process for using AI systems responsibly"), {
    coverage: "enforced",
    collector: "abac_policies_active",
    note: "Use is default-deny and gated per person, per tool and per model by policies in force. The written process is the organisation's.",
  }),
  att(i42("A.9.3-responsible-use-objectives"), t42("A.9.3", "Set objectives for using AI systems responsibly"), "unaddressed", ORG("the use objectives")),
  att(i42("A.9.4-intended-use"), t42("A.9.4", "Use AI systems as intended"), "partial", "Partly supported: use-case intake records intended use and the gateway enforces scope. Attest how use outside the platform is kept to intent."),
  att(i42("A.10.2-allocating-responsibilities"), t42("A.10.2", "Split responsibilities with suppliers, partners and customers"), "unaddressed", ORG("the allocation of responsibilities in contracts")),
  ev(i42("A.10.3-suppliers"), t42("A.10.3", "Make sure suppliers' services fit the organisation's approach to responsible AI"), {
    coverage: "partial",
    collector: "model_cards_approved",
    note: "Evidenced by approved model cards for third-party models and providers. Supplier due diligence outside the platform is the organisation's.",
  }),
  att(i42("A.10.4-customers"), t42("A.10.4", "Take customers' needs and expectations into account"), "unaddressed", ORG("how customer expectations are captured and met")),
];

export const ISO_42001_PACK_V2: CreateCompliancePackInput = {
  framework: "iso-42001",
  version: 2,
  title: "ISO/IEC 42001 — AI management system, every clause and Annex A control (ID-only mapping)",
  description:
    "Widens v1 to every requirement clause (4 to 10) and all 38 Annex A controls. Cited by clause number only, in " +
    "regulAIt's own words. A mapping is not a statement of applicability, an audit or certification.",
  provenance: {
    source: "ISO/IEC 42001:2023 clause and Annex A structure",
    catalogueRevision: "2023",
    reviewedBy: null,
    reviewedOn: null,
    note: `${LICENCE_NOTE} v1's impact-assessment ref (8.3) is corrected to 8.4 (ADR-0295).`,
  },
  cascadeTag: null,
  controls: ISO_42001_V2_CONTROLS,
};

// ===========================================================================
// ISO/IEC 23894:2023 — AI risk management guidance
// ===========================================================================

const i23 = (slug: string) => `iso-23894:${slug}`;
const t23 = (clause: string, text: string) => `ISO/IEC 23894 ${clause} — ${text}`;

export const ISO_23894_CONTROLS: Control[] = [
  att(i23("5.2-leadership-commitment"), t23("5.2", "Leadership commits to managing AI risk"), "unaddressed", ORG("leadership's commitment to AI risk management")),
  att(i23("5.3-integration"), t23("5.3", "Build AI risk management into the organisation's activities"), "unaddressed", ORG("how AI risk management is integrated")),
  att(i23("5.4.1-context"), t23("5.4.1", "Understand the organisation and its context for AI risk"), "unaddressed", ORG("the context analysis")),
  att(i23("5.4.2-commitment"), t23("5.4.2", "State the commitment to AI risk management"), "unaddressed", ORG("the published commitment")),
  att(i23("5.4.3-roles-accountabilities"), t23("5.4.3", "Assign roles, authority and accountability for AI risk"), "partial", "Partly supported: roles, entitlements and named approvers are configured in the platform. Attest the accountability assignments."),
  att(i23("5.4.4-resources"), t23("5.4.4", "Allocate resources to AI risk management"), "unaddressed", ORG("the resourcing")),
  att(i23("5.4.5-communication-consultation"), t23("5.4.5", "Set up communication and consultation on AI risk"), "unaddressed", ORG("the communication arrangements")),
  att(i23("5.5-implementation"), t23("5.5", "Put the AI risk management framework into practice"), "unaddressed", ORG("the implementation plan")),
  att(i23("5.6-evaluation"), t23("5.6", "Check that the framework works"), "unaddressed", ORG("the framework evaluation")),
  att(i23("5.7-improvement"), t23("5.7", "Adapt and improve the framework"), "unaddressed", ORG("the improvements made")),
  ev(i23("6.2-communication-consultation"), t23("6.2", "Talk to and hear from stakeholders throughout the process"), {
    coverage: "partial",
    collector: "user_feedback_channel",
    note: "Evidenced by end-user reports and appeals received in the period. Consultation with other stakeholders is the organisation's.",
  }),
  att(i23("6.3-scope-context-criteria"), t23("6.3", "Set the scope, context and risk criteria for each assessment"), "partial", "Partly supported: use-case intake records scope and risk tier. Attest the risk criteria."),
  att(i23("6.4.2-risk-identification"), t23("6.4.2", "Identify AI risks"), "partial", "Partly supported: red-team classes probe known attack types and shadow-AI discovery finds unregistered use. Attest the risk identification method and its results."),
  ev(i23("6.4.3-risk-analysis"), t23("6.4.3", "Analyse the likelihood and consequences of AI risks"), {
    coverage: "partial",
    collector: "eval_runs",
    note: "Evidenced by evaluation runs started in the period. Consequence analysis is the organisation's.",
  }),
  ev(i23("6.4.4-risk-evaluation"), t23("6.4.4", "Decide which AI risks need treatment"), {
    coverage: "partial",
    collector: "model_cards_approved",
    note: "Evidenced by approved model cards, which record the risk decision per model.",
  }),
  ev(i23("6.5-risk-treatment"), t23("6.5", "Choose and apply AI risk treatments"), {
    coverage: "partial",
    collector: "guardrail_configs",
    collectorParams: { detector: "prompt_injection", minMode: "block" },
    note: "Configuration evidence of one enforced treatment (a blocking detector). Other treatments are the organisation's.",
  }),
  ev(i23("6.6-monitoring-review"), t23("6.6", "Monitor and review AI risks and treatments"), {
    coverage: "partial",
    collector: "incident_register",
    note: "Evidenced by incidents recorded in the period. Scheduled risk reviews are the organisation's.",
  }),
  ev(i23("6.7-recording-reporting"), t23("6.7", "Record and report AI risk management outcomes"), {
    coverage: "enforced",
    collector: "audit_decisions",
    collectorParams: { effect: "deny" },
    note: "Every governed refusal is recorded in the hash-chained audit ledger. Reporting to management is the organisation's.",
  }),
];

export const ISO_23894_PACK: CreateCompliancePackInput = {
  framework: "iso-23894",
  version: 1,
  title: "ISO/IEC 23894 — AI risk management guidance (ID-only mapping)",
  description:
    "The framework (clause 5) and process (clause 6) of ISO/IEC 23894 mapped onto platform evidence. Cited by clause " +
    "number only, in regulAIt's own words. 23894 is guidance; a mapping is not a claim of following it.",
  provenance: {
    source: "ISO/IEC 23894:2023 clause structure",
    catalogueRevision: "2023",
    reviewedBy: null,
    reviewedOn: null,
    note: LICENCE_NOTE,
  },
  cascadeTag: null,
  controls: ISO_23894_CONTROLS,
};

// ===========================================================================
// ISO/IEC 42005:2025 — AI system impact assessment
// ===========================================================================

const i45 = (slug: string) => `iso-42005:${slug}`;
const t45 = (clause: string, text: string) => `ISO/IEC 42005 ${clause} — ${text}`;

/** P18 lane C1 (the impact-assessment artefact) is not built: say so where it would evidence a control */
const NO_C1 = "There is no impact-assessment record in the platform yet (P18 lane C1).";

export const ISO_42005_CONTROLS: Control[] = [
  att(i45("5.2-documenting-process"), t45("5.2", "Write down how impact assessments are done"), "unaddressed", `${ORG("the documented assessment process")} ${NO_C1}`),
  att(i45("5.3-integration"), t45("5.3", "Connect impact assessment to other management processes"), "unaddressed", ORG("how the assessment feeds risk management and other processes")),
  att(i45("5.4-timing"), t45("5.4", "Decide when an assessment is done and redone"), "partial", "Partly supported: model-card approvals expire, which forces a fresh sign-off. Attest the assessment triggers."),
  att(i45("5.5-scope"), t45("5.5", "Set the scope of each assessment"), "partial", "Partly supported: use-case intake records the system, its intended use and its risk tier. Attest the assessment scope."),
  att(i45("5.6-responsibilities"), t45("5.6", "Assign who does, reviews and approves assessments"), "partial", "Partly supported: named approvers are configured for governed stages. Attest the assessment roles."),
  att(i45("5.7-thresholds"), t45("5.7", "Set thresholds for sensitive and restricted uses and for impact scales"), "partial", "Partly supported: risk tiers and the EU AI Act classification gate high-risk use. Attest the organisation's thresholds."),
  att(i45("5.8-performing"), t45("5.8", "Carry out the assessment"), "unaddressed", `${ORG("the completed assessments")} ${NO_C1}`),
  att(i45("5.9-analysing-results"), t45("5.9", "Analyse what the assessment found"), "unaddressed", ORG("the analysis of findings")),
  att(i45("5.10-recording-reporting"), t45("5.10", "Record and report the assessment"), "unaddressed", `${ORG("the assessment records and reports")} ${NO_C1}`),
  ev(i45("5.11-approval"), t45("5.11", "Have the assessment approved"), {
    coverage: "partial",
    collector: "model_cards_approved",
    note: `Evidenced by approved model cards, the nearest sign-off the platform records. ${NO_C1}`,
  }),
  ev(i45("5.12-monitoring-review"), t45("5.12", "Monitor and review impacts after deployment"), {
    coverage: "partial",
    collector: "incident_register",
    note: "Evidenced by incidents recorded in the period. Planned reviews of the assessment are the organisation's.",
  }),
  att(i45("6.2-documented-scope"), t45("6.2", "Record the assessment's scope"), "partial", "Partly supported: use-case intake records much of the scope. Attest the recorded scope."),
  att(i45("6.3-system-information"), t45("6.3", "Record what the AI system is, does and is for"), "partial", "Partly supported: model cards and use-case records hold the description, purpose and intended use. Attest unintended uses considered."),
  ev(i45("6.4-data-information"), t45("6.4", "Record the data the system uses and its quality"), {
    coverage: "partial",
    collector: "lineage_edges",
    note: "Evidenced by lineage recorded for data the platform sees. Data quality documentation is the organisation's.",
  }),
  att(i45("6.5-algorithm-model-information"), t45("6.5", "Record the algorithms and models used and how they were built"), "partial", "Partly supported: model cards record the models and providers in use. Attest development information the provider does not publish."),
  att(i45("6.6-deployment-environment"), t45("6.6", "Record where and in what conditions the system is deployed"), "unaddressed", ORG("the deployment environment description")),
  att(i45("6.7-interested-parties"), t45("6.7", "Record who is affected, directly and indirectly"), "partial", "Partly supported: use-case intake records affected groups. Attest the interested-party analysis."),
  att(i45("6.8-impacts"), t45("6.8", "Record actual and foreseeable benefits, harms, failures and misuse"), "partial", "Partly supported: red-team runs probe foreseeable misuse and the incident register records failures. Attest the impact analysis."),
  att(i45("6.9-measures"), t45("6.9", "Record the measures taken to address harms and benefits"), "partial", "Partly supported: the controls enforced by the platform are recorded in packs and policy versions. Attest the measures taken outside it."),
];

export const ISO_42005_PACK: CreateCompliancePackInput = {
  framework: "iso-42005",
  version: 1,
  title: "ISO/IEC 42005 — AI system impact assessment (ID-only mapping)",
  description:
    "The process (clause 5) and documentation (clause 6) of ISO/IEC 42005 mapped onto platform evidence. Cited by " +
    "clause number only, in regulAIt's own words. Most of it awaits the impact-assessment record (P18 lane C1).",
  provenance: {
    source: "ISO/IEC 42005:2025 clause structure",
    catalogueRevision: "2025",
    reviewedBy: null,
    reviewedOn: null,
    note: LICENCE_NOTE,
  },
  cascadeTag: null,
  controls: ISO_42005_CONTROLS,
};

export const ISO_PACKS: CreateCompliancePackInput[] = [ISO_42001_PACK_V2, ISO_23894_PACK, ISO_42005_PACK];

/**
 * The trust dimension of each attestation-only ISO control (ADR-0148: a `none`
 * collector says nothing about subject matter, so each is classified on purpose).
 * Organisational clauses are `compliance`; data clauses `privacy`.
 */
export const ISO_PACK_DIMENSIONS: Readonly<Record<string, TrustDimension>> = Object.fromEntries(
  ISO_PACKS.flatMap((p) => p.controls)
    .filter((c) => c.collector === "none" && !(c.controlRef === "iso-42001:5.3-roles-responsibilities"))
    .map((c) => [c.controlRef, /^iso-42001:A\.7\.|^iso-42005:6\.4/.test(c.controlRef) ? "privacy" : "compliance"] as const),
);
