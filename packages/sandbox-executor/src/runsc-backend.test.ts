/**
 * ADR-0190 slice I4 — THE runsc BACKEND, without a Docker daemon:
 *  - THE SANDBOX AS ARGUMENTS: every isolation property of the `restricted`
 *    profile is on the `docker run` line (runtime, no network, read-only root,
 *    noexec work tmpfs, uid, no capabilities, no-new-privileges, CPU, memory
 *    without swap, host pids.max and RLIMIT_NPROC, no pull, the image by
 *    digest, the sandbox init as entry point); nothing comes from the workload.
 *  - WHAT PROVES IT IS runsc: the executor's OUTSIDE evidence (the container's
 *    runtime by docker inspect, the daemon's binary for it hashed against the
 *    pinned gVisor release, the profile's flags) plus the inside probes passes
 *    the gateway's evaluator; then ONE property at a time is made untrue (an
 *    unpinned binary, a runtime that is not runsc, a missing `--oci-seccomp`, no
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
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
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
  readLines,
  STDIO_SANDBOX_BLANKED_ENV,
  runtimeFromInfo,
  unsupportedProfileFeature,
  type DockerChild,
  type ExecutorSideObservation,
  type InitObservation,
} from "./docker-backend.js";
import { probesFrom, RunscBackendError, RunscDockerBackend } from "./runsc-backend.js";
import { buildReport } from "./report.js";
import { RUNSC_RELEASES, SANDBOX_INIT_SHA256 } from "./init-pin.js";

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
  const args = dockerRunArgs({ name: "regulait-sbx-t", runtimeName: "runsc", image: IMAGE, profile: restricted, canary: false, initVolume: "regulait-init" });

  it("names the runsc runtime, no network, no pull, no log driver, no IPC sharing, and the image by digest", () => {
    expect(args[0]).toBe("run");
    expect(args).toContain("-i");
    expect(valueAfter(args, "--runtime")).toBe("runsc");
    expect(valueAfter(args, "--network")).toBe("none");
    expect(valueAfter(args, "--pull")).toBe("never");
    expect(valueAfter(args, "--log-driver")).toBe("none");
    expect(valueAfter(args, "--ipc")).toBe("none");
    // review H2: the executor's init, from its own volume, read-only, is the entry point; the image follows
    expect(valueAfter(args, "--entrypoint")).toBe("/usr/local/bin/node");
    expect(valueAfter(args, "--mount")).toBe("type=volume,src=regulait-init,dst=/.regulait-init,readonly");
    expect(args.slice(-2)).toEqual([IMAGE, "/.regulait-init/sandbox-init.mjs"]);
    // nothing of the workload's: no command, no env value, no mounts of a host path. The only --env flags BLANK the
    // Node variables that load code (recheck N4): an image's ENV cannot make the interpreter run anything first.
    expect(args).not.toContain("-e");
    const envs = valuesAfter(args, "--env");
    expect(envs).toEqual(STDIO_SANDBOX_BLANKED_ENV.map((n) => `${n}=`));
    expect(envs).toEqual(expect.arrayContaining(["NODE_OPTIONS=", "NODE_PATH="]));
    expect(args.indexOf("--env")).toBeLessThan(args.indexOf("--entrypoint"));
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
    const canary = dockerRunArgs({ name: "c", runtimeName: "runsc", image: IMAGE, profile: restricted, canary: true, initVolume: "regulait-init" });
    expect(canary.at(-1)).toBe("--canary");
    const relaxed: ExecutionProfileBody = { ...restricted, process: { ...restricted.process, exec: "image_and_work_dir" } };
    expect(valueAfter(dockerRunArgs({ name: "c", runtimeName: "runsc", image: IMAGE, profile: relaxed, canary: false, initVolume: "regulait-init" }), "--tmpfs")).not.toMatch(/noexec/);
    expect(() => dockerRunArgs({ name: "c", runtimeName: "runsc", image: "node:22", profile: restricted, canary: false, initVolume: "regulait-init" })).toThrow(RunscBackendError);
    expect(() => dockerRunArgs({ name: "c", runtimeName: "runsc; rm", image: IMAGE, profile: restricted, canary: false, initVolume: "regulait-init" })).toThrow(RunscBackendError);
    expect(() => dockerRunArgs({ name: "c", runtimeName: "runsc", image: IMAGE, profile: restricted, canary: false, initVolume: "/host/path" })).toThrow(/volume name/);
  });

  it("a Localhost seccomp profile needs the executor's seccomp directory", () => {
    const local: ExecutionProfileBody = { ...restricted, process: { ...restricted.process, seccomp: { type: "Localhost", profile: "tight" } } };
    expect(() => dockerRunArgs({ name: "c", runtimeName: "runsc", image: IMAGE, profile: local, canary: false, initVolume: "regulait-init" })).toThrow(/seccomp directory/);
    const a = dockerRunArgs({ name: "c", runtimeName: "runsc", image: IMAGE, profile: local, canary: false, seccompDir: "/etc/regulait/seccomp", initVolume: "regulait-init" });
    expect(valuesAfter(a, "--security-opt")).toContain("seccomp=/etc/regulait/seccomp/tight.json");
  });

  it("refuses, before any sandbox, the profile features it does not provide (I5 adds the jobs input and task-scoped secrets)", () => {
    expect(unsupportedProfileFeature(restricted)).toBeNull();
    // I5: the engine-worker profile's one `jobs` input needs this executor's input volume
    expect(unsupportedProfileFeature(SHIPPED_EXECUTION_PROFILES["engine-worker"])).toMatch(/no input volume/);
    expect(unsupportedProfileFeature(SHIPPED_EXECUTION_PROFILES["engine-worker"], { inputVolume: true })).toBeNull();
    const other = SHIPPED_EXECUTION_PROFILES["engine-worker"];
    expect(unsupportedProfileFeature({ ...other, filesystem: { ...other.filesystem, inputs: [{ name: "models", mountPath: "/models" }] } }, { inputVolume: true })).toMatch(/other than the one jobs input/);
    expect(unsupportedProfileFeature({ ...restricted, secrets: "task_scoped" })).toBeNull();
    expect(unsupportedProfileFeature({ ...restricted, secrets: "injected_at_egress" })).toBe("secrets: injected_at_egress");
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
  runtimeBinaryVerified: true,
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
    ["the daemon's runtime binary is not the pinned gVisor release", (_i, s) => Object.assign(s, { runtimeBinaryVerified: false }), "backend_mismatch"],
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

  it("review H2: the kernel strings inside never decide the runtime (a gVisor sandbox that does not name itself still passes)", () => {
    const quiet = gvisorInit();
    Object.assign(quiet.runtime!, { kernelRelease: "4.4.0", procVersionGvisor: false, dmesgGvisor: false });
    expect(verdict(quiet, runscSide())).toEqual({ verdict: "pass", failures: [] });
    expect(probesFrom(quiet, runscSide(), { runtimeName: "runsc" }, ["runtime_identity"]).runtime_identity).toMatchObject({ observed: { runtime: "gvisor" } });
  });

  it("review H2, FORGED OBSERVATION: an init that prints gVisor everywhere, in a container the daemon ran under runc, is refused", () => {
    // the sandbox controls its own output (it runs the image's interpreter): it claims every gVisor marker
    const forged = gvisorInit();
    const side: ExecutorSideObservation = { ...runscSide(), containerRuntime: "runc", runtimeBinaryVerified: false, runtimePath: "/usr/bin/runc" };
    const v = verdict(forged, side);
    expect(v.verdict).toBe("fail");
    expect(v.failures.map((f) => f.code)).toContain("backend_mismatch");
    const probes = probesFrom(forged, side, { runtimeName: "runsc" }, ["runtime_identity", "runtime_config"]);
    expect(probes.runtime_identity).toMatchObject({ observed: { runtime: "runc" } });
    expect(probes.runtime_config).toMatchObject({ observed: { backend: "runc", flags: [] } });
    // and the same forged line under the right runtime NAME but an unverified binary is refused the same way
    const unpinned = verdict(forged, { ...runscSide(), runtimeBinaryVerified: false });
    expect(unpinned.failures.map((f) => f.code)).toContain("backend_mismatch");
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
const RUNSC_HOST = "/usr/local/lib/gvisor/runsc";
const PINNED = RUNSC_RELEASES["release-20261005.0"]!;
const dockerApi = async (p: string) => {
  if (p === "/info") return { Runtimes: { runsc: { path: RUNSC_HOST, runtimeArgs: runscFlags(restricted) } } };
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

/** the executor-side options: the shipped init, a fresh init directory, and a stand-in runsc file hashed by a seam */
function hostOptions(over: Partial<ConstructorParameters<typeof RunscDockerBackend>[0]> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "regulait-init-"));
  const fakeRunsc = path.join(dir, "runsc");
  writeFileSync(fakeRunsc, "stand-in");
  return {
    runtimeName: "runsc",
    canaryImage: IMAGE,
    runtimeVersion: "release-20261005.0",
    initSource: INIT,
    initDir: path.join(dir, "volume"),
    initVolume: "regulait-init",
    runscBinary: fakeRunsc,
    runscHostPath: RUNSC_HOST,
    sha512File: async () => PINNED,
    dockerApi,
    ...over,
  };
}

describe("review H2: the init and the runtime binary are pinned, checked from outside", () => {
  it("the init this package ships is the pinned init (a change to the init is a reviewed change to the pin)", () => {
    expect(createHash("sha256").update(readFileSync(INIT)).digest("hex")).toBe(SANDBOX_INIT_SHA256);
  });

  it("refuses to exist without a pinned canary image or an unpinned gVisor release", () => {
    expect(() => new RunscDockerBackend(hostOptions({ canaryImage: "regulait/stdio-base:latest" }))).toThrow(RunscBackendError);
    expect(() => new RunscDockerBackend(hostOptions({ runtimeVersion: "release-19990101.0" }))).toThrow(/not a pinned release/);
  });

  it("preflight: a missing runtime, a runtime at another path, or a binary that is not the pinned release is refused", async () => {
    await expect(new RunscDockerBackend(hostOptions({ dockerApi: async () => ({ Runtimes: {} }) })).preflight()).rejects.toThrow(/no runtime named runsc/);
    await expect(new RunscDockerBackend(hostOptions({ dockerApi: async () => ({ Runtimes: { runsc: { path: "/usr/bin/runc" } } }) })).preflight()).rejects.toThrow(/not the gVisor install/);
    // a basename of `runsc` is not enough: the binary's own hash decides
    await expect(new RunscDockerBackend(hostOptions({ sha512File: async () => "0".repeat(128) })).preflight()).rejects.toThrow(/sha512 is not the pinned one/);
    await expect(new RunscDockerBackend(hostOptions({ runscBinary: "/nonexistent/runsc" })).preflight()).rejects.toThrow(/sha512 is not the pinned one/);
    const ok = await new RunscDockerBackend(hostOptions()).preflight();
    expect(ok).toEqual({ path: RUNSC_HOST, args: runscFlags(restricted), verified: true });
  });

  it("recheck N1: a runsc binary replaced IN PLACE after it was verified refuses the next placement (rename-over and overwrite)", async () => {
    for (const how of ["rename-over", "overwrite"] as const) {
      const dir = mkdtempSync(path.join(tmpdir(), "regulait-runsc-"));
      const binary = path.join(dir, "runsc");
      writeFileSync(binary, "stand-in");
      const stamp = new Date("2026-10-01T00:00:00Z");
      utimesSync(binary, stamp, stamp);
      let hashed = 0;
      // the seam hashes the REAL file: the stand-in bytes are "the pinned release", anything else is not
      const sha512File = async (f: string) => {
        hashed += 1;
        return readFileSync(f, "utf8") === "stand-in" ? PINNED : createHash("sha512").update(readFileSync(f)).digest("hex");
      };
      const calls: string[][] = [];
      const b = new RunscDockerBackend(hostOptions({ runscBinary: binary, sha512File, spawnDocker: hostInit(calls) }));
      await b.preflight();
      // NEGATIVE CONTROL: an unchanged file is not re-hashed for a placement (the cache is keyed on its identity)
      await b.preflight();
      expect(hashed).toBe(1);
      // the upgrade in place: same size, same mtime, so only the inode (rename-over) or the ctime (overwrite) moves
      if (how === "rename-over") {
        const next = path.join(dir, "runsc.new");
        writeFileSync(next, "tampered");
        utimesSync(next, stamp, stamp);
        renameSync(next, binary);
      } else {
        await new Promise((r) => setTimeout(r, 20));
        writeFileSync(binary, "tampered");
        utimesSync(binary, stamp, stamp);
      }
      await expect(b.start(offer, restricted, "user_space_kernel"), how).rejects.toThrow(/sha512 is not the pinned one/);
      expect(calls, `${how}: no docker run`).toEqual([]);
    }
  });

  it("a tampered init (the shipped file or the copy in the volume) is refused or replaced before any sandbox", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "regulait-tamper-"));
    const tampered = path.join(dir, "sandbox-init.mjs");
    writeFileSync(tampered, readFileSync(INIT, "utf8") + "\n// tampered\n");
    const calls: string[][] = [];
    const b = new RunscDockerBackend(hostOptions({ initSource: tampered, spawnDocker: hostInit(calls) }));
    await expect(b.startCanary(restricted, "user_space_kernel")).rejects.toThrow(/not the pinned init/);
    expect(calls, "no docker run with a tampered init").toEqual([]);
    // a copy in the volume that was changed is rewritten from the pinned file
    const opts = hostOptions();
    const good = new RunscDockerBackend(opts);
    await good.verifyInit();
    const copy = path.join(opts.initDir, "sandbox-init.mjs");
    const { chmodSync } = await import("node:fs");
    chmodSync(copy, 0o644);
    writeFileSync(copy, "console.log('forged')\n");
    await good.verifyInit();
    expect(createHash("sha256").update(readFileSync(copy)).digest("hex")).toBe(SANDBOX_INIT_SHA256);
  });

  it("FORGED OBSERVATION end to end: the container's runtime (docker inspect) is runc, so the sandbox is reported runc whatever the init prints", async () => {
    const calls: string[][] = [];
    const runcInspect = async (p: string) => (p.endsWith("/json") ? { Image: IMAGE, HostConfig: { Runtime: "runc", NanoCpus: 1e9, Memory: 1024 ** 3, PidsLimit: 512 }, State: { OOMKilled: false } } : dockerApi(p));
    const b = new RunscDockerBackend(hostOptions({ spawnDocker: hostInit(calls), dockerApi: runcInspect }));
    const h = await b.startCanary(restricted, "user_space_kernel");
    const probes = await h.probe(["runtime_identity", "runtime_config"]);
    expect(probes.runtime_identity).toMatchObject({ observed: { runtime: "runc" } });
    expect(probes.runtime_config).toMatchObject({ observed: { backend: "runc", flags: [] } });
    await h.releaseInput();
    await h.ended;
  }, 30_000);
});

describe("the handshake with the real sandbox init (run on this host in place of docker run)", () => {
  const backend = (calls: string[][]) => new RunscDockerBackend(hostOptions({ spawnDocker: hostInit(calls) }));

  it("attests user_space_kernel only, and refuses a sandbox at any other class before starting one", async () => {
    const calls: string[][] = [];
    const b = backend(calls);
    expect(b.describe()).toEqual({ backend: "gvisor", runtimeVersion: "release-20261005.0", classes: ["user_space_kernel"] });
    await expect(b.startCanary(restricted, "hardened_container")).rejects.toThrow(/user_space_kernel only/);
    await expect(b.start({ ...offer, workloadKind: "code_exec" }, restricted, "user_space_kernel")).rejects.toThrow(/mcp_stdio and engine_worker/);
    // I5: an engine task needs its input; a profile that declares none cannot run one
    await expect(b.start({ ...offer, workloadKind: "engine_worker" }, restricted, "user_space_kernel")).rejects.toThrow(/declares no input/);
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
    // the host is not a sandbox: what it observed is reported as is, and the gateway's evaluator refuses it. (The
    // runtime itself is decided from outside — this test's Docker seam claims runsc — so it is the inside probes
    // that fail here.)
    const report = buildReport({ kind: "placement", identifier: ID, backend: b.describe(), profileDigest: offer.profileDigest, cls: "user_space_kernel", probes, offerId: offer.id, imageDigest: h.imageDigest });
    const v = evaluateExecutorReport(report, { profile: restricted, profileDigest: offer.profileDigest, backend: "gvisor", classesDeclared: ["user_space_kernel"], requiredClass: "user_space_kernel" });
    expect(v.verdict).toBe("fail");
    // which inside probes fail depends on the host (a CI runner has no effective capabilities, for one); a host process
    // is never the profile's uid 10001, so that one holds on any host, and the report is refused whatever else fails
    expect(v.failures.length).toBeGreaterThan(0);
    expect(v.failures.map((f) => f.code)).toContain("uid_mismatch");
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

describe("review M5: the stdout line splitter", () => {
  const collect = async (chunks: Buffer[], max = 1024) => {
    const out: string[] = [];
    for await (const l of readLines(Readable.from(chunks), max)) out.push(l);
    return out;
  };
  it("a multi-byte character split across chunks is decoded whole; a final line without a newline is kept", async () => {
    const bytes = Buffer.from('{"a":"\u00e9\u20ac\ud83d\ude00"}\n{"b":1}', "utf8");
    // split inside the 4-byte emoji and inside the 3-byte euro sign
    const cuts = [7, 9, 12, 14];
    const chunks: Buffer[] = [];
    let at = 0;
    for (const c of cuts) {
      chunks.push(bytes.subarray(at, c));
      at = c;
    }
    chunks.push(bytes.subarray(at));
    expect(await collect(chunks)).toEqual(['{"a":"\u00e9\u20ac\ud83d\ude00"}', '{"b":1}']);
  });
  it("an invalid UTF-8 sequence is an error, never replaced; a line above the limit is an error", async () => {
    await expect(collect([Buffer.from([0x7b, 0xff, 0x7d, 0x0a])])).rejects.toThrow(RunscBackendError);
    await expect(collect([Buffer.alloc(600, 0x61), Buffer.alloc(600, 0x61)], 1024)).rejects.toThrow(/frame limit/);
  });
  it("a long line delivered one byte at a time is linear, not quadratic", async () => {
    const n = 200_000;
    const chunks = Array.from({ length: n }, () => Buffer.from("a"));
    chunks.push(Buffer.from("\n"));
    const t = Date.now();
    const out = await collect(chunks, n + 1);
    expect(out[0]!.length).toBe(n);
    expect(Date.now() - t).toBeLessThan(5_000);
  });
});
