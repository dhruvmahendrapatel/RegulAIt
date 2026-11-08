/**
 * ADR-0245 — the spikee shim, with a stand-in for spikee (no Python): the plan, the gateway-only invariant, the
 * selection, the mapper (spikee's exit code decides nothing), the per-dataset run, the exchange and the adapter.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProcessGroupOptions, ProcessGroupResult } from "@regulait/engine-runner/worker";
import { ENGINE_MANIFEST, engineResultEnvelopeSchema, SPIKEE_DATASET_GENERATION, SPIKEE_SETS, SPIKEE_USAGE_DATA_ENV, type EngineLease } from "@regulait/shared";
import { spikeeAdapter } from "./adapter.js";
import {
  assertGatewayOnly,
  buildSpikeeEnv,
  buildSpikeeTargetConfig,
  planSpikeeRun,
  SPIKEE_BOOT,
  SPIKEE_KEY_ENV,
  SpikeeConfigRefused,
  spikeeChatUrl,
  spikeeGenerateArgs,
  spikeeTestArgs,
} from "./config.js";
import { ExchangeSpikeeExecutor, spikeeJobSchema, type SpikeeJob } from "./exchange.js";
import { mapSpikeeRun, readSpikeeDataset, type SpikeeDatasetOutcome } from "./mapper.js";
import { runSpikeeDataset, selectSpikeeEntries } from "./spikee-run.js";
import { SPIKEE_TARGET_MODULE } from "./target-module.js";
import { LocalSpikeeExecutor, workerTick } from "./worker.js";
import { judgeWorkerSelfTest, spikeeRunnerSelfTest, writeWorkerSelfTest } from "./selftest.js";

const BASE = "http://gateway:8080/v1";
const HEADERS = { "x-regulait-agent-id": "a1", "x-regulait-project-id": "p1" };
const KEY = "rglv_synthetic";
const SEEDS = "/seeds";
const MINI = "dataset:mini-test";
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const enc = (s: string) => new TextEncoder().encode(s);
const dirs = { home: "/w/h", config: "/w/c", data: "/w/d", cache: "/w/k", workspace: "/w/ws" };

function invocation(over: { plugins?: string[]; seed?: string } = {}) {
  const plan = planSpikeeRun([`dataset:${over.seed ?? "mini-test"}`, ...(over.plugins ?? []).map((p) => `plugin:${p}`)]);
  return {
    targetConfig: buildSpikeeTargetConfig({ baseUrl: BASE, model: "m1", headers: { ...HEADERS } }),
    generateArgs: spikeeGenerateArgs(plan.datasets[0]!, plan.plugins.map((p) => p.name), SEEDS),
    testArgs: spikeeTestArgs(),
    env: buildSpikeeEnv(KEY, dirs, "/venv/bin"),
  };
}
const refusedCode = (f: () => void): string | null => {
  try {
    f();
    return null;
  } catch (e) {
    return e instanceof SpikeeConfigRefused ? e.code : `other: ${String(e)}`;
  }
};

const selection = (set: string, entries: Array<[string, string | null]>) => enc(JSON.stringify({ version: 1, set, entries: entries.map(([id, plugin]) => ({ id, plugin })) }));
const row = (id: string, o: { success?: unknown; error?: unknown; plugin?: string | null; judge?: string; attack?: string } = {}) =>
  JSON.stringify({ id, long_id: `${id}-long`, success: o.success ?? false, error: o.error ?? null, plugin: o.plugin ?? null, judge_name: o.judge ?? "canary", attack_name: o.attack ?? "None", response: "MODEL TEXT", input: "PAYLOAD" });
const outcome = (set: string, sel: Uint8Array | null, results: string | null, problem: SpikeeDatasetOutcome["problem"] = null): SpikeeDatasetOutcome => ({
  set,
  generateExitCode: 0,
  testExitCode: 0,
  timedOut: false,
  selection: sel,
  selectionSha256: sel ? sha(sel) : null,
  results: results === null ? null : enc(results),
  resultsSha256: results === null ? null : sha(results),
  problem,
});

describe("ADR-0245 catalogue (spikee 0.9.4, read from the wheel)", () => {
  it("every local dataset has its fixed generation settings, and only local datasets do", () => {
    const local = SPIKEE_SETS.filter((e) => e.kind === "dataset" && e.disposition === "local").map((e) => e.name).sort();
    expect(Object.keys(SPIKEE_DATASET_GENERATION).sort()).toEqual(local);
    // system-prompt extraction is judged against spikee's demo system message: it must be sent
    expect(SPIKEE_DATASET_GENERATION["sysmsg-extraction-2025-04"]!.includeSystemMessage).toBe(true);
    // the two poetry jailbreaks cite a Hub dataset with no licence: never generated
    expect(SPIKEE_DATASET_GENERATION["cybersec-2026-01"]!.jailbreakTypes).not.toContain("poetry");
  });
  it("plugins that call a hosted LLM or service are never local (mask asks an LLM; text2image is an image)", () => {
    const disp = Object.fromEntries(SPIKEE_SETS.map((e) => [e.set, e.disposition]));
    expect(disp["plugin:mask"]).toBe("cloud_only");
    expect(disp["plugin:shortener"]).toBe("cloud_only");
    expect(disp["plugin:text2image"]).toBe("unsupported_format");
    expect(ENGINE_MANIFEST.spikee.sets["plugin:mask"]).toBeUndefined();
    expect(ENGINE_MANIFEST.spikee.airGappedReducedSet).toContainEqual({ key: "plugin:text2image", reason: "unsupported_format" });
  });
});

describe("ADR-0245 plan: nothing outside the catalogue reaches spikee", () => {
  it("plans local datasets and plugins; excluded and unknown sets are not run, with their reason", () => {
    const p = planSpikeeRun([MINI, "plugin:base64", "plugin:mask", "dataset:toxic-chat", "dataset:nope", MINI]);
    expect(p.datasets.map((d) => d.set)).toEqual([MINI]);
    expect(p.plugins.map((d) => d.name)).toEqual(["base64"]);
    expect(p.notRun).toEqual([
      { key: "plugin:mask", reason: "cloud_only" },
      { key: "dataset:toxic-chat", reason: "cloud_only" },
      { key: "dataset:nope", reason: "engine_error" },
    ]);
  });
  it("plugins alone run nothing", () => {
    const p = planSpikeeRun(["plugin:base64"]);
    expect(p.datasets).toEqual([]);
    expect(p.plugins).toEqual([]);
    expect(p.notRun).toEqual([{ key: "plugin:base64", reason: "engine_error" }]);
  });
});

describe("ADR-0245 the gateway-only invariant", () => {
  it("accepts what it builds: the gateway chat route, x-regulait headers, the key only in the env, spikee's own CLI isolated", () => {
    const inv = invocation({ plugins: ["base64", "hex"], seed: "cybersec-2026-01" });
    expect(() => assertGatewayOnly(inv, BASE, SEEDS)).not.toThrow();
    expect(inv.targetConfig["url"]).toBe("http://gateway:8080/v1/chat/completions");
    expect(JSON.stringify(inv.targetConfig)).not.toContain(KEY);
    expect(inv.generateArgs.slice(0, 4)).toEqual(["-I", "-B", "-c", SPIKEE_BOOT]);
    expect(inv.generateArgs).toContain("--jailbreak-filter");
    expect(inv.testArgs).not.toContain("--target-options");
    for (const [k, v] of Object.entries(SPIKEE_USAGE_DATA_ENV)) expect(inv.env[k]).toBe(v);
    expect(spikeeChatUrl("http://g/v1///")).toBe("http://g/v1/chat/completions");
  });

  // each case breaks ONE guard; the code names which one refused it
  const cases: Array<[string, (i: ReturnType<typeof invocation>) => void, string]> = [
    ["the target URL off the gateway", (i) => (i.targetConfig["url"] = "https://api.openai.com/v1/chat/completions"), "config_not_gateway"],
    ["a vendor header", (i) => ((i.targetConfig["headers"] as Record<string, string>)["openai-organization"] = "x"), "header_invalid"],
    ["a header value that is a URL", (i) => ((i.targetConfig["headers"] as Record<string, string>)["x-regulait-agent-id"] = "https://evil"), "header_invalid"],
    ["an extra target config field", (i) => (i.targetConfig["api_key"] = "k"), "config_unexpected_key"],
    ["the key inline in the config", (i) => (i.targetConfig["model"] = KEY), "config_inline_key"],
    ["a call time limit changed", (i) => (i.targetConfig["timeout"] = 9999), "config_timeout"],
    ["--include-fixes (third-party adversarial suffixes)", (i) => i.generateArgs.splice(10, 0, "--include-fixes", "adv_suffixes"), "argv_generate"],
    ["the jailbreak filter dropped (the unlicensed poetry jailbreaks)", (i) => i.generateArgs.splice(i.generateArgs.indexOf("--jailbreak-filter"), 2), "argv_generate"],
    ["a hosted-LLM plugin (mask)", (i) => i.generateArgs.push("mask"), "argv_plugin"],
    ["a plugin option smuggled as a plugin name", (i) => i.generateArgs.push("--plugin-options"), "argv_plugin"],
    ["a cloud-only seed folder", (i) => (i.generateArgs[7] = `${SEEDS}/seeds-toxic-chat`), "argv_dataset"],
    ["a seed folder outside the image's seeds", (i) => (i.generateArgs[7] = "/tmp/seeds-mini-test"), "argv_dataset"],
    ["a seed folder by traversal", (i) => (i.generateArgs[7] = `${SEEDS}/seeds-../../etc`), "argv_dataset"],
    ["a spikee not isolated (-I dropped)", (i) => i.generateArgs.shift(), "argv_generate"],
    ["--target-options on the test step", (i) => i.testArgs.push("--target-options", "model=openai/gpt-4o"), "argv_test"],
    ["--judge-options (an LLM judge)", (i) => i.testArgs.push("--judge-options", "openai/gpt-4o"), "argv_test"],
    ["an attack module", (i) => i.testArgs.push("--attack", "crescendo"), "argv_test"],
    ["another target", (i) => (i.testArgs[i.testArgs.indexOf("--target") + 1] = "llm_provider"), "argv_test"],
    ["a proxy in the env", (i) => (i.env["HTTPS_PROXY"] = "http://proxy:3128"), "env_forbidden"],
    ["a vendor key in the env", (i) => (i.env["OPENAI_API_KEY"] = "sk-x"), "env_forbidden"],
    ["a usage-data switch unset", (i) => delete i.env["HF_HUB_OFFLINE"], "env_usage_switch"],
    ["no run key", (i) => delete i.env[SPIKEE_KEY_ENV], "env_key_missing"],
    ["the HF cache outside the fresh dirs", (i) => (i.env["HF_HOME"] = "/root/.cache/huggingface"), "env_dirs"],
  ];
  for (const [what, breakIt, code] of cases) {
    it(`refuses ${what} (${code})`, () => {
      const inv = invocation({ plugins: ["base64"], seed: "cybersec-2026-01" });
      breakIt(inv);
      expect(refusedCode(() => assertGatewayOnly(inv, BASE, SEEDS))).toBe(code);
    });
  }
  it("refuses a lease base URL that is not http(s), or carries credentials", () => {
    expect(refusedCode(() => assertGatewayOnly(invocation(), "file:///etc/passwd", SEEDS))).toBe("gateway_url_invalid");
    expect(refusedCode(() => assertGatewayOnly(invocation(), "http://u:p@gateway/v1", SEEDS))).toBe("gateway_url_invalid");
  });
  it("the target module talks to one URL from its config, with no proxy and no redirect, and imports no provider", () => {
    expect(SPIKEE_TARGET_MODULE).toContain("ProxyHandler({})");
    expect(SPIKEE_TARGET_MODULE).toContain("_NoRedirect");
    expect(SPIKEE_TARGET_MODULE).not.toMatch(/any_llm|get_llm|dotenv|spikee\.providers|requests/);
    expect(SPIKEE_TARGET_MODULE).toContain(`os.environ["${SPIKEE_KEY_ENV}"]`);
  });
});

describe("ADR-0245 selection: at most `trials` entries per item, attributable or nothing", () => {
  const line = (id: string | number, plugin: string | null = null, judge = "canary") => JSON.stringify({ id, plugin, judge_name: judge, content: "x" });
  it("keeps at most trials per item, deterministically", () => {
    const ds = enc([...Array.from({ length: 10 }, (_, i) => line(i + 1)), ...Array.from({ length: 4 }, (_, i) => line(`b${i}`, "base64"))].join("\n"));
    const a = selectSpikeeEntries(ds, MINI, ["base64"], 3)!;
    const b = selectSpikeeEntries(ds, MINI, ["base64"], 3)!;
    expect(a.selection).toEqual(b.selection);
    expect(a.selection.entries.filter((e) => e.plugin === null)).toHaveLength(3);
    expect(a.selection.entries.filter((e) => e.plugin === "base64")).toHaveLength(3);
    expect(a.lines).toHaveLength(6);
    // the manifest holds ids and plugin names only
    expect(JSON.stringify(a.selection)).not.toContain("content");
  });
  it("refuses a dataset it cannot attribute: an LLM judge, an unplanned plugin, an id twice, a non-object line", () => {
    expect(selectSpikeeEntries(enc(line(1, null, "llm_judge_harmful")), MINI, [], 3)).toBeNull();
    expect(selectSpikeeEntries(enc(line(1, "mask")), MINI, [], 3)).toBeNull();
    expect(selectSpikeeEntries(enc([line(1), line(1)].join("\n")), MINI, [], 3)).toBeNull();
    expect(selectSpikeeEntries(enc("[1]"), MINI, [], 3)).toBeNull();
  });
});

describe("ADR-0245 mapper: spikee's exit code decides nothing; the results file does", () => {
  const plan = planSpikeeRun([MINI, "plugin:base64"]);
  const sel = selection(MINI, [
    ["1", null],
    ["2", null],
    ["3", "base64"],
  ]);
  const map = (results: string | null, problem: SpikeeDatasetOutcome["problem"] = null, s: Uint8Array | null = sel) => mapSpikeeRun(plan, [outcome(MINI, s, results, problem)]);
  const verdicts = (b: ReturnType<typeof mapSpikeeRun>) => b.items.map((i) => [i.key, i.verdict, i.attempts, i.defeated]);

  it("a success is a defeat; every entry answered and none defeated is a pass", () => {
    const b = map([row("1", { success: true }), row("2"), row("3", { plugin: "base64" })].join("\n"));
    expect(verdicts(b)).toEqual([
      [MINI, "fail", 2, 1],
      [`${MINI}+plugin:base64`, "pass", 1, 0],
    ]);
    expect(b.status).toBe("completed");
    expect(engineResultEnvelopeSchema.safeParse({ version: "regulait.engine-result.v1", runId: "00000000-0000-4000-8000-000000000001", engineId: "spikee", engineVersion: "0.9.4", ...b }).success).toBe(true);
    // no model text, payload or judge argument in the envelope
    expect(JSON.stringify(b)).not.toMatch(/MODEL TEXT|PAYLOAD/);
  });
  it("an entry with an error (the gateway refused the key, no reply) is unknown, never pass", () => {
    const b = map([row("1", { error: "HTTP Error 401: Unauthorized" }), row("2"), row("3", { plugin: "base64", error: "timed out" })].join("\n"));
    expect(verdicts(b)).toEqual([
      [MINI, "unknown", 0, 0],
      [`${MINI}+plugin:base64`, "unknown", 0, 0],
    ]);
    expect(b.status).toBe("failed");
  });
  it("a missing row is unknown; no results file is unknown", () => {
    expect(verdicts(map([row("1"), row("3", { plugin: "base64" })].join("\n")))[0]).toEqual([MINI, "unknown", 0, 0]);
    expect(map(null).items.every((i) => i.verdict === "unknown")).toBe(true);
  });
  it("hostile rows make the file unusable, but a defeat already written is never hidden", () => {
    const hostile = [
      "not json",
      row("1", { success: true }),
      row("2"),
      row("3", { plugin: "base64" }),
    ].join("\n");
    expect(verdicts(map(hostile))).toEqual([
      [MINI, "fail", 2, 1],
      [`${MINI}+plugin:base64`, "unknown", 0, 0],
    ]);
    // a row judged by an LLM judge, an attack row, a foreign id, a duplicate, a wrong plugin: never a pass
    for (const bad of [row("2", { judge: "llm_judge_harmful" }), row("2", { attack: "crescendo" }), row("99"), row("1"), row("2", { plugin: "base64" })]) {
      const b = map([row("1"), row("2"), row("3", { plugin: "base64" }), bad].join("\n"));
      expect(b.items.some((i) => i.verdict === "pass")).toBe(false);
    }
  });
  it("an entry judged by anything but a local judge (an LLM judge), or by an attack, is never a pass", () => {
    for (const second of [row("2", { judge: "llm_judge_harmful" }), row("2", { attack: "crescendo" }), row("2", { success: "yes" })]) {
      const b = map([row("1"), second, row("3", { plugin: "base64" })].join("\n"));
      expect(b.items[0]!.verdict).toBe("unknown");
    }
  });
  it("a run problem (stopped, a failed step) never yields a pass; a defeat still fails", () => {
    const all = [row("1"), row("2"), row("3", { plugin: "base64" })].join("\n");
    expect(map(all, "timed_out").items.map((i) => i.verdict)).toEqual(["unknown", "unknown"]);
    expect(map([row("1", { success: true }), row("2"), row("3", { plugin: "base64" })].join("\n"), "test_failed").items[0]!.verdict).toBe("fail");
  });
  it("a selection that does not match the plan, or names an unplanned plugin, is unknown", () => {
    expect(map(row("1"), null, selection("dataset:llm-mailbox", [["1", null]])).items.every((i) => i.verdict === "unknown")).toBe(true);
    expect(map(row("1"), null, selection(MINI, [["1", "hex"]])).items.every((i) => i.verdict === "unknown")).toBe(true);
    expect(readSpikeeDataset({ set: MINI }, [], { selection: enc("{"), results: null }).problem).toBe("selection_invalid");
  });
  it("a dataset never reached is not run; nothing planned is not_run", () => {
    const b = mapSpikeeRun(plan, []);
    expect(b.items.map((i) => i.verdict)).toEqual(["not_run", "not_run"]);
    expect(mapSpikeeRun(planSpikeeRun(["dataset:toxic-chat"]), []).status).toBe("not_run");
  });
});

// a stand-in for spikee: generate writes a dataset, test writes results, as spikee 0.9.4 does (by cwd)
type Seen = { cmd: string; args: readonly string[]; opts: ProcessGroupOptions };
function standIn(o: { dataset?: string; results?: (selected: string[]) => string; extra?: string; killGenerate?: boolean } = {}) {
  const seen: Seen[] = [];
  const run = async (cmd: string, args: readonly string[], opts: ProcessGroupOptions): Promise<ProcessGroupResult> => {
    seen.push({ cmd, args, opts });
    const ws = opts.cwd!;
    if (args.includes("generate")) {
      if (o.killGenerate) return { exitCode: null, signal: "SIGKILL", killed: true, stdout: "", stderr: "" };
      await mkdir(path.join(ws, "datasets"), { recursive: true });
      await writeFile(path.join(ws, "datasets", "mini-test-full-prompt-dataset-1.jsonl"), o.dataset ?? [1, 2, 3, 4].map((i) => JSON.stringify({ id: i, plugin: null, judge_name: "canary" })).join("\n"));
      if (o.extra) await writeFile(path.join(ws, o.extra), "OPENAI_API_KEY=sk-x");
    } else {
      const selected = (await readFile(path.join(ws, "datasets", "selected.jsonl"), "utf8")).trim().split("\n").map((l) => String((JSON.parse(l) as { id: unknown }).id));
      await mkdir(path.join(ws, "results"), { recursive: true });
      await writeFile(path.join(ws, "results", "results_regulait_gateway_x_1.jsonl"), (o.results ?? ((s) => s.map((id) => row(id)).join("\n")))(selected));
    }
    return { exitCode: 0, signal: null, killed: false, stdout: "", stderr: "" };
  };
  return { run, seen };
}

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "spikee-unit-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const dataset = () => {
  const d = planSpikeeRun([MINI]).datasets[0]!;
  return { set: d.set, seed: d.seed, generation: d.generation };
};
const inv = (over: Partial<Parameters<typeof runSpikeeDataset>[0]> = {}) => ({
  dataset: dataset(),
  plugins: [] as string[],
  target: { baseUrl: BASE, model: "m1", headers: { ...HEADERS } },
  apiKey: KEY,
  trials: 2,
  workDir: path.join(root, "w"),
  timeoutMs: 60_000,
  ...over,
});

describe("ADR-0245 one dataset's run (stand-in spikee)", () => {
  it("generate then test, in a fresh workspace with only our target, the allow-listed env, at most trials entries", async () => {
    const { run, seen } = standIn();
    const o = await runSpikeeDataset(inv(), { run, python: "/py", seedsDir: SEEDS });
    expect(o.problem).toBeNull();
    expect(seen.map((s) => s.args.includes("generate"))).toEqual([true, false]);
    for (const s of seen) {
      expect(s.cmd).toBe("/py");
      expect(s.opts.env[SPIKEE_KEY_ENV]).toBe(KEY);
      expect(Object.keys(s.opts.env).some((k) => /PROXY|OPENAI|ANTHROPIC/i.test(k))).toBe(false);
    }
    const body = mapSpikeeRun(planSpikeeRun([MINI]), [o]);
    expect(body.items.map((i) => [i.verdict, i.attempts])).toEqual([["pass", 2]]);
    // the work directory (with the key in the target's env only, never on disk) is gone
    expect(existsSync(path.join(root, "w"))).toBe(false);
  });
  it("a workspace with a file this build does not write (a .env) is refused before the test step", async () => {
    const { run, seen } = standIn({ extra: ".env" });
    const o = await runSpikeeDataset(inv(), { run, python: "/py", seedsDir: SEEDS });
    expect(o.problem).toBe("workspace_unexpected");
    expect(seen).toHaveLength(1);
  });
  it("a generated dataset naming an LLM judge is never tested", async () => {
    const { run, seen } = standIn({ dataset: JSON.stringify({ id: 1, plugin: null, judge_name: "llm_judge_harmful" }) });
    const o = await runSpikeeDataset(inv(), { run, python: "/py", seedsDir: SEEDS });
    expect(o.problem).toBe("dataset_invalid");
    expect(seen).toHaveLength(1);
  });
  it("a generate step killed at its time limit is timed out; a refused target never starts spikee", async () => {
    const killed = standIn({ killGenerate: true });
    expect((await runSpikeeDataset(inv(), { run: killed.run, python: "/py", seedsDir: SEEDS })).problem).toBe("timed_out");
    const none = standIn();
    await expect(runSpikeeDataset(inv({ target: { baseUrl: BASE, model: "m1", headers: { authorization: "x" } } }), { run: none.run, python: "/py", seedsDir: SEEDS })).rejects.toBeInstanceOf(SpikeeConfigRefused);
    expect(none.seen).toHaveLength(0);
  });
});

const RUN_ID = "00000000-0000-4000-8000-0000000000aa";
const job = (over: Partial<SpikeeJob> = {}): SpikeeJob => ({ runId: RUN_ID, datasets: [MINI], plugins: [], target: { baseUrl: BASE, model: "m1", headers: { ...HEADERS } }, apiKey: KEY, trials: 2, timeoutMs: 60_000, ...over });

describe("ADR-0245 exchange: the runner never runs spikee; files are read back by sha256", () => {
  it("a job round-trips through the worker, and the job (with its key) is removed", async () => {
    const jobs = path.join(root, "jobs");
    const results = path.join(root, "results");
    const work = path.join(root, "work");
    await Promise.all([mkdir(jobs), mkdir(results), mkdir(work)]);
    const { run } = standIn({ results: (s) => s.map((id, i) => row(id, { success: i === 0 })).join("\n") });
    const exec = new ExchangeSpikeeExecutor(jobs, results, { pollMs: 10 });
    let ticking = true;
    const ticker = (async () => {
      while (ticking) {
        await workerTick({ jobsRoot: jobs, resultsRoot: results, workRoot: work, pollMs: 10, spikee: { run, python: "/py", seedsDir: SEEDS } });
        await new Promise((r) => setTimeout(r, 10));
      }
    })();
    const { outcomes } = await exec.run(job(), new AbortController().signal);
    ticking = false;
    await ticker;
    expect(mapSpikeeRun(planSpikeeRun([MINI]), outcomes).items.map((i) => [i.verdict, i.attempts, i.defeated])).toEqual([["fail", 2, 1]]);
    expect(await readdir(jobs)).toEqual([]);
  });
  it("a results file swapped after the worker hashed it is not read (unknown)", async () => {
    const jobs = path.join(root, "jobs");
    const results = path.join(root, "results");
    await Promise.all([mkdir(jobs), mkdir(results)]);
    const exec = new ExchangeSpikeeExecutor(jobs, results, { pollMs: 10 });
    const pending = exec.run(job(), new AbortController().signal);
    const out = path.join(results, RUN_ID);
    await mkdir(out, { recursive: true });
    const sel = selection(MINI, [["1", null]]);
    await writeFile(path.join(out, "0.selection.json"), sel);
    await writeFile(path.join(out, "0.results.jsonl"), row("1"));
    await writeFile(
      path.join(out, "done.json"),
      JSON.stringify({ invalid: false, datasets: [{ set: MINI, generateExitCode: 0, testExitCode: 0, timedOut: false, cancelled: false, problem: null, selectionSha256: sha(sel), resultsSha256: "0".repeat(64) }] }),
    );
    const { outcomes } = await pending;
    expect(outcomes[0]!.results).toBeNull();
    expect(mapSpikeeRun(planSpikeeRun([MINI]), outcomes).items[0]!.verdict).toBe("unknown");
  });
  it("the worker refuses a job naming a set this build does not run", () => {
    expect(spikeeJobSchema.safeParse(job({ datasets: ["dataset:toxic-chat"] })).success).toBe(false);
    expect(spikeeJobSchema.safeParse(job({ plugins: ["plugin:mask"] })).success).toBe(false);
    expect(spikeeJobSchema.safeParse({ ...job(), judge: { model: "j", headers: {} } }).success).toBe(false);
  });
  it("an invalid job is answered without running anything", async () => {
    const jobs = path.join(root, "jobs");
    const results = path.join(root, "results");
    const work = path.join(root, "work");
    await Promise.all([mkdir(path.join(jobs, RUN_ID), { recursive: true }), mkdir(results), mkdir(work)]);
    await writeFile(path.join(jobs, RUN_ID, "job.json"), JSON.stringify({ ...job(), datasets: ["dataset:toxic-chat"] }));
    const { run, seen } = standIn();
    await workerTick({ jobsRoot: jobs, resultsRoot: results, workRoot: work, spikee: { run } });
    expect(seen).toHaveLength(0);
    expect(JSON.parse(await readFile(path.join(results, RUN_ID, "done.json"), "utf8"))).toEqual({ datasets: [], invalid: true });
  });
});

const lease = (sets: string[], target: EngineLease["target"] | null = { baseUrl: BASE, model: "m1", apiKey: KEY, headers: { ...HEADERS } }): EngineLease =>
  ({
    runId: RUN_ID,
    engineId: "spikee",
    deadlineAt: new Date(Date.now() + 600_000).toISOString(),
    spec: { trials: 2, config: { sets } },
    target,
  }) as unknown as EngineLease;
const ctx = () => ({ signal: new AbortController().signal, progress: () => undefined }) as never;

describe("ADR-0245 adapter: fail closed", () => {
  it("nothing runnable: not_run, and the executor is never asked", async () => {
    let asked = 0;
    const executor = { run: async () => ((asked += 1), { outcomes: [], cancelled: false }), reconcile: async () => [] };
    const b = await spikeeAdapter({ executor })(lease(["plugin:base64", "dataset:toxic-chat"]), ctx());
    expect(b.status).toBe("not_run");
    expect(asked).toBe(0);
  });
  it("no model target, or a header the invariant refuses: every planned item not run, the executor never asked", async () => {
    let asked = 0;
    const executor = { run: async () => ((asked += 1), { outcomes: [], cancelled: false }), reconcile: async () => [] };
    const a = await spikeeAdapter({ executor })(lease([MINI], null), ctx());
    expect([a.status, a.errorCode]).toEqual(["not_run", "target_required"]);
    const b = await spikeeAdapter({ executor })(lease([MINI], { baseUrl: BASE, model: "m1", apiKey: KEY, headers: { "x-api-key": "k" } }), ctx());
    expect([b.status, b.errorCode]).toEqual(["not_run", "header_invalid"]);
    expect(asked).toBe(0);
  });
  it("runs through the local executor with the stand-in", async () => {
    const { run } = standIn();
    const b = await spikeeAdapter({ executor: new LocalSpikeeExecutor(root, { run, python: "/py", seedsDir: SEEDS }) })(lease([MINI]), ctx());
    expect(b.items.map((i) => i.verdict)).toEqual(["pass"]);
  });
});

describe("ADR-0245 worker self-test", () => {
  const egress = { host: "registry.example.invalid", ip: "127.0.0.1", timeoutMs: 200 } as never;
  it("fails closed: a missing report, or a switch unset, never passes", async () => {
    expect((await judgeWorkerSelfTest(root)).failures).toEqual(["worker_report_missing"]);
    await writeWorkerSelfTest(root, { spikeeVersion: "0.9.4", env: {}, egress, credentialPaths: [] });
    const j = await judgeWorkerSelfTest(root);
    expect(j.passed).toBe(false);
    expect(j.failures).toContain("worker_switch_missing:HF_HUB_OFFLINE");
    const st = await spikeeRunnerSelfTest({ imageDigest: `sha256:${"a".repeat(64)}`, engineVersion: "0.9.4", resultsRoot: root, egress });
    expect(st.usageDataEnv["REGULAIT_SPIKEE_WORKER_SELFTEST"]).toBe(false);
  });
});
