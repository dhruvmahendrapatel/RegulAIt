/**
 * REL-01 / REL-02 / OPS-01 / REL-12 — the serving process survives what used
 * to kill it, and stops the way it was designed to.
 *
 *  1. An IDLE pooled connection losing its backend (`pg_terminate_backend`, a
 *     Postgres restart, an LB idle reset) is an `'error'` EVENT on the pg
 *     Pool. With no listener Node throws it and the whole gateway died.
 *     `createDb` now listens; the next query reconnects.
 *  2. SIGTERM/SIGINT ran Node's default (sever everything). Now they drain:
 *     `app.close()` runs the onClose hooks, the pool is ended, exit 0 — under
 *     a deadline, and a second signal exits at once.
 *  3. The anchor timer stacked a new capture on a hung one every interval.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, sql, type Db } from "@regulait/db";
import { installShutdownHandlers, startGateway, withoutOverlap } from "./boot.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const SCRATCH_DB = `regulait_lifecycle_${process.pid}`;
const scratchUrl = DATABASE_URL.replace(/\/[^/?]+(\?|$)/, `/${SCRATCH_DB}$1`);
const REAL_KEY = "3f9a1c7e2b8d4f60a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718";
let admin: Db;

type PoolLike = {
  on: (ev: string, fn: (err: Error) => void) => void;
  listenerCount: (ev: string) => number;
  idleCount: number;
  totalCount: number;
  ended?: boolean;
  end: () => Promise<void>;
  connect: () => Promise<CheckedOutClient>;
};
type CheckedOutClient = {
  query: (text: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
  listenerCount: (ev: string) => number;
  release: (err?: Error) => void;
};
/** the postgres lines createDb prints — the only console.error calls these tests attribute to the pool */
const pgLines = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((c) => String(c[0])).filter((line) => line.startsWith("[regulait] postgres:"));
const poolOf = (handle: Db) => (handle as unknown as { $client: PoolLike }).$client;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === "object" && addr ? resolve(addr.port) : reject(new Error("no port"))));
    });
  });
}

const until = async (pred: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  const migrator = createDb(scratchUrl);
  await runMigrations(migrator, migrationsFolder);
  await poolOf(migrator).end();
}, 90_000);

afterAll(async () => {
  await closeAll([async () => dropScratchDatabase(admin, SCRATCH_DB), async () => poolOf(admin).end()]);
});

describe("REL-01: an idle pooled connection dying is logged, not fatal", () => {
  it("createDb listens for the pool's 'error' event and the next query reconnects", async () => {
    const db = createDb(scratchUrl);
    const pool = poolOf(db);
    try {
      // the listener is what stands between an idle backend reset and a crash
      expect(pool.listenerCount("error")).toBeGreaterThanOrEqual(1);

      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const res = await db.execute(sql`select pg_backend_pid()::int as pid`);
      const pid = Number((res as unknown as { rows: Array<{ pid: number }> }).rows[0]!.pid);
      await until(() => pool.idleCount === 1);

      // kill that backend from OUTSIDE while the client sits idle in the pool
      await admin.execute(sql`select pg_terminate_backend(${pid})`);
      // the pool notices (the 'error' event fires) and discards the client
      await until(() => pool.totalCount === 0);
      await until(() => logged.mock.calls.some((c) => String(c[0]).includes("idle pooled connection was dropped")));
      // EXACTLY ONE line for one idle drop, and it is the idle one. The durable
      // per-connection listener (the checked-out guard below) is attached while
      // the client idles too, and both listeners run in the same synchronous
      // emit — so by the line above it has already had its chance to speak. A
      // second, "lost mid-use … the in-flight query fails" line here would tell
      // an operator a request failed when nothing was in flight.
      const lines = pgLines(logged);
      expect(lines, lines.join("\n")).toHaveLength(1);
      expect(lines[0]).toContain("idle pooled connection was dropped");
      expect(lines.some((l) => l.includes("mid-use"))).toBe(false);

      // the process is still here, and the pool dials a fresh client
      const again = await db.execute(sql`select pg_backend_pid()::int as pid`);
      const pid2 = Number((again as unknown as { rows: Array<{ pid: number }> }).rows[0]!.pid);
      expect(pid2).not.toBe(pid);
      logged.mockRestore();
    } finally {
      await pool.end();
    }
  }, 30_000);
});

describe("REL-01: a CHECKED-OUT connection dying is logged, not fatal", () => {
  it("a backend killed under a held client fails the query, never reaches the process, and logs mid-use once", async () => {
    const db = createDb(scratchUrl);
    const pool = poolOf(db);
    // what the fix exists to prevent, counted directly rather than left to the
    // test runner's own unhandled-error reporting
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUncaught);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // released in `finally` if the test bails early, so `pool.end()` there can
    // never wait behind a still-sleeping statement
    let held: CheckedOutClient | undefined;
    try {
      // a client held the way a transaction holds one: pg-pool strips its idle
      // listener for exactly this window, so createDb's own is the only guard
      const client = await pool.connect();
      held = client;
      const durableListeners = client.listenerCount("error");
      const pid = Number((await client.query("select pg_backend_pid()::int as pid")).rows[0]!.pid);
      await client.query("begin");
      const inFlight = client.query("select pg_sleep(30)").then(
        () => null,
        (e: Error) => e,
      );
      // wait until the statement is really running on that backend
      for (let i = 0; ; i++) {
        const r = await admin.execute(sql`select count(*)::int as n from pg_stat_activity where pid = ${pid} and query like 'select pg_sleep%'`);
        if (Number((r as unknown as { rows: Array<{ n: number }> }).rows[0]!.n) === 1) break;
        if (i > 200) throw new Error("the held client's statement never started");
        await new Promise((r) => setTimeout(r, 20));
      }
      await admin.execute(sql`select pg_terminate_backend(${pid})`);

      // the failure surfaces where the caller awaits it
      const err = await inFlight;
      expect(err, "the in-flight query rejects").toBeInstanceOf(Error);
      // the connection's own 'error' event follows; it lands either on
      // createDb's listener (a log line) or, unguarded, on the process
      await until(() => pgLines(logged).length > 0 || uncaught.length > 0);
      expect(uncaught.map(String), "nothing reached the process").toEqual([]);
      expect(durableListeners, "a durable listener survives checkout").toBeGreaterThanOrEqual(1);
      client.release(err!);
      held = undefined;

      await until(() => pool.totalCount === 0);
      // reported once, as what it was: a mid-use loss, not an idle drop
      const lines = pgLines(logged);
      expect(lines, lines.join("\n")).toHaveLength(1);
      expect(lines[0]).toContain("lost mid-use");

      // and the same pool serves the next query from a fresh backend
      const again = await db.execute(sql`select pg_backend_pid()::int as pid`);
      expect(Number((again as unknown as { rows: Array<{ pid: number }> }).rows[0]!.pid)).not.toBe(pid);
    } finally {
      held?.release(new Error("test teardown"));
      logged.mockRestore();
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUncaught);
      await pool.end();
    }
  }, 30_000);
});

describe("REL-02 / OPS-01: a signal drains the gateway", () => {
  it("SIGTERM closes the app (onClose hooks run), ends the pool and exits 0", async () => {
    const db = createDb(scratchUrl);
    const port = await freePort();
    const lines: string[] = [];
    const env = { PATH: process.env.PATH, VITEST: "1" } as NodeJS.ProcessEnv;
    const started = await startGateway({
      db,
      migrationsFolder,
      port,
      host: "127.0.0.1",
      dataKey: REAL_KEY,
      log: () => {},
      env,
    });
    let onCloseRan = false;
    // a hook registered after listen is refused by Fastify, so observe the
    // server instead: closed means every onClose hook already ran
    const proc = new EventEmitter() as EventEmitter & { exit: (code?: number) => void };
    const exits: number[] = [];
    proc.exit = (code?: number) => {
      exits.push(code ?? 0);
    };
    started.app.server.once("close", () => {
      onCloseRan = true;
    });

    const { shutdown } = installShutdownHandlers(started, db, { proc, log: (l) => lines.push(l), graceMs: 10_000 });
    expect(proc.listenerCount("SIGTERM")).toBe(1);
    expect(proc.listenerCount("SIGINT")).toBe(1);
    expect(proc.listenerCount("unhandledRejection")).toBe(1);
    expect(proc.listenerCount("uncaughtException")).toBe(1);

    // the real /health answers before the signal...
    const before = await fetch(`http://127.0.0.1:${port}/health`);
    expect(before.status).toBe(200);

    proc.emit("SIGTERM");
    await until(() => exits.length > 0, 10_000);
    expect(exits).toEqual([0]);
    expect(onCloseRan).toBe(true);
    expect(started.app.server.listening).toBe(false);
    expect(poolOf(db).ended).toBe(true);
    expect(lines.some((l) => l.includes("received SIGTERM"))).toBe(true);
    expect(lines.some((l) => l.includes("stopped (exit 0)"))).toBe(true);
    // ...and the socket is gone afterwards
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();

    // the drain is idempotent: a later call reuses the same promise
    await shutdown("again", 0);
    expect(exits).toEqual([0]);
  }, 30_000);

  it("a second signal during the drain exits immediately; an unhandled rejection drains with exit 1", async () => {
    const db = createDb(scratchUrl);
    const port = await freePort();
    const env = { PATH: process.env.PATH, VITEST: "1" } as NodeJS.ProcessEnv;
    const started = await startGateway({ db, migrationsFolder, port, host: "127.0.0.1", dataKey: REAL_KEY, log: () => {}, env });
    const proc = new EventEmitter() as EventEmitter & { exit: (code?: number) => void };
    const exits: number[] = [];
    proc.exit = (code?: number) => {
      exits.push(code ?? 0);
    };
    const lines: string[] = [];
    installShutdownHandlers(started, db, { proc, log: (l) => lines.push(l), graceMs: 10_000 });

    proc.emit("unhandledRejection", new Error("boom in a background tick"));
    expect(lines.some((l) => l.includes("unhandled promise rejection") && l.includes("boom in a background tick"))).toBe(true);
    // hammering Ctrl-C mid-drain is answered at once
    proc.emit("SIGINT");
    expect(exits).toContain(1);
    await until(() => exits.length >= 2, 10_000);
    // the drain itself still finishes with the rejection's exit code
    expect(exits[exits.length - 1]).toBe(1);
    expect(poolOf(db).ended).toBe(true);
  }, 30_000);
});

describe("REL-12: a timer callback never overlaps itself", () => {
  it("withoutOverlap skips ticks while one is in flight, then runs again", async () => {
    let resolveFirst!: () => void;
    let runs = 0;
    const tick = withoutOverlap(async () => {
      runs += 1;
      if (runs === 1) await new Promise<void>((r) => (resolveFirst = r));
    });
    tick();
    tick();
    tick();
    expect(runs).toBe(1); // the hung first run swallowed the two ticks behind it
    resolveFirst();
    await new Promise((r) => setTimeout(r, 0));
    tick();
    expect(runs).toBe(2);
  });
});
