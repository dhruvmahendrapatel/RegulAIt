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
import { createHash } from "node:crypto";
import { rm, mkdir } from "node:fs/promises";
import {
  ENGINE_RESULT_VERSION,
  type EngineId,
  type EngineLease,
  type EngineResultEnvelope,
  type RunnerSelfTest,
} from "@regulait/shared";
import { probeEgress, type EgressProbeOptions } from "./egress.js";

export interface RunnerHttp {
  (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; json(): Promise<unknown> }>;
}

export interface RunnerClientOptions {
  /** the gateway on the engines network, e.g. http://gateway:3000 */
  gatewayUrl: string;
  http?: RunnerHttp;
}

/** the five runner routes, nothing else */
export class RunnerClient {
  private token: string | null = null;
  private readonly http: RunnerHttp;
  constructor(private readonly opts: RunnerClientOptions) {
    this.http = opts.http ?? ((url, init) => fetch(url, init) as unknown as ReturnType<RunnerHttp>);
  }

  private async call(method: string, path: string, bearer: string, body?: unknown) {
    const res = await this.http(`${this.opts.gatewayUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return res;
  }

  /** exchange a one-time enrolment token for this runner's token */
  async register(enrollmentToken: string, body: { name: string; imageDigest: string; engineVersion: string; selfTest: RunnerSelfTest }) {
    const res = await this.call("POST", "/v1/engine-runner/register", enrollmentToken, body);
    const json = (await res.json()) as { runnerId?: string; token?: string; selfTest?: { passed: boolean; failures: string[] }; error?: string };
    if (res.status !== 201 || !json.token) throw new Error(`register refused (${res.status} ${json.error ?? ""})`);
    this.token = json.token;
    return json as { runnerId: string; token: string; selfTest: { passed: boolean; failures: string[] } };
  }

  useToken(token: string): void {
    this.token = token;
  }

  private bearer(): string {
    if (!this.token) throw new Error("runner is not registered");
    return this.token;
  }

  /** a lease, or null when there is no work (204) */
  async lease(): Promise<EngineLease | null> {
    const res = await this.call("POST", "/v1/engine-runner/lease", this.bearer());
    if (res.status === 204) return null;
    if (res.status !== 200) throw new Error(`lease refused (${res.status})`);
    return (await res.json()) as EngineLease;
  }

  async heartbeat(runId: string, phase: "starting" | "running" | "uploading", progress: number): Promise<{ cancel: boolean }> {
    const res = await this.call("POST", `/v1/engine-runner/runs/${runId}/heartbeat`, this.bearer(), { phase, progress });
    if (res.status !== 200) return { cancel: true }; // the gateway no longer knows this lease: stop
    return (await res.json()) as { cancel: boolean };
  }

  async result(runId: string, envelope: EngineResultEnvelope): Promise<number> {
    const res = await this.call("POST", `/v1/engine-runner/runs/${runId}/result`, this.bearer(), envelope);
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
  workRoot: string;
  heartbeatMs?: number;
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
 * run posts nothing (the gateway already ended it). The work directory is
 * wiped whatever happens.
 */
export async function runOnce(
  client: RunnerClient,
  adapter: EngineAdapter,
  opts: RunOnceOptions,
): Promise<{ outcome: "idle" | "posted" | "cancelled" | "failed"; runId?: string; status?: number }> {
  const lease = await client.lease();
  if (!lease) return { outcome: "idle" };
  const workDir = `${opts.workRoot.replace(/\/$/, "")}/${lease.runId}`;
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const abort = new AbortController();
  let progress = 0;
  let cancelled = false;
  const beat = async () => {
    try {
      const hb = await client.heartbeat(lease.runId, "running", progress);
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
    await client.heartbeat(lease.runId, "starting", 0).then((hb) => {
      if (hb.cancel) {
        cancelled = true;
        abort.abort();
      }
    });
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
    const status = await client.result(lease.runId, envelope);
    return { outcome: envelope.status === "failed" ? "failed" : "posted", runId: lease.runId, status };
  } finally {
    clearInterval(interval);
    clearTimeout(deadline);
    await rm(workDir, { recursive: true, force: true });
  }
}
