/**
 * ADR-0319 (gap G11) — THE AIUC-1 CONTROL-MAPPING PACK: authored data.
 *
 * `aiuc-1@1` maps every live requirement of AIUC-1, the AI agent standard
 * published by the Artificial Intelligence Underwriting Company, onto
 * regulAIt's evidence collectors. Release mapped: 15 October 2026 (Q4 2026),
 * the release current on 15 November 2026. AIUC-1 is revised every quarter
 * (next release 15 January 2027); a new release is published as `aiuc-1@2`
 * with the ADR-0087 diff, never by editing this one (ADR-0058).
 *
 * LICENCE (ADR-0176, ADR-0215 decision 2). The AIUC-1 site's terms reserve
 * all rights in its content and grant no licence to reproduce it. Requirements
 * are cited BY IDENTIFIER ONLY (A001 … F002): every title, description and
 * owner note is regulAIt's own wording. No AIUC-1 requirement text, control
 * text or evidence template is reproduced; read the standard for that. The
 * identifiers were checked against the standard's published index of
 * requirements for the 15 October 2026 release.
 *
 * GRANULARITY. Each control is one AIUC-1 REQUIREMENT (A001), not one of its
 * numbered controls (A001.1). The audit is run against the numbered controls
 * and their evidence; this pack says which platform evidence bears on each
 * requirement, and the owner note says what is left to the organisation.
 *
 * RETIRED REQUIREMENTS (C011, C012, D002, E007, E014) are listed in
 * `AIUC_1_RETIRED` and are NOT controls: their scope was folded into another
 * requirement (the third-party testing ones into C010 and D004).
 *
 * HONEST COVERAGE. The five third-party testing requirements (A009, B001,
 * C010, D004, E018) need an evaluation by an independent party: regulAIt's own
 * eval and red-team runs are first-party and never stand in for it, so they are
 * attestation-required and `unaddressed`. Where no collector evidences a
 * requirement the control is attestation-required and says what to attest;
 * nothing is guessed. Nothing here is a statement of conformity or of AIUC-1
 * certification, and the pack has had no domain review.
 *
 * Imports from `compliance-packs.ts` are TYPE-ONLY: that file imports this one
 * to append the pack to `DEFAULT_COMPLIANCE_PACKS`.
 */
import type { CreateCompliancePackInput } from "./compliance-packs.js";
import type { TrustDimension } from "./risks.js";

type Control = CreateCompliancePackInput["controls"][number];
type Evidence = Pick<Control, "coverage" | "collector"> & Partial<Pick<Control, "collectorParams">> & { note: string };

export const AIUC_1_FRAMEWORK = "aiuc-1" as const;

/** the primary source and the release this pack maps */
export const AIUC_1_SOURCE = {
  title: "AIUC-1, the AI agent standard (Artificial Intelligence Underwriting Company)",
  url: "https://standard.aiuc-1.com/",
  changelogUrl: "https://standard.aiuc-1.com/changelog",
  release: "2026-10-15",
  textPolicy: "id_only",
} as const;

/** retired in or before the 15 October 2026 release; never a control in this pack */
export const AIUC_1_RETIRED = ["C011", "C012", "D002", "E007", "E014"] as const;

const ref = (id: string, slug: string) => `${AIUC_1_FRAMEWORK}:${id}-${slug}`;
const t = (id: string, text: string) => `AIUC-1 ${id} — ${text}`;

const ev = (id: string, slug: string, title: string, e: Evidence): Control => ({
  controlRef: ref(id, slug),
  title: t(id, title),
  coverage: e.coverage,
  collector: e.collector,
  collectorParams: e.collectorParams ?? {},
  minEvidenceCount: 1,
  attestationRequired: false,
  ownerNote: e.note,
});

const att = (id: string, slug: string, title: string, coverage: Control["coverage"], ownerNote: string): Control => ({
  controlRef: ref(id, slug),
  title: t(id, title),
  coverage,
  collector: "none",
  collectorParams: {},
  minEvidenceCount: 1,
  attestationRequired: true,
  ownerNote,
});

/** organisational requirements the platform does not touch */
const ORG = (what: string) => `Organisational: the platform does not address this. Attest ${what}.`;

/** the five third-party testing requirements: first-party runs never stand in for them */
const THIRD_PARTY = (area: string) =>
  `Needs an evaluation by an independent party. regulAIt's own eval and red-team runs are first-party and are not ` +
  `counted here. Attest the third-party evaluation report for ${area}, and its date.`;

export const AIUC_1_CONTROLS: Control[] = [
  // --- A. Data & Privacy -----------------------------------------------------
  ev("A001", "input-data-policy", "Say how the data people put into the agent may be used and kept", {
    coverage: "partial",
    collector: "compliance_profile_cascade",
    collectorParams: { cascadeAspect: "retention" },
    note:
      "Evidenced by a compliance profile whose cascade forces a retention floor. Writing the input data policy, and what " +
      "a model provider may do with the data under its contract, are the organisation's.",
  }),
  att("A002", "output-data-policy", "Say who owns the agent's output and how it may be used", "unaddressed", ORG("the output data terms given to customers")),
  ev("A003", "limit-agent-data-access", "Let an agent reach only the data its task needs", {
    coverage: "partial",
    collector: "abac_policies_active",
    note:
      "Evidenced by attribute-based access policies in the active set; agents act with the entitlements of the person " +
      "running them and project context is shared per membership. Data an agent reaches outside the gateway is not seen.",
  }),
  ev("A004", "protect-ip-trade-secrets", "Keep the organisation's confidential and proprietary material out of prompts and responses", {
    coverage: "partial",
    collector: "guardrail_configs",
    collectorParams: { detector: "semantic_dlp", minMode: "block" },
    note: "Configuration evidence: a semantic data-loss detector set to block. It catches only what it recognises; marking what is confidential is the organisation's.",
  }),
  att(
    "A005",
    "cross-customer-exposure",
    "Keep one customer's data from reaching another",
    "partial",
    "Partly met by the platform, but no collector counts it: tenant tables carry row-level security, and caches are " +
      "scoped per user and agent and never cross a tenant. How the organisation's own product separates its customers " +
      "is the organisation's. Attest the separation of customer data in the agent.",
  ),
  ev("A006", "pii-leakage", "Keep personal data from leaking through the agent", {
    coverage: "partial",
    collector: "compliance_profile_cascade",
    collectorParams: { cascadeAspect: "pii_block" },
    note: "Configuration evidence: a compliance profile whose cascade forces PII blocking at the gateway. Detection is pattern- and model-based.",
  }),
  att(
    "A007",
    "ip-violations",
    "Keep the agent's output from infringing other people's intellectual property",
    "unaddressed",
    "Not addressed by the platform: output is not checked against third-party copyright or licences. Attest how the " +
      "organisation handles it.",
  ),
  att(
    "A008",
    "secrets-leakage",
    "Keep credentials and secrets out of prompts, output and logs",
    "partial",
    "Partly met by the platform, but no collector counts it: upstream credentials are held by the gateway and never " +
      "returned to a client or a model, content columns refuse typed credentials (ADR-0233) and the audit ledger scrubs " +
      "credential shapes (ADR-0099). A secret a tool or a model itself returns is not covered. Attest the practice.",
  ),
  att("A009", "third-party-testing", "Have data and privacy risk tested by an independent party", "unaddressed", THIRD_PARTY("data and privacy risk")),

  // --- B. Security -----------------------------------------------------------
  att("B001", "third-party-testing", "Have security risk tested by an independent party", "unaddressed", THIRD_PARTY("security risk")),
  ev("B002", "detect-adversarial-input", "Detect input that tries to subvert the agent", {
    coverage: "partial",
    collector: "guardrail_configs",
    collectorParams: { detector: "prompt_injection", minMode: "block" },
    note: "Configuration evidence: a prompt-injection detector set to block; it scans prompts, tool arguments and tool output. Detection is pattern-based; content in images or audio is not scanned.",
  }),
  att("B003", "public-technical-details", "Decide what technical detail about the agent is made public", "unaddressed", ORG("the review of published technical detail")),
  ev("B004", "endpoint-scraping", "Stop the agent's endpoints being harvested by volume", {
    coverage: "partial",
    collector: "compliance_profile_cascade",
    collectorParams: { cascadeAspect: "budget_ceiling" },
    note:
      "Configuration evidence: a compliance profile whose cascade forces a budget ceiling; budgets and rate limits are " +
      "enforced at the gateway per person and project. Public endpoints of the organisation's own product are the " +
      "organisation's to protect.",
  }),
  ev("B005", "real-time-input-filtering", "Filter input in real time before the model sees it", {
    coverage: "partial",
    collector: "guardrail_configs",
    collectorParams: { detector: "jailbreak", minMode: "block" },
    note: "Configuration evidence: a jailbreak detector set to block, applied at the gateway before the call. Detection is pattern-based.",
  }),
  ev("B006", "unauthorised-agent-actions", "Stop an agent taking actions it is not allowed to take", {
    coverage: "partial",
    collector: "audit_decisions",
    collectorParams: { objectType: "mcp_tool" },
    note:
      "Counts governed decisions on tool calls in the period. Tool access is default-deny per person and per tool, and " +
      "a refusal is recorded. Actions an agent takes outside the gateway are not seen.",
  }),
  ev("B007", "user-access-privileges", "Give each person only the AI access they need, and review it", {
    coverage: "enforced",
    collector: "audit_decisions",
    collectorParams: { ruleIdPrefix: "grant-cert-" },
    note:
      "Counts access-recertification decisions on grants (kept, revoked, reassigned) in the period. Access is " +
      "default-deny and granted per person. A period with no recertification shows no evidence.",
  }),
  ev("B008", "deployment-environment", "Protect the environment the agent runs in", {
    coverage: "partial",
    collector: "isolation_placements",
    note:
      "Counts workloads placed in a sandbox at L2 or L3 after the gateway accepted the sandbox's own probe report; " +
      "org-wide, so counted under an org-scoped report only. Hardening of the organisation's own hosts is the " +
      "organisation's.",
  }),
  ev("B009", "output-over-exposure", "Keep output from revealing more than the person asking should see", {
    coverage: "partial",
    collector: "guardrail_configs",
    collectorParams: { detector: "semantic_dlp", minMode: "block" },
    note: "Configuration evidence: a semantic data-loss detector set to block on responses. It catches only what it recognises.",
  }),
  att(
    "B010",
    "secure-generated-code",
    "Steer generated code towards secure patterns",
    "partial",
    "Partly met by the platform, but no collector counts it: workflow templates can require automated checks before a " +
      "change merges. Which checks run (static analysis, dependency scans) is the organisation's own CI. Attest them.",
  ),

  // --- C. Safety -------------------------------------------------------------
  ev("C001", "risk-taxonomy", "Define the AI risks that matter to this agent", {
    coverage: "partial",
    collector: "audit_decisions",
    collectorParams: { ruleIdPrefix: "risk-registered" },
    note: "Counts risks registered in the risk register in the period. The taxonomy itself, and its fit to the agent, are the organisation's.",
  }),
  ev("C002", "pre-deployment-testing", "Test the agent before it is deployed or changed", {
    coverage: "partial",
    collector: "eval_runs",
    note: "Counts evaluation runs started in the period. Whether a deployment was gated on them, and regression testing of open-weight model changes, are the organisation's to attest.",
  }),
  ev("C003", "harmful-outputs", "Stop harmful output", {
    coverage: "partial",
    collector: "guardrail_configs",
    collectorParams: { detector: "toxicity", minMode: "block" },
    note: "Configuration evidence: a toxicity detector set to block. It covers what the detector classifies; other harm categories are the organisation's.",
  }),
  att(
    "C004",
    "out-of-scope-outputs",
    "Keep the agent to the subjects it is meant to cover",
    "unaddressed",
    "Not addressed by the platform: there is no topic-scope filter. Attest how the agent is held to its intended scope.",
  ),
  att(
    "C005",
    "agent-specific-high-risk-outputs",
    "Stop the high-risk output specific to this agent's use",
    "unaddressed",
    "Not addressed by the platform: risks particular to the organisation's use are not classified. Attest the controls in place.",
  ),
  att(
    "C006",
    "output-vulnerabilities",
    "Keep output from carrying something that attacks the system that uses it",
    "partial",
    "Partly met by the platform, but no collector counts it: regulAIt's console renders model output as text under a " +
      "strict content security policy, and tool calls a model proposes pass the governance decision. What a downstream " +
      "system does with the output is that system's. Attest how it is handled.",
  ),
  ev("C007", "human-review-high-risk", "Send high-risk output to a person before it takes effect", {
    coverage: "partial",
    collector: "approvals",
    collectorParams: { status: "approved" },
    note: "Counts approvals decided by a named person in the period. Which outputs need review is set by the organisation's rules.",
  }),
  ev("C008", "monitor-risk-categories", "Watch the agent's risk categories while it runs", {
    coverage: "partial",
    collector: "audit_decisions",
    collectorParams: { objectType: "governance_monitor", ruleIdPrefix: "governance-monitor-evaluated" },
    note: "Counts governance monitor evaluations in the period. The categories monitored are the organisation's to choose.",
  }),
  ev("C009", "feedback-intervention", "Let people report problems and step in while the agent runs", {
    coverage: "partial",
    collector: "user_feedback_channel",
    note:
      "Counts end-user problem reports and appeals received in the period; the execution controls can halt an agent. " +
      "A period with no report shows no evidence, which is not a missing channel.",
  }),
  att("C010", "third-party-testing", "Have safety risk tested by an independent party", "unaddressed", THIRD_PARTY("safety risk")),

  // --- D. Reliability --------------------------------------------------------
  ev("D001", "hallucinated-outputs", "Reduce and catch wrong or unsupported answers", {
    coverage: "partial",
    collector: "eval_runs",
    note: "Counts evaluation runs started in the period. Evaluations measure quality on the organisation's test sets; they do not check answers at run time.",
  }),
  ev("D003", "unsafe-tool-calls", "Limit tool calls that could do damage, and have a person approve sensitive ones", {
    coverage: "partial",
    collector: "approvals",
    collectorParams: { status: "approved" },
    note:
      "Counts approvals decided by a named person in the period. State-changing tools can require an approval bound to " +
      "the payload. Which operations count as sensitive is the organisation's rule.",
  }),
  att("D004", "third-party-testing", "Have reliability risk tested by an independent party", "unaddressed", THIRD_PARTY("reliability risk")),

  // --- E. Accountability -----------------------------------------------------
  att(
    "E001",
    "failure-plan-security",
    "Have a plan for a security breach involving the agent",
    "partial",
    "Partly supported: the incident register records and tracks AI incidents. Attest the documented breach plan.",
  ),
  att(
    "E002",
    "failure-plan-harmful-outputs",
    "Have a plan for harmful output from the agent",
    "partial",
    "Partly supported: the incident register records and tracks AI incidents. Attest the documented plan.",
  ),
  att(
    "E003",
    "failure-plan-hallucinations",
    "Have a plan for wrong answers that cause harm",
    "partial",
    "Partly supported: the incident register records and tracks AI incidents. Attest the documented plan.",
  ),
  ev("E004", "assign-accountability", "Name who is accountable for the agent", {
    coverage: "partial",
    collector: "audit_decisions",
    collectorParams: { objectType: "agent", ruleIdPrefix: "agent-stewardship-" },
    note: "Counts agent stewardship records (owners and boundaries) in the period. Accountability above the agent's owner is the organisation's.",
  }),
  att(
    "E005",
    "data-storage-security",
    "Document where and how the agent's data is stored and secured",
    "partial",
    "Partly supported: the deployment mode (hosted, BYOC or air-gapped) and its data boundary are disclosed. Attest the " +
      "documented storage security.",
  ),
  ev("E006", "vendor-model-due-diligence", "Check vendors and models before relying on them", {
    coverage: "partial",
    collector: "model_cards_approved",
    note:
      "Counts approved, unexpired model cards. There is no verification of model weights or of an open-weight model's " +
      "source and licence. Attest the vendor due diligence.",
  }),
  att("E008", "review-internal-processes", "Review the processes around the agent at intervals", "unaddressed", ORG("the internal reviews and their dates")),
  ev("E009", "third-party-access", "Watch the access third parties have to the agent", {
    coverage: "partial",
    collector: "audit_decisions",
    collectorParams: { ruleIdPrefix: "api-key-" },
    note: "Counts API key issuance and revocation decisions in the period. Access a third party has outside the gateway is not seen.",
  }),
  ev("E010", "acceptable-use-policy", "Publish an acceptable use policy for AI and have people acknowledge it", {
    coverage: "partial",
    collector: "literacy_acknowledgements",
    note: "Counts acknowledgements of published AI policy documents in the period. Writing the policy is the organisation's.",
  }),
  att(
    "E011",
    "processing-locations",
    "Record where the agent's data is processed",
    "partial",
    "Partly supported: the model registry records each provider a call can be routed to. Attest the processing locations.",
  ),
  att(
    "E012",
    "regulatory-compliance",
    "Document how the agent meets the rules that apply to it",
    "partial",
    "Partly supported: compliance packs map controls onto evidence; a mapping is not a legal assessment. Attest the " +
      "documented regulatory analysis.",
  ),
  att("E013", "quality-management", "Run a quality management system for the agent", "unaddressed", ORG("the quality management system")),
  ev("E015", "log-activity", "Log what the AI system does", {
    coverage: "enforced",
    collector: "audit_decisions",
    note: "Counts governed decisions recorded in the hash-chained audit ledger in the period. Activity outside the gateway is not seen.",
  }),
  att("E016", "ai-disclosure", "Tell people when they are dealing with AI", "unaddressed", ORG("how AI use is disclosed to the agent's users")),
  att("E017", "transparency-policy", "Document what is made known about how the system works", "unaddressed", ORG("the transparency policy")),
  att("E018", "third-party-testing", "Have accountability risk tested by an independent party", "unaddressed", THIRD_PARTY("accountability risk")),

  // --- F. Society ------------------------------------------------------------
  att(
    "F001",
    "cyber-misuse",
    "Stop the agent being used for cyberattacks",
    "unaddressed",
    "Not addressed by the platform: no detector classifies exploit or malware generation. Attest the controls in place.",
  ),
  att(
    "F002",
    "catastrophic-misuse",
    "Stop the agent being used for catastrophic harm",
    "unaddressed",
    "Not addressed by the platform: no detector classifies chemical, biological, radiological or nuclear misuse. Attest the controls in place.",
  ),
];

export const AIUC_1_PACK: CreateCompliancePackInput = {
  framework: AIUC_1_FRAMEWORK,
  version: 1,
  title: "AIUC-1 — AI agent standard, every requirement (ID-only mapping)",
  description:
    "Every live requirement of AIUC-1 (15 October 2026 release) mapped onto platform evidence. Cited by requirement " +
    "identifier only, in regulAIt's own words. The third-party testing requirements need an independent evaluation " +
    "and are left to attestation. A mapping is not an audit or AIUC-1 certification.",
  provenance: {
    source: `${AIUC_1_SOURCE.title}, ${AIUC_1_SOURCE.url}`,
    catalogueRevision: "15 October 2026 release (Q4 2026)",
    reviewedBy: null,
    reviewedOn: null,
    note:
      "AIUC-1 content is all rights reserved and NOT reproduced: titles cite the requirement identifier and describe it " +
      "in regulAIt's own words. Identifiers checked against the published requirement index for the 15 October 2026 " +
      `release; retired requirements (${AIUC_1_RETIRED.join(", ")}) are not mapped. Mapped per requirement, not per ` +
      "numbered control. Coverage is regulAIt's self-assessment; NOT reviewed by AIUC or by a domain reviewer.",
  },
  cascadeTag: null,
  controls: AIUC_1_CONTROLS,
};

export const AIUC_PACKS: CreateCompliancePackInput[] = [AIUC_1_PACK];

/** AIUC-1's principle letter → trust dimension: each requirement is classified by its principle */
const PRINCIPLE_DIMENSION: Readonly<Record<string, TrustDimension>> = {
  A: "privacy",
  B: "security",
  C: "safety",
  D: "reliability",
  E: "compliance",
  F: "safety",
};

export const AIUC_PACK_DIMENSIONS: Readonly<Record<string, TrustDimension>> = Object.fromEntries(
  AIUC_1_CONTROLS.map((c) => [c.controlRef, PRINCIPLE_DIMENSION[c.controlRef.charAt(AIUC_1_FRAMEWORK.length + 1)]!] as const),
);
