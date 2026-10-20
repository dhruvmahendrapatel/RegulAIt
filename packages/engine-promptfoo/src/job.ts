/**
 * ADR-0187 B5-P2 — ONE PROMPTFOO JOB: what the runner hands to whatever runs promptfoo, and the one
 * function that runs it (`redteam generate`, then `eval`).
 *
 * The runner builds the job from the lease (adapter.ts): the config the generator wrote and the
 * invariant checked, the gateway base URL, the run-scoped virtual key and the run's deadline. The
 * job carries NOTHING of the runner's own: no runner key, no enrolment token, no state path. The
 * run key is the narrowest credential promptfoo can work with: it reaches only the gateway's compat
 * model routes, for one project, within the run's budget, until the run's deadline, and the gateway
 * revokes it the moment the run is cancelled, times out or ends (ADR-0187 decisions 4 and 5).
 *
 * Whoever runs the job (in the image: the engine task in an executor's sandbox, task-main.ts and worker.ts; in tests:
 * the local executor) re-builds the child environment for ITS OWN work directory and re-checks the invariant
 * (`assertGatewayOnly`) before promptfoo starts, so a job that points anywhere but the gateway is
 * refused on both sides of the exchange.
 */
import { z } from "zod";
// ADR-0190 I5: types only — running a job (process groups) is worker.ts, which the runner never imports
import type { ProcessGroupOptions, ProcessGroupResult } from "@regulait/engine-runner/worker";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const promptfooJobSchema = z
  .object({
    runId: z.string().regex(UUID),
    /** the gateway's compat base URL (the lease's `target.baseUrl`) */
    baseUrl: z.string().min(1).max(2048),
    /** the run-scoped virtual key (never the runner key) */
    apiKey: z.string().min(1).max(512),
    /** the generated promptfoo config (re-checked by `assertGatewayOnly` before promptfoo starts) */
    config: z.record(z.string(), z.unknown()),
    deadlineAt: z.string().datetime(),
  })
  .strict();
export type PromptfooJob = z.infer<typeof promptfooJobSchema>;

/** a refusal code from the job runner: short, fixed vocabulary (it crosses the exchange) */
export const REFUSAL_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export interface PromptfooJobOutcome {
  /** the job runner's invariant refused the job (its code); promptfoo was never started */
  refused: string | null;
  generateExitCode: number | null;
  /** did generation exit 0 and write its test file? */
  generated: boolean;
  /** null when the eval step never ran */
  evalExitCode: number | null;
  /** a cancel or the deadline killed a step (or stopped the job before one started) */
  aborted: boolean;
  /** the eval results file, when one was written; `sha256` is set when the file crossed the exchange */
  results: { path: string; sha256: string | null } | null;
}

/** where a job runs: in-process (tests) or the worker container (the image) */
export interface PromptfooExecutor {
  execute(job: PromptfooJob, ctx: { workDir: string; signal: AbortSignal; progress: (p: number) => void }): Promise<PromptfooJobOutcome>;
  /** forget everything of this run (after the runner has read its results) */
  release(runId: string): Promise<void>;
}

export interface PromptfooJobRunnerOptions {
  /** promptfoo's CLI entrypoint, run with node */
  entrypoint: string;
  /** the node binary (default: this process's) */
  nodeBin?: string;
  /** seam for tests */
  run?: (cmd: string, args: readonly string[], opts: ProcessGroupOptions) => Promise<ProcessGroupResult>;
  /** PATH handed to the child (nothing else is inherited) */
  path?: string;
}

