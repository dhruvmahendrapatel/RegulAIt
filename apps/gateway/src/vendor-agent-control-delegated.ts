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
 * Routes (admin-only, API-only: KNOWN_UI_GAPS against #453):
 *   POST /v1/discovery/sources/:sourceId/control-credential/delegated   start a sign-in (`settings_relax` step-up)
 *   GET  /v1/discovery/control-credential/delegated/callback            the vendor's redirect: stores the credential
 *
 * The state, nonce and PKCE verifier stay server side (`vendor_control_delegated_requests`, the verifier encrypted),
 * so an intercepted redirect cannot be redeemed. A request lives 10 minutes, is spent once whatever the outcome, and
 * only the admin who started it can complete it. The ID token is taken from the token endpoint's own TLS response
 * (OIDC Core §3.1.3.7), and its tenant, account and nonce must match what the step-up was bound to.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ConfidentialClientApplication, CryptoProvider, LogLevel, type AuthenticationResult, type INetworkModule, type NetworkRequestOptions, type NetworkResponse } from "@azure/msal-node";
import { and, auditLog, discoveryCredentials, discoverySettings, discoverySources, eq, isNull, sql, vendorControlDelegatedRequests, type Db, type DiscoveryCredentialRow } from "@regulait/db";
import { FEDERATION_AUDIENCES, vendorAgentControlSubject, type DiscoverySourceKind } from "@regulait/shared";
import { allowListedFetch } from "./agent-platform-endpoints.js";
import { errMessage } from "./err-serializer.js";
import { federationTokenMinter } from "./federation-signing-keys.js";
import { deploymentBaseUrl } from "./public-url.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { checkStepUp, isStepUpPrompt, type StepUpCheckArgs } from "./step-up.js";
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

/** the account a token is for, from the token endpoint's own ID token */
function accountOf(result: AuthenticationResult): { tenantId: string; objectId: string; upn: string } | null {
  const c = (result.idTokenClaims ?? {}) as Record<string, unknown>;
  const tid = typeof c.tid === "string" ? c.tid.toLowerCase() : "";
  const oid = typeof c.oid === "string" ? c.oid.toLowerCase() : "";
  const upn = typeof c.preferred_username === "string" ? c.preferred_username.toLowerCase() : typeof c.upn === "string" ? c.upn.toLowerCase() : "";
  return GUID.test(tid) && GUID.test(oid) && upn ? { tenantId: tid, objectId: oid, upn } : null;
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
  const who = accountOf(result);
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
// Routes
// ---------------------------------------------------------------------------

const sourceParam = z.object({ sourceId: z.string().uuid() });
export const delegatedStartSchema = z
  .object({
    /** the source's tenant and the write app (identifiers only) */
    tenantId: z.string().regex(/^[0-9a-fA-F-]{36}$/),
    clientId: z.string().regex(/^[0-9a-fA-F-]{36}$/),
    /** the named admin account that signs in (its UPN); the sign-in must come back as this account */
    account: z.string().min(3).max(320).regex(/^[^\s@]+@[^\s@]+$/),
    expiresInDays: z.number().int().min(1).max(DELEGATED_MAX_DAYS).default(DELEGATED_DEFAULT_DAYS),
    replacesCredentialId: z.string().uuid().nullable(),
  })
  .strict();
export type DelegatedStartBody = z.infer<typeof delegatedStartSchema>;

/** the start step-up: bound to the source, the account, the tenant, the app, the expiry and the row it replaces */
export const delegatedStepUp = (sourceId: string, b: DelegatedStartBody): StepUpCheckArgs => ({
  kind: "settings_relax",
  facts: {
    op: "vendor_control_delegated",
    sourceId: sourceId.toLowerCase(),
    account: b.account.toLowerCase(),
    tenantId: b.tenantId.toLowerCase(),
    clientId: b.clientId.toLowerCase(),
    expiresInDays: b.expiresInDays,
    replacesCredentialId: b.replacesCredentialId?.toLowerCase() ?? null,
  },
});

const callbackQuery = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code: z.string().min(1).max(8192).optional(),
  error: z.string().max(256).optional(),
});

type Refusal = { status: number; body: Record<string, unknown> };
const refusal = (status: number, error: string, detail: string): Refusal => ({ status, body: { error, detail } });
const isRefusal = (x: unknown): x is Refusal => typeof x === "object" && x !== null && "status" in x && "body" in x;

const audit = (t: Db, userId: string, objectId: string | null, ruleId: string, effect: "allow" | "deny", reason: string, detail: Record<string, unknown>) =>
  t.insert(auditLog).values({ userId, objectType: "discovery_credential", objectId, detail: { subsystem: "vendor-agent-control", adr: "0338", purpose: "platform_write", mode: "delegated", ...detail }, effect, ruleId, ruleChain: [], reason });

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

export function registerDelegatedControlCredentialRoutes(app: FastifyInstance, db: Db, deps: DelegatedRouteDeps): void {
  const send = (reply: FastifyReply, r: Refusal) => reply.status(r.status).send(r.body);
  const badRequest = (reply: FastifyReply, err: z.ZodError) =>
    reply.status(400).send({ error: "invalid_request", detail: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
  const personOf = (req: FastifyRequest) => req.authCtx.userId ?? null;
  const PERSON = refusal(403, "person_required", "a delegated control credential is connected by a signed-in administrator");
  const optInOn = async (t: Db) => {
    const [s] = await t.select({ on: discoverySettings.vendorAgentControlDelegatedEnabled }).from(discoverySettings).limit(1);
    return s?.on === true;
  };

  app.post("/v1/discovery/sources/:sourceId/control-credential/delegated", async (req, reply) => {
    const p = sourceParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const parsed = delegatedStartSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    const b = parsed.data;
    const userId = personOf(req);
    if (!userId) return send(reply, PERSON);
    if (!deps.dataKey) return send(reply, refusal(503, "data_key_unavailable", "the data key is not configured, so a refresh token cannot be stored encrypted"));
    const tenantId = b.tenantId.toLowerCase();
    const clientId = b.clientId.toLowerCase();
    if (!GUID.test(tenantId) || !GUID.test(clientId)) return send(reply, refusal(400, "invalid_request", "tenantId and clientId must be GUIDs"));
    const out = await db.transaction(async (tx): Promise<Refusal | { url: string; expiresAt: Date; requestId: string }> => {
      const t = tx as unknown as Db;
      const [s] = await t.select().from(discoverySources).where(eq(discoverySources.id, p.data.sourceId)).for("update");
      if (!s) return refusal(404, "not_found", "no such discovery source");
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
          state,
          nonce,
          codeVerifierCiphertext: encryptSecret(deps.dataKey!, pkce.verifier),
          tenantId,
          clientId,
          accountUpn: b.account.toLowerCase(),
          expiresInDays: b.expiresInDays,
          replacesCredentialId: live?.cred.id ?? null,
          redirectUri,
          // the database's clock for both ends of the window (the CHECK compares them)
          expiresAt: sql`now() + make_interval(secs => ${DELEGATED_REQUEST_TTL_MS / 1000})`,
        })
        .returning({ id: vendorControlDelegatedRequests.id, expiresAt: vendorControlDelegatedRequests.expiresAt });
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
      await audit(t, userId, null, "vendor-control-delegated-requested", "allow", `a delegated vendor control sign-in was started for '${b.account.toLowerCase()}' on discovery source '${s.name}' (a relaxation, confirmed with a step-up ${su.method}) (ADR-0338)`, {
        sourceId: s.id,
        kind: s.kind,
        requestId: row!.id,
        tenantId,
        clientId,
        accountUpn: b.account.toLowerCase(),
        expiresInDays: b.expiresInDays,
        replacesCredentialId: live?.cred.id ?? null,
        stepUp: su.method,
      });
      return { url, expiresAt: row!.expiresAt, requestId: row!.id };
    });
    if (isRefusal(out)) return send(reply, out);
    return reply.status(201).send({ authorizationUrl: out.url, requestId: out.requestId, expiresAt: out.expiresAt.toISOString() });
  });

  app.get(DELEGATED_CALLBACK_PATH, async (req, reply) => {
    const q = callbackQuery.safeParse(req.query);
    if (!q.success) return badRequest(reply, q.error);
    const userId = personOf(req);
    if (!userId) return send(reply, PERSON);
    // 1. spend the request, whatever happens next: the row gains `used_at` and loses its verifier, once
    const spent = await db.transaction(async (tx): Promise<Refusal | { req: typeof vendorControlDelegatedRequests.$inferSelect; verifier: string }> => {
      const t = tx as unknown as Db;
      const [r] = await t.select().from(vendorControlDelegatedRequests).where(eq(vendorControlDelegatedRequests.state, q.data.state)).for("update");
      if (!r) return refusal(404, "delegated_request_not_found", "no such delegated sign-in");
      if (r.usedAt) return refusal(409, "delegated_request_used", "this delegated sign-in was already completed or abandoned; start a new one");
      if (r.requestedBy !== userId) {
        await audit(t, userId, null, "vendor-control-delegated-wrong-admin", "deny", "a delegated vendor control sign-in was completed by a different admin than the one who started it; it was refused (ADR-0338)", { sourceId: r.sourceId, requestId: r.id });
        return refusal(403, "delegated_request_not_yours", "only the admin who started this sign-in can complete it");
      }
      await t.update(vendorControlDelegatedRequests).set({ usedAt: sql`now()`, codeVerifierCiphertext: null }).where(eq(vendorControlDelegatedRequests.id, r.id));
      if (r.expiresAt.getTime() <= Date.now()) {
        await audit(t, userId, null, "vendor-control-delegated-expired", "deny", "a delegated vendor control sign-in came back after its 10 minutes; nothing was stored (ADR-0338)", { sourceId: r.sourceId, requestId: r.id });
        return refusal(409, "delegated_request_expired", "this delegated sign-in expired; start a new one");
      }
      if (q.data.error || !q.data.code) {
        await audit(t, userId, null, "vendor-control-delegated-declined", "deny", "the vendor's sign-in returned no authorization code; nothing was stored (ADR-0338)", { sourceId: r.sourceId, requestId: r.id, vendorError: q.data.error?.slice(0, 64) ?? null });
        return refusal(400, "delegated_sign_in_failed", "the vendor's sign-in returned no authorization code");
      }
      if (!deps.dataKey || !r.codeVerifierCiphertext) return refusal(503, "data_key_unavailable", "the data key is not configured");
      return { req: r, verifier: decryptSecret(deps.dataKey, r.codeVerifierCiphertext) };
    });
    if (isRefusal(spent)) return send(reply, spent);
    const r = spent.req;
    const [s] = await db.select().from(discoverySources).where(eq(discoverySources.id, r.sourceId));
    const control = s ? deps.controlForKind(deps.controls, s.kind) : null;
    const scope = control?.token.delegatedScope;
    if (!s || !control || !scope) return send(reply, refusal(409, "control_not_offered", "the source's registry no longer offers a delegated control"));
    const denyAudit = (ruleId: string, reason: string, extra: Record<string, unknown> = {}) => audit(db, userId, null, ruleId, "deny", reason, { sourceId: s.id, requestId: r.id, accountUpn: r.accountUpn, ...extra });

    // 2. redeem the code with the verifier and nonce, outside any transaction (the vendor call)
    const assertion = (deps.federationToken ?? defaultFederationToken(deps.dataKey))(db, s.id);
    const client = msalClient(await deps.fetch(), r.tenantId, r.clientId, assertion);
    let result: AuthenticationResult;
    try {
      result = await client.acquireTokenByCode({ code: q.data.code!, redirectUri: r.redirectUri, scopes: [scope], codeVerifier: spent.verifier, nonce: r.nonce, state: r.state }, { code: q.data.code!, state: r.state, nonce: r.nonce });
    } catch (err) {
      const aad = aadCode(err);
      await denyAudit("vendor-control-delegated-token-failed", `the delegated vendor control code redemption failed${aad ? ` (${aad})` : ""}; nothing was stored (ADR-0338)`, { aad: aad ?? null });
      return send(reply, refusal(502, "control_token_failed", `the Entra code redemption failed${aad ? ` (${aad})` : ""}`));
    }
    const who = accountOf(result);
    const claims = (result.idTokenClaims ?? {}) as Record<string, unknown>;
    if (!who || who.tenantId !== r.tenantId || who.upn !== r.accountUpn || claims.nonce !== r.nonce) {
      await denyAudit("vendor-control-delegated-account-mismatch", "the delegated sign-in came back as a different account, tenant or nonce than the step-up was bound to; nothing was stored (ADR-0338)", { returnedTenant: who?.tenantId ?? null });
      return send(reply, refusal(403, "delegated_account_mismatch", "the sign-in must be the named account, in the source's tenant"));
    }
    const refreshToken = await refreshTokenOf(client);
    if (!refreshToken) {
      await denyAudit("vendor-control-delegated-no-refresh-token", "the delegated sign-in returned no refresh token; nothing was stored (ADR-0338)");
      return send(reply, refusal(502, "delegated_no_refresh_token", "Entra returned no refresh token (offline access was not granted)"));
    }

    // 3. store it: the opt-in, the source and the replaced row are re-checked, and the old row is revoked, in one transaction
    const out = await db.transaction(async (tx): Promise<Refusal | { cred: DiscoveryCredentialRow }> => {
      const t = tx as unknown as Db;
      const [src] = await t.select().from(discoverySources).where(eq(discoverySources.id, s.id)).for("update");
      if (!src) return refusal(404, "not_found", "no such discovery source");
      if (!(await optInOn(t))) return refusal(409, "credential_mode_disabled", "delegated control credentials were turned off while the sign-in was open");
      const live = await deps.liveControlCredentialRow(t, src.id);
      if ((live?.cred.id ?? null) !== (r.replacesCredentialId ?? null)) {
        return refusal(409, "credential_changed", "the source's control credential changed while the sign-in was open; start a new one");
      }
      if (live) {
        await t.update(discoveryCredentials).set({ revokedAt: sql`now()`, revokedBy: userId, secretCiphertext: null }).where(eq(discoveryCredentials.id, live.cred.id));
      }
      const [row] = await t
        .insert(discoveryCredentials)
        .values({
          sourceId: src.id,
          purpose: "platform_write",
          credentialMode: "delegated",
          publicConfig: { tenantId: r.tenantId, clientId: r.clientId, accountObjectId: who.objectId, accountUpn: who.upn },
          secretCiphertext: encryptSecret(deps.dataKey!, refreshToken),
          expiresAt: sql`now() + make_interval(days => ${r.expiresInDays})`,
          createdBy: userId,
        })
        .returning();
      await audit(t, userId, row!.id, live ? "vendor-control-credential-replaced" : "vendor-control-credential-stored", "allow", `a delegated vendor control credential for '${who.upn}' was ${live ? "connected, replacing the previous one," : "connected"} for discovery source '${src.name}'; it expires in ${r.expiresInDays} days (ADR-0338)`, {
        sourceId: src.id,
        kind: src.kind,
        requestId: r.id,
        tenantId: r.tenantId,
        clientId: r.clientId,
        accountObjectId: who.objectId,
        accountUpn: who.upn,
        expiresInDays: r.expiresInDays,
        replacedCredentialId: live?.cred.id ?? null,
      });
      return { cred: row! };
    });
    if (isRefusal(out)) {
      await denyAudit(`vendor-control-delegated-${out.body.error === "credential_changed" ? "credential-changed" : "refused"}`, `a delegated vendor control credential was not stored: ${String(out.body.error)} (ADR-0338)`);
      return send(reply, out);
    }
    const c = out.cred;
    return reply.status(201).send({
      credential: {
        id: c.id,
        sourceId: c.sourceId,
        purpose: "platform_write" as const,
        mode: "delegated" as const,
        publicConfig: c.publicConfig,
        expiresAt: c.expiresAt?.toISOString() ?? null,
        controlScope: "unverified" as const,
      },
    });
  });
}
