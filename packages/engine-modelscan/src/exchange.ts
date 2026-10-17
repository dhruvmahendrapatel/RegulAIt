/**
 * ADR-0187 B5-M (decision 104) — HOW THE RUNNER AND THE SCANNER TALK: two containers of one image,
 * and two tmpfs-backed volumes.
 *
 *   runner  (network: engines; holds the runner key)   jobs: read-write   results: read-only
 *   scanner (network_mode: none; no token, no state)     jobs: read-only    results: read-write (/out)
 *
 * The scanner can reach nothing at all (no network), never holds the runner credential, and reads
 * the artifact from a volume it cannot write. The runner never runs modelscan.
 *
 *   1. the runner writes `job.json` and the artifact's PLACE (`artifact.bin`, empty) into
 *      `jobs/<runId>.staging`, then renames the directory to `jobs/<runId>` (a job appears whole or
 *      not at all). ENG-IMG (ADR-0190 I5 open question 2): the runner never downloads the artifact.
 *      The gateway streams it from its store to the executor, which writes and verifies it (size and
 *      sha256) at that place in the sandbox's read-only input;
 *   2. the scanner decides the artifact's REAL format from its bytes (G19 2), hands a scannable one to
 *      modelscan (scan.ts) under that format's extension, writes `results/<runId>/report.json` and writes
 *      `results/<runId>/done.json` last (atomically): the detected format, the exit code, whether it was killed at its
 *      time limit or cancelled, and the report's sha256 (for a `.npy`, also the strict header check's
 *      answer, ADR-0187 decisions 180–184: modelscan then sees only an object array's pickle payload;
 *      for a `.npz`, the archive check's answer, decisions 219–224: modelscan sees only the object
 *      members' payloads);
 *   3. a cancel is the file `jobs/<runId>/cancel`: the scanner kills the process group;
 *   4. the runner reads the report, checks it against done.json's sha256, and removes its job; the
 *      scanner removes any result whose job is gone.
 *
 * Every name is fixed or validated: a job's artifact is always `artifact.bin`, and a run id must be
 * a UUID, so neither side can be steered to another path. The scanner enforces the time limit itself; the runner waits a short grace past it
 * and then reports the scan timed out (never clean).
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ARTIFACT_FORMATS, MODELSCAN_MAX_REPORT_BYTES, npyCheckSchema, npzCheckSchema, type ArtifactFormat } from "@regulait/shared";
// ADR-0190 I5: types only — the scanner's code (which runs modelscan) is in worker.ts, which the runner never imports
import type { ScanOutcome } from "./scan.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** the one name of the run's artifact in a job (the task bridge PLACES it: the gateway streams it to the executor) */
export const PLACED_ARTIFACT_NAME = "artifact.bin";
export const ARTIFACT_NAME = /^artifact\.bin$/;

export const scanJobSchema = z
  .object({
    runId: z.string().regex(UUID),
    artifactName: z.literal(PLACED_ARTIFACT_NAME),
    timeoutMs: z.number().int().min(1000).max(4 * 3600 * 1000),
  })
  .strict();
export type ScanJob = z.infer<typeof scanJobSchema>;

/** the scanner's reading of the artifact's bytes (the format decides the plan; the evidence is recorded) */
export const scanDetectionSchema = z.object({ format: z.enum(ARTIFACT_FORMATS), evidence: z.string().max(500) }).strict();
export type ScanDetection = z.infer<typeof scanDetectionSchema>;

/** what a scan job produced: the scan's outcome and the format the scanner read (null = it could not read one) */
export interface ScannerOutcome extends ScanOutcome {
  detection: ScanDetection | null;
}

const doneSchema = z
  .object({
    detection: scanDetectionSchema.nullable(),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    cancelled: z.boolean(),
    reportSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    reportTooLarge: z.boolean(),
    // ADR-0187 decisions 180–184: the scanner's `.npy` header check (null for every other format)
    npy: npyCheckSchema.nullable(),
    // ADR-0187 decisions 219–224: the scanner's `.npz` archive check (null for every other format)
    npz: npzCheckSchema.nullable(),
  })
  .strict();

/** what a lease's scan is handed to: in-process (tests, the real-engine test) or the scanner container */
export interface ScanExecutor {
  /** a fresh directory for the job (the adapter writes the artifact's place there) */
  stage(runId: string): Promise<string>;
  scan(job: ScanJob, signal: AbortSignal): Promise<ScannerOutcome>;
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
  async scan(job: ScanJob, signal: AbortSignal): Promise<ScannerOutcome> {
    scanJobSchema.parse(job);
    // PR #212 review sweep [4234946096]: an already-aborted signal publishes nothing
    if (signal.aborted) return { detection: null, exitCode: null, timedOut: false, cancelled: true, report: null, reportSha256: null, reportTooLarge: false, npy: null, npz: null };
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
      if (cancelSentAt !== null && Date.now() - cancelSentAt > 5000) return { detection: null, exitCode: null, timedOut: false, cancelled: true, report: null, reportSha256: null, reportTooLarge: false, npy: null, npz: null };
      if (Date.now() > give) {
        await writeFile(path.join(live, "cancel"), "", { mode: 0o640 }).catch(() => undefined);
        return { detection: null, exitCode: null, timedOut: true, cancelled: false, report: null, reportSha256: null, reportTooLarge: false, npy: null, npz: null };
      }
      await new Promise((r) => setTimeout(r, poll));
    }
  }
  private async collect(runId: string, donePath: string): Promise<ScannerOutcome> {
    const fail = (): ScannerOutcome => ({ detection: null, exitCode: null, timedOut: false, cancelled: false, report: null, reportSha256: null, reportTooLarge: false, npy: null, npz: null });
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

export type { ArtifactFormat };
