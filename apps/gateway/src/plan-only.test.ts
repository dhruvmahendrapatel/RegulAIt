import { beforeAll, describe, expect, it, afterAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { guardProjectPlanOnly } from "./plan-only.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

/**
 * ADR-0079 — PILLAR 2 §2 STAGE 2: "forced planning-only reasoning first, no
 * code/state mutation possible in this stage", made real.
 *
 * The ORDERING guarantee was always real (nothing builds before sign-off, and
 * `runGitExecutions` re-validates the current stage under a row lock) and is
 * NOT re-proved here. What this file pins is the narrower thing that was
 * missing: while a change is being PLANNED, a direct
 * `POST /v1/agents/:id/invoke` had no relation to the instance at all, because
 * an invoke body carried `projectId` and never an `instanceId`.
 *
 * So, in order:
 *  1. the instance actually RESTS at the planning stage (kernel semantics
 *     change — it used to auto-complete, so nothing could ever observe it);
 *  2. a plan/read mode attributed to it is ALLOWED;
 *  3. a mutating mode attributed to it is REFUSED (`plan_only_stage`), with the
 *     deny audited on the instance's own trail and the message naming both the
 *     instance and the stage;
 *  4. the SAME call succeeds once planning is explicitly finished — the control
 *     (M-002), so a refusal proves the gate rather than general breakage;
 *  5. an unknown / someone-else's instance REFUSES rather than being ignored;
 *  6. ADR-0250 (review P-02): the gate is FORCED at project level — an
 *     `execute` naming NO instance is refused while any live instance of the
 *     project it bills to rests in planning, on the invoke and run paths alike,
 *     and the workflow engine's own work for another instance is the one
 *     audited exception. (The compat and MCP surfaces are pinned in
 *     adr0250-plan-gate-surfaces.test.ts.)
 *
 * Shares one DB with the other gateway suites (fileParallelism off); everything
 * here is prefixed po-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "po-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let piaId: string;
let piaAuth: { authorization: string };
let malloryId: string;
let malloryAuth: { authorization: string };
let anaId: string;
let agentId: string;
let projectId: string;

async function makeUser(email: string) {
  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: email.split("@")[0] },
  });
  expect(user.statusCode).toBe(201);
  const key = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${user.json().id}/keys`,
    payload: { name: "test" },
  });
  return { id: user.json().id as string, auth: { authorization: `Bearer ${key.json().token}` } };
}

/** a fresh instance of the plan-first template, resting at plan-only */
async function startInstance(auth = piaAuth, project?: string) {
  const started = await app.inject({
    method: "POST",
    headers: auth,
    url: "/v1/workflows/instances",
    payload: {
      ...(project ? { projectId: project } : {}),
      change: {
        description: "po change",
        paths: ["src/po.ts"],
        changeType: "po-change",
        environment: "staging",
      },
    },
  });
  expect(started.statusCode).toBe(201);
  expect(started.json().status).toBe("blocked_on_plan");
  return started.json().id as string;
}

/** the exact call the refusal message tells a caller to make */
async function leavePlanOnly(instanceId: string, auth = piaAuth) {
  const res = await app.inject({
    method: "POST",
    headers: auth,
    url: `/v1/workflows/instances/${instanceId}/advance`,
    payload: { stageId: "plan" },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

/** the invoke under test — decision-only by default (the gate runs before any
 * dispatch, so nothing here needs to bill a provider) */
async function invoke(
  extra: Record<string, unknown>,
  auth = piaAuth,
): Promise<ReturnType<typeof app.inject>> {
  return app.inject({
    method: "POST",
    headers: auth,
    url: `/v1/agents/${agentId}/invoke`,
    payload: { mode: "execute", input: "po probe", ...extra },
  });
}

async function auditFor(instanceId: string, ruleId: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.objectId, instanceId), eq(auditLog.ruleId, ruleId)));
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "f".repeat(64) });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });

  const pia = await makeUser("po-pia@example.com");
  piaId = pia.id;
  piaAuth = pia.auth;
  const mallory = await makeUser("po-mallory@example.com");
  malloryId = mallory.id;
  malloryAuth = mallory.auth;
  const ana = await makeUser("po-ana@example.com");
  anaId = ana.id;

  // no `modes` on the registry row = the registry does not constrain modes, so
  // every mode this file tries reaches the plan-only gate rather than being
  // stopped earlier by pillar 1 for an unrelated reason.
  const agent = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: {
      name: "po-agent",
      provider: "mock",
      tier: 1,
      model: "mock-balanced",
      costPerMTokIn: 1,
      costPerMTokOut: 2,
    },
  });
  expect(agent.statusCode).toBe(201);
  agentId = agent.json().id;
  for (const userId of [piaId, malloryId]) {
    // ADR-0250 (S-04): a grant mint is a step-up action; this suite does not test step-up, so it is relaxed for the call
    const g = await relaxStepUpAround(db, () =>
      app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/grants/agents",
        payload: { userId, agentId },
      }),
    );
    expect(g.statusCode).toBe(201);
  }

  // ADR-0250: a project Pia bills to, for the project-level gate
  const project = await app.inject({ method: "POST", headers: AUTH, url: "/v1/projects", payload: { name: "po-project" } });
  expect(project.statusCode).toBe(201);
  projectId = project.json().id;
  const member = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/projects/${projectId}/members`,
    payload: { userId: piaId, role: "contributor" },
  });
  expect(member.statusCode, member.body).toBe(201);

  const tpl = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/templates",
    payload: {
      name: "po-plan-first",
      definition: {
        workflow: "po-plan-first",
        stages: [
          { id: "intake", type: "trigger" },
          { id: "plan", type: "planning" },
          { id: "requirements", type: "artifact_generation", output: "requirements_file" },
          { id: "signoff", type: "human_approval", approvers: [anaId] },
        ],
      },
    },
  });
  expect(tpl.statusCode).toBe(201);
  const rule = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/assignment-rules",
    payload: { templateId: tpl.json().id, changeType: "po-change" },
  });
  expect(rule.statusCode).toBe(201);
});

describe("the planning stage rests (ADR-0079 kernel semantics change)", () => {
  it("an instance comes to rest AT the planning stage instead of running through it", async () => {
    const instanceId = await startInstance();
    const view = await app.inject({
      method: "GET",
      headers: piaAuth,
      url: `/v1/workflows/instances/${instanceId}`,
    });
    expect(view.statusCode).toBe(200);
    const inst = view.json().instance;
    expect(inst.status).toBe("blocked_on_plan");
    expect(inst.definition.stages[inst.state.currentStageIndex].id).toBe("plan");
    expect(inst.state.stageStatuses[1]).toBe("active");
    // and the artifact stage is genuinely NOT reachable yet
    const early = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "requirements", content: "# too early" },
    });
    expect(early.statusCode).toBe(409);
  });
});

describe("the plan-only gate on a direct agent invoke", () => {
  it("a PLAN-mode invoke attributed to a plan-only instance is allowed, and audited as attributed", async () => {
    const instanceId = await startInstance();
    const res = await invoke({ mode: "plan", instanceId });
    expect(res.statusCode).toBe(200);
    expect(res.json().decision.effect).toBe("allow");
    const allows = await auditFor(instanceId, "workflow-instance-attributed");
    expect(allows.length).toBe(1);
    expect(allows[0]!.effect).toBe("allow");
    expect((allows[0]!.detail as { mode: string }).mode).toBe("plan");
    expect((allows[0]!.detail as { planOnlyStageId: string }).planOnlyStageId).toBe("plan");
    // nothing was refused
    expect((await auditFor(instanceId, "workflow-plan-only-stage")).length).toBe(0);
  });

  it("an EXECUTE-mode invoke attributed to the same instance is refused, naming the instance and the stage", async () => {
    const instanceId = await startInstance();
    const res = await invoke({ mode: "execute", instanceId });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("plan_only_stage");
    const detail = res.json().detail as string;
    expect(detail).toContain(instanceId);
    expect(detail).toContain("plan-only stage 'plan'");
    // actionable: it names the exact call that lifts the refusal
    expect(detail).toContain(`/v1/workflows/instances/${instanceId}/advance`);

    const denies = await auditFor(instanceId, "workflow-plan-only-stage");
    expect(denies.length).toBe(1);
    expect(denies[0]!.effect).toBe("deny");
    expect(denies[0]!.objectType).toBe("workflow");
    expect(denies[0]!.userId).toBe(piaId);
    expect(denies[0]!.reason).toContain("plan-only stage 'plan'");
    expect((denies[0]!.detail as { agentId: string }).agentId).toBe(agentId);
  });

  it("the rule is default-deny on the open mode vocabulary: an unknown mode mutates, 'review' does not", async () => {
    const instanceId = await startInstance();
    // `mode` is z.string() — a mode nobody enumerated is treated as mutating
    const invented = await invoke({ mode: "refactor-everything", instanceId });
    expect(invented.statusCode).toBe(409);
    expect(invented.json().error).toBe("plan_only_stage");
    // case/whitespace are normalized, so "  Execute " is not a way around it
    const padded = await invoke({ mode: "  Execute ", instanceId });
    expect(padded.statusCode).toBe(409);
    // a named plan-safe mode still passes
    const review = await invoke({ mode: "review", instanceId });
    expect(review.statusCode).toBe(200);
  });

  it("CONTROL: the SAME execute invoke is allowed once the planning stage is advanced past", async () => {
    const instanceId = await startInstance();
    expect((await invoke({ mode: "execute", instanceId })).statusCode).toBe(409);

    const advanced = await leavePlanOnly(instanceId);
    expect(advanced.status).toBe("blocked_on_artifact");

    const after = await invoke({ mode: "execute", instanceId });
    expect(after.statusCode).toBe(200);
    expect(after.json().decision.effect).toBe("allow");
    // the allowed call is attributed and audited; the deny count did not grow
    const allows = await auditFor(instanceId, "workflow-instance-attributed");
    expect(allows.length).toBe(1);
    expect((allows[0]!.detail as { planOnlyStageId: string | null }).planOnlyStageId).toBeNull();
    expect((await auditFor(instanceId, "workflow-plan-only-stage")).length).toBe(1);
  });

  it("an unknown instance refuses, and someone else's instance refuses — never ignored", async () => {
    const unknown = await invoke({
      mode: "plan",
      instanceId: "00000000-0000-4000-8000-0000000000ff",
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toBe("invalid_reference");

    // Mallory holds the agent grant, so only the ATTRIBUTION can refuse her
    const instanceId = await startInstance();
    const stranger = await invoke({ mode: "plan", instanceId }, malloryAuth);
    expect(stranger.statusCode).toBe(403);
    expect(stranger.json().error).toBe("not_an_instance_participant");
    // a refused attribution writes no attribution row on the instance's trail
    expect((await auditFor(instanceId, "workflow-instance-attributed")).length).toBe(0);
  });

  it("ADR-0250 (P-02): FORCED — an execute naming NO instance is refused while the project's instance plans", async () => {
    const instanceId = await startInstance(piaAuth, projectId);
    // the call that used to pass: execute, a real dispatch, no instanceId — only the project it bills to
    const bare = await invoke({ mode: "execute", dispatch: true, projectId });
    expect(bare.statusCode, bare.body).toBe(409);
    expect(bare.json().error).toBe("plan_only_stage");
    expect(bare.json().instanceId).toBe(instanceId);
    expect(bare.json().detail as string).toContain(`project '${projectId}'`);
    expect(bare.json().detail as string).toContain(`/v1/workflows/instances/${instanceId}/advance`);
    // audited on the planning instance's own trail, marked as the project-level enforcement
    const denies = await auditFor(instanceId, "workflow-plan-only-stage");
    expect(denies.length).toBe(1);
    expect(denies[0]!.effect).toBe("deny");
    expect(denies[0]!.detail).toMatchObject({ enforcement: "project", surface: "invoke", projectId, mode: "execute" });
    // a plan/read mode on the same project is untouched
    const plan = await invoke({ mode: "plan", projectId });
    expect(plan.statusCode).toBe(200);
    // the control (M-002): the same call passes once planning is explicitly finished
    await leavePlanOnly(instanceId);
    const after = await invoke({ mode: "execute", dispatch: true, projectId });
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json().dispatch?.outputText).toBeTruthy();
    expect((await auditFor(instanceId, "workflow-plan-only-stage")).length).toBe(1);
  });

  it("ADR-0250: naming ANOTHER instance of the project does not get round a planning one", async () => {
    const building = await startInstance(piaAuth, projectId);
    await leavePlanOnly(building);
    const planning = await startInstance(piaAuth, projectId);
    const res = await invoke({ mode: "execute", instanceId: building, projectId });
    expect(res.statusCode).toBe(409);
    expect(res.json().instanceId).toBe(planning);
    await leavePlanOnly(planning);
    expect((await invoke({ mode: "execute", instanceId: building, projectId })).statusCode).toBe(200);
  });

  it("ADR-0250 exception: the engine's own work for another instance passes, audited; its own planning instance refuses", async () => {
    const planning = await startInstance(piaAuth, projectId);
    const other = "00000000-0000-4000-8000-0000000000ee";
    const passed = await guardProjectPlanOnly(db, {
      projectIds: [projectId],
      userId: piaId,
      surface: "runs",
      mutating: true,
      mode: "execute",
      engineInstanceId: other,
    });
    expect(passed.ok).toBe(true);
    const exceptions = await auditFor(planning, "workflow-plan-only-engine-exception");
    expect(exceptions.length).toBe(1);
    expect(exceptions[0]!.effect).toBe("allow");
    expect(exceptions[0]!.detail).toMatchObject({ engineInstanceId: other, surface: "runs" });
    const own = await guardProjectPlanOnly(db, {
      projectIds: [projectId],
      userId: piaId,
      surface: "runs",
      mutating: true,
      mode: "execute",
      engineInstanceId: planning,
    });
    expect(own.ok).toBe(false);
    await leavePlanOnly(planning);
  });
});

describe("the plan-only gate on the run-plan path", () => {
  const graph = (name: string, mode: string) => ({
    run: name,
    escalationApproverUserId: anaId,
    nodes: [
      {
        id: "w",
        title: `po ${mode} node`,
        ownerAgentId: agentId,
        mode,
        estimate: { in: 10, out: 20 },
      },
    ],
  });

  it("a run naming a plan-only instance is refused when any node mutates, and named in the refusal", async () => {
    const instanceId = await startInstance();
    const res = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: "/v1/runs",
      payload: { graph: graph("po-run-exec", "execute"), workflowInstanceId: instanceId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("plan_only_stage");
    expect(res.json().detail as string).toContain("node 'w' (mode 'execute')");
  });

  it("a plan-safe graph plans fine, and the mutating one plans once planning is finished", async () => {
    const instanceId = await startInstance();
    const safe = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: "/v1/runs",
      payload: { graph: graph("po-run-plan", "plan"), workflowInstanceId: instanceId },
    });
    expect(safe.statusCode).toBe(201);

    await leavePlanOnly(instanceId);
    const after = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: "/v1/runs",
      payload: { graph: graph("po-run-exec-ok", "execute"), workflowInstanceId: instanceId },
    });
    expect(after.statusCode).toBe(201);
  });

  it("ADR-0250 (P-02): a mutating run naming NO instance is refused while the project's instance plans", async () => {
    const instanceId = await startInstance(piaAuth, projectId);
    const res = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: "/v1/runs",
      payload: { graph: graph("po-run-proj-exec", "execute"), projectId },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe("plan_only_stage");
    expect(res.json().instanceId).toBe(instanceId);
    expect(res.json().detail as string).toContain("node 'w' (mode 'execute')");
    const denies = await auditFor(instanceId, "workflow-plan-only-stage");
    expect(denies.at(-1)!.detail).toMatchObject({ enforcement: "project", surface: "runs" });
    const safe = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: "/v1/runs",
      payload: { graph: graph("po-run-proj-plan", "plan"), projectId },
    });
    expect(safe.statusCode, safe.body).toBe(201);
    await leavePlanOnly(instanceId);
    const after = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: "/v1/runs",
      payload: { graph: graph("po-run-proj-exec-ok", "execute"), projectId },
    });
    expect(after.statusCode, after.body).toBe(201);
  });

  it("the run path validates the instance link too: unknown refuses instead of failing on a foreign key", async () => {
    const res = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: "/v1/runs",
      payload: {
        graph: graph("po-run-unknown", "plan"),
        workflowInstanceId: "00000000-0000-4000-8000-0000000000ff",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_reference");
  });
});

afterAll(async () => {
  await restoreSb2Gates();
});
