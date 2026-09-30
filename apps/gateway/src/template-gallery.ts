/**
 * ADR-0077 — THE WORKFLOW-TEMPLATE GALLERY, MAPPED TO THE §8.3 CASCADE.
 *
 * The market analysis (docs/product/MARKET_ANALYSIS_2026-08.md §3) named the
 * compliance cascade the product's most defensible claim — and templates were
 * not discoverable by cascade profile. This module makes them so, under two
 * hard rules:
 *
 *  1. ANNOTATIONS ARE DERIVED, NEVER DUPLICATED. Which compliance profile
 *     demands which stage is computed live from the SAME sources the enforced
 *     cascade reads: `complianceProfilesForTags` (the ADR-0073 version funnel)
 *     composed by `effectiveCompliancePolicy` — i.e. exactly the
 *     `requiredTemplateIds` that `requiredTemplateIdsFor` unions into every
 *     instance started on a classified project. There is no stored/hardcoded
 *     annotation anywhere in this file; flip a profile and the gallery flips
 *     with it (template-gallery.test.ts proves this by flipping one).
 *
 *  2. CREATION GOES THROUGH THE ONE PATH. "Create from gallery" instantiates
 *     via `createWorkflowTemplateValidated` — the exact function behind
 *     `POST /v1/workflows/templates` — so kernel validation, approver
 *     resolution and nested-run-graph validation all apply. A gallery shape is
 *     a starting point, not a second creation path.
 *
 * The BUILT-IN shapes are code constants (no migration, nothing to drift): the
 * stage chains are inputs to the real `validateDefinition` at create time. The
 * COMPLIANCE-HEAVY shapes are not constants at all — one per profile that
 * requires templates, produced by the REAL `mergeDefinitions` over the standard
 * shape plus that profile's required templates, i.e. the same merge an
 * instance on a tagged project gets.
 */
import type { FastifyInstance } from "fastify";
import { auditLog, complianceProfiles, workflowTemplates, type Db } from "@regulait/db";
import {
  mergeDefinitions,
  MergeConflictError,
  type Stage,
  type WorkflowDefinition,
} from "@regulait/workflow-kernel";
import { createFromGallerySchema } from "@regulait/shared";
import { z } from "zod";
import { complianceProfilesForTags, effectiveCompliancePolicy } from "./projects.js";
import { createWorkflowTemplateValidated } from "./workflows.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

/** kernel-supported approver placeholder, resolved per instance to the
 * initiating user; "create from gallery" may substitute a concrete user id */
const APPROVER_PLACEHOLDER = "requesting_user";

export interface GalleryStageAnnotation {
  stageId: string;
  /** compliance profile tags whose cascade forces a stage with this id —
   * DERIVED live from the profiles' required templates, never stored */
  demandedByTags: string[];
}

export interface GalleryEntry {
  galleryId: string;
  title: string;
  description: string;
  source: "built_in" | "compliance_profile";
  /** set only for source 'compliance_profile' — the tag this shape serves */
  profileTag?: string;
  definition: WorkflowDefinition;
  stageAnnotations: GalleryStageAnnotation[];
}

export interface GalleryProfileSummary {
  tag: string;
  piiMode: import("./projects.js").PiiMode;
  auditRetentionDays: number | null;
  mcpDefaultMode: "read_only" | "read_write";
  requiredTemplates: Array<{ id: string; name: string; retired: boolean; stageIds: string[] }>;
  /** union of the required templates' stage ids — what the cascade forces into
   * every governed change on a project carrying this tag */
  forcedStageIds: string[];
}

/** ADR-0080 — the well-known name the use-case front-door resolves. An admin
 * who wants a concrete approver (instead of the requesting_user placeholder,
 * i.e. self-review-with-reason) creates a template UNDER THIS NAME from the
 * gallery entry below with `approverUserId` set; `POST /v1/use-cases` uses the
 * newest active template of this name and only mints the built-in shape when
 * none exists. */
export const AI_USE_CASE_INTAKE_TEMPLATE_NAME = "ai-use-case-intake";

/** The §2 core loop applied to the L1 front-door: intake → the ADR-0079
 * resting plan stage (where the use case is described and refined) → the
 * intake QUESTIONNAIRE as the artifact_generation output → human sign-off.
 * The questionnaire is a FORM the proposer fills — deliberately no AI
 * pre-fill (see ADR-0080: no model credential, no GAIA-equivalent). */
export function aiUseCaseIntakeDefinition(): WorkflowDefinition {
  return {
    workflow: AI_USE_CASE_INTAKE_TEMPLATE_NAME,
    stages: [
      { id: "intake", type: "trigger" },
      { id: "plan", type: "planning" },
      {
        id: "questionnaire",
        type: "artifact_generation",
        output: "use_case_questionnaire",
      },
      { id: "signoff", type: "human_approval", approvers: [APPROVER_PLACEHOLDER] },
    ],
  };
}

/** ADR-0084 — the well-known name the vendor front-door resolves, exactly the
 * ADR-0080 pattern above: the newest active template under this name wins
 * (so an admin can route vendor assessments to a named assessor), and only
 * when none exists is the built-in shape minted. */
export const VENDOR_AI_ASSESSMENT_TEMPLATE_NAME = "vendor-ai-assessment";

/** The §2 core loop applied to the L5 vendor portal: intake → the ADR-0079
 * resting plan stage (where the assessment is scoped) → the vendor
 * ASSESSMENT QUESTIONNAIRE as the artifact_generation output → human
 * sign-off. The questionnaire is an honest blank form the assessor fills
 * with VENDOR-SUPPLIED answers — labelled as attestations end to end
 * (ADR-0084), never pre-filled by any model. */
export function vendorAiAssessmentDefinition(): WorkflowDefinition {
  return {
    workflow: VENDOR_AI_ASSESSMENT_TEMPLATE_NAME,
    stages: [
      { id: "intake", type: "trigger" },
      { id: "plan", type: "planning" },
      {
        id: "questionnaire",
        type: "artifact_generation",
        output: "vendor_assessment_questionnaire",
      },
      { id: "signoff", type: "human_approval", approvers: [APPROVER_PLACEHOLDER] },
    ],
  };
}

function builtInShapes(): Array<
  Pick<GalleryEntry, "galleryId" | "title" | "description"> & { definition: WorkflowDefinition }
> {
  const standardStages: Stage[] = [
    { id: "intake", type: "trigger" },
    { id: "plan", type: "planning" },
    { id: "requirements", type: "artifact_generation", output: "requirements_file" },
    { id: "signoff", type: "human_approval", approvers: [APPROVER_PLACEHOLDER] },
  ];
  return [
    {
      galleryId: "standard-change",
      title: "Standard change",
      description:
        "Intake → forced plan → requirements artifact → human sign-off. The §2 core loop with nothing extra.",
      definition: { workflow: "standard-change", stages: standardStages },
    },
    {
      galleryId: "design-review",
      title: "Standard change + design review",
      description:
        "The standard chain with a separate design-review gate before the final sign-off — two humans, two decisions.",
      definition: {
        workflow: "design-review",
        stages: [
          ...standardStages.slice(0, 3),
          { id: "design-review", type: "human_approval", approvers: [APPROVER_PLACEHOLDER] },
          standardStages[3]!,
        ],
      },
    },
    {
      galleryId: "build-and-check",
      title: "Plan, build & check",
      description:
        "Standard change plus an automated build scoped to the signed-off requirements and a named-check stage.",
      definition: {
        workflow: "build-and-check",
        stages: [
          ...standardStages,
          { id: "build", type: "automated_build", scope: "requirements_file" },
          { id: "checks", type: "automated_check", checks: ["unit_tests", "lint"] },
        ],
      },
    },
    {
      galleryId: "ai-use-case-intake",
      title: "AI use-case intake",
      description:
        "The ADR-0080 pre-build front-door: propose an AI use case, refine it at the resting " +
        "plan stage, submit the intake questionnaire as the governed artifact, and a human " +
        "sign-off registers it as an approved use case. POST /v1/use-cases starts instances of " +
        "the newest active template named 'ai-use-case-intake' — create one from this shape with " +
        "a named approver to route use-case approvals to a governance owner.",
      definition: aiUseCaseIntakeDefinition(),
    },
    {
      galleryId: "vendor-ai-assessment",
      title: "Vendor AI assessment",
      description:
        "The ADR-0084 third-party front-door: propose an AI vendor, scope the assessment at " +
        "the resting plan stage, record the vendor's answers in the assessment questionnaire " +
        "as the governed artifact, and a human sign-off registers the vendor as assessed. " +
        "The answers are vendor attestations — recorded claims, never platform-verified " +
        "evidence. POST /v1/vendors starts instances of the newest active template named " +
        "'vendor-ai-assessment' — create one from this shape with a named approver to route " +
        "vendor assessments to a risk owner.",
      definition: vendorAiAssessmentDefinition(),
    },
    {
      galleryId: "hotfix",
      title: "Hotfix (fast path)",
      description:
        "No requirements artifact: plan, build, run checks, one sign-off. For changes where speed is the point and the checks are the gate.",
      definition: {
        workflow: "hotfix",
        stages: [
          { id: "intake", type: "trigger" },
          { id: "plan", type: "planning" },
          { id: "build", type: "automated_build" },
          { id: "checks", type: "automated_check", checks: ["unit_tests", "smoke"] },
          { id: "signoff", type: "human_approval", approvers: [APPROVER_PLACEHOLDER] },
        ],
      },
    },
  ];
}

/**
 * The whole gallery, derived fresh on every call: built-in shapes plus one
 * compliance-heavy shape per profile that requires templates, each stage
 * annotated with the tags whose cascade demands it.
 */
export async function buildTemplateGallery(
  db: Db,
): Promise<{ entries: GalleryEntry[]; profiles: GalleryProfileSummary[] }> {
  const tagRows = await db.select({ tag: complianceProfiles.tag }).from(complianceProfiles);
  const tags = tagRows.map((r) => r.tag);
  // THE funnel: resolved through config_versions (ADR-0073), so the gallery can
  // never disagree with what `requiredTemplateIdsFor` actually enforces.
  const resolved = tags.length ? await complianceProfilesForTags(db, tags) : [];
  const templateRows = await db.select().from(workflowTemplates);
  const templateById = new Map(templateRows.map((t) => [t.id, t]));

  const profiles: GalleryProfileSummary[] = resolved.map((p) => {
    const policy = effectiveCompliancePolicy([p]);
    const required = policy.requiredTemplateIds
      .map((id) => templateById.get(id))
      .filter((t): t is NonNullable<typeof t> => t !== undefined);
    const requiredTemplates = required.map((t) => ({
      id: t.id,
      name: t.name,
      retired: t.retiredAt !== null,
      stageIds: ((t.definition as WorkflowDefinition).stages ?? []).map((s) => s.id),
    }));
    return {
      tag: p.tag,
      piiMode: policy.piiMode,
      auditRetentionDays: policy.auditRetentionDays,
      mcpDefaultMode: policy.mcpDefaultMode,
      requiredTemplates,
      forcedStageIds: [...new Set(requiredTemplates.flatMap((t) => t.stageIds))],
    };
  });

  const demandedBy = (stageId: string): string[] =>
    profiles.filter((ps) => ps.forcedStageIds.includes(stageId)).map((ps) => ps.tag);
  const annotate = (def: WorkflowDefinition): GalleryStageAnnotation[] =>
    def.stages.map((s) => ({ stageId: s.id, demandedByTags: demandedBy(s.id) }));

  const entries: GalleryEntry[] = builtInShapes().map((shape) => ({
    ...shape,
    source: "built_in" as const,
    stageAnnotations: annotate(shape.definition),
  }));

  // one compliance-heavy shape per profile that actually requires templates —
  // built with the REAL merge, i.e. what an instance on a tagged project gets.
  const standardDef = entries[0]!.definition;
  for (const ps of profiles) {
    const requiredDefs = ps.requiredTemplates.map(
      (t) => templateById.get(t.id)!.definition as WorkflowDefinition,
    );
    if (requiredDefs.length === 0) continue;
    let definition: WorkflowDefinition;
    try {
      definition = mergeDefinitions([standardDef, ...requiredDefs]);
    } catch (err) {
      if (!(err instanceof MergeConflictError)) throw err;
      // a required template redefines a standard stage id — offer the cascade's
      // own stages alone rather than silently dropping the conflicting gate
      try {
        definition = mergeDefinitions(requiredDefs);
      } catch (err2) {
        if (!(err2 instanceof MergeConflictError)) throw err2;
        continue; // the profile's own templates conflict — nothing coherent to offer
      }
    }
    entries.push({
      galleryId: `compliance-${ps.tag}`,
      title: `Compliance-heavy: ${ps.tag}`,
      description:
        `The standard chain merged with every template the '${ps.tag}' profile requires — ` +
        `the exact flow the §8.3 cascade forces onto a project carrying this tag.`,
      source: "compliance_profile",
      profileTag: ps.tag,
      definition: { ...definition, workflow: `compliance-${ps.tag}` },
      stageAnnotations: annotate(definition),
    });
  }

  return { entries, profiles };
}

export function registerTemplateGalleryRoutes(app: FastifyInstance, db: Db): void {
  // admin-gated by the default route class (not in NON_ADMIN_ROUTES)
  app.get("/v1/workflows/template-gallery", async () => {
    const gallery = await buildTemplateGallery(db);
    return {
      ...gallery,
      note:
        "Stage annotations and compliance-heavy shapes are DERIVED live from the compliance " +
        "profiles' required templates (the same rules requiredTemplateIdsFor enforces) — " +
        "editing a profile changes this gallery on the next read.",
    };
  });

  app.post("/v1/workflows/template-gallery/:galleryId/create", async (req, reply) => {
    const { galleryId } = z.object({ galleryId: z.string().min(1).max(200) }).parse(req.params);
    const body = createFromGallerySchema.parse(req.body);
    const gallery = await buildTemplateGallery(db);
    const entry = gallery.entries.find((e) => e.galleryId === galleryId);
    if (!entry) return reply.status(404).send({ error: "unknown_gallery_entry" });

    // substitute the requesting_user placeholder with the named approver (if
    // any); resolution/validation happens in the ONE creation path below
    const definition: WorkflowDefinition = body.approverUserId
      ? {
          ...entry.definition,
          stages: entry.definition.stages.map((s) =>
            s.approvers
              ? {
                  ...s,
                  approvers: s.approvers.map((a) =>
                    a === APPROVER_PLACEHOLDER ? body.approverUserId! : a,
                  ),
                }
              : s,
          ),
        }
      : entry.definition;

    const result = await createWorkflowTemplateValidated(db, { name: body.name, definition });
    if (!result.ok) return reply.status(result.status).send(result.body);

    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NO_IDENTITY,
      objectType: "workflow_template",
      objectId: result.row.id,
      detail: {
        phase: "template-gallery-create",
        galleryId,
        name: body.name,
        source: entry.source,
        profileTag: entry.profileTag ?? null,
        cascadeDemandedStages: entry.stageAnnotations.filter((a) => a.demandedByTags.length > 0),
      },
      effect: "allow",
      ruleId: "workflow-template-gallery-created",
      ruleChain: [],
      reason:
        `workflow template '${body.name}' created from gallery shape '${galleryId}' — ` +
        `instantiated through the one template-creation path, so full validation applied`,
    });
    return reply.status(201).send({ ...result.row, galleryId });
  });
}
