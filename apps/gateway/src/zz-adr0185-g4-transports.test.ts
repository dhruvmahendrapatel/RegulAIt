/**
 * ADR-0185 G4 — stdio and SSE upstream transports, pinned on a real database
 * through the real app and the real SDK transports:
 *
 *  - SSE is governed EXACTLY like Streamable HTTP: an allowed call reaches the
 *    upstream, a denied one makes ZERO upstream contact; every request goes
 *    through the guarded fetch; a cross-origin `endpoint` event is refused
 *    (audited) and the other origin is never hit;
 *  - stdio (re-targeted by ADR-0190 I4: it runs only in a sandbox an executor
 *    starts, never on the gateway host; the sandboxed path is pinned in
 *    `zz-adr0190-i4-stdio-move.test.ts`): the org's transport list at
 *    registration and at connect; PATCH keeps the transport immutable,
 *    rewrites the sentinel url on rename, and a changed image or argv resets
 *    admission to `unscanned` (audited with transitions);
 *  - the health probe never selects a stdio server.
 *
 * Global state (M-068): the org transports and the private-range/cooldown
 * relaxations are restored in `afterAll`; every server row is deleted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  and,
  auditLog,
  createDb,
  desc,
  eq,
  inArray,
  mcpServers,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import {
  checkUpstreamDestination,
  guardedMcpConnect,
  McpEgressBlockedError,
  McpUpstreamRefusedError,
} from "./mcp-egress.js";
import { originPinnedFetch, SseCrossOriginError } from "./mcp-transports.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";
import { healthProbeEligibility } from "./mcp-health-probe.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `g4-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
const users = {} as Record<"admin" | "member" | "stranger", { id: string; auth: { authorization: string } }>;
const createdServers: string[] = [];
const restore: Array<() => Promise<void>> = [];

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

const IMAGE = `sha256:${"9".repeat(64)}`;
const IMAGE2 = `sha256:${"8".repeat(64)}`;
const COMMAND = "/srv/mcp/g4.js";

async function setTransports(t: string[]) {
  const r = await inject("PUT", "/v1/org/settings", users.admin.auth, { mcpUpstreamTransports: t });
  expect(r.statusCode, r.body).toBe(200);
}

async function registerStdio(name: string, args: string[], image = IMAGE) {
  const r = await inject("POST", "/v1/servers", users.admin.auth, { name, transport: "stdio", stdio: { image, command: COMMAND, args } });
  if (r.statusCode === 201) createdServers.push(r.json().id);
  return r;
}

async function lastDeny(serverId: string) {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.objectId, serverId), eq(auditLog.effect, "deny")))
    .orderBy(desc(auditLog.seq))
    .limit(1);
  return row;
}

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

async function addTool(serverId: string, name: string, grantTo: string) {
  const t = await inject("POST", `/v1/servers/${serverId}/tools`, AUTH, { name, kind: "read", description: name });
  expect(t.statusCode, t.body).toBeLessThan(300);
  const g = await inject("POST", "/v1/grants/tools", AUTH, { userId: grantTo, serverId, toolName: name, mode: "readwrite" });
  expect(g.statusCode, g.body).toBeLessThan(300);
}

const callTool = (userId: string, serverId: string, toolName: string) =>
  executeGovernedToolCall(db, undefined, { userId, serverId, toolName, projectId: null, arguments: {} });

const textOf = (outcome: unknown) =>
  JSON.parse(((outcome as { content: { content: Array<{ text: string }> } }).content.content[0]!.text) as string);

// ---------------------------------------------------------------------------
// SSE upstream doubles
// ---------------------------------------------------------------------------

interface SseUpstream {
  url: string;
  hits: () => number;
  close: () => Promise<void>;
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  return addr.port;
}
const closer = (server: http.Server) => () =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

/** a real SDK SSE server with one read tool */
async function startSseUpstream(): Promise<SseUpstream> {
  let hits = 0;
  const sessions = new Map<string, SSEServerTransport>();
  const server = http.createServer((req, res) => {
    hits += 1;
    const u = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && u.pathname === "/sse") {
      const mcp = new McpServer({ name: `g4-sse-${RUN}`, version: "0.0.1" });
      mcp.registerTool(
        "sse_read",
        { description: "read", inputSchema: {}, annotations: { readOnlyHint: true } },
        async () => ({ content: [{ type: "text", text: JSON.stringify({ via: "sse" }) }] }),
      );
      const t = new SSEServerTransport("/messages", res);
      sessions.set(t.sessionId, t);
      void mcp.connect(t);
      return;
    }
    if (req.method === "POST" && u.pathname === "/messages") {
      const t = sessions.get(u.searchParams.get("sessionId") ?? "");
      if (!t) return void res.writeHead(404).end();
      void t.handlePostMessage(req, res);
      return;
    }
    res.writeHead(404).end();
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}/sse`, hits: () => hits, close: closer(server) };
}

/** an SSE server whose `endpoint` event names ANOTHER origin */
async function startHostileSse(target: string): Promise<SseUpstream> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`event: endpoint\ndata: ${target}\n\n`);
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}/sse`, hits: () => hits, close: closer(server) };
}

/** a plain counter: proves the other origin is never contacted */
async function startCounter(): Promise<SseUpstream> {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits += 1;
    res.writeHead(202).end();
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}/messages`, hits: () => hits, close: closer(server) };
}

// ---------------------------------------------------------------------------

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
// ADR-0186 A: this suite drives step-up actions through API keys, which can never step up (restored below, M-068)
let restoreStepUp: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  restoreStepUp = await relaxStepUpForTest(db);
  // the doubles listen on 127.0.0.1 and were registered seconds ago;
  // admission stays `enforce` (the reserved-name proof needs it)
  restore.push(await relaxStrictAdmissionForTest(db));
  restore.push(await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  for (const [k, isAdmin] of [["admin", true], ["member", false], ["stranger", false]] as const) {
    const u = await inject("POST", "/v1/users", AUTH, { email: `g4-${k}-${RUN}@example.com`, displayName: `g4 ${k} ${RUN}`, isAdmin });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "g4" })).json().token as string;
    users[k] = { id, auth: { authorization: `Bearer ${token}` } };
  }
}, 120_000);

afterAll(async () => {
  await restoreStepUp?.();
  await db.execute(sql`UPDATE org_settings SET mcp_upstream_transports = '["streamable_http"]'::jsonb`);
  for (const r of restore.reverse()) await r();
  await restoreAdminKeyMfa?.();
  if (createdServers.length) await db.delete(mcpServers).where(inArray(mcpServers.id, createdServers));
  app.server.closeAllConnections();
  await app.close();
});

// ---------------------------------------------------------------------------

describe("G4 stdio: the org's transport list (ADR-0190 I4: there is no host opt-in any more)", () => {
  it("needs the org to enable stdio (and SSE): 422 mcp_transport_disabled at registration, refused at connect", async () => {
    await setTransports(["streamable_http"]);
    const r = await registerStdio(`g4-orgoff-${RUN}`, []);
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().error).toBe("mcp_transport_disabled");
    const sse = await inject("POST", "/v1/servers", users.admin.auth, {
      name: `g4-sse-off-${RUN}`,
      url: "http://127.0.0.1:9/sse",
      transport: "sse",
      allowPrivateRanges: true,
    });
    expect(sse.statusCode, sse.body).toBe(422);
    expect(sse.json().error).toBe("mcp_transport_disabled");
    const audited = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "mcp-transport-disabled"), eq(auditLog.userId, users.admin.id)));
    expect(audited.length, "write-time refusals are audited").toBeGreaterThanOrEqual(2);

    // registered while enabled, then the admin takes stdio away: connect refused before any placement
    await setTransports(["streamable_http", "stdio"]);
    const ok = await registerStdio(`g4-orgoff2-${RUN}`, []);
    expect(ok.statusCode, ok.body).toBe(201);
    await setTransports(["streamable_http"]);
    const err = await errorOf(checkUpstreamDestination(db, ok.json()));
    expect((err as McpUpstreamRefusedError).error).toBe("mcp_transport_disabled");
    expect((await lastDeny(ok.json().id))?.ruleId).toBe("mcp-transport-disabled");
    await setTransports(["streamable_http", "stdio"]);
  });

  it("the registration is the image, the entry point and the argv; registration places nothing; the view shows the image", async () => {
    const r = await registerStdio(`g4-fs-${RUN}`, ["--flag"]);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ transport: "stdio", url: `stdio:g4-fs-${RUN}`, stdio: { image: IMAGE, command: COMMAND, args: ["--flag"] }, admissionState: "unscanned" });
    const list = await inject("GET", "/v1/servers", users.admin.auth);
    const row = (list.json().servers as Array<{ id: string; stdio: unknown }>).find((s) => s.id === r.json().id);
    expect(row?.stdio).toEqual({ image: IMAGE, command: COMMAND, args: ["--flag"] });
    const [reg] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, r.json().id), eq(auditLog.ruleId, "mcp-stdio-server-registered")));
    expect(reg, "a stdio registration is audited").toBeDefined();
    // argv past its bounds, a relative entry point and an unpinned image are refused, nothing saved
    for (const [stdio, error, code] of [
      [{ image: IMAGE, command: "rel/x", args: [] }, "mcp_stdio_command_refused", "not_absolute"],
      [{ image: IMAGE, command: COMMAND, args: Array.from({ length: 65 }, () => "x") }, "mcp_stdio_command_refused", "invalid_argv"],
      [{ image: IMAGE, command: COMMAND, args: ["a\u0000b"] }, "mcp_stdio_command_refused", "invalid_argv"],
      [{ image: "node:22", command: COMMAND, args: [] }, "mcp_stdio_image_unpinned", "image_unpinned"],
    ] as const) {
      const bad = await inject("POST", "/v1/servers", users.admin.auth, { name: `g4-bad-${RUN}-${code}`, transport: "stdio", stdio });
      expect(bad.statusCode, bad.body).toBe(400);
      expect(bad.json()).toMatchObject({ error, code });
    }
  });
});

describe("G4 stdio: PATCH", () => {
  it("a transport never changes; a stdio server has no url; rename rewrites the sentinel; a new argv resets admission", async () => {
    const r = await registerStdio(`g4-patch-${RUN}`, ["--a"]);
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id as string;
    for (const body of [{ transport: "sse" }, { url: "http://127.0.0.1:9/x" }, { allowPrivateRanges: true }]) {
      const p = await inject("PATCH", `/v1/servers/${id}`, users.admin.auth, body);
      expect(p.statusCode, p.body).toBe(409);
      expect(p.json().error).toBe("mcp_transport_immutable");
    }
    const renamed = await inject("PATCH", `/v1/servers/${id}`, users.admin.auth, { name: `g4-patch2-${RUN}` });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().url).toBe(`stdio:g4-patch2-${RUN}`);

    // a bad new command is refused with the same codes, nothing saved
    const bad = await inject("PATCH", `/v1/servers/${id}`, users.admin.auth, { stdio: { image: IMAGE, command: "rel/x", args: [] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "mcp_stdio_command_refused", code: "not_absolute" });

    await db.update(mcpServers).set({ admissionState: "clean" }).where(eq(mcpServers.id, id));
    const same = await inject("PATCH", `/v1/servers/${id}`, users.admin.auth, { stdio: { image: IMAGE, command: COMMAND, args: ["--a"] } });
    expect(same.json().admissionState, "restating the same program changes nothing").toBe("clean");
    // a different image is a different program: admission resets, audited with its transitions
    const changed = await inject("PATCH", `/v1/servers/${id}`, users.admin.auth, { stdio: { image: IMAGE2, command: COMMAND, args: ["--b"] } });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({ admissionState: "unscanned", stdioCommandDigest: IMAGE2, stdio: { image: IMAGE2, command: COMMAND, args: ["--b"] } });
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, id), eq(auditLog.ruleId, "mcp-stdio-command-changed")))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    expect((audit?.detail as { transitions: Record<string, unknown> }).transitions).toMatchObject({
      args: { from: ["--a"], to: ["--b"] },
      digest: { from: IMAGE, to: IMAGE2 },
      admissionState: { from: "clean", to: "unscanned" },
    });
  });

  it("the health probe never selects a stdio server", async () => {
    const stdioIds = (
      await db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.transport, "stdio"))
    ).map((r) => r.id);
    expect(stdioIds.length).toBeGreaterThan(0);
    const eligible = await db
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(and(healthProbeEligibility(), inArray(mcpServers.id, stdioIds)));
    expect(eligible).toEqual([]);
  });
});

describe("G4 SSE", () => {
  let up: SseUpstream;
  let serverId = "";
  beforeAll(async () => {
    up = await startSseUpstream();
  });
  afterAll(async () => {
    await up?.close();
  });

  it("registers only when the org enables SSE, through the same write-time egress check", async () => {
    await setTransports(["streamable_http", "sse"]);
    const r = await inject("POST", "/v1/servers", users.admin.auth, {
      name: `g4-sse-${RUN}`,
      url: up.url,
      transport: "sse",
      allowPrivateRanges: true,
    });
    expect(r.statusCode, r.body).toBe(201);
    createdServers.push(r.json().id);
    serverId = r.json().id;
    expect(r.json()).toMatchObject({ transport: "sse", stdio: null });
    const imds = await inject("POST", "/v1/servers", users.admin.auth, {
      name: `g4-sse-imds-${RUN}`,
      url: "http://169.254.169.254/sse",
      transport: "sse",
      allowPrivateRanges: true,
    });
    expect(imds.statusCode, imds.body).toBe(400);
    expect(imds.json().error).toBe("egress_blocked");
  });

  it("an allowed call reaches the upstream over SSE; a denied call makes zero requests", async () => {
    await addTool(serverId, "sse_read", users.member.id);
    const ok = await callTool(users.member.id, serverId, "sse_read");
    expect(ok.kind, JSON.stringify(ok)).toBe("allowed");
    expect(textOf(ok)).toEqual({ via: "sse" });
    const hits = up.hits();
    const denied = await callTool(users.stranger.id, serverId, "sse_read");
    expect(denied.kind).toBe("denied");
    expect(up.hits(), "a denied call must not contact the SSE upstream").toBe(hits);
  });

  it("every request (the event stream and each message POST) goes through the guarded fetch", async () => {
    const seen: string[] = [];
    const client = await guardedMcpConnect(
      db,
      { id: serverId, url: up.url, allowPrivateRanges: true },
      {
        fetchImpl: (async (u: string | URL | Request, init?: RequestInit) => {
          seen.push(`${init?.method ?? "GET"} ${new URL(String(u)).pathname}`);
          return fetch(u, init);
        }) as typeof fetch,
      },
    );
    await client.listTools();
    await client.close();
    expect(seen[0]).toBe("GET /sse");
    expect(seen.filter((s) => s === "POST /messages").length).toBeGreaterThanOrEqual(2);
  });

  it("an SSE upstream whose name resolves somewhere the guard refuses is never contacted", async () => {
    // a hostname (not an IP literal), so the guard's resolver decides: it
    // answers with the instance-metadata address, refused unconditionally
    // whatever the private-range posture or allow-list says
    const hits = up.hits();
    const port = new URL(up.url).port;
    const fetched: string[] = [];
    const err = await errorOf(
      guardedMcpConnect(
        db,
        { id: serverId, url: `http://g4-sse-${RUN}.example:${port}/sse`, allowPrivateRanges: true, transport: "sse" },
        {
          resolve: async () => [{ address: "169.254.169.254", family: 4 }],
          fetchImpl: (async (u: string | URL | Request) => {
            fetched.push(String(u));
            return new Response(null, { status: 500 });
          }) as typeof fetch,
        },
      ),
    );
    expect(err).toBeInstanceOf(McpEgressBlockedError);
    expect((err as McpEgressBlockedError).error).toBe("egress_blocked");
    expect(fetched).toEqual([]);
    expect(up.hits()).toBe(hits);
  });

  it("an endpoint event naming another origin is refused, audited, and the other origin is never hit", async () => {
    const other = await startCounter();
    const hostile = await startHostileSse(other.url);
    try {
      const r = await inject("POST", "/v1/servers", users.admin.auth, {
        name: `g4-sse-hostile-${RUN}`,
        url: hostile.url,
        transport: "sse",
        allowPrivateRanges: true,
      });
      expect(r.statusCode, r.body).toBe(201);
      createdServers.push(r.json().id);
      const err = await errorOf(guardedMcpConnect(db, r.json()));
      expect(err).toBeInstanceOf(McpUpstreamRefusedError);
      expect((err as McpUpstreamRefusedError).error).toBe("mcp_sse_endpoint_refused");
      expect((await lastDeny(r.json().id))?.ruleId).toBe("mcp-sse-endpoint-refused");
      expect(hostile.hits()).toBeGreaterThan(0);
      expect(other.hits(), "the cross-origin endpoint was never contacted").toBe(0);
    } finally {
      await hostile.close();
      await other.close();
    }
  });

  it("the origin pin refuses a cross-origin request before the inner fetch runs", async () => {
    let inner = 0;
    const pinned = originPinnedFetch("http://127.0.0.1:1234", (async () => {
      inner += 1;
      return new Response(null);
    }) as typeof fetch);
    await expect(pinned("http://127.0.0.1:4321/messages")).rejects.toBeInstanceOf(SseCrossOriginError);
    await expect(pinned("https://127.0.0.1:1234/messages")).rejects.toBeInstanceOf(SseCrossOriginError);
    expect(inner).toBe(0);
    await pinned("http://127.0.0.1:1234/messages");
    expect(inner).toBe(1);
  });
});

describe("PR #181 review: every registration and every direct tool grant is on the trail", () => {
  it("a streamable HTTP registration is audited like a stdio one, with its url and owner", async () => {
    const r = await inject("POST", "/v1/servers", users.admin.auth, {
      name: `g4-http-audit-${RUN}`,
      url: "http://127.0.0.1:9/mcp",
      allowPrivateRanges: true,
    });
    expect(r.statusCode, r.body).toBe(201);
    const serverId = r.json().id as string;
    createdServers.push(serverId);
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, serverId), eq(auditLog.ruleId, "mcp-server-registered")));
    expect(rows, "a streamable_http registration is audited").toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: users.admin.id,
      objectType: "mcp_server",
      serverId,
      effect: "allow",
      detail: expect.objectContaining({ phase: "registration", transport: "streamable_http", url: "http://127.0.0.1:9/mcp", allowPrivateRanges: true }),
    });
  });

  it("a successful POST /v1/grants/tools names the actor, the grantee, the server and the grant", async () => {
    const r = await inject("POST", "/v1/servers", users.admin.auth, {
      name: `g4-grant-audit-${RUN}`,
      url: "http://127.0.0.1:9/mcp",
      allowPrivateRanges: true,
    });
    expect(r.statusCode, r.body).toBe(201);
    const serverId = r.json().id as string;
    createdServers.push(serverId);
    const g = await inject("POST", "/v1/grants/tools", users.admin.auth, { userId: users.member.id, serverId, toolName: "mcp:resources" });
    expect(g.statusCode, g.body).toBe(201);
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.serverId, serverId), eq(auditLog.ruleId, "mcp-tool-grant-created")));
    expect(rows, "a minted tool grant is audited").toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: users.admin.id,
      objectType: "user",
      objectId: users.member.id,
      effect: "allow",
      detail: { grantId: g.json().id, granteeUserId: users.member.id, serverId, toolName: "mcp:resources" },
    });
  });
});
