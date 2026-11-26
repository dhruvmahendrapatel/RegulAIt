/**
 * ADR-0346 — the fairlearn shim with a fake gateway (a real local HTTP server) and a stand-in metric step (a node
 * script on the same stdin/stdout contract as engines/fairlearn/fairlearn_metrics.py): the plan, the job, the task's
 * calls and mapping, suppression, the exchange (the runner's bounded, hashed, schema-checked read) and the adapter.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ENGINE_MANIFEST,
  engineResultEnvelopeSchema,
  FAIRLEARN_INPUT_FILE,
  FAIRLEARN_INPUT_VERSION,
  FAIRLEARN_LIMITS,
  FAIRLEARN_SET,
  FAIRLEARN_USAGE_DATA_ENV,
  FAIRLEARN_WORKER_SELF_TEST_SWITCH,
  fairlearnResultSchema,
  type EngineLease,
  type FairlearnInput,
} from "@regulait/shared";
import { fairlearnAdapter, fairlearnItemKey } from "./adapter.js";
import { checkFairlearnTarget, FAIRLEARN_GATEWAY_INPUT_MARKER, FAIRLEARN_METRICS_BOOT, fairlearnChatUrl, fairlearnMetricsArgs, fairlearnMetricsEnv, FairlearnConfigRefused, planFairlearnRun } from "./config.js";
import { collectFairlearnResult, ExchangeFairlearnExecutor, FAIRLEARN_DONE_FILE, FAIRLEARN_RESULT_FILE, type FairlearnJob } from "./exchange.js";
import type { MetricsCommand } from "./metrics.js";
import { judgeWorkerSelfTest, WORKER_SELF_TEST_FILE } from "./selftest.js";
import { fairlearnKeptRows, runFairlearnJob, runFairlearnTaskWork } from "./worker.js";

const RUN = "11111111-2222-4333-8444-555555555555";
const EVAL = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const KEY = "rglv_synthetic_key";
const HEADERS = { "x-regulait-agent": "a1", "x-regulait-project": "p1" };
/** a reply the mapping cannot parse; it must never appear in any file the task or the runner writes */
const STRAY = "MODEL-TEXT-THAT-MUST-NOT-LEAK";
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

let root: string;
let server: Server;
let baseUrl: string;
let calls: Array<{ path: string; headers: Record<string, unknown>; body: Record<string, unknown> }>;
/** how the fake gateway answers row i: a reply text, or a status */
let answer: (i: number) => { reply: string } | { status: number } | { hang: true };

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fairlearn-"));
  calls = [];
  answer = (i) => ({ reply: i % 2 === 0 ? " Approve " : "DENY" });
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: Array<{ content: string }> };
      calls.push({ path: req.url ?? "", headers: req.headers, body });
      const i = Number(/^row (\d+)$/.exec(body.messages[0]!.content)![1]);
      const a = answer(i);
      if ("hang" in a) return; // never answered (the call's own limit or a cancel ends it)
      if ("status" in a) {
        res.statusCode = a.status;
        return res.end("{}");
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "c", choices: [{ index: 0, message: { role: "assistant", content: a.reply } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(root, { recursive: true, force: true });
});

/** 80 rows: "group" A/B by parity of i div 2, "age band" X/Y by halves; labels alternate */
function input(over: Partial<FairlearnInput> = {}, n = 80): FairlearnInput {
  const idx = [...Array(n).keys()];
  return {
    v: FAIRLEARN_INPUT_VERSION,
    runId: RUN,
    evaluationId: EVAL,
    prompts: idx.map((i) => `row ${i}`),
    labels: idx.map((i) => ((i % 3 === 0 ? 1 : 0) as 0 | 1)),
    attributes: { group: idx.map((i) => (Math.floor(i / 2) % 2 === 0 ? "A" : "B")), "age band": idx.map((i) => (i < n / 2 ? "X" : "Y")) },
    outputs: { favourable: "approve", unfavourable: "deny" },
    minGroupSize: 30,
    ...over,
  };
}
const job = (over: Partial<FairlearnJob> = {}): FairlearnJob => ({ runId: RUN, evaluationId: EVAL, target: { baseUrl, model: "m1", headers: { ...HEADERS } }, apiKey: KEY, timeoutMs: 60_000, ...over });

/** the metric stand-in: records its stdin and environment, answers per the mode */
async function fakeMetrics(mode: "ok" | "crash" | "missing_attribute" | "garbage" = "ok"): Promise<MetricsCommand & { seen: string }> {
  const dir = path.join(root, "metrics");
  await mkdir(dir, { recursive: true });
  const seen = path.join(dir, "stdin.json");
  const script = path.join(dir, "fake.mjs");
  await writeFile(
    script,
    `import { readFileSync, writeFileSync } from "node:fs";
const input = readFileSync(process.argv[2], "utf8");
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ input: JSON.parse(input), env: process.env }));
const mode = ${JSON.stringify(mode)};
if (mode === "crash") process.exit(3);
if (mode === "garbage") { process.stdout.write("not json"); process.exit(0); }
const names = Object.keys(JSON.parse(input).attributes);
const v = { demographic_parity_difference: 0.1, disparate_impact_ratio: 0.8, equal_opportunity_difference: 0.05, equalized_odds_difference: null };
const attributes = Object.fromEntries((mode === "missing_attribute" ? names.slice(1) : names).map((n) => [n, v]));
process.stdout.write(JSON.stringify({ fairlearn: "0.15.0", attributes }));
`,
  );
  // node <rows file> <script>: the stand-in is the boot's last argument, so it runs as node's script with the rows file before it
  return { command: process.execPath, args: [script], script, env: fairlearnMetricsEnv(path.dirname(process.execPath)), seen };
}
const seenBy = async (m: { seen: string }) => JSON.parse(await readFile(m.seen, "utf8")) as { input: { labels: number[]; predictions: number[]; attributes: Record<string, string[]> }; env: Record<string, string> };

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(p)));
    else out.push(p);
  }
  return out;
}

describe("ADR-0346 the plan and the job", () => {
  it("one set and one evaluationId param, or not run", () => {
    expect(planFairlearnRun({ sets: [FAIRLEARN_SET], params: { evaluationId: EVAL } })).toEqual({ evaluationId: EVAL, problem: null });
    expect(planFairlearnRun({ sets: [FAIRLEARN_SET, "x"], params: { evaluationId: EVAL } }).problem).not.toBeNull();
    expect(planFairlearnRun({ sets: [FAIRLEARN_SET], params: { evaluationId: EVAL, judge: "x" } }).problem).not.toBeNull();
    expect(planFairlearnRun({ sets: [FAIRLEARN_SET] }).problem).not.toBeNull();
  });
  it("the target is the gateway with its own headers only; the metric step is isolated with PATH and the switches only", () => {
    expect(fairlearnChatUrl("http://g/v1//")).toBe("http://g/v1/chat/completions");
    const refused = (t: Parameters<typeof checkFairlearnTarget>[0]) => {
      try {
        checkFairlearnTarget(t);
        return null;
      } catch (e) {
        return e instanceof FairlearnConfigRefused ? e.code : "other";
      }
    };
    expect(refused({ baseUrl, model: "m1", headers: HEADERS })).toBeNull();
    expect(refused({ baseUrl, model: "m1", headers: { "openai-organization": "x" } })).toBe("header_invalid");
    expect(refused({ baseUrl, model: "m1", headers: { "x-regulait-agent": "https://evil" } })).toBe("header_invalid");
    expect(refused({ baseUrl: "http://u:p@g/v1", model: "m1", headers: {} })).toBe("gateway_url_invalid");
    expect(refused({ baseUrl: "file:///etc", model: "m1", headers: {} })).toBe("gateway_url_invalid");
    expect(refused({ baseUrl, model: "has space", headers: {} })).toBe("model_invalid");
    expect(fairlearnMetricsArgs()).toEqual(["-I", "-B", "-c", FAIRLEARN_METRICS_BOOT]);
    expect(Object.keys(fairlearnMetricsEnv()).sort()).toEqual(["PATH", ...Object.keys(FAIRLEARN_USAGE_DATA_ENV)].sort());
    expect(ENGINE_MANIFEST.fairlearn.usageDataEnv).toEqual({ ...FAIRLEARN_USAGE_DATA_ENV, [FAIRLEARN_WORKER_SELF_TEST_SWITCH]: "1" });
  });
});

describe("ADR-0346 the task's work", () => {
  it("happy path: one gateway call per prompt with the run's key, exact mapping, fairlearn's values for the kept rows", async () => {
    const metrics = await fakeMetrics();
    const bytes = Buffer.from(JSON.stringify(input()));
    const r = await runFairlearnJob(job(), bytes, new AbortController().signal, { scratch: root, metrics });
    expect(fairlearnResultSchema.safeParse(r).success).toBe(true);
    expect(r.problem).toBeNull();
    expect(r.inputSha256).toBe(sha(bytes));
    expect(r.predictions).toEqual([...Array(80).keys()].map((i) => (i % 2 === 0 ? 1 : 0)));
    expect(r.fairlearn).toBe("0.15.0");
    expect(Object.keys(r.metrics!).sort()).toEqual(["age band", "group"]);
    expect(calls.length).toBe(80);
    const c = calls[0]!;
    expect(c.path).toBe("/v1/chat/completions");
    expect(c.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(c.headers["x-regulait-agent"]).toBe("a1");
    expect(c.body).toEqual({ model: "m1", messages: [{ role: "user", content: "row 0" }], max_tokens: FAIRLEARN_LIMITS.maxTokens, temperature: 0, stream: false });
    // the metric step got exactly the kept rows, and an environment of PATH and the switches only
    const seen = await seenBy(metrics);
    expect(seen.input.labels.length).toBe(80);
    for (const [k, v] of Object.entries(FAIRLEARN_USAGE_DATA_ENV)) expect(seen.env[k]).toBe(v);
    expect(Object.keys(seen.env).sort()).toEqual(["PATH", ...Object.keys(FAIRLEARN_USAGE_DATA_ENV)].sort());
  });

  it("unparseable replies are null predictions and leave the computation; too few left is too_few_parseable", async () => {
    const metrics = await fakeMetrics();
    // rows 0..3 unparseable: still 38 per group, so the metrics run on 76 rows
    answer = (i) => ({ reply: i < 4 ? STRAY : i % 2 === 0 ? "approve" : "deny" });
    const r = await runFairlearnJob(job(), Buffer.from(JSON.stringify(input())), new AbortController().signal, { scratch: root, metrics });
    expect(r.problem).toBeNull();
    expect(r.predictions.slice(0, 5)).toEqual([null, null, null, null, 1]);
    expect((await seenBy(metrics)).input.labels.length).toBe(76);
    // a reply over the bound is unparseable without being read further
    answer = (i) => ({ reply: i === 4 ? `approve${" ".repeat(FAIRLEARN_LIMITS.maxReplyChars)}` : "approve" });
    calls = [];
    const long = await runFairlearnJob(job(), Buffer.from(JSON.stringify(input())), new AbortController().signal, { scratch: root, metrics });
    expect(long.predictions[4]).toBeNull();
    // every reply unparseable: nothing to measure, the metric step never starts
    const none = await fakeMetrics();
    await rm(none.seen, { force: true });
    answer = () => ({ reply: STRAY });
    const r2 = await runFairlearnJob(job(), Buffer.from(JSON.stringify(input())), new AbortController().signal, { scratch: root, metrics: none });
    expect(r2.problem).toBe("too_few_parseable");
    expect(r2.predictions.every((p) => p === null)).toBe(true);
    expect(r2.fairlearn).toBeNull();
    expect(r2.metrics).toBeNull();
    expect(existsSync(none.seen)).toBe(false);
  });

  it("small groups are suppressed as the gateway does: one group left of an attribute is too_few_parseable", () => {
    const one = input();
    const i = { ...one, attributes: { group: one.attributes.group! } };
    // group A has 40 rows; drop 11 of them to 29 (below 30): A goes, so "group" has one group left
    const preds = i.prompts.map((_, n) => (Math.floor(n / 2) % 2 === 0 && n < 22 ? null : 1)) as Array<0 | 1 | null>;
    const k = fairlearnKeptRows(i, preds);
    expect(k.enough).toBe(false);
    expect(new Set(k.rows.attributes.group)).toEqual(new Set(["B"]));
    expect(k.rows.labels.length).toBe(40);
    expect(fairlearnKeptRows(i, i.prompts.map(() => 1)).enough).toBe(true);
    // with a second attribute the removal cascades (X loses 11 rows to 29, so X goes too), exactly as the gateway's
    const both = fairlearnKeptRows(one, preds);
    expect(both.enough).toBe(false);
    expect(both.rows.labels.length).toBe(0);
  });

  it("a budget refusal stops the run (budget_exhausted); another refusal is gateway_refused; a 5xx leaves the row unanswered", async () => {
    answer = (i) => (i === 5 ? { status: 402 } : { reply: "approve" });
    const r = await runFairlearnJob(job(), Buffer.from(JSON.stringify(input())), new AbortController().signal, { scratch: root, metrics: await fakeMetrics() });
    expect(r.problem).toBe("budget_exhausted");
    expect(calls.length).toBe(6);
    expect(r.predictions.slice(0, 6)).toEqual([1, 1, 1, 1, 1, null]);
    expect(r.metrics).toBeNull();
    calls = [];
    answer = (i) => (i === 2 ? { status: 429 } : { reply: "approve" });
    expect((await runFairlearnJob(job(), Buffer.from(JSON.stringify(input())), new AbortController().signal, { scratch: root })).problem).toBe("budget_exhausted");
    calls = [];
    answer = (i) => (i === 0 ? { status: 403 } : { reply: "approve" });
    const refused = await runFairlearnJob(job(), Buffer.from(JSON.stringify(input())), new AbortController().signal, { scratch: root });
    expect(refused.problem).toBe("gateway_refused");
    expect(calls.length).toBe(1);
    calls = [];
    answer = (i) => (i === 0 ? { status: 502 } : { reply: i % 2 === 0 ? "approve" : "deny" });
    const flaky = await runFairlearnJob(job(), Buffer.from(JSON.stringify(input())), new AbortController().signal, { scratch: root, metrics: await fakeMetrics() });
    expect(flaky.problem).toBeNull();
    expect(flaky.predictions[0]).toBeNull();
  });

  it("a cancel stops the calls (cancelled), with the predictions so far", async () => {
    const abort = new AbortController();
    answer = (i) => {
      if (i === 3) {
        abort.abort();
        return { hang: true };
      }
      return { reply: "deny" };
    };
    const r = await runFairlearnJob(job(), Buffer.from(JSON.stringify(input())), abort.signal, { scratch: root });
    expect(r.problem).toBe("cancelled");
    expect(r.predictions.slice(0, 4)).toEqual([0, 0, 0, null]);
    expect(calls.length).toBe(4);
  });

  it("an input for another run or evaluation, or one that is not the contract, is input_invalid and nothing is called", async () => {
    for (const bad of [
      JSON.stringify(input({ runId: "99999999-2222-4333-8444-555555555555" })),
      JSON.stringify(input({ evaluationId: "99999999-7777-4888-8999-aaaaaaaaaaaa" })),
      JSON.stringify({ ...input(), extra: 1 }),
      JSON.stringify(input({ minGroupSize: 5 })),
      "not json",
    ]) {
      const r = await runFairlearnJob(job(), Buffer.from(bad), new AbortController().signal, { scratch: root });
      expect(r.problem).toBe("input_invalid");
      expect(r.inputSha256).toBe(sha(bad));
      expect(r.predictions).toEqual([]);
    }
    expect(calls.length).toBe(0);
  });

  it("a metric step that fails, or answers for other attributes, is metrics_failed (never values)", async () => {
    for (const mode of ["crash", "missing_attribute", "garbage"] as const) {
      const r = await runFairlearnJob(job(), Buffer.from(JSON.stringify(input())), new AbortController().signal, { scratch: root, metrics: await fakeMetrics(mode) });
      expect(r.problem, mode).toBe("metrics_failed");
      expect(r.metrics).toBeNull();
      expect(r.predictions.length).toBe(80);
    }
  });
});

describe("ADR-0346 the exchange and the adapter", () => {
  const lease = (over: Partial<EngineLease> = {}): EngineLease => ({
    runId: RUN,
    engineId: "fairlearn",
    engineVersion: "0.15.0",
    spec: { config: { sets: [FAIRLEARN_SET], params: { evaluationId: EVAL } }, trials: 1 },
    target: { baseUrl, model: "m1", apiKey: KEY, headers: { ...HEADERS } },
    judge: null,
    artifacts: [],
    deadlineAt: new Date(Date.now() + 120_000).toISOString(),
    budgetUsd: null,
    ...over,
  });
  const ctx = (signal = new AbortController().signal) => ({ workDir: path.join(root, "w"), signal, progress: () => undefined });

  /** the bridge's part, in-process: when the job appears, the task runs against it with the gateway's file at the input root */
  async function simulateTask(dirs: { jobs: string; results: string; input: string }, metrics: MetricsCommand, placed: string | null = JSON.stringify(input())) {
    const jobDir = path.join(dirs.jobs, RUN);
    for (let i = 0; i < 400 && !existsSync(path.join(jobDir, "job.json")); i++) await new Promise((r) => setTimeout(r, 10));
    // the runner asked for the gateway's file, and holds no row itself
    expect(JSON.parse(await readFile(path.join(jobDir, FAIRLEARN_GATEWAY_INPUT_MARKER), "utf8"))).toEqual({ path: FAIRLEARN_INPUT_FILE });
    expect((await readdir(jobDir)).sort()).toEqual([FAIRLEARN_GATEWAY_INPUT_MARKER, "job.json"]);
    const j = JSON.parse(await readFile(path.join(jobDir, "job.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(j).sort()).toEqual(["apiKey", "evaluationId", "runId", "target", "timeoutMs"]);
    await mkdir(dirs.input, { recursive: true });
    if (placed !== null) await writeFile(path.join(dirs.input, FAIRLEARN_INPUT_FILE), placed);
    await runFairlearnTaskWork({ runId: RUN, jobsRoot: dirs.jobs, inputRoot: dirs.input, resultsRoot: dirs.results, workRoot: path.join(root, "work"), pollMs: 20, work: { metrics } });
  }
  async function exchangeDirs() {
    const dirs = { jobs: path.join(root, "jobs"), results: path.join(root, "results"), input: path.join(root, "input") };
    await mkdir(dirs.jobs, { recursive: true });
    await mkdir(dirs.results, { recursive: true });
    return dirs;
  }

  it("end to end: completed, one bookkeeping item per attribute, the result as the raw report, no reply text anywhere", async () => {
    answer = (i) => ({ reply: i === 7 ? STRAY : i % 2 === 0 ? "approve" : "deny" });
    const dirs = await exchangeDirs();
    const metrics = await fakeMetrics();
    const executor = new ExchangeFairlearnExecutor(dirs.jobs, dirs.results, { pollMs: 20 });
    const [body] = await Promise.all([fairlearnAdapter({ executor })(lease(), ctx()), simulateTask(dirs, metrics)]);
    const env = engineResultEnvelopeSchema.parse({ version: "regulait.engine-result.v1", runId: RUN, engineId: "fairlearn", engineVersion: "0.15.0", ...body });
    expect(env.status).toBe("completed");
    expect(env.items.map((i) => i.key)).toEqual([fairlearnItemKey(0), fairlearnItemKey(1)]);
    for (const it of env.items) {
      expect(it).toMatchObject({ sourceTaxonomy: { system: "fairlearn", id: FAIRLEARN_SET }, mappedClass: null, severity: "low", attempts: 0, defeated: 0, verdict: "unknown", reason: null, dispatchAuditIds: [] });
    }
    const raw = Buffer.from(env.rawReport!.contentBase64!, "base64");
    expect(sha(raw)).toBe(env.rawReport!.sha256);
    expect(raw.length).toBe(env.rawReport!.bytes);
    const result = fairlearnResultSchema.parse(JSON.parse(raw.toString("utf8")));
    expect(result.predictions[7]).toBeNull();
    expect(result.inputSha256).toBe(sha(JSON.stringify(input())));
    expect(JSON.stringify(body)).not.toContain(STRAY);
    // the job (with the key) is gone, and nothing the task or the runner left holds a reply's text
    expect(existsSync(path.join(dirs.jobs, RUN))).toBe(false);
    for (const f of await filesUnder(root)) {
      // the stand-in's own record and the gateway's input (which names the outputs) are the test's, not the shim's
      if (f.startsWith(path.join(root, "metrics")) || f.startsWith(dirs.input)) continue;
      const text = await readFile(f, "utf8");
      expect(text, f).not.toContain(STRAY);
      expect(text, f).not.toContain("approve");
    }
  });

  it("the gateway's file missing from the task input: failed (input_unreadable), nothing called", async () => {
    const dirs = await exchangeDirs();
    const executor = new ExchangeFairlearnExecutor(dirs.jobs, dirs.results, { pollMs: 20 });
    const [body] = await Promise.all([fairlearnAdapter({ executor })(lease(), ctx()), simulateTask(dirs, await fakeMetrics(), null)]);
    expect(body).toMatchObject({ status: "failed", errorCode: "input_unreadable", items: [], rawReport: null });
    expect(calls.length).toBe(0);
  });

  it("a config the contract refuses, or no target, is not_run and publishes no job", async () => {
    const dirs = await exchangeDirs();
    const executor = new ExchangeFairlearnExecutor(dirs.jobs, dirs.results, { pollMs: 20 });
    const a = fairlearnAdapter({ executor });
    expect(await a(lease({ spec: { config: { sets: [FAIRLEARN_SET], params: {} }, trials: 1 } }), ctx())).toMatchObject({ status: "not_run", errorCode: "config_invalid", notRun: [{ key: FAIRLEARN_SET, reason: "engine_error" }] });
    expect(await a(lease({ target: null }), ctx())).toMatchObject({ status: "not_run", errorCode: "target_required" });
    expect(await a(lease({ target: { baseUrl, model: "m1", apiKey: KEY, headers: { authorization: "x" } } }), ctx())).toMatchObject({ status: "not_run", errorCode: "header_invalid" });
    expect(await readdir(dirs.jobs)).toEqual([]);
  });

  it("a cancel throws (the runner core reports it) and the job is removed", async () => {
    const dirs = await exchangeDirs();
    const executor = new ExchangeFairlearnExecutor(dirs.jobs, dirs.results, { pollMs: 20, cancelGraceMs: 100 });
    const abort = new AbortController();
    const p = fairlearnAdapter({ executor })(lease(), ctx(abort.signal));
    for (let i = 0; i < 200 && !existsSync(path.join(dirs.jobs, RUN)); i++) await new Promise((r) => setTimeout(r, 10));
    abort.abort();
    await expect(p).rejects.toThrow("cancelled");
    expect(existsSync(path.join(dirs.jobs, RUN))).toBe(false);
  });

  it("the runner refuses a result that is oversize, not the hashed file, not the schema, or another run's", async () => {
    const dir = path.join(root, "r", RUN);
    await mkdir(dir, { recursive: true });
    const good = { v: "regulait.fairness-result.v1", runId: RUN, evaluationId: EVAL, inputSha256: sha("x"), predictions: [1, 0, null], fairlearn: null, metrics: null, problem: "too_few_parseable" };
    const put = async (content: string, announced = sha(content)) => {
      await writeFile(path.join(dir, FAIRLEARN_RESULT_FILE), content);
      await writeFile(path.join(dir, FAIRLEARN_DONE_FILE), JSON.stringify({ resultSha256: announced, error: null }));
      return collectFairlearnResult(path.join(root, "r"), { runId: RUN, evaluationId: EVAL });
    };
    expect((await put(JSON.stringify(good))).kind).toBe("result");
    expect(await put(JSON.stringify(good), sha("other"))).toEqual({ kind: "unreadable", errorCode: "result_mismatch" });
    expect(await put(JSON.stringify({ ...good, reply: "x" }))).toEqual({ kind: "unreadable", errorCode: "result_invalid" });
    expect(await put(JSON.stringify({ ...good, predictions: [2] }))).toEqual({ kind: "unreadable", errorCode: "result_invalid" });
    expect(await put(JSON.stringify({ ...good, evaluationId: "99999999-7777-4888-8999-aaaaaaaaaaaa" }))).toEqual({ kind: "unreadable", errorCode: "result_not_this_run" });
    const big = JSON.stringify(good) + " ".repeat(FAIRLEARN_LIMITS.maxResultBytes);
    expect(await put(big)).toEqual({ kind: "unreadable", errorCode: "result_too_large" });
    expect((await stat(path.join(dir, FAIRLEARN_RESULT_FILE))).size).toBeGreaterThan(FAIRLEARN_LIMITS.maxResultBytes);
    await writeFile(path.join(dir, FAIRLEARN_DONE_FILE), JSON.stringify({ resultSha256: null, error: null }));
    expect(await collectFairlearnResult(path.join(root, "r"), { runId: RUN, evaluationId: EVAL })).toEqual({ kind: "unreadable", errorCode: "done_invalid" });
  });
});

describe("ADR-0346 the worker's self-test, judged by the runner", () => {
  const egress = { host: "example.com", dnsResolved: false, connected: false, address: "93.184.215.14", addressConnected: false };
  const report = (over: Record<string, unknown> = {}) => ({
    at: new Date().toISOString(),
    fairlearnVersion: "0.15.0",
    usageDataEnv: Object.fromEntries(Object.keys(FAIRLEARN_USAGE_DATA_ENV).map((k) => [k, true])),
    runnerCredentialVisible: false,
    egress,
    ...over,
  });
  it("passes only when fresh, pinned, every switch set and the sandbox reached nothing", async () => {
    const put = async (r: unknown) => {
      await writeFile(path.join(root, WORKER_SELF_TEST_FILE), JSON.stringify(r));
      return judgeWorkerSelfTest(root);
    };
    expect((await put(report())).passed).toBe(true);
    expect((await put(report({ fairlearnVersion: "0.14.0" }))).failures).toContain("worker_version_mismatch");
    expect((await put(report({ at: new Date(Date.now() - 3 * 3600_000).toISOString() }))).failures).toContain("worker_report_stale");
    expect((await put(report({ egress: { ...egress, connected: true } }))).failures).toContain("worker_connected");
    expect((await put(report({ runnerCredentialVisible: true }))).failures).toContain("worker_sees_runner_credential");
    expect((await put(report({ usageDataEnv: { OTEL_SDK_DISABLED: true } }))).failures).toContain("worker_switch_missing:DO_NOT_TRACK");
    expect((await put({ ...report(), extra: 1 })).failures).toEqual(["worker_report_invalid"]);
    await rm(path.join(root, WORKER_SELF_TEST_FILE));
    expect((await judgeWorkerSelfTest(root)).failures).toEqual(["worker_report_missing"]);
  });
});
