/**
 * ADR-0187 B5-M (decision 104) — the runner/scanner exchange and the scanner's self-test, with
 * modelscan replaced by a fake process (the real engine is modelscan-real.test.ts).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProcessGroupOptions, ProcessGroupResult } from "@regulait/engine-runner";
import { ExchangeScanExecutor, scannerTick } from "./exchange.js";
import { modelscanArgs, modelscanEnv } from "./scan.js";
import { judgeScannerSelfTest, SCANNER_SELF_TEST_FILE, writeScannerSelfTest } from "./selftest.js";

async function roots() {
  const root = await mkdtemp(path.join(tmpdir(), "b5m-ex-"));
  const jobs = path.join(root, "jobs");
  const results = path.join(root, "results");
  await mkdir(jobs);
  await mkdir(results);
  return { jobs, results };
}

/** a fake modelscan: writes `report` to the -o path and exits `code`; records argv, env and cwd */
function fakeRun(report: string | null, code = 0, seen: Array<{ args: readonly string[]; opts: ProcessGroupOptions }> = []) {
  return async (_cmd: string, args: readonly string[], opts: ProcessGroupOptions): Promise<ProcessGroupResult> => {
    seen.push({ args, opts });
    const out = args[args.indexOf("-o") + 1]!;
    if (report !== null) await writeFile(out, report);
    return { exitCode: code, signal: null, killed: false, stdout: "not parsed", stderr: "" };
  };
}

/** a fake modelscan that runs until it is aborted */
const hangs = async (_c: string, _a: readonly string[], opts: ProcessGroupOptions): Promise<ProcessGroupResult> =>
  new Promise((resolve) => {
    const done = () => resolve({ exitCode: null, signal: "SIGKILL", killed: true, stdout: "", stderr: "" });
    if (opts.signal?.aborted) return done();
    opts.signal?.addEventListener("abort", done, { once: true });
  });

describe("B5-M runner/scanner exchange", () => {
  it("a job goes in whole, the scanner runs modelscan from an empty working directory with fixed argv, and the runner reads the -o report", async () => {
    const { jobs, results } = await roots();
    const runner = new ExchangeScanExecutor(jobs, results, { pollMs: 10 });
    const runId = randomUUID();
    const stage = await runner.stage(runId);
    await writeFile(path.join(stage, "artifact.pkl"), "x");
    const seen: Array<{ args: readonly string[]; opts: ProcessGroupOptions }> = [];
    const scanning = runner.scan({ runId, format: "pickle", artifactName: "artifact.pkl", timeoutMs: 5000 }, new AbortController().signal);
    // until the rename, the scanner sees no job
    for (let i = 0; i < 50 && !existsSync(path.join(jobs, runId)); i++) await new Promise((r) => setTimeout(r, 10));
    expect(await scannerTick({ jobsRoot: jobs, resultsRoot: results, modelscan: { run: fakeRun('{"ok":1}', 0, seen), settingsFile: "/s.toml", modelscanBin: "/bin/ms", path: "/venv/bin" } })).toBe(1);
    const out = await scanning;
    expect(out.exitCode).toBe(0);
    expect(Buffer.from(out.report!).toString()).toBe('{"ok":1}');
    const call = seen[0]!;
    expect(call.args).toEqual(modelscanArgs(path.join(jobs, runId, "artifact.pkl"), path.join(results, runId, "report.json"), "/s.toml"));
    expect(call.args).toContain("--show-skipped");
    expect(call.opts.cwd).toBe(path.join(results, runId, "cwd"));
    expect(call.opts.env).toEqual(modelscanEnv(path.join(results, runId, "cwd"), "/venv/bin"));
    // the runner cleans its job; the scanner then drops the result
    await runner.release(runId);
    await scannerTick({ jobsRoot: jobs, resultsRoot: results });
    expect(existsSync(path.join(results, runId))).toBe(false);
  });

  it("a cancel reaches the scanner, which kills modelscan", async () => {
    const { jobs, results } = await roots();
    const runner = new ExchangeScanExecutor(jobs, results, { pollMs: 10 });
    const runId = randomUUID();
    await runner.stage(runId);
    const abort = new AbortController();
    const scanning = runner.scan({ runId, format: "pickle", artifactName: "artifact.pkl", timeoutMs: 60_000 }, abort.signal);
    for (let i = 0; i < 50 && !existsSync(path.join(jobs, runId)); i++) await new Promise((r) => setTimeout(r, 10));
    const tick = scannerTick({ jobsRoot: jobs, resultsRoot: results, pollMs: 10, modelscan: { run: hangs } });
    await new Promise((r) => setTimeout(r, 50));
    abort.abort();
    const out = await scanning;
    expect(await tick).toBe(1);
    expect(out.report).toBeNull();
    const done = JSON.parse(await readFile(path.join(results, runId, "done.json"), "utf8")) as { cancelled: boolean };
    expect(done.cancelled).toBe(true);
  });

  it("a scanner that never answers is a time-out for the runner, never a result", async () => {
    const { jobs, results } = await roots();
    const runner = new ExchangeScanExecutor(jobs, results, { pollMs: 10, graceMs: 50 });
    const runId = randomUUID();
    await runner.stage(runId);
    const out = await runner.scan({ runId, format: "pickle", artifactName: "artifact.pkl", timeoutMs: 1000 }, new AbortController().signal);
    expect(out).toMatchObject({ timedOut: true, exitCode: null, report: null });
    expect(existsSync(path.join(jobs, runId, "cancel"))).toBe(true);
  });

  it("a report that is not the one the scanner hashed is refused", async () => {
    const { jobs, results } = await roots();
    const runner = new ExchangeScanExecutor(jobs, results, { pollMs: 10 });
    const runId = randomUUID();
    await runner.stage(runId);
    const scanning = runner.scan({ runId, format: "pickle", artifactName: "artifact.pkl", timeoutMs: 5000 }, new AbortController().signal);
    for (let i = 0; i < 50 && !existsSync(path.join(jobs, runId)); i++) await new Promise((r) => setTimeout(r, 10));
    // the report is swapped after the scanner hashed it (between its two writes)
    const swapping = async (c: string, a: readonly string[], o: ProcessGroupOptions) => {
      const r = await fakeRun('{"issues":[{"os":"system"}]}', 1)(c, a, o);
      return r;
    };
    await scannerTick({ jobsRoot: jobs, resultsRoot: results, modelscan: { run: swapping } });
    await writeFile(path.join(results, runId, "report.json"), '{"issues":[]}');
    const out = await scanning;
    expect(out.exitCode).toBeNull();
    expect(out.report).toBeNull();
  });

  it("a job naming any other file, or a run id that is not a UUID, is never scanned", async () => {
    const { jobs, results } = await roots();
    const runId = randomUUID();
    await mkdir(path.join(jobs, runId));
    await writeFile(path.join(jobs, runId, "job.json"), JSON.stringify({ runId, format: "pickle", artifactName: "../../etc/passwd", timeoutMs: 5000 }));
    await mkdir(path.join(jobs, "not-a-uuid"));
    const seen: Array<{ args: readonly string[]; opts: ProcessGroupOptions }> = [];
    expect(await scannerTick({ jobsRoot: jobs, resultsRoot: results, modelscan: { run: fakeRun("{}", 0, seen) } })).toBe(0);
    expect(seen).toHaveLength(0);
    const done = JSON.parse(await readFile(path.join(results, runId, "done.json"), "utf8")) as { exitCode: number | null };
    expect(done.exitCode).toBeNull();
    expect(existsSync(path.join(results, "not-a-uuid"))).toBe(false);
  });
});

describe("B5-M scanner self-test, judged by the runner", () => {
  const unreachable = { lookup: async () => Promise.reject(Object.assign(new Error("x"), { code: "EAI_AGAIN" })), connect: async () => "denied" as const, ip: "93.184.215.14" };

  it("fresh, the pinned version and nothing reachable: isolated", async () => {
    const { results } = await roots();
    await writeScannerSelfTest(results, { modelscanVersion: "0.8.8", egress: unreachable });
    expect(await judgeScannerSelfTest(results)).toEqual({ isolated: true, failures: [] });
  });

  it("missing, stale, another version, or anything reachable: not isolated (the engine cannot be enabled)", async () => {
    const { results } = await roots();
    expect((await judgeScannerSelfTest(results)).failures).toEqual(["scanner_report_missing"]);
    await writeScannerSelfTest(results, { modelscanVersion: "0.8.8", egress: unreachable, now: new Date(Date.now() - 3 * 3600_000) });
    expect((await judgeScannerSelfTest(results)).failures).toEqual(["scanner_report_stale"]);
    await writeScannerSelfTest(results, { modelscanVersion: "0.8.9", egress: unreachable });
    expect((await judgeScannerSelfTest(results)).failures).toEqual(["scanner_version_mismatch"]);
    await writeScannerSelfTest(results, { modelscanVersion: "0.8.8", egress: { ...unreachable, connect: async () => "connected" as const } });
    expect((await judgeScannerSelfTest(results)).failures).toEqual(["scanner_connected", "scanner_address_connected"]);
    await writeScannerSelfTest(results, { modelscanVersion: "0.8.8", egress: { ...unreachable, ip: "10.0.0.1" } });
    expect((await judgeScannerSelfTest(results)).failures).toEqual(["scanner_address_missing"]);
    await writeFile(path.join(results, SCANNER_SELF_TEST_FILE), "{not json");
    expect((await judgeScannerSelfTest(results)).isolated).toBe(false);
  });
});
