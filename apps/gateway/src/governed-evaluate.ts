import {
  and,
  approvalRules,
  approvals,
  auditLog,
  count,
  dataScopeRules,
  eq,
  gte,
  inArray,
  mcpServers,
  rateLimits,
  users,
  type Db,
} from "@regulait/db";
import { evaluate, type Decision, type ToolRef } from "@regulait/policy-kernel";
import { loadEntitlements } from "./entitlements.js";

export interface GovernedEvaluation {
  decision: Decision;
  /** the approved Approvals-Queue row this evaluation relied on, if any */
  approvedApprovalId: string | null;
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
): Promise<GovernedEvaluation> {
  const [entitlements, aRules, limits, scopeRules, approvedRows, serverRows] = await Promise.all([
    loadEntitlements(db, userId, serverId),
    db
      .select()
      .from(approvalRules)
      .where(and(eq(approvalRules.userId, userId), eq(approvalRules.serverId, serverId))),
    db
      .select()
      .from(rateLimits)
      .where(and(eq(rateLimits.userId, userId), eq(rateLimits.serverId, serverId))),
    db
      .select()
      .from(dataScopeRules)
      .where(and(eq(dataScopeRules.userId, userId), eq(dataScopeRules.serverId, serverId))),
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
      const conditions = [
        eq(auditLog.userId, userId),
        eq(auditLog.serverId, serverId),
        eq(auditLog.effect, "allow"),
        gte(auditLog.at, windowStart),
      ];
      if (l.toolName) conditions.push(eq(auditLog.toolName, l.toolName));
      const [row] = await db
        .select({ value: count() })
        .from(auditLog)
        .where(and(...conditions));
      return { ...l, currentCount: Number(row?.value ?? 0) };
    }),
  );

  const approvedApprovalId = approvedRows[0]?.id ?? null;

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
  });

  return { decision, approvedApprovalId };
}
