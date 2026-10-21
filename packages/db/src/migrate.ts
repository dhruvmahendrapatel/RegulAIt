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

/** "valid", "invalid" (a CONCURRENTLY build that failed part way leaves one) or "missing" */
async function indexState(db: Db, name: string): Promise<"valid" | "invalid" | "missing"> {
  const res = await db.execute(sql`
    select i.indisvalid as "valid" from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_namespace n on n.oid = c.relnamespace
     where c.relname = ${name} and n.nspname = current_schema()`);
  const row = (res as unknown as { rows: Array<{ valid: boolean }> }).rows[0];
  return row === undefined ? "missing" : row.valid ? "valid" : "invalid";
}

/**
 * Build each `CONCURRENT_INDEXES` entry whose migration is journalled and that is not already a VALID index. A valid
 * index costs one catalogue read and no DDL. An INVALID one (a build that was interrupted) is dropped concurrently and
 * built again, since `IF NOT EXISTS` alone would accept it. A folder whose journal stops before the entry's migration
 * builds nothing. Never falls back to a plain CREATE INDEX: an error propagates and fails the run.
 */
export async function buildConcurrentIndexes(db: Db, migrationsFolder: string): Promise<string[]> {
  const applied = journalTags(migrationsFolder);
  const built: string[] = [];
  for (const ix of CONCURRENT_INDEXES) {
    if (!applied.has(ix.migration)) continue;
    const state = await indexState(db, ix.name);
    if (state === "valid") continue;
    if (state === "invalid") await db.execute(sql.raw(`DROP INDEX CONCURRENTLY IF EXISTS "${ix.name}"`));
    try {
      await db.execute(sql.raw(ix.create));
    } catch (err) {
      // a second process booting at the same moment may win the build; its valid index is the outcome wanted
      if ((await indexState(db, ix.name)) !== "valid") throw err;
    }
    // IF NOT EXISTS also skips an index another session is still building, so "returned" must mean "usable"
    if ((await indexState(db, ix.name)) !== "valid") {
      throw new Error(`index ${ix.name} is not valid after CREATE INDEX CONCURRENTLY (another session may still be building it); run the migrations again`);
    }
    built.push(ix.name);
  }
  return built;
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
