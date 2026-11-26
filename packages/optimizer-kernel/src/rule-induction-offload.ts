/**
 * ADR-0327 / ADR-0328: run a scan's pure kernel function (`induceStepRule`, `findRepetitiveAsks`) on a worker thread,
 * so its CPU (up to seconds per step or agent) never blocks the caller's event loop. Node's own `node:worker_threads`; no dependency (ADR-0176: the standard library first).
 *
 * A separate entry point (`@regulait/optimizer-kernel/offload`), so the kernel's main entry stays pure and zero-I/O.
 * The worker is bounded: a wall-clock timeout terminates it, and its heap is capped. A worker that fails, exits or
 * times out rejects the promise; it never yields a partial result.
 */
import { Worker } from "node:worker_threads";
import type { Ask, RepetitiveAskOptions, RepetitiveAskResult } from "./repetitive-asks.js";
import type { RuleInductionOptions, RuleInductionResult, StepRun } from "./rule-induction.js";

export const OFFLOAD_DEFAULT_TIMEOUT_MS = 120_000;
export const OFFLOAD_MAX_HEAP_MB = 256;

/** one bounded worker per call: the job is posted in, one result (or a refusal) comes back */
function runOffThread<T>(job: Record<string, unknown>, label: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./rule-induction-worker.js", import.meta.url), {
      workerData: job,
      resourceLimits: { maxOldGenerationSizeMb: OFFLOAD_MAX_HEAP_MB },
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`))), timeoutMs);
    worker.once("message", (m: { ok: true; result: T } | { ok: false; error: string }) =>
      finish(() => (m.ok ? resolve(m.result) : reject(new Error(`${label} failed: ${m.error}`)))),
    );
    worker.once("error", (e) => finish(() => reject(e)));
    worker.once("exit", (code) => finish(() => reject(new Error(`${label} worker exited with code ${code}`))));
  });
}

export function induceStepRuleOffThread(
  runs: readonly StepRun[],
  options: Partial<RuleInductionOptions> = {},
  { timeoutMs = OFFLOAD_DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<RuleInductionResult> {
  return runOffThread({ task: "induceStepRule", runs, options }, "rule induction", timeoutMs);
}

/** ADR-0328: `findRepetitiveAsks` on a worker thread (the asks' text goes to the worker only, never further) */
export function findRepetitiveAsksOffThread(
  asks: readonly Ask[],
  options: Partial<RepetitiveAskOptions> = {},
  { timeoutMs = OFFLOAD_DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<RepetitiveAskResult> {
  return runOffThread({ task: "findRepetitiveAsks", asks, options }, "repetitive-ask detection", timeoutMs);
}
