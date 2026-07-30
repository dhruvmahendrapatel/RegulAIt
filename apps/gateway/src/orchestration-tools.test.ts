import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

/**
 * PILLAR 7 DEPTH — tool-using multi-turn workers. A worker node becomes a
 * governed agentic loop: the mock model requests an MCP tool (via the
 * <<use-tool:NAME>> sentinel), the gateway executes it through the SAME
 * governed+audited path the human proxy uses (re-checked under the INITIATING
 * user), feeds the result back, and the model finalizes. Every model turn is a
 * measured usage row billed to the run's project; every tool call is one audit
 * row; the per-run measured budget cap + the node's maxTurns bound the loop.
 *
 * Reuses the real-upstream MCP harness shape from mcp-proxy.test.ts. The loop
 * connects to the upstream directly (as the gateway does), so no gateway HTTP
 * listener or MCP client is needed — everything drives via app.inject.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

// --- upstream test MCP server (stateless: fresh server+transport per request) ---

function buildUpstreamMcpServer(): McpServer {
  const server = new McpServer({ name: "upstream-tools", version: "0.0.1" });
  server.registerTool(
    "get_time",
    { description: "Returns a fixed time", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: "text", text: "12:00" }] }),
  );
  server.registerTool(
    "write_note",
    { description: "Writes a note", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text: `wrote: ${text}` }] }),
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

const BOOT = "test-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let upstream: Awaited<ReturnType<typeof startUpstream>>;
let serverId: string;
let approverId: string;

async function mkUser(email: string, name: string): Promise<string> {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/users",
    payload: { email, displayName: name },
  });
  return r.json().id as string;
}
async function authFor(userId: string): Promise<{ authorization: string }> {
  const res = await app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${userId}/keys`, payload: { name: "k" },
  });
  return { authorization: `Bearer ${res.json().token}` };
}
async function mkAgent(payload: Record<string, unknown>): Promise<string> {
  const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/agents", payload });
  return r.json().id as string;
}
async function grantAgent(userId: string, agentId: string): Promise<void> {
  await app.inject({
    method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId, agentId },
  });
}
async function grantTool(userId: string, toolName: string): Promise<void> {
  await app.inject({
    method: "POST", headers: AUTH, url: "/v1/grants/tools", payload: { userId, serverId, toolName },
  });
}

const mkNode = (id: string, agentId: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `task ${id}`,
  ownerAgentId: agentId,
  mode: "execute",
  estimate: { in: 1, out: 1 },
  ...extra,
});

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  upstream = await startUpstream();
  approverId = await mkUser("otools-approver@example.com", "Otools Approver");
  const server = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/servers",
    payload: { name: "otools-upstream", url: upstream.url },
  });
  serverId = server.json().id;
});

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
  await upstream.close();
});

describe("(a) a granted tool drives the loop end-to-end, governed + metered per turn", () => {
  it("node calls the tool, quotes the result, audits the call, bills each turn to the project", async () => {
    const uid = await mkUser("otools-a@example.com", "Otools A");
    const uAuth = await authFor(uid);
    const workerId = await mkAgent({
      name: "otools-a-worker", provider: "mock", tier: 0, modes: ["execute"],
      costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-worker",
    });
    await grantAgent(uid, workerId);
    await grantTool(uid, "get_time");

    const project = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/projects", payload: { name: "otools-a-proj" },
    });
    const projectId = project.json().id;
    await app.inject({
      method: "POST", headers: AUTH, url: `/v1/projects/${projectId}/members`,
      payload: { userId: uid, role: "contributor" },
    });

    const created = await app.inject({
      method: "POST", headers: uAuth, url: "/v1/runs",
      payload: {
        projectId,
        graph: {
          run: "otools-a-run",
          escalationApproverUserId: approverId,
          nodes: [
            mkNode("a", workerId, {
              toolServers: [serverId],
              instruction: "check the clock: please <<use-tool:get_time>> and report it",
            }),
          ],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const runId = created.json().id;

    const auto = await app.inject({
      method: "POST", headers: uAuth, url: `/v1/runs/${runId}/auto`, payload: { acceptReviews: true },
    });
    expect(auto.statusCode).toBe(200);
    expect(auto.json().status).toBe("completed");

    const view = await app.inject({ method: "GET", headers: uAuth, url: `/v1/runs/${runId}` });
    const dispatched = view.json().events.find(
      (e: { event: { kind: string } }) => e.event.kind === "node_dispatched",
    );
    expect(dispatched.event.nodeId).toBe("a");
    // two model turns (tool_use then finalize) and one governed tool call
    expect(dispatched.event.turns).toBe(2);
    expect(dispatched.event.toolCalls).toBe(1);
    // the final answer quotes the tool's actual output
    expect(dispatched.event.outputText).toContain("12:00");

    // the loop's tool-call trace is on the run's append-only history
    const toolEvt = view.json().events.find(
      (e: { event: { kind: string } }) => e.event.kind === "node_tool_call",
    );
    expect(toolEvt.event).toMatchObject({ toolName: "get_time", serverId, status: "allowed" });

    // the tool call is ONE governed audit row with serverId + toolName
    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${uid}` });
    const toolRow = audit.json().entries.find(
      (e: { serverId: string | null; toolName: string | null; effect: string }) =>
        e.serverId === serverId && e.toolName === "get_time" && e.effect === "allow",
    );
    expect(toolRow).toBeDefined();

    // each model turn is a measured usage row billed to the run's project
    const ledger = await app.inject({ method: "GET", headers: AUTH, url: `/v1/usage-events?userId=${uid}` });
    const runRows = ledger.json().events.filter(
      (e: { detail: { runId?: string } | null }) => e.detail?.runId === runId,
    );
    expect(runRows).toHaveLength(2);
    expect(runRows.every((e: { projectId: string | null }) => e.projectId === projectId)).toBe(true);

    // ADR-0019: the worker's MCP TOOL call now bills to the run's project too,
    // on the same ledger — so the project total is the two model turns PLUS the
    // one governed tool call. Its cost is null here (the server has no
    // price_per_call_usd), which is the honest "unpriced, never invented" case.
    const mcpRows = ledger.json().events.filter(
      (e: { objectType: string; operation: string | null; projectId: string | null }) =>
        e.objectType === "mcp_tool" && e.operation === "get_time" && e.projectId === projectId,
    );
    expect(mcpRows).toHaveLength(1);
    expect(mcpRows[0].costUsd).toBeNull();

    const costs = await app.inject({ method: "GET", headers: uAuth, url: `/v1/projects/${projectId}/costs` });
    expect(costs.json().measured.events).toBe(3);
    expect(costs.json().byMcpTool).toEqual([
      { toolName: "get_time", costUsd: 0, events: 1 },
    ]);
  });
});

describe("(b) an ungranted tool mid-loop is blocked by governance; the node still finalizes honestly", () => {
  it("writes a deny audit row and the model reacts to the blocked tool_result", async () => {
    const uid = await mkUser("otools-b@example.com", "Otools B");
    const uAuth = await authFor(uid);
    const workerId = await mkAgent({
      name: "otools-b-worker", provider: "mock", tier: 0, modes: ["execute"],
      costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-worker",
    });
    await grantAgent(uid, workerId);
    // NOTE: get_time is deliberately NOT granted to this user

    const created = await app.inject({
      method: "POST", headers: uAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "otools-b-run",
          escalationApproverUserId: approverId,
          nodes: [
            mkNode("a", workerId, {
              toolServers: [serverId],
              instruction: "please <<use-tool:get_time>> then answer",
            }),
          ],
        },
      },
    });
    const runId = created.json().id;

    const auto = await app.inject({
      method: "POST", headers: uAuth, url: `/v1/runs/${runId}/auto`, payload: { acceptReviews: true },
    });
    expect(auto.statusCode).toBe(200);
    // the node still reaches a terminal state (finalized honestly, not hung)
    expect(auto.json().status).toBe("completed");

    // governance held: a deny audit row for the ungranted tool
    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${uid}` });
    const denyRow = audit.json().entries.find(
      (e: { serverId: string | null; toolName: string | null; effect: string }) =>
        e.serverId === serverId && e.toolName === "get_time" && e.effect === "deny",
    );
    expect(denyRow).toBeDefined();

    // the final answer references the blocked tool result rather than a fake success
    const view = await app.inject({ method: "GET", headers: uAuth, url: `/v1/runs/${runId}` });
    const dispatched = view.json().events.find(
      (e: { event: { kind: string } }) => e.event.kind === "node_dispatched",
    );
    expect(dispatched.event.outputText).toContain("blocked by governance");
    const toolEvt = view.json().events.find(
      (e: { event: { kind: string } }) => e.event.kind === "node_tool_call",
    );
    expect(toolEvt.event.status).toBe("denied");
  });
});

describe("(c) maxTurns caps a loop that keeps requesting tools", () => {
  it("halts after exactly maxTurns model turns / tool calls", async () => {
    const uid = await mkUser("otools-c@example.com", "Otools C");
    const uAuth = await authFor(uid);
    const workerId = await mkAgent({
      name: "otools-c-worker", provider: "mock", tier: 0, modes: ["execute"],
      costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-worker",
    });
    await grantAgent(uid, workerId);
    await grantTool(uid, "get_time");

    const created = await app.inject({
      method: "POST", headers: uAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "otools-c-run",
          escalationApproverUserId: approverId,
          nodes: [
            mkNode("a", workerId, {
              toolServers: [serverId],
              maxTurns: 3,
              instruction: "keep checking forever: <<use-tool-loop:get_time>>",
            }),
          ],
        },
      },
    });
    const runId = created.json().id;
    await app.inject({ method: "POST", headers: uAuth, url: `/v1/runs/${runId}/events`, payload: { kind: "start" } });
    await app.inject({
      method: "POST", headers: uAuth, url: `/v1/runs/${runId}/events`,
      payload: { kind: "node_started", nodeId: "a" },
    });
    const res = await app.inject({
      method: "POST", headers: uAuth, url: `/v1/runs/${runId}/nodes/a/dispatch`, payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dispatch.turns).toBe(3);
    expect(res.json().dispatch.toolCalls).toBe(3);

    const view = await app.inject({ method: "GET", headers: uAuth, url: `/v1/runs/${runId}` });
    const toolEvents = view.json().events.filter(
      (e: { event: { kind: string } }) => e.event.kind === "node_tool_call",
    );
    expect(toolEvents).toHaveLength(3);
  });
});

describe("(d) a rate-limit rule denies the Nth tool call mid-loop", () => {
  it("allows up to the cap, then denies inside the same loop", async () => {
    const uid = await mkUser("otools-d@example.com", "Otools D");
    const uAuth = await authFor(uid);
    const workerId = await mkAgent({
      name: "otools-d-worker", provider: "mock", tier: 0, modes: ["execute"],
      costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-worker",
    });
    await grantAgent(uid, workerId);
    await grantTool(uid, "get_time");
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/rules/rate-limits",
      payload: { userId: uid, serverId, toolName: "get_time", maxCalls: 2, windowSeconds: 3600 },
    });

    const created = await app.inject({
      method: "POST", headers: uAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "otools-d-run",
          escalationApproverUserId: approverId,
          nodes: [
            mkNode("a", workerId, {
              toolServers: [serverId],
              maxTurns: 4,
              instruction: "keep polling: <<use-tool-loop:get_time>>",
            }),
          ],
        },
      },
    });
    const runId = created.json().id;
    await app.inject({ method: "POST", headers: uAuth, url: `/v1/runs/${runId}/events`, payload: { kind: "start" } });
    await app.inject({
      method: "POST", headers: uAuth, url: `/v1/runs/${runId}/events`,
      payload: { kind: "node_started", nodeId: "a" },
    });
    const res = await app.inject({
      method: "POST", headers: uAuth, url: `/v1/runs/${runId}/nodes/a/dispatch`, payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dispatch.toolCalls).toBe(4);

    // exactly two allows, then denies — governance self-enforced mid-loop
    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${uid}` });
    const toolRows = audit
      .json()
      .entries.filter(
        (e: { serverId: string | null; toolName: string | null }) =>
          e.serverId === serverId && e.toolName === "get_time",
      );
    const allows = toolRows.filter((e: { effect: string }) => e.effect === "allow").length;
    const denies = toolRows.filter((e: { effect: string }) => e.effect === "deny").length;
    expect(allows).toBe(2);
    expect(denies).toBeGreaterThanOrEqual(1);
  });
});

describe("(e) the per-run measured budget halts the loop mid-way and escalates a __budget__ approval", () => {
  it("crosses the cap on the first turn, escalates once, and stops before the next turn", async () => {
    const uid = await mkUser("otools-e@example.com", "Otools E");
    const uAuth = await authFor(uid);
    const priceyId = await mkAgent({
      name: "otools-e-pricey", provider: "mock", tier: 0, modes: ["execute"],
      costPerMTokIn: 1_000_000, costPerMTokOut: 1_000_000, model: "mock-pricey",
    });
    await grantAgent(uid, priceyId);
    await grantTool(uid, "get_time");
    await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${uid}/agent-policy`,
      payload: { runBudgetUsd: 10, runBudgetBreachAction: "approve" },
    });

    const created = await app.inject({
      method: "POST", headers: uAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "otools-e-run",
          escalationApproverUserId: approverId,
          nodes: [
            mkNode("a", priceyId, {
              toolServers: [serverId],
              maxTurns: 6,
              instruction: "poll forever <<use-tool-loop:get_time>> " + "x".repeat(200),
            }),
          ],
        },
      },
    });
    expect(created.json().budgetApprovalPending).toBe(false);
    const runId = created.json().id;
    await app.inject({ method: "POST", headers: uAuth, url: `/v1/runs/${runId}/events`, payload: { kind: "start" } });
    await app.inject({
      method: "POST", headers: uAuth, url: `/v1/runs/${runId}/events`,
      payload: { kind: "node_started", nodeId: "a" },
    });
    const res = await app.inject({
      method: "POST", headers: uAuth, url: `/v1/runs/${runId}/nodes/a/dispatch`, payload: {},
    });
    expect(res.statusCode).toBe(200);
    // the loop halted after the first (cap-crossing) turn, not maxTurns later
    expect(res.json().dispatch.turns).toBe(1);
    expect(res.json().budgetBreached).toBe(true);
    expect(res.json().measuredSpentUsd).toBeGreaterThan(10);

    // a single __budget__:a escalation lands in the one approvals queue
    const view = await app.inject({ method: "GET", headers: uAuth, url: `/v1/runs/${runId}` });
    const budgetApprovals = view
      .json()
      .pendingApprovals.filter((a: { stageId: string }) => a.stageId === "__budget__:a");
    expect(budgetApprovals).toHaveLength(1);

    // the approver sanctions it → the loop can resume on a re-dispatch
    const decided = await app.inject({
      method: "POST", headers: await authFor(approverId),
      url: `/v1/approvals/${budgetApprovals[0].id}/decide`, payload: { decision: "approved" },
    });
    expect(decided.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// §5.1 Team-Lead entitlement-narrowing tier. The load-bearing proof: a worker
// under a lead is DENIED an agent/tool that the INITIATING USER *is* granted,
// because the lead's ceiling excludes it — the ceiling NARROWS, never relabels.
// ---------------------------------------------------------------------------

describe("(f) TOOL narrowing: a lead ceiling denies a granted tool a control node can still call", () => {
  it("worker under lead{get_time} is denied write_note (lead-ceiling); a lead-less control node calls it fine", async () => {
    const uid = await mkUser("otools-f@example.com", "Otools F");
    const uAuth = await authFor(uid);
    const workerId = await mkAgent({
      name: "otools-f-worker", provider: "mock", tier: 0, modes: ["execute"],
      costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-worker",
    });
    await grantAgent(uid, workerId);
    // the user IS granted BOTH tools — only the ceiling flips write_note for the worker
    await grantTool(uid, "get_time");
    await grantTool(uid, "write_note");

    const created = await app.inject({
      method: "POST", headers: uAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "otools-f-run",
          escalationApproverUserId: approverId,
          nodes: [
            mkNode("lead", workerId, { allowedToolRefs: ["get_time"], instruction: "coordinate the tool work" }),
            mkNode("w", workerId, {
              leadNodeId: "lead", dependsOn: ["lead"], toolServers: [serverId],
              instruction: "please <<use-tool:write_note>> then report",
            }),
            mkNode("c", workerId, {
              toolServers: [serverId],
              instruction: "please <<use-tool:write_note>> then report",
            }),
          ],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const runId = created.json().id;

    const auto = await app.inject({
      method: "POST", headers: uAuth, url: `/v1/runs/${runId}/auto`, payload: { acceptReviews: true },
    });
    expect(auto.statusCode).toBe(200);
    expect(auto.json().status).toBe("completed");

    const view = await app.inject({ method: "GET", headers: uAuth, url: `/v1/runs/${runId}` });
    const toolEvents = view.json().events.filter(
      (e: { event: { kind: string } }) => e.event.kind === "node_tool_call",
    );
    const wCall = toolEvents.find((e: { event: { nodeId: string } }) => e.event.nodeId === "w");
    const cCall = toolEvents.find((e: { event: { nodeId: string } }) => e.event.nodeId === "c");
    // the worker's write_note is DENIED by the ceiling; the control's is ALLOWED
    expect(wCall.event).toMatchObject({ toolName: "write_note", status: "denied" });
    expect(cCall.event).toMatchObject({ toolName: "write_note", status: "allowed" });

    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${uid}` });
    const writeRows = audit.json().entries.filter(
      (e: { serverId: string | null; toolName: string | null }) =>
        e.serverId === serverId && e.toolName === "write_note",
    );
    // the ceiling deny carries the distinct ruleId `lead-ceiling` into the audit trail
    const denyRow = writeRows.find((e: { effect: string }) => e.effect === "deny");
    expect(denyRow).toBeDefined();
    expect(denyRow.ruleId).toBe("lead-ceiling");
    // and the SAME user's SAME grant allows write_note on the control node — proving
    // the grant is real and only the ceiling narrows it
    const allowRow = writeRows.find((e: { effect: string }) => e.effect === "allow");
    expect(allowRow).toBeDefined();
  });
});

describe("(g) AGENT narrowing: a lead ceiling denies a granted owner at plan time", () => {
  it("worker owned by B under lead{A} is denied agent-lead-ceiling; the identical lead-less node plans fine", async () => {
    const uid = await mkUser("otools-g@example.com", "Otools G");
    const uAuth = await authFor(uid);
    const agentA = await mkAgent({
      name: "otools-g-A", provider: "mock", tier: 0, modes: ["execute"],
      costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-a",
    });
    const agentB = await mkAgent({
      name: "otools-g-B", provider: "mock", tier: 0, modes: ["execute"],
      costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-b",
    });
    await grantAgent(uid, agentA);
    await grantAgent(uid, agentB); // B IS granted to the user — only the ceiling excludes it

    const denied = await app.inject({
      method: "POST", headers: uAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "otools-g-run",
          escalationApproverUserId: approverId,
          nodes: [
            mkNode("lead", agentA, { allowedAgentIds: [agentA] }),
            mkNode("w", agentB, { leadNodeId: "lead" }),
          ],
        },
      },
    });
    expect(denied.statusCode).toBe(422);
    expect(denied.json().error).toBe("entitlement_exceeded");
    const wDenial = denied.json().nodes.find((n: { nodeId: string }) => n.nodeId === "w");
    expect(wDenial.decision.ruleId).toBe("agent-lead-ceiling");

    // the SAME owner B, same user, WITHOUT a lead → allowed. The ceiling narrows, nothing else.
    const ok = await app.inject({
      method: "POST", headers: uAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "otools-g-run-flat",
          escalationApproverUserId: approverId,
          nodes: [mkNode("w2", agentB)],
        },
      },
    });
    expect(ok.statusCode).toBe(201);
  });
});

describe("(h) transitivity: the ceiling narrows at EACH hop; a grandchild can't exceed the top", () => {
  it("owner C is allowed one hop down (child) but denied two hops down (grandchild) because child narrowed it", async () => {
    const uid = await mkUser("otools-h@example.com", "Otools H");
    const uAuth = await authFor(uid);
    const mk = (n: string) => mkAgent({
      name: `otools-h-${n}`, provider: "mock", tier: 0, modes: ["execute"],
      costPerMTokIn: 1, costPerMTokOut: 5, model: `mock-${n}`,
    });
    const agentA = await mk("a");
    const agentB = await mk("b");
    const agentC = await mk("c");
    for (const a of [agentA, agentB, agentC]) await grantAgent(uid, a);

    const res = await app.inject({
      method: "POST", headers: uAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "otools-h-run",
          escalationApproverUserId: approverId,
          nodes: [
            mkNode("lead", agentA, { allowedAgentIds: [agentA, agentB, agentC] }),
            // child owner C is inside the lead's {A,B,C} ceiling → allowed
            mkNode("child", agentC, { leadNodeId: "lead", allowedAgentIds: [agentA, agentB] }),
            // grandchild ceiling = child{A,B} ∩ lead{A,B,C} = {A,B}; owner C excluded
            mkNode("grand", agentC, { leadNodeId: "child" }),
          ],
        },
      },
    });
    expect(res.statusCode).toBe(422);
    const deniedIds = res.json().nodes.map((n: { nodeId: string }) => n.nodeId);
    expect(deniedIds).toContain("grand");
    expect(deniedIds).not.toContain("child"); // C fine one hop down, forbidden two hops down
    const grand = res.json().nodes.find((n: { nodeId: string }) => n.nodeId === "grand");
    expect(grand.decision.ruleId).toBe("agent-lead-ceiling");
  });
});

describe("(i) re-plan safety: a budget re-plan never moves a node onto a ceiling-forbidden agent", () => {
  it("substitutes a lead-less node to the cheaper agent but leaves a ceiling-capped node on its pricey owner", async () => {
    const uid = await mkUser("otools-i@example.com", "Otools I");
    const uAuth = await authFor(uid);
    const priceyId = await mkAgent({
      name: "otools-i-pricey", provider: "mock", tier: 0, modes: ["execute"],
      costPerMTokIn: 1000, costPerMTokOut: 1000, model: "mock-pricey",
    });
    const cheapId = await mkAgent({
      name: "otools-i-cheap", provider: "mock", tier: 0, modes: ["execute"],
      costPerMTokIn: 1, costPerMTokOut: 1, model: "mock-cheap",
    });
    await grantAgent(uid, priceyId);
    await grantAgent(uid, cheapId); // cheap IS granted — a normal re-plan would jump to it
    // low cap + replan breach action → the pre-execution re-plan kicks in
    await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${uid}/agent-policy`,
      payload: { runBudgetUsd: 0.0001, runBudgetBreachAction: "replan" },
    });

    const created = await app.inject({
      method: "POST", headers: uAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "otools-i-run",
          escalationApproverUserId: approverId,
          nodes: [
            // lead's ceiling EXCLUDES the cheap agent
            mkNode("lead", cheapId, { allowedAgentIds: [priceyId] }),
            mkNode("capped", priceyId, { leadNodeId: "lead" }),
            mkNode("control", priceyId, {}),
          ],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const runId = created.json().id;

    const view = await app.inject({ method: "GET", headers: uAuth, url: `/v1/runs/${runId}` });
    const owners = view.json().run.state.owners as Record<string, string>;
    // the lead-less control node WAS substituted to the cheaper agent...
    expect(owners.control).toBe(cheapId);
    // ...but the ceiling-capped node was NOT — cheap is forbidden by its lead
    expect(owners.capped).toBe(priceyId);
  });
});
