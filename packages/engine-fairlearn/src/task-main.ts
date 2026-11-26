/**
 * ADR-0346 — the fairlearn TASK's entrypoint (`node /app/dist/task-main.js`, the manifest's `taskEntry`), as spikee's
 * (ADR-0245, ADR-0190 I5). It runs only as the workload of an `engine_worker` sandbox an executor started under the
 * run's placement:
 *
 *  - the read-only input holds `/jobs/<runId>/job.json` (the run, the evaluation, the target; the runner took the
 *    run's key OUT of it) and, at the input ROOT, the gateway's own `/jobs/fairness-input.json` (the rows: prompts,
 *    labels, groups), which the runner never saw;
 *  - the run's key is the task secret, read from fd 3 (never env or argv), and goes back into the job only in this
 *    sandbox's scratch space;
 *  - the model is reached only through the gateway channel (a loopback proxy whose requests the runner sends to the
 *    gateway, `viaGatewayChannel`); the sandbox has no network of its own.
 *
 * First the worker's self-test, in this sandbox; a sandbox that reaches the network, or sees a runner credential,
 * runs nothing (fail closed, answered as `sandbox_not_isolated`).
 */
import path from "node:path";
import { rm } from "node:fs/promises";
import { prepareJobCopy, runSandboxTask, sandboxRuntimeObservation, viaGatewayChannel, type SandboxTaskContext } from "@regulait/engine-runner/worker";
import { ENGINE_TASK_EGRESS_PROBE_ADDRESS } from "@regulait/shared";
import { fairlearnMetricsEnv } from "./config.js";
import { workerSelfTestBlocks, writeWorkerSelfTest } from "./selftest.js";
import { installedFairlearnVersion } from "./version.js";
import { runFairlearnTaskWork, writeFairlearnError, type FairlearnWorkOptions } from "./worker.js";

export interface FairlearnTaskOptions {
  /** seams for tests: the work (the metric command), the version, the probes */
  work?: FairlearnWorkOptions;
  fairlearnVersion?: () => string;
  egress?: Parameters<typeof writeWorkerSelfTest>[1]["egress"];
  credentialPaths?: readonly string[];
}

export function fairlearnTask(opts: FairlearnTaskOptions = {}): (ctx: SandboxTaskContext) => Promise<void> {
  return async (ctx) => {
    if (ctx.secret === null || ctx.gatewayOrigin === null) throw new Error("a fairlearn task needs the run's key and the gateway channel");
    const report = await writeWorkerSelfTest(ctx.resultsRoot, {
      fairlearnVersion: (opts.fairlearnVersion ?? installedFairlearnVersion)(),
      // the environment the metric process is started with (config.ts builds it from nothing)
      env: fairlearnMetricsEnv(),
      runtime: sandboxRuntimeObservation(),
      egress: opts.egress ?? { ip: ENGINE_TASK_EGRESS_PROBE_ADDRESS },
      ...(opts.credentialPaths ? { credentialPaths: opts.credentialPaths } : {}),
    });
    if (workerSelfTestBlocks(report)) {
      await writeFairlearnError(path.join(ctx.resultsRoot, ctx.runId), "sandbox_not_isolated");
      throw new Error("the worker's sandbox reached the network or a runner credential; nothing was run");
    }
    const origin = ctx.gatewayOrigin;
    const secret = ctx.secret;
    const jobsRoot = await prepareJobCopy(ctx, (job) => {
      const target = job.target as { baseUrl: string };
      return { ...job, apiKey: secret, target: { ...target, baseUrl: viaGatewayChannel(target.baseUrl, origin) } };
    });
    try {
      // the gateway's file is read from the read-only input ROOT, never from the job directory
      await runFairlearnTaskWork({ runId: ctx.runId, jobsRoot, inputRoot: ctx.jobsRoot, resultsRoot: ctx.resultsRoot, workRoot: ctx.workRoot, ...(opts.work ? { work: opts.work } : {}) }, ctx.log);
    } finally {
      // the copy holding the run's key goes as soon as the work is done
      await rm(jobsRoot, { recursive: true, force: true });
    }
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runSandboxTask({ gateway: true, run: fairlearnTask() }).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`fairlearn task stopped: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
