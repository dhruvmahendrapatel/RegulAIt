/**
 * #609 follow-up (owner 2026-10-30, #453): THE ON-DEMAND TOOL SYNC.
 *
 *   POST /v1/servers/:serverId/tools/sync
 *
 * An admin asks the gateway to fetch one server's manifest now, instead of
 * waiting for someone's first `tools/list` or the nightly re-scan. It adds no
 * second idea of "fetch, adjudicate, store": the pass is the live path's own
 * `preflightUpstream` → `connectUpstream` → `syncUpstreamTools`, so the
 * admission gate, the release-age cooldown, the egress guard, the transport
 * and isolation gates, the breaker and the manifest scan all decide exactly as
 * they do for a proxied call.
 *
 * What it adds, in order:
 *   1. admin-only through the default gate (not in NON_ADMIN_ROUTES);
 *   2. a per-SERVER rate limit (`mcpsync:<id>`, rate-limit.ts), because every
 *      sync is an outbound request;
 *   3. a `settings_relax` step-up bound to the server: a sync can bring new
 *      tools into the inventory, so it widens what can be granted;
 *   4. one audit row per outcome: `mcp-tools-synced` (allow) in the same
 *      transaction that stores the manifest, `mcp-tools-sync-refused` (deny)
 *      for every refusal after the step-up, with the refusal's code.
 *
 * Nothing secret leaves: the answer carries counts and tool names, never the
 * upstream's error text, a credential, or the URL.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auditLog, eq, mcpServers, mcpTools, type Db } from "@regulait/db";
import { connectUpstream, mcpPreHijackRefusal, preflightUpstream, syncUpstreamTools } from "./mcp-proxy.js";
import { breakerAdmits, recordUpstreamFailure, recordUpstreamSuccess } from "./upstream-breaker.js";
import { classifyUpstreamError, isDeadlineError } from "./upstream-retry.js";
import { mcpSyncRateLimitKey } from "./rate-limit.js";
import { requireStepUp } from "./step-up.js";
import { errMessage } from "./err-serializer.js";
import { abacPrincipalFromRequest } from "./abac-principal.js";
import { isReservedToolName } from "./mcp-protocol.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";
export const MCP_TOOLS_SYNCED_RULE_ID = "mcp-tools-synced";
export const MCP_TOOLS_SYNC_REFUSED_RULE_ID = "mcp-tools-sync-refused";

const serverParam = z.object({ serverId: z.string().uuid() });

export function registerMcpToolSyncRoutes(app: FastifyInstance, db: Db): void {
  app.post("/v1/servers/:serverId/tools/sync", async (req, reply) => {
    const { serverId } = serverParam.parse(req.params);
    const actor = req.authCtx.userId ?? NIL_USER;
    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
    if (!row) return reply.status(404).send({ error: "unknown_server", detail: `no MCP server has id ${serverId}. Nothing was synced.` });
    // per server, before the step-up, so a loop cannot mint ceremonies either (a no-op when the limiter is off)
    if (app.rateLimitCredential && (await app.rateLimitCredential(req, reply, mcpSyncRateLimitKey(serverId)))) return reply;
    if (!(await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { serverId, values: { mcpToolSync: serverId } } })).ok) {
      return reply;
    }

    const refuse = async (status: number, body: Record<string, unknown>): Promise<FastifyReply> => {
      await db.insert(auditLog).values({
        userId: actor,
        serverId,
        objectType: "mcp_server",
        objectId: serverId,
        detail: { phase: "tools-sync", via: req.authCtx.via, code: body.error, status },
        effect: "deny",
        ruleId: MCP_TOOLS_SYNC_REFUSED_RULE_ID,
        ruleChain: [],
        reason: `on-demand tool sync of MCP server '${row.name}' refused (${String(body.error)}); nothing was stored`,
      });
      return reply.status(status).send(body);
    };

    // the live path's gates, in the live path's order (AER-024: admission and egress before the breaker)
    try {
      await preflightUpstream(db, row);
    } catch (err) {
      const refused = mcpPreHijackRefusal(err);
      if (refused) return refuse(refused.status, refused.body);
      throw err;
    }
    const open = await breakerAdmits(db, row);
    if (open) {
      reply.header("retry-after", String(Math.ceil(open.refusedUntilMs / 1000)));
      return refuse(503, { error: "mcp_upstream_circuit_open", detail: open.reason, retryAfterMs: open.refusedUntilMs });
    }

    const before = new Set(
      (await db.select({ name: mcpTools.name }).from(mcpTools).where(eq(mcpTools.serverId, serverId))).map((t) => t.name),
    );
    let client: Client | null = null;
    try {
      client = await connectUpstream(db, row, {
        // ADR-0190 I4: a stdio connect is placed for this admin with no project, and fails closed where policy needs one
        placement: { userId: actor, projectId: null, principal: abacPrincipalFromRequest(req) },
      });
      const tools = await syncUpstreamTools(db, serverId, client, "sync", row.transport, async (tx, synced) => {
        const names = synced.map((t) => t.name).filter((n) => !isReservedToolName(n));
        await tx.insert(auditLog).values({
          userId: actor,
          serverId,
          objectType: "mcp_server",
          objectId: serverId,
          detail: { phase: "tools-sync", via: req.authCtx.via, toolCount: names.length, added: names.filter((n) => !before.has(n)) },
          effect: "allow",
          ruleId: MCP_TOOLS_SYNCED_RULE_ID,
          ruleChain: [],
          reason: `on-demand tool sync of MCP server '${row.name}': ${names.length} tool(s) in the manifest, scanned and stored`,
        });
      });
      await recordUpstreamSuccess(db, row);
      const names = tools.map((t) => t.name).filter((n) => !isReservedToolName(n));
      const [after] = await db.select({ admissionState: mcpServers.admissionState }).from(mcpServers).where(eq(mcpServers.id, serverId));
      return reply.send({
        serverId,
        toolCount: names.length,
        added: names.filter((n) => !before.has(n)),
        admissionState: after?.admissionState ?? null,
      });
    } catch (err) {
      // a scan hold, the cooldown on a changed manifest, an egress or transport refusal: ours, already audited by the gate
      const refused = mcpPreHijackRefusal(err);
      if (refused) return refuse(refused.status, refused.body);
      if (classifyUpstreamError(err).why !== "our_own_refusal") {
        await recordUpstreamFailure(db, row, errMessage(err));
      }
      // the upstream's own text can carry its address or a token echo: it goes to the breaker row, not the answer
      const timedOut = isDeadlineError(err);
      return refuse(timedOut ? 504 : 502, {
        error: timedOut ? "mcp_upstream_timeout" : "mcp_upstream_unreachable",
        detail: timedOut
          ? `MCP server '${row.name}' did not answer in time. Nothing was stored; try again later.`
          : `MCP server '${row.name}' could not be reached. Nothing was stored; check that it is running and allowed by egress.`,
      });
    } finally {
      await client?.close().catch(() => {});
    }
  });
}
