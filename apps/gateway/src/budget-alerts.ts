/**
 * ADR-0312 (pilot addendum) — BUDGET ALERTS THROUGH THE EXISTING ALERTING PATH.
 *
 * The governance monitor (ADR-0157) is where alerts live: an episode per condition, an owner and a due time
 * (ADR-0182 S5), chat delivery (ADR-0162), an optional ticket, the audit chain and so every SIEM stream. Budget
 * crossings were only an audit row and an approvals item, and nothing alerted on a person's spend. This module is the
 * loader for two monitor rules:
 *
 *   project_budget_threshold   a project's metered spend in its budget window reached alert_threshold_pct of its budget
 *   user_budget_threshold      a person's metered spend in their window reached the threshold of their spend budget
 *   user_imported_budget_threshold   a person's IMPORTED spend reached the same threshold: a separate alert, never added
 *                              to the metered figure (owner decision 2026-11-15, ADR-0069)
 *
 * Both are high at 100%. They are evaluated by the hourly monitor and by a five-minute spend pass
 * (`runSpendBudgetPass`, governance-monitor.ts), so an alert fires within minutes of the spend that crossed it.
 * Metered spend is every priced model, MCP tool and connector call on `usage_events`. Imported spend (seat and usage
 * exports of off-gateway tools) is reported beside it on the alert, never added (ADR-0069).
 *
 * Search first (ADR-0176): the alerting, delivery and ticketing are the existing monitor's; this adds two rules and a
 * budget row. No new dependency.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  and,
  auditLog,
  eq,
  isNotNull,
  isNull,
  projects,
  sql,
  userSpendBudgets,
  users,
  type Db,
} from "@regulait/db";
import type { MonitorAssuranceInput, MonitorAssuranceSubject, SpendMonitorRuleId } from "@regulait/shared";
import { requireStepUp } from "./step-up.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export const BUDGET_ALERT_RULE_IDS = {
  userBudgetSet: "user-spend-budget-set",
  userBudgetDeleted: "user-spend-budget-deleted",
} as const;

/** UTC month start: the lower bound of a monthly window (the project gate's own rule) */
function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
const periodKey = (now: Date) => `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
const usd = (n: number) => `$${n.toFixed(2)}`;

interface Crossing {
  spentUsd: number;
  budgetUsd: number;
  pct: number;
}
/** null below the threshold; otherwise the alert severity and how far along the budget the spend is */
export function budgetCrossing(c: Crossing): { severity: "medium" | "high"; pctOfBudget: number } | null {
  if (!(c.budgetUsd > 0)) return null;
  const pctOfBudget = (c.spentUsd / c.budgetUsd) * 100;
  if (c.spentUsd < (c.budgetUsd * c.pct) / 100) return null;
  return { severity: c.spentUsd >= c.budgetUsd ? "high" : "medium", pctOfBudget };
}

async function meteredBy(db: Db, column: "project_id" | "user_id", ids: string[], since: Date | null): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const res = await db.execute<{ k: string; usd: number }>(sql`
    SELECT ${sql.raw(column)}::text AS k, coalesce(sum(cost_usd), 0)::float8 AS usd
      FROM usage_events
     WHERE ${sql.raw(column)} = ANY(${sql`ARRAY[${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}]`})
       ${since ? sql`AND at >= ${since.toISOString()}::timestamptz` : sql``}
     GROUP BY 1`);
  return new Map(res.rows.map((r) => [r.k, Number(r.usd)]));
}

async function importedByUser(db: Db, ids: string[], since: Date | null, now: Date): Promise<Map<string, { usd: number; nonUsdLines: number }>> {
  if (ids.length === 0) return new Map();
  const res = await db.execute<{ k: string; usd: number | null; non_usd: number }>(sql`
    SELECT l.resolved_user_id::text AS k,
           sum(l.amount) FILTER (WHERE l.currency = 'USD')::float8 AS usd,
           count(*) FILTER (WHERE l.currency <> 'USD')::int AS non_usd
      FROM imported_cost_lines l
      JOIN cost_import_batches b ON b.id = l.batch_id AND b.status = 'applied'
     WHERE l.superseded_at IS NULL
       AND l.resolved_user_id = ANY(${sql`ARRAY[${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}]`})
       AND l.period_start < ${now.toISOString()}::timestamptz
       ${since ? sql`AND l.period_end > ${since.toISOString()}::timestamptz` : sql``}
     GROUP BY 1`);
  return new Map(res.rows.map((r) => [r.k, { usd: Number(r.usd ?? 0), nonUsdLines: Number(r.non_usd) }]));
}

/** The monitor loader: both spend rules, each with the breaches of this moment. */
export async function spendBudgetMonitorInput(db: Db, now: Date): Promise<Partial<Record<SpendMonitorRuleId, MonitorAssuranceInput>>> {
  const start = monthStart(now);

  // projects with their own budget (the compliance ceiling is enforced by the project gate, not alerted here)
  const projectRows = await db
    .select({
      id: projects.id,
      name: projects.name,
      budgetUsd: projects.budgetUsd,
      budgetPeriod: projects.budgetPeriod,
      alertThresholdPct: projects.alertThresholdPct,
      overageApproved: projects.overageApproved,
      overageApprovedPeriod: projects.overageApprovedPeriod,
    })
    .from(projects)
    .where(and(isNotNull(projects.budgetUsd), isNull(projects.archivedAt)));
  const monthlyP = projectRows.filter((p) => p.budgetPeriod === "monthly").map((p) => p.id);
  const lifetimeP = projectRows.filter((p) => p.budgetPeriod !== "monthly").map((p) => p.id);
  const pSpend = new Map([...(await meteredBy(db, "project_id", monthlyP, start)), ...(await meteredBy(db, "project_id", lifetimeP, null))]);
  const projectBreaches: MonitorAssuranceSubject[] = [];
  for (const p of projectRows) {
    const spentUsd = pSpend.get(p.id) ?? 0;
    const crossing = budgetCrossing({ spentUsd, budgetUsd: p.budgetUsd!, pct: p.alertThresholdPct });
    if (!crossing) continue;
    const monthly = p.budgetPeriod === "monthly";
    projectBreaches.push({
      subjectKey: `project:${p.id}`,
      severity: crossing.severity,
      title: `Project ${p.name} at ${Math.floor(crossing.pctOfBudget)}% of its ${usd(p.budgetUsd!)} ${monthly ? "monthly" : "lifetime"} budget`,
      detail: {
        projectId: p.id,
        basis: "metered",
        meteredUsd: spentUsd,
        budgetUsd: p.budgetUsd,
        alertThresholdPct: p.alertThresholdPct,
        window: monthly ? { period: periodKey(now), from: start.toISOString() } : { period: "lifetime" },
        overageApproved: p.overageApproved && (!monthly || p.overageApprovedPeriod === periodKey(now)),
        imported: null,
        importedNote: "imported cost lines carry no project, so no imported figure is attributable to a project",
      },
    });
  }

  // people with a spend budget (disabled accounts are not alerted on)
  const userRows = await db
    .select({
      userId: userSpendBudgets.userId,
      budgetUsd: userSpendBudgets.budgetUsd,
      budgetPeriod: userSpendBudgets.budgetPeriod,
      alertThresholdPct: userSpendBudgets.alertThresholdPct,
      displayName: users.displayName,
    })
    .from(userSpendBudgets)
    .innerJoin(users, eq(users.id, userSpendBudgets.userId))
    .where(isNull(users.disabledAt));
  const monthlyU = userRows.filter((u) => u.budgetPeriod === "monthly").map((u) => u.userId);
  const lifetimeU = userRows.filter((u) => u.budgetPeriod !== "monthly").map((u) => u.userId);
  const uSpend = new Map([...(await meteredBy(db, "user_id", monthlyU, start)), ...(await meteredBy(db, "user_id", lifetimeU, null))]);
  const uImported = new Map([...(await importedByUser(db, monthlyU, start, now)), ...(await importedByUser(db, lifetimeU, null, now))]);
  const userBreaches: MonitorAssuranceSubject[] = [];
  const importedBreaches: MonitorAssuranceSubject[] = [];
  for (const u of userRows) {
    const spentUsd = uSpend.get(u.userId) ?? 0;
    const monthly = u.budgetPeriod === "monthly";
    const window = monthly ? { period: periodKey(now), from: start.toISOString() } : { period: "lifetime" };
    const imported = uImported.get(u.userId) ?? { usd: 0, nonUsdLines: 0 };
    // owner decision 2026-11-15: imported spend is compared with the budget ON ITS OWN, as a separate alert. The two
    // bases are never summed: a person can be over on either, both or neither.
    const importedCrossing = budgetCrossing({ spentUsd: imported.usd, budgetUsd: u.budgetUsd, pct: u.alertThresholdPct });
    if (importedCrossing) {
      importedBreaches.push({
        subjectKey: `user:${u.userId}`,
        severity: importedCrossing.severity,
        title: `${u.displayName || u.userId}: imported spend at ${Math.floor(importedCrossing.pctOfBudget)}% of their ${usd(u.budgetUsd)} ${monthly ? "monthly" : "lifetime"} spend budget`,
        detail: {
          userId: u.userId,
          basis: "imported",
          importedUsd: imported.usd,
          nonUsdLines: imported.nonUsdLines,
          budgetUsd: u.budgetUsd,
          alertThresholdPct: u.alertThresholdPct,
          window,
          metered: { basis: "metered", usd: spentUsd },
          note:
            "imported lines are restated from customer exports and counted whole when their billing period overlaps " +
            "the window; non-USD lines are not converted and are not in importedUsd. Never added to metered spend.",
        },
      });
    }
    const crossing = budgetCrossing({ spentUsd, budgetUsd: u.budgetUsd, pct: u.alertThresholdPct });
    if (!crossing) continue;
    userBreaches.push({
      subjectKey: `user:${u.userId}`,
      severity: crossing.severity,
      // a display name and an id: never the email
      title: `${u.displayName || u.userId} at ${Math.floor(crossing.pctOfBudget)}% of their ${usd(u.budgetUsd)} ${monthly ? "monthly" : "lifetime"} spend budget`,
      detail: {
        userId: u.userId,
        basis: "metered",
        meteredUsd: spentUsd,
        budgetUsd: u.budgetUsd,
        alertThresholdPct: u.alertThresholdPct,
        window,
        imported: { basis: "imported", usd: imported.usd, nonUsdLines: imported.nonUsdLines },
        importedNote: "imported spend has its own alert (user_imported_budget_threshold) and is never added to this one",
      },
    });
  }

  return {
    project_budget_threshold: { breaches: projectBreaches },
    user_budget_threshold: { breaches: userBreaches },
    user_imported_budget_threshold: { breaches: importedBreaches },
  };
}

// ---------------------------------------------------------------------------
// routes: a person's spend budget
// ---------------------------------------------------------------------------

const userParam = z.object({ userId: z.string().uuid() });
const budgetBody = z
  .object({
    budgetUsd: z.number().positive().max(10_000_000),
    budgetPeriod: z.enum(["monthly", "none"]).optional(),
    alertThresholdPct: z.number().int().min(1).max(100).optional(),
  })
  .strict();

function refuse(reply: FastifyReply, status: number, error: string, detail: string) {
  return reply.status(status).send({ error, detail });
}

async function auditBudget(db: Db, actor: string | null | undefined, ruleId: string, reason: string, detail: Record<string, unknown>, objectId: string) {
  await db.insert(auditLog).values({
    userId: actor ?? NIL_UUID,
    objectType: "user",
    objectId,
    detail: { subsystem: "budget-alerts", adr: "0312", ...detail },
    effect: "allow",
    ruleId,
    ruleChain: [],
    reason,
  });
}

async function viewFor(db: Db, userId: string, now = new Date()) {
  const [b] = await db.select().from(userSpendBudgets).where(eq(userSpendBudgets.userId, userId));
  if (!b) return null;
  const since = b.budgetPeriod === "monthly" ? monthStart(now) : null;
  const metered = (await meteredBy(db, "user_id", [userId], since)).get(userId) ?? 0;
  const imported = (await importedByUser(db, [userId], since, now)).get(userId) ?? { usd: 0, nonUsdLines: 0 };
  return {
    budget: b,
    window: since ? { period: periodKey(now), from: since.toISOString() } : { period: "lifetime" },
    metered: { basis: "metered", usd: metered, pctOfBudget: (metered / b.budgetUsd) * 100 },
    imported: { basis: "imported", usd: imported.usd, nonUsdLines: imported.nonUsdLines },
    note: "Metered and imported spend are each compared with the budget, as two separate alerts; they are never added.",
  };
}

export function registerBudgetAlertRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/user-spend-budgets", async () => {
    const rows = await db
      .select({ budget: userSpendBudgets, displayName: users.displayName })
      .from(userSpendBudgets)
      .innerJoin(users, eq(users.id, userSpendBudgets.userId))
      .orderBy(users.displayName)
      .limit(1_000);
    return { budgets: rows.map((r) => ({ ...r.budget, displayName: r.displayName })), limit: 1_000 };
  });

  /** Self-scoped (NON_ADMIN_ROUTES): a person reads their own budget and spend; anyone else's is an admin read. */
  app.get("/v1/users/:userId/spend-budget", async (req, reply) => {
    const p = userParam.safeParse(req.params);
    if (!p.success) return refuse(reply, 400, "invalid_request", "userId must be a uuid");
    if (!req.authCtx.isAdmin && req.authCtx.userId !== p.data.userId) {
      return refuse(reply, 403, "forbidden", "you may read only your own spend budget; another person's is an admin surface");
    }
    const view = await viewFor(db, p.data.userId);
    if (!view) return refuse(reply, 404, "no_budget", "this person has no spend budget");
    return view;
  });

  // Setting or tightening a budget adds an alert (stricter); it is audited, not a step-up.
  app.put("/v1/users/:userId/spend-budget", async (req, reply) => {
    const p = userParam.safeParse(req.params);
    const b = budgetBody.safeParse(req.body ?? {});
    if (!p.success || !b.success) return refuse(reply, 400, "invalid_request", "send {budgetUsd > 0, budgetPeriod?: 'monthly' | 'none', alertThresholdPct?: 1-100}");
    const [person] = await db.select({ id: users.id }).from(users).where(eq(users.id, p.data.userId));
    if (!person) return refuse(reply, 404, "unknown_user", "no such person");
    const values = {
      budgetUsd: b.data.budgetUsd,
      budgetPeriod: b.data.budgetPeriod ?? "monthly",
      alertThresholdPct: b.data.alertThresholdPct ?? 80,
    };
    const [row] = await db
      .insert(userSpendBudgets)
      .values({ userId: p.data.userId, ...values, createdBy: req.authCtx.userId ?? null })
      .onConflictDoUpdate({ target: userSpendBudgets.userId, set: { ...values, updatedAt: sql`now()` } })
      .returning();
    await auditBudget(db, req.authCtx.userId, BUDGET_ALERT_RULE_IDS.userBudgetSet,
      `spend budget set: ${usd(values.budgetUsd)} ${values.budgetPeriod === "monthly" ? "per month" : "lifetime"}, alert at ${values.alertThresholdPct}%`,
      { ...values }, p.data.userId);
    return { budget: row };
  });

  // Removing a budget removes an alert: a relaxation, so a step-up, audited as one.
  app.delete("/v1/users/:userId/spend-budget", async (req, reply) => {
    const p = userParam.safeParse(req.params);
    if (!p.success) return refuse(reply, 400, "invalid_request", "userId must be a uuid");
    const [row] = await db.select().from(userSpendBudgets).where(eq(userSpendBudgets.userId, p.data.userId));
    if (!row) return refuse(reply, 404, "no_budget", "this person has no spend budget");
    const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { userSpendBudget: "delete", userId: p.data.userId } });
    if (!su.ok) return reply;
    await db.delete(userSpendBudgets).where(eq(userSpendBudgets.id, row.id));
    await auditBudget(db, req.authCtx.userId, BUDGET_ALERT_RULE_IDS.userBudgetDeleted,
      "spend budget removed: this person's spend no longer raises a budget alert (a relaxation)", { relaxation: true, stepUp: su.method }, p.data.userId);
    return reply.status(204).send();
  });
}
