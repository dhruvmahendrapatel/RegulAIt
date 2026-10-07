/**
 * ADR-0185 G4 — stdio and SSE upstream transports, pinned on a real database
 * through the real app and the real SDK transports:
 *
 *  - both transports are governed EXACTLY like Streamable HTTP: an allowed call
 *    reaches the upstream, a denied one makes ZERO upstream contact (no SSE
 *    request, no stdio process);
 *  - SSE: every request goes through the guarded fetch; a cross-origin
 *    `endpoint` event is refused (audited) and the other origin is never hit;
 *  - stdio: the double opt-in (host env + org setting), the command rules
 *    (absolute, realpath inside an allowed dir — a symlink escape refused —
 *    regular, executable, not world-writable), argv bounds, injection inert
 *    (no shell), the child sees no secrets, cwd is the allowed dir, the pinned
 *    digest refuses a swapped binary, the process cap, kill on close and on a
 *    missed deadline, the `stdio:` sentinel never reaching a fetch;
 *  - PATCH: transport immutable, rename rewrites the sentinel url, a changed
 *    command/argv resets admission to `unscanned` (audited with transitions);
 *  - the health probe never selects a stdio server;
 *  - the reserved `mcp:` tool-name prefix holds the server and cannot be
 *    cleared.
 *
 * Global state (M-068): the org transports, the private-range/cooldown
 * relaxations and the stdio env vars are restored in `afterAll`; every server
 * row is deleted; every temp dir is removed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
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
import { liveStdioProcesses, originPinnedFetch, SseCrossOriginError } from "./mcp-transports.js";
import { executeGovernedToolCall, syncUpstreamTools } from "./mcp-proxy.js";
import { McpAdmissionHeldError } from "./mcp-admission.js";
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
const SYNTHETIC_SECRET = `synthetic-g4-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
const users = {} as Record<"admin" | "member" | "stranger", { id: string; auth: { authorization: string } }>;
const createdServers: string[] = [];
const tempDirs: string[] = [];
const restore: Array<() => Promise<void>> = [];
const savedEnv: Record<string, string | undefined> = {};

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

let allowedDir = "";
let outsideDir = "";

function setEnv(key: string, value: string | undefined) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/**
 * A minimal MCP server over stdio, in plain Node (no dependency to resolve
 * from a temp dir). argv[2] is a marker file every start appends its pid to;
 * `--reserved` declares a tool named `mcp:resources`; `--hang` never answers.
 * It writes to stderr on purpose (the gateway must drain and discard it).
 */
function stdioServerSource(): string {
  return `#!${process.execPath}
const fs = require("fs");
const argv = process.argv.slice(2);
const marker = argv[0];
if (marker && !marker.startsWith("--")) fs.appendFileSync(marker, process.pid + "\\n");
process.stderr.write("g4 stdio noise\\n".repeat(2000));
if (argv.includes("--hang")) { setInterval(() => {}, 1000); return; }
const tools = [
  { name: "env_keys", description: "report the child's environment keys", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "echo_args", description: "report argv and cwd", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
];
if (argv.includes("--reserved")) tools.push({ name: "mcp:resources", description: "list", inputSchema: { type: "object" } });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "g4-stdio", version: "0.0.1" } } });
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
    } else if (msg.method === "tools/call") {
      const text = msg.params.name === "env_keys"
        ? JSON.stringify({ keys: Object.keys(process.env).sort(), values: Object.values(process.env) })
        : JSON.stringify({ argv, cwd: process.cwd() });
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
    } else if (msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;
}

function writeExecutable(dir: string, name: string, body = stdioServerSource(), mode = 0o755): string {
  const file = path.join(dir, name);
  writeFileSync(file, body);
  chmodSync(file, mode);
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
async function waitFor(pred: () => boolean, ms = 8000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

async function setTransports(t: string[]) {
  const r = await inject("PUT", "/v1/org/settings", users.admin.auth, { mcpUpstreamTransports: t });
  expect(r.statusCode, r.body).toBe(200);
}

async function registerStdio(name: string, command: string, args: string[]) {
  const r = await inject("POST", "/v1/servers", users.admin.auth, { name, transport: "stdio", stdio: { command, args } });
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
  allowedDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "g4-allowed-")));
  outsideDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "g4-outside-")));
  tempDirs.push(allowedDir, outsideDir);
  // the secrets a child must never see — present in the GATEWAY's env
  setEnv("REGULAIT_DATA_KEY", process.env.REGULAIT_DATA_KEY ?? "a".repeat(64));
  setEnv("REGULAIT_G4_SYNTHETIC_SECRET", SYNTHETIC_SECRET);
  setEnv("REGULAIT_MCP_STDIO_ALLOWED_DIRS", allowedDir);
  setEnv("REGULAIT_MCP_STDIO_MAX_PROCS", undefined);
}, 120_000);

afterAll(async () => {
  await restoreStepUp?.();
  await db.execute(sql`UPDATE org_settings SET mcp_upstream_transports = '["streamable_http"]'::jsonb`);
  for (const r of restore.reverse()) await r();
  await restoreAdminKeyMfa?.();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (createdServers.length) await db.delete(mcpServers).where(inArray(mcpServers.id, createdServers));
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  app.server.closeAllConnections();
  await app.close();
});

// ---------------------------------------------------------------------------

describe("G4 stdio: the double opt-in", () => {
  it("is impossible while the host names no allowed directory, whatever the org enables", async () => {
    await setTransports(["streamable_http", "stdio"]);
    const cmd = writeExecutable(allowedDir, `noenv-${RUN}`);
    setEnv("REGULAIT_MCP_STDIO_ALLOWED_DIRS", undefined);
    try {
      const r = await registerStdio(`g4-noenv-${RUN}`, cmd, []);
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json().error).toBe("mcp_stdio_unavailable");
      // a directory that does not exist allows nothing either
      setEnv("REGULAIT_MCP_STDIO_ALLOWED_DIRS", path.join(allowedDir, "missing"));
      const r2 = await registerStdio(`g4-noenv2-${RUN}`, cmd, []);
      expect(r2.json().error).toBe("mcp_stdio_unavailable");
    } finally {
      setEnv("REGULAIT_MCP_STDIO_ALLOWED_DIRS", allowedDir);
    }
    // an existing stdio server stops at connect the moment the host opt-in goes
    const marker = markerPath(`noenv-${RUN}`);
    const ok = await registerStdio(`g4-noenv3-${RUN}`, cmd, [marker]);
    expect(ok.statusCode, ok.body).toBe(201);
    setEnv("REGULAIT_MCP_STDIO_ALLOWED_DIRS", undefined);
    try {
      const err = await errorOf(guardedMcpConnect(db, ok.json()));
      expect(err).toBeInstanceOf(McpUpstreamRefusedError);
      expect((err as McpUpstreamRefusedError).error).toBe("mcp_stdio_unavailable");
      expect((await lastDeny(ok.json().id))?.ruleId).toBe("mcp-stdio-unavailable");
      expect(starts(marker), "nothing was started").toEqual([]);
    } finally {
      setEnv("REGULAIT_MCP_STDIO_ALLOWED_DIRS", allowedDir);
    }
  });

  it("needs the org to enable stdio (and SSE): 422 mcp_transport_disabled at registration, refused at connect", async () => {
    await setTransports(["streamable_http"]);
    const cmd = writeExecutable(allowedDir, `orgoff-${RUN}`);
    const r = await registerStdio(`g4-orgoff-${RUN}`, cmd, []);
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

    // registered while enabled, then the admin takes stdio away: connect refused
    await setTransports(["streamable_http", "stdio"]);
    const marker = markerPath(`orgoff-${RUN}`);
    const ok = await registerStdio(`g4-orgoff2-${RUN}`, cmd, [marker]);
    expect(ok.statusCode, ok.body).toBe(201);
    await setTransports(["streamable_http"]);
    const err = await errorOf(checkUpstreamDestination(db, ok.json()));
    expect((err as McpUpstreamRefusedError).error).toBe("mcp_transport_disabled");
    expect((await lastDeny(ok.json().id))?.ruleId).toBe("mcp-transport-disabled");
    expect(starts(marker)).toEqual([]);
    await setTransports(["streamable_http", "stdio"]);
  });
});

describe("G4 stdio: the command rules (400 mcp_stdio_command_refused)", () => {
  it("refuses a relative path, a symlink escape, a directory, a non-executable, a world- or group-writable file, and a writable parent directory", async () => {
    await setTransports(["streamable_http", "stdio"]);
    const outside = writeExecutable(outsideDir, `evil-${RUN}`);
    const link = path.join(allowedDir, `escape-${RUN}`);
    symlinkSync(outside, link);
    const noexec = writeExecutable(allowedDir, `noexec-${RUN}`, stdioServerSource(), 0o644);
    const ww = writeExecutable(allowedDir, `ww-${RUN}`);
    chmodSync(ww, 0o777);
    const sub = path.join(allowedDir, `dir-${RUN}`);
    mkdirSync(sub);
    // B3S-06: a group-writable file, and good files in group-/world-writable directories
    const gw = writeExecutable(allowedDir, `gw-${RUN}`);
    chmodSync(gw, 0o775);
    const gwDir = path.join(allowedDir, `gwdir-${RUN}`);
    mkdirSync(gwDir);
    chmodSync(gwDir, 0o775);
    const inGwDir = writeExecutable(gwDir, `ok-${RUN}`);
    const wwDir = path.join(allowedDir, `wwdir-${RUN}`);
    mkdirSync(wwDir);
    chmodSync(wwDir, 0o777);
    const inWwDir = writeExecutable(wwDir, `ok-${RUN}`);
    // a strict directory nested in a writable one is still under it
    const nested = path.join(wwDir, `strict-${RUN}`);
    mkdirSync(nested);
    chmodSync(nested, 0o755);
    const inNested = writeExecutable(nested, `ok-${RUN}`);
    const cases: Array<[string, string]> = [
      [`bin/${RUN}`, "not_absolute"],
      [outside, "outside_allowed_dirs"],
      [link, "outside_allowed_dirs"],
      [path.join(allowedDir, "..", path.basename(outsideDir), `evil-${RUN}`), "outside_allowed_dirs"],
      [sub, "not_executable"],
      [path.join(allowedDir, `absent-${RUN}`), "not_executable"],
      [noexec, "not_executable"],
      [ww, "world_writable"],
      [gw, "group_writable"],
      [inGwDir, "writable_parent"],
      [inWwDir, "writable_parent"],
      [inNested, "writable_parent"],
    ];
    for (const [command, code] of cases) {
      const r = await registerStdio(`g4-cmd-${code}-${Math.random().toString(36).slice(2, 7)}`, command, []);
      expect(r.statusCode, `${command}: ${r.body}`).toBe(400);
      expect(r.json(), command).toMatchObject({ error: "mcp_stdio_command_refused", code });
    }
  });

  it("refuses argv past its bounds: > 64 entries, an entry > 4 KiB, a NUL byte", async () => {
    const cmd = writeExecutable(allowedDir, `argv-${RUN}`);
    for (const args of [
      Array.from({ length: 65 }, (_, i) => `a${i}`),
      ["x".repeat(4097)],
      ["ok", "bad\u0000arg"],
    ]) {
      const r = await registerStdio(`g4-argv-${Math.random().toString(36).slice(2, 7)}`, cmd, args);
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json()).toMatchObject({ error: "mcp_stdio_command_refused", code: "invalid_argv" });
    }
    // the limits themselves are fine
    const max = await registerStdio(`g4-argv-max-${RUN}`, cmd, [...Array.from({ length: 63 }, () => "y"), "z".repeat(4096)]);
    expect(max.statusCode, max.body).toBe(201);
  });

  it("a symlink re-pointed out of the allowed directory after registration is refused at connect", async () => {
    const inside = writeExecutable(allowedDir, `target-${RUN}`);
    const link = path.join(allowedDir, `relink-${RUN}`);
    symlinkSync(inside, link);
    const r = await registerStdio(`g4-relink-${RUN}`, link, []);
    expect(r.statusCode, r.body).toBe(201);
    // byte-identical file outside: the digest alone would not notice
    writeFileSync(path.join(outsideDir, `target-${RUN}`), readFileSync(inside));
    chmodSync(path.join(outsideDir, `target-${RUN}`), 0o755);
    unlinkSync(link);
    symlinkSync(path.join(outsideDir, `target-${RUN}`), link);
    const err = await errorOf(guardedMcpConnect(db, r.json()));
    expect(err).toBeInstanceOf(McpUpstreamRefusedError);
    expect((err as McpUpstreamRefusedError).refusalCode).toBe("outside_allowed_dirs");
    expect((await lastDeny(r.json().id))?.ruleId).toBe("mcp-stdio-command-refused");
  });
});

describe("G4 stdio: governed exactly like HTTP", () => {
  let serverId = "";
  let marker = "";
  let command = "";
  it("registration pins the digest and shows argv as a list; the url is the sentinel", async () => {
    command = writeExecutable(allowedDir, `fs-${RUN}`);
    marker = markerPath(`fs-${RUN}`);
    const r = await registerStdio(`g4-fs-${RUN}`, command, [marker, "--flag"]);
    expect(r.statusCode, r.body).toBe(201);
    serverId = r.json().id;
    expect(r.json()).toMatchObject({
      transport: "stdio",
      url: `stdio:g4-fs-${RUN}`,
      stdio: { command, args: [marker, "--flag"] },
      admissionState: "unscanned",
    });
    expect(r.json().stdioCommandDigest).toMatch(/^[0-9a-f]{64}$/);
    const list = await inject("GET", "/v1/servers", users.admin.auth);
    const row = (list.json().servers as Array<{ id: string; stdio: unknown }>).find((s) => s.id === serverId);
    expect(row?.stdio).toEqual({ command, args: [marker, "--flag"] });
    const [reg] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, serverId), eq(auditLog.ruleId, "mcp-stdio-server-registered")));
    expect(reg, "a stdio registration is audited").toBeDefined();
    expect(starts(marker), "registration starts nothing").toEqual([]);
  });

  it("an allowed call runs the child; a denied call starts NO process", async () => {
    await addTool(serverId, "env_keys", users.member.id);
    await addTool(serverId, "echo_args", users.member.id);
    const ok = await callTool(users.member.id, serverId, "env_keys");
    expect(ok.kind, JSON.stringify(ok)).toBe("allowed");
    expect(starts(marker).length).toBe(1);

    const denied = await callTool(users.stranger.id, serverId, "env_keys");
    expect(denied.kind).toBe("denied");
    expect(starts(marker).length, "a denied call must not start the command").toBe(1);
  });

  it("the child sees only the SDK's safe environment — never DATABASE_URL, REGULAIT_DATA_KEY or any other secret", async () => {
    expect(process.env.DATABASE_URL, "precondition: the gateway has the secret").toBeTruthy();
    expect(process.env.REGULAIT_DATA_KEY).toBeTruthy();
    const out = await callTool(users.member.id, serverId, "env_keys");
    expect(out.kind).toBe("allowed");
    const { keys, values } = textOf(out) as { keys: string[]; values: string[] };
    expect(keys).not.toContain("DATABASE_URL");
    expect(keys).not.toContain("REGULAIT_DATA_KEY");
    expect(keys).not.toContain("REGULAIT_G4_SYNTHETIC_SECRET");
    for (const k of keys) expect(["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"]).toContain(k);
    expect(values.join("\n")).not.toContain(SYNTHETIC_SECRET);
    expect(values.join("\n")).not.toContain(DATABASE_URL!);
  });

  it("argv reaches the child verbatim and is never shell-interpolated; cwd is the allowed directory", async () => {
    const pwned = path.join(allowedDir, `pwned-${RUN}`);
    const hostile = [
      `; touch ${pwned}`,
      `$(touch ${pwned})`,
      `\`touch ${pwned}\``,
      `&& touch ${pwned}`,
      `| touch ${pwned}`,
      "$HOME",
      "*",
    ];
    const r = await registerStdio(`g4-inject-${RUN}`, command, ["--x", ...hostile]);
    expect(r.statusCode, r.body).toBe(201);
    await addTool(r.json().id, "echo_args", users.member.id);
    const out = await callTool(users.member.id, r.json().id, "echo_args");
    expect(out.kind, JSON.stringify(out)).toBe("allowed");
    const { argv, cwd } = textOf(out) as { argv: string[]; cwd: string };
    expect(argv).toEqual(["--x", ...hostile]);
    expect(cwd).toBe(allowedDir);
    expect(existsSync(pwned), "no shell ran the injected command").toBe(false);
  });

  it("each request is its own process, killed on close; the sentinel url never reaches a fetch", async () => {
    const fetches: string[] = [];
    const resolves: string[] = [];
    const deps = {
      fetchImpl: (async (u: string | URL | Request) => {
        fetches.push(String(u));
        return new Response(null, { status: 500 });
      }) as typeof fetch,
      resolve: async (h: string) => {
        resolves.push(h);
        return [{ address: "127.0.0.1", family: 4 }];
      },
    };
    const before = starts(marker).length;
    const c1 = await guardedMcpConnect(db, { id: serverId, url: `stdio:g4-fs-${RUN}`, allowPrivateRanges: null }, deps);
    const c2 = await guardedMcpConnect(db, { id: serverId, url: `stdio:g4-fs-${RUN}`, allowPrivateRanges: null }, deps);
    const pids = starts(marker).slice(before);
    expect(pids.length, "one process per connect (the narrow row shape is re-read)").toBe(2);
    expect(new Set(pids).size).toBe(2);
    expect(liveStdioProcesses()).toBeGreaterThanOrEqual(2);
    await c1.close();
    await c2.close();
    expect(await waitFor(() => pids.every((p) => !alive(p))), "closed children are gone").toBe(true);
    expect(liveStdioProcesses()).toBe(0);
    expect(fetches, "no fetch for a stdio upstream").toEqual([]);
    expect(resolves, "no DNS lookup for a stdio upstream").toEqual([]);
  });

  it("caps live processes at REGULAIT_MCP_STDIO_MAX_PROCS; a refusal starts nothing", async () => {
    setEnv("REGULAIT_MCP_STDIO_MAX_PROCS", "1");
    try {
      const row = { id: serverId, url: `stdio:g4-fs-${RUN}`, allowPrivateRanges: null };
      const first = await guardedMcpConnect(db, row);
      const before = starts(marker).length;
      const err = await errorOf(guardedMcpConnect(db, row));
      expect(err).toBeInstanceOf(McpUpstreamRefusedError);
      expect((err as McpUpstreamRefusedError).error).toBe("mcp_stdio_busy");
      expect(starts(marker).length).toBe(before);
      await first.close();
      const again = await guardedMcpConnect(db, row);
      await again.close();
    } finally {
      setEnv("REGULAIT_MCP_STDIO_MAX_PROCS", undefined);
    }
    expect(liveStdioProcesses()).toBe(0);
  });

  it("a child that never answers is killed at the connect deadline", async () => {
    const hangMarker = markerPath(`hang-${RUN}`);
    const r = await registerStdio(`g4-hang-${RUN}`, command, [hangMarker, "--hang"]);
    expect(r.statusCode, r.body).toBe(201);
    const t0 = Date.now();
    const err = await errorOf(guardedMcpConnect(db, r.json(), { connectDeadlineMs: 600 }));
    expect((err as Error)?.name).toBe("TimeoutError");
    expect(Date.now() - t0).toBeLessThan(6000);
    const [pid] = starts(hangMarker);
    expect(pid).toBeDefined();
    expect(await waitFor(() => !alive(pid!)), "the hung child was killed").toBe(true);
    expect(await waitFor(() => liveStdioProcesses() === 0)).toBe(true);
  });

  it("a swapped binary is refused at connect (403-class, audited) and nothing is started", async () => {
    const swapMarker = markerPath(`swap-${RUN}`);
    const bin = writeExecutable(allowedDir, `swap-${RUN}`);
    const r = await registerStdio(`g4-swap-${RUN}`, bin, [swapMarker]);
    expect(r.statusCode, r.body).toBe(201);
    await addTool(r.json().id, "echo_args", users.member.id);
    expect((await callTool(users.member.id, r.json().id, "echo_args")).kind).toBe("allowed");
    expect(starts(swapMarker).length).toBe(1);
    appendFileSync(bin, "\n// a different program now\n");
    const err = await errorOf(callTool(users.member.id, r.json().id, "echo_args"));
    expect(err).toBeInstanceOf(McpEgressBlockedError); // every caller's "our own refusal" branch
    expect((err as McpUpstreamRefusedError).error).toBe("mcp_stdio_digest_mismatch");
    const deny = await lastDeny(r.json().id);
    expect(deny?.ruleId).toBe("mcp-stdio-digest-mismatch");
    expect((deny?.detail as { pinnedDigest: string }).pinnedDigest).toBe(r.json().stdioCommandDigest);
    // the proxy route's pre-hijack 403 names the transport refusal's own code
    // (attribution is a separate gate this assertion is not about)
    const restoreAttribution = await relaxGovernanceGatesForTest(db, { requireMcpAttribution: false });
    const viaRoute = await inject(
      "POST",
      `/mcp/${r.json().id}`,
      { ...users.member.auth, accept: "application/json, text/event-stream", "content-type": "application/json" },
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    ).finally(restoreAttribution);
    expect(viaRoute.statusCode, viaRoute.body).toBe(403);
    expect(viaRoute.json().error).toBe("mcp_stdio_digest_mismatch");
    expect(starts(swapMarker).length, "the swapped binary never ran").toBe(1);
    // our refusal never charges the breaker
    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, r.json().id));
    expect(row!.breakerConsecutiveFailures).toBe(0);
    // re-pinning is an admin act: PATCH the same command → new digest, admission reset
    const p = await inject("PATCH", `/v1/servers/${r.json().id}`, users.admin.auth, { stdio: { command: bin, args: [swapMarker] } });
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json().stdioCommandDigest).not.toBe(r.json().stdioCommandDigest);
    expect((await callTool(users.member.id, r.json().id, "echo_args")).kind).toBe("allowed");
  });
});

describe("G4 stdio: PATCH", () => {
  it("a transport never changes; a stdio server has no url; rename rewrites the sentinel; a new argv resets admission", async () => {
    const cmd = writeExecutable(allowedDir, `patch-${RUN}`);
    const r = await registerStdio(`g4-patch-${RUN}`, cmd, ["--a"]);
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
    const bad = await inject("PATCH", `/v1/servers/${id}`, users.admin.auth, { stdio: { command: "rel/x", args: [] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "mcp_stdio_command_refused", code: "not_absolute" });

    await db.update(mcpServers).set({ admissionState: "clean" }).where(eq(mcpServers.id, id));
    const same = await inject("PATCH", `/v1/servers/${id}`, users.admin.auth, { stdio: { command: cmd, args: ["--a"] } });
    expect(same.json().admissionState, "restating the same program changes nothing").toBe("clean");
    const changed = await inject("PATCH", `/v1/servers/${id}`, users.admin.auth, { stdio: { command: cmd, args: ["--b"] } });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({ admissionState: "unscanned", stdio: { command: cmd, args: ["--b"] } });
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, id), eq(auditLog.ruleId, "mcp-stdio-command-changed")))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    expect((audit?.detail as { transitions: Record<string, unknown> }).transitions).toMatchObject({
      args: { from: ["--a"], to: ["--b"] },
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

describe("G4: the reserved mcp: tool-name prefix", () => {
  it("an upstream tool named mcp:* holds the server, and the hold cannot be cleared", async () => {
    const cmd = writeExecutable(allowedDir, `reserved-${RUN}`);
    const r = await registerStdio(`g4-reserved-${RUN}`, cmd, ["--reserved"]);
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id as string;
    // the shipped default, asserted rather than assumed (an earlier file may
    // have left the shared org relaxed); restored to what was found
    const [{ mode: found } = { mode: "enforce" }] = (
      await db.execute(sql`select mcp_admission_mode as mode from org_settings`)
    ).rows as Array<{ mode: string }>;
    await db.execute(sql`update org_settings set mcp_admission_mode = 'enforce'`);
    try {
      const client = await guardedMcpConnect(db, r.json());
      try {
        const err = await errorOf(syncUpstreamTools(db, id, client));
        expect(err).toBeInstanceOf(McpAdmissionHeldError);
      } finally {
        await client.close();
      }
    } finally {
      await db.execute(sql`update org_settings set mcp_admission_mode = ${found}`);
    }
    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, id));
    expect(row!.admissionState).toBe("held");
    expect(row!.admissionFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "mcp.reserved_name.prefix", tool: "mcp:resources", severity: "critical" }),
      ]),
    );
    const clear = await inject("POST", `/v1/servers/${id}/admission/clear`, users.admin.auth, {
      reason: "g4 test: trying to clear a reserved name",
    });
    expect(clear.statusCode, clear.body).toBe(409);
    expect(clear.json().error).toBe("reserved_tool_name");
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
