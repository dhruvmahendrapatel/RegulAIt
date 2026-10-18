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
 *   node scripts/engine-images-lock.mjs --check --base origin/main   also: the lock changed only as --apply changes it
 *   node scripts/engine-images-lock.mjs --write                   rewrite the derived files from the lock
 *   node scripts/engine-images-lock.mjs --apply <publish.json> --trusted-root <trusted_root.json>
 *                                                                 record a SIGNED publish (the workflow's artifact)
 *
 * `--apply` takes the `engine-images-publish.json` artifact the workflow uploads. It refuses a sourceCommit not
 * reachable from origin/main, and anything that is not `ghcr.io/<this repository's owner>/regulait-engine-<engine>`
 * (the owner from package.json `repository`, lowercased) with two `sha256:<64 hex>` digests, bumps an
 * engine's `publishGeneration` only when its digest changes (the manifest generation must move with every build,
 * ADR-0187 decision 95), and rewrites the derived files. Commit all three in one PR.
 *
 * Signing (ADR-0197 Q2, ADR-0190 "As built: engine image signing"): `--apply` refuses an engine whose publish entry
 * carries no keyless signature, or whose signature `engine-images-lock-verify.mjs` does not verify (the expected
 * identity and issuer, against the given Sigstore trusted root, for exactly this digest, image id and source commit).
 * It writes each new image's bundle to `engines/signatures/<engine>.sigstore.json` and the trusted root to
 * `engines/signatures/trusted_root.json`, so an air-gapped install verifies with no network. The lock-update bot (the
 * workflow's `lock-pr` job) runs `--apply` and opens the PR; nothing merges it but a person.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundlePath, checkBundleForEntry, SIGNATURES_DIR, TRUSTED_ROOT, verifyEntrySignature } from "./engine-images-lock-verify.mjs";

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

/**
 * The lock against the base's copy (#425 review, medium): the main-only and generation rules must hold however the
 * lock was changed, not only through `--apply`. Every published entry's sourceCommit is on main (`onMain`, default
 * `assertCommitOnMain`), an engine whose image changed moves its `publishGeneration` to exactly the base's + 1, and an
 * engine whose image did not change keeps its whole entry, and a new image's `publishedAt` is later than the base's.
 * `base` is the lock on the base ref (origin/main). This proves the SHAPE of a change, not that `--apply` made it:
 * provenance rests on the signed publish (#427 review F3). ADR-0197 Q2: a new image also carries its signature bundle,
 * and the bundle signs exactly the new entry by the publish workflow on main (`bundleFor`, default the committed
 * `engines/signatures/<engine>.sigstore.json`; read without cryptography here, cosign verifies it before use).
 */
export function checkLockTransition(base, lock, { onMain = (c) => assertCommitOnMain(c), bundleFor = readBundle } = {}) {
  validateLock(base);
  validateLock(lock);
  for (const id of ENGINE_IDS) {
    const b = base.engines[id];
    const e = lock.engines[id];
    if (e.sourceCommit !== null) onMain(e.sourceCommit);
    const changed = b.manifestDigest !== e.manifestDigest || b.imageId !== e.imageId || b.repository !== e.repository;
    if (changed && e.publishGeneration !== b.publishGeneration + 1) {
      throw new LockError(`${id}: a new image moves publishGeneration to exactly ${b.publishGeneration + 1} (the base's + 1), not ${e.publishGeneration}`);
    }
    // #427 review F3: `--apply` stamps a fresh publishedAt, so a new image recorded no later than the base's is a hand edit
    if (changed && e.publishedAt !== null && b.publishedAt !== null && Date.parse(e.publishedAt) <= Date.parse(b.publishedAt)) {
      throw new LockError(`${id}: a new image is published later than the base's (${b.publishedAt}), not at ${e.publishedAt}`);
    }
    if (!changed && JSON.stringify(e) !== JSON.stringify(b)) throw new LockError(`${id}: an engine whose image did not change keeps its whole entry`);
    if (changed && e.manifestDigest !== null) {
      const bundle = bundleFor(id);
      if (bundle === undefined) throw new LockError(`${id}: a new image carries its signature (engines/signatures/${id}.sigstore.json is missing)`);
      try {
        checkBundleForEntry(bundle, e);
      } catch (err) {
        throw new LockError(`${id}: ${err.message}`);
      }
    }
  }
  return lock;
}

/** the committed signature bundle of an engine, or undefined when there is none */
export function readBundle(id) {
  const f = bundlePath(id);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined;
}

/** the lock as committed on `ref` (git is injectable for tests) */
export function readLockAt(ref, { git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }) } = {}) {
  return validateLock(JSON.parse(git(["show", `${ref}:${path.relative(ROOT, PATHS.lock).split(path.sep).join("/")}`])));
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

/**
 * `--apply`'s signature gate (pure apart from `verify`): every engine the publish names must carry a signature that
 * `verify(id, entry, bundle)` accepts for exactly the entry the publish states, with the publish's sourceCommit
 * (the annotation the publish job signed). Returns the next lock and the bundles of the engines whose image changed.
 * `verify` throws to refuse; the CLI passes engine-images-lock-verify.mjs's cosign check.
 */
export function applySignedPublish(lock, publish, { verify }) {
  const names = Object.keys(publish?.engines ?? {});
  for (const id of names) {
    const p = publish.engines[id];
    const bundle = p?.signature?.bundle;
    if (!bundle) throw new LockError(`${id}: the publish carries no signature; an unsigned image is never recorded (ADR-0197 Q2)`);
    try {
      verify(id, { repository: p.repository, manifestDigest: p.manifestDigest, imageId: p.imageId, sourceCommit: publish.sourceCommit }, bundle);
    } catch (err) {
      throw new LockError(`${id}: ${err.message}`);
    }
  }
  const next = applyPublish(lock, publish);
  const bundles = {};
  for (const id of names) if (JSON.stringify(next.engines[id]) !== JSON.stringify(lock.engines[id])) bundles[id] = publish.engines[id].signature.bundle;
  return { lock: next, bundles };
}

/** cosign's check of one bundle, written to a scratch file (the CLI's `verify` for applySignedPublish) */
function cosignVerify(trustedRoot) {
  return (id, entry, bundle) => {
    const dir = mkdtempSync(path.join(tmpdir(), "engine-sig-"));
    try {
      const bundleFile = path.join(dir, `${id}.sigstore.json`);
      writeFileSync(bundleFile, JSON.stringify(bundle));
      verifyEntrySignature(id, entry, { bundleFile, trustedRoot });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const NO_TRUSTED_ROOT = "--apply needs --trusted-root <trusted_root.json> (the Sigstore trusted root the signatures are verified against)";

/**
 * `--apply` up to the writes (the checks are injectable for tests): the publish is of a commit on main, every new image
 * is signed for its entry, and, because `trustedRoot` replaces the committed one, every signature kept from before
 * verifies against it too (the air-gapped install's check). Throws before anything is written.
 */
export function prepareApply(lock, publish, { trustedRoot, verify, verifyKept, bundleFor = readBundle, onMain = (c) => assertCommitOnMain(c) } = {}) {
  if (!trustedRoot) throw new LockError(NO_TRUSTED_ROOT);
  onMain(publish?.sourceCommit);
  const signed = applySignedPublish(lock, publish, { verify: verify ?? cosignVerify(trustedRoot) });
  const kept = verifyKept ?? ((id, entry) => verifyEntrySignature(id, entry, { trustedRoot }));
  for (const id of ENGINE_IDS) {
    if (id in signed.bundles || signed.lock.engines[id].manifestDigest === null || bundleFor(id) === undefined) continue;
    kept(id, signed.lock.engines[id]);
  }
  return signed;
}

/**
 * `--check`'s signature pass: a committed signature must sign its entry; an entry without one is reported, not
 * refused here (every use refuses it, ADR-0197 Q2). Returns the engines reported unsigned.
 */
export function checkCommittedSignatures(lock, { bundleFor = readBundle, log = console.log } = {}) {
  const unsigned = [];
  for (const id of ENGINE_IDS) {
    const e = lock.engines[id];
    if (e.manifestDigest === null) continue;
    const bundle = bundleFor(id);
    if (bundle === undefined) {
      log(`engine image lock: ${id} has no signature; the installer and the bundle refuse it until a signed publish is recorded`);
      unsigned.push(id);
      continue;
    }
    try {
      checkBundleForEntry(bundle, e);
    } catch (err) {
      throw new LockError(`${id}: ${err.message}`);
    }
  }
  return unsigned;
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
    // `--check --base <ref>`: the lock may only have changed as `--apply` would change it (CI, after fetching main)
    if (arg === "--base") {
      const ref = argv[2];
      if (!ref) throw new LockError("--check --base needs the base ref (origin/main)");
      checkLockTransition(readLockAt(ref), lock, { onMain: (c) => assertCommitOnMain(c, { ref }) });
      console.log(`engine image lock: every published build is of ${ref}, and each changed image moved its generation once`);
    } else if (arg !== undefined) throw new LockError(`unknown --check option: ${arg}`);
    checkCommittedSignatures(lock);
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
      const trustedRoot = argv[2] === "--trusted-root" ? argv[3] : undefined;
      const signed = prepareApply(lock, JSON.parse(readFileSync(arg, "utf8")), { trustedRoot });
      lock = signed.lock;
      mkdirSync(SIGNATURES_DIR, { recursive: true });
      if (path.resolve(trustedRoot) !== TRUSTED_ROOT) copyFileSync(trustedRoot, TRUSTED_ROOT);
      for (const [id, bundle] of Object.entries(signed.bundles)) writeFileSync(bundlePath(id), `${JSON.stringify(bundle, null, 2)}\n`);
      writeFileSync(PATHS.lock, `${JSON.stringify(lock, null, 2)}\n`);
    }
    writeFileSync(PATHS.ts, renderTs(lock));
    writeFileSync(PATHS.compose, renderCompose(readFileSync(PATHS.compose, "utf8"), lock));
    console.log(`engine image lock: wrote ${mode === "--apply" ? "the lock, " : ""}the generated module and the compose defaults`);
    return 0;
  }
  console.error("usage: engine-images-lock.mjs --check [--base <ref>] | --write | --apply <publish.json> --trusted-root <trusted_root.json>");
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
