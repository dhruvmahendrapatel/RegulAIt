/**
 * ADR-0031 item 4 — per-IP / per-key HTTP rate limiting.
 *
 * The suite runs with REGULAIT_RATE_LIMIT=off (see vitest.config.ts), so these
 * tests build their own apps with the limiter explicitly ON — and separately
 * assert that the DEFAULT config, resolved from an empty environment, is
 * enabled, so the shipping posture is covered rather than assumed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import {
  AUTH_RATE_LIMIT_ROUTES,
  RATE_LIMIT_DEFAULTS,
  rateLimitMax,
  rateLimitWindowMs,
  resolveRateLimitConfig,
} from "./rate-limit.js";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
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

const SPRAYER = "192.0.2.50";
const NEIGHBOUR = "192.0.2.51";

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
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
      apiKeyMax: 50,
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
    expect(rateLimitMax(cfg, "key:rgl_abc")).toBe(cfg.apiKeyMax);
    expect(rateLimitMax(cfg, "ip:1.2.3.4")).toBe(cfg.globalMax);
    expect(rateLimitWindowMs(cfg, "auth:1.2.3.4")).toBe(cfg.authWindowMs);
    expect(rateLimitWindowMs(cfg, "ip:1.2.3.4")).toBe(cfg.globalWindowMs);
    // the credential endpoints are exactly the three unauthenticated ones
    expect([...AUTH_RATE_LIMIT_ROUTES].sort()).toEqual([
      "/auth/login",
      "/auth/login-with-key",
      "/auth/mfa/verify",
    ]);
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
