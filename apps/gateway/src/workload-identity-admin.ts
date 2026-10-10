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
  agents,
  and,
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
  GRANTS_REVISION_CONFLICT,
  listWorkloadIdentitiesQuerySchema,
  putAgentGrantsSchema,
  type AgentGrantsView,
  type PutAgentGrants,
  type WorkloadIdentityDetailView,
  type WorkloadIdentityListView,
  type WorkloadIdentityView,
} from "@regulait/shared";
import { requireStepUp } from "./step-up.js";

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
    readonly code: "identity_not_found" | "identity_not_active" | typeof GRANTS_REVISION_CONFLICT | "grant_target_not_found",
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
  return db.transaction(async (tx) => {
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
    await tx.update(workloadIdentities).set({ grantsRevision: revision, updatedAt: new Date() }).where(eq(workloadIdentities.id, identityId));
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
  const now = new Date();
  const [[creds], [live]] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(workloadCredentials)
      .where(and(eq(workloadCredentials.identityId, identityId), isNull(workloadCredentials.revokedAt), gt(workloadCredentials.notAfter, now))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(delegationGrants)
      .where(and(eq(delegationGrants.actorIdentityId, identityId), isNull(delegationGrants.revokedAt), gt(delegationGrants.expiresAt, now))),
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
    putGrants: async (req: FastifyRequest, reply: FastifyReply) => {
      const { identityId } = idParam.parse(req.params);
      const parsed = putAgentGrantsSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      const ifMatch = req.headers["if-match"];
      if (typeof ifMatch === "string" && ifMatch.replace(/"/g, "").trim() !== String(parsed.data.revision)) {
        return reply.status(409).send({ error: GRANTS_REVISION_CONFLICT, detail: "If-Match and revision disagree" });
      }
      const su = await requireStepUp(db, req, reply, { kind: "identity_manage", facts: { op: "identity_grants_replace", identityId } });
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
