#!/usr/bin/env node
/**
 * ADR-0187 B5-M / ADR-0176 — the licence gate for the modelscan image's Python closure, run offline on
 * the INSTALLED site-packages (after `pip install --require-hashes`), so it judges exactly what ships:
 *
 *   - every installed distribution, by its METADATA licence (License-Expression, else a License field
 *     that is an SPDX id, else a License classifier that names one licence);
 *   - every native library bundled inside a wheel (`<package>.libs/*.so*`), by a fixed table of what
 *     each library is (a library not in the table is denied);
 *   - the Python runtime itself (PSF-2.0), named on the command line.
 *
 * Each licence term is ALLOWED when it is on the ADR-0176 list (MIT, Apache-2.0, BSD-2-Clause,
 * BSD-3-Clause, ISC, Unlicense, CC0-1.0, 0BSD); otherwise it is admitted only when
 * `licence-allow.json` names that subject and that licence, and EVERY entry of that file says either
 * exactly "pending owner decision" or a recorded owner acceptance, "accepted by owner <YYYY-MM-DD>
 * (ADR-NNNN decision N)" (ADR-0187 decision 106, owner 2026-10-09): nothing outside the list is
 * admitted silently, and the allow file cannot carry a decision in any other form. Anything else is
 * DENIED and the build fails; so is an allow entry that matches nothing (a stale admission).
 *
 * Usage: node licence-gate.mjs <site-packages> <licence-allow.json> [--runtime python=PSF-2.0]
 * Exit 1 on any denied term, an invalid allow file or a stale entry.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const ALLOWED = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Unlicense", "CC0-1.0", "0BSD"]);
export const PENDING_TEXT = "pending owner decision";
/** a recorded owner acceptance names its date and the ADR decision that records it */
export const ACCEPTED_TEXT = /^accepted by owner \d{4}-\d{2}-\d{2} \(ADR-\d{4} decision \d+\)$/;
/** the only two forms an allow-file decision may take */
export function decisionValid(d) {
  return d === PENDING_TEXT || (typeof d === "string" && ACCEPTED_TEXT.test(d));
}

/** what each bundled native library is (by the name before its first hyphen), verified from the wheels' licence files */
export const NATIVE_LIBRARIES = {
  libscipy_openblas64_: "BSD-3-Clause", // OpenBLAS (numpy.libs; numpy LICENSE.txt)
  libgfortran: "GPL-3.0-or-later WITH GCC-exception-3.1", // GCC runtime (numpy.libs)
  libquadmath: "LGPL-2.1-or-later", // GCC quad-precision runtime (numpy.libs)
  libhdf5: "LicenseRef-HDF5", // HDF5, BSD-style but its own text (h5py.libs; licenses/hdf5.txt)
  libhdf5_hl: "LicenseRef-HDF5",
  libaec: "BSD-2-Clause", // h5py.libs
  libsz: "BSD-2-Clause", // libaec's szip compatibility library (h5py.libs)
};

/** the License classifiers that name exactly one SPDX licence */
const CLASSIFIERS = {
  "License :: OSI Approved :: MIT License": "MIT",
  "License :: OSI Approved :: Apache Software License": "Apache-2.0",
  "License :: OSI Approved :: BSD License": null, // ambiguous: not enough on its own
  "License :: OSI Approved :: ISC License (ISCL)": "ISC",
};

/** split an SPDX expression into its terms ("A WITH B" stays one term); null when it uses parentheses we do not parse */
export function licenceTerms(expr) {
  if (typeof expr !== "string" || !expr.trim()) return null;
  const flat = expr.trim().replace(/^\((.*)\)$/, "$1");
  if (/[()]/.test(flat)) return null;
  return flat.split(/\s+(?:AND|OR)\s+/).map((t) => t.trim());
}

function metadataLicence(text) {
  const field = (name) => {
    const m = new RegExp(`^${name}:\\s*(.+)$`, "m").exec(text);
    return m ? m[1].trim() : null;
  };
  const expr = field("License-Expression");
  if (expr) return expr;
  const lic = field("License");
  if (lic && (ALLOWED.has(lic) || /^[A-Za-z0-9.+-]+$/.test(lic))) return lic;
  const named = [...text.matchAll(/^Classifier:\s*(License :: .+)$/gm)].map((m) => CLASSIFIERS[m[1].trim()]).filter((x) => x);
  return named.length === 1 ? named[0] : null;
}

/** the inventory: one row per (subject, licence term) */
export function inventory(sitePackages, runtime = []) {
  const rows = [];
  for (const d of readdirSync(sitePackages).sort()) {
    const full = path.join(sitePackages, d);
    if (d.endsWith(".dist-info") && existsSync(path.join(full, "METADATA"))) {
      const text = readFileSync(path.join(full, "METADATA"), "utf8");
      const name = /^Name:\s*(.+)$/m.exec(text)?.[1].trim().toLowerCase() ?? d;
      const version = /^Version:\s*(.+)$/m.exec(text)?.[1].trim() ?? "?";
      const lic = metadataLicence(text);
      const terms = licenceTerms(lic);
      if (!terms) rows.push({ subject: name, version, licence: lic ?? "(none)", term: null });
      else for (const t of terms) rows.push({ subject: name, version, licence: lic, term: t });
    } else if (d.endsWith(".libs") && statSync(full).isDirectory()) {
      for (const lib of readdirSync(full).sort()) {
        if (!/\.so(\.|$)/.test(lib)) continue;
        const base = lib.split("-")[0];
        const lic = Object.prototype.hasOwnProperty.call(NATIVE_LIBRARIES, base) ? NATIVE_LIBRARIES[base] : null;
        rows.push({ subject: `${d}/${base}`, version: lib, licence: lic ?? "(unknown native library)", term: lic });
      }
    }
  }
  for (const r of runtime) {
    const [subject, lic] = r.split("=");
    rows.push({ subject, version: "runtime", licence: lic, term: lic });
  }
  return rows;
}

/** check the allow file's own shape: every entry pending, nothing else */
export function allowProblems(allow) {
  const out = [];
  if (!Array.isArray(allow)) return ["the allow file is not a list"];
  allow.forEach((e, i) => {
    if (!e || typeof e !== "object") return out.push(`entry ${i} is not an object`);
    if (typeof e.subject !== "string" || typeof e.licence !== "string") out.push(`entry ${i} needs subject and licence`);
    if (!decisionValid(e.decision)) out.push(`entry ${i} (${e.subject}) must say decision "${PENDING_TEXT}" or "accepted by owner <date> (ADR-NNNN decision N)"`);
    if (typeof e.why !== "string" || !e.why.trim()) out.push(`entry ${i} (${e.subject}) must say why it is needed`);
  });
  return out;
}

/** judge the inventory against the allow-list and the allow file */
export function judge(rows, allow) {
  const used = new Set();
  const allowed = [];
  const pending = [];
  const denied = [];
  for (const r of rows) {
    if (r.term !== null && ALLOWED.has(r.term)) {
      allowed.push(r);
      continue;
    }
    const i = Array.isArray(allow) ? allow.findIndex((e) => e.subject === r.subject && e.licence === r.term && decisionValid(e.decision)) : -1;
    if (r.term !== null && i >= 0) {
      used.add(i);
      pending.push(r);
    } else denied.push(r);
  }
  const stale = Array.isArray(allow) ? allow.filter((_, i) => !used.has(i)) : [];
  return { allowed, pending, denied, stale };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [site, allowFile, ...rest] = process.argv.slice(2);
  if (!site || !allowFile) {
    console.error("usage: licence-gate.mjs <site-packages> <licence-allow.json> [--runtime name=SPDX ...]");
    process.exit(2);
  }
  const runtime = [];
  for (let i = 0; i < rest.length; i++) if (rest[i] === "--runtime") runtime.push(rest[++i]);
  const allow = JSON.parse(readFileSync(allowFile, "utf8"));
  const problems = allowProblems(allow);
  const res = judge(inventory(site, runtime), allow);
  console.log(`licence gate: ${res.allowed.length} allowed, ${res.pending.length} admitted by the allow file, ${res.denied.length} denied`);
  const decisionOf = (r) => allow.find((e) => e.subject === r.subject && e.licence === r.term)?.decision ?? "?";
  for (const r of res.pending) console.log(`  admitted ${r.subject} ${r.version} ${r.term}: ${decisionOf(r)}`);
  for (const r of res.denied) console.log(`  DENIED   ${r.subject} ${r.version} ${r.licence}`);
  for (const e of res.stale) console.log(`  STALE    allow entry ${e.subject} ${e.licence} matches nothing installed`);
  for (const p of problems) console.log(`  INVALID  ${p}`);
  process.exit(res.denied.length || res.stale.length || problems.length ? 1 : 0);
}
