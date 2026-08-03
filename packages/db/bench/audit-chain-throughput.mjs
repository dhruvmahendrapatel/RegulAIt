/**
 * ADR-0060 — the throughput cost of serializing audit appends at the chain tip.
 *
 * The ADR says the lock "must be measured, not assumed". This is the harness
 * that measured it, kept so the number can be re-measured on any box rather than
 * quoted forever from one run on one laptop.
 *
 *   node packages/db/bench/audit-chain-throughput.mjs
 *
 * It CREATES AND DROPS its own `regulait_throughput` database and needs
 * `packages/db` built (`pnpm --filter @regulait/db build`). It writes nothing
 * anywhere else.
 *
 * What it compares: N sequential inserts through an UNWRAPPED drizzle handle
 * (no chaining — the pre-ADR-0060 behaviour) against the same N through the
 * handle `createDb` actually returns. Then the two things that matter in
 * practice: a BATCHED insert (one lock, one tip read, 100 rows) and a
 * CONCURRENCY SWEEP, which is where a global lock either does or does not show
 * up as a ceiling.
 */
// ADR-0060 throughput harness: N sequential audit inserts, unchained vs chained.
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as dbpkg from "/home/user/RegulAIt/packages/db/dist/index.js";

const URL_ = "postgres://regulait:regulait@localhost:5432/regulait_throughput";
const admin = dbpkg.createDb("postgres://regulait:regulait@localhost:5432/postgres");
await admin.execute(dbpkg.sql.raw(`DROP DATABASE IF EXISTS regulait_throughput WITH (FORCE)`));
await admin.execute(dbpkg.sql.raw(`CREATE DATABASE regulait_throughput`));

const chained = dbpkg.createDb(URL_);
await dbpkg.runMigrations(chained, "/home/user/RegulAIt/packages/db/migrations");

const pool = new pg.Pool({ connectionString: URL_ });
const raw = drizzle(pool, { schema: dbpkg.schema }); // NOT wrapped -> unchained

const row = (i) => ({
  userId: "00000000-0000-0000-0000-0000000000aa",
  objectType: "mcp_tool", effect: "allow", ruleId: "bench",
  ruleChain: ["grant"], reason: `bench ${i}`,
  detail: { phase: "call", i, args: { a: 1, b: "x" } },
});

const N = 500;
const time = async (label, fn) => {
  // warm-up
  for (let i = 0; i < 25; i++) await fn(i);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) await fn(i);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`${label}: ${N} sequential inserts in ${ms.toFixed(1)} ms  =>  ${(ms / N).toFixed(3)} ms/row, ${(N / (ms / 1000)).toFixed(0)} rows/s`);
  return ms;
};

const before = await time("UNCHAINED (baseline)", (i) => raw.insert(dbpkg.auditLog).values(row(i)));
const after = await time("CHAINED   (ADR-0060) ", (i) => chained.insert(dbpkg.auditLog).values(row(i)));
console.log(`\noverhead: ${((after / before - 1) * 100).toFixed(0)}%  (+${((after - before) / N).toFixed(3)} ms/row)`);

// batched: 100 rows in one .values([...])
const batch = Array.from({ length: 100 }, (_, i) => row(i));
const tb0 = process.hrtime.bigint();
for (let k = 0; k < 5; k++) await chained.insert(dbpkg.auditLog).values(batch);
const bms = Number(process.hrtime.bigint() - tb0) / 1e6;
console.log(`CHAINED batched: 500 rows in 5 batches of 100 = ${bms.toFixed(1)} ms => ${(bms / 500).toFixed(3)} ms/row`);

// concurrency sweep: what the serialize-at-the-tip lock actually costs
for (const width of [1, 4, 8, 16, 32, 64]) {
  const total = 200;
  const t0 = process.hrtime.bigint();
  for (let done = 0; done < total; done += width) {
    await Promise.all(Array.from({ length: Math.min(width, total - done) }, (_, i) => chained.insert(dbpkg.auditLog).values(row(i))));
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`CHAINED concurrency=${String(width).padStart(2)}: ${total} rows in ${ms.toFixed(0)} ms => ${(total / (ms / 1000)).toFixed(0)} rows/s aggregate`);
}

await pool.end();
process.exit(0);
