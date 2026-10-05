import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { and, auditLog, createDb, desc, eq, gt, mcpServers, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";
import { McpAdmissionHeldError } from "./mcp-admission.js";
import { McpEgressBlockedError } from "./mcp-egress.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

/**
 * AER-024 — AN OPEN BREAKER MUST NOT HIDE AN ADMISSION HOLD OR AN EGRESS REFUSAL.
 *
 * Before the fix, both upstream paths asked the breaker FIRST: an open circuit
 * answered `503 mcp_upstream_circuit_open` ("retry later") before
 * `assertAdmitted` or the egress URL check ever ran, so a server this
 * deployment had HELD, or pointed at a destination it refuses to reach, was
 * reported as an outage for as long as its circuit stayed open, with no deny
 * row. The preflight now runs those two gates before the breaker is consulted.
 *
 * Every refusal case asserts three things: the refusal is NAMED (not the
 * circuit), it is AUDITED under its own rule id, and the upstream saw nothing.
 * The admitted-and-permitted server with the same open breaker is the
 * positive control: it still gets the breaker's 503, which is the lift policy
 * g2-upstream-deadlines.test.ts pins.
 */

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must name a disposable test database");
const admin = { authorization: "Bearer aer024-preflight-bootstrap" };
let db: Db;
let app: ReturnType<typeof buildApp>;
let gatewayUrl: string;
let userId: string;
let auth: { authorization: string };

const setAdmissionMode = async (mcpAdmissionMode: "off" | "enforce") => {
  const r = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: admin, payload: { mcpAdmissionMode } });
  expect(r.statusCode).toBe(200);
};

beforeAll(async () => {
  db = createDb(databaseUrl);
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  app = buildApp(db, {
    bootstrapToken: "aer024-preflight-bootstrap",
    breaker: { failureThreshold: 2, cooldownMs: 30_000 },
    retry: { maxAttempts: 1 },
    timeouts: { mcpConnectMs: 2000, mcpListToolsMs: 2000, mcpCallToolMs: 2000 },
  });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { requireMcpAttribution: false });
  gatewayUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const user = await app.inject({ method: "POST", url: "/v1/users", headers: admin,
    payload: { email: `aer024-${Date.now()}@example.test`, displayName: "Preflight test" } });
  expect(user.statusCode).toBe(201);
  userId = user.json().id;
  const key = await app.inject({ method: "POST", url: `/v1/users/${userId}/keys`, headers: admin,
    payload: { name: "aer024" } });
  auth = { authorization: `Bearer ${key.json().token}` };
}, 120_000);

afterAll(async () => {
  await setAdmissionMode("off");
  app.server.closeAllConnections();
  await restoreSb2Gates();
  await app.close();
});

async function fixture() {
  const counts = { requests: 0 };
  const server = http.createServer((req, res) => {
    counts.requests++;
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      void (async () => {
        const message = body ? JSON.parse(body) : undefined;
        const mcp = new McpServer({ name: "aer024", version: "1" });
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
    payload: { name: `aer024-${crypto.randomUUID()}`, url: `http://127.0.0.1:${address.port}/` } });
  expect(registered.statusCode, registered.body).toBe(201);
  const id: string = registered.json().id;
  const grant = await app.inject({ method: "POST", url: "/v1/grants/tools", headers: admin,
    payload: { userId, serverId: id, toolName: "ping" } });
  expect(grant.statusCode, grant.body).toBe(201);
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
  // Persist the manifest while the server is healthy, so a later tools/call
  // needs no discovery and reaches the call-path breaker check directly.
  expect((await proxy("tools/list")).statusCode).toBe(200);
  const openBreaker = () => db.update(mcpServers).set({
    breakerOpenedAt: new Date(), breakerConsecutiveFailures: 2, breakerLastError: "prior outage",
  }).where(eq(mcpServers.id, id));
  const hold = () => db.update(mcpServers).set({
    admissionState: "held", admissionSeverity: "high",
    admissionFindings: [{ ruleId: "mcp.admission.injection", severity: "high", toolName: "ping" }],
    admissionManifestDigest: "sha256:aer024", admissionScannedAt: new Date(),
  }).where(eq(mcpServers.id, id));
  // Registered against a permitted URL, then pointed at a refused one directly,
  // because the write-time guard would refuse the registration — the shape of a
  // server after the allow-list was tightened underneath it. TEST-NET-3 is
  // public, so the private-range posture is irrelevant and nothing resolves it.
  const refuseEgress = () => db.update(mcpServers).set({
    url: `http://203.0.113.${1 + Math.floor(Math.random() * 250)}:8931/`,
  }).where(eq(mcpServers.id, id));
  return {
    id, counts, proxy, direct, openBreaker, hold, refuseEgress,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function auditSince(serverId: string, ruleId: string, since: Date) {
  return db.select().from(auditLog)
    .where(and(eq(auditLog.serverId, serverId), eq(auditLog.ruleId, ruleId), gt(auditLog.at, since)))
    .orderBy(desc(auditLog.at));
}

describe("a HELD server behind an open breaker is refused as held, not as an outage", () => {
  it("manifest path: 403 mcp_admission_held, audited, upstream untouched", async () => {
    const f = await fixture();
    try {
      await setAdmissionMode("enforce");
      await f.hold();
      await f.openBreaker();
      const since = new Date();
      const before = f.counts.requests;
      const res = await f.proxy("tools/list");
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("mcp_admission_held");
      expect(body.detail).toContain("HELD by admission scanning");
      expect(res.body).not.toContain("circuit");
      expect(f.counts.requests).toBe(before);
      const rows = await auditSince(f.id, "mcp-admission-held", since);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]!.effect).toBe("deny");
      // the breaker was never elected for it: the row is still as we opened it
      const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, f.id));
      expect(row!.breakerConsecutiveFailures).toBe(2);
    } finally { await setAdmissionMode("off"); await f.close(); }
  });

  it("tools/call path (proxy and direct): the named policy refusal, audited, upstream untouched", async () => {
    const f = await fixture();
    try {
      await setAdmissionMode("enforce");
      await f.hold();
      await f.openBreaker();
      const since = new Date();
      const before = f.counts.requests;
      const res = await f.proxy("tools/call");
      expect(res.body).toContain("Denied by policy");
      expect(res.body).toContain("HELD by admission scanning");
      expect(res.body).not.toMatch(/circuit|Upstream unavailable/);
      await expect(f.direct()).rejects.toBeInstanceOf(McpAdmissionHeldError);
      expect(f.counts.requests).toBe(before);
      const rows = await auditSince(f.id, "mcp-admission-held", since);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const r of rows) expect(r.effect).toBe("deny");
    } finally { await setAdmissionMode("off"); await f.close(); }
  });
});

describe("an EGRESS-REFUSED server behind an open breaker is refused as egress, not as an outage", () => {
  it("manifest path: 403 egress_blocked, audited at phase connect, nothing resolved or contacted", async () => {
    const f = await fixture();
    try {
      await f.refuseEgress();
      await f.openBreaker();
      const since = new Date();
      const before = f.counts.requests;
      const res = await f.proxy("tools/list");
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBe("egress_blocked");
      expect(res.body).not.toContain("circuit");
      expect(f.counts.requests).toBe(before);
      const rows = await auditSince(f.id, "mcp-server-egress-blocked", since);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]!.effect).toBe("deny");
      expect((rows[0]!.detail as Record<string, unknown>).phase).toBe("connect");
    } finally { await f.close(); }
  });

  it("tools/call path (proxy and direct): the named policy refusal, audited, nothing contacted", async () => {
    const f = await fixture();
    try {
      await f.refuseEgress();
      await f.openBreaker();
      const since = new Date();
      const before = f.counts.requests;
      const res = await f.proxy("tools/call");
      expect(res.body).toContain("Denied by policy");
      expect(res.body).toContain("egress blocked");
      expect(res.body).not.toMatch(/circuit|Upstream unavailable/);
      await expect(f.direct()).rejects.toBeInstanceOf(McpEgressBlockedError);
      expect(f.counts.requests).toBe(before);
      const rows = await auditSince(f.id, "mcp-server-egress-blocked", since);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const r of rows) expect((r.detail as Record<string, unknown>).phase).toBe("connect");
    } finally { await f.close(); }
  });
});

describe("POSITIVE CONTROL — an admitted, permitted server keeps the breaker's lift policy", () => {
  it("manifest 503 mcp_upstream_circuit_open with retry-after; tools/call reports the circuit; nothing contacted", async () => {
    const f = await fixture();
    try {
      await f.openBreaker();
      const before = f.counts.requests;
      const list = await f.proxy("tools/list");
      expect(list.statusCode).toBe(503);
      expect(JSON.parse(list.body).error).toBe("mcp_upstream_circuit_open");
      const call = await f.proxy("tools/call");
      expect(call.body).toMatch(/circuit/);
      expect((await f.direct()).kind).toBe("upstream_circuit_open");
      expect(f.counts.requests).toBe(before);
    } finally { await f.close(); }
  });
});
