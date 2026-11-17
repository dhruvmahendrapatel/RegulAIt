/**
 * ADR-0242 §6.1 — the admission-scan TASK's entrypoint (`node /app/dist/task-main.js <engine>`, the manifest's
 * `taskEntry`). It runs only as the workload of an `engine_worker` sandbox an executor started under the run's
 * placement (the gVisor class at the `confidential` floor, ADR-0242 owner decision 6): the read-only input root holds
 * exactly the gateway's subject file, the sandbox has no network and no gateway channel (the scanner calls nothing),
 * there is no task secret, and the results go back as frames (`runSandboxTask`).
 *
 * The engine comes from the argv the manifest gives (the sandbox init passes the workload no environment but PATH
 * and HOME); anything but one of the two engines stops the task before it reads its input.
 */
import { runSandboxTask } from "@regulait/engine-runner/worker";
import { ADMISSION_SUBJECT_FILE, parseAdmissionEngine } from "./config.js";
import { admissionScanTask } from "./task.js";

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  let engine;
  try {
    engine = parseAdmissionEngine(process.argv[2]);
  } catch (e) {
    process.stderr.write(`admission-scan task refused: ${(e as Error).message}\n`);
    process.exit(64);
  }
  runSandboxTask({ gateway: false, subjectFiles: [ADMISSION_SUBJECT_FILE[engine]], run: admissionScanTask(engine) }).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`${engine} task stopped: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
