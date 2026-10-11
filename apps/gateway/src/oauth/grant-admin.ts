/**
 * ADR-0188 (slice S5, carried from S3's review) — THE DELEGATION GRANT ADMIN
 * BACKEND the S6 screens are built against (`DelegationGrantListView`,
 * `DelegationGrantDetailView`, frozen in `@regulait/shared`):
 *
 *   GET  /v1/delegation-grants                 list (filters; `runId` = one run's tree), keyset-paginated,
 *                                              with the parent→child budget edges between the listed grants
 *   GET  /v1/delegation-grants/:grantId        one grant, its incoming edge and its outgoing edges
 *   POST /v1/delegation-grants/:grantId/revoke cascade revoke (S3 `revokeDelegationGrant`, reason `admin`);
 *                                              `identity_manage` step-up; audited by S3 in the same transaction
 *
 * All three are ADMIN-ONLY (the route-class gate). Views carry ids, scope,
 * amounts and lifecycle stamps only: never a thumbprint, credential or token.
 * "live / revoked / expired" is judged on the DATABASE clock.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, delegationAllocations, delegationGrants, desc, eq, inArray, isNull, isNotNull, sql, type Db, type DelegationAllocationRow, type DelegationGrantRow, type SQL } from "@regulait/db";
import {
  listDelegationGrantsQuerySchema,
  revokeDelegationGrantSchema,
  type DelegationAllocationView,
  type DelegationGrantDetailView,
  type DelegationGrantListView,
  type DelegationGrantView,
} from "@regulait/shared";
import { databaseNow, DelegationRefusedError, revokeDelegationGrant } from "../delegation.js";
import { afterCursorDesc, atTextSql, decodeCursor, encodeCursor } from "../pagination.js";
import { requireStepUp } from "../step-up.js";

const grantParam = z.object({ grantId: z.string().uuid() });
const DEFAULT_LIMIT = 50;

export function grantView(g: DelegationGrantRow): DelegationGrantView {
  return {
    id: g.id,
    rootGrantId: g.rootGrantId,
    parentGrantId: g.parentGrantId,
    path: [...g.path],
    depth: g.depth,
    sponsorUserId: g.sponsorUserId,
    actorIdentityId: g.actorIdentityId,
    runId: g.runId,
    builderTurnId: g.builderTurnId,
    engineRunId: g.engineRunId,
    scheduleId: g.scheduleId,
    projectId: g.projectId,
    scope: g.scope as DelegationGrantView["scope"],
    capMicros: g.capMicros,
    settledMicros: g.settledMicros,
    reservedMicros: g.reservedMicros,
    environment: g.environment,
    audience: g.audience,
    bindingKind: g.bindingKind as DelegationGrantView["bindingKind"],
    expiresAt: g.expiresAt.toISOString(),
    revokedAt: g.revokedAt ? g.revokedAt.toISOString() : null,
    revokedReason: (g.revokedReason ?? null) as DelegationGrantView["revokedReason"],
    createdAt: g.createdAt.toISOString(),
  };
}

export function allocationView(a: DelegationAllocationRow): DelegationAllocationView {
  return {
    id: a.id,
    parentGrantId: a.parentGrantId,
    childGrantId: a.childGrantId,
    amountMicros: a.amountMicros,
    drawnMicros: a.drawnMicros,
    releasedMicros: a.releasedMicros,
    status: a.status as DelegationAllocationView["status"],
    createdAt: a.createdAt.toISOString(),
    closedAt: a.closedAt ? a.closedAt.toISOString() : null,
  };
}

export function registerGrantAdminRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/delegation-grants", async (req, reply) => {
    const q = listDelegationGrantsQuerySchema.parse(req.query ?? {});
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    if (q.cursor && !cursor) return reply.status(400).send({ error: "invalid_cursor" });
    const now = await databaseNow(db);
    const at = sql`${now.toISOString()}::timestamptz`;
    const where: SQL[] = [];
    if (q.actorIdentityId) where.push(eq(delegationGrants.actorIdentityId, q.actorIdentityId));
    if (q.sponsorUserId) where.push(eq(delegationGrants.sponsorUserId, q.sponsorUserId));
    if (q.rootGrantId) where.push(eq(delegationGrants.rootGrantId, q.rootGrantId));
    if (q.runId) where.push(eq(delegationGrants.runId, q.runId));
    if (q.status === "revoked") where.push(isNotNull(delegationGrants.revokedAt));
    if (q.status === "live") where.push(and(isNull(delegationGrants.revokedAt), sql`${delegationGrants.expiresAt} > ${at}`)!);
    if (q.status === "expired") where.push(and(isNull(delegationGrants.revokedAt), sql`${delegationGrants.expiresAt} <= ${at}`)!);
    if (cursor) where.push(afterCursorDesc(delegationGrants.createdAt, delegationGrants.id, cursor));
    const limit = q.limit ?? DEFAULT_LIMIT;
    const rows = await db
      .select({ g: delegationGrants, atText: atTextSql(delegationGrants.createdAt) })
      .from(delegationGrants)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(delegationGrants.createdAt), desc(delegationGrants.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const ids = page.map((r) => r.g.id);
    const edges = ids.length
      ? await db
          .select()
          .from(delegationAllocations)
          .where(and(inArray(delegationAllocations.parentGrantId, ids), inArray(delegationAllocations.childGrantId, ids)))
      : [];
    const last = page[page.length - 1];
    const view: DelegationGrantListView = {
      items: page.map((r) => grantView(r.g)),
      edges: edges.map(allocationView),
      nextCursor: hasMore && last ? encodeCursor({ at: last.atText, id: last.g.id }) : null,
    };
    return reply.send(view);
  });

  app.get("/v1/delegation-grants/:grantId", async (req, reply) => {
    const { grantId } = grantParam.parse(req.params);
    const [g] = await db.select().from(delegationGrants).where(eq(delegationGrants.id, grantId));
    if (!g) return reply.status(404).send({ error: "grant_not_found" });
    const [incoming] = await db.select().from(delegationAllocations).where(eq(delegationAllocations.childGrantId, g.id));
    const outgoing = await db.select().from(delegationAllocations).where(eq(delegationAllocations.parentGrantId, g.id));
    const view: DelegationGrantDetailView = { ...grantView(g), allocation: incoming ? allocationView(incoming) : null, childAllocations: outgoing.map(allocationView) };
    return reply.send(view);
  });

  app.post("/v1/delegation-grants/:grantId/revoke", async (req, reply) => {
    const { grantId } = grantParam.parse(req.params);
    revokeDelegationGrantSchema.parse(req.body ?? {});
    const [g] = await db.select({ id: delegationGrants.id }).from(delegationGrants).where(eq(delegationGrants.id, grantId));
    if (!g) return reply.status(404).send({ error: "grant_not_found" });
    const su = await requireStepUp(db, req, reply, { kind: "identity_manage", facts: { op: "delegation_grant_revoke", grantId } });
    if (!su.ok) return reply;
    try {
      const out = await revokeDelegationGrant(db, { grantId, reason: "admin", actorUserId: req.authCtx.userId ?? null });
      return reply.send({ grantId, ...out });
    } catch (e) {
      if (e instanceof DelegationRefusedError) return reply.status(404).send({ error: e.code });
      throw e;
    }
  });
}
