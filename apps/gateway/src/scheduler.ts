/**
 * ADR-0064 — THE IN-PROCESS SCHEDULER.
 *
 * WHY THIS EXISTS. Six ADRs shipped a schedule and, in the same breath,
 * disclosed that nothing drives it:
 *
 *   ADR-0044 eval drift sweeps      ADR-0047 scheduled report generation
 *   ADR-0045 MRM expiry sweep       ADR-0049 spend forecast / anomaly
 *   ADR-0046 approval SLA breach    ADR-0057 red-team runs
 *
 * Each said, correctly, "an operator or an external cron must call this
 * endpoint". Six times. A BYOC or air-gapped install (ADR-0041, the primary
 * motion) has no cloud cron we can reach and frequently no host cron we are
 * allowed near, so "point EventBridge at it" is not an answer for this buyer.
 * In-process is the fit, for exactly the reason ADR-0040 chose in-process Cedar
 * over an OPA sidecar: one process, one artifact, no second thing to operate.
 *
 * WHAT THIS DOES NOT CHANGE, AND MUST NOT. Every one of the six sweeps was
 * built so that ENFORCEMENT NEVER DEPENDS ON THE SWEEP — `mrmDispatchGate`
 * recomputes expiry from `validUntil` on every dispatch, SLA breach is
 * evaluated when the queue is read and when an approval is decided. That is
 * the correct design and it stands. The sweeps buy TIMELINESS, not
 * correctness. Nothing here moves a control into a timer.
 *
 * THE FIVE PROPERTIES THIS MODULE IS RESPONSIBLE FOR
 * --------------------------------------------------
 *
 * 1. SAFE WITH A SECOND INSTANCE. There is one gateway today; the
 *    deployment-readiness checklist plans HA, and nobody will remember this
 *    file when that lands. So the claim is a short transaction that takes
 *    `FOR UPDATE` on the job's own row, re-checks enabled/due/lease INSIDE the
 *    lock, and writes a lease before committing. The loser blocks on the row,
 *    sees the winner's lease, and records a `skipped` run — it does not error
 *    and it does not run the body. Blocking `FOR UPDATE` rather than
 *    `SKIP LOCKED` is deliberate: the loser must be able to say WHY it did
 *    nothing, and "the row was locked" and "the job was not due" are different
 *    facts an operator needs told apart. The critical section is three
 *    statements long.
 *
 *    The lease is paired with an expiry rather than being a bare boolean,
 *    because a process SIGKILLed mid-pass would otherwise strand its job
 *    forever.
 *
 * 2. OFF BY DEFAULT, AND EXPLICITLY ON. `buildApp` does not start a timer —
 *    ~103 test files construct an app, and a scheduler that started on
 *    construction would slow all of them and make some of them flaky. The loop
 *    is started by the BOOT path (boot.ts), and only when `REGULAIT_SCHEDULER`
 *    says so. Default: OFF, in every environment. Turning this feature on
 *    changes nothing except that the sweeps now actually run, and an operator
 *    has to have decided that. Under vitest it is forced off even if the
 *    variable says otherwise, so a stray env var in CI cannot resurrect it.
 *
 * 3. A CRASHING JOB DOES NOT TAKE DOWN THE GATEWAY. Each job is run inside its
 *    own try/catch, its failure is written to its run row, to its job row and
 *    to the audit log, and the tick moves on to the next job. A throw in job A
 *    cannot stop job B on the same tick, cannot stop the next tick, and cannot
 *    reach the Fastify process.
 *
 * 4. NO OVERLAP. A job whose body outlives the tick interval does not stack:
 *    the in-process `inFlight` set refuses a second copy in the same process
 *    without a database round trip, and the lease refuses one from any other
 *    process.
 *
 * 5. CLEAN SHUTDOWN, DEFINED. `stop()` clears the interval and then AWAITS the
 *    in-flight tick to completion. It does not abort a running job. That is the
 *    deliberate choice: every job body here mutates governed state and writes
 *    audit rows, and a half-executed sweep killed at an arbitrary statement is
 *    worse than a shutdown that takes a few seconds longer. `stop()` therefore
 *    resolves only when nothing is running, and the process is then free of
 *    handles (the interval is also `unref`'d, so it never keeps a process
 *    alive on its own).
 *
 * WHAT THIS IS NOT. Not a distributed job queue. No fan-out, no retry policy,
 * no per-item durability, no work that outlives a deploy. A failed pass is
 * recorded and the next tick tries again — the right shape for a sweep, and the
 * wrong shape for anything that needs to run for hours. See the ADR.
 */
import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  auditLog,
  desc,
  eq,
  gt,
  schedulerJobs,
  schedulerRuns,
  sql,
  users,
  type Db,
  type SchedulerJobRow,
  type SchedulerRunRow,
  type SchedulerTrigger,
} from "@regulait/db";

/** the house convention for "the deployment itself acted, with no human behind
 * it" — the same all-zero id guardrails.ts and scheduler-health.ts use */
export const SCHEDULER_SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000";

/** how long a claimed lease is valid before another instance may steal it.
 * Generous relative to any sweep here; the point is only that a SIGKILLed
 * holder does not strand the job forever. */
export const DEFAULT_LEASE_SECONDS = 15 * 60;

/** how often the loop wakes. Timeliness is bounded BY THIS — a job with a
 * 60-second cadence on a 60-second tick runs somewhere in a 0–60s window after
 * it falls due, and that is the honest resolution of this design. */
export const DEFAULT_TICK_MS = 60_000;

// ---------------------------------------------------------------------------
// job definitions
// ---------------------------------------------------------------------------

export interface SchedulerJobResult {
  /** whatever the job counted — approvals evaluated, cards expired, reports
   * generated. This is the number that answers "and what did it do?". */
  itemsProcessed?: number;
  /** anything else worth keeping on the run row */
  detail?: Record<string, unknown>;
}

export interface SchedulerJobContext {
  db: Db;
  /** whose authority the pass runs under. The scheduler has no identity of its
   * own and mints no super-user: a job that needs to act as a person resolves
   * one from the data it is sweeping (see the eval-drift and red-team jobs,
   * which inherit the entitlements of whoever pinned the baseline). */
  actorUserId: string | null;
  now: Date;
  runId: string;
}

export interface SchedulerJobDefinition {
  /** stable id, used in the API, the ledger and the audit ruleId */
  name: string;
  description: string;
  /** the ADR this job discharges — for the admin screen and for whoever finds
   * this in three years */
  adr: string;
  defaultIntervalSeconds: number;
  run: (ctx: SchedulerJobContext) => Promise<SchedulerJobResult>;
}

export type SchedulerJobRegistry = ReadonlyMap<string, SchedulerJobDefinition>;

export function toRegistry(defs: readonly SchedulerJobDefinition[]): SchedulerJobRegistry {
  const map = new Map<string, SchedulerJobDefinition>();
  for (const d of defs) {
    if (map.has(d.name)) throw new Error(`duplicate scheduler job name: ${d.name}`);
    map.set(d.name, d);
  }
  return map;
}

// ---------------------------------------------------------------------------
// configuration — ON by default (ADR-0181); off only when REGULAIT_SCHEDULER says so
// ---------------------------------------------------------------------------

export interface SchedulerConfig {
  enabled: boolean;
  tickMs: number;
  leaseSeconds: number;
  /** why it is in the state it is in — printed on the boot line and returned
   * by the admin API, so "the sweeps are not running" is never a mystery */
  reason: string;
}

function truthy(v: string | undefined): boolean | null {
  if (v === undefined) return null;
  const s = v.trim().toLowerCase();
  if (["1", "on", "true", "yes", "enabled"].includes(s)) return true;
  if (["0", "off", "false", "no", "disable", "disabled"].includes(s)) return false;
  return null;
}

/**
 * Resolve the scheduler's posture from the environment.
 *
 * ON unless `REGULAIT_SCHEDULER` explicitly says off (ADR-0181, reversing the
 * ADR-0064 off-by-default). The sweeps are the controls' clock: MRM expiry,
 * approval SLAs, admission re-scans, backup verification, spend anomalies.
 * A deployment where none of them runs looks governed and is not. An operator
 * who drives the sweep endpoints from their own cron sets
 * `REGULAIT_SCHEDULER=off`, and the boot log and posture read say so.
 *
 * An unrecognised value is ON, not off: a typo must fail toward the controls
 * running, never toward them silently stopping.
 *
 * Under vitest it is forced off REGARDLESS of the variable: a stray
 * `REGULAIT_SCHEDULER=on` in a CI environment must not be able to start timers
 * underneath a 1689-test suite. Tests that need the loop construct a
 * `Scheduler` directly, which is the honest way to test a loop anyway.
 */
export function resolveSchedulerConfig(env: NodeJS.ProcessEnv = process.env): SchedulerConfig {
  const tickMs = Math.max(1_000, Number(env.REGULAIT_SCHEDULER_TICK_MS ?? DEFAULT_TICK_MS) || DEFAULT_TICK_MS);
  const leaseSeconds = Math.max(
    30,
    Number(env.REGULAIT_SCHEDULER_LEASE_SECONDS ?? DEFAULT_LEASE_SECONDS) || DEFAULT_LEASE_SECONDS,
  );
  const underTest = env.VITEST !== undefined || env.NODE_ENV === "test";
  const asked = truthy(env.REGULAIT_SCHEDULER);
  if (underTest) {
    return {
      enabled: false,
      tickMs,
      leaseSeconds,
      reason:
        "forced off under test — constructing an app never starts a timer, and a suite must not " +
        "inherit one from the environment. Drive a Scheduler directly to test the loop.",
    };
  }
  if (asked === false) {
    return {
      enabled: false,
      tickMs,
      leaseSeconds,
      reason:
        "off (REGULAIT_SCHEDULER is set to off) — the sweeps will NOT run; drive their endpoints from your own cron, " +
        "or unset it (the default is on)",
    };
  }
  return {
    enabled: true,
    tickMs,
    leaseSeconds,
    reason:
      asked === true
        ? `on (REGULAIT_SCHEDULER=${env.REGULAIT_SCHEDULER}), tick ${Math.round(tickMs / 1000)}s`
        : env.REGULAIT_SCHEDULER === undefined || env.REGULAIT_SCHEDULER.trim() === ""
          ? `on (default; REGULAIT_SCHEDULER unset), tick ${Math.round(tickMs / 1000)}s`
          : `on (REGULAIT_SCHEDULER=${JSON.stringify(env.REGULAIT_SCHEDULER)} is not a recognised value; the default is on), tick ${Math.round(tickMs / 1000)}s`,
  };
}

// ---------------------------------------------------------------------------
// definition sync
// ---------------------------------------------------------------------------

/**
 * Make the database agree with the code about which jobs exist.
 *
 * Called on boot and by the admin read path. The CODE owns name, description,
 * adr and the DEFAULT cadence; the DATABASE owns `enabled`, the effective
 * `interval_seconds` and the schedule state — so an admin's change survives a
 * restart, and a description never goes stale. A job removed from the code is
 * left in the table rather than deleted: its run history is the evidence that
 * it used to run, and silently dropping that is exactly the kind of quiet
 * erasure this product exists to prevent.
 */
export async function syncSchedulerJobs(db: Db, registry: SchedulerJobRegistry): Promise<void> {
  for (const def of registry.values()) {
    await db
      .insert(schedulerJobs)
      .values({
        name: def.name,
        description: def.description,
        adr: def.adr,
        intervalSeconds: def.defaultIntervalSeconds,
      })
      .onConflictDoUpdate({
        target: schedulerJobs.name,
        set: { description: def.description, adr: def.adr, updatedAt: new Date() },
      });
  }
}

// ---------------------------------------------------------------------------
// the claim — this is the lock
// ---------------------------------------------------------------------------

export type ClaimResult =
  | { claimed: true; job: SchedulerJobRow; run: SchedulerRunRow }
  | { claimed: false; reason: string; run: SchedulerRunRow | null };

export interface ClaimOptions {
  instanceId: string;
  trigger: SchedulerTrigger;
  actorUserId?: string | null;
  now?: Date;
  leaseSeconds?: number;
  /** `manual` runs ignore `next_due_at` (a human pressing "run now" means now)
   * but NEVER ignore the lease — a manual run must not be able to race a
   * scheduled pass of the same job. */
  ignoreDue?: boolean;
  /** a disabled job still runs on an explicit "run now"; the tick loop does not
   * pass this */
  ignoreEnabled?: boolean;
}

/**
 * Try to become the one process running `jobName`.
 *
 * The whole critical section is inside ONE transaction and is three statements
 * long: lock the row, decide, write the lease. Everything expensive — the job
 * body itself — happens after this has committed, holding only the lease.
 *
 * Returns `claimed: false` with a reason (and, for a lease conflict, a
 * `skipped` ledger row) rather than throwing. A loser is a fact to record, not
 * an error to raise.
 */
export async function claimJob(db: Db, jobName: string, opts: ClaimOptions): Promise<ClaimResult> {
  const now = opts.now ?? new Date();
  const leaseSeconds = opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS;

  return db.transaction(async (tx) => {
    // 1. Lock the job's own row. A second instance blocks HERE until we commit,
    //    then reads the lease we wrote and skips. Blocking rather than
    //    SKIP LOCKED so the loser can say why it did nothing.
    const [locked] = (await tx
      .select()
      .from(schedulerJobs)
      .where(eq(schedulerJobs.name, jobName))
      .for("update")) as SchedulerJobRow[];

    if (!locked) return { claimed: false as const, reason: "unknown_job", run: null };

    if (!opts.ignoreEnabled && !locked.enabled) {
      return { claimed: false as const, reason: "job_disabled", run: null };
    }

    const leaseLive =
      locked.running && locked.leaseExpiresAt !== null && locked.leaseExpiresAt.getTime() > now.getTime();
    if (leaseLive) {
      // Someone else is running it RIGHT NOW. This is the two-instances case,
      // and it is recorded rather than swallowed: "the other box ran it" and
      // "nothing ran it" must not look the same in the ledger.
      const [skipped] = await tx
        .insert(schedulerRuns)
        .values({
          jobName,
          trigger: opts.trigger,
          instanceId: opts.instanceId,
          initiatedByUserId: opts.actorUserId ?? null,
          startedAt: now,
          finishedAt: now,
          durationMs: 0,
          outcome: "skipped",
          itemsProcessed: 0,
          detail: {
            reason: "lease_held",
            heldBy: locked.leaseOwner,
            leaseExpiresAt: locked.leaseExpiresAt?.toISOString() ?? null,
          },
        })
        .returning();
      return { claimed: false as const, reason: "lease_held", run: skipped ?? null };
    }

    if (!opts.ignoreDue && locked.nextDueAt.getTime() > now.getTime()) {
      return { claimed: false as const, reason: "not_due", run: null };
    }

    // 2. Open the ledger row FIRST, so a process that dies between here and the
    //    job body leaves a row stuck at `running` — which is the diagnosis.
    const [run] = await tx
      .insert(schedulerRuns)
      .values({
        jobName,
        trigger: opts.trigger,
        instanceId: opts.instanceId,
        initiatedByUserId: opts.actorUserId ?? null,
        startedAt: now,
        outcome: "running",
      })
      .returning();

    // 3. Take the lease.
    const [job] = await tx
      .update(schedulerJobs)
      .set({
        running: true,
        leaseOwner: opts.instanceId,
        leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1000),
        lastRunAt: now,
        updatedAt: now,
      })
      .where(eq(schedulerJobs.name, jobName))
      .returning();

    return { claimed: true as const, job: job!, run: run! };
  });
}

/** Release the lease and write the verdict. Never throws on a well-formed
 * call; the caller is already inside a failure path when it uses the `failed`
 * branch and must not be handed a second exception. */
async function releaseJob(
  db: Db,
  jobName: string,
  runId: string,
  outcome: "ok" | "failed",
  opts: { startedAt: Date; itemsProcessed: number; detail: Record<string, unknown>; error: string | null },
): Promise<void> {
  const finishedAt = new Date();
  const durationMs = Math.max(0, finishedAt.getTime() - opts.startedAt.getTime());

  await db
    .update(schedulerRuns)
    .set({
      finishedAt,
      durationMs,
      outcome,
      itemsProcessed: opts.itemsProcessed,
      detail: opts.detail,
      error: opts.error,
    })
    .where(eq(schedulerRuns.id, runId));

  const [current] = await db.select().from(schedulerJobs).where(eq(schedulerJobs.name, jobName));
  const intervalSeconds = current?.intervalSeconds ?? 3600;

  await db
    .update(schedulerJobs)
    .set({
      running: false,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastFinishedAt: finishedAt,
      lastOutcome: outcome,
      lastError: opts.error,
      lastItemsProcessed: opts.itemsProcessed,
      lastDurationMs: durationMs,
      // The next window opens from the moment this pass FINISHED, not from when
      // it started: a job that takes longer than its own cadence must not
      // become instantly due again and monopolise every tick.
      nextDueAt: new Date(finishedAt.getTime() + intervalSeconds * 1000),
      runs: sql`${schedulerJobs.runs} + 1`,
      failures: outcome === "failed" ? sql`${schedulerJobs.failures} + 1` : sql`${schedulerJobs.failures}`,
      consecutiveFailures:
        outcome === "failed" ? sql`${schedulerJobs.consecutiveFailures} + 1` : sql`0`,
      updatedAt: finishedAt,
    })
    .where(eq(schedulerJobs.name, jobName));
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

/** an admin to attribute a system act to, or the all-zero id when the
 * deployment has none. Never throws — an audit helper that can fail is a
 * failure path that can mask the failure it was written to report. */
async function schedulerActor(db: Db, preferred: string | null): Promise<string> {
  if (preferred) return preferred;
  try {
    // ADR-0107 (F01): see scheduler-health.ts — oldest admin, deterministically.
    const [admin] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isAdmin, true))
      .orderBy(asc(users.createdAt), asc(users.id))
      .limit(1);
    return admin?.id ?? SCHEDULER_SYSTEM_ACTOR;
  } catch {
    return SCHEDULER_SYSTEM_ACTOR;
  }
}

/**
 * Audit one scheduler event into THE audit log — the same table every governed
 * act in this product lands in. Best-effort and never throwing: if the database
 * is what broke, this write fails too, and it must not be able to mask the
 * console line or the run row.
 *
 * The ruleIds are stable: `scheduler-job-started`, `scheduler-job-succeeded`,
 * `scheduler-job-failed`, `scheduler-job-skipped`, plus
 * `scheduler-job-configured` for an admin change.
 */
export async function auditSchedulerEvent(
  db: Db,
  ev: {
    ruleId: string;
    jobName: string;
    runId: string | null;
    actorUserId: string | null;
    effect: "allow" | "deny";
    reason: string;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      userId: await schedulerActor(db, ev.actorUserId),
      objectType: "scheduler_job",
      objectId: ev.runId,
      detail: { job: ev.jobName, ...ev.detail },
      effect: ev.effect,
      ruleId: ev.ruleId,
      ruleChain: [],
      reason: ev.reason,
    });
  } catch (err) {
    console.error(
      `[regulait] could not audit scheduler event ${ev.ruleId} for '${ev.jobName}': ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// running one job
// ---------------------------------------------------------------------------

export interface JobRunOutcome {
  job: string;
  outcome: "ok" | "failed" | "skipped";
  reason?: string;
  runId: string | null;
  itemsProcessed: number;
  durationMs: number | null;
  error?: string;
  detail?: Record<string, unknown>;
}

export interface RunJobOptions {
  instanceId: string;
  trigger: SchedulerTrigger;
  actorUserId?: string | null;
  now?: Date;
  leaseSeconds?: number;
  ignoreDue?: boolean;
  ignoreEnabled?: boolean;
}

/**
 * Claim, run, record, release — for exactly one job.
 *
 * THE ONE FUNCTION BOTH PATHS USE. The tick loop calls it and so does the admin
 * "run now" endpoint, which is what makes "run now runs the same thing the
 * schedule runs" true by construction rather than by review.
 *
 * NEVER THROWS. A job that throws is caught here, its error is written to its
 * run row and its job row, an audit row is emitted, and the caller gets an
 * outcome object. This is the property that keeps a bad job from taking the
 * gateway — or the next job on the same tick — down with it.
 */
export async function runSchedulerJob(
  db: Db,
  def: SchedulerJobDefinition,
  opts: RunJobOptions,
): Promise<JobRunOutcome> {
  const now = opts.now ?? new Date();
  const claim = await claimJob(db, def.name, {
    instanceId: opts.instanceId,
    trigger: opts.trigger,
    actorUserId: opts.actorUserId ?? null,
    now,
    ...(opts.leaseSeconds !== undefined ? { leaseSeconds: opts.leaseSeconds } : {}),
    ...(opts.ignoreDue !== undefined ? { ignoreDue: opts.ignoreDue } : {}),
    ...(opts.ignoreEnabled !== undefined ? { ignoreEnabled: opts.ignoreEnabled } : {}),
  });

  if (!claim.claimed) {
    if (claim.reason === "lease_held") {
      await auditSchedulerEvent(db, {
        ruleId: "scheduler-job-skipped",
        jobName: def.name,
        runId: claim.run?.id ?? null,
        actorUserId: opts.actorUserId ?? null,
        effect: "deny",
        reason:
          `scheduled job '${def.name}' was skipped: another instance holds the lease. ` +
          `The job still ran — elsewhere — which is why this is recorded as a skip and not a failure.`,
        detail: { phase: "claim", reason: claim.reason, instanceId: opts.instanceId },
      });
    }
    return {
      job: def.name,
      outcome: "skipped",
      reason: claim.reason,
      runId: claim.run?.id ?? null,
      itemsProcessed: 0,
      durationMs: 0,
    };
  }

  const { run } = claim;
  await auditSchedulerEvent(db, {
    ruleId: "scheduler-job-started",
    jobName: def.name,
    runId: run.id,
    actorUserId: opts.actorUserId ?? null,
    effect: "allow",
    reason: `scheduled job '${def.name}' started (${opts.trigger}) — ${def.adr}`,
    detail: { phase: "start", trigger: opts.trigger, instanceId: opts.instanceId },
  });

  try {
    const result = await def.run({
      db,
      actorUserId: opts.actorUserId ?? null,
      now,
      runId: run.id,
    });
    const items = result.itemsProcessed ?? 0;
    const detail = result.detail ?? {};
    await releaseJob(db, def.name, run.id, "ok", {
      startedAt: run.startedAt,
      itemsProcessed: items,
      detail,
      error: null,
    });
    await auditSchedulerEvent(db, {
      ruleId: "scheduler-job-succeeded",
      jobName: def.name,
      runId: run.id,
      actorUserId: opts.actorUserId ?? null,
      effect: "allow",
      reason: `scheduled job '${def.name}' completed — ${items} item(s) processed`,
      detail: { phase: "finish", outcome: "ok", itemsProcessed: items, ...detail },
    });
    return {
      job: def.name,
      outcome: "ok",
      runId: run.id,
      itemsProcessed: items,
      durationMs: Date.now() - run.startedAt.getTime(),
      detail,
    };
  } catch (err) {
    const message = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 2000);
    // The console line ALWAYS happens and happens first — it is the signal most
    // likely to survive whatever broke (see scheduler-health.ts for the same
    // ordering argument).
    console.error(`[regulait] scheduled job '${def.name}' FAILED: ${message}`);
    try {
      await releaseJob(db, def.name, run.id, "failed", {
        startedAt: run.startedAt,
        itemsProcessed: 0,
        detail: {},
        error: message,
      });
    } catch (releaseErr) {
      // The lease will expire on its own; a failure to record must not become a
      // second exception thrown at the tick loop.
      console.error(
        `[regulait] could not record the failure of '${def.name}' (its lease expires on its own): ` +
          `${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`,
      );
    }
    await auditSchedulerEvent(db, {
      ruleId: "scheduler-job-failed",
      jobName: def.name,
      runId: run.id,
      actorUserId: opts.actorUserId ?? null,
      effect: "deny",
      reason: `scheduled job '${def.name}' FAILED: ${message}`,
      detail: { phase: "finish", outcome: "failed", error: message },
    });
    return {
      job: def.name,
      outcome: "failed",
      runId: run.id,
      itemsProcessed: 0,
      durationMs: Date.now() - run.startedAt.getTime(),
      error: message,
    };
  }
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

export interface SchedulerOptions {
  registry: SchedulerJobRegistry;
  tickMs?: number;
  leaseSeconds?: number;
  /** identifies this process in the ledger. Defaults to a per-construction
   * uuid, which is exactly right: two instances must differ. */
  instanceId?: string;
  /** injected in tests so a tick can be driven at an arbitrary instant */
  now?: () => Date;
}

export interface TickSummary {
  at: string;
  results: JobRunOutcome[];
}

export class Scheduler {
  readonly instanceId: string;
  readonly tickMs: number;
  readonly leaseSeconds: number;
  private readonly db: Db;
  private readonly registry: SchedulerJobRegistry;
  private readonly clock: () => Date;
  private timer: NodeJS.Timeout | null = null;
  /** in-process overlap guard. The lease already stops a second PROCESS; this
   * stops a second copy in THIS process without a database round trip, which is
   * what makes "a slow job does not stack on itself" deterministic rather than
   * a race against the claim. */
  private readonly inFlight = new Set<string>();
  private currentTick: Promise<TickSummary> | null = null;
  private stopped = false;

  constructor(db: Db, opts: SchedulerOptions) {
    this.db = db;
    this.registry = opts.registry;
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.leaseSeconds = opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    this.instanceId = opts.instanceId ?? randomUUID();
    this.clock = opts.now ?? (() => new Date());
  }

  /** true while a tick is in progress — used by tests and by `stop()` */
  get busy(): boolean {
    return this.currentTick !== null;
  }

  /** which jobs this process currently has bodies executing for */
  get running(): string[] {
    return [...this.inFlight];
  }

  /** test seam: is an interval still registered? `stop()` must leave this
   * false, otherwise "clean shutdown" is a claim rather than a fact. */
  get timerActive(): boolean {
    return this.timer !== null;
  }

  /** test seam: would the interval keep the process alive? It must not —
   * `start()` unrefs it, so a forgotten scheduler can never be the reason a
   * node process refuses to exit. */
  get timerKeepsProcessAlive(): boolean {
    return this.timer?.hasRef?.() ?? false;
  }

  /**
   * ONE PASS OVER EVERY REGISTERED JOB.
   *
   * Sequential on purpose. These are database sweeps on a single-tenant install;
   * running six of them concurrently buys nothing and makes a slow one able to
   * starve the pool. Each is isolated: a throw inside `runSchedulerJob` is
   * already caught there, and the extra try/catch here is the belt for the
   * braces — nothing a job does can prevent the next job from being attempted.
   */
  async tick(): Promise<TickSummary> {
    const at = this.clock();
    const results: JobRunOutcome[] = [];
    for (const def of this.registry.values()) {
      if (this.stopped) break;
      if (this.inFlight.has(def.name)) {
        // Overlap: the previous pass of THIS job, in THIS process, has not
        // finished. Recorded as a skip so a chronically slow job is visible.
        results.push({
          job: def.name,
          outcome: "skipped",
          reason: "already_running_in_process",
          runId: null,
          itemsProcessed: 0,
          durationMs: 0,
        });
        continue;
      }
      this.inFlight.add(def.name);
      try {
        results.push(
          await runSchedulerJob(this.db, def, {
            instanceId: this.instanceId,
            trigger: "schedule",
            now: at,
            leaseSeconds: this.leaseSeconds,
          }),
        );
      } catch (err) {
        // runSchedulerJob does not throw. If it somehow did — a database that
        // refuses the claim transaction, say — the tick still continues.
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        console.error(`[regulait] scheduler tick could not attempt '${def.name}': ${message}`);
        results.push({
          job: def.name,
          outcome: "failed",
          runId: null,
          itemsProcessed: 0,
          durationMs: null,
          error: message,
        });
      } finally {
        this.inFlight.delete(def.name);
      }
    }
    return { at: at.toISOString(), results };
  }

  /** the tick the interval fires: never overlaps itself, never rejects */
  private async safeTick(): Promise<TickSummary> {
    if (this.currentTick) return this.currentTick;
    const p = this.tick()
      .catch((err: unknown) => {
        console.error(
          `[regulait] scheduler tick failed outright: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { at: new Date().toISOString(), results: [] } satisfies TickSummary;
      })
      .finally(() => {
        this.currentTick = null;
      });
    this.currentTick = p;
    return p;
  }

  /** Start the loop. Idempotent. The interval is `unref`'d so it can never be
   * the reason a process stays alive. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.safeTick(), this.tickMs);
    this.timer.unref?.();
  }

  /**
   * SHUTDOWN SEMANTICS, stated: the loop stops immediately and an in-flight
   * tick is AWAITED, not aborted. A sweep mid-pass is mutating governed state
   * and writing audit rows; a shutdown that takes a few extra seconds is
   * strictly better than one that leaves a half-executed sweep. `stop()`
   * resolves only when nothing is running, and no timer survives it.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.currentTick) await this.currentTick.catch(() => undefined);
  }

  /** "run now" — the same claim, the same body, the same ledger. Ignores the
   * cadence and the enabled flag (a human asked), never the lease. */
  async runNow(jobName: string, actorUserId: string | null): Promise<JobRunOutcome> {
    const def = this.registry.get(jobName);
    if (!def) return { job: jobName, outcome: "skipped", reason: "unknown_job", runId: null, itemsProcessed: 0, durationMs: 0 };
    if (this.inFlight.has(jobName)) {
      return { job: jobName, outcome: "skipped", reason: "already_running_in_process", runId: null, itemsProcessed: 0, durationMs: 0 };
    }
    this.inFlight.add(jobName);
    try {
      return await runSchedulerJob(this.db, def, {
        instanceId: this.instanceId,
        trigger: "manual",
        actorUserId,
        leaseSeconds: this.leaseSeconds,
        ignoreDue: true,
        ignoreEnabled: true,
      });
    } finally {
      this.inFlight.delete(jobName);
    }
  }
}

// ---------------------------------------------------------------------------
// reads for the admin surface
// ---------------------------------------------------------------------------

export interface SchedulerJobView extends SchedulerJobRow {
  /** true if the job is registered in the CODE of the running gateway. A row
   * whose job was removed from the code stays in the table (its history is
   * evidence) and is flagged here rather than silently listed as live. */
  registered: boolean;
  /** null when the scheduler is off — because then it is not due at any time,
   * and rendering a future timestamp would be a lie */
  effectiveNextDueAt: string | null;
  recentRuns: SchedulerRunRow[];
}

export async function listSchedulerJobs(
  db: Db,
  registry: SchedulerJobRegistry,
  config: SchedulerConfig,
  opts: { recentPerJob?: number } = {},
): Promise<SchedulerJobView[]> {
  const perJob = opts.recentPerJob ?? 5;
  const rows = await db.select().from(schedulerJobs).orderBy(schedulerJobs.name);
  const out: SchedulerJobView[] = [];
  for (const row of rows) {
    const recentRuns = await db
      .select()
      .from(schedulerRuns)
      .where(eq(schedulerRuns.jobName, row.name))
      .orderBy(desc(schedulerRuns.startedAt))
      .limit(perJob);
    out.push({
      ...row,
      registered: registry.has(row.name),
      effectiveNextDueAt: config.enabled && row.enabled ? row.nextDueAt.toISOString() : null,
      recentRuns,
    });
  }
  return out;
}

/** a run left at `running` with a start older than the lease is a process that
 * died mid-pass. Surfaced so the admin screen can say so out loud. */
export async function findStuckRuns(db: Db, leaseSeconds: number, now: Date = new Date()): Promise<SchedulerRunRow[]> {
  const cutoff = new Date(now.getTime() - leaseSeconds * 1000);
  return db
    .select()
    .from(schedulerRuns)
    .where(and(eq(schedulerRuns.outcome, "running"), gt(sql`${cutoff}`, schedulerRuns.startedAt)))
    .orderBy(desc(schedulerRuns.startedAt))
    .limit(50);
}
