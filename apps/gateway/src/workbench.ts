/**
 * ADR-0046 — the GATEWAY half of the REVIEW WORKBENCH.
 *
 *   `packages/shared/src/workbench.ts`  rule matching, the derived SLA clock,
 *                                       the bulk fences. Pure.
 *   THIS FILE                           materialization, SLA evaluation +
 *                                       escalation, claiming, saved views,
 *                                       workload, the routing/SLA admin API,
 *                                       and the BULK endpoint.
 *   `app.ts`                            owns `decideOneApproval` — the ONE
 *                                       decide path — and hands it to the bulk
 *                                       endpoint. Bulk does not reimplement it.
 *
 * THREE PROPERTIES THIS FILE EXISTS TO GUARANTEE
 *
 *  1. IT IS A LAYER, NOT A SECOND STORE. Nothing here writes an approval's
 *     decision, and nothing here creates an approval. The `approvals` row is
 *     untouched by routing except in the two cases the ADR sanctions: a
 *     `user`-kind rule resolves the named approver at materialization, and a
 *     CLAIM resolves a role/team assignment to the individual who claimed it.
 *     Both are audited.
 *
 *  2. SLA TIMERS ARE EVALUATED, NOT MERELY STORED — WITHOUT A SCHEDULER.
 *     THERE IS NO IN-PROCESS JOB RUNNER IN THIS CODEBASE. So breach evaluation
 *     runs LAZILY: on every read of the queue, on every decide, and on an
 *     explicit `POST /v1/approvals/sla/sweep` an operator or cron can call. The
 *     deadlines are a pure function of `approvals.requested_at` and the policy,
 *     so a lazily evaluated breach is byte-identical to what a timer would have
 *     produced — it just becomes visible when someone looks, or when the sweep
 *     is called. Nothing in this file claims a timer fires on its own, because
 *     none does.
 *
 *  3. ESCALATION NEVER DECIDES. On breach the work is moved toward someone who
 *     can decide it (`add_assignee` widens the queue, `reassign` moves the
 *     named approver, `notify_only` records it). There is no code path here
 *     that approves or denies anything on a timeout, and the type + DB CHECK
 *     make adding one a deliberate act rather than an accident.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  and,
  approvalAssignmentRules,
  approvalAssignments,
  approvalSavedViews,
  approvalSlaPolicies,
  approvals,
  asc,
  auditLog,
  desc,
  eq,
  inArray,
  isNull,
  or,
  projects,
  roleAssignments,
  sql,
  teamMembers,
  users,
  workflowInstances,
  type ApprovalAssignmentRow,
  type ApprovalSlaPolicyRow,
  type Db,
} from "@regulait/db";
import {
  bulkCapRefusal,
  bulkDecideApprovalsSchema,
  bulkSensitivityFenced,
  createApprovalAssignmentRuleSchema,
  createApprovalSavedViewSchema,
  createApprovalSlaPolicySchema,
  evaluateSla,
  selectAssignmentRule,
  slaDeadlines,
  type ApprovalRoutingContext,
} from "@regulait/shared";
import { loadOrgSettings } from "./org-settings.js";
import { projectClassifications, projectPiiMode } from "./projects.js";

type ApprovalRow = typeof approvals.$inferSelect;

/** the identity-less bootstrap token's audit actor — the sentinel
 * org-settings.ts established */
const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

// ---------------------------------------------------------------------------
// Materialization — idempotent, and identical whenever it happens
// ---------------------------------------------------------------------------

/**
 * Is ANY routing rule enabled?
 *
 * The workbench ships with an empty rules table, and this is the check that
 * keeps that state byte-identical to pre-0058 behaviour: with no rule enabled,
 * the queue read materializes nothing, writes nothing, and evaluates no SLA,
 * because there is nothing that could have routed or timed anything. One cheap
 * COUNT buys "the layer is inert until an admin turns it on".
 */
export async function routingActive(db: Db): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(approvalAssignmentRules)
    .where(eq(approvalAssignmentRules.enabled, true));
  return (row?.n ?? 0) > 0;
}

/** The SERVER-RESOLVED routing facts for one approval. `dataSensitivity` comes
 * from the attributed project's compliance classifications — the same source
 * ADR-0018's addendum names — and never from anything a caller supplied. */
async function routingContextFor(db: Db, row: ApprovalRow): Promise<ApprovalRoutingContext> {
  const classifications = row.projectId ? await projectClassifications(db, row.projectId) : [];
  let templateIds: string[] = [];
  if (row.instanceId) {
    const [inst] = await db
      .select({ templateIds: workflowInstances.templateIds })
      .from(workflowInstances)
      .where(eq(workflowInstances.id, row.instanceId));
    templateIds = ((inst?.templateIds ?? []) as string[]).slice();
  }
  return {
    objectType: row.objectType,
    projectId: row.projectId,
    dataSensitivity: classifications.length > 0 ? [...classifications].sort()[0]! : null,
    stageId: row.stageId,
    templateIds,
  };
}

/**
 * Ensure an assignment row exists for `row`, creating it from the first
 * matching rule (or, with no match, from the approval's own named approver).
 *
 * WHY THIS IS LAZY. There are a dozen places in this codebase that INSERT an
 * approval (workflow stages, MCP write-tool gates, budget escalations, infra
 * remediations, context conflicts, orchestration escalations, MRM sign-offs).
 * Editing every one to call a routing hook would be a dozen chances to miss
 * one, and a missed one is an approval that silently never routes. Instead the
 * assignment is materialized on first READ or DECIDE, from columns already
 * stored on the approval — so the result is identical to eager routing, and it
 * is impossible for a future insert site to forget.
 *
 * BEHAVIOUR-PRESERVING BY CONSTRUCTION: with the rules table empty (the shipped
 * state) the assignment mirrors `approverUserId` with no SLA, and nothing about
 * the approval changes.
 */
export async function ensureAssignment(
  db: Db,
  row: ApprovalRow,
  actorUserId: string | null = null,
): Promise<ApprovalAssignmentRow | null> {
  const [existing] = await db
    .select()
    .from(approvalAssignments)
    .where(eq(approvalAssignments.approvalId, row.id));
  if (existing) return existing;

  const rules = await db
    .select()
    .from(approvalAssignmentRules)
    .where(eq(approvalAssignmentRules.enabled, true));
  const ctx = await routingContextFor(db, row);
  const rule = selectAssignmentRule(rules, ctx);

  let policy: ApprovalSlaPolicyRow | null = null;
  if (rule?.slaPolicyId) {
    const [p] = await db
      .select()
      .from(approvalSlaPolicies)
      .where(and(eq(approvalSlaPolicies.id, rule.slaPolicyId), eq(approvalSlaPolicies.enabled, true)));
    policy = p ?? null;
  }
  const deadlines = policy ? slaDeadlines(row.requestedAt, policy) : null;

  const [created] = await db
    .insert(approvalAssignments)
    .values({
      approvalId: row.id,
      ruleId: rule?.id ?? null,
      assigneeKind: rule?.assigneeKind ?? "user",
      // no rule = today's behaviour made explicit: the assignment IS the
      // approval's own named approver
      assigneeId: rule?.assigneeId ?? row.approverUserId,
      quorum: rule?.quorum ?? 1,
      slaPolicyId: policy?.id ?? null,
      warnAt: deadlines?.warnAt ?? null,
      dueAt: deadlines?.dueAt ?? null,
    })
    .onConflictDoNothing()
    .returning();
  const assignment =
    created ??
    (await db.select().from(approvalAssignments).where(eq(approvalAssignments.approvalId, row.id)))[0]!;

  if (rule) {
    // A `user`-kind rule resolves the individual immediately, so ADR-0022's
    // approver-visibility checks and ADR-0027's quorum count keep reading a
    // meaningful `approverUserId`. A role/team rule does NOT — it waits for a
    // claim, because a NOT NULL column cannot hold a team.
    if (rule.assigneeKind === "user" && rule.assigneeId !== row.approverUserId && row.status === "pending") {
      await db
        .update(approvals)
        .set({ approverUserId: rule.assigneeId })
        .where(and(eq(approvals.id, row.id), eq(approvals.status, "pending")));
    }
    await db.insert(auditLog).values({
      userId: actorUserId ?? row.userId,
      objectType: row.objectType,
      objectId: row.instanceId ?? row.runId ?? row.projectId ?? null,
      serverId: row.serverId,
      toolName: row.toolName,
      detail: {
        phase: "routing",
        approvalId: row.id,
        ruleId: rule.id,
        ruleName: rule.name,
        assigneeKind: rule.assigneeKind,
        assigneeId: rule.assigneeId,
        previousApproverUserId: row.approverUserId,
        slaPolicyId: policy?.id ?? null,
        dueAt: deadlines?.dueAt?.toISOString() ?? null,
      },
      effect: "allow",
      ruleId: "approval-routed",
      ruleChain: [],
      reason: `approval routed to ${rule.assigneeKind} by rule '${rule.name}' — routing decides whose queue this shows in, never who is allowed to decide`,
    });
  }
  return assignment;
}

// ---------------------------------------------------------------------------
// SLA evaluation + escalation
// ---------------------------------------------------------------------------

/**
 * Evaluate one assignment's SLA and, on the transition INTO breached, escalate.
 *
 * Returns the (possibly updated) assignment. Idempotent: `evaluateSla` is
 * monotonic, so a second call after a breach neither re-escalates nor
 * un-breaches.
 */
export async function evaluateAssignmentSla(
  db: Db,
  row: ApprovalRow,
  assignment: ApprovalAssignmentRow,
  now: Date = new Date(),
): Promise<ApprovalAssignmentRow> {
  // a decided approval's clock is stopped, not reset
  if (row.status !== "pending") return assignment;
  const verdict = evaluateSla(assignment, now);
  if (!verdict.changed) return assignment;

  let policy: ApprovalSlaPolicyRow | null = null;
  if (assignment.slaPolicyId) {
    const [p] = await db
      .select()
      .from(approvalSlaPolicies)
      .where(eq(approvalSlaPolicies.id, assignment.slaPolicyId));
    policy = p ?? null;
  }

  const patch: Partial<typeof approvalAssignments.$inferInsert> = { slaState: verdict.state };
  if (verdict.breachedNow) {
    patch.breachedAt = now;
    if (policy && policy.escalateAction !== "notify_only" && policy.escalateToKind && policy.escalateToId) {
      patch.escalatedAt = now;
      patch.escalationAssigneeKind = policy.escalateToKind;
      patch.escalationAssigneeId = policy.escalateToId;
    }
  }
  const [updated] = await db
    .update(approvalAssignments)
    .set(patch)
    .where(eq(approvalAssignments.id, assignment.id))
    .returning();

  // `reassign` is the one escalation that touches the approval row: it moves
  // the single NOT NULL named approver. It NEVER decides — the approval stays
  // pending, it is simply now somebody else's to decide.
  let reassignedTo: string | null = null;
  if (
    verdict.breachedNow &&
    policy?.escalateAction === "reassign" &&
    policy.escalateToKind === "user" &&
    policy.escalateToId
  ) {
    const [moved] = await db
      .update(approvals)
      .set({ approverUserId: policy.escalateToId })
      .where(and(eq(approvals.id, row.id), eq(approvals.status, "pending")))
      .returning();
    if (moved) reassignedTo = policy.escalateToId;
  }

  if (verdict.breachedNow) {
    await db.insert(auditLog).values({
      userId: row.userId,
      objectType: row.objectType,
      objectId: row.instanceId ?? row.runId ?? row.projectId ?? null,
      serverId: row.serverId,
      toolName: row.toolName,
      detail: {
        phase: "sla",
        approvalId: row.id,
        assignmentId: assignment.id,
        slaPolicyId: policy?.id ?? null,
        dueAt: assignment.dueAt?.toISOString() ?? null,
        minutesLate: verdict.minutesLate,
        escalateAction: policy?.escalateAction ?? null,
        escalatedToKind: policy?.escalateToKind ?? null,
        escalatedToId: policy?.escalateToId ?? null,
        reassignedTo,
      },
      effect: "deny",
      ruleId: "approval-sla-breached",
      ruleChain: [],
      reason:
        `approval SLA breached ${verdict.minutesLate ?? 0} minute(s) past its due time` +
        (policy && policy.escalateAction !== "notify_only"
          ? `; escalated to ${policy.escalateToKind} (${policy.escalateAction})`
          : "; recorded only — this policy escalates to nobody") +
        ". Escalation moves the decision to someone who can make it; it NEVER approves or denies.",
    });
  } else if (verdict.state === "warning") {
    await db.insert(auditLog).values({
      userId: row.userId,
      objectType: row.objectType,
      objectId: row.instanceId ?? row.runId ?? row.projectId ?? null,
      serverId: row.serverId,
      toolName: row.toolName,
      detail: {
        phase: "sla",
        approvalId: row.id,
        assignmentId: assignment.id,
        dueAt: assignment.dueAt?.toISOString() ?? null,
      },
      effect: "allow",
      ruleId: "approval-sla-warning",
      ruleChain: [],
      reason: "approval is approaching its SLA due time",
    });
  }
  return updated ?? assignment;
}

/**
 * Materialize + evaluate a batch of approval rows. This is the function the
 * queue read and the decide path both call, and it is the ONLY thing making
 * SLA state advance in a deployment with no cron.
 */
export async function materializeAndEvaluate(
  db: Db,
  rows: ApprovalRow[],
  actorUserId: string | null,
  now: Date = new Date(),
): Promise<Map<string, ApprovalAssignmentRow>> {
  const out = new Map<string, ApprovalAssignmentRow>();
  for (const row of rows) {
    const assignment = await ensureAssignment(db, row, actorUserId);
    if (!assignment) continue;
    out.set(row.id, await evaluateAssignmentSla(db, row, assignment, now));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Eligibility for a role/team assignment
// ---------------------------------------------------------------------------

/** the approval ids whose assignment (or escalation target) points at a role or
 * team this user belongs to — i.e. the queues they are party to */
export async function assignedApprovalIdsFor(db: Db, userId: string): Promise<string[]> {
  const roles = await db
    .select({ roleId: roleAssignments.roleId })
    .from(roleAssignments)
    .where(eq(roleAssignments.userId, userId));
  const teams = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId));
  const groupIds = [...roles.map((r) => r.roleId), ...teams.map((t) => t.teamId)];
  const conds = [
    and(eq(approvalAssignments.assigneeKind, "user"), eq(approvalAssignments.assigneeId, userId)),
    and(
      eq(approvalAssignments.escalationAssigneeKind, "user"),
      eq(approvalAssignments.escalationAssigneeId, userId),
    ),
    ...(groupIds.length
      ? [
          inArray(approvalAssignments.assigneeId, groupIds),
          inArray(approvalAssignments.escalationAssigneeId, groupIds),
        ]
      : []),
  ];
  const rows = await db
    .select({ approvalId: approvalAssignments.approvalId })
    .from(approvalAssignments)
    .where(or(...conds));
  return rows.map((r) => r.approvalId);
}

async function userIsEligibleFor(
  db: Db,
  userId: string,
  assignment: ApprovalAssignmentRow,
): Promise<boolean> {
  const targets: Array<[string | null, string | null]> = [
    [assignment.assigneeKind, assignment.assigneeId],
    [assignment.escalationAssigneeKind, assignment.escalationAssigneeId],
  ];
  for (const [kind, id] of targets) {
    if (!kind || !id) continue;
    if (kind === "user" && id === userId) return true;
    if (kind === "role") {
      const [r] = await db
        .select({ id: roleAssignments.id })
        .from(roleAssignments)
        .where(and(eq(roleAssignments.userId, userId), eq(roleAssignments.roleId, id)));
      if (r) return true;
    }
    if (kind === "team") {
      const [t] = await db
        .select({ id: teamMembers.id })
        .from(teamMembers)
        .where(and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, id)));
      if (t) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface WorkbenchRouteOptions {
  /** the ONE decide path, owned by app.ts. Bulk calls exactly this. */
  decideOne: (input: {
    approvalId: string;
    deciderUserId: string | null;
    isAdmin: boolean;
    body: { decision: "approved" | "denied"; reason?: string | undefined };
  }) => Promise<
    { ok: true; body: Record<string, unknown> } | { ok: false; status: number; body: Record<string, unknown> }
  >;
}

const idParam = z.object({ id: z.string().uuid() });

export function registerWorkbenchRoutes(app: FastifyInstance, db: Db, opts: WorkbenchRouteOptions) {
  // ---------------- SLA policies (admin) ----------------

  app.get("/v1/approvals/sla-policies", async () => ({
    policies: await db.select().from(approvalSlaPolicies).orderBy(asc(approvalSlaPolicies.name)),
    note:
      "An SLA never decides anything. escalate_action admits add_assignee, reassign and notify_only — " +
      "there is deliberately no auto-approve and no auto-deny, because a queue that clears itself on a " +
      "timeout is a bypass. Nothing runs these timers on a schedule: breach is evaluated when the queue " +
      "is read, when an approval is decided, or when POST /v1/approvals/sla/sweep is called.",
  }));

  app.post("/v1/approvals/sla-policies", async (req, reply) => {
    const body = createApprovalSlaPolicySchema.parse(req.body);
    const [row] = await db
      .insert(approvalSlaPolicies)
      .values({
        name: body.name,
        warnAfterMinutes: body.warnAfterMinutes,
        breachAfterMinutes: body.breachAfterMinutes,
        escalateAction: body.escalateAction,
        escalateToKind: body.escalateToKind ?? null,
        escalateToId: body.escalateToId ?? null,
        enabled: body.enabled,
        createdByUserId: req.authCtx.userId ?? null,
      })
      .returning();
    return reply.status(201).send({ policy: row });
  });

  app.delete("/v1/approvals/sla-policies/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db.select().from(approvalSlaPolicies).where(eq(approvalSlaPolicies.id, id));
    if (!row) return reply.status(404).send({ error: "unknown_sla_policy" });
    await db.delete(approvalSlaPolicies).where(eq(approvalSlaPolicies.id, id));
    return { deleted: true };
  });

  // ---------------- routing rules (admin) ----------------

  app.get("/v1/approvals/assignment-rules", async () => ({
    rules: await db
      .select()
      .from(approvalAssignmentRules)
      .orderBy(asc(approvalAssignmentRules.priority), asc(approvalAssignmentRules.createdAt)),
    note:
      "Routing decides WHOSE QUEUE an approval shows in — never who is allowed to decide it. Eligibility " +
      "stays the entitlement model, and a role/team assignment still resolves to one individual when a " +
      "member claims it. A rule with no conditions matches nothing, by constraint.",
  }));

  app.post("/v1/approvals/assignment-rules", async (req, reply) => {
    const body = createApprovalAssignmentRuleSchema.parse(req.body);
    if (body.slaPolicyId) {
      const [p] = await db
        .select({ id: approvalSlaPolicies.id })
        .from(approvalSlaPolicies)
        .where(eq(approvalSlaPolicies.id, body.slaPolicyId));
      if (!p) return reply.status(404).send({ error: "unknown_sla_policy" });
    }
    const [row] = await db
      .insert(approvalAssignmentRules)
      .values({
        name: body.name,
        objectType: body.objectType ?? null,
        projectId: body.projectId ?? null,
        dataSensitivity: body.dataSensitivity ?? null,
        stagePattern: body.stagePattern ?? null,
        templateId: body.templateId ?? null,
        assigneeKind: body.assigneeKind,
        assigneeId: body.assigneeId,
        quorum: body.quorum,
        priority: body.priority,
        slaPolicyId: body.slaPolicyId ?? null,
        enabled: body.enabled,
        createdByUserId: req.authCtx.userId ?? null,
      })
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NO_IDENTITY,
      objectType: "approval_assignment_rule",
      objectId: row!.id,
      detail: {
        phase: "authoring",
        action: "create",
        name: row!.name,
        assigneeKind: row!.assigneeKind,
        assigneeId: row!.assigneeId,
        slaPolicyId: row!.slaPolicyId,
      },
      effect: "allow",
      ruleId: "approval-assignment-rule-created",
      ruleChain: [],
      reason: `approval routing rule '${row!.name}' created — it changes whose queue matching approvals appear in, not who may decide them`,
    });
    return reply.status(201).send({ rule: row });
  });

  app.delete("/v1/approvals/assignment-rules/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db
      .select()
      .from(approvalAssignmentRules)
      .where(eq(approvalAssignmentRules.id, id));
    if (!row) return reply.status(404).send({ error: "unknown_assignment_rule" });
    await db.delete(approvalAssignmentRules).where(eq(approvalAssignmentRules.id, id));
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NO_IDENTITY,
      objectType: "approval_assignment_rule",
      objectId: id,
      detail: { phase: "authoring", action: "delete", name: row.name },
      effect: "deny",
      ruleId: "approval-assignment-rule-deleted",
      ruleChain: [],
      reason: `approval routing rule '${row.name}' deleted — already-routed approvals keep their assignment`,
    });
    return { deleted: true };
  });

  // ---------------- the SLA sweep (admin / cron) ----------------

  /**
   * The sweep an operator or an external cron calls. It exists BECAUSE there is
   * no scheduler here — not as a supplement to one. Enforcement does not depend
   * on it (the queue read and the decide path evaluate lazily), but a
   * deployment where nobody opens the queue would otherwise never notice a
   * breach, so this is the pull-based way to make one visible.
   */
  app.post("/v1/approvals/sla/sweep", async (req) => {
    const now = new Date();
    const pending = await db.select().from(approvals).where(eq(approvals.status, "pending"));
    let evaluated = 0;
    let breached = 0;
    let warned = 0;
    for (const row of pending) {
      const assignment = await ensureAssignment(db, row, req.authCtx.userId ?? null);
      if (!assignment || !assignment.dueAt) continue;
      evaluated += 1;
      const before = assignment.slaState;
      const after = await evaluateAssignmentSla(db, row, assignment, now);
      if (before !== "breached" && after.slaState === "breached") breached += 1;
      else if (before === "ok" && after.slaState === "warning") warned += 1;
    }
    return {
      evaluated,
      breached,
      warned,
      note:
        "Nothing calls this on a timer — there is no in-process scheduler in this deployment. Breach is " +
        "ALSO evaluated whenever the queue is read or an approval is decided, and the deadlines are a pure " +
        "function of requested_at, so a lazily detected breach is identical to what a timer would have " +
        "produced. It becomes visible when someone looks, or when this endpoint is called.",
    };
  });

  // ---------------- workload (any reviewer) ----------------

  app.get("/v1/approvals/workload", async (req) => {
    const now = new Date();
    const me = req.authCtx.userId ?? "";
    const pending = await db.select().from(approvals).where(eq(approvals.status, "pending"));
    // Evaluate before aggregating, so "breached" in this view is the live truth
    // rather than whatever was last written. With no rule enabled nothing is
    // materialized at all and the aggregate falls back to the approval's own
    // named approver — the pre-0058 shape of "whose queue is this".
    const assignments = (await routingActive(db))
      ? await materializeAndEvaluate(db, pending, req.authCtx.userId ?? null, now)
      : new Map<string, ApprovalAssignmentRow>();
    // ADR-0022 scoping: a non-admin sees only queues they are party to
    const visibleIds = req.authCtx.isAdmin ? null : new Set(await assignedApprovalIdsFor(db, me));
    const buckets = new Map<string, { kind: string; id: string; open: number; dueSoon: number; breached: number }>();
    for (const row of pending) {
      const a = assignments.get(row.id) ?? null;
      if (visibleIds && !visibleIds.has(row.id) && row.approverUserId !== me) continue;
      const kind = a?.assigneeKind ?? "user";
      const id = a?.assigneeId ?? row.approverUserId;
      const key = `${kind}:${id}`;
      const b = buckets.get(key) ?? { kind, id, open: 0, dueSoon: 0, breached: 0 };
      b.open += 1;
      if (a?.slaState === "warning") b.dueSoon += 1;
      if (a?.slaState === "breached") b.breached += 1;
      buckets.set(key, b);
    }
    const rows = [...buckets.values()];
    const userIds = rows.filter((r) => r.kind === "user").map((r) => r.id);
    const names = userIds.length
      ? await db
          .select({ id: users.id, displayName: users.displayName, email: users.email })
          .from(users)
          .where(inArray(users.id, userIds))
      : [];
    const nameOf = new Map(names.map((u) => [u.id, u.displayName || u.email]));
    return {
      workload: rows
        .map((r) => ({ ...r, name: r.kind === "user" ? (nameOf.get(r.id) ?? null) : null }))
        .sort((a, b) => b.breached - a.breached || b.open - a.open),
      note: "Read-only aggregate over pending approvals, scoped to the queues you are party to.",
    };
  });

  // ---------------- claiming a role/team assignment ----------------

  /**
   * CLAIM. A role/team assignment is claimable by any ELIGIBLE MEMBER, and
   * claiming is what resolves it to the single individual `approverUserId`
   * must hold. This is not a widening of who may decide: an ineligible caller
   * is refused here, and the decide path's own named-approver check still runs
   * afterwards on whatever this wrote.
   */
  app.post("/v1/approvals/:approvalId/claim", async (req, reply) => {
    const { approvalId: id } = z.object({ approvalId: z.string().uuid() }).parse(req.params);
    const me = req.authCtx.userId;
    if (!me) return reply.status(403).send({ error: "bootstrap_cannot_claim" });
    const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
    if (!row) return reply.status(404).send({ error: "unknown_approval" });
    if (row.status !== "pending") return reply.status(409).send({ error: "already_decided" });
    const assignment = await ensureAssignment(db, row, me);
    if (!assignment) return reply.status(404).send({ error: "unknown_approval" });
    if (assignment.claimedByUserId) {
      return reply.status(409).send({
        error: "already_claimed",
        detail: "another eligible member has already taken this item",
      });
    }
    const eligible = await userIsEligibleFor(db, me, assignment);
    if (!eligible) {
      return reply.status(403).send({
        error: "not_eligible_to_claim",
        detail: "this approval is assigned to a user, role or team you are not part of",
      });
    }
    const [claimed] = await db
      .update(approvalAssignments)
      .set({ claimedByUserId: me, claimedAt: new Date() })
      .where(and(eq(approvalAssignments.id, assignment.id), isNull(approvalAssignments.claimedByUserId)))
      .returning();
    if (!claimed) return reply.status(409).send({ error: "already_claimed" });
    await db
      .update(approvals)
      .set({ approverUserId: me })
      .where(and(eq(approvals.id, id), eq(approvals.status, "pending")));
    await db.insert(auditLog).values({
      userId: me,
      objectType: row.objectType,
      objectId: row.instanceId ?? row.runId ?? row.projectId ?? null,
      serverId: row.serverId,
      toolName: row.toolName,
      detail: {
        phase: "routing",
        approvalId: id,
        assignmentId: assignment.id,
        assigneeKind: assignment.assigneeKind,
        assigneeId: assignment.assigneeId,
        previousApproverUserId: row.approverUserId,
      },
      effect: "allow",
      ruleId: "approval-claimed",
      ruleChain: [],
      reason: "an eligible member claimed a routed approval; it is now theirs to decide",
    });
    return { claimed: true, approverUserId: me };
  });

  // ---------------- saved views ----------------

  app.get("/v1/approvals/views", async (req) => {
    const me = req.authCtx.userId ?? NO_IDENTITY;
    const rows = await db
      .select()
      .from(approvalSavedViews)
      .where(or(eq(approvalSavedViews.userId, me), isNull(approvalSavedViews.userId)))
      .orderBy(asc(approvalSavedViews.name));
    return { views: rows.map((v) => ({ ...v, shared: v.userId === null })) };
  });

  app.post("/v1/approvals/views", async (req, reply) => {
    const body = createApprovalSavedViewSchema.parse(req.body);
    if (body.shared && !req.authCtx.isAdmin) {
      return reply.status(403).send({
        error: "shared_view_admin_only",
        detail: "publishing a view for everyone is an admin act; save it privately instead",
      });
    }
    const me = req.authCtx.userId;
    if (!body.shared && !me) return reply.status(403).send({ error: "bootstrap_cannot_own_a_view" });
    const [row] = await db
      .insert(approvalSavedViews)
      .values({
        userId: body.shared ? null : me!,
        name: body.name,
        filters: body.filters,
        sort: body.sort,
        createdByUserId: me ?? null,
      })
      .returning();
    return reply.status(201).send({ view: { ...row, shared: row!.userId === null } });
  });

  app.delete("/v1/approvals/views/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db.select().from(approvalSavedViews).where(eq(approvalSavedViews.id, id));
    if (!row) return reply.status(404).send({ error: "unknown_view" });
    const mine = row.userId !== null && row.userId === req.authCtx.userId;
    if (!mine && !req.authCtx.isAdmin) return reply.status(403).send({ error: "not_your_view" });
    await db.delete(approvalSavedViews).where(eq(approvalSavedViews.id, id));
    return { deleted: true };
  });

  // ---------------- BULK ----------------

  /**
   * BULK APPROVE / DENY — N individual decisions through the ONE decide path.
   *
   * The three things this endpoint is careful about, in order:
   *
   *  1. THE CAP is a property of the REQUEST and refuses it whole (422). A
   *     silently truncated bulk is worse than a refused one.
   *  2. THE SENSITIVITY FENCE and THE PER-ITEM AUTHORIZATION are properties of
   *     each ITEM. An item the caller may not decide is refused ON ITS OWN and
   *     the rest still proceed — there is deliberately NO "the batch is
   *     authorized" shortcut, because a batch-level check is exactly how an
   *     unauthorized item slips through in a queue tool.
   *  3. EVERY ITEM IS AUDITED — the successes and the refusals, one row each,
   *     carrying the batch id. A bulk action is N recorded decisions, never one
   *     opaque event.
   *
   * Authorization is not re-implemented here: each item goes through
   * `decideOne`, the same function the single-decision route calls, so every
   * guard it applies (named approver, delegation window, admin override with a
   * recorded reason, self-review reason, superseded, already-decided) applies
   * to a bulk item identically.
   */
  app.post("/v1/approvals/bulk", async (req, reply) => {
    const body = bulkDecideApprovalsSchema.parse(req.body);
    const me = req.authCtx.userId;
    if (!me) return reply.status(403).send({ error: "bootstrap_cannot_decide" });
    const org = await loadOrgSettings(db);

    const cap = bulkCapRefusal(body.approvalIds.length, org.approvalBulkMaxItems);
    if (cap.refused) return reply.status(422).send({ error: "bulk_cap_exceeded", detail: cap.detail });

    const batchId = crypto.randomUUID();
    const unique = [...new Set(body.approvalIds)];
    const rows = await db.select().from(approvals).where(inArray(approvals.id, unique));
    const byId = new Map(rows.map((r) => [r.id, r]));

    const results: Array<{
      approvalId: string;
      ok: boolean;
      status: number;
      error?: string;
      detail?: string;
    }> = [];

    const auditRefusal = async (
      row: ApprovalRow | undefined,
      approvalId: string,
      error: string,
      reason: string,
    ) => {
      await db.insert(auditLog).values({
        userId: me,
        objectType: row?.objectType ?? "mcp_tool",
        objectId: row ? (row.instanceId ?? row.runId ?? row.projectId ?? null) : null,
        serverId: row?.serverId ?? null,
        toolName: row?.toolName ?? null,
        detail: {
          phase: "bulk",
          batchId,
          approvalId,
          decision: body.decision,
          refusal: error,
        },
        effect: "deny",
        ruleId: "approval-bulk-item-refused",
        ruleChain: [],
        reason,
      });
    };

    for (const approvalId of unique) {
      const row = byId.get(approvalId);
      if (!row) {
        await auditRefusal(undefined, approvalId, "unknown_approval", "bulk item names an approval that does not exist");
        results.push({ approvalId, ok: false, status: 404, error: "unknown_approval" });
        continue;
      }
      // §4's sensitivity fence — evaluated PER ITEM, before the decision. A
      // batch containing one high-sensitivity item does not lose the fence
      // because the other items are ordinary.
      const piiMode = row.projectId ? await projectPiiMode(db, row.projectId) : null;
      if (bulkSensitivityFenced({ enabled: org.approvalBulkSensitiveBlocked, projectPiiMode: piiMode })) {
        const detail =
          "bulk is forbidden on approvals attributed to a project whose compliance cascade blocks PII — " +
          "decide this one individually. The friction is the control, not an oversight.";
        await auditRefusal(row, approvalId, "bulk_forbidden_sensitive", detail);
        results.push({ approvalId, ok: false, status: 403, error: "bulk_forbidden_sensitive", detail });
        continue;
      }
      // THE SAME per-item authorization and audit as a single decision — there
      // is no shortcut path that skips a check because it is in a batch.
      const outcome = await opts.decideOne({
        approvalId,
        deciderUserId: me,
        isAdmin: req.authCtx.isAdmin,
        body: { decision: body.decision, reason: body.reason },
      });
      if (!outcome.ok) {
        const error = String(outcome.body.error ?? "refused");
        await auditRefusal(
          row,
          approvalId,
          error,
          `bulk item refused by the one decide path: ${error}${outcome.body.detail ? ` — ${String(outcome.body.detail)}` : ""}`,
        );
        results.push({
          approvalId,
          ok: false,
          status: outcome.status,
          error,
          ...(outcome.body.detail ? { detail: String(outcome.body.detail) } : {}),
        });
        continue;
      }
      // one audit row PER DECIDED ITEM, carrying the batch id — so a bulk is
      // reconstructible as N decisions and never collapses into one event
      await db.insert(auditLog).values({
        userId: me,
        objectType: row.objectType,
        objectId: row.instanceId ?? row.runId ?? row.projectId ?? null,
        serverId: row.serverId,
        toolName: row.toolName,
        detail: {
          phase: "bulk",
          batchId,
          approvalId,
          decision: body.decision,
          batchSize: unique.length,
        },
        effect: body.decision === "approved" ? "allow" : "deny",
        ruleId: "approval-bulk-decision",
        ruleChain: [],
        reason: `decided as part of a bulk action (${unique.length} items): ${body.reason}`,
      });
      results.push({ approvalId, ok: true, status: 200 });
    }

    const decided = results.filter((r) => r.ok).length;
    return reply.status(207).send({
      batchId,
      requested: unique.length,
      decided,
      refused: results.length - decided,
      results,
      note:
        "Each item was decided through the same endpoint logic a single decision uses, and each carries " +
        "its own audit row. A refused item never blocks the rest, and a successful item never covers for a " +
        "refused one.",
    });
  });
}

/** the pending-approval ids a project's classifications make bulk-ineligible —
 * exported for the admin surface so the UI can grey the checkbox rather than
 * surprising a reviewer with a per-item refusal */
export async function bulkFencedProjectIds(db: Db): Promise<string[]> {
  const rows = await db.select({ id: projects.id }).from(projects);
  const fenced: string[] = [];
  for (const p of rows) {
    if ((await projectPiiMode(db, p.id)) === "block") fenced.push(p.id);
  }
  return fenced;
}
