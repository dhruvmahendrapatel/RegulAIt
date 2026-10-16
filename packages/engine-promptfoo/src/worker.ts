/**
 * ADR-0187 B5-P2 — the WORKER's side: running one promptfoo job (`redteam generate`, then `eval`) and the worker's
 * half of the exchange (moved out of job.ts and exchange.ts by ADR-0190 I5).
 *
 * This module runs promptfoo (child process groups), so it is reached only from code that runs INSIDE an engine
 * task's sandbox (`task-main.ts`) and from tests. The runner's entry point never imports it: the static guard
 * `adr0190-i5-engine-runner-no-spawn.test.ts` walks the runner's import closure.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProcessGroup, type ProcessGroupResult } from "@regulait/engine-runner/worker";
import type { EngineAdapter } from "@regulait/engine-runner";
import { assertGatewayOnly, promptfooEnvFor, PromptfooConfigRefused } from "./config.js";
import { promptfooRunnerAdapter, type PromptfooAdapterOptions } from "./adapter.js";
import { doneOf, DONE_FILE, RESULTS_FILE } from "./exchange.js";
import { promptfooJobSchema, REFUSAL_CODE, type PromptfooExecutor, type PromptfooJob, type PromptfooJobOutcome, type PromptfooJobRunnerOptions } from "./job.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOTHING: PromptfooJobOutcome = { refused: null, generateExitCode: null, generated: false, evalExitCode: null, aborted: false, results: null };

async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, { mode: 0o640 });
  await rename(tmp, file);
}

async function sha256OfFile(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/**
 * The adapter with this process as the default executor (`LocalPromptfooExecutor`): tests and the opt-in real-engine
 * test only. The image's runner uses `promptfooRunnerAdapter` with the exchange.
 */
export function promptfooAdapter(opts: PromptfooAdapterOptions): EngineAdapter {
  const executor =
    opts.executor ??
    new LocalPromptfooExecutor({
      entrypoint: opts.entrypoint,
      ...(opts.nodeBin ? { nodeBin: opts.nodeBin } : {}),
      ...(opts.run ? { run: opts.run } : {}),
      ...(opts.path ? { path: opts.path } : {}),
    });
  return promptfooRunnerAdapter({ ...opts, executor });
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

export interface WorkerOptions {
  jobsRoot: string;
  resultsRoot: string;
  /** the worker's own work area (promptfoo's HOME, sqlite store, cache and generated tests) */
  workRoot: string;
  pollMs?: number;
  promptfoo: PromptfooJobRunnerOptions;
}

/** the WORKER's side: one job at a time, until the signal stops it */
export async function runPromptfooWorkerLoop(
  opts: WorkerOptions & { signal?: AbortSignal; log?: (m: string) => void; onIdle?: () => Promise<void> },
): Promise<void> {
  const poll = opts.pollMs ?? 250;
  const log = opts.log ?? (() => undefined);
  while (!opts.signal?.aborted) {
    await promptfooWorkerTick(opts, log).catch((e: unknown) => log(`promptfoo worker: ${e instanceof Error ? e.message : String(e)}`));
    await opts.onIdle?.().catch(() => undefined);
    await new Promise((r) => setTimeout(r, poll));
  }
}

/** one pass: run every waiting job, then drop results whose job is gone */
export async function promptfooWorkerTick(opts: WorkerOptions, log: (m: string) => void = () => undefined): Promise<number> {
  let ran = 0;
  const jobs = (await readdir(opts.jobsRoot).catch(() => [] as string[])).filter((n) => UUID.test(n));
  for (const runId of jobs) {
    const outDir = path.join(opts.resultsRoot, runId);
    const donePath = path.join(outDir, DONE_FILE);
    if (existsSync(donePath)) continue;
    await mkdir(outDir, { recursive: true, mode: 0o750 });
    let job: PromptfooJob;
    try {
      const parsed = promptfooJobSchema.safeParse(JSON.parse(await readFile(path.join(opts.jobsRoot, runId, "job.json"), "utf8")));
      if (!parsed.success || parsed.data.runId !== runId) throw new Error("invalid job");
      job = parsed.data;
    } catch {
      // an unreadable job is answered (refused), so the runner is not left waiting; promptfoo never starts
      await writeAtomic(donePath, JSON.stringify({ ...doneOf(NOTHING, null), refused: "job_invalid" }));
      log(`promptfoo worker: job ${runId} is invalid; answered without running`);
      continue;
    }
    const workDir = path.join(opts.workRoot, runId);
    await rm(workDir, { recursive: true, force: true });
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    const abort = new AbortController();
    const cancelFile = path.join(opts.jobsRoot, runId, "cancel");
    const watch = setInterval(() => {
      if (existsSync(cancelFile) || !existsSync(path.join(opts.jobsRoot, runId))) abort.abort();
    }, opts.pollMs ?? 250);
    let outcome: PromptfooJobOutcome;
    try {
      if (existsSync(cancelFile)) abort.abort();
      outcome = await runPromptfooJob(job, { ...opts.promptfoo, workDir, resultsPath: path.join(outDir, RESULTS_FILE), signal: abort.signal });
    } catch (e) {
      log(`promptfoo worker: job ${runId} failed: ${e instanceof Error ? e.message : String(e)}`);
      outcome = { ...NOTHING };
    } finally {
      clearInterval(watch);
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
    const sha = outcome.results ? await sha256OfFile(outcome.results.path).catch(() => null) : null;
    await writeAtomic(donePath, JSON.stringify(doneOf(outcome, sha)));
    ran += 1;
  }
  // results whose job the runner has removed
  for (const name of await readdir(opts.resultsRoot).catch(() => [] as string[])) {
    if (UUID.test(name) && !existsSync(path.join(opts.jobsRoot, name))) await rm(path.join(opts.resultsRoot, name), { recursive: true, force: true });
  }
  return ran;
}

