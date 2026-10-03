import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { and, approvals, auditLog, createDb, dataScopeRules, eq, mcpTools, orgSettings, runMigrations, sql, traceSpans, usageEvents, type Db } from "@regulait/db";
import { approvalArgumentsDigest } from "@regulait/shared";
import { buildApp } from "./app.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";
import { beginTrace, type TraceContext } from "./tracing.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const RUN = Math.random().toString(36).slice(2, 8);
const AUTH = { authorization: "Bearer mcp-redaction-bootstrap" };
const RAW = "alice@example.test";
const SAFE = "[EMAIL]";
const inputSchema: Tool["inputSchema"] = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
let db: Db;
let app: ReturnType<typeof buildApp>;
let httpServer: http.Server;
let serverId: string;
let callerId: string;
let approverId: string;
let sequence = 0;
let wireCalls: Record<string, unknown>[] = [];
let onInitialize: (() => Promise<void>) | undefined;
let onCall: (() => Promise<void>) | undefined;
let response: CallToolResult | undefined;
let upstreamError: string | undefined;
const manifest = new Map<string, Tool>();

async function post(url: string, payload: unknown) {
  const result = await app.inject({ method: "POST", url, headers: AUTH, payload: payload as Record<string, unknown> });
  expect(result.statusCode, result.body).toBe(201);
  return result.json();
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  app = buildApp(db, { bootstrapToken: "mcp-redaction-bootstrap", dataKey: "a".repeat(64) });
  httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => void (async () => {
      const request = body ? JSON.parse(body) : undefined;
      if (request?.method === "initialize" && onInitialize) {
        const hook = onInitialize;
        onInitialize = undefined;
        await hook();
      }
      const server = new Server({ name: "redaction-test", version: "1" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...manifest.values()] }));
      server.setRequestHandler(CallToolRequestSchema, async (call) => {
        wireCalls.push(structuredClone(call.params.arguments ?? {}));
        if (onCall) await onCall();
        if (upstreamError) throw new Error(upstreamError);
        return response ?? { content: [{ type: "text", text: JSON.stringify(call.params.arguments) }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, request);
    })().catch(() => { if (!res.headersSent) res.writeHead(500).end(); }));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("missing test upstream address");
  serverId = (await post("/v1/servers", { name: `redact-${RUN}`, url: `http://127.0.0.1:${address.port}/` })).id;
  callerId = (await post("/v1/users", { email: `redact-caller-${RUN}@example.test`, displayName: "Redaction caller" })).id;
  approverId = (await post("/v1/users", { email: `redact-approver-${RUN}@example.test`, displayName: "Redaction approver" })).id;
});

beforeEach(() => { wireCalls = []; response = undefined; upstreamError = undefined; onInitialize = undefined; onCall = undefined; });
afterAll(async () => {
  await app?.close();
  httpServer?.closeAllConnections();
  if (httpServer) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

async function fixture(needsApproval = true) {
  const name = `redact_${RUN}_${++sequence}`;
  manifest.set(name, { name, inputSchema, annotations: { readOnlyHint: true } });
  await post(`/v1/servers/${serverId}/tools`, { name, kind: "read" });
  await db.update(mcpTools).set({ inputSchema }).where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, name)));
  await post("/v1/grants/tools", { userId: callerId, serverId, toolName: name });
  if (needsApproval) await post("/v1/rules/approvals", { userId: callerId, serverId, toolName: name, approverUserId: approverId, approvalScope: "tool" });
  await post("/v1/compliance/profiles", { tag: name, piiMode: "warn" });
  // Internal integration fixture ONLY. Public config intentionally rejects redact.
  await db.execute(sql`update compliance_profiles set pii_mode = 'redact' where tag = ${name}`);
  const projectId = (await post("/v1/projects", { name, classifications: [name] })).id as string;
  const call = (args: Record<string, unknown> = { text: RAW }, trace?: TraceContext | null) => executeGovernedToolCall(db, undefined, {
    userId: callerId, serverId, toolName: name, projectId, arguments: args, trace,
  });
  const mode = (value: string) => db.execute(sql`update compliance_profiles set pii_mode = ${value} where tag = ${name}`);
  const schema = (value: Record<string, unknown> | null) => db.update(mcpTools).set({ inputSchema: value }).where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, name)));
  return { name, projectId, call, mode, schema };
}

async function approve(f: Awaited<ReturnType<typeof fixture>>, args = { text: RAW }) {
  const queued = await f.call(args);
  expect(queued.kind).toBe("approval_required");
  if (queued.kind !== "approval_required") throw new Error("not queued");
  await db.update(approvals).set({ status: "approved", decidedBy: approverId, decidedAt: new Date() }).where(eq(approvals.id, queued.approvalId));
  return queued.approvalId;
}

describe("MCP redacted execution, real upstream and database", () => {
  it("queues a safe preview, forces exact scope, sends the approved snapshot and records no raw PII", async () => {
    const f = await fixture();
    const trace = await beginTrace(db, { kind: "tool", name: f.name, userId: callerId, projectId: f.projectId }, { enabled: true, captureContent: true, previewMaxChars: 4000 });
    expect(trace).not.toBeNull();
    const queued = await f.call({ text: RAW }, trace);
    expect(queued.kind).toBe("approval_required");
    if (queued.kind !== "approval_required") throw new Error("not queued");
    const [row] = await db.select().from(approvals).where(eq(approvals.id, queued.approvalId));
    expect(row).toMatchObject({ argumentsPreviewKind: "mcp_redacted_v1", approvalScope: "action", projectId: f.projectId });
    const queueView = await app.inject({ method: "GET", url: "/v1/approvals?status=pending", headers: AUTH });
    expect(queueView.statusCode).toBe(200);
    const presented = queueView.json().approvals.find((item: { id: string }) => item.id === row!.id);
    expect(presented).toMatchObject({ argumentsPreviewKind: "mcp_redacted_v1", approvalScope: "action", projectName: f.name, serverName: `redact-${RUN}` });
    expect(JSON.stringify(row!.argumentsPreview)).toContain(SAFE);
    expect(JSON.stringify(row!.argumentsPreview)).not.toContain(RAW);
    expect(row!.argumentsDigest).not.toBe(approvalArgumentsDigest({ projectId: f.projectId, arguments: { text: RAW } }));
    await db.update(approvals).set({ status: "approved" }).where(eq(approvals.id, row!.id));
    expect((await f.call({ text: "bob@example.test" })).kind).toBe("approval_required");
    expect(wireCalls).toHaveLength(0);
    response = { content: [{ type: "text", text: "contact bob@example.test" }], structuredContent: { email: RAW } };
    const ran = await f.call({ text: RAW }, trace);
    expect(ran.kind).toBe("allowed");
    expect(wireCalls).toEqual([{ text: SAFE }]);
    expect(JSON.stringify(ran)).toContain(SAFE);
    expect(JSON.stringify(ran)).not.toContain(RAW);
    const spans = await db.select().from(traceSpans).where(eq(traceSpans.traceId, trace!.traceId));
    expect(spans).toHaveLength(2);
    expect(spans.every((span) => span.inputPreview?.includes(SAFE))).toBe(true);
    const ledger = await db.select().from(auditLog).where(eq(auditLog.toolName, f.name));
    expect(ledger.length).toBeGreaterThan(0);
    expect(JSON.stringify([spans, ledger])).not.toContain(RAW);
    expect((await db.select().from(approvals).where(eq(approvals.id, row!.id)))[0]!.status).toBe("consumed");
  });

  it("one approval executes once under concurrency", async () => {
    const f = await fixture();
    await approve(f);
    const outcomes = await Promise.all([f.call(), f.call()]);
    expect(outcomes.filter((outcome) => outcome.kind === "allowed")).toHaveLength(1);
    expect(wireCalls).toEqual([{ text: SAFE }]);
  });

  it.each(["schema", "mode", "halt"])("does not consume or send if %s changes during connection", async (change) => {
    const f = await fixture();
    const id = await approve(f);
    onInitialize = async () => {
      if (change === "schema") await f.schema({ ...inputSchema, description: "changed during connection" });
      else if (change === "mode") await f.mode("block");
      else await db.execute(sql`update mcp_tools set halted_at = now(), halted_reason = 'test halt' where server_id = ${serverId} and name = ${f.name}`);
    };
    expect((await f.call()).kind).toBe("denied");
    expect(wireCalls).toHaveLength(0);
    expect((await db.select().from(approvals).where(eq(approvals.id, id)))[0]!.status).toBe("approved");
  });

  it("schema change between approval and retry requires fresh consent", async () => {
    const f = await fixture();
    await approve(f);
    await f.schema({ ...inputSchema, description: "a new contract" });
    expect((await f.call()).kind).toBe("approval_required");
    expect(wireCalls).toHaveLength(0);
  });

  it("legacy raw-only consent cannot authorize redaction, even under a tool-scoped rule", async () => {
    const f = await fixture();
    const id = await approve(f);
    await db.update(approvals).set({ argumentsDigest: approvalArgumentsDigest({ projectId: f.projectId, arguments: { text: RAW } }) }).where(eq(approvals.id, id));
    expect((await f.call()).kind).toBe("approval_required");
    expect(wireCalls).toHaveLength(0);
  });

  it("caller mutation during connection cannot change approved bytes", async () => {
    const f = await fixture();
    await approve(f);
    const args = { text: RAW };
    onInitialize = async () => { args.text = "different@example.test"; };
    expect((await f.call(args)).kind).toBe("allowed");
    expect(args.text).toBe("different@example.test");
    expect(wireCalls).toEqual([{ text: SAFE }]);
  });

  it("a new data-scope restriction during connection refuses even without an approval rule", async () => {
    const f = await fixture(false);
    onInitialize = async () => {
      await db.insert(dataScopeRules).values({ userId: callerId, serverId, toolName: f.name, argPath: "text", allowedValues: ["different"] });
    };
    expect((await f.call()).kind).toBe("denied");
    expect(wireCalls).toHaveLength(0);
  });

  it("category-policy changes invalidate consent even when the effective bytes are unchanged", async () => {
    const f = await fixture();
    const [settings] = await db.select().from(orgSettings);
    const id = await approve(f);
    try {
      await db.update(orgSettings).set({ piiInternationalCategories: ["nino"] });
      expect((await f.call()).kind).toBe("approval_required");
      expect(wireCalls).toHaveLength(0);
      expect((await db.select().from(approvals).where(eq(approvals.id, id)))[0]!.status).toBe("approved");
    } finally {
      await db.update(orgSettings).set({ piiInternationalCategories: settings!.piiInternationalCategories });
    }
  });

  it("a newly discovered manifest persists its schema, then prepares a fresh evaluation", async () => {
    const f = await fixture();
    await db.delete(mcpTools).where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, f.name)));
    expect((await f.call()).kind).toBe("denied");
    const [stored] = await db.select().from(mcpTools).where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, f.name)));
    expect(stored!.inputSchema).toEqual(inputSchema);
    expect((await f.call()).kind).toBe("approval_required");
    expect(wireCalls).toHaveLength(0);
  });

  it.each([null, { type: "object", properties: { text: { type: "string", format: "email" } } }])("does not queue or send incompatible schemas: %j", async (schema) => {
    const f = await fixture();
    await f.schema(schema);
    expect((await f.call()).kind).toBe("denied");
    expect(wireCalls).toHaveLength(0);
    expect(await db.select().from(approvals).where(eq(approvals.toolName, f.name))).toHaveLength(0);
  });

  it.each([{ allowedValues: [RAW] }, { allowedValues: [SAFE] }])("both original and effective arguments must satisfy data scopes: %j", async ({ allowedValues }) => {
    const f = await fixture(false);
    await db.insert(dataScopeRules).values({ userId: callerId, serverId, toolName: f.name, argPath: "text", allowedValues });
    const result = await f.call();
    expect(result.kind).toBe("denied");
    expect(JSON.stringify(result)).not.toContain(RAW);
    expect(wireCalls).toHaveLength(0);
  });

  it("allows both argument forms when scope explicitly permits both", async () => {
    const f = await fixture(false);
    await db.insert(dataScopeRules).values({ userId: callerId, serverId, toolName: f.name, argPath: "text", allowedValues: [RAW, SAFE] });
    expect((await f.call()).kind).toBe("allowed");
    expect(wireCalls).toEqual([{ text: SAFE }]);
  });

  it("withholds opaque output but still meters the completed call", async () => {
    const f = await fixture(false);
    response = { content: [{ type: "image", data: "YWxpY2VAZXhhbXBsZS50ZXN0", mimeType: "image/png" }] };
    const result = await f.call();
    expect(result.kind).toBe("allowed");
    if (result.kind !== "allowed") throw new Error("not executed");
    expect(result.pii?.withheld).toBe(true);
    expect(JSON.stringify(result.content)).toContain("output withheld");
    expect(JSON.stringify(result.content)).not.toContain("YWxpY2VA");
    expect(wireCalls).toHaveLength(1);
    expect(await db.select().from(usageEvents).where(eq(usageEvents.projectId, f.projectId))).toHaveLength(1);
  });

  it("output policy tightened during the call withholds the response", async () => {
    const f = await fixture(false);
    onCall = async () => { await f.mode("block"); };
    response = { content: [{ type: "text", text: RAW }] };
    const result = await f.call();
    expect(result.kind === "allowed" && result.pii?.withheld).toBe(true);
    expect(JSON.stringify(result)).not.toContain(RAW);
    expect(wireCalls).toHaveLength(1);
  });

  it("sanitizes upstream errors rather than persisting or returning their PII", async () => {
    const f = await fixture(false);
    upstreamError = `upstream failed for ${RAW}`;
    await expect(f.call()).rejects.toThrow("MCP upstream call failed under PII redaction");
    expect(wireCalls).toHaveLength(1);
    const ledger = await db.select().from(auditLog).where(eq(auditLog.toolName, f.name));
    expect(ledger.length).toBeGreaterThan(0);
    expect(JSON.stringify(ledger)).not.toContain(RAW);
  });

  it("failed preparation never captures an unsafe input in its trace", async () => {
    const f = await fixture(false);
    const trace = await beginTrace(db, { kind: "tool", name: f.name, userId: callerId }, { enabled: true, captureContent: true, previewMaxChars: 4000 });
    expect(trace).not.toBeNull();
    expect((await f.call({ [RAW]: "unsafe key" }, trace)).kind).toBe("denied");
    const spans = await db.select().from(traceSpans).where(eq(traceSpans.traceId, trace!.traceId));
    expect(spans).toHaveLength(1);
    expect(spans[0]!.inputPreview).toBeNull();
    expect(JSON.stringify(spans)).not.toContain(RAW);
    expect(wireCalls).toHaveLength(0);
  });

  it("public configuration still refuses this incomplete feature", async () => {
    const result = await app.inject({ method: "POST", url: "/v1/compliance/profiles", headers: AUTH, payload: { tag: `public-${RUN}`, piiMode: "redact" } });
    expect(result.statusCode).toBe(400);
  });

  it("new MCP rows preserve project attribution for the bulk sensitivity fence", async () => {
    const f = await fixture();
    await f.mode("block");
    const queued = await f.call({ text: "clean" });
    expect(queued.kind).toBe("approval_required");
    if (queued.kind !== "approval_required") throw new Error("not queued");
    const key = await post(`/v1/users/${approverId}/keys`, { name: "bulk-review-test" });
    const bulk = await app.inject({ method: "POST", url: "/v1/approvals/bulk", headers: { authorization: `Bearer ${key.token}` },
      payload: { approvalIds: [queued.approvalId], decision: "approved", reason: "test sensitivity attribution" } });
    expect(bulk.statusCode).toBe(207);
    expect(bulk.json().results).toContainEqual(expect.objectContaining({ approvalId: queued.approvalId, error: "bulk_forbidden_sensitive", ok: false }));
    expect((await db.select().from(approvals).where(eq(approvals.id, queued.approvalId)))[0]!.status).toBe("pending");
  });

  it("unknown historical review metadata is not reused for a fresh pending request", async () => {
    const f = await fixture();
    const first = await f.call();
    if (first.kind !== "approval_required") throw new Error("not queued");
    await db.update(approvals).set({ argumentsPreviewKind: null, approvalScope: null }).where(eq(approvals.id, first.approvalId));
    const fresh = await f.call();
    expect(fresh.kind).toBe("approval_required");
    if (fresh.kind !== "approval_required") throw new Error("not queued");
    expect(fresh.approvalId).not.toBe(first.approvalId);
    expect((await db.select().from(approvals).where(eq(approvals.id, fresh.approvalId)))[0]!.argumentsPreviewKind).toBe("mcp_redacted_v1");
  });
});
