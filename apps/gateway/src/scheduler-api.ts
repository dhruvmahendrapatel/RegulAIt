/**
 * ADR-0064 — the scheduler's OPERATOR SURFACE.
 *
 * Admin-only through the default gate (nothing here appears in
 * NON_ADMIN_ROUTES): enabling a background loop that sweeps every project's
 * spend, re-probes every agent and generates every org-wide report is operator
 * authority, and "run now" on the eval-drift job spends money.
 *
 * The five routes answer the five questions an operator actually has:
 *
 *   GET  /v1/scheduler                     is it on, and what is each job's
 *                                          cadence / last run / next due?
 *   GET  /v1/scheduler/jobs/:name/runs     did the MRM sweep run last night,
 *                                          and what did it do?
 *   PATCH /v1/scheduler/jobs/:name         turn one job off, or change its
 *                                          cadence, without a deploy
 *   POST /v1/scheduler/jobs/:name/run      run it now
 *
 * "Run now" goes through `runSchedulerJob` — the SAME function the tick loop
 * calls, taking the SAME lease. So a manual run cannot race a scheduled one,
 * and it cannot execute anything the schedule would not have executed. That is
 * a property of the code path, not of a comment.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  desc,
  eq,
  schedulerJobs,
  schedulerRuns,
  type Db,
} from "@regulait/db";
import {
  auditSchedulerEvent,
  findStuckRuns,
  listSchedulerJobs,
  resolveSchedulerConfig,
  runSchedulerJob,
  syncSchedulerJobs,
  type SchedulerJobRegistry,
} from "./scheduler.js";

const nameParam = z.object({ name: z.string().min(1).max(120) });

const patchJobSchema = z
  .object({
    enabled: z.boolean().optional(),
    intervalSeconds: z.number().int().min(60).max(30 * 24 * 3600).optional(),
  })
  .refine((v) => v.enabled !== undefined || v.intervalSeconds !== undefined, {
    message: "nothing to change",
  });

export interface SchedulerRouteOptions {
  registry: SchedulerJobRegistry;
  /** the live loop, when this process is running one. Absent in every test that
   * merely constructs an app — which is exactly the state the ADR requires. */
  instanceId?: string;
  env?: NodeJS.ProcessEnv;
}

export function registerSchedulerRoutes(app: FastifyInstance, db: Db, opts: SchedulerRouteOptions): void {
  const config = () => resolveSchedulerConfig(opts.env ?? process.env);

  /**
   * The posture + every job. The `enabled` flag and the posture STRING are both
   * returned because "the scheduler is off" is the single most likely reason a
   * sweep has not run, and an operator must not have to infer it from a screen
   * full of null timestamps.
   */
  app.get("/v1/scheduler", async () => {
    const cfg = config();
    // Sync on read as well as on boot: a gateway that has never been started
    // with the scheduler on still shows the operator what WOULD run.
    await syncSchedulerJobs(db, opts.registry);
    const jobs = await listSchedulerJobs(db, opts.registry, cfg);
    const stuck = await findStuckRuns(db, cfg.leaseSeconds);
    return {
      enabled: cfg.enabled,
      posture: cfg.reason,
      tickMs: cfg.tickMs,
      leaseSeconds: cfg.leaseSeconds,
      instanceId: opts.instanceId ?? null,
      jobs,
      stuckRuns: stuck,
      note:
        "The scheduler is ON unless REGULAIT_SCHEDULER=off (ADR-0181). It exists so a BYOC or air-gapped install " +
        "does not need a cron we cannot reach; it is NOT a distributed job queue, and a job that needs " +
        "to outlive a deploy or run for hours does not belong here. Timeliness is bounded by the tick " +
        "interval AND by this box being up — a sweep scheduled inside a nightly power-off window simply " +
        "does not run, and the next tick after power-on picks it up late. Every sweep is designed so " +
        "enforcement never depends on it: MRM recomputes expiry at dispatch, SLA breach is caught on " +
        "read and on decide. These jobs buy timeliness, not correctness.",
    };
  });

  /** one job's history — the ledger that answers "and what did it do?" */
  app.get("/v1/scheduler/jobs/:name/runs", async (req, reply) => {
    const { name } = nameParam.parse(req.params);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query ?? {});
    const [job] = await db.select().from(schedulerJobs).where(eq(schedulerJobs.name, name));
    if (!job) return reply.status(404).send({ error: "unknown_scheduler_job" });
    const runs = await db
      .select()
      .from(schedulerRuns)
      .where(eq(schedulerRuns.jobName, name))
      .orderBy(desc(schedulerRuns.startedAt))
      .limit(q.limit);
    return { job, runs, registered: opts.registry.has(name) };
  });

  /** enable/disable, or re-cadence. Audited — turning a governance sweep off is
   * a governed act, and the reason somebody stopped noticing breaches must be
   * findable. */
  app.patch("/v1/scheduler/jobs/:name", async (req, reply) => {
    const { name } = nameParam.parse(req.params);
    const body = patchJobSchema.parse(req.body ?? {});
    const [before] = await db.select().from(schedulerJobs).where(eq(schedulerJobs.name, name));
    if (!before) return reply.status(404).send({ error: "unknown_scheduler_job" });

    const [after] = await db
      .update(schedulerJobs)
      .set({
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.intervalSeconds !== undefined ? { intervalSeconds: body.intervalSeconds } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schedulerJobs.name, name))
      .returning();

    const changes: string[] = [];
    if (body.enabled !== undefined && body.enabled !== before.enabled) {
      changes.push(body.enabled ? "enabled" : "DISABLED");
    }
    if (body.intervalSeconds !== undefined && body.intervalSeconds !== before.intervalSeconds) {
      changes.push(`cadence ${before.intervalSeconds}s -> ${body.intervalSeconds}s`);
    }
    await auditSchedulerEvent(db, {
      ruleId: "scheduler-job-configured",
      jobName: name,
      runId: null,
      actorUserId: req.authCtx.userId ?? null,
      // a DISABLE is the change that stops something from being noticed, so it
      // lands in the same filtered view an admin uses to find things that did
      // not go through
      effect: body.enabled === false ? "deny" : "allow",
      reason:
        changes.length > 0
          ? `admin changed scheduled job '${name}': ${changes.join(", ")}`
          : `admin re-saved scheduled job '${name}' with no effective change`,
      detail: {
        phase: "configure",
        before: { enabled: before.enabled, intervalSeconds: before.intervalSeconds },
        after: { enabled: after!.enabled, intervalSeconds: after!.intervalSeconds },
      },
    });
    return { job: after };
  });

  /**
   * RUN NOW. Ignores the cadence and the enabled flag — a human asked — but
   * never the lease: if another instance (or this one's tick) is mid-pass, this
   * records a `skipped` run rather than starting a second copy.
   */
  app.post("/v1/scheduler/jobs/:name/run", async (req, reply) => {
    const { name } = nameParam.parse(req.params);
    const def = opts.registry.get(name);
    if (!def) return reply.status(404).send({ error: "unknown_scheduler_job" });
    await syncSchedulerJobs(db, opts.registry);
    const cfg = config();
    const outcome = await runSchedulerJob(db, def, {
      instanceId: opts.instanceId ?? `api:${req.authCtx.userId ?? "bootstrap"}`,
      trigger: "manual",
      actorUserId: req.authCtx.userId ?? null,
      leaseSeconds: cfg.leaseSeconds,
      ignoreDue: true,
      ignoreEnabled: true,
    });
    // A job that threw is a 200 carrying `outcome: 'failed'`, not a 500: the
    // REQUEST succeeded — it ran the job and recorded what happened. Turning a
    // recorded failure into an HTTP error would lose the run id the operator
    // needs to go look at.
    return { ...outcome, note: "This ran the same function the schedule runs, under the same lease." };
  });
}
