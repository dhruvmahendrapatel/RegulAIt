/**
 * ADR-0187 B5-M (decision 104) — HOW THE RUNNER AND THE SCANNER TALK: two containers of one image,
 * and two tmpfs-backed volumes.
 *
 *   runner  (network: engines; holds the runner token)   jobs: read-write   results: read-only
 *   scanner (network_mode: none; no token, no state)     jobs: read-only    results: read-write (/out)
 *
 * The scanner can reach nothing at all (no network), never holds the runner credential, and reads
 * the artifact from a volume it cannot write. The runner never runs modelscan.
 *
 *   1. the runner downloads the artifact into `jobs/<runId>.staging/artifact<ext>` and writes
 *      `job.json` there, then renames the directory to `jobs/<runId>` (a job appears whole or not
 *      at all);
 *   2. the scanner runs modelscan on it (scan.ts) into `results/<runId>/report.json` and writes
 *      `results/<runId>/done.json` last (atomically): the exit code, whether it was killed at its
 *      time limit or cancelled, and the report's sha256;
 *   3. a cancel is the file `jobs/<runId>/cancel`: the scanner kills the process group;
 *   4. the runner reads the report, checks it against done.json's sha256, and removes its job; the
 *      scanner removes any result whose job is gone.
 *
 * Every name is fixed or validated: a job's artifact must be `artifact<ext>` for one of the
 * extensions the format plans use, and a run id must be a UUID, so neither side can be steered to
 * another path. The scanner enforces the time limit itself; the runner waits a short grace past it
 * and then reports the scan timed out (never clean).
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ARTIFACT_FORMATS, MODELSCAN_MAX_REPORT_BYTES, type ArtifactFormat } from "@regulait/shared";
import { runModelscan, type ModelscanOutcome, type ModelscanRunnerOptions } from "./scan.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ARTIFACT_NAME = /^artifact\.(pkl|pt|npy|zip|h5)$/;

export const scanJobSchema = z
  .object({
    runId: z.string().regex(UUID),
    format: z.enum(ARTIFACT_FORMATS),
    artifactName: z.string().regex(ARTIFACT_NAME),
    timeoutMs: z.number().int().min(1000).max(4 * 3600 * 1000),
  })
  .strict();
export type ScanJob = z.infer<typeof scanJobSchema>;

const doneSchema = z
  .object({
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    cancelled: z.boolean(),
    reportSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    reportTooLarge: z.boolean(),
  })
  .strict();

/** what a lease's scan is handed to: in-process (tests, the real-engine test) or the scanner container */
export interface ScanExecutor {
  /** a fresh directory to write the artifact into */
  stage(runId: string): Promise<string>;
  scan(job: ScanJob, signal: AbortSignal): Promise<ModelscanOutcome>;
  /** remove everything of this run */
  release(runId: string): Promise<void>;
  /**
   * PR #212 review [4234946104]: remove every job (published or staging) that is not `keepRunId`'s —
   * at runner start (keep nothing) and before each scan (keep the run being scanned). A runner that
   * crashed after staging or publishing leaves directories nobody else would ever remove.
   */
  reconcile(keepRunId: string | null): Promise<string[]>;
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, { mode: 0o640 });
  await rename(tmp, file);
}

/** runs modelscan in this process's container (no isolation of its own: for tests and the opt-in real test) */
export class LocalScanExecutor implements ScanExecutor {
  constructor(
    private readonly root: string,
    private readonly opts: ModelscanRunnerOptions = {},
  ) {}
  async stage(runId: string): Promise<string> {
    if (!UUID.test(runId)) throw new Error("invalid run id");
    const dir = path.join(this.root, runId, "in");
    await rm(path.join(this.root, runId), { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  async scan(job: ScanJob, signal: AbortSignal): Promise<ModelscanOutcome> {
    const outDir = path.join(this.root, job.runId, "out");
    await mkdir(outDir, { recursive: true, mode: 0o700 });
    return runModelscan({ artifactPath: path.join(this.root, job.runId, "in", job.artifactName), outDir, timeoutMs: job.timeoutMs, signal }, this.opts);
  }
  async release(runId: string): Promise<void> {
    if (UUID.test(runId)) await rm(path.join(this.root, runId), { recursive: true, force: true });
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
export class ExchangeScanExecutor implements ScanExecutor {
  constructor(
    private readonly jobsRoot: string,
    private readonly resultsRoot: string,
    private readonly opts: { pollMs?: number; graceMs?: number } = {},
  ) {}
  private staging(runId: string) {
    return path.join(this.jobsRoot, `${runId}.staging`);
  }
  async stage(runId: string): Promise<string> {
    if (!UUID.test(runId)) throw new Error("invalid run id");
    await this.release(runId);
    const dir = this.staging(runId);
    await mkdir(dir, { mode: 0o750 });
    return dir;
  }
  async scan(job: ScanJob, signal: AbortSignal): Promise<ModelscanOutcome> {
    scanJobSchema.parse(job);
    // PR #212 review sweep [4234946096]: an already-aborted signal publishes nothing
    if (signal.aborted) return { exitCode: null, timedOut: false, cancelled: true, report: null, reportSha256: null, reportTooLarge: false };
    const dir = this.staging(job.runId);
    await writeFile(path.join(dir, "job.json"), JSON.stringify(job), { mode: 0o640 });
    const live = path.join(this.jobsRoot, job.runId);
    await rename(dir, live);
    const poll = this.opts.pollMs ?? 250;
    const give = Date.now() + job.timeoutMs + (this.opts.graceMs ?? 15_000);
    const donePath = path.join(this.resultsRoot, job.runId, "done.json");
    let cancelSentAt: number | null = null;
    for (;;) {
      if (existsSync(donePath)) return this.collect(job.runId, donePath);
      if (signal.aborted && cancelSentAt === null) {
        await writeFile(path.join(live, "cancel"), "", { mode: 0o640 }).catch(() => undefined);
        cancelSentAt = Date.now();
      }
      if (cancelSentAt !== null && Date.now() - cancelSentAt > 5000) return { exitCode: null, timedOut: false, cancelled: true, report: null, reportSha256: null, reportTooLarge: false };
      if (Date.now() > give) {
        await writeFile(path.join(live, "cancel"), "", { mode: 0o640 }).catch(() => undefined);
        return { exitCode: null, timedOut: true, cancelled: false, report: null, reportSha256: null, reportTooLarge: false };
      }
      await new Promise((r) => setTimeout(r, poll));
    }
  }
  private async collect(runId: string, donePath: string): Promise<ModelscanOutcome> {
    const fail = (): ModelscanOutcome => ({ exitCode: null, timedOut: false, cancelled: false, report: null, reportSha256: null, reportTooLarge: false });
    let done: z.infer<typeof doneSchema>;
    try {
      const parsed = doneSchema.safeParse(JSON.parse(await readFile(donePath, "utf8")));
      if (!parsed.success) return fail();
      done = parsed.data;
    } catch {
      return fail();
    }
    let report: Uint8Array | null = null;
    const reportPath = path.join(this.resultsRoot, runId, "report.json");
    if (done.reportSha256 !== null && existsSync(reportPath)) {
      if ((await stat(reportPath)).size > MODELSCAN_MAX_REPORT_BYTES) return { ...done, report: null, reportTooLarge: true };
      const bytes = await readFile(reportPath);
      // the report must be the one the scanner hashed (no swap between the two writes)
      if (createHash("sha256").update(bytes).digest("hex") !== done.reportSha256) return fail();
      report = bytes;
    }
    return { ...done, report };
  }
  async release(runId: string): Promise<void> {
    if (!UUID.test(runId)) return;
    await rm(this.staging(runId), { recursive: true, force: true });
    await rm(path.join(this.jobsRoot, runId), { recursive: true, force: true });
  }
  /**
   * [4234946104]: drop every published or staging job that is not `keepRunId`'s. The runner cannot
   * write the result volume (read-only there); the scanner drops every result whose job is gone on its
   * next pass, so reconciling the jobs reconciles the results too.
   */
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

/** the scanner's side: one job at a time, until the signal stops it */
export async function runScannerLoop(opts: {
  jobsRoot: string;
  resultsRoot: string;
  pollMs?: number;
  modelscan?: ModelscanRunnerOptions;
  signal?: AbortSignal;
  log?: (m: string) => void;
  /** called every iteration (the scanner refreshes its self-test file from here) */
  onIdle?: () => Promise<void>;
}): Promise<void> {
  const poll = opts.pollMs ?? 250;
  const log = opts.log ?? (() => undefined);
  while (!opts.signal?.aborted) {
    await scannerTick(opts, log).catch((e: unknown) => log(`scanner: ${e instanceof Error ? e.message : String(e)}`));
    await opts.onIdle?.().catch(() => undefined);
    await new Promise((r) => setTimeout(r, poll));
  }
}

/** one pass: run every waiting job, then drop results whose job is gone */
export async function scannerTick(
  opts: { jobsRoot: string; resultsRoot: string; pollMs?: number; modelscan?: ModelscanRunnerOptions },
  log: (m: string) => void = () => undefined,
): Promise<number> {
  let ran = 0;
  const jobs = (await readdir(opts.jobsRoot).catch(() => [] as string[])).filter((n) => UUID.test(n));
  for (const runId of jobs) {
    const outDir = path.join(opts.resultsRoot, runId);
    if (existsSync(path.join(outDir, "done.json"))) continue;
    let job: ScanJob;
    try {
      const parsed = scanJobSchema.safeParse(JSON.parse(await readFile(path.join(opts.jobsRoot, runId, "job.json"), "utf8")));
      if (!parsed.success || parsed.data.runId !== runId) throw new Error("invalid job");
      job = parsed.data;
    } catch {
      // an unreadable job is answered (exit unknown), so the runner is not left waiting
      await mkdir(outDir, { recursive: true, mode: 0o750 });
      await writeAtomic(path.join(outDir, "done.json"), JSON.stringify({ exitCode: null, timedOut: false, cancelled: false, reportSha256: null, reportTooLarge: false }));
      log(`scanner: job ${runId} is invalid; answered without scanning`);
      continue;
    }
    await mkdir(outDir, { recursive: true, mode: 0o750 });
    const abort = new AbortController();
    const cancelFile = path.join(opts.jobsRoot, runId, "cancel");
    const watch = setInterval(() => {
      if (existsSync(cancelFile) || !existsSync(path.join(opts.jobsRoot, runId))) abort.abort();
    }, opts.pollMs ?? 250);
    let outcome: ModelscanOutcome;
    try {
      outcome = await runModelscan({ artifactPath: path.join(opts.jobsRoot, runId, job.artifactName), outDir, timeoutMs: job.timeoutMs, signal: abort.signal }, opts.modelscan);
    } finally {
      clearInterval(watch);
    }
    await writeAtomic(
      path.join(outDir, "done.json"),
      JSON.stringify({
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        cancelled: outcome.cancelled,
        reportSha256: outcome.reportSha256,
        reportTooLarge: outcome.reportTooLarge,
      }),
    );
    ran += 1;
  }
  // results whose job the runner has removed
  for (const name of await readdir(opts.resultsRoot).catch(() => [] as string[])) {
    if (UUID.test(name) && !existsSync(path.join(opts.jobsRoot, name))) await rm(path.join(opts.resultsRoot, name), { recursive: true, force: true });
  }
  return ran;
}

export type { ArtifactFormat };
