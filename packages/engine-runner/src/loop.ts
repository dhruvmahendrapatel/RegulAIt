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
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ENGINE_RUNNER_TOKEN_PREFIX, type RunnerSelfTest } from "@regulait/shared";
import { RunnerHttpError, runOnce, type EngineAdapter, type RunnerClient, type RunOnceOptions } from "./runner.js";

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

export interface RunnerLoopOptions extends RunOnceOptions {
  store: RunnerTokenStore;
  /** the one-time enrolment token from the environment, or null */
  enrollmentToken: string | null;
  /** what registration reports (built fresh each time: the self-test is current) */
  registration: () => Promise<{ name: string; imageDigest: string; engineVersion: string; selfTest: RunnerSelfTest }>;
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

async function enrol(client: RunnerClient, opts: RunnerLoopOptions): Promise<void> {
  if (!opts.enrollmentToken) throw new RunnerFatalError(MESSAGE_NO_ENROLMENT);
  let reg: Awaited<ReturnType<RunnerClient["register"]>>;
  try {
    reg = await client.register(opts.enrollmentToken, await opts.registration());
  } catch (e) {
    if (e instanceof RunnerHttpError && e.status === 401) {
      throw new RunnerFatalError(`the enrolment token was refused (${e.code ?? "401"}: spent, expired or for another engine); ${MESSAGE_NO_ENROLMENT}`);
    }
    throw e;
  }
  await opts.store.save(reg.token);
  opts.log?.(`registered runner ${reg.runnerId}; self-test ${reg.selfTest.passed ? "passed" : `failed: ${reg.selfTest.failures.join(", ")}`}`);
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
    await enrol(client, opts);
    enrolled = true;
  }
  let backoff = base;
  let waitingOn: string | null = null;
  for (let i = 0; opts.maxIterations === undefined || i < opts.maxIterations; i++) {
    try {
      const r = await runOnce(client, adapter, opts);
      backoff = base;
      if (waitingOn) opts.log?.(`lease accepted again (was ${waitingOn})`);
      waitingOn = null;
      if (r.outcome === "idle") await sleep(opts.idleMs ?? 5_000);
      else opts.log?.(`run ${r.runId}: ${r.outcome}${r.status ? ` (${r.status})` : ""}`);
      continue;
    } catch (e) {
      if (e instanceof RunnerHttpError && e.route === "lease" && e.status === 401) {
        // the credential is gone: re-enrol once if we can, else stop
        if (enrolled) throw new RunnerFatalError(MESSAGE_NO_ENROLMENT);
        opts.log?.(`the stored runner token was refused (${e.code ?? "401"}); trying the enrolment token`);
        enrolled = true;
        await enrol(client, opts);
        continue;
      }
      if (e instanceof RunnerFatalError) throw e;
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
