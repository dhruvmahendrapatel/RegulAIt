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
 * The job-directory mechanics (staging → live, the cancel file, the poll, release, reconcile) are engine-runner's shared
 * `JobExchange`; this module keeps what is the admission scan's own: the subject job file, the done-file schema, the
 * task's error vocabulary and how the answer is read.
 *
 * The report is UNTRUSTED output of a process that has just read attacker-controlled content: the runner never
 * parses, logs or judges it. It is carried, byte for byte, to the gateway, which parses it strictly and decides.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isJobRunId, JobExchange, SUBJECT_JOB_FILE, subjectJobJson } from "@regulait/engine-runner";
import { ENGINE_RESULT_LIMITS } from "@regulait/shared";

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
  private readonly jobs: JobExchange;
  constructor(
    jobsRoot: string,
    private readonly resultsRoot: string,
    opts: { pollMs?: number; graceMs?: number } = {},
  ) {
    this.jobs = new JobExchange(jobsRoot, resultsRoot, { ...opts, doneFile: DONE_FILE });
  }

  async scan(job: { runId: string; subjectFile: string; timeoutMs: number }, signal: AbortSignal): Promise<SubjectScanOutcome> {
    if (!isJobRunId(job.runId)) throw new Error("invalid run id");
    const marker = subjectJobJson(job.subjectFile);
    const end = await this.jobs.run({ runId: job.runId, files: { [SUBJECT_JOB_FILE]: marker }, timeoutMs: job.timeoutMs }, signal);
    if (end === "done") return collectSubjectScan(this.resultsRoot, job.runId);
    return end === "cancelled" ? { ...NO_ANSWER, cancelled: true } : { ...NO_ANSWER, timedOut: true };
  }

  release(runId: string): Promise<void> {
    return this.jobs.release(runId);
  }

  reconcile(keepRunId: string | null): Promise<string[]> {
    return this.jobs.reconcile(keepRunId);
  }
}
