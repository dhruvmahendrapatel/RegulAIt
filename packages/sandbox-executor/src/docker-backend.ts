/**
 * ADR-0190 — THE DOCKER SANDBOX CORE shared by the Docker-based backends: the gVisor backend (`runsc-backend.ts`,
 * slice I4, attests L2 `user_space_kernel`) and the runc backend (`runc-backend.ts`, attests L1
 * `hardened_container`). Moved here unchanged from the I4 runsc backend when the runc backend was added, so both
 * start a sandbox with the SAME OCI hardening and differ only in the runtime and in how each proves it.
 *
 * Open source first (ADR-0176): the container lifecycle is Docker's own CLI (`docker run -i`, `docker kill`,
 * `docker rm`), and the executor-side observations are read from the Docker Engine API (`/info`,
 * `/containers/{id}/json`, `/containers/{id}/stats`) over the same socket. Nothing here builds a sandbox: it asks
 * Docker to start one under the runtime the operator registered, then checks what it got.
 *
 * WHAT A SANDBOX IS (`dockerRunArgs`): the closure image by its content digest (never a tag, never pulled:
 * `--pull never`), the backend's runtime, no network (`--network none`; the stdio pipe is the decision 4 channel), a
 * read-only root, one tmpfs work directory (`noexec` under `exec: image_only`), the profile's uid, no capabilities,
 * `no-new-privileges`, the runtime-default (or the profile's named) seccomp profile, CPU, memory (no swap), the host
 * `pids.max` and `RLIMIT_NPROC` for the workload (amendment C), no IPC namespace sharing, no log driver, no
 * environment passed in. Its entry point is the executor's hash-pinned sandbox init (`sandbox-init/`), mounted
 * read-only from a volume the executor owns; it probes from inside BEFORE any input and waits for the release line.
 *
 * WHAT DECIDES THE CLASS: only what the executor sees from OUTSIDE the sandbox (each backend's
 * `containerRuntimeVerified` and `probesFor`); the init's inside view corroborates and its kernel strings are recorded,
 * never trusted.
 *
 * I5's two channels for engine tasks (`engine_worker`) are here too: the read-only INPUT VOLUME (`task-input.ts`,
 * written and verified before the sandbox exists, mounted read-only, removed with the sandbox) and the TASK SECRET
 * (on the release line only, then fd 3; never in the environment, argv, labels, a log or a disk).
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  ENGINE_TASK_INPUT_NAME,
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
  type RequirableIsolationClass,
} from "@regulait/shared";
import type { BackendDescription, ProbeSet, SandboxBackend, SandboxHandle, SandboxStdio } from "./backend.js";
import { reconcileTaskInputs, removeTaskInput, writeTaskInput, type SandboxTaskInput } from "./task-input.js";
import { SANDBOX_INIT_SHA256 } from "./init-pin.js";

/** the name of every sandbox this backend starts (and of its input directory) */
const SANDBOX_NAME = /^regulait-sbx-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** sha256 of a file (the init pin) */
export const sha256Of = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");

export type DockerChild = ChildProcessByStdio<Writable, Readable, Readable>;

/** every refusal of a Docker-based backend (runsc and runc): nothing was started, or the sandbox was stopped */
export class DockerBackendError extends Error {}

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
  /** the container's own HostConfig as `docker inspect` reports it (the runc backend's outside hardening check reads it) */
  hostConfig?: ContainerHostConfig;
}

/** the parts of a container's `HostConfig` (docker inspect) the backends read; every field as the daemon sent it */
export interface ContainerHostConfig {
  Runtime?: unknown;
  NanoCpus?: unknown;
  CpuQuota?: unknown;
  CpuPeriod?: unknown;
  Memory?: unknown;
  PidsLimit?: unknown;
  Privileged?: unknown;
  CapAdd?: unknown;
  CapDrop?: unknown;
  ReadonlyRootfs?: unknown;
  SecurityOpt?: unknown;
  NetworkMode?: unknown;
  IpcMode?: unknown;
  PidMode?: unknown;
  UsernsMode?: unknown;
  UTSMode?: unknown;
  CgroupnsMode?: unknown;
  Devices?: unknown;
  Binds?: unknown;
  Mounts?: unknown;
}

/**
 * The runtime the executor established from OUTSIDE the sandbox (never from what the sandbox prints): `gvisor` only
 * on the runsc backend's verified evidence, else `runc`; the runtime flags are reported only for gVisor.
 */
export interface OutsideRuntime {
  runtime: "gvisor" | "runc";
  flags: readonly string[];
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
  /**
   * ADR-0190 I5: an engine task's input, a sub-directory of the executor's input volume, mounted READ-ONLY at the
   * profile's input path (Docker's `volume-subpath`, Engine 26 or later)
   */
  input?: { volume: string; subpath: string; mountPath: string } | null;
  /**
   * the runc backend: a private cgroup namespace, asked for explicitly (`--cgroupns private`) rather than left to the
   * daemon's default. The gVisor line is unchanged until #385 verifies L2 (a follow-up there).
   */
  cgroupnsPrivate?: boolean;
}

/**
 * Recheck N4: Node environment variables that make the interpreter load code or change module resolution before the
 * init's first line, blanked on every sandbox's `docker run` (an image may set them in its `ENV`).
 */
export const STDIO_SANDBOX_BLANKED_ENV = ["NODE_OPTIONS", "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE", "NODE_COMPILE_CACHE", "NODE_PRESERVE_SYMLINKS", "NODE_PRESERVE_SYMLINKS_MAIN", "NODE_ICU_DATA"] as const;

/**
 * The profile features the Docker backend cannot honour: refused before any sandbox. I5 adds the two channels I4
 * refused: ONE read-only input named `jobs` (an engine task's, when this executor has an input volume) and
 * `task_scoped` secrets (delivered on the release line, then fd 3). A scoped volume, an allow-list network and
 * `injected_at_egress` secrets are still refused.
 */
export function unsupportedProfileFeature(profile: ExecutionProfileBody, opts: { inputVolume?: boolean } = {}): string | null {
  const inputs = profile.filesystem.inputs;
  if (inputs.length > 0) {
    if (!opts.inputVolume) return "declared read-only inputs (this executor has no input volume)";
    if (inputs.length !== 1 || inputs[0]!.name !== ENGINE_TASK_INPUT_NAME) return `declared read-only inputs other than the one ${ENGINE_TASK_INPUT_NAME} input`;
  }
  if (profile.persistence !== "none") return "a scoped volume";
  if (profile.network.mode === "allow_list") return "an allow-list network";
  if (profile.secrets === "injected_at_egress") return "secrets: injected_at_egress";
  return null;
}

/** `docker run` for one sandbox under `profile` (every value from the profile; nothing from the workload) */
export function dockerRunArgs(input: DockerRunInput): string[] {
  const p = input.profile;
  if (!isStdioClosureImage(input.image)) throw new DockerBackendError("the image must be a content digest (sha256:<64 hex>)");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.runtimeName)) throw new DockerBackendError("the runtime name is not a Docker runtime name");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.initVolume)) throw new DockerBackendError("the init volume is not a Docker volume name");
  const inputMount: string[] = [];
  if (input.input) {
    const i = input.input;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(i.volume)) throw new DockerBackendError("the input volume is not a Docker volume name");
    // the sub-path is ours (the sandbox name and the input name), never the workload's: plain segments only
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(i.subpath)) throw new DockerBackendError("the input sub-path is not ours");
    if (!p.filesystem.inputs.some((x) => x.mountPath === i.mountPath)) throw new DockerBackendError("the input mount path is not the profile's");
    // a comma would start a new mount option: the values above cannot hold one, the mount path is a sandbox path
    if (i.mountPath.includes(",")) throw new DockerBackendError("the input mount path holds a comma");
    inputMount.push("--mount", `type=volume,src=${i.volume},dst=${i.mountPath},readonly,volume-subpath=${i.subpath}`);
  }
  const work = p.filesystem.workDir.path.replace(/\/$/, "");
  const tmpfsOpts = ["rw", "nosuid", "nodev", `size=${p.filesystem.workDir.tmpfsMiB}m`, `mode=0700`, `uid=${p.process.uid}`, `gid=${p.process.uid}`];
  if (p.process.exec === "image_only") tmpfsOpts.push("noexec");
  const seccomp: string[] = [];
  if (p.process.seccomp.type === "Localhost") {
    if (!input.seccompDir) throw new DockerBackendError(`the profile names the seccomp profile ${p.process.seccomp.profile}, and this executor has no seccomp directory`);
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
    ...(input.cgroupnsPrivate ? ["--cgroupns", "private"] : []),
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
    // I5: an engine task's input, read-only, written and verified by this executor before the sandbox starts
    ...inputMount,
    // recheck N4: the image's own environment may not make Node load code before the init (or the workload) runs.
    // These are the only `--env` flags: each BLANKS a variable the image may set, never passes a value in.
    ...STDIO_SANDBOX_BLANKED_ENV.flatMap((name) => ["--env", `${name}=`]),
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
export const notRun = (error: string) => ({ observed: null, error });

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
 * the report), never coerced into a passing shape. The runtime (and its flags)
 * is the one the backend established from outside (`outside`): nothing the
 * sandbox prints decides it.
 */
export function probesFromObservation(init: InitObservation, side: ExecutorSideObservation, outside: OutsideRuntime, wanted: readonly AttestationProbe[]): ProbeSet {
  const out: Record<string, unknown> = {};
  const gvisor = outside.runtime === "gvisor";
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
          runtime: outside.runtime,
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
        const flags = outside.flags.map((f) => token(f, 128)).filter((f): f is string => f !== null).slice(0, 32);
        out[probe] = { observed: { backend: outside.runtime, flags: gvisor ? flags : [] } };
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
          if ((res.statusCode ?? 500) >= 300) return reject(new DockerBackendError(`docker API ${apiPath} answered ${res.statusCode}`));
          try {
            resolve(JSON.parse(body) as unknown);
          } catch {
            reject(new DockerBackendError(`docker API ${apiPath} answered a body that is not JSON`));
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
      throw new DockerBackendError("a stdout line is not valid UTF-8");
    }
  };
  let parts: Buffer[] = [];
  let pending = 0;
  for await (const chunk of stream) {
    let buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer);
    let nl: number;
    while ((nl = buf.indexOf(0x0a)) >= 0) {
      if (pending + nl > max) throw new DockerBackendError("a stdout line exceeded the frame limit");
      parts.push(buf.subarray(0, nl));
      yield decode(parts);
      parts = [];
      pending = 0;
      buf = buf.subarray(nl + 1);
    }
    if (buf.length > 0) {
      pending += buf.length;
      if (pending > max) throw new DockerBackendError("a stdout line exceeded the frame limit");
      parts.push(buf);
    }
  }
  if (pending > 0) yield decode(parts);
}
// ---------------------------------------------------------------------------
// The backend core
// ---------------------------------------------------------------------------

/** what every Docker-based backend is configured with */
export interface DockerBackendOptions {
  /** the Docker runtime name every sandbox is started under (`--runtime`), checked on the container afterwards */
  runtimeName: string;
  /** the canary image for the self-test: the RegulAIt stdio base image, by content digest */
  canaryImage: string;
  /** the runtime release installed on the host, as the operator pinned it (informational, announced) */
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
   * ADR-0190 I5: the executor's INPUT VOLUME (a Docker volume) and where this executor has it mounted. An engine task's
   * input is written under `<inputDir>/<sandbox name>/jobs` and that sub-path is mounted read-only into the sandbox.
   * Unset here = `REGULAIT_EXECUTOR_INPUT_DIR` and `REGULAIT_EXECUTOR_INPUT_VOLUME` (null = none). Without both, profiles
   * with inputs are refused (no engine tasks on this executor).
   */
  inputDir?: string | null;
  inputVolume?: string | null;
  /** how long the sandbox init may take to print its probes (default 60 s) */
  probeTimeoutMs?: number;
  /** test seams */
  spawnDocker?: (args: string[], env: NodeJS.ProcessEnv) => DockerChild;
  dockerApi?: (apiPath: string) => Promise<unknown>;
}

/** what a backend's runtime check found before a sandbox: the runtime's path and arguments as the daemon names them */
export interface RuntimeCheck {
  path: string | null;
  args: string[];
  /** the backend's own outside evidence for this runtime held (runsc: the pinned binary; runc: the daemon's posture) */
  verified: boolean;
}

/**
 * The lifecycle every Docker-based backend shares: preflight, the init pin, the input volume, `docker run` with the
 * profile's hardening, the probe line, the outside observation, release, stdio, limits and cleanup. A backend supplies
 * its name, the ONE class it attests, its runtime check and how its outside evidence maps onto the probes.
 */
export abstract class DockerSandboxBackend implements SandboxBackend {
  protected readonly api: (p: string) => Promise<unknown>;
  protected readonly dockerBin: string;
  protected readonly socket: string;
  private readonly inputDir: string | null;
  private readonly inputVolume: string | null;
  private inputsReconciled = false;

  /** the backend's name in refusals ("runsc", "runc") */
  protected abstract readonly label: string;
  /** the ONE class this backend attests; a sandbox at any other class is refused before it starts */
  protected abstract readonly attestedClass: RequirableIsolationClass;

  constructor(protected readonly options: DockerBackendOptions) {
    if (!isStdioClosureImage(options.canaryImage)) throw new DockerBackendError("the canary image must be a content digest (sha256:<64 hex>)");
    if (!/^[A-Za-z0-9._+-]{1,128}$/.test(options.runtimeVersion)) throw new DockerBackendError("the runtime version is not a version string");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(options.runtimeName)) throw new DockerBackendError("the runtime name is not a Docker runtime name");
    this.socket = options.dockerSocket ?? "/var/run/docker.sock";
    this.api = options.dockerApi ?? dockerApiGet(this.socket);
    this.dockerBin = options.dockerBin ?? "docker";
    // I5: the input volume, from the options or (unset there) the executor's environment; both or neither (a half
    // configuration refuses engine tasks, never runs them without their input)
    const dir = options.inputDir === undefined ? (process.env.REGULAIT_EXECUTOR_INPUT_DIR ?? null) : options.inputDir;
    const vol = options.inputVolume === undefined ? (process.env.REGULAIT_EXECUTOR_INPUT_VOLUME ?? null) : options.inputVolume;
    this.inputDir = dir && vol ? dir : null;
    this.inputVolume = dir && vol ? vol : null;
  }

  abstract describe(): BackendDescription;
  /** the runtime's checks before any sandbox (`force`: a self-test re-checks everything it caches) */
  protected abstract checkRuntime(force: boolean): Promise<RuntimeCheck>;
  /** after the container started: does THIS container's runtime (docker inspect) carry the backend's evidence? */
  protected abstract containerRuntimeVerified(containerRuntime: string | null, rt: RuntimeCheck): Promise<boolean>;
  /** extra `docker run` choices a backend makes (the runc backend asks for a private cgroup namespace) */
  protected runOptions(): { cgroupnsPrivate: boolean } {
    return { cgroupnsPrivate: false };
  }
  /** the report's probes from the init's line and the executor's outside observation */
  protected abstract probesFor(init: InitObservation, side: ExecutorSideObservation, profile: ExecutionProfileBody, wanted: readonly AttestationProbe[]): ProbeSet;

  /** review MEDIUM-2: a profile this host cannot place under (no input volume for an engine task, …) is never attested */
  unsupported(profile: ExecutionProfileBody): string | null {
    return unsupportedProfileFeature(profile, { inputVolume: this.inputDir !== null && this.inputVolume !== null });
  }

  /**
   * The init this executor mounts: its shipped file and the copy in the init volume both hash to the pin. The copy
   * is (re)written from the shipped file, read-only, whenever it is missing or differs.
   */
  async verifyInit(): Promise<void> {
    const shipped = await sha256Of(this.options.initSource);
    if (shipped !== SANDBOX_INIT_SHA256) throw new DockerBackendError(`the sandbox init ${this.options.initSource} is not the pinned init (sha256 ${shipped}); nothing was started`);
    const target = path.join(this.options.initDir, "sandbox-init.mjs");
    let copied: string | null = null;
    try {
      copied = await sha256Of(target);
    } catch {
      copied = null;
    }
    if (copied !== SANDBOX_INIT_SHA256) {
      await mkdir(this.options.initDir, { recursive: true });
      await chmod(target, 0o644).catch(() => undefined);
      await copyFile(this.options.initSource, target);
      await chmod(target, 0o444);
      if ((await sha256Of(target)) !== SANDBOX_INIT_SHA256) throw new DockerBackendError("the init copy in the init volume does not match the pin; nothing was started");
    }
  }

  /** check, before any sandbox, the backend's runtime and the init; the first preflight also clears stale inputs */
  async preflight(force = false): Promise<RuntimeCheck> {
    const rt = await this.checkRuntime(force);
    await this.verifyInit();
    // review LOW-2: the first preflight removes the inputs a previous run of this executor left behind
    if (!this.inputsReconciled && this.inputDir !== null) {
      await reconcileTaskInputs(this.inputDir, (n) => SANDBOX_NAME.test(n));
      this.inputsReconciled = true;
    }
    return rt;
  }

  private run(args: string[]): DockerChild {
    const env = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", DOCKER_HOST: `unix://${this.socket}` };
    if (this.options.spawnDocker) return this.options.spawnDocker(args, env);
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

  private async sandbox(kind: "canary" | "placement", image: string, profile: ExecutionProfileBody, cls: AppliedIsolationKind, task?: SandboxTaskInput): Promise<SandboxHandle> {
    if (cls !== this.attestedClass) throw new DockerBackendError(`the ${this.label} backend attests ${this.attestedClass} only (asked ${cls})`);
    const inputVolume = this.inputDir !== null && this.inputVolume !== null;
    if (kind === "placement") {
      const unsupported = unsupportedProfileFeature(profile, { inputVolume });
      if (unsupported) throw new DockerBackendError(`the profile asks for ${unsupported}, which the ${this.label} backend does not provide in this release; nothing was started`);
      // I5: an input is required exactly when the profile declares one (a task without one, or one with an input the
      // profile does not declare, is refused: the sandbox never runs on an input nobody checked)
      if ((profile.filesystem.inputs.length > 0) !== (task !== undefined)) throw new DockerBackendError("the task's input does not match the profile's declared inputs; nothing was started");
    }
    // a self-test re-checks the runtime; a placement re-checks whatever the backend caches when it changed
    const rt = await this.preflight(kind === "canary");
    const name = `regulait-sbx-${randomUUID()}`;
    // I5: the input, written and verified under this executor's input volume BEFORE the sandbox exists
    let inputSha256: string | undefined;
    let inputRoot: string | null = null;
    let input: DockerRunInput["input"] = null;
    if (kind === "placement" && task) {
      const declared = profile.filesystem.inputs[0]!;
      inputRoot = path.join(this.inputDir!, name);
      try {
        inputSha256 = await writeTaskInput(path.join(inputRoot, declared.name), task);
      } catch (e) {
        // review LOW-2: the sandbox's whole input directory goes, not only the input under it
        await removeTaskInput(inputRoot).catch(() => undefined);
        throw e;
      }
      input = { volume: this.inputVolume!, subpath: `${name}/${declared.name}`, mountPath: declared.mountPath };
    }
    const cleanupInput = async () => {
      if (inputRoot) await removeTaskInput(inputRoot).catch(() => undefined);
    };
    let args: string[];
    try {
      args = dockerRunArgs({ name, runtimeName: this.options.runtimeName, image, profile, canary: kind === "canary", seccompDir: this.options.seccompDir ?? null, initVolume: this.options.initVolume, input, ...this.runOptions() });
    } catch (e) {
      await cleanupInput();
      throw e;
    }
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
        // I5: the task's input goes with its sandbox (the task secret never touched a disk)
        await cleanupInput();
        endedResolve(outcome ?? (oom ? "limit_exceeded" : code === 0 ? "completed" : "failed"));
      })();
    });

    // the init's probe line: the first stdout line, within the probe deadline
    const timeoutMs = this.options.probeTimeoutMs ?? 60_000;
    let timer: NodeJS.Timeout | undefined;
    let init: InitObservation | null = null;
    try {
      const first = await Promise.race([
        lines.next(),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new DockerBackendError(`the sandbox init printed no probes within ${timeoutMs} ms`)), timeoutMs);
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
      throw new DockerBackendError("the sandbox did not start the RegulAIt sandbox init (is the image built FROM the stdio base?)");
    }
    const inspect = (await this.api(`/containers/${name}/json`)) as { Image?: unknown; HostConfig?: unknown };
    let throttled = 0;
    try {
      const stats = (await this.api(`/containers/${name}/stats?stream=false&one-shot=true`)) as { cpu_stats?: { throttling_data?: { throttled_periods?: unknown } } };
      throttled = num(stats.cpu_stats?.throttling_data?.throttled_periods);
    } catch {
      throttled = 0;
    }
    const hostConfig: ContainerHostConfig = inspect.HostConfig !== null && typeof inspect.HostConfig === "object" ? (inspect.HostConfig as ContainerHostConfig) : {};
    const containerRuntime = typeof hostConfig.Runtime === "string" ? hostConfig.Runtime : null;
    const side: ExecutorSideObservation = {
      containerRuntime,
      runtimeBinaryVerified: await this.containerRuntimeVerified(containerRuntime, rt),
      runtimePath: rt.path,
      runtimeArgs: rt.args,
      imageId: typeof inspect.Image === "string" ? inspect.Image : null,
      nanoCpus: num(hostConfig.NanoCpus),
      cpuQuota: num(hostConfig.CpuQuota),
      cpuPeriod: num(hostConfig.CpuPeriod),
      memoryBytes: num(hostConfig.Memory),
      pidsLimit: num(hostConfig.PidsLimit),
      throttledPeriods: throttled,
      hostConfig,
    };
    const observedImage = side.imageId && isStdioClosureImage(side.imageId) ? side.imageId : `sha256:${"0".repeat(64)}`;
    let released = false;
    let outputBytes = 0;
    const outputLimit = profile.resources.outputBytes;

    const stdio: SandboxStdio | undefined =
      kind === "placement"
        ? {
            async write(line: string) {
              if (!released) throw new DockerBackendError("stdin before release");
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
        return self.probesFor(init!, side, profile, probes);
      },
      ...(inputSha256 !== undefined ? { inputSha256 } : {}),
      async releaseInput(workload, secret) {
        if (outcome !== null) throw new DockerBackendError("the sandbox has already ended");
        // decision 5: a secret reaches only a profile that admits one (`task_scoped`), and only with a workload
        if (secret !== undefined && (profile.secrets !== "task_scoped" || !workload)) throw new DockerBackendError("this sandbox's profile admits no task secret");
        released = true;
        // I5: the task secret rides the release line on the init's stdin (never env, argv or a file Docker can show);
        // the init hands it to the workload on fd 3. The line is written once and not kept.
        const line = JSON.stringify(
          workload ? { "regulait-release": 1, argv: [workload.command, ...workload.args], ...(secret !== undefined ? { secret } : {}) } : { "regulait-release": 1 },
        );
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
    return this.sandbox("canary", this.options.canaryImage, profile, cls);
  }

  async start(offer: ExecutionOffer, profile: ExecutionProfileBody, cls: AppliedIsolationKind, task?: SandboxTaskInput): Promise<SandboxHandle> {
    // I5: engine tasks (`engine_worker`) join I4's stdio servers; code execution and BYOC workers are not built
    if (offer.workloadKind !== "mcp_stdio" && offer.workloadKind !== "engine_worker") {
      throw new DockerBackendError(`the ${this.label} backend runs mcp_stdio and engine_worker placements in this release (offer is ${offer.workloadKind})`);
    }
    if (offer.workloadKind === "mcp_stdio" && task) throw new DockerBackendError("a stdio MCP server takes no task input");
    // an engine task runs on its input: a profile with no input cannot run one (the gateway would refuse its report)
    if (offer.workloadKind === "engine_worker" && profile.filesystem.inputs.length === 0) throw new DockerBackendError("an engine task's profile declares no input; nothing was started");
    return this.sandbox("placement", offer.imageDigest, profile, cls, task);
  }
}
