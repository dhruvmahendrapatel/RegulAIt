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
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProcessGroup, type EngineAdapter, type ProcessGroupOptions, type ProcessGroupResult } from "@regulait/engine-runner";
import {
  assertGatewayOnly,
  buildPromptfooConfig,
  buildPromptfooEnv,
  planPromptfooRun,
  PromptfooConfigRefused,
  type PromptfooPlan,
} from "./config.js";
import { mapPromptfooResults, type PromptfooEnvelopeBody } from "./mapper.js";

export interface PromptfooAdapterOptions {
  /** promptfoo's CLI entrypoint, run with node (in the image: /opt/promptfoo/node_modules/promptfoo/dist/src/entrypoint.js) */
  entrypoint: string;
  /** the node binary (default: the runner's own) */
  nodeBin?: string;
  /** seam for tests */
  run?: (cmd: string, args: readonly string[], opts: ProcessGroupOptions) => Promise<ProcessGroupResult>;
  /** PATH handed to the child (nothing else is inherited) */
  path?: string;
}

class Aborted extends Error {}

function notRunAll(plan: PromptfooPlan, errorCode: string): PromptfooEnvelopeBody {
  return {
    status: "not_run",
    errorCode,
    items: [],
    notRun: [...plan.notRun, ...plan.plugins.map((p) => ({ key: `${p.id}/basic`, reason: "engine_error" as const }))],
    rawReport: null,
  };
}

export function promptfooAdapter(opts: PromptfooAdapterOptions): EngineAdapter {
  const run = opts.run ?? runProcessGroup;
  const node = opts.nodeBin ?? process.execPath;
  return async (lease, ctx) => {
    const plan = planPromptfooRun(lease.spec.config.sets);
    if (plan.plugins.length === 0) return notRunAll(plan, "nothing_runnable");
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
      return { status: "failed", errorCode: "engine_generate_failed", items: [], notRun: plan.notRun, rawReport: null };
    }
    ctx.progress(0.3);
    const evaluated = await step(["eval", "-c", genPath, "-o", outPath, "--no-cache", "--no-share", "--no-table", "--no-progress-bar", "-j", "1"]);
    ctx.progress(0.9);
    const raw = existsSync(outPath) ? await readFile(outPath) : null;
    return mapPromptfooResults({ raw, exitCode: evaluated.exitCode, plan, gatewayBaseUrl: lease.target!.baseUrl });
  };
}
