/**
 * ADR-0053 — THE PUBLIC API CONTRACT, PROVED BY ATTACK.
 *
 * A published OpenAPI document is only worth something if it is impossible to
 * ship one that has quietly stopped describing the code. This suite is that
 * impossibility, and it is the actual deliverable of ADR-0053 — the document
 * itself is a build product.
 *
 * WHAT THIS FILE TRIES TO MAKE IMPOSSIBLE TO FAKE
 * ----------------------------------------------
 *  1. A ROUTE WITH NO SPEC ENTRY. Every route Fastify actually registered is
 *     checked against the stability registry. Add a route, forget the registry,
 *     and this goes red with the route named. There is no default tag and no
 *     "unclassified" bucket, because a default is how a surface gets published
 *     — or hidden — by accident.
 *  2. A SPEC ENTRY WITH NO ROUTE. The reverse: a registry line naming a route
 *     that was deleted or renamed. This is the failure mode that produces an
 *     SDK method calling a 404.
 *  3. A SPEC THAT LIES ABOUT AUTH. The document's `x-regulait-auth` is asserted
 *     against the gateway's ACTUAL enforcement over real HTTP, for one route of
 *     each class — an admin route (403s a non-admin), a user route (does not),
 *     a public route (works with no credential at all), and a SCIM route (which
 *     refuses a perfectly good user API key, because it is a separate trust
 *     path). A spec that says "user" on a route the gate 403s is worse than no
 *     spec: it is a support ticket generator.
 *  4. A STALE CHECKED-IN ARTIFACT. `docs/api/openapi.json` and the generated
 *     TypeScript client are re-rendered here and compared byte-for-byte. They
 *     are build products in the tree, so they can drift; this is what stops it.
 *  5. AN SDK THAT DOES NOT WORK. The generated client is instantiated against
 *     this very app instance and used to create and read a real user through
 *     real HTTP semantics — headers, JSON, status codes, error mapping.
 *
 * SHARED-STATE DISCIPLINE. This suite creates users (`oas-` prefixed) and one
 * API key. `afterAll` deletes exactly those, so the deployment ends the run as
 * it started. It writes no org-singleton state at all.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, eq, inArray, runMigrations, users, type Db } from "@regulait/db";
import { RegulAItApiError, RegulAItClient } from "@regulait/api-client";
import { buildApp } from "./app.js";
import {
  buildOpenApiDocument,
  openApiPath,
  operationIdFor,
  routeKey,
  stabilityCounts,
  ROUTE_DOCS,
  VERSIONING_POLICY,
} from "./openapi.js";
import { generateTypeScriptClient } from "./openapi-client-gen.js";
import { ROUTE_STABILITY, ROUTE_TAGS } from "./openapi-registry.js";
import { routeAuthClass } from "./route-classes.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const migrationsFolder = path.join(repoRoot, "packages/db/migrations");
const SPEC_FILE = path.join(repoRoot, "docs/api/openapi.json");
const CLIENT_FILE = path.join(repoRoot, "packages/api-client/src/generated.ts");
/** set to rewrite the two checked-in build products after an intentional change */
const WRITE = process.env.REGULAIT_WRITE_API_ARTIFACTS === "1";

const BOOT = "oas-bootstrap-token";
const ADMIN = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let memberAuth: { authorization: string };
let memberKey: string;
const createdUserIds: string[] = [];

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  await app.ready();

  const created = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: ADMIN,
    payload: { email: "oas-member@example.com", displayName: "OAS Member" },
  });
  expect(created.statusCode).toBe(201);
  const memberId = created.json().id as string;
  createdUserIds.push(memberId);
  const key = await app.inject({
    method: "POST",
    url: `/v1/users/${memberId}/keys`,
    headers: ADMIN,
    payload: { name: "oas-key" },
  });
  expect(key.statusCode).toBe(201);
  memberKey = key.json().token as string;
  memberAuth = { authorization: `Bearer ${memberKey}` };
}, 60_000);

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await app?.close();
});

// ===========================================================================
// 1. DRIFT — the deliverable
// ===========================================================================

describe("spec drift detection", () => {
  it("every registered route carries a stability tag", () => {
    const missing = app.routeInventory
      .map((r) => routeKey(r.method, r.url))
      .filter((k) => ROUTE_STABILITY[k] === undefined);
    expect(
      missing,
      `these routes exist but are absent from openapi-registry.ts. Add a line to ` +
        `ROUTE_STABILITY (and ROUTE_TAGS) tagging each one 'public-stable', ` +
        `'public-beta' or 'internal'. There is deliberately no default.`,
    ).toEqual([]);
  });

  it("every stability entry names a route that actually exists", () => {
    const live = new Set(app.routeInventory.map((r) => routeKey(r.method, r.url)));
    const orphans = Object.keys(ROUTE_STABILITY).filter((k) => !live.has(k));
    expect(
      orphans,
      "openapi-registry.ts names routes the gateway no longer registers — the " +
        "published spec (and the generated SDK) would advertise a 404.",
    ).toEqual([]);
  });

  it("every tagged route also carries a document tag", () => {
    const missing = Object.keys(ROUTE_STABILITY).filter((k) => ROUTE_TAGS[k] === undefined);
    expect(missing).toEqual([]);
  });

  it("every ROUTE_DOCS entry names a route that exists", () => {
    const live = new Set(app.routeInventory.map((r) => routeKey(r.method, r.url)));
    expect(Object.keys(ROUTE_DOCS).filter((k) => !live.has(k))).toEqual([]);
  });

  it("nothing is silently unclassified", () => {
    expect(stabilityCounts(app.routeInventory).unregistered).toBe(0);
  });

  it("the published document contains ONLY public routes, and every one of them", () => {
    const doc = buildOpenApiDocument(app.routeInventory);
    const paths = doc.paths as Record<string, Record<string, unknown>>;
    const rendered = new Set<string>();
    for (const [p, ops] of Object.entries(paths)) {
      for (const m of Object.keys(ops)) rendered.add(`${m.toUpperCase()} ${p}`);
    }
    const expectedPublic = app.routeInventory
      .filter((r) => ROUTE_STABILITY[routeKey(r.method, r.url)] !== "internal")
      .map((r) => `${r.method} ${openApiPath(r.url)}`);
    expect([...rendered].sort()).toEqual([...new Set(expectedPublic)].sort());

    // and no internal route leaked in
    const internal = app.routeInventory
      .filter((r) => ROUTE_STABILITY[routeKey(r.method, r.url)] === "internal")
      .map((r) => `${r.method} ${openApiPath(r.url)}`);
    for (const k of internal) expect(rendered.has(k)).toBe(false);
  });

  it("operation ids are unique — an SDK cannot have two methods with one name", () => {
    const doc = buildOpenApiDocument(app.routeInventory, { includeInternal: true });
    const ids: string[] = [];
    for (const ops of Object.values(doc.paths as Record<string, Record<string, { operationId: string }>>)) {
      for (const op of Object.values(ops)) ids.push(op.operationId);
    }
    expect(ids.length).toBe(new Set(ids).size);
  });

  it("operationIdFor is a pure function of method+path", () => {
    expect(operationIdFor("GET", "/v1/users/:userId/keys")).toBe(operationIdFor("get", "/v1/users/:userId/keys"));
    expect(operationIdFor("GET", "/v1/users")).not.toBe(operationIdFor("POST", "/v1/users"));
  });
});

// ===========================================================================
// 2. THE SPEC'S DECLARED AUTH == THE GATEWAY'S ACTUAL ENFORCEMENT
// ===========================================================================

describe("declared auth matches enforced auth", () => {
  const authOf = (doc: Record<string, unknown>, method: string, p: string) => {
    const paths = doc.paths as Record<string, Record<string, { "x-regulait-auth": string }>>;
    return paths[p]?.[method.toLowerCase()]?.["x-regulait-auth"];
  };

  it("the document's auth class is computed from the enforcing sets, for every route", () => {
    const doc = buildOpenApiDocument(app.routeInventory, { includeInternal: true });
    for (const r of app.routeInventory) {
      const declared = authOf(doc, r.method, openApiPath(r.url));
      expect(declared, `${r.method} ${r.url}`).toBe(routeAuthClass(r.method, r.url));
    }
  });

  it("an ADMIN route really does 403 a non-admin (spec says admin)", async () => {
    const doc = buildOpenApiDocument(app.routeInventory);
    expect(authOf(doc, "GET", "/v1/users")).toBe("admin");
    const res = await app.inject({ method: "GET", url: "/v1/users", headers: memberAuth });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("admin_only");
    // and the same route works for an admin, so the 403 was the gate and not a bug
    const ok = await app.inject({ method: "GET", url: "/v1/users", headers: ADMIN });
    expect(ok.statusCode).toBe(200);
  });

  it("a USER route really does admit a non-admin (spec says user)", async () => {
    const doc = buildOpenApiDocument(app.routeInventory);
    expect(authOf(doc, "GET", "/v1/me")).toBe("user");
    const res = await app.inject({ method: "GET", url: "/v1/me", headers: memberAuth });
    expect(res.statusCode).toBe(200);
    // ...and still refuses an anonymous caller, i.e. 'user' is not 'public'
    const anon = await app.inject({ method: "GET", url: "/v1/me" });
    expect(anon.statusCode).toBe(401);
  });

  it("a PUBLIC route really does work with no credential (spec says public)", async () => {
    const doc = buildOpenApiDocument(app.routeInventory);
    expect(authOf(doc, "GET", "/health")).toBe("public");
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    // a public operation must carry NO security requirement in the document
    const paths = doc.paths as Record<string, Record<string, { security: unknown[] }>>;
    expect(paths["/health"]!.get!.security).toEqual([]);
  });

  it("a SCIM route is a SEPARATE trust path — a valid user API key is refused there", async () => {
    const doc = buildOpenApiDocument(app.routeInventory, { includeInternal: true });
    expect(authOf(doc, "GET", "/scim/v2/Users")).toBe("scim-token");
    const paths = doc.paths as Record<string, Record<string, { security: Array<Record<string, unknown>> }>>;
    expect(Object.keys(paths["/scim/v2/Users"]!.get!.security[0]!)).toEqual(["scimToken"]);

    // the attack: a perfectly valid, non-revoked user API key presented to SCIM
    const res = await app.inject({ method: "GET", url: "/scim/v2/Users", headers: memberAuth });
    expect(res.statusCode).toBe(401);
    // and the ADMIN's credential fares no better — scim-token is not "admin+"
    const asAdmin = await app.inject({ method: "GET", url: "/scim/v2/Users", headers: ADMIN });
    expect(asAdmin.statusCode).toBe(401);
  });

  it("the spec is readable by any authenticated caller but internal routes are admin-only", async () => {
    const pub = await app.inject({ method: "GET", url: "/v1/openapi.json", headers: memberAuth });
    expect(pub.statusCode).toBe(200);
    expect(Object.keys(pub.json().paths)).not.toContain("/v1/licenses");

    const denied = await app.inject({
      method: "GET",
      url: "/v1/openapi.json?include=all",
      headers: memberAuth,
    });
    expect(denied.statusCode).toBe(403);

    const all = await app.inject({
      method: "GET",
      url: "/v1/openapi.json?include=all",
      headers: ADMIN,
    });
    expect(all.statusCode).toBe(200);
    expect(Object.keys(all.json().paths)).toContain("/v1/licenses");
    expect(all.json().paths["/v1/licenses"].post["x-regulait-guarantee"]).toBe("none");

    // and the spec itself is not readable without a credential at all
    const anon = await app.inject({ method: "GET", url: "/v1/openapi.json" });
    expect(anon.statusCode).toBe(401);
  });
});

// ===========================================================================
// 3. VERSIONING POLICY
// ===========================================================================

describe("versioning and deprecation policy", () => {
  it("is served as machine-readable data", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/api/versioning", headers: memberAuth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.major).toBe("v1");
    expect(body.scheme).toBe("url-path");
    expect(body.deprecationWindowDays["public-stable"]).toBe(365);
    expect(body.breakingChanges.length).toBeGreaterThan(0);
    expect(body.counts.unregistered).toBe(0);
  });

  it("every published route sits under a /v1 (or compat) path — the major is IN the path", () => {
    const doc = buildOpenApiDocument(app.routeInventory);
    for (const p of Object.keys(doc.paths as object)) {
      expect(
        p.startsWith("/v1/") || p === "/health" || p.startsWith("/mcp/"),
        `published path ${p} carries no major version`,
      ).toBe(true);
    }
  });

  it("the document embeds the same policy object the endpoint serves", () => {
    const doc = buildOpenApiDocument(app.routeInventory) as Record<string, unknown>;
    expect(doc["x-regulait-versioning"]).toBe(VERSIONING_POLICY);
  });
});

// ===========================================================================
// 4. THE CHECKED-IN BUILD PRODUCTS ARE NOT STALE
// ===========================================================================

describe("checked-in artifacts", () => {
  const render = () => JSON.stringify(buildOpenApiDocument(app.routeInventory), null, 2) + "\n";

  it("docs/api/openapi.json matches the live routes", () => {
    const fresh = render();
    if (WRITE) {
      mkdirSync(path.dirname(SPEC_FILE), { recursive: true });
      writeFileSync(SPEC_FILE, fresh);
    }
    const onDisk = readFileSync(SPEC_FILE, "utf8");
    expect(
      onDisk === fresh,
      "docs/api/openapi.json is stale. Regenerate with " +
        "REGULAIT_WRITE_API_ARTIFACTS=1 pnpm --filter @regulait/gateway exec vitest run src/openapi.test.ts",
    ).toBe(true);
  });

  it("the generated TypeScript client matches the spec", () => {
    const fresh = generateTypeScriptClient(buildOpenApiDocument(app.routeInventory));
    if (WRITE) writeFileSync(CLIENT_FILE, fresh);
    const onDisk = readFileSync(CLIENT_FILE, "utf8");
    expect(
      onDisk === fresh,
      "packages/api-client/src/generated.ts is stale. Regenerate with " +
        "REGULAIT_WRITE_API_ARTIFACTS=1 pnpm --filter @regulait/gateway exec vitest run src/openapi.test.ts",
    ).toBe(true);
  });

  it("the client exposes a method for every published operation and nothing more", () => {
    const doc = buildOpenApiDocument(app.routeInventory);
    const expected = new Set<string>();
    for (const ops of Object.values(doc.paths as Record<string, Record<string, { operationId: string }>>)) {
      for (const op of Object.values(ops)) expected.add(op.operationId);
    }
    const client = new RegulAItClient({ baseUrl: "http://x", apiKey: "rgl_x" });
    const proto = Object.getPrototypeOf(client) as object;
    const onClient = new Set(
      Object.getOwnPropertyNames(Object.getPrototypeOf(proto)).filter((n) => n !== "constructor"),
    );
    for (const id of expected) expect(onClient.has(id), `client is missing ${id}()`).toBe(true);
    // and no method for an internal route sneaked in
    expect([...onClient].filter((n) => !expected.has(n))).toEqual([]);
  });
});

// ===========================================================================
// 5. THE GENERATED CLIENT ACTUALLY WORKS
// ===========================================================================

describe("the generated client round-trips against a real endpoint", () => {
  /** route the client's fetch into this app instance — real headers, real
   * status codes, real JSON, no network. */
  const injectFetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const res = await app.inject({
      method: (init?.method ?? "GET") as "GET",
      url: url.pathname + url.search,
      headers: init?.headers as Record<string, string>,
      ...(init?.body ? { payload: String(init.body) } : {}),
    });
    return new Response(res.body, {
      status: res.statusCode,
      headers: res.headers as Record<string, string>,
    });
  };

  const adminClient = () =>
    new RegulAItClient({ baseUrl: "http://gateway.test", apiKey: BOOT, fetch: injectFetch });

  it("creates and reads a user through the typed methods", async () => {
    const client = adminClient();
    const created = await client.postV1Users<{ id: string; email: string }>({
      email: "oas-sdk@example.com",
      displayName: "SDK Created",
    });
    expect(created.email).toBe("oas-sdk@example.com");
    createdUserIds.push(created.id);

    const listed = await client.getV1Users<{ users: Array<{ id: string; email: string }> }>();
    expect(listed.users.some((u) => u.id === created.id)).toBe(true);

    const me = await client.getV1Me<{ isAdmin: boolean }>();
    expect(me.isAdmin).toBe(true);
  });

  it("sends the API key as an ADR-0025 Bearer token and nothing else", async () => {
    let seen: Record<string, string> = {};
    const spy: typeof globalThis.fetch = async (input, init) => {
      seen = (init?.headers ?? {}) as Record<string, string>;
      return injectFetch(input, init);
    };
    const client = new RegulAItClient({ baseUrl: "http://gateway.test", apiKey: BOOT, fetch: spy });
    await client.getV1Me();
    expect(seen.authorization).toBe(`Bearer ${BOOT}`);
  });

  it("a caller cannot override the Authorization header by accident", async () => {
    const client = new RegulAItClient({
      baseUrl: "http://gateway.test",
      apiKey: BOOT,
      fetch: injectFetch,
      defaultHeaders: { authorization: "Bearer not-a-real-token" },
    });
    // the real key wins, so this succeeds rather than 401ing
    const me = await client.getV1Me<{ isAdmin: boolean }>();
    expect(me.isAdmin).toBe(true);
  });

  it("maps a governance refusal to a typed error carrying the server's own body", async () => {
    const client = new RegulAItClient({
      baseUrl: "http://gateway.test",
      apiKey: memberKey,
      fetch: injectFetch,
    });
    await expect(client.getV1Users()).rejects.toBeInstanceOf(RegulAItApiError);
    const err = (await client.getV1Users().catch((e: unknown) => e)) as RegulAItApiError;
    expect(err.status).toBe(403);
    expect((err.body as { error: string }).error).toBe("admin_only");
  });

  it("exposure is not entitlement — the SDK grants nothing the gate would not", async () => {
    // the member's client can see the CONTRACT for POST /v1/users...
    const client = new RegulAItClient({
      baseUrl: "http://gateway.test",
      apiKey: memberKey,
      fetch: injectFetch,
    });
    const spec = await client.getV1OpenapiJson<{ paths: Record<string, unknown> }>();
    expect(Object.keys(spec.paths)).toContain("/v1/users");
    // ...and calling it is still refused, exactly as before the spec existed
    await expect(
      client.postV1Users({ email: "oas-nope@example.com", displayName: "Nope" }),
    ).rejects.toMatchObject({ status: 403 });
    const [row] = await db.select().from(users).where(eq(users.email, "oas-nope@example.com"));
    expect(row).toBeUndefined();
  });
});
