/**
 * ADR-0187 B5-P2 — ONE PROMPTFOO JOB: what the runner hands to whatever runs promptfoo, and the one
 * function that runs it (`redteam generate`, then `eval`).
 *
 * The runner builds the job from the lease (adapter.ts): the config the generator wrote and the
 * invariant checked, the gateway base URL, the run-scoped virtual key and the run's deadline. The
 * job carries NOTHING of the runner's own: no runner token, no enrolment token, no state path. The
 * run key is the narrowest credential promptfoo can work with: it reaches only the gateway's compat
 * model routes, for one project, within the run's budget, until the run's deadline, and the gateway
 * revokes it the moment the run is cancelled, times out or ends (ADR-0187 decisions 4 and 5).
 *
 * Whoever runs the job (in the image: the worker container, worker-main.ts; in tests: the local
 * executor) re-builds the child environment for ITS OWN work directory and re-checks the invariant
 * (`assertGatewayOnly`) before promptfoo starts, so a job that points anywhere but the gateway is
 * refused on both sides of the exchange.
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runProcessGroup, type ProcessGroupOptions, type ProcessGroupResult } from "@regulait/engine-runner";
import { assertGatewayOnly, promptfooEnvFor, PromptfooConfigRefused } from "./config.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const promptfooJobSchema = z
  .object({
    runId: z.string().regex(UUID),
    /** the gateway's compat base URL (the lease's `target.baseUrl`) */
    baseUrl: z.string().min(1).max(2048),
    /** the run-scoped virtual key (never the runner token) */
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

/**
 * Run one job: write the config into `workDir`, `promptfoo redteam generate`, then `promptfoo eval`
 * into `resultsPath`. Each step is a child process group under `signal` and the run's deadline.
 */
export async function runPromptfooJob(
  job: PromptfooJob,
  opts: PromptfooJobRunnerOptions & { workDir: string; resultsPath: string; signal: AbortSignal; progress?: (p: number) => void },
): Promise<PromptfooJobOutcome> {
  const outcome: PromptfooJobOutcome = { refused: null, generateExitCode: null, generated: false, evalExitCode: null, aborted: false, results: null };
  const env = promptfooEnvFor(job.apiKey, opts.workDir, { PATH: opts.path ?? process.env.PATH });
  try {
    assertGatewayOnly(job.config, env, job.baseUrl);
  } catch (e) {
    if (e instanceof PromptfooConfigRefused) return { ...outcome, refused: REFUSAL_CODE.test(e.code) ? e.code : "config_refused" };
    throw e;
  }
  const run = opts.run ?? runProcessGroup;
  const node = opts.nodeBin ?? process.execPath;
  const cfgPath = path.join(opts.workDir, "redteam-config.json");
  const genPath = path.join(opts.workDir, "redteam.yaml");
  await writeFile(cfgPath, JSON.stringify(job.config, null, 2), { mode: 0o600 });
  const remaining = () => Math.max(1000, Date.parse(job.deadlineAt) - Date.now());
  const step = async (args: string[]): Promise<ProcessGroupResult | null> => {
    if (opts.signal.aborted) return null;
    const r = await run(node, [opts.entrypoint, ...args], { cwd: opts.workDir, env, signal: opts.signal, timeoutMs: remaining() });
    if (opts.signal.aborted || r.killed) return null;
    return r;
  };
  const gen = await step(["redteam", "generate", "-c", cfgPath, "-o", genPath, "--no-cache", "--force", "--no-progress-bar", "-j", "1"]);
  if (!gen) return { ...outcome, aborted: true };
  outcome.generateExitCode = gen.exitCode;
  outcome.generated = gen.exitCode === 0 && existsSync(genPath);
  if (!outcome.generated) return outcome;
  opts.progress?.(0.3);
  const evaluated = await step(["eval", "-c", genPath, "-o", opts.resultsPath, "--no-cache", "--no-share", "--no-table", "--no-progress-bar", "-j", "1"]);
  if (!evaluated) return { ...outcome, aborted: true };
  outcome.evalExitCode = evaluated.exitCode;
  outcome.results = existsSync(opts.resultsPath) ? { path: opts.resultsPath, sha256: null } : null;
  return outcome;
}

/**
 * Runs the job in THIS process's container. No isolation of its own: the engine process can reach
 * whatever this process can. For tests and the opt-in real-engine test; the image's runner never
 * uses it (main.ts hands every job to the worker container).
 */
export class LocalPromptfooExecutor implements PromptfooExecutor {
  constructor(private readonly opts: PromptfooJobRunnerOptions) {}
  execute(job: PromptfooJob, ctx: { workDir: string; signal: AbortSignal; progress: (p: number) => void }): Promise<PromptfooJobOutcome> {
    return runPromptfooJob(job, { ...this.opts, workDir: ctx.workDir, resultsPath: path.join(ctx.workDir, "results.json"), signal: ctx.signal, progress: ctx.progress });
  }
  async release(): Promise<void> {
    // the runner core wipes the run's work directory
  }
}
