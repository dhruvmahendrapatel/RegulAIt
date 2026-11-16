/**
 * The one parser for a route-scoped, prefixed bearer credential (`rgldi_…`, `rgti_…`, the endpoint-agent tokens).
 *
 * Reads only `Authorization: Bearer <value>`: no cookie, no x-api-key, no query string. The auth-scheme is
 * case-insensitive (RFC 9110 §11.1, as in auth.ts). The value must be exactly `prefix` followed by `length`
 * characters of `charset`; anything else is null. The check walks characters with a fixed length bound, so no regular
 * expression runs on caller input.
 *
 * Open source first (ADR-0176): @fastify/bearer-auth compares against a fixed key list and is a plugin hook, not a
 * per-route parse of a hash-looked-up token, so it does not fit; this is the narrow shared parse.
 */
import type { FastifyRequest } from "fastify";

export type BearerCharset = "hex" | "base64url";

const isHex = (c: string) => (c >= "0" && c <= "9") || (c >= "a" && c <= "f");
const isBase64url = (c: string) => (c >= "0" && c <= "9") || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "-" || c === "_";

/** the presented `prefix` + `length` × `charset` token, or null */
export function prefixedBearer(req: FastifyRequest, prefix: string, length: number, charset: BearerCharset): string | null {
  const h = req.headers.authorization;
  if (typeof h !== "string" || h.length > 7 + prefix.length + length + 8) return null;
  if (h.slice(0, 7).toLowerCase() !== "bearer ") return null;
  const v = h.slice(7).trim();
  if (v.length !== prefix.length + length || !v.startsWith(prefix)) return null;
  const ok = charset === "hex" ? isHex : isBase64url;
  for (const c of v.slice(prefix.length)) if (!ok(c)) return null;
  return v;
}
