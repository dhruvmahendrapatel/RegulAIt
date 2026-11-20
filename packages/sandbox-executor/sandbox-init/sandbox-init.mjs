#!/usr/local/bin/node
/**
 * ADR-0190 slice I4 — THE SANDBOX INIT. EXECUTOR-CONTROLLED (review H2): the
 * executor ships this file, checks its pinned SHA-256 (`src/init-pin.ts`),
 * copies it into a volume it owns and mounts that volume READ-ONLY at
 * /.regulait-init, and starts the sandbox with this file as its entry point
 * (run by the image's own Node). The workload's image cannot replace it.
 *
 * What it reports CORROBORATES; it never decides the class. It runs under the
 * image's interpreter, so a hostile image could make it print anything: the
 * executor decides the runtime from outside the sandbox (the container's
 * runtime and the runtime binary's pinned hash), and the gateway refuses a
 * report whose inside view disagrees with that.
 *
 * It runs as the sandbox's first process, as the profile's uid, BEFORE the
 * workload has any input, and does three things in order:
 *
 *  1. PROBES (decision 6, amendment D) from inside the sandbox and writes ONE
 *     line to stdout: `{"regulait-sandbox-init":1,"observed":{…}}`. Every
 *     value is an observation, never a verdict (the gateway judges);
 *  2. waits for exactly ONE line on stdin, read byte by byte so nothing after
 *     it is consumed: `{"regulait-release":1,"argv":[…]}` (the gateway
 *     accepted the per-placement report; `argv` is the registered entry point
 *     inside the image and its fixed arguments) — anything else, or end of
 *     input, exits 3 with the workload never started;
 *  3. starts the workload (`argv`, never a shell) with the sandbox's own stdin
 *     and stdout, so from here on the MCP bytes are the server's, and exits
 *     with its status. ADR-0190 I5: a release line may also carry an engine
 *     task's `secret`; it is written to the workload's fd 3 (a pipe) and
 *     nowhere else.
 *
 * `--canary` (the executor self-test) exits 0 on a release line with no
 * `argv`: a canary never runs a workload.
 *
 * Node standard library only. No network, no file written except the probe's
 * own root-write attempt (which must fail).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { connect } from "node:net";
import { lookup } from "node:dns/promises";
import { release as osRelease } from "node:os";

/** the egress probe's public literal address (decision 6: no resolver needed, must not connect) */
const EGRESS_ADDRESS = "1.1.1.1";
const EGRESS_PORT = 443;
const DNS_HOST = "example.com";
/** names and shapes of credentials an executor, runner or gateway would hold (never their values) */
const CREDENTIAL_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|DATABASE_URL|DOCKER_HOST|^REGULAIT_)/i;
const CREDENTIAL_VALUE = /(^rge_|^pdp_|-----BEGIN [A-Z ]*PRIVATE KEY-----|^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)/;
/**
 * N7: the robot runner image's browser location, the ONLY values a robot run's workload takes from the image's own
 * environment (each an absolute path; never a `REGULAIT_` name, which the credential scan above would count); plus
 * PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, passed only as "1"
 */
const ROBOT_IMAGE_ENV = ["PLAYWRIGHT_BROWSERS_PATH", "ROBOT_CHROMIUM"];
/** paths that would hand the sandbox the executor's runtime or key */
const CREDENTIAL_PATHS = ["/var/run/docker.sock", "/run/docker.sock", "/run/containerd/containerd.sock", "/state", "/root/.docker", "/run/secrets", "/etc/regulait"];

const read = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

function procStatus() {
  const out = {};
  for (const line of read("/proc/self/status").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  const uid = Number.parseInt((out.Uid ?? "").split(/\s+/)[0] ?? "", 10);
  return {
    uid: Number.isInteger(uid) ? uid : -1,
    capEff: (out.CapEff ?? "").toLowerCase(),
    noNewPrivs: Number.parseInt(out.NoNewPrivs ?? "-1", 10),
    seccomp: Number.parseInt(out.Seccomp ?? "-1", 10),
  };
}

/** a syscall the runtime-default seccomp profile denies (unshare without CAP_SYS_ADMIN) */
function seccompProbe() {
  const r = spawnSync("unshare", ["-U", "/bin/true"], { encoding: "utf8", timeout: 5000, env: {} });
  if (r.error) return { syscall: "unshare", inconclusive: `spawn_${r.error.code ?? "error"}` };
  if (r.status === 0) return { syscall: "unshare", denied: false };
  if (/Operation not permitted/.test(r.stderr ?? "")) return { syscall: "unshare", denied: true };
  return { syscall: "unshare", inconclusive: "unexpected_failure" };
}

/** amendment D: EROFS, or `ro` on `/` in /proc/self/mounts; EACCES alone proves nothing */
function rootReadOnly() {
  const probe = "/.regulait-root-write-probe";
  try {
    writeFileSync(probe, "x");
    try {
      unlinkSync(probe);
    } catch {
      // nothing
    }
    return { method: "erofs", readOnly: false };
  } catch (e) {
    if (e && e.code === "EROFS") return { method: "erofs", readOnly: true };
    const root = read("/proc/self/mounts")
      .split("\n")
      .map((l) => l.split(" "))
      .find((f) => f[1] === "/");
    if (root) return { method: "mount_ro", readOnly: (root[3] ?? "").split(",").includes("ro") };
    return { method: "eacces", readOnly: true };
  }
}

function egressLiteral() {
  return new Promise((resolve) => {
    const s = connect({ host: EGRESS_ADDRESS, port: EGRESS_PORT });
    const done = (connected) => {
      s.destroy();
      resolve({ address: EGRESS_ADDRESS, connected });
    };
    s.setTimeout(3000, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

async function egressDns() {
  try {
    await Promise.race([lookup(DNS_HOST), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000))]);
    return { host: DNS_HOST, resolved: true };
  } catch {
    return { host: DNS_HOST, resolved: false };
  }
}

function interfaces() {
  return read("/proc/net/dev")
    .split("\n")
    .slice(2)
    .map((l) => l.split(":")[0].trim())
    .filter(Boolean);
}

function credentials() {
  let found = 0;
  for (const [k, v] of Object.entries(process.env)) if (CREDENTIAL_NAME.test(k) || CREDENTIAL_VALUE.test(v ?? "")) found += 1;
  for (const a of process.argv) if (CREDENTIAL_VALUE.test(a)) found += 1;
  for (const p of CREDENTIAL_PATHS) if (existsSync(p)) found += 1;
  return { scanned: ["env", "args", "fs"], found };
}

function limits() {
  const mem = /MemTotal:\s+(\d+)\s+kB/.exec(read("/proc/meminfo"));
  const soft = (name) => {
    const line = read("/proc/self/limits")
      .split("\n")
      .find((l) => l.startsWith(name));
    const v = line ? Number.parseInt(line.slice(name.length).trim().split(/\s+/)[0] ?? "", 10) : Number.NaN;
    return Number.isInteger(v) ? v : -1;
  };
  return {
    memTotalMiB: mem ? Math.floor(Number(mem[1]) / 1024) : -1,
    rlimitNproc: soft("Max processes"),
    rlimitNofile: soft("Max open files"),
  };
}

function runtimeIdentity() {
  const version = read("/proc/version");
  let dmesgGvisor = false;
  const d = spawnSync("dmesg", [], { encoding: "utf8", timeout: 5000, env: {} });
  if (!d.error) dmesgGvisor = /Starting gVisor/.test(d.stdout ?? "");
  const cpuinfo = read("/proc/cpuinfo");
  return {
    kernelRelease: osRelease(),
    procVersionGvisor: /gvisor/i.test(version),
    dmesgGvisor,
    hypervisorFlag: /^flags\s*:.*\bhypervisor\b/m.test(cpuinfo),
  };
}

/** read exactly one line from fd 0, byte by byte (nothing after it is consumed) */
/**
 * read exactly one line from fd 0, byte by byte (nothing after it is consumed), and decode it as UTF-8 only
 * once the whole line is in (review M5: a multi-byte character split across reads is never mangled; an invalid
 * sequence is refused, never replaced)
 */
function readOneLine(max = 512 * 1024) {
  const one = Buffer.alloc(1);
  const bytes = [];
  for (;;) {
    let n;
    try {
      n = readSync(0, one, 0, 1, null);
    } catch (e) {
      if (e && e.code === "EAGAIN") continue;
      return null;
    }
    if (n === 0) return null;
    if (one[0] === 0x0a) break;
    bytes.push(one[0]);
    if (bytes.length > max) return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

async function main() {
  const canary = process.argv[2] === "--canary";
  const observed = {
    runtime: runtimeIdentity(),
    status: procStatus(),
    seccomp: seccompProbe(),
    root: rootReadOnly(),
    egressLiteral: await egressLiteral(),
    dns: await egressDns(),
    interfaces: interfaces(),
    credentials: credentials(),
    limits: limits(),
  };
  writeSync(1, `${JSON.stringify({ "regulait-sandbox-init": 1, observed })}\n`);
  const line = readOneLine();
  let release = null;
  try {
    release = line === null ? null : JSON.parse(line);
  } catch {
    release = null;
  }
  if (!release || release["regulait-release"] !== 1) process.exit(3);
  if (canary) process.exit(release.argv === undefined ? 0 : 4);
  const argv = release.argv;
  const okArgv =
    Array.isArray(argv) &&
    argv.length >= 1 &&
    argv.length <= 65 &&
    argv.every((a) => typeof a === "string" && !a.includes("\0")) &&
    argv[0].startsWith("/");
  if (!okArgv) process.exit(4);
  // ADR-0190 I5: an engine task's secret (decision 5, task_scoped) arrives on this release line only, and goes to the
  // workload on fd 3, a pipe: never its environment, its argv, or a file
  const secret = release.secret;
  if (secret !== undefined && (typeof secret !== "string" || !/^[\x21-\x7e]{1,1024}$/.test(secret))) process.exit(4);
  release.secret = undefined;
  // ADR-0364 S3: a robot run's per-run egress proxy (the sandbox's only peer), named by the executor on this line:
  // http, an IPv4 literal and a port, nothing else (with the run id and the browser location below, all the workload gets beyond PATH and HOME)
  const egressProxy = release.egressProxy;
  if (egressProxy !== undefined && (typeof egressProxy !== "string" || !/^http:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5}$/.test(egressProxy))) process.exit(4);
  // with it, the run the robot runner reads its plan for (a uuid); both or neither
  const robotRunId = release.robotRunId;
  if (robotRunId !== undefined && (typeof robotRunId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(robotRunId))) process.exit(4);
  if ((egressProxy === undefined) !== (robotRunId === undefined)) process.exit(4);
  const [command, ...args] = argv;
  // the workload's environment: nothing but a PATH and HOME (the work directory the executor set as the cwd) (decision 5: no secret, nothing inherited from the executor)
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: process.cwd() };
  if (egressProxy !== undefined) {
    env.REGULAIT_ROBOT_EGRESS_PROXY = egressProxy;
    env.REGULAIT_ROBOT_RUN_ID = robotRunId;
    // N7: a robot run's browser location, from the IMAGE's own environment (its ENV; the executor passes none in), by a
    // fixed allow-list and only as absolute paths of plain segments; anything else is not passed (the runner then finds
    // no browser and fails closed)
    for (const name of ROBOT_IMAGE_ENV) {
      const v = process.env[name];
      if (typeof v === "string" && v.length <= 512 && /^\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(v) && !v.split("/").includes("..")) env[name] = v;
    }
    if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === "1") env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
  }
  const child = spawn(command, args, {
    stdio: secret === undefined ? "inherit" : ["inherit", "inherit", "inherit", "pipe"],
    env,
  });
  if (secret !== undefined) child.stdio[3].end(secret);
  child.on("error", () => process.exit(5));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
}

// fd 0 is read only through readOneLine (never a stream reader), so the workload inherits it unconsumed
void main();
