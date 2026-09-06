/**
 * ADR-0064 — THE SCHEDULED JOBS (six at ADR-0064; a seventh at ADR-0065; an
 * eighth at ADR-0076; an eleventh at ADR-0100).
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
import { runTrainingJobPollSweep } from "./regulait-llm.js";
import { runCostReconciliation } from "./cost-reconcile.js";
import { runCampaignExpirySweep } from "./grant-certification.js";
import { runCanaryObservationPrune } from "./config-versions.js";
import { runMcpAdmissionRescan } from "./mcp-admission-rescan.js";
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
  trainingPoll: "training-job-poll-sweep",
  costReconciliation: "cost-reconciliation-sweep",
  certificationExpiry: "certification-expiry-sweep",
  canaryObservationPrune: "canary-observation-prune-sweep",
  mcpAdmissionRescan: "mcp-admission-rescan-sweep",
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
    {
      // ADR-0065 — the seventh, and the first one that is not a sweep over
      // stored state. A REMOTE training job runs for hours on somebody else's
      // compute, so something has to ask how it is getting on and settle it
      // when it finishes. That something is a scheduler job and not a
      // setInterval, for the reason ADR-0064 was written: a module-level timer
      // double-fires the moment there are two gateway instances, and is
      // invisible when it stops.
      //
      // It makes NO model dispatch and mints no identity: it polls a job the
      // initiating user already started and writes the outcome back. In-process
      // (local/mock) jobs are never polled — they are finished by the time
      // their start call returns.
      name: SCHEDULER_JOB_NAMES.trainingPoll,
      description:
        "Poll every RegulAIt-LLM training job still running on a REMOTE backend and settle the ones that " +
        "finished. In-process jobs are never polled; they complete synchronously.",
      adr: "ADR-0065",
      defaultIntervalSeconds: 5 * 60,
      run: async (ctx) => {
        const out = await runTrainingJobPollSweep(ctx.db, { dataKey: opts.dataKey });
        return {
          itemsProcessed: out.polled.length,
          detail: { polled: out.polled.length, skipped: out.skipped.length },
        };
      },
    },
    {
      // ADR-0076 — the eighth, closing ADR-0069's disclosed cross-chunk
      // double-count gap. Marks (never deletes) cross-batch duplicate imported
      // cost lines so consolidated reads stop counting the same vendor fact
      // twice; ambiguity is reported and left alone. NOT a control: the
      // consolidated read discloses its own exclusions whether or not this has
      // ever run, and the manual endpoint runs the same function. Makes no
      // dispatch, mints no identity, and — per ADR-0069 — polls no vendor:
      // it re-examines rows we already hold.
      name: SCHEDULER_JOB_NAMES.costReconciliation,
      description:
        "Mark cross-batch duplicate imported cost lines as superseded (never deleted) so a consolidated " +
        "read cannot count the same vendor fact twice. Ambiguous duplicates are reported, never guessed at.",
      adr: "ADR-0076",
      defaultIntervalSeconds: DAY,
      run: async (ctx) => {
        const out = await runCostReconciliation(ctx.db, {
          actorUserId: ctx.actorUserId,
          now: ctx.now,
          trigger: "schedule",
        });
        return {
          itemsProcessed: out.supersededLines,
          detail: {
            runId: out.runId,
            scannedLines: out.scannedLines,
            duplicateGroups: out.duplicateGroups,
            supersededLines: out.supersededLines,
            ambiguousGroups: out.ambiguousGroups,
            overlapWarnings: out.overlapWarnings,
          },
        };
      },
    },
    {
      // ADR-0090 amendment (batch B2a) — the ninth, and the most deliberately
      // inert: it CHANGES NO DECISION AND NO STATUS. Campaign expiry stays a
      // read-time fact (ADR-0090's breach-on-read posture, unchanged) and
      // undecided items stay undecided forever; this job only writes ONE
      // audited campaign-expired-incomplete row per campaign the first time
      // it is observed past due, so the audit trail carries the expiry even
      // if nobody ever opens the campaigns page. Idempotent by data (the
      // audit row is the marker); re-runs add nothing. NOT a control.
      name: SCHEDULER_JOB_NAMES.certificationExpiry,
      description:
        "Record — once, into the audit log — each certification campaign that passed its due date with " +
        "items undecided. Decides nothing: expiry stays computed on read, and undecided stays undecided.",
      adr: "ADR-0090",
      defaultIntervalSeconds: HOUR,
      run: async (ctx) => {
        const out = await runCampaignExpirySweep(ctx.db, { actorUserId: ctx.actorUserId, now: ctx.now });
        return { itemsProcessed: out.observed, detail: { observed: out.observed, campaignIds: out.campaignIds } };
      },
    },
    {
      // ADR-0073 amendment (batch B7c) — the tenth, closing disclosure 5's
      // "no pruning" for `config_canary_observations`. Prunes shadow-canary
      // OBSERVATIONS older than the org-settings retention window
      // (`canaryObservationRetentionDays`, default 90d) and NOTHING else:
      // `config_versions` are the audit substrate and are never pruned by
      // anything, and an observation whose candidate is a LIVE canary is kept
      // regardless of age — an active canary's evidence is live evidence.
      // NOT a control: nothing enforces from observations; they are the
      // operator's promote-or-abandon evidence, and the manual endpoint
      // (POST /v1/config-versions/observations/prune) runs the same function.
      // Reconciles stored state only — no dispatch, no identity minted.
      name: SCHEDULER_JOB_NAMES.canaryObservationPrune,
      description:
        "Prune shadow-canary observation rows older than the org retention window. Never touches " +
        "config_versions (version history is the audit substrate) and never an observation of a LIVE canary.",
      adr: "ADR-0073",
      defaultIntervalSeconds: DAY,
      run: async (ctx) => {
        const out = await runCanaryObservationPrune(ctx.db, {
          actorUserId: ctx.actorUserId,
          now: ctx.now,
        });
        return {
          itemsProcessed: out.pruned,
          detail: {
            pruned: out.pruned,
            retainedDays: out.retainedDays,
            cutoff: out.cutoff,
            keptLiveCanary: out.keptLiveCanary,
          },
        };
      },
    },
    {
      // ADR-0100 — the eleventh, closing ADR-0097's own disclosed residue
      // ("it does not re-scan on a schedule ... a compromised server that is
      // never called is never caught", plus the indefinitely-trusted
      // grandfathered row). Re-fetches the manifest of every server in an
      // eligible admission state and drives THE LIVE PATH over it —
      // `connectUpstream` then `syncUpstreamTools`, which is
      // `recordManifestScan`, which owns the scan, the threshold, the digest
      // and the state rule. There is deliberately no second adjudication here.
      //
      // Daily by default and deliberately so: unlike every other reconcile
      // sweep, each pass of this one makes OUTBOUND calls (one tools/list per
      // examined server, bounded per pass), all of them through ADR-0043's
      // egress guard.
      //
      // Doubly opt-in: the scheduler is off by default AND the pass adjudicates
      // nothing while `org_settings.mcp_admission_mode` is `off`.
      name: SCHEDULER_JOB_NAMES.mcpAdmissionRescan,
      description:
        "Re-fetch and re-adjudicate the tool manifest of every MCP server in an eligible admission state " +
        "(grandfathered/unscanned/clean/cleared), so a server nobody calls is still caught. Never " +
        "re-examines a held server (nothing auto-clears) and never re-holds a cleared server on the " +
        "unchanged manifest an admin signed for. Makes outbound calls; adjudicates nothing while " +
        "mcp_admission_mode is off.",
      adr: "ADR-0100",
      defaultIntervalSeconds: DAY,
      run: async (ctx) => {
        const out = await runMcpAdmissionRescan(ctx.db, {
          actorUserId: ctx.actorUserId,
          now: ctx.now,
        });
        return {
          itemsProcessed: out.examined,
          detail: {
            mode: out.mode,
            skipped: out.skipped,
            eligible: out.eligible,
            examined: out.examined,
            capped: out.capped,
            adjudicated: out.adjudicated,
            held: out.held,
            reheld: out.reheld,
            clean: out.clean,
            clearedUnchanged: out.clearedUnchanged,
            unreachable: out.unreachable,
            reason: out.reason,
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
