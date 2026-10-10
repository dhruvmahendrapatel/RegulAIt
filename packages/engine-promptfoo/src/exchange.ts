/**
 * ADR-0187 B5-P2 — HOW THE PROMPTFOO RUNNER AND WORKER TALK: two containers of one image, and two
 * tmpfs-backed volumes (the modelscan pattern, ADR-0187 decision 104, adapted to an engine that
 * makes model calls).
 *
 *   runner (engines network; holds the runner token)            jobs: read-write   results: read-only
 *   worker (engines network; NO runner token, NO state volume)  jobs: read-only    results: read-write (/out)
 *
 * The worker runs promptfoo. It reaches the gateway (promptfoo's model calls go to the compat
 * routes) on the RUN key the job carries, which is the narrowest credential promptfoo can work with:
 * the gateway accepts it only on the compat model routes, for the run's project, within the run's
 * budget, until the run's deadline, and revokes it when the run ends. The runner token (which leases
 * runs, mints their keys through the lease and posts their results) never leaves the runner
 * container: it is on the runner's state volume, which the worker does not mount, in a process the
 * worker cannot see (its own PID namespace), and it is not an input of the adapter that writes jobs.
 *
 *   1. the runner writes `jobs/<runId>.staging/job.json` and renames the directory to
 *      `jobs/<runId>` (a job appears whole or not at all);
 *   2. the worker re-checks the job (schema and `assertGatewayOnly`), runs promptfoo in its own
 *      `/work/<runId>`, writes the eval results to `results/<runId>/results.json` and, last and
 *      atomically, `results/<runId>/done.json` (exit codes, aborted, refused, the results' sha256);
 *   3. a cancel is the file `jobs/<runId>/cancel` (or the job directory disappearing): the worker
 *      kills promptfoo's process group;
 *   4. the runner reads the results (bounded, and only if their sha256 is the one done.json names)
 *      and removes its job; the worker removes any result whose job is gone.
 *
 * Every name is fixed or validated (a run id must be a UUID), so neither side can be steered to
 * another path. The worker enforces the run's deadline itself; the runner gives up a grace period
 * after it and the run reads as timed out (never clean).
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { promptfooJobSchema, REFUSAL_CODE, runPromptfooJob, type PromptfooExecutor, type PromptfooJob, type PromptfooJobOutcome, type PromptfooJobRunnerOptions } from "./job.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const RESULTS_FILE = "results.json";
export const DONE_FILE = "done.json";

const doneSchema = z
  .object({
    refused: z.string().regex(REFUSAL_CODE).nullable(),
    generateExitCode: z.number().int().nullable(),
    generated: z.boolean(),
    evalExitCode: z.number().int().nullable(),
    aborted: z.boolean(),
    resultsSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  })
  .strict();
type Done = z.infer<typeof doneSchema>;

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

/** a job directory's run id: `<uuid>` (published) or `<uuid>.staging` (being written); else null */
export function jobDirRunId(name: string): string | null {
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.staging)?$/.exec(name);
  return m ? m[1]! : null;
}

const NOTHING: PromptfooJobOutcome = { refused: null, generateExitCode: null, generated: false, evalExitCode: null, aborted: false, results: null };

/** the RUNNER's side: publish a job, wait for its done file, hand back the results' path */
export class ExchangePromptfooExecutor implements PromptfooExecutor {
  constructor(
    private readonly jobsRoot: string,
    private readonly resultsRoot: string,
    private readonly opts: { pollMs?: number; graceMs?: number; cancelGraceMs?: number } = {},
  ) {}
  private staging(runId: string) {
    return path.join(this.jobsRoot, `${runId}.staging`);
  }
  async execute(job: PromptfooJob, ctx: { signal: AbortSignal; progress: (p: number) => void }): Promise<PromptfooJobOutcome> {
    promptfooJobSchema.parse(job);
    if (ctx.signal.aborted) return { ...NOTHING, aborted: true };
    // nothing of any other run stays in the exchange (a runner that crashed mid-run left it there)
    await this.reconcile(job.runId);
    await this.release(job.runId);
    const dir = this.staging(job.runId);
    await mkdir(dir, { mode: 0o750 });
    await writeFile(path.join(dir, "job.json"), JSON.stringify(job), { mode: 0o640 });
    const live = path.join(this.jobsRoot, job.runId);
    await rename(dir, live);
    const poll = this.opts.pollMs ?? 250;
    const giveUpAt = Date.parse(job.deadlineAt) + (this.opts.graceMs ?? 15_000);
    const donePath = path.join(this.resultsRoot, job.runId, DONE_FILE);
    let cancelSentAt: number | null = null;
    for (;;) {
      if (existsSync(donePath)) return this.collect(job.runId, donePath);
      if (ctx.signal.aborted && cancelSentAt === null) {
        await writeFile(path.join(live, "cancel"), "", { mode: 0o640 }).catch(() => undefined);
        cancelSentAt = Date.now();
      }
      if (cancelSentAt !== null && Date.now() - cancelSentAt > (this.opts.cancelGraceMs ?? 5000)) return { ...NOTHING, aborted: true };
      if (Date.now() > giveUpAt) {
        await writeFile(path.join(live, "cancel"), "", { mode: 0o640 }).catch(() => undefined);
        return { ...NOTHING, aborted: true };
      }
      await new Promise((r) => setTimeout(r, poll));
    }
  }
  private async collect(runId: string, donePath: string): Promise<PromptfooJobOutcome> {
    let done: Done;
    try {
      const parsed = doneSchema.safeParse(JSON.parse(await readFile(donePath, "utf8")));
      // an answer the runner cannot read decides nothing: generation "failed", every reading not run
      if (!parsed.success) return { ...NOTHING };
      done = parsed.data;
    } catch {
      return { ...NOTHING };
    }
    const resultsPath = path.join(this.resultsRoot, runId, RESULTS_FILE);
    return {
      refused: done.refused,
      generateExitCode: done.generateExitCode,
      generated: done.generated,
      evalExitCode: done.evalExitCode,
      aborted: done.aborted,
      // the adapter reads the file only if it is the one the worker hashed
      results: done.resultsSha256 !== null && existsSync(resultsPath) ? { path: resultsPath, sha256: done.resultsSha256 } : null,
    };
  }
  async release(runId: string): Promise<void> {
    if (!UUID.test(runId)) return;
    await rm(this.staging(runId), { recursive: true, force: true });
    await rm(path.join(this.jobsRoot, runId), { recursive: true, force: true });
  }
  /** drop every published or staging job that is not `keepRunId`'s (the worker then drops their results) */
  async reconcile(keepRunId: string | null): Promise<string[]> {
    const removed: string[] = [];
    for (const name of await readdir(this.jobsRoot).catch(() => [] as string[])) {
      const runId = jobDirRunId(name);
      if (runId !== null && runId !== keepRunId) {
        await rm(path.join(this.jobsRoot, name), { recursive: true, force: true });
        removed.push(name);
      }
    }
    return removed;
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

function doneOf(o: PromptfooJobOutcome, resultsSha256: string | null): Done {
  return {
    refused: o.refused,
    generateExitCode: o.generateExitCode,
    generated: o.generated,
    evalExitCode: o.evalExitCode,
    aborted: o.aborted,
    resultsSha256,
  };
}
