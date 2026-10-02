/**
 * `pnpm --filter @regulait/gateway demo:export-key` — the demo operator's export-signing key.
 *
 * ADR-0116: the product never mints its own signing key; the DEPLOYMENT holds it. For a demo the
 * presenter's laptop is the deployment, so this is the operator's step from
 * infra/export-keys/README.md made cross-platform (PowerShell has no openssl by default): it
 * writes an Ed25519 keypair under ~/.regulait-demo-keys (reused on later runs, so the fingerprint
 * stays stable for a rehearsal and the demo), prints the fingerprint, and prints the two variables
 * to set before `demo:prepare` and the gateway start.
 *
 *   --env   print only `export …` lines (for `eval "$(… --env)"` in bash/CI)
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

mkdirSync(dir, { recursive: true });
let created = false;
if (!existsSync(keyPath)) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(pubPath, publicKey.export({ type: "spki", format: "pem" }));
  created = true;
}
// same cast as export-bundle.ts: Node accepts a KeyObject here, its typings do not say so
const publicKeyPem = createPublicKey(createPrivateKey(readFileSync(keyPath)) as unknown as string)
  .export({ type: "spki", format: "pem" })
  .toString();
const fingerprint = publicKeyFingerprint(publicKeyPem);

if (process.argv.includes("--env")) {
  console.log(`export REGULAIT_EXPORT_SIGNING_KEY='${keyPath}'`);
  console.log(`export REGULAIT_EXPORT_SIGNING_KEY_ID='${KEY_ID}'`);
} else {
  console.log(`${created ? "Created" : "Reusing"} the demo export-signing key: ${keyPath}`);
  console.log(`Fingerprint (what an auditor pins): ${fingerprint}`);
  console.log("");
  console.log("Set these before demo:prepare and the gateway start (same terminal):");
  console.log(`  bash:       export REGULAIT_EXPORT_SIGNING_KEY='${keyPath}' REGULAIT_EXPORT_SIGNING_KEY_ID=${KEY_ID}`);
  console.log(`  PowerShell: $env:REGULAIT_EXPORT_SIGNING_KEY = "${keyPath}"; $env:REGULAIT_EXPORT_SIGNING_KEY_ID = "${KEY_ID}"`);
}
