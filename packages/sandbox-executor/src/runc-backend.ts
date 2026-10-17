/**
 * ADR-0190 — THE runc BACKEND (L1 `hardened_container`), for a Docker host with no user-space kernel: the default
 * OCI runtime with the SAME hardening as the gVisor backend (`docker-backend.ts`'s `dockerRunArgs`: no network, read-only
 * root, no capabilities, `no-new-privileges`, the runtime-default or the profile's seccomp profile, the profile's
 * non-root uid, CPU, memory and pids limits, no IPC sharing, no host path, no environment), minus `runsc`. The
 * workload SHARES THE HOST KERNEL: that is what L1 means (decision 1), and it is never called a sandbox in product
 * text or evidence (decision 11's invariant): L1 is "hardened container".
 *
 * HONEST CLASS. This backend attests `hardened_container` and nothing else: `describe()` names only that class, a
 * container at any other class is refused before it starts, and every report says `runc`. The shared rules then hold on
 * the gateway (`evaluateExecutorReport`): `runc` cannot attest L2 or L3 (`class_not_attestable_by_backend`), a runc
 * runtime observation caps the claim at L1 (`class_above_observed_runtime`), and a placement whose requirement is L2
 * or L3 refuses an L1 attestation (`class_below_required`, in the broker, at accept and at report). No setting turns
 * an L1 executor into an L2 one.
 *
 * WHAT PROVES THE HARDENING (decision 6; the review H2 rule that the outside decides). Before any container, the daemon
 * (`/info`) must have the runtime, a seccomp-capable build whose default is not `unconfined`, and user-namespace
 * remapping or rootless mode (so the container's uid is never a host uid; there is no opt-out in this release). After
 * the container starts, its own `HostConfig` (`docker inspect`) must show the runtime it was asked for, not privileged,
 * every capability dropped and none added, `no-new-privileges`, no `seccomp=unconfined` or `apparmor=unconfined`, a
 * read-only root, network `none`, IPC `none`, a private cgroup namespace (asked for with `--cgroupns private`), no
 * shared PID, UTS or host user namespace, no `systempaths=unconfined` or `label=disable`, no device, device request or
 * device cgroup rule, no bind mount, and only read-only volume mounts. Anything
 * the outside view contradicts makes the matching probe `not run` with a `host_*` code, so the report fails whatever
 * the init printed. The init's inside view (uid, capabilities, seccomp, root, egress, DNS, interfaces, credentials,
 * limits) corroborates, as on gVisor.
 *
 * Open source first (ADR-0176): Docker's own CLI and Engine API, exactly as the gVisor backend; runc is the Docker
 * Engine's default runtime (Apache-2.0), installed with the host's Docker. Nothing new is added to the executor image.
 *
 * NOT VERIFIED (M-041): no session that built this had a Docker daemon. The arguments, the outside checks and the
 * handshake with the real init (run on the host in place of `docker run`) are tested; a real runc run is pending.
 */
import type { AttestationProbe, ExecutionProfileBody } from "@regulait/shared";
import type { BackendDescription, ProbeSet } from "./backend.js";
import {
  DockerBackendError,
  DockerSandboxBackend,
  notRun,
  probesFromObservation,
  runtimeFromInfo,
  type ContainerHostConfig,
  type DockerBackendOptions,
  type ExecutorSideObservation,
  type InitObservation,
  type RuntimeCheck,
} from "./docker-backend.js";

export type RuncBackendOptions = DockerBackendOptions;

/** the daemon posture the runc backend needs, from `/info`; null when it holds, else what is missing */
export function runcDaemonProblem(info: unknown, runtimeName: string): string | null {
  const rt = runtimeFromInfo(info, runtimeName);
  if (!rt.path) return `the Docker daemon has no runtime named ${runtimeName}`;
  const raw = (info as { SecurityOptions?: unknown } | null)?.SecurityOptions;
  const opts = Array.isArray(raw) ? raw.filter((o): o is string => typeof o === "string") : [];
  // each entry is `name=<feature>[,key=value...]` (Docker Engine API `/info`)
  const features = opts.map((o) => {
    const parts = o.split(",");
    const kv = new Map(parts.map((p) => [p.slice(0, Math.max(0, p.indexOf("="))), p.slice(p.indexOf("=") + 1)] as const));
    return { name: kv.get("name") ?? "", profile: kv.get("profile") ?? null };
  });
  const seccomp = features.find((f) => f.name === "seccomp");
  if (!seccomp) return "the Docker daemon reports no seccomp support, so the runtime-default seccomp profile would not apply";
  if (seccomp.profile === "unconfined") return "the Docker daemon's default seccomp profile is unconfined";
  if (!features.some((f) => f.name === "userns" || f.name === "rootless")) {
    return "the Docker daemon runs containers in the host user namespace (enable userns-remap or rootless mode): a hardened container's uid must never be a host uid";
  }
  return null;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * What the container's own HostConfig contradicts, as `[probe, code]` pairs (pure). Every check is on the executor's
 * outside view: the workload cannot influence `docker inspect`.
 */
export function runcHostConfigFailures(hostConfig: ContainerHostConfig, containerRuntime: string | null, runtimeName: string): Array<[AttestationProbe, string]> {
  const out: Array<[AttestationProbe, string]> = [];
  const h = hostConfig;
  if (containerRuntime !== runtimeName) {
    out.push(["runtime_identity", "container_runtime_mismatch"], ["runtime_config", "container_runtime_mismatch"]);
  }
  if (h.Privileged !== false) out.push(["proc_status", "host_privileged"]);
  const capDrop = strings(h.CapDrop).map((c) => c.toUpperCase());
  if (!capDrop.includes("ALL") || strings(h.CapAdd).length > 0 || (h.CapAdd !== null && h.CapAdd !== undefined && !Array.isArray(h.CapAdd))) {
    out.push(["proc_status", "host_capabilities"]);
  }
  const sec = strings(h.SecurityOpt);
  if (!sec.some((o) => o === "no-new-privileges" || o === "no-new-privileges=true" || o === "no-new-privileges:true")) out.push(["proc_status", "host_no_new_privileges"]);
  if (sec.some((o) => o === "seccomp=unconfined" || o === "seccomp:unconfined")) out.push(["seccomp_enforced", "host_seccomp_unconfined"]);
  if (sec.some((o) => o === "apparmor=unconfined" || o === "apparmor:unconfined")) out.push(["runtime_identity", "host_apparmor_unconfined"]);
  // masked and read-only /proc and /sys paths unmasked, or the SELinux label turned off
  if (sec.some((o) => o === "systempaths=unconfined" || o === "systempaths:unconfined")) out.push(["runtime_identity", "host_systempaths_unconfined"]);
  if (sec.some((o) => o === "label=disable" || o === "label:disable")) out.push(["runtime_identity", "host_label_disabled"]);
  if (h.ReadonlyRootfs !== true) out.push(["root_read_only", "host_root_writable"]);
  if (h.NetworkMode !== "none") out.push(["network_interfaces", "host_network"]);
  if (h.IpcMode !== "none") out.push(["runtime_identity", "host_ipc_shared"]);
  if (typeof h.PidMode === "string" ? h.PidMode !== "" : h.PidMode !== undefined && h.PidMode !== null) out.push(["runtime_identity", "host_pid_shared"]);
  if (h.UsernsMode === "host") out.push(["runtime_identity", "host_userns"]);
  if (h.UTSMode === "host") out.push(["runtime_identity", "host_uts_shared"]);
  // the backend asks for `--cgroupns private`: anything else (the host's, or not reported) is refused
  if (h.CgroupnsMode !== "private") out.push(["runtime_identity", "host_cgroupns"]);
  const nonEmpty = (v: unknown) => (Array.isArray(v) && v.length > 0) || (v !== null && v !== undefined && !Array.isArray(v));
  if (nonEmpty(h.Devices)) out.push(["runtime_identity", "host_devices"]);
  if (nonEmpty(h.DeviceRequests)) out.push(["runtime_identity", "host_device_requests"]);
  if (nonEmpty(h.DeviceCgroupRules)) out.push(["runtime_identity", "host_device_cgroup_rules"]);
  if (strings(h.Binds).length > 0 || (h.Binds !== null && h.Binds !== undefined && !Array.isArray(h.Binds))) out.push(["no_executor_credentials", "host_bind_mount"]);
  const mounts = Array.isArray(h.Mounts) ? (h.Mounts as unknown[]) : h.Mounts === null || h.Mounts === undefined ? [] : null;
  if (mounts === null || mounts.some((m) => (m as { Type?: unknown } | null)?.Type !== "volume" || (m as { ReadOnly?: unknown }).ReadOnly !== true)) {
    out.push(["no_executor_credentials", "host_mount_not_read_only_volume"]);
  }
  return out;
}

/**
 * The probes of a runc hardened container: the runtime is ALWAYS `runc` (the one class this backend can attest, never more), and
 * every probe the container's HostConfig contradicts is `not run` with its `host_*` code (a failure the init cannot
 * undo). A contradiction on a probe the report does not carry is put on `runtime_identity`, which every report carries
 * (amendment U), so nothing is silently dropped.
 */
export function runcProbesFrom(init: InitObservation, side: ExecutorSideObservation, opts: { runtimeName: string }, wanted: readonly AttestationProbe[]): ProbeSet {
  const out = probesFromObservation(init, side, { runtime: "runc", flags: [] }, wanted) as Record<string, unknown>;
  for (const [probe, code] of runcHostConfigFailures(side.hostConfig ?? {}, side.containerRuntime, opts.runtimeName)) {
    const target = wanted.includes(probe) ? probe : "runtime_identity";
    // the first contradiction per probe is kept (each one alone fails the report)
    const cur = out[target] as { observed: unknown } | undefined;
    if (cur && cur.observed === null) continue;
    out[target] = notRun(code);
  }
  return out as ProbeSet;
}

export class RuncDockerBackend extends DockerSandboxBackend {
  protected readonly label = "runc";
  protected readonly attestedClass = "hardened_container" as const;

  constructor(private readonly opts: RuncBackendOptions) {
    super(opts);
  }

  describe(): BackendDescription {
    // L1 only: a runc host shares the host kernel, so it never attests L2 or L3 (decision 1)
    return { backend: "runc", runtimeVersion: this.opts.runtimeVersion, classes: ["hardened_container"] };
  }

  /** before any container starts: the daemon has the runtime, seccomp that is not unconfined, and user-namespace remapping */
  protected async checkRuntime(): Promise<RuntimeCheck> {
    const info = await this.api("/info");
    const problem = runcDaemonProblem(info, this.opts.runtimeName);
    if (problem) throw new DockerBackendError(`${problem}; nothing was started (ADR-0190 L1)`);
    const rt = runtimeFromInfo(info, this.opts.runtimeName);
    return { path: rt.path, args: rt.args, verified: true };
  }

  protected async containerRuntimeVerified(containerRuntime: string | null, rt: RuntimeCheck): Promise<boolean> {
    return rt.verified && containerRuntime === this.opts.runtimeName;
  }

  /** L1 asks for a private cgroup namespace explicitly (the host's is refused from outside) */
  protected override runOptions(): { cgroupnsPrivate: boolean } {
    return { cgroupnsPrivate: true };
  }

  protected probesFor(init: InitObservation, side: ExecutorSideObservation, _profile: ExecutionProfileBody, wanted: readonly AttestationProbe[]): ProbeSet {
    return runcProbesFrom(init, side, { runtimeName: this.opts.runtimeName }, wanted);
  }
}
