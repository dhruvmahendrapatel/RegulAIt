/**
 * ADR-0190 I5 — the garak TASK's entrypoint (`node /app/dist/task-main.js`, the manifest's `taskEntry`). It runs only
 * as the workload of an `engine_worker` sandbox an executor started under the run's placement (gVisor at L2):
 *
 *  - the read-only input is `/jobs/<runId>/job.json` (the probes, the target, the judge; the runner took the run's
 *    key OUT of it);
 *  - the run's key is the task secret, read from fd 3 (never env or argv), and goes back into the job only in this
 *    sandbox's scratch space, where garak's own per-probe environment is built from it (config.ts), as before;
 *  - garak reaches the gateway's model routes only through the gateway channel (decision 4: a loopback proxy whose
 *    requests the runner sends to the gateway, `viaGatewayChannel`); the sandbox has no network of its own.
 *
 * First the worker's self-test, in this sandbox, with its runtime probe (ADR-0190 decision 10: recorded, never
 * decisive); a sandbox that reaches the network, or sees a runner credential, runs nothing (fail closed).
 */
import { rm } from "node:fs/promises";
import { prepareJobCopy, runSandboxTask, sandboxRuntimeObservation, viaGatewayChannel, type SandboxTaskContext } from "@regulait/engine-runner/worker";
import { ENGINE_TASK_EGRESS_PROBE_ADDRESS, GARAK_USAGE_DATA_ENV } from "@regulait/shared";
import { writeWorkerSelfTest } from "./selftest.js";
import { installedGarakVersion } from "./version.js";
import { workerTick } from "./worker.js";

export async function garakTask(ctx: SandboxTaskContext): Promise<void> {
  if (ctx.secret === null || ctx.gatewayOrigin === null) throw new Error("a garak task needs the run's key and the gateway channel");
  const report = await writeWorkerSelfTest(ctx.resultsRoot, {
    garakVersion: installedGarakVersion(),
    // the switches garak's own processes are started with (config.ts builds each probe's environment from them)
    env: { ...process.env, ...GARAK_USAGE_DATA_ENV },
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
    // the copy holding the run's key goes as soon as garak is done
    await rm(jobsRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runSandboxTask({ gateway: true, run: garakTask }).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`garak task stopped: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
