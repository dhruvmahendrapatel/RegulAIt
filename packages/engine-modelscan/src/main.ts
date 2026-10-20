/**
 * ADR-0187 B5-M — the modelscan RUNNER's entrypoint (`node dist/main.js`), in the runner container:
 * on the internal `engines` network, holding the runner key on its state volume, never running
 * modelscan itself. ADR-0190 I5: each scan runs in an executor's sandbox under the run's engine_worker placement;
 * the task bridge hands it the job (the artifact is placed by the gateway, never uploaded) and writes its results
 * back into the exchange directories, so the exchange (exchange.ts) reads them as before. No scanner container.
 *
 * Its life comes from the shared core (`runRunnerLoop`): token persistence, enrolment, the
 * self-test refresh, result retention, the `next` state machine. Its self-test adds one thing: the
 * scanner's own no-network report (selftest.ts), as the manifest's `REGULAIT_MODELSCAN_SCANNER_ISOLATED`
 * switch. No listening port. The token is never logged.
 */
import path from "node:path";
import { buildSelfTest, ExecutorTaskBridge, FileRunnerKeyStore, pinnedImageDigest, runRunnerLoop, RunnerClient, RunnerObsoleteBuildError, runnerIssuerFromEnv } from "@regulait/engine-runner";
import { ENGINE_MANIFEST, type RunnerSelfTest } from "@regulait/shared";
import { modelscanAdapter } from "./adapter.js";
import { ARTIFACT_NAME, ExchangeScanExecutor } from "./exchange.js";
import { judgeScannerSelfTest, SCANNER_ISOLATED_SWITCH } from "./selftest.js";
import { installedModelscanVersion } from "./version.js";

/** the runner's self-test, with the scanner's isolation judged from the scanner's own report */
export async function modelscanRunnerSelfTest(args: { imageDigest: string; engineVersion: string; resultsRoot: string; now?: Date }): Promise<RunnerSelfTest> {
  const base = await buildSelfTest({ imageDigest: args.imageDigest, engineVersion: args.engineVersion, requiredEnv: {} });
  const scanner = await judgeScannerSelfTest(args.resultsRoot, args.now);
  if (!scanner.isolated) console.error(`modelscan runner: the scanner's self-test does not pass (${scanner.failures.join(", ")})`);
  return { ...base, usageDataEnv: { ...base.usageDataEnv, [SCANNER_ISOLATED_SWITCH]: scanner.isolated } };
}

async function main(): Promise<void> {
  const gatewayUrl = process.env.REGULAIT_GATEWAY_URL;
  if (!gatewayUrl) throw new Error("REGULAIT_GATEWAY_URL is required");
  // PR #205 review [55]: a digest-pinned reference that agrees with the reported digest, or no start
  const imageDigest = pinnedImageDigest(process.env.REGULAIT_ENGINE_IMAGE_REF, process.env.REGULAIT_ENGINE_IMAGE_DIGEST);
  const engineVersion = installedModelscanVersion();
  const jobsRoot = process.env.REGULAIT_MODELSCAN_JOBS_DIR ?? "/jobs";
  const resultsRoot = process.env.REGULAIT_MODELSCAN_RESULTS_DIR ?? "/results";
  // ADR-0188 S7: the runner authenticates with its own key (private_key_jwt + DPoP); each proof names the request
  // under the gateway's issuer (REGULAIT_PUBLIC_URL), the same value the gateway is configured with
  // (it refuses to start without one: never a guess from the address it dials)
  const client = new RunnerClient({ gatewayUrl, issuer: runnerIssuerFromEnv(process.env) });
  const stateDir = process.env.REGULAIT_RUNNER_STATE_DIR ?? "/state";
  const store = new FileRunnerKeyStore(path.join(stateDir, "runner-key"));
  const executor = new ExchangeScanExecutor(jobsRoot, resultsRoot);
  // PR #212 review [4234946104]: at start this runner holds no run, so no job of any run may remain
  const stale = await executor.reconcile(null);
  if (stale.length) console.log(`modelscan runner: removed ${stale.length} job(s) left by an earlier process`);
  // ADR-0190 I5: the only place a scan runs is an executor's sandbox (the scanner calls nothing: no gateway channel)
  const bridge = new ExecutorTaskBridge({
    client,
    jobsRoot,
    resultsRoot,
    gatewayBaseUrl: process.env.REGULAIT_ENGINE_GATEWAY_URL ?? `${gatewayUrl.replace(/\/$/, "")}/v1`,
    isArtifact: (name) => ARTIFACT_NAME.test(name),
    log: (m) => console.log(`modelscan runner: ${m}`),
  });
  void bridge.run(new AbortController().signal);
  await runRunnerLoop(client, modelscanAdapter({ executor }), {
    engineId: "modelscan",
    engineVersion,
    imageDigest,
    workRoot: process.env.REGULAIT_WORK_DIR ?? "/work",
    retainRoot: path.join(stateDir, "undelivered"),
    store,
    enrollmentToken: process.env.REGULAIT_ENGINE_ENROLLMENT_TOKEN || null,
    registration: async () => ({
      name: `modelscan-${process.env.HOSTNAME ?? "runner"}`,
      imageDigest,
      engineVersion,
      selfTest: await modelscanRunnerSelfTest({ imageDigest, engineVersion, resultsRoot }),
    }),
    log: (m) => console.log(m),
  });
}

// the manifest's switch is this engine's only usage-data entry (checked by image.test.ts)
export const MODELSCAN_REQUIRED_SWITCHES = Object.keys(ENGINE_MANIFEST.modelscan.usageDataEnv);

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(async (e: unknown) => {
    console.error(`modelscan runner stopped: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof RunnerObsoleteBuildError) {
      setInterval(() => console.error(`modelscan runner parked: ${e.message}`), 24 * 3_600_000);
      return;
    }
    await new Promise((res) => setTimeout(res, 60_000));
    process.exit(1);
  });
}
