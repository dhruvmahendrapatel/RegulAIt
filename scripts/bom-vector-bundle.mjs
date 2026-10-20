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
// the one the vector specifies. Refused too, rather than approximated: vectors
// with a non-file entry (a symlink or a directory; writeBomTar writes regular
// files only), online vectors (`trust.mode` not "offline", or trusting the
// deployment's own export key), an export keyring entry whose `fingerprint` is not
// its key's, an export keyring naming one key id twice (N-M04), and a trust
// root that states no receipt v2 boundary.
//
// TEST-ONLY: every key in the vectors is a published CANARY key. Never configure one.
// Exit: 0 written. 1 refused. 2 usage error.
// =============================================================================
import { createHash, createPublicKey } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
// --vectors FILE: another file in the b4-vectors.json shape (this script's own tests use it to reach refusals no
// published vector reaches); the default is the published vectors
let VECTORS = path.join(root, "packages/shared/test-vectors/decision-bom/b4-vectors.json");
if (argv[0] === "--vectors") {
  VECTORS = argv[1];
  argv.splice(0, 2);
}
const [id, out, ...extra] = argv;
if (!id || !out || extra.length || !VECTORS) {
  process.stderr.write("Usage: node scripts/bom-vector-bundle.mjs [--vectors FILE] <vector id> <out dir>\n");
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

// B8 review M1: write only a trust root the offline script can express exactly. An online vector (the route's
// keyring-plus-own-key trust, P20, P21, N-M02, N-M05), or an export keyring entry whose `fingerprint` is not its key's
// (a load-time refusal online, which a `--keyring` directory cannot carry) is refused, never silently approximated.
const t = vec.trust;
if (t.mode !== "offline") fail(`vector ${id} is a ${t.mode} vector (the online route's trust root); this writer writes offline trust roots only`);
if (t.export.ownKey) fail(`vector ${id} trusts the deployment's own export key (online only); refusing`);
const spkiFingerprint = (pem) => `sha256:${createHash("sha256").update(createPublicKey(pem).export({ type: "spki", format: "der" })).digest("hex")}`;
// B8 recheck L2: a `--keyring` directory holds one `<keyId>.pub` per id, so a trust root naming an id twice (N-M04)
// cannot be written without one key overwriting the other
const exportIds = (t.export.keyring ?? []).map((k) => k.keyId);
if (new Set(exportIds).size !== exportIds.length) fail(`vector ${id}: the export keyring names a key id twice, which a --keyring directory cannot hold; refusing`);
for (const k of t.export.keyring ?? []) {
  if (k.fingerprint !== undefined && k.fingerprint !== spkiFingerprint(k.publicKeyPem)) fail(`vector ${id}: export keyring entry ${k.keyId} names a fingerprint that is not its key's; refusing`);
}

const boundaryOf = t.receipt.keyring ? t.receipt.keyring : t.receipt;
if (!Object.hasOwn(boundaryOf, "receiptV2FromAuditSeq")) fail(`vector ${id} states no receipt v2 boundary; refusing (an absent boundary is never read as none)`);

const tar = shared.writeBomTar(entries.map((e) => ({ path: e.name, body: Buffer.from(e.text, "utf8") })));
const tarSha = createHash("sha256").update(tar).digest("hex");
if (tarSha !== vec.bundle.tarSha256 || tar.length !== vec.bundle.tarBytes) fail(`the written tar (${tarSha}, ${tar.length} bytes) is not vector ${id}'s pinned tar; refusing`);

const rootDir = entries[0].name.split("/")[0];
mkdirSync(out, { recursive: true });
const archive = path.join(out, `${rootDir}.tar.gz`);
writeFileSync(archive, gzipSync(tar, { level: 9 }));

const trustArgs = [];
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
