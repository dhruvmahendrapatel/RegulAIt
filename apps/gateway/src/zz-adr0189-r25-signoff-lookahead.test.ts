/**
 * ADR-0189 R25 item 13 — PREVENTION ("Prevention (open follow-up)"): an
 * executor stage that would complete a workflow instance, and so approve its
 * governed AI use case, is not run while that approval would be refused (no
 * usable receipt signing key under the strict `refuse` setting). Before #355's
 * re-sync backstop was needed, the external effect had already happened.
 *
 * One file, its OWN scratch database (`builderKit(…, { scratch: true })`,
 * M-040): it turns the receipt key off and on, relaxes step-up and flips
 * `ai_bom_snapshot_without_key`, none of which may reach the shared database.
 *
 * Each completion path, through the real code (the git and deploy executors run
 * on the mock providers, whose calls leave `external-effect:*` audit rows and,
 * for git, state in the shared `MockGitProvider`):
 *  - a git stage after an artifact submit; a deploy stage after an artifact submit;
 *  - a git stage run by an approval's post-commit step (decide);
 *  - a check stage evaluated by a report (`/checks`), and a report deferred to a
 *    running executor (202);
 *  - a nested orchestration run completing the build stage it was planned for;
 *  - an intake that would complete while the use case is being created (start).
 *
 * For each: with no key the effect is NOT performed, the instance is NOT
 * completed, the refusal is on the record (`context.lastError`, a
 * `workflow:executor-signoff-refused` audit row, `executorRefusal` in the
 * answer), and the use case stays where it was; a retry with a key completes the
 * instance and approves the use case, with its snapshot. Under the relaxed
 * `skip_and_record` setting nothing is refused.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  aiBomSnapshots,
  aiUseCases,
  aiVendors,
  and,
  approvals,
  auditLog,
  engineRuns,
  eq,
  orchestrationRuns,
  orgSettings,
  ORG_SETTINGS_ID,
  sql,
  workflowEvents,
  workflowInstances,
  workflowTemplates,
  type Db,
} from "@regulait/db";
import { resolveProvider, type MockGitProvider } from "@regulait/git-provider";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";
import {
  createWorkflowTemplateValidated,
  handleNestedRunCompletion,
  startWorkflowInstanceWithTemplates,
  workflowTestHooks,
} from "./workflows.js";
import { AI_BOM_SNAPSHOT_RULE_IDS } from "./ai-bom.js";
import { runEngineRunSweep } from "./engine-runs.js";
import { AI_USE_CASE_INTAKE_TEMPLATE_NAME, VENDOR_AI_ASSESSMENT_TEMPLATE_NAME } from "./template-gallery.js";

const KEY_ENV = ["REGULAIT_RECEIPT_SIGNING_KEY", "REGULAIT_RECEIPT_SIGNING_KEY_ID"] as const;
const savedEnv = Object.fromEntries(KEY_ENV.map((k) => [k, process.env[k]]));
const REFUSED_RULE = "workflow:executor-signoff-refused";
let keyDir: string;
let k: BuilderKit;
let db: Db;
let owner: Person;
let approver: Person;
/** SYNTHETIC: the one agent every use case here lists (and the nested run's owner) */
let ucAgentId: string;
let restoreStepUp: (() => Promise<void>) | undefined;
/** the mock git connection, the repo it writes, and the mock deploy target */
let gitConn: string;
let repo: string;
let deployTarget: string;

function useKey(on: boolean) {
  for (const key of KEY_ENV) delete process.env[key];
  if (on) {
    process.env.REGULAIT_RECEIPT_SIGNING_KEY = path.join(keyDir, "receipt.pem");
    process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID = `look-receipt-${k.RUN}`;
  }
}
async function withoutKey<T>(fn: () => Promise<T>): Promise<T> {
  useKey(false);
  try {
    return await fn();
  } finally {
    useKey(true);
  }
}
async function setWithoutKey(mode: "refuse" | "skip_and_record") {
  await db.update(orgSettings).set({ aiBomSnapshotWithoutKey: mode }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
}

/** a template started directly (no assignment rule is left behind), and a use case it governs */
async function startInstance(label: string, stages: unknown[]) {
  const tpl = await createWorkflowTemplateValidated(db, { name: `look-${label}-${k.RUN}`, definition: { workflow: `look-${label}-${k.RUN}`, stages } });
  if (!tpl.ok) throw new Error(`template refused: ${JSON.stringify(tpl.body)}`);
  const started = await startWorkflowInstanceWithTemplates(db, undefined, {
    templateIds: [tpl.row.id],
    initiatorUserId: owner.id,
    change: { description: `look ${label}`, paths: [], environment: `look-env-${k.RUN}` },
  });
  if (!started.ok) throw new Error(`instance refused: ${JSON.stringify(started.body)}`);
  const [uc] = await db.insert(aiUseCases).values({
    name: `look-uc-${label}-${k.RUN}`, description: "look synthetic", ownerUserId: owner.id, businessContext: "look synthetic",
    intendedAgentIds: [ucAgentId], dataSensitivity: "internal", status: "proposed", workflowInstanceId: started.instance.id,
  }).returning({ id: aiUseCases.id });
  return { instanceId: started.instance.id, useCaseId: uc!.id };
}

const BRANCH_STAGE = () => ({ id: "branch", type: "git_operation", action: "create_branch", connection: gitConn, repo });
const branchOf = (instanceId: string) => `regulait/${instanceId.slice(0, 8)}`;
/** THE GIT TEST DOUBLE: the one in-process mock the executor writes through */
function branchExists(instanceId: string): boolean {
  const mock = resolveProvider({ provider: "mock", token: "x" }) as MockGitProvider;
  return mock.repos.get(repo)?.branches.has(branchOf(instanceId)) ?? false;
}
/** every external write the executors made for this instance (git, deploy) — one row per provider call */
async function externalEffects(instanceId: string) {
  const rows = await db
    .select({ ruleId: auditLog.ruleId, detail: auditLog.detail })
    .from(auditLog)
    .where(sql`${auditLog.objectType} = 'workflow' and ${auditLog.objectId} = ${instanceId} and ${auditLog.ruleId} like 'external-effect:%'`);
  return rows.map((r) => r.ruleId);
}
async function refusals(instanceId: string) {
  return db.select().from(auditLog).where(sql`${auditLog.ruleId} = ${REFUSED_RULE} and ${auditLog.objectId} = ${instanceId}`);
}
async function instanceRow(instanceId: string) {
  const [i] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, instanceId));
  return i!;
}
async function useCaseStatus(useCaseId: string) {
  const [u] = await db.select({ status: aiUseCases.status }).from(aiUseCases).where(eq(aiUseCases.id, useCaseId));
  return u!.status;
}
async function approvalSnapshots(useCaseId: string) {
  const rows = await db.select().from(aiBomSnapshots).where(sql`${aiBomSnapshots.subjectKind} = 'use_case' and ${aiBomSnapshots.subjectId} = ${useCaseId}`);
  return rows.filter((s) => s.trigger === "use_case_approval");
}
async function succeededEvents(instanceId: string) {
  const rows = await db.select({ event: workflowEvents.event }).from(workflowEvents).where(eq(workflowEvents.instanceId, instanceId));
  return rows.filter((r) => (r.event as { kind: string }).kind === "execution_succeeded").length;
}
/** the refusal, as the instance, the trail and the answer record it; nothing completed */
async function expectRefusedAt(instanceId: string, useCaseId: string, stageId: string, useCaseWas: string, path = "executor") {
  const row = await instanceRow(instanceId);
  expect(row.status, "the instance stays at the stage, retryable").toBe("awaiting_execution");
  const ctx = row.context as Record<string, unknown>;
  expect(ctx.lastError, "the stage result the workflow page shows").toEqual(expect.stringContaining(`${stageId}: `));
  expect(ctx.lastError).toEqual(expect.stringContaining("would complete this workflow instance"));
  expect(ctx.executing, "no claim was taken").toBeUndefined();
  const rows = await refusals(instanceId);
  expect(rows.length).toBeGreaterThanOrEqual(1);
  expect(rows.at(-1)!.effect).toBe("deny");
  expect(rows.at(-1)!.detail).toMatchObject({ stageId, code: "bom_signing_unavailable", path });
  expect(await useCaseStatus(useCaseId)).toBe(useCaseWas);
  expect(await approvalSnapshots(useCaseId)).toEqual([]);
}
/** the retry with a key completed it and approved the use case, with its snapshot */
async function expectCompletedAndApproved(instanceId: string, useCaseId: string) {
  expect((await instanceRow(instanceId)).status).toBe("completed");
  expect(await useCaseStatus(useCaseId)).toBe("approved");
  expect(await approvalSnapshots(useCaseId)).toHaveLength(1);
}
const advance = (instanceId: string, stageId: string) => k.req("POST", `/v1/workflows/instances/${instanceId}/advance`, owner.auth, { stageId });
const submit = (instanceId: string, stageId = "questionnaire") =>
  k.req("POST", `/v1/workflows/instances/${instanceId}/artifacts`, owner.auth, { stageId, content: "look answers" });
/** the owner reports one named check passed (a self-report: it carries a reason) */
async function reportPass(instanceId: string, check: string, stageId = "ci-gate") {
  const round = (await instanceRow(instanceId)).round;
  return k.req("POST", `/v1/workflows/instances/${instanceId}/checks`, owner.auth, {
    round,
    stageId,
    results: [{ check, status: "passed" }],
    reason: "look: the CI run passed",
  });
}
/** park the FIRST locked completion of (instance, stage) until `release()` */
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

beforeAll(async () => {
  keyDir = mkdtempSync(path.join(tmpdir(), "look-"));
  writeFileSync(path.join(keyDir, "receipt.pem"), generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  k = await builderKit("look", { scratch: true });
  db = k.db;
  useKey(true);
  restoreStepUp = await relaxStepUpForTest(db);
  owner = await k.person("owner");
  approver = await k.person("approver");
  ucAgentId = await k.model("uc-agent");
  gitConn = `look-git-${k.RUN}`;
  repo = `look/app-${k.RUN}`;
  deployTarget = `look-staging-${k.RUN}`;
  const conn = await k.req("POST", "/v1/git/connections", k.BOOT, { name: gitConn, provider: "mock", token: "not-a-real-token" });
  expect(conn.statusCode, conn.body).toBe(201);
  const target = await k.req("POST", "/v1/deploy/targets", k.BOOT, { name: deployTarget, provider: "mock", environment: "staging" });
  expect(target.statusCode, target.body).toBe(201);
}, 300_000);

afterEach(() => {
  delete workflowTestHooks.beforeStageCommit;
  useKey(true);
});

afterAll(async () => {
  delete workflowTestHooks.beforeStageCommit;
  for (const key of KEY_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await restoreStepUp?.();
  await k?.close();
  rmSync(keyDir, { recursive: true, force: true });
}, 120_000);

describe("an executor stage after a committed route: the effect waits for a usable key", () => {
  it("git: the submit commits, but no branch is created and nothing completes; /advance with a key creates it and approves", async () => {
    const f = await startInstance("git", [
      { id: "intake", type: "trigger" },
      { id: "questionnaire", type: "artifact_generation", output: "look_git" },
      BRANCH_STAGE(),
    ]);
    const res = await withoutKey(() => submit(f.instanceId));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().status).toBe("awaiting_execution");
    expect(res.json().executorRefusal).toMatchObject({ stageId: "branch", code: "bom_signing_unavailable" });
    expect(res.json().useCaseSignoffWarning).toBeUndefined();
    // THE TEST DOUBLE WAS NOT CALLED: no branch in the mock, no external write on the trail
    expect(branchExists(f.instanceId)).toBe(false);
    expect(await externalEffects(f.instanceId)).toEqual([]);
    await expectRefusedAt(f.instanceId, f.useCaseId, "branch", "proposed");

    // PR #357 review 4: /advance whose only action is the refused stage answers
    // the refusal, as the route-level refusals do — and still runs nothing
    const again = await withoutKey(() => advance(f.instanceId, "branch"));
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json()).toMatchObject({ error: "bom_signing_unavailable", status: "awaiting_execution" });
    expect(again.json().executorRefusal).toMatchObject({ stageId: "branch", code: "bom_signing_unavailable" });
    expect(branchExists(f.instanceId)).toBe(false);
    expect(await refusals(f.instanceId)).toHaveLength(2);

    const retried = await advance(f.instanceId, "branch");
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json().status).toBe("completed");
    expect(retried.json().executorRefusal).toBeUndefined();
    expect(retried.json().useCaseSignoffWarning).toBeUndefined();
    expect(branchExists(f.instanceId)).toBe(true);
    expect(await externalEffects(f.instanceId)).toEqual(["external-effect:git.create_branch"]);
    await expectCompletedAndApproved(f.instanceId, f.useCaseId);
  }, 180_000);

  it("an Idempotency-Key replay of a held submit re-drives nothing (ADR-0179) and carries the standing refusal", async () => {
    const f = await startInstance("idem", [
      { id: "intake", type: "trigger" },
      { id: "questionnaire", type: "artifact_generation", output: "look_idem" },
      BRANCH_STAGE(),
    ]);
    const headers = { ...owner.auth, "idempotency-key": `look-idem-${k.RUN}` };
    const payload = { stageId: "questionnaire", content: "look answers" };
    const first = await withoutKey(() => k.req("POST", `/v1/workflows/instances/${f.instanceId}/artifacts`, headers, payload));
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().executorRefusal).toMatchObject({ stageId: "branch", code: "bom_signing_unavailable" });
    // the replay, even WITH a key now: a pure read — the stage is not run, nothing new is audited
    const replay = await k.req("POST", `/v1/workflows/instances/${f.instanceId}/artifacts`, headers, payload);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers["idempotent-replay"]).toBe("true");
    expect(replay.json()).toMatchObject({ version: 1, status: "awaiting_execution" });
    expect(replay.json().executorRefusal).toMatchObject({ stageId: "branch", code: "bom_signing_unavailable" });
    expect(replay.json().executorRefusal.detail).toEqual(expect.stringContaining("would complete this workflow instance"));
    expect(branchExists(f.instanceId)).toBe(false);
    expect(await refusals(f.instanceId)).toHaveLength(1);
    // the recovery is /advance; once the stage ran, a replay carries no refusal
    expect((await advance(f.instanceId, "branch")).statusCode).toBe(200);
    const after = await k.req("POST", `/v1/workflows/instances/${f.instanceId}/artifacts`, headers, payload);
    expect(after.json()).toMatchObject({ status: "completed" });
    expect(after.json().executorRefusal).toBeUndefined();
    await expectCompletedAndApproved(f.instanceId, f.useCaseId);
  }, 180_000);

  it("deploy: the submit commits, but nothing is deployed and nothing completes; /advance with a key deploys and approves", async () => {
    const f = await startInstance("deploy", [
      { id: "intake", type: "trigger" },
      { id: "questionnaire", type: "artifact_generation", output: "look_deploy" },
      { id: "deploy", type: "deployment", connection: deployTarget, environment: "staging" },
    ]);
    const res = await withoutKey(() => submit(f.instanceId));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().executorRefusal).toMatchObject({ stageId: "deploy", code: "bom_signing_unavailable" });
    // THE DEPLOY DOUBLE WAS NOT CALLED: no external write, no deployment on record
    expect(await externalEffects(f.instanceId)).toEqual([]);
    expect((await instanceRow(f.instanceId)).context).not.toHaveProperty("deploy:deploy");
    await expectRefusedAt(f.instanceId, f.useCaseId, "deploy", "proposed");

    const retried = await advance(f.instanceId, "deploy");
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json().status).toBe("completed");
    expect(await externalEffects(f.instanceId)).toEqual(["external-effect:deploy.deploy"]);
    expect((await instanceRow(f.instanceId)).context).toHaveProperty("deploy:deploy");
    await expectCompletedAndApproved(f.instanceId, f.useCaseId);
  }, 180_000);

  it("relaxed (skip_and_record): nothing is refused — the branch is created, the instance completes and the skipped snapshot is recorded", async () => {
    const f = await startInstance("relaxed", [
      { id: "intake", type: "trigger" },
      { id: "questionnaire", type: "artifact_generation", output: "look_relaxed" },
      BRANCH_STAGE(),
    ]);
    await setWithoutKey("skip_and_record");
    let res;
    try {
      res = await withoutKey(() => submit(f.instanceId));
    } finally {
      await setWithoutKey("refuse");
    }
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().status).toBe("completed");
    expect(res.json().executorRefusal).toBeUndefined();
    expect(branchExists(f.instanceId)).toBe(true);
    expect(await refusals(f.instanceId)).toEqual([]);
    expect(await useCaseStatus(f.useCaseId)).toBe("approved");
    const skipped = await db.select().from(auditLog).where(sql`${auditLog.ruleId} = ${AI_BOM_SNAPSHOT_RULE_IDS.skippedNoKey} and ${auditLog.detail}->>'subjectId' = ${f.useCaseId}`);
    expect(skipped).toHaveLength(1);
    expect(await approvalSnapshots(f.useCaseId)).toEqual([]);
  }, 180_000);
});

describe("an approval's post-commit step (decide) running a completing git stage", () => {
  const SIGNED_OFF = (label: string) => [
    { id: "intake", type: "trigger" },
    { id: "questionnaire", type: "artifact_generation", output: `look_${label}` },
    { id: "signoff", type: "human_approval", approvers: [approver.id] },
    BRANCH_STAGE(),
  ];
  async function decide(instanceId: string) {
    const [pending] = await db
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.instanceId, instanceId), eq(approvals.status, "pending")));
    return k.req("POST", `/v1/approvals/${pending!.id}/decide`, approver.auth, { decision: "approved", reason: "look sign-off" });
  }

  it("no key: the decision stands, but the branch is not created and the instance does not complete; /advance with a key does both", async () => {
    const f = await startInstance("decide-nokey", SIGNED_OFF("decide_nokey"));
    expect((await submit(f.instanceId)).statusCode).toBe(201);
    expect(await useCaseStatus(f.useCaseId)).toBe("under_review");
    const decided = await withoutKey(() => decide(f.instanceId));
    expect(decided.statusCode, decided.body).toBe(200);
    // PR #357 review 6: the decide answer says the executor held the stage
    expect(decided.json().executionWarning?.executorRefusal).toMatchObject({ stageId: "branch", code: "bom_signing_unavailable" });
    expect(branchExists(f.instanceId)).toBe(false);
    expect(await externalEffects(f.instanceId)).toEqual([]);
    await expectRefusedAt(f.instanceId, f.useCaseId, "branch", "under_review");

    const retried = await advance(f.instanceId, "branch");
    expect(retried.statusCode, retried.body).toBe(200);
    expect(branchExists(f.instanceId)).toBe(true);
    await expectCompletedAndApproved(f.instanceId, f.useCaseId);
  }, 180_000);

  it("with a key: the post-commit completion is mirrored at once (it was left for the re-sync before)", async () => {
    const f = await startInstance("decide-key", SIGNED_OFF("decide_key"));
    expect((await submit(f.instanceId)).statusCode).toBe(201);
    const decided = await decide(f.instanceId);
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json().executionWarning).toBeUndefined();
    expect(branchExists(f.instanceId)).toBe(true);
    expect(await refusals(f.instanceId)).toEqual([]);
    await expectCompletedAndApproved(f.instanceId, f.useCaseId);
  }, 180_000);
});

describe("a check stage evaluated by a report (/checks)", () => {
  const CHECK_STAGES = (label: string, checks: string[]) => [
    { id: "intake", type: "trigger" },
    { id: "questionnaire", type: "artifact_generation", output: `look_${label}` },
    { id: "ci-gate", type: "automated_check", checks },
  ];

  it("no key: the report is stored but not evaluated (refused_signoff_unavailable); /advance with a key evaluates it and approves", async () => {
    const f = await startInstance("checks-nokey", CHECK_STAGES("checks_nokey", ["ci"]));
    expect((await submit(f.instanceId)).json().status).toBe("awaiting_execution");
    const res = await withoutKey(() => reportPass(f.instanceId, "ci"));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "awaiting_execution", evaluation: "refused_signoff_unavailable" });
    expect(res.json().executorRefusal).toMatchObject({ stageId: "ci-gate", code: "bom_signing_unavailable" });
    // the stored verdict is still the one from before the report: nothing passed
    const ctx = (await instanceRow(f.instanceId)).context as Record<string, unknown>;
    expect((ctx["checks:ci-gate"] as Array<{ status: string }>).map((r) => r.status)).toEqual(["pending"]);
    expect(await succeededEvents(f.instanceId)).toBe(0);
    await expectRefusedAt(f.instanceId, f.useCaseId, "ci-gate", "proposed");

    const retried = await advance(f.instanceId, "ci-gate");
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json().status).toBe("completed");
    await expectCompletedAndApproved(f.instanceId, f.useCaseId);
  }, 180_000);

  it("a report deferred to a running executor (202): that executor's completion is mirrored by the request that ran it", async () => {
    const f = await startInstance("checks-202", CHECK_STAGES("checks_202", ["ci", "lint"]));
    expect((await submit(f.instanceId)).json().status).toBe("awaiting_execution");
    const park = parkFirstCommit(f.instanceId, "ci-gate");
    const first = reportPass(f.instanceId, "ci"); // its executor checks the key, evaluates, then parks
    await park.arrived;
    const second = await reportPass(f.instanceId, "lint");
    expect(second.statusCode, second.body).toBe(202);
    expect(second.json().evaluation).toBe("deferred_to_running_executor");
    park.release();
    const done = await first;
    expect(done.statusCode, done.body).toBe(200);
    // the parked executor's verdict reads the reports stored at its commit: both passed
    expect(done.json().status).toBe("completed");
    expect(await refusals(f.instanceId)).toEqual([]);
    await expectCompletedAndApproved(f.instanceId, f.useCaseId);
  }, 180_000);

  it("no key, a check still pending: the stage only waits — no refusal, nothing shown as a key problem", async () => {
    const f = await startInstance("checks-pending", CHECK_STAGES("checks_pending", ["ci", "lint"]));
    expect((await submit(f.instanceId)).json().status).toBe("awaiting_execution");
    const res = await withoutKey(() => reportPass(f.instanceId, "ci"));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "awaiting_execution", evaluation: "evaluated" });
    expect(res.json().executorRefusal).toBeUndefined();
    expect(await refusals(f.instanceId)).toEqual([]);
    const ctx = (await instanceRow(f.instanceId)).context as Record<string, unknown>;
    expect((ctx["checks:ci-gate"] as Array<{ check: string; status: string }>).map((r) => r.status)).toEqual(["passed", "pending"]);
  }, 180_000);

  it("no key, a CI failure: recorded as the failure it is (blocked_on_check), never as a key problem", async () => {
    const f = await startInstance("checks-fail", CHECK_STAGES("checks_fail", ["ci"]));
    expect((await submit(f.instanceId)).json().status).toBe("awaiting_execution");
    const round = (await instanceRow(f.instanceId)).round;
    const res = await withoutKey(() =>
      k.req("POST", `/v1/workflows/instances/${f.instanceId}/checks`, owner.auth, {
        round,
        stageId: "ci-gate",
        results: [{ check: "ci", status: "failed" }],
        reason: "look: the CI run failed",
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "blocked_on_check", evaluation: "evaluated" });
    expect(res.json().executorRefusal).toBeUndefined();
    expect(await refusals(f.instanceId)).toEqual([]);
    expect(await useCaseStatus(f.useCaseId)).toBe("proposed");
  }, 180_000);

  it("no key, the completing report lands while an executor that saw a pending check runs: refused at its commit, nothing completes; a key completes it", async () => {
    const f = await startInstance("checks-commit", CHECK_STAGES("checks_commit", ["ci", "lint"]));
    expect((await submit(f.instanceId)).json().status).toBe("awaiting_execution");
    useKey(false);
    let first;
    try {
      const park = parkFirstCommit(f.instanceId, "ci-gate");
      const pending = reportPass(f.instanceId, "ci"); // lint pending at its claim: the guard waits for the commit
      await park.arrived;
      const second = await reportPass(f.instanceId, "lint");
      expect(second.statusCode, second.body).toBe(202);
      park.release();
      first = await pending;
    } finally {
      useKey(true);
    }
    expect(first.statusCode, first.body).toBe(200);
    // the verdict read the reports stored at the commit (both passed), and the commit held it —
    // and the refusal REACHES the route answer (PR #357 recheck H1: it used to be dropped,
    // so this route answered `evaluated`)
    expect(first.json()).toMatchObject({ status: "awaiting_execution", evaluation: "refused_signoff_unavailable" });
    expect(first.json().executorRefusal).toMatchObject({ stageId: "ci-gate", code: "bom_signing_unavailable" });
    expect(await refusals(f.instanceId)).toHaveLength(1);
    expect(await succeededEvents(f.instanceId)).toBe(0);
    await expectRefusedAt(f.instanceId, f.useCaseId, "ci-gate", "proposed");

    const retried = await advance(f.instanceId, "ci-gate");
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json().status).toBe("completed");
    await expectCompletedAndApproved(f.instanceId, f.useCaseId);
  }, 180_000);

  it("/advance refused at the commit (PR #357 recheck H1): 409 with executorRefusal, nothing completes", async () => {
    const f = await startInstance("checks-commit-adv", CHECK_STAGES("checks_commit_adv", ["ci", "lint"]));
    expect((await submit(f.instanceId)).json().status).toBe("awaiting_execution");
    // ci passed, lint still pending: the next claim defers its guard to the commit
    expect((await reportPass(f.instanceId, "ci")).json().status).toBe("awaiting_execution");
    useKey(false);
    let adv;
    try {
      const park = parkFirstCommit(f.instanceId, "ci-gate");
      const pending = advance(f.instanceId, "ci-gate");
      await park.arrived;
      // the completing report lands while that executor holds the stage
      expect((await reportPass(f.instanceId, "lint")).statusCode).toBe(202);
      park.release();
      adv = await pending;
    } finally {
      useKey(true);
    }
    expect(adv.statusCode, adv.body).toBe(409);
    expect(adv.json()).toMatchObject({ error: "bom_signing_unavailable", status: "awaiting_execution" });
    expect(adv.json().executorRefusal).toMatchObject({ stageId: "ci-gate", code: "bom_signing_unavailable" });
    expect(await refusals(f.instanceId)).toHaveLength(1);
    expect(await succeededEvents(f.instanceId)).toBe(0);
    await expectRefusedAt(f.instanceId, f.useCaseId, "ci-gate", "proposed");
  }, 180_000);
});

describe("a nested orchestration run completing its build stage", () => {
  const BUILD_STAGES = (label: string) => [
    { id: "intake", type: "trigger" },
    { id: "questionnaire", type: "artifact_generation", output: `look_${label}` },
    {
      id: "build",
      type: "automated_build",
      run: {
        run: `look-build-${label}`,
        escalationApproverUserId: approver.id,
        nodes: [{ id: "implement", title: "Implement it", ownerAgentId: ucAgentId, mode: "execute", estimate: { in: 1, out: 1 } }],
      },
    },
  ];
  /** FIXTURE: the run the build stage waits on (planning one needs the full
   * orchestration envelope, which this file is not about); the stage finds it
   * on entry and waits for it, exactly as for a run it planned itself */
  async function waitingOnRun(label: string) {
    const f = await startInstance(label, BUILD_STAGES(label));
    const [run] = await db.insert(orchestrationRuns).values({
      name: `look-build-${label}-${k.RUN}`, initiatingUserId: owner.id, workflowInstanceId: f.instanceId, graph: {}, state: {}, status: "running",
    }).returning({ id: orchestrationRuns.id });
    await db.update(workflowInstances).set({ context: { "runId:build": run!.id } }).where(eq(workflowInstances.id, f.instanceId));
    const submitted = await submit(f.instanceId);
    expect(submitted.statusCode, submitted.body).toBe(201);
    expect(submitted.json().status).toBe("awaiting_execution");
    // FIXTURE: the run finished (its own engine marks it so before the funnel fires)
    await db.update(orchestrationRuns).set({ status: "completed" }).where(eq(orchestrationRuns.id, run!.id));
    return { ...f, runId: run!.id };
  }
  const completeRun = (f: { instanceId: string; runId: string }) =>
    handleNestedRunCompletion(db, undefined, { id: f.runId, workflowInstanceId: f.instanceId, status: "completed" }, owner.id);

  it("no key at the stage: no run is planned at all (the nested run is the effect)", async () => {
    const f = await startInstance("build-plan", BUILD_STAGES("build_plan"));
    const res = await withoutKey(() => submit(f.instanceId));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().executorRefusal).toMatchObject({ stageId: "build", code: "bom_signing_unavailable" });
    const runs = await db.select({ id: orchestrationRuns.id }).from(orchestrationRuns).where(eq(orchestrationRuns.workflowInstanceId, f.instanceId));
    expect(runs).toEqual([]);
    expect((await instanceRow(f.instanceId)).context).not.toHaveProperty("runId:build");
    await expectRefusedAt(f.instanceId, f.useCaseId, "build", "proposed");
  }, 180_000);

  it("no key when the run completes: the completion is not applied; /advance with a key applies it and approves", async () => {
    const f = await waitingOnRun("build-nokey");
    await withoutKey(() => completeRun(f));
    expect(await succeededEvents(f.instanceId)).toBe(0);
    await expectRefusedAt(f.instanceId, f.useCaseId, "build", "proposed", "nested_run_completion");
    // the stage still waits on this (completed) run
    expect((await instanceRow(f.instanceId)).context).toMatchObject({ "runId:build": f.runId });

    const retried = await advance(f.instanceId, "build");
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json().status).toBe("completed");
    await expectCompletedAndApproved(f.instanceId, f.useCaseId);
  }, 180_000);

  it("with a key: the run's completion completes the instance and is mirrored at once (no route mirrors it)", async () => {
    const f = await waitingOnRun("build-key");
    await completeRun(f);
    expect(await refusals(f.instanceId)).toEqual([]);
    await expectCompletedAndApproved(f.instanceId, f.useCaseId);
  }, 180_000);
});

describe("an intake that would complete while its use case is being created (instance start)", () => {
  /** an intake-named template, newest so it is the active one, retired after each use */
  async function withGitIntake<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const tpl = await createWorkflowTemplateValidated(db, {
      name: `${AI_USE_CASE_INTAKE_TEMPLATE_NAME}/look-${label}-${k.RUN}`,
      definition: { workflow: `look-intake-${label}-${k.RUN}`, stages: [{ id: "intake", type: "trigger" }, BRANCH_STAGE()] },
    });
    if (!tpl.ok) throw new Error(`template refused: ${JSON.stringify(tpl.body)}`);
    try {
      return await fn();
    } finally {
      await db.update(workflowTemplates).set({ retiredAt: new Date() }).where(eq(workflowTemplates.id, tpl.row.id));
    }
  }
  const propose = (label: string, headers: Record<string, string> = {}) =>
    k.req("POST", "/v1/use-cases", { ...owner.auth, ...headers }, {
      name: `look-proposal-${label}-${k.RUN}`,
      description: "look synthetic proposal",
      businessContext: "look synthetic",
      dataSensitivity: "internal",
      intendedAgentIds: [ucAgentId],
    });

  it("no key: the use case is created, but no branch is created and the intake does not complete; /advance with a key does both", async () => {
    const idem = { "idempotency-key": `look-start-nokey-${k.RUN}` };
    const created = await withGitIntake("start-nokey", () => withoutKey(() => propose("start-nokey", idem)));
    expect(created.statusCode, created.body).toBe(201);
    const useCaseId = created.json().id as string;
    const instanceId = created.json().workflowInstanceId as string;
    expect(created.json().status).toBe("proposed");
    // PR #357 review 5: the creation answer says the intake stage was held
    expect(created.json().executorRefusal).toMatchObject({ stageId: "branch", code: "bom_signing_unavailable" });
    expect(branchExists(instanceId)).toBe(false);
    expect(await externalEffects(instanceId)).toEqual([]);
    await expectRefusedAt(instanceId, useCaseId, "branch", "proposed");

    // #357 recheck L-b: the Idempotency-Key replay (even with a key now) re-drives
    // nothing and carries the refusal the intake still stands on
    const replay = await propose("start-nokey", idem);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers["idempotent-replay"]).toBe("true");
    expect(replay.json().id).toBe(useCaseId);
    expect(replay.json().executorRefusal).toMatchObject({ stageId: "branch", code: "bom_signing_unavailable" });
    expect(branchExists(instanceId)).toBe(false);
    expect(await refusals(instanceId)).toHaveLength(1);

    const retried = await advance(instanceId, "branch");
    expect(retried.statusCode, retried.body).toBe(200);
    expect(branchExists(instanceId)).toBe(true);
    await expectCompletedAndApproved(instanceId, useCaseId);
    // once the stage ran, a replay carries no refusal
    expect((await propose("start-nokey", idem)).json().executorRefusal).toBeUndefined();
  }, 180_000);

  it("with a key: an intake that completes at start approves the use case in the creating transaction, with its snapshot", async () => {
    const created = await withGitIntake("start-key", () => propose("start-key"));
    expect(created.statusCode, created.body).toBe(201);
    const useCaseId = created.json().id as string;
    const instanceId = created.json().workflowInstanceId as string;
    expect(created.json().status).toBe("approved");
    expect(created.json().executorRefusal).toBeUndefined();
    expect(branchExists(instanceId)).toBe(true);
    expect(await refusals(instanceId)).toEqual([]);
    await expectCompletedAndApproved(instanceId, useCaseId);
  }, 180_000);
});

describe("an engine run's hand-off to a stage held for a refused sign-off (PR #357 review 3)", () => {
  /** FIXTURE: the refusal marker as if it were written `minutes` ago (the sweep's back-off reads it on the database clock) */
  async function ageRefusal(instanceId: string, minutes: number) {
    await db.execute(sql`
      update workflow_instances
         set context = jsonb_set(context, '{signoffRefused,atEpoch}', to_jsonb(extract(epoch from now()) - ${minutes * 60}))
       where id = ${instanceId}::uuid`);
  }
  /** FIXTURE: an engine run bound to a stage of the instance, ended, its hand-off not yet landed */
  async function endedRun(instanceId: string, stageId: string, round: number) {
    const [run] = await db.insert(engineRuns).values({
      engineId: "modelscan", engineVersion: "0.8.8", status: "completed", trigger: "workflow", targetKind: "artifact",
      config: { sets: ["scan"], params: {} } as never, configHash: `look-${stageId}-${k.RUN}`, budgetUsd: 1, timeoutSeconds: 600,
      queueExpiresAt: new Date(Date.now() + 3_600_000), finishedAt: new Date(),
      workflowInstanceId: instanceId, workflowStageId: stageId, workflowCheckName: "ci", workflowRound: round,
    } as never).returning({ id: engineRuns.id });
    return run!.id;
  }
  async function notifiedAt(runId: string) {
    const [r] = await db.select({ at: engineRuns.workflowNotifiedAt }).from(engineRuns).where(eq(engineRuns.id, runId));
    return r!.at;
  }

  it("stays unnotified while refused, is left alone inside the back-off, and lands once a key is usable", async () => {
    const f = await startInstance("engine", [
      { id: "intake", type: "trigger" },
      { id: "questionnaire", type: "artifact_generation", output: "look_engine" },
      { id: "ci-gate", type: "automated_check", checks: ["ci"] },
    ]);
    expect((await submit(f.instanceId)).json().status).toBe("awaiting_execution");
    // the CI result is in, but the completing evaluation is held: no key
    expect((await withoutKey(() => reportPass(f.instanceId, "ci"))).json().evaluation).toBe("refused_signoff_unavailable");
    expect(await refusals(f.instanceId)).toHaveLength(1);
    const round = (await instanceRow(f.instanceId)).round;
    const runId = await endedRun(f.instanceId, "ci-gate", round);
    // #357 recheck L-a: a run of ANOTHER stage of the same instance is not held back
    // by the marker (that stage is not current, so its hand-off simply lands)
    const otherRun = await endedRun(f.instanceId, "questionnaire", round);

    // inside the back-off (the refusal is fresh): the sweep leaves the held stage's run
    // alone — no attempt, no new refusal row — and still lands the other stage's run
    await withoutKey(() => runEngineRunSweep(db));
    expect(await refusals(f.instanceId)).toHaveLength(1);
    expect(await notifiedAt(runId)).toBeNull();
    expect(await notifiedAt(otherRun)).not.toBeNull();

    // #357 recheck L-c: a malformed marker cannot fail the sweep — it is read as no
    // back-off (tried, refused again, which writes a well-formed marker back)
    await db.execute(sql`
      update workflow_instances
         set context = jsonb_set(jsonb_set(context, '{signoffRefused,atEpoch}', '"not-a-time"'), '{signoffRefused,at}', '"not-a-time"')
       where id = ${f.instanceId}::uuid`);
    await withoutKey(() => runEngineRunSweep(db));
    expect(await refusals(f.instanceId)).toHaveLength(2);
    expect(await notifiedAt(runId)).toBeNull();

    // past the back-off, still no key: tried once, refused again, still unnotified (retried later)
    await ageRefusal(f.instanceId, 11);
    await withoutKey(() => runEngineRunSweep(db));
    expect(await refusals(f.instanceId)).toHaveLength(3);
    expect(await notifiedAt(runId)).toBeNull();
    expect((await instanceRow(f.instanceId)).status).toBe("awaiting_execution");
    // ...and the fresh refusal starts a new back-off: the next tick does not try again
    await withoutKey(() => runEngineRunSweep(db));
    expect(await refusals(f.instanceId)).toHaveLength(3);

    // past the back-off with a key: the hand-off lands, completes the instance and approves the use case
    await ageRefusal(f.instanceId, 11);
    await runEngineRunSweep(db);
    expect(await notifiedAt(runId)).not.toBeNull();
    await expectCompletedAndApproved(f.instanceId, f.useCaseId);
  }, 180_000);
});

describe("a vendor assessment that completes while the vendor is being proposed (PR #357 review 8)", () => {
  it("the vendor is mirrored at once — approved, with no key needed (a vendor owes no snapshot)", async () => {
    // FIXTURE: the assessment template, a git stage that completes at start. The
    // name is unique; nothing in this scratch database proposed a vendor before.
    const tpl = await createWorkflowTemplateValidated(db, {
      name: VENDOR_AI_ASSESSMENT_TEMPLATE_NAME,
      definition: { workflow: `look-vendor-${k.RUN}`, stages: [{ id: "intake", type: "trigger" }, BRANCH_STAGE()] },
    });
    if (!tpl.ok) throw new Error(`template refused: ${JSON.stringify(tpl.body)}`);
    try {
      const res = await withoutKey(() =>
        k.req("POST", "/v1/vendors", owner.auth, { name: `look-vendor-${k.RUN}`, description: "look synthetic vendor", category: "model_provider" }),
      );
      expect(res.statusCode, res.body).toBe(201);
      const instanceId = res.json().workflowInstanceId as string;
      expect((await instanceRow(instanceId)).status).toBe("completed");
      expect(branchExists(instanceId)).toBe(true);
      expect(res.json().status).toBe("approved");
      const [vendor] = await db.select({ status: aiVendors.status }).from(aiVendors).where(eq(aiVendors.id, res.json().id as string));
      expect(vendor!.status).toBe("approved");
    } finally {
      await db.update(workflowTemplates).set({ retiredAt: new Date() }).where(eq(workflowTemplates.id, tpl.row.id));
    }
  }, 180_000);
});
