import type { FastifyInstance } from "fastify";
import {
  and,
  approvals,
  auditLog,
  connectors,
  count,
  complianceProfiles,
  inArray,
  costEvents,
  desc,
  eq,
  gte,
  initiatives,
  lt,
  projectContextItems,
  projectMembers,
  projects,
  sql,
  teamMembers,
  teams,
  usageEvents,
  users,
  workflowTemplates,
  workflowArtifacts,
  workflowInstances,
  type Db,
} from "@regulait/db";
import {
  addProjectMemberSchema,
  addTeamMemberSchema,
  contributeContextSchema,
  createInitiativeSchema,
  createProjectSchema,
  createTeamSchema,
  detectPII,
  patchProjectMemberSchema,
  promoteContextSchema,
  reclassifySchema,
  updateInitiativeSchema,
  updateProjectSchema,
  upsertComplianceProfileSchema,
  type PiiHit,
} from "@regulait/shared";
import { z } from "zod";

type ProjectRow = typeof projects.$inferSelect;

const projectIdParam = z.object({ projectId: z.string().uuid() });
const initiativeIdParam = z.object({ initiativeId: z.string().uuid() });

/** RFC-4180 field escaping: quote and double-up embedded quotes whenever a
 * field carries a comma, quote, or newline; leave plain fields untouched. */
function csvField(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The per-invocation CSV shape shared by both export endpoints: one header row
 * plus one row per usage_event, escaped. */
export const USAGE_CSV_HEADER = [
  "at",
  "userId",
  "objectType",
  "agentId",
  "connectorId",
  "model",
  "operation",
  "inputTokens",
  "outputTokens",
  "costUsd",
  "measuredCostSavedUsd",
  "projectId",
] as const;

export function usageEventsCsv(rows: Array<typeof usageEvents.$inferSelect>): string {
  const lines = [USAGE_CSV_HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.at instanceof Date ? r.at.toISOString() : r.at,
        r.userId,
        r.objectType,
        r.agentId,
        r.connectorId,
        r.model,
        r.operation,
        r.inputTokens,
        r.outputTokens,
        r.costUsd,
        r.measuredCostSavedUsd,
        r.projectId,
      ]
        .map(csvField)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/** §9 conflict approvals: stageId = this prefix + the retained item's id. */
const CONTEXT_CONFLICT_PREFIX = "__context_conflict__:";

/** Calendar-month period key 'YYYY-MM' (UTC) for the period containing `now`.
 * The overage latch is scoped to this key so a sanctioned overage never carries
 * into the next month. */
export function currentPeriodKey(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** UTC month-start timestamp for the period containing `now` — the lower bound
 * of a 'monthly' budget window. */
export function periodStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

/** True when a project's budget window is the current calendar month. */
function isMonthly(project: Pick<ProjectRow, "budgetPeriod">): boolean {
  return project.budgetPeriod === "monthly";
}

/** True when an approved overage still suppresses enforcement: always under a
 * lifetime ('none') budget, but under a 'monthly' budget only while the latch's
 * period matches the current one — on a new month the latch is inert and
 * enforcement resumes. */
function overageActive(project: ProjectRow, periodKey: string): boolean {
  if (!project.overageApproved) return false;
  if (!isMonthly(project)) return true;
  return project.overageApprovedPeriod === periodKey;
}

/** Measured spend attributed to a project (pillar 5 actuals). Under a 'monthly'
 * budget only spend within the current calendar-month window counts; otherwise
 * it is lifetime-cumulative (default, back-compat). */
async function projectSpendUsd(
  db: Db,
  projectId: string,
  opts?: { monthly?: boolean; now?: Date },
): Promise<number> {
  const where =
    opts?.monthly
      ? and(eq(usageEvents.projectId, projectId), gte(usageEvents.at, periodStart(opts.now)))
      : eq(usageEvents.projectId, projectId);
  const [row] = await db
    .select({ spent: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8` })
    .from(usageEvents)
    .where(where);
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

/** ADR-0011: once a project has members, only members (or admins) may
 * attribute spend/runs/instances to it; a memberless project stays an open
 * cost bucket (pillar-5 back-compat). Membership never touches tool/agent
 * entitlement — this gates ATTRIBUTION only. */
export async function assertProjectAttribution(
  db: Db,
  projectId: string,
  userId: string,
  isAdmin: boolean,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) return { ok: false, status: 400, error: "invalid_reference" };
  if (isAdmin) return { ok: true };
  const [memberCount] = await db
    .select({ members: count() })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId));
  if ((memberCount?.members ?? 0) === 0) return { ok: true };
  const [membership] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  if (!membership) return { ok: false, status: 403, error: "not_a_project_member" };
  return { ok: true };
}

type ComplianceProfileRow = typeof complianceProfiles.$inferSelect;

const PII_STRICTNESS: Record<string, number> = { log: 0, warn: 1, block: 2 };

/** §8.3: the effective policy of a SET of framework profiles. The spec gives
 * no strictness ordering among frameworks, so profiles compose additively:
 * required templates union, mcp defaults tighten to read_only if ANY profile
 * says so, retention takes the max, pii mode takes the strictest of the
 * three defined modes (block > warn > log).
 *
 * §8.3 -> §8.2 tie (pillar 3): backupRetentionDays composes as the MAX (the
 * longest floor wins) and patchCadenceDays as the MIN (the strictest cadence
 * wins). The pillar-3 infra layer consumes these — see infra.ts. */
export function effectiveCompliancePolicy(profiles: ComplianceProfileRow[]) {
  return {
    requiredTemplateIds: [...new Set(profiles.flatMap((p) => p.requiredTemplateIds ?? []))],
    mcpDefaultMode: profiles.some((p) => p.mcpDefaultMode === "read_only")
      ? ("read_only" as const)
      : ("read_write" as const),
    auditRetentionDays: profiles.reduce<number | null>(
      (m, p) =>
        p.auditRetentionDays == null ? m : Math.max(m ?? 0, p.auditRetentionDays),
      null,
    ),
    piiMode: profiles.reduce<"block" | "warn" | "log">(
      (m, p) => (PII_STRICTNESS[p.piiMode]! > PII_STRICTNESS[m]! ? (p.piiMode as never) : m),
      "log",
    ),
    backupRetentionDays: profiles.reduce<number | null>(
      (m, p) =>
        p.backupRetentionDays == null ? m : Math.max(m ?? 0, p.backupRetentionDays),
      null,
    ),
    patchCadenceDays: profiles.reduce<number | null>(
      (m, p) =>
        p.patchCadenceDays == null ? m : m == null ? p.patchCadenceDays : Math.min(m, p.patchCadenceDays),
      null,
    ),
  };
}

/** Exported for the pillar-3 infra layer (§8.3 cascade consumption): the
 * compliance profiles matching a set of tags. */
export async function complianceProfilesForTags(
  db: Db,
  tags: string[],
): Promise<ComplianceProfileRow[]> {
  return profilesForTags(db, tags);
}

async function profilesForTags(db: Db, tags: string[]): Promise<ComplianceProfileRow[]> {
  if (tags.length === 0) return [];
  const rows = await db.select().from(complianceProfiles);
  return rows.filter((p) => tags.includes(p.tag));
}

// --- §8.4 PII enforcement (pillar 3) -------------------------------------
// The compliance cascade's piiMode dimension, turned from a declared policy
// into a real enforcement point applied at every project-attributed dispatch.

export type PiiMode = "block" | "warn" | "log";

/** The effective piiMode a project's classifications force, or null when the
 * project is unclassified / has no matching compliance profile (in which case
 * PII enforcement is a no-op — unchanged behaviour). A profile always carries
 * a piiMode (the upsert defaults it to 'log'), so a matched project always
 * resolves to one of the three modes. */
export async function projectPiiMode(
  db: Db,
  projectId: string | null | undefined,
): Promise<PiiMode | null> {
  if (!projectId) return null;
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) return null;
  const tags = (project.classifications ?? []) as string[];
  if (tags.length === 0) return null;
  const profiles = await profilesForTags(db, tags);
  if (profiles.length === 0) return null;
  return effectiveCompliancePolicy(profiles).piiMode;
}

export interface PiiEnforcement {
  action: "allow" | "warn" | "block";
  hits: PiiHit[];
  phase: "input" | "output";
}

/** §8.4 message with COUNTS ONLY — never the matched substrings. */
export function piiCategoryList(hits: PiiHit[]): string {
  return hits.map((h) => h.category).join(", ");
}

/** The withheld-output marker a bill-and-withhold OUTPUT block substitutes for
 * the model/connector text — legible, and §8.4-safe (categories, never
 * content). */
export function piiWithheldMarker(hits: PiiHit[]): string {
  return `[output withheld — contained PII: ${piiCategoryList(hits)}]`;
}

/**
 * §8.4 PII enforcement decision for ONE phase. Detects PII in exactly the
 * side provided (input XOR output) and maps the project's effective piiMode
 * onto an action:
 *  - block: hits present -> 'block' (the caller denies on input BEFORE the
 *    provider call, or bills-and-withholds on output AFTER it).
 *  - warn : hits present -> 'warn' (proceed, attach a warning + audit).
 *  - log  : hits present -> 'allow' (proceed silently; the caller records the
 *    category counts in its usage/audit detail).
 * No hits (or no mode) -> 'allow', so a clean payload on a classified project
 * stays byte-identical to the pre-enforcement behaviour. Pure over its args. */
export function enforcePII(
  mode: PiiMode,
  io: { input?: string | undefined; output?: string | undefined },
): PiiEnforcement {
  const phase: "input" | "output" = io.output !== undefined ? "output" : "input";
  const text = phase === "output" ? (io.output ?? "") : (io.input ?? "");
  const hits = detectPII(text);
  if (hits.length === 0) return { action: "allow", hits, phase };
  const action = mode === "block" ? "block" : mode === "warn" ? "warn" : "allow";
  return { action, hits, phase };
}

/** §8.3 workflow cascade — the ENFORCED consumer. Returns the workflow
 * template ids a project's classifications force into every governed change
 * ("no manual per-control setup"). */
export async function requiredTemplateIdsFor(db: Db, projectId: string): Promise<string[]> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  const tags = (project?.classifications ?? []) as string[];
  const profiles = await profilesForTags(db, tags);
  return effectiveCompliancePolicy(profiles).requiredTemplateIds;
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
  const now = new Date();
  const periodKey = currentPeriodKey(now);
  if (project.budgetUsd == null || overageActive(project, periodKey)) {
    return { ok: true, project, spentUsd: 0 };
  }
  const spentUsd = await projectSpendUsd(db, projectId, { monthly: isMonthly(project), now });
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

/** The two distinct, non-blocking budget signals a dispatch can raise, surfaced
 * on the response and audited. `escalated` is the 100% crossing (routed into the
 * one approvals queue; the pre-gate blocks everything after it); `thresholdAlert`
 * is the softer configurable warning (>= budget*pct/100 but still < 100%). */
export interface ProjectBudgetSignal {
  escalated: boolean;
  thresholdAlert: boolean;
  thresholdPct: number;
  spentUsd: number;
  budgetUsd: number | null;
  period: string | null;
}

const NO_BUDGET_SIGNAL: ProjectBudgetSignal = {
  escalated: false,
  thresholdAlert: false,
  thresholdPct: 100,
  spentUsd: 0,
  budgetUsd: null,
  period: null,
};

/** Post-dispatch alert: the FIRST crossing of the budget is allowed (measured
 * cost arrives after the call) but escalates immediately into the one approvals
 * queue; the pre-gate blocks everything after it. Below the cap, if windowed
 * spend has crossed the configurable alert threshold (< 100%) a distinct
 * non-blocking 'budget-threshold-alert' is raised instead. */
export async function postDispatchProjectAlert(
  db: Db,
  gate: ProjectGate,
  userId: string,
  costUsd: number | null,
): Promise<ProjectBudgetSignal> {
  if (!gate.ok || !gate.project) return NO_BUDGET_SIGNAL;
  const project = gate.project;
  if (project.budgetUsd == null) return NO_BUDGET_SIGNAL;
  const budgetUsd = project.budgetUsd;
  const now = new Date();
  const periodKey = currentPeriodKey(now);
  const monthly = isMonthly(project);
  const pct = project.alertThresholdPct ?? 100;
  const newSpent = gate.spentUsd + (costUsd ?? 0);
  const signal: ProjectBudgetSignal = {
    escalated: false,
    thresholdAlert: false,
    thresholdPct: pct,
    spentUsd: newSpent,
    budgetUsd: project.budgetUsd,
    period: monthly ? periodKey : null,
  };
  // a sanctioned overage (scoped to this period under a monthly budget)
  // suppresses both signals until the next period
  if (overageActive(project, periodKey)) return signal;
  if (newSpent > budgetUsd) {
    await escalateProjectBudget(db, project, userId, newSpent);
    return { ...signal, escalated: true };
  }
  const thresholdUsd = (budgetUsd * pct) / 100;
  if (pct < 100 && newSpent >= thresholdUsd) {
    await db.insert(auditLog).values({
      userId,
      objectType: "project",
      objectId: project.id,
      detail: {
        phase: "project-budget-threshold",
        spentUsd: newSpent,
        budgetUsd: project.budgetUsd,
        thresholdPct: pct,
        thresholdUsd,
        ...(monthly ? { period: periodKey } : {}),
      },
      effect: "allow",
      ruleId: "budget-threshold-alert",
      ruleChain: [],
      reason: `measured project spend $${newSpent.toFixed(6)} crossed the ${pct}% alert threshold ($${thresholdUsd.toFixed(6)}) of the $${project.budgetUsd} budget — warning, dispatch proceeded`,
    });
    return { ...signal, thresholdAlert: true };
  }
  return signal;
}

/** Decide-endpoint hook for objectType 'project': budget overages and
 * shared-context conflicts (§9 arbiter resolution) ride the same one queue.
 * Both outcomes of both kinds are audited — never a silent path. */
export async function applyProjectApprovalDecision(
  db: Db,
  approvalRow: { projectId: string | null; stageId: string | null },
  decision: "approved" | "denied",
  deciderUserId: string,
): Promise<void> {
  if (!approvalRow.projectId) return;
  // §8.3 reclassification: the diff was reviewed — approve commits the
  // proposed tags, deny discards them; the current cascade stays either way
  // until this moment. Never applied silently.
  if (approvalRow.stageId === "__reclassification__") {
    const [project] = await db.select().from(projects).where(eq(projects.id, approvalRow.projectId));
    if (!project) return;
    const proposed = (project.pendingClassifications ?? null) as string[] | null;
    if (decision === "approved" && proposed) {
      await db
        .update(projects)
        .set({ classifications: proposed, pendingClassifications: null })
        .where(eq(projects.id, approvalRow.projectId));
    } else {
      await db
        .update(projects)
        .set({ pendingClassifications: null })
        .where(eq(projects.id, approvalRow.projectId));
    }
    await db.insert(auditLog).values({
      userId: deciderUserId,
      objectType: "project",
      objectId: approvalRow.projectId,
      detail: {
        phase: "reclassification-decision",
        decision,
        from: project.classifications ?? [],
        proposed: proposed ?? [],
      },
      effect: decision === "approved" ? "allow" : "deny",
      ruleId:
        decision === "approved" ? "project-reclassified" : "project-reclassification-rejected",
      ruleChain: [],
      reason:
        decision === "approved"
          ? "reclassification diff approved; the new cascade is now in force"
          : "reclassification rejected; the previous classifications remain in force",
    });
    return;
  }
  // §9 conflict resolution: approve = the retained conflicting revision
  // becomes the accepted latest; deny = it stays retained, never current.
  if (approvalRow.stageId?.startsWith(CONTEXT_CONFLICT_PREFIX)) {
    const itemId = approvalRow.stageId.slice(CONTEXT_CONFLICT_PREFIX.length);
    if (decision === "approved") {
      await db
        .update(projectContextItems)
        .set({ accepted: true })
        .where(eq(projectContextItems.id, itemId));
    }
    await db.insert(auditLog).values({
      userId: deciderUserId,
      objectType: "project",
      objectId: approvalRow.projectId,
      detail: { phase: "context-conflict-decision", itemId, decision },
      effect: decision === "approved" ? "allow" : "deny",
      ruleId:
        decision === "approved" ? "project-context-conflict-accepted" : "project-context-conflict-rejected",
      ruleChain: [],
      reason:
        decision === "approved"
          ? "conflicting context revision accepted by the named arbiter; it is now the current value"
          : "conflicting context revision rejected by the named arbiter; retained but never current",
    });
    return;
  }
  if (approvalRow.stageId !== "__project_budget__") return;
  if (decision === "approved") {
    // scope the latch to the CURRENT period under a monthly budget, so the
    // sanction expires at the next rollover; a lifetime budget stays unscoped
    const [proj] = await db.select().from(projects).where(eq(projects.id, approvalRow.projectId));
    await db
      .update(projects)
      .set({
        overageApproved: true,
        overageApprovedPeriod: proj && isMonthly(proj) ? currentPeriodKey() : null,
      })
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
 * Readable by admins (the FinOps fleet view) and by the project's own
 * MEMBERS (§9.3 — the people whose work the numbers are), enforced in the
 * route. */
const ROLE_RANK: Record<string, number> = { viewer: 0, contributor: 1, owner: 2 };

export function registerProjectRoutes(app: FastifyInstance, db: Db) {
  /** §9.3: per-user, per-Shared-Project access — viewer reads, contributor+
   * writes, owner administers membership. Admins bypass. Returns the
   * membership row for provenance defaults. */
  async function requireRole(
    req: { authCtx: { userId: string | null; isAdmin: boolean } },
    projectId: string,
    minRole: "viewer" | "contributor" | "owner",
  ): Promise<
    | { ok: true; membership: typeof projectMembers.$inferSelect | null }
    | { ok: false; status: number; error: string }
  > {
    if (req.authCtx.isAdmin) return { ok: true, membership: null };
    if (!req.authCtx.userId) return { ok: false, status: 403, error: "forbidden" };
    const [membership] = await db
      .select()
      .from(projectMembers)
      .where(
        and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, req.authCtx.userId)),
      );
    if (!membership || ROLE_RANK[membership.role]! < ROLE_RANK[minRole]!) {
      return { ok: false, status: 403, error: "forbidden" };
    }
    return { ok: true, membership };
  }

  /** Display enrichment (same discipline as the approvals list): resolve user
   * and team ids to names in one pass. Provenance ids are FK-free by design,
   * so a deleted contributor simply resolves to null — never an error. */
  async function nameMaps(
    userIds: Array<string | null | undefined>,
    teamIds: Array<string | null | undefined>,
  ) {
    const uids = [...new Set(userIds.filter((x): x is string => Boolean(x)))];
    const tids = [...new Set(teamIds.filter((x): x is string => Boolean(x)))];
    const [userRows, teamRows] = await Promise.all([
      uids.length
        ? db
            .select({ id: users.id, displayName: users.displayName, email: users.email })
            .from(users)
            .where(inArray(users.id, uids))
        : [],
      tids.length
        ? db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, tids))
        : [],
    ]);
    return {
      userName: new Map(userRows.map((u) => [u.id, u.displayName || u.email])),
      teamName: new Map(teamRows.map((t) => [t.id, t.name])),
    };
  }

  /** Which retained (accepted=false) context items still have their conflict
   * PENDING with the arbiter — itemId -> approvalId. A retained item with no
   * pending approval was denied: historical, never current. */
  async function pendingConflictApprovals(
    projectId: string,
    itemIds: string[],
  ): Promise<Map<string, string>> {
    if (itemIds.length === 0) return new Map();
    const rows = await db
      .select({ id: approvals.id, stageId: approvals.stageId })
      .from(approvals)
      .where(
        and(
          eq(approvals.projectId, projectId),
          eq(approvals.status, "pending"),
          inArray(
            approvals.stageId,
            itemIds.map((id) => `${CONTEXT_CONFLICT_PREFIX}${id}`),
          ),
        ),
      );
    return new Map(rows.map((r) => [r.stageId!.slice(CONTEXT_CONFLICT_PREFIX.length), r.id]));
  }

  app.post("/v1/projects", async (req, reply) => {
    const body = createProjectSchema.parse(req.body);
    const [row] = await db
      .insert(projects)
      .values({
        name: body.name,
        costCenter: body.costCenter ?? null,
        budgetUsd: body.budgetUsd ?? null,
        budgetApproverUserId: body.budgetApproverUserId ?? null,
        budgetPeriod: body.budgetPeriod ?? "none",
        alertThresholdPct: body.alertThresholdPct ?? 100,
        arbiterUserId: body.arbiterUserId ?? null,
        classifications: body.classifications ?? null,
        initiativeId: body.initiativeId ?? null,
      })
      .returning();
    return reply.status(201).send(row);
  });

  // Post-creation edits (admin-only by the default gate): budget, approver,
  // arbiter, cost center, name. Classifications never ride this route — a
  // reclassification is a governed diff-then-approve change (§8.3), and a
  // PATCH that could slip one through would bypass that review.
  app.patch("/v1/projects/:projectId", async (req, reply) => {
    const { projectId } = projectIdParam.parse(req.params);
    const body = updateProjectSchema.parse(req.body);
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) return reply.status(404).send({ error: "unknown_project" });
    const merged = {
      name: body.name ?? project.name,
      costCenter: body.costCenter === undefined ? project.costCenter : body.costCenter,
      budgetUsd: body.budgetUsd === undefined ? project.budgetUsd : body.budgetUsd,
      budgetApproverUserId:
        body.budgetApproverUserId === undefined
          ? project.budgetApproverUserId
          : body.budgetApproverUserId,
      budgetPeriod: body.budgetPeriod === undefined ? project.budgetPeriod : body.budgetPeriod,
      alertThresholdPct:
        body.alertThresholdPct === undefined ? project.alertThresholdPct : body.alertThresholdPct,
      arbiterUserId: body.arbiterUserId === undefined ? project.arbiterUserId : body.arbiterUserId,
      initiativeId:
        body.initiativeId === undefined ? project.initiativeId : body.initiativeId,
    };
    // the create-time invariant, held against the row this patch would leave
    if (merged.budgetUsd != null && merged.budgetApproverUserId == null) {
      return reply.status(422).send({
        error: "budget_requires_approver",
        detail: "a project budget requires a budgetApproverUserId",
      });
    }
    const [row] = await db.update(projects).set(merged).where(eq(projects.id, projectId)).returning();
    const changed = Object.fromEntries(
      Object.entries(body).filter(([, v]) => v !== undefined),
    ) as Record<string, unknown>;
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? project.budgetApproverUserId ?? projectId,
      objectType: "project",
      objectId: projectId,
      detail: { phase: "update", changed },
      effect: "allow",
      ruleId: "project-updated",
      ruleChain: [],
      reason: `project '${project.name}' updated: ${Object.keys(changed).join(", ")}`,
    });
    return row;
  });

  // ---------------------------------------------------------------------------
  // PILLAR 5 cross-team rollup: Initiatives. A flat, reporting-only grouping of
  // projects for cost attribution above the single-project level. ADMIN ONLY by
  // the default gate — a rollup spans projects a non-admin may not be a member
  // of. v1 is grouping only: NO initiative-level budget or enforcement, and
  // grouping a project changes NONE of its own governance or budget behaviour.
  app.post("/v1/initiatives", async (req, reply) => {
    const body = createInitiativeSchema.parse(req.body);
    const [row] = await db
      .insert(initiatives)
      .values({ name: body.name, costCenter: body.costCenter ?? null })
      .returning();
    return reply.status(201).send(row);
  });

  // Every initiative with its child-project count and rolled-up LIFETIME spend.
  // Count and spend are each one grouped pass (over projects, and over
  // usage_events joined to projects), mapped back on initiativeId; an initiative
  // with no children reads 0 projects / $0.
  app.get("/v1/initiatives", async (_req, _reply) => {
    const [rows, childCounts, spendByInitiative] = await Promise.all([
      db.select().from(initiatives).orderBy(desc(initiatives.createdAt)),
      db
        .select({ initiativeId: projects.initiativeId, projectCount: count() })
        .from(projects)
        .groupBy(projects.initiativeId),
      db
        .select({
          initiativeId: projects.initiativeId,
          costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
        })
        .from(usageEvents)
        .innerJoin(projects, eq(usageEvents.projectId, projects.id))
        .groupBy(projects.initiativeId),
    ]);
    const countMap = new Map(childCounts.map((c) => [c.initiativeId, c.projectCount]));
    const spendMap = new Map(spendByInitiative.map((s) => [s.initiativeId, s.costUsd]));
    return {
      initiatives: rows.map((r) => ({
        ...r,
        projectCount: countMap.get(r.id) ?? 0,
        spentUsd: spendMap.get(r.id) ?? 0,
      })),
    };
  });

  // One initiative with its child projects (each carrying its lifetime spend)
  // and the rolled-up total. 404 on an unknown id.
  app.get("/v1/initiatives/:initiativeId", async (req, reply) => {
    const { initiativeId } = initiativeIdParam.parse(req.params);
    const [initiative] = await db
      .select()
      .from(initiatives)
      .where(eq(initiatives.id, initiativeId));
    if (!initiative) return reply.status(404).send({ error: "unknown_initiative" });
    // left join so a child project with no spend still appears at $0
    const children = await db
      .select({
        id: projects.id,
        name: projects.name,
        spentUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
      })
      .from(projects)
      .leftJoin(usageEvents, eq(usageEvents.projectId, projects.id))
      .where(eq(projects.initiativeId, initiativeId))
      .groupBy(projects.id, projects.name);
    const totalUsd = Number(children.reduce((s, c) => s + (c.spentUsd ?? 0), 0).toFixed(6));
    return { initiative, projects: children, projectCount: children.length, spentUsd: totalUsd };
  });

  // Rename / re-cost-center an initiative (grouping only). 404 on unknown id.
  app.patch("/v1/initiatives/:initiativeId", async (req, reply) => {
    const { initiativeId } = initiativeIdParam.parse(req.params);
    const body = updateInitiativeSchema.parse(req.body);
    const [initiative] = await db
      .select()
      .from(initiatives)
      .where(eq(initiatives.id, initiativeId));
    if (!initiative) return reply.status(404).send({ error: "unknown_initiative" });
    const merged = {
      name: body.name ?? initiative.name,
      costCenter: body.costCenter === undefined ? initiative.costCenter : body.costCenter,
    };
    const [row] = await db
      .update(initiatives)
      .set(merged)
      .where(eq(initiatives.id, initiativeId))
      .returning();
    const changed = Object.fromEntries(
      Object.entries(body).filter(([, v]) => v !== undefined),
    ) as Record<string, unknown>;
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? initiativeId,
      objectType: "initiative",
      objectId: initiativeId,
      detail: { phase: "update", changed },
      effect: "allow",
      ruleId: "initiative-updated",
      ruleChain: [],
      reason: `initiative '${initiative.name}' updated: ${Object.keys(changed).join(", ")}`,
    });
    return row;
  });

  // Delete an initiative. The FK onDelete='set null' orphans its children back
  // to ungrouped automatically — a project row is never deleted with it.
  app.delete("/v1/initiatives/:initiativeId", async (req, reply) => {
    const { initiativeId } = initiativeIdParam.parse(req.params);
    const [initiative] = await db
      .select()
      .from(initiatives)
      .where(eq(initiatives.id, initiativeId));
    if (!initiative) return reply.status(404).send({ error: "unknown_initiative" });
    await db.delete(initiatives).where(eq(initiatives.id, initiativeId));
    return reply.status(200).send({ ok: true });
  });

  // fleet for admins; non-admins see the projects they are members of
  app.get("/v1/projects", async (req, reply) => {
    let memberProjectIds: string[] | null = null;
    if (!req.authCtx.isAdmin) {
      if (!req.authCtx.userId) return reply.status(403).send({ error: "bootstrap_has_no_projects" });
      const memberships = await db
        .select({ projectId: projectMembers.projectId })
        .from(projectMembers)
        .where(eq(projectMembers.userId, req.authCtx.userId));
      memberProjectIds = memberships.map((m) => m.projectId);
      if (memberProjectIds.length === 0) return { projects: [] };
    }
    const [rows, spend] = await Promise.all([
      db
        .select()
        .from(projects)
        .where(memberProjectIds ? inArray(projects.id, memberProjectIds) : undefined),
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

  // --- teams (admin) ---

  app.post("/v1/teams", async (req, reply) => {
    const body = createTeamSchema.parse(req.body);
    const [row] = await db
      .insert(teams)
      .values({ name: body.name, defaultClassifications: body.defaultClassifications ?? null })
      .returning();
    return reply.status(201).send(row);
  });

  // Purely additive enrichment (same discipline as the approvals list): each
  // team carries its members with names, so the /admin Teams table can show
  // who is on a team without a second endpoint or the raw user-id table.
  app.get("/v1/teams", async () => {
    const [rows, memberRows] = await Promise.all([
      db.select().from(teams),
      db
        .select({
          teamId: teamMembers.teamId,
          userId: teamMembers.userId,
          displayName: users.displayName,
          email: users.email,
        })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId)),
    ]);
    const byTeam = new Map<string, Array<{ userId: string; name: string }>>();
    for (const m of memberRows) {
      const list = byTeam.get(m.teamId) ?? [];
      list.push({ userId: m.userId, name: m.displayName || m.email });
      byTeam.set(m.teamId, list);
    }
    return { teams: rows.map((t) => ({ ...t, members: byTeam.get(t.id) ?? [] })) };
  });

  app.post("/v1/teams/:teamId/members", async (req, reply) => {
    const { teamId } = z.object({ teamId: z.string().uuid() }).parse(req.params);
    const body = addTeamMemberSchema.parse(req.body);
    const [row] = await db.insert(teamMembers).values({ teamId, userId: body.userId }).returning();
    return reply.status(201).send(row);
  });

  // --- Shared-Project membership (§9.2/§9.3, ADR-0011) ---
  // Roles are per-user and independent of home-team role. Membership widens
  // CONTEXT visibility and attribution only — never tool/connector/agent
  // entitlement (§2–§4 evaluation is untouched by anything here).

  app.post("/v1/projects/:projectId/members", async (req, reply) => {
    const { projectId } = projectIdParam.parse(req.params);
    const body = addProjectMemberSchema.parse(req.body);
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) return reply.status(404).send({ error: "unknown_project" });
    const gate = await requireRole(req, projectId, "owner");
    if (!gate.ok) return reply.status(gate.status).send({ error: gate.error });
    // provenance team must really be one of the member's teams
    if (body.teamId) {
      const [inTeam] = await db
        .select({ id: teamMembers.id })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, body.teamId), eq(teamMembers.userId, body.userId)));
      if (!inTeam) return reply.status(422).send({ error: "not_in_team" });
    }
    const [row] = await db
      .insert(projectMembers)
      .values({ projectId, userId: body.userId, role: body.role, teamId: body.teamId ?? null })
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? body.userId,
      objectType: "project",
      objectId: projectId,
      detail: { phase: "membership", memberUserId: body.userId, role: body.role, teamId: body.teamId ?? null },
      effect: "allow",
      ruleId: "project-member-added",
      ruleChain: [],
      reason: `user granted '${body.role}' on shared project '${project.name}'`,
    });
    // §9.3: the project's classification governs inside the project; a
    // member team whose defaults disagree is SURFACED here (response +
    // audit), never silently resolved.
    let classificationConflict: Record<string, unknown> | null = null;
    if (body.teamId) {
      const [team] = await db.select().from(teams).where(eq(teams.id, body.teamId));
      const teamTags = (team?.defaultClassifications ?? []) as string[];
      const projectTags = (project.classifications ?? []) as string[];
      const missing = teamTags.filter((t) => !projectTags.includes(t));
      if (missing.length > 0) {
        classificationConflict = {
          teamId: body.teamId,
          teamDefaults: teamTags,
          projectClassifications: projectTags,
          notCoveredByProject: missing,
          governing: "project",
        };
        await db.insert(auditLog).values({
          userId: req.authCtx.userId ?? body.userId,
          objectType: "project",
          objectId: projectId,
          detail: { phase: "classification-conflict", ...classificationConflict },
          effect: "allow",
          ruleId: "team-classification-conflict-surfaced",
          ruleChain: [],
          reason: `member team's default classifications [${missing.join(", ")}] are not covered by the project's [${projectTags.join(", ")}]; the project's classification governs inside the project`,
        });
      }
    }
    return reply
      .status(201)
      .send(classificationConflict ? { ...row, classificationConflict } : row);
  });

  app.get("/v1/projects/:projectId/members", async (req, reply) => {
    const { projectId } = projectIdParam.parse(req.params);
    const gate = await requireRole(req, projectId, "viewer");
    if (!gate.ok) return reply.status(gate.status).send({ error: gate.error });
    const rows = await db
      .select()
      .from(projectMembers)
      .where(eq(projectMembers.projectId, projectId));
    // additive: names, so the /app Members surface can say who — a member has
    // no access to the admin-only user list
    const names = await nameMaps(
      rows.map((r) => r.userId),
      rows.map((r) => r.teamId),
    );
    return {
      members: rows.map((r) => ({
        ...r,
        userName: names.userName.get(r.userId) ?? null,
        teamName: r.teamId ? (names.teamName.get(r.teamId) ?? null) : null,
      })),
    };
  });

  // Membership lifecycle (owner-only): a role change and a removal are the
  // only two mutators — membership is otherwise add-only. Both are guarded by
  // LAST-OWNER PROTECTION: a demote-away-from-owner or a remove of the sole
  // remaining owner is hard-blocked (409 last_owner) so a Shared Project can
  // never be orphaned without an administrator.
  const memberParams = z.object({ projectId: z.string().uuid(), userId: z.string().uuid() });

  async function ownerCount(projectId: string): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.role, "owner")));
    return row?.n ?? 0;
  }

  app.patch("/v1/projects/:projectId/members/:userId", async (req, reply) => {
    const { projectId, userId } = memberParams.parse(req.params);
    const body = patchProjectMemberSchema.parse(req.body);
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) return reply.status(404).send({ error: "unknown_project" });
    const gate = await requireRole(req, projectId, "owner");
    if (!gate.ok) return reply.status(gate.status).send({ error: gate.error });
    const [member] = await db
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
    if (!member) return reply.status(404).send({ error: "not_a_member" });
    // last-owner protection: demoting the sole owner would orphan the project
    if (member.role === "owner" && body.role !== "owner" && (await ownerCount(projectId)) <= 1) {
      return reply.status(409).send({ error: "last_owner" });
    }
    const [row] = await db
      .update(projectMembers)
      .set({ role: body.role })
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? userId,
      objectType: "project",
      objectId: projectId,
      detail: { phase: "membership", memberUserId: userId, from: member.role, role: body.role },
      effect: "allow",
      ruleId: "project-member-role-changed",
      ruleChain: [],
      reason: `member role changed '${member.role}' -> '${body.role}' on shared project '${project.name}'`,
    });
    return row;
  });

  app.delete("/v1/projects/:projectId/members/:userId", async (req, reply) => {
    const { projectId, userId } = memberParams.parse(req.params);
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) return reply.status(404).send({ error: "unknown_project" });
    const gate = await requireRole(req, projectId, "owner");
    if (!gate.ok) return reply.status(gate.status).send({ error: gate.error });
    const [member] = await db
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
    if (!member) return reply.status(404).send({ error: "not_a_member" });
    // last-owner protection: removing the sole owner would orphan the project
    if (member.role === "owner" && (await ownerCount(projectId)) <= 1) {
      return reply.status(409).send({ error: "last_owner" });
    }
    await db
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? userId,
      objectType: "project",
      objectId: projectId,
      detail: { phase: "membership", memberUserId: userId, removedRole: member.role },
      effect: "allow",
      ruleId: "project-member-removed",
      ruleChain: [],
      reason: `member removed from shared project '${project.name}'`,
    });
    return reply.status(200).send({ removed: true });
  });

  // --- shared context store (§9.2, ADR-0011): append-only revisions ---

  async function writeContextRevision(
    req: { authCtx: { userId: string | null; isAdmin: boolean } },
    reply: { status: (code: number) => { send: (body: unknown) => unknown } },
    projectId: string,
    args: {
      key: string;
      content: string;
      baseRevision?: number | undefined;
      teamId?: string | null | undefined;
      sourceArtifactId?: string | null;
    },
  ) {
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) return reply.status(404).send({ error: "unknown_project" });
    const gate = await requireRole(req, projectId, "contributor");
    if (!gate.ok) return reply.status(gate.status).send({ error: gate.error });
    // Authorship REQUIRES a real authenticated user — a context contribution is
    // a provenance record, so it can never be attributed to a governance-role
    // holder the writer merely happens to sit under. The bootstrap token (no
    // userId) simply cannot contribute; it is not silently reattributed.
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_contribute" });
    // provenance team must be one of the writer's teams (default: membership's)
    let teamId = args.teamId ?? gate.membership?.teamId ?? null;
    if (args.teamId) {
      const [inTeam] = await db
        .select({ id: teamMembers.id })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, args.teamId), eq(teamMembers.userId, userId)));
      if (!inTeam) return reply.status(422).send({ error: "not_in_team" });
    }

    // The read (maxRevision/latestAccepted) + insert run inside ONE
    // transaction, and (project_id, key, revision) is UNIQUE (migration 0019).
    // Two concurrent same-key writes that compute the SAME next revision can
    // therefore never both land: one commits, the other's insert hits the
    // unique violation. That loser is retried once against the winner's now-
    // committed row — recomputing to a distinct higher revision, or (if the
    // winner advanced the accepted head past its base) becoming a conflict
    // routed to the arbiter — so a lost race is a clean outcome, never a
    // duplicate revision number.
    type Outcome =
      | { kind: "reply"; status: number; body: unknown }
      | { kind: "created"; body: Record<string, unknown> };
    const attempt = (): Promise<Outcome> =>
      db.transaction(async (tx): Promise<Outcome> => {
        const rows = await tx
          .select({ revision: projectContextItems.revision, accepted: projectContextItems.accepted })
          .from(projectContextItems)
          .where(and(eq(projectContextItems.projectId, projectId), eq(projectContextItems.key, args.key)));
        const maxRevision = rows.reduce((m, r) => Math.max(m, r.revision), 0);
        const latestAccepted = rows.filter((r) => r.accepted).reduce((m, r) => Math.max(m, r.revision), 0);
        const revision = maxRevision + 1;

        // read-before-write is explicit: once a key exists, a write must name
        // the accepted revision it is based on — never a silent overwrite (§9.2)
        if (rows.length > 0 && args.baseRevision === undefined) {
          return { kind: "reply", status: 409, body: { error: "base_revision_required", latestAccepted } };
        }
        const conflicting = rows.length > 0 && args.baseRevision !== latestAccepted;
        if (conflicting && !project.arbiterUserId) {
          return {
            kind: "reply",
            status: 422,
            body: { error: "no_arbiter", detail: "set arbiterUserId to accept conflicting revisions" },
          };
        }

        const [item] = await tx
          .insert(projectContextItems)
          .values({
            projectId,
            key: args.key,
            revision,
            content: args.content,
            baseRevision: args.baseRevision ?? null,
            accepted: !conflicting,
            contributedByUserId: userId,
            contributedByTeamId: teamId,
            sourceArtifactId: args.sourceArtifactId ?? null,
          })
          .returning();

        let approvalId: string | null = null;
        if (conflicting) {
          const [approval] = await tx
            .insert(approvals)
            .values({
              userId,
              objectType: "project",
              projectId,
              stageId: `${CONTEXT_CONFLICT_PREFIX}${item!.id}`,
              approverUserId: project.arbiterUserId!,
            })
            .returning({ id: approvals.id });
          approvalId = approval!.id;
        }
        await tx.insert(auditLog).values({
          userId,
          objectType: "project",
          objectId: projectId,
          detail: {
            phase: "context",
            key: args.key,
            revision,
            baseRevision: args.baseRevision ?? null,
            conflicting,
            teamId,
            ...(args.sourceArtifactId ? { sourceArtifactId: args.sourceArtifactId } : {}),
          },
          effect: conflicting ? "require_approval" : "allow",
          ruleId: conflicting ? "project-context-conflict" : "project-context-contributed",
          ruleChain: [],
          reason: conflicting
            ? `revision ${revision} of '${args.key}' is based on stale revision ${args.baseRevision}; retained and routed to the named arbiter — never silently overwritten`
            : `revision ${revision} of '${args.key}' accepted`,
        });
        return {
          kind: "created",
          body: {
            id: item!.id,
            key: args.key,
            revision,
            accepted: !conflicting,
            ...(conflicting ? { conflict: true, approvalId } : {}),
          },
        };
      });

    const isUniqueViolation = (e: unknown) =>
      (e as { cause?: { code?: string } }).cause?.code === "23505";
    let outcome: Outcome;
    try {
      outcome = await attempt();
    } catch (e) {
      // lost the revision-number race — recompute against the winner's commit
      // and try exactly once more; a second collision surfaces as a clean 409
      // via the global constraint handler.
      if (!isUniqueViolation(e)) throw e;
      outcome = await attempt();
    }
    if (outcome.kind === "reply") return reply.status(outcome.status).send(outcome.body);
    return reply.status(201).send(outcome.body);
  }

  app.post("/v1/projects/:projectId/context", async (req, reply) => {
    const { projectId } = projectIdParam.parse(req.params);
    const body = contributeContextSchema.parse(req.body);
    return writeContextRevision(req, reply, projectId, body);
  });

  // §9.4 promote-to-shared: copy a team-local workflow artifact into the
  // shared store with source provenance. Only the artifact's own instance
  // initiator (or an admin) may promote — partial sharing is opt-in and never
  // exposes a workspace someone else owns.
  app.post("/v1/projects/:projectId/context/promote", async (req, reply) => {
    const { projectId } = projectIdParam.parse(req.params);
    const body = promoteContextSchema.parse(req.body);
    const [artifact] = await db
      .select()
      .from(workflowArtifacts)
      .where(eq(workflowArtifacts.id, body.artifactId));
    if (!artifact) return reply.status(404).send({ error: "unknown_artifact" });
    const [instance] = await db
      .select({ initiatorUserId: workflowInstances.initiatorUserId })
      .from(workflowInstances)
      .where(eq(workflowInstances.id, artifact.instanceId));
    if (!req.authCtx.isAdmin && req.authCtx.userId !== instance?.initiatorUserId) {
      return reply.status(403).send({ error: "not_the_artifact_owner" });
    }
    // promotion lands on top of the current accepted revision of the key
    const [latest] = await db
      .select({ revision: projectContextItems.revision })
      .from(projectContextItems)
      .where(
        and(
          eq(projectContextItems.projectId, projectId),
          eq(projectContextItems.key, artifact.output),
          eq(projectContextItems.accepted, true),
        ),
      )
      .orderBy(desc(projectContextItems.revision))
      .limit(1);
    return writeContextRevision(req, reply, projectId, {
      key: artifact.output,
      content: artifact.content,
      baseRevision: latest?.revision,
      sourceArtifactId: artifact.id,
    });
  });

  app.get("/v1/projects/:projectId/context", async (req, reply) => {
    const { projectId } = projectIdParam.parse(req.params);
    const q = z
      .object({ key: z.string().optional(), history: z.coerce.boolean().default(false) })
      .parse(req.query);
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) return reply.status(404).send({ error: "unknown_project" });
    const gate = await requireRole(req, projectId, "viewer");
    if (!gate.ok) return reply.status(gate.status).send({ error: gate.error });

    if (q.key && q.history) {
      // full retained history for one key — every side of every conflict.
      // Each row additively carries its author/team names and, for a retained
      // row, whether its conflict is still pending with the arbiter — so the
      // /app history drawer can say accepted / awaiting arbiter / rejected.
      const rows = await db
        .select()
        .from(projectContextItems)
        .where(and(eq(projectContextItems.projectId, projectId), eq(projectContextItems.key, q.key)))
        .orderBy(projectContextItems.revision);
      const [names, pendingMap] = await Promise.all([
        nameMaps(
          rows.map((r) => r.contributedByUserId),
          rows.map((r) => r.contributedByTeamId),
        ),
        pendingConflictApprovals(
          projectId,
          rows.filter((r) => !r.accepted).map((r) => r.id),
        ),
      ]);
      return {
        history: rows.map((r) => ({
          ...r,
          byName: names.userName.get(r.contributedByUserId) ?? null,
          teamName: r.contributedByTeamId ? (names.teamName.get(r.contributedByTeamId) ?? null) : null,
          pendingApprovalId: pendingMap.get(r.id) ?? null,
        })),
      };
    }
    // current value per key = highest ACCEPTED revision, with provenance
    const [rows, retained] = await Promise.all([
      db
        .select()
        .from(projectContextItems)
        .where(
          and(
            eq(projectContextItems.projectId, projectId),
            eq(projectContextItems.accepted, true),
            ...(q.key ? [eq(projectContextItems.key, q.key)] : []),
          ),
        )
        .orderBy(projectContextItems.revision),
      // retained-not-accepted revisions whose conflict still awaits the
      // arbiter — the card's "N revisions awaiting arbiter" marker
      db
        .select()
        .from(projectContextItems)
        .where(
          and(
            eq(projectContextItems.projectId, projectId),
            eq(projectContextItems.accepted, false),
            ...(q.key ? [eq(projectContextItems.key, q.key)] : []),
          ),
        )
        .orderBy(projectContextItems.revision),
    ]);
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) latest.set(row.key, row);
    const pendingMap = await pendingConflictApprovals(
      projectId,
      retained.map((r) => r.id),
    );
    const pendingItems = retained.filter((r) => pendingMap.has(r.id));
    const names = await nameMaps(
      [...latest.values(), ...pendingItems]
        .map((r) => r.contributedByUserId)
        .concat(project.arbiterUserId ? [project.arbiterUserId] : []),
      [...latest.values(), ...pendingItems].map((r) => r.contributedByTeamId),
    );
    return {
      context: [...latest.values()].map((r) => ({
        key: r.key,
        revision: r.revision,
        content: r.content,
        provenance: {
          userId: r.contributedByUserId,
          userName: names.userName.get(r.contributedByUserId) ?? null,
          teamId: r.contributedByTeamId,
          teamName: r.contributedByTeamId ? (names.teamName.get(r.contributedByTeamId) ?? null) : null,
          sourceArtifactId: r.sourceArtifactId,
          at: r.createdAt,
        },
      })),
      pending: pendingItems.map((r) => ({
        itemId: r.id,
        key: r.key,
        revision: r.revision,
        baseRevision: r.baseRevision,
        content: r.content,
        byName: names.userName.get(r.contributedByUserId) ?? null,
        teamName: r.contributedByTeamId ? (names.teamName.get(r.contributedByTeamId) ?? null) : null,
        at: r.createdAt,
        approvalId: pendingMap.get(r.id)!,
      })),
      // for the editor's "this will be sent to <arbiter>" copy
      arbiter: project.arbiterUserId
        ? { userId: project.arbiterUserId, name: names.userName.get(project.arbiterUserId) ?? null }
        : null,
    };
  });

  // Whole-project context as GRAPH-READY data in ONE call: every revision of
  // every key (incl. retained conflicts) as nodes, with the accepted head per
  // key for grouping. Version lineage is baseRevision -> revision; a conflict
  // (accepted=false) forks off its baseRevision. Viewer/member-gated exactly
  // like the other context endpoints. Content is truncated to a light preview.
  app.get("/v1/projects/:projectId/context/graph", async (req, reply) => {
    const { projectId } = projectIdParam.parse(req.params);
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) return reply.status(404).send({ error: "unknown_project" });
    const gate = await requireRole(req, projectId, "viewer");
    if (!gate.ok) return reply.status(gate.status).send({ error: gate.error });

    const rows = await db
      .select()
      .from(projectContextItems)
      .where(eq(projectContextItems.projectId, projectId))
      .orderBy(projectContextItems.key, projectContextItems.revision);

    const [names, pendingMap] = await Promise.all([
      nameMaps(
        rows.map((r) => r.contributedByUserId),
        rows.map((r) => r.contributedByTeamId),
      ),
      pendingConflictApprovals(
        projectId,
        rows.filter((r) => !r.accepted).map((r) => r.id),
      ),
    ]);

    // accepted head per key = highest accepted revision (rows are asc by rev)
    const currentByKey = new Map<string, number>();
    for (const r of rows) if (r.accepted) currentByKey.set(r.key, r.revision);

    const PREVIEW_LEN = 240;
    return {
      project: { id: project.id, name: project.name },
      nodes: rows.map((r) => ({
        id: r.id,
        key: r.key,
        revision: r.revision,
        baseRevision: r.baseRevision,
        accepted: r.accepted,
        pending: pendingMap.has(r.id),
        content:
          r.content.length > PREVIEW_LEN ? `${r.content.slice(0, PREVIEW_LEN)}…` : r.content,
        contributor: {
          userId: r.contributedByUserId,
          name: names.userName.get(r.contributedByUserId) ?? null,
          teamId: r.contributedByTeamId,
          teamName: r.contributedByTeamId
            ? (names.teamName.get(r.contributedByTeamId) ?? null)
            : null,
        },
        at: r.createdAt,
      })),
      keys: [...currentByKey.entries()].map(([key, currentRevision]) => ({
        key,
        currentRevision,
      })),
    };
  });

  // --- §8.3 compliance profiles (admin; policy-as-code via API) ---

  app.post("/v1/compliance/profiles", async (req, reply) => {
    const body = upsertComplianceProfileSchema.parse(req.body);
    if (body.requiredTemplateIds?.length) {
      const found = await db
        .select({ id: workflowTemplates.id })
        .from(workflowTemplates);
      const known = new Set(found.map((t) => t.id));
      if (body.requiredTemplateIds.some((id) => !known.has(id))) {
        return reply.status(422).send({ error: "unknown_template" });
      }
    }
    const values = {
      tag: body.tag,
      requiredTemplateIds: body.requiredTemplateIds ?? null,
      mcpDefaultMode: body.mcpDefaultMode ?? ("read_write" as const),
      auditRetentionDays: body.auditRetentionDays ?? null,
      piiMode: body.piiMode ?? ("log" as const),
      backupRetentionDays: body.backupRetentionDays ?? null,
      patchCadenceDays: body.patchCadenceDays ?? null,
    };
    const [row] = await db
      .insert(complianceProfiles)
      .values(values)
      .onConflictDoUpdate({ target: complianceProfiles.tag, set: values })
      .returning();
    return reply.status(201).send(row);
  });

  app.get("/v1/compliance/profiles", async () => ({
    profiles: await db.select().from(complianceProfiles),
  }));

  // §8.4 audit-log retention: audit_log has NO projectId column, so retention
  // is a single GLOBAL floor = the MAX auditRetentionDays across ALL compliance
  // profiles (longest-floor-wins, the same discipline the infra backup floor
  // uses). A framework with a shorter retention can never shorten another
  // framework's audit trail. Both endpoints are admin-only (the global gate).

  /** Compute the global retention floor + how many rows currently sit below
   * it — the admin's before-you-prune view. maxDays null = no profile sets a
   * retention, so nothing is ever eligible for pruning (fail-safe: keep all). */
  async function retentionFloor(): Promise<{
    retainedDays: number | null;
    floorSource: string[];
    cutoff: Date | null;
    prunable: number;
  }> {
    const profiles = await db.select().from(complianceProfiles);
    const withDays = profiles.filter(
      (p): p is typeof p & { auditRetentionDays: number } => p.auditRetentionDays != null,
    );
    if (withDays.length === 0) {
      return { retainedDays: null, floorSource: [], cutoff: null, prunable: 0 };
    }
    const retainedDays = withDays.reduce((m, p) => Math.max(m, p.auditRetentionDays), 0);
    const floorSource = withDays
      .filter((p) => p.auditRetentionDays === retainedDays)
      .map((p) => p.tag);
    const cutoff = new Date(Date.now() - retainedDays * 24 * 3600 * 1000);
    const [row] = await db
      .select({ n: count() })
      .from(auditLog)
      .where(lt(auditLog.at, cutoff));
    return { retainedDays, floorSource, cutoff, prunable: row?.n ?? 0 };
  }

  app.get("/v1/audit/retention", async () => {
    const f = await retentionFloor();
    return {
      retainedDays: f.retainedDays,
      floorSource: f.floorSource,
      cutoff: f.cutoff,
      prunable: f.prunable,
      basis: "global max auditRetentionDays across all compliance profiles (longest-floor-wins)",
    };
  });

  app.post("/v1/audit/prune", async (req, reply) => {
    const f = await retentionFloor();
    if (f.retainedDays == null || f.cutoff == null) {
      // no framework sets a retention -> nothing is eligible; keep everything
      return reply.status(200).send({ deleted: 0, retainedDays: null, floorSource: [] });
    }
    const deleted = await db
      .delete(auditLog)
      .where(lt(auditLog.at, f.cutoff))
      .returning({ id: auditLog.id });
    // The prune action is itself audited — a meta row that, by construction,
    // is newer than the cutoff and so survives its own and every future prune.
    // audit_log.userId is a non-null uuid with no FK; the deploy-time admin
    // token has no user id, so fall back to the nil uuid (a valid uuid shape).
    const actorId = req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000";
    await db.insert(auditLog).values({
      userId: actorId,
      objectType: "project",
      objectId: null,
      detail: {
        phase: "audit-retention-prune",
        deleted: deleted.length,
        retainedDays: f.retainedDays,
        floorSource: f.floorSource,
        cutoff: f.cutoff,
      },
      effect: "allow",
      ruleId: "audit-log-pruned",
      ruleChain: [],
      reason: `pruned ${deleted.length} audit row(s) older than ${f.retainedDays}d (global floor from [${f.floorSource.join(", ")}])`,
    });
    return reply.status(200).send({
      deleted: deleted.length,
      retainedDays: f.retainedDays,
      floorSource: f.floorSource,
    });
  });

  // §8.3: what a project's tags currently drive — with HONEST enforcement
  // labels. Workflow requirements are enforced at instance creation today;
  // mcp/retention/pii are declared policy awaiting their enforcement points.
  app.get("/v1/projects/:projectId/compliance", async (req, reply) => {
    const { projectId } = projectIdParam.parse(req.params);
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) return reply.status(404).send({ error: "unknown_project" });
    const gate = await requireRole(req, projectId, "viewer");
    if (!gate.ok) return reply.status(gate.status).send({ error: gate.error });
    const tags = (project.classifications ?? []) as string[];
    const profiles = await profilesForTags(db, tags);
    return {
      classifications: tags,
      pendingClassifications: (project.pendingClassifications ?? null) as string[] | null,
      profiles,
      effective: effectiveCompliancePolicy(profiles),
      enforcement: {
        requiredWorkflowTemplates: "enforced-at-instance-creation",
        mcpDefaultMode: "declared-not-enforced",
        // §8.3 -> §8.2: auditRetentionDays FEEDS the pillar-3 infra backup
        // floor AND now drives audit-log pruning: POST /v1/audit/prune deletes
        // rows older than the GLOBAL max retention across all profiles
        // (longest-floor-wins), so a shorter-retention framework can never
        // shorten another's audit trail. GET /v1/audit/retention shows the
        // computed floor before pruning.
        auditRetentionDays:
          "consumed-by-infra-backup-floor; audit-log pruning enforced via POST /v1/audit/prune (global floor)",
        // These two are ENFORCED by pillar 3: any infra resource carrying this
        // project's tags derives a backup-retention floor / patch-cadence
        // ceiling from them at scan time (see /v1/infra).
        backupRetentionDays: "enforced-as-infra-floor (pillar 3)",
        patchCadenceDays: "enforced-as-infra-ceiling (pillar 3)",
        // §8.4: piiMode is enforced at every PROJECT-ATTRIBUTED model and
        // connector dispatch — input blocks BEFORE the provider call (no
        // cost), output blocks bill-and-withhold, warn attaches a warning,
        // log records category counts. The MCP-proxy tool path is NOT yet
        // enforced (it carries no projectId) — a disclosed follow-up.
        piiMode: "enforced-on-model-and-connector-dispatch (mcp deferred)",
      },
    };
  });

  // §8.3 reclassification: never silent. A first classification applies
  // directly (nothing is in flight under the old cascade); any CHANGE
  // computes the before/after diff and pends behind a named reviewer in the
  // one approvals queue.
  app.post("/v1/projects/:projectId/classifications", async (req, reply) => {
    const { projectId } = projectIdParam.parse(req.params);
    const body = reclassifySchema.parse(req.body);
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) return reply.status(404).send({ error: "unknown_project" });
    const current = (project.classifications ?? []) as string[];

    if (current.length === 0) {
      await db
        .update(projects)
        .set({ classifications: body.classifications })
        .where(eq(projects.id, projectId));
      await db.insert(auditLog).values({
        userId: req.authCtx.userId ?? project.budgetApproverUserId ?? projectId,
        objectType: "project",
        objectId: projectId,
        detail: { phase: "classification", classifications: body.classifications },
        effect: "allow",
        ruleId: "project-classified",
        ruleChain: [],
        reason: `project classified [${body.classifications.join(", ")}]`,
      });
      return reply.status(200).send({ classifications: body.classifications, applied: true });
    }

    if (!body.reviewerUserId) {
      return reply.status(422).send({
        error: "reviewer_required",
        detail: "changing an existing classification requires a named reviewer for the cascade diff",
      });
    }
    const [before, after] = await Promise.all([
      profilesForTags(db, current).then(effectiveCompliancePolicy),
      profilesForTags(db, body.classifications).then(effectiveCompliancePolicy),
    ]);
    await db
      .update(projects)
      .set({ pendingClassifications: body.classifications })
      .where(eq(projects.id, projectId));
    const [approval] = await db
      .insert(approvals)
      .values({
        userId: req.authCtx.userId ?? body.reviewerUserId,
        objectType: "project",
        projectId,
        stageId: "__reclassification__",
        approverUserId: body.reviewerUserId,
      })
      .returning({ id: approvals.id });
    const diff = { from: current, to: body.classifications, effectiveBefore: before, effectiveAfter: after };
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? body.reviewerUserId,
      objectType: "project",
      objectId: projectId,
      detail: { phase: "reclassification-proposed", ...diff },
      effect: "require_approval",
      ruleId: "project-reclassification-proposed",
      ruleChain: [],
      reason: `reclassification [${current.join(", ")}] -> [${body.classifications.join(", ")}] pends review; the cascade diff is attached — never applied silently`,
    });
    return reply.status(202).send({ pending: true, approvalId: approval!.id, diff });
  });

  app.get("/v1/projects/:projectId/costs", async (req, reply) => {
    const { projectId } = projectIdParam.parse(req.params);
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) return reply.status(404).send({ error: "unknown_project" });
    // Pillar 5 for the people doing the work, not only FinOps: an admin sees
    // every project; a non-admin sees the rollup of a project they are a
    // MEMBER of — the same spend their own invokes and runs feed. Anyone
    // else gets a plain 403, membership is the whole test.
    if (!req.authCtx.isAdmin) {
      if (!req.authCtx.userId) return reply.status(403).send({ error: "not_a_project_member" });
      const [membership] = await db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(
          and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, req.authCtx.userId)),
        );
      if (!membership) return reply.status(403).send({ error: "not_a_project_member" });
    }

    const where = eq(usageEvents.projectId, projectId);
    // Connector rows carry no agent/model — keep byAgent to object_type='agent'
    // so a connector call never appears as a phantom agent. The `measured` total
    // and `byUser` deliberately span BOTH object types (one spend ledger), so
    // connector spend rolls up automatically without double-counting.
    const agentWhere = and(where, eq(usageEvents.objectType, "agent"));
    const connectorWhere = and(where, eq(usageEvents.objectType, "connector"));
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const [[measured], byUser, byAgent, byConnector, byTeam, estimated, [recent]] = await Promise.all([
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
        .where(agentWhere)
        .groupBy(usageEvents.agentId, usageEvents.model),
      db
        .select({
          connectorId: usageEvents.connectorId,
          name: connectors.name,
          operation: usageEvents.operation,
          costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
          events: count(),
        })
        .from(usageEvents)
        .leftJoin(connectors, eq(usageEvents.connectorId, connectors.id))
        .where(connectorWhere)
        .groupBy(usageEvents.connectorId, connectors.name, usageEvents.operation),
      // Cross-team rollup WITHIN this project: attribute each spending user's
      // cost to the team they contribute under HERE (project_members.teamId),
      // not their home team. A member with no team on this project — or spend
      // from a non-member — rolls up under a null teamId row (labeled "(no
      // team)" in the UI; the API never fabricates a team). One ledger, still
      // scoped by the same `where` as every other breakdown.
      db
        .select({
          teamId: projectMembers.teamId,
          name: teams.name,
          costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
          events: count(),
        })
        .from(usageEvents)
        .leftJoin(
          projectMembers,
          and(
            eq(usageEvents.userId, projectMembers.userId),
            eq(projectMembers.projectId, projectId),
          ),
        )
        .leftJoin(teams, eq(projectMembers.teamId, teams.id))
        .where(where)
        .groupBy(projectMembers.teamId, teams.name),
      // Estimated (not measured) savings, grouped by the optimization technique
      // that produced them. NOTE: a per-workflow cost-attribution source for
      // cost_events is RESERVED for a future slice (roll a workflow stage's
      // spend up to its parent initiative) — no writer is built yet, so no such
      // rows exist to group here today.
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
    // budget window: under a 'monthly' budget the gauge reads only the current
    // calendar-month spend; the lifetime total is still reported alongside it.
    const now = new Date();
    const periodKey = currentPeriodKey(now);
    const monthly = isMonthly(project);
    let windowedSpentUsd = spentUsd;
    if (monthly) {
      const [w] = await db
        .select({ costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8` })
        .from(usageEvents)
        .where(and(where, gte(usageEvents.at, periodStart(now))));
      windowedSpentUsd = w?.costUsd ?? 0;
    }
    const pct = project.alertThresholdPct ?? 100;
    const thresholdUsd =
      project.budgetUsd == null ? null : Number(((project.budgetUsd * pct) / 100).toFixed(6));
    // simple run-rate forecast, labeled as such: last-7-days daily rate
    // projected to the end of the current month
    const dailyRateUsd = (recent?.costUsd ?? 0) / 7;
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const daysRemaining = Math.max(0, (endOfMonth.getTime() - now.getTime()) / (24 * 3600 * 1000));
    const projectedEomUsd = Number((spentUsd + dailyRateUsd * daysRemaining).toFixed(6));

    // pillar-5 rollup label: this project's parent Initiative, if grouped under
    // one. Surfaced here (reporting-only) so the member-facing /app can show the
    // initiative name without the admin-only /v1/initiatives endpoint.
    const [initiative] = project.initiativeId
      ? await db
          .select({ id: initiatives.id, name: initiatives.name, costCenter: initiatives.costCenter })
          .from(initiatives)
          .where(eq(initiatives.id, project.initiativeId))
      : [];

    return {
      project,
      initiative: initiative ?? null,
      measured,
      byUser,
      byAgent,
      byConnector,
      byTeam,
      estimatedSavings: estimated,
      budget: {
        budgetUsd: project.budgetUsd,
        // the gauge reads the WINDOWED spend (== lifetime when period='none')
        spentUsd: windowedSpentUsd,
        lifetimeSpentUsd: spentUsd,
        period: monthly ? "monthly" : "none",
        periodKey: monthly ? periodKey : null,
        remainingUsd:
          project.budgetUsd == null ? null : Number((project.budgetUsd - windowedSpentUsd).toFixed(6)),
        overBudget: project.budgetUsd != null && windowedSpentUsd > project.budgetUsd,
        alertThresholdPct: pct,
        thresholdUsd,
        thresholdCrossed:
          project.budgetUsd != null &&
          thresholdUsd != null &&
          windowedSpentUsd >= thresholdUsd &&
          windowedSpentUsd <= project.budgetUsd,
        overageApproved: project.overageApproved,
        overageApprovedPeriod: project.overageApprovedPeriod,
        // whether the latch is currently suppressing enforcement
        overageActive: overageActive(project, periodKey),
      },
      forecast: {
        basis: "last-7-days-run-rate projected to end of current month",
        dailyRateUsd: Number(dailyRateUsd.toFixed(6)),
        projectedEomUsd,
      },
    };
  });

  // Per-invocation CSV export for a project's spend — same member/admin authz
  // as the /costs rollup (membership is the whole test for a non-admin). The
  // rows are the raw usage_events, newest first, for FinOps/chargeback export.
  app.get("/v1/projects/:projectId/costs.csv", async (req, reply) => {
    const { projectId } = projectIdParam.parse(req.params);
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) return reply.status(404).send({ error: "unknown_project" });
    if (!req.authCtx.isAdmin) {
      if (!req.authCtx.userId) return reply.status(403).send({ error: "not_a_project_member" });
      const [membership] = await db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(
          and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, req.authCtx.userId)),
        );
      if (!membership) return reply.status(403).send({ error: "not_a_project_member" });
    }
    const rows = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.projectId, projectId))
      .orderBy(desc(usageEvents.at));
    const safeName = project.name.replace(/[^A-Za-z0-9_.-]+/g, "-");
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${safeName}-costs.csv"`)
      .send(usageEventsCsv(rows));
  });
}
