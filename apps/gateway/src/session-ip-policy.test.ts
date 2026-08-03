/**
 * ADR-0039 e2e — session & device management, proof by attack.
 *
 * Covers: per-session revocation (admin single-session kills EXACTLY that
 * session), the self-service surface (list own sessions with device label +
 * current marker, revoke one, revoke-others; another user's session id is a
 * 404 that reveals nothing), org IP allow-listing (enforce_at_login refuses
 * out-of-envelope logins with 401 + audit and no cookie; enforce_continuous
 * force-revokes an in-flight session the moment the envelope tightens — and
 * the session STAYS dead when the envelope loosens again), the SEPARATE
 * api_key_ip_policy knob (human knob never touches API keys; the api-key knob
 * refuses header requests, refuses key-exchange logins, and force-revokes
 * exchanged api_key sessions), the bootstrap break-glass exemption, write-time
 * CIDR validation (400, nothing saved), and the admin self-lockout guard
 * (409 without the explicit confirm flag).
 *
 * Client IPs are faked exactly like trusted-proxy.test.ts: inject's
 * remoteAddress IS the socket peer, and the default app trusts no proxy, so
 * req.ip is whatever the test sets (default 127.0.0.1).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  auditLog,
  authSessions,
  createDb,
  desc,
  eq,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "adr0039-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
const PW = "Str0ng-passw0rd-39!";

const INSIDE = "10.1.2.3"; // inside 10.0.0.0/8
const LOOPBACK = "127.0.0.1"; // inject's default remoteAddress

let db: Db;
let app: ReturnType<typeof buildApp>;

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------
const putSettings = (payload: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: "/v1/org/settings", headers: AUTH, payload });

/** every block resets the posture so file ordering can never couple suites */
const resetPolicy = async () => {
  const r = await putSettings({ sessionIpPolicy: "off", apiKeyIpPolicy: "off", sessionIpAllowlist: null });
  expect(r.statusCode).toBe(200);
};

const mkUser = async (label: string): Promise<{ userId: string; email: string }> => {
  const email = `${label}-${randomUUID()}@example.com`;
  const r = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/users",
    payload: { email, displayName: label },
  });
  expect(r.statusCode).toBe(201);
  return { userId: r.json().id, email };
};

const mkKey = async (userId: string): Promise<string> => {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${userId}/keys`,
    payload: { name: "adr0039-key" },
  });
  expect(r.statusCode).toBe(201);
  return r.json().token;
};

const login = (email: string, password: string, remoteAddress = LOOPBACK) =>
  app.inject({ method: "POST", url: "/auth/login", headers: CSRF, remoteAddress, payload: { email, password } });

const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }): string => {
  const c = res.cookies.find((x) => x.name === "regulait_session");
  expect(c, "expected a session cookie").toBeTruthy();
  return c!.value;
};

const me = (cookie: string, remoteAddress = LOOPBACK) =>
  app.inject({ method: "GET", url: "/auth/me", remoteAddress, cookies: { regulait_session: cookie } });

const mySessions = (cookie: string) =>
  app.inject({ method: "GET", url: "/auth/sessions", cookies: { regulait_session: cookie } });

/** full onboarding: one-time password -> real password (keeps the session) */
const onboard = async (userId: string, email: string): Promise<string> => {
  const init = await app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${userId}/set-initial-password`, payload: {},
  });
  expect(init.statusCode).toBe(200);
  const oneTime = init.json().password;
  const first = await login(email, oneTime);
  expect(first.statusCode).toBe(200);
  const cookie = cookieOf(first);
  const change = await app.inject({
    method: "POST", url: "/auth/change-password", headers: CSRF,
    cookies: { regulait_session: cookie },
    payload: { currentPassword: oneTime, newPassword: PW },
  });
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

const sessionRow = async (sessionId: string) => {
  const [row] = await db.select().from(authSessions).where(eq(authSessions.id, sessionId));
  return row ?? null;
};

/** the caller's own current session id, via the self-service list */
const currentSessionId = async (cookie: string): Promise<string> => {
  const r = await mySessions(cookie);
  expect(r.statusCode).toBe(200);
  const current = (r.json().sessions as Array<{ id: string; current: boolean }>).find((s) => s.current);
  expect(current, "expected a current session in the list").toBeTruthy();
  return current!.id;
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  await resetPolicy();
});

afterAll(async () => {
  // leave the shared suite database in the default (off) posture
  await db
    .update(orgSettings)
    .set({ sessionIpPolicy: "off", apiKeyIpPolicy: "off", sessionIpAllowlist: null })
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await app.close();
});

// ==========================================================================
describe("ADR-0039: per-session revocation (admin)", () => {
  it("revoking ONE session kills exactly that session — the other keeps working", async () => {
    const { userId, email } = await mkUser("single-revoke");
    const cookie1 = await onboard(userId, email);
    const cookie2 = cookieOf(await login(email, PW));
    const id2 = await currentSessionId(cookie2);

    // the admin list carries the ADR-0039 device/context columns
    const list = await app.inject({ method: "GET", headers: AUTH, url: `/v1/users/${userId}/sessions` });
    expect(list.statusCode).toBe(200);
    const sessions = list.json().sessions as Array<Record<string, unknown>>;
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    for (const s of sessions) {
      expect(s).toHaveProperty("lastSeenIp");
      expect(s).toHaveProperty("deviceLabel");
      expect(s).toHaveProperty("origin");
    }
    const listAudit = await latestAudit("session-list-viewed");
    expect(listAudit?.detail).toMatchObject({ via: "admin" });

    const revoke = await app.inject({
      method: "POST", headers: AUTH,
      url: `/v1/users/${userId}/sessions/${id2}/revoke`,
      payload: { reason: "suspicious device" },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toMatchObject({ ok: true, revokedSessionId: id2 });

    expect((await me(cookie2)).statusCode).toBe(401); // the revoked one is dead...
    expect((await me(cookie1)).statusCode).toBe(200); // ...the sibling is untouched

    const audit = await latestAudit("session-revoked-by-admin");
    expect(audit?.effect).toBe("allow");
    expect(audit?.detail).toMatchObject({ sessionId: id2, reason: "suspicious device" });

    // second revoke of the same session is an honest 409, and an unknown id 404s
    expect((await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${userId}/sessions/${id2}/revoke`, payload: {},
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${userId}/sessions/${randomUUID()}/revoke`, payload: {},
    })).statusCode).toBe(404);
  });
});

// ==========================================================================
describe("ADR-0039: self-service session management", () => {
  it("lists own live sessions with device label and exactly one current marker", async () => {
    const { userId, email } = await mkUser("self-list");
    const cookie1 = await onboard(userId, email);
    cookieOf(await login(email, PW)); // a second device

    const r = await mySessions(cookie1);
    expect(r.statusCode).toBe(200);
    const sessions = r.json().sessions as Array<Record<string, unknown>>;
    expect(sessions.length).toBe(2);
    expect(sessions.filter((s) => s.current === true).length).toBe(1);
    for (const s of sessions) {
      expect(typeof s.deviceLabel).toBe("string");
      expect(s).toHaveProperty("ip");
      expect(s).toHaveProperty("lastSeenIp");
      expect(s).toHaveProperty("lastSeenAt");
    }
    const audit = await latestAudit("session-list-viewed");
    expect(audit?.detail).toMatchObject({ via: "self" });
  });

  it("revokes ONE own session; another user's session id is an unrevealing 404", async () => {
    const a = await mkUser("self-revoke-a");
    const b = await mkUser("self-revoke-b");
    const cookieA = await onboard(a.userId, a.email);
    const cookieB1 = await onboard(b.userId, b.email);
    const cookieB2 = cookieOf(await login(b.email, PW));
    const idB2 = await currentSessionId(cookieB2);

    // ATTACK: user A tries to revoke user B's session via the self-service
    // route. Ownership is inside the WHERE clause: 404, session untouched.
    const cross = await app.inject({
      method: "POST", url: `/auth/sessions/${idB2}/revoke`, headers: CSRF,
      cookies: { regulait_session: cookieA },
    });
    expect(cross.statusCode).toBe(404);
    expect(cross.json().error).toBe("unknown_session");
    expect((await me(cookieB2)).statusCode).toBe(200); // still alive

    // B revokes their own second device — exactly that one dies
    const own = await app.inject({
      method: "POST", url: `/auth/sessions/${idB2}/revoke`, headers: CSRF,
      cookies: { regulait_session: cookieB1 },
    });
    expect(own.statusCode).toBe(200);
    expect((await me(cookieB2)).statusCode).toBe(401);
    expect((await me(cookieB1)).statusCode).toBe(200);
    const audit = await latestAudit("session-revoked-by-self");
    expect(audit?.detail).toMatchObject({ sessionId: idB2, via: "self" });
  });

  it("revoke-others keeps ONLY the caller's current session", async () => {
    const { userId, email } = await mkUser("revoke-others");
    const cookie1 = await onboard(userId, email);
    const cookie2 = cookieOf(await login(email, PW));
    const cookie3 = cookieOf(await login(email, PW));

    const r = await app.inject({
      method: "POST", url: "/auth/sessions/revoke-others", headers: CSRF,
      cookies: { regulait_session: cookie1 },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().revoked).toBe(2);
    expect((await me(cookie1)).statusCode).toBe(200);
    expect((await me(cookie2)).statusCode).toBe(401);
    expect((await me(cookie3)).statusCode).toBe(401);
    const audit = await latestAudit("sessions-revoked-others");
    expect(audit?.detail).toMatchObject({ count: 2 });
  });
});

// ==========================================================================
describe("ADR-0039: enforce_at_login", () => {
  it("refuses an out-of-envelope password login (401 + audit, no cookie); permits inside; leaves existing sessions and API keys alone", async () => {
    const { userId, email } = await mkUser("at-login");
    const preCookie = await onboard(userId, email); // session from BEFORE the policy
    const apiKey = await mkKey(userId);

    const set = await putSettings({
      sessionIpPolicy: "enforce_at_login",
      sessionIpAllowlist: ["10.0.0.0/8"], // excludes 127.0.0.1
    });
    expect(set.statusCode).toBe(200);
    try {
      // outside the envelope: refused before any credential processing
      const denied = await login(email, PW); // remoteAddress defaults to 127.0.0.1
      expect(denied.statusCode).toBe(401);
      expect(denied.json().error).toBe("ip_not_allowed");
      expect(denied.cookies.find((c) => c.name === "regulait_session")).toBeUndefined();
      const audit = await latestAudit("ip-policy-login-denied");
      expect(audit?.effect).toBe("deny");
      expect(audit?.detail).toMatchObject({
        knob: "session_ip_policy",
        policy: "enforce_at_login",
        clientIp: LOOPBACK,
        allowlist: ["10.0.0.0/8"],
      });

      // inside the envelope: the same credentials sign in fine
      const allowed = await login(email, PW, INSIDE);
      expect(allowed.statusCode).toBe(200);
      cookieOf(allowed);

      // at_login does NOT touch existing sessions...
      expect((await me(preCookie)).statusCode).toBe(200);
      // ...and the human knob never governs the API-key path: header auth and
      // key-exchange both keep working from the "wrong" address
      expect((await app.inject({
        method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${apiKey}` },
      })).statusCode).toBe(200);
      const exchange = await app.inject({
        method: "POST", url: "/auth/login-with-key", headers: CSRF, payload: { apiKey },
      });
      expect(exchange.statusCode).toBe(200);
    } finally {
      await resetPolicy();
    }
  });
});

// ==========================================================================
describe("ADR-0039: enforce_continuous", () => {
  it("force-revokes an in-flight session when the envelope tightens — and the session STAYS dead when it loosens", async () => {
    const { userId, email } = await mkUser("continuous");
    const cookie = await onboard(userId, email); // from 127.0.0.1
    const sessionId = await currentSessionId(cookie);

    // posture on, envelope still contains the session's address: requests pass
    expect((await putSettings({
      sessionIpPolicy: "enforce_continuous",
      sessionIpAllowlist: ["127.0.0.0/8"],
    })).statusCode).toBe(200);
    try {
      expect((await me(cookie)).statusCode).toBe(200);

      // TIGHTEN the envelope past the session (needs the lockout confirm —
      // the write itself proves bootstrap stays exempt from the policy)
      expect((await putSettings({
        sessionIpAllowlist: ["10.0.0.0/8"],
        confirmIpLockout: true,
      })).statusCode).toBe(200);

      // the very next use is refused AND the session force-revoked on the spot
      const refused = await me(cookie);
      expect(refused.statusCode).toBe(401);
      expect(refused.json().error).toBe("ip_not_allowed");
      expect((await sessionRow(sessionId))?.revokedAt).not.toBeNull();
      const audit = await latestAudit("ip-policy-session-revoked");
      expect(audit?.effect).toBe("deny");
      expect(audit?.detail).toMatchObject({
        sessionId,
        knob: "session_ip_policy",
        policy: "enforce_continuous",
        clientIp: LOOPBACK,
        allowlist: ["10.0.0.0/8"],
      });

      // loosening the envelope again does NOT resurrect it: revocation is the
      // one way sessions die, and death is permanent
      expect((await putSettings({ sessionIpAllowlist: ["127.0.0.0/8"] })).statusCode).toBe(200);
      expect((await me(cookie)).statusCode).toBe(401);

      // a session created INSIDE the envelope keeps working under continuous
      const inside = await login(email, PW, "127.0.0.2");
      expect(inside.statusCode).toBe(200);
      expect((await me(cookieOf(inside), "127.0.0.2")).statusCode).toBe(200);
    } finally {
      await resetPolicy();
    }
  });

  it("fail-closed wording is real: an undeterminable client IP is refused (unit-proven) and a malformed stored entry admits nobody", async () => {
    const { userId, email } = await mkUser("failclosed");
    await onboard(userId, email);
    // simulate a legacy/bad row: write a malformed allow-list DIRECTLY to the
    // DB (the API would 400 it — that write-time wall is tested below), then
    // prove evaluation treats it as matching nothing.
    await db
      .update(orgSettings)
      .set({ sessionIpPolicy: "enforce_continuous", sessionIpAllowlist: ["not-a-cidr"] })
      .where(eq(orgSettings.id, ORG_SETTINGS_ID));
    try {
      const denied = await login(email, PW); // any address is outside a match-nothing envelope
      expect(denied.statusCode).toBe(401);
      expect(denied.json().error).toBe("ip_not_allowed");
    } finally {
      await resetPolicy();
    }
  });
});

// ==========================================================================
describe("ADR-0039: api_key_ip_policy is a SEPARATE knob", () => {
  it("governs header API-key auth and exchanged api_key sessions; never the human path; never bootstrap", async () => {
    const { userId, email } = await mkUser("apikey-knob");
    await onboard(userId, email);
    const apiKey = await mkKey(userId);

    expect((await putSettings({
      apiKeyIpPolicy: "enforce_continuous",
      sessionIpAllowlist: ["10.0.0.0/8"],
    })).statusCode).toBe(200);
    try {
      // header API-key request from outside: refused + audited
      const denied = await app.inject({
        method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(denied.statusCode).toBe(401);
      expect(denied.json().error).toBe("ip_not_allowed");
      const audit = await latestAudit("ip-policy-api-key-denied");
      expect(audit?.effect).toBe("deny");
      expect(audit?.detail).toMatchObject({ knob: "api_key_ip_policy", clientIp: LOOPBACK });

      // ...but from inside the envelope it works
      expect((await app.inject({
        method: "GET", url: "/auth/me", remoteAddress: INSIDE,
        headers: { authorization: `Bearer ${apiKey}` },
      })).statusCode).toBe(200);

      // the HUMAN path is untouched by the api-key knob (session_ip_policy off)
      const humanLogin = await login(email, PW);
      expect(humanLogin.statusCode).toBe(200);
      expect((await me(cookieOf(humanLogin))).statusCode).toBe(200);

      // key-EXCHANGE from outside is refused (it would mint an api_key session)
      const exchangeDenied = await app.inject({
        method: "POST", url: "/auth/login-with-key", headers: CSRF, payload: { apiKey },
      });
      expect(exchangeDenied.statusCode).toBe(401);
      expect(exchangeDenied.json().error).toBe("ip_not_allowed");

      // exchange from inside works — then the session dies the moment it is
      // used from outside (continuous governs api_key-origin sessions too)
      const exchange = await app.inject({
        method: "POST", url: "/auth/login-with-key", headers: CSRF,
        remoteAddress: INSIDE, payload: { apiKey },
      });
      expect(exchange.statusCode).toBe(200);
      const keyCookie = cookieOf(exchange);
      expect((await me(keyCookie, INSIDE)).statusCode).toBe(200);
      expect((await me(keyCookie /* loopback */)).statusCode).toBe(401);
      expect((await me(keyCookie, INSIDE)).statusCode).toBe(401); // revoked, stays dead

      // BOOTSTRAP is the break-glass path: header use and exchange both keep
      // working from outside the envelope
      expect((await app.inject({ method: "GET", url: "/auth/me", headers: AUTH })).statusCode).toBe(200);
      const bootExchange = await app.inject({
        method: "POST", url: "/auth/login-with-key", headers: CSRF, payload: { apiKey: BOOT },
      });
      expect(bootExchange.statusCode).toBe(200);
      expect((await me(cookieOf(bootExchange))).statusCode).toBe(200);
    } finally {
      await resetPolicy();
    }
  });
});

// ==========================================================================
describe("ADR-0039: settings write walls", () => {
  it("refuses malformed CIDR blocks with a 400 naming them — nothing saved", async () => {
    for (const bad of [["999.1.2.3/8"], ["10.0.0.0/33"], ["10.0.0.0/8", "banana"]]) {
      const r = await putSettings({ sessionIpAllowlist: bad });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("invalid_cidr");
    }
    const [row] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    expect(row?.sessionIpAllowlist ?? null).toBeNull(); // the 400s saved nothing
  });

  it("the self-lockout guard demands the explicit confirm flag for enforce_continuous excluding the caller's IP", async () => {
    const noConfirm = await putSettings({
      sessionIpPolicy: "enforce_continuous",
      sessionIpAllowlist: ["10.0.0.0/8"], // excludes the caller's 127.0.0.1
    });
    expect(noConfirm.statusCode).toBe(409);
    expect(noConfirm.json().error).toBe("ip_policy_lockout");

    // nothing changed
    let [row] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    expect(row?.sessionIpPolicy).toBe("off");

    const confirmed = await putSettings({
      sessionIpPolicy: "enforce_continuous",
      sessionIpAllowlist: ["10.0.0.0/8"],
      confirmIpLockout: true,
    });
    expect(confirmed.statusCode).toBe(200);
    [row] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    expect(row?.sessionIpPolicy).toBe("enforce_continuous");
    // confirmIpLockout is write-only — it never lands anywhere on the row
    expect(JSON.stringify(row)).not.toContain("confirmIpLockout");

    // a caller INSIDE the envelope needs no confirm (the guard is a lockout
    // guard, not general friction)
    const insideOk = await app.inject({
      method: "PUT", url: "/v1/org/settings", headers: AUTH, remoteAddress: INSIDE,
      payload: { sessionIpAllowlist: ["10.0.0.0/8", "192.168.0.0/16"] },
    });
    expect(insideOk.statusCode).toBe(200);

    await resetPolicy();
  });

  it("last_seen_ip tracks the session's CURRENT address on ordinary use", async () => {
    const { userId, email } = await mkUser("lastseen");
    const cookie = await onboard(userId, email);
    const sessionId = await currentSessionId(cookie);
    expect((await sessionRow(sessionId))?.lastSeenIp).toBe(LOOPBACK);
    // same cookie, new address (no proxy trust needed — socket peer moves)
    expect((await me(cookie, "127.0.0.9")).statusCode).toBe(200);
    const after = await sessionRow(sessionId);
    expect(after?.lastSeenIp).toBe("127.0.0.9");
    expect(after?.ip).toBe(LOOPBACK); // the creation-time record is untouched
  });
});
