/**
 * ADR-0190 slice I5 — THE TASK BRIDGE, runner side. The engine's worker runs ONLY in an executor's sandbox; this
 * is how the runner hands it a job and reads its results, without the runner ever running the engine.
 *
 * Each engine's runner keeps its ADR-0187 exchange (`jobs/<runId>/…` written whole, results read once
 * `results/<runId>/done.json` exists), but nothing mounts those directories into a worker any more. The bridge plays
 * the worker's part of the file protocol, over the gateway:
 *
 *   1. a PUBLISHED job directory (`jobs/<runId>`, a run id the runner holds) becomes the task's input: every file in
 *      it is sent inline, except the run's artifact (the files `isArtifact` names), which is only PLACED: the gateway
 *      streams the run's own artifact to the executor from its store. The run's key is taken out of `job.json`
 *      (`apiKey`) and sent as the TASK SECRET, so it is never in the input volume. The gateway decides the run's
 *      engine_worker placement on this request; a refusal ends the run there (`not_run`, isolation_unavailable);
 *   2. the task's stdout frames are read back: `file` frames are written under `results/` (each file in chunks, then
 *      checked against its size and sha256 and renamed into place, so `done.json` appears whole and last, as the
 *      exchange expects); `http` frames are the sandbox's gateway channel (decision 4, `gateway_only`): the bridge
 *      sends each one to the gateway's model routes, with exactly the headers the sandbox gave (the run's own key),
 *      NEVER the runner's credentials, and only under the gateway's base path; anything else is answered
 *      `not_gateway`;
 *   3. a cancel (`jobs/<runId>/cancel`, or the job directory gone) closes the task: the executor stops the sandbox.
 *
 * Nothing here starts a process: the bridge only reads and writes files and speaks HTTP (the static guard
 * `adr0190-i5-engine-runner-no-spawn.test.ts` checks every runner entry point's import closure).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  ENGINE_TASK_HTTP_BODY_MAX_BYTES,
  ENGINE_TASK_HTTP_HEADERS,
  ENGINE_TASK_INLINE_MAX_BYTES,
  ENGINE_TASK_MAX_FILES,
  engineTaskOutFrameSchema,
  isEngineTaskPath,
  type EngineTaskInFrame,
  type EngineTaskInputUpload,
} from "@regulait/shared";
import type { RunnerClient } from "./runner.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** the top-level result files a task may write besides its run's own (the worker's in-sandbox self-test) */
const SELF_TEST_FILE = /^\.[a-z]{1,32}-selftest\.json$/;

export interface TaskBridgeOptions {
  client: Pick<RunnerClient, "taskInput" | "taskFrames" | "taskPost">;
  jobsRoot: string;
  resultsRoot: string;
  /** the gateway's model base as the runner reaches it (the lease's target `baseUrl`): the gateway channel's only target */
  gatewayBaseUrl: string;
  /** which files of a job directory are the run's artifact (placed by the gateway, never uploaded) */
  isArtifact?: (name: string) => boolean;
  /** how often the jobs directory is looked at (default 250 ms) */
  pollMs?: number;
  /** a gateway channel request's bound (default 120 s) */
  httpTimeoutMs?: number;
  /** test seam: the HTTP client for the gateway channel */
  fetch?: typeof fetch;
  log?: (m: string) => void;
}

export class TaskBridgeError extends Error {}

/**
 * Read a published job directory into a task input: inline files (bounded), the artifact placed, the secret out of
 * `job.json`. Pure file reading; exported for tests.
 */
export async function taskInputFromJobDir(jobsRoot: string, runId: string, isArtifact: (name: string) => boolean = () => false): Promise<EngineTaskInputUpload> {
  if (!UUID.test(runId)) throw new TaskBridgeError("not a run id");
  const dir = path.join(jobsRoot, runId);
  const files: EngineTaskInputUpload["files"] = [];
  let artifact: EngineTaskInputUpload["artifact"] = null;
  let secret: string | null = null;
  let inline = 0;
  const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.name !== "cancel").sort((a, b) => (a.name < b.name ? -1 : 1));
  if (entries.length === 0 || entries.length > ENGINE_TASK_MAX_FILES) throw new TaskBridgeError("a job holds 1 to 16 files");
  for (const e of entries) {
    const rel = `${runId}/${e.name}`;
    if (!e.isFile() || !isEngineTaskPath(rel)) throw new TaskBridgeError(`job entry ${e.name} is not a plain file`);
    if (isArtifact(e.name)) {
      if (artifact) throw new TaskBridgeError("a job places one artifact");
      artifact = { path: rel };
      continue;
    }
    let bytes = await readFile(path.join(dir, e.name));
    if (e.name === "job.json") {
      // decision 5: the run's key is the task SECRET, never part of the input volume
      const j = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      if (typeof j.apiKey === "string") {
        secret = j.apiKey;
        delete j.apiKey;
        bytes = Buffer.from(JSON.stringify(j), "utf8");
      }
    }
    inline += bytes.length;
    if (inline > ENGINE_TASK_INLINE_MAX_BYTES) throw new TaskBridgeError("the job's inline files are too large");
    files.push({ path: rel, data: bytes.toString("base64") });
  }
  return { files, artifact, secret };
}

/** a result path the task may write: the run's own files, or a top-level self-test file */
function resultPathAllowed(runId: string, p: string): boolean {
  if (!isEngineTaskPath(p)) return false;
  const segs = p.split("/");
  return (segs[0] === runId && segs.length >= 2) || (segs.length === 1 && SELF_TEST_FILE.test(segs[0]!));
}

/** the gateway channel: one sandbox request sent to the gateway's model routes, or why not */
export async function forwardGatewayRequest(
  frame: { id: string; method: "GET" | "POST"; path: string; headers: Record<string, string>; body: string },
  opts: { gatewayBaseUrl: string; fetch?: typeof fetch; timeoutMs?: number },
): Promise<EngineTaskInFrame> {
  const base = new URL(opts.gatewayBaseUrl);
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  const reqPath = frame.path.split("?")[0]!;
  // only the gateway's model routes under its base; never the runner's or the executor's own channels
  if (!reqPath.startsWith(basePath) || /\/(?:engine-runner|executor-channel|oauth)(?:\/|$)/.test(reqPath)) return { t: "http_err", id: frame.id, code: "not_gateway" };
  const body = Buffer.from(frame.body, "base64");
  if (body.length > ENGINE_TASK_HTTP_BODY_MAX_BYTES) return { t: "http_err", id: frame.id, code: "too_large" };
  const headers: Record<string, string> = {};
  for (const name of ENGINE_TASK_HTTP_HEADERS) if (typeof frame.headers[name] === "string") headers[name] = frame.headers[name]!;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 120_000);
  try {
    const res = await (opts.fetch ?? fetch)(new URL(frame.path, base.origin).toString(), {
      method: frame.method,
      headers,
      ...(frame.method === "POST" ? { body } : {}),
      signal: abort.signal,
      redirect: "manual",
    });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > ENGINE_TASK_HTTP_BODY_MAX_BYTES) return { t: "http_err", id: frame.id, code: "too_large" };
    const out: Record<string, string> = {};
    const ct = res.headers.get("content-type");
    if (ct && /^[\x20-\x7e]{0,4096}$/.test(ct)) out["content-type"] = ct;
    return { t: "http_res", id: frame.id, status: res.status, headers: out, body: buf.toString("base64") };
  } catch {
    return { t: "http_err", id: frame.id, code: abort.signal.aborted ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

export class ExecutorTaskBridge {
  private readonly active = new Set<string>();
  constructor(private readonly opts: TaskBridgeOptions) {}

  /** watch the jobs directory until the signal stops it */
  async run(signal: AbortSignal): Promise<void> {
    const poll = this.opts.pollMs ?? 250;
    while (!signal.aborted) {
      await this.tick().catch((e: unknown) => this.opts.log?.(`task bridge: ${e instanceof Error ? e.message : String(e)}`));
      await new Promise((r) => setTimeout(r, poll));
    }
  }

  /** start a task for every published job not yet bridged (returns the run ids started now) */
  async tick(): Promise<string[]> {
    const started: string[] = [];
    for (const name of await readdir(this.opts.jobsRoot).catch(() => [] as string[])) {
      if (!UUID.test(name) || this.active.has(name)) continue;
      if (existsSync(path.join(this.opts.resultsRoot, name, "done.json"))) continue;
      this.active.add(name);
      started.push(name);
      void this.bridge(name)
        .catch((e: unknown) => this.opts.log?.(`task ${name}: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => {
          // a run is bridged once; it is forgotten only when its job directory is gone
          const forget = setInterval(() => {
            if (!existsSync(path.join(this.opts.jobsRoot, name))) {
              this.active.delete(name);
              clearInterval(forget);
            }
          }, this.opts.pollMs ?? 250);
          forget.unref?.();
        });
    }
    return started;
  }

  /** one run's task, start to end */
  async bridge(runId: string): Promise<"ended" | "refused" | "cancelled"> {
    const log = this.opts.log ?? (() => undefined);
    const input = await taskInputFromJobDir(this.opts.jobsRoot, runId, this.opts.isArtifact);
    const started = await this.opts.client.taskInput(runId, input);
    if (started.status !== 201) {
      log(`task ${runId}: not started (${started.status} ${started.error ?? ""}${started.reason ? ` ${started.reason}` : ""}); the gateway ended the run`);
      return "refused";
    }
    let from = 0;
    const parts = new Map<string, { file: string; chunk: number; size: number; hash: ReturnType<typeof createHash> }>();
    let closed = false;
    const jobDir = path.join(this.opts.jobsRoot, runId);
    try {
      for (;;) {
        if (!closed && (!existsSync(jobDir) || existsSync(path.join(jobDir, "cancel")))) {
          closed = true;
          await this.opts.client.taskPost(runId, [], true).catch(() => undefined);
          return "cancelled";
        }
        const got = await this.opts.client.taskFrames(runId, from, 5);
        for (const f of got.frames) {
          from = f.seq + 1;
          let parsed;
          try {
            parsed = engineTaskOutFrameSchema.safeParse(JSON.parse(f.data));
          } catch {
            parsed = null;
          }
          if (!parsed?.success) {
            // a frame outside the contract: the task is not trusted further (nothing it wrote is believed)
            log(`task ${runId}: a frame outside the task contract; task closed`);
            await this.opts.client.taskPost(runId, [], true).catch(() => undefined);
            return "refused";
          }
          const m = parsed.data;
          if (m.t === "file") {
            if (!resultPathAllowed(runId, m.path)) throw new TaskBridgeError(`a result path outside the run: ${m.path}`);
            await this.writeChunk(parts, m);
          } else if (m.t === "http") {
            // answered in the background: a slow model call never holds the frame reader
            void forwardGatewayRequest(m, { gatewayBaseUrl: this.opts.gatewayBaseUrl, ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}), ...(this.opts.httpTimeoutMs ? { timeoutMs: this.opts.httpTimeoutMs } : {}) }).then((answer) =>
              this.opts.client.taskPost(runId, [JSON.stringify(answer)]).catch((e: unknown) => log(`task ${runId}: an answer was not delivered (${(e as Error).message})`)),
            );
          }
        }
        if (got.state === "refused") {
          log(`task ${runId}: refused (${got.refusal ?? "unknown"})`);
          return "refused";
        }
        if (got.eof) return "ended";
      }
    } catch (e) {
      // anything the bridge cannot believe stops the task (nothing more it sends is read)
      await this.opts.client.taskPost(runId, [], true).catch(() => undefined);
      throw e;
    } finally {
      for (const p of parts.values()) await rm(`${p.file}.part`, { force: true });
    }
  }

  private async writeChunk(
    parts: Map<string, { file: string; chunk: number; size: number; hash: ReturnType<typeof createHash> }>,
    m: { path: string; chunk: number; data: string; last: boolean; size?: number | undefined; sha256?: string | undefined },
  ): Promise<void> {
    const file = path.join(this.opts.resultsRoot, m.path);
    let p = parts.get(m.path);
    if (!p) {
      if (m.chunk !== 0) throw new TaskBridgeError(`result ${m.path} does not start at chunk 0`);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o750 });
      await rm(`${file}.part`, { force: true });
      p = { file, chunk: 0, size: 0, hash: createHash("sha256") };
      parts.set(m.path, p);
    } else if (m.chunk !== p.chunk) throw new TaskBridgeError(`result ${m.path} chunk ${m.chunk} out of order`);
    const bytes = Buffer.from(m.data, "base64");
    const fh = await open(`${file}.part`, "a", 0o640);
    try {
      await fh.write(bytes);
    } finally {
      await fh.close();
    }
    p.size += bytes.length;
    p.hash.update(bytes);
    p.chunk += 1;
    if (m.last) {
      parts.delete(m.path);
      const sha = p.hash.digest("hex");
      if (p.size !== m.size || sha !== m.sha256 || (await stat(`${file}.part`)).size !== p.size) {
        await rm(`${file}.part`, { force: true });
        throw new TaskBridgeError(`result ${m.path} is not the file its last chunk names`);
      }
      // whole, then in place (done.json therefore appears complete, after every file sent before it)
      await rename(`${file}.part`, file);
    }
  }
}
