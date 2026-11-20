/**
 * ADR-0315 (G7): the portable, offline-verifiable agent credential. The contract that RegulAIt's issuer and any
 * third-party verifier (Kong, agentgateway, a SaaS MCP server, lane E5's outside coding agents) share: paths, the
 * token type, the header, the claim set and the bounds. Pure constants, types and schemas: no database, no network.
 *
 * A credential is a signed PROJECTION of one live delegation grant onto one REGISTERED audience. It never carries
 * more than the grant holds (scope is the intersection of the grant's scope with the audience's scope map), and the
 * grant already never exceeds its sponsor's entitlements or its parent's budget (ADR-0188 S3).
 */
import { z } from "zod";
import { CLIENT_ASSERTION_TYPE_JWT_BEARER, TOKEN_EXCHANGE_GRANT_TYPE, TOKEN_TYPE_ACCESS_TOKEN } from "./identity/contract.js";

/** the issuer is `<public URL>` + this path; its metadata and keys live under it */
export const AGENT_CREDENTIAL_ISSUER_PATH = "/agent-credentials";
export const AGENT_CREDENTIAL_DISCOVERY_PATH = `${AGENT_CREDENTIAL_ISSUER_PATH}/.well-known/openid-configuration`;
export const AGENT_CREDENTIAL_JWKS_PATH = `${AGENT_CREDENTIAL_ISSUER_PATH}/.well-known/jwks.json`;

/** RFC 8693 `requested_token_type` for an agent credential */
export const AGENT_CREDENTIAL_TOKEN_TYPE = "urn:regulait:params:oauth:token-type:agent-credential";
/** RFC 9068 §2.1 header `typ`, so standard JWT access-token verifiers accept it */
export const AGENT_CREDENTIAL_TYP = "at+jwt";

/** lifetime bounds in seconds: 300 by default; longer than the default is an audited relaxation; never above 900 */
export const AGENT_CREDENTIAL_TTL_MIN_SECONDS = 60;
export const AGENT_CREDENTIAL_TTL_DEFAULT_SECONDS = 300;
export const AGENT_CREDENTIAL_TTL_MAX_SECONDS = 900;
/** the clock leeway a verifier may allow on `exp`, `nbf` and `iat` */
export const AGENT_CREDENTIAL_LEEWAY_SECONDS = 30;
/** the deepest `act` chain (the delegation depth limit) */
export const AGENT_CREDENTIAL_MAX_CHAIN = 8;

/** the algorithms an audience may pin; ES256 is the default (the most widely supported by gateways) */
export const AGENT_CREDENTIAL_ALGORITHMS = ["ES256", "EdDSA"] as const;
export type AgentCredentialAlgorithm = (typeof AGENT_CREDENTIAL_ALGORITHMS)[number];
/** how the credential is bound to its holder: DPoP (RFC 9449) by default; bearer is an audited relaxation */
export const AGENT_CREDENTIAL_BINDINGS = ["dpop", "bearer"] as const;
export type AgentCredentialBinding = (typeof AGENT_CREDENTIAL_BINDINGS)[number];

/** the step-up facts key an audience registration or relaxation is bound to */
export const AGENT_CREDENTIAL_STEP_UP_KEY = "agentCredentialAudience";

/** one `scope` string at an audience: RFC 6749 §3.3 scope-token characters, at most 128 */
export const AGENT_CREDENTIAL_SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/;

/** an audience URI: https, no credentials, query or fragment, at most 512 characters */
export function audienceUriProblem(raw: string): string | null {
  if (raw.length > 512) return "the audience is longer than 512 characters";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "the audience is not a URL";
  }
  if (u.protocol !== "https:") return "the audience must be an https URL";
  if (u.username || u.password) return "the audience must not carry credentials";
  if (u.search || u.hash) return "the audience must not have a query or fragment";
  return null;
}

/** one mapping row: a grant scope atom (by type, resource and kind) and the scope string it becomes at the audience */
export const agentCredentialScopeMappingSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mcp_tool"), serverId: z.string().uuid(), toolName: z.string().min(1).max(256), kind: z.enum(["read", "write"]), scope: z.string().regex(AGENT_CREDENTIAL_SCOPE_TOKEN) }).strict(),
  z.object({ type: z.literal("connector"), connectorId: z.string().uuid(), kind: z.enum(["read", "write"]), scope: z.string().regex(AGENT_CREDENTIAL_SCOPE_TOKEN) }).strict(),
  z.object({ type: z.literal("agent"), agentId: z.string().uuid(), kind: z.enum(["read", "write"]), scope: z.string().regex(AGENT_CREDENTIAL_SCOPE_TOKEN) }).strict(),
]);
export type AgentCredentialScopeMapping = z.infer<typeof agentCredentialScopeMappingSchema>;

/** the body that registers an audience (admin, `settings_relax` step-up bound to all of it) */
export const agentCredentialAudienceCreateSchema = z
  .object({
    audience: z.string().min(1).max(512).refine((v) => audienceUriProblem(v) === null, { message: "not an https audience URI without query or fragment" }),
    name: z.string().trim().min(1).max(120),
    algorithm: z.enum(AGENT_CREDENTIAL_ALGORITHMS).default("ES256"),
    binding: z.enum(AGENT_CREDENTIAL_BINDINGS).default("dpop"),
    maxTtlSeconds: z.number().int().min(AGENT_CREDENTIAL_TTL_MIN_SECONDS).max(AGENT_CREDENTIAL_TTL_MAX_SECONDS).default(AGENT_CREDENTIAL_TTL_DEFAULT_SECONDS),
    scopes: z.array(agentCredentialScopeMappingSchema).min(1).max(200),
  })
  .strict();
export type AgentCredentialAudienceCreate = z.infer<typeof agentCredentialAudienceCreateSchema>;

/** an actor in the RFC 8693 §4.1 `act` chain: the outermost is the current actor; each nested one acted before it */
export interface AgentCredentialActClaim {
  sub: string;
  act?: AgentCredentialActClaim;
}

/** the claim set (ADR-0315 §4). `regulait_*` are private claim names (RFC 7519 §4.3) until a standard one exists. */
export interface AgentCredentialClaims {
  iss: string;
  aud: string;
  /** the initiating human, pairwise per audience */
  sub: string;
  /** the acting (leaf) agent's workload identity, a SPIFFE ID */
  client_id: string;
  act?: AgentCredentialActClaim;
  scope: string;
  regulait_grant: string;
  regulait_run?: string;
  regulait_budget?: { currency: "USD"; cap_micros: number; remaining_micros: number };
  cnf?: { jkt: string };
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
}

/** build the nested `act` claim from the actor chain, ROOT FIRST (lead agent first, leaf last) */
export function agentCredentialActClaim(chainRootFirst: readonly string[]): AgentCredentialActClaim | undefined {
  let act: AgentCredentialActClaim | undefined;
  // the outermost `act` is the current actor (the leaf); each nested `act` is the one before it
  for (const sub of chainRootFirst) act = act ? { sub, act } : { sub };
  return act;
}

/** the issuer's OIDC-style discovery document (only what a verifier needs) */
export function agentCredentialDiscoveryDocument(issuer: string): Record<string, unknown> {
  return {
    issuer,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    id_token_signing_alg_values_supported: [...AGENT_CREDENTIAL_ALGORITHMS],
    token_endpoint_auth_signing_alg_values_supported: [...AGENT_CREDENTIAL_ALGORITHMS],
    regulait_token_type: AGENT_CREDENTIAL_TOKEN_TYPE,
    regulait_typ: AGENT_CREDENTIAL_TYP,
    regulait_max_lifetime_seconds: AGENT_CREDENTIAL_TTL_MAX_SECONDS,
    regulait_leeway_seconds: AGENT_CREDENTIAL_LEEWAY_SECONDS,
    regulait_verifier_checks: [
      "alg equals the audience's pinned algorithm (never none, never chosen from the token)",
      "typ is at+jwt",
      "signature verifies with the JWKS key named by kid",
      "iss and aud match exactly",
      "exp, nbf and iat hold within the leeway",
      "a DPoP proof matches cnf.jkt unless the audience is bearer",
    ],
  };
}

/**
 * ADR-0315 §3 (slice 1b): the `POST /oauth/token` form that exchanges the caller's own delegated access token for an
 * agent credential at ONE registered audience. No scope is asked for: the credential's scope is the grant's,
 * projected through the audience's scope map. Strict: any other field is refused.
 */
export const agentCredentialExchangeRequestSchema = z
  .object({
    grant_type: z.literal(TOKEN_EXCHANGE_GRANT_TYPE),
    subject_token: z.string().min(1).max(16_384),
    subject_token_type: z.literal(TOKEN_TYPE_ACCESS_TOKEN),
    requested_token_type: z.literal(AGENT_CREDENTIAL_TOKEN_TYPE),
    resource: z.string().url().max(512).refine((v) => v.startsWith("https://"), { message: "an https audience" }),
    client_assertion_type: z.literal(CLIENT_ASSERTION_TYPE_JWT_BEARER).optional(),
    client_assertion: z.string().min(1).max(16_384).optional(),
    client_id: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type AgentCredentialExchangeRequest = z.infer<typeof agentCredentialExchangeRequestSchema>;

/** the public `error_code` values the agent credential exchange may answer with (beside the delegation ones) */
export const AGENT_CREDENTIAL_EXCHANGE_ERROR_CODES = [
  "agent_credential_audience_unknown",
  "agent_credential_audience_disabled",
  "agent_credential_subject_invalid",
  "agent_credential_subject_key_mismatch",
  "agent_credential_subject_client_mismatch",
  "agent_credential_grant_not_live",
  "agent_credential_org_halted",
  "agent_credential_agent_halted",
  "agent_credential_budget_exhausted",
  "agent_credential_scope_empty",
] as const;
