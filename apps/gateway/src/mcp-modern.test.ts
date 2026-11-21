/**
 * ADR-0311 decision 4, slices 1 and 2 — the MCP 2026-07-28 stateless protocol on `POST /mcp/:serverId`, beside
 * the unchanged 2025-era path, on a real database through the real app. Slice 2 adds the governed resources,
 * prompts and completion (the ADR-0185 G3 primitive, shared with the 2025-era path).
 *
 * The governance pipeline is the SAME code for both eras (`listToolsForCaller` / `callToolForCaller`), so these
 * cases pin the modern wire (discover, the envelope and header ladder, deterministic order, the refused methods)
 * and that a modern call lands the same decisions and audit rows a 2025-era call does.
 *
 * Global state (M-068): the loopback egress allow entry, the relaxed gates and the org transports are restored in
 * afterAll; every server row this file made is removed.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client as ModernClient, StreamableHTTPClientTransport as ModernClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { and, auditLog, createDb, desc, eq, inArray, mcpServers, mcpTools, orgSettings, ORG_SETTINGS_ID, runMigrations, sql, type Db } from "@regulait/db";
import { MCP_PROTOCOL_METHODS } from "@regulait/shared";
import { buildApp } from "./app.js";
import { setStdioPlacementAffinityForTest } from "./executor-stdio.js";
import { MCP_STDIO_NO_ENTITLEMENT_RULE_ID } from "./mcp-proxy.js";
import { relaxStepUpAround, relaxStepUpForTest } from "./testing/step-up-posture.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxApprovalSigningForTest } from "./testing/approval-signing-posture.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { removeEgressAllowEntry } from "./testing/egress-allow-cleanup.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `modern-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const REVISION = "2026-07-28";
const STDIO_IMAGE = `sha256:${"c".repeat(64)}`;

// --- the upstream double: tools registered out of name order, and a request counter ---

let upstreamRequests = 0;
function buildUpstream(): McpServer {
  const server = new McpServer({ name: "modern-upstream", version: "0.0.1" }, { capabilities: { logging: {} } });
  // slice 2: resources (one emits a log line and progress), a prompt with a completable argument
  server.registerResource("readme", "file:///public/readme.md", { mimeType: "text/markdown" }, async (uri, extra) => {
    await extra.sendNotification({ method: "notifications/message", params: { level: "info", data: "readme was read" } });
    const progressToken = extra._meta?.progressToken;
    if (progressToken !== undefined) {
      await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: 1, total: 2 } });
    }
    return { contents: [{ uri: uri.href, text: "# public readme" }] };
  });
  server.registerResource("secret", "file:///private/secret.md", { mimeType: "text/markdown" }, async (uri) => ({
    contents: [{ uri: uri.href, text: "private plans" }],
  }));
  server.registerPrompt("greet", { description: "greets", argsSchema: { who: completable(z.string(), (v) => ["world", "team"].filter((x) => x.startsWith(v))) } }, async ({ who }) => ({
    messages: [{ role: "user", content: { type: "text", text: `Say hello to ${who}` } }],
  }));
  server.registerTool("zeta_read", { description: "z", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({
    content: [{ type: "text", text: "zeta" }],
  }));
  server.registerTool("alpha_read", { description: "a", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({
    content: [{ type: "text", text: "alpha" }],
  }));
  server.registerTool("mid_read", { description: "m", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({
    content: [{ type: "text", text: "mid" }],
  }));
  server.registerTool("write_note", { description: "w", inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: "text", text: `wrote: ${text}` }],
  }));
  return server;
}
async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
    upstreamRequests += 1;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        const server = buildUpstream();
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

// --- a raw 2026-07-28 request, so every header is the test's choice ---

const META = {
  "io.modelcontextprotocol/protocolVersion": REVISION,
  "io.modelcontextprotocol/clientInfo": { name: "modern-test", version: "0.0.1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
let nextId = 1;
function modernBody(method: string, params: Record<string, unknown> = {}, meta: Record<string, unknown> = META) {
  return { jsonrpc: "2.0", id: nextId++, method, params: { ...params, _meta: meta } };
}
function modernHeaders(method: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": REVISION,
    "mcp-method": method,
    ...extra,
  };
}
async function modernPost(
  auth: Record<string, string>,
  method: string,
  params: Record<string, unknown> = {},
  opts: { headers?: Record<string, string>; meta?: Record<string, unknown>; serverId?: string } = {},
) {
  const headers = { ...modernHeaders(method), ...auth, ...(opts.headers ?? {}) };
  const res = await app.inject({
    method: "POST",
    url: `/mcp/${opts.serverId ?? serverId}`,
    headers,
    payload: modernBody(method, params, opts.meta ?? META),
  });
  return res;
}
const callHeaders = (name: string) => ({ "mcp-name": name });

// --- setup ---

let db: Db;
let app: ReturnType<typeof buildApp>;
let upstream: Awaited<ReturnType<typeof startUpstream>>;
let gatewayUrl = "";
let serverId = "";
let loopbackAllowHostId: string | undefined;
const restore: Array<() => Promise<void>> = [];
const createdServers: string[] = [];
const users = {} as Record<"admin" | "alice" | "bob" | "carol", { id: string; auth: { authorization: string } }>;

const auditFor = (userId: string) => db.select().from(auditLog).where(eq(auditLog.userId, userId)).orderBy(desc(auditLog.id));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restore.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  restore.push(await relaxStepUpForTest(db));
  restore.push(await relaxApprovalSigningForTest(db));
  restore.push(await relaxStrictAdmissionForTest(db));
  restore.push(
    await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, requireMcpAttribution: false }),
  );
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  upstream = await startUpstream();
  gatewayUrl = await app.listen({ port: 0, host: "127.0.0.1" });

  const allow = await relaxStepUpAround(db, () =>
    app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/egress-allow-hosts",
      payload: { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: "mcp-modern suite: local upstream double" },
    }),
  );
  expect(allow.statusCode, allow.body).toBe(201);
  loopbackAllowHostId = allow.json().id;

  for (const [k, isAdmin] of [["admin", true], ["alice", false], ["bob", false], ["carol", false]] as const) {
    const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `modern-${k}-${RUN}@example.com`, displayName: `modern ${k} ${RUN}`, isAdmin } });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "modern" } })).json().token as string;
    users[k] = { id, auth: { authorization: `Bearer ${token}` } };
  }
  const server = await app.inject({ method: "POST", headers: AUTH, url: "/v1/servers", payload: { name: `modern-upstream-${RUN}`, url: upstream.url } });
  expect(server.statusCode, server.body).toBe(201);
  serverId = server.json().id;
  createdServers.push(serverId);
}, 120_000);

afterAll(async () => {
  const loopback = await removeEgressAllowEntry(app, AUTH, { id: loopbackAllowHostId });
  try {
    setStdioPlacementAffinityForTest(null);
    for (const r of restore.reverse()) await r();
    if (createdServers.length) await db.delete(mcpServers).where(inArray(mcpServers.id, createdServers));
    app?.server.closeAllConnections();
    await app?.close();
    await upstream?.close();
  } finally {
    loopback.assertRemoved();
  }
});

describe("MCP 2026-07-28 on POST /mcp/:serverId (ADR-0311 decision 4, slice 1)", () => {
  it("server/discover answers from the gateway and never contacts the upstream", async () => {
    const before = upstreamRequests;
    const r = await modernPost(users.alice.auth, "server/discover");
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.error, r.body).toBeUndefined();
    expect(body.result.supportedVersions).toContain(REVISION);
    expect(body.result.capabilities).toMatchObject({ tools: {} });
    expect(body.result.capabilities.resources).toBeUndefined();
    expect(upstreamRequests, "a discover probe must not open an upstream").toBe(before);
  });

  it("tools/list offers only the entitled tools, sorted by name, with the private cache defaults", async () => {
    for (const toolName of ["zeta_read", "alpha_read", "mid_read"]) {
      const g = await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/tools", payload: { userId: users.alice.id, serverId, toolName } });
      expect(g.statusCode, g.body).toBe(201);
    }
    const r = await modernPost(users.alice.auth, "tools/list");
    expect(r.statusCode, r.body).toBe(200);
    const { result } = r.json();
    expect(result.tools.map((t: { name: string }) => t.name)).toEqual(["alpha_read", "mid_read", "zeta_read"]);
    expect(result).toMatchObject({ resultType: "complete", ttlMs: 0, cacheScope: "private" });

    // a caller with no grant is offered nothing (the same visibleTools filter as the 2025-era path)
    const none = await modernPost(users.bob.auth, "tools/list");
    expect(none.statusCode, none.body).toBe(200);
    expect(none.json().result.tools).toEqual([]);
  });

  it("tools/call: an ungranted call is denied by policy and audited", async () => {
    const r = await modernPost(users.bob.auth, "tools/call", { name: "alpha_read", arguments: {} }, { headers: callHeaders("alpha_read") });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().error, r.body).toMatchObject({ message: expect.stringMatching(/Denied by policy/) });
    const rows = (await auditFor(users.bob.id)).filter((e) => e.toolName === "alpha_read");
    expect(rows[0]).toMatchObject({ effect: "deny", serverId, toolName: "alpha_read" });
  });

  it("tools/call: a granted call goes through and is audited as an allow", async () => {
    const r = await modernPost(users.alice.auth, "tools/call", { name: "alpha_read", arguments: {} }, { headers: callHeaders("alpha_read") });
    expect(r.statusCode, r.body).toBe(200);
    const { result } = r.json();
    expect(result.content).toEqual([{ type: "text", text: "alpha" }]);
    expect(result.resultType).toBe("complete");
    const allow = (await auditFor(users.alice.id)).find((e) => e.effect === "allow" && e.toolName === "alpha_read" && e.objectType !== "content_provenance");
    expect(allow).toBeTruthy();
  });

  it("tools/call: a write behind an approval rule is paused and queues one pending approval", async () => {
    const g = await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/tools", payload: { userId: users.carol.id, serverId, toolName: "write_note" } });
    expect(g.statusCode, g.body).toBe(201);
    const rule = await app.inject({ method: "POST", headers: AUTH, url: "/v1/rules/approvals", payload: { userId: users.carol.id, serverId, writeOnly: true, approverUserId: users.admin.id } });
    expect(rule.statusCode, rule.body).toBe(201);
    for (let i = 0; i < 2; i++) {
      const r = await modernPost(users.carol.auth, "tools/call", { name: "write_note", arguments: { text: "hi" } }, { headers: callHeaders("write_note") });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().error?.message, r.body).toMatch(/Approval required/);
    }
    const queue = await app.inject({ method: "GET", headers: AUTH, url: "/v1/approvals?status=pending" });
    const pending = queue.json().approvals.filter((a: { userId: string }) => a.userId === users.carol.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ toolName: "write_note", status: "pending" });
  });

  it("an Mcp-Method header that disagrees with the body is -32020 (HeaderMismatch), and nothing is called", async () => {
    const before = (await auditFor(users.alice.id)).length;
    const r = await modernPost(users.alice.auth, "tools/call", { name: "alpha_read", arguments: {} }, { headers: { "mcp-method": "tools/list", ...callHeaders("alpha_read") } });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.code).toBe(-32020);
    expect((await auditFor(users.alice.id)).length, "a refused envelope reaches no governed decision").toBe(before);
  });

  it("an envelope naming a revision this gateway does not serve is -32022 (UnsupportedProtocolVersion)", async () => {
    const r = await modernPost(users.alice.auth, "tools/list", {}, {
      meta: { ...META, "io.modelcontextprotocol/protocolVersion": "2099-01-01" },
      headers: { "mcp-protocol-version": "2099-01-01" },
    });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.code).toBe(-32022);
    expect(r.json().error.data?.supported).toContain(REVISION);
  });

  it("subscriptions/listen is refused in band with -32601 and audited", async () => {
    const r = await modernPost(users.alice.auth, "subscriptions/listen", { notifications: {} });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().error.code).toBe(-32601);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, users.alice.id), eq(auditLog.ruleId, "mcp-method-unsupported")))
      .orderBy(desc(auditLog.id));
    expect(row).toMatchObject({ effect: "deny", serverId });
    expect(row!.detail).toMatchObject({ method: "subscriptions/listen", protocolRevision: REVISION });
  });

  it("a method outside every vocabulary is -32601 with an audit row", async () => {
    const r = await modernPost(users.alice.auth, "regulait/unknown");
    expect(r.json().error?.code, r.body).toBe(-32601);
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, users.alice.id), eq(auditLog.ruleId, "mcp-method-unsupported")));
    expect(rows.some((e) => (e.detail as { method?: string }).method === "regulait/unknown")).toBe(true);
  });

  it("the pre-hijack refusals still run first: no API key is 401 and an unknown server is 404", async () => {
    const anon = await app.inject({ method: "POST", url: `/mcp/${serverId}`, headers: modernHeaders("server/discover"), payload: modernBody("server/discover") });
    expect(anon.statusCode).toBe(401);
    const unknown = await modernPost(users.alice.auth, "server/discover", {}, { serverId: randomUUID() });
    expect(unknown.statusCode).toBe(404);
  });

  it("the official v2 client, pinned to 2026-07-28, discovers, lists and calls through the gateway", async () => {
    const client = new ModernClient({ name: "modern-sdk-test", version: "0.0.1" }, { versionNegotiation: { mode: { pin: REVISION } } });
    const transport = new ModernClientTransport(new URL(`${gatewayUrl}/mcp/${serverId}`), {
      requestInit: { headers: users.alice.auth },
    });
    await client.connect(transport);
    expect(client.getNegotiatedProtocolVersion()).toBe(REVISION);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["alpha_read", "mid_read", "zeta_read"]);
    const out = await client.callTool({ name: "mid_read", arguments: {} });
    expect(out.content).toEqual([{ type: "text", text: "mid" }]);
    await client.close();
  });

  it("a 2025-era client (initialize handshake) is served by the unchanged v1 path", async () => {
    const client = new LegacyClient({ name: "legacy-test", version: "0.0.1" });
    const transport = new LegacyClientTransport(new URL(`${gatewayUrl}/mcp/${serverId}`), { requestInit: { headers: users.alice.auth } });
    await client.connect(transport);
    // the v1 path keeps the upstream's order (no sort was added to it)
    const { tools } = await client.listTools();
    expect(new Set(tools.map((t) => t.name))).toEqual(new Set(["alpha_read", "mid_read", "zeta_read"]));
    const out = await client.callTool({ name: "zeta_read", arguments: {} });
    expect(out.content).toEqual([{ type: "text", text: "zeta" }]);
    await client.close();
  });
});

describe("MCP 2026-07-28 tools/list on a stdio server (B3S-01 stored manifest)", () => {
  let stdioId = "";
  beforeAll(async () => {
    const t = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: users.admin.auth, payload: { mcpUpstreamTransports: ["streamable_http", "stdio"] } });
    expect(t.statusCode, t.body).toBe(200);
    restore.push(async () => {
      await db.execute(sql`UPDATE org_settings SET mcp_upstream_transports = '["streamable_http"]'::jsonb`);
    });
    // no executor may take this file's placements (every file shares one database)
    setStdioPlacementAffinityForTest([randomUUID()]);
    const r = await app.inject({
      method: "POST",
      url: "/v1/servers",
      headers: users.admin.auth,
      payload: { name: `modern-stdio-${RUN}`, transport: "stdio", stdio: { image: STDIO_IMAGE, command: "/srv/mcp/modern.js", args: [] } },
    });
    expect(r.statusCode, r.body).toBe(201);
    stdioId = r.json().id;
    createdServers.push(stdioId);
    await db.insert(mcpTools).values([
      { serverId: stdioId, name: "stdio_zulu", kind: "read", description: "z", inputSchema: { type: "object" } },
      { serverId: stdioId, name: "stdio_alpha", kind: "read", description: "a", inputSchema: { type: "object" } },
    ]);
  });

  it("an ungranted caller is refused before anything starts (403 mcp_no_entitlement, audited)", async () => {
    const r = await modernPost(users.bob.auth, "tools/list", {}, { serverId: stdioId });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error).toBe("mcp_no_entitlement");
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, users.bob.id), eq(auditLog.ruleId, MCP_STDIO_NO_ENTITLEMENT_RULE_ID)));
    expect(row).toMatchObject({ effect: "deny", serverId: stdioId });
  });

  it("an entitled caller is served the stored manifest, sorted, with no process placed", async () => {
    const g = await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/servers", payload: { userId: users.alice.id, serverId: stdioId, readOnlyAll: true } });
    expect(g.statusCode, g.body).toBe(201);
    const r = await modernPost(users.alice.auth, "tools/list", {}, { serverId: stdioId });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result.tools.map((t: { name: string }) => t.name)).toEqual(["stdio_alpha", "stdio_zulu"]);
    const placed = await db.execute(
      sql`select count(*)::int as n from audit_log where rule_id in ('execution-refused', 'execution-placed') and detail->>'mcpServerId' = ${stdioId}`,
    );
    expect((placed as unknown as { rows: Array<{ n: number }> }).rows[0]!.n).toBe(0);
  });
});

// --- slice 2: the governed non-tool methods (ADR-0185 G3) on the 2026-07-28 path ---

/** the JSON-RPC messages of an answer: one JSON body, or the `data:` frames of an SSE stream */
function messagesOf(res: { headers: Record<string, unknown>; body: string }): Array<Record<string, any>> {
  if (String(res.headers["content-type"] ?? "").includes("text/event-stream")) {
    return res.body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)));
  }
  return [JSON.parse(res.body)];
}
const answerOf = (res: { headers: Record<string, unknown>; body: string }) => messagesOf(res).find((m) => "id" in m && ("result" in m || "error" in m))!;

describe("MCP 2026-07-28 governed resources, prompts and completion (ADR-0311 decision 4, slice 2)", () => {
  let priorMethods: string[] = [];
  const setMethods = async (methods: readonly string[]) => {
    await db.update(orgSettings).set({ mcpProtocolMethods: [...methods] as never }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  };
  let seq = 0;
  async function newUser(): Promise<{ id: string; auth: { authorization: string } }> {
    const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `modern-s2-${RUN}-${seq++}@example.com`, displayName: `modern s2 ${RUN}` } });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "modern-s2" } })).json().token as string;
    return { id, auth: { authorization: `Bearer ${token}` } };
  }
  async function grant(userId: string, toolName: string) {
    const g = await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/tools", payload: { userId, serverId, toolName } });
    expect(g.statusCode, g.body).toBe(201);
    return g.json().id as string;
  }
  /** the upstream HTTP requests `fn` cost */
  async function upstreamCost(fn: () => Promise<unknown>): Promise<number> {
    const before = upstreamRequests;
    await fn();
    return upstreamRequests - before;
  }

  beforeAll(async () => {
    const [org] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    priorMethods = (org?.mcpProtocolMethods ?? []) as string[];
    // M-068: the org's enabled methods are global state; put back after this block
    restore.push(async () => setMethods(priorMethods));
  });

  it("server/discover advertises exactly the enabled capabilities (never logging) and still contacts no upstream", async () => {
    await setMethods(MCP_PROTOCOL_METHODS);
    let body: Record<string, any> = {};
    const cost = await upstreamCost(async () => {
      const r = await modernPost(users.alice.auth, "server/discover");
      expect(r.statusCode, r.body).toBe(200);
      body = r.json();
    });
    expect(cost, "a discover probe must not open an upstream").toBe(0);
    expect(body.result.capabilities).toMatchObject({ tools: {}, resources: {}, prompts: {}, completions: {} });
    expect(body.result.capabilities.logging, "logging/setLevel does not exist in 2026-07-28").toBeUndefined();

    await setMethods(["prompts/list"]);
    const only = (await modernPost(users.alice.auth, "server/discover")).json();
    expect(Object.keys(only.result.capabilities).sort()).toEqual(["prompts", "tools"]);
  });

  it("a method the org has not enabled is denied by policy and audited (mcp-method-disabled), zero upstream", async () => {
    await setMethods([]);
    const u = await newUser();
    await grant(u.id, "mcp:resources");
    let r!: Awaited<ReturnType<typeof modernPost>>;
    expect(await upstreamCost(async () => (r = await modernPost(u.auth, "resources/list")))).toBe(0);
    expect(r.json().error?.message, r.body).toMatch(/Denied by policy: .*not enabled/);
    const rows = await auditFor(u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ effect: "deny", ruleId: "mcp-method-disabled", toolName: "mcp:resources" });
    expect(rows[0]!.detail).toMatchObject({ phase: "protocol", method: "resources/list" });
  });

  it("resources/list: an entitled caller is served (2026 cache fields), an unentitled one is denied and audited", async () => {
    await setMethods(MCP_PROTOCOL_METHODS);
    const u = await newUser();
    const grantId = await grant(u.id, "mcp:resources");
    const r = await modernPost(u.auth, "resources/list");
    expect(r.statusCode, r.body).toBe(200);
    const { result } = r.json();
    expect(result.resources.map((x: { uri: string }) => x.uri).sort()).toEqual(["file:///private/secret.md", "file:///public/readme.md"]);
    expect(result).toMatchObject({ resultType: "complete", ttlMs: 0, cacheScope: "private" });
    const allow = (await auditFor(u.id)).find((e) => e.effect === "allow" && e.objectType !== "content_provenance");
    expect(allow).toMatchObject({ toolName: "mcp:resources", ruleId: grantId });
    expect(allow!.detail).toMatchObject({ method: "resources/list" });

    const nobody = await newUser();
    let denied!: Awaited<ReturnType<typeof modernPost>>;
    expect(await upstreamCost(async () => (denied = await modernPost(nobody.auth, "resources/list")))).toBe(0);
    expect(denied.json().error?.message, denied.body).toMatch(/Denied by policy: no grant matches/);
    const [deny] = await auditFor(nobody.id);
    expect(deny).toMatchObject({ effect: "deny", ruleId: "default-deny", toolName: "mcp:resources" });
  });

  it("resources/read is decided on `uri`: a data-scope rule is an exact allow-list, a deny costs the upstream nothing", async () => {
    await setMethods(MCP_PROTOCOL_METHODS);
    const u = await newUser();
    await grant(u.id, "mcp:resources");
    const rule = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/rules/data-scopes",
      payload: { userId: u.id, serverId, toolName: "mcp:resources", argPath: "uri", allowedValues: ["file:///public/readme.md"] },
    });
    expect(rule.statusCode, rule.body).toBe(201);
    const ok = await modernPost(u.auth, "resources/read", { uri: "file:///public/readme.md" }, { headers: { "mcp-name": "file:///public/readme.md" } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(answerOf(ok).result).toMatchObject({ contents: [{ uri: "file:///public/readme.md", text: "# public readme" }], resultType: "complete" });
    for (const uri of ["file:///private/secret.md", "FILE:///public/readme.md"]) {
      let r!: Awaited<ReturnType<typeof modernPost>>;
      expect(await upstreamCost(async () => (r = await modernPost(u.auth, "resources/read", { uri }, { headers: { "mcp-name": uri } })))).toBe(0);
      expect(r.json().error?.message, r.body).toMatch(/Denied by policy/);
    }
  });

  it("resources/read of a resource the upstream does not have answers -32602 on 2026-07-28", async () => {
    await setMethods(MCP_PROTOCOL_METHODS);
    const u = await newUser();
    await grant(u.id, "mcp:resources");
    const uri = "file:///public/missing.md";
    const r = await modernPost(u.auth, "resources/read", { uri }, { headers: { "mcp-name": uri } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().error?.code, r.body).toBe(-32602);
  });

  it("prompts/list, prompts/get and completion/complete are governed by their own grants", async () => {
    await setMethods(MCP_PROTOCOL_METHODS);
    const u = await newUser();
    // no grant yet: each is denied and audited
    expect((await modernPost(u.auth, "prompts/list")).json().error?.message).toMatch(/Denied by policy/);
    const promptArgs = { name: "greet", arguments: { who: "world" } };
    expect((await modernPost(u.auth, "prompts/get", promptArgs, { headers: { "mcp-name": "greet" } })).json().error?.message).toMatch(/Denied by policy/);
    const completeArgs = { ref: { type: "ref/prompt", name: "greet" }, argument: { name: "who", value: "w" } };
    expect((await modernPost(u.auth, "completion/complete", completeArgs)).json().error?.message).toMatch(/Denied by policy/);
    const denies = (await auditFor(u.id)).filter((e) => e.effect === "deny");
    expect(denies.map((e) => e.toolName).sort()).toEqual(["mcp:completion", "mcp:prompts", "mcp:prompts"]);

    await grant(u.id, "mcp:prompts");
    await grant(u.id, "mcp:completion");
    const list = await modernPost(u.auth, "prompts/list");
    expect(list.json().result, list.body).toMatchObject({ prompts: [{ name: "greet" }], resultType: "complete", ttlMs: 0, cacheScope: "private" });
    const got = await modernPost(u.auth, "prompts/get", promptArgs, { headers: { "mcp-name": "greet" } });
    expect(got.json().result?.messages, got.body).toEqual([{ role: "user", content: { type: "text", text: "Say hello to world" } }]);
    const done = await modernPost(u.auth, "completion/complete", completeArgs);
    expect(done.json().result?.completion?.values, done.body).toEqual(["world"]);
    const allows = (await auditFor(u.id)).filter((e) => e.effect === "allow" && e.objectType !== "content_provenance");
    expect(allows.map((e) => (e.detail as { method: string }).method).sort()).toEqual(["completion/complete", "prompts/get", "prompts/list"]);
  });

  it("logging/setLevel and ping do not exist in 2026-07-28: -32601, audited, nothing decided, zero upstream", async () => {
    await setMethods(MCP_PROTOCOL_METHODS);
    const u = await newUser();
    await grant(u.id, "mcp:logging");
    for (const [method, params] of [["logging/setLevel", { level: "debug" }], ["ping", {}]] as const) {
      let r!: Awaited<ReturnType<typeof modernPost>>;
      expect(await upstreamCost(async () => (r = await modernPost(u.auth, method, params)))).toBe(0);
      expect(r.json().error?.code, r.body).toBe(-32601);
    }
    const rows = await auditFor(u.id);
    expect(rows.map((e) => e.ruleId)).toEqual(["mcp-method-unsupported", "mcp-method-unsupported"]);
    expect(rows.map((e) => (e.detail as { method: string }).method).sort()).toEqual(["logging/setLevel", "ping"]);
    expect(rows.every((e) => e.effect === "deny" && (e.detail as { protocolRevision: string }).protocolRevision === REVISION)).toBe(true);
  });

  it("the always-refused methods stay refused and audited (mcp-method-unsupported), zero upstream", async () => {
    await setMethods(MCP_PROTOCOL_METHODS);
    const u = await newUser();
    await grant(u.id, "mcp:resources");
    let r!: Awaited<ReturnType<typeof modernPost>>;
    expect(await upstreamCost(async () => (r = await modernPost(u.auth, "resources/subscribe", { uri: "file:///public/readme.md" })))).toBe(0);
    // removed from 2026-07-28 (subscriptions/listen replaces it), so the SDK answers -32601 before any handler runs
    expect(r.json().error?.code, r.body).toBe(-32601);
    const rows = await auditFor(u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ effect: "deny", ruleId: "mcp-method-unsupported" });
    expect(rows[0]!.detail).toMatchObject({ method: "resources/subscribe", answeredBy: "sdk" });

    // a client-bound method sent to the server: refused by name and audited, whatever the org enables
    let s!: Awaited<ReturnType<typeof modernPost>>;
    expect(await upstreamCost(async () => (s = await modernPost(u.auth, "sampling/createMessage", { messages: [], maxTokens: 1 })))).toBe(0);
    expect(s.json().error?.code, s.body).toBe(-32601);
    const sampling = (await auditFor(u.id)).filter((e) => (e.detail as { method?: string }).method === "sampling/createMessage");
    expect(sampling).toHaveLength(1);
    expect(sampling[0]).toMatchObject({ effect: "deny", ruleId: "mcp-method-unsupported" });

    // a name under an always-refused prefix that is no spec method reaches the shared primitive: refused by name,
    // audited, as on the 2025-era path ("Denied by policy", -32600)
    const odd = await modernPost(u.auth, "roots/regulait-probe");
    expect(odd.json().error, odd.body).toMatchObject({ code: -32600, message: expect.stringMatching(/Denied by policy: .*always refused/) });
    const roots = (await auditFor(u.id)).filter((e) => (e.detail as { method?: string }).method === "roots/regulait-probe");
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ effect: "deny", ruleId: "mcp-method-unsupported" });
  });

  it("progress is relayed on the request's own response stream; upstream log lines never are", async () => {
    const u = await newUser();
    await grant(u.id, "mcp:resources");
    await grant(u.id, "mcp:logging");
    const uri = "file:///public/readme.md";
    const read = () => modernPost(u.auth, "resources/read", { uri }, { headers: { "mcp-name": uri }, meta: { ...META, progressToken: "p-1" } });

    // the 2025-era rule: progress is relayed only when the org enables logging/setLevel
    await setMethods(["resources/read"]);
    const quiet = await read();
    expect(messagesOf(quiet).filter((m) => !("id" in m))).toEqual([]);
    expect(answerOf(quiet).result?.contents?.[0]?.text, quiet.body).toBe("# public readme");

    await setMethods(["resources/read", "logging/setLevel"]);
    const loud = await read();
    const notes = messagesOf(loud).filter((m) => !("id" in m));
    expect(notes, loud.body).toEqual([{ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "p-1", progress: 1, total: 2 } }]);
    expect(answerOf(loud).result?.contents?.[0]?.text, loud.body).toBe("# public readme");
    // no log relay was decided at all on this path (the 2025-era path writes a protocol-relay row)
    const relayRows = (await auditFor(u.id)).filter((e) => (e.detail as { phase?: string }).phase === "protocol-relay");
    expect(relayRows).toEqual([]);
  });

  it("the official v2 client lists and reads resources, gets a prompt and completes through the gateway", async () => {
    await setMethods(MCP_PROTOCOL_METHODS);
    const u = await newUser();
    for (const g of ["mcp:resources", "mcp:prompts", "mcp:completion"]) await grant(u.id, g);
    const client = new ModernClient({ name: "modern-sdk-s2", version: "0.0.1" }, { versionNegotiation: { mode: { pin: REVISION } } });
    await client.connect(new ModernClientTransport(new URL(`${gatewayUrl}/mcp/${serverId}`), { requestInit: { headers: u.auth } }));
    expect(client.getServerCapabilities()).toMatchObject({ resources: {}, prompts: {}, completions: {} });
    const { resources } = await client.listResources();
    expect(resources.map((x) => x.uri).sort()).toEqual(["file:///private/secret.md", "file:///public/readme.md"]);
    const read = await client.readResource({ uri: "file:///public/readme.md" });
    expect(read.contents).toEqual([{ uri: "file:///public/readme.md", text: "# public readme" }]);
    const prompt = await client.getPrompt({ name: "greet", arguments: { who: "team" } });
    expect(prompt.messages[0]?.content).toEqual({ type: "text", text: "Say hello to team" });
    const done = await client.complete({ ref: { type: "ref/prompt", name: "greet" }, argument: { name: "who", value: "t" } });
    expect(done.completion.values).toEqual(["team"]);
    await client.close();
  });
});
