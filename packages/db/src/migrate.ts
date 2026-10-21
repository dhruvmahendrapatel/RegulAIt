import { readFileSync } from "node:fs";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getTableColumns, sql } from "drizzle-orm";
import type { Db } from "./index.js";
import { auditLog } from "./schema.js";

/** the identity a migration's audit rows are attributed to: the system itself */
export const MIGRATION_AUDIT_ACTOR = "00000000-0000-0000-0000-000000000000";

export async function runMigrations(db: Db, migrationsFolder: string) {
  await migrate(db, { migrationsFolder });
  await buildConcurrentIndexes(db, migrationsFolder);
  await drainMigrationAuditOutbox(db);
}

/**
 * Indexes built with CREATE INDEX CONCURRENTLY, so a build never blocks writes to the table (migration 0210, owner
 * decision of 2026-10-21 on #453). The drizzle migrator runs every pending file in ONE transaction and CONCURRENTLY
 * cannot run inside a transaction, so the statement cannot live in a migration file. Each entry's migration file is
 * the journalled marker; once that file is in the folder's journal (and so applied by `migrate`), `runMigrations`
 * builds the index here, outside any transaction, on a pool connection in autocommit.
 *
 * Add to this list only an index; anything else belongs in a migration file.
 */
export const CONCURRENT_INDEXES: ReadonlyArray<{ migration: string; name: string; create: string }> = [
  {
    // `GET /v1/audit?objectType=&objectId=` (and the CSV export) and the use-case overview's trail and count
    migration: "0210_audit_log_object_at_idx",
    name: "audit_log_object_at_idx",
    create: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_log_object_at_idx" ON "audit_log" ("object_type", "object_id", "at" DESC)`,
  },
];

/** the tags of the folder's journal: the migrations `migrate` has applied from this folder */
function journalTags(migrationsFolder: string): Set<string> {
  const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  return new Set(journal.entries.map((e) => e.tag));
}

/**
 * #476 M1: one builder at a time. A session-level advisory lock on (namespace, hashtext(key)), held on ONE pinned
 * connection for the state check, any DROP and the CREATE. Without it, a replica booting during another's build read
 * the in-progress index as INVALID (CONCURRENTLY registers it with `indisvalid = false` first) and dropped it.
 */
export const CONCURRENT_INDEX_LOCK_NAMESPACE = 210_001;
export const CONCURRENT_INDEX_LOCK_KEY = "regulait:concurrent-indexes";
/** how often a waiting process retries the build lock */
export const CONCURRENT_INDEX_LOCK_POLL_MS = 500;
/**
 * #476 L1: the longest the build session waits for any one lock. CONCURRENTLY waits for every transaction in the
 * database that holds an older snapshot (its virtualxid waits are lock waits, so `lock_timeout` bounds them); without a
 * bound, one long or idle-in-transaction session kept a booting gateway out of `listen` indefinitely.
 */
export const CONCURRENT_INDEX_LOCK_TIMEOUT_MS = 60_000;

/** the build waited past `lock_timeout` for other sessions; `blockers` names the oldest open transactions it could see */
export class ConcurrentIndexBlockedError extends Error {
  readonly code = "concurrent_index_blocked";
  constructor(
    readonly index: string,
    readonly lockTimeoutMs: number,
    readonly blockers: ReadonlyArray<{ pid: number; state: string | null; applicationName: string | null; xactStart: string | null }>,
  ) {
    const named = blockers.length
      ? blockers.map((b) => `pid ${b.pid} (${b.state ?? "state hidden"}, transaction open since ${b.xactStart ?? "unknown"}, application "${b.applicationName ?? ""}")`).join("; ")
      : "none visible to this role (pg_read_all_stats shows other roles' sessions)";
    super(
      `index ${index}: CREATE INDEX CONCURRENTLY waited longer than lock_timeout (${lockTimeoutMs} ms) for other transactions to finish. ` +
        `Oldest open transactions in this database: ${named}. End them (or wait for them) and start again; the INVALID index this leaves is rebuilt on the next run.`,
    );
    this.name = "ConcurrentIndexBlockedError";
  }
}

type PinnedClient = { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>; release: (err?: Error) => void };

/** "valid", "invalid" (a CONCURRENTLY build that failed part way leaves one) or "missing" */
async function indexState(c: PinnedClient, name: string): Promise<"valid" | "invalid" | "missing"> {
  const res = await c.query(
    `select i.indisvalid as "valid" from pg_index i
       join pg_class c on c.oid = i.indexrelid
       join pg_namespace n on n.oid = c.relnamespace
      where c.relname = $1 and n.nspname = current_schema()`,
    [name],
  );
  const row = res.rows[0] as { valid: boolean } | undefined;
  return row === undefined ? "missing" : row.valid ? "valid" : "invalid";
}

/** the oldest open transactions in this database other than ours, for the lock_timeout message (no query text) */
async function oldestTransactions(c: PinnedClient): Promise<ConcurrentIndexBlockedError["blockers"]> {
  const res = await c.query(`
    select pid, state, application_name as "applicationName", xact_start::text as "xactStart" from pg_stat_activity
     where datname = current_database() and pid <> pg_backend_pid() and xact_start is not null
     order by xact_start limit 5`);
  return res.rows as unknown as ConcurrentIndexBlockedError["blockers"];
}

/**
 * Build each `CONCURRENT_INDEXES` entry whose migration is journalled and that is not already a VALID index. A valid
 * index costs one catalogue read and no DDL. An INVALID one (a build that was interrupted) is dropped concurrently and
 * built again, since `IF NOT EXISTS` alone would accept it. A folder whose journal stops before the entry's migration
 * builds nothing. Never falls back to a plain CREATE INDEX: an error propagates and fails the run.
 *
 * Everything runs on one pinned connection in autocommit, under the build lock (#476 M1), so a second process waits
 * for the first, then reads VALID and skips. The lock is taken by polling `pg_try_advisory_lock`, never by a blocking
 * `pg_advisory_lock`: a waiter parked inside one statement holds a snapshot, and the holder's CONCURRENTLY build would
 * then wait for the waiter while the waiter waits for the holder. The session runs with `statement_timeout = 0` (a
 * build on a large trail may take long) and a bounded `lock_timeout` (#476 L1), and both are reset before release.
 */
export async function buildConcurrentIndexes(
  db: Db,
  migrationsFolder: string,
  opts: { lockTimeoutMs?: number; pollMs?: number } = {},
): Promise<string[]> {
  const applied = journalTags(migrationsFolder);
  const due = CONCURRENT_INDEXES.filter((ix) => applied.has(ix.migration));
  if (due.length === 0) return [];
  const lockTimeoutMs = Math.trunc(opts.lockTimeoutMs ?? CONCURRENT_INDEX_LOCK_TIMEOUT_MS);
  if (!(lockTimeoutMs > 0)) throw new Error("buildConcurrentIndexes: lockTimeoutMs must be a positive number of milliseconds");
  const pollMs = opts.pollMs ?? CONCURRENT_INDEX_LOCK_POLL_MS;
  const c = await (db.$client as unknown as { connect: () => Promise<PinnedClient> }).connect();
  const lockArgs = [CONCURRENT_INDEX_LOCK_NAMESPACE, CONCURRENT_INDEX_LOCK_KEY];
  let locked = false;
  let broken: Error | undefined;
  try {
    for (let said = false; ; ) {
      const res = await c.query(`select pg_try_advisory_lock($1::int, hashtext($2)) as "ok"`, lockArgs);
      if ((res.rows[0] as { ok: boolean }).ok) break;
      if (!said) console.log("[regulait] migrations: another process is building the concurrent indexes; waiting for it");
      said = true;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    locked = true;
    await c.query("set statement_timeout = 0");
    await c.query(`set lock_timeout = ${lockTimeoutMs}`);
    const built: string[] = [];
    for (const ix of due) {
      const state = await indexState(c, ix.name);
      if (state === "valid") continue;
      try {
        if (state === "invalid") await c.query(`DROP INDEX CONCURRENTLY IF EXISTS "${ix.name}"`);
        await c.query(ix.create);
      } catch (err) {
        if ((err as { code?: string }).code === "55P03") throw new ConcurrentIndexBlockedError(ix.name, lockTimeoutMs, await oldestTransactions(c));
        throw err;
      }
      // IF NOT EXISTS also accepts an index some other session is still building, so "returned" must mean "usable"
      if ((await indexState(c, ix.name)) !== "valid") {
        throw new Error(`index ${ix.name} is not valid after CREATE INDEX CONCURRENTLY (a session outside the build lock may still be building it); run the migrations again`);
      }
      built.push(ix.name);
    }
    return built;
  } finally {
    try {
      if (locked) await c.query(`select pg_advisory_unlock($1::int, hashtext($2))`, lockArgs);
      await c.query("reset lock_timeout");
      await c.query("reset statement_timeout");
    } catch (e) {
      broken = e instanceof Error ? e : new Error(String(e));
    }
    // a broken connection is destroyed (which releases the session lock in the server), never returned to the pool
    c.release(broken);
  }
}

type OutboxRow = {
  id: string;
  migration: string;
  object_type: string;
  object_id: string | null;
  rule_id: string;
  reason: string;
  detail: Record<string, unknown> | null;
  created_at: Date | string;
};

/**
 * Does the database carry everything this build's chained audit writer needs:
 * every `audit_log` column the schema declares, and the ADR-0188
 * `audit_chain_versions` boundary table?
 */
export async function auditWriterSchemaCurrent(db: Db): Promise<boolean> {
  const res = await db.execute(sql`
    select to_regclass('audit_chain_versions') is not null as "versions",
           coalesce((select array_agg(column_name::text) from information_schema.columns
                     where table_schema = current_schema() and table_name = 'audit_log'), '{}') as "cols"`);
  const row = (res as unknown as { rows: Array<{ versions: boolean; cols: string[] }> }).rows[0];
  if (!row?.versions) return false;
  const have = new Set(row.cols);
  return Object.values(getTableColumns(auditLog)).every((c) => have.has(c.name));
}

/**
 * ADR-0181 (FX2): move the audit rows a migration wrote into
 * `migration_audit_outbox` into `audit_log`, through the CHAINED insert path
 * (`db` comes from `createDb`, which chains every `insert(auditLog)`). The
 * claim (DELETE … RETURNING) and the inserts are one transaction, so a row is
 * either moved exactly once or not at all, and two processes booting together
 * cannot both move it. Returns how many rows were moved.
 */
export async function drainMigrationAuditOutbox(db: Db): Promise<number> {
  // a migrations folder that stops before 0160 has no outbox to drain
  const present = await db.execute(sql`select to_regclass('migration_audit_outbox') is not null as "present"`);
  if (!(present as unknown as { rows: Array<{ present: boolean }> }).rows[0]?.present) return 0;
  // the common case — nothing to move — opens no transaction at all
  const pending = await db.execute(sql`select 1 from "migration_audit_outbox" limit 1`);
  if ((pending as unknown as { rows: unknown[] }).rows.length === 0) return 0;
  // A database migrated only part of the way (a test replaying an older
  // journal, an operator running a partial folder) has an `audit_log` older
  // than this build's chained writer, which names every column this build
  // knows and reads the ADR-0188 version boundary. The rows WAIT in the outbox
  // (durable, not lost) and move on the next run that brings the schema level
  // with this build; appending them to an older-shaped chain is never right.
  if (!(await auditWriterSchemaCurrent(db))) return 0;
  return db.transaction(async (tx) => {
    const res = await tx.execute(sql`delete from "migration_audit_outbox" returning *`);
    const rows = ((res as unknown as { rows: OutboxRow[] }).rows ?? []).slice();
    if (rows.length === 0) return 0;
    rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
    for (const r of rows) {
      await tx.insert(auditLog).values({
        userId: MIGRATION_AUDIT_ACTOR,
        objectType: r.object_type as typeof auditLog.$inferInsert.objectType,
        objectId: r.object_id,
        detail: { ...(r.detail ?? {}), migration: r.migration },
        effect: "allow",
        ruleId: r.rule_id,
        ruleChain: [r.rule_id],
        reason: r.reason,
      });
    }
    return rows.length;
  });
}
