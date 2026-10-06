/**
 * ADR-0025 e2e — real human authentication.
 *
 * Covers: password login + server-side sessions (logout, absolute expiry,
 * idle expiry, revocation, disabled-user death), uniform login errors +
 * lockout (audited), the must-change-password gate, the CSRF custom-header
 * wall (cookie mutations only — API-key requests untouched), TOTP MFA
 * (enroll/activate, two-step login, replay-block, admin recovery), and the
 * full OIDC authorization-code + PKCE flow against a FAKE local IdP
 * (discovery/jwks/token implemented in-process): state/nonce/PKCE
 * validation, domain filter, JIT default-deny vs provision-never-admin, and
 * the sso_only switch + its no-lockout guards. Plus an API-key regression
 * block proving the pre-0042 header path is byte-identical.
 *
 * ADR-0028 block at the end: session ORIGIN (migration 0046) recorded by every
 * login flow, the forced-password-change LOCKOUT fix for api_key-origin
 * sessions in a recovery state, and — most importantly — the escalation guard
 * that keeps the steady state requiring the current password.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  and,
  authSessions,
  auditLog,
  createDb,
  desc,
  eq,
  inArray,
  oidcProviders,
  ORG_SETTINGS_ID,
  orgSettings,
  roleAssignments,
  samlProviders,
  sql,
  users,
  type Db,
  type OrgSettingsRow,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { hashToken, totpCode, totpStep } from "./auth.js";
import { enrolTotpForTest } from "./testing/identity-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "auth-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
const DATA_KEY = "c".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;

// ---------------------------------------------------------------------------
// fake OIDC IdP: discovery + jwks + token endpoints on a local http server
// ---------------------------------------------------------------------------
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
interface CodeRecord {
  nonce: string;
  challenge: string | null;
  email: string;
  emailVerified: boolean;
  name?: string;
  sub: string;
  /** overrides the nonce actually embedded in the id_token (tamper tests) */
  nonceOverride?: string;
}
const idp = {
  server: null as Server | null,
  issuer: "",
  clientId: "regulait-test-client",
  clientSecret: "regulait-test-secret",
  codes: new Map<string, CodeRecord>(),
  lastVerifierOk: null as boolean | null,
  tokenCalls: 0,
};
function signJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = `${b64({ alg: "RS256", kid: "k1" })}.${b64(payload)}`;
  const sig = createSign("RSA-SHA256").update(data).sign(rsa.privateKey).toString("base64url");
  return `${data}.${sig}`;
}
async function startIdp(): Promise<void> {
  idp.server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", idp.issuer);
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json({
        issuer: idp.issuer,
        authorization_endpoint: `${idp.issuer}/authorize`,
        token_endpoint: `${idp.issuer}/token`,
        jwks_uri: `${idp.issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      });
    }
    if (url.pathname === "/jwks") {
      const jwk = rsa.publicKey.export({ format: "jwk" }) as Record<string, unknown>;
      return json({ keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] });
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        idp.tokenCalls += 1;
        const params = new URLSearchParams(body);
        const code = params.get("code") ?? "";
        const rec = idp.codes.get(code);
        if (!rec) return json({ error: "invalid_grant" }, 400);
        idp.codes.delete(code); // authorization codes are single-use
        // PKCE: the token endpoint verifies S256(code_verifier) == challenge
        const verifier = params.get("code_verifier");
        if (rec.challenge) {
          const ok =
            verifier !== null &&
            createHash("sha256").update(verifier).digest("base64url") === rec.challenge;
          idp.lastVerifierOk = ok;
          if (!ok) return json({ error: "invalid_grant", error_description: "PKCE failed" }, 400);
        }
        const now = Math.floor(Date.now() / 1000);
        return json({
          access_token: "fake-at-" + randomBytes(8).toString("hex"),
          token_type: "bearer",
          expires_in: 3600,
          id_token: signJwt({
            iss: idp.issuer,
            sub: rec.sub,
            aud: idp.clientId,
            iat: now,
            exp: now + 300,
            nonce: rec.nonceOverride ?? rec.nonce,
            email: rec.email,
            email_verified: rec.emailVerified,
            ...(rec.name ? { name: rec.name } : {}),
          }),
        });
      });
      return;
    }
    json({ error: "not_found" }, 404);
  });
  await new Promise<void>((resolve) => idp.server!.listen(0, "127.0.0.1", resolve));
  const addr = idp.server!.address();
  if (addr === null || typeof addr === "string") throw new Error("no idp port");
  idp.issuer = `http://127.0.0.1:${addr.port}`;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const mkUser = async (email: string, name: string, isAdmin = false): Promise<string> => {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/users",
    payload: { email, displayName: name, isAdmin },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id;
};
const setInitialPassword = async (userId: string, force = false): Promise<string> => {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${userId}/set-initial-password`,
    payload: force ? { force: true } : {},
  });
  expect(r.statusCode).toBe(200);
  return r.json().password;
};
const changePassword = (cookie: string, currentPassword: string, newPassword: string) =>
  app.inject({
    method: "POST", url: "/auth/change-password", headers: CSRF,
    cookies: { regulait_session: cookie },
    payload: { currentPassword, newPassword },
  });
const login = (email: string, password: string) =>
  app.inject({ method: "POST", url: "/auth/login", headers: CSRF, payload: { email, password } });
const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }): string => {
  const c = res.cookies.find((x) => x.name === "regulait_session");
  expect(c, "expected a session cookie").toBeTruthy();
  return c!.value;
};
const me = (cookie: string) =>
  app.inject({ method: "GET", url: "/auth/me", cookies: { regulait_session: cookie } });
/** full password onboarding: admin one-time password -> user sets a real one */
const onboard = async (userId: string, email: string, newPassword: string): Promise<string> => {
  const oneTime = await setInitialPassword(userId);
  const first = await login(email, oneTime);
  expect(first.statusCode).toBe(200);
  const cookie = cookieOf(first);
  const change = await changePassword(cookie, oneTime, newPassword);
  expect(change.statusCode).toBe(200);
  return cookie;
};
const latestAudit = async (ruleId: string) => {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.ruleId, ruleId))
    .orderBy(desc(auditLog.at))
    .limit(1);
  return row ?? null;
};
/** drive /auth/oidc/:id/start, mint a code at the fake IdP, hit the callback */
const oidcRoundTrip = async (
  providerId: string,
  claims: { email: string; emailVerified?: boolean; name?: string; sub?: string; nonceOverride?: string },
  opts: { tamperState?: string; dropBindingCookie?: boolean; bindingCookieOverride?: string } = {},
) => {
  const start = await app.inject({ method: "GET", url: `/auth/oidc/${providerId}/start?returnTo=/app` });
  expect(start.statusCode).toBe(302);
  // ADR-0167 (AUTHZ-04): /start binds the login to this browser with a cookie
  // the callback requires — a real browser carries it back; so does this.
  const binding = start.cookies.find((c) => c.name === "regulait_oidc_login");
  expect(binding, "expected the browser-binding cookie from /start").toBeTruthy();
  const bindingHeader = opts.dropBindingCookie
    ? {}
    : { cookie: `regulait_oidc_login=${opts.bindingCookieOverride ?? binding!.value}` };
  const authUrl = new URL(start.headers.location as string);
  const state = authUrl.searchParams.get("state")!;
  const nonce = authUrl.searchParams.get("nonce")!;
  const challenge = authUrl.searchParams.get("code_challenge");
  expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
  const code = "code-" + randomBytes(8).toString("hex");
  idp.codes.set(code, {
    nonce,
    challenge,
    email: claims.email,
    emailVerified: claims.emailVerified ?? true,
    name: claims.name,
    sub: claims.sub ?? "sub-" + claims.email,
    nonceOverride: claims.nonceOverride,
  });
  const cb = await app.inject({
    method: "GET",
    url: `/auth/oidc/callback?code=${code}&state=${encodeURIComponent(opts.tamperState ?? state)}`,
    headers: bindingHeader,
  });
  return { cb, state, nonce, binding: binding! };
};
/**
 * SUITE-ORDER ISOLATION. The whole gateway suite shares ONE database
 * (vitest.config.ts turns file parallelism off for exactly that reason) and
 * vitest orders files by their cached previous-run duration, so ANY file may
 * run before this one. Two pieces of state are global and would otherwise let
 * a neighbour decide whether this file passes:
 *
 *  1. `org_settings` is a SINGLETON row (ORG_SETTINGS_ID = "singleton").
 *  2. The set of ENABLED SSO providers — which the ADR-0036 lockout guard
 *     counts across OIDC *and* SAML together — decides whether `sso_only` may
 *     be engaged at all.
 *
 * So: every provider this file creates is tracked and deleted at the end, the
 * singleton is snapshotted and restored, and the `sso_only` block below
 * establishes its own precondition (zero enabled providers of either family)
 * instead of assuming a fresh database. group-role-mapping.test.ts is the
 * model for the cleanup half.
 */
const createdOidcProviderIds = new Set<string>();
let orgSettingsSnapshot: OrgSettingsRow | null = null;

const mkProvider = async (payload: Record<string, unknown>) => {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/auth/oidc-providers",
    payload: {
      issuerUrl: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      ...payload,
    },
  });
  expect(r.statusCode).toBe(201);
  const row = r.json();
  createdOidcProviderIds.add(row.id);
  return row;
};

beforeAll(async () => {
  const { runMigrations } = await import("@regulait/db");
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await startIdp();
  // ADR-0043 — the OIDC issuer URL is now behind the default-deny egress
  // guard (same table, same opt-ins as every other guarded surface). The fake
  // IdP is plaintext http on loopback, so this suite allow-lists 127.0.0.1
  // with the private-range and plaintext opt-ins, exactly as an air-gapped
  // operator with a self-hosted Keycloak would (the ADR-0034 suite pattern).
  const egressAllowed = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/egress-allow-hosts",
    payload: {
      host: "127.0.0.1",
      allowPrivateRanges: true,
      allowPlaintextHttp: true,
      note: "auth suite: local fake OIDC IdP",
    },
  });
  expect(egressAllowed.statusCode).toBe(201);
  // snapshot the shared singleton so whatever this file flips is handed back
  // exactly as it was found (see the SUITE-ORDER ISOLATION note above)
  const [settings] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  orgSettingsSnapshot = settings ?? null;
}, 120_000);

afterAll(async () => {
  // Providers first, settings second: the rows go out through the DB (not the
  // API), so the no-lockout guard can never refuse this file's own cleanup.
  if (createdOidcProviderIds.size > 0) {
    await db.delete(oidcProviders).where(inArray(oidcProviders.id, [...createdOidcProviderIds]));
  }
  if (orgSettingsSnapshot) {
    await db
      .update(orgSettings)
      .set(orgSettingsSnapshot)
      .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  }
  await app.close();
  await new Promise<void>((resolve) => idp.server?.close(() => resolve()) ?? resolve());
});

// ===========================================================================
describe("password login + server-side sessions", () => {
  let uid: string;
  const EMAIL = "pat@auth-test.example";
  const PW = "correct-horse-Battery1";

  beforeAll(async () => {
    uid = await mkUser(EMAIL, "Pat Password");
  });

  it("a fresh (migrated) user is passwordless — password login is impossible", async () => {
    const r = await login(EMAIL, "anything-at-all-1A");
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: "invalid_credentials", detail: "email or password is incorrect" });
  });

  it("admin issues a ONE-TIME password (returned exactly once, must-change set)", async () => {
    const r = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${uid}/set-initial-password`, payload: {},
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().password).toMatch(/^Rg1-/);
    expect(r.json().mustChangePassword).toBe(true);
    // a second issue without force refuses — the user already has a password
    const again = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${uid}/set-initial-password`, payload: {},
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("password_already_set");
  });

  it("must-change gate: the one-time password signs in but everything except auth self-service is 403", async () => {
    const oneTime = await setInitialPassword(uid, true);
    const r = await login(EMAIL, oneTime);
    expect(r.statusCode).toBe(200);
    expect(r.json().mustChangePassword).toBe(true);
    const cookie = cookieOf(r);
    // blocked: an ordinary API read
    const blocked = await app.inject({ method: "GET", url: "/v1/me", cookies: { regulait_session: cookie } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe("password_change_required");
    // allowed: the self-service surface
    const meRes = await me(cookie);
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().mustChangePassword).toBe(true);
    // weak new password rejected by policy (12 min length default)
    const weak = await changePassword(cookie, oneTime, "short1A");
    expect(weak.statusCode).toBe(422);
    expect(weak.json().error).toBe("password_policy");
    // a compliant change clears the gate
    const change = await changePassword(cookie, oneTime, PW);
    expect(change.statusCode).toBe(200);
    const open = await app.inject({ method: "GET", url: "/v1/me", cookies: { regulait_session: cookie } });
    expect(open.statusCode).toBe(200);
    expect(open.json().userId).toBe(uid);
  });

  it("session resolves to the same authCtx shape the API key path produces", async () => {
    const r = await login(EMAIL, PW);
    const cookie = cookieOf(r);
    const viaSession = await app.inject({ method: "GET", url: "/v1/me", cookies: { regulait_session: cookie } });
    expect(viaSession.statusCode).toBe(200);
    expect(viaSession.json().userId).toBe(uid);
    expect(viaSession.json().isAdmin).toBe(false);
  });

  it("logout revokes the session server-side and clears the cookie", async () => {
    const cookie = cookieOf(await login(EMAIL, PW));
    const out = await app.inject({
      method: "POST", url: "/auth/logout", headers: CSRF, cookies: { regulait_session: cookie },
    });
    expect(out.statusCode).toBe(200);
    const cleared = out.cookies.find((c) => c.name === "regulait_session");
    expect(cleared?.value).toBe("");
    const dead = await me(cookie);
    expect(dead.statusCode).toBe(401);
  });

  it("absolute expiry: a session past its lifetime wall is dead", async () => {
    const cookie = cookieOf(await login(EMAIL, PW));
    await db
      .update(authSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authSessions.userId, uid));
    const dead = await me(cookie);
    expect(dead.statusCode).toBe(401);
  });

  it("idle expiry: a session past its idle wall is dead, and use slides the wall", async () => {
    const cookie = cookieOf(await login(EMAIL, PW));
    // live use slides idle_expires_at forward
    const [before] = await db
      .select()
      .from(authSessions)
      .where(and(eq(authSessions.userId, uid), sql`revoked_at is null`))
      .orderBy(desc(authSessions.createdAt))
      .limit(1);
    await me(cookie);
    const [after] = await db.select().from(authSessions).where(eq(authSessions.id, before!.id));
    expect(after!.idleExpiresAt.getTime()).toBeGreaterThanOrEqual(before!.idleExpiresAt.getTime());
    // an idle-expired session is refused even inside the absolute lifetime
    await db
      .update(authSessions)
      .set({ idleExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(authSessions.id, before!.id));
    const dead = await me(cookie);
    expect(dead.statusCode).toBe(401);
  });

  it("admin session revocation kills a live session immediately", async () => {
    const cookie = cookieOf(await login(EMAIL, PW));
    const r = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${uid}/sessions/revoke`, payload: {},
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().revoked).toBeGreaterThanOrEqual(1);
    expect(await latestAudit("sessions-revoked-by-admin")).toBeTruthy();
    const dead = await me(cookie);
    expect(dead.statusCode).toBe(401);
  });

  it("a disabled user's live session dies at resolve (ADR-0022 parity)", async () => {
    const cookie = cookieOf(await login(EMAIL, PW));
    const dis = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${uid}/deactivate`, payload: {} });
    expect(dis.statusCode).toBe(200);
    const dead = await app.inject({ method: "GET", url: "/v1/me", cookies: { regulait_session: cookie } });
    expect(dead.statusCode).toBe(401);
    expect(dead.json().error).toBe("user_disabled");
    // and password login is refused with the UNIFORM error (no oracle)
    const refused = await login(EMAIL, PW);
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error).toBe("invalid_credentials");
    await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${uid}/reactivate`, payload: {} });
  });

  it("change-password revokes every OTHER session but keeps the current one", async () => {
    const cookieA = cookieOf(await login(EMAIL, PW));
    const cookieB = cookieOf(await login(EMAIL, PW));
    const NEW = "an-Entirely-new-pw-2";
    const r = await changePassword(cookieA, PW, NEW);
    expect(r.statusCode).toBe(200);
    expect((await me(cookieA)).statusCode).toBe(200); // survives
    expect((await me(cookieB)).statusCode).toBe(401); // revoked
    // restore for later tests
    const back = await changePassword(cookieA, NEW, PW);
    expect(back.statusCode).toBe(200);
  });

  it("login-with-key exchanges an API key for the SAME session cookie", async () => {
    const keyRes = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${uid}/keys`, payload: { name: "exchange" },
    });
    const token = keyRes.json().token;
    const r = await app.inject({
      method: "POST", url: "/auth/login-with-key", headers: CSRF, payload: { apiKey: token },
    });
    expect(r.statusCode).toBe(200);
    const cookie = cookieOf(r);
    const who = await me(cookie);
    expect(who.json().userId).toBe(uid);
    expect(who.json().via).toBe("session");
    // an invalid key is refused
    const bad = await app.inject({
      method: "POST", url: "/auth/login-with-key", headers: CSRF, payload: { apiKey: "rgl_nonsense" },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("the bootstrap token exchanges for an admin session that dies if bootstrap is unset", async () => {
    const r = await app.inject({
      method: "POST", url: "/auth/login-with-key", headers: CSRF, payload: { apiKey: BOOT },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().isAdmin).toBe(true);
    expect(r.json().userId).toBeNull();
    const cookie = cookieOf(r);
    const who = await me(cookie);
    expect(who.statusCode).toBe(200);
    expect(who.json().isAdmin).toBe(true);
    // an app WITHOUT a bootstrap token refuses the same session cookie
    const noBoot = buildApp(db, { dataKey: DATA_KEY });
    const dead = await noBoot.inject({ method: "GET", url: "/auth/me", cookies: { regulait_session: cookie } });
    expect(dead.statusCode).toBe(401);
    await noBoot.close();
  });
});

// ===========================================================================
describe("uniform errors + lockout", () => {
  let uid: string;
  const EMAIL = "lo@auth-test.example";
  const PW = "a-Real-password-33";

  beforeAll(async () => {
    uid = await mkUser(EMAIL, "Lo Lockout");
    await onboard(uid, EMAIL, PW);
  });

  it("unknown email and wrong password return byte-identical 401 bodies", async () => {
    const unknown = await login("nobody@auth-test.example", "whatever-Pass1");
    const wrong = await login(EMAIL, "wrong-Password11");
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.body).toBe(wrong.body);
  });

  it("failures are audited without leaking anything into the response", async () => {
    const row = await latestAudit("login-failed");
    expect(row).toBeTruthy();
    expect(row!.effect).toBe("deny");
  });

  it("5 failures inside the window engage a lockout (audited); even the CORRECT password then fails", async () => {
    // 4 more failures on top of the one from the uniform-error test
    for (let i = 0; i < 4; i++) {
      const r = await login(EMAIL, "wrong-Password11");
      expect(r.statusCode).toBe(401);
    }
    const audit = await latestAudit("login-lockout");
    expect(audit).toBeTruthy();
    expect(audit!.objectId).toBe(uid);
    const locked = await login(EMAIL, PW);
    expect(locked.statusCode).toBe(401);
    expect(locked.json().error).toBe("invalid_credentials"); // uniform, no oracle
    // lockout is TEMPORARY: clear the wall (simulating time passing) and log in
    await db.update(users).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(users.id, uid));
    const ok = await login(EMAIL, PW);
    expect(ok.statusCode).toBe(200);
  });
});

// ===========================================================================
describe("CSRF custom-header wall", () => {
  let adminCookie: string;
  let adminKey: string;
  let adminId: string;

  beforeAll(async () => {
    adminId = await mkUser("csrf-admin@auth-test.example", "Csrf Admin", true);
    adminCookie = await onboard(adminId, "csrf-admin@auth-test.example", "csrf-Admin-pw-9");
    // ADR-0181: an admin session enrols TOTP before it reaches the app
    await enrolTotpForTest(app, adminCookie);
    const k = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${adminId}/keys`, payload: { name: "csrf" },
    });
    adminKey = k.json().token;
  });

  it("a cookie-authenticated mutation WITHOUT the header is 403", async () => {
    const r = await app.inject({
      method: "POST", url: "/v1/users",
      cookies: { regulait_session: adminCookie },
      payload: { email: "x1@auth-test.example", displayName: "X" },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("csrf_header_required");
  });

  it("the same mutation WITH the header succeeds", async () => {
    const r = await app.inject({
      method: "POST", url: "/v1/users", headers: CSRF,
      cookies: { regulait_session: adminCookie },
      payload: { email: "x2@auth-test.example", displayName: "X2" },
    });
    expect(r.statusCode).toBe(201);
  });

  it("cookie-authenticated GETs need no header; API-key mutations need no header either", async () => {
    const read = await app.inject({ method: "GET", url: "/v1/users", cookies: { regulait_session: adminCookie } });
    expect(read.statusCode).toBe(200);
    const keyed = await app.inject({
      method: "POST", url: "/v1/users",
      headers: { authorization: `Bearer ${adminKey}` }, // no CSRF header at all
      payload: { email: "x3@auth-test.example", displayName: "X3" },
    });
    expect(keyed.statusCode).toBe(201);
  });

  it("the login endpoint itself requires the header (login-CSRF hardening)", async () => {
    const r = await app.inject({
      method: "POST", url: "/auth/login",
      payload: { email: "whoever@auth-test.example", password: "irrelevant-Pw1" },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("csrf_header_required");
  });
});

// ===========================================================================
describe("TOTP MFA", () => {
  let uid: string;
  let secret: string;
  const EMAIL = "totp@auth-test.example";
  const PW = "totp-User-pw-77";

  beforeAll(async () => {
    uid = await mkUser(EMAIL, "Toni Totp");
    await onboard(uid, EMAIL, PW);
  });

  it("self-service enroll returns the secret + otpauth URI once; activation needs a valid code", async () => {
    const cookie = cookieOf(await login(EMAIL, PW));
    const enroll = await app.inject({
      method: "POST", url: "/auth/totp/enroll", headers: CSRF, cookies: { regulait_session: cookie },
    });
    expect(enroll.statusCode).toBe(200);
    secret = enroll.json().secret;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(enroll.json().otpauthUri).toContain("otpauth://totp/");
    // a wrong code does not activate
    const bad = await app.inject({
      method: "POST", url: "/auth/totp/activate", headers: CSRF, cookies: { regulait_session: cookie },
      payload: { code: "000000" },
    });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({
      method: "POST", url: "/auth/totp/activate", headers: CSRF, cookies: { regulait_session: cookie },
      payload: { code: totpCode(secret, totpStep()) },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().totpEnabled).toBe(true);
  });

  it("login becomes two-step: password alone yields a pending token, no cookie", async () => {
    const r = await login(EMAIL, PW);
    expect(r.statusCode).toBe(200);
    expect(r.json().mfaRequired).toBe(true);
    expect(r.json().pendingToken).toBeTruthy();
    expect(r.cookies.find((c) => c.name === "regulait_session")).toBeUndefined();
  });

  it("the code completes the login; a CONSUMED code cannot be replayed in its window", async () => {
    const pending = (await login(EMAIL, PW)).json().pendingToken;
    // activation just burned the CURRENT step (replay protection working as
    // designed) — use the next step, which the ±1 skew window accepts
    const code = totpCode(secret, totpStep() + 1);
    const ok = await app.inject({
      method: "POST", url: "/auth/mfa/verify", headers: CSRF,
      payload: { pendingToken: pending, code },
    });
    expect(ok.statusCode).toBe(200);
    cookieOf(ok);
    // replay: same code, fresh pending token — refused (step already burned)
    const pending2 = (await login(EMAIL, PW)).json().pendingToken;
    const replay = await app.inject({
      method: "POST", url: "/auth/mfa/verify", headers: CSRF,
      payload: { pendingToken: pending2, code },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe("invalid_code");
  });

  it("a garbage pending token or wrong code is refused", async () => {
    const bogus = await app.inject({
      method: "POST", url: "/auth/mfa/verify", headers: CSRF,
      payload: { pendingToken: "rgls_" + "0".repeat(64), code: "123456" },
    });
    expect(bogus.statusCode).toBe(401);
    const pending = (await login(EMAIL, PW)).json().pendingToken;
    const wrong = await app.inject({
      method: "POST", url: "/auth/mfa/verify", headers: CSRF,
      payload: { pendingToken: pending, code: "000000" },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it("admin MFA recovery requires a reason, clears enrollment, and is audited", async () => {
    const noReason = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${uid}/mfa/clear`, payload: {},
    });
    expect(noReason.statusCode).toBe(400); // zod: reason required
    const r = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${uid}/mfa/clear`,
      payload: { reason: "lost authenticator — verified identity out of band" },
    });
    expect(r.statusCode).toBe(200);
    const audit = await latestAudit("mfa-cleared-by-admin");
    expect(audit).toBeTruthy();
    expect(audit!.reason).toContain("lost authenticator");
    // login is single-step again
    const back = await login(EMAIL, PW);
    expect(back.statusCode).toBe(200);
    expect(back.json().mfaRequired).toBeUndefined();
    cookieOf(back);
  });
});

// ===========================================================================
describe("OIDC SSO (fake IdP: discovery + jwks + token)", () => {
  it("provider CRUD: secrets are write-only, never returned", async () => {
    const p = await mkProvider({ name: "crud-check" });
    expect(JSON.stringify(p)).not.toContain(idp.clientSecret);
    const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/auth/oidc-providers" });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toContain(idp.clientSecret);
    expect(JSON.stringify(list.json())).not.toContain("iphertext");
    const del = await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/auth/oidc-providers/${p.id}` });
    expect(del.statusCode).toBe(200);
  });

  it("the login screen's provider list is public and names-only", async () => {
    const p = await mkProvider({ name: "public-list" });
    const r = await app.inject({ method: "GET", url: "/auth/oidc/providers" });
    expect(r.statusCode).toBe(200);
    const entry = r.json().providers.find((x: { id: string }) => x.id === p.id);
    expect(entry).toEqual({ id: p.id, name: "public-list" });
    await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/auth/oidc-providers/${p.id}` });
  });

  it("full code+PKCE flow: an EXISTING user signs in and gets the same session cookie", async () => {
    const uid = await mkUser("sso-user@auth-test.example", "Sso User");
    const p = await mkProvider({ name: "full-flow" });
    const { cb } = await oidcRoundTrip(p.id, { email: "sso-user@auth-test.example" });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe("/app");
    expect(idp.lastVerifierOk).toBe(true); // PKCE verifier reached the IdP and matched
    const cookie = cookieOf(cb);
    const who = await app.inject({ method: "GET", url: "/v1/me", cookies: { regulait_session: cookie } });
    expect(who.statusCode).toBe(200);
    expect(who.json().userId).toBe(uid);
    await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/auth/oidc-providers/${p.id}` });
  });

  it("state is validated and single-use; a tampered state never reaches the IdP", async () => {
    const p = await mkProvider({ name: "state-check" });
    const before = idp.tokenCalls;
    const { cb } = await oidcRoundTrip(p.id, { email: "sso-user@auth-test.example" }, { tamperState: "forged-state" });
    expect(cb.statusCode).toBe(401);
    expect(cb.json().error).toBe("invalid_or_expired_state");
    expect(idp.tokenCalls).toBe(before); // no token exchange happened
    // single-use: a completed state cannot be replayed
    const { cb: ok, state } = await oidcRoundTrip(p.id, { email: "sso-user@auth-test.example" });
    expect(ok.statusCode).toBe(302);
    const replay = await app.inject({ method: "GET", url: `/auth/oidc/callback?code=whatever&state=${state}` });
    expect(replay.statusCode).toBe(401);
    await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/auth/oidc-providers/${p.id}` });
  });

  it("ADR-0167 (AUTHZ-04): a callback carried by a DIFFERENT browser is refused before the token exchange, audited, and the state is spent", async () => {
    const p = await mkProvider({ name: "binding-check" });
    const before = idp.tokenCalls;
    // the login-CSRF shape: the attacker started the flow (and holds the
    // binding cookie); the victim's browser follows the callback URL without it
    const { cb, state, binding } = await oidcRoundTrip(p.id, { email: "sso-user@auth-test.example" }, { dropBindingCookie: true });
    expect(cb.statusCode).toBe(401);
    expect(cb.json().error).toBe("login_not_bound_to_this_browser");
    expect(cb.cookies.find((c) => c.name === "regulait_session")).toBeUndefined();
    expect(idp.tokenCalls).toBe(before); // refused before any exchange
    const row = await latestAudit("oidc-login-browser-mismatch");
    expect(row).toBeTruthy();
    expect((row!.detail as { bindingCookiePresent?: boolean }).bindingCookiePresent).toBe(false);
    // the state was consumed by the refusal: the attacker cannot try again with it
    const replay = await app.inject({
      method: "GET",
      url: `/auth/oidc/callback?code=whatever&state=${state}`,
      headers: { cookie: `regulait_oidc_login=${binding.value}` },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe("invalid_or_expired_state");
    // a forged binding value is a mismatch too — only the HMAC under the data key matches
    const forged = await oidcRoundTrip(p.id, { email: "sso-user@auth-test.example" }, { bindingCookieOverride: "not-the-hmac" });
    expect(forged.cb.statusCode).toBe(401);
    expect(forged.cb.json().error).toBe("login_not_bound_to_this_browser");
    // the cookie itself: scoped to the login path, HttpOnly, Lax (a top-level GET callback carries it)
    const start = await app.inject({ method: "GET", url: `/auth/oidc/${p.id}/start?returnTo=/app` });
    const setCookie = ([] as string[]).concat(start.headers["set-cookie"] as string | string[]).join("\n");
    expect(setCookie).toContain("regulait_oidc_login=");
    expect(setCookie).toContain("Path=/auth/oidc");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/auth/oidc-providers/${p.id}` });
  });

  it("a wrong nonce in the id_token fails validation (audited)", async () => {
    const p = await mkProvider({ name: "nonce-check" });
    const { cb } = await oidcRoundTrip(p.id, { email: "sso-user@auth-test.example", nonceOverride: "evil-nonce" });
    expect(cb.statusCode).toBe(401);
    expect(cb.json().error).toBe("oidc_validation_failed");
    expect(await latestAudit("oidc-login-failed")).toBeTruthy();
    await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/auth/oidc-providers/${p.id}` });
  });

  it("an unverified email claim is refused", async () => {
    const p = await mkProvider({ name: "verified-check" });
    const { cb } = await oidcRoundTrip(p.id, { email: "sso-user@auth-test.example", emailVerified: false });
    expect(cb.statusCode).toBe(403);
    expect(cb.json().error).toBe("email_not_verified");
    await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/auth/oidc-providers/${p.id}` });
  });

  it("the domain filter refuses emails outside the allow-list", async () => {
    const p = await mkProvider({ name: "domain-check", allowedEmailDomains: ["auth-test.example"] });
    const { cb } = await oidcRoundTrip(p.id, { email: "eve@evil.example" });
    expect(cb.statusCode).toBe(403);
    expect(cb.json().error).toBe("email_domain_not_allowed");
    expect(await latestAudit("oidc-domain-refused")).toBeTruthy();
    await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/auth/oidc-providers/${p.id}` });
  });

  it("JIT OFF (default-deny): an unknown subject is 403'd and audited, no user created", async () => {
    const p = await mkProvider({ name: "jit-off" });
    const { cb } = await oidcRoundTrip(p.id, { email: "stranger@auth-test.example" });
    expect(cb.statusCode).toBe(403);
    expect(cb.json().error).toBe("unknown_user");
    expect(await latestAudit("oidc-unknown-subject")).toBeTruthy();
    const [row] = await db.select().from(users).where(eq(users.email, "stranger@auth-test.example"));
    expect(row).toBeUndefined();
    await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/auth/oidc-providers/${p.id}` });
  });

  it("JIT ON: the user is provisioned with the default role, NEVER admin, and audited", async () => {
    const roleRes = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/roles", payload: { name: "sso-baseline" },
    });
    const roleId = roleRes.json().id;
    const p = await mkProvider({ name: "jit-on", jitProvisioning: true, allowedEmailDomains: ["auth-test.example"], defaultRoleId: roleId });
    const { cb } = await oidcRoundTrip(p.id, { email: "newcomer@auth-test.example", name: "New Comer" });
    expect(cb.statusCode).toBe(302);
    const [row] = await db.select().from(users).where(eq(users.email, "newcomer@auth-test.example"));
    expect(row).toBeTruthy();
    expect(row!.isAdmin).toBe(false);
    expect(row!.displayName).toBe("New Comer");
    const assigned = await db
      .select()
      .from(roleAssignments)
      .where(and(eq(roleAssignments.userId, row!.id), eq(roleAssignments.roleId, roleId)));
    expect(assigned).toHaveLength(1);
    expect(await latestAudit("oidc-user-provisioned")).toBeTruthy();
    // second login: same user, no duplicate
    const again = await oidcRoundTrip(p.id, { email: "newcomer@auth-test.example" });
    expect(again.cb.statusCode).toBe(302);
    const all = await db.select().from(users).where(eq(users.email, "newcomer@auth-test.example"));
    expect(all).toHaveLength(1);
    await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/auth/oidc-providers/${p.id}` });
  });
});

// ===========================================================================
describe("sso_only", () => {
  // These assertions are about a COUNT of enabled SSO providers, so they only
  // mean anything against a known starting count. Any earlier file (saml.test
  // .ts, group-role-mapping.test.ts, mcp-oidc-egress.test.ts) may have left
  // enabled providers behind, and vitest's duration-ordered file scheduling
  // decides which of them ran first — so establish the precondition here
  // rather than inheriting it, and hand back exactly what was borrowed.
  const borrowedOidcIds: string[] = [];
  const borrowedSamlIds: string[] = [];

  beforeAll(async () => {
    // ssoOnly off first: while it is on, disabling the last door is refused.
    await db.update(orgSettings).set({ ssoOnly: false }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    const oidcOn = await db
      .select({ id: oidcProviders.id })
      .from(oidcProviders)
      .where(eq(oidcProviders.enabled, true));
    const samlOn = await db
      .select({ id: samlProviders.id })
      .from(samlProviders)
      .where(eq(samlProviders.enabled, true));
    borrowedOidcIds.push(...oidcOn.map((p) => p.id));
    borrowedSamlIds.push(...samlOn.map((p) => p.id));
    if (borrowedOidcIds.length > 0) {
      await db
        .update(oidcProviders)
        .set({ enabled: false })
        .where(inArray(oidcProviders.id, borrowedOidcIds));
    }
    if (borrowedSamlIds.length > 0) {
      await db
        .update(samlProviders)
        .set({ enabled: false })
        .where(inArray(samlProviders.id, borrowedSamlIds));
    }
  });

  afterAll(async () => {
    // never leave sso_only engaged for a later file — a stuck dial 403s every
    // password login in the suite
    await db.update(orgSettings).set({ ssoOnly: false }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    if (borrowedOidcIds.length > 0) {
      await db
        .update(oidcProviders)
        .set({ enabled: true })
        .where(inArray(oidcProviders.id, borrowedOidcIds));
    }
    if (borrowedSamlIds.length > 0) {
      await db
        .update(samlProviders)
        .set({ enabled: true })
        .where(inArray(samlProviders.id, borrowedSamlIds));
    }
  });

  it("cannot be enabled while zero enabled OIDC providers exist", async () => {
    const r = await app.inject({
      method: "PUT", headers: AUTH, url: "/v1/org/settings", payload: { ssoOnly: true },
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("sso_only_needs_a_provider");
  });

  it("blocks password login with a 403 while on; disabling the last provider is refused", async () => {
    const p = await mkProvider({ name: "sso-only-anchor" });
    const on = await app.inject({
      method: "PUT", headers: AUTH, url: "/v1/org/settings", payload: { ssoOnly: true },
    });
    expect(on.statusCode).toBe(200);
    const blocked = await login("pat@auth-test.example", "correct-horse-Battery1");
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe("sso_required");
    // no-lockout guard: the last enabled provider cannot be disabled or deleted
    const dis = await app.inject({
      method: "PATCH", headers: AUTH, url: `/v1/auth/oidc-providers/${p.id}`, payload: { enabled: false },
    });
    expect(dis.statusCode).toBe(409);
    const del = await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/auth/oidc-providers/${p.id}` });
    expect(del.statusCode).toBe(409);
    // turn it back off; cleanup
    const off = await app.inject({
      method: "PUT", headers: AUTH, url: "/v1/org/settings", payload: { ssoOnly: false },
    });
    expect(off.statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/auth/oidc-providers/${p.id}` })).statusCode).toBe(200);
  });
});

// ===========================================================================
describe("API-key path regression (byte-identical to pre-0042)", () => {
  let uid: string;
  let key: string;

  beforeAll(async () => {
    uid = await mkUser("keyer@auth-test.example", "Key User");
    const k = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${uid}/keys`, payload: { name: "regression" },
    });
    key = k.json().token;
  });

  it("bearer-key requests work with no cookie, no CSRF header, and touch lastUsedAt", async () => {
    const r = await app.inject({
      method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${key}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().userId).toBe(uid);
  });

  it("a header credential WINS over a stale cookie riding along", async () => {
    const r = await app.inject({
      method: "GET", url: "/v1/me",
      headers: { authorization: `Bearer ${key}` },
      cookies: { regulait_session: "rgls_" + "f".repeat(64) }, // garbage cookie
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().userId).toBe(uid);
  });

  it("an invalid bearer is 401 unauthenticated exactly as before", async () => {
    const r = await app.inject({
      method: "GET", url: "/v1/me", headers: { authorization: "Bearer rgl_bogus" },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: "unauthenticated" });
  });

  it("mfa_required=all gates SESSION users into enrollment — and, since ADR-0181 FX2, their API keys too", async () => {
    const on = await app.inject({
      method: "PUT", headers: AUTH, url: "/v1/org/settings", payload: { mfaRequired: "all" },
    });
    expect(on.statusCode).toBe(200);
    try {
      // key path: an un-enrolled person's key answers to the same dial
      // (ADR-0181 FX2 — it used to be untouched, which made a key a way around MFA)
      const keyed = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${key}` } });
      expect(keyed.statusCode).toBe(403);
      expect(keyed.json().error).toBe("mfa_enrollment_required");
      // session path: gated until enrolled
      const pw = "keyer-Password-55";
      const cookie = await onboard(uid, "keyer@auth-test.example", pw);
      const gated = await app.inject({ method: "GET", url: "/v1/me", cookies: { regulait_session: cookie } });
      expect(gated.statusCode).toBe(403);
      expect(gated.json().error).toBe("mfa_enrollment_required");
      // /auth/me still reachable and says so
      const meRes = await me(cookie);
      expect(meRes.statusCode).toBe(200);
      expect(meRes.json().mfaSetupRequired).toBe(true);
    } finally {
      // back to the shipped strict default (ADR-0181), not to off (M-068)
      const back = await app.inject({
        method: "PUT", headers: AUTH, url: "/v1/org/settings", payload: { mfaRequired: "admins" },
      });
      expect(back.statusCode).toBe(200);
    }
    // under the default ('admins') this member's key works again
    const keyed = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${key}` } });
    expect(keyed.statusCode).toBe(200);
  });
});

// ===========================================================================
// ADR-0028 (migration 0046) — session origin + the forced-password-change
// LOCKOUT fix. A user who signed in with POST /auth/login-with-key onto an
// account with must_change_password = true was sent to a gate demanding the
// CURRENT one-time password they were never given, with every non-self-service
// route 403'd behind that same gate. The fix relaxes the current-password
// requirement ONLY for an api_key-origin session on a recovery-state account;
// the steady state is untouched, because relaxing THAT would turn a stolen key
// into a permanent password that outlives the key's revocation.
// ===========================================================================
describe("ADR-0028 — session origin + API-key password recovery", () => {
  const NEWPW = "brand-New-Password-42";
  const OTHERPW = "second-New-Password-43";

  const mkKey = async (userId: string, name: string): Promise<string> => {
    const r = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${userId}/keys`, payload: { name },
    });
    expect(r.statusCode).toBe(201);
    return r.json().token;
  };
  const keyLogin = async (apiKey: string) => {
    const r = await app.inject({
      method: "POST", url: "/auth/login-with-key", headers: CSRF, payload: { apiKey },
    });
    expect(r.statusCode).toBe(200);
    return r;
  };
  /** POST /auth/change-password with an arbitrary payload (currentPassword is
   * optional on the wire now — the SERVER decides whether it is required) */
  const setPw = (cookie: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "POST", url: "/auth/change-password", headers: CSRF,
      cookies: { regulait_session: cookie }, payload,
    });
  const originOf = async (cookie: string) => {
    const [row] = await db
      .select({ origin: authSessions.origin })
      .from(authSessions)
      .where(eq(authSessions.tokenHash, hashToken(cookie)));
    return row?.origin ?? null;
  };
  /** put a live session back into the pre-0046 state the migration backfilled */
  const forceOrigin = (cookie: string, origin: "password" | "api_key" | "oidc" | "bootstrap" | "unknown") =>
    db.update(authSessions).set({ origin }).where(eq(authSessions.tokenHash, hashToken(cookie)));
  /** the exact state the owner hit: one-time password issued, signed in by key */
  const keySessionOnOneTimeAccount = async (email: string, name: string) => {
    const uid = await mkUser(email, name);
    await setInitialPassword(uid);
    const key = await mkKey(uid, "recovery");
    const cookie = cookieOf(await keyLogin(key));
    return { uid, key, cookie };
  };

  // ---- origin is recorded by every session-creation site -------------------

  it("password login records origin 'password'", async () => {
    const email = "origin-pw@auth-test.example";
    const uid = await mkUser(email, "Origin Password");
    const cookie = await onboard(uid, email, NEWPW);
    expect(await originOf(cookie)).toBe("password");
  });

  it("an MFA-completed login is still 'password' origin (the 2nd factor is not the credential)", async () => {
    const email = "origin-mfa@auth-test.example";
    const pw = "origin-Mfa-pw-88";
    const uid = await mkUser(email, "Origin Mfa");
    const first = await onboard(uid, email, pw);
    const enroll = await app.inject({
      method: "POST", url: "/auth/totp/enroll", headers: CSRF, cookies: { regulait_session: first },
    });
    expect(enroll.statusCode).toBe(200);
    const secret = enroll.json().secret;
    const act = await app.inject({
      method: "POST", url: "/auth/totp/activate", headers: CSRF, cookies: { regulait_session: first },
      payload: { code: totpCode(secret, totpStep()) },
    });
    expect(act.statusCode).toBe(200);
    const pending = (await login(email, pw)).json().pendingToken;
    const verified = await app.inject({
      method: "POST", url: "/auth/mfa/verify", headers: CSRF,
      // activation burned the current step; the ±1 window accepts the next
      payload: { pendingToken: pending, code: totpCode(secret, totpStep() + 1) },
    });
    expect(verified.statusCode).toBe(200);
    expect(await originOf(cookieOf(verified))).toBe("password");
    expect(uid).toBeTruthy();
  });

  it("login-with-key records origin 'api_key'; the bootstrap token records 'bootstrap'", async () => {
    const uid = await mkUser("origin-key@auth-test.example", "Origin Key");
    const key = await mkKey(uid, "origin");
    const keyed = await keyLogin(key);
    expect(await originOf(cookieOf(keyed))).toBe("api_key");
    // the deploy-time bootstrap token is a DIFFERENT credential and gets its
    // own origin — it never opens the api_key bypass
    const boot = await keyLogin(BOOT);
    const bootCookie = cookieOf(boot);
    expect(await originOf(bootCookie)).toBe("bootstrap");
    const bootMe = await me(bootCookie);
    expect(bootMe.json().userId).toBeNull();
    expect(bootMe.json().passwordChangeRequiresCurrent).toBe(true);
  });

  it("the OIDC callback records origin 'oidc'", async () => {
    const provider = await mkProvider({ name: "origin-oidc-idp", jitProvisioning: true, allowedEmailDomains: ["auth-test.example"] });
    const { cb } = await oidcRoundTrip(provider.id, { email: "origin-oidc@auth-test.example" });
    expect(cb.statusCode).toBe(302);
    expect(await originOf(cookieOf(cb))).toBe("oidc");
    expect(
      (await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/auth/oidc-providers/${provider.id}` })).statusCode,
    ).toBe(200);
  });

  it("the DB refuses an origin outside the allowed set (0046 CHECK constraint)", async () => {
    await expect(
      db.execute(
        sql`insert into auth_sessions (token_hash, user_id, expires_at, idle_expires_at, idle_minutes, origin)
            values ('ck-probe-0046', null, now() + interval '1 hour', now() + interval '1 hour', 30, 'sso')`,
      ),
    ).rejects.toThrow();
  });

  // ---- THE LOCKOUT: bypass allowed in the recovery states ------------------

  it("api_key session + must_change: a password is set WITHOUT the current one, and the gate opens", async () => {
    const { uid, cookie } = await keySessionOnOneTimeAccount("lockout-a@auth-test.example", "Lock A");
    // the gate is closed exactly as the owner saw it
    const gated = await app.inject({ method: "GET", url: "/v1/me", cookies: { regulait_session: cookie } });
    expect(gated.statusCode).toBe(403);
    expect(gated.json().error).toBe("password_change_required");
    // /auth/me tells the UI the field is not needed
    const before = await me(cookie);
    expect(before.json().mustChangePassword).toBe(true);
    expect(before.json().sessionOrigin).toBe("api_key");
    expect(before.json().passwordChangeRequiresCurrent).toBe(false);
    // ... and the server agrees
    const done = await setPw(cookie, { newPassword: NEWPW });
    expect(done.statusCode).toBe(200);
    // the gate is open and the account now has a real password
    const open = await app.inject({ method: "GET", url: "/v1/me", cookies: { regulait_session: cookie } });
    expect(open.statusCode).toBe(200);
    expect(open.json().userId).toBe(uid);
    const after = await me(cookie);
    expect(after.json().mustChangePassword).toBe(false);
    expect(after.json().passwordSet).toBe(true);
    // and the new password really is the one that was set
    expect((await login("lockout-a@auth-test.example", NEWPW)).statusCode).toBe(200);
  });

  it("the bypass is audited under its OWN rule id, naming the origin and the recovery condition", async () => {
    const { uid, cookie } = await keySessionOnOneTimeAccount("lockout-b@auth-test.example", "Lock B");
    expect((await setPw(cookie, { newPassword: NEWPW })).statusCode).toBe(200);
    const row = await latestAudit("password-set-via-key-session");
    expect(row).toBeTruthy();
    expect(row!.objectId).toBe(uid);
    expect(row!.effect).toBe("allow");
    const detail = row!.detail as Record<string, unknown>;
    expect(detail.sessionOrigin).toBe("api_key");
    expect(detail.recoveryCondition).toBe("must_change_password");
    expect(detail.currentPasswordRequired).toBe(false);
    expect(detail.email).toBe("lockout-b@auth-test.example");
  });

  it("api_key session + NO password hash: a password is set without a current one (was a 409 dead end)", async () => {
    const email = "lockout-c@auth-test.example";
    const uid = await mkUser(email, "Lock C");
    const cookie = cookieOf(await keyLogin(await mkKey(uid, "recovery")));
    const before = await me(cookie);
    expect(before.json().passwordSet).toBe(false);
    expect(before.json().passwordChangeRequiresCurrent).toBe(false);
    const done = await setPw(cookie, { newPassword: NEWPW });
    expect(done.statusCode).toBe(200);
    const row = await latestAudit("password-set-via-key-session");
    expect((row!.detail as Record<string, unknown>).recoveryCondition).toBe("no_password_hash");
    expect((await login(email, NEWPW)).statusCode).toBe(200);
  });

  it("the key-session password set still revokes every OTHER session", async () => {
    const email = "lockout-d@auth-test.example";
    const uid = await mkUser(email, "Lock D");
    await setInitialPassword(uid);
    const key = await mkKey(uid, "recovery");
    const doomed = cookieOf(await keyLogin(key));
    const survivor = cookieOf(await keyLogin(key));
    expect((await setPw(survivor, { newPassword: NEWPW })).statusCode).toBe(200);
    expect((await me(doomed)).statusCode).toBe(401);
    expect((await me(survivor)).statusCode).toBe(200);
  });

  // ---- THE GUARD: the steady state is untouched ---------------------------

  it("ESCALATION GUARD: api_key session + established password + no forced change STILL requires the current password", async () => {
    const email = "steady@auth-test.example";
    const uid = await mkUser(email, "Steady State");
    await onboard(uid, email, NEWPW); // real password, must_change cleared
    const cookie = cookieOf(await keyLogin(await mkKey(uid, "stolen-key-simulation")));
    expect(await originOf(cookie)).toBe("api_key");
    // /auth/me and the server agree: the key alone is NOT enough here
    const probe = await me(cookie);
    expect(probe.json().mustChangePassword).toBe(false);
    expect(probe.json().passwordSet).toBe(true);
    expect(probe.json().passwordChangeRequiresCurrent).toBe(true);
    const bare = await setPw(cookie, { newPassword: OTHERPW });
    expect(bare.statusCode).toBe(401);
    expect(bare.json().error).toBe("current_password_required");
    // the old password still works — nothing was changed
    expect((await login(email, NEWPW)).statusCode).toBe(200);
    // proving the current password is the ONLY way through
    const ok = await setPw(cookie, { currentPassword: NEWPW, newPassword: OTHERPW });
    expect(ok.statusCode).toBe(200);
    expect((await login(email, OTHERPW)).statusCode).toBe(200);
  });

  it("a WRONG current password on that same session still 401s current_password_incorrect", async () => {
    const email = "steady-wrong@auth-test.example";
    const uid = await mkUser(email, "Steady Wrong");
    await onboard(uid, email, NEWPW);
    const cookie = cookieOf(await keyLogin(await mkKey(uid, "key")));
    const wrong = await setPw(cookie, { currentPassword: "not-the-Password-1", newPassword: OTHERPW });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toBe("current_password_incorrect");
    const rejected = await latestAudit("password-change-rejected");
    expect(rejected!.objectId).toBe(uid);
    expect((await login(email, NEWPW)).statusCode).toBe(200);
  });

  it("password-origin session + must_change: the current password is STILL required", async () => {
    const email = "pw-origin-gate@auth-test.example";
    const uid = await mkUser(email, "Pw Origin");
    const oneTime = await setInitialPassword(uid);
    const cookie = cookieOf(await login(email, oneTime));
    expect(await originOf(cookie)).toBe("password");
    const probe = await me(cookie);
    expect(probe.json().mustChangePassword).toBe(true);
    expect(probe.json().passwordChangeRequiresCurrent).toBe(true);
    const bare = await setPw(cookie, { newPassword: NEWPW });
    expect(bare.statusCode).toBe(401);
    expect(bare.json().error).toBe("current_password_required");
    // the one-time password they DO hold still works, exactly as before
    expect((await setPw(cookie, { currentPassword: oneTime, newPassword: NEWPW })).statusCode).toBe(200);
  });

  it("a pre-0046 'unknown' origin session fails CLOSED even in the recovery state", async () => {
    const { cookie } = await keySessionOnOneTimeAccount("unknown-origin@auth-test.example", "Unknown Origin");
    // exactly what migration 0046 backfilled onto every pre-existing row
    await forceOrigin(cookie, "unknown");
    const probe = await me(cookie);
    expect(probe.json().sessionOrigin).toBe("unknown");
    expect(probe.json().mustChangePassword).toBe(true);
    expect(probe.json().passwordChangeRequiresCurrent).toBe(true);
    const bare = await setPw(cookie, { newPassword: NEWPW });
    expect(bare.statusCode).toBe(401);
    expect(bare.json().error).toBe("current_password_required");
    // an oidc-origin session in the same recovery state fails closed too
    await forceOrigin(cookie, "oidc");
    expect((await me(cookie)).json().passwordChangeRequiresCurrent).toBe(true);
    expect((await setPw(cookie, { newPassword: NEWPW })).statusCode).toBe(401);
  });

  it("a header API-key request carries no session origin, so it fails closed too", async () => {
    const email = "header-key@auth-test.example";
    const uid = await mkUser(email, "Header Key");
    await setInitialPassword(uid);
    const key = await mkKey(uid, "header");
    const probe = await app.inject({
      method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${key}` },
    });
    expect(probe.json().sessionOrigin).toBeNull();
    expect(probe.json().passwordChangeRequiresCurrent).toBe(true);
    const bare = await app.inject({
      method: "POST", url: "/auth/change-password",
      headers: { authorization: `Bearer ${key}` }, payload: { newPassword: NEWPW },
    });
    expect(bare.statusCode).toBe(401);
    expect(bare.json().error).toBe("current_password_required");
  });

  it("/auth/me's boolean predicts the server's answer in every state (one rule, one source)", async () => {
    const states: Array<{ email: string; recovery: boolean }> = [
      { email: "oracle-recovery@auth-test.example", recovery: true },
      { email: "oracle-steady@auth-test.example", recovery: false },
    ];
    for (const st of states) {
      const uid = await mkUser(st.email, "Oracle");
      let cookie: string;
      if (st.recovery) {
        await setInitialPassword(uid);
        cookie = cookieOf(await keyLogin(await mkKey(uid, "oracle")));
      } else {
        await onboard(uid, st.email, NEWPW);
        cookie = cookieOf(await keyLogin(await mkKey(uid, "oracle")));
      }
      const claimed = (await me(cookie)).json().passwordChangeRequiresCurrent;
      const attempt = await setPw(cookie, { newPassword: OTHERPW });
      // claimed "not required" <=> the bare request succeeds
      expect(claimed).toBe(attempt.statusCode !== 200);
      expect(attempt.statusCode).toBe(st.recovery ? 200 : 401);
    }
  });
});

// ===========================================================================
// ADR-0030 — LOGIN BY USERNAME (migration 0047).
//
// Beyond "it works", the two invariants this block exists to hold:
//   1. ADR-0025's uniform-error invariant SURVIVES the second namespace — an
//      unknown username, an unknown email and a wrong password are one status,
//      one body, one scrypt cost;
//   2. the namespaces cannot COLLIDE — a username can never contain '@', so it
//      can never resolve as (or impersonate) somebody else's email, and case
//      folding is a property of the STORAGE, not of a code path.
// ===========================================================================
describe("ADR-0030 — login by username", () => {
  const PW = "correct-horse-Battery1";
  const dom = "@user-test.example";

  /** the NEW body shape: one identifier field, either namespace */
  const loginBy = (identifier: string, password: string) =>
    app.inject({ method: "POST", url: "/auth/login", headers: CSRF, payload: { identifier, password } });
  /** the PRE-0047 body shape, byte-for-byte what shipped clients send */
  const legacyLogin = (email: string, password: string) =>
    app.inject({ method: "POST", url: "/auth/login", headers: CSRF, payload: { email, password } });
  const setUsername = (userId: string, username: string | null) =>
    app.inject({
      method: "PUT", headers: AUTH, url: `/v1/users/${userId}/username`, payload: { username },
    });
  const selfSetUsername = (cookie: string, username: string | null) =>
    app.inject({
      method: "POST", url: "/auth/username", headers: CSRF,
      cookies: { regulait_session: cookie }, payload: { username },
    });
  const setSelfService = async (on: boolean) => {
    const r = await app.inject({
      method: "PUT", headers: AUTH, url: "/v1/org/settings", payload: { usernameSelfService: on },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().settings.usernameSelfService).toBe(on);
  };
  const usernameOf = async (userId: string) => {
    const [row] = await db.select({ username: users.username }).from(users).where(eq(users.id, userId));
    return row?.username ?? null;
  };
  const clearLockout = (userId: string) =>
    db
      .update(users)
      .set({ failedLoginCount: 0, lastFailedLoginAt: null, lockedUntil: null })
      .where(eq(users.id, userId));

  let uid: string;
  const EMAIL = `dhruv${dom}`;

  beforeAll(async () => {
    uid = await mkUser(EMAIL, "Dhruv Owner");
    await onboard(uid, EMAIL, PW);
  });

  // org_settings is a shared singleton — never leave the dial flipped for the
  // suites that run after this file
  afterAll(async () => {
    await app.inject({
      method: "PUT", headers: AUTH, url: "/v1/org/settings", payload: { usernameSelfService: false },
    });
  });

  // ---- admin management ---------------------------------------------------

  it("an admin sets a username; it is audited and rides the users list payload", async () => {
    const r = await setUsername(uid, "dhruv");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: uid, username: "dhruv", previousUsername: null });
    const audit = await latestAudit("username-set");
    expect(audit!.objectId).toBe(uid);
    expect(audit!.effect).toBe("allow");
    expect((audit!.detail as Record<string, unknown>).to).toBe("dhruv");
    expect((audit!.detail as Record<string, unknown>).via).toBe("admin");
    const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/users" });
    const row = list.json().users.find((u: { id: string }) => u.id === uid);
    expect(row.username).toBe("dhruv");
  });

  // ---- the point of the feature ------------------------------------------

  it("login by USERNAME succeeds and yields exactly the same session as email login", async () => {
    const r = await loginBy("dhruv", PW);
    expect(r.statusCode).toBe(200);
    expect(r.json().userId).toBe(uid);
    const cookie = cookieOf(r);
    const probe = await me(cookie);
    expect(probe.statusCode).toBe(200);
    expect(probe.json().userId).toBe(uid);
    // a user can always SEE their own username
    expect(probe.json().user.username).toBe("dhruv");
    // ADR-0028: a password login is 'password' origin whichever identifier it used
    const [row] = await db
      .select({ origin: authSessions.origin })
      .from(authSessions)
      .where(eq(authSessions.tokenHash, hashToken(cookie)));
    expect(row!.origin).toBe("password");
    const audit = await latestAudit("login-succeeded");
    expect((audit!.detail as Record<string, unknown>).identifierKind).toBe("username");
  });

  it("REGRESSION: the pre-0047 {email, password} body still logs in unchanged", async () => {
    const r = await legacyLogin(EMAIL, PW);
    expect(r.statusCode).toBe(200);
    expect(r.json().userId).toBe(uid);
    expect(cookieOf(r).length).toBeGreaterThan(10);
    // and the same address through the new field name resolves identically
    const viaIdentifier = await loginBy(EMAIL, PW);
    expect(viaIdentifier.statusCode).toBe(200);
    expect(viaIdentifier.json().userId).toBe(uid);
  });

  it("a legacy client that only knows the `email` field may still post a USERNAME in it", async () => {
    // the resolution rule reads the VALUE, not the field name: no '@' ⇒ username
    const r = await legacyLogin("dhruv", PW);
    expect(r.statusCode).toBe(200);
    expect(r.json().userId).toBe(uid);
    // ...and a body with neither identifier is a plain 400, not a 500
    const empty = await app.inject({
      method: "POST", url: "/auth/login", headers: CSRF, payload: { password: PW },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toBe("validation");
  });

  // ---- the uniform-error invariant (ADR-0025) survives --------------------

  it("an unknown USERNAME and a wrong password are indistinguishable — same status AND same body", async () => {
    const unknownUsername = await loginBy("nobody-at-all", PW);
    const wrongPassword = await loginBy("dhruv", "wrong-Password11");
    const unknownEmail = await loginBy(`ghost${dom}`, PW);
    expect(unknownUsername.statusCode).toBe(401);
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    // byte-identical bodies across all three failure modes
    expect(unknownUsername.body).toBe(wrongPassword.body);
    expect(unknownUsername.body).toBe(unknownEmail.body);
    expect(unknownUsername.json()).toEqual({
      error: "invalid_credentials",
      detail: "email or password is incorrect",
    });
    // the audit trail — and ONLY the audit trail — knows which it was
    const row = await latestAudit("login-failed");
    expect(row!.effect).toBe("deny");
    const detail = row!.detail as Record<string, unknown>;
    expect(detail.identifierKind).toBe("email");
    expect(detail.why).toBe("unknown_email");
    await clearLockout(uid);
  });

  it("an unknown USERNAME still burns the scrypt path (no fast-fail timing oracle)", async () => {
    const timed = async (fn: () => Promise<unknown>) => {
      const started = process.hrtime.bigint();
      await fn();
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    // min-of-3 per path: scheduling noise only ever makes a run slower. Both
    // paths must exceed the fast-fail floor; their ratio is runner-dependent.
    const unknown: number[] = [];
    const wrong: number[] = [];
    for (let i = 0; i < 3; i++) {
      unknown.push(await timed(() => loginBy("still-nobody", PW)));
      wrong.push(await timed(() => loginBy("dhruv", "wrong-Password11")));
    }
    const minUnknown = Math.min(...unknown);
    const minWrong = Math.min(...wrong);
    // a fast-fail (no hash computed) would be sub-millisecond; a scrypt at
    // N=2^14 costs tens of milliseconds
    expect(minUnknown).toBeGreaterThan(5);
    expect(minWrong).toBeGreaterThan(5);
    await clearLockout(uid);
  });

  // ---- the collision rule -------------------------------------------------

  it("a username containing '@' is REFUSED at write — the namespaces cannot overlap", async () => {
    for (const bad of ["someone@else.example", "dhruv@", "@dhruv"]) {
      const r = await setUsername(uid, bad);
      expect(r.statusCode, bad).toBe(400);
      expect(r.json().error).toBe("validation");
    }
    // the username set earlier survived every refusal
    expect(await usernameOf(uid)).toBe("dhruv");
  });

  it("the shape is enforced on write: case is FOLDED, everything else is refused", async () => {
    const other = await mkUser(`shape${dom}`, "Shape Test");
    // uppercase is normalized, not rejected — `MixedCase` and `mixedcase` are one name
    const folded = await setUsername(other, "MixedCase");
    expect(folded.statusCode).toBe(200);
    expect(folded.json().username).toBe("mixedcase");
    for (const bad of ["a", "-leading", ".dot", "has space", "has/slash", "x".repeat(64)]) {
      const r = await setUsername(other, bad);
      expect(r.statusCode, bad).toBe(400);
    }
    expect(await usernameOf(other)).toBe("mixedcase");
  });

  it("case-insensitive uniqueness is REAL: 'Dhruv' collides with 'dhruv' (409 naming the conflict)", async () => {
    const other = await mkUser(`clash${dom}`, "Clash Test");
    const r = await setUsername(other, "Dhruv");
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("username_taken");
    expect(r.json().detail).toContain("dhruv");
    expect(r.json().detail).toContain(EMAIL); // admin surface: the 409 names the holder
    expect(r.json().conflictUserId).toBe(uid);
    // an exact-case collision answers identically
    const exact = await setUsername(other, "dhruv");
    expect(exact.statusCode).toBe(409);
    expect(exact.json().error).toBe("username_taken");
    expect(await usernameOf(other)).toBeNull();
  });

  it("the uniqueness guarantee is STRUCTURAL — the database itself refuses both violations", async () => {
    const other = await mkUser(`raw${dom}`, "Raw Test");
    // mixed case cannot even be STORED (migration 0047's CHECK), which is what
    // makes the plain unique index case-insensitive by construction
    await expect(
      db.update(users).set({ username: "Dhruv" }).where(eq(users.id, other)),
    ).rejects.toThrow();
    // and a duplicate is refused by the unique index, API path or not
    await expect(
      db.update(users).set({ username: "dhruv" }).where(eq(users.id, other)),
    ).rejects.toThrow();
    expect(await usernameOf(other)).toBeNull();
    // NULL is not unique-constrained: any number of users may have no username
    const another = await mkUser(`raw2${dom}`, "Raw Test 2");
    expect(await usernameOf(another)).toBeNull();
  });

  // ---- change / clear -----------------------------------------------------

  it("an admin CHANGES a username: the old one stops working, the new one starts (audited)", async () => {
    const r = await setUsername(uid, "dhruv.patel");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ username: "dhruv.patel", previousUsername: "dhruv" });
    const audit = await latestAudit("username-changed");
    expect(audit!.objectId).toBe(uid);
    expect((audit!.detail as Record<string, unknown>).from).toBe("dhruv");
    expect((await loginBy("dhruv", PW)).statusCode).toBe(401);
    expect((await loginBy("dhruv.patel", PW)).statusCode).toBe(200);
    // the email never stopped working through any of this
    expect((await legacyLogin(EMAIL, PW)).statusCode).toBe(200);
    await clearLockout(uid);
    expect((await setUsername(uid, "dhruv")).statusCode).toBe(200);
  });

  it("an admin CLEARS a username: login by it is the uniform 401, email login is untouched (audited)", async () => {
    const email = `clearme${dom}`;
    const target = await mkUser(email, "Clear Me");
    await onboard(target, email, PW);
    expect((await setUsername(target, "clearme")).statusCode).toBe(200);
    expect((await loginBy("clearme", PW)).statusCode).toBe(200);
    const cleared = await setUsername(target, null);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ username: null, previousUsername: "clearme" });
    const audit = await latestAudit("username-cleared");
    expect(audit!.objectId).toBe(target);
    expect((audit!.detail as Record<string, unknown>).from).toBe("clearme");
    const gone = await loginBy("clearme", PW);
    expect(gone.statusCode).toBe(401);
    expect(gone.json()).toEqual({ error: "invalid_credentials", detail: "email or password is incorrect" });
    await clearLockout(target);
    expect((await legacyLogin(email, PW)).statusCode).toBe(200);
    // ...and the freed name can be handed to somebody else
    const heir = await mkUser(`heir${dom}`, "Heir");
    expect((await setUsername(heir, "clearme")).statusCode).toBe(200);
    // clearing an already-clear username is a no-op, not an error
    expect((await setUsername(target, null)).statusCode).toBe(200);
  });

  it("a username write against an unknown user is a 404, not a silent no-op", async () => {
    const r = await setUsername("00000000-0000-0000-0000-0000000000ff", "ghost");
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe("unknown_user");
  });

  // ---- self-service policy (ADR-0021 conventions) -------------------------

  it("username_self_service=false (the default) BLOCKS a user changing their own — audited", async () => {
    const settings = await app.inject({ method: "GET", headers: AUTH, url: "/v1/org/settings" });
    expect(settings.json().settings.usernameSelfService).toBe(false);
    const cookie = cookieOf(await loginBy("dhruv", PW));
    expect((await me(cookie)).json().usernameSelfService).toBe(false);
    const r = await selfSetUsername(cookie, "renamed");
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("username_self_service_disabled");
    const audit = await latestAudit("username-self-service-denied");
    expect(audit!.effect).toBe("deny");
    expect(await usernameOf(uid)).toBe("dhruv");
  });

  it("a user may ALWAYS read their own username, self-service or not", async () => {
    const cookie = cookieOf(await legacyLogin(EMAIL, PW));
    const probe = await me(cookie);
    expect(probe.json().user.username).toBe("dhruv");
    expect(probe.json().usernameSelfService).toBe(false);
  });

  it("username_self_service=true lets a user manage their own — same rules, quieter 409", async () => {
    await setSelfService(true);
    const cookie = cookieOf(await loginBy("dhruv", PW));
    expect((await me(cookie)).json().usernameSelfService).toBe(true);
    const ok = await selfSetUsername(cookie, "Dhruv.P");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().username).toBe("dhruv.p"); // folded, exactly as on the admin path
    const audit = await latestAudit("username-changed");
    expect((audit!.detail as Record<string, unknown>).via).toBe("self");
    expect((await loginBy("dhruv.p", PW)).statusCode).toBe(200);
    // uniqueness still bites — but a self-service 409 must NOT name the holder
    const taken = await mkUser(`taken${dom}`, "Taken");
    expect((await setUsername(taken, "already-mine")).statusCode).toBe(200);
    const clash = await selfSetUsername(cookie, "already-mine");
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toBe("username_taken");
    expect(clash.json().detail).not.toContain(`taken${dom}`);
    expect(clash.json().conflictUserId).toBeUndefined();
    // the shape rules are identical here, and a user may clear their own
    expect((await selfSetUsername(cookie, "no@at.signs")).statusCode).toBe(400);
    expect((await selfSetUsername(cookie, null)).statusCode).toBe(200);
    expect(await usernameOf(uid)).toBeNull();
    await setSelfService(false);
    expect((await setUsername(uid, "dhruv")).statusCode).toBe(200);
  });

  // ---- every other auth flow, entered by username -------------------------

  it("TOTP MFA still works when the login came in by username", async () => {
    const email = `mfa-user${dom}`;
    const target = await mkUser(email, "Mfa Username");
    const cookie = await onboard(target, email, PW);
    expect((await setUsername(target, "mfa-user")).statusCode).toBe(200);
    const enroll = await app.inject({
      method: "POST", url: "/auth/totp/enroll", headers: CSRF, cookies: { regulait_session: cookie },
    });
    expect(enroll.statusCode).toBe(200);
    const secret = enroll.json().secret;
    const activate = await app.inject({
      method: "POST", url: "/auth/totp/activate", headers: CSRF,
      cookies: { regulait_session: cookie }, payload: { code: totpCode(secret, totpStep()) },
    });
    expect(activate.statusCode).toBe(200);
    // step 1 by USERNAME: password accepted, no cookie, a pending token instead
    const step1 = await loginBy("mfa-user", PW);
    expect(step1.statusCode).toBe(200);
    expect(step1.json().mfaRequired).toBe(true);
    expect(step1.cookies.find((c) => c.name === "regulait_session")).toBeUndefined();
    const step2 = await app.inject({
      method: "POST", url: "/auth/mfa/verify", headers: CSRF,
      payload: { pendingToken: step1.json().pendingToken, code: totpCode(secret, totpStep() + 1) },
    });
    expect(step2.statusCode).toBe(200);
    expect(step2.json().userId).toBe(target);
    expect((await me(cookieOf(step2))).statusCode).toBe(200);
  });

  it("the must-change-password gate still works when the login came in by username", async () => {
    const email = `must-user${dom}`;
    const target = await mkUser(email, "Must Username");
    expect((await setUsername(target, "must-user")).statusCode).toBe(200);
    const oneTime = await setInitialPassword(target);
    const signIn = await loginBy("must-user", oneTime);
    expect(signIn.statusCode).toBe(200);
    expect(signIn.json().mustChangePassword).toBe(true);
    const cookie = cookieOf(signIn);
    const blocked = await app.inject({ method: "GET", url: "/v1/me", cookies: { regulait_session: cookie } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe("password_change_required");
    expect((await changePassword(cookie, oneTime, PW)).statusCode).toBe(200);
    const open = await app.inject({ method: "GET", url: "/v1/me", cookies: { regulait_session: cookie } });
    expect(open.statusCode).toBe(200);
    // the new password works through EITHER identifier
    expect((await loginBy("must-user", PW)).statusCode).toBe(200);
    expect((await legacyLogin(email, PW)).statusCode).toBe(200);
  });

  it("lockout counts failures against the ACCOUNT, whichever identifier they arrive by", async () => {
    const email = `lock-user${dom}`;
    const target = await mkUser(email, "Lock Username");
    await onboard(target, email, PW);
    expect((await setUsername(target, "lock-user")).statusCode).toBe(200);
    // mix the namespaces: 3 by username + 2 by email = the default threshold of 5
    for (let i = 0; i < 3; i++) {
      expect((await loginBy("lock-user", "wrong-Password11")).statusCode).toBe(401);
    }
    for (let i = 0; i < 2; i++) {
      expect((await legacyLogin(email, "wrong-Password11")).statusCode).toBe(401);
    }
    const audit = await latestAudit("login-lockout");
    expect(audit!.objectId).toBe(target);
    expect((audit!.detail as Record<string, unknown>).failures).toBe(5);
    // the CORRECT password now fails through BOTH identifiers — one account,
    // one lockout, and still the uniform body
    const byUsername = await loginBy("lock-user", PW);
    const byEmail = await legacyLogin(email, PW);
    expect(byUsername.statusCode).toBe(401);
    expect(byEmail.statusCode).toBe(401);
    expect(byUsername.body).toBe(byEmail.body);
    await db.update(users).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(users.id, target));
    expect((await loginBy("lock-user", PW)).statusCode).toBe(200);
  });

  it("a deactivated account is refused by username exactly as by email (ADR-0022 parity)", async () => {
    const email = `dis-user${dom}`;
    const target = await mkUser(email, "Disabled Username");
    await onboard(target, email, PW);
    expect((await setUsername(target, "dis-user")).statusCode).toBe(200);
    const off = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${target}/deactivate`, payload: {},
    });
    expect(off.statusCode).toBe(200);
    const byUsername = await loginBy("dis-user", PW);
    const byEmail = await legacyLogin(email, PW);
    expect(byUsername.statusCode).toBe(401);
    expect(byUsername.body).toBe(byEmail.body); // no oracle in either namespace
    await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${target}/reactivate`, payload: {} });
    await clearLockout(target);
    expect((await loginBy("dis-user", PW)).statusCode).toBe(200);
  });

  it("the seeder's persona names are valid under the shape the migration enforces", async () => {
    for (const name of ["admin", "dana", "avery"]) {
      const target = await mkUser(`${name}-shape${dom}`, `Shape ${name}`);
      const r = await setUsername(target, name.toUpperCase());
      expect(r.statusCode, name).toBe(200);
      expect(r.json().username).toBe(name);
      expect((await setUsername(target, null)).statusCode).toBe(200);
    }
  });
});


// ---------------------------------------------------------------------------
// ADR-0029 — behind the Caddy TLS terminator, as NARROWED by ADR-0031 item 3.
//
// Two mechanisms ride the reverse proxy, and both are now gated on the SAME
// question: is the peer that sent these X-Forwarded-* headers the proxy we
// named, or just whoever happened to connect?
//
//  1. The session cookie's `Secure` flag (requestIsSecure). ADR-0029 read
//     `x-forwarded-proto` off the RAW headers, ungated, on the grounds that
//     forging it can only turn Secure ON. That is the harmless direction. The
//     harmful one is `x-forwarded-proto: http` from something that bypassed
//     Caddy — the gateway port is published on host loopback — which would
//     hand out a session cookie with no Secure flag for a browser to send in
//     cleartext. It now uses req.protocol, which Fastify only derives from the
//     header for a TRUSTED peer.
//  2. `req.ip`, recorded on every auth_sessions row (ADR-0025/0028). Same gate.
//
// So these tests run against an app built behind a NAMED proxy, and every case
// is asserted from both sides of that trust boundary.
// ---------------------------------------------------------------------------
describe("ADR-0029 reverse-proxy trust, narrowed by ADR-0031", () => {
  const PW = "Proxy-Trust-Pw-1";
  /** the address REGULAIT_TRUSTED_PROXIES names — Caddy, in the real stack */
  const PROXY = "172.28.0.2";
  /** anything else that can reach the gateway port: host loopback, a sibling
   * container, a sidecar. Never went through Caddy. */
  const UNTRUSTED = "127.0.0.1";

  /** the deployed posture: exactly one trusted hop */
  let proxied: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    proxied = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, trustProxy: [PROXY] });
    await proxied.ready();
  });
  afterAll(async () => {
    await proxied.close();
  });

  const loginTo = (
    target: ReturnType<typeof buildApp>,
    email: string,
    password: string,
    headers: Record<string, string>,
    remoteAddress = PROXY,
  ) =>
    target.inject({
      method: "POST",
      url: "/auth/login",
      remoteAddress,
      headers: { ...CSRF, ...headers },
      payload: { email, password },
    });

  const setCookieHeader = (res: { headers: Record<string, unknown> }): string => {
    const h = res.headers["set-cookie"];
    return Array.isArray(h) ? h.join("\n") : String(h ?? "");
  };

  const latestSessionIp = async (uid: string): Promise<string | null> => {
    const [row] = await db
      .select({ ip: authSessions.ip })
      .from(authSessions)
      .where(eq(authSessions.userId, uid))
      .orderBy(desc(authSessions.createdAt))
      .limit(1);
    return row?.ip ?? null;
  };

  it("sets Secure when the TRUSTED proxy forwards https, and not when it forwards http or nothing", async () => {
    const email = "proxy-secure@auth-test.example";
    const uid = await mkUser(email, "Proxy Secure");
    await onboard(uid, email, PW);

    // plain HTTP, no proxy header at all — the localhost/dev case
    const plain = await loginTo(proxied, email, PW, {});
    expect(plain.statusCode).toBe(200);
    expect(setCookieHeader(plain)).toContain("regulait_session=");
    expect(setCookieHeader(plain)).not.toContain("Secure");

    // exactly what Caddy sends upstream for a TLS request
    const behindTls = await loginTo(proxied, email, PW, { "x-forwarded-proto": "https" });
    expect(behindTls.statusCode).toBe(200);
    expect(setCookieHeader(behindTls)).toContain("; Secure");
    // the rest of the cookie hardening must survive alongside it
    expect(setCookieHeader(behindTls)).toContain("HttpOnly");
    expect(setCookieHeader(behindTls)).toContain("SameSite=Strict");

    // explicitly forwarded http (Caddy's :80 side, pre-redirect) => still off
    const behindPlain = await loginTo(proxied, email, PW, { "x-forwarded-proto": "http" });
    expect(setCookieHeader(behindPlain)).not.toContain("Secure");
  });

  it("THE FIX: an untrusted peer cannot decide whether our cookies are protected", async () => {
    const email = "proxy-forge@auth-test.example";
    const uid = await mkUser(email, "Proxy Forge");
    await onboard(uid, email, PW);

    // the DANGEROUS direction ADR-0029 left open: something that bypassed
    // Caddy claims the hop was plaintext, hoping for a cookie with no Secure
    // flag that a browser will then send in the clear. On the trust-gated
    // path the claim is simply ignored — and since this hop really is
    // plaintext, the cookie is (correctly) not marked Secure either way.
    const strip = await loginTo(proxied, email, PW, { "x-forwarded-proto": "http" }, UNTRUSTED);
    expect(strip.statusCode).toBe(200);
    expect(setCookieHeader(strip)).not.toContain("Secure");

    // the mirror: a forged `https` from an untrusted peer is not believed
    // either. The old raw-header read would have marked this Secure purely on
    // the say-so of whoever connected.
    const claim = await loginTo(proxied, email, PW, { "x-forwarded-proto": "https" }, UNTRUSTED);
    expect(claim.statusCode).toBe(200);
    expect(setCookieHeader(claim)).not.toContain("Secure");

    // ...while the identical header from the NAMED proxy still wins
    const genuine = await loginTo(proxied, email, PW, { "x-forwarded-proto": "https" }, PROXY);
    expect(setCookieHeader(genuine)).toContain("; Secure");
  });

  it("an app that trusts nothing (the default) never believes x-forwarded-proto at all", async () => {
    const email = "proxy-notrust@auth-test.example";
    const uid = await mkUser(email, "Proxy NoTrust");
    await onboard(uid, email, PW);
    // `app` is built with the default posture: REGULAIT_TRUSTED_PROXIES unset
    const res = await loginTo(app, email, PW, { "x-forwarded-proto": "https" }, PROXY);
    expect(res.statusCode).toBe(200);
    expect(setCookieHeader(res)).not.toContain("Secure");
  });

  it("clears the cookie with Secure too, so the browser actually drops it over TLS", async () => {
    const email = "proxy-logout@auth-test.example";
    const uid = await mkUser(email, "Proxy Logout");
    await onboard(uid, email, PW);
    const cookie = cookieOf(await loginTo(proxied, email, PW, { "x-forwarded-proto": "https" }));
    const out = await proxied.inject({
      method: "POST",
      url: "/auth/logout",
      remoteAddress: PROXY,
      headers: { ...CSRF, "x-forwarded-proto": "https" },
      cookies: { regulait_session: cookie },
    });
    expect(out.statusCode).toBe(200);
    expect(setCookieHeader(out)).toContain("Max-Age=0");
    expect(setCookieHeader(out)).toContain("; Secure");
  });

  it("records the real client IP from X-Forwarded-For — but only from the named proxy", async () => {
    const email = "proxy-ip@auth-test.example";
    const uid = await mkUser(email, "Proxy Ip");
    await onboard(uid, email, PW);

    // Caddy OVERWRITES X-Forwarded-For with the real peer, so exactly one entry.
    const res = await loginTo(proxied, email, PW, {
      "x-forwarded-proto": "https",
      "x-forwarded-for": "203.0.113.9",
    });
    expect(res.statusCode).toBe(200);
    expect(await latestSessionIp(uid)).toBe("203.0.113.9");

    // the same header from a peer that bypassed Caddy is ignored: the audit
    // trail records who actually connected, not who they claimed to be
    const forged = await loginTo(
      proxied,
      email,
      PW,
      { "x-forwarded-for": "198.51.100.66" },
      UNTRUSTED,
    );
    expect(forged.statusCode).toBe(200);
    expect(await latestSessionIp(uid)).toBe(UNTRUSTED);
  });

  it("a multi-hop x-forwarded-proto is read as the NEAREST hop, not the client-supplied first entry", async () => {
    // ADR-0031: the first entry is exactly the one a client can inject when any
    // upstream APPENDS rather than overwrites, so the last (the trusted proxy
    // that actually spoke to us) is the safer of the two to believe. Our Caddy
    // sends a single value, so no chain arises in this topology — this pins the
    // semantics rather than describing a case we produce.
    const email = "proxy-chain@auth-test.example";
    const uid = await mkUser(email, "Proxy Chain");
    await onboard(uid, email, PW);
    const chained = await loginTo(proxied, email, PW, { "x-forwarded-proto": "https, http" });
    expect(setCookieHeader(chained)).not.toContain("Secure");
    const chainedTls = await loginTo(proxied, email, PW, { "x-forwarded-proto": "http, https" });
    expect(setCookieHeader(chainedTls)).toContain("; Secure");
  });
});
