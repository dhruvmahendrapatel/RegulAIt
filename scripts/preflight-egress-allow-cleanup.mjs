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
 *  - A file CLEANS UP if a removal is reachable from an `afterAll` callback,
 *    directly or through functions declared in the same file. A removal is
 *    `.delete(egressAllowHosts)`, a request to `/v1/egress-allow-hosts/${id}`
 *    (the only route on that path is DELETE), or `removeEgressAllowEntry(...)`.
 *    A removal at the end of a test body does not count: a failing assertion
 *    before it skips it.
 *  - PER ENTRY (M-078 follow-up): a create INSIDE a test body (`it`/`test`)
 *    also needs a cleanup of its own, because the afterAll removal a file has
 *    for its shared loopback row says nothing about a second host a test
 *    allow-lists. It is accepted when the create is a restore inside a
 *    `finally` block, when its statement passes the host through
 *    `trackHost(...)` and an `afterEach` reaches a removal
 *    (`removeAll(...)` of the tracker, or any removal above), or when the
 *    statement carries the marker comment `egress-allow-cleanup: afterAll`
 *    (a file-scoped entry the file's afterAll removes) or
 *    `egress-allow-cleanup: refused` (a POST the test expects to be refused).
 *    The afterAll marker is not taken on trust: a removal statement reachable
 *    from afterAll must name what the marked statement created, by its host
 *    (the same string literal, or the same identifier, as the create's `host`)
 *    or by its result (the variable the statement declares, or a variable or
 *    list that result is assigned or pushed into, such as the recorded id).
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
const HELPER = "removeEgressAllowEntry";
/** the per-test tracker's removal (src/testing/egress-allow-cleanup.ts) */
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

const isRemoval = (node) =>
  isTableCall(node, "delete") ||
  (ts.isTemplateExpression(node) && node.head.text.startsWith(`${ROUTE}/`)) ||
  (ts.isCallExpression(node) && (calleeName(node) === HELPER || calleeName(node) === TRACKER_REMOVAL));

const isHook = (name) => (node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;
const isAfterAll = isHook("afterAll");
const isAfterEach = isHook("afterEach");

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

/** where a create sits relative to the test that runs it */
function createContext(node, sf) {
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
  let tracked = false;
  let marked = false;
  let markedAfterAll = false;
  if (stmt) {
    const scan = (n) => {
      if (ts.isCallExpression(n) && calleeName(n) === TRACKER_ADD) tracked = true;
      ts.forEachChild(n, scan);
    };
    scan(stmt);
    const leading = stmt.getFullText(sf).slice(0, stmt.getStart(sf) - stmt.getFullStart());
    markedAfterAll = leading.includes(FILE_SCOPED_MARKER);
    marked = markedAfterAll || leading.includes(REFUSED_MARKER);
  }
  return { inTestBody, inFinally, tracked, marked, markedAfterAll, stmt, test };
}

/**
 * Name resolution for the afterAll marker check (review L2): names are compared by the SYMBOL the TypeScript checker
 * binds them to, never by spelling, so a shadowed `host` or a reused result name `r` is a different name. A name the
 * file never declares (a global) keys by its spelling. A property chain keys as its root's key plus the property names
 * (`created.allowHosts`).
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
  const declOf = (node) => {
    const sym = ts.isIdentifier(node) ? symbolOf(node) : undefined;
    return sym?.valueDeclaration ?? sym?.declarations?.[0];
  };
  return { keyOf, declOf, symKey };
}

/** is this identifier a property NAME (`a.b`'s b, `{ b: 1 }`'s b), not a reference? */
const isPropertyName = (n) =>
  (ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) || (ts.isPropertyAssignment(n.parent) && n.parent.name === n);

/** the keys of every reference under a node: variables and property chains (`created.allowHosts`, and `created`) */
function refKeys(node, keys, out = new Set()) {
  if (ts.isIdentifier(node)) {
    if (!isPropertyName(node)) {
      const k = keys.keyOf(node);
      if (k) out.add(k);
    }
    return out;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const k = keys.keyOf(node);
    if (k) out.add(k);
  }
  ts.forEachChild(node, (c) => {
    refKeys(c, keys, out);
  });
  return out;
}

/** names bound by a declaration's name: `x`, `[row]`, `{ id }` */
function boundIdentifiers(name, out = []) {
  if (ts.isIdentifier(name)) out.push(name);
  else if (ts.isArrayBindingPattern(name) || ts.isObjectBindingPattern(name)) {
    for (const el of name.elements) if (ts.isBindingElement(el)) boundIdentifiers(el.name, out);
  }
  return out;
}

/**
 * what a create statement makes: the literal and variable keys of its `host` values, and the keys of the names it
 * declares. A payload passed by name (`const payload = { host }; post(url, payload)`) is read through its
 * object-literal declaration.
 */
function createdBy(stmt, keys) {
  const hostLiterals = [];
  const hostKeys = [];
  const followed = new Set();
  const scan = (n) => {
    if (ts.isIdentifier(n) && !isPropertyName(n) && !followed.has(n)) {
      followed.add(n);
      const d = keys.declOf(n);
      if (d && ts.isVariableDeclaration(d) && d.initializer && ts.isObjectLiteralExpression(d.initializer)) scan(d.initializer);
    }
    if (ts.isPropertyAssignment(n) && n.name.getText() === "host") {
      const v = stringValue(n.initializer);
      if (v !== undefined) hostLiterals.push(v);
      else hostKeys.push(...refKeys(n.initializer, keys));
    }
    if (ts.isShorthandPropertyAssignment(n) && n.name.text === "host") {
      const k = keys.keyOf(n.name);
      if (k) hostKeys.push(k);
    }
    ts.forEachChild(n, scan);
  };
  scan(stmt);
  const results = ts.isVariableStatement(stmt)
    ? stmt.declarationList.declarations.flatMap((d) => boundIdentifiers(d.name)).map((i) => keys.keyOf(i)).filter(Boolean)
    : [];
  return { hostLiterals, hostKeys, results };
}

/**
 * the keys a created result flows into: `x = <uses result>`, `const x = <uses result>`, `xs.push(<uses result>)`,
 * followed transitively (`const post = …; const first = await post(); id = first.json().id`)
 */
function carriersOf(sf, results, keys) {
  const names = new Set(results);
  if (names.size === 0) return names;
  const mentions = (node) => [...refKeys(node, keys)].some((k) => names.has(k));
  let grew = true;
  const add = (k) => {
    if (k && !names.has(k)) {
      names.add(k);
      grew = true;
    }
  };
  const visit = (n) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && mentions(n.right)) add(keys.keyOf(n.left));
    if (ts.isVariableDeclaration(n) && n.initializer && mentions(n.initializer)) for (const b of boundIdentifiers(n.name)) add(keys.keyOf(b));
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "push" && n.arguments.some(mentions)) {
      add(keys.keyOf(n.expression.expression));
    }
    ts.forEachChild(n, visit);
  };
  while (grew) {
    grew = false;
    visit(sf);
  }
  return names;
}

/**
 * What one removal names, by position (review R1): the host values it removes (`host:` property values, and what is
 * compared with `<table>.host`: `eq(t.host, x)`, `inArray(t.host, xs)`) and the ids it removes (`id:` property values,
 * what is compared with `<table>.id`, and the DELETE url template's substitutions). A literal counts only as a host
 * value; a reference counts only in its own position, so a host variable or a recorded id in a `note:` field names
 * nothing. A for-of loop variable in a position brings its iterable into that position (`for (const id of ids)`).
 * The removal is the whole call: a `db.delete(t).where(...)` chain, or the request carrying the DELETE url.
 */
function removalNames(node, keys) {
  let call = node;
  if (!ts.isCallExpression(call)) {
    while (call.parent && !ts.isCallExpression(call)) call = call.parent;
  }
  // the outermost call of a chain: a.delete(t).where(...) → the .where(...) call
  while (call.parent && ts.isPropertyAccessExpression(call.parent) && call.parent.parent && ts.isCallExpression(call.parent.parent)) {
    call = call.parent.parent;
  }
  const hostLiterals = new Set();
  const hostRefs = new Set();
  const idRefs = new Set();
  /** the references in one position, plus the iterable of each for-of loop variable among them */
  const collect = (expr, out) => {
    refKeys(expr, keys, out);
    const loops = (n) => {
      if (ts.isIdentifier(n) && !isPropertyName(n)) {
        const d = keys.declOf(n);
        const list = d && ts.isVariableDeclaration(d) ? d.parent : undefined;
        const loop = list && ts.isVariableDeclarationList(list) ? list.parent : undefined;
        if (loop && (ts.isForOfStatement(loop) || ts.isForInStatement(loop))) refKeys(loop.expression, keys, out);
      }
      ts.forEachChild(n, loops);
    };
    loops(expr);
  };
  const column = (a) => (ts.isPropertyAccessExpression(a) ? a.name.text : undefined);
  const scan = (n) => {
    if (ts.isPropertyAssignment(n) && n.name.getText() === "host") {
      const v = stringValue(n.initializer);
      if (v !== undefined) hostLiterals.add(v);
      else collect(n.initializer, hostRefs);
    }
    if (ts.isPropertyAssignment(n) && n.name.getText() === "id") collect(n.initializer, idRefs);
    if (ts.isShorthandPropertyAssignment(n) && n.name.text === "host") collect(n.name, hostRefs);
    if (ts.isShorthandPropertyAssignment(n) && n.name.text === "id") collect(n.name, idRefs);
    if (ts.isCallExpression(n)) {
      const cols = n.arguments.map(column);
      for (const [col, out] of [
        ["host", hostRefs],
        ["id", idRefs],
      ]) {
        if (!cols.includes(col)) continue;
        n.arguments.forEach((a, i) => {
          if (cols[i] === col) return;
          const v = stringValue(a);
          if (v !== undefined) {
            if (col === "host") hostLiterals.add(v);
          } else collect(a, out);
        });
      }
    }
    if (ts.isTemplateExpression(n) && n.head.text.startsWith(`${ROUTE}/`)) for (const sp of n.templateSpans) collect(sp.expression, idRefs);
    ts.forEachChild(n, scan);
  };
  scan(call);
  return { hostLiterals, hostRefs, idRefs };
}

/** does any afterAll removal name what the marked create made (by its host, or by its recorded result)? */
function removalNamesCreate(sf, stmt, removals, keys) {
  const { hostLiterals, hostKeys, results } = createdBy(stmt, keys);
  const carriers = carriersOf(sf, results, keys);
  return removals.some(
    (r) => hostLiterals.some((h) => r.hostLiterals.has(h)) || hostKeys.some((k) => r.hostRefs.has(k)) || [...carriers].some((k) => r.idRefs.has(k)),
  );
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
  const createLines = [];
  /** creates inside a test body, with what protects each */
  const testCreates = [];
  const afterAllBodies = [];
  const afterEachBodies = [];
  /** name → function-like nodes declared under that name anywhere in the file */
  const functions = new Map();
  const declare = (name, fn) => functions.set(name, [...(functions.get(name) ?? []), fn]);

  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (node) => {
    const route = stringValue(node);
    let creates = false;
    if (route === ROUTE && !ts.isLiteralTypeNode(node.parent)) {
      const method = methodNear(node);
      if (method === undefined || method === "POST") creates = true;
    }
    if (isTableCall(node, "insert")) creates = true;
    if (creates) {
      createLines.push(line(node));
      const ctx = createContext(node, sf);
      if (ctx.inTestBody) testCreates.push({ line: line(node), ...ctx });
    }
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
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // walk everything reachable from the hook callbacks, following calls to
  // functions declared in this file
  const reach = (bodies) => {
    const seen = new Set();
    const work = [...bodies];
    let removes = false;
    let dropsScratchDb = false;
    /** what each reachable removal names (see removalNames) */
    const removals = [];
    while (work.length > 0) {
      const fn = work.pop();
      if (seen.has(fn)) continue;
      seen.add(fn);
      const scan = (node) => {
        if (isRemoval(node)) {
          removes = true;
          removals.push(removalNames(node, keys));
        }
        // a scratch database dropped by the shared helper or by its own DROP DATABASE statement
        if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) && /\bDROP DATABASE\b/i.test(node.text)) dropsScratchDb = true;
        if (ts.isCallExpression(node)) {
          const name = calleeName(node);
          if (name === "dropScratchDatabase") dropsScratchDb = true;
          if (ts.isIdentifier(node.expression)) for (const f of functions.get(node.expression.text) ?? []) work.push(f);
        }
        // a function passed by name (closeAll([... drop ...]), arr.map(fn))
        if (ts.isIdentifier(node) && functions.has(node.text) && !ts.isCallExpression(node.parent)) {
          for (const f of functions.get(node.text)) work.push(f);
        }
        ts.forEachChild(node, scan);
      };
      scan(fn);
    }
    return { removes, dropsScratchDb, removals };
  };
  const afterAllReach = reach(afterAllBodies);
  const cleansInAfterEach = reach(afterEachBodies).removes;
  const untrackedTestCreates = testCreates
    .filter((c) => !c.inFinally && !c.marked && !(c.tracked && cleansInAfterEach))
    .map((c) => c.line);
  // an afterAll marker whose create no afterAll removal names (by host or by recorded result). A marked
  // upsert of a host another create in the SAME test records (same host literal or variable) is covered by it.
  const named = testCreates.filter((c) => c.stmt && removalNamesCreate(sf, c.stmt, afterAllReach.removals, keys));
  const hostKeys = (c) => {
    const { hostLiterals, hostKeys: vars } = createdBy(c.stmt, keys);
    return [...hostLiterals.map((h) => `lit:${h}`), ...vars];
  };
  const coveredBySibling = (c) => {
    const keys = hostKeys(c);
    return named.some((d) => d.test === c.test && hostKeys(d).some((k) => keys.includes(k)));
  };
  const unmatchedMarkers = [
    ...new Set(testCreates.filter((c) => !c.inFinally && c.markedAfterAll && !named.includes(c) && !coveredBySibling(c)).map((c) => c.line)),
  ];
  return {
    creates: createLines.length > 0,
    createLines,
    cleansInAfterAll: afterAllReach.removes,
    cleansInAfterEach,
    untrackedTestCreates,
    unmatchedMarkers,
    dropsScratchDb: afterAllReach.dropsScratchDb,
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
        : { creates: false, createLines: [], cleansInAfterAll: false, cleansInAfterEach: false, untrackedTestCreates: [], unmatchedMarkers: [], dropsScratchDb: false };
    if (a.creates) creators.push(rel);
    if (exempt) {
      if (!a.creates) stale.push(`${rel}: listed in SCRATCH_DB_FILES but creates no allow entry`);
      else if (!a.dropsScratchDb) stale.push(`${rel}: listed in SCRATCH_DB_FILES but no afterAll drops a scratch database`);
      continue;
    }
    if (a.creates && !a.cleansInAfterAll) leaks.push(`${rel} (creates at line ${a.createLines.join(", ")})`);
    else if (a.untrackedTestCreates.length > 0) {
      leaks.push(`${rel} (a test creates an entry with no per-entry cleanup at line ${a.untrackedTestCreates.join(", ")})`);
    } else if (a.unmatchedMarkers.length > 0) {
      leaks.push(`${rel} ('${FILE_SCOPED_MARKER}' at line ${a.unmatchedMarkers.join(", ")}, but no afterAll removal names that host or its recorded id)`);
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
      "\nEach file above adds an egress allow entry on the shared database and no afterAll\n" +
        "removes it. Record the id and remove it with removeEgressAllowEntry (src/testing/\n" +
        "egress-allow-cleanup.ts) in afterAll, asserting the result in a finally (M-068).\n" +
        "An entry a single test creates is passed through trackEgressAllowHosts().trackHost(...)\n" +
        "and removed in afterEach; a file-scoped one created in a test carries the comment\n" +
        `'${FILE_SCOPED_MARKER}', and a POST the test expects refused '${REFUSED_MARKER}'.`,
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
