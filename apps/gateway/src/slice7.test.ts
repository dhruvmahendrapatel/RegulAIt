/**
 * Slice 7 e2e: the surfaces that put pillars 5, 6 and 8 where the work
 * happens — all driven through the public endpoints the /app UI calls.
 *
 *  - project /costs is member-readable (admin OR member; non-member 403)
 *  - auto-advance dispatches the FULL ready set as a wave: independent
 *    branches genuinely overlap in the event history, and the response's
 *    stoppedReason names why the pass ended
 *  - the PM strip's reads: /v1/pm/links by runId (node links + run parent,
 *    each carrying its connectionName) and by instanceId, and /v1/decisions
 *    enriched with the maker's name
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, type Db } from "@regulait/db";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "test-bootstrap-token-s7";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let workerId: string;

const mkUser = async (email: string, name: string): Promise<string> => {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/users",
    payload: { email, displayName: name },
  });
  return r.json().id;
};
const authFor = async (userId: string): Promise<{ authorization: string }> => {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${userId}/keys`,
    payload: { name: "s7-key" },
  });
  return { authorization: `Bearer ${r.json().token}` };
};
const mkNode = (id: string, agentId: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `task ${id}`,
  ownerAgentId: agentId,
  mode: "execute",
  estimate: { in: 10, out: 20 },
  ...extra,
});

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "b".repeat(64) });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });

  const agent = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/agents",
    payload: {
      name: "s7-worker", provider: "mock", tier: 0, modes: ["execute"],
      costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-s7",
    },
  });
  workerId = agent.json().id;
});

afterAll(async () => {
  await restoreSb2Gates();
  await app.close();
});

describe("project /costs is member-readable (pillar 5 where the work happens)", () => {
  let projectId: string;
  let miraAuth: { authorization: string };
  let nilsAuth: { authorization: string };

  it("a member reads the same rollup an admin sees; a non-member gets a plain 403", async () => {
    const miraId = await mkUser("s7-mira@example.com", "Mira Member");
    const nilsId = await mkUser("s7-nils@example.com", "Nils Nonmember");
    miraAuth = await authFor(miraId);
    nilsAuth = await authFor(nilsId);
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/agents",
      payload: { userId: miraId, agentId: workerId },
    });

    const project = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/projects",
      payload: { name: "s7-costs-project", costCenter: "CC-S7" },
    });
    projectId = project.json().id;
    await app.inject({
      method: "POST", headers: AUTH, url: `/v1/projects/${projectId}/members`,
      payload: { userId: miraId, role: "contributor" },
    });

    // real measured spend attributed to the project, made by the member
    const invoked = await app.inject({
      method: "POST", headers: miraAuth, url: `/v1/agents/${workerId}/invoke`,
      payload: { mode: "execute", input: "summarize the s7 slice", dispatch: true, projectId },
    });
    expect(invoked.statusCode).toBe(200);

    const asMember = await app.inject({
      method: "GET", headers: miraAuth, url: `/v1/projects/${projectId}/costs`,
    });
    expect(asMember.statusCode).toBe(200);
    expect(asMember.json().measured.events).toBe(1);
    expect(asMember.json().measured.costUsd).toBeGreaterThan(0);
    expect(asMember.json().byUser.some((u: { userId: string }) => u.userId === miraId)).toBe(true);

    const asNonMember = await app.inject({
      method: "GET", headers: nilsAuth, url: `/v1/projects/${projectId}/costs`,
    });
    expect(asNonMember.statusCode).toBe(403);
    expect(asNonMember.json().error).toBe("not_a_project_member");

    const asAdmin = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/projects/${projectId}/costs`,
    });
    expect(asAdmin.statusCode).toBe(200);
  });

  it("the self-scoped ledgers behind the Spend page stay non-admin readable", async () => {
    const usage = await app.inject({ method: "GET", headers: miraAuth, url: "/v1/usage-events" });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().totals.events).toBeGreaterThan(0);
    const costs = await app.inject({ method: "GET", headers: miraAuth, url: "/v1/cost-events" });
    expect(costs.statusCode).toBe(200);
  });
});

describe("auto-advance dispatches the full ready set as one wave (§4 parallelism)", () => {
  it("independent roots overlap in the event history and stoppedReason is returned", async () => {
    const paxId = await mkUser("s7-pax@example.com", "Pax Parallel");
    const paxAuth = await authFor(paxId);
    const approverId = await mkUser("s7-approver@example.com", "S7 Approver");
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/agents",
      payload: { userId: paxId, agentId: workerId },
    });

    const created = await app.inject({
      method: "POST", headers: paxAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "s7-parallel",
          escalationApproverUserId: approverId,
          nodes: [
            mkNode("x", workerId),
            mkNode("y", workerId),
            mkNode("z", workerId, { dependsOn: ["x", "y"] }),
          ],
        },
      },
    });
    const runId = created.json().id;

    const res = await app.inject({
      method: "POST", headers: paxAuth, url: `/v1/runs/${runId}/auto`,
      payload: { acceptReviews: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("completed");
    expect(res.json().stoppedReason).toBe("completed");
    expect(res.json().steps).toHaveLength(3);

    // the wave is visible in the append-only history: y STARTS before x is
    // submitted — the two roots were concurrently in_progress, not a
    // one-at-a-time march. z still never starts before both are done.
    const view = await app.inject({ method: "GET", headers: paxAuth, url: `/v1/runs/${runId}` });
    const kinds = view.json().events.map(
      (e: { event: { kind: string; nodeId?: string } }) => `${e.event.kind}:${e.event.nodeId ?? ""}`,
    );
    const idx = (k: string) => kinds.indexOf(k);
    expect(idx("node_started:y")).toBeGreaterThan(-1);
    expect(idx("node_started:y")).toBeLessThan(idx("node_submitted:x"));
    expect(idx("node_started:z")).toBeGreaterThan(idx("node_accepted:x"));
    expect(idx("node_started:z")).toBeGreaterThan(idx("node_accepted:y"));
  });

  it("a review-gated pass leaves BOTH roots in_review after one call", async () => {
    const quinId = await mkUser("s7-quin@example.com", "Quin Queue");
    const quinAuth = await authFor(quinId);
    const approverId = await mkUser("s7-approver2@example.com", "S7 Approver Two");
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/agents",
      payload: { userId: quinId, agentId: workerId },
    });
    const created = await app.inject({
      method: "POST", headers: quinAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "s7-parallel-review",
          escalationApproverUserId: approverId,
          nodes: [mkNode("a", workerId), mkNode("b", workerId)],
        },
      },
    });
    const runId = created.json().id;
    const res = await app.inject({
      method: "POST", headers: quinAuth, url: `/v1/runs/${runId}/auto`, payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stoppedReason).toBe("awaiting_review");
    expect(res.json().state.nodeStatuses).toMatchObject({ a: "in_review", b: "in_review" });
  });
});

describe("the PM strip's reads (pillar 8 in /app)", () => {
  let rioId: string;
  let rioAuth: { authorization: string };
  let runId: string;

  it("run links carry the connection name, node links AND the run parent item", async () => {
    rioId = await mkUser("s7-rio@example.com", "Rio Runner");
    rioAuth = await authFor(rioId);
    const approverId = await mkUser("s7-approver3@example.com", "S7 Approver Three");
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/agents",
      payload: { userId: rioId, agentId: workerId },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/pm/connections",
      payload: { name: "s7-pm", provider: "mock", project: "S7-PROJ", token: "not-a-real-token" },
    });

    const created = await app.inject({
      method: "POST", headers: rioAuth, url: "/v1/runs",
      payload: {
        graph: {
          run: "s7-pm-run",
          escalationApproverUserId: approverId,
          nodes: [mkNode("api", workerId), mkNode("docs", workerId, { dependsOn: ["api"] })],
        },
      },
    });
    runId = created.json().id;

    const synced = await app.inject({
      method: "POST", headers: rioAuth, url: `/v1/runs/${runId}/pm-sync`,
      payload: { connectionName: "s7-pm" },
    });
    expect(synced.statusCode).toBe(201);
    expect(synced.json().created).toHaveLength(2);

    const links = await app.inject({
      method: "GET", headers: rioAuth, url: `/v1/pm/links?runId=${runId}`,
    });
    expect(links.statusCode).toBe(200);
    const rows = links.json().links;
    expect(rows).toHaveLength(3); // run parent + 2 node links
    expect(rows.every((l: { connectionName: string }) => l.connectionName === "s7-pm")).toBe(true);
    expect(rows.filter((l: { objectType: string }) => l.objectType === "run")).toHaveLength(1);
    expect(
      rows.filter((l: { objectType: string }) => l.objectType === "run_node").map((l: { nodeId: string }) => l.nodeId).sort(),
    ).toEqual(["api", "docs"]);
    // no secret material rides along
    expect(JSON.stringify(links.json())).not.toContain("Ciphertext");
  });

  it("decisions list with the maker's name for the Decisions card", async () => {
    const recorded = await app.inject({
      method: "POST", headers: rioAuth, url: "/v1/decisions",
      payload: { objectType: "run", objectId: runId, decision: "Ship it behind the s7 flag" },
    });
    expect(recorded.statusCode).toBe(201);
    expect(recorded.json().pmMirror.ok).toBe(true);

    const listed = await app.inject({
      method: "GET", headers: rioAuth, url: `/v1/decisions?objectType=run&objectId=${runId}`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().decisions).toHaveLength(1);
    expect(listed.json().decisions[0].decisionMakerName).toBe("Rio Runner");
    // the mock default mapping has no decision type, so the mirror was a
    // comment — no link row, pmMirror stays null in the LIST view
    expect(listed.json().decisions[0].pmMirror).toBeNull();
  });

  it("instance links resolve by instanceId, gated to the initiator", async () => {
    const tpl = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: "s7-pm-flow",
        definition: {
          workflow: "s7-pm-flow",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "signoff", type: "human_approval", approvers: ["requesting_user"] },
          ],
        },
      },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "s7-pm-e2e" },
    });
    const started = await app.inject({
      method: "POST", headers: rioAuth, url: "/v1/workflows/instances",
      payload: {
        change: {
          description: "s7 pm-linked change",
          paths: ["src/s7.ts"],
          changeType: "s7-pm-e2e",
          environment: "staging",
        },
      },
    });
    const instanceId = started.json().id;
    const synced = await app.inject({
      method: "POST", headers: rioAuth, url: `/v1/workflows/instances/${instanceId}/pm-sync`,
      payload: { connectionName: "s7-pm" },
    });
    expect(synced.statusCode).toBe(201);

    const links = await app.inject({
      method: "GET", headers: rioAuth, url: `/v1/pm/links?instanceId=${instanceId}`,
    });
    expect(links.statusCode).toBe(200);
    expect(links.json().links).toHaveLength(1);
    expect(links.json().links[0]).toMatchObject({
      objectType: "workflow_instance",
      connectionName: "s7-pm",
    });

    // non-participants learn nothing, same as the run-scoped read
    const strangerAuth = await authFor(await mkUser("s7-sam@example.com", "Sam Stranger"));
    const denied = await app.inject({
      method: "GET", headers: strangerAuth, url: `/v1/pm/links?instanceId=${instanceId}`,
    });
    expect(denied.statusCode).toBe(404);

    // exactly one scope param — both or neither is a validation error
    const both = await app.inject({
      method: "GET", headers: rioAuth, url: `/v1/pm/links?runId=${runId}&instanceId=${instanceId}`,
    });
    expect(both.statusCode).toBe(400);
    const neither = await app.inject({ method: "GET", headers: rioAuth, url: "/v1/pm/links" });
    expect(neither.statusCode).toBe(400);
  });
});
