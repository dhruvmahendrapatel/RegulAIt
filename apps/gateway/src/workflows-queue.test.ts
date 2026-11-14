/**
 * ADR-0282 / ADR-0283 / ADR-0284 (P30, lane L5) — automatic stage retry over the pg-boss queue.
 *
 *  - the queue schema in the pending migration IS the pinned pg-boss version's construction plan;
 *  - a template's retry policy schedules ONE job per stage execution (the idempotency key), in the transition's
 *    transaction, audited beside it; a second failure of the same entry schedules nothing new;
 *  - a retry attempt runs the ordinary executor: failed with attempts left → throws (the queue backs off), succeeded,
 *    superseded (the stage moved on: a redelivered job never runs a stage twice), exhausted (audited);
 *  - the worker started the way boot starts it runs a job end to end.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getConstructionPlans } from "pg-boss";
import { and, auditLog, createDb, eq, runMigrations, sql, workflowInstances, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { runStageRetryJob } from "./workflows.js";
import {
  STAGE_RETRY_QUEUE,
  WORKFLOW_QUEUE_SCHEMA,
  stageExecutionKey,
  stageRetryWorkerEnabled,
  startStageRetryWorker,
  type StageRetryJob,
} from "./workflows-queue.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../../packages/db/migrations");

describe("the queue schema migration is the pinned pg-boss construction plan", () => {
  it("matches getConstructionPlans('regulait_queue') minus its own transaction wrapper", () => {
    const file = readFileSync(path.join(migrationsFolder, "pending", "workflow_stage_queue.sql"), "utf8");
    const block = file.slice(file.indexOf("-- pg-boss:begin\n") + "-- pg-boss:begin\n".length, file.indexOf("-- pg-boss:end"));
    const wrapper = /^\s*(BEGIN;|COMMIT;|SET LOCAL lock_timeout|SET LOCAL idle_in_transaction_session_timeout|SELECT pg_advisory_xact_lock\()/;
    const plan = getConstructionPlans(WORKFLOW_QUEUE_SCHEMA)
      .split("\n")
      .filter((l) => !wrapper.test(l))
      .join("\n")
      .trim();
    // a pg-boss upgrade without a migration from getMigrationPlans fails here
    expect(block.trim()).toBe(plan);
  });

  it("the worker is off under vitest and when the switch says off", () => {
    expect(stageRetryWorkerEnabled()).toBe(false);
    expect(stageRetryWorkerEnabled({ REGULAIT_WORKFLOW_RETRY_WORKER: "off" } as NodeJS.ProcessEnv)).toBe(false);
    expect(stageRetryWorkerEnabled({} as NodeJS.ProcessEnv)).toBe(true);
  });
});

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const BOOT = "l5-retry-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "f".repeat(64);
let db: Db;
let app: ReturnType<typeof buildApp>;
let initiator: { authorization: string };
let restoreIdentity: (() => Promise<void>) | undefined;

async function makeTemplate(name: string, connection: string, retry: Record<string, unknown>) {
  const tpl = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/templates",
    payload: {
      name,
      definition: {
        workflow: name,
        stages: [
          { id: "intake", type: "trigger" },
          { id: "branch", type: "git_operation", action: "create_branch", connection, repo: `${name}/app`, retry },
        ],
      },
    },
  });
  expect(tpl.statusCode).toBe(201);
  const rule = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/assignment-rules",
    payload: { templateId: tpl.json().id, changeType: name },
  });
  expect(rule.statusCode).toBe(201);
}

async function start(changeType: string): Promise<string> {
  const r = await app.inject({
    method: "POST",
    headers: initiator,
    url: "/v1/workflows/instances",
    payload: { change: { description: "retry change", paths: ["src/x.ts"], changeType, environment: "staging" } },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

async function instanceRow(id: string) {
  const [row] = await db.select().from(workflowInstances).where(eq(workflowInstances.id, id));
  return row!;
}

async function audits(instanceId: string, ruleId: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.objectId, instanceId), eq(auditLog.ruleId, ruleId)));
}

async function jobsFor(key: string) {
  const r = await db.execute(
    sql`SELECT id, state, retry_limit, retry_delay, retry_backoff, retry_delay_max, data, output FROM regulait_queue.job WHERE name = ${STAGE_RETRY_QUEUE} AND singleton_key = ${key}`,
  );
  return r.rows as Array<{ id: string; state: string; retry_limit: number; retry_delay: number; retry_backoff: boolean; retry_delay_max: number | null; data: StageRetryJob; output: unknown }>;
}

async function jobOf(instanceId: string): Promise<StageRetryJob> {
  const row = await instanceRow(instanceId);
  return { instanceId, stageId: "branch", round: row.round, entry: row.stageEntry };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  const user = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: "l5-retry@example.com", displayName: "Retry" } });
  const key = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${user.json().id}/keys`, payload: { name: "t" } });
  initiator = { authorization: `Bearer ${key.json().token}` };
});

afterAll(async () => {
  await restoreIdentity?.();
  await app.close();
});

describe("ADR-0283: automatic retry with backoff, one chain per stage execution (ADR-0284)", () => {
  it("schedules one job in the failure's transaction; a second failure of the entry schedules nothing new", async () => {
    await makeTemplate("l5-retry-a", "l5-retry-a-git", { maxAttempts: 2, delaySeconds: 5, maxDelaySeconds: 60 });
    const id = await start("l5-retry-a");
    const row = await instanceRow(id);
    expect(row.status).toBe("awaiting_execution");
    expect(String((row.context as Record<string, unknown>).lastError)).toMatch(/unknown git connection/);

    const job = await jobOf(id);
    const key = stageExecutionKey(job);
    const scheduled = await audits(id, "workflow:stage-retry-scheduled");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.detail).toMatchObject({ stageId: "branch", executionKey: key, maxAttempts: 2, delaySeconds: 5 });
    const jobs = await jobsFor(key);
    expect(jobs).toHaveLength(1);
    // the job carries ids only, and the stage's policy as its own retry options
    expect(jobs[0]!.data).toEqual(job);
    expect(jobs[0]).toMatchObject({ state: "created", retry_limit: 1, retry_delay: 5, retry_backoff: true, retry_delay_max: 60 });

    // the initiator retries by hand and it fails again: the same entry's chain is already queued
    const adv = await app.inject({ method: "POST", headers: initiator, url: `/v1/workflows/instances/${id}/advance`, payload: { stageId: "branch" } });
    expect(adv.statusCode).toBeLessThan(500);
    const again = await audits(id, "workflow:stage-retry-not-scheduled");
    expect(again).toHaveLength(1);
    expect(again[0]!.detail).toMatchObject({ notScheduled: "already_scheduled", executionKey: key });
    expect(await jobsFor(key)).toHaveLength(1);

    // attempt 1 of 2 fails: it throws (the queue backs off) and schedules nothing itself
    await expect(runStageRetryJob(db, job, { attempt: 1, maxAttempts: 2, key }, DATA_KEY)).rejects.toThrow(/automatic retry 1 of 2/);
    expect(await jobsFor(key)).toHaveLength(1);
    const failedByRetry = (await audits(id, "workflow:execution_failed")).filter((a) => (a.detail as Record<string, unknown>).retryAttempt);
    expect(failedByRetry).toHaveLength(1);
    expect((failedByRetry[0]!.detail as Record<string, unknown>).retryAttempt).toEqual({ attempt: 1, maxAttempts: 2, key });
    expect(await audits(id, "workflow:stage-retry-attempt")).toHaveLength(1);

    // the cause is fixed: attempt 2 of 2 succeeds and the instance completes
    const conn = await app.inject({ method: "POST", headers: AUTH, url: "/v1/git/connections", payload: { name: "l5-retry-a-git", provider: "mock", token: "not-a-real-token" } });
    expect(conn.statusCode).toBe(201);
    await expect(runStageRetryJob(db, job, { attempt: 2, maxAttempts: 2, key }, DATA_KEY)).resolves.toBe("succeeded");
    expect((await instanceRow(id)).status).toBe("completed");

    // a redelivered job finds the execution gone and runs nothing
    await expect(runStageRetryJob(db, job, { attempt: 2, maxAttempts: 2, key }, DATA_KEY)).resolves.toBe("superseded");
    expect(await audits(id, "workflow:stage-retry-attempt")).toHaveLength(2);
  });

  it("audits the exhaustion when the last attempt fails, and the stage waits for /advance", async () => {
    await makeTemplate("l5-retry-b", "l5-retry-b-missing", { maxAttempts: 1, delaySeconds: 5 });
    const id = await start("l5-retry-b");
    const job = await jobOf(id);
    const key = stageExecutionKey(job);
    await expect(runStageRetryJob(db, job, { attempt: 1, maxAttempts: 1, key }, DATA_KEY)).resolves.toBe("exhausted");
    const exhausted = await audits(id, "workflow:stage-retry-exhausted");
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]!.effect).toBe("deny");
    expect((await instanceRow(id)).status).toBe("awaiting_execution");
  });

  it("an aborted instance supersedes its queued retry", async () => {
    await makeTemplate("l5-retry-c", "l5-retry-c-missing", { maxAttempts: 3, delaySeconds: 5 });
    const id = await start("l5-retry-c");
    const job = await jobOf(id);
    const abort = await app.inject({ method: "POST", headers: initiator, url: `/v1/workflows/instances/${id}/abort`, payload: {} });
    expect(abort.statusCode).toBe(200);
    await expect(runStageRetryJob(db, job, { attempt: 1, maxAttempts: 3, key: stageExecutionKey(job) }, DATA_KEY)).resolves.toBe("superseded");
    expect(await audits(id, "workflow:stage-retry-attempt")).toHaveLength(0);
  });

  it("a template with no retry policy schedules nothing (the strict default)", async () => {
    const tpl = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/templates",
      payload: {
        name: "l5-retry-none",
        definition: { workflow: "l5-retry-none", stages: [{ id: "intake", type: "trigger" }, { id: "branch", type: "git_operation", action: "create_branch", connection: "l5-none", repo: "none/app" }] },
      },
    });
    await app.inject({ method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules", payload: { templateId: tpl.json().id, changeType: "l5-retry-none" } });
    const id = await start("l5-retry-none");
    expect((await instanceRow(id)).status).toBe("awaiting_execution");
    expect(await audits(id, "workflow:stage-retry-scheduled")).toHaveLength(0);
    expect(await jobsFor(stageExecutionKey(await jobOf(id)))).toHaveLength(0);
  });

  it("the worker, started as boot starts it, runs a due job end to end", async () => {
    await makeTemplate("l5-retry-w", "l5-retry-w-missing", { maxAttempts: 1, delaySeconds: 5 });
    const id = await start("l5-retry-w");
    const key = stageExecutionKey(await jobOf(id));
    await db.execute(sql`UPDATE regulait_queue.job SET start_after = now() WHERE singleton_key = ${key}`);
    const worker = await startStageRetryWorker(db, { pollingIntervalSeconds: 0.5 });
    try {
      const deadline = Date.now() + 15_000;
      let state = "";
      while (Date.now() < deadline) {
        state = (await jobsFor(key))[0]?.state ?? "";
        if (state === "completed" || state === "failed") break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(state).toBe("completed");
      expect((await jobsFor(key))[0]!.output).toEqual({ outcome: "exhausted" });
      expect(await audits(id, "workflow:stage-retry-exhausted")).toHaveLength(1);
    } finally {
      await worker.stop();
    }
  });
});
