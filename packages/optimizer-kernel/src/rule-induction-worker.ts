/**
 * ADR-0327: the worker-thread entry for `induceStepRuleOffThread` (rule-induction-offload.ts). It runs the pure
 * `induceStepRule` on the runs it is handed and posts the result back. It reads nothing and writes nothing.
 */
import { parentPort, workerData } from "node:worker_threads";
import { induceStepRule, type RuleInductionOptions, type StepRun } from "./rule-induction.js";

const data = workerData as { runs: StepRun[]; options: Partial<RuleInductionOptions> };
try {
  parentPort!.postMessage({ ok: true, result: induceStepRule(data.runs, data.options) });
} catch (e) {
  parentPort!.postMessage({ ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
}
