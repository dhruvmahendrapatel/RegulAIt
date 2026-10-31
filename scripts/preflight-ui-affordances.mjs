#!/usr/bin/env node
/**
 * AFFORDANCE PARITY — every destructive endpoint the gateway serves should be
 * reachable from a screen, or be on this file's list with a reason.
 *
 * WHY THIS EXISTS. An audit found twelve `DELETE` routes that no view could
 * reach. Four were the grant types — so for a per-user access-control product,
 * an admin could hand out access from the UI and only take it back with a
 * database client. Nothing was broken: the endpoints worked, and
 * `GET /v1/users/:id/agents` had been returning `grantId` the whole time. The
 * button was simply never built, and nothing noticed, because "create" and
 * "delete" are written months apart and only one of them has a happy path
 * somebody demos.
 *
 * That is the shape of the complaint that a product "looks vibe-coded": not a
 * bug, but a surface where the easy half shipped and the hard half did not,
 * with no mechanism that would ever say so. This is that mechanism.
 *
 * WHAT IT IS NOT. It does not check that the button WORKS — only that some
 * view calls the route. A control that opens a confirm dialog and deletes
 * nothing passes this and fails its e2e spec, which is the right division of
 * labour: this is a census, not a test.
 *
 * Exit 0 clean, 1 when an endpoint is unreachable and unlisted, 2 if it could
 * not run at all. Any non-zero fails CI.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Endpoints with NO UI affordance, on purpose. Each needs a reason a reader can
 * check — "not needed" is not a reason. Deleting an entry is how you say "this
 * should have a button now"; adding one is a decision, so it should be a diff
 * somebody reviews.
 */
export const DELIBERATELY_API_ONLY = new Map([
  // (none today). A DELETE that is still a 501 `notBuilt` stub needs no entry:
  // a stub deletes nothing, so the census skips it until it becomes a real
  // handler, and an entry for one is reported stale (see staleExemptions).
]);

export const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (e === "node_modules" || e === "dist" || e === ".git") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
};

/** `/v1/grants/agents/:grantId` and `/v1/grants/agents/${id}` both -> `/v1/grants/agents/:x` */
export const norm = (p) =>
  "/" +
  p
    .replace(/\$\{[^}]*\}/g, ":x")
    .replace(/:[A-Za-z0-9_]+/g, ":x")
    .replace(/^\/+|\/+$/g, "");

/**
 * The web app's API client objects, by the identifier a call site uses. A call
 * through any other object is not counted, so a Map's `.get("/v1/…")` or some
 * unrelated `.del` is never mistaken for a button.
 *
 *   api        apps/web/src/api/client.ts, the shared client (most views)
 *   stepUpApi  apps/web/src/stepup/stepUp.ts `api`, imported under this alias:
 *              the step-up client every relaxing or owner-changing write uses
 *   sharedApi  the shared client under the alias stepUp.ts gives it
 *   deps       views/approvals/signedDecision.ts: the approval-decision seam,
 *              whose default is stepUpApi.post (the injection exists for tests)
 *
 * A new client object (or a new alias for one) belongs on this list; the
 * census test pins it. Missing one makes the census OVERSTATE the gap.
 */
export const API_CLIENTS = ["api", "stepUpApi", "sharedApi", "deps"];

/** the method names each verb is written as on those clients (`…WithHeaders` is the same verb) */
const VERB_FORMS = { del: ["del", "delete"], get: ["get", "getBlob"], post: ["post"], put: ["put"], patch: ["patch"] };

/** the verbs, in the census's spelling (`del` for DELETE) */
export const VERBS = Object.freeze(Object.keys(VERB_FORMS));

const METHOD_VERB = new Map();
for (const [verb, names] of Object.entries(VERB_FORMS)) for (const n of names) METHOD_VERB.set(n, verb);

/**
 * The call shapes besides the client objects, each a request the browser makes:
 *
 *   fetch(path, …)            a raw fetch: the verb is its `method:` (GET when absent)
 *   window.open(path, …)      a link opened in a new tab (GET)
 *   x.open("VERB", path)      an XMLHttpRequest (the model-artifact upload, for progress)
 *   href={path} / href="…"    an anchor the user clicks (GET)
 *
 * A HELPER that forwards its own parameter to any of these or to a client
 * (`downloadCsv(path, …)`, `ssePost(path, …)`, a page's `deleteWithBody`) is
 * not listed: it is inferred (see `wrappers`), so a new one needs no entry.
 */
export const UI_SINKS = Object.freeze(["fetch", "window.open", "xhr.open", "href="]);

/** the path prefixes a web call can name (the gateway's browser-facing API surfaces; `/supplier/` is the ADR-0221 portal) */
const PATH_PREFIXES = ["/v1/", "/auth/", "/supplier/"];

/*
 * THE PARSER. Web sources are read with the TypeScript compiler API (already a
 * dependency; `preflight-egress-allow-cleanup.mjs` does the same), not by hand:
 * comments, strings, generics, JSX and argument lists are the parser's problem,
 * so the rules below are only about what a route call IS.
 */
const parsed = new Map();
/** the parsed source file (cached: the census reads every file several times) */
export function parse(src, fileName = "ui.tsx") {
  const key = `${fileName}\0${src}`;
  let sf = parsed.get(key);
  if (!sf) {
    const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, kind);
    parsed.set(key, sf);
  }
  return sf;
}

/** a web source as `{ src, fileName }` (a bare string is a .tsx snippet, as tests write them) */
const asSource = (s) => (typeof s === "string" ? { src: s, fileName: "ui.tsx" } : s);

/** strip the wrappers that do not change a value: `(x)`, `x as T`, `x!`, `x satisfies T`, `<T>x` */
function unwrap(e) {
  let n = e;
  while (
    n &&
    (ts.isParenthesizedExpression(n) ||
      ts.isAsExpression(n) ||
      ts.isNonNullExpression(n) ||
      ts.isTypeAssertionExpression(n) ||
      (ts.isSatisfiesExpression && ts.isSatisfiesExpression(n)))
  ) {
    n = n.expression;
  }
  return n;
}

/** visit every node under `node` (depth-first) */
function walkNodes(node, fn) {
  const visit = (n) => {
    fn(n);
    ts.forEachChild(n, visit);
  };
  visit(node);
}

const isStringy = (n) => n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));

/** an HTTP verb named by a string literal node (`"POST"`), in the census's spelling, or "" */
function verbNamed(node) {
  const n = unwrap(node);
  if (!isStringy(n)) return "";
  const v = n.text.toLowerCase();
  if (v === "delete") return "del";
  return VERB_FORMS[v] ? v : "";
}

/**
 * Every request a source file makes, as `{ verb, node }`: `node` is the ONE
 * argument that carries the path (the first, for a client call; the second,
 * for `xhr.open`; the attribute value, for `href`). Only that argument is
 * read, so a body (`api.post("/v1/a", { next: "/v1/b" })`) is never mistaken
 * for the path. `wrapperArgs` maps an inferred wrapper's name to the
 * `"verb:argIndex"`s it forwards (see `wrappers`).
 */
export function callSites(sf, wrapperArgs = new Map()) {
  const out = [];
  const push = (verb, node) => {
    if (node) out.push({ verb, node });
  };
  walkNodes(sf, (n) => {
    if (ts.isJsxAttribute(n) && n.name.getText(sf) === "href" && n.initializer) {
      push("get", ts.isJsxExpression(n.initializer) ? n.initializer.expression : n.initializer);
      return;
    }
    if (!ts.isCallExpression(n)) return;
    const callee = unwrap(n.expression);
    const args = n.arguments;
    if (ts.isPropertyAccessExpression(callee)) {
      const obj = unwrap(callee.expression);
      let method = callee.name.text;
      if (ts.isIdentifier(obj) && API_CLIENTS.includes(obj.text)) {
        if (method.endsWith("WithHeaders")) method = method.slice(0, -"WithHeaders".length);
        const verb = METHOD_VERB.get(method);
        if (verb) push(verb, args[0]);
      } else if (method === "open" && ts.isIdentifier(obj) && obj.text === "window") {
        push("get", args[0]);
      } else if (method === "open" && args.length >= 2) {
        // `xhr.open("POST", path)`: an XMLHttpRequest (an upload with progress)
        const verb = verbNamed(args[0]);
        if (verb) push(verb, args[1]);
      }
      return;
    }
    if (!ts.isIdentifier(callee)) return;
    if (callee.text === "fetch") {
      const opts = args[1] ? unwrap(args[1]) : undefined;
      let verb = "get";
      if (opts && ts.isObjectLiteralExpression(opts)) {
        for (const p of opts.properties) {
          const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : "";
          if (name !== "method") continue;
          // a `method` that is a variable (the client's own `request(method, path)`) names no verb here
          verb = ts.isPropertyAssignment(p) ? verbNamed(p.initializer) : "";
        }
      } else if (opts) verb = "";
      if (verb) push(verb, args[0]);
      return;
    }
    for (const va of wrapperArgs.get(callee.text) ?? []) {
      const [verb, arg] = va.split(":");
      push(verb, args[Number(arg)]);
    }
  });
  return out;
}

/** a string or template literal node as parts: `{ lit }` text and `{ expr }` template expressions */
export function literalParts(node, sf) {
  if (isStringy(node)) return [{ lit: node.text }];
  if (!ts.isTemplateExpression(node)) return null;
  const parts = [];
  if (node.head.text) parts.push({ lit: node.head.text });
  for (const span of node.templateSpans) {
    parts.push({ expr: span.expression.getText(sf).trim() });
    if (span.literal.text) parts.push({ lit: span.literal.text });
  }
  return parts;
}

/**
 * The route path(s) a literal's parts name, before normalization, or [] when
 * it names none. The rules, each one a shape the SPA really writes:
 *
 *   `/v1/x/${id}/y`              a whole-segment expression is a parameter
 *   `/v1/x/${kind}`              ...kept as `${kind}` so a literal union expands
 *   "/v1/x?limit=5"              a query string is not part of the route
 *   `/v1/x${qs}`                 an expression glued to the END of a segment is
 *   `/v1/x${a ? `?b=${a}` : ""}` the query string (it is never a path segment)
 *   `${subjectPath(s)}/drift`    a leading call to a path builder (resolve)
 *
 * `resolve(name)` answers the paths a path-builder identifier names.
 */
export function literalPaths(parts, resolve = () => []) {
  if (!parts || parts.length === 0) return [];
  let bases = [""];
  let k = 0;
  if (parts[0].expr !== undefined) {
    const m = /^[A-Za-z_$][\w$]{0,80}/.exec(parts[0].expr);
    bases = m ? resolve(m[0]) : [];
    if (bases.length === 0) return [];
    k = 1;
  } else if (!PATH_PREFIXES.some((pre) => parts[0].lit.startsWith(pre))) return [];
  let tail = "";
  for (; k < parts.length; k += 1) {
    const part = parts[k];
    if (part.lit !== undefined) {
      const stop = [part.lit.indexOf("?"), part.lit.indexOf("#")].filter((n) => n !== -1);
      if (stop.length > 0) {
        tail += part.lit.slice(0, Math.min(...stop));
        break;
      }
      tail += part.lit;
      continue;
    }
    const prev = (bases[0] + tail).slice(-1);
    const next = parts[k + 1];
    const glued = prev !== "/";
    const last = next === undefined || (next.lit !== undefined && /^[?&#]/.test(next.lit));
    if (glued && last) break; // a query-string suffix
    tail += /^[A-Za-z_$][\w$]*$/.test(part.expr) ? `\${${part.expr}}` : ":x";
  }
  return bases.map((b) => b + tail);
}

/** is this identifier a reference (not a property name, a declaration name, or a type)? */
function isReference(id) {
  const p = id.parent;
  if (!p) return true;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)) && p.name === id) return false;
  if ((ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isParameter(p)) && p.name === id) return false;
  if (ts.isTypeReferenceNode(p) || ts.isJsxAttribute(p)) return false;
  return true;
}

/**
 * Every path the argument `node` names: its path literals, and every
 * path-builder identifier in it, resolved (`api.get(runGraphPath(s))`,
 * `api.put(REQUIRED_TESTS_PATH, …)`, `api.post(path, …)` after a local
 * `const path = …`).
 */
function harvest(node, sf, resolve) {
  const out = [];
  const visit = (n) => {
    const parts = literalParts(n, sf);
    if (parts) {
      // a literal is read whole: an identifier inside `${…}` is a parameter, not a builder
      out.push(...literalPaths(parts, resolve));
      return;
    }
    if (ts.isIdentifier(n) && isReference(n)) out.push(...resolve(n.text));
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

const isFunctionLike = (n) => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n);

/** the value nodes a function body returns (not descending into nested functions) */
function returnedValues(body) {
  if (!ts.isBlock(body)) return valueNodes(body);
  const out = [];
  const visit = (n) => {
    if (isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) out.push(...valueNodes(n.expression));
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(body, visit);
  return out;
}

/**
 * The nodes an expression's VALUE can be: literals and identifiers, through
 * ternaries, `??`/`||`, functions' returns, and a call's callee or function
 * arguments (`useMemo(() => seriesPath(p), …)`). A literal passed as a plain
 * argument is not a value, so `useQuery({ queryFn: () => api.get("/v1/x") })`
 * is not a path builder.
 */
function valueNodes(expr) {
  const e = unwrap(expr);
  if (!e) return [];
  if (literalParts(e) || ts.isIdentifier(e)) return [e];
  if (ts.isConditionalExpression(e)) return [...valueNodes(e.whenTrue), ...valueNodes(e.whenFalse)];
  if (ts.isBinaryExpression(e) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(e.operatorToken.kind)) {
    return [...valueNodes(e.left), ...valueNodes(e.right)];
  }
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return returnedValues(e.body);
  if (ts.isCallExpression(e)) {
    const callee = unwrap(e.expression);
    const out = ts.isIdentifier(callee) ? [callee] : [];
    for (const a of e.arguments) if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) out.push(...returnedValues(a.body));
    return out;
  }
  return [];
}

const isExported = (n) => (ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export) !== 0;

/**
 * Every named definition in a file: `{ name, at, top, node, params, values }`.
 * `top` means module-level AND exported (only those are visible from another
 * file); `params` are a function's simple parameter names; `values` are the
 * nodes its value (or return value) can be.
 */
export function definitions(sf) {
  const out = [];
  walkNodes(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const stmt = n.parent?.parent;
      const top = !!stmt && ts.isVariableStatement(stmt) && stmt.parent === sf && isExported(stmt);
      const init = unwrap(n.initializer);
      const fn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : null;
      out.push({ name: n.name.text, at: n.getStart(sf), top, node: n, params: fn ? paramNames(fn) : [], values: valueNodes(n.initializer) });
    } else if (ts.isFunctionDeclaration(n) && n.name && n.body) {
      const top = n.parent === sf && isExported(n);
      out.push({ name: n.name.text, at: n.getStart(sf), top, node: n, params: paramNames(n), values: returnedValues(n.body) });
    }
  });
  return out;
}

const paramNames = (fn) => fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : null));

/**
 * PATH BUILDERS: a definition whose value is a route path —
 *
 *   export const REQUIRED_TESTS_PATH = "/v1/governance/review-policy/required-tests";
 *   export const draftPath = (scope) => `/v1/use-cases/draft?scope=${scope}`;
 *   export function runGraphPath(s) { switch (s.kind) { case "x": return `/v1/run-graph/…`; } }
 *   const path = `${subjectPath(subject)}/snapshots`;     (a local, then api.post(path, …))
 *
 * Returns `{ name, at, top, paths }` per definition with at least one path.
 */
export function pathDefs(sf, resolve = () => []) {
  const out = [];
  for (const d of definitions(sf)) {
    const paths = [];
    for (const v of d.values) {
      const parts = literalParts(v, sf);
      if (parts) paths.push(...literalPaths(parts, resolve));
      else if (ts.isIdentifier(v) && v.text !== d.name) paths.push(...resolve(v.text));
    }
    if (paths.length > 0) out.push({ name: d.name, at: d.at, top: d.top, paths: [...new Set(paths)] });
  }
  return out;
}

/**
 * WRAPPERS: a function that sends a request to a path its CALLER gives it,
 *
 *   async function deleteWithBody(path: string, body: unknown) { await fetch(path, { method: "DELETE", … }) }
 *   export async function downloadCsv(path: string, …) { … fetch(path, { credentials: "include" }) … }
 *
 * is a call site for that verb wherever it is called, reading the argument in
 * that parameter's position. Inferred, not listed: a request in the body whose
 * WHOLE path argument is one of the function's own parameters (`api.get(props.url)`
 * is not). Returns name -> Set("verb:argIndex"); `topOnly` keeps exported
 * module-level ones.
 */
export function wrappers(sf, known = new Map(), topOnly = false) {
  const out = new Map();
  const sites = callSites(sf, known);
  for (const d of definitions(sf)) {
    if (d.params.length === 0 || (topOnly && !d.top)) continue;
    for (const { verb, node } of sites) {
      if (node.pos < d.node.pos || node.end > d.node.end) continue;
      const arg = unwrap(node);
      if (!ts.isIdentifier(arg)) continue;
      const index = d.params.indexOf(arg.text);
      if (index === -1) continue;
      if (!out.has(d.name)) out.set(d.name, new Set());
      out.get(d.name).add(`${verb}:${index}`);
    }
  }
  return out;
}

/**
 * The resolver a file's calls use: the nearest definition of the name BEFORE
 * the use in the same file (else the nearest after it: a hoisted function),
 * else every exported module-level definition of it in any web file
 * (`globalDefs`: name -> paths).
 */
export function resolverFor(sf, globalDefs = new Map()) {
  const local = pathDefs(sf, (name) => globalDefs.get(name) ?? []);
  return (name, at = Infinity) => {
    let before = null;
    let after = null;
    for (const d of local) {
      if (d.name !== name) continue;
      if (d.at < at && (!before || d.at > before.at)) before = d;
      if (d.at >= at && (!after || d.at < after.at)) after = d;
    }
    const best = before ?? after;
    return best ? best.paths : (globalDefs.get(name) ?? []);
  };
}

/**
 * Exported path builders across every web file, name -> paths. Two passes so
 * a builder that composes another (`${subjectPath(s)}/snapshots`) resolves.
 */
export function globalPathDefs(sources) {
  const files = sources.map(asSource);
  let defs = new Map();
  for (let pass = 0; pass < 2; pass += 1) {
    const next = new Map();
    for (const { src, fileName } of files) {
      for (const d of pathDefs(parse(src, fileName), (name) => defs.get(name) ?? [])) {
        if (!d.top) continue;
        next.set(d.name, [...new Set([...(next.get(d.name) ?? []), ...d.paths])]);
      }
    }
    defs = next;
  }
  return defs;
}

/** add `more` (name -> Set("verb:arg")) into `into`; answers `into` */
function mergeWrappers(into, more) {
  for (const [name, verbs] of more) {
    if (!into.has(name)) into.set(name, new Set());
    for (const v of verbs) into.get(name).add(v);
  }
  return into;
}

/** exported module-level wrappers across every web file (three passes: a wrapper of a wrapper resolves) */
export function globalWrappers(sources) {
  const files = sources.map(asSource);
  const known = new Map();
  for (let pass = 0; pass < 3; pass += 1) {
    for (const { src, fileName } of files) mergeWrappers(known, wrappers(parse(src, fileName), known, true));
  }
  return known;
}

/**
 * Every path a web source file calls, by verb: `{ get, post, put, patch, del }`
 * of normalized-path Sets. In the path argument of each call it harvests every
 * path literal, and every path-builder identifier (resolved).
 */
export function uiCalls(src, globalDefs = new Map(), globalWrap = new Map(), fileName = "ui.tsx") {
  const sf = parse(src, fileName);
  const out = Object.fromEntries(VERBS.map((v) => [v, new Set()]));
  const resolveAt = resolverFor(sf, globalDefs);
  const known = mergeWrappers(new Map(globalWrap), wrappers(sf, globalWrap));
  mergeWrappers(known, wrappers(sf, known));
  for (const { verb, node } of callSites(sf, known)) {
    const at = node.getStart(sf);
    for (const p of harvest(node, sf, (name) => resolveAt(name, at))) {
      for (const q of expandLiteralUnions(p, src)) out[verb].add(norm(q));
    }
  }
  return out;
}

/** every path a web source file calls with `verb` through a known client or helper, normalized */
export function uiCallPaths(src, verb, globalDefs = new Map(), globalWrap = new Map()) {
  if (!VERB_FORMS[verb]) throw new Error(`uiCallPaths: unknown verb ${verb}`);
  return uiCalls(src, globalDefs, globalWrap)[verb];
}

/** every route path written as a literal anywhere in a file (any verb, called or not), normalized */
export function literalPathsIn(src, fileName = "ui.tsx") {
  const sf = parse(src, fileName);
  const out = new Set();
  walkNodes(sf, (n) => {
    for (const p of literalPaths(literalParts(n, sf))) for (const q of expandLiteralUnions(p, src)) out.add(norm(q));
  });
  return out;
}

/**
 * The string-literal union a file declares for `name` (`kind: "servers" | "connectors"`),
 * or null. Parsed by hand, not by a regex over the file (M-074: linear, no backtracking).
 */
export function literalUnionOf(name, src) {
  for (let at = src.indexOf(name); at !== -1; at = src.indexOf(name, at + name.length)) {
    const before = src[at - 1];
    if (before !== undefined && /[\w$.]/.test(before)) continue;
    let i = at + name.length;
    while (src[i] === " ") i += 1;
    if (src[i] !== ":") continue;
    i += 1;
    const values = [];
    for (;;) {
      while (src[i] === " ") i += 1;
      if (src[i] !== '"') break;
      const end = src.indexOf('"', i + 1);
      if (end === -1) break;
      values.push(src.slice(i + 1, end));
      i = end + 1;
      while (src[i] === " ") i += 1;
      if (src[i] !== "|") break;
      i += 1;
    }
    if (values.length > 1 && values.every((v) => /^[a-z0-9-]+$/.test(v))) return values;
  }
  return null;
}

/**
 * `/v1/${kind}/${id}/owner` where the file types `kind` as `"servers" | "connectors"`
 * is one call to each of `/v1/servers/${id}/owner` and `/v1/connectors/${id}/owner`.
 * Without the expansion the template collapses to `/v1/:x/:x/owner`, which would
 * either reach every `…/owner` route (over-count) or none (cry wolf).
 */
export function expandLiteralUnions(p, src) {
  let out = [p];
  for (const m of p.matchAll(/\$\{([A-Za-z_$][\w$]*)\}/g)) {
    const values = literalUnionOf(m[1], src);
    if (!values) continue;
    out = out.flatMap((q) => values.map((v) => q.split(m[0]).join(v)));
    if (out.length > 32) return [p];
  }
  return out;
}

/**
 * Routes the gateway registers but answers 501 `not_built` (the ADR-0188 S1
 * stubs: `app.post("/v1/…", notBuilt)`), as `"POST /v1/x/:x"`. The same regex
 * as the web drift test (`workloadIdentityModel.test.ts`). A stub creates
 * nothing, so a UI that lists the collection but cannot yet add to it is not
 * an add gap: the screen shows that control disabled with the reason, and the
 * gap reappears here the moment the stub is replaced by a real handler.
 */
export function notBuiltRoutes(src) {
  const out = new Set();
  // ONLY a handler this file defines as a 501 responder counts: a `notBuilt`
  // imported from elsewhere, or one that came to answer 200, is a real route
  // and must be reachable like any other
  if (!fiveOhOneResponders(src).has("notBuilt")) return out;
  for (const m of src.matchAll(/app\.(get|post|put|patch|delete)\(\s*"([^"]+)",\s*notBuilt\)/g)) {
    out.add(`${m[1].toUpperCase()} ${norm(m[2])}`);
  }
  return out;
}

/** names a file declares as a one-line handler that replies 501 (`const notBuilt = async (_req, reply) => reply.status(501)…`) */
export function fiveOhOneResponders(src) {
  const out = new Set();
  for (const line of src.split("\n")) {
    const m = /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*async\s*\(/.exec(line);
    if (m && line.includes("=>") && line.includes("reply.status(501)")) out.add(m[1]);
  }
  return out;
}

/**
 * Segment-wise match with `:x` as a wildcard on either side, EXCEPT the
 * collection segment (the one after `/v1`): a call that templates the
 * collection itself (`/v1/${kind}/…`, when `kind` has no declared literal
 * union to expand) could name any resource, so it is not evidence of reaching
 * a particular one.
 */
export const segmentMatch = (route, set) => {
  if (set.has(route)) return true;
  const want = route.split("/");
  for (const u of set) {
    const got = u.split("/");
    if (got.length !== want.length) continue;
    if (got[2] !== want[2]) continue;
    if (got.every((seg, i) => seg === want[i] || seg === ":x" || want[i] === ":x")) return true;
  }
  return false;
};

/**
 * Collections the UI lists (a GET it calls) and cannot add to (a POST it never
 * calls), skipping POSTs that are still `notBuilt` stubs.
 */
export function findAddGaps({ posted, gotten, uiPost, uiGet, notBuilt = new Set() }) {
  return [...posted]
    .filter((p) => !notBuilt.has(`POST ${p}`) && !segmentMatch(p, uiPost) && gotten.has(p) && segmentMatch(p, uiGet))
    .sort();
}

/** every path the web SPA under `webDir` calls, by verb (path builders resolved across files) */
export function scanWeb(webDir) {
  const sources = walk(webDir).map((f) => ({ src: readFileSync(f, "utf8"), fileName: f }));
  const defs = globalPathDefs(sources);
  const wrap = globalWrappers(sources);
  const out = Object.fromEntries(VERBS.map((v) => [v, new Set()]));
  for (const { src, fileName } of sources) {
    const calls = uiCalls(src, defs, wrap, fileName);
    for (const v of VERBS) for (const p of calls[v]) out[v].add(p);
  }
  return out;
}

/** every `notBuilt` 501 stub the gateway under `gatewayDir` registers, as `"VERB /normalized"` */
export function scanNotBuilt(gatewayDir) {
  const out = new Set();
  for (const f of walk(gatewayDir)) for (const r of notBuiltRoutes(readFileSync(f, "utf8"))) out.add(r);
  return out;
}

function main() {
  const gatewaySrc = path.join(root, "apps/gateway/src");
  const webSrc = path.join(root, "apps/web/src");

  const served = new Set();
  for (const f of walk(gatewaySrc)) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/app\.delete\(\s*"([^"]+)"/g)) served.add(norm(m[1]));
  }

  // EVERY SHAPE THE CALL IS ACTUALLY WRITTEN IN, which took four tries.
  //
  //   api.del(`/v1/x/${id}`)                 the easy one
  //   api.del<Thing>(`/v1/x/${id}`)          type parameter before the paren
  //   api.del(cond ? `/v1/a/..` : `/v1/b/..`) path chosen inside the call
  //   api.delWithHeaders(`/v1/x/${id}`, h)   the same DELETE with request headers
  //                                          (the intake draft's owner precondition)
  //   stepUpApi.del(`/v1/x/${id}`, b, h)     a different client object (API_CLIENTS)
  //
  // The first two misses each made this census OVERSTATE the gap, which is the
  // more dangerous direction: a report that cries wolf is switched off, and
  // then it is not a report. So rather than expecting a literal to sit
  // immediately after the paren, read the call's whole path ARGUMENT and
  // harvest every /v1 path literal inside it (only that argument: a body or
  // the next statement is not the path; see callSites).
  //
  // Later shapes (path builders, inferred download/delete helpers, nested
  // generics, a query string built in an expression) are described at
  // uiCalls, wrappers and literalPaths; the route census shares this matcher.
  const ui = scanWeb(webSrc);
  const reached = ui.del;

  // A helper may build one segment from a variable the literal shows as a
  // parameter, so compare segment-wise with `:x` as a wildcard on either side
  // (but never for the collection segment; see segmentMatch).
  const reachedPaths = reached;
  const isReached = (route) => segmentMatch(route, reachedPaths);

  // ---- the ADD side ------------------------------------------------------
  //
  // "73 POST routes are unreached" is a true number and a useless one: most are
  // ACTIONS (/prune, /sweep, /abort, /remediate), not add buttons, and a census
  // that counts them reads as noise and gets ignored. The precise question is
  // narrower and checkable: IS THERE A COLLECTION THE UI LISTS AND CANNOT ADD
  // TO? That is what "the add button is missing" actually means, and it is
  // three, not seventy-three.
  const posted = new Set();
  for (const f of walk(gatewaySrc)) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/app\.post\(\s*"([^"]+)"/g)) posted.add(norm(m[1]));
  }
  const gotten = new Set();
  for (const f of walk(gatewaySrc)) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/app\.get\(\s*"([^"]+)"/g)) gotten.add(norm(m[1]));
  }
  const uiPost = ui.post;
  const uiGet = ui.get;
  const notBuilt = scanNotBuilt(gatewaySrc);
  const addGaps = findAddGaps({ posted, gotten, uiPost, uiGet, notBuilt });
  if (served.size === 0) {
    console.error("preflight-ui-affordances: found no DELETE routes — the scan is broken, not the app");
    return 2;
  }

  // a DELETE that is still a 501 stub deletes nothing: skipped, like the add side
  const orphans = [...served].filter((r) => !notBuilt.has(`DELETE ${r}`) && !isReached(r) && !DELIBERATELY_API_ONLY.has(r)).sort();
  const staleExemptions = [...DELIBERATELY_API_ONLY.keys()]
    .filter((r) => !served.has(r) || notBuilt.has(`DELETE ${r}`))
    .sort();

  const stubs = [...served].filter((r) => notBuilt.has(`DELETE ${r}`)).length;
  console.log(
    `affordance parity: ${served.size} DELETE routes, ` +
      `${served.size - orphans.length - DELIBERATELY_API_ONLY.size - stubs} reachable, ` +
      `${stubs} still 501 stubs, ${DELIBERATELY_API_ONLY.size} exempt, ${orphans.length} orphaned`,
  );

  for (const r of staleExemptions) {
    const why = served.has(r) ? "it is a 501 notBuilt stub, which the census already skips" : "the gateway no longer serves it";
    console.error(`  STALE EXEMPTION  ${r} — listed as API-only but ${why}`);
  }
  for (const r of orphans) {
    console.error(`  NO UI AFFORDANCE  ${r}`);
  }
  if (addGaps.length > 0) {
    console.log("");
    console.log(`listed by the UI but not addable from it: ${addGaps.length}`);
    for (const r of addGaps) console.error(`  NO ADD AFFORDANCE  ${r}`);
    console.error(
      "\nEach route above creates something the UI already SHOWS — the list is\n" +
        "there and the way to add to it is not. Build the form, or say here why\n" +
        "the collection is populated some other way.",
    );
  }

  if (orphans.length > 0) {
    console.error(
      "\nEach route above can delete a governed object that no screen can delete.\n" +
        "Add the control (adminKit's <RemoveButton/>), or add the route to\n" +
        "DELIBERATELY_API_ONLY in this file with a reason somebody can check.",
    );
  }
  return orphans.length > 0 || staleExemptions.length > 0 || addGaps.length > 0 ? 1 : 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    process.exit(main());
  } catch (e) {
    console.error("preflight-ui-affordances could not run:", e);
    process.exit(2);
  }
}
