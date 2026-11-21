#!/usr/bin/env node
/**
 * ADR-0344: per-route bundle budgets. Two hard totals in apps/web/.size-limit.json bound what a first visit loads:
 * `first-load JS` (the entry chunk and its static imports) and `first-paint JS` (that, plus the screen each first-visit
 * path renders and everything those reach through static or dynamic imports), beside the "entry JS (index)" and
 * "entry CSS (index)" ceilings. Both are read from Vite's build manifest (`vite build --manifest`). Every JS chunk the build emits (each lazily loaded route chunk,
 * and each shared chunk) has its own gzip ceiling there, named `chunk: <name>`. A new screen grows only the chunk of
 * the route it lives in; there is no total over every chunk (ADR-0344 addendum, owner decision 2026-11-21).
 *
 *   --check   after `pnpm --filter @regulait/web build`: exit 1 unless every JS file under apps/web/dist/assets is
 *             covered by exactly one ceiling, every `chunk:` ceiling names a chunk the build emitted, and no two
 *             chunks share a name (size-limit would add them up under one ceiling), and each total lists exactly
 *             the chunks it adds up. size-limit itself checks the sizes; this checks that nothing is left without a
 *             ceiling and that the totals measure what a first visit loads.
 *   --write   add a `chunk:` ceiling for each emitted chunk that has none, at its current gzip size plus HEADROOM, and
 *             drop `chunk:` ceilings for chunks the build no longer emits, and set each total's path list from the
 *             build. It never changes an existing limit: a raise
 *             goes through an owner exception (scripts/ui-enterprise-baseline.mjs, CEILING_EXCEPTIONS).
 *
 * A route that is not lazy-loaded is part of the entry chunk, so it counts against "entry JS (index)". There is no
 * other place for it to go.
 *
 * Chunk names come from the file name the build writes: `<name>-<8-character hash>.js` (Vite's default
 * `assets/[name]-[hash].js`). A ceiling's path is matched by the chunk name it spells, not by a glob engine: the
 * check reads `dist/assets/<name>-????????.js` (a `chunk:` ceiling) or `dist/assets/<name>-*.js` (the entry and the
 * two older `lazy:` ceilings) and compares names. Any other path shape in a JS ceiling is reported.
 *
 * Exit 0 clean, 1 on a problem, 2 if it could not run.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SIZE_LIMIT_FILE = path.join(root, "apps", "web", ".size-limit.json");
export const ASSETS_DIR = path.join(root, "apps", "web", "dist", "assets");
/** Vite's own build manifest, written by `vite build --manifest` (the CI bundle job builds with it) */
export const MANIFEST_FILE = path.join(root, "apps", "web", "dist", ".vite", "manifest.json");
export const APP_FILE = path.join(root, "apps", "web", "src", "App.tsx");
export const CHUNK_PREFIX = "chunk: ";
/** the hard first-load total: the entry chunk plus its static imports (what index.html loads) */
export const FIRST_LOAD_NAME = "first-load JS";
/** the hard first-paint total: everything a first visit to a FIRST_VISIT_PATHS screen can load */
export const FIRST_PAINT_NAME = "first-paint JS";
/** the totals, each a sum over chunks that have their own ceilings; --check pins each path list to the build */
export const TOTAL_NAMES = [FIRST_LOAD_NAME, FIRST_PAINT_NAME];
/** the screens a first visit lands on: the sign-in screen, and home after sign-in */
export const FIRST_VISIT_PATHS = ["/login", "/"];

/**
 * ADR-0344's headroom: a new ceiling is the chunk's gzip size plus 10%, and at least 2 kB more, rounded up to the next
 * 0.1 kB. The floor keeps a small chunk from failing on a few hundred bytes; the 10% lets a route grow a screen or two.
 */
export const HEADROOM = { ratio: 0.1, minBytes: 2000 };

/** the chunk name of an emitted JS file (`admin-integrations-B6EzGUPE.js` -> `admin-integrations`), or null */
export const chunkName = (file) => /^(.+)-[A-Za-z0-9_-]{8}\.js$/.exec(file)?.[1] ?? null;

/** the path a `chunk:` ceiling uses for chunk `name` */
export const chunkPath = (name) => `dist/assets/${name}-????????.js`;

/** a size-limit `limit` for a chunk of `bytes` gzip bytes, with HEADROOM */
export function ceilingFor(bytes) {
  const withRoom = Math.max(bytes * (1 + HEADROOM.ratio), bytes + HEADROOM.minBytes);
  return `${(Math.ceil(withRoom / 100) / 10).toFixed(1)} kB`;
}

/** the manifest key of the build's entry (index.html) */
function entryKey(manifest) {
  const keys = Object.keys(manifest).filter((k) => manifest[k].isEntry);
  if (keys.length !== 1) throw new Error(`the build manifest has ${keys.length} entries; expected exactly one (index.html)`);
  return keys[0];
}

/** every manifest key reached from `keys` through static imports, and also dynamic imports where `followDynamic` allows */
function reach(manifest, keys, followDynamic = () => false) {
  const seen = new Set();
  const stack = [...keys];
  while (stack.length) {
    const k = stack.pop();
    if (seen.has(k)) continue;
    const m = manifest[k];
    if (!m) throw new Error(`the build manifest has no "${k}"`);
    seen.add(k);
    stack.push(...(m.imports ?? []));
    for (const d of m.dynamicImports ?? []) if (followDynamic(k, d)) stack.push(d);
  }
  return seen;
}

/** the JS files of a set of manifest keys, sorted */
const jsFiles = (manifest, keys) => [...new Set([...keys].map((k) => manifest[k].file).filter((f) => f.endsWith(".js")))].map((f) => f.slice(f.lastIndexOf("/") + 1)).sort();

/** the JS a first visit loads before any screen: the entry chunk and its static imports (Vite's build manifest) */
export function firstLoadFiles(manifest) {
  return jsFiles(manifest, reach(manifest, [entryKey(manifest)]));
}

/**
 * The route screens App.tsx declares: the `src/...` module each `screen(() => import("./x"), ...)` or
 * `lazy(() => import("./x"))` constant loads, by constant name; and which constant each `<Route path=... element=...>`
 * renders, by path.
 */
export function appRoutes(appSource) {
  const modules = new Map();
  for (const m of appSource.matchAll(/const\s+(\w+)\s*=\s*(?:screen|lazy)\(\s*\(\)\s*=>\s*import\(\s*"\.\/([^"]+)"\s*\)/g)) modules.set(m[1], `src/${m[2]}`);
  const elements = new Map();
  for (const m of appSource.matchAll(/<Route\s+path="([^"]+)"\s+element=\{<(\w+)\b/g)) if (!elements.has(m[1])) elements.set(m[1], m[2]);
  return { modules, elements };
}

/** the manifest key of a source module path without extension (`src/screens/auth` -> `src/screens/auth.ts`) */
function moduleKey(manifest, mod) {
  const key = ["ts", "tsx", "js", "jsx"].flatMap((e) => [`${mod}.${e}`, `${mod}/index.${e}`]).find((k) => manifest[k]);
  if (!key) throw new Error(`the build manifest has no module for ${mod}`);
  return key;
}

/**
 * The JS a first visit can load: the entry, the screen each of FIRST_VISIT_PATHS renders, and every chunk those reach
 * through static and dynamic imports. The one thing left out is the entry's route table: its dynamic imports of the
 * other screens App.tsx declares. Any other dynamic import counts, whether the code awaits it at once or later, so
 * moving code out of the entry or a first screen into a new lazy chunk does not take it out of this total.
 */
export function firstPaintFiles(manifest, appSource, paths = FIRST_VISIT_PATHS) {
  const { modules, elements } = appRoutes(appSource);
  const entry = entryKey(manifest);
  const routeKeys = new Set([...modules.values()].map((m) => moduleKey(manifest, m)));
  const first = paths.map((p) => {
    const name = elements.get(p);
    if (!name || !modules.has(name)) throw new Error(`App.tsx renders no lazily loaded screen at "${p}"; FIRST_VISIT_PATHS names the first screens`);
    return moduleKey(manifest, modules.get(name));
  });
  return jsFiles(manifest, reach(manifest, [entry, ...first], (from, to) => !(from === entry && routeKeys.has(to))));
}

/** a total's path list for those files */
export const totalPaths = (files) => files.map((f) => chunkPath(chunkName(f) ?? f)).sort();

/** problems with the total `name` against the files it must add up, as lines */
export function totalProblems(name, files, entries) {
  const e = entries.find((x) => x.name === name);
  if (!e) return [`no "${name}" ceiling in apps/web/.size-limit.json; it is a required hard budget (ADR-0344 addendum)`];
  const out = [];
  if (e.gzip !== true) out.push(`"${name}": must measure gzip (\`"gzip": true\`)`);
  if (files.length === 0) out.push(`"${name}": the build loads no JS for it; the manifest is not the web app's`);
  const want = totalPaths(files);
  const have = [e.path].flat().slice().sort();
  if (JSON.stringify(want) !== JSON.stringify(have)) {
    out.push(`"${name}": its paths must be exactly the chunks it adds up (${want.join(", ")}); set them with node scripts/ui-chunk-budgets.mjs --write`);
  }
  return out;
}

/** the chunk name a JS ceiling path spells, and whether it is the exact `chunk:` form; null for another shape */
function pathChunk(p) {
  const m = /^dist\/assets\/(.+)-(\?{8}|\*)\.js$/.exec(p);
  return m ? { name: m[1], exact: m[2] !== "*" } : null;
}

/**
 * problems with how the ceilings in `entries` (.size-limit.json) cover the JS `files` the build emitted, as lines.
 * Each file must be covered by exactly one ceiling; a `chunk:` ceiling must spell the chunk in its own name and path,
 * be gzip, and name a chunk that was emitted.
 */
export function coverageProblems(files, entries) {
  const out = [];
  const names = new Map();
  for (const f of files) {
    const n = chunkName(f);
    if (n === null) {
      out.push(`${f}: not a <name>-<hash>.js file, so no ceiling can name it`);
      continue;
    }
    if (names.has(n)) out.push(`two chunks are named "${n}" (${names.get(n)}, ${f}); size-limit would add them up under one ceiling, so give one a distinct name`);
    else names.set(n, f);
  }
  const covers = new Map([...names.keys()].map((n) => [n, []]));
  for (const e of entries) {
    // a total adds chunks up; it is no chunk's own ceiling (totalProblems checks it)
    if (TOTAL_NAMES.includes(e.name)) continue;
    const isChunk = e.name.startsWith(CHUNK_PREFIX);
    for (const p of [e.path].flat()) {
      if (!p.endsWith(".js")) continue;
      const pc = pathChunk(p);
      if (pc === null) {
        out.push(`"${e.name}": path "${p}" is not dist/assets/<name>-????????.js or dist/assets/<name>-*.js`);
        continue;
      }
      if (isChunk) {
        const expect = e.name.slice(CHUNK_PREFIX.length);
        if (!pc.exact || pc.name !== expect) out.push(`"${e.name}": its path must be "${chunkPath(expect)}" (it is "${p}")`);
        if (e.gzip !== true) out.push(`"${e.name}": must measure gzip (\`"gzip": true\`)`);
        if (!covers.has(pc.name)) out.push(`"${e.name}": the build emitted no "${pc.name}" chunk; drop the ceiling (node scripts/ui-chunk-budgets.mjs --write)`);
      }
      // a `-*` path also matches a longer chunk name that starts with "<name>-", which size-limit would add in
      const matched = pc.exact ? [pc.name] : [...covers.keys()].filter((n) => n === pc.name || n.startsWith(`${pc.name}-`));
      for (const n of matched) covers.get(n)?.push(e.name);
    }
  }
  for (const [n, by] of covers) {
    if (by.length === 0) out.push(`${names.get(n)}: no ceiling in apps/web/.size-limit.json; add one with node scripts/ui-chunk-budgets.mjs --write`);
    else if (by.length > 1) out.push(`${names.get(n)}: covered by ${by.length} ceilings (${by.join(", ")}); a chunk has exactly one`);
  }
  return out;
}

/**
 * `entries` with a `chunk:` ceiling added for each chunk in `sizes` (name -> gzip bytes) that no ceiling covers, and
 * `chunk:` ceilings for chunks not in `sizes` dropped. Existing ceilings keep their limit; the other entries keep their
 * place, and the `chunk:` ceilings follow them sorted by name.
 */
export function withChunkCeilings(entries, sizes, totals = {}) {
  const fixed = entries
    .filter((e) => !e.name.startsWith(CHUNK_PREFIX))
    .map((e) => (totals[e.name] ? { ...e, path: totalPaths(totals[e.name]) } : e));
  const covered = new Set();
  for (const e of fixed.filter((x) => !TOTAL_NAMES.includes(x.name))) {
    for (const p of [e.path].flat()) {
      const pc = p.endsWith(".js") ? pathChunk(p) : null;
      if (pc) for (const n of Object.keys(sizes)) if (n === pc.name || (!pc.exact && n.startsWith(`${pc.name}-`))) covered.add(n);
    }
  }
  const kept = new Map(entries.filter((e) => e.name.startsWith(CHUNK_PREFIX)).map((e) => [e.name.slice(CHUNK_PREFIX.length), e]));
  const chunks = Object.keys(sizes)
    .filter((n) => !covered.has(n))
    .sort()
    .map((n) => kept.get(n) ?? { name: `${CHUNK_PREFIX}${n}`, path: chunkPath(n), gzip: true, limit: ceilingFor(sizes[n]) });
  return [...fixed, ...chunks];
}

/** gzip bytes per chunk name, measured as @size-limit/file measures (zlib gzip, level 9) */
export function chunkSizes(dir) {
  const out = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    const n = chunkName(f);
    if (n !== null) out[n] = (out[n] ?? 0) + gzipSync(readFileSync(path.join(dir, f)), { level: 9 }).length;
  }
  return out;
}

function main(argv) {
  const [mode] = argv;
  if (mode !== "--check" && mode !== "--write") {
    console.error("usage: ui-chunk-budgets.mjs --check | --write   (after pnpm --filter @regulait/web build)");
    return 2;
  }
  if (!existsSync(ASSETS_DIR)) {
    console.error(`${path.relative(root, ASSETS_DIR)} is missing; build the web app first (pnpm --filter @regulait/web build)`);
    return 2;
  }
  const entries = JSON.parse(readFileSync(SIZE_LIMIT_FILE, "utf8"));
  if (!existsSync(MANIFEST_FILE)) {
    console.error(`${path.relative(root, MANIFEST_FILE)} is missing; build with Vite's manifest (pnpm --filter @regulait/web build --manifest)`);
    return 2;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
  const totals = {
    [FIRST_LOAD_NAME]: firstLoadFiles(manifest),
    [FIRST_PAINT_NAME]: firstPaintFiles(manifest, readFileSync(APP_FILE, "utf8")),
  };
  if (mode === "--write") {
    const next = withChunkCeilings(entries, chunkSizes(ASSETS_DIR), totals);
    writeFileSync(SIZE_LIMIT_FILE, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`apps/web/.size-limit.json: ${next.filter((e) => e.name.startsWith(CHUNK_PREFIX)).length} chunk ceilings`);
    return 0;
  }
  const files = readdirSync(ASSETS_DIR).filter((f) => f.endsWith(".js")).sort();
  const problems = [...coverageProblems(files, entries), ...TOTAL_NAMES.flatMap((n) => totalProblems(n, totals[n], entries))];
  for (const line of problems) console.log(`::error file=apps/web/.size-limit.json::${line}`);
  console.log(problems.length ? `${problems.length} bundle-ceiling coverage problems` : `every one of ${files.length} JS chunks has exactly one ceiling`);
  return problems.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err);
    process.exitCode = 2;
  }
}
