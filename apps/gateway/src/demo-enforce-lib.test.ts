/**
 * ADR-0202 lane F — the live "Enforce it" beat (`demo:enforce`), both paths, against a REAL listening gateway, a real
 * MCP upstream that counts tool executions, and a local Slack double that records every post.
 *
 * PASS CRITERIA, WRITTEN BEFORE THE RUN (M-023):
 *  1. LIVE, DENY: the revoked tool is refused by the gateway, audited as a deny, and never executed upstream.
 *  2. LIVE, QUEUE: the write is queued for the named approver, and the queued approval is posted to the enabled Slack
 *     workspace through the existing ChatOps route (bytes on the double's socket, and the route's audit row).
 *  3. EXECUTION ONLY AFTER APPROVAL: zero write executions while pending; exactly one after the approver approves.
 *  4. NO EXECUTION ON REJECTION, AND THE REQUESTER CANNOT APPROVE HER OWN CALL: a self-decision is refused, a
 *     rejection by the approver ends the beat, and the write never runs in either case.
 *  5. SIMULATED: with the beat on its fallback, the command asks `POST /v1/evaluate` only. No approval row, no chat
 *     post, no upstream contact; every line it prints is under the "simulated decision" label.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { approvals, auditLog, and, createDb, eq, mcpServers, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { CHATOPS_RULE_IDS } from "./chatops.js";
import { runEnforceBeat, type EnforceBeatOptions } from "./demo-enforce-lib.js";
import { relaxApprovalSigningForTest } from "./testing/approval-signing-posture.js";
import { removeEgressAllowEntry } from "./testing/egress-allow-cleanup.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `lanef-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const REQUESTER_EMAIL = `lanef-dana-${RUN}@example.com`;
const SERVER = `lanef-repo-${RUN}`;
const PROJECT = `lanef-project-${RUN}`;
const SLACK = `lanef-slack-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let gatewayUrl = "";
let requesterId = "";
let requesterKey = "";
let approverKey = "";
let serverId = "";
let slackConnectionId = "";
let loopbackAllowHostId: string | undefined;
let upstream: http.Server;
let slack: http.Server;
const runs = { search_code: 0, write_file: 0 };
let upstreamHits = 0;
const slackPosts: string[] = [];
const restores: Array<() => Promise<void>> = [];

const post = (url: string, payload?: unknown, headers: Record<string, string> = AUTH) =>
  app.inject({ method: "POST", url, headers, ...(payload ? { payload: payload as object } : {}) });

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  return `http://127.0.0.1:${addr.port}`;
}

const beat = (extra: Partial<EnforceBeatOptions> = {}) =>
  runEnforceBeat({
    baseUrl: gatewayUrl,
    bootstrapToken: BOOT,
    isSimulated: async () => false,
    requesterEmail: REQUESTER_EMAIL,
    serverName: SERVER,
    projectName: PROJECT,
    pollMs: 50,
    waitMs: 15_000,
    ...extra,
  });

/** the beat's own pending approval, once the command has queued it */
async function pendingApprovalId(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const [row] = await db
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.userId, requesterId), eq(approvals.toolName, "write_file"), eq(approvals.status, "pending")));
    if (row) return row.id;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the beat never queued its approval");
}
const decide = (approvalId: string, decision: "approved" | "denied", key: string) =>
  post(`/v1/approvals/${approvalId}/decide`, { decision, reason: "lane F test" }, { authorization: `Bearer ${key}` });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxApprovalSigningForTest(db));
  restores.push(await relaxStrictAdmissionForTest(db));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "f".repeat(64) });
  restores.push(await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false }));
  gatewayUrl = await app.listen({ port: 0, host: "127.0.0.1" });

  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        upstreamHits += 1;
        const mcp = new McpServer({ name: `lanef-up-${RUN}`, version: "0.0.1" });
        mcp.registerTool("search_code", { description: "search", inputSchema: { pattern: z.string() }, annotations: { readOnlyHint: true } }, async () => {
          runs.search_code += 1;
          return { content: [{ type: "text", text: "3 matches" }] };
        });
        mcp.registerTool(
          "write_file",
          { description: "write", inputSchema: { path: z.string(), content: z.string(), branch: z.string().optional() } },
          async (a) => {
            runs.write_file += 1;
            return { content: [{ type: "text", text: `committed ${a.path}` }] };
          },
        );
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  const upstreamUrl = await listen(upstream);
  slack = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      slackPosts.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ts: `1785000000.${slackPosts.length}` }));
    });
  });
  const slackUrl = await listen(slack);

  const allow = await relaxStepUpAround(db, () =>
    post("/v1/egress-allow-hosts", { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: "lane F suite: local doubles" }),
  );
  expect([200, 201]).toContain(allow.statusCode);
  loopbackAllowHostId = allow.json().id;

  const mkUser = async (email: string, displayName: string) => {
    const r = await post("/v1/users", { email, displayName });
    expect(r.statusCode).toBe(201);
    const id = r.json().id as string;
    return { id, key: (await post(`/v1/users/${id}/keys`, { name: "lanef" })).json().token as string };
  };
  const requester = await mkUser(REQUESTER_EMAIL, "Dana Lane F");
  requesterId = requester.id;
  requesterKey = requester.key;
  const approver = await mkUser(`lanef-avery-${RUN}@example.com`, "Avery Lane F");
  approverKey = approver.key;

  const s = await post("/v1/servers", { name: SERVER, url: `${upstreamUrl}/` });
  expect(s.statusCode).toBe(201);
  serverId = s.json().id;
  for (const [name, kind] of [["search_code", "read"], ["write_file", "write"]] as const) {
    await post(`/v1/servers/${serverId}/tools`, { name, kind, description: name });
  }
  // the seed's precedence story: a role's read-only baseline, a direct grant for the write, and a per-user
  // revocation that subtracts a ROLE-derived tool (a direct grant would survive it by design)
  const role = await post("/v1/roles", { name: `lanef-role-${RUN}`, description: "lane F read-only baseline" });
  expect(role.statusCode).toBe(201);
  const roleId = role.json().id as string;
  expect((await post(`/v1/roles/${roleId}/grants/servers`, { serverId, readOnlyAll: true })).statusCode).toBeLessThan(300);
  expect((await post(`/v1/users/${requesterId}/roles`, { roleId })).statusCode).toBeLessThan(300);
  expect((await post("/v1/grants/tools", { userId: requesterId, serverId, toolName: "write_file" })).statusCode).toBeLessThan(300);
  expect((await post("/v1/revocations", { userId: requesterId, serverId, toolName: "search_code" })).statusCode).toBeLessThan(300);
  expect(
    (await post("/v1/rules/approvals", { userId: requesterId, serverId, toolName: "write_file", approverUserId: approver.id })).statusCode,
  ).toBeLessThan(300);
  expect((await post("/v1/projects", { name: PROJECT })).statusCode).toBe(201);

  const connector = await post("/v1/connectors", { name: `${SLACK}-connector`, kind: "chat", providerKind: "slack", baseUrl: slackUrl });
  expect(connector.statusCode).toBe(201);
  const connectorId = connector.json().id as string;
  expect([200, 201]).toContain((await post(`/v1/connectors/${connectorId}/credential`, { token: "xoxb-lanef-token" })).statusCode);
  const conn = await post("/v1/chatops/connections", {
    name: SLACK,
    provider: "slack",
    connectorId,
    signingSecret: "lanef-signing-secret",
    defaultChannel: "C-LANEF",
  });
  expect(conn.statusCode).toBe(201);
  slackConnectionId = conn.json().id;
});

afterAll(async () => {
  if (slackConnectionId) await app.inject({ method: "DELETE", url: `/v1/chatops/connections/${slackConnectionId}`, headers: AUTH });
  const loopback = await removeEgressAllowEntry(app, AUTH, { id: loopbackAllowHostId });
  try {
    for (const restore of restores.reverse()) await restore();
    upstream?.closeAllConnections();
    slack?.closeAllConnections();
    await new Promise((r) => upstream?.close(r));
    await new Promise((r) => slack?.close(r));
    app.server.closeAllConnections();
    await app.close();
  } finally {
    loopback.assertRemoved();
  }
});

describe("demo:enforce LIVE", () => {
  it("denies the revoked tool (audited), queues the write for the approver, posts it to Slack, and executes only after approval", async () => {
    const postsBefore = slackPosts.length;
    const running = beat();
    const approvalId = await pendingApprovalId();
    // 3: pending means not executed
    expect(runs.write_file).toBe(0);
    // 4 (self-approval half): the requester cannot decide her own call
    const self = await decide(approvalId, "approved", requesterKey);
    expect(self.statusCode).toBeGreaterThanOrEqual(400);
    expect(runs.write_file).toBe(0);

    expect((await decide(approvalId, "approved", approverKey)).statusCode).toBe(200);
    const r = await running;

    expect(r.outcome).toBe("executed");
    expect(r.exitCode).toBe(0);
    expect(r.approvalId).toBe(approvalId);
    // 1
    expect(runs.search_code).toBe(0);
    expect(r.lines.some((l) => l.includes("search_code   DENIED   Denied by policy:"))).toBe(true);
    expect(r.lines.some((l) => /audit: deny, rule default-deny; her role-server-read-only-all grant is REVOKED/.test(l))).toBe(true);
    expect(r.lines.some((l) => l.includes("MCP error"))).toBe(false);
    const denies = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, requesterId), eq(auditLog.serverId, serverId), eq(auditLog.toolName, "search_code"), eq(auditLog.effect, "deny")));
    expect(denies.length).toBeGreaterThanOrEqual(1);
    // 2
    expect(r.lines.some((l) => l.includes("QUEUED") && l.includes("Avery Lane F"))).toBe(true);
    expect(slackPosts.slice(postsBefore).some((b) => b.includes(approvalId))).toBe(true);
    const mirrored = await db.select().from(auditLog).where(eq(auditLog.ruleId, CHATOPS_RULE_IDS.approvalPosted));
    expect(mirrored.some((row) => (row.detail as Record<string, unknown> | null)?.approvalId === approvalId)).toBe(true);
    expect(r.lines.some((l) => l.includes(`posted to slack '${SLACK}'`))).toBe(true);
    // 3
    expect(runs.write_file).toBe(1);
    const [spent] = await db.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, approvalId));
    expect(spent?.status).toBe("consumed");
  });

  it("executes nothing when the approver rejects", async () => {
    const before = runs.write_file;
    const running = beat();
    const approvalId = await pendingApprovalId();
    expect((await decide(approvalId, "denied", approverKey)).statusCode).toBe(200);
    const r = await running;
    expect(r.outcome).toBe("rejected");
    expect(r.lines.at(-1)).toContain("Nothing executed");
    expect(runs.write_file).toBe(before);
  });

  it("executes nothing when no decision arrives, and a re-run lands on the same request", async () => {
    const before = runs.write_file;
    const first = await beat({ waitMs: 200 });
    expect(first.outcome).toBe("timed_out");
    expect(first.exitCode).toBe(1);
    const again = await beat({ waitMs: 200 });
    expect(again.approvalId).toBe(first.approvalId);
    expect(runs.write_file).toBe(before);
    // leave the shared database without a pending row of ours
    await decide(first.approvalId!, "denied", approverKey);
  });
});

describe("demo:enforce LIVE, upstream down", () => {
  it("names the refusal and executes nothing", async () => {
    const before = { ...runs };
    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
    await db.update(mcpServers).set({ url: "http://127.0.0.1:9/" }).where(eq(mcpServers.id, serverId));
    try {
      const r = await beat({ waitMs: 200 });
      expect(r.outcome).toBe("unexpected");
      expect(r.exitCode).toBe(1);
      expect(r.lines.at(-1)).toMatch(/^\*\*\* /);
      expect(runs).toEqual(before);
    } finally {
      await db.update(mcpServers).set({ url: row!.url }).where(eq(mcpServers.id, serverId));
    }
  });
});

describe("demo:enforce SIMULATED (lane L's fallback switch)", () => {
  it("asks the policy engine only: no approval, no chat post, no upstream contact", async () => {
    const hits = upstreamHits;
    const posts = slackPosts.length;
    const pendingBefore = await db.select({ id: approvals.id }).from(approvals).where(eq(approvals.userId, requesterId));
    const r = await beat({ isSimulated: async () => true });
    expect(r.outcome).toBe("simulated");
    expect(r.exitCode).toBe(0);
    expect(r.lines[0]).toMatch(/^SIMULATED DECISION/);
    expect(r.lines.find((l) => l.includes("search_code:"))).toMatch(/simulated decision {2}search_code: deny/);
    expect(r.lines.find((l) => l.includes("write_file:"))).toMatch(/simulated decision {2}write_file: require_approval .*requires sign-off from Avery Lane F/);
    expect(upstreamHits).toBe(hits);
    expect(slackPosts.length).toBe(posts);
    const after = await db.select({ id: approvals.id }).from(approvals).where(eq(approvals.userId, requesterId));
    expect(after.length).toBe(pendingBefore.length);
  });
});
