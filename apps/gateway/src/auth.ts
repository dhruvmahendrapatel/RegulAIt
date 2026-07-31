import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  and,
  apiKeys,
  auditLog,
  authMfaPending,
  authSessions,
  eq,
  gt,
  isNull,
  lt,
  ne,
  oidcLoginStates,
  oidcProviders,
  roleAssignments,
  roles,
  sql,
  users,
  type Db,
  type OrgSettingsRow,
  type SessionOrigin,
} from "@regulait/db";
import {
  changePasswordSchema,
  clearMfaSchema,
  createOidcProviderSchema,
  loginSchema,
  loginWithKeySchema,
  mfaVerifySchema,
  setInitialPasswordSchema,
  totpActivateSchema,
  totpDisableSchema,
  updateOidcProviderSchema,
} from "@regulait/shared";
import { z } from "zod";
import * as oidc from "openid-client";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { loadOrgSettings } from "./org-settings.js";

export interface AuthContext {
  /** null only for the bootstrap token (header or exchanged session), which
   * has no user identity */
  userId: string | null;
  isAdmin: boolean;
  /** "session" = ADR-0025 cookie session (password, MFA, SSO or key-exchange
   * login). The API-key and bootstrap header paths are byte-identical to
   * pre-0042. */
  via: "bootstrap" | "api-key" | "session";
}

export const TOKEN_PREFIX = "rgl_";

export function generateToken(): { token: string; tokenHash: string } {
  const token = TOKEN_PREFIX + randomBytes(24).toString("hex");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
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
): Promise<AuthContext | null | "disabled"> {
  if (!authorizationHeader?.startsWith("Bearer ")) return null;
  const token = authorizationHeader.slice("Bearer ".length).trim();
  if (token.length === 0) return null;

  if (bootstrapToken && safeEqual(token, bootstrapToken)) {
    return { userId: null, isAdmin: true, via: "bootstrap" };
  }

  const [row] = await db
    .select({
      keyId: apiKeys.id,
      userId: apiKeys.userId,
      isAdmin: users.isAdmin,
      disabledAt: users.disabledAt,
    })
    .from(apiKeys)
    .innerJoin(users, eq(apiKeys.userId, users.id))
    .where(and(eq(apiKeys.tokenHash, hashToken(token)), isNull(apiKeys.revokedAt)));
  if (!row) return null;
  // ADR-0022: a deactivated user's keys stop authenticating IMMEDIATELY — no
  // lastUsedAt touch, no context. Reactivation restores them unchanged
  // (deactivate ≠ delete; the keys were never revoked).
  if (row.disabledAt !== null) return "disabled";

  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.keyId));
  return { userId: row.userId, isAdmin: row.isAdmin, via: "api-key" };
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
  return actual.length === expected.length && timingSafeEqual(actual, expected);
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

export function requestIsSecure(req: FastifyRequest): boolean {
  const fwd = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(fwd) ? fwd[0] : fwd;
  if (proto) return proto.split(",")[0]!.trim() === "https";
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

export interface SessionAuth {
  ctx: AuthContext;
  sessionId: string;
  /** user flags the gates in app.ts consult (null-user bootstrap session = all false) */
  mustChangePassword: boolean;
  totpEnabled: boolean;
  /** ADR-0028: HOW this session was established. 'unknown' = a pre-0046 row. */
  origin: SessionOrigin;
}

export async function createSession(
  db: Db,
  userId: string | null,
  org: OrgSettingsRow,
  req: FastifyRequest,
  /** ADR-0028: every creation site names the credential that established the
   * session. There is deliberately no default — a new login path must choose. */
  origin: SessionOrigin,
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
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 512) : null,
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
): Promise<SessionAuth | null | "disabled"> {
  const [row] = await db
    .select({
      id: authSessions.id,
      userId: authSessions.userId,
      expiresAt: authSessions.expiresAt,
      idleExpiresAt: authSessions.idleExpiresAt,
      idleMinutes: authSessions.idleMinutes,
      origin: authSessions.origin,
      revokedAt: authSessions.revokedAt,
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
  if (row.userId === null) {
    // bootstrap-exchanged session: dies with the deploy-time token
    if (!bootstrapConfigured) return null;
    await db
      .update(authSessions)
      .set({ idleExpiresAt: new Date(now + row.idleMinutes * 60_000), lastSeenAt: new Date(now) })
      .where(eq(authSessions.id, row.id));
    return {
      ctx: { userId: null, isAdmin: true, via: "session" },
      sessionId: row.id,
      mustChangePassword: false,
      totpEnabled: false,
      origin: row.origin,
    };
  }
  if (row.disabledAt) return "disabled";
  await db
    .update(authSessions)
    .set({ idleExpiresAt: new Date(now + row.idleMinutes * 60_000), lastSeenAt: new Date(now) })
    .where(eq(authSessions.id, row.id));
  return {
    ctx: { userId: row.userId, isAdmin: row.isAdmin ?? false, via: "session" },
    sessionId: row.id,
    mustChangePassword: row.mustChangePassword ?? false,
    totpEnabled: row.totpEnabled ?? false,
    origin: row.origin,
  };
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

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20)); // 160-bit secret per RFC 4226
}

export function totpStep(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);
}

export function totpCode(secretBase32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", base32Decode(secretBase32)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const bin =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * Verify a code within ±1 time-step (clock skew tolerance) with REPLAY
 * PROTECTION: any step <= lastUsedStep is refused, so a consumed code can
 * never be replayed inside its validity window. Returns the consumed step
 * (to persist as the new lastUsedStep) or null.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  lastUsedStep: number | null,
  atMs: number = Date.now(),
): number | null {
  const now = totpStep(atMs);
  for (const step of [now, now - 1, now + 1]) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (safeEqual(totpCode(secretBase32, step), code)) return step;
  }
  return null;
}

export function otpauthUri(email: string, secretBase32: string): string {
  const label = encodeURIComponent(`RegulAIt:${email}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=RegulAIt&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}

// --- audit helper -----------------------------------------------------------

function auditAuth(
  db: Db,
  actorUserId: string | null,
  targetUserId: string | null,
  ruleId: string,
  effect: "allow" | "deny",
  reason: string,
  detail: Record<string, unknown>,
  objectType: "user" | "oidc_provider" = "user",
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

/** uniform 401 for EVERY password-login failure — unknown email, wrong
 * password, passwordless account, deactivated account, active lockout — so
 * the endpoint is not an account-existence oracle. */
const UNIFORM_LOGIN_401 = {
  error: "invalid_credentials",
  detail: "email or password is incorrect",
};

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

export function registerAuthRoutes(app: FastifyInstance, db: Db, opts: AuthRouteOptions = {}) {
  const setSession = async (
    reply: FastifyReply,
    req: FastifyRequest,
    userId: string | null,
    org: OrgSettingsRow,
    origin: SessionOrigin,
  ) => {
    const { token, maxAgeSeconds } = await createSession(db, userId, org, req, origin);
    void reply.header("set-cookie", sessionCookie(token, requestIsSecure(req), maxAgeSeconds));
  };

  const loadUserByEmail = async (email: string) => {
    const [row] = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
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

    const user = await loadUserByEmail(body.email);
    const fail = async (why: string) => {
      if (user) {
        // lockout bookkeeping (dials from org settings). The window resets
        // the counter; crossing the threshold engages a temporary lockout.
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
            { phase: "login-lockout", email: user.email, failures: count, lockoutMinutes: org.loginLockoutMinutes });
        }
      }
      await auditAuth(db, null, user?.id ?? null, "login-failed", "deny",
        "password login failed",
        // the audit trail records WHY; the HTTP response never does
        { phase: "login-failed", email: body.email, why });
      return reply.status(401).send(UNIFORM_LOGIN_401);
    };

    if (!user) {
      verifyPassword(body.password, null); // burn the same scrypt cost
      return fail("unknown_email");
    }
    if (user.disabledAt) {
      verifyPassword(body.password, null);
      return fail("user_disabled");
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > now.getTime()) {
      verifyPassword(body.password, null);
      return fail("locked_out");
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
      `user '${user.email}' signed in with a password`,
      { phase: "login", email: user.email, method: "password" });
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
    const now = new Date();
    const [pending] = await db
      .select()
      .from(authMfaPending)
      .where(and(eq(authMfaPending.tokenHash, hashToken(body.pendingToken)), gt(authMfaPending.expiresAt, now)));
    if (!pending) return reply.status(401).send({ error: "invalid_or_expired_pending_token" });
    const [user] = await db.select().from(users).where(eq(users.id, pending.userId));
    if (!user || user.disabledAt || !user.totpEnabled || !user.totpSecretCiphertext || !opts.dataKey) {
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
    const org = await loadOrgSettings(db);
    // ADR-0028: the second factor does not change WHICH credential established
    // the session — a MFA-completed login is still 'password' origin.
    await setSession(reply, req, user.id, org, "password");
    await auditAuth(db, user.id, user.id, "login-succeeded", "allow",
      `user '${user.email}' signed in with password + TOTP`,
      { phase: "login", email: user.email, method: "password+totp" });
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
    if (!ctx) return reply.status(401).send({ error: "invalid_key" });
    const org = await loadOrgSettings(db);
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
        user = { id: row.id, email: row.email, displayName: row.displayName };
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
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    // client_secret_ciphertext deliberately absent: secrets are WRITE-ONLY
  });

  /** discovery against the provider's issuer. http:// issuers (dev/test IdPs)
   * need the explicit insecure opt-in; https needs nothing. */
  const oidcConfigFor = async (provider: typeof oidcProviders.$inferSelect) => {
    if (!opts.dataKey) throw new Error("REGULAIT_DATA_KEY required for OIDC");
    const secret = decryptSecret(opts.dataKey, provider.clientSecretCiphertext);
    return oidc.discovery(
      new URL(provider.issuerUrl),
      provider.clientId,
      secret,
      undefined,
      provider.issuerUrl.startsWith("http://") ? { execute: [oidc.allowInsecureRequests] } : undefined,
    );
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

  // step 1: redirect to the IdP with state + nonce + PKCE (all server-side)
  app.get("/auth/oidc/:providerId/start", async (req, reply) => {
    const { providerId } = providerParam.parse(req.params);
    const { returnTo } = z
      .object({ returnTo: z.enum(["/app", "/admin"]).optional() })
      .parse(req.query);
    const [provider] = await db
      .select()
      .from(oidcProviders)
      .where(and(eq(oidcProviders.id, providerId), eq(oidcProviders.enabled, true)));
    if (!provider) return reply.status(404).send({ error: "unknown_provider" });
    if (!opts.dataKey) return reply.status(409).send({ error: "data_key_required" });
    const config = await oidcConfigFor(provider);
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
    });
    return reply.redirect(authUrl.href, 302);
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
    const [provider] = await db
      .select()
      .from(oidcProviders)
      .where(and(eq(oidcProviders.id, login.providerId), eq(oidcProviders.enabled, true)));
    if (!provider) return reply.status(401).send({ error: "unknown_provider" });
    const config = await oidcConfigFor(provider);

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

    const email = typeof claims.email === "string" ? claims.email.toLowerCase() : null;
    const emailVerified = claims.email_verified === true;
    if (!email || !emailVerified) {
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

    let user = await loadUserByEmail(email);
    if (user?.disabledAt) {
      await auditAuth(db, null, user.id, "oidc-login-failed", "deny",
        `OIDC login refused: account '${email}' is deactivated`,
        { phase: "oidc-callback", provider: provider.name, email });
      return reply.status(401).send({
        error: "user_disabled",
        detail: "this account has been deactivated — an admin can reactivate it",
      });
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
    }

    const org = await loadOrgSettings(db);
    await setSession(reply, req, user.id, org, "oidc"); // ADR-0028
    await auditAuth(db, user.id, user.id, "login-succeeded", "allow",
      `user '${email}' signed in via OIDC provider '${provider.name}'`,
      { phase: "login", email, method: "oidc", provider: provider.name });
    return reply.redirect(login.returnTo, 302);
  });

  // ---- admin CRUD for OIDC providers (default admin gate applies) ----------

  app.get("/v1/auth/oidc-providers", async () => {
    const rows = await db.select().from(oidcProviders);
    return { providers: rows.map(publicProvider) };
  });

  app.post("/v1/auth/oidc-providers", async (req, reply) => {
    const body = createOidcProviderSchema.parse(req.body);
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
      })
      .returning();
    await auditAuth(db, req.authCtx.userId, null, "oidc-provider-created", "allow",
      `OIDC provider '${body.name}' created (issuer ${body.issuerUrl})`,
      { phase: "provider-created", name: body.name, issuerUrl: body.issuerUrl, jitProvisioning: body.jitProvisioning ?? false },
      "oidc_provider");
    return reply.status(201).send(publicProvider(row!));
  });

  app.patch("/v1/auth/oidc-providers/:providerId", async (req, reply) => {
    const { providerId } = providerParam.parse(req.params);
    const body = updateOidcProviderSchema.parse(req.body);
    const [existing] = await db.select().from(oidcProviders).where(eq(oidcProviders.id, providerId));
    if (!existing) return reply.status(404).send({ error: "unknown_provider" });
    if (body.clientSecret && !opts.dataKey) {
      return reply.status(409).send({ error: "data_key_required" });
    }
    if (body.defaultRoleId) {
      const [role] = await db.select().from(roles).where(eq(roles.id, body.defaultRoleId));
      if (!role) return reply.status(422).send({ error: "unknown_role" });
    }
    // lockout guard: disabling the LAST enabled provider while sso_only is on
    // would strand every human login
    if (body.enabled === false && existing.enabled) {
      const org = await loadOrgSettings(db);
      if (org.ssoOnly) {
        const stillEnabled = await db
          .select({ id: oidcProviders.id })
          .from(oidcProviders)
          .where(and(eq(oidcProviders.enabled, true), ne(oidcProviders.id, providerId)));
        if (stillEnabled.length === 0) {
          return reply.status(409).send({
            error: "sso_only_needs_a_provider",
            detail: "sso_only is on and this is the last enabled OIDC provider — turn sso_only off first",
          });
        }
      }
    }
    const { clientSecret, ...rest } = body;
    const [row] = await db
      .update(oidcProviders)
      .set({
        ...rest,
        ...(clientSecret ? { clientSecretCiphertext: encryptSecret(opts.dataKey!, clientSecret) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(oidcProviders.id, providerId))
      .returning();
    await auditAuth(db, req.authCtx.userId, null, "oidc-provider-updated", "allow",
      `OIDC provider '${existing.name}' updated: ${Object.keys(body).join(", ")}`,
      { phase: "provider-updated", name: existing.name, changed: Object.keys(body), secretRotated: Boolean(clientSecret) },
      "oidc_provider");
    return publicProvider(row!);
  });

  app.delete("/v1/auth/oidc-providers/:providerId", async (req, reply) => {
    const { providerId } = providerParam.parse(req.params);
    const [existing] = await db.select().from(oidcProviders).where(eq(oidcProviders.id, providerId));
    if (!existing) return reply.status(404).send({ error: "unknown_provider" });
    if (existing.enabled) {
      const org = await loadOrgSettings(db);
      if (org.ssoOnly) {
        const stillEnabled = await db
          .select({ id: oidcProviders.id })
          .from(oidcProviders)
          .where(and(eq(oidcProviders.enabled, true), ne(oidcProviders.id, providerId)));
        if (stillEnabled.length === 0) {
          return reply.status(409).send({
            error: "sso_only_needs_a_provider",
            detail: "sso_only is on and this is the last enabled OIDC provider — turn sso_only off first",
          });
        }
      }
    }
    await db.delete(oidcProviders).where(eq(oidcProviders.id, providerId));
    await auditAuth(db, req.authCtx.userId, null, "oidc-provider-deleted", "allow",
      `OIDC provider '${existing.name}' deleted`,
      { phase: "provider-deleted", name: existing.name },
      "oidc_provider");
    return { removed: true };
  });

  // ---- admin visibility: a user's live sessions (+ revoke) -----------------
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
        userAgent: authSessions.userAgent,
        revokedAt: authSessions.revokedAt,
      })
      .from(authSessions)
      .where(eq(authSessions.userId, userId));
    return { sessions: rows };
  });

  app.post("/v1/users/:userId/sessions/revoke", async (req, reply) => {
    const { userId } = userIdParam.parse(req.params);
    const [target] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    if (!target) return reply.status(404).send({ error: "unknown_user" });
    const revoked = await db
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)))
      .returning({ id: authSessions.id });
    await auditAuth(db, req.authCtx.userId, userId, "sessions-revoked-by-admin", "allow",
      `admin revoked ${revoked.length} live session(s) for '${target.email}'`,
      { phase: "sessions-revoked", email: target.email, count: revoked.length });
    return { revoked: revoked.length };
  });
}
