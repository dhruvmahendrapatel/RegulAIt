/**
 * ADR-0080 — THE AI USE-CASE REGISTRY, the L1 pre-build front-door
 * (internal/product/GAP_ANALYSIS_CREDO_AI_2026-08.md).
 *
 * Credo-style governance starts BEFORE anything runs: propose an AI use case,
 * fill an intake questionnaire, and an approval REGISTERS the use case. This
 * module ships that front door with the one differentiation available to an
 * enforcement-first product: an approved use case is not paperwork — it is a
 * governance OBJECT whose `complianceTags` are the SAME tags the §8.3 cascade
 * already enforces, so its detail view derives (never duplicates) the exact
 * consequences those tags force through `complianceProfilesForTags` +
 * `effectiveCompliancePolicy` — the functions the enforcement plane reads.
 *
 * FOUR PROPERTIES THIS FILE EXISTS TO GUARANTEE
 *
 *  1. INTAKE RUNS ON PILLAR-2 RAILS, NOT BESIDE THEM. `POST /v1/use-cases`
 *     starts a REAL workflow instance of the `ai-use-case-intake` template
 *     (gallery shape, ADR-0077) through `startWorkflowInstanceWithTemplates`
 *     — the exact code `POST /v1/workflows/instances` runs. The plan stage
 *     rests (ADR-0079), the questionnaire is a versioned workflow artifact,
 *     and the sign-off rides the ONE approvals queue with every
 *     separation-of-duties guard the decide endpoint applies.
 *
 *  2. STATUS IS DECIDED, NEVER PATCHED. `approved`/`rejected` are written
 *     ONLY by `syncUseCaseForInstance`, called from the decide path (app.ts,
 *     inside the decision's transaction) and from the workflow driving routes
 *     (via `WorkflowRouteOptions.onInstanceTransition`). A PATCH naming
 *     `status` is refused with a 422 that points at the decide path.
 *
 *  3. THE QUESTIONNAIRE IS A FORM, HONESTLY. No AI pre-fill: this deployment
 *     holds no model credential, and a fake "GAIA" would be
 *     mechanism-without-instrument. The blank form IS the deliverable; the
 *     proposer fills it and submits it as the instance's artifact.
 *
 *  4. THE CASCADE CARD IS DERIVED, NEVER DUPLICATED. Exactly the
 *     template-gallery discipline (ADR-0077): the detail view resolves the
 *     use case's tags through the SAME funnel `requiredTemplateIdsFor`
 *     enforces. There is no stored copy of any consequence anywhere here.
 *
 *  5. THE EU AI ACT TIER IS COMPUTED, NEVER ACCEPTED (ADR-0085, gap L10).
 *     The questionnaire's structured answers block is the ONLY input; the
 *     shared frozen rule set (`EU_AI_ACT_RULESET_V1`, hash-pinned) computes
 *     prohibited/high/limited/minimal server-side on every submission, the
 *     result is stored with its firing reasons and rule-set version, and it
 *     INFORMS the sign-off — a tier auto-blocks nothing, and every read of
 *     it carries the screening-not-legal-advice disclaimer as a field.
 *
 * WHAT THIS FILE DOES NOT DO — stated because a governance product that
 * overstates itself is worse than one that ships less: approval REGISTERS
 * intent, and — since the batch-B3 amendment closed ADR-0080's named
 * follow-up — GATES dispatch only where an admin arms the org opt-in
 * (`org_settings.use_case_gate_mode`, default off = byte-identical; see
 * use-case-gate.ts for the gate and its honest projectId-join limit).
 * And nothing auto-discovers use cases: every row here was proposed by a
 * person.
 */
import { recordRiskAcceptance } from "./risk-tolerance.js";
import { writeUseCaseDecisionRecord } from "./decision-regression.js";
import { assertAiBomSignoffPossible, prepareAiBomSignoff, runAiBomSignoffs, type AiBomSignoff } from "./ai-bom-signoff.js";
import { AiBomError } from "./ai-bom.js";
import { checkStepUp, isStepUpPrompt } from "./step-up.js";
import { syncVendorForInstance } from "./vendors.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  filterParams,
  parseListExport,
  parseListPage,
  runListPage,
  sendListError,
  sendListExport,
  wantsListContract,
  type ListReader,
  type ListSpec,
} from "./list-contract.js";
import { userNameSql } from "./delegations-list.js";
import { likeLiteral } from "./users-list.js";
import {
  getTableColumns,
  type SQL,
  agents,
  aiRisks,
  aiUseCases,
  and,
  approvals,
  auditLog,
  compliancePackControls,
  compliancePacks,
  desc,
  eq,
  inArray,
  lt,
  or,
  projectMembers,
  projects,
  shadowAiFindings,
  sql,
  users,
  useCaseConditions,
  useCaseIdempotencyKeys,
  workflowArtifacts,
  workflowEvents,
  workflowInstances,
  workflowTemplates,
  type AiUseCaseRow,
  type Db,
  type UseCaseConditionRow,
} from "@regulait/db";
import type { InstanceState, WorkflowDefinition } from "@regulait/workflow-kernel";
import {
  classifyEuAiActTier,
  createUseCaseSchema,
  deriveDataSensitivityFromCategories,
  extractEuAiActAnswers,
  retireUseCaseSchema,
  updateUseCaseSchema,
  EU_AI_ACT_ANSWERS_FENCE,
  EU_AI_ACT_RULESET_VERSION,
  EU_AI_ACT_SCREENING_DISCLAIMER,
  buildIntakeNarrativePrompt,
  intakeAssistRequestSchema,
  parseIntakeNarrative,
  suggestIntake,
  type EuAiActReason,
  COMPLIANCE_PACK_DISCLAIMER,
  REPORT_PERIODS,
  resolveReportPeriod,
  evaluateReportAccess,
  markConditionMetSchema,
  type UseCaseConditionView,
  describeMetricCondition,
  type AssuranceMetricId,
  type ConditionCadence,
  type ConditionOnBreach,
  type ConditionOperator,
  type MeasuredConditionFields,
  type MeasuredConditionKind,
  EU_AI_ACT_BOOLEAN_KEYS,
  INTAKE_BOOLEAN_QUESTION_KEYS,
  UNSURE_ANSWER_MUST_COUNT_AS_YES,
  unsureAnswerViolations,
  unsureViolationDetail,
} from "@regulait/shared";
import { z } from "zod";
import { complianceProfilesForTags, effectiveCompliancePolicy } from "./projects.js";
import { activeDelegatorsFor } from "./delegations.js";
// X15-H01: changing intended agents can widen an incident's evidence hold
import { lockEvidenceHoldsExclusive } from "./agent-evidence-hold.js";
// ADR-0058's evaluator, reused rather than reimplemented: a second copy of the
// collector logic would drift from the one that produces real pack reports.
import { evaluatePack } from "./compliance-packs.js";
import { executeGovernedDispatch } from "./agents-connectors.js";
import { agentDecision, featureDefaultModel } from "./copilot.js";
import { callerProjectIds, callerTeamIds, resolveScopeProjectIds } from "./reporting.js";
// ADR-0089 (gap L21): the ONE granted computation and its never-blend note —
// imported from the inventory, never reimplemented.
import { buildAgentHolderIndex, INVENTORY_NOTES } from "./inventory.js";
import { IDEMPOTENCY_WINDOW_MS, readIdempotencyKey, referencedId, replayReference } from "./request-idempotency.js";
import {
  createWorkflowTemplateValidated,
  standingExecutorRefusal,
  startWorkflowInstanceWithTemplates,
} from "./workflows.js";
import {
  AI_USE_CASE_INTAKE_TEMPLATE_NAME,
  aiUseCaseIntakeDefinition,
} from "./template-gallery.js";
import {
  ensureReviewRound,
  isRiskAcceptor,
  loadReviewPolicy,
  policyValidityMonths,
  recertificationDueAt,
  reviewRoleIdsFor,
  reviewsForInstance,
} from "./review-policy.js";
// ADR-0180 A2: a measured condition is closed only by passing evidence
import { specOf, storedMeasurement } from "./condition-metrics.js";
import { SHADOW_AI_RULE_IDS } from "./shadow-ai.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
const useCaseIdParam = z.object({ useCaseId: z.string().uuid() });

/** issue #522 finding #30: the use case a shadow-AI finding is registered as, if any */
async function discoveryFindingHolder(db: Db, findingId: string): Promise<{ id: string; name: string } | null> {
  const [row] = await db
    .select({ id: aiUseCases.id, name: aiUseCases.name })
    .from(aiUseCases)
    .where(eq(aiUseCases.discoveryFindingId, findingId));
  return row ?? null;
}

function findingAlreadyRegistered(holder: { id: string; name: string }) {
  return {
    error: "finding_already_registered",
    detail: `this shadow-AI finding is already registered as the AI use case '${holder.name}'; a finding is registered once`,
    useCaseId: holder.id,
  };
}

/** what a use-case read shows of the finding it was registered from (null when registered any other way) */
async function discoveryViewFor(
  db: Db,
  row: AiUseCaseRow,
  isAdmin: boolean,
): Promise<{ findingId: string; finding: { id: string; subject: string; subjectKind: string; provider: string; firstSeenAt: Date } | null } | null> {
  if (!row.discoveryFindingId) return null;
  if (!isAdmin) return { findingId: row.discoveryFindingId, finding: null };
  const [finding] = await db
    .select({
      id: shadowAiFindings.id,
      subject: shadowAiFindings.subject,
      subjectKind: shadowAiFindings.subjectKind,
      provider: shadowAiFindings.provider,
      firstSeenAt: shadowAiFindings.firstSeenAt,
    })
    .from(shadowAiFindings)
    .where(eq(shadowAiFindings.id, row.discoveryFindingId));
  return { findingId: row.discoveryFindingId, finding: finding ?? null };
}

function isDiscoveryFindingConflict(err: unknown): boolean {
  const pg = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } } | null;
  const e = pg?.code === "23505" ? pg : pg?.cause?.code === "23505" ? pg.cause : null;
  return e?.constraint === "ai_use_cases_discovery_finding_uq";
}

/** the artifact_generation output name the intake template declares */
export const USE_CASE_QUESTIONNAIRE_OUTPUT = "use_case_questionnaire";

/**
 * The intake questionnaire — a FORM the proposer fills and submits as the
 * instance's artifact. Deliberately not pre-filled by any model (ADR-0080).
 */
export const USE_CASE_QUESTIONNAIRE_TEMPLATE = `# AI use-case intake questionnaire

> Fill every section, then submit this document as the intake instance's
> \`${USE_CASE_QUESTIONNAIRE_OUTPUT}\` artifact. It becomes the versioned record the
> sign-off decision is made on. Nothing below is pre-filled by a model — the
> answers are yours, and they are what the approver approves.

## 1. Purpose and business context
What decision, task, or product capability will AI perform here, and why?

## 2. Users and affected parties
Who uses it, and who is affected by its outputs (customers, employees, third
parties)? Are any of them in a regulated or vulnerable category?

## 3. Data
What data does it read and produce? Name the categories (PII, PHI, payment,
proprietary), the sources, and where outputs are stored.

## 4. Models and agents
Which registered agents/models will serve this use case? If not yet
registered, name the intended provider and model family.

## 5. Compliance obligations
Which compliance tags apply, and why? These are the SAME tags the platform's
cascade enforces — an approved tag set is what the governed project inherits.

## 6. Risks and mitigations
What can go wrong (wrong output, leakage, misuse, drift), and what mitigates
each — human review, guardrails, evals, scope limits?

## 7. Rollout and human oversight
Pilot scope, success criteria, who monitors it, and where a human stays in
the loop.

## 8. Decommission criteria
Under what conditions is this use case retired or re-reviewed?

## 9. EU AI Act risk screening (structured, ADR-0085)
The platform computes an EU AI Act risk tier (prohibited / high / limited /
minimal) SERVER-SIDE from structured answers — a submitted tier is refused;
only the answers count, and the result is a SCREENING aid derived from the
public Act text, not legal advice. To be screened, include exactly one fenced
block tagged \`${EU_AI_ACT_ANSWERS_FENCE}\` containing JSON answers (the web
form builds it for you): purposeDomain, affectedPersons, decisionAutonomy,
biometricUse, and the boolean flags emotionRecognition, socialScoring,
manipulativeTechniques, profilesNaturalPersons, safetyComponent,
interactsWithHumans, generatesSyntheticContent. No block means "not
screened" — the platform never guesses a tier from prose.
`;

// ---------------------------------------------------------------------------
// ADR-0085 — the EU AI Act screening: computed server-side, from the answers,
// on every questionnaire submission. A calculator, not a lawyer.
// ---------------------------------------------------------------------------

/**
 * Recompute the screening from the LATEST questionnaire artifact and store it
 * on the use case — tier, the firing Annex/Article-shaped reasons, and the
 * frozen rule-set version that produced them. Called from the same sync the
 * driving routes and the decide path already run, so re-submitting the
 * questionnaire (versioned re-approval) recomputes automatically and the
 * decide path itself is untouched.
 *
 * The ONLY input is the answers block inside the artifact: no valid block →
 * all three columns null ("not screened" — never a guessed tier) unless the
 * use case was already screened, which keeps its tier (ADR-0170 §5), and a
 * block smuggling a `tier` key is refused by the shared parser. Idempotent;
 * writes (and audits) only when the stored screening actually changes.
 */
async function recomputeEuTierForUseCase(
  db: Db,
  useCase: AiUseCaseRow,
  actorUserId: string | null,
): Promise<void> {
  if (!useCase.workflowInstanceId) return;
  const [artifact] = await db
    .select()
    .from(workflowArtifacts)
    .where(
      and(
        eq(workflowArtifacts.instanceId, useCase.workflowInstanceId),
        eq(workflowArtifacts.output, USE_CASE_QUESTIONNAIRE_OUTPUT),
      ),
    )
    .orderBy(desc(workflowArtifacts.version))
    .limit(1);
  if (!artifact) return; // nothing submitted yet — nothing to screen

  const extracted = extractEuAiActAnswers(artifact.content);
  // ADR-0170 §5 — SCREENING NEVER SILENTLY DOWNGRADES. A later questionnaire
  // version without an extractable answers block (missing or invalid) says
  // nothing new about the tier, so a use case that was already screened keeps
  // its last computed tier, reasons and rule set (no write, no new audit) —
  // otherwise dropping the block would turn "high" into "unscreened" and route
  // the review to whatever the unscreened tier requires.
  if (extracted.status !== "ok" && useCase.euAiActTier !== null) return;

  // ADR-0171 / AER-053: a block that carries an `unsure` list restates the
  // EU answers' "Not sure" set; the context answers' entries (stored from the
  // Classify step) are kept. A block without the key says nothing about it.
  if (extracted.status === "ok" && extracted.unsure !== undefined) {
    const euKeys: readonly string[] = EU_AI_ACT_BOOLEAN_KEYS;
    const stored = useCase.screeningUnsure ?? [];
    const next = [...stored.filter((k) => !euKeys.includes(k)), ...extracted.unsure];
    if (JSON.stringify([...next].sort()) !== JSON.stringify([...stored].sort())) {
      await db
        .update(aiUseCases)
        .set({ screeningUnsure: next, updatedAt: new Date() })
        .where(eq(aiUseCases.id, useCase.id));
    }
  }
  let tier: AiUseCaseRow["euAiActTier"] = null;
  let reasons: EuAiActReason[] | null = null;
  let rulesetVersion: number | null = null;
  if (extracted.status === "ok") {
    const c = classifyEuAiActTier(extracted.answers);
    tier = c.tier;
    reasons = c.reasons;
    rulesetVersion = c.rulesetVersion;
  }

  const unchanged =
    tier === useCase.euAiActTier &&
    rulesetVersion === useCase.euAiActRulesetVersion &&
    JSON.stringify(reasons) === JSON.stringify(useCase.euAiActReasons);
  if (unchanged) return;

  await db
    .update(aiUseCases)
    .set({ euAiActTier: tier, euAiActReasons: reasons, euAiActRulesetVersion: rulesetVersion, updatedAt: new Date() })
    .where(eq(aiUseCases.id, useCase.id));
  await db.insert(auditLog).values({
    userId: actorUserId ?? useCase.ownerUserId,
    objectType: "ai_use_case",
    objectId: useCase.id,
    detail: {
      phase: "eu-ai-act-screening",
      tier,
      rulesetVersion,
      firedRuleIds: reasons?.map((r) => r.ruleId) ?? null,
      artifactVersion: artifact.version,
      answersStatus: extracted.status,
      ...(extracted.status === "invalid" ? { answersError: extracted.error } : {}),
    },
    // "allow" even for prohibited: the screening BLOCKS NOTHING — it informs
    // the sign-off decision, which is where a deny would honestly appear
    effect: "allow",
    ruleId: "use-case-eu-tier",
    ruleChain: [],
    reason: tier
      ? `EU AI Act screening for '${useCase.name}': ${tier} (rule set v${rulesetVersion}, from questionnaire v${artifact.version}) — a screening result that informs the sign-off, not legal advice and not a block`
      : `EU AI Act screening for '${useCase.name}' cleared — questionnaire v${artifact.version} carries no valid answers block (${extracted.status})`,
  });
}

// ---------------------------------------------------------------------------
// The lifecycle join: instance status -> use-case status
// ---------------------------------------------------------------------------

function statusForInstance(instanceStatus: string): AiUseCaseRow["status"] | null {
  switch (instanceStatus) {
    case "completed":
      return "approved";
    case "denied":
    case "aborted":
      return "rejected";
    case "blocked_on_approval":
      return "under_review";
    // NOTE (ADR-0168): blocked_on_artifact also follows a RETURNED sign-off;
    // `syncUseCaseForInstance` keeps a use case at `needs_info` there rather
    // than rewinding it to `proposed`.
    case "running":
    case "blocked_on_plan":
    case "blocked_on_artifact":
      return "proposed";
    default:
      // a status this mapping does not know (blocked_on_check, awaiting_execution,
      // …) can only come from a customized intake template — leave the use case
      // where it is rather than guess
      return null;
  }
}

/**
 * ADR-0189 R25 item 6, for the workflow routes (artifact submit, advance):
 * called INSIDE the transition's transaction, after the transition is applied
 * and before anything commits. When the instance now stands at a status that
 * would move its governed use case to `approved`, and that approval could not
 * take its signed AI BOM snapshot under the strict `refuse` setting, this
 * throws the same 409 `bom_signing_unavailable` the decide path answers — so
 * the transition, its artifact row and its git effects never happen, and the
 * use case is not left behind its instance.
 *
 * R25 item 13 prevention: `prospectiveStatus` judges a status the instance is
 * ABOUT to take instead of the one it stands at — the executor's lookahead,
 * before an external effect whose success would complete the instance.
 */
export async function assertUseCaseSignoffPossibleForInstance(tx: Db, instanceId: string, prospectiveStatus?: string): Promise<void> {
  const [instance] = await tx
    .select({ status: workflowInstances.status })
    .from(workflowInstances)
    .where(eq(workflowInstances.id, instanceId));
  if (!instance || statusForInstance(prospectiveStatus ?? instance.status) !== "approved") return;
  const [useCase] = await tx
    .select({ status: aiUseCases.status })
    .from(aiUseCases)
    .where(eq(aiUseCases.workflowInstanceId, instanceId));
  if (!useCase || useCase.status === "approved" || useCase.status === "rejected" || useCase.status === "retired") return;
  await assertAiBomSignoffPossible(tx);
}

/**
 * ADR-0080/0084 + ADR-0189 R25: THE dependent-object mirror after an instance
 * moved outside the decide transaction — the workflow driving routes (through
 * `WorkflowRouteOptions.onInstanceTransition`) and the executor runs no route
 * mirrors (an approval's post-commit step, a nested run's completion, an engine
 * run's re-evaluation). Runs after the move committed.
 *
 * A use-case approval that cannot take its signed snapshot is refused inside
 * its own sync transaction. The executors refuse such a completion before any
 * external effect (R25 item 13 prevention), so this refusal is what is left of
 * the race where the key became unusable mid-stage. The instance has already
 * moved, so the refusal is reported, not thrown: the vendor mirror still runs
 * and the caller learns the use case stayed behind its instance
 * (`useCaseSignoffWarning`; POST /v1/use-cases/:useCaseId/resync recovers it).
 */
export async function mirrorInstanceTransition(
  db: Db,
  instanceId: string,
  actorUserId: string | null,
  log: { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void },
): Promise<Record<string, unknown> | undefined> {
  let useCaseSignoff: AiBomSignoff | null = null;
  let useCaseSignoffRefused: { code: string; detail: string } | null = null;
  try {
    useCaseSignoff = await syncUseCaseForInstance(db, instanceId, actorUserId);
  } catch (err) {
    if (!(err instanceof AiBomError)) throw err;
    log.warn({ instanceId, code: err.code }, "use-case approval refused: its AI BOM snapshot cannot be signed");
    useCaseSignoffRefused = {
      code: err.code,
      detail:
        `${err.message} The workflow instance has moved, but its AI use case was not approved; it stays where it was ` +
        "until a receipt signing key is configured and an admin re-syncs it (POST /v1/use-cases/:useCaseId/resync).",
    };
  }
  await syncVendorForInstance(db, instanceId, actorUserId);
  // ADR-0189 R25: the move committed before this runs, so the snapshot runs here
  const aiBomSnapshotWarning = await runAiBomSignoffs(db, [useCaseSignoff], log);
  const extra = {
    ...(aiBomSnapshotWarning ? { aiBomSnapshotWarning } : {}),
    ...(useCaseSignoffRefused ? { useCaseSignoffWarning: useCaseSignoffRefused } : {}),
  };
  return Object.keys(extra).length ? extra : undefined;
}

/**
 * Mirror the linked intake instance's status onto its use case. Called from
 * the ONE decide path (app.ts, inside the decision's transaction — this is
 * what makes "approval registers the use case" transactional with the
 * decision itself) and from the workflow driving routes via
 * `onInstanceTransition`. Decided and retired statuses are terminal here:
 * once a use case is approved, rejected, or retired, no instance movement
 * rewrites history — re-proposing is a new use case.
 *
 * ADR-0189 R25: a move to `approved` returns the AI BOM sign-off it owes. The
 * caller runs it (`runAiBomSignoffs`) once its OUTERMOST transaction has
 * committed; the triggering audit row already records the debt.
 */
export async function syncUseCaseForInstance(
  db: Db,
  instanceId: string | null,
  actorUserId: string | null,
  /** ADR-0189 R25 item 13 follow-up, the admin re-sync ONLY: the decision as the
   * workflow made it, so a late mirror records the original approver and starts
   * the approval's lifetime when it was decided, not when it was re-synced.
   * Omitted on every other path, which keeps its behaviour. */
  original?: { decidedBy: string | null; decidedAt: Date; approvalId: string | null },
): Promise<AiBomSignoff | null> {
  if (!instanceId) return null;
  // ADR-0109 (migration 0108): `ai_use_cases_instance_uq` UNIQUE
  // (workflow_instance_id) WHERE workflow_instance_id IS NOT NULL. One pillar-2
  // instance governs ONE use case, so this is single-row by constraint —
  // ordering it would have implied a second object on one sign-off is expected.
  const [useCase] = await db
    .select()
    .from(aiUseCases)
    .where(eq(aiUseCases.workflowInstanceId, instanceId));
  if (!useCase) return null;
  if (useCase.status === "approved" || useCase.status === "rejected" || useCase.status === "retired") {
    return null;
  }
  // ADR-0085: the screening rides the same sync — BEFORE the no-status-change
  // early return below, because a questionnaire re-submission (versioned
  // re-approval) changes the answers without changing the mapped status.
  await recomputeEuTierForUseCase(db, useCase, actorUserId);
  // ADR-0168 amendment: a sign-off the instance just requested is routed by
  // the review policy for the tier AS IT NOW STANDS (re-read: the screening
  // above may have just recomputed it) — one required review per role.
  // No policy, or no roles for the tier: nothing changes.
  const policy = await loadReviewPolicy(db);
  if (policy) {
    const [screened] = await db
      .select({ euAiActTier: aiUseCases.euAiActTier })
      .from(aiUseCases)
      .where(eq(aiUseCases.id, useCase.id));
    await ensureReviewRound(db, { ...useCase, euAiActTier: screened?.euAiActTier ?? null }, actorUserId, policy);
  }
  const [instance] = await db
    .select({ status: workflowInstances.status })
    .from(workflowInstances)
    .where(eq(workflowInstances.id, instanceId));
  if (!instance) return null;
  const next = statusForInstance(instance.status);
  if (next === null || next === useCase.status) return null;
  // ADR-0168: sent back for information — the instance rests at its
  // questionnaire stage (blocked_on_artifact) and the use case STAYS
  // needs_info until a new version re-requests the sign-off (→ under_review).
  if (useCase.status === "needs_info" && next === "proposed") return null;

  const decided = next === "approved" || next === "rejected";
  // ADR-0168 — an approval has a lifetime, from the tier as it stands at the
  // decision (re-read: the screening above may just have recomputed it).
  let lifetime: { approvedAt: Date; approvedUntil: Date; months: number; tier: string | null } | null = null;
  if (next === "approved") {
    const [fresh] = await db
      .select({ tier: aiUseCases.euAiActTier })
      .from(aiUseCases)
      .where(eq(aiUseCases.id, useCase.id));
    const approvedAt = original ? new Date(original.decidedAt.getTime()) : new Date();
    // ADR-0168 amendment: the review policy may set the tier's lifetime
    const months = policyValidityMonths(policy, fresh?.tier ?? null) ?? approvalLifetimeMonths(fresh?.tier ?? null);
    lifetime = { approvedAt, approvedUntil: addMonthsUtc(approvedAt, months), months, tier: fresh?.tier ?? null };
  }
  // ADR-0182 A11: the status move, its audit row and — for a terminal
  // decision — its decision record commit together (a savepoint inside the
  // decide path's transaction; a transaction of its own from the workflow
  // routes). The record is not best-effort: no record, no decision.
  const decidedAt = original && decided ? new Date(original.decidedAt.getTime()) : new Date();
  // ADR-0189 R25: an approval owes a signed AI BOM snapshot of the use case,
  // taken by the caller AFTER the outermost commit (a rejection takes none)
  let signoff: AiBomSignoff | null = null;
  await db.transaction(async (tx) => {
    // compare-and-swap on the status this sync read: two syncs racing for the
    // same move (an artifact submission and its idempotent replay, ADR-0179)
    // move the use case, and audit the move, once
    const moved = await tx
      .update(aiUseCases)
      .set({
        status: next,
        updatedAt: new Date(),
        // a decision closes a recertification review (ADR-0168 amendment)
        ...(decided ? { decidedAt, recertification: false } : {}),
        ...(lifetime ? { approvedAt: lifetime.approvedAt, approvedUntil: lifetime.approvedUntil } : {}),
      })
      .where(and(eq(aiUseCases.id, useCase.id), eq(aiUseCases.status, useCase.status)))
      .returning({ id: aiUseCases.id });
    if (moved.length === 0) return;
    // R25 item 6: with no signing key under the strict default this throws 409
    // `bom_signing_unavailable`, and the move (and the decision around it) rolls back
    const prepared =
      next === "approved"
        ? await prepareAiBomSignoff(tx as unknown as Db, {
            trigger: "use_case_approval",
            triggeringObjectId: useCase.id,
            actorUserId,
            subjects: [{ kind: "use_case", id: useCase.id }],
          })
        : null;
    signoff = prepared?.signoff ?? null;
    await tx.insert(auditLog).values({
      userId: actorUserId ?? useCase.ownerUserId,
      objectType: "ai_use_case",
      objectId: useCase.id,
      detail: {
        ...(prepared?.auditDetail ?? {}),
        phase: "lifecycle",
        from: useCase.status,
        to: next,
        workflowInstanceId: instanceId,
        instanceStatus: instance.status,
        ...(useCase.recertification ? { recertification: true } : {}),
        ...(lifetime
          ? {
              approvedAt: lifetime.approvedAt.toISOString(),
              approvedUntil: lifetime.approvedUntil.toISOString(),
              lifetimeMonths: lifetime.months,
              lifetimeTier: lifetime.tier,
            }
          : {}),
      },
      effect: next === "rejected" ? "deny" : "allow",
      ruleId: `use-case-${next}`,
      ruleChain: [],
      reason: decided
        ? `AI use case '${useCase.name}' ${next.replace(/_/g, " ")} by the intake workflow's final decision`
        : `AI use case '${useCase.name}' moved to ${next.replace(/_/g, " ")} — intake workflow is ` +
          (instance.status === "blocked_on_approval" ? "awaiting sign-off" : instance.status.replace(/_/g, " ")),
    });
    if (decided) {
      await writeUseCaseDecisionRecord(tx, {
        useCase,
        outcome: next as "approved" | "rejected",
        decidedAt,
        decidedBy: original ? original.decidedBy : actorUserId,
        // an aborted intake was decided by no approval
        ...(instance.status === "aborted" ? { approvalId: null } : original ? { approvalId: original.approvalId } : {}),
      });
    }
  });
  return signoff;
}

// ---------------------------------------------------------------------------
// ADR-0189 R25 item 13 follow-up — a use case left behind its completed instance
// ---------------------------------------------------------------------------

/** the use-case statuses a completed instance still moves to `approved` (decided
 * and retired statuses are terminal, so a re-sync never touches them) */
export const USE_CASE_STATUSES_BEHIND_COMPLETION = ["proposed", "under_review", "needs_info"] as const;

/** how many examples the posture report names */
export const USE_CASES_BEHIND_SAMPLE = 5;

/**
 * Use cases whose governing workflow instance is `completed` (the approving
 * terminal state) while the use case itself was never approved. An executor or
 * git stage can complete an instance after the route that drove it committed;
 * when no receipt signing key was usable then, the sync refused the approval
 * (R25 item 6), and a completed instance can never be advanced again. Read-only;
 * it blocks nothing. The posture report shows it; an admin recovers each one
 * with POST /v1/use-cases/:useCaseId/resync once a key is usable.
 */
export async function useCasesBehindCompletedInstance(
  db: Pick<Db, "select">,
  sampleSize = USE_CASES_BEHIND_SAMPLE,
): Promise<{ count: number; sampleUseCaseIds: string[] }> {
  const behind = and(
    eq(workflowInstances.status, "completed"),
    inArray(aiUseCases.status, [...USE_CASE_STATUSES_BEHIND_COMPLETION]),
  );
  const [total] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(aiUseCases)
    .innerJoin(workflowInstances, eq(workflowInstances.id, aiUseCases.workflowInstanceId))
    .where(behind);
  const sample = await db
    .select({ id: aiUseCases.id })
    .from(aiUseCases)
    .innerJoin(workflowInstances, eq(workflowInstances.id, aiUseCases.workflowInstanceId))
    .where(behind)
    // the longest-stranded first
    .orderBy(aiUseCases.updatedAt, aiUseCases.id)
    .limit(sampleSize);
  return { count: total?.n ?? 0, sampleUseCaseIds: sample.map((r) => r.id) };
}

export type ResyncVerdict = { kind: "in_step" } | { kind: "refuse"; body: Record<string, unknown> } | { kind: "go" };

/** what the re-sync route does with a use case and its instance, as they stand */
export function resyncVerdict(useCaseStatus: string, instanceStatus: string): ResyncVerdict {
  const target = statusForInstance(instanceStatus);
  const terminal = useCaseStatus === "approved" || useCaseStatus === "rejected" || useCaseStatus === "retired";
  if (terminal || target === null || target === useCaseStatus || (useCaseStatus === "needs_info" && target === "proposed")) {
    return { kind: "in_step" };
  }
  if (instanceStatus === "completed") return { kind: "go" };
  const said = instanceStatus.replace(/_/g, " ");
  if (instanceStatus === "denied" || instanceStatus === "aborted") {
    return {
      kind: "refuse",
      body: {
        error: "instance_not_completed",
        detail:
          `the intake workflow ended ${said}. That is final: the instance can't be driven again, and a re-sync only ` +
          "applies an approval, which a completed instance carries and this one does not. If the change is still wanted, " +
          "propose it as a new use case.",
        instanceStatus,
      },
    };
  }
  return {
    kind: "refuse",
    body: {
      error: "instance_not_completed",
      detail:
        `the intake workflow is ${said}, not completed. A re-sync only recovers a use case left behind an instance ` +
        "that completed; drive this instance through its workflow instead.",
      instanceStatus,
    },
  };
}

/*
 * ORDERING BY THE AUDIT CHAIN, NOT BY CLOCKS. `audit_log.at` is the writer's process clock
 * when the row is built (packages/db audit-chain.ts), not commit time, so a long completing transaction can carry
 * an `at` older than an edit that committed while it ran. `seq` is allocated
 * under the chain's transaction-scoped advisory lock (packages/db
 * audit-chain.ts), held until commit: a row with a higher `seq` was appended
 * after every lower-`seq` transaction had committed. So `seq` is commit order
 * among audit writers, and it needs no migration. The use case's edit row is
 * written in the edit's own transaction (PATCH), and the completion row in the
 * transition's, so comparing their `seq` says which committed first. A row with
 * no `seq` (legacy, pre-chain) falls back to `at`.
 */

/** the audit row `applyEvent` writes for the transition into `completed`: its
 * chain position, its time (the writer's clock when it was written) and who drove that step */
export async function instanceCompletion(
  db: Pick<Db, "select" | "execute">,
  instanceId: string,
): Promise<{ seq: number | null; at: Date; actorUserId: string | null } | null> {
  const [hit] = await db
    .select({ seq: auditLog.seq, at: auditLog.at, detail: auditLog.detail })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.objectType, "workflow"),
        eq(auditLog.objectId, instanceId),
        sql`jsonb_typeof(${auditLog.detail}->'event') = 'object'`,
        sql`${auditLog.reason} like ${"%(status → completed)"}`,
      ),
    )
    .orderBy(sql`${auditLog.seq} desc nulls last`, desc(auditLog.at))
    .limit(1);
  if (!hit) return null;
  // WHO DROVE THE COMPLETING STEP comes from the kernel's own event row, never from
  // the audit row: `applyEvent` audits an actor-less (system) event under the
  // instance's INITIATOR, which would credit the requester with the decision. The
  // event row carries the real actor: the person whose request committed the
  // transition (for an executor stage, the person whose report, retry or override
  // ran it, as `runGitExecutions` passes them), or null for a system step.
  // WHICH event row: a completed instance accepts no event but a re-open, so while
  // it stands completed its NEWEST event row is the completing one. (The audit
  // row's `at` is the writer's process clock, not `now()`, so the two rows can't be
  // joined on time.) Its kind must be the completion row's; anything else reads as
  // no actor, which refuses (fail closed).
  const rows = (await db.execute(sql`
    select we.actor_user_id as "actorUserId", (we.event->>'kind') as "kind"
      from ${workflowEvents} we
     where we.instance_id = ${instanceId}
     order by we.at desc, we.id desc
     limit 1`)) as unknown as { rows: Array<{ actorUserId: string | null; kind: string | null }> };
  const completingKind = (hit.detail as { event?: { kind?: unknown } } | null)?.event?.kind;
  const ev = rows.rows[0];
  const actorUserId = ev && ev.kind === completingKind ? ev.actorUserId : null;
  return { seq: hit.seq ?? null, at: hit.at, actorUserId };
}

/** "row is after the completion" in commit order (see the note above) */
function afterCompletion(completion: { seq: number | null; at: Date }) {
  return completion.seq !== null
    ? sql`(${auditLog.seq} > ${completion.seq} or (${auditLog.seq} is null and ${auditLog.at} >= ${completion.at.toISOString()}::timestamptz))`
    : sql`${auditLog.at} >= ${completion.at.toISOString()}::timestamptz`;
}

/** an edit (PATCH) of the use case that committed after the instance completed */
export async function editAfterCompletion(
  db: Pick<Db, "select">,
  useCaseId: string,
  completion: { seq: number | null; at: Date },
): Promise<{ at: Date; auditId: string } | null> {
  const [hit] = await db
    .select({ at: auditLog.at, id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.objectType, "ai_use_case"),
        eq(auditLog.objectId, useCaseId),
        eq(auditLog.ruleId, "use-case-updated"),
        afterCompletion(completion),
      ),
    )
    .orderBy(desc(auditLog.at))
    .limit(1);
  return hit ? { at: hit.at, auditId: hit.id } : null;
}

/**
 * The sign-off that let THIS round of the instance through, if it had one: the
 * last `approval_granted` transition recorded after the round began (the newest
 * re-open row, which carries `round`) and before the completion, in commit order;
 * then the approval row of that gate requested in this round. A sign-off from a
 * round that was re-opened afterwards is never picked.
 */
export async function roundGrant(
  db: Pick<Db, "select">,
  instanceId: string,
  completion: { seq: number | null; at: Date },
): Promise<
  | { kind: "none" }
  | { kind: "approval"; approvalId: string; decidedBy: string | null; decidedAt: Date }
  | { kind: "missing"; stageId: string }
> {
  const beforeCompletion =
    completion.seq !== null
      ? sql`${auditLog.seq} < ${completion.seq}`
      : sql`${auditLog.at} <= ${completion.at.toISOString()}::timestamptz`;
  const onInstance = and(eq(auditLog.objectType, "workflow"), eq(auditLog.objectId, instanceId), beforeCompletion);
  const [roundStart] = await db
    .select({ seq: auditLog.seq, at: auditLog.at })
    .from(auditLog)
    // only the TRANSITION row of a re-open: it carries `round` and the kernel event as
    // an object. The effects-archived rows (a re-open's archive, and a late
    // old-round executor's `executor-result-discarded` archive) also carry `round`,
    // with `event` as a string, and can be written AFTER the re-open: matching
    // them would move the round start past the real grant
    .where(
      and(
        onInstance,
        sql`${auditLog.detail} ? 'round'`,
        sql`jsonb_typeof(${auditLog.detail}->'event') = 'object'`,
        sql`${auditLog.ruleId} <> 'workflow:effects-archived'`,
      ),
    )
    .orderBy(sql`${auditLog.seq} desc nulls last`, desc(auditLog.at))
    .limit(1);
  const inRound = roundStart
    ? roundStart.seq !== null
      ? sql`${auditLog.seq} > ${roundStart.seq}`
      : sql`${auditLog.at} >= ${roundStart.at.toISOString()}::timestamptz`
    : sql`true`;
  // up to AND including the completion row: a grant on the last gate completes the
  // instance in the same transition, so its row is the completion row itself
  const upToCompletion =
    completion.seq !== null
      ? sql`${auditLog.seq} <= ${completion.seq}`
      : sql`${auditLog.at} <= ${completion.at.toISOString()}::timestamptz`;
  const [granted] = await db
    .select({ detail: auditLog.detail })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.objectType, "workflow"),
        eq(auditLog.objectId, instanceId),
        upToCompletion,
        inRound,
        eq(auditLog.ruleId, "workflow:approval_granted"),
      ),
    )
    .orderBy(sql`${auditLog.seq} desc nulls last`, desc(auditLog.at))
    .limit(1);
  if (!granted) return { kind: "none" };
  const stageId = String(((granted.detail as { event?: { stageId?: unknown } } | null)?.event?.stageId) ?? "");
  // WHICH APPROVAL ROW, AND WHY A CLOCK HERE WHEN THE REST IS `seq`. An approval
  // row has no chain position of its own. The gate (its stage) and the fact that
  // it granted in THIS round before the completion are both established above, in
  // commit order. What is left is to pick that gate's row among the rows earlier
  // rounds left for the same stage: it is the newest REQUEST for the stage
  // (`requested_at`, the `now()` of the transaction that requested it). Requests
  // for one stage are a whole round apart (a re-open and a fresh walk to the gate
  // separate them), so ordering them by their own request time is safe. No
  // cross-transaction bound is drawn against the re-open's or the completion's
  // `at` (a transaction can start before another commits while it waits on the
  // instance lock), and never against the process clock (`decided_at`). Several
  // rows in the newest batch (one per review role) are one gate: the approved one
  // decided last stands for it.
  const sameStage = and(eq(approvals.instanceId, instanceId), eq(approvals.objectType, "workflow"), eq(approvals.stageId, stageId));
  const [approval] = await db
    .select({ id: approvals.id, decidedBy: approvals.decidedBy, decidedAt: approvals.decidedAt })
    .from(approvals)
    .where(
      and(
        sameStage,
        sql`${approvals.requestedAt} = (select max(a2.requested_at) from ${approvals} a2 where a2.instance_id = ${instanceId} and a2.object_type = 'workflow' and a2.stage_id = ${stageId})`,
        inArray(approvals.status, ["approved", "consumed"]),
        sql`${approvals.decidedAt} is not null`,
      ),
    )
    .orderBy(desc(approvals.decidedAt), desc(approvals.id))
    .limit(1);
  if (!approval?.decidedAt) return { kind: "missing", stageId };
  return { kind: "approval", approvalId: approval.id, decidedBy: approval.decidedBy, decidedAt: approval.decidedAt };
}

function editedAfterCompletionBody(edit: { at: Date; auditId: string }): Record<string, unknown> {
  return {
    error: "use_case_edited_after_completion",
    detail:
      "this use case was edited after its intake workflow completed, so approving it now would approve something no " +
      "reviewer saw. It is not re-synced: propose the edited use case as a new one and take it through intake.",
    editedAt: edit.at.toISOString(),
    editAuditId: edit.auditId,
  };
}

/**
 * The decision a re-sync applies, as the workflow made it, or why it can't be
 * established. Read before the step-up (so a refusal spends no grant) and again
 * under the re-sync's locks.
 */
export async function resyncDecision(
  db: Pick<Db, "select" | "execute">,
  instanceId: string,
  useCaseId: string,
): Promise<
  | { kind: "refuse"; body: Record<string, unknown> }
  | { kind: "ok"; original: { decidedBy: string; decidedAt: Date; approvalId: string | null } }
> {
  const completion = await instanceCompletion(db, instanceId);
  if (!completion) return { kind: "refuse", body: NO_COMPLETION_RECORD };
  const edit = await editAfterCompletion(db, useCaseId, completion);
  if (edit) return { kind: "refuse", body: editedAfterCompletionBody(edit) };
  const grant = await roundGrant(db, instanceId, completion);
  if (grant.kind === "missing") {
    return {
      kind: "refuse",
      body: {
        error: "approval_record_missing",
        detail:
          `the sign-off at stage '${grant.stageId}' that let this round of the intake through has no approval record, ` +
          "so who decided it can't be established. It is not re-synced: take the use case through intake again.",
      },
    };
  }
  const decidedBy = grant.kind === "approval" ? grant.decidedBy : completion.actorUserId;
  const decidedAt = grant.kind === "approval" ? grant.decidedAt : completion.at;
  // the decider must be a person on record (the decision record names them); a
  // system step or a removed account leaves nobody to attribute it to
  const [person] = decidedBy ? await db.select({ id: users.id }).from(users).where(eq(users.id, decidedBy)) : [];
  if (!person) {
    return {
      kind: "refuse",
      body: {
        error: "no_decider_record",
        detail:
          "neither an approval nor the step that completed the intake names a person who decided it, so the decision " +
          "can't be attributed. It is not re-synced: take the use case through intake again.",
      },
    };
  }
  return { kind: "ok", original: { decidedBy: person.id, decidedAt, approvalId: grant.kind === "approval" ? grant.approvalId : null } };
}

const NO_COMPLETION_RECORD = {
  error: "no_completion_record",
  detail:
    "there is no audit record of this use case's intake workflow completing (it may have been removed by retention), " +
    "so who decided it, and when, can't be established. It is not re-synced: take the use case through intake again.",
};

// ---------------------------------------------------------------------------
// ADR-0168 — approval lifetime, conditions, send-back
// ---------------------------------------------------------------------------

/** 6 months for a high tier — and for prohibited or unscreened, which are no
 * safer than high — and 12 for minimal and limited. */
export function approvalLifetimeMonths(tier: AiUseCaseRow["euAiActTier"] | string | null): number {
  return tier === "minimal" || tier === "limited" ? 12 : 6;
}

export function addMonthsUtc(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/** An approval is an INTAKE SIGN-OFF when it is a workflow gate on the
 * instance that governs a use case (ADR-0109: at most one). */
export async function useCaseForIntakeApproval(
  db: Db,
  approval: { objectType: string; instanceId: string | null },
): Promise<AiUseCaseRow | null> {
  if (approval.objectType !== "workflow" || !approval.instanceId) return null;
  const [uc] = await db
    .select()
    .from(aiUseCases)
    .where(eq(aiUseCases.workflowInstanceId, approval.instanceId));
  return uc ?? null;
}

/** Inside the decide transaction, after the kernel has parked the instance
 * back at its questionnaire stage: the use case becomes `needs_info`. */
export async function markUseCaseReturned(
  db: Db,
  useCaseId: string,
  approvalId: string,
  reason: string,
  actorUserId: string,
): Promise<void> {
  const [uc] = await db.select().from(aiUseCases).where(eq(aiUseCases.id, useCaseId));
  if (!uc || uc.status === "approved" || uc.status === "rejected" || uc.status === "retired") return;
  if (uc.status === "needs_info") return;
  await db
    .update(aiUseCases)
    .set({ status: "needs_info", updatedAt: new Date() })
    .where(eq(aiUseCases.id, uc.id));
  await db.insert(auditLog).values({
    userId: actorUserId,
    objectType: "ai_use_case",
    objectId: uc.id,
    detail: {
      phase: "lifecycle",
      from: uc.status,
      to: "needs_info",
      approvalId,
      workflowInstanceId: uc.workflowInstanceId,
    },
    effect: "deny",
    ruleId: "use-case-returned-for-info",
    ruleChain: [],
    reason: `AI use case '${uc.name}' sent back for information — a new questionnaire version re-requests sign-off: ${reason}`,
  });
  // ADR-0182 A11: a return is a terminal decision of its review round; its
  // record commits (or rolls back) with the decide path's transaction
  await writeUseCaseDecisionRecord(db, {
    useCase: uc,
    outcome: "needs_info",
    decidedAt: new Date(),
    decidedBy: actorUserId,
    approvalId,
  });
}

/** Inside the decide transaction: persist the conditions an approving
 * intake sign-off imposed, and audit them as one act. */
export async function imposeUseCaseConditions(
  db: Db,
  useCase: { id: string; name: string },
  approvalId: string,
  conditions: ReadonlyArray<{
    text: string;
    ownerUserId?: string | undefined;
    dueAt: Date;
    blocking: boolean;
    /** ADR-0180 A2: absent = a manual (ADR-0168) condition */
    measured?: {
      kind: MeasuredConditionKind;
      metric: AssuranceMetricId;
      params: Record<string, unknown>;
      operator: ConditionOperator;
      threshold: number;
      windowDays: number;
      minSamples: number;
      cadence: ConditionCadence;
      onBreach: ConditionOnBreach;
    };
  }>,
  actorUserId: string,
): Promise<void> {
  if (conditions.length === 0) return;
  const rows = await db
    .insert(useCaseConditions)
    .values(
      conditions.map((c) => ({
        useCaseId: useCase.id,
        approvalId,
        text: c.text,
        ownerUserId: c.ownerUserId ?? null,
        dueAt: c.dueAt,
        blocking: c.blocking,
        ...(c.measured
          ? {
              kind: c.measured.kind,
              metric: c.measured.metric,
              params: c.measured.params,
              operator: c.measured.operator,
              threshold: c.measured.threshold,
              windowDays: c.measured.windowDays,
              minSamples: c.measured.minSamples,
              cadence: c.measured.cadence,
              onBreach: c.measured.onBreach,
            }
          : {}),
      })),
    )
    .returning({ id: useCaseConditions.id, blocking: useCaseConditions.blocking, kind: useCaseConditions.kind });
  const blocking = rows.filter((r) => r.blocking).length;
  const measured = rows.filter((r) => r.kind !== "manual").length;
  await db.insert(auditLog).values({
    userId: actorUserId,
    objectType: "ai_use_case",
    objectId: useCase.id,
    detail: {
      phase: "conditions-imposed",
      approvalId,
      conditionIds: rows.map((r) => r.id),
      blocking,
      afterGoLive: rows.length - blocking,
      // ADR-0180 A2: how many are measured (closed only by passing evidence)
      ...(measured > 0
        ? {
            measured,
            specs: conditions.flatMap((c, i) =>
              c.measured ? [{ conditionId: rows[i]?.id, spec: describeMetricCondition(c.measured), onBreach: c.measured.onBreach }] : [],
            ),
          }
        : {}),
    },
    effect: "allow",
    ruleId: "use-case-conditions-imposed",
    ruleChain: [],
    reason:
      `AI use case '${useCase.name}' approved with ${rows.length} condition(s): ` +
      `${blocking} before go-live (blocking deployment while open), ${rows.length - blocking} after go-live`,
  });
}

/**
 * ADR-0168 amendment — RISK ACCEPTANCE ON A SIGN-OFF, refused BY NAME before
 * anything is written: only by a risk acceptor the review policy names (403
 * `not_a_risk_acceptor`), only for risks of THIS use case (422
 * `risk_not_on_use_case`), and only for a live risk (409 `risk_already_accepted`
 * / `risk_terminal`). The decide path calls this before its transaction.
 */
export async function precheckRiskAcceptance(
  db: Db,
  useCase: { id: string },
  deciderUserId: string,
  riskIds: string[],
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  if (!isRiskAcceptor(await loadReviewPolicy(db), deciderUserId)) {
    return {
      status: 403,
      body: {
        error: "not_a_risk_acceptor",
        detail: "only a risk acceptor named in the review policy may accept risk on a sign-off",
      },
    };
  }
  const ids = [...new Set(riskIds)];
  const rows = await db
    .select({ id: aiRisks.id, useCaseId: aiRisks.useCaseId, status: aiRisks.status })
    .from(aiRisks)
    .where(inArray(aiRisks.id, ids));
  const foreign = ids.filter((id) => rows.find((r) => r.id === id)?.useCaseId !== useCase.id);
  if (foreign.length > 0) {
    return {
      status: 422,
      body: {
        error: "risk_not_on_use_case",
        riskIds: foreign,
        detail: "every accepted risk must be a risk recorded against the use case being decided",
      },
    };
  }
  const accepted = rows.filter((r) => r.status === "accepted").map((r) => r.id);
  if (accepted.length > 0) {
    return { status: 409, body: { error: "risk_already_accepted", riskIds: accepted } };
  }
  const closed = rows.filter((r) => r.status === "closed").map((r) => r.id);
  if (closed.length > 0) {
    return { status: 409, body: { error: "risk_terminal", riskIds: closed, detail: "a closed risk has nothing left to accept" } };
  }
  return null;
}

/** Inside the decide transaction: the listed risks move to `accepted` with the
 * rationale, one audit row per risk (`use-case-risk-accepted`). */
export async function acceptUseCaseRisks(
  db: Db,
  useCase: { id: string; name: string },
  approvalId: string,
  input: { riskIds: string[]; rationale: string },
  actorUserId: string,
): Promise<void> {
  const now = new Date();
  const rows = await db
    .update(aiRisks)
    .set({ status: "accepted", acceptedByUserId: actorUserId, acceptedAt: now, acceptanceNote: input.rationale, updatedAt: now })
    .where(
      and(
        inArray(aiRisks.id, [...new Set(input.riskIds)]),
        eq(aiRisks.useCaseId, useCase.id),
        or(eq(aiRisks.status, "open"), eq(aiRisks.status, "mitigating")),
      ),
    )
    .returning({ id: aiRisks.id, title: aiRisks.title, likelihood: aiRisks.likelihood, impact: aiRisks.impact });
  for (const r of rows) {
    // ADR-0180 §6: a sign-off acceptance is a time-boxed acceptance record too
    // (expiry = the longest the residual band allows), not only a status flip.
    await recordRiskAcceptance(db, { riskId: r.id, rationale: input.rationale, actorUserId, now, origin: { kind: "sign_off", approvalId } });
    await db.insert(auditLog).values({
      userId: actorUserId,
      objectType: "ai_use_case",
      objectId: useCase.id,
      detail: {
        phase: "risk-accepted",
        riskId: r.id,
        approvalId,
        declared: { likelihood: r.likelihood, impact: r.impact },
      },
      effect: "allow",
      ruleId: "use-case-risk-accepted",
      ruleChain: [],
      reason:
        `residual risk '${r.title}' on AI use case '${useCase.name}' ACCEPTED at sign-off: ${input.rationale} — ` +
        "a recorded decision, not a control",
    });
  }
}

// ---------------------------------------------------------------------------
// ADR-0170 §3 — WHO MAY CLOSE A CONDITION (maker–checker for before-go-live)
// ---------------------------------------------------------------------------

/** the facts the closing rule reads, loaded once per use case */
export interface ConditionCloseContext {
  isAdmin: boolean;
  callerId: string | null;
  /** the use case's owner and the intake instance's initiator — "the proposer" */
  proposerIds: Set<string>;
  /** users who APPROVED a sign-off / review row of the use case's current approval */
  approverIds: Set<string>;
}

export async function conditionCloseContext(
  db: Db,
  useCase: Pick<AiUseCaseRow, "ownerUserId" | "workflowInstanceId">,
  auth: { isAdmin: boolean; userId: string | null | undefined },
): Promise<ConditionCloseContext> {
  const proposerIds = new Set<string>([useCase.ownerUserId]);
  const approverIds = new Set<string>();
  if (useCase.workflowInstanceId) {
    const [inst] = await db
      .select({ initiatorUserId: workflowInstances.initiatorUserId })
      .from(workflowInstances)
      .where(eq(workflowInstances.id, useCase.workflowInstanceId));
    if (inst?.initiatorUserId) proposerIds.add(inst.initiatorUserId);
    const rows = await db
      .select({ decidedBy: approvals.decidedBy, reviewRound: approvals.reviewRound })
      .from(approvals)
      .where(
        and(
          eq(approvals.instanceId, useCase.workflowInstanceId),
          eq(approvals.objectType, "workflow"),
          inArray(approvals.status, ["approved", "consumed"]),
        ),
      );
    // the CURRENT approval: on a review-policy path, the latest round's role
    // reviews; on the single named-approver path, its approved sign-offs
    const roleRounds = rows.map((r) => r.reviewRound).filter((r): r is number => r !== null);
    const current =
      roleRounds.length > 0
        ? rows.filter((r) => r.reviewRound === Math.max(...roleRounds))
        : rows.filter((r) => r.reviewRound === null);
    for (const r of current) if (r.decidedBy) approverIds.add(r.decidedBy);
  }
  return { isAdmin: auth.isAdmin, callerId: auth.userId ?? null, proposerIds, approverIds };
}

export type ConditionCloseVerdict =
  | { allowed: true; noteRequired: boolean }
  | { allowed: false; error: "proposer_cannot_close_blocking_condition" | "forbidden"; detail: string };

/**
 * A BEFORE-go-live (blocking) condition is closed by someone other than the
 * proposer: an admin; the condition's owner when that owner is neither the
 * use case's owner nor the intake initiator; or a reviewer who approved the
 * current approval — always with a note. An AFTER-go-live condition keeps the
 * ADR-0168 rule: its owner, the use case's owner, or an admin.
 */
export function conditionCloseVerdict(
  cond: Pick<UseCaseConditionRow, "blocking" | "ownerUserId">,
  useCaseOwnerId: string,
  ctx: ConditionCloseContext,
): ConditionCloseVerdict {
  const me = ctx.callerId;
  if (!cond.blocking) {
    if (ctx.isAdmin || (!!me && (me === cond.ownerUserId || me === useCaseOwnerId))) {
      return { allowed: true, noteRequired: false };
    }
    return {
      allowed: false,
      error: "forbidden",
      detail: "an after-go-live condition is marked met by its owner, the use case's owner, or an admin",
    };
  }
  if (ctx.isAdmin) return { allowed: true, noteRequired: true };
  if (me && ctx.proposerIds.has(me)) {
    return {
      allowed: false,
      error: "proposer_cannot_close_blocking_condition",
      detail:
        "a before-go-live condition is confirmed by someone other than the person who proposed the use case — " +
        "the condition's owner, a reviewer who approved it, or an admin",
    };
  }
  if (me && (me === cond.ownerUserId || ctx.approverIds.has(me))) return { allowed: true, noteRequired: true };
  return {
    allowed: false,
    error: "forbidden",
    detail:
      "a before-go-live condition is marked met by its owner, a reviewer who approved the use case, or an admin",
  };
}

async function conditionViewsFor(
  db: Db,
  useCase: Pick<AiUseCaseRow, "id" | "ownerUserId" | "workflowInstanceId">,
  now: Date,
  auth: { isAdmin: boolean; userId: string | null | undefined },
): Promise<UseCaseConditionRecordView[]> {
  const rows = await db
    .select()
    .from(useCaseConditions)
    .where(eq(useCaseConditions.useCaseId, useCase.id))
    .orderBy(useCaseConditions.dueAt, useCaseConditions.createdAt, useCaseConditions.id);
  const ids = [...new Set(rows.flatMap((r) => [r.ownerUserId, r.metByUserId, r.waivedBy]).filter((x): x is string => !!x))];
  const names = await userNames(db, ids);
  const ctx = rows.some((r) => r.status === "open") ? await conditionCloseContext(db, useCase, auth) : null;
  return rows.map((r) =>
    conditionView(r, names, now, !!ctx && r.status === "open" && conditionCloseVerdict(r, useCase.ownerUserId, ctx).allowed),
  );
}

async function userNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .where(inArray(users.id, ids));
  return new Map(rows.map((u) => [u.id, u.displayName || u.email]));
}

/** ADR-0168's condition view plus ADR-0180 A2's measured fields */
export type UseCaseConditionRecordView = UseCaseConditionView & MeasuredConditionFields;

function conditionView(
  r: UseCaseConditionRow,
  names: Map<string, string>,
  now: Date,
  canMarkMet: boolean,
): UseCaseConditionRecordView {
  const spec = specOf(r);
  return {
    id: r.id,
    approvalId: r.approvalId,
    text: r.text,
    ownerUserId: r.ownerUserId,
    ownerName: r.ownerUserId ? (names.get(r.ownerUserId) ?? null) : null,
    dueAt: r.dueAt.toISOString(),
    blocking: r.blocking,
    status: r.status,
    metAt: r.metAt ? r.metAt.toISOString() : null,
    metByName: r.metByUserId ? (names.get(r.metByUserId) ?? null) : null,
    note: r.note,
    overdue: r.status === "open" && r.dueAt.getTime() < now.getTime(),
    // ADR-0180 A2: a measured condition is closed only by passing evidence
    canMarkMet: canMarkMet && r.kind === "manual",
    kind: r.kind,
    metric: r.metric,
    params: r.params ?? {},
    operator: r.operator,
    threshold: r.threshold,
    windowDays: r.windowDays,
    minSamples: r.minSamples,
    cadence: r.cadence,
    onBreach: r.onBreach,
    spec: spec ? describeMetricCondition(spec) : null,
    lastValue: r.lastValue,
    lastSamples: r.lastSamples,
    lastState: r.lastState,
    lastEvaluatedAt: r.lastEvaluatedAt ? r.lastEvaluatedAt.toISOString() : null,
    consecutiveBreaches: r.consecutiveBreaches,
    evidence: r.evidence ?? [],
    waivedAt: r.waivedAt ? r.waivedAt.toISOString() : null,
    waivedByName: r.waivedBy ? (names.get(r.waivedBy) ?? null) : null,
    waiveReason: r.waiveReason,
  };
}

/**
 * ADR-0168 — WHO MAY READ ONE USE CASE: its owner, an admin, and the
 * reviewer of its intake sign-off — the named approver of a PENDING sign-off
 * on its intake instance, an active delegate of that approver (ADR-0022), or
 * whoever DECIDED one. Read-only: every write route keeps its own owner/admin
 * rule, and the list is not widened.
 */
export async function canReadUseCase(
  db: Db,
  useCase: Pick<AiUseCaseRow, "ownerUserId" | "workflowInstanceId">,
  auth: { isAdmin: boolean; userId: string | null | undefined },
): Promise<boolean> {
  if (auth.isAdmin) return true;
  const me = auth.userId;
  if (!me) return false;
  if (me === useCase.ownerUserId) return true;
  return isIntakeReviewer(db, useCase, me);
}

export async function isIntakeReviewer(
  db: Db,
  useCase: Pick<AiUseCaseRow, "workflowInstanceId">,
  userId: string,
): Promise<boolean> {
  if (!useCase.workflowInstanceId) return false;
  const delegators = await activeDelegatorsFor(db, userId);
  const named = delegators.length
    ? or(eq(approvals.approverUserId, userId), inArray(approvals.approverUserId, delegators))
    : eq(approvals.approverUserId, userId);
  // ADR-0168 amendment: a member of a reviewer role this use case's review
  // rounds were routed to is one of its reviewers, whoever the row names
  const myRoles = reviewRoleIdsFor(await loadReviewPolicy(db), userId);
  const [hit] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.objectType, "workflow"),
        eq(approvals.instanceId, useCase.workflowInstanceId),
        or(
          and(eq(approvals.status, "pending"), named),
          eq(approvals.decidedBy, userId),
          ...(myRoles.length ? [inArray(approvals.reviewRoleId, myRoles)] : []),
        ),
      ),
    )
    .limit(1);
  return !!hit;
}

/** ADR-0168 amendment — what the wizard needs to resubmit a use case that was
 * sent back: the structured answers and questionnaire last submitted, and who
 * asked for what. `allowed` = it is `needs_info` and the caller may edit it. */
async function resubmissionFor(
  db: Db,
  row: AiUseCaseRow,
  questionnaire: { version: number; content: string } | null,
  auth: { isAdmin: boolean; userId: string | null | undefined },
) {
  let returnReason: string | null = null;
  let returnedByName: string | null = null;
  if (row.workflowInstanceId) {
    const [ret] = await db
      .select({ reason: approvals.decisionReason, decidedBy: approvals.decidedBy })
      .from(approvals)
      .where(and(eq(approvals.instanceId, row.workflowInstanceId), eq(approvals.status, "returned")))
      .orderBy(desc(approvals.decidedAt), desc(approvals.id))
      .limit(1);
    if (ret) {
      returnReason = ret.reason;
      returnedByName = ret.decidedBy ? ((await userNames(db, [ret.decidedBy])).get(ret.decidedBy) ?? null) : null;
    }
  }
  // every Classify-step answer stored with the use case (registration, or a
  // resubmission PATCH) over the EU answers of the latest questionnaire; a
  // use case registered without them prefills the EU answers only
  const extracted = questionnaire ? extractEuAiActAnswers(questionnaire.content) : null;
  const fromQuestionnaire = extracted?.status === "ok" ? extracted.answers : null;
  // ADR-0171: + the "Not sure" set, so a resubmission starts from it
  const screeningAnswers =
    fromQuestionnaire || row.intakeAnswers
      ? { ...(fromQuestionnaire ?? {}), ...(row.intakeAnswers ?? {}), unsure: row.screeningUnsure ?? [] }
      : null;
  return {
    allowed: row.status === "needs_info" && (auth.isAdmin || (!!auth.userId && auth.userId === row.ownerUserId)),
    screeningAnswers,
    questionnaire: questionnaire ? { version: questionnaire.version, content: questionnaire.content } : null,
    returnReason,
    returnedByName,
  };
}

/** the use case's risks, with any acceptance (on a sign-off or the register) */
async function riskViewsFor(db: Db, useCaseId: string) {
  const rows = await db
    .select()
    .from(aiRisks)
    .where(eq(aiRisks.useCaseId, useCaseId))
    .orderBy(desc(aiRisks.createdAt), aiRisks.id);
  const names = await userNames(
    db,
    [...new Set(rows.map((r) => r.acceptedByUserId).filter((x): x is string => !!x))],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    category: r.category,
    status: r.status,
    likelihood: r.likelihood,
    impact: r.impact,
    residualLikelihood: r.residualLikelihood,
    residualImpact: r.residualImpact,
    acceptedByName: r.acceptedByUserId ? (names.get(r.acceptedByUserId) ?? null) : null,
    acceptedAt: r.acceptedAt ? r.acceptedAt.toISOString() : null,
    acceptanceRationale: r.status === "accepted" ? r.acceptanceNote : null,
  }));
}

// ---- ADR-0219: the AI registry under the shared list contract ---------------
const UC_OPEN_CONDITIONS = sql<number>`(select count(*)::int from ${useCaseConditions} where ${useCaseConditions.useCaseId} = ${aiUseCases.id} and ${useCaseConditions.status} = 'open')`;
/** the owner choices offered beside the list (by name) */
const UC_OWNER_CHOICES = 500;
const useCasesFilterQuery = z
  .object({
    /** matches the name, the purpose or the owner's name, case-insensitively; % and _ are literal */
    q: z.string().trim().max(200).optional(),
    status: z.enum(["all", "in_review", "recertification", "proposed", "under_review", "needs_info", "approved", "rejected", "retired"]).optional(),
    tier: z.enum(["all", "prohibited", "high", "limited", "minimal", "unscreened", "high_or_prohibited"]).optional(),
    owner: z.string().uuid().optional(),
  })
  .strict();
function useCasesWhere(scope: SQL | undefined, f: z.infer<typeof useCasesFilterQuery>): SQL | undefined {
  const conds: SQL[] = scope ? [scope] : [];
  if (f.status === "recertification") conds.push(sql`${aiUseCases.recertification} and ${aiUseCases.status} = 'under_review'`);
  else if (f.status === "in_review") conds.push(sql`${aiUseCases.status} in ('proposed', 'under_review', 'needs_info')`);
  else if (f.status && f.status !== "all") conds.push(eq(aiUseCases.status, f.status));
  if (f.tier === "unscreened") conds.push(sql`${aiUseCases.euAiActTier} is null`);
  else if (f.tier === "high_or_prohibited") conds.push(sql`${aiUseCases.euAiActTier} in ('high', 'prohibited')`);
  else if (f.tier && f.tier !== "all") conds.push(eq(aiUseCases.euAiActTier, f.tier));
  if (f.owner) conds.push(eq(aiUseCases.ownerUserId, f.owner));
  if (f.q) {
    const pattern = likeLiteral(f.q);
    conds.push(sql`(${aiUseCases.name} ilike ${pattern} or ${aiUseCases.description} ilike ${pattern} or coalesce(${userNameSql(aiUseCases.ownerUserId)}, '') ilike ${pattern})`);
  }
  return conds.length ? and(...conds) : undefined;
}
type UseCaseListRow = Omit<AiUseCaseRow, "intakeAnswers"> & {
  ownerName: string | null;
  openConditions: number;
  approvalExpired: boolean;
  recertificationDueAt: string | null;
};
const UC_STATUS_ORDER = sql`case when ${aiUseCases.recertification} and ${aiUseCases.status} = 'under_review' then 3 else case ${aiUseCases.status} when 'proposed' then 1 when 'under_review' then 2 when 'needs_info' then 4 when 'approved' then 5 when 'rejected' then 6 when 'retired' then 7 end end`;
const UC_TIER_ORDER = sql`case ${aiUseCases.euAiActTier} when 'prohibited' then 0 when 'high' then 1 when 'limited' then 2 when 'minimal' then 3 end`;
const ucStatusLabel = (r: UseCaseListRow) =>
  r.recertification && r.status === "under_review" ? "Re-review" : r.status === "needs_info" ? "Needs information" : r.status.replace(/_/g, " ");
export const USE_CASES_LIST: ListSpec<UseCaseListRow> = {
  id: "use-cases",
  sorts: {
    name: { expr: sql`lower(${aiUseCases.name})` },
    status: { expr: UC_STATUS_ORDER },
    tier: { expr: UC_TIER_ORDER },
    owner: { expr: sql`lower(${userNameSql(aiUseCases.ownerUserId)})` },
    created: { expr: aiUseCases.createdAt, keysetAt: aiUseCases.createdAt },
    validUntil: { expr: aiUseCases.approvedUntil },
    conditions: { expr: UC_OPEN_CONDITIONS },
    sensitivity: { expr: aiUseCases.dataSensitivity },
    decided: { expr: aiUseCases.decidedAt },
  },
  columns: {
    name: { label: "Name", value: (r) => r.name },
    status: { label: "Status", value: ucStatusLabel },
    tier: { label: "Tier", value: (r) => r.euAiActTier ?? "not screened" },
    owner: { label: "Owner", value: (r) => r.ownerName ?? "Unnamed" },
    created: { label: "Created", value: (r) => r.createdAt },
    validUntil: { label: "Valid until", value: (r) => (r.approvedUntil ? `${r.approvalExpired ? "Expired " : ""}${r.approvedUntil.toISOString().slice(0, 10)}` : null) },
    conditions: { label: "Open conditions", value: (r) => r.openConditions },
    sensitivity: { label: "Data sensitivity", value: (r) => r.dataSensitivity },
    decided: { label: "Decided", value: (r) => r.decidedAt },
    description: { label: "Purpose", value: (r) => r.description },
  },
  filters: ["q", "status", "tier", "owner"],
  defaultSort: { col: "created", dir: "desc" },
  idCol: aiUseCases.id,
};

function approvalExpired(row: AiUseCaseRow, now: Date): boolean {
  return row.status === "approved" && !!row.approvedUntil && row.approvedUntil.getTime() <= now.getTime();
}

// ---------------------------------------------------------------------------
// The intake template resolution
// ---------------------------------------------------------------------------

/**
 * Newest ACTIVE intake template wins — `ai-use-case-intake` itself or a named
 * variant `ai-use-case-intake/<label>` (ADR-0165). An admin routes use-case
 * approvals to a governance owner by creating a variant from the gallery shape
 * with a concrete approver; template names are unique even once retired, so
 * without variants the built-in shape — minted on the first use case — could
 * never be superseded. Only when none is active is the built-in shape minted,
 * through the ONE template-creation path (ADR-0077 discipline) — under a dated
 * `ai-use-case-intake/built-in-…` name when the built-in name is retired.
 */
async function resolveIntakeTemplate(
  db: Db,
): Promise<{ ok: true; templateId: string } | { ok: false; status: number; body: Record<string, unknown> }> {
  const rows = await db
    .select()
    .from(workflowTemplates)
    .where(
      or(
        eq(workflowTemplates.name, AI_USE_CASE_INTAKE_TEMPLATE_NAME),
        sql`${workflowTemplates.name} like ${`${AI_USE_CASE_INTAKE_TEMPLATE_NAME}/%`}`,
      ),
    )
    .orderBy(desc(workflowTemplates.createdAt));
  const active = rows.find((t) => t.retiredAt === null);
  if (active) return { ok: true, templateId: active.id };
  // No active intake template: the built-in shape decides (D4G-04's retire preview resolves to exactly this, so
  // it was previewed when the last active one was retired). Template names are unique even once retired, so when
  // the built-in name is already taken by a retired row the shape is minted as a dated built-in variant rather than
  // failing as a bare unique-violation conflict (ADR-0182 integration).
  const name = rows.some((t) => t.name === AI_USE_CASE_INTAKE_TEMPLATE_NAME)
    ? `${AI_USE_CASE_INTAKE_TEMPLATE_NAME}/built-in-${new Date().toISOString().replace(/[-:.]/g, "").toLowerCase()}`
    : AI_USE_CASE_INTAKE_TEMPLATE_NAME;
  const created = await createWorkflowTemplateValidated(db, {
    name,
    definition: aiUseCaseIntakeDefinition(),
  });
  if (!created.ok) return created;
  return { ok: true, templateId: created.row.id };
}

// ---------------------------------------------------------------------------
// The cascade-consequences card — DERIVED, never duplicated (ADR-0077 rule 1)
// ---------------------------------------------------------------------------

async function cascadeConsequencesFor(db: Db, useCase: AiUseCaseRow) {
  const tags = useCase.complianceTags;
  if (tags.length === 0) {
    return {
      profiles: [],
      unrecognizedTags: [],
      combined: null,
      project: await projectSummaryFor(db, useCase),
      note: "this use case carries no compliance tags, so the cascade forces nothing on its account",
    };
  }
  // THE funnel: the same resolution requiredTemplateIdsFor enforces
  const resolved = await complianceProfilesForTags(db, tags);
  const resolvedTags = new Set(resolved.map((p) => p.tag));
  const unrecognizedTags = tags.filter((t) => !resolvedTags.has(t));
  const templateIds = [...new Set(resolved.flatMap((p) => p.requiredTemplateIds ?? []))];
  const templateRows = templateIds.length
    ? await db.select().from(workflowTemplates).where(inArray(workflowTemplates.id, templateIds))
    : [];
  const templateById = new Map(templateRows.map((t) => [t.id, t]));
  const describeTemplates = (ids: string[]) =>
    ids
      .map((id) => templateById.get(id))
      .filter((t): t is NonNullable<typeof t> => t !== undefined)
      .map((t) => ({
        id: t.id,
        name: t.name,
        retired: t.retiredAt !== null,
        stageIds: ((t.definition as WorkflowDefinition).stages ?? []).map((s) => s.id),
      }));

  const profiles = resolved.map((p) => {
    const policy = effectiveCompliancePolicy([p]);
    return {
      tag: p.tag,
      piiMode: policy.piiMode,
      auditRetentionDays: policy.auditRetentionDays,
      mcpDefaultMode: policy.mcpDefaultMode,
      requiredTemplates: describeTemplates(policy.requiredTemplateIds),
    };
  });
  const combinedPolicy = effectiveCompliancePolicy(resolved);
  const combined = {
    piiMode: combinedPolicy.piiMode,
    auditRetentionDays: combinedPolicy.auditRetentionDays,
    mcpDefaultMode: combinedPolicy.mcpDefaultMode,
    requiredTemplates: describeTemplates(combinedPolicy.requiredTemplateIds),
    forcedStageIds: [
      ...new Set(describeTemplates(combinedPolicy.requiredTemplateIds).flatMap((t) => t.stageIds)),
    ],
  };
  return {
    profiles,
    unrecognizedTags,
    combined,
    project: await projectSummaryFor(db, useCase),
    note:
      "derived live from the compliance profiles — the same rules the cascade enforces on a " +
      "classified project. Enforcement reads a PROJECT's classifications: these consequences " +
      "bind when the named project carries these tags.",
  };
}

/** the no-auto-block posture, stated as data so every read carries it */
const EU_AI_ACT_ENFORCEMENT_NOTE =
  "the tier INFORMS the human sign-off on the one approvals queue — nothing is auto-blocked by " +
  "a tier (approval gates dispatch only where the org's use_case_gate_mode opt-in is armed — " +
  "off by default, per the ADR-0080 B3 amendment), and the decide path is unchanged";

/**
 * ADR-0085 — the screening as the detail view reads it: the STORED result
 * (tier + firing reasons + rule-set version, written only by
 * `recomputeEuTierForUseCase`), the disclaimer as a field, and — for a
 * `high`/`prohibited` tier — the CASCADE ENDING, derived live the ADR-0080
 * way (never a stored copy): which active eu-ai-act compliance packs exist,
 * which §8.3 cascade tag each drives, whether the org actually has a
 * compliance profile for that tag, and the pack's control references cited
 * read-only. A `prohibited` tier additionally carries the refusal text the
 * UI renders as an unmissable banner.
 */
async function euAiActScreeningFor(db: Db, useCase: AiUseCaseRow, questionnaireContent: string | null) {
  let answersStatus: "no_questionnaire" | "missing" | "invalid" | "ok" = "no_questionnaire";
  let answersError: string | null = null;
  if (questionnaireContent !== null) {
    const extracted = extractEuAiActAnswers(questionnaireContent);
    answersStatus = extracted.status;
    if (extracted.status === "invalid") answersError = extracted.error;
  }
  const tier = useCase.euAiActTier;
  const base = {
    tier,
    reasons: useCase.euAiActReasons,
    rulesetVersion: useCase.euAiActRulesetVersion,
    currentRulesetVersion: EU_AI_ACT_RULESET_VERSION,
    disclaimer: EU_AI_ACT_SCREENING_DISCLAIMER,
    enforcement: EU_AI_ACT_ENFORCEMENT_NOTE,
    answersStatus,
    answersError,
    refusal:
      tier === "prohibited"
        ? "Screening result: PROHIBITED under Art. 5 of the EU AI Act. As described by its own " +
          "answers, this use case falls within the Act's prohibited practices. The platform does " +
          "not auto-block it — the sign-off decision on the Approvals queue is where a human " +
          "refuses it, with this screening as the recorded reason."
        : null,
  };
  if (tier !== "high" && tier !== "prohibited") return { ...base, cascade: null };

  // derive live: active eu-ai-act packs -> their cascade tags -> whether a
  // §8.3 profile actually exists for each tag in THIS org, right now
  const activePacks = await db
    .select()
    .from(compliancePacks)
    .where(and(eq(compliancePacks.framework, "eu-ai-act"), eq(compliancePacks.status, "active")));
  const packs = [];
  for (const pack of activePacks) {
    const controls = await db
      .select({ controlRef: compliancePackControls.controlRef, title: compliancePackControls.title })
      .from(compliancePackControls)
      .where(eq(compliancePackControls.packId, pack.id))
      .orderBy(compliancePackControls.controlRef);
    const profiles = pack.cascadeTag ? await complianceProfilesForTags(db, [pack.cascadeTag]) : [];
    packs.push({
      id: pack.id,
      framework: pack.framework,
      version: pack.version,
      title: pack.title,
      cascadeTag: pack.cascadeTag,
      /** does the §8.3 cascade actually know this tag here, today? */
      profileExists: profiles.length > 0,
      carriedByUseCase: pack.cascadeTag !== null && useCase.complianceTags.includes(pack.cascadeTag),
      /** read-only citation of the pack's own control vocabulary */
      controls,
    });
  }
  const recommendedTags = packs
    .filter((p) => p.cascadeTag !== null)
    .map((p) => ({
      tag: p.cascadeTag!,
      fromPack: p.title,
      profileExists: p.profileExists,
      carriedByUseCase: p.carriedByUseCase,
    }));
  return {
    ...base,
    cascade: {
      recommendedTags,
      packs,
      note:
        tier === "high"
          ? "a high screening tier recommends carrying the tags above — where a §8.3 compliance " +
            "profile exists for a tag, adding it to this use case (and classifying the governed " +
            "project with it) is what turns the recommendation into enforced cascade consequences; " +
            "where none exists, creating the profile is the missing step. Derived live from the " +
            "active eu-ai-act compliance packs — never a stored copy."
          : "a prohibited screening tier is a reason to refuse at the sign-off, not to tag — the " +
            "pack citation shows the high-risk obligations that would apply even to a narrowed " +
            "variant of this proposal. Derived live from the active eu-ai-act compliance packs.",
    },
  };
}

/**
 * ADR-0089 (gap L21) — the use-case-shaped half of intended-vs-granted: for
 * an APPROVED use case, does each intended agent have a live grant path among
 * the use case's participants (the proposing owner plus the linked project's
 * members)? Computed at read time from the SAME holder sets the ADR-0082
 * inventory computes (imported, never reimplemented). Claims about GRANT ROWS
 * vs APPROVED intent only — never about observed traffic. A non-approved use
 * case gets no alignment (its intent is not yet, or no longer, something the
 * register stands behind), and an approved one naming no agents reads "no
 * intent recorded" — never a guessed alignment.
 */
async function intendedVsGrantedFor(db: Db, useCase: AiUseCaseRow) {
  if (useCase.status !== "approved") {
    return {
      status: "not_approved" as const,
      note:
        "alignment is computed against APPROVED intent only — this use case is " +
        `${useCase.status}, so its intended agents are not yet (or no longer) intent the register stands behind`,
    };
  }
  if ((useCase.intendedAgentIds ?? []).length === 0) {
    return {
      status: "no_intent_recorded" as const,
      note:
        "this approved use case names no intended agents, so there is nothing to compare grants " +
        "against — no intent recorded, never a guessed alignment",
    };
  }
  const holderIndex = await buildAgentHolderIndex(db);
  const participants = new Set<string>([useCase.ownerUserId]);
  if (useCase.projectId) {
    const members = await db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, useCase.projectId));
    for (const m of members) participants.add(m.userId);
  }
  const agentRows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(inArray(agents.id, useCase.intendedAgentIds));
  const nameOf = new Map(agentRows.map((a) => [a.id, a.name]));
  const perAgent = useCase.intendedAgentIds.map((agentId) => {
    const holderSet = holderIndex.holders.get(agentId) ?? new Set<string>();
    const participantHolders = [...participants].filter((p) => holderSet.has(p)).length;
    return {
      agentId,
      agentName: nameOf.get(agentId) ?? null,
      /** intendedAgentIds survive agent deletion by design — say so honestly */
      registered: nameOf.has(agentId),
      grantedToParticipants: participantHolders > 0,
      participantHolders,
    };
  });
  return {
    status: perAgent.every((a) => a.grantedToParticipants) ? ("aligned" as const) : ("undershoot" as const),
    participants: participants.size,
    agents: perAgent,
    note: INVENTORY_NOTES.alignment,
  };
}

async function projectSummaryFor(db: Db, useCase: AiUseCaseRow) {
  if (!useCase.projectId) return null;
  const [project] = await db
    .select({ id: projects.id, name: projects.name, classifications: projects.classifications })
    .from(projects)
    .where(eq(projects.id, useCase.projectId));
  if (!project) return null;
  const carried = project.classifications ?? [];
  return {
    id: project.id,
    name: project.name,
    classifications: carried,
    /** which of the use case's tags the project actually carries — i.e. which
     * consequences the cascade is enforcing there RIGHT NOW */
    tagsCarried: useCase.complianceTags.filter((t) => carried.includes(t)),
    tagsNotCarried: useCase.complianceTags.filter((t) => !carried.includes(t)),
  };
}

// ---------------------------------------------------------------------------
// ADR-0171 — framework rationales, "Not sure" answers, idempotent creation
// ---------------------------------------------------------------------------

/** AER-052: a rationale explains why a framework THIS use case carries
 * applies — one for a framework it does not carry has nothing to explain */
function unlistedRationaleRefusal(
  rationales: Record<string, string> | undefined,
  complianceTags: readonly string[],
): Record<string, unknown> | null {
  if (!rationales) return null;
  const unlisted = Object.keys(rationales).filter((k) => !complianceTags.includes(k));
  if (unlisted.length === 0) return null;
  return {
    error: "rationale_for_unlisted_framework",
    frameworks: unlisted,
    detail:
      `a framework rationale explains a framework this use case carries; ${unlisted.join(", ")} ` +
      "is not among its compliance tags",
  };
}

/** AER-053: the "Not sure" list split off the flat answers, deduplicated, and
 * checked against the answers it qualifies (null = consistent) */
function splitUnsure(answers: Record<string, unknown>): {
  rest: Record<string, unknown>;
  unsure: string[];
  refusal: Record<string, unknown> | null;
} {
  const { unsure: raw, ...rest } = answers;
  const unsure = [...new Set(Array.isArray(raw) ? (raw as string[]) : [])];
  const bad = unsureAnswerViolations(rest, unsure, INTAKE_BOOLEAN_QUESTION_KEYS);
  return {
    rest,
    unsure,
    refusal: bad.length
      ? { error: UNSURE_ANSWER_MUST_COUNT_AS_YES, answers: bad, detail: unsureViolationDetail(bad) }
      : null,
  };
}

/**
 * AER-053 — the questionnaire artifact route's pre-check (wired through
 * `WorkflowRouteOptions.validateArtifact`): an intake questionnaire whose
 * answers block marks an answer "Not sure" without counting it as yes is
 * refused by name BEFORE it is stored. Every other questionnaire — including
 * one with no or an otherwise invalid block — is unchanged (stored, then
 * screened as before).
 */
export function useCaseArtifactRefusal(
  output: string,
  content: string,
): { status: number; body: Record<string, unknown> } | null {
  if (output !== USE_CASE_QUESTIONNAIRE_OUTPUT) return null;
  const extracted = extractEuAiActAnswers(content);
  if (extracted.status === "invalid" && extracted.code === UNSURE_ANSWER_MUST_COUNT_AS_YES) {
    return { status: 422, body: { error: UNSURE_ANSWER_MUST_COUNT_AS_YES, detail: extracted.error } };
  }
  return null;
}

/** AER-050: how long a claimed Idempotency-Key replays its original response.
 * As long as a draft lives (use-case-drafts.ts, 30 days): the draft carries the
 * key, so a resume-and-retry after a lost response must still replay rather
 * than create a second use case. */
export const USE_CASE_IDEMPOTENCY_WINDOW_MS = IDEMPOTENCY_WINDOW_MS;

/** the stored original body for (caller, key), if claimed inside the window */
async function idempotentReplayFor(db: Db, userId: string, key: string): Promise<Record<string, unknown> | null> {
  const [hit] = await db
    .select({ response: useCaseIdempotencyKeys.response, createdAt: useCaseIdempotencyKeys.createdAt })
    .from(useCaseIdempotencyKeys)
    .where(and(eq(useCaseIdempotencyKeys.userId, userId), eq(useCaseIdempotencyKeys.key, key)));
  if (!hit || !hit.response) return null;
  if (Date.now() - hit.createdAt.getTime() >= USE_CASE_IDEMPOTENCY_WINDOW_MS) return null;
  return hit.response;
}

/** the 201 body of a create: the row, its intake instance, and how to fill the questionnaire */
const createdBody = (row: AiUseCaseRow, instance: { id: string; status: string; state: unknown }): Record<string, unknown> => ({
  ...row,
  instance,
  questionnaireTemplate: USE_CASE_QUESTIONNAIRE_TEMPLATE,
  note:
    "fill the questionnaire and submit it as the intake instance's " +
    `'${USE_CASE_QUESTIONNAIRE_OUTPUT}' artifact; the sign-off decision on the one approvals ` +
    "queue is what approves this use case",
});

/**
 * ADR-0179 security review, item 3: a claim keeps a reference to the use case
 * (`replayReference`), not the 201 body with its description and answers. A
 * replay rebuilds the body from the use case and its instance as they stand,
 * under the read rule (its owner or an admin); a caller who can no longer read
 * it gets its id only. A claim stored before the change holds the full body
 * and is replayed verbatim.
 */
async function useCaseReplayBody(
  db: Db,
  stored: Record<string, unknown>,
  caller: { userId: string; isAdmin: boolean },
): Promise<Record<string, unknown>> {
  const useCaseId = referencedId(stored);
  if (!useCaseId) return stored;
  const [row] = await db.select().from(aiUseCases).where(eq(aiUseCases.id, useCaseId));
  if (!row || !row.workflowInstanceId || (!caller.isAdmin && row.ownerUserId !== caller.userId)) return { id: useCaseId };
  const [instance] = await db
    .select({
      id: workflowInstances.id,
      status: workflowInstances.status,
      state: workflowInstances.state,
      stageEntry: workflowInstances.stageEntry,
      context: workflowInstances.context,
    })
    .from(workflowInstances)
    .where(eq(workflowInstances.id, row.workflowInstanceId));
  if (!instance) return { id: useCaseId };
  // PR #357 recheck L-b: a replay re-drives nothing (ADR-0179); it carries the
  // refusal the intake still stands on, read from the instance (a pure read)
  const standing = standingExecutorRefusal(instance);
  return {
    ...createdBody(row, { id: instance.id, status: instance.status, state: instance.state }),
    ...(standing ? { executorRefusal: standing } : {}),
  };
}

/** thrown inside the create transaction to roll back the key claim with it */
class CreateRefused extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super("use-case create refused");
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface UseCaseRouteOptions {
  dataKey?: string;
}

export function registerUseCaseRoutes(
  app: FastifyInstance,
  db: Db,
  opts: UseCaseRouteOptions = {},
): void {
  // -------------------------------------------------------------------------
  // ADR-0149 — THE INTAKE ASSISTANT. Suggestion-only: this route writes no use
  // case, no artifact and no risk. The tier, frameworks, risks, controls and a
  // first draft of every narrative section come from deterministic rules over
  // the proposer's own answers (`suggestIntake`), so they work with no model
  // at all. A model draft is OPTIONAL: an ordinary governed dispatch of a
  // registry agent the caller is entitled to (the copilot's `agentDecision` +
  // `executeGovernedDispatch` path — PII, guardrails, budget and audit all
  // apply), and every section says whether its text came from `rules`, a
  // `mock` provider or a live `model`.
  // -------------------------------------------------------------------------
  app.post("/v1/use-cases/intake/assist", async (req, reply) => {
    const userId = req.authCtx.userId;
    if (!userId) {
      return reply.status(403).send({
        error: "intake_assist_requires_identity",
        detail: "the assistant drafts on behalf of a person; a token with no user identity cannot propose",
      });
    }
    const body = intakeAssistRequestSchema.parse(req.body ?? {});
    const suggestions = suggestIntake(body);

    type Narrative =
      | { status: "not_requested" }
      | { status: "skipped" | "refused" | "failed" | "unparseable"; reason: string }
      | { status: "drafted"; source: "model" | "mock"; agentId: string; sections: string[] };
    let narrative: Narrative = { status: "not_requested" };
    let questionnaire = suggestions.questionnaire;
    if (body.draftNarrative) {
      // ADR-0173 §3 — the intake assistant is a feature of the model
      // allow-list, and it KNOWS the data class of what it sends: the class the
      // proposer's own data categories derive (the same derivation the use case
      // is stored with), so a data-class rule applies here.
      const intakeGate = {
        feature: "intake_assist" as const,
        dataClass: deriveDataSensitivityFromCategories(body.context.dataCategories),
      };
      const [named] = body.agentId ? await db.select().from(agents).where(eq(agents.id, body.agentId)) : [];
      // no agent named: the policy's default for the intake assistant, when
      // this person may use it (a default is a preference, never a grant)
      const agent = named ?? (body.agentId ? undefined : await featureDefaultModel(db, userId, intakeGate));
      if (!agent) {
        narrative = { status: "skipped", reason: body.agentId ? "unknown agent" : "no agentId supplied" };
      } else {
        const decision = await agentDecision(db, userId, agent, intakeGate);
        if (decision.effect !== "allow") {
          // audited like every other governance refusal of a model use
          await db.insert(auditLog).values({
            userId,
            objectType: "agent",
            objectId: agent.id,
            detail: { surface: "intake_assist", agentName: agent.name, dataClass: intakeGate.dataClass, receiptClass: "decision" },
            effect: "deny",
            ruleId: decision.ruleId,
            ruleChain: decision.ruleChain,
            reason: decision.reason,
          });
          narrative = { status: "refused", reason: decision.reason };
        } else {
          // ADR-0188 S4: one intake-assist narrative the person asked for: a direct call, no agent principal acts — decided as the person (no delegation grant).
          const outcome = await executeGovernedDispatch(db, opts.dataKey, {
            userId,
            served: agent,
            requestedAgentId: agent.id,
            baseline: null,
            input: buildIntakeNarrativePrompt(body, suggestions.questionnaire),
            maxTokens: 4096,
            projectId: null,
            modelFeature: intakeGate,
            detail: { purpose: "intake-assist" },
          });
          if (!outcome.ok) {
            narrative = { status: "failed", reason: `${outcome.error}${outcome.detail ? ` — ${outcome.detail}` : ""}` };
          } else {
            const parsed = parseIntakeNarrative(outcome.result.outputText);
            if (!parsed) {
              // the rules draft stands; a reply we cannot parse is never shown
              // as if it were a draft
              narrative = {
                status: "unparseable",
                reason: "the model reply was not the requested JSON; the rule-based draft is shown instead",
              };
            } else {
              const source = agent.provider === "mock" ? ("mock" as const) : ("model" as const);
              questionnaire = questionnaire.map((s) =>
                parsed[s.id] ? { ...s, text: parsed[s.id]!, source } : s,
              );
              narrative = { status: "drafted", source, agentId: agent.id, sections: Object.keys(parsed) };
            }
          }
        }
      }
    }

    // One audit row per assist: counts and outcomes, never the description
    // text — the proposer has not submitted anything yet.
    await db.insert(auditLog).values({
      userId,
      objectType: "ai_use_case",
      objectId: null,
      detail: {
        phase: "intake-assist",
        tier: suggestions.tier.value,
        frameworks: suggestions.frameworks.map((f) => f.framework),
        riskCategories: suggestions.risks.map((r) => r.category),
        narrative: narrative.status,
      },
      effect: "allow",
      ruleId: "use-case-intake-assisted",
      ruleChain: [],
      reason:
        `intake assistant suggested tier '${suggestions.tier.value}', ` +
        `${suggestions.frameworks.length} framework(s) and ${suggestions.risks.length} risk(s); nothing was saved`,
    });

    return {
      ...suggestions,
      questionnaire,
      narrative,
      disclaimer:
        "Suggestions only. Nothing is saved until you submit the questionnaire, and the tier is " +
        "recomputed server-side from the answers you submit. Rule-based suggestions trace to your " +
        "answers; model-drafted text is labelled with its source and may be wrong.",
    };
  });

  // Propose: creates the registry row AND starts its governing intake
  // instance through the one instance-creation path. Non-admin on purpose —
  // proposing a use case is the FRONT door, and the person walking through it
  // is not an admin.
  app.post("/v1/use-cases", async (req, reply) => {
    const body = createUseCaseSchema.parse(req.body);
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_propose" });

    // ADR-0171 / AER-050 — IDEMPOTENT CREATION. A retry carrying the same
    // Idempotency-Key from the same caller within 30 days gets the ORIGINAL 201
    // body back (200 + `Idempotent-Replay: true`) instead of a second use
    // case. Keys are per caller; no header = unchanged behaviour.
    // the header is read by the helper the risk and artifact writes share (ADR-0179)
    const keyRead = readIdempotencyKey(req);
    if (!keyRead.ok) return reply.status(400).send(keyRead.body);
    const idemKey = keyRead.key;
    const caller = { userId, isAdmin: req.authCtx.isAdmin };
    if (idemKey) {
      const replay = await idempotentReplayFor(db, userId, idemKey);
      if (replay) {
        return reply.status(200).header("Idempotent-Replay", "true").send(await useCaseReplayBody(db, replay, caller));
      }
    }

    // ADR-0171 / AER-052 — rationales only for frameworks this use case carries
    const unlisted = unlistedRationaleRefusal(body.frameworkRationales, body.complianceTags);
    if (unlisted) return reply.status(422).send(unlisted);
    // ADR-0171 / AER-053 — a "Not sure" answer counts as yes, never a silent no
    const split = body.screeningAnswers ? splitUnsure(body.screeningAnswers) : null;
    if (split?.refusal) return reply.status(422).send(split.refusal);

    if (body.projectId) {
      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, body.projectId));
      if (!project) return reply.status(400).send({ error: "invalid_reference", field: "projectId" });
    }
    if (body.intendedAgentIds.length > 0) {
      const found = await db
        .select({ id: agents.id })
        .from(agents)
        .where(inArray(agents.id, body.intendedAgentIds));
      if (found.length !== new Set(body.intendedAgentIds).size) {
        return reply.status(400).send({ error: "invalid_reference", field: "intendedAgentIds" });
      }
    }

    // issue #522 finding #30: a use case registered from a shadow-AI finding keeps the link. Findings are readable by
    // admins only (the shadow-AI routes are admin-only), so only an admin may name one. That is checked BEFORE the
    // lookup, so a refusal never says whether an id exists. A finding is registered as one use case at most.
    let discoveryFinding: { id: string; subject: string; provider: string } | null = null;
    if (body.discoveryFindingId) {
      if (!req.authCtx.isAdmin) {
        return reply.status(403).send({
          error: "finding_not_readable",
          detail: "only an administrator may register a use case from a shadow-AI finding",
        });
      }
      const [finding] = await db
        .select({ id: shadowAiFindings.id, subject: shadowAiFindings.subject, provider: shadowAiFindings.provider })
        .from(shadowAiFindings)
        .where(eq(shadowAiFindings.id, body.discoveryFindingId));
      if (!finding) return reply.status(400).send({ error: "invalid_reference", field: "discoveryFindingId" });
      const holder = await discoveryFindingHolder(db, finding.id);
      if (holder) return reply.status(409).send(findingAlreadyRegistered(holder));
      discoveryFinding = finding;
    }

    const template = await resolveIntakeTemplate(db);
    if (!template.ok) return reply.status(template.status).send(template.body);

    // ONE transaction: the key claim, the intake instance, the registry row
    // and its audit row commit together or not at all. The claim is
    // INSERTED FIRST: a concurrent duplicate's insert waits on this
    // transaction at the unique (user_id, key) index and, once it commits,
    // conflicts and replays — two requests can never both create.
    let outcome: { kind: "created"; body: Record<string, unknown> } | { kind: "replay"; body: Record<string, unknown> | null };
    let startSignoff: AiBomSignoff | null = null;
    try {
      outcome = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        if (idemKey) {
          const expired = new Date(Date.now() - USE_CASE_IDEMPOTENCY_WINDOW_MS);
          await tx
            .delete(useCaseIdempotencyKeys)
            .where(
              and(
                eq(useCaseIdempotencyKeys.userId, userId),
                eq(useCaseIdempotencyKeys.key, idemKey),
                lt(useCaseIdempotencyKeys.createdAt, expired),
              ),
            );
          const claimed = await tx
            .insert(useCaseIdempotencyKeys)
            .values({ userId, key: idemKey })
            .onConflictDoNothing({ target: [useCaseIdempotencyKeys.userId, useCaseIdempotencyKeys.key] })
            .returning({ id: useCaseIdempotencyKeys.id });
          if (claimed.length === 0) {
            const [existing] = await tx
              .select({ response: useCaseIdempotencyKeys.response })
              .from(useCaseIdempotencyKeys)
              .where(and(eq(useCaseIdempotencyKeys.userId, userId), eq(useCaseIdempotencyKeys.key, idemKey)));
            return { kind: "replay" as const, body: existing?.response ?? null };
          }
        }

        // pillar-2 rails: the intake instance. It carries NO projectId — the
        // proposal governs itself; the named project is a reference the cascade
        // card reads, not an attribution target (ADR-0080 honest limits).
        const started = await startWorkflowInstanceWithTemplates(tx, opts.dataKey, {
          templateIds: [template.templateId],
          initiatorUserId: userId,
          change: {
            description: `AI use-case intake: ${body.name}`,
            paths: [],
            changeType: "ai-use-case-intake",
            environment: "governance",
          },
          // ADR-0189 R25 item 13 prevention: the use case is bound below, after
          // the start ran its stages, so the executor's lookahead cannot find
          // it by instance. An intake stage that would complete the instance
          // would approve this proposal: it runs only if that approval could
          // take its signed snapshot, and otherwise waits, effect-free.
          executor: { assertTransitionAllowed: async (t) => assertAiBomSignoffPossible(t) },
        });
        if (!started.ok) throw new CreateRefused(started.status, started.body);

        const [row] = await tx
          .insert(aiUseCases)
          .values({
            name: body.name,
            description: body.description,
            ownerUserId: userId,
            businessContext: body.businessContext,
            intendedAgentIds: body.intendedAgentIds,
            dataSensitivity: body.dataSensitivity,
            complianceTags: body.complianceTags,
            projectId: body.projectId ?? null,
            workflowInstanceId: started.instance.id,
            status: "proposed",
            // ADR-0168 amendment: kept for resubmission prefill — nothing else reads it
            ...(split ? { intakeAnswers: split.rest, screeningUnsure: split.unsure } : {}),
            ...(body.frameworkRationales ? { frameworkRationales: body.frameworkRationales } : {}),
            ...(discoveryFinding ? { discoveryFindingId: discoveryFinding.id } : {}),
          })
          .returning();
        await tx.insert(auditLog).values({
          userId,
          objectType: "ai_use_case",
          objectId: row!.id,
          detail: {
            phase: "proposed",
            name: body.name,
            dataSensitivity: body.dataSensitivity,
            complianceTags: body.complianceTags,
            projectId: body.projectId ?? null,
            workflowInstanceId: started.instance.id,
            ...(split?.unsure.length ? { screeningUnsure: split.unsure } : {}),
            ...(body.frameworkRationales ? { rationaleFrameworks: Object.keys(body.frameworkRationales) } : {}),
            ...(discoveryFinding ? { discoveryFindingId: discoveryFinding.id } : {}),
            ...(idemKey ? { idempotencyKey: true } : {}),
          },
          effect: "allow",
          ruleId: "use-case-proposed",
          ruleChain: [],
          reason: discoveryFinding
            ? `AI use case '${body.name}' proposed from shadow-AI finding ${discoveryFinding.id} — intake workflow started`
            : `AI use case '${body.name}' proposed — intake workflow started`,
        });
        if (discoveryFinding) {
          // the finding's own trail records it too, in the same transaction as the link
          await tx.insert(auditLog).values({
            userId,
            objectType: "shadow_ai_finding",
            objectId: discoveryFinding.id,
            detail: { useCaseId: row!.id, useCaseName: body.name, provider: discoveryFinding.provider, subject: discoveryFinding.subject },
            effect: "allow",
            ruleId: SHADOW_AI_RULE_IDS.findingUseCaseLinked,
            ruleChain: [],
            reason: `finding for ${discoveryFinding.provider} on ${discoveryFinding.subject} registered as AI use case '${body.name}' (${row!.id})`,
          });
        }
        // ADR-0189 R25 item 13: an intake that completed while it started
        // approves the proposal now, in this transaction, rather than leaving it
        // behind its instance. The snapshot it owes runs after commit.
        let bound = row!;
        let signoffWarning: { code: string; detail: string } | null = null;
        if (started.instance.status === "completed") {
          try {
            startSignoff = await syncUseCaseForInstance(tx, started.instance.id, userId);
          } catch (err) {
            // only a key lost after the start's lookahead: left behind, re-syncable
            if (!(err instanceof AiBomError)) throw err;
            signoffWarning = { code: err.code, detail: `${err.message} The intake completed, but this use case was not approved; an admin re-syncs it once a key is usable.` };
          }
          const [fresh] = await tx.select().from(aiUseCases).where(eq(aiUseCases.id, row!.id));
          if (fresh) bound = fresh;
        }
        const created = {
          ...createdBody(bound, started.instance),
          ...(signoffWarning ? { useCaseSignoffWarning: signoffWarning } : {}),
          // PR #357 review 5: an intake stage held at start says so
          ...(started.executorRefusal ? { executorRefusal: started.executorRefusal } : {}),
        };
        if (idemKey) {
          // ADR-0179 review item 3: the claim keeps a reference, not the body;
          // a replay rebuilds the same shape from the use case (useCaseReplayBody)
          await tx
            .update(useCaseIdempotencyKeys)
            .set({ useCaseId: row!.id, response: replayReference(row!.id) })
            .where(and(eq(useCaseIdempotencyKeys.userId, userId), eq(useCaseIdempotencyKeys.key, idemKey)));
        }
        return { kind: "created" as const, body: created };
      });
    } catch (err) {
      if (err instanceof CreateRefused) return reply.status(err.status).send(err.body);
      // a concurrent registration of the same finding committed first: the unique index refused this one
      if (discoveryFinding && isDiscoveryFindingConflict(err)) {
        const holder = await discoveryFindingHolder(db, discoveryFinding.id);
        if (holder) return reply.status(409).send(findingAlreadyRegistered(holder));
      }
      throw err;
    }
    if (outcome.kind === "replay") {
      if (!outcome.body) {
        // unreachable while the claim and its response commit together; said
        // plainly rather than creating a second use case
        return reply.status(409).send({
          error: "idempotency_key_in_flight",
          detail: "a request with this Idempotency-Key has not finished — retry shortly",
        });
      }
      return reply.status(200).header("Idempotent-Replay", "true").send(await useCaseReplayBody(db, outcome.body, caller));
    }
    // ADR-0189 R25: an intake that completed at start owes its approval's snapshot, after commit
    const aiBomSnapshotWarning = await runAiBomSignoffs(db, [startSignoff], req.log);
    return reply.status(201).send({ ...outcome.body, ...(aiBomSnapshotWarning ? { aiBomSnapshotWarning } : {}) });
  });

  // ADR-0219: the registry under the shared list contract. The registry's filters (search, status chip, tier,
  // owner) run on the server, and the headline and chip counts and the owner choices come with every page, across
  // the caller's whole scope (fleet for an admin, own use cases otherwise), so they never count the page on screen.
  const useCasesScope = (req: FastifyRequest): SQL | undefined | null => {
    if (req.authCtx.isAdmin) return undefined;
    if (!req.authCtx.userId) return null;
    return eq(aiUseCases.ownerUserId, req.authCtx.userId);
  };
  const useCasesReader: ListReader<UseCaseListRow> = {
    fetch: async (q) => {
      const { intakeAnswers: _answers, ...cols } = getTableColumns(aiUseCases);
      const rows = await db
        .select({ ...cols, ownerName: userNameSql(aiUseCases.ownerUserId), openConditions: UC_OPEN_CONDITIONS, _cursorAt: q.cursorAt })
        .from(aiUseCases)
        .where(q.where)
        .orderBy(...q.orderBy)
        .limit(q.limit)
        .offset(q.offset);
      const now = new Date();
      return rows.map((r) => ({
        ...r,
        openConditions: Number(r.openConditions),
        approvalExpired: approvalExpired(r as unknown as AiUseCaseRow, now),
        recertificationDueAt: recertificationDueAt(r),
      }));
    },
    countable: (where) => db.select({ one: sql`1` }).from(aiUseCases).where(where),
    idOf: (r) => r.id,
  };
  const useCasesSummary = async (scope: SQL | undefined) => {
    const IN_REVIEW = sql`${aiUseCases.status} in ('proposed', 'under_review', 'needs_info')`;
    const HIGH = sql`${aiUseCases.euAiActTier} in ('high', 'prohibited')`;
    const [[c], byStatus, owners] = await Promise.all([
      db
        .select({
          total: sql<number>`count(*)::int`,
          underReview: sql<number>`count(*) filter (where ${IN_REVIEW})::int`,
          approved: sql<number>`count(*) filter (where ${aiUseCases.status} = 'approved')::int`,
          highTier: sql<number>`count(*) filter (where ${HIGH})::int`,
          recertification: sql<number>`count(*) filter (where ${aiUseCases.recertification} and ${aiUseCases.status} = 'under_review')::int`,
        })
        .from(aiUseCases)
        .where(scope),
      db.select({ status: aiUseCases.status, n: sql<number>`count(*)::int` }).from(aiUseCases).where(scope).groupBy(aiUseCases.status),
      db
        .selectDistinct({ id: aiUseCases.ownerUserId, name: userNameSql(aiUseCases.ownerUserId) })
        .from(aiUseCases)
        .where(scope)
        .limit(UC_OWNER_CHOICES),
    ]);
    const statusCounts: Record<string, number> = { all: c?.total ?? 0, in_review: c?.underReview ?? 0, recertification: c?.recertification ?? 0 };
    for (const r of byStatus) statusCounts[r.status] = Number(r.n);
    return {
      headline: { total: c?.total ?? 0, underReview: c?.underReview ?? 0, approved: c?.approved ?? 0, highTier: c?.highTier ?? 0 },
      statusCounts,
      owners: owners.map((o) => ({ id: o.id, name: o.name ?? "Unnamed owner" })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  };
  app.get("/v1/use-cases/export.xlsx", async (req, reply) => {
    try {
      const q = req.query as Record<string, unknown>;
      const filters = useCasesFilterQuery.parse(filterParams(q));
      const ex = parseListExport(USE_CASES_LIST, q);
      const scope = useCasesScope(req);
      if (scope === null) return reply.status(403).send({ error: "bootstrap_has_no_use_cases" });
      await sendListExport(db, req, reply, USE_CASES_LIST, useCasesReader, useCasesWhere(scope, filters), ex, filters);
      return reply;
    } catch (e) {
      return sendListError(reply, e);
    }
  });

  // List: fleet for admins, own proposals for everyone else — the same
  // scoping shape as GET /v1/workflows/instances.
  app.get("/v1/use-cases", async (req, reply) => {
    if (wantsListContract(req.query)) {
      try {
        const q = req.query as Record<string, unknown>;
        const filters = useCasesFilterQuery.parse(filterParams(q));
        const page = parseListPage(USE_CASES_LIST, q);
        const scope = useCasesScope(req);
        if (scope === null) return reply.status(403).send({ error: "bootstrap_has_no_use_cases" });
        const [out, summary] = await Promise.all([
          runListPage(db, USE_CASES_LIST, useCasesReader, useCasesWhere(scope, filters), page),
          useCasesSummary(scope),
        ]);
        return { ...out, summary };
      } catch (e) {
        return sendListError(reply, e);
      }
    }
    const { status } = z
      .object({
        status: z.enum(["proposed", "under_review", "needs_info", "approved", "rejected", "retired"]).optional(),
      })
      .parse(req.query);
    const conditions = [];
    if (status) conditions.push(eq(aiUseCases.status, status));
    if (!req.authCtx.isAdmin) {
      if (!req.authCtx.userId) return reply.status(403).send({ error: "bootstrap_has_no_use_cases" });
      conditions.push(eq(aiUseCases.ownerUserId, req.authCtx.userId));
    }
    const rows = await db
      .select()
      .from(aiUseCases)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(aiUseCases.createdAt))
      .limit(200);
    const ownerIds = [...new Set(rows.map((r) => r.ownerUserId))];
    const ownerRows = ownerIds.length
      ? await db
          .select({ id: users.id, displayName: users.displayName, email: users.email })
          .from(users)
          .where(inArray(users.id, ownerIds))
      : [];
    const ownerName = new Map(ownerRows.map((u) => [u.id, u.displayName || u.email]));
    // ADR-0168: open conditions per row (before- and after-go-live alike)
    const openCounts = rows.length
      ? await db
          .select({ useCaseId: useCaseConditions.useCaseId, n: sql<number>`count(*)::int` })
          .from(useCaseConditions)
          .where(
            and(
              inArray(
                useCaseConditions.useCaseId,
                rows.map((r) => r.id),
              ),
              eq(useCaseConditions.status, "open"),
            ),
          )
          .groupBy(useCaseConditions.useCaseId)
      : [];
    const openConditions = new Map(openCounts.map((c) => [c.useCaseId, Number(c.n)]));
    const now = new Date();
    return {
      useCases: rows.map((r) => ({
        ...r,
        ownerName: ownerName.get(r.ownerUserId) ?? null,
        openConditions: openConditions.get(r.id) ?? 0,
        approvalExpired: approvalExpired(r, now),
        // ADR-0168 amendment: `recertification` rides the row; when it is due
        recertificationDueAt: recertificationDueAt(r),
      })),
    };
  });

  // Detail: the row, the linked instance's live state, the questionnaire
  // artifact (or the blank form), and the derived cascade-consequences card.
  app.get("/v1/use-cases/:useCaseId", async (req, reply) => {
    const { useCaseId } = useCaseIdParam.parse(req.params);
    const [row] = await db.select().from(aiUseCases).where(eq(aiUseCases.id, useCaseId));
    if (!row) return reply.status(404).send({ error: "not_found" });
    // ADR-0168: + the reviewer of its intake sign-off (read-only)
    if (!(await canReadUseCase(db, row, req.authCtx))) {
      return reply.status(403).send({
        error: "forbidden",
        detail: "a use case is visible to its owner and to admins",
      });
    }
    let instance: {
      id: string;
      status: string;
      currentStageId: string | null;
      stages: Array<{ id: string; type: string }>;
    } | null = null;
    let questionnaire: { version: number; content: string; createdAt: Date } | null = null;
    if (row.workflowInstanceId) {
      const [inst] = await db
        .select()
        .from(workflowInstances)
        .where(eq(workflowInstances.id, row.workflowInstanceId));
      if (inst) {
        const def = inst.definition as WorkflowDefinition;
        const state = inst.state as InstanceState;
        instance = {
          id: inst.id,
          status: inst.status,
          currentStageId: def.stages[state.currentStageIndex]?.id ?? null,
          stages: def.stages.map((s) => ({ id: s.id, type: s.type })),
        };
        const [artifact] = await db
          .select()
          .from(workflowArtifacts)
          .where(
            and(
              eq(workflowArtifacts.instanceId, inst.id),
              eq(workflowArtifacts.output, USE_CASE_QUESTIONNAIRE_OUTPUT),
            ),
          )
          .orderBy(desc(workflowArtifacts.version))
          .limit(1);
        if (artifact) {
          questionnaire = {
            version: artifact.version,
            content: artifact.content,
            createdAt: artifact.createdAt,
          };
        }
      }
    }
    const now = new Date();
    return {
      useCase: { ...row, approvalExpired: approvalExpired(row, now), recertificationDueAt: recertificationDueAt(row) },
      // issue #522 finding #30: where it was found. The finding's details are shown to admins only (the shadow-AI
      // inventory is admin-only); another reader sees that discovery found it, and the id, which opens nothing for them
      discovery: await discoveryViewFor(db, row, req.authCtx.isAdmin),
      // ADR-0171: the owner's per-framework "why it applies" (AER-052) and the
      // answers they were unsure about, counted as yes (AER-053) — for reviewers
      frameworkRationales: row.frameworkRationales ?? {},
      screeningUnsure: row.screeningUnsure ?? [],
      // ADR-0168: what the approval imposed — owner/met-by names resolved
      conditions: await conditionViewsFor(db, row, now, req.authCtx),
      // ADR-0168 amendment: the current round's required reviews ([] on the
      // single-approver path), the resubmission state, and the use case's
      // risks with any acceptance recorded on a sign-off
      reviews: await reviewsForInstance(db, row.workflowInstanceId),
      resubmission: await resubmissionFor(db, row, questionnaire, req.authCtx),
      risks: await riskViewsFor(db, row.id),
      instance,
      questionnaire,
      questionnaireTemplate: questionnaire ? null : USE_CASE_QUESTIONNAIRE_TEMPLATE,
      cascadeConsequences: await cascadeConsequencesFor(db, row),
      euAiActScreening: await euAiActScreeningFor(db, row, questionnaire?.content ?? null),
      intendedVsGranted: await intendedVsGrantedFor(db, row),
    };
  });

  // Edit-while-in-flight. `status` is refused BY NAME — approved/rejected
  // exist only as decisions of the linked instance on the one queue.
  app.patch("/v1/use-cases/:useCaseId", async (req, reply) => {
    const { useCaseId } = useCaseIdParam.parse(req.params);
    if (req.body && typeof req.body === "object" && "status" in (req.body as Record<string, unknown>)) {
      return reply.status(422).send({
        error: "status_is_decided_not_patched",
        detail:
          "a use case's status is set only by the linked intake instance's decision on " +
          "POST /v1/approvals/:approvalId/decide (or by the audited retire endpoint) — never by PATCH",
      });
    }
    // ADR-0085: the tier is COMPUTED, never accepted — same by-name refusal
    // discipline as `status`, pointing at the real input (the answers block)
    if (
      req.body &&
      typeof req.body === "object" &&
      ("euAiActTier" in (req.body as Record<string, unknown>) ||
        "euAiActReasons" in (req.body as Record<string, unknown>) ||
        "euAiActRulesetVersion" in (req.body as Record<string, unknown>))
    ) {
      return reply.status(422).send({
        error: "eu_tier_is_computed_not_patched",
        detail:
          "the EU AI Act tier is computed server-side by the frozen rule set from the " +
          `'${EU_AI_ACT_ANSWERS_FENCE}' answers block inside the questionnaire artifact — ` +
          "submit answers, never a tier",
      });
    }
    const body = updateUseCaseSchema.parse(req.body);
    const [row] = await db.select().from(aiUseCases).where(eq(aiUseCases.id, useCaseId));
    if (!row) return reply.status(404).send({ error: "not_found" });
    if (!req.authCtx.isAdmin && req.authCtx.userId !== row.ownerUserId) {
      return reply.status(403).send({
        error: "forbidden",
        detail: "a use case is editable by its owner and by admins",
      });
    }
    // ADR-0170 §4 — WHAT IS UNDER REVIEW CANNOT CHANGE UNDER THE REVIEWERS.
    // Every field is material (the description, context, intended agents and
    // project are what the reviewers are reading), so no PATCH lands while a
    // round is open — for the owner or an admin. The honest path is a send-back
    // for information, which opens a new round on the edited record.
    if (row.status === "under_review") {
      return reply.status(409).send({
        error: "locked_under_review",
        detail:
          "this use case is with its reviewers, so it can't be changed until a reviewer sends it back " +
          "for more information",
      });
    }
    // ADR-0168: a use case sent back for information is editable — that is
    // what the reviewer asked for.
    if (row.status !== "proposed" && row.status !== "needs_info") {
      // ADR-0089 amendment (batch B3) — INTENT IS DECIDED WITH THE USE CASE.
      // The intended-agents list is part of what the sign-off approved (the
      // ADR-0089 alignment comparison stands on it), so a post-decision
      // intent edit is refused BY NAME, ahead of the generic refusal:
      // changing intent after approval is a NEW use case, never an edit.
      if (body.intendedAgentIds !== undefined) {
        return reply.status(409).send({
          error: "intent_is_decided_not_patched",
          detail:
            `a ${row.status} use case's intended agents are part of what was decided — editing ` +
            "them would rewrite what the sign-off approved. Changing intent after a decision is " +
            "a NEW use case: propose one naming the new agents and take it through the same " +
            "intake sign-off",
        });
      }
      return reply.status(409).send({
        error: "use_case_not_editable",
        detail: `a ${row.status} use case is a decided record — editing it would change what was decided`,
      });
    }
    // ADR-0168 amendment — RESUBMISSION. Screening answers are accepted only
    // while the use case is sent back; the tier is COMPUTED from them here
    // (and again from the resubmitted questionnaire's answers block).
    if (body.screeningAnswers !== undefined && row.status !== "needs_info") {
      return reply.status(409).send({
        error: "screening_answers_only_when_returned",
        detail:
          `screening answers are edited by resubmitting a use case that was sent back for information; ` +
          `this one is ${row.status} — submit a new questionnaire version instead`,
      });
    }
    const unlisted = unlistedRationaleRefusal(body.frameworkRationales, row.complianceTags);
    if (unlisted) return reply.status(422).send(unlisted);
    if (body.projectId) {
      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, body.projectId));
      if (!project) return reply.status(400).send({ error: "invalid_reference", field: "projectId" });
    }
    if (body.intendedAgentIds && body.intendedAgentIds.length > 0) {
      const found = await db
        .select({ id: agents.id })
        .from(agents)
        .where(inArray(agents.id, body.intendedAgentIds));
      if (found.length !== new Set(body.intendedAgentIds).size) {
        return reply.status(400).send({ error: "invalid_reference", field: "intendedAgentIds" });
      }
    }
    // the EU keys screen; the whole set is stored (merged over what
    // registration stored); `dataCategories`, when given, re-derives the
    // data sensitivity by the wizard's own fail-closed rule
    let screening: ReturnType<typeof classifyEuAiActTier> | null = null;
    let intakeAnswers: Record<string, unknown> | null = null;
    let dataSensitivity: AiUseCaseRow["dataSensitivity"] | null = null;
    let screeningUnsure: string[] | null = null;
    if (body.screeningAnswers) {
      const a = body.screeningAnswers;
      // ADR-0171 / AER-053: the "Not sure" set REPLACES the stored one (omitted
      // = none) and is checked against the answers as they will be stored —
      // an omitted context answer keeps its stored value
      const { unsure: _unsure, ...answersOnly } = a;
      const merged = { ...(row.intakeAnswers ?? {}), ...answersOnly };
      delete (merged as Record<string, unknown>).unsure;
      const split = splitUnsure({ ...merged, unsure: a.unsure ?? [] });
      if (split.refusal) return reply.status(422).send(split.refusal);
      screeningUnsure = split.unsure;
      screening = classifyEuAiActTier({
        purposeDomain: a.purposeDomain,
        affectedPersons: a.affectedPersons,
        decisionAutonomy: a.decisionAutonomy,
        biometricUse: a.biometricUse,
        emotionRecognition: a.emotionRecognition,
        socialScoring: a.socialScoring,
        manipulativeTechniques: a.manipulativeTechniques,
        profilesNaturalPersons: a.profilesNaturalPersons,
        safetyComponent: a.safetyComponent,
        interactsWithHumans: a.interactsWithHumans,
        generatesSyntheticContent: a.generatesSyntheticContent,
      });
      intakeAnswers = merged;
      if (a.dataCategories !== undefined) dataSensitivity = deriveDataSensitivityFromCategories(a.dataCategories);
    }
    // X15-H01: a use case's intended agents are covered by its incidents' evidence holds, so changing them can
    // widen a hold — that write takes the hold lock exclusively, as its transaction's first lock
    let updatedRows: AiUseCaseRow[];
    try {
      updatedRows = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      if (body.intendedAgentIds !== undefined) await lockEvidenceHoldsExclusive(tx);
      // ADR-0189 R25 item 13 follow-up: once the intake workflow has COMPLETED, the
      // use case is what it approved, even while the mirror has not caught up (no
      // signing key when it completed). An edit now would be approved by the re-sync
      // as edited, so it is refused. Read under a share lock, so a completion in
      // flight is waited for and then seen.
      if (row.workflowInstanceId) {
        const [inst] = await tx
          .select({ status: workflowInstances.status })
          .from(workflowInstances)
          .where(eq(workflowInstances.id, row.workflowInstanceId))
          .for("share");
        if (inst?.status === "completed") {
          throw new CreateRefused(409, {
            error: "use_case_locked_instance_completed",
            detail:
              "this use case's intake workflow has completed, so the use case is what it approved and can't be edited. " +
              "If it is not shown as approved yet, an admin re-syncs it (POST /v1/use-cases/:useCaseId/resync); " +
              "a change after that is a new use case.",
          });
        }
      }
      const rows = await tx
          .update(aiUseCases)
          .set({
            ...(screening
              ? {
                  euAiActTier: screening.tier,
                  euAiActReasons: screening.reasons,
                  euAiActRulesetVersion: screening.rulesetVersion,
                }
              : {}),
            ...(intakeAnswers ? { intakeAnswers } : {}),
            ...(screeningUnsure ? { screeningUnsure } : {}),
            ...(body.frameworkRationales !== undefined ? { frameworkRationales: body.frameworkRationales } : {}),
            ...(dataSensitivity ? { dataSensitivity } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
            ...(body.businessContext !== undefined ? { businessContext: body.businessContext } : {}),
            ...(body.intendedAgentIds !== undefined ? { intendedAgentIds: body.intendedAgentIds } : {}),
            ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
            updatedAt: new Date(),
          })
          .where(eq(aiUseCases.id, useCaseId))
          .returning();
      // ADR-0189 R25 item 13 follow-up: the edit's audit row commits WITH the edit, so
      // its chain position (`seq`, commit order) says whether it came before or after
      // the instance's completion — what the re-sync's late-edit check compares
      await tx.insert(auditLog).values({
        userId: req.authCtx.userId ?? NO_IDENTITY,
        objectType: "ai_use_case",
        objectId: useCaseId,
        detail: { phase: "updated", fields: Object.keys(body) },
        effect: "allow",
        ruleId: "use-case-updated",
        ruleChain: [],
        reason: `AI use case '${row.name}' updated while ${row.status}`,
      });
      return rows;
      });
    } catch (err) {
      if (err instanceof CreateRefused) return reply.status(err.status).send(err.body);
      throw err;
    }
    const [updated] = updatedRows;
    if (screening) {
      await db.insert(auditLog).values({
        userId: req.authCtx.userId ?? NO_IDENTITY,
        objectType: "ai_use_case",
        objectId: useCaseId,
        detail: {
          phase: "eu-ai-act-screening",
          source: "resubmission",
          from: row.euAiActTier,
          tier: screening.tier,
          ...(dataSensitivity ? { dataSensitivityFrom: row.dataSensitivity, dataSensitivity } : {}),
          rulesetVersion: screening.rulesetVersion,
          firedRuleIds: screening.reasons.map((r) => r.ruleId),
        },
        effect: "allow",
        ruleId: "use-case-eu-tier",
        ruleChain: [],
        reason:
          `EU AI Act screening for '${row.name}' recomputed from resubmitted answers: ${screening.tier} ` +
          `(rule set v${screening.rulesetVersion}) — a screening result that informs the sign-off, not legal advice and not a block`,
      });
    }
    return updated;
  });

  // Retire: admin-only (default route class), reason required and audited.
  // The linked intake instance, if still live, is left to run out — a retired
  // use case never changes status again (syncUseCaseForInstance treats
  // retired as terminal).
  /**
   * THE FRAMEWORK MAPPING — "show me this use case against NIST AI RMF, with
   * evidence", answerable in ONE call and for ANY shipped framework.
   *
   * WHY THIS IS NOT PART OF THE EU-AI-ACT SCREENING ABOVE. That screening is a
   * SCREENING: a questionnaire, a tier, and a refusal reason, and all three are
   * specific to the Act. `euAiActScreeningFor` cites packs only as a
   * consequence of reaching a high/prohibited tier, filtered to
   * `framework = "eu-ai-act"` — so every other framework we ship was
   * unreachable from a use case, and NIST AI RMF (which has no tier concept at
   * all) could never appear. A mapping is a different question from a
   * screening and gets its own route rather than a widened screening that
   * would have to invent a tier for frameworks that do not have one.
   *
   * THE SEAM IS NAMED, NOT HIDDEN. Pack evaluation is scoped by PROJECT — that
   * is what the collectors' WHERE clauses are built from, and this route does
   * not change it. So the evidence counts describe **everything in the project
   * this use case is attributed to**, not this use case alone. That is stated
   * on the response, in `evidenceScope.note`, on every call. A use case with
   * no project is reported as `mapped, not evidenced` rather than being given
   * numbers from somewhere else.
   *
   * IT PERSISTS NOTHING. `POST /v1/compliance/packs/:id/evaluate` writes a
   * `compliance_pack_reports` row because that call IS the artifact. This is a
   * read, and a page-view that minted a report each time would fill the
   * evidence ledger with noise and make the real reports impossible to find.
   * The entitlement decision is the SAME `evaluateReportAccess` the report
   * route uses, so a preview can never show more than a report would.
   */
  app.get("/v1/use-cases/:useCaseId/frameworks", async (req, reply) => {
    const { useCaseId } = useCaseIdParam.parse(req.params);
    const q = z
      .object({
        /** one framework, or all active packs when omitted */
        framework: z.string().min(1).max(100).optional(),
        period: z.enum(REPORT_PERIODS).optional(),
      })
      .parse(req.query ?? {});

    const [useCase] = await db.select().from(aiUseCases).where(eq(aiUseCases.id, useCaseId));
    if (!useCase) return reply.status(404).send({ error: "not_found" });
    // the SAME visibility rule the detail route applies — a mapping must not
    // be a way to read a use case you cannot read
    if (!req.authCtx.isAdmin && req.authCtx.userId !== useCase.ownerUserId) {
      return reply.status(403).send({
        error: "forbidden",
        detail: "a use case is visible to its owner and to admins",
      });
    }

    const activePacks = await db
      .select()
      .from(compliancePacks)
      .where(
        q.framework
          ? and(eq(compliancePacks.status, "active"), eq(compliancePacks.framework, q.framework))
          : eq(compliancePacks.status, "active"),
      )
      .orderBy(compliancePacks.framework);

    const project = await projectSummaryFor(db, useCase);
    const now = new Date();
    const period = q.period ?? "current_month";
    const resolved = resolveReportPeriod(period, now);

    /**
     * The entitlement decision, taken ONCE against the use case's project and
     * reused for every pack. `null` here means "not evidenced" for an honest
     * reason, and the reason is carried through to the caller.
     */
    let projectIds: string[] | null = null;
    let evidenceKind: "project" | "no_project" | "not_entitled" = "no_project";
    let evidenceReason =
      "This use case is not attributed to a project, and pack evidence is collected per project, " +
      "so the controls below are mapped but not yet evidenced. Attributing it to a project is the " +
      "missing step, not a limitation of the framework.";

    if (useCase.projectId && project) {
      const scopeProjectIds = await resolveScopeProjectIds(db, {
        scopeKind: "project",
        scopeId: useCase.projectId,
      });
      const decision = evaluateReportAccess({
        isAdmin: req.authCtx.isAdmin,
        userId: req.authCtx.userId ?? null,
        definition: {
          kind: "compliance",
          scopeKind: "project",
          scopeId: useCase.projectId,
          entitlementScope: "project",
        },
        scopeProjectIds,
        callerProjectIds: await callerProjectIds(db, req.authCtx.userId ?? null),
        callerTeamIds: await callerTeamIds(db, req.authCtx.userId ?? null),
      });
      if (decision.allowed) {
        projectIds = decision.projectIds;
        evidenceKind = "project";
        evidenceReason =
          `Evidence is counted over the project '${project.name}' for ${resolved.label}, so it ` +
          "describes everything governed in that project, not this use case alone — a use case and " +
          "a project are not the same scope.";
      } else {
        evidenceKind = "not_entitled";
        evidenceReason = `Mapped but not evidenced: ${decision.reason}`;
      }
    }

    const frameworks = [];
    for (const pack of activePacks) {
      const controls = await db
        .select()
        .from(compliancePackControls)
        .where(eq(compliancePackControls.packId, pack.id))
        .orderBy(compliancePackControls.controlRef);

      const profiles = pack.cascadeTag ? await complianceProfilesForTags(db, [pack.cascadeTag]) : [];
      const scorecard =
        evidenceKind === "project"
          ? await evaluatePack(db, {
              pack,
              controls,
              projectIds,
              periodStart: resolved.start,
              periodEnd: resolved.end,
              period,
              periodLabel: resolved.label,
              scopeKind: "project",
              scopeId: useCase.projectId,
              now,
            })
          : null;

      frameworks.push({
        id: pack.id,
        framework: pack.framework,
        version: pack.version,
        title: pack.title,
        cascadeTag: pack.cascadeTag,
        /** does a §8.3 profile exist for this pack's tag in THIS org today? */
        profileExists: profiles.length > 0,
        carriedByUseCase:
          pack.cascadeTag !== null && useCase.complianceTags.includes(pack.cascadeTag),
        /** the pack's own control vocabulary, always — the MAPPING half */
        controls: controls.map((c) => ({
          controlRef: c.controlRef,
          title: c.title,
          coverage: c.coverage,
          attestationRequired: c.attestationRequired,
          /** the EVIDENCE half, present only when it was really computed */
          status: scorecard?.controls.find((a) => a.controlRef === c.controlRef)?.status ?? null,
          evidenceCount:
            scorecard?.controls.find((a) => a.controlRef === c.controlRef)?.evidenceCount ?? null,
        })),
        totals: scorecard?.totals ?? null,
        statement: scorecard?.statement ?? null,
      });
    }

    return {
      useCase: {
        id: useCase.id,
        name: useCase.name,
        status: useCase.status,
        complianceTags: useCase.complianceTags,
      },
      project,
      evidenceScope: {
        kind: evidenceKind,
        projectId: useCase.projectId,
        period,
        periodLabel: resolved.label,
        note: evidenceReason,
      },
      frameworks,
      /** the same clause every pack report carries — one sentence, one meaning */
      disclaimer: COMPLIANCE_PACK_DISCLAIMER,
    };
  });

  // ADR-0168 — mark an approval condition met. Met is final: a second call is
  // a 409. Audited `use-case-condition-met`. ADR-0170 §3: a before-go-live
  // condition is closed by someone other than the proposer, with a note
  // (`conditionCloseVerdict`); an after-go-live one by its owner, the use
  // case's owner, or an admin.
  app.post("/v1/use-cases/:useCaseId/conditions/:conditionId/met", async (req, reply) => {
    const { useCaseId, conditionId } = z
      .object({ useCaseId: z.string().uuid(), conditionId: z.string().uuid() })
      .parse(req.params);
    const body = markConditionMetSchema.parse(req.body ?? {});
    const note = body.note ? body.note : null; // whitespace-only trims to "" — no note
    const callerId = req.authCtx.userId ?? null;
    const [cond] = await db
      .select()
      .from(useCaseConditions)
      .where(and(eq(useCaseConditions.id, conditionId), eq(useCaseConditions.useCaseId, useCaseId)));
    if (!cond) return reply.status(404).send({ error: "not_found" });
    const [uc] = await db.select().from(aiUseCases).where(eq(aiUseCases.id, useCaseId));
    if (!uc) return reply.status(404).send({ error: "not_found" });
    const verdict = conditionCloseVerdict(cond, uc.ownerUserId, await conditionCloseContext(db, uc, req.authCtx));
    if (!verdict.allowed) {
      return reply.status(403).send({ error: verdict.error, detail: verdict.detail });
    }
    if (cond.status !== "open") {
      return reply.status(409).send({ error: "condition_not_open", status: cond.status });
    }
    // ADR-0180 A2: ONLY PASSING EVIDENCE CLOSES A MEASURED CONDITION. A metric,
    // test-class or autonomy-floor condition is never marked met by hand: while
    // its evidence does not pass, the refusal says so; when it does, the
    // evaluator (scheduled, or an admin's "evaluate now") closes it. The
    // refusal reads the STORED evaluation and measures nothing: a refusal is
    // never a way to make the gateway scan the ledgers on demand.
    if (cond.kind !== "manual") {
      const m = storedMeasurement(cond);
      if (!m || m.state !== "pass") {
        return reply.status(422).send({
          error: "condition_evidence_failing",
          kind: cond.kind,
          state: m?.state ?? "not_run",
          measurement: m,
          evaluatedAt: cond.lastEvaluatedAt ? cond.lastEvaluatedAt.toISOString() : null,
          detail:
            "a measured condition is closed only by passing evidence, and its last evaluation does not pass " +
            `(${m?.state.replace("_", " ") ?? "not run"}); it cannot be marked met by hand`,
        });
      }
      return reply.status(422).send({
        error: "condition_not_manual",
        kind: cond.kind,
        state: m.state,
        detail:
          "a measured condition is closed by the condition evaluator, not by hand; its evidence passes, so " +
          "an administrator can run Evaluate now, or the next scheduled evaluation closes it",
      });
    }
    if (verdict.noteRequired && !note) {
      return reply.status(422).send({
        error: "condition_note_required",
        detail: "say what was done to meet a before-go-live condition (1 to 2000 characters)",
      });
    }
    const metAt = new Date();
    const [updated] = await db
      .update(useCaseConditions)
      .set({ status: "met", metAt, metByUserId: callerId, note })
      .where(and(eq(useCaseConditions.id, cond.id), eq(useCaseConditions.status, "open")))
      .returning();
    if (!updated) return reply.status(409).send({ error: "condition_not_open" });
    await db.insert(auditLog).values({
      userId: callerId ?? NO_IDENTITY,
      objectType: "ai_use_case",
      objectId: uc.id,
      detail: {
        phase: "condition-met",
        conditionId: cond.id,
        approvalId: cond.approvalId,
        blocking: cond.blocking,
        dueAt: cond.dueAt.toISOString(),
        overdue: cond.dueAt.getTime() < metAt.getTime(),
      },
      effect: "allow",
      ruleId: "use-case-condition-met",
      ruleChain: [],
      reason:
        `condition on AI use case '${uc.name}' marked met` +
        `${cond.blocking ? " (before go-live — no longer blocks deployment)" : " (after go-live)"}: ${cond.text}`,
    });
    const names = await userNames(
      db,
      [updated.ownerUserId, updated.metByUserId].filter((x): x is string => !!x),
    );
    return conditionView(updated, names, metAt, false);
  });

  // -------------------------------------------------------------------------
  // ADR-0189 R25 item 13 follow-up — RE-SYNC a use case left behind its
  // completed instance. Admin-only through the default gate (deliberately not in
  // NON_ADMIN_ROUTES), checked here as well, and never the bootstrap credential
  // (it names no person, as on the workflow routes). It decides nothing new: the
  // workflow already approved. It re-runs the one mirror
  // (`syncUseCaseForInstance`, then the vendor mirror) with the full R25
  // sign-off semantics: no usable key under the strict default is refused 409
  // `bom_signing_unavailable` (503 `receipt_signing_key_invalid`), checked
  // before the step-up is spent, and nothing commits; the signed AI BOM
  // snapshot is taken after commit. The decision keeps its original approver,
  // and the approval's lifetime starts when it was decided. Idempotent: a use
  // case already in step with its instance is a 200 no-op.
  // -------------------------------------------------------------------------
  app.post("/v1/use-cases/:useCaseId/resync", async (req, reply) => {
    const { useCaseId } = useCaseIdParam.parse(req.params);
    if (!req.authCtx.isAdmin) {
      return reply.status(403).send({ error: "forbidden", detail: "only an admin can re-sync a use case with its workflow instance" });
    }
    // EVERY refusal from here on is on the record: one `use-case-resync-refused` row
    // with the refusal code, written on the root handle, so never inside a
    // transaction the refusal rolled back
    const context: { from?: string; workflowInstanceId?: string; instanceStatus?: string } = {};
    const auditRefusal = async (code: string, extra: Record<string, unknown> = {}) => {
      await db.insert(auditLog).values({
        userId: req.authCtx.userId ?? NO_IDENTITY,
        objectType: "ai_use_case",
        objectId: useCaseId,
        detail: { phase: "resync", ...context, code, ...extra },
        effect: "deny",
        ruleId: "use-case-resync-refused",
        ruleChain: [],
        reason: `AI use case ${useCaseId} was not re-synced with its intake workflow (${code})`,
      });
    };
    const refuse = async (status: number, body: Record<string, unknown>) => {
      await auditRefusal(String(body.error));
      return reply.status(status).send(body);
    };
    if (!req.authCtx.userId) {
      return refuse(403, {
        error: "bootstrap_cannot_drive",
        detail: "the bootstrap credential names no person, so it cannot apply an approval: sign in as an administrator and re-sync from there",
      });
    }
    const actorUserId = req.authCtx.userId;
    const [row] = await db.select().from(aiUseCases).where(eq(aiUseCases.id, useCaseId));
    // nothing to put on the record against: there is no such use case
    if (!row) return reply.status(404).send({ error: "not_found" });
    context.from = row.status;
    const instanceId = row.workflowInstanceId;
    const [instance] = instanceId
      ? await db.select({ status: workflowInstances.status }).from(workflowInstances).where(eq(workflowInstances.id, instanceId))
      : [];
    if (!instanceId || !instance) {
      return refuse(409, {
        error: "no_governing_instance",
        detail: "this use case has no intake workflow instance, so there is nothing to re-sync it with",
      });
    }
    context.workflowInstanceId = instanceId;
    context.instanceStatus = instance.status;
    const inStepBody = (status: string, instanceStatus: string) => ({
      useCaseId,
      workflowInstanceId: instanceId,
      instanceStatus,
      status,
      resynced: false,
    });
    const first = resyncVerdict(row.status, instance.status);
    if (first.kind === "in_step") return reply.send(inStepBody(row.status, instance.status));
    if (first.kind === "refuse") return refuse(409, first.body);
    // the decision must be establishable from the record: its completion, no edit
    // committed after it (defence in depth for edits made before PATCH refused
    // them), and the person who decided it
    const decision = await resyncDecision(db, instanceId, useCaseId);
    if (decision.kind === "refuse") return refuse(409, decision.body);
    // a missing key is refused BEFORE the step-up, so it never spends the admin's grant
    try {
      await assertAiBomSignoffPossible(db);
    } catch (err) {
      if (err instanceof AiBomError) await auditRefusal(err.code);
      throw err;
    }
    // the step-up an approval decision asks for: this applies an approval
    const su = await checkStepUp(db, req, {
      kind: "approval_decide",
      facts: { op: "use_case_resync", useCaseId, workflowInstanceId: instanceId },
    });
    if (!su.ok) {
      // the same codes every protected route answers with. A prompt the admin can answer (`step_up_required`
      // naming a method) is the first half of the action, not a refusal, so it is not recorded as one; a refusal
      // nobody here can answer (an API key or the bootstrap credential, no method enrolled) is, under its own code
      if (!isStepUpPrompt(su.body)) {
        await auditRefusal(String(su.body.error), typeof su.body.credential === "string" ? { credentialKind: su.body.credential } : {});
      }
      return reply.status(su.status).send(su.body);
    }
    type Out =
      | { kind: "in_step"; status: string; instanceStatus: string }
      | { kind: "refuse"; body: Record<string, unknown> }
      | { kind: "done"; from: string; to: string; signoff: AiBomSignoff | null; approvedUntil: Date | null; expired: boolean };
    let out: Out;
    try {
      out = await db.transaction(async (rawTx): Promise<Out> => {
        const tx = rawTx as unknown as Db;
        // LOCK ORDER: the instance first, then the use case — the order every
        // workflow transition takes (`applyEvent` locks the instance FOR UPDATE,
        // and the mirror then writes the use case). The opposite order deadlocks
        // against a questionnaire resubmission that re-opens the instance. FOR
        // UPDATE, not SHARE: the mirror's review routing (`ensureReviewRound`)
        // may write the instance, and a share lock upgraded mid-transaction is
        // the other deadlock. Holding the instance also stops a re-open
        // (AER-049) between the re-read below and the commit.
        const [lockedInstance] = await tx
          .select({ status: workflowInstances.status })
          .from(workflowInstances)
          .where(eq(workflowInstances.id, instanceId))
          .for("update");
        const [lockedCase] = await tx
          .select({ status: aiUseCases.status, euAiActTier: aiUseCases.euAiActTier })
          .from(aiUseCases)
          .where(eq(aiUseCases.id, useCaseId))
          .for("update");
        if (!lockedCase || !lockedInstance) return { kind: "refuse", body: { error: "not_found" } };
        const verdict = resyncVerdict(lockedCase.status, lockedInstance.status);
        if (verdict.kind === "in_step") return { kind: "in_step", status: lockedCase.status, instanceStatus: lockedInstance.status };
        if (verdict.kind === "refuse") return verdict;
        const settled = await resyncDecision(tx, instanceId, useCaseId);
        if (settled.kind === "refuse") return settled;
        const original = settled.original;
        const from = lockedCase.status;
        const signoff = await syncUseCaseForInstance(tx, instanceId, actorUserId, original);
        // THE TIER THE LIFETIME RESTS ON. The stored tier is the one screened when the
        // instance completed (the mirror that ran then recomputed it before its approval
        // was refused, and nothing re-screens a completed instance's use case since).
        // The mirror re-screens with the CURRENT rule set; if that changes the tier, the
        // lifetime would no longer be the one the decision carried, so the re-sync is
        // refused (rolled back) and the admin is told what would change.
        const [after] = await tx
          .select({
            status: aiUseCases.status,
            euAiActTier: aiUseCases.euAiActTier,
            approvedUntil: aiUseCases.approvedUntil,
            // the database clock, as every lifetime comparison (M-075)
            expired: sql<boolean>`coalesce(${aiUseCases.approvedUntil} <= now(), false)`,
          })
          .from(aiUseCases)
          .where(eq(aiUseCases.id, useCaseId));
        if ((after?.euAiActTier ?? null) !== (lockedCase.euAiActTier ?? null)) {
          throw new CreateRefused(409, {
            error: "eu_tier_changed_since_completion",
            detail:
              `re-screening under the current EU AI Act rule set moves this use case from tier ` +
              `'${lockedCase.euAiActTier ?? "unscreened"}' to '${after?.euAiActTier ?? "unscreened"}', which changes the ` +
              "approval's lifetime from the one its decision carried. It is not re-synced: take the use case through intake again so the new tier is reviewed.",
            tierAtCompletion: lockedCase.euAiActTier ?? null,
            tierNow: after?.euAiActTier ?? null,
          });
        }
        await syncVendorForInstance(tx, instanceId, actorUserId);
        const to = after?.status ?? from;
        if (to !== from) {
          await tx.insert(auditLog).values({
            userId: actorUserId,
            objectType: "ai_use_case",
            objectId: useCaseId,
            detail: {
              phase: "resync",
              from,
              to,
              workflowInstanceId: instanceId,
              instanceStatus: lockedInstance.status,
              resyncedBy: actorUserId,
              approvalId: original.approvalId,
              originalApprover: original.decidedBy,
              originalDecidedAt: original.decidedAt.toISOString(),
              via: req.authCtx.via,
            },
            effect: "allow",
            ruleId: "use-case-resynced",
            ruleChain: [],
            reason:
              `AI use case '${row.name}' re-synced by an admin with its completed intake workflow: ` +
              `${from.replace(/_/g, " ")} to ${to.replace(/_/g, " ")}; the decision keeps its original approver and time`,
          });
        }
        return { kind: "done", from, to, signoff, approvedUntil: after?.approvedUntil ?? null, expired: after?.expired === true };
      });
    } catch (err) {
      // the transaction has rolled back; the refusal is recorded after it
      if (err instanceof AiBomError) await auditRefusal(err.code);
      if (err instanceof CreateRefused) return refuse(err.status, err.body);
      throw err;
    }
    if (out.kind === "in_step") return reply.send(inStepBody(out.status, out.instanceStatus));
    if (out.kind === "refuse") return refuse(out.body.error === "not_found" ? 404 : 409, out.body);
    // R25 item 5: the snapshot is taken after commit
    const aiBomSnapshotWarning = await runAiBomSignoffs(db, [out.signoff], req.log);
    return reply.send({
      useCaseId,
      workflowInstanceId: instanceId,
      instanceStatus: "completed",
      from: out.from,
      status: out.to,
      resynced: out.to !== out.from,
      // the approval's lifetime runs from the original decision, so it can already be over
      approvedUntil: out.approvedUntil ? out.approvedUntil.toISOString() : null,
      approvalExpired: out.expired,
      ...(aiBomSnapshotWarning ? { aiBomSnapshotWarning } : {}),
    });
  });

  app.post("/v1/use-cases/:useCaseId/retire", async (req, reply) => {
    const { useCaseId } = useCaseIdParam.parse(req.params);
    const body = retireUseCaseSchema.parse(req.body);
    const [row] = await db.select().from(aiUseCases).where(eq(aiUseCases.id, useCaseId));
    if (!row) return reply.status(404).send({ error: "not_found" });
    if (row.status === "retired") return reply.status(409).send({ error: "already_retired" });
    const [updated] = await db
      .update(aiUseCases)
      .set({
        status: "retired",
        retiredReason: body.reason,
        retiredAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(aiUseCases.id, useCaseId))
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NO_IDENTITY,
      objectType: "ai_use_case",
      objectId: useCaseId,
      detail: { phase: "retired", from: row.status, reason: body.reason },
      effect: "allow",
      ruleId: "use-case-retired",
      ruleChain: [],
      reason: `AI use case '${row.name}' retired: ${body.reason}`,
    });
    return updated;
  });
}
