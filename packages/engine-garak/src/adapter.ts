/**
 * ADR-0187 B5-G — THE GARAK ADAPTER (runner side): one lease → plan → one job for the worker (one
 * garak process per probe) → map every probe's report into the envelope body.
 *
 * Fail closed:
 *   - nothing runnable (every requested set excluded, not pre-seeded, cloud-only or unknown) → `not_run`
 *     and no job is ever published;
 *   - a lease with no model target, or a config the invariant refuses (`assertGatewayOnly`) → `not_run`
 *     for every planned probe, garak never started;
 *   - a cancel (or the run's deadline) throws, and the runner core reports it (cancelled posts nothing,
 *     a deadline posts `timeout`);
 *   - everything else is decided by the mapper from the reports, never from an exit code.
 */
import type { EngineAdapter } from "@regulait/engine-runner";
import type { EngineLease } from "@regulait/shared";
import { assertGatewayOnly, buildGarakConfig, buildGarakEnv, GarakConfigRefused, planGarakRun, type GarakPlan } from "./config.js";
import type { GarakExecutor, GarakJob } from "./exchange.js";
import { mapGarakRun, type GarakEnvelopeBody } from "./mapper.js";

export interface GarakAdapterOptions {
  executor: GarakExecutor;
  /** the worker's time limit is the run's remaining time less this margin (to report before the deadline) */
  reportMarginMs?: number;
}

class Cancelled extends Error {}

/** every planned probe not run for one reason, garak never started */
export function notRunAll(plan: GarakPlan, errorCode: string): GarakEnvelopeBody {
  const body = mapGarakRun({ probes: [], notRun: plan.notRun }, []);
  return {
    ...body,
    status: "not_run",
    errorCode,
    items: plan.probes.map((p) => ({
      key: p.probe,
      sourceTaxonomy: { system: "garak", id: p.probe },
      mappedClass: p.entry.attackClass,
      severity: p.entry.severity,
      attempts: 0,
      defeated: 0,
      verdict: "not_run" as const,
      reason: `not run: ${errorCode}`,
      dispatchAuditIds: [],
    })),
    notRun: [...plan.notRun, ...plan.probes.map((p) => ({ key: p.probe, reason: "engine_error" as const }))],
  };
}

/** the job a lease becomes (validated again by the worker) */
export function garakJobOf(lease: EngineLease, plan: GarakPlan, timeoutMs: number): GarakJob {
  if (!lease.target) throw new GarakConfigRefused("target_required", "a garak run needs a model target behind the gateway");
  return {
    runId: lease.runId,
    probes: plan.probes.map((p) => ({ probe: p.probe, detector: p.detector })),
    target: { baseUrl: lease.target.baseUrl, model: lease.target.model, headers: { ...lease.target.headers } },
    apiKey: lease.target.apiKey,
    trials: Math.max(1, Math.min(25, Math.trunc(lease.spec.trials))),
    timeoutMs,
  };
}

export function garakAdapter(opts: GarakAdapterOptions): EngineAdapter {
  return async (lease, ctx) => {
    const plan = planGarakRun(lease.spec.config.sets);
    if (plan.probes.length === 0) return mapGarakRun(plan, []);
    const margin = opts.reportMarginMs ?? 15_000;
    const timeoutMs = Math.min(4 * 3600 * 1000, Math.max(1000, Date.parse(lease.deadlineAt) - Date.now() - margin));
    let job: GarakJob;
    try {
      job = garakJobOf(lease, plan, timeoutMs);
      // the runner checks every probe's config before anything leaves it (the worker checks again)
      const dirs = { home: "/w/h", config: "/w/c", data: "/w/d", cache: "/w/k", report: "/w/r" };
      for (const p of plan.probes) {
        assertGatewayOnly(buildGarakConfig({ target: job.target, probe: p.probe, trials: job.trials, reportDir: dirs.report }), buildGarakEnv(job.apiKey, dirs, "/usr/bin"), job.target.baseUrl);
      }
    } catch (e) {
      if (e instanceof GarakConfigRefused) return notRunAll(plan, e.code);
      throw e;
    }
    if (ctx.signal.aborted) throw new Cancelled("cancelled");
    await opts.executor.reconcile(lease.runId);
    ctx.progress(0.1);
    const { outcomes, cancelled } = await opts.executor.run(job, ctx.signal);
    if (ctx.signal.aborted || cancelled) throw new Cancelled("cancelled");
    ctx.progress(0.95);
    return mapGarakRun(plan, outcomes);
  };
}
