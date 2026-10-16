/**
 * ADR-0190 slice I5 — THE ENGINE TASK, inside its sandbox. Each engine image's `task-main.js` (the manifest's
 * `taskEntry`) calls `runSandboxTask` with its one-job function. It runs as the workload the sandbox init released,
 * under the run's engine_worker placement, and only there:
 *
 *  - its INPUT is the read-only `jobs` volume (`/jobs/<runId>/…`), written and verified by the executor;
 *  - its TASK SECRET (the run's key, decision 5) is read once from fd 3, a pipe the init wrote; it is never in this
 *    process's environment or argv;
 *  - its GATEWAY CHANNEL (decision 4, `gateway_only`): the sandbox has no network; a loopback HTTP proxy turns each
 *    request into an `http` stdout frame and waits for the runner's `http_res` / `http_err` stdin frame. The engine is
 *    pointed at the proxy (`gatewayOrigin`), with the gateway's own path, so its requests reach only the gateway's
 *    model routes, through the trusted side;
 *  - its RESULTS are written under a work directory and sent as `file` frames (each file in chunks with its size and
 *    sha256; the run's `done.json` last), then `end`.
 *
 * stdout is the task's frames and nothing else: logs go to stderr (which the executor discards).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  ENGINE_TASK_CHUNK_MAX_BYTES,
  ENGINE_TASK_HTTP_BODY_MAX_BYTES,
  ENGINE_TASK_HTTP_HEADERS,
  ENGINE_TASK_SECRET_FD,
  ENGINE_TASK_SECRET_RE,
  engineTaskInFrameSchema,
  type EngineTaskInFrame,
  type SandboxRuntimeObservation,
  type EngineTaskOutFrame,
} from "@regulait/shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface SandboxTaskContext {
  runId: string;
  /** the read-only input (`<jobsRoot>/<runId>/…`) */
  jobsRoot: string;
  /** where the one-job function writes results (`<resultsRoot>/<runId>/…`, done file last; a top-level self-test file) */
  resultsRoot: string;
  /** scratch space (the sandbox's tmpfs) */
  workRoot: string;
  /** the task secret (the run's key), or null */
  secret: string | null;
  /** the loopback origin of the gateway channel (`http://127.0.0.1:<port>`), or null when the engine calls nothing */
  gatewayOrigin: string | null;
  log: (m: string) => void;
}

export interface SandboxTaskOptions {
  run: (ctx: SandboxTaskContext) => Promise<void>;
  /** does the engine call models (the gateway channel is opened)? */
  gateway: boolean;
  jobsRoot?: string;
  workRoot?: string;
  /** seams (tests): where the frames go, where answers come from, the secret */
  stdout?: Writable;
  stdin?: Readable;
  readSecret?: () => string | null;
  /** a gateway channel request waits this long for its answer (default 300 s) */
  httpTimeoutMs?: number;
}

/** fd 3, read once: the init wrote the secret there and closed it; no fd 3 = no secret */
export function readTaskSecretFd(): string | null {
  let s: string;
  try {
    s = readFileSync(ENGINE_TASK_SECRET_FD, "utf8");
  } catch {
    return null;
  }
  return ENGINE_TASK_SECRET_RE.test(s) ? s : null;
}

/** one frame per line on stdout, in order, honouring backpressure */
function frameWriter(out: Writable) {
  let chain = Promise.resolve();
  return (f: EngineTaskOutFrame): Promise<void> => {
    chain = chain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          const ok = out.write(`${JSON.stringify(f)}\n`, (err) => (err ? reject(err) : undefined));
          if (ok) resolve();
          else out.once("drain", () => resolve());
        }),
    );
    return chain;
  };
}

/** send one file as `file` frames (chunked; the last names its size and sha256) */
async function sendFile(write: (f: EngineTaskOutFrame) => Promise<void>, rel: string, abs: string): Promise<void> {
  const bytes = await readFile(abs);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const n = Math.max(1, Math.ceil(bytes.length / ENGINE_TASK_CHUNK_MAX_BYTES));
  for (let i = 0; i < n; i++) {
    const part = bytes.subarray(i * ENGINE_TASK_CHUNK_MAX_BYTES, (i + 1) * ENGINE_TASK_CHUNK_MAX_BYTES);
    const last = i === n - 1;
    await write({ t: "file", path: rel, chunk: i, data: part.toString("base64"), last, ...(last ? { size: bytes.length, sha256 } : {}) });
  }
}

/** the files a task sends: top-level self-test files, then the run's own (its done file last) */
async function resultFiles(resultsRoot: string, runId: string, doneFile: string): Promise<Array<{ rel: string; abs: string }>> {
  const out: Array<{ rel: string; abs: string }> = [];
  for (const e of await readdir(resultsRoot, { withFileTypes: true }).catch(() => [])) {
    if (e.isFile() && /^\.[a-z]{1,32}-selftest\.json$/.test(e.name)) out.push({ rel: e.name, abs: path.join(resultsRoot, e.name) });
  }
  const runDir = path.join(resultsRoot, runId);
  const names = (await readdir(runDir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isFile() && /^[A-Za-z0-9._-]{1,128}$/.test(e.name) && !e.name.endsWith(".tmp"))
    .map((e) => e.name)
    .sort((a, b) => (a === doneFile ? 1 : b === doneFile ? -1 : a < b ? -1 : 1));
  for (const n of names) out.push({ rel: `${runId}/${n}`, abs: path.join(runDir, n) });
  return out;
}

/** the gateway channel's loopback proxy: one `http` frame per request, answered by the runner's frame */
async function startGatewayProxy(write: (f: EngineTaskOutFrame) => Promise<void>, answers: Map<string, (f: EngineTaskInFrame) => void>, timeoutMs: number) {
  let next = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const fail = (status: number) => {
      res.statusCode = status;
      res.end();
    };
    const method = req.method === "GET" || req.method === "POST" ? req.method : null;
    if (!method || !req.url || !req.url.startsWith("/") || req.url.startsWith("//")) return fail(400);
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > ENGINE_TASK_HTTP_BODY_MAX_BYTES) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      const id = String(next++);
      const headers: Record<string, string> = {};
      for (const h of ENGINE_TASK_HTTP_HEADERS) {
        const v = req.headers[h];
        if (typeof v === "string" && /^[\x20-\x7e]{0,4096}$/.test(v)) headers[h] = v;
      }
      const timer = setTimeout(() => {
        answers.delete(id);
        fail(504);
      }, timeoutMs);
      answers.set(id, (a) => {
        clearTimeout(timer);
        answers.delete(id);
        if (a.t === "http_err") return fail(a.code === "not_gateway" ? 403 : a.code === "too_large" ? 413 : a.code === "unauthorized" ? 401 : a.code === "busy" ? 429 : 502);
        res.statusCode = a.status;
        if (a.headers["content-type"]) res.setHeader("content-type", a.headers["content-type"]);
        res.end(Buffer.from(a.body, "base64"));
      });
      void write({ t: "http", id, method, path: req.url!, headers, body: Buffer.concat(chunks).toString("base64") });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/**
 * Run the engine's one job inside the sandbox and send its results. Returns the exit code the task-main exits with
 * (0 when every result was sent; the results themselves say how the engine did).
 */
export async function runSandboxTask(opts: SandboxTaskOptions & { doneFile?: string }): Promise<number> {
  const out = opts.stdout ?? process.stdout;
  const log = (m: string) => void process.stderr.write(`${m}\n`);
  const write = frameWriter(out);
  const jobsRoot = opts.jobsRoot ?? "/jobs";
  const workRoot = opts.workRoot ?? "/work";
  const secret = (opts.readSecret ?? readTaskSecretFd)();
  const runs = (await readdir(jobsRoot).catch(() => [] as string[])).filter((n) => UUID.test(n));
  if (runs.length !== 1) {
    log(`task: expected exactly one job under ${jobsRoot}, found ${runs.length}`);
    await write({ t: "end", code: 2 });
    return 2;
  }
  const runId = runs[0]!;
  const resultsRoot = path.join(workRoot, "out");
  await rm(resultsRoot, { recursive: true, force: true });
  await mkdir(path.join(resultsRoot, runId), { recursive: true, mode: 0o700 });

  // the gateway channel: answers arrive on stdin
  const answers = new Map<string, (f: EngineTaskInFrame) => void>();
  const rl = createInterface({ input: opts.stdin ?? process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    let f: EngineTaskInFrame | null = null;
    try {
      const p = engineTaskInFrameSchema.safeParse(JSON.parse(line));
      f = p.success ? p.data : null;
    } catch {
      f = null;
    }
    if (f) answers.get(f.id)?.(f);
  });
  const proxy = opts.gateway ? await startGatewayProxy(write, answers, opts.httpTimeoutMs ?? 300_000) : null;
  let code = 0;
  try {
    await opts.run({ runId, jobsRoot, resultsRoot, workRoot: path.join(workRoot, "run"), secret, gatewayOrigin: proxy?.origin ?? null, log });
  } catch (e) {
    // the engine's own failure: whatever it wrote is still sent (its done file says what happened, or is absent)
    log(`task: the engine failed: ${e instanceof Error ? e.message : String(e)}`);
    code = 1;
  } finally {
    proxy?.server.close();
    rl.close();
  }
  for (const f of await resultFiles(resultsRoot, runId, opts.doneFile ?? "done.json")) await sendFile(write, f.rel, f.abs);
  await write({ t: "end", code });
  await rm(resultsRoot, { recursive: true, force: true });
  return code;
}

/** a job copied from the read-only input to scratch space, with the task's secret and the gateway channel applied */
export async function prepareJobCopy(
  ctx: SandboxTaskContext,
  edit: (job: Record<string, unknown>) => Record<string, unknown>,
): Promise<string> {
  const src = path.join(ctx.jobsRoot, ctx.runId);
  const dst = path.join(ctx.workRoot, "jobs");
  await rm(dst, { recursive: true, force: true });
  await mkdir(path.join(dst, ctx.runId), { recursive: true, mode: 0o700 });
  for (const e of await readdir(src, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const bytes = await readFile(path.join(src, e.name));
    const body = e.name === "job.json" ? Buffer.from(JSON.stringify(edit(JSON.parse(bytes.toString("utf8")) as Record<string, unknown>)), "utf8") : bytes;
    await writeFile(path.join(dst, ctx.runId, e.name), body, { mode: 0o600 });
  }
  return dst;
}

/**
 * ADR-0190 decision 10 — THE RUNTIME PROBE in an engine's self-test: what the worker observes of its runtime from
 * inside (the kernel it is told it runs on, whether `/proc/version` names gVisor, its uid, effective capabilities,
 * no_new_privs and seccomp mode). Recorded in the worker's self-test, NEVER decisive (review H2): the class is decided
 * from outside the sandbox by the executor, and an image can make an interpreter print anything.
 */
export function sandboxRuntimeObservation(read: (p: string) => string = (p) => readFileSync(p, "utf8")): SandboxRuntimeObservation {
  const safe = (p: string) => {
    try {
      return read(p);
    } catch {
      return "";
    }
  };
  const status: Record<string, string> = {};
  for (const line of safe("/proc/self/status").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) status[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  const int = (v: string | undefined) => {
    const n = Number.parseInt(v ?? "", 10);
    return Number.isInteger(n) ? n : -1;
  };
  const kernel = safe("/proc/sys/kernel/osrelease").trim();
  return {
    kernelRelease: /^[A-Za-z0-9._+-]{1,128}$/.test(kernel) ? kernel : "unknown",
    procVersionGvisor: /gvisor/i.test(safe("/proc/version")),
    uid: int((status.Uid ?? "").split(/\s+/)[0]),
    capEff: /^[0-9a-f]{16}$/i.test(status.CapEff ?? "") ? status.CapEff!.toLowerCase() : "unknown",
    noNewPrivs: int(status.NoNewPrivs),
    seccomp: int(status.Seccomp),
  };
}

/** point a gateway base URL at the loopback channel, keeping the gateway's own path */
export function viaGatewayChannel(baseUrl: string, gatewayOrigin: string): string {
  const u = new URL(baseUrl);
  return `${gatewayOrigin}${u.pathname}${u.search}`;
}
