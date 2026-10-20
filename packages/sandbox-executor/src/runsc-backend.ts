/**
 * ADR-0190 slice I4 — THE gVisor (`runsc`) BACKEND, for a Docker host whose
 * daemon has `runsc` registered as a runtime (compose: `runtime: runsc`).
 *
 * Open source first (ADR-0176): the isolation is gVisor's, the container
 * lifecycle is Docker's own CLI (`docker run -i`, `docker kill`, `docker rm`),
 * and the executor-side observations are read from the Docker Engine API
 * (`/info`, `/containers/{id}/json`, `/containers/{id}/stats`) over the same
 * socket. Nothing here builds a sandbox: it only asks Docker to start one
 * under the runtime the operator registered, then checks what it got. The
 * sandbox lifecycle and its OCI hardening (`dockerRunArgs`) are shared with the
 * runc (L1) backend in `docker-backend.ts`; this file holds what proves gVisor.
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
 * What this backend refuses to start (an error before any sandbox): a scoped
 * volume, an allow-list network or `injected_at_egress` secrets (none of those
 * channels exists, and running such a profile without them would not be what
 * the profile says).
 *
 * I5 ADDS TWO CHANNELS for engine tasks (`engine_worker`), in the shared core:
 *  - the INPUT VOLUME: the task's input is fetched from the gateway, written
 *    under this executor's input volume and verified file by file
 *    (`task-input.ts`) BEFORE the sandbox exists, then mounted READ-ONLY at
 *    the profile's one `jobs` input (Docker's `volume-subpath`); its digest
 *    is in the per-placement report and checked by the gateway; it is removed
 *    with the sandbox;
 *  - the TASK SECRET (`task_scoped`, decision 5): it arrives in the gateway's
 *    MACed `start` line and is written once, on the release line, to the
 *    init's stdin; the init hands it to the workload on fd 3. It is never in
 *    the sandbox's environment, argv or labels (nothing `docker inspect`
 *    shows), never logged, never on a disk.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { AttestationProbe, ExecutionProfileBody } from "@regulait/shared";
import type { BackendDescription, ProbeSet } from "./backend.js";
import {
  DockerBackendError,
  DockerSandboxBackend,
  probesFromObservation,
  runtimeFromInfo,
  type DockerBackendOptions,
  type ExecutorSideObservation,
  type InitObservation,
  type RuntimeCheck,
} from "./docker-backend.js";
import { RUNSC_RELEASES } from "./init-pin.js";

/** sha512 of a file, streamed */
export function sha512FileHex(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha512");
    createReadStream(file).on("error", reject).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex")));
  });
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RunscBackendOptions extends DockerBackendOptions {
  /** the Docker runtime name registered with the runsc binary (daemon.json `runtimes`) */
  runtimeName: string;
  /** the gVisor release installed on the host, as the operator pinned it (informational, announced) */
  runtimeVersion: string;
  /**
   * Review H2: the runsc binary as this executor can read it (the host's gVisor DIRECTORY, mounted read-only, so a
   * replaced binary is seen: a single-file bind mount would pin the old inode, recheck N1), and
   * the path the DAEMON names for it. The daemon's path must be `runscHostPath`, and the binary's sha512 a pinned
   * release (`RUNSC_RELEASES`).
   */
  runscBinary: string;
  runscHostPath: string;
  /** test seam: the sha512 of a file (default: read and hash it) */
  sha512File?: (file: string) => Promise<string>;
}

/** the runsc backend's refusals are the Docker core's (one class, so `instanceof` holds under either name) */
export const RunscBackendError = DockerBackendError;
export type RunscBackendError = DockerBackendError;

/**
 * The probes of a sandbox this backend started. Review H2: gVisor ONLY on the executor's own outside evidence (this
 * container's runtime by `docker inspect`, and the daemon's binary for it hashed against the pinned release). Nothing
 * the sandbox prints decides it either way: its kernel strings (`/proc/version`, dmesg) are recorded, never trusted:
 * the image's interpreter could forge them, and gVisor does not promise to name itself in `/proc/version`. Anything
 * else is reported as `runc` with no flags, and the gateway refuses it at L2.
 */
export function probesFrom(init: InitObservation, side: ExecutorSideObservation, opts: { runtimeName: string }, wanted: readonly AttestationProbe[]): ProbeSet {
  const isRunsc = side.runtimeBinaryVerified === true && side.containerRuntime === opts.runtimeName;
  return probesFromObservation(init, side, isRunsc ? { runtime: "gvisor", flags: side.runtimeArgs } : { runtime: "runc", flags: [] }, wanted);
}

// ---------------------------------------------------------------------------
// The backend
// ---------------------------------------------------------------------------

export class RunscDockerBackend extends DockerSandboxBackend {
  protected readonly label = "runsc";
  protected readonly attestedClass = "user_space_kernel" as const;

  /**
   * the runsc binary's identity when it was last verified (device, inode, size, mtime, ctime); re-hashed when any of
   * them changes (recheck N1: a replace-by-rename is a new inode, an in-place write moves size, mtime or ctime)
   */
  private verifiedBinary: string | null = null;

  constructor(private readonly opts: RunscBackendOptions) {
    super(opts);
    if (!RUNSC_RELEASES[opts.runtimeVersion]) throw new RunscBackendError(`gVisor ${opts.runtimeVersion} is not a pinned release (init-pin.ts)`);
  }

  describe(): BackendDescription {
    // a runsc host attests L2 only: an L1 (runc) placement is never served by this backend
    return { backend: "gvisor", runtimeVersion: this.opts.runtimeVersion, classes: ["user_space_kernel"] };
  }

  /** the runsc binary the daemon names is the pinned release (re-hashed whenever its file identity changes) */
  private async binaryVerified(daemonPath: string | null, force: boolean): Promise<boolean> {
    if (daemonPath !== this.opts.runscHostPath) return false;
    let st;
    try {
      st = await stat(this.opts.runscBinary);
    } catch {
      return false;
    }
    const identity = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    if (!force && this.verifiedBinary === identity) return true;
    const sum = await (this.opts.sha512File ?? sha512FileHex)(this.opts.runscBinary);
    if (sum !== RUNSC_RELEASES[this.opts.runtimeVersion]) {
      this.verifiedBinary = null;
      return false;
    }
    this.verifiedBinary = identity;
    return true;
  }

  /** before any sandbox: the daemon has the runtime, and its binary is the pinned runsc */
  protected async checkRuntime(force: boolean): Promise<RuntimeCheck> {
    const rt = runtimeFromInfo(await this.api("/info"), this.opts.runtimeName);
    if (!rt.path) throw new RunscBackendError(`the Docker daemon has no runtime named ${this.opts.runtimeName}; register runsc in daemon.json (see INSTALL.md)`);
    if (rt.path !== this.opts.runscHostPath) throw new RunscBackendError(`the runtime ${this.opts.runtimeName} is ${rt.path}, not the gVisor install at ${this.opts.runscHostPath}`);
    const verified = await this.binaryVerified(rt.path, force);
    if (!verified) throw new RunscBackendError(`the binary at ${this.opts.runscHostPath} is not gVisor ${this.opts.runtimeVersion} (its sha512 is not the pinned one)`);
    return { path: rt.path, args: rt.args, verified };
  }

  /** the daemon's binary for THIS container's runtime (looked up by the name inspect reports, not the one asked for) */
  protected async containerRuntimeVerified(containerRuntime: string | null, rt: RuntimeCheck): Promise<boolean> {
    return containerRuntime === this.opts.runtimeName && rt.verified && (await this.binaryVerified(runtimeFromInfo(await this.api("/info"), containerRuntime).path, false));
  }

  protected probesFor(init: InitObservation, side: ExecutorSideObservation, _profile: ExecutionProfileBody, wanted: readonly AttestationProbe[]): ProbeSet {
    return probesFrom(init, side, { runtimeName: this.opts.runtimeName }, wanted);
  }
}
