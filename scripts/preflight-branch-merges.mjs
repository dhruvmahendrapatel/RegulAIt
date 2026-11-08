#!/usr/bin/env node
// No sibling-branch merges (#738 §1; R-05 in the 2026-11-07 whole-build review).
//
// A lane branch may merge `main` into itself, but never another lane's branch: that folds unreviewed work from one PR
// into another (the entry-trim commit landed in six PRs this way). A stacked PR targets its parent PR's branch as its
// base and carries the `stacked` label instead.
//
// The check: every merge commit in <base>..<head> has each parent after the first reachable from <main>. A merge of
// main has main's commit as that parent; a merge of a sibling branch does not.
//
// Runs on pull_request only. In the merge queue every queue merge's second parent is a PR head, so it does not apply.
//
// usage: node scripts/preflight-branch-merges.mjs <base> <head> [--main <ref>] [--labels <comma,separated>]
//   <main> defaults to origin/main. With the `stacked` label the check reports and passes.
// exit 0 clean (or stacked), 1 sibling merges found, 2 usage or git error (fails closed, M-103).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** true when `commit` is an ancestor of (or equal to) `ref`; throws on any git error other than "not an ancestor" */
function isAncestor(commit, ref, cwd) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, ref], { cwd, stdio: "ignore" });
    return true;
  } catch (e) {
    if (e.status === 1) return false;
    throw new Error(`git merge-base --is-ancestor ${commit} ${ref} failed (exit ${e.status})`);
  }
}

/** merges in base..head whose non-first parents are not on main: [{ merge, parent, subject }] */
export function siblingMerges({ base, head, main = "origin/main", cwd = process.cwd() }) {
  for (const ref of [base, head, main]) git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
  const lines = git(["rev-list", "--merges", "--format=%H %P", "--no-commit-header", `${base}..${head}`], cwd);
  const out = [];
  for (const line of lines.split("\n").filter(Boolean)) {
    const [merge, , ...others] = line.split(" ");
    for (const parent of others) {
      if (!isAncestor(parent, main, cwd)) out.push({ merge, parent, subject: git(["log", "-1", "--format=%s", merge], cwd) });
    }
  }
  return out;
}

function main(argv) {
  const pos = [];
  let mainRef = "origin/main";
  let labels = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--main") mainRef = argv[++i];
    else if (argv[i] === "--labels") labels = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else pos.push(argv[i]);
  }
  if (pos.length !== 2 || !mainRef) {
    console.error("usage: node scripts/preflight-branch-merges.mjs <base> <head> [--main <ref>] [--labels <a,b>]");
    return 2;
  }
  let found;
  try {
    found = siblingMerges({ base: pos[0], head: pos[1], main: mainRef });
  } catch (e) {
    console.error(`preflight-branch-merges: ${e.message}`);
    return 2;
  }
  if (found.length === 0) {
    console.log(`preflight-branch-merges: no sibling-branch merges in ${pos[0]}..${pos[1]}`);
    return 0;
  }
  for (const f of found) console.error(`  ${f.merge} "${f.subject}" merges ${f.parent}, which is not on ${mainRef}`);
  if (labels.includes("stacked")) {
    console.log(`preflight-branch-merges: ${found.length} merge(s) of a non-main branch; allowed by the \`stacked\` label`);
    return 0;
  }
  console.error(
    `preflight-branch-merges: ${found.length} merge(s) of a branch other than main. Never merge one lane into another ` +
      "(AGENT_COORDINATION §4). Revert the merge with a new commit, or, for a stacked PR, target the parent PR's branch " +
      "as base and ask the master for the `stacked` label.",
  );
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
