#!/usr/bin/env node
// =============================================================================
// validate-bom-rendering.mjs — ADR-0189 slice B8: validate a CycloneDX or SPDX
// rendering taken out of an AI BOM bundle against the OFFICIAL schema bundled
// with the product (§6: "validated against the official schemas, offline,
// bundled"), on an auditor's machine. No network: the schemas are the pinned
// copies @regulait/shared already compiles with Ajv for every snapshot
// (CycloneDX 1.7 / 1.6 from @cyclonedx/cyclonedx-library, SPDX 3.0.1 vendored
// and sha256-pinned), with the reject-all `idn-email` format.
//
//   node scripts/validate-bom-rendering.mjs --format cyclonedx-1.7|cyclonedx-1.6|spdx-3.0.1 <file> [...]
//
// The format is stated, never guessed. This checks the schema only. It does NOT
// prove the file is the one the signed body commits to: that is
// `scripts/verify-bom.mjs`'s `rendering_hashes` check, run on the whole bundle.
// SPDX SHACL conformance (stronger than the schema) is `scripts/spdx3/run_offline.py`.
//
// Needs `pnpm -r build` (imports the built @regulait/shared).
// Exit: 0 every file valid. 1 a file is invalid or unreadable. 2 usage error.
// =============================================================================
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORMATS = ["cyclonedx-1.7", "cyclonedx-1.6", "spdx-3.0.1"];
const usage = () => {
  process.stderr.write(`Usage: node scripts/validate-bom-rendering.mjs --format ${FORMATS.join("|")} <file> [...]\n`);
  process.exit(2);
};

const args = process.argv.slice(2);
let format = null;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--format") {
    if (format !== null) usage();
    format = args[++i] ?? usage();
  } else if (args[i].startsWith("-")) usage();
  else files.push(args[i]);
}
if (!FORMATS.includes(format) || !files.length) usage();

const shared = await import(path.join(root, "packages/shared/dist/index.js")).catch(() => {
  process.stderr.write("the built @regulait/shared is missing: run `pnpm -r build` first\n");
  process.exit(2);
});

let failed = false;
for (const f of files) {
  let doc;
  try {
    // B8 review L7: never read more than a whole BOM archive may hold (the product's own cap)
    const st = statSync(f);
    if (!st.isFile() || st.size > shared.BOM_ARCHIVE_MAX_TAR_BYTES) {
      process.stdout.write(`[invalid] ${f}: not a regular file of at most ${shared.BOM_ARCHIVE_MAX_TAR_BYTES} bytes\n`);
      failed = true;
      continue;
    }
    doc = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    // value-free: never echo a file's content
    process.stdout.write(`[invalid] ${f}: not readable JSON\n`);
    failed = true;
    continue;
  }
  const spec = format.slice("cyclonedx-".length);
  // the bundled CycloneDX schemas do not pin `specVersion` to their own version, so a 1.7 document passes the 1.6
  // schema; the stated format must match what the document says it is
  if (format !== "spdx-3.0.1" && (doc?.bomFormat !== "CycloneDX" || doc?.specVersion !== spec)) {
    process.stdout.write(`[invalid] ${f}: not a CycloneDX ${spec} document (bomFormat and specVersion)\n`);
    failed = true;
    continue;
  }
  const r = format === "spdx-3.0.1" ? shared.validateSpdx(doc) : shared.validateCycloneDx(doc, spec);
  if (r.valid) process.stdout.write(`[valid] ${f}: ${format} schema\n`);
  else {
    failed = true;
    process.stdout.write(`[invalid] ${f}: ${format} schema, ${r.errors.length} error(s)\n`);
    for (const e of r.errors.slice(0, 20)) process.stdout.write(`    ${e.path || "/"}: ${e.message}\n`);
  }
}
process.exit(failed ? 1 : 0);
