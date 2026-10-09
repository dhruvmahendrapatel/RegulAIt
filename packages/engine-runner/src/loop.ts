/**
 * ADR-0187 — THE RUNNER'S LIFE, shared by every engine shim: a runner token that survives a
 * restart, and a loop that is an explicit STATE MACHINE driven by one gateway signal.
 *
 * Token (decisions 49, 54 and 72). The runner generates its own token, persists it on its own
 * volume (`FileRunnerTokenStore`: mode 0600, written atomically, never logged) as a PENDING
 * enrolment, together with the token it supersedes, BEFORE it registers, and sends only its hash,
 * so a lost response or a crash loses nothing: a restart that finds a pending enrolment resumes it
 * with the same secret and `supersedes`. The stored token is replaced, and the pending record
 * dropped, only after the gateway answered 201. At start a stored token is used and the enrolment
 * token is ignored. The state volume is never deleted.
 *
 * States (PR #205 review round 5, decision 67 — the table is in the ADR and `transition` below):
 *   enrolling    no credential yet: register with the enrolment token
 *   leasing      retry retained results [68], then lease (presenting the build it runs [67])
 *   refreshing   re-run the self-test and submit it on the runner-token route
 *   waiting      a slow, capped backoff, then lease again (the engine is off by an admin, or a
 *                refused report waits for its cadence, or too many results are retained)
 *   reenrolling  register again with the enrolment token (a build change, or a revoked credential)
 *   stopped      the runner cannot continue without an admin: it says what to do and exits
 *
 * Every lease refusal and every self-test answer carries `next` (`ok`, `admin_disabled`,
 * `self_test_required`, `reenrol_required`, `revoked`); the loop acts on that and nothing else. A
 * 401 without one means `revoked`. A network error, a 5xx, a 408, a 429 or a refusal with no signal
 * is transient: backed off and retried, never a state change of its own.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ENGINE_RUNNER_TOKEN_PREFIX, type EngineRunnerNext, type RunnerSelfTest } from "@regulait/shared";
import { generateRunnerSecret, retryRetainedResults, RunnerHttpError, runOnce, type EngineAdapter, type RunnerClient, type RunOnceOptions } from "./runner.js";

/**
 * PR #205 review round 6 [72]: an enrolment under way — the new secret, and the token it supersedes
 * (a build change) or null. Persisted BEFORE the registration leaves; the stored token is replaced
 * and this record deleted only after the gateway answered 201. A restart that finds one resumes it
 * with the same secret and the same `supersedes` (the gateway replays a same-hash registration).
 */
export interface PendingEnrolment {
  secret: string;
  supersedes: string | null;
}

export interface RunnerTokenStore {
  load(): Promise<string | null>;
  save(token: string): Promise<void>;
  loadPending(): Promise<PendingEnrolment | null>;
  savePending(pending: PendingEnrolment): Promise<void>;
  clearPending(): Promise<void>;
}

const isRunnerToken = (t: unknown): t is string => typeof t === "string" && t.startsWith(ENGINE_RUNNER_TOKEN_PREFIX) && /^[\x21-\x7e]+$/.test(t);

/** write a file atomically, 0600, in a 0700 directory */
async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, content, { mode: 0o600, flag: "wx" });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * The runner token on the runner's own volume: 0600, atomic replace, nothing else in the file. The
 * pending enrolment (round 6 [72]) sits beside it in `<file>.pending`, same mode, same atomic write.
 */
export class FileRunnerTokenStore implements RunnerTokenStore {
  constructor(readonly file: string) {}

  get pendingFile(): string {
    return `${this.file}.pending`;
  }

  async load(): Promise<string | null> {
    const text = await readOrNull(this.file);
    const token = text?.trim() ?? null;
    // a file that does not hold a runner token is not used (and not echoed)
    return isRunnerToken(token) ? token : null;
  }

  async save(token: string): Promise<void> {
    await writeAtomic(this.file, `${token}\n`);
  }

  async loadPending(): Promise<PendingEnrolment | null> {
    const text = await readOrNull(this.pendingFile);
    if (text === null) return null;
    try {
      const p = JSON.parse(text) as { secret?: unknown; supersedes?: unknown };
      if (isRunnerToken(p.secret) && (p.supersedes === null || isRunnerToken(p.supersedes))) return { secret: p.secret, supersedes: p.supersedes };
    } catch {
      // unreadable: treated as absent below
    }
    // a record that is not a valid pending enrolment is never used (fail closed: nothing is registered from it)
    return null;
  }

  async savePending(pending: PendingEnrolment): Promise<void> {
    await writeAtomic(this.pendingFile, JSON.stringify({ secret: pending.secret, supersedes: pending.supersedes }));
  }

  async clearPending(): Promise<void> {
    await rm(this.pendingFile, { force: true });
  }
}

/** the runner cannot continue without an admin (it says what the admin must do) */
export class RunnerFatalError extends Error {}

const UNSET_DIGEST = `sha256:${"0".repeat(64)}`;

/**
 * PR #205 review [55]: the image digest a runner reports. A container cannot prove which image it
 * runs, so this is a CONSISTENCY check, not proof (admission is the signature verification at
 * deploy time): the runner is given the image reference it was started from and the digest, both
 * derived from ONE deploy variable, and refuses to start unless the reference is pinned by digest
 * (no tag), the two agree, and the digest is not the all-zero placeholder.
 */
export function pinnedImageDigest(imageRef: string | undefined, imageDigest: string | undefined): string {
  const m = /^([a-z0-9][a-z0-9._\/:-]*)@(sha256:[0-9a-f]{64})$/.exec(imageRef ?? "");
  if (!m) throw new RunnerFatalError("REGULAIT_ENGINE_IMAGE_REF must name the image by digest (<repository>@sha256:<64 hex>), never by tag");
  if (imageDigest !== m[2]!) throw new RunnerFatalError("REGULAIT_ENGINE_IMAGE_DIGEST must be the digest REGULAIT_ENGINE_IMAGE_REF names (derive both from one variable)");
  if (m[2] === UNSET_DIGEST) throw new RunnerFatalError("the image digest is the unset placeholder: set the deployment's engine digest variable");
  return m[2]!;
}

// ---------------------------------------------------------------------------
// The state machine (pure: the table-driven test pins every row)
// ---------------------------------------------------------------------------

export const RUNNER_STATES = ["enrolling", "leasing", "refreshing", "waiting", "reenrolling", "stopped"] as const;
export type RunnerState = (typeof RUNNER_STATES)[number];

export type RunnerEvent =
  /** the gateway's signal (a lease refusal or a self-test answer; a 200/204 lease is `ok`) */
  | { kind: "next"; next: EngineRunnerNext }
  /** nothing definitive arrived (a network error, a 5xx, a 408, a 429, a refusal with no signal) */
  | { kind: "transient" }
  /** a registration landed */
  | { kind: "enrolled" }
  /** no enrolment token to use, or it was refused: an admin must act */
  | { kind: "enrolment_refused" }
  /** a wait is over */
  | { kind: "wait_over" }
  /** round 5 [68]: too many undelivered results are retained to take more work */
  | { kind: "retention_full" };

export interface TransitionContext {
  /** the self-test cadence allows a submission now (none yet, or the last definitive one is old enough) */
  refreshDue: boolean;
  /** an enrolment token is set and has not been tried by this process */
  enrolmentAvailable: boolean;
}

/** THE TABLE (ADR-0187 decision 67). Anything not named keeps the state. */
export function transition(state: RunnerState, event: RunnerEvent, ctx: TransitionContext): RunnerState {
  if (state === "stopped") return "stopped";
  switch (event.kind) {
    case "enrolled":
      return state === "enrolling" || state === "reenrolling" ? "leasing" : state;
    case "enrolment_refused":
      return state === "enrolling" || state === "reenrolling" ? "stopped" : state;
    case "transient":
      // a lost refresh goes back to leasing (the cadence is not used up); everything else retries itself
      return state === "refreshing" ? "leasing" : state;
    case "wait_over":
      return state === "waiting" ? "leasing" : state;
    case "retention_full":
      return state === "leasing" ? "waiting" : state;
    case "next":
      if (state !== "leasing" && state !== "refreshing") return state;
      switch (event.next) {
        case "ok":
          return "leasing";
        case "admin_disabled":
          return "waiting";
        case "self_test_required":
          // a lease that asks for a report refreshes when the cadence allows; a refused report waits
          return state === "leasing" && ctx.refreshDue ? "refreshing" : "waiting";
        case "reenrol_required":
        case "revoked":
          return ctx.enrolmentAvailable ? "reenrolling" : "stopped";
      }
  }
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

export interface RunnerLoopOptions extends RunOnceOptions {
  store: RunnerTokenStore;
  /** the one-time enrolment token from the environment, or null */
  enrollmentToken: string | null;
  /** what registration reports (built fresh each time: the self-test is current) */
  registration: () => Promise<{ name: string; imageDigest: string; engineVersion: string; selfTest: RunnerSelfTest }>;
  /** the self-test cadence: after a definitive submission, the next one waits this long (default 15 min) */
  selfTestRefreshMs?: number;
  /** round 5 [68]: refuse to lease while this many undelivered results are retained (default 3) */
  maxRetainedResults?: number;
  /** clock seam for tests (ms) */
  now?: () => number;
  /** register attempts on a transient failure, same secret each time (default 5) */
  registerAttempts?: number;
  /** pause when there is no work (default 5 s) */
  idleMs?: number;
  /** first wait after a refusal or an error, doubling up to maxBackoffMs (defaults 5 s and 5 min) */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** stop after this many visits to `leasing` (tests); unset = forever */
  maxIterations?: number;
  sleep?: (ms: number) => Promise<void>;
  /** never receives a token */
  log?: (message: string) => void;
}

const MESSAGE_FIRST =
  "this runner has no stored token and no enrolment token is set: " +
  "mint an enrolment token on the Engines page, set REGULAIT_ENGINE_ENROLLMENT_TOKEN and restart the runner";
const MESSAGE_INTERRUPTED =
  "an enrolment was interrupted (its new secret is kept as a pending enrolment) and it could not be completed: " +
  "set REGULAIT_ENGINE_ENROLLMENT_TOKEN to the token it was started with, or mint a new enrolment token on the Engines page and set that, and restart the runner";
const MESSAGE_REVOKED =
  "the gateway refused this runner's token (revoked or unknown) and no unused enrolment token is set: " +
  "mint a new enrolment token on the Engines page, set REGULAIT_ENGINE_ENROLLMENT_TOKEN and restart the runner";
const MESSAGE_REENROL =
  "this runner's token was registered for another build (the image or engine version changed) and no unused enrolment token is set: " +
  "mint a new enrolment token on the Engines page, set REGULAIT_ENGINE_ENROLLMENT_TOKEN and restart the runner (the old registration is revoked when it re-enrols)";

/** a definitive answer or a transient failure, from anything a runner route threw */
function eventOf(e: unknown): RunnerEvent {
  if (e instanceof RunnerHttpError) {
    if (e.next) return { kind: "next", next: e.next };
    if (e.status === 401) return { kind: "next", next: "revoked" };
  }
  return { kind: "transient" };
}

function whyOf(e: unknown): string {
  return e instanceof RunnerHttpError ? (e.code ?? String(e.status)) : "unreachable";
}

/**
 * Run the state machine until it stops (or for `maxIterations` visits to `leasing`). Throws
 * `RunnerFatalError` with what the admin must do when it stops.
 */
export async function runRunnerLoop(client: RunnerClient, adapter: EngineAdapter, opts: RunnerLoopOptions): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = opts.now ?? Date.now;
  const base = opts.backoffMs ?? 5_000;
  const max = opts.maxBackoffMs ?? 300_000;
  const cadence = opts.selfTestRefreshMs ?? 15 * 60_000;
  const cap = opts.maxRetainedResults ?? 3;

  const stored = await opts.store.load();
  // round 6 [72]: an enrolment interrupted by a crash or a restart is resumed first, with the same
  // secret and the same `supersedes`, so the credential it replaces is still revoked
  const interrupted = await opts.store.loadPending();
  let state: RunnerState = interrupted ? (interrupted.supersedes ? "reenrolling" : "enrolling") : stored ? "leasing" : "enrolling";
  if (stored && !interrupted) {
    client.useToken(stored);
    opts.log?.("using the stored runner token");
  }
  if (interrupted) opts.log?.("resuming an interrupted enrolment");
  /** the credential in use (what a re-enrolment after a build change supersedes) */
  let held: string | null = stored;
  /** the enrolment token is tried at most once per process (it is single-use) */
  let enrolmentTried = !!interrupted;
  /** an enrolment in progress: the same secret, body and `supersedes` on every retry (persisted: round 6 [72]) */
  let pending: { secret: string; body: Awaited<ReturnType<RunnerLoopOptions["registration"]>> | null; supersedes: string | null; attempts: number } | null = interrupted
    ? { secret: interrupted.secret, body: null, supersedes: interrupted.supersedes, attempts: 0 }
    : null;
  /** set when the move to `reenrolling` was for a build change (the held token is then superseded) */
  let supersedeOnReenrol = false;
  let stopMessage = interrupted ? MESSAGE_INTERRUPTED : stored ? MESSAGE_REVOKED : MESSAGE_FIRST;
  let lastRefreshAt: number | null = null;
  let backoff = base;
  let waitingOn: string | null = null;
  let leasingVisits = 0;

  // read through a function: `go` moves the state, so no narrowed copy of it may be trusted
  const current = (): RunnerState => state;
  const go = (event: RunnerEvent, why?: string) => {
    if (event.kind === "next" && (event.next === "reenrol_required" || event.next === "revoked")) {
      supersedeOnReenrol = event.next === "reenrol_required";
      stopMessage = supersedeOnReenrol ? MESSAGE_REENROL : MESSAGE_REVOKED;
    }
    const from = state;
    state = transition(state, event, {
      refreshDue: lastRefreshAt === null || clock() - lastRefreshAt >= cadence,
      enrolmentAvailable: !!opts.enrollmentToken && !enrolmentTried,
    });
    if (from !== state) opts.log?.(`state: ${from} -> ${state}${why ? ` (${why})` : ""}`);
  };
  const backOff = async () => {
    await sleep(backoff);
    backoff = Math.min(max, backoff * 2);
  };

  while (current() !== "stopped") {
    switch (current()) {
      case "enrolling":
      case "reenrolling": {
        if (!opts.enrollmentToken) {
          go({ kind: "enrolment_refused" }, "no enrolment token");
          break;
        }
        if (!pending) {
          if (enrolmentTried) {
            go({ kind: "enrolment_refused" }, "no unused enrolment token");
            break;
          }
          enrolmentTried = true;
          const supersedes = current() === "reenrolling" && supersedeOnReenrol ? held : null;
          // decision 54 / round 6 [72]: the new secret, and the token it supersedes, are persisted as a
          // PENDING enrolment before the request leaves; the stored token is not touched until a 201
          const secret = generateRunnerSecret();
          await opts.store.savePending({ secret, supersedes });
          pending = { secret, body: null, supersedes, attempts: 0 };
        }
        const p = pending;
        try {
          p.body ??= await opts.registration();
          const reg = await client.register(opts.enrollmentToken, p.secret, p.body, p.supersedes ?? undefined);
          // definitive: only now is the stored token replaced and the pending record dropped
          await opts.store.save(p.secret);
          await opts.store.clearPending();
          opts.log?.(
            `registered runner ${reg.runnerId}${reg.replayed ? " (replayed)" : ""}${reg.supersededRunnerId ? `; the previous registration ${reg.supersededRunnerId} is revoked` : ""}; ` +
              `self-test ${reg.selfTest.passed ? "passed" : `failed: ${reg.selfTest.failures.join(", ")}`}`,
          );
          held = p.secret;
          pending = null;
          lastRefreshAt = null;
          backoff = base;
          go({ kind: "enrolled" });
        } catch (e) {
          const transient = !(e instanceof RunnerHttpError) || e.status >= 500 || e.status === 408 || e.status === 429;
          p.attempts++;
          if (!transient || p.attempts >= (opts.registerAttempts ?? 5)) {
            stopMessage =
              e instanceof RunnerHttpError && e.status === 401
                ? `the enrolment token was refused (${e.code ?? "401"}: spent, expired or for another engine); ${stopMessage}`
                : `registration did not succeed (${whyOf(e)}); ${stopMessage}`;
            go({ kind: "enrolment_refused" }, whyOf(e));
            break;
          }
          await sleep(Math.min(30_000, base * 2 ** (p.attempts - 1)));
          go({ kind: "transient" });
        }
        break;
      }

      case "leasing": {
        if (opts.maxIterations !== undefined && leasingVisits >= opts.maxIterations) return;
        leasingVisits++;
        // round 5 [68]: retained results are delivered (or dropped) before any new work
        const retained = await retryRetainedResults(client, opts.workRoot, { now: clock, ...(opts.log ? { log: opts.log } : {}) });
        if (retained >= cap) {
          if (waitingOn !== "retention_full") opts.log?.(`waiting: ${retained} undelivered results are retained; no new work until they are delivered`);
          waitingOn = "retention_full";
          go({ kind: "retention_full" }, "retention_full");
          break;
        }
        try {
          const r = await runOnce(client, adapter, opts);
          backoff = base;
          lastRefreshAt = null;
          if (waitingOn) opts.log?.(`lease accepted again (was ${waitingOn})`);
          waitingOn = null;
          if (r.outcome === "idle") await sleep(opts.idleMs ?? 5_000);
          else opts.log?.(`run ${r.runId}: ${r.outcome}${r.status ? ` (${r.status})` : ""}`);
          go({ kind: "next", next: "ok" });
        } catch (e) {
          const event = eventOf(e);
          const why = event.kind === "next" ? event.next : whyOf(e);
          if (why !== waitingOn) opts.log?.(event.kind === "next" ? `lease refused: ${why}` : `lease failed (${why}); retrying`);
          waitingOn = why;
          if (event.kind === "transient") await backOff();
          go(event, why);
        }
        break;
      }

      case "refreshing": {
        try {
          const verdict = await client.submitSelfTest((await opts.registration()).selfTest);
          lastRefreshAt = clock();
          opts.log?.(`submitted a fresh self-test: ${verdict.passed ? "passed" : `failed: ${verdict.failures.join(", ")}`}`);
          go({ kind: "next", next: verdict.next ?? (verdict.passed ? "ok" : "self_test_required") }, verdict.next ?? undefined);
        } catch (e) {
          const event = eventOf(e);
          if (event.kind === "transient") {
            opts.log?.(`could not submit a fresh self-test (${whyOf(e)}); will retry`);
            await backOff();
          } else {
            lastRefreshAt = clock();
          }
          go(event, event.kind === "next" ? event.next : whyOf(e));
        }
        break;
      }

      case "waiting": {
        await backOff();
        go({ kind: "wait_over" });
        break;
      }
    }
  }
  throw new RunnerFatalError(stopMessage);
}
