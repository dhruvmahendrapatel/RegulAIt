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
  costEvents,
  eq,
  mcpServers,
  mcpTools,
  userAgentPolicies,
  type Db,
} from "@regulait/db";
import { visibleTools, type Decision, type ToolRef } from "@regulait/policy-kernel";
import { selectTools } from "@regulait/optimizer-kernel";
import type { ModelToolDef } from "@regulait/model-provider";
import { governedEvaluate } from "./governed-evaluate.js";
import { loadEntitlements } from "./entitlements.js";
import { z } from "zod";

const proxyParams = z.object({ serverId: z.string().uuid() });
// OPTIMIZATION §8: an optional declared intent for lazy tool-loading. MCP's
// tools/list carries no request text, so the signal rides on the proxy URL.
const proxyQuery = z.object({ intent: z.string().max(2000).optional() });

// Tools without an explicit readOnlyHint are treated as writes — the
// conservative default under §3's read/write distinction.
function toolKind(tool: Tool): "read" | "write" {
  return tool.annotations?.readOnlyHint === true ? "read" : "write";
}

export async function connectUpstream(url: string): Promise<Client> {
  const client = new Client({ name: "regulait-gateway", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

/** The one governed tool-call primitive, shared by the MCP proxy route (a
 * human calling a tool) and pillar 7's tool-using worker loop (a governed
 * agent calling a tool mid-run). It does EXACTLY what the proxy handler did
 * inline: resolve the tool's read/write kind (syncing the upstream manifest
 * when unknown), run the full §3 governed evaluation, write the ONE audit row
 * for the decision, and then act on it — deny stops here; require_approval
 * dedupes/inserts the queue entry and stops; an already-approved entry is
 * consumed atomically before the call runs. Only an allow (with any approval
 * consumed) reaches the upstream. The function owns the upstream connect/close
 * lifecycle. It NEVER throws for a governance outcome — callers map the
 * discriminated result to their own surface (MCP errors for the proxy, error
 * tool_result turns for the loop), so the loop can react to a denial instead
 * of crashing. `dataKey` is accepted for signature parity with the dispatch
 * core; MCP upstreams authenticate via their registered URL, so it is unused
 * today. */
export type GovernedToolCallOutcome =
  | { kind: "allowed"; content: unknown }
  | { kind: "unknown_tool" }
  | { kind: "denied"; decision: Decision }
  | { kind: "approval_required"; approvalId: string; decision: Decision }
  | { kind: "approval_consumed_race"; approvalId: string };

export async function executeGovernedToolCall(
  db: Db,
  _dataKey: string | undefined,
  args: {
    userId: string;
    serverId: string;
    toolName: string;
    arguments?: Record<string, unknown> | undefined;
  },
): Promise<GovernedToolCallOutcome> {
  const { userId, serverId, toolName } = args;
  const [serverRow] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
  if (!serverRow) return { kind: "unknown_tool" };

  const [toolRow] = await db
    .select()
    .from(mcpTools)
    .where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)));
  // Unknown tool: sync the manifest once in case it's newly added upstream.
  let kind = toolRow?.kind;
  let upstream: Client | null = null;
  const closeUpstream = async () => {
    if (upstream) {
      const u = upstream;
      upstream = null;
      await u.close();
    }
  };
  try {
    if (!kind) {
      upstream = await connectUpstream(serverRow.url);
      const upstreamTools = await syncUpstreamTools(db, serverId, upstream);
      const found = upstreamTools.find((t) => t.name === toolName);
      if (!found) return { kind: "unknown_tool" };
      kind = toolKind(found);
    }

    const { decision, approvedApprovalId } = await governedEvaluate(
      db,
      userId,
      serverId,
      { serverId, name: toolName, kind },
      args.arguments,
    );

    await db.insert(auditLog).values({
      userId,
      serverId,
      toolName,
      effect: decision.effect,
      ruleId: decision.ruleId,
      ruleChain: decision.ruleChain,
      reason: decision.reason,
    });

    if (decision.effect === "deny") return { kind: "denied", decision };

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
      return { kind: "approval_required", approvalId, decision };
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
        return { kind: "approval_consumed_race", approvalId: approvedApprovalId };
      }
    }

    if (!upstream) upstream = await connectUpstream(serverRow.url);
    const content = await upstream.callTool({ name: toolName, arguments: args.arguments });
    return { kind: "allowed", content };
  } finally {
    await closeUpstream();
  }
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


/** Pillar 7 tool resolution: turn a worker node's DECLARED tool servers into
 * (a) the model-facing tool defs the initiating user is ENTITLED to on those
 * servers, and (b) a full name→server map for governance routing. Reuses the
 * exact manifest sync + entitlement filter the proxy's tools/list uses, so a
 * node's tools are governed identically to a human's. The declaration is a
 * scoping hint only: a server the user can't reach, or a connect failure,
 * simply contributes nothing (never authority). The name→server map spans the
 * WHOLE manifest of each declared server — not just entitled tools — so a model
 * that asks for a manifested-but-ungranted tool still routes to
 * executeGovernedToolCall and earns a governed deny row rather than silently
 * vanishing. */
export async function resolveNodeToolContext(
  db: Db,
  userId: string,
  serverIds: string[],
  allowNames: string[] | undefined,
): Promise<{ toolDefs: ModelToolDef[]; serverByTool: Map<string, string> }> {
  const toolDefs: ModelToolDef[] = [];
  const serverByTool = new Map<string, string>();
  const nameFilter = allowNames && allowNames.length > 0 ? new Set(allowNames) : null;
  for (const serverId of serverIds) {
    const [serverRow] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
    if (!serverRow) continue;
    let upstream: Client | null = null;
    try {
      upstream = await connectUpstream(serverRow.url);
      const upstreamTools = await syncUpstreamTools(db, serverId, upstream);
      const entitlements = await loadEntitlements(db, userId, serverId);
      const refs: ToolRef[] = upstreamTools.map((t) => ({
        serverId,
        name: t.name,
        kind: toolKind(t),
      }));
      const visible = new Set(visibleTools(userId, serverId, refs, entitlements).map((t) => t.name));
      for (const t of upstreamTools) {
        // first declared server wins for a shared tool name
        if (!serverByTool.has(t.name)) serverByTool.set(t.name, serverId);
        if (!visible.has(t.name)) continue;
        if (nameFilter && !nameFilter.has(t.name)) continue;
        toolDefs.push({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
        });
      }
    } catch {
      // a declared server we cannot reach contributes no tools — a hint, not authority
    } finally {
      if (upstream) await upstream.close();
    }
  }
  return { toolDefs, serverByTool };
}

export function registerMcpProxy(app: FastifyInstance, db: Db) {
  app.post("/mcp/:serverId", async (req, reply) => {
    const { serverId } = proxyParams.parse(req.params);
    const { intent } = proxyQuery.parse(req.query);

    // Identity comes from the app-level auth hook (API key). The bootstrap
    // token has no user identity, so it cannot call tools.
    const userId = req.authCtx.userId;
    if (!userId) {
      return reply.status(403).send({ error: "bootstrap_cannot_call_tools" });
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
      const entitlements = await loadEntitlements(db, userId, serverId);
      const refs: ToolRef[] = upstreamTools.map((t) => ({
        serverId,
        name: t.name,
        kind: toolKind(t),
      }));
      const visible = new Set(
        visibleTools(userId, serverId, refs, entitlements).map((t) => t.name),
      );
      const entitled = upstreamTools.filter((t) => visible.has(t.name));

      // OPTIMIZATION §8: lazy tool-loading. Governance filtering above decides
      // what the user MAY see; this decides what is WORTH sending for the
      // declared intent. Withheld tools remain fully callable — tools/call
      // never consults this selection (§12: entitlements never shrink).
      const [policy] = await db
        .select({ routingMode: userAgentPolicies.routingMode })
        .from(userAgentPolicies)
        .where(eq(userAgentPolicies.userId, userId));
      const selection = selectTools({
        intent: intent ?? null,
        tools: entitled.map((t) => ({
          name: t.name,
          description: t.description ?? null,
          manifestChars: JSON.stringify(t).length,
        })),
        routingMode: policy?.routingMode ?? "automatic",
      });
      await db.insert(costEvents).values({
        userId,
        objectType: "mcp_tool",
        objectId: serverId,
        technique: "lazy_tool_loading",
        estimatedTokensSaved: selection.estimatedTokensSaved,
        estimatedCostSavedUsd: null,
        estimationBasis: selection.estimationBasis,
        ruleId: selection.ruleId,
        detail: {
          effect: selection.effect,
          selectedCount: selection.selected.length,
          withheldCount: selection.withheld.length,
        },
      });
      const exposed = new Set(selection.selected);
      return { tools: entitled.filter((t) => exposed.has(t.name)) };
    });

    proxy.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      // The proxy route is now a thin governance-to-MCP-error mapper over the
      // shared primitive; the identical logic serves the worker loop too.
      const outcome = await executeGovernedToolCall(db, undefined, {
        userId,
        serverId,
        toolName,
        arguments: request.params.arguments,
      });

      switch (outcome.kind) {
        case "unknown_tool":
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
        case "denied":
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Denied by policy: ${outcome.decision.reason}`,
          );
        case "approval_required": {
          // name the approver by display name when the kernel carried one — the
          // approval id keeps the full UUID (a caller retries with it)
          const decision = outcome.decision;
          const approverLabel = decision.approverName
            ? `'${decision.approverName}' (${decision.approverUserId!.slice(0, 8)}…)`
            : `'${decision.approverUserId}'`;
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Approval required: approval '${outcome.approvalId}' is pending sign-off by ` +
              `approver ${approverLabel}. Retry after approval.`,
          );
        }
        case "approval_consumed_race":
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Approval '${outcome.approvalId}' was already consumed — retry to request a new approval.`,
          );
        case "allowed":
          return outcome.content as Record<string, unknown>;
      }
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
