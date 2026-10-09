/**
 * ADR-0187 B5-M — the modelscan RUNNER's entrypoint (`node dist/main.js`), in the runner container:
 * on the internal `engines` network, holding the runner token on its state volume, never running
 * modelscan itself. Scans go to the scanner container through the exchange volumes (exchange.ts).
 *
 * Its life comes from the shared core (`runRunnerLoop`): token persistence, enrolment, the
 * self-test refresh, result retention, the `next` state machine. Its self-test adds one thing: the
 * scanner's own no-network report (selftest.ts), as the manifest's `REGULAIT_MODELSCAN_SCANNER_ISOLATED`
 * switch. No listening port. The token is never logged.
 */
import path from "node:path";
import { buildSelfTest, FileRunnerTokenStore, pinnedImageDigest, runRunnerLoop, RunnerClient, RunnerObsoleteBuildError } from "@regulait/engine-runner";
import { ENGINE_MANIFEST, type RunnerSelfTest } from "@regulait/shared";
import { modelscanAdapter } from "./adapter.js";
import { ExchangeScanExecutor } from "./exchange.js";
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
  const client = new RunnerClient({ gatewayUrl });
  const stateDir = process.env.REGULAIT_RUNNER_STATE_DIR ?? "/state";
  const store = new FileRunnerTokenStore(path.join(stateDir, "runner-token"));
  await runRunnerLoop(client, modelscanAdapter({ gatewayUrl, token: () => store.load(), executor: new ExchangeScanExecutor(jobsRoot, resultsRoot) }), {
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
