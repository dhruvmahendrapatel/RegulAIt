#!/usr/bin/env node
/**
 * THE SPA ROUTE CENSUS (ADR-0196) — every screen the web app routes to, read from apps/web/src/App.tsx.
 *
 * `preflight-ui-route-census.mjs` proves every GATEWAY route has a screen. This lists the SCREENS themselves, so the
 * enterprise UI harness (apps/web/e2e/enterprise) can visit every one: axe in both themes, the responsive pass, the
 * screenshot pack and the performance budgets all iterate this list, and a screen added to App.tsx is audited
 * without anyone remembering to add it.
 *
 * Rules: a `<Route path="/x">` is a screen; a relative path (the nested admin <Routes>) is `/admin/<path>`; a
 * catch-all (`*`) and a route whose element is a `<Navigate>` redirect are left out. A `:param` is filled with
 * PARAM_FIXTURE, an id the harness's mock API knows nothing about, so a detail page shows its not-found or error
 * state rather than invented data.
 *
 * Usage: node scripts/ui-spa-routes.mjs        # prints the list, one `path<TAB>url` per line
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const APP_FILE = path.join(root, "apps", "web", "src", "App.tsx");
export const PARAM_FIXTURE = "00000000-0000-4000-8000-000000000a11";
/** the nested admin <Routes> is the only place App.tsx uses relative paths */
const ADMIN_PREFIX = "/admin/";

/** `[{ path, url }]` in source order: `path` is the router pattern, `url` the one the harness opens (under /ui) */
export function spaRoutes(src = readFileSync(APP_FILE, "utf8")) {
  const out = [];
  const seen = new Set();
  const re = /<Route\s+path="([^"]{1,200})"([^>]{0,400})/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const [, raw, rest] = m;
    if (raw.includes("*")) continue;
    if (/element=\{\s*<Navigate\b/.test(rest)) continue;
    const routePath = raw.startsWith("/") ? raw : ADMIN_PREFIX + raw;
    if (seen.has(routePath)) throw new Error(`App.tsx routes ${routePath} twice`);
    seen.add(routePath);
    out.push({ path: routePath, url: routePath.replace(/:[A-Za-z]+/g, PARAM_FIXTURE) });
  }
  if (out.length === 0) throw new Error("no <Route path> found in App.tsx");
  return out;
}

/** the harness's file-safe name for a route ("/" is "root") */
export const routeSlug = (routePath) => (routePath === "/" ? "root" : routePath.slice(1).replace(/[^A-Za-z0-9]+/g, "_"));

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  for (const r of spaRoutes()) console.log(`${r.path}\t${r.url}`);
}
