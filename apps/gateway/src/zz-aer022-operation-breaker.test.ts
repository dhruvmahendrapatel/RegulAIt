import { afterAll, beforeAll, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { and, auditLog, createDb, eq, mcpServers, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { executeGovernedToolCall, resolveNodeToolContext } from "./mcp-proxy.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";

// ADR-0181: this file pins behaviour against a LOCAL MCP double (127.0.0.1, registered
// seconds ago), not the strict admission defaults — relaxed explicitly, restored after.
let restoreStrictAdmission: (() => Promise<void>) | undefined;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must name a disposable test database");
const admin = { authorization: "Bearer aer022-operation-bootstrap" };
let db: Db;
let app: ReturnType<typeof buildApp>;
let gatewayUrl: string;
let userId: string;
let auth: { authorization: string };

beforeAll(async () => {
  db = createDb(databaseUrl);
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, {
    bootstrapToken: "aer022-operation-bootstrap",
    breaker: { failureThreshold: 2, cooldownMs: 30_000 },
    retry: { maxAttempts: 1 },
    timeouts: { mcpConnectMs: 2000, mcpListToolsMs: 2000, mcpCallToolMs: 2000 },
  });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { requireMcpAttribution: false, mrmEnforced: false, dispatchAttributionRequired: false });
  gatewayUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const user = await app.inject({ method: "POST", url: "/v1/users", headers: admin,
    payload: { email: `aer022-${Date.now()}@example.test`, displayName: "Breaker test" } });
  expect(user.statusCode).toBe(201);
  userId = user.json().id;
  const key = await app.inject({ method: "POST", url: `/v1/users/${userId}/keys`, headers: admin,
    payload: { name: "aer022" } });
  auth = { authorization: `Bearer ${key.json().token}` };
}, 120_000);

afterAll(async () => {
  await restoreStrictAdmission?.();
  await restoreSb2Gates();
  app.server.closeAllConnections();
  await app.close();
});

async function fixture() {
  let fail: "tools/list" | "tools/call" | null = null;
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const counts = { initialize: 0, list: 0, call: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      void (async () => {
        const message = body ? JSON.parse(body) : undefined;
        const method = message?.method;
        if (method === "initialize") counts.initialize++;
        if (method === "tools/list") counts.list++;
        if (method === "tools/call") counts.call++;
        if (method === "tools/list" || method === "tools/call") {
          entered?.();
          await gate;
          if (method === fail) { res.writeHead(503).end("operation failed after initialize"); return; }
        }
        const mcp = new McpServer({ name: "aer022", version: "1" });
        mcp.registerTool("ping", { inputSchema: {}, annotations: { readOnlyHint: true } },
          async () => ({ content: [{ type: "text", text: "pong" }] }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => { void transport.close(); });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, message);
      })().catch(() => { if (!res.headersSent) res.writeHead(500).end(); });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No upstream address");
  const registered = await app.inject({ method: "POST", url: "/v1/servers", headers: admin,
    payload: { name: `aer022-${crypto.randomUUID()}`, url: `http://127.0.0.1:${address.port}/` } });
  expect(registered.statusCode, registered.body).toBe(201);
  const id: string = registered.json().id;
  const grant = await app.inject({ method: "POST", url: "/v1/grants/tools", headers: admin,
    payload: { userId, serverId: id, toolName: "ping" } });
  expect(grant.statusCode, grant.body).toBe(201);
  // The MCP HTTP adapter drains a real IncomingMessage/socket on close.
  // Fastify injection's fake socket does not implement that contract.
  const proxy = async (method: "tools/list" | "tools/call") => {
    const response = await fetch(`${gatewayUrl}/mcp/${id}`, {
      method: "POST", signal: AbortSignal.timeout(10_000),
      headers: { ...auth, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method,
        ...(method === "tools/call" ? { params: { name: "ping", arguments: {} } } : {}) }),
    });
    return { statusCode: response.status, body: await response.text() };
  };
  const direct = () => executeGovernedToolCall(db, undefined, { userId, serverId: id, toolName: "ping", arguments: {} });
  return {
    id, counts, proxy, direct,
    failWith: (method: typeof fail) => { fail = method; },
    hold: () => {
      gate = new Promise<void>((resolve) => { release = resolve; });
      return new Promise<void>((resolve) => { entered = resolve; });
    },
    release: () => { release?.(); },
    close: async () => {
      release?.();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it.each(["tools/list", "tools/call"] as const)("counts failed %s operations despite successful handshakes", async (method) => {
  const f = await fixture();
  try {
    f.failWith(method);
    for (let n = 0; n < 2; n++) {
      const response = await f.proxy(method);
      expect(response.body).toContain('"error"');
    }
    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, f.id));
    expect(row!.breakerConsecutiveFailures).toBe(2);
    expect(row!.breakerOpenedAt).not.toBeNull();
    const before = { ...f.counts };
    const refused = await f.proxy(method);
    expect(refused.body).toMatch(/circuit.broken|circuit_open/);
    expect(f.counts).toEqual(before);
    expect((await f.direct()).kind).toBe("upstream_circuit_open");
    expect(f.counts).toEqual(before);
  } finally { await f.close(); }
});

it.each(["proxy", "worker", "list", "discovery"] as const)("elects one %s probe across proxy and delegated calls", async (winner) => {
  const f = await fixture();
  try {
    // Persist the manifest before opening the breaker, so worker calls need no discovery.
    expect((await f.proxy("tools/list")).statusCode).toBe(200);
    await db.update(mcpServers).set({ breakerOpenedAt: new Date(Date.now() - 60_000),
      breakerConsecutiveFailures: 2, breakerLastError: "prior outage" }).where(eq(mcpServers.id, f.id));
    const entered = f.hold();
    const before = { ...f.counts };
    const winning = winner === "discovery"
      ? resolveNodeToolContext(db, userId, [f.id], undefined)
      : winner === "worker" ? f.direct() : f.proxy(winner === "list" ? "tools/list" : "tools/call");
    await entered;
    const losers = await Promise.all(Array.from({ length: 6 }, async (_, i) => {
      if (i % 2 === 0) return (await f.direct()).kind;
      return (await f.proxy("tools/call")).body;
    }));
    for (const loser of losers) expect(loser).toMatch(/upstream_circuit_open|circuit.broken/);
    expect(f.counts.initialize - before.initialize).toBe(1);
    expect(f.counts.call + f.counts.list - before.call - before.list).toBe(1);
    f.release();
    const result = await winning;
    if ("kind" in result) expect(result.kind).toBe("allowed");
    else if ("toolDefs" in result) expect(result.toolDefs.map((tool) => tool.name)).toContain("ping");
    else expect(result.body).not.toContain('"error"');
    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, f.id));
    expect(row!.breakerOpenedAt).toBeNull();
    expect(row!.breakerConsecutiveFailures).toBe(0);
    const transitions = await db.select().from(auditLog).where(and(eq(auditLog.serverId, f.id),
      eq(auditLog.ruleId, "mcp-upstream-breaker-closed")));
    expect(transitions).toHaveLength(1);
  } finally { await f.close(); }
});
