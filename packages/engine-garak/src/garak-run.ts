/**
 * ADR-0187 B5-G — ONE garak process for ONE probe, in the WORKER container (decision 151).
 *
 *   python -I -m garak --config <dir>/run.json
 *
 * run as a child process group (killed whole at the time limit or on cancel), from a fresh empty
 * directory on the worker's tmpfs that holds the config, HOME, the XDG directories and the report
 * directory, with an environment built from nothing (config.ts). Only `<prefix>.report.jsonl` is read
 * back, bounded before it is read; the hit log and the HTML summary (raw model text) are never read and
 * are deleted with the directory. stdout is never parsed.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProcessGroup, type ProcessGroupOptions, type ProcessGroupResult } from "@regulait/engine-runner";
import { assertGatewayOnly, buildGarakConfig, buildGarakEnv, GARAK_REPORT_PREFIX, type GarakTarget } from "./config.js";
import { GARAK_MAX_REPORT_BYTES, type GarakProbeOutcome } from "./mapper.js";

/** where the image keeps garak (image.test.ts checks the Dockerfile agrees) */
export const GARAK_IMAGE_PATHS = Object.freeze({
  venv: "/opt/garak/venv",
  python: "/opt/garak/venv/bin/python",
  venvBin: "/opt/garak/venv/bin",
});

export interface GarakInvocation {
  probe: string;
  target: GarakTarget;
  apiKey: string;
  trials: number;
  /** a directory this probe owns (created fresh, removed after) */
  workDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface GarakRunnerOptions {
  python?: string;
  /** PATH for the child (the venv's bin only, by default) */
  path?: string;
  /** seam for tests */
  run?: (cmd: string, args: readonly string[], opts: ProcessGroupOptions) => Promise<ProcessGroupResult>;
  /** seam for tests: the report bound (default GARAK_MAX_REPORT_BYTES) */
  maxReportBytes?: number;
}

/** the argv, fixed: nothing from the lease reaches it but the config path we chose */
export function garakArgs(configPath: string): string[] {
  return ["-I", "-m", "garak", "--config", configPath];
}

export async function runGarakProbe(inv: GarakInvocation, opts: GarakRunnerOptions = {}): Promise<GarakProbeOutcome & { cancelled: boolean }> {
  const empty = { probe: inv.probe, exitCode: null, timedOut: false, report: null, reportTooLarge: false, reportSha256: null };
  if (inv.signal?.aborted) return { ...empty, cancelled: true };
  const run = opts.run ?? runProcessGroup;
  const dir = inv.workDir;
  await rm(dir, { recursive: true, force: true });
  const dirs = {
    home: path.join(dir, "home"),
    config: path.join(dir, "xdg-config"),
    data: path.join(dir, "xdg-data"),
    cache: path.join(dir, "xdg-cache"),
    report: path.join(dir, "report"),
  };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true, mode: 0o700 });
  try {
    const config = buildGarakConfig({ target: inv.target, probe: inv.probe, trials: inv.trials, reportDir: dirs.report });
    const env = buildGarakEnv(inv.apiKey, dirs, opts.path ?? GARAK_IMAGE_PATHS.venvBin);
    assertGatewayOnly(config, env, inv.target.baseUrl);
    const configPath = path.join(dir, "run.json");
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const r = await run(opts.python ?? GARAK_IMAGE_PATHS.python, garakArgs(configPath), {
      cwd: dirs.home,
      env,
      timeoutMs: Math.max(1000, inv.timeoutMs),
      ...(inv.signal ? { signal: inv.signal } : {}),
      maxOutputBytes: 64 * 1024,
    });
    const cancelled = Boolean(inv.signal?.aborted);
    const timedOut = r.killed && !cancelled;
    const reportPath = path.join(dirs.report, `${GARAK_REPORT_PREFIX}.report.jsonl`);
    if (!existsSync(reportPath)) return { ...empty, exitCode: r.killed ? null : r.exitCode, timedOut, cancelled };
    const size = (await stat(reportPath)).size;
    if (size > (opts.maxReportBytes ?? GARAK_MAX_REPORT_BYTES)) return { ...empty, exitCode: r.exitCode, timedOut, cancelled, reportTooLarge: true };
    const bytes = await readFile(reportPath);
    return {
      probe: inv.probe,
      exitCode: r.killed ? null : r.exitCode,
      timedOut,
      cancelled,
      report: bytes,
      reportTooLarge: false,
      reportSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
