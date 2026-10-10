#!/usr/bin/env node
// Proves a sharded Vitest run covered the suite: every test FILE the unsharded
// `vitest list --filesOnly --json` reports ran in exactly one shard, no shard ran
// a file the list does not have, and every shard of 1..N reported. The Vitest
// sibling of playwright-shard-coverage.mjs (the `spa-mock` proof); used by the
// gateway shards in .github/workflows/ci.yml.
//
//   node scripts/vitest-shard-coverage.mjs --root <dir> <full-list.json> <name-shard-1-of-N.json> [...]
//
// Inputs:
//  - the full list: `vitest list --filesOnly --json=<path>`, an array of { file }.
//    `vitest list` IGNORES --shard (measured, Vitest 4.1.11: every --shard=i/N
//    lists all files), so it is the unsharded list whatever flags it is given.
//  - one JSON report per shard: `vitest run --shard=i/N --reporter=json
//    --outputFile.json=<...>-shard-<i>-of-<N>.json`. Vitest's JSON report does
//    not record which shard produced it, so the shard is read from the FILE
//    NAME, and a name without `-shard-<i>-of-<N>.json` is refused.
// File paths in both are absolute; they are compared relative to --root, so a
// list and a report written on different runners (or checkouts) still match.
//
// Exit 0 = covered; exit 1 = a gap, an overlap or a missing shard, with every
// offending file named; exit 2 = bad usage. A sum of per-shard "N files" lines
// cannot tell a dropped file from a doubled one; this is a multiset comparison.

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHARD_NAME = /-shard-(\d+)-of-(\d+)\.json$/;

/** Parse `...-shard-<i>-of-<N>.json` into { current, total }, or null. */
export function shardOfName(name) {
  const m = SHARD_NAME.exec(name);
  return m ? { current: Number(m[1]), total: Number(m[2]) } : null;
}

const norm = (root, file) => {
  const rel = path.relative(root, file).split(path.sep).join("/");
  return rel.startsWith("../") || path.isAbsolute(rel) ? null : rel;
};

/**
 * @param {string} root files are compared relative to this directory
 * @param {{file: string}[]} fullList the unsharded `vitest list --filesOnly --json` output
 * @param {{name: string, report: {testResults?: {name: string, startTime?: number, endTime?: number}[]}}[]} shards
 */
export function checkVitestShardCoverage(root, fullList, shards) {
  const problems = [];
  const want = new Map();
  for (const { file } of Array.isArray(fullList) ? fullList : []) {
    const rel = norm(root, file);
    if (rel === null) { problems.push(`listed file is outside --root ${root}: ${file}`); continue; }
    want.set(rel, (want.get(rel) ?? 0) + 1);
  }
  if (want.size === 0) problems.push("the unsharded list has no test files — nothing was proven");
  for (const [f, n] of want) if (n > 1) problems.push(`listed ${n} times in the unsharded list: ${f}`);

  const perShard = [];
  const got = new Map();
  const seen = new Set();
  let total;
  for (const { name, report } of shards) {
    const sh = shardOfName(name);
    if (!sh) { problems.push(`report name does not say which shard it is (want *-shard-<i>-of-<N>.json): ${name}`); continue; }
    total ??= sh.total;
    if (sh.total !== total) problems.push(`shard ${sh.current}/${sh.total} disagrees with ${total} shards in the first report`);
    if (sh.current < 1 || sh.current > sh.total) problems.push(`shard ${sh.current}/${sh.total} is out of range`);
    if (seen.has(sh.current)) problems.push(`shard ${sh.current}/${sh.total} was reported twice`);
    seen.add(sh.current);
    const results = report?.testResults;
    if (!Array.isArray(results)) { problems.push(`shard ${sh.current}/${sh.total} report has no testResults (not a Vitest JSON report?)`); continue; }
    let ms = 0;
    for (const r of results) {
      const rel = norm(root, r.name);
      if (rel === null) { problems.push(`shard ${sh.current}/${sh.total} ran a file outside --root ${root}: ${r.name}`); continue; }
      got.set(rel, [...(got.get(rel) ?? []), sh.current]);
      if (typeof r.startTime === "number" && typeof r.endTime === "number") ms += r.endTime - r.startTime;
    }
    perShard.push({ shard: `${sh.current}/${sh.total}`, files: results.length, seconds: Math.round(ms / 1000) });
  }
  if (typeof total === "number") for (let k = 1; k <= total; k++) if (!seen.has(k)) problems.push(`shard ${k}/${total} has no report`);
  if (shards.length === 0) problems.push("no shard reports were given");
  for (const f of want.keys()) {
    const where = got.get(f) ?? [];
    if (where.length === 0) problems.push(`never ran in any shard: ${f}`);
    else if (where.length > 1) problems.push(`ran ${where.length} times (shards ${where.join(", ")}): ${f}`);
  }
  for (const f of got.keys()) if (!want.has(f)) problems.push(`ran in a shard but is not in the unsharded list: ${f}`);
  perShard.sort((a, b) => a.shard.localeCompare(b.shard, undefined, { numeric: true }));
  return { ok: problems.length === 0, problems, listed: want.size, perShard };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--root");
  const root = at >= 0 ? path.resolve(args[at + 1] ?? "") : null;
  const rest = at >= 0 ? args.filter((_, i) => i !== at && i !== at + 1) : args;
  const [fullPath, ...shardPaths] = rest;
  if (!root || !fullPath || shardPaths.length === 0) {
    console.error("usage: vitest-shard-coverage.mjs --root <dir> <full-list.json> <name-shard-1-of-N.json> [...]");
    process.exit(2);
  }
  const read = (p) => JSON.parse(readFileSync(p, "utf8"));
  const res = checkVitestShardCoverage(
    root,
    read(fullPath),
    shardPaths.map((p) => ({ name: path.basename(p), report: read(p) })),
  );
  const sum = res.perShard.reduce((a, s) => a + s.files, 0);
  console.log(
    `unsharded list: ${res.listed} files; shards: ${res.perShard.map((s) => `${s.shard}=${s.files} files/${s.seconds}s`).join(", ")}; sum ${sum}`,
  );
  if (!res.ok) {
    for (const p of res.problems) console.error(`  ✗ ${p}`);
    console.error(`shard coverage FAILED: ${res.problems.length} problem(s)`);
    process.exit(1);
  }
  console.log("shard coverage OK: every listed test file ran in exactly one shard");
}
