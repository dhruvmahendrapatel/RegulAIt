/**
 * Resubmitting a use case sent back for information (ADR-0168 amendment,
 * afternoon, item 4). The registration screen opens prefilled from the
 * use case and its last questionnaire; on submit it PATCHes what changed (and
 * the screening answers, which the gateway re-screens) and posts a NEW
 * questionnaire version — the existing endpoints, nothing new.
 *
 * The questionnaire is one markdown document whose screening answers ride in
 * a fenced `eu-ai-act-answers` block; the tier is computed from that block, so
 * the new version carries the answers as they are NOW, never the old ones.
 */
import type { EuAiActScreeningAnswers } from "../../../api/types";

export type BooleanAnswer = "" | "yes" | "no";

export interface QuestionnaireSection {
  heading: string;
  body: string;
}

const SCREENING_HEADING = "9. EU AI Act risk screening";
const ANSWERS_FENCE = "eu-ai-act-answers";

/** the document's `## ` sections; anything above the first one is the preamble */
export function splitQuestionnaire(markdown: string): { preamble: string; sections: QuestionnaireSection[] } {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const preamble: string[] = [];
  const sections: QuestionnaireSection[] = [];
  let inFence = false;
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    const heading = !inFence && /^## (.*)$/.exec(line);
    if (heading) {
      sections.push({ heading: heading[1]!.trim(), body: "" });
      continue;
    }
    const current = sections.at(-1);
    if (current) current.body += `${current.body ? "\n" : ""}${line}`;
    else preamble.push(line);
  }
  return { preamble: preamble.join("\n").trim(), sections: sections.map((s) => ({ ...s, body: s.body.trim() })) };
}

/** the section the tier is read from: by its heading, or because it carries the answers block */
export const isScreeningSection = (section: QuestionnaireSection) =>
  /EU AI Act risk screening/i.test(section.heading) || section.body.includes("```" + ANSWERS_FENCE);

/** the canonical answers block — the same shape the gateway renders */
export const answersBlock = (answers: EuAiActScreeningAnswers) => "```" + ANSWERS_FENCE + "\n" + JSON.stringify(answers, null, 2) + "\n```";

/** the new questionnaire version: the edited sections, then the screening section rebuilt from the current answers */
export function rebuildQuestionnaire(preamble: string, sections: QuestionnaireSection[], answers: EuAiActScreeningAnswers): string {
  const screening = sections.find(isScreeningSection);
  const parts = [
    ...(preamble.trim() ? [preamble.trim()] : []),
    ...sections.filter((s) => !isScreeningSection(s)).map((s) => `## ${s.heading}\n\n${s.body.trim()}`),
    `## ${screening?.heading ?? SCREENING_HEADING}\n\n${answersBlock(answers)}`,
  ];
  return parts.join("\n\n");
}

export interface ScreeningForm {
  purposeDomain: string;
  /** kept as recorded unless the person changes "People affected" */
  affectedPersons: string[];
  decisionAutonomy: string;
  biometricUse: string;
  emotionRecognition: BooleanAnswer;
  socialScoring: BooleanAnswer;
  manipulativeTechniques: BooleanAnswer;
  profilesNaturalPersons: BooleanAnswer;
  safetyComponent: BooleanAnswer;
  interactsWithHumans: BooleanAnswer;
  generatesSyntheticContent: BooleanAnswer;
}
export const BOOLEAN_KEYS = [
  "profilesNaturalPersons",
  "interactsWithHumans",
  "generatesSyntheticContent",
  "safetyComponent",
  "emotionRecognition",
  "socialScoring",
  "manipulativeTechniques",
] as const;

const yn = (value: boolean | undefined): BooleanAnswer => (value === undefined ? "" : value ? "yes" : "no");

export function formFromAnswers(answers: EuAiActScreeningAnswers | null | undefined): ScreeningForm {
  return {
    purposeDomain: answers?.purposeDomain ?? "",
    affectedPersons: answers ? [...(answers.affectedPersons ?? [])] : [],
    decisionAutonomy: answers?.decisionAutonomy ?? "",
    biometricUse: answers?.biometricUse ?? "",
    emotionRecognition: yn(answers?.emotionRecognition),
    socialScoring: yn(answers?.socialScoring),
    manipulativeTechniques: yn(answers?.manipulativeTechniques),
    profilesNaturalPersons: yn(answers?.profilesNaturalPersons),
    safetyComponent: yn(answers?.safetyComponent),
    interactsWithHumans: yn(answers?.interactsWithHumans),
    generatesSyntheticContent: yn(answers?.generatesSyntheticContent),
  };
}

/** the answers in the gateway schema's key order, or null while any question is unanswered */
export function answersFromForm(form: ScreeningForm, affectedAnswered: boolean): EuAiActScreeningAnswers | null {
  if (!form.purposeDomain || !form.decisionAutonomy || !form.biometricUse || !affectedAnswered) return null;
  if (BOOLEAN_KEYS.some((key) => !form[key])) return null;
  return {
    purposeDomain: form.purposeDomain,
    affectedPersons: form.affectedPersons,
    decisionAutonomy: form.decisionAutonomy,
    biometricUse: form.biometricUse,
    emotionRecognition: form.emotionRecognition === "yes",
    socialScoring: form.socialScoring === "yes",
    manipulativeTechniques: form.manipulativeTechniques === "yes",
    profilesNaturalPersons: form.profilesNaturalPersons === "yes",
    safetyComponent: form.safetyComponent === "yes",
    interactsWithHumans: form.interactsWithHumans === "yes",
    generatesSyntheticContent: form.generatesSyntheticContent === "yes",
  };
}

export const sameAnswers = (a: EuAiActScreeningAnswers | null | undefined, b: EuAiActScreeningAnswers | null | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export interface DescribeFields {
  name: string;
  description: string;
  businessContext: string;
}

/**
 * The PATCH body: only the text fields that changed, plus the screening
 * answers (always — the gateway re-screens from them). A blank business
 * context reuses the purpose, as registration does.
 */
export function resubmitPatch(current: DescribeFields, edited: DescribeFields, answers: EuAiActScreeningAnswers): Record<string, unknown> {
  const next = {
    name: edited.name.trim(),
    description: edited.description.trim(),
    businessContext: edited.businessContext.trim() || edited.description.trim(),
  };
  const body: Record<string, unknown> = {};
  if (next.name !== current.name) body.name = next.name;
  if (next.description !== current.description) body.description = next.description;
  if (next.businessContext !== current.businessContext) body.businessContext = next.businessContext;
  body.screeningAnswers = answers;
  return body;
}
