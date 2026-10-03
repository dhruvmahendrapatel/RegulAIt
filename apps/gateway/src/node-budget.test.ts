import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

/**
 * PILLAR 7 §5.2 — Team-Lead SUB-BUDGET (transitive per-node budget ceiling). A
 * node (or the lead above it) can carry a `budgetCapUsd` that caps THAT node's
 * estimated spend independently of the run-level cap; it composes as a MIN up
 * the lead chain, so a delegated worker can never be handed a looser budget
 * than a lead above it. A node whose estimate exceeds its ceiling pauses and
 * escalates into the same approvals queue (ruleId `node-budget-cap`). The agent-
 * entitlement narrowing half of §5.1 already exists — this adds the sub-budget.
 *
 * Shares one DB (fileParallelism off); everything is prefixed nb-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "nb-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let benAuth: { authorization: string };
let benId: string;
let approverId: string;
let approverAuth: { authorization: string };
let worker: string; // a priced worker agent

async function makeUser(email: string) {
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: email.split("@")[0] } });
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "t" } });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}
const mkNode = (id: string, agentId: string, extra: Record<string, unknown> = {}) => ({
  id, title: `task ${id}`, ownerAgentId: agentId, mode: "execute",
  estimate: { in: 100_000, out: 100_000 }, ...extra,
});
async function createRun(name: string, nodes: unknown[]) {
  return await app.inject({ method: "POST", headers: benAuth, url: "/v1/runs",
    payload: { graph: { run: name, escalationApproverUserId: approverId, nodes } } });
}
async function event(runId: string, body: Record<string, unknown>) {
  return await app.inject({ method: "POST", headers: benAuth, url: `/v1/runs/${runId}/events`, payload: body });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "n".repeat(64) });
  const ben = await makeUser("nb-ben@example.com");
  benId = ben.id; benAuth = ben.auth;
  const ap = await makeUser("nb-approver@example.com");
  approverId = ap.id; approverAuth = ap.auth;
  // a priced worker: a node estimated at 100k in + 100k out costs
  // (0.1*5)+(0.1*25) = $3.00 under this agent.
  const a = await app.inject({ method: "POST", headers: AUTH, url: "/v1/agents",
    payload: { name: "nb-worker", provider: "mock", tier: 1, costPerMTokIn: 5, costPerMTokOut: 25, model: "mock-1" } });
  worker = a.json().id;
  await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: benId, agentId: worker } });
  // a GENEROUS run-level budget so it's the per-node cap that trips, not the run cap
  await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${benId}/agent-policy`,
    payload: { runBudgetUsd: 100, runBudgetBreachAction: "approve" } });
});

describe("transitive per-node budget ceiling", () => {
  it("a node whose estimate exceeds its own budgetCapUsd pauses and escalates (node-budget-cap)", async () => {
    // node cap $1 < estimated $3 → breach at node_started
    const created = await createRun("nb-own", [mkNode("n1", worker, { budgetCapUsd: 1 })]);
    expect(created.statusCode).toBe(201);
    const runId = created.json().id;
    expect((await event(runId, { kind: "start" })).statusCode).toBe(200);
    const started = await event(runId, { kind: "node_started", nodeId: "n1" });
    expect(started.statusCode).toBe(409);
    expect(started.json().error).toBe("node_budget_exceeded");
    expect(started.json().nodeCapUsd).toBe(1);
    // escalated to the named approver on a per-node budget stage
    const inbox = await app.inject({ method: "GET", headers: approverAuth, url: "/v1/approvals?status=pending" });
    const entry = inbox.json().approvals.find(
      (x: { runId: string | null; stageId: string | null }) => x.runId === runId && x.stageId === "__nodebudget__:n1",
    );
    expect(entry).toBeTruthy();
  });

  it("a generous per-node cap lets the node proceed (spend recorded, no breach)", async () => {
    const created = await createRun("nb-ok", [mkNode("n1", worker, { budgetCapUsd: 10 })]);
    const runId = created.json().id;
    await event(runId, { kind: "start" });
    const started = await event(runId, { kind: "node_started", nodeId: "n1" });
    expect(started.statusCode).toBe(200);
    const view = await app.inject({ method: "GET", headers: benAuth, url: `/v1/runs/${runId}` });
    expect(view.json().run.budget.spentUsd).toBeCloseTo(3.0, 6);
  });

  it("transitive MIN: a worker under a low-cap lead is capped by the lead, not its own looser cap", async () => {
    // lead caps at $1; the worker's own cap is a loose $50 → effective $1 → breach
    const created = await createRun("nb-lead", [
      mkNode("lead", worker, { budgetCapUsd: 1, estimate: { in: 1, out: 1 } }),
      mkNode("w", worker, { leadNodeId: "lead", budgetCapUsd: 50 }),
    ]);
    const runId = created.json().id;
    await event(runId, { kind: "start" });
    // the lead itself is cheap enough to start
    expect((await event(runId, { kind: "node_started", nodeId: "lead" })).statusCode).toBe(200);
    await event(runId, { kind: "node_completed", nodeId: "lead" });
    // the worker: own cap 50 but lead cap 1 → effective 1 < $3 estimate → breach
    const w = await event(runId, { kind: "node_started", nodeId: "w" });
    expect(w.statusCode).toBe(409);
    expect(w.json().error).toBe("node_budget_exceeded");
    expect(w.json().nodeCapUsd).toBe(1);
  });

  it("a node with NO cap anywhere is unaffected (only the run cap applies)", async () => {
    const created = await createRun("nb-none", [mkNode("n1", worker)]);
    const runId = created.json().id;
    await event(runId, { kind: "start" });
    expect((await event(runId, { kind: "node_started", nodeId: "n1" })).statusCode).toBe(200);
  });
});

describe("REL-07: the estimated spend is incremented atomically", () => {
  it("two nodes started CONCURRENTLY both land on budget.spentUsd (no lost update)", async () => {
    const created = await createRun("nb-rel07-concurrent", [mkNode("a", worker), mkNode("b", worker)]);
    const runId = created.json().id;
    expect((await event(runId, { kind: "start" })).statusCode).toBe(200);
    const [ra, rb] = await Promise.all([
      event(runId, { kind: "node_started", nodeId: "a" }),
      event(runId, { kind: "node_started", nodeId: "b" }),
    ]);
    expect(ra.statusCode).toBe(200);
    expect(rb.statusCode).toBe(200);
    const detail = await app.inject({ method: "GET", headers: benAuth, url: `/v1/runs/${runId}` });
    const budget = detail.json().run.budget as { spentUsd: number };
    // each node costs $3.00 under nb-worker; the snapshot write used to keep only one
    expect(budget.spentUsd).toBeCloseTo(6, 6);
  });

  it("chargeRunEstimate never rewrites the rest of the envelope: measured spend survives a concurrent estimate charge", async () => {
    const { chargeRunEstimate, chargeRunBudget } = await import("./orchestration.js");
    const created = await createRun("nb-rel07-envelope", [mkNode("a", worker)]);
    const runId = created.json().id;
    await event(runId, { kind: "start" });
    await Promise.all([
      ...Array.from({ length: 25 }, () => chargeRunEstimate(db, runId, 0.01)),
      chargeRunBudget(db, runId, "a", 1.25),
    ]);
    const detail = await app.inject({ method: "GET", headers: benAuth, url: `/v1/runs/${runId}` });
    const budget = detail.json().run.budget as { spentUsd: number; measuredSpentUsd: number; capUsd: number | null };
    expect(budget.spentUsd).toBeCloseTo(0.25, 6);
    expect(budget.measuredSpentUsd).toBeCloseTo(1.25, 6);
    expect(budget.capUsd).toBe(100);
  });
});
