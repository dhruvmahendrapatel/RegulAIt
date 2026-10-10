/**
 * ADR-0187 B5-G (decision 141) — the WORKER's own self-test, reported through the runner.
 *
 * The gateway reads only the runner's report, and the runner's egress probe runs in the runner's
 * container. garak runs in the worker, so the worker probes from inside its own container (the same
 * probe: name resolution, a TCP connect by name, and a public literal address), checks every usage-data
 * switch in its own environment, checks that it can see no runner credential (no enrolment token in its
 * environment, no runner token file), and writes the outcome with the garak version it runs to
 * `results/.worker-selftest.json`. The runner reports each switch as set only when that report sets it,
 * and the switch `REGULAIT_GARAK_WORKER_SELFTEST` only when the report is fresh, names the pinned version,
 * reached nothing outside and saw no runner credential. A missing, stale or failing worker report fails
 * the runner's self-test, so the engine cannot be enabled (fail closed).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { buildSelfTest, probeEgress, type EgressProbeOptions } from "@regulait/engine-runner";
import { GARAK_ENGINE_VERSION, GARAK_USAGE_DATA_ENV, GARAK_WORKER_SELF_TEST_SWITCH, isPublicAddress, type RunnerSelfTest } from "@regulait/shared";

export const WORKER_SELF_TEST_FILE = ".worker-selftest.json";
/** how old a worker report may be (the worker rewrites it every hour) */
export const WORKER_SELF_TEST_MAX_AGE_MS = 2 * 3600 * 1000;
/** the runner credential's locations a worker must not see (the runner's defaults) */
export const RUNNER_CREDENTIAL_PATHS = ["/state/runner-token", "/state/runner-token.pending"] as const;
export const RUNNER_CREDENTIAL_ENV = ["REGULAIT_ENGINE_ENROLLMENT_TOKEN"] as const;

const reportSchema = z
  .object({
    at: z.string().datetime(),
    garakVersion: z.string().max(64),
    usageDataEnv: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), z.boolean()),
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
  })
  .strict();
export type WorkerSelfTest = z.infer<typeof reportSchema>;

/** the worker writes its report (atomically) */
export async function writeWorkerSelfTest(
  resultsRoot: string,
  args: { garakVersion: string; env?: NodeJS.ProcessEnv; egress?: EgressProbeOptions; credentialPaths?: readonly string[]; now?: Date },
): Promise<WorkerSelfTest> {
  const env = args.env ?? process.env;
  const usageDataEnv: Record<string, boolean> = {};
  for (const [name, value] of Object.entries(GARAK_USAGE_DATA_ENV)) usageDataEnv[name] = env[name] === value;
  const runnerCredentialVisible =
    RUNNER_CREDENTIAL_ENV.some((n) => (env[n] ?? "") !== "") || (args.credentialPaths ?? RUNNER_CREDENTIAL_PATHS).some((p) => existsSync(p));
  const egress = await probeEgress(args.egress);
  const report: WorkerSelfTest = { at: (args.now ?? new Date()).toISOString(), garakVersion: args.garakVersion, usageDataEnv, runnerCredentialVisible, egress };
  const file = path.join(resultsRoot, WORKER_SELF_TEST_FILE);
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(report), { mode: 0o640 });
  await rename(tmp, file);
  return report;
}

/** the runner's judgement of the worker's report: every condition must hold, and each failure is named */
export async function judgeWorkerSelfTest(
  resultsRoot: string,
  now = new Date(),
): Promise<{ passed: boolean; failures: string[]; usageDataEnv: Record<string, boolean> }> {
  const off = Object.fromEntries(Object.keys(GARAK_USAGE_DATA_ENV).map((k) => [k, false]));
  let report: WorkerSelfTest;
  try {
    const parsed = reportSchema.safeParse(JSON.parse(await readFile(path.join(resultsRoot, WORKER_SELF_TEST_FILE), "utf8")));
    if (!parsed.success) return { passed: false, failures: ["worker_report_invalid"], usageDataEnv: off };
    report = parsed.data;
  } catch {
    return { passed: false, failures: ["worker_report_missing"], usageDataEnv: off };
  }
  const failures: string[] = [];
  const age = now.getTime() - Date.parse(report.at);
  const fresh = age >= -300_000 && age <= WORKER_SELF_TEST_MAX_AGE_MS;
  if (!fresh) failures.push("worker_report_stale");
  if (report.garakVersion !== GARAK_ENGINE_VERSION) failures.push("worker_version_mismatch");
  const usageDataEnv: Record<string, boolean> = {};
  for (const name of Object.keys(GARAK_USAGE_DATA_ENV)) {
    usageDataEnv[name] = fresh && report.usageDataEnv[name] === true;
    if (report.usageDataEnv[name] !== true) failures.push(`worker_switch_missing:${name}`);
  }
  if (report.runnerCredentialVisible) failures.push("worker_sees_runner_credential");
  if (report.egress.dnsResolved) failures.push("worker_dns_resolved");
  if (report.egress.connected) failures.push("worker_connected");
  if (!isPublicAddress(report.egress.address)) failures.push("worker_address_missing");
  else if (report.egress.addressConnected) failures.push("worker_address_connected");
  return { passed: failures.length === 0, failures, usageDataEnv };
}

/** the runner's self-test: its own egress probe, and every worker-side switch from the worker's report */
export async function garakRunnerSelfTest(args: { imageDigest: string; engineVersion: string; resultsRoot: string; now?: Date; egress?: EgressProbeOptions }): Promise<RunnerSelfTest> {
  const base = await buildSelfTest({ imageDigest: args.imageDigest, engineVersion: args.engineVersion, requiredEnv: {}, ...(args.egress ? { egress: args.egress } : {}), ...(args.now ? { now: args.now } : {}) });
  const worker = await judgeWorkerSelfTest(args.resultsRoot, args.now);
  if (!worker.passed) console.error(`garak runner: the worker's self-test does not pass (${worker.failures.join(", ")})`);
  return { ...base, usageDataEnv: { ...worker.usageDataEnv, [GARAK_WORKER_SELF_TEST_SWITCH]: worker.passed } };
}
