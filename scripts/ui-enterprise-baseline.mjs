#!/usr/bin/env node
/**
 * The enterprise UI harness's baselines (ADR-0196): write them from a run, check a run against them, and refuse a
 * baseline that grows.
 *
 * The browser checks (apps/web/e2e/enterprise) compare each screen against apps/web/e2e/enterprise/baselines/
 * <category>.json themselves and fail on anything above it; they also record every result in the findings
 * directory (apps/web/test-results/enterprise-findings, one JSON line per screen and check). This script:
 *
 *   --update [dir]      rewrite the baselines from the findings of a run. A key the run covered is replaced (and
 *                       removed when it has no findings); a key the run did not cover is kept, so a Chromium-only
 *                       run leaves the Firefox and WebKit entries alone.
 *   --stale [dir]       list baseline entries the run found fewer of (they should be shrunk with --update). Prints
 *                       only: a browser check can find fewer through timing, so this never fails a run.
 *   --guard <git-ref>   compare every baseline (the browser ones and scripts/ui-tokens.baseline.json) with the same
 *                       file at <git-ref>, and exit 1 if any count went UP or any entry was added: baselines only
 *                       shrink. A file missing at <git-ref> is skipped (the PR that introduces it).
 *
 * Exit 0 clean, 1 on a guard failure, 2 if it could not run.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE_DIR = path.join(root, "apps", "web", "e2e", "enterprise", "baselines");
export const CATEGORIES = ["axe", "keyboard", "responsive", "states", "density", "perf"];
const TOKENS_BASELINE = "scripts/ui-tokens.baseline.json";
const DEFAULT_FINDINGS = path.join(root, "apps", "web", "test-results", "enterprise-findings");
const ABOUT = {
  axe: "serious and critical axe violations (node counts) per screen|theme",
  keyboard: "keyboard-journey findings per browser|journey",
  responsive: "layout findings per browser|screen at the five viewports",
  states: "loading and error state findings per screen",
  density: "table cells off the kit's density per screen",
  perf: "screens over the LCP / INP budget",
};

const relPath = (abs) => path.relative(root, abs).split(path.sep).join("/");
const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k] && typeof o[k] === "object" ? sortObj(o[k]) : o[k]]));

/** `{ category: { key: findings } }` from the findings directory; a later line for the same key wins */
export function readFindings(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(path.join(dir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const { category, key, findings } = JSON.parse(line);
      (out[category] ??= {})[key] = findings;
    }
  }
  return out;
}

export function readBaseline(category) {
  const file = path.join(BASELINE_DIR, `${category}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).entries : {};
}

/** the baseline after a run: covered keys replaced (dropped when empty), the rest kept */
export function merge(baseline, run) {
  const next = { ...baseline };
  for (const [key, findings] of Object.entries(run)) {
    const kept = Object.fromEntries(Object.entries(findings).filter(([, n]) => n > 0));
    if (Object.keys(kept).length) next[key] = kept;
    else delete next[key];
  }
  return sortObj(next);
}

/** entries that grew or were added from `before` to `after`, as lines */
export function growth(before, after) {
  const out = [];
  for (const [key, findings] of Object.entries(after)) {
    for (const [finding, n] of Object.entries(findings)) {
      const was = before[key]?.[finding] ?? 0;
      if (n > was) out.push(`${key}: ${finding} ${was} -> ${n}`);
    }
  }
  return out;
}

/** entries the run found fewer of than the baseline allows */
export function stale(baseline, run) {
  const out = [];
  for (const [key, findings] of Object.entries(run)) {
    for (const [finding, allowed] of Object.entries(baseline[key] ?? {})) {
      const n = findings[finding] ?? 0;
      if (n < allowed) out.push(`${key}: ${finding} ${n} (baseline ${allowed})`);
    }
  }
  return out;
}

function writeBaseline(category, entries) {
  const file = path.join(BASELINE_DIR, `${category}.json`);
  writeFileSync(file, `${JSON.stringify({ _about: `ADR-0196: ${ABOUT[category]}. Counts may only shrink.`, entries }, null, 2)}\n`);
  return file;
}

function atRef(ref, file) {
  try {
    return JSON.parse(execFileSync("git", ["show", `${ref}:${file}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).entries;
  } catch {
    return null;
  }
}

function main(argv) {
  const [mode, arg] = argv;
  if (mode === "--update" || mode === "--stale") {
    const run = readFindings(path.resolve(arg ?? DEFAULT_FINDINGS));
    if (Object.keys(run).length === 0) {
      console.error(`no findings under ${arg ?? DEFAULT_FINDINGS}; run the harness first`);
      return 2;
    }
    for (const category of CATEGORIES.filter((c) => run[c])) {
      if (mode === "--update") {
        const next = merge(readBaseline(category), run[category]);
        const total = Object.values(next).reduce((n, f) => n + Object.values(f).reduce((a, b) => a + b, 0), 0);
        console.log(`${relPath(writeBaseline(category, next))}: ${Object.keys(next).length} keys, ${total} findings`);
      } else {
        for (const line of stale(readBaseline(category), run[category])) console.log(`STALE ${category} ${line}`);
      }
    }
    return 0;
  }
  if (mode === "--guard" && arg) {
    const files = [...CATEGORIES.map((c) => relPath(path.join(BASELINE_DIR, `${c}.json`))), TOKENS_BASELINE];
    let failed = 0;
    for (const file of files) {
      const before = atRef(arg, file);
      if (before === null) {
        console.log(`${file}: not on ${arg}; nothing to compare`);
        continue;
      }
      const after = existsSync(path.join(root, file)) ? JSON.parse(readFileSync(path.join(root, file), "utf8")).entries : {};
      const grew = growth(before, after);
      for (const line of grew) console.log(`::error file=${file}::the baseline grew (fix the violation instead): ${line}`);
      failed += grew.length;
    }
    console.log(failed ? `${failed} baseline entries grew` : "no baseline grew");
    return failed ? 1 : 0;
  }
  console.error("usage: ui-enterprise-baseline.mjs --update [findingsDir] | --stale [findingsDir] | --guard <git-ref>");
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(err);
    process.exit(2);
  }
}
