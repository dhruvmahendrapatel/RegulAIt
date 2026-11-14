/**
 * ADR-0288 — PROVIDER-SHAPED 401s ON THE COMPAT SURFACES (PENDING P33 follow-up).
 *
 * The shared auth hook answers every route with RegulAIt's own refusal body
 * (`{"error":"unauthenticated"}`, `{"error":"api_key_expired","detail":…}`).
 * An off-the-shelf OpenAI or Anthropic client pointed at a compat surface then
 * gets a 401 it cannot read: the SDKs look for `error.message` (and Anthropic's
 * for `type: "error"`), so the holder of a bad key sees an empty or generic
 * error instead of "your key is invalid".
 *
 * The fix does NOT touch the auth hook. Who is refused, and why, stays decided
 * in exactly one place. This module only RE-ENVELOPES an already-decided 401 in
 * the onSend phase, for the compat routes alone:
 *
 *  - only status 401 (a 403 is an entitlement answer the shims already shape);
 *  - only a RegulAIt refusal body (`error` is a string); a body that is already
 *    provider-shaped (`error` is an object) passes through byte-identical;
 *  - the RegulAIt code survives as `error.code` / `error.regulait_code`, and the
 *    refusal detail (when there is one) becomes the message, so nothing an
 *    operator or a client could key on is lost;
 *  - every header the hook set (the MCP route's RFC 9728 challenge, cookies,
 *    security headers) is untouched; the MCP route is not a compat dialect and
 *    is not reshaped.
 */

import type { FastifyRequest } from "fastify";
import { anthropicError } from "./compat-anthropic.js";
import { openaiError } from "./compat-openai.js";
import { modelsShapeFor } from "./compat-models.js";

export type CompatDialect = "openai" | "anthropic";

/** The compat routes and their wire dialect. `GET /v1/models` serves both and
 * picks by the `anthropic-version` header, exactly as its handler does.
 * `POST /v1/responses` is ADR-0287's surface; until that route is registered
 * the entry never matches. */
const COMPAT_401_DIALECT: Readonly<Record<string, CompatDialect | ((req: FastifyRequest) => CompatDialect)>> = {
  "POST /v1/messages": "anthropic",
  "POST /v1/chat/completions": "openai",
  "POST /v1/responses": "openai",
  "GET /v1/models": (req) => modelsShapeFor(req),
};

/** The dialect a 401 on this request is enveloped in, or null when the route is not a compat surface. */
export function compatDialectFor(req: FastifyRequest): CompatDialect | null {
  const entry = COMPAT_401_DIALECT[`${req.method} ${req.routeOptions.url ?? ""}`];
  if (entry === undefined) return null;
  return typeof entry === "function" ? entry(req) : entry;
}

/** A readable message for each RegulAIt 401 code that carries no detail of its own. */
const MESSAGE_FOR_CODE: Readonly<Record<string, string>> = {
  unauthenticated:
    "Invalid or missing API key. Send a RegulAIt API key or virtual key as a Bearer token" +
    " (the /v1/messages surface also accepts it in x-api-key).",
};

/**
 * Re-envelopes a serialized RegulAIt 401 body in the given dialect. Returns
 * null when the payload is not a RegulAIt refusal (not JSON, not an object, or
 * `error` is not a string): the caller then sends the payload unchanged.
 */
export function reshapeCompat401(payload: unknown, dialect: CompatDialect): string | null {
  if (typeof payload !== "string") return null;
  let body: unknown;
  try {
    body = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { error, detail } = body as { error?: unknown; detail?: unknown };
  if (typeof error !== "string" || error.length === 0) return null;
  const message =
    typeof detail === "string" && detail.length > 0
      ? detail
      : (MESSAGE_FOR_CODE[error] ?? `Authentication failed (${error}).`);
  return JSON.stringify(dialect === "anthropic" ? anthropicError(401, error, message) : openaiError(401, error, message));
}
