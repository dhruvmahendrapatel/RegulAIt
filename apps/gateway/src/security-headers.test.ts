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
import { DEFAULT_HSTS, HSTS_ENV, describeHsts, resolveHsts } from "./hsts.js";
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

// ---------------------------------------------------------------------------
// ADR-0029 amendment (2026-08-01) — HSTS has exactly ONE owner: this gateway.
//
// Before: `infra/caddy/Caddyfile` abstained with a long comment saying HSTS was
// deliberately OFF, while ADR-0031 item 5 had the gateway sending a flat
// `max-age=31536000; includeSubDomains` on every secure response. The deployed
// box therefore announced a one-year pin that the ADR argued must not exist.
//
// After: the gateway owns it (it is what ships into BYOC/air-gapped installs
// where no Caddy of ours exists), the value comes from REGULAIT_HSTS, and the
// default is a bounded one day with NO includeSubDomains and NO preload. These
// tests pin the default, because the default is what the ADR promises.
// ---------------------------------------------------------------------------
describe("ADR-0029 amendment: the gateway owns Strict-Transport-Security", () => {
  /** the address REGULAIT_TRUSTED_PROXIES names — Caddy, in the real stack */
  const PROXY = "172.28.0.2";
  /** exactly what Caddy sends upstream for a TLS request */
  const TLS_HOP = {
    remoteAddress: PROXY,
    headers: { "x-forwarded-proto": "https" },
  } as const;

  const built: ReturnType<typeof buildApp>[] = [];
  const mk = (hsts?: string | null) => {
    const a = buildApp(db, { bootstrapToken: BOOT, trustProxy: [PROXY], ...(hsts !== undefined ? { hsts } : {}) });
    built.push(a);
    return a;
  };

  afterAll(async () => {
    for (const a of built) await a.close();
  });

  it("sends the ADR's default — one day, host-scoped — on a genuinely secure hop", async () => {
    const res = await mk().inject({ method: "GET", url: "/health", ...TLS_HOP });
    expect(res.statusCode).toBe(200);
    // the value the ADR-0029 amendment commits to, asserted exactly
    expect(res.headers["strict-transport-security"]).toBe(DEFAULT_HSTS);
    expect(DEFAULT_HSTS).toBe("max-age=86400");
  });

  it("the default claims no subdomains and requests no preload", async () => {
    const res = await mk().inject({ method: "GET", url: "/health", ...TLS_HOP });
    const value = String(res.headers["strict-transport-security"]);
    // sslip.io resolves ANY label prefix to the same IP, so includeSubDomains
    // would claim a namespace that follows the address to its next owner —
    // and we serve no subdomains, so it buys this deployment nothing.
    expect(value.toLowerCase()).not.toContain("includesubdomains");
    // preload is effectively irreversible and must never be implied
    expect(value.toLowerCase()).not.toContain("preload");
    // NOT the pre-amendment value, which is the whole point of the change
    expect(value).not.toBe("max-age=31536000; includeSubDomains");
  });

  it("sends nothing at all when the deployment turns it off", async () => {
    const off = mk(null);
    const secure = await off.inject({ method: "GET", url: "/health", ...TLS_HOP });
    expect(secure.statusCode).toBe(200);
    expect(secure.headers["strict-transport-security"]).toBeUndefined();
    // the rest of the header set is untouched by the HSTS decision
    expect(secure.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sends a configured value verbatim — the real-domain case", async () => {
    const strict = mk("max-age=31536000; includeSubDomains");
    const res = await strict.inject({ method: "GET", url: "/health", ...TLS_HOP });
    expect(res.headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  });

  it("never rides a plaintext hop, whatever the setting is", async () => {
    for (const value of [undefined, "max-age=31536000; includeSubDomains"] as const) {
      const a = value === undefined ? mk() : mk(value);
      const plain = await a.inject({ method: "GET", url: "/health" });
      expect(plain.headers["strict-transport-security"]).toBeUndefined();
      // ...and a forged x-forwarded-proto from an UNTRUSTED peer is not a
      // secure hop either (ADR-0031 item 3 — same trust gate as the cookie's
      // Secure flag). Announcing HSTS on an attacker's say-so would let them
      // pin a host we may not be able to serve over TLS.
      const forged = await a.inject({
        method: "GET",
        url: "/health",
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-proto": "https" },
      });
      expect(forged.headers["strict-transport-security"]).toBeUndefined();
    }
  });

  describe("resolveHsts / REGULAIT_HSTS", () => {
    it("defaults to the bounded value when the variable is unset", () => {
      expect(resolveHsts({})).toBe(DEFAULT_HSTS);
    });

    it("treats the off-spellings as off", () => {
      for (const raw of ["off", "OFF", "none", "false", "0", "no", "disabled", "", "  "]) {
        expect(resolveHsts({ [HSTS_ENV]: raw }), raw).toBeNull();
      }
    });

    it("passes a valid value through, trimmed", () => {
      expect(resolveHsts({ [HSTS_ENV]: "max-age=0" })).toBe("max-age=0");
      expect(resolveHsts({ [HSTS_ENV]: "  max-age=63072000; includeSubDomains  " })).toBe(
        "max-age=63072000; includeSubDomains",
      );
      expect(resolveHsts({ [HSTS_ENV]: "max-age=63072000; includeSubDomains; preload" })).toBe(
        "max-age=63072000; includeSubDomains; preload",
      );
    });

    it("throws on a malformed value rather than silently sending nothing", () => {
      // a browser IGNORES a malformed HSTS header, so the quiet failure mode is
      // an operator who believes they have HSTS and does not
      for (const raw of ["1 year", "max-age", "max-age=abc", "includeSubDomains", "max-age=10; nonsense"]) {
        expect(() => resolveHsts({ [HSTS_ENV]: raw }), raw).toThrow(/REGULAIT_HSTS/);
      }
    });

    it("describes the posture loudly enough to notice in a boot log", () => {
      expect(describeHsts(null)).toContain("OFF");
      expect(describeHsts(DEFAULT_HSTS)).toContain(DEFAULT_HSTS);
      // the default is unremarkable and carries no warnings
      expect(describeHsts(DEFAULT_HSTS)).not.toContain("[");
      const loud = describeHsts("max-age=31536000; includeSubDomains; preload");
      expect(loud).toContain("PRELOAD");
      expect(loud).toContain("includeSubDomains");
      expect(loud).toContain("non-revocable");
    });
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
