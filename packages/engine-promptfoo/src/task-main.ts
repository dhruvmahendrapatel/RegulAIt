/**
 * ADR-0190 I5 — the promptfoo TASK's entrypoint (`node /app/dist/task-main.js`, the manifest's `taskEntry`). It runs
 * only as the workload of an `engine_worker` sandbox an executor started under the run's placement (gVisor at L2):
 *
 *  - the read-only input is `/jobs/<runId>/job.json` (the config, the gateway URL, the deadline; the runner took the
 *    run's key OUT of it);
 *  - the run's key is the task secret, read from fd 3 (never env or argv), and goes back into the job only in this
 *    sandbox's scratch space, where promptfoo's environment is built from it (config.ts), as before;
 *  - promptfoo reaches the gateway's model routes only through the gateway channel (decision 4): every place the job
 *    names the gateway's base URL is pointed at the loopback proxy, whose requests the runner sends to the gateway.
 *    `assertGatewayOnly` re-checks the rewritten config before promptfoo starts (job.ts / worker.ts).
 *
 * First the worker's self-test, in this sandbox, with its runtime probe (ADR-0190 decision 10: recorded, never
 * decisive); a sandbox that reaches the network, or sees a runner credential, runs nothing (fail closed).
 */
import { rm } from "node:fs/promises";
import { prepareJobCopy, runSandboxTask, sandboxRuntimeObservation, viaGatewayChannel, type SandboxTaskContext } from "@regulait/engine-runner/worker";
import { ENGINE_TASK_EGRESS_PROBE_ADDRESS } from "@regulait/shared";
import { installedPromptfooVersion, PROMPTFOO_HOME } from "./version.js";
import { promptfooWorkerTick } from "./worker.js";
import { writeWorkerSelfTest } from "./worker-selftest.js";

/** every string equal to `from`, anywhere in a JSON value, replaced by `to` (the gateway base URL in a config) */
export function replaceExactString(v: unknown, from: string, to: string): unknown {
  if (v === from) return to;
  if (Array.isArray(v)) return v.map((x) => replaceExactString(x, from, to));
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replaceExactString(x, from, to)]));
  return v;
}

export async function promptfooTask(ctx: SandboxTaskContext): Promise<void> {
  if (ctx.secret === null || ctx.gatewayOrigin === null) throw new Error("a promptfoo task needs the run's key and the gateway channel");
  const report = await writeWorkerSelfTest(ctx.resultsRoot, { promptfooVersion: installedPromptfooVersion(), runtime: sandboxRuntimeObservation(), egress: { ip: ENGINE_TASK_EGRESS_PROBE_ADDRESS } });
  const c = report.credential;
  if (report.egress.dnsResolved || report.egress.connected || report.egress.addressConnected || c.credentialEnv.length > 0 || c.stateEntries !== 0 || c.runnerProcessVisible) {
    throw new Error("the worker's sandbox reached the network or a runner credential; nothing was run");
  }
  const origin = ctx.gatewayOrigin;
  const secret = ctx.secret;
  const jobsRoot = await prepareJobCopy(ctx, (job) => {
    const base = String(job.baseUrl);
    const via = viaGatewayChannel(base, origin);
    return { ...(replaceExactString(job, base, via) as Record<string, unknown>), apiKey: secret };
  });
  try {
    await promptfooWorkerTick({ jobsRoot, resultsRoot: ctx.resultsRoot, workRoot: ctx.workRoot, promptfoo: { entrypoint: `${PROMPTFOO_HOME}/dist/src/entrypoint.js` } }, ctx.log);
  } finally {
    // the copy holding the run's key goes as soon as promptfoo is done
    await rm(jobsRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runSandboxTask({ gateway: true, run: promptfooTask }).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`promptfoo task stopped: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
