import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, eq, orgSettings, runMigrations, sql, workflowInstances, type Db } from "@regulait/db";
import { resolveProvider, type MockGitProvider } from "@regulait/git-provider";
import { buildApp } from "./app.js";
import {
  applyWorkflowApprovalDecision,
  CHECK_PENDING_DETAIL,
  EFFECT_HISTORY_KEY,
  EFFECT_STAMPS_KEY,
  reopenWorkflowInstance,
  workflowTestHooks,
  type EffectHistoryEntry,
  type EffectStamp,
} from "./workflows.js";

/**
 * AER-048 — the check executor, check reports and re-opens are bound to a
 * durable ROUND / STAGE-ENTRY token (workflow_instances.round / stage_entry,
 * migration 0130).
 *
 * The defect: `runGitExecutions` claimed a stage under a short lock, spent as
 * long as the evals took with no lock at all, then wrote back the WHOLE
 * context it had snapshotted at claim time. A report committed meanwhile was
 * silently lost; a re-open's clearing of the stale check keys was undone; and
 * reports carried no round, so a result produced for a previous artifact was
 * stored into the new round.
 *
 * These are BARRIER tests: `workflowTestHooks.duringStageEval` parks the
 * executor inside its lock-free eval window on a promise the test controls,
 * the concurrent action commits, and only then is the executor released. No
 * sleeps — the interleaving is the one the test names, every run.
 *
 * Shares one DB with the other suites (fileParallelism off); everything is
 * prefixed wr-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "wr-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let piaAuth: { authorization: string };
let anaId: string;
let anaAuth: { authorization: string };
let ciAuth: { authorization: string };
let piaId: string;
let adminId: string;
const CSRF = { "x-regulait-csrf": "1" };

async function makeUser(email: string, isAdmin = false) {
  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: email.split("@")[0], ...(isAdmin ? { isAdmin: true } : {}) },
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

async function makeTemplate(name: string, changeType: string, stages: unknown[]) {
  const tpl = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/templates",
    payload: { name, definition: { workflow: name, stages } },
  });
  expect(tpl.statusCode).toBe(201);
  const rule = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/assignment-rules",
    payload: { templateId: tpl.json().id, changeType },
  });
  expect(rule.statusCode).toBe(201);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });
  const pia = await makeUser("wr-pia@example.com");
  piaAuth = pia.auth;
  piaId = pia.id;
  adminId = (await makeUser("wr-console-admin@example.com", true)).id;
  const ana = await makeUser("wr-ana@example.com");
  anaId = ana.id;
  anaAuth = ana.auth;
  // an arm's-length admin standing in for CI (no ADR-0167 self-report reason)
  ciAuth = (await makeUser("wr-ci-bot@example.com", true)).auth;

  // gate → two consecutive check stages → final gate
  await makeTemplate("wr-flow", "wr-flow", [
    { id: "intake", type: "trigger" },
    { id: "gate", type: "human_approval", approvers: [anaId] },
    { id: "checks", type: "automated_check", checks: ["unit_tests", "lint"] },
    { id: "checks2", type: "automated_check", checks: ["smoke"] },
    { id: "done", type: "human_approval", approvers: [anaId] },
  ]);
  // external effects downstream of a re-openable artifact (review item 1)
  const target = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/deploy/targets",
    payload: { name: "wr-staging", provider: "mock", environment: "staging" },
  });
  expect(target.statusCode).toBe(201);
  await makeTemplate("wr-deploy", "wr-deploy", [
    { id: "intake", type: "trigger" },
    { id: "req", type: "artifact_generation", output: "requirements_file" },
    { id: "gate", type: "human_approval", approvers: [anaId] },
    { id: "deploy", type: "deployment", connection: "wr-staging", environment: "staging" },
    { id: "done", type: "human_approval", approvers: [anaId] },
  ]);
  const conn = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/git/connections",
    payload: { name: "wr-git", provider: "mock", token: "not-a-real-token" },
  });
  expect(conn.statusCode).toBe(201);
  await makeTemplate("wr-git", "wr-git", [
    { id: "intake", type: "trigger" },
    { id: "req", type: "artifact_generation", output: "requirements_file" },
    { id: "gate", type: "human_approval", approvers: [anaId] },
    { id: "branch", type: "git_operation", action: "create_branch", connection: "wr-git", repo: "wr/app" },
    { id: "open_pr", type: "git_operation", action: "open_pr", connection: "wr-git", repo: "wr/app" },
    { id: "merge_gate", type: "human_approval", approvers: [anaId] },
    { id: "merge", type: "git_operation", action: "merge", connection: "wr-git", repo: "wr/app" },
    { id: "done", type: "human_approval", approvers: [anaId] },
  ]);
  // a nested build run downstream of a re-openable artifact (review item 5)
  const agent = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name: "wr-worker", provider: "mock", tier: 0, modes: ["execute"], costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-wr" },
  });
  expect(agent.statusCode).toBe(201);
  await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: piaId, agentId: agent.json().id } });
  await makeTemplate("wr-build", "wr-build", [
    { id: "intake", type: "trigger" },
    { id: "req", type: "artifact_generation", output: "requirements_file" },
    { id: "gate", type: "human_approval", approvers: [anaId] },
    {
      id: "build",
      type: "automated_build",
      scope: "requirements_file",
      run: {
        run: "wr-build",
        escalationApproverUserId: anaId,
        nodes: [{ id: "implement", title: "Implement it", ownerAgentId: agent.json().id, mode: "execute", estimate: { in: 10, out: 20 } }],
      },
    },
    { id: "done", type: "human_approval", approvers: [anaId] },
  ]);
  // an artifact upstream of the gate, so a resubmission RE-OPENS the flow
  await makeTemplate("wr-reopen", "wr-reopen", [
    { id: "intake", type: "trigger" },
    { id: "req", type: "artifact_generation", output: "requirements_file" },
    { id: "gate", type: "human_approval", approvers: [anaId] },
    { id: "checks", type: "automated_check", checks: ["unit_tests", "lint"] },
    { id: "done", type: "human_approval", approvers: [anaId] },
  ]);
});

afterEach(() => {
  delete workflowTestHooks.duringStageEval;
  delete workflowTestHooks.beforeStageCommit;
});

afterAll(async () => {
  delete workflowTestHooks.duringStageEval;
  delete workflowTestHooks.beforeStageCommit;
  await app.close();
});

/** park the FIRST locked completion of (instance, stage) until `release()` —
 * the executor has already PERFORMED its work (a deploy, a merge) */
function parkFirstCommit(instanceId: string, stageId: string) {
  let release!: () => void;
  let reached!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const arrived = new Promise<void>((r) => (reached = r));
  let used = false;
  workflowTestHooks.beforeStageCommit = async (at) => {
    if (used || at.instanceId !== instanceId || at.stageId !== stageId) return;
    used = true;
    reached();
    await released;
  };
  return { arrived, release };
}

/** park the FIRST evaluation of (instance, stage) until `release()`; every
 * later evaluation (another executor) passes straight through */
function parkFirstEval(instanceId: string, stageId: string) {
  let release!: () => void;
  let reached!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const arrived = new Promise<void>((r) => (reached = r));
  let used = false;
  workflowTestHooks.duringStageEval = async (at) => {
    if (used || at.instanceId !== instanceId || at.stageId !== stageId) return;
    used = true;
    reached();
    await released;
  };
  return { arrived, release };
}

async function startInstance(changeType: string) {
  const started = await app.inject({
    method: "POST",
    headers: piaAuth,
    url: "/v1/workflows/instances",
    payload: { change: { description: "wr change", paths: ["src/x.ts"], changeType, environment: "staging" } },
  });
  expect(started.statusCode).toBe(201);
  return started.json().id as string;
}

async function view(instanceId: string) {
  const res = await app.inject({ method: "GET", headers: piaAuth, url: `/v1/workflows/instances/${instanceId}` });
  expect(res.statusCode).toBe(200);
  return res.json().instance as {
    status: string;
    round: number;
    stageEntry: number;
    context: Record<string, unknown>;
    state: { currentStageIndex: number };
  };
}

/** the decide request for the pending gate — NOT awaited by the caller when
 * the executor it cascades into is parked */
async function approveGate(instanceId: string, stageId = "gate") {
  const q = await app.inject({ method: "GET", headers: anaAuth, url: "/v1/approvals?status=pending" });
  const a = (q.json().approvals ?? []).find(
    (x: { instanceId: string; stageId: string }) => x.instanceId === instanceId && x.stageId === stageId,
  );
  expect(a).toBeTruthy();
  return app.inject({
    method: "POST",
    headers: anaAuth,
    url: `/v1/approvals/${a.id}/decide`,
    payload: { decision: "approved" },
  });
}

/** a CI report (API key) — `round` is required of a key caller, so pass
 * `"none"` to send a report that names no round */
function report(
  instanceId: string,
  stageId: string,
  results: Array<{ check: string; status: "passed" | "failed" }>,
  round: number | "none" = 0,
) {
  return app.inject({
    method: "POST",
    headers: ciAuth,
    url: `/v1/workflows/instances/${instanceId}/checks`,
    payload: { stageId, results, ...(round !== "none" ? { round } : {}) },
  });
}

async function setAllowUnbound(on: boolean) {
  const res = await app.inject({ method: "PUT", headers: AUTH, url: "/v1/org/settings", payload: { checkReportsAllowUnbound: on } });
  expect(res.statusCode).toBe(200);
}

/** a console session for an admin (password onboarding, as auth.test does) */
async function consoleCookie(userId: string, email: string): Promise<string> {
  const pw = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${userId}/set-initial-password`, payload: {} });
  expect(pw.statusCode).toBe(200);
  const oneTime = pw.json().password as string;
  const first = await app.inject({ method: "POST", url: "/auth/login", headers: CSRF, payload: { email, password: oneTime } });
  expect(first.statusCode).toBe(200);
  const cookie = first.cookies.find((c) => c.name === "regulait_session")!.value;
  const changed = await app.inject({
    method: "POST",
    url: "/auth/change-password",
    headers: CSRF,
    cookies: { regulait_session: cookie },
    payload: { currentPassword: oneTime, newPassword: "Wr-console-Passw0rd!x" },
  });
  expect(changed.statusCode).toBe(200);
  return cookie;
}

async function submitArtifact(instanceId: string, content: string) {
  const res = await app.inject({
    method: "POST",
    headers: piaAuth,
    url: `/v1/workflows/instances/${instanceId}/artifacts`,
    payload: { stageId: "req", content },
  });
  expect(res.statusCode).toBe(201);
}

async function auditFor(instanceId: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.objectType, "workflow"), eq(auditLog.objectId, instanceId)));
}

type Evaluated = { check: string; status: string; detail?: string };
const historyOf = (ctx: Record<string, unknown>) => (ctx[EFFECT_HISTORY_KEY] as EffectHistoryEntry[] | undefined) ?? [];
const stampsOf = (ctx: Record<string, unknown>) => (ctx[EFFECT_STAMPS_KEY] as Record<string, EffectStamp> | undefined) ?? {};
const statusOf = (ctx: Record<string, unknown>, stage: string, check: string) =>
  ((ctx[`checks:${stage}`] as Evaluated[] | undefined) ?? []).find((r) => r.check === check)?.status;

describe("AER-048 — check executor, reports and re-opens bind to the round / stage-entry token", () => {
  it("(1) a report posted while the executor is mid-eval is RETAINED and decides the verdict", async () => {
    const id = await startInstance("wr-flow");
    expect((await report(id, "checks", [{ check: "unit_tests", status: "passed" }])).statusCode).toBe(200);

    const park = parkFirstEval(id, "checks");
    const decide = approveGate(id); // cascades into the check executor, which parks
    await park.arrived;
    // the executor holds the claim; its snapshot has unit_tests only
    expect((await view(id)).context.executing).toBe("checks");

    // CI posts lint while the executor is parked mid-eval: accepted, and the
    // response says plainly it was NOT evaluated by this request (202)
    const lint = await report(id, "checks", [{ check: "lint", status: "passed" }]);
    expect(lint.statusCode).toBe(202);
    expect(lint.json().evaluation).toBe("deferred_to_running_executor");

    park.release();
    const decided = await decide;
    expect(decided.statusCode).toBe(200);
    expect(decided.json().executionError).toBeUndefined();

    const after = await view(id);
    // the report survived the executor's completion…
    expect((after.context["reported:checks"] as Evaluated[]).map((r) => r.check).sort()).toEqual(["lint", "unit_tests"]);
    // …and was part of its verdict: both green, so the stage advanced into
    // checks2 (which waits on smoke) instead of waiting on a lint it "missed"
    expect(statusOf(after.context, "checks", "lint")).toBe("passed");
    expect(after.context["awaitingReport:checks"]).toBeUndefined();
    expect(after.status).toBe("awaiting_execution");
    expect(statusOf(after.context, "checks2", "smoke")).toBe("pending");
    expect(after.context.executing).toBeUndefined();
  });

  it("(2) a RE-OPEN during the eval: the old executor can neither restore the cleared check keys nor advance the instance", async () => {
    const id = await startInstance("wr-reopen");
    await submitArtifact(id, "v1 requirements");
    // round-0 CI results for v1 — everything green
    expect((await report(id, "checks", [{ check: "unit_tests", status: "passed" }, { check: "lint", status: "passed" }])).statusCode).toBe(200);
    const before = await view(id);
    expect(before.round).toBe(0);

    const park = parkFirstEval(id, "checks");
    const decide = approveGate(id);
    await park.arrived;

    // the initiator resubmits the requirements while the v1 executor is
    // mid-eval: the flow re-opens to the gate, v1's check keys are cleared
    await submitArtifact(id, "v2 requirements — a different change");
    const reopened = await view(id);
    expect(reopened.round).toBe(1);
    expect(reopened.status).toBe("blocked_on_approval");
    expect(reopened.context["reported:checks"]).toBeUndefined();

    park.release();
    const decided = await decide;
    expect(decided.statusCode).toBe(200);
    // the stale result is discarded quietly — not surfaced as an execution fault
    expect(decided.json().executionError).toBeUndefined();

    const after = await view(id);
    // nothing restored, nothing advanced
    expect(after.context["reported:checks"]).toBeUndefined();
    expect(after.context["checks:checks"]).toBeUndefined();
    expect(after.context.executing).toBeUndefined();
    expect(after.status).toBe("blocked_on_approval");
    expect(after.round).toBe(1);
    const audit = await auditFor(id);
    const discarded = audit.filter((a) => a.ruleId === "workflow:executor-result-discarded");
    expect(discarded).toHaveLength(1);
    expect(discarded[0]!.effect).toBe("deny");
    expect(discarded[0]!.detail).toMatchObject({ stageId: "checks", currentRound: 1 });
    expect(audit.filter((a) => a.ruleId === "workflow:execution_succeeded")).toHaveLength(0);

    // the v2 sign-off runs the check stage in round 1: v1's green is gone, so
    // it WAITS for reports against v2
    const v2 = await approveGate(id);
    expect(v2.statusCode).toBe(200);
    const waiting = await view(id);
    expect(waiting.status).toBe("awaiting_execution");
    expect(statusOf(waiting.context, "checks", "unit_tests")).toBe("pending");
    expect(statusOf(waiting.context, "checks", "lint")).toBe("pending");
  });

  it("(3) a report for a PREVIOUS round is refused with 409 and audited; the current round (explicit or omitted) is accepted", async () => {
    const id = await startInstance("wr-reopen");
    await submitArtifact(id, "v1 requirements");
    expect((await approveGate(id)).statusCode).toBe(200);
    expect((await view(id)).status).toBe("awaiting_execution"); // waiting on reports
    await submitArtifact(id, "v2 requirements"); // re-open → round 1
    expect((await view(id)).round).toBe(1);

    // CI finishes the run it started against v1 and reports it for round 0
    const stale = await report(id, "checks", [{ check: "unit_tests", status: "passed" }], 0);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "stale_check_report", reportedRound: 0, currentRound: 1 });
    expect(stale.json().detail).toContain("round 1");
    expect((await view(id)).context["reported:checks"]).toBeUndefined();
    const refused = (await auditFor(id)).filter((a) => a.ruleId === "workflow:checks-report-stale-round");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.effect).toBe("deny");
    expect(refused[0]!.detail).toMatchObject({ stageId: "checks", reportedRound: 0, currentRound: 1 });

    // the current round, named explicitly: accepted and stamped
    const current = await report(id, "checks", [{ check: "unit_tests", status: "passed" }], 1);
    expect(current.statusCode).toBe(200);
    expect(current.json().round).toBe(1);
    const stored = (await view(id)).context["reported:checks"] as Array<{ check: string; round?: number }>;
    expect(stored.map((r) => [r.check, r.round])).toEqual([["unit_tests", 1]]);
  });

  it("(3b) FAIL CLOSED: a CI report naming no round is refused 422 unless the org opts out; a console session may omit it", async () => {
    const id = await startInstance("wr-reopen");
    await submitArtifact(id, "v1 requirements");
    // an API-key caller with no round: refused, told the current round
    const unbound = await report(id, "checks", [{ check: "unit_tests", status: "passed" }], "none");
    expect(unbound.statusCode).toBe(422);
    expect(unbound.json()).toMatchObject({ error: "round_required", currentRound: 0 });
    expect((await view(id)).context["reported:checks"]).toBeUndefined();

    // the org opt-out (default off) restores the bind-to-current behaviour
    await setAllowUnbound(true);
    try {
      const allowed = await report(id, "checks", [{ check: "unit_tests", status: "passed" }], "none");
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toMatchObject({ round: 0, evaluation: "stored_for_later" });
    } finally {
      await setAllowUnbound(false);
    }
    const [org] = await db.select().from(orgSettings);
    expect(org!.checkReportsAllowUnbound).toBe(false);

    // a person in the console: may omit the round — it binds to the current one
    const cookie = await consoleCookie(adminId, "wr-console-admin@example.com");
    const fromConsole = await app.inject({
      method: "POST",
      url: `/v1/workflows/instances/${id}/checks`,
      headers: CSRF,
      cookies: { regulait_session: cookie },
      payload: { stageId: "checks", results: [{ check: "lint", status: "passed" }] },
    });
    expect(fromConsole.statusCode, fromConsole.body).toBe(200);
    const stored = (await view(id)).context["reported:checks"] as Array<{ check: string; round?: number }>;
    expect(stored.map((r) => [r.check, r.round]).sort()).toEqual([
      ["lint", 0],
      ["unit_tests", 0],
    ]);
  });

  it("(4) a lapsed executor's late result is discarded: the stage's KERNEL OUTCOME is applied once and the context is not rolled back (an external effect repeated by a TTL re-take is not prevented — see WORKFLOW_ENGINE_SPEC)", async () => {
    const id = await startInstance("wr-flow");
    expect((await report(id, "checks", [{ check: "unit_tests", status: "passed" }, { check: "lint", status: "passed" }])).statusCode).toBe(200);

    const park = parkFirstEval(id, "checks");
    const first = approveGate(id); // executor A claims `checks` and parks
    await park.arrived;

    // a live claim refuses a second /advance outright…
    const refused = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${id}/advance`,
      payload: { stageId: "checks" },
    });
    expect(refused.statusCode).toBe(409);

    // …but A's claim LAPSES (REL-06: a stalled executor's claim is re-takeable
    // after its TTL — backdated here instead of waiting it out)
    await db
      .update(workflowInstances)
      .set({ context: sql`jsonb_set(${workflowInstances.context}, '{executingSince}', '"2000-01-01T00:00:00.000Z"')` })
      .where(eq(workflowInstances.id, id));
    // executor B re-takes the stage, passes it, and moves on into checks2,
    // which waits on smoke
    const second = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${id}/advance`,
      payload: { stageId: "checks" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe("awaiting_execution");
    expect(statusOf(second.json().context, "checks2", "smoke")).toBe("pending");

    // A wakes up with its claim-time snapshot and a verdict for `checks`
    park.release();
    const late = await first;
    expect(late.statusCode).toBe(200);
    expect(late.json().executionError).toBeUndefined();

    const after = await view(id);
    // A neither rolled the context back over B's checks2 evaluation…
    expect(statusOf(after.context, "checks2", "smoke")).toBe("pending");
    expect(after.context["awaitingReport:checks2"]).toBeTruthy();
    expect(after.context.executing).toBeUndefined();
    // …nor applied `checks`' outcome a second time
    const audit = await auditFor(id);
    expect(
      audit.filter(
        (a) => a.ruleId === "workflow:execution_succeeded" && (a.detail as { event: { stageId: string } }).event.stageId === "checks",
      ),
    ).toHaveLength(1);
    expect(audit.filter((a) => a.ruleId === "workflow-stage-claim-expired")).toHaveLength(1);
    const discarded = audit.filter((a) => a.ruleId === "workflow:executor-result-discarded");
    expect(discarded).toHaveLength(1);
    expect(discarded[0]!.detail).toMatchObject({ stageId: "checks" });
    expect(after.state.currentStageIndex).toBe(3);
  });

  it("the executor's own pending result still records when nothing raced it (control)", async () => {
    const id = await startInstance("wr-flow");
    const decided = await approveGate(id);
    expect(decided.statusCode).toBe(200);
    const after = await view(id);
    expect(after.status).toBe("awaiting_execution");
    expect(((after.context["checks:checks"] as Evaluated[]) ?? []).map((r) => [r.check, r.status, r.detail])).toEqual([
      ["unit_tests", "pending", CHECK_PENDING_DETAIL],
      ["lint", "pending", CHECK_PENDING_DETAIL],
    ]);
    expect((await auditFor(id)).filter((a) => a.ruleId === "workflow:executor-result-discarded")).toHaveLength(0);
  });
});

describe("AER-048 review — discarded results keep their external-effect records; a holder that fails re-evaluates", () => {
  it("(5) AER-049: a DEPLOY discarded by a re-open is kept as the OLD round's history — the new round deploys afresh", async () => {
    const id = await startInstance("wr-deploy");
    await submitArtifact(id, "v1 requirements");
    const park = parkFirstCommit(id, "deploy");
    const decide = approveGate(id); // the deploy executor deploys, then parks before committing
    await park.arrived;
    await submitArtifact(id, "v2 requirements"); // re-open → round 1
    park.release();
    expect((await decide).statusCode).toBe(200);

    const after = await view(id);
    expect(after.status).toBe("blocked_on_approval");
    expect(after.round).toBe(1);
    // the deployment happened, but it belongs to round 0: its record is NOT
    // live (it would make round 1 skip its own deploy) — it is round 0's history
    expect(after.context["deploy:deploy"]).toBeUndefined();
    const r0 = historyOf(after.context).find((e) => e.round === 0 && e.keys.includes("deploy:deploy"))!;
    expect(r0).toBeTruthy();
    expect(r0.source).toBe("discarded-executor");
    expect(r0.archivedInRound).toBe(1);
    expect(r0.values["deploy:deploy"]).toMatchObject({ target: "wr-staging", environment: "staging" });
    const audit = await auditFor(id);
    const discarded = audit.filter((a) => a.ruleId === "workflow:executor-result-discarded");
    expect(discarded).toHaveLength(1);
    const detail = discarded[0]!.detail as {
      effectRecords: Record<string, { deployId?: string }>;
      salvagedEffectRecords: string[];
      archivedEffectRecords: string[];
    };
    expect(detail.salvagedEffectRecords).toEqual([]);
    expect(detail.archivedEffectRecords).toContain("deploy:deploy");
    // the audit carries the VALUES, so the deploy is traceable/reversible from the trail alone
    expect(detail.effectRecords["deploy:deploy"]!.deployId).toBe((r0.values["deploy:deploy"] as { deployId: string }).deployId);
    expect(audit.filter((a) => a.ruleId === "workflow:effects-archived")).toHaveLength(1);
    expect(audit.filter((a) => a.ruleId === "external-effect:deploy.deploy")).toHaveLength(1);

    // round 1 is signed off: the deploy stage re-enters and DEPLOYS round 1
    expect((await approveGate(id)).statusCode).toBe(200);
    const done = await view(id);
    expect(done.status).toBe("blocked_on_approval");
    expect(done.state.currentStageIndex).toBe(4);
    expect(done.context["deploy:deploy"]).toMatchObject({ target: "wr-staging" });
    expect(stampsOf(done.context)["deploy:deploy"]).toEqual({ round: 1, stageId: "deploy" });
    expect(historyOf(done.context).some((e) => e.round === 0 && e.keys.includes("deploy:deploy"))).toBe(true);
    expect((await auditFor(id)).filter((a) => a.ruleId === "external-effect:deploy.deploy")).toHaveLength(2);
  });

  it("(6) AER-049: a MERGE discarded by a re-open goes to round 0's history — round 1 opens a NEW branch and PR and merges it", async () => {
    const id = await startInstance("wr-git");
    await submitArtifact(id, "v1 requirements");
    expect((await approveGate(id)).statusCode).toBe(200); // branch + PR, then the merge gate
    let v = await view(id);
    expect(v.status).toBe("blocked_on_approval");
    const prId = v.context.prId as string;
    // review item 2: CI learns the instance and the round from the PR body
    const mock = resolveProvider({ provider: "mock", token: "x" }) as MockGitProvider;
    const body = mock.repos.get("wr/app")!.prs.get(prId)!.body;
    expect(body).toContain(`regulait-instance: ${id}`);
    expect(body).toContain("regulait-round: 0");
    expect(body).not.toContain("regulait-supersedes");
    expect(stampsOf(v.context)).toMatchObject({
      branch: { round: 0, stageId: "branch" },
      prId: { round: 0, stageId: "open_pr" },
      prUrl: { round: 0, stageId: "open_pr" },
    });

    const park = parkFirstCommit(id, "merge");
    const decide = approveGate(id, "merge_gate"); // merges, then parks before committing
    await park.arrived;
    await submitArtifact(id, "v2 requirements"); // re-open
    park.release();
    expect((await decide).statusCode).toBe(200);
    v = await view(id);
    expect(v.round).toBe(1);
    // nothing of round 0 is live: branch/PR were archived by the re-open, the
    // late merge by the discard — all of it is round 0's history
    for (const k of ["branch", "prId", "prUrl", "mergeSha"]) expect(v.context[k]).toBeUndefined();
    const r0 = historyOf(v.context).filter((e) => e.round === 0);
    expect(r0.flatMap((e) => e.keys).sort()).toEqual(["branch", "mergeSha", "prId", "prUrl"]);
    expect(r0.find((e) => e.keys.includes("mergeSha"))!.values.mergeSha).toBe(`sha-merge-${prId}`);

    // round 1 runs the whole tail again against a FRESH branch and PR
    expect((await approveGate(id)).statusCode).toBe(200);
    v = await view(id);
    expect(v.context.branch).toBe(`regulait/${id.slice(0, 8)}-r1`);
    const pr1 = v.context.prId as string;
    expect(pr1).not.toBe(prId);
    const merged = await approveGate(id, "merge_gate");
    expect(merged.statusCode).toBe(200);
    expect(merged.json().executionError).toBeUndefined();
    v = await view(id);
    expect(v.context.lastError).toBeUndefined();
    expect(v.context.mergeSha).toBe(`sha-merge-${pr1}`);
    expect(v.state.currentStageIndex).toBe(7); // the final gate
    const audit = await auditFor(id);
    expect(audit.filter((a) => a.ruleId === "external-effect:git.merge_pull_request")).toHaveLength(2);
    expect(audit.filter((a) => a.ruleId === "external-effect:git.open_pull_request")).toHaveLength(2);
    expect(audit.filter((a) => a.ruleId === "external-effect:git.create_branch")).toHaveLength(2);
  });

  it("(7) a check executor that THROWS after a report arrived during its claim re-evaluates once — the green report is not stranded", async () => {
    const id = await startInstance("wr-flow");
    expect((await report(id, "checks", [{ check: "unit_tests", status: "passed" }])).statusCode).toBe(200);
    let release!: () => void;
    let reached!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const arrived = new Promise<void>((r) => (reached = r));
    let used = false;
    workflowTestHooks.duringStageEval = async (at) => {
      if (used || at.instanceId !== id || at.stageId !== "checks") return;
      used = true;
      reached();
      await released;
      throw new Error("wr: the holder crashed mid-eval");
    };
    const decide = approveGate(id);
    await arrived;
    const lint = await report(id, "checks", [{ check: "lint", status: "passed" }]);
    expect(lint.statusCode).toBe(202);
    release();
    const decided = await decide;
    // the holder's own failure still surfaces…
    expect(decided.json().executionError).toContain("the holder crashed");
    // …but the report that arrived during its claim was evaluated: both green,
    // the stage passed into checks2
    const after = await view(id);
    expect(statusOf(after.context, "checks", "lint")).toBe("passed");
    expect(after.state.currentStageIndex).toBe(3);
    expect(after.context.executing).toBeUndefined();
  });

  it("(8) a re-open clears a build stage's runId: a run planned in the old round does not satisfy the new one", async () => {
    const id = await startInstance("wr-build");
    await submitArtifact(id, "v1 requirements");
    expect((await approveGate(id)).statusCode).toBe(200);
    const planned = await view(id);
    expect(planned.status).toBe("awaiting_execution");
    const oldRun = planned.context["runId:build"] as string;
    expect(oldRun).toBeTruthy();

    await submitArtifact(id, "v2 requirements"); // re-open
    const reopened = await view(id);
    expect(reopened.context["runId:build"]).toBeUndefined();
    const audit = await auditFor(id);
    expect(
      audit.some((a) => a.ruleId === "workflow:artifact_submitted" && (a.detail as { staleRunIdsCleared?: string[] }).staleRunIdsCleared?.includes("build")),
    ).toBe(true);

    expect((await approveGate(id)).statusCode).toBe(200);
    const fresh = await view(id);
    expect(fresh.context["runId:build"]).toBeTruthy();
    expect(fresh.context["runId:build"]).not.toBe(oldRun);
  });
});

describe("AER-049 — a re-open past merge or deploy is a new review round: effect records belong to the round that produced them", () => {
  it("(a)+(d) a re-open AFTER the merge → the review runs again → a NEW branch, a NEW PR (carrying the new round) and a new merge; history keeps round 0", async () => {
    const id = await startInstance("wr-git");
    await submitArtifact(id, "v1 requirements");
    expect((await approveGate(id)).statusCode).toBe(200);
    expect((await approveGate(id, "merge_gate")).statusCode).toBe(200);
    let v = await view(id);
    expect(v.state.currentStageIndex).toBe(7); // merged, at the final gate
    const pr0 = v.context.prId as string;
    const round0 = { branch: v.context.branch, prId: pr0, prUrl: v.context.prUrl, mergeSha: v.context.mergeSha };
    expect(round0.mergeSha).toBe(`sha-merge-${pr0}`);

    await submitArtifact(id, "v2 requirements — changed after the merge"); // re-open → round 1
    v = await view(id);
    expect(v.round).toBe(1);
    expect(v.status).toBe("blocked_on_approval"); // the review runs again
    expect(v.state.currentStageIndex).toBe(2);
    for (const k of ["branch", "prId", "prUrl", "mergeSha"]) expect(v.context[k]).toBeUndefined();
    const archivedR0 = historyOf(v.context).filter((e) => e.round === 0);
    expect(archivedR0).toHaveLength(1);
    expect(archivedR0[0]!.source).toBe("reopen");
    expect(archivedR0[0]!.archivedInRound).toBe(1);
    expect(archivedR0[0]!.values).toEqual(round0);
    const archivedAudit = (await auditFor(id)).filter((a) => a.ruleId === "workflow:effects-archived");
    expect(archivedAudit).toHaveLength(1);
    expect(archivedAudit[0]!.detail).toMatchObject({ event: "artifact_submitted", closedRound: 0, round: 1, archived: [{ round: 0, values: round0 }] });

    // round 1: the sign-off, then a FRESH branch + PR, the merge gate, a new merge
    expect((await approveGate(id)).statusCode).toBe(200);
    v = await view(id);
    expect(v.context.branch).toBe(`regulait/${id.slice(0, 8)}-r1`);
    const pr1 = v.context.prId as string;
    expect(pr1).not.toBe(pr0);
    // (d) the new PR's body carries the NEW round, and names the PR it supersedes
    const mock = resolveProvider({ provider: "mock", token: "x" }) as MockGitProvider;
    const body1 = mock.repos.get("wr/app")!.prs.get(pr1)!.body;
    expect(body1).toContain(`regulait-instance: ${id}`);
    expect(body1).toContain("regulait-round: 1");
    expect(body1).not.toContain("regulait-round: 0");
    expect(body1).toContain(`regulait-supersedes: round 0 pull request ${String(round0.prUrl)}`);
    expect(body1).toContain("v2 requirements");
    expect(mock.repos.get("wr/app")!.prs.get(pr1)!.head).toBe(`regulait/${id.slice(0, 8)}-r1`);

    const merged = await approveGate(id, "merge_gate");
    expect(merged.statusCode).toBe(200);
    expect(merged.json().executionError).toBeUndefined();
    v = await view(id);
    expect(v.context.mergeSha).toBe(`sha-merge-${pr1}`);
    expect(v.state.currentStageIndex).toBe(7);
    expect(stampsOf(v.context)).toMatchObject({
      branch: { round: 1 },
      prId: { round: 1 },
      mergeSha: { round: 1, stageId: "merge" },
    });
    // round 0's history is untouched by round 1
    expect(historyOf(v.context).filter((e) => e.round === 0)[0]!.values).toEqual(round0);
    const audit = await auditFor(id);
    expect(audit.filter((a) => a.ruleId === "external-effect:git.create_branch")).toHaveLength(2);
    expect(audit.filter((a) => a.ruleId === "external-effect:git.open_pull_request")).toHaveLength(2);
    expect(audit.filter((a) => a.ruleId === "external-effect:git.merge_pull_request")).toHaveLength(2);
  });

  it("(b) a sign-off RETURNED after the deploy → resubmission → a new review → round 1 DEPLOYS again; history keeps round 0's deploy", async () => {
    const id = await startInstance("wr-deploy");
    await submitArtifact(id, "v1 requirements");
    expect((await approveGate(id)).statusCode).toBe(200); // deploys, then the final gate
    let v = await view(id);
    expect(v.state.currentStageIndex).toBe(4);
    const dep0 = v.context["deploy:deploy"];
    expect(dep0).toMatchObject({ target: "wr-staging" });
    expect(stampsOf(v.context)["deploy:deploy"]).toEqual({ round: 0, stageId: "deploy" });

    // the final reviewer sends it back for information → round 1 (the kernel
    // event the ADR-0168 decide path applies; over HTTP "returned" is offered
    // on intake sign-offs only)
    const ret = await applyWorkflowApprovalDecision(db, { instanceId: id, stageId: "done" }, "returned", anaId);
    expect(ret).toBeNull();
    v = await view(id);
    expect(v.round).toBe(1);
    expect(v.status).toBe("blocked_on_artifact");
    expect(v.context["deploy:deploy"]).toBeUndefined();
    expect(v.context.deployUrl).toBeUndefined();
    const r0 = historyOf(v.context).find((e) => e.round === 0)!;
    expect(r0.keys.sort()).toEqual(["deploy:deploy", "deployUrl"]);
    expect(r0.values["deploy:deploy"]).toEqual(dep0);

    await submitArtifact(id, "v2 requirements"); // resubmitted in round 1 (not a further re-open)
    v = await view(id);
    expect(v.round).toBe(1);
    expect(v.status).toBe("blocked_on_approval");
    expect((await approveGate(id)).statusCode).toBe(200);
    v = await view(id);
    expect(v.state.currentStageIndex).toBe(4);
    expect(v.context["deploy:deploy"]).toMatchObject({ target: "wr-staging" });
    expect(stampsOf(v.context)["deploy:deploy"]).toEqual({ round: 1, stageId: "deploy" });
    // the round is in the deploy seed: round 1's mock deployment has an id of its own
    expect((dep0 as { deployId: string }).deployId).toBe(`dep_${id.slice(0, 8)}_staging`);
    expect((v.context["deploy:deploy"] as { deployId: string }).deployId).toBe(`dep_${id.slice(0, 8)}r1_staging`);
    const deploys = (await auditFor(id)).filter((a) => a.ruleId === "external-effect:deploy.deploy");
    expect(deploys).toHaveLength(2);
    expect(deploys.map((a) => (a.detail as { round: number }).round).sort()).toEqual([0, 1]);
  });

  it("(c) WITHIN a round a discarded deploy executor's record is kept live — the stage re-entered in the same round does not deploy again", async () => {
    const id = await startInstance("wr-deploy");
    await submitArtifact(id, "v1 requirements");
    const park = parkFirstCommit(id, "deploy");
    const decide = approveGate(id); // deploys, then parks before committing
    await park.arrived;
    // a re-taker took the lapsed claim and died before doing anything (same
    // round, same stage entry) — the parked executor no longer holds the claim
    await db
      .update(workflowInstances)
      .set({
        context: sql`${workflowInstances.context} || ${JSON.stringify({ executingClaim: "wr-lapsed-retaker", executingSince: "1970-01-01T00:00:00.000Z" })}::jsonb`,
      })
      .where(eq(workflowInstances.id, id));
    park.release();
    expect((await decide).statusCode).toBe(200);
    let v = await view(id);
    expect(v.round).toBe(0);
    expect(v.status).toBe("awaiting_execution");
    expect(v.context["deploy:deploy"]).toMatchObject({ target: "wr-staging" }); // salvaged LIVE (same round)
    expect(stampsOf(v.context)["deploy:deploy"]).toEqual({ round: 0, stageId: "deploy" });
    expect(historyOf(v.context)).toEqual([]);
    const discarded = (await auditFor(id)).filter((a) => a.ruleId === "workflow:executor-result-discarded");
    expect(discarded).toHaveLength(1);
    expect((discarded[0]!.detail as { salvagedEffectRecords: string[] }).salvagedEffectRecords).toContain("deploy:deploy");

    // the stage is retried in the same round: the record is the idempotency key
    const adv = await app.inject({
      method: "POST",
      headers: piaAuth,
      url: `/v1/workflows/instances/${id}/advance`,
      payload: { stageId: "deploy" },
    });
    expect(adv.statusCode).toBe(200);
    v = await view(id);
    expect(v.state.currentStageIndex).toBe(4);
    const audit = await auditFor(id);
    expect(audit.filter((a) => a.ruleId === "external-effect:deploy.deploy")).toHaveLength(1);
    expect(audit.filter((a) => a.ruleId === "workflow:effects-archived")).toHaveLength(0);
  });

  it("the generic re-open (recertification): a COMPLETED instance re-opened to its sign-off archives the deploy and round 1 deploys again", async () => {
    const id = await startInstance("wr-deploy");
    await submitArtifact(id, "v1 requirements");
    expect((await approveGate(id)).statusCode).toBe(200);
    expect((await approveGate(id, "done")).statusCode).toBe(200);
    let v = await view(id);
    expect(v.status).toBe("completed");
    const dep0 = v.context["deploy:deploy"];

    const reopened = await reopenWorkflowInstance(db, id, {
      stageId: "gate",
      reason: "wr: approval expired — recertification",
      actorUserId: adminId,
      dataKey: "e".repeat(64),
    });
    await reopened.postCommit(db);
    expect(reopened.round).toBe(1);
    expect(reopened.state.status).toBe("blocked_on_approval");
    v = await view(id);
    expect(v.round).toBe(1);
    expect(v.state.currentStageIndex).toBe(2);
    expect(v.context["deploy:deploy"]).toBeUndefined();
    expect(historyOf(v.context).find((e) => e.round === 0)!.values["deploy:deploy"]).toEqual(dep0);
    const audit = await auditFor(id);
    expect(audit.filter((a) => a.ruleId === "workflow:reopen")).toHaveLength(1);
    expect(audit.filter((a) => a.ruleId === "workflow:effects-archived")).toHaveLength(1);

    expect((await approveGate(id)).statusCode).toBe(200);
    v = await view(id);
    expect(v.state.currentStageIndex).toBe(4);
    expect(stampsOf(v.context)["deploy:deploy"]).toEqual({ round: 1, stageId: "deploy" });
    // the round is in the deploy seed: round 1's mock deployment has an id of its own
    expect((dep0 as { deployId: string }).deployId).toBe(`dep_${id.slice(0, 8)}_staging`);
    expect((v.context["deploy:deploy"] as { deployId: string }).deployId).toBe(`dep_${id.slice(0, 8)}r1_staging`);
    expect((await auditFor(id)).filter((a) => a.ruleId === "external-effect:deploy.deploy")).toHaveLength(2);

    // AER-049 review: a re-open always runs review again — never to a stage
    // past the first PR / merge / deploy stage, and never to a non-review stage
    await expect(reopenWorkflowInstance(db, id, { stageId: "done", reason: "x", actorUserId: adminId })).rejects.toThrow(
      /comes after 'deploy' \(deployment\)/,
    );
    await expect(reopenWorkflowInstance(db, id, { stageId: "deploy", reason: "x", actorUserId: adminId })).rejects.toThrow(
      /is a deployment stage/,
    );
  });

  it("the git chain is one unit: a re-open after create_branch archives branch, PR and merge together, and open_pr cuts the round's own branch", async () => {
    await makeTemplate("wr-upstream", "wr-upstream", [
      { id: "intake", type: "trigger" },
      { id: "branch", type: "git_operation", action: "create_branch", connection: "wr-git", repo: "wr/up", branchPrefix: "wrup" },
      { id: "req", type: "artifact_generation", output: "requirements_file" },
      { id: "gate", type: "human_approval", approvers: [anaId] },
      { id: "open_pr", type: "git_operation", action: "open_pr", connection: "wr-git", repo: "wr/up" },
      { id: "merge", type: "git_operation", action: "merge", connection: "wr-git", repo: "wr/up" },
      { id: "done", type: "human_approval", approvers: [anaId] },
    ]);
    const id = await startInstance("wr-upstream");
    let v = await view(id);
    const branch0 = v.context.branch as string;
    expect(branch0).toBe(`wrup/${id.slice(0, 8)}`);
    await submitArtifact(id, "v1 requirements");
    expect((await approveGate(id)).statusCode).toBe(200);
    v = await view(id);
    const pr0 = v.context.prId as string;
    expect(v.context.mergeSha).toBe(`sha-merge-${pr0}`);

    await submitArtifact(id, "v2 requirements"); // re-open at req (after the branch stage)
    v = await view(id);
    // the create_branch stage does not run again, but its branch belongs to
    // the chain whose PR round 0 merged: all four records go to history
    expect(v.context.branch).toBeUndefined();
    expect(v.context.prId).toBeUndefined();
    expect(historyOf(v.context)[0]!.keys.sort()).toEqual(["branch", "mergeSha", "prId", "prUrl"]);
    expect(historyOf(v.context)[0]!.values.branch).toBe(branch0);

    expect((await approveGate(id)).statusCode).toBe(200);
    v = await view(id);
    const pr1 = v.context.prId as string;
    expect(pr1).not.toBe(pr0);
    expect(v.context.branch).toBe(`${branch0}-r1`); // cut by open_pr for round 1
    expect(stampsOf(v.context).branch).toEqual({ round: 1, stageId: "open_pr" });
    expect(v.context.mergeSha).toBe(`sha-merge-${pr1}`);
    const audit = await auditFor(id);
    const branches = audit.filter((a) => a.ruleId === "external-effect:git.create_branch");
    expect(branches.map((a) => (a.detail as any).branch ?? (a.detail as any).result?.branch).sort()).toEqual([branch0, `${branch0}-r1`]);
    expect(audit.filter((a) => a.ruleId === "external-effect:git.open_pull_request")).toHaveLength(2);
    expect(audit.filter((a) => a.ruleId === "external-effect:git.merge_pull_request")).toHaveLength(2);
    expect(audit.filter((a) => a.ruleId === "workflow:merge-refused-stale-pr")).toHaveLength(0);
  });

  it("a merge never merges an earlier round's PR: a re-open to merge_gate is refused, and a returned merge_gate re-runs the whole chain", async () => {
    await makeTemplate("wr-mergegate", "wr-mergegate", [
      { id: "intake", type: "trigger" },
      { id: "req", type: "artifact_generation", output: "requirements_file" },
      { id: "gate", type: "human_approval", approvers: [anaId] },
      { id: "branch", type: "git_operation", action: "create_branch", connection: "wr-git", repo: "wr/mg", branchPrefix: "wrmg" },
      { id: "open_pr", type: "git_operation", action: "open_pr", connection: "wr-git", repo: "wr/mg" },
      { id: "merge_gate", type: "human_approval", approvers: [anaId] },
      { id: "merge", type: "git_operation", action: "merge", connection: "wr-git", repo: "wr/mg" },
    ]);
    const id = await startInstance("wr-mergegate");
    await submitArtifact(id, "v1 requirements");
    expect((await approveGate(id)).statusCode).toBe(200);
    expect((await approveGate(id, "merge_gate")).statusCode).toBe(200);
    let v = await view(id);
    expect(v.status).toBe("completed");
    const pr0 = v.context.prId as string;
    expect(v.context.mergeSha).toBe(`sha-merge-${pr0}`);

    // the generic re-open cannot land between the PR and its merge
    await expect(
      reopenWorkflowInstance(db, id, { stageId: "merge_gate", reason: "x", actorUserId: adminId }),
    ).rejects.toThrow(/comes after 'open_pr' \(git_operation\)/);
    expect((await view(id)).status).toBe("completed");

    // a re-open to the review before the chain re-runs all of it
    const reopened = await reopenWorkflowInstance(db, id, { stageId: "gate", reason: "wr: change", actorUserId: adminId });
    await reopened.postCommit(db);
    expect((await approveGate(id)).statusCode).toBe(200);
    v = await view(id);
    expect(v.context.branch).toBe(`wrmg/${id.slice(0, 8)}-r1`);
    const pr1 = v.context.prId as string;
    expect(pr1).not.toBe(pr0);
    expect((await approveGate(id, "merge_gate")).statusCode).toBe(200);
    v = await view(id);
    expect(v.status).toBe("completed");
    expect(v.context.mergeSha).toBe(`sha-merge-${pr1}`);
    expect(historyOf(v.context).find((e) => e.round === 0)!.values).toMatchObject({ prId: pr0, mergeSha: `sha-merge-${pr0}` });
  });

  it("merge refuses, by name and audited, to merge a PR its round did not open", async () => {
    // a PR opened BEFORE the artifact stage: a new requirements version re-runs
    // the merge but not open_pr, so the new round has no PR of its own — the
    // merge must not reach back for round 0's
    await makeTemplate("wr-latepr", "wr-latepr", [
      { id: "intake", type: "trigger" },
      { id: "branch", type: "git_operation", action: "create_branch", connection: "wr-git", repo: "wr/lp", branchPrefix: "wrlp" },
      { id: "open_pr", type: "git_operation", action: "open_pr", connection: "wr-git", repo: "wr/lp" },
      { id: "req", type: "artifact_generation", output: "requirements_file" },
      { id: "gate", type: "human_approval", approvers: [anaId] },
      { id: "merge", type: "git_operation", action: "merge", connection: "wr-git", repo: "wr/lp" },
    ]);
    const toRoundOne = async () => {
      const id = await startInstance("wr-latepr");
      await submitArtifact(id, "v1 requirements");
      const pr0 = (await view(id)).context.prId as string;
      expect(pr0).toBeTruthy();
      await submitArtifact(id, "v2 requirements"); // re-open at req → round 1
      const v = await view(id);
      expect(v.round).toBe(1);
      expect(v.context.prId).toBeUndefined(); // the chain went to history together
      return { id, pr0 };
    };

    // (a) the natural case: round 1 has no PR at all
    const a = await toRoundOne();
    await approveGate(a.id);
    let v = await view(a.id);
    expect(v.status).not.toBe("completed");
    expect(v.context.mergeSha).toBeUndefined();
    expect(String(v.context.lastError)).toMatch(/merge refused: round 1 has opened no pull request to merge/);

    // (b) a round-0 PR record that survived in the live context (stamped round 0)
    const b = await toRoundOne();
    const [row] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, b.id));
    const ctx = { ...(row!.context as Record<string, unknown>) };
    ctx.prId = b.pr0;
    ctx["effects:stamps"] = { ...((ctx["effects:stamps"] as object) ?? {}), prId: { round: 0, stageId: "open_pr" } };
    await db.update(workflowInstances).set({ context: ctx }).where(eq(workflowInstances.id, b.id));
    await approveGate(b.id);
    v = await view(b.id);
    expect(v.context.mergeSha).toBeUndefined();
    expect(String(v.context.lastError)).toMatch(
      new RegExp(`merge refused: pull request ${b.pr0} was opened in round 0, not this round \\(1\\)`),
    );
    for (const id of [a.id, b.id]) {
      const audit = await auditFor(id);
      const refused = audit.filter((x) => x.ruleId === "workflow:merge-refused-stale-pr");
      expect(refused).toHaveLength(1);
      expect(refused[0]!.effect).toBe("deny");
      expect(audit.filter((x) => x.ruleId === "external-effect:git.merge_pull_request")).toHaveLength(0);
    }
  });
});
