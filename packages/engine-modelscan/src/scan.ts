/**
 * ADR-0187 B5-M — ONE modelscan invocation, exactly as G19 prescribes:
 *
 *   modelscan scan -p <artifact> -r json -o <out>/report.json --show-skipped -l ERROR
 *                  --settings-file <our read-only settings>
 *
 * run as a child process group (killed whole at the time limit or on cancel), from a FRESH EMPTY
 * working directory under the output tmpfs (modelscan otherwise loads ./modelscan-settings.toml from
 * its working directory), with an environment built from nothing (no proxy, no user site, no
 * bytecode writes). The report is read from the `-o` file only, bounded before it is read; stdout is
 * never parsed (it is hard-wrapped at the console width).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { runProcessGroup, type ProcessGroupOptions, type ProcessGroupResult } from "@regulait/engine-runner";
import { MODELSCAN_MAX_REPORT_BYTES, NPY_OBJECT_PAYLOAD_MAX_BYTES, NPY_OBJECT_PAYLOAD_NAME, npyCheckSchema, type ArtifactFormat, type NpyCheck } from "@regulait/shared";
import { MODELSCAN_IMAGE_PATHS } from "./settings.js";

export interface ModelscanInvocation {
  /** the artifact, already named `artifact<ext>` (the extension of its REAL format) */
  artifactPath: string;
  /** a directory this scan owns (the report and the empty working directory go here) */
  outDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ModelscanOutcome {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  /** the `-o` report's bytes, or null when there is none (or it is over the bound) */
  report: Uint8Array | null;
  reportSha256: string | null;
  reportTooLarge: boolean;
}

export interface ModelscanRunnerOptions {
  modelscanBin?: string;
  settingsFile?: string;
  /** PATH for the child (the venv's bin only, by default) */
  path?: string;
  /** seam for tests: how modelscan is run (the `.npy` header check always runs for real) */
  run?: (cmd: string, args: readonly string[], opts: ProcessGroupOptions) => Promise<ProcessGroupResult>;
  /** the Python that runs the `.npy` header check (the venv's, by default) */
  python?: string;
  /** the `.npy` header check script (engines/modelscan/npy-header.py, baked read-only into the image) */
  npyHelper?: string;
}

/** the argv, fixed: nothing from the artifact or the lease reaches it except the two paths we chose */
export function modelscanArgs(artifactPath: string, reportPath: string, settingsFile: string): string[] {
  return ["scan", "-p", artifactPath, "-r", "json", "-o", reportPath, "--show-skipped", "-l", "ERROR", "--settings-file", settingsFile];
}

/** the child's whole environment */
export function modelscanEnv(cwd: string, pathVar: string): Record<string, string> {
  return {
    PATH: pathVar,
    HOME: cwd,
    LANG: "C.UTF-8",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONSAFEPATH: "1",
    PYTHONHASHSEED: "0",
    // rich (modelscan's console) must not probe a terminal
    TERM: "dumb",
    NO_COLOR: "1",
  };
}

export async function runModelscan(inv: ModelscanInvocation, opts: ModelscanRunnerOptions = {}): Promise<ModelscanOutcome> {
  // PR #212 review sweep [4234946096]: an already-aborted signal starts nothing
  if (inv.signal?.aborted) return { exitCode: null, timedOut: false, cancelled: true, report: null, reportSha256: null, reportTooLarge: false };
  const run = opts.run ?? runProcessGroup;
  const bin = opts.modelscanBin ?? MODELSCAN_IMAGE_PATHS.modelscanBin;
  const settings = opts.settingsFile ?? MODELSCAN_IMAGE_PATHS.settingsFile;
  const cwd = path.join(inv.outDir, "cwd");
  const reportPath = path.join(inv.outDir, "report.json");
  // a fresh, EMPTY working directory every time (never the artifact's directory)
  await rm(cwd, { recursive: true, force: true });
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  await rm(reportPath, { force: true });
  const r = await run(bin, modelscanArgs(inv.artifactPath, reportPath, settings), {
    cwd,
    env: modelscanEnv(cwd, opts.path ?? MODELSCAN_IMAGE_PATHS.venvBin),
    timeoutMs: Math.max(1000, inv.timeoutMs),
    ...(inv.signal ? { signal: inv.signal } : {}),
    maxOutputBytes: 64 * 1024,
  });
  const cancelled = Boolean(inv.signal?.aborted);
  const timedOut = r.killed && !cancelled;
  let report: Uint8Array | null = null;
  let reportSha256: string | null = null;
  let reportTooLarge = false;
  if (!r.killed && existsSync(reportPath)) {
    const size = (await stat(reportPath)).size;
    if (size > MODELSCAN_MAX_REPORT_BYTES) {
      reportTooLarge = true;
    } else {
      const bytes = await readFile(reportPath);
      report = bytes;
      reportSha256 = createHash("sha256").update(bytes).digest("hex");
    }
  }
  await rm(cwd, { recursive: true, force: true });
  return { exitCode: r.killed ? null : r.exitCode, timedOut, cancelled, report, reportSha256, reportTooLarge };
}

// ---------------------------------------------------------------------------------------------------
// ADR-0187 decisions 180–184 (closes open question 15(b)): `.npy` artifacts
// ---------------------------------------------------------------------------------------------------

/** what one scan job produced: modelscan's outcome and, for a `.npy`, the header check */
export interface ScanOutcome extends ModelscanOutcome {
  /** the `.npy` header check; null for every other format (and when the check was cut off) */
  npy: NpyCheck | null;
}

const NOTHING: ModelscanOutcome = { exitCode: null, timedOut: false, cancelled: false, report: null, reportSha256: null, reportTooLarge: false };
const CHECK_FAILED: NpyCheck = { kind: "invalid", problem: "npy_check_failed" };

/** the helper's argv: isolated, no site, stdlib only; nothing from the artifact but the paths we chose */
export function npyCheckArgs(helper: string, artifactPath: string, payloadPath: string): string[] {
  return ["-I", "-S", helper, artifactPath, payloadPath, String(NPY_OBJECT_PAYLOAD_MAX_BYTES)];
}

/**
 * Run the strict header check (engines/modelscan/npy-header.py) in this (the scanner's) container,
 * from a fresh empty working directory, with the same environment built from nothing as modelscan.
 * Anything but exit 0 and exactly one valid JSON answer is `npy_check_failed` (unknown).
 */
export async function runNpyCheck(
  inv: { artifactPath: string; payloadPath: string; timeoutMs: number; signal?: AbortSignal },
  opts: ModelscanRunnerOptions = {},
): Promise<{ check: NpyCheck | null; timedOut: boolean; cancelled: boolean }> {
  const cwd = path.join(path.dirname(inv.payloadPath), "cwd");
  await rm(cwd, { recursive: true, force: true });
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  try {
    const r = await runProcessGroup(opts.python ?? MODELSCAN_IMAGE_PATHS.python, npyCheckArgs(opts.npyHelper ?? MODELSCAN_IMAGE_PATHS.npyHelper, inv.artifactPath, inv.payloadPath), {
      cwd,
      env: modelscanEnv(cwd, opts.path ?? MODELSCAN_IMAGE_PATHS.venvBin),
      timeoutMs: Math.max(1000, inv.timeoutMs),
      ...(inv.signal ? { signal: inv.signal } : {}),
      maxOutputBytes: 4096,
    });
    const cancelled = Boolean(inv.signal?.aborted);
    if (r.killed) return { check: null, timedOut: !cancelled, cancelled };
    const lines = r.stdout.split("\n").filter((l) => l.length > 0);
    if (r.exitCode !== 0 || lines.length !== 1) return { check: CHECK_FAILED, timedOut: false, cancelled: false };
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[0]!);
    } catch {
      return { check: CHECK_FAILED, timedOut: false, cancelled: false };
    }
    const check = npyCheckSchema.safeParse(parsed);
    return { check: check.success ? check.data : CHECK_FAILED, timedOut: false, cancelled: false };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/**
 * ONE scan job, in the scanner's container: modelscan on the artifact, except for a `.npy`, whose
 * header is checked first (decisions 180–184):
 *   - numeric: no pickle anywhere, so modelscan is not started;
 *   - object: exactly the payload bytes (a pickle stream) go to modelscan's PICKLE scanner, as
 *     `artifact.pkl` in a directory of their own, removed afterwards;
 *   - refused, or the check did not answer: modelscan is not started; the mapper reads `unknown`.
 */
export async function runScanJob(inv: ModelscanInvocation & { format: ArtifactFormat }, opts: ModelscanRunnerOptions = {}): Promise<ScanOutcome> {
  if (inv.format !== "numpy") return { ...(await runModelscan(inv, opts)), npy: null };
  if (inv.signal?.aborted) return { ...NOTHING, cancelled: true, npy: null };
  const started = Date.now();
  const npyDir = path.join(inv.outDir, "npy");
  await rm(npyDir, { recursive: true, force: true });
  await mkdir(npyDir, { recursive: true, mode: 0o700 });
  try {
    const payloadPath = path.join(npyDir, NPY_OBJECT_PAYLOAD_NAME);
    const checked = await runNpyCheck({ artifactPath: inv.artifactPath, payloadPath, timeoutMs: inv.timeoutMs, ...(inv.signal ? { signal: inv.signal } : {}) }, opts);
    if (checked.cancelled) return { ...NOTHING, cancelled: true, npy: null };
    if (checked.timedOut || checked.check === null) return { ...NOTHING, timedOut: true, npy: null };
    if (checked.check.kind !== "object") return { ...NOTHING, npy: checked.check };
    const remaining = inv.timeoutMs - (Date.now() - started);
    const outcome = await runModelscan({ artifactPath: payloadPath, outDir: inv.outDir, timeoutMs: remaining, ...(inv.signal ? { signal: inv.signal } : {}) }, opts);
    return { ...outcome, npy: checked.check };
  } finally {
    await rm(npyDir, { recursive: true, force: true });
  }
}
