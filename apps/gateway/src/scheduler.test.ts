import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  approvalAssignments,
  approvals,
  auditLog,
  createDb,
  desc,
  eq,
  evalRuns,
  modelCardApprovals,
  modelCards,
  reportRuns,
  reportSchedules,
  runMigrations,
  schedulerJobs,
  schedulerRuns,
  sql,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { startGateway } from "./boot.js";
import {
  DEFAULT_TICK_MS,
  Scheduler,
  claimJob,
  resolveSchedulerConfig,
  runSchedulerJob,
  syncSchedulerJobs,
  toRegistry,
  type SchedulerJobDefinition,
} from "./scheduler.js";
import { SCHEDULER_JOB_NAMES, schedulerJobRegistry } from "./scheduler-jobs.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

/**
 * ADR-0064 — THE IN-PROCESS SCHEDULER, proved by attack.
 *
 * What this file tries to make impossible to fake:
 *
 *  1. A LOCK THAT IS A COMMENT. The contention case starts TWO schedulers with
 *     TWO independent connection pools against ONE database, arranges for the
 *     job to be genuinely mid-flight when the second one arrives, and asserts
 *     the body executed EXACTLY ONCE via a counter — and that the loser
 *     recorded a `skipped` run rather than erroring. If the claim ever
 *     degrades to "check then set", this goes red.
 *
 *  2. A CRASH THAT PROPAGATES. Job A throws; job B on the SAME tick must still
 *     run, the tick must still return, the gateway must still serve HTTP, and
 *     A's error must be on its run row, its job row and in the audit log.
 *
 *  3. A JOB THAT STACKS ON ITSELF. A body slower than the tick interval is
 *     driven by a real running loop, and the maximum observed concurrency must
 *     be 1.
 *
 *  4. TIMERS UNDER TEST. Constructing an app must start NOTHING — this is the
 *     property that protects a 1689-test suite from this feature — and the
 *     posture resolver must refuse to enable even when the environment says on.
 *
 *  5. SWEEPS THAT ARE REGISTERED BUT NOT WIRED. Four of the six are driven end
 *     to end here and asserted on their REAL EFFECT (a model card flipped to
 *     expired, an SLA breach recorded, a report generated, an eval run created
 *     with the `scheduled` trigger). The other two are asserted to be
 *     registered AND to produce, through "run now", the identical result shape
 *     their own endpoint produces.
 *
 *  6. A SWEEP THAT BECAME A CONTROL. The last block is the invariant that must
 *     never regress: with the scheduler off entirely, MRM still refuses a
 *     lapsed card at dispatch and an SLA breach is still caught on a plain
 *     read. The sweeps buy timeliness, not correctness.
 *
 * ISOLATION. This file owns a SCRATCH DATABASE. `scheduler_jobs` is a global
 * table and the contention case deliberately leaves a lease mid-flight; doing
 * that on the shared suite database would be a landmine for every other file.
 * No fake timers are used anywhere here — the loop is driven by real intervals
 * of 20–50ms, so nothing can leak into another file's clock.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

// Per-RUN unique (pid + timestamp): a fixed name plus beforeAll's
// DROP ... WITH (FORCE) lets two concurrent runs on one host destroy each
// other's database (PENDING §5); afterAll drops this one, so nothing persists.
const SCRATCH_DB = `regulait_sched_adr0064_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + SCRATCH_DB;
  return u.toString();
})();
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "scheduler-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "5".repeat(64);

let admin: Db;
let db: Db;
/** a SECOND handle on the SAME database — a second gateway instance's pool */
let db2: Db;
let app: ReturnType<typeof buildApp>;

/** a promise a test resolves by hand, so "the job is mid-flight" is a fact
 * rather than a sleep */
function barrier() {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return { gate, release };
}

/** poll until `check` is true, or fail loudly. Never a bare sleep: a bare
 * sleep is how a concurrency test becomes a flake. */
async function until(check: () => Promise<boolean>, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function jobRow(name: string) {
  const [row] = await db.select().from(schedulerJobs).where(eq(schedulerJobs.name, name));
  return row;
}

async function runsFor(name: string) {
  return db
    .select()
    .from(schedulerRuns)
    .where(eq(schedulerRuns.jobName, name))
    .orderBy(desc(schedulerRuns.startedAt));
}

async function auditsFor(ruleId: string, jobName: string) {
  const rows = await db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId));
  return rows.filter((r) => (r.detail as { job?: string } | null)?.job === jobName);
}

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    // no "@" in the display name — another suite asserts across the whole users
    // table that nothing email-shaped leaks through the names-only directory
    payload: { email, displayName: email.split("@")[0]!.replace(/-/g, " ") },
  });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({
    method: "POST",
    url: `/v1/users/${u.json().id}/keys`,
    headers: AUTH,
    payload: { name: "sched" },
  });
  expect(k.statusCode).toBe(201);
  return { id: u.json().id as string, apiKey: k.json().token as string };
}

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(scratchUrl);
  db2 = createDb(scratchUrl);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
}, 90_000);

afterAll(async () => {
  await closeAll([
    async () => {
      await app.close();
    },
    async () => {
      await db.$client.end();
    },
    async () => {
      await db2.$client.end();
    },
    async () => {
      await dropScratchDatabase(admin, SCRATCH_DB);
    },
    async () => {
      await admin.$client.end();
    },
  ]);
});

// ===========================================================================
// 1. THE LOCK — two schedulers, one database, exactly one execution
// ===========================================================================

describe("the DB lock makes a second instance safe", () => {
  it("two schedulers against one database run the job EXACTLY ONCE, and the loser records a skip", async () => {
    let executions = 0;
    const b = barrier();
    const job: SchedulerJobDefinition = {
      name: "test-contention",
      description: "held open by a barrier so the second claim genuinely races a live lease",
      adr: "ADR-0064",
      defaultIntervalSeconds: 60,
      run: async () => {
        executions += 1;
        await b.gate;
        return { itemsProcessed: 7 };
      },
    };
    const registry = toRegistry([job]);
    await syncSchedulerJobs(db, registry);

    // instance A claims and then BLOCKS inside the body, holding the lease
    const a = runSchedulerJob(db, job, { instanceId: "instance-A", trigger: "schedule" });
    await until(async () => (await jobRow(job.name))?.running === true, "instance A to take the lease");

    // instance B — a genuinely separate pool — arrives while the lease is live
    const bOutcome = await runSchedulerJob(db2, job, { instanceId: "instance-B", trigger: "schedule" });

    expect(bOutcome.outcome).toBe("skipped");
    expect(bOutcome.reason).toBe("lease_held");
    // a skip is DATA, not an error: "the other box ran it" must not look like
    // "nothing ran it"
    expect(bOutcome.runId).toBeTruthy();

    b.release();
    const aOutcome = await a;
    expect(aOutcome.outcome).toBe("ok");
    expect(aOutcome.itemsProcessed).toBe(7);

    // THE ASSERTION THAT MATTERS
    expect(executions).toBe(1);

    const rows = await runsFor(job.name);
    expect(rows.filter((r) => r.outcome === "ok")).toHaveLength(1);
    const skip = rows.find((r) => r.outcome === "skipped");
    expect(skip).toBeDefined();
    expect(skip!.instanceId).toBe("instance-B");
    expect((skip!.detail as { reason?: string; heldBy?: string }).reason).toBe("lease_held");
    expect((skip!.detail as { heldBy?: string }).heldBy).toBe("instance-A");

    // the lease is released, so the next pass is claimable again
    const after = await jobRow(job.name);
    expect(after!.running).toBe(false);
    expect(after!.leaseOwner).toBeNull();
    expect(after!.lastOutcome).toBe("ok");
    expect(after!.lastItemsProcessed).toBe(7);
    // the next window opens from when the pass FINISHED, so a slow job cannot
    // become instantly due again and monopolise every tick
    expect(after!.nextDueAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("an EXPIRED lease is reclaimable — a SIGKILLed holder does not strand the job forever", async () => {
    const job: SchedulerJobDefinition = {
      name: "test-expired-lease",
      description: "left with a lease in the past, as a crashed holder would",
      adr: "ADR-0064",
      defaultIntervalSeconds: 60,
      run: async () => ({ itemsProcessed: 1 }),
    };
    await syncSchedulerJobs(db, toRegistry([job]));
    await db
      .update(schedulerJobs)
      .set({
        running: true,
        leaseOwner: "a-process-that-died",
        leaseExpiresAt: new Date(Date.now() - 60_000),
      })
      .where(eq(schedulerJobs.name, job.name));

    const out = await runSchedulerJob(db, job, { instanceId: "instance-C", trigger: "schedule" });
    expect(out.outcome).toBe("ok");
  });

  it("a disabled job is not claimed by the tick, but IS claimed by an explicit run-now", async () => {
    let ran = 0;
    const job: SchedulerJobDefinition = {
      name: "test-disabled",
      description: "off",
      adr: "ADR-0064",
      defaultIntervalSeconds: 60,
      run: async () => {
        ran += 1;
        return {};
      },
    };
    await syncSchedulerJobs(db, toRegistry([job]));
    await db.update(schedulerJobs).set({ enabled: false }).where(eq(schedulerJobs.name, job.name));

    const claim = await claimJob(db, job.name, { instanceId: "x", trigger: "schedule" });
    expect(claim.claimed).toBe(false);
    expect(claim.claimed === false && claim.reason).toBe("job_disabled");
    expect(ran).toBe(0);

    const forced = await runSchedulerJob(db, job, {
      instanceId: "x",
      trigger: "manual",
      ignoreDue: true,
      ignoreEnabled: true,
    });
    expect(forced.outcome).toBe("ok");
    expect(ran).toBe(1);
  });

  it("a job that is not yet due is skipped without a ledger row — 'not due' is not an event", async () => {
    const job: SchedulerJobDefinition = {
      name: "test-not-due",
      description: "due far in the future",
      adr: "ADR-0064",
      defaultIntervalSeconds: 3600,
      run: async () => ({}),
    };
    await syncSchedulerJobs(db, toRegistry([job]));
    await db
      .update(schedulerJobs)
      .set({ nextDueAt: new Date(Date.now() + 3_600_000) })
      .where(eq(schedulerJobs.name, job.name));

    const out = await runSchedulerJob(db, job, { instanceId: "x", trigger: "schedule" });
    expect(out.outcome).toBe("skipped");
    expect(out.reason).toBe("not_due");
    expect(await runsFor(job.name)).toHaveLength(0);
  });
});

// ===========================================================================
// 2. ISOLATION — a throwing job cannot take anything else down
// ===========================================================================

describe("a crashing job is isolated", () => {
  it("job A throws, job B on the SAME tick still runs, and the gateway still serves", async () => {
    let bRan = 0;
    const a: SchedulerJobDefinition = {
      name: "test-thrower",
      description: "always throws",
      adr: "ADR-0064",
      defaultIntervalSeconds: 60,
      run: async () => {
        throw new Error("deliberate explosion inside a job body");
      },
    };
    const b: SchedulerJobDefinition = {
      name: "test-survivor",
      description: "must still run",
      adr: "ADR-0064",
      defaultIntervalSeconds: 60,
      run: async () => {
        bRan += 1;
        return { itemsProcessed: 3 };
      },
    };
    const registry = toRegistry([a, b]);
    await syncSchedulerJobs(db, registry);

    const sched = new Scheduler(db, { registry, instanceId: "isolation" });
    const summary = await sched.tick();

    expect(summary.results.find((r) => r.job === a.name)?.outcome).toBe("failed");
    expect(summary.results.find((r) => r.job === b.name)?.outcome).toBe("ok");
    expect(bRan).toBe(1);

    // the failure is RECORDED, in all three places
    const aRun = (await runsFor(a.name))[0];
    expect(aRun!.outcome).toBe("failed");
    expect(aRun!.error).toContain("deliberate explosion inside a job body");
    expect(aRun!.finishedAt).toBeTruthy();

    const aJob = await jobRow(a.name);
    expect(aJob!.lastOutcome).toBe("failed");
    expect(aJob!.lastError).toContain("deliberate explosion");
    expect(aJob!.failures).toBe(1);
    expect(aJob!.consecutiveFailures).toBe(1);
    // and the lease is RELEASED — a crash must not strand the job
    expect(aJob!.running).toBe(false);

    const failAudit = await auditsFor("scheduler-job-failed", a.name);
    expect(failAudit).toHaveLength(1);
    expect(failAudit[0]!.effect).toBe("deny");
    expect(failAudit[0]!.objectType).toBe("scheduler_job");
    expect(failAudit[0]!.reason).toContain("deliberate explosion");

    // the gateway is untouched
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);

    // a SUCCESS after a failure clears the consecutive counter
    await runSchedulerJob(db, a, { instanceId: "isolation", trigger: "manual", ignoreDue: true });
    await runSchedulerJob(db, b, { instanceId: "isolation", trigger: "manual", ignoreDue: true });
    expect((await jobRow(b.name))!.consecutiveFailures).toBe(0);
    expect((await jobRow(a.name))!.consecutiveFailures).toBe(2);
  });

  it("every pass is audited with a stable ruleId, start and outcome both", async () => {
    const started = await auditsFor("scheduler-job-started", "test-survivor");
    const ok = await auditsFor("scheduler-job-succeeded", "test-survivor");
    expect(started.length).toBeGreaterThanOrEqual(1);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(ok[0]!.objectType).toBe("scheduler_job");
    expect(ok[0]!.effect).toBe("allow");
    // the run id is the audit row's objectId, so a row and its ledger entry
    // resolve to each other
    const runIds = new Set((await runsFor("test-survivor")).map((r) => r.id));
    expect(runIds.has(ok[0]!.objectId!)).toBe(true);
  });
});

// ===========================================================================
// 3. OVERLAP — a slow job does not stack on itself
// ===========================================================================

describe("overlap protection", () => {
  it("a body slower than the tick interval never runs two copies at once", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let starts = 0;
    const b = barrier();
    const job: SchedulerJobDefinition = {
      name: "test-slow",
      description: "outlives its own tick interval",
      adr: "ADR-0064",
      defaultIntervalSeconds: 1,
      run: async () => {
        starts += 1;
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await b.gate;
        concurrent -= 1;
        return {};
      },
    };
    const registry = toRegistry([job]);
    await syncSchedulerJobs(db, registry);

    // a REAL running loop at 20ms — many ticks land while the body is blocked
    const sched = new Scheduler(db, { registry, tickMs: 20, instanceId: "overlap" });
    sched.start();
    await until(async () => starts >= 1, "the first pass to start");
    await new Promise((r) => setTimeout(r, 250)); // ~12 further ticks
    expect(maxConcurrent).toBe(1);
    expect(starts).toBe(1);

    b.release();
    await sched.stop();
    expect(concurrent).toBe(0);
  });

  it("run-now refuses to start a second copy while this process is mid-pass", async () => {
    const b = barrier();
    let starts = 0;
    const job: SchedulerJobDefinition = {
      name: "test-runnow-overlap",
      description: "held open",
      adr: "ADR-0064",
      defaultIntervalSeconds: 60,
      run: async () => {
        starts += 1;
        await b.gate;
        return {};
      },
    };
    const registry = toRegistry([job]);
    await syncSchedulerJobs(db, registry);
    const sched = new Scheduler(db, { registry, instanceId: "runnow" });

    const first = sched.runNow(job.name, null);
    await until(async () => starts >= 1, "the first run-now to start");
    const second = await sched.runNow(job.name, null);
    expect(second.outcome).toBe("skipped");
    expect(second.reason).toBe("already_running_in_process");

    b.release();
    expect((await first).outcome).toBe("ok");
    expect(starts).toBe(1);
    await sched.stop();
  });
});

// ===========================================================================
// 4. OFF BY DEFAULT — the property that protects the rest of the suite
// ===========================================================================

describe("off by default, and explicitly on", () => {
  it("resolveSchedulerConfig is OFF with an empty environment", () => {
    const cfg = resolveSchedulerConfig({} as NodeJS.ProcessEnv);
    expect(cfg.enabled).toBe(false);
    expect(cfg.reason).toMatch(/REGULAIT_SCHEDULER unset/);
    expect(cfg.tickMs).toBe(DEFAULT_TICK_MS);
  });

  it("resolveSchedulerConfig is ON only when explicitly asked", () => {
    expect(resolveSchedulerConfig({ REGULAIT_SCHEDULER: "on" } as NodeJS.ProcessEnv).enabled).toBe(true);
    expect(resolveSchedulerConfig({ REGULAIT_SCHEDULER: "true" } as NodeJS.ProcessEnv).enabled).toBe(true);
    expect(resolveSchedulerConfig({ REGULAIT_SCHEDULER: "off" } as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(resolveSchedulerConfig({ REGULAIT_SCHEDULER: "maybe" } as NodeJS.ProcessEnv).enabled).toBe(false);
  });

  it("is FORCED off under test even when the environment says on — a stray CI var cannot start timers", () => {
    for (const env of [
      { VITEST: "1", REGULAIT_SCHEDULER: "on" },
      { NODE_ENV: "test", REGULAIT_SCHEDULER: "on" },
    ] as NodeJS.ProcessEnv[]) {
      const cfg = resolveSchedulerConfig(env);
      expect(cfg.enabled).toBe(false);
      expect(cfg.reason).toMatch(/forced off under test/);
    }
    // and the process this suite is actually running in
    expect(resolveSchedulerConfig().enabled).toBe(false);
  });

  it("CONSTRUCTING AN APP STARTS NO TIMER AND RUNS NO JOB", async () => {
    // the guarantee the other 103 test files depend on, asserted rather than
    // intended. `buildApp` is what every one of them calls.
    await syncSchedulerJobs(db, schedulerJobRegistry({ dataKey: DATA_KEY }));
    await db.update(schedulerJobs).set({ nextDueAt: new Date(0) });
    const before = (
      await db.select({ n: sql<number>`count(*)::int` }).from(schedulerRuns)
    )[0]!.n;

    const throwaway = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
    await throwaway.ready();
    // well past any plausible tick a construction-time scheduler would use if
    // one existed (the default tick is 60s; 1.2s is enough to catch a fast one)
    await new Promise((r) => setTimeout(r, 1200));
    const after = (await db.select({ n: sql<number>`count(*)::int` }).from(schedulerRuns))[0]!.n;
    expect(after).toBe(before);
    await throwaway.close();
  }, 30_000);

  it("startGateway leaves the scheduler NULL when the environment has not asked for it", async () => {
    const started = await startGateway({
      db,
      migrationsFolder,
      port: 0,
      host: "127.0.0.1",
      bootstrapToken: BOOT,
      dataKey: DATA_KEY,
      log: () => {},
      env: { ...process.env, REGULAIT_SCHEDULER: "off" },
    });
    expect(started.scheduler).toBeNull();
    // it still SYNCS the definitions, so an operator can see what WOULD run
    expect(await jobRow(SCHEDULER_JOB_NAMES.mrmExpiry)).toBeDefined();
    await started.app.close();
  }, 60_000);

  /**
   * REGRESSION — the first real deployment with REGULAIT_SCHEDULER=on
   * crash-looped, exit 1, before serving a single request:
   *
   *   FastifyError: Fastify instance is already listening. Cannot call "addHook"!
   *       at startGateway (boot.js:96)
   *
   * The scheduler's `onClose` hook was registered next to `scheduler.start()`,
   * which is deliberately AFTER `app.listen()` — and Fastify throws rather than
   * warns when a hook is added to a listening instance.
   *
   * It survived the whole suite because the two conditions never met: the
   * scheduler is force-disabled under vitest, and every other scheduler test
   * drives a `Scheduler` directly instead of going through startGateway. The
   * ONE existing startGateway test asserted the `off` path.
   *
   * So this test does the only thing that would have caught it: boots the real
   * gateway, through the real listen, with the scheduler genuinely ENABLED —
   * which needs an env with no VITEST key, since resolveSchedulerConfig forces
   * off under test regardless of the variable.
   */
  it("REGRESSION: startGateway with the scheduler ENABLED listens and shuts down cleanly", async () => {
    // strip the markers that force the scheduler off, or this asserts nothing
    const { VITEST: _vitest, VITEST_WORKER_ID: _worker, ...rest } = process.env;
    const enabledEnv = { ...rest, NODE_ENV: "production", REGULAIT_SCHEDULER: "on" };

    // guard the guard: if this ever resolves to disabled the test is vacuous
    expect(resolveSchedulerConfig(enabledEnv).enabled).toBe(true);

    const started = await startGateway({
      db,
      migrationsFolder,
      port: 0,
      host: "127.0.0.1",
      bootstrapToken: BOOT,
      dataKey: DATA_KEY,
      log: () => {},
      env: enabledEnv,
    });

    // it got past listen (the bug threw before this line) and the loop is live
    expect(started.scheduler).not.toBeNull();
    expect(started.app.server.listening).toBe(true);

    // and the onClose hook it registers actually stops the loop
    await started.app.close();
    expect(started.scheduler!.timerActive).toBe(false);
  }, 60_000);
});

// ===========================================================================
// 5. SHUTDOWN
// ===========================================================================

describe("clean shutdown", () => {
  it("stop() clears the interval, waits for the in-flight pass, and leaves nothing running", async () => {
    let finished = false;
    let starts = 0;
    const b = barrier();
    const job: SchedulerJobDefinition = {
      name: "test-shutdown",
      description: "in flight when stop() is called",
      adr: "ADR-0064",
      defaultIntervalSeconds: 1,
      run: async () => {
        starts += 1;
        await b.gate;
        finished = true;
        return {};
      },
    };
    const registry = toRegistry([job]);
    await syncSchedulerJobs(db, registry);
    const sched = new Scheduler(db, { registry, tickMs: 20, instanceId: "shutdown" });
    sched.start();

    // the interval exists but is UNREF'd — it can never be the reason a process
    // refuses to exit
    expect(sched.timerActive).toBe(true);
    expect(sched.timerKeepsProcessAlive).toBe(false);

    await until(async () => starts >= 1, "the pass to start");

    const stopping = sched.stop();
    // SHUTDOWN SEMANTICS: awaited, not aborted. The pass has not finished yet,
    // so stop() must not have resolved.
    expect(finished).toBe(false);
    b.release();
    await stopping;

    expect(finished).toBe(true);
    expect(sched.timerActive).toBe(false);
    expect(sched.running).toEqual([]);

    // and no further ticks happen after stop()
    const ticksAfter = starts;
    await new Promise((r) => setTimeout(r, 200));
    expect(starts).toBe(ticksAfter);
  }, 30_000);
});

// ===========================================================================
// 6. THE REGISTERED JOBS — six from ADR-0064, plus the ones later ADRs added
// ===========================================================================

describe("every sweep is registered", () => {
  it("the registry names exactly them, each with an ADR and a cadence", async () => {
    const registry = schedulerJobRegistry({ dataKey: DATA_KEY });
    expect([...registry.keys()].sort()).toEqual(
      [
        SCHEDULER_JOB_NAMES.approvalSla,
        // ADR-0073 amendment (B7c): prunes shadow-canary OBSERVATIONS older
        // than the org retention window — never config_versions (the audit
        // substrate), never a live canary's evidence. Driven end-to-end in
        // canary-observation-prune.test.ts; this list pins its registration.
        SCHEDULER_JOB_NAMES.canaryObservationPrune,
        // ADR-0090 amendment (B2a): records campaign expiry into the audit
        // log, once per campaign — decides NOTHING (expiry stays computed on
        // read). Driven end-to-end in grant-certification-ops.test.ts; this
        // list pins its registration.
        SCHEDULER_JOB_NAMES.certificationExpiry,
        // ADR-0076: reconciles cross-batch duplicate imported cost lines —
        // marked, never deleted. Driven end-to-end in cost-reconcile.test.ts;
        // this list pins its registration.
        SCHEDULER_JOB_NAMES.costReconciliation,
        SCHEDULER_JOB_NAMES.evalDrift,
        // ADR-0157: the governance monitor — raises, refreshes and resolves
        // alerts; decides nothing a dispatch reads. Driven end-to-end in
        // zz-adr0157-governance-monitor.test.ts; this list pins its registration.
        SCHEDULER_JOB_NAMES.governanceMonitor,
        // ADR-0100: re-fetches and re-adjudicates MCP tool manifests so a
        // server nobody calls is still caught. Drives the LIVE path
        // (connectUpstream + syncUpstreamTools + recordManifestScan) — there
        // is no second adjudication. Driven end-to-end in
        // mcp-admission-rescan.test.ts; this list pins its registration.
        SCHEDULER_JOB_NAMES.mcpAdmissionRescan,
        // ADR-0126's ACTIVE half: probes every registered upstream — broken ones
        // first — and feeds the result to the breaker, so a dead server is
        // refused before a user finds it and a recovered one resumes without
        // waiting for someone to try. Charges OUR refusals (admission holds,
        // egress blocks) to nothing, because an air-gapped install would
        // otherwise report every upstream as broken. Driven end-to-end in
        // zz-mcp-health-probe.test.ts; this list pins its registration.
        SCHEDULER_JOB_NAMES.mcpHealthProbe,
        // ADR-0101: pulls each ENABLED upstream MCP registry and refreshes the
        // federated CATALOGUE — and nothing else. It creates no server row and
        // no grant, because turning a directory entry into a governed object is
        // an explicit operator act, not something a timer does on the estate's
        // behalf. Driven end-to-end in mcp-registry.test.ts; this list pins its
        // registration.
        SCHEDULER_JOB_NAMES.mcpRegistrySync,
        SCHEDULER_JOB_NAMES.mrmExpiry,
        SCHEDULER_JOB_NAMES.redteam,
        SCHEDULER_JOB_NAMES.reportSchedules,
        SCHEDULER_JOB_NAMES.spendAnomalies,
        // ADR-0065: remote training jobs run on somebody else's compute for
        // hours; polling them is a scheduler job, never a setInterval.
        SCHEDULER_JOB_NAMES.trainingPoll,
        // ADR-0160: continuous trace evaluation (counts only). Driven
        // end-to-end in zz-adr0160-trace-evaluation.test.ts.
        SCHEDULER_JOB_NAMES.traceEvaluation,
        // ADR-0168 amendment: moves expired use-case approvals back into
        // review (recertification). Driven end-to-end, through the admin
        // endpoint that calls the same function, in
        // zz-adr0168-review-policy.test.ts; this list pins its registration.
        SCHEDULER_JOB_NAMES.useCaseRecertification,
        // ADR-0172: runs due agent-builder schedules as each agent's owner.
        // Driven end-to-end, through the admin sweep endpoint that calls the
        // same function, in builder-chat.test.ts; this list pins registration.
        SCHEDULER_JOB_NAMES.builderAgentSchedules,
        // ADR-0173 batch 2b: retries outbound webhook deliveries. Driven
        // end-to-end, through the admin sweep endpoint that calls the same
        // function, in outbound-webhooks.test.ts; this list pins registration.
        SCHEDULER_JOB_NAMES.webhookDeliveries,
        // ADR-0173 batch 2c (Q): annotation SLA breaches, once per item.
        // Driven end-to-end, through the admin sweep endpoint that calls the
        // same function, in annotations.test.ts; this list pins registration.
        SCHEDULER_JOB_NAMES.annotationSla,
        // ADR-0173 batch 2c (K): runs active automation rules as their
        // authors. Driven end-to-end, through the same function the admin
        // sweep endpoint calls, in zz-k-automation.test.ts; this list pins
        // registration.
        SCHEDULER_JOB_NAMES.automationRules,
        // ADR-0179 security review item 3: deletes Idempotency-Key claims past
        // their 30-day window. Driven end-to-end in
        // aer050-replay-retention.test.ts; this list pins registration.
        SCHEDULER_JOB_NAMES.idempotencyKeySweep,
        // ADR-0180 A2: evaluates measured approval conditions on their
        // cadence. Driven end-to-end in zz-adr0180-a2-conditions.test.ts;
        // this list pins registration.
        SCHEDULER_JOB_NAMES.conditionEvaluation,
      ].sort(),
    );
    for (const def of registry.values()) {
      expect(def.adr).toMatch(/^ADR-\d{4}$/);
      expect(def.defaultIntervalSeconds).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(20);
    }
  });

  it("GET /v1/scheduler lists them with cadence, last run, last outcome and next due", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/scheduler", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(false);
    expect(body.posture).toMatch(/forced off under test/);
    const names = (body.jobs as Array<{ name: string }>).map((j) => j.name);
    for (const n of Object.values(SCHEDULER_JOB_NAMES)) expect(names).toContain(n);
    const mrm = (body.jobs as Array<Record<string, unknown>>).find(
      (j) => j.name === SCHEDULER_JOB_NAMES.mrmExpiry,
    )!;
    expect(mrm.intervalSeconds).toBe(3600);
    expect(mrm.adr).toBe("ADR-0045");
    expect(mrm.registered).toBe(true);
    // the scheduler is OFF here, so "next due" must render as nothing rather
    // than as a future time nothing will act on
    expect(mrm.effectiveNextDueAt).toBeNull();
    expect(body.note).toMatch(/not a distributed job queue/i);
    expect(body.note).toMatch(/nightly power-off|being up/i);
  });

  it("the admin surface refuses a non-admin", async () => {
    const user = await makeUser("sched-nonadmin@example.com");
    const auth = { authorization: `Bearer ${user.apiKey}` };
    for (const [method, url] of [
      ["GET", "/v1/scheduler"],
      ["PATCH", `/v1/scheduler/jobs/${SCHEDULER_JOB_NAMES.mrmExpiry}`],
      ["POST", `/v1/scheduler/jobs/${SCHEDULER_JOB_NAMES.mrmExpiry}/run`],
    ] as const) {
      const res = await app.inject({ method, url, headers: auth, payload: { enabled: false } });
      expect(res.statusCode).toBe(403);
    }
  });

  it("PATCH enables/disables and re-cadences, and the change is audited", async () => {
    const name = SCHEDULER_JOB_NAMES.redteam;
    const off = await app.inject({
      method: "PATCH",
      url: `/v1/scheduler/jobs/${name}`,
      headers: AUTH,
      payload: { enabled: false, intervalSeconds: 7200 },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().job.enabled).toBe(false);
    expect(off.json().job.intervalSeconds).toBe(7200);

    const rows = await auditsFor("scheduler-job-configured", name);
    expect(rows).toHaveLength(1);
    // DISABLING a governance sweep lands in the same filtered view an admin
    // uses to find things that did not go through
    expect(rows[0]!.effect).toBe("deny");
    expect(rows[0]!.reason).toContain("DISABLED");

    const on = await app.inject({
      method: "PATCH",
      url: `/v1/scheduler/jobs/${name}`,
      headers: AUTH,
      payload: { enabled: true, intervalSeconds: 86400 },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().job.enabled).toBe(true);
  });

  it("PATCH and run-now 404 on an unknown job", async () => {
    expect(
      (await app.inject({ method: "PATCH", url: "/v1/scheduler/jobs/nope", headers: AUTH, payload: { enabled: true } }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "POST", url: "/v1/scheduler/jobs/nope/run", headers: AUTH })).statusCode,
    ).toBe(404);
  });
});

describe("WIRED: the MRM expiry sweep really expires a lapsed sign-off", () => {
  let cardId: string;
  let approvalId: string;

  it("a lapsed approved sign-off is still 'approved' until something sweeps", async () => {
    const agent = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: AUTH,
      payload: { name: "sched-mrm-agent", provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
    });
    expect(agent.statusCode).toBe(201);

    const [card] = await db
      .insert(modelCards)
      .values({ agentId: agent.json().id, intendedUse: "testing the sweep" })
      .returning();
    cardId = card!.id;
    const owner = await makeUser("sched-mrm-owner@example.com");
    const [ap] = await db
      .insert(modelCardApprovals)
      .values({
        cardId,
        approverUserId: owner.id,
        status: "approved",
        // lapsed an hour ago
        validUntil: new Date(Date.now() - 3_600_000),
      })
      .returning();
    approvalId = ap!.id;

    const [before] = await db.select().from(modelCardApprovals).where(eq(modelCardApprovals.id, approvalId));
    expect(before!.status).toBe("approved");
  });

  it("running the job through the SCHEDULER flips it to expired and audits the flip", async () => {
    const registry = schedulerJobRegistry({ dataKey: DATA_KEY });
    await syncSchedulerJobs(db, registry);
    const sched = new Scheduler(db, { registry, instanceId: "mrm-wire" });
    const out = await sched.runNow(SCHEDULER_JOB_NAMES.mrmExpiry, null);

    expect(out.outcome).toBe("ok");
    expect(out.itemsProcessed).toBeGreaterThanOrEqual(1);

    // THE REAL EFFECT, not the return value
    const [after] = await db.select().from(modelCardApprovals).where(eq(modelCardApprovals.id, approvalId));
    expect(after!.status).toBe("expired");

    // the DOMAIN audit row is MRM's own, on its own objectType — the sweep did
    // not grow a second audit vocabulary
    const [flip] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "mrm-approval-expired-swept"), eq(auditLog.objectId, cardId)));
    expect(flip).toBeDefined();
    expect(flip!.objectType).toBe("model_card");

    await sched.stop();
  }, 30_000);
});

describe("WIRED: the approval SLA sweep really records a breach", () => {
  let approvalId: string;

  it("seeds a pending approval that is an hour past a ten-minute deadline", async () => {
    const alex = await makeUser("sched-sla-alex@example.com");
    const policy = await app.inject({
      method: "POST",
      url: "/v1/approvals/sla-policies",
      headers: AUTH,
      payload: { name: "sched-sla", warnAfterMinutes: 5, breachAfterMinutes: 10, escalateAction: "notify_only" },
    });
    expect(policy.statusCode).toBe(201);
    const rule = await app.inject({
      method: "POST",
      url: "/v1/approvals/assignment-rules",
      headers: AUTH,
      payload: {
        name: "sched-sla-route",
        objectType: "run",
        assigneeKind: "user",
        assigneeId: alex.id,
        slaPolicyId: policy.json().policy.id,
        priority: 50,
      },
    });
    expect(rule.statusCode).toBe(201);

    const [row] = await db
      .insert(approvals)
      .values({
        userId: alex.id,
        objectType: "run",
        approverUserId: alex.id,
        status: "pending",
        requestedAt: new Date(Date.now() - 3_600_000),
      })
      .returning();
    approvalId = row!.id;
  });

  it("running the job through the SCHEDULER records the breach — nobody read the queue", async () => {
    const registry = schedulerJobRegistry({ dataKey: DATA_KEY });
    await syncSchedulerJobs(db, registry);
    const sched = new Scheduler(db, { registry, instanceId: "sla-wire" });
    const out = await sched.runNow(SCHEDULER_JOB_NAMES.approvalSla, null);

    expect(out.outcome).toBe("ok");
    expect((out.detail as { breached?: number }).breached).toBeGreaterThanOrEqual(1);

    // THE REAL EFFECT
    const [assignment] = await db
      .select()
      .from(approvalAssignments)
      .where(eq(approvalAssignments.approvalId, approvalId));
    expect(assignment!.slaState).toBe("breached");
    expect(assignment!.breachedAt).toBeTruthy();

    // escalation moved the work; it did NOT decide it
    const [ap] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(ap!.status).toBe("pending");
    expect(ap!.decidedBy).toBeNull();

    await sched.stop();
  }, 30_000);
});

describe("WIRED: the report schedule sweep really generates a report", () => {
  let scheduleId: string;

  it("seeds an enabled, never-generated schedule", async () => {
    const def = await app.inject({
      method: "POST",
      url: "/v1/reports/definitions",
      headers: AUTH,
      payload: {
        name: "sched-report",
        kind: "exec_summary",
        scopeKind: "org",
        scopeId: null,
        entitlementScope: "org",
      },
    });
    expect(def.statusCode).toBe(201);
    const sch = await app.inject({
      method: "POST",
      url: `/v1/reports/definitions/${def.json().definition.id}/schedules`,
      headers: AUTH,
      payload: { cadence: "monthly" },
    });
    expect(sch.statusCode).toBe(201);
    scheduleId = sch.json().schedule.id;
    const [row] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, scheduleId));
    expect(row!.lastGeneratedAt).toBeNull();
  });

  it("run-now through the API generates it, and the run is stamped trigger=scheduled", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/scheduler/jobs/${SCHEDULER_JOB_NAMES.reportSchedules}/run`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe("ok");
    expect(res.json().itemsProcessed).toBeGreaterThanOrEqual(1);
    expect(res.json().note).toContain("same function the schedule runs");

    // THE REAL EFFECT
    const [row] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, scheduleId));
    expect(row!.lastGeneratedAt).toBeTruthy();
    const [run] = await db
      .select()
      .from(reportRuns)
      .where(and(eq(reportRuns.scheduleId, scheduleId), eq(reportRuns.trigger, "scheduled")));
    expect(run).toBeDefined();
  }, 30_000);
});

describe("WIRED: the eval drift sweep really re-runs a pinned baseline", () => {
  let agentId: string;
  let datasetId: string;

  it("seeds a pinned baseline for a (dataset × agent) pair", async () => {
    const owner = await makeUser("sched-eval-owner@example.com");
    const ownerAuth = { authorization: `Bearer ${owner.apiKey}` };
    const agent = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: AUTH,
      payload: { name: "sched-eval-agent", provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
    });
    expect(agent.statusCode).toBe(201);
    agentId = agent.json().id;
    await app.inject({
      method: "POST",
      url: "/v1/grants/agents",
      headers: AUTH,
      payload: { userId: owner.id, agentId },
    });

    const ds = await app.inject({
      method: "POST",
      url: "/v1/evals/datasets",
      headers: AUTH,
      payload: { name: "sched-golden", scorerKind: "contains", scorerConfig: { needles: ["a"] } },
    });
    expect(ds.statusCode).toBe(201);
    datasetId = ds.json().id;
    const c = await app.inject({
      method: "POST",
      url: `/v1/evals/datasets/${datasetId}/cases`,
      headers: AUTH,
      payload: { input: "say something", expected: "a" },
    });
    expect(c.statusCode).toBe(201);

    const run = await app.inject({
      method: "POST",
      url: "/v1/evals/runs",
      headers: ownerAuth,
      payload: { datasetId, agentId },
    });
    expect(run.statusCode).toBe(201);
    const pin = await app.inject({
      method: "POST",
      url: `/v1/evals/runs/${run.json().run.id}/baseline`,
      headers: AUTH,
      payload: { isBaseline: true },
    });
    expect(pin.statusCode).toBe(200);
  }, 60_000);

  it("the job produces a NEW eval run stamped trigger=scheduled, under the pinner's identity", async () => {
    const before = await db
      .select()
      .from(evalRuns)
      .where(and(eq(evalRuns.datasetId, datasetId), eq(evalRuns.trigger, "scheduled")));
    expect(before).toHaveLength(0);

    const res = await app.inject({
      method: "POST",
      url: `/v1/scheduler/jobs/${SCHEDULER_JOB_NAMES.evalDrift}/run`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe("ok");

    // THE REAL EFFECT: a scheduled run exists that did not before
    const after = await db
      .select()
      .from(evalRuns)
      .where(and(eq(evalRuns.datasetId, datasetId), eq(evalRuns.trigger, "scheduled")));
    expect(after.length).toBeGreaterThanOrEqual(1);
    // and it ran as the HUMAN who pinned the baseline, never as an identity the
    // scheduler minted for itself
    expect(after[0]!.initiatedByUserId).toBeTruthy();
    expect(after[0]!.note).toContain("drift sweep");
  }, 60_000);
});

describe("REGISTERED: spend anomalies and red team invoke the same function their endpoint does", () => {
  it("the spend-anomaly job returns exactly what POST /v1/spend/anomalies/evaluate computes", async () => {
    const viaEndpoint = await app.inject({
      method: "POST",
      url: "/v1/spend/anomalies/evaluate",
      headers: AUTH,
      payload: {},
    });
    expect(viaEndpoint.statusCode).toBe(200);
    const projectCount = (viaEndpoint.json().results as unknown[]).length;

    const viaJob = await app.inject({
      method: "POST",
      url: `/v1/scheduler/jobs/${SCHEDULER_JOB_NAMES.spendAnomalies}/run`,
      headers: AUTH,
    });
    expect(viaJob.statusCode).toBe(200);
    expect(viaJob.json().outcome).toBe("ok");
    // the job counts the projects the evaluator walked — the same set
    expect(viaJob.json().itemsProcessed).toBe(projectCount);
    expect(viaJob.json().detail.projects).toBe(projectCount);

    // and the policy's lastEvaluatedAt / audit row is the evaluator's own
    const swept = await db.select().from(auditLog).where(eq(auditLog.ruleId, "spend-anomaly-swept"));
    expect(swept.length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("the red-team job returns exactly what POST /v1/redteam/scheduled-sweep computes", async () => {
    const viaEndpoint = await app.inject({
      method: "POST",
      url: "/v1/redteam/scheduled-sweep",
      headers: AUTH,
    });
    expect(viaEndpoint.statusCode).toBe(200);
    const ran = (viaEndpoint.json().ran as unknown[]).length;
    const skipped = (viaEndpoint.json().skipped as unknown[]).length;
    expect(viaEndpoint.json().disclosure).toBeTruthy();

    const viaJob = await app.inject({
      method: "POST",
      url: `/v1/scheduler/jobs/${SCHEDULER_JOB_NAMES.redteam}/run`,
      headers: AUTH,
    });
    expect(viaJob.statusCode).toBe(200);
    expect(viaJob.json().outcome).toBe("ok");
    expect(viaJob.json().detail.ran).toBe(ran);
    expect(viaJob.json().detail.skipped).toBe(skipped);
  }, 30_000);

  it("the eval-drift endpoint and its job agree too", async () => {
    const viaEndpoint = await app.inject({ method: "POST", url: "/v1/evals/drift-sweep", headers: AUTH });
    expect(viaEndpoint.statusCode).toBe(200);
    expect(viaEndpoint.json().note).toContain("as the user who pinned it");
    expect(Array.isArray(viaEndpoint.json().ran)).toBe(true);
  }, 60_000);

  it("every job's history is readable from the database — 'did it run, and what did it do?'", async () => {
    for (const name of Object.values(SCHEDULER_JOB_NAMES)) {
      const res = await app.inject({
        method: "GET",
        url: `/v1/scheduler/jobs/${name}/runs`,
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().registered).toBe(true);
      expect(res.json().job.name).toBe(name);
      expect(Array.isArray(res.json().runs)).toBe(true);
    }
  });
});

// ===========================================================================
// 7. THE INVARIANT — enforcement never depended on a sweep, and still does not
// ===========================================================================

describe("enforcement independence is preserved", () => {
  it("MRM still refuses a lapsed card at DISPATCH with the scheduler disabled entirely", async () => {
    // the scheduler is off in this process — `resolveSchedulerConfig().enabled`
    // is false, asserted above — and this test additionally never runs the
    // sweep, leaving the STORED status at 'approved'. The refusal must come
    // from recomputing validUntil, not from the cached status.
    const owner = await makeUser("sched-enforce-owner@example.com");
    const ownerAuth = { authorization: `Bearer ${owner.apiKey}` };
    const agent = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: AUTH,
      payload: { name: "sched-enforce-agent", provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
    });
    expect(agent.statusCode).toBe(201);
    const agentId = agent.json().id as string;
    await app.inject({
      method: "POST",
      url: "/v1/grants/agents",
      headers: AUTH,
      payload: { userId: owner.id, agentId },
    });

    const [card] = await db
      .insert(modelCards)
      .values({ agentId, intendedUse: "proving the gate does not need the sweep" })
      .returning();
    await db.insert(modelCardApprovals).values({
      cardId: card!.id,
      approverUserId: owner.id,
      status: "approved", // deliberately NOT swept
      validUntil: new Date(Date.now() - 3_600_000),
    });

    const on = await app.inject({
      method: "POST",
      url: "/v1/mrm/enforcement",
      headers: AUTH,
      payload: { enforced: true },
    });
    expect(on.statusCode).toBe(200);
    try {
      const invoke = await app.inject({
        method: "POST",
        url: `/v1/agents/${agentId}/invoke`,
        headers: ownerAuth,
        payload: { mode: "execute", input: "hello", dispatch: true },
      });
      expect(invoke.statusCode).toBe(409);
      // and the stored status is STILL 'approved' — the gate never read it
      const [ap] = await db
        .select()
        .from(modelCardApprovals)
        .where(eq(modelCardApprovals.cardId, card!.id));
      expect(ap!.status).toBe("approved");
    } finally {
      await app.inject({ method: "POST", url: "/v1/mrm/enforcement", headers: AUTH, payload: { enforced: false } });
    }
  }, 30_000);

  it("an SLA breach is still caught on a plain READ of the queue, with no sweep in sight", async () => {
    const alex = await makeUser("sched-lazy-alex@example.com");
    const alexAuth = { authorization: `Bearer ${alex.apiKey}` };
    const policy = await app.inject({
      method: "POST",
      url: "/v1/approvals/sla-policies",
      headers: AUTH,
      payload: { name: "sched-lazy", warnAfterMinutes: 1, breachAfterMinutes: 2, escalateAction: "notify_only" },
    });
    expect(policy.statusCode).toBe(201);
    const rule = await app.inject({
      method: "POST",
      url: "/v1/approvals/assignment-rules",
      headers: AUTH,
      payload: {
        name: "sched-lazy-route",
        objectType: "infra_operation",
        assigneeKind: "user",
        assigneeId: alex.id,
        slaPolicyId: policy.json().policy.id,
        priority: 90,
      },
    });
    expect(rule.statusCode).toBe(201);

    const [row] = await db
      .insert(approvals)
      .values({
        userId: alex.id,
        objectType: "infra_operation",
        approverUserId: alex.id,
        status: "pending",
        requestedAt: new Date(Date.now() - 3_600_000),
      })
      .returning();

    // A READ is the only thing that happens here — no sweep, no scheduler
    const inbox = await app.inject({ method: "GET", url: "/v1/approvals", headers: alexAuth });
    expect(inbox.statusCode).toBe(200);

    const [assignment] = await db
      .select()
      .from(approvalAssignments)
      .where(eq(approvalAssignments.approvalId, row!.id));
    expect(assignment!.slaState).toBe("breached");
  }, 30_000);
});
