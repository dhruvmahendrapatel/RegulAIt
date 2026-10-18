/**
 * ADR-0188 S9 follow-up N1(a) (2026-10-17) — SPIFFE trust material never
 * arrives over a raw outbound call.
 *
 * Today the only source of a trust bundle is the stepped-up, audited upload
 * (S9 item 3); nothing fetches one. Decision 10 still allows a bundle to be
 * "uploaded or fetched", and a fetch is the kind of change that lands as a
 * one-line `fetch(url)`, outside the egress allow-list, unaudited, and able to
 * reach a metadata address. This source check refuses that: every gateway
 * module that handles SPIFFE material may reach the network only through the
 * egress guard (`guardConnectionCall(...)`, whose `fetchImpl` is the guarded
 * fetch). A bare `fetch` (called or aliased), `globalThis.fetch`,
 * node:http/https/http2, undici, a raw socket or a child process (curl), imported statically, through
 * `import()` or through `require()`, fails this test.
 *
 * The scan covers every gateway module that names SPIFFE, every module under
 * `oauth/` (where a helper the SPIFFE code calls would live, named or not) and
 * `packages/shared/src/identity/`. It is a tripwire, not the gate: the fetch
 * slice, when built, carries a behavioural test (ADR-0188 S9 follow-ups).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHARED_IDENTITY = path.resolve(SRC, "../../../packages/shared/src/identity");

/** every non-test .ts under `dir` that `take` accepts */
function sources(dir: string, take: (p: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "testing") walk(p);
      } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts") && take(p)) {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out;
}

/** the scanned modules: SPIFFE-naming gateway modules, all of oauth/, and the shared identity package */
function spiffeModules(): string[] {
  const named = sources(SRC, (p) => /spiffe/i.test(readFileSync(p, "utf8")));
  const oauth = sources(path.join(SRC, "oauth"), () => true);
  const shared = sources(SHARED_IDENTITY, () => true);
  return [...new Set([...named, ...oauth, ...shared])];
}

/** the raw outbound calls a SPIFFE module may not make; the guarded `.fetchImpl(` is not one */
const RAW_EGRESS: ReadonlyArray<readonly [string, RegExp]> = [
  // called or aliased (`const f = fetch`); an object key `fetch:` and `.fetchImpl` are not the global
  ["bare fetch", /(?<![.\w$])fetch\b(?!\s*:)/],
  ["globalThis.fetch", /\bglobalThis\s*\.\s*fetch\b/],
  // R4: a destructured global (`const { fetch: f } = globalThis`)
  ["destructured fetch", /\{[^}]*\bfetch\b[^}]*\}\s*=\s*(?:globalThis|global|self)\b/],
  // a value import (or re-export); `import type` is not egress
  ["node:http(s)", /^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["'](?:node:)?(?:https?|http2|child_process)["']/m],
  ["undici", /^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']undici["']/m],
  // a dynamic import or a require of any network module
  ["dynamic network import", /\b(?:import|require)\s*\(\s*["'](?:node:)?(?:https?|http2|undici|net|tls|dgram|child_process)["']\s*\)/],
  // R4: an `import()` whose specifier is not a literal cannot be checked, so it is refused
  ["dynamic import of a variable", /\bimport\s*\(\s*(?!["'`])/],
  // a whole-module import, or a connecting name; `BlockList`/`isIP` and type-only imports are not egress
  ["raw socket", /import\s+(?:\*\s+as\s+)?\w+\s+from\s+["'](?:node:)?(?:net|tls|dgram)["']|import\s+\{[^}]*\b(?:connect|createConnection|Socket|createSocket)\b[^}]*\}\s*from\s+["'](?:node:)?(?:net|tls|dgram)["']/],
];

/** code only: a comment that names `fetch(` is not a call */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function violations(src: string): string[] {
  const code = stripComments(src);
  return RAW_EGRESS.filter(([, re]) => re.test(code)).map(([name]) => name);
}

describe("SPIFFE modules reach the network only through the egress guard", () => {
  it("finds the SPIFFE modules (the scan is not vacuous)", () => {
    const names = spiffeModules().map((p) => path.relative(SRC, p).split(path.sep).join("/"));
    expect(names).toEqual(expect.arrayContaining(["oauth/spiffe-bundles.ts", "oauth/spiffe-trust-domains.ts", "oauth/x509.ts"]));
    expect(names.some((n) => n.includes("packages/shared/src/identity/"))).toBe(true);
  });

  it("none makes a raw outbound call", () => {
    const found = spiffeModules()
      .map((p) => ({ file: path.relative(SRC, p), raw: violations(readFileSync(p, "utf8")) }))
      .filter((v) => v.raw.length > 0);
    expect(found).toEqual([]);
  });

  it("negative controls: each raw form is caught, and the guarded form is not", () => {
    expect(violations("const r = await fetch(bundleUrl);")).toEqual(["bare fetch"]);
    expect(violations("const f = globalThis.fetch; await f(u);")).toEqual(["globalThis.fetch"]);
    expect(violations('import https from "node:https";')).toEqual(["node:http(s)"]);
    expect(violations('import { connect } from "node:http2";')).toEqual(["node:http(s)"]);
    expect(violations("const f = fetch; await f(u);")).toEqual(["bare fetch"]);
    expect(violations("const { request } = await import(\"node:https\");")).toEqual(["dynamic network import"]);
    expect(violations("const http2 = await import('http2');")).toEqual(["dynamic network import"]);
    expect(violations('const { request } = require("undici");')).toEqual(["dynamic network import"]);
    expect(violations('const h = require("node:http");')).toEqual(["dynamic network import"]);
    // R4
    expect(violations("const { fetch: f } = globalThis; await f(u);")).toEqual(["destructured fetch"]);
    expect(violations('const cp = await import("node:child_process");')).toEqual(["dynamic network import"]);
    expect(violations('import { execFile } from "node:child_process";')).toEqual(["node:http(s)"]);
    expect(violations("const m = await import(moduleName);")).toEqual(["dynamic import of a variable"]);
    expect(violations("const deps = { fetch: g.fetchImpl };")).toEqual([]);
    expect(violations('import type { IncomingMessage } from "node:http";')).toEqual([]);
    expect(violations('import { request } from "undici";')).toEqual(["undici"]);
    expect(violations('import tls from "node:tls";')).toEqual(["raw socket"]);
    expect(violations('import { connect } from "node:tls";')).toEqual(["raw socket"]);
    expect(violations('import { BlockList, isIP } from "node:net";\nimport type { TLSSocket } from "node:tls";')).toEqual([]);
    expect(violations("const g = await guardConnectionCall(db, a); await g.fetchImpl(url);")).toEqual([]);
    expect(violations("// a bundle could be fetch(ed) one day\n/* fetch(x) */ const a = 1;")).toEqual([]);
  });
});
