import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createDb, eq, mcpTools, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

// --- upstream test MCP server (stateless: fresh server+transport per request) ---

function buildUpstreamMcpServer(): McpServer {
  const server = new McpServer({ name: "upstream-test", version: "0.0.1" });
  server.registerTool(
    "get_time",
    {
      description: "Returns a fixed time",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ({ content: [{ type: "text", text: "12:00" }] }),
  );
  server.registerTool(
    "write_note",
    {
      description: "Writes a note",
      inputSchema: { text: z.string() },
    },
    async ({ text }) => ({ content: [{ type: "text", text: `wrote: ${text}` }] }),
  );
  return server;
}

async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      void (async () => {
        const server = buildUpstreamMcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (typeof address !== "object" || !address) throw new Error("no address");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

// --- test setup ---

let db: Db;
let app: ReturnType<typeof buildApp>;
let upstream: Awaited<ReturnType<typeof startUpstream>>;
let gatewayUrl: string;
let serverId: string;
let aliceId: string;
let bobId: string;

function mcpClientFor(userId: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp/${serverId}`), {
    requestInit: { headers: { "x-regulait-user-id": userId } },
  });
  return client.connect(transport).then(() => client);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db);

  upstream = await startUpstream();

  const addr = await app.listen({ port: 0, host: "127.0.0.1" });
  gatewayUrl = addr;

  const alice = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email: "proxy-alice@example.com", displayName: "Proxy Alice" },
  });
  aliceId = alice.json().id;

  const bob = await app.inject({
    method: "POST",
    url: "/v1/users",
    payload: { email: "proxy-bob@example.com", displayName: "Proxy Bob" },
  });
  bobId = bob.json().id;

  const server = await app.inject({
    method: "POST",
    url: "/v1/servers",
    payload: { name: "upstream-test", url: upstream.url },
  });
  serverId = server.json().id;
});

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
  await upstream.close();
});

describe("MCP proxy path", () => {
  it("lists no tools for a user with no grants, but syncs the inventory", async () => {
    const client = await mcpClientFor(aliceId);
    const { tools } = await client.listTools();
    expect(tools).toEqual([]);
    await client.close();

    const inventory = await db.select().from(mcpTools).where(eq(mcpTools.serverId, serverId));
    const byName = Object.fromEntries(inventory.map((t) => [t.name, t.kind]));
    expect(byName).toEqual({ get_time: "read", write_note: "write" });
  });

  it("denies an ungranted call with a policy error and writes a deny audit row", async () => {
    const client = await mcpClientFor(aliceId);
    await expect(client.callTool({ name: "get_time", arguments: {} })).rejects.toThrow(
      /Denied by policy/,
    );
    await client.close();

    const audit = await app.inject({ method: "GET", url: `/v1/audit?userId=${aliceId}` });
    const entries = audit.json().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ effect: "deny", toolName: "get_time" });
  });

  it("proxies a granted tool call end-to-end and audits the allow", async () => {
    const grant = await app.inject({
      method: "POST",
      url: "/v1/grants/tools",
      payload: { userId: aliceId, serverId, toolName: "get_time" },
    });
    const grantId = grant.json().id;

    const client = await mcpClientFor(aliceId);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["get_time"]);

    const result = await client.callTool({ name: "get_time", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "12:00" }]);
    await client.close();

    const audit = await app.inject({ method: "GET", url: `/v1/audit?userId=${aliceId}` });
    const allowRow = audit.json().entries.find((e: { effect: string }) => e.effect === "allow");
    expect(allowRow).toMatchObject({ toolName: "get_time", ruleId: grantId });
  });

  it("read-only-all grant exposes and allows read tools but denies writes", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/grants/servers",
      payload: { userId: bobId, serverId, readOnlyAll: true },
    });

    const client = await mcpClientFor(bobId);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["get_time"]);

    const ok = await client.callTool({ name: "get_time", arguments: {} });
    expect(ok.content).toEqual([{ type: "text", text: "12:00" }]);

    await expect(
      client.callTool({ name: "write_note", arguments: { text: "hi" } }),
    ).rejects.toThrow(/Denied by policy/);
    await client.close();
  });

  it("rejects requests without a user identity header", async () => {
    const res = await fetch(`${gatewayUrl}/mcp/${serverId}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
  });
});
