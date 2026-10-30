/**
 * ADR-0204 — a static upstream credential per MCP server (shared contract).
 *
 * An admin attaches ONE secret to a network MCP server. The gateway sends it on every request to that server's
 * registered origin, either as `Authorization: Bearer <secret>` (`bearer`) or as the raw value of a header the admin
 * names (`header`, e.g. `X-API-Key`). Off by default: a server with no credential sends nothing.
 *
 * The secret is write-only. Reads return `McpUpstreamCredentialView`: whether one is set, the scheme and header, the
 * last four characters, and who set it and when. The header refusals here are repeated as a CHECK in migration 0214.
 */
import { z } from "zod";
import { IDENTITY_ASSERTION_HEADER } from "./identity/mcp-identity-assertion.js";

export const MCP_UPSTREAM_CREDENTIAL_SCHEMES = ["bearer", "header"] as const;
export type McpUpstreamCredentialScheme = (typeof MCP_UPSTREAM_CREDENTIAL_SCHEMES)[number];

/** the header a `bearer` credential rides in (stored lowercased, like every header name) */
export const MCP_UPSTREAM_BEARER_HEADER = "authorization";

/** the bounds on a secret: long enough that its last four characters say little, short enough for one header */
export const MCP_UPSTREAM_SECRET_MIN = 16;
export const MCP_UPSTREAM_SECRET_MAX = 4096;
export const MCP_UPSTREAM_HEADER_NAME_MAX = 64;

/**
 * Header names a credential may never use: hop-by-hop headers, the ones the HTTP client or the MCP transport owns,
 * and our own (the identity assertion among them), so the credential can never collide with or replace any of them.
 */
export const MCP_UPSTREAM_RESERVED_HEADERS: readonly string[] = [
  "host",
  "cookie",
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
  "accept",
  "accept-encoding",
  "forwarded",
  "via",
  "origin",
  "referer",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
  IDENTITY_ASSERTION_HEADER.toLowerCase(),
];
/** reserved prefixes (`content-*` and the rest), checked with `startsWith` */
export const MCP_UPSTREAM_RESERVED_HEADER_PREFIXES: readonly string[] = ["content-", "proxy-", "sec-", "x-forwarded-", "regulait-", "x-regulait-"];

/** a token-character header name: letters, digits and hyphens, starting with a letter or digit (linear, anchored) */
const HEADER_NAME_SHAPE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Why `name` cannot carry a `header`-scheme credential, or null when it can. `name` is compared lowercased.
 * `Authorization` is refused here because the `bearer` scheme is how a credential rides in it.
 */
export function mcpUpstreamHeaderNameProblem(name: string): string | null {
  const n = name.trim().toLowerCase();
  if (n.length === 0) return "a header name is required for the header scheme";
  if (n.length > MCP_UPSTREAM_HEADER_NAME_MAX) return `a header name is at most ${MCP_UPSTREAM_HEADER_NAME_MAX} characters`;
  if (!HEADER_NAME_SHAPE.test(n)) return "a header name may use only letters, digits and hyphens, and starts with a letter or digit";
  if (n === MCP_UPSTREAM_BEARER_HEADER) return "to send the credential in Authorization, choose the Bearer scheme";
  if (MCP_UPSTREAM_RESERVED_HEADERS.includes(n)) return `'${name.trim()}' is reserved: the HTTP client, the MCP transport or RegulAIt sets it`;
  const prefix = MCP_UPSTREAM_RESERVED_HEADER_PREFIXES.find((p) => n.startsWith(p));
  if (prefix) return `headers starting '${prefix}' are reserved: the HTTP client, the MCP transport or RegulAIt sets them`;
  return null;
}

/** Why `secret` cannot be stored, or null. Printable ASCII with no spaces, so it can never split or inject a header. */
export function mcpUpstreamSecretProblem(secret: string): string | null {
  if (secret.length < MCP_UPSTREAM_SECRET_MIN) return `the secret must be at least ${MCP_UPSTREAM_SECRET_MIN} characters`;
  if (secret.length > MCP_UPSTREAM_SECRET_MAX) return `the secret must be at most ${MCP_UPSTREAM_SECRET_MAX} characters`;
  for (let i = 0; i < secret.length; i += 1) {
    const c = secret.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return "the secret may contain only printable characters, with no spaces or line breaks";
  }
  return null;
}

/**
 * `PUT /v1/servers/:serverId/upstream-credential`. `rotate` must say whether a credential is being replaced, so a
 * set never silently overwrites one and a rotation never silently creates one (409 otherwise).
 */
export const setMcpUpstreamCredentialSchema = z
  .object({
    scheme: z.enum(MCP_UPSTREAM_CREDENTIAL_SCHEMES),
    /** `header` only: the header to send the secret in */
    headerName: z.string().max(MCP_UPSTREAM_HEADER_NAME_MAX * 2).optional(),
    secret: z.string().max(MCP_UPSTREAM_SECRET_MAX * 2),
    rotate: z.boolean().optional(),
  })
  .strict();
export type SetMcpUpstreamCredential = z.infer<typeof setMcpUpstreamCredentialSchema>;

/** what any read shows: never the secret, nor any part of it but the last four characters */
export interface McpUpstreamCredentialView {
  set: boolean;
  scheme: McpUpstreamCredentialScheme | null;
  /** lowercased, as sent */
  headerName: string | null;
  last4: string | null;
  setBy: string | null;
  setAt: string | null;
}

export const MCP_UPSTREAM_CREDENTIAL_RULE_IDS = {
  set: "mcp-upstream-credential-set",
  rotated: "mcp-upstream-credential-rotated",
  cleared: "mcp-upstream-credential-cleared",
  clearedOnUrlMove: "mcp-upstream-credential-cleared-url-move",
  refused: "mcp-upstream-credential-refused",
  unavailable: "mcp-upstream-credential-unavailable",
} as const;
