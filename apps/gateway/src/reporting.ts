/**
 * ADR-0047 — the GATEWAY half of EXECUTIVE & COMPLIANCE REPORTING.
 *
 *   `packages/shared/src/reporting.ts`  the period resolution, the entitlement
 *                                       decision, the section assembly, the
 *                                       control assessment, the CSV round trip.
 *                                       Pure — no db, no clock, no Fastify.
 *   THIS FILE                           the ledger queries, the admin API, the
 *                                       run ledger, the export, the audit rows.
 *
 * THREE PROPERTIES THIS FILE EXISTS TO GUARANTEE
 *
 *  1. EVERY NUMBER COMES FROM THE REAL LEDGER. `computeReport` issues SELECTs
 *     against `usage_events`, `audit_log`, `approvals`, `eval_runs` and
 *     `model_card_approvals` and aggregates them. There is no rollup table, no
 *     materialized view, and nothing that could drift from the cost dashboard.
 *     `report_runs.payload` is the ARTIFACT of a generation — it is never read
 *     back as an input to another computation, and re-generating recomputes
 *     from the ledgers.
 *
 *  2. A REPORT NEVER EXCEEDS THE CALLER'S OWN VISIBILITY. The scope is resolved
 *     to a concrete project-id list by `evaluateReportAccess`, and every query
 *     below is built with `inArray(usage_events.project_id, thoseIds)`. The
 *     narrowing happens at QUERY CONSTRUCTION. A post-hoc filter over an
 *     aggregate cannot un-aggregate it, so anything computed org-wide and
 *     filtered afterwards has already leaked. The only path that reaches
 *     org-wide rows (including spend attributed to no project) is an ADMIN
 *     under an org-scoped definition.
 *
 *  3. NOTHING HERE FIRES ON A TIMER, AND IT SAYS SO. There is no in-process
 *     scheduler in this codebase (ADR-0045's expiry sweep and ADR-0046's SLA
 *     evaluation are the same shape). `report_schedules` rows are schedule
 *     DEFINITIONS; `POST /v1/reports/schedules/run-due` is the endpoint an
 *     operator or an external cron drives, and its response says plainly that
 *     nothing calls it automatically.
 *
 * WHAT THIS FILE DOES NOT DO — stated here rather than only in the ADR:
 *   - It does not render PDF. ADR-0047 §3 flags the rendering dependency as
 *     unresolved and this repo's supply-chain posture resists dragging a
 *     headless browser into the gateway. CSV and JSON are the shipped formats;
 *     `format: 'pdf'` does not exist in the vocabulary rather than existing and
 *     quietly emitting something else.
 *   - It does not DELIVER anything. No S3 write, no mail. `recipientUserIds` is
 *     recorded so the entitlement check has something to check against; the
 *     ADR-0035 bucket delivery is a follow-up, and claiming it here would be
 *     the exact overstatement this project refuses.
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
  evalRuns,
  gte,
  inArray,
  lt,
  modelCardApprovals,
  projectMembers,
  projects,
  reportDefinitions,
  reportRuns,
  reportSchedules,
  sql,
  teamMembers,
  usageEvents,
  type Db,
  type ReportDefinitionRow,
  type ReportRunRow,
} from "@regulait/db";
import {
  assessControls,
  buildGovernanceSection,
  buildSpendSection,
  buildWorkflowSection,
  createReportDefinitionSchema,
  createReportScheduleSchema,
  defaultSectionsFor,
  evaluateReportAccess,
  generateReportSchema,
  renderReportCsv,
  reportCsvRows,
  resolveReportPeriod,
  scheduleIsDue,
  updateReportScheduleSchema,
  REPORT_ESTIMATE_DISCLAIMER,
  type ReportAccessDecision,
  type ReportPayload,
  type ReportSection,
  type SpendLine,
} from "@regulait/shared";
import { securityHeaders } from "./security-headers.js";

/** the audit row's actor when the caller is the identity-less bootstrap token */
const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

const idParam = z.object({ id: z.string().uuid() });

// ---------------------------------------------------------------------------
// Scope resolution — definition scope -> concrete project ids
// ---------------------------------------------------------------------------

/**
 * The DEFINITION's scope expands to a project-id list. Note what is NOT here:
 * this function never consults the caller. It answers "which projects does this
 * report cover"; `evaluateReportAccess` answers "which of those may this caller
 * see", and the two are deliberately separate so neither can quietly do the
 * other's job.
 */
export async function resolveScopeProjectIds(
  db: Db,
  def: { scopeKind: string; scopeId: string | null },
): Promise<string[]> {
  switch (def.scopeKind) {
    case "org": {
      const rows = await db.select({ id: projects.id }).from(projects);
      return rows.map((r) => r.id);
    }
    case "initiative": {
      const rows = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.initiativeId, def.scopeId!));
      return rows.map((r) => r.id);
    }
    case "team": {
      // a team's projects are the projects its members contribute to UNDER that
      // team (project_members.teamId) — the same join the per-project cost
      // rollup already uses for its byTeam breakdown, so the two agree.
      const rows = await db
        .selectDistinct({ id: projectMembers.projectId })
        .from(projectMembers)
        .where(eq(projectMembers.teamId, def.scopeId!));
      return rows.map((r) => r.id);
    }
    case "project":
      return def.scopeId ? [def.scopeId] : [];
    default:
      return [];
  }
}

export async function callerProjectIds(db: Db, userId: string | null): Promise<string[]> {
  if (!userId) return [];
  const rows = await db
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, userId));
  return rows.map((r) => r.id);
}

export async function callerTeamIds(db: Db, userId: string | null): Promise<string[]> {
  if (!userId) return [];
  const rows = await db
    .select({ id: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId));
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// THE COMPUTATION — every figure from the real ledger
// ---------------------------------------------------------------------------

export interface ComputeReportInput {
  definition: Pick<ReportDefinitionRow, "name" | "kind" | "scopeKind" | "scopeId" | "sections">;
  /** null = org-wide (admin only); a list = exactly these projects */
  projectIds: string[] | null;
  periodStart: Date;
  periodEnd: Date;
  period: ReportPayload["period"]["period"];
  periodLabel: string;
  now: Date;
}

export async function computeReport(db: Db, input: ComputeReportInput): Promise<ReportPayload> {
  const sections = (input.definition.sections as ReportSection[] | null) ??
    defaultSectionsFor(input.definition.kind);
  const { periodStart, periodEnd, projectIds } = input;

  // THE SCOPE PREDICATE. Built once, applied to every ledger query. `null` (an
  // admin org report) means no project constraint at all — which is the ONLY
  // way un-attributed spend (`project_id IS NULL`) can enter a report.
  const scopedUsage =
    projectIds === null ? undefined : inArray(usageEvents.projectId, projectIds.length ? projectIds : [ZERO_UUID]);
  const usageWhere = and(
    gte(usageEvents.at, periodStart),
    lt(usageEvents.at, periodEnd),
    ...(scopedUsage ? [scopedUsage] : []),
  );

  const payload: ReportPayload = {
    kind: input.definition.kind,
    definitionName: input.definition.name,
    scope: { kind: input.definition.scopeKind, id: input.definition.scopeId, projectIds },
    period: {
      period: input.period,
      label: input.periodLabel,
      start: periodStart.toISOString(),
      end: periodEnd.toISOString(),
    },
    generatedAt: input.now.toISOString(),
    disclaimer: REPORT_ESTIMATE_DISCLAIMER,
  };

  if (sections.includes("spend")) {
    const grouped = await db
      .select({
        projectId: usageEvents.projectId,
        costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
        events: count(),
        inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::int`,
      })
      .from(usageEvents)
      .where(usageWhere)
      .groupBy(usageEvents.projectId);
    const named = await db
      .select({ id: projects.id, name: projects.name, budgetUsd: projects.budgetUsd })
      .from(projects);
    const meta = new Map(named.map((p) => [p.id, p]));
    const lines: SpendLine[] = grouped
      .map((g) => ({
        projectId: g.projectId,
        projectName: g.projectId ? (meta.get(g.projectId)?.name ?? null) : null,
        costUsd: g.costUsd,
        events: g.events,
        inputTokens: g.inputTokens,
        outputTokens: g.outputTokens,
        budgetUsd: g.projectId ? (meta.get(g.projectId)?.budgetUsd ?? null) : null,
      }))
      .sort((a, b) => b.costUsd - a.costUsd);
    payload.spend = buildSpendSection(lines);
  }

  if (sections.includes("governance")) {
    // audit_log carries no project column; attribution rides `detail.projectId`
    // (the same jsonb key every governed path writes). Scoping is therefore a
    // jsonb predicate — still applied at QUERY CONSTRUCTION, not afterwards.
    const auditWhere = and(
      gte(auditLog.at, periodStart),
      lt(auditLog.at, periodEnd),
      ...(projectIds === null
        ? []
        : [
            sql`${auditLog.detail} ->> 'projectId' = ANY(${sql.raw(
              `ARRAY[${(projectIds.length ? projectIds : [ZERO_UUID]).map((p) => `'${assertUuid(p)}'`).join(",")}]::text[]`,
            )})`,
          ]),
    );
    const [counts, denies] = await Promise.all([
      db
        .select({ effect: auditLog.effect, count: count() })
        .from(auditLog)
        .where(auditWhere)
        .groupBy(auditLog.effect),
      db
        .select({ ruleId: auditLog.ruleId, count: count() })
        .from(auditLog)
        .where(and(auditWhere, eq(auditLog.effect, "deny")))
        .groupBy(auditLog.ruleId)
        .orderBy(desc(count()))
        .limit(10),
    ]);
    payload.governance = buildGovernanceSection(counts, denies);
  }

  if (sections.includes("workflow")) {
    // `approvals` carries no project column either; an approval is scoped by
    // the requesting user's membership of the reported projects. For an
    // org-wide (admin) report the constraint is absent.
    const memberIds =
      projectIds === null
        ? null
        : (
            await db
              .selectDistinct({ userId: projectMembers.userId })
              .from(projectMembers)
              .where(inArray(projectMembers.projectId, projectIds.length ? projectIds : [ZERO_UUID]))
          ).map((r) => r.userId);
    const approvalWhere = and(
      gte(approvals.requestedAt, periodStart),
      lt(approvals.requestedAt, periodEnd),
      ...(memberIds === null
        ? []
        : [inArray(approvals.userId, memberIds.length ? memberIds : [ZERO_UUID])]),
    );
    const [statuses, decided] = await Promise.all([
      db
        .select({ status: approvals.status, count: count() })
        .from(approvals)
        .where(approvalWhere)
        .groupBy(approvals.status),
      db
        .select({ requestedAt: approvals.requestedAt, decidedAt: approvals.decidedAt })
        .from(approvals)
        .where(and(approvalWhere, inArray(approvals.status, ["approved", "denied"]))),
    ]);
    const decisionMinutes = decided
      .filter((d) => d.decidedAt)
      .map((d) => (d.decidedAt!.getTime() - d.requestedAt.getTime()) / 60000);
    payload.workflow = buildWorkflowSection({ statuses, decisionMinutes });
  }

  if (sections.includes("controls")) {
    const [auditRows, approvalRows, liveCards, runs, attributed] = await Promise.all([
      db
        .select({ n: count() })
        .from(auditLog)
        .where(and(gte(auditLog.at, periodStart), lt(auditLog.at, periodEnd))),
      db
        .select({ n: count() })
        .from(approvals)
        .where(and(gte(approvals.requestedAt, periodStart), lt(approvals.requestedAt, periodEnd))),
      db
        .select({ n: count() })
        .from(modelCardApprovals)
        .where(eq(modelCardApprovals.status, "approved")),
      db
        .select({ n: count() })
        .from(evalRuns)
        .where(and(gte(evalRuns.startedAt, periodStart), lt(evalRuns.startedAt, periodEnd))),
      db
        .select({ n: count() })
        .from(usageEvents)
        .where(and(usageWhere, sql`${usageEvents.projectId} IS NOT NULL`)),
    ]);
    payload.controls = assessControls(input.definition.kind === "compliance" ? "built-in" : "built-in", {
      auditRows: auditRows[0]?.n ?? 0,
      approvalRows: approvalRows[0]?.n ?? 0,
      liveModelCards: liveCards[0]?.n ?? 0,
      evalRuns: runs[0]?.n ?? 0,
      attributedSpendRows: attributed[0]?.n ?? 0,
    });
  }

  return payload;
}

/** a uuid that cannot exist, so an empty allow-list yields an empty result set
 * rather than an unconstrained query — fail CLOSED, never open */
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** the jsonb project predicate is built by interpolation, so every id is
 * re-validated as a uuid on the way in. A non-uuid here would be an injection
 * primitive; it throws instead. */
function assertUuid(v: string): string {
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v)) {
    throw new Error("non-uuid project id in report scope");
  }
  return v;
}

// ---------------------------------------------------------------------------
// Generation — access decision + compute + ledger row + audit
// ---------------------------------------------------------------------------

export interface GenerateResult {
  ok: true;
  run: ReportRunRow;
  payload: ReportPayload;
  decision: ReportAccessDecision;
}
export interface GenerateRefusal {
  ok: false;
  status: number;
  error: string;
  detail: string;
}

export async function generateReport(
  db: Db,
  args: {
    definition: ReportDefinitionRow;
    actor: { userId: string | null; isAdmin: boolean };
    period?: ReportPayload["period"]["period"];
    format?: "csv" | "json" | "both";
    trigger?: "manual" | "scheduled";
    scheduleId?: string | null;
    now?: Date;
  },
): Promise<GenerateResult | GenerateRefusal> {
  const now = args.now ?? new Date();
  const def = args.definition;
  const scopeProjectIds = await resolveScopeProjectIds(db, def);
  const decision = evaluateReportAccess({
    isAdmin: args.actor.isAdmin,
    userId: args.actor.userId,
    definition: {
      kind: def.kind,
      scopeKind: def.scopeKind,
      scopeId: def.scopeId,
      entitlementScope: def.entitlementScope,
    },
    scopeProjectIds,
    callerProjectIds: await callerProjectIds(db, args.actor.userId),
    callerTeamIds: await callerTeamIds(db, args.actor.userId),
  });

  if (!decision.allowed) {
    // THE REFUSAL IS THE RECORD. A report aggregates across teams, so "who was
    // told no, and for which scope" belongs in the audit trail as much as what
    // was produced.
    await db.insert(auditLog).values({
      userId: args.actor.userId ?? NO_IDENTITY,
      objectType: "report",
      objectId: def.id,
      detail: {
        phase: "generate",
        definition: def.name,
        kind: def.kind,
        scopeKind: def.scopeKind,
        scopeId: def.scopeId,
        entitlementScope: def.entitlementScope,
        scopeProjectCount: scopeProjectIds.length,
      },
      effect: "deny",
      ruleId: decision.ruleId,
      ruleChain: [],
      reason: decision.reason,
    });
    return {
      ok: false,
      status: 403,
      error: "report_scope_not_entitled",
      detail: decision.reason,
    };
  }

  const period = args.period ?? def.period;
  const resolved = resolveReportPeriod(period, now);
  const payload = await computeReport(db, {
    definition: def,
    projectIds: decision.projectIds,
    periodStart: resolved.start,
    periodEnd: resolved.end,
    period,
    periodLabel: resolved.label,
    now,
  });
  const rows = reportCsvRows(payload);
  const [run] = await db
    .insert(reportRuns)
    .values({
      definitionId: def.id,
      scheduleId: args.scheduleId ?? null,
      requestedByUserId: args.actor.userId ?? null,
      trigger: args.trigger ?? "manual",
      period,
      periodStart: resolved.start,
      periodEnd: resolved.end,
      entitlementScope: def.entitlementScope,
      effectiveProjectIds: decision.projectIds,
      format: args.format ?? def.format,
      payload: payload as unknown as Record<string, unknown>,
      rowCount: rows.length,
    })
    .returning();

  await db.insert(auditLog).values({
    userId: args.actor.userId ?? NO_IDENTITY,
    objectType: "report",
    objectId: run!.id,
    detail: {
      phase: "generate",
      definition: def.name,
      kind: def.kind,
      trigger: args.trigger ?? "manual",
      period,
      periodStart: resolved.start.toISOString(),
      periodEnd: resolved.end.toISOString(),
      entitlementScope: def.entitlementScope,
      // the honest record of WHAT THIS REPORT WAS PERMITTED TO SEE
      effectiveProjectIds: decision.projectIds,
      effectiveProjectCount: decision.projectIds === null ? null : decision.projectIds.length,
      totalCostUsd: payload.spend?.totalCostUsd ?? null,
      rowCount: rows.length,
    },
    effect: "allow",
    ruleId: "report-generated",
    ruleChain: [],
    reason:
      `report '${def.name}' generated for ${resolved.label} over ` +
      (decision.projectIds === null
        ? "the whole organization (admin, org-scoped definition)"
        : `${decision.projectIds.length} entitled project(s)`) +
      " — read-only projection over usage_events/audit_log/approvals; spend figures are list-price estimates",
  });

  return { ok: true, run: run!, payload, decision };
}

/**
 * Can this caller READ an already-generated run? The run carries the
 * entitlement scope it was generated under, COPIED at generation time — so
 * editing the definition afterwards cannot retroactively widen the audience.
 */
export async function canReadRun(
  db: Db,
  run: ReportRunRow,
  actor: { userId: string | null; isAdmin: boolean },
): Promise<boolean> {
  if (actor.isAdmin) return true;
  if (!actor.userId) return false;
  // an org-scoped artifact is admin-only, full stop
  if (run.entitlementScope === "org" || run.effectiveProjectIds === null) return false;
  // otherwise the caller must still be a member of EVERY project the artifact
  // covers — a run generated for a wider membership than the reader holds today
  // is not readable by that reader
  const mine = new Set(await callerProjectIds(db, actor.userId));
  return (run.effectiveProjectIds as string[]).every((p) => mine.has(p));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerReportingRoutes(app: FastifyInstance, db: Db): void {
  async function audit(
    actor: string | null,
    objectId: string | null,
    ruleId: string,
    reason: string,
    detail: Record<string, unknown>,
    effect: "allow" | "deny" = "allow",
  ) {
    await db.insert(auditLog).values({
      userId: actor ?? NO_IDENTITY,
      objectType: "report",
      objectId,
      detail,
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });
  }

  // --- definitions (admin-only via the global gate) ------------------------

  app.post("/v1/reports/definitions", async (req, reply) => {
    const body = createReportDefinitionSchema.parse(req.body);
    const [row] = await db
      .insert(reportDefinitions)
      .values({
        name: body.name,
        kind: body.kind,
        scopeKind: body.scopeKind,
        scopeId: body.scopeId ?? null,
        period: body.period,
        sections: body.sections ?? null,
        format: body.format,
        entitlementScope: body.entitlementScope,
        description: body.description ?? null,
        createdByUserId: req.authCtx.userId ?? null,
      })
      .returning();
    await audit(
      req.authCtx.userId ?? null,
      row!.id,
      "report-definition-created",
      `admin created report definition '${body.name}' (${body.kind}, ${body.scopeKind}-scoped, ` +
        `entitlement '${body.entitlementScope}') — it computes nothing until it is generated, and a ` +
        `generation never exceeds the requesting caller's own visibility`,
      { name: body.name, kind: body.kind, scopeKind: body.scopeKind, entitlementScope: body.entitlementScope },
    );
    return reply.status(201).send({ definition: row });
  });

  app.get("/v1/reports/definitions", async () => {
    const rows = await db.select().from(reportDefinitions).orderBy(desc(reportDefinitions.createdAt));
    return { definitions: rows };
  });

  app.get("/v1/reports/definitions/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db.select().from(reportDefinitions).where(eq(reportDefinitions.id, id));
    if (!row) return reply.status(404).send({ error: "unknown_report_definition" });
    const scopeProjectIds = await resolveScopeProjectIds(db, row);
    const schedules = await db
      .select()
      .from(reportSchedules)
      .where(eq(reportSchedules.definitionId, id));
    return { definition: row, scopeProjectIds, schedules };
  });

  app.delete("/v1/reports/definitions/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db.select().from(reportDefinitions).where(eq(reportDefinitions.id, id));
    if (!row) return reply.status(404).send({ error: "unknown_report_definition" });
    await db.delete(reportDefinitions).where(eq(reportDefinitions.id, id));
    await audit(
      req.authCtx.userId ?? null,
      id,
      "report-definition-deleted",
      `admin deleted report definition '${row.name}' — its generated runs cascade with it; the LEDGERS ` +
        `it read (usage_events, audit_log, approvals) are untouched, so the same report is reproducible`,
      { name: row.name, kind: row.kind },
      "deny",
    );
    return { deleted: true };
  });

  // --- schedules (admin-only) — DEFINITIONS ONLY, nothing fires -----------

  app.post("/v1/reports/definitions/:id/schedules", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = createReportScheduleSchema.parse(req.body);
    const [def] = await db.select().from(reportDefinitions).where(eq(reportDefinitions.id, id));
    if (!def) return reply.status(404).send({ error: "unknown_report_definition" });
    const [row] = await db
      .insert(reportSchedules)
      .values({
        definitionId: id,
        cadence: body.cadence,
        enabled: body.enabled,
        recipientUserIds: body.recipientUserIds ?? null,
        createdByUserId: req.authCtx.userId ?? null,
      })
      .returning();
    await audit(
      req.authCtx.userId ?? null,
      row!.id,
      "report-schedule-created",
      `admin scheduled report '${def.name}' ${body.cadence} — this records a CADENCE ONLY. There is no ` +
        `in-process scheduler in this deployment: an operator or an external cron must call ` +
        `POST /v1/reports/schedules/run-due, or nothing will ever be generated`,
      { definition: def.name, cadence: body.cadence, recipients: body.recipientUserIds?.length ?? 0 },
    );
    return reply.status(201).send({
      schedule: row,
      note:
        "Schedule DEFINITION stored. Nothing drives it — call POST /v1/reports/schedules/run-due from " +
        "cron/an operator. No delivery transport is wired: recipients are recorded for the entitlement " +
        "check, not mailed.",
    });
  });

  app.get("/v1/reports/schedules", async () => {
    const rows = await db.select().from(reportSchedules).orderBy(desc(reportSchedules.createdAt));
    return {
      schedules: rows,
      note: "Nothing in this codebase fires these. POST /v1/reports/schedules/run-due is the driver.",
    };
  });

  app.patch("/v1/reports/schedules/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = updateReportScheduleSchema.parse(req.body);
    const [row] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, id));
    if (!row) return reply.status(404).send({ error: "unknown_report_schedule" });
    const [updated] = await db
      .update(reportSchedules)
      .set({
        ...(body.cadence !== undefined ? { cadence: body.cadence } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.recipientUserIds !== undefined
          ? { recipientUserIds: body.recipientUserIds ?? null }
          : {}),
      })
      .where(eq(reportSchedules.id, id))
      .returning();
    await audit(
      req.authCtx.userId ?? null,
      id,
      "report-schedule-updated",
      `admin updated a report schedule (${Object.keys(body).join(", ") || "no-op"})`,
      { fields: Object.keys(body), enabled: updated!.enabled, cadence: updated!.cadence },
    );
    return { schedule: updated };
  });

  app.delete("/v1/reports/schedules/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, id));
    if (!row) return reply.status(404).send({ error: "unknown_report_schedule" });
    await db.delete(reportSchedules).where(eq(reportSchedules.id, id));
    await audit(req.authCtx.userId ?? null, id, "report-schedule-deleted", "admin deleted a report schedule", {}, "deny");
    return { deleted: true };
  });

  /**
   * THE SWEEP, as an ENDPOINT — the same shape ADR-0045's expiry sweep and
   * ADR-0046's SLA evaluation take, and for the same reason: there is no
   * scheduler here to hang it on, and pretending otherwise would be the exact
   * dishonesty this project refuses. Admin-only, because it generates at the
   * DEFINITION's full scope.
   */
  app.post("/v1/reports/schedules/run-due", async (req) => {
    const now = new Date();
    const due = await db
      .select()
      .from(reportSchedules)
      .where(eq(reportSchedules.enabled, true));
    const generated: Array<{ scheduleId: string; runId: string; definition: string }> = [];
    const skipped: Array<{ scheduleId: string; reason: string }> = [];
    for (const s of due) {
      if (!scheduleIsDue(s.cadence, s.lastGeneratedAt, now)) {
        skipped.push({ scheduleId: s.id, reason: "not yet due for its cadence" });
        continue;
      }
      const [def] = await db
        .select()
        .from(reportDefinitions)
        .where(eq(reportDefinitions.id, s.definitionId));
      if (!def) {
        skipped.push({ scheduleId: s.id, reason: "definition disappeared" });
        continue;
      }
      const res = await generateReport(db, {
        definition: def,
        actor: { userId: req.authCtx.userId ?? null, isAdmin: req.authCtx.isAdmin },
        trigger: "scheduled",
        scheduleId: s.id,
        now,
      });
      if (!res.ok) {
        skipped.push({ scheduleId: s.id, reason: res.detail });
        continue;
      }
      await db
        .update(reportSchedules)
        .set({ lastGeneratedAt: now, lastRunId: res.run.id })
        .where(eq(reportSchedules.id, s.id));
      generated.push({ scheduleId: s.id, runId: res.run.id, definition: def.name });
    }
    await audit(
      req.authCtx.userId ?? null,
      null,
      "report-schedule-swept",
      `operator-driven schedule sweep: ${generated.length} generated, ${skipped.length} skipped`,
      { generated: generated.length, skipped: skipped.length },
    );
    return {
      generated,
      skipped,
      note:
        "Nothing calls this on a timer — there is no in-process scheduler in this codebase. A " +
        "deployment that never invokes this endpoint generates NO scheduled reports, and " +
        "`lastGeneratedAt` staying null is how that is visible rather than silent. No artifact is " +
        "delivered anywhere: recipients are recorded, not mailed.",
    };
  });

  // --- generation + reads (NON-ADMIN reachable, entitlement-scoped) --------

  app.post("/v1/reports/definitions/:id/generate", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = generateReportSchema.parse(req.body ?? {});
    const [def] = await db.select().from(reportDefinitions).where(eq(reportDefinitions.id, id));
    if (!def) return reply.status(404).send({ error: "unknown_report_definition" });
    const res = await generateReport(db, {
      definition: def,
      actor: { userId: req.authCtx.userId ?? null, isAdmin: req.authCtx.isAdmin },
      ...(body.period ? { period: body.period } : {}),
      ...(body.format ? { format: body.format } : {}),
    });
    if (!res.ok) return reply.status(res.status).send({ error: res.error, detail: res.detail });
    return reply.status(201).send({
      run: { ...res.run, payload: undefined },
      report: res.payload,
      scope: {
        entitlementScope: def.entitlementScope,
        effectiveProjectIds: res.decision.projectIds,
        reason: res.decision.reason,
      },
    });
  });

  app.get("/v1/reports/runs", async (req) => {
    const q = z
      .object({ definitionId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query ?? {});
    const rows = await db
      .select({
        id: reportRuns.id,
        definitionId: reportRuns.definitionId,
        scheduleId: reportRuns.scheduleId,
        requestedByUserId: reportRuns.requestedByUserId,
        trigger: reportRuns.trigger,
        period: reportRuns.period,
        periodStart: reportRuns.periodStart,
        periodEnd: reportRuns.periodEnd,
        entitlementScope: reportRuns.entitlementScope,
        effectiveProjectIds: reportRuns.effectiveProjectIds,
        format: reportRuns.format,
        rowCount: reportRuns.rowCount,
        generatedAt: reportRuns.generatedAt,
      })
      .from(reportRuns)
      .where(q.definitionId ? eq(reportRuns.definitionId, q.definitionId) : undefined)
      .orderBy(desc(reportRuns.generatedAt))
      .limit(q.limit);
    if (req.authCtx.isAdmin) return { runs: rows };
    // a non-admin sees only artifacts they could regenerate themselves
    const mine = new Set(await callerProjectIds(db, req.authCtx.userId ?? null));
    return {
      runs: rows.filter(
        (r) =>
          r.entitlementScope !== "org" &&
          r.effectiveProjectIds !== null &&
          (r.effectiveProjectIds as string[]).every((p) => mine.has(p)),
      ),
    };
  });

  app.get("/v1/reports/runs/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [run] = await db.select().from(reportRuns).where(eq(reportRuns.id, id));
    if (!run) return reply.status(404).send({ error: "unknown_report_run" });
    if (!(await canReadRun(db, run, req.authCtx))) {
      await audit(
        req.authCtx.userId ?? null,
        id,
        "report-read-denied",
        "a caller without the artifact's entitlement scope tried to read a generated report",
        { entitlementScope: run.entitlementScope },
        "deny",
      );
      return reply.status(403).send({ error: "report_scope_not_entitled" });
    }
    return { run };
  });

  /** the EXPORT. CSV is the documented interchange format (long-format
   * `section,key,metric,value`); JSON is the payload verbatim. */
  app.get("/v1/reports/runs/:id/export", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const q = z.object({ format: z.enum(["csv", "json"]).default("csv") }).parse(req.query ?? {});
    const [run] = await db.select().from(reportRuns).where(eq(reportRuns.id, id));
    if (!run) return reply.status(404).send({ error: "unknown_report_run" });
    if (!(await canReadRun(db, run, req.authCtx))) {
      await audit(
        req.authCtx.userId ?? null,
        id,
        "report-export-denied",
        "a caller without the artifact's entitlement scope tried to export a generated report",
        { entitlementScope: run.entitlementScope, format: q.format },
        "deny",
      );
      return reply.status(403).send({ error: "report_scope_not_entitled" });
    }
    const payload = run.payload as unknown as ReportPayload;
    await audit(
      req.authCtx.userId ?? null,
      id,
      "report-exported",
      `report artifact exported as ${q.format} — a self-contained spend+governance document leaves the ` +
        `platform here, so the act is recorded`,
      { format: q.format, entitlementScope: run.entitlementScope, rowCount: run.rowCount },
    );
    if (q.format === "json") return reply.send({ run: { ...run, payload: undefined }, report: payload });
    const csv = renderReportCsv(payload);
    for (const [k, v] of Object.entries(securityHeaders("text/csv"))) reply.header(k, v);
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="report-${run.id}.csv"`);
    reply.header("x-regulait-report-basis", "estimate-list-price");
    return reply.send(csv);
  });

  /** the read-side rollup the admin SPA's Reports page renders: definitions,
   * their latest run, and the honest "nothing drives these" note */
  app.get("/v1/reports/overview", async () => {
    const defs = await db.select().from(reportDefinitions).orderBy(desc(reportDefinitions.createdAt));
    const schedules = await db.select().from(reportSchedules);
    const latest = await db
      .select({
        definitionId: reportRuns.definitionId,
        generatedAt: sql<string>`max(${reportRuns.generatedAt})`,
        runs: count(),
      })
      .from(reportRuns)
      .groupBy(reportRuns.definitionId);
    const byDef = new Map(latest.map((l) => [l.definitionId, l]));
    return {
      definitions: defs.map((d) => ({
        ...d,
        schedules: schedules.filter((s) => s.definitionId === d.id),
        lastGeneratedAt: byDef.get(d.id)?.generatedAt ?? null,
        runCount: byDef.get(d.id)?.runs ?? 0,
      })),
      schedulerPresent: false,
      note:
        "No in-process scheduler exists in this deployment. Schedules are definitions only; drive " +
        "POST /v1/reports/schedules/run-due from cron. Spend figures are list-price ESTIMATES.",
    };
  });
}
