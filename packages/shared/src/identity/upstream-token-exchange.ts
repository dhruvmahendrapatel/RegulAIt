/**
 * ADR-0238 (backlog P12(d)) — DOWN-SCOPED UPSTREAM CREDENTIALS BY RFC 8693 TOKEN EXCHANGE (shared contract).
 *
 * The gateway, acting as an OAuth CLIENT of an upstream's own authorization server, exchanges a short-lived subject
 * token that speaks for the calling person (our ADR-0210 OIDC identity assertion) for an access token audienced to
 * ONE upstream and scoped to exactly the scopes an admin mapped to the ONE tool (MCP) or operation (connector) that
 * was just allowed. Default-deny: an action with no mapped scope is refused before anything is sent. Off by default:
 * a target with no enabled configuration exchanges nothing; enabling one is a `settings_relax` step-up.
 *
 * This file is the contract the gateway and (later) the admin UI share: the wire constants, the bounds, the rule ids
 * and the admin request schema. Nothing here ever carries a token or a secret value.
 */
import { z } from "zod";

/** RFC 8693 §3: the token type of the subject token we present (our signed OIDC assertion is a JWT) */
export const TOKEN_TYPE_JWT = "urn:ietf:params:oauth:token-type:jwt";

/** the upstream token's lifetime, in seconds: never more than this, whatever an admin or the upstream says */
export const UPSTREAM_EXCHANGE_TTL_CEILING_SECONDS = 900;
/** the floor an admin may set (a shorter one would expire in flight) */
export const UPSTREAM_EXCHANGE_TTL_FLOOR_SECONDS = 30;
/** the default lifetime ceiling of a new configuration (strict: five minutes) */
export const UPSTREAM_EXCHANGE_TTL_DEFAULT_SECONDS = 300;
/** the clock skew tolerated when an issued JWT's `exp`/`iat` is compared with the database clock */
export const UPSTREAM_EXCHANGE_CLOCK_SKEW_SECONDS = 30;
/** the bound on an issued access token we will hold (a larger answer is refused, never truncated) */
export const UPSTREAM_EXCHANGE_MAX_TOKEN_BYTES = 8 * 1024;
/** the bound on the token endpoint's whole response body */
export const UPSTREAM_EXCHANGE_MAX_RESPONSE_BYTES = 32 * 1024;
/** the bounds on the admin scope map */
export const UPSTREAM_EXCHANGE_MAX_ACTIONS = 256;
export const UPSTREAM_EXCHANGE_MAX_SCOPES_PER_ACTION = 32;

/** RFC 6749 §3.3 scope-token: 1*( %x21 / %x23-5B / %x5D-7E ), bounded */
export const SCOPE_TOKEN_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/;
/** an action key: an MCP tool name, an MCP JSON-RPC method (`resources/read`) or a connector operation */
export const EXCHANGE_ACTION_PATTERN = /^[A-Za-z0-9_.:/-]{1,128}$/;

export const UPSTREAM_EXCHANGE_TARGET_KINDS = ["mcp_server", "connector"] as const;
export type UpstreamExchangeTargetKind = (typeof UPSTREAM_EXCHANGE_TARGET_KINDS)[number];

/** the audit rule ids (one per outcome; codes ride in `detail.code`) */
export const UPSTREAM_EXCHANGE_RULE_IDS = {
  /** an exchanged token was obtained and attached to one governed call */
  issued: "upstream-token-exchange-issued",
  /** a governed call was refused because no acceptable down-scoped token could be obtained (nothing was sent) */
  refused: "upstream-token-exchange-refused",
  /** admin writes */
  set: "upstream-token-exchange-set",
  updated: "upstream-token-exchange-updated",
  cleared: "upstream-token-exchange-cleared",
  configRefused: "upstream-token-exchange-config-refused",
} as const;

/**
 * The refusal codes of a call-time exchange. Each is OUR refusal: the governed call is denied, audited, and the
 * upstream receives nothing (neither the call nor any token).
 */
export const UPSTREAM_EXCHANGE_REFUSAL_CODES = [
  "not_configured_for_action", // default-deny: no scope is mapped to this tool/operation
  "disabled",
  "secret_unavailable", // no data key, or the client secret does not decrypt
  "issuer_not_configured",
  "signing_key_unavailable",
  "egress_blocked", // the token endpoint is not an allowed destination
  "endpoint_unreachable",
  "endpoint_error", // a non-200 answer (its body is never stored)
  "malformed_response",
  "token_type_unsupported", // not a Bearer access token
  "token_too_large",
  "expiry_missing",
  "expiry_too_long",
  "expired",
  "scope_widened",
  "audience_mismatch",
  "token_replayed", // the same token was handed out before (to this or another person): never reused
  "audit_failed",
  "profile_conflict", // the server already sends its own Authorization (oidc_bearer profile)
] as const;
export type UpstreamExchangeRefusalCode = (typeof UPSTREAM_EXCHANGE_REFUSAL_CODES)[number];

const httpsUrl = z
  .string()
  .min(1)
  .max(2048)
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.protocol === "https:" && u.username === "" && u.password === "" && u.hash === "";
    } catch {
      return false;
    }
  }, "must be an absolute https URL with no credentials or fragment");

const scopeList = z.array(z.string().regex(SCOPE_TOKEN_PATTERN)).min(1).max(UPSTREAM_EXCHANGE_MAX_SCOPES_PER_ACTION);

/**
 * `PUT /v1/{servers|connectors}/:id/token-exchange`. `clientSecret` is required when the configuration is created and
 * optional on an update (absent = keep the stored one; present = rotate it). Unknown keys are refused.
 */
export const setUpstreamTokenExchangeSchema = z
  .object({
    enabled: z.boolean(),
    tokenEndpoint: httpsUrl,
    /** the `aud` of the subject token we present: the upstream authorization server's own identifier */
    subjectTokenAudience: z.string().min(1).max(512),
    /** RFC 8693 `audience`: the ONE upstream the issued token is for (pinned; never taken from a call) */
    audience: z.string().min(1).max(512),
    /** RFC 8707 `resource`, when the upstream's authorization server wants one */
    resource: httpsUrl.optional(),
    clientId: z.string().min(1).max(256).regex(/^[\x21-\x7E]+$/),
    clientSecret: z.string().min(16).max(512).regex(/^[\x21-\x7E]+$/).optional(),
    maxTokenTtlSeconds: z.number().int().min(UPSTREAM_EXCHANGE_TTL_FLOOR_SECONDS).max(UPSTREAM_EXCHANGE_TTL_CEILING_SECONDS).optional(),
    /** action → the scopes a person entitled to that action may receive for it (default-deny: unmapped = refused) */
    scopes: z
      .record(z.string().regex(EXCHANGE_ACTION_PATTERN), scopeList)
      .refine((m) => Object.keys(m).length <= UPSTREAM_EXCHANGE_MAX_ACTIONS, `at most ${UPSTREAM_EXCHANGE_MAX_ACTIONS} actions`),
  })
  .strict();
export type SetUpstreamTokenExchange = z.infer<typeof setUpstreamTokenExchangeSchema>;

/** what any read shows: never the secret, only its last four characters */
export interface UpstreamTokenExchangeView {
  configured: boolean;
  enabled: boolean;
  tokenEndpoint: string | null;
  subjectTokenAudience: string | null;
  audience: string | null;
  resource: string | null;
  clientId: string | null;
  clientSecretLast4: string | null;
  maxTokenTtlSeconds: number | null;
  scopes: Record<string, string[]>;
  setBy: string | null;
  secretSetAt: string | null;
}

/** the space-separated scope string of a list (RFC 6749 §3.3), sorted and de-duplicated so it is canonical */
export function canonicalScope(scopes: Iterable<string>): string {
  return [...new Set(scopes)].sort().join(" ");
}

/** a scope string split into its tokens (empty for an absent or blank value) */
export function scopeTokens(scope: string | null | undefined): string[] {
  if (typeof scope !== "string") return [];
  return scope.split(" ").filter((s) => s.length > 0);
}
