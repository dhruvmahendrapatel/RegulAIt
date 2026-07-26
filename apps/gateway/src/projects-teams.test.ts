import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

/**
 * Slice 4 — the create-affordances the two UIs grew, driven exactly as they
 * drive them (ADR-0012: the portals are pure API clients):
 *   · PATCH /v1/projects/:id — the /admin "Edit a project" form: budget and
 *     approver edits, the merged budget-requires-approver invariant, the
 *     rollup reading the NEW budget, classifications untouchable, non-admin
 *     403.
 *   · POST /v1/runs with the New Run form's exact JSON — per-node
 *     multi-sentence `instruction` stored on the graph and used as the
 *     worker's prompt (provable through the mock's deterministic token
 *     accounting), with an explicit dispatch-time input still winning.
 *   · GET /v1/teams enrichment (members with names) behind the /admin Teams
 *     section, and its admin-only gate.
 *
 * Shares one database with the other gateway suites (fileParallelism off),
 * so every object here is name-prefixed s4-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "s4-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let patId: string; // non-admin — plans runs, must never PATCH a project
let patAuth: { authorization: string };
let quinnId: string; // budget approver / arbiter / team member
let mockAgentId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  const pat = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: "s4-pat@example.com", displayName: "S4 Pat" },
  });
  expect(pat.statusCode).toBe(201);
  patId = pat.json().id;
  const patKey = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${patId}/keys`,
    payload: { name: "s4" },
  });
  patAuth = { authorization: `Bearer ${patKey.json().token}` };

  const quinn = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: "s4-quinn@example.com", displayName: "S4 Quinn" },
  });
  quinnId = quinn.json().id;

  const agent = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: {
      name: "s4-mock-worker",
      provider: "mock",
      tier: 1,
      costPerMTokIn: 3,
      costPerMTokOut: 15,
      model: "mock-balanced",
    },
  });
  expect(agent.statusCode).toBe(201);
  mockAgentId = agent.json().id;
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/agents",
    payload: { userId: patId, agentId: mockAgentId },
  });
});

describe("slice 4: PATCH /v1/projects/:id (the /admin edit form)", () => {
  let projectId: string;

  it("creates, patches the budget, and the rollup reads the NEW budget", async () => {
    const created = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/projects",
      payload: {
        name: "s4-edit-me",
        costCenter: "CC-S4",
        budgetUsd: 5,
        budgetApproverUserId: quinnId,
        classifications: ["s4-tag"],
      },
    });
    expect(created.statusCode).toBe(201);
    projectId = created.json().id;

    const patched = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/projects/${projectId}`,
      payload: { budgetUsd: 9 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().budgetUsd).toBe(9);
    expect(patched.json().budgetApproverUserId).toBe(quinnId); // untouched

    const rollup = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/projects/${projectId}/costs`,
    });
    expect(rollup.statusCode).toBe(200);
    expect(rollup.json().budget.budgetUsd).toBe(9);
    expect(rollup.json().budget.remainingUsd).toBe(9); // no spend yet
  });

  it("holds budget-requires-approver against the MERGED row, both directions", async () => {
    // removing the approver while a budget stands
    const orphanBudget = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/projects/${projectId}`,
      payload: { budgetApproverUserId: null },
    });
    expect(orphanBudget.statusCode).toBe(422);
    expect(orphanBudget.json().error).toBe("budget_requires_approver");

    // clearing both together is fine
    const cleared = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/projects/${projectId}`,
      payload: { budgetUsd: null, budgetApproverUserId: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().budgetUsd).toBeNull();

    // setting a budget on a row that now has no approver
    const budgetAlone = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/projects/${projectId}`,
      payload: { budgetUsd: 3 },
    });
    expect(budgetAlone.statusCode).toBe(422);

    // both halves in one patch restores it
    const restored = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/projects/${projectId}`,
      payload: { budgetUsd: 3, budgetApproverUserId: quinnId },
    });
    expect(restored.statusCode).toBe(200);
  });

  it("cannot touch classifications — a classifications-only PATCH is an empty update", async () => {
    const res = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/projects/${projectId}`,
      payload: { classifications: ["pci-dss"] },
    });
    // the schema strips the unknown key, leaving nothing to update
    expect(res.statusCode).toBe(400);
    const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/projects" });
    const row = list.json().projects.find((p: { id: string }) => p.id === projectId);
    expect(row.classifications).toEqual(["s4-tag"]); // untouched
  });

  it("edits name, cost center and arbiter in one patch, and audits the change", async () => {
    const res = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/projects/${projectId}`,
      payload: { name: "s4-edited", costCenter: "CC-S4B", arbiterUserId: quinnId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("s4-edited");
    expect(res.json().costCenter).toBe("CC-S4B");
    expect(res.json().arbiterUserId).toBe(quinnId);

    const audit = await app.inject({ method: "GET", headers: AUTH, url: "/v1/audit" });
    const entry = audit
      .json()
      .entries.find(
        (e: { ruleId: string; objectId: string | null }) =>
          e.ruleId === "project-updated" && e.objectId === projectId,
      );
    expect(entry).toBeTruthy();
  });

  it("403s a non-admin and 404s an unknown project", async () => {
    const forbidden = await app.inject({
      method: "PATCH",
      headers: patAuth,
      url: `/v1/projects/${projectId}`,
      payload: { budgetUsd: 999, budgetApproverUserId: quinnId },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error).toBe("admin_only");

    const missing = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: "/v1/projects/00000000-0000-4000-8000-000000000000",
      payload: { name: "nope" },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("slice 4: the New Run form's payload — per-node instructions", () => {
  // the feature template's first node, exactly as /app builds it
  const DESIGN_INSTRUCTION =
    "Draft the technical design for the feature named in the run title. Cover the API surface or " +
    "interfaces it adds or changes, the data it touches, and every error case you can foresee. " +
    "Call out anything that needs a migration or a staged rollout, and end with a short list of " +
    "open questions a reviewer should settle.";
  let runId: string;

  it("plans a run from the exact JSON the form POSTs; instructions survive validation", async () => {
    const res = await app.inject({
      method: "POST",
      headers: patAuth,
      url: "/v1/runs",
      payload: {
        graph: {
          run: "s4-form-run",
          escalationApproverUserId: patId,
          nodes: [
            {
              id: "design",
              title: "Design the change",
              instruction: DESIGN_INSTRUCTION,
              ownerAgentId: mockAgentId,
              mode: "execute",
              dependsOn: [],
            },
            {
              id: "implement",
              title: "Implement the change",
              instruction:
                "Implement the feature following the design produced by the design node. Describe " +
                "the change file by file and state explicitly how each error case is handled.",
              ownerAgentId: mockAgentId,
              mode: "execute",
              dependsOn: ["design"],
            },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(201);
    runId = res.json().id;

    // the stored graph carries the instructions — the kernel schema did not
    // strip them on the way through validation
    const view = await app.inject({ method: "GET", headers: patAuth, url: `/v1/runs/${runId}` });
    const nodes = view.json().run.graph.nodes;
    expect(nodes[0].instruction).toBe(DESIGN_INSTRUCTION);
    expect(nodes[1].instruction).toContain("file by file");
  });

  it("prompts the worker with the node's instruction, not its one-line title", async () => {
    const auto = await app.inject({
      method: "POST",
      headers: patAuth,
      url: `/v1/runs/${runId}/auto`,
      payload: { maxNodes: 1, acceptReviews: true },
    });
    expect(auto.statusCode).toBe(200);
    expect(auto.json().steps).toEqual([
      expect.objectContaining({ nodeId: "design", action: "accepted" }),
    ]);

    // the mock's token accounting is deterministic (ceil(len/4)), so the
    // dispatched input is provably the instruction and not the 17-char title
    const view = await app.inject({ method: "GET", headers: patAuth, url: `/v1/runs/${runId}` });
    const dispatched = view
      .json()
      .events.find(
        (e: { event: { kind: string; nodeId?: string } }) =>
          e.event.kind === "node_dispatched" && e.event.nodeId === "design",
      );
    expect(dispatched).toBeTruthy();
    expect(dispatched.event.usage.inputTokens).toBe(Math.ceil(DESIGN_INSTRUCTION.length / 4));
  });

  it("an explicit dispatch-time input still beats the stored instruction", async () => {
    const CUSTOM =
      "Ignore the canned instruction for this pass: implement only the request-validation half " +
      "of the design, and list what remains for a follow-up node.";
    const started = await app.inject({
      method: "POST",
      headers: patAuth,
      url: `/v1/runs/${runId}/events`,
      payload: { kind: "node_started", nodeId: "implement" },
    });
    expect(started.statusCode).toBe(200);

    const dispatch = await app.inject({
      method: "POST",
      headers: patAuth,
      url: `/v1/runs/${runId}/nodes/implement/dispatch`,
      payload: { input: CUSTOM },
    });
    expect(dispatch.statusCode).toBe(200);
    expect(dispatch.json().dispatch.usage.inputTokens).toBe(Math.ceil(CUSTOM.length / 4));
  });
});

describe("pillar-4 membership lifecycle: PATCH/DELETE members + last-owner", () => {
  let projectId: string;
  let ownerAId: string; // first owner
  let ownerBId: string; // second owner (so demote/remove leaves one behind)
  let memberId: string; // a contributor to promote/demote/remove
  let ownerAAuth: { authorization: string };
  let memberAuth: { authorization: string };

  const mkUser = async (email: string, name: string) => {
    const r = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: name },
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  };
  const authFor = async (userId: string) => {
    const r = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${userId}/keys`, payload: { name: "ml" },
    });
    return { authorization: `Bearer ${r.json().token}` };
  };
  const addMember = (userId: string, role: string) =>
    app.inject({
      method: "POST", headers: AUTH, url: `/v1/projects/${projectId}/members`,
      payload: { userId, role },
    });

  beforeAll(async () => {
    ownerAId = await mkUser("s4-owner-a@example.com", "S4 Owner A");
    ownerBId = await mkUser("s4-owner-b@example.com", "S4 Owner B");
    memberId = await mkUser("s4-member@example.com", "S4 Member");
    ownerAAuth = await authFor(ownerAId);
    memberAuth = await authFor(memberId);
    const project = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/projects", payload: { name: "s4-lifecycle" },
    });
    projectId = project.json().id;
    for (const [uid, role] of [
      [ownerAId, "owner"],
      [ownerBId, "owner"],
      [memberId, "contributor"],
    ] as const) {
      expect((await addMember(uid, role)).statusCode).toBe(201);
    }
  });

  it("an owner promotes a contributor to owner and the change is audited", async () => {
    const res = await app.inject({
      method: "PATCH", headers: ownerAAuth,
      url: `/v1/projects/${projectId}/members/${memberId}`,
      payload: { role: "owner" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe("owner");

    const audit = await app.inject({ method: "GET", headers: AUTH, url: "/v1/audit" });
    const entry = audit.json().entries.find(
      (e: { ruleId: string; objectId: string | null; detail: { memberUserId?: string } }) =>
        e.ruleId === "project-member-role-changed" &&
        e.objectId === projectId &&
        e.detail.memberUserId === memberId,
    );
    expect(entry).toBeTruthy();
    expect(entry.detail).toMatchObject({ from: "contributor", role: "owner" });

    // put it back to contributor for the following tests (three owners → one)
    const back = await app.inject({
      method: "PATCH", headers: ownerAAuth,
      url: `/v1/projects/${projectId}/members/${memberId}`,
      payload: { role: "contributor" },
    });
    expect(back.statusCode).toBe(200);
  });

  it("removing a member is audited and drops them from the list", async () => {
    const res = await app.inject({
      method: "DELETE", headers: ownerAAuth,
      url: `/v1/projects/${projectId}/members/${memberId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ removed: true });

    const list = await app.inject({
      method: "GET", headers: ownerAAuth, url: `/v1/projects/${projectId}/members`,
    });
    expect(list.json().members.find((m: { userId: string }) => m.userId === memberId)).toBeUndefined();

    const audit = await app.inject({ method: "GET", headers: AUTH, url: "/v1/audit" });
    expect(
      audit.json().entries.some(
        (e: { ruleId: string; detail: { memberUserId?: string } }) =>
          e.ruleId === "project-member-removed" && e.detail.memberUserId === memberId,
      ),
    ).toBe(true);
  });

  it("a 404 for a non-member on both PATCH and DELETE", async () => {
    const patch = await app.inject({
      method: "PATCH", headers: ownerAAuth,
      url: `/v1/projects/${projectId}/members/${memberId}`, // just removed
      payload: { role: "viewer" },
    });
    expect(patch.statusCode).toBe(404);
    expect(patch.json().error).toBe("not_a_member");
    const del = await app.inject({
      method: "DELETE", headers: ownerAAuth,
      url: `/v1/projects/${projectId}/members/${memberId}`,
    });
    expect(del.statusCode).toBe(404);
  });

  it("LAST-OWNER hard-block: with two owners one demote is allowed, the second is 409", async () => {
    // two owners remain (A, B). Demote B → allowed (A left).
    const demoteB = await app.inject({
      method: "PATCH", headers: ownerAAuth,
      url: `/v1/projects/${projectId}/members/${ownerBId}`,
      payload: { role: "contributor" },
    });
    expect(demoteB.statusCode).toBe(200);

    // A is now the sole owner. Demoting A would orphan the project → 409.
    const demoteA = await app.inject({
      method: "PATCH", headers: ownerAAuth,
      url: `/v1/projects/${projectId}/members/${ownerAId}`,
      payload: { role: "contributor" },
    });
    expect(demoteA.statusCode).toBe(409);
    expect(demoteA.json().error).toBe("last_owner");
  });

  it("LAST-OWNER hard-block also guards DELETE of the sole owner", async () => {
    const delA = await app.inject({
      method: "DELETE", headers: ownerAAuth,
      url: `/v1/projects/${projectId}/members/${ownerAId}`,
    });
    expect(delA.statusCode).toBe(409);
    expect(delA.json().error).toBe("last_owner");
    // and the owner is still there
    const list = await app.inject({
      method: "GET", headers: ownerAAuth, url: `/v1/projects/${projectId}/members`,
    });
    expect(list.json().members.find((m: { userId: string }) => m.userId === ownerAId).role).toBe("owner");
  });

  it("a non-owner member cannot PATCH or DELETE membership (403)", async () => {
    // re-add the contributor to have a non-owner actor
    await addMember(memberId, "contributor");
    const patch = await app.inject({
      method: "PATCH", headers: memberAuth,
      url: `/v1/projects/${projectId}/members/${ownerAId}`,
      payload: { role: "viewer" },
    });
    expect(patch.statusCode).toBe(403);
    const del = await app.inject({
      method: "DELETE", headers: memberAuth,
      url: `/v1/projects/${projectId}/members/${ownerAId}`,
    });
    expect(del.statusCode).toBe(403);
  });
});

describe("slice 4: the /admin Teams surface", () => {
  it("creates a team, adds a member, and the list names its members", async () => {
    const team = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/teams",
      payload: { name: "s4-team", defaultClassifications: ["s4-tag"] },
    });
    expect(team.statusCode).toBe(201);
    const teamId = team.json().id;

    const added = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/teams/${teamId}/members`,
      payload: { userId: quinnId },
    });
    expect(added.statusCode).toBe(201);

    // adding the same member twice is a clean conflict, not a duplicate row
    const dup = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/teams/${teamId}/members`,
      payload: { userId: quinnId },
    });
    expect(dup.statusCode).toBe(409);

    const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/teams" });
    const row = list.json().teams.find((t: { id: string }) => t.id === teamId);
    expect(row.defaultClassifications).toEqual(["s4-tag"]);
    expect(row.members).toEqual([{ userId: quinnId, name: "S4 Quinn" }]);
  });

  it("stays admin-only", async () => {
    const res = await app.inject({ method: "GET", headers: patAuth, url: "/v1/teams" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("admin_only");
  });
});
