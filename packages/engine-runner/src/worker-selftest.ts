/**
 * ADR-0187 decisions 104 and 141 / ADR-0242 §6.1 — THE WORKER SELF-TEST's generic part, shared by every engine whose
 * engine runs outside the runner's container (in a worker, or in a task's sandbox).
 *
 * The gateway reads only the runner's self-test, and the runner's egress probe runs in the runner's container. So the
 * worker probes from inside its own (name resolution, a TCP connect by name, a public literal address), checks that it
 * can see no runner credential (no enrolment token in its environment, no runner key file), and writes the outcome to
 * `.worker-selftest.json` in the results directory the runner reads. The engine adds its own fields (its id and version,
 * its usage-data or offline switches, its remote-credential check) and its own judgement of them; this module gives:
 *
 *   - the file name, the report's maximum age, the runner credential's locations and environment names;
 *   - the report schema around the engine's fields (strict: an unknown field makes the report invalid);
 *   - the sandbox observation (credential in reach, egress) and the atomic write;
 *   - the read (missing or invalid → a named failure), the freshness check and the isolation failures.
 *
 * Fail closed throughout: a missing, invalid, stale or failing report never counts as a pass.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isPublicAddress, sandboxRuntimeObservationSchema, type SandboxRuntimeObservation } from "@regulait/shared";
import { probeEgress, type EgressProbeOptions, type EgressProbeResult } from "./egress.js";

export const WORKER_SELF_TEST_FILE = ".worker-selftest.json";
/** how old a worker report may be (a worker rewrites it at least every hour) */
export const WORKER_SELF_TEST_MAX_AGE_MS = 2 * 3600 * 1000;
/** how far in the future a report's time may be (clock skew between the worker and the runner) */
export const WORKER_SELF_TEST_MAX_SKEW_MS = 300_000;
/** the runner credential's locations a worker must not see (the runner's defaults; ADR-0188 S7: its key, its pending enrolment, a rotation's next key) */
export const RUNNER_CREDENTIAL_PATHS = ["/state/runner-key", "/state/runner-key.pending", "/state/runner-key.next"] as const;
export const RUNNER_CREDENTIAL_ENV = ["REGULAIT_ENGINE_ENROLLMENT_TOKEN"] as const;

/** the egress probe's outcome as a worker report carries it */
export const workerEgressSchema = z
  .object({
    host: z.string().max(253),
    dnsResolved: z.boolean(),
    connected: z.boolean(),
    address: z.string().max(45).nullable(),
    addressConnected: z.boolean(),
  })
  .strict();

/** the fields every worker report carries */
export interface WorkerSelfTestCommon {
  at: string;
  usageDataEnv: Record<string, boolean>;
  runnerCredentialVisible: boolean;
  egress: EgressProbeResult;
  runtime?: SandboxRuntimeObservation | undefined;
}

/** a worker report's schema: the common fields and the engine's own (strict) */
export function workerSelfTestSchema<S extends z.ZodRawShape>(engineFields: S) {
  return z
    .object({
      at: z.string().datetime(),
      ...engineFields,
      usageDataEnv: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), z.boolean()),
      runnerCredentialVisible: z.boolean(),
      egress: workerEgressSchema,
      // ADR-0190 decision 10 (I5): the runtime the worker observed from inside its sandbox (recorded, never decisive)
      runtime: sandboxRuntimeObservationSchema.optional(),
    })
    .strict();
}

/** can the worker see a runner credential? (`env` first, then the process's own environment; then the key files) */
export function runnerCredentialVisible(env: Record<string, string | undefined>, credentialPaths: readonly string[] = RUNNER_CREDENTIAL_PATHS): boolean {
  return RUNNER_CREDENTIAL_ENV.some((n) => (env[n] ?? process.env[n] ?? "") !== "") || credentialPaths.some((p) => existsSync(p));
}

/** what the worker observes of its own sandbox: a runner credential in reach, and its egress */
export async function observeWorkerSandbox(args: { env: Record<string, string | undefined>; credentialPaths?: readonly string[]; egress?: EgressProbeOptions }): Promise<{ runnerCredentialVisible: boolean; egress: EgressProbeResult }> {
  const visible = runnerCredentialVisible(args.env, args.credentialPaths);
  const egress = await probeEgress(args.egress);
  return { runnerCredentialVisible: visible, egress };
}

/** the worker writes its report atomically (temp file, then rename), readable by the runner's group only */
export async function writeWorkerSelfTestFile(resultsRoot: string, report: WorkerSelfTestCommon): Promise<void> {
  const file = path.join(resultsRoot, WORKER_SELF_TEST_FILE);
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(report), { mode: 0o640 });
  await rename(tmp, file);
}

/** the runner reads the worker's report: the parsed report, or the one failure that names why there is none */
export async function readWorkerSelfTest<T>(resultsRoot: string, schema: z.ZodType<T>): Promise<{ report: T } | { failure: "worker_report_invalid" | "worker_report_missing" }> {
  try {
    const parsed = schema.safeParse(JSON.parse(await readFile(path.join(resultsRoot, WORKER_SELF_TEST_FILE), "utf8")));
    if (!parsed.success) return { failure: "worker_report_invalid" };
    return { report: parsed.data };
  } catch {
    return { failure: "worker_report_missing" };
  }
}

/** is the report fresh (not older than the maximum age, not further ahead than the allowed skew)? */
export function workerSelfTestFresh(report: { at: string }, now: Date = new Date()): boolean {
  const age = now.getTime() - Date.parse(report.at);
  return age >= -WORKER_SELF_TEST_MAX_SKEW_MS && age <= WORKER_SELF_TEST_MAX_AGE_MS;
}

/** the sandbox's isolation failures, each named: a runner credential in reach, and any egress (no public address probed fails too) */
export function workerIsolationFailures(report: Pick<WorkerSelfTestCommon, "runnerCredentialVisible" | "egress">): string[] {
  const failures: string[] = [];
  if (report.runnerCredentialVisible) failures.push("worker_sees_runner_credential");
  if (report.egress.dnsResolved) failures.push("worker_dns_resolved");
  if (report.egress.connected) failures.push("worker_connected");
  if (!isPublicAddress(report.egress.address)) failures.push("worker_address_missing");
  else if (report.egress.addressConnected) failures.push("worker_address_connected");
  return failures;
}

/** does the report show the sandbox reached anything, or the worker see a runner credential? (the worker's own stop) */
export function workerSandboxBlocks(report: Pick<WorkerSelfTestCommon, "runnerCredentialVisible" | "egress">): boolean {
  return report.egress.dnsResolved || report.egress.connected || report.egress.addressConnected || report.runnerCredentialVisible;
}
