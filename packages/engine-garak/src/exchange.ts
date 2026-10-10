/**
 * ADR-0187 B5-G (decision 140) — HOW THE RUNNER AND THE WORKER TALK: two containers of one image, and
 * two tmpfs-backed volumes (the modelscan layout, decision 104, with one difference: the worker must
 * reach the gateway's model routes, so it sits on the internal `engines` network).
 *
 *   runner (engines network; holds the runner token)          jobs: read-write   results: read-only
 *   worker (engines network; NO runner token, no state volume) jobs: read-only    results: read-write
 *
 * The worker runs garak and never holds the runner credential: it cannot lease, heartbeat, post a
 * result or register. What it holds, for one run at a time, is that run's own virtual key (purpose
 * `engine`, the run's project, models, budget and deadline), which is exactly what garak needs to call
 * the target through the gateway. The runner never runs garak.
 *
 *   1. the runner writes `jobs/<runId>.staging/job.json` (the probes, the target, the key, the trials,
 *      the time limit) and renames the directory to `jobs/<runId>` (a job appears whole or not at all);
 *   2. the worker runs one garak process per probe (garak-run.ts) and copies each probe's report to
 *      `results/<runId>/<n>.report.jsonl`, then writes `results/<runId>/done.json` last (atomically):
 *      per probe, the exit code, whether it was killed, and the report's sha256;
 *   3. a cancel is the file `jobs/<runId>/cancel`: the worker kills the running process group and runs
 *      nothing more;
 *   4. the runner reads each report, checks it against done.json's sha256, and removes its job (the key
 *      goes with it); the worker removes any result whose job is gone.
 *
 * Every name is fixed or validated: a run id is a UUID, a report is `<n>.report.jsonl` for the probe's
 * index, a probe must be one the catalogue runs, so neither side can be steered to another path.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { garakProbeForSet } from "@regulait/shared";
import { runGarakProbe, type GarakRunnerOptions } from "./garak-run.js";
import { GARAK_MAX_REPORT_BYTES, type GarakProbeOutcome } from "./mapper.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PRINTABLE = /^[\x21-\x7e]{1,300}$/;

const probeName = z
  .string()
  .regex(/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/)
  .refine((p) => garakProbeForSet(p.toLowerCase())?.probe === p && garakProbeForSet(p.toLowerCase())?.disposition === "local", "not a probe this build runs");

export const garakJobSchema = z
  .object({
    runId: z.string().regex(UUID),
    probes: z
      .array(z.object({ probe: probeName, detector: z.string().regex(/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/) }).strict())
      .min(1)
      .max(50),
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
  .strict();
export type GarakJob = z.infer<typeof garakJobSchema>;

const doneSchema = z
  .object({
    probes: z
      .array(
        z
          .object({
            probe: z.string().max(200),
            exitCode: z.number().int().nullable(),
            timedOut: z.boolean(),
            cancelled: z.boolean(),
            reportSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
            reportTooLarge: z.boolean(),
          })
          .strict(),
      )
      .max(50),
    /** the job could not be read, or failed validation: nothing ran */
    invalid: z.boolean(),
  })
  .strict();
type Done = z.infer<typeof doneSchema>;

/** what a lease's probes are handed to: in-process (tests, the real-engine test) or the worker container */
export interface GarakExecutor {
  run(job: GarakJob, signal: AbortSignal): Promise<{ outcomes: GarakProbeOutcome[]; cancelled: boolean }>;
  /** remove every job that is not `keepRunId`'s (at runner start: keep nothing) */
  reconcile(keepRunId: string | null): Promise<string[]>;
}

async function writeAtomic(file: string, content: string | Uint8Array, mode = 0o640): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, { mode });
  await rename(tmp, file);
}

/** runs garak in this process's container (no isolation of its own: for tests and the opt-in real test) */
export class LocalGarakExecutor implements GarakExecutor {
  constructor(
    private readonly root: string,
    private readonly opts: GarakRunnerOptions = {},
  ) {}
  async run(job: GarakJob, signal: AbortSignal): Promise<{ outcomes: GarakProbeOutcome[]; cancelled: boolean }> {
    garakJobSchema.parse(job);
    const outcomes: GarakProbeOutcome[] = [];
    const until = Date.now() + job.timeoutMs;
    for (const [i, p] of job.probes.entries()) {
      if (signal.aborted) return { outcomes, cancelled: true };
      const left = until - Date.now();
      if (left < 1000) break;
      const o = await runGarakProbe(
        { probe: p.probe, target: job.target, apiKey: job.apiKey, trials: job.trials, workDir: path.join(this.root, job.runId, String(i)), timeoutMs: left, signal },
        this.opts,
      );
      if (o.cancelled) return { outcomes, cancelled: true };
      outcomes.push({ probe: o.probe, exitCode: o.exitCode, timedOut: o.timedOut, report: o.report, reportTooLarge: o.reportTooLarge, reportSha256: o.reportSha256 });
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

/** a job directory's run id: `<uuid>` (published) or `<uuid>.staging` (being written); else null */
export function jobDirRunId(name: string): string | null {
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.staging)?$/.exec(name);
  return m ? m[1]! : null;
}

/** the runner's side of the exchange */
export class ExchangeGarakExecutor implements GarakExecutor {
  constructor(
    private readonly jobsRoot: string,
    private readonly resultsRoot: string,
    private readonly opts: { pollMs?: number; graceMs?: number; cancelGraceMs?: number } = {},
  ) {}
  async run(job: GarakJob, signal: AbortSignal): Promise<{ outcomes: GarakProbeOutcome[]; cancelled: boolean }> {
    garakJobSchema.parse(job);
    if (signal.aborted) return { outcomes: [], cancelled: true };
    await this.release(job.runId);
    const staging = path.join(this.jobsRoot, `${job.runId}.staging`);
    await mkdir(staging, { mode: 0o750 });
    // the job holds the run's key: readable by the worker (the same uid), by nobody else
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
          // the worker did not answer in time: nothing it may still write is read
          await writeFile(path.join(live, "cancel"), "", { mode: 0o640 }).catch(() => undefined);
          return { outcomes: job.probes.map((p) => ({ probe: p.probe, exitCode: null, timedOut: true, report: null, reportTooLarge: false, reportSha256: null })), cancelled: false };
        }
        await new Promise((r) => setTimeout(r, poll));
      }
    } finally {
      await this.release(job.runId);
    }
  }
  private async collect(job: GarakJob, donePath: string): Promise<GarakProbeOutcome[]> {
    let done: Done;
    try {
      const parsed = doneSchema.safeParse(JSON.parse(await readFile(donePath, "utf8")));
      if (!parsed.success) return [];
      done = parsed.data;
    } catch {
      return [];
    }
    if (done.invalid) return [];
    const out: GarakProbeOutcome[] = [];
    for (const [i, p] of job.probes.entries()) {
      const d = done.probes[i];
      // the answer must be for the probe this index was given; else nothing from it is read
      if (!d || d.probe !== p.probe) break;
      let report: Uint8Array | null = null;
      let reportTooLarge = d.reportTooLarge;
      const file = path.join(this.resultsRoot, job.runId, `${i}.report.jsonl`);
      if (d.reportSha256 !== null && existsSync(file)) {
        if ((await stat(file)).size > GARAK_MAX_REPORT_BYTES) reportTooLarge = true;
        else {
          const bytes = await readFile(file);
          // the report must be the one the worker hashed (no swap between the two writes)
          if (createHash("sha256").update(bytes).digest("hex") === d.reportSha256) report = bytes;
        }
      }
      out.push({ probe: p.probe, exitCode: d.exitCode, timedOut: d.timedOut, report, reportTooLarge, reportSha256: report ? d.reportSha256 : null });
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

/** the worker's side: one job at a time, until the signal stops it */
export async function runWorkerLoop(opts: {
  jobsRoot: string;
  resultsRoot: string;
  workRoot: string;
  pollMs?: number;
  garak?: GarakRunnerOptions;
  signal?: AbortSignal;
  log?: (m: string) => void;
  /** called every iteration (the worker refreshes its self-test file from here) */
  onIdle?: () => Promise<void>;
}): Promise<void> {
  const poll = opts.pollMs ?? 250;
  const log = opts.log ?? (() => undefined);
  while (!opts.signal?.aborted) {
    await workerTick(opts, log).catch((e: unknown) => log(`worker: ${e instanceof Error ? e.message : String(e)}`));
    await opts.onIdle?.().catch(() => undefined);
    await new Promise((r) => setTimeout(r, poll));
  }
}

/** one pass: run every waiting job, then drop results whose job is gone */
export async function workerTick(
  opts: { jobsRoot: string; resultsRoot: string; workRoot: string; pollMs?: number; garak?: GarakRunnerOptions },
  log: (m: string) => void = () => undefined,
): Promise<number> {
  let ran = 0;
  const jobs = (await readdir(opts.jobsRoot).catch(() => [] as string[])).filter((n) => UUID.test(n));
  for (const runId of jobs) {
    const outDir = path.join(opts.resultsRoot, runId);
    if (existsSync(path.join(outDir, "done.json"))) continue;
    await mkdir(outDir, { recursive: true, mode: 0o750 });
    let job: GarakJob;
    try {
      const parsed = garakJobSchema.safeParse(JSON.parse(await readFile(path.join(opts.jobsRoot, runId, "job.json"), "utf8")));
      if (!parsed.success || parsed.data.runId !== runId) throw new Error("invalid job");
      job = parsed.data;
    } catch {
      // an unreadable job is answered (nothing ran), so the runner is not left waiting
      await writeAtomic(path.join(outDir, "done.json"), JSON.stringify({ probes: [], invalid: true } satisfies Done));
      log(`worker: job ${runId} is invalid; answered without running`);
      continue;
    }
    const abort = new AbortController();
    const cancelFile = path.join(opts.jobsRoot, runId, "cancel");
    const watch = setInterval(() => {
      if (existsSync(cancelFile) || !existsSync(path.join(opts.jobsRoot, runId))) abort.abort();
    }, opts.pollMs ?? 250);
    const answered: Done["probes"] = [];
    try {
      const until = Date.now() + job.timeoutMs;
      for (const [i, p] of job.probes.entries()) {
        if (abort.signal.aborted) break;
        const left = until - Date.now();
        if (left < 1000) break;
        let o: Awaited<ReturnType<typeof runGarakProbe>>;
        try {
          o = await runGarakProbe(
            { probe: p.probe, target: job.target, apiKey: job.apiKey, trials: job.trials, workDir: path.join(opts.workRoot, runId, String(i)), timeoutMs: left, signal: abort.signal },
            opts.garak,
          );
        } catch (e) {
          // a refused config or an I/O failure: this probe has no report (unknown), the rest still run
          log(`worker: probe ${p.probe} of ${runId} did not start: ${e instanceof Error ? e.message : String(e)}`);
          answered.push({ probe: p.probe, exitCode: null, timedOut: false, cancelled: false, reportSha256: null, reportTooLarge: false });
          continue;
        }
        if (o.report) await writeAtomic(path.join(outDir, `${i}.report.jsonl`), o.report);
        answered.push({ probe: p.probe, exitCode: o.exitCode, timedOut: o.timedOut, cancelled: o.cancelled, reportSha256: o.reportSha256, reportTooLarge: o.reportTooLarge });
        if (o.cancelled) break;
      }
    } finally {
      clearInterval(watch);
      await rm(path.join(opts.workRoot, runId), { recursive: true, force: true });
    }
    await writeAtomic(path.join(outDir, "done.json"), JSON.stringify({ probes: answered, invalid: false } satisfies Done));
    ran += 1;
  }
  // results whose job the runner has removed
  for (const name of await readdir(opts.resultsRoot).catch(() => [] as string[])) {
    if (UUID.test(name) && !existsSync(path.join(opts.jobsRoot, name))) await rm(path.join(opts.resultsRoot, name), { recursive: true, force: true });
  }
  return ran;
}
