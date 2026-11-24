// ADR-0234 slice 1: the static guard that a migration after 0272 touching a slice-1 table enters the migration
// context. Pure file scanning (no database), so it is unit-tested on its own and the DB-backed suite only calls it.
//
// ADR-0252: a migration lands as `pending/<slug>.sql` and is numbered by assign-at-merge only after it merges, so a
// scan of numbered files alone let #1234 and #1237 through. A pending file is always "after 0272" and is named
// `pending/<name>` in the result.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PENDING_DIR } from "@regulait/db";

const MIGRATION_CONTEXT = /set_config\(\s*'regulait\.system_context'\s*,\s*'migration'\s*,\s*true\s*\)/i;

/** every migration after 0272: numbered `NNNN_*.sql` above 0272, then every `pending/*.sql` (named `pending/<name>`) */
export function migrationsAfter0272(folder: string): Array<{ name: string; body: string }> {
  const numbered = readdirSync(folder)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) > 272)
    .map((f) => ({ name: f, file: path.join(folder, f) }));
  const pendingDir = path.join(folder, PENDING_DIR);
  let pendingFiles: string[] = [];
  try {
    pendingFiles = readdirSync(pendingDir).filter((f) => f.endsWith(".sql"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const pending = pendingFiles.sort().map((f) => ({ name: `${PENDING_DIR}/${f}`, file: path.join(pendingDir, f) }));
  return [...numbered, ...pending].map(({ name, file }) => ({ name, body: readFileSync(file, "utf8") }));
}

/** migrations after 0272 with DML on a slice-1 table that do not set regulait.system_context = 'migration' */
export function dmlOffenders(folder: string, tables: readonly string[]): string[] {
  const dml = new RegExp(`\\b(insert\\s+into|update|delete\\s+from)\\s+(public\\.)?"?(${tables.join("|")})"?\\b`, "i");
  return migrationsAfter0272(folder)
    .filter(({ body }) => dml.test(body) && !MIGRATION_CONTEXT.test(body))
    .map(({ name }) => name);
}

/** migrations after 0272 whose data step reads a slice-1 table and that do not set the migration context */
export function readOffenders(folder: string, tables: readonly string[]): string[] {
  const dataStep = /\b(insert\s+into|update\s+(public\.)?"?\w+"?\s+set|delete\s+from)\b/i;
  const reads = new RegExp(`\\b(from|join)\\s+(public\\.)?"?(${tables.join("|")})"?\\b`, "i");
  return migrationsAfter0272(folder)
    .filter(({ body }) => dataStep.test(body) && reads.test(body) && !MIGRATION_CONTEXT.test(body))
    .map(({ name }) => name);
}
