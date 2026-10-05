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
import { runMcpRegistrySync } from "./mcp-registry.js";
import { runMcpHealthProbeSweep } from "./mcp-health-probe.js";
import { runGovernanceMonitor } from "./governance-monitor.js";
import { runTraceEvaluationSweep } from "./trace-evaluation.js";
import { runUseCaseRecertificationSweep } from "./review-policy.js";
import { runBuilderScheduleSweep } from "./builder-runtime.js";
import { runWebhookDeliverySweep } from "./outbound-webhooks.js";
import { runAnnotationSlaSweep } from "./annotations.js";
import { productionAutomationActionDeps, runAutomationRuleSweep } from "./automation-rules.js";
import { runIdempotencyKeySweep } from "./request-idempotency.js";
import { runConditionEvaluationSweep } from "./condition-metrics.js";
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
  mcpRegistrySync: "mcp-registry-sync-sweep",
  mcpHealthProbe: "mcp-health-probe-sweep",
  governanceMonitor: "governance-monitor-sweep",
  traceEvaluation: "trace-evaluation-sweep",
  useCaseRecertification: "use-case-recertification",
  builderAgentSchedules: "builder-agent-schedules",
  webhookDeliveries: "webhook-delivery-retry",
  // ADR-0173 batch 2c (Q)
  annotationSla: "annotation-sla-sweep",
  automationRules: "automation-rule-sweep",
  // ADR-0179 security review, item 3
  idempotencyKeySweep: "idempotency-key-sweep",
  // ADR-0180 A2: measured conditions of approval
  conditionEvaluation: "condition-evaluation-sweep",
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
    {
      // ADR-0101 — the twelfth. Pulls each ENABLED upstream MCP registry and
      // refreshes the CATALOGUE (`mcp_registry_entries`) — and nothing else. It
      // creates no `mcp_servers` row, no grant and no tool inventory, because
      // turning a directory entry into a governed object is an explicit,
      // audited operator act, not something a timer does on the estate's
      // behalf. That is the whole difference between this and the federation
      // design ADR-0101 declined to copy.
      //
      // Triply opt-in: the scheduler is off by default, a fresh install has no
      // registry rows at all, and a registry row is `enabled = false` until an
      // operator flips it. On an air-gapped deployment the pass refuses before
      // reading a row or opening a socket.
      name: SCHEDULER_JOB_NAMES.mcpRegistrySync,
      description:
        "Pull each enabled upstream MCP registry and refresh the federated CATALOGUE. Creates no " +
        "server and no grant — importing an entry is a separate explicit operator act. Bounded per " +
        "pass; refuses outright on an air-gapped deployment; never deletes a local server an upstream " +
        "stopped listing.",
      adr: "ADR-0101",
      defaultIntervalSeconds: 6 * HOUR,
      run: async (ctx) => {
        const out = await runMcpRegistrySync(ctx.db, {
          actorUserId: ctx.actorUserId,
          now: ctx.now,
        });
        return {
          itemsProcessed: out.entriesSeen,
          detail: {
            deployMode: out.deployMode,
            skipped: out.skipped,
            eligible: out.eligible,
            examined: out.examined,
            capped: out.capped,
            ok: out.ok,
            refused: out.refused,
            failed: out.failed,
            entriesSeen: out.entriesSeen,
            created: out.created,
            updated: out.updated,
            remote: out.remote,
            catalogueOnly: out.catalogueOnly,
            markedMissing: out.markedMissing,
            driftDetected: out.driftDetected,
            conflicts: out.conflicts,
            serversCreated: out.serversCreated,
            grantsCreated: out.grantsCreated,
            reason: out.reason,
          },
        };
      },
    },
    {
      // ADR-0126's ACTIVE half. The breaker learns from traffic, which means the
      // FIRST user after an outage always pays the full connect deadline — on a
      // quiet deployment that user can be the person being demoed to. This makes
      // the platform the first caller instead.
      //
      // NOT a control, like every other sweep here: the breaker consulted on the
      // request path is the enforcement, and with the scheduler off (the shipped
      // default) behaviour is identical to before this job existed, because the
      // breaker still learns passively. This only changes WHEN it learns.
      //
      // Our own refusals — an admission hold, an egress block — are counted
      // separately and never charged to the breaker. An air-gapped install
      // refuses every outbound host by design, and a probe that called that a
      // failure would report every upstream as circuit-broken on a deployment
      // where nothing is wrong.
      name: SCHEDULER_JOB_NAMES.mcpHealthProbe,
      description:
        "Probe up to 50 MCP upstreams per pass — circuit-broken ones first, then the least recently " +
        "probed — and feed the result to ADR-0126's breaker, so a dead upstream is refused before a " +
        "user finds it and a recovered one resumes without waiting for someone to try. Coverage of a " +
        "larger estate comes from the rotation across passes, not from one pass; the result reports " +
        "the backlog. Makes outbound calls through the same guarded connect the proxy uses. " +
        "Enforcement does not depend on it: the breaker still learns from traffic with this off. " +
        "Admission holds and egress blocks are OUR refusals and never open a breaker.",
      adr: "ADR-0126",
      defaultIntervalSeconds: 5 * 60,
      run: async (ctx) => {
        const out = await runMcpHealthProbeSweep(ctx.db);
        return {
          itemsProcessed: out.probed,
          detail: {
            eligible: out.eligible,
            probed: out.probed,
            healthy: out.healthy,
            failed: out.failed,
            skippedCircuitOpen: out.skippedCircuitOpen,
            skippedOurRefusal: out.skippedOurRefusal,
            opened: out.opened,
            recovered: out.recovered,
            capped: out.capped,
            // AER-037: `capped` alone says a pass truncated and nothing about
            // whether the estate is being covered. These three are what an
            // operator reads to tell a healthy steady backlog from a starved
            // tail: `neverProbed` must fall to zero and `oldestProbeAt` must
            // keep moving.
            backlog: out.backlog,
            neverProbed: out.neverProbed,
            oldestProbeAt: out.oldestProbeAt?.toISOString() ?? null,
          },
        };
      },
    },
    {
      // ADR-0157. Re-evaluates the governance monitor's rules over the
      // dependency graph, trust coverage and risk register; raises, refreshes
      // and resolves alerts. A monitor, not a control: no dispatch decision
      // reads the alert rows.
      name: SCHEDULER_JOB_NAMES.governanceMonitor,
      description:
        "Evaluate the governance monitor rules (approved use cases inheriting a high rating, depending on " +
        "halted/unowned agents, unapproved vendors or agents without an approved model card; live high " +
        "risks with no control; trust-dimension coverage below floor) and raise, refresh or resolve " +
        "alerts. Enforcement does not depend on it.",
      adr: "ADR-0157",
      defaultIntervalSeconds: HOUR,
      run: async (ctx) => {
        const out = await runGovernanceMonitor(ctx.db, { actorUserId: ctx.actorUserId, now: ctx.now });
        return { itemsProcessed: out.raised + out.resolved, detail: { ...out } };
      },
    },
    {
      // ADR-0160. Re-runs the shipped heuristic detectors over stored previews
      // of completed model calls (counts only). Feeds the monitor's
      // agent_output_leakage rule; changes nothing a dispatch reads.
      name: SCHEDULER_JOB_NAMES.traceEvaluation,
      description:
        "Evaluate up to 500 newly completed model-call spans per pass with the shipped guardrail detectors " +
        "(output: PII, credential material, toxicity; input: injection/jailbreak attempts). Counts only, no " +
        "model call. Withheld or uncaptured content is recorded as not evaluated.",
      adr: "ADR-0160",
      defaultIntervalSeconds: 15 * 60,
      run: async (ctx) => {
        const out = await runTraceEvaluationSweep(ctx.db, { now: ctx.now });
        return { itemsProcessed: out.scanned, detail: { ...out } };
      },
    },
    {
      // ADR-0168 amendment. Moves approved use cases whose approval expired
      // back into review (a new sign-off round per the review policy). Not the
      // control: the deploy gate refuses an expired approval whether or not
      // this has run; this makes the registry and the review queue say so.
      name: SCHEDULER_JOB_NAMES.useCaseRecertification,
      description:
        "Move approved AI use cases whose approval has expired back into review for recertification, " +
        "re-opening the intake sign-off with the reviews the review policy requires. Enforcement does not " +
        "depend on it: the deploy gate refuses an expired approval on every call.",
      adr: "ADR-0168",
      defaultIntervalSeconds: HOUR,
      run: async (ctx) => {
        const out = await runUseCaseRecertificationSweep(ctx.db, { now: ctx.now, actorUserId: ctx.actorUserId });
        return {
          itemsProcessed: out.movedToReview,
          detail: { evaluated: out.evaluated, movedToReview: out.movedToReview, skipped: out.skipped.length },
        };
      },
    },
    {
      // ADR-0172. Runs every due builder-agent schedule AS THE AGENT'S OWNER
      // (never as the scheduler, which has no identity): the run is an
      // ordinary governed dispatch with the owner's entitlements, budgets and
      // the agent's monthly limit, and lands in the owner's inbox as a thread
      // that needs attention. Each schedule is claimed compare-and-swap, so a
      // manual sweep racing this job runs it once.
      name: SCHEDULER_JOB_NAMES.builderAgentSchedules,
      description:
        "Run every agent-builder schedule the agent's owner turned on that has come due, as that owner, through the " +
        "governed dispatch path (owner entitlements, budgets and the agent's monthly limit apply), at most 10 per " +
        "owner per pass. Each run lands in the owner's inbox as a thread that needs attention.",
      adr: "ADR-0172",
      defaultIntervalSeconds: 5 * 60,
      run: async (ctx) => {
        const out = await runBuilderScheduleSweep(ctx.db, opts.dataKey, { now: ctx.now });
        return {
          itemsProcessed: out.ran + out.refused,
          detail: { due: out.due, ran: out.ran, refused: out.refused, skipped: out.skipped.length, deferred: out.deferred },
        };
      },
    },
    {
      // ADR-0173 batch 2b. Retries every outbound webhook delivery whose
      // backoff has come due. The first attempt happens right after the event;
      // this is only the retry path. Each delivery is claimed with a lease, so
      // the manual sweep racing this job sends once.
      name: SCHEDULER_JOB_NAMES.webhookDeliveries,
      description:
        "Retry outbound webhook deliveries whose backoff has come due (up to 100 per pass), signed with the " +
        "subscription's secret and sent through the egress guard; a delivery that runs out of attempts is marked " +
        "failed and audited.",
      adr: "ADR-0173",
      defaultIntervalSeconds: 60,
      run: async (ctx) => {
        const out = await runWebhookDeliverySweep(ctx.db, opts.dataKey, { now: ctx.now });
        return { itemsProcessed: out.due, detail: { ...out } };
      },
    },
    {
      // ADR-0173 batch 2c (Q). Marks open annotation items past their queue's
      // SLA as breached, once each (a conditional update claims an item only
      // while its breach time is unset), audits each and sends one
      // annotation.sla.breached webhook per item. The same function the admin
      // "run the SLA sweep now" endpoint calls.
      name: SCHEDULER_JOB_NAMES.annotationSla,
      description:
        "Mark open annotation-queue items that passed their review deadline as breached (up to 500 per pass), once " +
        "per item, with an audit row and one annotation.sla.breached webhook each.",
      adr: "ADR-0173",
      defaultIntervalSeconds: 15 * 60,
      run: async (ctx) => {
        const out = await runAnnotationSlaSweep(ctx.db, opts.dataKey, { now: ctx.now });
        return { itemsProcessed: out.breached, detail: { breached: out.breached } };
      },
    },
    {
      // ADR-0173 batch 2c (K). Runs every active automation rule over traces
      // that ended since its cursor: filter, deterministic sampling, then the
      // rule's actions AS ITS AUTHOR (paused, audited, if the author is no
      // longer an active admin). The scheduler has no identity and lends none.
      name: SCHEDULER_JOB_NAMES.automationRules,
      description:
        "Run the active automation rules over newly finished traces (at most 500 traces and 45 seconds per pass, and " +
        "each rule's daily cap): filter, deterministic sampling, then send to an annotation queue, add to a dataset, " +
        "notify one webhook or hold the trace's retention, as the rule's author. A rule whose author is no longer an " +
        "active admin is paused and the pause audited.",
      adr: "ADR-0173",
      defaultIntervalSeconds: 5 * 60,
      run: async (ctx) => {
        const out = await runAutomationRuleSweep(ctx.db, productionAutomationActionDeps(opts.dataKey), {
          now: ctx.now,
          dataKey: opts.dataKey,
        });
        return { itemsProcessed: out.examined, detail: { ...out } };
      },
    },
    {
      // ADR-0179 security review, item 3. Deletes Idempotency-Key claims past
      // their 30-day window from both claim tables. Not a control: an expired
      // claim never replays whether or not this has run; this only stops the
      // tables (and what they kept) from growing for ever.
      name: SCHEDULER_JOB_NAMES.idempotencyKeySweep,
      description:
        "Delete Idempotency-Key claims older than their 30-day replay window from request_idempotency_keys and " +
        "use_case_idempotency_keys (at most 5000 per table per pass, oldest first). Replay does not depend on it: " +
        "an expired claim is never replayed.",
      adr: "ADR-0179",
      defaultIntervalSeconds: HOUR,
      run: async (ctx) => {
        const out = await runIdempotencyKeySweep(ctx.db, { now: ctx.now });
        return { itemsProcessed: out.requestKeys + out.useCaseKeys, detail: { ...out } };
      },
    },
    {
      // ADR-0180 A2. Measures every measured approval condition whose cadence
      // (hourly, daily or weekly) has come due, from the existing ledgers, and
      // persists the result. An open condition is closed ONLY here (or by an
      // admin's "evaluate now", the same function) on passing evidence; a
      // reopen_review condition breached twice in a row re-opens review. The
      // deploy gate measures live and does not depend on this having run.
      name: SCHEDULER_JOB_NAMES.conditionEvaluation,
      description:
        "Evaluate measured approval conditions whose cadence has come due: measure the metric from the existing " +
        "ledgers, record the value, samples, state and evidence, close an open condition on passing evidence (audited " +
        "as the evaluator), and re-open review after two consecutive breaches where the condition asks for it. Too few " +
        "samples is never a pass.",
      adr: "ADR-0180",
      defaultIntervalSeconds: 15 * 60,
      run: async (ctx) => {
        const out = await runConditionEvaluationSweep(ctx.db, { now: ctx.now, dataKey: opts.dataKey });
        return {
          itemsProcessed: out.evaluated,
          detail: {
            useCases: out.useCases,
            evaluated: out.evaluated,
            met: out.met,
            breached: out.breached,
            reopened: out.reopened,
            skipped: out.skipped.length,
          },
        };
      },
    },
    ...adr0180A10Jobs(opts),
  ];
}

export function schedulerJobRegistry(opts: SchedulerJobsOptions = {}): SchedulerJobRegistry {
  return toRegistry(schedulerJobDefinitions(opts));
}

/** the type the `db` argument of a job body carries, re-exported so a test can
 * build a fake job without importing the whole registry */
export type { Db };

// ===== ADR-0180 (ADR-0175 batch D3) A10 — APPEND-ONLY BLOCK, owner A10 ======
// The risk-acceptance expiry sweep. Everything above this line is A2's.
// `schedulerJobDefinitions` spreads `adr0180A10Jobs` (A2's hook). The gate does
// not depend on the sweep: an acceptance past its expiry is never valid.
import { runRiskAcceptanceExpirySweep } from "./risk-tolerance.js";

export const RISK_ACCEPTANCE_EXPIRY_JOB_NAME = "risk-acceptance-expiry-sweep";

export function riskAcceptanceExpiryJobDefinition(): SchedulerJobDefinition {
  return {
    // ADR-0180 §6. Stamps lapsed residual-risk acceptances expired, reopens
    // each risk (audited as the deployment, never as a person) and raises
    // `risk_acceptance_expired`. The same function a test or a manual run calls.
    name: RISK_ACCEPTANCE_EXPIRY_JOB_NAME,
    description:
      "Mark residual-risk acceptances past their expiry as expired (up to 500 per pass), reopen each risk so it " +
      "needs a new decision, audit each, and raise a risk-acceptance-expired alert. The deploy gate does not depend " +
      "on it: an acceptance past its expiry is never valid.",
    adr: "ADR-0180",
    defaultIntervalSeconds: HOUR,
    run: async (ctx) => {
      // audited as the deployment; an admin who ran it by hand is only `requestedBy`
      const out = await runRiskAcceptanceExpirySweep(ctx.db, { now: ctx.now, requestedByUserId: ctx.actorUserId });
      return { itemsProcessed: out.expired, detail: { ...out } };
    },
  };
}
function adr0180A10Jobs(_opts: SchedulerJobsOptions): SchedulerJobDefinition[] {
  return [riskAcceptanceExpiryJobDefinition()];
}
// ===== end A10 block ==================================================