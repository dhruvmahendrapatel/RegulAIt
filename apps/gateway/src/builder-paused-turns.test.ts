/**
 * ADR-0173 review fixes — a paused builder turn binds to the tool it paused
 * on, can always be got out of, and finishes where it started.
 *
 *   1. "Ask first" consent and the step record bind to THE tool (kind + id):
 *      a resume never runs a different tool that has since taken the name,
 *      and names are deterministic (a clash hashes every clashing name).
 *   2. A paused thread is never stuck: a deny always goes through, an approve
 *      that hits the agent gate ends the step, the thread's person (or an
 *      admin) can cancel, a lapsed approval ends on read, an exception in the
 *      resumed run ends the step, and the pause is written atomically.
 *   3. A resumed CHANNEL turn is posted back into its Slack thread, with an
 *      absolute link under the SPA's /ui base.
 *   4. Deciding an approval does not run the resumed turn inside the
 *      approver's request.
 *   7. A channel reply is escaped for Slack.
 *
 * One local HTTP server plays both the MCP upstream (every tool counts its
 * own invocations — the honest proof a call did or did not run) and Slack (a
 * reply "posted" is a body that reached the socket).
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  and,
  approvals,
  auditLog,
  builderAgents,
  builderChannelThreads,
  builderThreads,
  builderToolSteps,
  chatopsConnections,
  connectorCredentials,
  connectors,
  egressAllowHosts,
  eq,
  inArray,
  sql,
} from "@regulait/db";
import { escapeSlackText, slackSignature } from "@regulait/shared";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { relaxDataPostureForTest } from "./testing/strict-data-posture.js";
import { backgroundWorkInFlight, drainBackgroundWork } from "./background-work.js";
import { resolveToolbox, toolNames } from "./builder-tools.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";

// ADR-0181: this file pins behaviour against a LOCAL MCP double (127.0.0.1, registered
// seconds ago), not the strict admission defaults — relaxed explicitly, restored after.
let restoreStrictAdmission: (() => Promise<void>) | undefined;

let k: BuilderKit;
let owner: Person;
let admin: Person;
let approver: Person;
let model = "";
let serverId = "";
let serverName = "";
let base = "";
let upstream: http.Server;

const TOOLS = ["dup.x", "dup_x", "plain", "needs_approval", "slow", "evil", "expiring"] as const;
type ToolName = (typeof TOOLS)[number];
const hits: Record<string, number> = {};
const toolIds: Partial<Record<ToolName, string>> = {};
const grantIds: Record<string, string> = {};
/** when set, the `slow` tool waits for it before answering */
let slowGate: Promise<void> | null = null;

const posted: Array<{ url: string; body: Record<string, any> }> = [];
const SECRET = "paused-turns-signing-secret";
const CHANNEL = "C-PAUSED";
let slackConn = "";
let createdEgressEntry = false;
const connectionIds: string[] = [];
const connectorIds: string[] = [];
let seq = 0;

const hit = (t: ToolName) => hits[t] ?? 0;
const plainName = (t: string) => `${serverName}__${t.replace(/[^a-z0-9_-]+/g, "_")}`;

function mcp(): McpServer {
  const s = new McpServer({ name: "paused-turns", version: "0.0.1" });
  for (const name of TOOLS) {
    s.registerTool(name, { description: name, inputSchema: {}, annotations: { readOnlyHint: true } }, async () => {
      if (name === "slow" && slowGate) await slowGate;
      hits[name] = (hits[name] ?? 0) + 1;
      const text = name === "evil" ? "<!channel> read <https://evil.example|the policy> & <@U999>" : `${name} ran`;
      return { content: [{ type: "text", text }] };
    });
  }
  return s;
}

const grantTool = async (userId: string, t: ToolName) => {
  const g = await k.req("POST", "/v1/grants/tools", k.BOOT, { userId, serverId, toolName: t });
  expect(g.statusCode, g.body).toBeLessThan(300);
  grantIds[`${userId}:${t}`] = g.json().id;
};

const setTools = async (who: Person, agentId: string, tools: Array<{ tool: ToolName; askFirst?: boolean }>) => {
  const t = await k.req("PUT", `/v1/builder/agents/${agentId}/tools`, who.auth, {
    tools: tools.map((x) => ({ kind: "mcp_tool", refId: toolIds[x.tool], requiresApproval: !!x.askFirst })),
  });
  expect(t.statusCode, t.body).toBe(200);
};

const newAgent = async (who: Person, tools: Array<{ tool: ToolName; askFirst?: boolean }>, extra: Record<string, unknown> = {}) => {
  const r = await k.req("POST", "/v1/builder/agents", who.auth, {
    name: `Paused ${Math.random().toString(36).slice(2, 7)}`,
    connectionFormat: "shared",
    computerUse: false,
    modelAgentId: model,
    projectId: owner.projectId,
  });
  expect(r.statusCode, r.body).toBe(201);
  const id = r.json().agent.id as string;
  if (Object.keys(extra).length) {
    const p = await k.req("PATCH", `/v1/builder/agents/${id}`, who.auth, extra);
    expect(p.statusCode, p.body).toBe(200);
  }
  if (tools.length) await setTools(who, id, tools);
  return id;
};

const chat = (who: Person, agentId: string, message: string, threadId?: string) =>
  k.req("POST", `/v1/builder/agents/${agentId}/chat`, who.auth, { message, ...(threadId ? { threadId } : {}) });
const confirm = (who: Person, threadId: string, stepId: string, decision: "approve" | "deny") =>
  k.req("POST", `/v1/builder/threads/${threadId}/steps/${stepId}/confirm`, who.auth, { decision });
const cancel = (who: Person | { auth: Record<string, string> }, threadId: string, stepId: string) =>
  k.req("POST", `/v1/builder/threads/${threadId}/steps/${stepId}/cancel`, who.auth, {});
const stepRow = async (id: string) => (await k.db.select().from(builderToolSteps).where(eq(builderToolSteps.id, id)))[0]!;
const threadRow = async (id: string) => (await k.db.select().from(builderThreads).where(eq(builderThreads.id, id)))[0]!;

/** a person who may use the owner's shared agents: model + tool grants and a
 * seat on the owner's project (shared agents bill there) */
async function colleague(label: string, tools: ToolName[]) {
  const p = await k.person(label);
  await k.grantModel(p.id, model);
  for (const t of tools) await grantTool(p.id, t);
  const m = await k.req("POST", `/v1/projects/${owner.projectId}/members`, k.BOOT, { userId: p.id, role: "contributor" });
  expect(m.statusCode, m.body).toBeLessThan(300);
  return p;
}

let restoreSb1Posture: (() => Promise<void>) | undefined;
beforeAll(async () => {
  k = await builderKit("bld-pause");
  restoreSb2Gates = await relaxGovernanceGatesForTest(k.db, { mrmEnforced: false, dispatchAttributionRequired: false, requireMcpAttribution: false });
  restoreStrictAdmission = await relaxStrictAdmissionForTest(k.db);
  // ADR-0181: the org PII floor ships at block, and a block-mode reply is withheld from
  // chat. This file pins the channel round trip, so the floor is set off explicitly.
  restoreSb1Posture = await relaxDataPostureForTest(k.db, { org: { defaultPiiMode: "none" }, interception: false, guardrails: false });
  owner = await k.person("owner");
  admin = await k.person("admin", { admin: true });
  approver = await k.person("approver");
  model = await k.model("pause", { price: 1 });
  await k.grantModel(owner.id, model);

  upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = req.url ?? "";
      if (url.startsWith("/mcp")) {
        void (async () => {
          const s = mcp();
          const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          await s.connect(t);
          await t.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
        })().catch(() => {
          if (!res.headersSent) res.writeHead(500).end();
        });
        return;
      }
      let body: Record<string, any> = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        body = { raw };
      }
      posted.push({ url, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ts: `1786.${posted.length}` }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const addr = upstream.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}`;

  serverName = `bp${k.RUN}`;
  const s = await k.req("POST", "/v1/servers", k.BOOT, { name: serverName, url: `${base}/mcp/` });
  expect(s.statusCode, s.body).toBeLessThan(300);
  serverId = s.json().id;
  for (const t of TOOLS) {
    const r = await k.req("POST", `/v1/servers/${serverId}/tools`, k.BOOT, { name: t, kind: "read", description: t });
    expect(r.statusCode, r.body).toBe(201);
    toolIds[t] = r.json().id;
    await grantTool(owner.id, t);
  }
  const rule = await k.req("POST", "/v1/rules/approvals", k.BOOT, { userId: owner.id, serverId, toolName: "needs_approval", approverUserId: approver.id });
  expect((await k.req("POST", "/v1/rules/approvals", k.BOOT, { userId: owner.id, serverId, toolName: "expiring", approverUserId: approver.id })).statusCode).toBe(201);
  expect(rule.statusCode, rule.body).toBe(201);
  const slowRule = await k.req("POST", "/v1/rules/approvals", k.BOOT, { userId: owner.id, serverId, toolName: "slow", approverUserId: approver.id });
  expect(slowRule.statusCode, slowRule.body).toBe(201);

  // Slack: the courier posts through the egress guard, which needs 127.0.0.1
  // allowed — added only if absent, removed afterwards only if added here
  const [existing] = await k.db.select().from(egressAllowHosts).where(eq(egressAllowHosts.host, "127.0.0.1"));
  if (!existing) {
    const allow = await k.req("POST", "/v1/egress-allow-hosts", k.BOOT, {
      host: "127.0.0.1",
      allowPrivateRanges: true,
      allowPlaintextHttp: true,
      note: "builder-paused-turns suite: local fake chat platform",
    });
    expect([200, 201]).toContain(allow.statusCode);
    createdEgressEntry = true;
  }
  const conn = await k.req("POST", "/v1/connectors", k.BOOT, { name: `bp-slack-connector-${k.RUN}`, kind: "chat", providerKind: "slack", baseUrl: base });
  expect(conn.statusCode, conn.body).toBe(201);
  connectorIds.push(conn.json().id);
  const cred = await k.req("POST", `/v1/connectors/${conn.json().id}/credential`, k.BOOT, { token: "xoxb-test" });
  expect(cred.statusCode, cred.body).toBeLessThan(300);
  slackConn = `bp-slack-${k.RUN}`;
  const created = await k.req("POST", "/v1/chatops/connections", k.BOOT, {
    name: slackConn, provider: "slack", connectorId: conn.json().id, signingSecret: SECRET, defaultChannel: CHANNEL,
  });
  expect(created.statusCode, created.body).toBe(201);
  connectionIds.push(created.json().id);
  const link = await k.req("POST", "/v1/chatops/identity-links", k.BOOT, {
    connectionName: slackConn, chatUserId: "U-BP-OWNER", email: `bld-pause-owner-${k.RUN}@example.com`,
  });
  expect(link.statusCode, link.body).toBe(201);
}, 120_000);

afterAll(async () => {
  await restoreStrictAdmission?.();
  await restoreSb1Posture?.();
  await drainBackgroundWork(k.db);
  if (connectionIds.length) await k.db.delete(chatopsConnections).where(inArray(chatopsConnections.id, connectionIds));
  if (connectorIds.length) {
    await k.db.delete(connectorCredentials).where(inArray(connectorCredentials.connectorId, connectorIds));
    await k.db.delete(connectors).where(inArray(connectors.id, connectorIds));
  }
  if (createdEgressEntry) await k.db.delete(egressAllowHosts).where(eq(egressAllowHosts.host, "127.0.0.1"));
  upstream.closeAllConnections();
  await new Promise<void>((r) => upstream.close(() => r()));
  await restoreSb2Gates();
  await k.close();
});

// ---------------------------------------------------------------------------
describe("1. a pause binds to THE tool it paused on", () => {
  it("names are deterministic: every clashing name carries its own hash, whatever the row order", () => {
    const a = { kind: "mcp_tool", refId: "11111111-1111-4111-8111-111111111111", base: "srv__dup_x" };
    const b = { kind: "mcp_tool", refId: "22222222-2222-4222-8222-222222222222", base: "srv__dup_x" };
    const c = { kind: "connector", refId: "33333333-3333-4333-8333-333333333333", base: "connector__crm" };
    const one = toolNames([a, b, c]);
    const two = toolNames([c, b, a]);
    expect([...one.entries()].sort()).toEqual([...two.entries()].sort());
    expect(one.get(`mcp_tool:${a.refId}`)).toMatch(/^srv__dup_x_[0-9a-f]{8}$/);
    expect(one.get(`mcp_tool:${b.refId}`)).toMatch(/^srv__dup_x_[0-9a-f]{8}$/);
    expect(one.get(`mcp_tool:${a.refId}`)).not.toBe(one.get(`mcp_tool:${b.refId}`));
    // no clash, no hash
    expect(one.get(`connector:${c.refId}`)).toBe("connector__crm");
    // 64-character cap, hash included
    const long = "x".repeat(80);
    const capped = toolNames([{ ...a, base: long }, { ...b, base: long }]);
    for (const n of capped.values()) expect(n.length).toBeLessThanOrEqual(64);
  });

  it("two tools whose names collide: neither wins the plain name, and revoking one person's grant moves no name", async () => {
    const agentId = await newAgent(owner, [{ tool: "dup.x", askFirst: true }, { tool: "dup_x" }]);
    const [agent] = await k.db.select().from(builderAgents).where(eq(builderAgents.id, agentId));
    const box = await resolveToolbox(k.db, agent!, owner.id);
    const names = new Map(box.entries.map((e) => [e.refId, e.name]));
    expect(names.get(toolIds["dup.x"]!)).toMatch(new RegExp(`^${serverName}__dup_x_[0-9a-f]{8}$`));
    expect(names.get(toolIds["dup_x"]!)).toMatch(new RegExp(`^${serverName}__dup_x_[0-9a-f]{8}$`));
    expect(box.byName.has(plainName("dup_x"))).toBe(false);
    // the model naming the plain name reaches nothing (never "whichever row came first")
    const before = { a: hit("dup.x"), b: hit("dup_x") };
    const r = await chat(owner, agentId, `go <<use-tool:${plainName("dup_x")}>>`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().messages[1].steps[0]).toMatchObject({ status: "refused", outcomeCode: "tool_not_available" });
    expect({ a: hit("dup.x"), b: hit("dup_x") }).toEqual(before);
    // a person who lacks one of the two still sees the other under the SAME name
    const c = await colleague("c1b", ["dup_x"]);
    const theirs = await resolveToolbox(k.db, agent!, c.id);
    expect(theirs.entries.map((e) => [e.refId, e.name])).toEqual([[toolIds["dup_x"]!, names.get(toolIds["dup_x"]!)]]);
  });

  it("a confirmed call whose name now names a DIFFERENT tool is refused on resume; the other tool never runs", async () => {
    const agentId = await newAgent(owner, [{ tool: "dup.x", askFirst: true }]);
    const r = await chat(owner, agentId, `go <<use-tool:${plainName("dup_x")}>>`);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.pending).toMatchObject({ status: "pending_confirmation" });
    expect((await stepRow(body.pending.stepId)).refId).toBe(toolIds["dup.x"]);
    // the editor swaps the toolbox: the plain name now belongs to dup_x
    await setTools(owner, agentId, [{ tool: "dup_x" }]);
    const before = { a: hit("dup.x"), b: hit("dup_x") };
    const ok = await confirm(owner, body.thread.id, body.pending.stepId, "approve");
    expect(ok.statusCode, ok.body).toBe(200);
    expect({ a: hit("dup.x"), b: hit("dup_x") }).toEqual(before);
    const step = await stepRow(body.pending.stepId);
    expect(step).toMatchObject({ status: "refused", outcomeCode: "tool_changed_since_requested", refId: toolIds["dup.x"] });
    expect((await threadRow(body.thread.id)).pendingTurnCiphertext).toBeNull();
  });

  it("a confirmed call whose tool left the toolbox is refused on resume as no longer available", async () => {
    const agentId = await newAgent(owner, [{ tool: "plain", askFirst: true }]);
    const body = (await chat(owner, agentId, `go <<use-tool:${plainName("plain")}>>`)).json();
    expect(body.pending).toMatchObject({ status: "pending_confirmation" });
    await setTools(owner, agentId, []);
    const before = hit("plain");
    const ok = await confirm(owner, body.thread.id, body.pending.stepId, "approve");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(hit("plain")).toBe(before);
    expect(await stepRow(body.pending.stepId)).toMatchObject({ status: "refused", outcomeCode: "tool_no_longer_available" });
  });
});

// ---------------------------------------------------------------------------
describe("2. a paused thread is never stuck", () => {
  it("a DENY goes through even when the agent gate now refuses the person; nothing runs and the thread is free", async () => {
    const c = await colleague("c2a", ["plain"]);
    const agentId = await newAgent(owner, [{ tool: "plain", askFirst: true }], { sharing: "workspace" });
    const body = (await chat(c, agentId, `go <<use-tool:${plainName("plain")}>>`)).json();
    expect(body.pending).toMatchObject({ status: "pending_confirmation" });
    const rm = await k.req("DELETE", `/v1/projects/${owner.projectId}/members/${c.id}`, k.BOOT);
    expect(rm.statusCode, rm.body).toBeLessThan(300);
    const before = hit("plain");
    const deny = await confirm(c, body.thread.id, body.pending.stepId, "deny");
    expect(deny.statusCode, deny.body).toBe(200);
    expect(hit("plain")).toBe(before);
    expect(await stepRow(body.pending.stepId)).toMatchObject({ status: "denied", outcomeCode: "declined_by_user" });
    expect((await threadRow(body.thread.id)).pendingTurnCiphertext).toBeNull();
    expect(deny.json().pending).toBeNull();
    expect(deny.json().messages.at(-1)).toMatchObject({ role: "system" });
    expect(deny.json().messages.at(-1).content).toContain("not_a_project_member");
    // the thread takes messages again (refused for the membership, not for a pause)
    const next = await chat(c, agentId, "hello", body.thread.id);
    expect(next.json().error).not.toBe("thread_waiting_on_tool_step");
  });

  it("an APPROVE the agent gate refuses ends the step and clears the pause; nothing runs", async () => {
    const c = await colleague("c2b", ["plain"]);
    const agentId = await newAgent(owner, [{ tool: "plain", askFirst: true }], { sharing: "workspace" });
    const body = (await chat(c, agentId, `go <<use-tool:${plainName("plain")}>>`)).json();
    expect((await k.req("DELETE", `/v1/projects/${owner.projectId}/members/${c.id}`, k.BOOT)).statusCode).toBeLessThan(300);
    const before = hit("plain");
    const ok = await confirm(c, body.thread.id, body.pending.stepId, "approve");
    expect(ok.statusCode).toBe(403);
    expect(ok.json().error).toBe("not_a_project_member");
    expect(ok.json().pending).toBeNull();
    expect(hit("plain")).toBe(before);
    expect(await stepRow(body.pending.stepId)).toMatchObject({ status: "refused", outcomeCode: "not_a_project_member" });
    expect((await threadRow(body.thread.id)).pendingTurnCiphertext).toBeNull();
    const next = await chat(c, agentId, "hello", body.thread.id);
    expect(next.json().error).not.toBe("thread_waiting_on_tool_step");
  });

  it("an approval nobody decides: the thread's person cancels; the approval is superseded and the thread is free", async () => {
    const agentId = await newAgent(owner, [{ tool: "needs_approval" }]);
    const body = (await chat(owner, agentId, `go <<use-tool:${plainName("needs_approval")}>>`)).json();
    expect(body.pending).toMatchObject({ status: "pending_approval" });
    const approvalId = body.pending.approvalId as string;
    // someone else's thread reads as unknown; an unpaused step is refused
    const stranger = await k.person("stranger");
    expect((await cancel(stranger, body.thread.id, body.pending.stepId)).statusCode).toBe(404);
    const before = hit("needs_approval");
    const auditsBefore = (await k.db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.ruleId, "builder-tool-step-cancelled"))).length;
    const c = await cancel(owner, body.thread.id, body.pending.stepId);
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().pending).toBeNull();
    expect(c.json().messages.at(-1).content).toContain("Cancelled by you");
    expect(await stepRow(body.pending.stepId)).toMatchObject({ status: "refused", outcomeCode: "cancelled_by_user" });
    expect((await threadRow(body.thread.id)).pendingTurnCiphertext).toBeNull();
    const [ap] = await k.db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(ap!.status).toBe("superseded");
    expect((await k.db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.ruleId, "builder-tool-step-cancelled"))).length).toBe(auditsBefore + 1);
    expect((await cancel(owner, body.thread.id, body.pending.stepId)).statusCode).toBe(409);
    // a late decision resumes nothing
    const d = await k.req("POST", `/v1/approvals/${approvalId}/decide`, approver.auth, { decision: "approved" });
    expect(d.statusCode).toBe(409);
    await drainBackgroundWork(k.db);
    expect(hit("needs_approval")).toBe(before);
    const next = await chat(owner, agentId, "hello again", body.thread.id);
    expect(next.statusCode, next.body).toBe(200);
    // (the replayed sentinel makes the mock ask again: leave no pending
    // approval behind for a later identical call to share)
    if (next.json().pending) expect((await cancel(owner, body.thread.id, next.json().pending.stepId)).statusCode).toBe(200);
  });

  it("an admin may cancel someone else's pause (audited as an admin cancel)", async () => {
    const agentId = await newAgent(owner, [{ tool: "plain", askFirst: true }]);
    const body = (await chat(owner, agentId, `go <<use-tool:${plainName("plain")}>>`)).json();
    const c = await cancel(admin, body.thread.id, body.pending.stepId);
    expect(c.statusCode, c.body).toBe(200);
    expect(await stepRow(body.pending.stepId)).toMatchObject({ status: "refused", outcomeCode: "cancelled_by_admin", decidedByUserId: admin.id });
    const [row] = await k.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "builder-tool-step-cancelled"), sql`${auditLog.detail}->>'builderStepId' = ${body.pending.stepId}`));
    expect(row).toMatchObject({ userId: admin.id });
    expect((row!.detail as Record<string, unknown>).byAdmin).toBe(true);
  });

  it("an approval that EXPIRED while pending ends the pause when the thread is read", async () => {
    const agentId = await newAgent(owner, [{ tool: "expiring" }]);
    const body = (await chat(owner, agentId, `go <<use-tool:${plainName("expiring")}>>`)).json();
    expect(body.pending).toMatchObject({ status: "pending_approval" });
    // control: an unexpired pending approval keeps the pause on read
    const still = await k.req("GET", `/v1/builder/threads/${body.thread.id}`, owner.auth);
    expect(still.json().pending).toMatchObject({ status: "pending_approval" });
    await k.db.update(approvals).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(approvals.id, body.pending.approvalId));
    const read = await k.req("GET", `/v1/builder/threads/${body.thread.id}`, owner.auth);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().pending).toBeNull();
    expect(await stepRow(body.pending.stepId)).toMatchObject({ status: "refused", outcomeCode: "approval_expired" });
    expect((await threadRow(body.thread.id)).pendingTurnCiphertext).toBeNull();
    // the dead approval is retired, so the next identical call asks afresh
    const [ap] = await k.db.select().from(approvals).where(eq(approvals.id, body.pending.approvalId));
    expect(ap!.status).toBe("superseded");
    const again = (await chat(owner, agentId, `again <<use-tool:${plainName("expiring")}>>`)).json();
    expect(again.pending).toMatchObject({ status: "pending_approval" });
    expect(again.pending.approvalId).not.toBe(body.pending.approvalId);
  });

  it("an exception in the resumed run puts the step in error and clears the pause", async () => {
    const agentId = await newAgent(owner, [{ tool: "plain", askFirst: true }]);
    const body = (await chat(owner, agentId, `go <<use-tool:${plainName("plain")}>>`)).json();
    const stepId = body.pending.stepId as string;
    // the step cannot be recorded as done: the resumed run throws mid-loop
    const fn = `bp_boom_${k.RUN}`;
    await k.db.execute(sql.raw(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN
      IF NEW.id = '${stepId}' AND NEW.status = 'done' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`));
    await k.db.execute(sql.raw(`CREATE TRIGGER ${fn} BEFORE UPDATE ON builder_tool_steps FOR EACH ROW EXECUTE FUNCTION ${fn}()`));
    try {
      const r = await confirm(owner, body.thread.id, stepId, "approve");
      expect(r.statusCode).toBe(500);
      expect(r.json().error).toBe("resume_failed");
    } finally {
      await k.db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${fn} ON builder_tool_steps`));
      await k.db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${fn}()`));
    }
    expect(await stepRow(stepId)).toMatchObject({ status: "error", outcomeCode: "resume_failed", outcomeDetail: "injected failure" });
    // the audit row says what failed on ONE line, without the query text
    const [failed] = await k.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "builder-tool-step-resume-failed"), sql`${auditLog.detail}->>'builderStepId' = ${stepId}`));
    expect(failed!.reason).toContain("injected failure");
    expect(failed!.reason).not.toMatch(/[\n\r]|update "builder_tool_steps"/);
    expect((await threadRow(body.thread.id)).pendingTurnCiphertext).toBeNull();
    const next = await chat(owner, agentId, "hello", body.thread.id);
    expect(next.statusCode, next.body).toBe(200);
  });

  it("the pause is durable before the step is seen waiting (state and step commit together)", async () => {
    const agentId = await newAgent(owner, [{ tool: "plain", askFirst: true }]);
    // whoever can see a waiting step (a decide hook, a confirm) must find the
    // paused turn already stored: a step visible as pending with no paused
    // state is refused by the database here
    const fn = `bp_atomic_${k.RUN}`;
    await k.db.execute(sql.raw(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN
      IF NEW.agent_id = '${agentId}' AND NEW.status IN ('pending_confirmation','pending_approval')
         AND NOT EXISTS (SELECT 1 FROM builder_threads WHERE id = NEW.thread_id AND pending_turn_ciphertext IS NOT NULL) THEN
        RAISE EXCEPTION 'step pending before its paused state';
      END IF; RETURN NEW; END $$ LANGUAGE plpgsql`));
    await k.db.execute(sql.raw(`CREATE TRIGGER ${fn} AFTER INSERT OR UPDATE ON builder_tool_steps FOR EACH ROW EXECUTE FUNCTION ${fn}()`));
    try {
      const r = await chat(owner, agentId, `go <<use-tool:${plainName("plain")}>>`);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().pending).toMatchObject({ status: "pending_confirmation" });
    } finally {
      await k.db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${fn} ON builder_tool_steps`));
      await k.db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${fn}()`));
    }
  });
});

// ---------------------------------------------------------------------------
describe("4. deciding an approval does not carry the resumed turn", () => {
  it("the decide answers while the resumed tool call is still running; the turn finishes afterwards", async () => {
    const agentId = await newAgent(owner, [{ tool: "slow" }]);
    const body = (await chat(owner, agentId, `go <<use-tool:${plainName("slow")}>>`)).json();
    expect(body.pending).toMatchObject({ status: "pending_approval" });
    let release: () => void = () => {};
    slowGate = new Promise<void>((r) => (release = r));
    const before = hit("slow");
    try {
      const decide = k.req("POST", `/v1/approvals/${body.pending.approvalId}/decide`, approver.auth, { decision: "approved" });
      const first = await Promise.race([decide.then(() => "decide" as const), new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 3000))]);
      expect(first).toBe("decide");
      expect((await decide).statusCode).toBe(200);
      expect(hit("slow")).toBe(before);
      expect(backgroundWorkInFlight(k.db)).toBeGreaterThan(0);
    } finally {
      release();
      slowGate = null;
    }
    await drainBackgroundWork(k.db);
    expect(hit("slow")).toBe(before + 1);
    expect(await stepRow(body.pending.stepId)).toMatchObject({ status: "done", resultPreview: "slow ran" });
  });
});

// ---------------------------------------------------------------------------
describe("3 + 7. channel turns: resumed replies go back, links are absolute, text is escaped", () => {
  let agentId = "";
  const slack = async (text: string, threadTs?: string) => {
    const ts = `${1786000000 + ++seq}.000${seq}`;
    const raw = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: `Ev-bp-${k.RUN}-${ts}`,
      event: { type: "app_mention", user: "U-BP-OWNER", channel: CHANNEL, ts, text: `<@UBOT> ${text}`, ...(threadTs ? { thread_ts: threadTs } : {}) },
    });
    const now = String(Math.floor(Date.now() / 1000));
    const res = await k.app.inject({
      method: "POST",
      url: `/v1/chatops/${slackConn}/events`,
      headers: { "content-type": "application/json", "x-slack-request-timestamp": now, "x-slack-signature": slackSignature(SECRET, now, raw) },
      payload: raw,
    });
    expect(res.statusCode, res.body).toBe(200);
    await drainBackgroundWork(k.db);
    return ts;
  };
  const repliesIn = (ts: string) => posted.filter((p) => p.body.channel === CHANNEL && p.body.thread_ts === ts).map((p) => String(p.body.text));
  const mappedThread = async (ts: string) =>
    (await k.db.select().from(builderChannelThreads).where(and(eq(builderChannelThreads.externalChannelId, CHANNEL), eq(builderChannelThreads.externalThreadId, ts))))[0]!;

  beforeAll(async () => {
    agentId = await newAgent(owner, [{ tool: "plain", askFirst: true }, { tool: "needs_approval" }, { tool: "evil" }]);
    const conn = (await k.db.select().from(chatopsConnections).where(eq(chatopsConnections.name, slackConn)))[0]!;
    const b = await k.req("POST", `/v1/builder/agents/${agentId}/channels`, admin.auth, { provider: "slack", chatopsConnectionId: conn.id });
    expect(b.statusCode, b.body).toBe(201);
    const routed = await k.req("PUT", `/v1/chatops/builder-routes/${b.json().id}`, k.BOOT, { externalChannelId: CHANNEL });
    expect(routed.statusCode, routed.body).toBe(200);
  });

  it("a pause notice links absolutely into /ui; confirming in the web app posts the resumed reply into the Slack thread", async () => {
    const ts = await slack(`please <<use-tool:${plainName("plain")}>>`);
    const map = await mappedThread(ts);
    const link = `http://localhost:80/ui/builder/inbox?tab=all&thread=${map.builderThreadId}`;
    // (Slack text is escaped: the link's `&` travels as `&amp;`, which Slack shows and links as `&`)
    expect(repliesIn(ts)).toEqual([expect.stringContaining(escapeSlackText(`Waiting for your confirmation in RegulAIt before using a tool: ${link}`))]);
    expect(map).toMatchObject({ replyTarget: CHANNEL, replyThreadRef: ts, linkOrigin: "http://localhost:80" });
    const detail = (await k.req("GET", `/v1/builder/threads/${map.builderThreadId}`, owner.auth)).json();
    const before = hit("plain");
    const ok = await confirm(owner, map.builderThreadId, detail.pending.stepId, "approve");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(hit("plain")).toBe(before + 1);
    await drainBackgroundWork(k.db);
    const replies = repliesIn(ts);
    expect(replies).toHaveLength(2);
    expect(replies[1]).toContain("plain ran");
    const [audit] = await k.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "builder-channel-reply-posted"), sql`${auditLog.detail}->>'builderThreadId' = ${map.builderThreadId}`, sql`${auditLog.detail}->>'resumed' = 'true'`));
    expect(audit).toBeTruthy();
  });

  it("while paused, a new message is told how to unblock (link, then confirm or cancel); cancelling posts the outcome back", async () => {
    const ts = await slack(`please <<use-tool:${plainName("plain")}>>`);
    const map = await mappedThread(ts);
    await slack("are you there?", ts);
    const replies = repliesIn(ts);
    expect(replies).toHaveLength(2);
    expect(replies[1]).toContain("waiting on a tool step");
    expect(replies[1]).toContain(escapeSlackText(`http://localhost:80/ui/builder/inbox?tab=all&thread=${map.builderThreadId}`));
    expect(replies[1]).toContain("confirm or cancel");
    const detail = (await k.req("GET", `/v1/builder/threads/${map.builderThreadId}`, owner.auth)).json();
    expect((await cancel(owner, map.builderThreadId, detail.pending.stepId)).statusCode).toBe(200);
    await drainBackgroundWork(k.db);
    expect(repliesIn(ts)).toHaveLength(3);
    expect(repliesIn(ts)[2]).toContain("did not run");
  });

  it("an approval decided in the queue resumes the channel turn and posts its reply", async () => {
    const ts = await slack(`please <<use-tool:${plainName("needs_approval")}>>`);
    expect(repliesIn(ts)[0]).toContain("Waiting for an approval in RegulAIt");
    const map = await mappedThread(ts);
    const detail = (await k.req("GET", `/v1/builder/threads/${map.builderThreadId}`, owner.auth)).json();
    expect(detail.pending, JSON.stringify(detail.messages)).toMatchObject({ status: "pending_approval" });
    const d = await k.req("POST", `/v1/approvals/${detail.pending.approvalId}/decide`, approver.auth, { decision: "approved" });
    expect(d.statusCode, d.body).toBe(200);
    await drainBackgroundWork(k.db);
    expect(repliesIn(ts)).toHaveLength(2);
    expect(repliesIn(ts)[1], JSON.stringify(await stepRow(detail.pending.stepId))).toContain("needs_approval ran");
  });

  it("model output posted to Slack is escaped: no broadcast, no mention, no disguised link", async () => {
    const ts = await slack(`look it up <<use-tool:${plainName("evil")}>>`);
    const [reply] = repliesIn(ts);
    expect(reply).toBeTruthy();
    expect(reply).toContain("&lt;!channel&gt;");
    expect(reply).toContain("&lt;https://evil.example|the policy&gt;");
    expect(reply).toContain("&lt;@U999&gt;");
    expect(reply).toContain(" &amp; ");
    expect(reply).not.toMatch(/<!channel>|<@U999>|<https:/);
    expect(escapeSlackText("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
  });
});
