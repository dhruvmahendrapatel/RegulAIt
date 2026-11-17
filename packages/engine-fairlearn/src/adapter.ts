/**
 * ADR-0346 — THE FAIRLEARN ADAPTER (runner side): one lease → plan → one job for the task → the envelope. Fail
 * closed, as spikee's:
 *
 *   - a config the shared contract refuses (`fairlearnConfigProblem`) → `not_run` (`config_invalid`), no job published;
 *   - a lease with no model target, or a target the checks refuse → `not_run` with the check's code;
 *   - a cancel throws, and the runner core reports it;
 *   - the task did not answer in time → `timeout`; it answered with an error, or with a result that is not readable as
 *     announced (over the bound, not the hashed file, not the shared schema, another run's) → `failed` with a code;
 *   - a result that is read and valid → `completed`, EVEN WITH a problem (`too_few_parseable`, `budget_exhausted`, …):
 *     the gateway decides the evaluation from the raw report (it recomputes every metric itself and records the run
 *     only when fairlearn agrees). The items are bookkeeping only: one per attribute fairlearn measured, verdict
 *     `unknown`, never a pass.
 *
 * ITEM KEYS: an attribute's name is the customer's column header (up to 200 characters, any text), so it never
 * becomes a key: an item's key is `fairlearn:attr:<n>`, n the attribute's index in the result's metrics in code-point
 * order of the names. The names travel only inside the raw report.
 */
import type { EngineAdapter } from "@regulait/engine-runner";
import { FAIRLEARN_SET, FAIRLEARN_TAXONOMY_SYSTEM, RED_TEAM_SEVERITIES, type EngineResultEnvelope, type EngineResultItem, type FairlearnResult } from "@regulait/shared";
import { FAIRLEARN_NOT_RUN_KEY, FairlearnConfigRefused, fairlearnJobOf, planFairlearnRun } from "./config.js";
import type { FairlearnExecutor, FairlearnJob } from "./exchange.js";

export type FairlearnEnvelopeBody = Omit<EngineResultEnvelope, "version" | "runId" | "engineId" | "engineVersion">;

export interface FairlearnAdapterOptions {
  executor: FairlearnExecutor;
  /** the task's time limit is the run's remaining time less this margin (to report before the deadline) */
  reportMarginMs?: number;
}

class Cancelled extends Error {}

/** the run's one set not run, for one reason (nothing was started) */
export function fairlearnNotRun(errorCode: string): FairlearnEnvelopeBody {
  return { status: "not_run", errorCode, items: [], notRun: [{ key: FAIRLEARN_NOT_RUN_KEY, reason: "engine_error" }], rawReport: null };
}

/** the item key of the attribute at index n (code-point order of the result's attribute names) */
export function fairlearnItemKey(n: number): string {
  return `fairlearn:attr:${n}`;
}

/** the attribute names in the order their item keys number them */
export function fairlearnAttributeOrder(result: Pick<FairlearnResult, "metrics">): string[] {
  return Object.keys(result.metrics ?? {}).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** a valid result as the envelope: completed, one bookkeeping item per measured attribute, the result as the raw report */
export function mapFairlearnResult(result: FairlearnResult, bytes: Uint8Array, sha256: string): FairlearnEnvelopeBody {
  const items: EngineResultItem[] = fairlearnAttributeOrder(result).map((_, n) => ({
    key: fairlearnItemKey(n),
    sourceTaxonomy: { system: FAIRLEARN_TAXONOMY_SYSTEM, id: FAIRLEARN_SET },
    mappedClass: null,
    severity: RED_TEAM_SEVERITIES[0],
    attempts: 0,
    defeated: 0,
    verdict: "unknown",
    reason: null,
    dispatchAuditIds: [],
  }));
  return {
    status: "completed",
    errorCode: null,
    items,
    notRun: [],
    rawReport: { sha256, bytes: bytes.length, contentBase64: Buffer.from(bytes).toString("base64") },
  };
}

export function fairlearnAdapter(opts: FairlearnAdapterOptions): EngineAdapter {
  return async (lease, ctx) => {
    const plan = planFairlearnRun(lease.spec.config);
    if (plan.problem !== null) return fairlearnNotRun("config_invalid");
    const margin = opts.reportMarginMs ?? 15_000;
    const timeoutMs = Math.min(4 * 3600 * 1000, Math.max(1000, Date.parse(lease.deadlineAt) - Date.now() - margin));
    let job: FairlearnJob;
    try {
      job = fairlearnJobOf(lease, plan.evaluationId, timeoutMs);
    } catch (e) {
      if (e instanceof FairlearnConfigRefused) return fairlearnNotRun(e.code);
      throw e;
    }
    if (ctx.signal.aborted) throw new Cancelled("cancelled");
    await opts.executor.reconcile(lease.runId);
    ctx.progress(0.1);
    const outcome = await opts.executor.run(job, ctx.signal);
    if (ctx.signal.aborted || outcome.kind === "cancelled") throw new Cancelled("cancelled");
    ctx.progress(0.95);
    if (outcome.kind === "timed_out") return { status: "timeout", errorCode: "timed_out", items: [], notRun: [], rawReport: null };
    if (outcome.kind === "unreadable") return { status: "failed", errorCode: outcome.errorCode, items: [], notRun: [], rawReport: null };
    return mapFairlearnResult(outcome.result, outcome.bytes, outcome.sha256);
  };
}
