/**
 * ADR-0187 B5-M / ADR-0190 I5 / ADR-0242 §6.1 — THE JOB-DIRECTORY EXCHANGE between an engine's runner and the task
 * bridge (the runner side): the generic part every engine shares. The engine keeps its own job files, its done-file
 * schema and how it reads its answer; this module only moves a job through the directories:
 *
 *   1. the job's files are written into `jobs/<runId>.staging/` (each one to a temp name, then renamed) and the staging
 *      directory is renamed to `jobs/<runId>`, so a job appears whole or not at all;
 *   2. the runner polls for `results/<runId>/<doneFile>`, which the task writes last;
 *   3. a cancel (the run's signal) is the file `jobs/<runId>/cancel`; past a short grace the run counts as cancelled;
 *   4. past the run's time plus a grace the runner writes the cancel file and stops waiting: nothing the task may still
 *      write is read (the engine reads its answer only on `"done"`);
 *   5. `release` removes everything of one run, and `reconcile` every job and result that is not the kept run's (at
 *      runner start: keep nothing; before each scan: keep that run), so a crashed runner leaves nothing behind.
 *
 * A run id is a lower-case UUID and nothing else: every path is built from it, so an id that is not one is refused
 * (publish throws, release and reconcile ignore it). Stdlib only (node:fs, node:path): nothing to admit (ADR-0176).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** the name of the file that asks the task to stop */
export const JOB_CANCEL_FILE = "cancel";

/** is this a run id the exchange builds paths from (a lower-case UUID)? */
export function isJobRunId(runId: unknown): runId is string {
  return typeof runId === "string" && RUN_ID.test(runId);
}

/** a job directory's run id: `<uuid>` (published) or `<uuid>.staging` (being written); else null */
export function jobDirRunId(name: string): string | null {
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.staging)?$/.exec(name);
  return m ? m[1]! : null;
}

/** how one exchange ended: the task's done file appeared, the run was cancelled, or the task did not answer in time */
export type JobExchangeEnd = "done" | "cancelled" | "timed_out";

export interface JobExchangeOptions {
  /** the file the task writes last in `results/<runId>/` (the engine's name for it) */
  doneFile: string;
  /** how often the results directory is looked at (default 250 ms) */
  pollMs?: number;
  /** how long past the run's time the task may still answer (default 15 s) */
  graceMs?: number;
  /** how long after a cancel the task may still answer (default 5 s) */
  cancelGraceMs?: number;
}

/** the runner's side of the exchange (the bridge reads `jobsRoot` and writes `resultsRoot`) */
export class JobExchange {
  constructor(
    readonly jobsRoot: string,
    readonly resultsRoot: string,
    private readonly opts: JobExchangeOptions,
  ) {}

  /** the directory a run's answer is read from */
  resultsDir(runId: string): string {
    if (!isJobRunId(runId)) throw new Error("invalid run id");
    return path.join(this.resultsRoot, runId);
  }

  /**
   * hand one job to the task and wait for its end: anything of an earlier attempt of this run is removed first, a
   * run already cancelled publishes nothing, and the job's files (name → content, each a plain file name) appear whole.
   */
  async run(job: { runId: string; files: Readonly<Record<string, string | Uint8Array>>; timeoutMs: number }, signal: AbortSignal): Promise<JobExchangeEnd> {
    if (!isJobRunId(job.runId)) throw new Error("invalid run id");
    for (const name of Object.keys(job.files)) {
      if (name === "" || name === JOB_CANCEL_FILE || name.startsWith(".") || path.basename(name) !== name) throw new Error("invalid job file name");
    }
    await this.release(job.runId);
    if (signal.aborted) return "cancelled";
    const staging = path.join(this.jobsRoot, `${job.runId}.staging`);
    await mkdir(staging, { mode: 0o750 });
    for (const [name, content] of Object.entries(job.files)) {
      const tmp = path.join(staging, `.${randomUUID()}.tmp`);
      await writeFile(tmp, content, { mode: 0o640 });
      await rename(tmp, path.join(staging, name));
    }
    const live = path.join(this.jobsRoot, job.runId);
    await rename(staging, live);
    const poll = this.opts.pollMs ?? 250;
    const giveUpAt = Date.now() + job.timeoutMs + (this.opts.graceMs ?? 15_000);
    const donePath = path.join(this.resultsRoot, job.runId, this.opts.doneFile);
    let cancelSentAt: number | null = null;
    for (;;) {
      if (existsSync(donePath)) return "done";
      if (signal.aborted && cancelSentAt === null) {
        await writeFile(path.join(live, JOB_CANCEL_FILE), "", { mode: 0o640 }).catch(() => undefined);
        cancelSentAt = Date.now();
      }
      if (cancelSentAt !== null && Date.now() - cancelSentAt > (this.opts.cancelGraceMs ?? 5000)) return "cancelled";
      if (Date.now() > giveUpAt) {
        await writeFile(path.join(live, JOB_CANCEL_FILE), "", { mode: 0o640 }).catch(() => undefined);
        return "timed_out";
      }
      await new Promise((r) => setTimeout(r, poll));
    }
  }

  /** remove everything of this run (its staging and live job, and its results) */
  async release(runId: string): Promise<void> {
    if (!isJobRunId(runId)) return;
    await rm(path.join(this.jobsRoot, `${runId}.staging`), { recursive: true, force: true });
    await rm(path.join(this.jobsRoot, runId), { recursive: true, force: true });
    await rm(path.join(this.resultsRoot, runId), { recursive: true, force: true });
  }

  /** remove every job and result that is not `keepRunId`'s; returns the job directory names removed */
  async reconcile(keepRunId: string | null): Promise<string[]> {
    const removed: string[] = [];
    for (const name of await readdir(this.jobsRoot).catch(() => [] as string[])) {
      const runId = jobDirRunId(name);
      if (runId !== null && runId !== keepRunId) {
        await rm(path.join(this.jobsRoot, name), { recursive: true, force: true });
        removed.push(name);
      }
    }
    for (const name of await readdir(this.resultsRoot).catch(() => [] as string[])) {
      if (isJobRunId(name) && name !== keepRunId) await rm(path.join(this.resultsRoot, name), { recursive: true, force: true });
    }
    return removed;
  }
}
