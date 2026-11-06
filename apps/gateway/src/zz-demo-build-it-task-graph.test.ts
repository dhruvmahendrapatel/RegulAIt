import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditLog, createDb, eq, runMigrations, usageEvents, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { autoGrantCreatedAgentsForTest } from "./testing/agent-own-grants.js";
import { installLicenseFixture, removeLicenseFixture } from "./testing/license-fixture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";

/**
 * Smoke test for the demo's "Build it" act, beat B3 (DEMO_SCRIPT_2026-11-01, addendum of 2026-10-31):
 * the task-graph flow the presenter walks on /runs, end to end, with the demo's three mock agents
 * (the same names, tiers and prices as `seed.ts`, prefixed so the shared test database stays clean).
 *
 *   decompose a goal → create the run from the proposal → Auto-advance with reviews accepted →
 *   every node is terminal (done), each through a governed dispatch that is metered and audited;
 *   and a node naming an agent the caller is not entitled to is never run: the lead's suggestion is
 *   substituted, and a human edit that puts it back is refused at plan time.
 *
 * The parts already covered elsewhere (decompose.test.ts, mcp-proxy.test.ts "auto-dispatch of ready
 * nodes") are not repeated in depth; this file pins the whole chain the demo relies on, in one place.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "dbit-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);
// the mock lead's own sentinel: it names "shadow-unsanctioned-agent" as one node's owner
const GOAL = "Draft the onboarding checklist for the support team and publish it <<rogueagent>>";
const UNGRANTED_NAME = "shadow-unsanctioned-agent";
// unique per run, so a re-run on the same database does not collide with its own rows
const RUN = Date.now().toString(36);

let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreGates: () => Promise<void> = async () => {};
let userId: string;
let userAuth: { authorization: string };
let projectId: string;
let ungrantedId: string;
const demoAgentIds: string[] = [];

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  autoGrantCreatedAgentsForTest(app, db, { mirrorTools: true });
  // ADR-0181: the gates this file does not test, relaxed by name (MRM is the B2 beat, not this one)
  restoreGates = await relaxGovernanceGatesForTest(db, {
    mrmEnforced: false,
    dispatchAttributionRequired: false,
  });
  await installLicenseFixture(app, { features: ["advanced_orchestration"], auth: AUTH });

  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: `dbit-presenter-${RUN}@example.com`, displayName: "Dbit Presenter" },
  });
  expect(user.statusCode).toBe(201);
  userId = user.json().id;
  const key = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${userId}/keys`,
    payload: { name: "test" },
  });
  expect(key.statusCode).toBe(201);
  userAuth = { authorization: `Bearer ${key.json().token}` };

  // the demo's three mock agents (seed.ts), granted to the presenter
  const specs = [
    { name: `dbit-fast-mock-${RUN}`, tier: 0, costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-fast" },
    { name: `dbit-balanced-mock-${RUN}`, tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
    { name: `dbit-premium-mock-${RUN}`, tier: 2, costPerMTokIn: 15, costPerMTokOut: 75, model: "mock-premium" },
  ];
  for (const spec of specs) {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/agents",
      payload: { ...spec, provider: "mock" },
    });
    expect(res.statusCode).toBe(201);
    demoAgentIds.push(res.json().id);
    const grant = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/grants/agents",
      payload: { userId, agentId: res.json().id },
    });
    expect(grant.statusCode).toBe(201);
  }
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${userId}/agent-policy`,
    payload: { defaultAgentId: demoAgentIds[1] },
  });

  // an agent that EXISTS in the registry under the name the lead will suggest, but is never granted
  // to the presenter: existing is not enough, entitlement is what counts
  const ungranted = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: {
      name: UNGRANTED_NAME,
      provider: "mock",
      tier: 0,
      costPerMTokIn: 1,
      costPerMTokOut: 5,
      model: "mock-fast",
    },
  });
  if (ungranted.statusCode === 201) {
    ungrantedId = ungranted.json().id;
  } else {
    // a re-run on the same database: the agent is already registered
    const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/agents" });
    const found = (list.json().agents as { id: string; name: string }[]).find(
      (a) => a.name === UNGRANTED_NAME,
    );
    expect(found).toBeDefined();
    ungrantedId = found!.id;
  }

  const project = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/projects",
    payload: { name: `dbit-project-${RUN}` },
  });
  expect(project.statusCode).toBe(201);
  projectId = project.json().id;
});

afterAll(async () => {
  await removeLicenseFixture(db);
  await restoreGates();
});

describe("demo Build it act, beat B3: the task graph end to end on the demo's mock agents", () => {
  let proposal: {
    name: string;
    nodes: {
      id: string;
      ownerAgentId: string;
      substituted?: { requestedAgentName: string; reason: string };
    }[];
  };

  it("decomposes the goal; the ungranted suggestion is substituted, never kept", async () => {
    const res = await app.inject({
      method: "POST",
      headers: userAuth,
      url: "/v1/runs/decompose",
      payload: { goal: GOAL, projectId },
    });
    expect(res.statusCode).toBe(200);
    proposal = res.json().proposal;
    expect(proposal.nodes.length).toBeGreaterThanOrEqual(2);
    for (const n of proposal.nodes) {
      expect(demoAgentIds).toContain(n.ownerAgentId);
      expect(n.ownerAgentId).not.toBe(ungrantedId);
    }
    const substituted = proposal.nodes.filter((n) => n.substituted);
    expect(substituted).toHaveLength(1);
    expect(substituted[0]!.substituted!.requestedAgentName).toBe(UNGRANTED_NAME);
    expect(substituted[0]!.substituted!.reason).toBe("unknown_or_ungranted_agent");
  });

  it("refuses a run whose node a human set back to the ungranted agent, and audits the deny", async () => {
    const target = proposal.nodes.find((n) => n.substituted)!;
    const edited = proposal.nodes.map((n) =>
      n.id === target.id ? { ...n, ownerAgentId: ungrantedId } : n,
    );
    const res = await app.inject({
      method: "POST",
      headers: userAuth,
      url: "/v1/runs",
      payload: {
        graph: { run: proposal.name, escalationApproverUserId: userId, nodes: edited },
        projectId,
      },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe("entitlement_exceeded");
    const refusedNodes = (body.nodes as { nodeId: string }[]).map((n) => n.nodeId);
    expect(refusedNodes).toContain(target.id);

    const audit = await db.select().from(auditLog).where(eq(auditLog.userId, userId));
    const denies = audit.filter(
      (a) => a.effect === "deny" && (a.detail as { nodeId?: string } | null)?.nodeId === target.id,
    );
    expect(denies.length).toBeGreaterThanOrEqual(1);
  });

  it("creates the run as proposed and Auto-advance drives every node to done through governed dispatch", async () => {
    const created = await app.inject({
      method: "POST",
      headers: userAuth,
      url: "/v1/runs",
      payload: {
        graph: { run: proposal.name, escalationApproverUserId: userId, nodes: proposal.nodes },
        projectId,
      },
    });
    expect(created.statusCode).toBe(201);
    const runId = created.json().id as string;

    const auto = await app.inject({
      method: "POST",
      headers: userAuth,
      url: `/v1/runs/${runId}/auto`,
      payload: { acceptReviews: true },
    });
    expect(auto.statusCode).toBe(200);
    expect(auto.json().status).toBe("completed");
    expect(auto.json().stoppedReason).toBe("completed");

    // every node terminal
    const run = await app.inject({ method: "GET", headers: userAuth, url: `/v1/runs/${runId}` });
    expect(run.statusCode).toBe(200);
    const statuses = run.json().run.state.nodeStatuses as Record<string, string>;
    expect(Object.keys(statuses).sort()).toEqual(proposal.nodes.map((n) => n.id).sort());
    for (const s of Object.values(statuses)) expect(s).toBe("done");

    // each node: one governed, metered dispatch attributed to this run and project …
    const usage = (await db.select().from(usageEvents).where(eq(usageEvents.userId, userId))).filter(
      (u) => (u.detail as { runId?: string } | null)?.runId === runId,
    );
    const usageNodes = new Set(usage.map((u) => (u.detail as { nodeId?: string }).nodeId));
    for (const n of proposal.nodes) expect(usageNodes).toContain(n.id);
    for (const u of usage) expect(u.projectId).toBe(projectId);

    // … and audited: a run-node-dispatched row per node, and the auto-advance itself
    const audit = await db.select().from(auditLog).where(eq(auditLog.userId, userId));
    const dispatched = new Set(
      audit
        .filter((a) => a.ruleId === "run-node-dispatched" && a.objectId === runId)
        .map((a) => (a.detail as { nodeId?: string }).nodeId),
    );
    for (const n of proposal.nodes) expect(dispatched).toContain(n.id);
    expect(audit.some((a) => a.ruleId === "run-auto-advance")).toBe(true);
    // the run never dispatched the ungranted agent
    expect(usage.every((u) => u.agentId !== ungrantedId)).toBe(true);
  });
});
