#!/usr/bin/env node
/**
 * ADR-0187 B5-G / ADR-0176 — the licence gate for the garak image's Python closure (decision 157): the
 * modelscan image's gate (engines/modelscan/licence-gate.mjs, decision 106) with two additions, run offline
 * on the INSTALLED site-packages (after `pip install --require-hashes`), so it judges exactly what ships:
 *
 *   - every installed distribution, by its METADATA licence (License-Expression, else a License field
 *     that is an SPDX id, else a License classifier that names one licence);
 *   - every native library bundled inside a wheel (`<package>.libs/*.so*`), by a fixed table of what
 *     each library is (a library not in the table is denied);
 *   - the Python runtime itself (PSF-2.0), named on the command line;
 *   - ADDITION 1, READINGS: a distribution whose METADATA names no SPDX licence (or one the parser cannot
 *     split) is judged by `licence-readings.json`: the licence a person READ in the licence file the wheel
 *     ships, pinned to that exact version AND that file's sha256. A reading for another version, or whose
 *     file is missing or has changed, is not used (the distribution is then judged by its metadata, and a
 *     reading that matched nothing fails the build as stale), so a reading can never outlive what it read;
 *   - ADDITION 2: the native libraries pillow's wheel bundles (`pillow.libs`), each by the licence pillow's
 *     own LICENSE file gives it;
 *   - ADDITION 3, CONDITIONS (ADR-0187 decision 194): an allow entry may carry `"condition": "unmodified"`,
 *     and an MPL-2.0 entry MUST (the owner admitted MPL-2.0 only while its files are unmodified, open
 *     question 21). Such a row is admitted only when every file the distribution's RECORD lists with a hash
 *     is present and matches that hash (the hashes pip wrote from the hash-pinned wheel); a missing or
 *     changed file DENIES the row, so a patched MPL file can never ship under the admission.
 *
 * Each licence term is ALLOWED when it is on the ADR-0176 list (MIT, Apache-2.0, BSD-2-Clause,
 * BSD-3-Clause, ISC, Unlicense, CC0-1.0, 0BSD); otherwise it is admitted only when
 * `licence-allow.json` names that subject and that licence (and its condition, if any, holds), and EVERY entry of that file says either
 * exactly "pending owner decision" or a recorded owner acceptance, "accepted by owner <YYYY-MM-DD>
 * (ADR-NNNN decision N)" (ADR-0187 decision 106, owner 2026-10-09): nothing outside the list is
 * admitted silently, and the allow file cannot carry a decision in any other form. Anything else is
 * DENIED and the build fails; so is an allow entry that matches nothing (a stale admission).
 *
 * Usage: node licence-gate.mjs <site-packages> <licence-allow.json> [--readings licence-readings.json] [--runtime python=PSF-2.0]
 * Exit 1 on any denied term, an invalid allow file or a stale entry.
 */
import { createHash } from "node:crypto";
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
/** the only condition an allow entry may carry, and the licences that must carry it */
export const CONDITIONS = new Set(["unmodified"]);
export const REQUIRED_CONDITION = { "MPL-2.0": "unmodified" };

/**
 * what is wrong with a distribution's installed files against its RECORD (null when every hashed file is
 * present and matches). RECORD rows are `path,sha256=<urlsafe base64, no padding>,size`; a row with no
 * hash (RECORD itself, files pip could not hash) is not checked.
 */
export function recordProblem(sitePackages, distInfo) {
  if (typeof distInfo !== "string" || !distInfo) return "no dist-info to check";
  const record = path.join(sitePackages, distInfo, "RECORD");
  if (!existsSync(record)) return `${distInfo} has no RECORD`;
  let checked = 0;
  for (const line of readFileSync(record, "utf8").split("\n")) {
    if (!line.trim()) continue;
    // the path may itself be quoted CSV; the hash and size are the last two fields
    const parts = line.split(",");
    const size = parts.pop();
    const hash = parts.pop();
    const rel = parts.join(",").replace(/^"(.*)"$/, "$1");
    if (!hash) continue;
    const m = /^sha256=([A-Za-z0-9_-]+)$/.exec(hash);
    if (!m) return `${rel}: RECORD hash is not sha256`;
    // RECORD paths are relative to site-packages; console scripts live in the venv's bin (`../../../bin`)
    const file = path.resolve(sitePackages, rel);
    const within = path.relative(path.resolve(sitePackages, "../../.."), file);
    if (!within || within.startsWith("..") || path.isAbsolute(within)) return `${rel}: RECORD path escapes the environment`;
    if (!existsSync(file)) return `${rel} is missing`;
    const got = createHash("sha256").update(readFileSync(file)).digest("base64url");
    if (got !== m[1]) return `${rel} is modified (its hash is not the wheel's)`;
    if (size && Number(size) !== statSync(file).size) return `${rel} is modified (its size is not the wheel's)`;
    checked++;
  }
  return checked > 0 ? null : `${distInfo} RECORD lists no hashed file`;
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
  // pillow.libs: each by its section of pillow's dist-info/licenses/LICENSE (pillow 12.3.0)
  libXau: "MIT", // libxcb's companion (X.Org MIT)
  libxcb: "MIT", // X.Org MIT
  libavif: "BSD-2-Clause", // LIBAVIF section
  libbrotlicommon: "MIT", // BROTLI section
  libbrotlidec: "MIT",
  libfreetype: "FTL", // FREETYPE2 section: dual FTL or GPL-2.0; the FTL is the one taken
  libharfbuzz: "MIT-Modern-Variant", // HARFBUZZ section ("Old MIT" style)
  libjpeg: "IJG AND BSD-3-Clause AND Zlib", // LIBJPEG section (libjpeg-turbo)
  liblcms2: "MIT", // LCMS2 section
  liblzma: "0BSD", // LIBLZMA section (XZ Utils: liblzma under 0BSD)
  libopenjp2: "BSD-2-Clause", // OPENJPEG section
  libpng16: "libpng-2.0", // LIBPNG section (PNG Reference Library License version 2)
  libsharpyuv: "BSD-3-Clause", // LIBWEBP section (sharpyuv ships with libwebp)
  libtiff: "libtiff", // LIBTIFF section
  libwebp: "BSD-3-Clause", // LIBWEBP section
  libwebpdemux: "BSD-3-Clause",
  libwebpmux: "BSD-3-Clause",
  libzstd: "BSD-3-Clause", // dual BSD-3-Clause or GPL-2.0; the BSD is the one taken
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
    // the field names are fixed constants; escaped anyway so no character of one is read as a pattern
    const m = new RegExp(`^${name.replace(/[\\^$.*+?()[\]{}|-]/g, "\\$&")}:\\s*(.+)$`, "m").exec(text);
    return m ? m[1].trim() : null;
  };
  const expr = field("License-Expression");
  if (expr) return expr;
  const lic = field("License");
  if (lic && (ALLOWED.has(lic) || /^[A-Za-z0-9.+-]+$/.test(lic))) return lic;
  const named = [...text.matchAll(/^Classifier:\s*(License :: .+)$/gm)].map((m) => CLASSIFIERS[m[1].trim()]).filter((x) => x);
  return named.length === 1 ? named[0] : null;
}

/** a reading applies only to that exact version and that exact licence file (by sha256) */
export function readingFor(readings, sitePackages, distInfo, name, version) {
  for (const r of readings ?? []) {
    if (r.subject !== name || r.version !== version || typeof r.file !== "string" || r.file.includes("..")) continue;
    const file = path.join(sitePackages, distInfo, r.file);
    if (!existsSync(file)) continue;
    if (createHash("sha256").update(readFileSync(file)).digest("hex") === r.sha256) return r;
  }
  return null;
}

/** check the readings file's own shape */
export function readingProblems(readings) {
  if (!Array.isArray(readings)) return ["the readings file is not a list"];
  const out = [];
  readings.forEach((r, i) => {
    if (!r || typeof r !== "object") return out.push(`reading ${i} is not an object`);
    for (const k of ["subject", "version", "file", "sha256", "licence", "read"]) if (typeof r[k] !== "string" || !r[k].trim()) out.push(`reading ${i} needs ${k}`);
    if (typeof r.sha256 === "string" && !/^[0-9a-f]{64}$/.test(r.sha256)) out.push(`reading ${i} (${r.subject}) sha256 is not a sha256`);
    if (licenceTerms(r.licence) === null) out.push(`reading ${i} (${r.subject}) licence must be a flat SPDX expression`);
  });
  return out;
}

/** the inventory: one row per (subject, licence term) */
export function inventory(sitePackages, runtime = [], readings = []) {
  const rows = [];
  const usedReadings = new Set();
  for (const d of readdirSync(sitePackages).sort()) {
    const full = path.join(sitePackages, d);
    if (d.endsWith(".dist-info") && existsSync(path.join(full, "METADATA"))) {
      const text = readFileSync(path.join(full, "METADATA"), "utf8");
      const name = /^Name:\s*(.+)$/m.exec(text)?.[1].trim().toLowerCase() ?? d;
      const version = /^Version:\s*(.+)$/m.exec(text)?.[1].trim() ?? "?";
      const metaLic = metadataLicence(text);
      // a reading is consulted only when the metadata alone does not pass on the list (no licence, a
      // non-SPDX name such as "Apache" or "BSD", or an expression the parser cannot split); it can make a
      // judgement possible, never overturn metadata that already passes
      const metaTerms = licenceTerms(metaLic);
      const metaPasses = metaTerms !== null && metaTerms.every((t) => ALLOWED.has(t));
      const reading = metaPasses ? null : readingFor(readings, sitePackages, d, name, version);
      if (reading) usedReadings.add(reading);
      const lic = reading ? reading.licence : metaLic;
      const terms = licenceTerms(lic);
      if (!terms) rows.push({ subject: name, version, licence: lic ?? "(none)", term: null, distInfo: d });
      else for (const t of terms) rows.push({ subject: name, version, licence: lic, term: t, distInfo: d });
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
  rows.staleReadings = (readings ?? []).filter((r) => !usedReadings.has(r));
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
    if (e.condition !== undefined && !CONDITIONS.has(e.condition)) out.push(`entry ${i} (${e.subject}) has an unknown condition "${e.condition}"`);
    const need = Object.prototype.hasOwnProperty.call(REQUIRED_CONDITION, e.licence) ? REQUIRED_CONDITION[e.licence] : null;
    if (need && e.condition !== need) out.push(`entry ${i} (${e.subject}) ${e.licence} is admitted only with condition "${need}"`);
  });
  return out;
}

/**
 * judge the inventory against the allow-list and the allow file. `conditionProblem(row, entry)` checks an
 * entry's condition (the CLI passes the RECORD check); with none given, a conditional entry admits nothing.
 */
export function judge(rows, allow, conditionProblem = () => "the condition was not checked") {
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
      const why = allow[i].condition !== undefined ? conditionProblem(r, allow[i]) : null;
      if (why) denied.push({ ...r, why: `condition "${allow[i].condition}" not met: ${why}` });
      else pending.push(r);
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
  let readingsFile = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--runtime") runtime.push(rest[++i]);
    else if (rest[i] === "--readings") readingsFile = rest[++i];
  }
  const allow = JSON.parse(readFileSync(allowFile, "utf8"));
  const readings = readingsFile ? JSON.parse(readFileSync(readingsFile, "utf8")) : [];
  const problems = [...allowProblems(allow), ...readingProblems(readings)];
  const rows = inventory(site, runtime, readings);
  const res = judge(rows, allow, (r, e) => (e.condition === "unmodified" ? recordProblem(site, r.distInfo) : `unknown condition ${e.condition}`));
  for (const r of rows.staleReadings) problems.push(`reading ${r.subject} ${r.version} (${r.file}) matches nothing installed`);
  console.log(`licence gate: ${res.allowed.length} allowed, ${res.pending.length} admitted by the allow file, ${res.denied.length} denied`);
  const decisionOf = (r) => allow.find((e) => e.subject === r.subject && e.licence === r.term)?.decision ?? "?";
  for (const r of res.pending) console.log(`  admitted ${r.subject} ${r.version} ${r.term}: ${decisionOf(r)}`);
  for (const r of res.denied) console.log(`  DENIED   ${r.subject} ${r.version} ${r.licence}${r.why ? ` (${r.why})` : ""}`);
  for (const e of res.stale) console.log(`  STALE    allow entry ${e.subject} ${e.licence} matches nothing installed`);
  for (const p of problems) console.log(`  INVALID  ${p}`);
  process.exit(res.denied.length || res.stale.length || problems.length ? 1 : 0);
}
