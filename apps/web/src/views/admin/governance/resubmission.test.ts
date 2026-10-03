import { describe, expect, it } from "vitest";
import { answersBlock, answersFromForm, formFromAnswers, rebuildQuestionnaire, resubmitPatch, sameAnswers, splitQuestionnaire } from "./resubmission";

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

  it("round-trips answers through the form, and refuses while a question is unanswered", () => {
    expect(answersFromForm(formFromAnswers(answers), true)).toEqual(answers);
    expect(sameAnswers(answersFromForm(formFromAnswers(answers), true), answers)).toBe(true);
    expect(answersFromForm({ ...formFromAnswers(answers), socialScoring: "" }, true)).toBeNull();
    expect(answersFromForm(formFromAnswers(answers), false)).toBeNull();
    expect(answersFromForm(formFromAnswers(null), false)).toBeNull();
  });

  it("PATCHes only what changed, always with the screening answers; a blank context reuses the purpose", () => {
    const current = { name: "Credit assistant", description: "Recommends", businessContext: "Recommends" };
    expect(resubmitPatch(current, { ...current }, answers)).toEqual({ screeningAnswers: answers });
    expect(resubmitPatch(current, { name: " Credit assistant v2 ", description: "Recommends", businessContext: "" }, answers)).toEqual({ name: "Credit assistant v2", screeningAnswers: answers });
    expect(resubmitPatch(current, { name: "Credit assistant", description: "Suggests", businessContext: "" }, answers)).toEqual({ description: "Suggests", businessContext: "Suggests", screeningAnswers: answers });
  });
});
