/**
 * ADR-0187 B5-P2 — the WORKER's own self-test, reported through the runner (the modelscan scanner
 * pattern, decision 104).
 *
 * The gateway reads only the runner's report, and the runner's probes run in the runner's
 * container. The container that runs promptfoo is the worker's, so the worker proves two things from
 * inside itself and writes them to `results/.worker-selftest.json`:
 *   - EGRESS: the same probe as the runner's (name resolution, a connect by name, a public literal
 *     address): nothing off the gateway is reachable;
 *   - NO RUNNER CREDENTIAL IN REACH: no enrolment token and no runner-token-shaped value in its
 *     environment; nothing in the runner state directory (the image ships it empty; the runner's
 *     volume is mounted only in the runner container); and no runner process visible in `/proc`
 *     (the worker has its own PID namespace, so it cannot read the runner's memory, environment or
 *     file descriptors).
 * The runner reports the switch `REGULAIT_PROMPTFOO_WORKER_ISOLATED` (one of the manifest's
 * usage-data entries for promptfoo) as true only when that report is fresh, names the pinned
 * promptfoo version, reached nothing and found no credential. A missing, stale or failing report
 * fails the self-test, so the engine cannot be enabled (fail closed).
 */
import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { probeEgress, type EgressProbeOptions, type EgressProbeResult } from "@regulait/engine-runner";
import { ENGINE_ENROLLMENT_TOKEN_PREFIX, ENGINE_RUNNER_TOKEN_PREFIX, isPublicAddress, PROMPTFOO_ENGINE_VERSION } from "@regulait/shared";

export const WORKER_SELF_TEST_FILE = ".worker-selftest.json";
/** the manifest's usage-data entry the runner derives from the worker's report */
export const WORKER_ISOLATED_SWITCH = "REGULAIT_PROMPTFOO_WORKER_ISOLATED";
/** how old a worker report may be (the worker rewrites it every hour) */
export const WORKER_SELF_TEST_MAX_AGE_MS = 2 * 3600 * 1000;
/** the runner's entrypoint in the image (the worker's is worker-main.js) */
export const RUNNER_ENTRY_SUFFIX = "/dist/main.js";

const credentialSchema = z
  .object({
    /** names of environment variables that carry an enrolment token or a runner-token-shaped value */
    credentialEnv: z.array(z.string().max(128)).max(64),
    /** entries in the runner state directory (-1: it could not be read) */
    stateEntries: z.number().int().min(-1),
    /** a runner process is visible in this container's /proc */
    runnerProcessVisible: z.boolean(),
  })
  .strict();
export type WorkerCredentialReach = z.infer<typeof credentialSchema>;

const reportSchema = z
  .object({
    at: z.string().datetime(),
    promptfooVersion: z.string().max(64),
    egress: z
      .object({
        host: z.string().max(253),
        dnsResolved: z.boolean(),
        connected: z.boolean(),
        address: z.string().max(45).nullable(),
        addressConnected: z.boolean(),
      })
      .strict(),
    credential: credentialSchema,
  })
  .strict();
export type WorkerSelfTest = z.infer<typeof reportSchema>;

/** what of the runner's credential this container can reach (every field must come back empty) */
export async function workerCredentialReach(opts: { env?: NodeJS.ProcessEnv; stateDir?: string; procRoot?: string; selfPid?: number } = {}): Promise<WorkerCredentialReach> {
  const env = opts.env ?? process.env;
  const credentialEnv = Object.entries(env)
    .filter(([name, v]) => name === "REGULAIT_ENGINE_ENROLLMENT_TOKEN" || (typeof v === "string" && (v.startsWith(ENGINE_RUNNER_TOKEN_PREFIX) || v.startsWith(ENGINE_ENROLLMENT_TOKEN_PREFIX))))
    .map(([name]) => name)
    .slice(0, 64);
  const stateDir = opts.stateDir ?? env.REGULAIT_RUNNER_STATE_DIR ?? "/state";
  let stateEntries: number;
  try {
    stateEntries = (await readdir(stateDir)).length;
  } catch (e) {
    // absent is fine (nothing there); anything else (unreadable) is not evidence of absence
    stateEntries = (e as NodeJS.ErrnoException).code === "ENOENT" ? 0 : -1;
  }
  const procRoot = opts.procRoot ?? "/proc";
  const self = String(opts.selfPid ?? process.pid);
  let runnerProcessVisible = false;
  for (const pid of await readdir(procRoot).catch(() => [] as string[])) {
    if (!/^\d+$/.test(pid) || pid === self) continue;
    const cmdline = await readFile(path.join(procRoot, pid, "cmdline"), "utf8").catch(() => "");
    if (cmdline.split("\0").some((arg) => arg.endsWith(RUNNER_ENTRY_SUFFIX))) {
      runnerProcessVisible = true;
      break;
    }
  }
  return { credentialEnv, stateEntries, runnerProcessVisible };
}

/** the worker writes its report (atomically) */
export async function writeWorkerSelfTest(
  resultsRoot: string,
  args: { promptfooVersion: string; egress?: EgressProbeOptions; reach?: Parameters<typeof workerCredentialReach>[0]; now?: Date },
): Promise<WorkerSelfTest> {
  const egress: EgressProbeResult = await probeEgress(args.egress);
  const credential = await workerCredentialReach(args.reach);
  const report: WorkerSelfTest = { at: (args.now ?? new Date()).toISOString(), promptfooVersion: args.promptfooVersion, egress, credential };
  const file = path.join(resultsRoot, WORKER_SELF_TEST_FILE);
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(report), { mode: 0o640 });
  await rename(tmp, file);
  return report;
}

/** the runner's judgement of the worker's report: every condition must hold, and each failure is named */
export async function judgeWorkerSelfTest(resultsRoot: string, now = new Date()): Promise<{ isolated: boolean; failures: string[] }> {
  let report: WorkerSelfTest;
  try {
    const parsed = reportSchema.safeParse(JSON.parse(await readFile(path.join(resultsRoot, WORKER_SELF_TEST_FILE), "utf8")));
    if (!parsed.success) return { isolated: false, failures: ["worker_report_invalid"] };
    report = parsed.data;
  } catch {
    return { isolated: false, failures: ["worker_report_missing"] };
  }
  const failures: string[] = [];
  const age = now.getTime() - Date.parse(report.at);
  if (!(age >= -300_000 && age <= WORKER_SELF_TEST_MAX_AGE_MS)) failures.push("worker_report_stale");
  if (report.promptfooVersion !== PROMPTFOO_ENGINE_VERSION) failures.push("worker_version_mismatch");
  if (report.egress.dnsResolved) failures.push("worker_dns_resolved");
  if (report.egress.connected) failures.push("worker_connected");
  if (!isPublicAddress(report.egress.address)) failures.push("worker_address_missing");
  else if (report.egress.addressConnected) failures.push("worker_address_connected");
  if (report.credential.credentialEnv.length > 0) failures.push("worker_credential_in_env");
  if (report.credential.stateEntries !== 0) failures.push("worker_runner_state_reachable");
  if (report.credential.runnerProcessVisible) failures.push("worker_runner_process_visible");
  return { isolated: failures.length === 0, failures };
}
