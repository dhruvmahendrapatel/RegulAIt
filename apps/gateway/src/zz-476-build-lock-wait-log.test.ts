/**
 * #476 (delta recheck, Low): a process waiting for the concurrent-index build lock says who holds it, at once and then
 * every `logEveryMs`, so an operator can see which session to end. A fake pinned client stands in for Postgres: the
 * lock is refused a few times, then granted, and the index already reads VALID, so no DDL runs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildConcurrentIndexes, CONCURRENT_INDEX_LOCK_LOG_MS, type Db } from "@regulait/db";

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

function fakeDb(refusals: number) {
  const queries: string[] = [];
  let tries = 0;
  const client = {
    async query(text: string) {
      queries.push(text);
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ ok: ++tries > refusals }] };
      if (text.includes("from pg_locks")) return { rows: [{ pid: 4242, applicationName: "regulait-migrate" }] };
      if (text.includes("indisvalid")) return { rows: [{ valid: true }] };
      return { rows: [] };
    },
    release: () => {},
  };
  return { db: { $client: { connect: async () => client } } as unknown as Db, queries };
}

afterEach(() => vi.restoreAllMocks());

describe("#476: the build-lock wait names the holder", () => {
  it("logs the holder's pid and application name at once, and again every logEveryMs while it waits", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { db, queries } = fakeDb(4);
    expect(await buildConcurrentIndexes(db, migrationsFolder, { pollMs: 1, logEveryMs: 0 })).toEqual([]);
    const waits = log.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("waiting for it"));
    expect(waits).toHaveLength(4);
    for (const m of waits) expect(m).toContain('pid 4242, application "regulait-migrate"');
    // the holder is read from the advisory lock row, the same two keys the lock is taken with
    const holderQuery = queries.find((q) => q.includes("from pg_locks"))!;
    expect(holderQuery).toMatch(/locktype = 'advisory'/);
    expect(holderQuery).toMatch(/objsubid = 2/);
    expect(holderQuery).toMatch(/classid = \$1::int::oid and l\.objid = hashtext\(\$2\)::oid/);
  });

  it("by default says it once per 30 s, not once per poll", async () => {
    expect(CONCURRENT_INDEX_LOCK_LOG_MS).toBe(30_000);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { db } = fakeDb(5);
    await buildConcurrentIndexes(db, migrationsFolder, { pollMs: 1 });
    expect(log.mock.calls.filter((c) => String(c[0]).includes("waiting for it"))).toHaveLength(1);
  });

  it("an uncontended lock logs nothing and reads no holder", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { db, queries } = fakeDb(0);
    await buildConcurrentIndexes(db, migrationsFolder, { pollMs: 1 });
    expect(log).not.toHaveBeenCalled();
    expect(queries.some((q) => q.includes("from pg_locks"))).toBe(false);
  });
});
