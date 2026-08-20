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
import { createUseCaseSchema, retireUseCaseSchema, updateUseCaseSchema } from "@regulait/shared";
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
`;

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
