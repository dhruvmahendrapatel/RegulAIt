/**
 * ADR-0206 G1 — PROJECT ARCHIVE.
 *
 * An archived project keeps everything it already has (spend, approvals, context, audit) readable, and takes nothing
 * new: no members, no context revisions, no settings edits, and no attributed calls. The last is enforced at the one
 * pre-dispatch gate every dispatch path calls (`preDispatchProjectGate` answers 409 `project_archived`), so an engine
 * key pinned to the project stops working without being revoked, and works again after an unarchive.
 *
 * Routes (all admin-only: none is in NON_ADMIN_ROUTES):
 *   GET  /v1/projects/:projectId/archive-impact  what the archive dialog lists: the live engine keys pinned to the
 *                                                project, and what would refuse the archive right now
 *   POST /v1/projects/:projectId/archive   {reason}  409 project_has_open_approvals | project_has_running_work |
 *                                                    project_has_open_delegations | project_already_archived
 *   POST /v1/projects/:projectId/unarchive {reason?} a `settings_relax` step-up bound to {op, projectId}: it turns
 *                                                    spend attribution and budget enforcement back on
 *
 * Each write and its audit row are one transaction. The archive takes FOR UPDATE on the project row and checks the
 * blockers under it; migration 0218's insert guard reads the row FOR SHARE, so a member or context write racing the
 * archive either lands first or is refused.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  and,
  approvals,
  auditLog,
  delegationGrants,
  engineRuns,
  eq,
  gt,
  inArray,
  isNull,
  notInArray,
  or,
  orchestrationRuns,
  projects,
  virtualKeys,
  workflowInstances,
  type Db,
} from "@regulait/db";
import {
  ARCHIVE_BLOCKER_LIST_MAX,
  ENGINE_TERMINAL_RUN_STATUSES,
  archiveProjectSchema,
  unarchiveProjectSchema,
  type ArchiveImpact,
  type RunningWork,
} from "@regulait/shared";
import { requireStepUp, type StepUpCheckArgs } from "./step-up.js";

type DbOrTx = Pick<Db, "select">;

const NIL_USER = "00000000-0000-0000-0000-000000000000";
export const PROJECT_ARCHIVED_RULE_ID = "project-archived";
export const PROJECT_UNARCHIVED_RULE_ID = "project-unarchived";

/** approvals still waiting on someone: a returned intake sign-off is waiting on its requester */
const OPEN_APPROVAL_STATUSES = ["pending", "returned"] as const;
/** the workflow statuses after which an instance does no more work (projects.ts O1 uses the same set) */
const WORKFLOW_TERMINAL_STATUSES = ["completed", "denied", "aborted", "rolled_back"] as const;
const ORCHESTRATION_OPEN_STATUSES = ["planned", "running"] as const;

const projectIdParam = z.object({ projectId: z.string().uuid() });

/** the refusal every write to an archived project (and every call attributed to one) answers */
export function projectArchivedRefusal(projectName: string) {
  return {
    status: 409 as const,
    body: {
      error: "project_archived" as const,
      detail: `project '${projectName}' is archived: it takes no new members, context, settings or attributed calls until an admin unarchives it`,
    },
  };
}

/** answers the refusal when the project is archived; true = the caller must stop */
export async function refuseIfArchived(
  reply: { status: (code: number) => { send: (body: unknown) => unknown } },
  project: { name: string; archivedAt: Date | null } | undefined,
): Promise<boolean> {
  if (!project?.archivedAt) return false;
  const r = projectArchivedRefusal(project.name);
  await reply.status(r.status).send(r.body);
  return true;
}

/** the step-up an unarchive needs: it gives the project its spend and budget enforcement back */
export function unarchiveStepUp(projectId: string): StepUpCheckArgs {
  return { kind: "settings_relax", facts: { op: "project_unarchive", projectId } };
}

/** what would refuse an archive now, and the engine keys an archive stops; every list bounded, counts exact */
export async function loadArchiveImpact(db: DbOrTx, projectId: string, now = new Date()): Promise<Omit<ArchiveImpact, "archived">> {
  const [keys, open, workflows, orchestrations, engines, delegations] = await Promise.all([
    db
      .select({ id: virtualKeys.id, name: virtualKeys.name, engineRunId: virtualKeys.engineRunId, expiresAt: virtualKeys.expiresAt })
      .from(virtualKeys)
      .where(
        and(
          eq(virtualKeys.projectId, projectId),
          eq(virtualKeys.purpose, "engine"),
          isNull(virtualKeys.revokedAt),
          or(isNull(virtualKeys.expiresAt), gt(virtualKeys.expiresAt, now)),
        ),
      ),
    db
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.projectId, projectId), inArray(approvals.status, [...OPEN_APPROVAL_STATUSES]))),
    db
      .select({ id: workflowInstances.id, status: workflowInstances.status })
      .from(workflowInstances)
      .where(and(eq(workflowInstances.projectId, projectId), notInArray(workflowInstances.status, [...WORKFLOW_TERMINAL_STATUSES]))),
    db
      .select({ id: orchestrationRuns.id, status: orchestrationRuns.status })
      .from(orchestrationRuns)
      .where(and(eq(orchestrationRuns.projectId, projectId), inArray(orchestrationRuns.status, [...ORCHESTRATION_OPEN_STATUSES]))),
    db
      .select({ id: engineRuns.id, status: engineRuns.status })
      .from(engineRuns)
      .where(and(eq(engineRuns.projectId, projectId), notInArray(engineRuns.status, [...ENGINE_TERMINAL_RUN_STATUSES]))),
    db
      .select({ id: delegationGrants.id })
      .from(delegationGrants)
      .where(and(eq(delegationGrants.projectId, projectId), isNull(delegationGrants.revokedAt), gt(delegationGrants.expiresAt, now))),
  ]);
  const runningWork: RunningWork[] = [
    ...workflows.map((r) => ({ id: r.id, kind: "workflow" as const, status: r.status })),
    ...orchestrations.map((r) => ({ id: r.id, kind: "orchestration" as const, status: r.status })),
    ...engines.map((r) => ({ id: r.id, kind: "engine_run" as const, status: r.status })),
  ];
  const cap = <T>(rows: T[]) => rows.slice(0, ARCHIVE_BLOCKER_LIST_MAX);
  return {
    projectId,
    pinnedEngineKeys: cap(keys).map((k) => ({
      id: k.id,
      name: k.name,
      engineRunId: k.engineRunId,
      expiresAt: k.expiresAt ? k.expiresAt.toISOString() : null,
    })),
    pinnedEngineKeyCount: keys.length,
    openApprovals: cap(open),
    openApprovalCount: open.length,
    runningWork: cap(runningWork),
    runningWorkCount: runningWork.length,
    openDelegations: cap(delegations),
    openDelegationCount: delegations.length,
  };
}

type ArchiveOutcome =
  | { ok: true; pinnedEngineKeys: ArchiveImpact["pinnedEngineKeys"]; pinnedEngineKeyCount: number }
  | { ok: false; status: number; body: Record<string, unknown> };

export function registerProjectArchiveRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/projects/:projectId/archive-impact", async (req, reply) => {
    const { projectId } = projectIdParam.parse(req.params);
    const [project] = await db.select({ archivedAt: projects.archivedAt }).from(projects).where(eq(projects.id, projectId));
    if (!project) return reply.status(404).send({ error: "unknown_project" });
    const impact: ArchiveImpact = { ...(await loadArchiveImpact(db, projectId)), archived: project.archivedAt !== null };
    return impact;
  });

  app.post("/v1/projects/:projectId/archive", async (req, reply) => {
    const { projectId } = projectIdParam.parse(req.params);
    const parsed = archiveProjectSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body", detail: "expected { reason: string (10-500 characters) }" });
    }
    const { reason } = parsed.data;
    const actor = req.authCtx.userId ?? null;
    const out = await db.transaction(async (tx): Promise<ArchiveOutcome> => {
      const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
      if (!project) return { ok: false, status: 404, body: { error: "unknown_project" } };
      if (project.archivedAt) {
        return { ok: false, status: 409, body: { error: "project_already_archived", archivedAt: project.archivedAt.toISOString() } };
      }
      const impact = await loadArchiveImpact(tx, projectId);
      if (impact.openApprovalCount > 0) {
        return {
          ok: false,
          status: 409,
          body: {
            error: "project_has_open_approvals",
            approvals: impact.openApprovals,
            count: impact.openApprovalCount,
            detail: `project '${project.name}' has ${impact.openApprovalCount} open approval(s): decide or withdraw them first`,
          },
        };
      }
      if (impact.runningWorkCount > 0) {
        return {
          ok: false,
          status: 409,
          body: {
            error: "project_has_running_work",
            runs: impact.runningWork,
            count: impact.runningWorkCount,
            detail: `project '${project.name}' has ${impact.runningWorkCount} run(s) in progress: let them finish or cancel them first`,
          },
        };
      }
      if (impact.openDelegationCount > 0) {
        return {
          ok: false,
          status: 409,
          body: {
            error: "project_has_open_delegations",
            delegations: impact.openDelegations,
            count: impact.openDelegationCount,
            detail: `project '${project.name}' has ${impact.openDelegationCount} live delegation grant(s): revoke them first`,
          },
        };
      }
      const now = new Date();
      await tx
        .update(projects)
        .set({ archivedAt: now, archivedReason: reason, archivedByUserId: actor })
        .where(eq(projects.id, projectId));
      await tx.insert(auditLog).values({
        userId: actor ?? NIL_USER,
        objectType: "project",
        objectId: projectId,
        detail: {
          phase: "project-archived",
          via: req.authCtx.via,
          name: project.name,
          reason,
          pinnedEngineKeys: impact.pinnedEngineKeys.map((k) => k.id),
          pinnedEngineKeyCount: impact.pinnedEngineKeyCount,
        },
        effect: "allow",
        ruleId: PROJECT_ARCHIVED_RULE_ID,
        ruleChain: [],
        reason: `project '${project.name}' archived: ${reason}`,
      });
      return { ok: true, pinnedEngineKeys: impact.pinnedEngineKeys, pinnedEngineKeyCount: impact.pinnedEngineKeyCount };
    });
    if (!out.ok) return reply.status(out.status).send(out.body);
    return { archived: true, pinnedEngineKeys: out.pinnedEngineKeys, pinnedEngineKeyCount: out.pinnedEngineKeyCount };
  });

  app.post("/v1/projects/:projectId/unarchive", async (req, reply) => {
    const { projectId } = projectIdParam.parse(req.params);
    const parsed = unarchiveProjectSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body", detail: "expected { reason?: string (10-500 characters) }" });
    }
    const [current] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!current) return reply.status(404).send({ error: "unknown_project" });
    if (!current.archivedAt) return reply.status(409).send({ error: "project_not_archived" });
    // the step-up is decided before the transaction (its refusal is audited by checkStepUp on `db`), then the write
    // re-checks the state under the row lock, so a concurrent unarchive cannot be applied twice
    const su = await requireStepUp(db, req, reply, unarchiveStepUp(projectId));
    if (!su.ok) return reply;
    const actor = req.authCtx.userId ?? null;
    const note = parsed.data.reason ?? null;
    const out = await db.transaction(async (tx): Promise<{ ok: boolean }> => {
      const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
      if (!project?.archivedAt) return { ok: false };
      await tx
        .update(projects)
        .set({ archivedAt: null, archivedReason: null, archivedByUserId: null })
        .where(eq(projects.id, projectId));
      await tx.insert(auditLog).values({
        userId: actor ?? NIL_USER,
        objectType: "project",
        objectId: projectId,
        detail: {
          phase: "project-unarchived",
          via: req.authCtx.via,
          name: project.name,
          stepUp: su.method,
          archivedAt: project.archivedAt.toISOString(),
          archivedReason: project.archivedReason,
          ...(note ? { reason: note } : {}),
        },
        effect: "allow",
        ruleId: PROJECT_UNARCHIVED_RULE_ID,
        ruleChain: [],
        reason: `project '${project.name}' unarchived${note ? `: ${note}` : ""}`,
      });
      return { ok: true };
    });
    if (!out.ok) return reply.status(409).send({ error: "project_not_archived" });
    return { archived: false };
  });
}
