#!/usr/bin/env node
/**
 * THE SPA ROUTE CENSUS (ADR-0196) — every screen the web app routes to, read from apps/web/src/App.tsx.
 *
 * `preflight-ui-route-census.mjs` proves every GATEWAY route has a screen. This lists the SCREENS themselves, so the
 * enterprise UI harness (apps/web/e2e/enterprise) can visit every one: axe in both themes, the responsive pass, the
 * screenshot pack and the performance budgets all iterate this list, and a screen added to App.tsx is audited
 * without anyone remembering to add it.
 *
 * App.tsx is parsed with the TypeScript compiler API (ADR-0176; the repo already depends on `typescript`), so the
 * attribute order and the way a path is written (`path="x"`, `path={"x"}`, `path={`x`}`) do not matter. A path that
 * is not a literal fails the census rather than dropping the route.
 *
 * Rules: a `<Route path>` is a screen; a relative path is resolved against the enclosing route (a `<Routes>` inside
 * `path="/admin/*"`'s element gives `/admin/<path>`); a catch-all (`*`) and a route whose element is a `<Navigate>`
 * redirect are left out; a pathless route is a layout. A screen under a layout whose element is one of
 * SIGNED_IN_LAYOUTS needs a session; any other screen is PUBLIC (`public: true`), and the harness opens it signed out.
 * A `:param` is filled with PARAM_FIXTURE, an id the harness's mock API knows nothing about, so a detail page shows
 * its not-found or error state rather than invented data.
 *
 * Usage: node scripts/ui-spa-routes.mjs        # prints the list, one `path<TAB>url<TAB>public|signed-in` per line
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const APP_FILE = path.join(root, "apps", "web", "src", "App.tsx");
export const PARAM_FIXTURE = "00000000-0000-4000-8000-000000000a11";
/** layout elements that redirect a signed-out visitor to /login */
export const SIGNED_IN_LAYOUTS = new Set(["Protected"]);

const tagName = (node) => (ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName).getText();
const isJsx = (node) => node && (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node));
const unwrap = (node) => (node && ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node);

/** the attributes of a JSX element as `{ name: initializer }` (`true` for a bare attribute) */
function attributes(node) {
  const attrs = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
  const out = {};
  for (const a of attrs.properties) {
    if (!ts.isJsxAttribute(a)) throw new Error(`App.tsx: a spread on <Route> at ${where(node)} hides its attributes`);
    out[a.name.getText()] = a.initializer ?? true;
  }
  return out;
}

const where = (node) => {
  const sf = node.getSourceFile();
  return `line ${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
};

/** a path attribute's literal text; anything computed fails the census */
function literalPath(init, node) {
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init)) {
    const e = unwrap(init.expression);
    if (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))) return e.text;
  }
  throw new Error(`App.tsx: <Route path> at ${where(node)} is not a literal; the census cannot read it`);
}

/** the JSX an `element={…}` attribute renders, or null */
function elementJsx(init) {
  if (!init || init === true || !ts.isJsxExpression(init)) return null;
  const e = unwrap(init.expression);
  return isJsx(e) ? e : null;
}

const join = (prefix, p) => (p.startsWith("/") ? p : `${prefix}${p}`);

/** `[{ path, url, public }]` in source order: `path` is the router pattern, `url` the one the harness opens (under /ui) */
export function spaRoutes(src = readFileSync(APP_FILE, "utf8")) {
  const sf = ts.createSourceFile("App.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = [];
  const seen = new Set();

  const visit = (node, ctx) => {
    if (!(isJsx(node) && tagName(node) === "Route")) {
      ts.forEachChild(node, (c) => visit(c, ctx));
      return;
    }
    const attrs = attributes(node);
    const element = elementJsx(attrs.element);
    const raw = attrs.path === undefined || attrs.path === true ? null : literalPath(attrs.path, node);
    const full = raw === null ? null : join(ctx.prefix, raw);
    const signedIn = ctx.signedIn || (element !== null && SIGNED_IN_LAYOUTS.has(tagName(element)));
    const redirect = element !== null && tagName(element) === "Navigate";

    if (attrs.index) throw new Error(`App.tsx: an index <Route> at ${where(node)} is not handled by the census yet`);
    if (full !== null && !full.includes("*") && !redirect) {
      if (seen.has(full)) throw new Error(`App.tsx routes ${full} twice`);
      seen.add(full);
      out.push({ path: full, url: full.replace(/:[A-Za-z]+/g, PARAM_FIXTURE), public: !signedIn });
    }
    // descendant <Routes> inside the element resolve against this route's path without its trailing `*`
    const base = full === null ? ctx.prefix : `${full.replace(/\/?\*$/, "").replace(/\/$/, "")}/`;
    if (element) visit(element, { prefix: base, signedIn });
    if (ts.isJsxElement(node)) for (const child of node.children) visit(child, { prefix: base, signedIn });
  };
  visit(sf, { prefix: "/", signedIn: false });

  if (out.length === 0) throw new Error("no <Route path> found in App.tsx");
  return out;
}

/** the harness's file-safe name for a route ("/" is "root") */
export const routeSlug = (routePath) => (routePath === "/" ? "root" : routePath.slice(1).replace(/[^A-Za-z0-9]+/g, "_"));

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  for (const r of spaRoutes()) console.log(`${r.path}\t${r.url}\t${r.public ? "public" : "signed-in"}`);
}
