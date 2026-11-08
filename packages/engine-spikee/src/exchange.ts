/**
 * ADR-0245 — HOW THE RUNNER AND THE SPIKEE TASK TALK (garak's exchange, ADR-0187 decision 140, ADR-0190 I5).
 *
 *   1. the runner writes `jobs/<runId>.staging/job.json` (the datasets, the plugins, the target, the key, the trials,
 *      the time limit) and renames the directory to `jobs/<runId>`; the task bridge takes the key OUT of it and hands
 *      it to the sandbox as the task secret;
 *   2. the task runs each dataset (spikee-run.ts) and writes `results/<runId>/<n>.selection.json` and
 *      `<n>.results.jsonl`, then `results/<runId>/done.json` last (atomically): per dataset, the exit codes, whether
 *      it was stopped, its problem, and each file's sha256;
 *   3. a cancel is the file `jobs/<runId>/cancel`;
 *   4. the runner reads each file, checks it against done.json's sha256, and removes its job (the key goes with it).
 *
 * Every name is fixed or validated: a run id is a UUID, a file is `<n>.<kind>` for the dataset's index, a dataset or
 * plugin must be one the catalogue runs, so neither side can be steered to another path. The job carries no judge:
 * spikee's admitted datasets use local judges only.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { SPIKEE_DATASET_GENERATION, spikeeEntryForSet } from "@regulait/shared";
import { SPIKEE_MAX_RESULTS_BYTES, SPIKEE_MAX_SELECTION_BYTES, SPIKEE_RUN_PROBLEMS, type SpikeeDatasetOutcome } from "./mapper.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PRINTABLE = /^[\x21-\x7e]{1,300}$/;

const localSet = (kind: "dataset" | "plugin") =>
  z
    .string()
    .max(100)
    .refine((s) => {
      const e = spikeeEntryForSet(s);
      return !!e && e.kind === kind && e.disposition === "local" && (kind === "plugin" || !!SPIKEE_DATASET_GENERATION[e.name]);
    }, `not a ${kind} this build runs`);

export const spikeeJobSchema = z
  .object({
    runId: z.string().regex(UUID),
    datasets: z.array(localSet("dataset")).min(1).max(20),
    plugins: z.array(localSet("plugin")).max(40),
    target: z
      .object({
        baseUrl: z.string().url().max(500),
        model: z.string().regex(PRINTABLE).max(200),
        headers: z.record(z.string().regex(/^x-regulait-[a-z-]{1,40}$/), z.string().regex(PRINTABLE).max(200)),
      })
      .strict(),
    apiKey: z.string().regex(PRINTABLE),
    trials: z.number().int().min(1).max(25),
    /** the whole job's time limit (the run's remaining time less a margin) */
    timeoutMs: z.number().int().min(1000).max(4 * 3600 * 1000),
  })
  .strict()
  .refine((j) => new Set(j.datasets).size === j.datasets.length && new Set(j.plugins).size === j.plugins.length, "a set is named once");
export type SpikeeJob = z.infer<typeof spikeeJobSchema>;

const sha = z.string().regex(/^[0-9a-f]{64}$/).nullable();
const doneSchema = z
  .object({
    datasets: z
      .array(
        z
          .object({
            set: z.string().max(200),
            generateExitCode: z.number().int().nullable(),
            testExitCode: z.number().int().nullable(),
            timedOut: z.boolean(),
            cancelled: z.boolean(),
            problem: z.enum(SPIKEE_RUN_PROBLEMS).nullable(),
            selectionSha256: sha,
            resultsSha256: sha,
          })
          .strict(),
      )
      .max(20),
    /** the job could not be read, or failed validation: nothing ran */
    invalid: z.boolean(),
  })
  .strict();
export type SpikeeWorkerDone = z.infer<typeof doneSchema>;

/** what a lease's datasets are handed to: in-process (tests, the real-engine test) or the task sandbox */
export interface SpikeeExecutor {
  run(job: SpikeeJob, signal: AbortSignal): Promise<{ outcomes: SpikeeDatasetOutcome[]; cancelled: boolean }>;
  /** remove every job that is not `keepRunId`'s (at runner start: keep nothing) */
  reconcile(keepRunId: string | null): Promise<string[]>;
}

/** a job directory's run id: `<uuid>` (published) or `<uuid>.staging` (being written); else null */
export function jobDirRunId(name: string): string | null {
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.staging)?$/.exec(name);
  return m ? m[1]! : null;
}

/** read one result file only when it is within its bound and is the file the worker hashed */
async function readHashed(file: string, want: string | null, max: number): Promise<Uint8Array | null> {
  if (want === null || !existsSync(file)) return null;
  if ((await stat(file)).size > max) return null;
  const bytes = await readFile(file);
  return createHash("sha256").update(bytes).digest("hex") === want ? bytes : null;
}

/** the runner's side of the exchange */
export class ExchangeSpikeeExecutor implements SpikeeExecutor {
  constructor(
    private readonly jobsRoot: string,
    private readonly resultsRoot: string,
    private readonly opts: { pollMs?: number; graceMs?: number; cancelGraceMs?: number } = {},
  ) {}
  async run(job: SpikeeJob, signal: AbortSignal): Promise<{ outcomes: SpikeeDatasetOutcome[]; cancelled: boolean }> {
    spikeeJobSchema.parse(job);
    if (signal.aborted) return { outcomes: [], cancelled: true };
    await this.release(job.runId);
    const staging = path.join(this.jobsRoot, `${job.runId}.staging`);
    await mkdir(staging, { mode: 0o750 });
    await writeFile(path.join(staging, "job.json"), JSON.stringify(job), { mode: 0o640 });
    const live = path.join(this.jobsRoot, job.runId);
    await rename(staging, live);
    try {
      const poll = this.opts.pollMs ?? 250;
      const give = Date.now() + job.timeoutMs + (this.opts.graceMs ?? 15_000);
      const donePath = path.join(this.resultsRoot, job.runId, "done.json");
      let cancelSentAt: number | null = null;
      for (;;) {
        if (existsSync(donePath)) return { outcomes: await this.collect(job, donePath), cancelled: signal.aborted };
        if (signal.aborted && cancelSentAt === null) {
          await writeFile(path.join(live, "cancel"), "", { mode: 0o640 }).catch(() => undefined);
          cancelSentAt = Date.now();
        }
        if (cancelSentAt !== null && Date.now() - cancelSentAt > (this.opts.cancelGraceMs ?? 5000)) return { outcomes: [], cancelled: true };
        if (Date.now() > give) {
          // the task did not answer in time: nothing it may still write is read
          await writeFile(path.join(live, "cancel"), "", { mode: 0o640 }).catch(() => undefined);
          return {
            outcomes: job.datasets.map((set) => ({ set, generateExitCode: null, testExitCode: null, timedOut: true, selection: null, selectionSha256: null, results: null, resultsSha256: null, problem: "timed_out" as const })),
            cancelled: false,
          };
        }
        await new Promise((r) => setTimeout(r, poll));
      }
    } finally {
      await this.release(job.runId);
    }
  }
  private async collect(job: SpikeeJob, donePath: string): Promise<SpikeeDatasetOutcome[]> {
    let done: SpikeeWorkerDone;
    try {
      const parsed = doneSchema.safeParse(JSON.parse(await readFile(donePath, "utf8")));
      if (!parsed.success) return [];
      done = parsed.data;
    } catch {
      return [];
    }
    if (done.invalid) return [];
    const out: SpikeeDatasetOutcome[] = [];
    for (const [i, set] of job.datasets.entries()) {
      const d = done.datasets[i];
      // the answer must be for the dataset this index was given; else nothing from it is read
      if (!d || d.set !== set) break;
      const dir = path.join(this.resultsRoot, job.runId);
      const selection = await readHashed(path.join(dir, `${i}.selection.json`), d.selectionSha256, SPIKEE_MAX_SELECTION_BYTES);
      const results = await readHashed(path.join(dir, `${i}.results.jsonl`), d.resultsSha256, SPIKEE_MAX_RESULTS_BYTES);
      out.push({
        set,
        generateExitCode: d.generateExitCode,
        testExitCode: d.testExitCode,
        timedOut: d.timedOut,
        selection,
        selectionSha256: selection ? d.selectionSha256 : null,
        results,
        resultsSha256: results ? d.resultsSha256 : null,
        // a file the worker announced but that is not readable as hashed: never a pass
        problem: d.problem ?? (d.resultsSha256 !== null && !results ? "results_unreadable" : null),
      });
    }
    return out;
  }
  async release(runId: string): Promise<void> {
    if (!UUID.test(runId)) return;
    await rm(path.join(this.jobsRoot, `${runId}.staging`), { recursive: true, force: true });
    await rm(path.join(this.jobsRoot, runId), { recursive: true, force: true });
  }
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
