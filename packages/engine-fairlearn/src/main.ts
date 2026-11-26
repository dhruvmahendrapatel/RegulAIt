/**
 * ADR-0346 — the fairlearn RUNNER's entrypoint (`node dist/main.js`), as spikee's (ADR-0245, ADR-0190 I5): on the
 * internal `engines` network, holding the runner key on its state volume, NEVER calling a model or running fairlearn
 * itself, and never seeing a dataset row. Each run is handed to an executor's sandbox under the run's engine_worker
 * placement; the task bridge hands it the job (the run's key as the task secret), has the gateway place the
 * evaluation's input file at the task input's root (the job's `gateway-input.json` marker), carries the gateway
 * channel and writes the task's results back into the exchange directories.
 *
 * Its life comes from the shared core (`runRunnerLoop`). Its self-test adds the worker's own report (selftest.ts).
 * No listening port. The token is never logged.
 */
import path from "node:path";
import { ExecutorTaskBridge, FileRunnerKeyStore, pinnedImageDigest, runRunnerLoop, RunnerClient, RunnerObsoleteBuildError, runnerIssuerFromEnv } from "@regulait/engine-runner";
import { ENGINE_MANIFEST } from "@regulait/shared";
import { fairlearnAdapter } from "./adapter.js";
import { ExchangeFairlearnExecutor } from "./exchange.js";
import { fairlearnRunnerSelfTest } from "./selftest.js";
import { installedFairlearnVersion } from "./version.js";

// the manifest's switches for this engine (checked by image.test.ts against the Dockerfile)
export const FAIRLEARN_REQUIRED_SWITCHES = Object.keys(ENGINE_MANIFEST.fairlearn.usageDataEnv);

async function main(): Promise<void> {
  const gatewayUrl = process.env.REGULAIT_GATEWAY_URL;
  if (!gatewayUrl) throw new Error("REGULAIT_GATEWAY_URL is required");
  const imageDigest = pinnedImageDigest(process.env.REGULAIT_ENGINE_IMAGE_REF, process.env.REGULAIT_ENGINE_IMAGE_DIGEST);
  const engineVersion = installedFairlearnVersion();
  const jobsRoot = process.env.REGULAIT_FAIRLEARN_JOBS_DIR ?? "/jobs";
  const resultsRoot = process.env.REGULAIT_FAIRLEARN_RESULTS_DIR ?? "/results";
  const client = new RunnerClient({ gatewayUrl, issuer: runnerIssuerFromEnv(process.env) });
  const stateDir = process.env.REGULAIT_RUNNER_STATE_DIR ?? "/state";
  const store = new FileRunnerKeyStore(path.join(stateDir, "runner-key"));
  const executor = new ExchangeFairlearnExecutor(jobsRoot, resultsRoot);
  // at start this runner holds no run, so no job of any run may remain (each holds a run's key)
  const stale = await executor.reconcile(null);
  if (stale.length) console.log(`fairlearn runner: removed ${stale.length} job(s) left by an earlier process`);
  const bridge = new ExecutorTaskBridge({
    client,
    jobsRoot,
    resultsRoot,
    gatewayBaseUrl: process.env.REGULAIT_ENGINE_GATEWAY_URL ?? `${gatewayUrl.replace(/\/$/, "")}/v1`,
    log: (m) => console.log(`fairlearn runner: ${m}`),
  });
  void bridge.run(new AbortController().signal);
  await runRunnerLoop(client, fairlearnAdapter({ executor }), {
    engineId: "fairlearn",
    engineVersion,
    imageDigest,
    workRoot: process.env.REGULAIT_WORK_DIR ?? "/work",
    retainRoot: path.join(stateDir, "undelivered"),
    store,
    enrollmentToken: process.env.REGULAIT_ENGINE_ENROLLMENT_TOKEN || null,
    registration: async () => ({
      name: `fairlearn-${process.env.HOSTNAME ?? "runner"}`,
      imageDigest,
      engineVersion,
      selfTest: await fairlearnRunnerSelfTest({ imageDigest, engineVersion, resultsRoot }),
    }),
    log: (m) => console.log(m),
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(async (e: unknown) => {
    console.error(`fairlearn runner stopped: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof RunnerObsoleteBuildError) {
      setInterval(() => console.error(`fairlearn runner parked: ${e.message}`), 24 * 3_600_000);
      return;
    }
    await new Promise((res) => setTimeout(res, 60_000));
    process.exit(1);
  });
}
