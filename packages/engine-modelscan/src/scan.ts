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
import { MODELSCAN_MAX_REPORT_BYTES } from "@regulait/shared";
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
  /** seam for tests */
  run?: (cmd: string, args: readonly string[], opts: ProcessGroupOptions) => Promise<ProcessGroupResult>;
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
