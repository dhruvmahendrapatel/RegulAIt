/**
 * RegulAIt-OWNED retry and backoff for outbound upstream calls — the third and
 * last piece of ADR-0126's resilience story, after the deadlines (timeouts.ts)
 * and the circuit breaker (upstream-breaker.ts).
 *
 * ── WHAT WAS ACTUALLY THERE BEFORE, MEASURED ───────────────────────────────
 * Not "nothing". The model SDKs retry twice on their own (`maxRetries: 2` in
 * `packages/model-provider/src/index.ts`), which is why the honest description
 * of the gap is narrower than "no retries": every outbound **MCP** call —
 * `connect`, `tools/list`, `tools/call` — was attempted exactly once, and the
 * retries that did exist were a vendor SDK's, with the vendor's backoff, on the
 * vendor's idea of what is retryable, invisible to this product's breaker and
 * unattached to this product's deadlines. This file gives the MCP path a retry
 * policy that is ours: our classifier, our jitter, our budget.
 *
 * ── THE RULE THAT SHAPES EVERYTHING ELSE: A RETRY IS AN IDEMPOTENCE CLAIM ──
 * A retry is not a reliability feature, it is an assertion that running the
 * operation twice is indistinguishable from running it once. For MCP that
 * assertion is true of `connect` and `tools/list` — a handshake and a manifest
 * read — and **it is not true of `tools/call`**, which is an arbitrary
 * side-effecting operation on somebody else's system. A blind retry there can
 * open two pull requests, send two messages, charge two cards; worse, it does
 * so exactly when the network is unreliable, which is exactly when nobody is
 * watching closely.
 *
 * Every tools/call gets one attempt, including tools marked readOnlyHint.
 * That upstream annotation is not an idempotency contract: a handler may have
 * completed before its response was lost. Replay needs operator authorization
 * and upstream deduplication, neither of which this protocol path provides.
 *
 * ── RETRIES NEVER EXTEND THE BOUND AN OPERATOR SET ─────────────────────────
 * The naive wrapper multiplies the deadline by the attempt count: a 10s connect
 * bound with 3 attempts is a 30s wait, and the number in `timeouts.ts` that an
 * operator read and approved has quietly become a third of the truth. So the
 * budget for a whole retry sequence **is** the operation's configured deadline,
 * and each attempt gets whatever is left of it. Two consequences follow, and
 * both are wanted:
 *
 *   - a fast failure (connection refused, reset, 503) leaves nearly all of the
 *     budget, so it is retried — which is the case retries actually help;
 *   - a DEADLINE EXCEEDED is never retried, because waiting the full bound the
 *     operator chose and then waiting it again is not resilience, it is
 *     ignoring the bound. `classifyUpstreamError` says this explicitly rather
 *     than leaving it to emerge from the arithmetic, so it can be tested.
 *
 * ── OUR OWN REFUSALS ARE NEVER RETRIED ─────────────────────────────────────
 * The same distinction the breaker and the health probe make. An egress block
 * (ADR-0043) or an admission hold (ADR-0097) is an adjudication this gateway
 * made; retrying it re-runs a decision whose inputs have not changed, three
 * times, and tells an operator reading latency that the network is flaky when
 * the manifest is dirty. Both exit on the first attempt.
 *
 * ── HOW IT COMPOSES WITH THE BREAKER (one sequence = one failure) ──────────
 * The breaker opens after `failureThreshold` **consecutive failures**, and that
 * threshold was chosen against a unit: one user-visible failed operation. This
 * wrapper therefore re-throws the last error and records nothing itself — the
 * call site still calls `recordUpstreamFailure` exactly once, after the whole
 * sequence is exhausted. Counting per attempt would silently redefine "five
 * consecutive failures is a pattern" as "two failed requests", making the
 * breaker three times more trigger-happy without anybody changing its config.
 *
 * The bounded cost of that choice, stated rather than hidden: the upstream now
 * sees up to `maxAttempts` contacts per failed operation, so the contacts
 * needed to open a breaker rise from `failureThreshold` to
 * `failureThreshold * maxAttempts` (5 → 15 at the defaults). That is the
 * amplification ceiling, it is bounded by the breaker rather than by a second
 * quota mechanism, and a cross-request retry quota was deliberately NOT added:
 * the breaker already is one, and two mechanisms rationing the same thing is
 * two things to keep in step.
 *
 * ── WHY NO AUDIT ROW PER RETRY ─────────────────────────────────────────────
 * Verbatim the breaker's reasoning: a row per attempt turns one upstream outage
 * into thousands of near-identical entries and buries the transitions an
 * auditor is looking for. Instead the caller may pass a `RetryReport`, and the
 * failure row it already writes carries `attempts` and `retryDelaysMs` — so the
 * ledger says "we tried three times over 1.4s" on the one row that exists,
 * rather than on three rows that did not.
 */
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpAdmissionHeldError } from "./mcp-admission.js";
import { McpEgressBlockedError } from "./mcp-egress.js";

export interface RetryConfig {
  /**
   * TOTAL attempts including the first, for an operation that is safe to
   * repeat. 1 disables retrying entirely and restores pre-ADR-0128 behaviour
   * exactly, which is what an operator who distrusts this file should set.
   */
  maxAttempts: number;
  /** first backoff, doubled per attempt before jitter */
  baseDelayMs: number;
  /** ceiling on one backoff, before jitter */
  maxDelayMs: number;
}

export const RETRY_DEFAULTS: Readonly<RetryConfig> = Object.freeze({
  // Three, not five. The failures a retry fixes — a reset during a redeploy, a
  // momentary 503 behind a load balancer — are overwhelmingly fixed by the
  // FIRST retry; beyond that the marginal success rate collapses while the load
  // on a struggling upstream keeps rising. Three is one free recovery plus one
  // benefit of the doubt.
  maxAttempts: 3,
  // Short, because the budget is the operation's deadline and sleeping is
  // spending it. A connect deadline is 10s at the defaults, so two backoffs
  // averaging ~150ms each is noise against it.
  baseDelayMs: 100,
  maxDelayMs: 2_000,
});

function envInt(env: NodeJS.ProcessEnv, key: string, dflt: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return dflt;
  const n = Number(raw);
  // Same posture as timeouts.ts and the breaker: a malformed value is a
  // deployment mistake, and falling back to a default would hide it at exactly
  // the moment an operator believed they had configured something.
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`${key} must be a number >= 1, got: ${raw}`);
  }
  return Math.floor(n);
}

export function resolveRetryConfig(
  env: NodeJS.ProcessEnv = process.env,
  override: Partial<RetryConfig> = {},
): RetryConfig {
  return {
    maxAttempts: envInt(env, "REGULAIT_UPSTREAM_RETRY_ATTEMPTS", RETRY_DEFAULTS.maxAttempts),
    baseDelayMs: envInt(env, "REGULAIT_UPSTREAM_RETRY_BASE_MS", RETRY_DEFAULTS.baseDelayMs),
    maxDelayMs: envInt(env, "REGULAIT_UPSTREAM_RETRY_MAX_DELAY_MS", RETRY_DEFAULTS.maxDelayMs),
    ...override,
  };
}

/** Module singleton, for the same reason timeouts.ts has one: the policy is
 *  needed deep inside `connectUpstream` and `syncUpstreamTools`, on paths
 *  reached from the proxy route, the admission rescan, the registry sync, the
 *  health probe and the copilot. The setter exists so a test can pin attempts
 *  without `process.env`. */
let active: RetryConfig = resolveRetryConfig();
export function retryConfig(): RetryConfig {
  return active;
}
export function setRetryConfig(cfg: RetryConfig): void {
  active = cfg;
}

/**
 * Is this failure a DEADLINE rather than a refusal?
 *
 * MOVED HERE from `mcp-proxy.ts`, where it was private, because the retry
 * classifier and the 502-vs-504 decision must not be allowed to disagree about
 * what a timeout is — one of them deciding "reset" and the other "timeout" for
 * the same error would mean a retried call reported as unreachable, or an
 * unreachable one silently retried past its bound.
 *
 * Three shapes reach here and they come from different layers, which is why
 * this is a predicate and not an `instanceof`: `AbortSignal.timeout` rejects
 * with a DOMException named `TimeoutError`, the MCP SDK raises `McpError` with
 * `ErrorCode.RequestTimeout` (-32001) when ITS timer fires first, and undici
 * surfaces some connect deadlines as an `Error` whose `cause.code` is one of
 * the ETIMEDOUT family.
 */
export function isDeadlineError(err: unknown): boolean {
  if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) return true;
  const e = err as { name?: string; code?: unknown; cause?: { code?: unknown } } | null;
  if (!e) return false;
  if (e.name === "TimeoutError" || e.name === "AbortError") return true;
  const code = e.code ?? e.cause?.code;
  return code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT";
}

/**
 * Network-level failures where a second attempt is genuinely a different roll
 * of the dice. Every one of these means the request did not reach a peer that
 * answered, or the connection died mid-flight — a redeploy, a reaped keep-alive
 * socket, a DNS server having a moment.
 */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
]);

/**
 * HTTP statuses worth a second attempt.
 *
 * 501 and 505 are absent on purpose: "not implemented" will not become
 * implemented in 200ms, and retrying it is pure load. 429 IS here — it is the
 * one status that explicitly means "later" — but note the honest limitation
 * below: the SDK's error carries the status and not the headers, so a
 * `Retry-After` the upstream sent is not visible to us and our own backoff is
 * used instead. That is a real gap; it is small because the backoff is bounded
 * and the breaker catches a persistently throttling upstream.
 */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504, 507, 509]);

export interface RetryVerdict {
  retryable: boolean;
  /** a stable machine-readable reason, so a test asserts the RULE that fired
   *  and not merely the boolean it produced */
  why:
    | "our_own_refusal"
    | "deadline_spent_the_budget"
    | "transient_network"
    | "transient_status"
    | "permanent_status"
    | "unrecognised";
}

/**
 * Should this error be retried at all? Ordered most-specific first, and the
 * order is load-bearing: our own refusals are checked before anything can
 * mistake them for a network fault, and a deadline is checked before the
 * transient-network codes because `ETIMEDOUT` appears in both vocabularies and
 * only one of those readings respects the operator's bound.
 */
export function classifyUpstreamError(err: unknown): RetryVerdict {
  // OURS, not theirs. An adjudication does not become a different adjudication
  // because it is asked again.
  if (err instanceof McpEgressBlockedError || err instanceof McpAdmissionHeldError) {
    return { retryable: false, why: "our_own_refusal" };
  }
  // We already waited exactly as long as the operator said to wait.
  if (isDeadlineError(err)) {
    return { retryable: false, why: "deadline_spent_the_budget" };
  }
  if (err instanceof StreamableHTTPError && typeof err.code === "number" && err.code > 0) {
    return TRANSIENT_STATUSES.has(err.code)
      ? { retryable: true, why: "transient_status" }
      : { retryable: false, why: "permanent_status" };
  }
  const e = err as { code?: unknown; cause?: { code?: unknown }; message?: string } | null;
  const code = e?.code ?? e?.cause?.code;
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) {
    return { retryable: true, why: "transient_network" };
  }
  // Node's oldest and least structured network failure: `socket hang up` with
  // no code at all. Recognised by message because there is nothing else to
  // recognise it by, and it is the single most common transient MCP failure
  // behind a proxy that reaps idle connections.
  if (typeof e?.message === "string" && e.message.includes("socket hang up")) {
    return { retryable: true, why: "transient_network" };
  }
  // DEFAULT IS DO-NOT-RETRY. An error we cannot name might be a protocol
  // violation, a bad argument, or a refusal; repeating it is a guess made at an
  // upstream's expense. The conservative default here matches `toolKind`'s.
  return { retryable: false, why: "unrecognised" };
}

/**
 * FULL jitter — `random() * min(maxDelay, base * 2^n)` — not equal jitter and
 * not a fixed delay. With a fixed delay, N callers that failed together retry
 * together forever; full jitter is the variant that measurably spreads a
 * recovering herd widest, which is the only property that matters when the
 * thing being protected is an upstream that just fell over.
 *
 * PURE, with the rng injected, so a test asserts the schedule rather than
 * observing a random one.
 */
export function backoffDelayMs(
  attemptIndex: number,
  cfg: RetryConfig = active,
  rng: () => number = Math.random,
): number {
  const ceiling = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** attemptIndex);
  return Math.floor(rng() * ceiling);
}

/** What a caller learns about a sequence it did not watch. Filled in place so
 *  the value survives a throw — the failure path is the one that most needs to
 *  say how hard we tried. */
export interface RetryReport {
  attempts: number;
  delaysMs: number[];
  /** why the LAST error was or was not retried; null before anything failed */
  lastWhy: RetryVerdict["why"] | null;
}

export function newRetryReport(): RetryReport {
  return { attempts: 0, delaysMs: [], lastWhy: null };
}

/**
 * Tool classification never authorizes replay after an ambiguous failure.
 * Keep the arguments for callers, but fail closed for every classification.
 */
export function attemptsForToolKind(
  _kind: "read" | "write" | null | undefined,
  _cfg: RetryConfig = active,
): number {
  return 1;
}

const sleepReal = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
  /**
   * The WHOLE sequence's budget in milliseconds — normally the operation's
   * configured deadline from `timeouts.ts`. Attempts and backoffs are spent
   * from it, and it is never exceeded.
   */
  budgetMs: number;
  /** total attempts allowed; callers pass `attemptsForToolKind(...)` for a
   *  tools/call and the config default for an idempotent operation */
  maxAttempts?: number;
  cfg?: RetryConfig;
  report?: RetryReport;
  /** injected for tests: a deterministic schedule, and no real waiting */
  rng?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Run `fn` up to `maxAttempts` times within one budget, and re-throw the LAST
 * error if every attempt failed.
 *
 * `fn` receives the deadline it may use, which is what is left of the budget —
 * so the caller passes it to the SDK rather than re-reading `timeouts()`, and a
 * second attempt cannot overrun the first's bound.
 *
 * Re-throwing the last error, unwrapped, is deliberate: every call site already
 * distinguishes `McpEgressBlockedError`, `McpAdmissionHeldError` and a deadline
 * to choose its own status code, and a wrapper error would have broken all of
 * them at once, for the benefit of a stack trace nobody reads.
 */
export async function withUpstreamRetry<T>(
  fn: (attempt: { index: number; deadlineMs: number }) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const cfg = opts.cfg ?? active;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? cfg.maxAttempts);
  const rng = opts.rng ?? Math.random;
  const sleep = opts.sleep ?? sleepReal;
  const now = opts.now ?? Date.now;
  const report = opts.report;
  const startedAt = now();
  const remaining = () => opts.budgetMs - (now() - startedAt);

  let lastErr: unknown;
  for (let index = 0; index < maxAttempts; index += 1) {
    const deadlineMs = remaining();
    // Budget gone. Only reachable on a later attempt — the first always gets
    // the full budget, so an operation never fails for want of time it was
    // never given.
    if (index > 0 && deadlineMs <= 0) break;
    if (report) report.attempts = index + 1;

    try {
      return await fn({ index, deadlineMs: Math.max(1, deadlineMs) });
    } catch (err) {
      lastErr = err;
      const verdict = classifyUpstreamError(err);
      if (report) report.lastWhy = verdict.why;
      if (!verdict.retryable) throw err;
      if (index === maxAttempts - 1) break;

      // A backoff never eats more than HALF of what is left. Sleeping out the
      // remainder of the budget and then giving up for want of time is
      // strictly worse than trying again immediately, so when the budget is
      // nearly spent the wait shrinks instead of the attempt disappearing.
      const left = remaining();
      if (left <= 0) break;
      const delayMs = Math.min(backoffDelayMs(index, cfg, rng), Math.floor(left / 2));
      if (report) report.delaysMs.push(delayMs);
      if (delayMs > 0) await sleep(delayMs);
    }
  }
  throw lastErr;
}
