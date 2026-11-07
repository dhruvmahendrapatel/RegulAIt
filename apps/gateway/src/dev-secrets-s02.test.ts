/**
 * ADR-0167 amendment — S-02 of the 2026-11-07 whole-build review.
 *
 * The published bootstrap token and data key were refused only when
 * REGULAIT_DEPLOY_MODE or REGULAIT_HSTS was set, and the base compose never
 * forwarded REGULAIT_HSTS, so `--profile tls`, `hosted` and `tunnel` booted
 * with a full-admin credential printed in the public repository. That
 * credential never expired, skipped MFA and the IP envelope, kept working
 * after a real admin existed, and could mint an API key for any user without
 * a step-up.
 *
 * This file covers each closed path:
 *   1. the decision: loopback-only or the explicit opt-in, an https public URL
 *      as a deploy signal;
 *   2. the compose file forwards REGULAIT_HSTS (without an empty default) and
 *      ships no opt-in;
 *   3. the opt-in is recorded in the audit log;
 *   4. the bootstrap credential retires once an active admin exists (header and
 *      bootstrap session), audited once, and the relaxation keeps it;
 *   5. minting an API key for another user is an `identity_manage` step-up.
 *
 * The suite sets REGULAIT_BOOTSTRAP_AFTER_ADMIN=1 (vitest.config.ts), so every
 * app here that tests retirement passes `bootstrapAfterAdmin: false` itself.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiKeys, auditLog, authSessions, createDb, eq, runMigrations, sql, users, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { CSRF_HEADER, SESSION_COOKIE, generateToken } from "./auth.js";
import {
  BOOTSTRAP_AFTER_ADMIN_ENV,
  DEV_SECRETS_OVERRIDE_ENV,
  PUBLISHED_DATA_KEY,
  assessDevSecrets,
  bootstrapAfterAdminRelaxed,
  isLoopbackListen,
  networkFacingSignal,
  activeAdminExists,
  recordDevSecretsOptIn,
} from "./dev-secrets.js";
import { hashToken } from "./token-hash.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../../packages/db/migrations");
const BOOT = "s02-bootstrap-token-of-decent-length";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "5".repeat(32) + "0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------
// 1. THE DECISION
// ---------------------------------------------------------------------------

describe("S-02: published secrets are accepted only on loopback or by explicit opt-in", () => {
  const published = { bootstrapToken: "dev-bootstrap", dataKey: PUBLISHED_DATA_KEY };

  it("the listen address decides when nothing says the box is deployed", () => {
    for (const host of ["127.0.0.1", "127.0.0.53", "::1", "[::1]", "localhost"]) {
      expect(isLoopbackListen(host), host).toBe(true);
      expect(assessDevSecrets({}, { ...published, listenHost: host }).refuse, host).toBe(false);
    }
    for (const host of ["0.0.0.0", "::", "", "10.0.0.5", "gateway", undefined]) {
      expect(isLoopbackListen(host), String(host)).toBe(false);
      const a = assessDevSecrets({}, { ...published, listenHost: host });
      expect(a.refuse, String(host)).toBe(true);
      expect(a.exposure, String(host)).toContain("not on loopback only");
    }
  });

  it("an https public URL on a real host is a deploy signal, and refuses even on loopback", () => {
    const env = { REGULAIT_PUBLIC_URL: "https://regulait.example.com" } as NodeJS.ProcessEnv;
    expect(networkFacingSignal(env)).toBe("REGULAIT_PUBLIC_URL is https on regulait.example.com");
    const a = assessDevSecrets(env, { ...published, listenHost: "127.0.0.1" });
    expect(a.refuse).toBe(true);
    expect(a.exposure).toContain("regulait.example.com");
  });

  it("a loopback public URL, http or https, is not a deploy signal; nor is a malformed one", () => {
    for (const url of ["http://localhost:3000", "http://127.0.0.1:3105", "https://localhost", "https://[::1]:8443", "not a url"]) {
      expect(networkFacingSignal({ REGULAIT_PUBLIC_URL: url } as NodeJS.ProcessEnv), url).toBeNull();
    }
  });

  it("the explicit opt-in boots a reachable listener and a deployed box, and only the exact value 1 counts", () => {
    const deployed = { REGULAIT_PUBLIC_URL: "https://regulait.example.com" } as NodeJS.ProcessEnv;
    const on = assessDevSecrets({ ...deployed, [DEV_SECRETS_OVERRIDE_ENV]: "1" }, { ...published, listenHost: "0.0.0.0" });
    expect(on.refuse).toBe(false);
    expect(on.overridden).toBe(true);
    for (const v of ["", "true", "yes", "0"]) {
      const off = assessDevSecrets({ ...deployed, [DEV_SECRETS_OVERRIDE_ENV]: v }, { ...published, listenHost: "0.0.0.0" });
      expect(off.refuse, v).toBe(true);
    }
  });

  it("real secrets boot anywhere, with no finding", () => {
    const a = assessDevSecrets({ REGULAIT_DEPLOY_MODE: "hosted" }, { bootstrapToken: BOOT, dataKey: DATA_KEY, listenHost: "0.0.0.0" });
    expect(a.findings).toEqual([]);
    expect(a.refuse).toBe(false);
  });

  it("the retirement relaxation is off unless set to exactly 1", () => {
    expect(bootstrapAfterAdminRelaxed({})).toBe(false);
    expect(bootstrapAfterAdminRelaxed({ [BOOTSTRAP_AFTER_ADMIN_ENV]: "true" })).toBe(false);
    expect(bootstrapAfterAdminRelaxed({ [BOOTSTRAP_AFTER_ADMIN_ENV]: "1" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. THE COMPOSE FILE
// ---------------------------------------------------------------------------

describe("S-02: the base compose forwards the deploy signal and ships no opt-in", () => {
  const compose = readFileSync(path.resolve(here, "../../../docker-compose.yml"), "utf8");
  const start = compose.indexOf("\n  gateway:\n");
  const end = compose.indexOf("\n  ", compose.indexOf("\n    healthcheck:", start) + 1);
  const gateway = compose.slice(start, end > start ? end : undefined);

  it("REGULAIT_HSTS reaches the gateway, with no default (unset must stay unset: empty means no header)", () => {
    expect(start).toBeGreaterThan(0);
    expect(gateway).toMatch(/\n {6}REGULAIT_HSTS:\s*\n/);
  });

  it("the dev opt-in and the retirement relaxation default to empty", () => {
    expect(gateway).toContain("REGULAIT_ALLOW_DEV_SECRETS: ${REGULAIT_ALLOW_DEV_SECRETS:-}");
    expect(gateway).toContain("REGULAIT_BOOTSTRAP_AFTER_ADMIN: ${REGULAIT_BOOTSTRAP_AFTER_ADMIN:-}");
  });
});

// ---------------------------------------------------------------------------
// 3-5. AGAINST A DATABASE OF ITS OWN (an active admin anywhere retires the token)
// ---------------------------------------------------------------------------

const SCRATCH_DB = `regulait_s02_${process.pid}`;
const scratchUrl = DATABASE_URL.replace(/\/[^/?]+(\?|$)/, `/${SCRATCH_DB}$1`);
let admin: Db;
let db: Db;

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(scratchUrl);
  await runMigrations(db, migrationsFolder);
}, 90_000);

afterAll(async () => {
  await closeAll([
    async () => {
      const client = (db as unknown as { $client?: { end?: () => Promise<void> } }).$client;
      if (client?.end) await client.end();
    },
    async () => dropScratchDatabase(admin, SCRATCH_DB),
  ]);
});

async function signInSession(userId: string | null, origin: "password" | "bootstrap"): Promise<string> {
  const token = `s02-session-${origin}-${Math.random().toString(36).slice(2)}`;
  const now = Date.now();
  await db.insert(authSessions).values({
    tokenHash: hashToken(token),
    userId,
    origin,
    expiresAt: new Date(now + 3_600_000),
    idleExpiresAt: new Date(now + 3_600_000),
    idleMinutes: 60,
  });
  return token;
}

const auditCount = async (ruleId: string) =>
  (await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.ruleId, ruleId))).length;

describe("S-02: the dev opt-in is recorded", () => {
  it("one audit row names what was accepted and why it would have been refused; nothing when not needed", async () => {
    const accepted = assessDevSecrets(
      { [DEV_SECRETS_OVERRIDE_ENV]: "1" },
      { bootstrapToken: "dev-bootstrap", dataKey: PUBLISHED_DATA_KEY, listenHost: "0.0.0.0" },
    );
    const before = await auditCount("dev-secrets-opt-in");
    expect(await recordDevSecretsOptIn(db, accepted)).toBe(true);
    expect(await auditCount("dev-secrets-opt-in")).toBe(before + 1);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.ruleId, "dev-secrets-opt-in"));
    expect(row!.effect).toBe("allow");
    expect(JSON.stringify(row!.detail)).not.toContain(PUBLISHED_DATA_KEY);

    const loopback = assessDevSecrets(
      { [DEV_SECRETS_OVERRIDE_ENV]: "1" },
      { bootstrapToken: "dev-bootstrap", dataKey: PUBLISHED_DATA_KEY, listenHost: "127.0.0.1" },
    );
    expect(await recordDevSecretsOptIn(db, loopback)).toBe(false);
    expect(await auditCount("dev-secrets-opt-in")).toBe(before + 1);
  });
});

describe("S-02: the bootstrap credential retires once an active admin exists", () => {
  let strict: ReturnType<typeof buildApp>;
  let adminId = "";
  let bootSession = "";

  beforeAll(async () => {
    strict = buildApp(db, { bootstrapToken: BOOT, bootstrapAfterAdmin: false, dataKey: DATA_KEY });
  });

  it("before any admin signs in, the token works: it creates the first admin and that admin is not yet active", async () => {
    expect((await strict.inject({ method: "GET", url: "/v1/users", headers: AUTH })).statusCode).toBe(200);
    const created = await strict.inject({
      method: "POST",
      url: "/v1/users",
      headers: AUTH,
      payload: { email: "s02-admin@example.com", displayName: "S02 Admin", isAdmin: true },
    });
    expect(created.statusCode, created.body).toBe(201);
    adminId = created.json().id;
    expect(await activeAdminExists(db)).toBe(false);
    expect((await strict.inject({ method: "GET", url: "/v1/users", headers: AUTH })).statusCode).toBe(200);
    // a bootstrap-exchanged browser session works too, for now
    bootSession = await signInSession(null, "bootstrap");
    const viaCookie = await strict.inject({ method: "GET", url: "/v1/users", headers: { cookie: `${SESSION_COOKIE}=${bootSession}` } });
    expect(viaCookie.statusCode, viaCookie.body).toBe(200);
  });

  it("once the admin has signed in, the token authenticates nothing, says why, and is audited once", async () => {
    await signInSession(adminId, "password");
    expect(await activeAdminExists(db)).toBe(true);
    const before = await auditCount("bootstrap-retired");
    const r = await strict.inject({ method: "GET", url: "/v1/users", headers: AUTH });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe("bootstrap_retired");
    const again = await strict.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: "s02-x@example.com", displayName: "x" } });
    expect(again.statusCode).toBe(401);
    expect(await auditCount("bootstrap-retired")).toBe(before + 1);
  });

  it("a bootstrap browser session dies with it, and the key exchange refuses the token", async () => {
    const viaCookie = await strict.inject({ method: "GET", url: "/v1/users", headers: { cookie: `${SESSION_COOKIE}=${bootSession}` } });
    expect(viaCookie.statusCode).toBe(401);
    const exchange = await strict.inject({
      method: "POST",
      url: "/auth/login-with-key",
      headers: { [CSRF_HEADER]: "1" },
      payload: { apiKey: BOOT },
    });
    expect(exchange.statusCode, exchange.body).toBe(401);
    expect(exchange.json().error).toBe("bootstrap_retired");
  });

  it("an admin who only used an API key counts as active too", async () => {
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, adminId));
    const [second] = await db.insert(users).values({ email: "s02-keyadmin@example.com", displayName: "Key Admin", isAdmin: true }).returning();
    const { tokenHash } = generateToken();
    await db.insert(apiKeys).values({ userId: second!.id, name: "used", tokenHash });
    expect(await activeAdminExists(db)).toBe(false);
    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.tokenHash, tokenHash));
    expect(await activeAdminExists(db)).toBe(true);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, second!.id));
  });

  it("when every admin is disabled the break-glass token works again (the lockout it exists for)", async () => {
    expect(await activeAdminExists(db)).toBe(false);
    expect((await strict.inject({ method: "GET", url: "/v1/users", headers: AUTH })).statusCode).toBe(200);
    await db.update(users).set({ disabledAt: null }).where(eq(users.id, adminId));
    expect((await strict.inject({ method: "GET", url: "/v1/users", headers: AUTH })).statusCode).toBe(401);
  });

  it("REGULAIT_BOOTSTRAP_AFTER_ADMIN=1 (the relaxation) keeps it working", async () => {
    const relaxed = buildApp(db, { bootstrapToken: BOOT, bootstrapAfterAdmin: true, dataKey: DATA_KEY });
    expect((await relaxed.inject({ method: "GET", url: "/v1/users", headers: AUTH })).statusCode).toBe(200);
  });
});

describe("S-02: minting an API key for another user is an identity_manage step-up", () => {
  let relaxed: ReturnType<typeof buildApp>;
  let adminId = "";
  let adminKey = "";
  let memberId = "";

  beforeAll(async () => {
    // relaxed: this app creates the member after other tests' admins signed in
    relaxed = buildApp(db, { bootstrapToken: BOOT, bootstrapAfterAdmin: true, dataKey: DATA_KEY });
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.isAdmin, true));
    const [a] = await db
      .insert(users)
      .values({ email: "s02-stepup-admin@example.com", displayName: "Step-up Admin", isAdmin: true })
      .returning();
    adminId = a!.id;
    const m = await relaxed.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: "s02-member@example.com", displayName: "Member" } });
    expect(m.statusCode, m.body).toBe(201);
    memberId = m.json().id;
  });

  it("first-admin setup still works: with no admin able to step up, the bootstrap token mints a key for someone", async () => {
    const r = await relaxed.inject({ method: "POST", url: `/v1/users/${memberId}/keys`, headers: AUTH, payload: { name: "first" } });
    expect(r.statusCode, r.body).toBe(201);
  });

  it("once an admin can step up, the bootstrap token cannot mint a key for anyone", async () => {
    await db.update(users).set({ totpEnabled: true }).where(eq(users.id, adminId));
    // the strict app: that admin has not signed in yet, so the token is not retired, and the step-up answers
    const strict = buildApp(db, { bootstrapToken: BOOT, bootstrapAfterAdmin: false, dataKey: DATA_KEY });
    for (const target of [memberId, adminId]) {
      const r = await strict.inject({ method: "POST", url: `/v1/users/${target}/keys`, headers: AUTH, payload: { name: "minted" } });
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json()).toMatchObject({ error: "step_up_required", actionKind: "identity_manage", credential: "bootstrap" });
    }
  });

  it("an admin's API key cannot mint a key for someone else, but can for its own owner", async () => {
    const { token, tokenHash } = generateToken();
    await db.insert(apiKeys).values({ userId: adminId, name: "admin", tokenHash });
    adminKey = token;
    const other = await relaxed.inject({
      method: "POST",
      url: `/v1/users/${memberId}/keys`,
      headers: { authorization: `Bearer ${adminKey}` },
      payload: { name: "for-member" },
    });
    expect(other.statusCode, other.body).toBe(403);
    expect(other.json()).toMatchObject({ error: "step_up_required", actionKind: "identity_manage", credential: "api_key" });
    const own = await relaxed.inject({
      method: "POST",
      url: `/v1/users/${adminId}/keys`,
      headers: { authorization: `Bearer ${adminKey}` },
      payload: { name: "for-me" },
    });
    expect(own.statusCode, own.body).toBe(201);
  });
});
