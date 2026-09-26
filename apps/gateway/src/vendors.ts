/**
 * ADR-0084 — THE AI VENDOR REGISTRY, the L5 third-party front-door
 * (docs/product/GAP_ANALYSIS_CREDO_AI_2026-08.md).
 *
 * Credo's Vendor Portal collects AI-risk evidence from vendors and applies
 * policy packs to them. RegulAIt's vendor story was COST (ADR-0069/0076) —
 * this module ships the risk half, the honest way an enforcement-first
 * product can: a vendor becomes a governed object whose ASSESSMENT rides the
 * pillar-2 rails, and everything the vendor supplies is labelled an
 * ATTESTATION — a recorded claim with attribution — never blended with the
 * evidence this platform computes from its own ledgers.
 *
 * FOUR PROPERTIES THIS FILE EXISTS TO GUARANTEE
 *
 *  1. THE ASSESSMENT RUNS ON PILLAR-2 RAILS, NOT BESIDE THEM. `POST
 *     /v1/vendors` starts a REAL workflow instance of the
 *     `vendor-ai-assessment` template (gallery shape, ADR-0077) through
 *     `startWorkflowInstanceWithTemplates` — the exact ADR-0080 discipline.
 *     The plan stage rests (ADR-0079), the questionnaire is a versioned
 *     workflow artifact, and the sign-off rides the ONE approvals queue with
 *     every separation-of-duties guard the decide endpoint already applies.
 *
 *  2. STATUS IS DECIDED, NEVER PATCHED. `approved`/`rejected` are written
 *     ONLY by `syncVendorForInstance`, called from the decide path (app.ts,
 *     inside the decision's transaction) and from the workflow driving
 *     routes (via `WorkflowRouteOptions.onInstanceTransition`). A PATCH
 *     naming `status` is refused with a 422 that points at the decide path.
 *
 *  3. ATTESTED AND MEASURED NEVER BLEND. A vendor's answers to pack controls
 *     are recorded with full attribution (who recorded the claim, when, from
 *     which questionnaire version) into the vendor's OWN `packAttestations`
 *     column — deliberately NOT `compliance_pack_attestations` rows, because
 *     those are the org's own statements and feed the pack evaluator's
 *     `attested` status. Nothing in the pack scorecard/report/collector
 *     machinery reads a vendor attestation; the checklist here reuses the
 *     pack DATA MODEL read-only and rides the
 *     `AI_VENDOR_ATTESTATION_DISCLAIMER` on its face.
 *
 *  4. AN APPROVAL APPROVES THE ASSESSMENT, NOT THE VENDOR'S CLAIMS. The
 *     sign-off records that a human reviewed the vendor-supplied answers and
 *     accepted the third-party relationship — the API says so wherever an
 *     approved status is rendered.
 *
 * WHAT THIS FILE DOES NOT DO — stated because a governance product that
 * overstates itself is worse than one that ships less: there is NO
 * vendor-facing portal — no external auth surface exists; a platform user
 * records what the vendor supplied. Nothing auto-creates vendors — L4's
 * classifier findings may NAME a vendor, but every row here was proposed by
 * a person. And there is no SLA/renewal scheduler: re-assessment cadence is
 * the customer's own process.
 */
import type { FastifyInstance } from "fastify";
import {
  aiVendors,
  and,
  auditLog,
  compliancePackControls,
  compliancePacks,
  customModelProviders,
  desc,
  eq,
  inArray,
  users,
  workflowArtifacts,
  workflowInstances,
  workflowTemplates,
  type AiVendorPackAttestation,
  type AiVendorRow,
  type Db,
} from "@regulait/db";
import type { InstanceState, WorkflowDefinition } from "@regulait/workflow-kernel";
import {
  AI_VENDOR_ATTESTATION_DISCLAIMER,
  createVendorSchema,
  recordVendorAttestationSchema,
  retireVendorSchema,
  updateVendorSchema,
} from "@regulait/shared";
import { z } from "zod";
import {
  createWorkflowTemplateValidated,
  startWorkflowInstanceWithTemplates,
} from "./workflows.js";
import {
  VENDOR_AI_ASSESSMENT_TEMPLATE_NAME,
  vendorAiAssessmentDefinition,
} from "./template-gallery.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
const vendorIdParam = z.object({ vendorId: z.string().uuid() });

/** the artifact_generation output name the assessment template declares */
export const VENDOR_QUESTIONNAIRE_OUTPUT = "vendor_assessment_questionnaire";

/**
 * The assessment questionnaire — an honest BLANK form the assessor fills
 * with VENDOR-SUPPLIED answers. Nothing is pre-filled by a model, and the
 * form says on its face that every answer is the vendor's claim.
 */
export const VENDOR_QUESTIONNAIRE_TEMPLATE = `# Vendor AI assessment questionnaire

> Fill every section with the VENDOR'S OWN ANSWERS, then submit this document
> as the assessment instance's \`${VENDOR_QUESTIONNAIRE_OUTPUT}\` artifact. It
> becomes the versioned record the sign-off decision is made on. Everything
> below is a vendor attestation — a claim the vendor supplied — not something
> this platform measured or verified. Nothing is pre-filled by a model.

## 1. What AI the vendor runs
Which models/AI systems does the vendor operate or embed, and for what
function? Include whether our usage trains or fine-tunes anything.

## 2. Data shared with the vendor
What of our data reaches the vendor (categories: PII, PHI, payment,
proprietary), through which channel, and what is retained for how long?

## 3. Subprocessors
Which subprocessors (including model providers) does the vendor use for the
AI in scope, and where do they process?

## 4. Certifications and audits claimed
Which certifications/attestations does the vendor claim (e.g. SOC 2, ISO
27001), with report dates and scope? These are claims to record — request the
reports; recording a claim here verifies nothing.

## 5. Security and incident contacts
Who is the vendor's security contact, what is their incident-notification
commitment, and how are we notified?

## 6. Our exit and controls
Can we disable the AI features, restrict data flows, or export/delete our
data? What contractual controls (DPA, AI addendum) exist?
`;

// ---------------------------------------------------------------------------
// The lifecycle join: instance status -> vendor status (ADR-0080's pattern)
// ---------------------------------------------------------------------------

function statusForInstance(instanceStatus: string): AiVendorRow["status"] | null {
  switch (instanceStatus) {
    case "completed":
      return "approved";
    case "denied":
    case "aborted":
      return "rejected";
    case "blocked_on_approval":
      return "under_assessment";
    case "running":
    case "blocked_on_plan":
    case "blocked_on_artifact":
      return "proposed";
    default:
      // a status this mapping does not know can only come from a customized
      // assessment template — leave the vendor where it is rather than guess
      return null;
  }
}

/**
 * Mirror the linked assessment instance's status onto its vendor. Called from
 * the ONE decide path (app.ts, inside the decision's transaction) and from
 * the workflow driving routes via `onInstanceTransition` — exactly
 * `syncUseCaseForInstance`. Decided and retired statuses are terminal here:
 * once a vendor is approved, rejected, or retired, no instance movement
 * rewrites history — re-assessing is a new proposal.
 */
export async function syncVendorForInstance(
  db: Db,
  instanceId: string | null,
  actorUserId: string | null,
): Promise<void> {
  if (!instanceId) return;
  // ADR-0109 (migration 0108): `ai_vendors_instance_uq` — the
  // `syncUseCaseForInstance` argument, verbatim.
  const [vendor] = await db
    .select()
    .from(aiVendors)
    .where(eq(aiVendors.workflowInstanceId, instanceId));
  if (!vendor) return;
  if (vendor.status === "approved" || vendor.status === "rejected" || vendor.status === "retired") {
    return;
  }
  const [instance] = await db
    .select({ status: workflowInstances.status })
    .from(workflowInstances)
    .where(eq(workflowInstances.id, instanceId));
  if (!instance) return;
  const next = statusForInstance(instance.status);
  if (next === null || next === vendor.status) return;

  const decided = next === "approved" || next === "rejected";
  await db
    .update(aiVendors)
    .set({
      status: next,
      updatedAt: new Date(),
      ...(decided ? { decidedAt: new Date() } : {}),
    })
    .where(eq(aiVendors.id, vendor.id));
  await db.insert(auditLog).values({
    userId: actorUserId ?? vendor.ownerUserId,
    objectType: "ai_vendor",
    objectId: vendor.id,
    detail: {
      phase: "lifecycle",
      from: vendor.status,
      to: next,
      workflowInstanceId: instanceId,
      instanceStatus: instance.status,
    },
    effect: next === "rejected" ? "deny" : "allow",
    ruleId: `vendor-${next}`,
    ruleChain: [],
    reason: decided
      ? `AI vendor '${vendor.name}' ${next} by the assessment instance's terminal decision on ` +
        `the one approvals queue — a sign-off on the vendor's attested answers, not a ` +
        `verification of them`
      : `AI vendor '${vendor.name}' moved to ${next} — assessment instance is ${instance.status}`,
  });
}

// ---------------------------------------------------------------------------
// The assessment template resolution — the ADR-0080 find-or-create pattern
// ---------------------------------------------------------------------------

async function resolveAssessmentTemplate(
  db: Db,
): Promise<{ ok: true; templateId: string } | { ok: false; status: number; body: Record<string, unknown> }> {
  const rows = await db
    .select()
    .from(workflowTemplates)
    .where(eq(workflowTemplates.name, VENDOR_AI_ASSESSMENT_TEMPLATE_NAME))
    .orderBy(desc(workflowTemplates.createdAt));
  const active = rows.find((t) => t.retiredAt === null);
  if (active) return { ok: true, templateId: active.id };
  const created = await createWorkflowTemplateValidated(db, {
    name: VENDOR_AI_ASSESSMENT_TEMPLATE_NAME,
    definition: vendorAiAssessmentDefinition(),
  });
  if (!created.ok) return created;
  return { ok: true, templateId: created.row.id };
}

// ---------------------------------------------------------------------------
// The attested checklist — the pack DATA MODEL reused read-only, the
// answers labelled as claims, and NOTHING feeding back into pack machinery
// ---------------------------------------------------------------------------

async function packChecklistFor(db: Db, vendor: AiVendorRow, framework: string) {
  const [pack] = await db
    .select()
    .from(compliancePacks)
    .where(and(eq(compliancePacks.framework, framework), eq(compliancePacks.status, "active")));
  if (!pack) {
    return {
      framework,
      pack: null,
      controls: [],
      note:
        `no active compliance pack exists for framework '${framework}' — activate one to ` +
        "render its control checklist here",
      disclaimer: AI_VENDOR_ATTESTATION_DISCLAIMER,
    };
  }
  const controls = await db
    .select()
    .from(compliancePackControls)
    .where(eq(compliancePackControls.packId, pack.id))
    .orderBy(compliancePackControls.controlRef);
  // newest attestation per controlRef for this framework
  const byControl = new Map<string, AiVendorPackAttestation>();
  for (const a of vendor.packAttestations) {
    if (a.framework !== framework) continue;
    const existing = byControl.get(a.controlRef);
    if (!existing || a.recordedAt > existing.recordedAt) byControl.set(a.controlRef, a);
  }
  return {
    framework,
    pack: { id: pack.id, version: pack.version, title: pack.title },
    controls: controls.map((c) => ({
      controlRef: c.controlRef,
      title: c.title,
      /** the mapping author's posture for the ORG's own scorecard — shown for
       * context only; it says nothing about this vendor */
      coverage: c.coverage,
      vendorAttestation: byControl.get(c.controlRef) ?? null,
    })),
    note:
      "the control list is the ADR-0058 pack data model read read-only; each vendor answer is " +
      "an ATTESTATION with attribution — a recorded claim, never computed or enforced " +
      "evidence, and never an input to any pack scorecard or report",
    disclaimer: AI_VENDOR_ATTESTATION_DISCLAIMER,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface VendorRouteOptions {
  dataKey?: string;
}

export function registerVendorRoutes(
  app: FastifyInstance,
  db: Db,
  opts: VendorRouteOptions = {},
): void {
  // Propose: creates the registry row AND starts its governing assessment
  // instance through the one instance-creation path. Non-admin on purpose —
  // naming a vendor is the front door.
  app.post("/v1/vendors", async (req, reply) => {
    const body = createVendorSchema.parse(req.body);
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_propose" });

    if (body.linkedCustomProviderIds.length > 0) {
      const found = await db
        .select({ id: customModelProviders.id })
        .from(customModelProviders)
        .where(inArray(customModelProviders.id, body.linkedCustomProviderIds));
      if (found.length !== new Set(body.linkedCustomProviderIds).size) {
        return reply
          .status(400)
          .send({ error: "invalid_reference", field: "linkedCustomProviderIds" });
      }
    }

    const template = await resolveAssessmentTemplate(db);
    if (!template.ok) return reply.status(template.status).send(template.body);

    const started = await startWorkflowInstanceWithTemplates(db, opts.dataKey, {
      templateIds: [template.templateId],
      initiatorUserId: userId,
      change: {
        description: `Vendor AI assessment: ${body.name}`,
        paths: [],
        changeType: "vendor-ai-assessment",
        environment: "governance",
      },
    });
    if (!started.ok) return reply.status(started.status).send(started.body);

    const [row] = await db
      .insert(aiVendors)
      .values({
        name: body.name,
        description: body.description,
        category: body.category,
        ownerUserId: userId,
        linkedCustomProviderIds: body.linkedCustomProviderIds,
        linkedAgentProviders: body.linkedAgentProviders,
        workflowInstanceId: started.instance.id,
        status: "proposed",
      })
      .returning();
    await db.insert(auditLog).values({
      userId,
      objectType: "ai_vendor",
      objectId: row!.id,
      detail: {
        phase: "proposed",
        name: body.name,
        category: body.category,
        linkedCustomProviderIds: body.linkedCustomProviderIds,
        linkedAgentProviders: body.linkedAgentProviders,
        workflowInstanceId: started.instance.id,
      },
      effect: "allow",
      ruleId: "vendor-proposed",
      ruleChain: [],
      reason: `AI vendor '${body.name}' proposed — assessment instance ${started.instance.id} started on the pillar-2 rails`,
    });
    return reply.status(201).send({
      ...row,
      instance: started.instance,
      questionnaireTemplate: VENDOR_QUESTIONNAIRE_TEMPLATE,
      note:
        "record the vendor's answers in the questionnaire and submit it as the assessment " +
        `instance's '${VENDOR_QUESTIONNAIRE_OUTPUT}' artifact; the sign-off decision on the one ` +
        "approvals queue is what approves this vendor's assessment — the answers stay vendor " +
        "attestations either way",
    });
  });

  // List: fleet for admins, own proposals for everyone else — the exact
  // GET /v1/use-cases scoping shape.
  app.get("/v1/vendors", async (req, reply) => {
    const { status } = z
      .object({
        status: z
          .enum(["proposed", "under_assessment", "approved", "rejected", "retired"])
          .optional(),
      })
      .parse(req.query);
    const conditions = [];
    if (status) conditions.push(eq(aiVendors.status, status));
    if (!req.authCtx.isAdmin) {
      if (!req.authCtx.userId) return reply.status(403).send({ error: "bootstrap_has_no_vendors" });
      conditions.push(eq(aiVendors.ownerUserId, req.authCtx.userId));
    }
    const rows = await db
      .select()
      .from(aiVendors)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(aiVendors.createdAt))
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
      vendors: rows.map((r) => ({ ...r, ownerName: ownerName.get(r.ownerUserId) ?? null })),
      disclaimer: AI_VENDOR_ATTESTATION_DISCLAIMER,
    };
  });

  // Detail: the row, the linked instance's live state, the questionnaire
  // artifact (or the blank form), the recorded attestations — and, when
  // ?framework= names one, the attested checklist over that framework's
  // ACTIVE pack (the pack data model read-only).
  app.get("/v1/vendors/:vendorId", async (req, reply) => {
    const { vendorId } = vendorIdParam.parse(req.params);
    const { framework } = z
      .object({ framework: z.string().min(1).max(64).optional() })
      .parse(req.query);
    const [row] = await db.select().from(aiVendors).where(eq(aiVendors.id, vendorId));
    if (!row) return reply.status(404).send({ error: "not_found" });
    if (!req.authCtx.isAdmin && req.authCtx.userId !== row.ownerUserId) {
      return reply.status(403).send({
        error: "forbidden",
        detail: "a vendor is visible to its owner and to admins",
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
              eq(workflowArtifacts.output, VENDOR_QUESTIONNAIRE_OUTPUT),
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
      vendor: row,
      instance,
      questionnaire,
      questionnaireTemplate: questionnaire ? null : VENDOR_QUESTIONNAIRE_TEMPLATE,
      attestations: row.packAttestations,
      packChecklist: framework ? await packChecklistFor(db, row, framework) : null,
      disclaimer: AI_VENDOR_ATTESTATION_DISCLAIMER,
    };
  });

  // Edit-while-in-flight. `status` is refused BY NAME — approved/rejected
  // exist only as decisions of the linked instance on the one queue.
  app.patch("/v1/vendors/:vendorId", async (req, reply) => {
    const { vendorId } = vendorIdParam.parse(req.params);
    if (req.body && typeof req.body === "object" && "status" in (req.body as Record<string, unknown>)) {
      return reply.status(422).send({
        error: "status_is_decided_not_patched",
        detail:
          "a vendor's status is set only by the linked assessment instance's decision on " +
          "POST /v1/approvals/:approvalId/decide (or by the audited retire endpoint) — never by PATCH",
      });
    }
    if (req.body && typeof req.body === "object" && "packAttestations" in (req.body as Record<string, unknown>)) {
      return reply.status(422).send({
        error: "attestations_are_recorded_not_patched",
        detail:
          "vendor attestations carry attribution (who recorded the claim, when, from which " +
          "questionnaire version) and are appended only through " +
          "POST /v1/vendors/:vendorId/attestations — never by PATCH",
      });
    }
    const body = updateVendorSchema.parse(req.body);
    const [row] = await db.select().from(aiVendors).where(eq(aiVendors.id, vendorId));
    if (!row) return reply.status(404).send({ error: "not_found" });
    if (!req.authCtx.isAdmin && req.authCtx.userId !== row.ownerUserId) {
      return reply.status(403).send({
        error: "forbidden",
        detail: "a vendor is editable by its owner and by admins",
      });
    }
    if (row.status !== "proposed" && row.status !== "under_assessment") {
      return reply.status(409).send({
        error: "vendor_not_editable",
        detail: `a ${row.status} vendor is a decided record — editing it would change what was decided`,
      });
    }
    if (body.linkedCustomProviderIds && body.linkedCustomProviderIds.length > 0) {
      const found = await db
        .select({ id: customModelProviders.id })
        .from(customModelProviders)
        .where(inArray(customModelProviders.id, body.linkedCustomProviderIds));
      if (found.length !== new Set(body.linkedCustomProviderIds).size) {
        return reply
          .status(400)
          .send({ error: "invalid_reference", field: "linkedCustomProviderIds" });
      }
    }
    const [updated] = await db
      .update(aiVendors)
      .set({
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.category !== undefined ? { category: body.category } : {}),
        ...(body.linkedCustomProviderIds !== undefined
          ? { linkedCustomProviderIds: body.linkedCustomProviderIds }
          : {}),
        ...(body.linkedAgentProviders !== undefined
          ? { linkedAgentProviders: body.linkedAgentProviders }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(aiVendors.id, vendorId))
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NO_IDENTITY,
      objectType: "ai_vendor",
      objectId: vendorId,
      detail: { phase: "updated", fields: Object.keys(body) },
      effect: "allow",
      ruleId: "vendor-updated",
      ruleChain: [],
      reason: `AI vendor '${row.name}' updated while ${row.status}`,
    });
    return updated;
  });

  // Record ONE vendor-supplied answer against one pack control — the audited
  // act that makes "attested with attribution" a property of every row:
  // the recorder must be a named user, the control must exist in the
  // framework's ACTIVE pack, and the questionnaire artifact must already be
  // submitted (the attribution names the version the answer came from).
  app.post("/v1/vendors/:vendorId/attestations", async (req, reply) => {
    const { vendorId } = vendorIdParam.parse(req.params);
    const body = recordVendorAttestationSchema.parse(req.body);
    const userId = req.authCtx.userId;
    if (!userId) {
      return reply.status(403).send({
        error: "attribution_requires_identity",
        detail:
          "a vendor attestation is a recorded claim attributed to the user who recorded it — " +
          "the bootstrap token has no identity to attribute",
      });
    }
    const [row] = await db.select().from(aiVendors).where(eq(aiVendors.id, vendorId));
    if (!row) return reply.status(404).send({ error: "not_found" });
    if (!req.authCtx.isAdmin && userId !== row.ownerUserId) {
      return reply.status(403).send({
        error: "forbidden",
        detail: "vendor attestations are recorded by the vendor's owner or by admins",
      });
    }
    if (row.status === "retired") {
      return reply.status(409).send({
        error: "vendor_retired",
        detail: "a retired vendor's record is closed — re-assessing is a new proposal",
      });
    }
    const [pack] = await db
      .select()
      .from(compliancePacks)
      .where(
        and(eq(compliancePacks.framework, body.framework), eq(compliancePacks.status, "active")),
      );
    if (!pack) {
      return reply.status(409).send({
        error: "no_active_pack_for_framework",
        detail: `no active compliance pack exists for framework '${body.framework}'`,
      });
    }
    const [control] = await db
      .select()
      .from(compliancePackControls)
      .where(
        and(
          eq(compliancePackControls.packId, pack.id),
          eq(compliancePackControls.controlRef, body.controlRef),
        ),
      );
    if (!control) {
      return reply.status(400).send({
        error: "unknown_control_ref",
        detail: `framework '${body.framework}' (pack v${pack.version}) has no control '${body.controlRef}'`,
      });
    }
    // the questionnaire is the SOURCE the attribution names — nothing is
    // recorded before it exists
    let questionnaireVersion: number | null = null;
    if (row.workflowInstanceId) {
      const [artifact] = await db
        .select({ version: workflowArtifacts.version })
        .from(workflowArtifacts)
        .where(
          and(
            eq(workflowArtifacts.instanceId, row.workflowInstanceId),
            eq(workflowArtifacts.output, VENDOR_QUESTIONNAIRE_OUTPUT),
          ),
        )
        .orderBy(desc(workflowArtifacts.version))
        .limit(1);
      questionnaireVersion = artifact?.version ?? null;
    }
    if (questionnaireVersion === null) {
      return reply.status(409).send({
        error: "questionnaire_not_submitted",
        detail:
          "vendor attestations are recorded FROM the assessment questionnaire — submit the " +
          `'${VENDOR_QUESTIONNAIRE_OUTPUT}' artifact on the assessment instance first`,
      });
    }
    const attestation: AiVendorPackAttestation = {
      framework: body.framework,
      packId: pack.id,
      packVersion: pack.version,
      controlRef: body.controlRef,
      statement: body.statement,
      evidenceRef: body.evidenceRef ?? null,
      recordedByUserId: userId,
      recordedAt: new Date().toISOString(),
      questionnaireVersion,
    };
    const [updated] = await db
      .update(aiVendors)
      .set({
        packAttestations: [...row.packAttestations, attestation],
        updatedAt: new Date(),
      })
      .where(eq(aiVendors.id, vendorId))
      .returning();
    await db.insert(auditLog).values({
      userId,
      objectType: "ai_vendor",
      objectId: vendorId,
      detail: {
        phase: "attestation-recorded",
        framework: body.framework,
        packVersion: pack.version,
        controlRef: body.controlRef,
        questionnaireVersion,
      },
      effect: "allow",
      ruleId: "vendor-attestation-recorded",
      ruleChain: [],
      reason:
        `vendor '${row.name}' attestation recorded for ${body.controlRef} (questionnaire ` +
        `v${questionnaireVersion}) — a vendor claim with attribution, never platform evidence`,
    });
    return reply.status(201).send({
      vendor: updated,
      attestation,
      disclaimer: AI_VENDOR_ATTESTATION_DISCLAIMER,
    });
  });

  // Retire: admin-only (default route class), reason required and audited.
  // The linked assessment instance, if still live, is left to run out — a
  // retired vendor never changes status again (syncVendorForInstance treats
  // retired as terminal).
  app.post("/v1/vendors/:vendorId/retire", async (req, reply) => {
    const { vendorId } = vendorIdParam.parse(req.params);
    const body = retireVendorSchema.parse(req.body);
    const [row] = await db.select().from(aiVendors).where(eq(aiVendors.id, vendorId));
    if (!row) return reply.status(404).send({ error: "not_found" });
    if (row.status === "retired") return reply.status(409).send({ error: "already_retired" });
    const [updated] = await db
      .update(aiVendors)
      .set({
        status: "retired",
        retiredReason: body.reason,
        retiredAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(aiVendors.id, vendorId))
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NO_IDENTITY,
      objectType: "ai_vendor",
      objectId: vendorId,
      detail: { phase: "retired", from: row.status, reason: body.reason },
      effect: "allow",
      ruleId: "vendor-retired",
      ruleChain: [],
      reason: `AI vendor '${row.name}' retired: ${body.reason}`,
    });
    return updated;
  });
}
