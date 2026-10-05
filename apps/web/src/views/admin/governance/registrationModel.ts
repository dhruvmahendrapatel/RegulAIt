/**
 * The registration wizard's state, as plain data (ADR-0171): the answers, the
 * assistant's proposal and the proposer's decisions about it. Pure, so the
 * rules the page relies on — what counts as a changed classification, what a
 * re-draft may replace, which answers are still missing, what an "unsure"
 * answer sends — are unit-tested apart from the page that renders them.
 */
import type { EuAiActScreeningAnswers, IntakeContextAnswers } from "../../../api/types";
import { canonicalDigest, emptyCheckpoint, type SubmissionCheckpoint, type UseCaseInputs } from "./intakeCheckpoint";

export type Source = "rules" | "mock" | "model";
export type Decision = "accepted" | "rejected";

/** `kept`: no longer suggested by the current answers, kept because the proposer chose to keep their edits */
export interface FrameworkSuggestion { source: Source; framework: string; title: string; why: string; kept?: boolean }
export interface RiskSuggestion {
  source: Source;
  scenarioKey: string;
  title: string;
  description: string;
  category: string;
  dimension: string;
  likelihood: "low" | "medium" | "high";
  impact: "low" | "medium" | "high";
  suggestedControls: string[];
  why: string;
  kept?: boolean;
}
export interface QuestionnaireSuggestion { source: Source; id: string; heading: string; text: string; kept?: boolean }
export interface IntakeAssistResponse {
  tier: { value: string; reasons: Array<{ ruleId: string; tier: string; ref: string; reason: string }>; rulesetVersion: number; source: "rules"; disclaimer: string };
  frameworks: FrameworkSuggestion[];
  risks: RiskSuggestion[];
  euAiActBlock: string;
  questionnaire: QuestionnaireSuggestion[];
  blocking: { reason?: string } | string | null;
  narrative: { status: string; source?: "model" | "mock"; [key: string]: unknown };
  disclaimer: string;
}

/** a yes/no screening answer; "unsure" counts as YES (the conservative reading) and is recorded as unsure */
export type BooleanAnswer = "" | "yes" | "no" | "unsure";

/** the yes/no questions, in the order the Classify step asks them */
export const BOOLEAN_QUESTIONS = [
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
export type BooleanQuestion = (typeof BOOLEAN_QUESTIONS)[number];
/** the ones the EU AI Act answers block (and so the tier) carries */
const EU_BOOLEANS: ReadonlySet<BooleanQuestion> = new Set([
  "emotionRecognition", "socialScoring", "manipulativeTechniques", "profilesNaturalPersons",
  "safetyComponent", "interactsWithHumans", "generatesSyntheticContent",
]);

export interface RegistrationForm {
  title: string;
  description: string;
  businessContext: string;
  purposeDomain: string;
  affectedPerson: string;
  decisionAutonomy: string;
  biometricUse: string;
  deployment: string;
  sectors: string[];
  dataCategories: string[];
  answers: Record<BooleanQuestion, BooleanAnswer>;
}

export const emptyForm = (prefill: { title?: string | null; description?: string | null } = {}): RegistrationForm => ({
  title: prefill.title ?? "",
  description: prefill.description ?? "",
  businessContext: "",
  purposeDomain: "",
  affectedPerson: "",
  decisionAutonomy: "",
  biometricUse: "",
  deployment: "",
  sectors: [],
  dataCategories: [],
  answers: Object.fromEntries(BOOLEAN_QUESTIONS.map((key) => [key, ""])) as Record<BooleanQuestion, BooleanAnswer>,
});

/** the worked example (a fictional bank's credit-limit assistant) — only on request */
export const exampleForm = (): RegistrationForm => ({
  title: "Credit-limit-increase assistant",
  description: "Helps Acme Bank customers request a credit-limit increase using profile and financial data, with a human reviewing every recommendation.",
  businessContext: "Faster answers for customers while every lending decision stays with an accountable person.",
  purposeDomain: "essential-services",
  affectedPerson: "customers",
  decisionAutonomy: "human-reviews",
  biometricUse: "none",
  deployment: "customer-facing",
  sectors: ["financial-services"],
  dataCategories: ["personal", "financial"],
  answers: {
    profilesNaturalPersons: "yes",
    interactsWithHumans: "yes",
    generatesSyntheticContent: "yes",
    autonomousActions: "no",
    usesExternalVendor: "yes",
    euNexus: "yes",
    safetyComponent: "no",
    emotionRecognition: "no",
    socialScoring: "no",
    manipulativeTechniques: "no",
  },
});

/** "unsure" is a yes for every purpose except the record of who was unsure */
const asBool = (answer: BooleanAnswer) => answer === "yes" || answer === "unsure";

/** the EU AI Act set the tier is screened on, in the gateway's shape */
export const euAiActAnswers = (form: RegistrationForm): EuAiActScreeningAnswers => ({
  purposeDomain: form.purposeDomain,
  affectedPersons: form.affectedPerson === "none" ? [] : [form.affectedPerson],
  decisionAutonomy: form.decisionAutonomy,
  biometricUse: form.biometricUse,
  emotionRecognition: asBool(form.answers.emotionRecognition),
  socialScoring: asBool(form.answers.socialScoring),
  manipulativeTechniques: asBool(form.answers.manipulativeTechniques),
  profilesNaturalPersons: asBool(form.answers.profilesNaturalPersons),
  safetyComponent: asBool(form.answers.safetyComponent),
  interactsWithHumans: asBool(form.answers.interactsWithHumans),
  generatesSyntheticContent: asBool(form.answers.generatesSyntheticContent),
});

/** the context answers beyond the EU AI Act set */
export const contextAnswers = (form: RegistrationForm): IntakeContextAnswers => ({
  sectors: form.sectors,
  dataCategories: form.dataCategories,
  deployment: form.deployment,
  euNexus: asBool(form.answers.euNexus),
  usesExternalVendor: asBool(form.answers.usesExternalVendor),
  generative: asBool(form.answers.generatesSyntheticContent),
  autonomousActions: asBool(form.answers.autonomousActions),
  toolsUsed: [],
});

/** every question answered "not sure", in question order */
export const unsureKeys = (form: RegistrationForm): BooleanQuestion[] => BOOLEAN_QUESTIONS.filter((key) => form.answers[key] === "unsure");
/** the unsure answers the EU AI Act answers block can carry (its own keys only) */
export const euUnsureKeys = (form: RegistrationForm): BooleanQuestion[] => unsureKeys(form).filter((key) => EU_BOOLEANS.has(key));

/**
 * What the assistant's proposal was drafted from. Two forms with the same
 * fingerprint get the same rules-based tier, frameworks and risks, so going
 * Back and continuing unchanged never re-drafts (AER-051). An "unsure" answer
 * fingerprints as the yes it counts as; the Describe text is not part of it —
 * the proposer's own words are never a reason to replace their edits.
 */
export const classificationFingerprint = (form: RegistrationForm) =>
  canonicalDigest({ euAiAct: euAiActAnswers(form), context: contextAnswers(form) });

/** the questions the Classify step asks, by group, with the names the page shows */
export const CLASSIFY_GROUPS: ReadonlyArray<{ group: string; questions: ReadonlyArray<{ key: string; label: string }> }> = [
  {
    group: "Purpose and people",
    questions: [
      { key: "purposeDomain", label: "Primary purpose domain" },
      { key: "affectedPerson", label: "People affected" },
      { key: "decisionAutonomy", label: "Decision autonomy" },
      { key: "deployment", label: "Deployment audience" },
      { key: "biometricUse", label: "Biometric use" },
    ],
  },
  {
    group: "Data and sector",
    questions: [
      { key: "dataCategories", label: "Data categories" },
      { key: "sectors", label: "Sectors" },
    ],
  },
  {
    group: "What it does in practice",
    questions: [
      { key: "profilesNaturalPersons", label: "Profiles natural persons" },
      { key: "interactsWithHumans", label: "Interacts directly with people" },
      { key: "generatesSyntheticContent", label: "Generates synthetic content" },
      { key: "autonomousActions", label: "Can take autonomous actions" },
      { key: "usesExternalVendor", label: "Uses an external AI vendor" },
      { key: "euNexus", label: "Has an EU nexus" },
      { key: "safetyComponent", label: "Safety component" },
      { key: "emotionRecognition", label: "Emotion recognition" },
      { key: "socialScoring", label: "Social scoring" },
      { key: "manipulativeTechniques", label: "Manipulative techniques" },
    ],
  },
];

/** a yes/no question's name, for "Owner unsure about: …" */
export const questionLabel = (key: string) =>
  CLASSIFY_GROUPS.flatMap((g) => g.questions).find((q) => q.key === key)?.label ?? key;

export interface MissingAnswer { key: string; label: string; group: string }

/** every unanswered Classify question, in page order, with the group it sits in */
export function missingAnswers(form: RegistrationForm): MissingAnswer[] {
  return missingFrom((key) => (key in form.answers ? form.answers[key as BooleanQuestion] : (form as unknown as Record<string, unknown>)[key]));
}

/** the same, for any form that can say what a question's answer is ("" or [] = unanswered) */
export function missingFrom(value: (key: string) => unknown): MissingAnswer[] {
  const out: MissingAnswer[] = [];
  for (const { group, questions } of CLASSIFY_GROUPS) {
    for (const { key, label } of questions) {
      const v = value(key);
      if (Array.isArray(v) ? v.length === 0 : !v) out.push({ key, label, group });
    }
  }
  return out;
}

/**
 * The questionnaire's EU AI Act answers block with the unsure answers recorded
 * in it, so the version the reviewer decides on says which answers were
 * guesses. Without any, the block is returned exactly as the assistant drafted
 * it (byte for byte).
 */
export function withUnsure(block: string, unsure: readonly string[]): string {
  if (unsure.length === 0) return block;
  const match = /```eu-ai-act-answers[^\S\n]*\n([\s\S]*?)```/.exec(block);
  if (!match) return block;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[1]!) as Record<string, unknown>;
  } catch {
    return block;
  }
  const next = "```eu-ai-act-answers\n" + JSON.stringify({ ...parsed, unsure: [...unsure] }, null, 2) + "\n```";
  return block.replace(match[0], next);
}

// ---------------------------------------------------------------------------
// The proposer's decisions about a proposal, and what a re-draft may change
// ---------------------------------------------------------------------------

export interface ProposalState {
  decisions: Record<string, Decision>;
  /** edited framework rationales and risk descriptions, by `framework:<tag>` / `risk:<key>` */
  suggestionEdits: Record<string, string>;
  /** the questionnaire answers as the proposer has them, by section id */
  questionnaire: Record<string, string>;
}

export const frameworkKey = (item: FrameworkSuggestion) => `framework:${item.framework}`;
export const riskKey = (item: RiskSuggestion) => `risk:${item.scenarioKey}`;
export const questionKey = (item: QuestionnaireSuggestion) => `question:${item.id}`;

/** the state a FIRST proposal starts from: frameworks and risks undecided, questionnaire drafts included */
export function initialProposalState(proposal: IntakeAssistResponse): ProposalState {
  return {
    decisions: Object.fromEntries(proposal.questionnaire.map((item) => [questionKey(item), "accepted" as const])),
    suggestionEdits: {},
    questionnaire: Object.fromEntries(proposal.questionnaire.map((item) => [item.id, item.text])),
  };
}

export interface ProposalDiff {
  tier: { from: string; to: string } | null;
  frameworks: { added: FrameworkSuggestion[]; removed: FrameworkSuggestion[] };
  risks: { added: RiskSuggestion[]; removed: RiskSuggestion[] };
  /** sections whose drafted answer differs, and whether the proposer had edited them */
  questionnaire: { changed: Array<{ item: QuestionnaireSuggestion; edited: boolean }>; added: QuestionnaireSuggestion[]; removed: QuestionnaireSuggestion[] };
  /** suggestions that go away and carry the proposer's own decision or edit */
  touchedRemovals: string[];
}

/** what a new proposal (drafted from changed answers) would change, against the proposer's current state */
export function diffProposals(before: IntakeAssistResponse, after: IntakeAssistResponse, state: ProposalState): ProposalDiff {
  const by = <T,>(items: T[], key: (item: T) => string) => new Map(items.map((item) => [key(item), item]));
  const fwBefore = by(before.frameworks, frameworkKey);
  const fwAfter = by(after.frameworks, frameworkKey);
  const rBefore = by(before.risks, riskKey);
  const rAfter = by(after.risks, riskKey);
  const qBefore = by(before.questionnaire, (q) => q.id);
  const qAfter = by(after.questionnaire, (q) => q.id);
  const removedFw = before.frameworks.filter((f) => !fwAfter.has(frameworkKey(f)));
  const removedRisks = before.risks.filter((r) => !rAfter.has(riskKey(r)));
  const touched = (key: string) => key in state.decisions || key in state.suggestionEdits;
  return {
    tier: before.tier.value !== after.tier.value ? { from: before.tier.value, to: after.tier.value } : null,
    frameworks: { added: after.frameworks.filter((f) => !fwBefore.has(frameworkKey(f))), removed: removedFw },
    risks: { added: after.risks.filter((r) => !rBefore.has(riskKey(r))), removed: removedRisks },
    questionnaire: {
      changed: after.questionnaire
        .filter((q) => qBefore.has(q.id) && qBefore.get(q.id)!.text !== q.text)
        .map((item) => ({ item, edited: (state.questionnaire[item.id] ?? qBefore.get(item.id)!.text) !== qBefore.get(item.id)!.text })),
      added: after.questionnaire.filter((q) => !qBefore.has(q.id)),
      removed: before.questionnaire.filter((q) => !qAfter.has(q.id)),
    },
    touchedRemovals: [
      ...removedFw.filter((f) => touched(frameworkKey(f))).map((f) => f.title),
      ...removedRisks.filter((r) => touched(riskKey(r))).map((r) => r.title),
    ],
  };
}

/** does the new proposal change anything the proposer decided or wrote? */
export const diffIsEmpty = (d: ProposalDiff) =>
  !d.tier && d.frameworks.added.length === 0 && d.frameworks.removed.length === 0 && d.risks.added.length === 0 &&
  d.risks.removed.length === 0 && d.questionnaire.changed.length === 0 && d.questionnaire.added.length === 0 && d.questionnaire.removed.length === 0;

/**
 * Apply a proposal drafted from CHANGED answers (AER-051), with the proposer's
 * explicit choice:
 *
 *   regenerate — the affected sections take the new draft: suggestions that no
 *                longer apply are removed together with their decisions and
 *                edits (deliberately, never left stale); new ones arrive
 *                undecided; questionnaire sections whose draft changed take
 *                the new text. Everything unaffected keeps its decision/edit.
 *   keep       — nothing the proposer wrote or decided is replaced or removed:
 *                suggestions that no longer apply stay, with their decisions;
 *                new ones arrive undecided; every questionnaire answer keeps
 *                its current text.
 *
 * Either way the tier and the EU AI Act answers block follow the new answers —
 * they are generated from them, never the proposer's text.
 */
export function applyProposal(
  mode: "regenerate" | "keep",
  before: IntakeAssistResponse,
  after: IntakeAssistResponse,
  state: ProposalState,
): { proposal: IntakeAssistResponse; state: ProposalState } {
  const decisions: Record<string, Decision> = {};
  const suggestionEdits: Record<string, string> = {};
  const questionnaire: Record<string, string> = {};
  const keepKey = (key: string) => {
    if (state.decisions[key]) decisions[key] = state.decisions[key]!;
    if (key in state.suggestionEdits) suggestionEdits[key] = state.suggestionEdits[key]!;
  };
  const afterFw = new Set(after.frameworks.map(frameworkKey));
  const afterRisks = new Set(after.risks.map(riskKey));
  const afterQ = new Map(after.questionnaire.map((q) => [q.id, q]));
  const beforeQ = new Map(before.questionnaire.map((q) => [q.id, q]));

  const frameworks = [...after.frameworks];
  const risks = [...after.risks];
  const sections = [...after.questionnaire];
  for (const item of after.frameworks) keepKey(frameworkKey(item));
  for (const item of after.risks) keepKey(riskKey(item));
  if (mode === "keep") {
    for (const item of before.frameworks) if (!afterFw.has(frameworkKey(item))) { frameworks.push({ ...item, kept: true }); keepKey(frameworkKey(item)); }
    for (const item of before.risks) if (!afterRisks.has(riskKey(item))) { risks.push({ ...item, kept: true }); keepKey(riskKey(item)); }
    for (const item of before.questionnaire) if (!afterQ.has(item.id)) sections.push({ ...item, kept: true });
  }
  for (const item of sections) {
    const key = questionKey(item);
    const old = beforeQ.get(item.id);
    if (!old) {
      // a section the earlier draft did not have: included, as drafted
      decisions[key] = "accepted";
      questionnaire[item.id] = item.text;
      continue;
    }
    decisions[key] = state.decisions[key] ?? "accepted";
    const current = state.questionnaire[item.id] ?? old.text;
    questionnaire[item.id] = mode === "regenerate" && old.text !== item.text ? item.text : current;
  }
  return {
    proposal: { ...after, frameworks, risks, questionnaire: sections },
    state: { decisions, suggestionEdits, questionnaire },
  };
}

// ---------------------------------------------------------------------------
// The draft the wizard keeps on the server (ADR-0171 item 1)
// ---------------------------------------------------------------------------

/** a submission attempt: the key the create was (or will be) sent with, and exactly what it sent */
export interface SubmissionAttempt { key: string; useCase: UseCaseInputs }

export interface RegistrationDraft {
  kind: "registration";
  version: 1;
  step: number;
  form: RegistrationForm;
  proposal: IntakeAssistResponse | null;
  /** the classification the proposal was drafted from */
  proposalFingerprint: string | null;
  proposalState: ProposalState;
  agentId: string;
  vendorId: string;
  checkpoint: SubmissionCheckpoint;
  attempt: SubmissionAttempt | null;
}

/** a saved draft read back, or null when it is not one this page wrote */
export function readRegistrationDraft(state: unknown): RegistrationDraft | null {
  if (!state || typeof state !== "object") return null;
  const d = state as Partial<RegistrationDraft>;
  if (d.kind !== "registration" || d.version !== 1 || !d.form || typeof d.step !== "number") return null;
  const blank = emptyForm();
  return {
    kind: "registration",
    version: 1,
    step: d.step,
    form: { ...blank, ...d.form, answers: { ...blank.answers, ...(d.form.answers ?? {}) } },
    proposal: d.proposal ?? null,
    proposalFingerprint: d.proposalFingerprint ?? null,
    proposalState: d.proposalState ?? { decisions: {}, suggestionEdits: {}, questionnaire: {} },
    agentId: d.agentId ?? "",
    vendorId: d.vendorId ?? "",
    checkpoint: d.checkpoint ?? emptyCheckpoint(),
    attempt: d.attempt ?? null,
  };
}

// ---------------------------------------------------------------------------
// What the record and the review task show of it (ADR-0171 items 4 and 5)
// ---------------------------------------------------------------------------

type DetailLike = { useCase?: Record<string, unknown> | null; frameworkRationales?: unknown; screeningUnsure?: unknown; resubmission?: { screeningAnswers?: { unsure?: unknown } | null } | null };

/** the owner's framework explanations from a detail read ({} when none or not served) */
export function detailRationales(detail: DetailLike | null | undefined): Record<string, string> {
  const raw = detail?.frameworkRationales ?? detail?.useCase?.frameworkRationales;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== ""));
}

/** the screening answers the owner was not sure about, from a detail read ([] when none or not served) */
export function detailUnsure(detail: DetailLike | null | undefined): string[] {
  const raw = detail?.screeningUnsure ?? detail?.useCase?.screeningUnsure ?? detail?.resubmission?.screeningAnswers?.unsure;
  // one question answers both generative keys: name it once
  return Array.isArray(raw)
    ? [...new Set(raw.filter((k): k is string => typeof k === "string").map((k) => (k === "generative" ? "generatesSyntheticContent" : k)))]
    : [];
}

/** a fresh key for one submission attempt (reused on every retry of it) */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Was the create's outcome unknown? A dropped connection or a server error may
 * have come after the record was committed, so the attempt's key must be
 * reused. A refusal (4xx) created nothing, so the next attempt may start fresh
 * — except `idempotency_key_in_flight` (ADR-0179): the request with that key
 * has not finished, so it may still create, and the key must be kept.
 */
export function outcomeUnknown(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  const code = (error as { payload?: { error?: unknown } } | null)?.payload?.error;
  return typeof status !== "number" || status >= 500 || status === 408 || (status === 409 && code === "idempotency_key_in_flight");
}
