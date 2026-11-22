/**
 * ADR-0311 decision 4, slice 1 — the MCP 2026-07-28 (stateless, per-request envelope) protocol on
 * `POST /mcp/:serverId`, beside the unchanged 2025-era path.
 *
 * The route (`mcp-proxy.ts`) runs every refusal it has always run first (origin, batch, auth, attribution, the
 * disabled server, the stdio entitlement, admission and egress preflight, the breaker, the manifest connect). Only
 * then is a request the official v2 SDK classifies as modern (`isLegacyRequest` false) served here, through
 * `createMcpHandler` with `legacy: 'reject'`. The SDK owns the 2026-07-28 wire: `server/discover`, the envelope and
 * header validation ladder (`-32020` header mismatch, `-32022` unsupported revision), `resultType`, and the
 * `ttlMs: 0` / `cacheScope: 'private'` defaults. RegulAIt owns only the governance: `tools/list` and `tools/call`
 * call the SAME functions the 2025-era handlers call (`listToolsForCaller`, `callToolForCaller`), so entitlements,
 * approvals, scans, cost and audit cannot differ between eras.
 *
 * Slice 1 serves `tools/*` only. Every other method answers `-32601` with an audit row (`mcp-method-unsupported`),
 * and `subscriptions/listen`, which the SDK would serve itself from an in-process bus, is refused before the
 * handler runs. Nothing here opens an upstream: the route connects only for a `tools/list`, so a `server/discover`
 * probe never reaches the upstream server.
 *
 * This module imports nothing from `mcp-proxy.ts` (the shared functions are passed in), so the import graph has no
 * cycle.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  createMcpHandler,
  isLegacyRequest,
  ProtocolError,
  ProtocolErrorCode,
  Server as ModernServer,
  type CallToolResult,
  type JSONRPCRequest,
  type Tool as ModernTool,
} from "@modelcontextprotocol/server";
import { auditLog, type Db } from "@regulait/db";
import { recordDecision } from "./metrics.js";

/** the revision this module serves; the SDK's own list decides what it accepts */
export const MCP_MODERN_REVISION = "2026-07-28";

/** headers never copied into the in-process web request: hop-by-hop, and the caller's credentials (already used) */
const NOT_FORWARDED = new Set(["authorization", "cookie", "proxy-authorization", "host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"]);

/**
 * The Fastify request as a web `Request` for the SDK (headers only: the body is already parsed and is handed over as
 * `parsedBody`). The URL's origin is a fixed placeholder: the SDK's entry does no host or origin checks (the route
 * ran `mcpOriginRefusal` first).
 */
export function toWebRequest(req: FastifyRequest, signal?: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || NOT_FORWARDED.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return new Request(new URL(req.url, "http://regulait-gateway.invalid"), {
    method: req.method,
    headers,
    ...(signal ? { signal } : {}),
  });
}

/** true when the v2 SDK would serve this request on its 2026-07-28 path (the SDK's own classification) */
export async function isModernMcpRequest(req: FastifyRequest): Promise<boolean> {
  try {
    return !(await isLegacyRequest(toWebRequest(req), req.body));
  } catch {
    // unclassifiable: the 2025-era path, whose transport answers a malformed request itself (behaviour unchanged)
    return false;
  }
}

/** code-point order by name: the 2026-07-28 revision asks for a deterministic tools/list order */
export function sortToolsByName<T extends { name: string }>(tools: readonly T[]): T[] {
  return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export interface ModernMcpContext {
  db: Db;
  userId: string;
  serverId: string;
  projectId: string | null;
  /** the shared `tools/list` (mcp-proxy.ts `listToolsForCaller`) */
  listTools: () => Promise<{ tools: unknown[] }>;
  /** the shared `tools/call` (mcp-proxy.ts `callToolForCaller`) */
  /** `signal`: ADR-0364 S3 (review B), the exchange's abort (the client left), so a robot run is cancelled with it */
  callTool: (name: string, args: Record<string, unknown> | undefined, signal?: AbortSignal) => Promise<Record<string, unknown>>;
  /** closes whatever upstream session the route opened (its own close-on-disconnect stays registered) */
  closeUpstream: () => void;
}

/** audit text: a client-chosen method name, bounded */
const methodLabel = (method: string) => method.slice(0, 200);

/** one deny row for a method the 2026-07-28 path does not serve (the G3 `mcp-method-unsupported` vocabulary) */
async function auditMethodNotServed(ctx: ModernMcpContext, method: string): Promise<string> {
  const reason = `MCP method '${methodLabel(method)}' is not served on the ${MCP_MODERN_REVISION} protocol path of this gateway`;
  await ctx.db.insert(auditLog).values({
    userId: ctx.userId,
    serverId: ctx.serverId,
    detail: { receiptClass: "decision", phase: "protocol", method: methodLabel(method), projectId: ctx.projectId, protocolRevision: MCP_MODERN_REVISION },
    effect: "deny",
    ruleId: "mcp-method-unsupported",
    ruleChain: [],
    reason,
  });
  recordDecision({ surface: "mcp_protocol", effect: "deny" });
  return reason;
}

/** the per-request v2 server: `tools` only, both handlers the shared governance functions */
export function buildModernServer(ctx: ModernMcpContext, signal?: AbortSignal): ModernServer {
  const server = new ModernServer({ name: "regulait-gateway", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", async () => {
    const { tools } = await ctx.listTools();
    return { tools: sortToolsByName(tools as ModernTool[]) };
  });
  server.setRequestHandler("tools/call", async (request) => {
    const result = await ctx.callTool(request.params.name, request.params.arguments as Record<string, unknown> | undefined, signal);
    return server.projectCallToolResult(result as CallToolResult, undefined);
  });
  server.fallbackRequestHandler = async (request: JSONRPCRequest) => {
    const reason = await auditMethodNotServed(ctx, request.method);
    throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Method not found: ${reason}`);
  };
  return server;
}

/**
 * Serve one 2026-07-28 request. The response is read in full before it is sent, so the upstream session is closed
 * only after the handler has finished; a client that leaves aborts the exchange.
 */
export async function serveModernMcp(req: FastifyRequest, reply: FastifyReply, ctx: ModernMcpContext): Promise<FastifyReply> {
  const body = req.body as { method?: unknown; id?: unknown } | undefined;
  // The SDK would serve `subscriptions/listen` itself (an in-process event bus) before any handler of ours runs; a
  // stateless proxy has nothing to stream, so it is refused here, in band, with its audit row.
  if (body && typeof body === "object" && body.method === "subscriptions/listen") {
    const reason = await auditMethodNotServed(ctx, "subscriptions/listen");
    ctx.closeUpstream();
    const id = typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
    return reply.status(200).send({ jsonrpc: "2.0", id, error: { code: ProtocolErrorCode.MethodNotFound, message: `Method not found: ${reason}` } });
  }
  const abort = new AbortController();
  reply.raw.on("close", () => abort.abort());
  const handler = createMcpHandler(() => buildModernServer(ctx, abort.signal), {
    legacy: "reject",
    onerror: (err) => req.log.debug({ err }, "mcp 2026-07-28 exchange reported an error"),
  });
  try {
    const res = await handler.fetch(toWebRequest(req, abort.signal), { parsedBody: req.body });
    const text = await res.text();
    reply.status(res.status);
    res.headers.forEach((value, name) => {
      if (name !== "content-length") reply.header(name, value);
    });
    return reply.send(text);
  } finally {
    await handler.close().catch(() => undefined);
    ctx.closeUpstream();
  }
}
