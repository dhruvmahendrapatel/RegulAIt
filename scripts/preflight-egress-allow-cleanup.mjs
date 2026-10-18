#!/usr/bin/env node
/**
 * EGRESS ALLOW CLEANUP (M-068, M-078): every gateway test file that adds an
 * egress allow entry on the SHARED database removes it from an `afterAll`.
 *
 * WHY. The gateway suite runs every file against one database
 * (`fileParallelism: false`), and `POST /v1/egress-allow-hosts` upserts by host,
 * so the whole suite shares ONE `127.0.0.1` row. A file that leaves that row
 * behind (with `allowPrivateRanges`) lets a later file reach a loopback double
 * that the strict posture should refuse. That later file then passes or fails
 * with vitest's file order, which is not fixed. M-068's rule was first applied
 * only to the spec that produced it; M-078 records that 13 gateway files kept
 * the same leak. This check stops it coming back.
 *
 * WHAT IT CHECKS. It is STATIC: it parses each `apps/gateway/src/**\/*.test.ts`
 * with the TypeScript compiler API and needs no database and no build.
 *  - A file CREATES an entry if it POSTs to `"/v1/egress-allow-hosts"` (a call
 *    whose HTTP method cannot be read counts as a POST) or calls
 *    `.insert(egressAllowHosts)`.
 *  - FAIL CLOSED BY CONSTRUCTION (#427 review N1): a removal counts only in the
 *    two forms of the shared helper (`src/testing/egress-allow-cleanup.ts`),
 *    each imported under its own name from that module. Every other shape (a
 *    `db.delete(egressAllowHosts)…`, a DELETE request, a helper of the file's
 *    own) names nothing, so the entry it was meant to remove is reported.
 *     1. `removeEgressAllowEntry(app, headers, { id: <saved> })`: the DELETE
 *        route, by the id the create returned. `<saved>` must be a plain name
 *        or property chain (or a for-of variable over one), and the create's
 *        result must flow into it by plain reads only: `x = r.json().id`,
 *        `const { id } = r.json()`, `ids.push(row.id)`, through `await`,
 *        parentheses, `!`, `as`, a zero-argument `.json()` and `[0]`. A read
 *        of any property but `id`, arithmetic, a template or any other call
 *        carries nothing.
 *     2. `<tracker>.removeAll(...)` of a `const <tracker> = trackEgressAllowHosts()`,
 *        when every `host:` value of the create is exactly
 *        `<tracker>.trackHost(...)`. The helper finds the row by the host
 *        normalised the way the route stores it and deletes it by id.
 *    Each form counts only when its result reaches `.assertRemoved()` and the
 *    call runs every time its hook does: not under an `if`, `?:`, `&&`/`||`,
 *    a `catch` or a `try` block, not after a `return`, and not in a function
 *    nobody calls (#427 round 3 L1). The helper module is the one real file,
 *    resolved from the test file's directory (L2).
 *  - ONE SAVED BINDING PER ROW (#427 round 3 M1). A saved id counts for a
 *    create only if every write to that binding is its declaration's default
 *    or the result of a create of the SAME row (one literal host, read through
 *    `const`s and the arguments of the functions the create was reached
 *    through; the route upserts by host). Two hosts saved into one variable,
 *    or a later `saved = undefined`, `ids.length = 0`, `ids.splice(…)`, leave
 *    a row unnamed, and both creates are reported.
 *  - WHERE THE REMOVAL RUNS. A create outside a test body (beforeAll, a
 *    describe body) needs the removal reachable from an `afterAll`, directly
 *    or through functions declared in the same file. A create INSIDE a test
 *    body (`it`/`test`) needs a cleanup of its own: a tracked host with the
 *    tracker removed from an `afterEach`, or the marker comment
 *    `egress-allow-cleanup: afterAll` on its statement AND its saved id
 *    removed from an `afterAll` (form 1). A marked upsert of the same host as
 *    a covered create in the same test, and a restore inside a `finally` of
 *    the same host as a covered create in the file, are covered by it (the
 *    upsert keeps the row id; if a restore makes a new one, the id removal
 *    returns 404 and the helper's assertRemoved fails the suite). A POST the
 *    test expects to be refused carries `egress-allow-cleanup: refused`. A
 *    marked create whose host is tracked is covered by that tracker's
 *    `removeAll` in an `afterAll` (it removes every row of the host).
 *  - A create inside a function declared in the file is judged at each place
 *    that function is called, with the call's result standing for the
 *    create's when the function returns it.
 *  - A file that creates its entries only on a scratch database it drops is
 *    listed in SCRATCH_DB_FILES with a reason. The listing is checked too: an
 *    exempt file must still create an entry and still drop a scratch database
 *    from an `afterAll`, or the exemption is stale.
 *
 * Exit 0 clean, 1 when a file leaks or an exemption is stale, 2 if it could
 * not run. Any non-zero fails CI (`pnpm exec vitest run --dir scripts` runs the
 * companion test).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const GATEWAY_SRC = "apps/gateway/src";

const ROUTE = "/v1/egress-allow-hosts";
const TABLE = "egressAllowHosts";
/** the shared helper module, relative to GATEWAY_SRC (src/testing/egress-allow-cleanup.ts) */
const HELPER_MODULE = "testing/egress-allow-cleanup";
/**
 * does a test file at `fileName` (relative to GATEWAY_SRC) import the ONE shared helper module with `spec`? The
 * specifier is resolved against the file's directory (#427 review L2), so `./fake/testing/egress-allow-cleanup.js`
 * names another module.
 */
const isHelperModule = (spec, fileName) => {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fileName.split(path.sep).join("/")), spec));
  return resolved === HELPER_MODULE || resolved === `${HELPER_MODULE}.js`;
};
const HELPER = "removeEgressAllowEntry";
const TRACKER_FACTORY = "trackEgressAllowHosts";
/** the tracker's methods: record a posted host, and remove every recorded host's row */
const TRACKER_REMOVAL = "removeAll";
const TRACKER_ADD = "trackHost";
export const FILE_SCOPED_MARKER = "egress-allow-cleanup: afterAll";
/** a POST the test expects to be REFUSED (a non-admin, an empty payload) creates nothing */
export const REFUSED_MARKER = "egress-allow-cleanup: refused";
const TEST_FNS = new Set(["it", "test"]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * Files whose allow entries are created ONLY on a scratch database they create
 * and drop. Each was confirmed by reading it: the app that POSTs is built on the
 * scratch database, never on DATABASE_URL.
 */
export const SCRATCH_DB_FILES = new Map([
  [
    "zz-adr0181-sc-strict-defaults.test.ts",
    "the allow entry is POSTed to an app built on the FRESH scratch database; afterAll drops FRESH_DB and UPGRADE_DB",
  ],
  [
    "zz-adr0189-b2-facts.test.ts",
    "beforeAll builds the app on the SCRATCH database it creates; afterAll drops it with dropScratchDatabase",
  ],
  [
    "audit-timestamp.test.ts",
    "the synthetic TSA allow entries are inserted into a per-run database it CREATEs in beforeAll and DROPs in afterAll",
  ],
]);

const stringValue = (node) =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;

const calleeName = (call) => {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
};

/** the HTTP method next to a route literal: a sibling string, a `method:` property, or the callee's name */
function methodNear(literal) {
  const container = ts.isPropertyAssignment(literal.parent) ? literal.parent.parent : literal.parent;
  if (ts.isObjectLiteralExpression(container)) {
    for (const p of container.properties) {
      if (ts.isPropertyAssignment(p) && p.name.getText() === "method") {
        const v = stringValue(p.initializer);
        if (v) return v.toUpperCase();
      }
    }
    return undefined;
  }
  if (ts.isCallExpression(container) || ts.isArrayLiteralExpression(container)) {
    const items = ts.isCallExpression(container) ? container.arguments : container.elements;
    for (const a of items) {
      const v = stringValue(a);
      if (v && METHODS.has(v.toUpperCase())) return v.toUpperCase();
    }
    if (ts.isCallExpression(container)) {
      const name = (calleeName(container) ?? "").toLowerCase();
      if (name === "post") return "POST";
      if (name === "get") return "GET";
    }
  }
  return undefined;
}

const isTableCall = (node, method) =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  node.expression.name.text === method &&
  node.arguments.length > 0 &&
  ts.isIdentifier(node.arguments[0]) &&
  node.arguments[0].text === TABLE;

const isHook = (name) => (node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;
const isAfterAll = isHook("afterAll");
const isAfterEach = isHook("afterEach");

/** a call that runs its callback once: `it`, `test`, `describe`, `beforeAll`, `afterAll` and their modifiers, never `.each` or `.for` */
const ONCE_FNS = new Set(["it", "test", "describe", "beforeAll", "afterAll"]);
const runsOnce = (call) => {
  let e = call.expression;
  while (ts.isPropertyAccessExpression(e) || ts.isCallExpression(e)) {
    if (ts.isPropertyAccessExpression(e) && (e.name.text === "each" || e.name.text === "for")) return false;
    e = e.expression;
  }
  return ts.isIdentifier(e) && ONCE_FNS.has(e.text);
};

/** `it(...)`, `test(...)`, `it.skip(...)`, `it.each(rows)(...)`: the root identifier of the callee chain */
const isTestCall = (node) => {
  if (!ts.isCallExpression(node)) return false;
  let e = node.expression;
  while (ts.isPropertyAccessExpression(e) || ts.isCallExpression(e)) e = e.expression;
  return ts.isIdentifier(e) && TEST_FNS.has(e.text);
};

/** the innermost statement holding a node (its leading comments carry the marker) */
const statementOf = (node) => {
  let n = node;
  while (n.parent && !(ts.isBlock(n.parent) || ts.isSourceFile(n.parent) || ts.isCaseOrDefaultClause(n.parent))) n = n.parent;
  return n.parent ? n : undefined;
};

/** where a node sits relative to the test that runs it, and the markers on its statement */
function siteContext(node, sf) {
  let inTestBody = false;
  let inFinally = false;
  let test;
  for (let p = node.parent; p; p = p.parent) {
    if (p.parent && ts.isTryStatement(p.parent) && p.parent.finallyBlock === p) inFinally = true;
    if (isTestCall(p)) {
      inTestBody = true;
      test = p;
      break;
    }
  }
  const stmt = statementOf(node);
  let markedAfterAll = false;
  let markedRefused = false;
  if (stmt) {
    const leading = stmt.getFullText(sf).slice(0, stmt.getStart(sf) - stmt.getFullStart());
    markedAfterAll = leading.includes(FILE_SCOPED_MARKER);
    markedRefused = leading.includes(REFUSED_MARKER);
  }
  return { inTestBody, inFinally, markedAfterAll, markedRefused, stmt, test };
}

/**
 * Name resolution: names are compared by the SYMBOL the TypeScript checker binds them to, never by spelling, so a
 * shadowed `host` or a reused result name `r` is a different name (review L2). A name the file never declares (a
 * global) keys by its spelling. A property chain keys as its root's key plus the property names (`created.allowHosts`).
 */
function makeKeys(checker) {
  const ids = new Map();
  const symKey = (sym) => {
    if (!ids.has(sym)) ids.set(sym, ids.size);
    return `s${ids.get(sym)}`;
  };
  /** the variable an identifier refers to (in `{ id }` shorthand, the variable `id`, not the property) */
  const symbolOf = (node) =>
    ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
  const keyOf = (node) => {
    if (ts.isIdentifier(node)) {
      const sym = symbolOf(node);
      return sym ? symKey(sym) : `g:${node.text}`;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const base = keyOf(node.expression);
      return base === undefined ? undefined : `${base}.${node.name.text}`;
    }
    if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)) return keyOf(node.expression);
    return undefined;
  };
  /** every declaration of the symbol an identifier refers to */
  const declsOf = (node) => {
    const sym = ts.isIdentifier(node) ? symbolOf(node) : undefined;
    return sym?.declarations ?? [];
  };
  const declOf = (node) => declsOf(node)[0];
  return { keyOf, declOf, declsOf };
}

/** is this identifier a property NAME (`a.b`'s b, `{ b: 1 }`'s b), not a reference? */
const isPropertyName = (n) =>
  (ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) || (ts.isPropertyAssignment(n.parent) && n.parent.name === n);

/** strip what does not change a value: parentheses, `!`, `as`, `satisfies`, `<T>x` */
function unwrap(e) {
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
    else if (ts.isSatisfiesExpression?.(e)) e = e.expression;
    else return e;
  }
}

/** a plain name or property chain on one (`saved`, `created.allowHosts`), after unwrap; anything else is undefined */
function strictRef(e) {
  const u = unwrap(e);
  let r = u;
  while (ts.isPropertyAccessExpression(r)) r = r.expression;
  return ts.isIdentifier(r) ? u : undefined;
}

/** how many declarations anywhere in the file bind `name` (an import, `import x = require()`, a variable, a parameter, …) */
const declaredNames = new WeakMap();
function declarationsNamed(sf, name) {
  if (!declaredNames.has(sf)) {
    const counts = new Map();
    const visit = (n) => {
      const declName =
        ts.isImportSpecifier(n) || ts.isImportEqualsDeclaration(n) || ts.isImportClause(n) || ts.isNamespaceImport(n) ||
        ts.isVariableDeclaration(n) || ts.isBindingElement(n) || ts.isParameter(n) || ts.isFunctionDeclaration(n) ||
        ts.isClassDeclaration(n) || ts.isEnumDeclaration(n) || ts.isModuleDeclaration(n)
          ? n.name
          : undefined;
      if (declName && ts.isIdentifier(declName)) counts.set(declName.text, (counts.get(declName.text) ?? 0) + 1);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    declaredNames.set(sf, counts);
  }
  return declaredNames.get(sf).get(name) ?? 0;
}

/**
 * is this identifier bound to the shared helper module's export of the same name? Only an un-aliased
 * `import { name } from ".../testing/egress-allow-cleanup.js"` counts: any other binding (an alias, a local
 * declaration, a parameter, a destructured element, an import from another module) makes the name say nothing.
 */
function boundToHelper(id, keys, name) {
  if (!ts.isIdentifier(id) || id.text !== name || declarationsNamed(id.getSourceFile(), name) !== 1) return false;
  const decls = keys.declsOf(id);
  if (decls.length !== 1) return false;
  const d = decls[0];
  if (!ts.isImportSpecifier(d) || d.propertyName) return false;
  const decl = d.parent?.parent?.parent;
  return !!decl && ts.isImportDeclaration(decl) && isHelperModule(stringValue(decl.moduleSpecifier) ?? "", id.getSourceFile().fileName);
}

/** the tracker a `const t = trackEgressAllowHosts()` declares, as the key of `t`, for an identifier naming it */
function trackerKey(e, keys) {
  const u = unwrap(e);
  if (!ts.isIdentifier(u)) return undefined;
  const decls = keys.declsOf(u);
  if (decls.length !== 1) return undefined;
  const d = decls[0];
  if (!ts.isVariableDeclaration(d) || !ts.isIdentifier(d.name) || !d.initializer) return undefined;
  if (!(ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const)) return undefined;
  const init = unwrap(d.initializer);
  if (!ts.isCallExpression(init) || init.arguments.length !== 0 || !boundToHelper(init.expression, keys, TRACKER_FACTORY)) return undefined;
  return keys.keyOf(u);
}

/** `<tracker>.<method>(...)`: the tracker's key, or undefined */
function trackerCall(n, keys, method) {
  if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression) || n.expression.name.text !== method) return undefined;
  return trackerKey(n.expression.expression, keys);
}

/**
 * one removal the helper makes, or undefined for anything else (#427 review N1: an allow-list of the helper's own
 * forms). `{ ids }` are the keys the saved id is read from (a for-of variable brings its iterable's key);
 * `{ tracker }` is the key of the tracker whose hosts are removed.
 */
function helperRemoval(n, keys) {
  if (!ts.isCallExpression(n)) return undefined;
  const tracker = trackerCall(n, keys, TRACKER_REMOVAL);
  if (tracker) return { ids: new Set(), tracker };
  if (!boundToHelper(n.expression, keys, HELPER) || n.arguments.length !== 3) return undefined;
  const target = unwrap(n.arguments[2]);
  if (!ts.isObjectLiteralExpression(target) || target.properties.length !== 1) return { ids: new Set() };
  const p = target.properties[0];
  let ref;
  if (ts.isShorthandPropertyAssignment(p) && p.name.text === "id" && !p.objectAssignmentInitializer) ref = p.name;
  else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "id") ref = strictRef(p.initializer);
  const ids = new Set();
  if (ref) {
    const k = keys.keyOf(ref);
    if (k) ids.add(k);
    // a for-of variable stands for each element of its iterable, when that is itself a plain name or chain
    if (ts.isIdentifier(ref)) {
      const d = keys.declOf(ref);
      const list = d && ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) ? d.parent : undefined;
      const loop = list && ts.isVariableDeclarationList(list) ? list.parent : undefined;
      if (loop && ts.isForOfStatement(loop)) {
        const it = strictRef(loop.expression);
        const ik = it && keys.keyOf(it);
        if (ik) ids.add(ik);
      }
    }
  }
  return { ids };
}

/**
 * a plain read of a value: its root (a name, or the expression that produced it) and the outermost property read.
 * Reads through `await`, unwrap, a zero-argument `.json()` and a numeric index; anything else is the root.
 */
function plainRead(e) {
  let lastProp;
  let n = e;
  for (;;) {
    n = unwrap(n);
    if (ts.isAwaitExpression(n)) n = n.expression;
    else if (ts.isPropertyAccessExpression(n)) {
      if (lastProp === undefined) lastProp = n.name.text;
      n = n.expression;
    } else if (ts.isElementAccessExpression(n) && ts.isNumericLiteral(n.argumentExpression)) n = n.expression;
    else if (
      ts.isCallExpression(n) &&
      n.arguments.length === 0 &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "json"
    ) {
      n = n.expression.expression;
    } else return { root: n, lastProp };
  }
}

/** the function a node sits in, when that function has a name the file can call it by */
function namedFunctionOf(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p)) return p.name ? { fn: p, name: p.name } : undefined;
    if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
      // an expression-bodied arrow passed as an argument (`relaxStepUpAround(db, () => post(...))`) is the call's value
      if (isValueArrow(p)) continue;
      const d = p.parent;
      if (ts.isVariableDeclaration(d) && d.initializer === p && ts.isIdentifier(d.name)) return { fn: p, name: d.name };
      return undefined;
    }
    if (ts.isMethodDeclaration(p) || ts.isConstructorDeclaration(p) || ts.isClassDeclaration(p)) return undefined;
  }
  return undefined;
}

/** an arrow with an expression body passed as a call argument: its value is (by convention) what the call returns */
const isValueArrow = (p) => ts.isArrowFunction(p) && !ts.isBlock(p.body) && ts.isCallExpression(p.parent) && p.parent.arguments.includes(p);

/**
 * is `inner` inside `outer` without crossing a function boundary below `outer`? An arrow with an expression body
 * passed as an argument (`relaxStepUpAround(db, () => app.inject(...))`) is crossed: its value is the call's.
 */
function within(inner, outer) {
  for (let p = inner; p; p = p.parent) {
    if (p === outer) return true;
    if (p === inner) continue;
    if (!isValueArrow(p) && (ts.isArrowFunction(p) || ts.isFunctionExpression(p) || ts.isFunctionDeclaration(p))) return false;
  }
  return false;
}

const isFunctionLike = (n) =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n);
const LOGICAL = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);
const JUMPS = (st) => ts.isReturnStatement(st) || ts.isThrowStatement(st) || ts.isBreakStatement(st) || ts.isContinueStatement(st);

/**
 * does `node` run every time `root` (a hook callback or a function the hooks reach) runs? (#427 review L1) It must not
 * sit under an `if`, `?:`, `&&`/`||`/`??`, an optional chain, a `switch` case, a `catch`, the `try` block of a `try`
 * (its `finally` runs always), a `while`/`do`/`for`/`for-in` loop (a `for-of` over the saved ids is allowed), nor in a
 * nested function, nor after a `return`/`throw`/`break`/`continue` in any enclosing block.
 */
function unconditional(node, root) {
  for (let child = node, p = node.parent; p; child = p, p = p.parent) {
    if (p === root) return true;
    if (isFunctionLike(p)) return false;
    if (ts.isIfStatement(p) || ts.isConditionalExpression(p) || ts.isCaseClause(p) || ts.isDefaultClause(p) || ts.isCatchClause(p)) return false;
    if (ts.isWhileStatement(p) || ts.isDoStatement(p) || ts.isForStatement(p) || ts.isForInStatement(p)) return false;
    if (ts.isForOfStatement(p) && child !== p.statement) return false;
    if (ts.isTryStatement(p) && child === p.tryBlock) return false;
    if (ts.isBinaryExpression(p) && LOGICAL.has(p.operatorToken.kind)) return false;
    if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || ts.isCallExpression(p)) && p.questionDotToken) return false;
    if (ts.isBlock(p) || ts.isSourceFile(p)) {
      for (const st of p.statements) {
        if (st === child) break;
        if (JUMPS(st)) return false;
      }
    }
  }
  return false;
}

/** strip what does not change a value, and `await` */
const unwrapAwait = (e) => {
  let n = unwrap(e);
  while (ts.isAwaitExpression(n)) n = unwrap(n.expression);
  return n;
};

/** the outermost expression that still IS `node`'s value: through parentheses, `!`, `as` and `await` */
function valueOf(node) {
  let n = node;
  while (
    n.parent &&
    (ts.isParenthesizedExpression(n.parent) || ts.isNonNullExpression(n.parent) || ts.isAsExpression(n.parent) || ts.isAwaitExpression(n.parent))
  ) {
    n = n.parent;
  }
  return n;
}

/** is `n` the call `<x>.assertRemoved()` with `x` naming `key`, run unconditionally within `scope`? */
const assertsKey = (n, key, keys, scope) =>
  ts.isCallExpression(n) &&
  n.arguments.length === 0 &&
  ts.isPropertyAccessExpression(n.expression) &&
  n.expression.name.text === "assertRemoved" &&
  ts.isIdentifier(unwrap(n.expression.expression)) &&
  keys.keyOf(unwrap(n.expression.expression)) === key &&
  unconditional(n, scope);

/** a `const` declared once, as its key, or undefined */
function constKey(nameNode, keys) {
  if (!ts.isIdentifier(nameNode)) return undefined;
  const decls = keys.declsOf(nameNode);
  if (decls.length !== 1 || !ts.isVariableDeclaration(decls[0]) || !(ts.getCombinedNodeFlags(decls[0]) & ts.NodeFlags.Const)) return undefined;
  return keys.keyOf(nameNode);
}

/** does any node under `scope` satisfy `pred`? */
function some(scope, pred) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (pred(n)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
}

/**
 * does the result of the removal call `call` reach `.assertRemoved()` in `root`? (#427 review L1: without it the
 * helper's report is dropped, so a 404 for a re-created row fails nothing.) Accepted:
 *  - `(await remove(...)).assertRemoved()`;
 *  - `const x = await remove(...)` and an unconditional `x.assertRemoved()` in the same function;
 *  - `xs.push(await remove(...))` into a `const xs`, and `for (const r of xs) r.assertRemoved();` in the same function.
 */
function asserted(call, root, keys) {
  const v = valueOf(call);
  const p = v.parent;
  if (ts.isPropertyAccessExpression(p) && p.expression === v && p.name.text === "assertRemoved" && ts.isCallExpression(p.parent) && p.parent.expression === p) {
    return p.parent.arguments.length === 0;
  }
  if (ts.isVariableDeclaration(p) && p.initializer === v) {
    const k = constKey(p.name, keys);
    return !!k && some(root, (n) => assertsKey(n, k, keys, root));
  }
  if (ts.isCallExpression(p) && p.arguments.length === 1 && p.arguments[0] === v && ts.isPropertyAccessExpression(p.expression) && p.expression.name.text === "push") {
    const k = constKey(unwrap(p.expression.expression), keys);
    if (!k) return false;
    return some(root, (n) => {
      if (!ts.isForOfStatement(n) || !ts.isIdentifier(unwrap(n.expression)) || keys.keyOf(unwrap(n.expression)) !== k || !unconditional(n, root)) return false;
      const list = n.initializer;
      if (!ts.isVariableDeclarationList(list) || list.declarations.length !== 1 || !ts.isIdentifier(list.declarations[0].name)) return false;
      const rk = keys.keyOf(list.declarations[0].name);
      return some(n.statement, (m) => assertsKey(m, rk, keys, n.statement) || (ts.isExpressionStatement(n.statement) && assertsKey(m, rk, keys, n)));
    });
  }
  return false;
}

/** the host values a create statement posts: literals and keys of plain names, and whether each is tracked */
function hostsOf(stmt, keys) {
  const literals = [];
  const refs = [];
  /** the plain-name host values, as nodes (resolved per site by sameRow) */
  const refNodes = [];
  const trackers = [];
  let untracked = 0;
  /** host values that are neither a literal nor a plain name (a call, a template, a ternary, …) */
  let opaque = 0;
  const followed = new Set();
  const scan = (n) => {
    // a payload passed by name (`const payload = { host }; post(url, payload)`) is read through its declaration
    if (ts.isIdentifier(n) && !isPropertyName(n) && !followed.has(n)) {
      followed.add(n);
      const d = keys.declOf(n);
      if (d && ts.isVariableDeclaration(d) && d.initializer && ts.isObjectLiteralExpression(d.initializer)) scan(d.initializer);
    }
    const value =
      ts.isPropertyAssignment(n) && n.name.getText() === "host" ? n.initializer : ts.isShorthandPropertyAssignment(n) && n.name.text === "host" ? n.name : undefined;
    if (value) {
      const v = stringValue(value);
      const ref = strictRef(value);
      const tracker = trackerCall(unwrap(value), keys, TRACKER_ADD);
      if (tracker) trackers.push(tracker);
      else untracked += 1;
      if (v !== undefined) literals.push(v);
      else if (ref && keys.keyOf(ref)) {
        refs.push(keys.keyOf(ref));
        refNodes.push(ref);
      } else opaque += 1;
    }
    ts.forEachChild(n, scan);
  };
  scan(stmt);
  return { literals, refs, refNodes, trackers, untracked, opaque };
}

/**
 * the keys a create's result flows into, by plain reads only (see plainRead): `x = <read>`, `const x = <read>`,
 * `const { id } = <read>`, `const [row] = <read>`, `xs.push(<read>)`, followed transitively. A read whose outermost
 * property is not `id` carries nothing, so `x = r.json().host` does not make `x` an id.
 */
function carriersOf(sf, sources, keys) {
  const names = new Set();
  /** the write nodes (an `=` assignment, a declaration) whose value is the create's result */
  const accepted = new Set();
  const flows = (expr) => {
    const { root, lastProp } = plainRead(expr);
    if (lastProp !== undefined && lastProp !== "id") return false;
    if (ts.isIdentifier(root)) return names.has(keys.keyOf(root));
    return sources(root);
  };
  let grew = true;
  const add = (node) => {
    const r = node && strictRef(node);
    const k = r && keys.keyOf(r);
    if (k && !names.has(k)) {
      names.add(k);
      grew = true;
    }
  };
  const bind = (name) => {
    if (ts.isIdentifier(name)) add(name);
    else if (ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) add(el.name);
    } else if (ts.isObjectBindingPattern(name)) {
      for (const el of name.elements) {
        const prop = el.propertyName ? el.propertyName.getText() : ts.isIdentifier(el.name) ? el.name.text : undefined;
        if (prop === "id" && ts.isIdentifier(el.name)) add(el.name);
      }
    }
  };
  const visit = (n) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && flows(n.right)) {
      accepted.add(n);
      add(n.left);
    }
    if (ts.isVariableDeclaration(n) && n.initializer && flows(n.initializer)) {
      accepted.add(n);
      bind(n.name);
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "push" &&
      n.arguments.length === 1 &&
      flows(n.arguments[0])
    ) {
      add(n.expression.expression);
    }
    ts.forEachChild(n, visit);
  };
  while (grew) {
    grew = false;
    visit(sf);
  }
  return { names, accepted };
}

const MUTATORS = new Set(["pop", "shift", "splice", "fill", "copyWithin"]);

/**
 * every WRITE in the file, by the keys it changes (#427 review M1, L1): an assignment of any operator (and a
 * destructuring one), `++`/`--`, a declaration with an initializer, a `for (x of …)` over an existing name, and an
 * array mutator (`pop`, `shift`, `splice`, `length = …`). A `.push()` adds and is not a write.
 */
function writesOf(sf, keys) {
  const writes = [];
  const targets = (n, out) => {
    const e = unwrap(n);
    if (ts.isObjectLiteralExpression(e)) {
      for (const p of e.properties) {
        if (ts.isShorthandPropertyAssignment(p)) out.push(p.name);
        else if (ts.isPropertyAssignment(p)) targets(p.initializer, out);
        else if (ts.isSpreadAssignment(p)) targets(p.expression, out);
      }
    } else if (ts.isArrayLiteralExpression(e)) {
      for (const el of e.elements) targets(ts.isSpreadElement(el) ? el.expression : el, out);
    } else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) targets(e.left, out);
    else out.push(e);
    return out;
  };
  const bindings = (name, out) => {
    if (ts.isIdentifier(name)) out.push(name);
    else for (const el of name.elements) if (ts.isBindingElement(el)) bindings(el.name, out);
    return out;
  };
  const keyed = (nodes) =>
    nodes
      .map((t) => {
        // `xs.length = 0` empties xs
        const u = unwrap(t);
        return ts.isPropertyAccessExpression(u) && u.name.text === "length" ? keys.keyOf(u.expression) : keys.keyOf(u);
      })
      .filter(Boolean);
  const visit = (n) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      writes.push({ node: n, keys: keyed(targets(n.left, [])), decl: false });
    } else if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      writes.push({ node: n, keys: keyed([n.operand]), decl: false });
    } else if (ts.isVariableDeclaration(n) && n.initializer) {
      writes.push({ node: n, keys: keyed(bindings(n.name, [])), decl: true });
    } else if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) {
      writes.push({ node: n, keys: keyed(targets(n.initializer, [])), decl: false });
    } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && MUTATORS.has(n.expression.name.text)) {
      writes.push({ node: n, keys: keyed([n.expression.expression]), decl: false });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return writes;
}

/** analyse one test file's source */
export function analyzeTestFile(source, fileName = "x.test.ts") {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // a one-file program, only for its checker's symbol binding (no lib, no imports resolved)
  const options = { noLib: true, noResolve: true, types: [] };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === fileName ? sf : undefined);
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => (name === fileName ? source : undefined);
  const keys = makeKeys(ts.createProgram([fileName], options, host).getTypeChecker());
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const createNodes = [];
  const afterAllBodies = [];
  const afterEachBodies = [];
  /** name → function-like nodes declared under that name anywhere in the file */
  const functions = new Map();
  const declare = (name, fn) => functions.set(name, [...(functions.get(name) ?? []), fn]);
  /** every call, for finding where a function holding a create is called */
  const calls = [];
  const visit = (node) => {
    const route = stringValue(node);
    let creates = false;
    if (route === ROUTE && !ts.isLiteralTypeNode(node.parent)) {
      const method = methodNear(node);
      if (method === undefined || method === "POST") creates = true;
    }
    if (isTableCall(node, "insert")) creates = true;
    if (creates) createNodes.push(node);
    if (isAfterAll(node) || isAfterEach(node)) {
      const into = isAfterAll(node) ? afterAllBodies : afterEachBodies;
      for (const a of node.arguments) if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) into.push(a);
    }
    if (ts.isFunctionDeclaration(node) && node.name) declare(node.name.text, node);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      declare(node.name.text, node.initializer);
    }
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // walk everything reachable from the hook callbacks, following calls to functions declared in this file
  const reach = (bodies) => {
    const seen = new Set();
    const work = [...bodies];
    let dropsScratchDb = false;
    const removals = [];
    while (work.length > 0) {
      const fn = work.pop();
      if (seen.has(fn)) continue;
      seen.add(fn);
      const scan = (node) => {
        // a removal counts only when it runs every time the hook does and its result is asserted (review L1)
        const r = helperRemoval(node, keys);
        if (r && unconditional(node, fn) && asserted(node, fn, keys)) removals.push(r);
        // a scratch database dropped by the shared helper or by its own DROP DATABASE statement
        if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) && /\bDROP DATABASE\b/i.test(node.text)) dropsScratchDb = true;
        if (ts.isCallExpression(node)) {
          if (calleeName(node) === "dropScratchDatabase") dropsScratchDb = true;
          if (ts.isIdentifier(node.expression) && unconditional(node, fn)) for (const f of functions.get(node.expression.text) ?? []) work.push(f);
        }
        // a function passed by name (closeAll([... drop ...]), arr.map(fn)); not the name a declaration gives it
        const declaresName = (ts.isVariableDeclaration(node.parent) || ts.isFunctionDeclaration(node.parent)) && node.parent.name === node;
        if (ts.isIdentifier(node) && functions.has(node.text) && !ts.isCallExpression(node.parent) && !declaresName && unconditional(node, fn)) {
          for (const f of functions.get(node.text)) work.push(f);
        }
        ts.forEachChild(node, scan);
      };
      scan(fn);
    }
    const ids = new Set(removals.flatMap((r) => [...r.ids]));
    const trackers = new Set(removals.map((r) => r.tracker).filter(Boolean));
    return { dropsScratchDb, removals, ids, trackers };
  };
  const afterAll = reach(afterAllBodies);
  const afterEach = reach(afterEachBodies);

  /**
   * the SITES a create is judged at: the create itself, or, when it sits in a function declared in the file, each
   * call of that function (recursively). A site carries the create's hosts and the nodes whose value is its result.
   */
  const sites = [];
  const expand = (create, node, results, depth, seen, chain = []) => {
    const named = depth < 8 ? namedFunctionOf(node) : undefined;
    if (named && !seen.has(named.fn)) {
      const key = keys.keyOf(named.name);
      const callSites = calls.filter((c) => ts.isIdentifier(c.expression) && keys.keyOf(c.expression) === key);
      // does the function return the create's value (an expression body, or a `return` of it)?
      const returns =
        (ts.isArrowFunction(named.fn) && !ts.isBlock(named.fn.body) && results.some((r) => within(r, named.fn.body))) ||
        results.some((r) => {
          const st = statementOf(r);
          return st && ts.isReturnStatement(st) && st.expression && within(r, st.expression) && namedFunctionOf(st)?.fn === named.fn;
        });
      if (callSites.length > 0) {
        const next = new Set(seen).add(named.fn);
        for (const c of callSites) expand(create, c, returns ? [...results, c] : results, depth + 1, next, [...chain, { fn: named.fn, call: c }]);
        return;
      }
    }
    sites.push({ create, node, results, chain });
  };
  for (const c of createNodes) expand(c, c, [c], 0, new Set());

  const writes = writesOf(sf, keys);
  /**
   * the ROW a site posts, as one literal host, or undefined when it cannot be read: every `host:` value must be a
   * string literal, a `const` with one, or a parameter of a function the site was reached through whose argument at
   * that call is one of those (review M1: `allow("a")` and `allow("b")` post different rows).
   */
  const rowOf = (site, hosts) => {
    if (hosts.opaque > 0 || hosts.literals.length + hosts.refNodes.length === 0) return undefined;
    const resolve = (ref, depth) => {
      if (depth > 8) return undefined;
      const u = unwrap(ref);
      const v = stringValue(u);
      if (v !== undefined) return v;
      if (!ts.isIdentifier(u)) return undefined;
      const d = keys.declOf(u);
      if (d && ts.isParameter(d)) {
        const link = site.chain.find((l) => l.fn === d.parent);
        const i = link ? link.fn.parameters.indexOf(d) : -1;
        return i >= 0 && link.call.arguments[i] ? resolve(link.call.arguments[i], depth + 1) : undefined;
      }
      if (d && ts.isVariableDeclaration(d) && ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const && d.initializer) return resolve(d.initializer, depth + 1);
      return undefined;
    };
    const all = new Set([...hosts.literals, ...hosts.refNodes.map((r) => resolve(r, 0))]);
    return all.size === 1 && !all.has(undefined) ? [...all][0] : undefined;
  };
  /**
   * may this site run MORE THAN ONCE? (#427 review M1′) Yes when the create, or any call it was reached through, sits
   * under a loop, in a callback passed to any call but a once-only test or hook or a plain function's value arrow
   * (`.map`, `forEach`, `it.each`, `beforeEach` all repeat), or in a named function the file also passes by name
   * (`xs.map(allow)`). Unsure counts as yes.
   */
  const repeats = (site) => {
    for (const node of [site.create, ...site.chain.map((l) => l.call)]) {
      for (let p = node.parent; p; p = p.parent) {
        if (ts.isIterationStatement(p, false)) return true;
        if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isCallExpression(p.parent) && p.parent.arguments.includes(p)) {
          // `relaxStepUpAround(db, () => post(...))`: a value arrow handed to a plain function is the call's value
          const wraps = isValueArrow(p) && ts.isIdentifier(p.parent.expression) && !TEST_FNS.has(p.parent.expression.text);
          if (!runsOnce(p.parent) && !wraps) return true;
        }
      }
      const named = namedFunctionOf(node);
      if (named) {
        const key = keys.keyOf(named.name);
        const passed = (n) =>
          (ts.isIdentifier(n) &&
            n !== named.name &&
            keys.keyOf(n) === key &&
            !(ts.isCallExpression(n.parent) && n.parent.expression === n)) ||
          ts.forEachChild(n, passed);
        if (passed(sf)) return true;
      }
    }
    return false;
  };
  const perSite = sites.map((site) => {
    const hosts = hostsOf(statementOf(site.create) ?? site.create, keys);
    const sources = (root) => site.results.some((r) => r === root || (ts.isCallExpression(root) && within(r, root)));
    const { names, accepted } = carriersOf(sf, sources, keys);
    return { site, hosts, carriers: names, accepted, row: rowOf(site, hosts), repeats: repeats(site) };
  });
  /**
   * does THIS site own the saved-id key `k`? (#427 review M1 and L1) Every write to `k`, or to a name it is read
   * through (`created` for `created.allowHosts`), must be its declaration's default, or carry the result of this
   * create, or of another create of the same row (the route upserts by host, so the binding names one row). A write
   * of anything else (`saved = undefined`, a constant), or of another row's create, leaves the earlier row unnamed.
   */
  const owns = (me, k) =>
    writes
      .filter((w) => w.keys.some((wk) => k === wk || k.startsWith(`${wk}.`)))
      .every((w) => {
        const by = perSite.filter((o) => o.accepted.has(w.node));
        if (by.length === 0) return w.decl;
        // a create that may run several times with a host the analysis cannot read writes several rows into one name
        if (me.repeats && me.row === undefined) return false;
        return by.every((o) => o === me || (me.row !== undefined && o.row === me.row));
      });
  const judged = perSite.map((me) => {
    const { site, hosts, carriers } = me;
    const ctx = siteContext(site.node, sf);
    // the marker may sit on the call of a function that creates, or on the creating statement inside it
    if (site.node !== site.create) {
      const inner = siteContext(site.create, sf);
      ctx.markedAfterAll ||= inner.markedAfterAll;
      ctx.markedRefused ||= inner.markedRefused;
    }
    const tracked = hosts.trackers.length > 0 && hosts.untracked === 0;
    const trackedBy = (reached) => tracked && hosts.trackers.every((t) => reached.trackers.has(t));
    const byId = [...carriers].some((k) => afterAll.ids.has(k) && owns(me, k));
    return { site, ctx, hosts, tracked, trackedBy, byId, line: line(site.node) };
  });
  const hostKeys = (j) => [...j.hosts.literals.map((h) => `lit:${h}`), ...j.hosts.refs];
  const sameHost = (a, b) => hostKeys(a).some((k) => hostKeys(b).includes(k));
  // a create is covered on its own when the helper removes exactly it
  const direct = (j) => {
    if (j.ctx.markedRefused) return true;
    if (!j.ctx.inTestBody) return j.trackedBy(afterAll) || j.byId;
    if (j.trackedBy(afterEach)) return true;
    // a marked create is file-scoped: its saved id, or its tracked host, is removed from an afterAll
    return j.ctx.markedAfterAll && (j.byId || j.trackedBy(afterAll));
  };
  const covered = judged.filter(direct);
  const untrackedTestCreates = [];
  const unmatchedMarkers = [];
  const uncoveredCreates = [];
  for (const j of judged) {
    if (covered.includes(j)) continue;
    // an upsert of a covered create's host in the same test, or a restore of a covered create's host
    if (j.ctx.inTestBody && j.ctx.markedAfterAll && covered.some((d) => d.ctx.test === j.ctx.test && sameHost(d, j))) continue;
    if (j.ctx.inTestBody && j.ctx.inFinally && covered.some((d) => sameHost(d, j))) continue;
    if (!j.ctx.inTestBody) uncoveredCreates.push(j.line);
    else if (j.ctx.markedAfterAll || j.ctx.inFinally) unmatchedMarkers.push(j.line);
    else untrackedTestCreates.push(j.line);
  }
  const uniq = (xs) => [...new Set(xs)].sort((a, b) => a - b);
  return {
    creates: createNodes.length > 0,
    createLines: uniq(createNodes.map(line)),
    cleansInAfterAll: afterAll.removals.length > 0,
    cleansInAfterEach: afterEach.removals.length > 0,
    uncoveredCreates: uniq(uncoveredCreates),
    untrackedTestCreates: uniq(untrackedTestCreates),
    unmatchedMarkers: uniq(unmatchedMarkers),
    dropsScratchDb: afterAll.dropsScratchDb,
  };
}

/** every *.test.ts under apps/gateway/src, relative to it */
export function gatewayTestFiles(base = root) {
  const dir = path.join(base, GATEWAY_SRC);
  return readdirSync(dir, { recursive: true })
    .map((p) => String(p).split(path.sep).join("/"))
    .filter((p) => p.endsWith(".test.ts") && !p.includes("node_modules/"))
    .sort();
}

/** leaks (create, no afterAll cleanup, not exempt) and stale exemptions */
export function findEgressAllowLeaks(base = root) {
  const files = gatewayTestFiles(base);
  const leaks = [];
  const stale = [];
  const creators = [];
  for (const rel of files) {
    const source = readFileSync(path.join(base, GATEWAY_SRC, rel), "utf8");
    const exempt = SCRATCH_DB_FILES.has(rel);
    // a file that never names the route or the table cannot create an entry; skip the parse
    const a =
      source.includes(ROUTE) || source.includes(TABLE)
        ? analyzeTestFile(source, rel)
        : { creates: false, createLines: [], uncoveredCreates: [], untrackedTestCreates: [], unmatchedMarkers: [], dropsScratchDb: false };
    if (a.creates) creators.push(rel);
    if (exempt) {
      if (!a.creates) stale.push(`${rel}: listed in SCRATCH_DB_FILES but creates no allow entry`);
      else if (!a.dropsScratchDb) stale.push(`${rel}: listed in SCRATCH_DB_FILES but no afterAll drops a scratch database`);
      continue;
    }
    if (a.uncoveredCreates.length > 0) {
      leaks.push(`${rel} (creates at line ${a.uncoveredCreates.join(", ")}, and no afterAll removes that entry through the helper)`);
    }
    if (a.untrackedTestCreates.length > 0) {
      leaks.push(`${rel} (a test creates an entry with no per-entry cleanup at line ${a.untrackedTestCreates.join(", ")})`);
    }
    if (a.unmatchedMarkers.length > 0) {
      leaks.push(`${rel} ('${FILE_SCOPED_MARKER}' or a finally restore at line ${a.unmatchedMarkers.join(", ")}, but no afterAll removal names that entry's saved id)`);
    }
  }
  for (const rel of SCRATCH_DB_FILES.keys()) if (!files.includes(rel)) stale.push(`${rel}: listed in SCRATCH_DB_FILES but no longer exists`);
  return { files, creators, leaks, stale };
}

function main() {
  const { files, creators, leaks, stale } = findEgressAllowLeaks();
  console.log(`gateway test files: ${files.length}; creating an egress allow entry: ${creators.length}`);
  for (const l of leaks) console.error(`  LEAKS AN EGRESS ALLOW ENTRY  ${l}`);
  for (const s of stale) console.error(`  STALE EXEMPTION  ${s}`);
  if (leaks.length > 0) {
    console.error(
      "\nEach entry above is created on the shared database and not removed through the shared\n" +
        "helper (src/testing/egress-allow-cleanup.ts). Save the id the create returns and remove it\n" +
        "with removeEgressAllowEntry(app, AUTH, { id: savedId }) in afterAll, asserting the result in\n" +
        "a finally (M-068). An entry a single test creates posts its host as\n" +
        "perTest.trackHost(...) of a const perTest = trackEgressAllowHosts(), removed in afterEach; a\n" +
        `file-scoped one created in a test carries '${FILE_SCOPED_MARKER}' and has its id removed\n` +
        `in afterAll; a POST the test expects refused carries '${REFUSED_MARKER}'. No other removal\n` +
        "shape counts (#427 review N1).",
    );
  }
  return leaks.length > 0 || stale.length > 0 ? 1 : 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    process.exit(main());
  } catch (e) {
    console.error("preflight-egress-allow-cleanup could not run:", e);
    process.exit(2);
  }
}
