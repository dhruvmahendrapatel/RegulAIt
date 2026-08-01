/**
 * LEGACY-vs-SPA CAPABILITY PARITY GATE.
 *
 * The two template-literal UIs (`apps/gateway/src/admin-portal.ts`,
 * `apps/gateway/src/app-ui.ts`) are slated for deletion. A previous attempt to
 * delete them was REVERTED because "the SPA is at parity" was asserted rather
 * than evidenced. This script is the evidence: it extracts, from source, what
 * each UI can actually make the gateway do, and reports anything the legacy
 * UIs can do that the SPA cannot.
 *
 * It compares THREE dimensions, because an endpoint list alone misses real
 * capability holes (a UI can call POST /v1/runs/:id/events and still be unable
 * to reassign a node):
 *
 *   1. ENDPOINT SHAPES     — `METHOD /path/:p`, resolved through string
 *                            concatenation, template literals and ternaries.
 *   2. RUN EVENT KINDS     — which `kind:` values are actually POSTed to
 *                            /v1/runs/:p/events. Deliberately keyed on
 *                            `kind: "x"` (a posted property) and NOT on
 *                            `ev.kind === "x"` (a timeline READ), so rendering
 *                            an event in a list never counts as driving it.
 *   3. REQUEST BODY KEYS   — the top-level keys of a request body literal, per
 *                            endpoint. This is what catches a payload-level
 *                            hole such as auto-advance accepting a per-node
 *                            `inputs` map in one UI but not the other.
 *
 * NON-GOALS / KNOWN LIMITS (stated honestly — this gate is only as good as its
 * limits are understood):
 *   - Only API surfaces (/v1, /auth, /mcp) are compared. UI navigation paths
 *     ("/app", "/ui/chat") are shells, not capabilities, and the two UIs live
 *     at different URLs by design.
 *   - A path expression that reaches the API client through a variable or a
 *     local helper cannot be resolved at the call site. Rather than report
 *     those as false gaps, each SPA file gets an ORPHAN-LITERAL FALLBACK: any
 *     API-path literal in the file that no resolved call consumed is credited
 *     against the methods whose call sites in that same file were unresolvable.
 *     The fallback runs on the SPA (coverage) side ONLY, and so can only ever
 *     REMOVE a reported gap, never invent one — running it on the legacy side
 *     would inflate the demand list with prose and documentation strings out
 *     of the template-literal HTML. Inferred entries are listed explicitly by
 *     `--verbose` and marked `~`, so every non-direct coverage claim in this
 *     gate is auditable by hand.
 *   - Dimensions 2 and 3 are scanned only in files that actually call the
 *     endpoint in question, so unrelated string matches cannot create credit.
 *
 * Usage:
 *   node scripts/parity-diff.mjs            # the gate: exits 1 if not at parity
 *   node scripts/parity-diff.mjs --verbose  # also print both full inventories
 *   node scripts/parity-diff.mjs --json     # machine-readable report
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const LEGACY_FILES = ["apps/gateway/src/admin-portal.ts", "apps/gateway/src/app-ui.ts"];
const SPA_DIR = "apps/web/src";

/** the API prefixes that represent a governed capability */
const API_PREFIX = /^\/(v1|auth|mcp)(\/|$)/;

/** the run-lifecycle verbs, mirrored from runEventSchema in @regulait/shared */
const RUN_EVENT_KINDS = [
  "start",
  "node_started",
  "node_submitted",
  "node_accepted",
  "node_failed",
  "retry_node",
  "reassign_node",
  "escalate_node",
  "abort",
];
const RUN_EVENTS_ENDPOINT = "POST /v1/runs/:p/events";

/** endpoints whose request-body keys are compared (dimension 3). Kept to the
 * run-driving surfaces, where the body IS the capability. */
const BODY_KEY_ENDPOINTS = new Set([
  "POST /v1/runs/:p/auto",
  "POST /v1/runs/:p/nodes/:p/dispatch",
]);

// ---------------------------------------------------------------------------
// expression resolution
// ---------------------------------------------------------------------------

/** split `s` on the given top-level separator chars, ignoring strings/nesting */
function topSplit(s, chars) {
  const parts = [];
  const seps = [];
  let depth = 0;
  let cur = "";
  let inStr = null;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (inStr) {
      cur += c;
      if (c === inStr && s[k - 1] !== "\\") inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      cur += c;
      continue;
    }
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth--;
    if (depth === 0 && chars.includes(c)) {
      parts.push(cur);
      seps.push(c);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return { parts, seps };
}

/**
 * Resolve a path expression to the candidate `/path/:p` shapes it can produce.
 * `${...}` interpolations and non-literal concatenation operands both collapse
 * to the `:p` placeholder; a ternary yields one candidate per branch.
 */
function resolvePath(expr) {
  const s = expr.trim().replace(/\$\{[^}]*\}/g, ":p");
  const { parts, seps } = topSplit(s, "?:");
  const alts = seps.includes("?") ? parts.slice(1) : [s];
  const out = [];
  for (const alt of alts) {
    const { parts: operands } = topSplit(alt, "+");
    let acc = "";
    for (const raw of operands) {
      const p = raw.trim();
      const m = p.match(/^(["'`])([\s\S]*)\1$/);
      acc += m ? m[2] : ":p";
    }
    const qi = acc.indexOf("?");
    if (qi >= 0) acc = acc.slice(0, qi); // drop the query string
    acc = acc.replace(/(:p)+/g, ":p").replace(/\/+$/, "") || "/";
    if (acc.startsWith("/")) out.push(acc);
  }
  return out;
}

/** read one argument starting at `k`, stopping at the top-level `,` or `)` */
function readArg(src, k) {
  let depth = 0;
  let inStr = null;
  let cur = "";
  for (; k < src.length; k++) {
    const c = src[k];
    if (inStr) {
      cur += c;
      if (c === inStr && src[k - 1] !== "\\") inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      cur += c;
      continue;
    }
    if ("([{".includes(c)) {
      depth++;
      cur += c;
      continue;
    }
    if (")]}".includes(c)) {
      if (depth === 0) break;
      depth--;
      cur += c;
      continue;
    }
    if (c === "," && depth === 0) break;
    cur += c;
  }
  return { text: cur, end: k };
}

/** the top-level keys of an object-literal expression: `{a, b: 1, ...(c ? {d:2} : {})}` */
function objectKeys(expr) {
  const s = expr.trim();
  if (!s.startsWith("{") || !s.endsWith("}")) return null;
  const { parts } = topSplit(s.slice(1, -1), ",");
  const keys = new Set();
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    if (p.startsWith("...")) {
      // a conditional spread contributes the keys of its object branches
      for (const inner of p.slice(3).matchAll(/\{([^{}]*)\}/g)) {
        for (const k of objectKeys(`{${inner[1]}}`) ?? []) keys.add(k);
      }
      continue;
    }
    const m = p.match(/^(?:(["'])([^"']+)\1|([A-Za-z_$][\w$]*))\s*(?::|$)/);
    if (m) keys.add(m[2] ?? m[3]);
  }
  return [...keys];
}

/** index of the `}` closing the `{` at `open` */
function findClose(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length - 1;
}

/**
 * The top-level keys of a request body argument. If the argument is a bare
 * identifier — the legacy auto-advance builds `const payload = {…}` and passes
 * it by name — the declaration is looked up in the same file, so a payload held
 * in a variable is not silently read as "this call sends no keys".
 */
function bodyKeysOf(src, expr) {
  const direct = objectKeys(expr);
  if (direct) return direct;
  const id = expr.trim().match(/^([A-Za-z_$][\w$]*)$/);
  if (!id) return null;
  const decl = new RegExp(`(?:const|let|var)\\s+${id[1]}\\s*(?::[^=]+)?=\\s*\\{`).exec(src);
  if (!decl) return null;
  const open = decl.index + decl[0].length - 1;
  return objectKeys(src.slice(open, findClose(src, open) + 1));
}

/**
 * Blank out comments so their contents can never be mistaken for source, while
 * preserving every offset (line numbers stay true).
 *
 * This has to be a real scanner, not a regex pair: a naive /\*...\*​/ strip
 * treats the `text/*` inside an <input accept="…"> string as a comment opener
 * and silently eats the rest of the file, which SILENTLY HIDES REAL CALLS and
 * would make this gate report false parity. So string, template-literal
 * (including `${}` nesting) and regex-literal contexts are all tracked.
 */
function stripComments(src) {
  const out = src.split("");
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== "\n") out[i] = " ";
  };
  // stack of enclosing contexts: "code" | "tpl"; braceDepth tracks `${}` exits
  const stack = [{ kind: "code", depth: 0 }];
  let prev = ""; // last significant char, for the regex-vs-division heuristic
  for (let i = 0; i < src.length; i++) {
    const top = stack[stack.length - 1];
    const c = src[i];
    if (top.kind === "tpl") {
      if (c === "\\") { i++; continue; }
      if (c === "`") { stack.pop(); prev = "`"; continue; }
      if (c === "$" && src[i + 1] === "{") { stack.push({ kind: "code", depth: 0 }); i++; continue; }
      continue;
    }
    // --- code context ---
    if (c === "{") { top.depth++; prev = c; continue; }
    if (c === "}") {
      if (top.depth === 0 && stack.length > 1) { stack.pop(); continue; } // end of `${}`
      top.depth--;
      prev = c;
      continue;
    }
    if (c === "`") { stack.push({ kind: "tpl" }); continue; }
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] === "\\") { j++; continue; }
        if (src[j] === q || src[j] === "\n") break;
      }
      i = j;
      prev = q;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      let j = src.indexOf("\n", i);
      if (j === -1) j = src.length;
      blank(i, j);
      i = j - 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let j = src.indexOf("*/", i + 2);
      j = j === -1 ? src.length : j + 2;
      blank(i, j);
      i = j - 1;
      continue;
    }
    if (c === "/" && /[(,=:[!&|?{};+\-*%~^]|^$/.test(prev)) {
      // a regex literal — skip its body so `/\/\//` cannot look like a comment
      let j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] === "\\") { j++; continue; }
        if (src[j] === "[") { while (j < src.length && src[j] !== "]") { if (src[j] === "\\") j++; j++; } continue; }
        if (src[j] === "/" || src[j] === "\n") break;
      }
      i = j;
      prev = "/";
      continue;
    }
    if (!/\s/.test(c)) prev = c;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// per-side extraction
// ---------------------------------------------------------------------------

/** call-expression name -> HTTP method, per UI generation */
const LEGACY_FNS = { get: "GET", post: "POST", patch: "PATCH", put: "PUT", del: "DELETE", ssePost: "POST" };
const SPA_FNS = {
  "api.get": "GET",
  "api.post": "POST",
  "api.patch": "PATCH",
  "api.put": "PUT",
  "api.del": "DELETE",
  ssePost: "POST",
};

function scanFile(file, fnMap, fallback) {
  const raw = fs.readFileSync(path.join(ROOT, file), "utf8");
  const src = stripComments(raw);
  const rel = file;
  /** endpointKey -> { sites:Set, bodyKeys:Set, inferred:boolean } */
  const endpoints = new Map();
  const resolvedPaths = new Set();
  const pendingMethods = new Set();
  const lineOf = (idx) => src.slice(0, idx).split("\n").length;

  const record = (method, p, idx, bodyKeys, inferred) => {
    if (!API_PREFIX.test(p)) return;
    const key = `${method} ${p}`;
    if (!endpoints.has(key))
      endpoints.set(key, { sites: new Set(), bodyKeys: new Set(), inferred: true });
    const e = endpoints.get(key);
    e.sites.add(`${path.basename(rel)}:${lineOf(idx)}`);
    if (!inferred) e.inferred = false;
    for (const k of bodyKeys ?? []) e.bodyKeys.add(k);
  };

  // --- pass 1: direct call sites -------------------------------------------
  const visit = (method, startIdx) => {
    const arg1 = readArg(src, startIdx);
    const paths = resolvePath(arg1.text).filter((p) => API_PREFIX.test(p));
    if (paths.length === 0) {
      pendingMethods.add(method);
      return;
    }
    let bodyKeys = null;
    if (src[arg1.end] === ",") bodyKeys = bodyKeysOf(src, readArg(src, arg1.end + 1).text);
    for (const p of paths) {
      resolvedPaths.add(p);
      record(method, p, startIdx, bodyKeys, false);
    }
  };

  for (const [fn, method] of Object.entries(fnMap)) {
    const re = new RegExp(`(?<![\\w.$])${fn.replace(/([$.])/g, "\\$1")}\\s*(?:<[^>()]*>)?\\s*\\(`, "g");
    let m;
    while ((m = re.exec(src))) visit(method, m.index + m[0].length);
  }
  // the legacy `api("PATCH", path, body)` escape hatch
  for (const m of src.matchAll(/\bapi\s*\(\s*("|')(GET|POST|PATCH|PUT|DELETE)\1\s*,/g)) {
    visit(m[2], m.index + m[0].length);
  }
  // raw fetch / EventSource
  for (const m of src.matchAll(/\bfetch\s*\(/g)) {
    const method = src.slice(m.index, m.index + 400).match(/method\s*:\s*["'](\w+)["']/);
    visit(method ? method[1].toUpperCase() : "GET", m.index + m[0].length);
  }
  for (const m of src.matchAll(/new EventSource\s*\(/g)) visit("GET", m.index + m[0].length);

  // --- pass 2: orphan-literal fallback -------------------------------------
  // Credit API-path literals that no resolved call consumed against the methods
  // whose call sites in THIS file could not be resolved (a path held in a
  // variable, or forwarded through a local helper). Marked inferred.
  if (fallback && pendingMethods.size > 0) {
    for (const m of src.matchAll(/(["'`])(\/(?:v1|auth|mcp)[^"'`\n]*)\1/g)) {
      for (const p of resolvePath(m[0])) {
        if (!API_PREFIX.test(p) || resolvedPaths.has(p)) continue;
        for (const method of pendingMethods) record(method, p, m.index, null, true);
      }
    }
  }

  // --- dimension 2: run event kinds ----------------------------------------
  const eventKinds = new Set();
  if ([...endpoints.keys()].includes(RUN_EVENTS_ENDPOINT)) {
    for (const m of src.matchAll(/\bkind\s*:\s*["'](\w+)["']/g)) {
      if (RUN_EVENT_KINDS.includes(m[1])) eventKinds.add(m[1]);
    }
  }

  return { endpoints, eventKinds };
}

function scanSide(files, fnMap, fallback = false) {
  const endpoints = new Map();
  const eventKinds = new Set();
  for (const f of files) {
    const r = scanFile(f, fnMap, fallback);
    for (const [k, v] of r.endpoints) {
      if (!endpoints.has(k)) endpoints.set(k, { sites: new Set(), bodyKeys: new Set(), inferred: true });
      const e = endpoints.get(k);
      for (const s of v.sites) e.sites.add(s);
      for (const b of v.bodyKeys) e.bodyKeys.add(b);
      if (!v.inferred) e.inferred = false;
    }
    for (const k of r.eventKinds) eventKinds.add(k);
  }
  return { endpoints, eventKinds };
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
// the legacy side is the DEMAND list — scanned with direct evidence only.
// the SPA side is the COVERAGE list — the orphan-literal fallback runs here,
// where it can only remove a gap, and every inferred credit is printed below.
const legacy = scanSide(LEGACY_FILES, LEGACY_FNS, false);
const spa = scanSide(walk(SPA_DIR).sort(), SPA_FNS, true);

const endpointGaps = [...legacy.endpoints.keys()].filter((k) => !spa.endpoints.has(k)).sort();
const eventGaps = [...legacy.eventKinds].filter((k) => !spa.eventKinds.has(k)).sort();
const bodyGaps = [];
for (const key of BODY_KEY_ENDPOINTS) {
  const l = legacy.endpoints.get(key);
  const s = spa.endpoints.get(key);
  if (!l || !s) continue;
  const missing = [...l.bodyKeys].filter((k) => !s.bodyKeys.has(k)).sort();
  if (missing.length) bodyGaps.push({ endpoint: key, missing });
}

if (args.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        legacyEndpoints: [...legacy.endpoints.keys()].sort(),
        spaEndpoints: [...spa.endpoints.keys()].sort(),
        legacyEventKinds: [...legacy.eventKinds].sort(),
        spaEventKinds: [...spa.eventKinds].sort(),
        endpointGaps,
        eventGaps,
        bodyGaps,
      },
      null,
      2,
    ),
  );
  process.exit(endpointGaps.length + eventGaps.length + bodyGaps.length ? 1 : 0);
}

const fmt = (m, e) => `  ${m.padEnd(52)} ${e.inferred ? "~" : " "} ${[...e.sites].slice(0, 2).join(", ")}`;
if (args.includes("--verbose")) {
  console.log(`LEGACY endpoints (${legacy.endpoints.size}):`);
  for (const k of [...legacy.endpoints.keys()].sort()) console.log(fmt(k, legacy.endpoints.get(k)));
  console.log(`\nSPA endpoints (${spa.endpoints.size}):`);
  for (const k of [...spa.endpoints.keys()].sort()) console.log(fmt(k, spa.endpoints.get(k)));
  console.log("");
}

console.log(`legacy: ${legacy.endpoints.size} endpoint shapes, ${legacy.eventKinds.size} run event kinds`);
console.log(`spa:    ${spa.endpoints.size} endpoint shapes, ${spa.eventKinds.size} run event kinds`);
console.log("");

console.log(`LEGACY-ONLY ENDPOINTS (${endpointGaps.length}):`);
for (const k of endpointGaps) console.log(`  ${k}   [${[...legacy.endpoints.get(k).sites].join(", ")}]`);
if (!endpointGaps.length) console.log("  (empty)");

console.log(`\nLEGACY-ONLY RUN EVENT KINDS (${eventGaps.length}):`);
for (const k of eventGaps) console.log(`  ${k}`);
if (!eventGaps.length) console.log("  (empty)");

console.log(`\nLEGACY-ONLY REQUEST BODY KEYS (${bodyGaps.length}):`);
for (const g of bodyGaps) console.log(`  ${g.endpoint}: ${g.missing.join(", ")}`);
if (!bodyGaps.length) console.log("  (empty)");

// Every SPA coverage claim that rests on the orphan-literal fallback rather
// than a resolved call site, and that a legacy UI also exercises — i.e. every
// place this gate is trusting inference to say "covered". Printed always, so
// the claim is never invisible.
const inferredCredits = [...spa.endpoints.entries()]
  .filter(([k, e]) => e.inferred && legacy.endpoints.has(k))
  .map(([k, e]) => `${k}  [${[...e.sites].join(", ")}]`)
  .sort();
console.log(`\nSPA COVERAGE CREDITED BY INFERENCE, NOT A RESOLVED CALL (${inferredCredits.length}) —`);
console.log("  verify these by hand; each is a path literal forwarded through a variable or helper:");
for (const c of inferredCredits) console.log(`  ~ ${c}`);
if (!inferredCredits.length) console.log("  (none)");

const total = endpointGaps.length + eventGaps.length + bodyGaps.length;
console.log(
  total === 0
    ? "\nPARITY: the SPA covers every capability the legacy UIs expose."
    : `\nNOT AT PARITY: ${total} legacy-only capabilit${total === 1 ? "y" : "ies"} remain.`,
);
process.exit(total === 0 ? 0 : 1);
