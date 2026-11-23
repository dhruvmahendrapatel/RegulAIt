/**
 * ADR-0327 / ADR-0328: the worker-thread entry for the offloaded kernel functions (rule-induction-offload.ts). It runs
 * the one pure function named by `task` on the input it is handed and posts the result back. It reads nothing and
 * writes nothing.
 */
import { parentPort, workerData } from "node:worker_threads";
import { findRepetitiveAsks, type Ask, type RepetitiveAskOptions } from "./repetitive-asks.js";
import { induceStepRule, type RuleInductionOptions, type StepRun } from "./rule-induction.js";

type Job =
  | { task: "induceStepRule"; runs: StepRun[]; options: Partial<RuleInductionOptions> }
  | { task: "findRepetitiveAsks"; asks: Ask[]; options: Partial<RepetitiveAskOptions> };

const job = workerData as Job;
try {
  const result = job.task === "findRepetitiveAsks" ? findRepetitiveAsks(job.asks, job.options) : induceStepRule(job.runs, job.options);
  parentPort!.postMessage({ ok: true, result });
} catch (e) {
  parentPort!.postMessage({ ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
}
