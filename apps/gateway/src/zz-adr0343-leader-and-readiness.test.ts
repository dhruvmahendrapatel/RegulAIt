/**
 * ADR-0343 slice 1 — the two process-level pieces N replicas need, against a real Postgres:
 *  - `ClusterLeader`: exactly one of several replicas leads a boot timer; release hands over; a leader whose session
 *    dies (a crash, a failover) loses the lease and another replica takes it on its next tick.
 *  - `GET /ready`: 200 while serving, 503 `draining` from the moment a SIGTERM starts the drain, while `/health`
 *    (liveness) still answers 200 until the listener closes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, sql, type Db } from "@regulait/db";
import { CLUSTER_LEADER_KEYS, ClusterLeader, leaderOnly } from "./cluster-leader.js";
import { installShutdownHandlers, startGateway } from "./boot.js";
import { MAX_DRAIN_DELAY_MS, resolveDrainDelayMs } from "./readiness.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `regulait_adr0343_ready_${process.pid}`;
const scratchUrl = DATABASE_URL.replace(/\/[^/?]+(\?|$)/, `/${SCRATCH_DB}$1`);
const REAL_KEY = "3f9a1c7e2b8d4f60a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718";
const TEST_KEY = 0x5245_4741_4c54_5354n; // "REGALTST", test-only

const end = (d: Db) => (d.$client as { end: () => Promise<void> }).end();
const rows = <T>(r: unknown) => (r as { rows: T[] }).rows;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

/** the backend that holds a bigint advisory key (classid = high 32 bits, objid = low 32 bits, objsubid = 1) */
async function holderPid(admin: Db, key: bigint): Promise<number | null> {
  const r = rows<{ pid: number }>(
    await admin.execute(
      sql`select pid from pg_locks where locktype = 'advisory' and granted and objsubid = 1
          and ((classid::bigint << 32) | objid::bigint) = ${key.toString()}::bigint`,
    ),
  );
  return r[0]?.pid ?? null;
}

let admin: Db;
const replicas: Db[] = [];

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  for (let i = 0; i < 3; i++) replicas.push(createDb(DATABASE_URL));
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  const scratch = createDb(scratchUrl);
  await runMigrations(scratch, migrationsFolder);
  await end(scratch);
}, 180_000);

afterAll(async () => {
  await closeAll([...replicas.map((r) => () => end(r)), () => dropScratchDatabase(admin, SCRATCH_DB), () => end(admin)]);
});

describe("ADR-0343: ClusterLeader", () => {
  it("exactly one of three replicas leads, and release hands the lease over", async () => {
    const leaders = replicas.map((r) => new ClusterLeader(r, TEST_KEY));
    const first = await Promise.all(leaders.map((l) => l.isLeader()));
    expect(first.filter(Boolean)).toHaveLength(1);
    // asking again changes nothing: the leader stays the leader, followers stay followers
    expect(await Promise.all(leaders.map((l) => l.isLeader()))).toEqual(first);
    const idx = first.indexOf(true);
    await leaders[idx]!.release();
    expect(await leaders[idx]!.isLeader()).toBe(false); // a released leader never leads again
    const second = await Promise.all(leaders.map((l, i) => (i === idx ? false : l.isLeader())));
    expect(second.filter(Boolean)).toHaveLength(1);
    await Promise.all(leaders.map((l) => l.release()));
    expect(await holderPid(admin, TEST_KEY)).toBeNull();
  });

  it("a leader whose session dies loses the lease, and another replica takes it on its next tick", async () => {
    const a = new ClusterLeader(replicas[0]!, TEST_KEY);
    const b = new ClusterLeader(replicas[1]!, TEST_KEY);
    expect(await a.isLeader()).toBe(true);
    expect(await b.isLeader()).toBe(false);
    const pid = await holderPid(admin, TEST_KEY);
    expect(pid).not.toBeNull();
    await admin.execute(sql`select pg_terminate_backend(${pid})`);
    await sleep(100);
    expect(await b.isLeader()).toBe(true);
    // the old leader notices on its next tick and does not act
    expect(await a.isLeader()).toBe(false);
    await a.release();
    await b.release();
  });

  it("leaderOnly runs the tick on the leader alone", async () => {
    const leaders = replicas.map((r) => new ClusterLeader(r, CLUSTER_LEADER_KEYS.auditPrune));
    let ran = 0;
    const ticks = leaders.map((l) => leaderOnly(l, async () => void ran++));
    for (let round = 0; round < 3; round++) await Promise.all(ticks.map((t) => t()));
    expect(ran).toBe(3);
    await Promise.all(leaders.map((l) => l.release()));
  });

  it("the three boot-timer keys are distinct", () => {
    expect(new Set(Object.values(CLUSTER_LEADER_KEYS)).size).toBe(3);
  });
});

describe("ADR-0343: readiness and drain", () => {
  it("REGULAIT_DRAIN_DELAY_MS is bounded and defaults to 0", () => {
    expect(resolveDrainDelayMs({})).toBe(0);
    expect(resolveDrainDelayMs({ REGULAIT_DRAIN_DELAY_MS: "5000" })).toBe(5000);
    expect(resolveDrainDelayMs({ REGULAIT_DRAIN_DELAY_MS: "-1" })).toBe(0);
    expect(resolveDrainDelayMs({ REGULAIT_DRAIN_DELAY_MS: "abc" })).toBe(0);
    expect(resolveDrainDelayMs({ REGULAIT_DRAIN_DELAY_MS: "999999999" })).toBe(MAX_DRAIN_DELAY_MS);
  });

  it("SIGTERM flips /ready to 503 draining while /health still answers, then the listener closes", async () => {
    const db = createDb(scratchUrl);
    const port = await freePort();
    const env = { PATH: process.env.PATH, VITEST: "1", REGULAIT_DEV_PRIVILEGED_DB_LOGIN: "1" } as NodeJS.ProcessEnv;
    const started = await startGateway({ db, migrationsFolder, port, host: "127.0.0.1", dataKey: REAL_KEY, log: () => {}, env });
    const proc = new EventEmitter() as EventEmitter & { exit: (code?: number) => void };
    const exits: number[] = [];
    proc.exit = (code?: number) => void exits.push(code ?? 0);
    const lines: string[] = [];
    installShutdownHandlers(started, db, { proc, log: (l) => lines.push(l), graceMs: 10_000, drainDelayMs: 1_500 });

    const ready = await fetch(`http://127.0.0.1:${port}/ready`);
    const readyBody = await ready.text();
    expect(ready.status, readyBody).toBe(200);
    expect(JSON.parse(readyBody)).toEqual({ status: "ready", database: "ok" });

    proc.emit("SIGTERM");
    await sleep(200);
    const draining = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(draining.status).toBe(503);
    expect(await draining.json()).toEqual({ status: "draining" });
    // liveness is not readiness: the process is healthy, just leaving
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    expect(lines.some((l) => l.includes("readiness now 503 (draining)"))).toBe(true);

    for (let t = 0; t < 100 && exits.length === 0; t++) await sleep(100);
    expect(exits).toEqual([0]);
    await expect(fetch(`http://127.0.0.1:${port}/ready`)).rejects.toThrow();
  }, 30_000);
});
