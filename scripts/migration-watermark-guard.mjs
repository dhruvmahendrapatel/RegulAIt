#!/usr/bin/env node
// Migration watermark guard (internal/process/CONTRIBUTING_PARALLEL_SESSIONS.md §4.1).
//
// The migrator applies a journal entry only when its `when` is greater than the newest
// migration already applied, read once before the loop. So an entry this PR adds whose
// `when` is not above every `when` already on the base branch is skipped, silently and for
// good, on any database that has run the base branch. A fresh CI database hides it.
//
// usage: node scripts/migration-watermark-guard.mjs <base-ref>   (e.g. origin/main)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const JOURNAL = "packages/db/migrations/meta/_journal.json";

/** the problems with `head`'s journal against `base`'s, as lines; empty when the PR is safe */
export function watermarkProblems(base, head) {
  const out = [];
  const baseTags = new Set(base.entries.map((e) => e.tag));
  const baseMax = Math.max(...base.entries.map((e) => e.when));
  for (const e of head.entries) {
    if (baseTags.has(e.tag)) continue;
    if (!(e.when > baseMax)) {
      out.push(`${e.tag}: when ${e.when} is not above the base branch's newest when ${baseMax}; it would never apply on a database that has run the base branch. Renumber it above the base branch's highest migration (file, tag, idx, and when by the formula); see CONTRIBUTING_PARALLEL_SESSIONS §4.1.`);
    }
  }
  const whens = head.entries.map((e) => e.when);
  for (let i = 1; i < whens.length; i++) {
    if (!(whens[i] > whens[i - 1])) out.push(`${head.entries[i].tag}: when ${whens[i]} is not above the entry before it (${whens[i - 1]}); journal order must be strictly increasing.`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ref = process.argv[2];
  if (!ref) {
    console.error("usage: migration-watermark-guard.mjs <base-ref>");
    process.exit(2);
  }
  const base = JSON.parse(execFileSync("git", ["show", `${ref}:${JOURNAL}`], { encoding: "utf8" }));
  const head = JSON.parse(readFileSync(JOURNAL, "utf8"));
  const problems = watermarkProblems(base, head);
  if (problems.length) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  console.log("every new migration sits above the base branch's watermark");
}
