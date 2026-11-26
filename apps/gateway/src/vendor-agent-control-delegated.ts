/**
 * ADR-0338 slice 1c: connecting a DELEGATED vendor control credential (one named admin account) through the vendor's
 * OAuth authorization-code flow with PKCE, and using it with a refresh token that rotates on use (§3a).
 *
 * STRICT DEFAULT (ADR-0180): nothing here works until an admin has turned on
 * `discovery_settings.vendor_agent_control_delegated_enabled` (a `settings_relax` step-up, slice 1b), the source's
 * control lists `delegated` in its `acceptedModes` and declares a `delegatedScope`, and the data key is configured.
 *
 * Open source first (ADR-0176): `@azure/msal-node` (MIT, Entra's own client, exact-pinned) builds the authorization
 * URL, redeems the code with the PKCE verifier and nonce, and redeems the refresh token. It talks to Entra only
 * through `networkClient`, which is the tenant's guarded fetch narrowed by `allowListedFetch` to one call: POST the
 * tenant's v2.0 token endpoint. The authority and cloud metadata are given statically, so msal makes no discovery
 * call (air-gap: no metadata fetch). The confidential client authenticates with a federated assertion for the CONTROL
 * subject (`vendorAgentControlSubject`), never a stored client secret: the row's one ciphertext is the refresh token.
 *
 * FOUR EYES: the admin who starts the sign-in names a second administrator (`approverUserId`), never themself. After
 * the sign-in the account's refresh token is HELD encrypted on the request, and the credential is stored only when
 * that approver approves in the Approvals Queue (`POST /v1/approvals/:id/decide`, an `approval_decide` step-up bound to
 * {approvalId, decision, argumentsDigest}). The lifecycle is ADR-0348's `vendor_control_delegated` machine
 * (`VENDOR_CONTROL_DELEGATED_MACHINE`); every writer goes through `whereFrom` with a returned row.
 *
 * Routes (admin-only, API-only: KNOWN_UI_GAPS against #453):
 *   POST /v1/discovery/sources/:sourceId/control-credential/delegated   start a sign-in (`settings_relax` step-up)
 *   GET  /v1/discovery/control-credential/delegated/callback            the vendor's redirect: holds the token, queues the approval
 *   GET  /v1/discovery/control-credential/delegated/:requestId          one request and its lifecycle
 *   POST /v1/discovery/control-credential/delegated/:requestId/cancel   withdraw it before approval (narrows: no step-up)
 *
 * The state, nonce and PKCE verifier stay server side (`vendor_control_delegated_requests`, the verifier encrypted),
 * so an intercepted redirect cannot be redeemed. The sign-in window is 10 minutes and only the admin who started it can
 * complete it. The ID token is taken from the token endpoint's own TLS response (OIDC Core §3.1.3.7), and its tenant,
 * account and nonce must match what the step-up was bound to.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ConfidentialClientApplication, CryptoProvider, LogLevel, type AuthenticationResult, type INetworkModule, type NetworkRequestOptions, type NetworkResponse } from "@azure/msal-node";
import * as oauth from "oauth4webapi";
import {
  and,
  approvals,
  auditLog,
  discoveryCredentials,
  discoverySettings,
  discoverySources,
  eq,
  inArray,
  isNull,
  runWithRlsSystem,
  sql,
  users,
  vendorControlDelegatedRequests,
  type Db,
  type DiscoveryCredentialRow,
  type SQL,
  type VendorControlDelegatedRequestRow,
} from "@regulait/db";
import {
  approvalArgumentsDigest,
  approvalArgumentsPreview,
  FEDERATION_AUDIENCES,
  VENDOR_CONTROL_DELEGATED_MACHINE,
  vendorAgentControlSubject,
  type DiscoverySourceKind,
} from "@regulait/shared";
import { allowListedFetch } from "./agent-platform-endpoints.js";
import { readCookie, requestIsSecure, ssoBindingCookie, ssoBindingMatches, ssoBrowserBinding } from "./auth.js";
import { loadApprovalPool, requestedAtOf } from "./approval-pool.js";
import { errMessage } from "./err-serializer.js";
import { federationTokenMinter } from "./federation-signing-keys.js";
import { deploymentBaseUrl } from "./public-url.js";
import { whereFrom } from "./state-transition.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { checkStepUp, isStepUpPrompt, type StepUpCheckArgs } from "./step-up.js";
import type { SchedulerJobDefinition } from "./scheduler.js";
import type { VendorAgentControl } from "./vendor-agent-control-contract.js";

export const ENTRA_AUTHORITY_HOST = "https://login.microsoftonline.com";
export const DELEGATED_CALLBACK_PATH = "/v1/discovery/control-credential/delegated/callback";
/** how long a started sign-in may wait for the vendor's redirect (the table's CHECK caps it at 10 minutes) */
export const DELEGATED_REQUEST_TTL_MS = 10 * 60 * 1000;
export const DELEGATED_DEFAULT_DAYS = 30;
export const DELEGATED_MAX_DAYS = 90;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const b64url = (n: number) => randomBytes(n).toString("base64url");

/** a delegated token failure; `code` is what the routes answer (a 502 for the vendor, a 409 for our own refusals) */
export class DelegatedTokenError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(detail);
    this.name = "DelegatedTokenError";
  }
}

export interface DelegatedDeps {
  dataKey?: string;
  /** the tenant's guarded fetch (egress allow-list, SSRF guard), built per call */
  fetch: () => Promise<typeof fetch>;
  /** TEST SEAM: the federation token supplier for a source's control subject (default: the federation issuer) */
  federationToken?: (db: Db, sourceId: string) => (audience: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// The msal client
// ---------------------------------------------------------------------------

/** the one Entra call msal may make: POST this tenant's v2.0 token endpoint */
const tokenEndpoint = (tenantId: string) => `${ENTRA_AUTHORITY_HOST}/${tenantId}/oauth2/v2.0/token`;

/** static metadata, so msal makes no instance-discovery or OpenID-configuration request (air-gap; one egress call) */
function staticMetadata(tenantId: string) {
  return {
    authorityMetadata: JSON.stringify({
      token_endpoint: tokenEndpoint(tenantId),
      authorization_endpoint: `${ENTRA_AUTHORITY_HOST}/${tenantId}/oauth2/v2.0/authorize`,
      end_session_endpoint: `${ENTRA_AUTHORITY_HOST}/${tenantId}/oauth2/v2.0/logout`,
      issuer: `${ENTRA_AUTHORITY_HOST}/${tenantId}/v2.0`,
      jwks_uri: `${ENTRA_AUTHORITY_HOST}/${tenantId}/discovery/v2.0/keys`,
    }),
    cloudDiscoveryMetadata: JSON.stringify({
      tenant_discovery_endpoint: `${ENTRA_AUTHORITY_HOST}/${tenantId}/v2.0/.well-known/openid-configuration`,
      "api-version": "1.1",
      metadata: [{ preferred_network: "login.microsoftonline.com", preferred_cache: "login.windows.net", aliases: ["login.microsoftonline.com", "login.windows.net", "login.microsoft.com", "sts.windows.net"] }],
    }),
  };
}

/** msal's network module over the guarded fetch, admitting only the token endpoint; response bodies are JSON */
function guardedNetworkClient(base: typeof fetch, tenantId: string, signal?: AbortSignal): INetworkModule {
  const f = allowListedFetch(base, new Set([ENTRA_AUTHORITY_HOST]), [{ method: "POST", path: new RegExp(`^/${tenantId}/oauth2/v2\\.0/token$`) }]);
  const send = async <T>(method: "GET" | "POST", url: string, options?: NetworkRequestOptions): Promise<NetworkResponse<T>> => {
    const res = await f(url, { method, headers: options?.headers ?? {}, ...(options?.body !== undefined ? { body: options.body } : {}), ...(signal ? { signal } : {}) });
    const text = await res.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { headers, body: body as T, status: res.status };
  };
  return { sendGetRequestAsync: (url, options) => send("GET", url, options), sendPostRequestAsync: (url, options) => send("POST", url, options) };
}

function msalClient(base: typeof fetch, tenantId: string, clientId: string, assertion: (audience: string) => Promise<string>, signal?: AbortSignal) {
  return new ConfidentialClientApplication({
    auth: {
      clientId,
      authority: `${ENTRA_AUTHORITY_HOST}/${tenantId}`,
      knownAuthorities: ["login.microsoftonline.com"],
      ...staticMetadata(tenantId),
      clientAssertion: () => assertion(FEDERATION_AUDIENCES.azure),
    },
    system: {
      networkClient: guardedNetworkClient(base, tenantId, signal),
      disableInternalRetries: true,
      // nothing msal logs reaches our logs: no PII, no tokens
      loggerOptions: { piiLoggingEnabled: false, logLevel: LogLevel.Error, loggerCallback: () => undefined },
    },
  });
}

/** the refresh token msal holds after a redemption (the rotated one after a refresh), read from its in-memory cache */
async function refreshTokenOf(client: ConfidentialClientApplication): Promise<string | null> {
  const cache = JSON.parse(client.getTokenCache().serialize()) as { RefreshToken?: Record<string, { secret?: unknown }> };
  const rts = Object.values(cache.RefreshToken ?? {})
    .map((r) => r.secret)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  return rts.length === 1 ? rts[0]! : null;
}

/** only the AADSTS code survives from Entra's error text (as the app-only path does) */
const aadCode = (err: unknown) => /AADSTS[0-9]{5,7}/.exec(errMessage(err))?.[0];

const defaultFederationToken = (dataKey: string | undefined) => (db: Db, sourceId: string) =>
  federationTokenMinter(db, { dataKey, subject: vendorAgentControlSubject(sourceId), allowedAudiences: [FEDERATION_AUDIENCES.azure] });

/**
 * The token endpoint's answer, validated by oauth4webapi (ADR-0176: the library's OIDC Core §3.1.3.7 checks, never
 * hand-written ones): the ID token's `iss` is this tenant's v2.0 issuer, `aud` is the app, `exp`/`iat` are current and,
 * on a code redemption, `nonce` is the request's. Its signature is not checked because it came straight from the token
 * endpoint over TLS (§3.1.3.7 item 6), which is also why no JWKS is fetched (air-gap, one egress call). The granted
 * scopes must include the control's delegated scope. Answers the validated claims.
 */
export async function validatedTokenResponse(
  result: AuthenticationResult,
  want: { tenantId: string; clientId: string; scope: string; nonce?: string },
): Promise<Record<string, unknown>> {
  if (!result.idToken) throw new DelegatedTokenError("delegated_id_token_missing", "Entra returned no ID token, so the account cannot be established");
  const granted = (result.scopes ?? []).map((x) => x.toLowerCase());
  if (!granted.includes(want.scope.toLowerCase())) {
    throw new DelegatedTokenError("delegated_scope_not_granted", "Entra did not grant the control's delegated scope");
  }
  const as: oauth.AuthorizationServer = { issuer: `${ENTRA_AUTHORITY_HOST}/${want.tenantId}/v2.0` };
  const client: oauth.Client = { client_id: want.clientId };
  // the same JSON the token endpoint sent, re-presented to the library's response processor
  const response = new Response(
    JSON.stringify({ access_token: result.accessToken || "unused", token_type: "Bearer", id_token: result.idToken, scope: (result.scopes ?? []).join(" ") }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
  try {
    const processed =
      want.nonce !== undefined
        ? await oauth.processAuthorizationCodeResponse(as, client, response, { expectedNonce: want.nonce, requireIdToken: true })
        : await oauth.processRefreshTokenResponse(as, client, response);
    const claims = oauth.getValidatedIdTokenClaims(processed);
    if (!claims) throw new Error("no validated ID token");
    return claims as Record<string, unknown>;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    throw new DelegatedTokenError("delegated_id_token_invalid", `the ID token failed validation${typeof code === "string" ? ` (${code})` : ""}`);
  }
}

/**
 * The account a validated token is for: matched on the immutable `tid` and `oid` (never `preferred_username`, which
 * Microsoft documents as mutable and not for authorization). A guest (another home tenant: `acct` = 1, or an `idp`
 * that is not this tenant's issuer) is refused, so a same-UPN guest can never stand in for the named member account.
 */
function accountOf(claims: Record<string, unknown>, tenantId: string): { tenantId: string; objectId: string; upn: string | null } | null {
  const tid = typeof claims.tid === "string" ? claims.tid.toLowerCase() : "";
  const oid = typeof claims.oid === "string" ? claims.oid.toLowerCase() : "";
  if (!GUID.test(tid) || !GUID.test(oid)) return null;
  const guest = claims.acct === 1 || claims.acct === "1" || (typeof claims.idp === "string" && claims.idp !== `https://sts.windows.net/${tenantId}/` && claims.idp !== `${ENTRA_AUTHORITY_HOST}/${tenantId}/v2.0`);
  if (guest) return null;
  const upn = typeof claims.preferred_username === "string" ? claims.preferred_username.toLowerCase() : null;
  return { tenantId: tid, objectId: oid, upn };
}

// ---------------------------------------------------------------------------
// Using a delegated credential: the access token, and the refresh token rotating on use
// ---------------------------------------------------------------------------

/**
 * An access token for `control.token.delegatedScope` from a delegated row. The stored refresh token is redeemed; the
 * refresh token Entra returns replaces it in the same row (the guard trigger allows only the ciphertext to change),
 * conditional on the row still holding the one redeemed, so a concurrent rotation is not overwritten. The token must
 * be for the row's account.
 */
export async function delegatedAccessToken(db: Db, deps: DelegatedDeps, cred: DiscoveryCredentialRow, control: VendorAgentControl, signal: AbortSignal): Promise<string> {
  const scope = control.token.delegatedScope;
  if (!scope) throw new DelegatedTokenError("credential_mode_not_accepted", "this vendor declares no delegated scope");
  const { tenantId, clientId, accountObjectId } = cred.publicConfig;
  if (!tenantId || !clientId || !accountObjectId) throw new DelegatedTokenError("credential_incomplete", "the delegated credential names no tenant, app or account");
  if (!deps.dataKey || !cred.secretCiphertext) throw new DelegatedTokenError("data_key_unavailable", "the stored refresh token cannot be read without the data key");
  let refreshToken: string;
  try {
    refreshToken = decryptSecret(deps.dataKey, cred.secretCiphertext);
  } catch {
    throw new DelegatedTokenError("credential_unreadable", "the delegated credential does not decrypt under the current data key");
  }
  const assertion = (deps.federationToken ?? defaultFederationToken(deps.dataKey))(db, cred.sourceId);
  const client = msalClient(await deps.fetch(), tenantId, clientId, assertion, signal);
  let result: AuthenticationResult | null;
  try {
    // forceCache: the client is fresh per use, so the account is not in its cache; without it msal drops the rotated
    // refresh token (its ADAL-migration path), and the one Entra returned would be lost
    result = await client.acquireTokenByRefreshToken({ refreshToken, scopes: [scope], forceCache: true });
  } catch (err) {
    const aad = aadCode(err);
    throw new DelegatedTokenError("control_token_failed", `the Entra refresh-token request failed${aad ? ` (${aad})` : ""}`);
  }
  if (!result?.accessToken) throw new DelegatedTokenError("control_token_failed", "the Entra refresh-token request returned no access token");
  const claims = await validatedTokenResponse(result, { tenantId, clientId, scope });
  const who = accountOf(claims, tenantId);
  if (!who || who.tenantId !== tenantId || who.objectId !== accountObjectId) {
    throw new DelegatedTokenError("delegated_account_mismatch", "the refreshed token is not for the credential's named account");
  }
  const rotated = await refreshTokenOf(client);
  if (rotated && rotated !== refreshToken) {
    await db
      .update(discoveryCredentials)
      .set({ secretCiphertext: encryptSecret(deps.dataKey, rotated) })
      .where(and(eq(discoveryCredentials.id, cred.id), isNull(discoveryCredentials.revokedAt), eq(discoveryCredentials.secretCiphertext, cred.secretCiphertext)));
  }
  return result.accessToken;
}

// ---------------------------------------------------------------------------
// Routes and the approval
// ---------------------------------------------------------------------------

export const VENDOR_CONTROL_DELEGATED_APPROVAL_PREFIX = "__vendor_control_delegated__:";
const DEFAULT_APPROVAL_TTL_HOURS = 24;

const sourceParam = z.object({ sourceId: z.string().uuid() });
const requestParam = z.object({ requestId: z.string().uuid() });
export const delegatedStartSchema = z
  .object({
    /** the source's tenant and the write app (identifiers only) */
    tenantId: z.string().regex(/^[0-9a-fA-F-]{36}$/),
    clientId: z.string().regex(/^[0-9a-fA-F-]{36}$/),
    /** the named admin account's UPN: the login hint and a label only (a UPN is mutable, never what is matched) */
    account: z.string().min(3).max(320).regex(/^[^\s@]+@[^\s@]+$/),
    /** the named admin account's immutable object id (oid): the sign-in must come back as exactly this account */
    accountObjectId: z.string().regex(/^[0-9a-fA-F-]{36}$/),
    expiresInDays: z.number().int().min(1).max(DELEGATED_MAX_DAYS).default(DELEGATED_DEFAULT_DAYS),
    replacesCredentialId: z.string().uuid().nullable(),
    /** four eyes: the second administrator who must approve it before the credential exists */
    approverUserId: z.string().uuid(),
  })
  .strict();
export type DelegatedStartBody = z.infer<typeof delegatedStartSchema>;

/** the start step-up: bound to the source, the account, the tenant, the app, the expiry, the row replaced and the approver */
export const delegatedStepUp = (sourceId: string, b: DelegatedStartBody): StepUpCheckArgs => ({
  kind: "settings_relax",
  facts: {
    op: "vendor_control_delegated",
    sourceId: sourceId.toLowerCase(),
    account: b.account.toLowerCase(),
    accountObjectId: b.accountObjectId.toLowerCase(),
    tenantId: b.tenantId.toLowerCase(),
    clientId: b.clientId.toLowerCase(),
    expiresInDays: b.expiresInDays,
    replacesCredentialId: b.replacesCredentialId?.toLowerCase() ?? null,
    approverUserId: b.approverUserId.toLowerCase(),
  },
});

/** what the approver signs: the signed-in account and everything the credential will be stored with */
export interface DelegatedFacts {
  requestId: string;
  sourceId: string;
  tenantId: string;
  clientId: string;
  accountObjectId: string;
  accountUpn: string;
  expiresInDays: number;
  replacesCredentialId: string | null;
}
const factsOf = (r: VendorControlDelegatedRequestRow): DelegatedFacts => ({
  requestId: r.id,
  sourceId: r.sourceId,
  tenantId: r.tenantId,
  clientId: r.clientId,
  accountObjectId: r.accountObjectId,
  accountUpn: r.accountUpn,
  expiresInDays: r.expiresInDays,
  replacesCredentialId: r.replacesCredentialId,
});
export const delegatedArgumentsDigest = (f: DelegatedFacts) => approvalArgumentsDigest({ projectId: null, arguments: { op: "vendor_control_delegated", ...f } });
export const delegatedDecideStepUp = (approvalId: string, decision: "approved" | "denied", argumentsDigest: string): StepUpCheckArgs => ({
  kind: "approval_decide",
  facts: { op: "vendor_control_delegated", approvalId, decision, argumentsDigest },
});

const callbackQuery = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code: z.string().min(1).max(8192).optional(),
  error: z.string().max(256).optional(),
});

/**
 * ADR-0167's browser binding, reused for this sign-in (review of #1251 [1]). Entra's redirect back is a cross-site
 * top-level navigation, which never carries the `SameSite=Strict` session cookie, so the callback cannot ask for a
 * session. Instead the start answer sets an HttpOnly `SameSite=Lax` cookie, scoped to the callback path, holding an
 * HMAC of the state under the data key; the callback (auth-exempt) completes the request only in the browser that
 * started it, and acts as the admin who started it. The state stays unguessable and server side, and the PKCE
 * verifier never leaves the server, so neither a planted redirect nor a stolen URL completes it.
 */
export const DELEGATED_BINDING_COOKIE = "regulait_vcd_login";
export const delegatedBrowserBinding = (dataKey: string | undefined, state: string) => ssoBrowserBinding(dataKey, `vendor-control-delegated\0${state}`);

type Refusal = { status: number; body: Record<string, unknown> };
const refusal = (status: number, error: string, detail: string, extra: Record<string, unknown> = {}): Refusal => ({ status, body: { error, detail, ...extra } });
const isRefusal = (x: unknown): x is Refusal => typeof x === "object" && x !== null && "status" in x && "body" in x;

const audit = (t: Db, userId: string, objectId: string | null, ruleId: string, effect: "allow" | "deny" | "require_approval", reason: string, detail: Record<string, unknown>) =>
  t.insert(auditLog).values({ userId, objectType: "discovery_credential", objectId, detail: { subsystem: "vendor-agent-control", adr: "0338", purpose: "platform_write", mode: "delegated", ...detail }, effect, ruleId, ruleChain: [], reason });

/** what an admin sees of a request: never a verifier, a token or a ciphertext */
export function delegatedView(r: VendorControlDelegatedRequestRow) {
  return {
    id: r.id,
    sourceId: r.sourceId,
    status: r.status,
    lifecycle: VENDOR_CONTROL_DELEGATED_MACHINE.describe(r.status),
    requestedBy: r.requestedBy,
    approverUserId: r.approverUserId,
    tenantId: r.tenantId,
    clientId: r.clientId,
    accountUpn: r.accountUpn,
    accountObjectId: r.accountObjectId,
    expiresInDays: r.expiresInDays,
    replacesCredentialId: r.replacesCredentialId,
    approvalId: r.approvalId,
    credentialId: r.credentialId,
    outcomeCode: r.outcomeCode,
    requestedAt: r.requestedAt.toISOString(),
    signInExpiresAt: r.signInExpiresAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * The two expiries, applied on every read and write before the row is used: a sign-in whose 10 minutes passed, and an
 * approval whose window passed (its approval is superseded). Each moves `expire` through `whereFrom`, destroys what the
 * state held, and is audited in the same transaction.
 */
export async function touchDueDelegated(t: Db, scope?: SQL): Promise<number> {
  const signIns = await t
    .update(vendorControlDelegatedRequests)
    .set({ status: VENDOR_CONTROL_DELEGATED_MACHINE.next("awaiting_sign_in", "expire"), codeVerifierCiphertext: null, outcomeCode: "sign_in_window_passed", updatedAt: sql`now()` })
    .where(and(scope, eq(vendorControlDelegatedRequests.status, "awaiting_sign_in"), whereFrom(vendorControlDelegatedRequests.status, VENDOR_CONTROL_DELEGATED_MACHINE, "expire"), sql`${vendorControlDelegatedRequests.signInExpiresAt} <= now()`))
    .returning();
  const approvalsDue = await t
    .update(vendorControlDelegatedRequests)
    .set({ status: VENDOR_CONTROL_DELEGATED_MACHINE.next("awaiting_approval", "expire"), refreshTokenCiphertext: null, outcomeCode: "approval_expired", updatedAt: sql`now()` })
    .where(
      and(
        scope,
        eq(vendorControlDelegatedRequests.status, "awaiting_approval"),
        whereFrom(vendorControlDelegatedRequests.status, VENDOR_CONTROL_DELEGATED_MACHINE, "expire"),
        sql`EXISTS (SELECT 1 FROM ${approvals} p WHERE p.id = ${vendorControlDelegatedRequests.approvalId} AND p.expires_at <= now())`,
      ),
    )
    .returning();
  const expiredApprovals = approvalsDue.map((r) => r.approvalId).filter((x): x is string => !!x);
  if (expiredApprovals.length) {
    await t.update(approvals).set({ status: "superseded" }).where(and(inArray(approvals.id, expiredApprovals), inArray(approvals.status, ["pending", "approved"])));
  }
  for (const r of [...signIns, ...approvalsDue]) {
    await audit(t, r.requestedBy, null, "vendor-control-delegated-expired", "deny", `a delegated vendor control sign-in expired (${r.outcomeCode}); anything it held was destroyed and nothing was stored (ADR-0338)`, { sourceId: r.sourceId, requestId: r.id, outcomeCode: r.outcomeCode });
  }
  return signIns.length + approvalsDue.length;
}

export const VENDOR_CONTROL_DELEGATED_EXPIRY_JOB_NAME = "vendor-control-delegated-expiry-sweep";
const SWEEP_BATCH = 500;

/**
 * The scheduled sweep (review of #1251 [2]): expires open requests whose sign-in window or approval has passed, at most
 * 500 per pass, oldest first, destroying the verifier or the held refresh token. Nothing depends on it having run:
 * every read, the callback and the decision expire a due request first; the sweep is what keeps a held token from
 * waiting for someone to look.
 */
export async function runDelegatedExpirySweep(db: Db): Promise<{ expired: number }> {
  const expired = await db.transaction((tx) =>
    touchDueDelegated(
      tx as unknown as Db,
      sql`${vendorControlDelegatedRequests.id} IN (SELECT q.id FROM ${vendorControlDelegatedRequests} q WHERE q.status IN ('awaiting_sign_in', 'awaiting_approval') ORDER BY q.requested_at LIMIT ${SWEEP_BATCH})`,
    ),
  );
  return { expired };
}

export function vendorControlDelegatedJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: VENDOR_CONTROL_DELEGATED_EXPIRY_JOB_NAME,
      description:
        "Expire delegated vendor control sign-ins whose 10-minute window or whose approval has passed (up to 500 per " +
        "pass, oldest first), destroying the held PKCE verifier or refresh token, superseding the approval and auditing " +
        "each. Nothing depends on it: a due request is expired whenever it is read or decided.",
      adr: "ADR-0338",
      defaultIntervalSeconds: 300,
      run: async (ctx) => {
        const out = await runDelegatedExpirySweep(ctx.db);
        return { itemsProcessed: out.expired, detail: { ...out } };
      },
    },
  ];
}

/** the credential module's helpers, passed in so the two modules do not import each other */
export interface DelegatedRouteDeps extends DelegatedDeps {
  controls: Readonly<Record<string, VendorAgentControl>>;
  controlForKind: (controls: Readonly<Record<string, VendorAgentControl>>, kind: DiscoverySourceKind) => VendorAgentControl | null;
  liveControlCredentialRow: (db: Db, sourceId: string) => Promise<{ cred: DiscoveryCredentialRow } | undefined>;
}

/** building the authorization URL makes no network call; a fetch that refuses proves it */
const noNetwork = (async () => {
  throw new Error("no network call is made while building the authorization URL");
}) as unknown as typeof fetch;

const optInOn = async (t: Db) => {
  const [s] = await t.select({ on: discoverySettings.vendorAgentControlDelegatedEnabled }).from(discoverySettings).limit(1);
  return s?.on === true;
};

export function registerDelegatedControlCredentialRoutes(app: FastifyInstance, db: Db, deps: DelegatedRouteDeps): void {
  const send = (reply: FastifyReply, r: Refusal) => reply.status(r.status).send(r.body);
  const badRequest = (reply: FastifyReply, err: z.ZodError) =>
    reply.status(400).send({ error: "invalid_request", detail: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
  const personOf = (req: FastifyRequest) => req.authCtx.userId ?? null;
  const PERSON = refusal(403, "person_required", "a delegated control credential is connected by a signed-in administrator");

  app.post("/v1/discovery/sources/:sourceId/control-credential/delegated", async (req, reply) => {
    const p = sourceParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const parsed = delegatedStartSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    const b = parsed.data;
    const userId = personOf(req);
    if (!userId) return send(reply, PERSON);
    if (!deps.dataKey) return send(reply, refusal(503, "data_key_unavailable", "the data key is not configured, so a refresh token cannot be held encrypted"));
    const tenantId = b.tenantId.toLowerCase();
    const clientId = b.clientId.toLowerCase();
    const approverUserId = b.approverUserId.toLowerCase();
    const accountObjectId = b.accountObjectId.toLowerCase();
    if (!GUID.test(tenantId) || !GUID.test(clientId) || !GUID.test(accountObjectId)) {
      return send(reply, refusal(400, "invalid_request", "tenantId, clientId and accountObjectId must be GUIDs"));
    }
    const out = await db.transaction(async (tx): Promise<Refusal | { url: string; row: VendorControlDelegatedRequestRow }> => {
      const t = tx as unknown as Db;
      const [s] = await t.select().from(discoverySources).where(eq(discoverySources.id, p.data.sourceId)).for("update");
      if (!s) return refusal(404, "not_found", "no such discovery source");
      await touchDueDelegated(t, eq(vendorControlDelegatedRequests.sourceId, s.id));
      if (!(await optInOn(t))) {
        return refusal(409, "credential_mode_disabled", "delegated control credentials are turned off in the discovery settings (turning them on is a step-up)");
      }
      const control = deps.controlForKind(deps.controls, s.kind);
      if (!control) return refusal(409, "control_not_offered", `a ${s.kind} source's registry offers no vendor control`);
      if (!control.acceptedModes.includes("delegated") || !control.token.delegatedScope) {
        return refusal(409, "credential_mode_not_accepted", "this vendor does not accept a delegated control credential");
      }
      if (String(s.target.tenantId ?? "").toLowerCase() !== tenantId) {
        return refusal(400, "credential_target_mismatch", "the control credential names a different tenant than the source's target");
      }
      const [read] = await t
        .select({ publicConfig: discoveryCredentials.publicConfig })
        .from(discoveryCredentials)
        .where(and(eq(discoveryCredentials.sourceId, s.id), eq(discoveryCredentials.purpose, "discovery_read"), isNull(discoveryCredentials.revokedAt)));
      if (read && String(read.publicConfig.clientId ?? "").toLowerCase() === clientId) {
        return refusal(400, "write_app_is_read_app", "the control credential must be a separate app from the source's read-only discovery app");
      }
      const live = await deps.liveControlCredentialRow(t, s.id);
      if ((live?.cred.id ?? null) !== (b.replacesCredentialId?.toLowerCase() ?? null)) {
        return refusal(409, "credential_conflict", live ? `this source already has a control credential (${live.cred.id}); name it in replacesCredentialId to replace it` : "this source has no control credential; replacesCredentialId must be null");
      }
      const [open] = await t
        .select({ id: vendorControlDelegatedRequests.id })
        .from(vendorControlDelegatedRequests)
        .where(and(eq(vendorControlDelegatedRequests.sourceId, s.id), inArray(vendorControlDelegatedRequests.status, ["awaiting_sign_in", "awaiting_approval"])));
      if (open) return refusal(409, "delegated_request_open", `this source already has an open delegated sign-in (${open.id}); finish or cancel it first`, { requestId: open.id });
      // four eyes: a second, active administrator in the approval pool, never the requester (nor anyone delegation-linked)
      if (approverUserId === userId) return refusal(422, "approver_is_requester", "a delegated control credential is approved by a second administrator, not the person who connects it");
      const [approver] = await t.select({ id: users.id }).from(users).where(and(eq(users.id, approverUserId), eq(users.isAdmin, true), isNull(users.disabledAt)));
      const pool = approver ? await loadApprovalPool(t, { namedApproverUserId: approverUserId, approverRoleId: null, callerUserId: userId }) : null;
      if (!pool || !pool.members.includes(approverUserId)) {
        return refusal(422, "approver_not_eligible", "the approver must be another active administrator who is not linked to you by a delegation");
      }
      const su = await checkStepUp(t, req, delegatedStepUp(s.id, b), { spend: true });
      if (!su.ok) {
        if (!isStepUpPrompt(su.body)) {
          await audit(t, userId, null, "vendor-control-delegated-step-up-refused", "deny", `starting a delegated vendor control sign-in was refused: ${String(su.body.error)} (ADR-0338)`, { sourceId: s.id, error: su.body.error });
        }
        return { status: su.status, body: su.body };
      }
      const pkce = await new CryptoProvider().generatePkceCodes();
      const state = b64url(32);
      const nonce = b64url(32);
      const redirectUri = `${deploymentBaseUrl(req)}${DELEGATED_CALLBACK_PATH}`;
      const [row] = await t
        .insert(vendorControlDelegatedRequests)
        .values({
          sourceId: s.id,
          requestedBy: userId,
          approverUserId,
          state,
          nonce,
          codeVerifierCiphertext: encryptSecret(deps.dataKey!, pkce.verifier),
          tenantId,
          clientId,
          accountUpn: b.account.toLowerCase(),
          accountObjectId,
          expiresInDays: b.expiresInDays,
          replacesCredentialId: live?.cred.id ?? null,
          redirectUri,
          // the database's clock for both ends of the window (the CHECK compares them)
          signInExpiresAt: sql`now() + make_interval(secs => ${DELEGATED_REQUEST_TTL_MS / 1000})`,
        })
        .returning();
      // the URL is built locally from static metadata: no network call, nothing secret in it (the challenge only)
      const url = await msalClient(noNetwork, tenantId, clientId, async () => "unused").getAuthCodeUrl({
        scopes: [control.token.delegatedScope],
        redirectUri,
        codeChallenge: pkce.challenge,
        codeChallengeMethod: "S256",
        state,
        nonce,
        loginHint: b.account.toLowerCase(),
        prompt: "login",
        responseMode: "query",
      });
      await audit(t, userId, null, "vendor-control-delegated-requested", "allow", `a delegated vendor control sign-in was started for '${b.account.toLowerCase()}' on discovery source '${s.name}', to be approved by a second administrator (a relaxation, confirmed with a step-up ${su.method}) (ADR-0338)`, {
        sourceId: s.id,
        kind: s.kind,
        requestId: row!.id,
        tenantId,
        clientId,
        accountUpn: b.account.toLowerCase(),
        accountObjectId,
        expiresInDays: b.expiresInDays,
        replacesCredentialId: live?.cred.id ?? null,
        approverUserId,
        stepUp: su.method,
      });
      return { url, row: row! };
    });
    if (isRefusal(out)) return send(reply, out);
    // this sign-in completes only in this browser (ADR-0167's binding; Lax so Entra's top-level redirect carries it)
    void reply.header(
      "set-cookie",
      ssoBindingCookie(DELEGATED_BINDING_COOKIE, delegatedBrowserBinding(deps.dataKey, out.row.state), { path: DELEGATED_CALLBACK_PATH, secure: requestIsSecure(req), crossSite: false }),
    );
    return reply.status(201).send({ authorizationUrl: out.url, request: delegatedView(out.row) });
  });

  // auth-exempt (route-classes.ts): bound to the browser that started it instead of to a session; see above
  app.get(DELEGATED_CALLBACK_PATH, async (req, reply) => {
    const q = callbackQuery.safeParse(req.query);
    if (!q.success) return badRequest(reply, q.error);
    // the request's own tables admit an admin or `system_task`; the work is the requester's, audited as them
    return runWithRlsSystem("system_task", "vendor-control-delegated.callback", () => completeSignIn(req, reply, q.data));
  });

  async function completeSignIn(req: FastifyRequest, reply: FastifyReply, query: z.infer<typeof callbackQuery>) {
    const binding = delegatedBrowserBinding(deps.dataKey, query.state);
    const clearBinding = () =>
      void reply.header("set-cookie", `${DELEGATED_BINDING_COOKIE}=; Path=${DELEGATED_CALLBACK_PATH}; HttpOnly; SameSite=Lax; Max-Age=0${requestIsSecure(req) ? "; Secure" : ""}`);
    /** sign_in_fail, through the machine; a request another callback already moved changes nothing */
    const failSignIn = (t: Db, r: VendorControlDelegatedRequestRow, outcomeCode: string, reason: string, extra: Record<string, unknown> = {}) =>
      t
        .update(vendorControlDelegatedRequests)
        .set({ status: VENDOR_CONTROL_DELEGATED_MACHINE.next("awaiting_sign_in", "sign_in_fail"), codeVerifierCiphertext: null, outcomeCode, updatedAt: sql`now()` })
        .where(and(eq(vendorControlDelegatedRequests.id, r.id), whereFrom(vendorControlDelegatedRequests.status, VENDOR_CONTROL_DELEGATED_MACHINE, "sign_in_fail")))
        .returning()
        .then(async (moved) => {
          if (moved.length) await audit(t, r.requestedBy, null, `vendor-control-delegated-${outcomeCode.replace(/_/g, "-")}`, "deny", `${reason}; nothing was stored (ADR-0338)`, { sourceId: r.sourceId, requestId: r.id, accountObjectId: r.accountObjectId, outcomeCode, ...extra });
          return moved.length > 0;
        });
    // 1. read the request (the expiries first) and check the browser binding; a declined sign-in fails it at once
    const first = await db.transaction(async (tx): Promise<Refusal | { r: VendorControlDelegatedRequestRow; verifier: string }> => {
      const t = tx as unknown as Db;
      await touchDueDelegated(t, eq(vendorControlDelegatedRequests.state, query.state));
      const [r] = await t.select().from(vendorControlDelegatedRequests).where(eq(vendorControlDelegatedRequests.state, query.state)).for("update");
      if (!r) return refusal(404, "delegated_request_not_found", "no such delegated sign-in");
      if (!ssoBindingMatches(readCookie(req.headers.cookie, DELEGATED_BINDING_COOKIE), binding)) {
        // refused before any vendor call; the request stays open for the browser that started it
        await audit(t, r.requestedBy, null, "vendor-control-delegated-browser-mismatch", "deny", "a delegated vendor control sign-in was completed in a different browser than the one that started it; it was refused (ADR-0338, ADR-0167)", { sourceId: r.sourceId, requestId: r.id });
        return refusal(403, "delegated_request_not_bound_to_this_browser", "this sign-in was started in a different browser; start it again from there");
      }
      if (r.status === "expired") return refusal(409, "delegated_request_expired", "this delegated sign-in expired; start a new one", { lifecycle: VENDOR_CONTROL_DELEGATED_MACHINE.describe(r.status) });
      if (!VENDOR_CONTROL_DELEGATED_MACHINE.can(r.status, "sign_in")) {
        return refusal(409, "delegated_request_used", "this delegated sign-in was already completed or abandoned; start a new one", { lifecycle: VENDOR_CONTROL_DELEGATED_MACHINE.describe(r.status) });
      }
      if (query.error || !query.code) {
        await failSignIn(t, r, "sign_in_declined", "the vendor's sign-in returned no authorization code", { vendorError: query.error?.slice(0, 64) ?? null });
        return refusal(400, "delegated_sign_in_failed", "the vendor's sign-in returned no authorization code");
      }
      if (!deps.dataKey || !r.codeVerifierCiphertext) return refusal(503, "data_key_unavailable", "the data key is not configured");
      return { r, verifier: decryptSecret(deps.dataKey, r.codeVerifierCiphertext) };
    });
    if (isRefusal(first)) return send(reply, first);
    clearBinding();
    const r = first.r;
    const [s] = await db.select().from(discoverySources).where(eq(discoverySources.id, r.sourceId));
    const control = s ? deps.controlForKind(deps.controls, s.kind) : null;
    const scope = control?.token.delegatedScope;
    const failNow = async (outcomeCode: string, reason: string, out: Refusal, extra: Record<string, unknown> = {}) => {
      await db.transaction((tx) => failSignIn(tx as unknown as Db, r, outcomeCode, reason, extra));
      return send(reply, out);
    };
    if (!s || !control || !scope) return failNow("control_not_offered", "the source's registry no longer offers a delegated control", refusal(409, "control_not_offered", "the source's registry no longer offers a delegated control"));

    // 2. redeem the code with the verifier and nonce, outside any transaction (the vendor call)
    const assertion = (deps.federationToken ?? defaultFederationToken(deps.dataKey))(db, s.id);
    const client = msalClient(await deps.fetch(), r.tenantId, r.clientId, assertion);
    let result: AuthenticationResult;
    try {
      result = await client.acquireTokenByCode({ code: query.code!, redirectUri: r.redirectUri, scopes: [scope], codeVerifier: first.verifier, nonce: r.nonce, state: r.state }, { code: query.code!, state: r.state, nonce: r.nonce });
    } catch (err) {
      const aad = aadCode(err);
      return failNow("control_token_failed", `the delegated vendor control code redemption failed${aad ? ` (${aad})` : ""}`, refusal(502, "control_token_failed", `the Entra code redemption failed${aad ? ` (${aad})` : ""}`), { aad: aad ?? null });
    }
    // the library's iss/aud/exp/nonce checks and the granted scope, then the immutable account
    let claims: Record<string, unknown>;
    try {
      claims = await validatedTokenResponse(result, { tenantId: r.tenantId, clientId: r.clientId, scope, nonce: r.nonce });
    } catch (err) {
      const e = err instanceof DelegatedTokenError ? err : new DelegatedTokenError("delegated_id_token_invalid", "the ID token failed validation");
      return failNow(e.code, `the delegated sign-in's token response was refused: ${e.message}`, refusal(403, e.code, e.message));
    }
    const who = accountOf(claims, r.tenantId);
    if (!who || who.tenantId !== r.tenantId || who.objectId !== r.accountObjectId) {
      return failNow("delegated_account_mismatch", "the delegated sign-in came back as a different account or tenant than the step-up was bound to, or as a guest", refusal(403, "delegated_account_mismatch", "the sign-in must be the named member account (its object id), in the source's tenant"), { returnedTenant: who?.tenantId ?? null });
    }
    const refreshToken = await refreshTokenOf(client);
    if (!refreshToken) {
      return failNow("delegated_no_refresh_token", "the delegated sign-in returned no refresh token", refusal(502, "delegated_no_refresh_token", "Entra returned no refresh token (offline access was not granted)"));
    }

    // 3. hold the token and queue the second administrator's approval, in one transaction
    const out = await db.transaction(async (tx): Promise<Refusal | { row: VendorControlDelegatedRequestRow }> => {
      const t = tx as unknown as Db;
      const [settings] = await t.select({ ttl: discoverySettings.vendorAgentControlApprovalTtlHours }).from(discoverySettings).limit(1);
      const facts = factsOf(r);
      const [approval] = await t
        .insert(approvals)
        .values({
          userId: r.requestedBy,
          objectType: "vendor_control_delegated",
          approverUserId: r.approverUserId,
          stageId: `${VENDOR_CONTROL_DELEGATED_APPROVAL_PREFIX}${r.id}`,
          argumentsDigest: delegatedArgumentsDigest(facts),
          argumentsPreview: approvalArgumentsPreview({ ...facts }),
          argumentsPreviewKind: "arguments_v1",
          expiresAt: sql`now() + make_interval(hours => ${settings?.ttl ?? DEFAULT_APPROVAL_TTL_HOURS})`,
        })
        .returning({ id: approvals.id, expiresAt: approvals.expiresAt });
      const [moved] = await t
        .update(vendorControlDelegatedRequests)
        .set({
          status: VENDOR_CONTROL_DELEGATED_MACHINE.next("awaiting_sign_in", "sign_in"),
          codeVerifierCiphertext: null,
          refreshTokenCiphertext: encryptSecret(deps.dataKey!, refreshToken),
          approvalId: approval!.id,
          updatedAt: sql`now()`,
        })
        .where(and(eq(vendorControlDelegatedRequests.id, r.id), whereFrom(vendorControlDelegatedRequests.status, VENDOR_CONTROL_DELEGATED_MACHINE, "sign_in")))
        .returning();
      if (!moved) {
        // another callback or a cancel moved it first: the approval written above rolls back with this transaction
        throw new DelegatedMovedError();
      }
      await audit(t, r.requestedBy, null, "vendor-control-delegated-signed-in", "require_approval", `the named account (${who.objectId}) signed in for a delegated vendor control credential on discovery source '${s.name}'; its refresh token is held encrypted until the second administrator approves (ADR-0338)`, {
        sourceId: s.id,
        requestId: r.id,
        accountObjectId: who.objectId,
        accountUpn: r.accountUpn,
        returnedUpn: who.upn,
        approvalId: approval!.id,
        approverUserId: r.approverUserId,
        expiresAt: approval!.expiresAt?.toISOString() ?? null,
      });
      return { row: moved };
    }).catch((err: unknown) => {
      if (err instanceof DelegatedMovedError) return refusal(409, "delegated_request_used", "this delegated sign-in was already completed or abandoned; start a new one");
      throw err;
    });
    if (isRefusal(out)) return send(reply, out);
    return reply.status(202).send({ request: delegatedView(out.row) });
  }

  app.get("/v1/discovery/control-credential/delegated/:requestId", async (req, reply) => {
    const p = requestParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const row = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      await touchDueDelegated(t, eq(vendorControlDelegatedRequests.id, p.data.requestId));
      const [r] = await t.select().from(vendorControlDelegatedRequests).where(eq(vendorControlDelegatedRequests.id, p.data.requestId));
      return r;
    });
    if (!row) return send(reply, refusal(404, "not_found", "no such delegated sign-in"));
    return reply.send({ request: delegatedView(row) });
  });

  app.post("/v1/discovery/control-credential/delegated/:requestId/cancel", async (req, reply) => {
    const p = requestParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const userId = personOf(req);
    if (!userId) return send(reply, PERSON);
    // withdrawing narrows, so it needs no step-up; the move, the approval's supersession and the audit commit together
    const out = await db.transaction(async (tx): Promise<Refusal | { row: VendorControlDelegatedRequestRow }> => {
      const t = tx as unknown as Db;
      await touchDueDelegated(t, eq(vendorControlDelegatedRequests.id, p.data.requestId));
      const [r] = await t.select().from(vendorControlDelegatedRequests).where(eq(vendorControlDelegatedRequests.id, p.data.requestId)).for("update");
      if (!r) return refusal(404, "not_found", "no such delegated sign-in");
      if (!VENDOR_CONTROL_DELEGATED_MACHINE.can(r.status, "cancel")) {
        return refusal(409, "delegated_request_not_open", `a delegated sign-in that is ${r.status} cannot be cancelled`, { lifecycle: VENDOR_CONTROL_DELEGATED_MACHINE.describe(r.status) });
      }
      const [moved] = await t
        .update(vendorControlDelegatedRequests)
        .set({ status: VENDOR_CONTROL_DELEGATED_MACHINE.next(r.status, "cancel"), codeVerifierCiphertext: null, refreshTokenCiphertext: null, outcomeCode: "cancelled", updatedAt: sql`now()` })
        .where(and(eq(vendorControlDelegatedRequests.id, r.id), whereFrom(vendorControlDelegatedRequests.status, VENDOR_CONTROL_DELEGATED_MACHINE, "cancel")))
        .returning();
      if (!moved) return refusal(409, "delegated_request_not_open", "the delegated sign-in moved before it could be cancelled");
      if (r.approvalId) await t.update(approvals).set({ status: "superseded" }).where(and(eq(approvals.id, r.approvalId), inArray(approvals.status, ["pending", "approved"])));
      await audit(t, userId, null, "vendor-control-delegated-cancelled", "allow", `a delegated vendor control sign-in was withdrawn; anything it held was destroyed (ADR-0338)`, { sourceId: r.sourceId, requestId: r.id, from: r.status });
      return { row: moved };
    });
    if (isRefusal(out)) return send(reply, out);
    return reply.send({ request: delegatedView(out.row) });
  });
}

class DelegatedMovedError extends Error {}

// ---------------------------------------------------------------------------
// The second administrator's decision (the one decide path, app.ts)
// ---------------------------------------------------------------------------

type DecideRefusal = { status: number; body: Record<string, unknown> };
type ApprovalLike = { id: string; userId: string; approverUserId: string | null; approverRoleId: string | null; argumentsDigest: string | null };

/**
 * Before anything is written: the decider is not the requester (by any route), is an active admin in the approval's
 * pool, and holds an `approval_decide` step-up bound to {approvalId, decision, argumentsDigest}. Only the HTTP decide
 * route carries the request a step-up needs, so bulk and ChatOps decisions of this kind are refused.
 */
export async function precheckVendorControlDelegatedDecision(
  db: Db,
  approval: ApprovalLike,
  deciderUserId: string,
  decision: "approved" | "denied",
  req: FastifyRequest | undefined,
): Promise<DecideRefusal | null> {
  // the approval's own window first (review of #1251 [2]): a request past it is expired, its token destroyed
  await db.transaction((tx) => touchDueDelegated(tx as unknown as Db, eq(vendorControlDelegatedRequests.approvalId, approval.id)));
  const [r] = await db.select().from(vendorControlDelegatedRequests).where(eq(vendorControlDelegatedRequests.approvalId, approval.id));
  if (!r) return { status: 409, body: { error: "delegated_request_missing", detail: "this approval names no delegated sign-in" } };
  if (r.status === "expired") return { status: 409, body: { error: "approval_expired", detail: "this approval's window passed; the held token was destroyed. Start a new sign-in" } };
  if (r.status !== "awaiting_approval") return { status: 409, body: { error: "delegated_request_not_open", detail: `this delegated sign-in is ${r.status}`, lifecycle: VENDOR_CONTROL_DELEGATED_MACHINE.describe(r.status) } };
  if (r.requestedBy === deciderUserId || approval.userId === deciderUserId) {
    return { status: 403, body: { error: "cannot_approve_own_delegated_credential", detail: "the decider connected this credential; another administrator must decide it" } };
  }
  const [decider] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, deciderUserId), eq(users.isAdmin, true), isNull(users.disabledAt)));
  const pool = await loadApprovalPool(db, { namedApproverUserId: approval.approverUserId, approverRoleId: approval.approverRoleId, callerUserId: approval.userId, asOf: requestedAtOf(approval.id) });
  if (!decider || !pool.members.includes(deciderUserId)) {
    return { status: 403, body: { error: "not_an_eligible_approver", detail: "a delegated control credential is decided by the administrator it names (or their delegate), never by an override" } };
  }
  if (!req) return { status: 403, body: { error: "step_up_required", actionKind: "approval_decide", methods: [], detail: "decide a delegated control credential from the approval itself, confirming it is you" } };
  if (!approval.argumentsDigest) return { status: 409, body: { error: "approval_unbound", detail: "this approval carries no arguments digest" } };
  const su = await checkStepUp(db, req, delegatedDecideStepUp(approval.id, decision, approval.argumentsDigest), { spend: false });
  if (!su.ok) return { status: su.status, body: su.body };
  return null;
}

/** the approvals queue's label for each delegated credential approval */
export async function vendorControlDelegatedApprovalLabels(db: Db, stageIds: readonly (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(stageIds.filter((s): s is string => !!s?.startsWith(VENDOR_CONTROL_DELEGATED_APPROVAL_PREFIX)).map((s) => s.slice(VENDOR_CONTROL_DELEGATED_APPROVAL_PREFIX.length)))];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: vendorControlDelegatedRequests.id, upn: vendorControlDelegatedRequests.accountUpn, oid: vendorControlDelegatedRequests.accountObjectId, days: vendorControlDelegatedRequests.expiresInDays, source: discoverySources.name })
    .from(vendorControlDelegatedRequests)
    .innerJoin(discoverySources, eq(discoverySources.id, vendorControlDelegatedRequests.sourceId))
    .where(inArray(vendorControlDelegatedRequests.id, ids));
  for (const r of rows) out.set(`${VENDOR_CONTROL_DELEGATED_APPROVAL_PREFIX}${r.id}`, `connect '${r.upn}' (object id ${r.oid}) as the delegated vendor control credential of '${r.source}' for ${r.days} days`);
  return out;
}

/** the decision's own failure inside its transaction: the whole decision rolls back */
export class VendorControlDelegatedDecideError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VendorControlDelegatedDecideError";
  }
}

/**
 * Inside the decision's transaction; the approver's grant is spent here, with the writes. Approved: the opt-in and the
 * replaced row are re-checked, the old row is revoked with its secret destroyed, the `delegated` row is stored with
 * the held ciphertext moved into it, and the request moves `awaiting_approval → connected`. Denied: the held token is
 * destroyed and the request moves to `denied`; nothing is stored.
 */
export async function applyVendorControlDelegatedDecision(tx: Db, approval: ApprovalLike, decision: "approved" | "denied", deciderUserId: string, req: FastifyRequest | undefined): Promise<void> {
  const [r] = await tx.select().from(vendorControlDelegatedRequests).where(eq(vendorControlDelegatedRequests.approvalId, approval.id)).for("update");
  if (!r || r.status !== "awaiting_approval") return;
  // decided only inside the approval's window, by the database clock (the precheck expired a due one already)
  const [window] = await tx.select({ open: sql<boolean>`${approvals.expiresAt} IS NOT NULL AND ${approvals.expiresAt} > now()` }).from(approvals).where(eq(approvals.id, approval.id));
  if (!window?.open) throw new VendorControlDelegatedDecideError(409, "approval_expired", "this approval's window passed; start a new sign-in");
  if (!req || !approval.argumentsDigest) throw new VendorControlDelegatedDecideError(403, "step_up_required", "a delegated control credential needs the approver's step-up");
  const su = await checkStepUp(tx, req, delegatedDecideStepUp(approval.id, decision, approval.argumentsDigest), { spend: true });
  if (!su.ok) throw new VendorControlDelegatedDecideError(su.status, String(su.body.error ?? "step_up_required"), "the approver's step-up was not accepted");
  if (decision === "denied") {
    const [moved] = await tx
      .update(vendorControlDelegatedRequests)
      .set({ status: VENDOR_CONTROL_DELEGATED_MACHINE.next(r.status, "deny"), refreshTokenCiphertext: null, outcomeCode: "denied_by_approver", updatedAt: sql`now()` })
      .where(and(eq(vendorControlDelegatedRequests.id, r.id), whereFrom(vendorControlDelegatedRequests.status, VENDOR_CONTROL_DELEGATED_MACHINE, "deny")))
      .returning();
    if (moved) await audit(tx, deciderUserId, null, "vendor-control-delegated-denied", "deny", `the delegated vendor control credential for '${r.accountUpn}' was denied by the approver; its held refresh token was destroyed (step-up ${su.method}) (ADR-0338)`, { sourceId: r.sourceId, requestId: r.id, approvalId: approval.id, requestedBy: r.requestedBy, stepUp: su.method });
    return;
  }
  if (!r.accountObjectId || !r.refreshTokenCiphertext) throw new VendorControlDelegatedDecideError(409, "delegated_request_incomplete", "the delegated sign-in holds no token");
  if (!(await optInOn(tx))) throw new VendorControlDelegatedDecideError(409, "credential_mode_disabled", "delegated control credentials were turned off while the approval was open; deny it or turn the opt-in back on");
  const [src] = await tx.select().from(discoverySources).where(eq(discoverySources.id, r.sourceId)).for("update");
  if (!src) throw new VendorControlDelegatedDecideError(404, "not_found", "the discovery source is gone");
  const [live] = await tx
    .select()
    .from(discoveryCredentials)
    .where(and(eq(discoveryCredentials.sourceId, src.id), eq(discoveryCredentials.purpose, "platform_write"), isNull(discoveryCredentials.revokedAt)))
    .for("update");
  if ((live?.id ?? null) !== (r.replacesCredentialId ?? null)) {
    throw new VendorControlDelegatedDecideError(409, "credential_changed", "the source's control credential changed while the approval was open; deny this one and start a new sign-in");
  }
  if (live) {
    await tx.update(discoveryCredentials).set({ revokedAt: sql`now()`, revokedBy: deciderUserId, secretCiphertext: null }).where(eq(discoveryCredentials.id, live.id));
  }
  const [cred] = await tx
    .insert(discoveryCredentials)
    .values({
      sourceId: src.id,
      purpose: "platform_write",
      credentialMode: "delegated",
      publicConfig: { tenantId: r.tenantId, clientId: r.clientId, accountObjectId: r.accountObjectId, accountUpn: r.accountUpn },
      // the held envelope moves as it is (the same data key); the request's copy is destroyed by the move below
      secretCiphertext: r.refreshTokenCiphertext,
      expiresAt: sql`now() + make_interval(days => ${r.expiresInDays})`,
      createdBy: r.requestedBy,
    })
    .returning();
  const [moved] = await tx
    .update(vendorControlDelegatedRequests)
    .set({ status: VENDOR_CONTROL_DELEGATED_MACHINE.next(r.status, "approve"), refreshTokenCiphertext: null, credentialId: cred!.id, outcomeCode: "connected", updatedAt: sql`now()` })
    .where(and(eq(vendorControlDelegatedRequests.id, r.id), whereFrom(vendorControlDelegatedRequests.status, VENDOR_CONTROL_DELEGATED_MACHINE, "approve")))
    .returning();
  if (!moved) throw new VendorControlDelegatedDecideError(409, "delegated_request_moved", "the delegated sign-in moved before it could be approved");
  await audit(tx, deciderUserId, cred!.id, live ? "vendor-control-credential-replaced" : "vendor-control-credential-stored", "allow", `a delegated vendor control credential for '${r.accountUpn}' was connected for discovery source '${src.name}', approved by a second administrator (step-up ${su.method}); it expires in ${r.expiresInDays} days (ADR-0338)`, {
    sourceId: src.id,
    kind: src.kind,
    requestId: r.id,
    approvalId: approval.id,
    requestedBy: r.requestedBy,
    approvedBy: deciderUserId,
    tenantId: r.tenantId,
    clientId: r.clientId,
    accountObjectId: r.accountObjectId,
    accountUpn: r.accountUpn,
    expiresInDays: r.expiresInDays,
    replacedCredentialId: live?.id ?? null,
    stepUp: su.method,
  });
}
