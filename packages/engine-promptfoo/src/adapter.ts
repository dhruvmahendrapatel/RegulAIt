/**
 * ADR-0187 B5-P — THE PROMPTFOO ADAPTER: one lease → plan → config → `promptfoo redteam generate`
 * → `promptfoo eval` → mapped envelope body. Each promptfoo step is a child process group under the
 * run's abort signal and deadline (the runner core kills the whole group on cancel or deadline).
 *
 * Fail closed:
 *   - nothing runnable (every requested set is cloud-only, excluded, not pre-seeded or unknown)
 *     → `not_run` and the engine is never started;
 *   - a config the invariant refuses (`assertGatewayOnly`) → `not_run`, the engine never started;
 *   - generation that fails or writes nothing → `failed` (`engine_generate_failed`), no items;
 *   - an abort (cancel, deadline) → throws, and the runner core reports it (cancelled posts
 *     nothing; a deadline posts `timeout`);
 *   - everything else is decided by the mapper (an `eval` exit other than 0/100 is `failed`).
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProcessGroup, type EngineAdapter, type ProcessGroupOptions, type ProcessGroupResult } from "@regulait/engine-runner";
import { PROMPTFOO_STRATEGY_SET_PREFIX } from "@regulait/shared";
import {
  assertGatewayOnly,
  buildPromptfooConfig,
  buildPromptfooEnv,
  planPromptfooRun,
  PromptfooConfigRefused,
  type PromptfooPlan,
} from "./config.js";
import { mapPromptfooResults, notRunPairs, plannedPairs, type PromptfooEnvelopeBody } from "./mapper.js";

/**
 * PR #205 review round 3 [63]: the largest promptfoo result file the runner will read and parse.
 * The runner container's memory limit is 2 GiB (docker-compose.yml `x-engine-runner` mem_limit);
 * JSON.parse costs several times a file's size in heap, so the bound is 1/32 of that limit. A
 * larger file is never read: the run fails (every reading unknown) with `results_too_large`, and
 * only its sha256 is recorded, computed by streaming.
 */
export const PROMPTFOO_MAX_RESULTS_BYTES = 64 * 1024 * 1024;

async function sha256OfFile(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

export interface PromptfooAdapterOptions {
  /** promptfoo's CLI entrypoint, run with node (in the image: /opt/promptfoo/node_modules/promptfoo/dist/src/entrypoint.js) */
  entrypoint: string;
  /** the node binary (default: the runner's own) */
  nodeBin?: string;
  /** seam for tests */
  run?: (cmd: string, args: readonly string[], opts: ProcessGroupOptions) => Promise<ProcessGroupResult>;
  /** PATH handed to the child (nothing else is inherited) */
  path?: string;
  /** seam for tests: the results-file bound (default PROMPTFOO_MAX_RESULTS_BYTES) */
  maxResultsBytes?: number;
}

class Aborted extends Error {}

/** every planned pair not run for one reason (PR #205 review round 3 [62]: the mapper's own enumeration) */
function notRunAll(plan: PromptfooPlan, errorCode: string, status: "not_run" | "failed" = "not_run"): PromptfooEnvelopeBody {
  const pairs = notRunPairs(plannedPairs(plan), "engine_error", `not run: ${errorCode}`);
  // PR #205 review round 4 [66]: with no runnable plugin there are no pairs, so every requested
  // strategy is recorded on its own. The reason column admits only the migration-0173 vocabulary;
  // a dedicated `no_runnable_plugin` reason needs migration 0174 (asked, not added): until then it
  // is `engine_error` and the run's errorCode says `no_runnable_plugin`.
  const strategies = plan.plugins.length === 0 ? plan.strategies.map((s) => ({ key: `${PROMPTFOO_STRATEGY_SET_PREFIX}${s.id}`, reason: "engine_error" as const })) : [];
  return { status, errorCode, items: pairs.items, notRun: [...plan.notRun, ...pairs.notRun, ...strategies], rawReport: null };
}

export function promptfooAdapter(opts: PromptfooAdapterOptions): EngineAdapter {
  const run = opts.run ?? runProcessGroup;
  const node = opts.nodeBin ?? process.execPath;
  return async (lease, ctx) => {
    const plan = planPromptfooRun(lease.spec.config.sets);
    if (plan.plugins.length === 0) return notRunAll(plan, plan.strategies.length > 0 ? "no_runnable_plugin" : "nothing_runnable");
    let config: Record<string, unknown>;
    let env: Record<string, string>;
    try {
      config = buildPromptfooConfig(lease, plan);
      env = buildPromptfooEnv(lease, ctx.workDir, { PATH: opts.path ?? process.env.PATH });
      assertGatewayOnly(config, env, lease.target!.baseUrl);
    } catch (e) {
      if (e instanceof PromptfooConfigRefused) return notRunAll(plan, e.code);
      throw e;
    }
    const cfgPath = path.join(ctx.workDir, "redteam-config.json");
    const genPath = path.join(ctx.workDir, "redteam.yaml");
    const outPath = path.join(ctx.workDir, "results.json");
    await writeFile(cfgPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    const remaining = () => Math.max(1000, Date.parse(lease.deadlineAt) - Date.now());
    const step = async (args: string[]) => {
      if (ctx.signal.aborted) throw new Aborted("aborted");
      const r = await run(node, [opts.entrypoint, ...args], { cwd: ctx.workDir, env, signal: ctx.signal, timeoutMs: remaining() });
      if (ctx.signal.aborted || r.killed) throw new Aborted("aborted");
      return r;
    };
    const gen = await step(["redteam", "generate", "-c", cfgPath, "-o", genPath, "--no-cache", "--force", "--no-progress-bar", "-j", "1"]);
    if (gen.exitCode !== 0 || !existsSync(genPath)) {
      return notRunAll(plan, "engine_generate_failed", "failed");
    }
    ctx.progress(0.3);
    const evaluated = await step(["eval", "-c", genPath, "-o", outPath, "--no-cache", "--no-share", "--no-table", "--no-progress-bar", "-j", "1"]);
    ctx.progress(0.9);
    // [63] bounded BEFORE it is read: a file over the bound is hashed by streaming and never parsed
    const size = existsSync(outPath) ? (await stat(outPath)).size : null;
    if (size !== null && size > (opts.maxResultsBytes ?? PROMPTFOO_MAX_RESULTS_BYTES)) {
      return { ...notRunAll(plan, "results_too_large", "failed"), rawReport: { sha256: await sha256OfFile(outPath), bytes: 0 } };
    }
    const raw = size !== null ? await readFile(outPath) : null;
    return mapPromptfooResults({ raw, exitCode: evaluated.exitCode, plan, gatewayBaseUrl: lease.target!.baseUrl });
  };
}
