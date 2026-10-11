import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  and,
  auditLog,
  costEvents,
  createDb,
  desc,
  eq,
  interceptionScopeRules,
  interceptionSettings,
  INTERCEPTION_SETTINGS_ID,
  isNull,
  mcpServers,
  runMigrations,
  usageEvents,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { PROJECT_HEADER } from "./compat-core.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";

// ADR-0181: this file pins behaviour against a LOCAL MCP double (127.0.0.1, registered
// seconds ago), not the strict admission defaults — relaxed explicitly, restored after.
let restoreStrictAdmission: (() => Promise<void>) | undefined;

/**
 * ADR-0024 (ROADMAP §6 O11 / O13 / O15) — interception DEPTH, end to end.
 *
 * The claims under test, in blast-radius order:
 *  1. METERING IS UNCONDITIONAL (O11): an unattributed MCP tool call writes
 *     the same usage row with projectId NULL, lands in the explicit
 *     Unattributed bucket, and can NEVER hit a project budget. The
 *     require_mcp_attribution toggle rejects unattributed calls, audited.
 *  2. SCOPE RULES grant surface EXPOSURE, never entitlement (O13): the
 *     precedence chain is user > project > role > org, first non-NULL per
 *     field, most-recent wins within a kind; org-off + role-enabled +
 *     unentitled user is STILL 403; disabled-by-resolution answers the same
 *     indistinguishable 404.
 *  3. KEY CUSTODY is an enforced rung (O15): credential create/update 409s
 *     (audited), dispatch resolution skips stored user credentials, and the
 *     flip is reversible (rows inert, not deleted).
 *  4. The posture display is honest: enforced vs declared-not-enforced vs
 *     honor system vs external infrastructure.
 *  5. The prompt-cache estimate counts the admin systemPrompt base.
 *
 * Shares one database with the other gateway suites (fileParallelism off), so
 * every object here is name-prefixed depth-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "depth-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let gatewayUrl: string;
let upstream: Awaited<ReturnType<typeof startUpstream>>;
let mcpServerId: string;

let devId: string;
let devKey: string;
let devAuth: { authorization: string };
let strangerId: string;
let strangerAuth: { authorization: string };
let modelAgentId: string;
let budgetProjectId: string;
/** an UNBUDGETED project for the scope-rule attribution tests — the budget
 * project would (correctly) budget-block attributed compat dispatches. */
let scopeProjectId: string;

// --- upstream test MCP server (stateless: fresh server+transport per request) ---

function buildUpstreamMcpServer(): McpServer {
  const server = new McpServer({ name: "depth-upstream", version: "0.0.1" });
  server.registerTool(
    "depth_time",
    { description: "Returns a fixed time", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: "text", text: "13:37" }] }),
  );
  return server;
}

async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      void (async () => {
        const server = buildUpstreamMcpServer();
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

// --- fake Anthropic upstream so custody tests can watch WHICH key served ---

async function startFakeAnthropic(marker: string) {
  const hits: Array<{ apiKey: string | null }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ apiKey: (req.headers["x-api-key"] as string) ?? null });
      const parsed = JSON.parse(body || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `msg_${marker}_${hits.length}`,
          type: "message",
          role: "assistant",
          model: parsed.model,
          content: [{ type: "text", text: `${marker}-reply` }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

// --- helpers ---------------------------------------------------------------

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: email.split("@")[0] },
  });
  const k = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${u.json().id}/keys`,
    payload: { name: "depth" },
  });
  return {
    id: u.json().id as string,
    token: k.json().token as string,
    auth: { authorization: `Bearer ${k.json().token}` },
  };
}

async function setPosture(patch: Record<string, unknown>) {
  const r = await app.inject({
    method: "PUT",
    headers: AUTH,
    url: "/v1/interception/settings",
    payload: patch,
  });
  expect(r.statusCode).toBe(200);
  return r.json();
}

async function mcpClient(token: string, projectId?: string): Promise<Client> {
  const client = new Client({ name: "depth-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp/${mcpServerId}`), {
    requestInit: {
      headers: {
        authorization: `Bearer ${token}`,
        ...(projectId ? { [PROJECT_HEADER]: projectId } : {}),
      },
    },
  });
  await client.connect(transport);
  return client;
}

const anthropicBody = (model: string, text = "depth probe") => ({
  model,
  max_tokens: 128,
  messages: [{ role: "user", content: text }],
});

/** Fastify's own not-found body — what an off/undisclosed surface must equal. */
const NOT_FOUND_MESSAGES = {
  message: "Route POST:/v1/messages not found",
  error: "Not Found",
  statusCode: 404,
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, requireProjectAttribution: false, requireMcpAttribution: false, keyCustodyEnforced: false });
  gatewayUrl = await app.listen({ port: 0, host: "127.0.0.1" });

  // ADR-0034 amendment — model-credential `baseUrl` overrides are now behind
  // the default-deny egress guard. This suite points them at local fake
  // provider servers on 127.0.0.1, so it allow-lists that host explicitly with
  // the private-range and plaintext opt-ins, exactly as an air-gapped operator
  // would (the same pattern as custom-providers.test.ts).
  const egressAllowed = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/egress-allow-hosts",
    payload: {
      host: "127.0.0.1",
      allowPrivateRanges: true,
      allowPlaintextHttp: true,
      note: "interception-depth suite: local fake provider endpoints",
    },
  });
  expect(egressAllowed.statusCode).toBe(201);

  upstream = await startUpstream();
  const server = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/servers",
    payload: { name: "depth-upstream", url: upstream.url },
  });
  mcpServerId = server.json().id;
  // pillar 5: a flat per-call price so every metered call has a real cost
  await db.update(mcpServers).set({ pricePerCallUsd: 0.005 }).where(eq(mcpServers.id, mcpServerId));

  const dev = await makeUser("depth-dev@example.com");
  devId = dev.id;
  devKey = dev.token;
  devAuth = dev.auth;
  const stranger = await makeUser("depth-stranger@example.com");
  strangerId = stranger.id;
  strangerAuth = stranger.auth;

  await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/tools",
    payload: { userId: devId, serverId: mcpServerId, toolName: "depth_time" },
  });

  // a governed agent for the compat-surface tests (granted to dev ONLY)
  const agentRes = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: {
      name: "depth-model-agent",
      provider: "mock",
      tier: 1,
      model: "depth-model",
      costPerMTokIn: 1,
      costPerMTokOut: 2,
    },
  });
  modelAgentId = agentRes.json().id;
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/agents",
    payload: { userId: devId, agentId: modelAgentId },
  });

  // a budgeted project (tiny budget) with dev as member — the null-row
  // cannot-hit-a-budget assertions run against it
  const approver = await makeUser("depth-approver@example.com");
  const proj = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/projects",
    payload: { name: "depth-budget-proj", budgetUsd: 0.001, budgetApproverUserId: approver.id },
  });
  budgetProjectId = proj.json().id;
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/projects/${budgetProjectId}/members`,
    payload: { userId: devId, role: "contributor" },
  });

  const scopeProj = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/projects",
    payload: { name: "depth-scope-proj" },
  });
  scopeProjectId = scopeProj.json().id;
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/projects/${scopeProjectId}/members`,
    payload: { userId: devId, role: "contributor" },
  });
});

afterAll(async () => {
  await restoreStrictAdmission?.();
  // restore the shipped defaults + clear scope rules so a later suite sharing
  // this database sees a pristine posture
  await db
    .update(interceptionSettings)
    .set({
      anthropicCompatEnabled: false,
      openaiCompatEnabled: false,
      mcpInterceptionEnabled: true,
      resolutionMode: "map_by_model",
      // ADR-0181: the shipped defaults are strict
      enforcementPosture: "managed",
      requireProjectAttribution: true,
      requireMcpAttribution: true,
      keyCustodyEnforced: true,
    })
    .where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
  await db.delete(interceptionScopeRules);
  app.server.closeAllConnections();
  await restoreSb2Gates();
  await app.close();
  await upstream.close();
});

// ===========================================================================
// O11 — unattributed MCP calls: metered, bucketed, and requirable
// ===========================================================================

describe("O11: unattributed MCP calls are metered into the Unattributed bucket", () => {
  it("an unattributed tool call writes a usage row with projectId NULL, priced at the server flat rate", async () => {
    const before = await db
      .select()
      .from(usageEvents)
      .where(and(eq(usageEvents.userId, devId), isNull(usageEvents.projectId)));

    const client = await mcpClient(devKey); // NO project header
    const result = await client.callTool({ name: "depth_time", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "13:37" }]);
    await client.close();

    const after = await db
      .select()
      .from(usageEvents)
      .where(and(eq(usageEvents.userId, devId), isNull(usageEvents.projectId)));
    expect(after.length).toBe(before.length + 1);
    const row = after.find((r) => !before.some((b) => b.id === r.id))!;
    expect(row.objectType).toBe("mcp_tool");
    expect(row.operation).toBe("depth_time");
    expect(row.projectId).toBeNull();
    expect(row.costUsd).toBe(0.005);
    expect((row.detail as { serverId?: string }).serverId).toBe(mcpServerId);
  });

  it("the unattributed bucket rollup names the spend — visible, labeled, admin-only", async () => {
    const r = await app.inject({ method: "GET", headers: AUTH, url: "/v1/costs/unattributed" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.bucket).toBe("unattributed");
    expect(body.measured.events).toBeGreaterThanOrEqual(1);
    expect(body.measured.costUsd).toBeGreaterThanOrEqual(0.005);
    const tool = body.byMcpTool.find((t: { toolName: string }) => t.toolName === "depth_time");
    expect(tool).toBeDefined();
    expect(tool.costUsd).toBeGreaterThanOrEqual(0.005);
    const byDev = body.byUser.find((u: { userId: string }) => u.userId === devId);
    expect(byDev).toBeDefined();
    // admin-only: a non-admin gets the ordinary admin gate, not the bucket
    const denied = await app.inject({ method: "GET", headers: devAuth, url: "/v1/costs/unattributed" });
    expect(denied.statusCode).toBe(403);
  });

  it("a null-project row can NEVER hit a project budget: project rollup stays zero and an attributed dispatch is not pre-blocked", async () => {
    // several unattributed calls whose total (>= 0.01) dwarfs the 0.001 budget
    const client = await mcpClient(devKey);
    await client.callTool({ name: "depth_time", arguments: {} });
    await client.callTool({ name: "depth_time", arguments: {} });
    await client.close();

    const costs = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/projects/${budgetProjectId}/costs`,
    });
    expect(costs.json().measured.events).toBe(0);
    expect(costs.json().budget.spentUsd).toBe(0);
    expect(costs.json().byMcpTool).toEqual([]);

    // the pre-dispatch budget gate reads the project's measured spend — if the
    // null rows counted, 0.015 >= 0.001 would 403 this attributed dispatch
    const invoke = await app.inject({
      method: "POST",
      headers: devAuth,
      url: `/v1/agents/${modelAgentId}/invoke`,
      payload: { mode: "execute", input: "budget probe", dispatch: true, projectId: budgetProjectId },
    });
    expect(invoke.statusCode).toBe(200);
  });

  it("require_mcp_attribution=true rejects an unattributed call pre-dispatch, naming the header, audited; attributed calls still run", async () => {
    await setPosture({ requireMcpAttribution: true });
    try {
      // raw POST so the 400 body is observable (the SDK client would just throw)
      const raw = await app.inject({
        method: "POST",
        headers: {
          ...devAuth,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        url: `/mcp/${mcpServerId}`,
        payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      });
      expect(raw.statusCode).toBe(400);
      expect(raw.json().error).toBe("mcp_attribution_required");
      expect(raw.json().detail).toContain(PROJECT_HEADER);

      // audited, with the dedicated ruleId
      const [auditRow] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.userId, devId), eq(auditLog.ruleId, "mcp-attribution-required")))
        .orderBy(desc(auditLog.at))
        .limit(1);
      expect(auditRow).toBeDefined();
      expect(auditRow!.effect).toBe("deny");

      // the SDK path fails too
      await expect(mcpClient(devKey)).rejects.toThrow();

      // an ATTRIBUTED call is unaffected and bills its project as usual
      const attributed = await mcpClient(devKey, budgetProjectId);
      await attributed.callTool({ name: "depth_time", arguments: {} });
      await attributed.close();
      const [projRow] = await db
        .select()
        .from(usageEvents)
        .where(and(eq(usageEvents.userId, devId), eq(usageEvents.projectId, budgetProjectId)))
        .orderBy(desc(usageEvents.at))
        .limit(1);
      expect(projRow).toBeDefined();
      expect(projRow!.objectType).toBe("mcp_tool");
    } finally {
      await setPosture({ requireMcpAttribution: false });
    }
  });

  it("with the toggle back off, unattributed calls run again (default behaviour)", async () => {
    const client = await mcpClient(devKey);
    const result = await client.callTool({ name: "depth_time", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "13:37" }]);
    await client.close();
  });
});

// ===========================================================================
// O13 — scope rules: staged rollout, precedence, and the no-privilege pins
// ===========================================================================

describe("O13: interception scope rules — precedence chain, exposure != entitlement, indistinguishable 404", () => {
  let roleId: string;
  const ruleIds: string[] = [];

  const mkRule = async (payload: Record<string, unknown>, expectStatus = 201) => {
    const r = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/interception/scope-rules",
      payload,
    });
    expect(r.statusCode).toBe(expectStatus);
    if (expectStatus === 201) ruleIds.push(r.json().id);
    return r.json();
  };
  const delRule = async (id: string) => {
    const r = await app.inject({
      method: "DELETE",
      headers: AUTH,
      url: `/v1/interception/scope-rules/${id}`,
    });
    expect(r.statusCode).toBe(200);
  };
  const callAnthropic = (auth: { authorization: string }, headers: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      headers: { ...auth, ...headers },
      url: "/v1/messages",
      payload: anthropicBody("depth-model"),
    });

  afterAll(async () => {
    await db.delete(interceptionScopeRules);
    await setPosture({ anthropicCompatEnabled: false, openaiCompatEnabled: false });
  });

  it("baseline: org-off answers Fastify's own 404 body", async () => {
    await setPosture({ anthropicCompatEnabled: false });
    const r = await callAnthropic(devAuth);
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual(NOT_FOUND_MESSAGES);
  });

  it("a rule must target something that exists (422 unknown_scope_target)", async () => {
    await mkRule(
      { scopeKind: "role", scopeId: "00000000-0000-4000-8000-00000000dead", anthropicCompatEnabled: true },
      422,
    );
  });

  it("PIN: org-off + role-enabled + ENTITLED user = 200; UNENTITLED user with the same role = 403 — exposure is not entitlement", async () => {
    const role = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/roles",
      payload: { name: "depth-pilot-role" },
    });
    roleId = role.json().id;
    for (const uid of [devId, strangerId]) {
      await app.inject({
        method: "POST",
        headers: AUTH,
        url: `/v1/users/${uid}/roles`,
        payload: { roleId },
      });
    }
    await mkRule({ scopeKind: "role", scopeId: roleId, anthropicCompatEnabled: true, note: "anthropic pilot" });

    // dev holds the role AND a grant on the resolved agent -> governed 200
    const ok = await callAnthropic(devAuth);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().regulait.servedAgentId).toBe(modelAgentId);

    // stranger holds the SAME role (surface exposed) but NO grant -> 403,
    // through the identical evaluateAgent gate — the rule granted nothing
    const denied = await callAnthropic(strangerAuth);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.regulait_code).toBe("agent_denied");
  });

  it("a caller with NO matching scope resolves at the org level: still the indistinguishable 404", async () => {
    const outsider = await makeUser("depth-outsider@example.com");
    const r = await callAnthropic(outsider.auth);
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual(NOT_FOUND_MESSAGES);
    // and an unauthenticated probe cannot detect that scope rules exist
    const probe = await app.inject({
      method: "POST",
      headers: { authorization: "Bearer bogus", "content-type": "application/json" },
      url: "/v1/messages",
      payload: anthropicBody("depth-model"),
    });
    expect(probe.statusCode).toBe(404);
    expect(probe.json()).toEqual(NOT_FOUND_MESSAGES);
  });

  it("project beats role: a project-scope disable turns the surface off for attributed calls, 404-indistinguishably", async () => {
    await mkRule({ scopeKind: "project", scopeId: scopeProjectId, anthropicCompatEnabled: false });
    // without the header: role rule still applies -> 200
    const noHeader = await callAnthropic(devAuth);
    expect(noHeader.statusCode).toBe(200);
    // with the header: project (disabled) outranks role (enabled) -> 404
    const withHeader = await callAnthropic(devAuth, { [PROJECT_HEADER]: scopeProjectId });
    expect(withHeader.statusCode).toBe(404);
    expect(withHeader.json()).toEqual(NOT_FOUND_MESSAGES);
  });

  it("user beats project: a user-scope enable wins over the project disable", async () => {
    await mkRule({ scopeKind: "user", scopeId: devId, anthropicCompatEnabled: true });
    const r = await callAnthropic(devAuth, { [PROJECT_HEADER]: scopeProjectId });
    expect(r.statusCode).toBe(200);
  });

  it("ties within a kind: the MOST RECENTLY CREATED rule wins", async () => {
    // a SECOND user rule for dev, newer, disabling the surface -> 404
    const newer = await mkRule({ scopeKind: "user", scopeId: devId, anthropicCompatEnabled: false });
    const off = await callAnthropic(devAuth);
    expect(off.statusCode).toBe(404);
    expect(off.json()).toEqual(NOT_FOUND_MESSAGES);
    // deleting the newer rule falls back to the older user rule -> 200
    await delRule(newer.id);
    const on = await callAnthropic(devAuth);
    expect(on.statusCode).toBe(200);
  });

  it("resolutionMode is scoped per field independently: a user-scope require_agent overrides the org map_by_model", async () => {
    const rule = await mkRule({ scopeKind: "user", scopeId: devId, resolutionMode: "require_agent" });
    const r = await callAnthropic(devAuth);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.regulait_code).toBe("agent_header_required");
    // naming the agent satisfies the scoped mode — and entitlement still gates
    const named = await callAnthropic(devAuth, { "x-regulait-agent-id": modelAgentId });
    expect(named.statusCode).toBe(200);
    await delRule(rule.id);
  });

  it("the live effective-value preview runs the same resolver and names its sources", async () => {
    const r = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/interception/effective?userId=${devId}&projectId=${scopeProjectId}`,
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    // user-scope enable (from the earlier test) wins for dev
    expect(body.effective.anthropicCompatEnabled).toBe(true);
    expect(body.sources.anthropicCompatEnabled.level).toBe("user");
    // no scoped openai rule -> org value + org source
    expect(body.sources.openaiCompatEnabled.level).toBe("org");
    expect(body.effective.openaiCompatEnabled).toBe(body.org.openaiCompatEnabled);
    expect(body.effective.resolutionMode).toBe("map_by_model");
  });

  it("scope-rule writes are audited and admin-only", async () => {
    const denied = await app.inject({
      method: "POST",
      headers: devAuth,
      url: "/v1/interception/scope-rules",
      payload: { scopeKind: "user", scopeId: devId, anthropicCompatEnabled: true },
    });
    expect(denied.statusCode).toBe(403);
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "interception-scope-rule-created"));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.objectType).toBe("interception_scope_rule");
  });
});

// ===========================================================================
// O15 — key custody: an ENFORCED rung, reversible, honestly displayed
// ===========================================================================

describe("O15: key_custody_enforced — 409s, dispatch skips user creds, reversible", () => {
  let userSrv: Awaited<ReturnType<typeof startFakeAnthropic>>;
  let platformSrv: Awaited<ReturnType<typeof startFakeAnthropic>>;
  let byoAgentId: string;
  // a DEDICATED user entitled ONLY to the anthropic agent, so pillar-6
  // routing has no cheaper mock candidate to downroute onto — which key
  // served is then the only variable under test
  let byoUserId: string;
  let byoAuth: { authorization: string };

  beforeAll(async () => {
    userSrv = await startFakeAnthropic("DEPTH-USER");
    platformSrv = await startFakeAnthropic("DEPTH-PLATFORM");
    const byo = await makeUser("depth-byo@example.com");
    byoUserId = byo.id;
    byoAuth = byo.auth;
    const agentRes = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/agents",
      payload: {
        name: "depth-byo-agent",
        provider: "anthropic",
        tier: 1,
        modes: ["execute"],
        costPerMTokIn: 5,
        costPerMTokOut: 25,
        model: "depth-claude",
      },
    });
    byoAgentId = agentRes.json().id;
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/agents",
      payload: { userId: byoUserId, agentId: byoAgentId },
    });
    // platform credential -> platform fake
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/model-credentials",
      payload: { provider: "anthropic", apiKey: "sk-depth-platform", baseUrl: platformSrv.url },
    });
    // the user's own BYO credential -> user fake (created while custody is OFF)
    const created = await app.inject({
      method: "POST",
      headers: byoAuth,
      url: `/v1/users/${byoUserId}/model-credentials`,
      payload: { provider: "anthropic", apiKey: "sk-depth-user", baseUrl: userSrv.url },
    });
    expect(created.statusCode).toBe(201);
  });

  afterAll(async () => {
    await setPosture({ keyCustodyEnforced: false, enforcementPosture: "voluntary" });
    await app.inject({ method: "DELETE", headers: AUTH, url: "/v1/model-credentials/anthropic" });
    await app.inject({
      method: "DELETE",
      headers: byoAuth,
      url: `/v1/users/${byoUserId}/model-credentials/anthropic`,
    });
    await userSrv.close();
    await platformSrv.close();
  });

  const invokeByo = () =>
    app.inject({
      method: "POST",
      headers: byoAuth,
      url: `/v1/agents/${byoAgentId}/invoke`,
      payload: { mode: "execute", input: "custody probe", dispatch: true },
    });

  it("custody OFF (default): the user's own key serves the dispatch", async () => {
    const r = await invokeByo();
    expect(r.statusCode).toBe(200);
    expect(r.json().dispatch.credentialSource).toBe("user");
    expect(r.json().dispatch.outputText).toBe("DEPTH-USER-reply");
    expect(userSrv.hits.length).toBe(1);
    expect(platformSrv.hits.length).toBe(0);
  });

  it("custody ON: credential create/update 409s with an explanation, and the refusal is audited", async () => {
    await setPosture({ keyCustodyEnforced: true, enforcementPosture: "key_custody" });
    const r = await app.inject({
      method: "POST",
      headers: byoAuth,
      url: `/v1/users/${byoUserId}/model-credentials`,
      payload: { provider: "anthropic", apiKey: "sk-depth-user-2", baseUrl: userSrv.url },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("key_custody_enforced");
    expect(r.json().detail).toContain("key custody");
    const [auditRow] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "key-custody-enforced"))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(auditRow).toBeDefined();
    expect(auditRow!.effect).toBe("deny");
  });

  it("custody ON: dispatch resolution SKIPS the stored user credential — the platform key serves", async () => {
    const r = await invokeByo();
    expect(r.statusCode).toBe(200);
    expect(r.json().dispatch.credentialSource).toBe("platform");
    expect(r.json().dispatch.outputText).toBe("DEPTH-PLATFORM-reply");
    // the user fake was NOT contacted again
    expect(userSrv.hits.length).toBe(1);
    expect(platformSrv.hits.length).toBe(1);
  });

  it("the stored user credential is inert, not deleted: it still lists", async () => {
    const listed = await app.inject({
      method: "GET",
      headers: byoAuth,
      url: `/v1/users/${byoUserId}/model-credentials`,
    });
    expect(listed.statusCode).toBe(200);
    expect(
      listed.json().credentials.some((c: { provider: string }) => c.provider === "anthropic"),
    ).toBe(true);
  });

  it("REVERSIBLE: custody back OFF restores the user's key with no re-entry", async () => {
    await setPosture({ keyCustodyEnforced: false });
    const r = await invokeByo();
    expect(r.statusCode).toBe(200);
    expect(r.json().dispatch.credentialSource).toBe("user");
    expect(r.json().dispatch.outputText).toBe("DEPTH-USER-reply");
    expect(userSrv.hits.length).toBe(2);
    expect(platformSrv.hits.length).toBe(1);
  });
});

// ===========================================================================
// O15 — honest posture display: enforced vs declared vs honor system
// ===========================================================================

describe("O15: posture display states enforced-vs-declared honestly", () => {
  afterAll(async () => {
    await setPosture({ enforcementPosture: "voluntary", keyCustodyEnforced: false });
  });

  const getPosture = async () => {
    const r = await app.inject({ method: "GET", headers: AUTH, url: "/v1/interception/settings" });
    expect(r.statusCode).toBe(200);
    return r.json().posture;
  };

  it("observe / voluntary are labeled honor system", async () => {
    await setPosture({ enforcementPosture: "voluntary", keyCustodyEnforced: false });
    expect(await getPosture()).toMatchObject({ rung: "voluntary", status: "honor_system" });
    await setPosture({ enforcementPosture: "observe" });
    expect(await getPosture()).toMatchObject({ rung: "observe", status: "honor_system" });
  });

  it("managed is labeled policy", async () => {
    await setPosture({ enforcementPosture: "managed" });
    expect(await getPosture()).toMatchObject({ rung: "managed", status: "policy" });
  });

  it("key_custody DECLARED without the toggle carries an explicit warning, never an enforcement claim", async () => {
    await setPosture({ enforcementPosture: "key_custody", keyCustodyEnforced: false });
    const p = await getPosture();
    expect(p.status).toBe("declared_not_enforced");
    expect(p.label).toContain("NOT enforced");
  });

  it("key_custody with the toggle ON is the one state labeled ENFORCED by this deployment", async () => {
    await setPosture({ enforcementPosture: "key_custody", keyCustodyEnforced: true });
    const p = await getPosture();
    expect(p.status).toBe("enforced");
    expect(p.label).toBe("ENFORCED by this deployment");
    await setPosture({ keyCustodyEnforced: false });
  });

  it("network points at the customer's egress boundary and the docs — not at this product", async () => {
    await setPosture({ enforcementPosture: "network" });
    const p = await getPosture();
    expect(p.status).toBe("external_infrastructure");
    expect(p.detail).toContain("IDE_INTEGRATION.md");
  });
});

// ===========================================================================
// Rider — prompt-cache estimation counts the admin systemPrompt base
// ===========================================================================

describe("prompt-cache estimation includes the served agent's admin systemPrompt base", () => {
  it("caller system below the cache minimum still caches (and lands a ledger row) when base+caller clears it", async () => {
    // minCacheableTokens default = 1024. Caller system alone: ~500 tokens
    // (below). Admin base: ~750 tokens. Composed: ~1251 tokens (above) — a
    // row exists ONLY because the estimate now counts the base.
    const adminBase = "B".repeat(3000);
    const callerSystem = "C".repeat(2000);
    const est = await makeUser("depth-estimate@example.com");
    const agentRes = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/agents",
      payload: {
        name: "depth-cache-agent",
        provider: "mock",
        tier: 1,
        model: "depth-cache-model",
        costPerMTokIn: 3,
        costPerMTokOut: 6,
        systemPrompt: adminBase,
      },
    });
    const cacheAgentId = agentRes.json().id;
    await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/agents",
      payload: { userId: est.id, agentId: cacheAgentId },
    });

    const r = await app.inject({
      method: "POST",
      headers: est.auth,
      url: `/v1/agents/${cacheAgentId}/invoke`,
      payload: { mode: "execute", input: "estimate probe", system: callerSystem, dispatch: true },
    });
    expect(r.statusCode).toBe(200);

    const rows = await db
      .select()
      .from(costEvents)
      .where(and(eq(costEvents.userId, est.id), eq(costEvents.technique, "prompt_caching")));
    expect(rows.length).toBe(1);
    const composed = adminBase + "\n\n" + callerSystem;
    const expectedTokens = Math.ceil(composed.length / 4);
    expect((rows[0]!.detail as { systemTokens: number }).systemTokens).toBe(expectedTokens);
    // and the estimate is the base+caller figure, not the caller-only one
    expect(expectedTokens).toBeGreaterThan(1024);
    expect(Math.ceil(callerSystem.length / 4)).toBeLessThan(1024);
  });
});
