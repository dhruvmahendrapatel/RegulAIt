import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, approvals, auditLog, createDb, eq, runMigrations, sql, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { runStageDeadlineJob } from "./workflows.js";
import { STAGE_DEADLINE_QUEUE, type StageDeadlineJob } from "./workflows-queue.js";
import { registerWorkflowSlaCourier, type WorkflowSlaNotice } from "./workflow-sla-notify.js";

/**
 * ADR-0340 slice 2 — stage deadlines. Entering a stage with an `sla` sends its timers in the entering transaction; a
 * timer that fires while the instance still rests at that stage execution warns, then breaches with the stage's
 * action (notify, fail). A sign-off stage takes only `fail`: its reminders and escalation are the approvals queue's
 * SLA (ADR-0340 decision 9). The worker is off under vitest, so the tests run the handler the worker calls
 * (`runStageDeadlineJob`) on the job the transition really queued. Everything is prefixed ws- and run-scoped.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = "ws-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "e".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
type U = { id: string; auth: { authorization: string } };
let pia: U;
let ana: U;
let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
const notices: WorkflowSlaNotice[] = [];

const post = (url: string, payload: unknown, headers: Record<string, string> = AUTH) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });

async function makeUser(name: string): Promise<U> {
  const user = await post("/v1/users", { email: `ws-${name}-${RUN}@example.com`, displayName: name });
  expect(user.statusCode, user.body).toBe(201);
  const key = await post(`/v1/users/${user.json().id}/keys`, { name: "ws" });
  return { id: user.json().id as string, auth: { authorization: `Bearer ${key.json().token}` } };
}
async function view(id: string) {
  const res = await app.inject({ method: "GET", url: `/v1/workflows/instances/${id}`, headers: pia.auth });
  expect(res.statusCode).toBe(200);
  return res.json().instance;
}
async function registerTemplate(name: string, stages: object[]) {
  const tpl = await post("/v1/workflows/templates", { name, definition: { workflow: name, stages } });
  expect(tpl.statusCode, tpl.body).toBe(201);
  const rule = await post("/v1/workflows/assignment-rules", { templateId: tpl.json().id, changeType: name });
  expect(rule.statusCode, rule.body).toBe(201);
}
async function start(changeType: string) {
  const res = await post(
    "/v1/workflows/instances",
    { change: { description: `ws ${changeType}`, paths: ["src/x.ts"], changeType, environment: `ws-env-${RUN}` } },
    pia.auth,
  );
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
async function rules(instanceId: string): Promise<string[]> {
  const rows = await db
    .select({ ruleId: auditLog.ruleId })
    .from(auditLog)
    .where(and(eq(auditLog.objectType, "workflow"), eq(auditLog.objectId, instanceId)))
    .orderBy(auditLog.at);
  return rows.map((r) => r.ruleId ?? "");
}
/** the timers the transition really queued for this instance */
async function queued(instanceId: string): Promise<Array<{ data: StageDeadlineJob; delay: number }>> {
  const r = await db.execute(
    sql`SELECT data, extract(epoch from (start_after - created_on))::int AS delay FROM regulait_queue.job
        WHERE name = ${STAGE_DEADLINE_QUEUE} AND data->>'instanceId' = ${instanceId} ORDER BY start_after`,
  );
  return (r.rows as Array<{ data: StageDeadlineJob; delay: number }>).map((x) => ({ data: x.data, delay: Number(x.delay) }));
}
async function pendingApprovers(instanceId: string, stageId: string) {
  return (
    await db
      .select({ approverUserId: approvals.approverUserId })
      .from(approvals)
      .where(and(eq(approvals.instanceId, instanceId), eq(approvals.stageId, stageId), eq(approvals.status, "pending")))
  ).map((r) => r.approverUserId);
}

const conn = `ws-git-${RUN}`;
const g = { connection: conn, repo: `ws-${RUN}/app` };

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  // after buildApp, so this test's courier replaces ChatOps' for the handle
  registerWorkflowSlaCourier(db, async (n) => {
    notices.push(n);
    return { posted: 1, failed: 0 };
  });
  pia = await makeUser("pia");
  ana = await makeUser("ana");
  expect((await post("/v1/git/connections", { name: conn, provider: "mock", token: "not-a-real-token" })).statusCode).toBe(201);
});
afterAll(async () => {
  await restoreAdminKeyMfa?.();
  await app.close();
});

describe("ADR-0340 slice 2: stage deadlines", () => {
  it("entering a timed stage queues a warning and a breach; the warning reminds once; the breach notifies", async () => {
    const name = `ws-notify-${RUN}`;
    await registerTemplate(name, [
      { id: "intake", type: "trigger" },
      { id: "req", type: "artifact_generation", output: "r", sla: { warnAfterSeconds: 3600, breachAfterSeconds: 7200 } },
    ]);
    const id = await start(name);
    const inst = await view(id);
    expect(inst.context["sla:req"]).toMatchObject({ phase: "scheduled", onBreach: "notify", executionKey: `${id}:req:0:0` });
    expect(await rules(id)).toContain("workflow:sla-scheduled");
    const jobs = await queued(id);
    expect(jobs.map((j) => [j.data.phase, j.delay])).toEqual([
      ["warn", 3600],
      ["breach", 7200],
    ]);

    const warn = jobs[0]!.data;
    expect(await runStageDeadlineJob(db, warn, DATA_KEY)).toBe("warned");
    expect(await runStageDeadlineJob(db, warn, DATA_KEY)).toBe("already_done");
    expect(notices.filter((n) => n.instanceId === id)).toEqual([expect.objectContaining({ phase: "warn", recipientUserIds: [pia.id] })]);

    expect(await runStageDeadlineJob(db, jobs[1]!.data, DATA_KEY)).toBe("notified");
    // the lifecycle table refuses a late warning and a second breach
    expect(await runStageDeadlineJob(db, warn, DATA_KEY)).toBe("already_done");
    expect(await runStageDeadlineJob(db, jobs[1]!.data, DATA_KEY)).toBe("already_done");
    const after = await view(id);
    expect(after.status).toBe(inst.status);
    expect(after.context["sla:req"]).toMatchObject({ phase: "breached" });
    expect(notices.filter((n) => n.instanceId === id).map((n) => [n.phase, n.action])).toEqual([
      ["warn", "notify"],
      ["breach", "notify"],
    ]);
    expect(await rules(id)).toEqual(expect.arrayContaining(["workflow:sla-warned", "workflow:sla-breached"]));
  });

  it("a timer for a stage execution the instance has left does nothing", async () => {
    const name = `ws-stale-${RUN}`;
    await registerTemplate(name, [
      { id: "intake", type: "trigger" },
      { id: "gate", type: "human_approval", approvers: [ana.id], sla: { breachAfterSeconds: 600, onBreach: "fail" } },
    ]);
    const id = await start(name);
    const [a] = await db.select().from(approvals).where(and(eq(approvals.instanceId, id), eq(approvals.status, "pending")));
    expect((await post(`/v1/approvals/${a!.id}/decide`, { decision: "approved" }, ana.auth)).statusCode).toBe(200);
    const [job] = await queued(id);
    expect(await runStageDeadlineJob(db, job!.data, DATA_KEY)).toBe("superseded");
    expect((await view(id)).status).toBe("completed");
    expect(await rules(id)).not.toContain("workflow:sla-breached");
  });

  it("a breach that fails the instance cancels it, and the cancel compensates what ran", async () => {
    const name = `ws-fail-${RUN}`;
    await registerTemplate(name, [
      { id: "intake", type: "trigger" },
      { id: "branch", type: "git_operation", action: "create_branch", ...g },
      { id: "gate", type: "human_approval", approvers: [ana.id], sla: { breachAfterSeconds: 600, onBreach: "fail" } },
      { id: "undo_branch", type: "git_operation", action: "delete_branch", compensates: "branch", ...g },
    ]);
    const id = await start(name);
    expect((await view(id)).context.branch).toBeDefined();
    const [job] = await queued(id);
    expect(await runStageDeadlineJob(db, job!.data, DATA_KEY)).toBe("failed_instance");
    const inst = await view(id);
    expect(inst.status).toBe("aborted");
    expect(inst.state.compensation).toMatchObject({ cause: "aborted", outcome: "completed" });
    expect(inst.context["compensation:undo_branch"]).toMatchObject({ changed: true });
    expect(await pendingApprovers(id, "gate")).toEqual([]);
    const r = await rules(id);
    expect(r.indexOf("workflow:sla-breached")).toBeLessThan(r.indexOf("workflow:abort"));
    expect(r).toContain("workflow:compensation-completed");
    const [abort] = await db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.objectId, id), eq(auditLog.ruleId, "workflow:abort")));
    expect(abort!.detail).toMatchObject({ actor: "workflow-sla" });
  });

  it("a sign-off stage with a reminder or a notify deadline is refused (the approvals queue owns those)", async () => {
    for (const sla of [{ breachAfterSeconds: 600 }, { breachAfterSeconds: 600, warnAfterSeconds: 60, onBreach: "fail" }, { breachAfterSeconds: 600, onBreach: "reassign" }]) {
      const res = await post("/v1/workflows/templates", {
        name: `ws-bad-${RUN}`,
        definition: {
          workflow: `ws-bad-${RUN}`,
          stages: [
            { id: "intake", type: "trigger" },
            { id: "gate", type: "human_approval", approvers: [ana.id], sla },
          ],
        },
      });
      expect(res.statusCode, JSON.stringify(sla)).toBe(400);
    }
  });
});
