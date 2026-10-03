import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, eq, runMigrations, sql, workflowInstances, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { CHECK_PENDING_DETAIL, workflowTestHooks } from "./workflows.js";

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
  piaAuth = (await makeUser("wr-pia@example.com")).auth;
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
});

afterAll(async () => {
  delete workflowTestHooks.duringStageEval;
  await app.close();
});

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

function report(instanceId: string, stageId: string, results: Array<{ check: string; status: "passed" | "failed" }>, round?: number) {
  return app.inject({
    method: "POST",
    headers: ciAuth,
    url: `/v1/workflows/instances/${instanceId}/checks`,
    payload: { stageId, results, ...(round !== undefined ? { round } : {}) },
  });
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

    // CI posts lint while the executor is parked mid-eval: accepted
    const lint = await report(id, "checks", [{ check: "lint", status: "passed" }]);
    expect(lint.statusCode).toBe(200);

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
    // no round at all (a pre-AER-048 CI integration): taken for the current round
    const legacy = await report(id, "checks", [{ check: "lint", status: "passed" }]);
    expect(legacy.statusCode).toBe(200);
    const stored = (await view(id)).context["reported:checks"] as Array<{ check: string; round?: number }>;
    expect(stored.map((r) => [r.check, r.round]).sort()).toEqual([
      ["lint", 1],
      ["unit_tests", 1],
    ]);
  });

  it("(4) overlapping executors on one stage entry apply its outcome ONCE — a lapsed executor's late result is discarded", async () => {
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
