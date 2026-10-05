/**
 * AER-046 — the intake wizard's retry checkpoint, bound to the inputs that
 * produced each persisted record.
 *
 * THE DEFECT. Submission is several requests (create the use case, advance
 * planning, store the questionnaire, create each accepted risk, link its
 * controls). A later failure leaves the earlier records written, and the
 * wizard keeps its inputs editable — so the proposer can go Back, change the
 * description, an answer or a risk's text, and retry. The old checkpoint only
 * remembered THAT a step had run ("questionnaireSubmitted: true"), so a retry
 * skipped it and finished the submission with the OLD use case and
 * questionnaire next to NEW risks: a record nobody ever wrote.
 *
 * THE RULE. Every checkpoint entry carries the canonical digest of exactly the
 * inputs its request sent. A retry reuses an entry only when the digest of the
 * CURRENT inputs matches; otherwise it brings the persisted record up to the
 * current inputs through the gateway's own edit path, or — where the gateway
 * has no edit for a field — refuses the whole retry before sending anything:
 *
 *   use case     PATCH /v1/use-cases/:id edits description, businessContext,
 *                intendedAgentIds and the framework explanations (ADR-0171)
 *                while the intake is in flight. It has no
 *                edit for name, dataSensitivity or complianceTags (the create
 *                contract fixes them), and takes the stored Classify answers
 *                (screeningAnswers) only from a use case sent back for
 *                information, so a change there is REFUSED.
 *   questionnaire the honest update is a NEW ARTIFACT VERSION: the kernel
 *                re-opens the workflow at the questionnaire stage and
 *                supersedes the pending sign-off, so the approver reviews the
 *                version that matches the record (never the stale one).
 *   risk         PATCH /v1/risks/:id edits title, description, likelihood,
 *                impact, agentId and vendorId of an open risk. `category` is
 *                the evidence key and is refused by name on PATCH, so a
 *                changed category is REFUSED. Two more are refused BY CHOICE,
 *                not for want of an endpoint: a risk already written for a
 *                scenario the proposer has since rejected (the owner could
 *                close it) and a control already linked that the current
 *                suggestion no longer names (it could be unlinked). A retry
 *                that silently closes risks or unlinks controls is a bigger
 *                write than the proposer asked for; leaving them attached is
 *                the mixed state this module exists to prevent; so the page
 *                stops and says which.
 *
 * The plan is computed for EVERY step before the first request of a retry, so
 * a refusal writes nothing: the persisted state stays exactly what the earlier
 * inputs produced (all-old), and a retry that proceeds and completes leaves
 * every record matching the current inputs (all-new). Never a silent second
 * use case — starting over as a new one is the proposer's explicit choice.
 *
 * WHY THE DIGEST IS THE CANONICAL FORM ITSELF. The checkpoint lives in page
 * memory and is compared, never transmitted, so the canonical serialisation
 * (sorted keys, `undefined` dropped, array order kept) is used directly: two
 * input sets share a digest exactly when they are the same inputs — no hash,
 * so no collision to reason about.
 */

import type { IntakeScreeningAnswers } from "../../../api/types";

/** Stable serialisation: object keys sorted at every depth, `undefined` members dropped, array order kept. */
export function canonicalDigest(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : canonicalise(item)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) out[key] = canonicalise(member);
    }
    return out;
  }
  return value;
}

/** what POST /v1/use-cases is sent */
export interface UseCaseInputs {
  name: string;
  description: string;
  businessContext: string;
  dataSensitivity: string;
  complianceTags: string[];
  intendedAgentIds: string[];
  /** every Classify-step answer (ADR-0168 amendment), stored for resubmission */
  screeningAnswers?: IntakeScreeningAnswers;
  /** ADR-0171: the proposer's own explanation of why an accepted framework applies, by framework tag */
  frameworkRationales?: Record<string, string>;
}

/** what POST /v1/risks is sent, less `useCaseId` (always the checkpoint's own use case) */
export interface RiskInputs {
  title: string;
  description: string;
  category: string;
  likelihood: string;
  impact: string;
  agentId?: string;
  vendorId?: string;
}

export interface SubmissionInputs {
  useCase: UseCaseInputs;
  /** the questionnaire artifact's full content */
  questionnaire: string;
  /** the ACCEPTED risks, keyed by scenario */
  risks: Array<{ key: string; inputs: RiskInputs; controls: string[] }>;
}

export interface SubmissionCheckpoint {
  useCase?: { id: string; instanceId?: string; inputs: UseCaseInputs; digest: string };
  planningAdvanced?: boolean;
  questionnaire?: { digest: string };
  risks: Record<string, { id: string; inputs: RiskInputs; digest: string; linkedControls: string[] }>;
}

export const emptyCheckpoint = (): SubmissionCheckpoint => ({ risks: {} });

const USE_CASE_PATCHABLE = ["description", "businessContext", "intendedAgentIds", "frameworkRationales"] as const;
const USE_CASE_PATCHABLE_LABEL: Record<(typeof USE_CASE_PATCHABLE)[number], string> = {
  description: "the description",
  businessContext: "the business context",
  intendedAgentIds: "the intended agents",
  frameworkRationales: "the framework explanations",
};
const USE_CASE_FIXED: Array<{ key: keyof UseCaseInputs; label: string }> = [
  { key: "name", label: "the use-case name" },
  { key: "dataSensitivity", label: "the data categories (the derived data sensitivity)" },
  { key: "complianceTags", label: "the accepted frameworks" },
  // stored with the use case at registration; PATCH takes them only once a
  // reviewer sends the use case back, so a changed answer cannot be applied
  { key: "screeningAnswers", label: "the classification answers" },
];
const RISK_PATCHABLE = ["title", "description", "likelihood", "impact", "agentId", "vendorId"] as const;

export type UseCasePatch = Partial<Pick<UseCaseInputs, (typeof USE_CASE_PATCHABLE)[number]>>;
export type RiskPatch = { [K in (typeof RISK_PATCHABLE)[number]]?: RiskInputs[K] | null };

export type StepAction<P> = { action: "create" } | { action: "reuse" } | { action: "update"; patch: P };

export type SubmissionPlan =
  | { kind: "refuse"; useCaseId: string; reasons: string[] }
  | {
      kind: "proceed";
      useCase: StepAction<UseCasePatch>;
      /** "submit" stores the first version; "resubmit" stores a new version over a stale one */
      questionnaire: "submit" | "reuse" | "resubmit";
      risks: Array<{ key: string; step: StepAction<RiskPatch>; controlsToLink: string[] }>;
    };

const same = (a: unknown, b: unknown) => canonicalDigest(a) === canonicalDigest(b);
// the accepted frameworks are a SET: the same tags in another order are not a change
const sameFixed = (key: keyof UseCaseInputs, a: unknown, b: unknown) =>
  key === "complianceTags" && Array.isArray(a) && Array.isArray(b) ? same([...a].sort(), [...b].sort()) : same(a, b);

/**
 * Decide, for every step, whether the checkpointed record is reused, created,
 * updated to the current inputs, or cannot be reconciled (refuse). Pure: the
 * caller executes the plan and records each success in the checkpoint.
 */
export function planSubmission(checkpoint: SubmissionCheckpoint, inputs: SubmissionInputs): SubmissionPlan {
  const reasons: string[] = [];

  let useCase: StepAction<UseCasePatch> = { action: "create" };
  if (checkpoint.useCase) {
    const before = checkpoint.useCase.inputs;
    if (checkpoint.useCase.digest === canonicalDigest(inputs.useCase)) {
      useCase = { action: "reuse" };
    } else {
      for (const { key, label } of USE_CASE_FIXED) {
        if (!sameFixed(key, before[key], inputs.useCase[key])) reasons.push(`${label} changed — a proposed use case has no edit for it`);
      }
      const patch: UseCasePatch = {};
      for (const key of USE_CASE_PATCHABLE) {
        // an emptied set of framework explanations is sent as {}, the PATCH that clears them
        if (!same(before[key], inputs.useCase[key])) (patch as Record<string, unknown>)[key] = inputs.useCase[key] ?? (key === "frameworkRationales" ? {} : undefined);
      }
      // once the questionnaire is stored the use case is WITH ITS REVIEWERS,
      // and nothing about it may change under them (the gateway refuses the
      // PATCH): refuse here, before anything is sent
      if (checkpoint.questionnaire) {
        for (const key of USE_CASE_PATCHABLE) {
          if (key in patch) reasons.push(`${USE_CASE_PATCHABLE_LABEL[key]} changed after the use case went to its reviewers — it can't be edited while it is under review`);
        }
      }
      useCase = Object.keys(patch).length > 0 ? { action: "update", patch } : { action: "reuse" };
    }
  }

  const questionnaireDigest = canonicalDigest(inputs.questionnaire);
  const questionnaire = !checkpoint.questionnaire
    ? "submit"
    : checkpoint.questionnaire.digest === questionnaireDigest
      ? "reuse"
      : "resubmit";

  const accepted = new Set(inputs.risks.map((risk) => risk.key));
  for (const [key, written] of Object.entries(checkpoint.risks)) {
    if (!accepted.has(key)) reasons.push(`the risk "${written.inputs.title}" was already recorded, and its scenario is no longer accepted`);
  }
  const risks = inputs.risks.map(({ key, inputs: current, controls }) => {
    const written = checkpoint.risks[key];
    if (!written) return { key, step: { action: "create" } as StepAction<RiskPatch>, controlsToLink: controls };
    const stale = written.linkedControls.filter((ref) => !controls.includes(ref));
    if (stale.length > 0) reasons.push(`the risk "${written.inputs.title}" already links ${stale.join(", ")}, which its current suggestion no longer names`);
    const controlsToLink = controls.filter((ref) => !written.linkedControls.includes(ref));
    if (written.digest === canonicalDigest(current)) return { key, step: { action: "reuse" } as StepAction<RiskPatch>, controlsToLink };
    if (written.inputs.category !== current.category) {
      reasons.push(`the risk "${written.inputs.title}" changed category — a risk's category is its evidence key and cannot be edited`);
    }
    const patch: RiskPatch = {};
    for (const field of RISK_PATCHABLE) {
      // a cleared agent/vendor is sent as null, which is how PATCH unlinks it
      if (!same(written.inputs[field], current[field])) (patch as Record<string, unknown>)[field] = current[field] ?? null;
    }
    return { key, step: { action: "update", patch } as StepAction<RiskPatch>, controlsToLink };
  });

  // a risk entry exists only once its use case does, so a refusal always names a use case
  if (reasons.length > 0 && checkpoint.useCase) return { kind: "refuse", useCaseId: checkpoint.useCase.id, reasons };
  return { kind: "proceed", useCase, questionnaire, risks };
}
