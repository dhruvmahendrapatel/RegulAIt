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
 *                       It also guards the bundle-size ceilings (apps/web/.size-limit.json), entry by entry keyed by
 *                       `name`: a raised `limit`, a removed entry, or a changed `path`, `gzip` or other option fails.
 *                       A new entry is allowed (it only adds a ceiling). A ceiling may rise only through an exception
 *                       recorded in an ADR, landed by the owner (ADR-0196): one row of CEILING_EXCEPTIONS below, which
 *                       allows exactly one raise (that entry, from that limit, to that limit), names a dated owner
 *                       decision, and fails unless ADR-0196 records that decision's link. Any other raise still fails.
 *                       And it fails when the ceilings could be read from anywhere else: size-limit searches
 *                       package.json before .size-limit.json, so a `size-limit` key in apps/web/package.json, another
 *                       apps/web/.size-limit* file (.js, .cjs, …), or a `size` script that does not pin
 *                       `--config .size-limit.json` would bypass the guarded file. Those are checked on HEAD alone.
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
export const SIZE_LIMIT_FILE = "apps/web/.size-limit.json";
const WEB_DIR = path.join(root, "apps", "web");
/** the one way the `size` script may call size-limit: with the guarded file pinned */
export const SIZE_SCRIPT_PIN = "size-limit --config .size-limit.json";
export const SIZE_LIMIT_ADR = "internal/decisions/0196-ui-enterprise-harness.md";

/**
 * Owner-approved ceiling raises (ADR-0196). Each row allows one raise of one `.size-limit.json` entry, from exactly
 * `from` to exactly `to` (compared in bytes), and nothing else: a raise to any other value, from any other value, or of
 * another entry still fails. `decision` is the owner's dated comment; ADR-0196 must record the same link. Once the
 * raise is on the base branch a row matches nothing and may be deleted.
 */
export const CEILING_EXCEPTIONS = [
  { name: "all JS", from: "1036 kB", to: "1038 kB", date: "2026-10-21", decision: "https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6328260537" },
  { name: "entry JS (index)", from: "137.3 kB", to: "137.7 kB", date: "2026-10-24", decision: "https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6385378784" },
  { name: "entry CSS (index)", from: "10.6 kB", to: "10.7 kB", date: "2026-10-24", decision: "https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6385378784" },
  { name: "all JS", from: "1038 kB", to: "1040 kB", date: "2026-10-24", decision: "https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6388659678" },
  { name: "entry JS (index)", from: "137.7 kB", to: "137.9 kB", date: "2026-10-25", decision: "https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6393701751" },
  { name: "all JS", from: "1040 kB", to: "1041 kB", date: "2026-10-25", decision: "https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6393701751" },
  { name: "all JS", from: "1041 kB", to: "1043 kB", date: "2026-10-25", decision: "https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6396960492" },
  { name: "entry JS (index)", from: "137.9 kB", to: "138.5 kB", date: "2026-10-25", decision: "https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6402364303" },
  { name: "all JS", from: "1043 kB", to: "1046 kB", date: "2026-10-29", decision: "https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6494584993" },
  // G2 + G11 (#453): one raise to 1048 kB, landing either before #597 (from 1043) or after it (from 1046)
  { name: "all JS", from: "1043 kB", to: "1048 kB", date: "2026-10-29", decision: "https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6498510014" },
  { name: "all JS", from: "1046 kB", to: "1048 kB", date: "2026-10-29", decision: "https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6498510014" },
  // G2 + G11 (#599) with batch I-1 (#597) merged in: measured 1,049,109 B
  { name: "all JS", from: "1048 kB", to: "1050 kB", date: "2026-10-30", decision: "https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6515493026" },
  // themes phase 2 (ADR-0218): measured 1,051,200 B, inside the owner's shared 1,060 kB budget for 2026-10-30
  { name: "all JS", from: "1050 kB", to: "1053 kB", date: "2026-10-30", decision: "https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6522492997" },
];
const DECISION_LINK = /^https:\/\/github\.com\/dhruvmahendrapatel\/RegulAIt\/issues\/\d+#issuecomment-\d+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * whether one line of `adrText` names this row's raise: `` `name` ``, then `` `from` ``, then `` `to` ``, each in
 * backticks. The decision link alone is not enough: the ADR keeps it after the row goes, so a later row could cite it.
 */
function adrNamesRaise(e, adrText) {
  const tick = (v) => `\`${v}\``;
  return adrText.split("\n").some((line) => {
    const n = line.indexOf(tick(e.name));
    const f = n < 0 ? -1 : line.indexOf(tick(e.from), n + tick(e.name).length);
    return f >= 0 && line.indexOf(tick(e.to), f + tick(e.from).length) >= 0;
  });
}

/**
 * problems with the exception rows themselves, as lines: a missing date or decision link, a link `adrText` lacks, or a
 * raise (entry, from, to) that no line of `adrText` names
 */
export function ceilingExceptionProblems(exceptions, adrText) {
  const out = [];
  for (const e of exceptions) {
    const label = `exception "${e.name}" ${e.from} -> ${e.to}`;
    if (!ISO_DATE.test(e.date ?? "")) out.push(`${label}: no dated owner decision (date "${e.date}")`);
    if (!DECISION_LINK.test(e.decision ?? "")) out.push(`${label}: decision must link an owner comment (it is "${e.decision}")`);
    else if (!adrText.includes(e.decision)) out.push(`${label}: ${SIZE_LIMIT_ADR} does not record ${e.decision}`);
    if (!adrNamesRaise(e, adrText)) out.push(`${label}: no line of ${SIZE_LIMIT_ADR} names \`${e.name}\` from \`${e.from}\` to \`${e.to}\``);
  }
  return out;
}

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

/**
 * A size-limit `limit` in bytes, read exactly as size-limit 14.2.0 reads it (its bytes.js `parseBytes`: B, kB, MB…
 * are powers of 1000, KiB, MiB… powers of 1024, case-insensitive; a bare number is bytes). size-limit does not export
 * that function (only its CLI and `index.js`), so it is mirrored here; the test pins it against size-limit's own
 * examples and a drift test compares it with size-limit's own bytes.js over a value table. Returns null for anything
 * else (a time limit such as "1 s" is not a size).
 *
 * Copied from size-limit 14.2.0 bytes.js, (c) Andrey Sitnik, MIT licence (listed in apps/web/THIRD_PARTY.md).
 * ADR-0176 §4 exception: `bytes` reads kB as 1024, so no importable module matches size-limit's semantics.
 */
export function parseBytes(value) {
  if (typeof value === "number") return value;
  const match = /^([+-]?\d+(?:\.\d+)?) *(?:([kmgtpezy])?(i)?b)?$/i.exec(String(value));
  if (!match) return null;
  const [, number, prefix, iec] = match;
  const power = prefix ? "kmgtpezy".indexOf(prefix.toLowerCase()) + 1 : 0;
  return Math.floor(parseFloat(number) * (iec ? 1024 : 1000) ** power);
}

/**
 * what loosened from the `before` .size-limit.json to `after`, as lines: raised limits, removed or changed entries.
 * A raise that matches one of `exceptions` exactly (entry name, from and to in bytes), and that `adrText` records (see
 * ceilingExceptionProblems), is not a line.
 */
export function sizeLimitLoosened(before, after, exceptions = [], adrText = "") {
  const byName = (checks, side) => {
    const out = new Map();
    for (const c of checks) {
      if (out.has(c.name)) throw new Error(`${SIZE_LIMIT_FILE} (${side}) names "${c.name}" twice`);
      out.set(c.name, c);
    }
    return out;
  };
  const was = byName(before, "base");
  const now = byName(after, "head");
  const options = (c) => JSON.stringify(sortObj(Object.fromEntries(Object.entries({ ...c, path: [c.path].flat() }).filter(([k]) => k !== "name" && k !== "limit"))));
  const out = [];
  for (const [name, b] of was) {
    const a = now.get(name);
    if (!a) {
      out.push(`"${name}": entry removed`);
      continue;
    }
    const lb = parseBytes(b.limit);
    const la = parseBytes(a.limit);
    if (la === null) out.push(`"${name}": limit "${a.limit}" is not a size`);
    else if (lb !== null && la > lb) {
      const allowed = exceptions.some(
        (e) => e.name === name && parseBytes(e.from) === lb && parseBytes(e.to) === la && ceilingExceptionProblems([e], adrText).length === 0,
      );
      if (!allowed) out.push(`"${name}": limit raised ${b.limit} -> ${a.limit}`);
    }
    if (options(a) !== options(b)) out.push(`"${name}": path, gzip or another option changed`);
  }
  return out;
}

/**
 * Ways the bundle ceilings could be read from somewhere other than the guarded .size-limit.json, as lines.
 * `pkg` is apps/web/package.json, `files` the names in apps/web.
 */
export function sizeLimitBypass(pkg, files) {
  const out = [];
  if (Object.hasOwn(pkg, "size-limit")) out.push(`apps/web/package.json has a "size-limit" key, which size-limit reads before .size-limit.json`);
  for (const name of files.filter((n) => n.startsWith(".size-limit") && n !== ".size-limit.json").sort()) {
    out.push(`apps/web/${name} is a second size-limit config; the ceilings live only in .size-limit.json`);
  }
  const script = pkg.scripts?.size ?? "";
  if (script.trim() !== SIZE_SCRIPT_PIN) out.push(`apps/web/package.json script "size" must be exactly "${SIZE_SCRIPT_PIN}" (it is "${script}")`);
  return out;
}

function writeBaseline(category, entries) {
  const file = path.join(BASELINE_DIR, `${category}.json`);
  writeFileSync(file, `${JSON.stringify({ _about: `ADR-0196: ${ABOUT[category]}. Counts may only shrink.`, entries }, null, 2)}\n`);
  return file;
}

/** the parsed JSON of `file` at `ref`, or null when it is not there */
function atRef(ref, file) {
  let text;
  try {
    text = execFileSync("git", ["show", `${ref}:${file}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
  return JSON.parse(text);
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
    const adr = path.join(root, SIZE_LIMIT_ADR);
    const adrText = existsSync(adr) ? readFileSync(adr, "utf8") : "";
    for (const file of files) {
      const before = atRef(arg, file)?.entries ?? null;
      if (before === null) {
        console.log(`${file}: not on ${arg}; nothing to compare`);
        continue;
      }
      const after = existsSync(path.join(root, file)) ? JSON.parse(readFileSync(path.join(root, file), "utf8")).entries : {};
      const grew = growth(before, after);
      for (const line of grew) console.log(`::error file=${file}::the baseline grew (fix the violation instead): ${line}`);
      failed += grew.length;
    }
    const limitsBefore = atRef(arg, SIZE_LIMIT_FILE);
    if (limitsBefore === null) console.log(`${SIZE_LIMIT_FILE}: not on ${arg}; nothing to compare`);
    else {
      const file = path.join(root, SIZE_LIMIT_FILE);
      const limitsAfter = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
      const loosened = sizeLimitLoosened(limitsBefore, limitsAfter, CEILING_EXCEPTIONS, adrText);
      for (const line of loosened) {
        console.log(`::error file=${SIZE_LIMIT_FILE}::a bundle ceiling loosened (a ceiling rises only through an ADR-recorded exception): ${line}`);
      }
      failed += loosened.length;
    }
    const unrecorded = ceilingExceptionProblems(CEILING_EXCEPTIONS, adrText);
    for (const line of unrecorded) console.log(`::error file=scripts/ui-enterprise-baseline.mjs::a ceiling exception is not an owner decision recorded in ADR-0196: ${line}`);
    failed += unrecorded.length;
    const bypass = sizeLimitBypass(JSON.parse(readFileSync(path.join(WEB_DIR, "package.json"), "utf8")), readdirSync(WEB_DIR));
    for (const line of bypass) console.log(`::error file=apps/web/package.json::the bundle ceilings could bypass ${SIZE_LIMIT_FILE}: ${line}`);
    failed += bypass.length;
    console.log(failed ? `${failed} baseline entries grew or ceilings loosened` : "no baseline grew and no ceiling loosened");
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
