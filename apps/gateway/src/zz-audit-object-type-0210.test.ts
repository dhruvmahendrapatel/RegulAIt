/**
 * Owner decisions of 2026-10-21 (issue #453, rows 1 and 2).
 *
 *  1. Migration 0210: `audit_log_object_at_idx ON audit_log (object_type, object_id, at DESC)`, built with CREATE
 *     INDEX CONCURRENTLY by `runMigrations` outside the migrator's transaction (`CONCURRENT_INDEXES`). Pinned here:
 *     a journal that stops before 0210 builds nothing; the head builds a VALID index with that exact definition; a
 *     second run issues no DDL; an INVALID index left by an interrupted build is rebuilt (the negative control shows
 *     `IF NOT EXISTS` alone would have kept it); a process that starts while another holds the build lock and is mid-build
 *     waits, never drops the in-progress index, and returns with it valid (#476 M1); a build held up by an old snapshot
 *     fails after `lock_timeout` naming the blocking session, and the next run rebuilds (#476 L1); and the planner uses the index for the `/v1/audit` and CSV reads the
 *     routes actually issue and for the use-case overview's trail.
 *  2. `GET /v1/audit` and `GET /v1/audit.csv` refuse an `objectType` the audit log cannot record with 400
 *     `unknown_object_type` (it used to be an empty 200), a known type still answers 200, and the two routes agree.
 *     The console's own link types (`apps/web/.../auditObjectLinks.ts`) are each a schema object type.
 *
 * Section 1's lifecycle runs on its OWN scratch database (prefix `aoi210_`), dropped in afterAll. The EXPLAIN checks
 * run on the shared suite database, which holds the rows earlier files wrote, so the planner has a real table.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  and,
  auditLog,
  buildConcurrentIndexes,
  CONCURRENT_INDEXES,
  CONCURRENT_INDEX_LOCK_KEY,
  CONCURRENT_INDEX_LOCK_NAMESPACE,
  ConcurrentIndexBlockedError,
  createDb,
  desc,
  eq,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { backdated } from "./testing/backdated-audit.js";
import { dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../../packages/db/migrations");
const SCRATCH_DB = `aoi210_${process.pid}_${Date.now()}`;
const TAG_0210 = "0210_audit_log_object_at_idx";
const INDEX = "audit_log_object_at_idx";
const BOOT = "aoi210-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };
const AT = new Date(Date.UTC(2026, 9, 21, 9, 0, 0));
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

type PoolLike = { query: (...a: unknown[]) => Promise<unknown>; connect: () => Promise<PgClient>; end: () => Promise<void> };
type PgClient = { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>; release: () => void };

let admin: Db;
let scratch: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;
let tmp: string;
const pre: { indexBefore0210?: string | null; builtBefore0210?: string[] } = {};

/** the index's definition, or null when there is none */
async function indexDef(on: Db): Promise<{ def: string; valid: boolean } | null> {
  const res = await on.execute<{ def: string; valid: boolean }>(sql`
    select pg_get_indexdef(c.oid) as "def", i.indisvalid as "valid"
      from pg_class c join pg_index i on i.indexrelid = c.oid join pg_namespace n on n.oid = c.relnamespace
     where c.relname = ${INDEX} and n.nspname = current_schema()`);
  return res.rows[0] ?? null;
}

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  scratch = createDb(urlFor(SCRATCH_DB));

  // migrate to the migration before 0210 only (0210 and anything after it cut from a copy of the journal)
  tmp = mkdtempSync(path.join(tmpdir(), "aoi210-"));
  cpSync(migrationsFolder, tmp, { recursive: true });
  const journalPath = path.join(tmp, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ when: number; tag: string }> };
  const entry = journal.entries.find((e) => e.tag === TAG_0210);
  expect(entry, `${TAG_0210} is not in the journal`).toBeDefined();
  journal.entries = journal.entries.filter((e) => e.when < entry!.when);
  writeFileSync(journalPath, JSON.stringify(journal));
  await runMigrations(scratch, tmp);
  pre.indexBefore0210 = (await indexDef(scratch))?.def ?? null;
  pre.builtBefore0210 = await buildConcurrentIndexes(scratch, tmp);

  // then the real folder, to the head
  await runMigrations(scratch, migrationsFolder);

  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
}, 240_000);

afterAll(async () => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  await app?.close();
  await scratch?.$client.end();
  await dropScratchDatabase(admin, SCRATCH_DB);
  await admin?.$client.end();
});

describe("migration 0210: the object index, built concurrently outside the migrator's transaction", () => {
  it("is declared once, as CONCURRENTLY IF NOT EXISTS, and the migration file itself changes no schema", () => {
    const ix = CONCURRENT_INDEXES.filter((i) => i.name === INDEX);
    expect(ix).toHaveLength(1);
    expect(ix[0]!.migration).toBe(TAG_0210);
    expect(ix[0]!.create).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_log_object_at_idx" ON "audit_log" \("object_type", "object_id", "at" DESC\)$/);
    const file = readFileSync(path.join(migrationsFolder, `${TAG_0210}.sql`), "utf8");
    const statements = file.split("\n").filter((l) => l.trim() !== "" && !l.trimStart().startsWith("--"));
    expect(statements).toEqual(["SELECT 1;"]);
  });

  it("a journal that stops before 0210 builds nothing", () => {
    expect(pre.indexBefore0210).toBeNull();
    expect(pre.builtBefore0210).toEqual([]);
  });

  it("the head has it, valid, on (object_type, object_id, at DESC)", async () => {
    for (const on of [scratch, db]) {
      const ix = await indexDef(on);
      expect(ix?.valid).toBe(true);
      expect(ix?.def).toMatch(/ON public\.audit_log USING btree \(object_type, object_id, at DESC\)$/);
    }
  });

  it("a second run issues no DDL", async () => {
    expect(await buildConcurrentIndexes(scratch, migrationsFolder)).toEqual([]);
  });

  it("an INVALID index left by an interrupted build is rebuilt, where IF NOT EXISTS alone would keep it", async () => {
    await scratch.execute(sql.raw(`DROP INDEX "${INDEX}"`));
    // two rows sharing an object_type make a UNIQUE concurrent build fail part way, leaving an INVALID index by that name
    await backdated(scratch).insert(auditLog).values(
      [0, 1].map((i) => ({ userId: randomUUID(), objectType: "agent" as const, effect: "allow" as const, ruleId: `aoi210-dup-${i}`, ruleChain: [], reason: "duplicate", at: AT })),
    );
    await expect(scratch.execute(sql.raw(`CREATE UNIQUE INDEX CONCURRENTLY "${INDEX}" ON "audit_log" ("object_type")`))).rejects.toThrow();
    expect((await indexDef(scratch))?.valid).toBe(false);
    // negative control: the bare statement keeps the broken index
    await scratch.execute(sql.raw(CONCURRENT_INDEXES.find((i) => i.name === INDEX)!.create));
    expect((await indexDef(scratch))?.valid).toBe(false);

    expect(await buildConcurrentIndexes(scratch, migrationsFolder)).toEqual([INDEX]);
    const ix = await indexDef(scratch);
    expect(ix?.valid).toBe(true);
    expect(ix?.def).toMatch(/^CREATE INDEX audit_log_object_at_idx ON public\.audit_log USING btree \(object_type, object_id, at DESC\)$/);
  });

  it("#476 M1: a second process waits for a build in progress under the lock, never drops it, and both end valid", async () => {
    await scratch.execute(sql.raw(`DROP INDEX IF EXISTS "${INDEX}"`));
    const side = createDb(urlFor(SCRATCH_DB), { max: 3 });
    const pool = side.$client as unknown as PoolLike;
    const holder = await pool.connect();
    const blocker = await pool.connect();
    let blockerOpen = false;
    let holderLocked = false;
    try {
      // an older snapshot holds the holder's CONCURRENTLY build in its final wait, so the index stays in progress
      await blocker.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      blockerOpen = true;
      await blocker.query("SELECT 1");
      const got = await holder.query(`select pg_try_advisory_lock($1::int, hashtext($2)) as "ok"`, [CONCURRENT_INDEX_LOCK_NAMESPACE, CONCURRENT_INDEX_LOCK_KEY]);
      expect((got.rows[0] as { ok: boolean }).ok).toBe(true);
      holderLocked = true;
      const holderBuild = holder.query(CONCURRENT_INDEXES.find((i) => i.name === INDEX)!.create);
      let during: { oid: string; valid: boolean } | undefined;
      for (let i = 0; i < 100 && !during; i++) {
        during = (await scratch.execute<{ oid: string; valid: boolean }>(sql`
          select c.oid::text as "oid", i.indisvalid as "valid" from pg_class c join pg_index i on i.indexrelid = c.oid
           where c.relname = ${INDEX}`)).rows[0];
        if (!during) await new Promise((r) => setTimeout(r, 50));
      }
      // the ambiguity M1 is about: a build in progress reads exactly like a failed one
      expect(during?.valid).toBe(false);

      let settled = false;
      const second = buildConcurrentIndexes(scratch, migrationsFolder, { pollMs: 50 }).finally(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 1_000));
      expect(settled).toBe(false);
      const still = await scratch.execute<{ oid: string }>(sql`select oid::text as "oid" from pg_class where relname = ${INDEX}`);
      expect(still.rows[0]?.oid).toBe(during!.oid);

      await blocker.query("COMMIT");
      blockerOpen = false;
      await holderBuild;
      await holder.query(`select pg_advisory_unlock($1::int, hashtext($2))`, [CONCURRENT_INDEX_LOCK_NAMESPACE, CONCURRENT_INDEX_LOCK_KEY]);
      holderLocked = false;
      // the second process saw it valid and issued no DDL: the same index, never dropped and rebuilt
      expect(await second).toEqual([]);
      const after = await scratch.execute<{ oid: string; valid: boolean }>(sql`
        select c.oid::text as "oid", i.indisvalid as "valid" from pg_class c join pg_index i on i.indexrelid = c.oid where c.relname = ${INDEX}`);
      expect(after.rows[0]).toEqual({ oid: during!.oid, valid: true });
    } finally {
      if (blockerOpen) await blocker.query("ROLLBACK");
      if (holderLocked) await holder.query(`select pg_advisory_unlock_all()`);
      blocker.release();
      holder.release();
      await pool.end();
    }
  }, 60_000);

  it("#476 L1: a build held up by an old snapshot fails after lock_timeout naming the blocker, and the next run rebuilds", async () => {
    await scratch.execute(sql.raw(`DROP INDEX IF EXISTS "${INDEX}"`));
    const side = createDb(urlFor(SCRATCH_DB), { max: 1 });
    const pool = side.$client as unknown as PoolLike;
    const blocker = await pool.connect();
    let open = false;
    try {
      await blocker.query("SET application_name = 'aoi210-blocker'");
      await blocker.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      open = true;
      await blocker.query("SELECT 1");
      const pid = ((await blocker.query("select pg_backend_pid() as pid")).rows[0] as { pid: number }).pid;
      const err = await buildConcurrentIndexes(scratch, migrationsFolder, { lockTimeoutMs: 500 }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ConcurrentIndexBlockedError);
      expect((err as Error).message).toContain(`pid ${pid} `);
      expect((err as Error).message).toContain("aoi210-blocker");
      expect((err as Error).message).toContain("lock_timeout (500 ms)");
      await blocker.query("ROLLBACK");
      open = false;
    } finally {
      if (open) await blocker.query("ROLLBACK");
      blocker.release();
      await pool.end();
    }
    // the build lock was released: the next run proceeds and rebuilds the INVALID index the timed-out build left
    expect(await buildConcurrentIndexes(scratch, migrationsFolder)).toEqual([INDEX]);
    expect((await indexDef(scratch))?.valid).toBe(true);
  }, 60_000);
});

/** EXPLAIN a statement with sequential scans priced as the last resort; the plan's JSON text */
async function plan(text: string, values: unknown[]): Promise<string> {
  const planner = createDb(DATABASE_URL!, { max: 1 });
  const pool = planner.$client as unknown as PoolLike;
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL enable_seqscan = off");
    const res = await c.query(`EXPLAIN (FORMAT JSON) ${text}`, values);
    return JSON.stringify(res.rows);
  } finally {
    await c.query("ROLLBACK");
    c.release();
    await pool.end();
  }
}

/** every statement `run` sends through the app's pool */
async function captured(run: () => Promise<unknown>): Promise<Array<{ text: string; values: unknown[] }>> {
  const client = db.$client as unknown as { query: (...a: unknown[]) => Promise<unknown> };
  const original = client.query.bind(client);
  const seen: Array<{ text: string; values: unknown[] }> = [];
  client.query = (...a: unknown[]) => {
    const q = a[0] as string | { text: string; values?: unknown[] };
    if (typeof q === "string") seen.push({ text: q, values: (a[1] as unknown[]) ?? [] });
    else seen.push({ text: q.text, values: q.values ?? (a[1] as unknown[]) ?? [] });
    return original(...a);
  };
  try {
    await run();
  } finally {
    client.query = original;
  }
  return seen;
}

describe("the object reads use the index", () => {
  const objectId = randomUUID();
  beforeAll(async () => {
    await backdated(db).insert(auditLog).values(
      Array.from({ length: 3 }, (_, i) => ({ userId: randomUUID(), objectType: "ai_use_case" as const, objectId, effect: "allow" as const, ruleId: `aoi210-plan-${i}`, ruleChain: [], reason: "plan fixture", at: AT })),
    );
    await db.execute(sql`analyze "audit_log"`);
  });

  for (const route of ["/v1/audit", "/v1/audit.csv"]) {
    it(`GET ${route}?objectType=&objectId= as the route sends it`, async () => {
      const seen = await captured(async () => {
        const res = await app.inject({ method: "GET", headers: AUTH, url: `${route}?objectType=ai_use_case&objectId=${objectId}&from=${new Date(Date.UTC(2000, 0, 1)).toISOString()}` });
        expect(res.statusCode, res.body).toBe(200);
      });
      const stmt = seen.find((s) => /from "audit_log"/i.test(s.text) && /"object_id" = \$/.test(s.text));
      expect(stmt, JSON.stringify(seen.map((s) => s.text))).toBeDefined();
      const text = await plan(stmt!.text, stmt!.values);
      expect(text).toContain(INDEX);
      expect(text).not.toContain('"Seq Scan"');
    });
  }

  it("the use-case overview's trail and count (the route's own predicate, order and window count)", async () => {
    // the same query as apps/gateway/src/use-case-overview.ts builds
    const q = db
      .select({ id: auditLog.id, total: sql<number>`count(*) over ()::int` })
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "ai_use_case"), eq(auditLog.objectId, objectId)))
      .orderBy(desc(auditLog.at))
      .limit(20)
      .toSQL();
    const text = await plan(q.sql, q.params);
    expect(text).toContain(INDEX);
    expect(text).not.toContain('"Seq Scan"');
    const source = readFileSync(path.join(here, "use-case-overview.ts"), "utf8");
    expect(source).toContain('.where(and(eq(auditLog.objectType, "ai_use_case"), eq(auditLog.objectId, useCaseId)))');
    expect(source).toContain(".orderBy(desc(auditLog.at))");
  });
});

describe("objectType is validated (owner decision 2026-10-21, #453 row 2)", () => {
  const objectId = randomUUID();
  beforeAll(async () => {
    await backdated(db).insert(auditLog).values(
      Array.from({ length: 2 }, (_, i) => ({ userId: randomUUID(), objectType: "agent" as const, objectId, effect: "allow" as const, ruleId: `aoi210-known-${i}`, ruleChain: [], reason: `known ${i}`, at: AT })),
    );
  });

  for (const url of ["/v1/audit?objectType=not_an_object_type", "/v1/audit.csv?objectType=not_an_object_type", "/v1/audit.csv?signed=1&objectType=not_an_object_type", `/v1/audit?objectType=AGENT&objectId=${objectId}`]) {
    it(`400 unknown_object_type on ${url}, naming the parameter and not the value list`, async () => {
      const res = await app.inject({ method: "GET", headers: AUTH, url });
      expect(res.statusCode).toBe(400);
      expect(res.headers["content-type"]).toContain("application/json");
      const body = res.json();
      expect(body.error).toBe("unknown_object_type");
      expect(body.detail).toContain("objectType");
      for (const known of ["mcp_tool", "ai_use_case", "audit_export"]) expect(body.detail).not.toContain(known);
    });
  }

  it("a known type answers 200 on both routes, with the same rows", async () => {
    const from = new Date(Date.UTC(2000, 0, 1)).toISOString();
    const json = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?objectType=agent&objectId=${objectId}&from=${from}&limit=1000` });
    expect(json.statusCode).toBe(200);
    const entries = json.json().entries as Array<{ ruleId: string; objectType: string }>;
    expect(entries.map((e) => e.ruleId).sort()).toEqual(["aoi210-known-0", "aoi210-known-1"]);
    const csv = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit.csv?objectType=agent&objectId=${objectId}&from=${from}` });
    expect(csv.statusCode).toBe(200);
    const lines = csv.body.trimEnd().split("\n").filter((l) => l.includes(objectId));
    expect(lines).toHaveLength(entries.length);
    for (const e of entries) expect(lines.some((l) => l.includes(e.ruleId))).toBe(true);
  });

  it("every object type the console links a trail for is one the schema declares", () => {
    const src = readFileSync(path.resolve(here, "../../web/src/views/admin/governance/auditObjectLinks.ts"), "utf8");
    const list = /new Set\(\[([^\]]*)\]\)/.exec(src)?.[1];
    expect(list, "AUDIT_OBJECT_LINK_TYPES not found").toBeDefined();
    const types = [...list!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(types.length).toBeGreaterThan(0);
    const known = new Set<string>(auditLog.objectType.enumValues);
    for (const t of types) expect(known.has(t), t).toBe(true);
  });
});
