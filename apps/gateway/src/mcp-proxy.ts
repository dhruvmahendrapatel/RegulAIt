import type { FastifyInstance } from "fastify";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  and,
  auditLog,
  eq,
  mcpServers,
  mcpTools,
  serverGrants,
  toolGrants,
  type Db,
} from "@regulait/db";
import { evaluate, visibleTools, type ToolRef } from "@regulait/policy-kernel";
import { z } from "zod";

const proxyParams = z.object({ serverId: z.string().uuid() });

// Tools without an explicit readOnlyHint are treated as writes — the
// conservative default under §3's read/write distinction.
function toolKind(tool: Tool): "read" | "write" {
  return tool.annotations?.readOnlyHint === true ? "read" : "write";
}

async function connectUpstream(url: string): Promise<Client> {
  const client = new Client({ name: "regulait-gateway", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

/** Discover the upstream tool manifest and sync it into the registry (§6: auto-discovered tool inventory). */
async function syncUpstreamTools(db: Db, serverId: string, client: Client): Promise<Tool[]> {
  const { tools } = await client.listTools();
  for (const tool of tools) {
    await db
      .insert(mcpTools)
      .values({
        serverId,
        name: tool.name,
        kind: toolKind(tool),
        description: tool.description ?? null,
      })
      .onConflictDoUpdate({
        target: [mcpTools.serverId, mcpTools.name],
        set: { kind: toolKind(tool), description: tool.description ?? null },
      });
  }
  return tools;
}

async function loadGrants(db: Db, userId: string, serverId: string) {
  const [tGrants, sGrants] = await Promise.all([
    db
      .select()
      .from(toolGrants)
      .where(and(eq(toolGrants.userId, userId), eq(toolGrants.serverId, serverId))),
    db
      .select()
      .from(serverGrants)
      .where(and(eq(serverGrants.userId, userId), eq(serverGrants.serverId, serverId))),
  ]);
  return { tGrants, sGrants };
}

export function registerMcpProxy(app: FastifyInstance, db: Db) {
  app.post("/mcp/:serverId", async (req, reply) => {
    const { serverId } = proxyParams.parse(req.params);

    // Interim identity mechanism until real authn lands: trusted header only.
    const userId = req.headers["x-regulait-user-id"];
    if (typeof userId !== "string" || !z.string().uuid().safeParse(userId).success) {
      return reply.status(401).send({ error: "missing_or_invalid_user" });
    }

    const [serverRow] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
    if (!serverRow) {
      return reply.status(404).send({ error: "unknown_server" });
    }

    const upstream = await connectUpstream(serverRow.url);

    const proxy = new Server(
      { name: "regulait-gateway", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );

    proxy.setRequestHandler(ListToolsRequestSchema, async () => {
      const upstreamTools = await syncUpstreamTools(db, serverId, upstream);
      const { tGrants, sGrants } = await loadGrants(db, userId, serverId);
      const refs: ToolRef[] = upstreamTools.map((t) => ({
        serverId,
        name: t.name,
        kind: toolKind(t),
      }));
      const visible = new Set(
        visibleTools(userId, serverId, refs, tGrants, sGrants).map((t) => t.name),
      );
      return { tools: upstreamTools.filter((t) => visible.has(t.name)) };
    });

    proxy.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;

      const [toolRow] = await db
        .select()
        .from(mcpTools)
        .where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)));
      // Unknown tool: sync the manifest once in case it's newly added upstream.
      let kind = toolRow?.kind;
      if (!kind) {
        const upstreamTools = await syncUpstreamTools(db, serverId, upstream);
        const found = upstreamTools.find((t) => t.name === toolName);
        if (!found) {
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
        }
        kind = toolKind(found);
      }

      const { tGrants, sGrants } = await loadGrants(db, userId, serverId);
      const decision = evaluate({
        userId,
        serverId,
        tool: { serverId, name: toolName, kind },
        toolGrants: tGrants,
        serverGrants: sGrants,
      });

      await db.insert(auditLog).values({
        userId,
        serverId,
        toolName,
        effect: decision.effect,
        ruleId: decision.ruleId,
        ruleChain: decision.ruleChain,
        reason: decision.reason,
      });

      if (decision.effect === "deny") {
        throw new McpError(ErrorCode.InvalidRequest, `Denied by policy: ${decision.reason}`);
      }

      return upstream.callTool({
        name: toolName,
        arguments: request.params.arguments,
      });
    });

    // Stateless mode: one transport per request, no session tracking yet.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void upstream.close();
    });
    await proxy.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
}
