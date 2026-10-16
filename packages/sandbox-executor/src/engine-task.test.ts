/**
 * ADR-0190 slice I5 — the two channels the runsc backend gains for engine tasks, and the offer handler's order for
 * an `engine_worker` placement. No Docker daemon: the real sandbox init runs on this host in place of `docker run`
 * (as the I4 suite does), and the Docker Engine API is a seam. What it pins:
 *
 *  - INPUT VOLUME: the task's input is written under the executor's input directory and verified file by file before
 *    any sandbox exists; a byte that differs from the manifest refuses the placement and leaves nothing behind; the
 *    `docker run` mounts that sub-path READ-ONLY at the profile's input path; the handle's digest is the digest of the
 *    bytes written; the input is removed with the sandbox.
 *  - TASK SECRET: never in the `docker run` arguments (nothing `docker inspect` shows); it reaches the workload on
 *    fd 3 only (the workload here prints the SHA-256 of what it read there, and of its environment); a profile with
 *    `secrets: none` refuses one; a stdio MCP server never takes an input.
 *  - THE OFFER HANDLER: for a profile with inputs it fetches the manifest and the files BEFORE it starts the sandbox,
 *    names the input digest in the per-placement report, and releases the workload only from the MACed `start`
 *    line, with that line's secret.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  engineTaskInputDigest,
  executionProfileDigest,
  runscFlags,
  SHIPPED_EXECUTION_PROFILES,
  stdioFrameMac,
  stdioMacKey,
  type EngineTaskInputManifest,
  type ExecutionOffer,
  type ExecutorReport,
  type ExecutorStdioMessage,
  type SignedExecutorReport,
} from "@regulait/shared";
import { RUNSC_RELEASES } from "./init-pin.js";
import { RunscDockerBackend, type DockerChild } from "./runsc-backend.js";
import { removeTaskInput, TaskInputError, writeTaskInput, type SandboxTaskInput } from "./task-input.js";
import { FakeSandboxBackend } from "./fake-backend.js";
import { handleOffer, type OfferContext } from "./offers.js";
import { runSelfTests } from "./self-test.js";
import type { ExecutorClient } from "./client.js";

const INIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../sandbox-init/sandbox-init.mjs");
const ENGINE = SHIPPED_EXECUTION_PROFILES["engine-worker"];
const IMAGE = `sha256:${"e".repeat(64)}`;
const RUNSC_HOST = "/usr/local/lib/gvisor/runsc";
const RUN_ID = "3d1f0c2b-6a7e-4b8c-9d0e-1f2a3b4c5d6e";
// a synthetic task secret, derived at run time (never a secret-shaped literal)
const SECRET = `t-${createHash("sha256").update(`i5-${process.pid}`).digest("hex").slice(0, 32)}`;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const job = Buffer.from(JSON.stringify({ runId: RUN_ID, probes: ["x.y"] }), "utf8");
const artifact = Buffer.alloc(70_000, 7);
function taskOf(files: Array<{ path: string; bytes: Buffer }>, tamper?: (n: number, b: Buffer) => Buffer): SandboxTaskInput {
  const metas = files.map((f) => ({ path: f.path, size: f.bytes.length, sha256: sha(f.bytes) }));
  const manifest: EngineTaskInputManifest = { input: "jobs", files: metas, digest: engineTaskInputDigest(metas) };
  return {
    manifest,
    open: async (n) =>
      (async function* () {
        const b = tamper ? tamper(n, files[n]!.bytes) : files[n]!.bytes;
        // in two chunks, as a stream would deliver it
        yield b.subarray(0, Math.floor(b.length / 2));
        yield b.subarray(Math.floor(b.length / 2));
      })(),
  };
}
const FILES = [
  { path: `${RUN_ID}/job.json`, bytes: job },
  { path: `${RUN_ID}/artifact.pkl`, bytes: artifact },
];

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeTaskInput(d);
});

describe("the input volume: written and verified before any sandbox", () => {
  it("writes every file read-only and returns the digest of what it wrote", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "regulait-i5-in-"));
    dirs.push(root);
    const digest = await writeTaskInput(path.join(root, "jobs"), taskOf(FILES));
    expect(digest).toBe(engineTaskInputDigest(FILES.map((f) => ({ path: f.path, size: f.bytes.length, sha256: sha(f.bytes) }))));
    const file = path.join(root, "jobs", RUN_ID, "artifact.pkl");
    expect(readFileSync(file).equals(artifact)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o444);
    expect(statSync(path.join(root, "jobs", RUN_ID)).mode & 0o777).toBe(0o555);
  });

  it("a file whose bytes differ from the manifest (or run long) refuses the input, and nothing is left behind", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "regulait-i5-in-"));
    dirs.push(root);
    const flip = (n: number, b: Buffer) => (n === 1 ? Buffer.concat([b.subarray(0, -1), Buffer.from([0])]) : b);
    await expect(writeTaskInput(path.join(root, "jobs"), taskOf(FILES, flip))).rejects.toThrow(TaskInputError);
    expect(existsSync(path.join(root, "jobs"))).toBe(false);
    const longer = (n: number, b: Buffer) => (n === 0 ? Buffer.concat([b, Buffer.from("x")]) : b);
    await expect(writeTaskInput(path.join(root, "jobs"), taskOf(FILES, longer))).rejects.toThrow(/longer than its manifest/);
    expect(existsSync(path.join(root, "jobs"))).toBe(false);
  });

  it("a manifest that is not valid (a digest that is not the files', a dot segment) is refused before anything is written", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "regulait-i5-in-"));
    dirs.push(root);
    const t = taskOf(FILES);
    await expect(writeTaskInput(path.join(root, "jobs"), { ...t, manifest: { ...t.manifest, digest: "0".repeat(64) } })).rejects.toThrow(/not valid/);
    const bad = { ...t.manifest, files: [{ ...t.manifest.files[0]!, path: "../escape" }] };
    await expect(writeTaskInput(path.join(root, "jobs"), { ...t, manifest: { ...bad, digest: engineTaskInputDigest(bad.files) } })).rejects.toThrow(/not valid/);
    expect(existsSync(path.join(root, "jobs"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The runsc backend, with the real init on this host
// ---------------------------------------------------------------------------

const offer: ExecutionOffer = {
  id: "8c2f0b1a-3d4e-4f5a-8b6c-7d8e9f0a1b2c",
  workloadKind: "engine_worker",
  requiredClass: "user_space_kernel",
  requiredBy: "workload_kind",
  enforcement: "enforce",
  profileDigest: executionProfileDigest(ENGINE),
  imageDigest: IMAGE,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

function hostBackend(calls: string[][], inputDir: string | null) {
  const dir = mkdtempSync(path.join(tmpdir(), "regulait-i5-init-"));
  const fakeRunsc = path.join(dir, "runsc");
  writeFileSync(fakeRunsc, "stand-in");
  return new RunscDockerBackend({
    runtimeName: "runsc",
    canaryImage: IMAGE,
    runtimeVersion: "release-20261005.0",
    initSource: INIT,
    initDir: path.join(dir, "volume"),
    initVolume: "regulait-init",
    runscBinary: fakeRunsc,
    runscHostPath: RUNSC_HOST,
    sha512File: async () => RUNSC_RELEASES["release-20261005.0"]!,
    inputDir,
    inputVolume: inputDir ? "regulait-input" : null,
    dockerApi: async (p: string) => {
      if (p === "/info") return { Runtimes: { runsc: { path: RUNSC_HOST, runtimeArgs: runscFlags(ENGINE) } } };
      if (p.endsWith("/json")) return { Image: IMAGE, HostConfig: { Runtime: "runsc", NanoCpus: 2e9, Memory: 2048 * 1024 ** 2, PidsLimit: 768 }, State: { OOMKilled: false } };
      return { cpu_stats: { throttling_data: { throttled_periods: 0 } } };
    },
    spawnDocker: (args: string[]): DockerChild => {
      calls.push(args);
      if (args[0] === "run") return spawn(process.execPath, [INIT], { stdio: ["pipe", "pipe", "pipe"] }) as DockerChild;
      return spawn(process.execPath, ["-e", ""], { stdio: ["pipe", "pipe", "pipe"] }) as DockerChild;
    },
  });
}

/** a workload that prints the SHA-256 of what it reads on fd 3, and whether its environment holds the secret */
function fd3Workload(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "regulait-i5-wl-"));
  const file = path.join(dir, "fd3.cjs");
  writeFileSync(
    file,
    [
      'const { readFileSync } = require("node:fs");',
      'const { createHash } = require("node:crypto");',
      "let s = '';",
      "try { s = readFileSync(3, 'utf8'); } catch { s = ''; }",
      "const inEnv = Object.values(process.env).some((v) => s && v === s);",
      "const inArgs = process.argv.some((a) => s && a.includes(s));",
      "process.stdout.write(JSON.stringify({ fd3: createHash('sha256').update(s).digest('hex'), inEnv, inArgs }) + '\\n');",
    ].join("\n"),
  );
  return file;
}

describe("the runsc backend: an engine task's input volume and task secret", () => {
  it("mounts the verified input read-only, keeps the secret out of docker run, and hands it to the workload on fd 3", async () => {
    const inputDir = mkdtempSync(path.join(tmpdir(), "regulait-i5-vol-"));
    dirs.push(inputDir);
    const calls: string[][] = [];
    const b = hostBackend(calls, inputDir);
    const h = await b.start(offer, ENGINE, "user_space_kernel", taskOf(FILES));
    const run = calls[0]!;
    expect(run[0]).toBe("run");
    const name = run[run.indexOf("--name") + 1]!;
    expect(run).toContain(`type=volume,src=regulait-input,dst=/jobs,readonly,volume-subpath=${name}/jobs`);
    expect(h.inputSha256).toBe(engineTaskInputDigest(FILES.map((f) => ({ path: f.path, size: f.bytes.length, sha256: sha(f.bytes) }))));
    expect(readFileSync(path.join(inputDir, name, "jobs", RUN_ID, "job.json")).equals(job)).toBe(true);
    await h.probe(["runtime_identity", "runtime_config"]);
    await h.releaseInput({ command: process.execPath, args: [fd3Workload()] }, SECRET);
    const lines = h.stdio!.lines()[Symbol.asyncIterator]();
    const out = JSON.parse((await lines.next()).value as string) as { fd3: string; inEnv: boolean; inArgs: boolean };
    expect(out).toEqual({ fd3: sha(SECRET), inEnv: false, inArgs: false });
    expect(await h.ended).toBe("completed");
    // never in any docker invocation (run, kill, rm): nothing docker inspect could show
    expect(JSON.stringify(calls)).not.toContain(SECRET);
    // the input goes with its sandbox
    expect(existsSync(path.join(inputDir, name))).toBe(false);
  }, 30_000);

  it("refuses before any docker run: no input volume, an input the profile does not declare, a profile without the input", async () => {
    const calls: string[][] = [];
    await expect(hostBackend(calls, null).start(offer, ENGINE, "user_space_kernel", taskOf(FILES))).rejects.toThrow(/no input volume/);
    const inputDir = mkdtempSync(path.join(tmpdir(), "regulait-i5-vol-"));
    dirs.push(inputDir);
    const b = hostBackend(calls, inputDir);
    await expect(b.start(offer, ENGINE, "user_space_kernel")).rejects.toThrow(/does not match the profile's declared inputs/);
    await expect(b.start({ ...offer, workloadKind: "mcp_stdio" }, SHIPPED_EXECUTION_PROFILES.restricted, "user_space_kernel", taskOf(FILES))).rejects.toThrow(/takes no task input/);
    await expect(b.start(offer, ENGINE, "user_space_kernel", taskOf(FILES, (n, x) => (n === 0 ? Buffer.from("other") : x)))).rejects.toThrow(TaskInputError);
    expect(calls, "no docker run for a refused sandbox").toEqual([]);
  }, 30_000);

  it("review LOW-2: a refused input leaves no sandbox directory behind, and the first preflight removes leftovers", async () => {
    const inputDir = mkdtempSync(path.join(tmpdir(), "regulait-i5-vol-"));
    dirs.push(inputDir);
    const calls: string[][] = [];
    const b = hostBackend(calls, inputDir);
    // a previous run of this executor left an input behind (read-only, as written); an unrelated entry stays
    const left = path.join(inputDir, "regulait-sbx-11111111-2222-4333-8444-555555555555");
    await writeTaskInput(path.join(left, "jobs"), taskOf(FILES));
    mkdirSync(path.join(inputDir, "not-ours"));
    await expect(b.start(offer, ENGINE, "user_space_kernel", taskOf(FILES, (n, x) => (n === 0 ? Buffer.from("other") : x)))).rejects.toThrow(TaskInputError);
    expect(readdirSync(inputDir)).toEqual(["not-ours"]);
    expect(calls).toEqual([]);
  }, 30_000);

  it("review MEDIUM-2: without an input volume the engine-worker profile is unsupported (never self-tested, never attested)", () => {
    expect(hostBackend([], null).unsupported(ENGINE)).toMatch(/no input volume/);
    const inputDir = mkdtempSync(path.join(tmpdir(), "regulait-i5-vol-"));
    dirs.push(inputDir);
    expect(hostBackend([], inputDir).unsupported(ENGINE)).toBeNull();
    expect(hostBackend([], null).unsupported(SHIPPED_EXECUTION_PROFILES.restricted)).toBeNull();
  });

  it("review MEDIUM-2: the self-test skips a profile the backend cannot serve, so the gateway never sees an attestation of it", async () => {
    const ref = (name: string, body: typeof ENGINE) => ({ digest: executionProfileDigest(body), name, version: 1, minClass: "user_space_kernel" as const, body });
    const profiles = new Map([ENGINE, SHIPPED_EXECUTION_PROFILES.restricted].map((b, i) => [executionProfileDigest(b), ref(`p${i}`, b)]));
    const submitted: string[] = [];
    const backend = new FakeSandboxBackend({ unsupported: (p) => (p.filesystem.inputs.length > 0 ? "declared read-only inputs (this executor has no input volume)" : null) });
    const out = await runSelfTests({
      backend,
      credential: { identifier: "spiffe://regulait.test/executor/i5", signReport: async (r: ExecutorReport) => ({ report: r }) as unknown as SignedExecutorReport } as never,
      client: {
        selfTest: async (reports: SignedExecutorReport[]) => {
          for (const r of reports) submitted.push((r as unknown as { report: ExecutorReport }).report.profileDigest);
          return { results: [], next: "ok" };
        },
      } as never,
      profiles,
      classesDeclared: ["user_space_kernel"],
    });
    expect(out.fresh).toEqual([]);
    expect(submitted).toEqual([executionProfileDigest(SHIPPED_EXECUTION_PROFILES.restricted)]);
    expect(backend.sandboxes.filter((s) => s.kind === "canary")).toHaveLength(1);
  });

  it("a profile with secrets: none never takes a task secret", async () => {
    const calls: string[][] = [];
    const restricted = SHIPPED_EXECUTION_PROFILES.restricted;
    const b = hostBackend(calls, null);
    const h = await b.start({ ...offer, workloadKind: "mcp_stdio", profileDigest: executionProfileDigest(restricted) }, restricted, "user_space_kernel");
    await expect(h.releaseInput({ command: "/bin/cat", args: [] }, SECRET)).rejects.toThrow(/admits no task secret/);
    // (on this host `docker kill` is a no-op: the init is released without a secret and its stdin ended instead)
    await h.releaseInput({ command: "/bin/cat", args: [] });
    await h.stdio!.endInput();
    expect(await h.ended).toBe("completed");
    expect(JSON.stringify(calls)).not.toContain(SECRET);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The offer handler for an engine_worker placement
// ---------------------------------------------------------------------------

describe("handleOffer: an engine task is started on its input, reported with its digest, released from its MACed start", () => {
  it("fetches the input before the sandbox, names its digest in the report, and releases with the start line's secret", async () => {
    const order: string[] = [];
    const secretB64 = Buffer.alloc(32, 9).toString("base64url");
    const key = stdioMacKey(secretB64, offer.id);
    const workload = { command: "/usr/local/bin/node", args: ["/app/dist/task-main.js"] };
    const task = taskOf(FILES);
    let reported: ExecutorReport | null = null;
    const posted: string[] = [];
    let seen: { secret: string | undefined; files: string[] } | null = null;
    const backend = new FakeSandboxBackend({
      engineTask: async (ctx) => {
        seen = { secret: ctx.secret, files: [...ctx.files.keys()].sort() };
        ctx.write(JSON.stringify({ t: "end", code: 0 }));
      },
    });
    const origStart = backend.start.bind(backend);
    backend.start = async (...a: Parameters<FakeSandboxBackend["start"]>) => {
      order.push("start");
      return origStart(...a);
    };
    const start: ExecutorStdioMessage = { type: "start", workload, secret: SECRET, mac: stdioFrameMac(key, offer.id, { type: "start", workload, secret: SECRET }) };
    const client = {
      accept: async () => {
        order.push("accept");
        return { offer, next: "ok" };
      },
      inputManifest: async () => {
        order.push("manifest");
        return task.manifest;
      },
      inputFile: async (_id: string, n: number) => {
        order.push(`file:${n}`);
        return task.open(n);
      },
      report: async (_id: string, signed: SignedExecutorReport) => {
        order.push("report");
        reported = signed.report;
        return { release: true, placementId: "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9", reportSha256: "a".repeat(64), next: "ok", stdioSecret: secretB64 };
      },
      stdioStream: async (_id: string, _w: number, _from: number, onMessage: (m: ExecutorStdioMessage) => Promise<void>) => {
        await onMessage(start);
        await new Promise((r) => setTimeout(r, 50));
      },
      stdioPost: async (_id: string, body: { frames: Array<{ data: string }>; eof?: boolean }) => {
        posted.push(...body.frames.map((f) => f.data));
        return { nextSeq: posted.length, closed: false };
      },
      end: async () => undefined,
      decline: async () => undefined,
    } as unknown as ExecutorClient;
    const ctx: OfferContext = {
      backend,
      credential: { identifier: "spiffe://test.example/regulait/worker_runtime/i5", signReport: async (r: ExecutorReport) => ({ report: r, signature: { protected: "a", signature: "b" } }), authorizeRequest: async () => ({}) } as unknown as OfferContext["credential"],
      client,
      profiles: new Map([[offer.profileDigest, { digest: offer.profileDigest, name: "engine-worker", version: 1, minClass: "user_space_kernel", body: ENGINE }]]),
      attestations: new Map([[offer.profileDigest, { cls: "user_space_kernel", expiresAt: new Date(Date.now() + 3_600_000).toISOString() } as never]]),
      sandboxes: new Map(),
      quarantined: () => false,
      onSignal: async () => undefined,
    };
    const out = await handleOffer(offer, ctx);
    expect(out).toMatchObject({ kind: "placed", ended: "completed" });
    // the input before the sandbox, the sandbox before the report
    // the manifest before the sandbox; every file written (inside start) before the report
    expect(order).toEqual(["accept", "manifest", "start", "file:0", "file:1", "report"]);
    expect(reported!.inputSha256).toBe(task.manifest.digest);
    expect(seen).toEqual({ secret: SECRET, files: FILES.map((f) => f.path).sort() });
    expect(backend.sandboxes[0]!.secretSha256).toBe(sha(SECRET));
    expect(posted).toEqual([JSON.stringify({ t: "end", code: 0 })]);
  });
});
