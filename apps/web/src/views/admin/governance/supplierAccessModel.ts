/**
 * The supplier portal's admin screens (ADR-0221): the shapes the gateway answers and the pure checks the forms run
 * before sending. The gateway re-checks everything; these only let a form say what is wrong next to the field.
 */
import { QUESTION_ID_RE, SUPPLIER_LIMITS, type SubmissionStatus } from "../../supplier/supplierPortal";

export type AccessState = "active" | "expired" | "revoked";
export type LinkState = "active" | "used" | "expired" | "revoked";

export interface SupplierLink {
  id: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  state: LinkState;
}
export interface SupplierGrant {
  id: string;
  email: string;
  framework: string;
  questionnaire: { id: string; name: string | null; version: number | null } | null;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  state: AccessState;
  liveSessions: number;
  links: SupplierLink[];
}
export interface SupplierAccessList {
  enabled: boolean;
  access: SupplierGrant[];
}
export interface IssuedLink {
  link: { url: string; expiresAt: string };
  notice: string;
}

export interface SupplierQuestion {
  id: string;
  prompt: string;
  help: string;
  required: boolean;
  allowFile: boolean;
  controlRef: string | null;
}
export interface SupplierQuestionnaire {
  id: string;
  name: string;
  version: number;
  description: string;
  questions: SupplierQuestion[];
  createdAt: string;
  retiredAt: string | null;
}

export interface ReviewSubmission {
  id: string;
  kind: "control" | "question";
  controlRef: string | null;
  questionnaireId: string | null;
  questionId: string | null;
  statement: string;
  file: { name: string; contentType: string | null; size: number | null; sha256: string | null; scanStatus: string | null } | null;
  status: SubmissionStatus;
  decisionReason: string | null;
  decidedAt: string | null;
  createdAt: string;
  accessId: string;
  /** the grant the answer came through, as it stands now: a revoked grant's answers cannot be accepted */
  accessState: AccessState;
  supplierEmail: string;
  framework: string;
}

export const ACCESS_STATE_LABEL: Record<AccessState, string> = { active: "Active", expired: "Expired", revoked: "Revoked" };
export const LINK_STATE_LABEL: Record<LinkState, string> = {
  active: "Link not used yet",
  used: "Link used",
  expired: "Link expired",
  revoked: "Link withdrawn",
};

/** beside the supplier's address on an answer; nothing for a grant that is still active */
export const ANSWER_ACCESS_LABEL: Record<AccessState, string | null> = {
  active: null,
  expired: "Access expired",
  revoked: "Access revoked",
};

/** a reviewer may decide only an answer still waiting; accepting one needs a grant that was not revoked */
export const canDecide = (s: Pick<ReviewSubmission, "status">) => s.status === "submitted";
export const canAccept = (s: Pick<ReviewSubmission, "status" | "accessState">) => canDecide(s) && s.accessState !== "revoked";

/** the shown name of what an answer is for; never the internal question id */
export function answerTargetLabel(
  s: Pick<ReviewSubmission, "kind" | "controlRef" | "questionnaireId" | "questionId">,
  questionnaires: readonly SupplierQuestionnaire[],
): string {
  if (s.kind === "control") return s.controlRef ?? "Control";
  return findQuestion(s, questionnaires)?.prompt ?? "Question (from an earlier version)";
}

function findQuestion(
  s: Pick<ReviewSubmission, "questionnaireId" | "questionId">,
  questionnaires: readonly SupplierQuestionnaire[],
): SupplierQuestion | undefined {
  const q = questionnaires.find((x) => x.id === s.questionnaireId);
  return q?.questions.find((x) => x.id === s.questionId);
}

/**
 * What accepting this answer does, mirroring the gateway: an answer to a control, or to a question linked to one, is
 * recorded as a vendor-attested claim; an answer to a question with no linked control is only marked accepted.
 * `unknown` when the question's version is not in the list the screen has.
 */
export type AcceptOutcome = "attestation" | "no_control" | "unknown";
export function acceptOutcome(
  s: Pick<ReviewSubmission, "kind" | "questionnaireId" | "questionId">,
  questionnaires: readonly SupplierQuestionnaire[],
): AcceptOutcome {
  if (s.kind === "control") return "attestation";
  const q = findQuestion(s, questionnaires);
  if (!q) return "unknown";
  return q.controlRef ? "attestation" : "no_control";
}

/** a file that is not known to be clean asks the reviewer to confirm before it downloads */
export const needsUnscannedConfirm = (file: { scanStatus: string | null } | null): boolean => file !== null && file.scanStatus !== "clean";

/** the file's address; `acknowledgeUnscanned` carries the reviewer's confirmation for a file nobody scanned */
export const answerFilePath = (vendorId: string, submissionId: string, acknowledgeUnscanned: boolean) =>
  `/v1/vendors/${vendorId}/supplier-submissions/${submissionId}/file${acknowledgeUnscanned ? "?acknowledgeUnscanned=1" : ""}`;

/** the name a downloaded file is saved under: a CSV is served as plain text, so it is saved as `.txt` too */
export const downloadName = (file: { name: string; contentType: string | null }) =>
  file.contentType === "text/csv" ? `${file.name}.txt` : file.name;

/** the newest link's state, which is the one that matters; null when the grant has none */
export function latestLink(g: SupplierGrant): SupplierLink | null {
  if (g.links.length === 0) return null;
  return [...g.links].sort((a, b) => b.expiresAt.localeCompare(a.expiresAt))[0] ?? null;
}

/** a whole number within [min, max], or null */
export function wholeInRange(raw: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

export interface InviteDraft {
  email: string;
  framework: string;
  questionnaireId: string;
  accessDays: string;
  inviteHours: string;
}
export const EMPTY_INVITE: InviteDraft = {
  email: "",
  framework: "",
  questionnaireId: "",
  accessDays: String(SUPPLIER_LIMITS.accessDaysDefault),
  inviteHours: String(SUPPLIER_LIMITS.inviteHoursDefault),
};

/** one @, no whitespace, 3–254 characters: the gateway's own rule */
export const looksLikeEmail = (e: string): boolean => {
  const t = e.trim();
  return t.length >= 3 && t.length <= 254 && /^[^@\s]+@[^@\s]+$/.test(t);
};

/** the field problems of an invitation, keyed by field; empty when it may be sent */
export function inviteProblems(d: InviteDraft): Partial<Record<keyof InviteDraft, string>> {
  const out: Partial<Record<keyof InviteDraft, string>> = {};
  if (!looksLikeEmail(d.email)) out.email = "Enter the supplier contact's email address.";
  if (!d.framework) out.framework = "Choose the framework the supplier answers.";
  if (wholeInRange(d.accessDays, 1, SUPPLIER_LIMITS.accessDaysMax) === null) {
    out.accessDays = `A whole number of days from 1 to ${SUPPLIER_LIMITS.accessDaysMax}.`;
  }
  if (wholeInRange(d.inviteHours, 1, SUPPLIER_LIMITS.inviteHoursMax) === null) {
    out.inviteHours = `A whole number of hours from 1 to ${SUPPLIER_LIMITS.inviteHoursMax}.`;
  }
  return out;
}

/** the request body of an invitation (call only when inviteProblems is empty) */
export function inviteBody(d: InviteDraft) {
  return {
    email: d.email.trim(),
    framework: d.framework,
    questionnaireId: d.questionnaireId || null,
    accessDays: Number(d.accessDays.trim()),
    inviteHours: Number(d.inviteHours.trim()),
  };
}

/** questionnaires grouped by name, each group's versions newest first, groups by name */
export function groupQuestionnaires(rows: SupplierQuestionnaire[]): Array<{ name: string; versions: SupplierQuestionnaire[] }> {
  const by = new Map<string, SupplierQuestionnaire[]>();
  for (const q of rows) by.set(q.name, [...(by.get(q.name) ?? []), q]);
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en-GB"))
    .map(([name, versions]) => ({ name, versions: versions.sort((a, b) => b.version - a.version) }));
}

/** the versions an access may still use (not retired) */
export const usableQuestionnaires = (rows: SupplierQuestionnaire[]) => rows.filter((q) => q.retiredAt === null);

/** "Security basics, version 2" */
export const questionnaireLabel = (q: { name: string | null; version: number | null }) =>
  `${q.name ?? "Questionnaire"}${q.version != null ? `, version ${q.version}` : ""}`;

// ---- the questionnaire builder ------------------------------------------------------------------------------

export interface QuestionDraft {
  id: string;
  prompt: string;
  help: string;
  required: boolean;
  allowFile: boolean;
  controlRef: string;
}
export const QUESTIONS_MAX = 100;

export const blankQuestion = (id: string): QuestionDraft => ({ id, prompt: "", help: "", required: true, allowFile: false, controlRef: "" });

/** the first unused `q1`, `q2`, … */
export function nextQuestionId(existing: readonly QuestionDraft[]): string {
  const taken = new Set(existing.map((q) => q.id));
  for (let i = 1; ; i++) if (!taken.has(`q${i}`)) return `q${i}`;
}

export const draftsFrom = (qs: readonly SupplierQuestion[]): QuestionDraft[] =>
  qs.map((q) => ({ id: q.id, prompt: q.prompt, help: q.help, required: q.required, allowFile: q.allowFile, controlRef: q.controlRef ?? "" }));

/** per question (by index) what is wrong, plus a problem for the list as a whole */
export function questionProblems(qs: readonly QuestionDraft[]): { list: string | null; byIndex: Array<string | null> } {
  const counts = new Map<string, number>();
  for (const q of qs) counts.set(q.id, (counts.get(q.id) ?? 0) + 1);
  const byIndex = qs.map((q) => {
    if (!QUESTION_ID_RE.test(q.id)) return "The question ID uses lower-case letters, digits, hyphens and underscores, starting with a letter or digit (at most 64).";
    if ((counts.get(q.id) ?? 0) > 1) return "Two questions share this ID. Each ID must be different.";
    if (!q.prompt.trim()) return "Write the question.";
    if (q.prompt.trim().length > 1000) return "The question can be at most 1,000 characters.";
    if (q.help.trim().length > 2000) return "The help text can be at most 2,000 characters.";
    if (q.controlRef.trim().length > 200) return "The control reference can be at most 200 characters.";
    return null;
  });
  const list = qs.length === 0 ? "Add at least one question." : qs.length > QUESTIONS_MAX ? `A questionnaire holds at most ${QUESTIONS_MAX} questions.` : null;
  return { list, byIndex };
}

/** the questions as the gateway takes them */
export const questionsBody = (qs: readonly QuestionDraft[]): SupplierQuestion[] =>
  qs.map((q) => ({
    id: q.id,
    prompt: q.prompt.trim(),
    help: q.help.trim(),
    required: q.required,
    allowFile: q.allowFile,
    controlRef: q.controlRef.trim() || null,
  }));
