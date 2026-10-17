/**
 * ADR-0190 I5 follow-up — THE runc BACKEND (L1 `hardened_container`), without a Docker daemon:
 *  - THE SAME HARDENING AS L2 MINUS runsc: the runc hardened container's `docker run` line is the gVisor line with only the
 *    runtime name changed (no network, read-only root, no capabilities, no-new-privileges, seccomp, the profile's
 *    uid, CPU, memory, pids, no IPC, no host path, no environment).
 *  - THE DAEMON POSTURE it refuses to start without: the runtime, seccomp that is not unconfined, user namespaces.
 *  - HONEST CLASS: a runc report passes the gateway's evaluator at L1 ONLY. Claimed at L2 it fails
 *    (`class_not_attestable_by_backend`, `class_above_observed_runtime`); placed against an L2 or L3 requirement it
 *    fails `class_below_required`; an init that prints every gVisor marker is still reported runc.
 *  - THE OUTSIDE VIEW decides: each HostConfig property made untrue one at a time fails the L1 report.
 *  - SELECTION: an executor that declares L1 self-tests no L2/L3 profile (it never holds an L2 attestation), and
 *    the backend refuses a sandbox at any class but L1 before any `docker run`.
 *  - THE HANDSHAKE with the real sandbox init (run on this host in place of `docker run`): on this HOST the report
 *    fails, so the backend reports what it sees, never what it was asked to be.
 * A real runc run needs a Docker daemon: NOT VERIFIED here (M-041), pending in ADR-0190.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluateExecutorReport,
  executionProfileDigest,
  registerExecutorSchema,
  requiredReportProbes,
  SHIPPED_EXECUTION_PROFILES,
  type AppliedIsolationKind,
  type ExecutionOffer,
  type ExecutionProfileBody,
  type ExecutorReport,
  type RequirableIsolationClass,
  type SignedExecutorReport,
} from "@regulait/shared";
import { dockerRunArgs, type ContainerHostConfig, type DockerChild, type ExecutorSideObservation, type InitObservation } from "./docker-backend.js";
import { RuncDockerBackend, runcDaemonProblem, runcHostConfigFailures, runcProbesFrom } from "./runc-backend.js";
import { buildReport } from "./report.js";
import { runSelfTests, topClassFor } from "./self-test.js";
import { FakeSandboxBackend } from "./fake-backend.js";

const restricted = SHIPPED_EXECUTION_PROFILES.restricted;
/** an admin's L1 profile: the shipped `restricted` at `hardened_container` (a relaxation, step-up on the gateway) */
const l1: ExecutionProfileBody = { ...structuredClone(restricted), name: "team-l1", minClass: "hardened_container" };
const L1_DIGEST = executionProfileDigest(l1);
const IMAGE = `sha256:${"c".repeat(64)}`;
const ID = "spiffe://test.example/regulait/worker_runtime/runc-1";
const INIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../sandbox-init/sandbox-init.mjs");
const RUNC_INFO = { Runtimes: { runc: { path: "runc" } }, SecurityOptions: ["name=apparmor", "name=seccomp,profile=builtin", "name=userns", "name=cgroupns"] };

const valueAfter = (args: string[], flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

describe("the runc hardened container is the gVisor sandbox minus runsc", () => {
  it("the docker run line differs from the runsc line ONLY in the runtime name", () => {
    for (const profile of [restricted, l1, SHIPPED_EXECUTION_PROFILES["engine-worker"]]) {
      const input = { volume: "regulait-in", subpath: "regulait-sbx-x/jobs", mountPath: "/jobs" };
      const withInput = profile.filesystem.inputs.length > 0 ? input : null;
      const runsc = dockerRunArgs({ name: "regulait-sbx-x", runtimeName: "runsc", image: IMAGE, profile, canary: false, initVolume: "regulait-init", input: withInput });
      const runc = dockerRunArgs({ name: "regulait-sbx-x", runtimeName: "runc", image: IMAGE, profile, canary: false, initVolume: "regulait-init", input: withInput });
      expect(valueAfter(runc, "--runtime")).toBe("runc");
      expect(runc.map((a) => (a === "runc" ? "runsc" : a))).toEqual(runsc);
      // the hardening, spelled out once more for L1
      for (const f of ["--read-only", "--cap-drop", "--network", "--ipc", "--user", "--pids-limit", "--memory", "--memory-swap", "--cpus"]) expect(runc).toContain(f);
      expect(valueAfter(runc, "--network")).toBe("none");
      expect(valueAfter(runc, "--cap-drop")).toBe("ALL");
      expect(runc).toContain("no-new-privileges=true");
      expect(runc).not.toContain("--privileged");
    }
  });
});

describe("the daemon posture (before any container starts)", () => {
  it("needs the runtime, a seccomp default that is not unconfined, and user-namespace remapping or rootless mode", () => {
    expect(runcDaemonProblem(RUNC_INFO, "runc")).toBeNull();
    expect(runcDaemonProblem({ ...RUNC_INFO, SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless"] }, "runc")).toBeNull();
    expect(runcDaemonProblem({ ...RUNC_INFO, Runtimes: {} }, "runc")).toMatch(/no runtime named runc/);
    expect(runcDaemonProblem({ ...RUNC_INFO, SecurityOptions: ["name=userns"] }, "runc")).toMatch(/no seccomp support/);
    expect(runcDaemonProblem({ ...RUNC_INFO, SecurityOptions: ["name=seccomp,profile=unconfined", "name=userns"] }, "runc")).toMatch(/unconfined/);
    expect(runcDaemonProblem({ ...RUNC_INFO, SecurityOptions: ["name=seccomp,profile=builtin"] }, "runc")).toMatch(/host user namespace/);
    expect(runcDaemonProblem(null, "runc")).toMatch(/no runtime/);
  });
});

// ---------------------------------------------------------------------------

/** what a restricted runc container observes from inside (host kernel; no gVisor markers) */
const runcInit = (): InitObservation => ({
  runtime: { kernelRelease: "6.8.0-generic", procVersionGvisor: false, dmesgGvisor: false, hypervisorFlag: false },
  status: { uid: 10001, capEff: "0000000000000000", noNewPrivs: 1, seccomp: 2 },
  seccomp: { syscall: "unshare", denied: true },
  root: { method: "erofs", readOnly: true },
  egressLiteral: { address: "1.1.1.1", connected: false },
  dns: { host: "example.com", resolved: false },
  interfaces: ["lo"],
  credentials: { scanned: ["env", "args", "fs"], found: 0 },
  limits: { memTotalMiB: 1024, rlimitNproc: 128, rlimitNofile: 1024 },
});
/** what `docker inspect` shows for a container started with `dockerRunArgs` under runc */
const goodHostConfig = (): ContainerHostConfig => ({
  Runtime: "runc",
  NanoCpus: 1e9,
  Memory: 1024 ** 3,
  PidsLimit: 512,
  Privileged: false,
  CapAdd: null,
  CapDrop: ["ALL"],
  ReadonlyRootfs: true,
  SecurityOpt: ["no-new-privileges=true"],
  NetworkMode: "none",
  IpcMode: "none",
  PidMode: "",
  UsernsMode: "",
  Binds: null,
  Mounts: [{ Type: "volume", Source: "regulait-init", Target: "/.regulait-init", ReadOnly: true }],
});
const runcSide = (hostConfig: ContainerHostConfig = goodHostConfig()): ExecutorSideObservation => ({
  containerRuntime: typeof hostConfig.Runtime === "string" ? hostConfig.Runtime : null,
  runtimeBinaryVerified: true,
  runtimePath: "runc",
  runtimeArgs: [],
  imageId: IMAGE,
  nanoCpus: 1_000_000_000,
  cpuQuota: 0,
  cpuPeriod: 0,
  memoryBytes: 1024 * 1024 * 1024,
  pidsLimit: 512,
  throttledPeriods: 0,
  hostConfig,
});
const RUNC_DESC = { backend: "runc" as const, runtimeVersion: "1.2.6", classes: ["hardened_container"] as AppliedIsolationKind[] };

function report(cls: AppliedIsolationKind, init: InitObservation, side: ExecutorSideObservation, kind: "self_test" | "placement" = "self_test", profile = l1): ExecutorReport {
  const probes = runcProbesFrom(init, side, { runtimeName: "runc" }, requiredReportProbes(profile, "runc", cls));
  return buildReport({ kind, identifier: ID, backend: RUNC_DESC, profileDigest: executionProfileDigest(profile), cls, probes, ...(kind === "placement" ? { offerId: "5b0c1a3e-6a1e-4a4b-9a2c-0f4e5d6c7b8a", imageDigest: IMAGE } : {}) });
}
const evaluate = (r: ExecutorReport, opts: { requiredClass?: RequirableIsolationClass; classesDeclared?: AppliedIsolationKind[]; profile?: ExecutionProfileBody } = {}) =>
  evaluateExecutorReport(r, {
    profile: opts.profile ?? l1,
    profileDigest: executionProfileDigest(opts.profile ?? l1),
    backend: "runc",
    classesDeclared: opts.classesDeclared ?? ["hardened_container"],
    ...(opts.requiredClass ? { requiredClass: opts.requiredClass } : {}),
  });
const codes = (v: ReturnType<typeof evaluate>) => v.failures.map((f) => f.code);

describe("honest class: a runc report passes at L1 only", () => {
  it("negative control first: a hardened runc container's self-test passes at hardened_container", () => {
    expect(evaluate(report("hardened_container", runcInit(), runcSide()))).toEqual({ verdict: "pass", failures: [] });
    const probes = runcProbesFrom(runcInit(), runcSide(), { runtimeName: "runc" }, ["runtime_identity", "runtime_config"]);
    expect(probes.runtime_identity).toMatchObject({ observed: { runtime: "runc", guestKernelDistinct: false } });
    expect(probes.runtime_config).toMatchObject({ observed: { backend: "runc", flags: [] } });
  });

  it("the same container claimed at L2 fails, whatever the executor row declares", () => {
    const asL2 = report("user_space_kernel", runcInit(), runcSide());
    // even an executor row that (wrongly) declared L2: runc cannot attest it, and a runc runtime caps the claim at L1
    const v = evaluate(asL2, { classesDeclared: ["hardened_container", "user_space_kernel"] });
    expect(v.verdict).toBe("fail");
    expect(codes(v)).toEqual(expect.arrayContaining(["class_not_attestable_by_backend", "class_above_observed_runtime"]));
    expect(codes(evaluate(report("microvm", runcInit(), runcSide())))).toEqual(expect.arrayContaining(["class_not_declared", "class_not_attestable_by_backend", "class_above_observed_runtime"]));
  });

  it("a placement report at L1 meets an L1 requirement and never an L2 or L3 one (class_below_required)", () => {
    const placed = report("hardened_container", runcInit(), runcSide(), "placement");
    expect(evaluate(placed, { requiredClass: "hardened_container" })).toEqual({ verdict: "pass", failures: [] });
    for (const required of ["user_space_kernel", "microvm"] as const) {
      const v = evaluate(placed, { requiredClass: required });
      expect(v.verdict, required).toBe("fail");
      expect(codes(v), required).toEqual(["class_below_required"]);
    }
  });

  it("FORGED OBSERVATION: an init that prints every gVisor marker is still reported runc, and an L2 claim fails", () => {
    const forged = runcInit();
    Object.assign(forged.runtime, { kernelRelease: "4.4.0", procVersionGvisor: true, dmesgGvisor: true });
    expect(runcProbesFrom(forged, runcSide(), { runtimeName: "runc" }, ["runtime_identity"]).runtime_identity).toMatchObject({ observed: { runtime: "runc" } });
    expect(codes(evaluate(report("user_space_kernel", forged, runcSide()), { classesDeclared: ["hardened_container", "user_space_kernel"] }))).toContain("class_above_observed_runtime");
  });

  it("the gateway's registration refuses a runc executor that declares L2 or L3", () => {
    const base = { workloadIdentityId: "7b0b1c2e-0000-4000-8000-000000000001", name: "runc-a", backend: "runc", runtimeVersion: "1.2.6" };
    expect(registerExecutorSchema.safeParse({ ...base, classesDeclared: ["hardened_container"] }).success).toBe(true);
    expect(registerExecutorSchema.safeParse({ ...base, classesDeclared: ["hardened_container", "user_space_kernel"] }).success).toBe(false);
    expect(registerExecutorSchema.safeParse({ ...base, classesDeclared: ["microvm"] }).success).toBe(false);
  });
});

describe("the outside view decides: each HostConfig property made untrue fails the L1 report", () => {
  const cases: Array<[string, (h: ContainerHostConfig) => void, string, string]> = [
    ["privileged", (h) => (h.Privileged = true), "proc_status", "host_privileged"],
    ["a capability added", (h) => (h.CapAdd = ["NET_ADMIN"]), "proc_status", "host_capabilities"],
    ["capabilities not all dropped", (h) => (h.CapDrop = ["NET_RAW"]), "proc_status", "host_capabilities"],
    ["no no-new-privileges", (h) => (h.SecurityOpt = []), "proc_status", "host_no_new_privileges"],
    ["seccomp unconfined", (h) => (h.SecurityOpt = ["no-new-privileges=true", "seccomp=unconfined"]), "seccomp_enforced", "host_seccomp_unconfined"],
    ["a writable root", (h) => (h.ReadonlyRootfs = false), "root_read_only", "host_root_writable"],
    ["a bridge network", (h) => (h.NetworkMode = "bridge"), "network_interfaces", "host_network"],
    ["shared IPC", (h) => (h.IpcMode = "shareable"), "runtime_identity", "host_ipc_shared"],
    ["the host PID namespace", (h) => (h.PidMode = "host"), "runtime_identity", "host_pid_shared"],
    ["the host user namespace", (h) => (h.UsernsMode = "host"), "runtime_identity", "host_userns"],
    ["a bind mount", (h) => (h.Binds = ["/etc:/host-etc:ro"]), "no_executor_credentials", "host_bind_mount"],
    ["a writable volume", (h) => (h.Mounts = [{ Type: "volume", Source: "v", Target: "/x", ReadOnly: false }]), "no_executor_credentials", "host_mount_not_read_only_volume"],
    ["a bind in Mounts", (h) => (h.Mounts = [{ Type: "bind", Source: "/", Target: "/x", ReadOnly: true }]), "no_executor_credentials", "host_mount_not_read_only_volume"],
    ["another runtime", (h) => (h.Runtime = "crun"), "runtime_identity", "container_runtime_mismatch"],
  ];
  it.each(cases)("%s fails", (_n, mutate, probe, code) => {
    const h = goodHostConfig();
    mutate(h);
    const r = report("hardened_container", runcInit(), runcSide(h));
    expect((r.probes as Record<string, { observed: unknown; error?: string }>)[probe]).toEqual({ observed: null, error: code });
    const v = evaluate(r);
    expect(v.verdict).toBe("fail");
    expect(v.failures).toContainEqual({ probe, code: "probe_not_run" });
  });

  it("a missing HostConfig is a failure, never a pass (fail closed)", () => {
    expect(runcHostConfigFailures({}, null, "runc").length).toBeGreaterThan(5);
    expect(evaluate(report("hardened_container", runcInit(), runcSide({}))).verdict).toBe("fail");
  });
});

describe("selection: an L1 executor never holds an L2 or L3 attestation", () => {
  it("an executor declaring L1 self-tests no shipped profile (all L2+) and only an L1 one", async () => {
    expect(topClassFor(["hardened_container"], "user_space_kernel")).toBeNull();
    expect(topClassFor(["hardened_container"], "microvm")).toBeNull();
    expect(topClassFor(["hardened_container"], "hardened_container")).toBe("hardened_container");
    const ref = (body: ExecutionProfileBody) => ({ digest: executionProfileDigest(body), name: body.name, version: 1, minClass: body.minClass, body });
    const profiles = new Map([...Object.values(SHIPPED_EXECUTION_PROFILES), l1].map((b) => [executionProfileDigest(b), ref(b)]));
    const submitted: Array<{ digest: string; cls: string }> = [];
    const backend = new FakeSandboxBackend({ backend: "runc" });
    await runSelfTests({
      backend,
      credential: { identifier: ID, signReport: async (r: ExecutorReport) => ({ report: r }) as unknown as SignedExecutorReport } as never,
      client: {
        selfTest: async (reports: SignedExecutorReport[]) => {
          for (const r of reports) submitted.push({ digest: r.report.profileDigest, cls: r.report.class });
          return { results: [], next: "ok" };
        },
      } as never,
      profiles,
      classesDeclared: ["hardened_container"],
    });
    expect(submitted).toEqual([{ digest: L1_DIGEST, cls: "hardened_container" }]);
    expect(backend.sandboxes.every((s) => s.cls === "hardened_container")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

/** the docker seam: run the real sandbox init on this host in place of the container */
function hostInit(calls: string[][]) {
  return (args: string[]): DockerChild => {
    calls.push(args);
    if (args[0] === "run") return spawn(process.execPath, [INIT, ...(args.at(-1) === "--canary" ? ["--canary"] : [])], { stdio: ["pipe", "pipe", "pipe"] }) as DockerChild;
    return spawn(process.execPath, ["-e", ""], { stdio: ["pipe", "pipe", "pipe"] }) as DockerChild;
  };
}
const dockerApi =
  (info: unknown = RUNC_INFO) =>
  async (p: string) => {
    if (p === "/info") return info;
    if (p.endsWith("/json")) return { Image: IMAGE, HostConfig: goodHostConfig(), State: { OOMKilled: false } };
    return { cpu_stats: { throttling_data: { throttled_periods: 0 } } };
  };
const offer: ExecutionOffer = {
  id: "5b0c1a3e-6a1e-4a4b-9a2c-0f4e5d6c7b8a",
  workloadKind: "mcp_stdio",
  requiredClass: "hardened_container",
  requiredBy: "configured_profile",
  enforcement: "enforce",
  profileDigest: L1_DIGEST,
  imageDigest: IMAGE,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};
function backend(calls: string[][], info?: unknown) {
  const dir = mkdtempSync(path.join(tmpdir(), "regulait-runc-"));
  return new RuncDockerBackend({
    runtimeName: "runc",
    canaryImage: IMAGE,
    runtimeVersion: "1.2.6",
    initSource: INIT,
    initDir: path.join(dir, "volume"),
    initVolume: "regulait-init",
    inputDir: null,
    inputVolume: null,
    spawnDocker: hostInit(calls),
    dockerApi: dockerApi(info),
  });
}

describe("the runc backend on this host (the real init in place of docker run)", () => {
  it("describes itself as runc at hardened_container only, and refuses any other class before any docker run (L1 is a hardened container, never a sandbox)", async () => {
    const calls: string[][] = [];
    const b = backend(calls);
    expect(b.describe()).toEqual({ backend: "runc", runtimeVersion: "1.2.6", classes: ["hardened_container"] });
    await expect(b.startCanary(restricted, "user_space_kernel")).rejects.toThrow(/runc backend attests hardened_container only/);
    await expect(b.start({ ...offer, requiredClass: "user_space_kernel" }, l1, "user_space_kernel")).rejects.toThrow(/hardened_container only/);
    await expect(b.start(offer, l1, "microvm")).rejects.toThrow(/hardened_container only/);
    await expect(b.start({ ...offer, workloadKind: "code_exec" }, l1, "hardened_container")).rejects.toThrow(/mcp_stdio and engine_worker/);
    expect(calls, "no docker run for a refused container").toEqual([]);
  });

  it("refuses to start anything on a daemon without user namespaces, or with no seccomp", async () => {
    for (const info of [{ ...RUNC_INFO, SecurityOptions: ["name=seccomp,profile=builtin"] }, { ...RUNC_INFO, SecurityOptions: ["name=userns"] }]) {
      const calls: string[][] = [];
      const b = backend(calls, info);
      await expect(b.preflight()).rejects.toThrow(/nothing was started/);
      await expect(b.startCanary(l1, "hardened_container")).rejects.toThrow(/nothing was started/);
      expect(calls).toEqual([]);
    }
  });

  it("starts under --runtime runc, probes before release, and on this HOST the report fails (the backend reports what it sees)", async () => {
    const calls: string[][] = [];
    const b = backend(calls);
    const h = await b.start(offer, l1, "hardened_container");
    expect(valueAfter(calls[0]!, "--runtime")).toBe("runc");
    const probes = await h.probe(requiredReportProbes(l1, "runc", "hardened_container"));
    const r = buildReport({ kind: "placement", identifier: ID, backend: b.describe(), profileDigest: L1_DIGEST, cls: "hardened_container", probes, offerId: offer.id, imageDigest: h.imageDigest });
    const v = evaluateExecutorReport(r, { profile: l1, profileDigest: L1_DIGEST, backend: "runc", classesDeclared: ["hardened_container"], requiredClass: "hardened_container" });
    expect(v.verdict).toBe("fail");
    // a host process is never the profile's uid 10001
    expect(codes(v)).toContain("uid_mismatch");
    expect(probes.runtime_identity).toMatchObject({ observed: { runtime: "runc" } });
    await h.releaseInput({ command: "/bin/cat", args: [] });
    await h.stdio!.endInput();
    expect(await h.ended).toBe("completed");
  }, 30_000);
});
