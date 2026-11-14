/**
 * ADR-0238 (backlog P12(d)) — DOWN-SCOPED UPSTREAM CREDENTIALS BY RFC 8693 TOKEN EXCHANGE.
 *
 * WHAT ALREADY EXISTED (and is unchanged). `POST /oauth/token` (oauth/token-endpoint.ts, ADR-0188 S5) is an RFC 8693
 * token-exchange endpoint on `oidc-provider`, but the gateway is its AUTHORIZATION SERVER and its only resource:
 * agents trade a human delegation proof or a parent's authorization for a DPoP/mTLS-bound token audienced to the
 * gateway's own routes. Outbound, ADR-0188 S8 / ADR-0210 SIGN an identity assertion per call (a fixed, admin-set
 * scope for the whole server), and ADR-0204 sends a static per-server secret. None of them obtains a token FROM an
 * upstream's own authorization server, and none narrows what the upstream receives to the one tool being called.
 *
 * WHAT THIS ADDS. The gateway as an RFC 8693 CLIENT of an upstream's authorization server. After a governed call to
 * an MCP server or a connector is ALLOWED (entitlement, approvals, budget, PII, guardrails all decided), and before
 * anything is sent:
 *  1. the scopes are those an admin mapped to THIS action (the tool, the JSON-RPC method or the connector
 *     operation). An unmapped action is refused (default-deny): the person is entitled to the tool, but the upstream
 *     would otherwise have to receive a token broader than that one tool;
 *  2. the subject token is a fresh ADR-0210 OIDC assertion (ES256, 60 s, unique `jti`, pairwise `sub` for the
 *     authorization server, the `act` chain of any acting agent), carrying the same down-scoped `scope`;
 *  3. it is exchanged at the configured token endpoint through the egress-guarded fetch (https only, the admin
 *     allow-list, no redirects), with `audience` and `resource` taken from the configuration, never from the call;
 *  4. the answer is held to the request: a Bearer access token, `expires_in` present and within the configuration's
 *     ceiling (≤ 900 s), no scope beyond what was asked, and — when the token is a JWT — an `aud` that is exactly the
 *     pinned audience/resource and an unexpired `exp` within the same ceiling;
 *  5. its SHA-256 is claimed in `replay_claims` (`upstream_exchanged_token`): a token the authorization server hands
 *     out twice — to this person or another — is refused, never attached again;
 *  6. an `upstream-token-exchange-issued` row is written (never the token: a 16-hex fingerprint), and only then is the
 *     token attached, as `Authorization: Bearer`, to requests of THIS call to the registered origin.
 * Any failure is OUR refusal: the call is denied with an `upstream-token-exchange-refused` row and nothing is sent.
 *
 * NO CACHING. A token lives in one call's holder (MCP) or one invocation's local (connector), and is never stored,
 * pooled or shared: every governed call exchanges afresh. There is nothing to leak across users or tenants.
 *
 * OFF BY DEFAULT. No configuration, or `enabled` false (the column default), changes nothing. Every write through the
 * admin routes is a `settings_relax` step-up, audited in its transaction; a server url move turns it off.
 *
 * Open source first (ADR-0176): `oauth4webapi` (already pinned, used by ADR-0188 S3) builds the token request, the
 * client authentication and validates the response, running through our egress-guarded fetch as its `customFetch`;
 * `jose` signs the subject token and decodes an issued JWT; the MCP SDK's `createMiddleware` attaches it; the egress
 * guard, the data-key envelope, the step-up and the replay table are the gateway's existing ones. Nothing new is added
 * to the tree. What is ours is when a token may be obtained and what it may say (`checkExchangeResponse`).
 */
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { decodeJwt } from "jose";
import * as oauth from "oauth4webapi";
import { z } from "zod";
import { createMiddleware, type Middleware } from "@modelcontextprotocol/sdk/client/middleware.js";
import {
  auditLog,
  connectorCredentials,
  connectors,
  eq,
  mcpServers,
  mcpServerUpstreamCredentials,
  upstreamTokenExchanges,
  upstreamTokenExchangeScopes,
  type Db,
  type UpstreamTokenExchangeRow,
} from "@regulait/db";
import type { Decision } from "@regulait/policy-kernel";
import {
  canonicalScope,
  scopeTokens,
  setUpstreamTokenExchangeSchema,
  TOKEN_EXCHANGE_GRANT_TYPE,
  TOKEN_TYPE_ACCESS_TOKEN,
  TOKEN_TYPE_JWT,
  UPSTREAM_EXCHANGE_CLOCK_SKEW_SECONDS,
  UPSTREAM_EXCHANGE_MAX_RESPONSE_BYTES,
  UPSTREAM_EXCHANGE_MAX_TOKEN_BYTES,
  UPSTREAM_EXCHANGE_RULE_IDS,
  UPSTREAM_EXCHANGE_TTL_CEILING_SECONDS,
  UPSTREAM_EXCHANGE_TTL_DEFAULT_SECONDS,
  type UpstreamExchangeRefusalCode,
  type UpstreamExchangeTargetKind,
  type UpstreamTokenExchangeView,
} from "@regulait/shared";
import { loadEgressAllowList } from "./custom-providers.js";
import { databaseNow } from "./db-clock.js";
import { claimReplay, pairwiseSubject } from "./delegated-token.js";
import { createGuardedFetch, EgressBlockedError, type EgressResolver } from "./egress-guard.js";
import { currentIssuerSigner, IdentitySigningKeyError } from "./identity-signing-keys.js";
import { IdentityAssertionRefusedError, mcpIdentityOidcIssuer, pairwiseActor, signIdentityAssertion } from "./mcp-identity-assertion.js";
import { identitySecretsFor } from "./oauth/common.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { CHANGED_CONCURRENTLY, checkStepUp, type StepUpCheckArgs } from "./step-up.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";
/** the bound on one exchange round trip */
export const UPSTREAM_EXCHANGE_TIMEOUT_MS = 10_000;

/**
 * TEST ONLY: the seams of the guarded fetch (an injected transport and resolver). The egress guard itself still runs
 * on every exchange; production code never sets these.
 */
export const upstreamExchangeTestHooks: { fetchImpl?: typeof fetch; resolve?: EgressResolver } = {};

// ---------------------------------------------------------------------------
// The response check (pure: no database, no clock of its own)
// ---------------------------------------------------------------------------

export type ExchangeCheck =
  | { ok: true; token: string; expiresAt: number; grantedScope: string; jwt: boolean; refreshTokenDiscarded: boolean }
  | { ok: false; code: UpstreamExchangeRefusalCode; why: string };

/** the 16-hex fingerprint the trail carries in place of a token (SHA-256; the token itself is never written) */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/**
 * Hold a token endpoint's answer to what was asked. `nowS` is the database clock in seconds. Strict where RFC 8693
 * is loose: `expires_in` is required (an unbounded token is refused), and the issued token type must be an access
 * token or a JWT. A `refresh_token` is never kept (reported as discarded).
 */
export function checkExchangeResponse(input: {
  status: number;
  body: string;
  requestedScopes: readonly string[];
  audience: string;
  resource: string | null;
  maxTtlSeconds: number;
  nowS: number;
}): ExchangeCheck {
  const refuse = (code: UpstreamExchangeRefusalCode, why: string): ExchangeCheck => ({ ok: false, code, why });
  if (input.status !== 200) return refuse("endpoint_error", `the token endpoint answered ${input.status}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body);
  } catch {
    return refuse("malformed_response", "the answer is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return refuse("malformed_response", "the answer is not a JSON object");
  const r = parsed as Record<string, unknown>;
  if (typeof r.access_token !== "string" || r.access_token.length === 0) return refuse("malformed_response", "no access_token");
  const token = r.access_token;
  if (Buffer.byteLength(token, "utf8") > UPSTREAM_EXCHANGE_MAX_TOKEN_BYTES) return refuse("token_too_large", "the access token exceeds the bound");
  // a header-safe token68 value (RFC 6750 §2.1), so it can never inject into the request it rides on
  if (!/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) return refuse("malformed_response", "the access token is not a b64token");
  if (typeof r.token_type !== "string" || r.token_type.toLowerCase() !== "bearer") {
    return refuse("token_type_unsupported", "only a Bearer access token can be attached");
  }
  if (r.issued_token_type !== undefined && r.issued_token_type !== TOKEN_TYPE_ACCESS_TOKEN && r.issued_token_type !== TOKEN_TYPE_JWT) {
    return refuse("token_type_unsupported", "the issued token is not an access token");
  }
  const ceiling = Math.min(input.maxTtlSeconds, UPSTREAM_EXCHANGE_TTL_CEILING_SECONDS);
  if (r.expires_in === undefined || r.expires_in === null) return refuse("expiry_missing", "the answer has no expires_in");
  const expiresIn = typeof r.expires_in === "string" && /^\d+$/.test(r.expires_in) ? Number(r.expires_in) : r.expires_in;
  if (typeof expiresIn !== "number" || !Number.isInteger(expiresIn) || expiresIn <= 0) return refuse("malformed_response", "expires_in is not a positive integer");
  if (expiresIn > ceiling) return refuse("expiry_too_long", `expires_in ${expiresIn}s exceeds the ${ceiling}s ceiling`);
  let expiresAt = input.nowS + expiresIn;

  const asked = new Set(input.requestedScopes);
  // RFC 6749 §5.1: an absent scope means exactly the requested one
  const granted = r.scope === undefined || r.scope === null ? [...asked] : typeof r.scope === "string" ? scopeTokens(r.scope) : null;
  if (granted === null) return refuse("malformed_response", "scope is not a string");
  const wider = granted.filter((s) => !asked.has(s));
  if (wider.length > 0) return refuse("scope_widened", `the token carries scope beyond the request (${wider.length} extra)`);

  // a JWT access token is checked for what it says, too (an opaque one cannot be, and its answer above must do)
  let jwt = false;
  if (token.split(".").length === 3) {
    let claims: Record<string, unknown> | null = null;
    try {
      claims = decodeJwt(token) as Record<string, unknown>;
    } catch {
      claims = null;
    }
    if (claims) {
      jwt = true;
      const allowedAud = new Set([input.audience, ...(input.resource ? [input.resource] : [])]);
      const aud = claims.aud === undefined ? [] : Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (aud.length === 0 || aud.some((a) => typeof a !== "string" || !allowedAud.has(a))) {
        return refuse("audience_mismatch", "the token's aud is not exactly the pinned audience");
      }
      if (typeof claims.exp !== "number") return refuse("expiry_missing", "the JWT has no exp");
      if (claims.exp <= input.nowS - UPSTREAM_EXCHANGE_CLOCK_SKEW_SECONDS) return refuse("expired", "the token has already expired");
      if (claims.exp > input.nowS + ceiling + UPSTREAM_EXCHANGE_CLOCK_SKEW_SECONDS) return refuse("expiry_too_long", "the JWT's exp is past the ceiling");
      if (typeof claims.nbf === "number" && claims.nbf > input.nowS + UPSTREAM_EXCHANGE_CLOCK_SKEW_SECONDS) return refuse("malformed_response", "the JWT is not valid yet");
      const jwtScopes =
        typeof claims.scope === "string" ? scopeTokens(claims.scope) : Array.isArray(claims.scp) ? claims.scp.filter((s): s is string => typeof s === "string") : typeof claims.scp === "string" ? scopeTokens(claims.scp) : [];
      if (jwtScopes.some((s) => !asked.has(s))) return refuse("scope_widened", "the JWT carries scope beyond the request");
      expiresAt = Math.min(expiresAt, claims.exp);
    }
  }
  return { ok: true, token, expiresAt, grantedScope: canonicalScope(granted), jwt, refreshTokenDiscarded: r.refresh_token !== undefined };
}

// ---------------------------------------------------------------------------
// A connector's destination (the token's audience never follows a changed destination)
// ---------------------------------------------------------------------------

/** the origin a destination URL names, or the URL as given when it does not parse; null stays null (the compiled default) */
export function destinationOrigin(url: string | null | undefined): string | null {
  if (url === null || url === undefined || url === "") return null;
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** where a connector's calls go now: its credential's baseUrl, else its own (ADR-0034 amendment #2), as an origin */
export async function connectorEffectiveDestination(t: Db, connectorId: string): Promise<string | null> {
  const [c] = await t.select({ baseUrl: connectors.baseUrl }).from(connectors).where(eq(connectors.id, connectorId));
  const [cred] = await t.select({ baseUrl: connectorCredentials.baseUrl }).from(connectorCredentials).where(eq(connectorCredentials.connectorId, connectorId));
  return destinationOrigin(cred?.baseUrl ?? c?.baseUrl ?? null);
}

// ---------------------------------------------------------------------------
// Loading a target's configuration
// ---------------------------------------------------------------------------

export interface ExchangeTarget {
  kind: UpstreamExchangeTargetKind;
  id: string;
}

export interface LoadedExchange {
  row: UpstreamTokenExchangeRow;
  scopes: Map<string, string[]>;
}

const targetColumn = (kind: UpstreamExchangeTargetKind) => (kind === "mcp_server" ? upstreamTokenExchanges.mcpServerId : upstreamTokenExchanges.connectorId);

/** the target's configuration and scope map, read fresh (never cached), or null when there is none */
export async function loadUpstreamExchange(db: Db, target: ExchangeTarget): Promise<LoadedExchange | null> {
  const [row] = await db.select().from(upstreamTokenExchanges).where(eq(targetColumn(target.kind), target.id));
  if (!row) return null;
  const rows = await db.select().from(upstreamTokenExchangeScopes).where(eq(upstreamTokenExchangeScopes.exchangeId, row.id));
  const scopes = new Map<string, string[]>();
  for (const s of rows) scopes.set(s.action, [...(scopes.get(s.action) ?? []), s.scope]);
  for (const [k, v] of scopes) scopes.set(k, [...new Set(v)].sort());
  return { row, scopes };
}

// ---------------------------------------------------------------------------
// One exchange (the call-time path, shared by MCP and connectors)
// ---------------------------------------------------------------------------

export interface ExchangeContext {
  db: Db;
  dataKey: string | undefined;
  target: ExchangeTarget;
  /** the person the call is for (the subject) */
  sponsorUserId: string;
  /** the acting chain (root first), or null when the person calls directly */
  actors: ReadonlyArray<{ identityId: string; identifier: string }> | null;
  /** the tool, JSON-RPC method or connector operation that was allowed */
  action: string;
  projectId?: string | null;
  /**
   * connectors only: the destination this call is about to be sent to (the credential's baseUrl, else the connector's;
   * null = the adapter's compiled default). It must be the one the exchange was configured for, or nothing is obtained.
   */
  destination?: string | null;
  env?: NodeJS.ProcessEnv;
}

export type ExchangeOutcome =
  | { kind: "not_configured" }
  | { kind: "token"; token: string; expiresAt: number; scope: string; audience: string }
  | { kind: "refused"; code: UpstreamExchangeRefusalCode; decision: Decision };

function auditTarget(target: ExchangeTarget): { serverId: string | null; objectType: "mcp_server" | "connector"; objectId: string } {
  return target.kind === "mcp_server"
    ? { serverId: target.id, objectType: "mcp_server" as const, objectId: target.id }
    : { serverId: null, objectType: "connector" as const, objectId: target.id };
}

/** write the refusal row of a call-time exchange and return its decision (the caller denies the call with it) */
export async function writeExchangeRefusal(ctx: ExchangeContext, code: UpstreamExchangeRefusalCode, why: string): Promise<Decision> {
  const t = auditTarget(ctx.target);
  const decision: Decision = {
    effect: "deny",
    ruleId: UPSTREAM_EXCHANGE_RULE_IDS.refused,
    ruleChain: [],
    reason:
      `${t.objectType === "mcp_server" ? "MCP server" : "connector"} ${ctx.target.id} receives only a down-scoped token obtained by ` +
      `token exchange, and none could be obtained for '${ctx.action}' (${code}): ${why}. The call was not sent.`,
  };
  await ctx.db.insert(auditLog).values({
    userId: ctx.sponsorUserId,
    serverId: t.serverId,
    objectType: t.objectType,
    objectId: t.objectId,
    toolName: t.objectType === "mcp_server" ? ctx.action : null,
    detail: { phase: "token-exchange", code, action: ctx.action, projectId: ctx.projectId ?? null, receiptClass: "decision" },
    ...decision,
  });
  return decision;
}

async function readBounded(res: Response, limit: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Exchange for the down-scoped token of ONE allowed call, or say there is nothing to do (no enabled configuration).
 * Every refusal is audited here. The token is returned to the caller only after its "issued" row is written.
 */
export async function exchangeUpstreamToken(ctx: ExchangeContext): Promise<ExchangeOutcome> {
  const env = ctx.env ?? process.env;
  const loaded = await loadUpstreamExchange(ctx.db, ctx.target);
  if (!loaded || !loaded.row.enabled) return { kind: "not_configured" };
  const { row } = loaded;
  const refuse = async (code: UpstreamExchangeRefusalCode, why: string): Promise<ExchangeOutcome> => ({
    kind: "refused",
    code,
    decision: await writeExchangeRefusal(ctx, code, why),
  });

  // 0. a connector's token goes only where the exchange was configured to send it: a changed destination (a new
  //    credential baseUrl, say) is refused here, before anything is obtained, even if the write-time switch-off raced
  if (ctx.target.kind === "connector") {
    if (ctx.destination === undefined) return refuse("destination_mismatch", "the call's destination was not stated, so it cannot be checked");
    if (destinationOrigin(ctx.destination) !== row.connectorDestination) {
      return refuse("destination_mismatch", "the connector's destination changed since the exchange was configured; an admin re-confirms it with a step-up");
    }
  }

  // 1. DEFAULT-DENY: only the scopes mapped to this one action, never the union of the server's
  const scopes = loaded.scopes.get(ctx.action);
  if (!scopes || scopes.length === 0) return refuse("not_configured_for_action", "no scope is mapped to this action, so no token narrower than the whole upstream exists");
  const scope = canonicalScope(scopes);

  // 2. what we can sign with, captured before anything leaves
  if (!ctx.dataKey) return refuse("secret_unavailable", "the data key is not configured");
  let clientSecret: string;
  try {
    clientSecret = decryptSecret(ctx.dataKey, row.clientSecretCiphertext);
  } catch {
    return refuse("secret_unavailable", "the client secret does not decrypt under the configured data key");
  }
  const issuer = mcpIdentityOidcIssuer(env);
  if (!issuer) return refuse("issuer_not_configured", "REGULAIT_PUBLIC_URL does not name this deployment");
  const secrets = identitySecretsFor(ctx.dataKey);
  if (!secrets) return refuse("secret_unavailable", "the pairwise key cannot be derived");
  let signer: Awaited<ReturnType<typeof currentIssuerSigner>>;
  try {
    signer = await currentIssuerSigner(ctx.db, env, "ES256");
  } catch (err) {
    if (err instanceof IdentitySigningKeyError) return refuse("signing_key_unavailable", "no active ES256 issuer signing key is available");
    throw err;
  }

  // 3. the subject token: who the call is for (pairwise for the authorization server), who acts, and the SAME scope
  const audience = row.subjectTokenAudience;
  const subject = pairwiseSubject(secrets.pairwiseKey, audience, ctx.sponsorUserId);
  const actors = ctx.actors ? ctx.actors.map((a) => ({ identityId: a.identityId, identifier: pairwiseActor(secrets.pairwiseKey, audience, a.identityId) })) : null;
  const now = await databaseNow(ctx.db);
  const nowS = Math.floor(now.getTime() / 1000);
  const iat = Math.max(nowS, Math.floor(signer.activatedAt.getTime() / 1000));
  const signed = await signIdentityAssertion({ signer, issuer, audience, subject, actors, iat, jti: randomBytes(32).toString("base64url"), oidc: { scope } });

  // 4. the exchange: oauth4webapi builds the request and the client authentication (client_secret_basic, RFC 6749
  // §2.3.1 encoding); our egress-guarded fetch carries it (https only, the admin allow-list, no redirect is followed)
  const form = new URLSearchParams({
    subject_token: signed.assertion,
    subject_token_type: TOKEN_TYPE_JWT,
    requested_token_type: TOKEN_TYPE_ACCESS_TOKEN,
    audience: row.audience,
    scope,
  });
  if (row.resource) form.set("resource", row.resource);
  const guarded = createGuardedFetch({
    allowList: await loadEgressAllowList(ctx.db),
    ...(upstreamExchangeTestHooks.resolve ? { resolve: upstreamExchangeTestHooks.resolve } : {}),
    ...(upstreamExchangeTestHooks.fetchImpl ? { fetchImpl: upstreamExchangeTestHooks.fetchImpl } : {}),
  });
  const as: oauth.AuthorizationServer = { issuer: row.subjectTokenAudience, token_endpoint: row.tokenEndpoint };
  const client: oauth.Client = { client_id: row.clientId };
  let status: number;
  let body: string | null;
  try {
    const res = await oauth.genericTokenEndpointRequest(as, client, oauth.ClientSecretBasic(clientSecret), TOKEN_EXCHANGE_GRANT_TYPE, form, {
      [oauth.customFetch]: guarded,
      signal: AbortSignal.timeout(UPSTREAM_EXCHANGE_TIMEOUT_MS),
    });
    status = res.status;
    body = await readBounded(res, UPSTREAM_EXCHANGE_MAX_RESPONSE_BYTES);
  } catch (err) {
    if (err instanceof EgressBlockedError) return refuse("egress_blocked", "the token endpoint is not an allowed destination (an admin adds it under Egress Allow Hosts)");
    return refuse("endpoint_unreachable", "the token endpoint could not be reached");
  }
  if (body === null) return refuse("malformed_response", "the answer exceeds the response bound");

  // 5. the answer, held to the request (the database clock, re-read after the round trip)
  const checkedAtS = Math.floor((await databaseNow(ctx.db)).getTime() / 1000);
  const checked = checkExchangeResponse({
    status,
    body,
    requestedScopes: scopes,
    audience: row.audience,
    resource: row.resource,
    maxTtlSeconds: row.maxTokenTtlSeconds,
    nowS: checkedAtS,
  });
  if (!checked.ok) return refuse(checked.code, checked.why);
  // and the library's own token-response validation, over the same bounded body (never the live stream)
  try {
    await oauth.processGenericTokenEndpointResponse(as, client, new Response(body, { status, headers: { "content-type": "application/json" } }));
  } catch {
    return refuse("malformed_response", "the answer is not a valid token endpoint response");
  }

  // 6. never the same token twice: a second hand-out (to anyone) is refused, not reused
  const fingerprint = tokenFingerprint(checked.token);
  const fresh = await claimReplay(
    ctx.db,
    "upstream_exchanged_token",
    createHash("sha256").update(checked.token).digest("base64url"),
    new Date((checked.expiresAt + UPSTREAM_EXCHANGE_CLOCK_SKEW_SECONDS) * 1000),
  );
  if (!fresh) return refuse("token_replayed", "the authorization server returned a token it had already issued; it is never attached again");

  // 7. the disclosure is on the trail before the token can be used (never the token itself)
  const t = auditTarget(ctx.target);
  try {
    await ctx.db.insert(auditLog).values({
      userId: ctx.sponsorUserId,
      serverId: t.serverId,
      objectType: t.objectType,
      objectId: t.objectId,
      toolName: t.objectType === "mcp_server" ? ctx.action : null,
      detail: {
        phase: "token-exchange",
        action: ctx.action,
        audience: row.audience,
        resource: row.resource,
        requestedScope: scope,
        grantedScope: checked.grantedScope,
        subjectTokenJti: signed.jti,
        sub: subject,
        actorChain: actors ? actors.map((a) => a.identityId) : null,
        tokenFingerprint: fingerprint,
        tokenFormat: checked.jwt ? "jwt" : "opaque",
        refreshTokenDiscarded: checked.refreshTokenDiscarded,
        expiresAt: new Date(checked.expiresAt * 1000).toISOString(),
        projectId: ctx.projectId ?? null,
        // a disclosure record of an allowed call (its decision row is the call's own), never a decision itself
        receiptClass: "excluded",
      },
      effect: "allow",
      ruleId: UPSTREAM_EXCHANGE_RULE_IDS.issued,
      ruleChain: [],
      reason: `down-scoped token (scope "${checked.grantedScope}", audience ${row.audience}) obtained by token exchange for one '${ctx.action}' call`,
    });
  } catch {
    return refuse("audit_failed", "the exchange could not be audited, so the token is not used");
  }
  return { kind: "token", token: checked.token, expiresAt: checked.expiresAt, scope: checked.grantedScope, audience: row.audience };
}

// ---------------------------------------------------------------------------
// MCP: the per-call holder and its fetch middleware
// ---------------------------------------------------------------------------

/** OUR refusal at send time; an IdentityAssertionRefusedError, so it is never retried or charged to the breaker */
export class UpstreamExchangeRefusedError extends IdentityAssertionRefusedError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "UpstreamExchangeRefusedError";
  }
}

const originOf = (u: string | URL): string => {
  try {
    return new URL(u.toString()).origin;
  } catch {
    return "invalid";
  }
};

/**
 * One governed MCP call's exchanged token. Unarmed (attaches nothing, changes nothing) until the call is allowed and
 * the exchange succeeded; then every request of the call's connection to the registered origin carries the token in
 * `Authorization: Bearer` (any other value removed). Never shared between calls.
 */
export class UpstreamExchangeHolder {
  private armed: { token: string; expiresAt: number } | null = null;
  constructor(readonly serverUrl: string) {}

  arm(token: string, expiresAt: number): void {
    this.armed = { token, expiresAt };
  }

  disarm(): void {
    this.armed = null;
  }

  get isArmed(): boolean {
    return this.armed !== null;
  }

  prepare(input: string | URL, init: RequestInit | undefined, nowMs: number = Date.now()): RequestInit {
    const armed = this.armed;
    if (armed === null) return init ?? {};
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    if (originOf(input) !== originOf(this.serverUrl)) {
      throw new UpstreamExchangeRefusedError("destination_mismatch", "a down-scoped token is sent only to the server it was obtained for; nothing was sent");
    }
    if (armed.expiresAt * 1000 <= nowMs) {
      this.armed = null;
      throw new UpstreamExchangeRefusedError("expired", "the down-scoped token expired before the request; nothing was sent");
    }
    headers.set("authorization", `Bearer ${armed.token}`);
    return { ...init, headers };
  }
}

export function upstreamExchangeMiddleware(holder: UpstreamExchangeHolder): Middleware {
  return createMiddleware(async (next, input, init) => next(input, holder.prepare(input, init)));
}

/**
 * After the call is allowed and before the connect: obtain the call's down-scoped token and arm the holder, or refuse
 * the call. A server with no enabled configuration is untouched (`ok: true`, holder unarmed).
 */
export async function armUpstreamExchange(
  holder: UpstreamExchangeHolder,
  ctx: Omit<ExchangeContext, "target"> & { server: { id: string; transport?: string | null; identityAssertionProfile?: string | null } },
): Promise<{ ok: true } | { ok: false; decision: Decision }> {
  holder.disarm();
  const exchangeCtx: ExchangeContext = { ...ctx, target: { kind: "mcp_server", id: ctx.server.id } };
  const loaded = await loadUpstreamExchange(ctx.db, exchangeCtx.target);
  if (!loaded || !loaded.row.enabled) return { ok: true };
  if ((ctx.server.transport ?? "streamable_http") === "stdio") {
    return { ok: false, decision: await writeExchangeRefusal(exchangeCtx, "profile_conflict", "a stdio upstream has no HTTP request to carry a token") };
  }
  if (ctx.server.identityAssertionProfile === "oidc_bearer") {
    return { ok: false, decision: await writeExchangeRefusal(exchangeCtx, "profile_conflict", "the server's oidc_bearer assertion already rides in Authorization") };
  }
  const out = await exchangeUpstreamToken(exchangeCtx);
  if (out.kind === "refused") return { ok: false, decision: out.decision };
  if (out.kind === "token") holder.arm(out.token, out.expiresAt);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// A url move turns it off (the token's audience never follows the url)
// ---------------------------------------------------------------------------

export async function disableUpstreamExchangeOnUrlMove(
  tx: Db,
  args: { serverId: string; label: string; fromUrl: string; toUrl: string; userId: string | null },
): Promise<boolean> {
  const [was] = await tx
    .update(upstreamTokenExchanges)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(upstreamTokenExchanges.mcpServerId, args.serverId))
    .returning({ enabled: upstreamTokenExchanges.enabled, id: upstreamTokenExchanges.id });
  if (!was) return false;
  await tx.insert(auditLog).values({
    userId: args.userId ?? NIL_USER,
    serverId: args.serverId,
    objectType: "mcp_server",
    objectId: args.serverId,
    detail: { phase: "update", tokenExchange: "disabled", cause: "url_move", from: args.fromUrl, to: args.toUrl },
    effect: "allow",
    ruleId: UPSTREAM_EXCHANGE_RULE_IDS.updated,
    ruleChain: [],
    reason: `${args.label}: the url moved, so its token exchange was turned off (an admin turns it on again, with a step-up)`,
  });
  return true;
}

/**
 * A connector credential write (stored, replaced or removed) that changes where the connector calls turns its token
 * exchange off, audited in the same transaction: a token pinned to the old audience is never sent to a new host. The
 * send-time check in `exchangeUpstreamToken` refuses it as well, so this is the visible half of the same rule.
 */
export async function disableConnectorExchangeOnDestinationChange(
  tx: Db,
  args: { connectorId: string; label: string; userId: string | null; cause: "credential_stored" | "credential_replaced" | "credential_removed" },
): Promise<boolean> {
  const [row] = await tx
    .select({ id: upstreamTokenExchanges.id, enabled: upstreamTokenExchanges.enabled, destination: upstreamTokenExchanges.connectorDestination })
    .from(upstreamTokenExchanges)
    .where(eq(upstreamTokenExchanges.connectorId, args.connectorId))
    .for("update");
  if (!row || !row.enabled) return false;
  const now = await connectorEffectiveDestination(tx, args.connectorId);
  if (now === row.destination) return false;
  await tx.update(upstreamTokenExchanges).set({ enabled: false, updatedAt: new Date() }).where(eq(upstreamTokenExchanges.id, row.id));
  await tx.insert(auditLog).values({
    userId: args.userId ?? NIL_USER,
    objectType: "connector",
    objectId: args.connectorId,
    detail: { phase: "update", tokenExchange: "disabled", cause: "destination_change", via: args.cause, from: row.destination, to: now, receiptClass: "configuration" },
    effect: "allow",
    ruleId: UPSTREAM_EXCHANGE_RULE_IDS.updated,
    ruleChain: [],
    reason: `${args.label}: its destination changed, so its token exchange was turned off (an admin turns it on again, with a step-up)`,
  });
  return true;
}

// ---------------------------------------------------------------------------
// The admin routes: GET / PUT / DELETE /v1/{servers|connectors}/:id/token-exchange
// ---------------------------------------------------------------------------

export function upstreamExchangeView(loaded: LoadedExchange | null): UpstreamTokenExchangeView {
  if (!loaded) {
    return {
      configured: false,
      enabled: false,
      tokenEndpoint: null,
      subjectTokenAudience: null,
      audience: null,
      resource: null,
      clientId: null,
      clientSecretLast4: null,
      maxTokenTtlSeconds: null,
      scopes: {},
      setBy: null,
      secretSetAt: null,
    };
  }
  const { row } = loaded;
  return {
    configured: true,
    enabled: row.enabled,
    tokenEndpoint: row.tokenEndpoint,
    subjectTokenAudience: row.subjectTokenAudience,
    audience: row.audience,
    resource: row.resource,
    clientId: row.clientId,
    clientSecretLast4: row.clientSecretLast4,
    maxTokenTtlSeconds: row.maxTokenTtlSeconds,
    scopes: Object.fromEntries([...loaded.scopes].sort(([a], [b]) => a.localeCompare(b))),
    setBy: row.setBy,
    secretSetAt: row.secretSetAt.toISOString(),
  };
}

interface Refusal {
  status: number;
  body: Record<string, unknown>;
}
const isRefusal = (x: unknown): x is Refusal =>
  typeof x === "object" && x !== null && "status" in x && "body" in x && typeof (x as Refusal).status === "number";

class StepUpRefusedInTx extends Error {
  constructor(readonly refusal: Refusal, readonly args: StepUpCheckArgs) {
    super("step_up_refused_in_transaction");
  }
}

/** the step-up facts: the target and every value the write would store (never the secret, only whether it changes) */
export function upstreamExchangeStepUpArgs(op: "set" | "update" | "clear", target: ExchangeTarget, values: Record<string, unknown> | null): StepUpCheckArgs {
  return {
    kind: "settings_relax",
    facts: { op: `upstream_token_exchange_${op}`, targetKind: target.kind, targetId: target.id, ...(values ? { values: { tokenExchange: values } } : {}) },
  };
}

async function lockTarget(
  t: Db,
  target: ExchangeTarget,
): Promise<{ label: string; url: string | null; transport: string | null; profile: string | null; destination: string | null } | null> {
  if (target.kind === "mcp_server") {
    const [s] = await t
      .select({ name: mcpServers.name, url: mcpServers.url, transport: mcpServers.transport, profile: mcpServers.identityAssertionProfile })
      .from(mcpServers)
      .where(eq(mcpServers.id, target.id))
      .for("update");
    return s ? { label: `MCP server '${s.name}'`, url: s.url, transport: s.transport ?? null, profile: s.profile, destination: null } : null;
  }
  const [c] = await t.select({ name: connectors.name }).from(connectors).where(eq(connectors.id, target.id)).for("update");
  if (!c) return null;
  // the destination this configuration is pinned to, read under the connector's row lock
  return { label: `connector '${c.name}'`, url: null, transport: null, profile: null, destination: await connectorEffectiveDestination(t, target.id) };
}

const targetParams = {
  mcp_server: { path: "/v1/servers/:serverId/token-exchange", param: z.object({ serverId: z.string().uuid() }), id: (p: Record<string, string>) => p.serverId! },
  connector: { path: "/v1/connectors/:connectorId/token-exchange", param: z.object({ connectorId: z.string().uuid() }), id: (p: Record<string, string>) => p.connectorId! },
} as const;

export function registerUpstreamTokenExchangeRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined } = {}): void {
  for (const kind of ["mcp_server", "connector"] as const) {
    const spec = targetParams[kind];
    const targetOf = (req: FastifyRequest): ExchangeTarget => ({ kind, id: spec.id(spec.param.parse(req.params) as Record<string, string>) });

    const auditConfigRefusal = async (req: FastifyRequest, target: ExchangeTarget, label: string, code: string, detail: string) => {
      const t = auditTarget(target);
      await db.insert(auditLog).values({
        userId: req.authCtx.userId ?? NIL_USER,
        serverId: t.serverId,
        objectType: t.objectType,
        objectId: t.objectId,
        detail: { phase: "token-exchange-config", code, receiptClass: "configuration" },
        effect: "deny",
        ruleId: UPSTREAM_EXCHANGE_RULE_IDS.configRefused,
        ruleChain: [],
        reason: `${label}: token exchange configuration refused (${code}): ${detail}. Nothing was saved.`,
      });
    };

    /** run `write` under the target's row lock; the step-up is claimed in the same transaction, after the write */
    const underLock = async <T>(req: FastifyRequest, target: ExchangeTarget, stepUp: StepUpCheckArgs, write: (t: Db, locked: NonNullable<Awaited<ReturnType<typeof lockTarget>>>) => Promise<T | Refusal>): Promise<T | Refusal> => {
      try {
        return await db.transaction(async (tx) => {
          const t = tx as unknown as Db;
          const locked = await lockTarget(t, target);
          if (!locked) return { status: 404, body: { error: kind === "mcp_server" ? "unknown_server" : "unknown_connector" } };
          const out = await write(t, locked);
          if (isRefusal(out)) return out;
          const su = await checkStepUp(t, req, stepUp);
          if (!su.ok) throw new StepUpRefusedInTx({ status: su.status, body: su.body }, stepUp);
          return out;
        });
      } catch (err) {
        if (!(err instanceof StepUpRefusedInTx)) throw err;
        await checkStepUp(db, req, err.args, { spend: false });
        return err.refusal;
      }
    };

    app.get(spec.path, async (req, reply) => {
      const target = targetOf(req);
      const exists = await lockTargetRead(db, target);
      if (!exists) return reply.status(404).send({ error: kind === "mcp_server" ? "unknown_server" : "unknown_connector" });
      return { tokenExchange: upstreamExchangeView(await loadUpstreamExchange(db, target)) };
    });

    app.put(spec.path, async (req, reply) => {
      const target = targetOf(req);
      const parsed = setUpstreamTokenExchangeSchema.safeParse(req.body);
      // the zod issues could echo the body, and the body may hold the secret: a fixed sentence instead
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_request",
          detail:
            "expected { enabled, tokenEndpoint (https), subjectTokenAudience, audience, resource? (https), clientId, clientSecret?, " +
            "maxTokenTtlSeconds? (30-900), scopes: { <action>: [<scope>, ...] } } with RFC 6749 scope tokens",
        });
      }
      const body = parsed.data;
      const current = await lockTargetRead(db, target);
      if (!current) return reply.status(404).send({ error: kind === "mcp_server" ? "unknown_server" : "unknown_connector" });
      const refuse = async (status: number, code: string, detail: string) => {
        await auditConfigRefusal(req, target, current.label, code, detail);
        return reply.status(status).send({ error: "upstream_token_exchange_refused", code, detail });
      };
      if (kind === "mcp_server" && current.transport === "stdio") return refuse(409, "stdio", "a stdio server has no HTTP request to carry a token");
      if (kind === "mcp_server" && current.profile === "oidc_bearer") {
        return refuse(409, "profile_conflict", "this server's oidc_bearer assertion already rides in Authorization: return it to the regulait_header profile first");
      }
      if (kind === "mcp_server") {
        const [bearer] = await db
          .select({ scheme: mcpServerUpstreamCredentials.scheme })
          .from(mcpServerUpstreamCredentials)
          .where(eq(mcpServerUpstreamCredentials.serverId, target.id));
        if (bearer?.scheme === "bearer") return refuse(409, "bearer_credential_conflict", "this server already sends a static Bearer credential: clear it first");
      }
      if (!opts.dataKey) return reply.status(503).send({ error: "data_key_unavailable", detail: "the data key is not configured, so a secret cannot be stored encrypted" });
      const existing = await loadUpstreamExchange(db, target);
      if (!existing && body.clientSecret === undefined) return refuse(400, "secret_required", "a new configuration needs its client secret");
      const scopes = Object.fromEntries(Object.entries(body.scopes).map(([a, s]) => [a, [...new Set(s)].sort()]).sort(([a], [b]) => (a as string).localeCompare(b as string)));
      const values = {
        enabled: body.enabled,
        tokenEndpoint: body.tokenEndpoint,
        subjectTokenAudience: body.subjectTokenAudience,
        audience: body.audience,
        resource: body.resource ?? null,
        clientId: body.clientId,
        maxTokenTtlSeconds: body.maxTokenTtlSeconds ?? existing?.row.maxTokenTtlSeconds ?? UPSTREAM_EXCHANGE_TTL_DEFAULT_SECONDS,
        scopes,
        clientSecretRotated: body.clientSecret !== undefined,
      };
      const stepUp = upstreamExchangeStepUpArgs(existing ? "update" : "set", target, values);
      // looked at (not spent) before anything is written, so a refusal here never burns a grant
      const look = await checkStepUp(db, req, stepUp, { spend: false });
      if (!look.ok) return reply.status(look.status).send(look.body);
      const secretColumns = body.clientSecret !== undefined ? { clientSecretCiphertext: encryptSecret(opts.dataKey, body.clientSecret), clientSecretLast4: body.clientSecret.slice(-4) } : {};
      const out = await underLock(req, target, stepUp, async (t, locked) => {
        if (kind === "mcp_server" && locked.profile === "oidc_bearer") {
          return { status: 409, body: { error: "upstream_token_exchange_refused", code: "profile_conflict", detail: "the server's oidc_bearer profile was turned on concurrently" } };
        }
        const [again] = await t.select({ id: upstreamTokenExchanges.id }).from(upstreamTokenExchanges).where(eq(targetColumn(kind), target.id));
        if (Boolean(again) !== Boolean(existing) || (again && again.id !== existing?.row.id)) return { status: CHANGED_CONCURRENTLY.status, body: { ...CHANGED_CONCURRENTLY.body } };
        const row = {
          enabled: values.enabled,
          tokenEndpoint: values.tokenEndpoint,
          subjectTokenAudience: values.subjectTokenAudience,
          audience: values.audience,
          resource: values.resource,
          clientId: values.clientId,
          maxTokenTtlSeconds: values.maxTokenTtlSeconds,
          // connectors: pinned to where the connector calls now; a later change of destination turns it off
          connectorDestination: kind === "connector" ? locked.destination : null,
          setBy: req.authCtx.userId ?? null,
          updatedAt: new Date(),
          ...secretColumns,
        };
        let id: string;
        if (existing) {
          await t.update(upstreamTokenExchanges).set(row).where(eq(upstreamTokenExchanges.id, existing.row.id));
          id = existing.row.id;
          await t.delete(upstreamTokenExchangeScopes).where(eq(upstreamTokenExchangeScopes.exchangeId, id));
        } else {
          const [ins] = await t
            .insert(upstreamTokenExchanges)
            .values({
              ...(kind === "mcp_server" ? { mcpServerId: target.id } : { connectorId: target.id }),
              ...row,
              clientSecretCiphertext: secretColumns.clientSecretCiphertext!,
              clientSecretLast4: secretColumns.clientSecretLast4!,
            })
            .returning({ id: upstreamTokenExchanges.id });
          id = ins!.id;
        }
        const scopeRows = Object.entries(scopes).flatMap(([action, list]) => (list as string[]).map((scope) => ({ exchangeId: id, action, scope })));
        if (scopeRows.length > 0) await t.insert(upstreamTokenExchangeScopes).values(scopeRows);
        const at = auditTarget(target);
        await t.insert(auditLog).values({
          userId: req.authCtx.userId ?? NIL_USER,
          serverId: at.serverId,
          objectType: at.objectType,
          objectId: at.objectId,
          detail: {
            phase: "token-exchange-config",
            tokenExchange: existing ? "updated" : "set",
            ...values,
            ...(kind === "connector" ? { destination: locked.destination } : {}),
            // turning it on (or keeping it on while changing what it may obtain) is the relaxation
            relaxation: values.enabled,
            receiptClass: "configuration",
          },
          effect: "allow",
          ruleId: existing ? UPSTREAM_EXCHANGE_RULE_IDS.updated : UPSTREAM_EXCHANGE_RULE_IDS.set,
          ruleChain: [],
          reason:
            `${locked.label}: token exchange ${existing ? "updated" : "configured"} (${values.enabled ? "on" : "off"}; audience ${values.audience}; ` +
            `${Object.keys(scopes).length} mapped action(s)${values.clientSecretRotated ? "; client secret set" : ""})`,
        });
        return id;
      });
      if (isRefusal(out)) return reply.status(out.status).send(out.body);
      return reply.status(existing ? 200 : 201).send({ tokenExchange: upstreamExchangeView(await loadUpstreamExchange(db, target)) });
    });

    app.delete(spec.path, async (req, reply) => {
      const target = targetOf(req);
      const existing = await loadUpstreamExchange(db, target);
      if (!existing) return reply.status(404).send({ error: "no_token_exchange", detail: "nothing is configured" });
      const stepUp = upstreamExchangeStepUpArgs("clear", target, null);
      const look = await checkStepUp(db, req, stepUp, { spend: false });
      if (!look.ok) return reply.status(look.status).send(look.body);
      const out = await underLock(req, target, stepUp, async (t, locked) => {
        const [gone] = await t.delete(upstreamTokenExchanges).where(eq(upstreamTokenExchanges.id, existing.row.id)).returning({ id: upstreamTokenExchanges.id });
        if (!gone) return { status: CHANGED_CONCURRENTLY.status, body: { ...CHANGED_CONCURRENTLY.body } };
        const at = auditTarget(target);
        await t.insert(auditLog).values({
          userId: req.authCtx.userId ?? NIL_USER,
          serverId: at.serverId,
          objectType: at.objectType,
          objectId: at.objectId,
          detail: { phase: "token-exchange-config", tokenExchange: "cleared", receiptClass: "configuration" },
          effect: "allow",
          ruleId: UPSTREAM_EXCHANGE_RULE_IDS.cleared,
          ruleChain: [],
          reason: `${locked.label}: token exchange cleared; its stored client secret was destroyed`,
        });
        return true;
      });
      if (isRefusal(out)) return reply.status(out.status).send(out.body);
      return { tokenExchange: upstreamExchangeView(null) };
    });
  }
}

/** the target's facts for a refusal check before any lock (re-checked under the lock) */
async function lockTargetRead(db: Db, target: ExchangeTarget) {
  if (target.kind === "mcp_server") {
    const [s] = await db
      .select({ name: mcpServers.name, url: mcpServers.url, transport: mcpServers.transport, profile: mcpServers.identityAssertionProfile })
      .from(mcpServers)
      .where(eq(mcpServers.id, target.id));
    return s ? { label: `MCP server '${s.name}'`, url: s.url, transport: s.transport ?? null, profile: s.profile } : null;
  }
  const [c] = await db.select({ name: connectors.name }).from(connectors).where(eq(connectors.id, target.id));
  return c ? { label: `connector '${c.name}'`, url: null, transport: null, profile: null } : null;
}
