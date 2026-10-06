#!/usr/bin/env node
// Proves a sharded Playwright run covered the suite: every test the UNSHARDED
// `playwright test --list` reports ran in exactly one shard, no shard ran a test
// the list does not have, and every shard of 1..N reported (ADR-0183 batch 2.4).
//
//   node scripts/playwright-shard-coverage.mjs <full-list.json> <shard-1.json> [<shard-2.json> ...]
//
// A test's id is its project, file and title path (see testsOf).
//
// Inputs are Playwright JSON reports: the full list from
// `playwright test --list --reporter=json`, each shard's from
// `--shard=i/N --reporter=json`. Exit 0 = covered; exit 1 = a gap or an
// overlap, with every offending test named.
//
// Why a script and not a tool: Playwright's own `merge-reports` merges shard
// reports but does not compare them with the unsharded list, and a sum of the
// per-shard "N passed" lines cannot tell a missing test from a doubled one. This
// is a multiset comparison of test ids, nothing more.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Flatten a Playwright JSON report into [{ id, ran }] — one entry per test (per project). */
export function testsOf(report) {
  const out = [];
  const walk = (suite, titles) => {
    const here = suite.title && !suite.file?.endsWith(suite.title) ? [...titles, suite.title] : titles;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        // file + title path, NOT line:column: Playwright refuses two tests with
        // the same title path in one file, so this is unique, while the line it
        // reports was measured to differ between two `--list` runs of the same
        // tree (a cold transform cache reported compiled-code lines: 206 for a
        // test at line 132), which would fail this check on a correct run.
        const id = `${t.projectName ?? ""}|${spec.file} › ${[...here, spec.title].join(" › ")}`;
        out.push({ id, ran: (t.results ?? []).length > 0 });
      }
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const s of report.suites ?? []) walk(s, []);
  return out;
}

/**
 * @param {object} fullList the unsharded `--list` report
 * @param {object[]} shards one report per shard
 * @returns {{ ok: boolean, problems: string[], listed: number, perShard: { shard: string, tests: number }[] }}
 */
export function checkShardCoverage(fullList, shards) {
  const problems = [];
  const listed = testsOf(fullList);
  if (listed.length === 0) problems.push("the unsharded --list report has no tests — nothing was proven");
  const want = new Map();
  for (const { id } of listed) want.set(id, (want.get(id) ?? 0) + 1);
  for (const [id, n] of want) if (n > 1) problems.push(`listed ${n} times in the unsharded list (ambiguous id): ${id}`);

  const total = shards[0]?.config?.shard?.total;
  const seenShard = new Set();
  const perShard = [];
  const got = new Map();
  for (const [i, r] of shards.entries()) {
    const sh = r.config?.shard;
    if (!sh || typeof sh.current !== "number" || typeof sh.total !== "number") {
      problems.push(`report #${i + 1} was not produced by a sharded run (config.shard is missing)`);
      continue;
    }
    if (sh.total !== total) problems.push(`shard ${sh.current}/${sh.total} disagrees with ${total} shards in the first report`);
    if (seenShard.has(sh.current)) problems.push(`shard ${sh.current}/${sh.total} was reported twice`);
    seenShard.add(sh.current);
    const tests = testsOf(r);
    perShard.push({ shard: `${sh.current}/${sh.total}`, tests: tests.length });
    for (const { id, ran } of tests) {
      if (!ran) problems.push(`in shard ${sh.current}/${sh.total} but has no result (did not run): ${id}`);
      got.set(id, [...(got.get(id) ?? []), sh.current]);
    }
  }
  if (typeof total === "number") {
    for (let k = 1; k <= total; k++) if (!seenShard.has(k)) problems.push(`shard ${k}/${total} has no report`);
  }
  for (const id of want.keys()) {
    const where = got.get(id) ?? [];
    if (where.length === 0) problems.push(`never ran in any shard: ${id}`);
    else if (where.length > 1) problems.push(`ran in ${where.length} shards (${where.join(", ")}): ${id}`);
  }
  for (const id of got.keys()) if (!want.has(id)) problems.push(`ran in a shard but is not in the unsharded list: ${id}`);
  return { ok: problems.length === 0, problems, listed: listed.length, perShard };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [fullPath, ...shardPaths] = process.argv.slice(2);
  if (!fullPath || shardPaths.length === 0) {
    console.error("usage: playwright-shard-coverage.mjs <full-list.json> <shard-1.json> [<shard-2.json> ...]");
    process.exit(2);
  }
  const read = (p) => JSON.parse(readFileSync(p, "utf8"));
  const res = checkShardCoverage(read(fullPath), shardPaths.map(read));
  const sum = res.perShard.reduce((a, s) => a + s.tests, 0);
  console.log(`unsharded --list: ${res.listed} tests; shards: ${res.perShard.map((s) => `${s.shard}=${s.tests}`).join(", ")}; sum ${sum}`);
  if (!res.ok) {
    for (const p of res.problems) console.error(`  ✗ ${p}`);
    console.error(`shard coverage FAILED: ${res.problems.length} problem(s)`);
    process.exit(1);
  }
  console.log("shard coverage OK: every listed test ran in exactly one shard");
}
