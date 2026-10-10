/**
 * ADR-0187 decisions 203-206 (owner decision on open question 24) — garak's model-calling probes and
 * detectors (`judge.*`, `agent_breaker.*`) run only with the run's judge agent behind the gateway.
 *
 * What it pins, on the shim:
 *   - the plan marks `agent_breaker.AgentBreaker` as a judge probe; the config re-points its attacker,
 *     parser and judge detector at the gateway's `/v1/` with the JUDGE's headers, never garak's hosted
 *     default, and the key stays in the one env var (no second credential);
 *   - without a judge, the config, the job schema and the adapter each refuse (default-deny), and the
 *     worker is never asked;
 *   - the invariant refuses every way a judge section could leave the gateway, and refuses a judge
 *     section on a probe that needs none;
 *   - through the real runner/worker exchange, the garak process for a judge probe sees only the run key
 *     (no runner or enrolment token, even one planted in the worker's own environment).
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENGINE_MANIFEST, engineConfigNeedsApproval, engineRunNeedsJudge, garakJudgeSets, garakProbeForSet, type EngineLease } from "@regulait/shared";
import type { ProcessGroupOptions, ProcessGroupResult } from "@regulait/engine-runner";
import { garakAdapter } from "./adapter.js";
import {
  assertGatewayOnly,
  buildGarakConfig,
  buildGarakEnv,
  GARAK_ATTACKER_MAX_TOKENS,
  GARAK_JUDGE_MAX_TOKENS,
  GarakConfigRefused,
  garakProbeNeedsJudge,
  planGarakRun,
} from "./config.js";
import { ExchangeGarakExecutor, garakJobSchema, workerTick, type GarakExecutor, type GarakJob } from "./exchange.js";

const AB = "agent_breaker.AgentBreaker";
const AB_DET = "agent_breaker.AgentBreakerResult";
const ENC = "encoding.InjectBase64";
const BASE = "http://gateway:3000/v1";
const TARGET = { baseUrl: BASE, model: "target-model", headers: { "x-regulait-agent-id": "t1", "x-regulait-project-id": "p1" } };
const JUDGE = { model: "judge-model", headers: { "x-regulait-agent-id": "j1", "x-regulait-project-id": "p1" } };
const DIRS = { home: "/w/h", config: "/w/c", data: "/w/d", cache: "/w/k", report: "/w/r" };

const refusal = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof GarakConfigRefused) return e.code;
    throw e;
  }
};

describe("decision 203: which garak probes need the gateway judge", () => {
  it("agent_breaker runs here, is a judge probe, and is classed agentic (approval first); no other admitted probe needs a judge", () => {
    const e = garakProbeForSet("agent_breaker.agentbreaker");
    expect(e).toMatchObject({ probe: AB, disposition: "local", requiresJudge: true, setClass: "agentic", attackClass: null });
    expect(garakJudgeSets()).toEqual(["agent_breaker.agentbreaker"]);
    expect(ENGINE_MANIFEST.garak.judgeSets).toEqual(["agent_breaker.agentbreaker"]);
    expect(ENGINE_MANIFEST.garak.requiresJudge).toBe(false);
    expect(engineConfigNeedsApproval(ENGINE_MANIFEST.garak, ["agent_breaker.agentbreaker"])).toBe(true);
    // control: an ordinary run of garak needs no judge; one selecting agent_breaker does; promptfoo always does
    expect(engineRunNeedsJudge(ENGINE_MANIFEST.garak, ["encoding.injectbase64"])).toBe(false);
    expect(engineRunNeedsJudge(ENGINE_MANIFEST.garak, ["encoding.injectbase64", "agent_breaker.agentbreaker"])).toBe(true);
    expect(engineRunNeedsJudge(ENGINE_MANIFEST.promptfoo, ["prompt-extraction"])).toBe(true);
    expect(engineRunNeedsJudge(ENGINE_MANIFEST.modelscan, ["scan"])).toBe(false);
  });

  it("the judge.* probes whose payload data is deleted stay excluded (their judge alone does not admit them)", () => {
    for (const p of ["fitd.FITD", "goat.GOATAttack"]) {
      expect(garakProbeForSet(p.toLowerCase()), p).toMatchObject({ disposition: "excluded_licence", requiresJudge: true });
      expect(ENGINE_MANIFEST.garak.sets[p.toLowerCase()], p).toBeUndefined();
      expect(planGarakRun([p.toLowerCase()]).probes).toEqual([]);
    }
  });
});

describe("decision 204: the judge is reached only through the gateway, with the run's own key", () => {
  const cfg = () => buildGarakConfig({ target: TARGET, judge: JUDGE, probe: AB, trials: 3, reportDir: DIRS.report });
  const env = () => buildGarakEnv("rglv_run_key", DIRS, "/opt/garak/venv/bin");

  it("re-points the attacker, the parser and the judge detector at the gateway judge, and the invariant accepts it", () => {
    const c = cfg() as { plugins: Record<string, Record<string, Record<string, unknown>>> };
    const gw = { uri: `${BASE}/`, extra_params: { extra_headers: JUDGE.headers } };
    expect(c.plugins["detectors"]).toEqual({
      agent_breaker: {
        detector_model_type: "openai.OpenAICompatible",
        detector_model_name: "judge-model",
        detector_model_config: expect.objectContaining({ ...gw, max_tokens: GARAK_JUDGE_MAX_TOKENS }),
      },
    });
    expect(c.plugins["probes"]!["agent_breaker"]).toMatchObject({
      red_team_model_type: "openai.OpenAICompatible",
      red_team_model_name: "judge-model",
      red_team_model_config: { ...gw, max_tokens: GARAK_ATTACKER_MAX_TOKENS },
      parse_model_type: "openai.OpenAICompatible",
      parse_model_name: "judge-model",
    });
    // the target is unchanged: its own model and headers
    expect(c.plugins["generators"]).toMatchObject({ openai: { OpenAICompatible: { uri: `${BASE}/`, extra_params: { extra_headers: TARGET.headers } } } });
    expect(refusal(() => assertGatewayOnly(c, env(), BASE))).toBeNull();
    // one key, in the one env var: nothing in the config carries it, and no second key variable exists
    expect(JSON.stringify(c)).not.toContain("rglv_run_key");
    expect(Object.entries(env()).filter(([, v]) => v === "rglv_run_key").map(([k]) => k)).toEqual(["OPENAICOMPATIBLE_API_KEY"]);
  });

  it("refuses a judge probe with no judge (default-deny), and puts no judge section on a probe that needs none", () => {
    expect(refusal(() => buildGarakConfig({ target: TARGET, probe: AB, trials: 3, reportDir: DIRS.report }))).toBe("judge_required");
    expect(refusal(() => buildGarakConfig({ target: TARGET, judge: null, probe: AB, trials: 3, reportDir: DIRS.report }))).toBe("judge_required");
    const plain = buildGarakConfig({ target: TARGET, judge: JUDGE, probe: ENC, trials: 3, reportDir: DIRS.report }) as { plugins: Record<string, unknown> };
    expect(plain.plugins).not.toHaveProperty("detectors");
    expect(plain.plugins).not.toHaveProperty("probes");
    expect(garakProbeNeedsJudge(ENC)).toBe(false);
  });

  it("the invariant refuses every way a judge section could leave the gateway or widen the run", () => {
    const c = cfg() as { plugins: Record<string, unknown> };
    const det = (c.plugins["detectors"] as Record<string, Record<string, unknown>>)["agent_breaker"]!;
    const detCfg = det["detector_model_config"] as Record<string, unknown>;
    const ab = (c.plugins["probes"] as Record<string, Record<string, unknown>>)["agent_breaker"]!;
    const withDet = (d: Record<string, unknown>) => ({ ...c, plugins: { ...c.plugins, detectors: { agent_breaker: d } } });
    const withAb = (p: Record<string, unknown>) => ({ ...c, plugins: { ...c.plugins, probes: { agent_breaker: p } } });
    const plain = buildGarakConfig({ target: TARGET, probe: ENC, trials: 3, reportDir: DIRS.report }) as { plugins: Record<string, unknown> };
    const variants: Array<[string, Record<string, unknown>, string]> = [
      ["garak's hosted default judge", withDet({ ...det, detector_model_type: "nim" }), "config_generator"],
      ["an off-gateway judge", withDet({ ...det, detector_model_config: { ...detCfg, uri: "https://judge.example.com/v1/" } }), "config_not_gateway"],
      ["a judge header that is not the gateway's", withDet({ ...det, detector_model_config: { ...detCfg, extra_params: { extra_headers: { authorization: "Bearer x" } } } }), "header_invalid"],
      ["a judge call with no headers", withDet({ ...det, detector_model_config: { ...detCfg, extra_params: { extra_headers: {} } } }), "header_invalid"],
      ["a key in the judge's config", withDet({ ...det, detector_model_config: { ...detCfg, api_key: "rglv_other" } }), "config_unexpected_key"],
      ["the judge's detector section missing", { ...c, plugins: { ...c.plugins, detectors: {} } }, "judge_required"],
      ["a second detector re-configured", { ...c, plugins: { ...c.plugins, detectors: { agent_breaker: det, judge: det } } }, "config_unexpected_key"],
      ["a hosted attacker", withAb({ ...ab, red_team_model_type: "nim" }), "config_generator"],
      ["an off-gateway parser", withAb({ ...ab, parse_model_config: { ...detCfg, uri: "https://x.example/v1/" } }), "config_not_gateway"],
      ["an agent config file override", withAb({ ...ab, agent_config_file: "/etc/passwd" }), "config_unexpected_key"],
      ["a judge section on a probe that needs none", { ...plain, plugins: { ...plain.plugins, detectors: c.plugins["detectors"] } }, "config_unexpected_key"],
      ["an attacker section on a probe that needs none", { ...plain, plugins: { ...plain.plugins, probes: c.plugins["probes"] } }, "config_unexpected_key"],
    ];
    for (const [name, v, code] of variants) {
      expect(refusal(() => assertGatewayOnly(v, env(), BASE)), name).toBe(code);
    }
  });

  it("the worker's job schema refuses a judge probe with no judge, and a judge carrying a key", () => {
    const base: GarakJob = {
      runId: randomUUID(),
      probes: [{ probe: AB, detector: AB_DET }],
      target: TARGET,
      apiKey: "rglv_run_key",
      judge: JUDGE,
      trials: 2,
      timeoutMs: 10_000,
    };
    expect(garakJobSchema.safeParse(base).success).toBe(true);
    expect(garakJobSchema.safeParse({ ...base, judge: null }).success).toBe(false);
    expect(garakJobSchema.safeParse({ ...base, judge: { ...JUDGE, apiKey: "rglv_other" } }).success).toBe(false);
    // control: a job of probes that need no judge carries none
    expect(garakJobSchema.safeParse({ ...base, probes: [{ probe: ENC, detector: "encoding.DecodeMatch" }], judge: null }).success).toBe(true);
  });
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "b5g-judge-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const lease = (sets: string[], judge: EngineLease["judge"]): EngineLease => ({
  runId: randomUUID(),
  engineId: "garak",
  engineVersion: "0.17.0",
  spec: { config: { sets, params: {} }, trials: 2 },
  target: { baseUrl: BASE, model: TARGET.model, apiKey: "rglv_run_key", headers: TARGET.headers },
  judge,
  artifacts: [],
  deadlineAt: new Date(Date.now() + 120_000).toISOString(),
  budgetUsd: 1,
});

describe("decision 204: the adapter and the worker", () => {
  const ctx = () => ({ workDir: root, signal: new AbortController().signal, progress: () => undefined });

  it("a lease selecting a judge probe with no judge is not run, and the worker is never asked", async () => {
    const e: GarakExecutor & { calls: number } = { calls: 0, run: async () => ((e.calls += 1), { outcomes: [], cancelled: false }), reconcile: async () => [] };
    const body = await garakAdapter({ executor: e })(lease(["agent_breaker.agentbreaker", "encoding.injectbase64"], null), ctx());
    expect(body).toMatchObject({ status: "not_run", errorCode: "judge_required" });
    expect(e.calls).toBe(0);
  });

  it("the job carries the judge only when a planned probe needs it, and never a key of its own", async () => {
    const jobs: GarakJob[] = [];
    const e: GarakExecutor = { run: async (j) => (jobs.push(j), { outcomes: [], cancelled: false }), reconcile: async () => [] };
    await garakAdapter({ executor: e })(lease(["agent_breaker.agentbreaker"], JUDGE), ctx());
    await garakAdapter({ executor: e })(lease(["encoding.injectbase64"], JUDGE), ctx());
    expect(jobs[0]!.judge).toEqual(JUDGE);
    expect(jobs[0]!.apiKey).toBe("rglv_run_key");
    expect(jobs[1]!.judge).toBeNull();
  });

  it("through the exchange, the judge probe's garak process sees only the run key: no runner or enrolment token", async () => {
    const jobsRoot = path.join(root, "jobs");
    const results = path.join(root, "results");
    const work = path.join(root, "work");
    await Promise.all([mkdir(jobsRoot), mkdir(results), mkdir(work)]);
    // a runner credential planted where a careless worker would pick it up: its own environment
    const planted = { REGULAIT_ENGINE_ENROLLMENT_TOKEN: "rgee_synthetic_planted", REGULAIT_RUNNER_TOKEN: "rge_synthetic_planted" };
    const prior = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
    Object.assign(process.env, planted);
    const seen: Array<{ env: Record<string, string>; config: Record<string, unknown> }> = [];
    const run = async (_cmd: string, args: readonly string[], opts: ProcessGroupOptions): Promise<ProcessGroupResult> => {
      const configPath = args[args.length - 1]!;
      seen.push({ env: opts.env, config: JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown> });
      return { exitCode: 0, signal: null, killed: false, stdout: "", stderr: "" };
    };
    try {
      const exec = new ExchangeGarakExecutor(jobsRoot, results, { pollMs: 10 });
      let ticking = true;
      const ticker = (async () => {
        while (ticking) {
          await workerTick({ jobsRoot, resultsRoot: results, workRoot: work, pollMs: 10, garak: { run, python: "/py" } });
          await new Promise((r) => setTimeout(r, 10));
        }
      })();
      const j: GarakJob = { runId: randomUUID(), probes: [{ probe: AB, detector: AB_DET }], target: TARGET, judge: JUDGE, apiKey: "rglv_run_key", trials: 2, timeoutMs: 10_000 };
      // the job file on the exchange volume: the run key, the judge's model and headers, nothing else secret
      const published = (async () => {
        for (;;) {
          try {
            return JSON.parse(await readFile(path.join(jobsRoot, j.runId, "job.json"), "utf8")) as Record<string, unknown>;
          } catch {
            await new Promise((r) => setTimeout(r, 2));
          }
        }
      })();
      await exec.run(j, new AbortController().signal);
      ticking = false;
      await ticker;
      const onDisk = await published;
      expect(Object.keys(onDisk).sort()).toEqual(["apiKey", "judge", "probes", "runId", "target", "timeoutMs", "trials"]);
      expect(onDisk["judge"]).toEqual(JUDGE);
      expect(seen).toHaveLength(1);
      const env = seen[0]!.env;
      expect(env["OPENAICOMPATIBLE_API_KEY"]).toBe("rglv_run_key");
      expect(Object.keys(env).filter((k) => /ENROLLMENT|RUNNER|STATE|TOKEN/.test(k))).toEqual([]);
      expect(Object.values(env).some((v) => /^rgee?_/.test(v))).toBe(false);
      expect(JSON.stringify(seen[0]!.config)).not.toMatch(/rgee?_|rglv_/);
      expect(seen[0]!.config).toMatchObject({ plugins: { detectors: { agent_breaker: { detector_model_name: "judge-model" } } } });
    } finally {
      for (const [k, v] of Object.entries(prior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

