#!/usr/bin/env node
// Migration guard (internal/process/CONTRIBUTING_PARALLEL_SESSIONS.md §4.1, ADR-0252, review C-03).
//
// The migrator applies a journal entry only when its `when` is greater than the newest
// migration already applied, read once before the loop. So an entry this PR adds whose
// `when` is not above every `when` already on the base branch is skipped, silently and for
// good, on any database that has run the base branch. A fresh CI database hides it.
//
// ADR-0252 moves numbering to merge time: a PR adds packages/db/migrations/pending/<slug>.sql and leaves the journal
// alone. This guard compares the PR's migrations folder with the base branch's and refuses:
// - a merged journal entry that changed (tag, idx, when, version, breakpoints) or disappeared;
// - a merged migration's `.sql` whose bytes changed;
// - a numbered `.sql` with no journal entry, or a journal entry with no `.sql`;
// - new journal entries other than exactly what scripts/assign-at-merge.mjs writes for the pending files this diff
//   numbers (so only that step appends to the journal, and a renamed file keeps its bytes);
// - a pending file whose name is not <slug>.sql;
// - and, as before, a new `when` not above the base branch's newest, or a journal whose `when` does not strictly rise.
//
// usage: node scripts/migration-watermark-guard.mjs <base-ref> [--root <dir>]   (e.g. origin/main, or a sha)
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NUMBERED_RE, PENDING_DIR, SLUG_RE, assignPending } from "../packages/db/src/pending-migrations.ts";

const FOLDER = "packages/db/migrations";
const JOURNAL = `${FOLDER}/meta/_journal.json`;

/** the problems with `head`'s journal against `base`'s, as lines; empty when the PR is safe */
export function watermarkProblems(base, head) {
  const out = [];
  const baseTags = new Set(base.entries.map((e) => e.tag));
  const baseMax = Math.max(...base.entries.map((e) => e.when));
  for (const e of head.entries) {
    if (baseTags.has(e.tag)) continue;
    if (!(e.when > baseMax)) {
      out.push(`${e.tag}: when ${e.when} is not above the base branch's newest when ${baseMax}; it would never apply on a database that has run the base branch. Add new migrations under ${FOLDER}/${PENDING_DIR}/ and let the assign-at-merge step number them (ADR-0252, CONTRIBUTING_PARALLEL_SESSIONS §4.1).`);
    }
  }
  const whens = head.entries.map((e) => e.when);
  for (let i = 1; i < whens.length; i++) {
    if (!(whens[i] > whens[i - 1])) out.push(`${head.entries[i].tag}: when ${whens[i]} is not above the entry before it (${whens[i - 1]}); journal order must be strictly increasing.`);
  }
  return out;
}

const FIELDS = ["idx", "version", "when", "tag", "breakpoints"];
const same = (a, b) => FIELDS.every((f) => a[f] === b[f]);

/**
 * The problems with the head migrations folder against the base one. Each side is
 * { journal, files: Map<path relative to the folder, content hash> }, with pending files as `pending/<name>`.
 */
export function migrationTreeProblems(base, head) {
  const out = [];
  const be = base.journal.entries;
  const he = head.journal.entries;

  // merged entries are frozen, in place
  be.forEach((b, i) => {
    const h = he[i];
    if (!h) out.push(`${b.tag}: a merged journal entry was removed; merged migrations are never removed or reordered.`);
    else if (!same(b, h)) out.push(`${b.tag}: a merged journal entry changed (${FIELDS.filter((f) => b[f] !== h[f]).map((f) => `${f} ${JSON.stringify(b[f])} -> ${JSON.stringify(h[f])}`).join(", ")}); merged entries are never edited.`);
  });
  // and so are their bytes
  for (const b of be) {
    const f = `${b.tag}.sql`;
    if (base.files.has(f) && head.files.has(f) && base.files.get(f) !== head.files.get(f)) {
      out.push(`${f}: a merged migration's SQL changed. A database that applied it never re-runs it (§4.1); put the change in a new migration under ${PENDING_DIR}/.`);
    }
  }

  // the numbered files and the journal are one-to-one
  const numbered = [...head.files.keys()].filter((f) => !f.includes("/") && f.endsWith(".sql"));
  const tags = new Set(he.map((e) => e.tag));
  for (const f of numbered) {
    if (!NUMBERED_RE.test(f)) out.push(`${f}: a migration in the folder's top level must be NNNN_<slug>.sql; new migrations go under ${PENDING_DIR}/<slug>.sql.`);
    else if (!tags.has(f.slice(0, -4))) out.push(`${f}: a numbered migration with no journal entry never applies. New migrations go under ${PENDING_DIR}/<slug>.sql (ADR-0252).`);
  }
  for (const e of he) if (!head.files.has(`${e.tag}.sql`)) out.push(`${e.tag}: a journal entry with no ${e.tag}.sql file.`);

  // pending names
  const pendingOf = (files) => [...files.keys()].filter((f) => f.startsWith(`${PENDING_DIR}/`) && f.endsWith(".sql")).map((f) => f.slice(PENDING_DIR.length + 1));
  const headPending = pendingOf(head.files);
  for (const p of headPending) {
    if (p.includes("/") || !SLUG_RE.test(p.slice(0, -4))) out.push(`${PENDING_DIR}/${p}: a pending migration is named <slug>.sql, lowercase words joined by "_".`);
  }

  // new entries are exactly the assignment of the pending files this diff numbers
  const added = he.slice(be.length);
  if (added.length) {
    const removed = pendingOf(base.files).filter((p) => !headPending.includes(p)).sort();
    let expected;
    try {
      expected = assignPending(base.journal, removed);
    } catch (e) {
      out.push(String(e.message ?? e));
    }
    const matches = expected && expected.journal.entries.length === he.length && expected.journal.entries.every((e, i) => same(e, he[i]));
    if (!matches) {
      out.push(
        `the journal gained ${added.map((e) => e.tag).join(", ")}, which is not what the assign-at-merge step writes for the pending files this diff numbers (${removed.join(", ") || "none"}). ` +
          `A pull request adds its migration as ${FOLDER}/${PENDING_DIR}/<slug>.sql and leaves meta/_journal.json alone; only scripts/assign-at-merge.mjs appends to the journal (ADR-0252).`,
      );
    } else {
      for (const a of expected.assignments) {
        if (base.files.get(a.from) !== head.files.get(a.to)) out.push(`${a.to}: its bytes differ from ${a.from} as merged; numbering renames a migration and never edits it.`);
      }
    }
  }

  return [...out, ...watermarkProblems(base.journal, head.journal)];
}

/** the migrations folder at a git ref: journal and blob hash per file */
export function treeAtRef(ref, root = process.cwd()) {
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const journal = JSON.parse(git("show", `${ref}:${JOURNAL}`));
  const files = new Map();
  for (const line of git("ls-tree", "-r", ref, "--", `${FOLDER}/`).split("\n").filter(Boolean)) {
    const [meta, p] = line.split("\t");
    const rel = p.slice(FOLDER.length + 1);
    if (rel.startsWith("meta/") || !rel.endsWith(".sql")) continue;
    files.set(rel, meta.split(" ")[2]);
  }
  return { journal, files };
}

/** the migrations folder in the working tree: journal and the blob hash git would give each file */
export function treeOnDisk(root = process.cwd()) {
  const dir = path.join(root, FOLDER);
  const journal = JSON.parse(readFileSync(path.join(root, JOURNAL), "utf8"));
  const rels = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  if (existsSync(path.join(dir, PENDING_DIR))) {
    for (const f of readdirSync(path.join(dir, PENDING_DIR))) if (f.endsWith(".sql")) rels.push(`${PENDING_DIR}/${f}`);
  }
  const hashes = rels.length
    ? execFileSync("git", ["hash-object", "--stdin-paths"], { cwd: root, input: rels.map((r) => path.join(FOLDER, r)).join("\n"), encoding: "utf8" }).trim().split("\n")
    : [];
  return { journal, files: new Map(rels.map((r, i) => [r, hashes[i]])) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const ref = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--root");
  const rootAt = args.indexOf("--root");
  const root = path.resolve(rootAt >= 0 ? args[rootAt + 1] : process.cwd());
  if (!ref) {
    console.error("usage: migration-watermark-guard.mjs <base-ref> [--root <dir>]");
    process.exit(2);
  }
  const problems = migrationTreeProblems(treeAtRef(ref, root), treeOnDisk(root));
  if (problems.length) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  console.log("merged migrations unchanged, folder and journal agree, and the journal grew only by assignment");
}
