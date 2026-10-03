/**
 * ADR-0149 — THE INTAKE ASSISTANT'S DETERMINISTIC HALF.
 *
 * ADR-0080 refused AI pre-fill of the intake questionnaire: with no model
 * credential, a "pre-filled" form would be mechanism-without-instrument. This
 * module is what makes an assistant honest anyway. Every suggestion here is a
 * RULE over the proposer's own structured answers — reviewable in code,
 * unit-tested, identical with or without a model — and each one says which
 * rule produced it. The optional model-drafted prose (gateway side) only ever
 * rewrites narrative text, is labelled with its provider, and is never needed.
 *
 * Nothing here decides anything:
 *  - the TIER is the existing ADR-0085 classifier over the same strict
 *    answers the server will screen on submission, so the preview and the
 *    stored screening cannot disagree;
 *  - FRAMEWORKS, RISKS and CONTROLS are suggestions the proposer accepts,
 *    edits or rejects; the gateway writes nothing until they submit.
 */
import { z } from "zod";
import { DEFAULT_COMPLIANCE_PACKS } from "./compliance-packs.js";
import {
  EU_AI_ACT_SCREENING_DISCLAIMER,
  classifyEuAiActTier,
  euAiActAnswersSchema,
  renderEuAiActAnswersBlock,
  type EuAiActAnswers,
} from "./eu-ai-act.js";
import {
  DEFAULT_RISK_LIBRARY,
  RISK_CATEGORY_DIMENSION,
  type AiRiskCategory,
  type AiRiskLevel,
  type TrustDimension,
} from "./risks.js";

export const INTAKE_SECTORS = [
  "financial-services",
  "securities-broker-dealer",
  "healthcare",
  "payments",
  "public-sector",
  "general",
] as const;
export const INTAKE_DATA_CATEGORIES = [
  "personal",
  "sensitive-personal",
  "health",
  "payment-card",
  "financial",
  "proprietary",
  "public",
] as const;
export const INTAKE_DEPLOYMENTS = ["internal", "customer-facing", "public"] as const;

/** the registration Classify step's context answers (beyond the EU AI Act set) */
export const intakeContextShape = {
  sectors: z.array(z.enum(INTAKE_SECTORS)).max(6).default([]),
  dataCategories: z.array(z.enum(INTAKE_DATA_CATEGORIES)).max(7).default([]),
  deployment: z.enum(INTAKE_DEPLOYMENTS),
  /** placed on the EU market or affecting people in the EU */
  euNexus: z.boolean(),
  /** a third party's model or service is in the path */
  usesExternalVendor: z.boolean(),
  /** produces free-form text/images rather than a score or label */
  generative: z.boolean(),
  /** an agent takes actions through tools, not only answers */
  autonomousActions: z.boolean(),
  toolsUsed: z.array(z.string().min(1).max(200)).max(50).default([]),
};
export const intakeContextSchema = z.object(intakeContextShape).strict();

/**
 * ADR-0168 amendment — EVERY answer the registration Classify step collects,
 * as ONE flat object: the EU AI Act screening answers plus the context
 * answers. Stored with the use case at registration (`screeningAnswers` on
 * `POST /v1/use-cases`, optional) so a sent-back use case can be resubmitted
 * prefilled; `PATCH` in `needs_info` takes the same set and recomputes the
 * tier (from the EU keys) and `dataSensitivity` (from `dataCategories`).
 */
export const intakeScreeningAnswersSchema = euAiActAnswersSchema.extend(intakeContextShape).strict();
export type IntakeScreeningAnswers = z.infer<typeof intakeScreeningAnswersSchema>;

/** PATCH form: the EU keys are required (the tier is recomputed from them);
 * context keys may be omitted, and an omitted key keeps its stored value */
export const intakeScreeningAnswersPatchSchema = euAiActAnswersSchema
  .extend({
    sectors: intakeContextShape.sectors.removeDefault().optional(),
    dataCategories: intakeContextShape.dataCategories.removeDefault().optional(),
    deployment: intakeContextShape.deployment.optional(),
    euNexus: intakeContextShape.euNexus.optional(),
    usesExternalVendor: intakeContextShape.usesExternalVendor.optional(),
    generative: intakeContextShape.generative.optional(),
    autonomousActions: intakeContextShape.autonomousActions.optional(),
    toolsUsed: intakeContextShape.toolsUsed.removeDefault().optional(),
  })
  .strict();

/**
 * AER-042 — a use case's `dataSensitivity` from its declared data categories,
 * the same rule the registration wizard applies. FAIL CLOSED: no categories
 * (or an unknown one) is the strictest level.
 */
export function deriveDataSensitivityFromCategories(
  categories: readonly string[],
): "public" | "internal" | "confidential" | "regulated" {
  const order = ["public", "internal", "confidential", "regulated"] as const;
  const levelFor: Record<string, (typeof order)[number]> = {
    health: "regulated",
    "sensitive-personal": "regulated",
    "payment-card": "regulated",
    financial: "regulated",
    personal: "confidential",
    proprietary: "confidential",
    public: "public",
  };
  if (categories.length === 0) return "regulated";
  let worst = 0;
  for (const c of categories) {
    const level = levelFor[c];
    if (!level) return "regulated";
    worst = Math.max(worst, order.indexOf(level));
  }
  return order[worst]!;
}

export const intakeAssistRequestSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(8000),
    /** the SAME strict answers ADR-0085 screens on — never a tier */
    euAiAct: euAiActAnswersSchema,
    context: intakeContextSchema,
    /** ask the governed model to rewrite the narrative sections (gateway) */
    draftNarrative: z.boolean().default(false),
    /** the registry agent to draft with — entitlement-checked like any invoke */
    agentId: z.string().uuid().optional(),
  })
  .strict();
export type IntakeAssistRequest = z.infer<typeof intakeAssistRequestSchema>;

export type SuggestionSource = "rules" | "model" | "mock";

export interface FrameworkSuggestion {
  framework: string;
  title: string;
  why: string;
  source: "rules";
}

export interface RiskSuggestion {
  scenarioKey: string;
  title: string;
  description: string;
  category: AiRiskCategory;
  dimension: TrustDimension;
  likelihood: AiRiskLevel;
  impact: AiRiskLevel;
  /** real `controlRef`s from the seeded packs, filtered to suggested frameworks */
  suggestedControls: string[];
  why: string;
  source: "rules";
}

export interface QuestionnaireSectionDraft {
  id: string;
  heading: string;
  text: string;
  source: SuggestionSource;
}

/** the questionnaire's eight narrative sections (§9 is the structured block) */
export const INTAKE_SECTIONS = [
  { id: "purpose", heading: "1. Purpose and business context" },
  { id: "users", heading: "2. Users and affected parties" },
  { id: "data", heading: "3. Data" },
  { id: "models", heading: "4. Models and agents" },
  { id: "compliance", heading: "5. Compliance obligations" },
  { id: "risks", heading: "6. Risks and mitigations" },
  { id: "oversight", heading: "7. Rollout and human oversight" },
  { id: "decommission", heading: "8. Decommission criteria" },
] as const;

/**
 * Mitigating controls a risk category is suggested with, by stable pack
 * `controlRef`. Every ref is asserted to exist by the test; a suggestion is
 * then narrowed to the frameworks actually suggested for this use case.
 */
export const CATEGORY_SUGGESTED_CONTROLS: Readonly<Record<AiRiskCategory, readonly string[]>> = {
  bias_fairness: ["eu-ai-act:art-9-risk-management-system", "iso-42001:8.3-ai-system-impact-assessment", "nist-ai-rmf:MEASURE-2.7"],
  unsafe_output: ["soc-2:CC7.2-monitoring", "eu-ai-act:art-15-accuracy-robustness"],
  prompt_injection: ["soc-2:CC7.2-monitoring", "eu-ai-act:art-15-accuracy-robustness"],
  data_leakage_pii: ["iso-27001:A.8.12", "soc-2:CC6.7-data-movement", "hipaa:164.312(a)(1)-access-control"],
  tool_misuse: ["nist-ai-rmf:MANAGE-2.2", "soc-2:CC6.1-logical-access", "eu-ai-act:art-14-human-oversight"],
  over_permissioning: ["iso-27001:A.5.15", "nist-ai-rmf:GOVERN-1.2", "pci-dss:7.2.1-least-privilege"],
  hallucination: ["eu-ai-act:art-15-accuracy-robustness", "nist-ai-rmf:MEASURE-2.7"],
  scope_drift: ["eu-ai-act:art-72-post-market-monitoring", "iso-42001:9.1-monitoring-measurement"],
  budget_overrun: ["iso-42001:9.1-monitoring-measurement"],
  shadow_ai: ["nist-ai-rmf:MAP-4.1", "iso-42001:A.6-ai-system-lifecycle"],
  third_party_ai: ["soc-2:CC9.2-vendor-risk", "nist-ai-rmf:MAP-4.1"],
};

const LIB = new Map(DEFAULT_RISK_LIBRARY.map((e) => [e.category, e]));
const PACK_TITLE = new Map(DEFAULT_COMPLIANCE_PACKS.map((p) => [p.framework, p.title]));

type Rule = { category: AiRiskCategory; why: (r: IntakeAssistRequest) => string | null; impact?: AiRiskLevel };

/** One rule per category; a rule returns WHY it fired, or null. */
const RISK_RULES: readonly Rule[] = [
  {
    category: "bias_fairness",
    why: (r) =>
      r.euAiAct.profilesNaturalPersons ||
      ["employment-hr", "education", "essential-services"].includes(r.euAiAct.purposeDomain)
        ? "the system evaluates or ranks people (profiling or an Annex III decision domain)"
        : null,
  },
  {
    category: "data_leakage_pii",
    why: (r) =>
      r.context.dataCategories.some((d) => ["personal", "sensitive-personal", "health", "payment-card", "financial"].includes(d))
        ? `it processes ${r.context.dataCategories.filter((d) => d !== "public" && d !== "proprietary").join(", ")} data`
        : null,
  },
  {
    category: "prompt_injection",
    why: (r) =>
      r.context.generative && r.context.deployment !== "internal"
        ? "a generative system takes untrusted input from outside the organisation"
        : null,
  },
  {
    category: "unsafe_output",
    why: (r) =>
      r.context.generative && (r.context.deployment !== "internal" || r.euAiAct.affectedPersons.includes("vulnerable-groups"))
        ? "generated output reaches customers, the public or vulnerable people"
        : null,
  },
  {
    category: "hallucination",
    why: (r) => (r.context.generative ? "it generates free-form content that can be wrong yet plausible" : null),
  },
  {
    category: "tool_misuse",
    why: (r) =>
      r.context.autonomousActions
        ? `an agent acts through tools${r.context.toolsUsed.length ? ` (${r.context.toolsUsed.slice(0, 5).join(", ")})` : ""}`
        : null,
  },
  {
    category: "over_permissioning",
    why: (r) =>
      r.context.autonomousActions && r.context.toolsUsed.length >= 3
        ? `${r.context.toolsUsed.length} tools are in scope — standing grants tend to outgrow need`
        : null,
  },
  {
    category: "third_party_ai",
    why: (r) => (r.context.usesExternalVendor ? "a third party's model or service is in the path" : null),
  },
  {
    category: "scope_drift",
    why: (r) =>
      r.euAiAct.decisionAutonomy === "fully-automated" || r.context.autonomousActions
        ? "decisions or actions run without a per-case human check, so purpose drift goes unnoticed"
        : null,
  },
];

const RANK: Record<AiRiskLevel, number> = { low: 0, medium: 1, high: 2 };
const raise = (l: AiRiskLevel): AiRiskLevel => (l === "low" ? "medium" : "high");

export interface IntakeSuggestions {
  tier: {
    value: "prohibited" | "high" | "limited" | "minimal";
    reasons: Array<{ ruleId: string; tier: string; ref: string; reason: string }>;
    rulesetVersion: number;
    source: "rules";
    disclaimer: string;
  };
  frameworks: FrameworkSuggestion[];
  risks: RiskSuggestion[];
  /** the ADR-0085 fenced answers block, ready to paste into §9 */
  euAiActBlock: string;
  questionnaire: QuestionnaireSectionDraft[];
  blocking: string | null;
}

export function suggestIntake(req: IntakeAssistRequest): IntakeSuggestions {
  const tierResult = classifyEuAiActTier(req.euAiAct as EuAiActAnswers);
  const tier = tierResult.tier;

  // --- frameworks -----------------------------------------------------------
  const fw: FrameworkSuggestion[] = [];
  const add = (framework: string, why: string) => {
    if (fw.some((f) => f.framework === framework)) return;
    fw.push({ framework, title: PACK_TITLE.get(framework) ?? framework, why, source: "rules" });
  };
  if (req.context.euNexus) add("eu-ai-act", `EU nexus; screened tier '${tier}'`);
  add("nist-ai-rmf", "baseline AI risk-management framework for every AI system");
  add("iso-42001", "AI management-system controls for the system's lifecycle");
  const personal = req.context.dataCategories.some((d) => ["personal", "sensitive-personal", "health", "payment-card", "financial"].includes(d));
  if (personal || req.context.deployment !== "internal") add("soc-2", "customer data or customer-facing service");
  if (personal) add("iso-27001", "information-security controls over personal or financial data");
  if (req.context.dataCategories.includes("health") || req.context.sectors.includes("healthcare")) add("hipaa", "health data or healthcare sector");
  if (req.context.dataCategories.includes("payment-card") || req.context.sectors.includes("payments")) add("pci-dss", "payment-card data or payments sector");
  if (req.context.sectors.includes("securities-broker-dealer")) add("finra", "securities broker-dealer supervision obligations");
  const suggested = new Set(fw.map((f) => f.framework));

  // --- risks ----------------------------------------------------------------
  const highStakes = tier === "high" || tier === "prohibited";
  const risks: RiskSuggestion[] = [];
  for (const rule of RISK_RULES) {
    const why = rule.why(req);
    if (!why) continue;
    const entry = LIB.get(rule.category);
    if (!entry) continue;
    // DECLARED starting points from the library, raised one step for a
    // high-tier system's impact — a suggestion the proposer can change
    const impact = highStakes && RANK[entry.impact] < 2 ? raise(entry.impact) : entry.impact;
    risks.push({
      scenarioKey: entry.key,
      title: entry.title,
      description: entry.description,
      category: rule.category,
      dimension: RISK_CATEGORY_DIMENSION[rule.category],
      likelihood: entry.likelihood,
      impact,
      suggestedControls: CATEGORY_SUGGESTED_CONTROLS[rule.category].filter((ref) =>
        suggested.has(ref.split(":")[0]!),
      ),
      why,
      source: "rules",
    });
  }

  return {
    tier: {
      value: tier,
      reasons: tierResult.reasons.map((r) => ({ ruleId: r.ruleId, tier: r.tier, ref: r.ref, reason: r.reason })),
      rulesetVersion: tierResult.rulesetVersion,
      source: "rules",
      disclaimer: EU_AI_ACT_SCREENING_DISCLAIMER,
    },
    frameworks: fw,
    risks,
    euAiActBlock: renderEuAiActAnswersBlock(req.euAiAct as EuAiActAnswers),
    questionnaire: composeQuestionnaireDraft(req, tier, fw, risks),
    blocking:
      tier === "prohibited"
        ? "The screening places this use case in the EU AI Act's PROHIBITED tier. It cannot be approved as described; change the design or record the rejection."
        : null,
  };
}

/** A first draft of each narrative section, composed ONLY from the proposer's
 * own answers — every sentence traces to a field they set. */
export function composeQuestionnaireDraft(
  req: IntakeAssistRequest,
  tier: string,
  frameworks: FrameworkSuggestion[],
  risks: RiskSuggestion[],
): QuestionnaireSectionDraft[] {
  const c = req.context;
  const a = req.euAiAct;
  const list = (xs: readonly string[], none: string) => (xs.length ? xs.join(", ") : none);
  const text: Record<string, string> = {
    purpose: `${req.title}. ${req.description.trim()}`,
    users:
      `Deployment: ${c.deployment}. Affected persons: ${list(a.affectedPersons, "no natural persons")}. ` +
      `Sectors: ${list(c.sectors, "not specified")}.` +
      (a.affectedPersons.includes("vulnerable-groups") ? " Vulnerable groups are affected." : ""),
    data: `Data categories: ${list(c.dataCategories, "none declared")}.` + (a.profilesNaturalPersons ? " The system profiles natural persons." : ""),
    models:
      (c.usesExternalVendor ? "A third-party model or service is in the path. " : "No third-party model declared. ") +
      (c.autonomousActions ? `An agent takes actions through tools: ${list(c.toolsUsed, "tools not yet listed")}.` : "The system answers; it does not act through tools."),
    compliance:
      `Screened EU AI Act tier: ${tier}. Suggested frameworks: ${frameworks.map((f) => f.framework).join(", ")}.`,
    risks: risks.length
      ? risks.map((r) => `- ${r.title} (${r.dimension}; declared ${r.likelihood} likelihood / ${r.impact} impact) — because ${r.why}.`).join("\n")
      : "No rule-based risk was triggered by the answers; record any you know of.",
    oversight: `Decision autonomy: ${a.decisionAutonomy}.` +
      (a.decisionAutonomy === "fully-automated" ? " No per-case human review — name the person who monitors outcomes." : " A named person reviews before outcomes take effect."),
    decommission: "Re-review on any change of model, purpose, data categories or affected persons; retire if monitoring shows sustained harm or drift.",
  };
  return INTAKE_SECTIONS.map((s) => ({ id: s.id, heading: s.heading, text: text[s.id] ?? "", source: "rules" as const }));
}

/** the prompt the gateway sends when a model draft is requested */
export function buildIntakeNarrativePrompt(req: IntakeAssistRequest, draft: QuestionnaireSectionDraft[]): string {
  return [
    "You are helping a person complete an AI use-case intake questionnaire.",
    "Rewrite each section below as clear, specific prose for a governance reviewer.",
    "Use ONLY facts present in the section text and the description. Do not add facts, numbers, vendors or controls.",
    'Reply with JSON only: {"sections":[{"id":"purpose","text":"..."}, ...]} using the same ids.',
    "",
    `Description: ${req.description}`,
    "",
    ...draft.map((s) => `[${s.id}] ${s.text}`),
  ].join("\n");
}

/** parse a model reply into section texts; unknown ids and non-strings dropped */
export function parseIntakeNarrative(output: string): Record<string, string> | null {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(output.slice(start, end + 1)) as { sections?: Array<{ id?: unknown; text?: unknown }> };
    if (!Array.isArray(parsed.sections)) return null;
    const ids = new Set<string>(INTAKE_SECTIONS.map((s) => s.id));
    const out: Record<string, string> = {};
    for (const s of parsed.sections) {
      if (typeof s.id === "string" && ids.has(s.id) && typeof s.text === "string" && s.text.trim()) {
        out[s.id] = s.text.trim().slice(0, 6000);
      }
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/**
 * The questionnaire document a proposer submits as the intake artifact:
 * the eight narrative sections plus §9 with the ADR-0085 answers block. One
 * renderer for the wizard (X1) and the demo seeder (C6), so both submit the
 * shape the server's tier extractor reads.
 */
export function renderQuestionnaireMarkdown(
  sections: ReadonlyArray<Pick<QuestionnaireSectionDraft, "heading" | "text">>,
  euAiActBlock: string,
): string {
  return [
    "# AI use-case intake questionnaire",
    "",
    ...sections.flatMap((s) => [`## ${s.heading}`, s.text.trim(), ""]),
    "## 9. EU AI Act risk screening (structured, ADR-0085)",
    euAiActBlock.trim(),
    "",
  ].join("\n");
}
