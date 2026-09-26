import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { installLicenseFixture, removeLicenseFixture } from "./testing/license-fixture.js";

/**
 * PILLAR 7 §5.2 (B2) — a lead may SUGGEST a per-node budget cap at decompose;
 * it round-trips through the New-Run editor into the submittable graph as the
 * node's budgetCapUsd, and is enforced downstream by the SAME per-node ceiling
 * the kernel already computes — a suggestion can only ever TIGHTEN spend, never
 * grant new authority (the caller's own per-run budget still governs). The mock
 * planner doesn't emit a cap, so the human's editor edit is simulated by adding
 * budgetCapUsd to a real drafted proposal before submit. Shares one DB
 * (fileParallelism off); prefixed dnc-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "dnc-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const GOAL = "Add rate-limit headers to the public API and document them";

let db: Db;
let app: ReturnType<typeof buildApp>;
let deeAuth: { authorization: string };
let deeId: string;
let poorAuth: { authorization: string };
let approverId: string;

async function makeUser(email: string) {
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: email.split("@")[0] } });
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "t" } });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}
async function decompose(auth: { authorization: string }) {
  const r = await app.inject({ method: "POST", headers: auth, url: "/v1/runs/decompose", payload: { goal: GOAL } });
  expect(r.statusCode).toBe(200);
  return r.json().proposal as { name: string; nodes: Array<Record<string, unknown>> };
}
async function submit(auth: { authorization: string }, name: string, nodes: unknown[]) {
  return await app.inject({ method: "POST", headers: auth, url: "/v1/runs",
    payload: { graph: { run: name, escalationApproverUserId: approverId, nodes } } });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });
  // ADR-0052 §4: decompose is tier-gated on `advanced_orchestration`, now
  // enforced at the route — run under a license granting it (removed in
  // afterAll; the deployment ends UNLICENSED exactly as it started).
  await installLicenseFixture(app, { features: ["advanced_orchestration"], auth: AUTH });
  const ap = await makeUser("dnc-approver@example.com");
  approverId = ap.id;
  const dee = await makeUser("dnc-dee@example.com");
  deeId = dee.id; deeAuth = dee.auth;
  const poor = await makeUser("dnc-poor@example.com");
  poorAuth = poor.auth;

  const specs = [
    { name: "dnc-fast", tier: 0, costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-fast" },
    { name: "dnc-balanced", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
    { name: "dnc-premium", tier: 2, costPerMTokIn: 15, costPerMTokOut: 75, model: "mock-premium" },
  ];
  let balancedId = "";
  for (const spec of specs) {
    const res = await app.inject({ method: "POST", headers: AUTH, url: "/v1/agents", payload: { ...spec, provider: "mock" } });
    if (spec.name === "dnc-balanced") balancedId = res.json().id;
    for (const uid of [dee.id, poor.id]) {
      await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: uid, agentId: res.json().id } });
    }
  }
  await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${deeId}/agent-policy`,
    payload: { defaultAgentId: balancedId, runBudgetUsd: 100, runBudgetBreachAction: "approve" } });
  // the "poor" user: a tiny run budget so the RUN cap governs regardless of any
  // suggested per-node cap
  await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${poor.id}/agent-policy`,
    payload: { defaultAgentId: balancedId, runBudgetUsd: 0.0000001, runBudgetBreachAction: "approve" } });
});

afterAll(async () => {
  // `licenses` is an org singleton — leave the deployment UNLICENSED
  await removeLicenseFixture(db);
});

describe("suggested per-node cap round-trips + is enforced (B2)", () => {
  it("a suggested cap on a drafted proposal node round-trips into a submittable, stored graph", async () => {
    const proposal = await decompose(deeAuth);
    // the human's editor edit: attach a generous per-node cap
    proposal.nodes[0]!.budgetCapUsd = 3;
    const created = await submit(deeAuth, proposal.name, proposal.nodes);
    expect(created.statusCode).toBe(201);
    const view = await app.inject({ method: "GET", headers: deeAuth, url: `/v1/runs/${created.json().id}` });
    const stored = (view.json().run.graph.nodes as Array<{ id: string; budgetCapUsd?: number }>)
      .find((n) => n.id === proposal.nodes[0]!.id);
    expect(stored?.budgetCapUsd).toBe(3);
  });

  it("a TINY suggested cap tightens spend downstream — the node escalates node-budget-cap", async () => {
    const proposal = await decompose(deeAuth);
    proposal.nodes[0]!.budgetCapUsd = 0.0000001; // below any real estimate
    const created = await submit(deeAuth, proposal.name, proposal.nodes);
    expect(created.statusCode).toBe(201);
    const runId = created.json().id;
    await app.inject({ method: "POST", headers: deeAuth, url: `/v1/runs/${runId}/events`, payload: { kind: "start" } });
    const started = await app.inject({ method: "POST", headers: deeAuth, url: `/v1/runs/${runId}/events`,
      payload: { kind: "node_started", nodeId: proposal.nodes[0]!.id } });
    expect(started.statusCode).toBe(409);
    expect(started.json().error).toBe("node_budget_exceeded");
    expect(started.json().nodeCapUsd).toBe(0.0000001);
  });

  it("a cap beyond the caller's authority grants nothing — the run budget still governs", async () => {
    const proposal = await decompose(poorAuth);
    // a huge suggested per-node cap can't rescue a caller whose RUN budget is tiny
    proposal.nodes[0]!.budgetCapUsd = 999999;
    const created = await submit(poorAuth, proposal.name, proposal.nodes);
    expect(created.statusCode).toBe(201);
    // the run is over its (tiny) run budget at plan time — no per-node cap lifts it
    expect(created.json().budgetApprovalPending).toBe(true);
  });
});
