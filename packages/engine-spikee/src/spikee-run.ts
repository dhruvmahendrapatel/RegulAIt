/**
 * ADR-0245 — ONE spikee DATASET in the task sandbox: a generate process, the worker's selection, a test process.
 *
 * Both processes run as a child process group (killed whole at the time limit or on cancel) from a fresh empty
 * workspace on the worker's tmpfs holding only what this build writes: `targets/regulait_gateway.py` and its config
 * (target-module.ts), then spikee's own `datasets/` and `results/`. The environment is built from nothing
 * (config.ts). Between the two steps the worker reads the generated dataset (bounded), keeps at most `trials` entries
 * per item, deterministically (by the sha256 of each entry's id), and writes the selection manifest (ids and plugin
 * names only). Only spikee's one results file is read back, bounded before it is read; stdout is never parsed.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProcessGroup, type ProcessGroupOptions, type ProcessGroupResult } from "@regulait/engine-runner/worker";
import { SPIKEE_LOCAL_JUDGES } from "@regulait/shared";
import {
  assertGatewayOnly,
  buildSpikeeEnv,
  buildSpikeeTargetConfig,
  SPIKEE_SEEDS_DIR,
  SPIKEE_SELECTED_DATASET,
  spikeeGenerateArgs,
  spikeeTestArgs,
  type PlannedDataset,
  type SpikeeTarget,
} from "./config.js";
import { SPIKEE_MAX_RESULTS_BYTES, type SpikeeDatasetOutcome, type SpikeeRunProblem, type SpikeeSelection } from "./mapper.js";
import { SPIKEE_TARGET_CONFIG_FILE, SPIKEE_TARGET_MODULE, SPIKEE_TARGET_MODULE_FILE } from "./target-module.js";

/** where the image keeps spikee (image.test.ts checks the Dockerfile agrees) */
export const SPIKEE_IMAGE_PATHS = Object.freeze({
  venv: "/opt/spikee/venv",
  python: "/opt/spikee/venv/bin/python",
  venvBin: "/opt/spikee/venv/bin",
  seeds: SPIKEE_SEEDS_DIR,
});

/** the largest generated dataset the worker reads (spikee's own seeds generate a few MiB with every plugin) */
export const SPIKEE_MAX_DATASET_BYTES = 64 * 1024 * 1024;

export interface SpikeeInvocation {
  dataset: Pick<PlannedDataset, "set" | "seed" | "generation">;
  plugins: readonly string[];
  target: SpikeeTarget;
  apiKey: string;
  trials: number;
  /** a directory this dataset owns (created fresh, removed after) */
  workDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface SpikeeRunnerOptions {
  python?: string;
  /** PATH for the child (the venv's bin only, by default) */
  path?: string;
  /** the image's seed folders (default: the image's) */
  seedsDir?: string;
  /** seam for tests */
  run?: (cmd: string, args: readonly string[], opts: ProcessGroupOptions) => Promise<ProcessGroupResult>;
  maxResultsBytes?: number;
  maxDatasetBytes?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const ID_RE = /^[\x20-\x7e]{1,200}$/;

/**
 * The selection (pure): parse spikee's generated dataset and keep at most `trials` entries per item (no plugin, or
 * one planned plugin), ordered by the sha256 of the entry id. Returns null when the dataset is not a list of entries
 * this build can attribute (an id twice, an unplanned plugin, a non-local judge, a line that is not an object).
 */
export function selectSpikeeEntries(bytes: Uint8Array, set: string, plugins: readonly string[], trials: number): { lines: string[]; selection: SpikeeSelection } | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const groups = new Map<string | null, Array<{ id: string; line: string; order: string }>>();
  const ids = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      return null;
    }
    if (!isObj(o)) return null;
    const raw = o["id"];
    const id = typeof raw === "string" ? raw : typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : null;
    const plugin = o["plugin"] ?? null;
    const judge = o["judge_name"];
    if (id === null || !ID_RE.test(id) || ids.has(id)) return null;
    if (plugin !== null && (typeof plugin !== "string" || !plugins.includes(plugin))) return null;
    if (typeof judge !== "string" || !SPIKEE_LOCAL_JUDGES.includes(judge)) return null;
    ids.add(id);
    const list = groups.get(plugin) ?? [];
    list.push({ id, line, order: sha256(id) });
    groups.set(plugin, list);
  }
  const cap = Math.max(1, Math.min(25, Math.trunc(trials)));
  const lines: string[] = [];
  const entries: SpikeeSelection["entries"] = [];
  for (const key of [null, ...plugins]) {
    const chosen = (groups.get(key) ?? []).sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0)).slice(0, cap);
    for (const c of chosen) {
      lines.push(c.line);
      entries.push({ id: c.id, plugin: key });
    }
  }
  return { lines, selection: { version: 1, set, entries } };
}

/** the workspace may hold only what this build and spikee's steps write: never a `.env`, a judge or a second target */
async function workspaceProblem(ws: string, allowed: Record<string, readonly string[] | "jsonl">): Promise<boolean> {
  const top = await readdir(ws);
  if (top.some((n) => !(n in allowed))) return true;
  for (const [dir, want] of Object.entries(allowed)) {
    const full = path.join(ws, dir);
    let names: string[];
    try {
      if (!(await lstat(full)).isDirectory()) return true;
      names = await readdir(full);
    } catch {
      continue;
    }
    for (const n of names) {
      const st = await lstat(path.join(full, n));
      if (!st.isFile()) return true;
      if (want === "jsonl" ? !n.endsWith(".jsonl") : !want.includes(n)) return true;
    }
  }
  return false;
}

/** the one regular `.jsonl` file of a directory, or null (none, several, or something else there) */
async function onlyJsonl(dir: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const files = names.filter((n) => n.endsWith(".jsonl"));
  if (files.length !== 1 || names.length !== 1) return null;
  const p = path.join(dir, files[0]!);
  return (await lstat(p)).isFile() ? p : null;
}

export async function runSpikeeDataset(inv: SpikeeInvocation, opts: SpikeeRunnerOptions = {}): Promise<SpikeeDatasetOutcome & { cancelled: boolean }> {
  const empty = (problem: SpikeeRunProblem | null, extra: Partial<SpikeeDatasetOutcome> = {}): SpikeeDatasetOutcome => ({
    set: inv.dataset.set,
    generateExitCode: null,
    testExitCode: null,
    timedOut: false,
    selection: null,
    selectionSha256: null,
    results: null,
    resultsSha256: null,
    problem,
    ...extra,
  });
  if (inv.signal?.aborted) return { ...empty(null), cancelled: true };
  const run = opts.run ?? runProcessGroup;
  const seedsDir = opts.seedsDir ?? SPIKEE_IMAGE_PATHS.seeds;
  const dir = inv.workDir;
  await rm(dir, { recursive: true, force: true });
  const dirs = {
    home: path.join(dir, "home"),
    config: path.join(dir, "xdg-config"),
    data: path.join(dir, "xdg-data"),
    cache: path.join(dir, "xdg-cache"),
    workspace: path.join(dir, "ws"),
  };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true, mode: 0o700 });
  const until = Date.now() + Math.max(1000, inv.timeoutMs);
  const left = () => Math.max(1000, until - Date.now());
  try {
    const targetConfig = buildSpikeeTargetConfig(inv.target);
    const env = buildSpikeeEnv(inv.apiKey, dirs, opts.path ?? SPIKEE_IMAGE_PATHS.venvBin);
    const generateArgs = spikeeGenerateArgs(inv.dataset, inv.plugins, seedsDir);
    const testArgs = spikeeTestArgs();
    assertGatewayOnly({ targetConfig, generateArgs, testArgs, env }, inv.target.baseUrl, seedsDir);
    const targets = path.join(dirs.workspace, "targets");
    await mkdir(targets, { mode: 0o700 });
    await writeFile(path.join(targets, SPIKEE_TARGET_MODULE_FILE), SPIKEE_TARGET_MODULE, { mode: 0o600 });
    await writeFile(path.join(targets, SPIKEE_TARGET_CONFIG_FILE), JSON.stringify(targetConfig), { mode: 0o600 });
    const python = opts.python ?? SPIKEE_IMAGE_PATHS.python;
    const common = { cwd: dirs.workspace, env, ...(inv.signal ? { signal: inv.signal } : {}), maxOutputBytes: 64 * 1024 };
    const stopped = (r: ProcessGroupResult) => ({ cancelled: Boolean(inv.signal?.aborted), timedOut: r.killed && !inv.signal?.aborted });

    // 1. generate
    const g = await run(python, generateArgs, { ...common, timeoutMs: left() });
    const gs = stopped(g);
    if (gs.cancelled) return { ...empty(null), cancelled: true };
    if (gs.timedOut) return { ...empty("timed_out", { timedOut: true }), cancelled: false };
    const targetFiles = [SPIKEE_TARGET_MODULE_FILE, SPIKEE_TARGET_CONFIG_FILE];
    if (await workspaceProblem(dirs.workspace, { targets: targetFiles, datasets: "jsonl" })) return { ...empty("workspace_unexpected", { generateExitCode: g.exitCode }), cancelled: false };
    const generated = await onlyJsonl(path.join(dirs.workspace, "datasets"));
    if (g.exitCode !== 0 || !generated) return { ...empty("generate_failed", { generateExitCode: g.exitCode }), cancelled: false };
    if ((await lstat(generated)).size > (opts.maxDatasetBytes ?? SPIKEE_MAX_DATASET_BYTES)) return { ...empty("dataset_invalid", { generateExitCode: g.exitCode }), cancelled: false };

    // 2. select (at most `trials` entries per item), then drop the generated file
    const picked = selectSpikeeEntries(await readFile(generated), inv.dataset.set, inv.plugins, inv.trials);
    if (!picked) return { ...empty("dataset_invalid", { generateExitCode: g.exitCode }), cancelled: false };
    const selectionBytes = Buffer.from(JSON.stringify(picked.selection), "utf8");
    const withSelection = { generateExitCode: g.exitCode, selection: selectionBytes, selectionSha256: sha256(selectionBytes) };
    await rm(generated, { force: true });
    if (picked.lines.length === 0) return { ...empty("nothing_generated", withSelection), cancelled: false };
    await writeFile(path.join(dirs.workspace, SPIKEE_SELECTED_DATASET), `${picked.lines.join("\n")}\n`, { mode: 0o600 });

    // 3. test
    const t = await run(python, testArgs, { ...common, timeoutMs: left() });
    const ts = stopped(t);
    if (ts.cancelled) return { ...empty(null, withSelection), cancelled: true };
    if (await workspaceProblem(dirs.workspace, { targets: targetFiles, datasets: ["selected.jsonl"], results: "jsonl" })) {
      return { ...empty("workspace_unexpected", { ...withSelection, testExitCode: t.exitCode }), cancelled: false };
    }
    const resultsPath = await onlyJsonl(path.join(dirs.workspace, "results"));
    const base = { ...withSelection, testExitCode: t.killed ? null : t.exitCode, timedOut: ts.timedOut };
    if (!resultsPath) return { ...empty(ts.timedOut ? "timed_out" : t.exitCode === 0 ? "no_results" : "test_failed", base), cancelled: false };
    if ((await lstat(resultsPath)).size > (opts.maxResultsBytes ?? SPIKEE_MAX_RESULTS_BYTES)) return { ...empty("results_too_large", base), cancelled: false };
    const results = await readFile(resultsPath);
    const problem: SpikeeRunProblem | null = ts.timedOut ? "timed_out" : t.exitCode !== 0 ? "test_failed" : null;
    return { ...empty(problem, base), results, resultsSha256: sha256(results), cancelled: false };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
