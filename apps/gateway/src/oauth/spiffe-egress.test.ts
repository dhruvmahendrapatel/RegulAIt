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
 * fetch). A bare `fetch(`, `globalThis.fetch`, node:http(s), undici or a raw
 * socket in such a module fails this test.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** every non-test .ts under src that handles SPIFFE material */
function spiffeModules(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "testing") walk(p);
      } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && /spiffe/i.test(readFileSync(p, "utf8"))) {
        out.push(p);
      }
    }
  };
  walk(SRC);
  return out;
}

/** the raw outbound calls a SPIFFE module may not make; the guarded `.fetchImpl(` is not one */
const RAW_EGRESS: ReadonlyArray<readonly [string, RegExp]> = [
  ["bare fetch", /(?<![.\w$])fetch\s*\(/],
  ["globalThis.fetch", /\bglobalThis\s*\.\s*fetch\b/],
  ["node:http(s)", /from\s+["'](?:node:)?https?["']|require\(\s*["'](?:node:)?https?["']\s*\)/],
  ["undici", /from\s+["']undici["']/],
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
    expect(violations('import { request } from "undici";')).toEqual(["undici"]);
    expect(violations('import tls from "node:tls";')).toEqual(["raw socket"]);
    expect(violations('import { connect } from "node:tls";')).toEqual(["raw socket"]);
    expect(violations('import { BlockList, isIP } from "node:net";\nimport type { TLSSocket } from "node:tls";')).toEqual([]);
    expect(violations("const g = await guardConnectionCall(db, a); await g.fetchImpl(url);")).toEqual([]);
    expect(violations("// a bundle could be fetch(ed) one day\n/* fetch(x) */ const a = 1;")).toEqual([]);
  });
});
