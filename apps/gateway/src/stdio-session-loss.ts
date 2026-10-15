/**
 * ADR-0190 slice I4 (review M3) — a LOST stdio session is the gateway's own refusal, never the upstream's failure.
 *
 * When the gateway loses the executor side of a placed stdio session (the executor ended the offer under a live
 * session, typically because a window or its stdout reached a replica that does not hold the session), the call
 * fails at once. The MCP SDK would otherwise reject every pending request with a generic "Connection closed", which
 * the breaker charges to the upstream. Instead, the session's transport answers each pending request itself with a
 * JSON-RPC error that carries this process's random marker in `error.data`; the SDK turns that into an `McpError`
 * with the same `data`, and `isStdioSessionLostError` recognises it. The marker never leaves this process (it is
 * never written to a sandbox), so a server cannot forge it to escape its own breaker.
 */
import { randomBytes } from "node:crypto";
import { ErrorCode, McpError, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const MARKER = randomBytes(16).toString("hex");

/** the JSON-RPC error answer the transport delivers for a request pending when the session was lost */
export function stdioSessionLostResponse(id: string | number, reason: string): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: ErrorCode.InternalError,
      message: `the gateway lost this call's sandbox session (its own refusal, not the server's failure): ${reason}`,
      data: { regulaitStdioSessionLost: MARKER },
    },
  } as JSONRPCMessage;
}

/** the same refusal as a thrown error (a request sent after the loss) */
export function stdioSessionLostError(reason: string): McpError {
  return new McpError(ErrorCode.InternalError, `the gateway lost this call's sandbox session (its own refusal, not the server's failure): ${reason}`, {
    regulaitStdioSessionLost: MARKER,
  });
}

/** true for the error the SDK raises from `stdioSessionLostResponse` (and only from it) */
export function isStdioSessionLostError(err: unknown): boolean {
  if (!(err instanceof McpError)) return false;
  const data = err.data as { regulaitStdioSessionLost?: unknown } | undefined;
  return typeof data === "object" && data !== null && data.regulaitStdioSessionLost === MARKER;
}
