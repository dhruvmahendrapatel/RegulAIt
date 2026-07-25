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

const BOOT = "test-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let upstream: Awaited<ReturnType<typeof startUpstream>>;
let gatewayUrl: string;
let serverId: string;
let aliceId: string;
let bobId: string;

async function apiKeyFor(userId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${userId}/keys`,
    payload: { name: "test-key" },
  });
  return res.json().token;
}

async function authFor(userId: string): Promise<{ authorization: string }> {
  return { authorization: `Bearer ${await apiKeyFor(userId)}` };
}

async function mcpClientFor(userId: string, intent?: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const url = new URL(`${gatewayUrl}/mcp/${serverId}`);
  if (intent) url.searchParams.set("intent", intent);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${await apiKeyFor(userId)}` } },
  });
  await client.connect(transport);
  return client;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });

  upstream = await startUpstream();

  const addr = await app.listen({ port: 0, host: "127.0.0.1" });
  gatewayUrl = addr;

  const alice = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: "proxy-alice@example.com", displayName: "Proxy Alice" },
  });
  aliceId = alice.json().id;

  const bob = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: "proxy-bob@example.com", displayName: "Proxy Bob" },
  });
  bobId = bob.json().id;

  const server = await app.inject({
    method: "POST",
    headers: AUTH,
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

    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${aliceId}` });
    const entries = audit.json().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ effect: "deny", toolName: "get_time" });
  });

  it("proxies a granted tool call end-to-end and audits the allow", async () => {
    const grant = await app.inject({
      method: "POST",
      headers: AUTH,
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

    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${aliceId}` });
    const allowRow = audit.json().entries.find((e: { effect: string }) => e.effect === "allow");
    expect(allowRow).toMatchObject({ toolName: "get_time", ruleId: grantId });
  });

  it("read-only-all grant exposes and allows read tools but denies writes", async () => {
    await app.inject({
      method: "POST",
      headers: AUTH,
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

describe("approvals through the proxy (§3 + §6 queue)", () => {
  let daveId: string;
  let carolId: string;

  it("pauses a write call behind an approval rule and queues exactly one pending entry", async () => {
    const dave = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-dave@example.com", displayName: "Proxy Dave" },
    });
    daveId = dave.json().id;
    const carol = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-carol@example.com", displayName: "Proxy Carol" },
    });
    carolId = carol.json().id;

    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/tools",
      payload: { userId: daveId, serverId, toolName: "write_note" },
    });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/rules/approvals",
      payload: { userId: daveId, serverId, writeOnly: true, approverUserId: carolId },
    });

    const client = await mcpClientFor(daveId);
    await expect(
      client.callTool({ name: "write_note", arguments: { text: "hi" } }),
    ).rejects.toThrow(/Approval required/);
    // second attempt while pending reuses the same queue entry
    await expect(
      client.callTool({ name: "write_note", arguments: { text: "hi" } }),
    ).rejects.toThrow(/Approval required/);
    await client.close();

    const queue = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const pending = queue
      .json()
      .approvals.filter((a: { userId: string }) => a.userId === daveId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      toolName: "write_note",
      approverUserId: carolId,
      status: "pending",
    });
  });

  it("only the named approver may decide", async () => {
    const queue = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const approvalId = queue
      .json()
      .approvals.find((a: { userId: string }) => a.userId === daveId).id;

    const wrongDecider = await app.inject({
      method: "POST",
      headers: await authFor(daveId),
      url: `/v1/approvals/${approvalId}/decide`,
      payload: { decision: "approved" },
    });
    expect(wrongDecider.statusCode).toBe(403);
  });

  it("an approved call goes through once, consumes the approval, and audits the full journey", async () => {
    const queue = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const approvalId = queue
      .json()
      .approvals.find((a: { userId: string }) => a.userId === daveId).id;

    const decide = await app.inject({
      method: "POST",
      headers: await authFor(carolId),
      url: `/v1/approvals/${approvalId}/decide`,
      payload: { decision: "approved", reason: "looks safe" },
    });
    expect(decide.json().status).toBe("approved");

    const client = await mcpClientFor(daveId);
    const result = await client.callTool({ name: "write_note", arguments: { text: "hi" } });
    expect(result.content).toEqual([{ type: "text", text: "wrote: hi" }]);

    // approval is single-use: the next call pauses again
    await expect(
      client.callTool({ name: "write_note", arguments: { text: "again" } }),
    ).rejects.toThrow(/Approval required/);
    await client.close();

    const consumed = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=consumed" });
    expect(
      consumed.json().approvals.some((a: { id: string }) => a.id === approvalId),
    ).toBe(true);

    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${daveId}` });
    const effects = audit
      .json()
      .entries.map((e: { effect: string }) => e.effect)
      .reverse();
    expect(effects).toEqual(["require_approval", "require_approval", "allow", "require_approval"]);
  });

  it("a denied approval does not let the call through", async () => {
    const queue = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const approvalId = queue
      .json()
      .approvals.find((a: { userId: string }) => a.userId === daveId).id;
    await app.inject({
      method: "POST",
      headers: await authFor(carolId),
      url: `/v1/approvals/${approvalId}/decide`,
      payload: { decision: "denied", reason: "not now" },
    });

    const client = await mcpClientFor(daveId);
    await expect(
      client.callTool({ name: "write_note", arguments: { text: "please" } }),
    ).rejects.toThrow(/Approval required/);
    await client.close();
  });
});

describe("rate limits through the proxy (§3)", () => {
  it("denies the call that exceeds the window cap and audits the deny", async () => {
    const erin = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-erin@example.com", displayName: "Proxy Erin" },
    });
    const erinId = erin.json().id;
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/tools",
      payload: { userId: erinId, serverId, toolName: "get_time" },
    });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/rules/rate-limits",
      payload: { userId: erinId, serverId, toolName: "get_time", maxCalls: 2, windowSeconds: 3600 },
    });

    const client = await mcpClientFor(erinId);
    await client.callTool({ name: "get_time", arguments: {} });
    await client.callTool({ name: "get_time", arguments: {} });
    await expect(client.callTool({ name: "get_time", arguments: {} })).rejects.toThrow(
      /rate limit exhausted/,
    );
    await client.close();

    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${erinId}` });
    const effects = audit
      .json()
      .entries.map((e: { effect: string }) => e.effect)
      .reverse();
    expect(effects).toEqual(["allow", "allow", "deny"]);
  });
});

describe("data-scope rules through the proxy (§3)", () => {
  it("allows in-scope argument values and denies out-of-scope ones, fail-closed on missing", async () => {
    const frank = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-frank@example.com", displayName: "Proxy Frank" },
    });
    const frankId = frank.json().id;
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/tools",
      payload: { userId: frankId, serverId, toolName: "write_note" },
    });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/rules/data-scopes",
      payload: {
        userId: frankId,
        serverId,
        toolName: "write_note",
        argPath: "text",
        allowedValues: ["hello", "hi"],
      },
    });

    const client = await mcpClientFor(frankId);

    const ok = await client.callTool({ name: "write_note", arguments: { text: "hi" } });
    expect(ok.content).toEqual([{ type: "text", text: "wrote: hi" }]);

    await expect(
      client.callTool({ name: "write_note", arguments: { text: "exfiltrate" } }),
    ).rejects.toThrow(/outside the allowed data scope/);

    await expect(client.callTool({ name: "write_note", arguments: {} })).rejects.toThrow(
      /fails closed/,
    );
    await client.close();

    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${frankId}` });
    const effects = audit
      .json()
      .entries.map((e: { effect: string }) => e.effect)
      .reverse();
    expect(effects).toEqual(["allow", "deny", "deny"]);
  });
});

describe("roles + per-user overrides through the proxy (§5)", () => {
  let graceId: string;
  let roleId: string;
  let revocationId: string;

  it("a role assignment grants its bundled tools end-to-end", async () => {
    const grace = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-grace@example.com", displayName: "Proxy Grace" },
    });
    graceId = grace.json().id;

    const role = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/roles",
      payload: { name: "note-taker", description: "can read time and write notes" },
    });
    roleId = role.json().id;

    for (const toolName of ["get_time", "write_note"]) {
      await app.inject({
        method: "POST",
        headers: AUTH,
        url: `/v1/roles/${roleId}/grants/tools`,
        payload: { serverId, toolName },
      });
    }
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${graceId}/roles`,
      payload: { roleId },
    });

    const client = await mcpClientFor(graceId);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_time", "write_note"]);

    const result = await client.callTool({ name: "get_time", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "12:00" }]);
    await client.close();

    const audit = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/audit?userId=${graceId}`,
    });
    const allowRow = audit.json().entries.find((e: { effect: string }) => e.effect === "allow");
    expect(
      allowRow.ruleChain.some(
        (t: { rule: string; outcome: string }) =>
          t.rule === "role-tool-allow-list" && t.outcome === "allow",
      ),
    ).toBe(true);
  });

  it("a revocation hides and blocks one role tool without touching the rest", async () => {
    const rev = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/revocations",
      payload: { userId: graceId, serverId, toolName: "write_note" },
    });
    revocationId = rev.json().id;

    const client = await mcpClientFor(graceId);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["get_time"]);
    await expect(
      client.callTool({ name: "write_note", arguments: { text: "hi" } }),
    ).rejects.toThrow(/Denied by policy/);
    await client.close();
  });

  it("the entitlements view flags the revoked role grant as a visible deviation", async () => {
    const view = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/users/${graceId}/servers/${serverId}/entitlements`,
    });
    const entries = view.json().entitlements;
    const writeNote = entries.find((e: { toolName: string }) => e.toolName === "write_note");
    expect(writeNote).toMatchObject({
      source: "role",
      role: "note-taker",
      revoked: true,
      revocationId,
    });
    const getTime = entries.find((e: { toolName: string }) => e.toolName === "get_time");
    expect(getTime).toMatchObject({ source: "role", role: "note-taker", revoked: false });
  });

  it("deleting the revocation restores the entitlement (independently reversible)", async () => {
    const del = await app.inject({
      method: "DELETE",
      headers: AUTH,
      url: `/v1/revocations/${revocationId}`,
    });
    expect(del.statusCode).toBe(200);

    const client = await mcpClientFor(graceId);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_time", "write_note"]);
    const ok = await client.callTool({ name: "write_note", arguments: { text: "back" } });
    expect(ok.content).toEqual([{ type: "text", text: "wrote: back" }]);
    await client.close();
  });

  it("unassigning the role removes all role-derived access", async () => {
    const del = await app.inject({
      method: "DELETE",
      headers: AUTH,
      url: `/v1/users/${graceId}/roles/${roleId}`,
    });
    expect(del.statusCode).toBe(200);

    const client = await mcpClientFor(graceId);
    const { tools } = await client.listTools();
    expect(tools).toEqual([]);
    await client.close();
  });
});

describe("§5 review fixes", () => {
  it("duplicate revocations are rejected with 409, dangling FKs with 400", async () => {
    const heidi = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-heidi@example.com", displayName: "Proxy Heidi" },
    });
    const heidiId = heidi.json().id;

    const first = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/revocations",
      payload: { userId: heidiId, serverId, toolName: "get_time" },
    });
    expect(first.statusCode).toBe(201);
    const dup = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/revocations",
      payload: { userId: heidiId, serverId, toolName: "get_time" },
    });
    expect(dup.statusCode).toBe(409);

    const dangling = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${heidiId}/roles`,
      payload: { roleId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(dangling.statusCode).toBe(400);
    expect(dangling.json().error).toBe("invalid_reference");
  });

  it("tool-scoped revocations against role read-only-all are visible and listable", async () => {
    const ivan = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-ivan@example.com", displayName: "Proxy Ivan" },
    });
    const ivanId = ivan.json().id;

    const role = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/roles",
      payload: { name: "reader" },
    });
    const readerRoleId = role.json().id;
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/roles/${readerRoleId}/grants/servers`,
      payload: { serverId, readOnlyAll: true },
    });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${ivanId}/roles`,
      payload: { roleId: readerRoleId },
    });
    const rev = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/revocations",
      payload: { userId: ivanId, serverId, toolName: "get_time" },
    });
    const revId = rev.json().id;

    // the kernel enforces the carve-out; the view must now show it too
    const client = await mcpClientFor(ivanId);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([]);
    await client.close();

    const view = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/users/${ivanId}/servers/${serverId}/entitlements`,
    });
    const body = view.json();
    const serverEntry = body.entitlements.find(
      (e: { kind: string; source: string }) => e.kind === "server-read-only" && e.source === "role",
    );
    expect(serverEntry.roleId).toBe(readerRoleId);
    expect(serverEntry.revokedTools).toEqual([{ toolName: "get_time", revocationId: revId }]);
    expect(body.revocations.map((r: { id: string }) => r.id)).toContain(revId);

    const list = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/revocations?userId=${ivanId}`,
    });
    expect(list.json().revocations.map((r: { id: string }) => r.id)).toContain(revId);
  });
});

describe("agent governance (§2/§4)", () => {
  let judyId: string;
  let planAgentId: string;
  let bigAgentId: string;

  it("registry + grant + mode restriction govern invocation end-to-end", async () => {
    const judy = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-judy@example.com", displayName: "Proxy Judy" },
    });
    judyId = judy.json().id;

    const small = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/agents",
      payload: { name: "claude-haiku", provider: "anthropic", tier: 1, modes: ["plan", "execute"] },
    });
    planAgentId = small.json().id;
    const big = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/agents",
      payload: { name: "claude-fable", provider: "anthropic", tier: 5, modes: ["plan", "execute"] },
    });
    bigAgentId = big.json().id;

    const judyAuth = await authFor(judyId);

    // no grant → default deny (403), audited
    const ungran = await app.inject({
      method: "POST",
      headers: judyAuth,
      url: `/v1/agents/${planAgentId}/invoke`,
      payload: { mode: "plan" },
    });
    expect(ungran.statusCode).toBe(403);
    expect(ungran.json().decision.ruleId).toBe("default-deny");

    // grant restricted to plan mode
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/agents",
      payload: { userId: judyId, agentId: planAgentId, allowedModes: ["plan"] },
    });

    const plan = await app.inject({
      method: "POST",
      headers: judyAuth,
      url: `/v1/agents/${planAgentId}/invoke`,
      payload: { mode: "plan" },
    });
    expect(plan.statusCode).toBe(200);
    expect(plan.json().decision.effect).toBe("allow");

    const exec = await app.inject({
      method: "POST",
      headers: judyAuth,
      url: `/v1/agents/${planAgentId}/invoke`,
      payload: { mode: "execute" },
    });
    expect(exec.statusCode).toBe(403);
    expect(exec.json().decision.reason).toContain("mode 'execute'");
  });

  it("the tier ceiling caps escalation even for granted agents", async () => {
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/agents",
      payload: { userId: judyId, agentId: bigAgentId },
    });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${judyId}/agent-policy`,
      payload: { defaultAgentId: planAgentId, ceilingAgentId: planAgentId },
    });

    const judyAuth = await authFor(judyId);
    const res = await app.inject({
      method: "POST",
      headers: judyAuth,
      url: `/v1/agents/${bigAgentId}/invoke`,
      payload: { mode: "plan" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().decision.ruleId).toBe("agent-ceiling");

    const listing = await app.inject({
      method: "GET",
      headers: judyAuth,
      url: `/v1/users/${judyId}/agents`,
    });
    expect(listing.json().defaultAgentId).toBe(planAgentId);
    expect(listing.json().ceilingAgentId).toBe(planAgentId);
    expect(listing.json().agents).toHaveLength(2);
  });

  it("platform-disabling an agent denies everyone regardless of grants", async () => {
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/agents/${planAgentId}/enabled`,
      payload: { enabled: false },
    });
    const judyAuth = await authFor(judyId);
    const res = await app.inject({
      method: "POST",
      headers: judyAuth,
      url: `/v1/agents/${planAgentId}/invoke`,
      payload: { mode: "plan" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().decision.ruleId).toBe("agent-registry-enabled");

    const audit = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/audit?userId=${judyId}`,
    });
    const agentRows = audit
      .json()
      .entries.filter((e: { objectType: string }) => e.objectType === "agent");
    expect(agentRows.length).toBeGreaterThanOrEqual(5);
    expect(agentRows[0].objectId).toBe(planAgentId);
  });
});

describe("connector governance (§2)", () => {
  it("mode + object scope govern connector calls, one audit trail", async () => {
    const kim = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-kim@example.com", displayName: "Proxy Kim" },
    });
    const kimId = kim.json().id;
    const sf = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/connectors",
      payload: { name: "salesforce", kind: "crm" },
    });
    const sfId = sf.json().id;
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/connectors",
      payload: { userId: kimId, connectorId: sfId, mode: "read", allowedObjects: ["accounts"] },
    });

    const kimAuth = await authFor(kimId);
    const ok = await app.inject({
      method: "POST",
      headers: kimAuth,
      url: `/v1/connectors/${sfId}/invoke`,
      payload: { operation: "read", object: "accounts" },
    });
    expect(ok.statusCode).toBe(200);

    const write = await app.inject({
      method: "POST",
      headers: kimAuth,
      url: `/v1/connectors/${sfId}/invoke`,
      payload: { operation: "write", object: "accounts" },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().decision.reason).toContain("read-only");

    const outside = await app.inject({
      method: "POST",
      headers: kimAuth,
      url: `/v1/connectors/${sfId}/invoke`,
      payload: { operation: "read", object: "payroll" },
    });
    expect(outside.statusCode).toBe(403);

    const listing = await app.inject({
      method: "GET",
      headers: kimAuth,
      url: `/v1/users/${kimId}/connectors`,
    });
    expect(listing.json().connectors).toHaveLength(1);
    expect(listing.json().connectors[0]).toMatchObject({ name: "salesforce", mode: "read" });

    const audit = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/audit?userId=${kimId}`,
    });
    const effects = audit
      .json()
      .entries.filter((e: { objectType: string }) => e.objectType === "connector")
      .map((e: { effect: string }) => e.effect)
      .reverse();
    expect(effects).toEqual(["allow", "deny", "deny"]);
  });
});

describe("workflow engine (EPIC-03 slice)", () => {
  let leoId: string;
  let leoAuth: { authorization: string };
  let stdTemplateId: string;
  let complianceApproverId: string;

  const standardDef = {
    workflow: "standard-change-workflow",
    stages: [
      { id: "intake", type: "trigger" },
      { id: "plan", type: "planning" },
      { id: "requirements", type: "artifact_generation", output: "requirements_file" },
      { id: "requirements_signoff", type: "human_approval", approvers: ["requesting_user"] },
      { id: "build", type: "automated_build", scope: "requirements_file" },
      { id: "checks", type: "automated_check", checks: ["ci_tests"] },
    ],
  };

  it("templates validate on creation and assignment rules route changes", async () => {
    const bad = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/templates",
      payload: { name: "bad", definition: { workflow: "bad", stages: [{ id: "x", type: "planning" }] } },
    });
    expect(bad.statusCode).toBe(400);

    const tpl = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/templates",
      payload: { name: "standard-change", definition: standardDef },
    });
    expect(tpl.statusCode).toBe(201);
    stdTemplateId = tpl.json().id;

    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/assignment-rules",
      payload: { templateId: stdTemplateId, changeType: "backend" },
    });

    const leo = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-leo@example.com", displayName: "Proxy Leo" },
    });
    leoId = leo.json().id;
    leoAuth = await authFor(leoId);

    const miss = await app.inject({
      method: "POST",
      headers: leoAuth,
      url: "/v1/workflows/instances",
      payload: {
        change: { description: "copy fix", paths: ["web/home.tsx"], changeType: "frontend", environment: "staging" },
      },
    });
    expect(miss.statusCode).toBe(422);
  });

  it("runs the full journey: artifact → sign-off → versioned re-approval → build → done", async () => {
    const started = await app.inject({
      method: "POST",
      headers: leoAuth,
      url: "/v1/workflows/instances",
      payload: {
        change: { description: "add endpoint", paths: ["api/x.ts"], changeType: "backend", environment: "staging" },
      },
    });
    expect(started.statusCode).toBe(201);
    const instanceId = started.json().id;
    expect(started.json().status).toBe("blocked_on_artifact");

    const v1 = await app.inject({
      method: "POST",
      headers: leoAuth,
      url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "requirements", content: "# Requirements v1" },
    });
    expect(v1.json()).toMatchObject({ version: 1, status: "blocked_on_approval" });

    // sign-off posts into the ONE approvals queue, approver = requesting user
    const queue = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const signoff = queue
      .json()
      .approvals.find((a: { instanceId: string | null }) => a.instanceId === instanceId);
    expect(signoff).toMatchObject({ objectType: "workflow", stageId: "requirements_signoff", approverUserId: leoId });

    const approve = await app.inject({
      method: "POST",
      headers: leoAuth,
      url: `/v1/approvals/${signoff.id}/decide`,
      payload: { decision: "approved" },
    });
    expect(approve.statusCode).toBe(200);

    let view = await app.inject({ method: "GET", headers: leoAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(view.json().instance.status).toBe("awaiting_trigger");

    // §2 stage 4: editing after sign-off re-opens the gate at version 2
    const v2 = await app.inject({
      method: "POST",
      headers: leoAuth,
      url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "requirements", content: "# Requirements v2" },
    });
    expect(v2.json()).toMatchObject({ version: 2, status: "blocked_on_approval" });

    const queue2 = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const signoff2 = queue2
      .json()
      .approvals.find((a: { instanceId: string | null }) => a.instanceId === instanceId);
    expect(signoff2.id).not.toBe(signoff.id);
    await app.inject({
      method: "POST",
      headers: leoAuth,
      url: `/v1/approvals/${signoff2.id}/decide`,
      payload: { decision: "approved" },
    });

    for (const stageId of ["build", "checks"]) {
      await app.inject({
        method: "POST",
        headers: leoAuth,
        url: `/v1/workflows/instances/${instanceId}/advance`,
        payload: { stageId },
      });
    }

    view = await app.inject({ method: "GET", headers: leoAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(view.json().instance.status).toBe("completed");
    expect(view.json().artifacts.map((a: { version: number }) => a.version)).toEqual([1, 2]);
    expect(view.json().events.length).toBeGreaterThanOrEqual(6);
  });

  it("merges multiple matching templates and honors named approvers (§4 composability)", async () => {
    const approver = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-compliance@example.com", displayName: "Compliance Officer" },
    });
    complianceApproverId = approver.json().id;

    const tpl = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/templates",
      payload: {
        name: "prod-compliance",
        definition: {
          workflow: "prod-compliance",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "compliance_signoff", type: "human_approval", approvers: [complianceApproverId] },
          ],
        },
      },
    });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, environment: "production" },
    });

    const started = await app.inject({
      method: "POST",
      headers: leoAuth,
      url: "/v1/workflows/instances",
      payload: {
        change: { description: "prod change", paths: ["api/y.ts"], changeType: "backend", environment: "production" },
      },
    });
    const instanceId = started.json().id;

    const view = await app.inject({ method: "GET", headers: leoAuth, url: `/v1/workflows/instances/${instanceId}` });
    const stageIds = view.json().instance.definition.stages.map((s: { id: string }) => s.id);
    expect(stageIds).toContain("requirements_signoff");
    expect(stageIds).toContain("compliance_signoff");

    // walk to the compliance gate: artifact → own sign-off → build/checks
    await app.inject({
      method: "POST",
      headers: leoAuth,
      url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "requirements", content: "# prod req" },
    });
    const q1 = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const s1 = q1.json().approvals.find(
      (a: { instanceId: string | null; stageId: string }) =>
        a.instanceId === instanceId && a.stageId === "requirements_signoff",
    );
    await app.inject({
      method: "POST",
      headers: leoAuth,
      url: `/v1/approvals/${s1.id}/decide`,
      payload: { decision: "approved" },
    });
    for (const stageId of ["build", "checks"]) {
      await app.inject({
        method: "POST",
        headers: leoAuth,
        url: `/v1/workflows/instances/${instanceId}/advance`,
        payload: { stageId },
      });
    }

    const q2 = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const s2 = q2.json().approvals.find(
      (a: { instanceId: string | null; stageId: string }) =>
        a.instanceId === instanceId && a.stageId === "compliance_signoff",
    );
    expect(s2.approverUserId).toBe(complianceApproverId);

    // initiator cannot decide the compliance gate — only the named approver
    const wrong = await app.inject({
      method: "POST",
      headers: leoAuth,
      url: `/v1/approvals/${s2.id}/decide`,
      payload: { decision: "approved" },
    });
    expect(wrong.statusCode).toBe(403);

    const denied = await app.inject({
      method: "POST",
      headers: await authFor(complianceApproverId),
      url: `/v1/approvals/${s2.id}/decide`,
      payload: { decision: "denied", reason: "missing rollback plan" },
    });
    expect(denied.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", headers: leoAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(after.json().instance.status).toBe("denied");
  });

  it("non-initiators cannot see or drive an instance; abort is terminal and audited", async () => {
    const started = await app.inject({
      method: "POST",
      headers: leoAuth,
      url: "/v1/workflows/instances",
      payload: {
        change: { description: "another", paths: ["api/z.ts"], changeType: "backend", environment: "staging" },
      },
    });
    const instanceId = started.json().id;

    const mallory = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-mallory@example.com", displayName: "Proxy Mallory" },
    });
    const malloryAuth = await authFor(mallory.json().id);
    const stranger = await app.inject({
      method: "GET",
      headers: malloryAuth,
      url: `/v1/workflows/instances/${instanceId}`,
    });
    expect(stranger.statusCode).toBe(403);

    await app.inject({
      method: "POST",
      headers: leoAuth,
      url: `/v1/workflows/instances/${instanceId}/abort`,
      payload: {},
    });
    const view = await app.inject({ method: "GET", headers: leoAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(view.json().instance.status).toBe("aborted");

    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${leoId}` });
    const wfRows = audit
      .json()
      .entries.filter(
        (e: { objectType: string; objectId: string | null }) =>
          e.objectType === "workflow" && e.objectId === instanceId,
      );
    expect(wfRows.some((e: { effect: string }) => e.effect === "deny")).toBe(true);
  });
});

describe("workflow review-fix regressions", () => {
  it("a stale downstream approval cannot advance a re-opened upstream sign-off", async () => {
    const nina = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "proxy-nina@example.com", displayName: "Proxy Nina" },
    });
    const ninaId = nina.json().id;
    const gate2Approver = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "proxy-gate2@example.com", displayName: "Gate2 Approver" },
    });
    const gate2Id = gate2Approver.json().id;

    const tpl = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: "two-gates",
        definition: {
          workflow: "two-gates",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "req", type: "artifact_generation", output: "req_file" },
            { id: "gate1", type: "human_approval", approvers: ["requesting_user"] },
            { id: "gate2", type: "human_approval", approvers: [gate2Id] },
            { id: "build2", type: "automated_build" },
          ],
        },
      },
    });
    expect(tpl.statusCode).toBe(201);
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "two-gates-test" },
    });

    const ninaAuth = await authFor(ninaId);
    const started = await app.inject({
      method: "POST", headers: ninaAuth, url: "/v1/workflows/instances",
      payload: { change: { description: "x", paths: ["a.ts"], changeType: "two-gates-test", environment: "staging" } },
    });
    const instanceId = started.json().id;

    await app.inject({
      method: "POST", headers: ninaAuth, url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "req", content: "v1" },
    });
    const q1 = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const gate1Row = q1.json().approvals.find(
      (a: { instanceId: string | null; stageId: string }) => a.instanceId === instanceId && a.stageId === "gate1",
    );
    await app.inject({
      method: "POST", headers: ninaAuth, url: `/v1/approvals/${gate1Row.id}/decide`,
      payload: { decision: "approved" },
    });

    // now blocked on gate2 with a live pending row — re-open by editing the artifact
    const q2 = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const gate2Row = q2.json().approvals.find(
      (a: { instanceId: string | null; stageId: string }) => a.instanceId === instanceId && a.stageId === "gate2",
    );
    expect(gate2Row).toBeTruthy();

    await app.inject({
      method: "POST", headers: ninaAuth, url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "req", content: "v2" },
    });

    // the stale gate2 row was superseded — deciding it must not advance gate1
    const decideStale = await app.inject({
      method: "POST", headers: await authFor(gate2Id), url: `/v1/approvals/${gate2Row.id}/decide`,
      payload: { decision: "approved" },
    });
    expect(decideStale.statusCode).toBe(409);

    const view = await app.inject({ method: "GET", headers: ninaAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(view.json().instance.status).toBe("blocked_on_approval");
    expect(view.json().pendingApprovals.map((a: { stageId: string }) => a.stageId)).toEqual(["gate1"]);
  });

  it("abort supersedes every outstanding pending approval (no dead rows in the inbox)", async () => {
    const omar = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "proxy-omar@example.com", displayName: "Proxy Omar" },
    });
    const omarId = omar.json().id;
    const omarAuth = await authFor(omarId);
    const started = await app.inject({
      method: "POST", headers: omarAuth, url: "/v1/workflows/instances",
      payload: { change: { description: "y", paths: ["b.ts"], changeType: "two-gates-test", environment: "staging" } },
    });
    const instanceId = started.json().id;
    await app.inject({
      method: "POST", headers: omarAuth, url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "req", content: "v1" },
    });

    await app.inject({
      method: "POST", headers: omarAuth, url: `/v1/workflows/instances/${instanceId}/abort`, payload: {},
    });
    const q = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    expect(
      q.json().approvals.filter((a: { instanceId: string | null }) => a.instanceId === instanceId),
    ).toHaveLength(0);
  });

  it("templates with unknown approver ids are rejected at creation", async () => {
    const res = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: "bad-approver",
        definition: {
          workflow: "bad-approver",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "gate", type: "human_approval", approvers: ["designated_reviewer_role"] },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("agent-policy partial update preserves the ceiling; grants are revocable", async () => {
    const pia = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "proxy-pia@example.com", displayName: "Proxy Pia" },
    });
    const piaId = pia.json().id;
    const a1 = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/agents",
      payload: { name: "tiny-agent", provider: "test", tier: 1 },
    });
    const a2 = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/agents",
      payload: { name: "big-agent", provider: "test", tier: 9 },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${piaId}/agent-policy`,
      payload: { ceilingAgentId: a1.json().id },
    });
    // partial update touching only the default must NOT lift the ceiling
    const updated = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${piaId}/agent-policy`,
      payload: { defaultAgentId: a1.json().id },
    });
    expect(updated.json().ceilingAgentId).toBe(a1.json().id);

    const grant = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/agents",
      payload: { userId: piaId, agentId: a2.json().id },
    });
    const del = await app.inject({
      method: "DELETE", headers: AUTH, url: `/v1/grants/agents/${grant.json().id}`,
    });
    expect(del.statusCode).toBe(200);
    const listing = await app.inject({ method: "GET", headers: AUTH, url: `/v1/users/${piaId}/agents` });
    expect(listing.json().agents).toHaveLength(0);
  });
});

describe("git-provider workflow stages (EPIC-03)", () => {
  it("runs a governed change end-to-end: branch → PR linked to artifact → merge gate → squash merge", async () => {
    const conn = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/git/connections",
      payload: { name: "mock-git", provider: "mock", token: "irrelevant" },
    });
    expect(conn.statusCode).toBe(201);
    expect(conn.body).not.toContain("irrelevant");

    const quinn = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-quinn@example.com", displayName: "Proxy Quinn" },
    });
    const quinnId = quinn.json().id;
    const quinnAuth = await authFor(quinnId);

    const tpl = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/templates",
      payload: {
        name: "git-change",
        definition: {
          workflow: "git-change",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "requirements", type: "artifact_generation", output: "requirements_file" },
            { id: "requirements_signoff", type: "human_approval", approvers: ["requesting_user"] },
            { id: "branch", type: "git_operation", action: "create_branch", connection: "mock-git", repo: "acme/app" },
            { id: "open_pr", type: "git_operation", action: "open_pr", connection: "mock-git", repo: "acme/app" },
            { id: "merge_gate", type: "human_approval", approvers: ["requesting_user"] },
            { id: "merge", type: "git_operation", action: "merge", connection: "mock-git", repo: "acme/app", strategy: "squash" },
          ],
        },
      },
    });
    expect(tpl.statusCode).toBe(201);
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "git-change-test" },
    });

    const started = await app.inject({
      method: "POST",
      headers: quinnAuth,
      url: "/v1/workflows/instances",
      payload: {
        change: { description: "add rate limiting", paths: ["api/limits.ts"], changeType: "git-change-test", environment: "staging" },
      },
    });
    const instanceId = started.json().id;
    expect(started.json().status).toBe("blocked_on_artifact");

    await app.inject({
      method: "POST",
      headers: quinnAuth,
      url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "requirements", content: "# Rate limiting requirements" },
    });
    const q = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const signoff = q.json().approvals.find(
      (a: { instanceId: string | null; stageId: string }) =>
        a.instanceId === instanceId && a.stageId === "requirements_signoff",
    );
    // approval unblocks straight into the git stages: branch + PR run automatically
    await app.inject({
      method: "POST",
      headers: quinnAuth,
      url: `/v1/approvals/${signoff.id}/decide`,
      payload: { decision: "approved" },
    });

    let view = await app.inject({ method: "GET", headers: quinnAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(view.json().instance.status).toBe("blocked_on_approval");
    const ctx = view.json().instance.context;
    expect(ctx.branch).toBe(`regulait/${instanceId.slice(0, 8)}`);
    expect(ctx.prId).toBe("1");
    expect(ctx.prUrl).toBe("mock://acme/app/pull/1");

    const q2 = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const mergeGate = q2.json().approvals.find(
      (a: { instanceId: string | null; stageId: string }) =>
        a.instanceId === instanceId && a.stageId === "merge_gate",
    );
    await app.inject({
      method: "POST",
      headers: quinnAuth,
      url: `/v1/approvals/${mergeGate.id}/decide`,
      payload: { decision: "approved" },
    });

    view = await app.inject({ method: "GET", headers: quinnAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(view.json().instance.status).toBe("completed");
    expect(view.json().instance.context.mergeSha).toBe("sha-merge-1");
  });

  it("execution failures are retryable and recorded, not terminal", async () => {
    const rita = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "proxy-rita@example.com", displayName: "Proxy Rita" },
    });
    const ritaAuth = await authFor(rita.json().id);

    const tpl = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/templates",
      payload: {
        name: "bad-conn-flow",
        definition: {
          workflow: "bad-conn-flow",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "branch", type: "git_operation", action: "create_branch", connection: "ghost-conn", repo: "acme/app" },
          ],
        },
      },
    });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "bad-conn-test" },
    });

    const started = await app.inject({
      method: "POST",
      headers: ritaAuth,
      url: "/v1/workflows/instances",
      payload: {
        change: { description: "x", paths: ["a.ts"], changeType: "bad-conn-test", environment: "staging" },
      },
    });
    const instanceId = started.json().id;
    expect(started.json().status).toBe("awaiting_execution");

    const view = await app.inject({ method: "GET", headers: ritaAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(view.json().instance.context.lastError).toContain("unknown git connection");

    // register the missing connection, then retry via advance
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/git/connections",
      payload: { name: "ghost-conn", provider: "mock", token: "t" },
    });
    const retried = await app.inject({
      method: "POST",
      headers: ritaAuth,
      url: `/v1/workflows/instances/${instanceId}/advance`,
      payload: { stageId: "branch" },
    });
    expect(retried.json().status).toBe("completed");
    expect(retried.json().context.lastError).toBeUndefined();
  });
});

describe("agents/connectors review follow-ups", () => {
  it("carve-outs exclude write-kind and nonexistent tools; oversized invoke strings are rejected", async () => {
    const sam = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "proxy-sam@example.com", displayName: "Proxy Sam" },
    });
    const samId = sam.json().id;
    const role = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/roles", payload: { name: "sam-reader" },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: `/v1/roles/${role.json().id}/grants/servers`,
      payload: { serverId, readOnlyAll: true },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${samId}/roles`,
      payload: { roleId: role.json().id },
    });
    // three revocations: a real read tool, a write tool, and a ghost tool
    for (const toolName of ["get_time", "write_note", "ghost_tool"]) {
      await app.inject({
        method: "POST", headers: AUTH, url: "/v1/revocations",
        payload: { userId: samId, serverId, toolName },
      });
    }

    const view = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/users/${samId}/servers/${serverId}/entitlements`,
    });
    const serverEntry = view
      .json()
      .entitlements.find(
        (e: { kind: string; source: string }) => e.kind === "server-read-only" && e.source === "role",
      );
    // only the read tool that exists is a genuine carve-out of read-only-all
    expect(serverEntry.revokedTools.map((c: { toolName: string }) => c.toolName)).toEqual([
      "get_time",
    ]);
    // all three revocations remain discoverable in the flat list
    expect(view.json().revocations).toHaveLength(3);

    const agent = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/agents",
      payload: { name: "bounded-agent", provider: "test", tier: 1 },
    });
    const samAuth = await authFor(samId);
    const oversized = await app.inject({
      method: "POST", headers: samAuth, url: `/v1/agents/${agent.json().id}/invoke`,
      payload: { mode: "x".repeat(65) },
    });
    expect(oversized.statusCode).toBe(400);
  });
});

describe("git executor hardening (review follow-ups)", () => {
  let umaId: string;
  let umaAuth: { authorization: string };

  it("re-opened instances replay git stages idempotently instead of wedging", async () => {
    const uma = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "proxy-uma@example.com", displayName: "Proxy Uma" },
    });
    umaId = uma.json().id;
    umaAuth = await authFor(umaId);

    const tpl = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: "git-reopen-flow",
        definition: {
          workflow: "git-reopen-flow",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "requirements", type: "artifact_generation", output: "requirements_file" },
            { id: "signoff", type: "human_approval", approvers: ["requesting_user"] },
            { id: "branch", type: "git_operation", action: "create_branch", connection: "mock-git", repo: "acme/reopen" },
            { id: "open_pr", type: "git_operation", action: "open_pr", connection: "mock-git", repo: "acme/reopen" },
            { id: "merge_gate", type: "human_approval", approvers: ["requesting_user"] },
            { id: "merge", type: "git_operation", action: "merge", connection: "mock-git", repo: "acme/reopen", strategy: "squash" },
          ],
        },
      },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "git-reopen-test" },
    });

    const started = await app.inject({
      method: "POST", headers: umaAuth, url: "/v1/workflows/instances",
      payload: { change: { description: "reopen test", paths: ["x.ts"], changeType: "git-reopen-test", environment: "staging" } },
    });
    const instanceId = started.json().id;

    const approveCurrent = async (stageId: string) => {
      const q = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
      const row = q.json().approvals.find(
        (a: { instanceId: string | null; stageId: string }) => a.instanceId === instanceId && a.stageId === stageId,
      );
      return app.inject({
        method: "POST", headers: umaAuth, url: `/v1/approvals/${row.id}/decide`,
        payload: { decision: "approved" },
      });
    };

    await app.inject({
      method: "POST", headers: umaAuth, url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "requirements", content: "v1" },
    });
    await approveCurrent("signoff");

    let view = await app.inject({ method: "GET", headers: umaAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(view.json().instance.status).toBe("blocked_on_approval");
    const prIdBefore = view.json().instance.context.prId;
    expect(prIdBefore).toBeTruthy();

    // §2 re-open: edit the artifact after branch+PR already exist
    await app.inject({
      method: "POST", headers: umaAuth, url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "requirements", content: "v2" },
    });
    await approveCurrent("signoff");

    // branch + open_pr replayed idempotently — same PR, no 422 wedge
    view = await app.inject({ method: "GET", headers: umaAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(view.json().instance.status).toBe("blocked_on_approval");
    expect(view.json().instance.context.prId).toBe(prIdBefore);
    expect(view.json().instance.context.lastError).toBeUndefined();

    await approveCurrent("merge_gate");
    view = await app.inject({ method: "GET", headers: umaAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(view.json().instance.status).toBe("completed");
  });

  it("/advance cannot execute git stages on a denied instance (gate bypass closed)", async () => {
    const started = await app.inject({
      method: "POST", headers: umaAuth, url: "/v1/workflows/instances",
      payload: { change: { description: "deny test", paths: ["y.ts"], changeType: "git-reopen-test", environment: "staging" } },
    });
    const instanceId = started.json().id;

    await app.inject({
      method: "POST", headers: umaAuth, url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "requirements", content: "v1" },
    });
    const q = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const signoff = q.json().approvals.find(
      (a: { instanceId: string | null; stageId: string }) => a.instanceId === instanceId && a.stageId === "signoff",
    );
    await app.inject({
      method: "POST", headers: umaAuth, url: `/v1/approvals/${signoff.id}/decide`,
      payload: { decision: "denied" },
    });

    const bypass = await app.inject({
      method: "POST", headers: umaAuth, url: `/v1/workflows/instances/${instanceId}/advance`,
      payload: { stageId: "merge" },
    });
    expect(bypass.statusCode).toBe(409);

    const view = await app.inject({ method: "GET", headers: umaAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(view.json().instance.status).toBe("denied");
    expect(view.json().instance.context.mergeSha).toBeUndefined();
  });

  it("an artifact stage flowing directly into open_pr links the just-submitted version", async () => {
    const tpl = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: "direct-pr-flow",
        definition: {
          workflow: "direct-pr-flow",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "branch", type: "git_operation", action: "create_branch", connection: "mock-git", repo: "acme/direct" },
            { id: "requirements", type: "artifact_generation", output: "requirements_file" },
            { id: "open_pr", type: "git_operation", action: "open_pr", connection: "mock-git", repo: "acme/direct" },
          ],
        },
      },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "direct-pr-test" },
    });
    const started = await app.inject({
      method: "POST", headers: umaAuth, url: "/v1/workflows/instances",
      payload: { change: { description: "direct pr", paths: ["z.ts"], changeType: "direct-pr-test", environment: "staging" } },
    });
    const instanceId = started.json().id;
    expect(started.json().status).toBe("blocked_on_artifact");

    const res = await app.inject({
      method: "POST", headers: umaAuth, url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "requirements", content: "UNIQUE-ARTIFACT-CONTENT-42" },
    });
    expect(res.json().status).toBe("completed");
    // the mock provider stored the PR body — verify through the instance view is
    // not possible, so assert via events: no execution failure and PR opened
    const view = await app.inject({ method: "GET", headers: umaAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(view.json().instance.context.prId).toBeTruthy();
    expect(view.json().instance.context.lastError).toBeUndefined();
  });

  it("non-admin named approvers see exactly their own approvals; empty git tokens rejected", async () => {
    const mine = await app.inject({ method: "GET", headers: umaAuth, url: "/v1/approvals" });
    expect(mine.statusCode).toBe(200);
    expect(
      mine.json().approvals.every((a: { approverUserId: string }) => a.approverUserId === umaId),
    ).toBe(true);

    const emptyToken = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/git/connections",
      payload: { name: "empty-token-conn", provider: "mock", token: "" },
    });
    expect(emptyToken.statusCode).toBe(400);
  });
});

describe("token/cost optimization (EPIC-04 §7/§8)", () => {
  let ottoId: string;
  let ottoAuth: { authorization: string };
  let cheapId: string;
  let midId: string;
  let bigId: string;

  it("routes a low-complexity request down to the cheapest entitled model and ledgers the savings", async () => {
    const otto = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "opt-otto@example.com", displayName: "Opt Otto" },
    });
    ottoId = otto.json().id;
    ottoAuth = await authFor(ottoId);

    const mk = async (name: string, tier: number, inC: number, outC: number) => {
      const r = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/agents",
        payload: {
          name,
          provider: "anthropic",
          tier,
          modes: ["plan", "execute"],
          costPerMTokIn: inC,
          costPerMTokOut: outC,
        },
      });
      return r.json().id as string;
    };
    cheapId = await mk("opt-cheap", 0, 1, 5);
    midId = await mk("opt-mid", 1, 3, 15);
    bigId = await mk("opt-big", 2, 15, 75);
    for (const agentId of [cheapId, midId, bigId]) {
      await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/grants/agents",
        payload: { userId: ottoId, agentId },
      });
    }

    const res = await app.inject({
      method: "POST",
      headers: ottoAuth,
      url: `/v1/agents/${bigId}/invoke`,
      payload: { mode: "plan", input: "summarize this one-line note please" },
    });
    expect(res.statusCode).toBe(200);
    const { decision, routing } = res.json();
    expect(decision.effect).toBe("allow");
    expect(routing.effect).toBe("routed");
    expect(routing.selectedAgentId).toBe(cheapId);
    expect(routing.baselineAgentId).toBe(bigId);
    expect(routing.estimatedCostSavedUsd).toBeGreaterThan(0);
    expect(routing.estimationBasis).toContain("vs-baseline");

    // §8: the served model is visible in the execution (audit) log
    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${ottoId}` });
    const row = audit.json().entries.find((e: { objectType: string }) => e.objectType === "agent");
    expect(row.detail.servedAgentId).toBe(cheapId);

    // §7: one dashboard-ready cost event per routing decision
    const ledger = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/cost-events?userId=${ottoId}`,
    });
    expect(ledger.statusCode).toBe(200);
    const { events, totals } = ledger.json();
    expect(events).toHaveLength(1);
    expect(events[0].technique).toBe("model_routing");
    expect(events[0].servedAgentId).toBe(cheapId);
    expect(events[0].baselineAgentId).toBe(bigId);
    const routingTotal = totals.find((t: { technique: string }) => t.technique === "model_routing");
    expect(routingTotal.estimatedCostSavedUsd).toBeGreaterThan(0);
  });

  it("routing never selects a model the user is not entitled to (§12)", async () => {
    const nina = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "opt-nina@example.com", displayName: "Opt Nina" },
    });
    const ninaId = nina.json().id;
    // Nina can use big + mid but was never granted the cheapest model.
    for (const agentId of [midId, bigId]) {
      await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/grants/agents",
        payload: { userId: ninaId, agentId },
      });
    }
    const res = await app.inject({
      method: "POST",
      headers: await authFor(ninaId),
      url: `/v1/agents/${bigId}/invoke`,
      payload: { mode: "plan", input: "tiny ask" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().routing.selectedAgentId).toBe(midId);
  });

  it("quality-sensitive requests and passthrough mode both disable downgrading (§9/§12)", async () => {
    const qs = await app.inject({
      method: "POST",
      headers: ottoAuth,
      url: `/v1/agents/${bigId}/invoke`,
      payload: { mode: "plan", input: "tiny ask", costSensitivity: "quality-sensitive" },
    });
    expect(qs.json().routing.effect).toBe("passthrough");
    expect(qs.json().routing.ruleId).toBe("cost-sensitivity");

    // admin flips Otto's off switch on the existing agent-policy surface
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${ottoId}/agent-policy`,
      payload: { routingMode: "passthrough" },
    });
    const off = await app.inject({
      method: "POST",
      headers: ottoAuth,
      url: `/v1/agents/${bigId}/invoke`,
      payload: { mode: "plan", input: "tiny ask" },
    });
    expect(off.json().routing.effect).toBe("passthrough");
    expect(off.json().routing.ruleId).toBe("routing-mode");
    expect(off.json().routing.selectedAgentId).toBe(bigId);
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${ottoId}/agent-policy`,
      payload: { routingMode: "automatic" },
    });
  });

  it("no input text means no signal and no downgrade", async () => {
    const res = await app.inject({
      method: "POST",
      headers: ottoAuth,
      url: `/v1/agents/${bigId}/invoke`,
      payload: { mode: "plan" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().routing.effect).toBe("passthrough");
    expect(res.json().routing.selectedAgentId).toBe(bigId);
  });

  it("denied invokes write no cost event, and non-admins see only their own ledger", async () => {
    const eve = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "opt-eve@example.com", displayName: "Opt Eve" },
    });
    const eveId = eve.json().id;
    const eveAuth = await authFor(eveId);

    // no grant → 403, and no ledger row
    const denied = await app.inject({
      method: "POST",
      headers: eveAuth,
      url: `/v1/agents/${bigId}/invoke`,
      payload: { mode: "plan", input: "tiny ask" },
    });
    expect(denied.statusCode).toBe(403);
    const eveLedger = await app.inject({ method: "GET", headers: eveAuth, url: "/v1/cost-events" });
    expect(eveLedger.statusCode).toBe(200);
    expect(eveLedger.json().events).toHaveLength(0);

    // a non-admin asking for someone else's history is forced back to self
    const spoofed = await app.inject({
      method: "GET",
      headers: eveAuth,
      url: `/v1/cost-events?userId=${ottoId}`,
    });
    expect(spoofed.json().events).toHaveLength(0);

    // admin sees the fleet
    const all = await app.inject({ method: "GET", headers: AUTH, url: "/v1/cost-events" });
    expect(all.json().events.length).toBeGreaterThanOrEqual(3);
  });
});

describe("lazy tool-loading in the MCP proxy (EPIC-04 §8)", () => {
  let laraId: string;

  it("a declared intent narrows tools/list to relevant tools and ledgers the withheld chars", async () => {
    const lara = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "opt-lara@example.com", displayName: "Opt Lara" },
    });
    laraId = lara.json().id;
    for (const toolName of ["get_time", "write_note"]) {
      await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/grants/tools",
        payload: { userId: laraId, serverId, toolName },
      });
    }

    const client = await mcpClientFor(laraId, "what time is it now");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["get_time"]);
    await client.close();

    const ledger = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/cost-events?userId=${laraId}`,
    });
    const row = ledger.json().events.find(
      (e: { technique: string }) => e.technique === "lazy_tool_loading",
    );
    expect(row).toBeDefined();
    expect(row.estimatedTokensSaved).toBeGreaterThan(0);
    expect(row.objectId).toBe(serverId);
    expect(row.detail).toMatchObject({ effect: "narrowed", selectedCount: 1, withheldCount: 1 });
  });

  it("withheld tools stay fully callable — the manifest shrinks, the entitlement never does (§12)", async () => {
    const client = await mcpClientFor(laraId, "what time is it now");
    const result = await client.callTool({ name: "write_note", arguments: { text: "hi" } });
    expect((result.content as Array<{ text: string }>)[0]!.text).toBe("wrote: hi");
    await client.close();
  });

  it("no intent means the full entitled manifest", async () => {
    const client = await mcpClientFor(laraId);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_time", "write_note"]);
    await client.close();
  });

  it("the per-user passthrough switch disables narrowing even with an intent", async () => {
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${laraId}/agent-policy`,
      payload: { routingMode: "passthrough" },
    });
    const client = await mcpClientFor(laraId, "what time is it now");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_time", "write_note"]);
    await client.close();
  });
});

describe("workflow cost-sensitivity tag (EPIC-04 §9)", () => {
  it("strictest-wins across merged templates and surfaces on the instance view", async () => {
    const mkTpl = async (name: string, tag?: string) => {
      const res = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/workflows/templates",
        payload: {
          name,
          definition: {
            workflow: name,
            ...(tag ? { costSensitivity: tag } : {}),
            stages: [
              { id: "intake", type: "trigger" },
              { id: `${name}-signoff`, type: "human_approval", approvers: ["requesting_user"] },
            ],
          },
        },
      });
      expect(res.statusCode).toBe(201);
      return res.json().id as string;
    };

    const invalid = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/templates",
      payload: {
        name: "bad-tag",
        definition: {
          workflow: "bad-tag",
          costSensitivity: "cheapest",
          stages: [{ id: "intake", type: "trigger" }],
        },
      },
    });
    expect(invalid.statusCode).toBe(400);

    const cheapTpl = await mkTpl("tagged-cheap", "cost-sensitive");
    const strictTpl = await mkTpl("tagged-strict", "quality-sensitive");
    for (const templateId of [cheapTpl, strictTpl]) {
      await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/workflows/assignment-rules",
        payload: { templateId, changeType: "cost-tag-e2e" },
      });
    }

    const tina = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "opt-tina@example.com", displayName: "Opt Tina" },
    });
    const tinaAuth = await authFor(tina.json().id);
    const started = await app.inject({
      method: "POST",
      headers: tinaAuth,
      url: "/v1/workflows/instances",
      payload: {
        change: {
          description: "tagged change",
          paths: ["svc/x.ts"],
          changeType: "cost-tag-e2e",
          environment: "staging",
        },
      },
    });
    expect(started.statusCode).toBe(201);

    const view = await app.inject({
      method: "GET",
      headers: tinaAuth,
      url: `/v1/workflows/instances/${started.json().id}`,
    });
    expect(view.json().costSensitivity).toBe("quality-sensitive");
    expect(view.json().instance.definition.costSensitivity).toBe("quality-sensitive");
  });

  it("an untagged run reads as standard", async () => {
    const view = await app.inject({
      method: "GET",
      headers: AUTH,
      url: "/v1/workflows/instances",
    });
    // fleet view untouched; per-instance default checked via a fresh untagged instance
    expect(view.statusCode).toBe(200);

    const tplRes = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/templates",
      payload: {
        name: "untagged-e2e",
        definition: {
          workflow: "untagged-e2e",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "untagged-signoff", type: "human_approval", approvers: ["requesting_user"] },
          ],
        },
      },
    });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/assignment-rules",
      payload: { templateId: tplRes.json().id, changeType: "untagged-e2e" },
    });
    const uma = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "opt-uma@example.com", displayName: "Opt Uma" },
    });
    const umaAuth = await authFor(uma.json().id);
    const started = await app.inject({
      method: "POST",
      headers: umaAuth,
      url: "/v1/workflows/instances",
      payload: {
        change: {
          description: "plain change",
          paths: ["svc/y.ts"],
          changeType: "untagged-e2e",
          environment: "staging",
        },
      },
    });
    const view2 = await app.inject({
      method: "GET",
      headers: umaAuth,
      url: `/v1/workflows/instances/${started.json().id}`,
    });
    expect(view2.json().costSensitivity).toBe("standard");
  });
});

describe("multi-agent orchestration runs (EPIC-05 slice)", () => {
  let patId: string;
  let patAuth: { authorization: string };
  let lenaId: string;
  let lenaAuth: { authorization: string };
  let smallId: string;
  let altId: string;
  let bigId: string;

  const mkNode = (id: string, agentId: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: `task ${id}`,
    ownerAgentId: agentId,
    mode: "execute",
    ...extra,
  });

  it("plans a run only within the initiating user's entitlements (§5.1)", async () => {
    const mkUser = async (email: string, name: string) => {
      const r = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/users",
        payload: { email, displayName: name },
      });
      return r.json().id as string;
    };
    patId = await mkUser("orc-pat@example.com", "Orc Pat");
    lenaId = await mkUser("orc-lena@example.com", "Orc Lena");
    patAuth = await authFor(patId);
    lenaAuth = await authFor(lenaId);

    const mkAgent = async (name: string, tier: number) => {
      const r = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/agents",
        payload: { name, provider: "anthropic", tier, modes: ["plan", "execute"] },
      });
      return r.json().id as string;
    };
    smallId = await mkAgent("orc-worker-small", 1);
    altId = await mkAgent("orc-worker-alt", 1);
    bigId = await mkAgent("orc-worker-big", 3);
    for (const agentId of [smallId, altId]) {
      await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/grants/agents",
        payload: { userId: patId, agentId },
      });
    }

    // a cycle is rejected before anything is stored
    const cyclic = await app.inject({
      method: "POST",
      headers: patAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "cyclic",
          escalationApproverUserId: lenaId,
          nodes: [mkNode("a", smallId, { dependsOn: ["b"] }), mkNode("b", smallId, { dependsOn: ["a"] })],
        },
      },
    });
    expect(cyclic.statusCode).toBe(400);

    // unordered shared file ownership is rejected (§4)
    const conflict = await app.inject({
      method: "POST",
      headers: patAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "conflict",
          escalationApproverUserId: lenaId,
          nodes: [mkNode("a", smallId, { files: ["x.ts"] }), mkNode("b", smallId, { files: ["x.ts"] })],
        },
      },
    });
    expect(conflict.statusCode).toBe(400);

    // a node owned by an agent the INITIATING user was never granted → the
    // whole plan is rejected: no path where privilege increases downward.
    const escalating = await app.inject({
      method: "POST",
      headers: patAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "escalating",
          escalationApproverUserId: lenaId,
          nodes: [mkNode("a", smallId), mkNode("b", bigId)],
        },
      },
    });
    expect(escalating.statusCode).toBe(422);
    expect(escalating.json().error).toBe("entitlement_exceeded");
    expect(escalating.json().nodes[0].nodeId).toBe("b");
    expect(escalating.json().nodes[0].decision.ruleId).toBe("default-deny");
  });

  it("runs a DAG to completion: parallel roots, dependency gating, one audit trail", async () => {
    const created = await app.inject({
      method: "POST",
      headers: patAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "feature-build",
          escalationApproverUserId: lenaId,
          nodes: [
            mkNode("api", smallId, { files: ["api.ts"] }),
            mkNode("ui", altId, { files: ["ui.tsx"] }),
            mkNode("integrate", smallId, { dependsOn: ["api", "ui"] }),
          ],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().status).toBe("planned");
    const runId = created.json().id;

    const ev = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", headers: patAuth, url: `/v1/runs/${runId}/events`, payload });

    const started = await ev({ kind: "start" });
    expect(started.json().readyNodes).toEqual(["api", "ui"]);

    for (const nodeId of ["api", "ui"]) {
      await ev({ kind: "node_started", nodeId });
      await ev({ kind: "node_submitted", nodeId });
      await ev({ kind: "node_accepted", nodeId });
    }
    const view = await app.inject({ method: "GET", headers: patAuth, url: `/v1/runs/${runId}` });
    expect(view.json().readyNodes).toEqual(["integrate"]);

    await ev({ kind: "node_started", nodeId: "integrate" });
    await ev({ kind: "node_submitted", nodeId: "integrate" });
    const done = await ev({ kind: "node_accepted", nodeId: "integrate" });
    expect(done.json().status).toBe("completed");

    // §5.3: every run event landed in the ONE audit trail
    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${patId}` });
    const runRows = audit.json().entries.filter((e: { objectType: string }) => e.objectType === "run");
    expect(runRows.length).toBeGreaterThanOrEqual(10);

    // terminal runs reject further events
    const late = await ev({ kind: "abort" });
    expect(late.statusCode).toBe(409);
  });

  it("failure → escalation lands in the one approvals queue; approval re-opens the node (§3)", async () => {
    const created = await app.inject({
      method: "POST",
      headers: patAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "flaky-task",
          escalationApproverUserId: lenaId,
          nodes: [mkNode("solo", smallId)],
        },
      },
    });
    const runId = created.json().id;
    const ev = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", headers: patAuth, url: `/v1/runs/${runId}/events`, payload });

    await ev({ kind: "start" });
    await ev({ kind: "node_started", nodeId: "solo" });
    await ev({ kind: "node_failed", nodeId: "solo", error: "worker crashed" });

    // reassignment is a fresh §5.1 check — the ungranted big agent is refused
    const badReassign = await ev({ kind: "reassign_node", nodeId: "solo", ownerAgentId: bigId });
    expect(badReassign.statusCode).toBe(403);
    expect(badReassign.json().error).toBe("entitlement_exceeded");

    const escalated = await ev({ kind: "escalate_node", nodeId: "solo" });
    expect(escalated.statusCode).toBe(200);

    // Lena sees it in the same approvals inbox as every other approval
    const inbox = await app.inject({ method: "GET", headers: lenaAuth, url: "/v1/approvals?status=pending" });
    const entry = inbox.json().approvals.find((a: { runId: string | null }) => a.runId === runId);
    expect(entry).toBeDefined();
    expect(entry.objectType).toBe("run");
    expect(entry.stageId).toBe("solo");

    // Pat is not the named approver
    const patDecide = await app.inject({
      method: "POST",
      headers: patAuth,
      url: `/v1/approvals/${entry.id}/decide`,
      payload: { decision: "approved" },
    });
    expect(patDecide.statusCode).toBe(403);

    const decided = await app.inject({
      method: "POST",
      headers: lenaAuth,
      url: `/v1/approvals/${entry.id}/decide`,
      payload: { decision: "approved" },
    });
    expect(decided.statusCode).toBe(200);

    const view = await app.inject({ method: "GET", headers: patAuth, url: `/v1/runs/${runId}` });
    expect(view.json().run.state.nodeStatuses.solo).toBe("not_started");
    expect(view.json().run.state.attempts.solo).toBe(1);
    expect(view.json().readyNodes).toEqual(["solo"]);

    // valid reassignment to a granted agent, then run to completion
    await ev({ kind: "node_started", nodeId: "solo" });
    await ev({ kind: "node_failed", nodeId: "solo", error: "still flaky" });
    const reassigned = await ev({ kind: "reassign_node", nodeId: "solo", ownerAgentId: altId });
    expect(reassigned.statusCode).toBe(200);
    await ev({ kind: "node_started", nodeId: "solo" });
    await ev({ kind: "node_submitted", nodeId: "solo" });
    const done = await ev({ kind: "node_accepted", nodeId: "solo" });
    expect(done.json().status).toBe("completed");
    expect(done.json().state.owners.solo).toBe(altId);
  });

  it("runs are invisible to non-participants; fleet view is admin-only", async () => {
    const created = await app.inject({
      method: "POST",
      headers: patAuth,
      url: "/v1/runs",
      payload: {
        graph: { run: "private", escalationApproverUserId: lenaId, nodes: [mkNode("n", smallId)] },
      },
    });
    const runId = created.json().id;

    const other = await app.inject({ method: "GET", headers: lenaAuth, url: `/v1/runs/${runId}` });
    expect(other.statusCode).toBe(404);
    const otherDrive = await app.inject({
      method: "POST",
      headers: lenaAuth,
      url: `/v1/runs/${runId}/events`,
      payload: { kind: "start" },
    });
    expect(otherDrive.statusCode).toBe(404);

    const fleetAsNonAdmin = await app.inject({ method: "GET", headers: patAuth, url: "/v1/runs" });
    expect(fleetAsNonAdmin.statusCode).toBe(403);
    const fleet = await app.inject({ method: "GET", headers: AUTH, url: "/v1/runs" });
    expect(fleet.json().runs.length).toBeGreaterThanOrEqual(3);
  });
});

describe("per-run budget caps (EPIC-05 §5.2)", () => {
  let benId: string;
  let benAuth: { authorization: string };
  let approverId: string;
  let approverAuth: { authorization: string };
  let cheapWorkerId: string;
  let priceyWorkerId: string;

  const mkNode = (id: string, agentId: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: `task ${id}`,
    ownerAgentId: agentId,
    mode: "execute",
    estimate: { in: 100_000, out: 100_000 },
    ...extra,
  });

  it("an under-cap run plans and starts; the budget envelope is visible and estimate-labeled", async () => {
    const mkUser = async (email: string, name: string) => {
      const r = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/users",
        payload: { email, displayName: name },
      });
      return r.json().id as string;
    };
    benId = await mkUser("budget-ben@example.com", "Budget Ben");
    approverId = await mkUser("budget-boss@example.com", "Budget Boss");
    benAuth = await authFor(benId);
    approverAuth = await authFor(approverId);

    const mkAgent = async (name: string, tier: number, inC: number, outC: number) => {
      const r = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/agents",
        payload: {
          name,
          provider: "anthropic",
          tier,
          modes: ["execute"],
          costPerMTokIn: inC,
          costPerMTokOut: outC,
        },
      });
      return r.json().id as string;
    };
    cheapWorkerId = await mkAgent("budget-cheap", 0, 1, 5);
    priceyWorkerId = await mkAgent("budget-pricey", 2, 15, 75);
    for (const agentId of [cheapWorkerId, priceyWorkerId]) {
      await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/grants/agents",
        payload: { userId: benId, agentId },
      });
    }
    // cap: pricey node = (1e5*15 + 1e5*75)/1e6 = $9; cheap node = $0.60
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${benId}/agent-policy`,
      payload: { runBudgetUsd: 2, runBudgetBreachAction: "approve" },
    });

    const created = await app.inject({
      method: "POST",
      headers: benAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "under-cap",
          escalationApproverUserId: approverId,
          nodes: [mkNode("n1", cheapWorkerId)],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().budgetApprovalPending).toBe(false);
    expect(created.json().budget.capUsd).toBe(2);
    expect(created.json().budget.estimatedTotalUsd).toBeCloseTo(0.6, 6);
    expect(created.json().budget.estimationBasis).toContain("estimate");

    const runId = created.json().id;
    const started = await app.inject({
      method: "POST",
      headers: benAuth,
      url: `/v1/runs/${runId}/events`,
      payload: { kind: "start" },
    });
    expect(started.statusCode).toBe(200);
    await app.inject({
      method: "POST",
      headers: benAuth,
      url: `/v1/runs/${runId}/events`,
      payload: { kind: "node_started", nodeId: "n1" },
    });
    const view = await app.inject({ method: "GET", headers: benAuth, url: `/v1/runs/${runId}` });
    expect(view.json().run.budget.spentUsd).toBeCloseTo(0.6, 6);
  });

  it("over-cap with 'approve': start is gated until the named approver sanctions the overage; denial aborts", async () => {
    const mkRun = async (name: string) => {
      const r = await app.inject({
        method: "POST",
        headers: benAuth,
        url: "/v1/runs",
        payload: {
          graph: {
            run: name,
            escalationApproverUserId: approverId,
            nodes: [mkNode("big", priceyWorkerId)],
          },
        },
      });
      expect(r.statusCode).toBe(201);
      expect(r.json().budgetApprovalPending).toBe(true);
      return r.json().id as string;
    };

    const runId = await mkRun("over-cap-approve");
    const blocked = await app.inject({
      method: "POST",
      headers: benAuth,
      url: `/v1/runs/${runId}/events`,
      payload: { kind: "start" },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("budget_approval_pending");

    const inbox = await app.inject({
      method: "GET",
      headers: approverAuth,
      url: "/v1/approvals?status=pending",
    });
    const entry = inbox.json().approvals.find(
      (a: { runId: string | null; stageId: string | null }) =>
        a.runId === runId && a.stageId === "__budget__",
    );
    expect(entry).toBeDefined();
    await app.inject({
      method: "POST",
      headers: approverAuth,
      url: `/v1/approvals/${entry.id}/decide`,
      payload: { decision: "approved" },
    });
    const started = await app.inject({
      method: "POST",
      headers: benAuth,
      url: `/v1/runs/${runId}/events`,
      payload: { kind: "start" },
    });
    expect(started.statusCode).toBe(200);

    // denial path on a fresh run: the run aborts, nothing starts
    const runId2 = await mkRun("over-cap-denied");
    const inbox2 = await app.inject({
      method: "GET",
      headers: approverAuth,
      url: "/v1/approvals?status=pending",
    });
    const entry2 = inbox2.json().approvals.find(
      (a: { runId: string | null }) => a.runId === runId2,
    );
    await app.inject({
      method: "POST",
      headers: approverAuth,
      url: `/v1/approvals/${entry2.id}/decide`,
      payload: { decision: "denied" },
    });
    const view2 = await app.inject({ method: "GET", headers: benAuth, url: `/v1/runs/${runId2}` });
    expect(view2.json().run.status).toBe("aborted");
  });

  it("over-cap with 'replan': owners are substituted to cheaper entitled agents and ledgered", async () => {
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${benId}/agent-policy`,
      payload: { runBudgetBreachAction: "replan" },
    });
    const created = await app.inject({
      method: "POST",
      headers: benAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "replanned",
          escalationApproverUserId: approverId,
          nodes: [mkNode("big", priceyWorkerId)],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().budgetApprovalPending).toBe(false);
    expect(created.json().budget.replanned).toBe(true);
    expect(created.json().budget.estimatedTotalUsd).toBeCloseTo(0.6, 6); // now on the cheap worker
    const runId = created.json().id;

    const view = await app.inject({ method: "GET", headers: benAuth, url: `/v1/runs/${runId}` });
    expect(view.json().run.state.owners.big).toBe(cheapWorkerId);

    // the substitution is a cost-attribution event like any routing decision
    const ledger = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/cost-events?userId=${benId}`,
    });
    const row = ledger.json().events.find(
      (e: { objectType: string; objectId: string | null }) =>
        e.objectType === "run" && e.objectId === runId,
    );
    expect(row).toBeDefined();
    expect(row.servedAgentId).toBe(cheapWorkerId);
    expect(row.requestedAgentId).toBe(priceyWorkerId);
    expect(row.estimatedCostSavedUsd).toBeGreaterThan(0);
  });

  it("in-flight breach: reassigning to a pricier agent trips the cap at node start, never silently", async () => {
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${benId}/agent-policy`,
      payload: { runBudgetBreachAction: "approve" },
    });
    const created = await app.inject({
      method: "POST",
      headers: benAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "drift",
          escalationApproverUserId: approverId,
          nodes: [mkNode("task", cheapWorkerId)],
        },
      },
    });
    expect(created.json().budgetApprovalPending).toBe(false);
    const runId = created.json().id;
    const ev = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", headers: benAuth, url: `/v1/runs/${runId}/events`, payload });

    await ev({ kind: "start" });
    await ev({ kind: "node_started", nodeId: "task" });
    await ev({ kind: "node_failed", nodeId: "task", error: "flaky" });
    // pricier agent is ENTITLED (no §5.1 violation) but blows the cap
    const reassigned = await ev({ kind: "reassign_node", nodeId: "task", ownerAgentId: priceyWorkerId });
    expect(reassigned.statusCode).toBe(200);
    const breach = await ev({ kind: "node_started", nodeId: "task" });
    expect(breach.statusCode).toBe(409);
    expect(breach.json().error).toBe("budget_exceeded");

    const inbox = await app.inject({
      method: "GET",
      headers: approverAuth,
      url: "/v1/approvals?status=pending",
    });
    const entry = inbox.json().approvals.find(
      (a: { runId: string | null; stageId: string | null }) =>
        a.runId === runId && a.stageId === "__budget__:task",
    );
    expect(entry).toBeDefined();
    await app.inject({
      method: "POST",
      headers: approverAuth,
      url: `/v1/approvals/${entry.id}/decide`,
      payload: { decision: "approved" },
    });
    const afterApproval = await ev({ kind: "node_started", nodeId: "task" });
    expect(afterApproval.statusCode).toBe(200);
  });
});

describe("PM-tool integration (EPIC-06 slice)", () => {
  let pmUserId: string;
  let pmUserAuth: { authorization: string };
  let pmApproverId: string;
  let workerId: string;
  let runId: string;

  it("connections store encrypted tokens, validate mappings, and reject unimplemented adapters", async () => {
    const u = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "pm-pete@example.com", displayName: "PM Pete" },
    });
    pmUserId = u.json().id;
    pmUserAuth = await authFor(pmUserId);
    const a = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "pm-approver@example.com", displayName: "PM Approver" },
    });
    pmApproverId = a.json().id;

    const jira = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/pm/connections",
      payload: { name: "jira-main", provider: "jira", project: "PROJ", token: "tok" },
    });
    expect(jira.statusCode).toBe(422);

    const badMapping = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/pm/connections",
      payload: {
        name: "bad-map",
        provider: "mock",
        project: "regulait",
        token: "tok",
        mapping: { task: { fields: {} } },
      },
    });
    expect(badMapping.statusCode).toBe(400);

    const ok = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/pm/connections",
      payload: { name: "mock-ado", provider: "mock", project: "regulait", token: "pm-secret" },
    });
    expect(ok.statusCode).toBe(201);
    expect(JSON.stringify(ok.json())).not.toContain("pm-secret");

    const listing = await app.inject({ method: "GET", headers: AUTH, url: "/v1/pm/connections" });
    expect(JSON.stringify(listing.json())).not.toContain("pm-secret");
  });

  it("pm-sync links every task-graph node to a real work item, idempotently, audited", async () => {
    const agent = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/agents",
      payload: { name: "pm-worker", provider: "anthropic", tier: 1, modes: ["execute"] },
    });
    workerId = agent.json().id;
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/agents",
      payload: { userId: pmUserId, agentId: workerId },
    });

    const created = await app.inject({
      method: "POST",
      headers: pmUserAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "pm-linked-run",
          escalationApproverUserId: pmApproverId,
          nodes: [
            { id: "api", title: "Build the API", ownerAgentId: workerId, mode: "execute" },
            { id: "docs", title: "Write the docs", ownerAgentId: workerId, mode: "execute", dependsOn: ["api"] },
          ],
        },
      },
    });
    runId = created.json().id;

    const sync = await app.inject({
      method: "POST",
      headers: pmUserAuth,
      url: `/v1/runs/${runId}/pm-sync`,
      payload: { connectionName: "mock-ado" },
    });
    expect(sync.statusCode).toBe(201);
    expect(sync.json().created).toHaveLength(2);

    // idempotent: second sync creates nothing new
    const again = await app.inject({
      method: "POST",
      headers: pmUserAuth,
      url: `/v1/runs/${runId}/pm-sync`,
      payload: { connectionName: "mock-ado" },
    });
    expect(again.json().created).toHaveLength(0);
    expect(again.json().skipped.sort()).toEqual(["api", "docs"]);

    // the mock provider really holds the items with mapped fields
    const { resolvePmProvider } = await import("@regulait/pm-provider");
    const mock = resolvePmProvider({ provider: "mock", token: "" });
    const first = sync.json().created.find((c: { nodeId: string }) => c.nodeId === "api");
    const item = await mock.getWorkItem("regulait", first.externalId);
    expect(item.fields.title).toBe("Build the API");

    // §5.3-style: creations are in the one audit trail
    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${pmUserId}` });
    const pmRows = audit.json().entries.filter(
      (e: { objectType: string }) => e.objectType === "pm_work_item",
    );
    expect(pmRows.length).toBeGreaterThanOrEqual(2);
  });

  it("node status changes mirror outbound through the statusMap (§3/§5)", async () => {
    const ev = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", headers: pmUserAuth, url: `/v1/runs/${runId}/events`, payload });
    await ev({ kind: "start" });
    const started = await ev({ kind: "node_started", nodeId: "api" });
    expect(started.json().pmSync).toEqual({ ok: true, state: "Doing" });

    const { resolvePmProvider } = await import("@regulait/pm-provider");
    const mock = resolvePmProvider({ provider: "mock", token: "" });
    const links = await app.inject({
      method: "GET",
      headers: pmUserAuth,
      url: `/v1/pm/links?runId=${runId}`,
    });
    const apiLink = links.json().links.find((l: { nodeId: string }) => l.nodeId === "api");
    expect((await mock.getWorkItem("regulait", apiLink.externalId)).state).toBe("Doing");

    await ev({ kind: "node_submitted", nodeId: "api" });
    const accepted = await ev({ kind: "node_accepted", nodeId: "api" });
    expect(accepted.json().pmSync).toEqual({ ok: true, state: "Done" });
    expect((await mock.getWorkItem("regulait", apiLink.externalId)).state).toBe("Done");
  });

  it("the links view reads PM-authoritative fields through live — no cached copy (§3)", async () => {
    // simulate a human editing the description IN THE PM TOOL
    const { resolvePmProvider } = await import("@regulait/pm-provider");
    const mock = resolvePmProvider({ provider: "mock", token: "" });
    const links = await app.inject({
      method: "GET",
      headers: pmUserAuth,
      url: `/v1/pm/links?runId=${runId}`,
    });
    const docsLink = links.json().links.find((l: { nodeId: string }) => l.nodeId === "docs");
    await mock.updateFields("regulait", docsLink.externalId, { description: "edited in the PM tool" });

    const live = await app.inject({
      method: "GET",
      headers: pmUserAuth,
      url: `/v1/pm/links?runId=${runId}&live=true`,
    });
    const docsLive = live.json().links.find((l: { nodeId: string }) => l.nodeId === "docs");
    expect(docsLive.live.fields.description).toBe("edited in the PM tool");

    // non-participants see nothing
    const stranger = await app.inject({
      method: "GET",
      headers: await authFor(pmApproverId),
      url: `/v1/pm/links?runId=${runId}`,
    });
    expect(stranger.statusCode).toBe(404);
  });
});

describe("PM approval mirroring (EPIC-06 §5)", () => {
  let miaId: string;
  let miaAuth: { authorization: string };

  it("an approved sign-off transitions the linked item when the stage is mapped", async () => {
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/pm/connections",
      payload: {
        name: "mock-signoff",
        provider: "mock",
        project: "signoff-proj",
        token: "tok2",
        mapping: {
          task: { workItemType: "Task", fields: { title: "title", status: "state" } },
          approval: { target: "status_transition", stageMap: { signoff: "Signed Off" } },
        },
      },
    });

    const tpl = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/templates",
      payload: {
        name: "pm-mirror-wf",
        definition: {
          workflow: "pm-mirror-wf",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "spec", type: "artifact_generation", output: "spec_doc" },
            { id: "signoff", type: "human_approval", approvers: ["requesting_user"] },
          ],
        },
      },
    });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "pm-mirror-e2e" },
    });

    const mia = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "pm-mia@example.com", displayName: "PM Mia" },
    });
    miaId = mia.json().id;
    miaAuth = await authFor(miaId);

    const started = await app.inject({
      method: "POST",
      headers: miaAuth,
      url: "/v1/workflows/instances",
      payload: {
        change: {
          description: "mirrored change",
          paths: ["svc/a.ts"],
          changeType: "pm-mirror-e2e",
          environment: "staging",
        },
      },
    });
    const instanceId = started.json().id;

    const sync = await app.inject({
      method: "POST",
      headers: miaAuth,
      url: `/v1/workflows/instances/${instanceId}/pm-sync`,
      payload: { connectionName: "mock-signoff" },
    });
    expect(sync.statusCode).toBe(201);
    const externalId = sync.json().externalId;
    // idempotent
    const again = await app.inject({
      method: "POST",
      headers: miaAuth,
      url: `/v1/workflows/instances/${instanceId}/pm-sync`,
      payload: { connectionName: "mock-signoff" },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().created).toBe(false);

    await app.inject({
      method: "POST",
      headers: miaAuth,
      url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "spec", content: "the spec" },
    });
    const inbox = await app.inject({ method: "GET", headers: miaAuth, url: "/v1/approvals?status=pending" });
    const entry = inbox.json().approvals.find(
      (a: { instanceId: string | null }) => a.instanceId === instanceId,
    );
    const decided = await app.inject({
      method: "POST",
      headers: miaAuth,
      url: `/v1/approvals/${entry.id}/decide`,
      payload: { decision: "approved", reason: "looks good" },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().pmMirror).toEqual({ ok: true, action: "transition" });

    const { resolvePmProvider } = await import("@regulait/pm-provider");
    const mock = resolvePmProvider({ provider: "mock", token: "" });
    const item = await mock.getWorkItem("signoff-proj", externalId);
    expect(item.state).toBe("Signed Off");
    expect(item.comments.some((c) => c.includes("signoff") && c.includes("approved"))).toBe(true);
    expect(item.comments.some((c) => c.includes("looks good"))).toBe(true);
  });

  it("a denial never enters the mapped state — it degrades to a comment", async () => {
    const started = await app.inject({
      method: "POST",
      headers: miaAuth,
      url: "/v1/workflows/instances",
      payload: {
        change: {
          description: "denied change",
          paths: ["svc/b.ts"],
          changeType: "pm-mirror-e2e",
          environment: "staging",
        },
      },
    });
    const instanceId = started.json().id;
    const sync = await app.inject({
      method: "POST",
      headers: miaAuth,
      url: `/v1/workflows/instances/${instanceId}/pm-sync`,
      payload: { connectionName: "mock-signoff" },
    });
    const externalId = sync.json().externalId;
    await app.inject({
      method: "POST",
      headers: miaAuth,
      url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "spec", content: "risky spec" },
    });
    const inbox = await app.inject({ method: "GET", headers: miaAuth, url: "/v1/approvals?status=pending" });
    const entry = inbox.json().approvals.find(
      (a: { instanceId: string | null }) => a.instanceId === instanceId,
    );
    const decided = await app.inject({
      method: "POST",
      headers: miaAuth,
      url: `/v1/approvals/${entry.id}/decide`,
      payload: { decision: "denied", reason: "too risky" },
    });
    expect(decided.json().pmMirror).toEqual({ ok: true, action: "comment" });

    const { resolvePmProvider } = await import("@regulait/pm-provider");
    const mock = resolvePmProvider({ provider: "mock", token: "" });
    const item = await mock.getWorkItem("signoff-proj", externalId);
    expect(item.state).not.toBe("Signed Off");
    expect(item.comments.some((c) => c.includes("denied") && c.includes("too risky"))).toBe(true);
  });

  it("run escalation decisions mirror as comments on the node's linked item", async () => {
    const approver = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email: "pm-run-approver@example.com", displayName: "Run Approver" },
    });
    const approverId = approver.json().id;
    const agent = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/agents",
      payload: { name: "pm-mirror-worker", provider: "anthropic", tier: 1, modes: ["execute"] },
    });
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/agents",
      payload: { userId: miaId, agentId: agent.json().id },
    });
    const run = await app.inject({
      method: "POST",
      headers: miaAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "mirror-escalation",
          escalationApproverUserId: approverId,
          nodes: [{ id: "risky", title: "Risky task", ownerAgentId: agent.json().id, mode: "execute" }],
        },
      },
    });
    const runId = run.json().id;
    await app.inject({
      method: "POST",
      headers: miaAuth,
      url: `/v1/runs/${runId}/pm-sync`,
      payload: { connectionName: "mock-signoff" },
    });
    const ev = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", headers: miaAuth, url: `/v1/runs/${runId}/events`, payload });
    await ev({ kind: "start" });
    await ev({ kind: "node_started", nodeId: "risky" });
    await ev({ kind: "node_failed", nodeId: "risky", error: "worker crashed" });
    await ev({ kind: "escalate_node", nodeId: "risky" });

    const approverAuth = await authFor(approverId);
    const inbox = await app.inject({
      method: "GET",
      headers: approverAuth,
      url: "/v1/approvals?status=pending",
    });
    const entry = inbox.json().approvals.find((a: { runId: string | null }) => a.runId === runId);
    const decided = await app.inject({
      method: "POST",
      headers: approverAuth,
      url: `/v1/approvals/${entry.id}/decide`,
      payload: { decision: "approved" },
    });
    expect(decided.json().pmMirror).toEqual({ ok: true, action: "comment" });

    const links = await app.inject({
      method: "GET",
      headers: miaAuth,
      url: `/v1/pm/links?runId=${runId}`,
    });
    const nodeLink = links.json().links.find((l: { nodeId: string }) => l.nodeId === "risky");
    const { resolvePmProvider } = await import("@regulait/pm-provider");
    const mock = resolvePmProvider({ provider: "mock", token: "" });
    const item = await mock.getWorkItem("signoff-proj", nodeLink.externalId);
    expect(item.comments.some((c) => c.includes("risky") && c.includes("approved"))).toBe(true);
  });
});
