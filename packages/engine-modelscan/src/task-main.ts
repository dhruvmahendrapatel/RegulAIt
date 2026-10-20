/**
 * ADR-0190 I5 — the modelscan TASK's entrypoint (`node /app/dist/task-main.js`, the manifest's `taskEntry`). It runs
 * only as the workload of an `engine_worker` sandbox an executor started under the run's placement (gVisor at L2):
 * the read-only input is `/jobs/<runId>/` (the job and the run's artifact at `artifact.bin`, streamed by the gateway and
 * written and verified by the executor; the format is decided here, from its bytes), the
 * sandbox has no network at all (the scanner calls nothing, so no gateway channel is opened), and the results go
 * back as frames (`@regulait/engine-runner/worker`'s `runSandboxTask`).
 *
 * First the scanner's self-test, in this sandbox, with its runtime probe (ADR-0190 decision 10: recorded, never
 * decisive); a sandbox that reaches the network scans nothing (fail closed). Then the one job.
 */
import { mkdir } from "node:fs/promises";
import { runSandboxTask, sandboxRuntimeObservation, type SandboxTaskContext } from "@regulait/engine-runner/worker";
import { ENGINE_TASK_EGRESS_PROBE_ADDRESS } from "@regulait/shared";
import { writeScannerSelfTest } from "./selftest.js";
import { installedModelscanVersion } from "./version.js";
import { scannerTick } from "./worker.js";

export async function modelscanTask(ctx: SandboxTaskContext): Promise<void> {
  const report = await writeScannerSelfTest(ctx.resultsRoot, { modelscanVersion: installedModelscanVersion(), runtime: sandboxRuntimeObservation(), egress: { ip: ENGINE_TASK_EGRESS_PROBE_ADDRESS } });
  if (report.egress.dnsResolved || report.egress.connected || report.egress.addressConnected) {
    throw new Error("the scanner's sandbox reached the network; nothing was scanned");
  }
  await mkdir(ctx.workRoot, { recursive: true, mode: 0o700 });
  await scannerTick({ jobsRoot: ctx.jobsRoot, resultsRoot: ctx.resultsRoot, scratchRoot: ctx.workRoot }, ctx.log);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runSandboxTask({ gateway: false, run: modelscanTask }).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`modelscan task stopped: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
