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
import type { EuAiActScreeningAnswers, IntakeContextAnswers, IntakeScreeningAnswers } from "../../../api/types";

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
export const answersBlock = (answers: EuAiActScreeningAnswers) => "```" + ANSWERS_FENCE + "\n" + JSON.stringify(euAnswersOf(answers), null, 2) + "\n```";

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
  /** one question on the registration screen: "Generates synthetic content"
   * answers both `generatesSyntheticContent` (EU) and `generative` (context) */
  generatesSyntheticContent: BooleanAnswer;
  sectors: string[];
  dataCategories: string[];
  deployment: string;
  euNexus: BooleanAnswer;
  usesExternalVendor: BooleanAnswer;
  autonomousActions: BooleanAnswer;
  /** not asked on the screen; kept as recorded */
  toolsUsed: string[];
}
export const BOOLEAN_KEYS = [
  "profilesNaturalPersons",
  "interactsWithHumans",
  "generatesSyntheticContent",
  "autonomousActions",
  "usesExternalVendor",
  "euNexus",
  "safetyComponent",
  "emotionRecognition",
  "socialScoring",
  "manipulativeTechniques",
] as const;

const yn = (value: boolean | undefined): BooleanAnswer => (value === undefined ? "" : value ? "yes" : "no");

type RecordedAnswers = EuAiActScreeningAnswers & Partial<IntakeContextAnswers>;

export function formFromAnswers(answers: RecordedAnswers | null | undefined): ScreeningForm {
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
    generatesSyntheticContent: yn(answers?.generatesSyntheticContent ?? answers?.generative),
    // a use case registered before the context answers were stored asks them again
    sectors: [...(answers?.sectors ?? [])],
    dataCategories: [...(answers?.dataCategories ?? [])],
    deployment: answers?.deployment ?? "",
    euNexus: yn(answers?.euNexus),
    usesExternalVendor: yn(answers?.usesExternalVendor),
    autonomousActions: yn(answers?.autonomousActions),
    toolsUsed: [...(answers?.toolsUsed ?? [])],
  };
}

/** every Classify answer in the gateway schema's key order, or null while any question is unanswered */
export function answersFromForm(form: ScreeningForm, affectedAnswered: boolean): IntakeScreeningAnswers | null {
  if (!form.purposeDomain || !form.decisionAutonomy || !form.biometricUse || !affectedAnswered) return null;
  if (!form.deployment || form.sectors.length === 0 || form.dataCategories.length === 0) return null;
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
    sectors: form.sectors,
    dataCategories: form.dataCategories,
    deployment: form.deployment,
    euNexus: form.euNexus === "yes",
    usesExternalVendor: form.usesExternalVendor === "yes",
    generative: form.generatesSyntheticContent === "yes",
    autonomousActions: form.autonomousActions === "yes",
    toolsUsed: form.toolsUsed,
  };
}

/** the EU AI Act subset — what the questionnaire's answers block carries and the tier is screened on */
export function euAnswersOf(answers: EuAiActScreeningAnswers): EuAiActScreeningAnswers {
  return {
    purposeDomain: answers.purposeDomain,
    affectedPersons: answers.affectedPersons,
    decisionAutonomy: answers.decisionAutonomy,
    biometricUse: answers.biometricUse,
    emotionRecognition: answers.emotionRecognition,
    socialScoring: answers.socialScoring,
    manipulativeTechniques: answers.manipulativeTechniques,
    profilesNaturalPersons: answers.profilesNaturalPersons,
    safetyComponent: answers.safetyComponent,
    interactsWithHumans: answers.interactsWithHumans,
    generatesSyntheticContent: answers.generatesSyntheticContent,
  };
}

/** the same answers, by value (key order ignored for the context keys a record may lack) */
export const sameAnswers = (a: RecordedAnswers | null | undefined, b: RecordedAnswers | null | undefined) =>
  JSON.stringify(a ? sortedKeys(a) : null) === JSON.stringify(b ? sortedKeys(b) : null);
/** the EU subsets are equal: the tier is screened on the same answers */
export const sameEuAnswers = (a: RecordedAnswers | null | undefined, b: RecordedAnswers | null | undefined) =>
  sameAnswers(a ? euAnswersOf(a) : null, b ? euAnswersOf(b) : null);
const sortedKeys = (o: object) => Object.fromEntries(Object.entries(o).sort(([x], [y]) => x.localeCompare(y)));

export interface DescribeFields {
  description: string;
  businessContext: string;
}

/**
 * The PATCH body: only the text fields that changed, plus every Classify
 * answer (always — the gateway re-screens the tier from them and re-derives
 * the data sensitivity from the data categories). A blank business context
 * reuses the purpose, as registration does. The name is not sent: a
 * registered use case's name has no edit.
 */
export function resubmitPatch(current: DescribeFields, edited: DescribeFields, answers: IntakeScreeningAnswers): Record<string, unknown> {
  const next = {
    description: edited.description.trim(),
    businessContext: edited.businessContext.trim() || edited.description.trim(),
  };
  const body: Record<string, unknown> = {};
  if (next.description !== current.description) body.description = next.description;
  if (next.businessContext !== current.businessContext) body.businessContext = next.businessContext;
  body.screeningAnswers = answers;
  return body;
}
