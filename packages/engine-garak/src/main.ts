/**
 * ADR-0187 B5-G — the garak RUNNER's entrypoint (`node dist/main.js`), in the runner container: on the
 * internal `engines` network, holding the runner token on its state volume, never running garak
 * itself. Probes go to the worker container through the exchange volumes (exchange.ts).
 *
 * Its life comes from the shared core (`runRunnerLoop`): token persistence, enrolment, the self-test
 * refresh, result retention, the `next` state machine. Its self-test adds the worker's own report
 * (selftest.ts): every usage-data switch as the worker has it, and the worker's isolation. No listening
 * port. The token is never logged.
 */
import path from "node:path";
import { FileRunnerTokenStore, pinnedImageDigest, runRunnerLoop, RunnerClient, RunnerObsoleteBuildError } from "@regulait/engine-runner";
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
  const client = new RunnerClient({ gatewayUrl });
  const stateDir = process.env.REGULAIT_RUNNER_STATE_DIR ?? "/state";
  const store = new FileRunnerTokenStore(path.join(stateDir, "runner-token"));
  const executor = new ExchangeGarakExecutor(jobsRoot, resultsRoot);
  // at start this runner holds no run, so no job of any run may remain (each holds a run's key)
  const stale = await executor.reconcile(null);
  if (stale.length) console.log(`garak runner: removed ${stale.length} job(s) left by an earlier process`);
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
