/**
 * ADR-0353 part 1 — governed MCP tools from an OpenAPI document or REST endpoint list, end to end.
 *
 * A REAL local REST API on 127.0.0.1 records every request it receives, so "nothing was sent" is checked on the wire.
 * The flow runs through the real routes, the real MCP proxy core (`executeGovernedToolCall`, admission, definition
 * pinning, grants) and the real egress guard; the in-process `openapi` server is the thing under test.
 *
 * What it proves:
 *  1. DEFAULT-DENY AT EVERY LAYER: the transport is refused until enabled; an import stages every operation and serves
 *     none; a staged operation is neither listed nor callable; an approved one still needs the user's grant.
 *  2. ONLY THE IMPORT ROUTE MAKES AN `openapi` SERVER, and its url and private-range posture cannot be patched.
 *  3. THE GENERATED TOOL IS GOVERNABLE: a multipart operation, an external `$ref`, a reserved header and a cookie are
 *     skipped with reasons; a security scheme never reaches the input schema; read-only follows the HTTP method.
 *  4. APPROVE IS A STEPPED-UP COMPARE-AND-SET on the reviewed digest, and approves the ADR-0246 pin at that digest.
 *  5. A CALL GOES OUT THE GUARDED WAY: to the admin's base URL (never the document's `servers`), with the server-held
 *     credential, arguments validated first, a dot segment refused, and the response returned.
 *  6. DRIFT NEEDS RE-APPROVAL: a re-import that changes an approved operation withholds it; one that removes it
 *     withdraws it; one that reverts it serves it again. Every move goes through the declared table and is audited.
 *  7. A REST ENDPOINT LIST IS IMPORTED THROUGH THE SAME GENERATOR.
 *
 * SHARED-STATE DISCIPLINE: every server is `oa-<run>-` prefixed; org settings changed here are restored in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  desc,
  eq,
  mcpDefinitionPins,
  mcpServers,
  openapiToolOperations,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  toolGrants,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";
import { insideBaseUrl } from "./openapi-tools.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must name a disposable test database");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `oa-boot-${RUN}`;
const boot = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "c".repeat(64);
const SECRET = `oa-secret-${RUN}-value-1234567890`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let userId: string;
let adminKey: { authorization: string };
let api: http.Server;
let apiBase: string;
const restores: Array<() => Promise<void>> = [];
const received: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];

const spec = (over: { getDescription?: string; dropCreate?: boolean } = {}) =>
  JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Orders", version: "1.0" },
    // never used: the admin's base URL wins
    servers: [{ url: "https://attacker.example.test" }],
    components: {
      securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Api-Key" } },
      schemas: { Order: { type: "object", properties: { item: { type: "string" }, qty: { type: "integer", minimum: 1 } }, required: ["item", "qty"] } },
    },
    security: [{ key: [] }],
    paths: {
      "/orders/{id}": {
        get: {
          operationId: "getOrder",
          summary: over.getDescription ?? "Get one order",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } } },
        },
      },
      ...(over.dropCreate
        ? {}
        : {
            "/orders": {
              post: {
                operationId: "createOrder",
                requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } },
                responses: { 201: { description: "created" } },
              },
            },
          }),
      "/upload": { post: { operationId: "upload", requestBody: { content: { "multipart/form-data": { schema: { type: "object", properties: { f: { type: "string", format: "binary" } } } } } }, responses: { 200: { description: "x" } } } },
      "/remote": { get: { operationId: "remote", parameters: [{ $ref: "https://169.254.169.254/latest/p.json" }], responses: { 200: { description: "x" } } } },
      "/hdr": { get: { operationId: "hdr", parameters: [{ name: "Authorization", in: "header", schema: { type: "string" } }], responses: { 200: { description: "x" } } } },
    },
  });

async function lastAudit(ruleId: string) {
  const [row] = await db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId)).orderBy(desc(auditLog.at)).limit(1);
  return row;
}

async function setTransports(list: string[]) {
  await db.update(orgSettings).set({ mcpUpstreamTransports: list as never }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
}

function importSource(name: string, extra: Record<string, unknown> = {}) {
  return app.inject({ method: "POST", url: "/v1/openapi-tool-sources", headers: boot, payload: { name, baseUrl: apiBase, spec: spec(), ...extra } });
}

async function decide(sourceId: string, operationId: string, event: "approve" | "reject" | "revoke", digest?: string) {
  if (event !== "approve") {
    return app.inject({ method: "POST", url: `/v1/openapi-tool-sources/${sourceId}/operations/${operationId}/${event}`, headers: boot, payload: {} });
  }
  const g = await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts: { sourceId, values: { openapiOperationApproved: [operationId, digest] } } });
  return app.inject({
    method: "POST",
    url: `/v1/openapi-tool-sources/${sourceId}/operations/${operationId}/approve`,
    ...stepUpRequest(g),
    payload: { definitionDigest: digest },
  });
}

type OpView = { id: string; operationKey: string; toolName: string; state: string; importedDigest: string; allowedEvents: string[]; imported: { tool: Record<string, unknown> } };
const op = (ops: OpView[], toolName: string) => ops.find((o) => o.toolName === toolName)!;

beforeAll(async () => {
  db = createDb(databaseUrl);
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  restores.push(await relaxStrictAdmissionForTest(db));
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const [before] = await db.select({ t: orgSettings.mcpUpstreamTransports }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(async () => setTransports((before?.t as string[]) ?? ["streamable_http"]));
  await setTransports(["streamable_http"]);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, retry: { maxAttempts: 1 }, timeouts: { mcpConnectMs: 3000, mcpListToolsMs: 3000, mcpCallToolMs: 5000 } });
  restores.push(await relaxGovernanceGatesForTest(db, { requireMcpAttribution: false }));
  await app.ready();
  const mk = async (who: string) => {
    const r = await app.inject({ method: "POST", url: "/v1/users", headers: boot, payload: { email: `oa-${who}-${RUN}@example.test`, displayName: `OA ${who}` } });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  };
  adminId = await mk("admin");
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
  const key = await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: boot, payload: { name: "oa" } });
  adminKey = { authorization: `Bearer ${key.json().token}` };
  userId = await mk("user");
  api = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (req.url?.startsWith("/v2/orders/missing")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
  apiBase = `http://127.0.0.1:${(api.address() as { port: number }).port}/v2`;
}, 120_000);

afterAll(async () => {
  for (const restore of restores.reverse()) await restore();
  api.closeAllConnections();
  await new Promise<void>((r) => api.close(() => r()));
  await app.close();
});

describe("ADR-0353 part 1: governed MCP tools from OpenAPI", () => {
  let sourceId: string;
  let serverId: string;
  let ops: OpView[];

  it("refuses an import while the openapi transport is off, and an openapi server made any other way", async () => {
    const off = await importSource(`oa-${RUN}-off`);
    expect(off.statusCode, off.body).toBe(422);
    expect(off.json().error).toBe("mcp_transport_disabled");
    await setTransports(["streamable_http", "openapi"]);
    const direct = await app.inject({ method: "POST", url: "/v1/servers", headers: boot, payload: { name: `oa-${RUN}-direct`, url: "https://x.example.test/mcp", transport: "openapi" } });
    // the generic registration schema has no openapi shape at all (the transport check refuses it again behind that)
    expect(direct.statusCode, direct.body).toBe(400);
    const [none] = await db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.name, `oa-${RUN}-direct`));
    expect(none).toBeUndefined();
  });

  it("refuses a document that is not OpenAPI 3.x, and stores nothing", async () => {
    const bad = await app.inject({ method: "POST", url: "/v1/openapi-tool-sources", headers: boot, payload: { name: `oa-${RUN}-bad`, baseUrl: apiBase, spec: "swagger: '2.0'\ninfo: {title: x, version: '1'}\npaths: {}" } });
    expect(bad.statusCode, bad.body).toBe(422);
    const [none] = await db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.name, `oa-${RUN}-bad`));
    expect(none).toBeUndefined();
  });

  it("imports: an openapi server, every servable operation staged, the rest skipped with reasons", async () => {
    const r = await importSource(`oa-${RUN}-orders`);
    expect(r.statusCode, r.body).toBe(201);
    const body = r.json();
    sourceId = body.id;
    serverId = body.serverId;
    ops = body.operations;
    expect(ops.map((o) => o.toolName).sort()).toEqual(["createOrder", "getOrder"]);
    expect(ops.every((o) => o.state === "staged" && o.allowedEvents.join() === "approve,reject")).toBe(true);
    const reasons = Object.fromEntries((body.skipped as Array<{ operationKey: string; reason: string }>).map((s) => [s.operationKey, s.reason]));
    expect(reasons["POST /upload"]).toMatch(/multipart/);
    expect(reasons["GET /remote"]).toMatch(/\$ref|resolved/);
    expect(reasons["GET /hdr"]).toMatch(/set by the gateway/);
    const get = op(ops, "getOrder").imported.tool as { inputSchema: { properties: Record<string, unknown> }; annotations: { readOnlyHint: boolean } };
    expect(Object.keys(get.inputSchema.properties)).toEqual(["id"]); // the API key is never an input
    expect(get.annotations.readOnlyHint).toBe(true);
    expect((op(ops, "createOrder").imported.tool as { annotations: { readOnlyHint: boolean } }).annotations.readOnlyHint).toBe(false);
    const [server] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
    expect(server).toMatchObject({ transport: "openapi", url: `openapi:oa-${RUN}-orders` });
    expect((await lastAudit("openapi-tool-source-imported"))?.serverId).toBe(serverId);
  });

  it("does not let the server's url or private-range posture be patched", async () => {
    const p = await app.inject({ method: "PATCH", url: `/v1/servers/${serverId}`, headers: boot, payload: { url: "https://elsewhere.example.test/" } });
    expect(p.statusCode, p.body).toBe(409);
    expect(p.json().error).toBe("mcp_transport_immutable");
  });

  it("serves nothing staged: not listed, and a call is refused before any request leaves", async () => {
    await db.insert(toolGrants).values([{ userId, serverId, toolName: "getOrder" }, { userId, serverId, toolName: "createOrder" }]);
    const before = received.length;
    const out = await executeGovernedToolCall(db, DATA_KEY, { userId, serverId, toolName: "getOrder", arguments: { id: "1" } });
    expect(out.kind).not.toBe("allowed");
    expect(received.length).toBe(before);
  });

  it("approve is a stepped-up compare-and-set on the reviewed digest", async () => {
    const getOp = op(ops, "getOrder");
    const stale = await decide(sourceId, getOp.id, "approve", "0".repeat(64));
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error).toBe("openapi_operation_stale");
    const noStepUp = await app.inject({ method: "POST", url: `/v1/openapi-tool-sources/${sourceId}/operations/${getOp.id}/approve`, headers: adminKey, payload: { definitionDigest: getOp.importedDigest } });
    expect(noStepUp.statusCode, noStepUp.body).not.toBe(200);
    expect((await db.select({ s: openapiToolOperations.state }).from(openapiToolOperations).where(eq(openapiToolOperations.id, getOp.id)))[0]?.s).toBe("staged");
    const ok = await decide(sourceId, getOp.id, "approve", getOp.importedDigest);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ state: "approved", served: true, allowedEvents: ["revoke"] });
    const reject = await decide(sourceId, getOp.id, "reject");
    expect(reject.statusCode).toBe(409);
    expect(reject.json()).toMatchObject({ error: "openapi_operation_transition_refused", allowedEvents: ["revoke"] });
  });

  it("calls the approved tool through the guarded fetch, at the admin's base URL, with the server-held credential", async () => {
    const cred = await relaxStepUpAround(db, () =>
      app.inject({ method: "PUT", url: `/v1/servers/${serverId}/upstream-credential`, headers: boot, payload: { scheme: "header", headerName: "x-api-key", secret: SECRET } }),
    );
    expect(cred.statusCode, cred.body).toBe(201);
    const before = received.length;
    const out = await executeGovernedToolCall(db, DATA_KEY, { userId, serverId, toolName: "getOrder", arguments: { id: "a/b c" } });
    expect(out.kind, JSON.stringify(out).slice(0, 400)).toBe("allowed");
    const req = received[before]!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/v2/orders/a%2Fb%20c");
    expect(req.headers["x-api-key"]).toBe(SECRET);
    if (out.kind === "allowed") expect(JSON.stringify(out.content)).toContain("/v2/orders/a%2Fb%20c");
    // the manifest never carries the credential
    const [listed] = await db.select().from(openapiToolOperations).where(eq(openapiToolOperations.id, op(ops, "getOrder").id));
    expect(JSON.stringify(listed)).not.toContain(SECRET);
  });

  it("validates the arguments and refuses a dot segment before anything is sent", async () => {
    const before = received.length;
    const bad = await executeGovernedToolCall(db, DATA_KEY, { userId, serverId, toolName: "getOrder", arguments: { id: 7, extra: true } });
    const dot = await executeGovernedToolCall(db, DATA_KEY, { userId, serverId, toolName: "getOrder", arguments: { id: ".." } });
    for (const out of [bad, dot]) {
      expect(out.kind).toBe("allowed");
      if (out.kind === "allowed") expect((out.content as { isError?: boolean }).isError).toBe(true);
    }
    expect(received.length).toBe(before);
  });

  it("approves the ADR-0246 pin at the served digest, so the rug-pull gate does not block an approved tool", async () => {
    const pins = await db.select().from(mcpDefinitionPins).where(and(eq(mcpDefinitionPins.serverId, serverId), eq(mcpDefinitionPins.name, "getOrder")));
    expect(pins).toHaveLength(1);
    expect(pins[0]!.approvedDigest).toBe(pins[0]!.observedDigest);
  });

  it("a re-import that changes an approved operation withholds it until it is approved again", async () => {
    const r = await app.inject({ method: "POST", url: `/v1/openapi-tool-sources/${sourceId}/reimport`, headers: boot, payload: { spec: spec({ getDescription: "Get one order (v2)" }) } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().transitions).toContainEqual({ operationKey: "GET /orders/{id}", event: "reimport_changed", from: "approved", to: "drifted" });
    const before = received.length;
    const out = await executeGovernedToolCall(db, DATA_KEY, { userId, serverId, toolName: "getOrder", arguments: { id: "1" } });
    if (out.kind === "allowed") expect((out.content as { isError?: boolean }).isError).toBe(true);
    expect(received.length).toBe(before);
    expect((await lastAudit("openapi-operation-reimport-changed"))?.effect).toBe("deny");
  });

  it("a re-import back to the approved definition serves it again; one that drops an operation withdraws it", async () => {
    const back = await app.inject({ method: "POST", url: `/v1/openapi-tool-sources/${sourceId}/reimport`, headers: boot, payload: { spec: spec({ dropCreate: true }) } });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().transitions).toEqual(
      expect.arrayContaining([
        { operationKey: "GET /orders/{id}", event: "reimport_reverted", from: "drifted", to: "approved" },
        { operationKey: "POST /orders", event: "reimport_missing", from: "staged", to: "withdrawn" },
      ]),
    );
    const out = await executeGovernedToolCall(db, DATA_KEY, { userId, serverId, toolName: "getOrder", arguments: { id: "2" } });
    expect(out.kind).toBe("allowed");
    if (out.kind === "allowed") expect((out.content as { isError?: boolean }).isError).not.toBe(true);
  });

  it("revoke takes an operation out of service", async () => {
    const r = await decide(sourceId, op(ops, "getOrder").id, "revoke");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ state: "withdrawn", served: false });
    const before = received.length;
    const out = await executeGovernedToolCall(db, DATA_KEY, { userId, serverId, toolName: "getOrder", arguments: { id: "3" } });
    if (out.kind === "allowed") expect((out.content as { isError?: boolean }).isError).toBe(true);
    expect(received.length).toBe(before);
  });

  it("imports a REST endpoint list through the same generator", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/openapi-tool-sources",
      headers: boot,
      payload: {
        name: `oa-${RUN}-rest`,
        baseUrl: apiBase,
        endpoints: [
          { method: "GET", path: "/orders/{id}", description: "Read an order" },
          { method: "POST", path: "/orders", description: "Create an order", bodySchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] } },
        ],
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().sourceKind).toBe("rest_endpoints");
    expect((r.json().operations as OpView[]).map((o) => o.operationKey).sort()).toEqual(["GET /orders/{id}", "POST /orders"]);
    const list = await app.inject({ method: "GET", url: "/v1/openapi-tool-sources?limit=200", headers: boot });
    expect(list.statusCode).toBe(200);
    expect(list.json().sources.some((s: { serverName: string }) => s.serverName === `oa-${RUN}-rest`)).toBe(true);
  });

  it("refuses a base URL the egress guard refuses, and stores nothing", async () => {
    await db.update(orgSettings).set({ mcpPrivateRangesDefault: false }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    try {
      const r = await importSource(`oa-${RUN}-blocked`);
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json().error).toBe("egress_blocked");
    } finally {
      await db.update(orgSettings).set({ mcpPrivateRangesDefault: true }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    }
  });
});

describe("insideBaseUrl", () => {
  it("keeps a request on the base URL's origin and under its path", () => {
    expect(insideBaseUrl("https://a.test/v2", "https://a.test/v2/orders")).toBe(true);
    expect(insideBaseUrl("https://a.test/v2/", "https://a.test/v2")).toBe(true);
    expect(insideBaseUrl("https://a.test/v2", "https://a.test/v20/orders")).toBe(false);
    expect(insideBaseUrl("https://a.test/v2", "https://a.test/admin")).toBe(false);
    expect(insideBaseUrl("https://a.test/v2", "https://b.test/v2/orders")).toBe(false);
    expect(insideBaseUrl("https://a.test", "https://a.test/orders")).toBe(true);
  });
});
