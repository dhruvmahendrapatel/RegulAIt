#!/usr/bin/env node
/**
 * ADR-0109 / ADR-0110 — pre-flight for the unique constraints migrations 0108
 * and 0109 add.
 *
 * Those migrations ADD constraints and REFUSE; they never repair, merge or
 * delete. On a deployment already holding a pair of rows a constraint forbids,
 * the upgrade STOPS. Run this BEFORE upgrading to see exactly what would block
 * it, per constraint, with counts and example keys.
 *
 *   node scripts/preflight-unique-constraints.mjs "$DATABASE_URL"
 *
 * Read-only: no writes, no locks, no transaction. Exit 0 = clean, 1 = blocked,
 * 2 = could not run.
 *
 * ADR-0110 WIRED THIS INTO CI (`.github/workflows/ci.yml`, the `build-and-test`
 * job) and into README's "Verifying a clean checkout" sequence. ADR-0109's own
 * honest-limits section said "a check nobody runs is worth nothing", and for a
 * release that was true of this file.
 *
 * WHY THE REPORT IS WRITTEN WITH `writeSync` AND NOT `console.log`. Node's
 * stdout is ASYNCHRONOUS when it is a pipe — which is exactly what it is under
 * a CI runner, `$(...)`, or a tee. `process.exit()` does not flush what is
 * still buffered, so a `console.log` immediately followed by `process.exit(1)`
 * can hand CI a non-zero exit with NO REASON PRINTED — the single worst failure
 * mode for a gate, because the operator sees only that something blocked and
 * not what. `fs.writeSync` is unbuffered, so the reason is on the wire before
 * the exit code is decided.
 *
 * Requires the workspace to have been built (`pnpm -r build`) — it imports the
 * same exported function a route or a test would call, so there is one
 * implementation of the check and not two.
 */
import { writeSync } from "node:fs";
import {
  createDb,
  formatDeferredUniquePreflight,
  runDeferredUniquePreflight,
} from "../packages/db/dist/index.js";

/** unbuffered — see the header on why `console.log` is not safe before exit */
function say(fd, text) {
  writeSync(fd, `${text}\n`);
}

const url = process.argv[2] ?? process.env.DATABASE_URL;
if (!url) {
  say(2, "usage: node scripts/preflight-unique-constraints.mjs <DATABASE_URL>");
  process.exit(2);
}

try {
  const db = createDb(url);
  const report = await runDeferredUniquePreflight(db);
  say(1, formatDeferredUniquePreflight(report));
  if (!report.clean) {
    // Repeat the blockers on stderr. CI folds a step's output into one stream,
    // but an operator piping stdout to a file still sees why it failed.
    for (const f of report.blocking) {
      say(2, `BLOCKS ${f.index} — ${f.table} (${f.key}): ${f.duplicateGroups} duplicate group(s), ${f.duplicateRows} row(s)`);
    }
  }
  process.exit(report.clean ? 0 : 1);
} catch (err) {
  say(2, `pre-flight could not run: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
