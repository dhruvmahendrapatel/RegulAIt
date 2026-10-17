#!/usr/bin/env node
/**
 * ENG-IMG (ADR-0190 "As built: engine task images") — THE ENGINE IMAGE LOCK.
 *
 * `engines/images.lock.json` is the one committed record of each engine image the publish workflow
 * (`.github/workflows/engine-images.yml`) pushed: its registry repository, its registry manifest digest (what a
 * runner reports and the gateway admits) and its image id (the config digest an executor runs a task by,
 * `docker image inspect --format '{{.Id}}'` on Docker's classic image store). Two files are DERIVED from it and must
 * never be edited by hand:
 *
 *   packages/shared/src/engines/images-lock.ts   the manifest's `imageDigest`, `taskImage` and generation step
 *   docker-compose.yml                           the defaults of REGULAIT_ENGINE_<ENGINE>_REPOSITORY / _DIGEST
 *
 * Until the first publish every entry is null: the manifest's `taskImage` stays null, so no engine task is placed
 * (`policy_unresolved`), exactly as before the lock existed (secure by default, ADR-0180).
 *
 *   node scripts/engine-images-lock.mjs --check                   exit 1 when a derived file is stale
 *   node scripts/engine-images-lock.mjs --write                   rewrite the derived files from the lock
 *   node scripts/engine-images-lock.mjs --apply <publish.json>    record a publish (the workflow's artifact)
 *
 * `--apply` takes the `engine-images-publish.json` artifact the workflow uploads. It refuses a sourceCommit not
 * reachable from origin/main, and anything that is not `ghcr.io/<this repository's owner>/regulait-engine-<engine>`
 * (the owner from package.json `repository`, lowercased) with two `sha256:<64 hex>` digests, bumps an
 * engine's `publishGeneration` only when its digest changes (the manifest generation must move with every build,
 * ADR-0187 decision 95), and rewrites the derived files. Commit all three in one PR.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ENGINE_IDS = ["promptfoo", "modelscan", "garak"];
export const LOCK_SCHEMA = "regulait.engine-images-lock.v1";
export const UNSET_DIGEST = `sha256:${"0".repeat(64)}`;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PATHS = {
  lock: path.join(ROOT, "engines/images.lock.json"),
  ts: path.join(ROOT, "packages/shared/src/engines/images-lock.ts"),
  compose: path.join(ROOT, "docker-compose.yml"),
  pkg: path.join(ROOT, "package.json"),
};

export class LockError extends Error {}

/**
 * The GHCR owner the lock accepts: this repository's own owner, read from the root package.json `repository`
 * (a github.com URL), lowercased as GHCR requires. An image pushed by a fork, or by anyone else, under another
 * namespace is refused by `--apply` and by `--check`.
 */
export function repositoryOwner(pkg = JSON.parse(readFileSync(PATHS.pkg, "utf8"))) {
  const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const m = /^(?:git\+)?https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/[A-Za-z0-9._-]+?(?:\.git)?$/.exec(url ?? "");
  if (!m) throw new LockError("package.json must name this repository as a https://github.com/<owner>/<repo> URL (the GHCR owner is pinned to it)");
  return m[1].toLowerCase();
}
export const GHCR_OWNER = repositoryOwner();
const repoPattern = (id) => new RegExp(`^ghcr\\.io/${GHCR_OWNER}/regulait-engine-${id}$`);

/**
 * `--apply` records only a build of a commit on main: the publish job runs only on main (engine-images.yml), and this
 * refuses a publish file whose sourceCommit is not an ancestor of `ref` (default origin/main, which must be fetched),
 * or is unknown to the local clone. `git` is injectable for tests.
 */
export function assertCommitOnMain(sourceCommit, { ref = "origin/main", git = (args) => execFileSync("git", args, { cwd: ROOT, stdio: "ignore" }) } = {}) {
  if (!COMMIT.test(sourceCommit ?? "")) throw new LockError("the publish must name its sourceCommit (a full commit sha)");
  try {
    git(["merge-base", "--is-ancestor", sourceCommit, ref]);
  } catch {
    throw new LockError(`the publish's sourceCommit ${sourceCommit} is not reachable from ${ref} (fetch ${ref} first; a build of any other branch is never recorded)`);
  }
}

/** validate a lock object; returns it unchanged or throws LockError */
export function validateLock(lock) {
  if (!lock || lock.schema !== LOCK_SCHEMA) throw new LockError(`the lock's schema must be ${LOCK_SCHEMA}`);
  const ids = Object.keys(lock.engines ?? {}).sort();
  if (ids.join(",") !== [...ENGINE_IDS].sort().join(",")) throw new LockError(`the lock must name exactly ${ENGINE_IDS.join(", ")}`);
  for (const id of ENGINE_IDS) {
    const e = lock.engines[id];
    const keys = Object.keys(e).sort().join(",");
    if (keys !== "imageId,manifestDigest,publishGeneration,publishedAt,repository,sourceCommit") throw new LockError(`${id}: unexpected fields (${keys})`);
    if (!Number.isInteger(e.publishGeneration) || e.publishGeneration < 0) throw new LockError(`${id}: publishGeneration must be a non-negative integer`);
    const set = [e.repository, e.manifestDigest, e.imageId, e.sourceCommit, e.publishedAt].map((v) => v !== null);
    if (set.some(Boolean) && !set.every(Boolean)) throw new LockError(`${id}: an entry is all null (never published) or all set`);
    if (!set[0]) {
      if (e.publishGeneration !== 0) throw new LockError(`${id}: an unpublished entry has publishGeneration 0`);
      continue;
    }
    if (!repoPattern(id).test(e.repository)) throw new LockError(`${id}: repository must be ghcr.io/${GHCR_OWNER}/regulait-engine-${id} (this repository's owner, lowercase)`);
    if (!DIGEST.test(e.manifestDigest) || e.manifestDigest === UNSET_DIGEST) throw new LockError(`${id}: manifestDigest must be sha256:<64 hex>`);
    if (!DIGEST.test(e.imageId) || e.imageId === UNSET_DIGEST) throw new LockError(`${id}: imageId must be sha256:<64 hex>`);
    if (!COMMIT.test(e.sourceCommit)) throw new LockError(`${id}: sourceCommit must be a full commit sha`);
    if (Number.isNaN(Date.parse(e.publishedAt)) || new Date(e.publishedAt).toISOString() !== e.publishedAt) throw new LockError(`${id}: publishedAt must be an ISO timestamp`);
    if (e.publishGeneration < 1) throw new LockError(`${id}: a published entry has publishGeneration 1 or more`);
  }
  return lock;
}

/** record a publish into the lock (pure): only engines named in the publish change */
export function applyPublish(lock, publish) {
  validateLock(lock);
  if (!publish || typeof publish !== "object" || !COMMIT.test(publish.sourceCommit ?? "")) throw new LockError("the publish must name its sourceCommit (a full commit sha)");
  if (Number.isNaN(Date.parse(publish.publishedAt ?? ""))) throw new LockError("the publish must name publishedAt");
  const names = Object.keys(publish.engines ?? {});
  if (names.length === 0) throw new LockError("the publish names no engine");
  const next = structuredClone(lock);
  for (const id of names) {
    if (!ENGINE_IDS.includes(id)) throw new LockError(`the publish names an unknown engine: ${id}`);
    const p = publish.engines[id];
    const prev = lock.engines[id];
    const changed = prev.manifestDigest !== p.manifestDigest || prev.imageId !== p.imageId || prev.repository !== p.repository;
    next.engines[id] = {
      repository: p.repository,
      manifestDigest: p.manifestDigest,
      imageId: p.imageId,
      publishGeneration: prev.publishGeneration + (changed ? 1 : 0),
      sourceCommit: changed ? publish.sourceCommit : prev.sourceCommit,
      publishedAt: changed ? new Date(publish.publishedAt).toISOString() : prev.publishedAt,
    };
  }
  return validateLock(next);
}

/** the generated TypeScript module (deterministic) */
export function renderTs(lock) {
  validateLock(lock);
  const lines = [
    "// GENERATED by scripts/engine-images-lock.mjs from engines/images.lock.json — do not edit by hand.",
    "// Change the lock with `node scripts/engine-images-lock.mjs --apply <publish.json>` (or `--write` after a reviewed",
    "// manual edit) and commit the lock, this file and docker-compose.yml together. `--check` runs in CI.",
    "",
    "/** one engine image the publish workflow pushed; every field null until its first publish */",
    "export interface EngineImageLockEntry {",
    "  /** the registry repository (ghcr.io/<owner>/regulait-engine-<engine>) */",
    "  repository: string | null;",
    "  /** the registry manifest digest: what the runner reports and the gateway admits (the manifest's `imageDigest`) */",
    "  manifestDigest: string | null;",
    "  /** the image id (config digest) an executor runs the task by (the manifest's `taskImage`) */",
    "  imageId: string | null;",
    "  /** how many distinct builds were recorded; added to the manifest entry's generation */",
    "  publishGeneration: number;",
    "  sourceCommit: string | null;",
    "  publishedAt: string | null;",
    "}",
    "",
    `export const ENGINE_IMAGES_LOCK: Readonly<Record<"promptfoo" | "modelscan" | "garak", Readonly<EngineImageLockEntry>>> = Object.freeze({`,
  ];
  const lit = (v) => (v === null ? "null" : JSON.stringify(v));
  for (const id of ENGINE_IDS) {
    const e = lock.engines[id];
    lines.push(`  ${id}: Object.freeze({`);
    for (const k of ["repository", "manifestDigest", "imageId", "publishGeneration", "sourceCommit", "publishedAt"]) lines.push(`    ${k}: ${lit(e[k])},`);
    lines.push("  }),");
  }
  lines.push("});", "");
  return lines.join("\n");
}

/** docker-compose.yml with each engine's repository and digest defaults taken from the lock */
export function renderCompose(compose, lock) {
  validateLock(lock);
  let out = compose;
  for (const id of ENGINE_IDS) {
    const e = lock.engines[id];
    const up = id.toUpperCase();
    const repo = e.repository ?? `regulait/engine-${id}`;
    const digest = e.manifestDigest ?? UNSET_DIGEST;
    const repoRe = new RegExp(`\\$\\{REGULAIT_ENGINE_${up}_REPOSITORY:-[^}]*\\}`, "g");
    const digRe = new RegExp(`\\$\\{REGULAIT_ENGINE_${up}_DIGEST:-[^}]*\\}`, "g");
    if (!repoRe.test(out) || !digRe.test(out)) throw new LockError(`docker-compose.yml has no REGULAIT_ENGINE_${up}_REPOSITORY/_DIGEST defaults to set`);
    out = out.replace(repoRe, `\${REGULAIT_ENGINE_${up}_REPOSITORY:-${repo}}`).replace(digRe, `\${REGULAIT_ENGINE_${up}_DIGEST:-${digest}}`);
  }
  return out;
}

function readLock() {
  return validateLock(JSON.parse(readFileSync(PATHS.lock, "utf8")));
}

function main(argv) {
  const [mode, arg] = argv;
  if (mode === "--check") {
    const lock = readLock();
    const stale = [];
    if (readFileSync(PATHS.ts, "utf8") !== renderTs(lock)) stale.push(path.relative(ROOT, PATHS.ts));
    const compose = readFileSync(PATHS.compose, "utf8");
    if (compose !== renderCompose(compose, lock)) stale.push(path.relative(ROOT, PATHS.compose));
    if (stale.length) {
      console.error(`engine image lock: stale derived file(s): ${stale.join(", ")}. Run: node scripts/engine-images-lock.mjs --write`);
      return 1;
    }
    console.log("engine image lock: derived files match engines/images.lock.json");
    return 0;
  }
  if (mode === "--write" || mode === "--apply") {
    let lock = readLock();
    if (mode === "--apply") {
      if (!arg) throw new LockError("--apply needs the publish file (the workflow's engine-images-publish.json artifact)");
      const publish = JSON.parse(readFileSync(arg, "utf8"));
      assertCommitOnMain(publish?.sourceCommit);
      lock = applyPublish(lock, publish);
      writeFileSync(PATHS.lock, `${JSON.stringify(lock, null, 2)}\n`);
    }
    writeFileSync(PATHS.ts, renderTs(lock));
    writeFileSync(PATHS.compose, renderCompose(readFileSync(PATHS.compose, "utf8"), lock));
    console.log(`engine image lock: wrote ${mode === "--apply" ? "the lock, " : ""}the generated module and the compose defaults`);
    return 0;
  }
  console.error("usage: engine-images-lock.mjs --check | --write | --apply <publish.json>");
  return 2;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`engine image lock: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
