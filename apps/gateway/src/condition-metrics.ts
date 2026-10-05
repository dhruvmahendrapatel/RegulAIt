/**
 * ADR-0180 A2 (ADR-0175 batch D3) — MEASURABLE CONDITIONS. OWNER: A2.
 *
 * A condition of approval may carry a metric spec (metric, operator,
 * threshold, window, minimum samples, cadence, breach policy). It is measured
 * from the EXISTING ledgers — nothing here writes a second copy of a number:
 *
 *   trace_eval_flag_rate    trace_evaluations (ADR-0160), evaluated rows only
 *   guardrail_hits          audit_log guardrail-* rows (the 0155 partial index);
 *                           samples = governed calls in usage_events
 *   guardrail_mode          resolveGuardrailPolicy, per agent of the stack
 *   redteam_asr             redteam_runs, newest finished run per agent
 *   eval_mean_score/        eval_runs (red-team eval runs excluded), newest
 *   eval_pass_rate            completed run per agent
 *   spend_usd               usage_events (the one spend ledger, NOT trace cost)
 *   error_rate              traces, through the KRI measurement (kri.ts),
 *                           widened to the use case's project PLUS agent set
 *   pack_control_evidenced  evaluatePack over the use case's project
 *
 * THE RULES (each pinned by zz-adr0180-a2-conditions.test.ts, red-proven):
 *   - too few samples is `insufficient` and no data is `not_run` — never `pass`
 *     (`measurementStateFor` in @regulait/shared is the one place a state is
 *     decided);
 *   - a measured condition is closed as met ONLY by the evaluator: a system
 *     actor, audited, with the evidence. A manual `/met` is refused 422
 *     (`condition_evidence_failing` / `condition_not_manual`, use-cases.ts);
 *   - a met condition whose evidence later breaches keeps its met history and
 *     raises the monitor finding (`condition_metric_breached`);
 *   - `on_breach = reopen_review` reopens review only on the SECOND consecutive
 *     breached evaluation, through `reopenUseCaseReview` (review-policy.ts);
 *   - an admin waiver needs a reason (prose-scrubbed by the DB wrapper), stamps
 *     `met_at` and the `waived_*` columns, is audited, and the verdict reads
 *     `waived` — a gate warning, never a pass.
 *
 * Callers (A3's gate composition, A8, A10, the monitor) import from THIS
 * module: `measureAssuranceMetric`, `evaluateUseCaseConditions`,
 * `conditionMetricsMonitorInput`, `runConditionEvaluationSweep`.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  aiUseCases,
  and,
  auditLog,
  compliancePackControls,
  compliancePacks,
  desc,
  eq,
  evalRuns,
  gte,
  inArray,
  isNotNull,
  lte,
  ne,
  notInArray,
  redteamRuns,
  redteamTrials,
  sql,
  traceEvaluations,
  traces,
  usageEvents,
  useCaseConditions,
  users,
  type AiUseCaseRow,
  type Db,
  type SQL,
  type UseCaseConditionRow,
} from "@regulait/db";
import {
  CONDITION_EVALUATOR_ACTOR,
  CONDITION_METRIC_HELP,
  CONDITION_REOPEN_AFTER,
  GUARDRAIL_MODE_LEVEL,
  NOT_RUN_MEASUREMENT,
  approvalConditionSchema,
  conditionEvaluationDue,
  conditionSubjectKey,
  decideApprovalSchema,
  describeMetricCondition,
  measuredConditionInputSchema,
  measurementStateFor,
  nextConsecutiveBreaches,
  validateMetricParams,
  waiveConditionSchema,
  type AssuranceMonitorRuleId,
  type AssuranceScope,
  type ConditionVerdict,
  type EvaluateUseCaseConditionsFn,
  type EvidenceRef,
  type GuardrailMode,
  type MeasureAssuranceMetricFn,
  type Measurement,
  type MeasurementState,
  type MetricSpec,
  type MonitorAssuranceInput,
  type MonitorAssuranceSubject,
} from "@regulait/shared";
import { evaluatePack } from "./compliance-packs.js";
import { resolveGuardrailPolicy } from "./guardrails.js";
import { measureTraceMetricForScope } from "./kri.js";
import { reopenUseCaseReview } from "./review-policy.js";

export type { ConditionVerdict } from "@regulait/shared";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
const DAY_MS = 86_400_000;
/** how many ledger row ids a measurement cites */
const EVIDENCE_LIMIT = 20;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

const ref = (type: string, ids: readonly string[]): EvidenceRef[] => ids.slice(0, EVIDENCE_LIMIT).map((id) => ({ type, id }));

function finish(spec: MetricSpec, value: number | null, samples: number, evidence: EvidenceRef[], opts: { incomplete?: boolean } = {}): Measurement {
  let state = measurementStateFor({ value, samples, minSamples: spec.minSamples, operator: spec.operator, threshold: spec.threshold });
  // partial evidence (an agent with no run, unpriced spend) can show a breach
  // but can never show a pass
  if (opts.incomplete && state === "pass") state = "insufficient";
  return { value: state === "not_run" ? null : value, samples, state, evidence };
}

/** the usage/trace-style scope predicate: in the project, or by one of the agents */
function agentOrProject(agentCol: SQL, projectCol: SQL, scope: AssuranceScope): SQL {
  const parts: SQL[] = [];
  if (scope.agentIds.length > 0) parts.push(sql`${agentCol} in (${sql.join(scope.agentIds.map((a) => sql`${a}::uuid`), sql`, `)})`);
  if (scope.projectId) parts.push(sql`${projectCol} = ${scope.projectId}::uuid`);
  if (parts.length === 0) return sql`false`;
  return parts.length === 1 ? parts[0]! : sql`(${sql.join(parts, sql` or `)})`;
}

async function measureTraceEvalFlagRate(db: Db, spec: MetricSpec, scope: AssuranceScope, since: Date, now: Date, params: Record<string, unknown>) {
  const inScope = agentOrProject(
    sql`${traceEvaluations.agentId}`,
    sql`(select ${traces.projectId} from ${traces} where ${traces.id} = ${traceEvaluations.traceId})`,
    scope,
  );
  const detector = typeof params.detector === "string" ? params.detector : null;
  const flaggedExpr = detector
    ? sql`${traceEvaluations.flagged} and ${traceEvaluations.findings} @> ${JSON.stringify([{ detector }])}::jsonb`
    : sql`${traceEvaluations.flagged}`;
  const where = and(
    eq(traceEvaluations.outcome, "evaluated"),
    gte(traceEvaluations.spanStartedAt, since),
    lte(traceEvaluations.spanStartedAt, now),
    inScope,
  );
  const [agg] = await db
    .select({ n: sql<number>`count(*)::int`, flagged: sql<number>`(count(*) filter (where ${flaggedExpr}))::int` })
    .from(traceEvaluations)
    .where(where);
  const n = Number(agg?.n ?? 0);
  const flagged = Number(agg?.flagged ?? 0);
  const ids = await db
    .select({ id: traceEvaluations.id })
    .from(traceEvaluations)
    .where(and(where, flaggedExpr))
    .orderBy(desc(traceEvaluations.spanStartedAt))
    .limit(EVIDENCE_LIMIT);
  return finish(spec, n > 0 ? (flagged / n) * 100 : null, n, ref("trace_evaluation", ids.map((r) => r.id)));
}

/** governed calls in the window: the exposure a hit count is read against */
async function usageCount(db: Db, scope: AssuranceScope, since: Date, now: Date) {
  const [agg] = await db
    .select({
      n: sql<number>`count(*)::int`,
      priced: sql<number>`count(${usageEvents.costUsd})::int`,
      cost: sql<number | null>`sum(${usageEvents.costUsd})`,
    })
    .from(usageEvents)
    .where(and(gte(usageEvents.at, since), lte(usageEvents.at, now), agentOrProject(sql`${usageEvents.agentId}`, sql`${usageEvents.projectId}`, scope)));
  return { n: Number(agg?.n ?? 0), priced: Number(agg?.priced ?? 0), cost: agg?.cost === null || agg?.cost === undefined ? null : Number(agg.cost) };
}

async function measureGuardrailHits(db: Db, spec: MetricSpec, scope: AssuranceScope, since: Date, now: Date, params: Record<string, unknown>) {
  // the literal IN list is the 0155 partial index's predicate, so the planner can use it
  const parts: SQL[] = [];
  if (scope.agentIds.length > 0) {
    parts.push(
      sql`(${auditLog.objectType} = 'agent' and ${auditLog.objectId} in (${sql.join(scope.agentIds.map((a) => sql`${a}::uuid`), sql`, `)}))`,
    );
  }
  if (scope.projectId) parts.push(sql`(${auditLog.detail} ->> 'projectId') = ${scope.projectId}`);
  const where = and(
    sql`${auditLog.ruleId} in ('guardrail-blocked', 'guardrail-warned', 'guardrail-logged')`,
    typeof params.outcome === "string" ? eq(auditLog.ruleId, `guardrail-${params.outcome}`) : undefined,
    gte(auditLog.at, since),
    lte(auditLog.at, now),
    parts.length === 0 ? sql`false` : sql`(${sql.join(parts, sql` or `)})`,
  );
  const [agg] = await db.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(where);
  const hits = Number(agg?.n ?? 0);
  const ids = await db.select({ id: auditLog.id }).from(auditLog).where(where).orderBy(desc(auditLog.at)).limit(EVIDENCE_LIMIT);
  const calls = await usageCount(db, scope, since, now);
  return finish(spec, calls.n > 0 ? hits : null, calls.n, ref("audit_log", ids.map((r) => r.id)));
}

async function measureGuardrailMode(db: Db, spec: MetricSpec, scope: AssuranceScope, params: Record<string, unknown>) {
  const detector = String(params.detector);
  const targets: Array<{ agentId: string | null; evidence: string }> =
    scope.agentIds.length > 0
      ? scope.agentIds.map((a) => ({ agentId: a, evidence: a }))
      : [{ agentId: null, evidence: `project:${scope.projectId}` }];
  let weakest: number | null = null;
  for (const t of targets) {
    const policy = await resolveGuardrailPolicy(db, { projectId: scope.projectId, agentId: t.agentId });
    const mode = (policy.modes as Record<string, GuardrailMode | undefined>)[detector] ?? "off";
    const level = GUARDRAIL_MODE_LEVEL[mode];
    weakest = weakest === null ? level : Math.min(weakest, level);
  }
  return finish(spec, weakest, targets.length, ref("guardrail_policy", targets.map((t) => t.evidence)));
}

async function measureRedTeamAsr(db: Db, spec: MetricSpec, scope: AssuranceScope, since: Date, now: Date, params: Record<string, unknown>) {
  const rows = await db
    .select({
      id: redteamRuns.id,
      agentId: redteamRuns.agentId,
      asr: redteamRuns.asr,
      asrTrials: redteamRuns.asrTrials,
      classSummary: redteamRuns.classSummary,
    })
    .from(redteamRuns)
    .where(
      and(
        isNotNull(redteamRuns.finishedAt),
        gte(redteamRuns.finishedAt, since),
        lte(redteamRuns.finishedAt, now),
        agentOrProject(sql`${redteamRuns.agentId}`, sql`${redteamRuns.projectId}`, scope),
      ),
    )
    .orderBy(desc(redteamRuns.finishedAt), desc(redteamRuns.id));
  // the newest finished run per agent: a red-team result is about a configuration
  const newest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = r.agentId ?? `run:${r.id}`;
    if (!newest.has(key)) newest.set(key, r);
  }
  const attackClass = typeof params.attackClass === "string" ? params.attackClass : null;
  let defeats = 0;
  let trials = 0;
  for (const r of newest.values()) {
    if (attackClass) {
      const c = (r.classSummary as Array<{ attackClass?: string; probes?: number; defeated?: number }>).find((x) => x.attackClass === attackClass);
      if (c && Number(c.probes) > 0) {
        trials += Number(c.probes);
        defeats += Number(c.defeated ?? 0);
      }
    } else if (r.asr !== null && r.asrTrials > 0) {
      trials += r.asrTrials;
      defeats += r.asr * r.asrTrials;
    }
  }
  const missing = scope.agentIds.filter((a) => !newest.has(a));
  return finish(spec, trials > 0 ? (defeats / trials) * 100 : null, trials, ref("redteam_run", [...newest.values()].map((r) => r.id)), {
    incomplete: missing.length > 0,
  });
}

async function measureEval(db: Db, spec: MetricSpec, scope: AssuranceScope, since: Date, now: Date, params: Record<string, unknown>) {
  const redteamEvalIds = sql`(select ${redteamRuns.evalRunId} from ${redteamRuns} union select ${redteamTrials.evalRunId} from ${redteamTrials} where ${redteamTrials.evalRunId} is not null)`;
  const rows = await db
    .select({
      id: evalRuns.id,
      agentId: evalRuns.agentId,
      cases: evalRuns.cases,
      passedCases: evalRuns.passedCases,
      meanScore: evalRuns.meanScore,
    })
    .from(evalRuns)
    .where(
      and(
        eq(evalRuns.status, "completed"),
        isNotNull(evalRuns.finishedAt),
        gte(evalRuns.finishedAt, since),
        lte(evalRuns.finishedAt, now),
        sql`${evalRuns.id} not in ${redteamEvalIds}`,
        typeof params.datasetId === "string" ? eq(evalRuns.datasetId, params.datasetId) : undefined,
        agentOrProject(sql`${evalRuns.agentId}`, sql`${evalRuns.projectId}`, scope),
      ),
    )
    .orderBy(desc(evalRuns.finishedAt), desc(evalRuns.id));
  const newest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = r.agentId ?? `run:${r.id}`;
    if (!newest.has(key)) newest.set(key, r);
  }
  let cases = 0;
  let passed = 0;
  let scoreSum = 0;
  let scored = 0;
  for (const r of newest.values()) {
    if (r.cases <= 0) continue;
    cases += r.cases;
    passed += r.passedCases;
    if (r.meanScore !== null) {
      scoreSum += r.meanScore * r.cases;
      scored += r.cases;
    }
  }
  const missing = scope.agentIds.filter((a) => !newest.has(a));
  const value =
    spec.metric === "eval_mean_score" ? (scored > 0 ? scoreSum / scored : null) : cases > 0 ? (passed / cases) * 100 : null;
  return finish(spec, value, spec.metric === "eval_mean_score" ? scored : cases, ref("eval_run", [...newest.values()].map((r) => r.id)), {
    incomplete: missing.length > 0,
  });
}

async function measureSpend(db: Db, spec: MetricSpec, scope: AssuranceScope, since: Date, now: Date) {
  const u = await usageCount(db, scope, since, now);
  const ids = await db
    .select({ id: usageEvents.id })
    .from(usageEvents)
    .where(
      and(
        gte(usageEvents.at, since),
        lte(usageEvents.at, now),
        isNotNull(usageEvents.costUsd),
        agentOrProject(sql`${usageEvents.agentId}`, sql`${usageEvents.projectId}`, scope),
      ),
    )
    .orderBy(desc(usageEvents.costUsd), desc(usageEvents.at))
    .limit(EVIDENCE_LIMIT);
  // an unpriced call makes the total a lower bound: it can show a breach, never a pass
  return finish(spec, u.priced > 0 ? (u.cost ?? 0) : null, u.priced, ref("usage_event", ids.map((r) => r.id)), {
    incomplete: u.n > u.priced,
  });
}

async function measureErrorRate(db: Db, spec: MetricSpec, scope: AssuranceScope, since: Date, now: Date) {
  const m = await measureTraceMetricForScope(db, "error_rate", scope, since, now, EVIDENCE_LIMIT);
  return finish(spec, m.value, m.samples, ref("trace", m.traceIds));
}

async function measurePackControl(db: Db, spec: MetricSpec, scope: AssuranceScope, since: Date, now: Date, params: Record<string, unknown>) {
  if (!scope.projectId) return { ...NOT_RUN_MEASUREMENT, evidence: [] };
  const [pack] = await db
    .select()
    .from(compliancePacks)
    .where(and(eq(compliancePacks.framework, String(params.framework)), eq(compliancePacks.status, "active")))
    .orderBy(desc(compliancePacks.version))
    .limit(1);
  if (!pack) return { ...NOT_RUN_MEASUREMENT, evidence: [] };
  const [control] = await db
    .select()
    .from(compliancePackControls)
    .where(and(eq(compliancePackControls.packId, pack.id), eq(compliancePackControls.controlRef, String(params.controlRef))));
  if (!control) return { ...NOT_RUN_MEASUREMENT, evidence: [] };
  const scorecard = await evaluatePack(db, {
    pack,
    controls: [control],
    projectIds: [scope.projectId],
    periodStart: since,
    periodEnd: now,
    period: `${spec.windowDays}d`,
    periodLabel: `the last ${spec.windowDays} day${spec.windowDays === 1 ? "" : "s"}`,
    scopeKind: "project",
    scopeId: scope.projectId,
    now,
  });
  const a = scorecard.controls[0];
  const samples = a?.evidenceCount ?? 0;
  // an attestation is the customer's statement, not evidence: it never reads 1
  return finish(spec, a ? (a.status === "satisfied" ? 1 : 0) : null, samples, [{ type: "compliance_pack_control", id: control.id }]);
}

/**
 * Measure one metric over a use case's scope (its project plus its agent
 * set). Reused by A3, A8 and A10. Never throws for "no data": nothing in
 * scope, an unknown pack or control, or a malformed `params` is `not_run`.
 */
export const measureAssuranceMetric: MeasureAssuranceMetricFn<Db> = async (db, spec, scopeIn, now) => {
  const scope: AssuranceScope = { projectId: scopeIn.projectId, agentIds: [...new Set(scopeIn.agentIds.filter(Boolean))] };
  if (!scope.projectId && scope.agentIds.length === 0) return { ...NOT_RUN_MEASUREMENT, evidence: [] };
  const checked = validateMetricParams(spec.metric, spec.params);
  if (!checked.ok) return { ...NOT_RUN_MEASUREMENT, evidence: [] };
  const params = checked.params;
  const since = new Date(now.getTime() - spec.windowDays * DAY_MS);
  switch (spec.metric) {
    case "trace_eval_flag_rate":
      return measureTraceEvalFlagRate(db, spec, scope, since, now, params);
    case "guardrail_hits":
      return measureGuardrailHits(db, spec, scope, since, now, params);
    case "guardrail_mode":
      return measureGuardrailMode(db, spec, scope, params);
    case "redteam_asr":
      return measureRedTeamAsr(db, spec, scope, since, now, params);
    case "eval_mean_score":
    case "eval_pass_rate":
      return measureEval(db, spec, scope, since, now, params);
    case "spend_usd":
      return measureSpend(db, spec, scope, since, now);
    case "error_rate":
      return measureErrorRate(db, spec, scope, since, now);
    case "pack_control_evidenced":
      return measurePackControl(db, spec, scope, since, now, params);
  }
};

/** a use case's measurement scope: its project and its intended agents */
export function useCaseScope(uc: Pick<AiUseCaseRow, "projectId" | "intendedAgentIds">): AssuranceScope {
  return { projectId: uc.projectId, agentIds: [...new Set(uc.intendedAgentIds ?? [])] };
}

export function specOf(c: UseCaseConditionRow): MetricSpec | null {
  if (c.kind === "manual" || !c.metric || !c.operator || c.threshold === null || c.windowDays === null || c.minSamples === null) return null;
  return {
    metric: c.metric,
    params: c.params ?? {},
    operator: c.operator,
    threshold: c.threshold,
    windowDays: c.windowDays,
    minSamples: c.minSamples,
  };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function verdictOf(c: UseCaseConditionRow, measurement: Measurement | null, evaluatedAt: Date | null): ConditionVerdict {
  const waived = c.status === "waived";
  return {
    conditionId: c.id,
    useCaseId: c.useCaseId,
    kind: c.kind,
    text: c.text,
    blocking: c.blocking,
    status: c.status,
    state: waived ? "waived" : c.kind === "manual" ? "manual" : (measurement?.state ?? "not_run"),
    measurement: waived || c.kind === "manual" ? null : measurement,
    onBreach: c.onBreach,
    consecutiveBreaches: c.consecutiveBreaches,
    evaluatedAt: evaluatedAt ? evaluatedAt.toISOString() : null,
  };
}

export interface EvaluateConditionsOptions {
  persist: boolean;
  /** persist only the conditions whose cadence is due (the scheduler job) */
  onlyDue?: boolean;
  /** narrow the pass to these conditions (the admin "evaluate now" route) */
  conditionIds?: string[];
  /** the admin who asked for the evaluation; null = the scheduler */
  requestedBy?: string | null;
  dataKey?: string;
}

export interface ConditionEvaluationOutcome {
  verdicts: ConditionVerdict[];
  met: string[];
  breached: string[];
  reopened: boolean;
  skipped: Array<{ conditionId: string; reason: string }>;
}

/**
 * Evaluate a use case's conditions. Manual and waived conditions are reported
 * as they stand (never measured). With `persist`, each measured condition's
 * `last_*` columns, evidence and breach streak are written; an OPEN one whose
 * measurement passes is closed as met by the evaluator (system actor, audited
 * with the evidence); a `reopen_review` condition whose streak reaches
 * `CONDITION_REOPEN_AFTER` re-opens the use case's review.
 */
export async function evaluateConditionsDetailed(
  db: Db,
  useCaseId: string,
  now: Date,
  opts: EvaluateConditionsOptions,
): Promise<ConditionEvaluationOutcome> {
  const out: ConditionEvaluationOutcome = { verdicts: [], met: [], breached: [], reopened: false, skipped: [] };
  const [uc] = await db.select().from(aiUseCases).where(eq(aiUseCases.id, useCaseId));
  if (!uc) return out;
  const rows = await db
    .select()
    .from(useCaseConditions)
    .where(
      and(
        eq(useCaseConditions.useCaseId, useCaseId),
        opts.conditionIds?.length ? inArray(useCaseConditions.id, opts.conditionIds) : undefined,
      ),
    )
    .orderBy(useCaseConditions.dueAt, useCaseConditions.createdAt, useCaseConditions.id);
  const scope = useCaseScope(uc);
  let reopenFor: UseCaseConditionRow | null = null;
  for (const c of rows) {
    const spec = specOf(c);
    if (!spec || c.status === "waived") {
      out.verdicts.push(verdictOf(c, null, c.lastEvaluatedAt));
      continue;
    }
    const due = !opts.onlyDue || conditionEvaluationDue(c.lastEvaluatedAt, c.cadence, now);
    if (!due) {
      // not due: the verdict is the stored evaluation, unchanged
      const stored: Measurement | null = c.lastState
        ? { value: c.lastValue, samples: c.lastSamples ?? 0, state: c.lastState, evidence: c.evidence ?? [] }
        : null;
      out.verdicts.push(verdictOf(c, stored, c.lastEvaluatedAt));
      continue;
    }
    const m = await measureAssuranceMetric(db, spec, scope, now);
    if (!opts.persist) {
      out.verdicts.push(verdictOf(c, m, now));
      continue;
    }
    try {
      const written = await persistEvaluation(db, uc, c, spec, m, now, opts.requestedBy ?? null);
      out.verdicts.push(verdictOf(written.row, m, now));
      if (written.closed) out.met.push(c.id);
      if (m.state === "fail") out.breached.push(c.id);
      if (
        m.state === "fail" &&
        written.row.onBreach === "reopen_review" &&
        written.row.consecutiveBreaches === CONDITION_REOPEN_AFTER &&
        !reopenFor
      ) {
        reopenFor = written.row;
      }
    } catch (err) {
      out.skipped.push({ conditionId: c.id, reason: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
      out.verdicts.push(verdictOf(c, m, now));
    }
  }
  if (reopenFor) out.reopened = await reopenForBreach(db, uc.id, reopenFor, now, opts);
  return out;
}

async function persistEvaluation(
  db: Db,
  uc: AiUseCaseRow,
  c: UseCaseConditionRow,
  spec: MetricSpec,
  m: Measurement,
  now: Date,
  requestedBy: string | null,
): Promise<{ row: UseCaseConditionRow; closed: boolean }> {
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(useCaseConditions).where(eq(useCaseConditions.id, c.id)).for("update");
    if (!cur || cur.status === "waived") return { row: cur ?? c, closed: false };
    const breaches = nextConsecutiveBreaches(cur.consecutiveBreaches, m.state);
    // ONLY the evaluator closes a measured condition, and only on a pass
    const close = cur.status === "open" && m.state === "pass";
    const [row] = await tx
      .update(useCaseConditions)
      .set({
        lastValue: m.value,
        lastSamples: m.samples,
        lastState: m.state,
        lastEvaluatedAt: now,
        consecutiveBreaches: breaches,
        evidence: m.evidence,
        ...(close
          ? {
              status: "met" as const,
              metAt: now,
              metByUserId: null,
              note: `Closed by the condition evaluator on passing evidence: ${describeMetricCondition(spec)}; measured ${formatValue(spec, m.value)} over ${m.samples} sample(s).`,
            }
          : {}),
      })
      .where(eq(useCaseConditions.id, cur.id))
      .returning();
    const measurement = { value: m.value, samples: m.samples, state: m.state, evidence: m.evidence };
    if (close) {
      await tx.insert(auditLog).values({
        userId: NO_IDENTITY,
        objectType: "ai_use_case",
        objectId: uc.id,
        detail: {
          actor: CONDITION_EVALUATOR_ACTOR,
          phase: "condition-met",
          closedBy: "evaluator",
          conditionId: cur.id,
          approvalId: cur.approvalId,
          kind: cur.kind,
          blocking: cur.blocking,
          spec,
          measurement,
          ...(requestedBy ? { requestedBy } : {}),
        },
        effect: "allow",
        ruleId: "use-case-condition-met",
        ruleChain: [],
        reason:
          `measured condition on AI use case '${uc.name}' met on passing evidence` +
          `${cur.blocking ? " (before go-live — no longer blocks deployment)" : " (after go-live)"}: ` +
          `${describeMetricCondition(spec)}; measured ${formatValue(spec, m.value)} over ${m.samples} sample(s)`,
      });
    } else if (cur.lastState !== m.state) {
      // a state CHANGE is a fact worth the ledger; an unchanged re-measurement is not
      await tx.insert(auditLog).values({
        userId: NO_IDENTITY,
        objectType: "ai_use_case",
        objectId: uc.id,
        detail: {
          actor: CONDITION_EVALUATOR_ACTOR,
          phase: "condition-evaluated",
          conditionId: cur.id,
          from: cur.lastState,
          to: m.state,
          status: cur.status,
          consecutiveBreaches: breaches,
          spec,
          measurement,
          ...(requestedBy ? { requestedBy } : {}),
        },
        effect: m.state === "fail" ? "deny" : "allow",
        ruleId: "use-case-condition-evaluated",
        ruleChain: [],
        reason:
          `measured condition on AI use case '${uc.name}' now reads ${m.state.replace("_", " ")}` +
          `${cur.status === "met" && m.state === "fail" ? " after it was met (its met history stands; the monitor raises it)" : ""}: ` +
          `${describeMetricCondition(spec)}; measured ${formatValue(spec, m.value)} over ${m.samples} sample(s)`,
      });
    }
    return { row: row ?? cur, closed: close };
  });
}

async function reopenForBreach(db: Db, useCaseId: string, cond: UseCaseConditionRow, now: Date, opts: EvaluateConditionsOptions): Promise<boolean> {
  const spec = specOf(cond)!;
  let postCommit: ((d: Db) => Promise<void>) | null = null;
  const done = await db.transaction(async (tx) => {
    const [uc] = await tx.select().from(aiUseCases).where(eq(aiUseCases.id, useCaseId)).for("update");
    // only a LIVE approval is re-opened; one already back in review is left alone
    if (!uc || uc.status !== "approved") return false;
    const reason =
      `measured condition breached ${CONDITION_REOPEN_AFTER} consecutive evaluations on AI use case '${uc.name}': ` +
      describeMetricCondition(spec);
    const r = await reopenUseCaseReview(tx as Tx, uc, reason, {
      actorUserId: opts.requestedBy ?? null,
      systemActor: CONDITION_EVALUATOR_ACTOR,
      recertification: false,
      ...(opts.dataKey ? { dataKey: opts.dataKey } : {}),
    });
    if (!r.ok) {
      await tx.insert(auditLog).values({
        userId: NO_IDENTITY,
        objectType: "ai_use_case",
        objectId: uc.id,
        detail: { actor: CONDITION_EVALUATOR_ACTOR, phase: "condition-reopen-skipped", conditionId: cond.id, reason: r.reason },
        effect: "deny",
        ruleId: "use-case-condition-reopen-skipped",
        ruleChain: [],
        reason: `measured condition on AI use case '${uc.name}' breached twice, but its review could not be re-opened: ${r.reason}`,
      });
      return false;
    }
    postCommit = r.postCommit;
    await tx.insert(auditLog).values({
      userId: opts.requestedBy ?? NO_IDENTITY,
      objectType: "ai_use_case",
      objectId: uc.id,
      detail: {
        ...(opts.requestedBy ? {} : { actor: CONDITION_EVALUATOR_ACTOR }),
        phase: "condition-breach-reopened",
        from: "approved",
        to: "under_review",
        conditionId: cond.id,
        consecutiveBreaches: cond.consecutiveBreaches,
        spec,
        measurement: { value: cond.lastValue, samples: cond.lastSamples, state: cond.lastState, evidence: cond.evidence },
        workflowInstanceId: r.instanceId,
        workflowRound: r.workflowRound,
        reviewRound: r.reviewRound,
        roles: r.roles,
        approvalIds: r.approvalIds,
        evaluatedAt: now.toISOString(),
      },
      effect: "deny",
      ruleId: "use-case-condition-breach-reopened",
      ruleChain: [],
      reason: `${reason} — back in review; deployment is refused until it is re-approved`,
    });
    return true;
  });
  if (postCommit) await (postCommit as (d: Db) => Promise<void>)(db);
  return done;
}

function formatValue(spec: Pick<MetricSpec, "metric">, value: number | null): string {
  if (value === null) return "nothing";
  const unit = CONDITION_METRIC_HELP[spec.metric].unit;
  const n = Number.isInteger(value) ? String(value) : value.toFixed(unit === "score" ? 3 : 2);
  return unit === "%" ? `${n} %` : `${n} ${unit}`;
}

/** Evaluate a use case's conditions; `persist` writes the last_* columns. The
 * deploy gate (persist: false) and the scheduler (persist: true) call it. */
export const evaluateUseCaseConditions: EvaluateUseCaseConditionsFn<Db> = async (db, useCaseId, now, opts) =>
  (await evaluateConditionsDetailed(db, useCaseId, now, opts)).verdicts;

// ---------------------------------------------------------------------------
// The scheduler sweep
// ---------------------------------------------------------------------------

export interface ConditionEvaluationSweepResult {
  useCases: number;
  evaluated: number;
  met: number;
  breached: number;
  reopened: number;
  skipped: Array<{ useCaseId: string; reason: string }>;
}

/** use cases whose conditions are live (not rejected, not retired) and carry a measured, unwaived condition */
async function useCasesWithMeasuredConditions(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: useCaseConditions.useCaseId })
    .from(useCaseConditions)
    .innerJoin(aiUseCases, eq(aiUseCases.id, useCaseConditions.useCaseId))
    .where(
      and(
        ne(useCaseConditions.kind, "manual"),
        ne(useCaseConditions.status, "waived"),
        notInArray(aiUseCases.status, ["rejected", "retired"]),
      ),
    );
  return rows.map((r) => r.id);
}

/** Evaluate every DUE measured condition (by its cadence) and persist it. */
export async function runConditionEvaluationSweep(
  db: Db,
  opts: { now?: Date; dataKey?: string | undefined; log?: (line: string) => void } = {},
): Promise<ConditionEvaluationSweepResult> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? ((line: string) => console.error(line));
  const out: ConditionEvaluationSweepResult = { useCases: 0, evaluated: 0, met: 0, breached: 0, reopened: 0, skipped: [] };
  for (const id of await useCasesWithMeasuredConditions(db)) {
    out.useCases += 1;
    try {
      const r = await evaluateConditionsDetailed(db, id, now, {
        persist: true,
        onlyDue: true,
        ...(opts.dataKey ? { dataKey: opts.dataKey } : {}),
      });
      out.evaluated += r.verdicts.filter((v) => v.evaluatedAt === now.toISOString() && v.measurement).length;
      out.met += r.met.length;
      out.breached += r.breached.length;
      if (r.reopened) out.reopened += 1;
      for (const s of r.skipped) out.skipped.push({ useCaseId: id, reason: `${s.conditionId}: ${s.reason}` });
    } catch (err) {
      // ONE failing use case never aborts the sweep
      const message = err instanceof Error ? err.message : String(err);
      log(`condition evaluation sweep: use case ${id} skipped — ${message}`);
      out.skipped.push({ useCaseId: id, reason: message.slice(0, 300) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The monitor
// ---------------------------------------------------------------------------

/**
 * The monitor's loader for `condition_metric_breached`: one finding per
 * breached condition that is LIVE after go-live — a met condition whose
 * evidence now breaches (its met history stands), or an after-go-live one.
 * Measured with `persist: false`, so the monitor never moves a breach streak.
 * Too few samples or no data HOLDS an open episode (neither raised nor resolved).
 */
export async function conditionMetricsMonitorInput(
  db: Db,
  now: Date,
): Promise<Partial<Record<AssuranceMonitorRuleId, MonitorAssuranceInput>>> {
  const breaches: MonitorAssuranceSubject[] = [];
  const held: string[] = [];
  for (const id of await useCasesWithMeasuredConditions(db)) {
    const [uc] = await db.select({ name: aiUseCases.name }).from(aiUseCases).where(eq(aiUseCases.id, id));
    const verdicts = await evaluateUseCaseConditions(db, id, now, { persist: false });
    for (const v of verdicts) {
      if (v.kind === "manual" || v.status === "waived" || !v.measurement) continue;
      const live = v.status === "met" || !v.blocking;
      if (!live) continue;
      const key = conditionSubjectKey(id, v.conditionId);
      if (v.state === "fail") {
        breaches.push({
          subjectKey: key,
          title: `Measured condition breached on use case '${uc?.name ?? id}'`,
          detail: {
            useCaseId: id,
            conditionId: v.conditionId,
            kind: v.kind,
            status: v.status,
            blocking: v.blocking,
            value: v.measurement.value,
            samples: v.measurement.samples,
            consecutiveBreaches: v.consecutiveBreaches,
            onBreach: v.onBreach,
            evidence: v.measurement.evidence.slice(0, 5),
          },
        });
      } else if (v.state === "insufficient" || v.state === "not_run") {
        held.push(key);
      }
    }
  }
  return { condition_metric_breached: { breaches, heldSubjectKeys: held } };
}

// ---------------------------------------------------------------------------
// The decide path's condition schema (app.ts)
// ---------------------------------------------------------------------------

/** A condition on an approving sign-off: the ADR-0168 manual shape (with or
 * without `kind: "manual"`), or a MEASURED one (`measuredConditionInputSchema`). */
export const decideConditionSchema = z.preprocess(
  (v) => (v && typeof v === "object" && !Array.isArray(v) && !("kind" in v) ? { ...(v as object), kind: "manual" } : v),
  z.discriminatedUnion("kind", [approvalConditionSchema.extend({ kind: z.literal("manual") }), measuredConditionInputSchema]),
);
export type DecideConditionInput = z.infer<typeof decideConditionSchema>;

/** `decideApprovalSchema`, with conditions that may be measured (ADR-0180 A2) */
export const decideApprovalWithMeasuredSchema = decideApprovalSchema.extend({
  conditions: z.array(decideConditionSchema).max(20).optional(),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const conditionParams = z.object({ useCaseId: z.string().uuid(), conditionId: z.string().uuid() });

async function waiverNames(db: Db, ids: Array<string | null>): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (want.length === 0) return new Map();
  const rows = await db.select({ id: users.id, displayName: users.displayName, email: users.email }).from(users).where(inArray(users.id, want));
  return new Map(rows.map((u) => [u.id, u.displayName || u.email]));
}

/**
 * Routes (classified in route-classes.ts and openapi-registry.ts, A2 block):
 *   POST /v1/use-cases/:useCaseId/conditions/:conditionId/evaluate  admin, audited
 *   POST /v1/use-cases/:useCaseId/conditions/:conditionId/waive     admin, reason required, audited
 */
export function registerConditionMetricRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string } = {}): void {
  // Evaluate one measured condition NOW (persisted, exactly as the scheduler
  // would): an open condition whose evidence passes is closed by the
  // evaluator, never by the admin who asked. Audited as the admin's request.
  app.post("/v1/use-cases/:useCaseId/conditions/:conditionId/evaluate", async (req, reply) => {
    const { useCaseId, conditionId } = conditionParams.parse(req.params);
    const callerId = req.authCtx.userId ?? null;
    const [cond] = await db
      .select()
      .from(useCaseConditions)
      .where(and(eq(useCaseConditions.id, conditionId), eq(useCaseConditions.useCaseId, useCaseId)));
    if (!cond) return reply.status(404).send({ error: "not_found" });
    if (!specOf(cond)) {
      return reply.status(422).send({
        error: "condition_not_measured",
        detail: "a manual condition has no metric to evaluate; it is marked met by hand",
      });
    }
    if (cond.status === "waived") {
      return reply.status(409).send({ error: "condition_waived", detail: "a waived condition is not evaluated" });
    }
    const now = new Date();
    const r = await evaluateConditionsDetailed(db, useCaseId, now, {
      persist: true,
      conditionIds: [conditionId],
      requestedBy: callerId,
      ...(opts.dataKey ? { dataKey: opts.dataKey } : {}),
    });
    const verdict = r.verdicts[0];
    if (!verdict) return reply.status(404).send({ error: "not_found" });
    const [uc] = await db.select({ name: aiUseCases.name }).from(aiUseCases).where(eq(aiUseCases.id, useCaseId));
    await db.insert(auditLog).values({
      userId: callerId ?? NO_IDENTITY,
      objectType: "ai_use_case",
      objectId: useCaseId,
      detail: {
        phase: "condition-evaluate-requested",
        conditionId,
        state: verdict.state,
        measurement: verdict.measurement,
        met: r.met.includes(conditionId),
        reopened: r.reopened,
      },
      effect: "allow",
      ruleId: "use-case-condition-evaluate-requested",
      ruleChain: [],
      reason: `an administrator evaluated a measured condition on AI use case '${uc?.name ?? useCaseId}' now: it reads ${verdict.state.replace("_", " ")}`,
    });
    return { verdict, met: r.met.includes(conditionId), reopened: r.reopened };
  });

  // Waive a condition: an admin's recorded decision that it no longer has to
  // be met. The reason is required (and prose-scrubbed on write). The verdict
  // reads `waived`, which the deploy gate reports as a WARNING, never a pass.
  app.post("/v1/use-cases/:useCaseId/conditions/:conditionId/waive", async (req, reply) => {
    const { useCaseId, conditionId } = conditionParams.parse(req.params);
    const parsed = waiveConditionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(422).send({
        error: "waive_reason_required",
        detail: "say why this condition is waived (1 to 2000 characters)",
        issues: parsed.error.issues,
      });
    }
    const callerId = req.authCtx.userId ?? null;
    if (!callerId) return reply.status(403).send({ error: "bootstrap_cannot_waive", detail: "a waiver is attributed to a named administrator" });
    const [cond] = await db
      .select()
      .from(useCaseConditions)
      .where(and(eq(useCaseConditions.id, conditionId), eq(useCaseConditions.useCaseId, useCaseId)));
    if (!cond) return reply.status(404).send({ error: "not_found" });
    if (cond.status === "waived") return reply.status(409).send({ error: "condition_already_waived" });
    const [uc] = await db.select({ name: aiUseCases.name }).from(aiUseCases).where(eq(aiUseCases.id, useCaseId));
    const now = new Date();
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(useCaseConditions)
        .set({
          status: "waived",
          // the ADR-0168 check needs met_at on any non-open status; a met
          // condition keeps the moment it was met
          metAt: cond.metAt ?? now,
          waivedAt: now,
          waivedBy: callerId,
          waiveReason: parsed.data.reason,
        })
        .where(and(eq(useCaseConditions.id, cond.id), eq(useCaseConditions.status, cond.status)))
        .returning();
      if (!row) return null;
      await tx.insert(auditLog).values({
        userId: callerId,
        objectType: "ai_use_case",
        objectId: useCaseId,
        detail: {
          phase: "condition-waived",
          conditionId: cond.id,
          approvalId: cond.approvalId,
          kind: cond.kind,
          blocking: cond.blocking,
          from: cond.status,
          lastState: cond.lastState,
        },
        effect: "allow",
        ruleId: "use-case-condition-waived",
        ruleChain: [],
        reason:
          `condition on AI use case '${uc?.name ?? useCaseId}' WAIVED by an administrator` +
          `${cond.blocking ? " (before go-live — the deploy gate reports it as a warning, not a pass)" : " (after go-live)"}: ` +
          parsed.data.reason,
      });
      return row;
    });
    if (!updated) return reply.status(409).send({ error: "condition_changed", detail: "the condition changed while it was being waived; reload and try again" });
    const names = await waiverNames(db, [updated.waivedBy]);
    return {
      id: updated.id,
      status: updated.status,
      metAt: updated.metAt ? updated.metAt.toISOString() : null,
      waivedAt: updated.waivedAt ? updated.waivedAt.toISOString() : null,
      waivedByName: updated.waivedBy ? (names.get(updated.waivedBy) ?? null) : null,
      waiveReason: updated.waiveReason,
      verdict: verdictOf(updated, null, updated.lastEvaluatedAt),
    };
  });
}

/** the measured state as the use-case read shows it (re-exported for use-cases.ts) */
export type { MeasurementState };
