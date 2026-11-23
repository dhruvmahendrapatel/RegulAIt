/**
 * ADR-0364 S3 (code review 5) — A ROBOT RUN'S EGRESS ON A REAL DOCKER DAEMON: a real sandbox (the executor's own
 * `docker run`, the pinned sandbox init, the robot profile) on its real per-run internal network, with its real
 * per-run Smokescreen (the robot-egress image: smokescreen plus the port filter), started by the runc backend exactly
 * as a placement is. From INSIDE the sandbox the workload then tries every way out, and each must be DENIED:
 *
 *  - through the proxy: a host not in the ACL, an IP literal, 169.254.169.254, the network's gateway address, an
 *    allowed host on a port the run's targets do not name (the front filter, then the port filter: Security B3), a
 *    plain-HTTP proxy request;
 *  - around the proxy: TCP to the run network's first address (where `--internal` alone puts the HOST: code review 2)
 *    and to the uplink's gateway, the allowed target's own address, 169.254.169.254, and UDP to the same addresses and
 *    to a public resolver (nothing arrives at the host's listeners), and DNS for a public name;
 *
 * and an ALLOWED host on its allowed port is reached through the proxy (a local target, below). A negative control
 * shows the gateway probe is real: on a plain `--internal` network (no `inhibit_ipv4`) the same probe reaches the host.
 *
 * Runs only where these are set (otherwise SKIPPED, and its title says why; it never passes vacuously):
 *   REGULAIT_TEST_ROBOT_EGRESS_IMAGE   the robot-egress image (engines/robot-egress), `sha256:<id>`
 *   REGULAIT_TEST_ROBOT_SANDBOX_IMAGE  an image with /usr/local/bin/node (the stdio base, or node:22-trixie-slim), `sha256:<id>`
 *   REGULAIT_TEST_ROBOT_TARGET_IMAGE   a busybox image (its httpd is the allowed target), `sha256:<id>` or a local tag
 * and a Docker daemon (Engine 26 or later) is reachable with the `docker` CLI, as root (the ACL is chowned to the proxy).
 * With REGULAIT_TEST_ROBOT_REQUIRED=1 a missing daemon or image FAILS the file instead (CI: .github/workflows/robot-egress.yml).
 *
 * WHAT IS NOT THE PRODUCT HERE, said plainly:
 *  - the sandbox runs under RUNC (the runc backend, L1), not gVisor: runsc is not installed where this was written.
 *    gVisor's netstack on the same network is NOT verified by this test;
 *  - the daemon's `/info` is wrapped to report `userns` when the daemon lacks it (the runc backend refuses a daemon
 *    without userns-remap; this test is about the network, not the uid mapping);
 *  - the allowed target is a container on a private test subnet, so the test derives an image from the egress image
 *    whose Smokescreen config adds `allow_ranges` for THAT subnet only (a product run never has an allow range);
 *  - the reconciler runs at the first preflight. Since Security N-D it removes only resources labelled with this
 *    backend's own executor tag (random here unless REGULAIT_EXECUTOR_IDENTIFIER is set), so another executor's live
 *    sandboxes on the same daemon are left alone; still, prefer a daemon of its own.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SHIPPED_EXECUTION_PROFILES, type ExecutionOffer, type ExecutionProfileBody } from "@regulait/shared";
import { dockerApiGet, egressNames } from "./docker-backend.js";
import { RuncDockerBackend } from "./runc-backend.js";

const EGRESS_IMAGE = process.env.REGULAIT_TEST_ROBOT_EGRESS_IMAGE ?? "";
const SANDBOX_IMAGE = process.env.REGULAIT_TEST_ROBOT_SANDBOX_IMAGE ?? "";
const TARGET_IMAGE = process.env.REGULAIT_TEST_ROBOT_TARGET_IMAGE ?? "";
const dockerUp = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" }).status === 0;
const enabled = dockerUp && /^sha256:[0-9a-f]{64}$/.test(EGRESS_IMAGE) && /^sha256:[0-9a-f]{64}$/.test(SANDBOX_IMAGE) && TARGET_IMAGE !== "";
const why = enabled
  ? "on a real Docker daemon (runc, not gVisor)"
  : "SKIPPED: no Docker daemon or REGULAIT_TEST_ROBOT_{EGRESS,SANDBOX,TARGET}_IMAGE unset; the egress is UNVERIFIED on a real network until it runs";
// R3 (non-blocking 3): where this suite is REQUIRED (the robot-egress CI job sets REGULAIT_TEST_ROBOT_REQUIRED=1) a
// missing daemon or image fails the file instead of skipping it, so the job can never pass vacuously
if (process.env.REGULAIT_TEST_ROBOT_REQUIRED === "1" && !enabled) {
  throw new Error(`REGULAIT_TEST_ROBOT_REQUIRED=1 but the suite cannot run: ${why} (docker reachable: ${dockerUp})`);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INIT = path.resolve(HERE, "../sandbox-init/sandbox-init.mjs");
const PRODUCT_SMOKESCREEN_YAML = path.resolve(HERE, "../../../engines/robot-egress/smokescreen.yaml");
/** the robot profile at L1 (the runc backend attests hardened_container only) */
const ROBOT_L1: ExecutionProfileBody = { ...structuredClone(SHIPPED_EXECUTION_PROFILES["robot-browser"]), minClass: "hardened_container" };
const RUN_ID = "0b6f3c1e-2d4a-4e8b-9f10-a1b2c3d4e5f6";
const ALLOWED_HOST = "portal.regulait.test";
const ALLOWED_PORT = 8443;
const OTHER_PORT = 9443;

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const dockerQuiet = (...args: string[]) => void spawnSync("docker", args, { stdio: "ignore" });

/**
 * The workload: run INSIDE the sandbox (node, no dependencies). argv: host TCP port, host UDP port, uplink gateway,
 * allowed target address. Prints ONE JSON line of what each attempt got.
 */
const PROBE = String.raw`
const net = require("node:net"), dgram = require("node:dgram"), dns = require("node:dns"), os = require("node:os");
const [tcpPort, udpPort, uplinkGw, targetIp] = process.argv.slice(1);
const proxy = new URL(process.env.REGULAIT_ROBOT_EGRESS_PROXY);
const withTimeout = (p, ms, v) => Promise.race([p, new Promise((r) => setTimeout(() => r(v), ms))]);
function viaProxy(request) {
  return withTimeout(new Promise((resolve) => {
    const s = net.connect(Number(proxy.port), proxy.hostname);
    let buf = "", tunnelled = false;
    s.on("error", (e) => resolve({ status: "error:" + e.code }));
    s.on("data", (c) => {
      buf += c.toString("latin1");
      if (!tunnelled && buf.includes("\r\n\r\n")) {
        const status = buf.split("\r\n")[0];
        if (request.startsWith("CONNECT") && / 200 /.test(status)) {
          tunnelled = true; buf = "";
          s.write("GET / HTTP/1.0\r\nHost: x\r\n\r\n");
        } else { s.destroy(); resolve({ status }); }
      }
    });
    s.on("end", () => { if (tunnelled) resolve({ status: "tunnelled", body: buf }); });
    s.on("connect", () => s.write(request));
  }), 15000, { status: "timeout" });
}
const connect = (authority) => viaProxy("CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\n\r\n");
function direct(host, port) {
  return withTimeout(new Promise((resolve) => {
    const s = net.connect(Number(port), host);
    s.on("connect", () => { s.destroy(); resolve("connected"); });
    s.on("error", (e) => resolve("error:" + e.code));
  }), 4000, "timeout");
}
function udp(host, port) {
  return withTimeout(new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    s.on("error", (e) => { s.close(); resolve("error:" + e.code); });
    s.send(Buffer.from("regulait-udp-probe"), Number(port), host, (e) => { s.close(); resolve(e ? "error:" + e.code : "sent"); });
  }), 4000, "timeout");
}
(async () => {
  const ifs = os.networkInterfaces();
  const eth = Object.entries(ifs).filter(([n]) => n !== "lo").flatMap(([, a]) => a);
  const v4 = eth.find((a) => a.family === "IPv4");
  const o = v4.address.split(".").map(Number), m = v4.netmask.split(".").map(Number);
  const first = o.map((x, i) => (i < 3 ? x & m[i] : (x & m[i]) + 1)).join(".");
  const out = {
    interfaces: Object.keys(ifs).sort(),
    ipv6: eth.filter((a) => a.family === "IPv6").map((a) => a.address),
    // with inhibit_ipv4 Docker reserves no gateway address, so the sandbox itself may hold the first address: the
    // assertion that matters is the host listener's, which counts every connection and datagram that arrives
    ownAddress: v4.address,
    networkFirstAddress: first,
    allowed: await connect("${ALLOWED_HOST}:${ALLOWED_PORT}"),
    otherPort: await connect("${ALLOWED_HOST}:${OTHER_PORT}"),
    notInAcl: await connect("other.regulait.test:${ALLOWED_PORT}"),
    ipLiteral: await connect(targetIp + ":${ALLOWED_PORT}"),
    metadata: await connect("169.254.169.254:80"),
    gatewayViaProxy: await connect(first + ":" + tcpPort),
    plainHttp: await viaProxy("GET http://${ALLOWED_HOST}:${ALLOWED_PORT}/ HTTP/1.1\r\nHost: ${ALLOWED_HOST}:${ALLOWED_PORT}\r\n\r\n"),
    directFirst: await direct(first, tcpPort),
    directUplinkGw: await direct(uplinkGw, tcpPort),
    directTarget: await direct(targetIp, ${ALLOWED_PORT}),
    directMetadata: await direct("169.254.169.254", 80),
    udpFirst: await udp(first, udpPort),
    udpUplinkGw: await udp(uplinkGw, udpPort),
    udpPublic: await udp("1.1.1.1", 53),
    dns: await withTimeout(dns.promises.lookup("example.com").then((r) => "resolved:" + r.address, (e) => "error:" + e.code), 8000, "timeout"),
  };
  console.log(JSON.stringify(out));
})();
`;

describe.skipIf(!enabled)(`a robot run's egress ${why}`, () => {
  const id = randomBytes(4).toString("hex");
  const third = randomInt(10, 250);
  const subnet = `10.250.${third}.0/24`;
  const uplinkGw = `10.250.${third}.1`;
  const targetIp = `10.250.${third}.10`;
  const uplink = `regulait-it-up-${id}`;
  const control = `regulait-it-ctl-${id}`;
  const target = `regulait-it-tgt-${id}`;
  const derived = `regulait-it/robot-egress-${id}`;
  const initVolume = `regulait-it-init-${id}`;
  const aclVolume = `regulait-it-acl-${id}`;
  const dirs: string[] = [];
  let tcp: Server;
  let udp: UdpSocket;
  let tcpPort = 0;
  let udpPort = 0;
  const tcpHits: string[] = [];
  const udpHits: string[] = [];
  let derivedId = "";
  let initDir = "";
  let aclDir = "";

  beforeAll(async () => {
    tcp = createServer((s) => {
      tcpHits.push(s.remoteAddress ?? "?");
      s.destroy();
    });
    await new Promise<void>((r) => tcp.listen(0, "0.0.0.0", () => r()));
    tcpPort = (tcp.address() as { port: number }).port;
    udp = createSocket("udp4");
    udp.on("message", (_m, rinfo) => udpHits.push(rinfo.address));
    await new Promise<void>((r) => udp.bind(0, "0.0.0.0", () => r()));
    udpPort = udp.address().port;

    docker("network", "create", "--driver", "bridge", "--subnet", subnet, "--label", "regulait-it=1", uplink);
    docker(
      "run",
      "-d",
      "--name",
      target,
      "--network",
      uplink,
      "--ip",
      targetIp,
      "--network-alias",
      ALLOWED_HOST,
      TARGET_IMAGE,
      "sh",
      "-c",
      `mkdir -p /www && echo ALLOWED-OK > /www/index.html && httpd -p ${ALLOWED_PORT} -h /www && httpd -f -p ${OTHER_PORT} -h /www`,
    );
    // TEST ONLY: the product config plus an allow range for THIS test subnet (the allowed target is a private address)
    const ctx = mkdtempSync(path.join(tmpdir(), "regulait-it-egress-"));
    dirs.push(ctx);
    writeFileSync(path.join(ctx, "smokescreen.yaml"), `${readFileSync(PRODUCT_SMOKESCREEN_YAML, "utf8")}\nallow_ranges:\n  - ${subnet}\n`);
    // BuildKit's FROM takes a name, not an image id: a local tag for the given image (never pulled)
    docker("tag", EGRESS_IMAGE, `${derived}-base`);
    writeFileSync(path.join(ctx, "Dockerfile"), `FROM ${derived}-base\nCOPY smokescreen.yaml /etc/regulait/smokescreen.yaml\n`);
    docker("build", "-q", "--pull=false", "-t", derived, ctx);
    derivedId = docker("image", "inspect", "-f", "{{.Id}}", derived);

    initDir = mkdtempSync(path.join(tmpdir(), "regulait-it-init-"));
    aclDir = mkdtempSync(path.join(tmpdir(), "regulait-it-acl-"));
    dirs.push(initDir, aclDir);
    chmodSync(initDir, 0o755);
    for (const [vol, dir] of [
      [initVolume, initDir],
      [aclVolume, aclDir],
    ] as const) {
      docker("volume", "create", "--driver", "local", "--opt", "type=none", "--opt", "o=bind", "--opt", `device=${dir}`, vol);
    }
  }, 180_000);

  afterAll(async () => {
    dockerQuiet("rm", "-f", target);
    dockerQuiet("network", "rm", uplink);
    dockerQuiet("network", "rm", control);
    dockerQuiet("volume", "rm", initVolume);
    dockerQuiet("volume", "rm", aclVolume);
    dockerQuiet("image", "rm", derived);
    dockerQuiet("image", "rm", `${derived}-base`);
    tcp?.close();
    udp?.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("from inside the sandbox: every way out is denied; the allowed host on its allowed port is reached", async () => {
    const real = dockerApiGet("/var/run/docker.sock");
    const backend = new RuncDockerBackend({
      runtimeName: "runc",
      canaryImage: SANDBOX_IMAGE,
      runtimeVersion: "it",
      initSource: INIT,
      initDir,
      initVolume,
      inputDir: null,
      inputVolume: null,
      robotEgressImage: derivedId,
      egressAclDir: aclDir,
      egressAclVolume: aclVolume,
      egressUplinkNetwork: uplink,
      egressRuntimeName: null,
      reconcileIntervalMs: 0,
      probeTimeoutMs: 60_000,
      // TEST ONLY (see the header): report userns when the daemon lacks it
      dockerApi: async (p: string) => {
        const v = await real(p);
        if (p !== "/info") return v;
        const opts = ((v as { SecurityOptions?: string[] }).SecurityOptions ?? []).slice();
        if (!opts.some((o) => o.startsWith("name=userns") || o.startsWith("name=rootless"))) opts.push("name=userns");
        return { ...(v as object), SecurityOptions: opts };
      },
    });
    const offer: ExecutionOffer = {
      id: "5b0c1a3e-6a1e-4a4b-9a2c-0f4e5d6c7b8a",
      workloadKind: "robot_browser",
      requiredClass: "hardened_container",
      requiredBy: "configured_profile",
      enforcement: "enforce",
      profileDigest: "a".repeat(64),
      imageDigest: SANDBOX_IMAGE,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      egress: { runId: RUN_ID, targets: [{ host: ALLOWED_HOST, port: ALLOWED_PORT }] },
    };
    const h = await backend.start(offer, ROBOT_L1, "hardened_container");
    const names = egressNames(h.id);
    try {
      // the network as built: internal, no IPv6, no gateway, the host bridge without an address
      const net = JSON.parse(docker("network", "inspect", names.network, "--format", "{{json .}}")) as {
        Internal: boolean;
        EnableIPv6: boolean;
        Options: Record<string, string>;
        IPAM: { Config: Array<{ Subnet?: string; Gateway?: string }> };
      };
      expect(net.Internal).toBe(true);
      expect(net.EnableIPv6).toBe(false);
      expect(net.Options["com.docker.network.bridge.inhibit_ipv4"]).toBe("true");
      expect(net.IPAM.Config.every((c) => !c.Gateway)).toBe(true);
      // the proxy: explicit runtime and seccomp profile
      const proxyHost = JSON.parse(docker("inspect", names.proxy, "--format", "{{json .HostConfig}}")) as { Runtime: string; SecurityOpt: string[] };
      expect(proxyHost.Runtime).toBe("runc");
      expect(proxyHost.SecurityOpt).toContain("seccomp=builtin");

      await h.releaseInput({ command: "/usr/local/bin/node", args: ["-e", PROBE, String(tcpPort), String(udpPort), uplinkGw, targetIp] });
      let last = "";
      for await (const l of h.stdio!.lines()) last = l;
      const r = JSON.parse(last) as Record<string, unknown> & {
        allowed: { status: string; body?: string };
        interfaces: string[];
        ipv6: string[];
      };
      // eslint-disable-next-line no-console
      console.log("robot egress probe (inside the sandbox):", JSON.stringify(r, null, 2));

      // ALLOWED: the target, through the proxy, on its allowed port
      expect(r.allowed.status).toBe("tunnelled");
      expect(r.allowed.body).toContain("ALLOWED-OK");
      // DENIED through the proxy (each answered, never tunnelled)
      for (const k of ["otherPort", "notInAcl", "ipLiteral", "metadata", "gatewayViaProxy", "plainHttp"]) {
        const v = r[k] as { status: string };
        expect(v.status, k).not.toBe("tunnelled");
        expect(v.status, k).not.toMatch(/ 200 /);
      }
      // the front filter (D-2026-11-22-07) refuses a target's host on another port with ITS 403, before Smokescreen
      // (whose own refusals answer 407) sees the request
      expect((r.otherPort as { status: string }).status).toMatch(/ 403 /);
      expect((r.plainHttp as { status: string }).status).toMatch(/ 403 /);
      // DENIED around the proxy: no TCP connection to the host, the uplink, the target or the metadata address
      for (const k of ["directFirst", "directUplinkGw", "directTarget", "directMetadata"]) expect(r[k], k).not.toBe("connected");
      // only the loopback and the one interface on the run's network; no IPv6 address
      expect(r.interfaces.length).toBe(2);
      expect(r.ipv6).toEqual([]);
      // no DNS for a public name
      expect(String(r.dns)).not.toMatch(/^resolved/);
    } finally {
      await h.kill().catch(() => undefined);
      await h.ended;
    }
    // UDP and TCP: nothing the sandbox sent arrived at the host's listeners (UDP to the network's first address, the
    // uplink gateway, a public resolver; TCP to the first address and the uplink gateway)
    await new Promise((res) => setTimeout(res, 500));
    expect(udpHits, "UDP reached the host").toEqual([]);
    expect(tcpHits, "TCP reached the host").toEqual([]);
    // the evidence: the proxy logged an allowed decision and the front filter's refusal
    const log = await h.egressLog!();
    expect(log).toContain(`"allow":true`);
    expect(log).toContain("regulait front filter");
    // and everything of the run is gone
    expect(spawnSync("docker", ["inspect", names.proxy], { stdio: "ignore" }).status).not.toBe(0);
    expect(spawnSync("docker", ["network", "inspect", names.network], { stdio: "ignore" }).status).not.toBe(0);
    backend.stopReconciler();
  }, 300_000);

  it("negative control: on a plain --internal network (no inhibit_ipv4) the same probe DOES reach the host", async () => {
    docker("network", "create", "--internal", "--driver", "bridge", "--label", "regulait-it=1", control);
    const gw = docker("network", "inspect", control, "--format", "{{(index .IPAM.Config 0).Gateway}}");
    const before = tcpHits.length;
    const script = `const s=require("node:net").connect(${tcpPort}, ${JSON.stringify(gw)});s.on("connect",()=>{console.log("connected");s.destroy()});s.on("error",(e)=>console.log("error:"+e.code));setTimeout(()=>{console.log("timeout");process.exit(0)},4000).unref()`;
    const out = docker("run", "--rm", "--network", control, "--user", "10001:10001", "--entrypoint", "/usr/local/bin/node", SANDBOX_IMAGE, "-e", script);
    expect(out).toBe("connected");
    // the docker call above blocked this process: let the listener's accept run
    await new Promise((res) => setTimeout(res, 500));
    expect(tcpHits.length).toBe(before + 1);
  }, 120_000);
});
