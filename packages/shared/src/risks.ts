/**
 * ADR-0081 — THE AI RISK REGISTER, the pure half.
 *
 *   THIS FILE                       the vocabulary (categories, statuses,
 *                                   levels, evidence-resolver ids), the
 *                                   category → resolver mapping, the request
 *                                   schemas, the seed risk library, the
 *                                   disclaimer. Pure — no db, no clock.
 *   `apps/gateway/src/risks.ts`     the EVIDENCE RESOLVERS (real SELECTs over
 *                                   real ledgers), the register API, the
 *                                   audited acceptance, the audit rows.
 *
 * THE ONE PROPERTY THIS FILE EXISTS TO GUARANTEE: the register can never
 * overclaim what the ledgers hold. Every category maps to a FIXED list of
 * resolver ids, each naming a query the gateway knows how to run against a
 * ledger that already exists — a risk cannot carry SQL, cannot invent an
 * evidence source, and a category no ledger measures maps to `none` and is
 * reported as "evidence: none — attestation only" outright. `scope_drift` is
 * kept in the vocabulary FOR that reason: it is the control case proving the
 * register says "we don't measure this" instead of inventing a proxy.
 *
 * MEASURED vs DECLARED, stated once and enforced everywhere: `likelihood` and
 * `impact` are declared human judgments (small enums, no arithmetic). The
 * evidence beside them is measured from the ledgers. The API labels each side
 * and never blends them into a single computed score — a 3x3 of two enums is
 * not quantified risk math, and this register does not pretend it is.
 */
import { z } from "zod";
import {
  ASSURANCE_DEFAULTS,
  RESIDUAL_RISK_BANDS,
  RISK_RESPONSE_TYPES,
  RISK_TOLERANCE_SCOPE_KINDS,
  TOLERANCE_BANDS,
  maxAcceptanceMonths,
  type ResidualRiskBand,
  type RiskToleranceScopeKind,
  type ToleranceBand,
} from "./assurance.js";
import { REVIEW_POLICY_TIER_KEYS } from "./review-policy.js";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * The curated category vocabulary — chosen by what OUR ledgers can actually
 * evidence, not by what a GRC taxonomy would like to name. Every category
 * except `scope_drift` resolves to at least one real ledger query; and
 * `scope_drift` is in the list precisely because a register that quietly
 * dropped the unmeasurable would be the tick-box this feature refuses to be.
 */
export const AI_RISK_CATEGORIES = [
  /** an entitled user's agent drives a tool destructively or off-purpose —
   * evidenced by the governed denial trail (pillar 1 default-deny + ABAC) */
  "tool_misuse",
  /** an agent's de-facto use drifts beyond its approved purpose over time —
   * NO ledger measures purpose drift; attestation only, said outright */
  "scope_drift",
  /** adversarial input steers the model past its instructions — evidenced by
   * red-team ASR (ADR-0068) and the guardrail configuration (ADR-0042) */
  "prompt_injection",
  /** PII/PHI leaves through a prompt or a connector — evidenced by the PII
   * cascade configuration and the `pii-blocked` denial trail (ADR-0019) */
  "data_leakage_pii",
  /** standing grants exceed what people actually need — evidenced by the
   * live grant inventory and the active ABAC policy set (ADR-0040) */
  "over_permissioning",
  /** AI spend exceeds what anyone authorized — evidenced by the budget-cap
   * refusal trail (project caps, run caps, virtual-key exhaustion) */
  "budget_overrun",
  /** the model asserts things its sources do not support — evidenced by
   * groundedness eval runs (ADR-0067) */
  "hallucination",
  /** AI usage outside the gateway entirely — evidenced by the shadow-AI
   * findings ledger (ADR-0071) */
  "shadow_ai",
  /** a third party's AI reaches our data or our stack without an assessed
   * vendor behind it — evidenced by the AI vendor registry's ASSESSMENT
   * LIFECYCLE (ADR-0084): counts of vendors by assessment state, decided on
   * the one approvals queue. The lifecycle is a platform record; the
   * assessment CONTENT is vendor-attested, and the resolver says so. */
  "third_party_ai",
  /** ADR-0147: outcomes differ unfairly across groups. No ledger here MEASURES
   * disparity; the evidence is the model cards' documented bias/fairness
   * assessments (ADR-0063 MRM) — a DOCUMENTATION record, labelled as one */
  "bias_fairness",
  /** ADR-0147: the system emits harmful, toxic or jailbreak-induced content —
   * evidenced by the output-safety guardrail configuration (toxicity /
   * jailbreak at block) and the guardrail block trail (ADR-0042) */
  "unsafe_output",
] as const;
export type AiRiskCategory = (typeof AI_RISK_CATEGORIES)[number];

export const AI_RISK_STATUSES = ["open", "mitigating", "accepted", "closed"] as const;
export type AiRiskStatus = (typeof AI_RISK_STATUSES)[number];

/** DECLARED human judgments — a position a person takes, never a measurement */
export const AI_RISK_LEVELS = ["low", "medium", "high"] as const;
export type AiRiskLevel = (typeof AI_RISK_LEVELS)[number];

/**
 * THE RESOLVER VOCABULARY — the honest boundary of the register, exactly the
 * ADR-0058 collector discipline: each id names a parameterised query the
 * gateway runs against a ledger that ALREADY EXISTS. A risk (or a library
 * entry) picks resolver ids by category; it cannot invent one and it cannot
 * write SQL. `none` is the resolver for a category no ledger measures — it is
 * the only one that produces no numbers, and the register reports it as
 * "none — attestation only" rather than as a silent zero.
 */
export const RISK_EVIDENCE_RESOLVERS = [
  /** `redteam_runs` in the window (agent-scoped when the risk names an
   * agent): run count plus the latest run's pooled ASR, its trial
   * denominator, and its measurement quality — ADR-0068's statistics,
   * surfaced verbatim, never re-derived */
  "redteam_asr",
  /** `guardrail_configs` with prompt-injection detection at or above block —
   * ADR-0042 configuration evidence, not event evidence */
  "guardrail_config",
  /** `audit_log` deny rows whose rule id starts with `pii-` — every PII
   * block the gateway actually performed in the window */
  "pii_denials",
  /** `compliance_profiles` whose cascade forces PII block mode — the §8.3
   * configuration evidence beside the event evidence */
  "pii_cascade_config",
  /** `audit_log` deny rows for mcp_tool / agent / connector objects — the
   * governed-denial trail proving default-deny is deciding real calls */
  "governed_denials",
  /** enabled `abac_policies` with an active version — ADR-0040 */
  "abac_policies",
  /** the live standing-grant inventory: tool, agent, and connector grants —
   * state evidence for the over-permissioning conversation */
  "active_grants",
  /** `audit_log` deny rows from the budget enforcement points: project caps,
   * orchestration run/node caps, virtual-key exhaustion — pillar 5's
   * refusals, counted per enforcement point */
  "budget_refusals",
  /** `eval_runs` scored by an ADR-0067 groundedness scorer in the window,
   * plus the latest run's pass rate */
  "groundedness_evals",
  /** `shadow_ai_findings` — open vs total, the ADR-0071 discovery ledger */
  "shadow_findings",
  /** `ai_vendors` (ADR-0084) — vendors by assessment state (proposed /
   * under_assessment / approved / rejected / retired) plus assessments
   * decided in the window, scoped to the risk's vendor when it names one.
   * Counts the assessment LIFECYCLE our approvals queue actually decided —
   * never the truth of the vendor's own attested answers. */
  "vendor_assessments",
  /** ADR-0147: `model_cards` that DOCUMENT a bias/fairness assessment, by
   * entry status, scoped to the risk's agent when it names one. A documented
   * assessment is an attestation by the card's author — the resolver reports
   * it as configuration evidence, never as a measured fairness result. */
  "model_card_fairness",
  /** ADR-0147: guardrail configs with toxicity or jailbreak detection at
   * block — configuration evidence for output safety */
  "output_safety_config",
  /** ADR-0147: `audit_log` deny rows with rule id `guardrail-blocked` in the
   * window — the guardrail blocks the gateway actually performed */
  "guardrail_blocks",
  /** NOT MEASURED BY ANY LEDGER. The register says so outright. */
  "none",
] as const;
export type RiskEvidenceResolverId = (typeof RISK_EVIDENCE_RESOLVERS)[number];

/**
 * THE CATEGORY → EVIDENCE MAPPING — fixed in code, not authored per risk, so
 * two risks in the same category can never disagree about what evidences
 * them, and no risk can shop for a flattering query. A category mapping to
 * `["none"]` maps to exactly that: the honest empty-handed answer.
 */
export const RISK_CATEGORY_EVIDENCE: Readonly<
  Record<AiRiskCategory, readonly RiskEvidenceResolverId[]>
> = {
  tool_misuse: ["governed_denials", "abac_policies"],
  scope_drift: ["none"],
  prompt_injection: ["redteam_asr", "guardrail_config"],
  data_leakage_pii: ["pii_denials", "pii_cascade_config"],
  over_permissioning: ["active_grants", "abac_policies"],
  budget_overrun: ["budget_refusals"],
  hallucination: ["groundedness_evals"],
  shadow_ai: ["shadow_findings"],
  third_party_ai: ["vendor_assessments"],
  bias_fairness: ["model_card_fairness"],
  unsafe_output: ["output_safety_config", "guardrail_blocks"],
};

/**
 * ADR-0147 — THE SIX TRUST DIMENSIONS, and which category belongs to which.
 *
 * The dashboard's radar axes. Fixed order (it is the axis order). Every risk
 * category maps to exactly one dimension, so a risk is never counted twice and
 * never dropped; the test asserts the mapping is total. `budget_overrun` sits
 * under compliance because an unauthorized spend is a breach of an approved
 * control, not a security or reliability property.
 */
export const TRUST_DIMENSIONS = ["bias", "security", "privacy", "reliability", "safety", "compliance"] as const;
export type TrustDimension = (typeof TRUST_DIMENSIONS)[number];

export const TRUST_DIMENSION_LABELS: Readonly<Record<TrustDimension, string>> = {
  bias: "Bias",
  security: "Security",
  privacy: "Privacy",
  reliability: "Reliability",
  safety: "Safety",
  compliance: "Compliance",
};

export const RISK_CATEGORY_DIMENSION: Readonly<Record<AiRiskCategory, TrustDimension>> = {
  bias_fairness: "bias",
  tool_misuse: "security",
  prompt_injection: "security",
  over_permissioning: "security",
  data_leakage_pii: "privacy",
  hallucination: "reliability",
  scope_drift: "reliability",
  unsafe_output: "safety",
  shadow_ai: "compliance",
  third_party_ai: "compliance",
  budget_overrun: "compliance",
};

/**
 * The load-bearing honesty clause, a FIELD on every evidence payload rather
 * than a footer somebody can strip — the ADR-0058 pattern.
 */
export const AI_RISK_REGISTER_DISCLAIMER =
  "Evidence shown for a risk is computed live from this deployment's own ledgers at read time — " +
  "it measures what the platform recorded, not real-world exposure, and a quiet ledger is not " +
  "proof a risk is absent. Likelihood and impact are DECLARED human judgments and are never " +
  "blended into any computed number. A category no ledger measures is reported as " +
  "'none — attestation only' rather than approximated. Accepting a risk records a decision; it " +
  "changes no enforcement.";

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

const riskLevelSchema = z.enum(AI_RISK_LEVELS);

export const createRiskSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().min(1).max(4000),
  category: z.enum(AI_RISK_CATEGORIES),
  likelihood: riskLevelSchema,
  impact: riskLevelSchema,
  /** the mitigating control in prose — seeded from the library, editable */
  mitigation: z.string().max(4000).optional(),
  /** admins may assign an owner; everyone else owns what they register */
  ownerUserId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
  useCaseId: z.string().uuid().optional(),
  /** ADR-0084: the vendor whose assessment lifecycle evidences a
   * third-party risk — narrows the `vendor_assessments` resolver */
  vendorId: z.string().uuid().optional(),
});
export type CreateRiskInput = z.infer<typeof createRiskSchema>;

/** editable while open/mitigating. `status`, `category`, and every acceptance
 * field are NOT here on purpose — the gateway refuses a body naming them with
 * a 422 that points at the right endpoint, rather than silently dropping the
 * key */
export const updateRiskSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().min(1).max(4000).optional(),
  likelihood: riskLevelSchema.optional(),
  impact: riskLevelSchema.optional(),
  mitigation: z.string().max(4000).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  agentId: z.string().uuid().nullable().optional(),
  useCaseId: z.string().uuid().nullable().optional(),
  vendorId: z.string().uuid().nullable().optional(),
});
export type UpdateRiskInput = z.infer<typeof updateRiskSchema>;

/** `accepted` is conspicuously absent: residual-risk acceptance is its own
 * audited act with its own endpoint, never a transition among peers */
export const transitionRiskSchema = z.object({
  status: z.enum(["open", "mitigating", "closed"]),
  reason: z.string().min(1).max(2000),
});
export type TransitionRiskInput = z.infer<typeof transitionRiskSchema>;

/**
 * ADR-0147 — RESIDUAL position after controls. Still DECLARED (the same
 * three-level scale, never arithmetic): the registrant's judgment of where the
 * risk sits once the linked controls operate. Both or neither — a half-stated
 * residual is not a position. `null`/`null` clears it.
 */
export const setResidualRiskSchema = z
  .object({
    likelihood: riskLevelSchema.nullable(),
    impact: riskLevelSchema.nullable(),
  })
  .refine((v) => (v.likelihood === null) === (v.impact === null), {
    message: "residual likelihood and impact are set together or cleared together",
  });
export type SetResidualRiskInput = z.infer<typeof setResidualRiskSchema>;

/** ADR-0147 — link a mitigating control to a risk, by the pack control's
 * stable `controlRef` (e.g. `eu-ai-act:art-14-human-oversight`). The gateway
 * refuses a ref no seeded pack defines. */
export const linkRiskControlSchema = z.object({
  controlRef: z.string().min(3).max(200),
});
export type LinkRiskControlInput = z.infer<typeof linkRiskControlSchema>;

export const acceptRiskSchema = z.object({
  /** WHY the residual risk is acceptable — the substance of the record */
  note: z.string().min(1).max(4000),
});
export type AcceptRiskInput = z.infer<typeof acceptRiskSchema>;

// ---------------------------------------------------------------------------
// The seed risk library
// ---------------------------------------------------------------------------

export const riskLibraryEntrySchema = z
  .object({
    /** stable id for the seed entry — what the UI keys its picker on */
    key: z.string().min(1).max(120),
    title: z.string().min(1).max(300),
    description: z.string().min(1).max(4000),
    category: z.enum(AI_RISK_CATEGORIES),
    /** DECLARED starting judgments — a starting point for the registrant's
     * own call, not an output of any measurement */
    likelihood: riskLevelSchema,
    impact: riskLevelSchema,
    /** the mitigating control this deployment ACTUALLY enforces, in prose,
     * with ADR references — never a control we merely intend */
    mitigatingControl: z.string().min(1).max(4000),
    /** the resolver ids that evidence this entry — must be exactly the
     * category's fixed mapping (checked below), named here so the library is
     * readable on its own */
    evidenceResolvers: z.array(z.enum(RISK_EVIDENCE_RESOLVERS)).min(1),
  })
  .strict()
  .superRefine((e, ctx) => {
    const allowed = RISK_CATEGORY_EVIDENCE[e.category];
    for (const r of e.evidenceResolvers) {
      if (!allowed.includes(r)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `resolver '${r}' is not in category '${e.category}'s fixed evidence mapping — a ` +
            `library entry cannot shop for a flattering query`,
        });
      }
    }
    if (allowed.includes("none") && !(e.evidenceResolvers.length === 1 && e.evidenceResolvers[0] === "none")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `category '${e.category}' is attestation-only; its entry must name exactly ['none'] — ` +
          `pairing 'none' with a real resolver would dress an unmeasured risk as measured`,
      });
    }
    if (!allowed.includes("none") && e.evidenceResolvers.includes("none")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `category '${e.category}' is ledger-evidenced; 'none' does not belong in its entry`,
      });
    }
  });
export type RiskLibraryEntry = z.infer<typeof riskLibraryEntrySchema>;

/**
 * The curated default library — the agentic risks THIS deployment's ledgers
 * can evidence, each naming the control we actually enforce. Honest grading:
 * `scope-drift-beyond-approved-purpose` is deliberately attestation-only, the
 * control case for "the register never overclaims". These are rows a
 * registrant seeds a risk from, not doctrine: every judgment below is a
 * starting DECLARED position the owner is expected to revise.
 */
export const DEFAULT_RISK_LIBRARY: RiskLibraryEntry[] = [
  {
    key: "tool-misuse-destructive-calls",
    title: "An agent drives a governed tool destructively or off-purpose",
    description:
      "An entitled user's agent invokes an MCP tool, agent, or connector in a way that damages " +
      "data or systems — bulk deletes, mass writes, or calls far outside the task at hand.",
    category: "tool_misuse",
    likelihood: "medium",
    impact: "high",
    mitigatingControl:
      "Default-deny per-user tool-level entitlements gate every call (pillar 1), ABAC/Cedar " +
      "policies add attribute conditions on top (ADR-0040), and every denial lands in the one " +
      "audit trail — the governed-denial count below is that trail, live.",
    evidenceResolvers: ["governed_denials", "abac_policies"],
  },
  {
    key: "scope-drift-beyond-approved-purpose",
    title: "An approved use of AI drifts beyond its approved purpose",
    description:
      "A use case approved for one purpose is gradually applied to another — same agent, same " +
      "entitlements, different intent. No ledger in this deployment measures intent drift.",
    category: "scope_drift",
    likelihood: "medium",
    impact: "medium",
    mitigatingControl:
      "Procedural only, and said outright: the use-case registry records the approved purpose " +
      "(ADR-0080) and retirement is an audited act, but nothing measures whether day-to-day " +
      "usage still matches the questionnaire. Periodic human re-review is the control, and it " +
      "is the customer's own.",
    evidenceResolvers: ["none"],
  },
  {
    key: "prompt-injection-defeats-instructions",
    title: "Adversarial input steers a model past its instructions",
    description:
      "Direct or indirect prompt injection makes an agent ignore its system prompt, exfiltrate " +
      "context, or take attacker-directed actions.",
    category: "prompt_injection",
    likelihood: "high",
    impact: "high",
    mitigatingControl:
      "Runtime prompt-injection detection with a configurable block mode (ADR-0042), measured " +
      "by red-team runs whose pooled attack-success rate carries its trial denominator and a " +
      "measurement-quality label (ADR-0057/ADR-0068) — the ASR shown below is that statistic, " +
      "verbatim, never re-derived.",
    evidenceResolvers: ["redteam_asr", "guardrail_config"],
  },
  {
    key: "pii-leaves-through-prompt-or-connector",
    title: "PII/PHI leaves the organization through a prompt or connector",
    description:
      "Personal or regulated data is pasted into a prompt or pulled through a connector and " +
      "reaches a model provider or third party it should not.",
    category: "data_leakage_pii",
    likelihood: "medium",
    impact: "high",
    mitigatingControl:
      "The §8.3 compliance cascade forces PII block mode on classified projects (ADR-0019), " +
      "and every block the gateway performs writes a `pii-blocked` denial to the audit trail — " +
      "both the configuration and the event trail are shown below.",
    evidenceResolvers: ["pii_denials", "pii_cascade_config"],
  },
  {
    key: "standing-grants-exceed-need",
    title: "Standing grants exceed what people actually need",
    description:
      "Tool, agent, and connector grants accumulate; nobody removes what is no longer used, " +
      "and the blast radius of any one compromised account grows with them.",
    category: "over_permissioning",
    likelihood: "medium",
    impact: "medium",
    mitigatingControl:
      "Grants are per-user and tool-level (pillar 1) so the inventory below is exact, not " +
      "role-approximate; ABAC policies (ADR-0040) narrow standing grants with attribute " +
      "conditions. Reviewing the inventory is the control — the register shows it live.",
    evidenceResolvers: ["active_grants", "abac_policies"],
  },
  {
    key: "spend-exceeds-authorization",
    title: "AI spend exceeds what anyone authorized",
    description:
      "Agent traffic, orchestration runs, or shared keys burn budget past the approved " +
      "ceiling before anyone notices.",
    category: "budget_overrun",
    likelihood: "medium",
    impact: "medium",
    mitigatingControl:
      "Budget ceilings are enforced at the gateway, not reported after the fact: project caps, " +
      "orchestration run/node caps, and virtual-key budgets each refuse the call that would " +
      "exceed them (pillar 5), and every refusal is an audited deny — counted below per " +
      "enforcement point.",
    evidenceResolvers: ["budget_refusals"],
  },
  {
    key: "ungrounded-output-relied-upon",
    title: "Ungrounded model output is relied upon as fact",
    description:
      "An agent asserts things its retrieved sources do not support, and the output is used " +
      "in a decision, a document, or a customer answer.",
    category: "hallucination",
    likelihood: "high",
    impact: "medium",
    mitigatingControl:
      "Groundedness evaluation (claim support, context precision/recall, answer relevance — " +
      "ADR-0067) run through the ADR-0044 eval harness, with runs and pass rates in the eval " +
      "ledger below. Measurement, not prevention — and the register says which.",
    evidenceResolvers: ["groundedness_evals"],
  },
  {
    key: "ai-usage-outside-the-gateway",
    title: "AI is used outside the gateway entirely",
    description:
      "Teams call model providers directly — personal keys, unsanctioned SaaS — so none of " +
      "the platform's controls apply and none of its ledgers see the traffic.",
    category: "shadow_ai",
    likelihood: "medium",
    impact: "high",
    mitigatingControl:
      "Shadow-AI discovery imports network/SaaS/repo signals into a findings ledger with " +
      "severity, disposition, and an audited remediation path onto the platform (ADR-0071). " +
      "The open-vs-total findings below are that ledger, live.",
    evidenceResolvers: ["shadow_findings"],
  },
  {
    key: "third-party-ai-unassessed-vendor",
    title: "A third party's AI reaches our data without an assessed vendor behind it",
    description:
      "A model provider, an AI-featured product, or a data processor runs AI over our data " +
      "with no recorded assessment of what it runs, what it sees, and who its subprocessors " +
      "are — third-party exposure nobody signed off on.",
    category: "third_party_ai",
    likelihood: "medium",
    impact: "high",
    mitigatingControl:
      "The AI vendor registry (ADR-0084): a vendor is a governed object whose assessment " +
      "rides the pillar-2 rails — questionnaire artifact, human sign-off on the one approvals " +
      "queue — and the assessment-state counts below are that lifecycle, live. Honest limit, " +
      "said outright: the platform verifies that assessments HAPPENED and were decided; the " +
      "answers inside them are vendor attestations, never platform-verified facts.",
    evidenceResolvers: ["vendor_assessments"],
  },
  {
    key: "bias-unfair-outcomes-across-groups",
    title: "Outcomes differ unfairly across protected groups",
    description:
      "A model or agent that informs decisions about people (credit, hiring, eligibility, " +
      "pricing) produces systematically different outcomes for comparable people in different " +
      "groups. This deployment does not compute disparity metrics itself.",
    category: "bias_fairness",
    likelihood: "medium",
    impact: "high",
    mitigatingControl:
      "Model risk management (ADR-0063) requires a model card with a documented bias/fairness " +
      "assessment before an agent is dispatchable; the evidence below counts those DOCUMENTED " +
      "assessments by status. The assessment itself — data, method, thresholds — is the card " +
      "author's attestation, not a measurement this platform performed.",
    evidenceResolvers: ["model_card_fairness"],
  },
  {
    key: "unsafe-or-toxic-output",
    title: "The system emits harmful, toxic or jailbreak-induced content",
    description:
      "A user or an injected document steers the model into producing abusive, dangerous or " +
      "policy-violating output that reaches a person or a downstream system.",
    category: "unsafe_output",
    likelihood: "medium",
    impact: "high",
    mitigatingControl:
      "ADR-0042 guardrails run toxicity and jailbreak detection on the governed path; at 'block' " +
      "the output is withheld before release. Evidence: how many guardrail configs hold these " +
      "detectors at block, and how many blocks the gateway actually performed in the window.",
    evidenceResolvers: ["output_safety_config", "guardrail_blocks"],
  },
];

// ---------------------------------------------------------------------------
// ADR-0180 §6 (A10) — risk tolerance and time-boxed acceptance, the pure half.
// The gateway half (routes, `residualPosition`, the expiry sweep, the monitor
// loader) is `apps/gateway/src/risk-tolerance.ts`.
// ---------------------------------------------------------------------------

/** a compensating control named beside an acceptance: an optional pack
 * control ref and what it does, in prose (the gateway scrubs the prose) */
export const compensatingControlSchema = z
  .object({
    controlRef: z.string().trim().min(3).max(200).nullable().optional(),
    description: z.string().trim().min(1).max(1000),
  })
  .strict();
export type CompensatingControlInput = z.infer<typeof compensatingControlSchema>;

/** `POST /v1/risks/:riskId/acceptances`. `expiresAt` absent = the longest the
 * residual band allows (6 calendar months for high/critical, 12 otherwise);
 * one beyond that is refused, never clamped. */
export const createRiskAcceptanceSchema = z
  .object({
    responseType: z.enum(RISK_RESPONSE_TYPES),
    rationale: z.string().trim().min(10).max(4000),
    compensatingControls: z.array(compensatingControlSchema).max(20).default([]),
    expiresAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type CreateRiskAcceptanceInput = z.infer<typeof createRiskAcceptanceSchema>;

/** the categories and review tiers a tolerance may be scoped to */
export const RISK_TOLERANCE_SCOPE_KEYS: Readonly<Record<RiskToleranceScopeKind, readonly string[]>> = {
  category: AI_RISK_CATEGORIES,
  tier: REVIEW_POLICY_TIER_KEYS,
};

/** `PUT /v1/risk-tolerances` — the WHOLE configured set; an empty list returns
 * the org to the strict default in code */
export const putRiskTolerancesSchema = z
  .object({
    tolerances: z
      .array(
        z
          .object({
            scopeKind: z.enum(RISK_TOLERANCE_SCOPE_KINDS),
            scopeKey: z.string().min(1).max(64),
            maxBand: z.enum(TOLERANCE_BANDS),
          })
          .strict(),
      )
      .max(AI_RISK_CATEGORIES.length + REVIEW_POLICY_TIER_KEYS.length),
  })
  .strict()
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.tolerances.forEach((t, i) => {
      if (!RISK_TOLERANCE_SCOPE_KEYS[t.scopeKind].includes(t.scopeKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tolerances", i, "scopeKey"],
          message: `'${t.scopeKey}' is not a known ${t.scopeKind}`,
        });
      }
      const k = `${t.scopeKind}:${t.scopeKey}`;
      if (seen.has(k)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tolerances", i],
          message: `${t.scopeKind} '${t.scopeKey}' is listed twice`,
        });
      }
      seen.add(k);
    });
  });
export type PutRiskTolerancesInput = z.infer<typeof putRiskTolerancesSchema>;

/** `months` calendar months after `from`, in UTC, clamped to the last day of
 * the target month (31 Aug + 6 months = 28/29 Feb, never 2/3 Mar), so a cap of
 * "6 months" never runs past six calendar months. Native Date on purpose: the
 * package carries no date library, and `addMonthsUtc` elsewhere rolls over. */
export function addCalendarMonthsUtc(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/** the latest an acceptance of residual risk at `band`, made at `acceptedAt`, may expire */
export function maxAcceptanceExpiry(band: ResidualRiskBand, acceptedAt: Date): Date {
  return addCalendarMonthsUtc(acceptedAt, maxAcceptanceMonths(band));
}

/** true when residual risk at `band` sits above a tolerance of `max` */
export function bandExceedsTolerance(band: ResidualRiskBand, max: ToleranceBand): boolean {
  return TOLERANCE_BANDS.indexOf(band) > TOLERANCE_BANDS.indexOf(max);
}

/** true when an acceptance recorded at `accepted` still covers residual risk at `band` */
export function acceptanceCoversBand(accepted: ResidualRiskBand, band: ResidualRiskBand): boolean {
  return RESIDUAL_RISK_BANDS.indexOf(accepted) >= RESIDUAL_RISK_BANDS.indexOf(band);
}

export interface ToleranceRowInput {
  scopeKind: RiskToleranceScopeKind;
  scopeKey: string;
  maxBand: ToleranceBand;
}

/**
 * The tolerance that applies to one risk. With no configured row for its
 * category or its use case's tier, the STRICT DEFAULT in code applies
 * (`ASSURANCE_DEFAULTS.toleranceMaxBand`, medium). With rows for both, the
 * STRICTER wins (secure by default: relaxing one scope never relaxes another);
 * on a tie the category row is named.
 */
export function resolveRiskTolerance(
  rows: readonly ToleranceRowInput[],
  risk: { category: string; tier: string | null },
): { band: ToleranceBand; source: "default" | "category" | "tier" } {
  const matches: Array<{ band: ToleranceBand; source: "category" | "tier" }> = [];
  const cat = rows.find((r) => r.scopeKind === "category" && r.scopeKey === risk.category);
  if (cat) matches.push({ band: cat.maxBand, source: "category" });
  const tier = risk.tier !== null ? rows.find((r) => r.scopeKind === "tier" && r.scopeKey === risk.tier) : undefined;
  if (tier) matches.push({ band: tier.maxBand, source: "tier" });
  if (matches.length === 0) return { band: ASSURANCE_DEFAULTS.toleranceMaxBand, source: "default" };
  return matches.reduce((a, b) => (TOLERANCE_BANDS.indexOf(b.band) < TOLERANCE_BANDS.indexOf(a.band) ? b : a));
}
