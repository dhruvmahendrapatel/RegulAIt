/**
 * ADR-0230 slice A2 (gateway part) — SAP business MCP servers, on a real database through the real app:
 *
 *  - marking a server `sap_business` seeds, in one transaction and audited, a write-only fleet approval rule (quorum 2,
 *    the marking admin plus a named role) and a write-only fleet rate limit (10 per user per hour); a second mark is
 *    refused;
 *  - a write to an SAP business server with no project, or an unbudgeted one, is refused (`sap-write-needs-project`),
 *    audited, never reaches the upstream and is never costed; a budgeted write goes to the kernel and is queued for the
 *    quorum approval; a tool the upstream annotates read-only is still a write on a marked server (review #798);
 *  - a write-only rate limit counts and limits write tools only, including a write tool added after the limit;
 *  - unmarking is a settings_relax step-up, audited.
 *
 * Global state (M-068): every org setting this file moves is put back in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  and,
  approvalRules,
  approvals,
  auditLog,
  createDb,
  desc,
  eq,
  mcpServers,
  orgSettings,
  ORG_SETTINGS_ID,
  rateLimits,
  roleAssignments,
  roles,
  runMigrations,
  usageEvents,
  users,
  type Db,
} from "@regulait/db";
import { BATCH4_STRICT_DEFAULTS } from "@regulait/shared";
import { buildApp } from "./app.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";
import { deriveSapIdempotencyKey, SAP_BUSINESS_DEFAULTS, SAP_BUSINESS_RULE_IDS } from "./mcp-sap-business.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";
import { relaxApprovalSigningForTest } from "./testing/approval-signing-posture.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must name a disposable test database");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `sap-boot-${RUN}`;
const boot = { authorization: `Bearer ${BOOT}` };
const WRITE = "create_sales_order";
const READ = "read_sales_order";
const LATE_WRITE = "change_sales_order";
/** 64-hex test-fixture key, the shape secrets.ts asserts. Not a secret. */
const DATA_KEY = "c".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminKey: { authorization: string };
let callerId: string;
let approverB: string;
let roleId: string;
const restores: Array<() => Promise<void>> = [];
const upstreamHits = { tool: 0 };
/** what the double's write tool last received, and what its next result says about the business document */
const upstream = { lastArgs: null as Record<string, unknown> | null, nextDocument: null as Record<string, unknown> | null };
let closeUpstream: () => Promise<void> = async () => {};
let upstreamUrl = "";

async function startUpstream(): Promise<void> {
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      void (async () => {
        const server = new McpServer({ name: "sap-double", version: "0.0.1" });
        for (const [name, readOnly] of [[WRITE, false], [READ, true], [LATE_WRITE, false]] as const) {
          server.registerTool(
            name,
            { description: name, inputSchema: { idempotencyKey: z.string().optional(), quantity: z.number().optional() }, annotations: { readOnlyHint: readOnly } },
            async (a: Record<string, unknown>) => {
              upstreamHits.tool++;
              upstream.lastArgs = a;
              const doc = upstream.nextDocument;
              return { content: [{ type: "text", text: `${name} ran` }], ...(doc ? { structuredContent: { businessDocument: doc } } : {}) };
            },
          );
        }
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
  upstreamUrl = `http://127.0.0.1:${address.port}/`;
  closeUpstream = () =>
    new Promise((resolve) => {
      httpServer.closeAllConnections();
      httpServer.close(() => resolve());
    });
}

async function mkUser(label: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/v1/users", headers: boot, payload: { email: `sap-${label}-${RUN}@example.test`, displayName: `SAP ${label}` } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

/** a server with the three tools in its inventory (kind given, so no manifest sync), granted to the caller */
async function mkServer(label: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/v1/servers", headers: boot, payload: { name: `sap-${label}-${RUN}`, url: upstreamUrl } });
  expect(r.statusCode, r.body).toBe(201);
  const serverId = r.json().id as string;
  await db.update(mcpServers).set({ pricePerCallUsd: 0.01 }).where(eq(mcpServers.id, serverId));
  for (const [name, kind] of [[WRITE, "write"], [READ, "read"]] as const) {
    const t = await app.inject({ method: "POST", url: `/v1/servers/${serverId}/tools`, headers: boot, payload: { name, kind } });
    expect(t.statusCode, t.body).toBeLessThan(300);
    const g = await app.inject({ method: "POST", url: "/v1/grants/tools", headers: boot, payload: { userId: callerId, serverId, toolName: name } });
    expect(g.statusCode, g.body).toBeLessThan(300);
  }
  return serverId;
}

async function mkProject(budgetUsd: number | null): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: boot,
    payload: { name: `sap-project-${crypto.randomUUID()}`, ...(budgetUsd != null ? { budgetUsd, budgetApproverUserId: adminId } : {}) },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

const lastAudit = async (ruleId: string, serverId: string) =>
  (await db.select().from(auditLog).where(and(eq(auditLog.ruleId, ruleId), eq(auditLog.serverId, serverId))).orderBy(desc(auditLog.seq)).limit(1))[0];
const usageCount = async (_serverId: string) =>
  (await db.select({ id: usageEvents.id }).from(usageEvents).where(and(eq(usageEvents.objectType, "mcp_tool"), eq(usageEvents.userId, callerId)))).length;

beforeAll(async () => {
  db = createDb(databaseUrl);
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  restores.push(await relaxStrictAdmissionForTest(db));
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  restores.push(await relaxApprovalSigningForTest(db));
  const [before] = await db.select({ mode: orgSettings.stepUpMode, actions: orgSettings.stepUpActions }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await db.update(orgSettings).set({ stepUpMode: "required", stepUpActions: [...BATCH4_STRICT_DEFAULTS.stepUpActions] }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(async () => {
    await db.update(orgSettings).set({ stepUpMode: before!.mode, stepUpActions: before!.actions }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });
  await startUpstream();
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, retry: { maxAttempts: 1 }, timeouts: { mcpConnectMs: 2000, mcpListToolsMs: 2000, mcpCallToolMs: 2000 } });
  restores.push(await relaxGovernanceGatesForTest(db, { requireMcpAttribution: false }));
  await app.ready();
  adminId = await mkUser("admin");
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
  const key = await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: boot, payload: { name: "sap" } });
  adminKey = { authorization: `Bearer ${key.json().token}` };
  callerId = await mkUser("caller");
  approverB = await mkUser("approver-b");
  const [role] = await db.insert(roles).values({ name: `sap approvers ${RUN}` }).returning({ id: roles.id });
  roleId = role!.id;
  // the caller is in the approver role on purpose: the pool must still exclude them
  for (const u of [approverB, callerId]) await db.insert(roleAssignments).values({ userId: u, roleId });
}, 120_000);

afterAll(async () => {
  for (const restore of restores.reverse()) await restore();
  await app.close();
  await closeUpstream();
});

describe("ADR-0230 A2: an SAP business server is approve-first", () => {
  let serverId: string;

  it("marking seeds a write-only quorum-2 approval rule and a write-only rate limit, in one audited step", async () => {
    serverId = await mkServer("orders");
    const marked = await app.inject({ method: "POST", url: `/v1/servers/${serverId}/system-class`, headers: adminKey, payload: { systemClass: "sap_business", approverRoleId: roleId } });
    expect(marked.statusCode, marked.body).toBe(201);
    expect(marked.json().approvalRule).toMatchObject({
      scope: "fleet",
      serverScope: "server",
      serverId,
      toolName: null,
      writeOnly: true,
      approvalScope: "action",
      quorum: SAP_BUSINESS_DEFAULTS.quorum,
      approverUserId: adminId,
      approverRoleId: roleId,
    });
    expect(marked.json().rateLimit).toMatchObject({ scope: "fleet", serverId, toolName: null, writeOnly: true, maxCalls: 10, windowSeconds: 3600 });
    const [row] = await db.select({ systemClass: mcpServers.systemClass }).from(mcpServers).where(eq(mcpServers.id, serverId));
    expect(row!.systemClass).toBe("sap_business");
    const audit = await lastAudit(SAP_BUSINESS_RULE_IDS.marked, serverId);
    expect(audit?.effect).toBe("allow");
    expect(audit?.detail).toMatchObject({ approvalRuleId: marked.json().approvalRule.id, rateLimitId: marked.json().rateLimit.id });
    const status = await app.inject({ method: "GET", url: `/v1/servers/${serverId}/system-class`, headers: adminKey });
    expect(status.json()).toMatchObject({ systemClass: "sap_business", approvalRuleIds: [marked.json().approvalRule.id], rateLimitIds: [marked.json().rateLimit.id] });
  });

  it("a second mark is refused and seeds nothing more", async () => {
    const again = await app.inject({ method: "POST", url: `/v1/servers/${serverId}/system-class`, headers: adminKey, payload: { systemClass: "sap_business", approverRoleId: roleId } });
    expect(again.statusCode, again.body).toBe(409);
    expect((await db.select().from(approvalRules).where(eq(approvalRules.serverId, serverId))).length).toBe(1);
    expect((await db.select().from(rateLimits).where(eq(rateLimits.serverId, serverId))).length).toBe(1);
  });

  it("refuses an approver pool that cannot reach the quorum, and changes nothing", async () => {
    const lone = await mkServer("lone");
    const [empty] = await db.insert(roles).values({ name: `sap empty ${RUN}` }).returning({ id: roles.id });
    const r = await app.inject({ method: "POST", url: `/v1/servers/${lone}/system-class`, headers: adminKey, payload: { systemClass: "sap_business", approverRoleId: empty!.id } });
    expect(r.statusCode, r.body).toBeGreaterThanOrEqual(400);
    const [row] = await db.select({ systemClass: mcpServers.systemClass }).from(mcpServers).where(eq(mcpServers.id, lone));
    expect(row!.systemClass).toBeNull();
    expect((await db.select().from(rateLimits).where(eq(rateLimits.serverId, lone))).length).toBe(0);
  });

  it("an unattributed write is refused before the upstream, audited and not costed", async () => {
    const hits = upstreamHits.tool;
    const usage = await usageCount(serverId);
    const out = await executeGovernedToolCall(db, DATA_KEY, { userId: callerId, serverId, toolName: WRITE, arguments: {} });
    expect(out.kind).toBe("denied");
    if (out.kind === "denied") expect(out.decision.ruleId).toBe(SAP_BUSINESS_RULE_IDS.needsProject);
    expect(upstreamHits.tool).toBe(hits);
    expect(await usageCount(serverId)).toBe(usage);
    expect((await lastAudit(SAP_BUSINESS_RULE_IDS.needsProject, serverId))?.effect).toBe("deny");
  });

  it("a write attributed to an unbudgeted project is refused too", async () => {
    const projectId = await mkProject(null);
    const out = await executeGovernedToolCall(db, DATA_KEY, { userId: callerId, serverId, toolName: WRITE, projectId, arguments: {} });
    expect(out.kind).toBe("denied");
    if (out.kind === "denied") {
      expect(out.decision.ruleId).toBe(SAP_BUSINESS_RULE_IDS.needsProject);
      expect(out.decision.reason).toContain("no budget");
    }
  });

  it("a budgeted write goes to the kernel and is queued for the quorum approval; the upstream is not called", async () => {
    const projectId = await mkProject(100);
    const hits = upstreamHits.tool;
    const out = await executeGovernedToolCall(db, DATA_KEY, { userId: callerId, serverId, toolName: WRITE, projectId, arguments: { idempotencyKey: crypto.randomUUID() } });
    expect(out.kind).toBe("approval_required");
    expect(upstreamHits.tool).toBe(hits);
  });

  it("review #798: a tool the upstream annotates readOnlyHint=true is still a write on an SAP business server", async () => {
    // READ is annotated read-only by the upstream and stored as kind 'read'; on a marked server that hint is ignored
    const hits = upstreamHits.tool;
    const unattributed = await executeGovernedToolCall(db, DATA_KEY, { userId: callerId, serverId, toolName: READ, arguments: {} });
    expect(unattributed.kind).toBe("denied");
    if (unattributed.kind === "denied") expect(unattributed.decision.ruleId).toBe(SAP_BUSINESS_RULE_IDS.needsProject);
    const projectId = await mkProject(100);
    const queued = await executeGovernedToolCall(db, DATA_KEY, { userId: callerId, serverId, toolName: READ, projectId, arguments: { idempotencyKey: crypto.randomUUID() } });
    expect(queued.kind, JSON.stringify(queued)).toBe("approval_required");
    expect(upstreamHits.tool).toBe(hits);
  });

  it("review #798: a caller with no grant gets the kernel's refusal, not the SAP project requirement", async () => {
    const stranger = await mkUser(`stranger-${crypto.randomUUID().slice(0, 6)}`);
    const out = await executeGovernedToolCall(db, DATA_KEY, { userId: stranger, serverId, toolName: WRITE, arguments: {} });
    expect(out.kind).toBe("denied");
    if (out.kind === "denied") expect(out.decision.ruleId).not.toBe(SAP_BUSINESS_RULE_IDS.needsProject);
  });

  it("unmarking is a settings_relax step-up, audited", async () => {
    const asked = await app.inject({ method: "DELETE", url: `/v1/servers/${serverId}/system-class`, headers: adminKey });
    expect(asked.statusCode, asked.body).toBe(403);
    expect(asked.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    const g = await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts: { serverId, values: { mcpSystemClass: null } } });
    const done = await app.inject({ method: "DELETE", url: `/v1/servers/${serverId}/system-class`, ...stepUpRequest(g) });
    expect(done.statusCode, done.body).toBe(200);
    const [row] = await db.select({ systemClass: mcpServers.systemClass }).from(mcpServers).where(eq(mcpServers.id, serverId));
    expect(row!.systemClass).toBeNull();
    expect((await lastAudit(SAP_BUSINESS_RULE_IDS.unmarked, serverId))?.effect).toBe("allow");
    // the seeded rows stay: they are ordinary rules
    expect((await db.select().from(rateLimits).where(eq(rateLimits.serverId, serverId))).length).toBe(1);
  });

  it("review #798: re-marking reuses the seeded rows still at the defaults instead of seeding a second pair", async () => {
    const again = await app.inject({ method: "POST", url: `/v1/servers/${serverId}/system-class`, headers: adminKey, payload: { systemClass: "sap_business", approverRoleId: roleId } });
    expect(again.statusCode, again.body).toBe(201);
    expect((await db.select().from(approvalRules).where(eq(approvalRules.serverId, serverId))).length).toBe(1);
    expect((await db.select().from(rateLimits).where(eq(rateLimits.serverId, serverId))).length).toBe(1);
    expect((await lastAudit(SAP_BUSINESS_RULE_IDS.marked, serverId))?.detail).toMatchObject({ approvalRuleReused: true, rateLimitReused: true });
  });

  it("review #798: an approver role that does not exist is a clean 4xx, and nothing changes", async () => {
    const other = await mkServer("norole");
    const r = await app.inject({ method: "POST", url: `/v1/servers/${other}/system-class`, headers: adminKey, payload: { systemClass: "sap_business", approverRoleId: crypto.randomUUID() } });
    expect(r.statusCode, r.body).toBeGreaterThanOrEqual(400);
    expect(r.statusCode, r.body).toBeLessThan(500);
    const [row] = await db.select({ systemClass: mcpServers.systemClass }).from(mcpServers).where(eq(mcpServers.id, other));
    expect(row!.systemClass).toBeNull();
    expect((await db.select().from(approvalRules).where(eq(approvalRules.serverId, other))).length).toBe(0);
  });
});

describe("ADR-0230 A2: a write-only rate limit", () => {
  it("counts and limits write tools only, including a write tool added after the limit", async () => {
    const serverId = await mkServer("limits");
    await db.insert(rateLimits).values({ scope: "fleet", serverScope: "server", serverId, toolName: null, writeOnly: true, maxCalls: 1, windowSeconds: 3600 });
    // reads are neither limited nor counted
    for (let i = 0; i < 3; i++) {
      const read = await executeGovernedToolCall(db, DATA_KEY, { userId: callerId, serverId, toolName: READ, arguments: {} });
      expect(read.kind, JSON.stringify(read)).toBe("allowed");
    }
    const first = await executeGovernedToolCall(db, DATA_KEY, { userId: callerId, serverId, toolName: WRITE, arguments: {} });
    expect(first.kind, JSON.stringify(first)).toBe("allowed");
    const second = await executeGovernedToolCall(db, DATA_KEY, { userId: callerId, serverId, toolName: WRITE, arguments: {} });
    expect(second.kind).toBe("denied");
    if (second.kind === "denied") expect(second.decision.reason).toContain("rate limit exhausted");
    // a write tool added after the limit was written is covered by the same row
    const t = await app.inject({ method: "POST", url: `/v1/servers/${serverId}/tools`, headers: boot, payload: { name: LATE_WRITE, kind: "write" } });
    expect(t.statusCode, t.body).toBeLessThan(300);
    await app.inject({ method: "POST", url: "/v1/grants/tools", headers: boot, payload: { userId: callerId, serverId, toolName: LATE_WRITE } });
    const late = await executeGovernedToolCall(db, DATA_KEY, { userId: callerId, serverId, toolName: LATE_WRITE, arguments: {} });
    expect(late.kind).toBe("denied");
    if (late.kind === "denied") expect(late.decision.reason).toContain("rate limit exhausted");
    // and a read still runs
    const read = await executeGovernedToolCall(db, DATA_KEY, { userId: callerId, serverId, toolName: READ, arguments: {} });
    expect(read.kind).toBe("allowed");
  });
});

/** decide an approval through the API as one approver, stepping up when asked */
async function decide(approvalId: string, approverId: string): Promise<void> {
  const url = `/v1/approvals/${approvalId}/decide`;
  const g0 = await grantStepUpForTest(db, approverId, { kind: "approval_decide", facts: { approvalId, decision: "approved" } });
  const r = await app.inject({ method: "POST", url, ...stepUpRequest(g0), payload: { decision: "approved" } });
  if (r.statusCode === 403 && r.json().error === "step_up_required") {
    const g = await grantStepUpForTest(db, approverId, r.json().action);
    const again = await app.inject({ method: "POST", url, ...stepUpRequest(g), payload: { decision: "approved" } });
    expect(again.statusCode, again.body).toBeLessThan(300);
    return;
  }
  expect(r.statusCode, r.body).toBeLessThan(300);
}

describe("ADR-0230 A3: the idempotency key, its approval binding, and the business audit detail", () => {
  let serverId: string;
  let projectId: string;
  const call = (args: Record<string, unknown>) =>
    executeGovernedToolCall(db, DATA_KEY, { userId: callerId, serverId, toolName: WRITE, projectId, arguments: args });

  beforeAll(async () => {
    serverId = await mkServer("a3");
    const marked = await app.inject({ method: "POST", url: `/v1/servers/${serverId}/system-class`, headers: adminKey, payload: { systemClass: "sap_business", approverRoleId: roleId } });
    expect(marked.statusCode, marked.body).toBe(201);
    projectId = await mkProject(100);
  });

  it("two principals with the same caller key get different stored keys; neither is the caller's", () => {
    const k = crypto.randomUUID();
    const server = { id: crypto.randomUUID(), url: "https://sap-mcp.example.test/mcp" };
    const a = deriveSapIdempotencyKey(DATA_KEY, server, crypto.randomUUID(), k);
    const b = deriveSapIdempotencyKey(DATA_KEY, server, crypto.randomUUID(), k);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
    expect(a).not.toBe(k);
    expect(deriveSapIdempotencyKey(undefined, server, crypto.randomUUID(), k)).toBeNull();
  });

  it("a write without a UUID idempotency key is refused before the upstream, audited", async () => {
    const hits = upstreamHits.tool;
    for (const args of [{}, { idempotencyKey: "order-1" }]) {
      const out = await call(args);
      expect(out.kind).toBe("denied");
      if (out.kind === "denied") expect(out.decision.ruleId).toBe(SAP_BUSINESS_RULE_IDS.keyRequired);
    }
    expect(upstreamHits.tool).toBe(hits);
    expect((await lastAudit(SAP_BUSINESS_RULE_IDS.keyRequired, serverId))?.effect).toBe("deny");
  });

  it("an approval for one key cannot authorise another, even under a tool-scoped rule", async () => {
    // relax the seeded rule to 'tool' scope behind the product's back: the SAP binding must hold anyway
    await db.update(approvalRules).set({ approvalScope: "tool" }).where(eq(approvalRules.serverId, serverId));
    const k1 = crypto.randomUUID();
    const queued = await call({ idempotencyKey: k1, quantity: 1 });
    expect(queued.kind, JSON.stringify(queued)).toBe("approval_required");
    if (queued.kind !== "approval_required") return;
    const [row] = await db.select().from(approvals).where(eq(approvals.id, queued.approvalId));
    // the approver sees, and the consent binds, the STORED key; the caller's never reaches the queue
    expect(JSON.stringify(row!.argumentsPreview)).not.toContain(k1);
    await decide(queued.approvalId, adminId);
    await decide(queued.approvalId, approverB);
    // the same fields under another key are not authorised by it
    const other = await call({ idempotencyKey: crypto.randomUUID(), quantity: 1 });
    expect(other.kind, JSON.stringify(other)).toBe("approval_required");
    // the approved key runs, once; the upstream receives the stored key, never the caller's
    upstream.nextDocument = { documentNumber: "4711", replayed: false };
    const hits = upstreamHits.tool;
    const ran = await call({ idempotencyKey: k1, quantity: 1 });
    expect(ran.kind, JSON.stringify(ran)).toBe("allowed");
    expect(upstreamHits.tool).toBe(hits + 1);
    const sent = upstream.lastArgs?.idempotencyKey as string;
    expect(sent).not.toBe(k1);
    expect(sent).toBe(deriveSapIdempotencyKey(DATA_KEY, { id: serverId, url: upstreamUrl }, callerId, k1));
    // the outcome row: service, entity set, the stored key, the approval, the document number
    const outcome = await lastAudit(SAP_BUSINESS_RULE_IDS.outcome, serverId);
    expect(outcome?.detail).toMatchObject({
      approvalId: queued.approvalId,
      sap: { service: "API_SALES_ORDER_SRV", entitySet: "A_SalesOrder", idempotencyKey: sent, documentNumber: "4711", replayed: false, errorCode: null },
    });
    const [usage] = await db.select().from(usageEvents).where(and(eq(usageEvents.userId, callerId), eq(usageEvents.operation, WRITE))).orderBy(desc(usageEvents.at)).limit(1);
    expect(usage!.costUsd).toBe(0.01);
    expect(usage!.detail).toMatchObject({ sap: { documentNumber: "4711", replayed: false } });
  });

  it("a key reused with other fields is refused; a replay is recorded and not charged; SAP error text is never kept", async () => {
    // the approval rule is not what this case is about: removed here so the calls run straight through
    await db.delete(approvalRules).where(eq(approvalRules.serverId, serverId));
    const k = crypto.randomUUID();
    upstream.nextDocument = { documentNumber: "4712", replayed: false };
    expect((await call({ idempotencyKey: k, quantity: 2 })).kind).toBe("allowed");
    const hits = upstreamHits.tool;
    const reused = await call({ idempotencyKey: k, quantity: 3 });
    expect(reused.kind).toBe("denied");
    if (reused.kind === "denied") expect(reused.decision.ruleId).toBe(SAP_BUSINESS_RULE_IDS.keyReused);
    expect(upstreamHits.tool).toBe(hits);
    // the server answers the same key and fields from its store: a replay
    upstream.nextDocument = { documentNumber: "4712", replayed: true };
    expect((await call({ idempotencyKey: k, quantity: 2 })).kind).toBe("allowed");
    const [usage] = await db.select().from(usageEvents).where(and(eq(usageEvents.userId, callerId), eq(usageEvents.operation, WRITE))).orderBy(desc(usageEvents.at)).limit(1);
    expect(usage!.costUsd).toBe(0);
    expect(usage!.detail).toMatchObject({ sap: { replayed: true, documentNumber: "4712" } });
    expect((await lastAudit(SAP_BUSINESS_RULE_IDS.outcome, serverId))?.detail).toMatchObject({ sap: { replayed: true } });
    // an SAP error: the code is kept if it is a code; free text in it is dropped
    upstream.nextDocument = { errorCode: "V1/320", message: "Sold-to party 4711 Main St is blocked" };
    expect((await call({ idempotencyKey: crypto.randomUUID(), quantity: 4 })).kind).toBe("allowed");
    const failed = await lastAudit(SAP_BUSINESS_RULE_IDS.outcome, serverId);
    expect(JSON.stringify(failed?.detail)).not.toContain("Main St");
    expect(failed?.detail).toMatchObject({ sap: { errorCode: null, documentNumber: null } });
    upstream.nextDocument = { errorCode: "V1_320" };
    expect((await call({ idempotencyKey: crypto.randomUUID(), quantity: 5 })).kind).toBe("allowed");
    expect((await lastAudit(SAP_BUSINESS_RULE_IDS.outcome, serverId))?.detail).toMatchObject({ sap: { errorCode: "V1_320" } });
    upstream.nextDocument = null;
  });
});
