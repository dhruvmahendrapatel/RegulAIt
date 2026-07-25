import type { FastifyInstance } from "fastify";
import {
  and,
  approvals,
  auditLog,
  count,
  costEvents,
  eq,
  gte,
  projects,
  sql,
  usageEvents,
  type Db,
} from "@regulait/db";
import { createProjectSchema } from "@regulait/shared";
import { z } from "zod";

type ProjectRow = typeof projects.$inferSelect;

const projectIdParam = z.object({ projectId: z.string().uuid() });

/** Measured spend attributed to a project so far (pillar 5 actuals). */
async function projectSpendUsd(db: Db, projectId: string): Promise<number> {
  const [row] = await db
    .select({ spent: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8` })
    .from(usageEvents)
    .where(eq(usageEvents.projectId, projectId));
  return row?.spent ?? 0;
}

async function escalateProjectBudget(
  db: Db,
  project: ProjectRow,
  userId: string,
  spentUsd: number,
): Promise<void> {
  if (!project.budgetApproverUserId) return; // schema requires one with a budget; defensive
  const [pending] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.projectId, project.id),
        eq(approvals.stageId, "__project_budget__"),
        eq(approvals.status, "pending"),
      ),
    )
    .limit(1);
  if (!pending) {
    await db.insert(approvals).values({
      userId,
      objectType: "project",
      projectId: project.id,
      stageId: "__project_budget__",
      approverUserId: project.budgetApproverUserId,
    });
  }
  await db.insert(auditLog).values({
    userId,
    objectType: "project",
    objectId: project.id,
    detail: { phase: "project-budget", spentUsd, budgetUsd: project.budgetUsd },
    effect: "require_approval",
    ruleId: "project-budget-cap",
    ruleChain: [],
    reason: `measured project spend $${spentUsd.toFixed(6)} is at/over the $${project.budgetUsd} budget; approval required to continue`,
  });
}

export type ProjectGate =
  | { ok: true; project: ProjectRow | null; spentUsd: number }
  | { ok: false; status: number; error: string; detail?: string };

/** Pre-dispatch gate (pillar 5 enforcement): once a project's MEASURED spend
 * reaches its budget, further attributed dispatches are blocked until the
 * named approver sanctions the overage — same first-crossing-allowed
 * semantics as run budgets, because measured cost is only knowable after the
 * call. Unattributed dispatches pass through untouched. */
export async function preDispatchProjectGate(
  db: Db,
  projectId: string | null | undefined,
  userId: string,
): Promise<ProjectGate> {
  if (!projectId) return { ok: true, project: null, spentUsd: 0 };
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) {
    return { ok: false, status: 422, error: "unknown_project", detail: projectId };
  }
  if (project.budgetUsd == null || project.overageApproved) {
    return { ok: true, project, spentUsd: 0 };
  }
  const spentUsd = await projectSpendUsd(db, projectId);
  if (spentUsd >= project.budgetUsd) {
    await escalateProjectBudget(db, project, userId, spentUsd);
    return {
      ok: false,
      status: 409,
      error: "project_budget_exceeded",
      detail: `measured spend $${spentUsd.toFixed(6)} >= budget $${project.budgetUsd}`,
    };
  }
  return { ok: true, project, spentUsd };
}

/** Post-dispatch alert: the FIRST crossing is allowed (measured cost arrives
 * after the call) but escalates immediately into the one approvals queue;
 * the pre-gate blocks everything after it. Returns true when it alerted. */
export async function postDispatchProjectAlert(
  db: Db,
  gate: ProjectGate,
  userId: string,
  costUsd: number | null,
): Promise<boolean> {
  if (!gate.ok || !gate.project || gate.project.budgetUsd == null || gate.project.overageApproved) {
    return false;
  }
  const newSpent = gate.spentUsd + (costUsd ?? 0);
  if (newSpent <= gate.project.budgetUsd) return false;
  await escalateProjectBudget(db, gate.project, userId, newSpent);
  return true;
}

/** Decide-endpoint hook: approving a __project_budget__ escalation lifts
 * enforcement for the project (sanctioned overage, audited); denying leaves
 * it enforced. Both outcomes are audited — never a silent path. */
export async function applyProjectBudgetDecision(
  db: Db,
  approvalRow: { projectId: string | null; stageId: string | null },
  decision: "approved" | "denied",
  deciderUserId: string,
): Promise<void> {
  if (!approvalRow.projectId || approvalRow.stageId !== "__project_budget__") return;
  if (decision === "approved") {
    await db
      .update(projects)
      .set({ overageApproved: true })
      .where(eq(projects.id, approvalRow.projectId));
  }
  await db.insert(auditLog).values({
    userId: deciderUserId,
    objectType: "project",
    objectId: approvalRow.projectId,
    detail: { phase: "project-budget-decision", decision },
    effect: decision === "approved" ? "allow" : "deny",
    ruleId:
      decision === "approved" ? "project-budget-overage-approved" : "project-budget-overage-denied",
    ruleChain: [],
    reason:
      decision === "approved"
        ? "project budget overage approved by the named approver; enforcement lifted"
        : "project budget overage denied; enforcement stays in place",
  });
}

/** PILLAR 5: the per-project cost dashboard — real-time rollup of MEASURED
 * spend (usage_events) and ESTIMATED savings (cost_events), budget-vs-actual,
 * a simple run-rate forecast, and showback breakdowns by user and agent.
 * Admin-only: this is the FinOps surface, not a member view (membership
 * arrives with Shared Projects, pillar 4). */
export function registerProjectRoutes(app: FastifyInstance, db: Db) {
  app.post("/v1/projects", async (req, reply) => {
    const body = createProjectSchema.parse(req.body);
    const [row] = await db
      .insert(projects)
      .values({
        name: body.name,
        costCenter: body.costCenter ?? null,
        budgetUsd: body.budgetUsd ?? null,
        budgetApproverUserId: body.budgetApproverUserId ?? null,
      })
      .returning();
    return reply.status(201).send(row);
  });

  app.get("/v1/projects", async () => {
    const [rows, spend] = await Promise.all([
      db.select().from(projects),
      db
        .select({
          projectId: usageEvents.projectId,
          costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
          events: count(),
        })
        .from(usageEvents)
        .groupBy(usageEvents.projectId),
    ]);
    const byProject = new Map(spend.map((s) => [s.projectId, s]));
    return {
      projects: rows.map((p) => ({
        ...p,
        spentUsd: byProject.get(p.id)?.costUsd ?? 0,
        usageEvents: byProject.get(p.id)?.events ?? 0,
      })),
    };
  });

  app.get("/v1/projects/:projectId/costs", async (req, reply) => {
    const { projectId } = projectIdParam.parse(req.params);
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) return reply.status(404).send({ error: "unknown_project" });

    const where = eq(usageEvents.projectId, projectId);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const [[measured], byUser, byAgent, estimated, [recent]] = await Promise.all([
      db
        .select({
          events: count(),
          costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
          inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::int`,
          measuredCostSavedUsd: sql<number>`coalesce(sum(${usageEvents.measuredCostSavedUsd}), 0)::float8`,
        })
        .from(usageEvents)
        .where(where),
      db
        .select({
          userId: usageEvents.userId,
          costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
          events: count(),
        })
        .from(usageEvents)
        .where(where)
        .groupBy(usageEvents.userId),
      db
        .select({
          agentId: usageEvents.agentId,
          model: usageEvents.model,
          costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
          events: count(),
        })
        .from(usageEvents)
        .where(where)
        .groupBy(usageEvents.agentId, usageEvents.model),
      db
        .select({
          technique: costEvents.technique,
          events: count(),
          estimatedCostSavedUsd: sql<number>`coalesce(sum(${costEvents.estimatedCostSavedUsd}), 0)::float8`,
        })
        .from(costEvents)
        .where(eq(costEvents.projectId, projectId))
        .groupBy(costEvents.technique),
      db
        .select({ costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8` })
        .from(usageEvents)
        .where(and(where, gte(usageEvents.at, sevenDaysAgo))),
    ]);

    const spentUsd = measured?.costUsd ?? 0;
    // simple run-rate forecast, labeled as such: last-7-days daily rate
    // projected to the end of the current month
    const dailyRateUsd = (recent?.costUsd ?? 0) / 7;
    const now = new Date();
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const daysRemaining = Math.max(0, (endOfMonth.getTime() - now.getTime()) / (24 * 3600 * 1000));
    const projectedEomUsd = Number((spentUsd + dailyRateUsd * daysRemaining).toFixed(6));

    return {
      project,
      measured,
      byUser,
      byAgent,
      estimatedSavings: estimated,
      budget: {
        budgetUsd: project.budgetUsd,
        spentUsd,
        remainingUsd: project.budgetUsd == null ? null : Number((project.budgetUsd - spentUsd).toFixed(6)),
        overBudget: project.budgetUsd != null && spentUsd > project.budgetUsd,
        overageApproved: project.overageApproved,
      },
      forecast: {
        basis: "last-7-days-run-rate projected to end of current month",
        dailyRateUsd: Number(dailyRateUsd.toFixed(6)),
        projectedEomUsd,
      },
    };
  });
}
