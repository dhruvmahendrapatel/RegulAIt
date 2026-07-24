import Fastify from "fastify";
import {
  and,
  desc,
  eq,
  auditLog,
  mcpServers,
  mcpTools,
  serverGrants,
  toolGrants,
  users,
  type Db,
} from "@regulait/db";
import { evaluate, visibleTools, type ToolRef } from "@regulait/policy-kernel";
import {
  createServerGrantSchema,
  createServerSchema,
  createToolGrantSchema,
  createToolSchema,
  createUserSchema,
  evaluateRequestSchema,
} from "@regulait/shared";
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

    const [tGrants, sGrants] = await Promise.all([
      db
        .select()
        .from(toolGrants)
        .where(and(eq(toolGrants.userId, body.userId), eq(toolGrants.serverId, body.serverId))),
      db
        .select()
        .from(serverGrants)
        .where(and(eq(serverGrants.userId, body.userId), eq(serverGrants.serverId, body.serverId))),
    ]);

    const decision = evaluate({
      userId: body.userId,
      serverId: body.serverId,
      tool: { serverId: tool.serverId, name: tool.name, kind: tool.kind },
      toolGrants: tGrants,
      serverGrants: sGrants,
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
