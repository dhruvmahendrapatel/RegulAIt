/**
 * ADR-0346 — THE FAIRLEARN PLAN, JOB AND INVOCATION (as spikee's config.ts, ADR-0245).
 *
 * A fairness evaluation run names exactly one set and one param (packages/shared/src/engines/fairlearn.ts):
 *
 *   sets:   ["fairlearn:group-metrics"]
 *   params: { evaluationId: "<uuid>" }
 *
 * The runner never sees the rows: the GATEWAY places `fairness-input.json` at the task input's root (the ADR-0242
 * subject-file pattern). The runner's job carries only the run, the evaluation, the target behind the gateway, the
 * run's key (which the task bridge takes out as the task secret) and the time limit; next to it the runner writes the
 * marker `gateway-input.json` (`{"path":"fairness-input.json"}`) that asks the bridge for the gateway's file.
 *
 * In the sandbox the task calls only the gateway's OpenAI-compatible chat route (one call per prompt, a single user
 * message, temperature 0, FAIRLEARN_LIMITS.maxTokens) and starts exactly one process,
 *
 *   /opt/fairlearn/venv/bin/python -I -B -c <boot> <rows file> /opt/fairlearn/fairlearn_metrics.py
 *
 * (the boot gives the script the rows file as its stdin; the script writes the metrics on stdout)
 * with an environment of PATH and the usage-data switches only. Nothing here does I/O.
 */
import { FAIRLEARN_INPUT_FILE, FAIRLEARN_LIMITS, FAIRLEARN_SET, FAIRLEARN_USAGE_DATA_ENV, fairlearnConfigProblem, fairlearnEvaluationIdOf, type EngineLease } from "@regulait/shared";

/** the marker next to job.json that asks the task bridge to have the gateway place its input file at the input root */
export const FAIRLEARN_GATEWAY_INPUT_MARKER = "gateway-input.json";

/** the marker's exact content */
export function fairlearnGatewayInputMarker(): string {
  return JSON.stringify({ path: FAIRLEARN_INPUT_FILE });
}

/** the image's paths (engines/fairlearn/Dockerfile installs them; image.test.ts checks it) */
export const FAIRLEARN_IMAGE_PATHS = Object.freeze({
  venv: "/opt/fairlearn/venv",
  python: "/opt/fairlearn/venv/bin/python",
  script: "/opt/fairlearn/fairlearn_metrics.py",
});

/**
 * The metric step's boot line: the rows file (argv[1]) becomes the script's stdin, and the script (argv[2]) runs as
 * `__main__` with only its own name in argv. Fixed text; nothing of a run's reaches it but the two paths.
 */
export const FAIRLEARN_METRICS_BOOT = "import runpy, sys; sys.stdin = open(sys.argv[1], encoding='utf-8'); sys.argv = [sys.argv[2]]; runpy.run_path(sys.argv[0], run_name='__main__')";

/** the metric step's argv (after the interpreter), before the rows file and the script: isolated, no bytecode, the boot */
export function fairlearnMetricsArgs(): string[] {
  return ["-I", "-B", "-c", FAIRLEARN_METRICS_BOOT];
}

/** the PATH the metric process sees (the venv first; nothing else is inherited) */
export const FAIRLEARN_METRICS_PATH = `${FAIRLEARN_IMAGE_PATHS.venv}/bin:/usr/local/bin:/usr/bin:/bin`;

/** the metric process's WHOLE environment: PATH and the usage-data switches, nothing else (no key, no proxy) */
export function fairlearnMetricsEnv(pathVar: string = FAIRLEARN_METRICS_PATH): Record<string, string> {
  return { PATH: pathVar, ...FAIRLEARN_USAGE_DATA_ENV };
}

/** the metric step's time limit (four metrics on at most 2000 rows: well under a second) */
export const FAIRLEARN_METRICS_TIMEOUT_MS = 120_000;
/** the most stdout the metric step may write (five attributes of four numbers) */
export const FAIRLEARN_METRICS_MAX_STDOUT = 64 * 1024;
/** one gateway call's time limit */
export const FAIRLEARN_CALL_TIMEOUT_MS = 120_000;
/** the most bytes of one gateway answer read (a chat completion of 16 tokens is a few hundred bytes) */
export const FAIRLEARN_MAX_ANSWER_BYTES = 256 * 1024;

export class FairlearnConfigRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface FairlearnTarget {
  baseUrl: string;
  model: string;
  headers: Record<string, string>;
}

const MODEL_RE = /^[\x21-\x7e]{1,200}$/;
export const HEADER_NAME_RE = /^x-regulait-[a-z-]{1,40}$/;
const HEADER_VALUE_RE = /^[\x21-\x7e]{1,200}$/;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** the gateway's chat route under its OpenAI-compatible base (`.../v1`) */
export function fairlearnChatUrl(baseUrl: string): string {
  let end = baseUrl.length;
  while (end > 0 && baseUrl.charCodeAt(end - 1) === 0x2f) end--;
  return `${baseUrl.slice(0, end)}/chat/completions`;
}

/**
 * The target, checked: the gateway reached over http(s) with no credentials in the URL, a printable model name, and
 * only the gateway's own `x-regulait-*` headers (no URL as a value). Throws `FairlearnConfigRefused`.
 */
export function checkFairlearnTarget(target: FairlearnTarget): FairlearnTarget {
  let base: URL;
  try {
    base = new URL(target.baseUrl);
  } catch {
    throw new FairlearnConfigRefused("gateway_url_invalid", "the lease's base URL is not a URL");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new FairlearnConfigRefused("gateway_url_invalid", "the gateway is reached over http(s)");
  if (base.username || base.password || base.search || base.hash) throw new FairlearnConfigRefused("gateway_url_invalid", "the gateway URL carries no credentials, query or fragment");
  if (!MODEL_RE.test(target.model)) throw new FairlearnConfigRefused("model_invalid", "a model name must be printable with no spaces");
  for (const [k, v] of Object.entries(target.headers)) {
    if (!HEADER_NAME_RE.test(k) || !HEADER_VALUE_RE.test(v) || URL_RE.test(v)) throw new FairlearnConfigRefused("header_invalid", "only the gateway's own x-regulait headers may be sent");
  }
  return { baseUrl: target.baseUrl, model: target.model, headers: { ...target.headers } };
}

/** the one request body of a row: one user message, deterministic, a one-word budget */
export function fairlearnChatBody(model: string, prompt: string): Record<string, unknown> {
  return { model, messages: [{ role: "user", content: prompt }], max_tokens: FAIRLEARN_LIMITS.maxTokens, temperature: 0, stream: false };
}

/** the run's plan: its evaluation, or why it does not run (a config the shared contract refuses) */
export type FairlearnPlan = { evaluationId: string; problem: null } | { evaluationId: null; problem: string };

export function planFairlearnRun(config: { sets: readonly string[]; params?: Readonly<Record<string, unknown>> }): FairlearnPlan {
  const problem = fairlearnConfigProblem(config);
  if (problem !== null) return { evaluationId: null, problem };
  return { evaluationId: fairlearnEvaluationIdOf(config), problem: null };
}

/** the envelope's key of the run's one set when it does not run */
export const FAIRLEARN_NOT_RUN_KEY = FAIRLEARN_SET;

/** the job a lease becomes (validated again by the task) */
export function fairlearnJobOf(lease: EngineLease, evaluationId: string, timeoutMs: number) {
  if (!lease.target) throw new FairlearnConfigRefused("target_required", "a fairlearn run needs the card's model behind the gateway");
  const target = checkFairlearnTarget({ baseUrl: lease.target.baseUrl, model: lease.target.model, headers: lease.target.headers });
  return { runId: lease.runId, evaluationId, target, apiKey: lease.target.apiKey, timeoutMs };
}
