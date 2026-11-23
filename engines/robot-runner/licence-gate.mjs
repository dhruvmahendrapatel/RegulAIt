#!/usr/bin/env node
/**
 * ADR-0364 S3 / ADR-0176 — the licence gate for the robot runner image's npm closure, run inside the image build on
 * the INSTALLED tree (`pnpm deploy --prod` output), so it judges exactly what ships.
 *
 * Every package directory under the tree's node_modules (pnpm's `.pnpm` store included; each real directory once) is
 * judged by its package.json `license`:
 *   - first-party: `@regulait/*` workspace packages (private), not judged here;
 *   - allowed: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, Unlicense, CC0-1.0, 0BSD (ADR-0176 rule 3); an
 *     `(A OR B)` expression passes when one alternative does, an `A AND B` one when every part does;
 *   - a row in licence-allow.json ({subject: "<name>@<version>", licence, decision}) admits anything else: "accepted
 *     by owner …" admitted; "… owner to confirm …" admitted but reported PENDING (the image is not admissible until
 *     the owner decides); a row that matches nothing fails the build as stale;
 *   - denied: everything else, a missing licence included. The build fails.
 *
 * Usage: node licence-gate.mjs <deployed dir> [licence-allow.json]
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWED = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Unlicense", "CC0-1.0", "0BSD"]);

export function classifyLicence(spdx) {
  if (typeof spdx !== "string" || !spdx.trim()) return false;
  const s = spdx.trim().replace(/^\((.*)\)$/, "$1");
  if (/\sAND\s/i.test(s)) return s.split(/\s+AND\s+/i).every((p) => ALLOWED.has(p.replace(/^\(|\)$/g, "").trim()));
  return s.split(/\s+OR\s+/i).some((a) => ALLOWED.has(a.replace(/^\(|\)$/g, "").trim()));
}

/** every installed package (name, version, licence), each real directory once */
export function inventory(root) {
  const seen = new Set();
  const out = [];
  const visitNodeModules = (nm) => {
    if (!existsSync(nm)) return;
    for (const e of readdirSync(nm)) {
      if (e === ".bin") continue;
      const p = path.join(nm, e);
      if (e === ".pnpm") {
        for (const s of readdirSync(p)) visitNodeModules(path.join(p, s, "node_modules"));
        continue;
      }
      if (e.startsWith("@")) {
        for (const s of readdirSync(p)) visitPackage(path.join(p, s));
        continue;
      }
      visitPackage(p);
    }
  };
  const visitPackage = (dir) => {
    let real;
    try {
      real = realpathSync(dir);
      if (!statSync(real).isDirectory()) return;
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    const pj = path.join(real, "package.json");
    if (existsSync(pj)) {
      const p = JSON.parse(readFileSync(pj, "utf8"));
      const licence = typeof p.license === "string" ? p.license : (p.license?.type ?? null);
      if (p.name) out.push({ name: p.name, version: p.version, licence });
    }
    visitNodeModules(path.join(real, "node_modules"));
  };
  visitNodeModules(path.join(root, "node_modules"));
  return out.sort((a, b) => (`${a.name}@${a.version}` < `${b.name}@${b.version}` ? -1 : 1));
}

export function judge(packages, allow) {
  const res = { firstParty: [], allowed: [], pending: [], denied: [] };
  const used = new Set();
  for (const p of packages) {
    if (p.name.startsWith("@regulait/")) {
      res.firstParty.push(p);
      continue;
    }
    if (classifyLicence(p.licence)) {
      res.allowed.push(p);
      continue;
    }
    const i = allow.findIndex((r) => r.subject === `${p.name}@${p.version}` && r.licence === p.licence);
    if (i < 0) {
      res.denied.push({ ...p, why: "not on the ADR-0176 list and no licence-allow.json row" });
      continue;
    }
    used.add(i);
    const d = allow[i].decision ?? "";
    if (/^accepted by owner/i.test(d)) res.allowed.push(p);
    else if (/owner to confirm|pending owner/i.test(d)) res.pending.push({ ...p, why: d });
    else res.denied.push({ ...p, why: "licence-allow.json row has no recognised decision" });
  }
  allow.forEach((r, i) => {
    if (!used.has(i)) res.denied.push({ name: r.subject, version: "", licence: r.licence, why: "a stale licence-allow.json row" });
  });
  return res;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [root, allowFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "licence-allow.json")] = process.argv.slice(2);
  if (!root) {
    console.error("usage: licence-gate.mjs <deployed dir> [licence-allow.json]");
    process.exit(2);
  }
  const res = judge(inventory(root), JSON.parse(readFileSync(allowFile, "utf8")));
  console.log(`licence gate: ${res.allowed.length} allowed, ${res.pending.length} pending an owner decision, ${res.denied.length} denied (${res.firstParty.length} first-party)`);
  for (const r of res.pending) console.log(`  pending  ${r.name}@${r.version} ${r.licence} (${r.why})`);
  for (const r of res.denied) console.log(`  DENIED   ${r.name}@${r.version} ${r.licence ?? "(no licence)"} (${r.why})`);
  process.exit(res.denied.length || res.allowed.length === 0 ? 1 : 0);
}
