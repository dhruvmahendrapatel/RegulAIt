/**
 * ADR-0190 slice I4 (review M3, recheck N2) — a LOST stdio session is the gateway's own refusal, never the
 * upstream's failure.
 *
 * When the gateway loses the executor side of a placed stdio session (the offer was withdrawn under a live
 * session, or the holding replica's lease on the session lapsed: `stdio-relay.ts`), the call fails at once. The MCP SDK would otherwise reject every pending request with a generic "Connection closed", which
 * the breaker charges to the upstream. Instead, the session's transport answers each pending request itself.
 *
 * The decision is IN-PROCESS STATE, never something a caller or a server can present: each answer carries a fresh
 * single-use nonce that this process records when the transport (which holds the session's `lostReason`) writes the
 * answer. The first time the resulting error is classified, the nonce is consumed, the error object is remembered
 * (a `WeakSet`), and its `data` is STRIPPED, so the nonce never reaches a client. An error that carries a nonce this
 * process never issued, or one already consumed (a replay of a value a client once saw), is the server's own error.
 */
import { randomBytes } from "node:crypto";
import { ErrorCode, McpError, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const MESSAGE = "the gateway lost this call's sandbox session (its own refusal, not the server's failure)";
/** nonces issued by a transport whose session was lost, not yet consumed (bounded: oldest dropped) */
const issued = new Set<string>();
const ISSUED_MAX = 4096;
/** the error objects recognised as ours */
const ours = new WeakSet<object>();

/** the JSON-RPC error answer the transport delivers for a request pending when the session was lost */
export function stdioSessionLostResponse(id: string | number, reason: string): JSONRPCMessage {
  const nonce = randomBytes(16).toString("hex");
  issued.add(nonce);
  if (issued.size > ISSUED_MAX) issued.delete(issued.values().next().value!);
  return { jsonrpc: "2.0", id, error: { code: ErrorCode.InternalError, message: `${MESSAGE}: ${reason}`, data: { regulaitStdioSessionLost: nonce } } } as JSONRPCMessage;
}

/** the same refusal as a thrown error (a request sent after the loss); it carries no data at all */
export function stdioSessionLostError(reason: string): McpError {
  const e = new McpError(ErrorCode.InternalError, `${MESSAGE}: ${reason}`);
  ours.add(e);
  return e;
}

/**
 * True only for an error this process produced from a lost session. The first recognition consumes the nonce and
 * strips `data` from the error, so nothing a client sees can be replayed.
 */
export function isStdioSessionLostError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if (ours.has(err)) return true;
  if (!(err instanceof McpError)) return false;
  const data = err.data as { regulaitStdioSessionLost?: unknown } | undefined;
  const nonce = typeof data === "object" && data !== null ? data.regulaitStdioSessionLost : undefined;
  if (typeof nonce !== "string" || !issued.delete(nonce)) return false;
  ours.add(err);
  (err as { data?: unknown }).data = undefined;
  return true;
}
