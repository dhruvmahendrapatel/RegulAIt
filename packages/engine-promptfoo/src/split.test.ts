/**
 * ADR-0187 B5-P2 — the runner/worker split, without containers: the runner's side of the exchange
 * (ExchangePromptfooExecutor, used by the adapter as in the image) and the worker's side
 * (promptfooWorkerTick) on two temporary volumes, with only the promptfoo process faked.
 *
 * What is pinned (each shown red by breaking it; see ADR-0187 decisions 170 on):
 *   - the runner never runs promptfoo, and nothing of the runner's credential crosses the exchange:
 *     the job carries the run key and nothing else secret, and the worker's child environment is the
 *     allow-list (no enrolment token, no runner token) whatever the worker's own environment holds;
 *   - the worker re-checks every job (schema and the gateway-only invariant) and never starts
 *     promptfoo for one it refuses;
 *   - cancel and the deadline reach the worker; a results file that is not the one the worker
 *     hashed decides nothing;
 *   - the worker's self-test names every way the runner's credential could be in its reach, and the
 *     runner reports the manifest's worker switch true only for a clean, fresh report;
 *   - the manifest claims credential isolation for promptfoo only together with that switch.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_MANIFEST, evaluateRunnerSelfTest, PROMPTFOO_ENGINE_VERSION, type EngineLease } from "@regulait/shared";
import { FileRunnerTokenStore, generateRunnerSecret, type ProcessGroupOptions, type ProcessGroupResult } from "@regulait/engine-runner";
import { promptfooAdapter } from "./adapter.js";
import { buildPromptfooConfig, planPromptfooRun, RUN_KEY_ENV } from "./config.js";
import { DONE_FILE, ExchangePromptfooExecutor, promptfooWorkerTick, RESULTS_FILE } from "./exchange.js";
import { LocalPromptfooExecutor } from "./job.js";
import { promptfooRunnerSelfTest } from "./main.js";
import { judgeWorkerSelfTest, WORKER_ISOLATED_SWITCH, WORKER_SELF_TEST_FILE, workerCredentialReach, writeWorkerSelfTest } from "./worker-selftest.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PASS_FIXTURE = readFileSync(path.join(here, "fixtures", "results-0.123.1-pass.json"));
const GATEWAY = "http://gateway:3000/v1";
const KEY = "rglv_synthetic_engine_run_key_2222222222222222";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const DENIED = { lookup: async () => Promise.reject(Object.assign(new Error("nx"), { code: "ENOTFOUND" })), connect: async () => "denied" as const, ip: "93.184.215.14" };

function lease(over: Partial<EngineLease> = {}): EngineLease {
  return {
    runId: RUN_ID,
    engineId: "promptfoo",
    engineVersion: PROMPTFOO_ENGINE_VERSION,
    spec: { config: { sets: ["prompt-extraction", "pii:direct", "strategy:base64"], params: {} }, trials: 2 },
    target: { baseUrl: GATEWAY, model: "target-model", apiKey: KEY, headers: { "x-regulait-agent-id": "a1", "x-regulait-project-id": "p1" } },
    judge: { model: "judge-model", headers: { "x-regulait-agent-id": "j1", "x-regulait-project-id": "p1" } },
    artifacts: [],
    deadlineAt: new Date(Date.now() + 600_000).toISOString(),
    budgetUsd: 1,
    ...over,
  };
}

/** a stand-in for promptfoo: writes the file named after `-o`, records each step and its whole environment */
function fakePromptfoo(behave: { genExit?: number; results?: Buffer; waitForAbort?: boolean } = {}) {
  const calls: Array<{ step: string; env: Record<string, string>; cwd: string | undefined }> = [];
  const run = async (_cmd: string, args: readonly string[], opts: ProcessGroupOptions): Promise<ProcessGroupResult> => {
    const step = String(args[1]);
    calls.push({ step, env: { ...opts.env }, cwd: opts.cwd });
    if (behave.waitForAbort) {
      await new Promise<void>((resolve) => (opts.signal!.aborted ? resolve() : opts.signal!.addEventListener("abort", () => resolve())));
      return { exitCode: null, signal: "SIGKILL", killed: true, stdout: "", stderr: "" };
    }
    const out = args[args.indexOf("-o") + 1]!;
    if (step === "redteam") {
      if ((behave.genExit ?? 0) === 0) await writeFile(out, "tests: []");
      return { exitCode: behave.genExit ?? 0, signal: null, killed: false, stdout: "", stderr: "" };
    }
    await writeFile(out, behave.results ?? PASS_FIXTURE);
    return { exitCode: 0, signal: null, killed: false, stdout: "", stderr: "" };
  };
  return { calls, run };
}

async function volumes() {
  const root = await mkdtemp(path.join(tmpdir(), "pf-split-"));
  const v = { jobs: path.join(root, "jobs"), results: path.join(root, "results"), work: path.join(root, "worker-work"), runnerWork: path.join(root, "runner-work"), state: path.join(root, "state") };
  for (const d of Object.values(v)) await mkdir(d, { recursive: true });
  return { root, ...v };
}

/** a worker that keeps ticking until stopped (as worker-main does) */
function startWorker(v: Awaited<ReturnType<typeof volumes>>, run: ReturnType<typeof fakePromptfoo>["run"]) {
  let stop = false;
  const done = (async () => {
    while (!stop) {
      await promptfooWorkerTick({ jobsRoot: v.jobs, resultsRoot: v.results, workRoot: v.work, pollMs: 10, promptfoo: { entrypoint: "/x/entrypoint.js", run } });
      await new Promise((r) => setTimeout(r, 10));
    }
  })();
  return async () => {
    stop = true;
    await done;
  };
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) out.push(path.join(e.parentPath, e.name));
  return out;
}

const ctx = (workDir: string, signal = new AbortController().signal) => ({ workDir, signal, progress: () => undefined });

let savedEnrolment: string | undefined;
afterEach(() => {
  if (savedEnrolment === undefined) delete process.env.REGULAIT_ENGINE_ENROLLMENT_TOKEN;
  else process.env.REGULAIT_ENGINE_ENROLLMENT_TOKEN = savedEnrolment;
});

describe("B5-P2: the runner hands promptfoo to the worker", () => {
  it("the same body as in-process, the runner never runs promptfoo, and nothing of the runner's credential crosses the exchange", async () => {
    const v = await volumes();
    // the runner's credential, where the runner keeps it (its state volume)
    const token = generateRunnerSecret();
    await new FileRunnerTokenStore(path.join(v.state, "runner-token")).save(token);
    // even an enrolment token in the worker's own environment never reaches promptfoo
    savedEnrolment = process.env.REGULAIT_ENGINE_ENROLLMENT_TOKEN;
    process.env.REGULAIT_ENGINE_ENROLLMENT_TOKEN = "rgee_synthetic_enrolment_token_for_the_test";
    const worker = fakePromptfoo();
    const runnerSide = fakePromptfoo();
    const stopWorker = startWorker(v, worker.run);
    let jobSeen: string | null = null;
    const exchange = new ExchangePromptfooExecutor(v.jobs, v.results, { pollMs: 10 });
    const spy = {
      execute: async (job: Parameters<ExchangePromptfooExecutor["execute"]>[0], c: Parameters<ExchangePromptfooExecutor["execute"]>[1]) => {
        const p = exchange.execute(job, c);
        // read the published job while the worker has it
        for (let i = 0; i < 200 && jobSeen === null; i++) {
          jobSeen = await readFile(path.join(v.jobs, RUN_ID, "job.json"), "utf8").catch(() => null);
          if (jobSeen === null) await new Promise((r) => setTimeout(r, 5));
        }
        return p;
      },
      release: (id: string) => exchange.release(id),
    };
    try {
      const split = await promptfooAdapter({ entrypoint: "/x/entrypoint.js", run: runnerSide.run, executor: spy })(lease(), ctx(v.runnerWork));
      const local = await promptfooAdapter({ entrypoint: "/x/entrypoint.js", run: fakePromptfoo().run })(lease(), ctx(await mkdtemp(path.join(tmpdir(), "pf-local-"))));
      expect(split.status).toBe("completed");
      expect(split).toEqual(local);
      // the runner's side never started promptfoo; the worker ran both steps
      expect(runnerSide.calls).toEqual([]);
      expect(worker.calls.map((c) => c.step)).toEqual(["redteam", "eval"]);
      // the job is the config, the gateway URL, the RUN key and the deadline; never the runner token
      expect(jobSeen).not.toBeNull();
      expect(Object.keys(JSON.parse(jobSeen!)).sort()).toEqual(["apiKey", "baseUrl", "config", "deadlineAt", "runId"]);
      expect(JSON.parse(jobSeen!).apiKey).toBe(KEY);
      expect(jobSeen).not.toContain(token);
      // promptfoo's environment: the allow-list, the run key the only credential, its own work dir
      for (const c of worker.calls) {
        expect(c.env[RUN_KEY_ENV]).toBe(KEY);
        expect(Object.values(c.env).join("\n")).not.toContain(token);
        expect(Object.keys(c.env)).not.toContain("REGULAIT_ENGINE_ENROLLMENT_TOKEN");
        expect(Object.values(c.env).some((x) => x.startsWith("rge_") || x.startsWith("rgee_"))).toBe(false);
        expect(c.cwd!.startsWith(v.work)).toBe(true);
        expect(c.env.HOME!.startsWith(v.work)).toBe(true);
      }
      // the run is released: no job is left, and the worker drops its result
      expect(await readdir(v.jobs)).toEqual([]);
    } finally {
      await stopWorker();
    }
    // nothing anywhere in the exchange ever held the runner token
    for (const f of [...(await filesUnder(v.jobs)), ...(await filesUnder(v.results))]) expect(await readFile(f, "utf8")).not.toContain(token);
  });

  it("the worker re-checks every job: off-gateway or malformed, it is refused and promptfoo never starts", async () => {
    const v = await volumes();
    const worker = fakePromptfoo();
    const plan = planPromptfooRun(["prompt-extraction"]);
    const config = buildPromptfooConfig(lease(), plan);
    // a job whose target points off the gateway (as if the jobs volume could be written by someone else)
    const evil = JSON.parse(JSON.stringify(config)) as { targets: Array<{ config: { apiBaseUrl: string } }> };
    evil.targets[0]!.config.apiBaseUrl = "http://elsewhere.example/v1";
    const badId = "33333333-3333-4333-8333-333333333333";
    const junkId = "44444444-4444-4444-8444-444444444444";
    await mkdir(path.join(v.jobs, badId));
    await writeFile(path.join(v.jobs, badId, "job.json"), JSON.stringify({ runId: badId, baseUrl: GATEWAY, apiKey: KEY, config: evil, deadlineAt: lease().deadlineAt }));
    await mkdir(path.join(v.jobs, junkId));
    await writeFile(path.join(v.jobs, junkId, "job.json"), JSON.stringify({ runId: junkId, baseUrl: GATEWAY, apiKey: KEY, config, deadlineAt: lease().deadlineAt, runnerToken: "rge_x" }));
    expect(await promptfooWorkerTick({ jobsRoot: v.jobs, resultsRoot: v.results, workRoot: v.work, promptfoo: { entrypoint: "/x/entrypoint.js", run: worker.run } })).toBe(1);
    expect(worker.calls).toEqual([]);
    const done = async (id: string) => JSON.parse(await readFile(path.join(v.results, id, DONE_FILE), "utf8")) as { refused: string | null; generated: boolean };
    expect(await done(badId)).toMatchObject({ refused: "config_non_gateway_url", generated: false });
    expect(await done(junkId)).toMatchObject({ refused: "job_invalid", generated: false });
    // the runner maps a refusal to not_run, every planned pair reported
    const exchange = new ExchangePromptfooExecutor(v.jobs, v.results, { pollMs: 10 });
    const refusing = { execute: async () => ({ refused: "config_non_gateway_url", generateExitCode: null, generated: false, evalExitCode: null, aborted: false, results: null }), release: (id: string) => exchange.release(id) };
    const body = await promptfooAdapter({ entrypoint: "/x/entrypoint.js", executor: refusing })(lease(), ctx(v.runnerWork));
    expect(body).toMatchObject({ status: "not_run", errorCode: "config_non_gateway_url" });
    expect(body.items.every((i) => i.verdict === "not_run")).toBe(true);
  });

  it("a cancel reaches the worker: promptfoo's group is killed, the adapter throws and posts nothing", async () => {
    const v = await volumes();
    const worker = fakePromptfoo({ waitForAbort: true });
    const stopWorker = startWorker(v, worker.run);
    const abort = new AbortController();
    try {
      const pending = promptfooAdapter({ entrypoint: "/x/entrypoint.js", executor: new ExchangePromptfooExecutor(v.jobs, v.results, { pollMs: 10 }) })(lease(), ctx(v.runnerWork, abort.signal));
      for (let i = 0; i < 200 && worker.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
      expect(worker.calls.map((c) => c.step)).toEqual(["redteam"]);
      abort.abort();
      await expect(pending).rejects.toThrow(/aborted/);
      expect(await readdir(v.jobs)).toEqual([]);
    } finally {
      await stopWorker();
    }
    expect(worker.calls.map((c) => c.step)).toEqual(["redteam"]);
  });

  it("with no worker answering, the runner gives up after the deadline (never clean)", async () => {
    const v = await volumes();
    const body = promptfooAdapter({ entrypoint: "/x/entrypoint.js", executor: new ExchangePromptfooExecutor(v.jobs, v.results, { pollMs: 10, graceMs: 50 }) })(
      lease({ deadlineAt: new Date(Date.now() + 100).toISOString() }),
      ctx(v.runnerWork),
    );
    await expect(body).rejects.toThrow(/aborted/);
  });

  it("a results file that is not the one the worker hashed decides nothing: failed results_inconsistent", async () => {
    const v = await volumes();
    const plan = planPromptfooRun(["prompt-extraction", "pii:direct", "strategy:base64"]);
    expect(plan.plugins.length).toBe(2);
    // the worker answered; the file was swapped after it hashed it
    const swapped = {
      execute: async () => {
        const p = path.join(v.results, RESULTS_FILE);
        await writeFile(p, PASS_FIXTURE.toString().replace(/"pass"\s*:\s*false/g, '"pass": true'));
        return { refused: null, generateExitCode: 0, generated: true, evalExitCode: 0, aborted: false, results: { path: p, sha256: "0".repeat(64) } };
      },
      release: async () => undefined,
    };
    const body = await promptfooAdapter({ entrypoint: "/x/entrypoint.js", executor: swapped })(lease(), ctx(v.runnerWork));
    expect(body).toMatchObject({ status: "failed", errorCode: "results_inconsistent" });
    expect(body.items.every((i) => i.verdict === "not_run")).toBe(true);
  });

  it("a crashed runner's jobs are reconciled; the worker drops results whose job is gone", async () => {
    const v = await volumes();
    const ex = new ExchangePromptfooExecutor(v.jobs, v.results);
    const a = "55555555-5555-4555-8555-555555555555";
    await mkdir(path.join(v.jobs, `${a}.staging`));
    await mkdir(path.join(v.jobs, RUN_ID));
    await mkdir(path.join(v.results, a));
    expect((await ex.reconcile(null)).sort()).toEqual([RUN_ID, `${a}.staging`].sort());
    await promptfooWorkerTick({ jobsRoot: v.jobs, resultsRoot: v.results, workRoot: v.work, promptfoo: { entrypoint: "/x/entrypoint.js", run: fakePromptfoo().run } });
    expect(await readdir(v.results)).toEqual([]);
  });

  it("the local executor is the in-process path the tests use; the image's runner uses only the exchange", () => {
    const main = readFileSync(path.join(here, "main.ts"), "utf8");
    expect(main).toMatch(/new ExchangePromptfooExecutor\(/);
    expect(main).toMatch(/promptfooAdapter\(\{ entrypoint: `\$\{PROMPTFOO_HOME\}\/dist\/src\/entrypoint\.js`, executor \}\)/);
    expect(main).not.toMatch(/LocalPromptfooExecutor|runProcessGroup|runPromptfooJob/);
    expect(new LocalPromptfooExecutor({ entrypoint: "/x" })).toBeInstanceOf(LocalPromptfooExecutor);
  });
});

describe("B5-P2: the worker proves the runner's credential is out of its reach", () => {
  async function fakeProc(cmdlines: Record<string, string[]>) {
    const proc = await mkdtemp(path.join(tmpdir(), "pf-proc-"));
    for (const [pid, argv] of Object.entries(cmdlines)) {
      await mkdir(path.join(proc, pid));
      await writeFile(path.join(proc, pid, "cmdline"), argv.join("\0") + "\0");
    }
    return proc;
  }

  it("a clean worker: nothing in reach, the report is judged isolated and the runner reports the switch", async () => {
    const v = await volumes();
    const proc = await fakeProc({ "1": ["node", "/app/dist/worker-main.js"], "7": ["node", "/opt/promptfoo/node_modules/promptfoo/dist/src/entrypoint.js", "eval"] });
    const reach = { env: { PATH: "/usr/bin", REGULAIT_PROMPTFOO_JOBS_DIR: "/jobs" }, stateDir: v.state, procRoot: proc, selfPid: 1 };
    expect(await workerCredentialReach(reach)).toEqual({ credentialEnv: [], stateEntries: 0, runnerProcessVisible: false });
    await writeWorkerSelfTest(v.results, { promptfooVersion: PROMPTFOO_ENGINE_VERSION, egress: DENIED, reach });
    expect(await judgeWorkerSelfTest(v.results)).toEqual({ isolated: true, failures: [] });
    const st = await promptfooRunnerSelfTest({ imageDigest: `sha256:${"a".repeat(64)}`, engineVersion: PROMPTFOO_ENGINE_VERSION, resultsRoot: v.results, env: { ...ENGINE_MANIFEST.promptfoo.usageDataEnv, REGULAIT_EGRESS_PROBE_ADDRESS: "93.184.215.14" } });
    expect(st.usageDataEnv[WORKER_ISOLATED_SWITCH]).toBe(true);
  });

  it("each way the credential could be in reach is named, and the switch is false", async () => {
    const v = await volumes();
    // the runner's state volume mounted here too
    await new FileRunnerTokenStore(path.join(v.state, "runner-token")).save(generateRunnerSecret());
    // the runner's process visible (a shared PID namespace)
    const proc = await fakeProc({ "1": ["node", "/app/dist/worker-main.js"], "9": ["node", "/app/dist/main.js"] });
    const env = { PATH: "/usr/bin", REGULAIT_ENGINE_ENROLLMENT_TOKEN: "", LEAKED: generateRunnerSecret() };
    const reach = await workerCredentialReach({ env, stateDir: v.state, procRoot: proc, selfPid: 1 });
    expect(reach.credentialEnv.sort()).toEqual(["LEAKED", "REGULAIT_ENGINE_ENROLLMENT_TOKEN"]);
    expect(reach.stateEntries).toBeGreaterThan(0);
    expect(reach.runnerProcessVisible).toBe(true);
    await writeWorkerSelfTest(v.results, { promptfooVersion: PROMPTFOO_ENGINE_VERSION, egress: DENIED, reach: { env, stateDir: v.state, procRoot: proc, selfPid: 1 } });
    expect((await judgeWorkerSelfTest(v.results)).failures).toEqual(["worker_credential_in_env", "worker_runner_state_reachable", "worker_runner_process_visible"]);
    const st = await promptfooRunnerSelfTest({ imageDigest: `sha256:${"a".repeat(64)}`, engineVersion: PROMPTFOO_ENGINE_VERSION, resultsRoot: v.results });
    expect(st.usageDataEnv[WORKER_ISOLATED_SWITCH]).toBe(false);
  });

  it("an unreadable state directory, a missing, stale, other-version or reaching report all fail closed", async () => {
    const v = await volumes();
    const proc = await fakeProc({ "1": ["node", "/app/dist/worker-main.js"] });
    expect((await workerCredentialReach({ env: {}, stateDir: path.join(v.root, "nope"), procRoot: proc, selfPid: 1 })).stateEntries).toBe(0);
    const notADir = path.join(v.root, "file");
    await writeFile(notADir, "x");
    expect((await workerCredentialReach({ env: {}, stateDir: notADir, procRoot: proc, selfPid: 1 })).stateEntries).toBe(-1);
    expect(await judgeWorkerSelfTest(v.results)).toEqual({ isolated: false, failures: ["worker_report_missing"] });
    const reach = { env: {}, stateDir: v.state, procRoot: proc, selfPid: 1 };
    await writeWorkerSelfTest(v.results, { promptfooVersion: PROMPTFOO_ENGINE_VERSION, egress: DENIED, reach, now: new Date(Date.now() - 3 * 3600 * 1000) });
    expect((await judgeWorkerSelfTest(v.results)).failures).toEqual(["worker_report_stale"]);
    await writeWorkerSelfTest(v.results, { promptfooVersion: "0.0.1", egress: { ...DENIED, connect: async () => "connected" as const }, reach });
    expect((await judgeWorkerSelfTest(v.results)).failures).toEqual(["worker_version_mismatch", "worker_connected", "worker_address_connected"]);
    await writeFile(path.join(v.results, WORKER_SELF_TEST_FILE), JSON.stringify({ at: new Date().toISOString() }));
    expect((await judgeWorkerSelfTest(v.results)).failures).toEqual(["worker_report_invalid"]);
  });

  it("the manifest claims credential isolation for promptfoo, and a self-test without the worker's proof cannot pass", async () => {
    const m = { ...ENGINE_MANIFEST.promptfoo, imageDigest: `sha256:${"a".repeat(64)}` };
    expect(ENGINE_MANIFEST.promptfoo.credentialIsolation).toBe(true);
    expect(m.usageDataEnv[WORKER_ISOLATED_SWITCH]).toBe("1");
    const v = await volumes();
    const env = { ...ENGINE_MANIFEST.promptfoo.usageDataEnv };
    const without = await promptfooRunnerSelfTest({ imageDigest: m.imageDigest, engineVersion: m.version, resultsRoot: v.results, env });
    const verdict = evaluateRunnerSelfTest(m, { ...without, egress: { host: "example.com", dnsResolved: false, connected: false, address: "93.184.215.14", addressConnected: false } }, new Date());
    expect(verdict.failures).toEqual([`usage_env_missing:${WORKER_ISOLATED_SWITCH}`]);
  });
});
