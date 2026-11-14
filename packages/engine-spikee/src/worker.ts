/**
 * ADR-0245 — the WORKER's side of the spikee exchange (as garak's worker.ts, ADR-0190 I5).
 *
 * This module runs spikee (through `spikee-run.ts`'s process groups), so it is reached only from code that runs INSIDE
 * an engine task's sandbox (`task-main.ts`) and from tests. The runner's entry point never imports it: the static
 * guard `adr0190-i5-engine-runner-no-spawn.test.ts` walks the runner's import closure.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SPIKEE_DATASET_GENERATION, spikeeEntryForSet } from "@regulait/shared";
import type { PlannedDataset } from "./config.js";
import { spikeeJobSchema, type SpikeeExecutor, type SpikeeJob, type SpikeeWorkerDone as Done } from "./exchange.js";
import type { SpikeeDatasetOutcome } from "./mapper.js";
import { runSpikeeDataset, type SpikeeRunnerOptions } from "./spikee-run.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function writeAtomic(file: string, content: string | Uint8Array, mode = 0o640): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, { mode });
  await rename(tmp, file);
}

/** a job's dataset set id as the planner's dataset (the job schema already admitted it) */
function datasetOf(set: string): Pick<PlannedDataset, "set" | "seed" | "generation"> {
  const e = spikeeEntryForSet(set)!;
  return { set, seed: e.name, generation: SPIKEE_DATASET_GENERATION[e.name]! };
}
const pluginNames = (job: SpikeeJob): string[] => job.plugins.map((p) => spikeeEntryForSet(p)!.name);

/** one dataset, with a refused config or an I/O failure answered as `refused` (never a pass) */
async function runOne(job: SpikeeJob, i: number, workRoot: string, signal: AbortSignal, timeoutMs: number, opts: SpikeeRunnerOptions | undefined, log: (m: string) => void) {
  const set = job.datasets[i]!;
  try {
    return await runSpikeeDataset(
      { dataset: datasetOf(set), plugins: pluginNames(job), target: job.target, apiKey: job.apiKey, trials: job.trials, workDir: path.join(workRoot, job.runId, String(i)), timeoutMs, signal },
      opts,
    );
  } catch (e) {
    log(`worker: dataset ${set} of ${job.runId} did not start: ${e instanceof Error ? e.message : String(e)}`);
    const refused: SpikeeDatasetOutcome & { cancelled: boolean } = {
      set,
      generateExitCode: null,
      testExitCode: null,
      timedOut: false,
      selection: null,
      selectionSha256: null,
      results: null,
      resultsSha256: null,
      problem: "refused",
      cancelled: false,
    };
    return refused;
  }
}

/** runs spikee in this process's container (no isolation of its own: for tests and the opt-in real test) */
export class LocalSpikeeExecutor implements SpikeeExecutor {
  constructor(
    private readonly root: string,
    private readonly opts: SpikeeRunnerOptions = {},
  ) {}
  async run(job: SpikeeJob, signal: AbortSignal): Promise<{ outcomes: SpikeeDatasetOutcome[]; cancelled: boolean }> {
    spikeeJobSchema.parse(job);
    const outcomes: SpikeeDatasetOutcome[] = [];
    const until = Date.now() + job.timeoutMs;
    for (let i = 0; i < job.datasets.length; i++) {
      if (signal.aborted) return { outcomes, cancelled: true };
      const left = until - Date.now();
      if (left < 1000) break;
      const { cancelled, ...o } = await runOne(job, i, this.root, signal, left, this.opts, () => undefined);
      if (cancelled) return { outcomes, cancelled: true };
      outcomes.push(o);
    }
    return { outcomes, cancelled: false };
  }
  async reconcile(keepRunId: string | null): Promise<string[]> {
    const removed: string[] = [];
    for (const name of await readdir(this.root).catch(() => [] as string[])) {
      if (UUID.test(name) && name !== keepRunId) {
        await rm(path.join(this.root, name), { recursive: true, force: true });
        removed.push(name);
      }
    }
    return removed;
  }
}

/** one pass: run every waiting job, then drop results whose job is gone */
export async function workerTick(
  opts: { jobsRoot: string; resultsRoot: string; workRoot: string; pollMs?: number; spikee?: SpikeeRunnerOptions },
  log: (m: string) => void = () => undefined,
): Promise<number> {
  let ran = 0;
  const jobs = (await readdir(opts.jobsRoot).catch(() => [] as string[])).filter((n) => UUID.test(n));
  for (const runId of jobs) {
    const outDir = path.join(opts.resultsRoot, runId);
    if (existsSync(path.join(outDir, "done.json"))) continue;
    await mkdir(outDir, { recursive: true, mode: 0o750 });
    let job: SpikeeJob;
    try {
      const parsed = spikeeJobSchema.safeParse(JSON.parse(await readFile(path.join(opts.jobsRoot, runId, "job.json"), "utf8")));
      if (!parsed.success || parsed.data.runId !== runId) throw new Error("invalid job");
      job = parsed.data;
    } catch {
      // an unreadable job is answered (nothing ran), so the runner is not left waiting
      await writeAtomic(path.join(outDir, "done.json"), JSON.stringify({ datasets: [], invalid: true } satisfies Done));
      log(`worker: job ${runId} is invalid; answered without running`);
      continue;
    }
    const abort = new AbortController();
    const cancelFile = path.join(opts.jobsRoot, runId, "cancel");
    const watch = setInterval(() => {
      if (existsSync(cancelFile) || !existsSync(path.join(opts.jobsRoot, runId))) abort.abort();
    }, opts.pollMs ?? 250);
    const answered: Done["datasets"] = [];
    try {
      const until = Date.now() + job.timeoutMs;
      for (let i = 0; i < job.datasets.length; i++) {
        if (abort.signal.aborted) break;
        const left = until - Date.now();
        if (left < 1000) break;
        const o = await runOne(job, i, opts.workRoot, abort.signal, left, opts.spikee, log);
        if (o.selection) await writeAtomic(path.join(outDir, `${i}.selection.json`), o.selection);
        if (o.results) await writeAtomic(path.join(outDir, `${i}.results.jsonl`), o.results);
        answered.push({
          set: o.set,
          generateExitCode: o.generateExitCode,
          testExitCode: o.testExitCode,
          timedOut: o.timedOut,
          cancelled: o.cancelled,
          problem: o.problem,
          selectionSha256: o.selectionSha256,
          resultsSha256: o.resultsSha256,
        });
        if (o.cancelled) break;
      }
    } finally {
      clearInterval(watch);
      await rm(path.join(opts.workRoot, runId), { recursive: true, force: true });
    }
    await writeAtomic(path.join(outDir, "done.json"), JSON.stringify({ datasets: answered, invalid: false } satisfies Done));
    ran += 1;
  }
  for (const name of await readdir(opts.resultsRoot).catch(() => [] as string[])) {
    if (UUID.test(name) && !existsSync(path.join(opts.jobsRoot, name))) await rm(path.join(opts.resultsRoot, name), { recursive: true, force: true });
  }
  return ran;
}
