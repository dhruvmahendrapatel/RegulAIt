/**
 * ADR-0340 slice 3 — GOVERNED MIGRATION OF A RUNNING WORKFLOW INSTANCE to another version of its template (a row of
 * ADR-0341's `workflow_template_versions`, the one version store).
 *
 *   POST /v1/workflows/instances/:instanceId/migrations   dry run (the default): the kernel's plan and the RFC 6902
 *                                                           diff; `dryRun: false` files the request in the one
 *                                                           approvals queue (kind `workflow_migration`)
 *   GET  /v1/workflows/instances/:instanceId/migrations   the instance's requests, newest first
 *
 * Both are admin routes (app.ts's default gate). A request needs an admin other than the requester to approve it
 * (one row per such admin; the first decision closes the others). The decision is applied by the one decide path
 * (app.ts), inside the decision's transaction: the plan is computed again under the instance lock against the
 * instance as it is THEN, and applied only if it still holds and the definition has not moved since the request;
 * otherwise the request is recorded `stale` and nothing changes. An applied migration replaces the instance's
 * definition and state (stage statuses follow the stage ids), bumps the stage entry (so an executor or timer from
 * before it can never commit into it), pins the new version, re-arms the current stage's deadline, and is audited
 * with both versions and the diff. Only an instance started from ONE template can migrate: a merged definition has
 * no single version to move to.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  and,
  approvals,
  auditLog,
  desc,
  eq,
  inArray,
  workflowInstanceMigrations,
  workflowInstances,
  workflowTemplates,
  workflowTemplateVersions,
  withinSystemReason,
  type Db,
  type WorkflowTemplateVersionRow,
} from "@regulait/db";
import { jsonPatch, WORKFLOW_MIGRATION_MACHINE } from "@regulait/shared";
import { planInstanceMigration, type InstanceState, type MigrationRefusal, type WorkflowDefinition } from "@regulait/workflow-kernel";
import { adminsOtherThan } from "./workflow-approvers.js";
import type { DbOrTx } from "./orchestration.js";
import { CLAIM_KEYS, scheduleStageDeadlines } from "./workflows.js";
import { contentHashOf, recordInstanceTemplateVersions } from "./workflow-template-versions.js";

/** an approval row of this kind names its request as `migration:<id>` in `stage_id` */
export const WORKFLOW_MIGRATION_PREFIX = "migration:";

export const WORKFLOW_MIGRATION_RULE_IDS = {
  requested: "workflow:migration-requested",
  denied: "workflow:migration-denied",
  stale: "workflow:migration-stale",
  applied: "workflow:instance-migrated",
} as const;

type InstanceRow = typeof workflowInstances.$inferSelect;

export type MigrationAssessment =
  | { ok: true; state: InstanceState; target: WorkflowDefinition; added: string[]; removed: string[]; changed: string[]; diff: unknown[] }
  | { ok: false; refusals: MigrationRefusal[] | Array<{ code: string; detail: string }>; diff?: unknown[] };

/** the plan for moving `instance` to `version`, refusing what the kernel refuses and what cannot be a single-template move */
export function assessMigration(instance: InstanceRow, version: WorkflowTemplateVersionRow): MigrationAssessment {
  const templateIds = instance.templateIds;
  if (templateIds.length !== 1 || templateIds[0] !== version.templateId) {
    return {
      ok: false,
      refusals: [
        templateIds.length !== 1
          ? { code: "multi_template_instance", detail: "the instance runs a definition merged from several templates; it finishes on it" }
          : { code: "not_this_template", detail: "the target is not a version of the template this instance runs" },
      ],
    };
  }
  const from = instance.definition as WorkflowDefinition;
  if (contentHashOf(from) === version.contentHash) {
    return { ok: false, refusals: [{ code: "no_change", detail: "the instance already runs this definition" }] };
  }
  const diff = jsonPatch(from, version.definition);
  const plan = planInstanceMigration(from, version.definition, instance.state as InstanceState);
  if (!plan.ok) return { ok: false, refusals: plan.refusals, diff };
  return { ok: true, state: plan.state, target: version.definition as WorkflowDefinition, added: plan.added, removed: plan.removed, changed: plan.changed, diff };
}

const migrationBody = z
  .object({
    targetVersionId: z.string().uuid(),
    dryRun: z.boolean().default(true),
    reason: z.string().trim().min(10).max(500).optional(),
  })
  .strict()
  .refine((b) => b.dryRun || b.reason !== undefined, { message: "a migration request needs a reason (10 to 500 characters)" });

export function registerWorkflowMigrationRoutes(app: FastifyInstance, db: Db): void {
  app.post("/v1/workflows/instances/:instanceId/migrations", async (req, reply) => {
    const { instanceId } = z.object({ instanceId: z.string().uuid() }).parse(req.params);
    const body = migrationBody.parse(req.body);
    const requester = req.authCtx.userId;
    if (!requester) return reply.status(403).send({ error: "bootstrap_cannot_drive" });
    const [instance] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
    if (!instance) return reply.status(404).send({ error: "unknown_instance" });
    const [version] = await db.select().from(workflowTemplateVersions).where(eq(workflowTemplateVersions.id, body.targetVersionId));
    if (!version) return reply.status(404).send({ error: "unknown_version" });
    const a = assessMigration(instance, version);
    const summary = a.ok
      ? { ok: true, added: a.added, removed: a.removed, changed: a.changed, diff: a.diff }
      : { ok: false, refusals: a.refusals, ...(a.diff ? { diff: a.diff } : {}) };
    if (body.dryRun) return { dryRun: true, targetVersion: version.version, ...summary };
    if (!a.ok) return reply.status(409).send({ error: "migration_refused", ...summary });
    const approvers = await adminsOtherThan(db, requester);
    if (approvers.length === 0) {
      return reply.status(422).send({
        error: "second_approver_unavailable",
        detail: "a migration must be approved by an admin other than the requester, and there is no other active admin",
      });
    }
    const filed = await db.transaction(async (tx) => {
      const [open] = await tx
        .select({ id: workflowInstanceMigrations.id })
        .from(workflowInstanceMigrations)
        .where(and(eq(workflowInstanceMigrations.instanceId, instanceId), eq(workflowInstanceMigrations.status, "pending")));
      if (open) return { pending: open.id } as const;
      const [m] = await tx
        .insert(workflowInstanceMigrations)
        .values({
          instanceId,
          targetVersionId: version.id,
          requestedByUserId: requester,
          reason: body.reason!,
          plan: { targetVersion: version.version, ...summary },
          fromDefinitionSha256: contentHashOf(instance.definition),
        })
        .returning();
      const ids: string[] = [];
      await withinSystemReason(tx, "approval_maintenance", "workflow-migrations.request", async () => {
        for (const approverUserId of approvers) {
          const [row] = await tx
            .insert(approvals)
            .values({ userId: requester, objectType: "workflow_migration", instanceId, stageId: `${WORKFLOW_MIGRATION_PREFIX}${m!.id}`, approverUserId })
            .returning({ id: approvals.id });
          ids.push(row!.id);
        }
      });
      await tx.insert(auditLog).values({
        userId: requester,
        objectType: "workflow_migration",
        objectId: m!.id,
        detail: { instanceId, targetVersionId: version.id, targetVersion: version.version, added: a.added, removed: a.removed, changed: a.changed, approvers },
        effect: "allow",
        ruleId: WORKFLOW_MIGRATION_RULE_IDS.requested,
        ruleChain: [],
        reason: `migration of instance ${instanceId} to template version ${version.version} requested: ${body.reason}`,
      });
      return { migrationId: m!.id, approvalIds: ids } as const;
    });
    if ("pending" in filed) return reply.status(409).send({ error: "migration_pending", migrationId: filed.pending });
    return reply.status(202).send({ status: "pending", ...filed, targetVersion: version.version, ...summary });
  });

  app.get("/v1/workflows/instances/:instanceId/migrations", async (req) => {
    const { instanceId } = z.object({ instanceId: z.string().uuid() }).parse(req.params);
    const rows = await db
      .select({
        id: workflowInstanceMigrations.id,
        status: workflowInstanceMigrations.status,
        targetVersionId: workflowInstanceMigrations.targetVersionId,
        targetVersion: workflowTemplateVersions.version,
        requestedByUserId: workflowInstanceMigrations.requestedByUserId,
        reason: workflowInstanceMigrations.reason,
        plan: workflowInstanceMigrations.plan,
        decidedByUserId: workflowInstanceMigrations.decidedByUserId,
        decidedAt: workflowInstanceMigrations.decidedAt,
        createdAt: workflowInstanceMigrations.createdAt,
      })
      .from(workflowInstanceMigrations)
      .innerJoin(workflowTemplateVersions, eq(workflowTemplateVersions.id, workflowInstanceMigrations.targetVersionId))
      .where(eq(workflowInstanceMigrations.instanceId, instanceId))
      .orderBy(desc(workflowInstanceMigrations.createdAt))
      .limit(100);
    return { migrations: rows };
  });
}

function migrationIdOf(approval: { stageId: string | null }): string | null {
  return approval.stageId?.startsWith(WORKFLOW_MIGRATION_PREFIX) ? approval.stageId.slice(WORKFLOW_MIGRATION_PREFIX.length) : null;
}

/** the one decide path's guard: the requester never approves their own migration, whatever delegation or override says */
export async function precheckWorkflowMigrationDecision(
  db: Pick<Db, "select">,
  approval: { stageId: string | null },
  deciderUserId: string,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const id = migrationIdOf(approval);
  if (!id) return null;
  const [m] = await db
    .select({ requestedByUserId: workflowInstanceMigrations.requestedByUserId })
    .from(workflowInstanceMigrations)
    .where(eq(workflowInstanceMigrations.id, id));
  if (m?.requestedByUserId === deciderUserId) {
    return {
      status: 403,
      body: { error: "cannot_approve_own_workflow_migration", detail: "the decider requested this migration; another admin decides it" },
    };
  }
  return null;
}

/**
 * Inside the decision's transaction. Approved: re-plan under the instance lock and apply, or record `stale`. Denied:
 * nothing changes. Either way the request's other pending rows are closed and the outcome is audited.
 */
export async function applyWorkflowMigrationDecision(
  tx: DbOrTx,
  approval: { id: string; stageId: string | null },
  decision: "approved" | "denied",
  deciderUserId: string,
): Promise<void> {
  const id = migrationIdOf(approval);
  if (!id) return;
  const [m] = await tx.select().from(workflowInstanceMigrations).where(eq(workflowInstanceMigrations.id, id)).for("update");
  if (!m || m.status !== "pending") return;
  await withinSystemReason(tx, "approval_maintenance", "workflow-migrations.close-others", async () => {
    await tx
      .update(approvals)
      .set({ status: "superseded" })
      .where(and(eq(approvals.stageId, approval.stageId!), eq(approvals.status, "pending")));
  });
  // ADR-0348: the request moves only as WORKFLOW_MIGRATION_MACHINE allows, from the states it names (a guarded UPDATE)
  const close = async (trigger: "approve_applied" | "approve_stale" | "deny") => {
    const status = WORKFLOW_MIGRATION_MACHINE.next(m.status, trigger);
    const moved = await tx
      .update(workflowInstanceMigrations)
      .set({ status, decidedByUserId: deciderUserId, decidedAt: new Date() })
      .where(and(eq(workflowInstanceMigrations.id, id), inArray(workflowInstanceMigrations.status, [...WORKFLOW_MIGRATION_MACHINE.sourcesOf(trigger)])))
      .returning({ id: workflowInstanceMigrations.id });
    if (moved.length !== 1) throw new Error(`workflow migration ${id} was decided concurrently`);
  };
  const audit = (ruleId: string, effect: "allow" | "deny", reason: string, detail: Record<string, unknown>) =>
    tx.insert(auditLog).values({ userId: deciderUserId, objectType: "workflow", objectId: m.instanceId, detail: { migrationId: id, ...detail }, effect, ruleId, ruleChain: [], reason });
  if (decision === "denied") {
    await close("deny");
    await audit(WORKFLOW_MIGRATION_RULE_IDS.denied, "deny", "the migration was denied; the instance stays on its version", {});
    return;
  }
  const [instance] = await tx.select().from(workflowInstances).where(eq(workflowInstances.id, m.instanceId)).for("update");
  const [version] = await tx.select().from(workflowTemplateVersions).where(eq(workflowTemplateVersions.id, m.targetVersionId));
  if (!instance || !version) {
    // the request cannot hold any more: close it, so it neither stays pending nor blocks the next one (one-pending index)
    await close("approve_stale");
    await audit(WORKFLOW_MIGRATION_RULE_IDS.stale, "deny", "the approved migration's instance or target version is gone; nothing changed", {
      ...(instance ? {} : { instanceGone: true }),
      ...(version ? {} : { targetVersionGone: true }),
    });
    return;
  }
  const a = assessMigration(instance, version);
  const moved = contentHashOf(instance.definition) !== m.fromDefinitionSha256;
  if (!a.ok || moved) {
    await close("approve_stale");
    await audit(WORKFLOW_MIGRATION_RULE_IDS.stale, "deny", "the approved migration no longer holds for the instance as it is now; nothing changed", {
      ...(moved ? { definitionMoved: true } : {}),
      ...(a.ok ? {} : { refusals: a.refusals }),
    });
    return;
  }
  const entry = instance.stageEntry + 1;
  const ctx = { ...(instance.context as Record<string, unknown>) };
  for (const k of CLAIM_KEYS) delete ctx[k];
  await tx
    .update(workflowInstances)
    .set({ definition: a.target, state: a.state, stageEntry: entry, context: ctx, updatedAt: new Date() })
    .where(eq(workflowInstances.id, instance.id));
  const [tpl] = await tx.select({ name: workflowTemplates.name }).from(workflowTemplates).where(eq(workflowTemplates.id, version.templateId));
  await recordInstanceTemplateVersions(
    tx,
    instance.id,
    [{ templateId: version.templateId, templateName: tpl?.name ?? version.templateId, definition: a.target, versionId: version.id, version: version.version, canary: false }],
    "migration",
    deciderUserId,
  );
  await close("approve_applied");
  await audit(WORKFLOW_MIGRATION_RULE_IDS.applied, "allow", `instance migrated to template version ${version.version}`, {
    targetVersionId: version.id,
    targetVersion: version.version,
    fromDefinitionSha256: m.fromDefinitionSha256,
    toDefinitionSha256: version.contentHash,
    added: a.added,
    removed: a.removed,
    changed: a.changed,
    diff: a.diff,
    stageEntry: entry,
    requestedByUserId: m.requestedByUserId,
  });
  // the current stage keeps its deadline across the migration (the entry moved, so its old timers stand down)
  const current = a.target.stages[a.state.currentStageIndex];
  if (current?.sla) await scheduleStageDeadlines(tx, instance.id, instance.projectId ?? null, current, instance.round, entry, deciderUserId, null);
}
