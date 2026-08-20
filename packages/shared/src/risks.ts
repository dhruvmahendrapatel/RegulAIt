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
];
