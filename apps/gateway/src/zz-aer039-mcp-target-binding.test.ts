/**
 * AER-039 — an MCP consent is bound to WHERE the approved bytes go.
 *
 * An admin could edit an MCP server's `url` / `allowPrivateRanges` in place,
 * keeping its id and admitted inventory, and a consent signed for upstream A
 * was then spent against upstream B. The approval context (v3) now carries the
 * server's destination, private-range posture and admitted manifest digest, so:
 *
 *   - a URL change through the API, or by direct SQL, leaves the old consent
 *     UNSPENT (stale, re-queued) with ZERO contact on either upstream; the
 *     fresh review binds upstream B, and only after it is approved does B run;
 *   - a private-range posture change, and admitted-manifest drift, do the same;
 *   - a URL change that lands mid-connect cannot route the signed call to B:
 *     evaluation and connection read one row snapshot, so the bytes go to A;
 *   - breaker churn (operational state on the same row) does NOT invalidate it.
 *
 * Both fake upstreams count HTTP requests and tool invocations; every
 * fail-closed assertion is a zero delta on both. Shared database: per-run tool
 * names and server rows; assertions are deltas (M-008).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { and, approvals, asc, auditLog, createDb, desc, eq, mcpServers, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "aer039-bootstrap-token";
const RUN = Math.random().toString(36).slice(2, 8);
const AUTH = { authorization: `Bearer ${BOOT}` };
const TOOL = `aer039_write_${RUN}`;

type Hits = { http: number; tool: number };
const hits: Record<"A" | "B", Hits> = { A: { http: 0, tool: 0 }, B: { http: 0, tool: 0 } };
const snapshot = () => ({ A: { ...hits.A }, B: { ...hits.B } });

let db: Db;
let app: ReturnType<typeof buildApp>;
const upstream: Record<"A" | "B", { url: string; close: () => Promise<void> }> = {} as never;
let callerId = "";
let approverId = "";
/** barrier hook: runs once, inside upstream A's first request, before it is served */
let onFirstHitA: (() => Promise<void>) | null = null;

async function startUpstream(name: "A" | "B") {
  const httpServer = http.createServer((req, res) => {
    hits[name].http++;
    const hook = name === "A" ? onFirstHitA : null;
    if (hook) onFirstHitA = null;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      void (async () => {
        if (hook) await hook();
        const server = new McpServer({ name: `aer039-${name}`, version: "0.0.1" });
        server.registerTool(TOOL, { description: TOOL, inputSchema: { text: z.string() } }, async ({ text }) => {
          hits[name].tool++;
          return { content: [{ type: "text", text: `${name} ran: ${text}` }] };
        });
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
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

async function mkUser(email: string): Promise<string> {
  const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: email.split("@")[0] } });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

/** a fresh server pointing at upstream A, with the tool registered, granted and approval-gated */
async function freshServer(label: string): Promise<string> {
  const s = await app.inject({ method: "POST", headers: AUTH, url: "/v1/servers", payload: { name: `aer039-${label}-${RUN}`, url: upstream.A.url } });
  expect(s.statusCode, s.body).toBe(201);
  const serverId = s.json().id as string;
  await app.inject({ method: "POST", headers: AUTH, url: `/v1/servers/${serverId}/tools`, payload: { name: TOOL, kind: "write" } });
  await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/tools", payload: { userId: callerId, serverId, toolName: TOOL } });
  const rule = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/rules/approvals",
    payload: { userId: callerId, serverId, toolName: TOOL, approverUserId: approverId },
  });
  expect(rule.statusCode, rule.body).toBe(201);
  return serverId;
}

const call = (serverId: string, text: string) =>
  executeGovernedToolCall(db, undefined, { userId: callerId, serverId, toolName: TOOL, arguments: { text } });

async function rowsFor(serverId: string, status: "pending" | "approved" | "superseded" | "consumed") {
  return db
    .select()
    .from(approvals)
    .where(and(eq(approvals.userId, callerId), eq(approvals.serverId, serverId), eq(approvals.toolName, TOOL), eq(approvals.status, status)))
    .orderBy(asc(approvals.requestedAt));
}

async function approve(approvalId: string) {
  const r = await db
    .update(approvals)
    .set({ status: "approved", decidedBy: approverId, decidedAt: new Date() })
    .where(eq(approvals.id, approvalId))
    .returning({ id: approvals.id });
  expect(r).toHaveLength(1);
}

/** queue a call against the server's CURRENT target and approve it — the consent under test */
async function queueAndApprove(serverId: string, text: string): Promise<string> {
  const before = new Set((await rowsFor(serverId, "pending")).map((r) => r.id));
  const out = await call(serverId, text);
  expect(out.kind).toBe("approval_required");
  const fresh = (await rowsFor(serverId, "pending")).filter((r) => !before.has(r.id));
  expect(fresh).toHaveLength(1);
  await approve(fresh[0]!.id);
  return fresh[0]!.id;
}

/** the consent signed for A must not be spent after the target moved: zero contact, row not consumed */
async function expectRefusedWithoutContact(serverId: string, signed: string, text: string) {
  const before = snapshot();
  const out = await call(serverId, text);
  expect(["approval_context_stale", "approval_required"]).toContain(out.kind);
  expect(snapshot()).toEqual(before);
  const [row] = await db.select().from(approvals).where(eq(approvals.id, signed));
  expect(row!.status).not.toBe("consumed");
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });
  await app.listen({ port: 0, host: "127.0.0.1" });
  upstream.A = await startUpstream("A");
  upstream.B = await startUpstream("B");
  callerId = await mkUser(`aer039-caller-${RUN}@example.com`);
  approverId = await mkUser(`aer039-approver-${RUN}@example.com`);
}, 120_000);

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
  await upstream.A.close();
  await upstream.B.close();
});

describe("AER-039 — a consent names its MCP target", () => {
  it("POSITIVE CONTROL: with the target unchanged, the signed consent executes against A exactly once", async () => {
    const serverId = await freshServer("control");
    const signed = await queueAndApprove(serverId, `control-${RUN}`);
    const before = snapshot();
    const out = await call(serverId, `control-${RUN}`);
    expect(out.kind).toBe("allowed");
    expect(snapshot().A.tool - before.A.tool).toBe(1);
    expect(snapshot().B).toEqual(before.B);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, signed));
    expect(row!.status).toBe("consumed");
  });

  it("a URL change through the API leaves the consent unspent; the fresh review binds B, and B runs only once it is approved", async () => {
    const serverId = await freshServer("api");
    const text = `api-${RUN}`;
    const signed = await queueAndApprove(serverId, text);
    const patch = await app.inject({ method: "PATCH", headers: AUTH, url: `/v1/servers/${serverId}`, payload: { url: upstream.B.url } });
    expect(patch.statusCode, patch.body).toBe(200);

    await expectRefusedWithoutContact(serverId, signed, text);

    // the replacement consent is for B: queue it, approve it, and only then does B receive the call
    const pending = await rowsFor(serverId, "pending");
    const fresh = pending.length ? pending[pending.length - 1]! : null;
    const replacement = fresh ? fresh.id : await queueAndApprove(serverId, text);
    if (fresh) await approve(fresh.id);
    const before = snapshot();
    const out = await call(serverId, text);
    expect(out.kind).toBe("allowed");
    expect(snapshot().B.tool - before.B.tool).toBe(1);
    expect(snapshot().A).toEqual(before.A);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, replacement));
    expect(row!.status).toBe("consumed");

    // the queue's audit row names the host the consent was bound to
    const [queued] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, callerId), eq(auditLog.serverId, serverId)))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect((queued!.detail as { target?: { host: string } }).target?.host).toBe(new URL(upstream.B.url).host);
  });

  it("a URL change by direct SQL is caught the same way (no trigger, no route — the digest is the guard)", async () => {
    const serverId = await freshServer("sql");
    const text = `sql-${RUN}`;
    const signed = await queueAndApprove(serverId, text);
    await db.update(mcpServers).set({ url: upstream.B.url }).where(eq(mcpServers.id, serverId));
    await expectRefusedWithoutContact(serverId, signed, text);
  });

  it("a private-range posture change invalidates the consent", async () => {
    const serverId = await freshServer("posture");
    const text = `posture-${RUN}`;
    const signed = await queueAndApprove(serverId, text);
    const [row] = await db.select({ flag: mcpServers.allowPrivateRanges }).from(mcpServers).where(eq(mcpServers.id, serverId));
    await db.update(mcpServers).set({ allowPrivateRanges: row!.flag === true ? false : true }).where(eq(mcpServers.id, serverId));
    await expectRefusedWithoutContact(serverId, signed, text);
  });

  it("admitted-manifest drift invalidates the consent", async () => {
    const serverId = await freshServer("manifest");
    const text = `manifest-${RUN}`;
    const signed = await queueAndApprove(serverId, text);
    await db.update(mcpServers).set({ admissionManifestDigest: "f".repeat(64) }).where(eq(mcpServers.id, serverId));
    await expectRefusedWithoutContact(serverId, signed, text);
  });

  it("BARRIER: a URL change while the signed call is connecting cannot route its bytes to B", async () => {
    const serverId = await freshServer("barrier");
    const text = `barrier-${RUN}`;
    const signed = await queueAndApprove(serverId, text);
    // the evaluation and the connection share one row snapshot: the swap lands mid-handshake
    onFirstHitA = async () => {
      await db.update(mcpServers).set({ url: upstream.B.url }).where(eq(mcpServers.id, serverId));
    };
    const before = snapshot();
    const out = await call(serverId, text);
    expect(onFirstHitA).toBeNull(); // the hook really ran inside A's first request
    expect(out.kind).toBe("allowed");
    expect(snapshot().A.tool - before.A.tool).toBe(1); // the signed target, and only it
    expect(snapshot().B).toEqual(before.B);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, signed));
    expect(row!.status).toBe("consumed");
    // and the next call, against the moved row, needs a fresh consent
    const after = snapshot();
    const again = await call(serverId, text);
    expect(again.kind).toBe("approval_required");
    expect(snapshot()).toEqual(after);
  });

  it("breaker churn on the same row does NOT invalidate the consent", async () => {
    const serverId = await freshServer("breaker");
    const text = `breaker-${RUN}`;
    const signed = await queueAndApprove(serverId, text);
    await db
      .update(mcpServers)
      .set({ breakerConsecutiveFailures: 1, breakerLastFailureAt: new Date() })
      .where(eq(mcpServers.id, serverId));
    const before = snapshot();
    const out = await call(serverId, text);
    expect(out.kind).toBe("allowed");
    expect(snapshot().A.tool - before.A.tool).toBe(1);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, signed));
    expect(row!.status).toBe("consumed");
  });
});
