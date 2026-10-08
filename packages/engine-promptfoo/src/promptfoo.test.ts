/**
 * ADR-0187 B5-P — the promptfoo shim without a gateway: the plan, the config generator and its
 * invariant, the result mapper (on fixtures captured from a real promptfoo 0.123.1 run, trimmed to
 * the fields the mapper reads), and the adapter with the process runner faked.
 *
 * The four required proofs are pinned here at the engine boundary and, through the shared
 * normaliser, at the verdict the gateway stores:
 *   - engine error → unknown (never pass);
 *   - egress denied → not_run;
 *   - budget spent → the 401s that follow are unknown, never pass, and what was measured counts;
 *   - cancel → the adapter stops the engine and posts nothing (the key itself is revoked by the
 *     gateway: zz-b5-engines.test.ts and zz-b5-promptfoo.test.ts).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENGINE_MANIFEST,
  ENGINE_RESULT_VERSION,
  ENGINE_TAXONOMY,
  PROMPTFOO_USAGE_DATA_ENV,
  engineResultEnvelopeSchema,
  normaliseEngineResult,
  type EngineLease,
} from "@regulait/shared";
import { runOnce, type RunnerClient } from "@regulait/engine-runner";
import {
  assertGatewayOnly,
  buildPromptfooConfig,
  buildPromptfooEnv,
  planPromptfooRun,
  PromptfooConfigRefused,
  RUN_KEY_ENV,
} from "./config.js";
import { classifyError, mapPromptfooResults, type PromptfooEnvelopeBody } from "./mapper.js";
import { promptfooAdapter } from "./adapter.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(path.join(here, "fixtures", name));

const GATEWAY = "http://gateway:3000/v1";
const KEY = "rglv_synthetic_engine_run_key_0000000000000000";

function lease(over: Partial<EngineLease> = {}, sets = ["prompt-extraction", "pii:direct", "strategy:base64"]): EngineLease {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    engineId: "promptfoo",
    engineVersion: "0.123.1",
    spec: { config: { sets, params: {} }, trials: 2 },
    target: { baseUrl: GATEWAY, model: "target-model", apiKey: KEY, headers: { "x-regulait-agent-id": "a1", "x-regulait-project-id": "p1" } },
    judge: { model: "judge-model", headers: { "x-regulait-agent-id": "j1", "x-regulait-project-id": "p1" } },
    artifacts: [],
    deadlineAt: new Date(Date.now() + 600_000).toISOString(),
    budgetUsd: 1,
    ...over,
  };
}

/** what the gateway would store for this body (the server's verdicts, not the engine's) */
function stored(body: PromptfooEnvelopeBody) {
  const envelope = engineResultEnvelopeSchema.parse({
    version: ENGINE_RESULT_VERSION,
    runId: "11111111-1111-4111-8111-111111111111",
    engineId: "promptfoo",
    engineVersion: "0.123.1",
    ...body,
  });
  return normaliseEngineResult({ envelope, status: envelope.status, taxonomy: ENGINE_TAXONOMY, scrub: (t) => t });
}

function result(plugin: string | null, opts: { strategy?: string; success?: boolean; failureReason?: number; error?: string } = {}) {
  const meta = plugin === null ? {} : { pluginId: plugin, ...(opts.strategy ? { strategyId: opts.strategy } : {}) };
  return {
    success: opts.success ?? true,
    failureReason: opts.failureReason ?? 0,
    metadata: meta,
    testCase: { metadata: meta },
    ...(opts.error ? { error: opts.error, response: { error: opts.error } } : {}),
  };
}
const output = (results: unknown[]) => Buffer.from(JSON.stringify({ evalId: "e", results: { version: 3, results } }));

describe("the plan: only what this build admits reaches promptfoo", () => {
  it("cloud-only, excluded, not pre-seeded and unknown sets are not run, with their reason", () => {
    const plan = planPromptfooRun(["prompt-extraction", "bias:age", "harmful:hate", "pliny", "beavertails", "strategy:goat", "strategy:rot13", "made-up", "strategy:basic"]);
    expect(plan.plugins.map((p) => p.id)).toEqual(["prompt-extraction"]);
    expect(plan.strategies.map((s) => s.id)).toEqual(["rot13"]);
    expect(plan.notRun).toEqual([
      { key: "bias:age", reason: "cloud_only" },
      { key: "harmful:hate", reason: "cloud_only" },
      { key: "pliny", reason: "excluded_licence" },
      { key: "beavertails", reason: "missing_preseed" },
      { key: "strategy:goat", reason: "cloud_only" },
      { key: "made-up", reason: "engine_error" },
    ]);
  });

  it("the manifest classes every set that runs and lists the reduced set; the taxonomy maps promptfoo ids", () => {
    const m = ENGINE_MANIFEST.promptfoo;
    expect(m.version).toBe("0.123.1");
    expect(m.imageDigest).toBeNull(); // not built here: the engine cannot be enabled
    expect(m.usageDataEnv).toEqual(PROMPTFOO_USAGE_DATA_ENV);
    expect(m.sets["prompt-extraction"]).toBe("standard");
    expect(m.sets["strategy:crescendo"]).toBe("offensive");
    expect(m.sets["excessive-agency"]).toBe("agentic");
    expect(m.sets["pliny"]).toBeUndefined();
    expect(m.airGappedReducedSet).toContainEqual({ key: "pliny", reason: "excluded_licence" });
    expect(m.airGappedReducedSet).toContainEqual({ key: "strategy:goat", reason: "cloud_only" });
    const ids = ENGINE_TAXONOMY.entries.filter((e) => e.system === "promptfoo").map((e) => [e.id, e.attackClass]);
    expect(ids).toContainEqual(["prompt-extraction", "system_prompt_extraction"]);
    expect(ids).toContainEqual(["strategy:base64", "encoding_evasion"]);
    // agentic-named plugins are deliberately unmapped (a chat-route run cannot show a tool call)
    expect(ids.map(([id]) => id)).not.toContain("excessive-agency");
  });
});

describe("the config generator never leaves the gateway", () => {
  it("every provider is the gateway's compat route on the run's key, sharing off, the key only in env", () => {
    const l = lease();
    const plan = planPromptfooRun(l.spec.config.sets);
    const config = buildPromptfooConfig(l, plan);
    const env = buildPromptfooEnv(l, "/work/run", { PATH: "/usr/bin" });
    expect(() => assertGatewayOnly(config, env, GATEWAY)).not.toThrow();
    const text = JSON.stringify(config);
    expect(text).not.toContain(KEY);
    for (const url of text.match(/[a-z][a-z0-9+.-]*:\/\/[^"]+/gi) ?? []) expect(url.startsWith(GATEWAY)).toBe(true);
    expect(config["sharing"]).toBe(false);
    const rt = config["redteam"] as { provider: { id: string }; plugins: Array<{ id: string }>; strategies: Array<{ id: string }> };
    expect(rt.provider.id).toBe("openai:chat:judge-model");
    expect((config["defaultTest"] as { options: { provider: { id: string } } }).options.provider.id).toBe("openai:chat:judge-model");
    expect(rt.plugins.map((p) => p.id)).toEqual(["prompt-extraction", "pii:direct"]);
    expect(rt.strategies.map((s) => s.id)).toEqual(["basic", "base64"]);
    // the env: built from nothing, every switch at its value, the key in exactly one variable
    expect(env[RUN_KEY_ENV]).toBe(KEY);
    for (const [k, v] of Object.entries(PROMPTFOO_USAGE_DATA_ENV)) expect(env[k]).toBe(v);
    expect(Object.keys(env).filter((k) => /PROXY|API_KEY|BASE_URL/i.test(k))).toEqual([]);
    expect(Object.values(env).filter((v) => v === KEY)).toHaveLength(1);
  });

  it("the invariant refuses a non-gateway URL, a vendor default, an inline key, sharing, a missing switch, a proxy", () => {
    const l = lease();
    const plan = planPromptfooRun(l.spec.config.sets);
    const good = () => buildPromptfooConfig(l, plan) as Record<string, any>;
    const env = buildPromptfooEnv(l, "/work/run", { PATH: "/usr/bin" });
    const refused = (config: Record<string, unknown>, e = env) => {
      try {
        assertGatewayOnly(config, e, GATEWAY);
        return null;
      } catch (err) {
        expect(err).toBeInstanceOf(PromptfooConfigRefused);
        return (err as PromptfooConfigRefused).code;
      }
    };
    const offGateway = good();
    offGateway.targets[0].config.apiBaseUrl = "https://models.example.net/v1";
    expect(refused(offGateway)).toBe("config_non_gateway_url");
    const lookalike = good();
    lookalike.redteam.provider.config.apiBaseUrl = "http://gateway:3000/v1.attacker.example";
    expect(refused(lookalike)).toBe("config_non_gateway_url");
    const noGrader = good();
    delete noGrader.defaultTest; // promptfoo would grade with a vendor default
    expect(refused(noGrader)).toBe("config_providers");
    const vendorProvider = good();
    vendorProvider.redteam.provider.id = "vendor:some-model";
    expect(refused(vendorProvider)).toBe("config_provider_not_gateway");
    const inlineKey = good();
    inlineKey.targets[0].config.apiKey = KEY;
    expect(refused(inlineKey)).toBe("config_forbidden_key");
    const fallbackKey = good();
    fallbackKey.targets[0].config.useDefaultApiKey = true;
    expect(refused(fallbackKey)).toBe("config_provider_key");
    const sharing = good();
    sharing.sharing = true;
    expect(refused(sharing)).toBe("config_sharing_on");
    const { PROMPTFOO_DISABLE_REMOTE_GENERATION: _off, ...noSwitch } = env;
    expect(refused(good(), noSwitch)).toBe("env_usage_switch");
    expect(refused(good(), { ...env, HTTPS_PROXY: "http://proxy.example:3128" })).toBe("env_forbidden");
    expect(refused(good(), { ...env, OPENAI_API_KEY: "sk-synthetic" })).toBe("env_forbidden");
    // the env is an allow-list: a remote-URL override is refused like a credential
    expect(refused(good(), { ...env, PROMPTFOO_REMOTE_GENERATION_URL: "https://remote.example" })).toBe("env_forbidden");
    expect(refused(good(), { ...env, PROMPTFOO_DISABLE_SHARING: "0" })).toBe("env_usage_switch");
  });

  it("no judge, or no target, is refused before anything runs (promptfoo would grade with a vendor default)", () => {
    const plan = planPromptfooRun(["prompt-extraction"]);
    expect(() => buildPromptfooConfig(lease({ judge: null }), plan)).toThrow(/judge_required/);
    expect(() => buildPromptfooConfig(lease({ target: null }), plan)).toThrow(/target_required/);
  });
});

describe("the result mapper", () => {
  const plan = planPromptfooRun(["prompt-extraction", "pii:direct", "strategy:base64", "bias:age"]);

  it("a real 0.123.1 output: one item per (plugin, strategy), classes from the taxonomy, plan not-runs kept", () => {
    const body = mapPromptfooResults({ raw: fixture("results-0.123.1-pass.json"), exitCode: 0, plan });
    expect(body.status).toBe("completed");
    expect(body.items.map((i) => [i.key, i.sourceTaxonomy.id, i.verdict, i.attempts])).toEqual([
      ["pii:direct/basic", "pii:direct", "pass", 3],
      ["prompt-extraction/basic", "prompt-extraction", "pass", 2],
      ["pii:direct/base64", "strategy:base64", "pass", 3],
      ["prompt-extraction/base64", "strategy:base64", "pass", 2],
    ]);
    expect(body.notRun).toEqual([{ key: "bias:age", reason: "cloud_only" }]);
    const n = stored(body);
    expect(n.verdict).toBe("pass");
    expect(n.items.find((i) => i.key === "bias:age")).toMatchObject({ verdict: "not_run", notRunReason: "cloud_only" });
    expect(new Set(n.items.filter((i) => i.verdict !== "not_run").map((i) => i.attackClass))).toEqual(new Set(["pii_leak", "system_prompt_extraction", "encoding_evasion"]));
    // no model text: every reason is our own sentence
    for (const i of body.items) expect(i.reason).toMatch(/^\d+ (graded attempts|of)/);
  });

  it("a graded failure is a defeat, and a defeat is never hidden by the attempt cap", () => {
    const many = Array.from({ length: 30 }, (_, i) => result("prompt-extraction", { success: i !== 29, failureReason: i === 29 ? 1 : 0 }));
    const body = mapPromptfooResults({ raw: output(many), exitCode: 100, plan });
    expect(body.status).toBe("completed");
    expect(body.items[0]).toMatchObject({ verdict: "fail", attempts: 25, defeated: 1 });
    expect(stored(body).items[0]!.verdict).toBe("fail");
  });

  it("RED PROOF engine error → unknown: a failed eval step, or an errored result, never reads pass", () => {
    // promptfoo exited 1 (neither 0 nor 100): the run failed and the server reads every item unknown
    const crashed = mapPromptfooResults({ raw: output([result("prompt-extraction"), result("pii:direct")]), exitCode: 1, plan });
    expect(crashed).toMatchObject({ status: "failed", errorCode: "engine_error" });
    const n = stored(crashed);
    expect(n.verdict).toBe("unknown");
    expect(n.items.filter((i) => i.key !== "bias:age").map((i) => i.verdict)).toEqual(["unknown", "unknown"]);
    // an engine error on an attempt: that item is unknown even though the run completed
    const errored = mapPromptfooResults({
      raw: output([result("prompt-extraction"), result("prompt-extraction", { success: false, failureReason: 2, error: "Error: provider returned malformed JSON" })]),
      exitCode: 0,
      plan,
    });
    expect(errored.items[0]).toMatchObject({ verdict: "unknown", attempts: 1 });
    expect(stored(errored).items[0]!.verdict).toBe("unknown");
    // output promptfoo did not write, or that does not parse: failed, no items
    expect(mapPromptfooResults({ raw: null, exitCode: 0, plan })).toMatchObject({ status: "failed", errorCode: "engine_output_missing", items: [] });
    expect(mapPromptfooResults({ raw: Buffer.from("{not json"), exitCode: 0, plan })).toMatchObject({ status: "failed", errorCode: "engine_output_invalid" });
    expect(mapPromptfooResults({ raw: Buffer.from('{"results":{}}'), exitCode: 0, plan })).toMatchObject({ status: "failed", errorCode: "engine_output_invalid" });
    // a result that is neither graded nor an error is not evidence
    const ungraded = mapPromptfooResults({ raw: output([{ metadata: { pluginId: "prompt-extraction" }, failureReason: 0 }]), exitCode: 0, plan });
    expect(ungraded.items[0]).toMatchObject({ verdict: "unknown", attempts: 0 });
  });

  it("RED PROOF egress denied → not_run: every attempt failed to connect", () => {
    const body = mapPromptfooResults({
      raw: output([
        result("prompt-extraction"),
        result("pii:direct", { success: false, failureReason: 2, error: "request to https://collector.example/x failed, reason: getaddrinfo ENOTFOUND collector.example" }),
        result("pii:direct", { success: false, failureReason: 2, error: "TypeError: fetch failed (cause: ECONNREFUSED)" }),
      ]),
      exitCode: 0,
      plan,
    });
    expect(body.notRun).toContainEqual({ key: "pii:direct/basic", reason: "egress_denied" });
    const n = stored(body);
    expect(n.items.find((i) => i.key === "pii:direct/basic")).toMatchObject({ verdict: "not_run", notRunReason: "egress_denied" });
    expect(n.items.find((i) => i.key === "prompt-extraction/basic")!.verdict).toBe("pass");
  });

  it("RED PROOF budget spent → 401 mid-run: the 401s are unknown, the unreached plugin is not run, what was measured counts", () => {
    // captured from a real run whose gateway answered 401 virtual_key_revoked from the 8th call on;
    // promptfoo aborted the scan ("will not resolve on retry") and still exited 0
    const body = mapPromptfooResults({ raw: fixture("results-0.123.1-key-revoked.json"), exitCode: 0, plan });
    expect(body.status).toBe("completed");
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ key: "pii:direct/basic", verdict: "unknown", attempts: 2, defeated: 0 });
    expect(body.items[0]!.reason).toMatch(/refused the run's key/);
    expect(body.notRun).toContainEqual({ key: "prompt-extraction/basic", reason: "engine_error" });
    const n = stored(body);
    expect(n.counts.pass).toBe(0);
    expect(n.items[0]!.verdict).toBe("unknown");
    expect(classifyError('API error: 401 Unauthorized {"error":{"code":"virtual_key_revoked"}}')).toBe("key_revoked");
  });

  it("an unknown plugin, or an unattributed result, is unmapped and never passes", () => {
    const body = mapPromptfooResults({ raw: output([result("some-new-plugin"), result(null)]), exitCode: 0, plan: planPromptfooRun(["prompt-extraction"]) });
    expect(body.items.map((i) => [i.key, i.verdict])).toEqual([
      ["some-new-plugin/basic", "unknown"],
      ["unattributed", "unknown"],
    ]);
    const n = stored(body);
    const reported = n.items.filter((i) => i.key === "some-new-plugin/basic" || i.key === "unattributed");
    expect(reported.map((i) => [i.attackClass, i.verdict])).toEqual([
      [null, "unknown"],
      [null, "unknown"],
    ]);
    // the planned plugin that produced nothing is not run, never clean
    expect(n.items.find((i) => i.key === "prompt-extraction/basic")).toMatchObject({ verdict: "not_run", notRunReason: "engine_error" });
    expect(n.unmappedItems).toBe(3);
    expect(n.mappedItems).toBe(0);
  });
});

describe("the adapter", () => {
  const fakeRun = (script: (args: readonly string[]) => { exitCode: number; write?: [string, string] }) => {
    const calls: string[][] = [];
    return {
      calls,
      run: async (_cmd: string, args: readonly string[], opts: { cwd?: string; env: Record<string, string> }) => {
        calls.push([...args.slice(1, 3)]);
        const s = script(args);
        if (s.write) {
          const { writeFile } = await import("node:fs/promises");
          await writeFile(path.join(opts.cwd!, s.write[0]), s.write[1]);
        }
        expect(opts.env[RUN_KEY_ENV]).toBe(KEY);
        return { exitCode: s.exitCode, signal: null, killed: false, stdout: "", stderr: "" };
      },
    };
  };
  const ctx = async () => ({ workDir: await mkdtemp(path.join(tmpdir(), "pf-adapter-")), signal: new AbortController().signal, progress: () => {} });

  it("nothing runnable, or a refused config, never starts the engine", async () => {
    const f = fakeRun(() => ({ exitCode: 0 }));
    const a = promptfooAdapter({ entrypoint: "/x/entrypoint.js", run: f.run });
    const none = await a(lease({}, ["bias:age", "pliny"]), await ctx());
    expect(none).toMatchObject({ status: "not_run", errorCode: "nothing_runnable" });
    const noJudge = await a(lease({ judge: null }), await ctx());
    expect(noJudge).toMatchObject({ status: "not_run", errorCode: "judge_required" });
    expect(noJudge.notRun).toContainEqual({ key: "prompt-extraction/basic", reason: "engine_error" });
    const offGateway = await a(lease({ target: { ...lease().target!, baseUrl: "not a url" } }), await ctx());
    expect(offGateway).toMatchObject({ status: "not_run" });
    expect(f.calls).toEqual([]);
  });

  it("generate then the eval step; a failed generation is failed with no items", async () => {
    const ok = fakeRun((args) =>
      args[1] === "redteam" ? { exitCode: 0, write: ["redteam.yaml", "tests: []"] } : { exitCode: 0, write: ["results.json", fixture("results-0.123.1-pass.json").toString()] },
    );
    const body = await promptfooAdapter({ entrypoint: "/x/entrypoint.js", run: ok.run })(lease(), await ctx());
    expect(ok.calls).toEqual([["redteam", "generate"], ["eval", "-c"]]);
    expect(body.status).toBe("completed");
    const bad = fakeRun(() => ({ exitCode: 1 }));
    const failed = await promptfooAdapter({ entrypoint: "/x/entrypoint.js", run: bad.run })(lease(), await ctx());
    expect(failed).toMatchObject({ status: "failed", errorCode: "engine_generate_failed", items: [] });
    expect(bad.calls).toEqual([["redteam", "generate"]]);
  });

  it("RED PROOF cancel: a cancel heartbeat aborts the engine and nothing is posted", async () => {
    let aborted = false;
    const steps: string[] = [];
    const adapter = promptfooAdapter({
      entrypoint: "/x/entrypoint.js",
      // the generate step happens to finish cleanly at the moment the cancel lands (it wrote its
      // output and exited 0): the adapter must still not start the eval step
      run: (_cmd, args, opts) =>
        new Promise((resolve) => {
          steps.push(String(args[1]));
          const finished = async () => {
            aborted = true;
            const { writeFile } = await import("node:fs/promises");
            await writeFile(path.join(opts.cwd!, "redteam.yaml"), "tests: []");
            resolve({ exitCode: 0, signal: null, killed: false, stdout: "", stderr: "" });
          };
          if (opts.signal!.aborted) void finished();
          else opts.signal!.addEventListener("abort", () => void finished());
        }),
    });
    const posted: unknown[] = [];
    let beats = 0;
    const client = {
      lease: async () => lease(),
      heartbeat: async () => ({ cancel: ++beats > 1 }),
      result: async (_id: string, env: unknown) => {
        posted.push(env);
        return 200;
      },
    } as unknown as RunnerClient;
    const out = await runOnce(client, adapter, { engineId: "promptfoo", engineVersion: "0.123.1", workRoot: await mkdtemp(path.join(tmpdir(), "pf-cancel-")), heartbeatMs: 20 });
    expect(out.outcome).toBe("cancelled");
    expect(aborted).toBe(true);
    // the engine is not started again after the cancel (no eval step), and nothing is posted
    expect(steps).toEqual(["redteam"]);
    expect(posted).toEqual([]);
  });
});
