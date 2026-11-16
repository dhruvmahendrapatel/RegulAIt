/**
 * ADR-0242 §6.1 — HOW THE RUNNER HANDS A SUBJECT SCAN TO THE SANDBOX, and reads its answer back (the runner side).
 *
 * The exchange is modelscan's (ADR-0187 B5-M), over the task bridge (ADR-0190 I5), reduced to what a subject run is:
 *
 *   1. the runner writes `jobs/<runId>.staging/subject.json` (`{"path": "tools.json" | "SKILL.md"}`, the lease's
 *      subject file) and renames it to `jobs/<runId>` (a job appears whole or not at all). The bridge starts the task
 *      with NO files, no artifact, no secret and that root subject path: the gateway writes the subject's bytes into
 *      the task input itself, from its own records (the #843 security review), so the runner never supplies them;
 *   2. in the sandbox the task runs the driver on the read-only input and writes `subject/report.json` and
 *      `subject/done.json` last; the bridge writes them as `results/<runId>/…`;
 *   3. a cancel is the file `jobs/<runId>/cancel` (the bridge closes the task: the executor stops the sandbox);
 *   4. the runner reads the report, checks it against done.json's sha256 and the gateway's raw-report cap, and
 *      removes its job.
 *
 * The report is UNTRUSTED output of a process that has just read attacker-controlled content: the runner never
 * parses, logs or judges it. It is carried, byte for byte, to the gateway, which parses it strictly and decides.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { subjectJobJson } from "@regulait/engine-runner";
import { ENGINE_RESULT_LIMITS } from "@regulait/shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const REPORT_FILE = "report.json";
export const DONE_FILE = "done.json";
/** the gateway's raw-report cap (`engineRawReportSchema`): a larger report is never posted */
export const ADMISSION_REPORT_MAX_BYTES = ENGINE_RESULT_LIMITS.maxRawReportBytes;

/** why the task scanned nothing (a fixed vocabulary; never engine output) */
export const TASK_ERRORS = ["sandbox_not_isolated", "subject_unreadable", "driver_not_started"] as const;

/** what the task writes last: the driver's end and the report's identity (never its content) */
export const doneSchema = z
  .object({
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    reportSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    reportTooLarge: z.boolean(),
    error: z.enum(TASK_ERRORS).nullable(),
  })
  .strict();
export type SubjectScanDone = z.infer<typeof doneSchema>;

/** what one subject scan produced, as the runner read it */
export interface SubjectScanOutcome {
  /** the task's done file was read and valid */
  answered: boolean;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  /** the report's bytes, checked against done.json's sha256 and the cap; null when there is none to post */
  report: Buffer | null;
  reportTooLarge: boolean;
  /** the report named in done.json was missing or not the bytes it named */
  reportMismatch: boolean;
  error: SubjectScanDone["error"];
}

export const NO_ANSWER: SubjectScanOutcome = Object.freeze({ answered: false, exitCode: null, timedOut: false, cancelled: false, report: null, reportTooLarge: false, reportMismatch: false, error: null });

/** what a lease's scan is handed to (the bridge's exchange; tests substitute their own) */
export interface SubjectScanExecutor {
  scan(job: { runId: string; subjectFile: string; timeoutMs: number }, signal: AbortSignal): Promise<SubjectScanOutcome>;
  /** remove everything of this run */
  release(runId: string): Promise<void>;
  /** remove every job that is not `keepRunId`'s (at runner start: keep nothing; before each scan: keep that run) */
  reconcile(keepRunId: string | null): Promise<string[]>;
}

/** a job directory's run id: `<uuid>` (published) or `<uuid>.staging` (being written); else null */
export function jobDirRunId(name: string): string | null {
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.staging)?$/.exec(name);
  return m ? m[1]! : null;
}

/** read the task's answer for one run from the results directory (pure file reading; exported for tests) */
export async function collectSubjectScan(resultsRoot: string, runId: string): Promise<SubjectScanOutcome> {
  let done: SubjectScanDone;
  try {
    const parsed = doneSchema.safeParse(JSON.parse(await readFile(path.join(resultsRoot, runId, DONE_FILE), "utf8")));
    if (!parsed.success) return NO_ANSWER;
    done = parsed.data;
  } catch {
    return NO_ANSWER;
  }
  const base: SubjectScanOutcome = { answered: true, exitCode: done.exitCode, timedOut: done.timedOut, cancelled: false, report: null, reportTooLarge: done.reportTooLarge, reportMismatch: false, error: done.error };
  if (done.reportSha256 === null || done.reportTooLarge) return base;
  const file = path.join(resultsRoot, runId, REPORT_FILE);
  if (!existsSync(file)) return { ...base, reportMismatch: true };
  // the gateway's cap, checked before the bytes are read
  if ((await stat(file)).size > ADMISSION_REPORT_MAX_BYTES) return { ...base, reportTooLarge: true };
  const bytes = await readFile(file);
  if (bytes.length > ADMISSION_REPORT_MAX_BYTES) return { ...base, reportTooLarge: true };
  // the report must be the one the task hashed
  if (createHash("sha256").update(bytes).digest("hex") !== done.reportSha256) return { ...base, reportMismatch: true };
  return { ...base, report: bytes };
}

/** the runner's side of the exchange (the bridge reads `jobsRoot` and writes `resultsRoot`) */
export class SubjectExchange implements SubjectScanExecutor {
  constructor(
    private readonly jobsRoot: string,
    private readonly resultsRoot: string,
    private readonly opts: { pollMs?: number; graceMs?: number } = {},
  ) {}

  async scan(job: { runId: string; subjectFile: string; timeoutMs: number }, signal: AbortSignal): Promise<SubjectScanOutcome> {
    if (!UUID.test(job.runId)) throw new Error("invalid run id");
    const marker = subjectJobJson(job.subjectFile);
    await this.release(job.runId);
    if (signal.aborted) return { ...NO_ANSWER, cancelled: true };
    const staging = path.join(this.jobsRoot, `${job.runId}.staging`);
    await mkdir(staging, { mode: 0o750 });
    const tmp = path.join(staging, `.${randomUUID()}.tmp`);
    await writeFile(tmp, marker, { mode: 0o640 });
    await rename(tmp, path.join(staging, "subject.json"));
    const live = path.join(this.jobsRoot, job.runId);
    await rename(staging, live);
    const poll = this.opts.pollMs ?? 250;
    const giveUpAt = Date.now() + job.timeoutMs + (this.opts.graceMs ?? 15_000);
    const donePath = path.join(this.resultsRoot, job.runId, DONE_FILE);
    let cancelSentAt: number | null = null;
    for (;;) {
      if (existsSync(donePath)) return collectSubjectScan(this.resultsRoot, job.runId);
      if (signal.aborted && cancelSentAt === null) {
        await writeFile(path.join(live, "cancel"), "", { mode: 0o640 }).catch(() => undefined);
        cancelSentAt = Date.now();
      }
      if (cancelSentAt !== null && Date.now() - cancelSentAt > 5000) return { ...NO_ANSWER, cancelled: true };
      if (Date.now() > giveUpAt) {
        await writeFile(path.join(live, "cancel"), "", { mode: 0o640 }).catch(() => undefined);
        return { ...NO_ANSWER, timedOut: true };
      }
      await new Promise((r) => setTimeout(r, poll));
    }
  }

  async release(runId: string): Promise<void> {
    if (!UUID.test(runId)) return;
    await rm(path.join(this.jobsRoot, `${runId}.staging`), { recursive: true, force: true });
    await rm(path.join(this.jobsRoot, runId), { recursive: true, force: true });
    await rm(path.join(this.resultsRoot, runId), { recursive: true, force: true });
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
    for (const name of await readdir(this.resultsRoot).catch(() => [] as string[])) {
      if (UUID.test(name) && name !== keepRunId) await rm(path.join(this.resultsRoot, name), { recursive: true, force: true });
    }
    return removed;
  }
}
