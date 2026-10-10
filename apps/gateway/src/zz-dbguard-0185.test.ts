/**
 * Migration 0185 — database guard hardening.
 *
 *  1. Every function in `public` written in plpgsql or sql pins
 *     `search_path = pg_catalog, public, pg_temp`. Without it an unqualified
 *     table name in a guard resolves through the CALLER's search_path, which
 *     searches pg_temp first, so a session with only the default TEMP
 *     privilege can shadow a table the guard reads.
 *  2. Every table with a BEFORE ROW trigger that refuses an UPDATE or DELETE
 *     (plus `audit_log` and `audit_anchors`) also refuses TRUNCATE, which fires
 *     no row trigger.
 *
 * Negative controls: on a database migrated to the migration BEFORE 0185 the
 * temp-table shadow attack deletes an append-only evidence row and a TRUNCATE
 * of an append-only table succeeds; after migrating to the head both are
 * refused. The invariant checks are also shown to fire on the pre-0185
 * database, so they are not vacuous.
 *
 * Also I1R-01: the execution_profiles body CHECK (0183) passed on NULL; 0185 makes it NULL-safe.
 *
 * Runs on its OWN scratch database (prefix `dbg185_`), dropped in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createDb, runMigrations, sql, type Db } from "@regulait/db";
import { dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `dbg185_${process.pid}_${Date.now()}`;
const TAG_0185 = "0185_guard_search_path_and_truncate";
const PINNED = "search_path=pg_catalog, public, pg_temp";
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

/**
 * Functions allowed to run without a pinned search_path. Keep this EMPTY unless a function genuinely must resolve
 * names through its caller's path; every entry needs a comment saying why, and a name here is a review finding.
 */
const SEARCH_PATH_EXEMPT: ReadonlySet<string> = new Set<string>([]);

/** Append-only tables with no row-level refusal trigger that must still refuse TRUNCATE (migration 0185). */
const NAMED_TRUNCATE_GUARDED = ["audit_anchors", "audit_log"] as const;

let admin: Db;
let db: Db;
let tmp: string;

/** public plpgsql/sql functions (not from an extension) whose config lacks the pinned search_path */
async function unpinnedFunctions(): Promise<string[]> {
  const res = await db.execute<{ sig: string }>(sql`
    SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
     WHERE n.nspname = 'public'
       AND l.lanname IN ('plpgsql', 'sql')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
       AND NOT (${PINNED} = ANY (COALESCE(p.proconfig, '{}')))
     ORDER BY 1`);
  return res.rows.map((r) => r.sig).filter((sig) => !SEARCH_PATH_EXEMPT.has(sig.slice(0, sig.indexOf("("))));
}

/** tables in public with an enabled BEFORE ROW trigger on UPDATE or DELETE whose function can RAISE EXCEPTION */
async function rowGuardedTables(): Promise<string[]> {
  const res = await db.execute<{ t: string }>(sql`
    SELECT DISTINCT c.relname AS t
      FROM pg_trigger tg
      JOIN pg_class c ON c.oid = tg.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = tg.tgfoid
     WHERE n.nspname = 'public' AND NOT tg.tgisinternal
       AND (tg.tgtype & 1) = 1            -- ROW
       AND (tg.tgtype & 2) = 2            -- BEFORE
       AND (tg.tgtype & (8 | 16)) <> 0    -- DELETE or UPDATE
       AND p.prosrc ~* 'raise\\s+exception'
     ORDER BY 1`);
  return res.rows.map((r) => r.t);
}

/** tables in public with an enabled BEFORE TRUNCATE statement trigger running regulait_refuse_truncate() */
async function truncateGuardedTables(): Promise<string[]> {
  const res = await db.execute<{ t: string }>(sql`
    SELECT DISTINCT c.relname AS t
      FROM pg_trigger tg
      JOIN pg_class c ON c.oid = tg.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = tg.tgfoid
      JOIN pg_namespace pn ON pn.oid = p.pronamespace
     WHERE n.nspname = 'public' AND NOT tg.tgisinternal
       AND tg.tgenabled <> 'D'
       AND (tg.tgtype & 2) = 2 AND (tg.tgtype & 32) = 32   -- BEFORE TRUNCATE
       AND pn.nspname = 'public' AND p.proname = 'regulait_refuse_truncate'
     ORDER BY 1`);
  return res.rows.map((r) => r.t);
}

const expectedTruncateGuarded = async () =>
  [...new Set([...(await rowGuardedTables()), ...NAMED_TRUNCATE_GUARDED])].sort();

/** an open incident with one append-only event; returns the event id */
async function seedEvidence(): Promise<string> {
  const incident = (
    await db.execute<{ id: string }>(
      sql`INSERT INTO ai_incidents (title, severity, detection_source, aware_at) VALUES (${`dbg185 ${randomUUID()}`}, 'low', 'manual', now()) RETURNING id`,
    )
  ).rows[0]!.id;
  return (
    await db.execute<{ id: string }>(
      sql`INSERT INTO ai_incident_events (incident_id, kind, note) VALUES (${incident}, 'note', 'dbg185 evidence') RETURNING id`,
    )
  ).rows[0]!.id;
}

/**
 * The shadow attack, on ONE session (temp objects are per-session): a temp `ai_incidents` with no rows makes
 * `regulait_refuse_mutation` think the event's parent is gone. The guard only takes that branch inside a nested
 * trigger, so a temp table's trigger (a pg_temp function, which needs no privilege beyond TEMP) issues the DELETE.
 * Returns the error message, or null when the DELETE went through.
 */
async function shadowDelete(eventId: string): Promise<string | null> {
  const client = await db.$client.connect();
  try {
    await client.query(`CREATE TEMP TABLE ai_incidents (id uuid)`);
    await client.query(`CREATE TEMP TABLE dbg185_kick (x int)`);
    await client.query(
      `CREATE FUNCTION pg_temp.dbg185_kick_fn() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN DELETE FROM public.ai_incident_events WHERE id = '${eventId}'; RETURN NULL; END $$`,
    );
    await client.query(
      `CREATE TRIGGER dbg185_kick_trg AFTER INSERT ON dbg185_kick FOR EACH ROW EXECUTE FUNCTION pg_temp.dbg185_kick_fn()`,
    );
    try {
      await client.query(`INSERT INTO dbg185_kick VALUES (1)`);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  } finally {
    // destroy the session so its temp objects go with it
    client.release(true);
  }
}

const eventExists = async (id: string) =>
  (await db.execute(sql`SELECT 1 FROM ai_incident_events WHERE id = ${id}`)).rows.length === 1;

/** run a TRUNCATE in a transaction that is always rolled back; returns the error message or null on success */
async function tryTruncate(table: string): Promise<string | null> {
  const client = await db.$client.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(`TRUNCATE TABLE public."${table}" CASCADE`);
      return null;
    } catch (e) {
      return (e as Error).message;
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    client.release();
  }
}

/**
 * I1R-01: insert one execution profile (version 1 of a fresh name, digest computed from the body) in a transaction
 * that is always rolled back. Returns the error message, or null when the row was accepted.
 */
async function tryProfile(body: string, name = "dbg185-probe", minClass = "microvm"): Promise<string | null> {
  const client = await db.$client.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO execution_profiles (name, version, body, digest, min_class)
         VALUES ($1, 1, $2, encode(sha256(convert_to($2, 'UTF8')), 'hex'), $3)`,
        [name, body, minClass],
      );
      return null;
    } catch (e) {
      return (e as Error).message;
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    client.release();
  }
}

/** a shipped profile's body, renamed: the positive control for the NULL-safe body CHECK */
async function shippedBodyRenamed(name: string): Promise<string> {
  const res = await db.execute<{ body: string }>(
    sql`SELECT jsonb_set(body::jsonb, '{name}', to_jsonb(${name}::text))::text AS body FROM execution_profiles WHERE shipped ORDER BY name LIMIT 1`,
  );
  return res.rows[0]!.body;
}

const pre = {} as { shadowError: string | null; shadowRowKept: boolean; truncateError: string | null; unpinned: string[]; missingTruncate: string[]; emptyProfileError: string | null };

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(urlFor(SCRATCH_DB));

  // migrate to the migration before 0185 only (0185 and anything after it cut from a copy of the journal)
  tmp = mkdtempSync(path.join(tmpdir(), "dbg185-"));
  cpSync(migrationsFolder, tmp, { recursive: true });
  const journalPath = path.join(tmp, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ when: number; tag: string }> };
  const cut = journal.entries.find((e) => e.tag === TAG_0185)!.when;
  journal.entries = journal.entries.filter((e) => e.when < cut);
  writeFileSync(journalPath, JSON.stringify(journal));
  await runMigrations(db, tmp);

  // negative controls, before 0185
  const eventId = await seedEvidence();
  pre.shadowError = await shadowDelete(eventId);
  pre.shadowRowKept = await eventExists(eventId);
  pre.truncateError = await tryTruncate("ai_incident_events");
  pre.unpinned = await unpinnedFunctions();
  const guarded = new Set(await truncateGuardedTables());
  pre.missingTruncate = (await expectedTruncateGuarded()).filter((t) => !guarded.has(t));
  pre.emptyProfileError = await tryProfile("{}");

  // then the real folder, to the head
  await runMigrations(db, migrationsFolder);
}, 240_000);

afterAll(async () => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  await db?.$client.end();
  await dropScratchDatabase(admin, SCRATCH_DB);
  await admin?.$client.end();
});

describe("0185 negative controls: the attacks work on the database before 0185", () => {
  it("a temp-table shadow lets a DELETE past the append-only guard", () => {
    expect(pre.shadowError).toBeNull();
    expect(pre.shadowRowKept).toBe(false);
  });
  it("TRUNCATE of an append-only table succeeds", () => {
    expect(pre.truncateError).toBeNull();
  });
  it("I1R-01: an execution profile with a body of {} is accepted", () => {
    expect(pre.emptyProfileError).toBeNull();
  });
  it("the invariant checks fire on the unhardened schema (not vacuous)", () => {
    expect(pre.unpinned).toContain("regulait_refuse_mutation()");
    expect(pre.missingTruncate).toEqual(expect.arrayContaining(["ai_incident_events", "decision_receipts", "audit_log"]));
  });
});

describe("0185: the attacks are refused after migrating to the head", () => {
  it("the temp-table shadow no longer moves the guard: the DELETE is refused and the row stays", async () => {
    const eventId = await seedEvidence();
    const err = await shadowDelete(eventId);
    expect(err).toMatch(/ai_incident_events is append-only: DELETE refused/);
    expect(await eventExists(eventId)).toBe(true);
  });

  it("every TRUNCATE-guarded table actually refuses TRUNCATE", async () => {
    const tables = await truncateGuardedTables();
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) {
      expect(await tryTruncate(t), t).toMatch(/TRUNCATE refused \(append-only\)/);
    }
  });
});

describe("0185 I1R-01: the execution_profiles body CHECK is NULL-safe", () => {
  const BODY_CHECK = /execution_profiles_body_check/;
  it("refuses {}", async () => {
    expect(await tryProfile("{}")).toMatch(BODY_CHECK);
  });
  it("refuses a JSON-null schema", async () => {
    expect(await tryProfile(JSON.stringify({ schema: null, name: "dbg185-probe", minClass: "microvm" }))).toMatch(BODY_CHECK);
  });
  it("refuses a body with no name", async () => {
    expect(await tryProfile(JSON.stringify({ schema: "regulait.execution-profile.v1", minClass: "microvm" }))).toMatch(BODY_CHECK);
  });
  it("refuses a body with no minClass", async () => {
    expect(await tryProfile(JSON.stringify({ schema: "regulait.execution-profile.v1", name: "dbg185-probe" }))).toMatch(BODY_CHECK);
  });
  it("positive control: a shipped profile body (renamed) is accepted, and every seeded row still passes", async () => {
    const shipped = await db.execute<{ name: string; min_class: string }>(
      sql`SELECT name, min_class FROM execution_profiles WHERE shipped ORDER BY name LIMIT 1`,
    );
    const { min_class: minClass } = shipped.rows[0]!;
    expect(await tryProfile(await shippedBodyRenamed("dbg185-ok"), "dbg185-ok", minClass)).toBeNull();
    const bad = await db.execute(sql`SELECT 1 FROM execution_profiles WHERE NOT COALESCE(
      ("body"::jsonb ->> 'schema') = 'regulait.execution-profile.v1' AND ("body"::jsonb ->> 'name') = "name"
      AND ("body"::jsonb ->> 'minClass') = "min_class", false)`);
    expect(bad.rows).toEqual([]);
    expect((await db.execute(sql`SELECT 1 FROM execution_profiles WHERE shipped`)).rows.length).toBeGreaterThan(0);
  });
});

describe("0185 invariants (fail CI when a later migration forgets them)", () => {
  it("every public plpgsql/sql function pins search_path = pg_catalog, public, pg_temp", async () => {
    // CREATE OR REPLACE FUNCTION drops the setting: repeat `SET search_path = pg_catalog, public, pg_temp` in it
    expect(await unpinnedFunctions()).toEqual([]);
  });

  it("every table with a row-level UPDATE/DELETE refusal trigger (and audit_log, audit_anchors) refuses TRUNCATE", async () => {
    const expected = await expectedTruncateGuarded();
    expect(expected).toEqual(expect.arrayContaining(["ai_incident_events", "decision_receipts", "replay_claims", "audit_log"]));
    const guarded = new Set(await truncateGuardedTables());
    expect(expected.filter((t) => !guarded.has(t))).toEqual([]);
  });

  it("regulait_refuse_truncate itself pins search_path", async () => {
    const res = await db.execute<{ cfg: string[] | null }>(
      sql`SELECT proconfig AS cfg FROM pg_proc WHERE oid = 'public.regulait_refuse_truncate()'::regprocedure`,
    );
    expect(res.rows[0]!.cfg).toContain(PINNED);
  });
});
