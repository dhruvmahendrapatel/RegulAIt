import Fastify from "fastify";
import {
  and,
  desc,
  eq,
  agentRevocations,
  agents,
  apiKeys,
  approvalRules,
  approvals,
  auditLog,
  connectorRevocations,
  connectors,
  dataScopeRules,
  inArray,
  isNull,
  mcpServers,
  mcpTools,
  orchestrationRuns,
  projectContextItems,
  projects,
  rateLimits,
  revocations,
  roleAgentGrants,
  roleAssignments,
  roleConnectorGrants,
  roleServerGrants,
  roleToolGrants,
  roles,
  serverGrants,
  sql,
  teamMembers,
  teams,
  toolGrants,
  users,
  workflowInstances,
  type Db,
} from "@regulait/db";
import { visibleTools, type ToolRef } from "@regulait/policy-kernel";
import {
  assignRoleSchema,
  createAgentRevocationSchema,
  createApiKeySchema,
  createApprovalRuleSchema,
  createDataScopeRuleSchema,
  createConnectorRevocationSchema,
  createRateLimitSchema,
  createRevocationSchema,
  createRoleAgentGrantSchema,
  createRoleConnectorGrantSchema,
  createRoleSchema,
  createRoleServerGrantSchema,
  createRoleToolGrantSchema,
  createServerGrantSchema,
  createServerSchema,
  createToolGrantSchema,
  createToolSchema,
  createUserSchema,
  decideApprovalSchema,
  evaluateRequestSchema,
} from "@regulait/shared";
import { governedEvaluate } from "./governed-evaluate.js";
import { loadEntitlements } from "./entitlements.js";
import { authenticate, generateToken, type AuthContext } from "./auth.js";

declare module "fastify" {
  interface FastifyRequest {
    authCtx: AuthContext;
  }
}

export interface BuildAppOptions {
  /** deploy-time admin token used to create the first real user + key */
  bootstrapToken?: string;
  /** hex AES-256 key for encrypting stored git tokens (REGULAIT_DATA_KEY) */
  dataKey?: string;
}
import { z } from "zod";
import { registerMcpProxy } from "./mcp-proxy.js";
import { registerAgentConnectorRoutes } from "./agents-connectors.js";
import {
  API_KEY_HEADER_ROUTES,
  interceptionSurfaceEnabled,
  notFoundBody,
  registerInterceptionRoutes,
} from "./compat-core.js";
import { registerAnthropicCompat } from "./compat-anthropic.js";
import { registerOpenAiCompat } from "./compat-openai.js";
import { registerConversationRoutes } from "./conversations.js";
import { applyProjectApprovalDecision, registerProjectRoutes } from "./projects.js";
import { applyInfraApprovalDecision, registerInfraRoutes } from "./infra.js";
import { ADMIN_PORTAL_HTML } from "./admin-portal.js";
import { APP_HTML } from "./app-ui.js";
import { registerOptimizationRoutes } from "./optimization.js";
import { applyRunApprovalDecision, registerOrchestrationRoutes } from "./orchestration.js";
import { registerDecomposeRoutes } from "./decompose.js";
import { mirrorApprovalDecision, registerPmRoutes } from "./pm.js";
import { RunStateError } from "@regulait/orchestration-kernel";
import { applyWorkflowApprovalDecision, registerWorkflowRoutes } from "./workflows.js";
import {
  loadOrgSettings,
  registerOrgSettingsRoutes,
  startAuditPruneScheduler,
} from "./org-settings.js";
import { MergeConflictError, WorkflowStateError } from "@regulait/workflow-kernel";

const uuidParam = z.object({ serverId: z.string().uuid() });
const visibleToolsParams = z.object({
  userId: z.string().uuid(),
  serverId: z.string().uuid(),
});
const auditQuery = z.object({ userId: z.string().uuid().optional() });

export function buildApp(db: Db, opts: BuildAppOptions = {}) {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: "validation", issues: err.issues });
    }
    // Postgres constraint violations surface as DrizzleQueryError wrapping the
    // pg error; map them to client errors instead of a generic 500.
    if (err instanceof WorkflowStateError) {
      return reply.status(409).send({ error: "invalid_workflow_state", detail: err.message });
    }
    if (err instanceof RunStateError) {
      return reply.status(409).send({ error: "invalid_run_state", detail: err.message });
    }
    if (err instanceof MergeConflictError) {
      return reply.status(422).send({ error: "template_merge_conflict", detail: err.message });
    }
    const pgCode = (err as { cause?: { code?: string } }).cause?.code;
    if (pgCode === "23505") return reply.status(409).send({ error: "conflict" });
    if (pgCode === "23503") return reply.status(400).send({ error: "invalid_reference" });
    app.log.error(err);
    if (process.env.DEBUG_ERRORS) console.error("GATEWAY ERR:", err);
    return reply.status(500).send({ error: "internal" });
  });

  app.decorateRequest("authCtx");

  // Every route requires a valid Bearer token (bootstrap or API key) — except
  // the inbound PM webhook (ADR-0010), which is called by external systems and
  // authenticates with its per-connection secret inside the route handler, the
  // two UI shells, and the two unauthenticated entry points a browser or a
  // load balancer hits before it has any credential (/ and /health).
  const AUTH_EXEMPT_ROUTES = new Set([
    "/v1/pm/webhooks/:connectionName",
    "/admin",
    "/app",
    "/",
    "/health",
  ]);
  // ADR-0020 INTERCEPTION GATE. Runs in the onRequest phase — BEFORE auth — so
  // a surface the admin has not enabled answers Fastify's own 404 body and is
  // indistinguishable from a route that was never registered. Doing this after
  // auth would leak the surface's existence via a 401. Only the three
  // interception routes are consulted; every other route short-circuits with no
  // query at all.
  app.addHook("onRequest", async (req, reply) => {
    const route = `${req.method} ${req.routeOptions.url ?? ""}`;
    const enabled = await interceptionSurfaceEnabled(db, route);
    if (enabled === false) {
      return reply.status(404).send(notFoundBody(req.method, req.url));
    }
  });

  app.addHook("preHandler", async (req, reply) => {
    if (AUTH_EXEMPT_ROUTES.has(req.routeOptions.url ?? "")) {
      req.authCtx = { userId: null, isAdmin: false, via: "api-key" };
      return;
    }
    // ADR-0020: the Anthropic-shaped compat endpoint additionally accepts the
    // key in `x-api-key`, because that is the header Anthropic clients send.
    // It is the SAME RegulAIt API key resolved by the SAME authenticate() —
    // a second header name, never a second credential or a weaker path.
    let authorization = req.headers.authorization;
    if (!authorization && API_KEY_HEADER_ROUTES.has(`${req.method} ${req.routeOptions.url ?? ""}`)) {
      const alt = req.headers["x-api-key"];
      if (typeof alt === "string" && alt.length > 0) authorization = `Bearer ${alt}`;
    }
    const ctx = await authenticate(db, opts.bootstrapToken, authorization);
    if (!ctx) return reply.status(401).send({ error: "unauthenticated" });
    req.authCtx = ctx;
  });

  // Everything is admin-only except the routes where a non-admin identity is
  // the point: deciding an approval (named approver), viewing one's own
  // visible tools, and calling tools through the proxy.
  const NON_ADMIN_ROUTES = new Set([
    "POST /v1/approvals/:approvalId/decide",
    "GET /v1/users/:userId/servers/:serverId/tools",
    "POST /mcp/:serverId",
    "POST /v1/agents/:agentId/invoke",
    // ADR-0020: the provider-shaped compatibility surfaces are the DEVELOPER's
    // path — a non-admin calling from their IDE — exactly like the MCP proxy
    // above. Their governance is the ordinary evaluateAgent entitlement check
    // inside the shim, not admin-ness. The interception SETTINGS endpoints are
    // deliberately NOT here: writing the posture stays admin-only.
    "POST /v1/messages",
    "POST /v1/chat/completions",
    "POST /v1/connectors/:connectorId/invoke",
    "POST /v1/conversations",
    "GET /v1/conversations",
    "GET /v1/conversations/:conversationId",
    "DELETE /v1/conversations/:conversationId",
    "GET /v1/users/:userId/agents",
    "GET /v1/users/:userId/connectors",
    "POST /v1/workflows/instances",
    "POST /v1/workflows/instances/:instanceId/artifacts",
    "POST /v1/workflows/instances/:instanceId/advance",
    "POST /v1/workflows/instances/:instanceId/checks",
    "POST /v1/workflows/instances/:instanceId/recheck",
    "POST /v1/workflows/instances/:instanceId/deploy-override",
    "POST /v1/workflows/instances/:instanceId/abort",
    "GET /v1/workflows/instances/:instanceId",
    "GET /v1/approvals",
    "GET /v1/cost-events",
    "GET /v1/usage-events",
    "POST /v1/users/:userId/model-credentials",
    "GET /v1/users/:userId/model-credentials",
    "DELETE /v1/users/:userId/model-credentials/:provider",
    "POST /v1/projects/:projectId/members",
    "GET /v1/projects/:projectId/members",
    "PATCH /v1/projects/:projectId/members/:userId",
    "DELETE /v1/projects/:projectId/members/:userId",
    "POST /v1/projects/:projectId/context",
    "GET /v1/projects/:projectId/context",
    "GET /v1/projects/:projectId/context/graph",
    "POST /v1/projects/:projectId/context/promote",
    "GET /v1/projects/:projectId/compliance",
    "GET /v1/projects/:projectId/costs",
    "GET /v1/projects/:projectId/costs.csv",
    "POST /v1/runs",
    "POST /v1/runs/decompose",
    "POST /v1/runs/:runId/events",
    "POST /v1/runs/:runId/nodes/:nodeId/dispatch",
    "POST /v1/runs/:runId/auto",
    "GET /v1/runs/:runId",
    "POST /v1/runs/:runId/pm-sync",
    "POST /v1/workflows/instances/:instanceId/pm-sync",
    "GET /v1/pm/links",
    "POST /v1/decisions",
    "GET /v1/decisions",
    "POST /v1/pm/webhooks/:connectionName",
    "GET /admin",
    "GET /app",
    "GET /",
    "GET /health",
    "GET /v1/me",
    "GET /v1/model-providers/status",
    "GET /v1/runs",
    "GET /v1/workflows/instances",
    "GET /v1/projects",
    "GET /v1/users/directory",
  ]);
  app.addHook("preHandler", async (req, reply) => {
    const route = `${req.method} ${req.routeOptions.url ?? ""}`;
    if (!NON_ADMIN_ROUTES.has(route) && !req.authCtx.isAdmin) {
      return reply.status(403).send({ error: "admin_only" });
    }
  });

  // identity echo for UI clients — who am I, what may I see. Additively
  // carries the ADR-0021 org size ceilings any authenticated client needs to
  // pre-validate uploads (numbers only — no admin-only configuration leaks).
  app.get("/v1/me", async (req) => {
    const userId = req.authCtx.userId;
    let user = null;
    if (userId) {
      const [row] = await db
        .select({ id: users.id, email: users.email, displayName: users.displayName })
        .from(users)
        .where(eq(users.id, userId));
      user = row ?? null;
    }
    const org = await loadOrgSettings(db);
    return {
      userId,
      isAdmin: req.authCtx.isAdmin,
      user,
      limits: {
        maxAttachmentsPerDispatch: org.maxAttachmentsPerDispatch,
        maxAttachmentBytes: org.maxAttachmentBytes,
      },
    };
  });

  app.post("/v1/users", async (req, reply) => {
    const body = createUserSchema.parse(req.body);
    const [row] = await db
      .insert(users)
      .values({ email: body.email, displayName: body.displayName, isAdmin: body.isAdmin ?? false })
      .returning();
    return reply.status(201).send(row);
  });

  // ADR-0012: portal-driven API-parity gap fill — the bulk user table needs
  // a list endpoint, not only POST.
  app.get("/v1/users", async () => ({
    users: await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        isAdmin: users.isAdmin,
        createdAt: users.createdAt,
      })
      .from(users),
  }));

  // Names-only directory for the /app pickers (add a project member, name an
  // approver) — the gap slices 3–4 kept hitting: non-admins cannot read the
  // admin-only GET /v1/users, so their forms had no one to offer. This
  // exposes ids, display names, and team names ONLY — no emails, no roles,
  // no admin flags, no keys, no grants.
  app.get("/v1/users/directory", async () => {
    const [userRows, memberRows] = await Promise.all([
      db.select({ id: users.id, displayName: users.displayName }).from(users),
      db
        .select({ userId: teamMembers.userId, teamId: teamMembers.teamId, teamName: teams.name })
        .from(teamMembers)
        .innerJoin(teams, eq(teams.id, teamMembers.teamId)),
    ]);
    const teamsByUser = new Map<string, Array<{ id: string; name: string }>>();
    for (const m of memberRows) {
      const list = teamsByUser.get(m.userId) ?? [];
      list.push({ id: m.teamId, name: m.teamName });
      teamsByUser.set(m.userId, list);
    }
    return {
      users: userRows.map((u) => ({
        id: u.id,
        name: u.displayName,
        teams: teamsByUser.get(u.id) ?? [],
      })),
    };
  });

  app.post("/v1/users/:userId/keys", async (req, reply) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    const body = createApiKeySchema.parse(req.body);
    const { token, tokenHash } = generateToken();
    const [row] = await db
      .insert(apiKeys)
      .values({ userId, name: body.name, tokenHash })
      .returning({ id: apiKeys.id, name: apiKeys.name, createdAt: apiKeys.createdAt });
    // The plaintext token is returned exactly once and never stored.
    return reply.status(201).send({ ...row, token });
  });

  app.get("/v1/keys", async (req) => {
    const { userId } = z.object({ userId: z.string().uuid().optional() }).parse(req.query);
    const rows = await db
      .select({
        id: apiKeys.id,
        userId: apiKeys.userId,
        name: apiKeys.name,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(userId ? eq(apiKeys.userId, userId) : undefined);
    return { keys: rows };
  });

  app.post("/v1/keys/:keyId/revoke", async (req, reply) => {
    const { keyId } = z.object({ keyId: z.string().uuid() }).parse(req.params);
    const [row] = await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id, revokedAt: apiKeys.revokedAt });
    if (!row) return reply.status(404).send({ error: "unknown_or_already_revoked" });
    return row;
  });

  app.post("/v1/servers", async (req, reply) => {
    const body = createServerSchema.parse(req.body);
    const [row] = await db.insert(mcpServers).values(body).returning();
    return reply.status(201).send(row);
  });

  app.get("/v1/servers", async () => ({ servers: await db.select().from(mcpServers) }));

  app.get("/v1/servers/:serverId/tools", async (req) => {
    const { serverId } = uuidParam.parse(req.params);
    return { tools: await db.select().from(mcpTools).where(eq(mcpTools.serverId, serverId)) };
  });

  app.post("/v1/servers/:serverId/tools", async (req, reply) => {
    const { serverId } = uuidParam.parse(req.params);
    const body = createToolSchema.parse(req.body);
    const [row] = await db
      .insert(mcpTools)
      .values({ serverId, name: body.name, kind: body.kind, description: body.description ?? null })
      .returning();
    return reply.status(201).send(row);
  });

  app.post("/v1/grants/tools", async (req, reply) => {
    const body = createToolGrantSchema.parse(req.body);
    const [row] = await db.insert(toolGrants).values(body).returning();
    return reply.status(201).send(row);
  });

  app.post("/v1/grants/servers", async (req, reply) => {
    const body = createServerGrantSchema.parse(req.body);
    const [row] = await db.insert(serverGrants).values(body).returning();
    return reply.status(201).send(row);
  });

  app.get("/v1/users/:userId/servers/:serverId/tools", async (req, reply) => {
    const { userId, serverId } = visibleToolsParams.parse(req.params);
    // Non-admins may only view their own visible tools.
    if (!req.authCtx.isAdmin && req.authCtx.userId !== userId) {
      return reply.status(403).send({ error: "forbidden" });
    }
    const [tools, entitlements] = await Promise.all([
      db.select().from(mcpTools).where(eq(mcpTools.serverId, serverId)),
      loadEntitlements(db, userId, serverId),
    ]);
    const refs: ToolRef[] = tools.map((t) => ({ serverId: t.serverId, name: t.name, kind: t.kind }));
    return { tools: visibleTools(userId, serverId, refs, entitlements) };
  });

  // §5 roles: named entitlement bundles, admin-assignable as a user's baseline.
  app.post("/v1/roles", async (req, reply) => {
    const body = createRoleSchema.parse(req.body);
    const [row] = await db
      .insert(roles)
      .values({ name: body.name, description: body.description ?? null })
      .returning();
    return reply.status(201).send(row);
  });

  app.get("/v1/roles", async () => {
    return { roles: await db.select().from(roles) };
  });

  app.post("/v1/roles/:roleId/grants/tools", async (req, reply) => {
    const { roleId } = z.object({ roleId: z.string().uuid() }).parse(req.params);
    const body = createRoleToolGrantSchema.parse(req.body);
    const [row] = await db
      .insert(roleToolGrants)
      .values({ roleId, serverId: body.serverId, toolName: body.toolName })
      .returning();
    return reply.status(201).send(row);
  });

  app.post("/v1/roles/:roleId/grants/servers", async (req, reply) => {
    const { roleId } = z.object({ roleId: z.string().uuid() }).parse(req.params);
    const body = createRoleServerGrantSchema.parse(req.body);
    const [row] = await db
      .insert(roleServerGrants)
      .values({ roleId, serverId: body.serverId, readOnlyAll: body.readOnlyAll })
      .returning();
    return reply.status(201).send(row);
  });

  // §5 role-bundled AGENT/CONNECTOR grants (ADR-0014) — the agent/connector
  // twins of the MCP role-grant POSTs above. Admin-only via the default gate.
  app.post("/v1/roles/:roleId/grants/agents", async (req, reply) => {
    const { roleId } = z.object({ roleId: z.string().uuid() }).parse(req.params);
    const body = createRoleAgentGrantSchema.parse(req.body);
    const [row] = await db
      .insert(roleAgentGrants)
      .values({ roleId, agentId: body.agentId, allowedModes: body.allowedModes ?? null })
      .returning();
    return reply.status(201).send(row);
  });

  app.post("/v1/roles/:roleId/grants/connectors", async (req, reply) => {
    const { roleId } = z.object({ roleId: z.string().uuid() }).parse(req.params);
    const body = createRoleConnectorGrantSchema.parse(req.body);
    const [row] = await db
      .insert(roleConnectorGrants)
      .values({
        roleId,
        connectorId: body.connectorId,
        mode: body.mode,
        allowedObjects: body.allowedObjects ?? null,
      })
      .returning();
    return reply.status(201).send(row);
  });

  // §5 admin read-back: every grant this role bundles, across all four object
  // types, joined to names where useful (the role builder / access preview).
  app.get("/v1/roles/:roleId/grants", async (req) => {
    const { roleId } = z.object({ roleId: z.string().uuid() }).parse(req.params);
    const [tools, servers, roleAgents, roleConnectors] = await Promise.all([
      db
        .select({
          grantId: roleToolGrants.id,
          serverId: roleToolGrants.serverId,
          serverName: mcpServers.name,
          toolName: roleToolGrants.toolName,
        })
        .from(roleToolGrants)
        .leftJoin(mcpServers, eq(roleToolGrants.serverId, mcpServers.id))
        .where(eq(roleToolGrants.roleId, roleId)),
      db
        .select({
          grantId: roleServerGrants.id,
          serverId: roleServerGrants.serverId,
          serverName: mcpServers.name,
          readOnlyAll: roleServerGrants.readOnlyAll,
        })
        .from(roleServerGrants)
        .leftJoin(mcpServers, eq(roleServerGrants.serverId, mcpServers.id))
        .where(eq(roleServerGrants.roleId, roleId)),
      db
        .select({
          grantId: roleAgentGrants.id,
          agentId: roleAgentGrants.agentId,
          agentName: agents.name,
          allowedModes: roleAgentGrants.allowedModes,
        })
        .from(roleAgentGrants)
        .leftJoin(agents, eq(roleAgentGrants.agentId, agents.id))
        .where(eq(roleAgentGrants.roleId, roleId)),
      db
        .select({
          grantId: roleConnectorGrants.id,
          connectorId: roleConnectorGrants.connectorId,
          connectorName: connectors.name,
          mode: roleConnectorGrants.mode,
          allowedObjects: roleConnectorGrants.allowedObjects,
        })
        .from(roleConnectorGrants)
        .leftJoin(connectors, eq(roleConnectorGrants.connectorId, connectors.id))
        .where(eq(roleConnectorGrants.roleId, roleId)),
    ]);
    return { tools, servers, agents: roleAgents, connectors: roleConnectors };
  });

  app.delete("/v1/roles/:roleId/grants/agents/:grantId", async (req, reply) => {
    const { roleId, grantId } = z
      .object({ roleId: z.string().uuid(), grantId: z.string().uuid() })
      .parse(req.params);
    const deleted = await db
      .delete(roleAgentGrants)
      .where(and(eq(roleAgentGrants.id, grantId), eq(roleAgentGrants.roleId, roleId)))
      .returning({ id: roleAgentGrants.id });
    if (deleted.length === 0) return reply.status(404).send({ error: "unknown_grant" });
    return { removed: true };
  });

  app.delete("/v1/roles/:roleId/grants/connectors/:grantId", async (req, reply) => {
    const { roleId, grantId } = z
      .object({ roleId: z.string().uuid(), grantId: z.string().uuid() })
      .parse(req.params);
    const deleted = await db
      .delete(roleConnectorGrants)
      .where(and(eq(roleConnectorGrants.id, grantId), eq(roleConnectorGrants.roleId, roleId)))
      .returning({ id: roleConnectorGrants.id });
    if (deleted.length === 0) return reply.status(404).send({ error: "unknown_grant" });
    return { removed: true };
  });

  app.post("/v1/users/:userId/roles", async (req, reply) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    const body = assignRoleSchema.parse(req.body);
    const [row] = await db
      .insert(roleAssignments)
      .values({ userId, roleId: body.roleId })
      .returning();
    return reply.status(201).send(row);
  });

  app.delete("/v1/users/:userId/roles/:roleId", async (req, reply) => {
    const params = z
      .object({ userId: z.string().uuid(), roleId: z.string().uuid() })
      .parse(req.params);
    const deleted = await db
      .delete(roleAssignments)
      .where(
        and(eq(roleAssignments.userId, params.userId), eq(roleAssignments.roleId, params.roleId)),
      )
      .returning({ id: roleAssignments.id });
    if (deleted.length === 0) return reply.status(404).send({ error: "not_assigned" });
    return { removed: true };
  });

  // §5 subtractive override: revoke a role-derived entitlement for one user.
  // Deleting the revocation reverses it — overrides are independently reversible.
  app.post("/v1/revocations", async (req, reply) => {
    const body = createRevocationSchema.parse(req.body);
    const [row] = await db
      .insert(revocations)
      .values({ userId: body.userId, serverId: body.serverId, toolName: body.toolName ?? null })
      .returning();
    return reply.status(201).send(row);
  });

  app.delete("/v1/revocations/:revocationId", async (req, reply) => {
    const { revocationId } = z.object({ revocationId: z.string().uuid() }).parse(req.params);
    const deleted = await db
      .delete(revocations)
      .where(eq(revocations.id, revocationId))
      .returning({ id: revocations.id });
    if (deleted.length === 0) return reply.status(404).send({ error: "unknown_revocation" });
    return { removed: true };
  });

  // --- ADR-0019: per-user AGENT / CONNECTOR revocations -------------------
  // Pillar 1 promises "role builder + per-user override". Role-bundled agent
  // and connector grants (ADR-0014) composed additively with no way to subtract
  // one object from one user — an admin could only unassign the whole role.
  // These four writes close that hole. Admin-only (deliberately NOT in
  // NON_ADMIN_ROUTES): a subtractive override on someone else's entitlement is
  // an administrative act. Deleting the row reverses it, exactly like the MCP
  // revocation routes above. The kernel consults revocations on the allow path
  // ONLY, so creating one can never grant anything.

  const revocationUserParam = z.object({ userId: z.string().uuid() });
  const revocationIdParams = z.object({
    userId: z.string().uuid(),
    revocationId: z.string().uuid(),
  });

  app.post("/v1/users/:userId/revocations/agents", async (req, reply) => {
    const { userId } = revocationUserParam.parse(req.params);
    const body = createAgentRevocationSchema.parse(req.body);
    const [row] = await db
      .insert(agentRevocations)
      .values({ userId, agentId: body.agentId, reason: body.reason ?? null })
      .returning();
    return reply.status(201).send(row);
  });

  app.get("/v1/users/:userId/revocations/agents", async (req) => {
    const { userId } = revocationUserParam.parse(req.params);
    const rows = await db
      .select({
        id: agentRevocations.id,
        userId: agentRevocations.userId,
        agentId: agentRevocations.agentId,
        agentName: agents.name,
        reason: agentRevocations.reason,
        createdAt: agentRevocations.createdAt,
      })
      .from(agentRevocations)
      .innerJoin(agents, eq(agentRevocations.agentId, agents.id))
      .where(eq(agentRevocations.userId, userId));
    return { revocations: rows };
  });

  app.delete("/v1/users/:userId/revocations/agents/:revocationId", async (req, reply) => {
    const { userId, revocationId } = revocationIdParams.parse(req.params);
    const deleted = await db
      .delete(agentRevocations)
      .where(and(eq(agentRevocations.id, revocationId), eq(agentRevocations.userId, userId)))
      .returning({ id: agentRevocations.id });
    if (deleted.length === 0) return reply.status(404).send({ error: "unknown_revocation" });
    return { removed: true };
  });

  app.post("/v1/users/:userId/revocations/connectors", async (req, reply) => {
    const { userId } = revocationUserParam.parse(req.params);
    const body = createConnectorRevocationSchema.parse(req.body);
    const [row] = await db
      .insert(connectorRevocations)
      .values({ userId, connectorId: body.connectorId, reason: body.reason ?? null })
      .returning();
    return reply.status(201).send(row);
  });

  app.get("/v1/users/:userId/revocations/connectors", async (req) => {
    const { userId } = revocationUserParam.parse(req.params);
    const rows = await db
      .select({
        id: connectorRevocations.id,
        userId: connectorRevocations.userId,
        connectorId: connectorRevocations.connectorId,
        connectorName: connectors.name,
        reason: connectorRevocations.reason,
        createdAt: connectorRevocations.createdAt,
      })
      .from(connectorRevocations)
      .innerJoin(connectors, eq(connectorRevocations.connectorId, connectors.id))
      .where(eq(connectorRevocations.userId, userId));
    return { revocations: rows };
  });

  app.delete("/v1/users/:userId/revocations/connectors/:revocationId", async (req, reply) => {
    const { userId, revocationId } = revocationIdParams.parse(req.params);
    const deleted = await db
      .delete(connectorRevocations)
      .where(
        and(eq(connectorRevocations.id, revocationId), eq(connectorRevocations.userId, userId)),
      )
      .returning({ id: connectorRevocations.id });
    if (deleted.length === 0) return reply.status(404).send({ error: "unknown_revocation" });
    return { removed: true };
  });

  // §5 override-visibility view: every entitlement with its source (direct
  // vs role) and any revocation flagged — deviations from role defaults are
  // visible, not silent.
  app.get("/v1/users/:userId/servers/:serverId/entitlements", async (req) => {
    const { userId, serverId } = visibleToolsParams.parse(req.params);
    const [entitlements, roleRows, serverTools] = await Promise.all([
      loadEntitlements(db, userId, serverId),
      db.select().from(roles),
      db.select().from(mcpTools).where(eq(mcpTools.serverId, serverId)),
    ]);
    const toolKindByName = new Map(serverTools.map((t) => [t.name, t.kind]));
    const roleName = (roleId: string) => roleRows.find((r) => r.id === roleId)?.name ?? roleId;
    const revocationFor = (toolName: string | null) =>
      entitlements.revocations?.find((r) => r.toolName === null || r.toolName === toolName);

    const entries = [
      ...entitlements.toolGrants.map((g) => ({
        kind: "tool" as const,
        toolName: g.toolName,
        source: "direct" as const,
        grantId: g.id,
      })),
      ...entitlements.serverGrants
        .filter((g) => g.readOnlyAll)
        .map((g) => ({
          kind: "server-read-only" as const,
          toolName: null,
          source: "direct" as const,
          grantId: g.id,
        })),
      ...(entitlements.roleToolGrants ?? []).map((g) => {
        const rev = revocationFor(g.toolName);
        return {
          kind: "tool" as const,
          toolName: g.toolName,
          source: "role" as const,
          role: roleName(g.roleId),
          roleId: g.roleId,
          grantId: g.id,
          revoked: Boolean(rev),
          ...(rev ? { revocationId: rev.id } : {}),
        };
      }),
      ...(entitlements.roleServerGrants ?? [])
        .filter((g) => g.readOnlyAll)
        .map((g) => {
          const rev = revocationFor(null);
          // Tool-scoped revocations also carve tools out of a role
          // read-only-all grant (the kernel enforces this); flag them here so
          // the deviation is visible, not silent (§5).
          const roleToolNames = new Set(
            (entitlements.roleToolGrants ?? []).map((g) => g.toolName),
          );
          // Only read-kind tools that exist on the server were ever conferred
          // by read-only-all, so only those are genuine carve-outs of it.
          const carveOuts = (entitlements.revocations ?? [])
            .filter(
              (r) =>
                r.toolName !== null &&
                !roleToolNames.has(r.toolName) &&
                toolKindByName.get(r.toolName) === "read",
            )
            .map((r) => ({ toolName: r.toolName, revocationId: r.id }));
          return {
            kind: "server-read-only" as const,
            toolName: null,
            source: "role" as const,
            role: roleName(g.roleId),
            roleId: g.roleId,
            grantId: g.id,
            revoked: Boolean(rev),
            ...(rev ? { revocationId: rev.id } : {}),
            ...(carveOuts.length > 0 ? { revokedTools: carveOuts } : {}),
          };
        }),
    ];
    // Every active revocation, so overrides are discoverable and reversible
    // via DELETE /v1/revocations/:id even when no grant currently matches.
    return { entitlements: entries, revocations: entitlements.revocations ?? [] };
  });

  app.get("/v1/revocations", async (req) => {
    const query = z
      .object({ userId: z.string().uuid().optional(), serverId: z.string().uuid().optional() })
      .parse(req.query);
    const conditions = [
      query.userId ? eq(revocations.userId, query.userId) : undefined,
      query.serverId ? eq(revocations.serverId, query.serverId) : undefined,
    ].filter((c) => c !== undefined);
    const rows = await db
      .select()
      .from(revocations)
      .where(conditions.length > 0 ? and(...conditions) : undefined);
    return { revocations: rows };
  });

  app.post("/v1/evaluate", async (req, reply) => {
    const body = evaluateRequestSchema.parse(req.body);

    const [tool] = await db
      .select()
      .from(mcpTools)
      .where(and(eq(mcpTools.serverId, body.serverId), eq(mcpTools.name, body.toolName)));
    if (!tool) {
      return reply.status(404).send({ error: "unknown_tool" });
    }

    // Full governed evaluation, but decision-only: unlike the proxy path this
    // endpoint never creates queue entries or consumes approvals.
    const { decision } = await governedEvaluate(db, body.userId, body.serverId, {
      serverId: tool.serverId,
      name: tool.name,
      kind: tool.kind,
    });

    await db.insert(auditLog).values({
      userId: body.userId,
      serverId: body.serverId,
      toolName: body.toolName,
      effect: decision.effect,
      ruleId: decision.ruleId,
      ruleChain: decision.ruleChain,
      reason: decision.reason,
    });

    return decision;
  });

  app.get("/v1/rules/approvals", async () => ({
    rules: await db.select().from(approvalRules),
  }));
  app.get("/v1/rules/data-scopes", async () => ({
    rules: await db.select().from(dataScopeRules),
  }));
  app.get("/v1/rules/rate-limits", async () => ({
    rules: await db.select().from(rateLimits),
  }));

  // PILLAR 1 rule scoping: the discriminant is already validated by the shared
  // superRefine (mirrors the DB CHECK). We null out every off-scope subject/
  // server field so the row is clean and the DB CHECK always passes — a
  // role-scoped rule stores only roleId, a fleet rule stores none, an
  // all-servers rule stores no serverId.
  const scopedRuleColumns = (body: {
    scope: "user" | "role" | "team" | "fleet";
    serverScope: "server" | "all";
    userId?: string | null;
    roleId?: string | null;
    teamId?: string | null;
    serverId?: string | null;
  }) => ({
    scope: body.scope,
    serverScope: body.serverScope,
    userId: body.scope === "user" ? body.userId! : null,
    roleId: body.scope === "role" ? body.roleId! : null,
    teamId: body.scope === "team" ? body.teamId! : null,
    serverId: body.serverScope === "server" ? body.serverId! : null,
  });

  app.post("/v1/rules/approvals", async (req, reply) => {
    const body = createApprovalRuleSchema.parse(req.body);
    const [row] = await db
      .insert(approvalRules)
      .values({
        ...scopedRuleColumns(body),
        toolName: body.toolName ?? null,
        writeOnly: body.writeOnly ?? false,
        approverUserId: body.approverUserId,
      })
      .returning();
    return reply.status(201).send(row);
  });

  app.post("/v1/rules/data-scopes", async (req, reply) => {
    const body = createDataScopeRuleSchema.parse(req.body);
    const [row] = await db
      .insert(dataScopeRules)
      .values({
        ...scopedRuleColumns(body),
        toolName: body.toolName ?? null,
        argPath: body.argPath,
        allowedValues: body.allowedValues,
      })
      .returning();
    return reply.status(201).send(row);
  });

  app.post("/v1/rules/rate-limits", async (req, reply) => {
    const body = createRateLimitSchema.parse(req.body);
    const [row] = await db
      .insert(rateLimits)
      .values({
        ...scopedRuleColumns(body),
        toolName: body.toolName ?? null,
        maxCalls: body.maxCalls,
        windowSeconds: body.windowSeconds,
      })
      .returning();
    return reply.status(201).send(row);
  });

  // §6 Approvals Queue — one inbox for every paused call. Admins see all;
  // a non-admin sees exactly the approvals naming them as approver, so named
  // approvers can discover what awaits their sign-off.
  app.get("/v1/approvals", async (req) => {
    const { status } = z
      .object({ status: z.enum(["pending", "approved", "denied", "consumed", "superseded"]).optional() })
      .parse(req.query);
    const conditions = [
      status ? eq(approvals.status, status) : undefined,
      req.authCtx.isAdmin ? undefined : eq(approvals.approverUserId, req.authCtx.userId ?? ""),
    ].filter((c) => c !== undefined);
    const rows = await db
      .select()
      .from(approvals)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(approvals.requestedAt))
      .limit(100);
    // Display enrichment — purely additive to the row shape: names for the
    // requester/approver/decider and a label for the governed object, so the
    // inbox and queue can say WHO asked and WHAT is governed without the
    // admin-only user list.
    const ids = (xs: Array<string | null>) => [...new Set(xs.filter((x): x is string => x !== null))];
    // §9 context conflicts: the arbiter decides between two TEXTS, so their
    // inbox row must carry both sides — the retained conflicting revision and
    // the currently accepted one — not just an object label.
    const CONFLICT_PREFIX = "__context_conflict__:";
    const conflictItemIds = ids(
      rows.map((r) =>
        r.stageId?.startsWith(CONFLICT_PREFIX) ? r.stageId.slice(CONFLICT_PREFIX.length) : null,
      ),
    );
    const conflictItems = conflictItemIds.length
      ? await db
          .select()
          .from(projectContextItems)
          .where(inArray(projectContextItems.id, conflictItemIds))
      : [];
    const acceptedCounterparts = conflictItems.length
      ? await db
          .select()
          .from(projectContextItems)
          .where(
            and(
              inArray(projectContextItems.projectId, ids(conflictItems.map((i) => i.projectId))),
              inArray(projectContextItems.key, [...new Set(conflictItems.map((i) => i.key))]),
              eq(projectContextItems.accepted, true),
            ),
          )
      : [];
    const currentFor = (item: (typeof conflictItems)[number]) =>
      acceptedCounterparts
        .filter((c) => c.projectId === item.projectId && c.key === item.key && c.id !== item.id)
        .reduce<(typeof acceptedCounterparts)[number] | null>(
          (m, c) => (m === null || c.revision > m.revision ? c : m),
          null,
        );
    const conflictByItemId = new Map(conflictItems.map((i) => [i.id, i]));
    const userIds = ids(
      rows
        .flatMap((r) => [r.userId, r.approverUserId, r.decidedBy])
        .concat(conflictItems.map((i) => i.contributedByUserId))
        .concat(acceptedCounterparts.map((c) => c.contributedByUserId)),
    );
    const instanceIds = ids(rows.map((r) => r.instanceId));
    const runIds = ids(rows.map((r) => r.runId));
    const projectIds = ids(rows.map((r) => r.projectId));
    const [userRows, instanceRows, runRows, projectRows] = await Promise.all([
      userIds.length
        ? db
            .select({ id: users.id, displayName: users.displayName, email: users.email })
            .from(users)
            .where(inArray(users.id, userIds))
        : [],
      instanceIds.length
        ? db
            .select({ id: workflowInstances.id, change: workflowInstances.change })
            .from(workflowInstances)
            .where(inArray(workflowInstances.id, instanceIds))
        : [],
      runIds.length
        ? db
            .select({ id: orchestrationRuns.id, name: orchestrationRuns.name })
            .from(orchestrationRuns)
            .where(inArray(orchestrationRuns.id, runIds))
        : [],
      projectIds.length
        ? db
            .select({ id: projects.id, name: projects.name })
            .from(projects)
            .where(inArray(projects.id, projectIds))
        : [],
    ]);
    const nameOf = new Map(userRows.map((u) => [u.id, u.displayName || u.email]));
    const instanceLabel = new Map(
      instanceRows.map((i) => [i.id, (i.change as { description?: string } | null)?.description ?? null]),
    );
    const runLabel = new Map(runRows.map((r) => [r.id, r.name]));
    const projectLabel = new Map(projectRows.map((p) => [p.id, p.name]));
    const contextConflictFor = (r: (typeof rows)[number]) => {
      if (!r.stageId?.startsWith(CONFLICT_PREFIX)) return {};
      const item = conflictByItemId.get(r.stageId.slice(CONFLICT_PREFIX.length));
      if (!item) return {};
      const current = currentFor(item);
      const side = (i: NonNullable<typeof current>) => ({
        revision: i.revision,
        baseRevision: i.baseRevision,
        content: i.content,
        byName: nameOf.get(i.contributedByUserId) ?? null,
        at: i.createdAt,
      });
      return {
        contextConflict: {
          key: item.key,
          conflicting: side(item),
          current: current ? side(current) : null,
        },
      };
    };
    return {
      approvals: rows.map((r) => ({
        ...r,
        // Finding-6 separation-of-duties surface: the approver IS the user
        // who triggered the governed action — the UI badges it, deciding it
        // requires a recorded reason.
        selfReview: r.userId === r.approverUserId,
        requestedByName: nameOf.get(r.userId) ?? null,
        approverName: nameOf.get(r.approverUserId) ?? null,
        decidedByName: r.decidedBy ? (nameOf.get(r.decidedBy) ?? null) : null,
        objectLabel:
          (r.instanceId ? instanceLabel.get(r.instanceId) : null) ??
          (r.runId ? runLabel.get(r.runId) : null) ??
          (r.projectId ? projectLabel.get(r.projectId) : null) ??
          r.toolName ??
          null,
        ...contextConflictFor(r),
      })),
    };
  });

  app.post("/v1/approvals/:approvalId/decide", async (req, reply) => {
    const { approvalId } = z.object({ approvalId: z.string().uuid() }).parse(req.params);
    const body = decideApprovalSchema.parse(req.body);

    // The decider is the authenticated identity — a body-supplied id would be
    // trivially spoofable. The bootstrap token has no identity and cannot decide.
    const deciderUserId = req.authCtx.userId;
    if (!deciderUserId) return reply.status(403).send({ error: "bootstrap_cannot_decide" });

    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    if (!row) return reply.status(404).send({ error: "unknown_approval" });
    // A superseded gate is dead, not decidable: its node was reassigned or
    // retried, its run turned terminal, or a newer artifact re-opened the
    // stage. Refuse loudly instead of accepting a decision about nothing.
    if (row.status === "superseded") {
      return reply.status(409).send({
        error: "approval_superseded",
        detail: "this approval was superseded (its node, run, or stage moved on) and can no longer be decided",
      });
    }
    // Only the rule's named approver may decide (§3) — with one escape hatch:
    // an org ADMIN may decide in the approver's place to unblock a stuck
    // queue, but only with a recorded reason, and the override is written to
    // the one audit trail as exactly what it is.
    const adminOverride = row.approverUserId !== deciderUserId;
    if (adminOverride) {
      if (!req.authCtx.isAdmin) {
        return reply.status(403).send({ error: "not_the_named_approver" });
      }
      if (!body.reason?.trim()) {
        return reply.status(422).send({
          error: "override_reason_required",
          detail: "an admin deciding in place of the named approver must record a reason",
        });
      }
    }
    // Separation-of-duties guard: the named approver IS the user who
    // triggered the governed action. Still decidable (alternate-approver
    // routing is deliberately out of scope) but never silently — a recorded
    // reason is required and the audit row is stamped selfReview.
    const selfReview = row.userId === row.approverUserId;
    if (selfReview && !body.reason?.trim()) {
      return reply.status(400).send({
        error: "self_review_reason_required",
        detail: "this is a self-review (the approver is the requesting user); deciding it requires a recorded reason",
      });
    }

    // ONE transaction: the decision write and the run/workflow/project event
    // it causes commit or roll back together — a downstream invalid-state 409
    // can never leave a silently persisted decision behind. Post-commit
    // execution (git stages, nested-run completion) and the PM mirror run
    // only after the decision is durable.
    const outcome = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(approvals)
        .set({
          status: body.decision,
          decidedBy: deciderUserId,
          decidedAt: new Date(),
          decisionReason: body.reason ?? null,
        })
        .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
        .returning();
      if (!updated) return { updated: null, postCommit: null };
      if (adminOverride) {
        await tx.insert(auditLog).values({
          userId: deciderUserId,
          objectType: updated.objectType,
          objectId: updated.instanceId ?? updated.runId ?? updated.projectId ?? null,
          serverId: updated.serverId,
          toolName: updated.toolName,
          detail: {
            approvalId: updated.id,
            adminOverride: true,
            namedApproverUserId: row.approverUserId,
            decision: body.decision,
            stageId: updated.stageId,
          },
          effect: body.decision === "approved" ? "allow" : "deny",
          ruleId: "approval-admin-override",
          ruleChain: [],
          reason: `admin decided in place of the named approver: ${body.reason}`,
        });
      }
      if (selfReview) {
        await tx.insert(auditLog).values({
          userId: deciderUserId,
          objectType: updated.objectType,
          objectId: updated.instanceId ?? updated.runId ?? updated.projectId ?? null,
          serverId: updated.serverId,
          toolName: updated.toolName,
          detail: {
            approvalId: updated.id,
            selfReview: true,
            decision: body.decision,
            stageId: updated.stageId,
          },
          effect: body.decision === "approved" ? "allow" : "deny",
          ruleId: "approval-self-review",
          ruleChain: [],
          reason: `self-review: the approver is the requesting user; decided with recorded reason: ${body.reason}`,
        });
      }
      let postCommit: ((d: Db) => Promise<void>) | null = null;
      // Workflow sign-offs advance their instance through the same one inbox (§5).
      if (updated.objectType === "workflow") {
        postCommit = await applyWorkflowApprovalDecision(tx, updated, body.decision, deciderUserId, opts.dataKey);
      }
      // Orchestration escalations (§3): approve = another attempt, deny = abort.
      if (updated.objectType === "run") {
        postCommit = await applyRunApprovalDecision(tx, updated, body.decision, deciderUserId, opts.dataKey);
      }
      // Pillar 5 budget escalations + §9 context-conflict resolutions.
      if (updated.objectType === "project") {
        await applyProjectApprovalDecision(tx as unknown as Db, updated, body.decision, deciderUserId);
      }
      // Pillar 3 §8.2 governed remediations: approve -> provider.remediate +
      // finding 'remediated'; deny -> 'accepted_risk'. Both audited. SoD guards
      // (named-approver, admin-override-reason, self-review-reason) apply above.
      if (updated.objectType === "infra_operation") {
        await applyInfraApprovalDecision(tx as unknown as Db, updated, body.decision, deciderUserId);
      }
      return { updated, postCommit };
    });
    if (!outcome.updated) {
      // raced: re-read so the refusal names what actually happened
      const [current] = await db
        .select({ status: approvals.status })
        .from(approvals)
        .where(eq(approvals.id, approvalId));
      return reply.status(409).send(
        current?.status === "superseded"
          ? {
              error: "approval_superseded",
              detail: "this approval was superseded (its node, run, or stage moved on) and can no longer be decided",
            }
          : { error: "already_decided" },
      );
    }
    // The decision is durable from here on: an execution hiccup surfaces in
    // the response (and the execution machinery's own failure events), never
    // as a failed decide.
    let executionError: string | null = null;
    if (outcome.postCommit) {
      try {
        await outcome.postCommit(db);
      } catch (err) {
        executionError = err instanceof Error ? err.message : String(err);
      }
    }
    // EPIC-06 §5: sign-offs mirror to the linked work item — display only,
    // never a second decision point; a mirror failure never unwinds the
    // decision, it is surfaced in the response.
    const pmMirror = await mirrorApprovalDecision(db, opts.dataKey, outcome.updated, deciderUserId);
    return {
      ...outcome.updated,
      ...(adminOverride ? { adminOverride: true } : {}),
      ...(selfReview ? { selfReview: true } : {}),
      ...(pmMirror ? { pmMirror } : {}),
      ...(executionError ? { executionError } : {}),
    };
  });

  // ADR-0012: the portal is a static shell (zero data, zero secrets) that
  // talks to the same REST API as any script — policy-as-code by construction.
  app.get("/admin", async (_req, reply) => reply.type("text/html").send(ADMIN_PORTAL_HTML));
  app.get("/app", async (_req, reply) => reply.type("text/html").send(APP_HTML));

  // The two things anything pointed at the bare origin expects to find: a
  // human landing on / gets the app, a load balancer or uptime check gets a
  // status. Both are auth-exempt — neither reveals anything.
  app.get("/", async (_req, reply) => reply.redirect("/app", 302));
  app.get("/health", async (_req, reply) => {
    try {
      await db.execute(sql`select 1`);
    } catch {
      return reply.status(503).send({ status: "degraded", database: "unreachable" });
    }
    return { status: "ok", database: "ok" };
  });

  registerAgentConnectorRoutes(app, db, { dataKey: opts.dataKey });
  registerConversationRoutes(app, db);
  registerProjectRoutes(app, db);
  registerInfraRoutes(app, db, opts.dataKey);
  registerOptimizationRoutes(app, db);
  registerOrchestrationRoutes(app, db, { dataKey: opts.dataKey });
  registerDecomposeRoutes(app, db, { dataKey: opts.dataKey });
  registerPmRoutes(app, db, { dataKey: opts.dataKey });

  registerWorkflowRoutes(app, db, { dataKey: opts.dataKey });

  registerMcpProxy(app, db);

  // ADR-0020 (Batch H) — IDE / existing-agent interception. The two
  // provider-shaped shims are OFF by default and gated by the onRequest hook
  // above; the settings routes that flip them are admin-only.
  registerInterceptionRoutes(app, db);

  // ADR-0021 — org-wide functional defaults (org_settings singleton). The
  // GET/PUT routes are admin-only (deliberately NOT in NON_ADMIN_ROUTES); the
  // audit auto-prune scheduler is OFF by default and unref'd, stopped on close.
  registerOrgSettingsRoutes(app, db);
  const stopAuditPruneScheduler = startAuditPruneScheduler(db);
  app.addHook("onClose", async () => stopAuditPruneScheduler());
  registerAnthropicCompat(app, db, { dataKey: opts.dataKey });
  registerOpenAiCompat(app, db, { dataKey: opts.dataKey });

  app.get("/v1/audit", async (req) => {
    const { userId } = auditQuery.parse(req.query);
    const rows = await db
      .select()
      .from(auditLog)
      .where(userId ? eq(auditLog.userId, userId) : undefined)
      .orderBy(desc(auditLog.at))
      .limit(100);
    return { entries: rows };
  });

  return app;
}
