/**
 * ADR-0346 — the fairlearn METRIC STEP, run by the task (never the runner): our script, `fairlearn_metrics.py`, reads
 * the kept rows on stdin and writes fairlearn's values on stdout. As every engine child it runs through engine-runner's
 * process-group runner (`runProcessGroup`: its own process group, killed on a cancel or at its time limit, its output
 * bounded), the one module allowed to start a process (`adr0190-i5-engine-runner-no-spawn.test.ts`).
 *
 * That runner gives the child no stdin, so the rows go to one file in the sandbox's scratch tmpfs (the task's own
 * copy, removed when the step ends) and a fixed boot line (FAIRLEARN_METRICS_BOOT, isolated with `-I -B`) opens it as
 * the script's stdin and runs the script as `__main__`: the script itself is unchanged and still reads only stdin.
 * The child's stderr is discarded (a traceback could quote a group name); its stdout is bounded and parsed strictly.
 *
 * Reached only from worker.ts (inside the task's sandbox) and tests.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runProcessGroup } from "@regulait/engine-runner/worker";
import { fairlearnResultSchema, type FairlearnResult, type FairnessRows } from "@regulait/shared";
import { FAIRLEARN_IMAGE_PATHS, FAIRLEARN_METRICS_MAX_STDOUT, FAIRLEARN_METRICS_TIMEOUT_MS, fairlearnMetricsArgs, fairlearnMetricsEnv } from "./config.js";

/** what fairlearn_metrics.py writes on success */
const metricsOutputSchema = z
  .object({
    fairlearn: z.string().min(1).max(64).regex(/^[\x21-\x7e]+$/),
    attributes: fairlearnResultSchema.shape.metrics.unwrap(),
  })
  .strict();

export interface MetricsCommand {
  /** the interpreter */
  command: string;
  /** the argv before the rows file (the rows file's path is appended, then the script) */
  args: readonly string[];
  /** the script the boot line runs */
  script: string;
  env: Record<string, string>;
}

/** the image's metric command (tests substitute a stand-in) */
export function defaultMetricsCommand(): MetricsCommand {
  return { command: FAIRLEARN_IMAGE_PATHS.python, args: fairlearnMetricsArgs(), script: FAIRLEARN_IMAGE_PATHS.script, env: fairlearnMetricsEnv() };
}

/**
 * fairlearn's values for the kept rows, or null when the step failed (did not start, exited non-zero, was killed,
 * wrote too much or something that is not exactly one value per metric for exactly the given attributes).
 */
export async function runFairlearnMetrics(
  rows: FairnessRows,
  opts: { signal: AbortSignal; scratch: string; timeoutMs?: number; command?: MetricsCommand },
): Promise<{ fairlearn: string; metrics: NonNullable<FairlearnResult["metrics"]> } | null> {
  const cmd = opts.command ?? defaultMetricsCommand();
  const dir = path.join(opts.scratch, `metrics-${randomUUID()}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const rowsFile = path.join(dir, "rows.json");
  try {
    await writeFile(rowsFile, JSON.stringify({ labels: rows.labels, predictions: rows.predictions, attributes: rows.attributes }), { mode: 0o600 });
    const run = await runProcessGroup(cmd.command, [...cmd.args, rowsFile, cmd.script], {
      cwd: dir,
      env: cmd.env,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? FAIRLEARN_METRICS_TIMEOUT_MS,
      maxOutputBytes: FAIRLEARN_METRICS_MAX_STDOUT,
    });
    // a killed, failed or over-long (so truncated) answer is never read as values
    if (run.killed || run.exitCode !== 0 || run.stdout.length >= FAIRLEARN_METRICS_MAX_STDOUT) return null;
    let parsed: ReturnType<typeof metricsOutputSchema.safeParse>;
    try {
      parsed = metricsOutputSchema.safeParse(JSON.parse(run.stdout));
    } catch {
      return null;
    }
    if (!parsed.success) return null;
    const want = Object.keys(rows.attributes).sort();
    const got = Object.keys(parsed.data.attributes).sort();
    if (want.length !== got.length || want.some((n, i) => n !== got[i])) return null;
    return { fairlearn: parsed.data.fairlearn, metrics: parsed.data.attributes };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
