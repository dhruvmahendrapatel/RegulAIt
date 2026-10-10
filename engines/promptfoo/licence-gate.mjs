#!/usr/bin/env node
/**
 * ADR-0187 B5-P / ADR-0176 — the licence gate for the promptfoo image's npm closure, run offline
 * from the lockfile (npm records each package's `license` in package-lock v3). The image build
 * runs it before anything is installed; packages/engine-promptfoo/src/image.test.ts runs it on the
 * committed lockfile.
 *
 * Every package `npm ci --omit=optional` installs is classified:
 *   - allowed: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, or a public-domain dedication
 *     (Unlicense, CC0-1.0, 0BSD) — ADR-0176 rule 3; an `(A OR B)` expression passes when one
 *     alternative does;
 *   - pending: permissive licences outside that list (Artistic-2.0, BlueOak-1.0.0, Python-2.0).
 *     They do not fail the build, but the image is NOT admissible until the owner decides
 *     (ADR-0187 open question; the manifest lists it as unverified);
 *   - denied: anything else — the GPL family, SSPL, BUSL, EPL, MPL, an unknown or missing licence.
 *     The build fails.
 * A package whose lockfile entry has no licence is denied unless it is in KNOWN below, each entry
 * verified by hand against the package's own LICENSE file.
 *
 * Usage: node licence-gate.mjs <package-lock.json>  → prints a summary; exit 1 on any denied.
 */
import { readFileSync } from "node:fs";

export const ALLOWED = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Unlicense", "CC0-1.0", "0BSD"]);
export const PENDING = new Set(["Artistic-2.0", "BlueOak-1.0.0", "Python-2.0"]);
/** lockfile entries with no `license` field, verified by hand (path → licence, and how) */
export const KNOWN = {
  "node_modules/xmlhttprequest-ssl": "MIT", // 2.1.2: legacy `licenses` array naming MIT; LICENSE file is the MIT text
};

/** classify one SPDX string (or an `(A OR B)` expression): allowed | pending | denied */
export function classifyLicence(spdx) {
  if (typeof spdx !== "string" || !spdx.trim()) return "denied";
  const alternatives = spdx.replace(/^\(|\)$/g, "").split(/\s+OR\s+/i).map((s) => s.trim());
  if (/\sAND\s/i.test(spdx)) {
    // every part must be acceptable
    const parts = spdx.replace(/^\(|\)$/g, "").split(/\s+AND\s+/i).map((s) => s.trim());
    if (parts.every((p) => ALLOWED.has(p))) return "allowed";
    if (parts.every((p) => ALLOWED.has(p) || PENDING.has(p))) return "pending";
    return "denied";
  }
  if (alternatives.some((a) => ALLOWED.has(a))) return "allowed";
  if (alternatives.some((a) => PENDING.has(a))) return "pending";
  return "denied";
}

/** the inventory of what `npm ci --omit=optional` installs from this lockfile */
export function licenceInventory(lock) {
  const out = { allowed: [], pending: [], denied: [] };
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path || entry.optional || entry.dev || entry.link) continue;
    const spdx = entry.license ?? KNOWN[path] ?? null;
    const row = { path, version: entry.version, licence: spdx };
    out[classifyLicence(spdx)].push(row);
  }
  return out;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: licence-gate.mjs <package-lock.json>");
    process.exit(2);
  }
  const inv = licenceInventory(JSON.parse(readFileSync(file, "utf8")));
  console.log(`licence gate: ${inv.allowed.length} allowed, ${inv.pending.length} pending an owner decision, ${inv.denied.length} denied`);
  for (const r of inv.pending) console.log(`  pending  ${r.path}@${r.version} ${r.licence}`);
  for (const r of inv.denied) console.log(`  DENIED   ${r.path}@${r.version} ${r.licence ?? "(no licence)"}`);
  process.exit(inv.denied.length ? 1 : 0);
}
