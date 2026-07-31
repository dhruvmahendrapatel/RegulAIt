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
  roleAssignments,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { totpCode, totpStep } from "./auth.js";

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
  opts: { tamperState?: string } = {},
) => {
  const start = await app.inject({ method: "GET", url: `/auth/oidc/${providerId}/start?returnTo=/app` });
  expect(start.statusCode).toBe(302);
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
  });
  return { cb, state, nonce };
};
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
  return r.json();
};

beforeAll(async () => {
  const { runMigrations } = await import("@regulait/db");
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await startIdp();
}, 120_000);

afterAll(async () => {
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
    const p = await mkProvider({ name: "jit-on", jitProvisioning: true, defaultRoleId: roleId });
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

  it("mfa_required=all gates SESSION users into enrollment but never touches API-key requests", async () => {
    const on = await app.inject({
      method: "PUT", headers: AUTH, url: "/v1/org/settings", payload: { mfaRequired: "all" },
    });
    expect(on.statusCode).toBe(200);
    // key path: untouched
    const keyed = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${key}` } });
    expect(keyed.statusCode).toBe(200);
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
    const off = await app.inject({
      method: "PUT", headers: AUTH, url: "/v1/org/settings", payload: { mfaRequired: "off" },
    });
    expect(off.statusCode).toBe(200);
  });
});
