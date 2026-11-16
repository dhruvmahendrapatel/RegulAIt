/**
 * ADR-0242 §6.1 (as spikee's and modelscan's, ADR-0187 decisions 104 and 141) — the WORKER's own self-test, reported
 * through the runner, for the manifest's one worker-attested switch (`REGULAIT_MCPSCANNER_OFFLINE_ANALYZERS_ONLY` /
 * `REGULAIT_SKILLSCANNER_OFFLINE_ANALYZERS_ONLY`).
 *
 * The scanner runs only in the task's sandbox, so the task probes from inside it at the start of every task (name
 * resolution, a TCP connect by name, a public literal address), checks the environment it starts the driver with (the
 * offline switch set, no remote-analyzer credential: REMOTE_ANALYZER_ENV), checks that it can see no runner
 * credential, records its runtime (ADR-0190 decision 10: recorded, never decisive) and writes the outcome with the
 * engine version it runs to `.worker-selftest.json`, which the bridge brings back to the runner's results directory.
 *
 * The runner reports the switch true only when that report is fresh, names the pinned version and passes every check.
 * Before the first enable no task has run, so there is no report: the switch is reported false and the gateway rests
 * it on a fresh executor attestation of the engine-worker profile instead (engine-worker-attestation.ts), never on
 * nothing. A stale or failing report keeps it false (fail closed).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { buildSelfTest, probeEgress, type EgressProbeOptions } from "@regulait/engine-runner";
import { isPublicAddress, sandboxRuntimeObservationSchema, type AdmissionScanEngineId, type RunnerSelfTest, type SandboxRuntimeObservation } from "@regulait/shared";
import { offlineSwitch, pinnedVersion, REMOTE_ANALYZER_ENV } from "./config.js";

export const WORKER_SELF_TEST_FILE = ".worker-selftest.json";
/** how old a worker report may be */
export const WORKER_SELF_TEST_MAX_AGE_MS = 2 * 3600 * 1000;
/** the runner credential's locations a worker must not see (the runner's defaults; ADR-0188 S7) */
export const RUNNER_CREDENTIAL_PATHS = ["/state/runner-key", "/state/runner-key.pending", "/state/runner-key.next"] as const;
export const RUNNER_CREDENTIAL_ENV = ["REGULAIT_ENGINE_ENROLLMENT_TOKEN"] as const;

const reportSchema = z
  .object({
    at: z.string().datetime(),
    engine: z.enum(["mcpscanner", "skillscanner"]),
    engineVersion: z.string().max(64),
    usageDataEnv: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), z.boolean()),
    remoteAnalyzerEnvSet: z.boolean(),
    runnerCredentialVisible: z.boolean(),
    egress: z
      .object({
        host: z.string().max(253),
        dnsResolved: z.boolean(),
        connected: z.boolean(),
        address: z.string().max(45).nullable(),
        addressConnected: z.boolean(),
      })
      .strict(),
    runtime: sandboxRuntimeObservationSchema.optional(),
  })
  .strict();
export type WorkerSelfTest = z.infer<typeof reportSchema>;

/** does the report show the sandbox reached anything, or the worker see something it must not? */
export function workerSelfTestBlocks(r: WorkerSelfTest): boolean {
  return r.egress.dnsResolved || r.egress.connected || r.egress.addressConnected || r.runnerCredentialVisible || r.remoteAnalyzerEnvSet;
}

/** the worker writes its report (atomically), judging `env`: the environment it starts the driver with */
export async function writeWorkerSelfTest(
  resultsRoot: string,
  args: { engine: AdmissionScanEngineId; engineVersion: string; env: Record<string, string | undefined>; egress?: EgressProbeOptions; credentialPaths?: readonly string[]; now?: Date; runtime?: SandboxRuntimeObservation },
): Promise<WorkerSelfTest> {
  const sw = offlineSwitch(args.engine);
  const remoteAnalyzerEnvSet = REMOTE_ANALYZER_ENV[args.engine].some((n) => (args.env[n] ?? "") !== "");
  const runnerCredentialVisible =
    RUNNER_CREDENTIAL_ENV.some((n) => (args.env[n] ?? process.env[n] ?? "") !== "") || (args.credentialPaths ?? RUNNER_CREDENTIAL_PATHS).some((p) => existsSync(p));
  const egress = await probeEgress(args.egress);
  const report: WorkerSelfTest = {
    at: (args.now ?? new Date()).toISOString(),
    engine: args.engine,
    engineVersion: args.engineVersion,
    usageDataEnv: { [sw]: args.env[sw] === "1" && !remoteAnalyzerEnvSet },
    remoteAnalyzerEnvSet,
    runnerCredentialVisible,
    egress,
    ...(args.runtime ? { runtime: args.runtime } : {}),
  };
  const file = path.join(resultsRoot, WORKER_SELF_TEST_FILE);
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(report), { mode: 0o640 });
  await rename(tmp, file);
  return report;
}

/** the runner's judgement of the worker's report: every condition must hold, and each failure is named */
export async function judgeWorkerSelfTest(engine: AdmissionScanEngineId, resultsRoot: string, now = new Date()): Promise<{ passed: boolean; failures: string[] }> {
  let report: WorkerSelfTest;
  try {
    const parsed = reportSchema.safeParse(JSON.parse(await readFile(path.join(resultsRoot, WORKER_SELF_TEST_FILE), "utf8")));
    if (!parsed.success) return { passed: false, failures: ["worker_report_invalid"] };
    report = parsed.data;
  } catch {
    return { passed: false, failures: ["worker_report_missing"] };
  }
  const failures: string[] = [];
  const age = now.getTime() - Date.parse(report.at);
  if (!(age >= -300_000 && age <= WORKER_SELF_TEST_MAX_AGE_MS)) failures.push("worker_report_stale");
  if (report.engine !== engine) failures.push("worker_engine_mismatch");
  if (report.engineVersion !== pinnedVersion(engine)) failures.push("worker_version_mismatch");
  const sw = offlineSwitch(engine);
  if (report.usageDataEnv[sw] !== true) failures.push(`worker_switch_missing:${sw}`);
  if (report.remoteAnalyzerEnvSet) failures.push("worker_remote_analyzer_env");
  if (report.runnerCredentialVisible) failures.push("worker_sees_runner_credential");
  if (report.egress.dnsResolved) failures.push("worker_dns_resolved");
  if (report.egress.connected) failures.push("worker_connected");
  if (!isPublicAddress(report.egress.address)) failures.push("worker_address_missing");
  else if (report.egress.addressConnected) failures.push("worker_address_connected");
  return { passed: failures.length === 0, failures };
}

/** the runner's self-test: its own egress probe, and the worker-attested switch from the worker's report */
export async function admissionRunnerSelfTest(args: {
  engine: AdmissionScanEngineId;
  imageDigest: string;
  engineVersion: string;
  resultsRoot: string;
  now?: Date;
  egress?: EgressProbeOptions;
  log?: (m: string) => void;
}): Promise<RunnerSelfTest> {
  const base = await buildSelfTest({ imageDigest: args.imageDigest, engineVersion: args.engineVersion, requiredEnv: {}, ...(args.egress ? { egress: args.egress } : {}), ...(args.now ? { now: args.now } : {}) });
  const worker = await judgeWorkerSelfTest(args.engine, args.resultsRoot, args.now);
  if (!worker.passed) (args.log ?? ((m: string) => console.error(m)))(`${args.engine} runner: no passing worker self-test yet (${worker.failures.join(", ")}); the switch rests on the executor's attestation`);
  return { ...base, usageDataEnv: { ...base.usageDataEnv, [offlineSwitch(args.engine)]: worker.passed } };
}
