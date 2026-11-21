/**
 * ADR-0346 — HOW THE RUNNER AND THE FAIRLEARN TASK TALK (spikee's exchange, ADR-0245; the generic moves are
 * engine-runner's `JobExchange`).
 *
 *   1. the runner writes `jobs/<runId>/job.json` (the run, the evaluation, the target, the key, the time limit) and
 *      the marker `gateway-input.json`, through a staging directory so the job appears whole; the task bridge takes the
 *      key OUT of job.json and hands it to the sandbox as the task secret, and turns the marker into the gateway's own
 *      `fairness-input.json` at the task input's root (the runner never sees the rows);
 *   2. the task writes `results/<runId>/result.json` (fairlearnResultSchema: predictions and fairlearn's values,
 *      never a reply's text), then `results/<runId>/done.json` LAST, naming result.json's sha256 (or why there is none);
 *   3. a cancel is the file `jobs/<runId>/cancel`;
 *   4. the runner reads result.json only when it is within FAIRLEARN_LIMITS.maxResultBytes, is the file done.json
 *      hashed, parses against the shared schema and names this run and evaluation; then removes the job (the key goes
 *      with it).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isJobRunId, JobExchange } from "@regulait/engine-runner";
import { FAIRLEARN_LIMITS, fairlearnResultSchema, type FairlearnResult } from "@regulait/shared";
import { FAIRLEARN_GATEWAY_INPUT_MARKER, fairlearnGatewayInputMarker, HEADER_NAME_RE } from "./config.js";

export const FAIRLEARN_RESULT_FILE = "result.json";
export const FAIRLEARN_DONE_FILE = "done.json";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PRINTABLE = /^[\x21-\x7e]{1,300}$/;

export const fairlearnJobSchema = z
  .object({
    runId: z.string().regex(UUID),
    evaluationId: z.string().regex(UUID),
    target: z
      .object({
        baseUrl: z.string().url().max(500),
        model: z.string().regex(PRINTABLE).max(200),
        headers: z.record(z.string().regex(HEADER_NAME_RE), z.string().regex(PRINTABLE).max(200)),
      })
      .strict(),
    apiKey: z.string().regex(PRINTABLE),
    /** the whole job's time limit (the run's remaining time less a margin) */
    timeoutMs: z.number().int().min(1000).max(4 * 3600 * 1000),
  })
  .strict();
export type FairlearnJob = z.infer<typeof fairlearnJobSchema>;

/** why the task wrote no result (a fixed vocabulary; never engine or model output) */
export const FAIRLEARN_TASK_ERRORS = ["job_invalid", "input_unreadable", "sandbox_not_isolated"] as const;
export type FairlearnTaskError = (typeof FAIRLEARN_TASK_ERRORS)[number];

export const fairlearnDoneSchema = z
  .object({
    resultSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    error: z.enum(FAIRLEARN_TASK_ERRORS).nullable(),
  })
  .strict()
  .refine((d) => (d.resultSha256 === null) !== (d.error === null), "a result or an error, never both or neither");
export type FairlearnDone = z.infer<typeof fairlearnDoneSchema>;

/** what one run produced, as the runner read it */
export type FairlearnOutcome =
  | { kind: "result"; result: FairlearnResult; bytes: Buffer; sha256: string }
  /** the task answered, with an error or a result that is not readable as announced (never a pass) */
  | { kind: "unreadable"; errorCode: string }
  | { kind: "timed_out" }
  | { kind: "cancelled" };

/** what a lease's job is handed to (the bridge's exchange; tests substitute their own) */
export interface FairlearnExecutor {
  run(job: FairlearnJob, signal: AbortSignal): Promise<FairlearnOutcome>;
  /** remove every job that is not `keepRunId`'s (at runner start: keep nothing) */
  reconcile(keepRunId: string | null): Promise<string[]>;
}

/** read the task's answer for one job from the results directory (pure file reading; exported for tests) */
export async function collectFairlearnResult(resultsRoot: string, job: Pick<FairlearnJob, "runId" | "evaluationId">): Promise<FairlearnOutcome> {
  if (!isJobRunId(job.runId)) return { kind: "unreadable", errorCode: "result_unreadable" };
  const dir = path.join(resultsRoot, job.runId);
  let done: FairlearnDone;
  try {
    const parsed = fairlearnDoneSchema.safeParse(JSON.parse(await readFile(path.join(dir, FAIRLEARN_DONE_FILE), "utf8")));
    if (!parsed.success) return { kind: "unreadable", errorCode: "done_invalid" };
    done = parsed.data;
  } catch {
    return { kind: "unreadable", errorCode: "done_invalid" };
  }
  if (done.error !== null) return { kind: "unreadable", errorCode: done.error };
  const file = path.join(dir, FAIRLEARN_RESULT_FILE);
  if (!existsSync(file)) return { kind: "unreadable", errorCode: "result_missing" };
  // the bound is checked before the bytes are read, and again on what was read
  if ((await stat(file)).size > FAIRLEARN_LIMITS.maxResultBytes) return { kind: "unreadable", errorCode: "result_too_large" };
  const bytes = await readFile(file);
  if (bytes.length > FAIRLEARN_LIMITS.maxResultBytes) return { kind: "unreadable", errorCode: "result_too_large" };
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== done.resultSha256) return { kind: "unreadable", errorCode: "result_mismatch" };
  let parsed: ReturnType<typeof fairlearnResultSchema.safeParse>;
  try {
    parsed = fairlearnResultSchema.safeParse(JSON.parse(bytes.toString("utf8")));
  } catch {
    return { kind: "unreadable", errorCode: "result_invalid" };
  }
  if (!parsed.success) return { kind: "unreadable", errorCode: "result_invalid" };
  if (parsed.data.runId !== job.runId || parsed.data.evaluationId !== job.evaluationId) return { kind: "unreadable", errorCode: "result_not_this_run" };
  return { kind: "result", result: parsed.data, bytes, sha256 };
}

/** the runner's side of the exchange (the bridge reads `jobsRoot` and writes `resultsRoot`) */
export class ExchangeFairlearnExecutor implements FairlearnExecutor {
  private readonly jobs: JobExchange;
  constructor(
    jobsRoot: string,
    private readonly resultsRoot: string,
    opts: { pollMs?: number; graceMs?: number; cancelGraceMs?: number } = {},
  ) {
    this.jobs = new JobExchange(jobsRoot, resultsRoot, { ...opts, doneFile: FAIRLEARN_DONE_FILE });
  }

  async run(job: FairlearnJob, signal: AbortSignal): Promise<FairlearnOutcome> {
    fairlearnJobSchema.parse(job);
    try {
      const end = await this.jobs.run(
        { runId: job.runId, files: { "job.json": JSON.stringify(job), [FAIRLEARN_GATEWAY_INPUT_MARKER]: fairlearnGatewayInputMarker() }, timeoutMs: job.timeoutMs },
        signal,
      );
      if (end === "cancelled") return { kind: "cancelled" };
      if (end === "timed_out") return { kind: "timed_out" };
      return await collectFairlearnResult(this.resultsRoot, job);
    } finally {
      // the job (and the key in it) goes as soon as the answer is read
      await this.jobs.release(job.runId);
    }
  }

  reconcile(keepRunId: string | null): Promise<string[]> {
    return this.jobs.reconcile(keepRunId);
  }
}
