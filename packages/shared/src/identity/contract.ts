/**
 * ADR-0188 (batch 6 item 1) — per-agent and workload identity, and constrained
 * delegation: THE SHARED CONTRACT (slice S1, foundation).
 *
 * The vocabularies here are the same lists migration 0180's CHECK constraints
 * hold (packages/db/migrations/0180_agent_workload_identity.sql); a value added
 * to one and not the other fails `identity.test.ts` and the gateway's
 * foundation test. The request bodies are what the S6 admin UI builds against;
 * every route answers 501 `not_built` until its slice lands (S3, S5, S6, S9).
 *
 * What is NOT here (later slices): the kernel's use of `ActorChain` (S2), the
 * grant check, allocation and settlement (S3, `delegation.ts`), token mint and
 * verification (S3/S5), and the wiring into the governed call paths (S4).
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Workload identities (decision 2)
// ---------------------------------------------------------------------------

/** what a `workload_identities` row identifies (exactly one subject FK, or none for the external kinds) */
export const WORKLOAD_IDENTITY_KINDS = ["agent", "builder_agent", "engine_runner", "worker_runtime", "pdp"] as const;
export type WorkloadIdentityKind = (typeof WORKLOAD_IDENTITY_KINDS)[number];

/** the kinds whose subject is a row of ours, and the column that names it */
export const WORKLOAD_IDENTITY_SUBJECT_COLUMN: Readonly<Record<WorkloadIdentityKind, "agentId" | "builderAgentId" | "engineRunnerId" | null>> = {
  agent: "agentId",
  builder_agent: "builderAgentId",
  engine_runner: "engineRunnerId",
  worker_runtime: null,
  pdp: null,
};

/** `revoked` is terminal (a trigger in migration 0180 refuses leaving it) */
export const WORKLOAD_IDENTITY_STATUSES = ["active", "suspended", "revoked"] as const;
export type WorkloadIdentityStatus = (typeof WORKLOAD_IDENTITY_STATUSES)[number];

/**
 * A SPIFFE ID (and so a WIMSE identifier): `spiffe://<trust-domain>/<path>`.
 * Trust domain: lowercase letters, digits, `.`, `-`, `_`; path segments:
 * letters, digits, `.`, `-`, `_`, never empty, `.` or `..`. Max 2048 bytes
 * (SPIFFE-ID §2.3). The database CHECK holds the same pattern.
 */
export const SPIFFE_ID_PATTERN = /^spiffe:\/\/[a-z0-9._-]{1,255}(\/[A-Za-z0-9._-]+)+$/;
export const SPIFFE_ID_MAX_LENGTH = 2048;
/** a bare trust domain, as in `spiffe://<trust-domain>` */
export const SPIFFE_TRUST_DOMAIN_PATTERN = /^[a-z0-9._-]{1,255}$/;

export function isSpiffeId(value: string): boolean {
  if (value.length > SPIFFE_ID_MAX_LENGTH || !SPIFFE_ID_PATTERN.test(value)) return false;
  return value
    .slice("spiffe://".length)
    .split("/")
    .slice(1)
    .every((seg) => seg !== "." && seg !== "..");
}

/** the default identifier (decision 2): `spiffe://<trust-domain>/regulait/<kind>/<id>` */
export function defaultWorkloadIdentifier(trustDomain: string, kind: WorkloadIdentityKind, id: string): string {
  if (!SPIFFE_TRUST_DOMAIN_PATTERN.test(trustDomain)) throw new TypeError(`invalid SPIFFE trust domain: ${trustDomain}`);
  return `spiffe://${trustDomain}/regulait/${kind}/${id}`;
}

/** at most this many stewards (sponsors) per identity */
export const WORKLOAD_IDENTITY_MAX_STEWARDS = 10;
/** at most this many allowed environments per identity */
export const WORKLOAD_IDENTITY_MAX_ENVIRONMENTS = 20;
/** an environment or deploy-mode name (`dev`, `staging`, `byoc`, …); the database CHECK holds the same pattern */
export const ENVIRONMENT_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

// ---------------------------------------------------------------------------
// Workload credentials: PUBLIC halves only (decision 2)
// ---------------------------------------------------------------------------

/** a registered JWK, an X.509 certificate's thumbprint and SAN, or a SPIFFE ID under a trust bundle */
export const WORKLOAD_CREDENTIAL_KINDS = ["jwk", "x509", "spiffe_id"] as const;
export type WorkloadCredentialKind = (typeof WORKLOAD_CREDENTIAL_KINDS)[number];

/** the algorithms a workload key may use (decision 13: `EdDSA`, `ES256`) */
export const WORKLOAD_JWS_ALGORITHMS = ["EdDSA", "ES256"] as const;

/** a registered key lives at most this long (OWNER DECISION 7; migration 0180 CHECK) */
export const WORKLOAD_CREDENTIAL_MAX_DAYS = 90;

/** an RFC 7638 JWK thumbprint or an RFC 8705 `x5t#S256`: SHA-256, base64url, no padding */
export const SHA256_B64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** the private or symmetric JWK members that must never reach us (`d` of OKP/EC/RSA, RSA CRT values, `k`) */
export const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"] as const;

const b64u = z.string().regex(/^[A-Za-z0-9_-]+$/);
const noPrivateMembers = (jwk: Record<string, unknown>) => PRIVATE_JWK_MEMBERS.every((m) => !(m in jwk));

/** a PUBLIC workload JWK: Ed25519 (OKP) or P-256 (EC); any private member is refused */
export const workloadPublicJwkSchema = z
  .union([
    z.object({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: b64u.length(43) }).passthrough(),
    z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: b64u.length(43), y: b64u.length(43) }).passthrough(),
  ])
  .refine((jwk) => noPrivateMembers(jwk as Record<string, unknown>), {
    message: "a workload credential is a PUBLIC key: private members (d, p, q, dp, dq, qi, oth, k) are refused",
  });
export type WorkloadPublicJwk = z.infer<typeof workloadPublicJwkSchema>;

// ---------------------------------------------------------------------------
// Delegation grants (decisions 4, 12, 22)
// ---------------------------------------------------------------------------

/** how a grant's tokens are bound (decision 12). `in_process` grants mint no token (decision 6). */
export const DELEGATION_BINDING_KINDS = ["dpop", "mtls", "in_process"] as const;
export type DelegationBindingKind = (typeof DELEGATION_BINDING_KINDS)[number];
/** the bindings an issued (external) token may carry: an unbound bearer token is never issued (decision 5) */
export const TOKEN_BINDING_KINDS = ["dpop", "mtls"] as const;
export type TokenBindingKind = (typeof TOKEN_BINDING_KINDS)[number];

/** the hard ceiling on delegation depth (the setting's maximum; migration 0180 CHECK) */
export const DELEGATION_DEPTH_CEILING = 8;

/** what a scope entry governs (RFC 9396-style `authorization_details` `type`) */
export const DELEGATION_SCOPE_TYPES = ["mcp_tool", "connector", "agent"] as const;
export type DelegationScopeType = (typeof DELEGATION_SCOPE_TYPES)[number];
export const DELEGATION_SCOPE_KINDS = ["read", "write"] as const;
export type DelegationScopeKind = (typeof DELEGATION_SCOPE_KINDS)[number];

const toolName = z.string().trim().min(1).max(200);
const modeName = z.string().trim().min(1).max(64);

/**
 * One scope entry (decision 4): `{type, server/connector/agent id, tool names,
 * modes, kind read/write}`. The id names the governed object; `toolNames` is
 * meaningful for `mcp_tool`, `modes` for `agent`.
 *
 * STRICT SEMANTICS (ADR-0188 decision 27): nothing implies anything else.
 * `write` does not include `read` (an entry grants exactly its `kind`); one
 * mode never implies another; an `agent` entry with no `modes` allows NO mode;
 * an `mcp_tool` entry with no `toolNames` covers NO tool. Absence is denial.
 */
export const delegationScopeItemSchema = z
  .object({
    type: z.enum(DELEGATION_SCOPE_TYPES),
    serverId: z.string().uuid().optional(),
    connectorId: z.string().uuid().optional(),
    agentId: z.string().uuid().optional(),
    toolNames: z.array(toolName).max(200).optional(),
    modes: z.array(modeName).max(20).optional(),
    kind: z.enum(DELEGATION_SCOPE_KINDS),
  })
  .strict()
  .superRefine((v, ctx) => {
    const ids = { mcp_tool: "serverId", connector: "connectorId", agent: "agentId" } as const;
    const want = ids[v.type];
    for (const k of ["serverId", "connectorId", "agentId"] as const) {
      const present = v[k] !== undefined;
      if (k === want && !present) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${v.type} needs ${k}`, path: [k] });
      if (k !== want && present) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${v.type} takes no ${k}`, path: [k] });
    }
    if (v.type !== "mcp_tool" && v.toolNames !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "toolNames applies to mcp_tool only", path: ["toolNames"] });
    }
    if (v.type !== "agent" && v.modes !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "modes applies to agent only", path: ["modes"] });
    }
  });
export type DelegationScopeItem = z.infer<typeof delegationScopeItemSchema>;
export const delegationScopeSchema = z.array(delegationScopeItemSchema).max(100);
export type DelegationScope = z.infer<typeof delegationScopeSchema>;

/** a parent→child allocation edge (decision 22) */
export const DELEGATION_ALLOCATION_STATUSES = ["open", "closed"] as const;
export type DelegationAllocationStatus = (typeof DELEGATION_ALLOCATION_STATUSES)[number];

/**
 * Why a grant was revoked (`delegation_grants.revoked_reason`, a CODE from this
 * list, never prose; migration 0180 CHECK). Expiry is not a revocation.
 */
export const DELEGATION_REVOKE_REASONS = [
  "admin",
  "cascade",
  "identity_revoked",
  "credential_revoked",
  "sponsor_disabled",
  "agent_halted",
  "run_ended",
] as const;
export type DelegationRevokeReason = (typeof DELEGATION_REVOKE_REASONS)[number];

/** the rule ids a delegation refusal names (decision 3) */
export const DELEGATION_RULE_IDS = [
  /** the existing per-user agent allow-list (unchanged meaning) */
  "agent-allow-list",
  /** decision 28: an actor's OWN grants (`identity_*_grants`) do not cover the call */
  "actor-allow-list",
  /** decision 28: the stored chain is inconsistent, or an actor in it is not live (decision 17) */
  "actor-chain-invalid",
  "delegation-scope",
  "delegation-depth",
  "delegation-budget",
  "lead-ceiling",
] as const;
export type DelegationRuleId = (typeof DELEGATION_RULE_IDS)[number];

/** budgets are integer micro-dollars (decision 16): 1 USD = 1,000,000 */
export const MICROS_PER_USD = 1_000_000;
/** USD → micro-dollars, rounded up so a cap is never silently widened by rounding */
export function usdToMicros(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new RangeError(`usdToMicros: not a non-negative amount: ${usd}`);
  const micros = Math.ceil(usd * MICROS_PER_USD - 1e-6);
  if (!Number.isSafeInteger(micros)) throw new RangeError(`usdToMicros: amount too large: ${usd}`);
  return micros;
}

// ---------------------------------------------------------------------------
// The actor chain (decisions 1, 3, 9)
// ---------------------------------------------------------------------------

/** the most hops a chain can have: a root grant (depth 0) plus `DELEGATION_DEPTH_CEILING` descendants */
export const ACTOR_CHAIN_MAX_HOPS = DELEGATION_DEPTH_CEILING + 1;

/** the hop count of the chain whose LEAF grant has stored `delegation_grants.depth` = `grantDepth` */
export function actorChainDepthForGrantDepth(grantDepth: number): number {
  return grantDepth + 1;
}

/** the RFC 8693 `act` encoding of a chain: outermost = the leaf (the current actor), nested inward to the root */
export interface ActClaim {
  sub: string;
  act?: ActClaim;
}
export function actClaimFromChain(actors: ReadonlyArray<{ identifier: string }>): ActClaim | undefined {
  let act: ActClaim | undefined;
  for (const a of actors) act = act ? { sub: a.identifier, act } : { sub: a.identifier };
  return act;
}

/** one link of the chain: an agent principal */
export const actorChainLinkSchema = z
  .object({
    identityId: z.string().uuid(),
    kind: z.enum(WORKLOAD_IDENTITY_KINDS),
    identifier: z.string().max(SPIFFE_ID_MAX_LENGTH).refine(isSpiffeId, { message: "identifier must be a SPIFFE ID" }),
  })
  .strict();
export type ActorChainLink = z.infer<typeof actorChainLinkSchema>;

/**
 * Who an agent action is FOR and who is DOING it (decision 1). The human
 * sponsor stays the subject (`sub`).
 *
 * ONE CANONICAL ORDER (ADR-0188 decision 25): `actors` is ROOT FIRST, LEAF
 * LAST — the agent the human delegated to first, the agent making the call
 * last. It is the same order as `delegation_grants.path` (+ the leaf grant)
 * and as `audit_log.actor_chain`. The RFC 8693 nested `act` claim is only a
 * wire encoding derived from it at mint and verify time (S3/S5): outermost
 * `act` = the last element.
 *
 * DEPTH IS THE HOP COUNT (decision 26): `depth = actors.length`. A human
 * acting directly is 0 (and is `actor: null`, never an empty chain), a first
 * agent 1, its sub-agent 2. Cedar's `context.delegationDepth` is the same
 * number. The stored `delegation_grants.depth` counts ANCESTOR GRANTS
 * (`cardinality(path)`, 0 for a root grant), so for the leaf grant of a chain
 * `ActorChain.depth = delegation_grants.depth + 1`.
 *
 * The kernel input carries `actor: ActorChain | null` (decision 3; S2). The
 * chain is never taken from a caller: S3/S4 BUILD it from the stored grant
 * path (decision 17).
 */
export const actorChainSchema = z
  .object({
    sponsorUserId: z.string().uuid(),
    delegationGrantId: z.string().uuid(),
    /** hop count: `actors.length` (1..9) */
    depth: z.number().int().min(1).max(ACTOR_CHAIN_MAX_HOPS),
    /** ROOT FIRST, leaf (the caller) last */
    actors: z.array(actorChainLinkSchema).min(1).max(ACTOR_CHAIN_MAX_HOPS),
  })
  .strict()
  .refine((c) => c.depth === c.actors.length, { message: "depth is the hop count: it must equal the number of actors" })
  .refine((c) => new Set(c.actors.map((a) => a.identityId)).size === c.actors.length, {
    message: "an identity appears at most once in a chain",
  });
export type ActorChain = z.infer<typeof actorChainSchema>;

// ---------------------------------------------------------------------------
// Replay claims (decision 14) and the audit chain version (decision 19)
// ---------------------------------------------------------------------------

/** `replay_claims.namespace` (migration 0180 CHECK) */
export const REPLAY_NAMESPACES = [
  "client_assertion",
  "as_dpop",
  "rs_dpop",
  "human_delegation_proof",
  "delegation_authz",
] as const;
export type ReplayNamespace = (typeof REPLAY_NAMESPACES)[number];

/** the audit canonical serialisation versions this build reads and writes (decision 19) */
export const AUDIT_CHAIN_VERSIONS_SUPPORTED = [1, 2] as const;

// ---------------------------------------------------------------------------
// Settings vocabularies (decision 10)
// ---------------------------------------------------------------------------

/** `own_grants` = the agent's own grants ∩ the sponsor's (I7 on); `sponsor_only` = today's behaviour */
export const AGENT_ENTITLEMENT_MODES = ["own_grants", "sponsor_only"] as const;
export type AgentEntitlementMode = (typeof AGENT_ENTITLEMENT_MODES)[number];

/** how a workload may authenticate to the token endpoint. `client_secret_*` is not offered, ever. */
export const WORKLOAD_CLIENT_AUTH_METHODS = [
  "private_key_jwt",
  "tls_client_auth",
  "self_signed_tls_client_auth",
  "spiffe_svid",
] as const;
export type WorkloadClientAuthMethod = (typeof WORKLOAD_CLIENT_AUTH_METHODS)[number];

/** `mcp_servers.identity_propagation` (decision 8; OWNER DECISION 6: default `none`) */
export const IDENTITY_PROPAGATION_MODES = ["none", "signed_assertion"] as const;
export type IdentityPropagationMode = (typeof IDENTITY_PROPAGATION_MODES)[number];
export const DEFAULT_IDENTITY_PROPAGATION: IdentityPropagationMode = "none";

// ---------------------------------------------------------------------------
// Issuer and token wire constants (decisions 5, 7, 13, 15, 23)
// ---------------------------------------------------------------------------

/** the gateway issuer signs with Ed25519 only (decision 5) */
export const IDENTITY_SIGNING_ALGORITHM = "Ed25519" as const;
/** the deploy-time secret that carries the issuer's private key (never in the database) */
export const IDENTITY_SIGNING_KEY_ENV = "REGULAIT_IDENTITY_SIGNING_KEY" as const;

export const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange" as const;
export const TOKEN_TYPE_ACCESS_TOKEN = "urn:ietf:params:oauth:token-type:access_token" as const;
export const TOKEN_TYPE_DELEGATION_PROOF = "urn:regulait:params:oauth:token-type:delegation-proof" as const;
export const TOKEN_TYPE_DELEGATION_AUTHZ = "urn:regulait:params:oauth:token-type:delegation-authz" as const;
export const CLIENT_ASSERTION_TYPE_JWT_BEARER = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" as const;
/** JOSE `typ` of the human's one-use delegation proof (decision 15) */
export const DELEGATION_PROOF_TYP = "regulait-delegation-proof+jwt" as const;
/** JOSE `typ` of a parent's delegation authorization (decision 23) */
export const DELEGATION_AUTHZ_TYP = "regulait-delegation-authz+jwt" as const;
/** a delegation proof lives 120 s (decision 15) */
export const DELEGATION_PROOF_TTL_SECONDS = 120;
/** a client assertion is at most 5 minutes old (decision 5) */
export const CLIENT_ASSERTION_MAX_AGE_SECONDS = 300;
/** a DPoP proof's `iat` within 60 s (decision 13; NOT relaxable), and at most 5 s ahead */
export const DPOP_PROOF_MAX_AGE_SECONDS = 60;
export const DPOP_PROOF_MAX_FUTURE_SECONDS = 5;
/** a per-call upstream assertion lives 60 s (decision 8) */
export const UPSTREAM_ASSERTION_TTL_SECONDS = 60;

/** the token endpoint's RFC 6749 / 8693 / 9449 errors (decision 15) */
export const TOKEN_ENDPOINT_ERRORS = [
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "invalid_target",
  "invalid_authorization_details",
  "invalid_dpop_proof",
  "use_dpop_nonce",
] as const;
/** RegulAIt `error_code`s riding `invalid_grant` (decisions 15, 23) */
export const DELEGATION_ERROR_CODES = ["delegation_budget", "delegation_depth", "mtls_parent_handoff_unsupported"] as const;

/** the form fields of `POST /oauth/token` (decisions 15 and 23); S5 validates the semantics */
export const tokenExchangeRequestSchema = z
  .object({
    grant_type: z.literal(TOKEN_EXCHANGE_GRANT_TYPE),
    subject_token: z.string().min(1).max(16_384),
    subject_token_type: z.enum([TOKEN_TYPE_DELEGATION_PROOF, TOKEN_TYPE_ACCESS_TOKEN]),
    actor_token: z.string().min(1).max(16_384).optional(),
    actor_token_type: z.literal(TOKEN_TYPE_DELEGATION_AUTHZ).optional(),
    requested_token_type: z.literal(TOKEN_TYPE_ACCESS_TOKEN),
    resource: z.string().url().max(2048),
    authorization_details: z.string().min(2).max(65_536),
    client_assertion_type: z.literal(CLIENT_ASSERTION_TYPE_JWT_BEARER).optional(),
    client_assertion: z.string().min(1).max(16_384).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const root = v.subject_token_type === TOKEN_TYPE_DELEGATION_PROOF;
    // a root takes no actor_token (the authenticated client is the actor); a child must carry A's authorization
    if (root && (v.actor_token !== undefined || v.actor_token_type !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a root exchange takes no actor_token", path: ["actor_token"] });
    }
    if (!root && (v.actor_token === undefined || v.actor_token_type === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a child exchange needs the parent's delegation authorization", path: ["actor_token"] });
    }
    if ((v.client_assertion === undefined) !== (v.client_assertion_type === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "client_assertion and client_assertion_type go together", path: ["client_assertion"] });
    }
  });
export type TokenExchangeRequest = z.infer<typeof tokenExchangeRequestSchema>;

// ---------------------------------------------------------------------------
// Route bodies (the S6 UI builds against these)
// ---------------------------------------------------------------------------

const environmentName = z.string().regex(ENVIRONMENT_NAME_PATTERN);
const uniqueUuids = (max: number) =>
  z
    .array(z.string().uuid())
    .min(1)
    .max(max)
    .refine((a) => new Set(a).size === a.length, { message: "duplicate entries" });
const uniqueEnvironments = z
  .array(environmentName)
  .max(WORKLOAD_IDENTITY_MAX_ENVIRONMENTS)
  .refine((a) => new Set(a).size === a.length, { message: "duplicate entries" });

/**
 * `POST /v1/workload-identities` — admin, `identity_manage` step-up. Exactly
 * the subject the kind names; `identifier` overrides the default only with an
 * exact SPIFFE ID (a SPIFFE-backed workload, decision 2).
 */
export const createWorkloadIdentitySchema = z
  .object({
    kind: z.enum(WORKLOAD_IDENTITY_KINDS),
    agentId: z.string().uuid().optional(),
    builderAgentId: z.string().uuid().optional(),
    engineRunnerId: z.string().uuid().optional(),
    identifier: z.string().max(SPIFFE_ID_MAX_LENGTH).refine(isSpiffeId, { message: "identifier must be a SPIFFE ID" }).optional(),
    sponsorUserIds: uniqueUuids(WORKLOAD_IDENTITY_MAX_STEWARDS),
    environments: uniqueEnvironments,
  })
  .strict()
  .superRefine((v, ctx) => {
    const want = WORKLOAD_IDENTITY_SUBJECT_COLUMN[v.kind];
    for (const k of ["agentId", "builderAgentId", "engineRunnerId"] as const) {
      const present = v[k] !== undefined;
      if (k === want && !present) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${v.kind} needs ${k}`, path: [k] });
      if (k !== want && present) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${v.kind} takes no ${k}`, path: [k] });
    }
  });
export type CreateWorkloadIdentity = z.infer<typeof createWorkloadIdentitySchema>;

/**
 * `PATCH /v1/workload-identities/:identityId` — admin, `identity_manage`
 * step-up: stewards, environments, suspend (`suspended`) or reinstate
 * (`active`). Revocation is its own route and is terminal.
 */
export const updateWorkloadIdentitySchema = z
  .object({
    sponsorUserIds: uniqueUuids(WORKLOAD_IDENTITY_MAX_STEWARDS).optional(),
    environments: uniqueEnvironments.optional(),
    status: z.enum(["active", "suspended"]).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "nothing to change" });
export type UpdateWorkloadIdentity = z.infer<typeof updateWorkloadIdentitySchema>;

/** `POST /v1/workload-identities/:identityId/revoke` — terminal; cascades to every grant naming it at next use */
export const revokeWorkloadIdentitySchema = z.object({}).strict();

const isoDate = z.string().datetime({ offset: true });

/**
 * `POST /v1/workload-identities/:identityId/credentials` — bind a PUBLIC
 * credential (admin, `identity_manage` step-up). `notAfter` defaults to, and
 * may not exceed, `workloadKeyMaxAgeDays` from now.
 */
export const addWorkloadCredentialSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("jwk"), publicJwk: workloadPublicJwkSchema, notAfter: isoDate.optional() }).strict(),
  z
    .object({
      kind: z.literal("x509"),
      /** the leaf certificate, PEM; only its thumbprint, SAN URI and subject are kept */
      certificatePem: z.string().min(1).max(16_384),
      /** `self_signed_tls_client_auth`: matched by thumbprint, no chain (decision 21) */
      selfSigned: z.boolean(),
      notAfter: isoDate.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("spiffe_id"),
      spiffeId: z.string().max(SPIFFE_ID_MAX_LENGTH).refine(isSpiffeId, { message: "spiffeId must be a SPIFFE ID" }),
      notAfter: isoDate.optional(),
    })
    .strict(),
]);
export type AddWorkloadCredential = z.infer<typeof addWorkloadCredentialSchema>;

// ---------------------------------------------------------------------------
// An agent principal's OWN grants (decision 3; storage: decision 24)
// ---------------------------------------------------------------------------

/**
 * The same shapes as a user's tool, server, agent-invoke and connector grants
 * and role assignments (`tool_grants`, `server_grants`, `agent_grants`,
 * `connector_grants`, `role_assignments`), stored in the parallel
 * `identity_*` tables of migration 0180 (decision 24). Default-deny: an
 * identity with no rows can do nothing (OWNER DECISION 1). One deliberate
 * difference from a user's grants: `allowedModes` and `allowedObjects` are
 * REQUIRED lists — a user's NULL means "every mode / every object", and an
 * agent never gets that implicitly (decision 27).
 */
export const CONNECTOR_GRANT_MODES = ["read", "readwrite"] as const;
export type ConnectorGrantMode = (typeof CONNECTOR_GRANT_MODES)[number];

const uniqueStrings = (item: z.ZodString, max: number) =>
  z
    .array(item)
    .max(max)
    .refine((a) => new Set(a).size === a.length, { message: "duplicate entries" });

export const identityToolGrantSchema = z.object({ serverId: z.string().uuid(), toolName: toolName }).strict();
export const identityServerGrantSchema = z.object({ serverId: z.string().uuid(), readOnlyAll: z.boolean() }).strict();
export const identityAgentGrantSchema = z
  .object({ agentId: z.string().uuid(), allowedModes: uniqueStrings(modeName, 20) })
  .strict();
export const identityConnectorGrantSchema = z
  .object({
    connectorId: z.string().uuid(),
    mode: z.enum(CONNECTOR_GRANT_MODES),
    allowedObjects: uniqueStrings(z.string().trim().min(1).max(200), 500),
  })
  .strict();
export type IdentityToolGrant = z.infer<typeof identityToolGrantSchema>;
export type IdentityServerGrant = z.infer<typeof identityServerGrantSchema>;
export type IdentityAgentGrant = z.infer<typeof identityAgentGrantSchema>;
export type IdentityConnectorGrant = z.infer<typeof identityConnectorGrantSchema>;

const uniqueBy = <T>(key: (v: T) => string) => (a: T[]) => new Set(a.map(key)).size === a.length;

/**
 * An actor's entitlements as the kernel reads them (S2 fills this per actor
 * from the `identity_*` tables, with role grants expanded): the exact twin of
 * a user's entitlement inputs.
 */
export const actorEntitlementsSchema = z
  .object({
    tools: z.array(identityToolGrantSchema).max(5000).refine(uniqueBy((g) => `${g.serverId}/${g.toolName}`), { message: "duplicate tool grant" }),
    servers: z.array(identityServerGrantSchema).max(1000).refine(uniqueBy((g) => g.serverId), { message: "duplicate server grant" }),
    agents: z.array(identityAgentGrantSchema).max(1000).refine(uniqueBy((g) => g.agentId), { message: "duplicate agent grant" }),
    connectors: z.array(identityConnectorGrantSchema).max(1000).refine(uniqueBy((g) => g.connectorId), { message: "duplicate connector grant" }),
  })
  .strict();
export type ActorEntitlements = z.infer<typeof actorEntitlementsSchema>;
/** what an identity starts with: nothing (OWNER DECISION 1) */
export const EMPTY_ACTOR_ENTITLEMENTS: Readonly<ActorEntitlements> = Object.freeze({ tools: [], servers: [], agents: [], connectors: [] });

/**
 * `PUT /v1/workload-identities/:identityId/grants` — replaces the identity's
 * direct grants and role assignments as one set (admin, `identity_manage`
 * step-up, audited).
 */
export const putAgentGrantsSchema = actorEntitlementsSchema
  .extend({
    roleIds: z
      .array(z.string().uuid())
      .max(100)
      .refine((a) => new Set(a).size === a.length, { message: "duplicate entries" }),
    /**
     * Stale-write protection (X33): the `revision` of the grant set the caller
     * read (`AgentGrantsView.revision`, `workload_identities.grants_revision`).
     * The PUT replaces the WHOLE set, so it is refused with 409
     * `grants_revision_conflict` unless this equals the stored revision; a
     * successful write stores `revision + 1`. An `If-Match: "<revision>"`
     * header, when also sent, must agree with it.
     */
    revision: z.number().int().min(0),
  })
  .strict();
/** the refusal a stale `PUT .../grants` gets (409) */
export const GRANTS_REVISION_CONFLICT = "grants_revision_conflict" as const;
export interface GrantsRevisionConflictBody {
  error: typeof GRANTS_REVISION_CONFLICT;
  /** the revision now stored: re-read the set, re-apply the change, send this */
  currentRevision: number;
}
export type PutAgentGrants = z.infer<typeof putAgentGrantsSchema>;

/**
 * `POST /v1/delegations/proofs` — a human starts a delegation (decision 15
 * step 1; OWNER DECISION 4: a browser session or an MFA-qualified API key,
 * never the bootstrap token or a virtual key). The response is a one-use
 * signed JWT bound to every field here.
 */
export const createDelegationProofSchema = z
  .object({
    agentIdentityId: z.string().uuid(),
    authorizationDetails: delegationScopeSchema.min(1),
    resource: z.string().url().max(2048),
    projectId: z.string().uuid(),
    env: environmentName,
    /** the agent's key thumbprint, when known: binds the proof to that key */
    agentKeyThumbprint: z.string().regex(SHA256_B64URL_PATTERN).optional(),
  })
  .strict();
export type CreateDelegationProof = z.infer<typeof createDelegationProofSchema>;

/** `POST /v1/delegation-grants/:grantId/revoke` — admin; cascades to every descendant (decision 4) */
export const revokeDelegationGrantSchema = z.object({}).strict();

/**
 * list filters of `GET /v1/delegation-grants`. `runId` (X33) reads one run's
 * delegation TREE: its grants plus the parent→child edges between them.
 * Keyset-paginated: `cursor` is the opaque `nextCursor` of the previous page.
 */
export const listDelegationGrantsQuerySchema = z
  .object({
    actorIdentityId: z.string().uuid().optional(),
    sponsorUserId: z.string().uuid().optional(),
    rootGrantId: z.string().uuid().optional(),
    runId: z.string().uuid().optional(),
    status: z.enum(["live", "revoked", "expired"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
export type ListDelegationGrantsQuery = z.infer<typeof listDelegationGrantsQuerySchema>;

/** list filters of `GET /v1/workload-identities` (keyset-paginated like every list) */
export const listWorkloadIdentitiesQuerySchema = z
  .object({
    kind: z.enum(WORKLOAD_IDENTITY_KINDS).optional(),
    status: z.enum(WORKLOAD_IDENTITY_STATUSES).optional(),
    sponsorUserId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
export type ListWorkloadIdentitiesQuery = z.infer<typeof listWorkloadIdentitiesQuerySchema>;

// ---------------------------------------------------------------------------
// Response shapes (what the routes will answer once built)
// ---------------------------------------------------------------------------

export interface WorkloadIdentityView {
  id: string;
  kind: WorkloadIdentityKind;
  agentId: string | null;
  builderAgentId: string | null;
  engineRunnerId: string | null;
  identifier: string;
  sponsorUserIds: string[];
  environments: string[];
  status: WorkloadIdentityStatus;
  /** the revision of its own grant set (`PutAgentGrants.revision`) */
  grantsRevision: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkloadCredentialView {
  id: string;
  identityId: string;
  kind: WorkloadCredentialKind;
  /** PUBLIC key only */
  publicJwk: WorkloadPublicJwk | null;
  jwkThumbprint: string | null;
  x5tS256: string | null;
  sanUri: string | null;
  subjectDn: string | null;
  spiffeId: string | null;
  selfSigned: boolean;
  notBefore: string;
  notAfter: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface DelegationGrantView {
  id: string;
  rootGrantId: string;
  parentGrantId: string | null;
  /** ancestor grant ids, root first */
  path: string[];
  depth: number;
  sponsorUserId: string;
  actorIdentityId: string;
  runId: string | null;
  builderTurnId: string | null;
  engineRunId: string | null;
  scheduleId: string | null;
  projectId: string | null;
  scope: DelegationScope;
  capMicros: number | null;
  settledMicros: number;
  reservedMicros: number;
  environment: string;
  audience: string | null;
  bindingKind: DelegationBindingKind;
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: DelegationRevokeReason | null;
  createdAt: string;
}

// --- Read shapes, frozen for the S6 UI (X33) --------------------------------
// Every list is keyset-paginated: `nextCursor` is null on the last page and is
// passed back verbatim as `cursor`.

/** `GET /v1/workload-identities` */
export interface WorkloadIdentityListView {
  items: WorkloadIdentityView[];
  nextCursor: string | null;
}

/** `GET /v1/workload-identities/:identityId`: the identity plus the counts its page summarises */
export interface WorkloadIdentityDetailView extends WorkloadIdentityView {
  /** credentials not revoked and not past `notAfter` */
  activeCredentialCount: number;
  /** delegation grants naming this identity as actor that are neither revoked nor expired */
  liveDelegationGrantCount: number;
}

/** `GET /v1/workload-identities/:identityId/credentials` (public halves only) */
export interface WorkloadCredentialListView {
  items: WorkloadCredentialView[];
}

/** `GET /v1/workload-identities/:identityId/grants`: the whole set a `PUT` replaces, and its revision */
export interface AgentGrantsView extends ActorEntitlements {
  identityId: string;
  roleIds: string[];
  /** send back as `PutAgentGrants.revision` */
  revision: number;
}

/** one parent→child budget edge of a delegation tree (decision 22, `delegation_allocations`) */
export interface DelegationAllocationView {
  id: string;
  parentGrantId: string;
  childGrantId: string;
  amountMicros: number;
  drawnMicros: number;
  releasedMicros: number;
  status: DelegationAllocationStatus;
  createdAt: string;
  closedAt: string | null;
}

/** `GET /v1/delegation-grants` (with `runId`: one run's tree) */
export interface DelegationGrantListView {
  items: DelegationGrantView[];
  /** the parent→child edges between grants on this page, with their allocations */
  edges: DelegationAllocationView[];
  nextCursor: string | null;
}

/** `GET /v1/delegation-grants/:grantId`: the grant, the edge into it, and the edges out of it */
export interface DelegationGrantDetailView extends DelegationGrantView {
  allocation: DelegationAllocationView | null;
  childAllocations: DelegationAllocationView[];
}

/** one choice offered by a picker */
export interface IdentityPickerOption {
  id: string;
  label: string;
}

/**
 * `GET /v1/identity/picker-sources`: what the identity forms may offer. Only
 * objects that exist and that an admin may name; a picker never offers a free
 * text id.
 */
export interface IdentityPickerSourcesView {
  /** people who may steward an identity */
  sponsors: Array<IdentityPickerOption & { email: string }>;
  /** subjects that have no identity yet, by kind */
  subjects: {
    agent: IdentityPickerOption[];
    builder_agent: IdentityPickerOption[];
    engine_runner: IdentityPickerOption[];
  };
  /** environment names an identity may be limited to */
  environments: string[];
  /** grant targets for the own-grants editor */
  servers: Array<IdentityPickerOption & { tools: string[] }>;
  agents: IdentityPickerOption[];
  connectors: IdentityPickerOption[];
  roles: IdentityPickerOption[];
}

export interface IdentitySigningKeyView {
  kid: string;
  algorithm: typeof IDENTITY_SIGNING_ALGORITHM;
  publicJwk: { kty: "OKP"; crv: "Ed25519"; x: string; kid?: string };
  createdAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
  revokedAt: string | null;
}

/** `GET /v1/identity/signing-keys` (S3): every issuer key ever recorded, newest first; public halves only */
export interface IdentitySigningKeyListView {
  items: IdentitySigningKeyView[];
}

/** an issuer key id: the RFC 7638 thumbprint of its public JWK (migration 0180 CHECK allows this alphabet) */
export const IDENTITY_SIGNING_KID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * `POST /v1/identity/signing-keys/rotate` (S3; admin, `identity_manage`
 * step-up, audited). The new key's PRIVATE half is a deploy-time secret
 * (`REGULAIT_IDENTITY_SIGNING_KEY`), never sent here: the operator deploys it
 * first, then this activates it and retires the current signer (overlap keeps
 * the retired key's public half in the JWKS until every token it signed has
 * expired). `kid` names the configured key to activate; it may be omitted only
 * when exactly one configured key has never been recorded.
 */
export const rotateIdentitySigningKeySchema = z
  .object({ kid: z.string().regex(IDENTITY_SIGNING_KID_PATTERN).optional() })
  .strict();
export type RotateIdentitySigningKey = z.infer<typeof rotateIdentitySigningKeySchema>;

/** `POST /v1/identity/signing-keys/:kid/revoke` (S3): compromise; every token it signed is refused; never undone */
export const revokeIdentitySigningKeySchema = z.object({}).strict();

// ---------------------------------------------------------------------------
// The routes (S1 registers every one as a 501 stub)
// ---------------------------------------------------------------------------

/** what every identity route that is not built yet answers */
export const IDENTITY_NOT_BUILT = { error: "not_built" } as const;

/** the RFC 7517 JWKS document of the gateway issuer (decision 5) */
export const IDENTITY_JWKS_PATH = "/.well-known/jwks.json";
/** the RFC 8693 token endpoint (decision 7), and RFC 7009 revocation / RFC 7662 introspection under it */
export const OAUTH_TOKEN_PATH = "/oauth/token";
export const OAUTH_REVOCATION_PATH = "/oauth/token/revocation";
export const OAUTH_INTROSPECTION_PATH = "/oauth/token/introspection";

export type IdentityRouteClass = "public" | "user" | "admin";

/**
 * EVERY ADR-0188 route, its auth class, and the slice that builds it.
 *  - `public`: no RegulAIt credential (the JWKS document; the token endpoint
 *    authenticates IN-ROUTE on the client assertion, mTLS or SVID).
 *  - `user`: a signed-in person acting for themselves (the delegation proof).
 *  - `admin`: identity administration (and an `identity_manage` step-up on every write).
 */
export const IDENTITY_ROUTES: ReadonlyArray<{ method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; cls: IdentityRouteClass; slice: string }> = [
  { method: "GET", path: IDENTITY_JWKS_PATH, cls: "public", slice: "S3" },
  { method: "POST", path: OAUTH_TOKEN_PATH, cls: "public", slice: "S5" },
  { method: "POST", path: OAUTH_REVOCATION_PATH, cls: "public", slice: "S5" },
  { method: "POST", path: OAUTH_INTROSPECTION_PATH, cls: "public", slice: "S5" },
  { method: "POST", path: "/v1/delegations/proofs", cls: "user", slice: "S5" },
  { method: "GET", path: "/v1/workload-identities", cls: "admin", slice: "S6" },
  { method: "POST", path: "/v1/workload-identities", cls: "admin", slice: "S6" },
  { method: "GET", path: "/v1/workload-identities/:identityId", cls: "admin", slice: "S6" },
  { method: "PATCH", path: "/v1/workload-identities/:identityId", cls: "admin", slice: "S6" },
  { method: "POST", path: "/v1/workload-identities/:identityId/revoke", cls: "admin", slice: "S6" },
  { method: "GET", path: "/v1/workload-identities/:identityId/credentials", cls: "admin", slice: "S6" },
  { method: "POST", path: "/v1/workload-identities/:identityId/credentials", cls: "admin", slice: "S6" },
  { method: "DELETE", path: "/v1/workload-identities/:identityId/credentials/:credentialId", cls: "admin", slice: "S6" },
  { method: "GET", path: "/v1/workload-identities/:identityId/grants", cls: "admin", slice: "S6" },
  { method: "PUT", path: "/v1/workload-identities/:identityId/grants", cls: "admin", slice: "S6" },
  { method: "GET", path: "/v1/workload-identities/:identityId/grant-proposals", cls: "admin", slice: "S6" },
  { method: "GET", path: "/v1/identity/picker-sources", cls: "admin", slice: "S6" },
  { method: "GET", path: "/v1/delegation-grants", cls: "admin", slice: "S6" },
  { method: "GET", path: "/v1/delegation-grants/:grantId", cls: "admin", slice: "S6" },
  { method: "POST", path: "/v1/delegation-grants/:grantId/revoke", cls: "admin", slice: "S6" },
  { method: "GET", path: "/v1/identity/signing-keys", cls: "admin", slice: "S3" },
  { method: "POST", path: "/v1/identity/signing-keys/rotate", cls: "admin", slice: "S3" },
  { method: "POST", path: "/v1/identity/signing-keys/:kid/revoke", cls: "admin", slice: "S3" },
];
