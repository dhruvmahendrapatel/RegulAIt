import Fastify from "fastify";
import {
  and,
  desc,
  eq,
  approvalRules,
  approvals,
  auditLog,
  mcpServers,
  mcpTools,
  rateLimits,
  serverGrants,
  toolGrants,
  users,
  type Db,
} from "@regulait/db";
import { visibleTools, type ToolRef } from "@regulait/policy-kernel";
import {
  createApprovalRuleSchema,
  createRateLimitSchema,
  createServerGrantSchema,
  createServerSchema,
  createToolGrantSchema,
  createToolSchema,
  createUserSchema,
  decideApprovalSchema,
  evaluateRequestSchema,
} from "@regulait/shared";
import { governedEvaluate } from "./governed-evaluate.js";
import { z } from "zod";
import { registerMcpProxy } from "./mcp-proxy.js";

const uuidParam = z.object({ serverId: z.string().uuid() });
const visibleToolsParams = z.object({
  userId: z.string().uuid(),
  serverId: z.string().uuid(),
});
const auditQuery = z.object({ userId: z.string().uuid().optional() });

export function buildApp(db: Db) {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: "validation", issues: err.issues });
    }
    app.log.error(err);
    return reply.status(500).send({ error: "internal" });
  });

  app.post("/v1/users", async (req, reply) => {
    const body = createUserSchema.parse(req.body);
    const [row] = await db
      .insert(users)
      .values({ email: body.email, displayName: body.displayName })
      .returning();
    return reply.status(201).send(row);
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

  app.get("/v1/users/:userId/servers/:serverId/tools", async (req) => {
    const { userId, serverId } = visibleToolsParams.parse(req.params);
    const [tools, tGrants, sGrants] = await Promise.all([
      db.select().from(mcpTools).where(eq(mcpTools.serverId, serverId)),
      db
        .select()
        .from(toolGrants)
        .where(and(eq(toolGrants.userId, userId), eq(toolGrants.serverId, serverId))),
      db
        .select()
        .from(serverGrants)
        .where(and(eq(serverGrants.userId, userId), eq(serverGrants.serverId, serverId))),
    ]);
    const refs: ToolRef[] = tools.map((t) => ({ serverId: t.serverId, name: t.name, kind: t.kind }));
    return { tools: visibleTools(userId, serverId, refs, tGrants, sGrants) };
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

  // §6 Approvals Queue — one inbox for every paused call.
  app.get("/v1/approvals", async (req) => {
    const { status } = z
      .object({ status: z.enum(["pending", "approved", "denied", "consumed"]).optional() })
      .parse(req.query);
    const rows = await db
      .select()
      .from(approvals)
      .where(status ? eq(approvals.status, status) : undefined)
      .orderBy(desc(approvals.requestedAt))
      .limit(100);
    return { approvals: rows };
  });

  app.post("/v1/approvals/:approvalId/decide", async (req, reply) => {
    const { approvalId } = z.object({ approvalId: z.string().uuid() }).parse(req.params);
    const body = decideApprovalSchema.parse(req.body);

    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    if (!row) return reply.status(404).send({ error: "unknown_approval" });
    // Only the rule's named approver may decide (§3).
    if (row.approverUserId !== body.deciderUserId) {
      return reply.status(403).send({ error: "not_the_named_approver" });
    }

    const [updated] = await db
      .update(approvals)
      .set({
        status: body.decision,
        decidedBy: body.deciderUserId,
        decidedAt: new Date(),
        decisionReason: body.reason ?? null,
      })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
      .returning();
    if (!updated) return reply.status(409).send({ error: "already_decided" });
    return updated;
  });

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
