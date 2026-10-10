/**
 * ADR-0187 B5-P — THE PROMPTFOO ADAPTER: one lease → plan → config → `promptfoo redteam generate`
 * → `promptfoo eval` → mapped envelope body. Each promptfoo step is a child process group under the
 * run's abort signal and deadline (the runner core kills the whole group on cancel or deadline).
 *
 * B5-P2 (ADR-0187 decisions 170 on): the adapter runs in the RUNNER container and never runs
 * promptfoo there. It hands a job (job.ts: the config, the gateway URL, the run key, the deadline)
 * to an executor; in the image that is the exchange to the worker container (exchange.ts), which
 * holds no runner credential. The runner token is not an input of this adapter at all.
 *
 * Fail closed:
 *   - nothing runnable (every requested set is cloud-only, excluded, not pre-seeded or unknown)
 *     → `not_run` and the engine is never started;
 *   - a config the invariant refuses (`assertGatewayOnly`, here and again in the worker) → `not_run`,
 *     the engine never started;
 *   - generation that fails or writes nothing → `failed` (`engine_generate_failed`), no items;
 *   - an abort (cancel, deadline) → throws, and the runner core reports it (cancelled posts
 *     nothing; a deadline posts `timeout`);
 *   - a results file that is not the one the worker hashed → `failed` (`results_inconsistent`);
 *   - everything else is decided by the mapper (an `eval` exit other than 0/100 is `failed`).
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { type EngineAdapter, type ProcessGroupOptions, type ProcessGroupResult } from "@regulait/engine-runner";
import { PROMPTFOO_STRATEGY_SET_PREFIX } from "@regulait/shared";
import {
  assertGatewayOnly,
  buildPromptfooConfig,
  buildPromptfooEnv,
  planPromptfooRun,
  PromptfooConfigRefused,
  type PromptfooPlan,
} from "./config.js";
import { LocalPromptfooExecutor, type PromptfooExecutor, type PromptfooJob } from "./job.js";
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
  /**
   * B5-P2: where promptfoo runs. The image's runner passes the exchange to the worker container
   * (exchange.ts), so promptfoo never runs where the runner token is. Default: this process's
   * container (`LocalPromptfooExecutor`, from `entrypoint`, `nodeBin`, `run` and `path`), for tests
   * and the opt-in real-engine test only.
   */
  executor?: PromptfooExecutor;
}

class Aborted extends Error {}

/** every planned pair not run for one reason (PR #205 review round 3 [62]: the mapper's own enumeration) */
function notRunAll(plan: PromptfooPlan, errorCode: string, status: "not_run" | "failed" = "not_run"): PromptfooEnvelopeBody {
  const pairs = notRunPairs(plannedPairs(plan), "engine_error", `not run: ${errorCode}`);
  // PR #205 review round 4 [66]: with no runnable plugin there are no pairs, so every requested
  // strategy is recorded on its own as `engine_error`, and the run's errorCode says
  // `no_runnable_plugin`. Strategy-only plans are rejected at validation, so this is a residual
  // path; decided with no new reason and no migration (ADR-0187 decision 66).
  const strategies = plan.plugins.length === 0 ? plan.strategies.map((s) => ({ key: `${PROMPTFOO_STRATEGY_SET_PREFIX}${s.id}`, reason: "engine_error" as const })) : [];
  return { status, errorCode, items: pairs.items, notRun: [...plan.notRun, ...pairs.notRun, ...strategies], rawReport: null };
}

export function promptfooAdapter(opts: PromptfooAdapterOptions): EngineAdapter {
  const executor =
    opts.executor ??
    new LocalPromptfooExecutor({
      entrypoint: opts.entrypoint,
      ...(opts.nodeBin ? { nodeBin: opts.nodeBin } : {}),
      ...(opts.run ? { run: opts.run } : {}),
      ...(opts.path ? { path: opts.path } : {}),
    });
  return async (lease, ctx) => {
    const plan = planPromptfooRun(lease.spec.config.sets);
    if (plan.plugins.length === 0) return notRunAll(plan, plan.strategies.length > 0 ? "no_runnable_plugin" : "nothing_runnable");
    let config: Record<string, unknown>;
    try {
      config = buildPromptfooConfig(lease, plan);
      const env = buildPromptfooEnv(lease, ctx.workDir, { PATH: opts.path ?? process.env.PATH });
      assertGatewayOnly(config, env, lease.target!.baseUrl);
    } catch (e) {
      if (e instanceof PromptfooConfigRefused) return notRunAll(plan, e.code);
      throw e;
    }
    // B5-P2: the job carries the config, the gateway URL, the RUN key and the deadline, nothing of
    // the runner's own
    const job: PromptfooJob = { runId: lease.runId, baseUrl: lease.target!.baseUrl, apiKey: lease.target!.apiKey, config, deadlineAt: lease.deadlineAt };
    try {
      if (ctx.signal.aborted) throw new Aborted("aborted");
      const outcome = await executor.execute(job, ctx);
      if (ctx.signal.aborted || outcome.aborted) throw new Aborted("aborted");
      // the worker re-checked the invariant and refused: promptfoo never started
      if (outcome.refused !== null) return notRunAll(plan, outcome.refused);
      if (!outcome.generated) return notRunAll(plan, "engine_generate_failed", "failed");
      ctx.progress(0.9);
      const outPath = outcome.results?.path ?? null;
      // [63] bounded BEFORE it is read: a file over the bound is hashed by streaming and never parsed
      const size = outPath !== null && existsSync(outPath) ? (await stat(outPath)).size : null;
      if (size !== null && size > (opts.maxResultsBytes ?? PROMPTFOO_MAX_RESULTS_BYTES)) {
        return { ...notRunAll(plan, "results_too_large", "failed"), rawReport: { sha256: await sha256OfFile(outPath!), bytes: 0 } };
      }
      const raw = size !== null ? await readFile(outPath!) : null;
      // B5-P2: a file that crossed the exchange must be the one the worker hashed (no torn or swapped write)
      if (raw !== null && outcome.results?.sha256 && createHash("sha256").update(raw).digest("hex") !== outcome.results.sha256) {
        return notRunAll(plan, "results_inconsistent", "failed");
      }
      return mapPromptfooResults({ raw, exitCode: outcome.evalExitCode, plan, gatewayBaseUrl: lease.target!.baseUrl });
    } finally {
      await executor.release(lease.runId);
    }
  };
}
