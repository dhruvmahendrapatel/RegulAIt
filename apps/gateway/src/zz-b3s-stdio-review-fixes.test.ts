/**
 * Batch-3 security review — the stdio findings, on a real database through the
 * real app (listening on a real port) and a real stdio child:
 *
 *  B3S-01  a caller with NO entitlement on a stdio server cannot make the
 *          gateway start its process: `tools/list` is a 403
 *          `mcp_no_entitlement` and a `tools/call` on a tool missing from the
 *          stored manifest is "Denied by policy", both audited
 *          `mcp-stdio-no-entitlement`, nothing started. An entitled caller's
 *          listing is served from the stored manifest once one exists.
 *  B3S-02  a client that disconnects while the gateway is still starting the
 *          stdio child (spawn + initialize) does not leave the child running
 *          or its process slot taken.
 *
 * Races are made deterministic with a pause point, never a sleep: the fixture
 * child started with `--gate` does not answer `initialize` until it receives
 * SIGUSR2, so the test decides exactly when the connect completes.
 *
 * Global state (M-068): org transports, the relaxed gates and the stdio env
 * vars are restored in afterAll; every server row and temp dir is removed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { and, auditLog, createDb, eq, inArray, mcpServers, mcpTools, runMigrations, sql, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { liveStdioProcesses } from "./mcp-transports.js";
import { executeGovernedToolCall, MCP_STDIO_NO_ENTITLEMENT_RULE_ID } from "./mcp-proxy.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const PORT = Number(process.env.PORT ?? 4313);

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `b3s-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let gatewayUrl = "";
const users = {} as Record<"admin" | "member" | "stranger", { id: string; token: string; auth: { authorization: string } }>;
const createdServers: string[] = [];
const restore: Array<() => Promise<void>> = [];
const savedEnv: Record<string, string | undefined> = {};
let allowedDir = "";

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

function setEnv(key: string, value: string | undefined) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/**
 * A minimal stdio MCP server in plain Node. argv[0] is a marker file each
 * start appends its pid to. `--gate`: `initialize` is answered only after the
 * process receives SIGUSR2 (the test's pause point).
 */
function stdioServerSource(): string {
  return `#!${process.execPath}
const fs = require("fs");
const argv = process.argv.slice(2);
const marker = argv[0];
const gated = argv.includes("--gate");
let open = !gated;
const pending = [];
process.on("SIGUSR2", () => { open = true; while (pending.length) pending.shift()(); });
if (marker && !marker.startsWith("--")) fs.appendFileSync(marker, process.pid + "\\n");
const tools = [
  { name: "echo_args", description: "report argv", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "env_keys", description: "report env keys", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
];
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      const answer = () => send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "b3s-stdio", version: "0.0.1" } } });
      if (open) answer(); else pending.push(answer);
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
    } else if (msg.method === "tools/call") {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ argv }) }] } });
    } else if (msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;
}

function writeExecutable(name: string): string {
  const file = path.join(allowedDir, name);
  writeFileSync(file, stdioServerSource());
  chmodSync(file, 0o755);
  return file;
}
const markerPath = (name: string) => path.join(allowedDir, `${name}.marker`);
const starts = (marker: string) =>
  existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean).map(Number) : [];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** poll a CONDITION (never a fixed sleep) until it holds or the bound passes */
async function waitFor(pred: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

async function registerStdio(name: string, command: string, args: string[]): Promise<string> {
  const r = await inject("POST", "/v1/servers", users.admin.auth, { name, transport: "stdio", stdio: { command, args } });
  expect(r.statusCode, r.body).toBe(201);
  createdServers.push(r.json().id);
  return r.json().id as string;
}
async function grantServer(userId: string, serverId: string) {
  const g = await inject("POST", "/v1/grants/servers", AUTH, { userId, serverId, readOnlyAll: true });
  expect(g.statusCode, g.body).toBe(201);
}
async function clientFor(token: string, serverId: string): Promise<Client> {
  const client = new Client({ name: "b3s-client", version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp/${serverId}`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}
const MCP_HEADERS = { accept: "application/json, text/event-stream", "content-type": "application/json" };
const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  restore.push(await relaxStrictAdmissionForTest(db));
  restore.push(
    await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, requireMcpAttribution: false }),
  );
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  for (const [k, isAdmin] of [["admin", true], ["member", false], ["stranger", false]] as const) {
    const u = await inject("POST", "/v1/users", AUTH, { email: `b3s-${k}-${RUN}@example.com`, displayName: `b3s ${k} ${RUN}`, isAdmin });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "b3s" })).json().token as string;
    users[k] = { id, token, auth: { authorization: `Bearer ${token}` } };
  }
  allowedDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "b3s-allowed-")));
  setEnv("REGULAIT_MCP_STDIO_ALLOWED_DIRS", allowedDir);
  setEnv("REGULAIT_MCP_STDIO_MAX_PROCS", undefined);
  const t = await inject("PUT", "/v1/org/settings", users.admin.auth, { mcpUpstreamTransports: ["streamable_http", "stdio"] });
  expect(t.statusCode, t.body).toBe(200);
  gatewayUrl = await app.listen({ port: PORT, host: "127.0.0.1" });
}, 120_000);

afterAll(async () => {
  await db.execute(sql`UPDATE org_settings SET mcp_upstream_transports = '["streamable_http"]'::jsonb`);
  for (const r of restore.reverse()) await r();
  await restoreAdminKeyMfa?.();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (createdServers.length) await db.delete(mcpServers).where(inArray(mcpServers.id, createdServers));
  if (allowedDir) rmSync(allowedDir, { recursive: true, force: true });
  app.server.closeAllConnections();
  await app.close();
});

describe("B3S-01: no stdio process for a caller with no entitlement on the server", () => {
  let serverId = "";
  let marker = "";
  beforeAll(async () => {
    marker = markerPath(`ent-${RUN}`);
    serverId = await registerStdio(`b3s-ent-${RUN}`, writeExecutable(`ent-${RUN}`), [marker]);
  });

  it("tools/list by an ungranted caller is a 403 mcp_no_entitlement, audited, and starts nothing", async () => {
    const r = await inject("POST", `/mcp/${serverId}`, { ...users.stranger.auth, ...MCP_HEADERS }, LIST);
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error).toBe("mcp_no_entitlement");
    expect(starts(marker), "an ungranted listing must not start the command").toEqual([]);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, users.stranger.id), eq(auditLog.ruleId, MCP_STDIO_NO_ENTITLEMENT_RULE_ID)));
    expect(row).toMatchObject({ effect: "deny", serverId });
    expect((row!.detail as { method: string }).method).toBe("tools/list");
  });

  it("tools/call on a tool missing from the stored manifest by an ungranted caller is denied and starts nothing", async () => {
    const out = await executeGovernedToolCall(db, undefined, {
      userId: users.stranger.id,
      serverId,
      toolName: `not-in-manifest-${RUN}`,
      projectId: null,
      arguments: {},
    });
    expect(out.kind).toBe("denied");
    expect((out as { decision: { ruleId: string } }).decision.ruleId).toBe(MCP_STDIO_NO_ENTITLEMENT_RULE_ID);
    expect(starts(marker), "an ungranted unknown-tool sync must not start the command").toEqual([]);
  });

  it("an entitled caller's first listing syncs the manifest; the next is served from it without a process", async () => {
    await grantServer(users.member.id, serverId);
    const first = await clientFor(users.member.token, serverId);
    expect((await first.listTools()).tools.map((t) => t.name).sort()).toEqual(["echo_args", "env_keys"]);
    await first.close();
    expect(starts(marker).length, "the never-synced manifest needed one process").toBe(1);
    const stored = await db.select().from(mcpTools).where(eq(mcpTools.serverId, serverId));
    expect(stored.map((t) => t.name).sort()).toEqual(["echo_args", "env_keys"]);

    const second = await clientFor(users.member.token, serverId);
    const listed = (await second.listTools()).tools;
    expect(listed.map((t) => t.name)).toEqual(["echo_args", "env_keys"]);
    expect(listed.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    // an allowed call still runs the child
    const ran = await second.callTool({ name: "echo_args", arguments: {} });
    expect(JSON.parse((ran.content as Array<{ text: string }>)[0]!.text)).toEqual({ argv: [marker] });
    await second.close();
    expect(starts(marker).length, "the listing was served from the stored manifest; only the call started a process").toBe(2);
    expect(await waitFor(() => liveStdioProcesses() === 0)).toBe(true);
  });
});

describe("B3S-02: a client that disconnects mid-connect leaves no stdio child and no taken slot", () => {
  it("drop the socket while the child is still initializing: the slot is released and the child exits", async () => {
    const marker = markerPath(`drop-${RUN}`);
    const serverId = await registerStdio(`b3s-drop-${RUN}`, writeExecutable(`drop-${RUN}`), [marker, "--gate"]);
    await grantServer(users.member.id, serverId);
    expect(liveStdioProcesses()).toBe(0);
    // no idle keep-alive sockets left over from earlier clients: the only
    // connection the server holds from here on is this request's
    app.server.closeIdleConnections();
    const connections = () =>
      new Promise<number>((resolve, reject) => app.server.getConnections((err, n) => (err ? reject(err) : resolve(n))));
    expect(await waitFor(async () => (await connections()) === 0)).toBe(true);

    const body = JSON.stringify(LIST);
    const req = http.request({
      host: "127.0.0.1",
      port: PORT,
      path: `/mcp/${serverId}`,
      method: "POST",
      agent: false,
      headers: { ...users.member.auth, ...MCP_HEADERS, "content-length": Buffer.byteLength(body) },
    });
    req.on("error", () => undefined);
    req.end(body);

    // PAUSE POINT: the child is running and has not answered `initialize`
    expect(await waitFor(() => starts(marker).length === 1), "the manifest connect started the child").toBe(true);
    const [pid] = starts(marker);
    expect(liveStdioProcesses()).toBe(1);

    // the client goes away, and the gateway has seen it go
    req.destroy();
    expect(await waitFor(async () => (await connections()) === 0), "the gateway saw the disconnect").toBe(true);

    // only now does the connect complete
    process.kill(pid!, "SIGUSR2");
    expect(await waitFor(() => !alive(pid!), 5000), "the child of a departed client exits").toBe(true);
    expect(await waitFor(() => liveStdioProcesses() === 0, 5000), "its process slot is given back").toBe(true);
  });
});
