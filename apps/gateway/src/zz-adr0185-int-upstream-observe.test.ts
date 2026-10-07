/**
 * ADR-0185 G5 x G4 integration — every upstream operation is counted EXACTLY
 * ONCE on `regulait_mcp_upstream_requests_total`.
 *
 * Two slices observe upstream work: G4's `guardedMcpConnect` observes every
 * connect (one per attempt, the only function that opens an upstream
 * session), and G5's `withUpstreamRetry({ observe })` observes a call
 * sequence. The integration wires `observe` onto the CALL sites only
 * (`tools/call`, the `tools/list` manifest sync, the governed protocol
 * request, the health probe's `tools/list`) and deliberately not onto
 * `connectUpstream`, which would count every connect twice.
 *
 * The proof uses the real meter and the upstream's own request log: after a
 * real session through the proxy route (connect, manifest sync, a tool call,
 * a governed resources/read), the counter's delta for the server equals the
 * number of JSON-RPC REQUESTS the upstream received (each `initialize` is one
 * connect, every other request one call; notifications are not operations).
 *
 * Red proofs (recorded in the integration commit):
 *  - remove `observe` from the tools/call site → delta is one short;
 *  - add `observe` to connectUpstream's retry → delta exceeds the request count.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDb, eq, orgSettings, ORG_SETTINGS_ID, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { scrapeMetricsText } from "./metrics.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0185-int-observe-boot";
const AUTH = { authorization: `Bearer ${BOOT}` };

/** an upstream that logs every JSON-RPC message it receives: method, and
 * whether it is a request (has an id) or a notification */
async function startUpstream() {
  const seen: { method: string; request: boolean }[] = [];
  const build = () => {
    const server = new McpServer({ name: "int-observe", version: "0.0.1" });
    server.registerTool("get_time", { description: "time", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({
      content: [{ type: "text", text: "12:00" }],
    }));
    server.registerResource("readme", "file:///public/readme.md", { mimeType: "text/markdown" }, async (uri) => ({
      contents: [{ uri: uri.href, text: "# public readme" }],
    }));
    return server;
  };
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        const parsed = body ? JSON.parse(body) : undefined;
        for (const m of Array.isArray(parsed) ? parsed : parsed ? [parsed] : []) {
          if (typeof m.method === "string") seen.push({ method: m.method, request: m.id !== undefined });
        }
        const server = build();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        await transport.handleRequest(req, res, parsed);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const a = httpServer.address();
  if (typeof a !== "object" || !a) throw new Error("no address");
  return {
    url: `http://127.0.0.1:${a.port}/`,
    seen,
    close: () =>
      new Promise<void>((r) => {
        httpServer.closeAllConnections();
        httpServer.close(() => r());
      }),
  };
}

/** the counter's samples for one server, by outcome (real meter, real exposition) */
async function upstreamCounts(serverId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const line of (await scrapeMetricsText()).split("\n")) {
    if (!line.startsWith("regulait_mcp_upstream_requests_total{")) continue;
    if (!line.includes(`server_id="${serverId}"`)) continue;
    const outcome = /outcome="([^"]+)"/.exec(line)?.[1] ?? "?";
    out[outcome] = (out[outcome] ?? 0) + Number(line.trim().split(/\s+/).pop());
  }
  return out;
}
const total = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);

let db: Db;
let app: ReturnType<typeof buildApp>;
let gatewayUrl: string;
let up: Awaited<ReturnType<typeof startUpstream>>;
let serverId: string;
let priorMethods: string[] = [];
let restoreGates: () => Promise<void> = async () => {};
let restoreAdmission: (() => Promise<void>) | undefined;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  restoreGates = await relaxGovernanceGatesForTest(db, { requireMcpAttribution: false });
  const [org] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  priorMethods = (org?.mcpProtocolMethods ?? []) as string[];
  await db.update(orgSettings).set({ mcpProtocolMethods: ["resources/read"] as never }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  up = await startUpstream();
  gatewayUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  const allow = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/egress-allow-hosts",
    payload: { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: "int-observe: local MCP double" },
  });
  expect([201, 409]).toContain(allow.statusCode);
  const s = await app.inject({ method: "POST", headers: AUTH, url: "/v1/servers", payload: { name: `int-observe-${Date.now()}`, url: up.url } });
  expect(s.statusCode).toBe(201);
  serverId = s.json().id;
});

afterAll(async () => {
  try {
    // M-068: the org-wide method list this file changed goes back
    if (db) await db.update(orgSettings).set({ mcpProtocolMethods: priorMethods as never }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    await restoreGates();
    await restoreAdmission?.();
    app?.server.closeAllConnections();
    await app?.close();
  } finally {
    await up?.close();
  }
});

describe("ADR-0185 G5 x G4 — one count per upstream operation", () => {
  it("a proxied session (connects, manifest sync, tools/call, resources/read) counts each upstream request once", async () => {
    const u = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: `int-observe-${Date.now()}@example.com`, displayName: "Observe User" },
    });
    const userId = u.json().id as string;
    for (const toolName of ["get_time", "mcp:resources"]) {
      const g = await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/tools", payload: { userId, serverId, toolName } });
      expect(g.statusCode).toBe(201);
    }
    const key = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${userId}/keys`, payload: { name: "int-observe" } });

    const before = await upstreamCounts(serverId);
    const seenBefore = up.seen.length;

    const client = new Client({ name: "int-observe-client", version: "0.0.1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp/${serverId}`), {
        requestInit: { headers: { authorization: `Bearer ${key.json().token as string}` } },
      }),
    );
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("get_time");
    expect((await client.callTool({ name: "get_time", arguments: {} })).content).toEqual([{ type: "text", text: "12:00" }]);
    expect((await client.readResource({ uri: "file:///public/readme.md" })).contents[0]).toMatchObject({ text: "# public readme" });
    await client.close();

    const after = await upstreamCounts(serverId);
    const requests = up.seen.slice(seenBefore).filter((m) => m.request);
    const methods = requests.map((m) => m.method);
    // the session really exercised every observed site: connects, the
    // manifest sync, the tool call and the governed protocol request
    expect(methods).toContain("initialize");
    expect(methods).toContain("tools/list");
    expect(methods).toContain("tools/call");
    expect(methods).toContain("resources/read");

    const delta = total(after) - total(before);
    expect(
      delta,
      `upstream requests ${JSON.stringify(methods)} vs counted ${JSON.stringify({ before, after })}`,
    ).toBe(requests.length);
    // and every one of them succeeded
    expect((after.ok ?? 0) - (before.ok ?? 0)).toBe(requests.length);
  });
});
