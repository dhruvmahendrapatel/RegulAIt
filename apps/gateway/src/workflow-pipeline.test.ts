/**
 * Slice 6 e2e: the complete-pipeline workflow — intake → plan → requirements
 * artifact → human sign-off → automated_build (nested run on a mock agent) →
 * automated_check (mock check executor) → create_branch → open_pr → merge
 * gate → merge — driven exclusively through the public endpoints the /app and
 * /admin UIs call. Also covers the Workflows-tab plumbing this slice added:
 * the assignment-rule DELETE endpoint and the changeTypes list the intake
 * form derives its Type select from.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "test-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let piaId: string; // the initiator
let piaAuth: { authorization: string };
let anaId: string; // the named approver (sign-off + merge gate)
let anaAuth: { authorization: string };
let workerAgentId: string;
let templateId: string;

async function authFor(userId: string): Promise<{ authorization: string }> {
  const res = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${userId}/keys`,
    payload: { name: "test-key" },
  });
  return { authorization: `Bearer ${res.json().token}` };
}

const instanceView = (auth: { authorization: string }, id: string) =>
  app.inject({ method: "GET", headers: auth, url: `/v1/workflows/instances/${id}` });

const pendingFor = async (
  auth: { authorization: string },
  instanceId: string,
  stageId: string,
) => {
  const q = await app.inject({ method: "GET", headers: auth, url: "/v1/approvals?status=pending" });
  return q
    .json()
    .approvals.find(
      (a: { instanceId: string | null; stageId: string | null }) =>
        a.instanceId === instanceId && a.stageId === stageId,
    );
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });

  const pia = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: "pipe-pia@example.com", displayName: "Pipeline Pia" },
  });
  piaId = pia.json().id;
  piaAuth = await authFor(piaId);

  const ana = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: "pipe-ana@example.com", displayName: "Pipeline Ana" },
  });
  anaId = ana.json().id;
  anaAuth = await authFor(anaId);

  const agent = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: {
      name: "pipe-worker",
      provider: "mock",
      tier: 0,
      modes: ["execute"],
      costPerMTokIn: 1,
      costPerMTokOut: 5,
      model: "mock-pipe",
    },
  });
  workerAgentId = agent.json().id;
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/agents",
    payload: { userId: piaId, agentId: workerAgentId },
  });
});

afterAll(async () => {
  await app.close();
});

describe("complete pipeline: intake to merged through public endpoints only", () => {
  it("registers the mock git connection and the 10-stage template + rule", async () => {
    const conn = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/git/connections",
      payload: { name: "pipeline-e2e-git", provider: "mock", token: "not-a-real-token" },
    });
    expect(conn.statusCode).toBe(201);

    const tpl = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/templates",
      payload: {
        name: "pipeline-e2e",
        definition: {
          workflow: "pipeline-e2e",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "plan", type: "planning" },
            { id: "requirements", type: "artifact_generation", output: "requirements_file" },
            { id: "signoff", type: "human_approval", approvers: [anaId] },
            {
              id: "build",
              type: "automated_build",
              scope: "requirements_file",
              run: {
                run: "pipeline-e2e-build",
                escalationApproverUserId: anaId,
                nodes: [
                  { id: "implement", title: "Implement it", ownerAgentId: workerAgentId, mode: "execute", estimate: { in: 10, out: 20 } },
                  { id: "review", title: "Self-review it", ownerAgentId: workerAgentId, mode: "execute", dependsOn: ["implement"], estimate: { in: 5, out: 10 } },
                ],
              },
            },
            { id: "checks", type: "automated_check", checks: ["unit_tests", "lint", "security_scan"] },
            { id: "branch", type: "git_operation", action: "create_branch", connection: "pipeline-e2e-git", repo: "pipee2e/app" },
            { id: "open_pr", type: "git_operation", action: "open_pr", connection: "pipeline-e2e-git", repo: "pipee2e/app" },
            { id: "merge_gate", type: "human_approval", approvers: [anaId] },
            { id: "merge", type: "git_operation", action: "merge", connection: "pipeline-e2e-git", repo: "pipee2e/app", strategy: "squash" },
          ],
        },
      },
    });
    expect(tpl.statusCode).toBe(201);
    templateId = tpl.json().id;

    const rule = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/assignment-rules",
      payload: { templateId, changeType: "pipeline-e2e-change" },
    });
    expect(rule.statusCode).toBe(201);
  });

  it("exposes the routable changeTypes on the instances list a non-admin can read", async () => {
    const list = await app.inject({ method: "GET", headers: piaAuth, url: "/v1/workflows/instances" });
    expect(list.statusCode).toBe(200);
    expect(list.json().changeTypes).toContain("pipeline-e2e-change");
  });

  it("drives the full chain: artifact → sign-off → nested run → checks → branch/PR → merge gate → merged", async () => {
    // intake: the same POST the /app form makes, with a rule-routed changeType
    const started = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: "/v1/workflows/instances",
      payload: {
        change: {
          description: "pipeline e2e change",
          paths: ["src/pipeline.ts"],
          changeType: "pipeline-e2e-change",
          environment: "staging",
        },
      },
    });
    expect(started.statusCode).toBe(201);
    const instanceId = started.json().id;
    // trigger + planning auto-complete; the instance parks at the artifact
    expect(started.json().status).toBe("blocked_on_artifact");

    // plan-mode output: the requirements artifact
    const art = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "requirements", content: "# Pipeline requirements\n\n1. Do the thing." },
    });
    expect(art.json()).toMatchObject({ version: 1, status: "blocked_on_approval" });

    // the sign-off lands in ANA's inbox (she is the named approver)
    const signoff = await pendingFor(anaAuth, instanceId, "signoff");
    expect(signoff).toBeTruthy();
    expect(signoff.approverUserId).toBe(anaId);
    const approved = await app.inject({
      method: "POST",
      headers: anaAuth,
      url: `/v1/approvals/${signoff.id}/decide`,
      payload: { decision: "approved" },
    });
    expect(approved.statusCode).toBe(200);

    // approval unblocks into the build stage, which spawns the nested run
    let view = await instanceView(piaAuth, instanceId);
    expect(view.json().instance.status).toBe("awaiting_execution");
    const runId = view.json().instance.context["runId:build"];
    expect(runId).toBeTruthy();

    // the initiator drives the nested run exactly as the Runs page would
    const auto = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/runs/${runId}/auto`,
      payload: { acceptReviews: true },
    });
    expect(auto.statusCode).toBe(200);
    expect(auto.json().status).toBe("completed");

    // run completion cascades WITHOUT further human triggers: build succeeds,
    // the check executor records pass results, branch + PR run on the mock
    // provider, and the instance parks at the merge gate.
    view = await instanceView(piaAuth, instanceId);
    const inst = view.json().instance;
    expect(inst.status).toBe("blocked_on_approval");
    const ctx = inst.context;
    expect(ctx["checks:checks"]).toHaveLength(3);
    for (const result of ctx["checks:checks"]) {
      expect(result.status).toBe("passed");
      expect(result.detail).toContain("requirements_file v1");
    }
    expect(ctx.branch).toBe(`regulait/${instanceId.slice(0, 8)}`);
    expect(ctx.prId).toBe("1");
    expect(ctx.prUrl).toBe("mock://pipee2e/app/pull/1");
    // the rail shows the whole chain: everything before merge_gate completed
    const stageIds = inst.definition.stages.map((s: { id: string }) => s.id);
    expect(stageIds).toEqual([
      "intake", "plan", "requirements", "signoff", "build",
      "checks", "branch", "open_pr", "merge_gate", "merge",
    ]);
    const gateIndex = stageIds.indexOf("merge_gate");
    expect(inst.state.stageStatuses.slice(0, gateIndex)).toEqual(
      Array(gateIndex).fill("completed"),
    );
    expect(inst.state.currentStageIndex).toBe(gateIndex);

    // named checks can never be human-triggered past — the kernel refuses
    const bypass = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${instanceId}/advance`,
      payload: { stageId: "checks" },
    });
    expect(bypass.statusCode).toBe(409);

    // the merge approval is in ana's inbox; approving it merges and completes
    const mergeGate = await pendingFor(anaAuth, instanceId, "merge_gate");
    expect(mergeGate).toBeTruthy();
    expect(mergeGate.approverUserId).toBe(anaId);
    await app.inject({
      method: "POST",
      headers: anaAuth,
      url: `/v1/approvals/${mergeGate.id}/decide`,
      payload: { decision: "approved" },
    });

    view = await instanceView(piaAuth, instanceId);
    expect(view.json().instance.status).toBe("completed");
    expect(view.json().instance.context.mergeSha).toBe("sha-merge-1");
    expect(view.json().instance.state.stageStatuses).toEqual(Array(10).fill("completed"));

    // the event log recorded an execution success per executed stage
    const succeeded = view
      .json()
      .events.filter((e: { event: { kind: string } }) => e.event.kind === "execution_succeeded")
      .map((e: { event: { stageId: string } }) => e.event.stageId);
    expect(succeeded).toEqual(["build", "checks", "branch", "open_pr", "merge"]);
  });

  it("assignment rules are deletable by admins only, and deletion stops the routing", async () => {
    const rules = await app.inject({ method: "GET", headers: AUTH, url: "/v1/workflows/assignment-rules" });
    const rule = rules.json().rules.find(
      (r: { templateId: string; changeType: string | null }) =>
        r.templateId === templateId && r.changeType === "pipeline-e2e-change",
    );
    expect(rule).toBeTruthy();

    // non-admin: the admin gate refuses before the handler runs
    const forbidden = await app.inject({
      method: "DELETE",
      headers: piaAuth,
      url: `/v1/workflows/assignment-rules/${rule.id}`,
    });
    expect(forbidden.statusCode).toBe(403);

    const removed = await app.inject({
      method: "DELETE",
      headers: AUTH,
      url: `/v1/workflows/assignment-rules/${rule.id}`,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().removed).toBe(true);

    // deleting again is a clean 404, not a crash
    const again = await app.inject({
      method: "DELETE",
      headers: AUTH,
      url: `/v1/workflows/assignment-rules/${rule.id}`,
    });
    expect(again.statusCode).toBe(404);

    // the changeType no longer routes anywhere: intake dead-ends explicitly…
    const miss = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: "/v1/workflows/instances",
      payload: {
        change: {
          description: "no longer routed",
          paths: ["src/x.ts"],
          changeType: "pipeline-e2e-change",
          environment: "staging",
        },
      },
    });
    expect(miss.statusCode).toBe(422);
    expect(miss.json().error).toBe("no_workflow_matches_change");

    // …and the /app Type select no longer offers it
    const list = await app.inject({ method: "GET", headers: piaAuth, url: "/v1/workflows/instances" });
    expect(list.json().changeTypes).not.toContain("pipeline-e2e-change");
  });
});
