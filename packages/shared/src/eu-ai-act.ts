/**
 * ADR-0085 — EU AI ACT RISK-TIER SCREENING, the pure half (gap L10,
 * docs/product/GAP_ANALYSIS_FOUR_VENDORS_2026-08.md).
 *
 *   THIS FILE                        the questionnaire vocabulary, the frozen
 *                                    rule set, the deterministic classifier,
 *                                    the answers-block parser, the disclaimer.
 *                                    Pure — no db, no clock, no network.
 *   `apps/gateway/src/use-cases.ts`  computes and stores the tier on the
 *                                    ADR-0080 use case whenever the intake
 *                                    questionnaire artifact lands, and derives
 *                                    the cascade-facing consequences live.
 *
 * WHAT THIS IS: A CALCULATOR, NOT A LAWYER. `classifyEuAiActTier` maps a
 * small structured questionnaire onto the four tiers of Regulation (EU)
 * 2024/1689 (prohibited / high / limited / minimal) using rules compiled into
 * the build — the ADR-0068/ADR-0083 frozen-corpus discipline. Every rule is
 * PLAIN DATA (field/op/value conditions, no functions, no regex), so the
 * rule set is hash-pinnable and a tier is exactly reproducible from the
 * answers plus the rule-set version, forever.
 *
 * WHY FROZEN: a stored "high @ ruleset v1" must mean the same thing in two
 * years. `EU_AI_ACT_RULESET_V1` is deep-frozen and the shared suite pins its
 * rule count AND a content hash. Guidance will evolve and the encoding will
 * date — that is a NEW VERSION alongside v1, never an in-place edit under
 * rows already stamped v1.
 *
 * HONESTY, stated where the code lives:
 *   - The rules encode a SUBSET of the Act (Art. 5 prohibitions, Annex III
 *     high-risk areas via Art. 6, Art. 50 transparency). Exemptions,
 *     derogations and sector nuance are NOT fully encoded; the Art. 6(3)
 *     narrow-procedural screen here is a screening approximation of a
 *     derogation that legally requires a documented assessment.
 *   - The answers are SELF-REPORTED by the proposer. The classifier cannot
 *     see what the system actually does.
 *   - A tier INFORMS the human sign-off on the one approvals queue. Nothing
 *     is auto-blocked by a tier — stating otherwise would overclaim
 *     enforcement the platform does not do (the ADR-0080 honesty).
 */
import { z } from "zod";

// ===========================================================================
// 1. THE VOCABULARY — tiers, questionnaire fields
// ===========================================================================

export const EU_AI_ACT_RULESET_VERSION = 1;

export const EU_AI_ACT_TIERS = ["prohibited", "high", "limited", "minimal"] as const;
export type EuAiActTier = (typeof EU_AI_ACT_TIERS)[number];

/** dominance order: prohibited > high > limited > minimal */
export const EU_AI_ACT_TIER_RANK: Record<EuAiActTier, number> = {
  prohibited: 3,
  high: 2,
  limited: 1,
  minimal: 0,
};

/**
 * Where the system is used. The first seven are the Annex III high-risk
 * areas this rule set encodes; the last two exist so "none of the above" is
 * an explicit answer rather than a missing one.
 */
export const EU_AI_ACT_PURPOSE_DOMAINS = [
  "employment-hr",
  "education",
  "essential-services",
  "law-enforcement",
  "migration-border",
  "justice-democracy",
  "critical-infrastructure",
  "general-business",
  "internal-productivity",
] as const;
export type EuAiActPurposeDomain = (typeof EU_AI_ACT_PURPOSE_DOMAINS)[number];

/** the Annex III subset of the domains above (Art. 6(2) route to high) */
export const EU_AI_ACT_ANNEX_III_DOMAINS = [
  "employment-hr",
  "education",
  "essential-services",
  "law-enforcement",
  "migration-border",
  "justice-democracy",
  "critical-infrastructure",
] as const;

/** who the system's outputs reach or affect — multi-select; empty means no
 * natural persons are affected (a build pipeline, an infra optimizer) */
export const EU_AI_ACT_AFFECTED_PERSONS = [
  "employees",
  "customers",
  "general-public",
  "vulnerable-groups",
] as const;
export type EuAiActAffectedPersons = (typeof EU_AI_ACT_AFFECTED_PERSONS)[number];

/**
 * How much of the decision the system holds. `narrow-procedural` is the
 * Art. 6(3) screen: a narrow procedural/preparatory task that does not
 * materially influence the decision outcome — the one answer that can keep
 * an Annex III domain out of the high tier (profiling excepted, per the
 * final subparagraph of Art. 6(3)).
 */
export const EU_AI_ACT_DECISION_AUTONOMY = [
  "narrow-procedural",
  "informs-human",
  "human-reviews",
  "fully-automated",
] as const;
export type EuAiActDecisionAutonomy = (typeof EU_AI_ACT_DECISION_AUTONOMY)[number];

/** biometric use. `verification` (1:1 unlock/login) is deliberately its own
 * answer because the Act's remote-biometric definitions exclude it. */
export const EU_AI_ACT_BIOMETRIC_USES = ["none", "verification", "remote-identification"] as const;
export type EuAiActBiometricUse = (typeof EU_AI_ACT_BIOMETRIC_USES)[number];

/**
 * The structured screening answers. STRICT on purpose: an unknown key —
 * above all a smuggled `tier` — refuses the whole block, because the tier is
 * computed server-side from the answers and never accepted from a payload.
 */
export const euAiActAnswersSchema = z
  .object({
    purposeDomain: z.enum(EU_AI_ACT_PURPOSE_DOMAINS),
    affectedPersons: z.array(z.enum(EU_AI_ACT_AFFECTED_PERSONS)).max(4).default([]),
    decisionAutonomy: z.enum(EU_AI_ACT_DECISION_AUTONOMY),
    biometricUse: z.enum(EU_AI_ACT_BIOMETRIC_USES),
    /** infers emotions of natural persons from biometric data */
    emotionRecognition: z.boolean(),
    /** scores/ranks natural persons by social behaviour or personal traits
     * with detrimental treatment in unrelated contexts */
    socialScoring: z.boolean(),
    /** subliminal, purposefully manipulative or deceptive techniques that
     * materially distort behaviour, or exploitation of vulnerabilities */
    manipulativeTechniques: z.boolean(),
    /** profiling of natural persons (automated evaluation of personal
     * aspects) — Art. 6(3) removes the derogation when this is true */
    profilesNaturalPersons: z.boolean(),
    /** safety component of a product under Annex I Union harmonisation law
     * (machinery, medical devices, vehicles, …) — Art. 6(1) */
    safetyComponent: z.boolean(),
    /** natural persons interact with the system directly (chatbot, voice
     * agent) — Art. 50(1) disclosure */
    interactsWithHumans: z.boolean(),
    /** generates synthetic audio/image/video/text content presented outward
     * — Art. 50(2)/(4) marking and disclosure */
    generatesSyntheticContent: z.boolean(),
  })
  .strict();
export type EuAiActAnswers = z.infer<typeof euAiActAnswersSchema>;

// ===========================================================================
// 2. THE RULE SET — versioned, compiled-in, frozen, data-only
// ===========================================================================

/** a condition is DATA — never a function, never a regex — so the rule set
 * can be hash-pinned and interpreted identically forever */
export type EuAiActCondition =
  | { field: keyof EuAiActAnswers; op: "eq"; value: string | boolean }
  | { field: keyof EuAiActAnswers; op: "neq"; value: string }
  | { field: keyof EuAiActAnswers; op: "in"; values: readonly string[] }
  | { field: "affectedPersons"; op: "includes"; value: EuAiActAffectedPersons };

export interface EuAiActRule {
  /** stable id — the string a stored reason carries forever */
  id: string;
  tier: EuAiActTier;
  /** the Act's own reference, Annex/Article-shaped */
  ref: string;
  /** the plain-language reason reported when the rule fires */
  reason: string;
  /** every condition must hold (AND) for the rule to fire */
  all: readonly EuAiActCondition[];
}

const deepFreeze = <T extends object>(o: T): T => {
  for (const v of Object.values(o)) {
    if (v && typeof v === "object") deepFreeze(v as object);
  }
  return Object.freeze(o);
};

/**
 * v1 — frozen 2026-08-20, authored from the published text of Regulation
 * (EU) 2024/1689. 17 rules. The shared suite pins this count and a sha256 of
 * the JSON — extending screening is a v2 alongside this, never an edit.
 */
export const EU_AI_ACT_RULESET_V1: readonly EuAiActRule[] = deepFreeze([
  // ---- prohibited (Art. 5) ------------------------------------------------
  {
    id: "p-social-scoring",
    tier: "prohibited",
    ref: "Art. 5(1)(c)",
    reason:
      "social scoring of natural persons leading to detrimental treatment in unrelated contexts → prohibited (Art. 5(1)(c))",
    all: [{ field: "socialScoring", op: "eq", value: true }],
  },
  {
    id: "p-manipulative-techniques",
    tier: "prohibited",
    ref: "Art. 5(1)(a)-(b)",
    reason:
      "subliminal, manipulative or deceptive techniques that materially distort behaviour, or exploitation of vulnerabilities → prohibited (Art. 5(1)(a)-(b))",
    all: [{ field: "manipulativeTechniques", op: "eq", value: true }],
  },
  {
    id: "p-emotion-workplace-education",
    tier: "prohibited",
    ref: "Art. 5(1)(f)",
    reason:
      "emotion recognition in the workplace or in education institutions → prohibited (Art. 5(1)(f); medical/safety exceptions are not encoded here)",
    all: [
      { field: "emotionRecognition", op: "eq", value: true },
      { field: "purposeDomain", op: "in", values: ["employment-hr", "education"] },
    ],
  },
  {
    id: "p-rbi-law-enforcement-public",
    tier: "prohibited",
    ref: "Art. 5(1)(h)",
    reason:
      "remote biometric identification for law-enforcement purposes reaching the general public in publicly accessible spaces → treat as prohibited (Art. 5(1)(h); the narrow judicially-authorised exceptions are not encoded here)",
    all: [
      { field: "biometricUse", op: "eq", value: "remote-identification" },
      { field: "purposeDomain", op: "eq", value: "law-enforcement" },
      { field: "affectedPersons", op: "includes", value: "general-public" },
    ],
  },
  // ---- high (Art. 6 + Annex III) -----------------------------------------
  {
    id: "h-safety-component",
    tier: "high",
    ref: "Art. 6(1) / Annex I",
    reason:
      "safety component of a product under Annex I Union harmonisation legislation → high-risk (Art. 6(1))",
    all: [{ field: "safetyComponent", op: "eq", value: true }],
  },
  {
    id: "h-remote-biometric-identification",
    tier: "high",
    ref: "Annex III 1(a)",
    reason:
      "remote biometric identification of natural persons → high-risk (Annex III 1(a); 1:1 verification is excluded by the Act's definitions and does not trigger this)",
    all: [{ field: "biometricUse", op: "eq", value: "remote-identification" }],
  },
  {
    id: "h-emotion-recognition",
    tier: "high",
    ref: "Annex III 1(c)",
    reason: "emotion recognition of natural persons → high-risk (Annex III 1(c))",
    all: [{ field: "emotionRecognition", op: "eq", value: true }],
  },
  {
    id: "h-domain-critical-infrastructure",
    tier: "high",
    ref: "Annex III 2",
    reason:
      "safety-relevant use in the management or operation of critical infrastructure, materially influencing outcomes → high-risk (Annex III 2)",
    all: [
      { field: "purposeDomain", op: "eq", value: "critical-infrastructure" },
      { field: "decisionAutonomy", op: "neq", value: "narrow-procedural" },
    ],
  },
  {
    id: "h-domain-education",
    tier: "high",
    ref: "Annex III 3",
    reason:
      "use in education or vocational training (admission, evaluation, proctoring), materially influencing outcomes → high-risk (Annex III 3)",
    all: [
      { field: "purposeDomain", op: "eq", value: "education" },
      { field: "decisionAutonomy", op: "neq", value: "narrow-procedural" },
    ],
  },
  {
    id: "h-domain-employment",
    tier: "high",
    ref: "Annex III 4",
    reason:
      "use in employment, workers management or access to self-employment (recruitment, evaluation, task allocation), materially influencing outcomes → high-risk (Annex III 4)",
    all: [
      { field: "purposeDomain", op: "eq", value: "employment-hr" },
      { field: "decisionAutonomy", op: "neq", value: "narrow-procedural" },
    ],
  },
  {
    id: "h-domain-essential-services",
    tier: "high",
    ref: "Annex III 5",
    reason:
      "use in access to essential private or public services (creditworthiness, benefits eligibility, insurance pricing, emergency dispatch), materially influencing outcomes → high-risk (Annex III 5)",
    all: [
      { field: "purposeDomain", op: "eq", value: "essential-services" },
      { field: "decisionAutonomy", op: "neq", value: "narrow-procedural" },
    ],
  },
  {
    id: "h-domain-law-enforcement",
    tier: "high",
    ref: "Annex III 6",
    reason:
      "use by or for law enforcement (risk assessment, evidence evaluation, profiling in investigations), materially influencing outcomes → high-risk (Annex III 6)",
    all: [
      { field: "purposeDomain", op: "eq", value: "law-enforcement" },
      { field: "decisionAutonomy", op: "neq", value: "narrow-procedural" },
    ],
  },
  {
    id: "h-domain-migration-border",
    tier: "high",
    ref: "Annex III 7",
    reason:
      "use in migration, asylum or border-control management, materially influencing outcomes → high-risk (Annex III 7)",
    all: [
      { field: "purposeDomain", op: "eq", value: "migration-border" },
      { field: "decisionAutonomy", op: "neq", value: "narrow-procedural" },
    ],
  },
  {
    id: "h-domain-justice-democracy",
    tier: "high",
    ref: "Annex III 8",
    reason:
      "use in the administration of justice or democratic processes, materially influencing outcomes → high-risk (Annex III 8)",
    all: [
      { field: "purposeDomain", op: "eq", value: "justice-democracy" },
      { field: "decisionAutonomy", op: "neq", value: "narrow-procedural" },
    ],
  },
  {
    id: "h-annex3-profiling",
    tier: "high",
    ref: "Art. 6(3), final subparagraph",
    reason:
      "profiling of natural persons in an Annex III area is ALWAYS high-risk — the narrow-procedural derogation is unavailable (Art. 6(3), final subparagraph)",
    all: [
      {
        field: "purposeDomain",
        op: "in",
        values: [
          "employment-hr",
          "education",
          "essential-services",
          "law-enforcement",
          "migration-border",
          "justice-democracy",
          "critical-infrastructure",
        ],
      },
      { field: "profilesNaturalPersons", op: "eq", value: true },
    ],
  },
  // ---- limited (Art. 50 transparency) ------------------------------------
  {
    id: "l-interaction-transparency",
    tier: "limited",
    ref: "Art. 50(1)",
    reason:
      "natural persons interact with the AI system directly — they must be informed they are interacting with AI → limited risk (Art. 50(1) transparency)",
    all: [{ field: "interactsWithHumans", op: "eq", value: true }],
  },
  {
    id: "l-synthetic-content",
    tier: "limited",
    ref: "Art. 50(2)/(4)",
    reason:
      "generates synthetic audio/image/video/text content — outputs must be marked and disclosed as artificially generated → limited risk (Art. 50(2)/(4) transparency)",
    all: [{ field: "generatesSyntheticContent", op: "eq", value: true }],
  },
] satisfies EuAiActRule[]);

/**
 * The load-bearing honesty clause — a FIELD on every stored screening and
 * every rendering of a tier, never a footer somebody can strip (the ADR-0058
 * pattern).
 */
export const EU_AI_ACT_SCREENING_DISCLAIMER =
  "EU AI Act SCREENING result, computed deterministically by rule set v" +
  EU_AI_ACT_RULESET_VERSION +
  " — a fixed, dated encoding of a SUBSET of the published text of Regulation (EU) 2024/1689 " +
  "(Art. 5 prohibitions, Art. 6 + Annex III high-risk classification, Art. 50 transparency). " +
  "The answers are self-reported by the proposer; the Act's exemptions, derogations and evolving " +
  "guidance are not fully encoded, and the encoding will date — revisions ship as a new rule-set " +
  "version, never as an edit under stored results. This is not legal advice and not a conformity " +
  "assessment; the tier informs the human sign-off and blocks nothing by itself. The customer and " +
  "their qualified advisors own the final classification.";

// ===========================================================================
// 3. THE CLASSIFIER — pure, deterministic
// ===========================================================================

export interface EuAiActReason {
  ruleId: string;
  tier: EuAiActTier;
  ref: string;
  reason: string;
}

export interface EuAiActClassification {
  tier: EuAiActTier;
  /** every rule that fired, highest tier first — the audit-ready "why" */
  reasons: EuAiActReason[];
  rulesetVersion: typeof EU_AI_ACT_RULESET_VERSION;
  disclaimer: typeof EU_AI_ACT_SCREENING_DISCLAIMER;
}

function conditionHolds(answers: EuAiActAnswers, c: EuAiActCondition): boolean {
  const v = answers[c.field];
  switch (c.op) {
    case "eq":
      return v === c.value;
    case "neq":
      return v !== c.value;
    case "in":
      return typeof v === "string" && c.values.includes(v);
    case "includes":
      return Array.isArray(v) && v.includes(c.value);
  }
}

/**
 * The calculator. Every rule whose conditions all hold fires; the tier is
 * the highest-ranked tier among the fired rules (prohibited dominates high
 * dominates limited dominates minimal); nothing firing is `minimal` with an
 * empty reasons list — "no rule in this rule set matched", which is exactly
 * as much as a screening can honestly say.
 */
export function classifyEuAiActTier(answers: EuAiActAnswers): EuAiActClassification {
  const fired = EU_AI_ACT_RULESET_V1.filter((r) => r.all.every((c) => conditionHolds(answers, c)));
  const reasons: EuAiActReason[] = fired
    .map((r) => ({ ruleId: r.id, tier: r.tier, ref: r.ref, reason: r.reason }))
    .sort((a, b) => EU_AI_ACT_TIER_RANK[b.tier] - EU_AI_ACT_TIER_RANK[a.tier]);
  const tier = reasons.length ? reasons[0]!.tier : "minimal";
  return {
    tier,
    reasons,
    rulesetVersion: EU_AI_ACT_RULESET_VERSION,
    disclaimer: EU_AI_ACT_SCREENING_DISCLAIMER,
  };
}

// ===========================================================================
// 4. THE ANSWERS BLOCK — how answers travel inside the questionnaire artifact
// ===========================================================================

/**
 * The ADR-0080 questionnaire is ONE versioned markdown artifact — the
 * screening answers ride inside it as a fenced block so the record the
 * sign-off decides on and the record the tier was computed from are the SAME
 * document, at the same version:
 *
 *     ```eu-ai-act-answers
 *     { ...JSON matching euAiActAnswersSchema... }
 *     ```
 */
export const EU_AI_ACT_ANSWERS_FENCE = "eu-ai-act-answers";

const FENCE_RE = /```eu-ai-act-answers[^\S\n]*\n([\s\S]*?)```/g;

export type EuAiActExtraction =
  | { status: "ok"; answers: EuAiActAnswers }
  | { status: "missing" }
  | { status: "invalid"; error: string };

/** deterministic extraction of the answers block from questionnaire markdown */
export function extractEuAiActAnswers(markdown: string): EuAiActExtraction {
  const matches = [...markdown.matchAll(FENCE_RE)];
  if (matches.length === 0) return { status: "missing" };
  if (matches.length > 1) {
    return { status: "invalid", error: "more than one eu-ai-act-answers block — exactly one is allowed" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(matches[0]![1]!);
  } catch {
    return { status: "invalid", error: "the eu-ai-act-answers block is not valid JSON" };
  }
  if (parsed && typeof parsed === "object" && "tier" in (parsed as Record<string, unknown>)) {
    return {
      status: "invalid",
      error:
        "a submitted tier is refused — the tier is computed server-side from the answers, never accepted from a payload",
    };
  }
  const result = euAiActAnswersSchema.safeParse(parsed);
  if (!result.success) {
    return {
      status: "invalid",
      error: `answers do not match the v${EU_AI_ACT_RULESET_VERSION} questionnaire: ${result.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    };
  }
  return { status: "ok", answers: result.data };
}

/** render the canonical block the UI embeds into the questionnaire markdown */
export function renderEuAiActAnswersBlock(answers: EuAiActAnswers): string {
  return "```" + EU_AI_ACT_ANSWERS_FENCE + "\n" + JSON.stringify(answers, null, 2) + "\n```";
}
