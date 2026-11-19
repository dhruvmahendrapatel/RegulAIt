#!/usr/bin/env node
/**
 * ADR-0364 S3 / ADR-0176 — the licence gate for the robot egress image's ONE binary (stripe/smokescreen), run inside
 * the image build on exactly what was linked: the module list `go version -m` reads out of the built binary.
 *
 * Every module the binary links (and smokescreen itself) is judged by a READING (licence-readings.json): the licence a
 * person read in the module's licence file, pinned to that exact module version AND that file's sha256 in the module
 * cache (a module the Go toolchain verified against go.sum and the checksum database). A module with no reading, a
 * reading whose file is missing or changed, or a reading that matched nothing (stale) fails the build. A `replace`
 * directive in the binary fails it too (the build must be the published module, unmodified).
 *
 * A licence is ALLOWED when it is on the ADR-0176 list (MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, Unlicense,
 * CC0-1.0, 0BSD; an `A AND B` reading needs every part). Anything else needs a row in licence-allow.json naming the
 * module, the licence, and a decision:
 *   - "accepted by owner …"                         admitted;
 *   - "… owner to confirm …" / "pending owner …"     admitted for the build, reported as PENDING: the image is not
 *                                                    admissible until the owner records the decision (the
 *                                                    promptfoo / spikee gates' pending form);
 * and an MPL-2.0 row MUST carry `"condition": "unmodified"` (ADR-0187 decision 194: MPL-2.0 only while its files are
 * unmodified), which holds here because the Dockerfile runs `go mod verify` on the build's module cache first.
 * Everything else is DENIED and fails the build.
 *
 * Usage: node licence-gate.mjs <go-version-m.txt> <GOMODCACHE> <smokescreen source dir>
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWED = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Unlicense", "CC0-1.0", "0BSD"]);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** the module cache's directory name for a module path (Go's case-encoding: an upper-case letter is `!` + lower) */
export const escapeModulePath = (m) => m.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);

/** `go version -m` output → { main, deps: [{module, version}] }; a replace (`=>`) is refused */
export function parseBuildInfo(text) {
  let main = null;
  const deps = [];
  for (const raw of text.split("\n")) {
    const p = raw.trim().split(/\s+/);
    if (p[0] === "=>") throw new Error(`the binary was built with a replace directive (${raw.trim()})`);
    if (p[0] === "mod") main = p[1];
    if (p[0] === "dep") deps.push({ module: p[1], version: p[2] });
  }
  if (!main) throw new Error("no main module in the build info");
  return { main, deps };
}

export function classify(licence, module, allow) {
  const parts = licence.split(/\s+AND\s+/);
  if (parts.every((x) => ALLOWED.has(x))) return { verdict: "allowed" };
  const row = allow.find((r) => r.subject === module && r.licence === licence);
  if (!row) return { verdict: "denied", why: `${licence} is not on the ADR-0176 list and has no licence-allow.json row` };
  if (/MPL-2\.0/.test(licence) && row.condition !== "unmodified") return { verdict: "denied", why: "an MPL-2.0 row must carry condition: unmodified" };
  if (/^accepted by owner/i.test(row.decision ?? "")) return { verdict: "allowed", why: row.decision };
  if (/owner to confirm|pending owner/i.test(row.decision ?? "")) return { verdict: "pending", why: row.decision };
  return { verdict: "denied", why: `licence-allow.json row for ${module} has no recognised decision` };
}

/** judge the binary's modules; returns {allowed, pending, denied} rows */
export function judge({ buildInfo, modcache, srcDir, readings, allow, read = (f) => (existsSync(f) ? readFileSync(f) : null) }) {
  const out = { allowed: [], pending: [], denied: [] };
  const used = new Set();
  const subjects = [{ module: buildInfo.main, version: "(main)", dir: srcDir }, ...buildInfo.deps.map((d) => ({ ...d, dir: path.join(modcache, `${escapeModulePath(d.module)}@${d.version}`) }))];
  for (const s of subjects) {
    const idx = readings.findIndex((r) => r.module === s.module && r.version === s.version);
    if (idx < 0) {
      out.denied.push({ ...s, why: "no licence reading for this exact version" });
      continue;
    }
    const r = readings[idx];
    used.add(idx);
    const bytes = read(path.join(s.dir, r.file));
    const sha = bytes ? createHash("sha256").update(bytes).digest("hex") : null;
    if (sha !== r.sha256) {
      out.denied.push({ ...s, why: `the reading's file ${r.file} is ${bytes ? "changed" : "missing"}` });
      continue;
    }
    const c = classify(r.licence, s.module, allow);
    out[c.verdict].push({ ...s, licence: r.licence, why: c.why });
  }
  readings.forEach((r, i) => {
    if (!used.has(i)) out.denied.push({ module: r.module, version: r.version, why: "a stale reading (the binary does not link this module version)" });
  });
  return out;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [info, modcache, srcDir] = process.argv.slice(2);
  if (!info || !modcache || !srcDir) {
    console.error("usage: licence-gate.mjs <go-version-m.txt> <GOMODCACHE> <smokescreen source dir>");
    process.exit(2);
  }
  const res = judge({
    buildInfo: parseBuildInfo(readFileSync(info, "utf8")),
    modcache,
    srcDir,
    readings: JSON.parse(readFileSync(path.join(HERE, "licence-readings.json"), "utf8")),
    allow: JSON.parse(readFileSync(path.join(HERE, "licence-allow.json"), "utf8")),
  });
  console.log(`licence gate: ${res.allowed.length} allowed, ${res.pending.length} pending an owner decision, ${res.denied.length} denied`);
  for (const r of res.pending) console.log(`  pending  ${r.module}@${r.version} ${r.licence} (${r.why})`);
  for (const r of res.denied) console.log(`  DENIED   ${r.module}@${r.version} ${r.why}`);
  process.exit(res.denied.length ? 1 : 0);
}
