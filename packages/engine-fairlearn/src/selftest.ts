/**
 * ADR-0346 (as spikee's, ADR-0245; garak's ADR-0187 decision 141) — the fairlearn WORKER's own self-test, reported
 * through the runner.
 *
 * fairlearn runs only in the task's sandbox, so the task probes from inside it at the start of every task (name
 * resolution, a TCP connect by name, a public literal address), checks every usage-data switch in the environment it
 * starts the metric process with (FAIRLEARN_USAGE_DATA_ENV), checks that it can see no runner credential, records its
 * runtime (ADR-0190 decision 10: recorded, never decisive) and writes the outcome with the fairlearn version it runs to
 * `.worker-selftest.json`, which the bridge brings back to the runner's results directory. The runner reports each
 * switch as set only when that report sets it, and `REGULAIT_FAIRLEARN_WORKER_SELFTEST` only when the report is fresh,
 * names the pinned version, reached nothing outside and saw no runner credential (fail closed).
 *
 * The generic part (the file, its age, the credential locations, the common fields, the sandbox observation, the
 * atomic write, the read, freshness and the isolation failures) is engine-runner's shared worker self-test.
 */
import { z } from "zod";
import {
  buildSelfTest,
  observeWorkerSandbox,
  readWorkerSelfTest,
  workerIsolationFailures,
  workerSandboxBlocks,
  workerSelfTestFresh,
  workerSelfTestSchema,
  writeWorkerSelfTestFile,
  type EgressProbeOptions,
} from "@regulait/engine-runner";
import { FAIRLEARN_ENGINE_VERSION, FAIRLEARN_USAGE_DATA_ENV, FAIRLEARN_WORKER_SELF_TEST_SWITCH, type RunnerSelfTest, type SandboxRuntimeObservation } from "@regulait/shared";

export { RUNNER_CREDENTIAL_ENV, RUNNER_CREDENTIAL_PATHS, WORKER_SELF_TEST_FILE, WORKER_SELF_TEST_MAX_AGE_MS } from "@regulait/engine-runner";

const reportSchema = workerSelfTestSchema({ fairlearnVersion: z.string().max(64) });
export type WorkerSelfTest = z.infer<typeof reportSchema>;

/** does the report show the sandbox reached anything, or the worker see a runner credential? */
export function workerSelfTestBlocks(r: WorkerSelfTest): boolean {
  return workerSandboxBlocks(r);
}

/** the worker writes its report (atomically), judging `env`: the environment it starts the metric process with */
export async function writeWorkerSelfTest(
  resultsRoot: string,
  args: { fairlearnVersion: string; env: Record<string, string | undefined>; egress?: EgressProbeOptions; credentialPaths?: readonly string[]; now?: Date; runtime?: SandboxRuntimeObservation },
): Promise<WorkerSelfTest> {
  const usageDataEnv: Record<string, boolean> = {};
  for (const [name, value] of Object.entries(FAIRLEARN_USAGE_DATA_ENV)) usageDataEnv[name] = args.env[name] === value;
  const { runnerCredentialVisible, egress } = await observeWorkerSandbox({ env: args.env, ...(args.credentialPaths ? { credentialPaths: args.credentialPaths } : {}), ...(args.egress ? { egress: args.egress } : {}) });
  const report: WorkerSelfTest = {
    at: (args.now ?? new Date()).toISOString(),
    fairlearnVersion: args.fairlearnVersion,
    usageDataEnv,
    runnerCredentialVisible,
    egress,
    ...(args.runtime ? { runtime: args.runtime } : {}),
  };
  await writeWorkerSelfTestFile(resultsRoot, report);
  return report;
}

/** the runner's judgement of the worker's report: every condition must hold, and each failure is named */
export async function judgeWorkerSelfTest(resultsRoot: string, now = new Date()): Promise<{ passed: boolean; failures: string[]; usageDataEnv: Record<string, boolean> }> {
  const off = Object.fromEntries(Object.keys(FAIRLEARN_USAGE_DATA_ENV).map((k) => [k, false]));
  const read = await readWorkerSelfTest(resultsRoot, reportSchema);
  if ("failure" in read) return { passed: false, failures: [read.failure], usageDataEnv: off };
  const report = read.report;
  const failures: string[] = [];
  const fresh = workerSelfTestFresh(report, now);
  if (!fresh) failures.push("worker_report_stale");
  if (report.fairlearnVersion !== FAIRLEARN_ENGINE_VERSION) failures.push("worker_version_mismatch");
  const usageDataEnv: Record<string, boolean> = {};
  for (const name of Object.keys(FAIRLEARN_USAGE_DATA_ENV)) {
    usageDataEnv[name] = fresh && report.usageDataEnv[name] === true;
    if (report.usageDataEnv[name] !== true) failures.push(`worker_switch_missing:${name}`);
  }
  failures.push(...workerIsolationFailures(report));
  return { passed: failures.length === 0, failures, usageDataEnv };
}

/** the runner's self-test: its own egress probe, and every worker-side switch from the worker's report */
export async function fairlearnRunnerSelfTest(args: {
  imageDigest: string;
  engineVersion: string;
  resultsRoot: string;
  now?: Date;
  egress?: EgressProbeOptions;
  log?: (m: string) => void;
}): Promise<RunnerSelfTest> {
  const base = await buildSelfTest({ imageDigest: args.imageDigest, engineVersion: args.engineVersion, requiredEnv: {}, ...(args.egress ? { egress: args.egress } : {}), ...(args.now ? { now: args.now } : {}) });
  const worker = await judgeWorkerSelfTest(args.resultsRoot, args.now);
  if (!worker.passed) (args.log ?? ((m: string) => console.error(m)))(`fairlearn runner: the worker's self-test does not pass (${worker.failures.join(", ")})`);
  return { ...base, usageDataEnv: { ...worker.usageDataEnv, [FAIRLEARN_WORKER_SELF_TEST_SWITCH]: worker.passed } };
}
