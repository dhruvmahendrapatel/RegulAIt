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
  (ts.isCallExpression(node) && calleeName(node) === HELPER);

const isAfterAll = (node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "afterAll";

/** analyse one test file's source */
export function analyzeTestFile(source, fileName = "x.test.ts") {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const createLines = [];
  const afterAllBodies = [];
  /** name → function-like nodes declared under that name anywhere in the file */
  const functions = new Map();
  const declare = (name, fn) => functions.set(name, [...(functions.get(name) ?? []), fn]);

  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (node) => {
    const route = stringValue(node);
    if (route === ROUTE && !ts.isLiteralTypeNode(node.parent)) {
      const method = methodNear(node);
      if (method === undefined || method === "POST") createLines.push(line(node));
    }
    if (isTableCall(node, "insert")) createLines.push(line(node));
    if (isAfterAll(node)) {
      for (const a of node.arguments) if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) afterAllBodies.push(a);
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

  // walk everything reachable from an afterAll callback, following calls to
  // functions declared in this file
  const seen = new Set();
  const work = [...afterAllBodies];
  let cleansInAfterAll = false;
  let dropsScratchDb = false;
  while (work.length > 0) {
    const fn = work.pop();
    if (seen.has(fn)) continue;
    seen.add(fn);
    const scan = (node) => {
      if (isRemoval(node)) cleansInAfterAll = true;
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
  return { creates: createLines.length > 0, createLines, cleansInAfterAll, dropsScratchDb };
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
        : { creates: false, createLines: [], cleansInAfterAll: false, dropsScratchDb: false };
    if (a.creates) creators.push(rel);
    if (exempt) {
      if (!a.creates) stale.push(`${rel}: listed in SCRATCH_DB_FILES but creates no allow entry`);
      else if (!a.dropsScratchDb) stale.push(`${rel}: listed in SCRATCH_DB_FILES but no afterAll drops a scratch database`);
      continue;
    }
    if (a.creates && !a.cleansInAfterAll) leaks.push(`${rel} (creates at line ${a.createLines.join(", ")})`);
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
        "egress-allow-cleanup.ts) in afterAll, asserting the result in a finally (M-068).",
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
