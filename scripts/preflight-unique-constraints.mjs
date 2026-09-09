#!/usr/bin/env node
/**
 * ADR-0109 — pre-flight for migration 0108's unique constraints.
 *
 * Migration 0108 ADDS constraints and REFUSES; it never repairs, merges or
 * deletes. On a deployment already holding a pair of rows a constraint forbids,
 * the upgrade STOPS. Run this BEFORE upgrading to see exactly what would block
 * it, per constraint, with counts and example keys.
 *
 *   node scripts/preflight-unique-constraints.mjs "$DATABASE_URL"
 *
 * Read-only: no writes, no locks, no transaction. Exit 0 = clean, 1 = blocked,
 * 2 = could not run.
 *
 * Requires the workspace to have been built (`pnpm -r build`) — it imports the
 * same exported function a route or a test would call, so there is one
 * implementation of the check and not two.
 */
import {
  createDb,
  formatDeferredUniquePreflight,
  runDeferredUniquePreflight,
} from "../packages/db/dist/index.js";

const url = process.argv[2] ?? process.env.DATABASE_URL;
if (!url) {
  console.error("usage: node scripts/preflight-unique-constraints.mjs <DATABASE_URL>");
  process.exit(2);
}

try {
  const db = createDb(url);
  const report = await runDeferredUniquePreflight(db);
  console.log(formatDeferredUniquePreflight(report));
  process.exit(report.clean ? 0 : 1);
} catch (err) {
  console.error(`pre-flight could not run: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
