import {
  createHmac,
  randomBytes,
  scryptSync,
} from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  and,
  apiKeys,
  asc,
  auditLog,
  authMfaPending,
  authSessions,
  desc,
  eq,
  federatedLinkRequests,
  gt,
  isNull,
  lt,
  ne,
  oidcLoginStates,
  oidcProviders,
  ORG_SETTINGS_ID,
  roleAssignments,
  roles,
  samlProviders,
  sql,
  users,
  type Db,
  type IpPolicy,
  type OrgSettingsRow,
  type SessionOrigin,
} from "@regulait/db";
import {
  BROKER_IDP_VALUES,
  changePasswordSchema,
  clearMfaSchema,
  createOidcProviderSchema,
  linkConfirmSchema,
  linkDecisionSchema,
  loginSchema,
  loginWithKeySchema,
  mfaVerifySchema,
  setInitialPasswordSchema,
  setUsernameSchema,
  totpActivateSchema,
  totpDisableSchema,
  updateOidcProviderSchema,
  constantTimeEqual,
  OIDC_JIT_DOMAINS_REQUIRED,
  oidcJitDomainsMissing,
} from "@regulait/shared";
import { settingTransitions } from "./setting-transitions.js";
import { z } from "zod";
import * as oidc from "openid-client";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { loadOrgSettings } from "./org-settings.js";
import { evaluateIpEnvelope } from "./net-policy.js";
import { deviceLabel } from "./device-label.js";
import { checkEgress, createGuardedFetch, type EgressDenied } from "./egress-guard.js";
import { loadEgressAllowList } from "./custom-providers.js";
import { normalizeAssertedGroups, reconcileGroupRoles } from "./group-roles.js";
import { hashToken } from "./token-hash.js";
import { isVirtualKeyToken, resolveVirtualKey, touchVirtualKey } from "./virtual-keys.js";
import {
  anchorLinkedUser,
  anchorOfRequest,
  dropProviderLinks,
  idTokenMfa,
  LINK_COOKIE,
  LINK_PROOF_MINUTES,
  loadPendingProof,
  normalizeClaimEmail,
  orgRequiresMfa,
  raiseLinkRequest,
  recordFederatedLink,
  resolveFederatedLogin,
  touchFederatedLink,
  type FederatedAnchor,
  type ProviderRef,
} from "./federated-identity.js";
import {
  providerRemovalRefusal,
  signInInvariantChecked,
  signInInvariantWritten,
  withSignInInvariant,
  type SignInInvariantSite,
} from "./break-glass.js";

/** ADR-0066 kept this exported from `auth.ts` — the implementation moved to
 * `token-hash.ts` so `virtual-keys.ts` can share it without an import cycle,
 * and every existing `import { hashToken } from "./auth.js"` is unchanged. */
export { hashToken };

export interface AuthContext {
  /** null only for the bootstrap token (header or exchanged session), which
   * has no user identity */
  userId: string | null;
  isAdmin: boolean;
  /** "session" = ADR-0025 cookie session (password, MFA, SSO or key-exchange
   * login). The API-key and bootstrap header paths are byte-identical to
   * pre-0042. "virtual-key" is ADR-0066's scoped proxy credential: it resolves
   * to a real user (`userId` is the OWNER, whose entitlements are its ceiling)
   * but is NEVER admin, whatever the owner is, and reaches only the routes in
   * `VIRTUAL_KEY_ALLOWED_ROUTES`. */
  via: "bootstrap" | "api-key" | "session" | "virtual-key";
  /** AER-027: which allow-list this virtual key is bound to. 'dispatch' is
   *  ADR-0066's model surfaces; 'pdp' is `POST /v1/authz/check` and nothing
   *  else. Set only when `via === "virtual-key"`. */
  virtualKeyPurpose?: "dispatch" | "pdp";
  /** ADR-0066: set only when `via === "virtual-key"`. The dispatch core reads
   * it to apply the key's allow-list and budget, and the ledger stamps it. */
  virtualKeyId?: string;
  /** ADR-0167: the `api_keys` row a header credential resolved to. Set only
   * when `via === "api-key"`; it names the post-auth rate-limit bucket, so the
   * bucket is the STORED id and never anything derived from the presented
   * string. */
  apiKeyId?: string;
  /** ADR-0181 (FX2): whether the key's OWNER has TOTP enrolled. Set only when
   * `via === "api-key"`; the route hook refuses an un-enrolled owner's key
   * wherever the org MFA requirement covers them (`apiKeyMfaEnrollmentRequired`). */
  totpEnabled?: boolean;
}

/**
 * ADR-0066 — a credential that really exists but may not be used, and the
 * reason. Distinguished from `null` (nothing matched) so the holder — who by
 * definition possesses the real token — learns why, exactly as ADR-0022's
 * "disabled" marker does for a deactivated user's API key.
 */
/**
 * ADR-0098 adds `api_key_expired` and `api_key_revoked`. Both are 401s that
 * name what happened, for the same reason ADR-0066 named the virtual-key pair:
 * only somebody holding the real token ever sees them, so nothing leaks, and
 * an operator debugging "my key stopped working" MUST be able to tell a
 * lifetime that ran out from a credential somebody deliberately killed. Those
 * two facts call for opposite responses — reissue on the same terms, versus
 * find out who revoked it and why — and `unauthenticated` distinguishes
 * neither of them from a typo.
 */
export const AUTH_REFUSALS = [
  "disabled",
  "virtual_key_revoked",
  "virtual_key_expired",
  "api_key_expired",
  "api_key_revoked",
] as const;
export type AuthRefusal = (typeof AUTH_REFUSALS)[number];

export function isAuthRefusal(x: AuthContext | null | AuthRefusal): x is AuthRefusal {
  return typeof x === "string";
}

/** ONE place the holder-facing wording lives, so the route hook and the
 * key-exchange endpoint cannot drift into saying different things about the
 * same credential. */
export const AUTH_REFUSAL_DETAIL: Record<AuthRefusal, string> = {
  disabled: "this account has been deactivated — an admin can reactivate it",
  virtual_key_revoked: "this virtual key has been revoked and authenticates nothing",
  virtual_key_expired: "this virtual key has expired — its issuer can mint a new one",
  api_key_expired:
    "this API key has expired and authenticates nothing — an admin must issue a new one (an expiry cannot be extended)",
  api_key_revoked: "this API key has been revoked and authenticates nothing",
};

export const TOKEN_PREFIX = "rgl_";

export function generateToken(): { token: string; tokenHash: string } {
  const token = TOKEN_PREFIX + randomBytes(24).toString("hex");
  return { token, tokenHash: hashToken(token) };
}


/**
 * Resolve a Bearer token to an auth context. The bootstrap token (deploy-time
 * config) acts as an admin with no user identity — it exists only to create
 * the first real admin user and key. Returns null for anything invalid, and
 * the distinct marker "disabled" for a VALID key whose user is deactivated
 * (ADR-0022) — so the 401 can say WHY without leaking anything to holders of
 * invalid tokens (only someone holding the real key ever sees it).
 */
export async function authenticate(
  db: Db,
  bootstrapToken: string | undefined,
  authorizationHeader: string | undefined,
): Promise<AuthContext | null | AuthRefusal> {
  if (!authorizationHeader?.startsWith("Bearer ")) return null;
  const token = authorizationHeader.slice("Bearer ".length).trim();
  if (token.length === 0) return null;

  if (bootstrapToken && constantTimeEqual(token, bootstrapToken)) {
    return { userId: null, isAdmin: true, via: "bootstrap" };
  }

  // ADR-0066 — VIRTUAL KEYS. The `rglv_` prefix makes the two credential kinds
  // disjoint, so this branch cannot change the api_keys path in any way: an
  // ordinary `rgl_` token never reaches it, and an `rglv_` token never reaches
  // the api_keys lookup below.
  //
  // THE LINE THAT MATTERS: `isAdmin` is hard-coded false. A virtual key issued
  // by an admin is not an admin — a scoped, budgeted proxy credential that
  // silently carried admin would be the exact opposite of what it is for. Its
  // `userId` IS the owner, so every downstream entitlement check evaluates the
  // owner's grants, which is what makes the key a CEILING rather than a bypass.
  if (isVirtualKeyToken(token)) {
    const resolved = await resolveVirtualKey(db, token);
    if (!resolved.ok) {
      if (resolved.reason === "revoked") return "virtual_key_revoked";
      if (resolved.reason === "expired") return "virtual_key_expired";
      return null;
    }
    // ADR-0022: a deactivated owner's virtual keys stop authenticating for the
    // same reason their API keys do — the ceiling belongs to a person who is
    // no longer allowed in.
    if (resolved.ownerDisabled) return "disabled";
    await touchVirtualKey(db, resolved.row.id);
    return {
      userId: resolved.row.userId,
      isAdmin: false,
      via: "virtual-key",
      virtualKeyId: resolved.row.id,
      virtualKeyPurpose: resolved.row.purpose ?? "dispatch",
    };
  }

  // ADR-0098: the `revoked_at IS NULL` filter moved OUT of this WHERE clause.
  // It used to make a revoked key indistinguishable from a token that never
  // existed; the row is now fetched either way so the two dead states —
  // revoked and expired — can be told apart, by the holder AND in the audit
  // trail. The lookup is still one indexed equality on `token_hash`.
  const [row] = await db
    .select({
      keyId: apiKeys.id,
      userId: apiKeys.userId,
      isAdmin: users.isAdmin,
      disabledAt: users.disabledAt,
      revokedAt: apiKeys.revokedAt,
      expiresAt: apiKeys.expiresAt,
      totpEnabled: users.totpEnabled,
    })
    .from(apiKeys)
    .innerJoin(users, eq(apiKeys.userId, users.id))
    .where(eq(apiKeys.tokenHash, hashToken(token)));
  if (!row) return null;
  // ADR-0022: a deactivated user's keys stop authenticating IMMEDIATELY — no
  // lastUsedAt touch, no context. Reactivation restores them unchanged
  // (deactivate ≠ delete; the keys were never revoked). Checked BEFORE the two
  // key-state refusals so a disabled account keeps saying so, unchanged.
  if (row.disabledAt !== null) return "disabled";
  // ADR-0098 — THE TWO DEAD STATES, in the one place a bearer token becomes an
  // identity. Revoked is checked FIRST: a key somebody deliberately killed is
  // revoked whatever its clock says, and telling its holder "expired" would
  // invite them to ask for the same key again.
  if (row.revokedAt !== null) {
    await auditKeyRefusal(db, row.userId, row.keyId, "revoked", row.revokedAt);
    return "api_key_revoked";
  }
  if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
    await auditKeyRefusal(db, row.userId, row.keyId, "expired", row.expiresAt);
    return "api_key_expired";
  }

  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.keyId));
  return { userId: row.userId, isAdmin: row.isAdmin, via: "api-key", apiKeyId: row.keyId, totpEnabled: row.totpEnabled };
}

/**
 * ADR-0181 (FX2, review finding 3) — an API key is not a way around MFA.
 *
 * The org MFA requirement used to bind only the cookie session, so an admin
 * who never enrolled TOTP kept full administrator power through an API key.
 * A key now answers to the SAME dial as a session (`orgRequiresMfa`): where
 * the requirement covers the key's owner and the owner has no TOTP, the key is
 * refused (route hook), it cannot be exchanged for a browser session (where
 * the self-service enrolment routes would let its holder enrol THEIR OWN
 * authenticator), and no new key is issued to that person. The bootstrap token
 * is no user's key and is not affected; a virtual key is never admin.
 */
export function apiKeyMfaEnrollmentRequired(org: OrgSettingsRow, ctx: AuthContext): boolean {
  if (ctx.via !== "api-key" || !ctx.userId || ctx.totpEnabled === true) return false;
  return orgRequiresMfa(org, ctx.isAdmin);
}

/** the holder-facing refusal for an un-enrolled owner's key (one wording) */
export const API_KEY_MFA_REFUSAL = {
  error: "mfa_enrollment_required",
  detail:
    "this organization requires TOTP MFA for this account, and an API key does not satisfy it: the key's owner must " +
    "sign in and enroll TOTP (POST /auth/totp/enroll) before the key works. An admin may relax mfaRequired (audited).",
} as const;

/**
 * ADR-0098 — the audit half of "expired ≠ revoked".
 *
 * Written HERE rather than at each 401 site, because `authenticate()` is the
 * only place that knows WHICH key was presented — the refusal that leaves this
 * function is a bare string. Every caller (the route auth hook, the
 * interception identity probe, `POST /auth/login-with-key`) therefore audits
 * identically, with no site left to forget.
 *
 * `ruleId` is the discriminator an operator greps: `api-key-refused-expired`
 * versus `api-key-refused-revoked`. `lastUsedAt` is deliberately NOT touched —
 * a refused presentation is not a use.
 */
async function auditKeyRefusal(
  db: Db,
  userId: string,
  keyId: string,
  kind: "expired" | "revoked",
  at: Date,
): Promise<void> {
  await db.insert(auditLog).values({
    userId,
    objectType: "api_key",
    objectId: keyId,
    detail: {
      phase: "authenticate",
      keyId,
      refusal: kind,
      [kind === "expired" ? "expiresAt" : "revokedAt"]: at.toISOString(),
    },
    effect: "deny",
    ruleId: `api-key-refused-${kind}`,
    ruleChain: [],
    reason:
      kind === "expired"
        ? `API key ${keyId} expired at ${at.toISOString()} and authenticates nobody; a new key must be issued`
        : `API key ${keyId} was revoked at ${at.toISOString()} and authenticates nobody`,
  });
}

// ===========================================================================
// ADR-0025 — real human authentication.
// Everything below is NEW surface: the two functions above are the pre-0042
// API-key/bootstrap path, untouched.
// ===========================================================================

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

// --- passwords (scrypt via node:crypto — memory-hard, zero deps) ------------
// Parameters recorded in ADR-0025: N=2^14, r=8, p=1 → 16 MiB per verification,
// interactive-login grade per the scrypt paper/OWASP; 64-byte derived key.
// The format string carries the parameters so they can be raised later and
// old hashes keep verifying (and can be flagged for rehash-on-login).
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** constant-time verify; a null/malformed stored hash still burns a scrypt so
 * response timing cannot distinguish "no such user / no password" from "wrong
 * password". */
export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  const parts = stored?.split("$") ?? [];
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    // dummy derivation against a fixed salt — same cost, always false
    scryptSync(password, "regulait-dummy-salt", SCRYPT_KEYLEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
    });
    return false;
  }
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  const expected = Buffer.from(hashB64!, "base64");
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || expected.length === 0) {
    return false;
  }
  const actual = scryptSync(password, Buffer.from(saltB64!, "base64"), expected.length, {
    N,
    r,
    p,
    maxmem: 128 * N * r * 2,
  });
  return constantTimeEqual(actual, expected);
}

/** org-policy check; returns a human reason or null when the password passes */
export function checkPasswordPolicy(
  password: string,
  minLength: number,
  requireClasses: number,
): string | null {
  if (password.length < minLength) {
    return `password must be at least ${minLength} characters`;
  }
  const classes =
    (/[a-z]/.test(password) ? 1 : 0) +
    (/[A-Z]/.test(password) ? 1 : 0) +
    (/[0-9]/.test(password) ? 1 : 0) +
    (/[^a-zA-Z0-9]/.test(password) ? 1 : 0);
  if (classes < requireClasses) {
    return `password must use at least ${requireClasses} of: lowercase, uppercase, digits, symbols`;
  }
  return null;
}

// --- sessions ---------------------------------------------------------------

export const SESSION_COOKIE = "regulait_session";
export const CSRF_HEADER = "x-regulait-csrf";
const SESSION_TOKEN_PREFIX = "rgls_";
const MFA_PENDING_MINUTES = 5;
const OIDC_STATE_MINUTES = 10;

export function generateSessionToken(): { token: string; tokenHash: string } {
  // 256-bit random token; only its sha256 ever touches the database
  const token = SESSION_TOKEN_PREFIX + randomBytes(32).toString("hex");
  return { token, tokenHash: hashToken(token) };
}

export function readCookie(header: string | string[] | undefined, name: string): string | null {
  if (!header) return null;
  const raw = Array.isArray(header) ? header.join(";") : header;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

/**
 * Did this request REALLY arrive over TLS? This decides the session cookie's
 * `Secure` flag, so getting it wrong in the "no" direction leaks the session
 * token onto a plaintext hop.
 *
 * ADR-0031 (item 3 follow-up) — this used to read `x-forwarded-proto` straight
 * off the raw headers, which Fastify never gates on `trustProxy`. ADR-0029
 * assessed that as safe on the grounds that forging the header can only turn
 * `Secure` ON. That is the harmless direction; the harmful one is the reverse.
 * Anything able to reach the gateway port without passing through Caddy — host
 * loopback (the port is published there), a sibling container, a future
 * sidecar — could send `x-forwarded-proto: http` and be issued a session cookie
 * with NO `Secure` flag, which the browser will then happily transmit in
 * cleartext. An attacker choosing whether our cookies are protected is not a
 * property we want to keep.
 *
 * `req.protocol` is Fastify's own answer to the same question, and it is
 * trust-gated: it consults `x-forwarded-proto` only when the socket peer
 * matches the configured `trustProxy` (see trusted-proxy.ts), and otherwise
 * reports the real socket protocol. So the value is decided by the named proxy
 * or by the transport itself — never by whoever happened to connect.
 *
 * Two consequences, both deliberate:
 *  - Multi-hop `x-forwarded-proto: a, b` is now read as the LAST entry (the
 *    nearest, trusted proxy) rather than the first. The first entry is exactly
 *    the one a client can inject when any upstream *appends* rather than
 *    overwrites, so the last is the safer of the two. Our Caddy sends a single
 *    value, so no chain arises in this topology.
 *  - A deployment behind a TLS terminator MUST name it in
 *    REGULAIT_TRUSTED_PROXIES, or `Secure` turns off — docker-compose.yml sets
 *    it, and main.ts prints the effective posture at boot precisely so this
 *    cannot be got wrong quietly.
 */
export function requestIsSecure(req: FastifyRequest): boolean {
  return req.protocol === "https";
}

export function sessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  return (
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}` +
    (secure ? "; Secure" : "")
  );
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` + (secure ? "; Secure" : "");
}

// --- ADR-0167 (AUTHZ-04): SSO login state is bound to the browser that started it ---
//
// /auth/oidc/:id/start and /auth/saml/:id/start stored a single-use state row
// and redirected; the callback / ACS claimed the row by the `state` (or
// `RelayState`) in the request and minted a session for WHOEVER presented it.
// PKCE and the nonce bind the CODE to the server-side row; nothing bound the
// row to a user agent. So an attacker could start a login, authenticate at the
// IdP as themselves, and hand the resulting callback URL to a victim, whose
// browser would complete the exchange and be signed in to the ATTACKER's
// account — classic login CSRF, with everything the victim then typed landing
// where the attacker can read it.
//
// The binding is a cookie set at /start whose value is an HMAC of the state
// under the data key (so it needs no column, survives a replica change, and
// cannot be computed by anyone without the key); the return leg requires it to
// match. The cookie never leaves the login path and lives as long as the
// state row does.
//
//   - OIDC: the callback is a top-level GET, which a `SameSite=Lax` cookie
//     accompanies. Lax, HttpOnly, Secure when the request is.
//   - SAML: the ACS is a CROSS-SITE top-level POST from the IdP, which a Lax
//     cookie never accompanies. The binding therefore rides `SameSite=None;
//     Secure`, which browsers accept only over TLS — so for SAML the cookie is
//     set, and required, only when the request is genuinely secure. A SAML
//     deployment over plaintext http is already handing its session cookie to
//     the wire; it is not made worse here, and it is not pretended to be bound.
//
// IdP-initiated SAML (no RelayState row) has no /start to bind to and stays
// behind the provider's explicit `allowIdpInitiated` switch, unchanged.

export const OIDC_BINDING_COOKIE = "regulait_oidc_login";
export const SAML_BINDING_COOKIE = "regulait_saml_login";
const SSO_BINDING_MAX_AGE_SECONDS = OIDC_STATE_MINUTES * 60;
/** the HMAC key when no data key is configured: per-process, which is correct
 * for a single replica and honestly weaker for several — a multi-replica
 * deployment has a data key (ADR-0063) */
const processBindingSecret = randomBytes(32);

export function ssoBrowserBinding(dataKeyHex: string | undefined, state: string): string {
  const trimmed = dataKeyHex?.trim() ?? "";
  const key = /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, "hex") : processBindingSecret;
  return createHmac("sha256", key).update(`sso-browser-binding\0${state}`).digest("base64url");
}

export function ssoBindingMatches(presented: string | null, expected: string): boolean {
  return presented !== null && constantTimeEqual(presented, expected);
}

export function ssoBindingCookie(
  name: string,
  value: string,
  opts: { path: string; secure: boolean; crossSite: boolean },
): string {
  const sameSite = opts.crossSite ? "None" : "Lax";
  return (
    `${name}=${value}; Path=${opts.path}; HttpOnly; SameSite=${sameSite}; Max-Age=${SSO_BINDING_MAX_AGE_SECONDS}` +
    (opts.secure || opts.crossSite ? "; Secure" : "")
  );
}

export interface SessionAuth {
  ctx: AuthContext;
  sessionId: string;
  /** user flags the gates in app.ts consult (null-user bootstrap session = all false) */
  mustChangePassword: boolean;
  totpEnabled: boolean;
  /** ADR-0028: HOW this session was established. 'unknown' = a pre-0046 row. */
  origin: SessionOrigin;
  /** ADR-0174: the identity provider asserted MFA for the login that minted
   * this session — it satisfies the org MFA requirement without a TOTP. */
  idpMfa: boolean;
}

export async function createSession(
  db: Db,
  userId: string | null,
  org: OrgSettingsRow,
  req: FastifyRequest,
  /** ADR-0028: every creation site names the credential that established the
   * session. There is deliberately no default — a new login path must choose. */
  origin: SessionOrigin,
  /** ADR-0174: set only by a federated login whose IdP asserted MFA */
  extra: { idpMfa?: boolean } = {},
): Promise<{ token: string; sessionId: string; maxAgeSeconds: number }> {
  const { token, tokenHash } = generateSessionToken();
  const now = Date.now();
  const lifetimeMs = org.sessionLifetimeHours * 3600_000;
  const idleMs = org.sessionIdleMinutes * 60_000;
  const [row] = await db
    .insert(authSessions)
    .values({
      tokenHash,
      userId,
      origin,
      expiresAt: new Date(now + lifetimeMs),
      idleExpiresAt: new Date(now + Math.min(idleMs, lifetimeMs)),
      idleMinutes: org.sessionIdleMinutes,
      ip: req.ip ?? null,
      // ADR-0039: last_seen starts where the session starts
      lastSeenIp: req.ip ?? null,
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 512) : null,
      idpMfa: extra.idpMfa === true,
    })
    .returning({ id: authSessions.id });
  return { token, sessionId: row!.id, maxAgeSeconds: Math.floor(lifetimeMs / 1000) };
}

/**
 * Resolve a session cookie token. Checks, in order: token known, not revoked,
 * inside both the absolute and the idle wall, and — for user sessions — the
 * user is not deactivated (ADR-0022: a disabled user's sessions are dead the
 * moment the flag lands, exactly like their keys). A null-user session is the
 * exchanged BOOTSTRAP token; it only resolves while the deployment still has a
 * bootstrap token configured. Valid use slides the idle wall forward.
 */
export async function resolveSession(
  db: Db,
  token: string,
  bootstrapConfigured: boolean,
  /** ADR-0039: the requesting client IP; when provided it is written into
   * last_seen_ip in the SAME update as the idle-slide (no extra query).
   * Omitted (undefined) leaves the stored value untouched. */
  clientIp?: string | null,
): Promise<SessionAuth | null | "disabled"> {
  const [row] = await db
    .select({
      id: authSessions.id,
      userId: authSessions.userId,
      expiresAt: authSessions.expiresAt,
      idleExpiresAt: authSessions.idleExpiresAt,
      idleMinutes: authSessions.idleMinutes,
      lastSeenAt: authSessions.lastSeenAt,
      // ADR-0181 (FX2, finding 10a): the org's CURRENT idle window, read with
      // the session in the same query (the singleton row; null before it exists)
      orgIdleMinutes: sql<number | null>`(select "session_idle_minutes" from "org_settings" where "id" = ${ORG_SETTINGS_ID})`,
      origin: authSessions.origin,
      revokedAt: authSessions.revokedAt,
      idpMfa: authSessions.idpMfa,
      isAdmin: users.isAdmin,
      disabledAt: users.disabledAt,
      mustChangePassword: users.mustChangePassword,
      totpEnabled: users.totpEnabled,
    })
    .from(authSessions)
    .leftJoin(users, eq(authSessions.userId, users.id))
    .where(eq(authSessions.tokenHash, hashToken(token)));
  if (!row) return null;
  if (row.revokedAt) return null;
  const now = Date.now();
  if (row.expiresAt.getTime() <= now || row.idleExpiresAt.getTime() <= now) return null;
  // ADR-0181 (FX2, finding 10a) — NO GRANDFATHERING of the idle window. A
  // session snapshots the org's idle minutes when it is created, so a session
  // opened under a laxer setting used to keep it until it died. The window
  // that applies is now the SHORTER of the snapshot and the org's current
  // value: tightening sessionIdleMinutes binds every live session on its next
  // request (measured from its last use); relaxing it applies to new sessions.
  const orgIdle = row.orgIdleMinutes === null ? null : Number(row.orgIdleMinutes);
  const idleMinutes = orgIdle !== null && orgIdle > 0 ? Math.min(row.idleMinutes, orgIdle) : row.idleMinutes;
  if (row.lastSeenAt.getTime() + idleMinutes * 60_000 <= now) return null;
  if (row.userId === null) {
    // bootstrap-exchanged session: dies with the deploy-time token
    if (!bootstrapConfigured) return null;
    await db
      .update(authSessions)
      .set({
        idleExpiresAt: new Date(now + idleMinutes * 60_000),
        idleMinutes,
        lastSeenAt: new Date(now),
        ...(clientIp !== undefined ? { lastSeenIp: clientIp } : {}),
      })
      .where(eq(authSessions.id, row.id));
    return {
      ctx: { userId: null, isAdmin: true, via: "session" },
      sessionId: row.id,
      mustChangePassword: false,
      totpEnabled: false,
      origin: row.origin,
      idpMfa: false,
    };
  }
  if (row.disabledAt) return "disabled";
  await db
    .update(authSessions)
    .set({
      idleExpiresAt: new Date(now + idleMinutes * 60_000),
      idleMinutes,
      lastSeenAt: new Date(now),
      ...(clientIp !== undefined ? { lastSeenIp: clientIp } : {}),
    })
    .where(eq(authSessions.id, row.id));
  return {
    ctx: { userId: row.userId, isAdmin: row.isAdmin ?? false, via: "session" },
    sessionId: row.id,
    mustChangePassword: row.mustChangePassword ?? false,
    totpEnabled: row.totpEnabled ?? false,
    origin: row.origin,
    idpMfa: row.idpMfa,
  };
}

// --- ADR-0039: which IP-policy knob governs a session origin ---------------

/** the origins the HUMAN knob (session_ip_policy) governs. 'saml' is listed
 * for ADR-0036 forward-compatibility even though the origin enum does not
 * carry it yet — when SAML lands its sessions are governed from day one. */
export const HUMAN_SESSION_ORIGINS: ReadonlySet<string> = new Set(["password", "oidc", "saml"]);

/**
 * ADR-0039 — ONE rule for which knob binds a session origin:
 *  - password | oidc | saml -> session_ip_policy (interactive humans);
 *  - api_key                -> api_key_ip_policy (automation gets its own,
 *    consciously separate knob — tightening the human policy never silently
 *    locks out CI, and neither knob can EXEMPT the other's path);
 *  - bootstrap              -> never restricted (the deploy-time break-glass
 *    path, already scoped to "dies when the bootstrap token is unset");
 *  - unknown                -> not governed. A pre-0046 row's true origin is
 *    unknowable; the ADR enumerates the governed origins explicitly, and
 *    inventing coverage here would revoke grandfathered sessions on upgrade.
 */
export function governingIpPolicy(org: OrgSettingsRow, origin: SessionOrigin): IpPolicy {
  if (HUMAN_SESSION_ORIGINS.has(origin)) return org.sessionIpPolicy;
  if (origin === "api_key") return org.apiKeyIpPolicy;
  return "off";
}

// --- ADR-0028: the current-password requirement, in ONE place ---------------

/**
 * Is the CURRENT password required to set a new one on this request?
 *
 * It is NOT required only in the narrow lockout case: the session was
 * established with an API KEY and the account is in a recovery state — a
 * one-time password it was never told (`mustChangePassword`) or no password at
 * all (`passwordHash IS NULL`). The API key already authenticates as that
 * user, so demanding a password they cannot obtain protects nothing and locks
 * the account out of every non-self-service route (including Users, so they
 * cannot even reset themselves).
 *
 * It IS required everywhere else — in particular for an api_key session on an
 * account with an established password and no forced change. Relaxing THAT
 * would let a stolen API key be escalated into a permanent password that
 * outlives revocation of the key: a privilege-persistence path, not a
 * convenience.
 *
 * `origin` 'unknown' (a pre-0046 session, origin unknowable) and every
 * non-api_key origin fail CLOSED. A header API-key request has no session and
 * therefore no origin — it also fails closed here.
 */
export function passwordChangeRequiresCurrent(
  origin: SessionOrigin | null | undefined,
  user: { mustChangePassword: boolean; passwordHash: string | null } | null,
): boolean {
  if (!user) return true;
  if (origin !== "api_key") return true;
  return !(user.mustChangePassword || user.passwordHash === null);
}

/** which recovery condition opened the bypass — named in the audit row so a
 * key-session password set is never an invisible event */
export function recoveryReason(user: {
  mustChangePassword: boolean;
  passwordHash: string | null;
}): "must_change_password" | "no_password_hash" | null {
  if (user.passwordHash === null) return "no_password_hash";
  if (user.mustChangePassword) return "must_change_password";
  return null;
}

// --- TOTP (RFC 6238 via HMAC-SHA1, zero deps) -------------------------------
// The implementation lives in `totp.ts` (ADR-0181: the e2e journeys load it
// without the rest of this module); every name is re-exported unchanged.
export {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUri,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  totpCode,
  totpStep,
  verifyTotp,
} from "./totp.js";
import { generateTotpSecret, otpauthUri, verifyTotp } from "./totp.js";

// --- audit helper -----------------------------------------------------------

export function auditAuth(
  db: Pick<Db, "insert">,
  actorUserId: string | null,
  targetUserId: string | null,
  ruleId: string,
  effect: "allow" | "deny",
  reason: string,
  detail: Record<string, unknown>,
  objectType: "user" | "oidc_provider" | "saml_provider" | "scim_group" | "scim_token" = "user",
) {
  return db.insert(auditLog).values({
    userId: actorUserId ?? NIL_UUID,
    objectType,
    objectId: targetUserId,
    detail,
    effect,
    ruleId,
    ruleChain: [],
    reason,
  });
}

/** ADR-0043: thrown when an OIDC issuer fails the egress guard at discovery
 * time. The /start and /callback routes turn it into an honest 403
 * `egress_blocked`; the refusal is audited before the throw and nothing has
 * left the box. */
export class OidcEgressBlockedError extends Error {
  constructor(readonly decision: EgressDenied) {
    super(`egress blocked (${decision.code}): ${decision.reason}`);
    this.name = "OidcEgressBlockedError";
  }
}

// --- routes -----------------------------------------------------------------

export interface AuthRouteOptions {
  bootstrapToken?: string;
  dataKey?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    /** set when the request authenticated via a cookie session (ADR-0025) */
    sessionAuth?: SessionAuth;
  }
}

/** uniform 401 for EVERY password-login failure — unknown email, UNKNOWN
 * USERNAME (ADR-0030), wrong password, passwordless account, deactivated
 * account, active lockout — so the endpoint is not an account-existence
 * oracle. The wording is deliberately UNCHANGED from ADR-0025: the body must
 * be byte-identical across every failure mode, and changing it would both
 * break clients matching on it and, worse, invite a future variant per
 * namespace — which is exactly the oracle this constant exists to deny. */
const UNIFORM_LOGIN_401 = {
  error: "invalid_credentials",
  detail: "email or password is incorrect",
};

/**
 * ADR-0030 — the ONE resolution rule for a login identifier.
 *
 * An identifier containing '@' is an EMAIL; anything else is a USERNAME.
 * The rule is total and unambiguous because the two namespaces are provably
 * disjoint: migration 0047's CHECK forbids '@' in a username, so no string
 * can ever be a valid member of both. A username can therefore never be used
 * to impersonate another user's email address.
 */
export function identifierKind(identifier: string): "email" | "username" {
  return identifier.includes("@") ? "email" : "username";
}

function requireCsrfHeader(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.headers[CSRF_HEADER] !== "1") {
    void reply.status(403).send({
      error: "csrf_header_required",
      detail: `state-changing requests must carry ${CSRF_HEADER}: 1`,
    });
    return false;
  }
  return true;
}

/**
 * ADR-0039 enforce_at_login (and stricter): may a NEW session be minted for
 * this request? Called at every session-CREATION site with the knob that
 * governs the origin being created. Any enforcing level refuses creation from
 * outside the envelope — a session minted under `enforce_continuous` would die
 * on its first use anyway, so refusing at the door is the same policy stated
 * honestly. Refusal = 401 + audit, NO cookie. Returns true when the login was
 * refused (caller returns immediately).
 *
 * Module-level and exported (ADR-0036): the SAML ACS is a session-creation
 * site living in another file and MUST answer to the same function, not to a
 * second copy of the rule that could drift.
 */
export async function refuseIpBlockedLogin(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  org: OrgSettingsRow,
  knob: "session_ip_policy" | "api_key_ip_policy",
  detail: { method: string; userId?: string | null; email?: string; provider?: string },
): Promise<boolean> {
  const policy = knob === "session_ip_policy" ? org.sessionIpPolicy : org.apiKeyIpPolicy;
  if (policy === "off") return false;
  const decision = evaluateIpEnvelope(org.sessionIpAllowlist, req.ip ?? null);
  if (decision.allowed) return false;
  await auditAuth(db, null, detail.userId ?? null, "ip-policy-login-denied", "deny",
    `session creation (${detail.method}) refused by ${knob}='${policy}': client IP ${req.ip ?? "unknown"} is ${decision.reason === "no_client_ip" ? "undeterminable (fail closed)" : "outside the org IP allow-list"}`,
    {
      phase: "ip-policy-login",
      knob,
      policy,
      clientIp: req.ip ?? null,
      reason: decision.reason,
      allowlist: org.sessionIpAllowlist ?? [],
      ...detail,
    });
  await reply.status(401).send({
    error: "ip_not_allowed",
    detail: "sign-in from this network address is not permitted by organization policy",
  });
  return true;
}

/**
 * ADR-0025's identity anchor, module-level so BOTH federated paths share ONE
 * implementation: SSO maps on the verified/asserted EMAIL, case-insensitively,
 * and never on `users.username` (ADR-0030's locally-editable second
 * identifier — a compromised or misconfigured IdP attribute must not be able
 * to impersonate another account through it).
 */
export async function loadUserByEmail(db: Db, email: string) {
  // ADR-0107 (F01): `users_email_unique` is UNIQUE on `email` EXACTLY, not on
  // `lower(email)`. This lookup case-folds, so 'Ada@x' and 'ada@x' — two
  // separate, both-legal rows — BOTH match it, and unordered the row that got
  // authenticated (or SCIM-updated) was arbitrary. Oldest account wins: the
  // first registration of an address is the one that owns it.
  //
  // ADR-0109 (migration 0108) SHIPPED THE REAL FIX ADR-0107 deferred:
  // `users_email_lower_uq`, a functional UNIQUE index ON users (lower(email)).
  // On any database carrying that migration this predicate now matches AT MOST
  // ONE ROW and the `orderBy` below is a no-op. It is KEPT rather than removed
  // because it is the honest behaviour for a database that has not yet been
  // migrated, and because removing it would say ordering never mattered here.
  // The consequence of the index is stated at POST /v1/users, the one path
  // that could create a case-variant: it now answers 409 instead.
  const [row] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(1);
  return row ?? null;
}

/**
 * ADR-0025 lockout bookkeeping for ONE failed password presentation, shared by
 * password login and ADR-0174's link proof — a second copy of the counter rule
 * would let one path be brute-forced around the other. The window resets the
 * counter; crossing the threshold engages a temporary lockout (audited).
 */
export async function recordPasswordFailure(
  db: Db,
  org: OrgSettingsRow,
  user: typeof users.$inferSelect,
  now: Date,
  identifierKindTried: "email" | "username",
): Promise<void> {
  const windowMs = org.loginLockoutWindowMinutes * 60_000;
  const inWindow =
    user.lastFailedLoginAt && now.getTime() - user.lastFailedLoginAt.getTime() < windowMs;
  const count = (inWindow ? user.failedLoginCount : 0) + 1;
  const engage = count >= org.loginLockoutThreshold;
  await db
    .update(users)
    .set({
      failedLoginCount: count,
      lastFailedLoginAt: now,
      ...(engage ? { lockedUntil: new Date(now.getTime() + org.loginLockoutMinutes * 60_000) } : {}),
    })
    .where(eq(users.id, user.id));
  if (engage) {
    await auditAuth(db, null, user.id, "login-lockout", "deny",
      `account '${user.email}' temporarily locked after ${count} failed logins (${org.loginLockoutMinutes}m)`,
      // ADR-0030: lockout is per ACCOUNT, not per identifier — failures
      // arriving by username and by email count against the same user.
      { phase: "login-lockout", email: user.email, identifierKind: identifierKindTried, failures: count, lockoutMinutes: org.loginLockoutMinutes });
  }
}

/** ADR-0174: may this account use password sign-in under the org's local
 * sign-in mode? 'break_glass_only' admits only a designated, active ADMIN. */
export function localSignInAllowed(org: OrgSettingsRow, user: { id: string; isAdmin: boolean }): boolean {
  if (org.localSignIn !== "break_glass_only") return true;
  return user.isAdmin && (org.breakGlassUserIds ?? []).includes(user.id);
}

/** ADR-0174: the clear page a browser sees when a federated sign-in is refused
 * for a reason the person can act on. Static text only — nothing from the
 * request is echoed into it. JSON callers get the same refusal as JSON. */
function federatedRefusal(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  error: string,
  title: string,
  detail: string,
) {
  const accept = typeof req.headers.accept === "string" ? req.headers.accept : "";
  if (!accept.includes("text/html")) return reply.status(status).send({ error, detail });
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — RegulAIt</title><style>
:root{color-scheme:light dark;--bg:#f6f7f9;--panel:#fff;--ink:#14171c;--muted:#4a5260;--line:#d9dde3;--accent:#1d4ed8}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--panel:#171b21;--ink:#e8eaee;--muted:#a7aebb;--line:#2a3039;--accent:#8ab4ff}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{max-width:440px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:1.25rem;margin:0 0 8px}p{color:var(--muted);margin:0 0 16px}a{color:var(--accent);font-weight:600}
</style></head><body><main><h1>${esc(title)}</h1><p>${esc(detail)}</p><p><a href="/ui/login">Back to sign-in</a></p></main></body></html>`;
  return reply.status(status).header("content-type", "text/html; charset=utf-8").send(html);
}

export function linkCookie(value: string, secure: boolean, maxAgeSeconds: number): string {
  return `${LINK_COOKIE}=${value}; Path=/auth/link; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}` + (secure ? "; Secure" : "");
}

/** ADR-0174 (finding 1): the pending-MFA token of a SAML login that must step
 * up to the account's TOTP. HttpOnly, scoped to /auth/mfa, minutes-long.
 *
 * The value is an opaque 256-bit handle from `generateSessionToken` (or "" when
 * clearing). It carries no user id, no origin and no TOTP state: those live in
 * the `auth_mfa_pending` row, which stores only sha256(handle), and the TOTP
 * secret stays encrypted on `users`. Secure is set whenever the request came
 * over TLS. `token-hash.test.ts` pins these attributes. */
export const MFA_PENDING_COOKIE = "regulait_mfa_pending";
export function mfaPendingCookie(value: string, secure: boolean, maxAgeSeconds: number): string {
  return `${MFA_PENDING_COOKIE}=${value}; Path=/auth/mfa; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}` + (secure ? "; Secure" : "");
}

/** park a SAML login at the TOTP step: no session exists until the code
 * verifies at POST /auth/mfa/verify (which mints it with origin `saml`) */
export async function beginSamlTotpStepUp(
  db: Db,
  userId: string,
  samlProviderId: string,
): Promise<{ token: string; maxAgeSeconds: number }> {
  const { token, tokenHash } = generateSessionToken();
  await db.delete(authMfaPending).where(eq(authMfaPending.userId, userId));
  await db.insert(authMfaPending).values({
    tokenHash,
    userId,
    origin: "saml",
    samlProviderId,
    expiresAt: new Date(Date.now() + MFA_PENDING_MINUTES * 60_000),
  });
  return { token, maxAgeSeconds: MFA_PENDING_MINUTES * 60 };
}

export function registerAuthRoutes(app: FastifyInstance, db: Db, opts: AuthRouteOptions = {}) {
  const setSession = async (
    reply: FastifyReply,
    req: FastifyRequest,
    userId: string | null,
    org: OrgSettingsRow,
    origin: SessionOrigin,
    extra: { idpMfa?: boolean } = {},
  ) => {
    const { token, maxAgeSeconds } = await createSession(db, userId, org, req, origin, extra);
    void reply.header("set-cookie", sessionCookie(token, requestIsSecure(req), maxAgeSeconds));
  };

  /** thin binder over the module-level rule (shared with the SAML ACS) */
  const refuseIpBlocked = (
    req: FastifyRequest,
    reply: FastifyReply,
    org: OrgSettingsRow,
    knob: "session_ip_policy" | "api_key_ip_policy",
    detail: { method: string; userId?: string | null; email?: string; provider?: string },
  ) => refuseIpBlockedLogin(db, req, reply, org, knob, detail);

  const loadUserByEmailHere = (email: string) => loadUserByEmail(db, email);

  /** ADR-0030: resolve either namespace with the SAME shape of query and the
   * same absence semantics — a miss returns null and the caller then walks
   * the identical failure path (scrypt burn + uniform 401 + audit), so an
   * unknown username is indistinguishable from an unknown email, which is
   * indistinguishable from a wrong password. */
  const loadUserByIdentifier = async (identifier: string) => {
    if (identifierKind(identifier) === "email") return loadUserByEmailHere(identifier);
    const [row] = await db
      .select()
      .from(users)
      .where(eq(users.username, identifier.toLowerCase()));
    return row ?? null;
  };

  // ---- POST /auth/login ----------------------------------------------------
  app.post("/auth/login", async (req, reply) => {
    if (!requireCsrfHeader(req, reply)) return reply;
    const body = loginSchema.parse(req.body);
    const org = await loadOrgSettings(db);
    // opportunistic sweep of expired short-lived rows (cheap, indexed)
    const now = new Date();
    await db.delete(authMfaPending).where(lt(authMfaPending.expiresAt, now));
    await db.delete(oidcLoginStates).where(lt(oidcLoginStates.expiresAt, now));

    if (org.ssoOnly) {
      return reply.status(403).send({
        error: "sso_required",
        detail: "password login is disabled for this organization — use single sign-on",
      });
    }

    // ADR-0039: an out-of-envelope address never even reaches password
    // processing — refused before any credential is examined, no cookie.
    if (await refuseIpBlocked(req, reply, org, "session_ip_policy", { method: "password" })) {
      return reply;
    }

    // ADR-0030: ONE field, either namespace. `body.identifier` is what the
    // schema normalized `{identifier}` OR the legacy `{email}` down to.
    const kind = identifierKind(body.identifier);
    const user = await loadUserByIdentifier(body.identifier);
    const fail = async (why: string) => {
      if (user) {
        // lockout bookkeeping (dials from org settings) — the shared rule
        await recordPasswordFailure(db, org, user, now, kind);
      }
      await auditAuth(db, null, user?.id ?? null, "login-failed", "deny",
        "password login failed",
        // the audit trail records WHY (and WHICH namespace was tried); the
        // HTTP response never does
        { phase: "login-failed", identifier: body.identifier, identifierKind: kind, why });
      return reply.status(401).send(UNIFORM_LOGIN_401);
    };

    if (!user) {
      // ADR-0030: the unknown-USERNAME path burns the same scrypt as the
      // unknown-email and wrong-password paths — one branch, no shortcut.
      verifyPassword(body.password, null); // burn the same scrypt cost
      return fail(kind === "username" ? "unknown_username" : "unknown_email");
    }
    if (user.disabledAt) {
      verifyPassword(body.password, null);
      return fail("user_disabled");
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > now.getTime()) {
      verifyPassword(body.password, null);
      return fail("locked_out");
    }
    // ADR-0174 (security review, finding 3): in break-glass mode only a
    // designated admin may use a local password, and that is decided BEFORE the
    // password result is trusted. Everybody else gets the SAME uniform 401 a
    // wrong password gets, after paying the same scrypt cost against their own
    // hash — so neither the status, the body nor the timing says whether the
    // password was right, and the account is no oracle for who is break-glass.
    // The lockout counter is left exactly as it was: a refused login neither
    // resets it (which would let a correct guess wipe a brute-force trail) nor
    // advances it (password sign-in is closed to this account anyway).
    if (!localSignInAllowed(org, user)) {
      verifyPassword(body.password, user.passwordHash); // same cost, result unused
      await auditAuth(db, null, user.id, "local-sign-in-refused", "deny",
        `password sign-in refused for '${user.email}': local sign-in is break-glass only and this account is not a designated break-glass admin`,
        { phase: "login", email: user.email, method: "password", localSignIn: org.localSignIn, identifierKind: kind });
      return reply.status(401).send(UNIFORM_LOGIN_401);
    }
    if (!verifyPassword(body.password, user.passwordHash)) {
      return fail(user.passwordHash ? "wrong_password" : "no_password_set");
    }

    // success: reset lockout state
    await db
      .update(users)
      .set({ failedLoginCount: 0, lastFailedLoginAt: null, lockedUntil: null })
      .where(eq(users.id, user.id));

    if (user.totpEnabled) {
      // two-step: password accepted → short-lived pending-MFA token, no cookie
      const { token, tokenHash } = generateSessionToken();
      await db.delete(authMfaPending).where(eq(authMfaPending.userId, user.id));
      await db.insert(authMfaPending).values({
        tokenHash,
        userId: user.id,
        expiresAt: new Date(now.getTime() + MFA_PENDING_MINUTES * 60_000),
      });
      return reply.send({ mfaRequired: true, pendingToken: token });
    }

    // ADR-0028: password credential -> 'password' origin
    await setSession(reply, req, user.id, org, "password");
    await auditAuth(db, user.id, user.id, "login-succeeded", "allow",
      `user '${user.email}' signed in with a password (by ${kind})`,
      { phase: "login", email: user.email, method: "password", identifierKind: kind });
    return reply.send({
      ok: true,
      userId: user.id,
      isAdmin: user.isAdmin,
      mustChangePassword: user.mustChangePassword,
    });
  });

  // ---- POST /auth/mfa/verify ----------------------------------------------
  app.post("/auth/mfa/verify", async (req, reply) => {
    if (!requireCsrfHeader(req, reply)) return reply;
    const body = mfaVerifySchema.parse(req.body);
    const org = await loadOrgSettings(db);
    // ADR-0039: the second login step is still session CREATION — the policy
    // may have tightened between the password step and this one, and a
    // pending-MFA token must not be a side door around the envelope.
    if (await refuseIpBlocked(req, reply, org, "session_ip_policy", { method: "password+totp" })) {
      return reply;
    }
    const now = new Date();
    // ADR-0174 (finding 1): a SAML login that stepped up to TOTP carries its
    // pending token in an HttpOnly cookie (the ACS answered with a redirect, so
    // there was no JSON body to hand it over in); a password login still sends
    // it in the body.
    const cookieToken = readCookie(req.headers.cookie, MFA_PENDING_COOKIE);
    const presented = body.pendingToken ?? cookieToken;
    if (!presented) return reply.status(401).send({ error: "invalid_or_expired_pending_token" });
    const [pending] = await db
      .select()
      .from(authMfaPending)
      .where(and(eq(authMfaPending.tokenHash, hashToken(presented)), gt(authMfaPending.expiresAt, now)));
    if (!pending) return reply.status(401).send({ error: "invalid_or_expired_pending_token" });
    const [user] = await db.select().from(users).where(eq(users.id, pending.userId));
    if (!user || user.disabledAt || !user.totpEnabled || !user.totpSecretCiphertext || !opts.dataKey) {
      return reply.status(401).send({ error: "invalid_or_expired_pending_token" });
    }
    // a password login's second step answers to the break-glass mode as it is
    // NOW — it may have tightened since the password step
    if (pending.origin === "password" && !localSignInAllowed(org, user)) {
      await db.delete(authMfaPending).where(eq(authMfaPending.id, pending.id));
      return reply.status(401).send({ error: "invalid_or_expired_pending_token" });
    }
    const secret = decryptSecret(opts.dataKey, user.totpSecretCiphertext);
    const step = verifyTotp(secret, body.code, user.totpLastUsedStep);
    if (step === null) {
      await auditAuth(db, null, user.id, "mfa-code-rejected", "deny",
        `user '${user.email}' presented an invalid or replayed TOTP code`,
        { phase: "mfa-verify", email: user.email });
      return reply.status(401).send({ error: "invalid_code" });
    }
    // consume: the pending token is single-use, the step is burned forever
    await db.delete(authMfaPending).where(eq(authMfaPending.id, pending.id));
    await db.update(users).set({ totpLastUsedStep: step }).where(eq(users.id, user.id));
    // ADR-0028: the second factor does not change WHICH credential established
    // the session — a MFA-completed login is still 'password' origin, and a
    // SAML login that stepped up to TOTP is still 'saml' (ADR-0174).
    if (cookieToken) void reply.header("set-cookie", mfaPendingCookie("", requestIsSecure(req), 0));
    if (pending.origin === "saml") {
      await setSession(reply, req, user.id, org, "saml");
      await auditAuth(db, user.id, user.id, "login-succeeded", "allow",
        `user '${user.email}' signed in via SAML + TOTP step-up`,
        { phase: "login", email: user.email, method: "saml", mfa: "totp-step-up", providerId: pending.samlProviderId });
    } else {
      await setSession(reply, req, user.id, org, "password");
      await auditAuth(db, user.id, user.id, "login-succeeded", "allow",
        `user '${user.email}' signed in with password + TOTP`,
        { phase: "login", email: user.email, method: "password+totp" });
    }
    return reply.send({
      ok: true,
      userId: user.id,
      isAdmin: user.isAdmin,
      mustChangePassword: user.mustChangePassword,
    });
  });

  // ---- POST /auth/login-with-key (transition fallback) ---------------------
  // Exchanges an API key (or the bootstrap token) for the SAME session cookie,
  // so even key-first users get cookie semantics in the browser and the key
  // never has to live in web storage. The key remains the credential for
  // programmatic/IDE access — this endpoint only wraps it for browsers.
  app.post("/auth/login-with-key", async (req, reply) => {
    if (!requireCsrfHeader(req, reply)) return reply;
    const body = loginWithKeySchema.parse(req.body);
    const ctx = await authenticate(db, opts.bootstrapToken, `Bearer ${body.apiKey}`);
    if (ctx === "disabled") {
      return reply.status(401).send({
        error: "user_disabled",
        detail: "this account has been deactivated — an admin can reactivate it",
      });
    }
    // ADR-0066: a revoked or expired virtual key is refused here for the same
    // reason it is refused everywhere else, and says which. ADR-0098 extends
    // the same courtesy to the API-key pair — this exchange runs through the
    // very same `authenticate()`, so an expired key cannot buy a session here
    // that it could not buy anywhere else.
    if (isAuthRefusal(ctx)) {
      return reply.status(401).send({ error: ctx, detail: AUTH_REFUSAL_DETAIL[ctx] });
    }
    if (!ctx) return reply.status(401).send({ error: "invalid_key" });
    // ADR-0066 — THE ESCALATION THIS ENDPOINT WOULD OTHERWISE BE. A virtual key
    // is a NARROWED credential: not admin, budgeted, and confined to the
    // dispatch surfaces. A browser session is the OWNER'S FULL IDENTITY. If
    // this exchange accepted one, every restriction on the key would evaporate
    // in a single POST — so it refuses, by kind, before anything else happens.
    if (ctx.via === "virtual-key") {
      return reply.status(403).send({
        error: "virtual_key_not_exchangeable",
        detail:
          "a virtual key is a scoped, budgeted dispatch credential and cannot be exchanged for a browser session — that would hand back the full identity the key exists to narrow",
      });
    }
    const org = await loadOrgSettings(db);
    // ADR-0181 (FX2): an un-enrolled owner's key buys no session either — an
    // exchanged session may reach the TOTP self-service routes, which would
    // let whoever holds the key enrol their own authenticator.
    if (apiKeyMfaEnrollmentRequired(org, ctx)) {
      await auditAuth(db, null, ctx.userId, "api-key-mfa-enrollment-required", "deny",
        "API-key browser sign-in refused: the org requires MFA for this account and its owner has not enrolled TOTP",
        { phase: "login", method: "api-key-exchange", mfaRequired: org.mfaRequired, apiKeyId: ctx.apiKeyId ?? null });
      return reply.status(403).send(API_KEY_MFA_REFUSAL);
    }
    // ADR-0174 (finding 9): in break-glass mode a browser session from an API
    // key is a local sign-in like any other — only a designated break-glass
    // admin may have one. Everybody else gets the same answer as an unknown
    // key; the key itself keeps working for programmatic use. The bootstrap
    // exchange (no user) is the operator's own break-glass path, unchanged.
    if (ctx.via === "api-key" && ctx.userId && org.localSignIn === "break_glass_only") {
      if (!localSignInAllowed(org, { id: ctx.userId, isAdmin: ctx.isAdmin })) {
        await auditAuth(db, null, ctx.userId, "local-sign-in-refused", "deny",
          "API-key browser sign-in refused: local sign-in is break-glass only and this account is not a designated break-glass admin",
          { phase: "login", method: "api-key-exchange", localSignIn: org.localSignIn });
        return reply.status(401).send({ error: "invalid_key" });
      }
    }
    // ADR-0039: an exchanged API-key session is the AUTOMATION path — governed
    // by api_key_ip_policy, never by the human knob. The bootstrap exchange is
    // the break-glass path and is never IP-restricted.
    if (
      ctx.via === "api-key" &&
      (await refuseIpBlocked(req, reply, org, "api_key_ip_policy", {
        method: "api-key-exchange",
        userId: ctx.userId,
      }))
    ) {
      return reply;
    }
    // ADR-0028: the deploy-time bootstrap token and a user's API key are two
    // different credentials and get two different origins — only 'api_key'
    // (a real user identity) can ever open the current-password bypass.
    await setSession(reply, req, ctx.userId, org, ctx.via === "bootstrap" ? "bootstrap" : "api_key");
    await auditAuth(db, ctx.userId, ctx.userId, "login-succeeded", "allow",
      ctx.userId ? "user exchanged an API key for a browser session" : "operator exchanged the bootstrap token for a browser session",
      { phase: "login", method: ctx.via === "bootstrap" ? "bootstrap-exchange" : "api-key-exchange" });
    return reply.send({ ok: true, userId: ctx.userId, isAdmin: ctx.isAdmin });
  });

  // ---- POST /auth/logout ---------------------------------------------------
  // Deliberately auth-exempt: an expired or already-revoked session can still
  // "log out" (idempotent). Reads the cookie itself; CSRF header required
  // like every state-changing cookie request.
  app.post("/auth/logout", async (req, reply) => {
    if (!requireCsrfHeader(req, reply)) return reply;
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (token) {
      await db
        .update(authSessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(authSessions.tokenHash, hashToken(token)), isNull(authSessions.revokedAt)));
    }
    void reply.header("set-cookie", clearSessionCookie(requestIsSecure(req)));
    return { ok: true };
  });

  // ---- GET /auth/me --------------------------------------------------------
  // Runs under the normal auth hook (session, API key or bootstrap): the UI's
  // "who am I / what must I do next" probe.
  app.get("/auth/me", async (req) => {
    const userId = req.authCtx.userId;
    let user = null;
    let mustChangePassword = false;
    let totpEnabled = false;
    let passwordSet = false;
    // ADR-0028: the UI must never infer this — it is the SAME function the
    // change-password handler enforces with, evaluated on the same inputs.
    let requiresCurrent = true;
    if (userId) {
      const [row] = await db.select().from(users).where(eq(users.id, userId));
      if (row) {
        // ADR-0030: a user may ALWAYS see their own username (reading it is
        // never gated); org.usernameSelfService governs writes only.
        user = { id: row.id, email: row.email, username: row.username, displayName: row.displayName };
        mustChangePassword = row.mustChangePassword;
        totpEnabled = row.totpEnabled;
        passwordSet = row.passwordHash !== null;
        requiresCurrent = passwordChangeRequiresCurrent(req.sessionAuth?.origin, row);
      }
    }
    const org = await loadOrgSettings(db);
    const mfaSetupRequired =
      userId !== null &&
      !totpEnabled &&
      (org.mfaRequired === "all" || (org.mfaRequired === "admins" && req.authCtx.isAdmin));
    return {
      userId,
      isAdmin: req.authCtx.isAdmin,
      via: req.authCtx.via,
      user,
      mustChangePassword,
      totpEnabled,
      passwordSet,
      mfaSetupRequired,
      /** ADR-0028: false = this caller may set a password WITHOUT proving the
       * current one (api_key-origin session on a recovery-state account); the
       * forced-change gate hides the field. Fail-closed default is true. */
      passwordChangeRequiresCurrent: requiresCurrent,
      /** the recorded origin of THIS session ('unknown' = pre-0046 row); null
       * when the request authenticated with a header credential */
      sessionOrigin: req.sessionAuth?.origin ?? null,
      /** ADR-0030: may THIS caller write their own username? false (the
       * default org posture) = admin-managed; the UI shows the value
       * read-only rather than offering an edit that would 403. */
      usernameSelfService: org.usernameSelfService,
    };
  });

  // ---- POST /auth/change-password -----------------------------------------
  app.post("/auth/change-password", async (req, reply) => {
    const body = changePasswordSchema.parse(req.body);
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "no_user_identity" });
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) return reply.status(404).send({ error: "unknown_user" });
    // ADR-0028: ONE rule, shared with /auth/me. The current password is
    // required unless this session was established with an API KEY and the
    // account is in a recovery state (must-change, or no password at all).
    const origin = req.sessionAuth?.origin;
    const requiresCurrent = passwordChangeRequiresCurrent(origin, user);
    if (requiresCurrent) {
      if (!user.passwordHash) {
        return reply.status(409).send({
          error: "no_password_set",
          detail: "this account has no password yet — an admin must set an initial one-time password",
        });
      }
      if (body.currentPassword === undefined) {
        // burn the same scrypt cost as a wrong password so the two are
        // indistinguishable by timing
        verifyPassword("", null);
        await auditAuth(db, userId, userId, "password-change-rejected", "deny",
          `user '${user.email}' omitted the current password on a change attempt that requires it`,
          { phase: "change-password", email: user.email, why: "current_password_required", sessionOrigin: origin ?? null });
        return reply.status(401).send({
          error: "current_password_required",
          detail: "this account's current password must be supplied to set a new one",
        });
      }
      if (!verifyPassword(body.currentPassword, user.passwordHash)) {
        await auditAuth(db, userId, userId, "password-change-rejected", "deny",
          `user '${user.email}' failed the current-password check on a change attempt`,
          { phase: "change-password", email: user.email });
        return reply.status(401).send({ error: "current_password_incorrect" });
      }
    }
    const org = await loadOrgSettings(db);
    const policyError = checkPasswordPolicy(body.newPassword, org.passwordMinLength, org.passwordRequireClasses);
    if (policyError) return reply.status(422).send({ error: "password_policy", detail: policyError });
    if (body.currentPassword !== undefined && body.newPassword === body.currentPassword) {
      return reply.status(422).send({ error: "password_policy", detail: "the new password must differ from the current one" });
    }
    await db
      .update(users)
      .set({ passwordHash: hashPassword(body.newPassword), passwordUpdatedAt: new Date(), mustChangePassword: false })
      .where(eq(users.id, userId));
    // revoke every OTHER session — a stolen session dies with the password.
    // (When the caller authenticated with an API key there is no current
    // session, so ALL of the user's sessions are revoked.)
    const keepId = req.sessionAuth?.sessionId ?? null;
    await db
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(authSessions.userId, userId),
          isNull(authSessions.revokedAt),
          ...(keepId ? [ne(authSessions.id, keepId)] : []),
        ),
      );
    if (requiresCurrent) {
      await auditAuth(db, userId, userId, "password-changed", "allow",
        `user '${user.email}' changed their password (other sessions revoked)`,
        { phase: "change-password", email: user.email });
    } else {
      // ADR-0028: the bypass is NEVER invisible — it gets its own rule id and
      // records the origin plus which recovery condition opened it.
      const recovery = recoveryReason(user);
      await auditAuth(db, userId, userId, "password-set-via-key-session", "allow",
        `user '${user.email}' set a password from an API-key session without the current password (${recovery === "no_password_hash" ? "account had no password" : "account was on a one-time password"}); other sessions revoked`,
        {
          phase: "change-password",
          email: user.email,
          sessionOrigin: origin ?? null,
          recoveryCondition: recovery,
          currentPasswordRequired: false,
        });
    }
    return { ok: true };
  });

  // ---- TOTP self-service ---------------------------------------------------
  app.post("/auth/totp/enroll", async (req, reply) => {
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "no_user_identity" });
    if (!opts.dataKey) {
      return reply.status(409).send({
        error: "data_key_required",
        detail: "TOTP secrets are stored encrypted — set REGULAIT_DATA_KEY on the gateway first",
      });
    }
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) return reply.status(404).send({ error: "unknown_user" });
    if (user.totpEnabled) return reply.status(409).send({ error: "totp_already_enabled" });
    const secret = generateTotpSecret();
    await db
      .update(users)
      .set({ totpSecretCiphertext: encryptSecret(opts.dataKey, secret), totpEnabled: false, totpLastUsedStep: null })
      .where(eq(users.id, userId));
    // the secret + URI are shown exactly ONCE, like every secret in the product
    return { secret, otpauthUri: otpauthUri(user.email, secret) };
  });

  app.post("/auth/totp/activate", async (req, reply) => {
    const body = totpActivateSchema.parse(req.body);
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "no_user_identity" });
    if (!opts.dataKey) return reply.status(409).send({ error: "data_key_required" });
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user?.totpSecretCiphertext) return reply.status(409).send({ error: "not_enrolled" });
    if (user.totpEnabled) return reply.status(409).send({ error: "totp_already_enabled" });
    const secret = decryptSecret(opts.dataKey, user.totpSecretCiphertext);
    const step = verifyTotp(secret, body.code, user.totpLastUsedStep);
    if (step === null) return reply.status(401).send({ error: "invalid_code" });
    await db.update(users).set({ totpEnabled: true, totpLastUsedStep: step }).where(eq(users.id, userId));
    await auditAuth(db, userId, userId, "mfa-enabled", "allow",
      `user '${user.email}' enabled TOTP MFA`,
      { phase: "mfa-enabled", email: user.email });
    return { ok: true, totpEnabled: true };
  });

  app.post("/auth/totp/disable", async (req, reply) => {
    const body = totpDisableSchema.parse(req.body);
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "no_user_identity" });
    if (!opts.dataKey) return reply.status(409).send({ error: "data_key_required" });
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user?.totpEnabled || !user.totpSecretCiphertext) {
      return reply.status(409).send({ error: "totp_not_enabled" });
    }
    // disabling MFA re-proves BOTH factors
    if (!verifyPassword(body.password, user.passwordHash)) {
      return reply.status(401).send({ error: "invalid_password_or_code" });
    }
    const secret = decryptSecret(opts.dataKey, user.totpSecretCiphertext);
    const step = verifyTotp(secret, body.code, user.totpLastUsedStep);
    if (step === null) return reply.status(401).send({ error: "invalid_password_or_code" });
    await db
      .update(users)
      .set({ totpEnabled: false, totpSecretCiphertext: null, totpLastUsedStep: null })
      .where(eq(users.id, userId));
    await auditAuth(db, userId, userId, "mfa-disabled", "allow",
      `user '${user.email}' disabled TOTP MFA (password + code re-proven)`,
      { phase: "mfa-disabled", email: user.email });
    return { ok: true, totpEnabled: false };
  });

  // ---- admin: initial one-time password + MFA recovery ---------------------
  // Both admin-only via app.ts's default gate (absent from NON_ADMIN_ROUTES).

  const userIdParam = z.object({ userId: z.string().uuid() });

  app.post("/v1/users/:userId/set-initial-password", async (req, reply) => {
    const { userId } = userIdParam.parse(req.params);
    const body = setInitialPasswordSchema.parse(req.body ?? {});
    const [target] = await db.select().from(users).where(eq(users.id, userId));
    if (!target) return reply.status(404).send({ error: "unknown_user" });
    if (target.disabledAt) {
      return reply.status(409).send({
        error: "user_disabled",
        detail: "this account is deactivated — reactivate it before issuing a password",
      });
    }
    if (target.passwordHash && !body.force) {
      return reply.status(409).send({
        error: "password_already_set",
        detail: "this user already has a password — pass force:true to overwrite it (audited reset)",
      });
    }
    // generated server-side: 18 random bytes -> 24 url-safe chars, always
    // passes any policy up to length 24 / 3 classes
    const password = "Rg1-" + randomBytes(18).toString("base64url");
    await db
      .update(users)
      .set({
        passwordHash: hashPassword(password),
        passwordUpdatedAt: new Date(),
        mustChangePassword: true,
        failedLoginCount: 0,
        lockedUntil: null,
      })
      .where(eq(users.id, userId));
    // a password reset kills every live session for the account
    await db
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));
    await auditAuth(db, req.authCtx.userId, userId,
      target.passwordHash ? "password-reset-by-admin" : "initial-password-set", "allow",
      `admin ${target.passwordHash ? "reset" : "set an initial"} one-time password for '${target.email}' (must change on first use)`,
      { phase: "set-initial-password", email: target.email, forced: Boolean(body.force) });
    // the plaintext is returned exactly once and never stored
    return { password, mustChangePassword: true };
  });

  app.post("/v1/users/:userId/mfa/clear", async (req, reply) => {
    const { userId } = userIdParam.parse(req.params);
    const body = clearMfaSchema.parse(req.body);
    const [target] = await db.select().from(users).where(eq(users.id, userId));
    if (!target) return reply.status(404).send({ error: "unknown_user" });
    if (!target.totpEnabled && !target.totpSecretCiphertext) {
      return reply.status(409).send({ error: "totp_not_enabled" });
    }
    await db
      .update(users)
      .set({ totpEnabled: false, totpSecretCiphertext: null, totpLastUsedStep: null })
      .where(eq(users.id, userId));
    await db.delete(authMfaPending).where(eq(authMfaPending.userId, userId));
    await auditAuth(db, req.authCtx.userId, userId, "mfa-cleared-by-admin", "allow",
      `admin cleared TOTP MFA for locked-out user '${target.email}': ${body.reason}`,
      { phase: "mfa-cleared", email: target.email, reason: body.reason });
    return { ok: true, totpEnabled: false };
  });

  // ---- ADR-0030: username management --------------------------------------
  // ONE writer for both surfaces (admin route + self-service route): same
  // validator, same uniqueness check, same audit shape. The only difference is
  // WHO may call it and how much a 409 is allowed to say.

  /** a unique-index violation racing our pre-check (two admins, same second) */
  const isUniqueViolation = (err: unknown): boolean =>
    (err as { cause?: { code?: string } })?.cause?.code === "23505";

  const applyUsername = async (
    reply: FastifyReply,
    actorUserId: string | null,
    targetUserId: string,
    /** already normalized+validated by usernameSchema; null CLEARS it */
    next: string | null,
    via: "admin" | "self",
  ) => {
    const [target] = await db.select().from(users).where(eq(users.id, targetUserId));
    if (!target) return reply.status(404).send({ error: "unknown_user" });
    const before = target.username;
    /** a 409 must NAME the conflict for an admin (who can act on it) and must
     * NOT name the holder to a self-service caller (that would turn this route
     * into a directory of who owns which username). */
    const conflict = (username: string, holderEmail: string, holderId: string) =>
      reply.status(409).send({
        error: "username_taken",
        detail:
          via === "admin"
            ? `username '${username}' already belongs to ${holderEmail}`
            : `username '${username}' is already taken`,
        username,
        ...(via === "admin" ? { conflictUserId: holderId } : {}),
      });
    if (next !== null) {
      const [clash] = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(and(eq(users.username, next), ne(users.id, targetUserId)));
      if (clash) return conflict(next, clash.email, clash.id);
    }
    try {
      await db.update(users).set({ username: next }).where(eq(users.id, targetUserId));
    } catch (err) {
      // the pre-check lost a race with a concurrent write — still a clean 409,
      // never a raw constraint error escaping as a 500/opaque "conflict"
      if (next !== null && isUniqueViolation(err)) {
        const [clash] = await db
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(and(eq(users.username, next), ne(users.id, targetUserId)));
        return conflict(next, clash?.email ?? "another account", clash?.id ?? "");
      }
      throw err;
    }
    const ruleId = next === null ? "username-cleared" : before === null ? "username-set" : "username-changed";
    const actorWord = via === "admin" ? "admin" : "user";
    await auditAuth(db, actorUserId, targetUserId, ruleId, "allow",
      next === null
        ? `${actorWord} cleared the username '${before}' on '${target.email}'`
        : before === null
          ? `${actorWord} set the username '${next}' on '${target.email}'`
          : `${actorWord} changed the username on '${target.email}': '${before}' → '${next}'`,
      { phase: "username", email: target.email, from: before, to: next, via });
    return reply.send({ id: target.id, username: next, previousUsername: before });
  };

  /** admin: set / change / clear ANY user's username. Admin-only via app.ts's
   * default gate (absent from NON_ADMIN_ROUTES), exactly like the rest of the
   * users admin surface. */
  app.put("/v1/users/:userId/username", async (req, reply) => {
    const { userId } = userIdParam.parse(req.params);
    const body = setUsernameSchema.parse(req.body ?? {});
    return applyUsername(reply, req.authCtx.userId, userId, body.username, "admin");
  });

  /** self-service: a user manages their OWN username — only when the org has
   * opted in (org_settings.username_self_service, default false = admin-managed
   * only). READING one's own username is never gated; /auth/me always carries
   * it. The org is the ceiling here exactly as everywhere else. */
  app.post("/auth/username", async (req, reply) => {
    if (!requireCsrfHeader(req, reply)) return reply;
    const body = setUsernameSchema.parse(req.body ?? {});
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "no_user_identity" });
    const org = await loadOrgSettings(db);
    if (!org.usernameSelfService) {
      await auditAuth(db, userId, userId, "username-self-service-denied", "deny",
        "user attempted to change their own username while self-service is disabled",
        { phase: "username", requested: body.username, via: "self" });
      return reply.status(403).send({
        error: "username_self_service_disabled",
        detail: "usernames are managed by an administrator in this organization",
      });
    }
    return applyUsername(reply, userId, userId, body.username, "self");
  });

  // ---- OIDC SSO ------------------------------------------------------------

  const providerParam = z.object({ providerId: z.string().uuid() });
  const publicProvider = (p: typeof oidcProviders.$inferSelect) => ({
    id: p.id,
    name: p.name,
    issuerUrl: p.issuerUrl,
    clientId: p.clientId,
    enabled: p.enabled,
    allowedEmailDomains: p.allowedEmailDomains,
    defaultRoleId: p.defaultRoleId,
    jitProvisioning: p.jitProvisioning,
    /** ADR-0038: null = this provider emits no group signal, so its logins
     * never reconcile group-derived roles. */
    groupsClaim: p.groupsClaim,
    /** ADR-0174: non-null = a broker; each entry is a "Continue with …" button */
    brokerIdps: p.brokerIdps,
    mfaAcrValues: p.mfaAcrValues,
    brokerEnforcesMfa: p.brokerEnforcesMfa,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    // client_secret_ciphertext deliberately absent: secrets are WRITE-ONLY
  });

  /** ADR-0043: one issuer-URL egress decision against the SAME default-deny
   * `egress_allow_hosts` table every other guarded surface uses. An OIDC
   * issuer is configured once, by an admin, at setup — one allow entry is a
   * one-time act, not per-call friction — so the ordinary allow-list posture
   * applies (NOT the MCP private-ranges-open default). */
  const oidcIssuerDecision = async (issuerUrl: string) => {
    const allowList = await loadEgressAllowList(db);
    const decision = await checkEgress(issuerUrl, { allowList });
    return { decision, allowList };
  };

  /** discovery against the provider's issuer — now THROUGH the egress guard
   * (ADR-0043). The issuer is re-validated on every discovery (a write-time
   * verdict is not a fact about the future, and rows written before this
   * guard existed are in the live database right now), and the discovery +
   * token + JWKS fetches all ride `createGuardedFetch`, so they inherit the
   * ADR-0034 pinned transport and redirect refusal. `allowInsecureRequests`
   * for an http:// issuer is no longer free: checkEgress only passes plaintext
   * http when the issuer host's allow entry set allowPlaintextHttp, so the
   * insecure opt-in is a per-host admin decision, not a side effect of typing
   * 'http://'. A refusal throws OidcEgressBlockedError with nothing leaving
   * the box, audited. */
  const oidcConfigFor = async (provider: typeof oidcProviders.$inferSelect) => {
    if (!opts.dataKey) throw new Error("REGULAIT_DATA_KEY required for OIDC");
    const { decision, allowList } = await oidcIssuerDecision(provider.issuerUrl);
    if (!decision.ok) {
      await auditAuth(db, null, provider.id, "oidc-egress-blocked", "deny",
        `OIDC discovery refused for provider '${provider.name}': ${decision.reason}`,
        { phase: "oidc-discovery", provider: provider.name, issuerUrl: provider.issuerUrl, code: decision.code },
        "oidc_provider");
      throw new OidcEgressBlockedError(decision);
    }
    const secret = decryptSecret(opts.dataKey, provider.clientSecretCiphertext);
    return oidc.discovery(new URL(provider.issuerUrl), provider.clientId, secret, undefined, {
      // the guarded fetch is assigned onto the resolved Configuration too, so
      // the token-endpoint and JWKS requests of the login flow are guarded —
      // not just the discovery document fetch
      [oidc.customFetch]: createGuardedFetch({ allowList }),
      // only reachable for http:// when the host's allow entry opted in —
      // checkEgress refused plaintext without allowPlaintextHttp above
      ...(decision.protocol === "http:" ? { execute: [oidc.allowInsecureRequests] } : {}),
    });
  };

  const baseUrlFor = (req: FastifyRequest): string => {
    const proto = requestIsSecure(req) ? "https" : "http";
    const host = req.headers.host ?? "localhost";
    return `${proto}://${host}`;
  };

  // enabled providers for the login screen — names only, no config. Exempt
  // from auth (the login page has no credential yet).
  app.get("/auth/oidc/providers", async () => {
    const rows = await db.select().from(oidcProviders).where(eq(oidcProviders.enabled, true));
    return { providers: rows.map((p) => ({ id: p.id, name: p.name })) };
  });

  // ADR-0174 — what the sign-in page should offer. PUBLIC (the page has no
  // credential yet) and deliberately free of configuration: provider ids and
  // display names (already public via /auth/oidc/providers and
  // /auth/saml/providers), which broker buttons exist, and whether the email
  // form is open. No issuer, client id, secret, domain list or user is named.
  app.get("/auth/sign-in-options", async () => {
    const org = await loadOrgSettings(db);
    const oidcRows = await db
      .select({ id: oidcProviders.id, name: oidcProviders.name, brokerIdps: oidcProviders.brokerIdps })
      .from(oidcProviders)
      .where(eq(oidcProviders.enabled, true))
      .orderBy(asc(oidcProviders.createdAt), asc(oidcProviders.id));
    const samlRows = await db
      .select({ id: samlProviders.id, name: samlProviders.name })
      .from(samlProviders)
      .where(eq(samlProviders.enabled, true))
      .orderBy(asc(samlProviders.createdAt), asc(samlProviders.id));
    const brokerRow = oidcRows.find((p) => (p.brokerIdps ?? []).length > 0) ?? null;
    const localMode = org.ssoOnly ? "sso_only" : org.localSignIn;
    return {
      broker: brokerRow
        ? {
            providerId: brokerRow.id,
            name: brokerRow.name,
            // canonical order, allow-listed values only
            idps: BROKER_IDP_VALUES.filter((v) => (brokerRow.brokerIdps ?? []).includes(v)),
          }
        : null,
      enterprise: [
        ...oidcRows
          .filter((p) => (p.brokerIdps ?? []).length === 0)
          .map((p) => ({ id: p.id, name: p.name, protocol: "oidc" as const })),
        ...samlRows.map((p) => ({ id: p.id, name: p.name, protocol: "saml" as const })),
      ],
      local: { mode: localMode, emailForm: localMode === "enabled" },
      // ADR-0174 (finding 9): break-glass mode closes the API-key exchange to
      // everyone but the break-glass admins, so the page stops offering it
      apiKeyExchange: org.localSignIn !== "break_glass_only",
    };
  });

  /** step 1, shared by /start and ADR-0174's broker-hinted /login: redirect to
   * the IdP with state + nonce + PKCE (all server-side). */
  const beginOidcLogin = async (
    req: FastifyRequest,
    reply: FastifyReply,
    providerId: string,
    returnTo: "/app" | "/admin" | undefined,
    idpHint: string | null,
  ) => {
    const [provider] = await db
      .select()
      .from(oidcProviders)
      .where(and(eq(oidcProviders.id, providerId), eq(oidcProviders.enabled, true)));
    if (!provider) return reply.status(404).send({ error: "unknown_provider" });
    // ADR-0174: an IdP hint is honoured only when THIS provider is a broker
    // that offers it — the allow-list is the provider's own configuration.
    if (idpHint !== null && !(provider.brokerIdps ?? []).includes(idpHint)) {
      await auditAuth(db, null, provider.id, "oidc-idp-hint-refused", "deny",
        `OIDC sign-in refused: provider '${provider.name}' does not offer the identity provider '${idpHint}'`,
        { phase: "oidc-start", provider: provider.name, idp: idpHint, offered: provider.brokerIdps ?? [] },
        "oidc_provider");
      return reply.status(400).send({
        error: "idp_not_offered",
        detail: "this sign-in provider does not offer that identity provider",
      });
    }
    if (!opts.dataKey) return reply.status(409).send({ error: "data_key_required" });
    let config: oidc.Configuration;
    try {
      config = await oidcConfigFor(provider);
    } catch (err) {
      // ADR-0043: a guard refusal is a governance decision with a reason an
      // operator needs, not a 500 — already audited inside oidcConfigFor.
      if (err instanceof OidcEgressBlockedError) {
        return reply.status(403).send({
          error: "egress_blocked",
          code: err.decision.code,
          detail: err.decision.reason,
        });
      }
      throw err;
    }
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const redirectUri = `${baseUrlFor(req)}/auth/oidc/callback`;
    await db.insert(oidcLoginStates).values({
      providerId,
      state,
      nonce,
      codeVerifier,
      redirectUri,
      returnTo: returnTo ?? "/app",
      expiresAt: new Date(Date.now() + OIDC_STATE_MINUTES * 60_000),
    });
    const authUrl = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      // ADR-0174: Keycloak skips its own chooser and goes straight to the
      // named upstream IdP. Only ever an allow-listed value (checked above).
      ...(idpHint !== null ? { kc_idp_hint: idpHint } : {}),
    });
    // ADR-0167 (AUTHZ-04): this login completes only in THIS browser
    void reply.header(
      "set-cookie",
      ssoBindingCookie(OIDC_BINDING_COOKIE, ssoBrowserBinding(opts.dataKey, state), {
        path: "/auth/oidc",
        secure: requestIsSecure(req),
        crossSite: false,
      }),
    );
    return reply.redirect(authUrl.href, 302);
  };

  const returnToQuery = z.object({ returnTo: z.enum(["/app", "/admin"]).optional() });

  app.get("/auth/oidc/:providerId/start", async (req, reply) => {
    const { providerId } = providerParam.parse(req.params);
    const { returnTo } = returnToQuery.parse(req.query);
    return beginOidcLogin(req, reply, providerId, returnTo, null);
  });

  // ADR-0174: broker-hinted sign-in ("Continue with Microsoft"). `idp` is
  // validated against the GLOBAL allow-list here and against the provider's
  // own broker list in beginOidcLogin; anything else is refused, audited.
  app.get("/auth/oidc/:providerId/login", async (req, reply) => {
    const { providerId } = providerParam.parse(req.params);
    const q = req.query as Record<string, unknown>;
    const { returnTo } = returnToQuery.parse({ returnTo: q.returnTo });
    const rawIdp = q.idp;
    if (rawIdp === undefined) return beginOidcLogin(req, reply, providerId, returnTo, null);
    // ADR-0174 (finding 11): the provider is looked up FIRST — an unknown id
    // is a plain 404 that writes nothing, so an unauthenticated caller cannot
    // fill the audit trail with provider ids of its own choosing.
    const [known] = await db
      .select({ id: oidcProviders.id })
      .from(oidcProviders)
      .where(and(eq(oidcProviders.id, providerId), eq(oidcProviders.enabled, true)));
    if (!known) return reply.status(404).send({ error: "unknown_provider" });
    if (typeof rawIdp !== "string" || !(BROKER_IDP_VALUES as readonly string[]).includes(rawIdp)) {
      await auditAuth(db, null, providerId, "oidc-idp-hint-refused", "deny",
        "OIDC sign-in refused: the requested identity provider is not on the broker allow-list",
        { phase: "oidc-start", idp: typeof rawIdp === "string" ? rawIdp.slice(0, 64) : null, allowed: [...BROKER_IDP_VALUES] },
        "oidc_provider");
      return reply.status(400).send({
        error: "unknown_idp",
        detail: `idp must be one of: ${BROKER_IDP_VALUES.join(", ")}`,
      });
    }
    return beginOidcLogin(req, reply, providerId, returnTo, rawIdp);
  });

  // step 2: the IdP redirects back — validate state, PKCE and nonce, map the
  // VERIFIED email claim, mint the SAME session cookie password login mints.
  app.get("/auth/oidc/callback", async (req, reply) => {
    const { state } = z.object({ state: z.string().min(1) }).parse(
      // tolerate extra params (code, session_state, etc.)
      { state: (req.query as Record<string, unknown>).state ?? "" },
    );
    const now = new Date();
    // single-use: claim-and-delete the state row atomically
    const claimed = await db
      .delete(oidcLoginStates)
      .where(and(eq(oidcLoginStates.state, state), gt(oidcLoginStates.expiresAt, now)))
      .returning();
    const login = claimed[0];
    if (!login) return reply.status(401).send({ error: "invalid_or_expired_state" });
    // ADR-0167 (AUTHZ-04): the row is claimed either way (single-use holds),
    // but it completes a login only in the browser that opened it. Refused
    // BEFORE the token exchange, so a planted callback costs the IdP nothing.
    const presentedBinding = readCookie(req.headers.cookie, OIDC_BINDING_COOKIE);
    if (!ssoBindingMatches(presentedBinding, ssoBrowserBinding(opts.dataKey, state))) {
      await auditAuth(db, null, null, "oidc-login-browser-mismatch", "deny",
        `OIDC callback refused: the login was started in a different browser (login CSRF) — state consumed, no session minted`,
        { phase: "oidc-callback", providerId: login.providerId, bindingCookiePresent: presentedBinding !== null },
        "oidc_provider");
      return reply.status(401).send({
        error: "login_not_bound_to_this_browser",
        detail: "this sign-in was started in a different browser session — start again from the login page",
      });
    }
    const [provider] = await db
      .select()
      .from(oidcProviders)
      .where(and(eq(oidcProviders.id, login.providerId), eq(oidcProviders.enabled, true)));
    if (!provider) return reply.status(401).send({ error: "unknown_provider" });
    let config: oidc.Configuration;
    try {
      config = await oidcConfigFor(provider);
    } catch (err) {
      // ADR-0043: same honest refusal on the callback leg — the issuer may
      // have been re-pointed, or its allow entry withdrawn, mid-login.
      if (err instanceof OidcEgressBlockedError) {
        return reply.status(403).send({
          error: "egress_blocked",
          code: err.decision.code,
          detail: err.decision.reason,
        });
      }
      throw err;
    }

    const currentUrl = new URL(login.redirectUri);
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    currentUrl.search = qs;

    let claims: oidc.IDToken;
    try {
      const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: login.codeVerifier,
        expectedState: state,
        expectedNonce: login.nonce,
        idTokenExpected: true,
      });
      const c = tokens.claims();
      if (!c) throw new Error("no id_token claims");
      claims = c;
    } catch (err) {
      await auditAuth(db, null, null, "oidc-login-failed", "deny",
        `OIDC token exchange/validation failed for provider '${provider.name}'`,
        { phase: "oidc-callback", provider: provider.name, error: err instanceof Error ? err.message : String(err) });
      return reply.status(401).send({ error: "oidc_validation_failed" });
    }

    // ADR-0174 (finding 7): ONE normalisation (NFKC, trimmed, case-folded)
    const normalized = normalizeClaimEmail(claims.email);
    const email = normalized?.email ?? null;
    const emailVerified = claims.email_verified === true;
    if (!normalized || !email || !emailVerified) {
      await auditAuth(db, null, null, "oidc-login-failed", "deny",
        `OIDC login refused: no verified email claim (provider '${provider.name}')`,
        { phase: "oidc-callback", provider: provider.name, sub: claims.sub, emailPresent: Boolean(email), emailVerified });
      return reply.status(403).send({ error: "email_not_verified" });
    }
    const domain = email.slice(email.indexOf("@") + 1);
    if (provider.allowedEmailDomains && !provider.allowedEmailDomains.includes(domain)) {
      await auditAuth(db, null, null, "oidc-domain-refused", "deny",
        `OIDC login refused: '${email}' is outside the provider's allowed domains`,
        { phase: "oidc-callback", provider: provider.name, email, domain });
      return reply.status(403).send({ error: "email_domain_not_allowed" });
    }

    // ADR-0174 §5: the linked (provider, issuer, subject) first, then the
    // verified email — READ-ONLY, so a refusal below writes nothing but its
    // audit row. The issuer is the token's own (validated) `iss`.
    const ref: ProviderRef = { kind: "oidc", id: provider.id, name: provider.name };
    const subject = String(claims.sub);
    const anchor: FederatedAnchor = {
      ref,
      issuer: typeof claims.iss === "string" ? claims.iss : provider.issuerUrl,
      subjectFormat: "",
      subject,
    };
    const resolution = await resolveFederatedLogin(db, anchor, normalized);
    if (resolution.kind === "not_linkable") {
      await auditAuth(db, null, null, "oidc-login-failed", "deny",
        `OIDC login refused: provider '${provider.name}' asserted an email outside plain ASCII, which is never matched to an account`,
        { phase: "oidc-callback", provider: provider.name, sub: subject, why: "email_not_linkable" });
      return federatedRefusal(req, reply, 403, "email_not_linkable",
        "This email address can't be used to sign in",
        "Your identity provider sent an email address with characters outside plain ASCII. Ask your administrator to link your account.");
    }
    let user = resolution.kind === "none" ? null : resolution.user;
    if (user?.disabledAt) {
      await auditAuth(db, null, user.id, "oidc-login-failed", "deny",
        `OIDC login refused: account '${email}' is deactivated`,
        { phase: "oidc-callback", provider: provider.name, email });
      return reply.status(401).send({
        error: "user_disabled",
        detail: "this account has been deactivated — an admin can reactivate it",
      });
    }
    // ADR-0174 §4: when the org requires MFA for this person, the IdP must
    // assert it (RFC 8176 amr — `mfa` or two factor classes, or one possession
    // factor from an MFA-enforcing broker — or a configured acr value).
    // A JIT-created user is never an admin, so 'admins' never applies to one.
    const mfa = idTokenMfa(claims as Record<string, unknown>, provider.mfaAcrValues ?? null, provider.brokerEnforcesMfa);
    const orgNow = await loadOrgSettings(db);
    if (orgRequiresMfa(orgNow, user?.isAdmin ?? false) && !mfa.asserted) {
      await auditAuth(db, null, user?.id ?? null, "oidc-mfa-not-asserted", "deny",
        `OIDC login refused: the organization requires MFA and provider '${provider.name}' did not assert it for '${email}'`,
        { phase: "oidc-callback", provider: provider.name, email, sub: subject, amr: mfa.amr, acr: mfa.acr, mfaRequired: orgNow.mfaRequired });
      return federatedRefusal(req, reply, 403, "mfa_required",
        "Multi-factor sign-in required",
        "Your organization requires multi-factor authentication, and your identity provider did not confirm a second factor for this sign-in. Sign in again and complete the code or passkey step, or ask your administrator to require MFA at the identity provider.");
    }
    if (resolution.kind === "proof") {
      // ADR-0174 §5: an account already in use is NEVER taken over on an
      // asserted email alone. The person proves it in this browser
      // (password, plus TOTP when enrolled) or an admin approves.
      const link = await raiseLinkRequest(db, anchor, email, resolution.user.id, mfa.asserted);
      await auditAuth(db, null, resolution.user.id, "federated-link-required", "deny",
        `OIDC identity from provider '${provider.name}' matched the existing account '${resolution.user.email}', which is already in use — link pending proof or admin approval, no session minted`,
        { phase: "oidc-callback", provider: provider.name, providerId: provider.id, providerKind: "oidc", email, sub: subject, why: resolution.why, linkRequestId: link.requestId, refreshed: link.refreshed });
      void reply.header("set-cookie", linkCookie(link.proofToken, requestIsSecure(req), LINK_PROOF_MINUTES * 60));
      return reply.redirect("/ui/login?link=pending", 302);
    }
    if (resolution.kind === "link") {
      // a never-used pre-provisioned account, or a pre-0139 SSO user signing
      // in again through the provider they already used (the backfill)
      await recordFederatedLink(db, anchor, resolution.user.id, resolution.via);
      await auditAuth(db, null, resolution.user.id, "federated-identity-linked", "allow",
        resolution.via === "prior_sso"
          ? `OIDC identity from provider '${provider.name}' linked to '${resolution.user.email}', who signed in through this provider before migration 0139 (backfill)`
          : `OIDC identity from provider '${provider.name}' linked to the pre-provisioned account '${resolution.user.email}' (never signed in, no local credential)`,
        { phase: "oidc-callback", provider: provider.name, providerId: provider.id, providerKind: "oidc", email, sub: subject, issuer: anchor.issuer, linkedVia: resolution.via });
    } else if (resolution.kind === "linked") {
      await touchFederatedLink(db, anchor);
    }
    if (!user) {
      // DEFAULT-DENY: an unknown subject is refused unless the admin opted
      // this provider into JIT provisioning.
      if (!provider.jitProvisioning) {
        await auditAuth(db, null, null, "oidc-unknown-subject", "deny",
          `OIDC login refused: no account for '${email}' and JIT provisioning is off for provider '${provider.name}'`,
          { phase: "oidc-callback", provider: provider.name, email, sub: claims.sub });
        return reply.status(403).send({ error: "unknown_user", detail: "no account exists for this identity" });
      }
      const displayName =
        typeof claims.name === "string" && claims.name.trim().length > 0
          ? claims.name.trim()
          : email.slice(0, email.indexOf("@"));
      // JIT users are NEVER admins; the provider's default role is their baseline
      const [created] = await db
        .insert(users)
        .values({ email, displayName, isAdmin: false })
        .returning();
      user = created!;
      if (provider.defaultRoleId) {
        await db
          .insert(roleAssignments)
          .values({ userId: user.id, roleId: provider.defaultRoleId })
          .onConflictDoNothing();
      }
      await auditAuth(db, null, user.id, "oidc-user-provisioned", "allow",
        `user '${email}' JIT-provisioned via OIDC provider '${provider.name}'${provider.defaultRoleId ? " with the provider's default role" : ""} (never admin)`,
        { phase: "oidc-jit", provider: provider.name, email, sub: claims.sub, defaultRoleId: provider.defaultRoleId });
      await recordFederatedLink(db, anchor, user.id, "jit");
    }

    // ADR-0038 — group → role reconciliation from the id_token's groups claim.
    //
    // THE FAIL-SAFE, spelled out because getting it wrong is a mass access
    // strip: `provider.groupsClaim` null means this provider emits no group
    // signal at all; a claim that is CONFIGURED but ABSENT from this id_token is
    // also "no signal" (an IdP hiccup or a renamed claim must not read as "in
    // zero groups"). Both leave existing group-derived roles exactly as they
    // are. A claim that is PRESENT — including an empty array — is
    // authoritative, and an empty one reconciles the user to zero group-derived
    // roles. `normalizeAssertedGroups` returns null for the first case and an
    // array for the second, so the distinction is a type at the boundary rather
    // than a convention.
    if (provider.groupsClaim) {
      const asserted = normalizeAssertedGroups(
        (claims as Record<string, unknown>)[provider.groupsClaim],
      );
      await reconcileGroupRoles(db, user.id, "oidc", asserted, {
        kind: "oidc-login",
        actor: `oidc provider '${provider.name}'`,
        actorUserId: user.id,
        detail: { providerId: provider.id, provider: provider.name, groupsClaim: provider.groupsClaim, sub: claims.sub },
      });
    }

    const org = await loadOrgSettings(db);
    // ADR-0039: SSO is a human login — the identity provider vouching for the
    // user does not move the request inside the org's network envelope.
    if (
      await refuseIpBlocked(req, reply, org, "session_ip_policy", {
        method: "oidc",
        userId: user.id,
        email,
        provider: provider.name,
      })
    ) {
      return reply;
    }
    await setSession(reply, req, user.id, org, "oidc", { idpMfa: mfa.asserted }); // ADR-0028, ADR-0174
    await auditAuth(db, user.id, user.id, "login-succeeded", "allow",
      `user '${email}' signed in via OIDC provider '${provider.name}'`,
      // providerId marks this as a post-0139 row: never backfill evidence
      { phase: "login", email, method: "oidc", provider: provider.name, providerId: provider.id, idpMfa: mfa.asserted, mfaVia: mfa.via });
    return reply.redirect(login.returnTo, 302);
  });

  // ---- ADR-0174 §5: proving an existing account to link a federated identity
  //
  // The proof cookie was set by the federated callback (OIDC or SAML) that
  // found an existing account with a local credential. It is HttpOnly, scoped
  // to /auth/link, short-lived, and stored only as a hash — and it names ONE
  // account: the person cannot pick a different one here.

  const linkProviderName = async (row: { oidcProviderId: string | null; samlProviderId: string | null }) => {
    if (row.oidcProviderId) {
      const [p] = await db.select({ name: oidcProviders.name }).from(oidcProviders).where(eq(oidcProviders.id, row.oidcProviderId));
      return p?.name ?? "single sign-on";
    }
    const [p] = await db.select({ name: samlProviders.name }).from(samlProviders).where(eq(samlProviders.id, row.samlProviderId!));
    return p?.name ?? "single sign-on";
  };

  app.get("/auth/link/pending", async (req, reply) => {
    const pending = await loadPendingProof(db, readCookie(req.headers.cookie, LINK_COOKIE));
    if (!pending) return reply.status(404).send({ error: "no_pending_link" });
    return {
      pending: true,
      provider: await linkProviderName(pending),
      protocol: pending.oidcProviderId ? "oidc" : "saml",
      // the address the identity provider itself asserted to this browser
      email: pending.email,
      expiresAt: pending.proofExpiresAt,
    };
  });

  /** one uniform answer for every failed proof — not an oracle for which of
   * password or code was wrong, nor for whether the account uses TOTP */
  const LINK_PROOF_401 = { error: "invalid_credentials", detail: "password or code is incorrect" };

  app.post("/auth/link/confirm", async (req, reply) => {
    if (!requireCsrfHeader(req, reply)) return reply;
    const body = linkConfirmSchema.parse(req.body);
    const pending = await loadPendingProof(db, readCookie(req.headers.cookie, LINK_COOKIE));
    if (!pending) return reply.status(401).send({ error: "no_pending_link", detail: "the link request expired — sign in with your identity provider again" });
    const org = await loadOrgSettings(db);
    const method = pending.oidcProviderId ? "oidc" : "saml";
    if (await refuseIpBlocked(req, reply, org, "session_ip_policy", { method: `${method}-link`, userId: pending.userId })) {
      return reply;
    }
    const [user] = await db.select().from(users).where(eq(users.id, pending.userId));
    const now = new Date();
    const providerName = await linkProviderName(pending);
    const failProof = async (why: string) => {
      if (user) await recordPasswordFailure(db, org, user, now, "email");
      await auditAuth(db, null, user?.id ?? null, "federated-link-proof-failed", "deny",
        `link proof failed for a federated identity from '${providerName}'`,
        { phase: "link-confirm", linkRequestId: pending.id, provider: providerName, why });
      return reply.status(401).send(LINK_PROOF_401);
    };
    if (!user || user.disabledAt) {
      verifyPassword(body.password, null);
      return failProof("user_unavailable");
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > now.getTime()) {
      verifyPassword(body.password, null);
      return failProof("locked_out");
    }
    if (!verifyPassword(body.password, user.passwordHash)) return failProof("wrong_password");
    let totpStepUsed: number | null = null;
    if (user.totpEnabled) {
      if (!body.code || !user.totpSecretCiphertext || !opts.dataKey) return failProof("code_missing");
      const step = verifyTotp(decryptSecret(opts.dataKey, user.totpSecretCiphertext), body.code, user.totpLastUsedStep);
      if (step === null) return failProof("wrong_code");
      totpStepUsed = step;
    }
    // ADR-0174 (finding 12): the identity-already-linked refusal comes BEFORE
    // the request is spent, so a refused confirm leaves it pending (an admin
    // can still see and deny it) instead of marking it `linked` with no link.
    const anchor = anchorOfRequest(pending, providerName);
    const owner = await anchorLinkedUser(db, anchor);
    if (owner && owner !== user.id) {
      await auditAuth(db, null, user.id, "federated-link-proof-refused", "deny",
        `link proof for '${user.email}' refused: the identity from '${providerName}' is already linked to another account — request left pending`,
        { phase: "link-confirm", linkRequestId: pending.id, provider: providerName, sub: pending.subject });
      return reply.status(409).send({ error: "identity_already_linked", detail: "this identity is already linked to another account" });
    }
    // proven: spend the request, record the link, reset the counters
    const spent = await db
      .update(federatedLinkRequests)
      .set({ status: "linked", proofTokenHash: null, decidedAt: now, decidedBy: user.id })
      .where(and(eq(federatedLinkRequests.id, pending.id), eq(federatedLinkRequests.status, "pending")))
      .returning({ id: federatedLinkRequests.id });
    if (spent.length === 0) return reply.status(401).send({ error: "no_pending_link" });
    await recordFederatedLink(db, anchor, user.id, "proof");
    await db
      .update(users)
      .set({
        failedLoginCount: 0,
        lastFailedLoginAt: null,
        lockedUntil: null,
        ...(totpStepUsed !== null ? { totpLastUsedStep: totpStepUsed } : {}),
      })
      .where(eq(users.id, user.id));
    await auditAuth(db, user.id, user.id, "federated-identity-linked", "allow",
      `federated identity from '${providerName}' linked to '${user.email}' after the person proved the local account${user.totpEnabled ? " (password + TOTP)" : " (password)"}`,
      { phase: "link-confirm", provider: providerName, providerKind: method, email: pending.email, sub: pending.subject, linkedVia: "proof", linkRequestId: pending.id });
    void reply.header("set-cookie", linkCookie("", requestIsSecure(req), 0));
    await setSession(reply, req, user.id, org, method, { idpMfa: pending.idpMfa });
    await auditAuth(db, user.id, user.id, "login-succeeded", "allow",
      `user '${user.email}' signed in via ${method.toUpperCase()} provider '${providerName}' (identity linked by proof)`,
      { phase: "login", email: user.email, method, provider: providerName, providerId: anchor.ref.id, idpMfa: pending.idpMfa });
    return reply.send({ ok: true, userId: user.id, isAdmin: user.isAdmin, mustChangePassword: user.mustChangePassword });
  });

  // ---- ADR-0174 §5: admin review of link requests (default admin gate) -----

  app.get("/v1/auth/link-requests", async (req) => {
    const { status } = z
      .object({ status: z.enum(["pending", "linked", "approved", "denied", "all"]).optional() })
      .parse(req.query);
    const rows = await db
      .select({
        id: federatedLinkRequests.id,
        userId: federatedLinkRequests.userId,
        userEmail: users.email,
        userDisplayName: users.displayName,
        oidcProviderId: federatedLinkRequests.oidcProviderId,
        samlProviderId: federatedLinkRequests.samlProviderId,
        oidcProviderName: oidcProviders.name,
        samlProviderName: samlProviders.name,
        subject: federatedLinkRequests.subject,
        email: federatedLinkRequests.email,
        idpMfa: federatedLinkRequests.idpMfa,
        status: federatedLinkRequests.status,
        approvals: federatedLinkRequests.approvals,
        userIsAdmin: users.isAdmin,
        createdAt: federatedLinkRequests.createdAt,
        expiresAt: federatedLinkRequests.expiresAt,
        decidedAt: federatedLinkRequests.decidedAt,
      })
      .from(federatedLinkRequests)
      .innerJoin(users, eq(users.id, federatedLinkRequests.userId))
      .leftJoin(oidcProviders, eq(oidcProviders.id, federatedLinkRequests.oidcProviderId))
      .leftJoin(samlProviders, eq(samlProviders.id, federatedLinkRequests.samlProviderId))
      .where((status ?? "pending") === "all" ? undefined : eq(federatedLinkRequests.status, (status ?? "pending") as "pending"))
      .orderBy(desc(federatedLinkRequests.createdAt))
      .limit(200);
    const now = Date.now();
    return {
      requests: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        userEmail: r.userEmail,
        userDisplayName: r.userDisplayName,
        provider: r.oidcProviderName ?? r.samlProviderName ?? "(deleted provider)",
        protocol: r.oidcProviderId ? "oidc" : "saml",
        subject: r.subject,
        email: r.email,
        idpMfa: r.idpMfa,
        status: r.status,
        // ADR-0174 (finding 12): an admin account needs two distinct approvers
        approvals: r.approvals.length,
        requiredApprovals: r.userIsAdmin ? 2 : 1,
        expired: r.status === "pending" && r.expiresAt.getTime() <= now,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        decidedAt: r.decidedAt,
      })),
    };
  });

  const linkRequestParam = z.object({ requestId: z.string().uuid() });
  const decideLinkRequest = async (req: FastifyRequest, reply: FastifyReply, decision: "approved" | "denied") => {
    const { requestId } = linkRequestParam.parse(req.params);
    const body = linkDecisionSchema.parse(req.body ?? {});
    const [row] = await db.select().from(federatedLinkRequests).where(eq(federatedLinkRequests.id, requestId));
    if (!row) return reply.status(404).send({ error: "unknown_link_request" });
    if (row.status !== "pending") {
      return reply.status(409).send({ error: "link_request_not_pending", detail: `this request is already ${row.status}` });
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      return reply.status(409).send({ error: "link_request_expired", detail: "the person must sign in with the identity provider again to raise a fresh request" });
    }
    // separation of duties: an admin proves their OWN account by password,
    // they do not approve a takeover of it
    if (decision === "approved" && req.authCtx.userId === row.userId) {
      return reply.status(409).send({
        error: "cannot_approve_own_link",
        detail: "link your own account by proving it at sign-in (password and code), or ask another administrator",
      });
    }
    const [target] = await db.select().from(users).where(eq(users.id, row.userId));
    if (!target || target.disabledAt) return reply.status(409).send({ error: "user_disabled" });
    const providerName = await linkProviderName(row);
    const anchor = anchorOfRequest(row, providerName);
    if (decision === "approved") {
      const owner = await anchorLinkedUser(db, anchor);
      if (owner && owner !== row.userId) {
        return reply.status(409).send({ error: "identity_already_linked", detail: "this identity is already linked to another account" });
      }
    }
    const now = new Date();
    // ADR-0174 (finding 12): linking an identity to an ADMIN account takes two
    // DISTINCT approvers (neither of them the account itself — refused above);
    // a member account takes one. The bootstrap operator counts as one
    // approver. A first approval is recorded and the request stays pending.
    if (decision === "approved") {
      const required = target.isAdmin ? 2 : 1;
      const approverKey = req.authCtx.userId ?? "bootstrap";
      if (row.approvals.some((a) => (a.userId ?? "bootstrap") === approverKey)) {
        return reply.status(409).send({
          error: "already_approved_by_you",
          detail: "linking an identity to an administrator needs a second, different administrator to approve",
        });
      }
      const approvals = [...row.approvals, { userId: req.authCtx.userId, at: now.toISOString() }];
      if (approvals.length < required) {
        const recorded = await db
          .update(federatedLinkRequests)
          .set({ approvals })
          .where(
            and(
              eq(federatedLinkRequests.id, row.id),
              eq(federatedLinkRequests.status, "pending"),
              sql`jsonb_array_length(${federatedLinkRequests.approvals}) = ${row.approvals.length}`,
            ),
          )
          .returning({ id: federatedLinkRequests.id });
        if (recorded.length === 0) return reply.status(409).send({ error: "link_request_not_pending" });
        await auditAuth(db, req.authCtx.userId, row.userId, "federated-link-approval-recorded", "allow",
          `admin approval ${approvals.length} of ${required} recorded for linking the identity '${row.email}' from '${providerName}' to the administrator account '${target.email}'${body.reason ? `: ${body.reason}` : ""}`,
          { phase: "link-decision", linkRequestId: row.id, provider: providerName, sub: row.subject, email: row.email, approvals: approvals.length, required, via: req.authCtx.via });
        return reply.send({ ok: true, status: "pending", approvals: approvals.length, requiredApprovals: required });
      }
      const updated = await db
        .update(federatedLinkRequests)
        .set({ status: "approved", approvals, proofTokenHash: null, decidedAt: now, decidedBy: req.authCtx.userId })
        .where(
          and(
            eq(federatedLinkRequests.id, row.id),
            eq(federatedLinkRequests.status, "pending"),
            sql`jsonb_array_length(${federatedLinkRequests.approvals}) = ${row.approvals.length}`,
          ),
        )
        .returning({ id: federatedLinkRequests.id });
      if (updated.length === 0) return reply.status(409).send({ error: "link_request_not_pending" });
      await recordFederatedLink(db, anchor, row.userId, "admin");
      await auditAuth(db, req.authCtx.userId, row.userId, "federated-link-approved", "allow",
        `admin approved linking the identity '${row.email}' from '${providerName}' to the account '${target.email}'${required > 1 ? ` (approval ${approvals.length} of ${required})` : ""}${body.reason ? `: ${body.reason}` : ""}`,
        { phase: "link-decision", linkRequestId: row.id, provider: providerName, sub: row.subject, email: row.email, decision, approvals: approvals.length, required, via: req.authCtx.via });
      return reply.send({ ok: true, status: "approved", approvals: approvals.length, requiredApprovals: required });
    }
    const updated = await db
      .update(federatedLinkRequests)
      .set({ status: "denied", proofTokenHash: null, decidedAt: now, decidedBy: req.authCtx.userId })
      .where(and(eq(federatedLinkRequests.id, row.id), eq(federatedLinkRequests.status, "pending")))
      .returning({ id: federatedLinkRequests.id });
    if (updated.length === 0) return reply.status(409).send({ error: "link_request_not_pending" });
    await auditAuth(db, req.authCtx.userId, row.userId, "federated-link-denied", "deny",
      `admin denied linking the identity '${row.email}' from '${providerName}' to the account '${target.email}'${body.reason ? `: ${body.reason}` : ""}`,
      { phase: "link-decision", linkRequestId: row.id, provider: providerName, sub: row.subject, email: row.email, decision, via: req.authCtx.via });
    return reply.send({ ok: true, status: "denied" });
  };
  app.post("/v1/auth/link-requests/:requestId/approve", (req, reply) => decideLinkRequest(req, reply, "approved"));
  app.post("/v1/auth/link-requests/:requestId/deny", (req, reply) => decideLinkRequest(req, reply, "denied"));

  // ---- admin CRUD for OIDC providers (default admin gate applies) ----------

  /** ADR-0181: JIT on with no allowed domains is refused by name, audited */
  const refuseJitWithoutDomains = async (
    reply: FastifyReply,
    actorUserId: string | null,
    name: string,
    providerId: string | null,
  ) => {
    const detail =
      "JIT provisioning creates an account from whatever email the identity provider asserts, so it needs " +
      "allowedEmailDomains: name the domains this provider may provision (or turn JIT off). Nothing was saved.";
    await auditAuth(db, actorUserId, providerId, OIDC_JIT_DOMAINS_REQUIRED, "deny",
      `OIDC provider '${name}' write refused: JIT provisioning without allowed email domains`,
      { phase: providerId ? "provider-updated" : "provider-created", name, error: OIDC_JIT_DOMAINS_REQUIRED },
      "oidc_provider");
    return reply.status(422).send({ error: OIDC_JIT_DOMAINS_REQUIRED, detail });
  };

  app.get("/v1/auth/oidc-providers", async () => {
    const rows = await db.select().from(oidcProviders);
    return { providers: rows.map(publicProvider) };
  });

  app.post("/v1/auth/oidc-providers", async (req, reply) => {
    const body = createOidcProviderSchema.parse(req.body);
    // ADR-0181: JIT provisioning needs the email domains it accepts
    if (oidcJitDomainsMissing(body)) return refuseJitWithoutDomains(reply, req.authCtx.userId, body.name, null);
    if (!opts.dataKey) {
      return reply.status(409).send({
        error: "data_key_required",
        detail: "OIDC client secrets are stored encrypted — set REGULAIT_DATA_KEY on the gateway first",
      });
    }
    if (body.defaultRoleId) {
      const [role] = await db.select().from(roles).where(eq(roles.id, body.defaultRoleId));
      if (!role) return reply.status(422).send({ error: "unknown_role" });
    }
    // ADR-0043: WRITE-TIME egress check against the ordinary default-deny
    // allow-list — a non-permitted issuer is an honest 400 before the row is
    // stored, audited. (Discovery re-checks every login; this is the earliest
    // honest failure.)
    {
      const { decision } = await oidcIssuerDecision(body.issuerUrl);
      if (!decision.ok) {
        await auditAuth(db, req.authCtx.userId, null, "oidc-egress-blocked", "deny",
          `OIDC provider '${body.name}' registration refused: issuer ${decision.reason}`,
          { phase: "provider-created", name: body.name, issuerUrl: body.issuerUrl, code: decision.code },
          "oidc_provider");
        return reply.status(400).send({
          error: "egress_blocked",
          code: decision.code,
          detail: decision.reason,
        });
      }
    }
    const [row] = await db
      .insert(oidcProviders)
      .values({
        name: body.name,
        issuerUrl: body.issuerUrl,
        clientId: body.clientId,
        clientSecretCiphertext: encryptSecret(opts.dataKey, body.clientSecret),
        enabled: body.enabled ?? true,
        allowedEmailDomains: body.allowedEmailDomains ?? null,
        defaultRoleId: body.defaultRoleId ?? null,
        jitProvisioning: body.jitProvisioning ?? false,
        // ADR-0038: naming the claim turns the group SIGNAL on. It grants
        // nothing by itself — an asserted group confers nothing until an admin
        // maps it (`group_role_mappings`), and no mapping reaches isAdmin.
        groupsClaim: body.groupsClaim ?? null,
        // ADR-0174: a broker's upstream IdPs and the acr values meaning MFA
        brokerIdps: body.brokerIdps ?? null,
        mfaAcrValues: body.mfaAcrValues ?? null,
        brokerEnforcesMfa: body.brokerEnforcesMfa ?? false,
      })
      .returning();
    await auditAuth(db, req.authCtx.userId, null, "oidc-provider-created", "allow",
      `OIDC provider '${body.name}' created (issuer ${body.issuerUrl})`,
      { phase: "provider-created", name: body.name, issuerUrl: body.issuerUrl, jitProvisioning: body.jitProvisioning ?? false, allowedEmailDomains: body.allowedEmailDomains ?? null, brokerIdps: body.brokerIdps ?? null },
      "oidc_provider");
    return reply.status(201).send(publicProvider(row!));
  });

  app.patch("/v1/auth/oidc-providers/:providerId", async (req, reply) => {
    const { providerId } = providerParam.parse(req.params);
    const body = updateOidcProviderSchema.parse(req.body);
    const [existing] = await db.select().from(oidcProviders).where(eq(oidcProviders.id, providerId));
    if (!existing) return reply.status(404).send({ error: "unknown_provider" });
    // ADR-0181: checked over the EFFECTIVE values, so a two-step PATCH cannot
    // turn JIT on before (or clear the domains after) naming them
    if (
      oidcJitDomainsMissing({
        jitProvisioning: body.jitProvisioning ?? existing.jitProvisioning,
        allowedEmailDomains: body.allowedEmailDomains !== undefined ? body.allowedEmailDomains : existing.allowedEmailDomains,
      })
    ) {
      return refuseJitWithoutDomains(reply, req.authCtx.userId, existing.name, providerId);
    }
    if (body.clientSecret && !opts.dataKey) {
      return reply.status(409).send({ error: "data_key_required" });
    }
    if (body.defaultRoleId) {
      const [role] = await db.select().from(roles).where(eq(roles.id, body.defaultRoleId));
      if (!role) return reply.status(422).send({ error: "unknown_role" });
    }
    // ADR-0043: moving the issuer re-runs the write-time egress check
    if (body.issuerUrl !== undefined) {
      const { decision } = await oidcIssuerDecision(body.issuerUrl);
      if (!decision.ok) {
        await auditAuth(db, req.authCtx.userId, providerId, "oidc-egress-blocked", "deny",
          `OIDC provider '${existing.name}' issuer change refused: ${decision.reason}`,
          { phase: "provider-updated", name: existing.name, issuerUrl: body.issuerUrl, code: decision.code },
          "oidc_provider");
        return reply.status(400).send({
          error: "egress_blocked",
          code: decision.code,
          detail: decision.reason,
        });
      }
    }
    const { clientSecret, ...rest } = body;
    /** the write and its audit rows, on whichever handle the caller holds */
    const apply = async (x: Pick<Db, "update" | "insert" | "delete">, site?: SignInInvariantSite) => {
      const [row] = await x
        .update(oidcProviders)
        .set({
          ...rest,
          ...(clientSecret ? { clientSecretCiphertext: encryptSecret(opts.dataKey!, clientSecret) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(oidcProviders.id, providerId))
        .returning();
      if (site) await signInInvariantWritten(site);
      await auditAuth(x, req.authCtx.userId, null, "oidc-provider-updated", "allow",
        `OIDC provider '${existing.name}' updated: ${Object.keys(body).join(", ")}`,
        {
          phase: "provider-updated",
          name: existing.name,
          changed: Object.keys(body),
          // ADR-0181: a relaxed posture flag is answerable as old -> new
          transitions: settingTransitions(existing, rest),
          secretRotated: Boolean(clientSecret),
        },
        "oidc_provider");
      // ADR-0174 (finding 6): a new issuer is a different identity provider —
      // the subjects linked under the old one mean nothing under the new one
      if (body.issuerUrl !== undefined && body.issuerUrl !== existing.issuerUrl) {
        const dropped = await dropProviderLinks(x, { kind: "oidc", id: providerId, name: existing.name });
        await auditAuth(x, req.authCtx.userId, providerId, "federated-identities-reset", "allow",
          `OIDC provider '${existing.name}' issuer changed: ${dropped.identities} linked identit${dropped.identities === 1 ? "y" : "ies"} and ${dropped.requests} pending link request(s) removed — each person links again on their next sign-in`,
          { phase: "provider-updated", name: existing.name, fromIssuer: existing.issuerUrl, toIssuer: body.issuerUrl, ...dropped },
          "oidc_provider");
      }
      return row!;
    };
    if (body.enabled !== false) return publicProvider(await apply(db));
    // lockout guard: disabling the LAST enabled provider while sso_only is on
    // would strand every human login. ADR-0036 GENERALIZED the count to both
    // provider families — with a live SAML provider, disabling the last OIDC
    // one no longer strands anybody, and the guard must not pretend otherwise.
    // ADR-0174 (finding 5): nor while email sign-in is break-glass only.
    // AER-056: re-read, check, write and audit under the invariant lock, so a
    // concurrent disable/delete/demotion/mode change cannot pass the same count.
    const out = await withSignInInvariant(db, async (tx, org) => {
      const [current] = await tx.select({ enabled: oidcProviders.enabled }).from(oidcProviders).where(eq(oidcProviders.id, providerId));
      if (!current) return { status: 404, body: { error: "unknown_provider" } } as const;
      if (current.enabled) {
        const refusal = await providerRemovalRefusal(tx, org, { kind: "oidc_provider", providerId });
        if (refusal) return { status: 409, body: refusal } as const;
        await signInInvariantChecked("oidc-provider-disable");
      }
      return { row: await apply(tx, "oidc-provider-disable") };
    });
    if (out.status !== undefined) return reply.status(out.status).send(out.body);
    return publicProvider(out.row);
  });

  app.delete("/v1/auth/oidc-providers/:providerId", async (req, reply) => {
    const { providerId } = providerParam.parse(req.params);
    // AER-056: the lookup, both lockout guards (ADR-0036 sso_only, ADR-0174
    // break-glass), the delete and its audit row are one locked transaction
    const out = await withSignInInvariant(db, async (tx, org) => {
      const [existing] = await tx.select().from(oidcProviders).where(eq(oidcProviders.id, providerId));
      if (!existing) return { status: 404, body: { error: "unknown_provider" } } as const;
      if (existing.enabled) {
        const refusal = await providerRemovalRefusal(tx, org, { kind: "oidc_provider", providerId });
        if (refusal) return { status: 409, body: refusal } as const;
        await signInInvariantChecked("oidc-provider-delete");
      }
      await tx.delete(oidcProviders).where(eq(oidcProviders.id, providerId));
      await signInInvariantWritten("oidc-provider-delete");
      await auditAuth(tx, req.authCtx.userId, null, "oidc-provider-deleted", "allow",
        `OIDC provider '${existing.name}' deleted`,
        { phase: "provider-deleted", name: existing.name },
        "oidc_provider");
      return { removed: true } as const;
    });
    if (out.status !== undefined) return reply.status(out.status).send(out.body);
    return { removed: true };
  });

  // ---- admin visibility: a user's live sessions (+ revoke) -----------------
  // ADR-0039: list access is itself audited, rows carry last_seen_ip and the
  // derived (non-authoritative) device label, and revocation exists at BOTH
  // granularities — one session or all of them. Every death is still just
  // revoked_at; resolveSession stays the single enforcement path.

  const revokeReasonSchema = z.object({ reason: z.string().trim().min(1).max(500).optional() });

  app.get("/v1/users/:userId/sessions", async (req) => {
    const { userId } = userIdParam.parse(req.params);
    const rows = await db
      .select({
        id: authSessions.id,
        createdAt: authSessions.createdAt,
        expiresAt: authSessions.expiresAt,
        idleExpiresAt: authSessions.idleExpiresAt,
        lastSeenAt: authSessions.lastSeenAt,
        ip: authSessions.ip,
        lastSeenIp: authSessions.lastSeenIp,
        userAgent: authSessions.userAgent,
        origin: authSessions.origin,
        revokedAt: authSessions.revokedAt,
      })
      .from(authSessions)
      .where(eq(authSessions.userId, userId));
    await auditAuth(db, req.authCtx.userId, userId, "session-list-viewed", "allow",
      `admin viewed the session list for user ${userId} (${rows.length} session(s))`,
      { phase: "session-list", via: "admin", count: rows.length });
    return {
      sessions: rows.map((s) => ({ ...s, deviceLabel: deviceLabel(s.userAgent) })),
    };
  });

  app.post("/v1/users/:userId/sessions/revoke", async (req, reply) => {
    const { userId } = userIdParam.parse(req.params);
    const body = revokeReasonSchema.parse(req.body ?? {});
    const [target] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    if (!target) return reply.status(404).send({ error: "unknown_user" });
    const revoked = await db
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)))
      .returning({ id: authSessions.id });
    await auditAuth(db, req.authCtx.userId, userId, "sessions-revoked-by-admin", "allow",
      `admin revoked ${revoked.length} live session(s) for '${target.email}'${body.reason ? `: ${body.reason}` : ""}`,
      { phase: "sessions-revoked", email: target.email, count: revoked.length, reason: body.reason ?? null });
    return { revoked: revoked.length };
  });

  /** ADR-0039: single-session (single-device) revocation — kill ONE
   * suspicious session without signing the user out everywhere. Registered
   * beside revoke-all; the static `revoke` segment wins over `:sessionId`, so
   * the existing route is untouched. */
  app.post("/v1/users/:userId/sessions/:sessionId/revoke", async (req, reply) => {
    const { userId, sessionId } = z
      .object({ userId: z.string().uuid(), sessionId: z.string().uuid() })
      .parse(req.params);
    const body = revokeReasonSchema.parse(req.body ?? {});
    const [target] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    if (!target) return reply.status(404).send({ error: "unknown_user" });
    // scoped to the named user: a session id under someone else's account is
    // indistinguishable from one that never existed
    const [session] = await db
      .select({ id: authSessions.id, revokedAt: authSessions.revokedAt })
      .from(authSessions)
      .where(and(eq(authSessions.id, sessionId), eq(authSessions.userId, userId)));
    if (!session) return reply.status(404).send({ error: "unknown_session" });
    if (session.revokedAt) {
      return reply.status(409).send({ error: "already_revoked", revokedAt: session.revokedAt });
    }
    await db.update(authSessions).set({ revokedAt: new Date() }).where(eq(authSessions.id, sessionId));
    await auditAuth(db, req.authCtx.userId, userId, "session-revoked-by-admin", "allow",
      `admin revoked session ${sessionId} for '${target.email}'${body.reason ? `: ${body.reason}` : ""}`,
      { phase: "session-revoked", email: target.email, sessionId, reason: body.reason ?? null });
    return { ok: true, revokedSessionId: sessionId };
  });

  // ---- ADR-0039: self-service session management ---------------------------
  // The account-security affordance: see your own live sessions, kill one you
  // don't recognize, or "sign out my other devices". Every route operates ONLY
  // on the caller's own rows — ownership is part of the WHERE clause, never a
  // post-hoc check, so another user's session id 404s without leaking that it
  // exists. Non-admin by design (NON_ADMIN_ROUTES in app.ts); CSRF is enforced
  // by the global cookie-mutation hook like every state-changing route.

  app.get("/auth/sessions", async (req, reply) => {
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "no_user_identity" });
    const now = new Date();
    const rows = await db
      .select({
        id: authSessions.id,
        createdAt: authSessions.createdAt,
        expiresAt: authSessions.expiresAt,
        lastSeenAt: authSessions.lastSeenAt,
        ip: authSessions.ip,
        lastSeenIp: authSessions.lastSeenIp,
        userAgent: authSessions.userAgent,
        origin: authSessions.origin,
      })
      .from(authSessions)
      .where(
        and(
          eq(authSessions.userId, userId),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, now),
          gt(authSessions.idleExpiresAt, now),
        ),
      );
    await auditAuth(db, userId, userId, "session-list-viewed", "allow",
      `user viewed their own session list (${rows.length} live session(s))`,
      { phase: "session-list", via: "self", count: rows.length });
    return {
      sessions: rows.map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        lastSeenAt: s.lastSeenAt,
        ip: s.ip,
        lastSeenIp: s.lastSeenIp,
        origin: s.origin,
        deviceLabel: deviceLabel(s.userAgent),
        current: s.id === (req.sessionAuth?.sessionId ?? null),
      })),
    };
  });

  app.post("/auth/sessions/:sessionId/revoke", async (req, reply) => {
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(req.params);
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "no_user_identity" });
    // ownership IS the predicate: only the caller's own live session can match
    const revoked = await db
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(authSessions.id, sessionId),
          eq(authSessions.userId, userId),
          isNull(authSessions.revokedAt),
        ),
      )
      .returning({ id: authSessions.id });
    if (revoked.length === 0) return reply.status(404).send({ error: "unknown_session" });
    const wasCurrent = sessionId === (req.sessionAuth?.sessionId ?? null);
    await auditAuth(db, userId, userId, "session-revoked-by-self", "allow",
      `user revoked their own session ${sessionId}${wasCurrent ? " (their current session — self sign-out)" : ""}`,
      { phase: "session-revoked", via: "self", sessionId, wasCurrent });
    return { ok: true, revokedSessionId: sessionId, wasCurrent };
  });

  app.post("/auth/sessions/revoke-others", async (req, reply) => {
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "no_user_identity" });
    // caller on a session keeps exactly that session; an API-key caller has
    // no current session, so ALL of their browser sessions are revoked
    const keepId = req.sessionAuth?.sessionId ?? null;
    const revoked = await db
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(authSessions.userId, userId),
          isNull(authSessions.revokedAt),
          ...(keepId ? [ne(authSessions.id, keepId)] : []),
        ),
      )
      .returning({ id: authSessions.id });
    await auditAuth(db, userId, userId, "sessions-revoked-others", "allow",
      `user signed out ${revoked.length} other session(s)${keepId ? " (current session kept)" : ""}`,
      { phase: "sessions-revoked", via: "self", count: revoked.length, keptSessionId: keepId });
    return { revoked: revoked.length };
  });
}
