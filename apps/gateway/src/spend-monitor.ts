/**
 * ADR-0049 — the GATEWAY half of COST FORECASTING and SPEND-ANOMALY DETECTION.
 *
 *   `packages/shared/src/forecasting.ts`  the two projectors and their
 *                                         confidence interval, the modified-z
 *                                         anomaly rule with its cold-start and
 *                                         absolute-floor rails, and the
 *                                         enforcement decision. Pure — no db,
 *                                         no clock, no Fastify.
 *   THIS FILE                             the `usage_events` queries, the
 *                                         entitlement scoping, the
 *                                         Approvals-Queue escalation, the admin
 *                                         API and the audit rows.
 *
 * FOUR PROPERTIES THIS FILE EXISTS TO GUARANTEE
 *
 *  1. EVERY NUMBER COMES FROM THE MEASURED LEDGER. Both the forecast's history
 *     and every anomaly baseline are SELECTs against `usage_events` — the
 *     ledger ADR-0024 made unconditional. There is no rollup table and nothing
 *     that could drift from the cost dashboard or from ADR-0047's reports.
 *     `spend_forecast_runs.payload` is the ARTIFACT of a computation; it is
 *     never read back as an input, and regenerating recomputes from the ledger.
 *
 *  2. THE ENTITLEMENT SCOPING IS ADR-0047'S, LITERALLY. `resolveSpendScope`
 *     below calls `evaluateReportAccess` — the same function, not a
 *     reimplementation of its rules — and builds every WHERE clause from the
 *     project-id list it returns. This matters more here than it does for a
 *     report: a forecast and an anomaly alert are both DERIVED numbers, and a
 *     derived number is exactly the shape in which cross-team spend leaks. A
 *     post-hoc filter over an aggregate cannot un-aggregate it, so the
 *     narrowing happens at QUERY CONSTRUCTION, once, from one decision
 *     function. If ADR-0047's rules change, these change with them, because
 *     there is only one copy.
 *
 *  3. THE EVALUATOR IS DRIVEN, NOT IMPLICIT — and the deployment says which.
 *     ADR-0049 §3 describes a scheduled evaluator; ADR-0064 finally built the
 *     scheduler that drives it. `runSpendAnomalyEvaluation` below is the ONE
 *     implementation, reached two ways: by the ADR-0064 tick loop (when
 *     REGULAIT_SCHEDULER=on, which is OFF by default) and by
 *     `POST /v1/spend/anomalies/evaluate` for an operator or an external cron.
 *     `spend_monitor_policies` rows remain the evaluator's DEFINITION, and
 *     `lastEvaluatedAt` staying null is still how a deployment running neither
 *     SEES that, rather than assuming it works. `GET /v1/spend/monitor-overview`
 *     reports the live scheduler posture rather than a hard-coded `false`.
 *
 *  4. AN ALERT IS AN ITEM ON THE EXISTING APPROVALS QUEUE. When a policy's
 *     action escalates, this file inserts into `approvals` with the SAME shape
 *     the pillar-5 budget cap already uses (`objectType: 'project'`, the
 *     project's named budget approver, a `__spend_anomaly__` stage sentinel).
 *     There is no second inbox, no second status machine, and no second
 *     notification path — the anomaly row merely POINTS at its approval.
 *
 * WHAT THIS FILE DOES NOT DO — stated here rather than only in the ADR:
 *   - It does not implement ADR-0049 §3's INLINE pre-dispatch acceleration
 *     gate. That wants a cached rolling counter on the dispatch hot path;
 *     adding an un-cached ledger scan there to claim the feature would be
 *     exactly the overstatement this project refuses. The scheduled evaluator
 *     over the MEASURED ledger is what ships; the inline `cost_events`-based
 *     gate is a follow-up, and `preDispatchProjectGate` is untouched.
 *   - It does not send anything anywhere. An alert is a row plus (optionally)
 *     an approvals item. No mail, no webhook.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  and,
  approvals,
  auditLog,
  count,
  desc,
  eq,
  gte,
  inArray,
  lt,
  projects,
  spendAnomalies,
  spendForecastRuns,
  spendMonitorPolicies,
  spendScheduledChanges,
  sql,
  usageEvents,
  type Db,
  type SpendMonitorPolicyRow,
} from "@regulait/db";
import {
  ANOMALY_ABSOLUTE_FLOORS,
  ANOMALY_SIGNALS,
  MIN_BASELINE_SAMPLES,
  activeHours,
  bucketDaily,
  decideAnomalySchema,
  decideEnforcement,
  detectAnomaly,
  detectUnusualModel,
  evaluateReportAccess,
  forecastQuerySchema,
  forecastSpend,
  scheduledSpendChangeSchema,
  spendMonitorPolicySchema,
  type AnomalySignal,
  type AnomalyVerdict,
  type ForecastResult,
  type ReportAccessDecision,
} from "@regulait/shared";
import { callerProjectIds, callerTeamIds, resolveScopeProjectIds } from "./reporting.js";
import { complianceProfilesForTags, effectiveCompliancePolicy } from "./projects.js";
import { resolveSchedulerConfig } from "./scheduler.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
/** a uuid that cannot exist, so an empty allow-list yields an empty result set
 * rather than an unconstrained query — fail CLOSED, never open */
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** the approvals-queue sentinel, in the same `__x__` style the project-budget
 * cap (`__project_budget__`) and the run budget (`__budget__:<node>`) already
 * use. A distinct sentinel so a spend-anomaly review is never confused with a
 * budget-cap breach, on the SAME queue. */
export const SPEND_ANOMALY_STAGE = "__spend_anomaly__";

const idParam = z.object({ id: z.string().uuid() });
const DAY_MS = 24 * 3600 * 1000;

// ---------------------------------------------------------------------------
// Entitlement scoping — ADR-0047's decision function, called, not copied
// ---------------------------------------------------------------------------

export interface SpendScopeRequest {
  scopeKind: "org" | "initiative" | "team" | "project";
  scopeId: string | null;
}

/**
 * Resolve a forecast/anomaly request to the EXACT project ids the caller may
 * query. This is deliberately a thin adapter over ADR-0047's
 * `evaluateReportAccess`: the request is expressed as the report definition it
 * is equivalent to, and the SAME function decides. The alternative — a second
 * set of rules that happens to agree today — is how two surfaces drift into
 * disagreeing about who may see a team's spend, and the disagreement is always
 * discovered by the person who saw too much.
 *
 * The entitlement scope is derived from the request rather than stored: an
 * org-wide question needs an `org` grant (admin-only), a team question a `team`
 * grant, everything else a `project` grant.
 */
export function resolveSpendAccess(input: {
  isAdmin: boolean;
  userId: string | null;
  request: SpendScopeRequest;
  scopeProjectIds: string[];
  callerProjectIds: string[];
  callerTeamIds: string[];
}): ReportAccessDecision {
  return evaluateReportAccess({
    isAdmin: input.isAdmin,
    userId: input.userId,
    definition: {
      kind: "exec_summary",
      scopeKind: input.request.scopeKind,
      scopeId: input.request.scopeId,
      entitlementScope:
        input.request.scopeKind === "org"
          ? "org"
          : input.request.scopeKind === "team"
            ? "team"
            : "project",
    },
    scopeProjectIds: input.scopeProjectIds,
    callerProjectIds: input.callerProjectIds,
    callerTeamIds: input.callerTeamIds,
  });
}

async function decideFor(
  db: Db,
  actor: { userId: string | null; isAdmin: boolean },
  request: SpendScopeRequest,
): Promise<ReportAccessDecision> {
  return resolveSpendAccess({
    isAdmin: actor.isAdmin,
    userId: actor.userId,
    request,
    scopeProjectIds: await resolveScopeProjectIds(db, request),
    callerProjectIds: await callerProjectIds(db, actor.userId),
    callerTeamIds: await callerTeamIds(db, actor.userId),
  });
}

/** THE SCOPE PREDICATE, built once per query from the decision's id list.
 * `null` (an admin org request) means no project constraint at all — the only
 * way un-attributed spend (`project_id IS NULL`) enters an answer. */
function usageScope(projectIds: string[] | null) {
  if (projectIds === null) return undefined;
  return inArray(usageEvents.projectId, projectIds.length ? projectIds : [ZERO_UUID]);
}

// ---------------------------------------------------------------------------
// Period resolution — UTC, half-open, matching ADR-0047 exactly
// ---------------------------------------------------------------------------

export type ForecastPeriod = "current_month" | "current_quarter" | "last_30_days";

export function resolveForecastPeriod(
  period: ForecastPeriod,
  now: Date,
): { start: Date; end: Date; label: string; periodDays: number; elapsedDays: number } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const utc = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm, dd));
  let start: Date;
  let end: Date;
  let label: string;
  switch (period) {
    case "current_month":
      start = utc(y, m, 1);
      end = utc(y, m + 1, 1);
      label = `${y}-${String(m + 1).padStart(2, "0")}`;
      break;
    case "current_quarter": {
      const q = Math.floor(m / 3);
      start = utc(y, q * 3, 1);
      end = utc(y, q * 3 + 3, 1);
      label = `${y}-Q${q + 1}`;
      break;
    }
    case "last_30_days":
      end = new Date(now.getTime());
      start = new Date(end.getTime() - 30 * DAY_MS);
      label = "last 30 days";
      break;
  }
  const periodDays = (end.getTime() - start.getTime()) / DAY_MS;
  // elapsed is CLAMPED into the window: a `last_30_days` request is fully
  // elapsed by construction, and a clock skew must never produce a negative
  // elapsed fraction that would make the projection explode.
  const elapsedDays = Math.min(
    periodDays,
    Math.max(0, (now.getTime() - start.getTime()) / DAY_MS),
  );
  return { start, end, label, periodDays, elapsedDays };
}

// ---------------------------------------------------------------------------
// THE FORECAST
// ---------------------------------------------------------------------------

export interface ComputedForecast extends ForecastResult {
  scope: { kind: string; id: string | null; projectIds: string[] | null };
  period: { period: ForecastPeriod; label: string; start: string; end: string };
  periodDays: number;
  elapsedDays: number;
  generatedAt: string;
  scheduledChanges: Array<{ id: string; deltaUsd: number; effectiveAt: string; reason: string }>;
}

export async function computeForecast(
  db: Db,
  args: {
    decision: ReportAccessDecision;
    request: SpendScopeRequest;
    period: ForecastPeriod;
    method: "run_rate" | "ewma";
    now: Date;
  },
): Promise<ComputedForecast> {
  const { start, end, label, periodDays, elapsedDays } = resolveForecastPeriod(args.period, args.now);
  const projectIds = args.decision.projectIds;
  const scope = usageScope(projectIds);

  // the MEASURED history: one row per event, bucketed into UTC days by the
  // pure helper. Only rows up to `now` exist, so the bucket array is truncated
  // to the elapsed days — a projection must never treat future empty days as
  // observed zeros.
  const rows = await db
    .select({ at: usageEvents.at, costUsd: usageEvents.costUsd })
    .from(usageEvents)
    .where(and(gte(usageEvents.at, start), lt(usageEvents.at, args.now), ...(scope ? [scope] : [])));
  const elapsedBuckets = Math.max(1, Math.ceil(elapsedDays));
  const daily = bucketDaily(
    rows.map((r) => ({ at: r.at, value: r.costUsd ?? 0 })),
    start,
    new Date(start.getTime() + elapsedBuckets * DAY_MS),
  );

  // DECIDED future changes still ahead in this period. Nothing else is
  // anticipated; an undeclared change simply makes the projection wrong, and
  // the payload's `limits` says so.
  const pending =
    projectIds === null
      ? await db
          .select()
          .from(spendScheduledChanges)
          .where(and(gte(spendScheduledChanges.effectiveAt, args.now), lt(spendScheduledChanges.effectiveAt, end)))
      : projectIds.length === 0
        ? []
        : await db
            .select()
            .from(spendScheduledChanges)
            .where(
              and(
                inArray(spendScheduledChanges.projectId, projectIds),
                gte(spendScheduledChanges.effectiveAt, args.now),
                lt(spendScheduledChanges.effectiveAt, end),
              ),
            );
  const scheduledDeltaUsd = pending.reduce((a, c) => a + c.deltaUsd, 0);

  // the budget the forecast is measured against: the sum of the in-scope
  // projects' own budgets. Null when none of them carries one — an implied
  // budget of zero would turn every project into an over-budget project.
  const budgetRows =
    projectIds === null
      ? await db.select({ budgetUsd: projects.budgetUsd }).from(projects)
      : projectIds.length === 0
        ? []
        : await db
            .select({ budgetUsd: projects.budgetUsd })
            .from(projects)
            .where(inArray(projects.id, projectIds));
  const budgeted = budgetRows.filter((b) => b.budgetUsd != null);
  const budgetUsd = budgeted.length > 0 ? budgeted.reduce((a, b) => a + (b.budgetUsd ?? 0), 0) : null;

  const result = forecastSpend({
    dailyTotals: daily,
    periodDays,
    elapsedDays,
    method: args.method,
    scheduledDeltaUsd,
    budgetUsd,
  });

  return {
    ...result,
    scope: { kind: args.request.scopeKind, id: args.request.scopeId, projectIds },
    period: { period: args.period, label, start: start.toISOString(), end: end.toISOString() },
    periodDays,
    elapsedDays: Number(elapsedDays.toFixed(6)),
    generatedAt: args.now.toISOString(),
    scheduledChanges: pending.map((c) => ({
      id: c.id,
      deltaUsd: c.deltaUsd,
      effectiveAt: c.effectiveAt.toISOString(),
      reason: c.reason,
    })),
  };
}

// ---------------------------------------------------------------------------
// THE ANOMALY EVALUATOR
// ---------------------------------------------------------------------------

/** The effective policy for a project: its own row if it has one, else the
 * org-wide default row, else the built-in defaults (which are OFF). */
export async function effectivePolicy(
  db: Db,
  projectId: string,
): Promise<SpendMonitorPolicyRow | { synthetic: true } & Omit<SpendMonitorPolicyRow, "id" | "createdAt">> {
  const [own] = await db
    .select()
    .from(spendMonitorPolicies)
    .where(eq(spendMonitorPolicies.projectId, projectId));
  if (own) return own;
  const [orgDefault] = await db
    .select()
    .from(spendMonitorPolicies)
    .where(sql`${spendMonitorPolicies.projectId} IS NULL`);
  if (orgDefault) return orgDefault;
  return {
    synthetic: true,
    projectId: null,
    enabled: false,
    sensitivity: "medium",
    baselineDays: 30,
    action: "alert",
    signals: null,
    activeHourStart: null,
    activeHourEnd: null,
    lastEvaluatedAt: null,
    updatedByUserId: null,
  };
}

export interface EvaluatedProject {
  projectId: string;
  projectName: string;
  evaluated: boolean;
  reason: string;
  verdicts: Array<AnomalyVerdict & { recorded: boolean; anomalyId?: string; approvalId?: string | null }>;
}

/**
 * Evaluate ONE project's most recent complete day against its own trailing
 * baseline. The observation window is the last COMPLETE UTC day, not a partial
 * one: comparing six hours of today against full days of history would fire on
 * nothing and, worse, would fire on the reverse (a quiet morning reading as a
 * collapse) if the rule were two-sided.
 */
export async function evaluateProjectAnomalies(
  db: Db,
  args: {
    projectId: string;
    projectName: string;
    budgetApproverUserId: string | null;
    policy: Awaited<ReturnType<typeof effectivePolicy>>;
    /** ADR-0049 §4 / ADR-0027 §9: the compliance cascade's budgetEnforcement
     * for this project's tags, mapped to `decideEnforcement`'s floor
     * vocabulary ('block' | 'warn' | null). Resolved by the caller from the
     * SAME `complianceProfilesForTags` funnel the dispatch gate reads, so a
     * `block`-mandating framework tightens the anomaly response and can never
     * be relaxed by a softer policy action. An untagged project passes null
     * and is byte-identical to before. */
    frameworkFloor: "warn" | "block" | null;
    now: Date;
    actorUserId: string | null;
  },
): Promise<EvaluatedProject> {
  const { policy, now } = args;
  if (!policy.enabled) {
    return {
      projectId: args.projectId,
      projectName: args.projectName,
      evaluated: false,
      reason:
        "spend monitoring is not enabled for this project (ADR-0049 §3: OFF by default, admin-enabled) — " +
        "no baseline is computed and no claim is made",
      verdicts: [],
    };
  }

  // [windowStart, windowEnd) is the last COMPLETE UTC day; the baseline is the
  // `baselineDays` complete days BEFORE it, and never includes the observation.
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const windowEnd = todayStart;
  const windowStart = new Date(windowEnd.getTime() - DAY_MS);
  const baselineStart = new Date(windowStart.getTime() - policy.baselineDays * DAY_MS);

  const rows = await db
    .select({
      at: usageEvents.at,
      costUsd: usageEvents.costUsd,
      inputTokens: usageEvents.inputTokens,
      outputTokens: usageEvents.outputTokens,
      model: usageEvents.model,
      objectType: usageEvents.objectType,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.projectId, args.projectId),
        gte(usageEvents.at, baselineStart),
        lt(usageEvents.at, windowEnd),
      ),
    );

  const inWindow = rows.filter((r) => r.at >= windowStart);
  const inBaseline = rows.filter((r) => r.at < windowStart);

  const dayCount = policy.baselineDays;
  const baselineCost = bucketDaily(
    inBaseline.map((r) => ({ at: r.at, value: r.costUsd ?? 0 })),
    baselineStart,
    windowStart,
  );
  const baselineTokens = bucketDaily(
    inBaseline.map((r) => ({ at: r.at, value: (r.inputTokens ?? 0) + (r.outputTokens ?? 0) })),
    baselineStart,
    windowStart,
  );
  const baselineEgress = bucketDaily(
    inBaseline
      .filter((r) => r.objectType !== "agent")
      .map((r) => ({ at: r.at, value: 1 })),
    baselineStart,
    windowStart,
  );

  const observedCost = inWindow.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  const observedTokens = inWindow.reduce((a, r) => a + (r.inputTokens ?? 0) + (r.outputTokens ?? 0), 0);
  const observedEgress = inWindow.filter((r) => r.objectType !== "agent").length;

  // COLD START, decided on the ledger rather than on the calendar: a project
  // with `baselineDays` of zeros has plenty of buckets but no history. The
  // detector's own MIN_BASELINE_SAMPLES rail then applies to the buckets that
  // actually carry data.
  const activeBaselineDays = baselineCost.filter((d) => d > 0).length;
  if (activeBaselineDays < MIN_BASELINE_SAMPLES) {
    return {
      projectId: args.projectId,
      projectName: args.projectName,
      evaluated: false,
      reason:
        `BASELINE BUILDING: ${activeBaselineDays} day(s) with measured spend in the trailing ` +
        `${dayCount}-day window, below the ${MIN_BASELINE_SAMPLES} required. No anomaly claim is made ` +
        "for this project — only the static budget and compliance-framework caps apply (ADR-0049 §5).",
      verdicts: [],
    };
  }

  const wanted: AnomalySignal[] = (policy.signals as AnomalySignal[] | null) ?? [...ANOMALY_SIGNALS];
  const verdicts: EvaluatedProject["verdicts"] = [];

  const nonZero = (xs: number[]) => xs.filter((x) => x > 0);

  for (const signal of wanted) {
    let verdict: AnomalyVerdict;
    switch (signal) {
      case "spend_spike":
        verdict = detectAnomaly({
          signal,
          baseline: nonZero(baselineCost),
          observed: observedCost,
          sensitivity: policy.sensitivity,
        });
        break;
      case "token_volume":
        verdict = detectAnomaly({
          signal,
          baseline: nonZero(baselineTokens),
          observed: observedTokens,
          sensitivity: policy.sensitivity,
        });
        break;
      case "egress_volume":
        verdict = detectAnomaly({
          signal,
          baseline: nonZero(baselineEgress),
          observed: observedEgress,
          sensitivity: policy.sensitivity,
        });
        break;
      case "unusual_model": {
        // the single most expensive model in the window that the project has
        // rarely used — one verdict, not one per model, because a flag per
        // model on a diverse day is noise rather than signal
        const historicalCounts: Record<string, number> = {};
        for (const r of inBaseline) if (r.model) historicalCounts[r.model] = (historicalCounts[r.model] ?? 0) + 1;
        const byModel = new Map<string, number>();
        for (const r of inWindow) if (r.model) byModel.set(r.model, (byModel.get(r.model) ?? 0) + (r.costUsd ?? 0));
        const worst = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0];
        if (!worst) continue;
        verdict = detectUnusualModel({
          model: worst[0],
          historicalCounts,
          observedSpendUsd: worst[1],
        });
        break;
      }
      case "off_hours": {
        const active =
          policy.activeHourStart != null && policy.activeHourEnd != null
            ? hourRange(policy.activeHourStart, policy.activeHourEnd)
            : activeHours(inBaseline.map((r) => ({ hour: r.at.getUTCHours(), value: r.costUsd ?? 0 })));
        if (active.length === 0) continue; // no derivable active window — no claim
        const activeSet = new Set(active);
        const offHoursBaseline = bucketDaily(
          inBaseline.filter((r) => !activeSet.has(r.at.getUTCHours())).map((r) => ({ at: r.at, value: r.costUsd ?? 0 })),
          baselineStart,
          windowStart,
        );
        const offHoursObserved = inWindow
          .filter((r) => !activeSet.has(r.at.getUTCHours()))
          .reduce((a, r) => a + (r.costUsd ?? 0), 0);
        verdict = detectAnomaly({
          signal,
          baseline: nonZero(offHoursBaseline),
          observed: offHoursObserved,
          sensitivity: policy.sensitivity,
        });
        break;
      }
    }

    if (!verdict.fired) {
      verdicts.push({ ...verdict, recorded: false });
      continue;
    }

    // FIRED. Decide the response — the framework floor may tighten it, and a
    // missing approver declines the escalation rather than inventing one.
    const enforcement = decideEnforcement({
      action: policy.action,
      frameworkFloor: args.frameworkFloor,
      hasApprover: Boolean(args.budgetApproverUserId),
    });

    let approvalId: string | null = null;
    if (enforcement.escalate) {
      // the SAME queue the project-budget cap uses, deduped the same way
      const [pendingItem] = await db
        .select({ id: approvals.id })
        .from(approvals)
        .where(
          and(
            eq(approvals.projectId, args.projectId),
            eq(approvals.stageId, SPEND_ANOMALY_STAGE),
            eq(approvals.status, "pending"),
          ),
        )
        .limit(1);
      if (pendingItem) approvalId = pendingItem.id;
      else {
        const [created] = await db
          .insert(approvals)
          .values({
            userId: args.actorUserId ?? args.budgetApproverUserId!,
            objectType: "project",
            projectId: args.projectId,
            stageId: SPEND_ANOMALY_STAGE,
            approverUserId: args.budgetApproverUserId!,
          })
          .returning({ id: approvals.id });
        approvalId = created!.id;
      }
    }

    // IDEMPOTENT: the unique index on (project, signal, window) means a cron
    // driven ten times an hour records ONE incident, not ten.
    const [row] = await db
      .insert(spendAnomalies)
      .values({
        projectId: args.projectId,
        signal,
        method: verdict.method!,
        observed: verdict.observed,
        baselineMedian: verdict.baselineMedian,
        baselineMad: verdict.baselineMad,
        baselineSamples: verdict.baselineSamples,
        score: verdict.score,
        threshold: verdict.threshold,
        absoluteFloor: verdict.absoluteFloor,
        windowStart,
        windowEnd,
        explanation: verdict.explanation,
        action: enforcement.effect,
        approvalId,
        detail: {
          enforcement: enforcement.ruleId,
          enforcementReason: enforcement.reason,
          frameworkFloor: args.frameworkFloor,
        },
      })
      .onConflictDoNothing()
      .returning({ id: spendAnomalies.id });

    if (row) {
      await db.insert(auditLog).values({
        userId: args.actorUserId ?? NO_IDENTITY,
        objectType: "project",
        objectId: args.projectId,
        detail: {
          phase: "spend-anomaly",
          signal,
          method: verdict.method,
          observed: verdict.observed,
          baselineMedian: verdict.baselineMedian,
          threshold: verdict.threshold,
          baselineSamples: verdict.baselineSamples,
          windowStart: windowStart.toISOString(),
          windowEnd: windowEnd.toISOString(),
          action: enforcement.effect,
          approvalId,
        },
        effect: enforcement.escalate ? "require_approval" : "allow",
        ruleId: enforcement.escalate ? "spend-anomaly-escalated" : "spend-anomaly-detected",
        ruleChain: [],
        reason: `${verdict.explanation} ${enforcement.reason}`,
      });
    }
    verdicts.push({ ...verdict, recorded: Boolean(row), ...(row ? { anomalyId: row.id } : {}), approvalId });
  }

  return {
    projectId: args.projectId,
    projectName: args.projectName,
    evaluated: true,
    reason: `evaluated ${verdicts.length} signal(s) against a ${activeBaselineDays}-day measured baseline`,
    verdicts,
  };
}

/** inclusive hour range, wrapping midnight when end < start */
function hourRange(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 24; i++) {
    const h = (start + i) % 24;
    out.push(h);
    if (h === end) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The anomaly evaluator
// ---------------------------------------------------------------------------

export const SPEND_ANOMALY_SWEEP_NOTE =
  "ADR-0064's in-process scheduler drives this when it is switched on (REGULAIT_SCHEDULER=on); this " +
  "endpoint is the manual/on-demand path and calls exactly the same function. A deployment running " +
  "neither raises NO anomalies, and a policy's `lastEvaluatedAt` staying null is how that stays visible " +
  "rather than silent. A project below the baseline sample floor is reported as 'baseline building' and " +
  "makes no claim either way. Spend figures are list-price ESTIMATES computed over usage_events.";

/**
 * ONE PASS of the anomaly evaluator over every project (or one named project).
 *
 * Extracted from `POST /v1/spend/anomalies/evaluate` for ADR-0064 so the
 * scheduler and the endpoint share ONE implementation. Idempotence is a
 * property of the DATA, not of the caller: the unique index on
 * `(project, signal, window_start, window_end)` means a second pass over the
 * same window raises nothing new, which is what makes it safe to run this both
 * on a timer and by hand.
 */
export async function runSpendAnomalyEvaluation(
  db: Db,
  opts: { actorUserId: string | null; projectId?: string; now?: Date },
): Promise<{ evaluatedAt: string; results: EvaluatedProject[] }> {
  const now = opts.now ?? new Date();
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      budgetApproverUserId: projects.budgetApproverUserId,
      classifications: projects.classifications,
    })
    .from(projects)
    .where(opts.projectId ? eq(projects.id, opts.projectId) : undefined);

  const results: EvaluatedProject[] = [];
  for (const p of rows) {
    const policy = await effectivePolicy(db, p.id);
    // ADR-0049 §4: source the framework cost floor from ADR-0027 §9's cascade —
    // the SAME funnel `preDispatchProjectGate` reads, so the two enforcement
    // points cannot diverge. An untagged project resolves with NO query
    // (`profilesForTags([])` short-circuits) and stays byte-identical; a
    // profile with versions but no active one throws the same
    // config-version-unresolvable the dispatch path refuses on, loudly, rather
    // than guessing a floor. `budgetEnforcement` maps onto `decideEnforcement`'s
    // floor vocabulary: block -> 'block' (tightens), warn_only -> 'warn'
    // (no-op by design — only 'block' raises the response), absent -> null.
    const tags = (p.classifications ?? []) as string[];
    const budgetEnforcement = effectiveCompliancePolicy(
      await complianceProfilesForTags(db, tags),
    ).budgetEnforcement;
    const frameworkFloor =
      budgetEnforcement === "block" ? ("block" as const)
      : budgetEnforcement === "warn_only" ? ("warn" as const)
      : null;
    const out = await evaluateProjectAnomalies(db, {
      projectId: p.id,
      projectName: p.name,
      budgetApproverUserId: p.budgetApproverUserId,
      policy,
      frameworkFloor,
      now,
      actorUserId: opts.actorUserId,
    });
    results.push(out);
    if (policy.enabled && "id" in policy) {
      await db
        .update(spendMonitorPolicies)
        .set({ lastEvaluatedAt: now })
        .where(eq(spendMonitorPolicies.id, policy.id));
    }
  }

  const fired = results.flatMap((r) => r.verdicts.filter((v) => v.fired));
  await db.insert(auditLog).values({
    userId: opts.actorUserId ?? NO_IDENTITY,
    objectType: "project",
    objectId: opts.projectId ?? null,
    detail: { phase: "spend-anomaly-sweep", projects: rows.length, fired: fired.length },
    effect: "allow",
    ruleId: "spend-anomaly-swept",
    ruleChain: [],
    reason:
      `anomaly evaluation over ${rows.length} project(s): ` +
      `${results.filter((r) => r.evaluated).length} evaluated, ${fired.length} signal(s) fired`,
  });

  return { evaluatedAt: now.toISOString(), results };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerSpendMonitorRoutes(app: FastifyInstance, db: Db): void {
  async function audit(
    actor: string | null,
    objectId: string | null,
    ruleId: string,
    reason: string,
    detail: Record<string, unknown>,
    effect: "allow" | "deny" | "require_approval" = "allow",
  ) {
    await db.insert(auditLog).values({
      userId: actor ?? NO_IDENTITY,
      objectType: "project",
      objectId,
      detail,
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });
  }

  // --- the forecast (NON-ADMIN reachable, entitlement-scoped) --------------

  app.get("/v1/spend/forecast", async (req, reply) => {
    const q = forecastQuerySchema.parse(req.query ?? {});
    const request: SpendScopeRequest = q.projectId
      ? { scopeKind: "project", scopeId: q.projectId }
      : q.teamId
        ? { scopeKind: "team", scopeId: q.teamId }
        : { scopeKind: "org", scopeId: null };
    const decision = await decideFor(db, req.authCtx, request);
    if (!decision.allowed) {
      // THE REFUSAL IS THE RECORD. A forecast aggregates across teams exactly
      // as a report does, so "who was told no, and for which scope" belongs in
      // the trail as much as what was produced.
      await audit(
        req.authCtx.userId ?? null,
        request.scopeId,
        "spend-forecast-denied",
        decision.reason,
        { phase: "forecast", scopeKind: request.scopeKind, ruleId: decision.ruleId },
        "deny",
      );
      return reply.status(403).send({ error: "spend_scope_not_entitled", detail: decision.reason });
    }

    const now = new Date();
    const forecast = await computeForecast(db, {
      decision,
      request,
      period: q.period,
      method: q.method,
      now,
    });

    const [run] = await db
      .insert(spendForecastRuns)
      .values({
        requestedByUserId: req.authCtx.userId ?? null,
        scopeKind: request.scopeKind,
        scopeId: request.scopeId,
        effectiveProjectIds: decision.projectIds,
        method: q.method,
        period: q.period,
        periodStart: new Date(forecast.period.start),
        periodEnd: new Date(forecast.period.end),
        sufficient: forecast.sufficient,
        projectedSpendUsd: forecast.projectedSpendUsd,
        lowUsd: forecast.lowUsd,
        highUsd: forecast.highUsd,
        spendToDateUsd: forecast.spendToDateUsd,
        payload: forecast as unknown as Record<string, unknown>,
      })
      .returning({ id: spendForecastRuns.id });

    await audit(
      req.authCtx.userId ?? null,
      request.scopeId,
      "spend-forecast-computed",
      `${q.method} forecast over ${forecast.period.label} for ` +
        (decision.projectIds === null
          ? "the whole organization (admin, org-scoped request)"
          : `${decision.projectIds.length} entitled project(s)`) +
        (forecast.sufficient
          ? ` — projected $${forecast.projectedSpendUsd} (95% CI $${forecast.lowUsd}–$${forecast.highUsd}); a projection, not a commitment`
          : ` — INSUFFICIENT DATA, no number claimed: ${forecast.insufficientReason}`),
      {
        phase: "forecast",
        method: q.method,
        period: q.period,
        sufficient: forecast.sufficient,
        projectedSpendUsd: forecast.projectedSpendUsd,
        effectiveProjectIds: decision.projectIds,
        effectiveProjectCount: decision.projectIds === null ? null : decision.projectIds.length,
        runId: run!.id,
      },
    );

    return { runId: run!.id, forecast, scope: { effectiveProjectIds: decision.projectIds, reason: decision.reason } };
  });

  // --- anomalies (NON-ADMIN reachable READ, entitlement-scoped) ------------

  app.get("/v1/spend/anomalies", async (req) => {
    const q = z
      .object({
        projectId: z.string().uuid().optional(),
        status: z.enum(["open", "acknowledged", "dismissed"]).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query ?? {});

    // the SAME narrowing as everywhere else: an admin sees all, anyone else
    // sees only projects they are a member of. Built into the WHERE clause.
    const mine = req.authCtx.isAdmin ? null : await callerProjectIds(db, req.authCtx.userId ?? null);
    const scoped =
      mine === null
        ? undefined
        : inArray(spendAnomalies.projectId, mine.length ? mine : [ZERO_UUID]);
    const rows = await db
      .select()
      .from(spendAnomalies)
      .where(
        and(
          ...(q.projectId ? [eq(spendAnomalies.projectId, q.projectId)] : []),
          ...(q.status ? [eq(spendAnomalies.status, q.status)] : []),
          ...(scoped ? [scoped] : []),
        ),
      )
      .orderBy(desc(spendAnomalies.detectedAt))
      .limit(q.limit);
    return {
      anomalies: rows,
      note:
        "An anomaly is a SIGNAL FOR HUMAN REVIEW, never proof of wrongdoing. Every row carries the " +
        "method, baseline, threshold and score it was derived from so it can be re-checked by hand. " +
        "Enforcement, where configured, rides the existing Approvals Queue.",
    };
  });

  app.patch("/v1/spend/anomalies/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = decideAnomalySchema.parse(req.body);
    const [row] = await db.select().from(spendAnomalies).where(eq(spendAnomalies.id, id));
    if (!row) return reply.status(404).send({ error: "unknown_anomaly" });
    if (row.status !== "open") return reply.status(409).send({ error: "already_decided", status: row.status });
    const [updated] = await db
      .update(spendAnomalies)
      .set({
        status: body.status,
        decidedByUserId: req.authCtx.userId ?? null,
        decidedAt: new Date(),
        decisionReason: body.reason,
      })
      .where(eq(spendAnomalies.id, id))
      .returning();
    await audit(
      req.authCtx.userId ?? null,
      row.projectId,
      body.status === "acknowledged" ? "spend-anomaly-acknowledged" : "spend-anomaly-dismissed",
      `spend anomaly (${row.signal}) ${body.status}: ${body.reason}. The flag row is retained either way — ` +
        "a dismissed signal stays in the ledger with its evidence and the reason it was dismissed.",
      { phase: "spend-anomaly-decision", signal: row.signal, status: body.status },
      body.status === "dismissed" ? "deny" : "allow",
    );
    return { anomaly: updated };
  });

  // --- policies (ADMIN) ----------------------------------------------------

  app.get("/v1/spend/monitor-policies", async () => {
    const rows = await db.select().from(spendMonitorPolicies);
    return {
      policies: rows,
      schedulerPresent: false,
      note:
        "These are evaluator DEFINITIONS. There is no in-process scheduler in this deployment: an " +
        "operator or an external cron must call POST /v1/spend/anomalies/evaluate, or no baseline is " +
        "ever computed and no anomaly is ever raised. `lastEvaluatedAt` staying null is how that is " +
        "visible rather than silent.",
    };
  });

  app.put("/v1/spend/monitor-policies", async (req, reply) => {
    const body = spendMonitorPolicySchema.parse(req.body);
    if (body.projectId) {
      const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, body.projectId));
      if (!p) return reply.status(404).send({ error: "unknown_project" });
    }
    const values = {
      projectId: body.projectId ?? null,
      enabled: body.enabled,
      sensitivity: body.sensitivity,
      baselineDays: body.baselineDays,
      action: body.action,
      signals: body.signals ?? null,
      activeHourStart: body.activeHourStart ?? null,
      activeHourEnd: body.activeHourEnd ?? null,
      updatedByUserId: req.authCtx.userId ?? null,
    };
    const [existing] = body.projectId
      ? await db.select().from(spendMonitorPolicies).where(eq(spendMonitorPolicies.projectId, body.projectId))
      : await db.select().from(spendMonitorPolicies).where(sql`${spendMonitorPolicies.projectId} IS NULL`);
    const [row] = existing
      ? await db.update(spendMonitorPolicies).set(values).where(eq(spendMonitorPolicies.id, existing.id)).returning()
      : await db.insert(spendMonitorPolicies).values(values).returning();
    await audit(
      req.authCtx.userId ?? null,
      body.projectId ?? null,
      "spend-monitor-policy-updated",
      `admin set the spend-monitor policy for ${body.projectId ? "a project" : "the org-wide default"}: ` +
        `enabled=${body.enabled}, sensitivity=${body.sensitivity}, baseline=${body.baselineDays}d, ` +
        `action=${body.action}. Storing a policy computes nothing — an operator must drive the evaluator.`,
      { phase: "spend-monitor-policy", enabled: body.enabled, sensitivity: body.sensitivity, action: body.action },
    );
    return { policy: row, note: "Nothing drives this. POST /v1/spend/anomalies/evaluate is the driver." };
  });

  // --- scheduled changes (ADMIN) ------------------------------------------

  app.post("/v1/spend/scheduled-changes", async (req, reply) => {
    const body = scheduledSpendChangeSchema.parse(req.body);
    const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, body.projectId));
    if (!p) return reply.status(404).send({ error: "unknown_project" });
    const [row] = await db
      .insert(spendScheduledChanges)
      .values({
        projectId: body.projectId,
        deltaUsd: body.deltaUsd,
        effectiveAt: new Date(body.effectiveAt),
        reason: body.reason,
        createdByUserId: req.authCtx.userId ?? null,
      })
      .returning();
    await audit(
      req.authCtx.userId ?? null,
      body.projectId,
      "spend-scheduled-change-created",
      `admin recorded a DECIDED future spend change of $${body.deltaUsd} effective ${body.effectiveAt}: ` +
        `${body.reason}. The forecast adds this on top of the extrapolation; nothing else is anticipated.`,
      { phase: "scheduled-change", deltaUsd: body.deltaUsd, effectiveAt: body.effectiveAt },
    );
    return reply.status(201).send({ scheduledChange: row });
  });

  app.get("/v1/spend/scheduled-changes", async (req) => {
    const q = z.object({ projectId: z.string().uuid().optional() }).parse(req.query ?? {});
    const rows = await db
      .select()
      .from(spendScheduledChanges)
      .where(q.projectId ? eq(spendScheduledChanges.projectId, q.projectId) : undefined)
      .orderBy(desc(spendScheduledChanges.effectiveAt));
    return { scheduledChanges: rows };
  });

  app.delete("/v1/spend/scheduled-changes/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db.select().from(spendScheduledChanges).where(eq(spendScheduledChanges.id, id));
    if (!row) return reply.status(404).send({ error: "unknown_scheduled_change" });
    await db.delete(spendScheduledChanges).where(eq(spendScheduledChanges.id, id));
    await audit(
      req.authCtx.userId ?? null,
      row.projectId,
      "spend-scheduled-change-deleted",
      "admin withdrew a decided future spend change; subsequent forecasts no longer include it",
      { phase: "scheduled-change", deltaUsd: row.deltaUsd },
      "deny",
    );
    return { deleted: true };
  });

  /**
   * THE EVALUATOR, as an ENDPOINT. ADR-0064's in-process scheduler now drives
   * the SAME function when it is switched on; this endpoint stays as the
   * manual / on-demand path. Admin-only, because it reads every project's
   * ledger.
   */
  app.post("/v1/spend/anomalies/evaluate", async (req) => {
    const q = z.object({ projectId: z.string().uuid().optional() }).parse(req.body ?? {});
    const result = await runSpendAnomalyEvaluation(db, {
      actorUserId: req.authCtx.userId ?? null,
      ...(q.projectId ? { projectId: q.projectId } : {}),
    });
    return { ...result, note: SPEND_ANOMALY_SWEEP_NOTE };
  });

  /** the read-side rollup the admin SPA's Spend monitor page renders */
  app.get("/v1/spend/monitor-overview", async () => {
    const policies = await db.select().from(spendMonitorPolicies);
    const [openCount] = await db
      .select({ n: count() })
      .from(spendAnomalies)
      .where(eq(spendAnomalies.status, "open"));
    const recent = await db
      .select()
      .from(spendAnomalies)
      .orderBy(desc(spendAnomalies.detectedAt))
      .limit(25);
    const changes = await db
      .select()
      .from(spendScheduledChanges)
      .orderBy(desc(spendScheduledChanges.effectiveAt))
      .limit(25);
    return {
      policies,
      openAnomalies: openCount?.n ?? 0,
      recentAnomalies: recent,
      scheduledChanges: changes,
      // ADR-0064: a scheduler now EXISTS, and whether it is switched ON in this
      // deployment is a different question — answered honestly rather than
      // hard-coded. `false` here still means "nothing drives this on a timer".
      schedulerPresent: resolveSchedulerConfig().enabled,
      schedulerPosture: resolveSchedulerConfig().reason,
      floors: ANOMALY_ABSOLUTE_FLOORS,
      minBaselineSamples: MIN_BASELINE_SAMPLES,
      note: SPEND_ANOMALY_SWEEP_NOTE,
    };
  });
}
