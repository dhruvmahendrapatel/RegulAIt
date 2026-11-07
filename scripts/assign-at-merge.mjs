#!/usr/bin/env node
// ADR-0252: the one step that writes the shared append-only files, run on main after a merge
// (.github/workflows/assign-at-merge.yml opens its result as a bot pull request through the merge queue).
//
// 1. Migrations: each packages/db/migrations/pending/<slug>.sql gets the next number, idx and `when`, is renamed to
//    NNNN_<slug>.sql and gets its journal entry (packages/db/src/pending-migrations.ts, the same rule runMigrations
//    uses for a disposable database).
// 2. The ADR index gets a row for every ADR file without one (scripts/fold-docs.mjs).
// 3. Fragments under internal/fragments/ are folded into STATE.md and PENDING.md and deleted.
//
// Deterministic: the same tree always gives the same result, so a re-run, or a human running it by hand, writes
// exactly what the bot would.
//
// usage: node scripts/assign-at-merge.mjs [--write] [--root <dir>]
//   without --write it prints the plan and changes nothing
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assignPending, formatJournal, pendingFiles, readJournal } from "../packages/db/src/pending-migrations.ts";
import { foldAdrIndex, foldFragments } from "./fold-docs.mjs";

export const MIGRATIONS = "packages/db/migrations";
export const ADR_DIR = "internal/decisions";
export const FRAGMENT_DIR = "internal/fragments";
export const FOLD_TARGETS = ["internal/memory/STATE.md", "internal/product/PENDING.md"];

/** the whole plan for a tree: { migrations, adrRows, fragments, writes } where writes is what --write does */
export function plan(root) {
  const writes = { files: new Map(), renames: [], deletes: [] };

  const folder = path.join(root, MIGRATIONS);
  const pending = pendingFiles(folder);
  const { journal, assignments } = assignPending(readJournal(folder), pending);
  if (assignments.length) {
    writes.files.set(path.join(MIGRATIONS, "meta/_journal.json"), formatJournal(journal));
    for (const a of assignments) {
      const to = path.join(MIGRATIONS, a.to);
      if (existsSync(path.join(root, to))) throw new Error(`${to} already exists; the journal and the folder disagree`);
      writes.renames.push([path.join(MIGRATIONS, a.from), to]);
    }
  }

  const adrDir = path.join(root, ADR_DIR);
  const readmePath = path.join(ADR_DIR, "README.md");
  let adr = { added: [] };
  if (existsSync(path.join(root, readmePath))) {
    const readme = readFileSync(path.join(root, readmePath), "utf8");
    const adrFiles = readdirSync(adrDir).filter((f) => /^\d{4}-.*\.md$/.test(f)).map((name) => ({ name, text: readFileSync(path.join(adrDir, name), "utf8") }));
    adr = foldAdrIndex(readme, adrFiles);
    if (adr.added.length) writes.files.set(readmePath, adr.text);
  }

  const fragDir = path.join(root, FRAGMENT_DIR);
  const fragments = existsSync(fragDir)
    ? readdirSync(fragDir).filter((f) => f.endsWith(".md") && f !== "README.md").map((name) => ({ name, text: readFileSync(path.join(fragDir, name), "utf8") }))
    : [];
  let folded = [];
  if (fragments.length) {
    const targets = new Map(FOLD_TARGETS.filter((t) => existsSync(path.join(root, t))).map((t) => [t, readFileSync(path.join(root, t), "utf8")]));
    const res = foldFragments(targets, fragments);
    for (const [t, text] of res.targets) if (text !== targets.get(t)) writes.files.set(t, text);
    folded = res.folded;
    for (const f of folded) writes.deletes.push(path.join(FRAGMENT_DIR, f));
  }

  return { migrations: assignments.map((a) => `${a.from} -> ${a.to} (idx ${a.entry.idx}, when ${a.entry.when})`), adrRows: adr.added, fragments: folded, writes };
}

/** apply a plan's writes under root */
export function apply(root, { writes }) {
  for (const [from, to] of writes.renames) renameSync(path.join(root, from), path.join(root, to));
  for (const [file, text] of writes.files) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  for (const f of writes.deletes) unlinkSync(path.join(root, f));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const rootAt = args.indexOf("--root");
  const root = path.resolve(rootAt >= 0 ? args[rootAt + 1] : process.cwd());
  const p = plan(root);
  const say = (head, items) => console.log(items.length ? `${head}:\n${items.map((i) => `  ${i}`).join("\n")}` : `${head}: none`);
  say("migrations to number", p.migrations);
  say("ADR index rows to add", p.adrRows);
  say("fragments to fold", p.fragments);
  if (args.includes("--write")) {
    apply(root, p);
    console.log("written");
  }
}
