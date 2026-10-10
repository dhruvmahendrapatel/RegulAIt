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
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { runProcessGroup, type ProcessGroupOptions, type ProcessGroupResult } from "@regulait/engine-runner";
import {
  MODELSCAN_MAX_REPORT_BYTES,
  NPY_OBJECT_PAYLOAD_MAX_BYTES,
  NPY_OBJECT_PAYLOAD_NAME,
  NPZ_MAX_MEMBERS,
  NPZ_MAX_UNCOMPRESSED_BYTES,
  npyCheckSchema,
  npzCheckSchema,
  npzMemberPayloadName,
  type ArtifactFormat,
  type NpyCheck,
  type NpzCheck,
} from "@regulait/shared";
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
// ADR-0187 decisions 180–184 and 219–224 (open question 15(b) and (c)): `.npy` and `.npz` artifacts
// ---------------------------------------------------------------------------------------------------

/** what one scan job produced: modelscan's outcome and, for a `.npy` or a `.npz`, the scanner's own check */
export interface ScanOutcome extends ModelscanOutcome {
  /** the `.npy` header check; null for every other format (and when the check was cut off) */
  npy: NpyCheck | null;
  /** the `.npz` archive check (decisions 219–224); null for every other format (and when the check was cut off) */
  npz: NpzCheck | null;
}

const NOTHING: ModelscanOutcome = { exitCode: null, timedOut: false, cancelled: false, report: null, reportSha256: null, reportTooLarge: false };
const CHECK_FAILED: NpyCheck = { kind: "invalid", problem: "npy_check_failed" };
const NPZ_CHECK_FAILED: NpzCheck = { kind: "invalid", problem: "npz_check_failed" };
/** the `.npz` answer lists every member (at most NPZ_MAX_MEMBERS, each under 64 bytes of JSON) */
const NPZ_ANSWER_MAX_BYTES = 128 * 1024;

/** the helper's argv: isolated, no site, stdlib only; nothing from the artifact but the paths we chose */
export function npyCheckArgs(helper: string, artifactPath: string, payloadPath: string): string[] {
  return ["-I", "-S", helper, artifactPath, payloadPath, String(NPY_OBJECT_PAYLOAD_MAX_BYTES)];
}

/** the `.npz` argv (decision 220): the whole archive's object payloads share the one `.npy` bound */
export function npzCheckArgs(helper: string, artifactPath: string, payloadDir: string): string[] {
  return ["-I", "-S", helper, "--npz", artifactPath, payloadDir, String(NPY_OBJECT_PAYLOAD_MAX_BYTES), String(NPZ_MAX_UNCOMPRESSED_BYTES), String(NPZ_MAX_MEMBERS)];
}

/**
 * Run the helper (engines/modelscan/npy-header.py) in this (the scanner's) container, from a fresh
 * empty working directory beside `besideDir`, with the same environment built from nothing as
 * modelscan. Anything but exit 0 and exactly one answer the schema accepts is `failed` (unknown).
 */
async function runHelper<T>(
  inv: { args: string[]; besideDir: string; timeoutMs: number; signal?: AbortSignal; maxOutputBytes: number },
  parse: (v: unknown) => { success: true; data: T } | { success: false },
  failed: T,
  opts: ModelscanRunnerOptions,
): Promise<{ check: T | null; timedOut: boolean; cancelled: boolean }> {
  const cwd = path.join(inv.besideDir, "cwd");
  await rm(cwd, { recursive: true, force: true });
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  try {
    const r = await runProcessGroup(opts.python ?? MODELSCAN_IMAGE_PATHS.python, inv.args, {
      cwd,
      env: modelscanEnv(cwd, opts.path ?? MODELSCAN_IMAGE_PATHS.venvBin),
      timeoutMs: Math.max(1000, inv.timeoutMs),
      ...(inv.signal ? { signal: inv.signal } : {}),
      maxOutputBytes: inv.maxOutputBytes,
    });
    const cancelled = Boolean(inv.signal?.aborted);
    if (r.killed) return { check: null, timedOut: !cancelled, cancelled };
    const lines = r.stdout.split("\n").filter((l) => l.length > 0);
    if (r.exitCode !== 0 || lines.length !== 1) return { check: failed, timedOut: false, cancelled: false };
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[0]!);
    } catch {
      return { check: failed, timedOut: false, cancelled: false };
    }
    const check = parse(parsed);
    return { check: check.success ? check.data : failed, timedOut: false, cancelled: false };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/**
 * Run the strict header check on one `.npy`. Anything but exit 0 and exactly one valid JSON answer is
 * `npy_check_failed` (unknown).
 */
export async function runNpyCheck(
  inv: { artifactPath: string; payloadPath: string; timeoutMs: number; signal?: AbortSignal },
  opts: ModelscanRunnerOptions = {},
): Promise<{ check: NpyCheck | null; timedOut: boolean; cancelled: boolean }> {
  const args = npyCheckArgs(opts.npyHelper ?? MODELSCAN_IMAGE_PATHS.npyHelper, inv.artifactPath, inv.payloadPath);
  return runHelper(
    { args, besideDir: path.dirname(inv.payloadPath), timeoutMs: inv.timeoutMs, maxOutputBytes: 4096, ...(inv.signal ? { signal: inv.signal } : {}) },
    (v) => npyCheckSchema.safeParse(v),
    CHECK_FAILED,
    opts,
  );
}

/**
 * Run the strict archive check on one `.npz` (decisions 219–224). Object members' payloads land in
 * `payloadDir` as `member-NNNN.pkl`. Anything but exit 0, exactly one valid JSON answer, and a payload
 * directory holding exactly the object members' files is `npz_check_failed` (unknown).
 */
export async function runNpzCheck(
  inv: { artifactPath: string; payloadDir: string; timeoutMs: number; signal?: AbortSignal },
  opts: ModelscanRunnerOptions = {},
): Promise<{ check: NpzCheck | null; timedOut: boolean; cancelled: boolean }> {
  const args = npzCheckArgs(opts.npyHelper ?? MODELSCAN_IMAGE_PATHS.npyHelper, inv.artifactPath, inv.payloadDir);
  const r = await runHelper(
    { args, besideDir: path.dirname(inv.payloadDir), timeoutMs: inv.timeoutMs, maxOutputBytes: NPZ_ANSWER_MAX_BYTES, ...(inv.signal ? { signal: inv.signal } : {}) },
    (v) => npzCheckSchema.safeParse(v),
    NPZ_CHECK_FAILED,
    opts,
  );
  if (r.check === null) return r;
  // the payload directory must hold exactly the object members' files: modelscan scans the directory
  const want = r.check.kind === "npz" ? r.check.members.flatMap((m, i) => (m.kind === "object" ? [npzMemberPayloadName(i)] : [])).sort() : [];
  const have = (await readdir(inv.payloadDir)).sort();
  if (want.length !== have.length || want.some((n, i) => n !== have[i])) return { check: NPZ_CHECK_FAILED, timedOut: false, cancelled: false };
  return r;
}

/**
 * ONE scan job, in the scanner's container: modelscan on the artifact, except
 *   - a `.npy`, whose header is checked first (decisions 180–184):
 *     - numeric: no pickle anywhere, so modelscan is not started;
 *     - object: exactly the payload bytes (a pickle stream) go to modelscan's PICKLE scanner, as
 *       `artifact.pkl` in a directory of their own, removed afterwards;
 *     - refused, or the check did not answer: modelscan is not started; the mapper reads `unknown`;
 *   - a `.npz`, whose archive and every member are checked first (decisions 219–224): an archive-level
 *     refusal, or an archive with no object member, starts nothing; otherwise modelscan scans the
 *     directory of object payloads (one `member-NNNN.pkl` per object member, as pickles), removed
 *     afterwards.
 */
export async function runScanJob(inv: ModelscanInvocation & { format: ArtifactFormat }, opts: ModelscanRunnerOptions = {}): Promise<ScanOutcome> {
  if (inv.format === "numpy_npz") return runNpzJob(inv, opts);
  if (inv.format !== "numpy") return { ...(await runModelscan(inv, opts)), npy: null, npz: null };
  if (inv.signal?.aborted) return { ...NOTHING, cancelled: true, npy: null, npz: null };
  const started = Date.now();
  const npyDir = path.join(inv.outDir, "npy");
  await rm(npyDir, { recursive: true, force: true });
  await mkdir(npyDir, { recursive: true, mode: 0o700 });
  try {
    const payloadPath = path.join(npyDir, NPY_OBJECT_PAYLOAD_NAME);
    const checked = await runNpyCheck({ artifactPath: inv.artifactPath, payloadPath, timeoutMs: inv.timeoutMs, ...(inv.signal ? { signal: inv.signal } : {}) }, opts);
    if (checked.cancelled) return { ...NOTHING, cancelled: true, npy: null, npz: null };
    if (checked.timedOut || checked.check === null) return { ...NOTHING, timedOut: true, npy: null, npz: null };
    if (checked.check.kind !== "object") return { ...NOTHING, npy: checked.check, npz: null };
    const remaining = inv.timeoutMs - (Date.now() - started);
    const outcome = await runModelscan({ artifactPath: payloadPath, outDir: inv.outDir, timeoutMs: remaining, ...(inv.signal ? { signal: inv.signal } : {}) }, opts);
    return { ...outcome, npy: checked.check, npz: null };
  } finally {
    await rm(npyDir, { recursive: true, force: true });
  }
}

async function runNpzJob(inv: ModelscanInvocation, opts: ModelscanRunnerOptions): Promise<ScanOutcome> {
  if (inv.signal?.aborted) return { ...NOTHING, cancelled: true, npy: null, npz: null };
  const started = Date.now();
  const npzDir = path.join(inv.outDir, "npz");
  const payloadDir = path.join(npzDir, "payloads");
  await rm(npzDir, { recursive: true, force: true });
  await mkdir(payloadDir, { recursive: true, mode: 0o700 });
  try {
    const checked = await runNpzCheck({ artifactPath: inv.artifactPath, payloadDir, timeoutMs: inv.timeoutMs, ...(inv.signal ? { signal: inv.signal } : {}) }, opts);
    if (checked.cancelled) return { ...NOTHING, cancelled: true, npy: null, npz: null };
    if (checked.timedOut || checked.check === null) return { ...NOTHING, timedOut: true, npy: null, npz: null };
    if (checked.check.kind !== "npz" || !checked.check.members.some((m) => m.kind === "object")) return { ...NOTHING, npy: null, npz: checked.check };
    const remaining = inv.timeoutMs - (Date.now() - started);
    const outcome = await runModelscan({ artifactPath: payloadDir, outDir: inv.outDir, timeoutMs: remaining, ...(inv.signal ? { signal: inv.signal } : {}) }, opts);
    return { ...outcome, npy: null, npz: checked.check };
  } finally {
    await rm(npzDir, { recursive: true, force: true });
  }
}
