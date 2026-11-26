#!/usr/bin/env node
/**
 * THIRD_PARTY.md ↔ LOCKFILE (#1265, ADR-0176 rule 3): every npm row a
 * `THIRD_PARTY.md` lists names a version that is actually installed for that
 * package.
 *
 * WHY. ADR-0176 requires each shipped dependency to be listed at its locked
 * version. Nothing checked it, so Dependabot bumps left rows stale and only a
 * human reviewer caught them (#1255, #1257, #1293).
 *
 * WHAT IT CHECKS. It is STATIC and OFFLINE: it reads files only.
 *  - Which lockfile. A `THIRD_PARTY.md` next to a `package.json` that is a
 *    pnpm importer is checked against that importer in `pnpm-lock.yaml`;
 *    `scripts/THIRD_PARTY.md` against the root importer (the root
 *    devDependencies it documents). A directory with its own
 *    `package-lock.json` (an engine image such as `engines/promptfoo`) is
 *    checked against that file, together with the pnpm importer of its
 *    runner shim (`engines/<x>` → `packages/engine-<x>`), which the image
 *    also installs. Every other `THIRD_PARTY.md` (Go modules,
 *    PyPI wheels, images, tools) has no npm lockfile and is skipped.
 *  - The resolved set. For a pnpm importer: its dependencies,
 *    devDependencies and optionalDependencies, then everything they depend on
 *    through `snapshots`, and through `link:` into the workspace packages they
 *    use (a row may document a package that arrives through
 *    `@regulait/shared`). For a `package-lock.json`: every installed entry.
 *  - A row. A table line whose first cell's first backticked token is an npm
 *    package name and whose second cell holds a version (`1.2.3`, backticked
 *    or bare; the first one in the cell). The row fails if the package is in
 *    the resolved set at other versions only ("row X says A, the lockfile has
 *    B"), or if it is absent from the set although the row says `npm`. A name
 *    that is not in the set and does not say `npm` is not an npm row (a PyPI
 *    or Go component) and is left alone.
 *  - Exemption. A row carrying `<!-- third-party-lock: exempt <reason> -->`
 *    is skipped; the reason is required and printed.
 *
 * Open source first (ADR-0176), 2026-11-26: the lockfile is read with
 * `js-yaml` 4.3.2, already a pinned root devDependency. `@pnpm/lockfile.fs`
 * (MIT, maintained) would add about 20 packages, a second js-yaml major and a
 * git resolver to read one documented YAML file; `@pnpm/lockfile-file` is
 * unmaintained since 2024; `@pnpm/lockfile.walker` walks one importer's
 * snapshots but not `link:` edges into other importers, which this check
 * needs. The walk here is a breadth-first search over `snapshots`.
 *
 * Usage: node scripts/preflight-third-party-lock.mjs [repoRoot]
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const VERSION = /(?:^|[\s`(])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=$|[\s`),;])/;
const EXEMPT = /<!--\s*third-party-lock:\s*exempt\b\s*(.*?)\s*-->/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", "graphify-out", ".turbo"]);

/** Splits a markdown table line into trimmed cells (an escaped `\|` stays in its cell). */
export function splitRow(line) {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return body.split(/(?<!\\)\|/).map((c) => c.trim());
}

/**
 * The npm rows of one THIRD_PARTY.md: `{ line, name, version, sayNpm, exempt }`.
 * A row naming several packages (`` `a`, `b` `` | `` `1.0.0`, `2.0.0` ``) yields one
 * entry per name when the counts match; otherwise its first name and first version.
 */
export function parseRows(text) {
  const rows = [];
  text.split("\n").forEach((raw, i) => {
    if (!raw.trimStart().startsWith("|")) return;
    const cells = splitRow(raw);
    if (cells.length < 2 || /^:?-{3,}/.test(cells[0])) return;
    const first = /`([^`]+)`/.exec(cells[0]);
    if (!first || !NPM_NAME.test(first[1])) return;
    const names = [...cells[0].matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((n) => NPM_NAME.test(n));
    const versions = [...cells[1].matchAll(new RegExp(VERSION.source, "g"))].map((m) => m[1]);
    if (!versions.length) return;
    const ex = EXEMPT.exec(raw);
    const base = { line: i + 1, sayNpm: /\bnpm\b/.test(cells[0]), exempt: ex ? ex[1] || null : undefined };
    if (names.length > 1 && names.length === versions.length) {
      names.forEach((name, k) => rows.push({ ...base, name, version: versions[k] }));
    } else {
      rows.push({ ...base, name: first[1], version: versions[0] });
    }
  });
  return rows;
}

/** `name@1.2.3(peer@x)` → `{ name, version }`; `link:`/`file:` and aliases are handled by the caller. */
export function splitKey(key) {
  const at = key.indexOf("@", 1);
  const name = key.slice(0, at);
  const version = key.slice(at + 1).replace(/\(.*$/, "");
  return { name, version };
}

function stripPeers(v) {
  return String(v).replace(/\(.*$/, "");
}

/**
 * The resolved set of a pnpm importer: Map<name, Set<version>>.
 * `lock` is the parsed lockfile (v9: `importers`, `snapshots`).
 */
export function pnpmResolvedSet(lock, importer) {
  const importers = lock.importers ?? {};
  const snapshots = lock.snapshots ?? {};
  const set = new Map();
  const add = (n, v) => {
    if (!set.has(n)) set.set(n, new Set());
    set.get(n).add(v);
  };
  const seenSnap = new Set();
  const seenImp = new Set();
  const queue = [];
  const pushDep = (fromImp, name, ref) => {
    const r = String(ref);
    if (r.startsWith("link:")) {
      const target = posix.normalize(posix.join(fromImp, r.slice(5)));
      if (importers[target] && !seenImp.has(target)) queue.push({ imp: target });
      return;
    }
    // An npm alias (`name: npm:real@1.2.3` in importers, `real@1.2.3` in snapshots).
    let key;
    if (r.startsWith("npm:")) key = r.slice(4);
    else if (/^\d/.test(r)) key = `${name}@${r}`;
    else key = r.includes("@") ? r : `${name}@${r}`;
    queue.push({ snap: key });
  };
  queue.push({ imp: importer });
  while (queue.length) {
    const item = queue.shift();
    if (item.imp !== undefined) {
      if (seenImp.has(item.imp)) continue;
      seenImp.add(item.imp);
      const node = importers[item.imp] ?? {};
      for (const kind of ["dependencies", "devDependencies", "optionalDependencies"]) {
        for (const [n, spec] of Object.entries(node[kind] ?? {})) pushDep(item.imp, n, spec.version ?? spec);
      }
      continue;
    }
    if (seenSnap.has(item.snap)) continue;
    seenSnap.add(item.snap);
    const { name, version } = splitKey(item.snap);
    add(name, stripPeers(version));
    const snap = snapshots[item.snap] ?? snapshots[item.snap.replace(/\(.*$/, "")] ?? {};
    for (const kind of ["dependencies", "optionalDependencies"]) {
      for (const [n, ref] of Object.entries(snap[kind] ?? {})) {
        const r = String(ref);
        if (r.startsWith("link:")) continue;
        queue.push({ snap: /^\d/.test(r) ? `${n}@${r}` : r });
      }
    }
  }
  return set;
}

/** The resolved set of an npm `package-lock.json` (v2/v3): every installed entry. */
export function npmResolvedSet(pkgLock) {
  const set = new Map();
  for (const [path, entry] of Object.entries(pkgLock.packages ?? {})) {
    if (!path || !entry?.version || entry.link) continue;
    const name = entry.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    if (!set.has(name)) set.set(name, new Set());
    set.get(name).add(entry.version);
  }
  return set;
}

function mergeInto(set, other) {
  for (const [n, vs] of other) {
    if (!set.has(n)) set.set(n, new Set());
    for (const v of vs) set.get(n).add(v);
  }
}

/** Problems for one file's rows against one resolved set. */
export function checkRows(file, rows, set) {
  const problems = [];
  const exemptions = [];
  for (const row of rows) {
    const where = `${file}:${row.line}`;
    if (row.exempt !== undefined) {
      if (row.exempt) exemptions.push(`${where} ${row.name}: exempt (${row.exempt})`);
      else problems.push(`${where} row ${row.name} carries an exemption marker without a reason`);
      continue;
    }
    const have = set.get(row.name);
    if (!have) {
      if (row.sayNpm) problems.push(`${where} row ${row.name} says ${row.version}, the lockfile has no ${row.name}`);
      continue;
    }
    if (!have.has(row.version)) {
      problems.push(`${where} row ${row.name} says ${row.version}, the lockfile has ${[...have].sort().join(", ")}`);
    }
  }
  return { problems, exemptions };
}

function findThirdParty(root, dir = root, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) findThirdParty(root, p, out);
    else if (name === "THIRD_PARTY.md") out.push(p);
  }
  return out.sort();
}

/** Runs the check over a repository. Returns `{ checked, skipped, problems, exemptions }`. */
export function run(root) {
  const lock = yaml.load(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"), { schema: yaml.JSON_SCHEMA }) ?? {};
  const importers = lock.importers ?? {};
  const checked = [];
  const skipped = [];
  const problems = [];
  const exemptions = [];
  for (const file of findThirdParty(root)) {
    const rel = relative(root, file).split(sep).join("/");
    const dirAbs = dirname(file);
    let importer = relative(root, dirAbs).split(sep).join("/") || ".";
    if (importer === "scripts") importer = ".";
    let set;
    if (existsSync(join(dirAbs, "package-lock.json"))) {
      set = npmResolvedSet(JSON.parse(readFileSync(join(dirAbs, "package-lock.json"), "utf8")));
      // The image also carries the workspace runner shim (`engines/<x>` → `packages/engine-<x>`).
      const shim = importer.replace(/^engines\//, "packages/engine-");
      if (shim !== importer && importers[shim]) mergeInto(set, pnpmResolvedSet(lock, shim));
    } else if (importers[importer]) {
      set = pnpmResolvedSet(lock, importer);
    } else {
      skipped.push(rel);
      continue;
    }
    const result = checkRows(rel, parseRows(readFileSync(file, "utf8")), set);
    checked.push(rel);
    problems.push(...result.problems);
    exemptions.push(...result.exemptions);
  }
  return { checked, skipped, problems, exemptions };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const { checked, skipped, problems, exemptions } = run(root);
  console.log(`THIRD_PARTY.md lock check: ${checked.length} files checked, ${skipped.length} without an npm lockfile skipped.`);
  for (const e of exemptions) console.log(`  ${e}`);
  if (problems.length) {
    console.error(`\n${problems.length} THIRD_PARTY.md row(s) disagree with the lockfile:`);
    for (const p of problems) console.error(`  ${p}`);
    console.error("\nUpdate the row to the locked version (ADR-0176 rule 3), or mark a deliberate exception with");
    console.error("`<!-- third-party-lock: exempt <reason> -->` on the row.");
    process.exit(1);
  }
  console.log("Every npm row matches its lockfile.");
}
