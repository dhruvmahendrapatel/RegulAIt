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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  and,
  approvalRules,
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
import { SAP_BUSINESS_DEFAULTS, SAP_BUSINESS_RULE_IDS } from "./mcp-sap-business.js";
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

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminKey: { authorization: string };
let callerId: string;
let approverB: string;
let roleId: string;
const restores: Array<() => Promise<void>> = [];
const upstreamHits = { tool: 0 };
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
          server.registerTool(name, { description: name, inputSchema: {}, annotations: { readOnlyHint: readOnly } }, async () => {
            upstreamHits.tool++;
            return { content: [{ type: "text", text: `${name} ran` }] };
          });
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
  app = buildApp(db, { bootstrapToken: BOOT, retry: { maxAttempts: 1 }, timeouts: { mcpConnectMs: 2000, mcpListToolsMs: 2000, mcpCallToolMs: 2000 } });
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
    const out = await executeGovernedToolCall(db, undefined, { userId: callerId, serverId, toolName: WRITE, arguments: {} });
    expect(out.kind).toBe("denied");
    if (out.kind === "denied") expect(out.decision.ruleId).toBe(SAP_BUSINESS_RULE_IDS.needsProject);
    expect(upstreamHits.tool).toBe(hits);
    expect(await usageCount(serverId)).toBe(usage);
    expect((await lastAudit(SAP_BUSINESS_RULE_IDS.needsProject, serverId))?.effect).toBe("deny");
  });

  it("a write attributed to an unbudgeted project is refused too", async () => {
    const projectId = await mkProject(null);
    const out = await executeGovernedToolCall(db, undefined, { userId: callerId, serverId, toolName: WRITE, projectId, arguments: {} });
    expect(out.kind).toBe("denied");
    if (out.kind === "denied") {
      expect(out.decision.ruleId).toBe(SAP_BUSINESS_RULE_IDS.needsProject);
      expect(out.decision.reason).toContain("no budget");
    }
  });

  it("a budgeted write goes to the kernel and is queued for the quorum approval; the upstream is not called", async () => {
    const projectId = await mkProject(100);
    const hits = upstreamHits.tool;
    const out = await executeGovernedToolCall(db, undefined, { userId: callerId, serverId, toolName: WRITE, projectId, arguments: {} });
    expect(out.kind).toBe("approval_required");
    expect(upstreamHits.tool).toBe(hits);
  });

  it("review #798: a tool the upstream annotates readOnlyHint=true is still a write on an SAP business server", async () => {
    // READ is annotated read-only by the upstream and stored as kind 'read'; on a marked server that hint is ignored
    const hits = upstreamHits.tool;
    const unattributed = await executeGovernedToolCall(db, undefined, { userId: callerId, serverId, toolName: READ, arguments: {} });
    expect(unattributed.kind).toBe("denied");
    if (unattributed.kind === "denied") expect(unattributed.decision.ruleId).toBe(SAP_BUSINESS_RULE_IDS.needsProject);
    const projectId = await mkProject(100);
    const queued = await executeGovernedToolCall(db, undefined, { userId: callerId, serverId, toolName: READ, projectId, arguments: {} });
    expect(queued.kind, JSON.stringify(queued)).toBe("approval_required");
    expect(upstreamHits.tool).toBe(hits);
  });

  it("review #798: a caller with no grant gets the kernel's refusal, not the SAP project requirement", async () => {
    const stranger = await mkUser(`stranger-${crypto.randomUUID().slice(0, 6)}`);
    const out = await executeGovernedToolCall(db, undefined, { userId: stranger, serverId, toolName: WRITE, arguments: {} });
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

  it("security review #798: a deploy-mode-scoped row is never reused as the default; a fresh unscoped pair is seeded", async () => {
    const scoped = await mkServer("scoped");
    await db.insert(approvalRules).values({ scope: "fleet", serverScope: "server", serverId: scoped, toolName: null, writeOnly: true, approvalScope: "action", approverUserId: adminId, approverRoleId: roleId, quorum: 2, deployMode: "byoc" });
    await db.insert(rateLimits).values({ scope: "fleet", serverScope: "server", serverId: scoped, toolName: null, writeOnly: true, maxCalls: 10, windowSeconds: 3600, deployMode: "byoc" });
    const r = await app.inject({ method: "POST", url: `/v1/servers/${scoped}/system-class`, headers: adminKey, payload: { systemClass: "sap_business", approverRoleId: roleId } });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().approvalRule.deployMode).toBeNull();
    expect(r.json().rateLimit.deployMode).toBeNull();
    expect((await lastAudit(SAP_BUSINESS_RULE_IDS.marked, scoped))?.detail).toMatchObject({ approvalRuleReused: false, rateLimitReused: false });
  });

  it("security review #798: a re-mark naming another approver role seeds a fresh rule, and the audit names the pool in force", async () => {
    const [other] = await db.insert(roles).values({ name: `sap approvers 2 ${RUN}` }).returning({ id: roles.id });
    for (const u of [approverB]) await db.insert(roleAssignments).values({ userId: u, roleId: other!.id });
    const off = await app.inject({ method: "DELETE", url: `/v1/servers/${serverId}/system-class`, ...stepUpRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts: { serverId, values: { mcpSystemClass: null } } })) });
    expect(off.statusCode, off.body).toBe(200);
    const r = await app.inject({ method: "POST", url: `/v1/servers/${serverId}/system-class`, headers: adminKey, payload: { systemClass: "sap_business", approverRoleId: other!.id } });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().approvalRule.approverRoleId).toBe(other!.id);
    const audit = await lastAudit(SAP_BUSINESS_RULE_IDS.marked, serverId);
    expect(audit?.detail).toMatchObject({ approvalRuleReused: false, rateLimitReused: true, approverRoleId: other!.id, approverUserId: adminId });
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
      const read = await executeGovernedToolCall(db, undefined, { userId: callerId, serverId, toolName: READ, arguments: {} });
      expect(read.kind, JSON.stringify(read)).toBe("allowed");
    }
    const first = await executeGovernedToolCall(db, undefined, { userId: callerId, serverId, toolName: WRITE, arguments: {} });
    expect(first.kind, JSON.stringify(first)).toBe("allowed");
    const second = await executeGovernedToolCall(db, undefined, { userId: callerId, serverId, toolName: WRITE, arguments: {} });
    expect(second.kind).toBe("denied");
    if (second.kind === "denied") expect(second.decision.reason).toContain("rate limit exhausted");
    // a write tool added after the limit was written is covered by the same row
    const t = await app.inject({ method: "POST", url: `/v1/servers/${serverId}/tools`, headers: boot, payload: { name: LATE_WRITE, kind: "write" } });
    expect(t.statusCode, t.body).toBeLessThan(300);
    await app.inject({ method: "POST", url: "/v1/grants/tools", headers: boot, payload: { userId: callerId, serverId, toolName: LATE_WRITE } });
    const late = await executeGovernedToolCall(db, undefined, { userId: callerId, serverId, toolName: LATE_WRITE, arguments: {} });
    expect(late.kind).toBe("denied");
    if (late.kind === "denied") expect(late.decision.reason).toContain("rate limit exhausted");
    // and a read still runs
    const read = await executeGovernedToolCall(db, undefined, { userId: callerId, serverId, toolName: READ, arguments: {} });
    expect(read.kind).toBe("allowed");
  });
});
