/**
 * ADR-0187 B5-P2 — the promptfoo WORKER's entrypoint (`node dist/worker-main.js`), in the worker
 * container: the same image as the runner, on the internal `engines` network (promptfoo's model
 * calls go to the gateway's compat routes on each job's run key), read-only root, no capabilities,
 * non-root, NO state volume, NO runner or enrolment token, its own PID namespace. It reads jobs from
 * the read-only jobs volume, runs promptfoo on each in its own /work, and writes the results to its
 * one shared writable volume (/out = the results volume). It also writes its own self-test there
 * every hour (worker-selftest.ts), which the runner reports to the gateway.
 */
import { PROMPTFOO_ENGINE_VERSION } from "@regulait/shared";
import { runPromptfooWorkerLoop } from "./exchange.js";
import { installedPromptfooVersion, PROMPTFOO_HOME } from "./version.js";
import { writeWorkerSelfTest } from "./worker-selftest.js";

const SELF_TEST_EVERY_MS = 3600 * 1000;

async function main(): Promise<void> {
  const jobsRoot = process.env.REGULAIT_PROMPTFOO_JOBS_DIR ?? "/jobs";
  const resultsRoot = process.env.REGULAIT_PROMPTFOO_RESULTS_DIR ?? "/out";
  const workRoot = process.env.REGULAIT_WORK_DIR ?? "/work";
  const promptfooVersion = installedPromptfooVersion();
  if (promptfooVersion !== PROMPTFOO_ENGINE_VERSION) console.error(`promptfoo worker: installed ${promptfooVersion}, pinned ${PROMPTFOO_ENGINE_VERSION}`);
  // on its own timer, so a long run never lets the report go stale (a stale report fails the
  // runner's self-test refresh, which switches the engine off)
  const refresh = () =>
    writeWorkerSelfTest(resultsRoot, { promptfooVersion }).catch((e: unknown) => console.error(`promptfoo worker: self-test not written: ${e instanceof Error ? e.message : String(e)}`));
  await refresh();
  setInterval(() => void refresh(), SELF_TEST_EVERY_MS);
  await runPromptfooWorkerLoop({
    jobsRoot,
    resultsRoot,
    workRoot,
    promptfoo: { entrypoint: `${PROMPTFOO_HOME}/dist/src/entrypoint.js` },
    log: (m) => console.log(m),
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(async (e: unknown) => {
    console.error(`promptfoo worker stopped: ${e instanceof Error ? e.message : String(e)}`);
    await new Promise((res) => setTimeout(res, 60_000));
    process.exit(1);
  });
}
