#!/usr/bin/env node
// THIRD_PARTY completeness (#738, review O-01; CLAUDE.md "open source first", rule 3).
//
// Every production dependency of a workspace package (apps/*, packages/*: `dependencies` that are not `workspace:`)
// has a row in that package's THIRD_PARTY.md, and the row's version cell names the version the lockfile resolves.
// A row is a Markdown table line whose first cell starts with the package name in backticks (`| \`zod\` | 4.6.7 |`);
// other rows (vendored rulesets, data, prose) are left alone. The lockfile is the source of truth for versions.
//
// usage: node scripts/preflight-third-party.mjs [--root <dir>] [--print-missing]
//   --print-missing  print a stub row (name, lockfile version, installed licence) for each missing one, to paste
// exit 0 complete, 1 rows missing or stale, 2 a read error (fails closed, M-103).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const WORKSPACE_DIRS = ["apps", "packages"];

/** name -> version cell, from the rows of a THIRD_PARTY.md */
export function parseRows(markdown) {
  const rows = new Map();
  for (const line of markdown.split("\n")) {
    const m = /^\|\s*`([^`]+)`/.exec(line);
    if (!m) continue;
    const cells = line.split(/(?<!\\)\|/);
    rows.set(m[1], (cells[2] ?? "").trim());
  }
  return rows;
}

/** "1.2.3(peer@4)" -> "1.2.3" */
const bare = (v) => String(v).replace(/\(.*$/, "");

/** a version cell names `version` as a whole token (so 1.2.3 matches "`1.2.3` (pinned)" but not 11.2.3 or 1.2.30) */
export function cellNames(cell, version) {
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![0-9.])${esc}(?![0-9]|\\.[0-9])`).test(cell);
}

/** the problems for every workspace package under `root`, as { dir, name, version, kind, cell } */
export function thirdPartyProblems(root) {
  const lock = yaml.load(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"));
  const out = [];
  const dirs = WORKSPACE_DIRS.flatMap((b) =>
    existsSync(path.join(root, b)) ? readdirSync(path.join(root, b)).map((d) => `${b}/${d}`) : [],
  ).filter((d) => existsSync(path.join(root, d, "package.json")));
  if (dirs.length === 0) throw new Error(`no workspace packages under ${root}`);
  for (const dir of dirs.sort()) {
    const pkg = JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8"));
    const deps = Object.entries(pkg.dependencies ?? {}).filter(([, spec]) => !String(spec).startsWith("workspace:"));
    if (deps.length === 0) continue;
    const file = path.join(root, dir, "THIRD_PARTY.md");
    const rows = existsSync(file) ? parseRows(readFileSync(file, "utf8")) : new Map();
    const resolved = lock.importers?.[dir]?.dependencies ?? {};
    for (const [name] of deps.sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!resolved[name]) throw new Error(`${dir}: ${name} is in package.json but not in pnpm-lock.yaml (run pnpm install)`);
      const version = bare(resolved[name].version);
      if (!rows.has(name)) out.push({ dir, name, version, kind: "missing" });
      else if (!cellNames(rows.get(name), version)) out.push({ dir, name, version, kind: "version", cell: rows.get(name) });
    }
  }
  return out;
}

function licenceOf(root, dir, name) {
  try {
    const p = JSON.parse(readFileSync(path.join(root, dir, "node_modules", name, "package.json"), "utf8"));
    return typeof p.license === "string" ? p.license : "UNKNOWN";
  } catch {
    return "UNKNOWN (not installed)";
  }
}

function main(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let printMissing = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") root = path.resolve(argv[++i] ?? "");
    else if (argv[i] === "--print-missing") printMissing = true;
    else {
      console.error("usage: node scripts/preflight-third-party.mjs [--root <dir>] [--print-missing]");
      return 2;
    }
  }
  let problems;
  try {
    problems = thirdPartyProblems(root);
  } catch (e) {
    console.error(`preflight-third-party: ${e.message}`);
    return 2;
  }
  if (problems.length === 0) {
    console.log("preflight-third-party: every production dependency has a THIRD_PARTY.md row at its lockfile version");
    return 0;
  }
  for (const p of problems) {
    if (p.kind === "missing") console.error(`  ${p.dir}/THIRD_PARTY.md: no row for ${p.name} (${p.version})`);
    else console.error(`  ${p.dir}/THIRD_PARTY.md: the ${p.name} row says "${p.cell}", the lockfile resolves ${p.version}`);
  }
  if (printMissing) {
    for (const p of problems.filter((x) => x.kind === "missing")) {
      console.log(`${p.dir}: | \`${p.name}\` | ${p.version} | ${licenceOf(root, p.dir, p.name)} | <why, ADR> |`);
    }
  }
  console.error(
    `preflight-third-party: ${problems.length} problem(s). Add or update each row (ADR-0176 rule 3: licence, maintenance, ` +
      "pin, air-gapped); --print-missing prints stubs with the lockfile version and the installed licence.",
  );
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
