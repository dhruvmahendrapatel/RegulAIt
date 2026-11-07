import { afterAll, beforeAll, describe, expect, it } from "vitest";
// an opt-in egress allow entry and a grant mint are stepped-up actions (ADR-0186 A, ADR-0250): each setup post
// relaxes step-up for that one call
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { and, auditLog, createDb, eq, INTERCEPTION_SETTINGS_ID, interceptionSettings, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { PROJECT_HEADER } from "./mcp-proxy.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { removeEgressAllowEntry } from "./testing/egress-allow-cleanup.js";

/**
 * ADR-0250 (review P-02) — the plan-only gate is FORCED at project level on the two surfaces that can never name a
 * workflow instance: the IDE compat shims (every call is `execute`) and the MCP proxy (a WRITE tool mutates, a read
 * tool is plan-safe). While a live instance of the attributed project rests at its planning stage, the mutating call
 * is refused and audited on that instance's own trail; once planning is finished, the same call passes (the control,
 * M-002). The invoke and run paths are pinned in plan-only.test.ts.
 *
 * Shares one DB with the other gateway suites; everything here is prefixed pgs-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "pgs-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let gatewayUrl: string;
let devAuth: { authorization: string };
let devToken: string;
let projectId: string;
let mcpServerId: string;
let mcpUpstream: { url: string; close: () => Promise<void> };
let loopbackAllowHostId: string | undefined;
let restoreStrictAdmission: (() => Promise<void>) | undefined;
let restoreSb2Gates: () => Promise<void> = async () => {};

function buildMcpUpstream(): McpServer {
  const server = new McpServer({ name: "pgs-upstream", version: "0.0.1" });
  server.registerTool(
    "pgs_read",
    { description: "Reads a note", inputSchema: { key: z.string() }, annotations: { readOnlyHint: true } },
    async ({ key }) => ({ content: [{ type: "text", text: `note: ${key}` }] }),
  );
  // no readOnlyHint → classified WRITE (the conservative default)
  server.registerTool(
    "pgs_write",
    { description: "Writes a note", inputSchema: { key: z.string() } },
    async ({ key }) => ({ content: [{ type: "text", text: `wrote: ${key}` }] }),
  );
  return server;
}

async function startMcpUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        const server = buildMcpUpstream();
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

async function mcpClient(): Promise<Client> {
  const client = new Client({ name: "pgs-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp/${mcpServerId}`), {
    requestInit: { headers: { authorization: `Bearer ${devToken}`, [PROJECT_HEADER]: projectId } },
  });
  await client.connect(transport);
  return client;
}

async function startPlanningInstance(): Promise<string> {
  const started = await app.inject({
    method: "POST",
    headers: devAuth,
    url: "/v1/workflows/instances",
    payload: {
      projectId,
      change: { description: "pgs change", paths: ["src/pgs.ts"], changeType: "pgs-change", environment: "staging" },
    },
  });
  expect(started.statusCode, started.body).toBe(201);
  expect(started.json().status).toBe("blocked_on_plan");
  return started.json().id as string;
}

async function leavePlanOnly(instanceId: string) {
  const res = await app.inject({
    method: "POST",
    headers: devAuth,
    url: `/v1/workflows/instances/${instanceId}/advance`,
    payload: { stageId: "plan" },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function auditFor(instanceId: string, ruleId: string) {
  return db.select().from(auditLog).where(and(eq(auditLog.objectId, instanceId), eq(auditLog.ruleId, ruleId)));
}

const compatCall = () =>
  app.inject({
    method: "POST",
    headers: { ...devAuth, [PROJECT_HEADER]: projectId },
    url: "/v1/chat/completions",
    payload: { model: "pgs-model", messages: [{ role: "user", content: "pgs probe" }] },
  });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  gatewayUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  mcpUpstream = await startMcpUpstream();

  const egressAllowed = await relaxStepUpAround(db, () =>
    app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/egress-allow-hosts",
      payload: { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: "pgs suite: local MCP double" },
    }),
  );
  expect(egressAllowed.statusCode, egressAllowed.body).toBe(201);
  loopbackAllowHostId = egressAllowed.json().id;

  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: "pgs-dev@example.com", displayName: "pgs-dev" },
  });
  expect(user.statusCode, user.body).toBe(201);
  const devId = user.json().id as string;
  const key = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${devId}/keys`, payload: { name: "pgs" } });
  devToken = key.json().token;
  devAuth = { authorization: `Bearer ${devToken}` };

  const agent = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name: "pgs-agent", provider: "mock", tier: 1, model: "pgs-model", costPerMTokIn: 1, costPerMTokOut: 2 },
  });
  expect(agent.statusCode, agent.body).toBe(201);
  const grant = await relaxStepUpAround(db, () =>
    app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: devId, agentId: agent.json().id } }),
  );
  expect(grant.statusCode, grant.body).toBe(201);
  const policy = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${devId}/agent-policy`,
    payload: { routingMode: "passthrough" },
  });
  expect(policy.statusCode).toBe(200);

  const server = await app.inject({ method: "POST", headers: AUTH, url: "/v1/servers", payload: { name: "pgs-upstream", url: mcpUpstream.url } });
  expect(server.statusCode, server.body).toBe(201);
  mcpServerId = server.json().id;
  for (const toolName of ["pgs_read", "pgs_write"]) {
    const g = await relaxStepUpAround(db, () =>
      app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/tools", payload: { userId: devId, serverId: mcpServerId, toolName } }),
    );
    expect(g.statusCode, g.body).toBe(201);
  }

  const project = await app.inject({ method: "POST", headers: AUTH, url: "/v1/projects", payload: { name: "pgs-project" } });
  expect(project.statusCode, project.body).toBe(201);
  projectId = project.json().id;
  const member = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/projects/${projectId}/members`,
    payload: { userId: devId, role: "contributor" },
  });
  expect(member.statusCode, member.body).toBe(201);

  const tpl = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/templates",
    payload: {
      name: "pgs-plan-first",
      definition: {
        workflow: "pgs-plan-first",
        stages: [
          { id: "intake", type: "trigger" },
          { id: "plan", type: "planning" },
          { id: "requirements", type: "artifact_generation", output: "requirements_file" },
        ],
      },
    },
  });
  expect(tpl.statusCode, tpl.body).toBe(201);
  const rule = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/assignment-rules",
    payload: { templateId: tpl.json().id, changeType: "pgs-change" },
  });
  expect(rule.statusCode, rule.body).toBe(201);

  const compat = await app.inject({
    method: "PUT",
    headers: AUTH,
    url: "/v1/interception/settings",
    payload: { openaiCompatEnabled: true },
  });
  expect(compat.statusCode, compat.body).toBe(200);
}, 120_000);

afterAll(async () => {
  // M-068: remove the loopback allow entry first, while the app is open; assert after every other restore
  const loopback = await removeEgressAllowEntry(app, AUTH, { id: loopbackAllowHostId });
  try {
    await restoreStrictAdmission?.();
    // the shipped interception default for later suites on this DB
    await db.update(interceptionSettings).set({ openaiCompatEnabled: false }).where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
    app.server.closeAllConnections();
    await restoreSb2Gates();
    await app.close();
    await mcpUpstream.close();
  } finally {
    loopback.assertRemoved();
  }
});

describe("ADR-0250 (P-02): the compat surface meets the plan-only gate", () => {
  it("an IDE call on a project whose instance plans is refused 409 plan_only_stage, audited; it passes once planning is done", async () => {
    const instanceId = await startPlanningInstance();
    const refused = await compatCall();
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.body).toContain("plan_only_stage");
    expect(refused.body).toContain(instanceId);
    const denies = await auditFor(instanceId, "workflow-plan-only-stage");
    expect(denies.length).toBe(1);
    expect(denies[0]!.effect).toBe("deny");
    expect(denies[0]!.detail).toMatchObject({ enforcement: "project", surface: "compat", projectId, mode: "execute" });

    await leavePlanOnly(instanceId);
    const passed = await compatCall();
    expect(passed.statusCode, passed.body).toBe(200);
  });
});

describe("ADR-0250 (P-02): the MCP surface meets the plan-only gate", () => {
  it("a read tool passes while the project plans; a write tool is refused before the upstream, audited; it passes after", async () => {
    const instanceId = await startPlanningInstance();
    const client = await mcpClient();
    try {
      const read = (await client.callTool({ name: "pgs_read", arguments: { key: "alpha" } })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(read.isError ?? false).toBe(false);
      expect(read.content[0]!.text).toBe("note: alpha");

      const err = (await client.callTool({ name: "pgs_write", arguments: { key: "beta" } }).catch((e: unknown) => e)) as
        | Error
        | { isError?: boolean; content: Array<{ text: string }> };
      const message = err instanceof Error ? err.message : JSON.stringify(err);
      expect(message).toContain("plan-only stage");
      expect(message).toContain(instanceId);
      expect(message).not.toContain("wrote: beta");

      const denies = await auditFor(instanceId, "workflow-plan-only-stage");
      expect(denies.length).toBe(1);
      expect(denies[0]!.toolName).toBe("pgs_write");
      expect(denies[0]!.detail).toMatchObject({ enforcement: "project", surface: "mcp", projectId, toolKind: "write" });
    } finally {
      await client.close();
    }

    await leavePlanOnly(instanceId);
    const after = await mcpClient();
    try {
      const wrote = (await after.callTool({ name: "pgs_write", arguments: { key: "gamma" } })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(wrote.isError ?? false).toBe(false);
      expect(wrote.content[0]!.text).toBe("wrote: gamma");
    } finally {
      await after.close();
    }
  });
});
