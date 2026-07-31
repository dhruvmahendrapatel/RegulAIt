import {
  and,
  approvalRules,
  approvals,
  auditLog,
  count,
  dataScopeRules,
  deployTargets,
  eq,
  gte,
  inArray,
  mcpServers,
  or,
  rateLimits,
  users,
  workflowInstances,
  type Db,
  type PgColumn,
  type SQL,
} from "@regulait/db";
import { evaluate, type Decision, type ToolRef } from "@regulait/policy-kernel";
import { loadEntitlements, loadScopeMemberships } from "./entitlements.js";

/**
 * PILLAR 1 rule scoping: the SQL pre-filter that widens a rule load from the
 * old exact (userId, serverId) match to every scope this user matches, exactly
 * mirroring how roleToolGrants is already pre-filtered. The kernel then stays
 * subject-free — it re-checks only the user-scope id it must never widen.
 *
 * Subject: fleet always, user rules for THIS user, role rules for the user's
 * assigned roles, team rules for the user's teams. Server: all-servers rules
 * plus this-server rules. Empty roleIds/teamIds simply drop their OR arm, so
 * an `IN ()` is never emitted.
 */
function scopedRuleWhere(
  cols: {
    scope: PgColumn;
    serverScope: PgColumn;
    userId: PgColumn;
    roleId: PgColumn;
    teamId: PgColumn;
    serverId: PgColumn;
  },
  userId: string,
  serverId: string,
  roleIds: string[],
  teamIds: string[],
): SQL {
  const subject: SQL[] = [
    eq(cols.scope, "fleet"),
    and(eq(cols.scope, "user"), eq(cols.userId, userId))!,
  ];
  if (roleIds.length) subject.push(and(eq(cols.scope, "role"), inArray(cols.roleId, roleIds))!);
  if (teamIds.length) subject.push(and(eq(cols.scope, "team"), inArray(cols.teamId, teamIds))!);
  return and(or(...subject)!, or(eq(cols.serverScope, "all"), eq(cols.serverId, serverId))!)!;
}

export interface GovernedEvaluation {
  decision: Decision;
  /** the approved Approvals-Queue row this evaluation relied on, if any */
  approvedApprovalId: string | null;
}

/** the workflow statuses under which attributed work is still "landing on" its
 * deploy targets — terminal instances no longer bind a mode context */
const TERMINAL_INSTANCE_STATUSES = ["completed", "denied", "aborted", "rolled_back"];

/**
 * A4 (ADR-0027): derive the SERVER-SIDE deploy context of an attributed call —
 * the set of deploy-target modes the project's in-flight workflow instances'
 * deployment/rollback stages name. This is "the deploy target the change lands
 * on" from ADR-0019's A4 assessment, made concrete: never client-asserted, a
 * SET because one project can be in flight toward targets of different modes
 * at once. An unattributed call, a project with no in-flight instances, or
 * instances whose stages name no (existing) deploy target all derive [] — and
 * a mode-scoped rule then simply does not match (the kernel's documented
 * fail-closed-for-restrictions-bound-to-a-known-context precedence).
 * Exported for tests.
 */
export async function deriveDeployContext(db: Db, projectId: string): Promise<string[]> {
  const instances = await db
    .select({ definition: workflowInstances.definition, status: workflowInstances.status })
    .from(workflowInstances)
    .where(eq(workflowInstances.projectId, projectId));
  const connections = new Set<string>();
  for (const inst of instances) {
    if (TERMINAL_INSTANCE_STATUSES.includes(inst.status)) continue;
    const stages = (inst.definition as { stages?: Array<{ type?: string; connection?: string }> })
      ?.stages;
    for (const stage of stages ?? []) {
      if ((stage.type === "deployment" || stage.type === "rollback") && stage.connection) {
        connections.add(stage.connection);
      }
    }
  }
  if (connections.size === 0) return [];
  const targets = await db
    .select({ mode: deployTargets.mode })
    .from(deployTargets)
    .where(inArray(deployTargets.name, [...connections]));
  return [...new Set(targets.map((t) => t.mode))];
}

/**
 * Full §3 evaluation: grants + rate limits (usage counted from audit-log
 * allow rows inside each limit's window) + approval rules, including any
 * already-approved queue entry for exactly this user/server/tool. Pure
 * decision only — callers own auditing, queue writes, and consumption.
 */
export async function governedEvaluate(
  db: Db,
  userId: string,
  serverId: string,
  tool: ToolRef,
  args?: Record<string, unknown>,
  /** §5.1 Team-Lead ceiling: the tool NAMES this worker's lead chain permits.
   * null/undefined = no lead constraint. Only ever narrows a granted call. */
  ceilingTools?: readonly string[] | null,
  /** A4: pillar-5 attribution of this call, used ONLY to derive the deploy
   * context for mode-scoped rules — and only lazily, when a loaded rule
   * actually carries a deployMode, so the default path costs nothing. */
  projectId?: string | null,
): Promise<GovernedEvaluation> {
  // PILLAR 1 rule scoping: resolve the user's role/team memberships first, then
  // widen every rule load from the exact (userId, serverId) match to every
  // scope this user matches. The kernel receives a pre-filtered set and stays
  // subject-free — it re-checks only the user-scope id it must never widen.
  const { roleIds, teamIds } = await loadScopeMemberships(db, userId);
  const [entitlements, aRules, limits, scopeRules, approvedRows, serverRows] = await Promise.all([
    loadEntitlements(db, userId, serverId),
    db
      .select()
      .from(approvalRules)
      .where(
        scopedRuleWhere(
          {
            scope: approvalRules.scope,
            serverScope: approvalRules.serverScope,
            userId: approvalRules.userId,
            roleId: approvalRules.roleId,
            teamId: approvalRules.teamId,
            serverId: approvalRules.serverId,
          },
          userId,
          serverId,
          roleIds,
          teamIds,
        ),
      ),
    db
      .select()
      .from(rateLimits)
      .where(
        scopedRuleWhere(
          {
            scope: rateLimits.scope,
            serverScope: rateLimits.serverScope,
            userId: rateLimits.userId,
            roleId: rateLimits.roleId,
            teamId: rateLimits.teamId,
            serverId: rateLimits.serverId,
          },
          userId,
          serverId,
          roleIds,
          teamIds,
        ),
      ),
    db
      .select()
      .from(dataScopeRules)
      .where(
        scopedRuleWhere(
          {
            scope: dataScopeRules.scope,
            serverScope: dataScopeRules.serverScope,
            userId: dataScopeRules.userId,
            roleId: dataScopeRules.roleId,
            teamId: dataScopeRules.teamId,
            serverId: dataScopeRules.serverId,
          },
          userId,
          serverId,
          roleIds,
          teamIds,
        ),
      ),
    db
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.userId, userId),
          eq(approvals.serverId, serverId),
          eq(approvals.toolName, tool.name),
          eq(approvals.status, "approved"),
        ),
      )
      .limit(1),
    db.select({ name: mcpServers.name }).from(mcpServers).where(eq(mcpServers.id, serverId)),
  ]);

  // Display names for the decision's reason prose — the ids in ruleId /
  // ruleChain / stored audit fields stay authoritative, but the sentence a
  // human reads (simulation verdicts, proxy denials) names things by name.
  const nameIds = [...new Set([userId, ...aRules.map((r) => r.approverUserId)])];
  const nameRows = nameIds.length
    ? await db
        .select({ id: users.id, displayName: users.displayName, email: users.email })
        .from(users)
        .where(inArray(users.id, nameIds))
    : [];
  const nameOf = new Map(nameRows.map((u) => [u.id, u.displayName || u.email]));

  const limitsWithCounts = await Promise.all(
    limits.map(async (l) => {
      const windowStart = new Date(Date.now() - l.windowSeconds * 1000);
      // Each widened limit keeps its OWN per-subject count/window (no summing).
      // The count is always this user's allowed calls in the window; an
      // all-servers limit counts across every server, a server-scoped one stays
      // pinned to this server (identical to the legacy behaviour).
      const conditions = [
        eq(auditLog.userId, userId),
        eq(auditLog.effect, "allow"),
        gte(auditLog.at, windowStart),
      ];
      if (l.serverScope !== "all") conditions.push(eq(auditLog.serverId, serverId));
      if (l.toolName) conditions.push(eq(auditLog.toolName, l.toolName));
      const [row] = await db
        .select({ value: count() })
        .from(auditLog)
        .where(and(...conditions));
      return { ...l, currentCount: Number(row?.value ?? 0) };
    }),
  );

  const approvedApprovalId = approvedRows[0]?.id ?? null;

  // A4: derive the deploy context ONLY when some loaded rule is mode-scoped —
  // zero extra queries on the default path (no mode-scoped rules = today).
  const anyModeScoped =
    aRules.some((r) => r.deployMode != null) ||
    limits.some((l) => l.deployMode != null) ||
    scopeRules.some((r) => r.deployMode != null);
  const deployContext =
    anyModeScoped && projectId ? await deriveDeployContext(db, projectId) : null;

  const decision = evaluate({
    userId,
    serverId,
    userName: nameOf.get(userId) ?? null,
    serverName: serverRows[0]?.name ?? null,
    tool,
    ...entitlements,
    approvalRules: aRules.map((r) => ({
      ...r,
      approverName: nameOf.get(r.approverUserId) ?? null,
    })),
    rateLimits: limitsWithCounts,
    dataScopeRules: scopeRules,
    args,
    approvedApprovalId,
    ceilingTools: ceilingTools ?? null,
    deployContext,
  });

  return { decision, approvedApprovalId };
}
