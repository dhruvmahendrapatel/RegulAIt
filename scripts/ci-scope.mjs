#!/usr/bin/env node
// ADR-0262: what a CI run must cover (.github/actions/ci-scope runs this).
//
// FAIL CLOSED. Anything other than a pull_request is a full run. On a pull_request the PR's files are read from
// GitHub's merge commit (HEAD^1 is the base, HEAD^2 the PR head), with renames OFF so a moved file counts at both
// its old and its new path: moving apps/x.ts to docs/x.md is a code change. If the diff cannot be read (no merge
// commit, a missing parent in a shallow clone, any git error) or is empty, the run is full.
//
// A change to this scope machinery itself (this script, its test, the composite action) is a full run too: the rules
// that would skip a job are the thing under change. ADR-0323: so is a change that can reach any suite whatever its
// path says: the dependencies (lockfile, any package.json, the workspace and toolchain files), CI itself (any workflow
// or action), the database schema and migrations, and the security configuration (security/**, gitleaks, CODEOWNERS,
// Dependabot).
//
// Outputs (each 'true' or 'false'; every one is 'true' on a full run):
//   code     any changed file that is not documentation
//   web      the web app or what it is built from
//   image    an input of the root Dockerfile image, or of the Trivy gate that judges it (allow-list, gate scripts)
//   engines  an engine's own inputs (engines/**, any Dockerfile, the lockfile, the engine allow-lists and gate scripts,
//            the image workflows). NOT every input: each engine Dockerfile also COPYs packages/ and apps/ (the shim
//            stage), so a change there alone gives engines=false and the engine build-and-compare runs at merge time.
//
//   base     ADR-0323: `code`, or a change to documentation that build-and-test-base's own checks read: the ADR files
//            and index (internal/decisions/**), the merge-time fragments (internal/fragments/**), PENDING.md, and any
//            THIRD_PARTY.md (the licence gate). Runs the build, package suites and static pre-flights, no database.
//   gateway  ADR-0323: a code change outside apps/web/**. When it is false on a code PR (a web-only PR) the five
//            gateway shards and their coverage check are replaced by ONE runner that runs only the gateway tests that
//            read apps/web sources (`--gateway-web-readers`, below): step-up-posture-guard walks every product source,
//            apps/web included, and a handful of contract tests read SPA files (#737 review finding 1).
//
// usage: node scripts/ci-scope.mjs                         (reads GITHUB_EVENT_NAME; appends to $GITHUB_OUTPUT if set)
//        node scripts/ci-scope.mjs --gateway-web-readers   (prints the gateway test files that read outside the gateway)
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** documentation only: cannot change a build, a test or an image */
export const DOCS_RE = /^(internal|docs)\/|\.md$|^\.gitignore$|^LICENSE$/;
/** the web app, the shared package it imports, the workspace manifests, and the workflows and action that run its suites */
export const WEB_RE = /^(apps\/web\/|packages\/(shared|ui)\/|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|package\.json$|\.github\/workflows\/(ci|ui-enterprise|mock-ui-shards)\.yml$|\.github\/actions\/)/;

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
export const SELF_RE = /^(scripts\/ci-(scope|plan)(\.test)?\.mjs|\.github\/actions\/ci-scope\/.*)$/;
/** ADR-0323: a change any suite can depend on, whatever its path says, is a full run: the dependencies and the
 *  toolchain (lockfile, every package.json, the workspace, .npmrc, .node-version, the base tsconfig), CI itself (any
 *  workflow or action), the database schema and its migrations, and the security configuration */
export const ALL_RE = /^(pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.node-version|tsconfig\.base\.json)$|(^|\/)package\.json$|^\.github\/(workflows|actions)\/|^\.github\/(CODEOWNERS|dependabot\.yml)$|^packages\/db\/(src\/schema\.ts|migrations\/|drizzle\.config\.ts)|^security\/|^\.gitleaks\.toml$/;
/** ADR-0323: documentation that build-and-test-base's checks read (the scripts tests and the licence gate) */
export const BASE_DOCS_RE = /^internal\/(decisions|fragments)\/|^internal\/product\/PENDING\.md$|(^|\/)THIRD_PARTY\.md$/;
/** ADR-0323: the only tree a web-only PR changes; anything else is a gateway change */
export const WEB_ONLY_RE = /^apps\/web\//;

export const FULL = Object.freeze({ full: true, code: true, base: true, web: true, image: true, engines: true, gateway: true, reason: "" });
export const OUTPUTS = Object.freeze(["full", "code", "base", "web", "image", "engines", "gateway"]);

/** the scope for a list of changed paths (null = could not be read) */
export function scopeOf(files) {
  if (!files) return { ...FULL, reason: "the PR's changed files could not be read" };
  if (files.length === 0) return { ...FULL, reason: "the PR's diff is empty" };
  if (files.some((f) => SELF_RE.test(f))) return { ...FULL, reason: "the PR changes the CI scope rules themselves" };
  const code = files.filter((f) => !DOCS_RE.test(f));
  const all = code.find((f) => ALL_RE.test(f));
  if (all) return { ...FULL, reason: `the PR changes ${all} (dependencies, CI, the schema or security configuration)` };
  return {
    full: false,
    code: code.length > 0,
    base: code.length > 0 || files.some((f) => BASE_DOCS_RE.test(f)),
    web: files.some((f) => WEB_RE.test(f)),
    image: code.some((f) => IMAGE_RE.test(f) && !IMAGE_IGNORED_RE.test(f)),
    engines: code.some((f) => ENGINES_RE.test(f)),
    gateway: code.some((f) => !WEB_ONLY_RE.test(f)),
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

/** a gateway test that names the web app, or reads files and reaches the repository root (`../../..`, `"apps"`,
 *  `process.cwd()`, `git ls-files`). Deliberately broad: a file wrongly included only runs; one wrongly left out
 *  is a gateway test a web-only PR does not run (it still runs at merge time, on main and nightly). */
export const WEB_NAME_RE = /\.\.\/\.\.\/web\b|apps\/web\b|["'`]web["'`]\s*[,)]/;
export const READS_FILES_RE = /\b(readFileSync|readdirSync|readFile|readdir|statSync|existsSync|globSync|glob|execFileSync|execSync|spawnSync)\s*\(/;
export const REPO_ROOT_RE = /["'`](\.\.\/){2,}\.\.["'`/]|["'`]apps["'`]|process\.cwd\(\)|ls-files/;

/** the gateway test files (paths relative to apps/gateway) a web-only PR must still run, sorted */
export function gatewayWebReaders(root = repoRoot) {
  const src = path.join(root, "apps/gateway/src");
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(p);
      } else if (/\.test\.ts$/.test(e.name)) {
        const text = readFileSync(p, "utf8");
        if (WEB_NAME_RE.test(text) || (READS_FILES_RE.test(text) && REPO_ROOT_RE.test(text))) out.push(p);
      }
    }
  };
  walk(src);
  return out.map((p) => path.relative(path.join(root, "apps/gateway"), p).split(path.sep).join("/")).sort();
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv[2] === "--gateway-web-readers") {
  console.log(gatewayWebReaders().join(" "));
} else if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const s = scopeForEvent(process.env.GITHUB_EVENT_NAME ?? "");
  const lines = OUTPUTS.map((k) => `${k}=${s[k]}`);
  console.log(s.reason ? `full run: ${s.reason}` : lines.join(" "));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
}
