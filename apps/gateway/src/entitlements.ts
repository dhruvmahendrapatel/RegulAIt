import {
  agentRevocations,
  and,
  connectorRevocations,
  eq,
  inArray,
  isNull,
  mcpBundleGrants,
  mcpBundleVersionItems,
  mcpBundleVersions,
  mcpBundles,
  mcpTools,
  or,
  ORG_SETTINGS_ID,
  orgSettings,
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
  users,
  type Db,
} from "@regulait/db";
import type {
  AgentRevocation,
  BundleToolGrant,
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
    // ADR-0038: a role held BOTH directly and via an IdP group mapping is two
    // `role_assignments` rows and ONE role — every caller wants the SET.
    roleIds: [...new Set(assignments.map((a) => a.roleId))],
    teamIds: [...new Set(memberships.map((m) => m.teamId))],
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
  const [tGrants, sGrants, assignments, revs, bundleGrants] = await Promise.all([
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
    loadBundleToolGrants(db, userId, serverId),
  ]);

  // ADR-0038: DISTINCT — a role held both directly and via a group mapping is
  // two assignment rows and one role. The kernel is unaffected either way (it
  // receives role-derived GRANTS, never assignments), but the SET is what the
  // pre-filter means.
  const roleIds = [...new Set(assignments.map((a) => a.roleId))];
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
    // ADR-0236: present only when the user holds a bundle naming a tool on this server, so every other decision's
    // input (and therefore its rule chain) is exactly what it was before
    ...(bundleGrants.length > 0 ? { bundleToolGrants: bundleGrants } : {}),
    revocations: revs,
  };
}

/** ADR-0236: when a user holds the same tool through several bundles, the kernel names the most direct one */
const BUNDLE_VIA_ORDER = { user: 0, role: 1, team: 2 } as const;

/**
 * ADR-0236 (P11) — the governed-MCP-bundle grants that reach `userId` on `serverId`: every bundle granted to the user,
 * to a role the user is assigned, or to a team the user belongs to, at the bundle's CURRENT version, skipping archived
 * bundles. Returns [] while `org_settings.mcp_bundles_enabled` is false (the default), so the feature switched off
 * loads nothing and decides nothing. The kernel then applies the per-user revocations to these exactly as to role
 * grants; this loader only resolves which bundle items are in reach.
 */
export async function loadBundleToolGrants(db: Db, userId: string, serverId: string): Promise<BundleToolGrant[]> {
  const [org] = await db
    .select({ enabled: orgSettings.mcpBundlesEnabled })
    .from(orgSettings)
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  if (!org?.enabled) return [];
  const { roleIds, teamIds } = await loadScopeMemberships(db, userId);
  const subject = or(
    eq(mcpBundleGrants.userId, userId),
    ...(roleIds.length > 0 ? [inArray(mcpBundleGrants.roleId, roleIds)] : []),
    ...(teamIds.length > 0 ? [inArray(mcpBundleGrants.teamId, teamIds)] : []),
  );
  const rows = await db
    .select({
      grantId: mcpBundleGrants.id,
      grantUserId: mcpBundleGrants.userId,
      grantRoleId: mcpBundleGrants.roleId,
      maxTier: mcpBundleGrants.maxTier,
      bundleId: mcpBundles.id,
      bundleName: mcpBundles.name,
      approverUserId: mcpBundles.approverUserId,
      approverName: users.displayName,
      version: mcpBundleVersions.version,
      toolName: mcpBundleVersionItems.toolName,
      toolKind: mcpTools.kind,
      toolDangerous: mcpTools.dangerous,
    })
    .from(mcpBundleGrants)
    .innerJoin(mcpBundles, and(eq(mcpBundles.id, mcpBundleGrants.bundleId), isNull(mcpBundles.archivedAt)))
    .innerJoin(
      mcpBundleVersions,
      and(eq(mcpBundleVersions.bundleId, mcpBundles.id), eq(mcpBundleVersions.version, mcpBundles.currentVersion)),
    )
    .innerJoin(
      mcpBundleVersionItems,
      and(eq(mcpBundleVersionItems.versionId, mcpBundleVersions.id), eq(mcpBundleVersionItems.serverId, serverId)),
    )
    // the tier comes from the inventory; an item whose tool left the inventory grants nothing (fail closed)
    .innerJoin(mcpTools, and(eq(mcpTools.serverId, mcpBundleVersionItems.serverId), eq(mcpTools.name, mcpBundleVersionItems.toolName)))
    .leftJoin(users, eq(users.id, mcpBundles.approverUserId))
    .where(subject)
    .limit(10_000);
  const grants: BundleToolGrant[] = rows.map((r) => ({
    id: r.grantId,
    bundleId: r.bundleId,
    bundleName: r.bundleName,
    version: r.version,
    via: r.grantUserId ? "user" : r.grantRoleId ? "role" : "team",
    serverId,
    toolName: r.toolName,
    toolTier: r.toolDangerous ? "dangerous" : r.toolKind,
    maxTier: r.maxTier,
    approverUserId: r.approverUserId,
    approverName: r.approverName,
  }));
  return grants.sort((a, b) => BUNDLE_VIA_ORDER[a.via] - BUNDLE_VIA_ORDER[b.via] || a.id.localeCompare(b.id));
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
  const roleIds = [...new Set(assignments.map((a) => a.roleId))];
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
  const roleIds = [...new Set(assignments.map((a) => a.roleId))];
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
    // O9 (ADR-0027): partial-revocation scope — 'full' = the total semantics
    scope: r.scope,
  }));
}
