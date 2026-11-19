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
import { CHANGED_CONCURRENTLY, requireStepUp } from "./step-up.js";
import { currentPeriodKey, meteredSpendUsdBy, periodStart } from "./projects.js";
import type { ListSpec } from "./list-contract.js";
import { answerListPage, type ContractList } from "./list-contract-route.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export const BUDGET_ALERT_RULE_IDS = {
  userBudgetSet: "user-spend-budget-set",
  userBudgetDeleted: "user-spend-budget-deleted",
} as const;

// The window rules and the spend reader are the project gate's own (projects.ts), so the alert window and the
// enforcement window cannot drift apart.
const monthStart = periodStart;
const periodKey = currentPeriodKey;
const meteredBy = meteredSpendUsdBy;
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

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Written in the same transaction as the change it records, so a change never lands without its audit row. */
async function auditBudget(db: Db | Tx, actor: string | null | undefined, ruleId: string, reason: string, detail: Record<string, unknown>, objectId: string) {
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

interface BudgetFacts {
  budgetUsd: number;
  budgetPeriod: "monthly" | "none";
  alertThresholdPct: number;
}

/**
 * The ways a change loosens a stored budget's alert (ADR-0180: a loosening is a step-up, audited as a relaxation): a
 * higher budget, a higher threshold, or a different window. Either window change can move when the alert fires (a
 * monthly window resets each month; a lifetime one counts spend the monthly one no longer does), so both are treated
 * as a loosening. A first budget and a pure tightening loosen nothing.
 */
export function budgetLoosenings(before: BudgetFacts | null, after: BudgetFacts): string[] {
  if (!before) return [];
  const out: string[] = [];
  if (after.budgetUsd > before.budgetUsd) out.push("budget_raised");
  if (after.alertThresholdPct > before.alertThresholdPct) out.push("threshold_raised");
  if (after.budgetPeriod !== before.budgetPeriod) out.push("window_changed");
  return out;
}

const factsOf = (r: BudgetFacts): BudgetFacts => ({
  budgetUsd: r.budgetUsd,
  budgetPeriod: r.budgetPeriod,
  alertThresholdPct: r.alertThresholdPct,
});
const sameFacts = (a: BudgetFacts, b: BudgetFacts) =>
  a.budgetUsd === b.budgetUsd && a.budgetPeriod === b.budgetPeriod && a.alertThresholdPct === b.alertThresholdPct;

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

interface SpendBudgetListRow {
  id: string;
  userId: string;
  displayName: string | null;
  budgetUsd: number;
  budgetPeriod: string;
  alertThresholdPct: number;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** GET /v1/user-spend-budgets under the ADR-0226 list contract (keyset by last change, page sizes 10 to 500). */
export const USER_SPEND_BUDGETS_LIST: ListSpec<SpendBudgetListRow> = {
  id: "user-spend-budgets",
  sorts: {
    updated: { expr: userSpendBudgets.updatedAt, keysetAt: userSpendBudgets.updatedAt },
    name: { expr: sql`lower(${users.displayName})` },
    budget: { expr: userSpendBudgets.budgetUsd },
  },
  columns: {
    name: { label: "Person", value: (r) => r.displayName },
    budget: { label: "Budget (USD)", value: (r) => r.budgetUsd },
    period: { label: "Window", value: (r) => r.budgetPeriod },
    pct: { label: "Alert at (%)", value: (r) => r.alertThresholdPct },
    updated: { label: "Last changed", value: (r) => r.updatedAt },
  },
  filters: [],
  defaultSort: { col: "updated", dir: "desc" },
  idCol: userSpendBudgets.id,
};

export function registerBudgetAlertRoutes(app: FastifyInstance, db: Db): void {
  const budgetsList: ContractList<SpendBudgetListRow, Record<string, never>> = {
    spec: USER_SPEND_BUDGETS_LIST,
    filters: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
    reader: {
      fetch: (q) =>
        db
          .select({
            id: userSpendBudgets.id,
            userId: userSpendBudgets.userId,
            displayName: users.displayName,
            budgetUsd: userSpendBudgets.budgetUsd,
            budgetPeriod: userSpendBudgets.budgetPeriod,
            alertThresholdPct: userSpendBudgets.alertThresholdPct,
            createdBy: userSpendBudgets.createdBy,
            createdAt: userSpendBudgets.createdAt,
            updatedAt: userSpendBudgets.updatedAt,
            _cursorAt: q.cursorAt,
          })
          .from(userSpendBudgets)
          .innerJoin(users, eq(users.id, userSpendBudgets.userId))
          .where(q.where)
          .orderBy(...q.orderBy)
          .limit(q.limit)
          .offset(q.offset),
      countable: (where) =>
        db.select({ one: sql`1` }).from(userSpendBudgets).innerJoin(users, eq(users.id, userSpendBudgets.userId)).where(where),
      idOf: (r) => r.id,
    },
    where: () => undefined,
  };
  app.get("/v1/user-spend-budgets", async (req, reply) => answerListPage(db, req, reply, budgetsList));

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

  /**
   * A first budget or a tightening adds or strengthens an alert: audited, no step-up. Raising the budget or the
   * threshold, or changing the window, loosens it: a `settings_relax` step-up, audited as a relaxation (ADR-0180).
   * The step-up is decided on an unlocked read, so the write is a compare-and-set on what was read (ADR-0186 A).
   */
  app.put("/v1/users/:userId/spend-budget", async (req, reply) => {
    const p = userParam.safeParse(req.params);
    const b = budgetBody.safeParse(req.body ?? {});
    if (!p.success || !b.success) return refuse(reply, 400, "invalid_request", "send {budgetUsd > 0, budgetPeriod?: 'monthly' | 'none', alertThresholdPct?: 1-100}");
    const userId = p.data.userId;
    const [person] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
    if (!person) return refuse(reply, 404, "unknown_user", "no such person");
    const values: BudgetFacts = {
      budgetUsd: b.data.budgetUsd,
      budgetPeriod: b.data.budgetPeriod ?? "monthly",
      alertThresholdPct: b.data.alertThresholdPct ?? 80,
    };
    const [stored] = await db.select().from(userSpendBudgets).where(eq(userSpendBudgets.userId, userId));
    const before = stored ? factsOf(stored as BudgetFacts) : null;
    const loosenings = budgetLoosenings(before, values);
    let stepUp: string | null = null;
    if (loosenings.length > 0) {
      const su = await requireStepUp(db, req, reply, {
        kind: "settings_relax",
        facts: { userSpendBudget: "loosen", userId, from: before, to: values, loosenings },
      });
      if (!su.ok) return reply;
      stepUp = su.method;
    }
    const written = await db.transaction(async (tx) => {
      let row;
      if (before) {
        // compare-and-set under the row lock: the step-up decision rested on `before`
        const [locked] = await tx.select().from(userSpendBudgets).where(eq(userSpendBudgets.userId, userId)).for("update");
        if (!locked || !sameFacts(factsOf(locked as BudgetFacts), before)) return null;
        [row] = await tx
          .update(userSpendBudgets)
          .set({ ...values, updatedAt: sql`now()` })
          .where(eq(userSpendBudgets.id, locked.id))
          .returning();
      } else {
        // a first budget: if one appeared meanwhile, the decision (no step-up) may no longer hold
        [row] = await tx
          .insert(userSpendBudgets)
          .values({ userId, ...values, createdBy: req.authCtx.userId ?? null })
          .onConflictDoNothing({ target: userSpendBudgets.userId })
          .returning();
        if (!row) return null;
      }
      const relaxation = loosenings.length > 0;
      await auditBudget(tx, req.authCtx.userId, BUDGET_ALERT_RULE_IDS.userBudgetSet,
        `spend budget set: ${usd(values.budgetUsd)} ${values.budgetPeriod === "monthly" ? "per month" : "lifetime"}, alert at ${values.alertThresholdPct}%` +
          (relaxation ? ` (a relaxation: ${loosenings.join(", ")})` : ""),
        { ...values, previous: before, relaxation, loosenings, stepUp }, userId);
      return row;
    });
    if (!written) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    return { budget: written };
  });

  // Removing a budget removes an alert: a relaxation, so a step-up, audited as one.
  app.delete("/v1/users/:userId/spend-budget", async (req, reply) => {
    const p = userParam.safeParse(req.params);
    if (!p.success) return refuse(reply, 400, "invalid_request", "userId must be a uuid");
    const [row] = await db.select().from(userSpendBudgets).where(eq(userSpendBudgets.userId, p.data.userId));
    if (!row) return refuse(reply, 404, "no_budget", "this person has no spend budget");
    const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { userSpendBudget: "delete", userId: p.data.userId } });
    if (!su.ok) return reply;
    const removed = await db.transaction(async (tx) => {
      const gone = await tx.delete(userSpendBudgets).where(eq(userSpendBudgets.id, row.id)).returning({ id: userSpendBudgets.id });
      if (gone.length === 0) return false;
      await auditBudget(tx, req.authCtx.userId, BUDGET_ALERT_RULE_IDS.userBudgetDeleted,
        "spend budget removed: this person's spend no longer raises a budget alert (a relaxation)",
        { relaxation: true, stepUp: su.method, previous: factsOf(row as BudgetFacts) }, p.data.userId);
      return true;
    });
    if (!removed) return refuse(reply, 404, "no_budget", "this person has no spend budget");
    return reply.status(204).send();
  });
}
