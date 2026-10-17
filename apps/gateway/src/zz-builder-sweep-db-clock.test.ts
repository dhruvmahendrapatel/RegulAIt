/**
 * M-075 / ADR-0173 As built (N13): the SCHEDULED builder sweep judges due-ness on the database clock.
 *
 *  1. the scheduler marks its clock as injected only when a caller supplied one, so a job can tell a test's clock
 *     from the process clock;
 *  2. the registered `builder-agent-schedules` job, handed a process clock two days behind the database, still
 *     runs a schedule the database says is due. Control: the same skewed clock, marked as injected, is honoured
 *     and the schedule is not due yet.
 *
 * Its own database: the sweep runs every due schedule, and the job's lease must not race another file's.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { builderAgentSchedules, eq, sql } from "@regulait/db";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { databaseNow } from "./db-clock.js";
import { runSchedulerJob, Scheduler, syncSchedulerJobs, toRegistry, type SchedulerJobContext } from "./scheduler.js";
import { SCHEDULER_JOB_NAMES, schedulerJobRegistry } from "./scheduler-jobs.js";

let k: BuilderKit;
let owner: Person;
let priced = "";
let restoreSb2Gates: () => Promise<void> = async () => {};
let restoreStrictAdmission: (() => Promise<void>) | undefined;

const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  k = await builderKit("bld-sweep-clock", { scratch: true });
  restoreSb2Gates = await relaxGovernanceGatesForTest(k.db, { mrmEnforced: false, dispatchAttributionRequired: false });
  restoreStrictAdmission = await relaxStrictAdmissionForTest(k.db);
  owner = await k.person("owner");
  priced = await k.model("priced", { price: 100_000 });
  await k.grantModel(owner.id, priced);
}, 120_000);

afterAll(async () => {
  await restoreStrictAdmission?.();
  await restoreSb2Gates();
  await k.close();
});

describe("1. the scheduler says whether its clock was injected", () => {
  it("the process clock is not injected; a supplied clock is, and is the one passed", async () => {
    const seen: SchedulerJobContext[] = [];
    const mk = (name: string) => toRegistry([
      { name, description: "records its context", adr: "ADR-0173", defaultIntervalSeconds: 60, run: async (ctx) => (seen.push(ctx), {}) },
    ]);
    const plain = mk(`test-clock-plain-${k.RUN}`);
    await syncSchedulerJobs(k.db, plain);
    await new Scheduler(k.db, { registry: plain, instanceId: `clock-plain-${k.RUN}` }).tick();
    // ahead, so the freshly synced job is due by the injected clock too
    const skewed = new Date(Date.now() + 2 * DAY_MS);
    const injected = mk(`test-clock-injected-${k.RUN}`);
    await syncSchedulerJobs(k.db, injected);
    await new Scheduler(k.db, { registry: injected, instanceId: `clock-inj-${k.RUN}`, now: () => skewed }).tick();
    expect(seen).toHaveLength(2);
    expect(seen[0]!.clockInjected).toBe(false);
    expect(seen[1]!.clockInjected).toBe(true);
    expect(seen[1]!.now.getTime()).toBe(skewed.getTime());
  });
});

describe("2. the scheduled sweep decides due-ness on the database clock", () => {
  it("a process clock two days behind does not hold back a schedule the database says is due", async () => {
    const agent = await k.req("POST", "/v1/builder/agents", owner.auth, {
      name: `Clock ${k.RUN}`,
      connectionFormat: "shared",
      computerUse: false,
      projectId: owner.projectId,
      modelAgentId: priced,
    });
    expect(agent.statusCode, agent.body).toBe(201);
    const made = await k.req("POST", `/v1/builder/agents/${agent.json().agent.id}/schedules`, owner.auth, {
      name: "Daily", cadence: "daily", timeUtc: "06:00", prompt: "digest", enabled: true,
    });
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json().id as string;
    // due a minute ago by the DATABASE's clock; millisecond precision, as every writer stores it (the sweep's
    // claim compares `next_run_at` with the value it read back into a JS Date)
    await k.db.update(builderAgentSchedules).set({ nextRunAt: sql`date_trunc('milliseconds', now() - interval '60 seconds')` }).where(eq(builderAgentSchedules.id, id));
    const row = async () => (await k.db.select().from(builderAgentSchedules).where(eq(builderAgentSchedules.id, id)))[0]!;

    const def = schedulerJobRegistry({ dataKey: "a".repeat(64) }).get(SCHEDULER_JOB_NAMES.builderAgentSchedules)!;
    await syncSchedulerJobs(k.db, toRegistry([def]));
    const behind = new Date((await databaseNow(k.db)).getTime() - 2 * DAY_MS);
    const run = (clockInjected: boolean) =>
      runSchedulerJob(k.db, def, {
        instanceId: `sweep-clock-${k.RUN}`,
        trigger: "schedule",
        now: behind,
        clockInjected,
        ignoreDue: true,
        ignoreEnabled: true,
      });

    // control: an injected clock is honoured, and by it the schedule is not due yet
    const held = await run(true);
    expect(held.outcome, JSON.stringify(held)).toBe("ok");
    expect(held.detail).toMatchObject({ due: 0, ran: 0 });
    expect((await row()).lastRunAt).toBeNull();

    // the scheduler's own (process) clock, two days behind: the sweep reads the database clock and runs it
    const out = await run(false);
    expect(out.outcome, JSON.stringify(out)).toBe("ok");
    expect(out.detail).toMatchObject({ due: 1 });
    const after = await row();
    expect(after.lastRunAt).not.toBeNull();
    // stamped from the database's clock, not two days back
    expect(after.lastRunAt!.getTime()).toBeGreaterThan(behind.getTime() + DAY_MS);
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(after.lastRunAt!.getTime());
  });
});
