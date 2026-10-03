/**
 * ADR-0167 (CFG-08) — the pool is bounded and /health cannot hang.
 *
 * `createDb` ran `new pg.Pool({ connectionString })` on every default: ten
 * clients and a connection timeout of ZERO, which in node-postgres means a
 * caller waiting for a free client waits forever. Ten slow operations stalled
 * every later request, and /health — which ran `select 1` through the same
 * pool — queued behind them instead of answering 503.
 *
 * The pool knobs are resolved from the environment and proved here; the
 * /health half is driven with a database whose `execute` never settles, so
 * the only way the route can answer at all is the deadline.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_POOL_DEFAULTS, createDb, describeDbPool, resolveDbPoolConfig, runMigrations, type Db } from "@regulait/db";
import { HEALTH_DB_TIMEOUT_MS, buildApp } from "./app.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

describe("the pool configuration", () => {
  it("is bounded from an empty environment — never pg's wait-forever default", () => {
    const cfg = resolveDbPoolConfig({} as NodeJS.ProcessEnv);
    expect(cfg).toEqual(DB_POOL_DEFAULTS);
    expect(cfg.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(cfg.max).toBeGreaterThan(10);
    expect(cfg.ssl).toBe("off");
  });

  it("honours the env knobs and falls back on garbage rather than throwing or going unbounded", () => {
    const cfg = resolveDbPoolConfig({
      REGULAIT_DB_POOL_MAX: "7",
      REGULAIT_DB_CONNECT_TIMEOUT_MS: "1500",
      REGULAIT_DB_IDLE_TIMEOUT_MS: "nope",
      REGULAIT_DATABASE_SSL: "require",
    } as NodeJS.ProcessEnv);
    expect(cfg.max).toBe(7);
    expect(cfg.connectionTimeoutMillis).toBe(1500);
    expect(cfg.idleTimeoutMillis).toBe(DB_POOL_DEFAULTS.idleTimeoutMillis);
    expect(cfg.ssl).toBe("require");
    expect(resolveDbPoolConfig({ REGULAIT_DATABASE_SSL: "no-verify" } as NodeJS.ProcessEnv).ssl).toBe("no-verify");
    expect(resolveDbPoolConfig({ REGULAIT_DB_CONNECT_TIMEOUT_MS: "0" } as NodeJS.ProcessEnv).connectionTimeoutMillis).toBe(
      DB_POOL_DEFAULTS.connectionTimeoutMillis,
    );
  });

  it("describes itself for the posture block, and says when the database hop is plaintext", () => {
    expect(describeDbPool(DB_POOL_DEFAULTS)).toContain("pool max 20");
    expect(describeDbPool(DB_POOL_DEFAULTS)).toContain("tls off");
    expect(describeDbPool({ ...DB_POOL_DEFAULTS, ssl: "require" })).toContain("certificate verified");
    expect(describeDbPool({ ...DB_POOL_DEFAULTS, ssl: "no-verify" })).toContain("NOT verified");
  });

  it("a caller waiting for a client past the deadline is refused, not held forever", async () => {
    // one client, a short deadline, and that one client is busy — the second
    // query must FAIL within the bound rather than queue indefinitely
    const tiny = createDb(DATABASE_URL, { max: 1, connectionTimeoutMillis: 300 });
    // drizzle's execute() is LAZY — nothing is sent until the promise is
    // awaited — so the occupying query is kicked off explicitly
    const busy = tiny.execute(`select pg_sleep(1.5)` as unknown as Parameters<Db["execute"]>[0]).then(() => "done");
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    let caught: unknown = null;
    try {
      await tiny.execute(`select 1` as unknown as Parameters<Db["execute"]>[0]);
    } catch (err) {
      caught = err;
    }
    // drizzle wraps the driver error ("Failed query"); pg's own reason is the cause
    expect(caught).toBeTruthy();
    const reason = `${(caught as Error).message} ${(caught as { cause?: Error }).cause?.message ?? ""}`;
    expect(reason).toMatch(/timeout/i);
    expect(Date.now() - started).toBeLessThan(1_400);
    expect(await busy).toBe("done");
  });
});

describe("/health under an exhausted pool", () => {
  let real: Db;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    real = createDb(DATABASE_URL);
    await runMigrations(real, migrationsFolder);
    // a db whose `execute` NEVER settles — what an exhausted pool looks like
    // from the route's side — while everything else buildApp touches is real
    const hanging = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "execute") return () => new Promise(() => {});
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;
    app = buildApp(hanging, { bootstrapToken: "db-pool-bootstrap" });
  });

  afterAll(async () => {
    await app.close();
  });

  it("answers 503 degraded within the deadline instead of hanging", async () => {
    const started = Date.now();
    const res = await app.inject({ method: "GET", url: "/health" });
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "degraded", database: "timeout" });
    expect(elapsed).toBeGreaterThanOrEqual(HEALTH_DB_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(HEALTH_DB_TIMEOUT_MS + 1_500);
  });
});
