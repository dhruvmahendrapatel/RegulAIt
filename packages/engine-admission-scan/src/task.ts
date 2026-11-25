/**
 * ADR-0242 §6.1 — the admission-scan TASK, inside the executor's sandbox (reached only from `task-main.ts`, which only
 * a sandbox init runs; the runner's entry never imports this module: `adr0190-i5-engine-runner-no-spawn.test.ts`).
 *
 *   - the input root is read-only and holds exactly the gateway's subject file (`runSandboxTask`'s `subjectFiles`
 *     checks that before this runs);
 *   - first the worker's self-test (selftest.ts), in this sandbox; a sandbox that reaches the network, or a worker
 *     that sees a runner credential or a remote-analyzer credential, scans nothing (fail closed);
 *   - then our driver, `python -I /opt/<id>/scan.py <input root> <results>/report.json` (ADR-0362: for the
 *     extractor, `python -I /opt/contentextract/extract.py <input root>/bundle.json <results>/report.json`), as a child
 *     process group bounded by `driverTimeoutMs`, with an environment built here (the sandbox init gives this process
 *     only PATH and HOME): the offline switch, a scratch HOME and TMPDIR, nothing else;
 *   - last `done.json`: the driver's exit, whether it was killed at its limit, and the report's sha256 (or that it was
 *     over the gateway's raw-report cap, in which case it is not sent). The report's content is never read here
 *     beyond hashing it, and never logged.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProcessGroup, sandboxRuntimeObservation, type SandboxTaskContext } from "@regulait/engine-runner/worker";
import { ENGINE_TASK_EGRESS_PROBE_ADDRESS, type SandboxRuntimeObservation } from "@regulait/shared";
import { admissionImagePaths, driverInputArg, driverTimeoutMs, offlineSwitch, type SubjectEngineId } from "./config.js";
import { ADMISSION_REPORT_MAX_BYTES, DONE_FILE, REPORT_FILE, type SubjectScanDone } from "./exchange.js";
import { workerSelfTestBlocks, writeWorkerSelfTest } from "./selftest.js";
import { installedAdmissionEngineVersion } from "./version.js";

export interface AdmissionTaskOptions {
  /** the driver command (default: the image's venv python, `-I`, the driver); tests substitute a stand-in */
  driver?: { command: string; args: readonly string[] };
  /** the installed engine version (default: read from the venv) */
  engineVersion?: () => string;
  timeoutMs?: number;
  /** seams for tests (the egress probe, the runtime probe, the runner-credential paths) */
  egress?: Parameters<typeof writeWorkerSelfTest>[1]["egress"];
  runtime?: () => SandboxRuntimeObservation;
  credentialPaths?: readonly string[];
}

async function writeDone(dir: string, done: SubjectScanDone): Promise<void> {
  const file = path.join(dir, DONE_FILE);
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(done), { mode: 0o600 });
  await rename(tmp, file);
}

/** the environment the driver is started with: nothing inherited, nothing secret */
export function driverEnv(engine: SubjectEngineId, scratch: string): Record<string, string> {
  return { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: scratch, TMPDIR: scratch, LANG: "C.UTF-8", [offlineSwitch(engine)]: "1" };
}

export function admissionScanTask(engine: SubjectEngineId, opts: AdmissionTaskOptions = {}): (ctx: SandboxTaskContext) => Promise<void> {
  return async (ctx) => {
    const out = path.join(ctx.resultsRoot, ctx.runId);
    const failClosed = (error: NonNullable<SubjectScanDone["error"]>) => writeDone(out, { exitCode: null, timedOut: false, reportSha256: null, reportTooLarge: false, error });
    await mkdir(ctx.workRoot, { recursive: true, mode: 0o700 });
    const scratch = path.join(ctx.workRoot, "scratch");
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const env = driverEnv(engine, scratch);
    const report = await writeWorkerSelfTest(ctx.resultsRoot, {
      engine,
      engineVersion: (opts.engineVersion ?? (() => installedAdmissionEngineVersion(engine)))(),
      env,
      runtime: (opts.runtime ?? sandboxRuntimeObservation)(),
      egress: opts.egress ?? { ip: ENGINE_TASK_EGRESS_PROBE_ADDRESS },
      ...(opts.credentialPaths ? { credentialPaths: opts.credentialPaths } : {}),
    });
    if (workerSelfTestBlocks(report)) {
      await failClosed("sandbox_not_isolated");
      throw new Error("the scanner's sandbox reached the network or a credential; nothing was scanned");
    }
    if (!ctx.subjectFile || !existsSync(ctx.subjectFile)) {
      await failClosed("subject_unreadable");
      throw new Error("the subject file is not in the task's input");
    }
    const reportPath = path.join(out, REPORT_FILE);
    const paths = admissionImagePaths(engine);
    const driver = opts.driver ?? { command: paths.python, args: ["-I", paths.driver] };
    // an admission driver reads the input ROOT (the one file there) and echoes what it read (`inputs`); the extractor
    // reads the bundle file itself (ADR-0362). Only the argument differs, never the driver or its environment
    const input = driverInputArg(engine, { inputRoot: ctx.jobsRoot, subjectFile: ctx.subjectFile });
    const run = await runProcessGroup(driver.command, [...driver.args, input, reportPath], { cwd: scratch, env, timeoutMs: opts.timeoutMs ?? driverTimeoutMs(engine), maxOutputBytes: 64 * 1024 });
    // the driver's own output is never kept or logged (it may name parts of the subject)
    await rm(scratch, { recursive: true, force: true });
    if (run.exitCode === null && !run.killed) {
      await rm(reportPath, { force: true });
      await failClosed("driver_not_started");
      return;
    }
    let reportSha256: string | null = null;
    let reportTooLarge = false;
    if (!run.killed && existsSync(reportPath)) {
      if ((await stat(reportPath)).size > ADMISSION_REPORT_MAX_BYTES) {
        reportTooLarge = true;
        await rm(reportPath, { force: true });
      } else reportSha256 = createHash("sha256").update(await readFile(reportPath)).digest("hex");
    } else await rm(reportPath, { force: true });
    await writeDone(out, { exitCode: run.exitCode, timedOut: run.killed, reportSha256, reportTooLarge, error: null });
    ctx.log(`${engine} task: driver exited ${run.exitCode ?? "killed"}`);
  };
}
