import {
  and,
  eq,
  inArray,
  revocations,
  roleAssignments,
  roleServerGrants,
  roleToolGrants,
  serverGrants,
  toolGrants,
  type Db,
} from "@regulait/db";
import type { Entitlements } from "@regulait/policy-kernel";

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
  const [rtGrants, rsGrants] =
    roleIds.length === 0
      ? [[], []]
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
        ]);

  return {
    toolGrants: tGrants,
    serverGrants: sGrants,
    roleToolGrants: rtGrants,
    roleServerGrants: rsGrants,
    revocations: revs,
  };
}
