/**
 * ADR-0187 B5-G — the garak RUNNER's entrypoint (`node dist/main.js`), in the runner container: on the
 * internal `engines` network, holding the runner key on its state volume, never running garak
 * itself. ADR-0190 I5: each run's probes run in an executor's sandbox under the run's engine_worker placement; the
 * task bridge hands it the job (the run's key as the task secret), carries its gateway channel and writes its results
 * back into the exchange directories, so the exchange (exchange.ts) reads them as before. No worker container.
 *
 * Its life comes from the shared core (`runRunnerLoop`): token persistence, enrolment, the self-test
 * refresh, result retention, the `next` state machine. Its self-test adds the worker's own report
 * (selftest.ts): every usage-data switch as the worker has it, and the worker's isolation. No listening
 * port. The token is never logged.
 */
import path from "node:path";
import { ExecutorTaskBridge, FileRunnerKeyStore, pinnedImageDigest, runRunnerLoop, RunnerClient, RunnerObsoleteBuildError, runnerIssuerFromEnv } from "@regulait/engine-runner";
import { ENGINE_MANIFEST } from "@regulait/shared";
import { garakAdapter } from "./adapter.js";
import { ExchangeGarakExecutor } from "./exchange.js";
import { garakRunnerSelfTest } from "./selftest.js";
import { installedGarakVersion } from "./version.js";

// the manifest's switches for this engine (checked by image.test.ts against the Dockerfile)
export const GARAK_REQUIRED_SWITCHES = Object.keys(ENGINE_MANIFEST.garak.usageDataEnv);

async function main(): Promise<void> {
  const gatewayUrl = process.env.REGULAIT_GATEWAY_URL;
  if (!gatewayUrl) throw new Error("REGULAIT_GATEWAY_URL is required");
  // PR #205 review [55]: a digest-pinned reference that agrees with the reported digest, or no start
  const imageDigest = pinnedImageDigest(process.env.REGULAIT_ENGINE_IMAGE_REF, process.env.REGULAIT_ENGINE_IMAGE_DIGEST);
  const engineVersion = installedGarakVersion();
  const jobsRoot = process.env.REGULAIT_GARAK_JOBS_DIR ?? "/jobs";
  const resultsRoot = process.env.REGULAIT_GARAK_RESULTS_DIR ?? "/results";
  // ADR-0188 S7: the runner authenticates with its own key (private_key_jwt + DPoP); each proof names the request
  // under the gateway's issuer (REGULAIT_PUBLIC_URL), the same value the gateway is configured with
  // (it refuses to start without one: never a guess from the address it dials)
  const client = new RunnerClient({ gatewayUrl, issuer: runnerIssuerFromEnv(process.env) });
  const stateDir = process.env.REGULAIT_RUNNER_STATE_DIR ?? "/state";
  const store = new FileRunnerKeyStore(path.join(stateDir, "runner-key"));
  const executor = new ExchangeGarakExecutor(jobsRoot, resultsRoot);
  // at start this runner holds no run, so no job of any run may remain (each holds a run's key)
  const stale = await executor.reconcile(null);
  if (stale.length) console.log(`garak runner: removed ${stale.length} job(s) left by an earlier process`);
  // ADR-0190 I5: the only place garak runs is an executor's sandbox; its model calls come back through this bridge
  const bridge = new ExecutorTaskBridge({
    client,
    jobsRoot,
    resultsRoot,
    gatewayBaseUrl: process.env.REGULAIT_ENGINE_GATEWAY_URL ?? `${gatewayUrl.replace(/\/$/, "")}/v1`,
    log: (m) => console.log(`garak runner: ${m}`),
  });
  void bridge.run(new AbortController().signal);
  await runRunnerLoop(client, garakAdapter({ executor }), {
    engineId: "garak",
    engineVersion,
    imageDigest,
    workRoot: process.env.REGULAIT_WORK_DIR ?? "/work",
    retainRoot: path.join(stateDir, "undelivered"),
    store,
    enrollmentToken: process.env.REGULAIT_ENGINE_ENROLLMENT_TOKEN || null,
    registration: async () => ({
      name: `garak-${process.env.HOSTNAME ?? "runner"}`,
      imageDigest,
      engineVersion,
      selfTest: await garakRunnerSelfTest({ imageDigest, engineVersion, resultsRoot }),
    }),
    log: (m) => console.log(m),
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(async (e: unknown) => {
    console.error(`garak runner stopped: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof RunnerObsoleteBuildError) {
      setInterval(() => console.error(`garak runner parked: ${e.message}`), 24 * 3_600_000);
      return;
    }
    await new Promise((res) => setTimeout(res, 60_000));
    process.exit(1);
  });
}
