/**
 * ADR-0365 (lane E46, slice 1): the live context graph's routes.
 *
 * Admin-only (absent from NON_ADMIN_ROUTES): bind a PM connection to a project (a `settings_relax` step-up: it lets that
 * project's members see the connection's work-item linkage), rebind it (same step-up; the nodes are re-scoped in the
 * same transaction), unbind it, list the bindings, and run a sync. Every change is audited.
 *
 * Slice 3, admin-only too: bind a discovery repo source as a git source (a `settings_relax` step-up), unbind it, map a
 * repository to a project (the same step-up; a remap re-scopes that repository's nodes in the same transaction) or
 * unmap it (its facts and nodes go), list both, and run a git sync. Strict default: an unmapped repository is never
 * read into the graph.
 *
 * Any signed-in principal (in NON_ADMIN_ROUTES): list readable nodes, read one, read its neighbourhood. Every result is
 * filtered by the caller's own project memberships through `nodeReadable` (the same rule row-level security
 * enforces); a node the caller cannot read is a 404, exactly like a missing one.
 */
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  and,
  asc,
  auditLog,
  contextGraphGitRepoMappings,
  contextGraphGitRepositories,
  contextGraphGitSources,
  contextGraphSources,
  discoveryCredentials,
  discoverySources,
  eq,
  gt,
  isNull,
  pmConnections,
  projects,
  runAsPrincipalStepIfScoped,
  sql,
  type Db,
} from "@regulait/db";
import { discoveryWriteScopeFinal } from "@regulait/shared";
import { repoScopeProblem } from "./discovery-repo-scanner.js";
import { isRepoSourceKind, rescopeGitNodes, syncContextGraphGitSource, type ContextGraphGitDeps } from "./context-graph-git.js";
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
const nodesQuery = z
  .object({ kind: z.enum(["pm_project", "pm_work_item", "orchestration_run", "git_repository", "git_pull_request"]).optional(), sourceId: z.string().uuid().optional(), ...page })
  .strict();
const neighboursQuery = z.object({ depth: z.coerce.number().int().min(1).max(CONTEXT_GRAPH_MAX_DEPTH).default(1) }).strict();
const bindBody = z.object({ pmConnectionId: z.string().uuid(), projectId: z.string().uuid() }).strict();
const rebindBody = z.object({ projectId: z.string().uuid() }).strict();
const syncBody = z.object({ full: z.boolean().default(false) }).strict();
// slice 3
const gitSourceParam = z.object({ gitSourceId: z.string().uuid() });
const gitBindBody = z.object({ discoverySourceId: z.string().uuid() }).strict();
const repoName = z.string().trim().min(3).max(1024);
const mappingBody = z.object({ fullName: repoName, projectId: z.string().uuid() }).strict();
const unmapQuery = z.object({ fullName: repoName }).strict();
const mappingsQuery = z.object({ after: z.string().max(1024).optional(), limit: page.limit }).strict();
const gitSyncBody = z.object({}).strict();

export function registerContextGraphRoutes(app: FastifyInstance, db: Db, opts: { git?: ContextGraphGitDeps } = {}): void {
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

  // ---- admin: git sources (slice 3) ---------------------------------------------------------------------------------
  const gitAudit = (t: Db, req: FastifyRequest, gitSourceId: string, ruleId: string, detail: Record<string, unknown>, reason: string) =>
    t.insert(auditLog).values({ userId: actor(req), objectType: "context_graph_git_source", objectId: gitSourceId, detail: { subsystem: "context-graph", ...detail }, effect: "allow", ruleId, ruleChain: [], reason });

  app.get("/v1/context-graph/git-sources", async (req, reply) => {
    const q = sourcesQuery.safeParse(req.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    const rows = await db
      .select({
        id: contextGraphGitSources.id,
        discoverySourceId: contextGraphGitSources.discoverySourceId,
        discoverySourceName: discoverySources.name,
        kind: discoverySources.kind,
        boundByUserId: contextGraphGitSources.boundByUserId,
        boundAt: contextGraphGitSources.boundAt,
        lastSyncedAt: contextGraphGitSources.lastSyncedAt,
        mappedRepositories: sql<number>`(SELECT count(*)::int FROM context_graph_git_repo_mappings m WHERE m.git_source_id = ${contextGraphGitSources.id})`,
      })
      .from(contextGraphGitSources)
      .innerJoin(discoverySources, eq(discoverySources.id, contextGraphGitSources.discoverySourceId))
      .where(q.data.after ? gt(contextGraphGitSources.id, q.data.after) : undefined)
      .orderBy(asc(contextGraphGitSources.id))
      .limit(q.data.limit + 1);
    const items = rows.slice(0, q.data.limit);
    return { items, nextAfter: rows.length > q.data.limit ? items[items.length - 1]!.id : null };
  });

  // binding lets the graph read the source's repositories, but only those an admin then maps (strict default); a
  // relax all the same (it puts the source's credential to a second use), so the settings step-up
  app.post("/v1/context-graph/git-sources", async (req, reply) => {
    const b = gitBindBody.safeParse(req.body ?? {});
    if (!b.success) return badRequest(reply, b.error);
    const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { op: "context_graph_git_source_bind", discoverySourceId: b.data.discoverySourceId } });
    if (!su.ok) return reply;
    try {
      const out = await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        const [src] = await t.select({ id: discoverySources.id, kind: discoverySources.kind, name: discoverySources.name }).from(discoverySources).where(eq(discoverySources.id, b.data.discoverySourceId));
        if (!src) return { ok: false as const, status: 404 as const, error: "discovery_source_not_found", detail: "no such discovery source" };
        if (!isRepoSourceKind(src.kind)) return { ok: false as const, status: 409 as const, error: "not_a_repository_source", detail: "only a repository discovery source (GitHub, GitLab, Bitbucket, Azure DevOps) can be bound" };
        const [cred] = await t.select({ writeScope: discoveryCredentials.writeScope }).from(discoveryCredentials).where(and(eq(discoveryCredentials.sourceId, src.id), isNull(discoveryCredentials.revokedAt)));
        if (cred && discoveryWriteScopeFinal(cred.writeScope)) {
          return { ok: false as const, status: 409 as const, error: "credential_refused", detail: "the source's credential was found to grant write access and is refused; replace it first" };
        }
        const [row] = await t.insert(contextGraphGitSources).values({ discoverySourceId: src.id, boundByUserId: req.authCtx.userId ?? null }).returning();
        await gitAudit(t, req, row!.id, "context-graph-git-source-bound", { discoverySourceId: src.id, kind: src.kind, stepUp: su.method },
          `discovery source '${src.name}' bound to the context graph as a git source; no repository is read until one is mapped to a project`);
        return { ok: true as const, source: row! };
      });
      if (!out.ok) return reply.status(out.status).send({ error: out.error, detail: out.detail });
      return reply.status(201).send(out.source);
    } catch (e) {
      if (isUniqueViolation(e)) return reply.status(409).send({ error: "already_bound", detail: "that discovery source is already bound to the context graph" });
      throw e;
    }
  });

  // unbinding removes the mappings, facts, nodes, edges and scopes (cascade: source, mapping, fact, node); the discovery
  // source is untouched
  app.delete("/v1/context-graph/git-sources/:gitSourceId", async (req, reply) => {
    const p = gitSourceParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const removed = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [row] = await t.delete(contextGraphGitSources).where(eq(contextGraphGitSources.id, p.data.gitSourceId)).returning();
      if (!row) return null;
      await gitAudit(t, req, row.id, "context-graph-git-source-unbound", { discoverySourceId: row.discoverySourceId },
        `context graph git source ${row.id} unbound; its mappings, repositories, pull requests, nodes, edges and scopes were removed`);
      return row;
    });
    if (!removed) return reply.status(404).send({ error: "git_source_not_found", detail: "no such context graph git source" });
    return reply.status(204).send();
  });

  app.get("/v1/context-graph/git-sources/:gitSourceId/repositories", async (req, reply) => {
    const p = gitSourceParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const q = mappingsQuery.safeParse(req.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    const [gs] = await db.select({ id: contextGraphGitSources.id }).from(contextGraphGitSources).where(eq(contextGraphGitSources.id, p.data.gitSourceId));
    if (!gs) return reply.status(404).send({ error: "git_source_not_found", detail: "no such context graph git source" });
    const rows = await db
      .select({
        fullName: contextGraphGitRepoMappings.fullName,
        projectId: contextGraphGitRepoMappings.projectId,
        projectName: projects.name,
        mappedByUserId: contextGraphGitRepoMappings.mappedByUserId,
        mappedAt: contextGraphGitRepoMappings.mappedAt,
        lastSeenAt: contextGraphGitRepositories.lastSeenAt,
        missingSince: contextGraphGitRepositories.missingSince,
      })
      .from(contextGraphGitRepoMappings)
      .innerJoin(projects, eq(projects.id, contextGraphGitRepoMappings.projectId))
      .leftJoin(
        contextGraphGitRepositories,
        and(eq(contextGraphGitRepositories.gitSourceId, contextGraphGitRepoMappings.gitSourceId), eq(contextGraphGitRepositories.fullName, contextGraphGitRepoMappings.fullName)),
      )
      .where(and(eq(contextGraphGitRepoMappings.gitSourceId, gs.id), q.data.after ? gt(contextGraphGitRepoMappings.fullName, q.data.after) : undefined))
      .orderBy(asc(contextGraphGitRepoMappings.fullName))
      .limit(q.data.limit + 1);
    const items = rows.slice(0, q.data.limit);
    return { items, nextAfter: rows.length > q.data.limit ? items[items.length - 1]!.fullName : null };
  });

  // map (or remap) one repository to a project: a relax for that project's members, so the settings step-up. A remap
  // re-scopes the repository's nodes in the same transaction, so the old project's members lose sight at once.
  app.put("/v1/context-graph/git-sources/:gitSourceId/repositories", async (req, reply) => {
    const p = gitSourceParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const b = mappingBody.safeParse(req.body ?? {});
    if (!b.success) return badRequest(reply, b.error);
    const su = await requireStepUp(db, req, reply, {
      kind: "settings_relax",
      facts: { op: "context_graph_git_repository_map", gitSourceId: p.data.gitSourceId, fullName: b.data.fullName, projectId: b.data.projectId },
    });
    if (!su.ok) return reply;
    const out = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [gs] = await t
        .select({ id: contextGraphGitSources.id, kind: discoverySources.kind, scope: discoverySources.scope })
        .from(contextGraphGitSources)
        .innerJoin(discoverySources, eq(discoverySources.id, contextGraphGitSources.discoverySourceId))
        .where(eq(contextGraphGitSources.id, p.data.gitSourceId))
        .for("update", { of: contextGraphGitSources });
      if (!gs) return { ok: false as const, status: 404 as const, error: "git_source_not_found", detail: "no such context graph git source" };
      const shape = repoScopeProblem(gs.kind, { orgLevel: false, include: [b.data.fullName] });
      if (shape) return { ok: false as const, status: 400 as const, error: "invalid_request", detail: shape };
      // a repo-level discovery source reads only the repositories it names: a mapping outside them would never sync
      if (gs.scope.orgLevel !== true && !(gs.scope.include ?? []).some((r) => r.trim().toLowerCase() === b.data.fullName.toLowerCase())) {
        return { ok: false as const, status: 409 as const, error: "repository_out_of_scope", detail: "the discovery source's scope does not name that repository" };
      }
      const bad = await projectProblem(t, b.data.projectId);
      if (bad) return { ok: false as const, ...bad };
      const [prev] = await t
        .select()
        .from(contextGraphGitRepoMappings)
        .where(and(eq(contextGraphGitRepoMappings.gitSourceId, gs.id), sql`lower(${contextGraphGitRepoMappings.fullName}) = lower(${b.data.fullName})`))
        .for("update");
      let row;
      if (prev) {
        [row] = await t
          .update(contextGraphGitRepoMappings)
          .set({ projectId: b.data.projectId, mappedByUserId: req.authCtx.userId ?? null, mappedAt: sql`now()` })
          .where(and(eq(contextGraphGitRepoMappings.gitSourceId, gs.id), eq(contextGraphGitRepoMappings.fullName, prev.fullName)))
          .returning();
      } else {
        [row] = await t.insert(contextGraphGitRepoMappings).values({ gitSourceId: gs.id, fullName: b.data.fullName, projectId: b.data.projectId, mappedByUserId: req.authCtx.userId ?? null }).returning();
      }
      const scoped = await rescopeGitNodes(t, gs.id, row!.fullName);
      await gitAudit(t, req, gs.id, prev ? "context-graph-git-repository-remapped" : "context-graph-git-repository-mapped",
        { fullName: row!.fullName, from: prev?.projectId ?? null, to: b.data.projectId, removedScopes: scoped.removed, stepUp: su.method },
        prev
          ? `repository ${row!.fullName} of git source ${gs.id} moved from project ${prev.projectId} to ${b.data.projectId}; ${scoped.removed} scope row(s) removed`
          : `repository ${row!.fullName} of git source ${gs.id} mapped to project ${b.data.projectId}; its members may read it and its pull requests after the next sync`);
      return { ok: true as const, mapping: row!, created: !prev };
    });
    if (!out.ok) return reply.status(out.status).send({ error: out.error, detail: out.detail });
    return reply.status(out.created ? 201 : 200).send(out.mapping);
  });

  // unmapping removes the repository's facts, nodes, edges and scopes (cascade: mapping, fact, node)
  app.delete("/v1/context-graph/git-sources/:gitSourceId/repositories", async (req, reply) => {
    const p = gitSourceParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const q = unmapQuery.safeParse(req.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    const removed = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const match = and(eq(contextGraphGitRepoMappings.gitSourceId, p.data.gitSourceId), sql`lower(${contextGraphGitRepoMappings.fullName}) = lower(${q.data.fullName})`);
      const [m] = await t.select().from(contextGraphGitRepoMappings).where(match).for("update");
      if (!m) return null;
      await t.delete(contextGraphGitRepoMappings).where(and(eq(contextGraphGitRepoMappings.gitSourceId, m.gitSourceId), eq(contextGraphGitRepoMappings.fullName, m.fullName)));
      await gitAudit(t, req, m.gitSourceId, "context-graph-git-repository-unmapped", { fullName: m.fullName, projectId: m.projectId },
        `repository ${m.fullName} of git source ${m.gitSourceId} unmapped from project ${m.projectId}; its facts, nodes and scopes were removed`);
      return m;
    });
    if (!removed) return reply.status(404).send({ error: "mapping_not_found", detail: "that repository is not mapped" });
    return reply.status(204).send();
  });

  app.post("/v1/context-graph/git-sources/:gitSourceId/sync", async (req, reply) => {
    const p = gitSourceParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const b = gitSyncBody.safeParse(req.body ?? {});
    if (!b.success) return badRequest(reply, b.error);
    const out = await syncContextGraphGitSource(db, { gitSourceId: p.data.gitSourceId, actorUserId: actor(req), ...(opts.git ? { deps: opts.git } : {}) });
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

