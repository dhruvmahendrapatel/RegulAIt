/**
 * ADR-0188 slice S4 — the admin reads of workload identities, and the ONE way an
 * agent principal gets grants of its own: replacing its grant set
 * (`PUT /v1/workload-identities/:identityId/grants`).
 *
 * S4 switches the in-process agent paths on under the strict default
 * (`agent_entitlement_mode = own_grants`, OWNER DECISION 1, ADR-0180: nothing is
 * grandfathered), so an agent can do nothing until an admin grants it. That needs
 * the grant write to exist, so S4 builds it here (backend only; the S6 page
 * consumes it): the list and detail reads, and the grant-set read and replace.
 * The other identity routes (create, patch, revoke, credentials, proposals,
 * picker sources) stay S1 stubs for S6.
 *
 * The replace is one transaction: the stored `grants_revision` must equal the
 * one the caller read (X33: a stale write is 409 `grants_revision_conflict`),
 * the direct grants and role assignments are deleted and re-inserted, the
 * revision moves forward by exactly one (the 0180 trigger holds that), and the
 * change is audited with counts and ids only. An identity that is not `active`
 * cannot be granted. `putIdentityGrants` is exported so the demo seed and the
 * test fixtures write grants through the same service an admin's request does.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  agentGrants,
  agentRevocations,
  agents,
  and,
  connectorGrants,
  connectorRevocations,
  inArray,
  mcpTools,
  roleAssignments,
  revocations,
  roleAgentGrants,
  roleConnectorGrants,
  roleServerGrants,
  roleToolGrants,
  serverGrants,
  toolGrants,
  users,
  asc,
  auditLog,
  connectors,
  delegationGrants,
  eq,
  gt,
  identityAgentGrants,
  identityConnectorGrants,
  identityRoleAssignments,
  identityServerGrants,
  identityToolGrants,
  isNull,
  mcpServers,
  roles,
  sql,
  workloadCredentials,
  workloadIdentities,
  type Db,
} from "@regulait/db";
import {
  canonicalJson,
  GRANTS_REVISION_CONFLICT,
  sha256Hex,
  listWorkloadIdentitiesQuerySchema,
  putAgentGrantsSchema,
  updateWorkloadIdentitySchema,
  type UpdateWorkloadIdentity,
  type AgentGrantsView,
  type PutAgentGrants,
  type WorkloadIdentityDetailView,
  type WorkloadIdentityListView,
  type WorkloadIdentityView,
} from "@regulait/shared";
import { requireStepUp, type StepUpCheckArgs } from "./step-up.js";

const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";
const idParam = z.object({ identityId: z.string().uuid() });

type IdentityRow = typeof workloadIdentities.$inferSelect;

function view(r: IdentityRow): WorkloadIdentityView {
  return {
    id: r.id,
    kind: r.kind,
    agentId: r.agentId,
    builderAgentId: r.builderAgentId,
    engineRunnerId: r.engineRunnerId,
    identifier: r.identifier,
    sponsorUserIds: [...r.sponsorUserIds],
    environments: [...r.environments],
    status: r.status,
    grantsRevision: r.grantsRevision,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** why a grant-set write was refused: a stable code and an HTTP status */
export class IdentityGrantsError extends Error {
  constructor(
    readonly code:
      | "identity_not_found"
      | "identity_not_active"
      | typeof GRANTS_REVISION_CONFLICT
      | "grant_target_not_found"
      | "grant_exceeds_stewards"
      | "steward_not_found",
    readonly status: number,
    detail: string,
    readonly currentRevision?: number,
  ) {
    super(detail);
    this.name = "IdentityGrantsError";
  }
}

/** the identity's DIRECT grant set and role assignments, and the revision a replace must name */
export async function getIdentityGrants(db: Db, identityId: string): Promise<AgentGrantsView | null> {
  const [ident] = await db.select().from(workloadIdentities).where(eq(workloadIdentities.id, identityId));
  if (!ident) return null;
  const [tools, servers, agentRows, connectorRows, roleRows] = await Promise.all([
    db.select().from(identityToolGrants).where(eq(identityToolGrants.identityId, identityId)).orderBy(asc(identityToolGrants.serverId), asc(identityToolGrants.toolName)),
    db.select().from(identityServerGrants).where(eq(identityServerGrants.identityId, identityId)).orderBy(asc(identityServerGrants.serverId)),
    db.select().from(identityAgentGrants).where(eq(identityAgentGrants.identityId, identityId)).orderBy(asc(identityAgentGrants.agentId)),
    db.select().from(identityConnectorGrants).where(eq(identityConnectorGrants.identityId, identityId)).orderBy(asc(identityConnectorGrants.connectorId)),
    db.select().from(identityRoleAssignments).where(eq(identityRoleAssignments.identityId, identityId)).orderBy(asc(identityRoleAssignments.roleId)),
  ]);
  return {
    identityId,
    revision: ident.grantsRevision,
    tools: tools.map((t) => ({ serverId: t.serverId, toolName: t.toolName })),
    servers: servers.map((s) => ({ serverId: s.serverId, readOnlyAll: s.readOnlyAll })),
    agents: agentRows.map((a) => ({ agentId: a.agentId, allowedModes: [...(a.allowedModes as string[])] })),
    connectors: connectorRows.map((c) => ({ connectorId: c.connectorId, mode: c.mode as "read" | "readwrite", allowedObjects: [...(c.allowedObjects as string[])] })),
    roleIds: roleRows.map((r) => r.roleId),
  };
}

/**
 * REPLACE an identity's own grant set (decision 24). Validated by
 * `putAgentGrantsSchema` (strict lists: an agent never gets "every mode" or
 * "every object", decision 27). Refuses a stale revision, an identity that is
 * not active, and a target (server, agent, connector, role) that does not
 * exist. Audited (`workload-identity-grants-replaced`), ids and counts only.
 */
export async function putIdentityGrants(db: Db, identityId: string, body: PutAgentGrants, actorUserId: string | null): Promise<AgentGrantsView> {
  const set = putAgentGrantsSchema.parse(body);
  // a refusal is audited in its own committed transaction, then thrown (nothing of the set is written)
  const out = await db.transaction(async (tx): Promise<AgentGrantsView | { refused: string }> => {
    const [ident] = await tx.select().from(workloadIdentities).where(eq(workloadIdentities.id, identityId)).for("update");
    if (!ident) throw new IdentityGrantsError("identity_not_found", 404, `no workload identity ${identityId}`);
    if (ident.status !== "active") throw new IdentityGrantsError("identity_not_active", 409, `identity ${identityId} is ${ident.status}; only an active identity is granted`);
    if (set.revision !== ident.grantsRevision) {
      throw new IdentityGrantsError(GRANTS_REVISION_CONFLICT, 409, "the grant set changed since it was read", ident.grantsRevision);
    }
    // every target exists (a FK would also refuse, but with a 500 and no name)
    const need = async (ok: boolean, what: string) => {
      if (!ok) throw new IdentityGrantsError("grant_target_not_found", 404, `${what} does not exist`);
    };
    for (const id of new Set([...set.tools.map((t) => t.serverId), ...set.servers.map((s) => s.serverId)])) {
      await need((await tx.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.id, id))).length > 0, `MCP server ${id}`);
    }
    for (const a of set.agents) await need((await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, a.agentId))).length > 0, `agent ${a.agentId}`);
    for (const c of set.connectors) {
      await need((await tx.select({ id: connectors.id }).from(connectors).where(eq(connectors.id, c.connectorId))).length > 0, `connector ${c.connectorId}`);
    }
    for (const r of set.roleIds) await need((await tx.select({ id: roles.id }).from(roles).where(eq(roles.id, r))).length > 0, `role ${r}`);
    // S4 follow-up N1 (secure by default): nothing is granted to an agent that none of its stewards holds.
    // The at-use intersection (the sponsor's rights, decision 3) still applies on every call.
    const unheld = await firstItemNoStewardHolds(tx as unknown as Db, ident.sponsorUserIds, set);
    if (unheld) {
      await tx.insert(auditLog).values({
        userId: actorUserId ?? SYSTEM_USER_ID,
        objectType: "workload_identity",
        objectId: identityId,
        detail: { phase: "grants_refused", code: "grant_exceeds_stewards", item: unheld, stewards: ident.sponsorUserIds },
        effect: "deny",
        ruleId: "grant-exceeds-stewards",
        ruleChain: [],
        reason: `refused: no steward of workload identity ${identityId} holds ${unheld} (ADR-0188 S4 amendment 1)`,
      });
      return { refused: unheld };
    }

    await tx.delete(identityToolGrants).where(eq(identityToolGrants.identityId, identityId));
    await tx.delete(identityServerGrants).where(eq(identityServerGrants.identityId, identityId));
    await tx.delete(identityAgentGrants).where(eq(identityAgentGrants.identityId, identityId));
    await tx.delete(identityConnectorGrants).where(eq(identityConnectorGrants.identityId, identityId));
    await tx.delete(identityRoleAssignments).where(eq(identityRoleAssignments.identityId, identityId));
    const by = actorUserId && actorUserId !== SYSTEM_USER_ID ? actorUserId : null;
    if (set.tools.length) await tx.insert(identityToolGrants).values(set.tools.map((t) => ({ identityId, serverId: t.serverId, toolName: t.toolName, createdBy: by })));
    if (set.servers.length) await tx.insert(identityServerGrants).values(set.servers.map((s) => ({ identityId, serverId: s.serverId, readOnlyAll: s.readOnlyAll, createdBy: by })));
    if (set.agents.length) await tx.insert(identityAgentGrants).values(set.agents.map((a) => ({ identityId, agentId: a.agentId, allowedModes: a.allowedModes, createdBy: by })));
    if (set.connectors.length) {
      await tx.insert(identityConnectorGrants).values(set.connectors.map((c) => ({ identityId, connectorId: c.connectorId, mode: c.mode, allowedObjects: c.allowedObjects, createdBy: by })));
    }
    if (set.roleIds.length) await tx.insert(identityRoleAssignments).values(set.roleIds.map((roleId) => ({ identityId, roleId, createdBy: by })));
    const revision = ident.grantsRevision + 1;
    await tx.update(workloadIdentities).set({ grantsRevision: revision, updatedAt: sql`now()` }).where(eq(workloadIdentities.id, identityId));
    await tx.insert(auditLog).values({
      userId: actorUserId ?? SYSTEM_USER_ID,
      objectType: "workload_identity",
      objectId: identityId,
      detail: {
        phase: "grants_replaced",
        revision,
        counts: { tools: set.tools.length, servers: set.servers.length, agents: set.agents.length, connectors: set.connectors.length, roles: set.roleIds.length },
        agentIds: set.agents.map((a) => a.agentId),
        serverIds: [...new Set([...set.tools.map((t) => t.serverId), ...set.servers.map((s) => s.serverId)])],
        connectorIds: set.connectors.map((c) => c.connectorId),
        roleIds: set.roleIds,
      },
      effect: "allow",
      ruleId: "workload-identity-grants-replaced",
      ruleChain: [],
      reason: `the own grant set of workload identity ${identityId} was replaced (revision ${revision}; ADR-0188 decision 24)`,
    });
    return { ...set, identityId, revision } as AgentGrantsView;
  });
  if ("refused" in out) throw new IdentityGrantsError("grant_exceeds_stewards", 422, `no steward of this identity holds ${out.refused}`);
  return out;
}

/**
 * Test-only pause points of the steward check (the L5 and deadlock tests hold a check open here while another
 * transaction runs). Unset in production; never changes what the check decides.
 */
export const stewardCheckTestHooks: { afterStewardReads?: (() => Promise<void>) | undefined } = {};

/**
 * Serialization point for the steward check (S4+S5 follow-up, review L5). A revocation is an INSERT, which no
 * `FOR SHARE` read can block, so a revocation committed while a check was running could leave a grant written
 * for an item its steward no longer held. Every revocation insert therefore first takes this person's `users` row
 * `FOR NO KEY UPDATE`, which conflicts with the `FOR SHARE` the steward check holds on each steward's row: a
 * revocation waits for a check in flight, and a check that starts after a revocation waits for it and then sees it.
 * `NO KEY UPDATE` (not `UPDATE`) so rows that merely reference the person (their `FOR KEY SHARE` foreign-key
 * checks) are not blocked. Call it inside the revocation's own transaction, before the insert.
 */
export async function lockPersonForRevocation(tx: Db, userId: string): Promise<boolean> {
  const rows = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("no key update");
  return rows.length > 0;
}

/**
 * The role-row twin of `lockPersonForRevocation` (PR #339 review). Adding an item to a role is an INSERT into a
 * `role_*_grants` table, whose foreign-key check takes only `FOR KEY SHARE` on the role's row; that does not
 * conflict with the `FOR SHARE` the steward check holds on every role it reads, so an item a steward has had
 * revoked could join the role while the check is open. Every role-grant insert therefore first takes the role's
 * row `FOR NO KEY UPDATE`: it waits for a check in flight, and a check that starts later waits for it and then
 * sees the new item. Call it inside the insert's own transaction, before the insert.
 */
export async function lockRoleForGrantInsert(tx: Db, roleId: string): Promise<boolean> {
  const rows = await tx.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId)).for("no key update");
  return rows.length > 0;
}

/**
 * Review follow-up (2026-10-10): a role-grant insert whose role does not exist is refused by name
 * (`404 role_not_found`, audited) instead of falling through to the role-grant table's foreign-key error.
 * Thrown inside the insert's transaction by `lockRoleOrRefuse`, so nothing is written.
 */
export class RoleNotFoundError extends Error {
  readonly code = "role_not_found" as const;
  constructor(readonly roleId: string) {
    super(`role ${roleId} does not exist`);
    this.name = "RoleNotFoundError";
  }
}

/** `lockRoleForGrantInsert`, refusing a missing role with `RoleNotFoundError` (the caller's transaction rolls back) */
export async function lockRoleOrRefuse(tx: Db, roleId: string): Promise<void> {
  if (!(await lockRoleForGrantInsert(tx, roleId))) throw new RoleNotFoundError(roleId);
}

export function roleNotFoundBody(roleId: string) {
  return { error: "role_not_found" as const, detail: `role ${roleId} does not exist; nothing was granted` };
}

/** the refusal's deny row, written on `db` after the refused transaction has rolled back (as other refusals are) */
export async function auditRoleNotFound(
  db: Db,
  args: { actorUserId: string | null | undefined; roleId: string; via: string; detail?: Record<string, unknown> },
): Promise<void> {
  await db.insert(auditLog).values({
    userId: args.actorUserId ?? "00000000-0000-0000-0000-000000000000",
    objectType: "role",
    objectId: args.roleId,
    detail: { phase: "role-grant", code: "role_not_found", via: args.via, ...(args.detail ?? {}) },
    effect: "deny",
    ruleId: "role-grant-refused",
    ruleChain: [],
    reason: `a grant to role ${args.roleId} was refused: the role does not exist (${args.via})`,
  });
}

/**
 * Run a role-grant insert under the role's lock. A missing role: the transaction rolls back, the refusal is
 * audited, and `null` is returned for the route to answer `404 role_not_found`.
 */
export async function insertRoleGrantLocked<T>(
  db: Db,
  roleId: string,
  audit: { actorUserId: string | null | undefined; via: string },
  insert: (tx: Db) => Promise<T>,
): Promise<T | null> {
  try {
    return await db.transaction(async (tx) => {
      await lockRoleOrRefuse(tx as unknown as Db, roleId);
      return insert(tx as unknown as Db);
    });
  } catch (err) {
    if (!(err instanceof RoleNotFoundError)) throw err;
    await auditRoleNotFound(db, { ...audit, roleId });
    return null;
  }
}

/**
 * What one steward holds, read in the caller's transaction with `FOR SHARE` on every grant, assignment and
 * revocation row (review L5): a concurrent revoke of a row this check relied on waits for the write that relied
 * on it, and a revoke that commits first is seen. Role-derived rows are read only for `lockedRoleIds`, the roles
 * the caller has already locked (deadlock fix: a role's own row is locked before any row that cascades from it).
 */
async function stewardHoldings(tx: Db, userId: string, lockedRoleIds: ReadonlySet<string>) {
  const assignments = await tx.select({ roleId: roleAssignments.roleId }).from(roleAssignments).where(eq(roleAssignments.userId, userId)).for("share");
  // a role assigned after the roles were locked is not counted (stricter, never wider)
  const roleIds = [...new Set(assignments.map((r) => r.roleId))].filter((r) => lockedRoleIds.has(r));
  const byRole = roleIds.length > 0;
  return {
    roleIds,
    tools: [
      ...(await tx.select({ serverId: toolGrants.serverId, toolName: toolGrants.toolName }).from(toolGrants).where(eq(toolGrants.userId, userId)).for("share")),
      ...(byRole ? await tx.select({ serverId: roleToolGrants.serverId, toolName: roleToolGrants.toolName }).from(roleToolGrants).where(inArray(roleToolGrants.roleId, roleIds)).for("share") : []),
    ],
    servers: [
      ...(await tx.select({ serverId: serverGrants.serverId, readOnlyAll: serverGrants.readOnlyAll }).from(serverGrants).where(eq(serverGrants.userId, userId)).for("share")),
      ...(byRole ? await tx.select({ serverId: roleServerGrants.serverId, readOnlyAll: roleServerGrants.readOnlyAll }).from(roleServerGrants).where(inArray(roleServerGrants.roleId, roleIds)).for("share") : []),
    ],
    agents: [
      ...(await tx.select({ agentId: agentGrants.agentId, modes: agentGrants.allowedModes }).from(agentGrants).where(eq(agentGrants.userId, userId)).for("share")),
      ...(byRole ? await tx.select({ agentId: roleAgentGrants.agentId, modes: roleAgentGrants.allowedModes }).from(roleAgentGrants).where(inArray(roleAgentGrants.roleId, roleIds)).for("share") : []),
    ],
    connectors: [
      ...(await tx.select({ connectorId: connectorGrants.connectorId, mode: connectorGrants.mode, objects: connectorGrants.allowedObjects }).from(connectorGrants).where(eq(connectorGrants.userId, userId)).for("share")),
      ...(byRole
        ? await tx.select({ connectorId: roleConnectorGrants.connectorId, mode: roleConnectorGrants.mode, objects: roleConnectorGrants.allowedObjects }).from(roleConnectorGrants).where(inArray(roleConnectorGrants.roleId, roleIds)).for("share")
        : []),
    ],
    toolRevocations: await tx.select({ serverId: revocations.serverId, toolName: revocations.toolName }).from(revocations).where(eq(revocations.userId, userId)).for("share"),
    agentRevocations: await tx.select({ agentId: agentRevocations.agentId }).from(agentRevocations).where(eq(agentRevocations.userId, userId)).for("share"),
    connectorRevocations: await tx.select({ connectorId: connectorRevocations.connectorId }).from(connectorRevocations).where(eq(connectorRevocations.userId, userId)).for("share"),
  };
}

/** everything a role bundles, read `FOR SHARE` (the role's own row is already locked by the caller) */
async function roleItems(tx: Db, roleId: string) {
  return {
    tools: await tx.select({ serverId: roleToolGrants.serverId, toolName: roleToolGrants.toolName }).from(roleToolGrants).where(eq(roleToolGrants.roleId, roleId)).for("share"),
    servers: await tx.select({ serverId: roleServerGrants.serverId }).from(roleServerGrants).where(eq(roleServerGrants.roleId, roleId)).for("share"),
    agents: await tx.select({ agentId: roleAgentGrants.agentId }).from(roleAgentGrants).where(eq(roleAgentGrants.roleId, roleId)).for("share"),
    connectors: await tx.select({ connectorId: roleConnectorGrants.connectorId }).from(roleConnectorGrants).where(eq(roleConnectorGrants.roleId, roleId)).for("share"),
  };
}

/**
 * S4 amendment 1 (N1): the first item of `set` that NONE of `stewards` holds (a label), or null. A steward holds
 * an item when one of their own grants, direct or through a role, reaches it and their revocations do not take it
 * away. The subtraction mirrors `sponsorGrantsMiss`. A whole-server revocation (`tool_name IS NULL`) takes every
 * tool and the server grant; a tool revocation takes that tool; an agent or connector revocation takes the target
 * whether it was granted directly or through a role. The rules per item:
 * - a tool: a tool grant, or a read-only-all server grant for a read tool;
 * - an agent: in every listed mode;
 * - a connector: in its mode and for every listed object, by ONE grant;
 * - a server: a server grant, read-only-all when the item asks for it;
 * - a role (S4+S5 follow-up, review L3): assigned to the steward AND none of what the role bundles is revoked for
 *   that steward. A tool revocation (or a whole-server one) on a role tool, a whole-server revocation on a role
 *   server (the same rule as a server item), an agent revocation on a role agent, or a connector revocation on a
 *   role connector each mean that steward does not hold the whole role.
 * A disabled or unknown steward holds nothing; the system principal is no person and holds nothing.
 *
 * Locking (review L5 and the force role-delete deadlock): the stewards' `users` rows `FOR SHARE` in id order
 * first (the serialization point with `lockPersonForRevocation`), then every role the check may read through
 * `FOR SHARE` in id order, and only then the grant, assignment and revocation rows. `DELETE /v1/roles/:id` locks
 * the role's row before it cascades, so the two meet on the role row first and wait instead of deadlocking (40P01).
 * Must run inside the caller's transaction.
 */
export async function firstItemNoStewardHolds(tx: Db, stewardIds: readonly string[], set: PutAgentGrants): Promise<string | null> {
  const live = stewardIds.length
    ? (await tx.select({ id: users.id }).from(users).where(and(inArray(users.id, [...stewardIds]), isNull(users.disabledAt))).orderBy(asc(users.id)).for("share")).map((r) => r.id)
    : [];
  // the roles this check may read through: the stewards' assignments (read unlocked here, re-read locked below)
  // and the roles being granted; their own rows are locked before any row that cascades from them
  const assigned = live.length ? await tx.select({ roleId: roleAssignments.roleId }).from(roleAssignments).where(inArray(roleAssignments.userId, live)) : [];
  const toLock = [...new Set([...assigned.map((a) => a.roleId), ...set.roleIds])];
  const lockedRoles = new Set(
    toLock.length ? (await tx.select({ id: roles.id }).from(roles).where(inArray(roles.id, toLock)).orderBy(asc(roles.id)).for("share")).map((r) => r.id) : [],
  );
  const held: Array<Awaited<ReturnType<typeof stewardHoldings>>> = [];
  for (const s of live) held.push(await stewardHoldings(tx, s, lockedRoles));
  const bundles = new Map<string, Awaited<ReturnType<typeof roleItems>>>();
  for (const r of set.roleIds) if (lockedRoles.has(r)) bundles.set(r, await roleItems(tx, r));
  await stewardCheckTestHooks.afterStewardReads?.();
  const toolKinds = new Map<string, string>();
  for (const t of set.tools) {
    const [row] = await tx.select({ kind: mcpTools.kind }).from(mcpTools).where(and(eq(mcpTools.serverId, t.serverId), eq(mcpTools.name, t.toolName)));
    toolKinds.set(`${t.serverId}\u0000${t.toolName}`, row?.kind === "read" ? "read" : "write");
  }
  const modesAllow = (m: unknown, mode: string) => m === null || m === undefined || (Array.isArray(m) && m.includes(mode));
  const serverRevoked = (h: Awaited<ReturnType<typeof stewardHoldings>>, serverId: string) => h.toolRevocations.some((r) => r.serverId === serverId && r.toolName === null);
  for (const t of set.tools) {
    const read = toolKinds.get(`${t.serverId}\u0000${t.toolName}`) === "read";
    const ok = held.some(
      (h) =>
        !h.toolRevocations.some((r) => r.serverId === t.serverId && (r.toolName === null || r.toolName === t.toolName)) &&
        (h.tools.some((g) => g.serverId === t.serverId && g.toolName === t.toolName) || (read && h.servers.some((g) => g.serverId === t.serverId && g.readOnlyAll))),
    );
    if (!ok) return `tool ${t.serverId}/${t.toolName}`;
  }
  for (const a of set.agents) {
    for (const mode of a.allowedModes) {
      const ok = held.some((h) => !h.agentRevocations.some((r) => r.agentId === a.agentId) && h.agents.some((g) => g.agentId === a.agentId && modesAllow(g.modes, mode)));
      if (!ok) return `agent ${a.agentId} mode ${mode}`;
    }
  }
  for (const v of set.servers) {
    const ok = held.some((h) => !serverRevoked(h, v.serverId) && h.servers.some((g) => g.serverId === v.serverId && (!v.readOnlyAll || g.readOnlyAll)));
    if (!ok) return `server ${v.serverId}${v.readOnlyAll ? " (read-only all)" : ""}`;
  }
  for (const c of set.connectors) {
    const ok = held.some(
      (h) =>
        !h.connectorRevocations.some((r) => r.connectorId === c.connectorId) &&
        // one grant must cover the mode AND every object (grants are candidates, never merged)
        h.connectors.some(
          (g) =>
            g.connectorId === c.connectorId &&
            (c.mode === "read" || g.mode === "readwrite") &&
            (g.objects == null || c.allowedObjects.every((o) => (g.objects as string[]).includes(o))),
        ),
    );
    if (!ok) return `connector ${c.connectorId} (${c.mode})`;
  }
  for (const r of set.roleIds) {
    const bundle = bundles.get(r);
    // a role deleted while this check waited is held by nobody
    const ok =
      !!bundle &&
      held.some(
        (h) =>
          h.roleIds.includes(r) &&
          !bundle.tools.some((t) => h.toolRevocations.some((rv) => rv.serverId === t.serverId && (rv.toolName === null || rv.toolName === t.toolName))) &&
          !bundle.servers.some((v) => serverRevoked(h, v.serverId)) &&
          !bundle.agents.some((a) => h.agentRevocations.some((rv) => rv.agentId === a.agentId)) &&
          !bundle.connectors.some((c) => h.connectorRevocations.some((rv) => rv.connectorId === c.connectorId)),
      );
    if (!ok) return `role ${r}`;
  }
  return null;
}

/** sort structured entries by their canonical JSON (no string joining, so no delimiter can collide: review L2) */
function sortedCanonical<T>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const x = canonicalJson(a);
    const y = canonicalJson(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** the canonical digest of a grant set: structured entries, inner lists sorted, entries sorted */
export function grantSetDigest(set: Omit<PutAgentGrants, "revision">): string {
  return sha256Hex(
    canonicalJson({
      tools: sortedCanonical(set.tools.map((t) => ({ serverId: t.serverId, toolName: t.toolName }))),
      servers: sortedCanonical(set.servers.map((v) => ({ serverId: v.serverId, readOnlyAll: v.readOnlyAll }))),
      agents: sortedCanonical(set.agents.map((a) => ({ agentId: a.agentId, allowedModes: [...a.allowedModes].sort() }))),
      connectors: sortedCanonical(set.connectors.map((c) => ({ connectorId: c.connectorId, mode: c.mode, allowedObjects: [...c.allowedObjects].sort() }))),
      roleIds: [...set.roleIds].sort(),
    }),
  );
}

/**
 * S4 amendment 1 (N2): the step-up for a grant-set replace is bound to the identity, the revision it replaces and
 * the canonical digest of the parsed set, so a step-up given for set A is never good for set B.
 */
export function identityGrantsStepUp(identityId: string, set: PutAgentGrants): StepUpCheckArgs {
  return {
    kind: "identity_manage",
    facts: { op: "identity_grants_replace", identityId, revision: set.revision, grantsDigest: grantSetDigest(set) },
  };
}

/** the step-up for `PATCH /v1/workload-identities/:id`: bound to the identity and exactly this change */
export function identityUpdateStepUp(identityId: string, change: UpdateWorkloadIdentity): StepUpCheckArgs {
  return { kind: "identity_manage", facts: { op: "identity_update", identityId, changeDigest: sha256Hex(canonicalJson(change)) } };
}

/**
 * `PATCH /v1/workload-identities/:identityId` (S4 follow-up): name the stewards, the allowed environments, or
 * suspend / reinstate. Built with N1 because an identity whose only steward is the system principal (an agent
 * with no owner) can be granted nothing until an admin names a person who holds what it needs. Every steward is
 * an existing, enabled user. Audited; revocation stays its own (S6) route and is terminal.
 */
export async function updateWorkloadIdentity(db: Db, identityId: string, body: UpdateWorkloadIdentity, actorUserId: string | null): Promise<WorkloadIdentityView> {
  const change = updateWorkloadIdentitySchema.parse(body);
  const actor = actorUserId ?? SYSTEM_USER_ID;
  // a refusal writes its deny audit row and COMMITS (nothing else is written), then is thrown (review L4)
  const out = await db.transaction(async (tx): Promise<WorkloadIdentityView | IdentityGrantsError> => {
    const refuse = async (err: IdentityGrantsError, extra: Record<string, unknown> = {}) => {
      await tx.insert(auditLog).values({
        userId: actor,
        objectType: "workload_identity",
        objectId: identityId,
        detail: { phase: "update_refused", code: err.code, fields: Object.keys(change), ...extra },
        effect: "deny",
        ruleId: err.code === "grant_exceeds_stewards" ? "grant-exceeds-stewards" : "workload-identity-update-refused",
        ruleChain: [],
        reason: `refused: ${err.message} (ADR-0188 S4 amendment 1)`,
      });
      return err;
    };
    const [ident] = await tx.select().from(workloadIdentities).where(eq(workloadIdentities.id, identityId)).for("update");
    if (!ident) return refuse(new IdentityGrantsError("identity_not_found", 404, `no workload identity ${identityId}`));
    if (ident.status === "revoked") return refuse(new IdentityGrantsError("identity_not_active", 409, `identity ${identityId} is revoked`));
    if (change.sponsorUserIds) {
      const found = await tx.select({ id: users.id }).from(users).where(and(inArray(users.id, change.sponsorUserIds), isNull(users.disabledAt))).orderBy(asc(users.id)).for("share");
      if (found.length !== change.sponsorUserIds.length) {
        const missing = change.sponsorUserIds.filter((id) => !found.some((f) => f.id === id));
        return refuse(new IdentityGrantsError("steward_not_found", 404, "every steward is an existing, enabled user"), { missing });
      }
      // review M1: the identity's CURRENT grant set must still be held by the new stewards. A steward who later
      // loses a grant is bounded at use by the sponsor intersection (decision 3); there is no revocation cascade.
      const current = (await getIdentityGrants(tx as unknown as Db, identityId))!;
      const unheld = await firstItemNoStewardHolds(tx as unknown as Db, change.sponsorUserIds, current);
      if (unheld) {
        return refuse(new IdentityGrantsError("grant_exceeds_stewards", 422, `no proposed steward of this identity holds ${unheld}`), {
          item: unheld,
          stewards: change.sponsorUserIds,
        });
      }
    }
    const [row] = await tx
      .update(workloadIdentities)
      .set({
        ...(change.sponsorUserIds ? { sponsorUserIds: change.sponsorUserIds } : {}),
        ...(change.environments ? { environments: change.environments } : {}),
        ...(change.status ? { status: change.status } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(workloadIdentities.id, identityId))
      .returning();
    await tx.insert(auditLog).values({
      userId: actor,
      objectType: "workload_identity",
      objectId: identityId,
      detail: { phase: "updated", fields: Object.keys(change), before: { sponsorUserIds: ident.sponsorUserIds, environments: ident.environments, status: ident.status }, after: change },
      effect: "allow",
      ruleId: "workload-identity-updated",
      ruleChain: [],
      reason: `workload identity ${identityId} updated (${Object.keys(change).join(", ")})`,
    });
    return view(row!);
  });
  if (out instanceof IdentityGrantsError) throw out;
  return out;
}

/** list identities, keyset-paginated by id */
export async function listWorkloadIdentities(db: Db, q: z.infer<typeof listWorkloadIdentitiesQuerySchema>): Promise<WorkloadIdentityListView> {
  const limit = q.limit ?? 50;
  const conds = [
    q.kind ? eq(workloadIdentities.kind, q.kind) : undefined,
    q.status ? eq(workloadIdentities.status, q.status) : undefined,
    q.sponsorUserId ? sql`${q.sponsorUserId}::uuid = ANY (${workloadIdentities.sponsorUserIds})` : undefined,
    q.cursor ? gt(workloadIdentities.id, q.cursor) : undefined,
  ].filter((c) => c !== undefined);
  const rows = await db
    .select()
    .from(workloadIdentities)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(workloadIdentities.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return { items: page.map(view), nextCursor: rows.length > limit ? page[page.length - 1]!.id : null };
}

export async function getWorkloadIdentity(db: Db, identityId: string): Promise<WorkloadIdentityDetailView | null> {
  const [r] = await db.select().from(workloadIdentities).where(eq(workloadIdentities.id, identityId));
  if (!r) return null;
  // the database clock (S4 review L3), never the gateway's
  const [[creds], [live]] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(workloadCredentials)
      .where(and(eq(workloadCredentials.identityId, identityId), isNull(workloadCredentials.revokedAt), sql`${workloadCredentials.notAfter} > now()`)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(delegationGrants)
      .where(and(eq(delegationGrants.actorIdentityId, identityId), isNull(delegationGrants.revokedAt), sql`${delegationGrants.expiresAt} > now()`)),
  ]);
  return { ...view(r), activeCredentialCount: creds?.n ?? 0, liveDelegationGrantCount: live?.n ?? 0 };
}

/** the route handlers S4 builds (registered by `identity-routes.ts`, which keeps the auth classes and the rest) */
export function workloadIdentityAdminHandlers(db: Db) {
  return {
    list: async (req: FastifyRequest, reply: FastifyReply) => {
      const q = listWorkloadIdentitiesQuerySchema.safeParse(req.query ?? {});
      if (!q.success) return reply.status(400).send({ error: "invalid_query", detail: q.error.issues.map((i) => i.message).join("; ") });
      return reply.send(await listWorkloadIdentities(db, q.data));
    },
    get: async (req: FastifyRequest, reply: FastifyReply) => {
      const { identityId } = idParam.parse(req.params);
      const out = await getWorkloadIdentity(db, identityId);
      return out ? reply.send(out) : reply.status(404).send({ error: "identity_not_found" });
    },
    getGrants: async (req: FastifyRequest, reply: FastifyReply) => {
      const { identityId } = idParam.parse(req.params);
      const out = await getIdentityGrants(db, identityId);
      return out ? reply.header("etag", `"${out.revision}"`).send(out) : reply.status(404).send({ error: "identity_not_found" });
    },
    patch: async (req: FastifyRequest, reply: FastifyReply) => {
      const { identityId } = idParam.parse(req.params);
      const parsed = updateWorkloadIdentitySchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      // bound to the identity and exactly this change
      const su = await requireStepUp(db, req, reply, identityUpdateStepUp(identityId, parsed.data));
      if (!su.ok) return reply;
      try {
        return reply.send(await updateWorkloadIdentity(db, identityId, parsed.data, req.authCtx.userId ?? SYSTEM_USER_ID));
      } catch (err) {
        if (!(err instanceof IdentityGrantsError)) throw err;
        return reply.status(err.status).send({ error: err.code, detail: err.message });
      }
    },
    putGrants: async (req: FastifyRequest, reply: FastifyReply) => {
      const { identityId } = idParam.parse(req.params);
      const parsed = putAgentGrantsSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      const ifMatch = req.headers["if-match"];
      if (typeof ifMatch === "string" && ifMatch.replace(/"/g, "").trim() !== String(parsed.data.revision)) {
        return reply.status(409).send({ error: GRANTS_REVISION_CONFLICT, detail: "If-Match and revision disagree" });
      }
      const su = await requireStepUp(db, req, reply, identityGrantsStepUp(identityId, parsed.data));
      if (!su.ok) return reply;
      try {
        const out = await putIdentityGrants(db, identityId, parsed.data, req.authCtx.userId ?? SYSTEM_USER_ID);
        return reply.header("etag", `"${out.revision}"`).send(out);
      } catch (err) {
        if (!(err instanceof IdentityGrantsError)) throw err;
        return reply.status(err.status).send({
          error: err.code,
          detail: err.message,
          ...(err.currentRevision !== undefined ? { currentRevision: err.currentRevision } : {}),
        });
      }
    },
  };
}
