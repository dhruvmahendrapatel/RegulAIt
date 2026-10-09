/**
 * ADR-0187 B5-E — THE RUNNER CORE: the protocol side of the thin shim each
 * engine image runs (`engines/<id>/runner` in B5-P/M/G). No listening port: it
 * registers once (enrolment token → runner token, reporting its self-test),
 * then loops: lease → run the engine under a heartbeat → post the envelope →
 * wipe the work directory.
 *
 * It is never the control: the gateway revokes the run's key on cancel and on
 * the deadline whether or not this stops, recomputes every verdict, and treats
 * a missing result as unknown. What this core guarantees is that it does stop
 * promptly (the heartbeat's `cancel` aborts the engine's process group) and
 * that an engine that throws or exits badly is reported as `failed`, never as
 * a clean result.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  ENGINE_RESULT_VERSION,
  ENGINE_RUNNER_NEXT,
  ENGINE_RUNNER_TOKEN_PREFIX,
  type EngineId,
  type EngineLease,
  type EngineResultEnvelope,
  type EngineRunnerNext,
  type RunnerSelfTest,
} from "@regulait/shared";
import { probeEgress, type EgressProbeOptions } from "./egress.js";

export interface RunnerHttp {
  (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<{ status: number; json(): Promise<unknown> }>;
}

export interface RunnerClientOptions {
  /** the gateway on the engines network, e.g. http://gateway:3000 */
  gatewayUrl: string;
  http?: RunnerHttp;
  /**
   * PR #205 review round 11 [89]: every request (response body included) is bounded by this many ms
   * (default 30 s), and by the run's deadline where it has one. A timeout is a transient failure: it
   * throws like a network error, so every caller's existing retry applies.
   */
  requestTimeoutMs?: number;
}

/** a request that took longer than its bound (transient, like a network error) */
export class RunnerTimeoutError extends Error {}

/**
 * PR #205 review [54]: the runner's own token — `rge_` and 256 bits from the OS CSPRNG. The
 * gateway stores only `runnerTokenHash` of it (the same sha256 hex its auth hashes presented
 * tokens with).
 */
export function generateRunnerSecret(): string {
  return ENGINE_RUNNER_TOKEN_PREFIX + randomBytes(32).toString("hex");
}
export function runnerTokenHash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** the gateway's `next` signal, when it gave a known one (PR #205 review round 5) */
function nextOf(json: { next?: unknown }): EngineRunnerNext | null {
  return typeof json.next === "string" && (ENGINE_RUNNER_NEXT as readonly string[]).includes(json.next) ? (json.next as EngineRunnerNext) : null;
}

/** a refusal from a runner route, with the gateway's error code and `next` signal (never the token) */
export class RunnerHttpError extends Error {
  constructor(
    readonly route: "register" | "lease" | "self-test" | "heartbeat",
    readonly status: number,
    readonly code: string | null,
    /** PR #205 review round 5: the one signal the runner's state machine acts on, when the gateway gave it */
    readonly next: EngineRunnerNext | null = null,
  ) {
    super(`${route} refused (${status}${code ? ` ${code}` : ""}${next ? `; next: ${next}` : ""})`);
  }
}

/** the build a runner is running, presented on every lease (round 5 [67]) */
export interface RunnerBuild {
  imageDigest: string;
  engineVersion: string;
}

/** the five runner routes, nothing else */
export class RunnerClient {
  private token: string | null = null;
  private readonly http: RunnerHttp;
  constructor(private readonly opts: RunnerClientOptions) {
    this.http = opts.http ?? ((url, init) => fetch(url, init) as unknown as ReturnType<RunnerHttp>);
  }

  private async call(method: string, path: string, bearer: string, body?: unknown, deadlineAt?: string) {
    // PR #205 review round 11 [89]: bounded — the request and its body are aborted after the
    // timeout, or at the run's deadline when that is sooner (never below 1 ms)
    const bound = Math.max(1, Math.min(this.opts.requestTimeoutMs ?? 30_000, deadlineAt ? Date.parse(deadlineAt) - Date.now() : Number.POSITIVE_INFINITY));
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new RunnerTimeoutError(`${method} ${path} took longer than ${bound} ms`));
      }, bound);
    });
    try {
      return await Promise.race([
        (async () => {
          // B5-P: a JSON content-type is sent only with a body — the gateway (Fastify) refuses an empty
          // body declared as JSON with 400, which made every bodiless lease fail against the real app
          const res = await this.http(`${this.opts.gatewayUrl.replace(/\/$/, "")}${path}`, {
            method,
            headers: { authorization: `Bearer ${bearer}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            signal: abort.signal,
          });
          // the body is read inside the bound too (a stalled body is a stalled request)
          const data = res.status === 204 ? null : await res.json().catch(() => null);
          return { status: res.status, json: async () => data };
        })(),
        timedOut,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** exchange a one-time enrolment token for this runner's token */
  /**
   * Register with a one-time enrolment token. PR #205 review [54]: `runnerSecret` is the runner's
   * OWN token (`generateRunnerSecret`), already persisted by the caller; only its sha256 is sent and
   * nothing secret comes back. Retrying with the same secret after a lost response returns the same
   * runner.
   */
  async register(
    enrollmentToken: string,
    runnerSecret: string,
    body: { name: string; imageDigest: string; engineVersion: string; selfTest: RunnerSelfTest },
    /** round 5 [67]: the runner token this registration replaces (a build change), as proof of possession */
    supersedes?: string,
  ) {
    const res = await this.call("POST", "/v1/engine-runner/register", enrollmentToken, {
      ...body,
      tokenHash: runnerTokenHash(runnerSecret),
      ...(supersedes ? { supersedes } : {}),
    });
    const json = ((await res.json().catch(() => null)) ?? {}) as {
      runnerId?: string;
      selfTest?: { passed: boolean; failures: string[] };
      replayed?: boolean;
      supersededRunnerId?: string | null;
      error?: string;
    };
    if (res.status !== 201 || !json.runnerId) throw new RunnerHttpError("register", res.status, json.error ?? null);
    this.token = runnerSecret;
    return json as { runnerId: string; selfTest: { passed: boolean; failures: string[] }; replayed?: boolean; supersededRunnerId?: string | null };
  }

  /**
   * PR #205 review [53]: submit a fresh self-test report. Round 5: the answer carries `next`, the
   * same signal a lease gives (a passing report leases when the engine is on, waits when it is off).
   */
  async submitSelfTest(selfTest: RunnerSelfTest): Promise<{ passed: boolean; failures: string[]; next: EngineRunnerNext | null }> {
    const res = await this.call("POST", "/v1/engine-runner/self-test", this.bearer(), { selfTest });
    const json = ((await res.json().catch(() => null)) ?? {}) as { selfTest?: { passed: boolean; failures: string[] }; error?: string; next?: unknown };
    if (res.status !== 200 || !json.selfTest) throw new RunnerHttpError("self-test", res.status, json.error ?? null, nextOf(json));
    return { ...json.selfTest, next: nextOf(json) };
  }

  useToken(token: string): void {
    this.token = token;
  }

  private bearer(): string {
    if (!this.token) throw new Error("runner is not registered");
    return this.token;
  }

  /** a lease, or null when there is no work (204). Round 5 [67]: presents the build it is running. */
  async lease(build: RunnerBuild): Promise<EngineLease | null> {
    const res = await this.call("POST", "/v1/engine-runner/lease", this.bearer(), { imageDigest: build.imageDigest, engineVersion: build.engineVersion });
    if (res.status === 204) return null;
    if (res.status !== 200) {
      const json = ((await res.json().catch(() => null)) ?? {}) as { error?: string; next?: unknown };
      throw new RunnerHttpError("lease", res.status, typeof json.error === "string" ? json.error : null, nextOf(json));
    }
    return (await res.json()) as EngineLease;
  }

  async heartbeat(runId: string, phase: "starting" | "running" | "uploading", progress: number, deadlineAt?: string): Promise<{ cancel: boolean }> {
    const res = await this.call("POST", `/v1/engine-runner/runs/${runId}/heartbeat`, this.bearer(), { phase, progress }, deadlineAt);
    // PR #205 review round 10 [83]: a 5xx, 408 or 429 says nothing about the lease — it is thrown
    // (transient, retried by the caller); any other refusal (401, 404, 409) is definitive: stop
    if (res.status >= 500 || res.status === 408 || res.status === 429) throw new RunnerHttpError("heartbeat", res.status, null);
    if (res.status !== 200) return { cancel: true }; // the gateway no longer knows this lease: stop
    return (await res.json()) as { cancel: boolean };
  }

  async result(runId: string, envelope: EngineResultEnvelope, deadlineAt?: string): Promise<number> {
    const res = await this.call("POST", `/v1/engine-runner/runs/${runId}/result`, this.bearer(), envelope, deadlineAt);
    return res.status;
  }
}

/** build the self-test report the register route evaluates */
export async function buildSelfTest(args: {
  imageDigest: string;
  engineVersion: string;
  /** the usage-data switches the manifest names: env name -> required value */
  requiredEnv: Readonly<Record<string, string>>;
  env?: NodeJS.ProcessEnv;
  egress?: EgressProbeOptions;
  now?: Date;
}): Promise<RunnerSelfTest> {
  const env = args.env ?? process.env;
  const usageDataEnv: Record<string, boolean> = {};
  for (const [name, value] of Object.entries(args.requiredEnv)) usageDataEnv[name] = env[name] === value;
  const egress = await probeEgress(args.egress);
  return {
    imageDigest: args.imageDigest,
    engineVersion: args.engineVersion,
    usageDataEnv,
    egress,
    at: (args.now ?? new Date()).toISOString(),
  };
}

/** what an engine adapter does with one lease (B5-P/M/G implement this) */
export type EngineAdapter = (
  lease: EngineLease,
  ctx: { workDir: string; signal: AbortSignal; progress: (p: number) => void },
) => Promise<Omit<EngineResultEnvelope, "version" | "runId" | "engineId" | "engineVersion">>;

export interface RunOnceOptions {
  engineId: EngineId;
  engineVersion: string;
  /** round 5 [67]: the image digest this runner runs (presented on every lease with engineVersion) */
  imageDigest: string;
  workRoot: string;
  /**
   * PR #205 review round 11 [90]: where an undelivered result is kept until delivery is definitive or
   * its deadline passes — a directory on the runner's PERSISTENT state volume, separate from the
   * engine's work dirs (default: workRoot, which loses it on restart)
   */
  retainRoot?: string;
  heartbeatMs?: number;
  /** first retry delay for the result POST (doubles each time, capped at 30 s) */
  retryBaseMs?: number;
  /** result POST attempts before giving up (the lease then expires at the gateway) */
  maxResultAttempts?: number;
  /** round 10 [83]: starting-heartbeat attempts on a transient failure (default 8; never past the deadline) */
  maxStartAttempts?: number;
}

/**
 * PR #203 review round 2 [18]: post the result until the gateway gives a
 * definitive answer — a 2xx, or a 4xx that will not change on retry (409 the
 * run ended or timed out, 401 the runner is revoked, 422 the envelope is
 * invalid, …). A network error, a 5xx, a 408 or a 429 is retried with
 * exponential backoff, never past the run's deadline. Returns the last status,
 * or null when nothing definitive arrived.
 */
export async function postResultWithRetry(
  client: RunnerClient,
  runId: string,
  envelope: EngineResultEnvelope,
  opts: { deadlineAt: string; retryBaseMs?: number; maxAttempts?: number },
): Promise<number | null> {
  const base = opts.retryBaseMs ?? 1000;
  const max = opts.maxAttempts ?? 8;
  for (let attempt = 1; attempt <= max; attempt++) {
    let status: number | null = null;
    try {
      status = await client.result(runId, envelope, opts.deadlineAt);
    } catch {
      status = null;
    }
    if (status !== null && status < 500 && status !== 408 && status !== 429) return status;
    if (attempt === max || Date.now() >= Date.parse(opts.deadlineAt)) return status;
    await new Promise((r) => setTimeout(r, Math.min(30_000, base * 2 ** (attempt - 1))));
  }
  return null;
}

/** PR #205 review round 5 [68]: the one file an undelivered run's work directory keeps */
export const RETAINED_RESULT_FILE = "undelivered-result.json";
export interface RetainedResult {
  runId: string;
  deadlineAt: string;
  envelope: EngineResultEnvelope;
}
const RUN_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PR #205 review round 5 [68]: retry the delivery of every retained result, once each (the loop's
 * backoff spaces the attempts; a network error, a 5xx, a 408 or a 429 is not definitive, exactly
 * as in `postResultWithRetry`). A work directory goes when the gateway answered definitively (a 2xx,
 * or a 4xx such as 409 the run ended or timed out), when the run's deadline has passed (the gateway
 * has ended it), or when it holds no readable result (a crash leftover: nothing to deliver). Only
 * run-id directories are touched. Returns how many are still retained.
 */
export async function retryRetainedResults(
  client: RunnerClient,
  workRoot: string,
  opts: { now?: () => number; log?: (message: string) => void } = {},
): Promise<number> {
  const root = workRoot.replace(/\/$/, "");
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && RUN_DIR.test(d.name)).map((d) => d.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw e;
  }
  const now = opts.now ?? Date.now;
  let retained = 0;
  for (const name of names) {
    const dir = `${root}/${name}`;
    let r: RetainedResult | null = null;
    try {
      const parsed = JSON.parse(await readFile(`${dir}/${RETAINED_RESULT_FILE}`, "utf8")) as Partial<RetainedResult>;
      if (parsed.runId === name && typeof parsed.deadlineAt === "string" && parsed.envelope) r = parsed as RetainedResult;
    } catch {
      r = null;
    }
    if (!r) {
      opts.log?.(`run ${name}: a work directory with no result to deliver was removed`);
      await rm(dir, { recursive: true, force: true });
      continue;
    }
    const deadline = Date.parse(r.deadlineAt);
    if (!Number.isFinite(deadline) || now() >= deadline) {
      opts.log?.(`run ${name}: the deadline passed before its result was delivered; the gateway has ended it`);
      await rm(dir, { recursive: true, force: true });
      continue;
    }
    let status: number | null = null;
    try {
      status = await client.result(r.runId, r.envelope, r.deadlineAt);
    } catch {
      status = null;
    }
    if (status !== null && status < 500 && status !== 408 && status !== 429) {
      opts.log?.(`run ${name}: retained result delivered (${status})`);
      await rm(dir, { recursive: true, force: true });
    } else {
      retained++;
    }
  }
  return retained;
}

/** an envelope that reports a run that produced nothing usable */
export function failedEnvelope(lease: EngineLease, engineVersion: string, status: "failed" | "timeout" | "cancelled", errorCode: string): EngineResultEnvelope {
  return {
    version: ENGINE_RESULT_VERSION,
    runId: lease.runId,
    engineId: lease.engineId,
    engineVersion,
    status,
    errorCode,
    items: [],
    notRun: [],
    rawReport: null,
  };
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Lease and run at most one job. Returns what happened, for the shim's log.
 * The engine is aborted on a `cancel` heartbeat or at the deadline; an engine
 * that throws is reported `failed` (engine_error) with no items; a cancelled
 * run posts nothing (the gateway already ended it). The result POST is
 * retried until the gateway answers definitively; the work directory is wiped
 * then, and kept when nothing definitive arrived (outcome `undelivered`).
 */
export async function runOnce(
  client: RunnerClient,
  adapter: EngineAdapter,
  opts: RunOnceOptions,
): Promise<{ outcome: "idle" | "posted" | "cancelled" | "failed" | "undelivered"; runId?: string; status?: number }> {
  const lease = await client.lease({ imageDigest: opts.imageDigest, engineVersion: opts.engineVersion });
  if (!lease) return { outcome: "idle" };
  const workDir = `${opts.workRoot.replace(/\/$/, "")}/${lease.runId}`;
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const abort = new AbortController();
  let progress = 0;
  let cancelled = false;
  let keepWorkDir = false;
  const beat = async () => {
    try {
      const hb = await client.heartbeat(lease.runId, "running", progress, lease.deadlineAt);
      if (hb.cancel) {
        cancelled = true;
        abort.abort();
      }
    } catch {
      // a heartbeat that cannot reach the gateway: the lease will expire and the run end there
    }
  };
  const interval = setInterval(() => void beat(), opts.heartbeatMs ?? 15_000);
  const deadline = setTimeout(() => abort.abort(), Math.max(0, Date.parse(lease.deadlineAt) - Date.now()));
  try {
    // PR #205 review round 10 [83]: the starting heartbeat is retried on a transient failure (a
    // network error, a 5xx, a 408, a 429) with a bounded backoff, never past the run's deadline; only
    // a definitive refusal (or running out of time) abandons the run, reported as `cancelled`, not a crash
    const startBase = opts.retryBaseMs ?? 1000;
    const startAttempts = opts.maxStartAttempts ?? 8;
    for (let attempt = 1; ; attempt++) {
      try {
        const hb = await client.heartbeat(lease.runId, "starting", 0, lease.deadlineAt);
        if (hb.cancel) {
          cancelled = true;
          abort.abort();
        }
        break;
      } catch {
        const wait = Math.min(30_000, startBase * 2 ** (attempt - 1));
        if (attempt >= startAttempts || Date.now() + wait >= Date.parse(lease.deadlineAt)) {
          cancelled = true;
          abort.abort();
          break;
        }
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    if (cancelled) return { outcome: "cancelled", runId: lease.runId };
    let envelope: EngineResultEnvelope;
    try {
      const out = await adapter(lease, { workDir, signal: abort.signal, progress: (p) => (progress = Math.max(0, Math.min(1, p))) });
      envelope = { version: ENGINE_RESULT_VERSION, runId: lease.runId, engineId: opts.engineId, engineVersion: opts.engineVersion, ...out };
      if (abort.signal.aborted && !cancelled) envelope = failedEnvelope(lease, opts.engineVersion, "timeout", "deadline_passed");
    } catch {
      envelope = abort.signal.aborted
        ? failedEnvelope(lease, opts.engineVersion, cancelled ? "cancelled" : "timeout", cancelled ? "cancelled" : "deadline_passed")
        : failedEnvelope(lease, opts.engineVersion, "failed", "engine_error");
    }
    if (cancelled) return { outcome: "cancelled", runId: lease.runId };
    // the heartbeat keeps running through the retries so the lease stays live
    // across a brief gateway outage; the work dir is kept until the gateway
    // gave a definitive answer
    const status = await postResultWithRetry(client, lease.runId, envelope, {
      deadlineAt: lease.deadlineAt,
      ...(opts.retryBaseMs !== undefined ? { retryBaseMs: opts.retryBaseMs } : {}),
      ...(opts.maxResultAttempts !== undefined ? { maxAttempts: opts.maxResultAttempts } : {}),
    });
    if (status === null || status >= 500 || status === 408 || status === 429) {
      // PR #205 review round 5 [68]: keep ONLY the envelope (the engine's own files go now), so the
      // loop can retry the delivery before its next lease and the tmpfs does not fill up.
      // PR #205 review round 11 [90]: kept under `retainRoot` — the runner's persistent state volume,
      // apart from the engine's work dirs — so a restart still delivers it (or drops it at its deadline)
      const retainDir = `${(opts.retainRoot ?? opts.workRoot).replace(/\/$/, "")}/${lease.runId}`;
      await rm(workDir, { recursive: true, force: true });
      await mkdir(retainDir, { recursive: true, mode: 0o700 });
      const retained: RetainedResult = { runId: lease.runId, deadlineAt: lease.deadlineAt, envelope };
      await writeFile(`${retainDir}/${RETAINED_RESULT_FILE}`, JSON.stringify(retained), { mode: 0o600 });
      keepWorkDir = retainDir === workDir;
      return { outcome: "undelivered", runId: lease.runId };
    }
    return { outcome: envelope.status === "failed" ? "failed" : "posted", runId: lease.runId, status };
  } finally {
    clearInterval(interval);
    clearTimeout(deadline);
    if (!keepWorkDir) await rm(workDir, { recursive: true, force: true });
  }
}
