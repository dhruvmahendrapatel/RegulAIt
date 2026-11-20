/**
 * ADR-0311 (lane E1, G10): the MCP transport rules the gateway's `/mcp/:serverId` endpoint enforces itself, before
 * the SDK transport runs, so a refused request never reaches an upstream.
 *
 * Both rules are MUSTs in every protocol revision the gateway serves (2025-03-26 through 2025-11-25) and carry
 * forward into 2026-07-28 (Streamable HTTP transport, "Security Warning"; "Sending Messages to the Server").
 *
 * 1. Origin. Servers MUST validate the `Origin` header on incoming requests, against DNS rebinding. The gateway
 *    serves no CORS, so the only browser origin that may call it is its own public URL (REGULAIT_PUBLIC_URL). A
 *    request with no `Origin` is not from a browser page and passes; any other origin is refused (403). With no
 *    public URL set, every request that carries an `Origin` is refused (ADR-0180: strict when unknown).
 *    The SDK's own check (`enableDnsRebindingProtection`/`allowedOrigins`) is not used: it runs only after the
 *    gateway has opened the upstream session for the request, and it lets everything through when the list is empty.
 * 2. Batching. JSON-RPC batches were removed in 2025-06-18 ("each POST body is a single JSON-RPC message"), and
 *    2026-07-28 keeps that. The SDK still accepts arrays, so the gateway refuses a batch whenever the request's
 *    `MCP-Protocol-Version` is 2025-06-18 or later. An older client (no header, or 2025-03-26, where batching was
 *    defined) keeps the old behaviour.
 */
/** the first revision without JSON-RPC batching */
export const MCP_BATCHLESS_SINCE = "2025-06-18";

/** the origin a browser page calling the gateway must have: its public URL's (already validated by
 * `resolvePublicUrl`), or null when none is set */
export function allowedMcpOrigin(publicUrl: string | null): string | null {
  if (!publicUrl) return null;
  try {
    return new URL(publicUrl).origin;
  } catch {
    return null;
  }
}

/** null when the request's Origin is acceptable, else the refusal */
export function mcpOriginRefusal(originHeader: string | string[] | undefined, publicUrl: string | null): { status: 403; error: string; detail: string } | null {
  if (originHeader === undefined) return null;
  const origin = Array.isArray(originHeader) ? originHeader.join(",") : originHeader;
  const allowed = allowedMcpOrigin(publicUrl);
  if (allowed !== null && origin === allowed) return null;
  return {
    status: 403,
    error: "mcp_origin_refused",
    detail: allowed
      ? `this MCP endpoint accepts a browser Origin only from ${allowed}`
      : "this MCP endpoint refuses browser requests: no public URL is configured, so no Origin can be checked",
  };
}

/** true when the body is a JSON-RPC batch the request's protocol version does not allow */
export function mcpBatchRefused(body: unknown, protocolVersionHeader: string | string[] | undefined): boolean {
  if (!Array.isArray(body)) return false;
  const v = Array.isArray(protocolVersionHeader) ? protocolVersionHeader[0] : protocolVersionHeader;
  // revisions are ISO dates, so they compare as strings; an absent header is the 2025-03-26 default
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && v >= MCP_BATCHLESS_SINCE;
}

/** the JSON-RPC error a refused batch is answered with (no id: a batch has none of its own) */
export const MCP_BATCH_REFUSAL = {
  jsonrpc: "2.0",
  id: null,
  error: { code: -32600, message: `Invalid Request: JSON-RPC batching is not supported from protocol version ${MCP_BATCHLESS_SINCE}; send one message per POST` },
} as const;
