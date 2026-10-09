/**
 * ADR-0187 decisions 48 and 49 (PR #205 review) — THE RUNNER'S LIFE, shared by every engine shim:
 * a runner token that survives a restart, and a loop that waits instead of dying.
 *
 * Token (decision 49). The enrolment token is single-use, so a runner that kept its runner token
 * only in memory was bricked by any restart. The token registration returns is now written to a
 * file on the runner's own volume (`FileRunnerTokenStore`: mode 0600, written atomically, never
 * logged). At start, a stored token is used and the enrolment token is ignored. Only when the
 * gateway refuses the stored token (401: revoked or unknown) is the enrolment token tried, once;
 * if there is none, or it is refused too (spent, expired), the runner stops with a message saying
 * what the admin must do. The gateway still refuses a second registration with the same enrolment
 * token.
 *
 * Loop (decision 48). The documented flow is register → the admin enables the engine; until then
 * a lease answers 409 `engine_disabled` (or `engine_self_test_required` while the self-test is
 * stale). Those are WAITING states: the loop backs off (doubling, capped) and keeps leasing. A
 * network error or a 5xx is retried the same way. Only a refused credential with no way to
 * re-enrol ends the process.
 *
 * Self-test (decision 53). After 24 hours the lease refuses the runner's report
 * (`engine_self_test_required`); the loop re-runs the self-test, submits it on the runner-token
 * route, and leases again at once if the gateway accepted it (at most once per refusal streak).
 *
 * Enrolment (decision 54). The runner generates its own token, persists it, then registers only
 * its hash, so nothing secret comes back and a lost response is recoverable (see `enrol`).
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ENGINE_RUNNER_TOKEN_PREFIX, type RunnerSelfTest } from "@regulait/shared";
import { generateRunnerSecret, RunnerHttpError, runOnce, type EngineAdapter, type RunnerClient, type RunOnceOptions } from "./runner.js";

/** lease refusals that mean "wait": the engine is off, or its self-test must be refreshed */
export const LEASE_WAIT_CODES: ReadonlySet<string> = new Set(["engine_disabled", "engine_self_test_required"]);

export interface RunnerTokenStore {
  load(): Promise<string | null>;
  save(token: string): Promise<void>;
}

/** the runner token on the runner's own volume: 0600, atomic replace, nothing else in the file */
export class FileRunnerTokenStore implements RunnerTokenStore {
  constructor(readonly file: string) {}

  async load(): Promise<string | null> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    const token = text.trim();
    // a file that does not hold a runner token is not used (and not echoed)
    return token.startsWith(ENGINE_RUNNER_TOKEN_PREFIX) && /^[\x21-\x7e]+$/.test(token) ? token : null;
  }

  async save(token: string): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, `${token}\n`, { mode: 0o600, flag: "wx" });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
  }
}

/** the runner cannot continue without an admin (a refused credential and nothing to re-enrol with) */
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

export interface RunnerLoopOptions extends RunOnceOptions {
  store: RunnerTokenStore;
  /** the one-time enrolment token from the environment, or null */
  enrollmentToken: string | null;
  /** what registration reports (built fresh each time: the self-test is current) */
  registration: () => Promise<{ name: string; imageDigest: string; engineVersion: string; selfTest: RunnerSelfTest }>;
  /** register attempts on a transient failure, same secret each time (default 5) */
  registerAttempts?: number;
  /** pause when there is no work (default 5 s) */
  idleMs?: number;
  /** first wait after a refusal or an error, doubling up to maxBackoffMs (defaults 5 s and 5 min) */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** stop after this many lease attempts (tests); unset = forever */
  maxIterations?: number;
  sleep?: (ms: number) => Promise<void>;
  /** never receives a token */
  log?: (message: string) => void;
}

const MESSAGE_NO_ENROLMENT =
  "the gateway refused this runner's stored token (revoked or unknown) and no usable enrolment token is set: " +
  "mint a new enrolment token on the Engines page, set REGULAIT_ENGINE_ENROLLMENT_TOKEN and restart the runner";

/**
 * PR #205 review [54]: enrol with a runner token the runner generates itself and PERSISTS BEFORE
 * calling register (only its hash is sent; nothing secret comes back). A lost response loses
 * nothing: a transient failure is retried with the same secret (the gateway answers a replay of
 * the same enrolment token and hash with the same runner), and after a crash the stored secret is
 * the credential if the registration landed — or is refused (401) and replaced if it did not.
 */
async function enrol(client: RunnerClient, opts: RunnerLoopOptions, sleep: (ms: number) => Promise<void>): Promise<void> {
  if (!opts.enrollmentToken) throw new RunnerFatalError(MESSAGE_NO_ENROLMENT);
  const secret = generateRunnerSecret();
  await opts.store.save(secret);
  const body = await opts.registration();
  let reg: Awaited<ReturnType<RunnerClient["register"]>> | null = null;
  for (let attempt = 1; reg === null; attempt++) {
    try {
      reg = await client.register(opts.enrollmentToken, secret, body);
    } catch (e) {
      if (e instanceof RunnerHttpError && e.status === 401) {
        throw new RunnerFatalError(`the enrolment token was refused (${e.code ?? "401"}: spent, expired or for another engine); ${MESSAGE_NO_ENROLMENT}`);
      }
      const transient = !(e instanceof RunnerHttpError) || e.status >= 500 || e.status === 408 || e.status === 429;
      if (!transient || attempt >= (opts.registerAttempts ?? 5)) throw e;
      await sleep(Math.min(30_000, (opts.backoffMs ?? 5_000) * 2 ** (attempt - 1)));
    }
  }
  opts.log?.(`registered runner ${reg.runnerId}${reg.replayed ? " (replayed)" : ""}; self-test ${reg.selfTest.passed ? "passed" : `failed: ${reg.selfTest.failures.join(", ")}`}`);
}

/** PR #205 review [53]: re-run the self-test and submit it; true when the gateway accepted a passing report */
async function refreshSelfTest(client: RunnerClient, opts: RunnerLoopOptions): Promise<boolean> {
  try {
    const verdict = await client.submitSelfTest((await opts.registration()).selfTest);
    opts.log?.(`submitted a fresh self-test: ${verdict.passed ? "passed" : `failed: ${verdict.failures.join(", ")}`}`);
    return verdict.passed;
  } catch (e) {
    if (e instanceof RunnerHttpError && e.status === 401) throw e;
    opts.log?.(`could not submit a fresh self-test (${e instanceof RunnerHttpError ? (e.code ?? e.status) : "unreachable"})`);
    return false;
  }
}

/**
 * Connect (stored token first, enrolment only without one), then lease and run forever (or for
 * `maxIterations`). Throws `RunnerFatalError` only when the credential is refused and cannot be
 * replaced.
 */
export async function runRunnerLoop(client: RunnerClient, adapter: EngineAdapter, opts: RunnerLoopOptions): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = opts.backoffMs ?? 5_000;
  const max = opts.maxBackoffMs ?? 300_000;
  const stored = await opts.store.load();
  // set once the enrolment token has been spent (or found unusable) in this process
  let enrolled = false;
  if (stored) {
    client.useToken(stored);
    opts.log?.("using the stored runner token");
  } else {
    await enrol(client, opts, sleep);
    enrolled = true;
  }
  let backoff = base;
  let waitingOn: string | null = null;
  // a fresh self-test is submitted at most once per refusal streak (no tight loop when it fails)
  let refreshedSinceAccepted = false;
  for (let i = 0; opts.maxIterations === undefined || i < opts.maxIterations; i++) {
    try {
      const r = await runOnce(client, adapter, opts);
      backoff = base;
      refreshedSinceAccepted = false;
      if (waitingOn) opts.log?.(`lease accepted again (was ${waitingOn})`);
      waitingOn = null;
      if (r.outcome === "idle") await sleep(opts.idleMs ?? 5_000);
      else opts.log?.(`run ${r.runId}: ${r.outcome}${r.status ? ` (${r.status})` : ""}`);
      continue;
    } catch (e) {
      if (e instanceof RunnerHttpError && (e.route === "lease" || e.route === "self-test") && e.status === 401) {
        // the credential is gone: re-enrol once if we can, else stop
        if (enrolled) throw new RunnerFatalError(MESSAGE_NO_ENROLMENT);
        opts.log?.(`the stored runner token was refused (${e.code ?? "401"}); trying the enrolment token`);
        enrolled = true;
        await enrol(client, opts, sleep);
        continue;
      }
      if (e instanceof RunnerFatalError) throw e;
      // [53] a stale report: re-run the self-test, submit it, and lease again at once if it passed
      if (e instanceof RunnerHttpError && e.code === "engine_self_test_required" && !refreshedSinceAccepted) {
        refreshedSinceAccepted = true;
        try {
          if (await refreshSelfTest(client, opts)) continue;
        } catch (inner) {
          if (inner instanceof RunnerHttpError && inner.status === 401) {
            if (enrolled) throw new RunnerFatalError(MESSAGE_NO_ENROLMENT);
            enrolled = true;
            await enrol(client, opts, sleep);
            continue;
          }
          throw inner;
        }
      }
      const why = e instanceof RunnerHttpError ? (e.code ?? String(e.status)) : "unreachable";
      if (why !== waitingOn) {
        opts.log?.(
          e instanceof RunnerHttpError && e.code !== null && LEASE_WAIT_CODES.has(e.code)
            ? `waiting: ${e.code} (an admin enables the engine after its self-test passes)`
            : `lease failed (${why}); retrying`,
        );
      }
      waitingOn = why;
      await sleep(backoff);
      backoff = Math.min(max, backoff * 2);
    }
  }
}
