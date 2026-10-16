/**
 * ADR-0187 B5-G — the WORKER's side of the exchange (moved out of exchange.ts by ADR-0190 I5).
 *
 * This module runs garak (through `garak-run.ts`'s process group), so it is reached only from code that runs INSIDE
 * an engine task's sandbox (`task-main.ts`) and from tests. The runner's entry point never imports it: the static
 * guard `adr0190-i5-engine-runner-no-spawn.test.ts` walks the runner's import closure.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runGarakProbe, type GarakRunnerOptions } from "./garak-run.js";
import type { GarakProbeOutcome } from "./mapper.js";
import { garakJobSchema, type GarakExecutor, type GarakJob, type GarakWorkerDone as Done } from "./exchange.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
        { probe: p.probe, target: job.target, judge: job.judge, apiKey: job.apiKey, trials: job.trials, workDir: path.join(this.root, job.runId, String(i)), timeoutMs: left, signal },
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
            {
              probe: p.probe,
              target: job.target,
              judge: job.judge,
              apiKey: job.apiKey,
              trials: job.trials,
              workDir: path.join(opts.workRoot, runId, String(i)),
              timeoutMs: left,
              signal: abort.signal,
            },
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
