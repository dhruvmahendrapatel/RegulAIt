/**
 * ADR-0190 slice I5 — "an engine's worker runs ONLY in an executor's sandbox" as a static guard (no database, no
 * Docker). The ADR-0187 runner holds the runner key; under I5 it never executes an engine process: every run's task
 * goes to an executor through the task bridge (`@regulait/engine-runner`'s `ExecutorTaskBridge`), and the code that
 * starts engine processes (`@regulait/engine-runner/worker`: the process-group runner and the in-sandbox task helper)
 * is reached only from each engine's TASK entry, which only a sandbox init runs.
 *
 * What it checks, for garak, modelscan and promptfoo:
 *  - the RUNNER entry point's static import closure (static and side-effect imports, re-exports, dynamic `import()`
 *    and `require`, followed through relative modules and into `@regulait/engine-runner`) contains no module that
 *    names a process-spawning API (`child_process`) and no edge into `@regulait/engine-runner/worker`;
 *  - the guard fires: the TASK entry's closure does reach the process-group runner (a guard that cannot fire proves
 *    nothing, M-024);
 *  - the runner entry starts the task bridge, and nothing else in the engine packages spawns a process: the one
 *    module that does is the worker-side process-group runner;
 *  - no long-lived worker container is left: the stock compose file names no `worker-main.js` or `scanner-main.js`,
 *    and those entry points are gone.
 * The behaviour (a run is placed, refused with nothing run, or run in the fake executor's sandbox) is pinned on a real
 * database in `zz-adr0190-i5-engines.test.ts`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PKG = (name: string) => path.join(ROOT, "packages", name, "src");
const ENGINES = ["engine-garak", "engine-modelscan", "engine-promptfoo"] as const;

const SPAWN_IMPORT = /["'`](?:node:)?child_process["'`]/;
/** every import edge of one module, by specifier; type-only imports and re-exports are left out (TypeScript erases them) */
export function importEdges(source: string): string[] {
  const out: string[] = [];
  // a whole `import … from "x"` / `export … from "x"` statement (non-greedy up to its specifier), or a bare import
  const stmt = /(?:^|\n)\s*(import|export)\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = stmt.exec(source)) !== null) {
    const clause = m[2]!.trim();
    if (clause.startsWith("type ")) continue;
    // `import { type A, type B } from` imports nothing at run time
    const braces = /^\{([\s\S]*)\}$/.exec(clause);
    if (braces && braces[1]!.split(",").map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith("type "))) continue;
    out.push(m[3]!);
  }
  for (const r of [/(?:^|\n)\s*import\s+["']([^"']+)["']/g, /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g, /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g]) {
    while ((m = r.exec(source)) !== null) out.push(m[1]!);
  }
  return out;
}

/** a specifier, resolved to a source file we follow, or null for a module outside the walk (a leaf) */
function resolve(from: string, spec: string): string | null {
  if (spec.startsWith(".")) return path.resolve(path.dirname(from), spec.replace(/\.js$/, ".ts"));
  if (spec === "@regulait/engine-runner") return path.join(PKG("engine-runner"), "index.ts");
  if (spec === "@regulait/engine-runner/worker") return path.join(PKG("engine-runner"), "worker.ts");
  return null;
}

/** the closure of an entry point: every module reached, and every leaf specifier named */
function closure(entry: string): { files: Set<string>; leaves: Set<string> } {
  const files = new Set<string>();
  const leaves = new Set<string>();
  const todo = [entry];
  while (todo.length > 0) {
    const f = todo.pop()!;
    if (files.has(f)) continue;
    files.add(f);
    for (const spec of importEdges(readFileSync(f, "utf8"))) {
      const r = resolve(f, spec);
      if (r === null) leaves.add(spec);
      else if (!files.has(r)) {
        expect(existsSync(r), `${path.relative(ROOT, f)} imports ${spec}, which does not resolve`).toBe(true);
        todo.push(r);
      }
    }
  }
  return { files, leaves };
}

const WORKER_SIDE = path.join(PKG("engine-runner"), "worker.ts");
const PROCESS_GROUP = path.join(PKG("engine-runner"), "process.ts");
function offenders(c: { files: Set<string>; leaves: Set<string> }): string[] {
  const out: string[] = [];
  for (const f of c.files) {
    if (f === WORKER_SIDE || f === PROCESS_GROUP) out.push(path.relative(ROOT, f));
    else if (SPAWN_IMPORT.test(readFileSync(f, "utf8"))) out.push(path.relative(ROOT, f));
  }
  for (const l of c.leaves) if (/^(?:node:)?child_process$/.test(l)) out.push(l);
  return out.sort();
}

describe("the import-edge reader (shown to fire before it is trusted)", () => {
  it.each([
    ['import { spawn } from "node:child_process";', ["node:child_process"]],
    ['import "./side.js";', ["./side.js"]],
    ["export * from './worker.js';", ["./worker.js"]],
    ['const m = await import("@regulait/engine-runner/worker");', ["@regulait/engine-runner/worker"]],
    ['import {\n  runProcessGroup,\n  type ProcessGroupOptions,\n} from "@regulait/engine-runner/worker";', ["@regulait/engine-runner/worker"]],
  ])("reads %s", (src, want) => {
    expect(importEdges(src)).toEqual(want);
  });
  it.each(['import type { ProcessGroupOptions } from "@regulait/engine-runner/worker";', 'import { type A, type B } from "./worker.js";', 'export type { X } from "./worker.js";'])("ignores the type-only %s", (src) => {
    expect(importEdges(src)).toEqual([]);
  });
});

describe("no engine runner can execute an engine process outside the executor (ADR-0190 I5)", () => {
  it.each(ENGINES)("%s: the runner entry's closure never reaches a process spawn or the worker side", (engine) => {
    const entry = path.join(PKG(engine), "main.ts");
    const c = closure(entry);
    // non-vacuous: the closure is the runner's real one (the adapter, the exchange, the runner core)
    expect(c.files.size).toBeGreaterThan(5);
    expect([...c.files].some((f) => f.endsWith(path.join("engine-runner", "src", "task-bridge.ts")))).toBe(true);
    expect(offenders(c)).toEqual([]);
  });

  it.each(ENGINES)("%s: the guard fires on the task entry (its closure does run the engine)", (engine) => {
    const c = closure(path.join(PKG(engine), "task-main.ts"));
    expect(offenders(c)).toContain(path.relative(ROOT, PROCESS_GROUP));
  });

  it.each(ENGINES)("%s: the runner starts the task bridge; the long-lived worker entry is gone", (engine) => {
    const main = readFileSync(path.join(PKG(engine), "main.ts"), "utf8");
    expect(main).toMatch(/new ExecutorTaskBridge\(/);
    expect(existsSync(path.join(PKG(engine), "worker-main.ts"))).toBe(false);
    expect(existsSync(path.join(PKG(engine), "scanner-main.ts"))).toBe(false);
  });

  it("the only engine source that names a process-spawning API is the worker-side process-group runner", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = path.join(dir, n);
        if (statSync(p).isDirectory()) return walk(p);
        return n.endsWith(".ts") && !n.endsWith(".test.ts") ? [p] : [];
      });
    const spawning = ["engine-runner", ...ENGINES].flatMap((p) => walk(PKG(p))).filter((f) => SPAWN_IMPORT.test(readFileSync(f, "utf8")));
    expect(spawning.map((f) => path.relative(ROOT, f))).toEqual([path.relative(ROOT, PROCESS_GROUP)]);
  });

  it("the stock compose file starts no engine worker outside an executor", () => {
    const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
    expect(compose).not.toMatch(/worker-main\.js|scanner-main\.js/);
  });
});
