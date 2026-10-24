#!/usr/bin/env node
/**
 * FS-22 / ADR-0176 (2026-10-24 addendum) — the licence gate for the shipped workspace closure:
 * every package `pnpm licenses list --prod --json` reports (what the gateway and web images
 * install with `--prod`) is classified, offline, from pnpm's own reading of each package.
 *
 *   - allowed: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, or a public-domain dedication
 *     (Unlicense, CC0-1.0, 0BSD) — ADR-0176 rule 3. An `A OR B` expression passes when one
 *     alternative does; an `A AND B` expression when every part does.
 *   - admitted: BlueOak-1.0.0 or Python-2.0 (the ADR-0176 addendum), and ONLY for a package named
 *     with that licence in `licence-allow-workspace.json`. A new package under either licence
 *     fails until the owner adds it.
 *   - denied: anything else, an unknown or missing licence included.
 * An allow-file entry that no longer matches a package in the closure also fails, so the file
 * cannot rot.
 *
 * Usage: node scripts/licence-gate-workspace.mjs [licences.json]
 *   With no file it runs `pnpm licenses list --prod --json` itself. Exit 1 on any finding.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWED = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Unlicense", "CC0-1.0", "0BSD"]);
/** the only licences an allow-file entry may admit (ADR-0176 addendum, FS-22) */
export const ADMISSIBLE = new Set(["BlueOak-1.0.0", "Python-2.0"]);

/** true when an SPDX id or a flat `AND`/`OR` expression is on the ADR-0176 list */
export function isAllowed(spdx) {
  if (typeof spdx !== "string" || !spdx.trim()) return false;
  const expr = spdx.trim().replace(/^\((.*)\)$/, "$1");
  if (/\s(AND|OR)\s/i.test(expr) && /[()]/.test(expr)) return false; // nested: decide by hand
  if (/\sAND\s/i.test(expr)) return expr.split(/\s+AND\s+/i).every((p) => ALLOWED.has(p.trim()));
  return expr.split(/\s+OR\s+/i).some((p) => ALLOWED.has(p.trim()));
}

/**
 * @param {Record<string, Array<{name: string, versions?: string[]}>>} byLicence pnpm's JSON
 * @param {Array<{subject: string, licence: string}>} allow
 * @returns {{ checked: number, admitted: string[], problems: string[] }}
 */
export function checkLicences(byLicence, allow) {
  const problems = [];
  const admitted = [];
  const used = new Set();
  let checked = 0;
  for (const e of allow) {
    if (!ADMISSIBLE.has(e.licence)) problems.push(`allow file: ${e.subject} names ${e.licence}, which no ADR admits`);
  }
  for (const [licence, pkgs] of Object.entries(byLicence)) {
    for (const p of pkgs) {
      checked++;
      const id = `${p.name}@${(p.versions ?? []).join(",")} ${licence}`;
      if (isAllowed(licence)) continue;
      const entry = allow.find((e) => e.subject === p.name && e.licence === licence && ADMISSIBLE.has(e.licence));
      if (entry) {
        used.add(entry);
        admitted.push(id);
      } else problems.push(`DENIED ${id}`);
    }
  }
  for (const e of allow) if (!used.has(e)) problems.push(`allow file: ${e.subject} (${e.licence}) is not in the closure; remove it`);
  return { checked, admitted, problems };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let raw;
  if (process.argv[2]) raw = readFileSync(process.argv[2], "utf8");
  else {
    const r = spawnSync("pnpm", ["licenses", "list", "--prod", "--json"], { cwd: path.resolve(here, ".."), encoding: "utf8", maxBuffer: 64 << 20 });
    if (r.status !== 0) {
      console.error(`pnpm licenses list failed (${r.status}): ${r.stderr}`);
      process.exit(2);
    }
    raw = r.stdout;
  }
  const allow = JSON.parse(readFileSync(path.join(here, "licence-allow-workspace.json"), "utf8"));
  const res = checkLicences(JSON.parse(raw), allow);
  console.log(`workspace licence gate: ${res.checked} packages, ${res.admitted.length} admitted by the allow file, ${res.problems.length} problems`);
  for (const a of res.admitted) console.log(`  admitted ${a}`);
  for (const p of res.problems) console.log(`  ${p}`);
  process.exit(res.problems.length ? 1 : 0);
}
