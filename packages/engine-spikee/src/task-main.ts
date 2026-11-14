/**
 * ADR-0245 — the spikee TASK's entrypoint (`node /app/dist/task-main.js`, the manifest's `taskEntry`), as garak's
 * (ADR-0190 I5). It runs only as the workload of an `engine_worker` sandbox an executor started under the run's
 * placement:
 *
 *  - the read-only input is `/jobs/<runId>/job.json` (the datasets, the plugins, the target; the runner took the
 *    run's key OUT of it);
 *  - the run's key is the task secret, read from fd 3 (never env or argv), and goes back into the job only in this
 *    sandbox's scratch space, where each dataset's spikee environment is built from it (config.ts);
 *  - spikee reaches the gateway's chat route only through the gateway channel (a loopback proxy whose requests the
 *    runner sends to the gateway, `viaGatewayChannel`); the sandbox has no network of its own.
 *
 * First the worker's self-test, in this sandbox; a sandbox that reaches the network, or sees a runner credential,
 * runs nothing (fail closed).
 */
import { rm } from "node:fs/promises";
import { prepareJobCopy, runSandboxTask, sandboxRuntimeObservation, viaGatewayChannel, type SandboxTaskContext } from "@regulait/engine-runner/worker";
import { ENGINE_TASK_EGRESS_PROBE_ADDRESS, SPIKEE_USAGE_DATA_ENV } from "@regulait/shared";
import { writeWorkerSelfTest } from "./selftest.js";
import { installedSpikeeVersion } from "./version.js";
import { workerTick } from "./worker.js";

export async function spikeeTask(ctx: SandboxTaskContext): Promise<void> {
  if (ctx.secret === null || ctx.gatewayOrigin === null) throw new Error("a spikee task needs the run's key and the gateway channel");
  const report = await writeWorkerSelfTest(ctx.resultsRoot, {
    spikeeVersion: installedSpikeeVersion(),
    // the switches spikee's own processes are started with (config.ts builds each dataset's environment from them)
    env: { ...process.env, ...SPIKEE_USAGE_DATA_ENV },
    runtime: sandboxRuntimeObservation(),
    egress: { ip: ENGINE_TASK_EGRESS_PROBE_ADDRESS },
  });
  if (report.egress.dnsResolved || report.egress.connected || report.egress.addressConnected || report.runnerCredentialVisible) {
    throw new Error("the worker's sandbox reached the network or a runner credential; nothing was run");
  }
  const origin = ctx.gatewayOrigin;
  const secret = ctx.secret;
  const jobsRoot = await prepareJobCopy(ctx, (job) => {
    const target = job.target as { baseUrl: string };
    return { ...job, apiKey: secret, target: { ...target, baseUrl: viaGatewayChannel(target.baseUrl, origin) } };
  });
  try {
    await workerTick({ jobsRoot, resultsRoot: ctx.resultsRoot, workRoot: ctx.workRoot }, ctx.log);
  } finally {
    // the copy holding the run's key goes as soon as spikee is done
    await rm(jobsRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runSandboxTask({ gateway: true, run: spikeeTask }).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`spikee task stopped: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
