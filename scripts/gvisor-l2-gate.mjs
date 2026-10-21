#!/usr/bin/env node
// The gVisor job's L2 gate (.github/workflows/gvisor.yml): the runsc integration tests' Vitest JSON report proves
// every REQUIRED control ran and passed, by title. A count alone (passed == total, none skipped) stays green when a
// negative control is deleted (the #385 review, L1), so each required title must be present and passed, and nothing
// may be skipped or failed.
//
//   node scripts/gvisor-l2-gate.mjs <vitest-runsc.json>
//
// Exit 0 = every required control passed; exit 1 = a control missing, skipped or failed (each one named);
// exit 2 = bad usage.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** the titles in packages/sandbox-executor/src/runsc-backend.integration.test.ts; a rename must update both */
export const REQUIRED_TITLES = [
  "the canary under the restricted profile passes the gateway's evaluator at user_space_kernel",
  "negative control: a runtime that is not runsc is refused before any sandbox starts",
  "negative control: a runsc binary that is not the pinned release is refused before any sandbox starts",
];

/** @returns {string[]} the problems; empty when the gate passes */
export function checkRunscReport(report, required = REQUIRED_TITLES) {
  const problems = [];
  const results = (report?.testResults ?? []).flatMap((f) => f?.assertionResults ?? []);
  const total = Number(report?.numTotalTests ?? 0);
  const passed = Number(report?.numPassedTests ?? 0);
  const skipped = Number(report?.numPendingTests ?? 0) + Number(report?.numTodoTests ?? 0);
  if (passed <= 0 || skipped !== 0 || passed !== total) {
    problems.push(`the runsc integration tests did not all run: ${passed} passed of ${total}, ${skipped} skipped`);
  }
  for (const title of required) {
    const hits = results.filter((r) => r?.title === title);
    if (hits.length === 0) problems.push(`required control missing: ${title}`);
    else if (!hits.every((r) => r.status === "passed")) {
      problems.push(`required control did not pass (${hits.map((r) => r.status).join(", ")}): ${title}`);
    }
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [file] = process.argv.slice(2);
  if (!file) {
    console.error("usage: node scripts/gvisor-l2-gate.mjs <vitest-runsc.json>");
    process.exit(2);
  }
  const problems = checkRunscReport(JSON.parse(readFileSync(file, "utf8")));
  for (const p of problems) console.log(`::error::${p}`);
  if (problems.length) process.exit(1);
  console.log(`every required runsc control passed: ${REQUIRED_TITLES.length} of ${REQUIRED_TITLES.length}`);
}
