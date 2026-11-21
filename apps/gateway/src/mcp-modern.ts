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
 * Slice 1 served `tools/*`. Slice 2 serves the governed non-tool methods (ADR-0185 G3: `resources/list`,
 * `resources/templates/list`, `resources/read`, `prompts/list`, `prompts/get`, `completion/complete`) through the SAME
 * function the 2025-era protocol surface calls (`protocolCallForCaller`), so the org switch, the kernel decision on
 * the `mcp:*` grant, data scopes, approvals, scans, provenance and audit cannot differ either. The capabilities are
 * the 2025-era `protocolCapabilities(...)` of the org's enabled methods, minus `logging` (2026-07-28 removed
 * `logging/setLevel`). What 2026-07-28 changed is left to the SDK: resource-not-found `-32002` is re-coded `-32602`,
 * and list results carry `resultType` and the `ttlMs: 0` / `cacheScope: 'private'` defaults. Only `tools/list` is
 * sorted (the revision's SHOULD names tools/list alone; the other lists keep the upstream's order and cursors).
 *
 * Notifications: progress for the caller's own request is relayed on that request's response stream
 * (`ctx.mcpReq.notify`; the SDK upgrades the answer to SSE), under the same org rule as the 2025-era path. Upstream
 * log messages are never relayed here: 2026-07-28 forbids `notifications/message` unless the request set a
 * per-request log level, which this gateway does not offer.
 *
 * Refusals: an unknown method answers `-32601` with an audit row (`mcp-method-unsupported`); a method the SDK
 * answers `-32601` itself because the revision removed it (`logging/setLevel`, `ping`, `resources/subscribe`, ...)
 * gets the same audit row after the fact; `subscriptions/listen`, which the SDK would serve itself from an
 * in-process bus, is refused before the handler runs. Nothing here opens an upstream: the route connects only for a
 * `tools/list`, and the protocol primitive connects only after an allow, so a `server/discover` probe never reaches
 * the upstream server.
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
  type ServerCapabilities as ModernServerCapabilities,
  type Tool as ModernTool,
} from "@modelcontextprotocol/server";
import { auditLog, type Db } from "@regulait/db";
import { MCP_PROTOCOL_METHODS, MCP_PROTOCOL_REFUSED_METHODS } from "@regulait/shared";
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
  callTool: (name: string, args: Record<string, unknown> | undefined) => Promise<Record<string, unknown>>;
  /**
   * The capabilities to advertise: the 2025-era `protocolCapabilities(...)` of the org's enabled methods with
   * `logging/setLevel` left out (`tools` is always added here).
   */
  capabilities: Record<string, unknown>;
  /** the shared governed non-tool request (mcp-proxy.ts `protocolCallForCaller`) */
  protocolCall: (
    method: string,
    params: Record<string, unknown> | undefined,
    extra: {
      relay: (n: { method: string; params?: Record<string, unknown> }) => Promise<void>;
      progressToken?: string | number;
      relayLogMessages: false;
    },
  ) => Promise<Record<string, unknown>>;
  /** closes whatever upstream session the route opened (its own close-on-disconnect stays registered) */
  closeUpstream: () => void;
}

/**
 * The non-tool methods served through the shared protocol primitive: the governed vocabulary minus
 * `logging/setLevel` (removed in 2026-07-28), plus the always-refused ones, so a refused method that reaches us is
 * decided and audited exactly as on the 2025-era path.
 */
export function isModernProtocolMethod(method: string): boolean {
  if (method === "logging/setLevel") return false;
  if ((MCP_PROTOCOL_METHODS as readonly string[]).includes(method)) return true;
  return MCP_PROTOCOL_REFUSED_METHODS.some((m) => (m.endsWith("/") ? method.startsWith(m) : method === m));
}

/** the 2025-era capabilities input for this path: the org's enabled methods without `logging/setLevel` */
export function modernProtocolMethods(enabled: readonly string[]): string[] {
  return enabled.filter((m) => m !== "logging/setLevel");
}

/** audit text: a client-chosen method name, bounded */
const methodLabel = (method: string) => method.slice(0, 200);

/** one deny row for a method the 2026-07-28 path does not serve (the G3 `mcp-method-unsupported` vocabulary) */
async function auditMethodNotServed(ctx: ModernMcpContext, method: string, answeredBy: "gateway" | "sdk" = "gateway"): Promise<string> {
  const reason =
    answeredBy === "sdk"
      ? `MCP method '${methodLabel(method)}' is not a client-to-server request of protocol revision ${MCP_MODERN_REVISION}`
      : `MCP method '${methodLabel(method)}' is not served on the ${MCP_MODERN_REVISION} protocol path of this gateway`;
  await ctx.db.insert(auditLog).values({
    userId: ctx.userId,
    serverId: ctx.serverId,
    detail: { receiptClass: "decision", phase: "protocol", method: methodLabel(method), projectId: ctx.projectId, protocolRevision: MCP_MODERN_REVISION, answeredBy },
    effect: "deny",
    ruleId: "mcp-method-unsupported",
    ruleChain: [],
    reason,
  });
  recordDecision({ surface: "mcp_protocol", effect: "deny" });
  return reason;
}

/** which of our handlers ran for this exchange: none = the SDK answered by itself */
interface ExchangeState {
  handled: boolean;
}

/**
 * The per-request v2 server: `tools` through the shared tool functions, the governed non-tool methods through the
 * shared protocol primitive, anything else an audited `-32601`.
 */
export function buildModernServer(ctx: ModernMcpContext, state: ExchangeState = { handled: false }): ModernServer {
  const server = new ModernServer(
    { name: "regulait-gateway", version: "0.1.0" },
    { capabilities: { ...(ctx.capabilities as ModernServerCapabilities), tools: {} } },
  );
  server.setRequestHandler("tools/list", async () => {
    state.handled = true;
    const { tools } = await ctx.listTools();
    return { tools: sortToolsByName(tools as ModernTool[]) };
  });
  server.setRequestHandler("tools/call", async (request) => {
    state.handled = true;
    const result = await ctx.callTool(request.params.name, request.params.arguments as Record<string, unknown> | undefined);
    return server.projectCallToolResult(result as CallToolResult, undefined);
  });
  server.fallbackRequestHandler = async (request: JSONRPCRequest, sctx) => {
    state.handled = true;
    if (isModernProtocolMethod(request.method)) {
      const progressToken = sctx.mcpReq._meta?.progressToken;
      // the primitive's v1 McpError carries `code` and `data`, which the SDK copies onto the wire (re-coding
      // `-32002` resource-not-found as `-32602` for this revision)
      return (await ctx.protocolCall(request.method, request.params as Record<string, unknown> | undefined, {
        relay: (n) => sctx.mcpReq.notify(n as never),
        ...(progressToken !== undefined ? { progressToken } : {}),
        relayLogMessages: false,
      })) as never;
    }
    const reason = await auditMethodNotServed(ctx, request.method);
    throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Method not found: ${reason}`);
  };
  return server;
}

/** the JSON-RPC error code of a plain JSON answer, if it is one */
function jsonErrorCode(text: string): number | undefined {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown } };
    return typeof parsed?.error?.code === "number" ? parsed.error.code : undefined;
  } catch {
    return undefined;
  }
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
  const state: ExchangeState = { handled: false };
  const handler = createMcpHandler(() => buildModernServer(ctx, state), {
    legacy: "reject",
    onerror: (err) => req.log.debug({ err }, "mcp 2026-07-28 exchange reported an error"),
  });
  try {
    const res = await handler.fetch(toWebRequest(req, abort.signal), { parsedBody: req.body });
    const text = await res.text();
    // a method the revision removed (`logging/setLevel`, `ping`, ...) is answered -32601 by the SDK before any
    // handler of ours runs; it still gets its audit row
    if (!state.handled && body && typeof body.method === "string" && jsonErrorCode(text) === ProtocolErrorCode.MethodNotFound) {
      await auditMethodNotServed(ctx, body.method, "sdk");
    }
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
