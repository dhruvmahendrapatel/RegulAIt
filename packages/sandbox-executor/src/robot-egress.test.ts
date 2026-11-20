/**
 * ADR-0364 S3 — A ROBOT RUN'S PER-RUN EGRESS in the Docker backends, without a Docker daemon (the docker CLI and the
 * Engine API are seams; the sandbox is the real sandbox init run on this host, as runc-backend.test.ts does):
 *  - the sandbox joins ONLY its run's internal network (never host, bridge or none-with-egress), the network is
 *    created `--internal`, and the proxy alone is connected to the uplink;
 *  - the proxy (Smokescreen) is started with the run's ACL (generated from the offer's targets, written 0600) mounted
 *    read-only, the per-run flags, an empty proxy environment, never as root, and listens only on its internal address;
 *  - the workload gets REGULAIT_ROBOT_EGRESS_PROXY and REGULAIT_ROBOT_RUN_ID from the init, nothing else new;
 *  - no egress image (or ACL volume, or runtime) → the profile is unsupported and a placement is refused before any
 *    docker command (fail closed);
 *  - cleanup: the sandbox, the proxy (its log read first) and the network are removed, and the ACL deleted, on
 *    success, on a failed start and on a kill; the egress log is the handle's evidence;
 *  - an egress on any other kind, or a robot offer without one, is refused.
 * A real Docker run (Smokescreen in its image, gVisor's netstack on an internal network) is NOT VERIFIED here (M-041).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SHIPPED_EXECUTION_PROFILES, smokescreenAclForTargets, type ExecutionOffer, type ExecutionProfileBody } from "@regulait/shared";
import {
  DockerBackendError,
  dockerRunArgs,
  egressNetworkCreateArgs,
  egressProxyAddress,
  isPinnedImageRef,
  proxyRunArgs,
  smokescreenArgs,
  unsupportedProfileFeature,
  type DockerChild,
} from "./docker-backend.js";
import { RuncDockerBackend } from "./runc-backend.js";
import { RunscDockerBackend } from "./runsc-backend.js";
import { FakeSandboxBackend } from "./fake-backend.js";

const ROBOT = SHIPPED_EXECUTION_PROFILES["robot-browser"];
/** an admin's L1 version of robot-browser (the runc backend attests L1 only) */
const ROBOT_L1: ExecutionProfileBody = { ...structuredClone(ROBOT), minClass: "hardened_container" };
const IMAGE = `sha256:${"c".repeat(64)}`;
const EGRESS_IMAGE = `sha256:${"e".repeat(64)}`;
const INIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../sandbox-init/sandbox-init.mjs");
const RUNC_INFO = { Runtimes: { runc: { path: "runc" } }, SecurityOptions: ["name=seccomp,profile=builtin", "name=userns"] };
const RUN_ID = "0b6f3c1e-2d4a-4e8b-9f10-a1b2c3d4e5f6";
const TARGETS = [{ host: "portal.example.com", port: 443 }, { host: "files.example.com", port: 8443 }];
const SANDBOX = "regulait-sbx-11111111-2222-4333-8444-555555555555";
const NET = "regulait-egn-11111111-2222-4333-8444-555555555555";
const PROXY = "regulait-egp-11111111-2222-4333-8444-555555555555";

const valueAfter = (args: string[], flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const valuesAfter = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]!] : []));

const offer: ExecutionOffer = {
  id: "5b0c1a3e-6a1e-4a4b-9a2c-0f4e5d6c7b8a",
  workloadKind: "robot_browser",
  requiredClass: "hardened_container",
  requiredBy: "configured_profile",
  enforcement: "enforce",
  profileDigest: "a".repeat(64),
  imageDigest: IMAGE,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  egress: { runId: RUN_ID, targets: TARGETS },
};

describe("the pure builders", () => {
  it("the sandbox joins only its run's internal network, never host, bridge or another container's", () => {
    const base = { name: SANDBOX, runtimeName: "runc", image: IMAGE, profile: ROBOT, canary: false, initVolume: "regulait-init" };
    const args = dockerRunArgs({ ...base, network: NET });
    expect(valuesAfter(args, "--network")).toEqual([NET]);
    expect(args).not.toContain("host");
    for (const bad of ["host", "bridge", "container:other", "default", "regulait-egn-x"]) {
      expect(() => dockerRunArgs({ ...base, network: bad }), bad).toThrow(DockerBackendError);
    }
    // an egress_proxy sandbox always has its network; no other profile ever joins one
    expect(() => dockerRunArgs({ ...base, network: null })).toThrow(/internal network/);
    expect(() => dockerRunArgs({ ...base, profile: SHIPPED_EXECUTION_PROFILES.restricted, network: NET })).toThrow(DockerBackendError);
    expect(valueAfter(dockerRunArgs({ ...base, profile: SHIPPED_EXECUTION_PROFILES.restricted }), "--network")).toBe("none");
    // no environment value is passed in (the proxy URL and run id ride the release line)
    expect(valuesAfter(args, "--env").every((e) => e.endsWith("="))).toBe(true);
  });

  it("the run's network is internal", () => {
    expect(egressNetworkCreateArgs(NET)).toEqual(["network", "create", "--internal", "--driver", "bridge", "--label", "org.regulait.sandbox=1", NET]);
    expect(() => egressNetworkCreateArgs("bridge")).toThrow();
  });

  it("the proxy gets the ACL read-only, the per-run flags, an empty proxy environment, and never root", () => {
    const args = proxyRunArgs({ name: PROXY, image: EGRESS_IMAGE, network: NET, ip: "172.30.5.2", aclVolume: "regulait-acl", aclSubpath: SANDBOX, user: "65532:65532" });
    expect(valueAfter(args, "--network")).toBe(NET);
    expect(valueAfter(args, "--ip")).toBe("172.30.5.2");
    expect(valueAfter(args, "--pull")).toBe("never");
    expect(args).toContain("--read-only");
    expect(valueAfter(args, "--cap-drop")).toBe("ALL");
    expect(valueAfter(args, "--mount")).toBe(`type=volume,src=regulait-acl,dst=/etc/regulait-egress,readonly,volume-subpath=${SANDBOX}`);
    for (const v of ["HTTP_PROXY=", "HTTPS_PROXY=", "NO_PROXY=", "ALL_PROXY=", "http_proxy=", "https_proxy="]) expect(valuesAfter(args, "--env")).toContain(v);
    const after = args.slice(args.indexOf(EGRESS_IMAGE) + 1);
    expect(after).toEqual(smokescreenArgs("172.30.5.2"));
    expect(after).toEqual(["--egress-acl-file", "/etc/regulait-egress/acl.yaml", "--listen-ip", "172.30.5.2", "--listen-port", "4750"]);
    expect(() => proxyRunArgs({ name: PROXY, image: EGRESS_IMAGE, network: NET, ip: "172.30.5.2", aclVolume: "regulait-acl", aclSubpath: SANDBOX, user: "0:0" })).toThrow(/root/);
    expect(() => proxyRunArgs({ name: PROXY, image: "smokescreen:latest", network: NET, ip: "172.30.5.2", aclVolume: "regulait-acl", aclSubpath: SANDBOX, user: "1:1" })).toThrow(/pinned/);
  });

  it("the proxy's address is the internal subnet's second host; images are pinned by digest only", () => {
    expect(egressProxyAddress("172.30.5.0/24")).toBe("172.30.5.2");
    expect(egressProxyAddress("10.10.0.0/16")).toBe("10.10.0.2");
    expect(() => egressProxyAddress("fd00::/64")).toThrow();
    expect(() => egressProxyAddress(undefined)).toThrow();
    expect(isPinnedImageRef(EGRESS_IMAGE)).toBe(true);
    expect(isPinnedImageRef(`ghcr.io/x/robot-egress@sha256:${"e".repeat(64)}`)).toBe(true);
    expect(isPinnedImageRef("ghcr.io/x/robot-egress:1.0")).toBe(false);
  });

  it("an egress_proxy profile is unsupported unless this executor can build the egress", () => {
    expect(unsupportedProfileFeature(ROBOT)).toMatch(/per-run egress proxy/);
    expect(unsupportedProfileFeature(ROBOT, { egressProxy: "REGULAIT_ROBOT_EGRESS_IMAGE is not set" })).toMatch(/REGULAIT_ROBOT_EGRESS_IMAGE/);
    expect(unsupportedProfileFeature(ROBOT, { egressProxy: null })).toBeNull();
    expect(unsupportedProfileFeature(SHIPPED_EXECUTION_PROFILES.restricted)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

interface Rig {
  calls: string[][];
  aclDir: string;
  /** what the ACL file held, and its mode, when the proxy was started */
  aclAtStart: { text: string; mode: number } | null;
}

/** the docker seam: the real init for the sandbox's `docker run`, no-ops (or the configured failures) for the rest */
function seam(rig: Rig, opts: { proxyFails?: boolean; sandboxSilent?: boolean } = {}) {
  let sandbox: ChildProcess | null = null;
  return (args: string[]): DockerChild => {
    rig.calls.push(args);
    const noop = (code = 0, out = "") => spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(out)}); process.exit(${code})`], { stdio: ["pipe", "pipe", "pipe"] }) as DockerChild;
    if (args[0] === "run" && args[1] === "-d") {
      const mount = valueAfter(args, "--mount")!;
      const sub = /volume-subpath=([^,]+)$/.exec(mount)![1]!;
      const file = path.join(rig.aclDir, sub, "acl.yaml");
      rig.aclAtStart = { text: readFileSync(file, "utf8"), mode: statSync(file).mode & 0o777 };
      return noop(opts.proxyFails ? 1 : 0, "proxy-id\n");
    }
    if (args[0] === "run") {
      sandbox = opts.sandboxSilent
        ? spawn(process.execPath, ["-e", "process.exit(1)"], { stdio: ["pipe", "pipe", "pipe"] })
        : spawn(process.execPath, [INIT, ...(args.at(-1) === "--canary" ? ["--canary"] : [])], { stdio: ["pipe", "pipe", "pipe"] });
      return sandbox as DockerChild;
    }
    if (args[0] === "kill") sandbox?.kill("SIGKILL");
    if (args[0] === "logs") return noop(0, '{"allow":true,"requested_hostport":"portal.example.com:443","msg":"CANONICAL-PROXY-DECISION"}\n');
    return noop();
  };
}
const api = (rig: Rig) => async (p: string) => {
  if (p === "/info") return RUNC_INFO;
  if (p.startsWith("/networks/")) return { Internal: true, IPAM: { Config: [{ Subnet: "172.30.5.0/24" }] } };
  if (p.startsWith("/containers/regulait-egp-")) return { State: { Running: true } };
  const run = rig.calls.find((c) => c[0] === "run" && c[1] !== "-d");
  if (p.endsWith("/json")) return { Image: IMAGE, HostConfig: { Runtime: "runc", NetworkMode: run ? valueAfter(run, "--network") : "none" }, State: { OOMKilled: false } };
  return { cpu_stats: { throttling_data: { throttled_periods: 0 } } };
};
function runc(rig: Rig, opts: Parameters<typeof seam>[1] & { egressImage?: string | null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "regulait-robot-"));
  return new RuncDockerBackend({
    runtimeName: "runc",
    canaryImage: IMAGE,
    runtimeVersion: "1.2.6",
    initSource: INIT,
    initDir: path.join(dir, "volume"),
    initVolume: "regulait-init",
    inputDir: null,
    inputVolume: null,
    robotEgressImage: opts.egressImage === undefined ? EGRESS_IMAGE : opts.egressImage,
    egressAclDir: rig.aclDir,
    egressAclVolume: "regulait-acl",
    egressUplinkNetwork: "regulait-uplink",
    egressRuntimeName: null,
    spawnDocker: seam(rig, opts),
    dockerApi: api(rig),
  });
}
const newRig = (): Rig => ({ calls: [], aclDir: mkdtempSync(path.join(tmpdir(), "regulait-acl-")), aclAtStart: null });
const verbs = (calls: string[][]) => calls.map((c) => (c[0] === "network" ? `network ${c[1]}` : c[0] === "run" && c[1] === "-d" ? "run proxy" : c[0] === "run" ? "run sandbox" : c[0]!));
const removedAll = (calls: string[][], name: string, net: string, proxy: string) => {
  expect(calls.some((c) => c[0] === "rm" && c.includes(name)), "sandbox removed").toBe(true);
  expect(calls.some((c) => c[0] === "rm" && c.includes(proxy)), "proxy removed").toBe(true);
  expect(calls.some((c) => c[0] === "network" && c[1] === "rm" && c[2] === net), "network removed").toBe(true);
};

describe("a robot run on the runc backend (the real init in place of docker run)", () => {
  it("builds the egress before the sandbox, gives the workload the proxy and run id, and removes all three on success", async () => {
    const rig = newRig();
    const b = runc(rig);
    expect(b.unsupported(ROBOT_L1)).toBeNull();
    const h = await b.start(offer, ROBOT_L1, "hardened_container");
    const sandboxRun = rig.calls.find((c) => c[0] === "run" && c[1] !== "-d")!;
    const net = valueAfter(sandboxRun, "--network")!;
    const proxy = net.replace("regulait-egn-", "regulait-egp-");
    expect(verbs(rig.calls)).toEqual(["network create", "run proxy", "network connect", "run sandbox"]);
    expect(rig.calls[0]).toEqual(egressNetworkCreateArgs(net));
    // the proxy alone joins the uplink
    expect(rig.calls[2]).toEqual(["network", "connect", "regulait-uplink", proxy]);
    expect(valuesAfter(sandboxRun, "--network")).toEqual([net]);
    // the ACL: generated from the offer's targets in the one place, written 0600
    expect(rig.aclAtStart).toEqual({ text: smokescreenAclForTargets(TARGETS), mode: 0o600 });
    const proxyRun = rig.calls[1]!;
    expect(proxyRun.slice(-6)).toEqual(["--egress-acl-file", "/etc/regulait-egress/acl.yaml", "--listen-ip", "172.30.5.2", "--listen-port", "4750"]);
    expect(valueAfter(proxyRun, "--user")).not.toMatch(/^0:/);
    // the workload (a host node here) sees exactly the proxy and the run id the init put in its environment
    await h.releaseInput({ command: process.execPath, args: ["-e", "console.log(JSON.stringify({p: process.env.REGULAIT_ROBOT_EGRESS_PROXY, r: process.env.REGULAIT_ROBOT_RUN_ID, n: Object.keys(process.env).sort()}))"] });
    const seen: string[] = [];
    for await (const l of h.stdio!.lines()) seen.push(l);
    const env = JSON.parse(seen.at(-1)!) as { p: string; r: string; n: string[] };
    expect(env.p).toBe("http://172.30.5.2:4750");
    expect(env.r).toBe(RUN_ID);
    expect(env.n.filter((k) => !["PATH", "HOME", "REGULAIT_ROBOT_EGRESS_PROXY", "REGULAIT_ROBOT_RUN_ID"].includes(k) && !k.startsWith("NODE") && k !== "PWD" && k !== "SHLVL" && k !== "_")).toEqual([]);
    expect(await h.ended).toBe("completed");
    removedAll(rig.calls, sandboxRun[sandboxRun.indexOf("--name") + 1]!, net, proxy);
    // the log was read before the proxy was removed, and is the handle's evidence
    const logAt = rig.calls.findIndex((c) => c[0] === "logs");
    const rmProxyAt = rig.calls.findIndex((c) => c[0] === "rm" && c.includes(proxy));
    expect(logAt).toBeGreaterThan(-1);
    expect(logAt).toBeLessThan(rmProxyAt);
    expect(await h.egressLog!()).toContain("CANONICAL-PROXY-DECISION");
    expect(existsSync(path.join(rig.aclDir, sandboxRun[sandboxRun.indexOf("--name") + 1]!))).toBe(false);
  }, 30_000);

  it("removes all three when the run is killed", async () => {
    const rig = newRig();
    const h = await runc(rig).start(offer, ROBOT_L1, "hardened_container");
    await h.kill();
    expect(await h.ended).toBe("killed");
    const sandboxRun = rig.calls.find((c) => c[0] === "run" && c[1] !== "-d")!;
    const net = valueAfter(sandboxRun, "--network")!;
    removedAll(rig.calls, sandboxRun[sandboxRun.indexOf("--name") + 1]!, net, net.replace("regulait-egn-", "regulait-egp-"));
  }, 30_000);

  it("removes all three when the sandbox fails to start (its init prints nothing)", async () => {
    const rig = newRig();
    await expect(runc(rig, { sandboxSilent: true }).start(offer, ROBOT_L1, "hardened_container")).rejects.toThrow(DockerBackendError);
    // the exit handler's cleanup runs once the (failed) sandbox process has exited
    await new Promise((r) => setTimeout(r, 300));
    const sandboxRun = rig.calls.find((c) => c[0] === "run" && c[1] !== "-d")!;
    const net = valueAfter(sandboxRun, "--network")!;
    removedAll(rig.calls, sandboxRun[sandboxRun.indexOf("--name") + 1]!, net, net.replace("regulait-egn-", "regulait-egp-"));
  }, 30_000);

  it("a proxy that does not start: no sandbox, and the network, proxy and ACL are removed", async () => {
    const rig = newRig();
    await expect(runc(rig, { proxyFails: true }).start(offer, ROBOT_L1, "hardened_container")).rejects.toThrow(/egress proxy did not start/);
    expect(rig.calls.some((c) => c[0] === "run" && c[1] !== "-d"), "no sandbox started").toBe(false);
    expect(verbs(rig.calls)).toEqual(["network create", "run proxy", "logs", "rm", "network rm"]);
    const net = rig.calls[0]!.at(-1)!;
    expect(rig.calls.at(-1)).toEqual(["network", "rm", net]);
  });

  it("no egress image: the profile is unsupported and a placement is refused before any docker command", async () => {
    const rig = newRig();
    const b = runc(rig, { egressImage: null });
    expect(b.unsupported(ROBOT_L1)).toMatch(/REGULAIT_ROBOT_EGRESS_IMAGE/);
    await expect(b.start(offer, ROBOT_L1, "hardened_container")).rejects.toThrow(/REGULAIT_ROBOT_EGRESS_IMAGE is not set.*nothing was started/);
    await expect(b.startCanary(ROBOT_L1, "hardened_container")).rejects.toThrow(/nothing was started/);
    // a tag is not a pin
    expect(runc(newRig(), { egressImage: "robot-egress:latest" }).unsupported(ROBOT_L1)).toMatch(/not pinned/);
    expect(rig.calls).toEqual([]);
  });

  it("refuses a robot offer without egress, a robot run under another profile, and egress on any other kind", async () => {
    const rig = newRig();
    const b = runc(rig);
    const { egress: _e, ...bare } = offer;
    await expect(b.start(bare as ExecutionOffer, ROBOT_L1, "hardened_container")).rejects.toThrow(/no valid egress/);
    const l1 = { ...structuredClone(SHIPPED_EXECUTION_PROFILES.restricted), name: "team-l1", minClass: "hardened_container" as const };
    await expect(b.start(offer, l1, "hardened_container")).rejects.toThrow(/no per-run egress proxy/);
    await expect(b.start({ ...offer, workloadKind: "mcp_stdio" }, l1, "hardened_container")).rejects.toThrow(/has no egress/);
    expect(rig.calls).toEqual([]);
  });

  it("a canary self-test of the robot profile gets its own internal network (no proxy), removed after", async () => {
    const rig = newRig();
    const h = await runc(rig).startCanary(ROBOT_L1, "hardened_container");
    expect(h.egressLog).toBeUndefined();
    await h.kill();
    await h.ended;
    expect(verbs(rig.calls).slice(0, 2)).toEqual(["network create", "run sandbox"]);
    expect(rig.calls.some((c) => c[0] === "run" && c[1] === "-d")).toBe(false);
    const net = rig.calls[0]!.at(-1)!;
    expect(rig.calls.some((c) => c[0] === "network" && c[1] === "rm" && c[2] === net)).toBe(true);
  }, 30_000);
});

describe("the gVisor backend needs its own robot runtime", () => {
  it("without REGULAIT_EXECUTOR_EGRESS_RUNTIME the robot profile is unsupported", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "regulait-robot-runsc-"));
    const opts = {
      runtimeName: "runsc",
      canaryImage: IMAGE,
      runtimeVersion: "release-20261012.0",
      initSource: INIT,
      initDir: path.join(dir, "volume"),
      initVolume: "regulait-init",
      inputDir: null,
      inputVolume: null,
      runscBinary: "/nonexistent/runsc",
      runscHostPath: "/usr/local/bin/runsc",
      robotEgressImage: EGRESS_IMAGE,
      egressAclDir: dir,
      egressAclVolume: "regulait-acl",
      egressRuntimeName: null,
      dockerApi: async () => ({}),
    };
    expect(new RunscDockerBackend(opts).unsupported(ROBOT)).toMatch(/no runtime for robot sandboxes/);
    expect(new RunscDockerBackend({ ...opts, egressRuntimeName: "runsc-egress" }).unsupported(ROBOT)).toBeNull();
  });
});

describe("the fake backend (for gateway tests without docker)", () => {
  it("records the targets and the ACL it was given, simulates the egress log, and removes the egress at the end", async () => {
    const b = new FakeSandboxBackend({ backend: "gvisor" });
    const h = await b.start(offer, ROBOT, "user_space_kernel");
    const rec = b.sandboxes.at(-1)!;
    expect(rec.egress).toMatchObject({ runId: RUN_ID, targets: TARGETS, acl: smokescreenAclForTargets(TARGETS), removed: false });
    expect(await h.egressLog!()).toContain("portal.example.com:443");
    await h.kill();
    expect(rec.egress!.removed).toBe(true);
    const { egress: _e, ...bare } = offer;
    await expect(b.start(bare as ExecutionOffer, ROBOT, "user_space_kernel")).rejects.toThrow(/no valid egress/);
    await expect(b.start({ ...offer, workloadKind: "mcp_stdio" }, SHIPPED_EXECUTION_PROFILES.restricted, "user_space_kernel")).rejects.toThrow(/has no egress/);
  });
});

describe("capEgressLog (CodeQL alert 81: linear trim of a split trailing sequence)", () => {
  it("keeps a short log, caps a long one with a marker and drops a split multi-byte tail", async () => {
    const { capEgressLog } = await import("./docker-backend.js");
    expect(capEgressLog("ok", 64)).toBe("ok");
    const capped = capEgressLog("é".repeat(100), 51);
    expect(capped.endsWith("[regulait: egress log truncated]\n")).toBe(true);
    expect(capped).not.toContain("�");
    expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(51);
  });
  it("stays fast on a log of many replacement characters", async () => {
    const { capEgressLog } = await import("./docker-backend.js");
    const t0 = Date.now();
    const out = capEgressLog("�".repeat(200_000) + "x", 300_000);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(out).not.toMatch(/�\n\[regulait/);
  });
});
