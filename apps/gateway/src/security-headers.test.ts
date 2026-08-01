/**
 * ADR-0031 item 5 — CSP + the rest of the security headers, from the gateway
 * itself (it serves the SPA and is directly reachable, so it cannot delegate
 * these to an edge proxy).
 *
 * The load-bearing test is the last one: it serves the REAL built SPA bundle
 * and checks the document against the CSP the gateway actually emitted —
 * every inline script must be covered by a hash source, every external
 * script/stylesheet must be same-origin (so `'self'` covers it), and the
 * assets it names must really be there. That is a static evaluation of the
 * policy rather than a browser, but it is the failure a browser would report:
 * a blank page because the pre-paint script was blocked.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { documentCsp, inlineScriptBodies, sha256Source } from "./security-headers.js";
import { defaultWebDistDir } from "./web-serving.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "sec-headers-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;

const DIST = defaultWebDistDir();
const SPA_BUILT = existsSync(path.join(DIST, "index.html"));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
});

afterAll(async () => {
  await app.close();
});

/** parse a CSP header into directive -> source list */
function parseCsp(header: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of header.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out[name] = sources;
  }
  return out;
}

describe("ADR-0031: security headers on every response", () => {
  it("sets nosniff / frame-ancestors / referrer-policy / COOP+CORP on an API response", async () => {
    const res = await app.inject({ method: "GET", headers: AUTH, url: "/v1/users" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(res.headers["permissions-policy"]).toContain("camera=()");

    // a JSON response can never legitimately load anything
    const csp = parseCsp(res.headers["content-security-policy"] as string);
    expect(csp["default-src"]).toEqual(["'none'"]);
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
    expect(csp["base-uri"]).toEqual(["'none'"]);
  });

  it("covers unauthenticated and error responses too", async () => {
    for (const url of ["/health", "/v1/users", "/nope-does-not-exist"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.headers["content-security-policy"], url).toBeTruthy();
      expect(res.headers["x-content-type-options"], url).toBe("nosniff");
    }
  });

  it("does not announce HSTS over a plaintext hop", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["strict-transport-security"]).toBeUndefined();
  });

  it("never overwrites a header a route already chose", async () => {
    // web-serving.ts sets nosniff itself; the hook must leave it alone rather
    // than emitting a second, possibly conflicting value
    const res = await app.inject({ method: "GET", url: "/ui" });
    const raw = res.headers["x-content-type-options"];
    expect(Array.isArray(raw) ? raw : [raw]).toEqual(["nosniff"]);
  });

  it("the streamed CSV export carries them too (reply.hijack() bypasses onSend)", async () => {
    const res = await app.inject({ method: "GET", headers: AUTH, url: "/v1/audit.csv" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("the document CSP never surrenders script-src to 'unsafe-inline'", () => {
    // ADR-0033 deleted the /legacy/* shells this used to be asserted against;
    // the document policy itself is asserted directly so the shape stays
    // covered even when no SPA bundle is present to serve. The bundle-served
    // version of this (every inline script really covered by a hash) is the
    // load-bearing test in the next describe.
    const csp = parseCsp(documentCsp());
    expect(csp["script-src"]).toContain("'self'");
    expect(csp["script-src"]).not.toContain("'unsafe-inline'");
    expect(csp["script-src"]).not.toContain("'unsafe-eval'");
    expect(csp["object-src"]).toEqual(["'none'"]);
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
    expect(csp["base-uri"]).toEqual(["'self'"]);
    expect(csp["default-src"]).toEqual(["'self'"]);
  });
});

describe("ADR-0031: the real SPA bundle satisfies the CSP the gateway emits", () => {
  it.skipIf(!SPA_BUILT)("every inline script is hashed and every subresource is same-origin", async () => {
    const res = await app.inject({ method: "GET", url: "/ui" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");

    const csp = parseCsp(res.headers["content-security-policy"] as string);
    const scriptSrc = csp["script-src"] ?? [];
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");

    // the theme pre-paint script (and anything else inline) must be allowed,
    // or the SPA renders with the wrong theme / not at all
    const inline = inlineScriptBodies(res.body);
    expect(inline.length).toBeGreaterThan(0);
    for (const body of inline) expect(scriptSrc).toContain(sha256Source(body));

    // every external subresource must be same-origin so 'self' covers it
    const srcs = [...res.body.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]!);
    const hrefs = [...res.body.matchAll(/<link\b[^>]*\bhref="([^"]+)"/gi)].map((m) => m[1]!);
    expect(srcs.length).toBeGreaterThan(0);
    for (const url of [...srcs, ...hrefs]) {
      expect(url.startsWith("/"), `${url} must be same-origin`).toBe(true);
      expect(/^\/\//.test(url), `${url} must not be protocol-relative`).toBe(false);
    }

    // ...and they are really served, with the same headers
    for (const url of [...srcs, ...hrefs]) {
      const asset = await app.inject({ method: "GET", url });
      expect(asset.statusCode, url).toBe(200);
      expect(asset.headers["x-content-type-options"], url).toBe("nosniff");
    }

    // the SPA talks to its own origin only, so connect-src 'self' is enough
    expect(csp["connect-src"]).toEqual(["'self'"]);
    // disclosed relaxation, pinned so tightening it later is a deliberate act
    expect(csp["style-src"]).toContain("'unsafe-inline'");
  });
});
