// ADR-0252: a migration is written as `pending/<slug>.sql` and renamed to `NNNN_<slug>.sql` (with a journal entry)
// by assign-at-merge after it lands. A test that addresses one migration must find it in either state, or it breaks
// the moment numbering lands. These helpers locate a migration by its slug and remove it from a scratch copy.
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PENDING_DIR } from "@regulait/db";

type Journal = { entries: Array<{ tag: string }> } & Record<string, unknown>;

export type LocatedMigration =
  | { state: "pending"; slug: string; file: string }
  | { state: "numbered"; slug: string; file: string; tag: string };

const journalPath = (folder: string) => path.join(folder, "meta", "_journal.json");
const readJournal = (folder: string) => JSON.parse(readFileSync(journalPath(folder), "utf8")) as Journal;

/** where the migration named `slug` lives in `folder`: its pending file, or its numbered file listed in the journal */
export function locateMigration(folder: string, slug: string): LocatedMigration {
  const pending = path.join(folder, PENDING_DIR, `${slug}.sql`);
  const numbered = readdirSync(folder).filter((f) => new RegExp(`^\\d{4,}_${slug}\\.sql$`).test(f));
  if (existsSync(pending) && numbered.length) throw new Error(`migration ${slug} is both pending and numbered (${numbered.join(", ")})`);
  if (existsSync(pending)) return { state: "pending", slug, file: pending };
  if (numbered.length !== 1) throw new Error(`migration ${slug}: expected pending/${slug}.sql or one NNNN_${slug}.sql, found ${numbered.length} numbered`);
  const tag = numbered[0]!.slice(0, -4);
  if (!readJournal(folder).entries.some((e) => e.tag === tag)) throw new Error(`migration ${tag}.sql has no journal entry`);
  return { state: "numbered", slug, file: path.join(folder, numbered[0]!), tag };
}

/** the SQL text of the migration named `slug` */
export function readMigration(folder: string, slug: string): string {
  return readFileSync(locateMigration(folder, slug).file, "utf8");
}

/**
 * Remove the migration named `slug` from `folder` (a scratch copy; never the repo's folder): the pending file, or the
 * numbered file and its journal entry. The journal keeps the repo's format (two-space JSON, final newline).
 */
export function removeMigration(folder: string, slug: string): LocatedMigration {
  const found = locateMigration(folder, slug);
  rmSync(found.file);
  if (found.state === "numbered") {
    const journal = readJournal(folder);
    journal.entries = journal.entries.filter((e) => e.tag !== found.tag);
    writeFileSync(journalPath(folder), `${JSON.stringify(journal, null, 2)}\n`);
  }
  return found;
}
