/**
 * ADR-0190 slice I4 — THE runsc BACKEND, without a Docker daemon:
 *  - THE SANDBOX AS ARGUMENTS: every isolation property of the `restricted`
 *    profile is on the `docker run` line (runtime, no network, read-only root,
 *    noexec work tmpfs, uid, no capabilities, no-new-privileges, CPU, memory
 *    without swap, host pids.max and RLIMIT_NPROC, no pull, the image by
 *    digest, the sandbox init as entry point); nothing comes from the workload.
 *  - WHAT PROVES IT IS runsc: an observation of gVisor from inside, plus the
 *    daemon's runsc runtime with the profile's flags from outside, passes the
 *    gateway's evaluator; then ONE property at a time is made untrue (the host
 *    kernel, a runtime that is not runsc, a missing `--oci-seccomp`, no
 *    seccomp filter, a writable root, a reachable address, an extra interface,
 *    a credential, a memory limit) and the report fails with the named code.
 *  - THE HANDSHAKE, with the real sandbox init (`sandbox-init/sandbox-init.mjs`)
 *    run directly on this host in place of `docker run` (the test seam): the
 *    init's probe line is parsed, nothing reaches the workload before release,
 *    the release carries the registered argv, then the server's stdio is the
 *    sandbox's. Run on the host, the probes report the HOST, and the gateway's
 *    evaluator refuses that report: the backend reports what it sees, never
 *    what it was asked to be.
 * The real runsc run is `runsc-backend.integration.test.ts` (skipped, with its
 * reason, where no Docker daemon with runsc is available).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluateExecutorReport,
  executionProfileDigest,
  requiredReportProbes,
  runscFlags,
  SHIPPED_EXECUTION_PROFILES,
  type ExecutionOffer,
  type ExecutionProfileBody,
  type ReportFailureCode,
} from "@regulait/shared";
import {
  dockerRunArgs,
  probesFrom,
  RunscBackendError,
  RunscDockerBackend,
  runtimeFromInfo,
  unsupportedProfileFeature,
  type DockerChild,
  type ExecutorSideObservation,
  type InitObservation,
} from "./runsc-backend.js";
import { buildReport } from "./report.js";

const restricted = SHIPPED_EXECUTION_PROFILES.restricted;
const IMAGE = `sha256:${"d".repeat(64)}`;
const ID = "spiffe://test.example/regulait/worker_runtime/runsc-1";
const INIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../sandbox-init/sandbox-init.mjs");

const valueAfter = (args: string[], flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const valuesAfter = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]!] : []));

describe("the sandbox as docker run arguments (restricted profile)", () => {
  const args = dockerRunArgs({ name: "regulait-sbx-t", runtimeName: "runsc", image: IMAGE, profile: restricted, canary: false });

  it("names the runsc runtime, no network, no pull, no log driver, no IPC sharing, and the image by digest", () => {
    expect(args[0]).toBe("run");
    expect(args).toContain("-i");
    expect(valueAfter(args, "--runtime")).toBe("runsc");
    expect(valueAfter(args, "--network")).toBe("none");
    expect(valueAfter(args, "--pull")).toBe("never");
    expect(valueAfter(args, "--log-driver")).toBe("none");
    expect(valueAfter(args, "--ipc")).toBe("none");
    expect(valueAfter(args, "--entrypoint")).toBe("/regulait/sandbox-init");
    expect(args.at(-1)).toBe(IMAGE);
    // nothing of the workload's: no command, no env, no mounts of a host path
    expect(args).not.toContain("-e");
    expect(args).not.toContain("--env");
    expect(args).not.toContain("-v");
    expect(args).not.toContain("--volume");
    expect(args).not.toContain("--privileged");
  });

  it("read-only root, one noexec tmpfs work directory owned by the profile's uid, no capabilities, no-new-privileges", () => {
    expect(args).toContain("--read-only");
    expect(valueAfter(args, "--tmpfs")).toBe("/work:rw,nosuid,nodev,size=256m,mode=0700,uid=10001,gid=10001,noexec");
    expect(valueAfter(args, "--workdir")).toBe("/work");
    expect(valueAfter(args, "--user")).toBe("10001:10001");
    expect(valueAfter(args, "--cap-drop")).toBe("ALL");
    expect(valuesAfter(args, "--security-opt")).toEqual(["no-new-privileges=true"]);
  });

  it("CPU, memory with no swap, host pids.max with headroom, and the workload's RLIMIT_NPROC (amendment C)", () => {
    expect(valueAfter(args, "--cpus")).toBe("1");
    expect(valueAfter(args, "--memory")).toBe("1024m");
    expect(valueAfter(args, "--memory-swap")).toBe("1024m");
    expect(valueAfter(args, "--pids-limit")).toBe("512");
    expect(valuesAfter(args, "--ulimit")).toEqual(["nproc=128:128", "nofile=1024:1024"]);
  });

  it("a canary runs the same sandbox with --canary; image_and_work_dir drops noexec; a tag or a bad runtime name is refused", () => {
    const canary = dockerRunArgs({ name: "c", runtimeName: "runsc", image: IMAGE, profile: restricted, canary: true });
    expect(canary.at(-1)).toBe("--canary");
    const relaxed: ExecutionProfileBody = { ...restricted, process: { ...restricted.process, exec: "image_and_work_dir" } };
    expect(valueAfter(dockerRunArgs({ name: "c", runtimeName: "runsc", image: IMAGE, profile: relaxed, canary: false }), "--tmpfs")).not.toMatch(/noexec/);
    expect(() => dockerRunArgs({ name: "c", runtimeName: "runsc", image: "node:22", profile: restricted, canary: false })).toThrow(RunscBackendError);
    expect(() => dockerRunArgs({ name: "c", runtimeName: "runsc; rm", image: IMAGE, profile: restricted, canary: false })).toThrow(RunscBackendError);
  });

  it("a Localhost seccomp profile needs the executor's seccomp directory", () => {
    const local: ExecutionProfileBody = { ...restricted, process: { ...restricted.process, seccomp: { type: "Localhost", profile: "tight" } } };
    expect(() => dockerRunArgs({ name: "c", runtimeName: "runsc", image: IMAGE, profile: local, canary: false })).toThrow(/seccomp directory/);
    const a = dockerRunArgs({ name: "c", runtimeName: "runsc", image: IMAGE, profile: local, canary: false, seccompDir: "/etc/regulait/seccomp" });
    expect(valuesAfter(a, "--security-opt")).toContain("seccomp=/etc/regulait/seccomp/tight.json");
  });

  it("refuses, before any sandbox, the profile features I4 does not provide", () => {
    expect(unsupportedProfileFeature(restricted)).toBeNull();
    expect(unsupportedProfileFeature(SHIPPED_EXECUTION_PROFILES["engine-worker"])).not.toBeNull();
    expect(unsupportedProfileFeature({ ...restricted, secrets: "task_scoped" })).toBe("secrets: task_scoped");
    expect(unsupportedProfileFeature({ ...restricted, persistence: "scoped_volume" })).toBe("a scoped volume");
    expect(unsupportedProfileFeature({ ...restricted, network: { mode: "allow_list", entries: [{ host: "a.example", port: 443 }] } })).toBe("an allow-list network");
  });
});

// ---------------------------------------------------------------------------

/** what a restricted gVisor sandbox observes (the I0 spike's restricted run, `probe-restricted.json`) */
const gvisorInit = (): InitObservation => ({
  runtime: { kernelRelease: "4.19.0-gvisor", procVersionGvisor: true, dmesgGvisor: true, hypervisorFlag: true },
  status: { uid: 10001, capEff: "0000000000000000", noNewPrivs: 1, seccomp: 2 },
  seccomp: { syscall: "unshare", denied: true },
  root: { method: "mount_ro", readOnly: true },
  egressLiteral: { address: "1.1.1.1", connected: false },
  dns: { host: "example.com", resolved: false },
  interfaces: ["lo"],
  credentials: { scanned: ["env", "args", "fs"], found: 0 },
  limits: { memTotalMiB: 1024, rlimitNproc: 128, rlimitNofile: 1024 },
});
const runscSide = (): ExecutorSideObservation => ({
  containerRuntime: "runsc",
  runtimePath: "/usr/local/lib/gvisor/runsc",
  runtimeArgs: runscFlags(restricted),
  imageId: IMAGE,
  nanoCpus: 1_000_000_000,
  cpuQuota: 0,
  cpuPeriod: 0,
  memoryBytes: 1024 * 1024 * 1024,
  pidsLimit: 512,
  throttledPeriods: 3,
});

function verdict(init: InitObservation, side: ExecutorSideObservation, profile: ExecutionProfileBody = restricted) {
  const probes = probesFrom(init, side, { runtimeName: "runsc" }, requiredReportProbes(profile, "gvisor", "user_space_kernel"));
  const report = buildReport({ kind: "self_test", identifier: ID, backend: { backend: "gvisor", runtimeVersion: "release-20261005.0", classes: ["user_space_kernel"] }, profileDigest: executionProfileDigest(profile), cls: "user_space_kernel", probes });
  return evaluateExecutorReport(report, { profile, profileDigest: executionProfileDigest(profile), backend: "gvisor", classesDeclared: ["user_space_kernel"] });
}

describe("what proves the runtime is runsc (decision 6 probe set, amendments A, D and U)", () => {
  it("negative control first: a gVisor sandbox under the daemon's runsc runtime with the profile's flags passes", () => {
    expect(verdict(gvisorInit(), runscSide())).toEqual({ verdict: "pass", failures: [] });
  });

  const lies: Array<[string, (i: InitObservation, s: ExecutorSideObservation) => void, ReportFailureCode]> = [
    ["the host kernel inside (runc, not gVisor)", (i) => Object.assign(i.runtime, { kernelRelease: "6.18.44-host", procVersionGvisor: false, dmesgGvisor: false }), "class_above_observed_runtime"],
    ["the daemon's runtime is runc, not runsc", (_i, s) => Object.assign(s, { runtimePath: "/usr/bin/runc" }), "backend_mismatch"],
    ["the container ran under another runtime name", (_i, s) => Object.assign(s, { containerRuntime: "runc" }), "backend_mismatch"],
    ["runsc without --oci-seccomp (amendment A)", (_i, s) => Object.assign(s, { runtimeArgs: runscFlags(restricted).filter((f) => f !== "--oci-seccomp") }), "runtime_flags_missing"],
    ["runsc with directfs on (amendment B)", (_i, s) => Object.assign(s, { runtimeArgs: runscFlags(restricted).map((f) => (f === "--directfs=false" ? "--directfs=true" : f)) }), "runtime_flags_missing"],
    ["no seccomp filter", (i) => Object.assign(i.status, { seccomp: 0 }), "seccomp_not_filtering"],
    ["a capability left", (i) => Object.assign(i.status, { capEff: "00000000a80425fb" }), "capabilities_present"],
    ["the syscall the filter should deny is allowed", (i) => Object.assign(i.seccomp, { denied: false }), "seccomp_not_enforced"],
    ["a writable root", (i) => Object.assign(i.root, { method: "erofs", readOnly: false }), "root_writable"],
    ["EACCES alone (amendment D)", (i) => Object.assign(i.root, { method: "eacces", readOnly: true }), "root_proof_insufficient"],
    ["a public literal address reached", (i) => Object.assign(i.egressLiteral, { connected: true }), "egress_reached"],
    ["DNS resolves", (i) => Object.assign(i.dns, { resolved: true }), "dns_resolved"],
    ["an extra interface", (i) => Object.assign(i, { interfaces: ["lo", "eth0"] }), "extra_interface"],
    ["a credential reachable", (i) => Object.assign(i.credentials, { found: 1 }), "credentials_reachable"],
    ["a memory limit not applied", (_i, s) => Object.assign(s, { memoryBytes: 4 * 1024 * 1024 * 1024 }), "host_memory_limit_mismatch"],
    ["no RLIMIT_NPROC", (i) => Object.assign(i.limits, { rlimitNproc: 64299 }), "nproc_mismatch"],
  ];
  it.each(lies)("%s fails", (_name, mutate, code) => {
    const i = gvisorInit();
    const s = runscSide();
    mutate(i, s);
    const v = verdict(i, s);
    expect(v.verdict).toBe("fail");
    expect(v.failures.map((f) => f.code)).toContain(code);
  });

  it("an observation that does not fit the vocabulary is not run, never coerced (an inconclusive seccomp probe, an unreadable status)", () => {
    const i = gvisorInit();
    i.seccomp = { syscall: "unshare", inconclusive: "spawn_ENOENT" };
    i.status.capEff = "not-hex";
    const v = verdict(i, runscSide());
    expect(v.failures).toEqual(expect.arrayContaining([{ probe: "seccomp_enforced", code: "probe_not_run" }, { probe: "proc_status", code: "probe_not_run" }]));
  });

  it("reads the runtime from the daemon's /info answer", () => {
    expect(runtimeFromInfo({ Runtimes: { runsc: { path: "/usr/local/bin/runsc", runtimeArgs: ["--oci-seccomp"] } } }, "runsc")).toEqual({ path: "/usr/local/bin/runsc", args: ["--oci-seccomp"] });
    expect(runtimeFromInfo({ Runtimes: { runc: { path: "runc" } } }, "runsc")).toEqual({ path: null, args: [] });
  });
});

// ---------------------------------------------------------------------------

/** the docker seam: run the real sandbox init on this host in place of the container */
function hostInit(calls: string[][]) {
  return (args: string[]): DockerChild => {
    calls.push(args);
    if (args[0] === "run") return spawn(process.execPath, [INIT, ...(args.at(-1) === "--canary" ? ["--canary"] : [])], { stdio: ["pipe", "pipe", "pipe"] }) as DockerChild;
    // kill / rm: nothing to do on the host; a short-lived no-op process
    return spawn(process.execPath, ["-e", ""], { stdio: ["pipe", "pipe", "pipe"] }) as DockerChild;
  };
}
const dockerApi = async (p: string) => {
  if (p === "/info") return { Runtimes: { runsc: { path: "/usr/local/lib/gvisor/runsc", runtimeArgs: runscFlags(restricted) } } };
  if (p.endsWith("/json")) return { Image: IMAGE, HostConfig: { Runtime: "runsc", NanoCpus: 1e9, Memory: 1024 ** 3, PidsLimit: 512 }, State: { OOMKilled: false } };
  return { cpu_stats: { throttling_data: { throttled_periods: 0 } } };
};
const offer: ExecutionOffer = {
  id: "5b0c1a3e-6a1e-4a4b-9a2c-0f4e5d6c7b8a",
  workloadKind: "mcp_stdio",
  requiredClass: "user_space_kernel",
  requiredBy: "workload_kind",
  enforcement: "enforce",
  profileDigest: executionProfileDigest(restricted),
  imageDigest: IMAGE,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

describe("the handshake with the real sandbox init (run on this host in place of docker run)", () => {
  const backend = (calls: string[][]) => new RunscDockerBackend({ runtimeName: "runsc", canaryImage: IMAGE, runtimeVersion: "release-20261005.0", spawnDocker: hostInit(calls), dockerApi });

  it("refuses to exist without a pinned canary image or with a runtime that is not runsc", async () => {
    expect(() => new RunscDockerBackend({ runtimeName: "runsc", canaryImage: "regulait/stdio-base:latest", runtimeVersion: "x", dockerApi })).toThrow(RunscBackendError);
    const notRunsc = new RunscDockerBackend({ runtimeName: "runsc", canaryImage: IMAGE, runtimeVersion: "x", dockerApi: async () => ({ Runtimes: { runsc: { path: "/usr/bin/runc" } } }) });
    await expect(notRunsc.preflight()).rejects.toThrow(/not runsc/);
    const missing = new RunscDockerBackend({ runtimeName: "runsc", canaryImage: IMAGE, runtimeVersion: "x", dockerApi: async () => ({ Runtimes: {} }) });
    await expect(missing.preflight()).rejects.toThrow(/no runtime named runsc/);
  });

  it("attests user_space_kernel only, and refuses a sandbox at any other class before starting one", async () => {
    const calls: string[][] = [];
    const b = backend(calls);
    expect(b.describe()).toEqual({ backend: "gvisor", runtimeVersion: "release-20261005.0", classes: ["user_space_kernel"] });
    await expect(b.startCanary(restricted, "hardened_container")).rejects.toThrow(/user_space_kernel only/);
    await expect(b.start({ ...offer, workloadKind: "engine_worker" }, restricted, "user_space_kernel")).rejects.toThrow(/mcp_stdio/);
    await expect(b.start(offer, SHIPPED_EXECUTION_PROFILES["engine-worker"], "user_space_kernel")).rejects.toThrow(/nothing was started/);
    expect(calls, "no docker run for a refused sandbox").toEqual([]);
  });

  it("probes before release; the release carries the registered argv; then the server's stdio is the sandbox's; on this HOST the report fails", async () => {
    const calls: string[][] = [];
    const b = backend(calls);
    const h = await b.start(offer, restricted, "user_space_kernel");
    expect(calls[0]![0]).toBe("run");
    expect(h.imageDigest).toBe(IMAGE);
    const probes = await h.probe(requiredReportProbes(restricted, "gvisor", "user_space_kernel"));
    // the host is not a sandbox: what it observed is reported as is, and the gateway's evaluator refuses it
    const report = buildReport({ kind: "placement", identifier: ID, backend: b.describe(), profileDigest: offer.profileDigest, cls: "user_space_kernel", probes, offerId: offer.id, imageDigest: h.imageDigest });
    const v = evaluateExecutorReport(report, { profile: restricted, profileDigest: offer.profileDigest, backend: "gvisor", classesDeclared: ["user_space_kernel"], requiredClass: "user_space_kernel" });
    expect(v.verdict).toBe("fail");
    expect(v.failures.map((f) => f.code)).toEqual(expect.arrayContaining(["class_above_observed_runtime", "uid_mismatch"]));
    // the stdio protocol itself: release with argv, then a line through /bin/cat and back
    await expect(h.stdio!.write("early")).rejects.toThrow(/before release/);
    await h.releaseInput({ command: "/bin/cat", args: [] });
    const lines = h.stdio!.lines()[Symbol.asyncIterator]();
    await h.stdio!.write('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    expect((await lines.next()).value).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    await h.stdio!.endInput();
    expect(await h.ended).toBe("completed");
  }, 30_000);

  it("a canary exits on its release with no argv, and is never handed a workload", async () => {
    const calls: string[][] = [];
    const b = backend(calls);
    const h = await b.startCanary(restricted, "user_space_kernel");
    expect(calls[0]!.at(-1)).toBe("--canary");
    expect(h.stdio).toBeUndefined();
    await h.releaseInput();
    expect(await h.ended).toBe("completed");
  }, 30_000);
});
