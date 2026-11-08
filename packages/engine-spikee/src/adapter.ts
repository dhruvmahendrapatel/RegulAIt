/**
 * ADR-0245 — THE SPIKEE ADAPTER (runner side): one lease → plan → one job for the task (two spikee processes per
 * dataset) → map every dataset's selection and results into the envelope body. Fail closed, as garak's:
 *
 *   - nothing runnable (no local dataset: every set excluded, cloud-only, unknown, or plugins alone) → `not_run`, and
 *     no job is ever published;
 *   - a lease with no model target, or a config the invariant refuses (`assertGatewayOnly`) → `not_run` for every
 *     planned item, spikee never started;
 *   - a cancel (or the run's deadline) throws, and the runner core reports it;
 *   - everything else is decided by the mapper from the files, never from an exit code.
 * The lease's judge, if any, is never handed on: spikee's admitted datasets judge locally.
 */
import type { EngineAdapter } from "@regulait/engine-runner";
import type { EngineLease } from "@regulait/shared";
import { assertGatewayOnly, buildSpikeeEnv, buildSpikeeTargetConfig, planSpikeeRun, SpikeeConfigRefused, spikeeGenerateArgs, spikeeItemKey, spikeeSourceTaxonomy, spikeeTestArgs, type SpikeePlan } from "./config.js";
import type { SpikeeExecutor, SpikeeJob } from "./exchange.js";
import { mapSpikeeRun, type SpikeeEnvelopeBody } from "./mapper.js";

export interface SpikeeAdapterOptions {
  executor: SpikeeExecutor;
  /** the task's time limit is the run's remaining time less this margin (to report before the deadline) */
  reportMarginMs?: number;
}

class Cancelled extends Error {}

/** every planned item not run for one reason, spikee never started */
export function notRunAll(plan: SpikeePlan, errorCode: string): SpikeeEnvelopeBody {
  const keys = [null, ...plan.plugins.map((p) => p.name)];
  const items = plan.datasets.flatMap((d) =>
    keys.map((plugin) => ({
      key: spikeeItemKey(d.set, plugin),
      sourceTaxonomy: spikeeSourceTaxonomy(d.set),
      mappedClass: d.entry.attackClass,
      severity: d.entry.severity,
      attempts: 0,
      defeated: 0,
      verdict: "not_run" as const,
      reason: `not run: ${errorCode}`,
      dispatchAuditIds: [],
    })),
  );
  return {
    status: "not_run",
    errorCode,
    items,
    notRun: [...plan.notRun, ...items.map((i) => ({ key: i.key, reason: "engine_error" as const }))],
    rawReport: null,
  };
}

/** the job a lease becomes (validated again by the task) */
export function spikeeJobOf(lease: EngineLease, plan: SpikeePlan, timeoutMs: number): SpikeeJob {
  if (!lease.target) throw new SpikeeConfigRefused("target_required", "a spikee run needs a model target behind the gateway");
  return {
    runId: lease.runId,
    datasets: plan.datasets.map((d) => d.set),
    plugins: plan.plugins.map((p) => p.set),
    target: { baseUrl: lease.target.baseUrl, model: lease.target.model, headers: { ...lease.target.headers } },
    apiKey: lease.target.apiKey,
    trials: Math.max(1, Math.min(25, Math.trunc(lease.spec.trials))),
    timeoutMs,
  };
}

export function spikeeAdapter(opts: SpikeeAdapterOptions): EngineAdapter {
  return async (lease, ctx) => {
    const plan = planSpikeeRun(lease.spec.config.sets);
    if (plan.datasets.length === 0) return mapSpikeeRun(plan, []);
    const margin = opts.reportMarginMs ?? 15_000;
    const timeoutMs = Math.min(4 * 3600 * 1000, Math.max(1000, Date.parse(lease.deadlineAt) - Date.now() - margin));
    let job: SpikeeJob;
    try {
      job = spikeeJobOf(lease, plan, timeoutMs);
      // the runner checks every dataset's invocation before anything leaves it (the task checks again)
      const dirs = { home: "/w/h", config: "/w/c", data: "/w/d", cache: "/w/k", workspace: "/w/ws" };
      const plugins = plan.plugins.map((p) => p.name);
      for (const d of plan.datasets) {
        assertGatewayOnly(
          { targetConfig: buildSpikeeTargetConfig(job.target), generateArgs: spikeeGenerateArgs(d, plugins), testArgs: spikeeTestArgs(), env: buildSpikeeEnv(job.apiKey, dirs, "/usr/bin") },
          job.target.baseUrl,
        );
      }
    } catch (e) {
      if (e instanceof SpikeeConfigRefused) return notRunAll(plan, e.code);
      throw e;
    }
    if (ctx.signal.aborted) throw new Cancelled("cancelled");
    await opts.executor.reconcile(lease.runId);
    ctx.progress(0.1);
    const { outcomes, cancelled } = await opts.executor.run(job, ctx.signal);
    if (ctx.signal.aborted || cancelled) throw new Cancelled("cancelled");
    ctx.progress(0.95);
    return mapSpikeeRun(plan, outcomes);
  };
}
