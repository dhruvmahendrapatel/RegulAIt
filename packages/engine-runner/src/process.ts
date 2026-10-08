/**
 * ADR-0187 — the engine runs as a CHILD PROCESS GROUP, so a cancel, a passed
 * deadline or a runner shutdown kills the tool and everything it started
 * (SIGKILL to the negative pid), not just the first process. Stdlib only.
 */
import { spawn } from "node:child_process";

export interface ProcessGroupResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** true when we killed it (abort or timeout) */
  killed: boolean;
  stdout: string;
  stderr: string;
}

export interface ProcessGroupOptions {
  cwd?: string;
  /** the WHOLE environment the child sees (nothing is inherited implicitly) */
  env: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs: number;
  /** stdout/stderr kept, at most (bytes each) */
  maxOutputBytes?: number;
}

export function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** run `cmd args` in its own process group; resolves when it ends or is killed */
export function runProcessGroup(cmd: string, args: readonly string[], opts: ProcessGroupOptions): Promise<ProcessGroupResult> {
  const max = opts.maxOutputBytes ?? 1024 * 1024;
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < max) stdout += d.toString("utf8").slice(0, max - stdout.length);
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < max) stderr += d.toString("utf8").slice(0, max - stderr.length);
    });
    const kill = () => {
      killed = true;
      killGroup(child.pid);
    };
    const timer = setTimeout(kill, opts.timeoutMs);
    timer.unref();
    if (opts.signal) {
      if (opts.signal.aborted) kill();
      else opts.signal.addEventListener("abort", kill, { once: true });
    }
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, killed, stdout, stderr });
    });
    child.once("close", (code, sig) => {
      clearTimeout(timer);
      // the group may still hold grandchildren: they never outlive the run
      killGroup(child.pid);
      resolve({ exitCode: code, signal: sig, killed, stdout, stderr });
    });
  });
}
