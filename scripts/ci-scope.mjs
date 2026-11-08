#!/usr/bin/env node
// ADR-0252 addendum: what a CI run must cover (.github/actions/ci-scope runs this).
//
// FAIL CLOSED. Anything other than a pull_request is a full run. On a pull_request the PR's files are read from
// GitHub's merge commit (HEAD^1 is the base, HEAD^2 the PR head), with renames OFF so a moved file counts at both
// its old and its new path: moving apps/x.ts to docs/x.md is a code change. If the diff cannot be read (no merge
// commit, a missing parent in a shallow clone, any git error) or is empty, the run is full.
//
// usage: node scripts/ci-scope.mjs   (reads GITHUB_EVENT_NAME; appends full=, code=, web= to $GITHUB_OUTPUT if set)
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** documentation only: cannot change a build, a test or an image */
export const DOCS_RE = /^(internal|docs)\/|\.md$|^\.gitignore$|^LICENSE$/;
/** the web app, the shared package it imports, the workspace manifests, and the workflows and action that run its suites */
export const WEB_RE = /^(apps\/web\/|packages\/shared\/|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|package\.json$|\.github\/workflows\/(ci|ui-enterprise|mock-ui-shards)\.yml$|\.github\/actions\/|scripts\/ci-scope\.mjs$)/;

export const FULL = Object.freeze({ full: true, code: true, web: true, reason: "" });

/** the scope for a list of changed paths (null = could not be read) */
export function scopeOf(files) {
  if (!files) return { ...FULL, reason: "the PR's changed files could not be read" };
  if (files.length === 0) return { ...FULL, reason: "the PR's diff is empty" };
  return { full: false, code: files.some((f) => !DOCS_RE.test(f)), web: files.some((f) => WEB_RE.test(f)), reason: "" };
}

/** the PR's changed paths from the merge commit at HEAD, both sides of every rename; null when that cannot be done */
export function changedFiles(cwd = process.cwd()) {
  try {
    const git = (...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const parents = git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ").slice(1);
    if (parents.length !== 2) return null; // not GitHub's pull_request merge commit
    git("cat-file", "-e", `${parents[0]}^{commit}`); // the base must really be here (shallow clones)
    const out = git("diff", "--name-only", "--no-renames", "-z", `${parents[0]}`, "HEAD");
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

export function scopeForEvent(event, cwd) {
  if (event !== "pull_request") return { ...FULL, reason: `not a pull request (${event || "unknown event"})` };
  return scopeOf(changedFiles(cwd));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const s = scopeForEvent(process.env.GITHUB_EVENT_NAME ?? "");
  console.log(s.reason ? `full run: ${s.reason}` : `full=${s.full} code=${s.code} web=${s.web}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `full=${s.full}\ncode=${s.code}\nweb=${s.web}\n`);
}
