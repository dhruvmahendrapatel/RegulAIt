import Fastify from "fastify";
import {
  and,
  desc,
  eq,
  apiKeys,
  approvalRules,
  approvals,
  auditLog,
  dataScopeRules,
  isNull,
  mcpServers,
  mcpTools,
  rateLimits,
  revocations,
  roleAssignments,
  roleServerGrants,
  roleToolGrants,
  roles,
  serverGrants,
  toolGrants,
  users,
  type Db,
} from "@regulait/db";
import { visibleTools, type ToolRef } from "@regulait/policy-kernel";
import {
  assignRoleSchema,
  createApiKeySchema,
  createApprovalRuleSchema,
  createDataScopeRuleSchema,
  createRateLimitSchema,
  createRevocationSchema,
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
import { registerOptimizationRoutes } from "./optimization.js";
import { applyRunApprovalDecision, registerOrchestrationRoutes } from "./orchestration.js";
import { mirrorApprovalDecision, registerPmRoutes } from "./pm.js";
import { RunStateError } from "@regulait/orchestration-kernel";
import { applyWorkflowApprovalDecision, registerWorkflowRoutes } from "./workflows.js";
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
  // authenticates with its per-connection secret inside the route handler.
  app.addHook("preHandler", async (req, reply) => {
    if (req.routeOptions.url === "/v1/pm/webhooks/:connectionName") {
      req.authCtx = { userId: null, isAdmin: false, via: "api-key" };
      return;
    }
    const ctx = await authenticate(db, opts.bootstrapToken, req.headers.authorization);
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
    "POST /v1/connectors/:connectorId/invoke",
    "GET /v1/users/:userId/agents",
    "GET /v1/users/:userId/connectors",
    "POST /v1/workflows/instances",
    "POST /v1/workflows/instances/:instanceId/artifacts",
    "POST /v1/workflows/instances/:instanceId/advance",
    "POST /v1/workflows/instances/:instanceId/abort",
    "GET /v1/workflows/instances/:instanceId",
    "GET /v1/approvals",
    "GET /v1/cost-events",
    "GET /v1/usage-events",
    "POST /v1/users/:userId/model-credentials",
    "GET /v1/users/:userId/model-credentials",
    "DELETE /v1/users/:userId/model-credentials/:provider",
    "POST /v1/runs",
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
  ]);
  app.addHook("preHandler", async (req, reply) => {
    const route = `${req.method} ${req.routeOptions.url ?? ""}`;
    if (!NON_ADMIN_ROUTES.has(route) && !req.authCtx.isAdmin) {
      return reply.status(403).send({ error: "admin_only" });
    }
  });

  app.post("/v1/users", async (req, reply) => {
    const body = createUserSchema.parse(req.body);
    const [row] = await db
      .insert(users)
      .values({ email: body.email, displayName: body.displayName, isAdmin: body.isAdmin ?? false })
      .returning();
    return reply.status(201).send(row);
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

  app.post("/v1/rules/approvals", async (req, reply) => {
    const body = createApprovalRuleSchema.parse(req.body);
    const [row] = await db
      .insert(approvalRules)
      .values({
        userId: body.userId,
        serverId: body.serverId,
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
        userId: body.userId,
        serverId: body.serverId,
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
        userId: body.userId,
        serverId: body.serverId,
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
    return { approvals: rows };
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
    // Only the rule's named approver may decide (§3).
    if (row.approverUserId !== deciderUserId) {
      return reply.status(403).send({ error: "not_the_named_approver" });
    }

    const [updated] = await db
      .update(approvals)
      .set({
        status: body.decision,
        decidedBy: deciderUserId,
        decidedAt: new Date(),
        decisionReason: body.reason ?? null,
      })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
      .returning();
    if (!updated) return reply.status(409).send({ error: "already_decided" });
    // Workflow sign-offs advance their instance through the same one inbox (§5).
    if (updated.objectType === "workflow") {
      await applyWorkflowApprovalDecision(db, updated, body.decision, deciderUserId, opts.dataKey);
    }
    // Orchestration escalations (§3): approve = another attempt, deny = abort.
    if (updated.objectType === "run") {
      await applyRunApprovalDecision(db, updated, body.decision, deciderUserId, opts.dataKey);
    }
    // EPIC-06 §5: sign-offs mirror to the linked work item — display only,
    // never a second decision point; a mirror failure never unwinds the
    // decision, it is surfaced in the response.
    const pmMirror = await mirrorApprovalDecision(db, opts.dataKey, updated, deciderUserId);
    return pmMirror ? { ...updated, pmMirror } : updated;
  });

  registerAgentConnectorRoutes(app, db, { dataKey: opts.dataKey });
  registerOptimizationRoutes(app, db);
  registerOrchestrationRoutes(app, db, { dataKey: opts.dataKey });
  registerPmRoutes(app, db, { dataKey: opts.dataKey });

  registerWorkflowRoutes(app, db, { dataKey: opts.dataKey });

  registerMcpProxy(app, db);

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
