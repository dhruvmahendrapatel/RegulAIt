import { describe, expect, it } from "vitest";
import { DEFAULT_COMPLIANCE_PACKS } from "./compliance-packs.js";
import { classifyEuAiActTier, extractEuAiActAnswers } from "./eu-ai-act.js";
import {
  CATEGORY_SUGGESTED_CONTROLS,
  intakeAssistRequestSchema,
  parseIntakeNarrative,
  renderQuestionnaireMarkdown,
  suggestIntake,
  type IntakeAssistRequest,
} from "./intake-assist.js";
import { AI_RISK_CATEGORIES } from "./risks.js";

/** the demo's hero: a customer-facing credit-limit assistant */
const credit = (): IntakeAssistRequest =>
  intakeAssistRequestSchema.parse({
    title: "Credit-limit-increase assistant",
    description: "Recommends whether to approve a customer's request for a higher credit limit.",
    euAiAct: {
      purposeDomain: "essential-services",
      affectedPersons: ["customers"],
      decisionAutonomy: "human-reviews",
      biometricUse: "none",
      emotionRecognition: false,
      socialScoring: false,
      manipulativeTechniques: false,
      profilesNaturalPersons: true,
      safetyComponent: false,
      interactsWithHumans: true,
      generatesSyntheticContent: true,
    },
    context: {
      sectors: ["financial-services"],
      dataCategories: ["personal", "financial"],
      deployment: "customer-facing",
      euNexus: true,
      usesExternalVendor: true,
      generative: true,
      autonomousActions: true,
      toolsUsed: ["crm.read", "bureau.score", "limits.propose"],
    },
  });

/** a quiet internal utility: nothing should fire beyond the baseline */
const quiet = (): IntakeAssistRequest =>
  intakeAssistRequestSchema.parse({
    title: "Log summarizer",
    description: "Summarises build logs for engineers.",
    euAiAct: {
      purposeDomain: "internal-productivity",
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
    },
    context: {
      sectors: [],
      dataCategories: ["proprietary"],
      deployment: "internal",
      euNexus: false,
      usesExternalVendor: false,
      generative: false,
      autonomousActions: false,
      toolsUsed: [],
    },
  });

describe("ADR-0149 — the intake assistant's rules", () => {
  it("every suggested control ref exists in a seeded pack", () => {
    const refs = new Set(DEFAULT_COMPLIANCE_PACKS.flatMap((p) => p.controls.map((c) => c.controlRef)));
    for (const cat of AI_RISK_CATEGORIES) {
      for (const ref of CATEGORY_SUGGESTED_CONTROLS[cat]) expect(refs, `${cat} → ${ref}`).toContain(ref);
    }
  });

  it("the tier is the SAME classifier the server screens with on submission", () => {
    const req = credit();
    const s = suggestIntake(req);
    expect(s.tier.value).toBe(classifyEuAiActTier(req.euAiAct).tier);
    expect(s.tier.value).toBe("high");
    // and the block it hands back round-trips through the server's extractor
    const extracted = extractEuAiActAnswers(`# Q\n\n${s.euAiActBlock}\n`);
    expect(extracted.status).toBe("ok");
  });

  it("the hero case gets the frameworks and risks its answers imply, each with a reason", () => {
    const s = suggestIntake(credit());
    expect(s.frameworks.map((f) => f.framework)).toEqual(
      expect.arrayContaining(["eu-ai-act", "nist-ai-rmf", "iso-42001", "soc-2", "iso-27001"]),
    );
    expect(s.frameworks.map((f) => f.framework)).not.toContain("hipaa");
    const cats = s.risks.map((r) => r.category);
    expect(cats).toEqual(
      expect.arrayContaining(["bias_fairness", "data_leakage_pii", "prompt_injection", "unsafe_output", "hallucination", "tool_misuse", "over_permissioning", "third_party_ai"]),
    );
    for (const r of s.risks) {
      expect(r.why.length).toBeGreaterThan(10);
      // suggested controls are narrowed to frameworks actually suggested
      for (const ref of r.suggestedControls) {
        expect(s.frameworks.map((f) => f.framework)).toContain(ref.split(":")[0]);
      }
    }
    // a high-tier system's bias impact is raised to high
    expect(s.risks.find((r) => r.category === "bias_fairness")!.impact).toBe("high");
    expect(s.blocking).toBeNull();
  });

  it("a quiet internal tool triggers no risk rules and only the baseline frameworks (negative control)", () => {
    const s = suggestIntake(quiet());
    expect(s.risks).toHaveLength(0);
    expect(s.frameworks.map((f) => f.framework).sort()).toEqual(["iso-42001", "nist-ai-rmf"]);
    expect(s.tier.value).toBe("minimal");
  });

  it("a prohibited practice is flagged as blocking", () => {
    const req = credit();
    req.euAiAct.socialScoring = true;
    const s = suggestIntake(req);
    expect(s.tier.value).toBe("prohibited");
    expect(s.blocking).toMatch(/PROHIBITED/);
  });

  it("the draft questionnaire traces to the answers and is labelled rules", () => {
    const s = suggestIntake(credit());
    expect(s.questionnaire).toHaveLength(8);
    for (const q of s.questionnaire) expect(q.source).toBe("rules");
    expect(s.questionnaire.find((q) => q.id === "data")!.text).toContain("financial");
    expect(s.questionnaire.find((q) => q.id === "compliance")!.text).toContain("high");
  });

  it("refuses a smuggled tier and unknown context keys", () => {
    const raw = { ...credit(), euAiAct: { ...credit().euAiAct, tier: "minimal" } };
    expect(intakeAssistRequestSchema.safeParse(raw).success).toBe(false);
    const raw2 = { ...credit(), context: { ...credit().context, riskScore: 1 } };
    expect(intakeAssistRequestSchema.safeParse(raw2).success).toBe(false);
  });

  it("parses a model narrative and drops unknown sections", () => {
    expect(parseIntakeNarrative('noise {"sections":[{"id":"purpose","text":"A"},{"id":"evil","text":"B"}]} tail')).toEqual({ purpose: "A" });
    expect(parseIntakeNarrative("canned mock prose with no json")).toBeNull();
  });

  it("renders a submittable questionnaire whose tier the server extractor reads back", () => {
    const req = credit();
    const s = suggestIntake(req);
    const md = renderQuestionnaireMarkdown(s.questionnaire, s.euAiActBlock);
    expect(md).toContain("## 1. Purpose and business context");
    expect(md).toContain("## 9. EU AI Act risk screening");
    const extracted = extractEuAiActAnswers(md);
    expect(extracted.status).toBe("ok");
    if (extracted.status === "ok") expect(classifyEuAiActTier(extracted.answers).tier).toBe("high");
  });
});
