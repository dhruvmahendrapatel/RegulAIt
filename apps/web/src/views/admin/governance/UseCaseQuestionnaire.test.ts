import { describe, expect, it } from "vitest";
import { answerRows, parseQuestionnaire } from "./UseCaseQuestionnaire";

const SUBMITTED = [
  "# AI use-case intake questionnaire",
  "",
  "> Fill every section, then submit this document as the intake",
  "> instance's `use_case_questionnaire` artifact.",
  "",
  "## 1. Purpose and business context",
  "Summarize support tickets",
  "for the on-call team.",
  "",
  "## 2. Users and affected parties",
  "- Support agents",
  "- Customers, indirectly",
  "  through faster replies",
  "",
  "### Notes",
  "1. pilot first",
  "2. then roll out",
  "",
  "## 9. EU AI Act risk screening (structured, ADR-0085)",
  "```eu-ai-act-answers",
  JSON.stringify(
    {
      purposeDomain: "essential-services",
      affectedPersons: ["customers", "vulnerable-groups"],
      decisionAutonomy: "human-reviews",
      biometricUse: "none",
      emotionRecognition: false,
      socialScoring: false,
      manipulativeTechniques: false,
      profilesNaturalPersons: true,
      safetyComponent: false,
      interactsWithHumans: true,
      generatesSyntheticContent: false,
    },
    null,
    2,
  ),
  "```",
  "",
].join("\n");

describe("the submitted questionnaire reads as a document, not as markdown", () => {
  const blocks = parseQuestionnaire(SUBMITTED);

  it("splits headings, quotes, paragraphs and lists, joining wrapped lines", () => {
    expect(blocks.slice(0, 9)).toEqual([
      { kind: "heading", level: 1, text: "AI use-case intake questionnaire" },
      {
        kind: "quote",
        text: "Fill every section, then submit this document as the intake instance's `use_case_questionnaire` artifact.",
      },
      { kind: "heading", level: 2, text: "1. Purpose and business context" },
      { kind: "paragraph", text: "Summarize support tickets for the on-call team." },
      { kind: "heading", level: 2, text: "2. Users and affected parties" },
      { kind: "list", ordered: false, items: ["Support agents", "Customers, indirectly through faster replies"] },
      { kind: "heading", level: 3, text: "Notes" },
      { kind: "list", ordered: true, items: ["pilot first", "then roll out"] },
      // the template's ADR cross-reference is dropped from the heading
      { kind: "heading", level: 2, text: "9. EU AI Act risk screening" },
    ]);
  });

  it("turns the answers block into labelled rows in form order — no JSON, no camelCase", () => {
    const answers = blocks.find((b) => b.kind === "answers");
    expect(answers).toBeDefined();
    expect(blocks.some((b) => b.kind === "code")).toBe(false);
    const rows = answerRows((answers as { answers: Record<string, unknown> }).answers);
    expect(rows.slice(0, 4)).toEqual([
      ["Purpose domain", "Essential services (credit, benefits, insurance)"],
      ["Affected persons", "Customers, Vulnerable groups"],
      ["Decision autonomy", "Decides, a human reviews"],
      ["Biometric use", "No biometric use"],
    ]);
    expect(rows).toContainEqual(["Profiles natural persons", "Yes"]);
    expect(rows).toContainEqual(["Social scoring", "No"]);
    expect(rows).toHaveLength(11);
  });

  it("says 'no natural persons' for an empty affected list and labels unknown keys readably", () => {
    expect(answerRows({ affectedPersons: [], someNewQuestion: "remote-only" })).toEqual([
      ["Affected persons", "No natural persons affected"],
      ["Some new question", "Remote only"],
    ]);
  });

  it("keeps an unreadable answers block and any other fence as code, never dropped", () => {
    expect(parseQuestionnaire("```eu-ai-act-answers\n{not json\n```")).toEqual([
      { kind: "code", lang: "eu-ai-act-answers", text: "{not json" },
    ]);
    expect(parseQuestionnaire("```yaml\na: 1\n```")).toEqual([{ kind: "code", lang: "yaml", text: "a: 1" }]);
  });

  it("strips a closing # run only when a space precedes it", () => {
    expect(parseQuestionnaire("## Using C#")).toEqual([{ kind: "heading", level: 2, text: "Using C#" }]);
    expect(parseQuestionnaire("## Scope ##")).toEqual([{ kind: "heading", level: 2, text: "Scope" }]);
  });

  it("treats markup as text — a questionnaire cannot inject HTML", () => {
    expect(parseQuestionnaire("<img src=x onerror=alert(1)>")).toEqual([
      { kind: "paragraph", text: "<img src=x onerror=alert(1)>" },
    ]);
  });
});
