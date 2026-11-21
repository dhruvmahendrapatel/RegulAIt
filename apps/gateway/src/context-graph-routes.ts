/**
 * ADR-0365 (lane E46, slice 1): the live context graph's routes.
 *
 * Admin-only (absent from NON_ADMIN_ROUTES): bind a PM connection to a project (a `settings_relax` step-up: it lets that
 * project's members see the connection's work-item linkage), rebind it (same step-up; the nodes are re-scoped in the
 * same transaction), unbind it, list the bindings, and run a sync. Every change is audited.
 *
 * Any signed-in principal (in NON_ADMIN_ROUTES): list readable nodes, read one, read its neighbourhood. Every result is
 * filtered by the caller's own project memberships through `nodeReadable` (the same rule row-level security
 * enforces); a node the caller cannot read is a 404, exactly like a missing one.
 */
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { asc, auditLog, contextGraphSources, eq, gt, pmConnections, projects, runAsPrincipalStepIfScoped, type Db } from "@regulait/db";
import {
  CONTEXT_GRAPH_MAX_DEPTH,
  readableNeighbourhood,
  readableNode,
  listReadableNodes,
  rescopeContextGraphSource,
  syncContextGraphSource,
  type GraphCaller,
} from "./context-graph.js";
import { requireStepUp } from "./step-up.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const MAX_PAGE = 200;
const isUniqueViolation = (e: unknown): boolean => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === "23505" || err?.cause?.code === "23505";
};

const sourceParam = z.object({ sourceId: z.string().uuid() });
const nodeParam = z.object({ nodeId: z.string().uuid() });
const page = { after: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(50) };
const sourcesQuery = z.object(page).strict();
const nodesQuery = z.object({ kind: z.enum(["pm_project", "pm_work_item"]).optional(), sourceId: z.string().uuid().optional(), ...page }).strict();
const neighboursQuery = z.object({ depth: z.coerce.number().int().min(1).max(CONTEXT_GRAPH_MAX_DEPTH).default(1) }).strict();
const bindBody = z.object({ pmConnectionId: z.string().uuid(), projectId: z.string().uuid() }).strict();
const rebindBody = z.object({ projectId: z.string().uuid() }).strict();
const syncBody = z.object({ full: z.boolean().default(false) }).strict();

export function registerContextGraphRoutes(app: FastifyInstance, db: Db): void {
  const actor = (req: FastifyRequest) => req.authCtx.userId ?? NIL_UUID;
  const caller = (req: FastifyRequest): GraphCaller => ({ userId: req.authCtx.userId ?? null, isAdmin: req.authCtx.isAdmin });
  const badRequest = (reply: FastifyReply, err: z.ZodError) =>
    reply.status(400).send({ error: "invalid_request", detail: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
  // a project to bind to: it exists and is not archived (an archived project takes no new context, ADR-0206 G1)
  const projectProblem = async (t: Db, id: string) => {
    const [p] = await t.select({ archivedAt: projects.archivedAt }).from(projects).where(eq(projects.id, id));
    if (!p) return { status: 404 as const, error: "project_not_found", detail: "no such project" };
    if (p.archivedAt) return { status: 409 as const, error: "project_archived", detail: "an archived project cannot be bound to a context graph source" };
    return null;
  };
  const audit = (t: Db, req: FastifyRequest, sourceId: string, ruleId: string, detail: Record<string, unknown>, reason: string) =>
    t.insert(auditLog).values({ userId: actor(req), objectType: "context_graph_source", objectId: sourceId, detail: { subsystem: "context-graph", ...detail }, effect: "allow", ruleId, ruleChain: [], reason });

  // ---- admin: bindings and sync -------------------------------------------------------------------------------------

  app.get("/v1/context-graph/sources", async (req, reply) => {
    const q = sourcesQuery.safeParse(req.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    const rows = await db
      .select({
        id: contextGraphSources.id,
        pmConnectionId: contextGraphSources.pmConnectionId,
        pmConnectionName: pmConnections.name,
        provider: pmConnections.provider,
        projectId: contextGraphSources.projectId,
        projectName: projects.name,
        boundByUserId: contextGraphSources.boundByUserId,
        boundAt: contextGraphSources.boundAt,
        lastSyncedAt: contextGraphSources.lastSyncedAt,
      })
      .from(contextGraphSources)
      .innerJoin(pmConnections, eq(pmConnections.id, contextGraphSources.pmConnectionId))
      .innerJoin(projects, eq(projects.id, contextGraphSources.projectId))
      .where(q.data.after ? gt(contextGraphSources.id, q.data.after) : undefined)
      .orderBy(asc(contextGraphSources.id))
      .limit(q.data.limit + 1);
    const items = rows.slice(0, q.data.limit);
    return { items, nextAfter: rows.length > q.data.limit ? items[items.length - 1]!.id : null };
  });

  app.post("/v1/context-graph/sources", async (req, reply) => {
    const b = bindBody.safeParse(req.body ?? {});
    if (!b.success) return badRequest(reply, b.error);
    const su = await requireStepUp(db, req, reply, {
      kind: "settings_relax",
      facts: { op: "context_graph_source_bind", pmConnectionId: b.data.pmConnectionId, projectId: b.data.projectId },
    });
    if (!su.ok) return reply;
    try {
      const out = await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        const [conn] = await t.select({ id: pmConnections.id }).from(pmConnections).where(eq(pmConnections.id, b.data.pmConnectionId));
        if (!conn) return { ok: false as const, status: 404 as const, error: "pm_connection_not_found", detail: "no such PM connection" };
        const bad = await projectProblem(t, b.data.projectId);
        if (bad) return { ok: false as const, ...bad };
        const [row] = await t
          .insert(contextGraphSources)
          .values({ pmConnectionId: b.data.pmConnectionId, projectId: b.data.projectId, boundByUserId: req.authCtx.userId ?? null })
          .returning();
        await audit(t, req, row!.id, "context-graph-source-bound", { pmConnectionId: row!.pmConnectionId, projectId: row!.projectId, stepUp: su.method },
          `PM connection ${row!.pmConnectionId} bound to the context graph; members of project ${row!.projectId} may read its work-item linkage`);
        return { ok: true as const, source: row! };
      });
      if (!out.ok) return reply.status(out.status).send({ error: out.error, detail: out.detail });
      return reply.status(201).send(out.source);
    } catch (e) {
      if (isUniqueViolation(e)) return reply.status(409).send({ error: "already_bound", detail: "that PM connection is already bound to the context graph" });
      throw e;
    }
  });

  // rebind to another project: the nodes are re-scoped in the same transaction, so the old project's members lose
  // sight at once; a relax for the new project's members, so the same step-up
  app.patch("/v1/context-graph/sources/:sourceId", async (req, reply) => {
    const p = sourceParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const b = rebindBody.safeParse(req.body ?? {});
    if (!b.success) return badRequest(reply, b.error);
    const su = await requireStepUp(db, req, reply, {
      kind: "settings_relax",
      facts: { op: "context_graph_source_rebind", sourceId: p.data.sourceId, projectId: b.data.projectId },
    });
    if (!su.ok) return reply;
    const out = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [src] = await t.select().from(contextGraphSources).where(eq(contextGraphSources.id, p.data.sourceId)).for("update");
      if (!src) return { ok: false as const, status: 404 as const, error: "source_not_found", detail: "no such context graph source" };
      const bad = await projectProblem(t, b.data.projectId);
      if (bad) return { ok: false as const, ...bad };
      const [row] = await t.update(contextGraphSources).set({ projectId: b.data.projectId }).where(eq(contextGraphSources.id, src.id)).returning();
      const removedScopes = await rescopeContextGraphSource(t, src.id, b.data.projectId);
      await audit(t, req, src.id, "context-graph-source-rebound", { from: src.projectId, to: b.data.projectId, removedScopes, stepUp: su.method },
        `context graph source ${src.id} moved from project ${src.projectId} to ${b.data.projectId}; ${removedScopes} scope row(s) removed`);
      return { ok: true as const, source: row! };
    });
    if (!out.ok) return reply.status(out.status).send({ error: out.error, detail: out.detail });
    return out.source;
  });

  // unbinding removes the source's nodes, edges and scope rows (cascade); the PM linkage itself is untouched
  app.delete("/v1/context-graph/sources/:sourceId", async (req, reply) => {
    const p = sourceParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const removed = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [row] = await t.delete(contextGraphSources).where(eq(contextGraphSources.id, p.data.sourceId)).returning();
      if (!row) return null;
      await audit(t, req, row.id, "context-graph-source-unbound", { pmConnectionId: row.pmConnectionId, projectId: row.projectId },
        `context graph source ${row.id} unbound; its nodes, edges and scopes were removed`);
      return row;
    });
    if (!removed) return reply.status(404).send({ error: "source_not_found", detail: "no such context graph source" });
    return reply.status(204).send();
  });

  app.post("/v1/context-graph/sources/:sourceId/sync", async (req, reply) => {
    const p = sourceParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const b = syncBody.safeParse(req.body ?? {});
    if (!b.success) return badRequest(reply, b.error);
    const out = await db.transaction((tx) => syncContextGraphSource(tx as unknown as Db, { sourceId: p.data.sourceId, actorUserId: actor(req), full: b.data.full }));
    if (!out.ok) return reply.status(out.status).send({ error: out.error, detail: out.detail });
    const { ok: _ok, ...result } = out;
    return result;
  });

  // ---- any signed-in principal: entitlement-filtered reads ---------------------------------------------------------
  // Each runs as a `context_graph_read` principal step, so the joined facts of a readable node can be selected; the
  // nodes and edges themselves stay under the principal's own readable predicate (in the query and in the policy).
  const graphRead = <R>(fn: () => Promise<R>) => runAsPrincipalStepIfScoped("context_graph_read", "context-graph/read", fn);

  app.get("/v1/context-graph/nodes", async (req, reply) => {
    const q = nodesQuery.safeParse(req.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    return graphRead(() => listReadableNodes(db, caller(req), q.data));
  });

  app.get("/v1/context-graph/nodes/:nodeId", async (req, reply) => {
    const p = nodeParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const node = await graphRead(() => readableNode(db, caller(req), p.data.nodeId));
    if (!node) return reply.status(404).send({ error: "node_not_found", detail: "no such node" });
    return node;
  });

  app.get("/v1/context-graph/nodes/:nodeId/neighbours", async (req, reply) => {
    const p = nodeParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const q = neighboursQuery.safeParse(req.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    const out = await graphRead(() => readableNeighbourhood(db, caller(req), p.data.nodeId, q.data.depth));
    if (!out) return reply.status(404).send({ error: "node_not_found", detail: "no such node" });
    return out;
  });
}

