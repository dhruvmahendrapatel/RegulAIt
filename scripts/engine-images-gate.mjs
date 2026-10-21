#!/usr/bin/env node
/**
 * ENG-IMG publish gate (owner decision on #453, 2026-10-21; ADR-0187 addendum 2026-10-21) — WHAT an engine image is
 * built from, and whether that changed since the lock recorded it.
 *
 *   node scripts/engine-images-gate.mjs --plan [--force] [--github-output <file>] [--summary <file>]
 *       per engine: publish it when its inputs changed between the lock's `sourceCommit` and HEAD, when it was never
 *       published, or when --force (the workflow_dispatch input `force_publish`) says so. Writes `engines` (a JSON
 *       array) and `any` (true|false) for the workflow.
 *   node scripts/engine-images-gate.mjs --input <engine> [<ref>]
 *       prints "<input commit> <SOURCE_DATE_EPOCH>": the last commit at or before <ref> (default HEAD) that touched
 *       the engine's inputs, and its committer time. The build archives exactly that commit, labels the image with it
 *       (org.opencontainers.image.revision) and pins every timestamp to that time.
 *   node scripts/engine-images-gate.mjs --pathspecs <engine>
 *       prints the engine's input pathspecs, one per line (`git diff <a> <b> -- $(...)` reproduces the gate by hand).
 *
 * The inputs are what the build reads that can change the image (engines/<engine>/Dockerfile and its COPY lines):
 *   - engines/<engine>/ and any file directly in engines/ (never another engine's directory, the lock or the
 *     signatures: the lock-update PR changes only those, and must not count);
 *   - the engine's workspace package and its workspace dependency closure (dependencies of every kind, transitively),
 *     whole: the shim stage builds them and `pnpm deploy` ships them;
 *   - every workspace package.json (apps/*, packages/*): `pnpm install` reads them all, and a lifecycle script in any
 *     of them would run in the shim stage;
 *   - the root files the Dockerfiles COPY (package.json, pnpm-lock.yaml, pnpm-workspace.yaml, tsconfig.base.json),
 *     .dockerignore (it decides what the context holds), and the build's own scripts: build-engine-image.sh, this
 *     file (it decides the context) and engine-images-normalise.mjs (the image build runs it).
 * Never inputs:
 *   - packages/shared/src/engines/images-lock.ts, the module GENERATED from the lock: the build context carries its
 *     all-null form instead (engine-images-normalise.mjs `lock`), so a lock merge never changes an image;
 *   - `*.test.ts` and `*.spec.ts`, which .dockerignore keeps out of the context (engine-images-gate.test.mjs fails if
 *     .dockerignore stops doing so);
 *   - .github/workflows/engine-images.yml: a workflow edit that should republish uses `force_publish`.
 * Over-inclusion costs a rebuild under a new input commit (so new digests); under-inclusion would ship a stale image,
 * so when in doubt a path is an input. engine-images-gate.test.mjs checks every COPY source of every engine
 * Dockerfile is covered.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_IDS } from "./engine-images-lock.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const GENERATED_LOCK_MODULE = "packages/shared/src/engines/images-lock.ts";
export const ROOT_INPUTS = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  ".dockerignore",
  "scripts/build-engine-image.sh",
  "scripts/engine-images-gate.mjs",
  "scripts/engine-images-normalise.mjs",
];
/** what .dockerignore keeps out of every build context, so never an input */
export const CONTEXT_EXCLUDED = ["**/*.test.ts", "**/*.spec.ts"];
const WORKSPACE_DIRS = ["apps", "packages"];
const COMMIT = /^[0-9a-f]{40}$/;

export class GateError extends Error {}

const defaultGit = (args, opts = {}) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

/** the workspace packages: name -> { dir, deps } (deps: the workspace: dependencies of every kind) */
export function readWorkspace(root = ROOT) {
  const pkgs = new Map();
  for (const base of WORKSPACE_DIRS) {
    if (!existsSync(path.join(root, base))) continue;
    for (const d of readdirSync(path.join(root, base), { withFileTypes: true })) {
      const file = path.join(root, base, d.name, "package.json");
      if (!d.isDirectory() || !existsSync(file)) continue;
      const p = JSON.parse(readFileSync(file, "utf8"));
      const all = { ...p.dependencies, ...p.devDependencies, ...p.optionalDependencies, ...p.peerDependencies };
      const deps = Object.entries(all).filter(([, v]) => String(v).startsWith("workspace:")).map(([k]) => k);
      pkgs.set(p.name, { dir: `${base}/${d.name}`, deps });
    }
  }
  return pkgs;
}

/** the directories of `@regulait/engine-<engine>` and its workspace dependencies, transitively, sorted */
export function workspaceClosure(engine, pkgs) {
  const start = `@regulait/engine-${engine}`;
  if (!pkgs.has(start)) throw new GateError(`no workspace package ${start}`);
  const seen = new Set();
  const walk = (name) => {
    if (seen.has(name)) return;
    const p = pkgs.get(name);
    if (!p) throw new GateError(`${name}: a workspace dependency that is not in the workspace`);
    seen.add(name);
    for (const d of p.deps) walk(d);
  };
  walk(start);
  return [...seen].map((n) => pkgs.get(n).dir).sort();
}

/** the git pathspecs of one engine's image inputs */
export function inputPathspecs(engine, pkgs = readWorkspace()) {
  if (!ENGINE_IDS.includes(engine)) throw new GateError(`unknown engine: ${engine}`);
  return [
    ":(glob)engines/*",
    `engines/${engine}`,
    ...workspaceClosure(engine, pkgs),
    ...WORKSPACE_DIRS.map((b) => `:(glob)${b}/*/package.json`),
    ...ROOT_INPUTS,
    ":(exclude)engines/images.lock.json",
    ":(exclude)engines/signatures",
    `:(exclude)${GENERATED_LOCK_MODULE}`,
    ...CONTEXT_EXCLUDED.map((g) => `:(exclude,glob)${g}`),
  ];
}

/** the files under the engine's inputs that differ between two commits (both must be in the local history) */
export function changedInputs(from, to, specs, { git = defaultGit } = {}) {
  for (const c of [from, to]) {
    try {
      git(["cat-file", "-e", `${c}^{commit}`]);
    } catch {
      throw new GateError(`commit ${c} is not in the local history (check out with fetch-depth: 0)`);
    }
  }
  return git(["diff", "--name-only", "--no-renames", from, to, "--", ...specs]).split("\n").filter(Boolean);
}

/** the last commit at or before `ref` that touched the inputs, its committer time, and proof the inputs equal ref's */
export function inputCommit(specs, { ref = "HEAD", git = defaultGit } = {}) {
  const commit = git(["log", "-1", "--format=%H", ref, "--", ...specs]).trim();
  if (!COMMIT.test(commit)) throw new GateError(`no commit at or before ${ref} touches the image inputs`);
  // git's history simplification follows only parents whose inputs are identical, so this holds; it is checked anyway
  if (changedInputs(commit, ref, specs, { git }).length) throw new GateError(`the inputs at ${commit} differ from ${ref}'s`);
  const epoch = git(["show", "-s", "--format=%ct", commit]).trim();
  if (!/^\d+$/.test(epoch)) throw new GateError(`${commit}: no committer time`);
  return { commit, epoch };
}

/** the gate's verdict per engine (pure apart from `changed`) */
export function plan(lock, { force = false, changed }) {
  const engines = {};
  for (const id of ENGINE_IDS) {
    const sourceCommit = lock.engines?.[id]?.sourceCommit ?? null;
    if (force) engines[id] = { publish: true, reason: "forced (force_publish)", files: [] };
    else if (sourceCommit === null) engines[id] = { publish: true, reason: "never published", files: [] };
    else {
      if (!COMMIT.test(sourceCommit)) throw new GateError(`${id}: the lock's sourceCommit is not a full commit sha`);
      const files = changed(id, sourceCommit);
      engines[id] = files.length
        ? { publish: true, reason: `${files.length} input file(s) changed since ${sourceCommit.slice(0, 12)}`, files }
        : { publish: false, reason: `inputs unchanged since ${sourceCommit.slice(0, 12)}`, files: [] };
    }
  }
  const publish = ENGINE_IDS.filter((id) => engines[id].publish);
  return { engines, publish };
}

function summary(result) {
  const lines = ["### Engine image publish gate", "", "| engine | publish | why |", "|---|---|---|"];
  for (const id of ENGINE_IDS) lines.push(`| ${id} | ${result.engines[id].publish ? "yes" : "no"} | ${result.engines[id].reason} |`);
  for (const id of ENGINE_IDS) {
    const f = result.engines[id].files;
    if (f.length) lines.push("", `<details><summary>${id}: changed inputs</summary>`, "", ...f.slice(0, 200).map((x) => `- \`${x}\``), "", "</details>");
  }
  if (!result.publish.length) lines.push("", "Nothing to publish: the build, sign, publish and lock jobs are skipped.");
  return `${lines.join("\n")}\n`;
}

function main(argv) {
  const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  if (argv[0] === "--plan") {
    const lock = JSON.parse(readFileSync(path.join(ROOT, "engines/images.lock.json"), "utf8"));
    const pkgs = readWorkspace();
    const result = plan(lock, { force: argv.includes("--force"), changed: (id, from) => changedInputs(from, "HEAD", inputPathspecs(id, pkgs)) });
    const out = opt("--github-output");
    if (out) appendFileSync(out, `engines=${JSON.stringify(result.publish)}\nany=${result.publish.length > 0}\n`);
    const sum = opt("--summary");
    if (sum) appendFileSync(sum, summary(result));
    for (const id of ENGINE_IDS) console.log(`${id}: ${result.engines[id].publish ? "PUBLISH" : "skip"} (${result.engines[id].reason})`);
    return 0;
  }
  if (argv[0] === "--input") {
    const { commit, epoch } = inputCommit(inputPathspecs(argv[1]), { ref: argv[2] ?? "HEAD" });
    console.log(`${commit} ${epoch}`);
    return 0;
  }
  if (argv[0] === "--pathspecs") {
    console.log(inputPathspecs(argv[1]).join("\n"));
    return 0;
  }
  console.error("usage: engine-images-gate.mjs --plan [--force] [--github-output <file>] [--summary <file>] | --input <engine> [<ref>] | --pathspecs <engine>");
  return 2;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`engine image gate: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
