#!/usr/bin/env node
/**
 * PRODUCTION BUILDS ONLY — the built SPA ships no library's development build.
 *
 * Libraries that ship a development and a production build pick one in two ways:
 *   - React and most others branch on `process.env.NODE_ENV`, which `vite build` replaces with "production";
 *   - the routing library names only its development build in its package exports, so `vite build` would ship it
 *     unless apps/web/vite.config.ts swaps the folder (`routerProductionBuild`).
 * Either can regress silently: a config change, a library upgrade or a build run with NODE_ENV=development. This
 * scans every JS file in apps/web/dist/assets for text that only a development build contains.
 *
 * Run after `pnpm --filter @regulait/web build`. Exit 0 clean, 1 when a development build is found, 2 if it could
 * not run (no build).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** text each library's development build leaves in a bundle and its production build does not (pinned by the test) */
export const DEV_ONLY_MARKERS = [
  // the routing library: warnings behind its ENABLE_DEV_WARNINGS switch
  { library: "routing library", text: "No routes matched location" },
  // React and React DOM: development-only warnings
  { library: "React", text: "Download the React DevTools" },
  { library: "React", text: 'Each child in a list should have a unique "key" prop' },
];

/** the markers found in one file's text */
export const devMarkersIn = (source) => DEV_ONLY_MARKERS.filter((m) => source.includes(m.text));

/** every [file, marker] pair found under a dist/assets folder */
export function scanAssets(assetsDir) {
  const found = [];
  for (const name of readdirSync(assetsDir).sort()) {
    if (!name.endsWith(".js")) continue;
    for (const m of devMarkersIn(readFileSync(path.join(assetsDir, name), "utf8"))) found.push({ file: name, ...m });
  }
  return found;
}

function main() {
  const assets = path.join(root, "apps/web/dist/assets");
  let found;
  try {
    found = scanAssets(assets);
  } catch (e) {
    console.error(`preflight-ui-prod-bundle: cannot read ${assets} (${e.code ?? e.message}); build apps/web first`);
    return 2;
  }
  if (found.length === 0) {
    console.log("preflight-ui-prod-bundle: no development build in apps/web/dist/assets");
    return 0;
  }
  for (const f of found) console.error(`  ${f.file}: ${f.library} development build ("${f.text}")`);
  console.error(`preflight-ui-prod-bundle: ${found.length} development-only marker(s) in the production build`);
  return 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) process.exit(main());
