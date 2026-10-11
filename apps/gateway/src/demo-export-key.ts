/**
 * `pnpm --filter @regulait/gateway demo:export-key` — the demo operator's export-signing key, and
 * (ADR-0189 R25) its receipt signing key.
 *
 * The receipt key: under the strict defaults every sign-off (a use-case or model-card approval, a
 * promotion, an admission) takes a signed AI BOM snapshot, and is REFUSED (409
 * `bom_signing_unavailable`) while no receipt key is configured. The demo approves use cases and
 * model cards, so it holds one too: `regulait-demo-receipt`, made and reused the same way.
 *
 * ADR-0116: the product never mints its own signing key; the DEPLOYMENT holds it. For a demo the
 * presenter's laptop is the deployment, so this is the operator's step from
 * infra/export-keys/README.md made cross-platform (PowerShell has no openssl by default): it
 * writes an Ed25519 keypair under ~/.regulait-demo-keys (reused on later runs, so the fingerprint
 * stays stable for a rehearsal and the demo), prints the fingerprint, and prints the two variables
 * to set before `demo:prepare` and the gateway start.
 *
 *   --env   print only `export …` lines on stdout (four: each key's path and id; for `eval "$(… --env)"`
 *           in bash/CI and the Docker demo's start script); the fingerprint goes to stderr
 *
 * Demo key only — a real deployment generates its key OFF the gateway host (README step 1).
 */
import { generateKeyPairSync, createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { publicKeyFingerprint } from "./export-bundle.js";

const KEY_ID = "regulait-demo-export";
const dir = process.env.REGULAIT_DEMO_KEY_DIR ?? path.join(homedir(), ".regulait-demo-keys");
const keyPath = path.join(dir, `${KEY_ID}.key`);
const pubPath = path.join(dir, `${KEY_ID}.pub`);

const RECEIPT_KEY_ID = "regulait-demo-receipt";
const receiptKeyPath = path.join(dir, `${RECEIPT_KEY_ID}.key`);

mkdirSync(dir, { recursive: true });
let created = false;
if (!existsSync(keyPath)) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(pubPath, publicKey.export({ type: "spki", format: "pem" }));
  created = true;
}
// ADR-0189 R25: the receipt key (PKCS#8 Ed25519, what REGULAIT_RECEIPT_SIGNING_KEY reads), reused like the export key
let receiptCreated = false;
if (!existsSync(receiptKeyPath)) {
  writeFileSync(receiptKeyPath, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  receiptCreated = true;
}
// same cast as export-bundle.ts: Node accepts a KeyObject here, its typings do not say so
const publicKeyPem = createPublicKey(createPrivateKey(readFileSync(keyPath)) as unknown as string)
  .export({ type: "spki", format: "pem" })
  .toString();
const fingerprint = publicKeyFingerprint(publicKeyPem);

if (process.argv.includes("--env")) {
  // stdout stays the four `export` lines (CI appends them to $GITHUB_ENV, the Docker start script evals them);
  // the fingerprint goes to stderr so a log still shows what an auditor pins. Never the key itself.
  console.error(`${created ? "Created" : "Reusing"} the demo export-signing key ${keyPath} — fingerprint ${fingerprint}`);
  console.error(`${receiptCreated ? "Created" : "Reusing"} the demo receipt signing key ${receiptKeyPath}`);
  console.log(`export REGULAIT_EXPORT_SIGNING_KEY='${keyPath}'`);
  console.log(`export REGULAIT_EXPORT_SIGNING_KEY_ID='${KEY_ID}'`);
  console.log(`export REGULAIT_RECEIPT_SIGNING_KEY='${receiptKeyPath}'`);
  console.log(`export REGULAIT_RECEIPT_SIGNING_KEY_ID='${RECEIPT_KEY_ID}'`);
} else {
  console.log(`${created ? "Created" : "Reusing"} the demo export-signing key: ${keyPath}`);
  console.log(`Fingerprint (what an auditor pins): ${fingerprint}`);
  console.log("");
  console.log(`${receiptCreated ? "Created" : "Reusing"} the demo receipt signing key: ${receiptKeyPath}`);
  console.log("");
  console.log("Set these before demo:prepare and the gateway start (same terminal):");
  console.log(
    `  bash:       export REGULAIT_EXPORT_SIGNING_KEY='${keyPath}' REGULAIT_EXPORT_SIGNING_KEY_ID=${KEY_ID}` +
      ` REGULAIT_RECEIPT_SIGNING_KEY='${receiptKeyPath}' REGULAIT_RECEIPT_SIGNING_KEY_ID=${RECEIPT_KEY_ID}`,
  );
  console.log(
    `  PowerShell: $env:REGULAIT_EXPORT_SIGNING_KEY = "${keyPath}"; $env:REGULAIT_EXPORT_SIGNING_KEY_ID = "${KEY_ID}";` +
      ` $env:REGULAIT_RECEIPT_SIGNING_KEY = "${receiptKeyPath}"; $env:REGULAIT_RECEIPT_SIGNING_KEY_ID = "${RECEIPT_KEY_ID}"`,
  );
}
