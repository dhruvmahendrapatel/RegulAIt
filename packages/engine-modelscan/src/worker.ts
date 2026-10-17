/**
 * ADR-0187 B5-M — the SCANNER's side of the exchange (moved out of exchange.ts by ADR-0190 I5).
 *
 * This module runs modelscan (through `scan.ts`'s process group), so it is reached only from code that runs INSIDE an
 * engine task's sandbox (`task-main.ts`) and from tests. The runner's entry point never imports it: the static guard
 * `adr0190-i5-engine-runner-no-spawn.test.ts` walks the runner's import closure.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ARTIFACT_FORMAT_PLANS, detectArtifactFormat, modelscanArtifactName, type ArtifactReader } from "@regulait/shared";
import { runScanJob, type ModelscanRunnerOptions } from "./scan.js";
import { scanJobSchema, type ScanDetection, type ScanExecutor, type ScanJob, type ScannerOutcome } from "./exchange.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, { mode: 0o640 });
  await rename(tmp, file);
}

/** a reader over a local file (for format detection) */
export async function fileReader(file: string): Promise<{ reader: ArtifactReader; close: () => Promise<void> }> {
  const fh = await open(file, "r");
  const size = (await fh.stat()).size;
  return {
    reader: {
      size,
      async read(offset, length) {
        const n = Math.max(0, Math.min(length, size - offset));
        const buf = Buffer.alloc(n);
        if (n > 0) await fh.read(buf, 0, n, offset);
        return new Uint8Array(buf.buffer, buf.byteOffset, n);
      },
    },
    close: () => fh.close(),
  };
}

const UNREAD: ScannerOutcome = { detection: null, exitCode: null, timedOut: false, cancelled: false, report: null, reportSha256: null, reportTooLarge: false, npy: null, npz: null };

/**
 * ENG-IMG — scan the PLACED artifact (`artifact.bin`, written and verified by the executor in the read-only input).
 * THE FORMAT IS DECIDED FROM THE BYTES (G19 2), here, by the code that reads them: a format modelscan does not scan
 * is answered with its detection alone (modelscan never starts); a scannable one is handed to modelscan through a
 * symlink named for its format's extension, in scratch space (the input is read-only, and a copy would double a large
 * artifact). modelscan 0.8.8 takes the path as given (`Path.absolute()`, never `resolve()`), so its report names
 * the extension's name, as before.
 */
export async function scanPlacedArtifact(
  inv: { artifactPath: string; outDir: string; scratchRoot?: string; timeoutMs: number; signal?: AbortSignal },
  opts: ModelscanRunnerOptions = {},
): Promise<ScannerOutcome> {
  let detection: ScanDetection;
  try {
    const { reader, close } = await fileReader(inv.artifactPath);
    try {
      const d = await detectArtifactFormat(reader);
      detection = { format: d.format, evidence: d.evidence.slice(0, 500) };
    } finally {
      await close();
    }
  } catch {
    return UNREAD;
  }
  const name = modelscanArtifactName(detection.format);
  if (!ARTIFACT_FORMAT_PLANS[detection.format].scanAs || !name) return { ...UNREAD, detection };
  const scratch = await mkdtemp(path.join(inv.scratchRoot ?? tmpdir(), "modelscan-in-"));
  try {
    const named = path.join(scratch, name);
    await symlink(path.resolve(inv.artifactPath), named);
    const outcome = await runScanJob({ format: detection.format, artifactPath: named, outDir: inv.outDir, timeoutMs: inv.timeoutMs, ...(inv.signal ? { signal: inv.signal } : {}) }, opts);
    return { ...outcome, detection };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
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
  async scan(job: ScanJob, signal: AbortSignal): Promise<ScannerOutcome> {
    const outDir = path.join(this.root, job.runId, "out");
    await mkdir(outDir, { recursive: true, mode: 0o700 });
    return scanPlacedArtifact({ artifactPath: path.join(this.root, job.runId, "in", job.artifactName), outDir, scratchRoot: path.join(this.root, job.runId), timeoutMs: job.timeoutMs, signal }, this.opts);
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


/** the scanner's side: one job at a time, until the signal stops it */
export async function runScannerLoop(opts: {
  jobsRoot: string;
  resultsRoot: string;
  scratchRoot?: string;
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
  opts: { jobsRoot: string; resultsRoot: string; scratchRoot?: string; pollMs?: number; modelscan?: ModelscanRunnerOptions },
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
      await writeAtomic(path.join(outDir, "done.json"), JSON.stringify({ detection: null, exitCode: null, timedOut: false, cancelled: false, reportSha256: null, reportTooLarge: false, npy: null, npz: null }));
      log(`scanner: job ${runId} is invalid; answered without scanning`);
      continue;
    }
    await mkdir(outDir, { recursive: true, mode: 0o750 });
    const abort = new AbortController();
    const cancelFile = path.join(opts.jobsRoot, runId, "cancel");
    const watch = setInterval(() => {
      if (existsSync(cancelFile) || !existsSync(path.join(opts.jobsRoot, runId))) abort.abort();
    }, opts.pollMs ?? 250);
    let outcome: ScannerOutcome;
    try {
      outcome = await scanPlacedArtifact(
        { artifactPath: path.join(opts.jobsRoot, runId, job.artifactName), outDir, ...(opts.scratchRoot ? { scratchRoot: opts.scratchRoot } : {}), timeoutMs: job.timeoutMs, signal: abort.signal },
        opts.modelscan,
      );
    } finally {
      clearInterval(watch);
    }
    await writeAtomic(
      path.join(outDir, "done.json"),
      JSON.stringify({
        detection: outcome.detection,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        cancelled: outcome.cancelled,
        reportSha256: outcome.reportSha256,
        reportTooLarge: outcome.reportTooLarge,
        npy: outcome.npy,
        npz: outcome.npz,
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

