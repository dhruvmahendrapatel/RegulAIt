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
  approvals,
  auditLog,
  eq,
  mcpServers,
  mcpTools,
  serverGrants,
  toolGrants,
  type Db,
} from "@regulait/db";
import { visibleTools, type ToolRef } from "@regulait/policy-kernel";
import { governedEvaluate } from "./governed-evaluate.js";
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

      const { decision, approvedApprovalId } = await governedEvaluate(db, userId, serverId, {
        serverId,
        name: toolName,
        kind,
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

      if (decision.effect === "require_approval") {
        // Reuse an existing pending entry rather than piling up duplicates.
        const [pending] = await db
          .select({ id: approvals.id })
          .from(approvals)
          .where(
            and(
              eq(approvals.userId, userId),
              eq(approvals.serverId, serverId),
              eq(approvals.toolName, toolName),
              eq(approvals.status, "pending"),
            ),
          )
          .limit(1);
        const approvalId =
          pending?.id ??
          (
            await db
              .insert(approvals)
              .values({
                userId,
                serverId,
                toolName,
                ruleId: decision.ruleId,
                approverUserId: decision.approverUserId!,
              })
              .returning({ id: approvals.id })
          )[0]!.id;
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Approval required: approval '${approvalId}' is pending sign-off by ` +
            `approver '${decision.approverUserId}'. Retry after approval.`,
        );
      }

      if (approvedApprovalId) {
        // Atomically consume the approval; losing the race means another call
        // already spent it, so this call must go back through the queue.
        const consumed = await db
          .update(approvals)
          .set({ status: "consumed" })
          .where(and(eq(approvals.id, approvedApprovalId), eq(approvals.status, "approved")))
          .returning({ id: approvals.id });
        if (consumed.length === 0) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Approval '${approvedApprovalId}' was already consumed — retry to request a new approval.`,
          );
        }
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
