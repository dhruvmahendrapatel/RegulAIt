/**
 * ADR-0085 — the EU AI Act screening classifier (gap L10).
 *
 * The adversarial contract, stated up front:
 *  - THE RULE SET IS FROZEN. v1 is pinned by RULE COUNT and by a CONTENT
 *    HASH — any drift fails here first (the ADR-0083 catalogue discipline).
 *  - EVERY TIER IS REACHABLE, and EVERY RULE IS LOAD-BEARING: for each rule
 *    there is a fixture where it fires, and removing its trigger answer
 *    strictly DROPS the tier — a rule that cannot change the outcome is a
 *    decoration, not a rule (M-002's non-vacuity, per rule).
 *  - DOMINANCE: prohibited > high > limited > minimal, proven with stacked
 *    fixtures, not asserted from the rank table.
 *  - THE TIER IS NEVER AN INPUT: an answers block smuggling a `tier` key is
 *    refused by the parser with the server-side-only message.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  classifyEuAiActTier,
  euAiActAnswersSchema,
  extractEuAiActAnswers,
  renderEuAiActAnswersBlock,
  EU_AI_ACT_ANNEX_III_DOMAINS,
  EU_AI_ACT_PURPOSE_DOMAINS,
  EU_AI_ACT_RULESET_V1,
  EU_AI_ACT_RULESET_VERSION,
  EU_AI_ACT_SCREENING_DISCLAIMER,
  EU_AI_ACT_TIER_RANK,
  EU_AI_ACT_TIERS,
  type EuAiActAnswers,
} from "./eu-ai-act.js";

/** nothing fires from here — the minimal baseline every fixture perturbs */
const baseline: EuAiActAnswers = {
  purposeDomain: "general-business",
  affectedPersons: [],
  decisionAutonomy: "informs-human",
  biometricUse: "none",
  emotionRecognition: false,
  socialScoring: false,
  manipulativeTechniques: false,
  profilesNaturalPersons: false,
  safetyComponent: false,
  interactsWithHumans: false,
  generatesSyntheticContent: false,
};
const answers = (over: Partial<EuAiActAnswers>): EuAiActAnswers => ({ ...baseline, ...over });

describe("EU_AI_ACT_RULESET_V1 is a valid, frozen, pinned rule set", () => {
  it("pins version, rule count and content hash — v1 can never drift silently", () => {
    expect(EU_AI_ACT_RULESET_VERSION).toBe(1);
    expect(EU_AI_ACT_RULESET_V1.length).toBe(17);
    const hash = createHash("sha256").update(JSON.stringify(EU_AI_ACT_RULESET_V1)).digest("hex");
    expect(hash).toBe("e404b97f7530b88550dc9a62f6854049f8c3a4ef9f36732cfe252085265db2aa");
  });

  it("is deep-frozen — a rule cannot be edited at runtime", () => {
    expect(Object.isFrozen(EU_AI_ACT_RULESET_V1)).toBe(true);
    expect(() => {
      (EU_AI_ACT_RULESET_V1[0] as { tier: string }).tier = "minimal";
    }).toThrow();
    expect(() => {
      (EU_AI_ACT_RULESET_V1 as unknown as unknown[]).push({});
    }).toThrow();
  });

  it("every rule is well-formed: unique id, known tier, Act-shaped ref, conditions over known fields", () => {
    const ids = EU_AI_ACT_RULESET_V1.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const knownFields = Object.keys(baseline);
    for (const rule of EU_AI_ACT_RULESET_V1) {
      expect(EU_AI_ACT_TIERS).toContain(rule.tier);
      expect(rule.tier).not.toBe("minimal"); // minimal is the ABSENCE of a rule firing
      expect(rule.ref).toMatch(/Art\.|Annex/);
      expect(rule.reason.length).toBeGreaterThan(20);
      expect(rule.all.length).toBeGreaterThan(0);
      for (const c of rule.all) expect(knownFields).toContain(c.field);
    }
  });

  it("the Annex III domain list is a strict subset of the purpose domains", () => {
    for (const d of EU_AI_ACT_ANNEX_III_DOMAINS) expect(EU_AI_ACT_PURPOSE_DOMAINS).toContain(d);
    expect(EU_AI_ACT_PURPOSE_DOMAINS.length).toBeGreaterThan(EU_AI_ACT_ANNEX_III_DOMAINS.length);
  });
});

// ---------------------------------------------------------------------------
// Every rule load-bearing: fire it, then remove the trigger and watch the
// tier DROP. One fixture per rule, keyed by rule id so a new rule without a
// fixture fails the completeness assertion below.
// ---------------------------------------------------------------------------
const LOAD_BEARING: Record<
  string,
  { fire: EuAiActAnswers; expectTier: string; drop: EuAiActAnswers }
> = {
  "p-social-scoring": {
    fire: answers({ socialScoring: true }),
    expectTier: "prohibited",
    drop: answers({}),
  },
  "p-manipulative-techniques": {
    fire: answers({ manipulativeTechniques: true }),
    expectTier: "prohibited",
    drop: answers({}),
  },
  "p-emotion-workplace-education": {
    // narrow-procedural so no Annex III domain rule fires; h-emotion still
    // fires, so removing the WORKPLACE half drops prohibited → high
    fire: answers({
      purposeDomain: "employment-hr",
      decisionAutonomy: "narrow-procedural",
      emotionRecognition: true,
    }),
    expectTier: "prohibited",
    drop: answers({ decisionAutonomy: "narrow-procedural", emotionRecognition: true }),
  },
  "p-rbi-law-enforcement-public": {
    // removing "general-public" from affected persons drops prohibited → high
    // (h-remote-biometric-identification remains) — affectedPersons is load-bearing
    fire: answers({
      biometricUse: "remote-identification",
      purposeDomain: "law-enforcement",
      decisionAutonomy: "narrow-procedural",
      affectedPersons: ["general-public"],
    }),
    expectTier: "prohibited",
    drop: answers({
      biometricUse: "remote-identification",
      purposeDomain: "law-enforcement",
      decisionAutonomy: "narrow-procedural",
      affectedPersons: ["employees"],
    }),
  },
  "h-safety-component": {
    fire: answers({ safetyComponent: true }),
    expectTier: "high",
    drop: answers({}),
  },
  "h-remote-biometric-identification": {
    // the drop goes to VERIFICATION, not to none — proving the Act's
    // 1:1-verification exclusion is honoured, not just the boolean removed
    fire: answers({ biometricUse: "remote-identification" }),
    expectTier: "high",
    drop: answers({ biometricUse: "verification" }),
  },
  "h-emotion-recognition": {
    fire: answers({ emotionRecognition: true }),
    expectTier: "high",
    drop: answers({}),
  },
  "h-domain-critical-infrastructure": {
    fire: answers({ purposeDomain: "critical-infrastructure", decisionAutonomy: "fully-automated" }),
    expectTier: "high",
    drop: answers({ purposeDomain: "critical-infrastructure", decisionAutonomy: "narrow-procedural" }),
  },
  "h-domain-education": {
    fire: answers({ purposeDomain: "education", decisionAutonomy: "fully-automated" }),
    expectTier: "high",
    drop: answers({ purposeDomain: "education", decisionAutonomy: "narrow-procedural" }),
  },
  "h-domain-employment": {
    fire: answers({ purposeDomain: "employment-hr", decisionAutonomy: "fully-automated" }),
    expectTier: "high",
    drop: answers({ purposeDomain: "employment-hr", decisionAutonomy: "narrow-procedural" }),
  },
  "h-domain-essential-services": {
    fire: answers({ purposeDomain: "essential-services", decisionAutonomy: "fully-automated" }),
    expectTier: "high",
    drop: answers({ purposeDomain: "essential-services", decisionAutonomy: "narrow-procedural" }),
  },
  "h-domain-law-enforcement": {
    fire: answers({ purposeDomain: "law-enforcement", decisionAutonomy: "fully-automated" }),
    expectTier: "high",
    drop: answers({ purposeDomain: "law-enforcement", decisionAutonomy: "narrow-procedural" }),
  },
  "h-domain-migration-border": {
    fire: answers({ purposeDomain: "migration-border", decisionAutonomy: "fully-automated" }),
    expectTier: "high",
    drop: answers({ purposeDomain: "migration-border", decisionAutonomy: "narrow-procedural" }),
  },
  "h-domain-justice-democracy": {
    fire: answers({ purposeDomain: "justice-democracy", decisionAutonomy: "fully-automated" }),
    expectTier: "high",
    drop: answers({ purposeDomain: "justice-democracy", decisionAutonomy: "narrow-procedural" }),
  },
  "h-annex3-profiling": {
    // the derogation-removal rule: narrow-procedural employment stays minimal
    // UNTIL profiling is true — then high, with only this rule firing
    fire: answers({
      purposeDomain: "employment-hr",
      decisionAutonomy: "narrow-procedural",
      profilesNaturalPersons: true,
    }),
    expectTier: "high",
    drop: answers({ purposeDomain: "employment-hr", decisionAutonomy: "narrow-procedural" }),
  },
  "l-interaction-transparency": {
    fire: answers({ interactsWithHumans: true }),
    expectTier: "limited",
    drop: answers({}),
  },
  "l-synthetic-content": {
    fire: answers({ generatesSyntheticContent: true }),
    expectTier: "limited",
    drop: answers({}),
  },
};

describe("every rule is load-bearing (fire it, remove the trigger, watch the tier drop)", () => {
  it("has exactly one fixture per rule — a new rule cannot ship untested", () => {
    expect(Object.keys(LOAD_BEARING).sort()).toEqual(
      EU_AI_ACT_RULESET_V1.map((r) => r.id).sort(),
    );
  });

  for (const rule of EU_AI_ACT_RULESET_V1) {
    it(`${rule.id} fires to ${rule.tier} and its trigger is load-bearing`, () => {
      const fx = LOAD_BEARING[rule.id]!;
      const fired = classifyEuAiActTier(fx.fire);
      expect(fired.tier).toBe(fx.expectTier);
      expect(fired.reasons.map((r) => r.ruleId)).toContain(rule.id);
      // the reason carries the Act-shaped reference, verbatim
      expect(fired.reasons.find((r) => r.ruleId === rule.id)!.ref).toBe(rule.ref);

      const dropped = classifyEuAiActTier(fx.drop);
      expect(dropped.reasons.map((r) => r.ruleId)).not.toContain(rule.id);
      expect(EU_AI_ACT_TIER_RANK[dropped.tier]).toBeLessThan(EU_AI_ACT_TIER_RANK[fired.tier]);
    });
  }
});

describe("tiers, dominance, determinism", () => {
  it("every tier is reachable", () => {
    expect(classifyEuAiActTier(answers({ socialScoring: true })).tier).toBe("prohibited");
    expect(classifyEuAiActTier(answers({ safetyComponent: true })).tier).toBe("high");
    expect(classifyEuAiActTier(answers({ interactsWithHumans: true })).tier).toBe("limited");
    expect(classifyEuAiActTier(baseline).tier).toBe("minimal");
  });

  it("minimal means NO rule fired — empty reasons, never a fabricated one", () => {
    const c = classifyEuAiActTier(baseline);
    expect(c.tier).toBe("minimal");
    expect(c.reasons).toEqual([]);
    expect(c.rulesetVersion).toBe(1);
    expect(c.disclaimer).toBe(EU_AI_ACT_SCREENING_DISCLAIMER);
  });

  it("prohibited dominates high dominates limited — stacked fixtures, reasons kept", () => {
    // everything at once: prohibited wins, every fired reason still reported
    const stacked = classifyEuAiActTier(
      answers({
        socialScoring: true,
        purposeDomain: "employment-hr",
        decisionAutonomy: "fully-automated",
        interactsWithHumans: true,
      }),
    );
    expect(stacked.tier).toBe("prohibited");
    const ids = stacked.reasons.map((r) => r.ruleId);
    expect(ids).toContain("p-social-scoring");
    expect(ids).toContain("h-domain-employment");
    expect(ids).toContain("l-interaction-transparency");
    // sorted highest tier first
    expect(stacked.reasons[0]!.tier).toBe("prohibited");

    // high + limited → high, limited reason kept
    const hl = classifyEuAiActTier(
      answers({ purposeDomain: "employment-hr", decisionAutonomy: "fully-automated", interactsWithHumans: true }),
    );
    expect(hl.tier).toBe("high");
    expect(hl.reasons.map((r) => r.ruleId)).toContain("l-interaction-transparency");
  });

  it("is deterministic — same answers, same classification, twice", () => {
    const a = answers({ purposeDomain: "education", decisionAutonomy: "human-reviews", interactsWithHumans: true });
    expect(classifyEuAiActTier(a)).toEqual(classifyEuAiActTier(a));
  });

  it("the disclaimer says screening, not-legal-advice, and self-reported — on the result itself", () => {
    const c = classifyEuAiActTier(baseline);
    expect(c.disclaimer).toContain("SCREENING");
    expect(c.disclaimer).toContain("not legal advice");
    expect(c.disclaimer).toContain("self-reported");
    expect(c.disclaimer).toContain("2024/1689");
  });
});

describe("the answers block — round-trip, refusals", () => {
  const doc = (block: string) =>
    `# AI use-case intake questionnaire\n\n## 1. Purpose\nFilled.\n\n${block}\n`;

  it("round-trips: render → extract → identical answers", () => {
    const a = answers({ purposeDomain: "essential-services", decisionAutonomy: "fully-automated" });
    const extracted = extractEuAiActAnswers(doc(renderEuAiActAnswersBlock(a)));
    expect(extracted).toEqual({ status: "ok", answers: a });
  });

  it("no block → missing (screening simply did not happen — never a guessed tier)", () => {
    expect(extractEuAiActAnswers(doc("no structured answers here"))).toEqual({ status: "missing" });
  });

  it("a smuggled `tier` key is refused with the server-side-only message", () => {
    const block =
      "```eu-ai-act-answers\n" + JSON.stringify({ ...baseline, tier: "minimal" }) + "\n```";
    const r = extractEuAiActAnswers(doc(block));
    expect(r.status).toBe("invalid");
    expect((r as { error: string }).error).toContain("computed server-side");
  });

  it("unknown keys, broken JSON, and duplicate blocks are each refused, not repaired", () => {
    const unknown =
      "```eu-ai-act-answers\n" + JSON.stringify({ ...baseline, verdict: "fine" }) + "\n```";
    expect(extractEuAiActAnswers(doc(unknown)).status).toBe("invalid");

    const broken = "```eu-ai-act-answers\n{ not json\n```";
    expect(extractEuAiActAnswers(doc(broken)).status).toBe("invalid");

    const twice = renderEuAiActAnswersBlock(baseline) + "\n\n" + renderEuAiActAnswersBlock(baseline);
    expect(extractEuAiActAnswers(doc(twice)).status).toBe("invalid");
  });

  it("the schema itself is strict and defaults only affectedPersons", () => {
    const { affectedPersons: _dropped, ...withoutAffected } = baseline;
    const parsed = euAiActAnswersSchema.parse(withoutAffected);
    expect(parsed.affectedPersons).toEqual([]);
    expect(() => euAiActAnswersSchema.parse({ ...baseline, extra: 1 })).toThrow();
  });
});
