/**
 * /ui web-serving (ADR-0026): index + assets + SPA fallback + 503-when-unbuilt
 * + traversal containment + NO auth bypass — static serving must never shadow
 * /v1 or /auth. Runs against the full buildApp() so every gateway hook
 * (interception gate, auth, admin gate) is live exactly as in production.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "test-bootstrap-token";

let db: Db;
let distDir: string;
let app: ReturnType<typeof buildApp>;
let unbuiltApp: ReturnType<typeof buildApp>;

const INDEX_HTML = "<!doctype html><title>RegulAIt</title><div id=root></div>";
const ASSET_JS = "console.log('regulait spa');";

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);

  // a fake built bundle: index.html + a hashed asset
  distDir = mkdtempSync(path.join(tmpdir(), "regulait-web-dist-"));
  writeFileSync(path.join(distDir, "index.html"), INDEX_HTML);
  mkdirSync(path.join(distDir, "assets"));
  writeFileSync(path.join(distDir, "assets", "index-abc123.js"), ASSET_JS);

  process.env.REGULAIT_WEB_DIST = distDir;
  app = buildApp(db, { bootstrapToken: BOOT });

  // a second app pointed at a directory that has never been built
  process.env.REGULAIT_WEB_DIST = path.join(distDir, "does-not-exist");
  unbuiltApp = buildApp(db, { bootstrapToken: BOOT });
  delete process.env.REGULAIT_WEB_DIST;
});

afterAll(async () => {
  await app?.close();
  await unbuiltApp?.close();
  rmSync(distDir, { recursive: true, force: true });
  await (db.$client as { end: () => Promise<void> }).end();
});

describe("GET /ui — the SPA shell", () => {
  it("serves index.html with no-cache and html content type", async () => {
    const res = await app.inject({ method: "GET", url: "/ui" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.body).toBe(INDEX_HTML);
  });

  it("requires no credential (a browser has none before login)", async () => {
    // deliberately no Authorization header, no cookie
    const res = await app.inject({ method: "GET", url: "/ui" });
    expect(res.statusCode).toBe(200);
  });

  it("serves hashed assets with immutable caching and the right type", async () => {
    const res = await app.inject({ method: "GET", url: "/ui/assets/index-abc123.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/javascript");
    expect(res.headers["cache-control"]).toContain("immutable");
    expect(res.body).toBe(ASSET_JS);
  });

  it("falls back to index.html for SPA client routes", async () => {
    for (const url of ["/ui/login", "/ui/runs/0f0e0d0c-1b2a-4c3d-8e9f-a0b1c2d3e4f5", "/ui/inbox"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toBe(INDEX_HTML);
    }
  });

  it("refuses path traversal — never a byte from outside dist", async () => {
    const res = await app.inject({ method: "GET", url: "/ui/..%2f..%2f..%2fetc%2fpasswd" });
    // containment resolves to the SPA fallback, not a file read
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX_HTML);
  });

  it("answers 503 web_bundle_not_built when dist is absent — never a blank page", async () => {
    for (const url of ["/ui", "/ui/login", "/ui/assets/index-abc123.js"]) {
      const res = await unbuiltApp.inject({ method: "GET", url });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("web_bundle_not_built");
      expect(res.json().detail).toContain("legacy UI remains at /app");
    }
  });
});

describe("no auth bypass — /ui serving never shadows the API surface", () => {
  it("unauthenticated /v1 requests still 401 (not index.html)", async () => {
    for (const url of ["/v1/me", "/v1/runs", "/v1/approvals", "/v1/users"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("unauthenticated");
    }
  });

  it("unauthenticated /auth/me still 401s; the login endpoints still enforce CSRF", async () => {
    const me = await app.inject({ method: "GET", url: "/auth/me" });
    expect(me.statusCode).toBe(401);
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "a@b.c", password: "x" },
    });
    expect(login.statusCode).toBe(403);
    expect(login.json().error).toBe("csrf_header_required");
  });

  it("the bootstrap credential still works beside /ui (API path unchanged)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${BOOT}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isAdmin).toBe(true);
  });

  it("phase-2 swap: / , /app and /admin all redirect to the SPA at /ui", async () => {
    for (const url of ["/", "/app", "/admin"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/ui");
    }
  });

  it("legacy shells stay reachable for one release at /legacy/*, labeled deprecated", async () => {
    for (const url of ["/legacy/app", "/legacy/admin"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain("Deprecated");
      expect(res.body).toContain('href="/ui"');
      expect(res.body).not.toBe(INDEX_HTML);
    }
  });

  it("POST /ui is not a registered route — it never serves the SPA", async () => {
    // an unmatched method behaves like ANY unmatched gateway route: the auth
    // hook answers first (401), and no HTML is ever served
    const res = await app.inject({ method: "POST", url: "/ui" });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("<!doctype");
    const withCred = await app.inject({
      method: "POST",
      url: "/ui",
      headers: { authorization: `Bearer ${BOOT}` },
    });
    expect(withCred.statusCode).toBe(404);
  });
});
