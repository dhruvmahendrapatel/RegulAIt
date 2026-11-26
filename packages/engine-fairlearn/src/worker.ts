/**
 * ADR-0346 — the TASK's work (the worker side of the exchange, as spikee's worker.ts, ADR-0245).
 *
 * Reached only from code that runs INSIDE an engine task's sandbox (`task-main.ts`) and from tests: it starts the
 * metric process (metrics.ts). The runner's entry point never imports it (`adr0190-i5-engine-runner-no-spawn.test.ts`).
 *
 * One job:
 *   1. read the job (the key and the gateway channel already applied by `prepareJobCopy`) and the GATEWAY's input
 *      file at the task input's root, by its exact bytes (their sha256 goes into the result); the input must parse
 *      against `fairlearnInputSchema` and name this run and this evaluation, else the result's problem is
 *      `input_invalid` and nothing is called;
 *   2. per prompt, in order (one call at a time), the gateway's chat route with the run's key: a 402 or 429 stops the
 *      run (`budget_exhausted`), any other 4xx (a governance refusal) stops it (`gateway_refused`), a 5xx or a failed
 *      call leaves that row unanswered; a reply is mapped by `mapFairnessReply` (exact, trim and case-fold) and
 *      forgotten: no reply's text is ever written, logged or kept beyond the mapping;
 *   3. the parseable rows, less ADR-0222's small groups (`suppressSmallGroups`, the gateway's own function, over the
 *      attribute names in code-point order as `computeFairness` takes them); fewer than two groups left for an
 *      attribute, or no row left, is `too_few_parseable`; else fairlearn's values from the metric step;
 *   4. `result.json` (strict against `fairlearnResultSchema`), then `done.json` last with its sha256.
 * A cancel (the job's cancel file, or the job gone) or the job's time limit stops the calls (`cancelled`,
 * `timed_out`); the predictions so far are still returned.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  FAIRLEARN_INPUT_FILE,
  FAIRLEARN_LIMITS,
  FAIRLEARN_RESULT_VERSION,
  fairlearnInputSchema,
  fairlearnResultSchema,
  mapFairnessReply,
  suppressSmallGroups,
  type FairlearnInput,
  type FairlearnResult,
  type FairlearnRunProblem,
  type FairnessRows,
} from "@regulait/shared";
import { FAIRLEARN_CALL_TIMEOUT_MS, FAIRLEARN_MAX_ANSWER_BYTES, fairlearnChatBody, fairlearnChatUrl } from "./config.js";
import { FAIRLEARN_DONE_FILE, FAIRLEARN_RESULT_FILE, fairlearnJobSchema, type FairlearnDone, type FairlearnJob, type FairlearnTaskError } from "./exchange.js";
import { runFairlearnMetrics, type MetricsCommand } from "./metrics.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface FairlearnWorkOptions {
  /** the HTTP client (tests: a fake gateway is a real local server, so the default fetch is used) */
  fetch?: typeof fetch;
  /** the metric step's command (default: the image's venv python and script) */
  metrics?: MetricsCommand;
  metricsTimeoutMs?: number;
  callTimeoutMs?: number;
}

async function writeAtomic(file: string, content: string | Uint8Array): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, file);
}

/** one call's answer, reduced to what the run may keep */
type CallOutcome = { kind: "reply"; prediction: 1 | 0 | null } | { kind: "stop"; problem: FairlearnRunProblem } | { kind: "unanswered" };

/** the reply text of an OpenAI-compatible chat completion, bounded; null when there is none */
function replyText(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown } | null)?.message;
  const content = message && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
  if (typeof content !== "string" || content.length > FAIRLEARN_LIMITS.maxReplyChars) return null;
  return content;
}

async function callOnce(job: FairlearnJob, prompt: string, outputs: FairlearnInput["outputs"], signal: AbortSignal, timeoutMs: number, doFetch: typeof fetch): Promise<CallOutcome> {
  const call = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  let res: Response;
  try {
    res = await doFetch(fairlearnChatUrl(job.target.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${job.apiKey}`, ...job.target.headers },
      body: JSON.stringify(fairlearnChatBody(job.target.model, prompt)),
      signal: call,
      redirect: "manual",
    });
  } catch {
    return { kind: "unanswered" };
  }
  if (res.status === 402 || res.status === 429) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: "stop", problem: "budget_exhausted" };
  }
  if (res.status >= 300 && res.status < 500) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: "stop", problem: "gateway_refused" };
  }
  if (res.status !== 200 && res.status !== 201) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: "unanswered" };
  }
  try {
    // read as a stream and abandoned past the bound (never buffered whole first)
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (!reader) return { kind: "reply", prediction: null };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > FAIRLEARN_MAX_ANSWER_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { kind: "reply", prediction: null };
      }
      chunks.push(value);
    }
    const text = replyText(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    return { kind: "reply", prediction: text === null ? null : mapFairnessReply(text, outputs) };
  } catch {
    // an answer that does not parse is unparseable, never a decision
    return { kind: "reply", prediction: null };
  }
}

/** the rows fairlearn measures: the parseable ones, less every small group (the gateway's own suppression) */
export function fairlearnKeptRows(input: FairlearnInput, predictions: readonly (0 | 1 | null)[]): { rows: FairnessRows; enough: boolean } {
  const idx = predictions.flatMap((p, i) => (p === null ? [] : [i]));
  const names = Object.keys(input.attributes).sort();
  const parseable: FairnessRows = {
    labels: idx.map((i) => input.labels[i]!),
    predictions: idx.map((i) => predictions[i]!),
    attributes: Object.fromEntries(names.map((n) => [n, idx.map((i) => input.attributes[n]![i]!)])),
  };
  const keep = suppressSmallGroups(parseable, names, input.minGroupSize);
  const pick = <T>(xs: readonly T[]) => xs.filter((_, i) => keep[i]);
  const rows: FairnessRows = {
    labels: pick(parseable.labels),
    predictions: pick(parseable.predictions),
    attributes: Object.fromEntries(names.map((n) => [n, pick(parseable.attributes[n]!)])),
  };
  const enough = rows.labels.length > 0 && names.every((n) => new Set(rows.attributes[n]).size >= 2);
  return { rows, enough };
}

/**
 * One job's work, given the input file's exact bytes: the result to write (always one; its problem says why it
 * carries no metrics). Pure but for the gateway calls and the metric step.
 */
export async function runFairlearnJob(job: FairlearnJob, inputBytes: Uint8Array, signal: AbortSignal, opts: FairlearnWorkOptions & { scratch: string }): Promise<FairlearnResult> {
  const inputSha256 = createHash("sha256").update(inputBytes).digest("hex");
  const base = { v: FAIRLEARN_RESULT_VERSION, runId: job.runId, evaluationId: job.evaluationId, inputSha256 } as const;
  const none = (problem: FairlearnRunProblem, predictions: Array<0 | 1 | null> = []): FairlearnResult => ({ ...base, predictions, fairlearn: null, metrics: null, problem });
  let input: FairlearnInput;
  try {
    if (inputBytes.length > FAIRLEARN_LIMITS.maxInputBytes) return none("input_invalid");
    const parsed = fairlearnInputSchema.safeParse(JSON.parse(Buffer.from(inputBytes).toString("utf8")));
    if (!parsed.success) return none("input_invalid");
    input = parsed.data;
  } catch {
    return none("input_invalid");
  }
  // the gateway's file for THIS run and evaluation, or nothing is called
  if (input.runId !== job.runId || input.evaluationId !== job.evaluationId) return none("input_invalid");

  const until = Date.now() + job.timeoutMs;
  const doFetch = opts.fetch ?? fetch;
  const predictions: Array<0 | 1 | null> = new Array(input.prompts.length).fill(null);
  for (let i = 0; i < input.prompts.length; i++) {
    if (signal.aborted) return none("cancelled", predictions);
    const left = until - Date.now();
    if (left < 1000) return none("timed_out", predictions);
    const o = await callOnce(job, input.prompts[i]!, input.outputs, signal, Math.min(left, opts.callTimeoutMs ?? FAIRLEARN_CALL_TIMEOUT_MS), doFetch);
    if (signal.aborted) return none("cancelled", predictions);
    if (o.kind === "stop") return none(o.problem, predictions);
    if (o.kind === "reply") predictions[i] = o.prediction;
  }

  const { rows, enough } = fairlearnKeptRows(input, predictions);
  if (!enough) return none("too_few_parseable", predictions);
  const left = until - Date.now();
  if (left < 1000) return none("timed_out", predictions);
  const metrics = await runFairlearnMetrics(rows, { signal, scratch: opts.scratch, timeoutMs: Math.min(left, opts.metricsTimeoutMs ?? 120_000), ...(opts.metrics ? { command: opts.metrics } : {}) });
  if (signal.aborted) return none("cancelled", predictions);
  if (!metrics) return none("metrics_failed", predictions);
  return { ...base, predictions, fairlearn: metrics.fairlearn, metrics: metrics.metrics, problem: null };
}

/** read the gateway's input file: a plain file at the input root within the bound, or null */
async function readGatewayInput(inputRoot: string): Promise<Buffer | null> {
  const file = path.join(inputRoot, FAIRLEARN_INPUT_FILE);
  try {
    const st = await lstat(file);
    if (!st.isFile() || st.size > FAIRLEARN_LIMITS.maxInputBytes) return null;
    const bytes = await readFile(file);
    return bytes.length > FAIRLEARN_LIMITS.maxInputBytes ? null : bytes;
  } catch {
    return null;
  }
}

/** answer a job without a result (nothing to measure), so the runner is not left waiting */
export async function writeFairlearnError(outDir: string, error: FairlearnTaskError): Promise<void> {
  await writeAtomic(path.join(outDir, FAIRLEARN_DONE_FILE), JSON.stringify({ resultSha256: null, error } satisfies FairlearnDone));
}

/**
 * The task's one job: `<jobsRoot>/<runId>/job.json` (the scratch copy holding the key), the gateway's file at
 * `<inputRoot>/fairness-input.json`, the answer under `<resultsRoot>/<runId>/`.
 */
export async function runFairlearnTaskWork(
  opts: { runId: string; jobsRoot: string; inputRoot: string; resultsRoot: string; workRoot: string; pollMs?: number; work?: FairlearnWorkOptions },
  log: (m: string) => void = () => undefined,
): Promise<FairlearnResult | null> {
  if (!UUID.test(opts.runId)) throw new Error("invalid run id");
  const outDir = path.join(opts.resultsRoot, opts.runId);
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  let job: FairlearnJob;
  try {
    const parsed = fairlearnJobSchema.safeParse(JSON.parse(await readFile(path.join(opts.jobsRoot, opts.runId, "job.json"), "utf8")));
    if (!parsed.success || parsed.data.runId !== opts.runId) throw new Error("invalid job");
    job = parsed.data;
  } catch {
    await writeFairlearnError(outDir, "job_invalid");
    log(`fairlearn task: job ${opts.runId} is invalid; answered without running`);
    return null;
  }
  const inputBytes = await readGatewayInput(opts.inputRoot);
  if (inputBytes === null) {
    await writeFairlearnError(outDir, "input_unreadable");
    log(`fairlearn task: the gateway's ${FAIRLEARN_INPUT_FILE} is not in the task input`);
    return null;
  }
  const abort = new AbortController();
  const jobDir = path.join(opts.jobsRoot, opts.runId);
  const watch = setInterval(() => {
    if (existsSync(path.join(jobDir, "cancel")) || !existsSync(jobDir)) abort.abort();
  }, opts.pollMs ?? 250);
  let result: FairlearnResult;
  try {
    result = await runFairlearnJob(job, inputBytes, abort.signal, { ...opts.work, scratch: opts.workRoot });
  } finally {
    clearInterval(watch);
  }
  // the result is checked against the shared schema before it is written: never a malformed answer
  const checked = fairlearnResultSchema.parse(result);
  const bytes = Buffer.from(JSON.stringify(checked), "utf8");
  await writeAtomic(path.join(outDir, FAIRLEARN_RESULT_FILE), bytes);
  await writeAtomic(path.join(outDir, FAIRLEARN_DONE_FILE), JSON.stringify({ resultSha256: createHash("sha256").update(bytes).digest("hex"), error: null } satisfies FairlearnDone));
  log(`fairlearn task: run ${opts.runId} answered (${checked.problem ?? "metrics computed"})`);
  return checked;
}
