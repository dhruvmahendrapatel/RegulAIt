#!/usr/bin/env node
/**
 * PRE-FLIGHT: EVERY GATEWAY MODULE LOADS AS THE FIRST MODULE (ADR-0190 I4 follow-ups).
 *
 * Why: an import cycle only crashes when the module that closes it is loaded FIRST in a process. #383 hit exactly
 * that (a temporal-dead-zone ReferenceError at init), and the I4 builder found it by importing every module by
 * hand. This makes that sweep a CI step: each non-test module in `apps/gateway/dist` is imported, alone, as the first
 * module of a fresh `node` child process, and the step fails when any import throws while modules initialise.
 * `preflight-import-cycles.mjs` stops a NEW cycle; this catches an OLD cycle that a change made fatal.
 *
 * Containment (the manual sweep once wrote a demo receipt key into the real home directory): every child runs with
 *   - an empty temporary HOME, TMPDIR and working directory, removed afterwards;
 *   - an environment holding only PATH, NODE_ENV=test and the marker REGULAIT_IMPORT_SMOKE=1 (no database URL, no
 *     data key, no REGULAIT_* settings), so nothing can reach a real database or real key material;
 *   - no `process.argv[1]`, so a module's `if (process.argv[1] === this file) main()` guard stays shut;
 *   - `process.exit` straight after the import resolves, and a hard timeout.
 * Command-line and demo ENTRY POINTS, which do their work at top level (start a server, write keys, migrate a
 * database), are never imported: they are listed by name in ENTRY_POINTS below, each with what it would do. A new
 * entry point must be added there in the PR that adds it; a module that does not finish loading within the timeout
 * fails the step, which is how a missing entry is noticed.
 *
 * Usage (from the repository root, after `pnpm -r build`): node scripts/preflight-import-smoke.mjs
 * Exit 0: every module loaded; 1: at least one failed (each failure is printed); 2: the check could not run.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GATEWAY_ROOT, liveDistModules } from "./preflight-import-cycles.mjs";

/** dist-relative paths of modules that act when imported; never loaded by this check */
export const ENTRY_POINTS = new Map([
  ["main.js", "starts the gateway (listens, connects to the database, runs migrations)"],
  ["seed.js", "seeds a database (pnpm seed)"],
  ["reencrypt.js", "re-encrypts a database under a new data key"],
  ["first-admin.js", "creates the first admin (the installer's tool, ADR-0194)"],
  ["receipt-key-init.js", "creates the install receipt signing key"],
  ["identity-key-init.js", "creates the install identity key"],
  ["demo-check.js", "migrates and checks the demo database"],
  ["demo-docker-prepared.js", "asks the database whether the Docker demo is prepared (docker-start.sh)"],
  ["demo-export-key.js", "writes the demo export and receipt keys into the home directory"],
  ["demo-gate.js", "runs the demo gate against a database"],
  ["demo-intake-seed.js", "seeds demo intake data"],
  ["demo-mcp-server.js", "starts the demo MCP servers (listens)"],
  ["demo-prepare.js", "runs every demo preparation step"],
  ["demo-set-passwords.js", "sets demo persona passwords in a database"],
  ["demo-setup.js", "sets up the demo database"],
  ["demo-traffic.js", "generates demo traffic against a gateway"],
  ["openapi-client-gen.js", "generates the API client (writes files)"],
  ["testing/mock-socket-contract.js", "test helper that runs its contract at top level"],
]);

const CHILD = [
  "const target = process.env.REGULAIT_IMPORT_SMOKE_TARGET;",
  "try { await import(target); }",
  "catch (e) {",
  "  const err = e instanceof Error ? e : new Error(String(e));",
  "  process.stdout.write('\\n@@IMPORT_SMOKE_FAIL@@' + JSON.stringify({ name: err.name, message: err.message, stack: String(err.stack ?? '').split('\\n').slice(0, 6).join('\\n') }) + '\\n');",
  "  process.exit(1);",
  "}",
  "process.exit(0);",
].join("\n");

/** import one module in a contained child; resolves to null when it loaded, else the failure */
export function importAlone(file, { timeoutMs = 30_000 } = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), "regulait-import-smoke-"));
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD], {
      cwd: sandbox,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: sandbox,
        TMPDIR: sandbox,
        NODE_ENV: "test",
        REGULAIT_IMPORT_SMOKE: "1",
        REGULAIT_IMPORT_SMOKE_TARGET: pathToFileURL(file).href,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out = (out + d).slice(-64 * 1024)));
    child.stderr.on("data", (d) => (err = (err + d).slice(-16 * 1024)));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      rmSync(sandbox, { recursive: true, force: true });
      if (code === 0) return done(null);
      const marker = out.lastIndexOf("@@IMPORT_SMOKE_FAIL@@");
      if (marker >= 0) {
        const line = out.slice(marker + "@@IMPORT_SMOKE_FAIL@@".length).split("\n")[0];
        try {
          return done({ kind: "threw", ...JSON.parse(line) });
        } catch {
          /* fall through */
        }
      }
      if (signal === "SIGKILL") return done({ kind: "timeout", message: `did not finish loading in ${timeoutMs} ms (an entry point missing from ENTRY_POINTS?)` });
      return done({ kind: "exit", message: `exited ${code ?? signal} while loading (an entry point missing from ENTRY_POINTS?)`, stack: err.trim().split("\n").slice(-6).join("\n") });
    });
  });
}

export async function smokeAll(packageRoot, { concurrency = Math.max(2, availableParallelism()), timeoutMs } = {}) {
  const modules = liveDistModules(packageRoot).map((m) => m.slice("dist/".length));
  const targets = modules.filter((m) => !ENTRY_POINTS.has(m));
  const unknownEntries = [...ENTRY_POINTS.keys()].filter((e) => !modules.includes(e));
  const failures = [];
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const rel = targets[next++];
      const failure = await importAlone(join(packageRoot, "dist", rel), timeoutMs ? { timeoutMs } : {});
      if (failure) failures.push({ module: rel, ...failure });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  failures.sort((a, b) => (a.module < b.module ? -1 : 1));
  return { loaded: targets.length - failures.length, skipped: modules.length - targets.length, failures, unknownEntries };
}

async function main() {
  let result;
  try {
    result = await smokeAll(GATEWAY_ROOT);
  } catch (e) {
    console.error(`import smoke check could not run: ${e.message}`);
    process.exit(2);
  }
  const { loaded, skipped, failures, unknownEntries } = result;
  console.log(`gateway import smoke: ${loaded} module(s) loaded alone, ${skipped} entry point(s) skipped by name, ${failures.length} failure(s)`);
  for (const e of unknownEntries) console.error(`ENTRY_POINTS names ${e}, which is not a compiled gateway module any more: remove it from the list`);
  for (const f of failures) {
    const tdz = f.name === "ReferenceError" ? " (a ReferenceError at init: most likely an import cycle read before it finished, see preflight-import-cycles.mjs)" : "";
    console.error(`\nFAILED ${f.module}: ${f.kind === "threw" ? `${f.name}: ${f.message}` : f.message}${tdz}`);
    if (f.stack) console.error(f.stack.replace(/^/gm, "    "));
  }
  if (failures.length > 0 || unknownEntries.length > 0) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
