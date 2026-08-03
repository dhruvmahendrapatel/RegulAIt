/**
 * ADR-0064 — THE SIX JOBS.
 *
 * This file is deliberately thin, and that is the whole point of it. Every
 * entry here CALLS the function the corresponding endpoint already calls.
 * Nothing below reimplements a sweep, computes a verdict, decides an expiry or
 * writes a domain audit row — if a job body here started doing any of that,
 * there would be two implementations of the same control and they would drift,
 * and the drift would be discovered by whoever was relying on the one that was
 * wrong.
 *
 * Four of the six needed their logic extracted out of a Fastify handler first
 * (`runApprovalSlaSweep`, `runDueReportSchedules`, `runSpendAnomalyEvaluation`,
 * plus the two sweep drivers `runEvalDriftSweep` / `runScheduledRedTeamSweep`).
 * The endpoints still exist and now call those same functions, so a manual run
 * and a scheduled run are the same code path by construction rather than by
 * review.
 *
 * ON CADENCE. These are DEFAULTS, written to the `scheduler_jobs` row the first
 * time a job is registered; after that the DATABASE owns the interval and an
 * admin can change it without a deploy. They are conservative on purpose — a
 * governance sweep that runs every minute is a way to spend money and generate
 * noise, not a way to be more compliant.
 *
 * ON AUTHORITY. The scheduler has NO identity. It never mints an admin and
 * never runs as one. Jobs that only reconcile stored state (MRM expiry, SLA
 * evaluation) run with a null actor and audit as the deployment itself; jobs
 * that DISPATCH A MODEL (eval drift, red-team) inherit the entitlements of the
 * specific human who pinned the baseline or last ran the probe, and skip with a
 * stated reason when that human is gone. That asymmetry is deliberate: nothing
 * a timer does should be able to reach a model the initiating user could not.
 */
import type { Db } from "@regulait/db";
import { runMrmExpirySweep } from "./mrm.js";
import { runApprovalSlaSweep } from "./workbench.js";
import { runDueReportSchedules } from "./reporting.js";
import { runSpendAnomalyEvaluation } from "./spend-monitor.js";
import { runEvalDriftSweep } from "./evals.js";
import { runScheduledRedTeamSweep } from "./redteam.js";
import { toRegistry, type SchedulerJobDefinition, type SchedulerJobRegistry } from "./scheduler.js";

const HOUR = 3600;
const DAY = 24 * HOUR;

export interface SchedulerJobsOptions {
  /** needed by the two jobs that DISPATCH (eval drift, red-team): the same
   * envelope key every other dispatch path takes */
  dataKey?: string | undefined;
}

/** stable job ids. Exported because tests, the API and the SPA all name them,
 * and a typo in a string literal is a silently-never-runs bug. */
export const SCHEDULER_JOB_NAMES = {
  mrmExpiry: "mrm-expiry-sweep",
  approvalSla: "approval-sla-sweep",
  reportSchedules: "report-schedule-sweep",
  spendAnomalies: "spend-anomaly-sweep",
  evalDrift: "eval-drift-sweep",
  redteam: "redteam-sweep",
} as const;

export function schedulerJobDefinitions(opts: SchedulerJobsOptions = {}): SchedulerJobDefinition[] {
  return [
    {
      // ADR-0045. Flips lapsed `approved` sign-offs to `expired` so the
      // registry screen and any status filter are truthful. NOT a control —
      // `mrmDispatchGate` recomputes expiry from `validUntil` on every dispatch
      // whether or not this has ever run.
      name: SCHEDULER_JOB_NAMES.mrmExpiry,
      description:
        "Mark lapsed model-card sign-offs as expired so the registry reads true. Enforcement does not " +
        "depend on it: dispatch recomputes expiry from validUntil on every call.",
      adr: "ADR-0045",
      defaultIntervalSeconds: HOUR,
      run: async (ctx) => {
        const out = await runMrmExpirySweep(ctx.db, { actorUserId: ctx.actorUserId, now: ctx.now });
        return { itemsProcessed: out.expired, detail: { expired: out.expired, ids: out.ids } };
      },
    },
    {
      // ADR-0046. Evaluates every pending approval's SLA. Also NOT a control —
      // breach is caught on queue read and on decide, and the deadlines are a
      // pure function of requested_at.
      name: SCHEDULER_JOB_NAMES.approvalSla,
      description:
        "Evaluate the SLA clock on every pending approval so a breach is noticed before somebody happens " +
        "to open the queue. Breach is also caught lazily on read and on decide.",
      adr: "ADR-0046",
      defaultIntervalSeconds: 15 * 60,
      run: async (ctx) => {
        const out = await runApprovalSlaSweep(ctx.db, {
          actorUserId: ctx.actorUserId,
          now: ctx.now,
        });
        return {
          itemsProcessed: out.evaluated,
          detail: { evaluated: out.evaluated, breached: out.breached, warned: out.warned },
        };
      },
    },
    {
      // ADR-0047. Generates the scheduled reports whose cadence has come due.
      name: SCHEDULER_JOB_NAMES.reportSchedules,
      description:
        "Generate every report schedule whose cadence has come due. Recipients are recorded, never " +
        "mailed — nothing is delivered anywhere.",
      adr: "ADR-0047",
      defaultIntervalSeconds: HOUR,
      run: async (ctx) => {
        const out = await runDueReportSchedules(ctx.db, {
          actorUserId: ctx.actorUserId,
          now: ctx.now,
        });
        return {
          itemsProcessed: out.generated.length,
          detail: { generated: out.generated.length, skipped: out.skipped.length },
        };
      },
    },
    {
      // ADR-0049. Evaluates every project's spend policy against the measured
      // ledger. Idempotent by DATA (the unique index on the anomaly window), so
      // running it on a timer and by hand cannot double-raise.
      name: SCHEDULER_JOB_NAMES.spendAnomalies,
      description:
        "Evaluate every project's spend-anomaly policy against the usage_events ledger and escalate what " +
        "fires onto the ordinary Approvals Queue. Spend figures are list-price estimates.",
      adr: "ADR-0049",
      defaultIntervalSeconds: HOUR,
      run: async (ctx) => {
        const out = await runSpendAnomalyEvaluation(ctx.db, {
          actorUserId: ctx.actorUserId,
          now: ctx.now,
        });
        const fired = out.results.flatMap((r) => r.verdicts.filter((v) => v.fired)).length;
        return {
          itemsProcessed: out.results.length,
          detail: { projects: out.results.length, fired },
        };
      },
    },
    {
      // ADR-0044 §5 — the part of that ADR that did not ship, because there was
      // no scheduler to ship it against. DISPATCHES: runs as the user who
      // pinned each baseline, never as an identity of its own.
      //
      // Daily by default and deliberately so: every pass of this job spends
      // real model tokens on every pinned pair.
      name: SCHEDULER_JOB_NAMES.evalDrift,
      description:
        "Re-run every pinned eval baseline (dataset version × agent) to detect drift, as the user who " +
        "pinned it. Spends model tokens on every pass — hence the daily default.",
      adr: "ADR-0044",
      defaultIntervalSeconds: DAY,
      run: async (ctx) => {
        const out = await runEvalDriftSweep(ctx.db, opts.dataKey);
        return {
          itemsProcessed: out.ran.length,
          detail: {
            ran: out.ran.length,
            regressions: out.ran.filter((r) => r.regression).length,
            skipped: out.skipped.length,
          },
        };
      },
    },
    {
      // ADR-0057 — what "continuous" red teaming was always supposed to mean.
      // DISPATCHES adversarial prompts, so it too inherits a named human's
      // entitlements and only re-probes pairs a human already chose.
      name: SCHEDULER_JOB_NAMES.redteam,
      description:
        "Re-probe every (published attack library × agent) pair a human has already probed, as the user " +
        "who last probed it. Spends model tokens on every pass. Green never means safe.",
      adr: "ADR-0057",
      defaultIntervalSeconds: DAY,
      run: async (ctx) => {
        const out = await runScheduledRedTeamSweep(ctx.db, opts.dataKey);
        return {
          itemsProcessed: out.ran.length,
          detail: {
            ran: out.ran.length,
            regressions: out.ran.filter((r) => r.regression).length,
            skipped: out.skipped.length,
          },
        };
      },
    },
  ];
}

export function schedulerJobRegistry(opts: SchedulerJobsOptions = {}): SchedulerJobRegistry {
  return toRegistry(schedulerJobDefinitions(opts));
}

/** the type the `db` argument of a job body carries, re-exported so a test can
 * build a fake job without importing the whole registry */
export type { Db };
