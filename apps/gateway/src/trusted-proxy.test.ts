/**
 * ADR-0031 item 3 — X-Forwarded-* is honoured only from a named proxy.
 *
 * The load-bearing assertion is the FORGERY one: a request that arrives
 * directly at the gateway port carrying `x-forwarded-for: 203.0.113.9` must
 * NOT get 203.0.113.9 written into `auth_sessions.ip`, because that column is
 * the attribution record pillar 1 sells. The mirror assertion is that a
 * genuine hop from a trusted proxy still wins, so a real deployment behind
 * Caddy/an ALB does not lose the caller's address.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authSessions, createDb, desc, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { describeTrustProxy, resolveTrustProxy, TRUSTED_PROXIES_ENV } from "./trusted-proxy.js";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "trust-proxy-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };

const PROXY_IP = "10.9.9.9";
const DIRECT_IP = "198.51.100.7";
const FORGED = "203.0.113.9";

let db: Db;
/** trusts nothing (the default posture) */
let strict: ReturnType<typeof buildApp>;
/** trusts exactly PROXY_IP */
let behindProxy: ReturnType<typeof buildApp>;
let userId: string;
let apiKey: string;

/** the ip the gateway recorded for the most recent session of this user */
async function latestSessionIp(): Promise<string | null> {
  const [row] = await db
    .select({ ip: authSessions.ip, createdAt: authSessions.createdAt })
    .from(authSessions)
    .where(eq(authSessions.userId, userId))
    .orderBy(desc(authSessions.createdAt))
    .limit(1);
  return row?.ip ?? null;
}

async function signIn(
  app: ReturnType<typeof buildApp>,
  opts: { remoteAddress: string; forwardedFor?: string },
) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/login-with-key",
    remoteAddress: opts.remoteAddress,
    headers: opts.forwardedFor ? { ...CSRF, "x-forwarded-for": opts.forwardedFor } : CSRF,
    payload: { apiKey },
  });
  expect(res.statusCode).toBe(200);
  return res;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  strict = buildApp(db, { bootstrapToken: BOOT, trustProxy: false });
  behindProxy = buildApp(db, { bootstrapToken: BOOT, trustProxy: [PROXY_IP] });

  const u = await strict.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: `trust-proxy-${randomUUID()}@example.com`, displayName: "Proxy Probe" },
  });
  expect(u.statusCode).toBe(201);
  userId = u.json().id;

  const k = await strict.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${userId}/keys`,
    payload: { name: "trust-proxy-probe" },
  });
  expect(k.statusCode).toBe(201);
  apiKey = k.json().token;
});

afterAll(async () => {
  await strict.close();
  await behindProxy.close();
});

describe("ADR-0031: trusted-proxy env contract", () => {
  it("defaults to trusting nothing", () => {
    expect(resolveTrustProxy({})).toBe(false);
    expect(describeTrustProxy(false)).toContain("IGNORED");
  });

  it("parses a list of addresses/CIDRs/keywords, and the explicit off/all escapes", () => {
    expect(resolveTrustProxy({ [TRUSTED_PROXIES_ENV]: "10.0.0.1, 172.18.0.0/16 ,loopback" })).toEqual([
      "10.0.0.1",
      "172.18.0.0/16",
      "loopback",
    ]);
    for (const off of ["", "  ", "none", "false", "off", "0", "NO"]) {
      expect(resolveTrustProxy({ [TRUSTED_PROXIES_ENV]: off })).toBe(false);
    }
    for (const all of ["all", "true", "*", "ALL"]) {
      expect(resolveTrustProxy({ [TRUSTED_PROXIES_ENV]: all })).toBe(true);
    }
    expect(describeTrustProxy(true)).toContain("forgeable");
    expect(describeTrustProxy(["10.0.0.1"])).toContain("10.0.0.1");
  });
});

describe("ADR-0031: a forged x-forwarded-for never reaches the attribution record", () => {
  it("an UNTRUSTED peer's x-forwarded-for is ignored — the socket address is recorded", async () => {
    await signIn(strict, { remoteAddress: DIRECT_IP, forwardedFor: FORGED });
    const ip = await latestSessionIp();
    expect(ip).toBe(DIRECT_IP);
    expect(ip).not.toBe(FORGED);
  });

  it("...and that holds even when the forger claims to be the proxy itself", async () => {
    // a sibling container spoofing a whole forwarded chain
    await signIn(strict, {
      remoteAddress: DIRECT_IP,
      forwardedFor: `${FORGED}, ${PROXY_IP}`,
    });
    expect(await latestSessionIp()).toBe(DIRECT_IP);
  });

  it("a GENUINE hop from the trusted proxy DOES win", async () => {
    await signIn(behindProxy, { remoteAddress: PROXY_IP, forwardedFor: FORGED });
    expect(await latestSessionIp()).toBe(FORGED);
  });

  it("the same trusted-proxy app still ignores a forwarded header from a peer that is NOT the proxy", async () => {
    await signIn(behindProxy, { remoteAddress: DIRECT_IP, forwardedFor: FORGED });
    expect(await latestSessionIp()).toBe(DIRECT_IP);
  });

  it("and with no forwarded header at all, both postures record the socket address", async () => {
    await signIn(strict, { remoteAddress: DIRECT_IP });
    expect(await latestSessionIp()).toBe(DIRECT_IP);
    await signIn(behindProxy, { remoteAddress: PROXY_IP });
    expect(await latestSessionIp()).toBe(PROXY_IP);
  });
});
