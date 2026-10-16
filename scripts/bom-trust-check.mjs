#!/usr/bin/env node
// =============================================================================
// bom-trust-check.mjs — ADR-0189 slice B8 (review M2, L1): check the keys an
// operator hands an auditor against the auditor's TRUST RECORD, by exact string
// comparison, never by eye (docs/ops/BOM_VERIFICATION.md, step 3).
//
// The trust record is written ONCE, out of band, at key generation or at the
// first engagement (for example from a signed engagement letter), and kept with
// the auditor's working papers. Every keyring received later is checked against
// it. A key that is not in the record is NOT trusted by this check: it needs a
// separate attestation, and only then is it added to the record.
//
//   node scripts/bom-trust-check.mjs --record <trust-record.json>
//        [--export-pub <keyId>.pub]...  [--receipt-keyring <file>]
//
// trust-record.json:
//   { "exportFingerprints": ["sha256:<64 hex>", ...],
//     "receiptFingerprints": { "<keyId>": "sha256:<64 hex>", ... },
//     "receiptV2FromAuditSeq": null | <positive seq> }      // as recorded; required
//
// Prints one line per key (MATCH or NOT IN RECORD) and for the boundary.
// Exit: 0 every key and the boundary match the record. 1 anything does not.
// 2 usage error or an unreadable or malformed file. Offline; needs `pnpm -r build`.
// =============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FPR = /^sha256:[0-9a-f]{64}$/;
const usage = (m) => {
  process.stderr.write(`bom-trust-check: ${m}\nUsage: node scripts/bom-trust-check.mjs --record FILE [--export-pub FILE]... [--receipt-keyring FILE]\n`);
  process.exit(2);
};
const args = process.argv.slice(2);
let record = null;
let receiptKeyring = null;
const exportPubs = [];
for (let i = 0; i < args.length; i++) {
  const v = args[i + 1];
  if (v === undefined) usage(`${args[i]} needs a value`);
  if (args[i] === "--record") record = v;
  else if (args[i] === "--export-pub") exportPubs.push(v);
  else if (args[i] === "--receipt-keyring") receiptKeyring = v;
  else usage(`unknown argument ${JSON.stringify(args[i])}`);
  i++;
}
if (!record) usage("--record is required");
if (!exportPubs.length && !receiptKeyring) usage("nothing to check: pass --export-pub and/or --receipt-keyring");

const shared = await import(path.join(root, "packages/shared/dist/index.js")).catch(() => usage("the built @regulait/shared is missing: run `pnpm -r build` first"));
// value-free: a read or parse error names the argument, never the content
const readJson = (f, what) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return usage(`${what} is not readable JSON`);
  }
};
const isBoundary = (b) => b === null || (Number.isSafeInteger(b) && b >= 1);

const rec = readJson(record, "--record");
if (
  !rec ||
  !Array.isArray(rec.exportFingerprints) ||
  !rec.exportFingerprints.every((f) => FPR.test(f)) ||
  typeof rec.receiptFingerprints !== "object" ||
  rec.receiptFingerprints === null ||
  !Object.values(rec.receiptFingerprints).every((f) => FPR.test(f)) ||
  !Object.hasOwn(rec, "receiptV2FromAuditSeq") ||
  !isBoundary(rec.receiptV2FromAuditSeq)
)
  usage("--record must hold exportFingerprints, receiptFingerprints and receiptV2FromAuditSeq (null or a positive seq)");

let ok = true;
const line = (match, what) => {
  if (!match) ok = false;
  process.stdout.write(`${match ? "MATCH" : "NOT IN RECORD"}  ${what}\n`);
};

for (const f of exportPubs) {
  let fpr;
  try {
    fpr = shared.bomSpkiFingerprint(readFileSync(f, "utf8"));
  } catch {
    usage("an --export-pub file is not a readable public key");
  }
  line(rec.exportFingerprints.includes(fpr), `export key ${path.basename(f)}`);
}

if (receiptKeyring) {
  const k = readJson(receiptKeyring, "--receipt-keyring");
  if (!k || !Array.isArray(k.keys) || !k.keys.every((e) => typeof e?.keyId === "string" && typeof e?.jwk?.x === "string")) usage('--receipt-keyring: expected {"keys": [{"keyId", "jwk"}], ...}');
  for (const e of k.keys) line(rec.receiptFingerprints[e.keyId] === shared.bomReceiptKeyFingerprint(e.jwk.x), `receipt key ${e.keyId}`);
  // the boundary is part of the trust root (R42): absent is refused, and it must be the recorded one
  if (!Object.hasOwn(k, "receiptV2FromAuditSeq")) line(false, "receipt v2 boundary: absent from the keyring (use GET /v1/receipts/export)");
  else line(k.receiptV2FromAuditSeq === rec.receiptV2FromAuditSeq, `receipt v2 boundary ${k.receiptV2FromAuditSeq === null ? "none" : k.receiptV2FromAuditSeq}`);
}

process.stdout.write(ok ? "TRUST RECORD: MATCH\n" : "TRUST RECORD: MISMATCH. Do not verify with these keys until the difference is attested out of band.\n");
process.exit(ok ? 0 : 1);
