/**
 * ADR-0187 B5-M — the modelscan SCANNER's entrypoint (`node dist/scanner-main.js`), in the scanner
 * container: `network_mode: none`, read-only root, no capabilities, non-root, no state volume and no
 * runner token. It reads jobs from the read-only jobs volume, runs modelscan on each (scan.ts) and
 * writes the report to its one writable tmpfs (/out = the results volume). It also writes its own
 * egress self-test there every hour (selftest.ts), which the runner reports to the gateway.
 */
import { MODELSCAN_ENGINE_VERSION } from "@regulait/shared";
import { runScannerLoop } from "./exchange.js";
import { writeScannerSelfTest } from "./selftest.js";
import { installedModelscanVersion } from "./version.js";

const SELF_TEST_EVERY_MS = 3600 * 1000;

async function main(): Promise<void> {
  const jobsRoot = process.env.REGULAIT_MODELSCAN_JOBS_DIR ?? "/jobs";
  const resultsRoot = process.env.REGULAIT_MODELSCAN_RESULTS_DIR ?? "/out";
  const modelscanVersion = installedModelscanVersion();
  if (modelscanVersion !== MODELSCAN_ENGINE_VERSION) console.error(`modelscan scanner: installed ${modelscanVersion}, pinned ${MODELSCAN_ENGINE_VERSION}`);
  let lastSelfTest = 0;
  const refresh = async () => {
    if (Date.now() - lastSelfTest < SELF_TEST_EVERY_MS) return;
    lastSelfTest = Date.now();
    await writeScannerSelfTest(resultsRoot, { modelscanVersion });
  };
  await refresh();
  await runScannerLoop({ jobsRoot, resultsRoot, onIdle: refresh, log: (m) => console.log(m) });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(async (e: unknown) => {
    console.error(`modelscan scanner stopped: ${e instanceof Error ? e.message : String(e)}`);
    await new Promise((res) => setTimeout(res, 60_000));
    process.exit(1);
  });
}
