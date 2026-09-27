/**
 * ADR-0090 — THE ONE GRANT-REMOVAL IMPLEMENTATION PER GRANT KIND.
 *
 * Before this module, "remove a grant row" lived inline in eight tiny route
 * handlers (direct agent/connector deletes in agents-connectors.ts, the four
 * role-grant deletes in app.ts — direct MCP tool/server grants had no delete
 * at all). A certification campaign's revoke decision (ADR-0090) must execute
 * EXACTLY those removals — never a parallel delete with its own semantics —
 * so the removals moved here and both callers now share them:
 *
 *   - the admin DELETE endpoints call these functions (same behaviour,
 *     byte-identical responses);
 *   - a campaign item's revoke decision calls the same functions inside the
 *     decision's own transaction (app.ts `decideOneApproval` →
 *     `applyGrantCertificationDecision`).
 *
 * There is deliberately nothing else in here: no audit writes (each caller
 * audits as itself), no entitlement re-evaluation (the kernel reads grant
 * rows live on every call, so a deleted row is gone at the very next
 * evaluation — that IS the enforcement).
 *
 * WHY DELETES AND NOT ADR-0019 REVOCATION ROWS: the kernel gives a DIRECT
 * grant precedence over a revocation row (a direct grant is itself a per-user
 * override — packages/policy-kernel, "a direct user grant always survives a
 * revocation"), so inserting a revocation would NOT revoke a direct grant.
 * Deleting the row is the only truthful removal for every kind, and for
 * role-bundled kinds it is exactly what the existing role-grant DELETE
 * endpoints already meant: the role stops bundling that access for everyone.
 */
import {
  agentGrants,
  and,
  connectorGrants,
  eq,
  roleAgentGrants,
  roleConnectorGrants,
  roleServerGrants,
  roleToolGrants,
  serverGrants,
  toolGrants,
  type Db,
} from "@regulait/db";
import type { DbOrTxWrite } from "./config-versions.js";

/** true when a row was actually removed; false when it was already gone */
export type Removed = boolean;

export async function deleteAgentGrantById(db: DbOrTxWrite, grantId: string): Promise<Removed> {
  const deleted = await db
    .delete(agentGrants)
    .where(eq(agentGrants.id, grantId))
    .returning({ id: agentGrants.id });
  return deleted.length > 0;
}

export async function deleteConnectorGrantById(db: DbOrTxWrite, grantId: string): Promise<Removed> {
  const deleted = await db
    .delete(connectorGrants)
    .where(eq(connectorGrants.id, grantId))
    .returning({ id: connectorGrants.id });
  return deleted.length > 0;
}

export async function deleteToolGrantById(db: DbOrTxWrite, grantId: string): Promise<Removed> {
  const deleted = await db
    .delete(toolGrants)
    .where(eq(toolGrants.id, grantId))
    .returning({ id: toolGrants.id });
  return deleted.length > 0;
}

export async function deleteServerGrantById(db: DbOrTxWrite, grantId: string): Promise<Removed> {
  const deleted = await db
    .delete(serverGrants)
    .where(eq(serverGrants.id, grantId))
    .returning({ id: serverGrants.id });
  return deleted.length > 0;
}

/** roleId, when given, scopes the delete exactly as the nested admin route
 * does (`DELETE /v1/roles/:roleId/grants/agents/:grantId`) */
export async function deleteRoleAgentGrantById(
  db: DbOrTxWrite,
  grantId: string,
  roleId?: string,
): Promise<Removed> {
  const deleted = await db
    .delete(roleAgentGrants)
    .where(
      roleId
        ? and(eq(roleAgentGrants.id, grantId), eq(roleAgentGrants.roleId, roleId))
        : eq(roleAgentGrants.id, grantId),
    )
    .returning({ id: roleAgentGrants.id });
  return deleted.length > 0;
}

export async function deleteRoleConnectorGrantById(
  db: DbOrTxWrite,
  grantId: string,
  roleId?: string,
): Promise<Removed> {
  const deleted = await db
    .delete(roleConnectorGrants)
    .where(
      roleId
        ? and(eq(roleConnectorGrants.id, grantId), eq(roleConnectorGrants.roleId, roleId))
        : eq(roleConnectorGrants.id, grantId),
    )
    .returning({ id: roleConnectorGrants.id });
  return deleted.length > 0;
}

export async function deleteRoleToolGrantById(
  db: DbOrTxWrite,
  grantId: string,
  roleId?: string,
): Promise<Removed> {
  const deleted = await db
    .delete(roleToolGrants)
    .where(
      roleId
        ? and(eq(roleToolGrants.id, grantId), eq(roleToolGrants.roleId, roleId))
        : eq(roleToolGrants.id, grantId),
    )
    .returning({ id: roleToolGrants.id });
  return deleted.length > 0;
}

export async function deleteRoleServerGrantById(
  db: DbOrTxWrite,
  grantId: string,
  roleId?: string,
): Promise<Removed> {
  const deleted = await db
    .delete(roleServerGrants)
    .where(
      roleId
        ? and(eq(roleServerGrants.id, grantId), eq(roleServerGrants.roleId, roleId))
        : eq(roleServerGrants.id, grantId),
    )
    .returning({ id: roleServerGrants.id });
  return deleted.length > 0;
}
