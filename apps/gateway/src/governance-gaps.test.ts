import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import {
  and,
  auditLog,
  createDb,
  eq,
  isNull,
  mcpServers,
  runMigrations,
  usageEvents,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { installLicenseFixture, removeLicenseFixture } from "./testing/license-fixture.js";
import { PROJECT_HEADER } from "./mcp-proxy.js";

/**
 * ADR-0019 — the four governance gaps, end to end at the gateway edge.
 *
 * G1 per-user AGENT/CONNECTOR revocation: pillar 1 promises "role builder +
 *    per-user override", but role-bundled agent/connector grants (ADR-0014)
 *    composed additively with no subtractive override. Proves a revocation
 *    denies a ROLE-granted agent at DIRECT invoke, in DECOMPOSE, and at
 *    orchestration PLAN time (a revocation honoured in one place but not the
 *    others would be a security hole), the same for connectors, and that it can
 *    only ever DENY.
 * G2 streaming suppression: a block-mode PII project gets NO SSE delta stream —
 *    the recorded known limit (raw text flashing before the withheld marker) is
 *    closed by running the dispatch buffered, disclosed via streamingSuppressed.
 * G3 MCP attribution + PII: the MCP proxy takes a project, bills ONE usage row
 *    onto the same ledger, enforces the project's PII mode on tool arguments
 *    and results, and — critically — is BYTE-IDENTICAL when unattributed.
 * G4 data_sensitivity: the 6th assignment dim, server-resolved from the
 *    attributed project's compliance classifications.
 *
 * Shares one database with the other gateway suites (fileParallelism off), so
 * every object here is name-prefixed gg-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "gg-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "b".repeat(64);
const SSN = "123-45-6789"; // well-known INVALID test SSN — never real PII

// --- upstream test MCP server -------------------------------------------
// echo_note returns whatever it is given (so a PII-bearing ARGUMENT is the
// input-check subject); leak_note returns a fake SSN regardless of input (so
// the OUTPUT check is exercised on clean input).

function buildUpstream(): McpServer {
  const server = new McpServer({ name: "gg-upstream", version: "0.0.1" });
  server.registerTool(
    "gg_echo",
    { description: "Echoes text", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
    async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
  );
  server.registerTool(
    "gg_leak",
    { description: "Returns a fake SSN", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: "text", text: `record ssn ${SSN}` }] }),
  );
  return server;
}

async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        const server = buildUpstream();
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
      new Promise((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

let db: Db;
let app: ReturnType<typeof buildApp>;
let upstream: Awaited<ReturnType<typeof startUpstream>>;
let gatewayUrl: string;

let ivaId: string;
let ivaAuth: { authorization: string };
let ivaKey: string;
let approverId: string;
let roleId: string;
let roleAgentId: string; // agent granted ONLY via the role
let directAgentId: string; // agent granted DIRECTLY to iva
let roleConnectorId: string;
let mcpServerId: string;
let plainProject: string;
let blockProject: string;
let sensitiveProject: string;

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/users",
    payload: { email, displayName: email.split("@")[0] },
  });
  const k = await app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`,
    payload: { name: "gg" },
  });
  return {
    id: u.json().id as string,
    token: k.json().token as string,
    auth: { authorization: `Bearer ${k.json().token}` },
  };
}

async function makeProject(name: string, classifications?: string[]) {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/projects",
    payload: { name, ...(classifications ? { classifications } : {}) },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

/** an MCP client over the real proxy, optionally attributed to a project */
async function mcpClient(token: string, projectId?: string): Promise<Client> {
  const client = new Client({ name: "gg-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${gatewayUrl}/mcp/${mcpServerId}`),
    {
      requestInit: {
        headers: {
          authorization: `Bearer ${token}`,
          ...(projectId ? { [PROJECT_HEADER]: projectId } : {}),
        },
      },
    },
  );
  await client.connect(transport);
  return client;
}

async function usageRows(projectId: string) {
  return db.select().from(usageEvents).where(eq(usageEvents.projectId, projectId));
}

async function revokeAgent(userId: string, agentId: string, reason?: string) {
  return app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${userId}/revocations/agents`,
    payload: { agentId, ...(reason ? { reason } : {}) },
  });
}

async function invokeAgent(agentId: string, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST", headers: ivaAuth, url: `/v1/agents/${agentId}/invoke`,
    payload: { mode: "execute", input: "gg probe", ...extra },
  });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  // ADR-0052 §4: this suite exercises a route now tier-gated on
  // `advanced_orchestration` — run under a real signed license granting it
  // (removed in afterAll; the deployment ends UNLICENSED as it started).
  await installLicenseFixture(app, { features: ["advanced_orchestration"], auth: AUTH });
  gatewayUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  upstream = await startUpstream();

  const iva = await makeUser("gg-iva@example.com");
  ivaId = iva.id;
  ivaAuth = iva.auth;
  ivaKey = iva.token;
  approverId = (await makeUser("gg-approver@example.com")).id;

  // two agents: one reachable ONLY through a role, one granted directly
  const mkAgent = async (name: string) => {
    const r = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/agents",
      payload: {
        name, provider: "mock", tier: 1, model: "mock-balanced",
        costPerMTokIn: 1, costPerMTokOut: 2,
      },
    });
    return r.json().id as string;
  };
  roleAgentId = await mkAgent("gg-role-agent");
  directAgentId = await mkAgent("gg-direct-agent");

  const connector = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/connectors",
    payload: { name: "gg-conn", kind: "data", providerKind: "mock", pricePerCallUsd: 0.002 },
  });
  roleConnectorId = connector.json().id;

  // a role that bundles the agent AND the connector, assigned to iva. Nothing
  // is granted to iva directly for these two — the ONLY path is the role.
  const role = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/roles",
    payload: { name: "gg-analyst", description: "gg analyst" },
  });
  roleId = role.json().id;
  await app.inject({
    method: "POST", headers: AUTH, url: `/v1/roles/${roleId}/grants/agents`,
    payload: { agentId: roleAgentId },
  });
  await app.inject({
    method: "POST", headers: AUTH, url: `/v1/roles/${roleId}/grants/connectors`,
    payload: { connectorId: roleConnectorId, mode: "readwrite" },
  });
  await app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${ivaId}/roles`,
    payload: { roleId },
  });
  await app.inject({
    method: "POST", headers: AUTH, url: "/v1/grants/agents",
    payload: { userId: ivaId, agentId: directAgentId },
  });

  const server = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/servers",
    payload: { name: "gg-upstream", url: upstream.url },
  });
  mcpServerId = server.json().id;
  // pillar 5: a flat per-call price so an attributed MCP call has real cost
  await db
    .update(mcpServers)
    .set({ pricePerCallUsd: 0.005 })
    .where(eq(mcpServers.id, mcpServerId));
  for (const toolName of ["gg_echo", "gg_leak"]) {
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/tools",
      payload: { userId: ivaId, serverId: mcpServerId, toolName },
    });
  }

  await app.inject({
    method: "POST", headers: AUTH, url: "/v1/compliance/profiles",
    payload: { tag: "gg-block", piiMode: "block" },
  });
  await app.inject({
    method: "POST", headers: AUTH, url: "/v1/compliance/profiles",
    payload: { tag: "gg-restricted", piiMode: "log" },
  });
  plainProject = await makeProject("gg-plain-proj");
  blockProject = await makeProject("gg-block-proj", ["gg-block"]);
  sensitiveProject = await makeProject("gg-sensitive-proj", ["gg-restricted"]);
  // ADR-0011: once a project has ANY member, only members may attribute to it —
  // so iva joins all three up front (membership is ATTRIBUTION only; it never
  // touches tool/agent entitlement, which is the whole point of G1's asserts).
  for (const p of [plainProject, blockProject, sensitiveProject]) {
    const m = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/projects/${p}/members`,
      payload: { userId: ivaId, role: "contributor" },
    });
    expect(m.statusCode).toBe(201);
  }
});

afterAll(async () => {
  await removeLicenseFixture(db);
  app.server.closeAllConnections();
  await app.close();
  await upstream.close();
});

// =========================================================================
// G1 — per-user revocation of role-derived agent/connector grants
// =========================================================================

describe("G1 agent revocation applies at EVERY evaluation site", () => {
  let revocationId: string;

  it("baseline: the role-granted agent invokes, decomposes and plans fine", async () => {
    expect((await invokeAgent(roleAgentId)).statusCode).toBe(200);

    const plan = await app.inject({
      method: "POST", headers: ivaAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "gg-baseline-run",
          escalationApproverUserId: approverId,
          nodes: [{ id: "n1", title: "t", ownerAgentId: roleAgentId, mode: "execute" }],
        },
      },
    });
    expect(plan.statusCode).toBe(201);

    const dec = await app.inject({
      method: "POST", headers: ivaAuth, url: "/v1/runs/decompose",
      payload: { goal: "gg baseline decomposition goal", leadAgentId: roleAgentId },
    });
    expect(dec.statusCode).toBe(200);
  });

  it("a revocation denies the ROLE-granted agent at DIRECT invoke with ruleId agent-revoked", async () => {
    const created = await revokeAgent(ivaId, roleAgentId, "gg: off the analyst rotation");
    expect(created.statusCode).toBe(201);
    revocationId = created.json().id;

    const res = await invokeAgent(roleAgentId);
    expect(res.statusCode).toBe(403);
    expect(res.json().decision.effect).toBe("deny");
    expect(res.json().decision.ruleId).toBe("agent-revoked");
    expect(res.json().decision.reason).toContain("off the analyst rotation");
    // still audited like any other decision
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, ivaId), eq(auditLog.ruleId, "agent-revoked")));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.effect === "deny")).toBe(true);
  });

  it("the SAME revocation denies the agent at orchestration PLAN time (not just direct invoke)", async () => {
    const plan = await app.inject({
      method: "POST", headers: ivaAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "gg-revoked-run",
          escalationApproverUserId: approverId,
          nodes: [{ id: "n1", title: "t", ownerAgentId: roleAgentId, mode: "execute" }],
        },
      },
    });
    expect(plan.statusCode).toBe(422);
    expect(plan.json().error).toBe("entitlement_exceeded");
    expect(plan.json().nodes[0].decision.ruleId).toBe("agent-revoked");
  });

  it("the SAME revocation denies the agent as a DECOMPOSE lead", async () => {
    const dec = await app.inject({
      method: "POST", headers: ivaAuth, url: "/v1/runs/decompose",
      payload: { goal: "gg revoked decomposition goal", leadAgentId: roleAgentId },
    });
    expect(dec.statusCode).toBe(403);
    expect(dec.json().decision.ruleId).toBe("agent-revoked");
  });

  it("a revocation NARROWS only: the directly-granted agent is untouched", async () => {
    expect((await invokeAgent(directAgentId)).statusCode).toBe(200);
  });

  it("a revocation can only DENY — revoking an ungranted agent grants nothing", async () => {
    const stranger = await makeUser("gg-stranger@example.com");
    const rev = await revokeAgent(stranger.id, roleAgentId);
    expect(rev.statusCode).toBe(201);
    const res = await app.inject({
      method: "POST", headers: stranger.auth, url: `/v1/agents/${roleAgentId}/invoke`,
      payload: { mode: "execute", input: "gg probe" },
    });
    expect(res.statusCode).toBe(403);
    // the ORIGINAL default-deny, never re-labelled as a revocation
    expect(res.json().decision.ruleId).toBe("default-deny");
  });

  it("the per-user entitlement view flags the revocation instead of hiding it", async () => {
    const view = await app.inject({
      method: "GET", headers: ivaAuth, url: `/v1/users/${ivaId}/agents`,
    });
    const row = view.json().agents.find((a: { agentId: string }) => a.agentId === roleAgentId);
    expect(row.source).toBe("role");
    expect(row.roles).toContain("gg-analyst");
    expect(row.revoked).toBe(true);
    // and the dedicated read-back lists it with the object named
    const list = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/users/${ivaId}/revocations/agents`,
    });
    expect(list.json().revocations[0].agentName).toBe("gg-role-agent");
  });

  it("the revocation routes are admin-only; a non-admin cannot revoke for anyone", async () => {
    const res = await app.inject({
      method: "POST", headers: ivaAuth, url: `/v1/users/${ivaId}/revocations/agents`,
      payload: { agentId: directAgentId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("admin_only");
  });

  it("lifting the revocation restores exactly what the role already granted", async () => {
    const del = await app.inject({
      method: "DELETE", headers: AUTH,
      url: `/v1/users/${ivaId}/revocations/agents/${revocationId}`,
    });
    expect(del.statusCode).toBe(200);
    expect((await invokeAgent(roleAgentId)).statusCode).toBe(200);
  });
});

describe("G1 connector revocation", () => {
  it("denies a ROLE-granted connector with ruleId connector-revoked, and lifting restores it", async () => {
    const invoke = () =>
      app.inject({
        method: "POST", headers: ivaAuth, url: `/v1/connectors/${roleConnectorId}/invoke`,
        payload: { operation: "read" },
      });
    expect((await invoke()).statusCode).toBe(200);

    const created = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${ivaId}/revocations/connectors`,
      payload: { connectorId: roleConnectorId, reason: "gg: no CRM access" },
    });
    expect(created.statusCode).toBe(201);

    const denied = await invoke();
    expect(denied.statusCode).toBe(403);
    expect(denied.json().decision.ruleId).toBe("connector-revoked");
    expect(denied.json().decision.reason).toContain("no CRM access");

    const view = await app.inject({
      method: "GET", headers: ivaAuth, url: `/v1/users/${ivaId}/connectors`,
    });
    expect(
      view.json().connectors.find((c: { connectorId: string }) => c.connectorId === roleConnectorId)
        .revoked,
    ).toBe(true);

    await app.inject({
      method: "DELETE", headers: AUTH,
      url: `/v1/users/${ivaId}/revocations/connectors/${created.json().id}`,
    });
    expect((await invoke()).statusCode).toBe(200);
  });
});

// =========================================================================
// G2 — streaming suppressed for block-mode PII projects
// =========================================================================

describe("G2 block-mode projects never open an SSE stream", () => {
  it("stream:true on a block-mode project returns buffered JSON with streamingSuppressed", async () => {
    const res = await invokeAgent(directAgentId, {
      dispatch: true, stream: true, projectId: blockProject,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["content-type"]).not.toContain("event-stream");
    const body = res.json();
    // honest, not silent: the caller is told why it got JSON
    expect(body.streamingSuppressed).toBe(true);
    expect(body.dispatch.outputText).toContain("gg probe");
    // and the audit row records it too
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, ivaId), eq(auditLog.objectType, "agent")));
    expect(
      rows.some((r) => (r.detail as { streamingSuppressed?: boolean }).streamingSuppressed === true),
    ).toBe(true);
  });

  it("the withheld OUTPUT never reaches the client on the suppressed path", async () => {
    const res = await invokeAgent(directAgentId, {
      input: "summarize this <<emit-ssn>>", dispatch: true, stream: true, projectId: blockProject,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).not.toContain("event-stream");
    const d = res.json().dispatch;
    expect(d.pii.withheld).toBe(true);
    expect(d.outputText).toContain("output withheld");
    expect(res.body).not.toContain(SSN);
  });

  it("a non-block project still streams exactly as before (no regression)", async () => {
    const res = await invokeAgent(directAgentId, {
      dispatch: true, stream: true, projectId: plainProject,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("event: delta");
    expect(res.body).toContain("event: result");
  });
});

// =========================================================================
// G3 — MCP proxy project attribution + PII enforcement
// =========================================================================

describe("G3 MCP proxy attribution", () => {
  it("an UNATTRIBUTED call is METERED with projectId NULL (ADR-0024 O11) — same price, no project touched", async () => {
    const before = await db.select().from(usageEvents).where(isNull(usageEvents.projectId));
    const client = await mcpClient(ivaKey);
    const result = await client.callTool({ name: "gg_echo", arguments: { text: "hello" } });
    await client.close();
    expect(result.content).toEqual([{ type: "text", text: "echo: hello" }]);
    // ADR-0024 (O11) widened ADR-0019: attribution decides WHERE the row
    // lands, not WHETHER it exists — the unattributed call writes the same
    // priced usage row with projectId NULL (the explicit Unattributed bucket).
    const after = await db.select().from(usageEvents).where(isNull(usageEvents.projectId));
    expect(after.length).toBe(before.length + 1);
    const row = after.find((r) => !before.some((b) => b.id === r.id))!;
    expect(row.objectType).toBe("mcp_tool");
    expect(row.operation).toBe("gg_echo");
    expect(row.projectId).toBeNull();
    expect(row.costUsd).toBeCloseTo(0.005, 6);
  });

  it("an ATTRIBUTED call writes EXACTLY ONE usage row that rolls into the project total", async () => {
    const before = await usageRows(plainProject);
    const client = await mcpClient(ivaKey, plainProject);
    const result = await client.callTool({ name: "gg_echo", arguments: { text: "billed" } });
    await client.close();
    expect(result.content).toEqual([{ type: "text", text: "echo: billed" }]);

    const after = await usageRows(plainProject);
    expect(after.length).toBe(before.length + 1);
    // find the NEW row by id-diff — an unordered select's "last row" is not a
    // stable concept once the shared table has churn from other suites
    const row = after.find((r) => !before.some((b) => b.id === r.id))!;
    expect(row.objectType).toBe("mcp_tool");
    expect(row.operation).toBe("gg_echo");
    expect(row.costUsd).toBeCloseTo(0.005, 6);
    expect((row.detail as { serverId: string }).serverId).toBe(mcpServerId);

    // the project dashboard picks it up with no separate reporting path
    const costs = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/projects/${plainProject}/costs`,
    });
    expect(costs.json().measured.costUsd).toBeGreaterThanOrEqual(0.005);
    const byTool = costs.json().byMcpTool.find((t: { toolName: string }) => t.toolName === "gg_echo");
    expect(byTool.events).toBeGreaterThanOrEqual(1);
  });

  it("a DENIED call still bills nothing even when attributed", async () => {
    const stranger = await makeUser("gg-mcp-stranger@example.com");
    const mem = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/projects/${plainProject}/members`,
      payload: { userId: stranger.id, role: "contributor" },
    }); // membership grants ATTRIBUTION only, never tool entitlement
    expect(mem.statusCode).toBe(201);
    const before = await usageRows(plainProject);
    const client = await mcpClient(stranger.token, plainProject);
    await expect(client.callTool({ name: "gg_echo", arguments: { text: "x" } })).rejects.toThrow(
      /Denied by policy/,
    );
    await client.close();
    expect((await usageRows(plainProject)).length).toBe(before.length);
  });

  it("a project the caller may not attribute to is rejected before the transport opens", async () => {
    const outsider = await makeUser("gg-outsider@example.com");
    const res = await app.inject({
      method: "POST",
      headers: { authorization: `Bearer ${outsider.token}`, [PROJECT_HEADER]: plainProject },
      url: `/mcp/${mcpServerId}`,
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    // plainProject now HAS members, so a non-member cannot bill to it
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_a_project_member");
  });

  it("a malformed project header is a 400, not a JSON-RPC error", async () => {
    const res = await app.inject({
      method: "POST",
      headers: { authorization: `Bearer ${ivaKey}`, [PROJECT_HEADER]: "not-a-uuid" },
      url: `/mcp/${mcpServerId}`,
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_project_id");
  });
});

describe("G3 MCP PII enforcement", () => {
  it("block on INPUT: PII in the tool ARGUMENTS denies pre-call with NO bill", async () => {
    const before = await usageRows(blockProject);
    const client = await mcpClient(ivaKey, blockProject);
    await expect(
      client.callTool({ name: "gg_echo", arguments: { text: `ssn ${SSN}` } }),
    ).rejects.toThrow(/input contains PII/);
    await client.close();
    // nothing executed, nothing billed
    expect((await usageRows(blockProject)).length).toBe(before.length);
    const denies = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, ivaId), eq(auditLog.ruleId, "pii-blocked")));
    const mcpDeny = denies.find((d) => d.toolName === "gg_echo");
    expect(mcpDeny).toBeDefined();
    expect(mcpDeny!.effect).toBe("deny");
    // §8.4: counts only — the matched substring is never persisted
    expect(JSON.stringify(mcpDeny!.detail)).not.toContain(SSN);
    expect(mcpDeny!.reason).not.toContain(SSN);
  });

  it("block on OUTPUT: bills-and-withholds — one usage row, the SSN never returned", async () => {
    const before = await usageRows(blockProject);
    const client = await mcpClient(ivaKey, blockProject);
    const result = await client.callTool({ name: "gg_leak", arguments: {} });
    await client.close();
    expect(JSON.stringify(result)).not.toContain(SSN);
    expect(JSON.stringify(result)).toContain("output withheld");
    // the spend is honest: the tool really ran
    const after = await usageRows(blockProject);
    expect(after.length).toBe(before.length + 1);
    // The new row is identified by IDENTITY, not by position. `usageRows` is an
    // unordered SELECT, so "the last element" is whatever Postgres happened to
    // hand back last — not the row this call just wrote. That distinction is
    // invisible until the physical row order changes, which is exactly how this
    // failed in CI while passing locally: the tail element was an `agent` row
    // from an earlier test in the same project.
    const seen = new Set(before.map((r) => r.id));
    const fresh = after.filter((r) => !seen.has(r.id));
    expect(fresh).toHaveLength(1);
    const row = fresh[0]!;
    expect(row.objectType).toBe("mcp_tool");
    expect((row.detail as { pii?: { action: string } }).pii?.action).toBe("block");
    expect(JSON.stringify(row.detail)).not.toContain(SSN);
  });

  it("an unclassified project meters but does not enforce — the leaky tool returns normally", async () => {
    const client = await mcpClient(ivaKey, plainProject);
    const result = await client.callTool({ name: "gg_leak", arguments: {} });
    await client.close();
    expect(JSON.stringify(result)).toContain(SSN);
  });
});

// =========================================================================
// G4 — data_sensitivity, the 6th assignment dimension
// =========================================================================

describe("G4 data-sensitivity assignment dim", () => {
  let baseStage: string;
  let sensitiveStage: string;

  beforeAll(async () => {
    const mkTemplate = async (name: string, stageId: string) => {
      const r = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/workflows/templates",
        payload: {
          name,
          definition: {
            workflow: name,
            stages: [
              { id: "intake", type: "trigger" },
              { id: stageId, type: "human_approval", approvers: [approverId] },
            ],
          },
        },
      });
      return r.json().id as string;
    };
    baseStage = "gg_base_gate";
    sensitiveStage = "gg_sensitive_gate";
    const base = await mkTemplate("gg-base-tpl", baseStage);
    const sensitive = await mkTemplate("gg-sensitive-tpl", sensitiveStage);
    // both rules key on the same changeType; only the second adds the 6th dim
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: base, changeType: "gg-change" },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: sensitive, changeType: "gg-change", dataSensitivity: "gg-restricted" },
    });
  });

  const stageIds = async (instanceId: string) => {
    const r = await app.inject({
      method: "GET", headers: ivaAuth, url: `/v1/workflows/instances/${instanceId}`,
    });
    return (r.json().instance.definition.stages ?? []).map((s: { id: string }) => s.id);
  };
  const start = (projectId?: string) =>
    app.inject({
      method: "POST", headers: ivaAuth, url: "/v1/workflows/instances",
      payload: {
        ...(projectId ? { projectId } : {}),
        change: {
          description: "gg change", paths: ["src/x.ts"],
          changeType: "gg-change", environment: "gg-env",
        },
      },
    });

  it("a classified project's change routes onto the sensitivity-scoped template too", async () => {
    const res = await start(sensitiveProject);
    expect(res.statusCode).toBe(201);
    const ids = await stageIds(res.json().id);
    expect(ids).toContain(baseStage);
    expect(ids).toContain(sensitiveStage);
  });

  it("an UNCLASSIFIED project's change does not — the dim matches as absent", async () => {
    const res = await start(plainProject);
    expect(res.statusCode).toBe(201);
    const ids = await stageIds(res.json().id);
    expect(ids).toContain(baseStage);
    expect(ids).not.toContain(sensitiveStage);
  });

  it("a change with NO project does not match either — no invented sensitivity", async () => {
    const res = await start();
    expect(res.statusCode).toBe(201);
    const ids = await stageIds(res.json().id);
    expect(ids).toContain(baseStage);
    expect(ids).not.toContain(sensitiveStage);
  });

  it("the dim is SERVER-resolved: a client cannot assert a sensitivity in the change body", async () => {
    const res = await app.inject({
      method: "POST", headers: ivaAuth, url: "/v1/workflows/instances",
      payload: {
        projectId: plainProject,
        change: {
          description: "gg smuggle", paths: ["src/x.ts"],
          changeType: "gg-change", environment: "gg-env",
          // not part of changeDescriptorSchema — stripped, never matched on
          dataSensitivities: ["gg-restricted"],
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const ids = await stageIds(res.json().id);
    expect(ids).not.toContain(sensitiveStage);
  });
});
