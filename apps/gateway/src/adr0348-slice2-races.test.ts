/**
 * ADR-0348 slice 2: the races the inventory scored highest, each reproduced with a second transaction that holds
 * a row lock while the code under test runs, then commits. On the code before slice 2 every "race" case below
 * ends in the wrong state; the "valid" cases show the ordinary path is unchanged.
 *
 * - incidents: an edit made from a stale read is refused (it used to silently undo the other edit); a close
 *   re-checks its blockers under the lock (a corrective action added meanwhile used to slip past).
 * - orchestration: approving a budget overage keeps a concurrent measured-spend charge (it used to erase it).
 * - scheduler: a pass whose lease was taken over does not release the new holder's lease.
 *
 * Shared state: identity and step-up posture relaxed and restored (M-068); every row created here is removed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  aiIncidentActions,
  aiIncidents,
  createDb,
  eq,
  inArray,
  orchestrationRuns,
  runMigrations,
  schedulerJobs,
  schedulerRuns,
  sql,
  type Db,
} from "@regulait/db";
import { INCIDENT_MACHINE } from "@regulait/shared";
import { buildApp } from "./app.js";
import { applyRunApprovalDecision, chargeRunBudget } from "./orchestration.js";
import { runSchedulerJob, syncSchedulerJobs, toRegistry, type SchedulerJobDefinition } from "./scheduler.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `adr0348-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
const incidents: string[] = [];
const runs: string[] = [];
const jobNames: string[] = [];
let restoreMfa: (() => Promise<void>) | undefined;
let restoreStepUp: (() => Promise<void>) | undefined;

/** run `hold` in its own transaction and keep it open (its row locks held) until `commit()` is called */
async function heldTransaction(hold: (tx: Db) => Promise<void>): Promise<{ commit: () => Promise<void> }> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let ready!: () => void;
  const written = new Promise<void>((r) => (ready = r));
  const done = db.transaction(async (tx) => {
    await hold(tx as unknown as Db);
    ready();
    await gate;
  });
  await written;
  return {
    commit: async () => {
      release();
      await done;
    },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 300));

async function openIncident(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/incidents",
    headers: AUTH,
    payload: { title: `adr0348 incident ${RUN}`, severity: "low", detectionSource: "manual" },
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().incident.id as string;
  incidents.push(id);
  return id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  restoreStepUp = await relaxStepUpForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `adr0348-${RUN}@example.com`, displayName: `adr0348 ${RUN}`, isAdmin: true },
  });
  expect(u.statusCode, u.body).toBe(201);
  adminId = u.json().id as string;
}, 120_000);

afterAll(async () => {
  await restoreStepUp?.();
  await restoreMfa?.();
  if (incidents.length) {
    // the register keeps an incident that is not closed (migration 0168), so fixtures are closed first
    await db.execute(sql`UPDATE ai_incidents SET status = 'closed', closed_at = now(),
      root_cause = COALESCE(root_cause, 'adr0348 cleanup'), lessons_learned = COALESCE(lessons_learned, 'adr0348 cleanup')
      WHERE id IN (${sql.join(incidents.map((i) => sql`${i}::uuid`), sql`, `)}) AND status <> 'closed'`);
    await db.delete(aiIncidents).where(inArray(aiIncidents.id, incidents));
  }
  if (runs.length) await db.delete(orchestrationRuns).where(inArray(orchestrationRuns.id, runs));
  if (jobNames.length) {
    await db.delete(schedulerRuns).where(inArray(schedulerRuns.jobName, jobNames));
    await db.delete(schedulerJobs).where(inArray(schedulerJobs.name, jobNames));
  }
  app.server.closeAllConnections();
  await app.close();
});

describe("ADR-0348 incidents", () => {
  it("valid: an edit with no one else editing still applies, and the detail carries the lifecycle view", async () => {
    const id = await openIncident();
    const res = await app.inject({ method: "PATCH", url: `/v1/incidents/${id}`, headers: AUTH, payload: { status: "contained" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().incident.status).toBe("contained");
    const lifecycle = res.json().lifecycle as ReturnType<typeof INCIDENT_MACHINE.describe>;
    expect(lifecycle).toMatchObject({ machine: "incident", state: "contained", terminal: false });
    expect(lifecycle.transitions.find((t) => t.event === "resolve")).toMatchObject({ allowed: true });
    expect(lifecycle.transitions.find((t) => t.event === "contain_by_halt")!.allowed).toBe(false);
  });

  it("race: an edit built from a read that someone else's edit has since overtaken is refused, not written over it", async () => {
    const id = await openIncident();
    const other = await heldTransaction(async (tx) => {
      await tx.update(aiIncidents).set({ severity: "medium", updatedAt: new Date() }).where(eq(aiIncidents.id, id));
    });
    const mine = app.inject({ method: "PATCH", url: `/v1/incidents/${id}`, headers: AUTH, payload: { title: `adr0348 retitled ${RUN}` } });
    await settle();
    await other.commit();
    const res = await mine;

    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe("incident_changed");
    const [row] = await db.select().from(aiIncidents).where(eq(aiIncidents.id, id));
    expect(row!.severity).toBe("medium"); // the other responder's change stands
    expect(row!.title).toBe(`adr0348 incident ${RUN}`);
  });

  it("race: a corrective action added while a close is in flight stops the close", async () => {
    const id = await openIncident();
    const other = await heldTransaction(async (tx) => {
      await tx.insert(aiIncidentActions).values({ incidentId: id, title: "adr0348 late action", createdBy: adminId });
    });
    const close = app.inject({
      method: "POST",
      url: `/v1/incidents/${id}/close`,
      headers: AUTH,
      payload: { rootCause: "adr0348 root cause", lessonsLearned: "adr0348 lessons" },
    });
    await settle();
    await other.commit();
    const res = await close;

    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe("incident_actions_open");
    const [row] = await db.select().from(aiIncidents).where(eq(aiIncidents.id, id));
    expect(row!.status).toBe("open");
  });

  it("valid: a close with nothing open still closes, and a closed incident takes no edit", async () => {
    const id = await openIncident();
    const res = await app.inject({
      method: "POST",
      url: `/v1/incidents/${id}/close`,
      headers: AUTH,
      payload: { rootCause: "adr0348 root cause", lessonsLearned: "adr0348 lessons" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().incident.status).toBe("closed");
    expect(res.json().lifecycle.terminal).toBe(true);
    const edit = await app.inject({ method: "PATCH", url: `/v1/incidents/${id}`, headers: AUTH, payload: { status: "open" } });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error).toBe("incident_closed");
  });
});

describe("ADR-0348 orchestration budget overage gate", () => {
  it("race: approving an overage keeps a measured-spend charge that committed meanwhile", async () => {
    const [run] = await db
      .insert(orchestrationRuns)
      .values({
        name: `adr0348-${RUN}`,
        initiatingUserId: adminId,
        graph: { nodes: [] },
        state: { status: "running", nodes: {} },
        status: "running",
        budget: { capUsd: 1, measuredSpentUsd: 0.5, measuredPerNodeUsd: { a: 0.5 } },
      })
      .returning();
    runs.push(run!.id);

    const charge = await heldTransaction(async (tx) => {
      await chargeRunBudget(tx, run!.id, "a", 0.25);
    });
    const approve = applyRunApprovalDecision(db, { runId: run!.id, stageId: "__budget__" }, "approved", adminId);
    await settle();
    await charge.commit();
    await approve;

    const [after] = await db.select().from(orchestrationRuns).where(eq(orchestrationRuns.id, run!.id));
    expect(after!.budget).toMatchObject({ overageApproved: true, measuredSpentUsd: 0.75, measuredPerNodeUsd: { a: 0.75 } });
  });
});

describe("ADR-0348 scheduler lease release", () => {
  it("race: a pass whose lease was taken over leaves the new holder's lease alone and says so on its run row", async () => {
    const name = `adr0348-job-${RUN}`;
    jobNames.push(name);
    const job: SchedulerJobDefinition = {
      name,
      description: "ADR-0348 lease fence test",
      adr: "ADR-0348",
      defaultIntervalSeconds: 3600,
      run: async (ctx) => {
        // while this pass runs, its lease expires and another instance takes the job
        await ctx.db
          .update(schedulerJobs)
          .set({ leaseOwner: "instance-B", lastRunAt: new Date(Date.now() + 1000), running: true })
          .where(eq(schedulerJobs.name, name));
        return { itemsProcessed: 1 };
      },
    };
    await syncSchedulerJobs(db, toRegistry([job]));
    const outcome = await runSchedulerJob(db, job, { instanceId: "instance-A", trigger: "manual", ignoreDue: true, ignoreEnabled: true });
    expect(outcome.outcome).toBe("ok");

    const [row] = await db.select().from(schedulerJobs).where(eq(schedulerJobs.name, name));
    expect(row!.running).toBe(true);
    expect(row!.leaseOwner).toBe("instance-B");
    expect(row!.runs).toBe(0);
    const [ledger] = await db.select().from(schedulerRuns).where(eq(schedulerRuns.id, outcome.runId!));
    expect(ledger!.outcome).toBe("ok");
    expect(ledger!.detail).toMatchObject({ leaseLost: true });
  });

  it("valid: a pass that still holds its lease releases it as before", async () => {
    const name = `adr0348-job2-${RUN}`;
    jobNames.push(name);
    const job: SchedulerJobDefinition = {
      name,
      description: "ADR-0348 lease fence test",
      adr: "ADR-0348",
      defaultIntervalSeconds: 3600,
      run: async () => ({ itemsProcessed: 2 }),
    };
    await syncSchedulerJobs(db, toRegistry([job]));
    const outcome = await runSchedulerJob(db, job, { instanceId: `instance-${randomUUID()}`, trigger: "manual", ignoreDue: true, ignoreEnabled: true });
    expect(outcome.outcome).toBe("ok");
    const [row] = await db.select().from(schedulerJobs).where(eq(schedulerJobs.name, name));
    expect(row!).toMatchObject({ running: false, leaseOwner: null, runs: 1, lastOutcome: "ok", lastItemsProcessed: 2 });
  });
});
