#!/usr/bin/env node
/**
 * PRE-FLIGHT: NO NEW STATIC IMPORT CYCLE IN THE GATEWAY (ADR-0190 I4 follow-ups).
 *
 * Why: #383 shipped a runtime temporal-dead-zone crash from an import cycle
 * (mcp-proxy -> executor-stdio -> ... -> compat-core, which reads PROJECT_HEADER while its module initialises).
 * The gateway has many older cycles that cannot all be fixed at once, so this check is a RATCHET: it fails on any
 * import edge that is part of a cycle and is not in the checked-in baseline, and on any baseline entry that no
 * longer is one (so the baseline only ever shrinks).
 *
 * What is checked: the COMPILED gateway (`apps/gateway/dist`, after `pnpm -r build`), because that is the module
 * graph Node actually loads. `tsc` erases type-only imports, so they never count. Dynamic `import()` edges are left
 * out too: they run after every module has initialised, which is how the existing fixes break a cycle. Test files
 * (`*.test.js`) are left out, and so is any `dist` file with no `src` counterpart (a stale output on a dev machine).
 *
 * What escapes this ratchet: a TOP-LEVEL `await import()` (it runs during initialisation, but it is a dynamic edge,
 * so it is left out with the lazy ones) and a `require` through `createRequire` (not followed). Both are covered only
 * by `preflight-import-smoke.mjs`, which loads every module first in a fresh process.
 *
 * CI also refuses a PR whose baseline file GAINS an edge line against the base branch
 * (.github/workflows/import-cycles.yml), so `--update` can only ever shrink it in a merged change.
 *
 * The unit is an EDGE ("a.js -> b.js") that dependency-cruiser marks `circular`, i.e. the edge lies on some cycle.
 * Unlike a list of cycle paths, the set of such edges does not depend on the order a search visits modules in, so
 * the baseline is deterministic (sorted, one edge per line).
 *
 * Usage (from the repository root, after `pnpm -r build`):
 *   node scripts/preflight-import-cycles.mjs            # check; exit 1 on a new or stale entry, 2 if it cannot run
 *   node scripts/preflight-import-cycles.mjs --update   # rewrite the baseline from the current graph
 *
 * Shrinking the baseline: break a cycle (move the shared constant or type into a leaf module, or turn the import
 * that closes the loop into a lazy `await import()` inside the function that needs it), rebuild, run with
 * `--update`, and commit the shorter file. `--update` is never the fix for a NEW edge: a new cycle edge is a
 * review finding unless the PR says why it is safe (no top-level read of an imported binding on the loop).
 *
 * Tool: dependency-cruiser (MIT, pinned in the root package.json; see scripts/THIRD_PARTY.md). It parses and
 * resolves; this script only selects, sorts and compares.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const GATEWAY_ROOT = join(REPO_ROOT, "apps", "gateway");
export const BASELINE_FILE = join(REPO_ROOT, "scripts", "import-cycles-gateway.baseline.txt");

const BASELINE_HEADER = [
  "# Import-cycle baseline for apps/gateway (scripts/preflight-import-cycles.mjs).",
  "# One edge per line, `from -> to`, paths relative to apps/gateway/dist, sorted. Each edge lies on a static import",
  "# cycle that existed when this file was written. CI fails on an edge that is not listed, and on a listed edge that",
  "# is no longer on a cycle. Only ever SHRINK this file: fix a cycle, rebuild, run the script with --update.",
];

const toPosix = (p) => p.split(sep).join("/");

/** every compiled, non-test module under `dist` that still has its `src` TypeScript source */
export function liveDistModules(packageRoot, distDir = "dist", srcDir = "src") {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(join(packageRoot, distDir, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(childRel);
      else if (entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) {
        const src = join(packageRoot, srcDir, childRel.slice(0, -3));
        if (existsSync(`${src}.ts`) || existsSync(`${src}.mts`)) out.push(`${distDir}/${childRel}`);
      }
    }
  };
  walk("");
  return out.sort();
}

/** the sorted `from -> to` edges that dependency-cruiser marks circular (static imports only), plus one cycle each */
export async function circularEdges(packageRoot, distDir = "dist") {
  const { cruise } = await import("dependency-cruiser");
  const files = liveDistModules(packageRoot, distDir);
  if (files.length === 0) throw new Error(`no compiled modules under ${join(packageRoot, distDir)}; run \`pnpm -r build\` first`);
  const cwd = process.cwd();
  process.chdir(packageRoot);
  let result;
  try {
    result = await cruise(files, {
      includeOnly: `^${distDir}/`,
      exclude: { path: "\\.test\\.js$", dynamic: true },
      doNotFollow: { path: "node_modules" },
    });
  } finally {
    process.chdir(cwd);
  }
  const strip = (name) => toPosix(name).replace(new RegExp(`^${distDir}/`), "");
  const edges = new Map();
  for (const mod of result.output.modules) {
    for (const dep of mod.dependencies) {
      if (!dep.circular || dep.dynamic) continue;
      const key = `${strip(mod.source)} -> ${strip(dep.resolved)}`;
      if (!edges.has(key)) edges.set(key, (dep.cycle ?? []).map((c) => strip(typeof c === "string" ? c : c.name)));
    }
  }
  return new Map([...edges.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** baseline file text -> its edges (comments and blank lines ignored) */
export function parseBaseline(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

export function renderBaseline(edges) {
  return `${[...BASELINE_HEADER, ...[...edges].sort()].join("\n")}\n`;
}

/** what is on a cycle now and not in the baseline (`added`), and what the baseline lists that no longer is (`stale`) */
export function compareBaseline(current, baseline) {
  const now = new Set(current);
  const known = new Set(baseline);
  return {
    added: [...now].filter((e) => !known.has(e)).sort(),
    stale: [...known].filter((e) => !now.has(e)).sort(),
  };
}

async function main() {
  const update = process.argv.includes("--update");
  let edges;
  try {
    edges = await circularEdges(GATEWAY_ROOT);
  } catch (e) {
    console.error(`import-cycle check could not run: ${e.message}`);
    process.exit(2);
  }
  if (update) {
    writeFileSync(BASELINE_FILE, renderBaseline(edges.keys()));
    console.log(`wrote ${relative(REPO_ROOT, BASELINE_FILE)}: ${edges.size} edge(s) on import cycles`);
    return;
  }
  if (!existsSync(BASELINE_FILE)) {
    console.error(`no baseline at ${relative(REPO_ROOT, BASELINE_FILE)}; create it with --update`);
    process.exit(2);
  }
  const baseline = parseBaseline(readFileSync(BASELINE_FILE, "utf8"));
  const { added, stale } = compareBaseline(edges.keys(), baseline);
  console.log(`gateway import cycles: ${edges.size} edge(s) on a cycle, baseline ${baseline.length}`);
  if (added.length > 0) {
    console.error(`\nNEW import-cycle edge(s) in apps/gateway (${added.length}). A static import cycle can crash the gateway at start`);
    console.error("(a binding read while its module is still initialising: a temporal dead zone ReferenceError). Break the loop,");
    console.error("e.g. move the shared value into a leaf module or make the closing import a lazy `await import()`:");
    for (const e of added) console.error(`  ${e}\n      cycle: ${[e.split(" -> ")[0], ...(edges.get(e) ?? [])].join(" -> ")}`);
  }
  if (stale.length > 0) {
    console.error(`\n${stale.length} baseline edge(s) are no longer on a cycle. Shrink the baseline: \`node scripts/preflight-import-cycles.mjs --update\``);
    for (const e of stale) console.error(`  ${e}`);
  }
  if (added.length > 0 || stale.length > 0) process.exit(1);
  console.log("no new import cycle; the baseline is exact");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
