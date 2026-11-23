#!/usr/bin/env node
/**
 * STEP-UP CALL GUARD — every web call to a gateway route whose handler can demand
 * step-up must go through `withStepUp` (or `putOrgSettings`, which wraps it), or be
 * on this file's allow-list with a reason.
 *
 * WHY THIS EXISTS (Codex review ADM-001 / INT-001, R3 on #1205). The server refuses a
 * protected write with 403 `step_up_required`. A call through the plain client is
 * refused and stays refused: the shared client's step-up event carries no `retry`, so
 * the global listener cannot open the "Confirm it's you" dialog, and the admin is left
 * at an error with no way through. A grep found twelve such sites, and a reviewer
 * found a thirteenth (the ABAC "Activate" button) the same way. This is that grep,
 * written down, so the fourteenth fails CI instead of a demo.
 *
 * WHAT IT READS.
 *  - Gateway: every `app.<verb>("/path", …, handler)` whose handler calls
 *    `requireStepUp`, `requireStepUps` or `checkStepUp`, directly or through a helper
 *    function in the same file that does (a fixed point over that file's functions).
 *  - Web: every request a view makes through a known client (see
 *    preflight-ui-affordances.mjs `callSites`), and whether it sits lexically inside a
 *    `withStepUp(…)` or `putOrgSettings(…)` call.
 *
 * KNOWN LIMITS. A route registered with a template-literal or variable path, a
 * step-up demanded only by a helper in ANOTHER file, and a web call whose path is
 * built by a helper (not a literal at the call) are not seen. Each makes the guard
 * miss a site, never invent one.
 *
 * BODY-CONDITIONAL ROUTES. Some handlers demand step-up only for some bodies. A web
 * call that never sends such a body may stay plain; it is listed in ALLOWED below,
 * keyed by route AND file (so the same route called from a new file is checked
 * again), with the condition and why the call cannot meet it. Removing an entry is how you
 * say "this call can now trigger step-up"; adding one is a decision for review.
 *
 * Exit 0 clean, 1 on an unwrapped call or a stale allow-list entry, 2 if it could not
 * run. Its test (stepup-call-guard.test.mjs) runs it over the repository in CI.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import {
  callSites,
  globalPathDefs,
  globalWrappers,
  literalParts,
  literalPaths,
  norm,
  parse,
  resolverFor,
  segmentMatch,
  walk,
  wrappers,
} from "./preflight-ui-affordances.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** the gateway's step-up entry points (apps/gateway/src/step-up.ts) */
export const STEP_UP_FUNCTIONS = Object.freeze(["requireStepUp", "requireStepUps", "checkStepUp"]);

/** web functions that run a request through the step-up retry (apps/web/src/stepup/stepUp.ts) */
export const STEP_UP_WRAPPERS = Object.freeze(["withStepUp", "putOrgSettings"]);

/**
 * `"VERB /normalized/path  apps/web/src/…file"` -> reason. Each is a web call to a route whose handler can
 * demand step-up, made without the retry because the body it sends never meets the
 * handler's condition. The reason names the condition and the call's body.
 */
export const ALLOWED = new Map([
  [
    "POST /v1/connectors/:x/enabled  apps/web/src/views/admin/integrations/ConnectorsPage.tsx",
    "useLifecycle's Disable sends { enabled: false }; step-up applies only to enabling a connector, and Enable goes through withStepUp",
  ],
  [
    "POST /v1/servers/:x/enabled  apps/web/src/views/admin/integrations/McpServersPage.tsx",
    "useLifecycle's Disable sends { enabled: false }; step-up applies only to enabling a server, and Enable goes through withStepUp",
  ],
  [
    "PATCH /v1/privacy/processing-records/:x  apps/web/src/views/admin/compliance/ProcessingRecordsPage.tsx",
    "the plain branch retires a record ({ status: 'retired' }); processingRecordWidens is false for a retire, and reactivating goes through withStepUp",
  ],
  [
    "POST /v1/onboarding/imports/group-roles  apps/web/src/views/admin/settings/OnboardingImportsCards.tsx",
    "the plain branch is mode 'dry_run', which returns its plan before the handler's requireStepUps; 'apply' goes through withStepUp",
  ],
  [
    "PATCH /v1/chatops/connections/:x  apps/web/src/views/admin/governance/ChatOpsPage.tsx",
    "the severity PATCH sends no recipients; step-up applies only when recipients are added",
  ],
  [
    "PATCH /v1/auth/oidc-providers/:x  apps/web/src/views/admin/identity/SsoPage.tsx",
    "the enable toggle sends { enabled }; step-up applies only to changing defaultRoleId",
  ],
  [
    "PATCH /v1/auth/saml-providers/:x  apps/web/src/views/admin/identity/SsoPage.tsx",
    "the enable toggle sends { enabled }; step-up applies only to changing defaultRoleId",
  ],
  [
    "POST /v1/agents  apps/web/src/views/admin/integrations/AgentsPage.tsx",
    "the register form never sends expectedServedModel, the only field that makes this route demand step-up",
  ],
  [
    "PATCH /v1/servers/:x  apps/web/src/views/admin/integrations/Batch3Mcp.tsx",
    "the stdio-only edit; step-up applies only to the HTTP-server fields this form does not send",
  ],
  [
    "PUT /v1/execution-person-stdio-relaxations/:x/:x  apps/web/src/views/admin/integrations/isolation/IsolationPanel.tsx",
    "Restore sends { relaxed: false }, which only tightens; the handler's requireStepUp is inside `if (b.data.relaxed)`, and allow/renew go through withStepUp",
  ],
]);

const GATEWAY_VERBS = new Map([
  ["get", "GET"],
  ["post", "POST"],
  ["put", "PUT"],
  ["patch", "PATCH"],
  ["delete", "DELETE"],
]);
const WEB_VERB = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", del: "DELETE" };

const isFn = (n) => n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n));

/** the name a call is made by: `f(…)` -> f, `x.f(…)` -> f */
function calleeName(call) {
  const c = call.expression;
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  return "";
}

/** does `node`'s subtree call any name in `names`? */
function callsAny(node, names) {
  let hit = false;
  const visit = (n) => {
    if (hit) return;
    if (ts.isCallExpression(n) && names.has(calleeName(n))) {
      hit = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

/** named functions in a file: `function f…`, `const f = (…) => …`, `const f = function …` */
function namedFunctions(sf) {
  const out = [];
  const visit = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) out.push([n.name.text, n.body]);
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && isFn(n.initializer)) out.push([n.name.text, n.initializer.body]);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Every route a gateway source registers whose handler can demand step-up, as
 * `"VERB /normalized/path"`.
 */
export function stepUpRoutes(src, fileName = "gateway.ts") {
  const sf = parse(src, fileName);
  const callers = new Set(STEP_UP_FUNCTIONS);
  const fns = namedFunctions(sf);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, body] of fns) {
      if (!callers.has(name) && callsAny(body, callers)) {
        callers.add(name);
        changed = true;
      }
    }
  }
  const out = new Set();
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const verb = GATEWAY_VERBS.get(n.expression.name.text);
      const [first] = n.arguments;
      if (verb && first && ts.isStringLiteral(first) && first.text.startsWith("/")) {
        const handler = [...n.arguments].reverse().find(isFn);
        if (handler && callsAny(handler.body, callers)) out.add(`${verb} ${norm(first.text)}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Is this request made under the step-up retry? Either it sits lexically inside a call
 * to one of STEP_UP_WRAPPERS, or it is a step-up call FACTORY: a `stepUpApi.<verb>(…, h)`
 * whose last argument is a parameter of the enclosing function, i.e. the `(h) => …`
 * that a component (StaticCredentialCard's save/clear) hands to withStepUp itself.
 */
function insideWrapper(node, safeHelpers = new Set()) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && STEP_UP_WRAPPERS.includes(calleeName(p))) return true;
  }
  const call = node.parent;
  // the path is handed to a helper that itself runs the request through withStepUp
  // (UsersPage's `lift(path, msg)`, InfraRowActions' `useRetire(path, …)`)
  if (call && ts.isCallExpression(call) && safeHelpers.has(calleeName(call))) return true;
  if (call && ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)) {
    const obj = call.expression.expression;
    const last = call.arguments[call.arguments.length - 1];
    if (ts.isIdentifier(obj) && obj.text === "stepUpApi" && call.arguments.length >= 2 && last && ts.isIdentifier(last)) {
      for (let f = call.parent; f; f = f.parent) {
        if (isFn(f)) return f.parameters.some((prm) => ts.isIdentifier(prm.name) && prm.name.text === last.text);
      }
    }
  }
  return false;
}

/**
 * Every path a call's path argument names, normalized: its literals, and any
 * path-builder identifier in it resolved the way the affordance census does
 * (`api.put(ownerPath(kind, id), …)`, a local `const path = …`).
 */
function pathsIn(node, sf, resolve) {
  const out = [];
  const visit = (n) => {
    const parts = literalParts(n, sf);
    if (parts) {
      out.push(...literalPaths(parts, resolve));
      return;
    }
    if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) out.push(...resolve(n.text));
    ts.forEachChild(n, visit);
  };
  visit(node);
  return [...new Set(out.map(norm))];
}

/**
 * Named functions whose own body calls a STEP_UP_WRAPPER: a request helper built this
 * way already retries through step-up, so a path handed to it is not an unwrapped call.
 */
export function stepUpSafeHelpers(sf) {
  const wrapNames = new Set(STEP_UP_WRAPPERS);
  return new Set(namedFunctions(sf).filter(([, body]) => callsAny(body, wrapNames)).map(([name]) => name));
}

/** name -> Set("verb:arg"), merged */
function mergeInto(into, more) {
  for (const [name, verbs] of more) {
    if (!into.has(name)) into.set(name, new Set());
    for (const v of verbs) into.get(name).add(v);
  }
  return into;
}

/**
 * Every request a web source makes outside a step-up wrapper: `{ route, line }`, route
 * as `"VERB /normalized"`. `globalDefs` and `globalWrap` are the cross-file path
 * builders and request helpers (preflight-ui-affordances globalPathDefs/globalWrappers),
 * so a page's own `deleteWithBody(path, body)` raw-fetch helper is seen too.
 */
export function unwrappedCalls(src, fileName = "ui.tsx", globalDefs = new Map(), globalWrap = new Map(), globalSafe = new Set()) {
  const sf = parse(src, fileName);
  const safe = new Set([...globalSafe, ...stepUpSafeHelpers(sf)]);
  const known = mergeInto(new Map(globalWrap), wrappers(sf, globalWrap));
  mergeInto(known, wrappers(sf, known));
  const resolveAt = resolverFor(sf, globalDefs);
  const out = [];
  for (const { verb, node } of callSites(sf, known)) {
    if (insideWrapper(node, safe)) continue;
    const at = node.getStart(sf);
    const line = sf.getLineAndCharacterOfPosition(at).line + 1;
    for (const p of pathsIn(node, sf, (name) => resolveAt(name, at))) out.push({ route: `${WEB_VERB[verb]} ${p}`, line });
  }
  return out;
}

/** does a web call `"VERB /p"` reach a step-up route in `routes` (segment-wise, `:x` either side)? */
function hitsStepUpRoute(call, routesByVerb) {
  const sp = call.indexOf(" ");
  const set = routesByVerb.get(call.slice(0, sp));
  return set ? segmentMatch(call.slice(sp + 1), set) : false;
}

/**
 * The guard. `gateway` and `web` are `[{ src, fileName }]`. Returns
 * `{ routes, findings, stale }`: findings are unwrapped calls to a step-up route not
 * on ALLOWED; stale are ALLOWED entries no unwrapped call matches any more.
 */
export function check({ gateway, web, allowed = ALLOWED }) {
  const routes = new Set();
  for (const { src, fileName } of gateway) for (const r of stepUpRoutes(src, fileName)) routes.add(r);
  const routesByVerb = new Map();
  for (const r of routes) {
    const [verb, p] = r.split(" ");
    if (!routesByVerb.has(verb)) routesByVerb.set(verb, new Set());
    routesByVerb.get(verb).add(p);
  }
  const findings = [];
  const usedAllowed = new Set();
  const defs = globalPathDefs(web);
  const wrap = globalWrappers(web);
  // exported step-up-safe helpers are visible from any file (a name is only trusted where it is defined with the retry)
  const safe = new Set();
  for (const { src, fileName } of web) {
    const sf = parse(src, fileName);
    const local = stepUpSafeHelpers(sf);
    for (const st of sf.statements) {
      const exported = st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      if (ts.isFunctionDeclaration(st) && st.name && local.has(st.name.text)) safe.add(st.name.text);
      if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && local.has(d.name.text)) safe.add(d.name.text);
    }
  }
  for (const { src, fileName } of web) {
    for (const { route, line } of unwrappedCalls(src, fileName, defs, wrap, safe)) {
      if (!hitsStepUpRoute(route, routesByVerb)) continue;
      const key = `${route}  ${fileName.split(path.sep).join("/")}`;
      if (allowed.has(key)) {
        usedAllowed.add(key);
        continue;
      }
      findings.push({ route, file: fileName, line });
    }
  }
  const stale = [...allowed.keys()].filter((r) => !usedAllowed.has(r)).sort();
  return { routes, findings, stale };
}

/** the repository's gateway routes and web views (the step-up client itself is the wrapper, so not a caller) */
export function scanRepo() {
  const read = (f) => ({ src: readFileSync(f, "utf8"), fileName: path.relative(root, f) });
  const gateway = walk(path.join(root, "apps/gateway/src")).map(read);
  const web = walk(path.join(root, "apps/web/src"))
    .filter((f) => !f.includes(`${path.sep}stepup${path.sep}`) && !f.endsWith(`${path.sep}api${path.sep}client.ts`))
    .map(read);
  return check({ gateway, web });
}

function main() {
  const { routes, findings, stale } = scanRepo();
  if (routes.size === 0) {
    console.error("stepup-call-guard: found no step-up routes in the gateway; the scan is broken, not the app");
    return 2;
  }
  console.log(`step-up call guard: ${routes.size} step-up routes, ${findings.length} unwrapped web calls, ${stale.length} stale allow-list entries`);
  for (const f of findings) console.error(`  NOT THROUGH withStepUp  ${f.route}  ${f.file}:${f.line}`);
  for (const r of stale) console.error(`  STALE ALLOW-LIST ENTRY  ${r}`);
  return findings.length || stale.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main());
