#!/usr/bin/env node
// ADR-0189 §B4.6: write the worked export-bundle/3 example (TEST-ONLY CANARY keys)
// to a directory, for anyone writing verifier vectors from the specification.
// Offline: run `pnpm -r build` first. No network, no database, no clock.
//
//   node scripts/bom-b4-spec-example.mjs <out-dir>
//
// Writes <out-dir>/<root>/<file> for every bundle file, <out-dir>/<root>.tar
// (uncompressed USTAR, pinned in the ADR) and <out-dir>/<root>.tar.gz (the
// served form; its compressed bytes are not pinned, §B4.1).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUNDLE_ROOT, buildB4SpecExample } from "../apps/gateway/dist/testing/bom-b4-spec-example.js";

const out = process.argv[2];
if (!out || process.argv.length !== 3) {
  process.stderr.write("Usage: node scripts/bom-b4-spec-example.mjs <out-dir>\n");
  process.exit(2);
}
const ex = buildB4SpecExample();
for (const [file, bytes] of ex.files) {
  const target = path.join(out, BUNDLE_ROOT, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}
writeFileSync(path.join(out, `${BUNDLE_ROOT}.tar`), ex.tar);
writeFileSync(path.join(out, `${BUNDLE_ROOT}.tar.gz`), ex.archive);
process.stdout.write(`wrote ${ex.files.size} files, ${BUNDLE_ROOT}.tar and ${BUNDLE_ROOT}.tar.gz under ${out}\n`);
process.stdout.write("TEST-ONLY: every key in this bundle is a published CANARY test key; never configure it.\n");
