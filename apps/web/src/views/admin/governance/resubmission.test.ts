import { describe, expect, it } from "vitest";
import { answersBlock, answersFromForm, euAnswersOf, formFromAnswers, rebuildQuestionnaire, resubmitPatch, sameAnswers, sameEuAnswers, splitQuestionnaire } from "./resubmission";

const answers = {
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
};
/** every Classify answer, as registration stores it */
const full = {
  ...answers,
  sectors: ["financial-services"],
  dataCategories: ["personal", "financial"],
  deployment: "customer-facing",
  euNexus: true,
  usesExternalVendor: false,
  generative: true,
  autonomousActions: false,
  toolsUsed: ["crm-lookup"],
};

const doc = [
  "## 1. Purpose and business context", "", "Recommends credit-limit increases.", "",
  "## 6. Risks and mitigations", "", "Human review of every recommendation.", "",
  "## 9. EU AI Act risk screening", "", answersBlock(answers),
].join("\n");

describe("resubmission model", () => {
  it("splits the questionnaire into its sections, ignoring ## inside a fenced block", () => {
    const withFence = `${doc.replace("Human review", "```\n## not a heading\n```\nHuman review")}`;
    const { preamble, sections } = splitQuestionnaire(withFence);
    expect(preamble).toBe("");
    expect(sections.map((s) => s.heading)).toEqual(["1. Purpose and business context", "6. Risks and mitigations", "9. EU AI Act risk screening"]);
    expect(sections[1]!.body).toContain("## not a heading");
  });

  it("rebuilds an unchanged document byte for byte, and carries NEW answers into the screening block", () => {
    const { preamble, sections } = splitQuestionnaire(doc);
    expect(rebuildQuestionnaire(preamble, sections, answers)).toBe(doc);
    const changed = { ...answers, decisionAutonomy: "fully-automated" };
    const next = rebuildQuestionnaire(preamble, sections.map((s) => (s.heading.startsWith("6.") ? { ...s, body: "Now with the DPIA reference." } : s)), changed);
    expect(next).toContain('"decisionAutonomy": "fully-automated"');
    expect(next).not.toContain("human-reviews");
    expect(next).toContain("## 6. Risks and mitigations\n\nNow with the DPIA reference.");
    expect(next.match(/```eu-ai-act-answers/g)).toHaveLength(1);
  });

  it("adds the screening section when the old document had none, and keeps a preamble", () => {
    const { preamble, sections } = splitQuestionnaire("# Intake\n\n## 1. Purpose\n\nText");
    expect(rebuildQuestionnaire(preamble, sections, answers)).toBe(`# Intake\n\n## 1. Purpose\n\nText\n\n## 9. EU AI Act risk screening\n\n${answersBlock(answers)}`);
  });

  it("round-trips EVERY Classify answer through the form, and refuses while a question is unanswered", () => {
    expect(answersFromForm(formFromAnswers(full), true)).toEqual(full);
    expect(Object.keys(answersFromForm(formFromAnswers(full), true)!).sort()).toEqual([
      "affectedPersons", "autonomousActions", "biometricUse", "dataCategories", "decisionAutonomy", "deployment",
      "emotionRecognition", "euNexus", "generatesSyntheticContent", "generative", "interactsWithHumans",
      "manipulativeTechniques", "profilesNaturalPersons", "purposeDomain", "safetyComponent", "sectors",
      "socialScoring", "toolsUsed", "usesExternalVendor",
    ]);
    expect(sameAnswers(answersFromForm(formFromAnswers(full), true), full)).toBe(true);
    expect(answersFromForm({ ...formFromAnswers(full), socialScoring: "" }, true)).toBeNull();
    expect(answersFromForm({ ...formFromAnswers(full), euNexus: "" }, true)).toBeNull();
    expect(answersFromForm({ ...formFromAnswers(full), dataCategories: [] }, true)).toBeNull();
    expect(answersFromForm(formFromAnswers(full), false)).toBeNull();
    expect(answersFromForm(formFromAnswers(null), false)).toBeNull();
    // a record registered before the context answers were stored: the EU
    // answers prefill, the context questions are asked again
    expect(answersFromForm(formFromAnswers(answers), true)).toBeNull();
    // one question answers both the EU and the context "synthetic content" keys
    const flipped = answersFromForm({ ...formFromAnswers(full), generatesSyntheticContent: "no" }, true)!;
    expect([flipped.generatesSyntheticContent, flipped.generative]).toEqual([false, false]);
  });

  it("the questionnaire block carries only the EU answers; a context-only change does not re-screen the tier", () => {
    expect(answersBlock(full)).toBe(answersBlock(answers));
    expect(euAnswersOf(full)).toEqual(answers);
    expect(sameEuAnswers({ ...full, sectors: ["payments"] }, full)).toBe(true);
    expect(sameAnswers({ ...full, sectors: ["payments"] }, full)).toBe(false);
    expect(sameEuAnswers({ ...full, socialScoring: true }, full)).toBe(false);
  });

  it("PATCHes only what changed, always with every Classify answer; a blank context reuses the purpose; never the name", () => {
    const current = { description: "Recommends", businessContext: "Recommends" };
    expect(resubmitPatch(current, { ...current }, full)).toEqual({ screeningAnswers: full });
    expect(resubmitPatch(current, { description: "Recommends", businessContext: "" }, full)).toEqual({ screeningAnswers: full });
    expect(resubmitPatch(current, { description: "Suggests", businessContext: "" }, full)).toEqual({ description: "Suggests", businessContext: "Suggests", screeningAnswers: full });
  });
});
