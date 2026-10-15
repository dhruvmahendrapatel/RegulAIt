/**
 * ADR-0190 slice I4 — THE gVisor (`runsc`) BACKEND, for a Docker host whose
 * daemon has `runsc` registered as a runtime (compose: `runtime: runsc`).
 *
 * Open source first (ADR-0176): the isolation is gVisor's, the container
 * lifecycle is Docker's own CLI (`docker run -i`, `docker kill`, `docker rm`),
 * and the executor-side observations are read from the Docker Engine API
 * (`/info`, `/containers/{id}/json`, `/containers/{id}/stats`) over the same
 * socket. Nothing here builds a sandbox: it only asks Docker to start one
 * under the runtime the operator registered, then checks what it got.
 *
 * WHAT A SANDBOX IS (`dockerRunArgs`): the closure image by its content digest
 * (never a tag, never pulled: `--pull never`), the `runsc` runtime, no network
 * (`--network none`; the stdio pipe is the decision 4 channel), a read-only
 * root, one tmpfs work directory (`noexec` under `exec: image_only`), the
 * profile's uid, no capabilities, `no-new-privileges`, the runtime-default
 * (or the profile's named) seccomp profile, CPU, memory (no swap), the host
 * `pids.max` with headroom for the Sentry and `RLIMIT_NPROC` for the workload
 * (amendment C), no IPC namespace sharing, no log driver, no environment
 * passed in. Its entry point is the sandbox init (`sandbox-init/`), which
 * probes from inside BEFORE any input and waits for the release line.
 *
 * WHAT PROVES IT IS REALLY runsc (decision 6, amendments A and U; review H2).
 * The class is decided ONLY by what the executor sees from OUTSIDE the
 * sandbox, never by anything the sandbox prints:
 *  - the container's own runtime (`docker inspect` → `HostConfig.Runtime`) is
 *    the configured runtime name;
 *  - that runtime's binary, as the daemon names it, is the binary the
 *    executor can read (mounted read-only from the host) and its sha512 is a
 *    pinned gVisor release (`init-pin.ts`, from the I0-verified tarball);
 *  - its `runtimeArgs` are reported verbatim as `runtime_config.flags`, which
 *    the gateway checks against the profile's `runscFlags`.
 * Only when all three hold is the sandbox reported as gVisor; otherwise it is
 * reported as `runc` with no flags, and the gateway refuses it. The sandbox
 * init (executor-controlled: hash-pinned, mounted read-only, the entry point)
 * reports the inside view (`/proc/self/status`, seccomp, root, egress, DNS,
 * interfaces, credentials, limits); those corroborate. Its kernel string is
 * recorded, never trusted to name the runtime.
 *
 * What this backend refuses to start (an error before any sandbox): a profile
 * with declared inputs, a scoped volume, an allow-list network, or secrets
 * other than `none` — I4 builds none of those channels, and running such a
 * profile without them would not be what the profile says.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  STDIO_FRAME_MAX_BYTES,
  STDIO_SANDBOX_INIT_DIR,
  STDIO_SANDBOX_INIT_PATH,
  STDIO_SANDBOX_NODE,
  isStdioClosureImage,
  stdioLineBytes,
  type AppliedIsolationKind,
  type AttestationProbe,
  type ExecutionOffer,
  type ExecutionProfileBody,
  type ProbeObserved,
} from "@regulait/shared";
import type { BackendDescription, ProbeSet, SandboxBackend, SandboxHandle, SandboxStdio } from "./backend.js";
import { RUNSC_RELEASES, SANDBOX_INIT_SHA256 } from "./init-pin.js";

/** sha512 of a file, streamed */
export function sha512FileHex(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha512");
    createReadStream(file).on("error", reject).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex")));
  });
}
const sha256Of = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RunscBackendOptions {
  /** the Docker runtime name registered with the runsc binary (daemon.json `runtimes`) */
  runtimeName: string;
  /** the canary image for the self-test: the RegulAIt stdio base image, by content digest */
  canaryImage: string;
  /** the gVisor release installed on the host, as the operator pinned it (informational, announced) */
  runtimeVersion: string;
  /** the Docker socket (default /var/run/docker.sock) */
  dockerSocket?: string;
  /** the docker CLI (default `docker` on PATH) */
  dockerBin?: string;
  /** the directory holding `Localhost` seccomp profiles (`<name>.json`); unset = such profiles are refused */
  seccompDir?: string | null;
  /**
   * Review H2: the executor-controlled init. `initSource` is the file this executor ships; it is copied into
   * `initDir` (where this executor mounts the Docker volume `initVolume`), and the volume is mounted read-only into
   * every sandbox. Both copies are checked against `SANDBOX_INIT_SHA256` before a sandbox starts.
   */
  initSource: string;
  initDir: string;
  initVolume: string;
  /**
   * Review H2: the runsc binary as this executor can read it (the host's gVisor directory, mounted read-only), and
   * the path the DAEMON names for it. The daemon's path must be `runscHostPath`, and the binary's sha512 a pinned
   * release (`RUNSC_RELEASES`).
   */
  runscBinary: string;
  runscHostPath: string;
  /** how long the sandbox init may take to print its probes (default 60 s) */
  probeTimeoutMs?: number;
  /** test seams */
  spawnDocker?: (args: string[], env: NodeJS.ProcessEnv) => DockerChild;
  dockerApi?: (apiPath: string) => Promise<unknown>;
  /** test seam: the sha512 of a file (default: read and hash it) */
  sha512File?: (file: string) => Promise<string>;
}

export type DockerChild = ChildProcessByStdio<Writable, Readable, Readable>;

export class RunscBackendError extends Error {}

/** what the sandbox init printed (its raw observations; never a verdict) */
export interface InitObservation {
  runtime: { kernelRelease: string; procVersionGvisor: boolean; dmesgGvisor: boolean; hypervisorFlag: boolean };
  status: { uid: number; capEff: string; noNewPrivs: number; seccomp: number };
  seccomp: { syscall: string; denied?: boolean; inconclusive?: string };
  root: { method: "erofs" | "mount_ro" | "eacces"; readOnly: boolean };
  egressLiteral: { address: string; connected: boolean };
  dns: { host: string; resolved: boolean };
  interfaces: string[];
  credentials: { scanned: Array<"env" | "args" | "fs">; found: number };
  limits: { memTotalMiB: number; rlimitNproc: number; rlimitNofile: number };
}

/** what only the executor can see, from the Docker Engine API */
export interface ExecutorSideObservation {
  /** the container's `HostConfig.Runtime` (docker inspect of THIS container) */
  containerRuntime: string | null;
  /** review H2: the daemon's binary for that runtime is the pinned gVisor release this executor hashed */
  runtimeBinaryVerified: boolean;
  /** the configured runtime's binary path and arguments (`/info` → `Runtimes[name]`) */
  runtimePath: string | null;
  runtimeArgs: string[];
  /** the image the container really runs (`.Image`) */
  imageId: string | null;
  nanoCpus: number;
  cpuQuota: number;
  cpuPeriod: number;
  memoryBytes: number;
  pidsLimit: number;
  throttledPeriods: number;
}

// ---------------------------------------------------------------------------
// The sandbox, as Docker arguments (pure)
// ---------------------------------------------------------------------------

export interface DockerRunInput {
  name: string;
  runtimeName: string;
  image: string;
  profile: ExecutionProfileBody;
  canary: boolean;
  seccompDir?: string | null;
  /** the Docker volume holding the executor's pinned init (mounted read-only) */
  initVolume: string;
}

/** the profile features the Docker backend cannot honour in I4: refused before any sandbox */
export function unsupportedProfileFeature(profile: ExecutionProfileBody): string | null {
  if (profile.filesystem.inputs.length > 0) return "declared read-only inputs";
  if (profile.persistence !== "none") return "a scoped volume";
  if (profile.network.mode === "allow_list") return "an allow-list network";
  if (profile.secrets !== "none") return `secrets: ${profile.secrets}`;
  return null;
}

/** `docker run` for one sandbox under `profile` (every value from the profile; nothing from the workload) */
export function dockerRunArgs(input: DockerRunInput): string[] {
  const p = input.profile;
  if (!isStdioClosureImage(input.image)) throw new RunscBackendError("the image must be a content digest (sha256:<64 hex>)");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.runtimeName)) throw new RunscBackendError("the runtime name is not a Docker runtime name");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.initVolume)) throw new RunscBackendError("the init volume is not a Docker volume name");
  const work = p.filesystem.workDir.path.replace(/\/$/, "");
  const tmpfsOpts = ["rw", "nosuid", "nodev", `size=${p.filesystem.workDir.tmpfsMiB}m`, `mode=0700`, `uid=${p.process.uid}`, `gid=${p.process.uid}`];
  if (p.process.exec === "image_only") tmpfsOpts.push("noexec");
  const seccomp: string[] = [];
  if (p.process.seccomp.type === "Localhost") {
    if (!input.seccompDir) throw new RunscBackendError(`the profile names the seccomp profile ${p.process.seccomp.profile}, and this executor has no seccomp directory`);
    seccomp.push("--security-opt", `seccomp=${path.join(input.seccompDir, `${p.process.seccomp.profile}.json`)}`);
  }
  const cpus = (p.resources.cpuMillis / 1000).toFixed(3).replace(/\.?0+$/, "");
  return [
    "run",
    "-i",
    "--name",
    input.name,
    "--runtime",
    input.runtimeName,
    "--pull",
    "never",
    "--network",
    "none",
    "--ipc",
    "none",
    "--read-only",
    "--tmpfs",
    `${work}:${tmpfsOpts.join(",")}`,
    "--workdir",
    work,
    "--user",
    `${p.process.uid}:${p.process.uid}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    ...seccomp,
    "--cpus",
    cpus,
    "--memory",
    `${p.resources.memoryMiB}m`,
    "--memory-swap",
    `${p.resources.memoryMiB}m`,
    "--pids-limit",
    String(p.process.pids.hostCgroupPidsMax),
    "--ulimit",
    `nproc=${p.process.pids.workloadNproc}:${p.process.pids.workloadNproc}`,
    "--ulimit",
    "nofile=1024:1024",
    "--log-driver",
    "none",
    "--label",
    "org.regulait.sandbox=1",
    // review H2: the init is the executor's, read-only, and it is the entry point (the image cannot replace it)
    "--mount",
    `type=volume,src=${input.initVolume},dst=${STDIO_SANDBOX_INIT_DIR},readonly`,
    "--entrypoint",
    STDIO_SANDBOX_NODE,
    input.image,
    STDIO_SANDBOX_INIT_PATH,
    ...(input.canary ? ["--canary"] : []),
  ];
}

// ---------------------------------------------------------------------------
// Observations → the report's probe set (pure)
// ---------------------------------------------------------------------------

const TOKEN = /^[A-Za-z0-9._:+=@/-]+$/;
const token = (s: string, max: number): string | null => (s.length >= 1 && s.length <= max && TOKEN.test(s) ? s : null);
const notRun = (error: string) => ({ observed: null, error });

/** parse the init's line; null when it is not the init's probe line */
export function parseInitLine(line: string): InitObservation | null {
  let j: unknown;
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof j !== "object" || j === null || (j as Record<string, unknown>)["regulait-sandbox-init"] !== 1) return null;
  const o = (j as { observed?: unknown }).observed;
  return typeof o === "object" && o !== null ? (o as InitObservation) : null;
}

/**
 * Map what the init and the executor observed onto the report's fixed
 * vocabulary. A value that does not fit is `not run` with a code (it fails
 * the report), never coerced into a passing shape.
 */
export function probesFrom(init: InitObservation, side: ExecutorSideObservation, opts: { runtimeName: string }, wanted: readonly AttestationProbe[]): ProbeSet {
  const out: Record<string, unknown> = {};
  // review H2: gVisor ONLY on the executor's own outside evidence (this container's runtime by `docker inspect`, and
  // the daemon's binary for it hashed against the pinned release). Nothing the sandbox prints decides it either way:
  // its kernel strings (`/proc/version`, dmesg) are recorded, never trusted — the image's interpreter could forge
  // them, and gVisor does not promise to name itself in `/proc/version`.
  const isRunsc = side.runtimeBinaryVerified === true && side.containerRuntime === opts.runtimeName;
  for (const probe of wanted) {
    switch (probe) {
      case "runtime_identity": {
        const k = token(init.runtime?.kernelRelease ?? "", 128);
        if (!k) {
          out[probe] = notRun("kernel_unreadable");
          break;
        }
        const observed: ProbeObserved<"runtime_identity"> = {
          // the runtime is what the executor verified from outside; the kernel string inside is recorded only
          runtime: isRunsc ? "gvisor" : "runc",
          kernelVersion: k,
          hypervisor: init.runtime.hypervisorFlag === true,
          // a Docker sandbox is never a hardware VM guest: no distinct guest kernel to report
          guestKernelDistinct: false,
        };
        out[probe] = { observed };
        break;
      }
      case "proc_status": {
        const s = init.status;
        const okSeccomp = s && (s.seccomp === 0 || s.seccomp === 1 || s.seccomp === 2);
        const okNnp = s && (s.noNewPrivs === 0 || s.noNewPrivs === 1);
        if (!s || !Number.isInteger(s.uid) || s.uid < 0 || !/^[0-9a-f]{16}$/.test(s.capEff) || !okSeccomp || !okNnp) {
          out[probe] = notRun("status_unreadable");
          break;
        }
        out[probe] = { observed: { uid: s.uid, capEff: s.capEff, noNewPrivs: s.noNewPrivs as 0 | 1, seccomp: s.seccomp as 0 | 1 | 2 } };
        break;
      }
      case "seccomp_enforced": {
        const s = init.seccomp;
        if (!s || typeof s.denied !== "boolean") {
          out[probe] = notRun("seccomp_probe_inconclusive");
          break;
        }
        out[probe] = { observed: { syscall: "unshare", denied: s.denied } };
        break;
      }
      case "root_read_only": {
        const r = init.root;
        if (!r || !["erofs", "mount_ro", "eacces"].includes(r.method) || typeof r.readOnly !== "boolean") {
          out[probe] = notRun("root_probe_unreadable");
          break;
        }
        out[probe] = { observed: { method: r.method, readOnly: r.readOnly } };
        break;
      }
      case "egress_literal_address": {
        const e = init.egressLiteral;
        if (!e || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(e.address) || typeof e.connected !== "boolean") {
          out[probe] = notRun("egress_probe_unreadable");
          break;
        }
        out[probe] = { observed: { address: e.address, connected: e.connected } };
        break;
      }
      case "egress_dns": {
        const d = init.dns;
        const host = d ? token(d.host, 253) : null;
        if (!host || typeof d.resolved !== "boolean") {
          out[probe] = notRun("dns_probe_unreadable");
          break;
        }
        out[probe] = { observed: { host, resolved: d.resolved } };
        break;
      }
      case "network_interfaces": {
        const names = Array.isArray(init.interfaces) ? init.interfaces.map((n) => token(String(n), 32)) : null;
        if (!names || names.length > 16 || names.some((n) => n === null)) {
          out[probe] = notRun("interfaces_unreadable");
          break;
        }
        // the decision 4 channel is the stdio pipe: no channel interface exists
        out[probe] = { observed: { interfaces: names as string[], channelInterface: null } };
        break;
      }
      case "no_executor_credentials": {
        const c = init.credentials;
        const scanned = Array.isArray(c?.scanned) ? c.scanned.filter((x) => x === "env" || x === "args" || x === "fs") : [];
        if (!c || scanned.length === 0 || !Number.isInteger(c.found) || c.found < 0) {
          out[probe] = notRun("credential_scan_unreadable");
          break;
        }
        out[probe] = { observed: { scanned, found: c.found } };
        break;
      }
      case "visible_limits": {
        const l = init.limits;
        if (!l || !(l.memTotalMiB >= 1) || !(l.rlimitNproc >= 1) || !(l.rlimitNofile >= 1)) {
          out[probe] = notRun("limits_unreadable");
          break;
        }
        out[probe] = { observed: { memTotalMiB: Math.floor(l.memTotalMiB), rlimitNproc: Math.floor(l.rlimitNproc), rlimitNofile: Math.floor(l.rlimitNofile) } };
        break;
      }
      case "host_cgroup_limits": {
        const millis = side.nanoCpus > 0 ? Math.round(side.nanoCpus / 1e6) : side.cpuQuota > 0 && side.cpuPeriod > 0 ? Math.round((side.cpuQuota * 1000) / side.cpuPeriod) : 0;
        const mem = Math.floor(side.memoryBytes / (1024 * 1024));
        if (millis < 1 || mem < 1 || !(side.pidsLimit >= 1)) {
          out[probe] = notRun("host_limit_unset");
          break;
        }
        out[probe] = { observed: { cpuQuotaMillis: millis, memoryLimitMiB: mem, pidsMax: side.pidsLimit, throttledPeriods: Math.max(0, Math.floor(side.throttledPeriods)) } };
        break;
      }
      case "runtime_config": {
        const flags = side.runtimeArgs.map((f) => token(f, 128)).filter((f): f is string => f !== null).slice(0, 32);
        out[probe] = { observed: { backend: isRunsc ? "gvisor" : "runc", flags: isRunsc ? flags : [] } };
        break;
      }
    }
  }
  return out as ProbeSet;
}

// ---------------------------------------------------------------------------
// Docker Engine API (GET only) and the CLI
// ---------------------------------------------------------------------------

export function dockerApiGet(socketPath: string): (apiPath: string) => Promise<unknown> {
  return (apiPath) =>
    new Promise((resolve, reject) => {
      const req = request({ socketPath, path: apiPath, method: "GET", headers: { host: "docker" }, timeout: 15_000 }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          body += c;
          if (body.length > 4 * 1024 * 1024) req.destroy(new Error("docker API answer too large"));
        });
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 300) return reject(new RunscBackendError(`docker API ${apiPath} answered ${res.statusCode}`));
          try {
            resolve(JSON.parse(body) as unknown);
          } catch {
            reject(new RunscBackendError(`docker API ${apiPath} answered a body that is not JSON`));
          }
        });
      });
      req.on("timeout", () => req.destroy(new Error(`docker API ${apiPath} timed out`)));
      req.on("error", reject);
      req.end();
    });
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** the configured runtime as the daemon reports it */
export function runtimeFromInfo(info: unknown, runtimeName: string): { path: string | null; args: string[] } {
  const rt = (info as { Runtimes?: Record<string, { path?: unknown; runtimeArgs?: unknown }> } | null)?.Runtimes?.[runtimeName];
  if (!rt) return { path: null, args: [] };
  return {
    path: typeof rt.path === "string" ? rt.path : null,
    args: Array.isArray(rt.runtimeArgs) ? rt.runtimeArgs.filter((a): a is string => typeof a === "string") : [],
  };
}

/**
 * a bounded line splitter over a byte stream: a line above `max` bytes is an error, never buffered without bound.
 * Review M5: the split is on BYTES (0x0a never occurs inside a multi-byte UTF-8 sequence), and each complete line
 * is decoded once, with a fatal decoder (an invalid sequence is an error, never replaced). Each byte is scanned once
 * and the pending bytes are counted, not re-encoded: linear in the stream's length.
 */
export async function* readLines(stream: Readable, max: number): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const decode = (parts: Buffer[]): string => {
    try {
      return decoder.decode(parts.length === 1 ? parts[0]! : Buffer.concat(parts));
    } catch {
      throw new RunscBackendError("a stdout line is not valid UTF-8");
    }
  };
  let parts: Buffer[] = [];
  let pending = 0;
  for await (const chunk of stream) {
    let buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer);
    let nl: number;
    while ((nl = buf.indexOf(0x0a)) >= 0) {
      if (pending + nl > max) throw new RunscBackendError("a stdout line exceeded the frame limit");
      parts.push(buf.subarray(0, nl));
      yield decode(parts);
      parts = [];
      pending = 0;
      buf = buf.subarray(nl + 1);
    }
    if (buf.length > 0) {
      pending += buf.length;
      if (pending > max) throw new RunscBackendError("a stdout line exceeded the frame limit");
      parts.push(buf);
    }
  }
  if (pending > 0) yield decode(parts);
}

// ---------------------------------------------------------------------------
// The backend
// ---------------------------------------------------------------------------

export class RunscDockerBackend implements SandboxBackend {
  private readonly api: (p: string) => Promise<unknown>;
  private readonly dockerBin: string;
  private readonly socket: string;

  /** the runsc binary's identity when it was last verified (size and mtime); re-hashed when either changes */
  private verifiedBinary: { size: number; mtimeMs: number } | null = null;

  constructor(private readonly opts: RunscBackendOptions) {
    if (!isStdioClosureImage(opts.canaryImage)) throw new RunscBackendError("the canary image must be a content digest (sha256:<64 hex>)");
    if (!/^[A-Za-z0-9._+-]{1,128}$/.test(opts.runtimeVersion)) throw new RunscBackendError("the runtime version is not a version string");
    if (!RUNSC_RELEASES[opts.runtimeVersion]) throw new RunscBackendError(`gVisor ${opts.runtimeVersion} is not a pinned release (init-pin.ts)`);
    this.socket = opts.dockerSocket ?? "/var/run/docker.sock";
    this.api = opts.dockerApi ?? dockerApiGet(this.socket);
    this.dockerBin = opts.dockerBin ?? "docker";
  }

  describe(): BackendDescription {
    // a runsc host attests L2 only: an L1 (runc) placement is never served by this backend
    return { backend: "gvisor", runtimeVersion: this.opts.runtimeVersion, classes: ["user_space_kernel"] };
  }

  /**
   * The init this executor mounts: its shipped file and the copy in the init volume both hash to the pin. The copy
   * is (re)written from the shipped file, read-only, whenever it is missing or differs.
   */
  async verifyInit(): Promise<void> {
    const shipped = await sha256Of(this.opts.initSource);
    if (shipped !== SANDBOX_INIT_SHA256) throw new RunscBackendError(`the sandbox init ${this.opts.initSource} is not the pinned init (sha256 ${shipped}); nothing was started`);
    const target = path.join(this.opts.initDir, "sandbox-init.mjs");
    let copied: string | null = null;
    try {
      copied = await sha256Of(target);
    } catch {
      copied = null;
    }
    if (copied !== SANDBOX_INIT_SHA256) {
      await mkdir(this.opts.initDir, { recursive: true });
      await chmod(target, 0o644).catch(() => undefined);
      await copyFile(this.opts.initSource, target);
      await chmod(target, 0o444);
      if ((await sha256Of(target)) !== SANDBOX_INIT_SHA256) throw new RunscBackendError("the init copy in the init volume does not match the pin; nothing was started");
    }
  }

  /** the runsc binary the daemon names is the pinned release (re-hashed whenever its size or mtime changes) */
  private async binaryVerified(daemonPath: string | null, force: boolean): Promise<boolean> {
    if (daemonPath !== this.opts.runscHostPath) return false;
    let st;
    try {
      st = await stat(this.opts.runscBinary);
    } catch {
      return false;
    }
    if (!force && this.verifiedBinary && this.verifiedBinary.size === st.size && this.verifiedBinary.mtimeMs === st.mtimeMs) return true;
    const sum = await (this.opts.sha512File ?? sha512FileHex)(this.opts.runscBinary);
    if (sum !== RUNSC_RELEASES[this.opts.runtimeVersion]) {
      this.verifiedBinary = null;
      return false;
    }
    this.verifiedBinary = { size: st.size, mtimeMs: st.mtimeMs };
    return true;
  }

  /** check, before any sandbox, that the daemon has the runtime, that its binary is the pinned runsc, and the init */
  async preflight(force = false): Promise<{ path: string; args: string[]; verified: boolean }> {
    const rt = runtimeFromInfo(await this.api("/info"), this.opts.runtimeName);
    if (!rt.path) throw new RunscBackendError(`the Docker daemon has no runtime named ${this.opts.runtimeName}; register runsc in daemon.json (see INSTALL.md)`);
    if (rt.path !== this.opts.runscHostPath) throw new RunscBackendError(`the runtime ${this.opts.runtimeName} is ${rt.path}, not the gVisor install at ${this.opts.runscHostPath}`);
    const verified = await this.binaryVerified(rt.path, force);
    if (!verified) throw new RunscBackendError(`the binary at ${this.opts.runscHostPath} is not gVisor ${this.opts.runtimeVersion} (its sha512 is not the pinned one)`);
    await this.verifyInit();
    return { path: rt.path, args: rt.args, verified };
  }

  private run(args: string[]): DockerChild {
    const env = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", DOCKER_HOST: `unix://${this.socket}` };
    if (this.opts.spawnDocker) return this.opts.spawnDocker(args, env);
    return spawn(this.dockerBin, args, { stdio: ["pipe", "pipe", "pipe"], env });
  }

  private async docker(args: string[]): Promise<number> {
    const child = this.run(args);
    child.stdin.end();
    child.stdout.resume();
    child.stderr.resume();
    return new Promise((resolve) => {
      child.once("error", () => resolve(-1));
      child.once("exit", (code) => resolve(code ?? -1));
    });
  }

  private async sandbox(kind: "canary" | "placement", image: string, profile: ExecutionProfileBody, cls: AppliedIsolationKind): Promise<SandboxHandle> {
    if (cls !== "user_space_kernel") throw new RunscBackendError(`the runsc backend attests user_space_kernel only (asked ${cls})`);
    if (kind === "placement") {
      const unsupported = unsupportedProfileFeature(profile);
      if (unsupported) throw new RunscBackendError(`the profile asks for ${unsupported}, which the runsc backend does not provide in this release; nothing was started`);
    }
    // a self-test re-hashes the runtime binary; a placement re-hashes it when its size or mtime changed
    const rt = await this.preflight(kind === "canary");
    const name = `regulait-sbx-${randomUUID()}`;
    const args = dockerRunArgs({ name, runtimeName: this.opts.runtimeName, image, profile, canary: kind === "canary", seccompDir: this.opts.seccompDir ?? null, initVolume: this.opts.initVolume });
    const child = this.run(args);
    // stderr is drained and discarded (bounded): the server's diagnostics never reach the executor's log
    child.stderr.resume();
    const lines = readLines(child.stdout, STDIO_FRAME_MAX_BYTES)[Symbol.asyncIterator]();
    let outcome: "completed" | "failed" | "killed" | "limit_exceeded" | null = null;
    let endedResolve!: (o: "completed" | "failed" | "killed" | "limit_exceeded") => void;
    const ended = new Promise<"completed" | "failed" | "killed" | "limit_exceeded">((r) => (endedResolve = r));
    const self = this;
    const stop = async (why: "killed" | "limit_exceeded") => {
      if (outcome === null) outcome = why;
      await self.docker(["kill", name]);
    };
    child.once("exit", (code) => {
      void (async () => {
        let oom = false;
        try {
          const j = (await self.api(`/containers/${name}/json`)) as { State?: { OOMKilled?: unknown } };
          oom = j.State?.OOMKilled === true;
        } catch {
          // the container may already be gone
        }
        await self.docker(["rm", "-f", name]);
        endedResolve(outcome ?? (oom ? "limit_exceeded" : code === 0 ? "completed" : "failed"));
      })();
    });

    // the init's probe line: the first stdout line, within the probe deadline
    const timeoutMs = this.opts.probeTimeoutMs ?? 60_000;
    let timer: NodeJS.Timeout | undefined;
    let init: InitObservation | null = null;
    try {
      const first = await Promise.race([
        lines.next(),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new RunscBackendError(`the sandbox init printed no probes within ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
      init = first.done ? null : parseInitLine(first.value);
    } catch (e) {
      await stop("killed");
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (!init) {
      await stop("killed");
      throw new RunscBackendError("the sandbox did not start the RegulAIt sandbox init (is the image built FROM the stdio base?)");
    }
    const inspect = (await this.api(`/containers/${name}/json`)) as {
      Image?: unknown;
      HostConfig?: { Runtime?: unknown; NanoCpus?: unknown; CpuQuota?: unknown; CpuPeriod?: unknown; Memory?: unknown; PidsLimit?: unknown };
    };
    let throttled = 0;
    try {
      const stats = (await this.api(`/containers/${name}/stats?stream=false&one-shot=true`)) as { cpu_stats?: { throttling_data?: { throttled_periods?: unknown } } };
      throttled = num(stats.cpu_stats?.throttling_data?.throttled_periods);
    } catch {
      throttled = 0;
    }
    const containerRuntime = typeof inspect.HostConfig?.Runtime === "string" ? inspect.HostConfig.Runtime : null;
    const side: ExecutorSideObservation = {
      containerRuntime,
      // the daemon's binary for THIS container's runtime (looked up by the name inspect reports, not the one asked for)
      runtimeBinaryVerified: containerRuntime === this.opts.runtimeName && rt.verified && (await this.binaryVerified(runtimeFromInfo(await this.api("/info"), containerRuntime).path, false)),
      runtimePath: rt.path,
      runtimeArgs: rt.args,
      imageId: typeof inspect.Image === "string" ? inspect.Image : null,
      nanoCpus: num(inspect.HostConfig?.NanoCpus),
      cpuQuota: num(inspect.HostConfig?.CpuQuota),
      cpuPeriod: num(inspect.HostConfig?.CpuPeriod),
      memoryBytes: num(inspect.HostConfig?.Memory),
      pidsLimit: num(inspect.HostConfig?.PidsLimit),
      throttledPeriods: throttled,
    };
    const observedImage = side.imageId && isStdioClosureImage(side.imageId) ? side.imageId : `sha256:${"0".repeat(64)}`;
    let released = false;
    let outputBytes = 0;
    const outputLimit = profile.resources.outputBytes;

    const stdio: SandboxStdio | undefined =
      kind === "placement"
        ? {
            async write(line: string) {
              if (!released) throw new RunscBackendError("stdin before release");
              await new Promise<void>((resolve, reject) => child.stdin.write(`${line}\n`, (err) => (err ? reject(err) : resolve())));
            },
            async endInput() {
              child.stdin.end();
            },
            lines: () =>
              (async function* () {
                try {
                  for (;;) {
                    const step = await lines.next();
                    if (step.done) return;
                    outputBytes += stdioLineBytes(step.value) + 1;
                    if (outputBytes > outputLimit) {
                      await stop("limit_exceeded");
                      return;
                    }
                    yield step.value;
                  }
                } catch {
                  await stop("limit_exceeded");
                }
              })(),
          }
        : undefined;

    const sessionLimit = setTimeout(() => void stop("limit_exceeded"), profile.resources.wallClockSecondsPerSession * 1000);
    sessionLimit.unref?.();
    void ended.finally(() => clearTimeout(sessionLimit));

    const handle: SandboxHandle = {
      id: name,
      imageDigest: observedImage,
      async probe(probes) {
        return probesFrom(init!, side, { runtimeName: self.opts.runtimeName }, probes);
      },
      async releaseInput(workload) {
        if (outcome !== null) throw new RunscBackendError("the sandbox has already ended");
        released = true;
        const line = JSON.stringify(workload ? { "regulait-release": 1, argv: [workload.command, ...workload.args] } : { "regulait-release": 1 });
        await new Promise<void>((resolve, reject) => child.stdin.write(`${line}\n`, (err) => (err ? reject(err) : resolve())));
      },
      async kill() {
        await stop("killed");
      },
      ...(stdio ? { stdio } : {}),
      ended,
    };
    return handle;
  }

  async startCanary(profile: ExecutionProfileBody, cls: AppliedIsolationKind): Promise<SandboxHandle> {
    return this.sandbox("canary", this.opts.canaryImage, profile, cls);
  }

  async start(offer: ExecutionOffer, profile: ExecutionProfileBody, cls: AppliedIsolationKind): Promise<SandboxHandle> {
    if (offer.workloadKind !== "mcp_stdio") throw new RunscBackendError(`the runsc backend runs mcp_stdio placements in this release (offer is ${offer.workloadKind})`);
    return this.sandbox("placement", offer.imageDigest, profile, cls);
  }
}
