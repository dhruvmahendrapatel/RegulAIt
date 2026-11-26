/**
 * ADR-0340 slice 3 (rebuilt on ADR-0341's `workflow_template_versions`, the one version store): which version of a
 * template serves a NEW instance, the pin that records it, and the canary over new instances.
 *
 *   GET  /v1/workflows/builder/templates/:templateId/canary       the open canary (or none) and what it has served
 *   POST /v1/workflows/builder/templates/:templateId/canary/end   {outcome: promote | rollback, reason, acceptRelaxations?}
 *
 * A canary is opened by a builder publish that names `canaryPercent` (workflow-builder.ts): the new version is the
 * canary, the version it replaced is the stable one, and `percent` (1 to 50) of NEW instances, chosen by instance id,
 * get the canary. While it is open no other publish is accepted (builder or governance apply), so the two versions
 * cannot move under it. It ends once: promoted (every new instance gets the canary) or rolled back (the stable
 * definition is published again as the next version, origin `canary_rollback`). A rollback is a publish like any other
 * (ADR-0341 §4.5 and §4.6): what it weakens against the live definition must be accepted with the reason, and it needs
 * the `settings_relax` step-up bound to the template, the canary, the version it replaces and the bytes it restores.
 * Running instances never change
 * version through a canary: only a governed migration (workflow-migrations.ts) moves one.
 *
 * Both routes are admin routes (the default route class, as for every builder route).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  and,
  auditLog,
  desc,
  eq,
  inArray,
  sql,
  workflowInstanceTemplateVersions,
  workflowTemplateCanaries,
  workflowTemplates,
  workflowTemplateVersions,
  type Db,
  type WorkflowTemplateCanaryRow,
  type WorkflowTemplateVersionRow,
} from "@regulait/db";
import { canaryBucket, canonicalJson, sha256Hex, WORKFLOW_TEMPLATE_CANARY_MACHINE } from "@regulait/shared";
import { findRelaxations, workflowDefinitionSchema, type Relaxation, type WorkflowDefinition } from "@regulait/workflow-kernel";
import type { DbOrTx } from "./orchestration.js";
import { CHANGED_CONCURRENTLY, requireStepUp } from "./step-up.js";

/** the step-up op a canary rollback is bound to (kind `settings_relax`, as a publish is: ADR-0341 §4.6) */
export const CANARY_ROLLBACK_STEP_UP_OP = "workflow_template_canary_rollback";

/** what restoring `restored` over the live definition weakens (ADR-0341 §4.5); none when either does not parse */
function relaxationsOf(live: unknown, restored: unknown): Relaxation[] {
  const a = workflowDefinitionSchema.safeParse(live);
  const b = workflowDefinitionSchema.safeParse(restored);
  return a.success && b.success ? findRelaxations(a.data, b.data) : [];
}

/** the audit identity of a system actor (audit_log.user_id is NOT NULL) */
const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

/** audit rule ids, one per audited act */
export const TEMPLATE_VERSION_RULE_IDS = {
  /** the template's live definition recorded as a version because an instance started on it (ADR-0341's baseline) */
  baselineAtStart: "workflow-template-version-baseline",
  canarySelected: "workflow:canary-version-selected",
  canaryStarted: "workflow-template-canary-started",
  canaryPromoted: "workflow-template-canary-promoted",
  canaryRolledBack: "workflow-template-canary-rolled-back",
} as const;

type TemplateRow = typeof workflowTemplates.$inferSelect;

export const contentHashOf = (definition: unknown): string => sha256Hex(canonicalJson(definition));

/** the template's open canary, if any */
export async function openCanary(db: DbOrTx, templateId: string): Promise<WorkflowTemplateCanaryRow | undefined> {
  const [c] = await db
    .select()
    .from(workflowTemplateCanaries)
    .where(and(eq(workflowTemplateCanaries.templateId, templateId), eq(workflowTemplateCanaries.status, "open")));
  return c;
}

/** the refusal for a publish while a canary is open (the builder's and governance apply's) */
export const CANARY_OPEN_REFUSAL = {
  status: 409,
  body: {
    error: "canary_open",
    detail: "a canary is running for this template: promote it or roll it back before publishing another version",
  },
} as const;

async function versionById(db: DbOrTx, id: string): Promise<WorkflowTemplateVersionRow | undefined> {
  const [v] = await db.select().from(workflowTemplateVersions).where(eq(workflowTemplateVersions.id, id));
  return v;
}

async function latestVersionOf(db: DbOrTx, templateId: string): Promise<WorkflowTemplateVersionRow | undefined> {
  const [v] = await db
    .select()
    .from(workflowTemplateVersions)
    .where(eq(workflowTemplateVersions.templateId, templateId))
    .orderBy(desc(workflowTemplateVersions.version))
    .limit(1);
  return v;
}

/**
 * The version that holds the template's live definition, recorded first if it has none (a template never opened in
 * the builder, or whose row was written by a seed): the newest version with the live content hash, else a new
 * `baseline` version capturing it. No template lock is taken on the start path: two starts recording the same
 * version race on the (template, version) unique index, and the loser reads the winner's row.
 */
async function liveVersion(db: DbOrTx, t: TemplateRow, actorUserId: string | null): Promise<WorkflowTemplateVersionRow> {
  const hash = contentHashOf(t.definition);
  for (let attempt = 0; attempt < 3; attempt++) {
    const [match] = await db
      .select()
      .from(workflowTemplateVersions)
      .where(and(eq(workflowTemplateVersions.templateId, t.id), eq(workflowTemplateVersions.contentHash, hash)))
      .orderBy(desc(workflowTemplateVersions.version))
      .limit(1);
    const latest = await latestVersionOf(db, t.id);
    if (match && match.id === latest?.id) return match;
    const [inserted] = await db
      .insert(workflowTemplateVersions)
      .values({ templateId: t.id, version: (latest?.version ?? 0) + 1, definition: t.definition, contentHash: hash, origin: "baseline" })
      .onConflictDoNothing({ target: [workflowTemplateVersions.templateId, workflowTemplateVersions.version] })
      .returning();
    if (!inserted) continue; // a concurrent start or publish took that number: read again
    await db.insert(auditLog).values({
      userId: actorUserId ?? NO_IDENTITY,
      objectType: "workflow_template",
      objectId: t.id,
      detail: { phase: "version-baseline", name: t.name, version: inserted.version, contentHash: hash, via: "instance-start" },
      effect: "allow",
      ruleId: TEMPLATE_VERSION_RULE_IDS.baselineAtStart,
      ruleChain: [],
      reason: `workflow template '${t.name}': its live definition is recorded as version ${inserted.version} so the instance starting on it can be pinned to it`,
    });
    return inserted;
  }
  throw new Error(`workflow template ${t.id}: could not record its live version`);
}

/** ADR-0340 slice 3: the definition a template serves to one new instance, and which version that is */
export interface ResolvedTemplateVersion {
  templateId: string;
  templateName: string;
  definition: WorkflowDefinition;
  versionId: string;
  version: number;
  canary: boolean;
}

/**
 * Resolve each template's version for a new instance: with an open canary, the canary version for `percent` of
 * instance ids (sticky: the bucket is a pure function of template and instance id) and the stable one for the rest;
 * otherwise the version holding the live definition.
 */
export async function resolveTemplateVersions(
  db: DbOrTx,
  templates: readonly TemplateRow[],
  instanceId: string,
  actorUserId: string | null,
): Promise<ResolvedTemplateVersion[]> {
  const out: ResolvedTemplateVersion[] = [];
  for (const t of templates) {
    const c = await openCanary(db, t.id);
    if (c) {
      const canary = canaryBucket(t.id, instanceId) < c.percent;
      const v = await versionById(db, canary ? c.canaryVersionId : c.stableVersionId);
      if (v) {
        out.push({ templateId: t.id, templateName: t.name, definition: v.definition as WorkflowDefinition, versionId: v.id, version: v.version, canary });
        continue;
      }
    }
    const v = await liveVersion(db, t, actorUserId);
    out.push({ templateId: t.id, templateName: t.name, definition: t.definition as WorkflowDefinition, versionId: v.id, version: v.version, canary: false });
  }
  return out;
}

/** pin an instance to the versions that serve it, with a canary selection audited */
export async function recordInstanceTemplateVersions(
  tx: DbOrTx,
  instanceId: string,
  resolved: readonly ResolvedTemplateVersion[],
  via: "start" | "migration",
  actorUserId: string | null,
): Promise<void> {
  for (const r of resolved) {
    await tx.insert(workflowInstanceTemplateVersions).values({ instanceId, templateVersionId: r.versionId, canary: r.canary, via });
    if (!r.canary) continue;
    await tx.insert(auditLog).values({
      userId: actorUserId ?? NO_IDENTITY,
      objectType: "workflow",
      objectId: instanceId,
      detail: { templateId: r.templateId, templateName: r.templateName, versionId: r.versionId, version: r.version },
      effect: "allow",
      ruleId: TEMPLATE_VERSION_RULE_IDS.canarySelected,
      ruleChain: [],
      reason: `the canary version ${r.version} of template '${r.templateName}' serves this instance (it stays on that version)`,
    });
  }
}

/** open a canary in the publish's transaction (workflow-builder.ts), audited */
export async function startCanary(
  tx: DbOrTx,
  args: { template: Pick<TemplateRow, "id" | "name">; canary: WorkflowTemplateVersionRow; stable: WorkflowTemplateVersionRow; percent: number; actorUserId: string | null },
): Promise<WorkflowTemplateCanaryRow> {
  const [c] = await tx
    .insert(workflowTemplateCanaries)
    .values({ templateId: args.template.id, canaryVersionId: args.canary.id, stableVersionId: args.stable.id, percent: args.percent, startedBy: args.actorUserId })
    .returning();
  await tx.insert(auditLog).values({
    userId: args.actorUserId ?? NO_IDENTITY,
    objectType: "workflow_template",
    objectId: args.template.id,
    detail: { phase: "canary-started", name: args.template.name, canaryId: c!.id, canaryVersion: args.canary.version, stableVersion: args.stable.version, percent: args.percent },
    effect: "allow",
    ruleId: TEMPLATE_VERSION_RULE_IDS.canaryStarted,
    ruleChain: [],
    reason: `workflow template '${args.template.name}': version ${args.canary.version} serves ${args.percent}% of new instances as a canary; version ${args.stable.version} serves the rest`,
  });
  return c!;
}

const templateParam = z.object({ templateId: z.string().uuid() });
const endBody = z
  .object({
    outcome: z.enum(["promote", "rollback"]),
    reason: z.string().trim().min(10).max(500),
    /** a rollback that weakens the live template must accept it, as a publish does (ADR-0341 §4.5) */
    acceptRelaxations: z.boolean().optional(),
  })
  .strict();

/** how many new instances each side of a canary has served */
async function servedCounts(db: Db, c: WorkflowTemplateCanaryRow): Promise<{ canary: number; stable: number }> {
  const rows = await db
    .select({ canary: workflowInstanceTemplateVersions.canary, n: sql<number>`count(*)`.mapWith(Number) })
    .from(workflowInstanceTemplateVersions)
    .where(
      and(
        eq(workflowInstanceTemplateVersions.via, "start"),
        sql`${workflowInstanceTemplateVersions.templateVersionId} IN (${c.canaryVersionId}, ${c.stableVersionId})`,
        sql`${workflowInstanceTemplateVersions.at} >= ${c.startedAt}`,
        c.endedAt ? sql`${workflowInstanceTemplateVersions.at} <= ${c.endedAt}` : undefined,
      ),
    )
    .groupBy(workflowInstanceTemplateVersions.canary);
  return { canary: rows.find((r) => r.canary)?.n ?? 0, stable: rows.find((r) => !r.canary)?.n ?? 0 };
}

async function canaryView(db: Db, c: WorkflowTemplateCanaryRow) {
  const [canary, stable] = await Promise.all([versionById(db, c.canaryVersionId), versionById(db, c.stableVersionId)]);
  return {
    id: c.id,
    status: c.status,
    percent: c.percent,
    canaryVersion: canary?.version ?? null,
    stableVersion: stable?.version ?? null,
    startedBy: c.startedBy,
    startedAt: c.startedAt,
    endedBy: c.endedBy,
    endedAt: c.endedAt,
    endReason: c.endReason,
    served: await servedCounts(db, c),
  };
}

export function registerWorkflowTemplateVersionRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/workflows/builder/templates/:templateId/canary", async (req, reply) => {
    const { templateId } = templateParam.parse(req.params);
    const [t] = await db.select({ id: workflowTemplates.id, name: workflowTemplates.name }).from(workflowTemplates).where(eq(workflowTemplates.id, templateId));
    if (!t) return reply.status(404).send({ error: "unknown_template" });
    const [last] = await db
      .select()
      .from(workflowTemplateCanaries)
      .where(eq(workflowTemplateCanaries.templateId, templateId))
      .orderBy(desc(workflowTemplateCanaries.startedAt))
      .limit(1);
    return { template: t, canary: last && last.status === "open" ? await canaryView(db, last) : null, last: last ? await canaryView(db, last) : null };
  });

  app.post("/v1/workflows/builder/templates/:templateId/canary/end", async (req, reply) => {
    const { templateId } = templateParam.parse(req.params);
    const body = endBody.parse(req.body ?? {});
    const actor = req.authCtx.userId ?? null;
    // a rollback is a publish: decide its relaxations and step-up on what is there now, then write only if it still is
    let planned: { canaryId: string; latestId: string; relaxations: Relaxation[]; stepUp: string } | null = null;
    if (body.outcome === "rollback") {
      const [t] = await db.select().from(workflowTemplates).where(eq(workflowTemplates.id, templateId));
      if (!t) return reply.status(404).send({ error: "unknown_template" });
      const c = await openCanary(db, templateId);
      if (!c) return reply.status(409).send({ error: "no_open_canary" });
      const stable = (await versionById(db, c.stableVersionId))!;
      const latest = (await latestVersionOf(db, templateId))!;
      const relaxations = relaxationsOf(t.definition, stable.definition);
      if (relaxations.length > 0 && body.acceptRelaxations !== true) {
        return reply.status(409).send({
          error: "relaxation_not_accepted",
          detail: "this rollback weakens the template: accept the relaxations (the reason is recorded with them)",
          relaxations,
        });
      }
      const su = await requireStepUp(db, req, reply, {
        kind: "settings_relax",
        facts: { op: CANARY_ROLLBACK_STEP_UP_OP, templateId, canaryId: c.id, fromVersion: latest.version, contentHash: stable.contentHash },
      });
      if (!su.ok) return reply;
      planned = { canaryId: c.id, latestId: latest.id, relaxations, stepUp: su.method };
    }
    const out = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const [locked] = await tx.select().from(workflowTemplates).where(eq(workflowTemplates.id, templateId)).for("update");
      if (!locked) return { status: 404, body: { error: "unknown_template" } } as const;
      const [c] = await tx
        .select()
        .from(workflowTemplateCanaries)
        .where(and(eq(workflowTemplateCanaries.templateId, templateId), eq(workflowTemplateCanaries.status, "open")))
        .for("update");
      if (!c) return { status: 409, body: { error: "no_open_canary" } } as const;
      // fail closed: the rollback's step-up was decided on this canary and this latest version (ADR-0186 A, Class A)
      if (planned && (c.id !== planned.canaryId || (await latestVersionOf(tx, templateId))?.id !== planned.latestId)) {
        return CHANGED_CONCURRENTLY;
      }
      // ADR-0348: the canary moves only as WORKFLOW_TEMPLATE_CANARY_MACHINE allows, from the states it names (a guarded UPDATE)
      const status = WORKFLOW_TEMPLATE_CANARY_MACHINE.next(c.status, body.outcome);
      const moved = await tx
        .update(workflowTemplateCanaries)
        .set({ status, endedBy: actor, endedAt: new Date(), endReason: body.reason })
        .where(and(eq(workflowTemplateCanaries.id, c.id), inArray(workflowTemplateCanaries.status, [...WORKFLOW_TEMPLATE_CANARY_MACHINE.sourcesOf(body.outcome)])))
        .returning({ id: workflowTemplateCanaries.id });
      if (moved.length !== 1) return { status: 409, body: { error: "changed_concurrently" } } as const;
      const canary = (await versionById(tx, c.canaryVersionId))!;
      const stable = (await versionById(tx, c.stableVersionId))!;
      let restored: WorkflowTemplateVersionRow | undefined;
      if (body.outcome === "rollback") {
        // a restore is a publish (ADR-0341 §5): the stable definition becomes the next version and the live one
        const latest = (await latestVersionOf(tx, templateId))!;
        [restored] = await tx
          .insert(workflowTemplateVersions)
          .values({ templateId, version: latest.version + 1, definition: stable.definition, contentHash: stable.contentHash, origin: "canary_rollback", publishedBy: actor })
          .returning();
        await tx.update(workflowTemplates).set({ definition: stable.definition }).where(eq(workflowTemplates.id, templateId));
      }
      await tx.insert(auditLog).values({
        userId: actor ?? NO_IDENTITY,
        objectType: "workflow_template",
        objectId: templateId,
        detail: {
          phase: body.outcome === "promote" ? "canary-promoted" : "canary-rolled-back",
          name: locked.name,
          canaryId: c.id,
          canaryVersion: canary.version,
          stableVersion: stable.version,
          percent: c.percent,
          ...(restored ? { version: restored.version, contentHash: restored.contentHash } : {}),
          ...(planned
            ? {
                relaxations: planned.relaxations,
                ...(planned.relaxations.length > 0 ? { relaxationReason: body.reason } : {}),
                stepUp: planned.stepUp,
                stepUpKind: "settings_relax",
              }
            : {}),
        },
        effect: "allow",
        ruleId: body.outcome === "promote" ? TEMPLATE_VERSION_RULE_IDS.canaryPromoted : TEMPLATE_VERSION_RULE_IDS.canaryRolledBack,
        ruleChain: [],
        reason:
          body.outcome === "promote"
            ? `workflow template '${locked.name}': canary version ${canary.version} now serves every new instance: ${body.reason}`
            : `workflow template '${locked.name}': canary version ${canary.version} rolled back; version ${stable.version}'s definition is live again as version ${restored!.version}` +
              (planned!.relaxations.length > 0 ? ` with ${planned!.relaxations.length} accepted relaxation(s)` : "") +
              `: ${body.reason}`,
      });
      return { status: 200, body: { outcome: body.outcome, canaryId: c.id, ...(restored ? { version: restored.version } : {}) } } as const;
    });
    return reply.status(out.status).send(out.body);
  });
}
