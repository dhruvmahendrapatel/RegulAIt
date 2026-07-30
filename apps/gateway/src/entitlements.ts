import {
  agentRevocations,
  and,
  connectorRevocations,
  eq,
  inArray,
  revocations,
  roleAgentGrants,
  roleAssignments,
  roleConnectorGrants,
  roleServerGrants,
  roleToolGrants,
  roles,
  serverGrants,
  teamMembers,
  toolGrants,
  type Db,
} from "@regulait/db";
import type {
  AgentRevocation,
  ConnectorRevocation,
  Entitlements,
  RoleAgentGrant,
  RoleConnectorGrant,
} from "@regulait/policy-kernel";

/**
 * PILLAR 1 rule scoping: the subject memberships that decide which widened
 * restriction rules apply to a user — the roles they are assigned and the
 * teams they belong to. The gateway uses these to pre-filter role/team-scoped
 * rules in SQL, exactly as it pre-filters role-derived GRANTS, keeping the
 * kernel subject-free. This is entitlement METADATA only: membership widens
 * which RESTRICTIONS can bind, never which tools/agents a user may call.
 */
export async function loadScopeMemberships(
  db: Db,
  userId: string,
): Promise<{ roleIds: string[]; teamIds: string[] }> {
  const [assignments, memberships] = await Promise.all([
    db.select({ roleId: roleAssignments.roleId }).from(roleAssignments).where(eq(roleAssignments.userId, userId)),
    db.select({ teamId: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, userId)),
  ]);
  return {
    roleIds: assignments.map((a) => a.roleId),
    teamIds: memberships.map((m) => m.teamId),
  };
}

/**
 * Load everything that determines what a user may do on a server (§5):
 * direct grants, role-derived grants for the user's assigned roles, and
 * per-user revocations. The kernel receives role grants pre-filtered to the
 * user's roles, so it never needs to know about assignments.
 */
export async function loadEntitlements(
  db: Db,
  userId: string,
  serverId: string,
): Promise<Entitlements> {
  const [tGrants, sGrants, assignments, revs] = await Promise.all([
    db
      .select()
      .from(toolGrants)
      .where(and(eq(toolGrants.userId, userId), eq(toolGrants.serverId, serverId))),
    db
      .select()
      .from(serverGrants)
      .where(and(eq(serverGrants.userId, userId), eq(serverGrants.serverId, serverId))),
    db.select().from(roleAssignments).where(eq(roleAssignments.userId, userId)),
    db
      .select()
      .from(revocations)
      .where(and(eq(revocations.userId, userId), eq(revocations.serverId, serverId))),
  ]);

  const roleIds = assignments.map((a) => a.roleId);
  const [rtGrants, rsGrants, roleRows] =
    roleIds.length === 0
      ? [[], [], []]
      : await Promise.all([
          db
            .select()
            .from(roleToolGrants)
            .where(
              and(inArray(roleToolGrants.roleId, roleIds), eq(roleToolGrants.serverId, serverId)),
            ),
          db
            .select()
            .from(roleServerGrants)
            .where(
              and(
                inArray(roleServerGrants.roleId, roleIds),
                eq(roleServerGrants.serverId, serverId),
              ),
            ),
          db
            .select({ id: roles.id, name: roles.name })
            .from(roles)
            .where(inArray(roles.id, roleIds)),
        ]);

  // Role display names ride along for the kernel's reason prose — ids stay
  // authoritative in ruleId/ruleChain, but a matched role reads by name.
  const roleName = new Map(roleRows.map((r) => [r.id, r.name]));
  return {
    toolGrants: tGrants,
    serverGrants: sGrants,
    roleToolGrants: rtGrants.map((g) => ({ ...g, roleName: roleName.get(g.roleId) ?? null })),
    roleServerGrants: rsGrants.map((g) => ({ ...g, roleName: roleName.get(g.roleId) ?? null })),
    revocations: revs,
  };
}

/**
 * §5 role-bundled AGENT grants for a user (ADR-0014). Mirrors loadEntitlements'
 * roleAssignments → roleIds → role-grant pre-filter, kept SEPARATE from
 * loadEntitlements (which is MCP/server-scoped). The kernel receives the grants
 * pre-filtered to the user's assigned roles, with the role display name riding
 * along for reason prose. Returns [] when the user has no role assignments.
 */
export async function loadRoleAgentGrants(db: Db, userId: string): Promise<RoleAgentGrant[]> {
  const assignments = await db
    .select({ roleId: roleAssignments.roleId })
    .from(roleAssignments)
    .where(eq(roleAssignments.userId, userId));
  const roleIds = assignments.map((a) => a.roleId);
  if (roleIds.length === 0) return [];

  const [grants, roleRows] = await Promise.all([
    db.select().from(roleAgentGrants).where(inArray(roleAgentGrants.roleId, roleIds)),
    db.select({ id: roles.id, name: roles.name }).from(roles).where(inArray(roles.id, roleIds)),
  ]);
  const roleName = new Map(roleRows.map((r) => [r.id, r.name]));
  return grants.map((g) => ({
    id: g.id,
    roleId: g.roleId,
    roleName: roleName.get(g.roleId) ?? null,
    agentId: g.agentId,
    allowedModes: g.allowedModes,
  }));
}

/**
 * §5 role-bundled CONNECTOR grants for a user (ADR-0014). Same pre-filter shape
 * as loadRoleAgentGrants. Returns [] when the user has no role assignments.
 */
export async function loadRoleConnectorGrants(
  db: Db,
  userId: string,
): Promise<RoleConnectorGrant[]> {
  const assignments = await db
    .select({ roleId: roleAssignments.roleId })
    .from(roleAssignments)
    .where(eq(roleAssignments.userId, userId));
  const roleIds = assignments.map((a) => a.roleId);
  if (roleIds.length === 0) return [];

  const [grants, roleRows] = await Promise.all([
    db.select().from(roleConnectorGrants).where(inArray(roleConnectorGrants.roleId, roleIds)),
    db.select({ id: roles.id, name: roles.name }).from(roles).where(inArray(roles.id, roleIds)),
  ]);
  const roleName = new Map(roleRows.map((r) => [r.id, r.name]));
  return grants.map((g) => ({
    id: g.id,
    roleId: g.roleId,
    roleName: roleName.get(g.roleId) ?? null,
    connectorId: g.connectorId,
    mode: g.mode,
    allowedObjects: g.allowedObjects,
  }));
}

/**
 * ADR-0019 per-user AGENT revocations. The subtractive half of the entitlement
 * picture, loaded beside loadRoleAgentGrants at EVERY evaluateAgent site — a
 * revocation honoured on direct invoke but not in orchestration would be a
 * security hole, so the two loaders always travel together. Returns [] when the
 * user has no revocations, which makes the kernel call byte-identical to the
 * pre-ADR-0019 behaviour.
 */
export async function loadAgentRevocations(db: Db, userId: string): Promise<AgentRevocation[]> {
  const rows = await db
    .select()
    .from(agentRevocations)
    .where(eq(agentRevocations.userId, userId));
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    agentId: r.agentId,
    reason: r.reason,
  }));
}

/** ADR-0019 per-user CONNECTOR revocations — the connector twin of
 * loadAgentRevocations, same discipline. */
export async function loadConnectorRevocations(
  db: Db,
  userId: string,
): Promise<ConnectorRevocation[]> {
  const rows = await db
    .select()
    .from(connectorRevocations)
    .where(eq(connectorRevocations.userId, userId));
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    connectorId: r.connectorId,
    reason: r.reason,
  }));
}
