import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

/**
 * TIGHTEN-ONLY DELEGATION CONFORMANCE SUITE (docs/product/DELEGATION_CONFORMANCE.md,
 * ADR-0078). The delegation lattice enumerated systematically: for each
 * entitlement DIMENSION (agent allow-list / tool refs / budget cap) at each
 * composition LEVEL (user grant / lead ceiling / nested-lead ceiling / run
 * budget / node budget), composition must be INTERSECTION (sets) or MIN
 * (budgets) — never widening. Each test here pins exactly one cell of the
 * conformance table in DELEGATION_CONFORMANCE.md; the table cites this file's
 * test names verbatim, so renaming a test is a spec change.
 *
 * Design of the probes (every dimension uses the SAME lattice shape):
 *
 *     user granted {A,B,C,E}   (D exists, never granted)
 *     gp   lead ceiling {A,B,D,E}   — excludes C, and ONLY gp excludes C
 *     mid  lead ceiling {B,C,D,E}   — excludes A, and ONLY mid excludes A
 *     w    (leadNodeId: mid; mid's leadNodeId: gp)
 *
 *     effective(w) = granted ∩ gp ∩ mid = {B,E}
 *
 * Because each excluded member is vetoed by exactly ONE level, each denial
 * probe FAILS if that one level is skipped:
 *   · A denied  → only the DIRECT lead vetoes it   (skip mid   ⇒ test fails)
 *   · C denied  → only the GRANDPARENT vetoes it   (skip gp    ⇒ test fails —
 *                 the three-level chain proof)
 *   · D denied  → only the USER-GRANT level vetoes it (both ceilings admit D;
 *                 a ceiling that could GRANT would let D through ⇒ test fails)
 *   · E allowed → the control (M-002): proves the probe point actually works,
 *                 so the denials above are the lattice, not general breakage.
 *
 * Bypass-proofs (M-002, recorded in ADR-0078): each dimension's chain probe was
 * shown to FAIL by temporarily bypassing one composition point — the kernel
 * lead-chain walk truncated to one hop (agent + tool nested cells fail), the
 * dispatch loop's ceiling pass-through nulled (tool lead cells fail), and
 * computeNodeBudgetCeiling's lead fold dropped (budget lead/nested cells fail)
 * — then reverted.
 *
 * The core "never exceeds at EXECUTION time" attacks (revocation mid-run,
 * admin-driven runs, the auto loop) live in pillar7-inheritance.test.ts and are
 * NOT duplicated here; this suite adds the systematic lattice enumeration.
 *
 * Shares one DB (fileParallelism off); everything is prefixed dconf-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "dconf-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

// --- upstream test MCP server (same stateless harness shape as
// orchestration-tools.test.ts): four tools so every lattice role has a
// dedicated probe tool ---
function buildUpstreamMcpServer(): McpServer {
  const server = new McpServer({ name: "dconf-upstream", version: "0.0.1" });
  for (const name of ["dconf_alpha", "dconf_beta", "dconf_gamma", "dconf_delta"]) {
    server.registerTool(
      name,
      { description: `probe tool ${name}`, inputSchema: {}, annotations: { readOnlyHint: true } },
      async () => ({ content: [{ type: "text", text: `${name}-ok` }] }),
    );
  }
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

let db: Db;
let app: ReturnType<typeof buildApp>;
let upstream: Awaited<ReturnType<typeof startUpstream>>;
let serverId: string;

let danaId: string; // the initiating user for agent/tool lattices
let danaAuth: { authorization: string };
let approverId: string;
let approverAuth: { authorization: string };
// the agent lattice roles (see file header): D exists but is never granted
let agA: string, agB: string, agC: string, agD: string, agE: string;
let pricey: string; // 5/25 per MTok → a 100k/100k node estimates at $3.00

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/users",
    payload: { email, displayName: email.split("@")[0] },
  });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "t" },
  });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}
async function mkAgent(name: string, costIn = 1, costOut = 5) {
  const a = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/agents",
    payload: {
      name, provider: "mock", tier: 0, modes: ["execute"],
      costPerMTokIn: costIn, costPerMTokOut: costOut, model: `mock-${name}`,
    },
  });
  expect(a.statusCode).toBe(201);
  return a.json().id as string;
}
const grantAgent = (userId: string, agentId: string) =>
  app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId, agentId } });
const grantTool = (userId: string, toolName: string) =>
  app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/tools", payload: { userId, serverId, toolName } });

const mkNode = (id: string, agentId: string, extra: Record<string, unknown> = {}) => ({
  id, title: `task ${id}`, ownerAgentId: agentId, mode: "execute",
  estimate: { in: 1, out: 1 }, ...extra,
});
async function createRun(name: string, nodes: unknown[], auth = danaAuth, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST", headers: auth, url: "/v1/runs",
    payload: { graph: { run: name, escalationApproverUserId: approverId, nodes }, ...extra },
  });
}
const event = (runId: string, body: Record<string, unknown>, auth = danaAuth) =>
  app.inject({ method: "POST", headers: auth, url: `/v1/runs/${runId}/events`, payload: body });

/** create a run and drive node `w` to the BLOCKED state, where reassignment is
 * legal — the same idiom pillar7-inheritance.test.ts uses */
async function blockedW(name: string, nodes: unknown[]) {
  const created = await createRun(name, nodes);
  expect(created.statusCode).toBe(201);
  const runId = created.json().id as string;
  expect((await event(runId, { kind: "start" })).statusCode).toBe(200);
  expect((await event(runId, { kind: "node_started", nodeId: "w" })).statusCode).toBe(200);
  expect((await event(runId, { kind: "node_failed", nodeId: "w", error: "boom" })).statusCode).toBe(200);
  return runId;
}
const reassign = (runId: string, ownerAgentId: string) =>
  event(runId, { kind: "reassign_node", nodeId: "w", ownerAgentId });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });
  upstream = await startUpstream();

  const dana = await makeUser("dconf-dana@example.com");
  danaId = dana.id; danaAuth = dana.auth;
  const ap = await makeUser("dconf-approver@example.com");
  approverId = ap.id; approverAuth = ap.auth;

  agA = await mkAgent("dconf-A");
  agB = await mkAgent("dconf-B");
  agC = await mkAgent("dconf-C");
  agD = await mkAgent("dconf-D"); // exists, NEVER granted — the user-grant probe
  agE = await mkAgent("dconf-E");
  for (const a of [agA, agB, agC, agE]) await grantAgent(danaId, a);
  pricey = await mkAgent("dconf-pricey", 5, 25);
  await grantAgent(danaId, pricey);

  const server = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/servers",
    payload: { name: "dconf-upstream", url: upstream.url },
  });
  expect(server.statusCode).toBe(201);
  serverId = server.json().id;
  // granted: alpha, beta, gamma. dconf_delta exists upstream, NEVER granted.
  for (const t of ["dconf_alpha", "dconf_beta", "dconf_gamma"]) await grantTool(danaId, t);

  // a generous run cap so the agent/tool lattices never touch the budget gates;
  // per-user knob on a per-test user, so nothing process-wide is mutated (M-012)
  await app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${danaId}/agent-policy`,
    payload: { runBudgetUsd: 100, runBudgetBreachAction: "approve" },
  });
});

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
  await upstream.close();
});

// the shared lattice: gp excludes ONLY C, mid excludes ONLY A, grants exclude
// ONLY D — each denial isolates one composition level (see file header)
const agentLattice = () => [
  mkNode("gp", agB, { allowedAgentIds: [agA, agB, agD, agE] }),
  mkNode("mid", agB, { leadNodeId: "gp", allowedAgentIds: [agB, agC, agD, agE] }),
  mkNode("w", agB, { leadNodeId: "mid" }),
];

describe("AGENT dimension — composition is the INTERSECTION of user grants and every lead ceiling", () => {
  it("[agent × lead ceiling] the DIRECT lead's exclusion vetoes a granted agent at reassign", async () => {
    const runId = await blockedW("dconf-agent-direct", agentLattice());
    // A is granted and inside gp's ceiling — ONLY mid excludes it
    const res = await reassign(runId, agA);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("entitlement_exceeded");
    expect(res.json().decision.ruleId).toBe("agent-lead-ceiling");
  });

  it("[agent × nested-lead ceiling] the GRANDPARENT's exclusion vetoes through an admitting direct lead (three-level chain)", async () => {
    const runId = await blockedW("dconf-agent-nested", agentLattice());
    // C is granted and inside mid's (the direct lead's) ceiling — ONLY gp, two
    // levels up, excludes it. If the ceiling fold stopped at the direct lead,
    // this reassign would succeed and this test would FAIL.
    const res = await reassign(runId, agC);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("entitlement_exceeded");
    expect(res.json().decision.ruleId).toBe("agent-lead-ceiling");
  });

  it("[agent × user grant] both ceilings admit D, but the user was never granted it — a ceiling can never GRANT", async () => {
    const runId = await blockedW("dconf-agent-grant", agentLattice());
    const res = await reassign(runId, agD);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("entitlement_exceeded");
    // the denial comes from the GRANT level, not the ceiling — pinning that the
    // user-grant check still runs when every ceiling passes
    expect(res.json().decision.ruleId).toBe("default-deny");
  });

  it("[agent control] E — granted AND inside both ceilings — reassigns fine, so the denials above are the lattice, not breakage", async () => {
    const runId = await blockedW("dconf-agent-control", agentLattice());
    const res = await reassign(runId, agE);
    expect(res.statusCode).toBe(200);
  });

  it("[agent × plan time] the same lattice holds at run creation: C (nested veto) and D (grant veto) are refused as initial owners", async () => {
    // owner C: only the grandparent excludes it — plan-time nested-chain proof
    const nested = await createRun("dconf-agent-plan-nested", [
      mkNode("gp", agB, { allowedAgentIds: [agA, agB, agD, agE] }),
      mkNode("mid", agB, { leadNodeId: "gp", allowedAgentIds: [agB, agC, agD, agE] }),
      mkNode("w", agC, { leadNodeId: "mid" }),
    ]);
    expect(nested.statusCode).toBe(422);
    expect(nested.json().error).toBe("entitlement_exceeded");
    const wNested = nested.json().nodes.find((n: { nodeId: string }) => n.nodeId === "w");
    expect(wNested.decision.ruleId).toBe("agent-lead-ceiling");

    // owner D: both ceilings admit it, the grant level alone refuses
    const ungranted = await createRun("dconf-agent-plan-grant", [
      mkNode("gp", agB, { allowedAgentIds: [agA, agB, agD, agE] }),
      mkNode("mid", agB, { leadNodeId: "gp", allowedAgentIds: [agB, agC, agD, agE] }),
      mkNode("w", agD, { leadNodeId: "mid" }),
    ]);
    expect(ungranted.statusCode).toBe(422);
    const wGrant = ungranted.json().nodes.find((n: { nodeId: string }) => n.nodeId === "w");
    expect(wGrant.decision.ruleId).toBe("default-deny");
  });
});

describe("TOOL dimension — the same lattice, enforced per governed tool call inside the worker loop", () => {
  it("[tool × all levels + control] alpha (direct veto), gamma (nested veto), delta (grant veto) deny; beta (in everything) allows", async () => {
    // gp allows {alpha, beta, delta} — excludes ONLY gamma
    // mid allows {beta, gamma, delta} — excludes ONLY alpha
    // grants cover {alpha, beta, gamma} — exclude ONLY delta
    // → effective(worker) = {beta}
    const created = await createRun("dconf-tool-lattice", [
      mkNode("gp", agB, { allowedToolRefs: ["dconf_alpha", "dconf_beta", "dconf_delta"] }),
      mkNode("mid", agB, {
        leadNodeId: "gp", allowedToolRefs: ["dconf_beta", "dconf_gamma", "dconf_delta"],
      }),
      mkNode("wa", agB, {
        leadNodeId: "mid", toolServers: [serverId],
        instruction: "please <<use-tool:dconf_alpha>> then report",
      }),
      mkNode("wg", agB, {
        leadNodeId: "mid", toolServers: [serverId],
        instruction: "please <<use-tool:dconf_gamma>> then report",
      }),
      mkNode("wd", agB, {
        leadNodeId: "mid", toolServers: [serverId],
        instruction: "please <<use-tool:dconf_delta>> then report",
      }),
      mkNode("wb", agB, {
        leadNodeId: "mid", toolServers: [serverId],
        instruction: "please <<use-tool:dconf_beta>> then report",
      }),
    ]);
    expect(created.statusCode).toBe(201);
    const runId = created.json().id;

    const auto = await app.inject({
      method: "POST", headers: danaAuth, url: `/v1/runs/${runId}/auto`, payload: { acceptReviews: true },
    });
    expect(auto.statusCode).toBe(200);
    expect(auto.json().status).toBe("completed");

    const view = await app.inject({ method: "GET", headers: danaAuth, url: `/v1/runs/${runId}` });
    const toolEvents = view.json().events.filter(
      (e: { event: { kind: string } }) => e.event.kind === "node_tool_call",
    );
    const byNode = (nodeId: string) =>
      toolEvents.find((e: { event: { nodeId: string } }) => e.event.nodeId === nodeId)?.event;

    // [tool × lead ceiling] alpha: granted, gp admits it — ONLY mid excludes it
    expect(byNode("wa")).toMatchObject({ toolName: "dconf_alpha", status: "denied" });
    // [tool × nested-lead ceiling] gamma: granted, mid (direct) admits it —
    // ONLY gp, two levels up, excludes it (three-level chain). If the fold
    // stopped at the direct lead this would be "allowed" and the test FAILS.
    expect(byNode("wg")).toMatchObject({ toolName: "dconf_gamma", status: "denied" });
    // [tool × user grant] delta: BOTH ceilings admit it; never granted
    expect(byNode("wd")).toMatchObject({ toolName: "dconf_delta", status: "denied" });
    // [tool control] beta: granted and inside both ceilings
    expect(byNode("wb")).toMatchObject({ toolName: "dconf_beta", status: "allowed" });

    // the audit trail pins WHICH level denied each probe: ceiling denials carry
    // ruleId `lead-ceiling`, the grant denial carries `default-deny`
    const audit = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit?userId=${danaId}` });
    const rows = audit.json().entries as Array<{
      serverId: string | null; toolName: string | null; effect: string; ruleId: string | null;
    }>;
    const denyRule = (tool: string) =>
      rows.find((e) => e.serverId === serverId && e.toolName === tool && e.effect === "deny")?.ruleId;
    expect(denyRule("dconf_alpha")).toBe("lead-ceiling");
    expect(denyRule("dconf_gamma")).toBe("lead-ceiling");
    expect(denyRule("dconf_delta")).toBe("default-deny");
    expect(
      rows.find((e) => e.serverId === serverId && e.toolName === "dconf_beta" && e.effect === "allow"),
    ).toBeTruthy();
  });
});

describe("BUDGET dimension — the effective per-node cap is the MIN across the node and every lead above it", () => {
  // a 100k/100k node under the 5/25 pricey agent estimates at exactly $3.00
  const bigNode = (extra: Record<string, unknown> = {}) =>
    mkNode("w", pricey, { estimate: { in: 100_000, out: 100_000 }, ...extra });

  it("[budget × node budget] the node's OWN cap binds under loose leads (MIN picks $1 out of {1, 50, 50})", async () => {
    const created = await createRun("dconf-bud-own", [
      mkNode("gp", pricey, { budgetCapUsd: 50 }),
      mkNode("mid", pricey, { leadNodeId: "gp", budgetCapUsd: 50 }),
      bigNode({ leadNodeId: "mid", budgetCapUsd: 1 }),
    ]);
    expect(created.statusCode).toBe(201);
    const runId = created.json().id;
    expect((await event(runId, { kind: "start" })).statusCode).toBe(200);
    const started = await event(runId, { kind: "node_started", nodeId: "w" });
    expect(started.statusCode).toBe(409);
    expect(started.json().error).toBe("node_budget_exceeded");
    expect(started.json().nodeCapUsd).toBe(1); // the MIN, not a lead's 50
  });

  it("[budget × lead ceiling] the DIRECT lead's lower cap binds ($2 out of {none, 5, 2}); skipping that level would let $3 pass", async () => {
    const created = await createRun("dconf-bud-direct", [
      mkNode("gp", pricey, { budgetCapUsd: 5 }),
      mkNode("mid", pricey, { leadNodeId: "gp", budgetCapUsd: 2 }),
      bigNode({ leadNodeId: "mid" }), // no own cap
    ]);
    const runId = created.json().id;
    expect((await event(runId, { kind: "start" })).statusCode).toBe(200);
    const started = await event(runId, { kind: "node_started", nodeId: "w" });
    // effective MIN(5, 2) = $2 < $3 estimate → breach. If the fold skipped the
    // direct lead the effective cap would be $5 > $3 and this would be 200.
    expect(started.statusCode).toBe(409);
    expect(started.json().error).toBe("node_budget_exceeded");
    expect(started.json().nodeCapUsd).toBe(2);
  });

  it("[budget × nested-lead ceiling] the GRANDPARENT's lower cap binds through a looser direct lead ($2 out of {none, 2, 5}) — three-level MIN proof", async () => {
    const created = await createRun("dconf-bud-nested", [
      mkNode("gp", pricey, { budgetCapUsd: 2 }),
      mkNode("mid", pricey, { leadNodeId: "gp", budgetCapUsd: 5 }),
      bigNode({ leadNodeId: "mid" }),
    ]);
    const runId = created.json().id;
    expect((await event(runId, { kind: "start" })).statusCode).toBe(200);
    const started = await event(runId, { kind: "node_started", nodeId: "w" });
    // MIN(2, 5) = $2 < $3 → breach reported AT THE GRANDPARENT'S figure. If the
    // fold stopped at the direct lead: cap $5 > $3 → 200 → this test FAILS.
    expect(started.statusCode).toBe(409);
    expect(started.json().error).toBe("node_budget_exceeded");
    expect(started.json().nodeCapUsd).toBe(2);
  });

  it("[budget control] caps above the estimate everywhere (MIN {none, 5, 4} = $4 > $3) start cleanly — the gates fire on the MIN, not on the presence of caps", async () => {
    const created = await createRun("dconf-bud-control", [
      mkNode("gp", pricey, { budgetCapUsd: 5 }),
      mkNode("mid", pricey, { leadNodeId: "gp", budgetCapUsd: 4 }),
      bigNode({ leadNodeId: "mid" }),
    ]);
    const runId = created.json().id;
    expect((await event(runId, { kind: "start" })).statusCode).toBe(200);
    expect((await event(runId, { kind: "node_started", nodeId: "w" })).statusCode).toBe(200);
  });

  it("[budget × run budget] the run-level cap comes from the initiating user's policy and blocks the whole run pending approval", async () => {
    // a dedicated user so the tight cap never leaks into other tests (M-012)
    const carla = await makeUser("dconf-carla@example.com");
    await grantAgent(carla.id, pricey);
    await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${carla.id}/agent-policy`,
      payload: { runBudgetUsd: 1, runBudgetBreachAction: "approve" },
    });
    const created = await createRun("dconf-bud-run", [bigNode()], carla.auth);
    expect(created.statusCode).toBe(201);
    expect(created.json().budgetApprovalPending).toBe(true);
    expect(created.json().budget.capUsd).toBe(1);
    const runId = created.json().id;
    // over-cap runs cannot even START until the __budget__ approval is decided
    const start = await event(runId, { kind: "start" }, carla.auth);
    expect(start.statusCode).toBe(409);
    expect(start.json().error).toBe("budget_approval_pending");
    // the escalation is in the ONE approvals queue, on the run's __budget__ stage
    const inbox = await app.inject({ method: "GET", headers: approverAuth, url: "/v1/approvals?status=pending" });
    const entry = inbox.json().approvals.find(
      (x: { runId: string | null; stageId: string | null }) => x.runId === runId && x.stageId === "__budget__",
    );
    expect(entry).toBeTruthy();
  });

  it("[budget × user grant] there is NO request surface that widens the cap: a smuggled budget in the payload is stripped, the policy figure stands", async () => {
    // dana's policy says $100; the payload tries to hand itself $999,999
    const created = await createRun("dconf-bud-nowiden", [mkNode("w", agB)], danaAuth, {
      budget: { capUsd: 999_999, overageApproved: true },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().budget.capUsd).toBe(100); // the POLICY's number, not the payload's
    expect(created.json().budget.overageApproved).toBe(false);
  });
});
