/**
 * ADR-0187 B5-G — the garak WORKER's entrypoint (`node dist/worker-main.js`), in the worker container:
 * on the internal `engines` network (garak must reach the gateway's model routes), read-only root, no
 * capabilities, non-root, NO runner token and no state volume. It reads jobs from the read-only jobs
 * volume, runs one garak process per probe on its own tmpfs (/work), and writes each probe's report to
 * the results volume. It also writes its own self-test there every hour (selftest.ts), which the runner
 * reports to the gateway.
 */
import { GARAK_ENGINE_VERSION } from "@regulait/shared";
import { runWorkerLoop } from "./exchange.js";
import { writeWorkerSelfTest } from "./selftest.js";
import { installedGarakVersion } from "./version.js";

const SELF_TEST_EVERY_MS = 3600 * 1000;

async function main(): Promise<void> {
  const jobsRoot = process.env.REGULAIT_GARAK_JOBS_DIR ?? "/jobs";
  const resultsRoot = process.env.REGULAIT_GARAK_RESULTS_DIR ?? "/out";
  const workRoot = process.env.REGULAIT_WORK_DIR ?? "/work";
  const garakVersion = installedGarakVersion();
  if (garakVersion !== GARAK_ENGINE_VERSION) console.error(`garak worker: installed ${garakVersion}, pinned ${GARAK_ENGINE_VERSION}`);
  let lastSelfTest = 0;
  const refresh = async () => {
    if (Date.now() - lastSelfTest < SELF_TEST_EVERY_MS) return;
    lastSelfTest = Date.now();
    await writeWorkerSelfTest(resultsRoot, { garakVersion });
  };
  await refresh();
  await runWorkerLoop({ jobsRoot, resultsRoot, workRoot, onIdle: refresh, log: (m) => console.log(m) });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(async (e: unknown) => {
    console.error(`garak worker stopped: ${e instanceof Error ? e.message : String(e)}`);
    await new Promise((res) => setTimeout(res, 60_000));
    process.exit(1);
  });
}
