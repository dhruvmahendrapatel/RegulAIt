/**
 * ADR-0327: run `induceStepRule` on a worker thread, so a scan's induction (seconds of CPU per step) never blocks
 * the caller's event loop. Node's own `node:worker_threads`; no dependency (ADR-0176: the standard library first).
 *
 * A separate entry point (`@regulait/optimizer-kernel/offload`), so the kernel's main entry stays pure and zero-I/O.
 * The worker is bounded: a wall-clock timeout terminates it, and its heap is capped. A worker that fails, exits or
 * times out rejects the promise; it never yields a partial rule.
 */
import { Worker } from "node:worker_threads";
import type { RuleInductionOptions, RuleInductionResult, StepRun } from "./rule-induction.js";

export const OFFLOAD_DEFAULT_TIMEOUT_MS = 120_000;
export const OFFLOAD_MAX_HEAP_MB = 256;

export function induceStepRuleOffThread(
  runs: readonly StepRun[],
  options: Partial<RuleInductionOptions> = {},
  { timeoutMs = OFFLOAD_DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<RuleInductionResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./rule-induction-worker.js", import.meta.url), {
      workerData: { runs, options },
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
    const timer = setTimeout(() => finish(() => reject(new Error(`rule induction timed out after ${timeoutMs} ms`))), timeoutMs);
    worker.once("message", (m: { ok: true; result: RuleInductionResult } | { ok: false; error: string }) =>
      finish(() => (m.ok ? resolve(m.result) : reject(new Error(`rule induction failed: ${m.error}`)))),
    );
    worker.once("error", (e) => finish(() => reject(e)));
    worker.once("exit", (code) => finish(() => reject(new Error(`rule induction worker exited with code ${code}`))));
  });
}
