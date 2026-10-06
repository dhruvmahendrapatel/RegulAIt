import { beforeAll, describe, expect, it, afterAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

/**
 * PILLAR 7 §5.2 (B1) — the MEASURED per-node budget ceiling. A node's OWN
 * transitive budgetCapUsd is enforced on PROVIDER-MEASURED dollars, mirroring
 * the run-level measured cap: the first crossing is allowed (measured cost is
 * only known post-call) but escalates immediately into the one approvals queue
 * under a DISTINCT sentinel (`__nodebudget_measured__:<node>`) and ruleId
 * (`node-budget-cap-measured`); the per-turn/per-dispatch pre-gate then blocks
 * the next attempt until the overage is decided. A run with no per-node cap is
 * byte-identical (no new approvals). Deciding the escalation lifts it.
 *
 * Uses a super-pricey mock agent so a single measured dispatch dwarfs a small
 * node cap while the node's ESTIMATE stays under it (so node_started passes and
 * the crossing lands on MEASURED, not the estimate gate). Shares one DB
 * (fileParallelism off); everything is prefixed mnb-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "mnb-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let benAuth: { authorization: string };
let benId: string;
let approverId: string;
let approverAuth: { authorization: string };
let pricey: string; // a very expensive worker so measured >> a small node cap

async function makeUser(email: string) {
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: email.split("@")[0] } });
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "t" } });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}
// small ESTIMATE (1 tok each way) so node_started's ESTIMATE gate passes under a
// modest cap; the pricey agent makes the MEASURED dispatch dwarf that cap.
const mkNode = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: `task ${id}`, ownerAgentId: pricey, mode: "execute",
  estimate: { in: 1, out: 1 }, ...extra,
});
async function createRun(name: string, nodes: unknown[]) {
  return await app.inject({ method: "POST", headers: benAuth, url: "/v1/runs",
    payload: { graph: { run: name, escalationApproverUserId: approverId, nodes } } });
}
async function event(runId: string, body: Record<string, unknown>) {
  return await app.inject({ method: "POST", headers: benAuth, url: `/v1/runs/${runId}/events`, payload: body });
}
async function dispatch(runId: string, nodeId: string) {
  return await app.inject({ method: "POST", headers: benAuth, url: `/v1/runs/${runId}/nodes/${nodeId}/dispatch`, payload: {} });
}
async function pending(runId: string, stageId: string) {
  const inbox = await app.inject({ method: "GET", headers: approverAuth, url: "/v1/approvals?status=pending" });
  return inbox.json().approvals.find(
    (x: { runId: string | null; stageId: string | null }) => x.runId === runId && x.stageId === stageId,
  );
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "m".repeat(64) });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  const ben = await makeUser("mnb-ben@example.com");
  benId = ben.id; benAuth = ben.auth;
  const ap = await makeUser("mnb-approver@example.com");
  approverId = ap.id; approverAuth = ap.auth;
  const a = await app.inject({ method: "POST", headers: AUTH, url: "/v1/agents",
    payload: { name: "mnb-pricey", provider: "mock", tier: 0, modes: ["execute"], costPerMTokIn: 1_000_000, costPerMTokOut: 1_000_000, model: "mock-pricey" } });
  pricey = a.json().id;
  await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: benId, agentId: pricey } });
  // a GENEROUS run-level budget ($1000) so the per-node MEASURED ceiling trips,
  // not the run cap.
  await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${benId}/agent-policy`,
    payload: { runBudgetUsd: 1000, runBudgetBreachAction: "approve" } });
});

describe("measured per-node budget ceiling (B1)", () => {
  it("crossing a node's own measured ceiling escalates __nodebudget_measured__ and blocks the next dispatch; decide lifts it", async () => {
    // cap $5: estimate ($2 = 1+1 tok x $1e6/MTok) passes node_started, but the
    // pricey MEASURED dispatch dwarfs $5 → measured crossing.
    const created = await createRun("mnb-cap", [mkNode("n1", { budgetCapUsd: 5 })]);
    expect(created.statusCode).toBe(201);
    const runId = created.json().id;
    expect((await event(runId, { kind: "start" })).statusCode).toBe(200);
    // node_started passes the ESTIMATE gate ($2 < $5)
    expect((await event(runId, { kind: "node_started", nodeId: "n1" })).statusCode).toBe(200);

    // first dispatch: allowed, but measured crosses the $5 node cap → escalated
    const first = await dispatch(runId, "n1");
    expect(first.statusCode).toBe(200);
    expect(first.json().nodeBudgetBreached).toBe(true);

    // the distinct per-node MEASURED escalation lands in the one queue
    expect(await pending(runId, "__nodebudget_measured__:n1")).toBeTruthy();

    // the next dispatch is pre-gated by the measured ceiling — blocked
    const second = await dispatch(runId, "n1");
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("node_budget_exceeded_measured");

    // the run's budget carries the measured per-node running total
    const view = await app.inject({ method: "GET", headers: benAuth, url: `/v1/runs/${runId}` });
    expect(view.json().run.budget.measuredPerNodeUsd.n1).toBeGreaterThan(5);

    // decide-approve the escalation → cap enforcement lifted for the run
    const entry = await pending(runId, "__nodebudget_measured__:n1");
    const decided = await app.inject({ method: "POST", headers: approverAuth, url: `/v1/approvals/${entry.id}/decide`, payload: { decision: "approved" } });
    expect(decided.statusCode).toBe(200);

    // now a re-dispatch is no longer blocked by the per-node ceiling
    const third = await dispatch(runId, "n1");
    expect(third.statusCode).toBe(200);
  });

  it("a flat run with NO per-node cap is byte-identical — no measured node escalation", async () => {
    const created = await createRun("mnb-none", [mkNode("n1")]);
    const runId = created.json().id;
    await event(runId, { kind: "start" });
    expect((await event(runId, { kind: "node_started", nodeId: "n1" })).statusCode).toBe(200);
    const out = await dispatch(runId, "n1");
    expect(out.statusCode).toBe(200);
    expect(out.json().nodeBudgetBreached).toBeUndefined();
    expect(await pending(runId, "__nodebudget_measured__:n1")).toBeUndefined();
  });
});

afterAll(async () => {
  await restoreSb2Gates();
});
