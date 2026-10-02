/**
 * ADR-0125 / ROADMAP G1 — the HTTP edge limiter's counters are SHARED.
 *
 * WHAT THIS FILE IS FOR, AND WHY rate-limit.test.ts DOES NOT COVER IT.
 * That file builds ONE app and proves the ceilings hold. Every one of its
 * assertions passed before this change and passes after it, because a single
 * process cannot tell a shared counter from a local one. The defect G1 names
 * is invisible to a single-process test by construction: with N processes the
 * old store admitted N x the configured ceiling, and the posture page went on
 * reporting the configured number.
 *
 * So the test that means anything is TWO apps on ONE database. Two `buildApp`
 * calls are genuinely two independent limiter instances with two independent
 * in-process Maps — the same thing two replicas behind a load balancer have —
 * so if the counter were still local, app B would start from zero and these
 * tests would fail.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, sql, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { SharedRateLimitStore, pruneRateLimitCounters } from "./rate-limit-store.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "shared-rl-bootstrap";

/**
 * Each test owns its own caller address so buckets never collide — and the
 * third octet is randomised per RUN because these rows outlive the process:
 * they are in Postgres now, which is the entire point of the change, so a
 * re-run against the same database would otherwise inherit its predecessor's
 * counts and fail for a reason that has nothing to do with the code.
 */
const RUN = Math.floor(Math.random() * 250) + 1;
let seq = 0;
const nextIp = () => `198.51.${RUN}.${(seq += 1)}`;

let db: Db;
/** two independent processes, as far as the limiter is concerned */
let alpha: ReturnType<typeof buildApp>;
let bravo: ReturnType<typeof buildApp>;

const MAX = 4;

function makeApp() {
  return buildApp(db, {
    bootstrapToken: BOOT,
    trustProxy: false,
    rateLimit: { enabled: true, globalMax: MAX, globalWindowMs: 60_000, authMax: 50, apiKeyMax: 500 },
  });
}

/**
 * DELIBERATELY UNAUTHENTICATED. `rateLimitKey` buckets a caller presenting a
 * Bearer token under `ipk:<ip>` with the far larger apiKeyMax ceiling (ADR-0167:
 * still the IP, never the token); only an anonymous caller lands in the `ip:`
 * bucket these tests are about. The limiter runs in an onRequest hook ahead of
 * authentication precisely so that an unauthenticated flood is bounded, so a
 * 401 still counts — which is the behaviour under test. (The first draft of
 * this file sent AUTH and every assertion failed against a 500-request
 * ceiling; the bug was the test's.)
 */
const hit = (app: ReturnType<typeof buildApp>, ip: string) =>
  app.inject({ method: "GET", url: "/v1/users", remoteAddress: ip });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  alpha = makeApp();
  bravo = makeApp();
  await db.execute(sql`delete from rate_limit_counters where bucket like ${`ip:198.51.${RUN}.%`}`);
});

afterAll(async () => {
  await alpha.close();
  await bravo.close();
});

describe("two processes, one ceiling", () => {
  it("THE G1 CLAIM: requests spent on one process count against the other", async () => {
    const ip = nextIp();

    // three on alpha — under the ceiling of four, all allowed
    for (let i = 0; i < 3; i += 1) {
      expect((await hit(alpha, ip)).statusCode).not.toBe(429);
    }

    // bravo has served this caller ZERO times. Before G1 it would have had a
    // fresh local counter and allowed four more; the whole defect is that the
    // deployment's real ceiling was max x replicas.
    expect((await hit(bravo, ip)).statusCode).not.toBe(429);
    const fifth = await hit(bravo, ip);
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json().error).toBe("rate_limited");

    // and the refusal names the CONFIGURED number, not a per-process share of it
    expect(fifth.json().detail).toContain(`limit ${MAX}`);
  });

  it("the counter is one row in Postgres, keyed by the caller", async () => {
    const ip = nextIp();
    await hit(alpha, ip);
    await hit(bravo, ip);
    const rows = (await db.execute(
      sql`select hits from rate_limit_counters where bucket = ${`ip:${ip}`}`,
    )) as unknown as Array<{ hits: number }>;
    const found = Array.isArray(rows) ? rows[0] : (rows as { rows?: unknown[] }).rows?.[0];
    expect(Number((found as { hits: number }).hits)).toBe(2);
  });

  it("one caller's ceiling is not another's", async () => {
    const loud = nextIp();
    const quiet = nextIp();
    for (let i = 0; i < MAX + 1; i += 1) await hit(alpha, loud);
    expect((await hit(alpha, loud)).statusCode).toBe(429);
    expect((await hit(bravo, quiet)).statusCode).not.toBe(429);
  });
});

describe("the local pre-filter", () => {
  it("stops writing to the database once a bucket is saturated — a flood is not a write storm", async () => {
    const ip = nextIp();
    const bucket = `ip:${ip}`;
    const hitsNow = async () => {
      const rows = (await db.execute(
        sql`select hits from rate_limit_counters where bucket = ${bucket}`,
      )) as unknown as Array<{ hits: number }>;
      const r = Array.isArray(rows) ? rows[0] : (rows as { rows?: unknown[] }).rows?.[0];
      return r ? Number((r as { hits: number }).hits) : 0;
    };

    // saturate on ONE app, so its local counter alone reaches the ceiling
    for (let i = 0; i < MAX; i += 1) await hit(alpha, ip);
    const atSaturation = await hitsNow();

    // GUARD AGAINST A VACUOUS PASS. Everything below asserts that the row
    // STOPS advancing; a store that never wrote at all would satisfy that
    // trivially — and did, when this file was briefly run against the old
    // in-process store to check these tests could fail. So first prove the
    // writes were happening.
    expect(atSaturation).toBe(MAX);

    // twenty more from the same process: all refused, and NONE of them costs a
    // write. This is the property that keeps the limiter from becoming the
    // amplifier it exists to prevent.
    for (let i = 0; i < 20; i += 1) {
      expect((await hit(alpha, ip)).statusCode).toBe(429);
    }
    expect(await hitsNow()).toBe(atSaturation);
  });
});

describe("when Postgres is unreachable", () => {
  it("fails OPEN to the local count, and still enforces the ceiling on its own traffic", async () => {
    const errors: unknown[] = [];
    const broken = {
      execute: () => Promise.reject(new Error("connection terminated")),
    } as unknown as Db;
    const store = new SharedRateLimitStore(broken, (e) => errors.push(e));

    const call = (key: string) =>
      new Promise<{ current: number }>((resolve, reject) => {
        store.incr(key, (err, res) => (err ? reject(err) : resolve(res!)), 60_000, 3);
      });

    // it serves rather than refusing everything: a gateway cannot answer any
    // governed request without Postgres anyway, so failing closed here would
    // turn a blip into a louder outage, not a safer one
    expect((await call("ip:down")).current).toBe(1);
    expect((await call("ip:down")).current).toBe(2);
    expect(errors.length).toBeGreaterThan(0);

    // and the degradation is bounded: the local ceiling still applies, which
    // is exactly the pre-G1 behaviour rather than no limit at all
    expect((await call("ip:down")).current).toBe(3);
    expect((await call("ip:down")).current).toBeGreaterThanOrEqual(3);
  });
});

describe("window roll and prune", () => {
  it("a window that has expired restarts at one rather than accumulating", async () => {
    const store = new SharedRateLimitStore(db);
    const key = `ip:roll-${Date.now()}`;
    const call = (windowMs: number) =>
      new Promise<{ current: number }>((resolve, reject) => {
        store.incr(key, (err, res) => (err ? reject(err) : resolve(res!)), windowMs, 100);
      });

    expect((await call(60_000)).current).toBe(1);
    expect((await call(60_000)).current).toBe(2);
    // a window of 1ms is already over by the time the next call lands
    await new Promise((r) => setTimeout(r, 5));
    expect((await call(1)).current).toBe(1);
  });

  it("prune deletes only rows no window could still be using", async () => {
    const fresh = `ip:prune-fresh-${Date.now()}`;
    const stale = `ip:prune-stale-${Date.now()}`;
    await db.execute(sql`insert into rate_limit_counters (bucket, window_started_at, hits)
      values (${fresh}, now(), 1), (${stale}, now() - interval '2 hours', 1)`);

    await pruneRateLimitCounters(db, 60 * 60 * 1000);

    const left = (await db.execute(
      sql`select bucket from rate_limit_counters where bucket in (${fresh}, ${stale})`,
    )) as unknown as Array<{ bucket: string }>;
    const rows = (Array.isArray(left) ? left : ((left as { rows?: unknown[] }).rows ?? [])) as Array<{
      bucket: string;
    }>;
    expect(rows.map((r) => r.bucket)).toEqual([fresh]);
  });
});
