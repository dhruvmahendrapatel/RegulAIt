/**
 * ADR-0343 slice 1 — N replicas boot at once against one database.
 *
 * drizzle's migrator takes no lock, so two replicas booting together both read the same watermark and both apply the
 * same files. `runMigrations` now takes one cluster-wide session advisory lock (`SESSION_LOCK_KEYS.migrations`) through
 * `withSessionAdvisoryLock`. These tests run against a real Postgres:
 *  - three concurrent `runMigrations` on a fresh database all succeed and leave exactly one journal row per migration;
 *  - the helper is mutually exclusive across pools, and says once that it is waiting;
 *  - a holder whose session dies (a crashed replica, a failover) does not leave the lock held.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, sql, withSessionAdvisoryLock, SESSION_LOCK_KEYS, type Db } from "@regulait/db";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../../packages/db/migrations");
const SCRATCH = `regulait_adr0343_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};
const end = (d: Db) => (d.$client as { end: () => Promise<void> }).end();
const rows = <T>(r: unknown) => (r as { rows: T[] }).rows;

let admin: Db;
const replicas: Db[] = [];

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH}`));
  for (let i = 0; i < 3; i++) replicas.push(createDb(urlFor(SCRATCH)));
}, 60_000);

afterAll(async () => {
  await closeAll([...replicas.map((r) => () => end(r)), () => dropScratchDatabase(admin, SCRATCH), () => end(admin)]);
});

describe("ADR-0343: replicas booting together", () => {
  it("three concurrent migration runs on a fresh database all succeed, and each migration is recorded once", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const results = await Promise.allSettled(replicas.map((r) => runMigrations(r, migrationsFolder)));
      expect(results.map((r) => (r.status === "rejected" ? String(r.reason) : "ok"))).toEqual(["ok", "ok", "ok"]);
      // at least one run had to wait, and said so
      expect(log.mock.calls.some((c) => String(c[0]).includes("another process is migrating this database"))).toBe(true);
    } finally {
      log.mockRestore();
    }
    const dup = rows<{ hash: string; n: number }>(
      await replicas[0]!.execute(sql`select hash, count(*)::int as n from drizzle.__drizzle_migrations group by hash having count(*) > 1`),
    );
    expect(dup).toEqual([]);
    // the lock is released: nobody holds the migration key now
    const held = rows<{ n: number }>(
      await admin.execute(
        sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and database = (select oid from pg_database where datname = ${SCRATCH})`,
      ),
    );
    expect(held[0]!.n).toBe(0);
  }, 300_000);

  it("withSessionAdvisoryLock never lets two holders overlap, across pools", async () => {
    const key = 0x5245_4741_5445_5354n; // "REGATEST", test-only
    let inside = 0;
    let maxInside = 0;
    const work = (r: Db) =>
      withSessionAdvisoryLock(r, key, async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await new Promise((res) => setTimeout(res, 50));
        inside--;
      });
    await Promise.all([work(replicas[0]!), work(replicas[1]!), work(replicas[2]!), work(replicas[0]!)]);
    expect(maxInside).toBe(1);
  });

  it("a holder whose session dies releases the lock, so a waiter proceeds (a crashed replica or a failover)", async () => {
    const key = SESSION_LOCK_KEYS.migrations;
    let holderPid = 0;
    let release!: () => void;
    const blocked = new Promise<void>((res) => (release = res));
    const holder = withSessionAdvisoryLock(replicas[0]!, key, async (c) => {
      holderPid = Number((await c.query("select pg_backend_pid() as pid")).rows[0]!.pid);
      await blocked;
    }).catch((e: unknown) => e);
    while (holderPid === 0) await new Promise((res) => setTimeout(res, 10));
    let waited = false;
    const waiter = withSessionAdvisoryLock(replicas[1]!, key, async () => "acquired", { onWait: () => (waited = true) });
    // kill the holder's backend, as a crash or a failover would
    await admin.execute(sql`select pg_terminate_backend(${holderPid})`);
    await expect(waiter).resolves.toBe("acquired");
    expect(waited).toBe(true);
    release();
    await holder;
  });
});
