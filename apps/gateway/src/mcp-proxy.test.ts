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

async function mcpClientFor(userId: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp/${serverId}`), {
    requestInit: { headers: { authorization: `Bearer ${await apiKeyFor(userId)}` } },
  });
  await client.connect(transport);
  return client;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });

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
