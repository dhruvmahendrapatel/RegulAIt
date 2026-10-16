#!/usr/bin/env node
// =============================================================================
// RegulAIt BOM VERIFIER, offline (ADR-0189 §6, R19, B4.2)
//
// Verifies an export-bundle/3 holding a Decision BOM or an AI BOM (one tool for
// both subjects) on an AUDITOR's machine: no database, no gateway, no network.
// It runs the same pure verifier as `POST /v1/boms/verify`
// (`packages/shared/src/bom/verify.ts`), against a trust root YOU supply:
//
//   the export key (it signs manifest.json):
//     --fingerprint sha256:<hex>     repeatable; pins the bundled signing-key.pub (ADR-0116)
//     --keyring <dir>                a directory of pinned <keyId>.pub files (ADR-0116)
//   the receipt key (it signs the BOM body, the receipt and any addenda):
//     --receipt-keyring <file>       the operator's `GET /v1/receipts/export` JSON, obtained out of band;
//                                    its `receiptV2FromAuditSeq` is the receipt v2 boundary
//     --receipt-fingerprint sha256:<hex>  repeatable; pins the bundle's receipt-keys.json entries
//     --receipt-v2-from <seq|none>   the receipt v2 boundary (overrides the keyring file's). REQUIRED with
//                                    --receipt-fingerprint, and with a keyring file that has no
//                                    `receiptV2FromAuditSeq` (such as `GET /v1/receipts/keys`): an absent
//                                    boundary is refused, never read as "no cutover" (B8 review H1)
//   optional:
//     --tsa-trust <pem>              a TSA trust bundle, to check an anchor's RFC 3161 token
//     --now <iso-8601>               the verification time (default: this machine's clock)
//     --json                         print the report as JSON
//
// The keys inside the bundle (signing-key.pub, receipt-keys.json) are convenience
// copies and NEVER the trust root. Both trust roots are required; there is no --force.
//
// Run `pnpm -r build` first: this script imports the built verifier.
//
// Exit codes: 0 valid. 3 unverifiable (evidence that should be there is missing).
// 1 invalid. 2 usage error.
// =============================================================================
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const usage = () => {
  process.stderr.write(
    "Usage: node scripts/verify-bom.mjs <bundle.tar.gz> (--fingerprint F | --keyring DIR) (--receipt-keyring FILE | --receipt-fingerprint F)\n" +
      "         [--receipt-v2-from SEQ|none] [--tsa-trust PEM] [--now ISO] [--json]\n",
  );
  process.exit(2);
};

const args = process.argv.slice(2);
const opt = { fingerprints: [], keyring: null, receiptKeyring: null, receiptFingerprints: [], v2From: undefined, tsaTrust: null, now: null, json: false, bundle: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => {
    const v = args[++i];
    if (v === undefined) usage();
    return v;
  };
  if (a === "--fingerprint") opt.fingerprints.push(next());
  else if (a === "--keyring") opt.keyring = next();
  else if (a === "--receipt-keyring") opt.receiptKeyring = next();
  else if (a === "--receipt-fingerprint") opt.receiptFingerprints.push(next());
  else if (a === "--receipt-v2-from") opt.v2From = next();
  else if (a === "--tsa-trust") opt.tsaTrust = next();
  else if (a === "--now") opt.now = next();
  else if (a === "--json") opt.json = true;
  else if (a === "-h" || a === "--help") usage();
  else if (a.startsWith("-")) usage();
  else if (opt.bundle === null) opt.bundle = a;
  else usage();
}
if (!opt.bundle) usage();
const FPR = /^sha256:[0-9a-f]{64}$/;
if (!opt.fingerprints.length && !opt.keyring) {
  process.stderr.write("REFUSED: no export-key trust root. Pass --fingerprint or --keyring, obtained out of band; the bundle's own signing-key.pub is never trusted.\n");
  process.exit(2);
}
if (!opt.receiptKeyring && !opt.receiptFingerprints.length) {
  process.stderr.write("REFUSED: no receipt-key trust root. Pass --receipt-keyring or --receipt-fingerprint, obtained out of band; the bundle's own receipt-keys.json is never trusted.\n");
  process.exit(2);
}
if ([...opt.fingerprints, ...opt.receiptFingerprints].some((f) => !FPR.test(f))) {
  process.stderr.write("a fingerprint is sha256:<64 lower-case hex>\n");
  process.exit(2);
}

const shared = await import(path.join(root, "packages/shared/dist/index.js")).catch(() => {
  process.stderr.write("the built verifier is missing: run `pnpm -r build` first\n");
  process.exit(2);
});

// --- the trust root ----------------------------------------------------------
let exportTrust;
if (opt.keyring) {
  if (!statSync(opt.keyring).isDirectory()) usage();
  const keys = readdirSync(opt.keyring)
    .filter((f) => f.endsWith(".pub"))
    .map((f) => ({ keyId: f.slice(0, -".pub".length), publicKeyPem: readFileSync(path.join(opt.keyring, f), "utf8") }));
  exportTrust = { keys };
} else exportTrust = { pinnedFingerprints: opt.fingerprints };

let receiptTrust;
let boundary = null;
if (opt.receiptKeyring) {
  const file = JSON.parse(readFileSync(opt.receiptKeyring, "utf8"));
  if (!file || !Array.isArray(file.keys)) {
    process.stderr.write("--receipt-keyring: expected {\"keys\": [{\"keyId\", \"jwk\"}], ...}\n");
    process.exit(2);
  }
  receiptTrust = { keys: file.keys.map((k) => ({ keyId: k.keyId, jwk: k.jwk })) };
  // B8 review H1: an ABSENT boundary is not "no cutover". `GET /v1/receipts/keys` carries no boundary; a keyring
  // without the field is refused unless --receipt-v2-from states it. An explicit null is "no cutover recorded".
  if (!Object.hasOwn(file, "receiptV2FromAuditSeq")) {
    if (opt.v2From === undefined) {
      process.stderr.write("REFUSED: --receipt-keyring has no receiptV2FromAuditSeq (the receipt v2 boundary). Use the operator's `GET /v1/receipts/export` JSON, or pass --receipt-v2-from SEQ|none, obtained out of band.\n");
      process.exit(2);
    }
  } else if (file.receiptV2FromAuditSeq === null) boundary = null;
  else if (Number.isSafeInteger(file.receiptV2FromAuditSeq) && file.receiptV2FromAuditSeq >= 1) boundary = file.receiptV2FromAuditSeq;
  else {
    process.stderr.write("REFUSED: --receipt-keyring's receiptV2FromAuditSeq must be null or a positive audit seq.\n");
    process.exit(2);
  }
} else {
  receiptTrust = { pinnedFingerprints: opt.receiptFingerprints };
  if (opt.v2From === undefined) {
    process.stderr.write("REFUSED: pinned receipt fingerprints carry no receipt v2 boundary. Pass --receipt-v2-from SEQ|none, obtained out of band.\n");
    process.exit(2);
  }
}
if (opt.v2From !== undefined) {
  if (opt.v2From === "none") boundary = null;
  else if (/^[1-9][0-9]{0,15}$/.test(opt.v2From)) boundary = Number(opt.v2From);
  else usage();
}

// the RFC 3161 half lives with the gateway's pkijs validator (air-gapped, no network); it only reads a token
let timestamp = null;
try {
  const ts = await import(path.join(root, "apps/gateway/dist/bom-timestamp.js"));
  timestamp = ts.bomTimestampVerifier(opt.tsaTrust ? readFileSync(opt.tsaTrust, "utf8") : null);
} catch (e) {
  if (opt.tsaTrust) {
    process.stderr.write(`--tsa-trust needs the built gateway (apps/gateway/dist): ${e.message}\n`);
    process.exit(2);
  }
}
const now = opt.now ? new Date(opt.now) : new Date();
if (!Number.isFinite(now.getTime())) usage();

const report = await shared.verifyBomBundle(readFileSync(opt.bundle), {
  receipt: receiptTrust,
  receiptV2FromAuditSeq: boundary,
  export: exportTrust,
  timestamp,
  verificationTime: now.toISOString(),
});

if (opt.json) process.stdout.write(`${JSON.stringify({ trust: "out_of_band", source: "bundle", ...report, verifiedAt: now.toISOString() }, null, 2)}\n`);
else {
  const id = report.identity;
  process.stdout.write(`\n==> ${opt.bundle}\n`);
  if (id?.subject === "decision-bom") process.stdout.write(`    Decision BOM ${id.bomId} v${id.version} of decision ${id.auditId}; finality ${id.recordedFinality} (reported ${id.reportedFinality}); receipt ${id.receiptPayloadVersion}\n`);
  else if (id?.subject === "ai-bom") process.stdout.write(`    AI BOM snapshot ${id.snapshotId} v${id.version} (${id.subjectKind} ${id.subjectId}), ${id.serialNumber}\n`);
  for (const c of report.checks) process.stdout.write(`    [${c.status}] ${c.check}${c.ref ? ` (${c.ref})` : ""}${c.reason ? `: ${c.reason}` : ""}\n`);
  for (const s of report.sections.filter((x) => x.status !== "valid")) process.stdout.write(`    [invalid] section ${s.section}\n`);
  if (report.cannotProve.length) {
    process.stdout.write("    This verification cannot prove:\n");
    for (const c of report.cannotProve) process.stdout.write(`      - ${shared.BOM_CANNOT_PROVE_COPY[c]}\n`);
  }
  process.stdout.write(`\n    OUTCOME: ${report.outcome.toUpperCase()}\n\n`);
}
process.exit(report.outcome === "valid" ? 0 : report.outcome === "unverifiable" ? 3 : 1);
