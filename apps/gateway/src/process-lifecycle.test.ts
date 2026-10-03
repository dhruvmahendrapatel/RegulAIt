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
};
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
