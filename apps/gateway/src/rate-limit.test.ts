/**
 * ADR-0031 item 4 — per-IP / per-key HTTP rate limiting.
 *
 * The suite runs with REGULAIT_RATE_LIMIT=off (see vitest.config.ts), so these
 * tests build their own apps with the limiter explicitly ON — and separately
 * assert that the DEFAULT config, resolved from an empty environment, is
 * enabled, so the shipping posture is covered rather than assumed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, sql, type Db } from "@regulait/db";
import type { FastifyRequest } from "fastify";
import { buildApp } from "./app.js";
import {
  AUTH_RATE_LIMIT_ROUTES,
  RATE_LIMIT_DEFAULTS,
  SSO_RATE_LIMIT_ROUTES,
  rateLimitCredentialKey,
  rateLimitKey,
  rateLimitMax,
  rateLimitWindowMs,
  resolveRateLimitConfig,
} from "./rate-limit.js";
import { SharedRateLimitStore } from "./rate-limit-store.js";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "rate-limit-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
/** a REAL api key, so the credential tier can be driven from several IPs */
let userKeyAuth: { authorization: string };

const SPRAYER = "192.0.2.50";
const NEIGHBOUR = "192.0.2.51";

/** the ceilings this file pins — named so the assertions read against them */
const API_KEY_MAX = 50;
const SCIM_MAX = 4;
const SSO_MAX = 4;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // the counters live in Postgres (ADR-0125) and outlive the process, so a
  // re-run against the same database must not inherit the last run's counts
  await db.execute(sql`delete from rate_limit_counters where bucket like '%192.0.2.%' or bucket like 'cred:%'`);
  app = buildApp(db, {
    bootstrapToken: BOOT,
    // trust nothing: the limiter must key on the socket peer, not a header
    trustProxy: false,
    rateLimit: {
      enabled: true,
      globalMax: 5,
      globalWindowMs: 60_000,
      authMax: 3,
      authWindowMs: 60_000,
      apiKeyMax: API_KEY_MAX,
      scimMax: SCIM_MAX,
      ssoMax: SSO_MAX,
    },
  });

  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: `rate-limit-${randomUUID()}@example.com`, displayName: "Rate Limited" },
  });
  expect(u.statusCode).toBe(201);
  userId = u.json().id;
  const k = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${userId}/keys`,
    payload: { name: "rate-limit" },
  });
  expect(k.statusCode).toBe(201);
  userKeyAuth = { authorization: `Bearer ${k.json().token}` };
});

afterAll(async () => {
  await app.close();
});

const tryLogin = (remoteAddress: string, email: string, extraHeaders: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url: "/auth/login",
    remoteAddress,
    headers: { ...CSRF, ...extraHeaders },
    payload: { email, password: "definitely-Wrong-1" },
  });

describe("ADR-0031: rate-limit configuration", () => {
  it("is ON by default, from an empty environment", () => {
    const cfg = resolveRateLimitConfig({});
    expect(cfg).toEqual(RATE_LIMIT_DEFAULTS);
    expect(cfg.enabled).toBe(true);
  });

  it("honours env overrides and the explicit off switch", () => {
    expect(resolveRateLimitConfig({ REGULAIT_RATE_LIMIT: "off" }).enabled).toBe(false);
    const cfg = resolveRateLimitConfig({
      REGULAIT_RATE_LIMIT_MAX: "42",
      REGULAIT_AUTH_RATE_LIMIT_MAX: "2",
      REGULAIT_API_KEY_RATE_LIMIT_MAX: "9999",
    });
    expect(cfg.globalMax).toBe(42);
    expect(cfg.authMax).toBe(2);
    expect(cfg.apiKeyMax).toBe(9999);
    // garbage falls back to the default rather than to zero (which would be a
    // self-inflicted outage)
    expect(resolveRateLimitConfig({ REGULAIT_RATE_LIMIT_MAX: "nope" }).globalMax).toBe(
      RATE_LIMIT_DEFAULTS.globalMax,
    );
  });

  it("routes each bucket to its own ceiling and window", () => {
    const cfg = resolveRateLimitConfig({});
    expect(rateLimitMax(cfg, "auth:1.2.3.4")).toBe(cfg.authMax);
    expect(rateLimitMax(cfg, "sso:1.2.3.4")).toBe(cfg.ssoMax);
    expect(rateLimitMax(cfg, "ipk:1.2.3.4")).toBe(cfg.apiKeyMax);
    expect(rateLimitMax(cfg, `cred:key:${randomUUID()}`)).toBe(cfg.apiKeyMax);
    expect(rateLimitMax(cfg, "cred:bootstrap")).toBe(cfg.apiKeyMax);
    expect(rateLimitMax(cfg, `cred:scim:${randomUUID()}`)).toBe(cfg.scimMax);
    expect(rateLimitMax(cfg, "ip:1.2.3.4")).toBe(cfg.globalMax);
    expect(rateLimitWindowMs(cfg, "auth:1.2.3.4")).toBe(cfg.authWindowMs);
    expect(rateLimitWindowMs(cfg, "sso:1.2.3.4")).toBe(cfg.ssoWindowMs);
    expect(rateLimitWindowMs(cfg, "ip:1.2.3.4")).toBe(cfg.globalWindowMs);
    // the credential endpoints are exactly the three unauthenticated ones
    expect([...AUTH_RATE_LIMIT_ROUTES].sort()).toEqual([
      "/auth/login",
      "/auth/login-with-key",
      "/auth/mfa/verify",
    ]);
    // CFG-06: and the SSO return legs are exactly the two
    expect([...SSO_RATE_LIMIT_ROUTES].sort()).toEqual(["/auth/oidc/callback", "/auth/saml/:providerId/acs"]);
  });

  it("ADR-0167: the pre-auth key is the client IP whatever the bearer says — the token never names a bucket", () => {
    const fake = (headers: Record<string, string>, url = "/v1/users") =>
      ({ ip: "203.0.113.9", url, routeOptions: { url }, headers }) as unknown as FastifyRequest;
    const junk = `rgl_${randomBytes(24).toString("hex")}`;
    expect(rateLimitKey(fake({}))).toBe("ip:203.0.113.9");
    expect(rateLimitKey(fake({ authorization: `Bearer ${junk}` }))).toBe("ipk:203.0.113.9");
    expect(rateLimitKey(fake({ authorization: "Bearer dev-bootstrap" }))).toBe("ipk:203.0.113.9");
    // ADR-0037's per-token SCIM ceiling is the credential tier's; before the
    // token resolves a SCIM request is a bearer-carrying request from an address
    expect(rateLimitKey(fake({ authorization: `Bearer ${junk}` }, "/scim/v2/Users"))).toBe("ipk:203.0.113.9");
    expect(rateLimitKey(fake({}, "/scim/v2/Users"))).toBe("ip:203.0.113.9");
    expect(rateLimitKey(fake({}, "/auth/saml/:providerId/acs"))).toBe("sso:203.0.113.9");
    expect(rateLimitKey(fake({}, "/auth/oidc/callback"))).toBe("sso:203.0.113.9");
    const variants: Array<Record<string, string>> = [{}, { authorization: `Bearer ${junk}` }];
    for (const h of variants) {
      expect(rateLimitKey(fake(h))).not.toContain(junk.slice(4, 12));
    }
    // the credential tier is named by the STORED row id, and only for bearers
    const keyId = randomUUID();
    expect(rateLimitCredentialKey({ userId: "u", isAdmin: false, via: "api-key", apiKeyId: keyId })).toBe(
      `cred:key:${keyId}`,
    );
    expect(rateLimitCredentialKey({ userId: "u", isAdmin: false, via: "virtual-key", virtualKeyId: keyId })).toBe(
      `cred:vkey:${keyId}`,
    );
    expect(rateLimitCredentialKey({ userId: null, isAdmin: true, via: "bootstrap" })).toBe("cred:bootstrap");
    expect(rateLimitCredentialKey({ userId: "u", isAdmin: false, via: "session" })).toBeNull();
  });
});

const counterRows = async (pattern: string): Promise<number> => {
  const res = (await db.execute(
    sql`select count(*)::int as n from rate_limit_counters where bucket like ${pattern}`,
  )) as unknown as Array<{ n: number }> | { rows?: Array<{ n: number }> };
  const row = Array.isArray(res) ? res[0] : res.rows?.[0];
  return Number(row?.n ?? 0);
};

describe("ADR-0167 (AUTHZ-01 / CFG-01): a bearer the gateway has not verified cannot buy a bucket", () => {
  it("rotating a junk bearer on every request from one IP still meets the per-IP ceiling, and costs ONE counter row", async () => {
    const rotator = "192.0.2.90";
    const codes: number[] = [];
    for (let i = 0; i < API_KEY_MAX + 10; i++) {
      // a fresh, never-seen, well-formed-looking credential on every request —
      // the shape of a key-guessing or route-scanning client
      const junk = `rgl_${randomBytes(24).toString("hex")}`;
      const res = await app.inject({
        method: "GET",
        url: "/v1/audit",
        remoteAddress: rotator,
        headers: { authorization: `Bearer ${junk}` },
      });
      codes.push(res.statusCode);
    }
    expect(codes.filter((c) => c === 401).length).toBe(API_KEY_MAX);
    expect(codes.filter((c) => c === 429).length).toBe(10);
    // ADR-0125's bound, restored: rows grow with distinct CALLERS, not requests
    expect(await counterRows(`ipk:${rotator}`)).toBe(1);
    expect(await counterRows("key:%")).toBe(0);
    expect(await counterRows("cred:key:%")).toBe(0);
  });

  it("the SCIM surface is no different: rotated bearers on /scim/v2 share ONE per-IP bucket and mint no per-token rows", async () => {
    const rotator = "192.0.2.91";
    for (let i = 0; i < SCIM_MAX + 2; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/scim/v2/Users",
        remoteAddress: rotator,
        headers: { authorization: `Bearer rglscim_${randomBytes(32).toString("hex")}` },
      });
      // never-seen tokens: the scope's own 401, counted against the address
      expect(res.statusCode).toBe(401);
    }
    expect(await counterRows(`ipk:${rotator}`)).toBe(1);
    expect(await counterRows("cred:scim:%")).toBe(0);
    // (the per-TOKEN ceiling — scimMax, keyed on the stored token id — is
    // proved in scim.test.ts, where a real token exists to be refused)
  });

  it("the credential tier: ONE resolved api key shares ONE bucket across every IP it is used from", async () => {
    const [a, b] = ["192.0.2.92", "192.0.2.93"];
    const codes: number[] = [];
    for (let i = 0; i < API_KEY_MAX + 6; i++) {
      // alternate addresses, so neither per-IP bucket comes near its ceiling —
      // only a bucket named by the key itself can refuse the 51st request
      const res = await app.inject({
        method: "GET",
        headers: userKeyAuth,
        remoteAddress: i % 2 === 0 ? a : b,
        url: `/v1/users/${userId}/agents`,
      });
      codes.push(res.statusCode);
    }
    expect(codes.filter((c) => c === 200).length).toBe(API_KEY_MAX);
    expect(codes.filter((c) => c === 429).length).toBe(6);
    expect(await counterRows("cred:key:%")).toBe(1);
  });
});

describe("ADR-0167 (CFG-06): the SSO return legs ride their own per-IP bucket", () => {
  it("the SAML ACS and the OIDC callback share the sso bucket — neither the anonymous nor the spray one", async () => {
    const ip = "192.0.2.94";
    const codes: number[] = [];
    for (let i = 0; i < SSO_MAX + 2; i++) {
      // alternate the two legs: they are one surface to a flood
      const res =
        i % 2 === 0
          ? await app.inject({
              method: "POST",
              url: `/auth/saml/${randomUUID()}/acs`,
              remoteAddress: ip,
              headers: { "content-type": "application/x-www-form-urlencoded" },
              payload: "SAMLResponse=bm90LWEtcmVzcG9uc2U%3D",
            })
          : await app.inject({ method: "GET", url: "/auth/oidc/callback?state=nope", remoteAddress: ip });
      codes.push(res.statusCode);
    }
    // under the ceiling: the routes' own refusals (unknown provider / bad state)
    expect(codes.slice(0, SSO_MAX).every((c) => c === 404 || c === 401)).toBe(true);
    expect(codes.slice(SSO_MAX).every((c) => c === 429)).toBe(true);
    expect(await counterRows(`sso:${ip}`)).toBe(1);
    // and the same address can still reach an ordinary anonymous route
    const other = await app.inject({ method: "GET", url: "/v1/audit", remoteAddress: ip });
    expect(other.statusCode).toBe(401);
  });

  it("an oversized SAMLResponse is refused as too large before anything is decoded", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/auth/saml/${randomUUID()}/acs`,
      remoteAddress: "192.0.2.95",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `SAMLResponse=${"A".repeat(300 * 1024)}`,
    });
    expect(res.statusCode).toBe(413);
    // the raw body was over the ACS route's own limit, so Fastify refused it
    // before the handler — and the error handler reports THAT honestly
    expect(res.json().error).toBe("body_too_large");
  });
});

describe("ADR-0167 (CFG-01): the local pre-filter is bounded", () => {
  it("stops growing past its cap — distinct callers over a long uptime are not a leak", async () => {
    // a db that answers every upsert; what is under test is the map, not SQL
    const fakeDb = {
      execute: async () => [{ hits: 1, window_started_at: new Date().toISOString() }],
    } as unknown as Db;
    const store = new SharedRateLimitStore(fakeDb, undefined, 25);
    const bump = (key: string) =>
      new Promise<void>((resolve, reject) => {
        store.incr(key, (err) => (err ? reject(err) : resolve()), 60_000, 100);
      });
    for (let i = 0; i < 200; i++) await bump(`ip:198.51.100.${i}`);
    expect(store.localBucketCount()).toBeLessThanOrEqual(25);
    // and a live caller is still counted correctly after an eviction pass
    let last = 0;
    for (let i = 0; i < 3; i++) {
      await new Promise<void>((resolve, reject) => {
        store.incr("ip:198.51.100.7", (err, res) => (err ? reject(err) : ((last = res!.current), resolve())), 60_000, 100);
      });
    }
    expect(last).toBeGreaterThanOrEqual(1);
  });
});

describe("ADR-0031: the auth bucket stops credential spraying across accounts", () => {
  it("throttles one IP walking many DIFFERENT accounts — which the per-account lockout cannot see", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      // a different account every time, so the ADR-0025 per-account lockout
      // never engages; only a per-IP bound can stop this
      const res = await tryLogin(SPRAYER, `spray-${i}-${randomUUID()}@example.com`);
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 3).every((c) => c === 401)).toBe(true);
    expect(codes.slice(3).every((c) => c === 429)).toBe(true);

    const blocked = await tryLogin(SPRAYER, `spray-final-${randomUUID()}@example.com`);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe("rate_limited");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(blocked.headers["x-ratelimit-limit"]).toBe("3");
  });

  it("does not punish a different client IP for the sprayer's behaviour", async () => {
    const res = await tryLogin(NEIGHBOUR, `neighbour-${randomUUID()}@example.com`);
    expect(res.statusCode).toBe(401);
  });

  it("a forged x-forwarded-for cannot buy the sprayer a fresh bucket", async () => {
    // the app trusts no proxy (item 3), so the header is ignored and the
    // sprayer's socket address keeps counting
    const res = await tryLogin(SPRAYER, `spray-forged-${randomUUID()}@example.com`, {
      "x-forwarded-for": "198.51.100.99",
    });
    expect(res.statusCode).toBe(429);
  });

  it("the auth bucket is separate from the general bucket — spraying does not consume the API allowance", async () => {
    // the sprayer is at its auth ceiling; an authenticated API call from the
    // same address still works, because it counts against the key bucket
    const res = await app.inject({
      method: "GET",
      headers: AUTH,
      remoteAddress: SPRAYER,
      url: `/v1/users/${userId}/agents`,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("ADR-0031: the general bucket", () => {
  it("bounds an unauthenticated flood, and /health is never throttled", async () => {
    const flooder = "192.0.2.70";
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await app.inject({ method: "GET", url: "/v1/audit", remoteAddress: flooder });
      codes.push(res.statusCode);
    }
    // globalMax = 5: the first five get the ordinary 401, the rest are 429
    expect(codes.filter((c) => c === 401).length).toBe(5);
    expect(codes.filter((c) => c === 429).length).toBe(2);

    // a liveness poll from the same throttled address still answers
    for (let i = 0; i < 5; i++) {
      const health = await app.inject({ method: "GET", url: "/health", remoteAddress: flooder });
      expect(health.statusCode).toBe(200);
    }
  });

  it("gives an API-key caller its own, larger allowance instead of sharing one per-IP bucket", async () => {
    const busy = "192.0.2.80";
    // well past globalMax (5) — a shared per-IP bucket would have 429'd by now
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: "GET",
        headers: AUTH,
        remoteAddress: busy,
        url: "/v1/users",
      });
      expect(res.statusCode).toBe(200);
    }
  });
});
