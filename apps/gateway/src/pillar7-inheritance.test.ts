import { beforeAll, describe, expect, it, afterAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

/**
 * PILLAR 7's LOAD-BEARING SENTENCE, attacked from the outside.
 *
 * CLAUDE.md states it as an absolute: every worker/lead agent inherits — and
 * NEVER EXCEEDS — the entitlements and per-run budget of the initiating user.
 * "Never exceeds" is a claim about the moment of execution, not about the
 * moment of planning, and the interesting cases are all the ones where those
 * two moments disagree:
 *
 *   · the grant that existed at plan time is REVOKED before the worker runs;
 *   · the run is driven by somebody who is NOT the initiating user, so "the
 *     initiating user's entitlements" and "the caller's entitlements" are
 *     different sets and the narrower one has to win;
 *   · a lead's ceiling excludes an agent the initiator personally holds —
 *     delegation may only ever tighten;
 *   · the same attempts routed through the AUTO loop instead of the manual
 *     dispatch, because a convenience path that skips a gate is still a
 *     bypass.
 *
 * Every test here is written to FAIL if the check moved to plan time only.
 *
 * Shares one DB (fileParallelism off); everything is prefixed p7-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "p7-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let ivyId: string; // the initiating user
let ivyAuth: { authorization: string };
let approverId: string;
let outsiderAuth: { authorization: string }; // a plain user, party to nothing
let adminAuth: { authorization: string }; // a real admin (not the bootstrap token)
let workerAgent: string;
let otherAgent: string; // granted to ivy, but OUTSIDE a lead's ceiling

async function makeUser(email: string, isAdmin = false) {
  const u = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/users",
    payload: { email, displayName: email.split("@")[0], isAdmin },
  });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "t" },
  });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function mkAgent(name: string) {
  const a = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/agents",
    payload: { name, provider: "mock", tier: 1, costPerMTokIn: 1, costPerMTokOut: 2, model: "mock-1" },
  });
  expect(a.statusCode).toBe(201);
  return a.json().id as string;
}

const grantAgent = (userId: string, agentId: string) =>
  app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId, agentId } });

/** find and delete ivy's grant for an agent — the revocation under test */
async function revokeAgent(userId: string, agentId: string) {
  const list = await app.inject({ method: "GET", headers: AUTH, url: `/v1/users/${userId}/agents` });
  expect(list.statusCode).toBe(200);
  const rows: Array<{ grantId?: string; id?: string; agentId?: string }> = list.json().agents ?? [];
  const row = rows.find((r) => (r.agentId ?? r.id) === agentId);
  expect(row, "expected a grant row to revoke").toBeTruthy();
  const grantId = row!.grantId ?? row!.id;
  const del = await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/grants/agents/${grantId}` });
  expect(del.statusCode).toBeLessThan(300);
}

const mkNode = (id: string, agentId: string, extra: Record<string, unknown> = {}) => ({
  id, title: `task ${id}`, ownerAgentId: agentId, mode: "execute",
  estimate: { in: 100, out: 100 }, ...extra,
});

async function createRun(name: string, nodes: unknown[], auth = ivyAuth) {
  return app.inject({
    method: "POST", headers: auth, url: "/v1/runs",
    payload: { graph: { run: name, escalationApproverUserId: approverId, nodes } },
  });
}
const event = (runId: string, body: Record<string, unknown>, auth = ivyAuth) =>
  app.inject({ method: "POST", headers: auth, url: `/v1/runs/${runId}/events`, payload: body });
const dispatch = (runId: string, nodeId: string, auth = ivyAuth) =>
  app.inject({ method: "POST", headers: auth, url: `/v1/runs/${runId}/nodes/${nodeId}/dispatch`, payload: {} });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "p".repeat(64) });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });

  const ivy = await makeUser("p7-ivy@example.com");
  ivyId = ivy.id; ivyAuth = ivy.auth;
  approverId = (await makeUser("p7-approver@example.com")).id;
  outsiderAuth = (await makeUser("p7-outsider@example.com")).auth;
  adminAuth = (await makeUser("p7-admin@example.com", true)).auth;

  workerAgent = await mkAgent("p7-worker");
  otherAgent = await mkAgent("p7-other");
  await grantAgent(ivyId, workerAgent);
  await grantAgent(ivyId, otherAgent);
});

describe("pillar 7: a worker never exceeds the INITIATING user's entitlements", () => {
  it("a grant revoked AFTER planning stops the worker at dispatch, and says why", async () => {
    const created = await createRun("p7-revoke", [mkNode("n1", workerAgent)]);
    expect(created.statusCode).toBe(201);
    const runId = created.json().id;
    expect((await event(runId, { kind: "start" })).statusCode).toBe(200);
    expect((await event(runId, { kind: "node_started", nodeId: "n1" })).statusCode).toBe(200);

    // the node is live and the agent is currently granted — baseline: it runs
    const ok = await dispatch(runId, "n1");
    expect(ok.statusCode).toBe(200);

    // now the entitlement goes away mid-run
    await revokeAgent(ivyId, workerAgent);

    // the SAME node, already started and already dispatched once, must stop.
    // If this returns 200 the check lives at plan time and the guarantee is
    // "inherits", not "never exceeds".
    const after = await dispatch(runId, "n1");
    expect(after.statusCode).toBe(403);
    expect(after.json().error).toBe("entitlement_exceeded");
    expect(after.json().decision.effect).not.toBe("allow");

    // restore for the tests below (shared DB, ordered file)
    await grantAgent(ivyId, workerAgent);
  });

  it("the AUTO loop honours the same revocation — the convenience path is not a bypass", async () => {
    const created = await createRun("p7-revoke-auto", [mkNode("n1", workerAgent)]);
    expect(created.statusCode).toBe(201);
    const runId = created.json().id;
    await revokeAgent(ivyId, workerAgent);

    const auto = await app.inject({
      method: "POST", headers: ivyAuth, url: `/v1/runs/${runId}/auto`, payload: { maxNodes: 3 },
    });
    // the pass itself is a legitimate request — what must NOT happen is a
    // worker running on a revoked grant
    expect(auto.statusCode).toBeLessThan(500);
    const body = auto.json();
    const steps: Array<Record<string, unknown>> = body.steps ?? [];
    const ran = steps.filter((s) => s.status === "submitted" || s.status === "accepted");
    expect(ran).toHaveLength(0);
    expect(JSON.stringify(body)).toMatch(/denied|entitlement|refus/i);

    await grantAgent(ivyId, workerAgent);
  });

  it("an ADMIN driving someone else's run still gets the INITIATOR's entitlements, not their own", async () => {
    // The run is ivy's. The admin has every privilege in the org, and the
    // agent is revoked from IVY. Resolving against the caller would let an
    // admin's dispatch execute work ivy is no longer entitled to — attributed
    // to ivy's run and billed to ivy's budget.
    const created = await createRun("p7-admin-drive", [mkNode("n1", workerAgent)]);
    expect(created.statusCode).toBe(201);
    const runId = created.json().id;
    expect((await event(runId, { kind: "start" })).statusCode).toBe(200);
    expect((await event(runId, { kind: "node_started", nodeId: "n1" })).statusCode).toBe(200);
    await revokeAgent(ivyId, workerAgent);

    const asAdmin = await dispatch(runId, "n1", adminAuth);
    expect(asAdmin.statusCode).toBe(403);
    expect(asAdmin.json().error).toBe("entitlement_exceeded");

    await grantAgent(ivyId, workerAgent);
  });

  it("a stranger cannot drive, dispatch, or auto-advance a run that is not theirs", async () => {
    const created = await createRun("p7-stranger", [mkNode("n1", workerAgent)]);
    const runId = created.json().id;
    for (const res of [
      await event(runId, { kind: "start" }, outsiderAuth),
      await dispatch(runId, "n1", outsiderAuth),
      await app.inject({
        method: "POST", headers: outsiderAuth, url: `/v1/runs/${runId}/auto`, payload: { maxNodes: 1 },
      }),
      await app.inject({ method: "GET", headers: outsiderAuth, url: `/v1/runs/${runId}` }),
    ]) {
      expect(res.statusCode).toBeGreaterThanOrEqual(403);
      expect(res.statusCode).toBeLessThan(500);
    }
  });
});

describe("pillar 7: delegation may only ever TIGHTEN", () => {
  it("a lead's ceiling excludes an agent the initiator personally holds", async () => {
    // ivy holds BOTH agents. The lead delegates to n2 with a ceiling naming
    // only workerAgent, so otherAgent is out of bounds for n2 — the user's own
    // grant must not widen what the lead allowed.
    const created = await createRun("p7-ceiling", [
      mkNode("lead", workerAgent, { allowedAgentIds: [workerAgent] }),
      mkNode("n2", workerAgent, { leadNodeId: "lead", dependsOn: ["lead"] }),
    ]);
    expect(created.statusCode).toBe(201);
    const runId = created.json().id;
    // reassign is only legal on a BLOCKED node, so drive n2 there for real:
    // the lead completes, n2 starts and fails.
    expect((await event(runId, { kind: "start" })).statusCode).toBe(200);
    await event(runId, { kind: "node_started", nodeId: "lead" });
    await event(runId, { kind: "node_submitted", nodeId: "lead" });
    await event(runId, { kind: "node_accepted", nodeId: "lead" });
    await event(runId, { kind: "node_started", nodeId: "n2" });
    expect((await event(runId, { kind: "node_failed", nodeId: "n2", error: "boom" })).statusCode).toBe(200);

    // reassigning the DELEGATED node onto the out-of-ceiling agent is refused,
    // even though ivy is granted it outright
    const reassign = await event(runId, {
      kind: "reassign_node", nodeId: "n2", ownerAgentId: otherAgent,
    });
    expect(reassign.statusCode).toBe(403);
    expect(reassign.json().error).toBe("entitlement_exceeded");

    // CONTROL, driven to the identical depth: the same agent, the same blocked
    // state, on a node with no lead above it — succeeds. Without this the test
    // above would also pass if reassignment were broken outright, and would be
    // proving nothing about the ceiling.
    const flat = await createRun("p7-ceiling-flat", [mkNode("n1", workerAgent)]);
    expect(flat.statusCode).toBe(201);
    const flatRunId = flat.json().id;
    expect((await event(flatRunId, { kind: "start" })).statusCode).toBe(200);
    await event(flatRunId, { kind: "node_started", nodeId: "n1" });
    expect((await event(flatRunId, { kind: "node_failed", nodeId: "n1", error: "boom" })).statusCode).toBe(200);
    const okReassign = await event(flatRunId, {
      kind: "reassign_node", nodeId: "n1", ownerAgentId: otherAgent,
    });
    expect(okReassign.statusCode).toBe(200);
  });

  it("a run cannot name an agent the initiator was never granted at all", async () => {
    const ungranted = await mkAgent("p7-never-granted");
    const created = await createRun("p7-ungranted", [mkNode("n1", ungranted)]);
    expect(created.statusCode).toBeGreaterThanOrEqual(400);
    expect(created.statusCode).toBeLessThan(500);
  });
});

afterAll(async () => {
  await restoreSb2Gates();
});
