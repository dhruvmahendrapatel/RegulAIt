/**
 * ADR-0080 — THE AI USE-CASE REGISTRY, the L1 pre-build front-door
 * (docs/product/GAP_ANALYSIS_CREDO_AI_2026-08.md).
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
 * intent; it does not yet GATE dispatch (nothing refuses an agent call for
 * lacking an approved use case — named in ADR-0080 as the obvious next step).
 * And nothing auto-discovers use cases: every row here was proposed by a
 * person.
 */
import type { FastifyInstance } from "fastify";
import {
  agents,
  aiUseCases,
  and,
  auditLog,
  compliancePackControls,
  compliancePacks,
  desc,
  eq,
  inArray,
  projects,
  users,
  workflowArtifacts,
  workflowInstances,
  workflowTemplates,
  type AiUseCaseRow,
  type Db,
} from "@regulait/db";
import type { InstanceState, WorkflowDefinition } from "@regulait/workflow-kernel";
import {
  classifyEuAiActTier,
  createUseCaseSchema,
  extractEuAiActAnswers,
  retireUseCaseSchema,
  updateUseCaseSchema,
  EU_AI_ACT_ANSWERS_FENCE,
  EU_AI_ACT_RULESET_VERSION,
  EU_AI_ACT_SCREENING_DISCLAIMER,
  type EuAiActReason,
} from "@regulait/shared";
import { z } from "zod";
import { complianceProfilesForTags, effectiveCompliancePolicy } from "./projects.js";
import {
  createWorkflowTemplateValidated,
  startWorkflowInstanceWithTemplates,
} from "./workflows.js";
import {
  AI_USE_CASE_INTAKE_TEMPLATE_NAME,
  aiUseCaseIntakeDefinition,
} from "./template-gallery.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
const useCaseIdParam = z.object({ useCaseId: z.string().uuid() });

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
 * all three columns null ("not screened" — never a guessed tier), and a
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
 * Mirror the linked intake instance's status onto its use case. Called from
 * the ONE decide path (app.ts, inside the decision's transaction — this is
 * what makes "approval registers the use case" transactional with the
 * decision itself) and from the workflow driving routes via
 * `onInstanceTransition`. Decided and retired statuses are terminal here:
 * once a use case is approved, rejected, or retired, no instance movement
 * rewrites history — re-proposing is a new use case.
 */
export async function syncUseCaseForInstance(
  db: Db,
  instanceId: string | null,
  actorUserId: string | null,
): Promise<void> {
  if (!instanceId) return;
  const [useCase] = await db
    .select()
    .from(aiUseCases)
    .where(eq(aiUseCases.workflowInstanceId, instanceId));
  if (!useCase) return;
  if (useCase.status === "approved" || useCase.status === "rejected" || useCase.status === "retired") {
    return;
  }
  // ADR-0085: the screening rides the same sync — BEFORE the no-status-change
  // early return below, because a questionnaire re-submission (versioned
  // re-approval) changes the answers without changing the mapped status.
  await recomputeEuTierForUseCase(db, useCase, actorUserId);
  const [instance] = await db
    .select({ status: workflowInstances.status })
    .from(workflowInstances)
    .where(eq(workflowInstances.id, instanceId));
  if (!instance) return;
  const next = statusForInstance(instance.status);
  if (next === null || next === useCase.status) return;

  const decided = next === "approved" || next === "rejected";
  await db
    .update(aiUseCases)
    .set({
      status: next,
      updatedAt: new Date(),
      ...(decided ? { decidedAt: new Date() } : {}),
    })
    .where(eq(aiUseCases.id, useCase.id));
  await db.insert(auditLog).values({
    userId: actorUserId ?? useCase.ownerUserId,
    objectType: "ai_use_case",
    objectId: useCase.id,
    detail: {
      phase: "lifecycle",
      from: useCase.status,
      to: next,
      workflowInstanceId: instanceId,
      instanceStatus: instance.status,
    },
    effect: next === "rejected" ? "deny" : "allow",
    ruleId: `use-case-${next}`,
    ruleChain: [],
    reason: decided
      ? `AI use case '${useCase.name}' ${next} by the intake instance's terminal decision on the one approvals queue`
      : `AI use case '${useCase.name}' moved to ${next} — intake instance is ${instance.status}`,
  });
}

// ---------------------------------------------------------------------------
// The intake template resolution
// ---------------------------------------------------------------------------

/**
 * Newest ACTIVE template named `ai-use-case-intake` wins — an admin can route
 * use-case approvals to a governance owner by creating one from the gallery
 * shape with a concrete approver. Only when none exists is the built-in shape
 * minted, through the ONE template-creation path (ADR-0077 discipline).
 */
async function resolveIntakeTemplate(
  db: Db,
): Promise<{ ok: true; templateId: string } | { ok: false; status: number; body: Record<string, unknown> }> {
  const rows = await db
    .select()
    .from(workflowTemplates)
    .where(eq(workflowTemplates.name, AI_USE_CASE_INTAKE_TEMPLATE_NAME))
    .orderBy(desc(workflowTemplates.createdAt));
  const active = rows.find((t) => t.retiredAt === null);
  if (active) return { ok: true, templateId: active.id };
  const created = await createWorkflowTemplateValidated(db, {
    name: AI_USE_CASE_INTAKE_TEMPLATE_NAME,
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
  "a tier (approval itself gates nothing yet, per ADR-0080's honest limit), and the decide path " +
  "is unchanged";

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
  // Propose: creates the registry row AND starts its governing intake
  // instance through the one instance-creation path. Non-admin on purpose —
  // proposing a use case is the FRONT door, and the person walking through it
  // is not an admin.
  app.post("/v1/use-cases", async (req, reply) => {
    const body = createUseCaseSchema.parse(req.body);
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_propose" });

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

    const template = await resolveIntakeTemplate(db);
    if (!template.ok) return reply.status(template.status).send(template.body);

    // pillar-2 rails: the intake instance. It carries NO projectId — the
    // proposal governs itself; the named project is a reference the cascade
    // card reads, not an attribution target (ADR-0080 honest limits).
    const started = await startWorkflowInstanceWithTemplates(db, opts.dataKey, {
      templateIds: [template.templateId],
      initiatorUserId: userId,
      change: {
        description: `AI use-case intake: ${body.name}`,
        paths: [],
        changeType: "ai-use-case-intake",
        environment: "governance",
      },
    });
    if (!started.ok) return reply.status(started.status).send(started.body);

    const [row] = await db
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
      })
      .returning();
    await db.insert(auditLog).values({
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
      },
      effect: "allow",
      ruleId: "use-case-proposed",
      ruleChain: [],
      reason: `AI use case '${body.name}' proposed — intake instance ${started.instance.id} started on the pillar-2 rails`,
    });
    return reply.status(201).send({
      ...row,
      instance: started.instance,
      questionnaireTemplate: USE_CASE_QUESTIONNAIRE_TEMPLATE,
      note:
        "fill the questionnaire and submit it as the intake instance's " +
        `'${USE_CASE_QUESTIONNAIRE_OUTPUT}' artifact; the sign-off decision on the one approvals ` +
        "queue is what approves this use case",
    });
  });

  // List: fleet for admins, own proposals for everyone else — the same
  // scoping shape as GET /v1/workflows/instances.
  app.get("/v1/use-cases", async (req, reply) => {
    const { status } = z
      .object({ status: z.enum(["proposed", "under_review", "approved", "rejected", "retired"]).optional() })
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
    return {
      useCases: rows.map((r) => ({ ...r, ownerName: ownerName.get(r.ownerUserId) ?? null })),
    };
  });

  // Detail: the row, the linked instance's live state, the questionnaire
  // artifact (or the blank form), and the derived cascade-consequences card.
  app.get("/v1/use-cases/:useCaseId", async (req, reply) => {
    const { useCaseId } = useCaseIdParam.parse(req.params);
    const [row] = await db.select().from(aiUseCases).where(eq(aiUseCases.id, useCaseId));
    if (!row) return reply.status(404).send({ error: "not_found" });
    if (!req.authCtx.isAdmin && req.authCtx.userId !== row.ownerUserId) {
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
    return {
      useCase: row,
      instance,
      questionnaire,
      questionnaireTemplate: questionnaire ? null : USE_CASE_QUESTIONNAIRE_TEMPLATE,
      cascadeConsequences: await cascadeConsequencesFor(db, row),
      euAiActScreening: await euAiActScreeningFor(db, row, questionnaire?.content ?? null),
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
    if (row.status !== "proposed" && row.status !== "under_review") {
      return reply.status(409).send({
        error: "use_case_not_editable",
        detail: `a ${row.status} use case is a decided record — editing it would change what was decided`,
      });
    }
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
    const [updated] = await db
      .update(aiUseCases)
      .set({
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.businessContext !== undefined ? { businessContext: body.businessContext } : {}),
        ...(body.intendedAgentIds !== undefined ? { intendedAgentIds: body.intendedAgentIds } : {}),
        ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(aiUseCases.id, useCaseId))
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NO_IDENTITY,
      objectType: "ai_use_case",
      objectId: useCaseId,
      detail: { phase: "updated", fields: Object.keys(body) },
      effect: "allow",
      ruleId: "use-case-updated",
      ruleChain: [],
      reason: `AI use case '${row.name}' updated while ${row.status}`,
    });
    return updated;
  });

  // Retire: admin-only (default route class), reason required and audited.
  // The linked intake instance, if still live, is left to run out — a retired
  // use case never changes status again (syncUseCaseForInstance treats
  // retired as terminal).
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
