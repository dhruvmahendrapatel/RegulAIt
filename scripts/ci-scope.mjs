#!/usr/bin/env node
// ADR-0262: what a CI run must cover (.github/actions/ci-scope runs this).
//
// FAIL CLOSED. Anything other than a pull_request is a full run. On a pull_request the PR's files are read from
// GitHub's merge commit (HEAD^1 is the base, HEAD^2 the PR head), with renames OFF so a moved file counts at both
// its old and its new path: moving apps/x.ts to docs/x.md is a code change. If the diff cannot be read (no merge
// commit, a missing parent in a shallow clone, any git error) or is empty, the run is full.
//
// A change to this scope machinery itself (this script, its test, the composite action) is a full run too: the rules
// that would skip a job are the thing under change.
//
// Outputs (each 'true' or 'false'; every one is 'true' on a full run):
//   code     any changed file that is not documentation
//   web      the web app or what it is built from
//   image    an input of the root Dockerfile image, or of the Trivy gate that judges it (allow-list, gate scripts)
//   engines  an engine's own inputs (engines/**, any Dockerfile, the lockfile, the engine allow-lists and gate scripts,
//            the image workflows). NOT every input: each engine Dockerfile also COPYs packages/ and apps/ (the shim
//            stage), so a change there alone gives engines=false and the engine build-and-compare runs at merge time.
//
// There is no gateway-only output: the gateway shards run whenever `code` is true, web-only PRs included. Gateway
// tests read apps/web sources (step-up-posture-guard walks every product source, apps/web included), so a web
// change can fail them (#737 review finding 1).
//
// usage: node scripts/ci-scope.mjs   (reads GITHUB_EVENT_NAME; appends the outputs to $GITHUB_OUTPUT if set)
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** documentation only: cannot change a build, a test or an image */
export const DOCS_RE = /^(internal|docs)\/|\.md$|^\.gitignore$|^LICENSE$/;
/** the web app, the shared package it imports, the workspace manifests, and the workflows and action that run its suites */
export const WEB_RE = /^(apps\/web\/|packages\/shared\/|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|package\.json$|\.github\/workflows\/(ci|ui-enterprise|mock-ui-shards)\.yml$|\.github\/actions\/)/;

/** the root image's build context (Dockerfile COPYs the workspace manifests, packages/ and apps/; .dockerignore
 *  drops tests and apps/web/e2e), the workflow that scans it, and the Trivy gate's own inputs: its allow-lists and the
 *  gate, runtime-contents, suppressions and cosign-verify scripts (#737 review finding 2) */
export const IMAGE_RE = /^(Dockerfile|\.dockerignore|pnpm-lock\.yaml|pnpm-workspace\.yaml|package\.json|tsconfig\.base\.json)$|^(apps|packages)\/|^\.github\/workflows\/security\.yml$|^security\/image-allowlist[^/]*\.json$|^scripts\/security-(gate|runtime-contents|suppressions)\.mjs$|^scripts\/security-cosign-verify\.sh$/;
/** files the root image's .dockerignore leaves out of the build context */
export const IMAGE_IGNORED_RE = /\.(test|spec)\.ts$|^apps\/web\/e2e\//;
/** an engine's own inputs: its directory, any Dockerfile, the lockfile, the engine packages and scripts, the engine
 *  allow-lists and the gate scripts its scan runs, the image workflows (not packages/ and apps/: see the header) */
export const ENGINES_RE = /^engines\/|(^|\/)Dockerfile$|^pnpm-lock\.yaml$|^packages\/engine-|^scripts\/(build-engine-image\.sh|engine-images-[a-z-]+\.mjs)$|^security\/image-allowlist\.engine-[^/]+\.json$|^scripts\/security-(gate|suppressions)\.mjs$|^scripts\/security-cosign-verify\.sh$|^\.github\/workflows\/(security|engine-images|engine-images-build)\.yml$/;
/** the scope machinery: changing it is a full run */
export const SELF_RE = /^(scripts\/ci-scope(\.test)?\.mjs|\.github\/actions\/ci-scope\/.*)$/;

export const FULL = Object.freeze({ full: true, code: true, web: true, image: true, engines: true, reason: "" });
export const OUTPUTS = Object.freeze(["full", "code", "web", "image", "engines"]);

/** the scope for a list of changed paths (null = could not be read) */
export function scopeOf(files) {
  if (!files) return { ...FULL, reason: "the PR's changed files could not be read" };
  if (files.length === 0) return { ...FULL, reason: "the PR's diff is empty" };
  if (files.some((f) => SELF_RE.test(f))) return { ...FULL, reason: "the PR changes the CI scope rules themselves" };
  const code = files.filter((f) => !DOCS_RE.test(f));
  return {
    full: false,
    code: code.length > 0,
    web: files.some((f) => WEB_RE.test(f)),
    image: code.some((f) => IMAGE_RE.test(f) && !IMAGE_IGNORED_RE.test(f)),
    engines: code.some((f) => ENGINES_RE.test(f)),
    reason: "",
  };
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
  const lines = OUTPUTS.map((k) => `${k}=${s[k]}`);
  console.log(s.reason ? `full run: ${s.reason}` : lines.join(" "));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
}
