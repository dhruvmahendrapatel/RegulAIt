#!/usr/bin/env node
// =============================================================================
// bom-vector-bundle.mjs — ADR-0189 slice B8: write one B4 verifier vector
// (packages/shared/test-vectors/decision-bom/b4-vectors.json) to disk as a real
// export-bundle/3 archive plus its TEST-ONLY trust root, so an auditor can prove
// an offline verification toolchain on a known answer BEFORE trusting it with a
// customer's bundle (docs/ops/BOM_VERIFICATION.md, step 2).
//
//   node scripts/bom-vector-bundle.mjs <vector id> <out dir>
//
// Writes:
//   <out dir>/<root>.tar.gz                the bundle (B4.1 USTAR via the product's writeBomTar, gzip MTIME 0)
//   <out dir>/trust/export-keyring/<keyId>.pub   when the vector pins export keys by keyring
//   <out dir>/trust/receipt-keyring.json   when the vector pins receipt keys by keyring
//                                          (the `GET /v1/receipts/keys` shape plus `receiptV2FromAuditSeq`)
// and prints the vector's expected outcome and the verify-bom.mjs trust arguments.
//
// Offline: no network, no database, no clock. Needs `pnpm -r build` (imports the
// built @regulait/shared). Refuses (exit 1) when the written tar is not the
// vector's pinned `tarSha256`, so it can never hand out a different bundle than
// the one the vector specifies. Vectors with a non-file entry (a symlink or a
// directory) are refused: writeBomTar writes regular files only.
//
// TEST-ONLY: every key in the vectors is a published CANARY key. Never configure one.
// Exit: 0 written. 1 refused. 2 usage error.
// =============================================================================
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VECTORS = path.join(root, "packages/shared/test-vectors/decision-bom/b4-vectors.json");

const [id, out, ...extra] = process.argv.slice(2);
if (!id || !out || extra.length) {
  process.stderr.write("Usage: node scripts/bom-vector-bundle.mjs <vector id> <out dir>\n");
  process.exit(2);
}
const fail = (m) => {
  process.stderr.write(`bom-vector-bundle: ${m}\n`);
  process.exit(1);
};

const shared = await import(path.join(root, "packages/shared/dist/index.js")).catch(() => {
  process.stderr.write("the built @regulait/shared is missing: run `pnpm -r build` first\n");
  process.exit(2);
});

const v = JSON.parse(readFileSync(VECTORS, "utf8"));
const all = [...v.positives, ...v.negatives];
const vec = all.find((x) => x.id === id);
if (!vec) fail(`no vector ${JSON.stringify(id)} (positives P01-P30, A01-A03; negatives as listed in the vectors README)`);

let entries;
if (vec.bundle.entries) entries = vec.bundle.entries;
else {
  const base = v.positives.find((x) => x.id === vec.bundle.base);
  if (!base) fail(`vector ${id} names a base ${vec.bundle.base} that is not a positive`);
  const replace = vec.bundle.replace ?? {};
  for (const name of Object.keys(replace)) if (!base.bundle.entries.some((e) => e.name === name)) fail(`vector ${id} replaces ${name}, which ${base.id} does not hold`);
  entries = base.bundle.entries.map((e) => (e.name in replace ? { ...e, text: replace[e.name] } : e));
}
if (entries.some((e) => e.type !== "file")) fail(`vector ${id} holds a non-file entry; this writer writes regular files only`);

const tar = shared.writeBomTar(entries.map((e) => ({ path: e.name, body: Buffer.from(e.text, "utf8") })));
const tarSha = createHash("sha256").update(tar).digest("hex");
if (tarSha !== vec.bundle.tarSha256 || tar.length !== vec.bundle.tarBytes) fail(`the written tar (${tarSha}, ${tar.length} bytes) is not vector ${id}'s pinned tar; refusing`);

const rootDir = entries[0].name.split("/")[0];
mkdirSync(out, { recursive: true });
const archive = path.join(out, `${rootDir}.tar.gz`);
writeFileSync(archive, gzipSync(tar, { level: 9 }));

const trustArgs = [];
const t = vec.trust;
if (t.export.keyring) {
  const dir = path.join(out, "trust", "export-keyring");
  mkdirSync(dir, { recursive: true });
  for (const k of t.export.keyring) writeFileSync(path.join(dir, `${k.keyId}.pub`), k.publicKeyPem);
  trustArgs.push("--keyring", dir);
}
for (const f of t.export.pinnedFingerprints ?? []) trustArgs.push("--fingerprint", f);
if (t.receipt.keyring) {
  const file = path.join(out, "trust", "receipt-keyring.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(t.receipt.keyring, null, 2)}\n`);
  trustArgs.push("--receipt-keyring", file);
}
for (const f of t.receipt.pinnedFingerprints ?? []) trustArgs.push("--receipt-fingerprint", f);
if (!t.receipt.keyring) trustArgs.push("--receipt-v2-from", t.receipt.receiptV2FromAuditSeq === null ? "none" : String(t.receipt.receiptV2FromAuditSeq));
trustArgs.push("--now", t.verificationTime ?? v.verificationTime);

process.stdout.write(`vector ${vec.id} (${vec.polarity}, ${vec.subject}): ${vec.title}\n`);
process.stdout.write(`wrote ${archive}\n`);
process.stdout.write(`tar sha256 ${tarSha} (${tar.length} bytes), as pinned by the vector\n`);
process.stdout.write(`expected outcome: ${vec.expect.outcome}\n`);
process.stdout.write(`verify-bom.mjs trust arguments: ${trustArgs.join(" ")}\n`);
process.stdout.write("TEST-ONLY: every key in this bundle is a published CANARY test key; never configure it.\n");
