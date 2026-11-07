// ADR-0252: migrations are numbered when they merge, not when they are written.
//
// A pull request adds `migrations/pending/<slug>.sql` and never edits `meta/_journal.json`. After the merge, one
// deterministic step (`scripts/assign-at-merge.mjs`, run by `.github/workflows/assign-at-merge.yml`) gives every
// pending file the next number, idx and `when`, renames it to `NNNN_<slug>.sql` and appends its journal entry. Two
// pull requests that each add a migration therefore touch no common line and merge in either order.
//
// Until that step has run, the numbers are not fixed. `runMigrations` refuses a folder with pending files unless the
// caller says the database is disposable (`REGULAIT_MIGRATIONS_UNASSIGNED=apply`, set by CI and the test suites): a
// long-lived database that applied a provisional number could later skip the migration that really gets it (the
// watermark rule, CONTRIBUTING_PARALLEL_SESSIONS §4.1).
//
// This file only uses erasable TypeScript, so the Node scripts import it directly (type stripping).
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** the folder, inside a migrations folder, that holds migrations not yet numbered */
export const PENDING_DIR = "pending";
/** the gap between consecutive `when` values (the repo's hand-authored convention, §4.1) */
export const WHEN_STEP = 1_000_000;
/** a pending file's name without `.sql`: lowercase words joined by `_`, as in the existing tags */
export const SLUG_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
/** a numbered migration file: four or more digits, `_`, a slug */
export const NUMBERED_RE = /^(\d{4,})_([a-z0-9_]+)\.sql$/;
/** the environment variable that lets a disposable database apply pending migrations in their provisional order */
export const UNASSIGNED_ENV = "REGULAIT_MIGRATIONS_UNASSIGNED";

export type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
export type Journal = { version: string; dialect: string; entries: JournalEntry[] };
export type Assignment = { from: string; to: string; entry: JournalEntry };

export function readJournal(migrationsFolder: string): Journal {
  return JSON.parse(readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8")) as Journal;
}

/** the journal as the repo writes it: two-space JSON and a final newline */
export function formatJournal(journal: Journal): string {
  return `${JSON.stringify(journal, null, 2)}\n`;
}

/** the pending `.sql` file names, in assignment order (byte order of the name); [] when there is no pending folder */
export function pendingFiles(migrationsFolder: string): string[] {
  const dir = path.join(migrationsFolder, PENDING_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
}

/** the number a tag starts with (`0282_x` → 282) */
export function tagNumber(tag: string): number {
  const m = /^(\d{4,})_/.exec(tag);
  if (!m) throw new Error(`journal tag ${tag} does not start with a migration number`);
  return Number(m[1]);
}

/**
 * Give each pending file (already in assignment order) the next number, idx and `when` after the journal's last
 * entry. Pure: returns the new journal and the renames, and changes nothing on disk. The number is one above the
 * highest number or idx in the journal, so retired numbers are never reused; idx equals the number, as it does for
 * every entry since 0272; `when` rises by `WHEN_STEP` from the journal's last `when`.
 */
export function assignPending(journal: Journal, pending: readonly string[]): { journal: Journal; assignments: Assignment[] } {
  const bad = pending.filter((f) => !f.endsWith(".sql") || !SLUG_RE.test(f.slice(0, -4)));
  if (bad.length) throw new Error(`pending migration names must be <slug>.sql with a lowercase slug of words joined by "_": ${bad.join(", ")}`);
  if (new Set(pending).size !== pending.length) throw new Error("a pending migration is listed twice");
  const entries = journal.entries.slice();
  const last = entries[entries.length - 1];
  let number = Math.max(0, ...entries.map((e) => Math.max(tagNumber(e.tag), e.idx)));
  let when = last ? last.when : 0;
  const version = last?.version ?? journal.version;
  const assignments: Assignment[] = [];
  for (const file of pending) {
    number += 1;
    when += WHEN_STEP;
    const tag = `${String(number).padStart(4, "0")}_${file.slice(0, -4)}`;
    const entry: JournalEntry = { idx: number, version, when, tag, breakpoints: true };
    entries.push(entry);
    assignments.push({ from: `${PENDING_DIR}/${file}`, to: `${tag}.sql`, entry });
  }
  return { journal: { ...journal, entries }, assignments };
}

/** thrown by `runMigrations` when the folder holds pending migrations and the database is not declared disposable */
export class UnassignedMigrationsError extends Error {
  readonly code = "unassigned_migrations";
  readonly files: string[];
  constructor(files: string[]) {
    super(
      `the migrations folder holds ${files.length} migration(s) not yet numbered (${files.join(", ")}). ` +
        "They get their numbers after they merge (ADR-0252), and a long-lived database must not apply a provisional number. " +
        "Wait for the assign-at-merge pull request to land on main, or, for a disposable database only, set " +
        `${UNASSIGNED_ENV}=apply.`,
    );
    this.name = "UnassignedMigrationsError";
    this.files = files;
  }
}

/**
 * The folder `migrate` should read. With no pending files, the folder itself. With pending files and
 * `REGULAIT_MIGRATIONS_UNASSIGNED=apply`, a temporary copy in which they are numbered as `assignPending` would number
 * them now; `cleanup` removes it. Anything else throws `UnassignedMigrationsError`.
 */
export function resolveMigrationsFolder(
  migrationsFolder: string,
  env: Record<string, string | undefined> = process.env,
): { folder: string; provisional: Assignment[]; cleanup: () => void } {
  const pending = pendingFiles(migrationsFolder);
  if (pending.length === 0) return { folder: migrationsFolder, provisional: [], cleanup: () => {} };
  if (env[UNASSIGNED_ENV] !== "apply") throw new UnassignedMigrationsError(pending);
  const { journal, assignments } = assignPending(readJournal(migrationsFolder), pending);
  const tmp = mkdtempSync(path.join(tmpdir(), "regulait-migrations-"));
  mkdirSync(path.join(tmp, "meta"));
  writeFileSync(path.join(tmp, "meta", "_journal.json"), formatJournal(journal));
  for (const e of journal.entries.slice(0, journal.entries.length - assignments.length)) {
    copyFileSync(path.join(migrationsFolder, `${e.tag}.sql`), path.join(tmp, `${e.tag}.sql`));
  }
  for (const a of assignments) copyFileSync(path.join(migrationsFolder, a.from), path.join(tmp, a.to));
  return {
    folder: tmp,
    provisional: assignments,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}
