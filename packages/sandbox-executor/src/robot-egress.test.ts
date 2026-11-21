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
 * A real Docker run: robot-egress.integration.test.ts (runc; gVisor's netstack there is NOT VERIFIED, M-041).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SHIPPED_EXECUTION_PROFILES, smokescreenAclForTargets, type ExecutionOffer, type ExecutionProfileBody } from "@regulait/shared";
import {
  BRIDGE_INHIBIT_IPV4,
  DockerBackendError,
  capEgressBytes,
  dockerRunArgs,
  egressLogMarker,
  egressNetworkCreateArgs,
  egressNetworkProblem,
  egressPortsFile,
  egressProxyAddress,
  executorTag,
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

  it("the run's network is internal, IPv4 only, and gives the host no address on it (code review 2)", () => {
    expect(egressNetworkCreateArgs(NET)).toEqual([
      "network",
      "create",
      "--internal",
      "--driver",
      "bridge",
      "--ipv6=false",
      "--opt",
      "com.docker.network.bridge.inhibit_ipv4=true",
      "--label",
      "org.regulait.sandbox=1",
      NET,
    ]);
    expect(() => egressNetworkCreateArgs("bridge")).toThrow();
  });

  it("the network as the daemon made it is checked before the proxy starts", () => {
    const good = { Internal: true, EnableIPv6: false, Options: { [BRIDGE_INHIBIT_IPV4]: "true" }, IPAM: { Config: [{ Subnet: "172.30.5.0/24" }] } };
    expect(egressNetworkProblem(good)).toBeNull();
    expect(egressNetworkProblem({ ...good, Internal: false })).toMatch(/not internal/);
    expect(egressNetworkProblem({ ...good, EnableIPv6: true })).toMatch(/IPv6/);
    expect(egressNetworkProblem({ ...good, EnableIPv6: undefined })).toMatch(/IPv6/);
    expect(egressNetworkProblem({ ...good, Options: {} })).toMatch(/inhibit_ipv4/);
    expect(egressNetworkProblem({ ...good, Options: null })).toMatch(/inhibit_ipv4/);
    expect(egressNetworkProblem({ ...good, IPAM: { Config: [{ Subnet: "172.30.5.0/24", Gateway: "172.30.5.1" }] } })).toMatch(/gateway/);
    expect(egressNetworkProblem({ ...good, IPAM: { Config: [{ Subnet: "172.30.5.0/24" }, { Subnet: "fd00:1::/64" }] } })).toMatch(/IPv6 subnet/);
    expect(egressNetworkProblem(null)).not.toBeNull();
  });

  it("the ports file names exactly the offer's host:port targets (Security B3)", () => {
    expect(egressPortsFile(TARGETS)).toBe("files.example.com:8443\nportal.example.com:443\n");
    expect(egressPortsFile([...TARGETS, TARGETS[0]!])).toBe("files.example.com:8443\nportal.example.com:443\n");
    expect(() => egressPortsFile([])).toThrow(DockerBackendError);
    for (const bad of [{ host: "10.0.0.1", port: 443 }, { host: "Portal.example.com", port: 443 }, { host: "portal.example.com", port: 0 }, { host: "a.example.com\nb.example.com", port: 443 }]) {
      expect(() => egressPortsFile([bad]), JSON.stringify(bad)).toThrow(DockerBackendError);
    }
  });

  it("the proxy gets the ACL read-only, the per-run flags, an empty proxy environment, and never root", () => {
    const args = proxyRunArgs({ name: PROXY, image: EGRESS_IMAGE, network: NET, ip: "172.30.5.2", aclVolume: "regulait-acl", aclSubpath: SANDBOX, user: "65532:65532" });
    // item 17: an explicit runtime and Docker's default seccomp profile, named
    expect(valueAfter(args, "--runtime")).toBe("runc");
    expect(valuesAfter(args, "--security-opt")).toEqual(["no-new-privileges=true", "seccomp=builtin"]);
    // not --rm: the log is read before the proxy is removed
    expect(args).not.toContain("--rm");
    expect(valueAfter(proxyRunArgs({ name: PROXY, image: EGRESS_IMAGE, network: NET, ip: "172.30.5.2", aclVolume: "regulait-acl", aclSubpath: SANDBOX, user: "1:1", runtime: "runsc-proxy" }), "--runtime")).toBe("runsc-proxy");
    expect(() => proxyRunArgs({ name: PROXY, image: EGRESS_IMAGE, network: NET, ip: "172.30.5.2", aclVolume: "regulait-acl", aclSubpath: SANDBOX, user: "1:1", runtime: "--privileged" })).toThrow(/runtime/);
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

  it("Security N-D: the executor tag labels the sandbox, the proxy and the network, and scopes the ACL sub-path", () => {
    const tag = executorTag("executor-a");
    // stable for one identity, different for another, never the identity itself; random (and valid) without one
    expect(tag).toMatch(/^[0-9a-f]{32}$/);
    expect(executorTag("executor-a")).toBe(tag);
    expect(executorTag("executor-b")).not.toBe(tag);
    expect(executorTag(null)).toMatch(/^[0-9a-f]{32}$/);
    expect(executorTag(null)).not.toBe(executorTag(null));
    expect(egressNetworkCreateArgs(NET, tag).slice(-3)).toEqual(["--label", `org.regulait.executor=${tag}`, NET]);
    const base = { name: SANDBOX, runtimeName: "runc", image: IMAGE, profile: ROBOT, canary: false, initVolume: "regulait-init", network: NET };
    expect(valuesAfter(dockerRunArgs({ ...base, executor: tag }), "--label")).toEqual(["org.regulait.sandbox=1", `org.regulait.executor=${tag}`]);
    const proxy = { name: PROXY, image: EGRESS_IMAGE, network: NET, ip: "172.30.5.2", aclVolume: "regulait-acl", aclSubpath: `${tag}/${SANDBOX}`, user: "65532:65532", executor: tag };
    const args = proxyRunArgs(proxy);
    expect(valuesAfter(args, "--label")).toEqual(["org.regulait.sandbox=1", "org.regulait.egress-proxy=1", `org.regulait.executor=${tag}`]);
    expect(valueAfter(args, "--mount")).toBe(`type=volume,src=regulait-acl,dst=/etc/regulait-egress,readonly,volume-subpath=${tag}/${SANDBOX}`);
    // a tag is 32 hex characters; a sub-path is `<tag>/<sandbox>` (or a bare sandbox name), nothing else
    for (const bad of ["x", "", "A".repeat(32), `${tag},readonly=false`]) {
      expect(() => egressNetworkCreateArgs(NET, bad), bad).toThrow(DockerBackendError);
      expect(() => proxyRunArgs({ ...proxy, executor: bad }), bad).toThrow(DockerBackendError);
    }
    for (const bad of [`../${SANDBOX}`, `${tag}/../${SANDBOX}`, `${tag}/${tag}/${SANDBOX}`, `${tag}/`, `x/${SANDBOX}`]) {
      expect(() => proxyRunArgs({ ...proxy, aclSubpath: bad }), bad).toThrow(/ACL sub-path/);
    }
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
  /** what the ports file held, and its mode, when the proxy was started */
  portsAtStart: { text: string; mode: number } | null;
}

/** the image ENV the robot runner image sets (engines/robot-runner/Dockerfile), plus values the init must NOT pass on */
const IMAGE_ENV = {
  PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
  ROBOT_CHROMIUM: "/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell",
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
  LEAK_ME: "image-only",
  NODE_ENV: "production",
};

interface SeamOptions {
  proxyFails?: boolean;
  sandboxSilent?: boolean;
  /** the sandbox init's own environment (the image's ENV); default the test process's plus IMAGE_ENV */
  initEnv?: NodeJS.ProcessEnv;
  /** `docker ps` / `docker network ls` output for the reconciler */
  ps?: string;
  networks?: string;
  /** a script whose stdout is `docker logs` */
  logsScript?: string;
  /** a docker verb that never exits (the timeout) */
  hang?: string;
  /**
   * Security N-D: the daemon's labelled objects (all carry org.regulait.sandbox=1); `ps` / `network ls` list those
   * matching every `--filter label=org.regulait.executor=<tag>` given, as the daemon does
   */
  daemon?: { containers: Array<{ name: string; executor?: string }>; networks: Array<{ name: string; executor?: string }> };
}

/** the docker seam: the real init for the sandbox's `docker run`, no-ops (or the configured failures) for the rest */
function seam(rig: Rig, opts: SeamOptions = {}) {
  let sandbox: ChildProcess | null = null;
  return (args: string[]): DockerChild => {
    rig.calls.push(args);
    const noop = (code = 0, out = "") => spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(out)}); process.exit(${code})`], { stdio: ["pipe", "pipe", "pipe"] }) as DockerChild;
    if (opts.hang && (args[0] === opts.hang || `${args[0]} ${args[1]}` === opts.hang)) return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["pipe", "pipe", "pipe"] }) as DockerChild;
    if (args[0] === "run" && args[1] === "-d") {
      const mount = valueAfter(args, "--mount")!;
      const sub = /volume-subpath=([^,]+)$/.exec(mount)![1]!;
      const file = path.join(rig.aclDir, sub, "acl.yaml");
      rig.aclAtStart = { text: readFileSync(file, "utf8"), mode: statSync(file).mode & 0o777 };
      const ports = path.join(rig.aclDir, sub, "ports.txt");
      rig.portsAtStart = { text: readFileSync(ports, "utf8"), mode: statSync(ports).mode & 0o777 };
      return noop(opts.proxyFails ? 1 : 0, "proxy-id\n");
    }
    if (args[0] === "run") {
      const env = opts.initEnv ?? { ...process.env, ...IMAGE_ENV };
      sandbox = opts.sandboxSilent
        ? spawn(process.execPath, ["-e", "process.exit(1)"], { stdio: ["pipe", "pipe", "pipe"] })
        : spawn(process.execPath, [INIT, ...(args.at(-1) === "--canary" ? ["--canary"] : [])], { stdio: ["pipe", "pipe", "pipe"], env });
      return sandbox as DockerChild;
    }
    if (args[0] === "kill") sandbox?.kill("SIGKILL");
    if (args[0] === "logs") {
      if (opts.logsScript) return spawn(process.execPath, ["-e", opts.logsScript], { stdio: ["pipe", "pipe", "pipe"] }) as DockerChild;
      return noop(0, '{"allow":true,"requested_hostport":"portal.example.com:443","msg":"CANONICAL-PROXY-DECISION"}\n');
    }
    const listed = (objs: Array<{ name: string; executor?: string }>) => {
      const want = valuesAfter(args, "--filter").flatMap((f) => (f.startsWith("label=org.regulait.executor=") ? [f.slice("label=org.regulait.executor=".length)] : []));
      return objs.filter((o) => want.every((w) => o.executor === w)).map((o) => `${o.name}\n`).join("");
    };
    if (args[0] === "ps") return noop(0, opts.daemon ? listed(opts.daemon.containers) : (opts.ps ?? ""));
    if (args[0] === "network" && args[1] === "ls") return noop(0, opts.daemon ? listed(opts.daemon.networks) : (opts.networks ?? ""));
    return noop();
  };
}
const GOOD_NET = { Internal: true, EnableIPv6: false, Options: { "com.docker.network.bridge.inhibit_ipv4": "true" }, IPAM: { Config: [{ Subnet: "172.30.5.0/24" }] } };
let netAnswer: unknown = GOOD_NET;
const api = (rig: Rig) => async (p: string) => {
  if (p === "/info") return RUNC_INFO;
  if (p.startsWith("/networks/")) return netAnswer;
  if (p.startsWith("/containers/regulait-egp-")) return { State: { Running: true } };
  const run = rig.calls.find((c) => c[0] === "run" && c[1] !== "-d");
  if (p.endsWith("/json")) return { Image: IMAGE, HostConfig: { Runtime: "runc", NetworkMode: run ? valueAfter(run, "--network") : "none" }, State: { OOMKilled: false } };
  return { cpu_stats: { throttling_data: { throttled_periods: 0 } } };
};
function runc(rig: Rig, opts: SeamOptions & { egressImage?: string | null; dockerTimeoutMs?: number; executorId?: string } = {}) {
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
    reconcileIntervalMs: 0,
    executorId: opts.executorId ?? "executor-under-test",
    ...(opts.dockerTimeoutMs !== undefined ? { dockerTimeoutMs: opts.dockerTimeoutMs } : {}),
    spawnDocker: seam(rig, opts),
    dockerApi: api(rig),
  });
}
const newRig = (): Rig => ({ calls: [], aclDir: mkdtempSync(path.join(tmpdir(), "regulait-acl-")), aclAtStart: null, portsAtStart: null });
/** a run's docker calls in order, without the first preflight's reconciler listings (`ps`, `network ls`) */
const verbs = (calls: string[][]) =>
  calls
    .filter((c) => c[0] !== "ps" && !(c[0] === "network" && c[1] === "ls"))
    .map((c) => (c[0] === "network" ? `network ${c[1]}` : c[0] === "run" && c[1] === "-d" ? "run proxy" : c[0] === "run" ? "run sandbox" : c[0]!));
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
    const run = rig.calls.filter((c) => c[0] !== "ps" && !(c[0] === "network" && c[1] === "ls"));
    expect(run[0]).toEqual(egressNetworkCreateArgs(net, b.executorTag));
    // Security N-D: the sandbox, the proxy and the network carry this executor's tag; the ACL is under its directory
    expect(b.executorTag).toBe(executorTag("executor-under-test"));
    expect(valuesAfter(sandboxRun, "--label")).toContain(`org.regulait.executor=${b.executorTag}`);
    expect(valuesAfter(run[1]!, "--label")).toContain(`org.regulait.executor=${b.executorTag}`);
    expect(valueAfter(run[1]!, "--mount")).toMatch(new RegExp(`volume-subpath=${b.executorTag}/regulait-sbx-[0-9a-f-]{36}$`));
    // the proxy alone joins the uplink
    expect(run[2]).toEqual(["network", "connect", "regulait-uplink", proxy]);
    expect(valuesAfter(sandboxRun, "--network")).toEqual([net]);
    // the ACL: generated from the offer's targets in the one place, written 0600
    expect(rig.aclAtStart).toEqual({ text: smokescreenAclForTargets(TARGETS), mode: 0o600 });
    // Security B3: the ports file beside it, the same mode, from the same targets
    expect(rig.portsAtStart).toEqual({ text: "files.example.com:8443\nportal.example.com:443\n", mode: 0o600 });
    const proxyRun = run[1]!;
    expect(proxyRun.slice(-6)).toEqual(["--egress-acl-file", "/etc/regulait-egress/acl.yaml", "--listen-ip", "172.30.5.2", "--listen-port", "4750"]);
    expect(valueAfter(proxyRun, "--user")).not.toMatch(/^0:/);
    // the workload (a host node here) sees exactly the proxy and the run id the init put in its environment, and (N7)
    // the browser location from the image's ENV by the init's allow-list; nothing else of the image's ENV
    await h.releaseInput({ command: process.execPath, args: ["-e", "console.log(JSON.stringify({p: process.env.REGULAIT_ROBOT_EGRESS_PROXY, r: process.env.REGULAIT_ROBOT_RUN_ID, e: process.env, n: Object.keys(process.env).sort()}))"] });
    const seen: string[] = [];
    for await (const l of h.stdio!.lines()) seen.push(l);
    const env = JSON.parse(seen.at(-1)!) as { p: string; r: string; e: Record<string, string>; n: string[] };
    expect(env.p).toBe("http://172.30.5.2:4750");
    expect(env.r).toBe(RUN_ID);
    expect(env.e.PLAYWRIGHT_BROWSERS_PATH).toBe(IMAGE_ENV.PLAYWRIGHT_BROWSERS_PATH);
    expect(env.e.ROBOT_CHROMIUM).toBe(IMAGE_ENV.ROBOT_CHROMIUM);
    expect(env.e.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD).toBe("1");
    expect(env.e.LEAK_ME).toBeUndefined();
    expect(env.e.NODE_ENV).toBeUndefined();
    expect(env.n.filter((k) => !["PATH", "HOME", "REGULAIT_ROBOT_EGRESS_PROXY", "REGULAIT_ROBOT_RUN_ID", "PLAYWRIGHT_BROWSERS_PATH", "ROBOT_CHROMIUM", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"].includes(k) && k !== "PWD" && k !== "SHLVL" && k !== "_")).toEqual([]);
    expect(await h.ended).toBe("completed");
    removedAll(rig.calls, sandboxRun[sandboxRun.indexOf("--name") + 1]!, net, proxy);
    // the log was read before the proxy was removed, and is the handle's evidence
    const logAt = rig.calls.findIndex((c) => c[0] === "logs");
    const rmProxyAt = rig.calls.findIndex((c) => c[0] === "rm" && c.includes(proxy));
    expect(logAt).toBeGreaterThan(-1);
    expect(logAt).toBeLessThan(rmProxyAt);
    expect(await h.egressLog!()).toContain("CANONICAL-PROXY-DECISION");
    expect(existsSync(path.join(rig.aclDir, b.executorTag, sandboxRun[sandboxRun.indexOf("--name") + 1]!))).toBe(false);
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
    const net = rig.calls.find((c) => c[0] === "network" && c[1] === "create")!.at(-1)!;
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
    const net = rig.calls.find((c) => c[0] === "network" && c[1] === "create")!.at(-1)!;
    expect(rig.calls.some((c) => c[0] === "network" && c[1] === "rm" && c[2] === net)).toBe(true);
  }, 30_000);

  it("Security N-C: the canary self-test re-checks its network too; a bad one fails closed (no sandbox, network removed)", async () => {
    for (const bad of [{ ...GOOD_NET, Options: {} }, { ...GOOD_NET, Internal: false }, { ...GOOD_NET, EnableIPv6: true }, { ...GOOD_NET, IPAM: { Config: [{ Subnet: "172.30.5.0/24", Gateway: "172.30.5.1" }] } }, null]) {
      netAnswer = bad;
      const rig = newRig();
      try {
        await expect(runc(rig).startCanary(ROBOT_L1, "hardened_container"), JSON.stringify(bad)).rejects.toThrow(DockerBackendError);
      } finally {
        netAnswer = GOOD_NET;
      }
      expect(verbs(rig.calls)).toEqual(["network create", "network rm"]);
      expect(rig.calls.some((c) => c[0] === "run")).toBe(false);
    }
  });
});

describe("the network check, the reconciler and the docker timeout (code review 2, 7)", () => {
  it("a network the daemon made with a host address or IPv6 is refused: no proxy, no sandbox, the network removed", async () => {
    for (const bad of [{ ...GOOD_NET, Options: {} }, { ...GOOD_NET, EnableIPv6: true }, { ...GOOD_NET, IPAM: { Config: [{ Subnet: "172.30.5.0/24", Gateway: "172.30.5.1" }] } }]) {
      netAnswer = bad;
      const rig = newRig();
      try {
        await expect(runc(rig).start(offer, ROBOT_L1, "hardened_container")).rejects.toThrow(DockerBackendError);
      } finally {
        netAnswer = GOOD_NET;
      }
      expect(verbs(rig.calls)).toEqual(["network create", "network rm"]);
    }
  });

  it("removes this executor's labelled sandboxes, proxies, run networks and ACL directories no live sandbox owns; nothing else", async () => {
    const rig = newRig();
    const orphan = "regulait-sbx-99999999-2222-4333-8444-555555555555";
    const orphanProxy = "regulait-egp-88888888-2222-4333-8444-555555555555";
    const orphanNet = "regulait-egn-77777777-2222-4333-8444-555555555555";
    // Security N-D: another executor's (labelled with its tag) and a pre-N-D one (no executor label)
    const other = executorTag("another-executor");
    const theirs = "regulait-sbx-66666666-2222-4333-8444-555555555555";
    const theirProxy = "regulait-egp-66666666-2222-4333-8444-555555555555";
    const theirNet = "regulait-egn-66666666-2222-4333-8444-555555555555";
    const legacy = "regulait-sbx-55555555-2222-4333-8444-555555555555";
    const legacyNet = "regulait-egn-55555555-2222-4333-8444-555555555555";
    const mine = executorTag("executor-under-test");
    mkdirSync(path.join(rig.aclDir, mine, orphan), { recursive: true });
    mkdirSync(path.join(rig.aclDir, mine, "keep-me"));
    writeFileSync(path.join(rig.aclDir, mine, "regulait-sbx-not-a-uuid"), "x");
    mkdirSync(path.join(rig.aclDir, other, theirs), { recursive: true });
    mkdirSync(path.join(rig.aclDir, legacy));
    const b = runc(rig, {
      daemon: {
        containers: [
          { name: orphan, executor: mine },
          { name: orphanProxy, executor: mine },
          { name: "postgres", executor: mine },
          { name: "regulait-sbx-not-a-uuid", executor: mine },
          { name: theirs, executor: other },
          { name: theirProxy, executor: other },
          { name: legacy },
        ],
        networks: [{ name: orphanNet, executor: mine }, { name: "bridge", executor: mine }, { name: "regulait-egn-x", executor: mine }, { name: theirNet, executor: other }, { name: legacyNet }],
      },
    });
    expect(b.executorTag).toBe(mine);
    expect(await b.reconcileOrphans()).toEqual({ containers: 2, networks: 1, aclDirs: 1 });
    const rms = rig.calls.filter((c) => c[0] === "rm").map((c) => c.at(-1));
    expect(rms.sort()).toEqual([orphanProxy, orphan].sort());
    expect(rig.calls.filter((c) => c[0] === "network" && c[1] === "rm").map((c) => c[2])).toEqual([orphanNet]);
    expect(existsSync(path.join(rig.aclDir, mine, orphan))).toBe(false);
    expect(existsSync(path.join(rig.aclDir, mine, "keep-me"))).toBe(true);
    expect(existsSync(path.join(rig.aclDir, mine, "regulait-sbx-not-a-uuid"))).toBe(true);
    // another executor's sandbox, proxy, network and ACL survive; so do the unlabelled (pre-N-D) ones
    for (const n of [theirs, theirProxy, legacy]) expect(rms, n).not.toContain(n);
    expect(existsSync(path.join(rig.aclDir, other, theirs))).toBe(true);
    expect(existsSync(path.join(rig.aclDir, legacy))).toBe(true);
    // only objects labelled as ours AND with this executor's tag are listed
    const filters = ["--filter", "label=org.regulait.sandbox=1", "--filter", `label=org.regulait.executor=${mine}`];
    expect(rig.calls.find((c) => c[0] === "ps")).toEqual(["ps", "-a", ...filters, "--format", "{{.Names}}"]);
    expect(rig.calls.find((c) => c[0] === "network" && c[1] === "ls")).toEqual(["network", "ls", ...filters, "--format", "{{.Name}}"]);
  });

  it("Security N-D: another executor's reconciler, on the same daemon and ACL volume, removes only its own orphan", async () => {
    const rig = newRig();
    const a = runc(rig, { executorId: "executor-a" });
    const h = await a.start(offer, ROBOT_L1, "hardened_container");
    const sandboxRun = rig.calls.find((c) => c[0] === "run" && c[1] !== "-d")!;
    const name = sandboxRun[sandboxRun.indexOf("--name") + 1]!;
    const id = name.slice("regulait-sbx-".length);
    const bOrphan = "regulait-sbx-44444444-2222-4333-8444-555555555555";
    const b = runc(rig, {
      executorId: "executor-b",
      daemon: {
        containers: [{ name, executor: a.executorTag }, { name: `regulait-egp-${id}`, executor: a.executorTag }, { name: bOrphan, executor: executorTag("executor-b") }],
        networks: [{ name: `regulait-egn-${id}`, executor: a.executorTag }],
      },
    });
    mkdirSync(path.join(rig.aclDir, b.executorTag, bOrphan), { recursive: true });
    const before = rig.calls.length;
    // executor b never saw a's live run: before N-D it would have removed it
    expect(await b.reconcileOrphans()).toEqual({ containers: 1, networks: 0, aclDirs: 1 });
    const removed = rig.calls.slice(before).filter((c) => c[0] === "rm" || (c[0] === "network" && c[1] === "rm"));
    expect(removed).toEqual([["rm", "-f", bOrphan]]);
    expect(existsSync(path.join(rig.aclDir, a.executorTag, name))).toBe(true);
    expect(existsSync(path.join(rig.aclDir, b.executorTag, bOrphan))).toBe(false);
    await h.kill();
    await h.ended;
  }, 30_000);

  it("runs at the first preflight, and never touches a live run's sandbox, proxy, network or ACL", async () => {
    const rig = newRig();
    const b = runc(rig);
    const h = await b.start(offer, ROBOT_L1, "hardened_container");
    // the first preflight listed (and found nothing)
    expect(rig.calls[0]![0]).toBe("ps");
    const sandboxRun = rig.calls.find((c) => c[0] === "run" && c[1] !== "-d")!;
    const name = sandboxRun[sandboxRun.indexOf("--name") + 1]!;
    const id = name.slice("regulait-sbx-".length);
    // the daemon now lists the live run's sandbox, proxy and network (the seam is swapped to say so)
    const own = b as unknown as { reconcileOrphans(): Promise<{ containers: number; networks: number; aclDirs: number }>; options: { spawnDocker: unknown } };
    const runSeam = own.options.spawnDocker;
    own.options.spawnDocker = seam(rig, { ps: `${name}\nregulait-egp-${id}\n`, networks: `regulait-egn-${id}\n` });
    const before = rig.calls.length;
    expect(await own.reconcileOrphans()).toEqual({ containers: 0, networks: 0, aclDirs: 0 });
    expect(rig.calls.slice(before).filter((c) => c[0] === "rm" || (c[0] === "network" && c[1] === "rm"))).toEqual([]);
    expect(existsSync(path.join(rig.aclDir, b.executorTag, name))).toBe(true);
    own.options.spawnDocker = runSeam;
    await h.kill();
    await h.ended;
  }, 30_000);

  it("a docker call that hangs is killed at its bound (teardown and the reconciler never wait forever)", async () => {
    const rig = newRig();
    const b = runc(rig, { hang: "ps", dockerTimeoutMs: 300 });
    const t0 = Date.now();
    expect(await b.reconcileOrphans()).toEqual({ containers: 0, networks: 0, aclDirs: 0 });
    expect(Date.now() - t0).toBeLessThan(5_000);
    // a run whose network removal hangs still ends
    const rig2 = newRig();
    const h = await runc(rig2, { hang: "network rm", dockerTimeoutMs: 300 }).start(offer, ROBOT_L1, "hardened_container");
    await h.kill();
    expect(await h.ended).toBe("killed");
  }, 30_000);

  it("the egress log keeps its head and its tail (code review 8)", async () => {
    const rig = newRig();
    // 1 MiB of log: a first line, filler, a last line
    const h = await runc(rig, { logsScript: "process.stdout.write('FIRST-LINE\\n' + 'x'.repeat(1024 * 1024) + '\\nLAST-LINE\\n')" }).start(offer, ROBOT_L1, "hardened_container");
    await h.kill();
    await h.ended;
    const log = await h.egressLog!();
    expect(log.startsWith("FIRST-LINE\n")).toBe(true);
    expect(log.endsWith("\nLAST-LINE\n")).toBe(true);
    expect(log).toMatch(/\[regulait: egress log truncated, \d+ bytes dropped\]/);
    expect(Buffer.byteLength(log)).toBeLessThanOrEqual(256 * 1024);
  }, 30_000);
});

describe("the sandbox init's environment for a robot run (N7)", () => {
  /** run the real init on this host: its probe line, then a release line; the workload prints its environment */
  async function workloadEnv(initEnv: NodeJS.ProcessEnv, robot: boolean): Promise<Record<string, string>> {
    const child = spawn(process.execPath, [INIT], { stdio: ["pipe", "pipe", "pipe"], env: initEnv, cwd: mkdtempSync(path.join(tmpdir(), "regulait-init-")) });
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
      if (out.split("\n").length === 2) {
        const release = { "regulait-release": 1, argv: [process.execPath, "-e", "console.log(JSON.stringify(process.env))"], ...(robot ? { egressProxy: "http://172.30.5.2:4750", robotRunId: RUN_ID } : {}) };
        child.stdin.write(`${JSON.stringify(release)}\n`);
      }
    });
    await new Promise((r) => child.once("exit", r));
    return JSON.parse(out.trim().split("\n").at(-1)!) as Record<string, string>;
  }

  it("passes the allow-listed browser variables to a robot run only, as plain absolute paths", async () => {
    const robot = await workloadEnv({ ...process.env, ...IMAGE_ENV }, true);
    expect(robot).toMatchObject({ PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright", ROBOT_CHROMIUM: IMAGE_ENV.ROBOT_CHROMIUM, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" });
    expect(robot.LEAK_ME).toBeUndefined();
    // a stdio server or engine task gets none of them
    const other = await workloadEnv({ ...process.env, ...IMAGE_ENV }, false);
    for (const k of ["PLAYWRIGHT_BROWSERS_PATH", "ROBOT_CHROMIUM", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", "LEAK_ME"]) expect(other[k], k).toBeUndefined();
    // a value that is not a plain absolute path is not passed
    const bad = await workloadEnv({ ...process.env, PLAYWRIGHT_BROWSERS_PATH: "relative/path", ROBOT_CHROMIUM: "/ms-playwright/../etc/x", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "0" }, true);
    for (const k of ["PLAYWRIGHT_BROWSERS_PATH", "ROBOT_CHROMIUM", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"]) expect(bad[k], k).toBeUndefined();
    const semi = await workloadEnv({ ...process.env, ROBOT_CHROMIUM: "/a;b", PLAYWRIGHT_BROWSERS_PATH: "/a b" }, true);
    expect(semi.ROBOT_CHROMIUM).toBeUndefined();
    expect(semi.PLAYWRIGHT_BROWSERS_PATH).toBeUndefined();
  }, 60_000);
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

describe("capEgressLog (code review 8: head AND tail; CodeQL alert 81: linear trims, no regex on log text)", () => {
  it("keeps a short log, caps a long one to its head and tail with the dropped byte count, never splitting a character", async () => {
    const { capEgressLog } = await import("./docker-backend.js");
    expect(capEgressLog("ok", 64)).toBe("ok");
    const text = "HEAD" + "é".repeat(500) + "TAIL";
    for (const max of [120, 121, 122, 123, 200]) {
      const capped = capEgressLog(text, max);
      expect(capped.startsWith("HEAD"), String(max)).toBe(true);
      expect(capped.endsWith("TAIL"), String(max)).toBe(true);
      expect(capped).not.toContain("�");
      expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(max);
      const m = /truncated, (\d+) bytes dropped/.exec(capped)!;
      const kept = Buffer.byteLength(capped, "utf8") - Buffer.byteLength(egressLogMarker(Number(m[1])));
      expect(kept + Number(m[1])).toBe(Buffer.byteLength(text, "utf8"));
    }
    // 4-byte characters at both cuts
    const emoji = capEgressLog("😀".repeat(1000), 301);
    expect(emoji).not.toContain("�");
    expect(Buffer.byteLength(emoji, "utf8")).toBeLessThanOrEqual(301);
  });

  it("capEgressBytes: separate head and tail buffers (the capture keeps only those) give the same result", () => {
    const full = Buffer.from("a".repeat(1000) + "MIDDLE" + "z".repeat(1000), "utf8");
    const max = 300;
    const viaFull = capEgressBytes(full, full, full.length, max);
    const viaParts = capEgressBytes(full.subarray(0, max), full.subarray(full.length - max), full.length, max);
    expect(viaParts).toBe(viaFull);
    expect(viaFull).not.toContain("MIDDLE");
    expect(viaFull.startsWith("a")).toBe(true);
    expect(viaFull.endsWith("z")).toBe(true);
    expect(capEgressBytes(Buffer.from("short"), Buffer.from("short"), 5, max)).toBe("short");
  });
  it("stays fast on a log of many replacement characters", async () => {
    const { capEgressLog } = await import("./docker-backend.js");
    const t0 = Date.now();
    const out = capEgressLog("�".repeat(200_000) + "x", 300_000);
    expect(Date.now() - t0).toBeLessThan(1000);
    // genuine U+FFFD characters are text and kept; only a sequence split by a cut is dropped
    expect(out.startsWith("�")).toBe(true);
    expect(out.endsWith("x")).toBe(true);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(300_000);
    // and on one of many continuation bytes (an invalid log is still trimmed in bounded steps)
    const t1 = Date.now();
    capEgressBytes(Buffer.alloc(2_000_000, 0x80), Buffer.alloc(2_000_000, 0x80), 2_000_000, 300_000);
    expect(Date.now() - t1).toBeLessThan(1000);
  });
});

describe("dockerReason (why the proxy did not start, bounded)", () => {
  it("keeps the first non-empty line, printable ASCII only, at most 300 characters", async () => {
    const { dockerReason } = await import("./docker-backend.js");
    expect(dockerReason("\n  docker: Error response from daemon: invalid mount config\nmore\n")).toBe("docker: Error response from daemon: invalid mount config");
    expect(dockerReason("")).toBe("no output");
    expect(dockerReason("a\u0007béc")).toBe("a?b?c");
    expect(dockerReason("x".repeat(1000)).length).toBe(300);
  });
});
