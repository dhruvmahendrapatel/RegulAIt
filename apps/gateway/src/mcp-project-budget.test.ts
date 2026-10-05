import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  and,
  approvals,
  auditLog,
  createDb,
  eq,
  mcpServers,
  projects,
  runMigrations,
  usageEvents,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { executeGovernedToolCall, PROJECT_HEADER } from "./mcp-proxy.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";

// ADR-0181: this file pins behaviour against a LOCAL MCP double (127.0.0.1, registered
// seconds ago), not the strict admission defaults — relaxed explicitly, restored after.
let restoreStrictAdmission: (() => Promise<void>) | undefined;

/**
 * F02 / ADR-0103 — the pillar-5 PROJECT budget on the MCP tool-call path.
 *
 * The path was priced and attributed but never gated: `preDispatchProjectGate`
 * had exactly one production call site (the model/connector dispatch path), so
 * an attributed `tools/call` loop could run unbounded PAID spend against an
 * exhausted project. The gate now lives once inside the shared governed
 * tool-call primitive, so both entry points — the direct MCP proxy route and
 * pillar 7's delegated worker loop — inherit it.
 *
 * The acceptance criterion is strict: a blocked call must not merely return an
 * error, it must never have CONTACTED the upstream. The fake upstream below
 * therefore counts BOTH its HTTP requests and its tool-handler invocations, and
 * every block asserts a zero delta on both.
 *
 * Shares one DB (fileParallelism off) — every assertion is a DELTA, never an
 * absolute count. Prefix f02-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "f02-bootstrap-token";
/** Shared DB, re-runnable: every named object gets a per-run suffix so a second
 * run in the same database never collides on a unique name/email. */
const RUN = Math.random().toString(36).slice(2, 8);
const AUTH = { authorization: `Bearer ${BOOT}` };

const PAID = `f02_paid_${RUN}`;
const FREE = `f02_free_${RUN}`;
const PROFILE_TAG = `f02-finreg-${RUN}`;

/** The two independent proofs that a blocked call never reached upstream. */
const upstreamHits = { http: 0, tool: 0 };
const snapshotUpstream = () => ({ ...upstreamHits });

let db: Db;
let app: ReturnType<typeof buildApp>;
let gatewayUrl: string;
let upstreamClose: () => Promise<void>;
let serverId: string;
let userId: string;
let approverId: string;

async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
    upstreamHits.http++;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      void (async () => {
        const server = new McpServer({ name: "f02-upstream", version: "0.0.1" });
        for (const name of [PAID, FREE]) {
          server.registerTool(
            name,
            { description: `${name} read`, inputSchema: {}, annotations: { readOnlyHint: true } },
            async () => {
              upstreamHits.tool++;
              return { content: [{ type: "text", text: `${name} ran` }] };
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
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

async function mkUser(email: string): Promise<string> {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/users",
    payload: { email, displayName: email.split("@")[0] },
  });
  return r.json().id as string;
}
async function apiKeyFor(uid: string): Promise<string> {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${uid}/keys`, payload: { name: "f02-key" },
  });
  return r.json().token as string;
}
async function mkProject(payload: Record<string, unknown>): Promise<string> {
  const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/projects", payload });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}
/** Seed measured spend the same way the model path would have left it. */
async function spend(projectId: string, costUsd: number) {
  await db.insert(usageEvents).values({ userId, objectType: "agent", projectId, costUsd });
}
async function mcpUsageCount(toolName: string, projectId: string | null): Promise<number> {
  const rows = await db
    .select({ id: usageEvents.id })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.objectType, "mcp_tool"),
        eq(usageEvents.operation, toolName),
        ...(projectId ? [eq(usageEvents.projectId, projectId)] : []),
      ),
    );
  return rows.length;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "b".repeat(64) });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, requireMcpAttribution: false });
  gatewayUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  const up = await startUpstream();
  upstreamClose = up.close;

  const s = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/servers",
    payload: { name: `f02-server-${RUN}`, url: up.url },
  });
  serverId = s.json().id;
  // Server flat price stays NULL so FREE is genuinely unpriced; PAID carries a
  // per-tool override (O10 tool-first resolution).
  await db.update(mcpServers).set({ pricePerCallUsd: null }).where(eq(mcpServers.id, serverId));
  for (const name of [PAID, FREE]) {
    // Register the inventory row WITH its kind so no manifest sync — and thus
    // no upstream contact — is ever needed before the gate runs.
    await app.inject({
      method: "POST", headers: AUTH, url: `/v1/servers/${serverId}/tools`,
      payload: { name, kind: "read" },
    });
  }
  await app.inject({
    method: "PATCH", headers: AUTH, url: `/v1/servers/${serverId}/tools/${PAID}/price`,
    payload: { pricePerCallUsd: 0.05 },
  });

  userId = await mkUser(`f02-uma-${RUN}@example.com`);
  approverId = await mkUser(`f02-approver-${RUN}@example.com`);
  for (const name of [PAID, FREE]) {
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/tools",
      payload: { userId, serverId, toolName: name },
    });
  }
  // a framework whose budgetEnforcement is 'block' — the ADR-0027 O2 cascade
  // dimension the strictest-wins case below exercises on this path
  const profile = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/compliance/profiles",
    payload: { tag: PROFILE_TAG, budgetEnforcement: "block", piiMode: "log" },
  });
  expect(profile.statusCode).toBe(201);
});

afterAll(async () => {
  await restoreStrictAdmission?.();
  app.server.closeAllConnections();
  await restoreSb2Gates();
  await app.close();
  await upstreamClose();
});

describe("the exhausted project blocks a paid tool call BEFORE the upstream is contacted", () => {
  it("returns budget_blocked, contacts nothing, bills nothing", async () => {
    const projectId = await mkProject({
      name: `f02-exhausted-${RUN}`, budgetUsd: 0.01, budgetApproverUserId: approverId,
    });
    await spend(projectId, 0.5); // measured spend far past the budget

    const before = snapshotUpstream();
    const usageBefore = await mcpUsageCount(PAID, projectId);

    const out = await executeGovernedToolCall(db, undefined, {
      userId, serverId, toolName: PAID, projectId, arguments: {},
    });
    expect(out.kind).toBe("budget_blocked");
    if (out.kind === "budget_blocked") {
      expect(out.status).toBe(409);
      expect(out.error).toBe("project_budget_exceeded");
      expect(out.detail).toContain("hard-block threshold");
    }

    // THE acceptance criterion: the upstream was never spoken to at all —
    // neither an HTTP request nor a tool invocation.
    expect(snapshotUpstream()).toEqual(before);
    // ...and nothing was billed for it.
    expect(await mcpUsageCount(PAID, projectId)).toBe(usageBefore);
  });

  it("the block is one audited deny row naming the project-budget rule", async () => {
    const projectId = await mkProject({
      name: `f02-audited-${RUN}`, budgetUsd: 0.01, budgetApproverUserId: approverId,
    });
    await spend(projectId, 0.5);
    const out = await executeGovernedToolCall(db, undefined, {
      userId, serverId, toolName: PAID, projectId, arguments: {},
    });
    expect(out.kind).toBe("budget_blocked");
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "project-budget-cap"), eq(auditLog.toolName, PAID)));
    expect(rows.some((r) => r.effect === "deny" && r.serverId === serverId)).toBe(true);
  });

  it("an UNPRICED tool on the same exhausted project is blocked too — the gate keys on the project's spend, not on this call's price", async () => {
    const projectId = await mkProject({
      name: `f02-unpriced-${RUN}`, budgetUsd: 0.01, budgetApproverUserId: approverId,
    });
    await spend(projectId, 0.5);
    const before = snapshotUpstream();
    const out = await executeGovernedToolCall(db, undefined, {
      userId, serverId, toolName: FREE, projectId, arguments: {},
    });
    expect(out.kind).toBe("budget_blocked");
    expect(snapshotUpstream()).toEqual(before);
  });

  it("a project still UNDER its budget runs and bills normally", async () => {
    const projectId = await mkProject({
      name: `f02-healthy-${RUN}`, budgetUsd: 10, budgetApproverUserId: approverId,
    });
    const beforeTool = upstreamHits.tool;
    const usageBefore = await mcpUsageCount(PAID, projectId);
    const out = await executeGovernedToolCall(db, undefined, {
      userId, serverId, toolName: PAID, projectId, arguments: {},
    });
    expect(out.kind).toBe("allowed");
    expect(upstreamHits.tool).toBe(beforeTool + 1);
    expect(await mcpUsageCount(PAID, projectId)).toBe(usageBefore + 1);
  });
});

describe("the treatments that must NOT change", () => {
  it("an UNATTRIBUTED paid call is unaffected — it runs and lands in the null-project bucket", async () => {
    const beforeTool = upstreamHits.tool;
    const usageBefore = await mcpUsageCount(PAID, null);
    const out = await executeGovernedToolCall(db, undefined, {
      userId, serverId, toolName: PAID, arguments: {},
    });
    expect(out.kind).toBe("allowed");
    expect(upstreamHits.tool).toBe(beforeTool + 1);
    expect(await mcpUsageCount(PAID, null)).toBe(usageBefore + 1);
  });

  it("warn_only lets the call through, still bills it, and still escalates + audits the crossing", async () => {
    const current = await app.inject({ method: "GET", headers: AUTH, url: "/v1/org/settings" });
    const restore = current.json().budgetEnforcement ?? "block";
    await app.inject({
      method: "PUT", headers: AUTH, url: "/v1/org/settings",
      payload: { budgetEnforcement: "warn_only" },
    });
    try {
      const projectId = await mkProject({
        name: `f02-warn-only-${RUN}`, budgetUsd: 0.01, budgetApproverUserId: approverId,
      });
      await spend(projectId, 0.5);
      const beforeTool = upstreamHits.tool;
      const usageBefore = await mcpUsageCount(PAID, projectId);

      const out = await executeGovernedToolCall(db, undefined, {
        userId, serverId, toolName: PAID, projectId, arguments: {},
      });
      expect(out.kind).toBe("allowed");
      // behaviour parity with the model path: advisory, so it runs and bills
      expect(upstreamHits.tool).toBe(beforeTool + 1);
      expect(await mcpUsageCount(PAID, projectId)).toBe(usageBefore + 1);

      // ...but the crossing is still escalated into the ONE approvals queue
      const queued = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.projectId, projectId), eq(approvals.stageId, "__project_budget__")));
      expect(queued).toHaveLength(1);
      // ...and audited
      const audited = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.objectId, projectId), eq(auditLog.ruleId, "project-budget-cap")));
      expect(audited.length).toBeGreaterThan(0);
    } finally {
      await app.inject({
        method: "PUT", headers: AUTH, url: "/v1/org/settings",
        payload: { budgetEnforcement: restore },
      });
    }
  });
});

describe("the gate's other verdicts carry over to the MCP path unchanged", () => {
  it("a SANCTIONED overage lets the paid call through and bills it", async () => {
    const projectId = await mkProject({
      name: `f02-overage-${RUN}`, budgetUsd: 0.01, budgetApproverUserId: approverId,
    });
    await spend(projectId, 0.5);
    // what the named approver's decision on the __project_budget__ row writes
    await db.update(projects).set({ overageApproved: true, overageApprovedPeriod: null }).where(eq(projects.id, projectId));
    const beforeTool = upstreamHits.tool;
    const usageBefore = await mcpUsageCount(PAID, projectId);
    const out = await executeGovernedToolCall(db, undefined, {
      userId, serverId, toolName: PAID, projectId, arguments: {},
    });
    expect(out.kind).toBe("allowed");
    expect(upstreamHits.tool).toBe(beforeTool + 1);
    expect(await mcpUsageCount(PAID, projectId)).toBe(usageBefore + 1);
  });

  it("a compliance profile's budgetEnforcement 'block' overrides org warn_only (strictest wins) — blocked, untouched, unbilled", async () => {
    const current = await app.inject({ method: "GET", headers: AUTH, url: "/v1/org/settings" });
    const restore = current.json().budgetEnforcement ?? "block";
    await app.inject({
      method: "PUT", headers: AUTH, url: "/v1/org/settings",
      payload: { budgetEnforcement: "warn_only" },
    });
    try {
      const projectId = await mkProject({
        name: `f02-compliance-block-${RUN}`, budgetUsd: 0.01, budgetApproverUserId: approverId,
        classifications: [PROFILE_TAG],
      });
      await spend(projectId, 0.5);
      const before = snapshotUpstream();
      const usageBefore = await mcpUsageCount(PAID, projectId);
      const out = await executeGovernedToolCall(db, undefined, {
        userId, serverId, toolName: PAID, projectId, arguments: {},
      });
      expect(out.kind).toBe("budget_blocked");
      if (out.kind === "budget_blocked") {
        expect(out.status).toBe(409);
        expect(out.detail).toContain("blocking forced by the compliance cascade");
      }
      expect(snapshotUpstream()).toEqual(before);
      expect(await mcpUsageCount(PAID, projectId)).toBe(usageBefore);
    } finally {
      await app.inject({
        method: "PUT", headers: AUTH, url: "/v1/org/settings",
        payload: { budgetEnforcement: restore },
      });
    }
  });
});

describe("the direct MCP proxy route surfaces the block as a policy error", () => {
  it("tools/call with the project header on an exhausted project errors and never reaches upstream", async () => {
    const projectId = await mkProject({
      name: `f02-route-${RUN}`, budgetUsd: 0.01, budgetApproverUserId: approverId,
    });
    await spend(projectId, 0.5);
    const token = await apiKeyFor(userId);
    const client = new Client({ name: "f02-client", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp/${serverId}`), {
      requestInit: {
        headers: { authorization: `Bearer ${token}`, [PROJECT_HEADER]: projectId },
      },
    });
    await client.connect(transport);
    const beforeTool = upstreamHits.tool;
    await expect(client.callTool({ name: PAID, arguments: {} })).rejects.toThrow(
      /project_budget_exceeded/,
    );
    expect(upstreamHits.tool).toBe(beforeTool);
    await client.close();
  });
});

describe("the DELEGATED worker loop is equally protected (coverage consistency)", () => {
  it("a pillar-7 worker in a run attributed to an exhausted project cannot call a paid tool", async () => {
    // The node's FIRST model turn is what exhausts the project (first crossing
    // is allowed on the model path too), so the run reaches the tool loop with
    // the budget already blown — exactly the sequence F02 describes.
    const workerRes = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/agents",
      payload: {
        name: `f02-worker-${RUN}`, provider: "mock", tier: 0, modes: ["execute"],
        costPerMTokIn: 1_000_000, costPerMTokOut: 1_000_000, model: `mock-f02-${RUN}`,
      },
    });
    const workerId = workerRes.json().id as string;
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/agents",
      payload: { userId, agentId: workerId },
    });
    const projectId = await mkProject({
      name: `f02-delegated-${RUN}`, budgetUsd: 0.01, budgetApproverUserId: approverId,
    });
    const uAuth = { authorization: `Bearer ${await apiKeyFor(userId)}` };

    const created = await app.inject({
      method: "POST", headers: uAuth, url: "/v1/runs",
      payload: {
        projectId,
        graph: {
          run: `f02-delegated-run-${RUN}`,
          escalationApproverUserId: approverId,
          nodes: [
            {
              id: "a", title: "task a", ownerAgentId: workerId, mode: "execute",
              estimate: { in: 1, out: 1 },
              toolServers: [serverId],
              instruction: `please <<use-tool:${PAID}>> and report it`,
            },
          ],
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const runId = created.json().id as string;

    const beforeTool = upstreamHits.tool;
    const usageBefore = await mcpUsageCount(PAID, projectId);
    await app.inject({
      method: "POST", headers: uAuth, url: `/v1/runs/${runId}/auto`,
      payload: { acceptReviews: true },
    });

    const view = await app.inject({ method: "GET", headers: uAuth, url: `/v1/runs/${runId}` });
    const toolEvt = view.json().events.find(
      (e: { event: { kind: string } }) => e.event.kind === "node_tool_call",
    );
    expect(toolEvt).toBeDefined();
    expect(toolEvt.event).toMatchObject({ toolName: PAID, status: "budget_blocked" });
    // the worker never reached the upstream and never billed the tool
    expect(upstreamHits.tool).toBe(beforeTool);
    expect(await mcpUsageCount(PAID, projectId)).toBe(usageBefore);
  });
});
